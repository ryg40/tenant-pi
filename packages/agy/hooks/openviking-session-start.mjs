#!/usr/bin/env node
// SessionStart hook for Antigravity CLI (agy): OpenViking session recall.
// It injects the OpenViking profile block as a system message, in the same
// <openviking-context source="startup"> envelope as the Claude Code plugin. It
// also replays writes that earlier hooks queued while OpenViking was down.
// After that it commits other agy conversations that are idle (the commit sweep
// of openviking-lib.mjs).
// AGY_OV_DRY_RUN=1 skips the replay and the commits and reports the block and the
// sweep candidates on stderr; the block is still printed, so the output shows
// what agy would get.
// Every path prints valid JSON ({} for no injection) and exits 0.
import {
	CLIENT_ID, FETCH_DEADLINE_MS, dryReport, emit, injection, isDryRun, loadPlugin, parseInput,
	readStdin, sweepIdleCommits, withDeadline, workspaceCwd,
} from "./openviking-lib.mjs";

// The hook timeout that the kit installer sets is 20 s. The commit sweep stops at this time
// after the start of the hook.
const HOOK_BUDGET_MS = 18000;
const started = Date.now();

async function sessionStart(input) {
	const plugin = await loadPlugin();
	const cwd = workspaceCwd(input);
	const cfg = plugin.loadAgentHookConfig(CLIENT_ID, cwd);
	const { log } = plugin.createAgentLogger(CLIENT_ID, "session-start", cfg);
	if (cfg.enabled === false || cfg.noAutoInject) return log("skip", { reason: "disabled" });
	if (plugin.isBypassed(cfg, { sessionId: String(input.conversationId || ""), cwd })) {
		return log("skip", { reason: "bypass" });
	}

	const { fetchJSON } = plugin.makeAgentFetchJSON(cfg, cwd);
	const work = (async () => {
		if (!isDryRun()) {
			const replay = await plugin.replayAgentPending(fetchJSON, log).catch(() => null);
			if (replay?.replayed || replay?.failed) log("pending-replay", replay);
		}
		return plugin.buildAgentProfile(fetchJSON, cfg, cwd);
	})();
	const profile = await withDeadline(work, FETCH_DEADLINE_MS, null);
	await sweepIdleCommits(plugin, cfg, String(input.conversationId || ""), { cwd, deadline: started + HOOK_BUDGET_MS, log });
	if (!profile) return log("skip", { reason: "no profile" });
	const block = `<openviking-context source="startup">\n${profile}\n</openviking-context>`;
	if (isDryRun()) dryReport("SessionStart", { chars: block.length, block });
	log("inject", { chars: block.length });
	return block;
}

let output = {};
try {
	output = injection(await sessionStart(parseInput(await readStdin())));
} catch (error) {
	process.stderr.write(`[agy-openviking] session-start: ${error?.message || error}\n`);
	output = {};
}
emit(output);
// A fetch past the deadline must not hold the hook open.
process.exit(0);
