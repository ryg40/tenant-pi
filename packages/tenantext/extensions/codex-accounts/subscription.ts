import { readFileSync, statSync } from "node:fs";
import { CLOCK_SKEW_MS, parseZonedTimestamp, periodState, type PeriodState } from "../../src/period-end.ts";

/** Bounds on the work that one malformed or hostile token file can cause. */
export const MAX_TOKEN_FILE_BYTES = 64 * 1024;
export const MAX_ID_TOKEN_CHARS = 16 * 1024;
export const MAX_CLAIM_DEPTH = 8;
const AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Saved subscription metadata of one account, sanitized for the status bus. Only these fields cross; never the ID token or a claim.
 * `periodEndsAt` is the saved active-until time, not a verified billing or renewal date.
 * `providerCheckedAt` is the provider's last check, the basis of the evidence age; absent when unknown.
 * `collectedAt` is the time of the local read only. A later read never moves `providerCheckedAt`.
 */
export interface CodexSubscription {
	periodEndsAt?: string;
	providerCheckedAt?: string;
	collectedAt: string;
	source: "token-file";
	state: PeriodState | "unavailable";
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function depth(value: unknown, max: number): boolean {
	const stack: Array<[unknown, number]> = [[value, 1]];
	while (stack.length) {
		const [next, level] = stack.pop()!;
		if (next === null || typeof next !== "object") continue;
		if (level > max) return false;
		for (const child of Object.values(next)) stack.push([child, level + 1]);
	}
	return true;
}

/** The payload of a saved ID token, decoded in memory. Decoding is not verification: the signature is not checked. */
function idTokenClaims(token: unknown): Record<string, unknown> | undefined {
	if (typeof token !== "string" || token.length > MAX_ID_TOKEN_CHARS) return undefined;
	const segments = token.split(".");
	if (segments.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(segments[1])) return undefined;
	const claims: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
	return depth(claims, MAX_CLAIM_DEPTH) ? record(claims) : undefined;
}

/**
 * Read the saved period end of an account from its token file: a flat account-worker file or a Codex CLI `tokens` container.
 * Read-only, no network. Any failure gives `unavailable` with no date, so another login's date is never kept.
 */
export function readSubscription(path: string, now = Date.now()): CodexSubscription {
	const unavailable: CodexSubscription = { collectedAt: new Date(now).toISOString(), source: "token-file", state: "unavailable" };
	try {
		if (statSync(path).size > MAX_TOKEN_FILE_BYTES) return unavailable;
		const file = record(JSON.parse(readFileSync(path, "utf8")));
		const data = record(file?.tokens) ?? file;
		const auth = record(idTokenClaims(data?.id_token)?.[AUTH_CLAIM]);
		if (!data || !auth) return unavailable;
		// The ID token must name the account of the file. A missing identity on either side, or a token of another identity, never lends its date.
		if (typeof data.account_id !== "string" || !data.account_id || data.account_id !== auth.chatgpt_account_id) return unavailable;
		const endsAt = parseZonedTimestamp(auth.chatgpt_subscription_active_until);
		if (endsAt === undefined) return unavailable;
		const checkedAt = parseZonedTimestamp(auth.chatgpt_subscription_last_checked);
		if (checkedAt !== undefined && checkedAt - now > CLOCK_SKEW_MS) return unavailable;
		return { ...unavailable, periodEndsAt: new Date(endsAt).toISOString(),
			...(checkedAt !== undefined ? { providerCheckedAt: new Date(checkedAt).toISOString() } : {}), state: periodState(endsAt, checkedAt, now) };
	} catch { return unavailable; }
}
