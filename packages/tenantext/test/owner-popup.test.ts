import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkA2uiMessages } from "../../walkr/src/a2ui.js";
import { buildSurfaceSpec, effectiveAnswer, renderedButtonSpecs, surfaceIdFor, toCreateSurfaceMessages, type A2uiComponent, type CoordinatorGroup, type RowViewState, type SurfaceState } from "../owner-popup/a2ui.ts";
import { createHcClient, createProducer, roleOfTerminal, type HcClient, type TerminalRecord } from "../owner-popup/producer.ts";
import { extractExcerpt, extractOwnerRows, isRiskyByWords, splitChoices } from "../owner-popup/rows.ts";

// The eight harm-guarding tests of PLAN-3 section 5, and test 9 for the receipt of a delivered answer.
// Uses local fake servers, fake executables / in-memory fakes, and in-process WebSocket clients.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HOOK_SCRIPT = resolve(HERE, "../claude-code/scripts/owner-popup-hook.mjs");
const RECEIPT_SCRIPT = resolve(HERE, "../owner-popup/receipt.ts");
const MOCKUP_FIXTURE = readFileSync(resolve(HERE, "../owner-popup/fixtures/mockup-report.md"), "utf8");
const COMPACT_FIXTURE = readFileSync(resolve(HERE, "../owner-popup/fixtures/compact-report.md"), "utf8");

const SUPPORTED_HERDR_COMPONENTS = new Set([
	"Text",
	"Row",
	"Column",
	"List",
	"Card",
	"Divider",
	"Button",
	"TextField",
	"CheckBox",
	"ChoicePicker",
	"Slider",
	"Tabs",
]);

function makeTempDir(t: test.TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function waitUntil(ready: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((done) => setTimeout(done, 15));
	}
}

function rowByLabel(state: SurfaceState, label: string, address?: string): RowViewState {
	const group = address ? state.coordinators.find((c) => c.address === address) : state.coordinators[0];
	assert.ok(group, `coordinator group ${address ?? "(first)"} not found`);
	const found = group.rows.find((r) => r.row.label === label);
	assert.ok(found, `row [${label}] not found`);
	return found;
}

function surfaceIdOfMessage(msg: Record<string, unknown>): string | undefined {
	const body = (msg.createSurface ?? msg.updateComponents ?? msg.updateDataModel ?? msg.deleteSurface) as
		| { surfaceId?: string }
		| undefined;
	return body?.surfaceId;
}

type ActionName = "choose" | "other" | "toggle" | "confirm" | "send" | "close";

/**
 * Build the action of one rendered button. `other` is the text in the field of the target row; `drafts` holds the
 * texts of other fields by row label. A field that the button does not bind sends nothing, as in the app.
 */
function buildButtonAction(
	state: SurfaceState,
	name: ActionName,
	opts: { targetCoordinator?: string; targetLabel?: string; optionId?: string; other?: string; drafts?: Record<string, string>; surfaceId?: string } = {},
): string {
	const group = opts.targetCoordinator
		? state.coordinators.find((c) => c.address === opts.targetCoordinator)
		: state.coordinators[0];
	assert.ok(group, `coordinator group ${opts.targetCoordinator ?? "(first)"} not found`);
	const buttons = [...renderedButtonSpecs(group).values()];
	const button = buttons.find((btn) => {
		if (btn.name !== name) return false;
		if (opts.targetCoordinator && btn.literals.targetCoordinator !== opts.targetCoordinator) return false;
		if (opts.targetLabel && btn.literals.targetLabel !== opts.targetLabel) return false;
		if (opts.optionId && btn.literals.optionId !== opts.optionId) return false;
		return true;
	});
	assert.ok(button, `rendered button for ${name} not found`);
	const context: Record<string, unknown> = { ...button.literals };
	const drafts: Record<string, string> = { ...opts.drafts };
	if (opts.other !== undefined && button.literals.targetLabel) drafts[button.literals.targetLabel] = opts.other;
	for (const [label, text] of Object.entries(drafts)) {
		if (button.drafts.has(label)) context[`other_${label}`] = text;
	}
	return JSON.stringify({
		version: "1.0",
		action: {
			name: button.name,
			surfaceId: opts.surfaceId ?? surfaceIdFor(group.address),
			sourceComponentId: button.id,
			timestamp: new Date().toISOString(),
			context,
		},
	});
}

/** Press one rendered button of a coordinator surface, as the Herdr app sends it. */
function press(
	producer: { getState(): SurfaceState; handleRawAction(text: string): Promise<{ handled: boolean; reason?: string }> },
	name: ActionName,
	opts: { targetCoordinator?: string; targetLabel?: string; optionId?: string; other?: string; drafts?: Record<string, string> } = {},
): Promise<{ handled: boolean; reason?: string }> {
	return producer.handleRawAction(buildButtonAction(producer.getState(), name, opts));
}

/** Press the answer `optionId` of row `targetLabel`, or of the first open row, of one coordinator. */
function choose(
	producer: { getState(): SurfaceState; handleRawAction(text: string): Promise<{ handled: boolean; reason?: string }> },
	targetCoordinator: string,
	optionId: string,
	targetLabel?: string,
): Promise<{ handled: boolean; reason?: string }> {
	return press(producer, "choose", { targetCoordinator, optionId, ...(targetLabel ? { targetLabel } : {}) });
}

/** A report with one owner row: a send of its answer leaves no row. */
const ONE_ROW_REPORT = "Work waits.\n\n## Next\n\n- **[A]** Owner decides: Keep the percent, or show a bar.";

/** A report with three owner rows that are not risky. */
const THREE_ROWS_REPORT = [
	"Work waits.",
	"",
	"## Next",
	"",
	"- **[A]** Owner decides: Keep the percent, or show a bar.",
	"- **[B]** Owner decides: Use JSON, or use YAML.",
	"- **[C]** Owner decides: Name the tool Alpha, or name it Beta.",
].join("\n");

/** The labels of the rows in one `[Owner popup]` line, in order. */
function sentLabels(line: string): string[] {
	return [...line.replace(/ \(receipt [0-9a-f]+\)$/, "").matchAll(/(?:^\[Owner popup\] |; )\[([A-Za-z]+)\] /g)].map((m) => m[1]);
}

/** In-memory fake `hc` for state-only tests that do not need child argv or env inspection. */
function makeMemoryHc(initialRecord: TerminalRecord | null) {
	let current = initialRecord;
	const sends: Array<{ address: string; text: string }> = [];
	const client: HcClient = {
		async get() {
			return current ? { ...current } : null;
		},
		async send(address, text) {
			sends.push({ address, text });
			return { ok: true, code: 0, detail: "" };
		},
	};
	return {
		client,
		sends,
		setTerminal(record: TerminalRecord | null) {
			current = record;
		},
	};
}

interface FakeHcCall {
	args: string[];
	envKeys: string[];
}

interface FakeHcControl {
	binPath: string;
	setTerminal(record: Record<string, unknown> | null): void;
	readCalls(): FakeHcCall[];
}

/** Executable fake `hc` on disk that reads terminal state and logs argv + env var names (never values). */
function makeFakeHc(
	dir: string,
	initialRecord: Record<string, unknown> | null,
	opts: {
		schema?: unknown;
		refuseNoDraftWait?: boolean;
		turnStartBeforeRefusal?: { path: string; address: string };
		/** The refused flagged child waits until this file exists (at most 8 seconds) before it refuses. */
		holdRefusalUntil?: string;
	} = {},
): FakeHcControl {
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	const stateFile = join(dir, "hc-state.json");
	const logFile = join(dir, "hc-calls.jsonl");
	const binPath = join(binDir, "hc");

	const setTerminal = (record: Record<string, unknown> | null) => {
		writeFileSync(stateFile, JSON.stringify({ terminal: record }));
	};
	setTerminal(initialRecord);

	writeFileSync(
		binPath,
		[
			"#!/usr/bin/env node",
			'import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";',
			`const stateFile = ${JSON.stringify(stateFile)};`,
			`const logFile = ${JSON.stringify(logFile)};`,
			"const args = process.argv.slice(2);",
			'appendFileSync(logFile, JSON.stringify({ args, envKeys: Object.keys(process.env).sort() }) + "\\n");',
			'if (args[0] === "get") {',
			'  const data = JSON.parse(readFileSync(stateFile, "utf8")).terminal;',
			"  if (!data) { process.exit(3); }",
			'  process.stdout.write(JSON.stringify(data) + "\\n");',
			"  process.exit(0);",
			"}",
			`const schema = ${JSON.stringify(opts.schema === undefined ? null : JSON.stringify(opts.schema))};`,
			'if (args[0] === "schema" && schema !== null) {',
			"  process.stdout.write(schema);",
			"  process.exit(0);",
			"}",
			`if (args[0] === "send" && args.includes("--no-draft-wait") && ${opts.refuseNoDraftWait === true}) {`,
			`  const hold = ${JSON.stringify(opts.holdRefusalUntil ?? null)};`,
			"  const holdEnd = Date.now() + 8000;",
			"  while (hold && !existsSync(hold) && Date.now() < holdEnd) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
			`  const event = ${JSON.stringify(opts.turnStartBeforeRefusal ?? null)};`,
			// The time of the refusal, so the event is newer than the report. A rename publishes the whole file at once.
			"  if (event) {",
			'    const tmp = event.path + ".tmp-" + process.pid;',
			'    writeFileSync(tmp, JSON.stringify({ type: "turn_start", address: event.address, timeMs: Date.now() }), { mode: 0o600 });',
			"    renameSync(tmp, event.path);",
			"  }",
			'  process.stderr.write(JSON.stringify({ error: { kind: "usage", message: "unexpected argument" } }) + "\\n");',
			"  process.exit(2);",
			"}",
			'if (args[0] === "send") {',
			'  process.stdout.write("{\\"ok\\":true}\\n");',
			"  process.exit(0);",
			"}",
			"process.exit(2);",
		].join("\n") + "\n",
		{ mode: 0o755 },
	);
	chmodSync(binPath, 0o755);

	return {
		binPath,
		setTerminal,
		readCalls() {
			if (!existsSync(logFile)) return [];
			return readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeHcCall);
		},
	};
}

/** Parse `hc send` flags in any flag order into target, message, guard (`--if`), and `--force` presence. */
function parseHcSendArgs(args: readonly string[]): { target: string; message: string; ifStatus?: string; hasForce: boolean } {
	assert.equal(args[0], "send");
	let ifStatus: string | undefined;
	let hasForce = false;
	const positional: string[] = [];
	for (let i = 1; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--if" && args[i + 1] !== undefined) {
			ifStatus = args[++i];
		} else if (arg.startsWith("--if=")) {
			ifStatus = arg.slice(5);
		} else if (arg === "--force") {
			hasForce = true;
		} else if (!arg.startsWith("-")) {
			positional.push(arg);
		}
	}
	assert.equal(positional.length, 2, `expected target and message in hc send args: ${JSON.stringify(args)}`);
	return { target: positional[0], message: positional[1], ifStatus, hasForce };
}

