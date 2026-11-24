// Shared parts of the OpenViking hook adapters for Antigravity CLI (agy).
//
// The adapters give agy the memory behavior of the OpenViking Claude Code plugin:
// capture (Stop), session recall (SessionStart) and prompt recall (PreInvocation).
// They import the shared modules of the installed plugin by absolute path and call
// them with agy data. This file has no OpenViking import at the top, so the agy
// transcript conversion stays testable without the plugin.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CLIENT_ID = "antigravity-cli";
export const SESSION_PREFIX = "agy-";
// Hooks are synchronous for agy. A recall or profile fetch that runs longer than
// this answers with no injection, inside the hook timeout that the kit installer sets (20 s).
export const FETCH_DEADLINE_MS = 15000;

export const isDryRun = () => process.env.AGY_OV_DRY_RUN === "1";

export function dryReport(event, data) {
	process.stderr.write(`${JSON.stringify({ dryRun: true, event, ...data }, null, 2)}\n`);
}

export async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

/** The hook input as an object. Bad JSON or a non-object throws. The error text quotes no input. */
export function parseInput(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		// The message of JSON.parse holds the start of the input; the hook writes the message to stderr.
		throw new Error("hook input is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hook input is not an object");
	return value;
}

export function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** The agy injection envelope. The nested systemMessage form was tested in a live agy session. */
export function injection(text) {
	return text ? { injectSteps: [{ systemMessage: { systemMessage: text } }] } : {};
}

