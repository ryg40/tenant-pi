// The on-demand search: one run that a person or an agent starts on request (`scripts/search.mjs`).
// It reuses `runChain` of `core.mjs` (the clock, the parallel stores, the late drop, the merge) with
// `scope: "on-demand"`, so the scope rule of the automatic run does not apply here. The ranker slot
// holds a decider ranker that never throws: on a fallback it keeps the first 3 hits of the merged list.
// The block of the automatic run is not used; this module builds its own, smaller block.
import { parseExtraHeaders } from "../../openviking-pi/shared/mcp-proxy-config.mjs";
import { BUDGET_MS, realClock, runChain } from "./core.mjs";
import { RANK_LIMITS, deciderLimits, rankWithDecider, stripPrivacyTokens } from "./decider-rank.mjs";
import { loadOvConfig } from "./shadow.mjs";
import { hermesDbStore, hermesFactsStore, openvikingAllStore, personalWikiStore, resolveAgentDir } from "./stores-ondemand.mjs";

export const SEARCH_LIMITS = Object.freeze({ maxChars: 1600, excerpts: 4, excerptChars: 300, pointers: 6, minExcerptChars: 80,
	titleChars: 120, idChars: 300, reasonChars: 40 });
/** The word printed in place of an id that is too long to print whole: an id is never cut. */
export const ID_TOO_LONG = "(id too long)";

/** The on-demand store set, in the order of the merged list. */
export function onDemandStores({ env = process.env, cwd = process.cwd(), agentDir, personalWiki = true, fetchImpl } = {}) {
	const cfg = loadOvConfig("claude-code", cwd, env);
	const extraHeaders = parseExtraHeaders(env.OPENVIKING_EXTRA_HEADERS, { onWarn: () => {} });
	const stores = [openvikingAllStore({ cfg, extraHeaders, fetchImpl })];
	if (personalWiki) stores.push(personalWikiStore({ env }));
	stores.push(hermesFactsStore({ agentDir }), hermesDbStore({ agentDir }));
	return stores;
}

/** The candidates in turn: the first hit of each store in store order, then the second, and so on. */
function inTurn(candidates, order) {
	const lists = order.map((name) => candidates.filter((candidate) => candidate.store === name));
	const out = [];
	for (let index = 0; lists.some((list) => index < list.length); index += 1) {
		for (const list of lists) if (list[index]) out.push(list[index]);
	}
	return out;
}

/**
 * Remove a hit whose whole text equals an earlier one (a Hermes fact sits in MEMORY.md and in sessions.db).
 * The key is the full text that the reader kept (at most 600 characters), not the 200 that go to the decider.
 */
function uniqueByText(candidates) {
	const seen = new Set();
	return candidates.filter((candidate) => {
		const key = candidate.text.replace(/\s+/g, " ").trim().toLowerCase();
		if (!key || seen.has(key)) return !key;
		seen.add(key);
		return true;
	});
}

/** The text that goes to the decider. A Hermes title is a cut of its text, so Hermes sends the text only. */
function deciderText(candidate) {
	return candidate.title && !candidate.store.startsWith("hermes") ? `${candidate.title}: ${candidate.text}` : candidate.text;
}

/**
 * Run the on-demand search once. Returns `{ excerpts, pointers, unavailable, fallback, reason, stats }`.
 * It never throws for a store or a decider failure.
 * @param {{query: string, env?: object, cwd?: string, agentDir?: string, personalWiki?: boolean,
 *   stores?: object[], fetchImpl?: typeof fetch, decider?: object, clock?: object}} input
 */
