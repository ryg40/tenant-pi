#!/usr/bin/env node
// PreToolUse hook for Bash. Denies a command that matches a rule of
// command-rules.mjs. Every other path prints {} and exits 0, so a failure
// here cannot block a session.
import { denyReason } from "./command-rules.mjs";

let reason;
try {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
	if (input.tool_name === "Bash") reason = denyReason(String(input.tool_input?.command ?? ""));
} catch {
	reason = undefined;
}

const output = reason
	? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
	: {};
process.stdout.write(`${JSON.stringify(output)}\n`);