export function safeId(value) {
	return String(value || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

export function workspaceCwd(input) {
	const paths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
	return String(input.cwd || paths.find((p) => typeof p === "string" && p.trim()) || process.cwd());
}

export function hashText(text) {
	return createHash("sha256").update(String(text)).digest("hex");
}

// ---------------------------------------------------------------------------
// The installed OpenViking plugin
// ---------------------------------------------------------------------------

// The number at the start of each part; a part without one counts as 0.
const versionParts = (name) => name.split(/[.-]/).map((part) => Number(/^[0-9]+/.exec(part)?.[0] ?? 0));

/** The version order of the plugin folders, the same as compare_versions in scripts/kit_agy.py: compare the parts
 * as numbers, pad the shorter list with zeros, and order equal versions by their name text. */
export function compareVersions(a, b) {
	const pa = versionParts(a);
	const pb = versionParts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The newest version folder of the plugin, as the kit installer finds it for the MCP proxy. */
export async function pluginRoot() {
	if (process.env.AGY_OV_PLUGIN_ROOT) return process.env.AGY_OV_PLUGIN_ROOT;
	const base = join(homedir(), ".claude", "plugins", "cache", "openviking", "openviking-memory");
	const versions = (await readdir(base)).sort(compareVersions);
	if (!versions.length) throw new Error(`no OpenViking plugin in ${base}`);
	return join(base, versions[versions.length - 1]);
}

export async function loadPlugin() {
	const root = await pluginRoot();
	const load = (name) => import(pathToFileURL(join(root, "scripts", "shared", name)).href);
	const [runtime, sessionModel, captureUtils, inputFilters, pendingQueue] = await Promise.all([
		load("agent-hook-runtime.mjs"),
		load("session-model.mjs"),
		load("capture-utils.mjs"),
		load("input-filters.mjs"),
		load("pending-queue.mjs").catch(() => ({})),
	]);
	// From the pending queue only the replay of the commit sweep.
	const { replayPending } = pendingQueue;
	return { root, ...runtime, ...sessionModel, ...captureUtils, ...inputFilters, replayPending };
}

/** The OpenViking session id of an agy conversation. */
export function ovSessionId(plugin, conversationId) {
	return plugin.deriveHarnessSessionId(SESSION_PREFIX, safeId(conversationId));
}

/** Resolve `promise`, or `fallback` after `ms`. A hook must answer in time. */
export function withDeadline(promise, ms, fallback) {
	let timer;
	return Promise.race([
		promise,
		new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
	]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// The agy transcript
// ---------------------------------------------------------------------------

/** JSONL steps in step order. Lines that do not parse are skipped. */
export function parseTranscript(content) {
	const steps = [];
	for (const line of String(content || "").split("\n")) {
		if (!line.trim()) continue;
		try {
			const step = JSON.parse(line);
			if (step && typeof step === "object") steps.push(step);
		} catch { /* a partial last line */ }
	}
	return steps.sort((a, b) => (Number(a.step_index) || 0) - (Number(b.step_index) || 0));
}

/**
 * The user's own text of a USER_INPUT step. agy wraps the prompt in
 * <USER_REQUEST> and adds blocks of its own (time, setting changes).
 */
export function userText(content) {
	let text = String(content || "");
	const request = text.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
	if (request) text = request[1];
	return text
		.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, "")
		.trim();
}

function isHumanInput(step) {
	return step.type === "USER_INPUT" && (!step.source || step.source === "USER_EXPLICIT");
}

function hasToolCalls(step) {
	return Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
}

/**
 * One turn for each prompt of the user, in order: the user text and the last
 * final assistant text (a PLANNER_RESPONSE with text and no tool call), or null.
 * Thinking, tool calls, tool output (GENERIC steps), system messages and
 * hook-injected inputs (source SYSTEM_SDK) are left out.
 *
 * `closed` is true when a later prompt of the user exists. Only the newest turn
 * can be open: agy can still add text to it.
 */
export function stepsToTurns(steps) {
	const turns = [];
	let turn = null;
	for (const step of steps) {
		if (isHumanInput(step)) {
			if (turn) turn.closed = true;
			turn = { userStep: Number(step.step_index), user: userText(step.content), assistant: null, closed: false };
			turns.push(turn);
			continue;
		}
		if (!turn || step.type !== "PLANNER_RESPONSE" || hasToolCalls(step)) continue;
		const text = typeof step.content === "string" ? step.content.trim() : "";
		if (text) turn.assistant = text;
	}
	return turns;
}

/**
 * True when the Stop input says that the conversation is idle: agy adds no more
 * steps to the newest turn (`fullyIdle`, and no active continuation).
 */
export function isIdleStop(input) {
	return input?.fullyIdle === true && input?.continuationActive !== true;
}

/**
 * The turns to send: the turns after the cursor (the user step of the last
 * turn that was sent) that are closed. At an idle Stop the newest turn is closed
 * too. A turn without a final assistant text goes with its user text alone.
 */
export function newTurns(turns, lastUserStep, idle = false) {
	const cursor = Number.isFinite(lastUserStep) ? lastUserStep : -1;
	return turns.filter((t) => t.userStep > cursor && (t.closed || idle));
}

// ---------------------------------------------------------------------------
// State per conversation: ~/.local/state/agy-openviking/<conversationId>.json
// ---------------------------------------------------------------------------

export function stateDir() {
	return process.env.AGY_OV_STATE_DIR || join(homedir(), ".local", "state", "agy-openviking");
}

function stateFile(conversationId) {
	return join(stateDir(), `${safeId(conversationId)}.json`);
}

export async function readState(conversationId) {
	try {
		const value = JSON.parse(await readFile(stateFile(conversationId), "utf8"));
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

export async function writeState(conversationId, value) {
	const file = stateFile(conversationId);
	await mkdir(stateDir(), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tmp, file);
}

/** Run `fn` under a lock folder of the conversation. Returns null when the lock stays taken. */
export async function withStateLock(conversationId, fn, waitMs = 5000) {
	const lock = `${stateFile(conversationId)}.lock`;
	await mkdir(stateDir(), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			await mkdir(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lock)).mtimeMs > 60_000) {
					await rm(lock, { recursive: true, force: true });
					continue;
				}
			} catch { /* the lock went away */ }
			if (Date.now() >= deadline) return null;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lock, { recursive: true, force: true }).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// The commit sweep
// ---------------------------------------------------------------------------

// agy has no session-end event. OpenViking makes long-term memories from a
// session only at a commit, so a short conversation that never reaches the
// token threshold of the capture is committed here, when it is idle.
export const SWEEP_IDLE_MS = 30 * 60 * 1000;

/** The last step that was sent. State files from before `sentStep` have only the cursor. */
function sentStepOf(state) {
	const step = Number.isFinite(state.sentStep) ? state.sentStep : state.lastUserStep;
	return Number.isFinite(step) ? step : null;
}

/** The time of the last activity: the state file or the transcript, the newer one. */
async function lastActivityMs(file, state) {
	let newest = (await stat(file)).mtimeMs;
	if (state.transcriptPath) {
		try { newest = Math.max(newest, (await stat(state.transcriptPath)).mtimeMs); } catch { /* gone */ }
	}
	return newest;
}

/** The folder of the plugin pending queue, by the rule of pending-queue.mjs. */
function pendingDir() {
	return process.env.OPENVIKING_PENDING_DIR || join(homedir(), ".openviking", "pending");
}

/** The scans of the queue folder in one sweep, at most: the first one and the rescans after a rename race. */
const QUEUE_SCANS = 3;

/** The entry of a queue file under the first of `names` that exists, "moved" when none exists, null when it cannot be read or parsed. */
async function readQueueEntry(dir, names) {
	for (const name of names) {
		try {
			return JSON.parse(await readFile(join(dir, name), "utf8"));
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return null;
		}
	}
	return "moved";
}

/**
 * The session ids of the entries in the pending queue. Unlike the plugin
 * listPending(), this includes the `*.processing` entries: a replay that the
 * hook exit cut off leaves its entry claimed for up to 10 minutes, and its
 * message is still not on the server. A file that is renamed between the scan
 * and the read is read under the other suffix. A file under neither name was
 * moved by a replay of another process (for example to a new retry number), so
 * the folder is scanned again, QUEUE_SCANS times at most. A file that cannot be
 * read or parsed is skipped, as listPending() does: the plugin never replays it,
 * so it must not stop the commits. A queue folder that cannot be read throws,
 * and the sweep then commits nothing in this run.
 */
async function queuedSessionIds() {
	const dir = pendingDir();
	for (let scan = 1; ; scan++) {
		let files;
		try { files = await readdir(dir); } catch (error) {
			if (error?.code === "ENOENT") return new Set();
			throw error;
		}
		const ids = new Set();
		let moved = false;
		for (const name of files) {
			let other;
			if (name.endsWith(".json")) other = `${name.slice(0, -".json".length)}.processing`;
			else if (name.endsWith(".processing")) other = `${name.slice(0, -".processing".length)}.json`;
			else continue;
			const entry = await readQueueEntry(dir, [name, other]);
			if (entry === "moved") moved = true;
			else if (entry?.sessionId) ids.add(entry.sessionId);
		}
		if (!moved || scan >= QUEUE_SCANS) return ids;
	}
}

/** After this many 404 answers to the commit of one batch, the batch is not due any more. */
export const COMMIT_MISS_LIMIT = 3;

/** True when a write failed because the session does not exist on the server. */
function isSessionMissing(res) {
	return res?.status === 404 || String(res?.error?.code || "").toUpperCase() === "NOT_FOUND";
}

/**
 * Commit each other agy conversation that has sent but uncommitted messages and
 * no activity for SWEEP_IDLE_MS. `committedStep` in the state file records the
 * commit, so each batch of messages is committed once. The current conversation
 * is never committed here. Stops at `deadline` (a Date.now() value). Never throws.
 *
 * Before the first commit the sweep replays the pending queue of the plugin: a
 * capture that ran while OpenViking was down queued its messages there, and a
 * commit before the replay would commit a session without them. A sweep whose
 * replay does not end before the deadline commits nothing, and a session with
 * writes still in the queue (also an entry that a replay has claimed) is not
 * committed. A batch whose commit answers 404 COMMIT_MISS_LIMIT times is not
 * tried again; a new batch is.
 */
export async function sweepIdleCommits(plugin, cfg, currentConversationId, { cwd, deadline, log = () => {} } = {}) {
	const result = { committed: [], failed: [], candidates: [] };
	// The sessions that still have queued writes after the replay, or null when
	// the replay did not end. It runs once, before the first commit.
	let stillQueued;
	const replayOnce = async () => {
		if (stillQueued !== undefined) return stillQueued;
		stillQueued = null;
		const wait = deadline - Date.now();
		if (wait <= 0) return stillQueued;
		const { fetchJSON } = plugin.makeAgentFetchJSON(cfg, cwd, { defaultTimeoutMs: wait, requireJsonBody: true });
		const work = (async () => {
			// consumeRetries false: the Stop hook runs often, and a replay that fails
			// while OpenViking is down must not use up the retries of SessionStart.
			const replay = plugin.replayPending
				? await plugin.replayPending(fetchJSON, log, { consumeRetries: false })
				: await plugin.replayAgentPending(fetchJSON, log);
			if (replay?.replayed || replay?.failed) log("pending-replay", replay);
			return await queuedSessionIds();
		})().catch((error) => {
			log("sweep-skip", { reason: "pending queue failed", error: String(error?.message || error) });
			return false;
		});
		stillQueued = await withDeadline(work, wait, null);
		if (stillQueued === null) log("sweep-skip", { reason: "pending replay did not end" });
		if (!stillQueued) stillQueued = null;
		return stillQueued;
	};
	try {
		const current = safeId(currentConversationId);
		const now = Date.now();
		let names;
		try { names = await readdir(stateDir()); } catch { return result; }
		for (const name of names) {
			if (Date.now() >= deadline) break;
			if (!name.endsWith(".json")) continue;
			const conversationId = name.slice(0, -".json".length);
			if (!conversationId || conversationId === current) continue;
			try {
				const due = (state) => {
					const sent = sentStepOf(state);
					if (sent === null || state.committedStep === sent) return null;
					const miss = state.commitMiss;
					if (miss?.step === sent && miss.n >= COMMIT_MISS_LIMIT) return null;
					return sent;
				};
				const first = await readState(conversationId);
				if (due(first) === null) continue;
				if (now - (await lastActivityMs(stateFile(conversationId), first)) < SWEEP_IDLE_MS) continue;
				const sessionId = ovSessionId(plugin, conversationId);
				result.candidates.push(sessionId);
				if (isDryRun()) continue;
				const queued = await replayOnce();
				if (!queued) break;
				// Its messages are still in the queue: a commit now would miss them.
				if (queued.has(sessionId)) continue;
				await withStateLock(conversationId, async () => {
					const state = await readState(conversationId);
					const sent = due(state);
					if (sent === null) return;
					const wait = deadline - Date.now();
					if (wait <= 0) return;
					const { fetchJSON } = plugin.makeAgentFetchJSON(cfg, state.cwd || cwd, { defaultTimeoutMs: wait, requireJsonBody: true });
					const res = await withDeadline(
						plugin.commitAgentSession(fetchJSON, sessionId, log, { keep_recent_count: 0 }), wait, null);
					// A commit past the deadline, or a retryable failure that could not be
					// queued for replay, stays due. A missing session (404: the messages
					// can still be on their way) stays due for COMMIT_MISS_LIMIT misses of
					// the same batch. Another failure that the plugin calls not retryable
					// is not tried again for this batch.
					if (!res || res.pendingEnqueueFailed) return;
					const { commitMiss, ...rest } = state;
					if (!res.ok && !res.pendingQueued && isSessionMissing(res)) {
						const n = commitMiss?.step === sent ? (Number(commitMiss.n) || 0) + 1 : 1;
						await writeState(conversationId, { ...rest, commitMiss: { step: sent, n } });
						if (n === COMMIT_MISS_LIMIT) log("sweep-give-up", { sessionId, step: sent, misses: n });
						result.failed.push(sessionId);
						return;
					}
					await writeState(conversationId, { ...rest, committedStep: sent });
					if (res.ok || res.pendingQueued) result.committed.push(sessionId);
					else result.failed.push(sessionId);
				}, 0);
			} catch (error) {
				log("sweep-error", { conversationId, error: String(error?.message || error) });
			}
		}
	} catch (error) {
		log("sweep-error", { error: String(error?.message || error) });
	}
	if (isDryRun()) dryReport("sweep", result);
	else if (result.candidates.length) log("sweep", result);
	return result;
}
