import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "claude-code", "scripts");

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		assert.equal(entry.isSymbolicLink(), false, `Plugin resources must be files: ${entry.name}`);
		return entry.isDirectory()
			? files(join(directory, entry.name)).map((path) => `${entry.name}/${path}`)
			: [entry.name];
	}).sort();
}

test("the Claude Code plugin ships the Herdr runtime and command without drift", () => {
	const source = join(root, "..", "..", "skills", "herdr");
	const copy = join(root, "..", "skills", "herdr");
	const expected = [
		"SKILL.md", "SPAWN.md", "LAYOUT.md", "roles.json", "resources.json",
		"resources.local.example.json", "models.example.json", "commands/spawn_agent.md",
		"roles/contract.md", "roles/coordinator.md", "roles/researcher.md", "roles/reviewer.md",
		"roles/scout.md", "roles/worker.md", "scripts/_common.py", "scripts/ask.py", "scripts/close.py",
		"scripts/init.py", "scripts/last-reply.py", "scripts/panes.py", "scripts/resources.py", "scripts/spawn.py",
	];
	// Private model notes are absent from portable snapshots in both directories.
	if (existsSync(join(source, "MODEL-NOTES.md"))) expected.push("MODEL-NOTES.md");
	// Optional MCP files join the runtime if the kit adds them.
	if (existsSync(join(source, "mcp"))) expected.push(...files(join(source, "mcp")).map((path) => `mcp/${path}`));
	expected.sort();
	const runtime = files(source).filter((path) => path !== "install.sh" && !path.startsWith("tests/")
		&& !path.split("/").includes("__pycache__"));
	assert.deepEqual(runtime, expected, "Update the runtime list when the kit skill changes");
	assert.deepEqual(files(copy), expected, "The plugin must contain exactly the runtime files");
	for (const path of expected) {
		assert.deepEqual(readFileSync(join(copy, path)), readFileSync(join(source, path)), path);
	}
	assert.deepEqual(readFileSync(join(root, "..", "commands", "spawn_agent.md")),
		readFileSync(join(source, "commands", "spawn_agent.md")));
});

function run(script: string, args: string[], stdin: string, dir: string): string {
	return execFileSync("node", [join(root, script), ...args], { input: stdin, env: { ...process.env, TENANTEXT_CLAUDE_DIR: dir }, encoding: "utf8" });
}

test("session-start hook injects the rules by default and records the run", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-cc-"));
	const out = JSON.parse(run("session-start.mjs", [], '{"session_id":"s1","source":"startup"}', dir));
	assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
	assert.ok(out.hookSpecificOutput.additionalContext.startsWith("## Output language"));
	const last = JSON.parse(readFileSync(join(dir, "last-injection.json"), "utf8"));
	assert.equal(last.injected, true);
	assert.equal(last.sessionId, "s1");
});

test("session-start hook skips when rules are off, and survives bad stdin", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-cc-"));
	run("ste.mjs", ["off"], "", dir);
	assert.equal(run("session-start.mjs", [], "not json", dir).trim(), "{}");
	const last = JSON.parse(readFileSync(join(dir, "last-injection.json"), "utf8"));
	assert.equal(last.injected, false);
	assert.equal(last.source, "startup");
});

test("ste status reports the toggle and the last run", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-cc-"));
	run("session-start.mjs", [], '{"source":"compact"}', dir);
	const out = run("ste.mjs", ["status"], "", dir);
	assert.ok(out.includes("| rules default | on |"));
	assert.ok(out.includes("source compact, injected"));
	assert.ok(run("ste.mjs", ["rules"], "", dir).includes("No greetings"));
	assert.ok(run("ste.mjs", ["help"], "", dir).includes("/ste on"));
});
