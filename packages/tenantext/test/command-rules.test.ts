import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMAND_RULES, denyReason } from "../claude-code/scripts/command-rules.mjs";
import commandRules from "../extensions/command-rules/index.ts";

const REASON = COMMAND_RULES["find / *"].reason;
const SECRET = COMMAND_RULES.env.reason;
const HOOK = fileURLToPath(new URL("../claude-code/scripts/pre-tool-use.mjs", import.meta.url));

test("denies a whole-disk find and a bare env or printenv, also inside a command list", () => {
	for (const [line, reason] of [
		["find  /  -type f", REASON],
		["cd /tmp && find / -name x 2>&1 | head", REASON],
		["env", SECRET],
		["env | grep TOKEN", SECRET],
		["printenv | sort", SECRET],
	]) {
		assert.equal(denyReason(line), reason, line);
	}
});

test("allows a scoped find and a quoted mention", () => {
	for (const line of ["find /var/log -name x", "find . -name x", 'rg "find / -name"', 'git commit -m "a; find / -name x"', "printenv HOME", "env FOO=1 node x.js", "env -i bash -c true"]) {
		assert.equal(denyReason(line), undefined, line);
	}
});

test("the Pi extension blocks a matching bash call only", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	assert.deepEqual(await handler!({ toolName: "bash", input: { command: "find / -name x" } }), { block: true, reason: REASON });
	assert.equal(await handler!({ toolName: "read", input: { command: "find / -name x" } }), undefined);
});

function runHook(input: string) {
	return spawnSync(process.execPath, [HOOK], { input, encoding: "utf8" });
}

test("the Claude Code hook denies a matching Bash call and fails open", () => {
	const denied = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "find / -name x" } }));
	assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
	assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, REASON);
	for (const input of [JSON.stringify({ tool_name: "Bash", tool_input: { command: "find . -name x" } }), "not json"]) {
		const allowed = runHook(input);
		assert.equal(allowed.status, 0);
		assert.deepEqual(JSON.parse(allowed.stdout), {});
	}
});
