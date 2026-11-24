import { execFile } from "node:child_process";
import type { OwnerRow, RowOption } from "./rows.ts";

/**
 * Loopback-only client for the local decision model (`POST /v1/systemone`).
 * Combines the rank (`choice`) and risk (`noul`) questions in one request per row.
 * Never logs, prints, or returns the API key.
 */

export const DEFAULT_DECIDER_URL = "http://127.0.0.1:9301";
// The default names the model of the reference setup. Set the model ID to one that your local decision endpoint
// serves: `DeciderConfig.model` for a caller of the producer, `--model` for measure-decider.ts. The producer
// command has no option for it and always sends this default.
export const DEFAULT_DECIDER_MODEL = "pplx-decider-flash-v1.3-Q4_K_M";

export const DECIDER_LIMITS = Object.freeze({
	healthTimeoutMs: 150,
	rowTimeoutMs: 400,
	phaseTimeoutMs: 2000,
});

export interface DeciderThresholds {
	minTopProb: number;
	minMargin: number;
	riskThreshold: number;
	rankingEnabled: boolean;
}

export const DEFAULT_THRESHOLDS: Readonly<DeciderThresholds> = Object.freeze({
	minTopProb: 0.55,
	minMargin: 0.15,
	riskThreshold: 0.30,
	rankingEnabled: true,
});

export interface DeciderConfig {
	baseUrl?: string;
	model?: string;
	keyEnv?: string;
	apiKey?: string;
	lockFile?: string;
	healthTimeoutMs?: number;
	rowTimeoutMs?: number;
	phaseTimeoutMs?: number;
	thresholds?: Partial<DeciderThresholds>;
	fetchImpl?: typeof fetch;
	checkLock?: (lockFile: string) => Promise<boolean>;
}

export interface DeciderRowScore {
	probabilities: Record<string, number>;
	riskProb: number;
	ms: number;
	inputTokens?: number;
	answerModel?: string;
}

export interface DeciderRequestBody {
	model: string;
	state: { prompt: string };
	questions: {
		rank: {
			type: "choice";
			instructions: string;
			criteria: Record<string, string>;
		};
		risk: {
			type: "noul";
			instructions: string;
		};
	};
}

export const RANK_INSTRUCTIONS = "Which answer does the owner most likely give?";
export const RISK_INSTRUCTIONS =
	"Does an answer to this task approve an action that is hard to undo or that leaves this computer: a push, a deploy, a release, a restart, a deletion or a change of a secret?";

const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Refuse any base URL that is not plain HTTP on loopback (no credentials, query, or fragment). */
export function assertLoopbackUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error("Decider base URL is not a valid URL.");
	}
	if (parsed.protocol !== "http:") {
		throw new Error("Decider base URL must use http on loopback.");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Decider base URL must not carry credentials, query, or fragment.");
	}
	const host = parsed.hostname.toLowerCase();
	const isLoopback = host === "localhost" || host === "[::1]" || host === "::1" || LOOPBACK_IPV4.test(host);
	if (!isLoopback) {
		throw new Error("Decider base URL must target loopback only.");
	}
	return parsed;
}

const FLOCK_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP"] as const;

function buildFlockEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of FLOCK_ENV_KEYS) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}

type LockCheckOutcome = "free" | "held" | "timeout" | "error";

function defaultCheckLockDetailed(lockFile: string, timeoutMs: number): Promise<LockCheckOutcome> {
	return new Promise((resolve) => {
		execFile("flock", ["-n", lockFile, "true"], { timeout: Math.max(1, timeoutMs), env: buildFlockEnv() }, (error) => {
			if (!error) {
				resolve("free");
				return;
			}
			const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null };
			if (err.killed || err.signal === "SIGTERM" || err.signal === "SIGKILL") {
				resolve("timeout");
				return;
			}
			if (typeof err.code === "number" && err.code === 1) {
				resolve("held");
				return;
			}
			resolve("error");
		});
	});
}

function isTimeoutError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = (err as { name?: unknown }).name;
	return name === "TimeoutError" || name === "AbortError";
}

function resolveKey(config: DeciderConfig): string | undefined {
	if (config.apiKey !== undefined) return config.apiKey || undefined;
	const envName = config.keyEnv ?? "DECISION_API_KEY";
	return process.env[envName] || undefined;
}

