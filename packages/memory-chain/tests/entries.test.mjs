// Behavior 1: shadow on and shadow off deliver the same prompt, in the Pi entry and the Claude Code hook.
// Also: `off` works with a broken vendored helper, and sessions that are not primary prompts get no run.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerMemoryChain } from "../runtime.mjs";
import { runShadow } from "../src/shadow.mjs";
import { fakeOpenViking, sandbox, waitFor } from "./helpers.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const SHARED = fileURLToPath(new URL("../../openviking-pi/shared", import.meta.url));
const HOOK = join(PACKAGE, "scripts", "shadow-hook.mjs");
const PROMPT = "how does the alpha build work";

function recordLines(state) {
	if (!existsSync(state)) return 0;
	return readdirSync(state).reduce((sum, name) => sum + readFileSync(join(state, name), "utf8").trim().split("\n").length, 0);
}

async function box(t, mode) {
	const server = await fakeOpenViking(t, () => ({ status: 200, json: { status: "ok", result: { entries: [] } } }));
	return { ...sandbox(t, { base: server.base, mode }), server };
}

/** Run the hook script with `input` on standard input. */
function runHook(script, env, input) {
	return new Promise((resolve, reject) => {
		// An async child: the fake server runs in this process and must answer while the hook runs.
		const proc = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => { stdout += chunk; });
		proc.stderr.on("data", (chunk) => { stderr += chunk; });
		proc.on("error", reject);
		proc.on("close", (status) => resolve({ status, stdout, stderr }));
		proc.stdin.end(input);
	});
}

for (const mode of ["shadow", "off"]) {
	test(`Pi entry, mode ${mode}: the prompt and the system prompt stay as they are`, async (t) => {
		const { env, project, state, server } = await box(t, mode);
		const handlers = {};
		registerMemoryChain({ on: (name, handler) => { handlers[name] = handler; } }, { env, cwd: () => project });
		assert.equal(typeof handlers.before_agent_start, "function");
		const event = { messageType: "user", prompt: PROMPT, systemPrompt: "SYSTEM", images: [] };
		const before = structuredClone(event);
		assert.equal(handlers.before_agent_start(event, {}), undefined);
		assert.deepEqual(event, before);
		if (mode === "shadow") {
			assert.ok(await waitFor(() => recordLines(state) === 1), "one run for the prompt");
			assert.equal(server.requests.length, 1);
		} else {
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(existsSync(state), false);
			assert.equal(server.requests.length, 0);
		}
	});

	test(`Claude Code hook, mode ${mode}: no output for the model and exit 0`, async (t) => {
		const { env, project, state, server } = await box(t, mode);
		const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: PROMPT, cwd: project, session_id: "s1" });
		const child = await runHook(HOOK, env, input);
		assert.equal(child.status, 0);
		assert.equal(child.stdout, "");
		if (mode === "shadow") {
			// The detached child of the hook writes the record after the hook exits.
			assert.ok(await waitFor(() => recordLines(state) === 1), "one run for the prompt");
			assert.equal(server.requests.length, 1);
		} else {
			assert.equal(existsSync(state), false);
			assert.equal(server.requests.length, 0);
		}
	});
}

test("off: a missing vendored helper leaves the hook silent and the Pi extension loaded", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "memory-chain-copy-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const copy = join(root, "packages", "memory-chain");
	cpSync(PACKAGE, copy, { recursive: true, filter: (path) => !path.includes("node_modules") });
	cpSync(SHARED, join(root, "packages", "openviking-pi", "shared"), { recursive: true });
	rmSync(join(root, "packages", "openviking-pi", "shared", "workspace-peer.mjs"));
	const { env, project } = sandbox(t, { mode: "off" });
	const child = await runHook(join(copy, "scripts", "shadow-hook.mjs"), env, JSON.stringify({ prompt: PROMPT, cwd: project }));
	assert.equal(child.status, 0);
	assert.equal(child.stdout, "");
	assert.equal(child.stderr, "");
	const runtime = await import(pathToFileURL(join(copy, "runtime.mjs")).href);
	const handlers = {};
	runtime.registerMemoryChain({ on: (name, handler) => { handlers[name] = handler; } }, { env, cwd: () => project });
	assert.equal(handlers.before_agent_start({ messageType: "user", prompt: PROMPT }, {}), undefined);
});

test("a task session, a bypassed session and a Pi message that is not from the user get no run", async (t) => {
	const cases = [
		{ name: "task session marker", env: { OPENVIKING_RECALL_COMPRESS: "off" } },
		{ name: "bypassSession", env: { OPENVIKING_BYPASS_SESSION: "true" } },
		{ name: "Pi message not from the user", pi: { messageType: "custom", prompt: PROMPT } },
	];
	for (const item of cases) {
		const { env, project, state, server } = await box(t, "shadow");
		if (item.pi) {
			let runs = 0;
			const handlers = {};
			registerMemoryChain({ on: (name, handler) => { handlers[name] = handler; } },
				{ env, cwd: () => project, run: (input) => { runs += 1; return runShadow(input); } });
			handlers.before_agent_start(item.pi, {});
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(runs, 0, item.name);
		} else {
			const { ran } = await runShadow({ harness: "pi", prompt: PROMPT, cwd: project, env: { ...env, ...item.env } });
			assert.equal(ran, false, item.name);
		}
		assert.equal(server.requests.length, 0, item.name);
		assert.equal(recordLines(state), 0, item.name);
	}
});

test("shadow: a hook input over 256 KiB starts no run and writes one line with a reason and no input", async (t) => {
	const { env, project, state, server } = await box(t, "shadow");
	const input = JSON.stringify({ prompt: `CAPMARK ${"x".repeat(300 * 1024)}`, cwd: project, session_id: "s1" });
	const child = await runHook(HOOK, env, input);
	assert.equal(child.status, 0);
	assert.equal(child.stdout, "");
	assert.ok(await waitFor(() => recordLines(state) === 1), "one record line");
	assert.equal(server.requests.length, 0);
	const raw = readdirSync(state).map((name) => readFileSync(join(state, name), "utf8")).join("");
	assert.ok(!raw.includes("CAPMARK"));
	const line = JSON.parse(raw.trim());
	assert.equal(typeof line.reason, "string");
	assert.ok(line.reason);
});
