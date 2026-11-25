// The memory chain core. No import of Pi or Claude Code: the stores, the ranker and the clock come in
// as arguments. One clock runs from prompt arrival. The stores run in parallel; the chain stops
// waiting at the budget, drops late replies, keeps only permitted hits, ranks them and builds one block.

export const BUDGET_MS = 2000;
export const MAX_EXCERPTS = 4;
export const MAX_CHARS = 3000;
export const MAX_LINKS = 8;
export const MAX_SOURCE_CHARS = 240;
const MAX_OMISSION_CHARS = 400;
export const TIMEOUT_LINE = "memory search timed out";

const HEADER_EXCERPTS = "Memory chain excerpts:";
const HEADER_LINKS = "Memory chain links (not ranked):";
const SEPARATOR = "\n---\n";
const LATE = Symbol("late");
const FAILED = Symbol("failed");

/** The real clock. It reads the timer functions at call time, so test timers apply. */
export const realClock = Object.freeze({
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (timer) => clearTimeout(timer),
});

/** Resolve to the value of `promise`, or to LATE at the time `at` of `clock`. */
function until(promise, at, clock) {
	let timer;
	const wait = Math.max(0, at - clock.now());
	const deadline = new Promise((resolve) => { timer = clock.setTimeout(() => resolve(LATE), wait); });
	return Promise.race([promise, deadline]).finally(() => clock.clearTimeout(timer));
}

/**
 * The deterministic test ranker: score high to low, then the identifier. Other rankers are later work.
 * A ranker declares `reserveMs`, the time that it needs: the stores stop at the budget minus that time.
 */
export function testRanker(candidates) {
	return [...candidates]
		.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((candidate) => candidate.id);
}
testRanker.reserveMs = 0;

/** The declared time of `rank`, or null when the declaration is missing or not a whole number in the budget. */
export function rankReserve(rank, budgetMs) {
	const value = typeof rank === "function" ? rank.reserveMs : undefined;
	return Number.isInteger(value) && value >= 0 && value <= budgetMs ? value : null;
}

/**
 * The scope rule (decision 1.3). A hit passes when its project key is one of the current project,
 * or when its global identifier is in the owner list. Every other hit stops here, so it reaches
 * no ranker, no link and no block.
 */
export function permitted(hit, { projects, approved }) {
	if (!hit || typeof hit !== "object") return false;
	if (typeof hit.source !== "string" || !hit.source) return false;
	if (typeof hit.project === "string" && hit.project && projects.has(hit.project)) return true;
	return typeof hit.globalId === "string" && hit.globalId !== "" && approved.has(hit.globalId);
}

function clip(text, max) {
	if (text.length <= max) return text;
	if (max <= 1) return "";
	return `${text.slice(0, max - 1)}…`;
}

/** Merge hits of the same source: keep the highest score and its text (and its title, when the store gives one). */
function mergeCandidates(hits) {
	const bySource = new Map();
	for (const hit of hits) {
		const score = Number.isFinite(Number(hit.score)) ? Number(hit.score) : 0;
		const text = typeof hit.text === "string" ? hit.text.trim() : "";
		const prior = bySource.get(hit.source);
		if (!prior || score > prior.score) {
			const merged = { store: hit.store, source: hit.source, text, score };
			if (typeof hit.title === "string" && hit.title) merged.title = hit.title;
			bySource.set(hit.source, merged);
		}
	}
	return [...bySource.values()].map((candidate, index) => ({ id: `c${index + 1}`, ...candidate }));
}

export function omissionLine(omitted) {
	if (!omitted.length) return "";
	return clip(`Left out: ${omitted.map((item) => `${item.store} (${item.reason})`).join(", ")}`, MAX_OMISSION_CHARS);
}

/**
 * The excerpt block: at most MAX_EXCERPTS items and MAX_CHARS characters in total, with the header,
 * the labels, the sources, the separators and the omission line counted.
 */
