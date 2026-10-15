import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseInput, skipPrompt } from "../src/hook.mjs";
import { BLOCK, fakeCoreModule } from "./fake-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const input = { prompt: "How does the example site build?", session_id: "s1", cwd: "/tmp/example-site" };
const env = {};

function run(module, extra = {}) {
	const logs = [];
	let loads = 0;
	const loadCore = async () => {
		loads += 1;
		return module;
	};
	return main(extra.input ?? input, { env: extra.env ?? env, loadCore, log: (line) => logs.push(line), deadlineMs: extra.deadlineMs })
		.then((output) => ({ output, logs, loads: () => loads }));
}

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "agentcore-claude-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a prompt gives one context block through the core", async () => {
	const module = fakeCoreModule();
	const { output, logs } = await run(module);
	assert.deepEqual(output, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: BLOCK } });
	assert.deepEqual(module.calls.map((call) => call.method),
		["loadConfig", "createCore", "resolveProject", "recall", "formatContext", "close"]);
	assert.equal(module.calls[2].cwd, "/tmp/example-site");
	assert.deepEqual(module.calls[3], { method: "recall", query: input.prompt, projectId: "example-project", signal: true });
	assert.equal(module.calls[1].hasLog, true);
	assert.deepEqual(logs, []);
});

test("no project gives a recall with a null project", async () => {
	const module = fakeCoreModule({ resolution: { projectId: null, role: null, source: "none" } });
	const { output } = await run(module);
	assert.equal(output.hookSpecificOutput.additionalContext, BLOCK);
	assert.equal(module.calls.find((call) => call.method === "recall").projectId, null);
});

test("the skip rules send no query and load no core", async () => {
	for (const prompt of ["", "   ", "/help", "  /memory list", "hi", " a ", undefined, 42]) {
		const module = fakeCoreModule();
		const result = await run(module, { input: { ...input, prompt } });
		assert.deepEqual(result.output, {}, `prompt ${JSON.stringify(prompt)}`);
		assert.equal(result.loads(), 0);
	}
	assert.equal(skipPrompt("abc"), false);
	assert.equal(skipPrompt("ab"), true);
});

test("the kill switch skips before the core loads", async () => {
	const module = fakeCoreModule();
	const result = await run(module, { env: { AGENTCORE_MEMORY_DISABLE: "1" } });
	assert.deepEqual(result.output, {});
	assert.equal(result.loads(), 0);
});

test("no config gives an empty answer", async () => {
	const module = fakeCoreModule({ config: null });
	const { output, logs } = await run(module);
	assert.deepEqual(output, {});
	assert.deepEqual(module.calls.map((call) => call.method), ["loadConfig"]);
	assert.deepEqual(logs, []);
});

test("no record gives an empty answer", async () => {
	const { output } = await run(fakeCoreModule({ block: null }));
	assert.deepEqual(output, {});
});

test("a throwing core gives an empty answer and one static line", async () => {
	const canary = "CANARY-hook-text";
	for (const throwAt of ["loadConfig", "createCore", "resolveProject", "recall", "formatContext"]) {
		const module = fakeCoreModule({ throwAt, error: new Error(`${canary} ${input.prompt}`) });
		const { output, logs } = await run(module);
		assert.deepEqual(output, {}, throwAt);
		assert.deepEqual(logs, ["skipped (failed)"], throwAt);
		if (!["loadConfig", "createCore"].includes(throwAt)) assert.equal(module.calls.at(-1).method, "close", throwAt);
	}
	const coded = await run(fakeCoreModule({ throwAt: "recall", error: Object.assign(new Error(canary), { code: "aws_denied" }) }));
	assert.deepEqual(coded.logs, ["skipped (aws_denied)"]);
	const failedLoad = await main(input, { env, loadCore: async () => { throw new Error(canary); }, log: () => {} });
	assert.deepEqual(failedLoad, {});
});

test("a recall past the deadline gives an empty answer", async () => {
	const module = fakeCoreModule({ hang: true });
	const started = Date.now();
	const { output, logs } = await run(module, { deadlineMs: 50 });
	assert.deepEqual(output, {});
	assert.deepEqual(logs, ["skipped (timeout)"]);
	assert.ok(Date.now() - started < 2000);
});

test("a broken input is an empty object", () => {
	assert.deepEqual(parseInput("not json"), {});
	assert.deepEqual(parseInput("[1]"), {});
	assert.deepEqual(parseInput('{"prompt":"abc"}'), { prompt: "abc" });
});

test("the hook process writes no file and no request data on standard error", (t) => {
	const dir = tempDir(t);
	const childEnv = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir };
	const prompt = "CANARY-prompt-text about the example site";
	for (const mode of ["ok", "throw"]) {
		const result = spawnSync(process.execPath, [join(root, "tests/fixtures/run-hook.mjs"), mode], {
			cwd: dir, env: childEnv, input: JSON.stringify({ prompt, session_id: "s1", cwd: dir }), encoding: "utf8",
		});
		assert.equal(result.status, 0, mode);
		assert.doesNotMatch(result.stderr, /CANARY/, mode);
		const output = JSON.parse(result.stdout);
		if (mode === "ok") assert.equal(output.hookSpecificOutput.additionalContext, BLOCK);
		else assert.deepEqual(output, {});
		assert.equal(result.stderr, mode === "ok" ? "" : "agentcore-memory recall: skipped (failed)\n", mode);
	}
	assert.deepEqual(readdirSync(dir), []);
});

test("the hook script prints {} and exits 0 with the kill switch, a broken input and no config", (t) => {
	const dir = tempDir(t);
	const script = join(root, "scripts/recall.mjs");
	const cases = [
		{ env: { AGENTCORE_MEMORY_DISABLE: "1" }, input: JSON.stringify({ prompt: "hello", session_id: "s1", cwd: dir }) },
		{ env: {}, input: "not json" },
		{ env: {}, input: JSON.stringify({ prompt: "/help", session_id: "s1", cwd: dir }) },
		{ env: {}, input: JSON.stringify({ prompt: "hello", session_id: "s1", cwd: dir }) },
	];
	for (const item of cases) {
		const result = spawnSync(process.execPath, [script], {
			cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ...item.env }, input: item.input, encoding: "utf8",
		});
		assert.equal(result.status, 0, item.input);
		assert.equal(result.stdout, "{}\n", item.input);
		assert.doesNotMatch(result.stderr, /hello/);
	}
	assert.deepEqual(readdirSync(dir), []);
});