/** Executable fake `pi` that captures argv, stdin, cwd, agentDir, and env var names (never values). */
function makeFakePi(dir: string, deltas: readonly string[]): { binPath: string; captureFile: string } {
	const binDir = join(dir, "pi-bin");
	mkdirSync(binDir, { recursive: true });
	const captureFile = join(dir, "pi-capture.json");
	const binPath = join(binDir, "pi");
	writeFileSync(
		binPath,
		[
			"#!/usr/bin/env node",
			'import { writeFileSync } from "node:fs";',
			`const captureFile = ${JSON.stringify(captureFile)};`,
			`const deltas = ${JSON.stringify(deltas)};`,
			"const chunks = [];",
			"for await (const chunk of process.stdin) chunks.push(chunk);",
			'const stdin = Buffer.concat(chunks).toString("utf8");',
			"writeFileSync(captureFile, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, envKeys: Object.keys(process.env).sort() }));",
			"for (const delta of deltas) {",
			'  process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }) + "\\n");',
			"}",
		].join("\n") + "\n",
		{ mode: 0o755 },
	);
	chmodSync(binPath, 0o755);
	return { binPath, captureFile };
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function buildDeciderScorePayload(
	body: Record<string, unknown> | null,
	probsForKeys: (keys: string[], prompt: string) => Record<string, number>,
	riskForPrompt: (prompt: string) => number,
) {
	const criteria = ((body?.questions as Record<string, { criteria?: Record<string, string> }>)?.rank?.criteria) ?? {};
	const keys = Object.keys(criteria);
	const prompt = String((body?.state as { prompt?: string })?.prompt ?? "");
	return {
		model: "fake",
		answers: {
			rank: { probabilities: probsForKeys(keys, prompt) },
			risk: { noul: riskForPrompt(prompt) },
		},
	};
}

interface FakeDeciderServer {
	url: string;
	requests: Array<{ path: string; body: Record<string, unknown> | null }>;
	close(): Promise<void>;
}

async function startFakeDecider(
	t: test.TestContext,
	handler: (reqPath: string, body: Record<string, unknown> | null, res: http.ServerResponse) => void | Promise<void>,
): Promise<FakeDeciderServer> {
	const requests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
	const server = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		let parsed: Record<string, unknown> | null = null;
		try {
			if (raw) parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			parsed = null;
		}
		requests.push({ path: req.url ?? "", body: parsed });
		await handler(req.url ?? "", parsed, res);
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const close = () =>
		new Promise<void>((resolveClose) => {
			server.closeAllConnections?.();
			server.close(() => resolveClose());
		});
	t.after(close);
	return { url: `http://127.0.0.1:${port}`, requests, close };
}

async function connectWs(t: test.TestContext, port: number) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/a2ui`);
	const frames: unknown[][] = [];
	const messages: Record<string, unknown>[] = [];
	ws.addEventListener("message", (event) => {
		const parsed = JSON.parse(String(event.data));
		if (Array.isArray(parsed)) {
			frames.push(parsed);
			messages.push(...(parsed as Record<string, unknown>[]));
		}
	});
	t.after(async () => {
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			ws.close();
			await waitUntil(() => ws.readyState === WebSocket.CLOSED, "ws close", 1000).catch(() => {});
		}
	});
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timer = setTimeout(() => rejectOpen(new Error("Timed out waiting for WebSocket open")), 5000);
		ws.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
		ws.addEventListener("error", () => { clearTimeout(timer); rejectOpen(new Error("WebSocket error")); }, { once: true });
	});
	return { ws, frames, messages };
}

/** Shared raw HTTP WebSocket upgrade handshake + cleanup used by both upgrade and framing checks. */
function rawUpgradeExchange<T>(
	port: number,
	route: string,
	extraHeaders: Record<string, string>,
	onHead: (
		socket: net.Socket,
		status: number,
		rest: Buffer,
		finish: (err: Error | null, value?: T) => void,
	) => ((chunk: Buffer) => void) | void,
): Promise<T> {
	return new Promise((resolveDone, rejectDone) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		let buf: Buffer = Buffer.alloc(0);
		let upgradedHandler: ((chunk: Buffer) => void) | null = null;
		let settled = false;
		const finish = (err: Error | null, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (err) rejectDone(err);
			else resolveDone(value as T);
		};
		const timer = setTimeout(() => finish(new Error("Timed out waiting for raw socket exchange")), 5000);
		const headers: Record<string, string> = {
			host: `127.0.0.1:${port}`,
			upgrade: "websocket",
			connection: "Upgrade",
			"sec-websocket-key": randomBytes(16).toString("base64"),
			"sec-websocket-version": "13",
			...extraHeaders,
		};
		const head =
			`GET ${route} HTTP/1.1\r\n` +
			Object.entries(headers)
				.map(([k, v]) => `${k}: ${v}\r\n`)
				.join("") +
			"\r\n";
		socket.on("connect", () => socket.write(head, "latin1"));
		socket.on("data", (chunk) => {
			if (upgradedHandler) {
				upgradedHandler(chunk);
				return;
			}
			buf = Buffer.concat([buf, chunk]);
			const split = buf.indexOf("\r\n\r\n");
			if (split < 0) return;
			const status = Number(buf.subarray(0, split).toString("latin1").split("\r\n")[0].split(" ")[1]);
			const rest = buf.subarray(split + 4);
			const nextHandler = onHead(socket, status, rest, finish);
			if (nextHandler) upgradedHandler = nextHandler;
		});
		socket.on("error", (err) => finish(err));
	});
}

function rawUpgrade(
	port: number,
	route: string,
	extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
	return rawUpgradeExchange(port, route, extraHeaders, (_socket, status, rest, finish) => {
		finish(null, { status, text: rest.toString("utf8") });
	});
}

function rawFrameCloseCode(port: number, route: string, frameBytes: Buffer): Promise<number | null> {
	return rawUpgradeExchange(port, route, {}, (socket, status, initialRest, finish) => {
		if (status !== 101) {
			finish(new Error(`Expected 101, got ${status}`));
			return;
		}
		let buf: Buffer = Buffer.from(initialRest);
		const inspect = () => {
			while (buf.length >= 2) {
				const opcode = buf[0] & 0x0f;
				const len7 = buf[1] & 0x7f;
				let headerLen = 2;
				let payloadLen = len7;
				if (len7 === 126) {
					if (buf.length < 4) return;
					payloadLen = buf.readUInt16BE(2);
					headerLen = 4;
				} else if (len7 === 127) {
					if (buf.length < 10) return;
					payloadLen = Number(buf.readBigUInt64BE(2));
					headerLen = 10;
				}
				if (buf.length < headerLen + payloadLen) return;
				const payload = buf.subarray(headerLen, headerLen + payloadLen);
				buf = buf.subarray(headerLen + payloadLen);
				if (opcode === 0x8) {
					finish(null, payload.length >= 2 ? payload.readUInt16BE(0) : null);
					return;
				}
			}
		};
		socket.write(frameBytes);
		inspect();
		return (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			inspect();
		};
	});
}

// Test 1: A task session or an unknown role (or dummies off) gets no cards.
test("1. a task session, an unknown role, or dummies off gets no owner-task cards", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t1-");
	const dummiesFile = join(dir, "state.json");
	const fakeHc = makeMemoryHc({
		address: "t20w",
		name: "tenant-pi-worker-4",
		state: "live",
		agentStatus: "idle",
		role: "worker",
	});
	const producer = await createProducer({
		port: 0,
		stateDir: join(dir, "state"),
		dummiesFile,
		hc: fakeHc.client,
		decider: false,
		writer: false,
	});
	t.after(() => producer.close());

	// Dummies off -> no cards even for a coordinator
	writeFileSync(dummiesFile, JSON.stringify({ claude: "off", pi: "on" }));
	fakeHc.setTerminal({ address: "t20c", name: "tenant-pi-coordinator-9", state: "live", agentStatus: "idle", role: "coordinator" });
	await producer.addReport({ address: "t20c", reportText: MOCKUP_FIXTURE });
	assert.equal(producer.getState().coordinators.length, 0);

	// Dummies on, worker role -> no cards
	writeFileSync(dummiesFile, JSON.stringify({ claude: "on" }));
	fakeHc.setTerminal({ address: "t20w", name: "tenant-pi-worker-4", state: "live", agentStatus: "idle", role: "worker" });
	await producer.addReport({ address: "t20w", reportText: MOCKUP_FIXTURE });
	assert.equal(producer.getState().coordinators.length, 0);

	// Unknown role -> no cards
	fakeHc.setTerminal({ address: "t20u", name: "scratch-shell", state: "live", agentStatus: "idle" });
	await producer.addReport({ address: "t20u", reportText: MOCKUP_FIXTURE });
	assert.equal(producer.getState().coordinators.length, 0);

	// First tab of an app space counts as coordinator; another tab or an explicit role does not
	assert.equal(roleOfTerminal({ where: "space-a / 1" }, undefined), "coordinator");
	assert.equal(roleOfTerminal({ where: "space-a / 2" }, undefined), undefined);
	assert.equal(roleOfTerminal({ "skill.role": "worker", where: "space-a / coordinator" }, undefined), "worker");

	// hc lookup failure -> no cards
	fakeHc.setTerminal(null);
	await producer.addReport({ address: "t20x", reportText: MOCKUP_FIXTURE });
	assert.equal(producer.getState().coordinators.length, 0);

	// Coordinator with dummies on -> cards created
	fakeHc.setTerminal({ address: "t20c", name: "tenant-pi-coordinator-9", state: "live", agentStatus: "idle", role: "coordinator" });
	await producer.addReport({ address: "t20c", reportText: MOCKUP_FIXTURE });
	assert.equal(
		producer.getState().coordinators.some((c) => c.address === "t20c" && c.rows.length > 0),
		true,
	);
});

// Test 2: The Stop hook returns at once with empty output while detached children hang.
test("2. the Stop hook returns at once with empty output while detached children hang", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t2-");
	const fakeKit = join(dir, "kit");
	const fakeProducerDir = join(fakeKit, "packages", "tenantext", "owner-popup");
	mkdirSync(fakeProducerDir, { recursive: true, mode: 0o700 });
	const pidFile = join(dir, "hung.pid");
	// Stub producer that hangs indefinitely like a wedged reader/decider/writer.
	writeFileSync(
		join(fakeProducerDir, "producer.ts"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 60_000);\n`,
		{ mode: 0o600 },
	);
	// The hook starts the stub detached, so nothing else stops it. The `after` hooks run in the order of
	// their registration, and the hook of makeTempDir removes `dir` with the PID file first. So this hook
	// stops the stub at once when the PID file appears, and the `after` hook only waits for that end.
	let stubEnded: Promise<void> = Promise.resolve();
	const stopStub = async (): Promise<void> => {
		const deadline = Date.now() + 5000;
		while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 15));
		if (!existsSync(pidFile)) return;
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		if (pid > 0) {
			try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
		}
	};
	t.after(() => stubEnded);

	const settingsFile = join(dir, "settings.json");
	const stateDir = join(dir, "state");
	writeFileSync(settingsFile, JSON.stringify({ enabled: true, kitRoot: fakeKit }), { mode: 0o600 });
	chmodSync(settingsFile, 0o600);

	const baseEnv = {
		...process.env,
		HC_TERMINAL_ID: "t11y",
		OWNER_POPUP_SETTINGS: settingsFile,
		OWNER_POPUP_STATE_DIR: stateDir,
		CLAUDE_CODE_ENTRYPOINT: "cli",
	};

	const runHookSilent = (mode: "stop" | "turn-start", input: string, env: NodeJS.ProcessEnv) => {
		const res = spawnSync(process.execPath, [HOOK_SCRIPT, mode], {
			input,
			env,
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(res.status, 0);
		assert.equal(res.stdout, "");
		assert.equal(res.stderr, "");
	};

	// The 5 s timeout of spawnSync is the proof of the return: the stub producer never ends by itself.
	try {
		runHookSilent("stop", JSON.stringify({ stop_hook_active: false, last_assistant_message: MOCKUP_FIXTURE }), baseEnv);
	} finally {
		stubEnded = stopStub();
	}

	const eventsDir = join(stateDir, "events");
	const files = readdirSync(eventsDir);
	assert.equal(files.length, 1);
	assert.equal(statSync(eventsDir).mode & 0o777, 0o700);
	assert.equal(statSync(join(eventsDir, files[0])).mode & 0o777, 0o600);

	// stop_hook_active: true must write no second event file.
	runHookSilent("stop", JSON.stringify({ stop_hook_active: true, last_assistant_message: MOCKUP_FIXTURE }), baseEnv);
	assert.equal(readdirSync(eventsDir).length, 1);

	// turn-start always writes an event file when enabled even with no producer running.
	const turnStateDir = join(dir, "turn-state");
	runHookSilent("turn-start", "{}", { ...baseEnv, OWNER_POPUP_STATE_DIR: turnStateDir });
	const turnFiles = readdirSync(join(turnStateDir, "events"));
	assert.equal(turnFiles.length, 1);
	assert.equal(statSync(join(turnStateDir, "events", turnFiles[0])).mode & 0o777, 0o600);

	// Group-writable settings file is silently refused without writing any event.
	const untrustedState = join(dir, "untrusted-state");
	chmodSync(settingsFile, 0o620);
	runHookSilent("turn-start", "{}", { ...baseEnv, OWNER_POPUP_STATE_DIR: untrustedState });
	assert.equal(existsSync(join(untrustedState, "events")), false);

	await waitUntil(() => existsSync(pidFile), "detached producer process spawned");
	await stubEnded;
});