export async function runSearch(input) {
	const env = input.env ?? process.env;
	const clock = input.clock ?? realClock;
	const startedAt = clock.now();
	const agentDir = input.agentDir ?? resolveAgentDir({ env });
	const stores = (input.stores ?? onDemandStores({ env, cwd: input.cwd, agentDir, personalWiki: input.personalWiki !== false, fetchImpl: input.fetchImpl }))
		.map((store) => measured(store));
	const order = stores.map((store) => store.name);
	const decider = input.decider ?? {};
	// The same limits as the calls: a caller value can only shorten them. The default reserve is 900 ms.
	const { healthTimeoutMs, questionTimeoutMs, reserveMs } = deciderLimits(decider);
	const seen = { list: null, answer: null };
	const rank = async (candidates, { signal } = {}) => {
		seen.list = uniqueByText(inTurn(candidates, order));
		// All candidates go to the decider (4 stores x 8), so a hit that a store ranks late still reaches it.
		seen.answer = await rankWithDecider(input.query, seen.list.map((candidate) => ({ id: candidate.id, text: deciderText(candidate) })),
			{ env, ...decider, healthTimeoutMs, questionTimeoutMs, maxCandidates: RANK_LIMITS.maxOnDemandCandidates, signal });
		return seen.answer.ranked.map((item) => item.id);
	};
	rank.reserveMs = reserveMs;
	const result = await runChain({ query: input.query, stores, scope: "on-demand", rank, clock, startedAt, budgetMs: BUDGET_MS + rank.reserveMs });

	const unavailable = Object.entries(result.steps.stores).filter(([, step]) => step.status !== "ready")
		.map(([store, step]) => ({ store, reason: result.omitted.find((item) => item.store === store)?.reason ?? step.status }));
	const list = seen.list ?? [];
	// A ranker answer that came too late counts as a fallback: the first 3 of the merged list.
	const answer = seen.answer && result.steps.rank.status === "ok" ? seen.answer
		: { ranked: list.slice(0, RANK_LIMITS.fallbackCount).map((candidate, index) => ({ id: candidate.id, p: null, rank: index + 1 })),
			fallback: true, reason: seen.answer?.reason && seen.answer.fallback ? seen.answer.reason : "decider late" };
	const byId = new Map(list.map((candidate) => [candidate.id, candidate]));
	const kept = answer.ranked.filter((item) => byId.has(item.id)).slice(0, SEARCH_LIMITS.excerpts);
	const keptIds = new Set(kept.map((item) => item.id));
	// A ranked answer orders the pointers too (the next hits by the decider); a fallback keeps the merged order.
	const place = new Map(answer.fallback ? [] : (answer.order ?? []).map((id, index) => [id, index]));
	const byPlace = (a, b) => (place.get(a.id) ?? place.size) - (place.get(b.id) ?? place.size);
	const clean = (text) => stripPrivacyTokens(text);
	const storeStats = Object.fromEntries(stores.map((store) => [store.name, { ...result.steps.stores[store.name], chars: store.chars() }]));
	return {
		excerpts: kept.map((item) => {
			const candidate = byId.get(item.id);
			return { store: candidate.store, id: candidate.source, title: clean(candidate.title ?? ""), p: item.p, text: clean(candidate.text).slice(0, SEARCH_LIMITS.excerptChars) };
		}),
		pointers: list.filter((candidate) => !keptIds.has(candidate.id)).sort(byPlace).slice(0, SEARCH_LIMITS.pointers)
			.map((candidate) => ({ store: candidate.store, id: candidate.source, title: clean(candidate.title ?? "") })),
		unavailable,
		fallback: list.length ? answer.fallback === true : false,
		reason: list.length ? answer.reason : "no hits",
		stats: {
			totalMs: clock.now() - startedAt,
			storesMs: result.steps.storesMs,
			rankMs: result.steps.rank.ms,
			stores: storeStats,
			rawChars: Object.values(storeStats).reduce((sum, step) => sum + step.chars, 0),
		},
	};
}

/** A store that counts the characters of the hit texts that it returned (for the stats only). */
function measured(store) {
	let chars = 0;
	return {
		name: store.name,
		chars: () => chars,
		async search(input) {
			const reply = await store.search(input);
			if (Array.isArray(reply?.hits)) chars = reply.hits.reduce((sum, hit) => sum + String(hit.text ?? "").length + String(hit.title ?? "").length, 0);
			return reply;
		},
	};
}

