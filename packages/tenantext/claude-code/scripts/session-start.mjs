#!/usr/bin/env node
// SessionStart hook. Injects the rule block as additional context once per
// session, and again on resume, /clear and compaction so the rules survive
// context loss. On the start source `startup` it also adds the handoff
// assessment prompt of idle_cleanup.py, when the script prints one. Never
// calls a model. Exits 0 on every path so a failure here cannot block a session.
import { spawnSync } from "node:child_process";
import { handoffScript } from "./idle-script.mjs";
import { RULES_BLOCK, RULES_VERSION, estimateTokensFromText } from "./rules.mjs";
import { lastInjectionPath, loadSettings, writeJson } from "./settings.mjs";

async function readInput() {
	try {
		const chunks = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		return JSON.parse(Buffer.concat(chunks).toString() || "{}");
	} catch {
		return {};
	}
}

// The startup assessment of handoff entries: idle_cleanup.py of the herdr-idle-cleanup skill claims the open
// entries of the repository and prints the assessment prompt, or nothing. Only on the start source `startup`,
// and only in an interactive session: Claude Code sets CLAUDE_CODE_ENTRYPOINT to sdk-cli for `claude -p`.
// handoffScript() in idle-script.mjs finds the script; /herdr-idle uses the same order.
// When the switch of /herdr-idle is off, the script prints nothing.
const NON_INTERACTIVE = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

function handoffAssessment(cwd) {
	const script = handoffScript();
	if (!script) return "";
	try {
		const p = spawnSync("python3", [script, "startup", "--cwd", cwd], {
			cwd, encoding: "utf8", timeout: 7000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		return p.status === 0 ? (p.stdout ?? "").trim() : "";
	} catch {
		return "";
	}
}

const input = await readInput();
const source = input.source ?? "startup";
const settings = loadSettings();
const interactive = !NON_INTERACTIVE.has(process.env.CLAUDE_CODE_ENTRYPOINT ?? "");
const assessment = source === "startup" && interactive ? handoffAssessment(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd()) : "";
const withAssessment = context => (assessment ? (context ? `${context}\n\n${assessment}` : assessment) : context);

if (!settings.rules) {
	writeJson(lastInjectionPath(), { at: new Date().toISOString(), source, injected: false, sessionId: input.session_id ?? null });
	process.stdout.write(assessment
		? `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: assessment } })}\n`
		: "{}\n");
	process.exit(0);
}

writeJson(lastInjectionPath(), {
	at: new Date().toISOString(),
	source,
	injected: true,
	sessionId: input.session_id ?? null,
	rulesVersion: RULES_VERSION,
	tokens: estimateTokensFromText(RULES_BLOCK),
});

process.stdout.write(
	`${JSON.stringify({
		hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: withAssessment(RULES_BLOCK) },
	})}\n`,
);
