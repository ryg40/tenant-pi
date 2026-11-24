// The command-rules adapter applies the rule table of the kit to run_command. Run: node --test 'tests/*.test.mjs'
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "hooks", "pre-tool-use.mjs");
const table = join(here, "..", "..", "tenantext", "claude-code", "scripts", "command-rules.mjs");

function runHook(commandLine) {
	const input = JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: commandLine } } });
	return new Promise((resolve) => {
		const child = execFile("node", [hook], { timeout: 10000 },
			(error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
		child.stdin.end(input);
	});
}

test("a command of the rule table is denied with the reason of the table, a harmless command is allowed", async () => {
	const { denyReason } = await import(pathToFileURL(table).href);
	const reason = denyReason("find / -name notes.txt");
	assert.ok(reason, "the rule table denies find / -name notes.txt");
	const denied = await runHook("find / -name notes.txt");
	assert.equal(denied.code, 0, denied.stderr);
	assert.deepEqual(JSON.parse(denied.stdout), { decision: "deny", reason });

	const allowed = await runHook("ls -la");
	assert.equal(allowed.code, 0, allowed.stderr);
	assert.deepEqual(JSON.parse(allowed.stdout), { decision: "allow" });
});