export function buildExcerptBlock(items, omission) {
	let chosen = items.slice(0, MAX_EXCERPTS).map((item) => ({ ...item, source: clip(item.source, MAX_SOURCE_CHARS) }));
	const tail = omission ? `\n${omission}` : "";
	for (;;) {
		const heads = chosen.map((item, index) => `[${index + 1}] ${item.source}\n`);
		const fixed = HEADER_EXCERPTS.length + 1 + heads.reduce((sum, head) => sum + head.length, 0)
			+ Math.max(0, chosen.length - 1) * SEPARATOR.length + tail.length;
		if (fixed > MAX_CHARS && chosen.length) {
			chosen = chosen.slice(0, -1);
			continue;
		}
		let left = MAX_CHARS - fixed;
		const parts = chosen.map((item, index) => {
			const share = Math.floor(left / (chosen.length - index));
			const text = clip(item.text, share);
			left -= text.length;
			chosen[index] = { ...item, excerpt: text };
			return `${heads[index]}${text}`;
		});
		const block = chosen.length ? `${HEADER_EXCERPTS}\n${parts.join(SEPARATOR)}${tail}` : omission;
		return { block: clip(block, MAX_CHARS), items: chosen };
	}
}

/** The links block: sources only, no excerpt, within MAX_CHARS. */
export function buildLinksBlock(items, omission) {
	const tail = omission ? `\n${omission}` : "";
	const lines = [];
	let size = HEADER_LINKS.length + tail.length;
	for (const item of items.slice(0, MAX_LINKS)) {
		const line = `\n- ${clip(item.source, MAX_SOURCE_CHARS)}`;
		if (size + line.length > MAX_CHARS) break;
		lines.push(line);
		size += line.length;
	}
	const block = lines.length ? `${HEADER_LINKS}${lines.join("")}${tail}` : omission;
	return { block: clip(block, MAX_CHARS), items: items.slice(0, lines.length) };
}

/**
 * Run the chain once.
 * @param {object} options
 * @param {string} options.query the prompt text after the bypass filters
 * @param {{name: string, search: (input: {query: string, signal: AbortSignal}) => Promise<any>}[]} options.stores
 * @param {Set<string>} options.projects the project keys of the current project
 * @param {Set<string>} options.approved the exact identifiers of the owner list
 * @param {{store: string, reason: string}[]} [options.fixedOmissions] stores left out by rule
 * @param {((candidates: object[], input: {signal: AbortSignal}) => string[]|Promise<string[]>) & {reserveMs: number}} [options.rank]
 *   a ranker with no valid `reserveMs` counts as failed: the run gives links
 * @param {typeof realClock} [options.clock]
 * @param {number} [options.startedAt] the prompt arrival on `clock`
 * @param {number} [options.budgetMs] the whole budget; BUDGET_MS by default
 * @param {"project"|"on-demand"} [options.scope] "project" (the default) applies the scope rule `permitted`.
 *   "on-demand" is for a search that a person or an agent starts on request: every hit with a source passes.
 *   The automatic runs (`runPrompt`) never set it.
 */