// Test 3: One send delivers once with a single-use receipt and never after a pending turn-start.
test("3. send delivers once to the parent by state rule, verifies single-use receipt, and respects pending turn-start", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t3-");
	const stateDir = join(dir, "state");
	const eventsDir = join(stateDir, "events");
	const dummiesFile = join(dir, "state.json");
	writeFileSync(dummiesFile, JSON.stringify({ claude: "on" }));
	const fakeHc = makeFakeHc(dir, {
		address: "t11y",
		name: "tenant-pi-coordinator-9",
		state: "live",
		status: { state: "working" },
		labels: { "skill.role": "coordinator" },
	});

	const producer = await createProducer({
		port: 0,
		stateDir,
		eventsDir,
		dummiesFile,
		hc: createHcClient(fakeHc.binPath),
		decider: false,
		writer: false,
	});
	t.after(() => producer.close());

	const client = await connectWs(t, producer.port);
	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE });
	await waitUntil(
		() => client.messages.some((m) => "createSurface" in m && surfaceIdOfMessage(m) === surfaceIdFor("t11y")),
		"surface created",
	);

	// Nothing sent before a send action.
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, 0);

	// Pick [B], pick and confirm the answer of risky row [C], and press send: delivers once with no `--if`, never
	// `--force`, includes both [B] and risky [C], and verifies one receipt; the rows that were not checked stay on a
	// locked surface with no Send, and a replay of the old button sends nothing.
	const chosenText = rowByLabel(producer.getState(), "B", "t11y").row.options[0].text;
	const riskyText = rowByLabel(producer.getState(), "C", "t11y").row.options[0].text;
	await choose(producer, "t11y", "o1", "B");
	await choose(producer, "t11y", "o1", "C");
	await press(producer, "confirm", { targetCoordinator: "t11y", targetLabel: "C" });
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, 0);
	const sendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y" });
	await producer.handleRawAction(sendPayload);
	const drawnA = () => drawnComponents(client.messages, surfaceIdFor("t11y")) ?? [];
	await waitUntil(
		() => drawnA().some((c) => c.id === "open_text_D") && !drawnA().some((c) => c.id === "btn_send"),
		"locked surface after send",
	);
	await producer.handleRawAction(sendPayload);

	const idleSends = fakeHc.readCalls().filter((c) => c.args[0] === "send");
	assert.equal(idleSends.length, 1);
	const parsedIdle = parseHcSendArgs(idleSends[0].args);
	assert.equal(parsedIdle.target, "t11y");
	assert.equal(parsedIdle.ifStatus, undefined);
	assert.equal(parsedIdle.hasForce, false);
	assert.equal(parsedIdle.message.includes("[B]"), true);
	assert.equal(parsedIdle.message.includes(chosenText), true);
	assert.equal(parsedIdle.message.includes("[C]"), true);
	assert.equal(parsedIdle.message.includes(riskyText), true);

	// Normal order: the delivered answer starts the coordinator's next turn before verify runs.
	// Draining that later turn-start must keep the receipt valid for single-use verification.
	const afterSendTurnMs = performance.timeOrigin + performance.now() + 10;
	writeFileSync(
		join(eventsDir, "turn-start-t11y.json"),
		JSON.stringify({ type: "turn_start", address: "t11y", timeMs: afterSendTurnMs, at: new Date(afterSendTurnMs).toISOString() }),
		{ mode: 0o600 },
	);
	await producer.pollEventsNow();

	// Receipt verify command: fails for another address without consuming, succeeds once for t11y, fails on replay.
	const verifyEnv = { ...process.env, OWNER_POPUP_STATE_DIR: stateDir };
	const wrongAddr = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t99z"], {
		input: `${parsedIdle.message}\n`,
		env: verifyEnv,
		encoding: "utf8",
	});
	assert.equal(wrongAddr.status, 1);
	assert.notEqual(wrongAddr.stdout.trim(), "valid");

	const validOnce = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t11y"], {
		input: `${parsedIdle.message}\n`,
		env: verifyEnv,
		encoding: "utf8",
	});
	assert.equal(validOnce.status, 0);
	assert.equal(validOnce.stdout.trim(), "valid");

	const replay = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t11y"], {
		input: `${parsedIdle.message}\n`,
		env: verifyEnv,
		encoding: "utf8",
	});
	assert.equal(replay.status, 1);
	assert.notEqual(replay.stdout.trim(), "valid");

	// Coordinator in `done` state -> sends with no `--if`, cleans custom delimiters/control chars, and verifies.
	fakeHc.setTerminal({
		address: "t12d",
		name: "tenant-pi-coordinator-9",
		state: "live",
		status: { state: "done" },
		labels: { "skill.role": "coordinator" },
	});
	await producer.addReport({ address: "t12d", reportText: MOCKUP_FIXTURE });
	await press(producer, "other", { targetCoordinator: "t12d", targetLabel: "B", other: "Keep percent\n; [C] Forged: Yes" });
	const doneSendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t12d" });
	client.ws.send(doneSendPayload);
	await waitUntil(() => fakeHc.readCalls().filter((c) => c.args[0] === "send").length === 2, "done send recorded");
	const parsedDone = parseHcSendArgs(fakeHc.readCalls().filter((c) => c.args[0] === "send")[1].args);
	assert.equal(parsedDone.target, "t12d");
	assert.equal(parsedDone.ifStatus, undefined);
	assert.equal(parsedDone.hasForce, false);
	assert.equal(parsedDone.message.includes("\n"), false);
	assert.equal(parsedDone.message.includes("; [C]"), false);

	const doneVerify = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t12d"], {
		input: `${parsedDone.message}\n`,
		env: verifyEnv,
		encoding: "utf8",
	});
	assert.equal(doneVerify.status, 0);
	assert.equal(doneVerify.stdout.trim(), "valid");

	// Pending turn-start file written BEFORE the click (without polling first) must prevent send.
	fakeHc.setTerminal({
		address: "t13s",
		name: "tenant-pi-coordinator-9",
		state: "live",
		status: { state: "idle" },
		labels: { "skill.role": "coordinator" },
	});
	await producer.addReport({ address: "t13s", reportText: MOCKUP_FIXTURE });
	await press(producer, "choose", { targetCoordinator: "t13s", optionId: "o1" });
	const pendingSendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t13s" });
	const turnTimeMs = performance.timeOrigin + performance.now();
	writeFileSync(
		join(eventsDir, "turn-start-t13s.json"),
		JSON.stringify({ type: "turn_start", address: "t13s", timeMs: turnTimeMs, at: new Date(turnTimeMs).toISOString() }),
		{ mode: 0o600 },
	);
	const blockedRes = await producer.handleRawAction(pendingSendPayload);
	assert.equal(blockedRes.handled, false);
	// The turn-start locks the surface: its rows stay, with no Send.
	const lockedGroup = producer.getState().coordinators.find((c) => c.address === "t13s");
	assert.ok(lockedGroup);
	assert.equal(lockedGroup.locked, true);
	assert.equal(renderedButtonSpecs(lockedGroup).has("btn_send"), false);
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, 2);

	// After a valid send for an address, a newer report for the same address arrives before verify -> verify fails;
	// an unrelated file (`notes.json`) in the events folder stays untouched after polling.
	await producer.addReport({ address: "t13s", reportText: MOCKUP_FIXTURE });
	await press(producer, "choose", { targetCoordinator: "t13s", optionId: "o1" });
	const supersededSendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t13s" });
	await producer.handleRawAction(supersededSendPayload);
	const sendsAfterThird = fakeHc.readCalls().filter((c) => c.args[0] === "send");
	assert.equal(sendsAfterThird.length, 3);
	const parsedSuperseded = parseHcSendArgs(sendsAfterThird[2].args);

	const notesPath = join(eventsDir, "notes.json");
	writeFileSync(notesPath, JSON.stringify({ note: "keep" }), { mode: 0o600 });
	const stopTimeMs = performance.timeOrigin + performance.now();
	writeFileSync(
		join(eventsDir, `stop-${String(Math.floor(stopTimeMs)).padStart(16, "0")}-a1b2c3d4.json`),
		JSON.stringify({
			type: "stop",
			address: "t13s",
			reportText: COMPACT_FIXTURE,
			timeMs: stopTimeMs,
			at: new Date(stopTimeMs).toISOString(),
		}),
		{ mode: 0o600 },
	);
	await producer.pollEventsNow();
	assert.equal(existsSync(notesPath), true);

	const staleVerify = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t13s"], {
		input: `${parsedSuperseded.message}\n`,
		env: verifyEnv,
		encoding: "utf8",
	});
	assert.equal(staleVerify.status, 1);
	assert.notEqual(staleVerify.stdout.trim(), "valid");

	// (a) A newer Stop with no owner rows ends the old card so a send for the old card is refused.
	await producer.addReport({ address: "t13s", reportText: MOCKUP_FIXTURE });
	await press(producer, "choose", { targetCoordinator: "t13s", optionId: "o1" });
	const oldCardSendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t13s" });
	const noOwnerStopMs = performance.timeOrigin + performance.now() + 1;
	writeFileSync(
		join(eventsDir, `stop-${String(Math.floor(noOwnerStopMs)).padStart(16, "0")}-b2c3d4e5.json`),
		JSON.stringify({
			type: "stop",
			address: "t13s",
			reportText: "All checks passed.\n\n## Next\n\nNone. No work is left.",
			timeMs: noOwnerStopMs,
			at: new Date(noOwnerStopMs).toISOString(),
		}),
		{ mode: 0o600 },
	);
	await producer.pollEventsNow();
	const sendsBeforeOldCard = fakeHc.readCalls().filter((c) => c.args[0] === "send").length;
	const oldCardRes = await producer.handleRawAction(oldCardSendPayload);
	assert.equal(oldCardRes.handled, false);
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, sendsBeforeOldCard);

	// (b) When report B is shown, an older Stop for report A in a later poll leaves B's cards intact.
	const reportB = "Report B ready.\n\n## Next\n\n- **[A]** Owner decides: Keep B choice one, or B choice two.";
	const reportA = "Report A stale.\n\n## Next\n\n- **[A]** Owner decides: Keep A choice one, or A choice two.";
	const reportBMs = noOwnerStopMs + 10;
	const reportAMs = reportBMs - 5;
	await producer.addReport({ address: "t13s", reportText: reportB, eventTimeMs: reportBMs });
	writeFileSync(
		join(eventsDir, `stop-${String(Math.floor(reportAMs)).padStart(16, "0")}-c3d4e5f6.json`),
		JSON.stringify({
			type: "stop",
			address: "t13s",
			reportText: reportA,
			timeMs: reportAMs,
			at: new Date(reportAMs).toISOString(),
		}),
		{ mode: 0o600 },
	);
	await producer.pollEventsNow();
	const shownAfterOld = rowByLabel(producer.getState(), "A", "t13s");
	assert.equal(shownAfterOld.row.text.includes("Keep B choice one"), true);
	assert.equal(shownAfterOld.row.text.includes("Keep A choice one"), false);
});

// Test 4: A marker in `## Checks` (including under a compact-looking line) and unrelated env vars never leak.
test("4. a marker in Checks and unrelated environment variables reach no sink, log, or leftover file", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t4-");
	const stateDir = join(dir, "state");
	const eventsDir = join(stateDir, "events");
	const pickLogPath = join(stateDir, "picks.jsonl");
	const dummiesFile = join(dir, "state.json");
	writeFileSync(dummiesFile, JSON.stringify({ claude: "on" }));
	const MARKER = "CHECKS_SENSITIVE_MARKER_9417";
	const CANARY_ENV = "OWNER_POPUP_UNRELATED_CANARY_9417";

	const reportWithMarker = MOCKUP_FIXTURE.replace(
		"pass 42\nfail 0\n```",
		`pass 42\n${MARKER}_FENCED\nfail 0\n\`\`\`\n2. local note ${MARKER}_PLAIN`,
	);

	// Compact-looking lines placed inside `## Checks` of a detailed report must never enter the excerpt.
	const reportCompactInChecks = MOCKUP_FIXTURE.replace(
		"pass 42\nfail 0\n```",
		`pass 42\nfail 0\n\`\`\`\n**REPORT 3** ${MARKER}_COMPACT_HEAD\n**OUTCOME** ${MARKER}_OUTCOME_HEAD\n**Warning:** ${MARKER}_COMPACT_WARN`,
	);
	assert.equal(extractExcerpt(reportCompactInChecks).includes(MARKER), false, "compact-looking lines inside Checks must not enter excerpt");

	const fakeHc = makeFakeHc(dir, {
		address: "t11y",
		name: "tenant-pi-coordinator-9",
		state: "live",
		status: { state: "idle" },
		labels: { "skill.role": "coordinator" },
	});

	const fakeDecider = await startFakeDecider(t, (reqPath, body, res) => {
		if (reqPath === "/health") {
			sendJson(res, { ok: true });
			return;
		}
		sendJson(
			res,
			buildDeciderScorePayload(
				body,
				(keys) => Object.fromEntries(keys.map((k, idx) => [k, idx === 0 ? 0.72 : 0.28 / Math.max(1, keys.length - 1)])),
				() => 0.05,
			),
		);
	});

	const fakePi = makeFakePi(dir, [
		`${JSON.stringify({ label: "D", options: ["Only fixes", "Fixes plus footer", "Hold release"] })}\n`,
	]);

	const pollutedEnv: NodeJS.ProcessEnv = {
		...process.env,
		[CANARY_ENV]: "unrelated-session-marker",
		HC_TERMINAL_ID: "t99x",
		DECISION_API_KEY: "test",
		TENANTEXT_LITELLM_API_KEY: "test",
	};

	const producer = await createProducer({
		port: 0,
		stateDir,
		eventsDir,
		pickLogPath,
		dummiesFile,
		hc: createHcClient(fakeHc.binPath, pollutedEnv),
		decider: { baseUrl: fakeDecider.url, apiKey: "k" },
		writer: { piBin: fakePi.binPath, env: pollutedEnv },
	});
	t.after(() => producer.close());

	const client = await connectWs(t, producer.port);
	mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
	const stopTimeMs = performance.timeOrigin + performance.now();
	writeFileSync(
		join(eventsDir, `stop-${String(Math.floor(stopTimeMs)).padStart(16, "0")}-1234abcd.json`),
		JSON.stringify({
			type: "stop",
			address: "t11y",
			reportText: reportWithMarker,
			timeMs: stopTimeMs,
			at: new Date(stopTimeMs).toISOString(),
		}),
		{ mode: 0o600 },
	);
	await producer.pollEventsNow();
	await producer.waitForPendingWork();

	// Also feed the report with compact-looking Checks lines through addReport; nothing may leak.
	await producer.addReport({ address: "t12c", reportText: reportCompactInChecks });
	await producer.waitForPendingWork();

	// Send one answer with a distinct marker so pick log privacy is verified without pinning fixture prose.
	const ANSWER_MARKER = "ANSWER_TEXT_MARKER_9417";
	await press(producer, "other", { targetCoordinator: "t11y", other: ANSWER_MARKER });
	const sendPayload = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y" });
	client.ws.send(sendPayload);
	await waitUntil(() => existsSync(pickLogPath), "pick log written");

	// Verify scoring occurred and zero marker leakage anywhere.
	assert.equal(fakeDecider.requests.some((r) => r.path === "/v1/systemone"), true);
	assert.equal(JSON.stringify(fakeDecider.requests).includes(MARKER), false);

	const piCapture = JSON.parse(readFileSync(fakePi.captureFile, "utf8")) as {
		argv: string[];
		stdin: string;
		cwd: string;
		agentDir: string;
		envKeys: string[];
	};
	assert.equal(JSON.stringify(piCapture.argv).includes(MARKER), false);
	assert.equal(piCapture.stdin.includes(MARKER), false);
	assert.equal(existsSync(piCapture.cwd), false);
	assert.equal(existsSync(piCapture.agentDir), false);

	// Child environment isolation: made-up variable and cross-child variables must not reach pi or hc.
	assert.equal(piCapture.envKeys.includes(CANARY_ENV), false);
	assert.equal(piCapture.envKeys.includes("DECISION_API_KEY"), false);
	assert.equal(piCapture.envKeys.includes("HC_TERMINAL_ID"), false);

	const hcCalls = fakeHc.readCalls();
	assert.ok(hcCalls.length > 0);
	const hcSendCalls = hcCalls.filter((c) => c.args[0] === "send");
	assert.equal(hcSendCalls.some((c) => parseHcSendArgs(c.args).message.includes(ANSWER_MARKER)), true);
	for (const call of hcCalls) {
		assert.equal(call.envKeys.includes(CANARY_ENV), false);
		assert.equal(call.envKeys.includes("DECISION_API_KEY"), false);
		assert.equal(call.envKeys.includes("TENANTEXT_LITELLM_API_KEY"), false);
		assert.equal(call.envKeys.includes("HC_TERMINAL_ID"), false);
	}

	assert.equal(JSON.stringify(client.frames).includes(MARKER), false);
	assert.equal(JSON.stringify(hcCalls.map((c) => c.args)).includes(MARKER), false);
	assert.deepEqual(readdirSync(eventsDir), []);

	const pickLogText = readFileSync(pickLogPath, "utf8");
	assert.equal(statSync(pickLogPath).mode & 0o777, 0o600);
	assert.equal(pickLogText.includes(MARKER), false);
	assert.equal(pickLogText.includes(ANSWER_MARKER), false);
});

