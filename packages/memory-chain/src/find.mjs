// The on-demand memory search of the Pi tool `memory_find`: OpenViking and Hermes through their native
// tools, the personal wiki through the package's own reader (`readWiki`), all in parallel; their hits
// merged, one decider ranking, one fitted result.
// Plain ESM with no import of Pi. `call(name, args, signal)` runs one store tool; only the three literal names
// of STORE_CALLS reach it, never a name from data. `wiki_recall` runs only as the fallback of the reader.
import { stripPrivacyTokens } from "./decider-rank.mjs";

// The store tools, as literals, in store order. The wiki entry is the fallback of `readWiki`.
const STORE_CALLS = [
	{ store: "openviking", tool: "openviking_find", args: (query) => ({ query, limit: 8, context_type: ["memory"] }) },
	{ store: "wiki", tool: "wiki_recall", args: (query) => ({ query, max_results: 5 }) },
	{ store: "hermes", tool: "memory_search", args: (query) => ({ query, limit: 8 }) },
];
/** The names of the three store tools, in store order. */
export const STORE_TOOLS = Object.freeze(STORE_CALLS.map((item) => item.tool));

// A store string is cut before parsing: 6,000 characters hold 8 OpenViking hits; longer results reach 51,000.
export const MAX_STORE_CHARS = 6000;
// The start of an OpenViking hit record. Its cut ends before the last record that starts inside the limit.
const OV_HEADER = /^- \[\w+ \d+%\] viking:\/\//gm;
// Output limits: a title, an id that is still a useful lookup target, the text sent to the ranker, the whole result.
export const MAX_TITLE = 120;
export const MAX_ID = 300;
const MAX_RANK_TEXT = 200;
export const MAX_RESULT = 3000;
// The deadline of each store call.
export const STORE_TIMEOUT_MS = 15000;
// The wiki reader stops reading new pages at this time and keeps the pages that it scored (the store is
// then `partial`). The store deadline still ends a reader that does not return.
export const WIKI_READ_MS = 3000;
// An explicit empty reply: the store is available and has no hit. "Found N ..." claims N hits.
const EMPTY = /^(No matching context found|No memories |No wiki pages found)/;
const FOUND = /^Found (\d+) /;

function hash(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h.toString(16).padStart(8, "0");
}

/** OpenViking: "- [memory 85%] viking://...\n    text" for each hit. */
export function parseOpenViking(t, out) {
	const raw = [];
	let hit = null;
	for (const line of t.split("\n")) {
		const m = /^- \[(\w+) \d+%\] (viking:\/\/\S+)\s*$/.exec(line);
		if (m) {
			hit = { id: m[2], lines: [] };
			raw.push(hit);
		} else if (hit) hit.lines.push(line.trim());
	}
	for (const h of raw) {
		const parts = h.id.replace(/\/+$/, "").split("/");
		const last = parts[parts.length - 1] || h.id;
		const name = last.startsWith(".") ? `${parts[parts.length - 2]}/${last}` : last.replace(/\.md$/, "");
		out.push({ src: "openviking", id: h.id, title: name, text: h.lines.filter(Boolean).join(" ") });
	}
}

/**
 * LLM Wiki: links form "1. [[id]] — title (type, score s)\n   Path: ... — snippet",
 * or preview form "## [[id]] — title\nType: ...\nPath: ...\n\npreview" with "---" between pages.
 */
export function parseWiki(t, out) {
	const links = /^\d+\. \[\[([^\]]+)\]\] — (.*?) \([^()]*, score [\d.]+\)[^\n]*\n[ \t]+Path: [^\n]*?(?: — ([^\n]*))?$/gm;
	for (let m = links.exec(t); m; m = links.exec(t)) out.push({ src: "wiki", id: `wiki:${m[1]}`, title: m[2], text: m[3] || "" });
	if (out.length) return;
	for (const page of t.split(/\n\n---\n\n/)) {
		const m = /^(?:[^\n]*\n\n)?## \[\[([^\]]+)\]\] — ([^\n]*)\nType: [^\n]*\nPath: [^\n]*\n\n([\s\S]*)$/.exec(page);
		if (m) out.push({ src: "wiki", id: `wiki:${m[1]}`, title: m[2], text: m[3].replace(/\s+/g, " ") });
	}
}

