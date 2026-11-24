import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single-use private delivery receipts for `[Owner popup]` lines.
 * Shared by the producer (writes a receipt right before each real `hc send`, removes receipts
 * for an address on Stop, and sweeps expired receipts) and the coordinator verify
 * command (`verify --address <own address>`).
 *
 * Trust boundary: proves that the owner-task producer of this user prepared this exact line
 * for this coordinator (not that delivery completed); it is no defense against another process
 * of the same user that can write the receipt folder.
 */

export const RECEIPT_MAX_AGE_MS = 10 * 60 * 1000;
export const RECEIPT_ID_RE = /^[0-9a-f]{32}$/;
const RECEIPT_FILE_RE = /^([0-9a-f]{32})\.json$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RECEIPT_LINE_RE = /^(.+) \(receipt ([^)\s]+)\)$/;
const UNSAFE_ADDRESS_RE = /[\r\n\t\p{Cc}\p{Cf}\u2028\u2029]/u;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_STDIN_MS = 2000;

export interface ReceiptRecord {
	version: 1;
	id: string;
	address: string;
	lineDigest: string;
	reportDigest: string;
	createdAt: string;
}

export interface CreatedReceipt {
	id: string;
	path: string;
	record: ReceiptRecord;
}

export type VerifyReceiptResult =
	| { ok: true; word: "valid"; record: ReceiptRecord }
	| { ok: false; word: string };

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OWNER_POPUP_STATE_DIR;
	if (override && isAbsolute(override)) return override;
	const xdg = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
	return join(xdg, "owner-popup");
}

export function receiptsDir(stateDir: string): string {
	return join(stateDir, "receipts");
}

export function isValidReceiptAddress(address: unknown): address is string {
	return (
		typeof address === "string" &&
		address.length > 0 &&
		!address.startsWith("-") &&
		!address.includes("/") &&
		!UNSAFE_ADDRESS_RE.test(address)
	);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function appendReceiptSuffix(baseLine: string, id: string): string {
	if (!RECEIPT_ID_RE.test(id)) {
		throw new Error("Invalid receipt ID format.");
	}
	return `${baseLine} (receipt ${id})`;
}

export function parseReceiptLine(
	rawInput: string,
): { ok: true; baseLine: string; id: string } | { ok: false; word: string } {
	const line = rawInput.replace(/\r?\n$/, "");
	if (!line) return { ok: false, word: "empty" };
	if (/[\r\n]/.test(line)) return { ok: false, word: "invalid_line" };
	const match = RECEIPT_LINE_RE.exec(line);
	if (!match) return { ok: false, word: "missing_receipt" };
	const [, baseLine, id] = match;
	if (!baseLine.startsWith("[Owner popup] ")) return { ok: false, word: "invalid_prefix" };
	if (!RECEIPT_ID_RE.test(id)) return { ok: false, word: "invalid_id" };
	return { ok: true, baseLine, id };
}

/**
 * Write one private receipt file (folder mode 0700, file mode 0600) via atomic rename.
 * Must be called immediately before a real `hc send`, and removed with `removeReceipt` if send fails.
 */
export function writeReceipt(options: {
	stateDir: string;
	address: string;
	baseLine: string;
	reportDigest: string;
	nowMs?: number;
}): CreatedReceipt {
	if (!isValidReceiptAddress(options.address)) {
		throw new Error("Invalid coordinator address for receipt.");
	}
	if (!SHA256_HEX_RE.test(options.reportDigest)) {
		throw new Error("Invalid report digest for receipt.");
	}

	mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
	const dir = receiptsDir(options.stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const dirStat = lstatSync(dir);
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
		throw new Error("Receipts path is not a private directory.");
	}
	chmodSync(dir, 0o700);
	const nowMs = options.nowMs ?? Date.now();
	sweepExpiredReceipts(options.stateDir, nowMs);

	const id = randomBytes(16).toString("hex");
	const record: ReceiptRecord = {
		version: 1,
		id,
		address: options.address,
		lineDigest: sha256Hex(options.baseLine),
		reportDigest: options.reportDigest,
		createdAt: new Date(nowMs).toISOString(),
	};

	const tmpPath = join(dir, `.tmp-${id}-${process.pid}-${randomBytes(4).toString("hex")}`);
	const finalPath = join(dir, `${id}.json`);
	try {
		writeFileSync(tmpPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, finalPath);
	} catch (err) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
		throw err;
	}

	return { id, path: finalPath, record };
}

export function removeReceipt(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// ignore missing or already-consumed receipt
	}
}

function scanReceipts(
	stateDir: string,
	shouldRemove: (record: ReceiptRecord, createdAtMs: number) => boolean,
): void {
	const dir = receiptsDir(stateDir);
	let entries: string[];
	try {
		const dirStat = lstatSync(dir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const match = RECEIPT_FILE_RE.exec(name);
		if (!match) continue;
		const filePath = join(dir, name);
		try {
			const stat = lstatSync(filePath);
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			const parsed = parseReceiptRecord(readFileSync(filePath, "utf8"), match[1]);
			if (parsed && shouldRemove(parsed.record, parsed.createdAtMs)) {
				removeReceipt(filePath);
			}
		} catch {
			// ignore unreadable or concurrently removed receipt
		}
	}
}

/** Remove every receipt file older than `maxAgeMs` (default 10 minutes). */
export function sweepExpiredReceipts(stateDir: string, nowMs = Date.now(), maxAgeMs = RECEIPT_MAX_AGE_MS): void {
	scanReceipts(stateDir, (_record, createdAtMs) => nowMs - createdAtMs > maxAgeMs);
}

/** Remove every receipt file belonging to one coordinator address. */
export function removeReceiptsForAddress(stateDir: string, address: string): void {
	if (!isValidReceiptAddress(address)) return;
	scanReceipts(stateDir, (record) => record.address === address);
}

function parseReceiptRecord(raw: string, expectedId: string): { record: ReceiptRecord; createdAtMs: number } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	if (
		obj.version !== 1 ||
		obj.id !== expectedId ||
		typeof obj.address !== "string" ||
		!isValidReceiptAddress(obj.address) ||
		typeof obj.lineDigest !== "string" ||
		!SHA256_HEX_RE.test(obj.lineDigest) ||
		typeof obj.reportDigest !== "string" ||
		!SHA256_HEX_RE.test(obj.reportDigest) ||
		typeof obj.createdAt !== "string"
	) {
		return null;
	}
	const createdAtMs = Date.parse(obj.createdAt);
	if (!Number.isFinite(createdAtMs)) return null;
	return {
		record: {
			version: 1,
			id: obj.id,
			address: obj.address,
			lineDigest: obj.lineDigest,
			reportDigest: obj.reportDigest,
			createdAt: obj.createdAt,
		},
		createdAtMs,
	};
}