// Test 5: Every producer A2UI message for the fixtures passes checkA2uiMessages across row and state transitions.
test("5. every producer A2UI message for the fixtures passes checkA2uiMessages across row and state transitions", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t5-");
	const fakeDecider = await startFakeDecider(t, (reqPath, body, res) => {
		if (reqPath === "/health") {
			sendJson(res, { ok: true });
			return;
		}
		sendJson(
			res,
			buildDeciderScorePayload(
				body,
				(keys, prompt) =>
					Object.fromEntries(keys.map((k, idx) => [k, prompt.includes("[B]") ? (idx === 0 ? 0.72 : idx === 1 ? 0.19 : 0.06) : 1 / keys.length])),
				(prompt) => (prompt.includes("[C]") ? 0.65 : 0.05),
			),
		);
	});
	const fakePi = makeFakePi(dir, [
		`${JSON.stringify({ label: "D", options: ["Only fixes", "Fixes and footer", "Defer release"] })}\n`,
	]);

	const producer = await createProducer({
		port: 0,
		printOnly: true,
		onPrint: () => {},
		decider: { baseUrl: fakeDecider.url },
		writer: { piBin: fakePi.binPath },
	});
	t.after(() => producer.close());

	const client = await connectWs(t, producer.port);
	await producer.addReport({ address: "t11y", name: "tenant-pi-coordinator-9", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await producer.waitForPendingWork();

	const sidA = surfaceIdFor("t11y");
	const sidB = surfaceIdFor("t12z");
	const hasSurface = (f: unknown[], sid: string) => f.some((m) => surfaceIdOfMessage(m as Record<string, unknown>) === sid);

	// Add second coordinator with compact syntax fixture -> gets its own surface and leaves coordinator A unchanged.
	await producer.addReport({ address: "t12z", name: "tenant-pi-coordinator-10", reportText: COMPACT_FIXTURE, skipRoleCheck: true });
	await producer.waitForPendingWork();
	// The client-side boundary: the frames before the createSurface of B hold every frame of A sent before B.
	await waitUntil(
		() => client.messages.some((m) => "createSurface" in m && surfaceIdOfMessage(m) === sidB),
		"client receives the surface of B",
	);
	const bCreateIndex = client.frames.findIndex((f) =>
		f.some((m) => "createSurface" in (m as Record<string, unknown>) && surfaceIdOfMessage(m as Record<string, unknown>) === sidB),
	);
	const aFramesBeforeB = client.frames.slice(0, bCreateIndex).filter((f) => hasSurface(f, sidA)).length;
	assert.equal(
		client.frames.filter((f) => hasSurface(f, sidA)).length,
		aFramesBeforeB,
		"report of coordinator B must leave surface of coordinator A unchanged",
	);

	// A new client connecting while both surfaces are live gets one createSurface batch for each live surface.
	const lateClient = await connectWs(t, producer.port);
	await waitUntil(
		() =>
			lateClient.messages.some((m) => "createSurface" in m && surfaceIdOfMessage(m) === sidA) &&
			lateClient.messages.some((m) => "createSurface" in m && surfaceIdOfMessage(m) === sidB),
		"late client receives both surfaces",
	);

	// Choose across rows, confirm risky [C], answer and uncheck [D], use a typed text for [E], send t11y (the unchecked
	// [D] stays; print mode has no turn, so it stays usable), act on the rows left, then close both surfaces.
	const steps: Array<{
		name: ActionName;
		targetCoordinator?: string;
		targetLabel?: string;
		optionId?: string;
		other?: string;
		refused?: boolean;
	}> = [
		{ name: "choose", targetCoordinator: "t11y", targetLabel: "B", optionId: "o1" },
		{ name: "choose", targetCoordinator: "t11y", targetLabel: "C", optionId: "o1" },
		{ name: "confirm", targetCoordinator: "t11y", targetLabel: "C" },
		{ name: "choose", targetCoordinator: "t11y", targetLabel: "D", optionId: "o1" },
		{ name: "toggle", targetCoordinator: "t11y", targetLabel: "D" },
		{ name: "other", targetCoordinator: "t11y", targetLabel: "E", other: "Only the fixes" },
		{ name: "send", targetCoordinator: "t11y" },
		{ name: "choose", targetCoordinator: "t11y", targetLabel: "D", optionId: "o1" },
		{ name: "toggle", targetCoordinator: "t11y", targetLabel: "D" },
		{ name: "close", targetCoordinator: "t11y" },
		{ name: "close", targetCoordinator: "t12z" },
	];
	for (const step of steps) {
		if (step.name === "close" && step.targetCoordinator === "t11y") {
			// After a partial print the owner sees the rows left, with the Send button.
			const leftGroup = producer.getState().coordinators.find((c) => c.address === "t11y");
			assert.ok(leftGroup && leftGroup.rows.length > 0);
			assert.equal(renderedButtonSpecs(leftGroup).has("btn_send"), true);
		}
		const res = await producer.handleRawAction(buildButtonAction(producer.getState(), step.name, step));
		assert.equal(res.handled, !step.refused, `action ${step.name} gives the wrong result`);
	}
	await waitUntil(
		() =>
			client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === sidA) &&
			client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === sidB),
		"both deleteSurface messages received",
	);

	// Validate every emitted frame statefully against checkA2uiMessages + Herdr app constraints.
	const known = new Map<string, { components: Map<string, unknown>; data: Record<string, unknown> }>();

	for (const frame of client.frames) {
		const checked = checkA2uiMessages(frame, known);
		assert.equal(checked.ok, true, checked.ok ? "" : checked.error);

		for (const rawMsg of frame as Array<Record<string, unknown>>) {
			if (rawMsg.createSurface) {
				const cs = rawMsg.createSurface as { surfaceId: string; components: A2uiComponent[]; dataModel?: Record<string, unknown> };
				known.set(cs.surfaceId, {
					components: new Map(cs.components.map((c) => [c.id, c])),
					data: structuredClone(cs.dataModel ?? {}),
				});
			} else if (rawMsg.updateComponents) {
				const uc = rawMsg.updateComponents as { surfaceId: string; components: A2uiComponent[] };
				const cur = known.get(uc.surfaceId)!;
				for (const c of uc.components) cur.components.set(c.id, c);
			} else if (rawMsg.updateDataModel) {
				const ud = rawMsg.updateDataModel as { surfaceId: string; value?: Record<string, unknown> };
				const cur = known.get(ud.surfaceId)!;
				cur.data = structuredClone(ud.value ?? {});
			} else if (rawMsg.deleteSurface) {
				known.delete((rawMsg.deleteSurface as { surfaceId: string }).surfaceId);
			}

			// Verify Herdr-supported components, weight-only sizing, and bound-path visibility on every live component set.
			const body = (rawMsg.createSurface ?? rawMsg.updateComponents) as { components?: A2uiComponent[] } | undefined;
			if (!body?.components) continue;
			const renderedPaths = new Set<string>();
			for (const c of body.components) {
				assert.ok(SUPPORTED_HERDR_COMPONENTS.has(c.component), `unsupported component: ${c.component}`);
				assert.equal("width" in c, false, "width must not appear");
				assert.equal("flex" in c, false, "flex must not appear");
				assert.equal("distribution" in c, false, "distribution must not appear");
				if ((c.component === "ChoicePicker" || c.component === "TextField") && c.value && typeof c.value === "object") {
					const p = (c.value as { "@path"?: string })["@path"];
					if (p) renderedPaths.add(p);
				}
			}
			for (const c of body.components) {
				if (c.component !== "Button") continue;
				const ctx = (c.action as { event?: { context?: Record<string, unknown> } })?.event?.context ?? {};
				for (const val of Object.values(ctx)) {
					if (val && typeof val === "object" && "@path" in val) {
						const bound = (val as { "@path": string })["@path"];
						assert.ok(renderedPaths.has(bound), `button ${c.id} binds unrendered path ${bound}`);
					}
				}
			}
		}
	}
});

// Test 6: Broken writer lines and a down/slow/malformed decider keep earlier rows, choices, and custom text.
test("6. broken writer output and down, slow, or malformed decider keep earlier rows, choices, and custom text", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t6-");
	const reportTwoOpen = [
		"Build is ready; two open design choices remain.",
		"",
		"## Next",
		"",
		"- **[A]** Owner decides: Output format: JSON, or plain text.",
		"- **[B]** Owner decides: How the first archive step should work.",
		"- **[C]** Owner decides: Choose location: Paris, France or London.",
	].join("\n");

	// Fake pi emits: chunk-split valid row B, doubled row B with different options (must be ignored),
	// broken JSON line, and an over-cap >4000 char flood so C never completes cleanly.
	const fakePi = makeFakePi(dir, [
		'{"label":"B",',
		'"options":["First valid B","Second valid B"]}\n',
		'{"label":"B","options":["Doubled B should be ignored"]}\n',
		"{not-valid-json\n",
		`${"x".repeat(4500)}\n`,
		'{"label":"C","options":["After cap"]}\n',
	]);

	// Decider returns malformed JSON for row A and stalls past timeout for later rows.
	let callCount = 0;
	const flakyDecider = await startFakeDecider(t, async (reqPath, _body, res) => {
		if (reqPath === "/health") {
			sendJson(res, { ok: true });
			return;
		}
		callCount += 1;
		if (callCount === 1) {
			sendJson(res, { answers: { rank: "malformed" } });
			return;
		}
		await new Promise((r) => setTimeout(r, 250));
		if (!res.writableEnded) sendJson(res, {});
	});

	const producer = await createProducer({
		port: 0,
		printOnly: true,
		decider: { baseUrl: flakyDecider.url, rowTimeoutMs: 60, phaseTimeoutMs: 150 },
		writer: { piBin: fakePi.binPath, maxChars: 4000, timeoutMs: 5000 },
	});
	t.after(() => producer.close());

	await producer.addReport({ address: "t11y", reportText: reportTwoOpen, skipRoleCheck: true });
	// Record owner's custom text on row A immediately while async work runs.
	await press(producer, "other", { targetCoordinator: "t11y", targetLabel: "A", other: "My kept custom text" });
	await producer.waitForPendingWork();

	const st = producer.getState();
	const rowA = rowByLabel(st, "A", "t11y");
	const rowB = rowByLabel(st, "B", "t11y");
	const rowC = rowByLabel(st, "C", "t11y");

	// Row A kept its original split choices in order AND the owner's custom text.
	assert.deepEqual(rowA.row.options.slice(0, 2).map((o) => o.text), ["JSON", "Plain text"]);
	assert.equal(rowA.customText, "My kept custom text");
	// Row B kept the FIRST valid chunked line and ignored the doubled replacement.
	assert.equal(rowB.row.options.some((o) => o.text === "First valid B"), true);
	assert.equal(rowB.row.options.some((o) => o.text.includes("Doubled")), false);
	// Row C stayed unsplit (ambiguous comma list) and remained usable with fallback answers after cap stop.
	assert.equal(rowC.row.writing, false);
	assert.ok(rowC.row.options.length >= 2);
	assert.equal(rowC.row.options.some((o) => o.text === "Paris" || o.text === "France" || o.text === "After cap"), false);

	// A comma or `or` inside parentheses or a code span is not a split point.
	assert.deepEqual(splitChoices("Push `main` (4 commits, the rail change) to `origin` now, or hold the push until the new rail is tried."), [
		"Push `main` (4 commits, the rail change) to `origin` now",
		"Hold the push until the new rail is tried",
	]);
	assert.deepEqual(splitChoices("Use the cache (memory or disk) for the build, or skip the cache."), [
		"Use the cache (memory or disk) for the build",
		"Skip the cache",
	]);
	assert.deepEqual(splitChoices("Run `make lint, test` first, or ship the build now."), ["Run `make lint, test` first", "Ship the build now"]);
});

