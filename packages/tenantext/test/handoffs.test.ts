import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHandoffs, type RunResult } from "../extensions/handoffs/index.ts";

test("handoffs starts one turn for a non-empty startup output and no turn for an empty one, a reload or no UI", async () => {
	const cases = [["ASSESSMENT-MARKER", 1, "startup", true], ["", 0, "startup", true],
		["ASSESSMENT-MARKER", 0, "reload", true], ["ASSESSMENT-MARKER", 0, "startup", false]] as const;
	for (const [stdout, turns, reason, hasUI] of cases) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const messages: Array<{ message: { content: string }; options: { triggerTurn?: boolean } }> = [];
		const calls: string[][] = [];
		let finished!: () => void;
		const ran = new Promise<void>(resolve => { finished = resolve; });
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); return () => {}; },
			registerCommand() {},
			sendMessage(message: { content: string }, options: { triggerTurn?: boolean }) { messages.push({ message, options }); },
		} as unknown as ExtensionAPI;
		createHandoffs(pi, {
			findScript: () => "/stub/idle_cleanup.py",
			run: async (args): Promise<RunResult> => { calls.push(args); queueMicrotask(finished); return { code: 0, stdout, stderr: "" }; },
		});
		await handlers.get("session_start")!({ type: "session_start", reason }, { cwd: "/work/repo-a", hasUI });
		const runs = reason === "startup" && hasUI;
		if (runs) await ran;
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(calls, runs ? [["/stub/idle_cleanup.py", "startup", "--cwd", "/work/repo-a"]] : []);
		assert.equal(messages.length, turns);
		if (turns) {
			assert.equal(messages[0].message.content, "ASSESSMENT-MARKER");
			assert.equal(messages[0].options.triggerTurn, true);
		}
	}
});