/** Hermes: "🧠 scope=global [target=memory] [category] content\n   Created: ... | Last used: ...". */
export function parseHermes(t, out) {
	const raw = [];
	let hit = null;
	for (const line of t.split("\n")) {
		const m = /^\S+ scope=(\S+) \[target=[^\]]+\](?: \[[^\]]+\])* (.*)$/.exec(line);
		if (m) {
			hit = { scope: m[1], lines: [m[2]] };
			raw.push(hit);
		} else if (/^\s+Created: /.test(line)) hit = null;
		else if (hit) hit.lines.push(line);
	}
	for (const h of raw) {
		const text = h.lines.join(" ").replace(/\s+/g, " ").trim();
		out.push({ src: "hermes", id: `hermes:${hash(text)}`, title: `${h.scope}: ${text.slice(0, 60)}`, text });
	}
}

const PARSERS = { openviking: parseOpenViking, wiki: parseWiki, hermes: parseHermes };

/**
 * The text that is parsed, and whether it was cut. A long OpenViking string ends before the last hit header that
 * starts inside the limit, so no half record is parsed; one record longer than the limit stays when its header line is whole.
 */
export function boundStoreText(t, store) {
	if (t.length <= MAX_STORE_CHARS) return { text: t, cut: false };
	const head = t.slice(0, MAX_STORE_CHARS);
	if (store !== "openviking") return { text: head, cut: true };
	const starts = [...head.matchAll(OV_HEADER)].map((m) => m.index);
	if (starts.length === 1 && head.indexOf("\n", starts[0]) >= 0) return { text: head, cut: true };
	return { text: head.slice(0, starts.length ? starts[starts.length - 1] : 0), cut: true };
}

/**
 * The hits of one store reply, whether its string was cut, and whether the store is available (`ok`).
 * Not available: an error, a non-string, an unknown form, a reply that claims hits of which none parse,
 * or a parser throw. The hits that parsed before a parser throw stay. `cut` is apart from `ok`.
 */
export function readStore(store, reply) {
	const t = typeof reply === "string" ? reply.trim() : null;
	if (t !== null && EMPTY.test(t)) return { hits: [], cut: false, ok: true };
	const found = t === null ? null : FOUND.exec(t);
	if (!found) return { hits: [], cut: false, ok: false };
	if (Number(found[1]) === 0) return { hits: [], cut: false, ok: true };
	const { text, cut } = boundStoreText(t, store);
	const hits = [];
	try {
		PARSERS[store](text, hits);
	} catch {
		return { hits, cut, ok: false };
	}
	return { hits, cut, ok: hits.length > 0 };
}

/**
 * One store call with its own deadline. Its signal aborts at the deadline or when the caller's signal aborts,
 * and the wait ends then too, also when the store ignores the abort.
 */
function callWithDeadline(call, name, args, signal, ms) {
	const controller = new AbortController();
	let timer;
	let onAbort;
	const stop = new Promise((_resolve, reject) => {
		const end = (reason) => {
			controller.abort(reason);
			reject(reason);
		};
		timer = setTimeout(() => end(new Error("store deadline")), ms);
		onAbort = () => end(signal.reason ?? new Error("aborted"));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener?.("abort", onAbort, { once: true });
	});
	const run = Promise.resolve().then(() => call(name, args, controller.signal));
	return Promise.race([run, stop]).finally(() => {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	});
}

// The reasons of an `omitted` reply of `personalWikiStore` (literals, so this module loads without the reader):
// no vault or a root that cannot be listed runs the fallback; only pages over the size limit stays local.
const READER_OFF = "not available";
const READER_TOO_LARGE = "file over 128 KB";
const isText = (value) => typeof value === "string";

/**
 * The hits of a reader reply, `cut` for a part (read stopped at its limit, or `unread` pages), or null when the
 * vault cannot be used: an `omitted` reply of READER_OFF, or a reply of a bad form (a status other than
 * ready or omitted, no hit array, a hit that is not an object with string `source`, `title` and `text`).
 */