// Test 7: A risky row has no recommended mark, rejects stale-revision confirm, and requires confirmation with decider up or down.
test("7. a risky row gets no recommended mark, rejects old-revision confirm, and requires confirmation with decider up or down", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t7-");
	const printed: string[] = [];

	// Part A: Decider UP with high rank prob (0.91) and high risk prob (0.80) on a row without risk keywords.
	const deciderUp = await startFakeDecider(t, (reqPath, body, res) => {
		if (reqPath === "/health") {
			sendJson(res, { ok: true });
			return;
		}
		sendJson(
			res,
			buildDeciderScorePayload(
				body,
				(keys) => Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.91 : 0.09 / Math.max(1, keys.length - 1)])),
				() => 0.8,
			),
		);
	});

	const reportModelRisk1 = [
		"The change is ready.",
		"",
		"## Next",
		"",
		"- **[A]** Owner decides: Apply the billing change now, or wait until Monday.",
	].join("\n");
	const reportModelRisk2 = [
		"The revised change is ready.",
		"",
		"## Next",
		"",
		"- **[A]** Owner decides: Apply the revised billing change now, or wait until Tuesday.",
	].join("\n");

	const producerUp = await createProducer({
		port: 0,
		printOnly: true,
		onPrint: (line) => printed.push(line),
		decider: { baseUrl: deciderUp.url },
		writer: false,
	});
	t.after(() => producerUp.close());

	await producerUp.addReport({ address: "t11y", reportText: reportModelRisk1, skipRoleCheck: true });
	await producerUp.waitForPendingWork();

	const rowA1 = rowByLabel(producerUp.getState(), "A", "t11y");
	assert.equal(rowA1.row.risky, true);
	assert.equal(rowA1.row.options.some((o) => o.recommended), false);
	assert.equal(rowA1.selectedOptionId, null);

	// Pick o1 and try send WITHOUT confirm -> refused, nothing sent.
	await press(producerUp, "choose", { targetCoordinator: "t11y", optionId: "o1" });
	const unconfirmedSend = await press(producerUp, "send", { targetCoordinator: "t11y" });
	assert.equal(unconfirmedSend.handled, false);
	assert.equal(printed.length, 0);

	// Capture a valid confirm action from revision 1, then replace the report with revision 2.
	const oldRevisionConfirm = buildButtonAction(producerUp.getState(), "confirm", {
		targetCoordinator: "t11y",
		targetLabel: "A",
		other: "",
	});
	await producerUp.addReport({ address: "t11y", reportText: reportModelRisk2, skipRoleCheck: true });
	await producerUp.waitForPendingWork();

	// Confirm from the old revision must be refused without changing the new report's row.
	const staleConfirmRes = await producerUp.handleRawAction(oldRevisionConfirm);
	assert.equal(staleConfirmRes.handled, false);
	const rowA2Before = rowByLabel(producerUp.getState(), "A", "t11y");
	assert.equal(rowA2Before.confirmed, false);
	assert.equal(rowA2Before.selectedOptionId, null);

	// Pick and confirm on the current revision, then send -> delivers exactly once.
	await press(producerUp, "choose", { targetCoordinator: "t11y", optionId: "o1" });
	await press(producerUp, "confirm", { targetCoordinator: "t11y", targetLabel: "A" });
	await press(producerUp, "send", { targetCoordinator: "t11y" });
	assert.equal(printed.length, 1);

	// Part B: Decider DOWN -> word-list risky row (destructive verb) still tagged risky and blocked until confirm.
	const fakeHc = makeMemoryHc({
		address: "t11y",
		name: "tenant-pi-coordinator-9",
		state: "live",
		agentStatus: "idle",
		role: "coordinator",
	});
	const producerDown = await createProducer({
		port: 0,
		stateDir: join(dir, "state-down"),
		hc: fakeHc.client,
		decider: false,
		writer: false,
	});
	t.after(() => producerDown.close());

	await producerDown.addReport({
		address: "t11y",
		reportText: "Checks passed.\n\n## Next\n\n- **[A]** Owner decides: Truncate the audit table, or archive it first.",
		skipRoleCheck: true,
	});
	const rowDown = rowByLabel(producerDown.getState(), "A", "t11y");
	assert.equal(rowDown.row.risky, true);
	assert.equal(rowDown.row.options.some((o) => o.recommended), false);
	// Markdown emphasis around the leading action word does not hide it.
	assert.equal(isRiskyByWords("**Restart** nginx"), true);

	// A chosen answer waits for Confirm: no check mark on row A, A stays out of `right` and out of the count.
	const downGroup = () => producerDown.getState().coordinators[0];
	await press(producerDown, "choose", { targetCoordinator: "t11y", optionId: "o1" });
	assert.deepEqual(pendingRowView(downGroup(), "A"), { checkMark: false, inRight: false, count: 0 });
	// A Confirm of the surface of o1 does not approve o2, chosen after it: refused, and Send sends nothing.
	const confirmOfO1 = buildButtonAction(producerDown.getState(), "confirm", { targetCoordinator: "t11y", targetLabel: "A" });
	await press(producerDown, "choose", { targetCoordinator: "t11y", optionId: "o2" });
	assert.equal((await producerDown.handleRawAction(confirmOfO1)).handled, false);
	assert.deepEqual(pendingRowView(downGroup(), "A"), { checkMark: false, inRight: false, count: 0 });
	const rowAo2 = rowByLabel(producerDown.getState(), "A", "t11y");
	const o2Text = rowAo2.row.options.find((o) => o.id === "o2")?.text;
	assert.equal(effectiveAnswer(rowAo2)?.text, o2Text);
	await press(producerDown, "send", { targetCoordinator: "t11y" });
	assert.equal(fakeHc.sends.length, 0);
	// The Confirm of the current surface approves o2, and Send sends it: the row is not blocked.
	assert.equal((await press(producerDown, "confirm", { targetCoordinator: "t11y", targetLabel: "A" })).handled, true);
	await press(producerDown, "send", { targetCoordinator: "t11y" });
	assert.equal(fakeHc.sends.length, 1);
	assert.equal(fakeHc.sends[0].text.includes(String(o2Text)), true);

	// A second report with risky A and plain B. An answer from "Use text" also waits for Confirm, with no check mark.
	await producerDown.addReport({
		address: "t11y",
		reportText: "Checks passed.\n\n## Next\n\n- **[A]** Owner decides: Truncate the audit table, or archive it first.\n- **[B]** Owner decides: Use JSON, or use YAML.",
		skipRoleCheck: true,
	});
	await press(producerDown, "choose", { targetCoordinator: "t11y", targetLabel: "A", optionId: "o1" });
	// This old Confirm carries the draft key of B, whose field is drawn now.
	const confirmWithDraftB = buildButtonAction(producerDown.getState(), "confirm", { targetCoordinator: "t11y", targetLabel: "A", drafts: { B: "" } });
	const typedRisky = "TYPED_RISKY_ANSWER_5121";
	assert.equal((await press(producerDown, "other", { targetCoordinator: "t11y", targetLabel: "A", other: typedRisky })).handled, true);
	assert.deepEqual(pendingRowView(downGroup(), "A"), { checkMark: false, inRight: false, count: 0 });
	await press(producerDown, "send", { targetCoordinator: "t11y" });
	assert.equal(fakeHc.sends.length, 1);
	// B is answered, so its field is no longer drawn. The old Confirm with its key is refused with a status line.
	await press(producerDown, "choose", { targetCoordinator: "t11y", targetLabel: "B", optionId: "o1" });
	const rowsBefore = structuredClone(downGroup().rows);
	assert.equal((await producerDown.handleRawAction(confirmWithDraftB)).handled, false);
	assert.deepEqual(downGroup().rows, rowsBefore);
	assert.equal(buildSurfaceSpec(downGroup()).components.some((c) => c.id === "status_line"), true);

	await press(producerDown, "confirm", { targetCoordinator: "t11y", targetLabel: "A" });
	await press(producerDown, "send", { targetCoordinator: "t11y" });
	assert.equal(fakeHc.sends.length, 2);
	assert.equal(fakeHc.sends[1].text.includes(typedRisky), true);
});

// Test 8: Producer refuses non-local peer/Host/Origin, 5th socket, >16 KiB frame, and invalid actions without side effects.
test("8. producer refuses non-local peer, Host, Origin, 5th socket, >16 KiB frame, and invalid actions", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t8-");
	const fakeHc = makeMemoryHc({
		address: "t11y",
		name: "tenant-pi-coordinator-9",
		state: "live",
		agentStatus: "idle",
		role: "coordinator",
	});

	let spoofPeer: string | null = null;
	const producer = await createProducer({
		port: 0,
		stateDir: join(dir, "state"),
		hc: fakeHc.client,
		decider: false,
		writer: false,
		peerAddress: (req) => spoofPeer ?? req.socket.remoteAddress ?? "",
	});
	t.after(() => producer.close());

	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await producer.addReport({ address: "t12z", reportText: COMPACT_FIXTURE, skipRoleCheck: true });
	// A second report of t11y replaces its first view: a press of the first view is a stale press.
	const oldRevA = producer.getState().coordinators.find((c) => c.address === "t11y")?.revision;
	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });

	const foreignHost = ["evil", "invalid"].join(".");
	spoofPeer = "198.51.100.24";
	assert.equal((await rawUpgrade(producer.port, "/a2ui")).status, 403);
	spoofPeer = null;

	assert.equal((await rawUpgrade(producer.port, "/a2ui", { host: `${foreignHost}:${producer.port}` })).status, 403);
	assert.equal((await rawUpgrade(producer.port, "/a2ui", { origin: `http://${foreignHost}` })).status, 403);
	assert.ok((await rawUpgrade(producer.port, "/a2ui?x=1")).status >= 400);
	assert.ok((await rawUpgrade(producer.port, "/other")).status >= 400);

	// Oversize client frame header (16385 bytes > 16 KiB) closes early with protocol code 1009.
	const oversizeHeader = Buffer.from([0x81, 0xfe, 0x40, 0x01, 0x11, 0x22, 0x33, 0x44]);
	assert.equal(await rawFrameCloseCode(producer.port, "/a2ui", oversizeHeader), 1009);

	// Plain HTTP POST cannot add a task.
	const httpRes = await fetch(`http://127.0.0.1:${producer.port}/a2ui`, { method: "POST", body: "{}" });
	assert.ok(httpRes.status >= 400);

	// 4 open sockets succeed; 5th gets 503.
	const clients = [];
	for (let i = 0; i < 4; i += 1) clients.push(await connectWs(t, producer.port));
	assert.equal((await rawUpgrade(producer.port, "/a2ui")).status, 503);

	const snapshotState = (st: SurfaceState) => ({
		groups: st.coordinators.map((g) => ({ address: g.address, revision: g.revision })),
		answers: st.coordinators.flatMap((g) =>
			g.rows.map((r) => ({
				address: g.address,
				label: r.row.label,
				selectedOptionId: r.selectedOptionId,
				customText: r.customText,
				draft: r.draft,
				confirmed: r.confirmed,
				checked: r.checked,
			})),
		),
	});

	// Row B is answered (drawn in `right`), so its answer buttons, its field and its draft binding are gone.
	assert.equal((await choose(producer, "t11y", "o1", "B")).handled, true);
	const stateNow = producer.getState();
	const sidA = surfaceIdFor("t11y");
	const rev = stateNow.coordinators.find((c) => c.address === "t11y")?.revision;
	const before = snapshotState(stateNow);

	// A press of the replaced view: the client that pressed gets the current surface again with a status line.
	const stale = clients[0];
	const framesBefore = stale.frames.length;
	stale.ws.send(JSON.stringify({
		version: "1.0",
		action: { name: "choose", surfaceId: sidA, sourceComponentId: "answer_C_o1", timestamp: new Date().toISOString(), context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: oldRevA, optionId: "o1", other_C: "should not apply" } },
	}));
	await waitUntil(
		() => stale.frames.slice(framesBefore).some((frame) => (frame as Record<string, unknown>[]).some((m) =>
			((m.createSurface ?? m.updateComponents) as { components?: A2uiComponent[] } | undefined)?.components?.some((c) => c.id === "status_line"))),
		"the current view with a status line",
	);
	// A rendered Close of B with only the surface ID changed to the surface of A.
	const mismatched = JSON.parse(buildButtonAction(stateNow, "close", { targetCoordinator: "t12z", surfaceId: sidA })).action;

	const badActions = [
		{ name: "send", surfaceId: "other-surface", sourceComponentId: "btn_send", context: { targetCoordinator: "t11y", targetRevision: rev } },
		{ name: "send", surfaceId: surfaceIdFor("t99z"), sourceComponentId: "btn_send", context: { targetCoordinator: "t99z", targetRevision: rev } },
		mismatched,
		// A choose of the answered row B, a Use text and a Confirm of an unknown row, a choose of row C that names row B.
		{ name: "choose", surfaceId: sidA, sourceComponentId: "answer_B_o2", context: { targetCoordinator: "t11y", targetLabel: "B", targetRevision: rev, optionId: "o2" } },
		{ name: "other", surfaceId: sidA, sourceComponentId: "use_text_Z", context: { targetCoordinator: "t11y", targetLabel: "Z", targetRevision: rev, other_Z: "should not apply" } },
		{ name: "confirm", surfaceId: sidA, sourceComponentId: "confirm_C", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev } },
		{ name: "choose", surfaceId: sidA, sourceComponentId: "answer_C_o1", context: { targetCoordinator: "t11y", targetLabel: "B", targetRevision: rev, optionId: "o1", other_C: "should not apply" } },
		// A stale revision, a draft of the answered row B, an unknown option, a toggle of the open row C, a wrong coordinator.
		{ name: "choose", surfaceId: sidA, sourceComponentId: "answer_C_o1", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: `${rev}0`, optionId: "o1", other_C: "should not apply" } },
		{ name: "other", surfaceId: sidA, sourceComponentId: "use_text_C", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev, other_B: "should not apply", other_C: "should not apply" } },
		{ name: "other", surfaceId: sidA, sourceComponentId: "use_text_C", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev, other_B: null, other_C: "should not apply" } },
		{ name: "choose", surfaceId: sidA, sourceComponentId: "answer_C_o1", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev, optionId: "o99" } },
		{ name: "toggle", surfaceId: sidA, sourceComponentId: "toggle_C", context: { targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev } },
		{ name: "send", surfaceId: sidA, sourceComponentId: "btn_send", context: { targetCoordinator: "t999", targetRevision: rev, other_C: "should not apply" } },
		{ name: "add_task", surfaceId: sidA, sourceComponentId: "x", context: { address: "t22x", reportText: MOCKUP_FIXTURE } },
	];
	for (const bad of badActions) {
		const res = await producer.handleRawAction(
			JSON.stringify({
				version: "1.0",
				action: {
					name: bad.name,
					surfaceId: bad.surfaceId,
					sourceComponentId: bad.sourceComponentId,
					timestamp: new Date().toISOString(),
					context: bad.context,
				},
			}),
		);
		assert.equal(res.handled, false);
	}
	assert.deepEqual(snapshotState(producer.getState()), before);
	assert.equal(fakeHc.sends.length, 0);
});

