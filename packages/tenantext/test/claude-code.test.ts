import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "claude-code", "scripts");

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
