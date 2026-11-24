// The shadow run of the chain for one prompt: the switch, the eligibility rules, the store set of the
// harness, and the record line (`record.mjs`). `runPrompt` is the one run that the shadow run and the
// replay share. A shadow run never changes the prompt: the callers drop the block.
// The entries load this module only after the switch says `shadow` (see `switch.mjs`).
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { applyInputFilters, compileInputFilters } from "../../openviking-pi/shared/input-filters.mjs";
import { parseExtraHeaders } from "../../openviking-pi/shared/mcp-proxy-config.mjs";
import { buildPluginConfig } from "../../openviking-pi/shared/plugin-config.mjs";
import { isBypassed } from "../../openviking-pi/shared/session-model.mjs";
import { resolveWorkspaceIdentity } from "../../openviking-pi/shared/workspace-identity.mjs";
import { resolveEffectivePeerId } from "../../openviking-pi/shared/workspace-peer.mjs";
import { realClock, runChain, testRanker } from "./core.mjs";
import { writeShadowRecord } from "./record.mjs";
import { fsProjectKey, hermesGlobalStore, hermesProjectStore, openvikingStore, ovProjectKey, wikiStore } from "./stores.mjs";
import { configDir, home, readJson, readMode, stateDir } from "./switch.mjs";

export { configDir, readMode, stateDir, writeShadowRecord };

/** Stores that no harness may read, with the reason named in the omission line. */
export const FIXED_OMISSIONS = Object.freeze([{ store: "openknowledge", reason: "no scoped read path" }]);
/** The OpenViking harness key of each harness, for the bypass rules and the connection. */
export const OV_HARNESS = Object.freeze({ pi: "pi", "claude-code": "claude_code" });

/** The owner list of exact global fact identifiers. No file means none. */
export function readApproved(env = process.env) {
	const value = readJson(join(configDir(env), "approved-facts.json"));
	const list = Array.isArray(value) ? value : Array.isArray(value?.facts) ? value.facts : [];
	return new Set(list.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()));
}

/** The record of one run. Never a prompt, a memory text, a source address or a digest. */
export function shadowRecord(harness, result, now) {
	return {
		v: 1,
		at: new Date(now).toISOString(),
		harness,
		kind: result.kind,
		totalMs: result.totalMs,
		storeDeadlineMs: result.storeDeadlineMs,
		steps: result.steps,
		omitted: result.omitted.map((item) => ({ store: item.store, reason: item.reason })),
		chars: result.chars,
		selected: result.selected.map((item) => ({ id: item.id, score: item.score, length: item.length })),
	};
}

function findGitRoot(cwd) {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return "";
		dir = parent;
	}
}

/** The project of `cwd`: its root folder, or none for the home folder and the file system root. */
export function projectOf(cwd, env = process.env) {
	const dir = resolve(cwd);
	if (dir === resolve(home(env)) || dir === "/") return { root: "", name: "" };
	const root = findGitRoot(dir) || dir;
	if (root === resolve(home(env))) return { root: "", name: "" };
	return { root, name: basename(root) };
}

/**
 * The peers of the current project, as `workspace-peer.mjs` derives them.
 * - `explicit`: a peer that `OPENVIKING_PEER_ID`, `actor_peer_id` or `peerId` names. It is account-wide,
 *   not a project, so the OpenViking store is left out when it is set.
 * - `peer`: the project peer (the git remote, else the git root).
 * - `legacy`: the path-derived peer of `cwd` that sessions used before the git rule, when it differs.
 *   The live recall asks it too (`recall-core.mjs`, `buildRecallBlockDetailed`), so it counts as the project.
 */
export function projectPeers(cfg, cwd, env) {
	const explicit = String(cfg?.peerId || "").trim();
	const identity = resolveWorkspaceIdentity({ cwd, env, cache: false });
	const resolved = resolveEffectivePeerId({ cfg: { ...cfg, peerId: "" }, cwd, identity, env, onWarn: () => {} });
	const peer = resolved.peerId || "";
	const legacy = peer && resolved.legacyPeerId && resolved.legacyPeerId !== peer ? resolved.legacyPeerId : "";
	return { explicit, peer, legacy };
}

/** The project peer alone (see `projectPeers`). */
export function projectPeer(cfg, cwd, env) {
	return projectPeers(cfg, cwd, env).peer;
}

/**
 * The rules that make a prompt eligible. Returns `{query}`, or `{query: "", reason}` for a skipped prompt.
 * `cfg` is the OpenViking plugin config of the harness, or null.
 */