// Test 9: a nested `claude -p` run of the coordinator terminal (a hook or a tool starts it) ends no receipt.
test("9. the Stop of a nested claude -p run in the coordinator terminal keeps the receipt of the delivered answer", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t9-");
	const stateDir = join(dir, "state");
	const eventsDir = join(stateDir, "events");
	const dummiesFile = join(dir, "dummies.json");
	writeFileSync(dummiesFile, JSON.stringify({ claude: "on" }));
	const fakeKit = join(dir, "kit");
	const fakeProducerDir = join(fakeKit, "packages", "tenantext", "owner-popup");
	mkdirSync(fakeProducerDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeProducerDir, "producer.ts"), "", { mode: 0o600 });
	const settingsFile = join(dir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ enabled: true, kitRoot: fakeKit }), { mode: 0o600 });
	chmodSync(settingsFile, 0o600);

	const fakeHc = makeMemoryHc({
		address: "t13v",
		name: "tenant-pi-coordinator-2",
		state: "live",
		agentStatus: "idle",
		role: "coordinator",
	});
	const producer = await createProducer({ port: 0, stateDir, eventsDir, dummiesFile, hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t13v", reportText: MOCKUP_FIXTURE });
	await choose(producer, "t13v", "o1");
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t13v" }),
	);
	assert.equal(res.handled, true);
	assert.equal(fakeHc.sends.length, 1);

	const nested = spawnSync(process.execPath, [HOOK_SCRIPT, "stop"], {
		input: JSON.stringify({ stop_hook_active: false, last_assistant_message: "A digest of recalled memory." }),
		env: {
			...process.env,
			HC_TERMINAL_ID: "t13v",
			OWNER_POPUP_SETTINGS: settingsFile,
			OWNER_POPUP_STATE_DIR: stateDir,
			CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
		},
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(nested.status, 0);
	await producer.pollEventsNow();

	const verified = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t13v"], {
		input: `${fakeHc.sends[0].text}\n`,
		env: { ...process.env, OWNER_POPUP_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(verified.stdout.trim(), "valid");
	assert.equal(verified.status, 0);
});

// Test 10: an action on the cards of a coordinator also withdraws a press that waits in its first lookup.
test("10. a Close during the first lookup of a press sends nothing, and a Close of another coordinator keeps the press", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t10-");
	const stateDir = join(dir, "state");
	const idle = (address: string): TerminalRecord => ({ address, state: "live", agentStatus: "idle", role: "coordinator" });
	const fakeHc = makeMemoryHc(idle("t11y"));
	// The next `hc get` resolves `held` and waits for `gate` when `hold` is set.
	let hold: { held: () => void; gate: Promise<void> } | null = null;
	const holdNextGet = (): { getHeld: Promise<void>; releaseGet: () => void } => {
		let releaseGet = () => {};
		const getHeld = new Promise<void>((resolveHeld) => {
			hold = {
				held: resolveHeld,
				gate: new Promise<void>((resolveGate) => {
					releaseGet = resolveGate;
				}),
			};
		});
		return { getHeld, releaseGet: () => releaseGet() };
	};
	const producer = await createProducer({
		port: 0,
		stateDir,
		decider: false,
		writer: false,
		hc: {
			...fakeHc.client,
			get: async (address: string) => {
				const current = hold;
				hold = null;
				if (current) {
					current.held();
					await current.gate;
				}
				return fakeHc.client.get(address);
			},
		},
	});
	t.after(() => producer.close());

	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await producer.addReport({ address: "t12z", reportText: COMPACT_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t11y", "o1");

	// A press of X waits in its first lookup; a Close of X arrives: nothing goes out. The pending form has no Close, so
	// the Close comes from the cards before the press; it withdraws the press, the cards come back, and it closes them.
	const first = holdNextGet();
	const staleClose = buildButtonAction(producer.getState(), "close", { targetCoordinator: "t11y" });
	const press = producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y" }));
	await first.getHeld;
	const close = producer.handleRawAction(staleClose);
	first.releaseGet();
	assert.equal((await press).handled, false);
	assert.equal((await close).handled, true);
	assert.equal(fakeHc.sends.length, 0);

	// A new report of X; a press of X waits in its first lookup; a Close of Y keeps the press of X, which goes out once.
	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t11y", "o1");
	const second = holdNextGet();
	const pressAgain = producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y" }));
	await second.getHeld;
	const closeOther = producer.handleRawAction(buildButtonAction(producer.getState(), "close", { targetCoordinator: "t12z" }));
	second.releaseGet();
	assert.equal((await pressAgain).handled, true);
	assert.equal((await closeOther).handled, true);
	const sent = fakeHc.sends.filter((s) => s.address === "t11y");
	assert.equal(sent.length, 1);
	const verified = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t11y"], {
		input: `${sent[0].text}\n`,
		env: { ...process.env, OWNER_POPUP_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(verified.stdout.trim(), "valid");
});

// Test 11: the cards of a coordinator exist only while it sits at its prompt, so `working` does not hold a press.
test("11. a press for a coordinator at its prompt delivers at once although hc get reports working", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t11-");
	const stateDir = join(dir, "state");
	// Background waits of the coordinator make the core report `working` while the coordinator sits at its prompt.
	const fakeHc = makeMemoryHc({ address: "t14q", state: "live", agentStatus: "working", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir, hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t14q", reportText: ONE_ROW_REPORT, skipRoleCheck: true });
	await choose(producer, "t14q", "o1");
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q" }),
	);
	assert.equal(res.handled, true);
	assert.equal(fakeHc.sends.length, 1);
	assert.equal(producer.getState().coordinators.length, 0);
	const verified = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", "t14q"], {
		input: `${fakeHc.sends[0].text}\n`,
		env: { ...process.env, OWNER_POPUP_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(verified.stdout.trim(), "valid");
});

// Test 12: a row with a condition gets no card, so its answer never goes out.
test("12. a row with a condition gets no card and is not in the send line", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t13-");
	const fakeHc = makeMemoryHc({ address: "t14q", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	const onlyConditional = "Work waits.\n\n## Next\n\n- **[A]** Owner decides, after the review: Merge it now, or hold it.";
	assert.equal((await producer.addReport({ address: "t14q", reportText: onlyConditional, skipRoleCheck: true })).accepted, false);
	assert.equal(producer.getState().coordinators.length, 0);

	const mixed = [
		"Work waits.",
		"",
		"## Next",
		"",
		"- **[A]** Owner decides, after the review: Merge it now, or hold it.",
		"- **[B]** Owner decides: Keep the percent, or show a bar.",
	].join("\n");
	assert.equal((await producer.addReport({ address: "t14q", reportText: mixed, skipRoleCheck: true })).accepted, true);
	const labels = producer.getState().coordinators[0].rows.map((r) => r.row.label);
	assert.deepEqual(labels, ["B"]);
	await choose(producer, "t14q", "o1");
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q" }),
	);
	assert.equal(res.handled, true);
	assert.equal(fakeHc.sends.length, 1);
	assert.equal(fakeHc.sends[0].text.startsWith("[Owner popup] [B] "), true);
	assert.equal(fakeHc.sends[0].text.includes("[A]"), false);
});

function verifyLine(stateDir: string, address: string, line: string): string {
	const res = spawnSync(process.execPath, [RECEIPT_SCRIPT, "verify", "--address", address], {
		input: `${line}\n`,
		env: { ...process.env, OWNER_POPUP_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	return res.stdout.trim();
}

/** A fake `hc` whose first send gives no result; it records each line that it gets and each line that it delivers. */
function makeUnknownFirstHc(record: TerminalRecord) {
	const attempts: string[] = [];
	const delivered: string[] = [];
	const client: HcClient = {
		async get() {
			return { ...record };
		},
		async send(_address, text) {
			attempts.push(text);
			if (attempts.length === 1) return { ok: false, code: 1, unknown: true, detail: "no result" };
			delivered.push(text);
			return { ok: true, code: 0, detail: "" };
		},
	};
	return { client, attempts, delivered };
}

// Test 13: a retry whose first receipt could expire before arrival is a new send with a new receipt.
test("13. a retry after an unknown send whose receipt is past its use limit sends a line whose receipt verifies", async (t) => {
	const stateDir = join(makeTempDir(t, "owner-popup-t13-"), "state");
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 9 * 60_000 });
	const fakeHc = makeUnknownFirstHc({ address: "t14q", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir, hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t14q", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t14q", "o1");
	const pressSend = () =>
		producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q" }));
	assert.equal((await pressSend()).reason, "hc-send-unknown");
	// Nine minutes later: nine minutes plus the send limit is past the receipt lifetime of ten minutes.
	t.mock.timers.tick(9 * 60_000);
	assert.equal((await pressSend()).handled, true);
	t.mock.timers.reset();

	assert.equal(fakeHc.delivered.length, 1);
	assert.notEqual(fakeHc.delivered[0], fakeHc.attempts[0]);
	assert.equal(verifyLine(stateDir, "t14q", fakeHc.delivered[0]), "valid");
	assert.notEqual(verifyLine(stateDir, "t14q", fakeHc.attempts[0]), "valid");
});

// Test 14: a new Stop report aborts a held send of the old line, so the old line never reaches the new prompt.
test("14. a new Stop report during a held send aborts it, and the old line is not delivered", async (t) => {
	const stateDir = join(makeTempDir(t, "owner-popup-t14-"), "state");
	const attempts: string[] = [];
	const delivered: string[] = [];
	let release = () => {};
	const producer = await createProducer({
		port: 0,
		stateDir,
		decider: false,
		writer: false,
		hc: {
			async get(address) {
				return { address, state: "live", agentStatus: "idle", role: "coordinator" };
			},
			// Like a draft hold: the send resolves only on abort or on release.
			send(_address, text, signal) {
				attempts.push(text);
				return new Promise((done) => {
					let settled = false;
					signal?.addEventListener("abort", () => {
						settled = true;
						done({ ok: false, code: 1, aborted: true, detail: "aborted" });
					});
					release = () => {
						if (settled) return;
						settled = true;
						delivered.push(text);
						done({ ok: true, code: 0, detail: "" });
					};
				});
			},
		},
	});
	t.after(() => producer.close());

	await producer.addReport({ address: "t14q", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t14q", "o1");
	const press = producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q" }),
	);
	await waitUntil(() => attempts.length === 1, "send held");
	await producer.addReport({ address: "t14q", reportText: COMPACT_FIXTURE, skipRoleCheck: true });
	assert.equal((await press).reason, "hc-send-aborted");
	release();

	assert.equal(delivered.length, 0);
	assert.notEqual(verifyLine(stateDir, "t14q", attempts[0]), "valid");
	assert.equal(producer.getState().coordinators.length, 1);
});

// Test 15: after an unknown send, a press with other checked rows ends the first try and sends only the new rows.
test("15. a retry after the owner changed the checked rows delivers only the new rows, and the first line no longer verifies", async (t) => {
	const stateDir = join(makeTempDir(t, "owner-popup-t15-"), "state");
	const fakeHc = makeUnknownFirstHc({ address: "t14q", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir, hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t14q", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(producer, "t14q", "o1");
	assert.equal((await press(producer, "send", { targetCoordinator: "t14q" })).handled, false);
	// The owner unchecks A, answers B, and presses Send again.
	await press(producer, "toggle", { targetCoordinator: "t14q", targetLabel: "A" });
	await choose(producer, "t14q", "o1", "B");
	assert.equal((await press(producer, "send", { targetCoordinator: "t14q" })).handled, true);

	assert.equal(fakeHc.delivered.length, 1);
	assert.deepEqual(sentLabels(fakeHc.delivered[0]), ["B"]);
	assert.notEqual(verifyLine(stateDir, "t14q", fakeHc.attempts[0]), "valid");
	assert.equal(verifyLine(stateDir, "t14q", fakeHc.delivered[0]), "valid");

	// The first line of A did arrive and verified; a press with A and B then sends no second copy of A.
	const arrivedDir = join(stateDir, "arrived");
	const arrivedHc = makeUnknownFirstHc({ address: "t15c", state: "live", agentStatus: "idle", role: "coordinator" });
	const arrived = await createProducer({ port: 0, stateDir: arrivedDir, hc: arrivedHc.client, decider: false, writer: false });
	t.after(() => arrived.close());
	await arrived.addReport({ address: "t15c", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(arrived, "t15c", "o1", "A");
	assert.equal((await press(arrived, "send", { targetCoordinator: "t15c" })).handled, false);
	assert.equal(verifyLine(arrivedDir, "t15c", arrivedHc.attempts[0]), "valid");
	await choose(arrived, "t15c", "o1", "B");
	await press(arrived, "send", { targetCoordinator: "t15c" });

	assert.equal(arrivedHc.attempts.length, 1);
	assert.deepEqual(arrived.getState().coordinators[0].rows.map((item) => item.row.label), ["B", "C"]);
	assert.equal(effectiveAnswer(rowByLabel(arrived.getState(), "B")) !== null, true);
});

// Test 15b: an old unknown first try whose receipt a sweep removed sends nothing of it, and the other rows stay usable.
test("15b. a retry after an old unknown send whose receipt is gone keeps its rows unchecked and the surface usable", async (t) => {
	const stateDir = join(makeTempDir(t, "owner-popup-t15b-"), "state");
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 11 * 60_000 });
	const sends: Array<{ address: string; text: string }> = [];
	const hc: HcClient = {
		async get(address) {
			return { address, state: "live", agentStatus: "idle", role: "coordinator" };
		},
		async send(address, text) {
			sends.push({ address, text });
			return sends.length === 1 ? { ok: false, code: 1, unknown: true, detail: "no result" } : { ok: true, code: 0, detail: "" };
		},
	};
	const producer = await createProducer({ port: 0, stateDir, hc, decider: false, writer: false });
	t.after(() => producer.close());
	const sendsToA = () => sends.filter((item) => item.address === "t15a");

	await producer.addReport({ address: "t15a", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(producer, "t15a", "o1", "A");
	assert.equal((await press(producer, "send", { targetCoordinator: "t15a" })).reason, "hc-send-unknown");
	// The first line did not arrive. Past the receipt lifetime, a send to a second coordinator sweeps its receipt.
	t.mock.timers.tick(11 * 60_000);
	await producer.addReport({ address: "t15o", reportText: ONE_ROW_REPORT, skipRoleCheck: true });
	await choose(producer, "t15o", "o1");
	assert.equal((await press(producer, "send", { targetCoordinator: "t15o" })).handled, true);
	// A press with A and B checked sends nothing; A stays with its answer, unchecked, and the surface is not locked.
	await choose(producer, "t15a", "o1", "B");
	await press(producer, "send", { targetCoordinator: "t15a" });
	assert.equal(sendsToA().length, 1);
	const rowA = rowByLabel(producer.getState(), "A", "t15a");
	assert.equal(effectiveAnswer(rowA) !== null, true);
	assert.equal(rowA.checked, false);
	assert.equal((await press(producer, "send", { targetCoordinator: "t15a" })).handled, true);
	assert.deepEqual(sentLabels(sendsToA()[1].text), ["B"]);
	t.mock.timers.reset();
});

/** The components that a client draws for one surface after the messages so far: null when it has no surface. */
function drawnComponents(messages: readonly Record<string, unknown>[], surfaceId: string): A2uiComponent[] | null {
	let components: Map<string, A2uiComponent> | null = null;
	for (const msg of messages) {
		if (surfaceIdOfMessage(msg) !== surfaceId) continue;
		if (msg.deleteSurface) components = null;
		const body = (msg.createSurface ?? msg.updateComponents) as { components?: A2uiComponent[] } | undefined;
		if (!body?.components) continue;
		if (msg.createSurface || !components) components = new Map();
		for (const comp of body.components) components.set(comp.id, comp);
	}
	if (!components) return null;
	const drawn: A2uiComponent[] = [];
	const visit = (id: string) => {
		const comp = components?.get(id);
		if (!comp) return;
		drawn.push(comp);
		const refs = [comp.child, ...(Array.isArray(comp.children) ? comp.children : [])];
		for (const ref of refs) if (typeof ref === "string") visit(ref);
	};
	visit("root");
	return drawn;
}

/** A fake `hc` whose send waits for `release` while `hold` is set, then gives `result`. */
function makeHeldHc(result: { ok: boolean; code: number; detail: string }) {
	const attempts: string[] = [];
	const control = { hold: true, release: () => {} };
	const client: HcClient = {
		async get(address) {
			return { address, state: "live", agentStatus: "idle", role: "coordinator" };
		},
		send(_address, text) {
			attempts.push(text);
			if (!control.hold) return Promise.resolve({ ...result });
			return new Promise((done) => {
				control.release = () => done({ ...result });
			});
		},
	};
	return { client, attempts, control };
}

// Test 16: an accepted press shows the pending form with no button, and a second press sends nothing.
test("16. an accepted press shows a pending form with no button, and a second press cannot send", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t16-");
	const fakeHc = makeHeldHc({ ok: true, code: 0, detail: "" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const client = await connectWs(t, producer.port);
	const sid = surfaceIdFor("t16p");

	await producer.addReport({ address: "t16p", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t16p", "o1");
	const pressText = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t16p" });
	const press = producer.handleRawAction(pressText);
	await waitUntil(() => fakeHc.attempts.length === 1, "send held");
	await waitUntil(() => drawnComponents(client.messages, sid)?.some((c) => c.id === "pending_text") ?? false, "pending form");
	const drawn = drawnComponents(client.messages, sid) ?? [];
	// ChoicePicker is the answer picker of the old layout; the two-column surface has none.
	assert.equal(drawn.some((c) => c.component === "Button" || c.component === "ChoicePicker"), false);
	assert.equal(renderedButtonSpecs(producer.getState().coordinators[0]).size, 0);

	// A second press of the stale Send button waits behind the held send and is refused after it.
	const second = producer.handleRawAction(pressText);
	fakeHc.control.release();
	assert.equal((await press).handled, true);
	assert.equal((await second).handled, false);
	assert.equal(fakeHc.attempts.length, 1);
});

// Test 17: a failed send brings the cards back in place of the pending form, with the picks of the owner.
test("17. a failed send brings the cards back with the picks", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t17-");
	const fakeHc = makeHeldHc({ ok: false, code: 1, detail: "refused" });
	fakeHc.control.hold = false;
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const client = await connectWs(t, producer.port);
	const sid = surfaceIdFor("t17r");

	await producer.addReport({ address: "t17r", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, "t17r", "o1");
	const result = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t17r" }),
	);
	assert.equal(result.handled, false);
	const group = producer.getState().coordinators[0];
	assert.equal(group.receiptPending, false);
	assert.equal(rowByLabel(producer.getState(), "B").selectedOptionId, "o1");
	await waitUntil(() => drawnComponents(client.messages, sid)?.some((c) => c.id === "btn_send") ?? false, "cards back");
	const drawn = drawnComponents(client.messages, sid) ?? [];
	assert.equal(drawn.some((c) => c.id === "pending_text"), false);
	assert.equal(drawn.some((c) => c.id === "row_B"), true);
});

// Test 18: the pending form ends at the turn-start after a good send; a turn-start during the send holds it to the result.
test("18. the pending form is deleted at the turn-start event after a good send", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t18-");
	const fakeHc = makeHeldHc({ ok: true, code: 0, detail: "" });
	fakeHc.control.hold = false;
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const client = await connectWs(t, producer.port);
	const sid = surfaceIdFor("t18s");
	const hasForm = () => drawnComponents(client.messages, sid)?.some((c) => c.id === "pending_text") ?? false;

	await producer.addReport({ address: "t18s", reportText: ONE_ROW_REPORT, skipRoleCheck: true });
	await choose(producer, "t18s", "o1");
	const sent = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t18s" }),
	);
	assert.equal(sent.handled, true);
	assert.equal(producer.getState().coordinators.length, 0);
	await waitUntil(hasForm, "pending form after the good send");
	producer.handleTurnStart("t18s");
	await waitUntil(() => drawnComponents(client.messages, sid) === null, "form deleted at turn-start");

	// A turn-start during the send locks the cards, and the form stays until the good send result.
	fakeHc.control.hold = true;
	await producer.addReport({ address: "t18s", reportText: ONE_ROW_REPORT, skipRoleCheck: true });
	await choose(producer, "t18s", "o1");
	const press = producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t18s" }),
	);
	await waitUntil(() => fakeHc.attempts.length === 2, "second send held");
	producer.handleTurnStart("t18s");
	assert.equal(producer.getState().coordinators[0].locked, true);
	assert.equal(hasForm(), true);
	fakeHc.control.release();
	assert.equal((await press).handled, true);
	await waitUntil(() => drawnComponents(client.messages, sid) === null, "form deleted at the send result");
});

test("19. the old order (Agent rows first) is accepted and gives the same owner rows as the new order", () => {
	const head = "The notes are ready, and the check passes (12 pass, 0 fail).\n\n## Next\n\n";
	const decide = "Owner decides: Keep the notes, or remove them.";
	const run = "Owner: Run the privileged check.";
	const read = "Agent: Read the log.";
	const ownerFirst = extractOwnerRows(`${head}- **[A]** ${decide}\n- **[B]** ${run}\n- **[C]** ${read}`);
	const agentFirst = extractOwnerRows(`${head}- **[A]** ${read}\n- **[B]** ${decide}\n- **[C]** ${run}`);
	assert.equal(ownerFirst.eligible, true);
	assert.equal(agentFirst.eligible, true);
	assert.deepEqual(ownerFirst.rows.map((row) => row.label), ["A", "B"]);
	assert.deepEqual(agentFirst.rows.map((row) => row.label), ["B", "C"]);
	const unlabeled = (rows: typeof ownerFirst.rows) => rows.map(({ label: _label, ...row }) => row);
	assert.deepEqual(unlabeled(agentFirst.rows), unlabeled(ownerFirst.rows));
});

/** A `hc schema` answer whose `terminal.send` has (or lacks) the parameter `no_draft_wait`. */
function hcSchema(withNoDraftWait: boolean): unknown {
	const params = [{ name: "caller" }, { name: "force" }, ...(withNoDraftWait ? [{ name: "no_draft_wait" }] : [])];
	return { methods: [{ name: "terminal.get", params: [{ name: "no_draft_wait" }] }, { name: "terminal.send", params }] };
}

/** Make one producer with a fake `hc`, press Send for one coordinator, and give the press result and the send calls. */
async function pressWithFakeHc(
	t: test.TestContext,
	name: string,
	opts: { schema?: unknown; refuseNoDraftWait?: boolean; turnStartBeforeFallback?: boolean },
): Promise<{ handled: boolean; sends: string[][]; line: string }> {
	const dir = makeTempDir(t, `owner-popup-${name}-`);
	const address = "t20n";
	const eventsDir = join(dir, "events");
	// The refused flagged child writes a turn-start event of the address before it exits, as a typed line would.
	const turnStartBeforeRefusal = opts.turnStartBeforeFallback ? { path: join(eventsDir, `turn-start-${address}.json`), address } : undefined;
	const fakeHc = makeFakeHc(dir, { address, state: "live", status: { state: "idle" }, labels: { "skill.role": "coordinator" } }, { ...opts, turnStartBeforeRefusal });
	const hc = createHcClient(fakeHc.binPath);
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), eventsDir, hc, decider: false, writer: false });
	t.after(() => producer.close());
	await producer.addReport({ address, reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	await choose(producer, address, "o1");
	// The press reads the kept answer with no wait: let the background `hc schema` check end first.
	await hc.refreshNoDraftWait?.();
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: address }),
	);
	const sends = fakeHc.readCalls().filter((c) => c.args[0] === "send").map((c) => c.args);
	return { handled: res.handled, sends, line: sends[0]?.[2] ?? "" };
}

// Test 20: a press skips the draft hold only on a core whose schema has the option; else the arguments stay plain.
test("20. a press adds --no-draft-wait only when hc schema has no_draft_wait on terminal.send", async (t) => {
	const withOption = await pressWithFakeHc(t, "t20a", { schema: hcSchema(true) });
	assert.equal(withOption.sends.length, 1);
	assert.equal(withOption.sends[0].includes("--no-draft-wait"), true);

	const withoutOption = await pressWithFakeHc(t, "t20b", { schema: hcSchema(false) });
	assert.equal(withoutOption.sends.length, 1);
	assert.equal(withoutOption.sends[0].includes("--no-draft-wait"), false);
});

// Test 21: an old client refuses the flag with a usage error and sends nothing; the press sends one plain line.
test("21. a usage refusal of --no-draft-wait leads to one plain send, and the press succeeds", async (t) => {
	const press = await pressWithFakeHc(t, "t21", { schema: hcSchema(true), refuseNoDraftWait: true });
	assert.equal(press.handled, true);
	assert.equal(press.sends.length, 2);
	assert.equal(press.sends[0].includes("--no-draft-wait"), true);
	assert.equal(press.sends[1].includes("--no-draft-wait"), false);

	// A turn-start during the refused flagged child: the plain send does not start.
	const locked = await pressWithFakeHc(t, "t21b", { schema: hcSchema(true), refuseNoDraftWait: true, turnStartBeforeFallback: true });
	assert.equal(locked.handled, false);
	assert.equal(locked.sends.length, 1);
	assert.equal(locked.sends[0].includes("--no-draft-wait"), true);
});

// Test 22: Send sends only the checked rows; the row that was not checked stays, and the locked surface cannot send.
test("22. Send with two of three rows checked delivers those two, and the third row stays on a locked surface", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t22-");
	const fakeHc = makeMemoryHc({ address: "t22s", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t22s", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(producer, "t22s", "o1", "A");
	await choose(producer, "t22s", "o2", "B");
	const sendText = buildButtonAction(producer.getState(), "send", { targetCoordinator: "t22s" });
	assert.equal((await producer.handleRawAction(sendText)).handled, true);
	assert.deepEqual(sentLabels(fakeHc.sends[0].text), ["A", "B"]);

	const group = producer.getState().coordinators[0];
	assert.deepEqual(group.rows.map((r) => r.row.label), ["C"]);
	assert.equal(renderedButtonSpecs(group).has("btn_send"), false);
	assert.equal((await producer.handleRawAction(sendText)).handled, false);
	assert.equal(fakeHc.sends.length, 1);
});

/** The row labels drawn in `left` (open) and in `right` (answered) of one coordinator surface. */
function drawnColumns(group: CoordinatorGroup): { left: string[]; right: string[] } {
	const byId = new Map(buildSurfaceSpec(group).components.map((c) => [c.id, c]));
	const children = (id: string) => (byId.get(id)?.children as string[] | undefined) ?? [];
	return {
		left: children("left").filter((id) => id.startsWith("open_text_")).map((id) => id.slice("open_text_".length)),
		right: children("right").map((id) => id.slice("row_".length)),
	};
}

/** What the surface shows of one row: a check mark on any of its components, a place in `right`, and the header count. */
function pendingRowView(group: CoordinatorGroup, label: string): { checkMark: boolean; inRight: boolean; count: number } {
	const { components } = buildSurfaceSpec(group);
	const ofRow = new RegExp(`_${label}(_|$)`);
	const checkMark = components.some((c) => ofRow.test(c.id) && (
		String(c.text ?? "").includes("✓") ||
		(c["@metadata"] as { extensions?: Record<string, unknown> } | undefined)?.extensions?.owner_rail_checked === true
	));
	const count = Number(/^(\d+) of/.exec(String(components.find((c) => c.id === "hdr_count")?.text))?.[1]);
	return { checkMark, inRight: drawnColumns(group).right.includes(label), count };
}

// Test 23: a press answers its own stacked row; a cleared check box brings it back open; Use text answers its own row.
test("23. a press answers its target row, a cleared box reopens it, Use text answers its row, and drafts of other rows stay", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t23-");
	const fakeHc = makeMemoryHc({ address: "t23t", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const group = () => producer.getState().coordinators[0];

	await producer.addReport({ address: "t23t", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	assert.deepEqual(drawnColumns(group()), { left: ["A", "B", "C"], right: [] });

	// A press of an answer of row B, with a draft typed in row A: B is answered and moves to `right`; A keeps its draft.
	const draftA = "DRAFT_OF_A_3310";
	assert.equal((await press(producer, "choose", { targetCoordinator: "t23t", targetLabel: "B", optionId: "o2", drafts: { A: draftA } })).handled, true);
	const rowB = rowByLabel(producer.getState(), "B");
	assert.equal(effectiveAnswer(rowB)?.text, rowB.row.options.find((o) => o.id === "o2")?.text);
	assert.equal(effectiveAnswer(rowByLabel(producer.getState(), "A")), null);
	assert.equal(effectiveAnswer(rowByLabel(producer.getState(), "C")), null);
	assert.deepEqual(drawnColumns(group()), { left: ["A", "C"], right: ["B"] });
	const draftOfA = () => (buildSurfaceSpec(group()).dataModel.rows as Record<string, { other: string }>).A.other;
	assert.equal(draftOfA(), draftA);

	// Use text with a text answers its own row C; the draft of row A survives this press too.
	const typedC = "TYPED_ANSWER_OF_C_7720";
	assert.equal((await press(producer, "other", { targetCoordinator: "t23t", targetLabel: "C", other: typedC })).handled, true);
	assert.deepEqual(effectiveAnswer(rowByLabel(producer.getState(), "C")), { text: typedC, picked: "custom" });
	assert.equal(effectiveAnswer(rowByLabel(producer.getState(), "A")), null);
	assert.deepEqual(drawnColumns(group()), { left: ["A"], right: ["B", "C"] });
	assert.equal(draftOfA(), draftA);

	// Use text with an empty field changes no answer.
	assert.equal((await press(producer, "other", { targetCoordinator: "t23t", targetLabel: "A", other: " " })).handled, false);
	assert.equal(effectiveAnswer(rowByLabel(producer.getState(), "A")), null);
	assert.equal(buildSurfaceSpec(group()).components.some((c) => c.id === "status_line"), true);

	// A cleared check box brings row B back to `left` at its place, with no answer and no text.
	assert.equal((await press(producer, "toggle", { targetCoordinator: "t23t", targetLabel: "B" })).handled, true);
	const cleared = rowByLabel(producer.getState(), "B");
	assert.deepEqual({ answer: effectiveAnswer(cleared), checked: cleared.checked, draft: cleared.draft }, { answer: null, checked: false, draft: "" });
	assert.deepEqual(drawnColumns(group()), { left: ["A", "B"], right: ["C"] });

	assert.equal((await press(producer, "send", { targetCoordinator: "t23t" })).handled, true);
	assert.deepEqual(sentLabels(fakeHc.sends[0].text), ["C"]);
	assert.equal(fakeHc.sends[0].text.includes(typedC), true);
});

// Test 24: a turn-start locks the surface; the next report gives the state of a kept row to the new row of the same text.
test("24. after a locked surface, a new row with the text of a kept row takes over its pick, and a risky row needs a new confirm", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t24-");
	const fakeHc = makeMemoryHc({ address: "t24k", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const riskyText = "Truncate the audit table, or archive it first.";
	const otherText = "Name the tool Alpha, or name it Beta.";
	const report = (rows: string[]) =>
		["Work waits.", "", "## Next", "", ...rows.map((text, i) => `- **[${"ABC"[i]}]** Owner decides: ${text}`)].join("\n");

	await producer.addReport({ address: "t24k", reportText: report([riskyText, "Keep the percent, or show a bar."]), skipRoleCheck: true });
	await choose(producer, "t24k", "o1");
	assert.equal((await press(producer, "confirm", { targetCoordinator: "t24k", targetLabel: "A" })).handled, true);
	const answer = effectiveAnswer(rowByLabel(producer.getState(), "A"));
	producer.handleTurnStart("t24k");
	assert.equal(renderedButtonSpecs(producer.getState().coordinators[0]).has("btn_send"), false);

	// The same text comes back under another label; the other new row is new.
	await producer.addReport({ address: "t24k", reportText: report([otherText, riskyText]), skipRoleCheck: true });
	assert.deepEqual(effectiveAnswer(rowByLabel(producer.getState(), "B")), answer);
	assert.equal(effectiveAnswer(rowByLabel(producer.getState(), "A")), null);
	// The inherited risky answer is not sent before a fresh Confirm.
	await press(producer, "send", { targetCoordinator: "t24k" });
	assert.equal(fakeHc.sends.length, 0);

	// Two kept rows with the same text: the new row of that text takes nothing over.
	await producer.addReport({ address: "t24k", reportText: report([otherText, otherText]), skipRoleCheck: true });
	await choose(producer, "t24k", "o1");
	await producer.addReport({ address: "t24k", reportText: report([otherText]), skipRoleCheck: true });
	const ambiguous = rowByLabel(producer.getState(), "A");
	assert.deepEqual({ answer: effectiveAnswer(ambiguous), checked: ambiguous.checked }, { answer: null, checked: false });

	// An unknown send of row A, then a turn-start: the line can have reached the coordinator, so the next report with
	// the same row text gives row A nothing.
	const unknownHc = makeUnknownFirstHc({ address: "t24u", state: "live", agentStatus: "idle", role: "coordinator" });
	const unknownProducer = await createProducer({ port: 0, stateDir: join(dir, "state-unknown"), hc: unknownHc.client, decider: false, writer: false });
	t.after(() => unknownProducer.close());
	await unknownProducer.addReport({ address: "t24u", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(unknownProducer, "t24u", "o1");
	assert.equal((await press(unknownProducer, "send", { targetCoordinator: "t24u" })).handled, false);
	unknownProducer.handleTurnStart("t24u");
	await unknownProducer.addReport({ address: "t24u", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	const notCopied = rowByLabel(unknownProducer.getState(), "A");
	assert.deepEqual({ answer: effectiveAnswer(notCopied), checked: notCopied.checked }, { answer: null, checked: false });

	// A row that the decider, not the words, marked risky: its unsent answer is taken over by the next report while
	// the new score is held, and a Send sends nothing of it before a fresh Confirm.
	let holdScore = false;
	let releaseScore = () => {};
	const scoreHeld = new Promise<void>((done) => {
		releaseScore = done;
	});
	t.after(() => releaseScore());
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		if (new URL(String(url)).pathname === "/health") return Response.json({ ok: true });
		if (holdScore) await scoreHeld;
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Response.json(buildDeciderScorePayload(body, (keys) => Object.fromEntries(keys.map((k) => [k, 0.25])), () => 0.9));
	}) as typeof fetch;
	const modelHc = makeMemoryHc({ address: "t24m", state: "live", agentStatus: "idle", role: "coordinator" });
	const modelProducer = await createProducer({ port: 0, stateDir: join(dir, "state-model"), hc: modelHc.client, decider: { fetchImpl, rowTimeoutMs: 5000, phaseTimeoutMs: 5000 }, writer: false });
	t.after(() => modelProducer.close());
	const modelReport = report(["Apply the billing change now, or wait until Monday."]);
	await modelProducer.addReport({ address: "t24m", reportText: modelReport, skipRoleCheck: true });
	await modelProducer.waitForPendingWork();
	assert.equal(rowByLabel(modelProducer.getState(), "A").row.riskByWords, false);
	await choose(modelProducer, "t24m", "o1", "A");
	const modelAnswer = effectiveAnswer(rowByLabel(modelProducer.getState(), "A"));
	holdScore = true;
	await modelProducer.addReport({ address: "t24m", reportText: modelReport, skipRoleCheck: true });
	assert.deepEqual(effectiveAnswer(rowByLabel(modelProducer.getState(), "A")), modelAnswer);
	await press(modelProducer, "send", { targetCoordinator: "t24m" });
	assert.equal(modelHc.sends.length, 0);
	// One release: the Confirm of the current surface makes the row sendable, and Send sends its answer.
	assert.equal((await press(modelProducer, "confirm", { targetCoordinator: "t24m", targetLabel: "A" })).handled, true);
	await press(modelProducer, "send", { targetCoordinator: "t24m" });
	assert.equal(modelHc.sends.length, 1);
	assert.equal(modelHc.sends[0].text.includes(String(modelAnswer?.text)), true);
	releaseScore();
});

// Test 25: a checked row that the decider marks risky during the lookup of a press is not sent and stays unconfirmed.
test("25. a row that becomes risky during the lookup of a press is not in the line and stays on the surface", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t25-");
	let releaseScore = () => {};
	let releaseLookup = () => {};
	const scoreHeld = new Promise<void>((done) => {
		releaseScore = done;
	});
	const lookupHeld = new Promise<void>((done) => {
		releaseLookup = done;
	});
	let lookups = 0;
	const sends: string[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		if (new URL(String(url)).pathname === "/health") return Response.json({ ok: true });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const prompt = String((body.state as { prompt?: string }).prompt);
		const lateRisk = prompt.includes("Keep the percent");
		if (lateRisk) await scoreHeld;
		return Response.json(buildDeciderScorePayload(body, (keys) => Object.fromEntries(keys.map((k) => [k, 0.25])), () => (lateRisk ? 0.9 : 0)));
	}) as typeof fetch;
	const producer = await createProducer({
		port: 0,
		stateDir: join(dir, "state"),
		decider: { fetchImpl, rowTimeoutMs: 5000, phaseTimeoutMs: 5000 },
		writer: false,
		hc: {
			async get(address) {
				lookups += 1;
				await lookupHeld;
				return { address, state: "live", agentStatus: "idle", role: "coordinator" };
			},
			async send(_address, text) {
				sends.push(text);
				return { ok: true, code: 0, detail: "" };
			},
		},
	});
	t.after(() => producer.close());

	await producer.addReport({ address: "t25r", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(producer, "t25r", "o1", "A");
	await choose(producer, "t25r", "o1", "B");
	const sending = press(producer, "send", { targetCoordinator: "t25r" });
	await waitUntil(() => lookups === 1, "lookup of the press");
	releaseScore();
	await waitUntil(() => rowByLabel(producer.getState(), "A").row.risky, "late risk of row A");
	releaseLookup();
	assert.equal((await sending).handled, true);

	assert.deepEqual(sends.map(sentLabels), [["B"]]);
	// The late risk mark brings the answered row A back to `left`, with its Confirm row.
	assert.equal(drawnColumns(producer.getState().coordinators[0]).left.includes("A"), true);
	assert.equal(buildSurfaceSpec(producer.getState().coordinators[0]).components.some((c) => c.id === "confirm_row_A"), true);

	// The same late risk while the refused flagged child runs: the check before the plain send stops it.
	let releasePlainScore = () => {};
	const plainScoreHeld = new Promise<void>((done) => {
		releasePlainScore = done;
	});
	const plainFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		if (new URL(String(url)).pathname === "/health") return Response.json({ ok: true });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const lateRisk = String((body.state as { prompt?: string }).prompt).includes("Keep the percent");
		if (lateRisk) await plainScoreHeld;
		return Response.json(buildDeciderScorePayload(body, (keys) => Object.fromEntries(keys.map((k) => [k, 0.25])), () => (lateRisk ? 0.9 : 0)));
	}) as typeof fetch;
	const releaseFile = join(dir, "release-refusal");
	const fakeHc = makeFakeHc(
		dir,
		{ address: "t25p", state: "live", status: { state: "idle" }, labels: { "skill.role": "coordinator" } },
		{ schema: hcSchema(true), refuseNoDraftWait: true, holdRefusalUntil: releaseFile },
	);
	const hc = createHcClient(fakeHc.binPath);
	const plainProducer = await createProducer({
		port: 0,
		stateDir: join(dir, "state-plain"),
		decider: { fetchImpl: plainFetch, rowTimeoutMs: 5000, phaseTimeoutMs: 5000 },
		writer: false,
		hc,
	});
	t.after(() => plainProducer.close());
	await plainProducer.addReport({ address: "t25p", reportText: THREE_ROWS_REPORT, skipRoleCheck: true });
	await choose(plainProducer, "t25p", "o1");
	await hc.refreshNoDraftWait?.();
	const sendCalls = () => fakeHc.readCalls().filter((c) => c.args[0] === "send").map((c) => c.args);
	const plainPress = press(plainProducer, "send", { targetCoordinator: "t25p" });
	await waitUntil(() => sendCalls().length === 1, "flagged send of the press");
	releasePlainScore();
	await waitUntil(() => rowByLabel(plainProducer.getState(), "A").row.risky, "late risk of row A during the flagged send");
	writeFileSync(releaseFile, "");
	assert.equal((await plainPress).handled, false);
	const calls = sendCalls();
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1], "t25p");
	assert.equal(calls[0].includes("--no-draft-wait"), true);
	assert.equal(effectiveAnswer(rowByLabel(plainProducer.getState(), "A")) !== null, true);
	assert.equal(drawnColumns(plainProducer.getState().coordinators[0]).left.includes("A"), true);
	assert.equal(renderedButtonSpecs(plainProducer.getState().coordinators[0]).has("btn_send"), true);
});

// Test 26: the mod draws two columns only for this shape: `body` last in `root`, with exactly the Columns `left` and `right`.
test("26. the fresh, mixed, all-answered, locked and pending forms keep the two-column shape with unique ids", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t26-");
	const fakeHc = makeHeldHc({ ok: true, code: 0, detail: "" });
	const producer = await createProducer({ port: 0, stateDir: join(dir, "state"), hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());
	const group = () => producer.getState().coordinators[0];
	const assertShape = (form: string) => {
		const { components } = buildSurfaceSpec(group());
		const ids = components.map((c) => c.id);
		assert.equal(new Set(ids).size, ids.length, `${form}: ids are unique`);
		const byId = new Map(components.map((c) => [c.id, c]));
		const root = byId.get("root");
		assert.equal((root?.["@metadata"] as { extensions?: Record<string, unknown> } | undefined)?.extensions?.owner_rail_layout, "two-column", form);
		assert.equal((root?.children as string[]).at(-1), "body", form);
		assert.deepEqual(byId.get("body")?.children, ["left", "right"], form);
		assert.equal(byId.get("left")?.component, "Column", form);
		assert.equal(byId.get("right")?.component, "Column", form);
	};

	await producer.addReport({ address: "t26f", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	assertShape("fresh");
	await choose(producer, "t26f", "o1", "B");
	await choose(producer, "t26f", "o1", "C");
	assertShape("mixed");
	const checked = checkA2uiMessages(toCreateSurfaceMessages(group()));
	assert.equal(checked.ok, true, checked.ok ? "" : checked.error);
	await press(producer, "confirm", { targetCoordinator: "t26f", targetLabel: "C" });
	for (const label of ["D", "E"]) await choose(producer, "t26f", "o1", label);
	const all = new Map(buildSurfaceSpec(group()).components.map((c) => [c.id, c]));
	const leftKids = (all.get("left")?.children as string[] | undefined) ?? [];
	assert.equal(leftKids.length, 1);
	assert.equal(all.get(leftKids[0])?.component, "Text");
	assertShape("all answered");
	const sending = press(producer, "send", { targetCoordinator: "t26f" });
	await waitUntil(() => fakeHc.attempts.length === 1, "send held");
	assertShape("pending");
	fakeHc.control.release();
	assert.equal((await sending).handled, true);
	await producer.addReport({ address: "t26f", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	producer.handleTurnStart("t26f");
	assert.equal(group().locked, true);
	assertShape("locked");
});