export async function runChain(options) {
	const clock = options.clock ?? realClock;
	const startedAt = options.startedAt ?? clock.now();
	const budgetMs = options.budgetMs ?? BUDGET_MS;
	const end = startedAt + budgetMs;
	const rank = options.rank ?? testRanker;
	const reserve = rankReserve(rank, budgetMs);
	const storeEnd = end - (reserve ?? 0);
	const scope = { projects: options.projects ?? new Set(), approved: options.approved ?? new Set() };
	const controller = new AbortController();
	let open = true;

	const states = options.stores.map((store) => ({ store: store.name, status: "late", reason: "", ms: null, hits: [] }));
	const searches = options.stores.map((store, index) => Promise.resolve()
		.then(() => store.search({ query: options.query, signal: controller.signal }))
		.then((reply) => {
			if (!open) return; // a late reply is dropped
			const state = states[index];
			state.ms = clock.now() - startedAt;
			if (reply?.status === "omitted") {
				state.status = "omitted";
				state.reason = String(reply.reason || "omitted");
			} else {
				state.status = "ready";
				state.hits = Array.isArray(reply?.hits) ? reply.hits.map((hit) => ({ ...hit, store: store.name })) : [];
			}
		}, () => {
			if (!open) return;
			states[index].status = "failed";
			states[index].ms = clock.now() - startedAt;
		}));
	await until(Promise.all(searches), storeEnd, clock);
	open = false;
	controller.abort();
	const storesMs = clock.now() - startedAt;

	const omitted = [];
	for (const state of states) {
		if (state.status === "late") omitted.push({ store: state.store, reason: "late" });
		else if (state.status === "failed") omitted.push({ store: state.store, reason: "failed" });
		else if (state.status === "omitted") omitted.push({ store: state.store, reason: state.reason });
	}
	const allOmitted = [...omitted, ...(options.fixedOmissions ?? [])];
	const steps = { stores: Object.fromEntries(states.map((state) => [state.store,
		{ status: state.status, ms: state.ms, hits: state.status === "ready" ? state.hits.length : 0 }])), storesMs };
	const finish = (kind, built, rankStatus, rankMs) => ({
		kind,
		block: built.block,
		chars: built.block.length,
		omitted: allOmitted,
		selected: built.items.map((item) => ({ id: item.id, score: item.score, length: item.text.length })),
		// The sources and excerpts of the selected items, for the replay output only. No record takes them.
		items: built.items.map((item) => ({ id: item.id, store: item.store, source: item.source, excerpt: item.excerpt ?? "", score: item.score })),
		steps: { ...steps, rank: { status: rankStatus, ms: rankMs }, buildMs: clock.now() - startedAt - storesMs - (rankMs ?? 0) },
		totalMs: clock.now() - startedAt,
		storeDeadlineMs: storeEnd - startedAt,
	});

	if (!states.some((state) => state.status === "ready")) {
		// Stores that are all left out by rule (no project, refused scope) are not a timeout.
		if (!states.some((state) => state.status === "late" || state.status === "failed")) {
			return finish("empty", { block: "", items: [] }, "none", null);
		}
		return finish("timeout", { block: TIMEOUT_LINE, items: [] }, "none", null);
	}
	const onDemand = options.scope === "on-demand";
	const pass = (hit) => (onDemand ? Boolean(hit) && typeof hit.source === "string" && hit.source !== "" : permitted(hit, scope));
	const candidates = mergeCandidates(states.flatMap((state) => state.hits).filter(pass));
	const omission = omissionLine(allOmitted);
	if (!candidates.length) {
		// `empty` only when every store answered: a late or failed store makes the result partial.
		const missing = states.some((state) => state.status === "late" || state.status === "failed");
		return finish(missing ? "partial" : "empty", { block: missing ? omission : "", items: [] }, "none", null);
	}

	if (reserve === null) {
		const byScore = [...candidates].sort((a, b) => b.score - a.score);
		return finish("links", buildLinksBlock(byScore, omission), "failed", null);
	}
	const rankStart = clock.now();
	const rankController = new AbortController();
	const view = candidates.map(({ id, store, source, text, score, title }) => ({ id, store, source, text, score, ...(title ? { title } : {}) }));
	const answer = await until(Promise.resolve().then(() => rank(view, { signal: rankController.signal })).catch(() => FAILED), end, clock);
	rankController.abort();
	const rankMs = clock.now() - rankStart;
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const order = Array.isArray(answer) ? [...new Set(answer.filter((id) => byId.has(id)))] : [];
	if (!order.length) {
		const byScore = [...candidates].sort((a, b) => b.score - a.score);
		return finish("links", buildLinksBlock(byScore, omission), answer === LATE ? "late" : answer === FAILED ? "failed" : "empty", rankMs);
	}
	return finish(omitted.length ? "partial" : "full", buildExcerptBlock(order.map((id) => byId.get(id)), omission), "ok", rankMs);
}
