#!/usr/bin/env node
// PreToolUse hook for Antigravity CLI (agy). It applies the shell command rules of the
// kit (packages/tenantext/claude-code/scripts/command-rules.mjs) to the run_command
// tool. A matching command gets "deny" with the reason of the rule table. Every other
// path prints "allow": agy then applies its normal permission policy. A fault here
// never blocks a session.
//
// Input: {"toolCall": {"name": "run_command", "args": {"CommandLine": "<command line>"}}}.
// The rule table is found by a path relative to the real file of this hook, so the
// hook works from any kit clone and through a link.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const rulesFile = join(here, "..", "..", "tenantext", "claude-code", "scripts", "command-rules.mjs");

let output = { decision: "allow" };
try {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
	if (input?.toolCall?.name === "run_command") {
		let denyReason;
		try {
			({ denyReason } = await import(pathToFileURL(rulesFile).href));
		} catch (error) {
			process.stderr.write(`[agy-kit] pre-tool-use: the command rules are not loaded from ${rulesFile}: ${error?.message || error}\n`);
		}
		const reason = denyReason?.(String(input.toolCall.args?.CommandLine ?? ""));
		if (reason) output = { decision: "deny", reason };
	}
} catch {
	output = { decision: "allow" };
}
process.stdout.write(`${JSON.stringify(output)}\n`);
