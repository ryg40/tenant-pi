#!/usr/bin/env node
// UserPromptSubmit hook of the memory chain. Reads the hook input from standard input and prints
// nothing, so the prompt reaches the model unchanged. Exits 0 on every path.
// In `shadow` it hands the input to a detached child (`shadow-run.mjs`) and exits at once, so the
// hook never holds the prompt; the child runs the chain and writes the record line.
// An input over INPUT_CAP bytes starts no child: the hook writes one `skipped` record line instead.
// In `off` it loads nothing but the switch, so a broken vendored helper cannot break the hook.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The largest hook input that the hook hands to its child (map rule 25). */
const INPUT_CAP = 256 * 1024;

const startedAt = Date.now();
try {
	// Read standard input to its end, so that Claude Code can write the whole input, but keep no more
	// than the cap in memory.
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size <= INPUT_CAP) chunks.push(chunk);
		else chunks.length = 0;
	}
	const { readMode } = await import("../src/switch.mjs");
	if (readMode(process.env) === "shadow") {
		if (size > INPUT_CAP) {
			// No part of the input goes into the line. `record.mjs` imports no vendored helper.
			const { SKIP_REASONS, skipRecord, writeShadowRecord } = await import("../src/record.mjs");
			const now = Date.now();
			writeShadowRecord(skipRecord("claude-code", SKIP_REASONS.inputOverCap, now), { env: process.env, now });
		} else {
			const runner = fileURLToPath(new URL("./shadow-run.mjs", import.meta.url));
			// The input goes through a pipe, not argv or the environment: no size limit, and other users
			// cannot read it in the process list.
			const child = spawn(process.execPath, [runner, String(startedAt)],
				{ detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env });
			child.on("error", () => {});
			await new Promise((resolve) => {
				child.stdin.on("error", resolve);
				child.stdin.end(Buffer.concat(chunks), resolve);
			});
			child.unref();
		}
	}
} catch { /* exit 0 below */ }
process.exit(0);
