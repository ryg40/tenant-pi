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

test("both harnesses deny credsync approval with usual command prefixes", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	for (const command of [
		"credsync allow",
		"credsync allow ./project",
		"/path/bin/credsync allow ./project",
		"sudo credsync allow ./project",
		"VAR=x credsync allow ./project",
		"VAR=x sudo /path/bin/credsync allow ./project",
		"true && credsync allow",
		"VAR=x MORE='two words' sudo -n -u root NEXT=y /path/bin/credsync allow ./project",
		"env -i -u UNUSED NEXT=y credsync allow ./project",
	]) {
		const result = await handler!({ toolName: "bash", input: { command } }) as { block: boolean };
		assert.equal(result?.block, true, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.equal(hook.status, 0);
		assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny", command);
	}
});

test("both harnesses allow credsync run, credsync-status and command mentions", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	for (const command of [
		"credsync run -- command",
		"VAR=x sudo /path/bin/credsync run -- command",
		"credsync-status",
		'rg "credsync allow" README.md',
		"echo credsync allow",
		'git commit -m "document credsync allow"',
		"cat <<'EOF'\nRun credsync allow in an owner terminal.\nEOF",
		"sudo -n echo credsync allow",
		"env -i echo credsync allow",
	]) {
		assert.equal(await handler!({ toolName: "bash", input: { command } }), undefined, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.equal(hook.status, 0);
		assert.deepEqual(JSON.parse(hook.stdout), {}, command);
	}
});

test("both harnesses deny an AWS CLI read of a Secrets Manager secret value", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	for (const command of [
		"aws secretsmanager get-secret-value --secret-id demo",
		"aws secretsmanager batch-get-secret-value --secret-id-list demo",
		"aws --region us-east-1 --output json secretsmanager get-secret-value --secret-id demo",
		"aws secretsmanager --profile test get-secret-value --secret-id demo",
		"AWS_PROFILE=test /usr/local/bin/aws secretsmanager get-secret-value --secret-id demo",
		"sudo -n aws secretsmanager get-secret-value --secret-id demo",
		"cd /tmp && aws secretsmanager get-secret-value --secret-id demo | head",
	]) {
		const result = await handler!({ toolName: "bash", input: { command } }) as { block: boolean };
		assert.equal(result?.block, true, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny", command);
	}
});

test("both harnesses allow other Secrets Manager calls and mentions of the read", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	for (const command of [
		"aws secretsmanager create-secret --name demo --secret-string dummy",
		"aws secretsmanager describe-secret --secret-id demo",
		"aws secretsmanager list-secrets",
		'rg "aws secretsmanager get-secret-value" docs',
		"echo aws secretsmanager get-secret-value",
		'git commit -m "deny aws secretsmanager get-secret-value"',
	]) {
		assert.equal(await handler!({ toolName: "bash", input: { command } }), undefined, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.deepEqual(JSON.parse(hook.stdout), {}, command);
	}
});

test("both harnesses read shell words: quoted option operands and shell -c scripts", async () => {
	let handler: ((event: unknown) => Promise<unknown>) | undefined;
	commandRules({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	const denied = [
		'aws --profile "review profile" secretsmanager get-secret-value --secret-id demo',
		"aws --profile 'review profile' --region us-east-1 secretsmanager get-secret-value --secret-id demo",
		"sh -c 'aws secretsmanager get-secret-value --secret-id demo'",
		'sh -c "aws secretsmanager batch-get-secret-value --secret-id-list demo"',
		"bash -lc 'cd /tmp && aws --output text secretsmanager get-secret-value --secret-id demo'",
		"env -u AWS_PAGER bash -c \"sh -c 'aws secretsmanager get-secret-value --secret-id demo'\"",
		// A backslash-newline joins the lines, also inside the script of sh -c.
		"aws \\\nsecretsmanager get-secret-value --secret-id demo",
		"sh -c 'aws secretsmanager \\\nget-secret-value --secret-id demo'",
	];
	const allowed = [
		"aws secretsmanager describe-secret --secret-id demo",
		"sh -c 'aws secretsmanager describe-secret --secret-id demo'",
		'bash -c "echo aws secretsmanager get-secret-value"',
		'grep -rn "aws secretsmanager get-secret-value" docs',
		"aws --profile 'review profile' s3 ls",
	];
	for (const command of denied) {
		const result = await handler!({ toolName: "bash", input: { command } }) as { block: boolean };
		assert.equal(result?.block, true, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny", command);
	}
	for (const command of allowed) {
		assert.equal(await handler!({ toolName: "bash", input: { command } }), undefined, command);
		const hook = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
		assert.deepEqual(JSON.parse(hook.stdout), {}, command);
	}
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
