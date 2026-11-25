// The decider ranker: one `choice` question over the memory candidates to the local decision model.
// Plain ESM with no import of Pi, Claude Code or packages/tenantext. The loopback check and the health
// check are ports of packages/tenantext/owner-popup/decider.ts (`assertLoopbackUrl`, `checkDeciderHealth`).
// It prints and logs nothing: no key, no candidate text.
// Transport: `node:http` with `agent: false` to a numeric loopback address. No proxy setting of the
// process (`NODE_USE_ENV_PROXY`, `HTTP_PROXY`) applies to it, and `localhost` maps to 127.0.0.1, so no
// name lookup happens. A redirect is not followed: any answer other than 200 is a failure.
import { request as httpRequest } from "node:http";

export const DEFAULT_DECIDER_URL = "http://127.0.0.1:9301";
export const DEFAULT_DECIDER_MODEL = "pplx-decider-flash-v1.3-Q4_K_M";
export const KEY_ENV = "DECISION_API_KEY";

export const RANK_LIMITS = Object.freeze({
	healthTimeoutMs: 150,
	questionTimeoutMs: 600,
	maxCandidates: 20,
	// An on-demand search may send more: all hits of its stores (Pi 3 x 8, Claude Code 4 x 8), so a hit that a
	// store ranks late still reaches the decider. The automatic run keeps 20.
	maxOnDemandCandidates: 32,
	maxTextChars: 200,
	keepMin: 2,
	keepMax: 4,
	keepProb: 0.10,
	fallbackCount: 3,
});

const MAX_ANSWER_BYTES = 64 * 1024;
const QUESTION_ID = "pick";
const NONE = "none";
const INSTRUCTIONS = "Which memory helps an agent most to answer the prompt?";
const NONE_TEXT = "No memory helps answer the prompt.";

// The two forms of an OpenViking privacy placeholder: `{{ov_privacy:...}}` in text and the
// path-safe `{{ov_privacy_..._}}` form in file names (see openviking/privacy/restore.py `_REFERENCE`).
const PRIVACY_TOKEN = /\{\{[ \t]*ov_privacy[:_][^{}\r\n]*\}\}/g;

/** The text with every OpenViking privacy placeholder removed. It resolves no placeholder. */
export function stripPrivacyTokens(text) {
	return String(text ?? "").replace(PRIVACY_TOKEN, "").replace(/[ \t]{2,}/g, " ").trim();
}

const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Refuse any base URL that is not plain HTTP on loopback (no credentials, query, or fragment). */
export function assertLoopbackUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Decider base URL is not a valid URL.");
	}
	if (parsed.protocol !== "http:") throw new Error("Decider base URL must use http on loopback.");
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Decider base URL must not carry credentials, query, or fragment.");
	}
	const host = parsed.hostname.toLowerCase();
	const isLoopback = host === "localhost" || host === "[::1]" || host === "::1" || LOOPBACK_IPV4.test(host);
	if (!isLoopback) throw new Error("Decider base URL must target loopback only.");
	return parsed;
}

/** The numeric loopback address and the port of a base URL (a string or a URL). Throws when it is not loopback. */
function loopbackTarget(base) {
	const parsed = assertLoopbackUrl(base instanceof URL ? base.href : base);
	const name = parsed.hostname.toLowerCase();
	const host = name === "localhost" ? "127.0.0.1" : name === "[::1]" || name === "::1" ? "::1" : name;
	return { host, port: Number(parsed.port || 80) };
}

/** The limits of one call: a caller value can only make a limit shorter. A value that is not a positive finite number is ignored. */
export function deciderLimits(options = {}) {
	const shorter = (value, max) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, max) : max);
	const healthTimeoutMs = shorter(options.healthTimeoutMs, RANK_LIMITS.healthTimeoutMs);
	const questionTimeoutMs = shorter(options.questionTimeoutMs, RANK_LIMITS.questionTimeoutMs);
	// Two health attempts (one retry after a timeout) and the question.
	return { healthTimeoutMs, questionTimeoutMs, reserveMs: 2 * healthTimeoutMs + questionTimeoutMs };
}

function namedError(name) {
	const error = new Error(name);
	error.name = name;
	return error;
}

function isTimeoutError(error) {
	const name = error && typeof error === "object" ? error.name : undefined;
	return name === "TimeoutError" || name === "AbortError";
}

/**
 * One direct HTTP exchange with a loopback target. Resolves `{ status, text }`; `text` is null for any
 * status other than 200 (a 3xx is not followed). Rejects on a socket error, a timeout (`TimeoutError`),
 * an abort (`AbortError`) or an answer over 64 KiB. The time limit covers the whole answer.
 */
