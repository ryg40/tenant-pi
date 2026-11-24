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
import { renderedButtonSpecs, surfaceIdFor, type A2uiComponent, type RowViewState, type SurfaceState } from "../owner-popup/a2ui.ts";
import { createHcClient, createProducer, roleOfTerminal, type HcClient, type TerminalRecord } from "../owner-popup/producer.ts";
import { extractExcerpt, isRiskyByWords } from "../owner-popup/rows.ts";

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

function buildButtonAction(
	state: SurfaceState,
	name: "focus" | "confirm" | "send" | "close",
	opts: { targetCoordinator?: string; targetLabel?: string; pick?: string[]; other?: string; surfaceId?: string } = {},
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
		return true;
	});
	assert.ok(button, `rendered button for ${name} not found`);
	const context: Record<string, unknown> = { ...button.literals };
	if (opts.pick !== undefined && button.bindsPick) context.focusedPick = opts.pick;
	if (opts.other !== undefined && button.bindsOther) context.focusedOther = opts.other;
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
function makeFakeHc(dir: string, initialRecord: Record<string, unknown> | null): FakeHcControl {
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
			'import { appendFileSync, readFileSync } from "node:fs";',
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

	// Focus risky row [C] while picking [B], then confirm [C] with a picked answer and press send:
	// delivers once with no `--if`, never `--force`, includes both [B] and risky [C], and verifies one receipt;
	// replay of the old button sends nothing.
	const chosenText = rowByLabel(producer.getState(), "B", "t11y").row.options[0].text;
	const riskyText = rowByLabel(producer.getState(), "C", "t11y").row.options[0].text;
	await producer.handleRawAction(
		buildButtonAction(producer.getState(), "focus", {
			targetCoordinator: "t11y",
			targetLabel: "C",
			pick: ["o1"],
			other: "",
		}),
	);
	await producer.handleRawAction(
		buildButtonAction(producer.getState(), "confirm", {
			targetCoordinator: "t11y",
			targetLabel: "C",
			pick: ["o1"],
			other: "",
		}),
	);
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, 0);
	const sendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t11y",
		pick: ["o1"],
		other: "",
	});
	await producer.handleRawAction(sendPayload);
	await waitUntil(
		() => client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === surfaceIdFor("t11y")),
		"surface deleted after send",
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
	const doneSendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t12d",
		pick: [],
		other: "Keep percent\n; [C] Forged: Yes",
	});
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
	const pendingSendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t13s",
		pick: ["o1"],
		other: "",
	});
	const turnTimeMs = performance.timeOrigin + performance.now();
	writeFileSync(
		join(eventsDir, "turn-start-t13s.json"),
		JSON.stringify({ type: "turn_start", address: "t13s", timeMs: turnTimeMs, at: new Date(turnTimeMs).toISOString() }),
		{ mode: 0o600 },
	);
	const blockedRes = await producer.handleRawAction(pendingSendPayload);
	assert.equal(blockedRes.handled, false);
	assert.equal(producer.getState().coordinators.length, 0);
	await waitUntil(
		() => client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === surfaceIdFor("t13s")),
		"surface deleted after turn-start",
	);
	assert.equal(fakeHc.readCalls().filter((c) => c.args[0] === "send").length, 2);

	// After a valid send for an address, a newer report for the same address arrives before verify -> verify fails;
	// an unrelated file (`notes.json`) in the events folder stays untouched after polling.
	await producer.addReport({ address: "t13s", reportText: MOCKUP_FIXTURE });
	const supersededSendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t13s",
		pick: ["o1"],
		other: "",
	});
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
	const oldCardSendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t13s",
		pick: ["o1"],
		other: "",
	});
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
	const sendPayload = buildButtonAction(producer.getState(), "send", {
		targetCoordinator: "t11y",
		pick: [],
		other: ANSWER_MARKER,
	});
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