function readerHits(reply, stopped) {
	if (reply?.status === "omitted") return reply.reason === READER_TOO_LARGE ? { hits: [], cut: false, ok: true } : null;
	if (reply?.status !== "ready" || !Array.isArray(reply.hits)) return null;
	if (!reply.hits.every((h) => h && typeof h === "object" && isText(h.source) && isText(h.title) && isText(h.text))) return null;
	const hits = reply.hits.map((h) => ({ src: "wiki", id: h.source, title: h.title, text: h.text }));
	return { hits, cut: stopped || Number(reply.unread) > 0, ok: true };
}

/**
 * The wiki store: the reader `readWiki(query, signal)` (the reply form of `personalWikiStore`), with the
 * reader limit `wikiReadMs` on its signal. A hit id is the page path in the `~/` form. The reader and its
 * fallback share one store deadline. The fallback `wiki_recall` runs through `call` only when the vault
 * cannot be used: the reader throws before the deadline, or `readerHits` gives null. A readable vault with no
 * hit, a partial read, or pages that the reader refuses (too large, a link, an unsafe name) stays local:
 * `wiki_recall` can search another scope or send the query to a remote embedder. A reader that misses the
 * deadline, or a deadline that ends before the fallback, makes the store unavailable.
 */
async function wikiStore({ query, call, readWiki, signal, storeTimeoutMs, wikiReadMs }) {
	const deadline = Date.now() + storeTimeoutMs;
	let stop;
	let late = false;
	let reply;
	let threw = false;
	try {
		reply = await callWithDeadline((_name, _args, callSignal) => {
			stop = AbortSignal.any([callSignal, AbortSignal.timeout(wikiReadMs)]);
			return readWiki(query, stop);
		}, "wiki", null, signal, storeTimeoutMs);
	} catch (error) {
		threw = true;
		late = error?.message === "store deadline" || signal?.aborted === true;
	}
	if (late) return { hits: [], cut: false, ok: false };
	const local = threw ? null : readerHits(reply, stop?.aborted === true);
	if (local) return local;
	const left = deadline - Date.now();
	if (left <= 0) return { hits: [], cut: false, ok: false };
	const fallback = STORE_CALLS.find((item) => item.store === "wiki");
	const text = await callWithDeadline(call, fallback.tool, fallback.args(query), signal, left).catch(() => null);
	return readStore("wiki", text);
}

/**
 * One list: the hits of the stores in turn (the first of each store, then the second, ...), each with a local key `c<n>`.
 * A hit whose id is too long to be a useful lookup target is left out; an id is never cut.
 */
export function mergeHits(lists) {
	const seen = new Set();
	const hits = [];
	for (let i = 0; lists.some((l) => i < l.length); i += 1) {
		for (const l of lists) {
			const h = l[i];
			if (!h || typeof h.id !== "string" || h.id.length > MAX_ID || seen.has(h.id)) continue;
			seen.add(h.id);
			hits.push({ key: `c${hits.length + 1}`, src: h.src, id: h.id, title: stripPrivacyTokens(h.title).slice(0, MAX_TITLE), text: stripPrivacyTokens(h.text) });
		}
	}
	return hits;
}

const rankText = (h) => (h.src === "hermes" ? h.text : `${h.title}: ${h.text}`).replace(/\s+/g, " ").slice(0, MAX_RANK_TEXT);

/**
 * The ranked keys from a ranker reply. The reply is data: only entries with a known local key count, each once.
 * No usable entry, or a fallback reply: the first 3 hits of the merged list, and `fallback` is true.
 * `order` holds the known keys of `reply.order` (the decider order of all hits), each once; empty on a fallback.
 */
