import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import slopscore from "../src/index.ts";
import { collectPrData, renderPrMarkdown } from "../src/pr.ts";
import { loadConfig } from "../src/tiers.ts";
import { branchRepo, writePiTrace } from "./helpers.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Both harness entry points must print the block the renderer prints for the same data.
 * Pi: the real command handler through a fake ExtensionAPI. Claude Code: the exact shell
 * line from the command file, with the plugin root and the arguments substituted.
 */

const pluginRoot = fileURLToPath(new URL("../../claude-code", import.meta.url));

function fixtureRepo() {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-entry-pi-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-entry-claude-"));
	writePiTrace(piDir, "main", r.dir, [{ time: "2026-09-02T13:00:00Z", cost: 2, model: "gpt-5.6-sol", thinking: "medium" }]);
	writePiTrace(piDir, "review", join(r.dir, "src"), [{ time: "2026-09-02T14:00:00Z", cost: 0.5, model: "claude-fable-5-1", thinking: "high" }], "reviewer");
	const env = { ...process.env, PI_CODING_AGENT_DIR: piDir, CLAUDE_CONFIG_DIR: claudeDir, SLOPSCORE_CONFIG: join(piDir, "isolated-config.json") };
	return { ...r, env };
}

/** The block for the fixture, built in-process with the same env the entry points get. */
function expectedBlock(r: ReturnType<typeof fixtureRepo>, noSpend = false): string {
	const saved = { ...process.env };
	Object.assign(process.env, r.env);
	try {
		const data = collectPrData(r.dir, { base: "main", json: false, help: false, noSpend }, loadConfig());
		if (!data.ok) throw new Error(data.error);
		assert.equal(data.data.trace?.sessions, 2);
		return renderPrMarkdown(data.data);
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

interface FakePi {
	handler?: (args: string, ctx: unknown) => Promise<void>;
	completions?: (prefix: string) => Array<{ value: string }> | null;
	shown: string[];
	notices: string[];
}

function fakePi(): FakePi {
	const fake: FakePi = { shown: [], notices: [] };
	const api = {
		registerEntryRenderer() {},
		appendEntry(_type: string, data: { body: string }) { fake.shown.push(data.body); },
		on() {},
		registerCommand(_name: string, spec: { handler: FakePi["handler"]; getArgumentCompletions: FakePi["completions"] }) {
			fake.handler = spec.handler;
			fake.completions = spec.getArgumentCompletions;
		},
	};
	slopscore(api as never);
	return fake;
}

function piContext(cwd: string, notices: string[]) {
	return { cwd, ui: { notify: (message: string) => notices.push(message) }, sessionManager: { getSessionFile: () => undefined } };
}

async function runPi(fake: FakePi, r: ReturnType<typeof fixtureRepo>, args: string): Promise<string> {
	const saved = { ...process.env };
	Object.assign(process.env, r.env);
	try {
		fake.shown.length = 0;
		await fake.handler!(args, piContext(r.dir, fake.notices));
		return fake.shown.join("\n");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

test("Pi: /slopscore pr joins the completion list, help documents it, and the block equals the renderer output", async () => {
	const r = fixtureRepo();
	const fake = fakePi();
	assert.ok(fake.completions!("p")?.some((item) => item.value === "pr"));
	assert.match(await runPi(fake, r, "help"), /\| \/slopscore pr \[--base REF\] \[--no-spend\] \[--json\] \|/);
	assert.equal(await runPi(fake, r, "pr --base main"), expectedBlock(r));
	assert.equal(await runPi(fake, r, "pr --base main --no-spend"), expectedBlock(r, true));
	assert.match(await runPi(fake, r, "pr --base main --no-spend"), /\| n\/a \|/);
	const json = JSON.parse(await runPi(fake, r, "pr --base main --json"));
	assert.equal(json.trace.sessions, 2);
	assert.equal(await runPi(fake, r, "pr --base nope"), "");
	assert.deepEqual(fake.notices, ["slopscore pr: Base ref does not resolve."]);
});

test("Claude Code: the command file forwards `pr` and its flags to the CLI and prints the renderer block", () => {
	const r = fixtureRepo();
	const command = readFileSync(join(pluginRoot, "commands", "slopscore.md"), "utf8");
	assert.match(command, /argument-hint: ".*pr \[--base REF\] \[--no-spend\] \[--json\]/);
	const shellLine = command.split("\n").find((line) => line.startsWith("!`"));
	assert.ok(shellLine, "command file has a shell line");
	const template = shellLine.slice(2, -1);
	const runClaude = (args: string) => {
		const cmd = template.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replace("$ARGUMENTS", args);
		return spawnSync("bash", ["-c", cmd], { cwd: r.dir, encoding: "utf8", env: r.env });
	};
	const block = runClaude("pr --base main");
	assert.equal(block.status, 0, block.stderr);
	assert.equal(block.stdout.trimEnd(), expectedBlock(r));
	assert.equal(runClaude("pr --base main --no-spend").stdout.trimEnd(), expectedBlock(r, true));
	assert.equal(JSON.parse(runClaude("pr --base main --json").stdout).trace.sessions, 2);
	assert.equal(runClaude("pr --base nope").status, 1);
});