function exchange(target, { method, path, headers = {}, body, timeoutMs, signal }) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(namedError("AbortError"));
			return;
		}
		let done = false;
		let req;
		const finish = (settle, value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			settle(value);
		};
		const fail = (error) => {
			finish(reject, error);
			req?.destroy();
		};
		const onAbort = () => fail(namedError("AbortError"));
		const timer = setTimeout(() => fail(namedError("TimeoutError")), Math.max(1, timeoutMs));
		signal?.addEventListener("abort", onAbort, { once: true });
		req = httpRequest({ host: target.host, port: target.port, path, method, headers, agent: false }, (res) => {
			if (res.statusCode !== 200) {
				finish(resolve, { status: res.statusCode, text: null });
				res.resume();
				req.destroy();
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_ANSWER_BYTES) fail(namedError("TooLarge"));
				else chunks.push(chunk);
			});
			res.on("end", () => finish(resolve, { status: 200, text: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", fail);
		});
		req.on("error", fail);
		req.end(body);
	});
}

/**
 * `GET /health`: 150 ms per attempt, one retry after a timeout, so up to 300 ms. Returns false when
 * unavailable, and also when `base` is not a loopback base URL: it checks its own input.
 * The lock file of `checkDeciderHealth` is left out: no caller of this module sets one.
 */
export async function checkDeciderHealth(base, { healthTimeoutMs, signal } = {}) {
	let target;
	try {
		target = loopbackTarget(base);
	} catch {
		return false;
	}
	return healthy(target, deciderLimits({ healthTimeoutMs }).healthTimeoutMs, signal);
}

async function healthy(target, limit, signal) {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (signal?.aborted) return false;
		try {
			const res = await exchange(target, { method: "GET", path: "/health", timeoutMs: limit, signal });
			return res.status === 200;
		} catch (error) {
			if (attempt === 0 && error?.name === "TimeoutError" && !signal?.aborted) continue;
			return false;
		}
	}
	return false;
}

/** The candidate limit of one call: 20 by default; a caller value is a whole number from 1 to 32. */
export function candidateLimit(value) {
	return Number.isInteger(value) && value > 0 ? Math.min(value, RANK_LIMITS.maxOnDemandCandidates) : RANK_LIMITS.maxCandidates;
}

/** The candidates that go out: at most `max` (20 by default) with a unique id, each text without placeholders and cut to 200 characters. */
export function prepareCandidates(candidates, max = RANK_LIMITS.maxCandidates) {
	const list = [];
	const seen = new Set();
	for (const candidate of Array.isArray(candidates) ? candidates : []) {
		if (!candidate || typeof candidate !== "object") continue;
		const id = typeof candidate.id === "string" ? candidate.id : typeof candidate.id === "number" ? String(candidate.id) : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		list.push({ id, text: stripPrivacyTokens(candidate.text).slice(0, RANK_LIMITS.maxTextChars) });
		if (list.length >= max) break;
	}
	return list;
}