export function resolveThresholds(partial?: Partial<DeciderThresholds>): DeciderThresholds {
	return {
		minTopProb: partial?.minTopProb ?? DEFAULT_THRESHOLDS.minTopProb,
		minMargin: partial?.minMargin ?? DEFAULT_THRESHOLDS.minMargin,
		riskThreshold: partial?.riskThreshold ?? DEFAULT_THRESHOLDS.riskThreshold,
		rankingEnabled: partial?.rankingEnabled ?? DEFAULT_THRESHOLDS.rankingEnabled,
	};
}

/**
 * Check `/health` (150 ms per attempt, one retry on timeout within the 2 s phase budget)
 * and optional GPU lock file (no retry when the lock is known to be held).
 * Returns false when unavailable.
 */
export async function checkDeciderHealth(config: DeciderConfig = {}, phaseDeadlineMs?: number): Promise<boolean> {
	let base: URL;
	try {
		base = assertLoopbackUrl(config.baseUrl ?? DEFAULT_DECIDER_URL);
	} catch {
		return false;
	}
	const phaseLimit = config.phaseTimeoutMs ?? DECIDER_LIMITS.phaseTimeoutMs;
	const deadline = phaseDeadlineMs ?? Date.now() + phaseLimit;
	const timeoutMs = config.healthTimeoutMs ?? DECIDER_LIMITS.healthTimeoutMs;

	if (config.lockFile) {
		if (config.checkLock) {
			const free = await config.checkLock(config.lockFile);
			if (!free) return false;
		} else {
			const remaining1 = deadline - Date.now();
			if (remaining1 <= 0) return false;
			const first = await defaultCheckLockDetailed(config.lockFile, Math.min(timeoutMs, remaining1));
			if (first === "held" || first === "error") return false;
			if (first === "timeout") {
				const remaining2 = deadline - Date.now();
				if (remaining2 <= 0) return false;
				const second = await defaultCheckLockDetailed(config.lockFile, Math.min(timeoutMs, remaining2));
				if (second !== "free") return false;
			}
		}
	}

	const fetchFn = config.fetchImpl ?? fetch;
	const healthUrl = `${base.origin}/health`;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		const attemptTimeout = Math.max(1, Math.min(timeoutMs, remaining));
		try {
			const res = await fetchFn(healthUrl, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(attemptTimeout),
			});
			return res.status === 200;
		} catch (err) {
			if (attempt === 0 && isTimeoutError(err)) continue;
			return false;
		}
	}
	return false;
}

