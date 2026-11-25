// The stores of the chain. Each store returns `{status: "ready", hits}` or `{status: "omitted", reason}`.
// A hit carries `source`, `text`, `score` and either `project` (a key of the current project) or
// `globalId` (an exact identifier for the owner list). The core enforces the scope again.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildOvHeaders } from "../../openviking-pi/shared/ov-http.mjs";

export const HERMES_DELIMITER = "\n§\n";
const WIKI_DIRS = [".llm-wiki", ".wiki"];
const MAX_WIKI_FILES = 300;
export const MAX_FILE_BYTES = 128 * 1024;
const MAX_HITS_PER_STORE = 8;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "what", "how", "does", "from", "are", "was", "you", "not"]);

export function terms(text) {
	const found = String(text || "").toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
	return [...new Set(found.filter((term) => !STOP.has(term)))];
}

/** The share of query terms that occur in `text`, 0 to 1. */
export function overlap(queryTerms, text) {
	if (!queryTerms.length) return 0;
	const own = new Set(terms(text));
	return queryTerms.filter((term) => own.has(term)).length / queryTerms.length;
}

function best(hits) {
	return hits.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_HITS_PER_STORE);
}

/** The project key of an OpenViking peer. */
export function ovProjectKey(peer) {
	return `openviking-peer:${peer}`;
}

/** The peer of an OpenViking URI under `viking://user/<user>/peers/<peer>/`, or "" for a URI outside any peer. */
export function peerOfUri(uri) {
	const match = /^viking:\/\/user\/[^/]+\/peers\/([^/]+)\//.exec(String(uri || ""));
	return match ? match[1] : "";
}

