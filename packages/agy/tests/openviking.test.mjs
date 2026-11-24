// Tests of the OpenViking hook adapters for agy that need no OpenViking plugin and no network.
// Run: node --test 'tests/*.test.mjs'
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseTranscript, stepsToTurns } from "../hooks/openviking-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hooks = join(here, "..", "hooks");
const fixture = join(here, "fixtures", "agy-transcript.jsonl");

function runHook(name, stdin, env = {}) {
	return new Promise((resolve) => {
		const child = execFile("node", [join(hooks, name)], { env: { ...process.env, ...env }, timeout: 30000 },
			(error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

test("transcript conversion keeps the user text and the final assistant text of each turn, in order", async () => {
	const turns = stepsToTurns(parseTranscript(await readFile(fixture, "utf8")));
	assert.deepEqual(
		turns.map(({ user, assistant }) => ({ user, assistant })),
		[
			{
				user: '<hc from="pane-1 coordinator">First prompt: please check the hook.</hc>',
				assistant: "The hook works: it blocked the command.",
			},
			{
				user: "Second prompt: what is in my memory about Herdr?",
				assistant: "Herdr worker panes default to Claude Opus with medium thinking.",
			},
			{ user: "Third prompt, still running.", assistant: null },
		],
	);
});

test("each OpenViking hook fails open when the plugin folder is gone", async () => {
	const home = await mkdtemp(join(tmpdir(), "agy-ov-test-"));
	const input = JSON.stringify({
		conversationId: "conversation-1", cwd: home, lastUserInput: "a prompt", invocationNum: 0,
		transcriptPath: join(home, "transcript.jsonl"),
	});
	try {
		for (const name of ["openviking-capture.mjs", "openviking-session-start.mjs", "openviking-prompt-recall.mjs"]) {
			const { code, stdout, stderr } = await runHook(name, input, {
				HOME: home, AGY_OV_STATE_DIR: join(home, "state"), AGY_OV_PLUGIN_ROOT: join(home, "no-plugin"),
			});
			assert.equal(code, 0, `${name}: ${stderr}`);
			const output = JSON.parse(stdout);
			assert.ok(output && typeof output === "object" && !Array.isArray(output), name);
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