export function eligibility({ prompt, cwd, sessionId, env, cfg }) {
	if (env.OPENVIKING_RECALL_COMPRESS === "off") return { query: "", reason: "task session" }; // spawn.py
	if (typeof prompt !== "string" || !prompt.trim()) return { query: "", reason: "empty prompt" };
	if (cfg && isBypassed(cfg, { sessionId, cwd })) return { query: "", reason: "bypassed session" };
	const filtered = applyInputFilters(prompt, compileInputFilters(cfg?.recallQueryFilters).rules, { role: "user" });
	if (filtered.dropped) return { query: "", reason: "dropped by a query filter" };
	if (filtered.text.length < Number(cfg?.minQueryLength || 3)) return { query: "", reason: "under the minimum length" };
	return { query: filtered.text };
}

/** The query of an eligible prompt, or "" for a skipped prompt (see `eligibility`). */
export function eligibleQuery(input) {
	return eligibility(input).query;
}

/** The OpenViking plugin config of the harness for `cwd`, or null when it does not load. */
export function loadOvConfig(harness, cwd, env) {
	try {
		return buildPluginConfig(OV_HARNESS[harness], { cwd, env });
	} catch {
		return null;
	}
}

/**
 * Run the chain once for a prompt, in shadow. Returns `{ran: false}` for off and for a skipped
 * prompt; else `{ran: true, result}`. The caller never puts `result.block` into the prompt.
 * @param {{harness: "pi"|"claude-code", prompt: unknown, cwd: string, sessionId?: string,
 *   env?: Record<string, string|undefined>, clock?: object, startedAt?: number, fetchImpl?: typeof fetch,
 *   rank?: Function, record?: boolean}} input
 */
export async function runShadow(input) {
	const env = input.env ?? process.env;
	const clock = input.clock ?? realClock;
	const startedAt = input.startedAt ?? clock.now();
	if (readMode(env) !== "shadow") return { ran: false };
	const { ran, result } = await runPrompt({ ...input, env, clock, startedAt });
	return ran ? { ran, result } : { ran: false };
}

/**
 * One run of the chain for one prompt, without the switch: the prompt rules, the store set of the
 * harness and the project scope, the chain and the record line. The shadow run and the replay both
 * call it, so they cannot drift apart. `record: false` writes no record line.
 * Returns `{ran: false, reason}` for a skipped prompt; else `{ran: true, query, cfg, result}`.
 * `cfg` is the OpenViking plugin config of the harness, or null; it holds the connection.
 * @param {{harness: "pi"|"claude-code", prompt: unknown, cwd: string, sessionId?: string,
 *   env?: Record<string, string|undefined>, clock?: object, startedAt?: number, fetchImpl?: typeof fetch,
 *   rank?: Function, record?: boolean}} input
 */
export async function runPrompt(input) {
	const env = input.env ?? process.env;
	const clock = input.clock ?? realClock;
	const startedAt = input.startedAt ?? clock.now();
	const cwd = input.cwd || process.cwd();
	const cfg = loadOvConfig(input.harness, cwd, env);
	const { query, reason } = eligibility({ prompt: input.prompt, cwd, sessionId: input.sessionId, env, cfg });
	if (!query) return { ran: false, reason };

	const approved = readApproved(env);
	const peers = cfg ? projectPeers(cfg, cwd, env) : { explicit: "", peer: "", legacy: "" };
	const projects = new Set();
	if (!peers.explicit) for (const peer of [peers.peer, peers.legacy]) if (peer) projects.add(ovProjectKey(peer));
	const extraHeaders = parseExtraHeaders(env.OPENVIKING_EXTRA_HEADERS, { onWarn: () => {} });
	const stores = [openvikingStore({ cfg, peers, extraHeaders, fetchImpl: input.fetchImpl })];
	if (input.harness === "pi") {
		// Pi private stores. Claude Code gets none of them.
		const project = projectOf(cwd, env);
		const agentDir = resolve(env.PI_CODING_AGENT_DIR || join(home(env), ".pi", "agent"));
		if (project.root) projects.add(fsProjectKey(project.root));
		stores.push(hermesProjectStore({ agentDir, projectName: project.name, root: project.root }));
		stores.push(wikiStore({ root: project.root, home: home(env) }));
		if ([...approved].some((id) => id.startsWith("hermes-global:"))) stores.push(hermesGlobalStore({ agentDir, approved }));
	}
	const result = await runChain({
		query, stores, projects, approved, fixedOmissions: FIXED_OMISSIONS,
		rank: input.rank ?? testRanker, clock, startedAt,
	});
	if (input.record !== false) {
		try {
			writeShadowRecord(shadowRecord(input.harness, result, clock.now()), { env, now: clock.now() });
		} catch { /* a record failure never touches the prompt */ }
	}
	return { ran: true, query, cfg, result };
}