export function readRanking(reply, hits) {
	const known = new Set(hits.map((h) => h.key));
	const ranked = [];
	const used = new Set();
	for (const r of Array.isArray(reply?.ranked) ? reply.ranked : []) {
		if (!r || typeof r !== "object" || typeof r.id !== "string" || !known.has(r.id) || used.has(r.id)) continue;
		used.add(r.id);
		ranked.push({ key: r.id, p: typeof r.p === "number" && Number.isFinite(r.p) ? r.p : null });
	}
	if (!ranked.length) return { ranked: hits.slice(0, 3).map((h) => ({ key: h.key, p: null })), fallback: true, order: [] };
	const fallback = reply.fallback === true;
	const order = fallback || !Array.isArray(reply.order) ? [] : [...new Set(reply.order.filter((key) => typeof key === "string" && known.has(key)))];
	return { ranked, fallback, order };
}

/**
 * The result object under MAX_RESULT characters as JSON: the pointers go first, then the excerpts get shorter,
 * then the last excerpt goes. It changes `result` in place and returns it.
 */
export function fitResult(result) {
	const size = () => JSON.stringify(result).length;
	while (size() > MAX_RESULT && result.pointers.length) result.pointers.pop();
	for (let cut = 240; size() > MAX_RESULT && cut >= 60; cut -= 60) for (const e of result.excerpts) e.text = e.text.slice(0, cut);
	while (size() > MAX_RESULT && result.excerpts.length) result.excerpts.pop();
	return result;
}

/**
 * Search the three stores for one question and rank the hits.
 * `call(name, args, signal)` returns the text of a store tool or throws. Each call has `storeTimeoutMs`
 * (default 15 s); a store that has not answered then is unavailable. `readWiki(query, signal)` reads the
 * personal wiki (see `wikiStore`); with no `readWiki`, the wiki store is the tool `wiki_recall`.
 * `rank(query, candidates, { signal })` is `rankWithDecider` or a fake; it gets the local keys `c1` ... and
 * at most 200 characters of cleaned text of each hit.
 * Returns `{ excerpts, pointers, unavailable, partial, fallback }`. It throws for no error of a store or of the ranker.
 */
export async function findMemories({ query, call, rank, signal, readWiki, storeTimeoutMs = STORE_TIMEOUT_MS, wikiReadMs = WIKI_READ_MS }) {
	const settled = await Promise.allSettled(STORE_CALLS.map((item) => (item.store === "wiki" && readWiki
		? wikiStore({ query, call, readWiki, signal, storeTimeoutMs, wikiReadMs })
		: callWithDeadline(call, item.tool, item.args(query), signal, storeTimeoutMs).then((reply) => readStore(item.store, reply)))));
	const unavailable = [];
	// The stores whose hits are only a part: a cut string, or a wiki read stopped at its limit. A cut store can be unavailable too.
	const partial = [];
	const lists = STORE_CALLS.map((item, i) => {
		const read = settled[i].status === "fulfilled" ? settled[i].value : readStore(item.store, null);
		if (!read.ok) unavailable.push(item.store);
		if (read.cut) partial.push(item.store);
		return read.hits;
	});
	const hits = mergeHits(lists);
	const byKey = new Map(hits.map((h) => [h.key, h]));
	let ranking = { ranked: [], fallback: true };
	if (hits.length) {
		let reply = null;
		try {
			reply = await rank(stripPrivacyTokens(query), hits.map((h) => ({ id: h.key, text: rankText(h) })), { signal });
		} catch {
			reply = null;
		}
		ranking = readRanking(reply, hits);
	}
	const kept = ranking.ranked.slice(0, 4);
	const keptKeys = new Set(kept.map((r) => r.key));
	// A ranked answer orders the pointers too (the next hits by the decider); a fallback keeps the merged order.
	const place = new Map((ranking.order ?? []).map((key, index) => [key, index]));
	const byPlace = (a, b) => (place.get(a.key) ?? place.size) - (place.get(b.key) ?? place.size);
	return fitResult({
		excerpts: kept.map((r) => {
			const h = byKey.get(r.key);
			return { store: h.src, id: h.id, title: h.title, p: r.p, text: h.text.slice(0, 300) };
		}),
		pointers: hits.filter((h) => !keptKeys.has(h.key)).sort(byPlace).slice(0, 6).map((h) => ({ store: h.src, id: h.id, title: h.title.slice(0, 80) })),
		unavailable,
		partial,
		fallback: ranking.fallback,
	});
}