/**
 * Verify a received `[Owner popup]` line against a stored receipt and consume it once.
 * Removes the receipt only when valid (consumed) or expired; leaves it untouched on all other failures.
 */
export function verifyAndConsumeReceipt(options: {
	line: string;
	address: string;
	stateDir?: string;
	nowMs?: number;
	maxAgeMs?: number;
}): VerifyReceiptResult {
	if (!isValidReceiptAddress(options.address)) {
		return { ok: false, word: "invalid_address" };
	}

	const parsedLine = parseReceiptLine(options.line);
	if (!parsedLine.ok) {
		return { ok: false, word: parsedLine.word };
	}

	const dir = receiptsDir(options.stateDir ?? defaultStateDir());
	const filePath = join(dir, `${parsedLine.id}.json`);

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(filePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		return { ok: false, word: code === "ENOENT" ? "missing" : "unreadable" };
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		return { ok: false, word: "unreadable" };
	}

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		return { ok: false, word: code === "ENOENT" ? "missing" : "unreadable" };
	}

	const parsedRecord = parseReceiptRecord(raw, parsedLine.id);
	if (!parsedRecord) {
		return { ok: false, word: "malformed" };
	}

	const nowMs = options.nowMs ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? RECEIPT_MAX_AGE_MS;
	const ageMs = nowMs - parsedRecord.createdAtMs;
	if (ageMs > maxAgeMs) {
		removeReceipt(filePath);
		return { ok: false, word: "expired" };
	}
	if (ageMs < -5000) {
		return { ok: false, word: "invalid_time" };
	}

	if (parsedRecord.record.address !== options.address) {
		return { ok: false, word: "address_mismatch" };
	}

	const actualDigest = Buffer.from(sha256Hex(parsedLine.baseLine), "hex");
	const storedDigest = Buffer.from(parsedRecord.record.lineDigest, "hex");
	if (actualDigest.length !== storedDigest.length || !timingSafeEqual(actualDigest, storedDigest)) {
		return { ok: false, word: "digest_mismatch" };
	}

	try {
		unlinkSync(filePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		return { ok: false, word: code === "ENOENT" ? "missing" : "consume_failed" };
	}

	return { ok: true, word: "valid", record: parsedRecord.record };
}

function readBoundedStdin(maxBytes = MAX_STDIN_BYTES, timeoutMs = MAX_STDIN_MS): Promise<{ ok: true; text: string } | { ok: false; word: string }> {
	return new Promise((resolveDone) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;

		const finish = (result: { ok: true; text: string } | { ok: false; word: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			process.stdin.pause();
			resolveDone(result);
		};

		const timer = setTimeout(() => finish({ ok: false, word: "stdin_timeout" }), timeoutMs);
		timer.unref();

		const onData = (chunk: Buffer | string) => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			total += buf.length;
			if (total > maxBytes) {
				finish({ ok: false, word: "stdin_too_large" });
				return;
			}
			chunks.push(buf);
		};
		const onEnd = () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
		const onError = () => finish({ ok: false, word: "stdin_error" });

		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.stdin.on("error", onError);
		process.stdin.resume();
	});
}

async function main(argv: readonly string[]): Promise<number> {
	if (argv[0] !== "verify") {
		process.stdout.write("usage\n");
		return 1;
	}

	let address: string | undefined;
	let stateDir: string | undefined;
	for (let i = 1; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--address" && argv[i + 1] !== undefined) {
			address = argv[++i];
		} else if (arg === "--state-dir" && argv[i + 1] !== undefined) {
			stateDir = argv[++i];
		} else {
			process.stdout.write("usage\n");
			return 1;
		}
	}

	if (!address) {
		process.stdout.write("usage\n");
		return 1;
	}
	if (stateDir !== undefined && !isAbsolute(stateDir)) {
		process.stdout.write("invalid_state_dir\n");
		return 1;
	}

	const input = await readBoundedStdin();
	if (!input.ok) {
		process.stdout.write(`${input.word}\n`);
		return 1;
	}

	const res = verifyAndConsumeReceipt({
		line: input.text,
		address,
		...(stateDir ? { stateDir } : {}),
	});
	process.stdout.write(`${res.word}\n`);
	return res.ok ? 0 : 1;
}

function isDirectEntry(): boolean {
	if (!process.argv[1]) return false;
	const self = fileURLToPath(import.meta.url);
	try {
		return realpathSync(self) === realpathSync(process.argv[1]);
	} catch {
		return resolve(self) === resolve(process.argv[1]);
	}
}

if (isDirectEntry()) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
