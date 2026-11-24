#!/usr/bin/env node
// Stop hook for Antigravity CLI (agy): OpenViking capture.
// It reads the agy transcript (transcriptPath), takes the closed turns that are
// not sent yet, and adds the user text and the last final assistant text of each
// turn to the OpenViking session of the conversation. A turn is closed when a
// later prompt exists, or at a Stop with fullyIdle and no active continuation.
// Until then the newest turn is held: agy can still add text to it. A cursor per
// conversation (the step_index of the last sent prompt) keeps each turn from
// being sent twice. After that it commits other agy conversations that are
// idle (the commit sweep of openviking-lib.mjs).
// AGY_OV_DRY_RUN=1 prints the messages on stderr and sends and saves nothing.
// Every path prints {"decision":"stop"} and exits 0: agy always stops normally.
import { readFile } from "node:fs/promises";
import {
	CLIENT_ID, dryReport, emit, isDryRun, isIdleStop, loadPlugin, newTurns, withDeadline, ovSessionId, parseInput,
	parseTranscript, readState, readStdin, stepsToTurns, sweepIdleCommits, withStateLock, workspaceCwd, writeState,
} from "./openviking-lib.mjs";

const STOP = { decision: "stop" };
// The Stop hook timeout that the kit installer sets is 30 s. A capture request must end before
// agy kills the hook: a kill after the server took the messages and before the
// cursor is saved sends the turn again at the next Stop. The plugin default is
// at least 30 s (captureTimeoutMs), so this client caps it.
const CAPTURE_REQUEST_MS = 20000;
// The session check, the commit after the send and the commit sweep run only
// until this time after the start of the hook. The cursor is already saved then.
const HOOK_BUDGET_MS = 27000;
const started = Date.now();

function payloadsFor(plugin, cfg, turns) {
	const payloads = [];
	const message = (role, text) => {
		if (!text) return;
		const { parts } = plugin.shapeCaptureParts([{ type: "text", text }], role, cfg);
		if (parts.length) payloads.push({ role, parts });
	};
	for (const turn of turns) {
		message("user", turn.user);
		if (cfg.captureAssistantTurns !== false) message("assistant", turn.assistant);
	}
	return payloads;
}

async function capture(input) {
	const conversationId = String(input.conversationId || "");
	const transcriptPath = String(input.transcriptPath || "");
	if (!conversationId || !transcriptPath) return;

	const plugin = await loadPlugin();
	const cwd = workspaceCwd(input);
	const cfg = plugin.loadAgentHookConfig(CLIENT_ID, cwd);
	const { log, logError } = plugin.createAgentLogger(CLIENT_ID, "capture", cfg);
	const sessionId = ovSessionId(plugin, conversationId);
	if (cfg.enabled === false || !plugin.isCaptureEnabled(cfg)) return log("skip", { reason: "disabled" });
	if (plugin.isBypassed(cfg, { sessionId: conversationId, cwd })) return log("skip", { reason: "bypass" });

	const done = await withStateLock(conversationId, async () => {
		const state = await readState(conversationId);
		const turns = stepsToTurns(parseTranscript(await readFile(transcriptPath, "utf8")));
		const fresh = newTurns(turns, state.lastUserStep, isIdleStop(input));
		if (!fresh.length) return log("skip", { reason: "no new turns", total: turns.length });
		const cursor = fresh[fresh.length - 1].userStep;
		const payloads = payloadsFor(plugin, cfg, fresh);

		if (isDryRun()) {
			dryReport("Stop", { sessionId, turns: fresh.length, cursorAfter: cursor, messages: payloads });
			return true;
		}
		if (!payloads.length) {
			await writeState(conversationId, { ...state, lastUserStep: cursor });
			return log("skip", { reason: "filtered", turns: fresh.length });
		}

		const { fetchJSON, effectivePeer } = plugin.makeAgentFetchJSON(cfg, cwd, {
			defaultTimeoutMs: Math.min(Number(cfg.captureTimeoutMs) || CAPTURE_REQUEST_MS, CAPTURE_REQUEST_MS),
			requireJsonBody: true,
		});
		const res = await plugin.addAgentMessages(fetchJSON, sessionId, payloads, effectivePeer.peerId);
		log("send", { sessionId, messages: payloads.length, sent: res.sent, queued: res.queued, failed: res.failed });
		// As the Claude Code capture: keep the cursor when a message was neither sent
		// nor queued for replay, or when the session is missing on the server.
		const missing = String(res.lastError?.code || "").toUpperCase() === "NOT_FOUND";
		if (res.enqueueFailed > 0 || (res.failed > 0 && res.sent === 0 && res.queued === 0 && missing)) {
			logError("send", "messages neither sent nor queued; cursor kept");
			return true;
		}
		// sentStep, transcriptPath and cwd are for the commit sweep of a later hook.
		const sentState = { ...state, lastUserStep: cursor, sentStep: cursor, transcriptPath, cwd };
		await writeState(conversationId, sentState);

		if (res.sent > 0) {
			const commit = async () => {
				const meta = await plugin.getAgentSession(fetchJSON, sessionId);
				if (Number(meta?.pending_tokens || 0) >= cfg.commitTokenThreshold) {
					const done = await plugin.commitAgentSession(fetchJSON, sessionId, log, { keep_recent_count: 0 });
					if (done?.ok || done?.pendingQueued) await writeState(conversationId, { ...sentState, committedStep: cursor });
				}
			};
			await withDeadline(commit(), Math.max(0, HOOK_BUDGET_MS - (Date.now() - started)), null);
		}
		return true;
	});
	if (done === null) logError("lock", "state lock busy; capture skipped");
	await sweepIdleCommits(plugin, cfg, conversationId, { cwd, deadline: started + HOOK_BUDGET_MS, log });
}

try {
	await capture(parseInput(await readStdin()));
} catch (error) {
	process.stderr.write(`[agy-openviking] capture: ${error?.message || error}\n`);
}
emit(STOP);
process.exit(0);
