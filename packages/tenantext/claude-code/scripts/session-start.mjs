#!/usr/bin/env node
// SessionStart hook. Injects the rule block as additional context once per
// session, and again on resume, /clear and compaction so the rules survive
// context loss. Never calls a model. Exits 0 on every path so a failure here
// cannot block a session.
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

const input = await readInput();
const source = input.source ?? "startup";
const settings = loadSettings();

if (!settings.rules) {
	writeJson(lastInjectionPath(), { at: new Date().toISOString(), source, injected: false, sessionId: input.session_id ?? null });
	process.stdout.write("{}\n");
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
		hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RULES_BLOCK },
	})}\n`,
);