function oneLine(text) {
	return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The fitted fields of a result, for both formats: each title at most 120 characters, each reason at most
 * 40, and an id over 300 characters left out whole (null; the block prints ID_TOO_LONG). An id is never cut.
 */
function fields(result) {
	const id = (value) => {
		const line = oneLine(value);
		return line.length > SEARCH_LIMITS.idChars ? null : line;
	};
	const title = (value) => oneLine(value).slice(0, SEARCH_LIMITS.titleChars);
	return {
		excerpts: result.excerpts.map((item) => ({ ...item, id: id(item.id), title: title(item.title), text: oneLine(item.text) })),
		pointers: result.pointers.map((item) => ({ ...item, id: id(item.id), title: title(item.title) })),
		unavailable: result.unavailable.map((item) => ({ store: item.store, reason: oneLine(item.reason).slice(0, SEARCH_LIMITS.reasonChars) })),
		fallback: result.fallback,
		reason: oneLine(result.reason).slice(0, SEARCH_LIMITS.reasonChars),
	};
}

/** The notice lines: the `Not available` line and the fallback line. They are never cut or dropped. */
function notices(view, excerptCount) {
	const lines = [];
	if (view.unavailable.length) lines.push(`Not available: ${view.unavailable.map((item) => `${item.store} (${item.reason})`).join(", ")}`);
	if (view.fallback) lines.push(`Ranking fell back (${view.reason}): the excerpts are the first ${excerptCount} hits, the stores in turn.`);
	return lines;
}

function render(view, { excerptChars, pointerCount, excerptCount }) {
	const lines = [];
	const excerpts = view.excerpts.slice(0, excerptCount);
	if (!view.excerpts.length && !view.pointers.length) lines.push("Memory search: no hits.");
	else lines.push(view.fallback ? "Memory search (not ranked):" : "Memory search (ranked by the decider):");
	excerpts.forEach((item, index) => {
		lines.push(`[${index + 1}] ${item.store} | ${item.id ?? ID_TOO_LONG} | ${item.title}`);
		// Indented, so an excerpt that starts with "- " does not read as a pointer.
		lines.push(`   ${item.text.slice(0, excerptChars)}`);
	});
	const pointers = view.pointers.slice(0, pointerCount);
	if (pointers.length) {
		lines.push("Pointers (read one in full only when its title bears on the question):");
		for (const item of pointers) lines.push(`- ${item.store} | ${item.id ?? ID_TOO_LONG} | ${item.title}`);
	}
	return lines;
}

/**
 * The cut that fits the block in 1,600 characters. The notice lines take their room first and always stay.
 * When the rest is too long, the excerpts get shorter first (to 80 characters), then the last pointer goes,
 * then the last excerpt. Every field is bounded, so whole lines go and no id or path is cut.
 */
function fit(result) {
	const view = fields(result);
	const cut = { excerptChars: SEARCH_LIMITS.excerptChars, pointerCount: SEARCH_LIMITS.pointers, excerptCount: SEARCH_LIMITS.excerpts };
	for (;;) {
		const block = [...render(view, cut), ...notices(view, Math.min(cut.excerptCount, view.excerpts.length))].join("\n");
		if (block.length <= SEARCH_LIMITS.maxChars || (cut.excerptCount === 0 && cut.pointerCount === 0)) return { view, cut, block };
		if (cut.excerptChars > SEARCH_LIMITS.minExcerptChars) cut.excerptChars -= 20;
		else if (cut.pointerCount > 0) cut.pointerCount -= 1;
		else cut.excerptCount -= 1;
	}
}

/** The printed block: at most 1,600 characters. */
export function formatBlock(result) {
	return fit(result).block;
}

/**
 * The JSON form: the same fitted fields as the block, cut the same way (an id that is too long is null),
 * plus `stats` (times, counts and sizes; no text). The JSON envelope and `stats` are extra to the 1,600.
 */
export function formatJson(result) {
	const { view, cut } = fit(result);
	return {
		excerpts: view.excerpts.slice(0, cut.excerptCount).map((item) => ({ ...item, text: item.text.slice(0, cut.excerptChars) })),
		pointers: view.pointers.slice(0, cut.pointerCount),
		unavailable: view.unavailable,
		fallback: view.fallback,
		reason: view.reason,
		stats: result.stats,
	};
}
