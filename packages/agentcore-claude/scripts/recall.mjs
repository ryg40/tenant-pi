#!/usr/bin/env node
// UserPromptSubmit hook of the AgentCore memory plugin. Reads the hook input
// from standard input and prints one JSON object. Exits 0 on every path, so a
// failure of the memory cannot block a prompt.
import { main, parseInput } from "../src/hook.mjs";

function finish(output) {
	process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

try {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	finish(await main(parseInput(Buffer.concat(chunks).toString("utf8"))));
} catch {
	finish({});
}
