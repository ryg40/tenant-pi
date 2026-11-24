#!/usr/bin/env node
// PreInvocation hook for Antigravity CLI (agy): OpenViking recall for the prompt.
// agy runs PreInvocation before each model call of a turn, not once per prompt.
// invocationNum is 0 at the first model call of each prompt (seen in a live agy
// run), so the hook recalls then. A later call recalls only when its
// lastUserInput differs from the saved hash. The recall block of the plugin goes
// in as a system message.
// AGY_OV_DRY_RUN=1 saves no hash, sends no session id (no server-side dedup
// ledger), and reports the block on stderr; the block is still printed.
// Every path prints valid JSON ({} for no injection) and exits 0.
import {
	CLIENT_ID, FETCH_DEADLINE_MS, dryReport, emit, hashText, injection, isDryRun, loadPlugin,
	ovSessionId, parseInput, readState, readStdin, withDeadline, withStateLock, workspaceCwd, writeState,
} from "./openviking-lib.mjs";

/**
 * True when this call starts a prompt (invocationNum 0), or when its prompt
 * differs from the last recalled one. Saves the hash of the prompt.
 */
async function claimPrompt(conversationId, prompt, invocationNum) {
	const hash = hashText(prompt);
	const first = invocationNum === 0;
	if (isDryRun()) return first || (await readState(conversationId)).lastRecallHash !== hash;
	const claimed = await withStateLock(conversationId, async () => {
		const state = await readState(conversationId);
		if (!first && state.lastRecallHash === hash) return false;
		await writeState(conversationId, { ...state, lastRecallHash: hash });
		return true;
	}, 2000);
	return claimed === true;
}

async function promptRecall(input) {
	const conversationId = String(input.conversationId || "");
	let prompt = String(input.lastUserInput || "").trim();
	if (!conversationId || !prompt) return null;
	// Before the plugin loads: the later model calls of a turn end here, fast.
	if (!(await claimPrompt(conversationId, prompt, input.invocationNum))) return null;

	const plugin = await loadPlugin();
	const cwd = workspaceCwd(input);
	const cfg = plugin.loadAgentHookConfig(CLIENT_ID, cwd);
	const { log } = plugin.createAgentLogger(CLIENT_ID, "prompt-recall", cfg);
	if (cfg.enabled === false || cfg.autoRecall === false) return log("skip", { reason: "disabled" });
	if (plugin.isBypassed(cfg, { sessionId: conversationId, cwd })) return log("skip", { reason: "bypass" });

	// The query filters and the length gate of the Claude Code recall hook.
	const filters = plugin.compileInputFilters(cfg.recallQueryFilters);
	if (filters.rules.length) {
		const verdict = plugin.applyInputFilters(prompt, filters.rules, { role: "user" });
		if (verdict.dropped) return log("skip", { reason: "query_filter" });
		prompt = verdict.text;
	}
	if (!prompt || prompt.length < cfg.minQueryLength) return log("skip", { reason: "short_query" });

	const { fetchJSON } = plugin.makeAgentFetchJSON(cfg, cwd);
	const sessionId = isDryRun() ? "" : ovSessionId(plugin, conversationId);
	const block = await withDeadline(
		plugin.recallForPrompt(fetchJSON, cfg, prompt, cwd, log, { sessionId }),
		FETCH_DEADLINE_MS,
		null,
	);
	if (!block) return log("skip", { reason: "no recall" });
	if (isDryRun()) dryReport("PreInvocation", { query: prompt, chars: block.length, block });
	log("inject", { chars: block.length });
	return block;
}

let output = {};
try {
	output = injection(await promptRecall(parseInput(await readStdin())));
} catch (error) {
	process.stderr.write(`[agy-openviking] prompt-recall: ${error?.message || error}\n`);
	output = {};
}
emit(output);
// A fetch past the deadline must not hold the hook open.
process.exit(0);