// Test 5: Every producer A2UI message for the fixtures passes checkA2uiMessages across focus and state transitions.
test("5. every producer A2UI message for the fixtures passes checkA2uiMessages across focus and state transitions", async (t) => {
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

	// Focus across cards, confirm risky [C], focus [D] and [E], then send t11y and close t12z.
	const steps: Array<{
		name: "focus" | "confirm" | "send" | "close";
		targetCoordinator?: string;
		targetLabel?: string;
		pick?: string[];
		other?: string;
	}> = [
		{ name: "focus", targetCoordinator: "t11y", targetLabel: "C", pick: ["o1"], other: "" },
		{ name: "confirm", targetCoordinator: "t11y", targetLabel: "C", pick: ["o1"], other: "" },
		{ name: "focus", targetCoordinator: "t11y", targetLabel: "D", pick: ["o1"], other: "" },
		{ name: "focus", targetCoordinator: "t11y", targetLabel: "E", pick: [], other: "Only the fixes" },
		{ name: "send", targetCoordinator: "t11y", pick: [], other: "" },
		{ name: "close", targetCoordinator: "t12z" },
	];
	for (const step of steps) {
		const res = await producer.handleRawAction(buildButtonAction(producer.getState(), step.name, step));
		assert.equal(res.handled, true, `action ${step.name} should succeed`);
	}
	await waitUntil(
		() =>
			client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === sidA) &&
			client.messages.some((m) => "deleteSurface" in m && surfaceIdOfMessage(m) === sidB),
		"both deleteSurface messages received",
	);

	// Explicitly require each necessary surface transition rather than pinning a frame count.
	assert.equal(client.messages.some((m) => "createSurface" in m), true);
	assert.equal(client.messages.some((m) => "updateComponents" in m), true);
	assert.equal(client.messages.some((m) => "updateDataModel" in m), true);
	assert.equal(client.messages.some((m) => "deleteSurface" in m), true);

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
	await producer.handleRawAction(
		buildButtonAction(producer.getState(), "focus", {
			targetCoordinator: "t11y",
			targetLabel: "B",
			pick: [],
			other: "My kept custom text",
		}),
	);
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
	const unconfirmedSend = await producerUp.handleRawAction(
		buildButtonAction(producerUp.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }),
	);
	assert.equal(unconfirmedSend.handled, false);
	assert.equal(printed.length, 0);

	// Capture a valid confirm action from revision 1, then replace the report with revision 2.
	const oldRevisionConfirm = buildButtonAction(producerUp.getState(), "confirm", {
		targetCoordinator: "t11y",
		targetLabel: "A",
		pick: ["o1"],
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

	// Confirm on the current revision, then send -> delivers exactly once.
	await producerUp.handleRawAction(
		buildButtonAction(producerUp.getState(), "confirm", {
			targetCoordinator: "t11y",
			targetLabel: "A",
			pick: ["o1"],
			other: "",
		}),
	);
	await producerUp.handleRawAction(
		buildButtonAction(producerUp.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }),
	);
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

	await producerDown.handleRawAction(
		buildButtonAction(producerDown.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }),
	);
	assert.equal(fakeHc.sends.length, 0);

	await producerDown.handleRawAction(
		buildButtonAction(producerDown.getState(), "confirm", {
			targetCoordinator: "t11y",
			targetLabel: "A",
			pick: ["o1"],
			other: "",
		}),
	);
	await producerDown.handleRawAction(
		buildButtonAction(producerDown.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }),
	);
	assert.equal(fakeHc.sends.length, 1);
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
		groups: st.coordinators.map((g) => ({ address: g.address, revision: g.revision, focusedLabel: g.focusedLabel })),
		answers: st.coordinators.flatMap((g) =>
			g.rows.map((r) => ({
				address: g.address,
				label: r.row.label,
				selectedOptionId: r.selectedOptionId,
				customText: r.customText,
				confirmed: r.confirmed,
			})),
		),
	});

	const stateNow = producer.getState();
	const sidA = surfaceIdFor("t11y");
	const rev = stateNow.coordinators[0].revision;
	const before = snapshotState(stateNow);
	// A rendered Close of B with only the surface ID changed to the surface of A.
	const mismatched = JSON.parse(buildButtonAction(stateNow, "close", { targetCoordinator: "t12z", surfaceId: sidA })).action;

	const badActions = [
		{ name: "send", surfaceId: "other-surface", sourceComponentId: "btn_send", context: { targetCoordinator: "t11y", targetRevision: rev } },
		{ name: "send", surfaceId: surfaceIdFor("t99z"), sourceComponentId: "btn_send", context: { focusedCoordinator: "t99z", focusedLabel: "B", focusedRevision: rev, focusedPick: ["o1"], focusedOther: "", targetCoordinator: "t99z", targetRevision: rev } },
		mismatched,
		{ name: "focus", surfaceId: sidA, sourceComponentId: "c_0_1_btn", context: { focusedCoordinator: "t11y", focusedLabel: "B", focusedRevision: rev, focusedPick: ["o1"], focusedOther: "should not apply", targetCoordinator: "t11y", targetLabel: "Z", targetRevision: rev } },
		{ name: "confirm", surfaceId: sidA, sourceComponentId: "focused_confirm_btn", context: { focusedCoordinator: "t11y", focusedLabel: "B", focusedRevision: rev, focusedPick: ["o1"], focusedOther: "should not apply", targetCoordinator: "t11y", targetLabel: "C", targetRevision: rev } },
		{ name: "send", surfaceId: sidA, sourceComponentId: "btn_send", context: { focusedCoordinator: "t11y", focusedLabel: "B", focusedRevision: rev, focusedPick: ["o1"], focusedOther: "should not apply", targetCoordinator: "t999", targetRevision: rev } },
		{ name: "send", surfaceId: sidA, sourceComponentId: "btn_send", context: { focusedCoordinator: "t11y", focusedLabel: "B", focusedRevision: rev, focusedPick: ["o99"], focusedOther: "", targetCoordinator: "t11y", targetRevision: rev } },
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
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t13v", pick: ["o1"], other: "" }),
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

	// A press of X waits in its first lookup; a Close of X arrives: nothing goes out.
	const first = holdNextGet();
	const press = producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }));
	await first.getHeld;
	const close = producer.handleRawAction(buildButtonAction(producer.getState(), "close", { targetCoordinator: "t11y" }));
	first.releaseGet();
	assert.equal((await press).handled, false);
	assert.equal((await close).handled, true);
	assert.equal(fakeHc.sends.length, 0);

	// A new report of X; a press of X waits in its first lookup; a Close of Y keeps the press of X, which goes out once.
	await producer.addReport({ address: "t11y", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	const second = holdNextGet();
	const pressAgain = producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t11y", pick: ["o1"], other: "" }));
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

	await producer.addReport({ address: "t14q", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q", pick: ["o1"], other: "" }),
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
	const res = await producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q", pick: ["o1"], other: "" }),
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
	const press = () =>
		producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q", pick: ["o1"], other: "" }));
	assert.equal((await press()).reason, "hc-send-unknown");
	// Nine minutes later: nine minutes plus the send limit is past the receipt lifetime of ten minutes.
	t.mock.timers.tick(9 * 60_000);
	assert.equal((await press()).handled, true);
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
	const press = producer.handleRawAction(
		buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q", pick: ["o1"], other: "" }),
	);
	await waitUntil(() => attempts.length === 1, "send held");
	await producer.addReport({ address: "t14q", reportText: COMPACT_FIXTURE, skipRoleCheck: true });
	assert.equal((await press).reason, "hc-send-aborted");
	release();

	assert.equal(delivered.length, 0);
	assert.notEqual(verifyLine(stateDir, "t14q", attempts[0]), "valid");
	assert.equal(producer.getState().coordinators.length, 1);
});

// Test 15: a retry goes to the saved line of the first try, and the pick log holds the first pick.
test("15. a retry after the owner changed the pick delivers the first line, and the pick log holds the first pick", async (t) => {
	const dir = makeTempDir(t, "owner-popup-t15-");
	const stateDir = join(dir, "state");
	const pickLogPath = join(stateDir, "picks.jsonl");
	const fakeHc = makeUnknownFirstHc({ address: "t14q", state: "live", agentStatus: "idle", role: "coordinator" });
	const producer = await createProducer({ port: 0, stateDir, pickLogPath, hc: fakeHc.client, decider: false, writer: false });
	t.after(() => producer.close());

	await producer.addReport({ address: "t14q", reportText: MOCKUP_FIXTURE, skipRoleCheck: true });
	const send = (pick: string[]) =>
		producer.handleRawAction(buildButtonAction(producer.getState(), "send", { targetCoordinator: "t14q", pick, other: "" }));
	assert.equal((await send(["o1"])).reason, "hc-send-unknown");
	// The owner selects the second choice and presses Send again.
	assert.equal((await send(["o2"])).handled, true);

	assert.deepEqual(fakeHc.delivered, [fakeHc.attempts[0]]);
	assert.equal(verifyLine(stateDir, "t14q", fakeHc.delivered[0]), "valid");
	const entries = readFileSync(pickLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(entries.length, 1);
	assert.deepEqual(
		entries[0].rows.map((r: { picked: unknown }) => r.picked).filter((picked: unknown) => picked !== "none"),
		[1],
	);
});