/** The `score_threshold` of the live recall (`recall-core.mjs`, `buildContextSearchBody`). */
export function scoreThreshold(cfg) {
	return Number.isFinite(Number(cfg?.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35;
}

/**
 * OpenViking for the current project only: `peer_scope: "actor"` and the project peer in the actor
 * header, then the legacy peer of the same project as the live recall asks it. A refused scope skips
 * the store; the chain never retries without the scope. An explicit peer is account-wide, so the
 * store is left out and sends no request. The body has no `session_id`: with it the server starts a
 * query expansion with a 5 s limit, which does not fit the 2 s clock.
 * @param {{cfg: object|null, peers: {explicit: string, peer: string, legacy: string}, extraHeaders?: object, fetchImpl?: typeof fetch}} input
 */
export function openvikingStore({ cfg, peers, extraHeaders = {}, fetchImpl = fetch }) {
	return {
		name: "openviking",
		async search({ query, signal }) {
			if (!cfg?.baseUrl) return { status: "omitted", reason: "not configured" };
			if (peers?.explicit) return { status: "omitted", reason: "account-wide peer" };
			if (!peers?.peer) return { status: "omitted", reason: "no project scope" };
			const body = JSON.stringify({ query, mode: "context", purpose: "coding", score_threshold: scoreThreshold(cfg),
				peer_scope: "actor", query_expansion: "off" });
			const asked = [...new Set([peers.peer, peers.legacy].filter(Boolean))];
			const responses = await Promise.all(asked.map((peer) => fetchImpl(`${cfg.baseUrl}/api/v1/search/search`, {
				method: "POST", headers: buildOvHeaders(cfg, { actorPeerId: peer, extraHeaders }), body, signal,
			})));
			if (responses.some((response) => response.status === 400 || response.status === 422)) {
				return { status: "omitted", reason: "scope refused" };
			}
			if (responses.some((response) => !response.ok)) throw new Error("openviking request failed");
			const hits = [];
			for (const response of responses) {
				const reply = await response.json();
				const entries = Array.isArray(reply?.result?.entries) ? reply.result.entries : [];
				for (const entry of entries) {
					const uri = String(entry?.uri || "").trim();
					if (!uri) continue;
					const entryPeer = peerOfUri(uri);
					hits.push({
						source: uri,
						text: String(entry.text || entry.content || entry.summary || entry.abstract || "").trim(),
						score: Number(entry.score) || 0,
						// The project comes from the URI, not from the peer that was asked.
						project: entryPeer ? ovProjectKey(entryPeer) : "",
						globalId: entryPeer ? "" : uri,
					});
				}
			}
			return { status: "ready", hits };
		},
	};
}

/** The project key of a folder on disk. */
export function fsProjectKey(root) {
	return `project-root:${resolve(root)}`;
}

export const TOO_LARGE = "file over 128 KB";
export const BIG = Symbol("too large");

/** The text of a small file; null for a missing file or a link; BIG for a file over MAX_FILE_BYTES. */
export async function readSmall(path) {
	const info = await lstat(path).catch(() => null);
	if (!info || !info.isFile()) return null;
	if (info.size > MAX_FILE_BYTES) return BIG;
	return readFile(path, "utf8").catch(() => null);
}

/** The Hermes facts of the current project: `<agent dir>/projects-memory/<name>/MEMORY.md`. */
export function hermesProjectStore({ agentDir, projectName, root }) {
	return {
		name: "hermes-project",
		async search({ query }) {
			if (!projectName || !root) return { status: "omitted", reason: "no project scope" };
			const raw = await readSmall(join(agentDir, "projects-memory", projectName, "MEMORY.md"));
			if (raw === BIG) return { status: "omitted", reason: TOO_LARGE };
			if (raw === null) return { status: "ready", hits: [] };
			const queryTerms = terms(query);
			const entries = raw.split(HERMES_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
			return { status: "ready", hits: best(entries.map((text, index) => ({
				source: `hermes-project:${projectName}/MEMORY.md#${index + 1}`,
				text, score: overlap(queryTerms, text), project: fsProjectKey(root),
			}))) };
		},
	};
}

/** The identifier of one Hermes global entry, for the owner list. */
export function hermesGlobalId(text) {
	return `hermes-global:${createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)}`;
}

/** The Hermes global facts, but only the entries whose identifier is in the owner list. */
export function hermesGlobalStore({ agentDir, approved }) {
	return {
		name: "hermes-global",
		async search({ query }) {
			const raw = await readSmall(join(agentDir, "pi-hermes-memory", "MEMORY.md"));
			if (raw === BIG) return { status: "omitted", reason: TOO_LARGE };
			if (raw === null) return { status: "ready", hits: [] };
			const queryTerms = terms(query);
			const hits = [];
			for (const text of raw.split(HERMES_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
				const id = hermesGlobalId(text);
				if (!approved.has(id)) continue;
				hits.push({ source: id, text, score: overlap(queryTerms, text), globalId: id });
			}
			return { status: "ready", hits: best(hits) };
		},
	};
}

async function markdownFiles(dir, out, depth = 0) {
	if (depth > 4 || out.length >= MAX_WIKI_FILES) return;
	const names = await readdir(dir).catch(() => []);
	for (const name of names.sort()) {
		if (out.length >= MAX_WIKI_FILES) return;
		if (name.startsWith(".")) continue;
		const path = join(dir, name);
		// lstat: a symbolic link can point out of the project, so it is never followed.
		const info = await lstat(path).catch(() => null);
		if (!info) continue;
		if (info.isDirectory()) await markdownFiles(path, out, depth + 1);
		else if (info.isFile() && name.endsWith(".md")) out.push(path);
	}
}

/**
 * The wiki of the current project: `<root>/.llm-wiki/` or `<root>/.wiki/`. Never the personal vault:
 * a root that is the home folder has no project wiki.
 */
export function wikiStore({ root, home = homedir() }) {
	return {
		name: "project-wiki",
		async search({ query }) {
			if (!root || resolve(root) === resolve(home)) return { status: "omitted", reason: "no project scope" };
			let dir = "";
			for (const name of WIKI_DIRS) {
				const info = await lstat(join(root, name)).catch(() => null);
				if (info?.isDirectory()) { dir = join(root, name); break; }
			}
			if (!dir) return { status: "ready", hits: [] };
			const files = [];
			await markdownFiles(dir, files);
			const queryTerms = terms(query);
			const hits = [];
			let tooLarge = 0;
			for (const path of files) {
				const raw = await readSmall(path);
				if (raw === BIG) tooLarge += 1;
				if (raw === null || raw === BIG) continue;
				const source = relative(root, path);
				for (const paragraph of raw.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
					hits.push({ source, text: paragraph, score: overlap(queryTerms, paragraph), project: fsProjectKey(root) });
				}
			}
			const found = best(hits);
			// A page over the limit with no other hit is an omission, not an empty wiki.
			if (!found.length && tooLarge) return { status: "omitted", reason: TOO_LARGE };
			return { status: "ready", hits: found };
		},
	};
}