/** One request with one `choice` question. The criteria keys are `c1`..`cN` and `none`: no id leaves the process. */
export function buildRankPayload(query, prepared, model = DEFAULT_DECIDER_MODEL) {
	const criteria = {};
	prepared.forEach((candidate, index) => { criteria[`c${index + 1}`] = candidate.text || "-"; });
	criteria[NONE] = NONE_TEXT;
	return {
		model,
		state: { prompt: stripPrivacyTokens(query) },
		questions: { [QUESTION_ID]: { type: "choice", instructions: INSTRUCTIONS, criteria } },
	};
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The probabilities of the candidate keys, or null when the answer is not valid. */
export function parseRankResponse(raw, count) {
	const answer = isRecord(raw) && isRecord(raw.answers) ? raw.answers[QUESTION_ID] : undefined;
	if (!isRecord(answer) || !isRecord(answer.probabilities)) return null;
	const out = [];
	for (let index = 0; index < count; index += 1) {
		const p = answer.probabilities[`c${index + 1}`];
		if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
		out.push(p);
	}
	return out;
}

/** All ids from the highest probability down; ties keep the given order. The pointers of a search follow it. */
export function rankOrder(prepared, probabilities) {
	return prepared.map((candidate, index) => ({ id: candidate.id, p: probabilities[index], index }))
		.sort((a, b) => (b.p - a.p) || (a.index - b.index)).map((item) => item.id);
}

/** The keep rule: probability 0.10 or more, or in the top 2; at most 4. Ties keep the given order. */
export function keepRanked(prepared, probabilities) {
	const order = prepared.map((candidate, index) => ({ id: candidate.id, p: probabilities[index], index }))
		.sort((a, b) => (b.p - a.p) || (a.index - b.index));
	const ranked = [];
	order.forEach((item, index) => {
		const rank = index + 1;
		if (ranked.length < RANK_LIMITS.keepMax && (rank <= RANK_LIMITS.keepMin || item.p >= RANK_LIMITS.keepProb)) {
			ranked.push({ id: item.id, p: item.p, rank });
		}
	});
	return ranked;
}

function fallback(prepared, reason) {
	return {
		ranked: prepared.slice(0, RANK_LIMITS.fallbackCount).map((candidate, index) => ({ id: candidate.id, p: null, rank: index + 1 })),
		fallback: true,
		reason,
	};
}

let busy = false;

/**
 * Rank `candidates` (`{ id, text }[]`) for `query` with the decider. Returns `{ ranked, fallback, reason }`, and
 * on a ranked answer also `order`: every sent id from the highest probability down.
 * It never throws. A second call while one runs in this process takes the fallback (`busy`) at once.
 * @param {string} query
 * @param {{id: string, text: string}[]} candidates
 * @param {{baseUrl?: string, model?: string, apiKey?: string, env?: Record<string, string|undefined>,
 *   healthTimeoutMs?: number, questionTimeoutMs?: number, maxCandidates?: number, signal?: AbortSignal}} [options]
 *   the two limits can only be shorter than `RANK_LIMITS` (see `deciderLimits`); `maxCandidates` is at most 32 (see `candidateLimit`).
 */
export async function rankWithDecider(query, candidates, options = {}) {
	const prepared = prepareCandidates(candidates, candidateLimit(options.maxCandidates));
	if (!prepared.length) return { ranked: [], fallback: true, reason: "no candidates" };
	if (typeof query !== "string" || !query.trim()) return fallback(prepared, "no query");
	let target;
	try {
		target = loopbackTarget(options.baseUrl ?? DEFAULT_DECIDER_URL);
	} catch {
		return fallback(prepared, "not loopback");
	}
	const env = options.env ?? process.env;
	const key = options.apiKey !== undefined ? options.apiKey : env[KEY_ENV];
	if (typeof key !== "string" || !key) return fallback(prepared, "no key");
	if (busy) return fallback(prepared, "busy");
	busy = true;
	try {
		const signal = options.signal;
		const limits = deciderLimits(options);
		if (!(await healthy(target, limits.healthTimeoutMs, signal))) return fallback(prepared, "decider down");
		const body = JSON.stringify(buildRankPayload(query, prepared, options.model ?? DEFAULT_DECIDER_MODEL));
		let res;
		try {
			res = await exchange(target, {
				method: "POST",
				path: "/v1/systemone",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${key}` },
				body,
				timeoutMs: limits.questionTimeoutMs,
				signal,
			});
		} catch (error) {
			return fallback(prepared, isTimeoutError(error) ? "decider slow" : error?.name === "TooLarge" ? "bad answer" : "decider error");
		}
		// A redirect is a bad answer: it is never followed.
		if (res.status >= 300 && res.status < 400) return fallback(prepared, "bad answer");
		if (res.status !== 200) return fallback(prepared, `decider http ${res.status}`);
		let json;
		try {
			json = JSON.parse(res.text);
		} catch {
			return fallback(prepared, "bad answer");
		}
		const probabilities = parseRankResponse(json, prepared.length);
		if (!probabilities) return fallback(prepared, "bad answer");
		return { ranked: keepRanked(prepared, probabilities), order: rankOrder(prepared, probabilities), fallback: false, reason: "ok" };
	} catch {
		return fallback(prepared, "decider error");
	} finally {
		busy = false;
	}
}

/**
 * A ranker for `runChain` of `core.mjs` (its `rank` slot), for one query (`options.query`). It sends the candidate text only, not the
 * source. On a fallback it throws, so the chain records the ranker as failed and gives links.
 * `reserveMs` comes from the same limits as the calls: two health attempts and the question.
 */
export function createDeciderRanker(options = {}) {
	// `runChain` passes only the candidates and a signal, so the query comes in with the options.
	const { healthTimeoutMs, questionTimeoutMs, reserveMs } = deciderLimits(options);
	const rank = async (candidates, input = {}) => {
		const list = candidates.map((candidate) => ({ id: candidate.id, text: candidate.text }));
		const signal = input.signal && options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal ?? options.signal;
		const result = await rankWithDecider(options.query, list, { ...options, healthTimeoutMs, questionTimeoutMs, signal });
		if (result.fallback) throw new Error(result.reason);
		return result.ranked.map((item) => item.id);
	};
	rank.reserveMs = reserveMs;
	return rank;
}