export function buildDeciderPayload(
	excerpt: string,
	row: Pick<OwnerRow, "label" | "text" | "candidates">,
	model = DEFAULT_DECIDER_MODEL,
): DeciderRequestBody {
	const criteria: Record<string, string> = {};
	for (const option of row.candidates.slice(0, 5)) {
		criteria[option.id] = option.text;
	}
	const prompt = excerpt ? `${excerpt}\n\nTask [${row.label}]: ${row.text}` : `Task [${row.label}]: ${row.text}`;
	return {
		model,
		state: { prompt },
		questions: {
			rank: {
				type: "choice",
				instructions: RANK_INSTRUCTIONS,
				criteria,
			},
			risk: {
				type: "noul",
				instructions: RISK_INSTRUCTIONS,
			},
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse and validate one `/v1/systemone` response against the expected option keys. */
export function parseDeciderResponse(raw: unknown, expectedKeys: readonly string[]): Omit<DeciderRowScore, "ms"> | null {
	if (!isRecord(raw)) return null;
	const answers = raw.answers;
	if (!isRecord(answers)) return null;

	const rank = answers.rank;
	if (!isRecord(rank) || !isRecord(rank.probabilities)) return null;
	const probabilities: Record<string, number> = {};
	for (const key of expectedKeys) {
		const val = rank.probabilities[key];
		if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) return null;
		probabilities[key] = val;
	}

	const risk = answers.risk;
	if (!isRecord(risk) || typeof risk.noul !== "number" || !Number.isFinite(risk.noul) || risk.noul < 0 || risk.noul > 1) {
		return null;
	}

	const usage = isRecord(raw.usage) ? raw.usage : undefined;
	const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined;
	const answerModel = typeof raw.model === "string" ? raw.model : undefined;
	return { probabilities, riskProb: risk.noul, inputTokens, answerModel };
}

/** Send one combined rank+risk request for one row. Returns null on timeout, error, or bad shape. */
export async function scoreRowWithDecider(
	config: DeciderConfig,
	excerpt: string,
	row: Pick<OwnerRow, "label" | "text" | "candidates">,
	timeoutOverrideMs?: number,
): Promise<DeciderRowScore | null> {
	const base = assertLoopbackUrl(config.baseUrl ?? DEFAULT_DECIDER_URL);
	const candidates = row.candidates.slice(0, 5);
	if (candidates.length === 0) return null;

	const fetchFn = config.fetchImpl ?? fetch;
	const timeoutMs = Math.max(1, timeoutOverrideMs ?? config.rowTimeoutMs ?? DECIDER_LIMITS.rowTimeoutMs);
	const model = config.model ?? DEFAULT_DECIDER_MODEL;
	const body = buildDeciderPayload(excerpt, { ...row, candidates }, model);
	const key = resolveKey(config);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;

	const t0 = performance.now();
	try {
		const res = await fetchFn(`${base.origin}/v1/systemone`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const ms = performance.now() - t0;
		if (res.status !== 200) return null;
		const json = (await res.json()) as unknown;
		const parsed = parseDeciderResponse(json, candidates.map((opt) => opt.id));
		if (!parsed) return null;
		return { ...parsed, ms };
	} catch {
		return null;
	}
}

/** Apply a validated decider score to a row according to PLAN-2 section 2.2 rules. */
export function applyDeciderScore(
	row: OwnerRow,
	score: DeciderRowScore,
	thresholds: DeciderThresholds = DEFAULT_THRESHOLDS,
): OwnerRow {
	const risky = row.riskByWords || score.riskProb >= thresholds.riskThreshold;
	const canMark = !risky && row.kind !== "owner_step" && row.kind !== "grilling";

	if (!thresholds.rankingEnabled) {
		return {
			...row,
			risky,
			riskProbability: score.riskProb,
			noClearPick: false,
			deciderApplied: true,
			options: row.candidates.slice(0, 3).map((opt) => ({ id: opt.id, text: opt.text })),
		};
	}

	const ranked = row.candidates
		.slice(0, 5)
		.map((opt, index) => ({
			opt,
			index,
			prob: score.probabilities[opt.id] ?? 0,
		}))
		.sort((a, b) => b.prob - a.prob || a.index - b.index);

	const top1 = ranked[0]?.prob ?? 0;
	const top2 = ranked[1]?.prob ?? 0;
	const recommended = canMark && top1 >= thresholds.minTopProb && top1 - top2 >= thresholds.minMargin;
	const noClearPick = canMark && !recommended;

	const options: RowOption[] = ranked.slice(0, 3).map((entry, idx) => ({
		id: entry.opt.id,
		text: entry.opt.text,
		probability: entry.prob,
		...(idx === 0 && recommended ? { recommended: true } : {}),
	}));

	return {
		...row,
		risky,
		riskProbability: score.riskProb,
		noClearPick,
		deciderApplied: true,
		options,
	};
}

export interface RankRowsResult {
	available: boolean;
	rows: OwnerRow[];
	answeredCount: number;
}

/**
 * Rank eligible rows in row order within the phase budget (2 s).
 * Invokes `onRowUpdate` as each row settles so the caller can repaint in series.
 */
export async function rankRowsWithDecider(
	config: DeciderConfig,
	excerpt: string,
	rows: readonly OwnerRow[],
	onRowUpdate?: (index: number, row: OwnerRow) => void,
): Promise<RankRowsResult> {
	const out = rows.map((row) => ({ ...row }));
	const phaseLimit = config.phaseTimeoutMs ?? DECIDER_LIMITS.phaseTimeoutMs;
	const rowLimit = config.rowTimeoutMs ?? DECIDER_LIMITS.rowTimeoutMs;
	const deadline = Date.now() + phaseLimit;
	const healthy = await checkDeciderHealth(config, deadline);
	if (!healthy) {
		return { available: false, rows: out, answeredCount: 0 };
	}

	const thresholds = resolveThresholds(config.thresholds);
	let answeredCount = 0;

	for (let i = 0; i < out.length; i++) {
		const row = out[i];
		if (!row.needsDecider || row.candidates.length === 0) continue;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const score = await scoreRowWithDecider(config, excerpt, row, Math.min(rowLimit, remaining));
		if (!score) continue;
		answeredCount += 1;
		out[i] = applyDeciderScore(row, score, thresholds);
		onRowUpdate?.(i, out[i]);
	}

	return { available: answeredCount > 0 || out.every((r) => !r.needsDecider || r.candidates.length === 0), rows: out, answeredCount };
}
