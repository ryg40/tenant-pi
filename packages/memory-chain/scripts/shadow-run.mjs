#!/usr/bin/env node
// The detached child of `shadow-hook.mjs`: reads the hook input from standard input, runs the chain in
// shadow and writes the record line. Its output goes nowhere. Argument 1 is the prompt arrival in ms.
const startedAt = Number(process.argv[2]) || Date.now();
try {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const { main, parseInput } = await import("../src/hook.mjs");
	await main(parseInput(Buffer.concat(chunks).toString("utf8")), { startedAt });
} catch { /* nothing to report to */ }
process.exit(0);
