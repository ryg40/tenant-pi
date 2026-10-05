import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { CodexAccountConfig } from "./config.ts";
import { fetchCodexLimits, type CodexLimitsResult, type CodexPlan } from "./limits.ts";
import { readTokenFile, tokenFileNoLogin } from "./token-file.ts";

export const CODEX_STATUS_EVENT = "tenantext:codex:status";
export const CODEX_REFRESH_EVENT = "tenantext:codex:refresh";
export interface CodexStatusSnapshot {
	checkedAt: number;
	staleAfter: number;
	/**
	 * `plan` is an allowlisted, normalized value. It is absent when the payload did not report one or the fetch failed.
	 * `login: false` marks a configured account that has no login. Its state is `unknown` and it has no windows.
	 */
	accounts: Array<{ provider: string; label: string; state: "ok" | "error" | "unknown"; login?: false; plan?: CodexPlan; windows: Array<{
		label: string; remainingPercent: number; resetsAt?: string; unavailable?: boolean;
	}> }>;
	/** Account names are the gateway service names codex1, codex2, codex3, ... */
	routing?: { state: "ok" | "error" | "unknown"; selectedAccount?: string; preferredAccount?: string;
		blockedUntil?: string; quotaCacheSeconds?: number; summary?: string };
}
/** Errors that mean the login owner has not refreshed the token yet, not that the account is unusable. */
const CREDENTIAL_ERRORS = new Set(["Token file unreadable or expired", "OAuth access token not found", "HTTP 401"]);
/** The account is configured but nobody logged in. This is not a failure: the footer shows `no login` and no alert. */
export const NO_LOGIN_ERROR = "No login";
/** The longest time a last good reading stands in for a credential failure. */
export const CACHED_LIMITS_MS = 24 * 60 * 60 * 1000;
/**
 * A request inside this time gets the cached reading, so a burst of requests gives one fetch. It stays below the footer's
 * default poll time (60 seconds). A reading gets its time when the fetch ends, so a skip time equal to the poll time
 * skips every second poll.
 */
export const CODEX_REFRESH_MIN_MS = 30_000;
/** The lifetime of a reading: two default poll times, so one late poll does not make it stale. */
export const CODEX_STALE_AFTER_MS = 120_000;
type SnapshotAccount = CodexStatusSnapshot["accounts"][number];
export type AccountLimits = Array<{ account: CodexAccountConfig; result: CodexLimitsResult }>;
export type LimitsCollector = (accounts: CodexAccountConfig[], signal: AbortSignal) => Promise<AccountLimits>;

/**
 * Accounts with a token file or a stored Pi login. An account with neither is not configured here, so the footer omits it.
 * A configured token file decides alone: another client owns that login, so a stale Pi login does not count.
 * `explicit` means the user listed the accounts in a settings file. Then an account with no token file setting and no
 * Pi login stays in the list, and the footer shows `no login` for it.
 */
export function presentAccounts(accounts: CodexAccountConfig[], read: (provider: string) => unknown = readStoredCredential,
	exists: (path: string) => boolean = existsSync, explicit = false): CodexAccountConfig[] {
	return accounts.filter((account) => {
		try { return account.tokenFile ? exists(account.tokenFile) : explicit || read(account.provider) !== undefined; } catch { return false; }
	});
}

/** Limits from the account's token file when configured, otherwise from the Pi login. Read-only: the login owner refreshes. */
export async function accountLimits(account: CodexAccountConfig, signal: AbortSignal,
	fetchLimits: typeof fetchCodexLimits = fetchCodexLimits, readToken: typeof readTokenFile = readTokenFile,
	readCredential: (provider: string) => unknown = readStoredCredential,
	noLogin: (path: string) => boolean = tokenFileNoLogin): Promise<CodexLimitsResult> {
	if (account.tokenFile) {
		const token = readToken(account.tokenFile);
		if (token) return fetchLimits(account, token.access, signal, token.accountId);
		// Empty values mean no login. An expired token or an unreadable file keeps the credential error.
		return { success: false, error: noLogin(account.tokenFile) ? NO_LOGIN_ERROR : "Token file unreadable or expired" };
	}
	const credential = readCredential(account.provider) as { type?: string; expires?: number; access?: string } | undefined;
	if (credential === undefined) return { success: false, error: NO_LOGIN_ERROR };
	const access = credential?.type === "oauth" && (credential.expires ?? 0) > Date.now() ? credential.access : undefined;
	return fetchLimits(account, access, signal);
}

/** `explicit` keeps a listed account that has no credential, so the footer can show `no login` for it. */
export const collectLimitsFor = (explicit: boolean): LimitsCollector => async (accounts, signal) => Promise.all(
	presentAccounts(accounts, readStoredCredential, existsSync, explicit).map(async (account) => {
		try {
			// Read-only: the login owner refreshes. The footer never rotates OAuth tokens.
			return { account, result: await accountLimits(account, signal) };
		} catch { return { account, result: { success: false as const, error: "Account limits unavailable" } }; }
	}));
export const collectLimits: LimitsCollector = collectLimitsFor(false);

export function createCodexStatus(pi: ExtensionAPI, accounts: CodexAccountConfig[], collect: LimitsCollector = collectLimits) {
	let ctx: ExtensionContext | undefined;
	let stopped = false;
	let requested = false;
	let controller: AbortController | undefined;
	let pending: Promise<AccountLimits> | undefined;
	let cached: AccountLimits = [];
	// Last successful plan and windows per provider. A gateway refreshes its token only on use, so an idle gateway's expired token
	// shows the last reading (state unknown, no error chip) until a window resets or the reading is a day old.
	const lastGood = new Map<string, { at: number; account: SnapshotAccount }>();
	let snapshot: CodexStatusSnapshot = { checkedAt: 0, staleAfter: CODEX_STALE_AFTER_MS, accounts: [], routing: {
		state: "unknown", summary: "Gateway status unavailable.",
	} };
	const publish = () => { if (!stopped) pi.events.emit(CODEX_STATUS_EVENT, structuredClone(snapshot)); };
	const refresh = (force = false): Promise<AccountLimits> => {
		if (stopped || !ctx) return Promise.resolve([]);
		if (pending) return pending;
		if (!force && snapshot.checkedAt && Date.now() - snapshot.checkedAt < CODEX_REFRESH_MIN_MS) {
			publish();
			return Promise.resolve(cached);
		}
		controller = new AbortController();
		const deadline = setTimeout(() => controller?.abort(), 16_000);
		deadline.unref();
		const signals = [controller.signal];
		if (ctx.signal) signals.push(ctx.signal);
		const signal = AbortSignal.any(signals);
		pending = (async () => {
			let onAbort: () => void = () => {};
			try {
				const cancelled = new Promise<AccountLimits>((resolve) => {
					onAbort = () => resolve([]);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				});
				const results = await Promise.race([collect(accounts, signal), cancelled]);
				if (stopped || signal.aborted) return [];
				cached = results;
				const now = Date.now();
				snapshot = { ...snapshot, checkedAt: now, accounts: results.map(({ account, result }) => {
					if (!result.success && result.error === NO_LOGIN_ERROR) {
						lastGood.delete(account.provider);
						return { provider: account.provider, label: account.provider === "openai-codex" ? "Codex 1" : `Codex ${account.provider.split("-").at(-1)}`,
							state: "unknown" as const, login: false as const, windows: [] };
					}
					const current: SnapshotAccount = {
						provider: account.provider,
						label: account.provider === "openai-codex" ? "Codex 1" : `Codex ${account.provider.split("-").at(-1)}`,
						state: result.success ? (result.windows.some((window) => !window.unavailable) ? "ok" : "unknown") : "error",
						...(result.success && result.plan ? { plan: result.plan } : {}),
						windows: result.success ? result.windows.map((window) => ({ label: window.label, remainingPercent: window.remainingPercent,
							resetsAt: window.resetsAt?.toISOString(), unavailable: window.unavailable })) : [],
					};
					if (current.state === "ok") lastGood.set(account.provider, { at: now, account: current });
					if (result.success || !CREDENTIAL_ERRORS.has(result.error)) return current;
					const last = lastGood.get(account.provider);
					const reset = last?.account.windows.some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
					return last && !reset && now - last.at < CACHED_LIMITS_MS ? { ...last.account, state: "unknown" as const } : current;
				}) };
				publish();
				return results;
			} catch { return []; }
			finally { clearTimeout(deadline); signal.removeEventListener("abort", onAbort); pending = undefined; controller = undefined; }
		})();
		return pending;
	};
	const unsubscribe = pi.events.on(CODEX_REFRESH_EVENT, () => {
		if (!ctx) requested = true;
		else void refresh();
	});
	pi.on("session_start", (_event, latest) => {
		ctx = latest;
		publish();
		if (requested) { requested = false; void refresh(); }
	});
	pi.on("model_select", (_event, latest) => { ctx = latest; });
	pi.on("session_shutdown", () => { stopped = true; ctx = undefined; controller?.abort(); unsubscribe(); });
	return {
		refresh(latest: ExtensionContext) { ctx = latest; return refresh(true); },
		setRouting(routing: NonNullable<CodexStatusSnapshot["routing"]>) { snapshot = { ...snapshot, routing }; publish(); },
		report() {
			const routing = snapshot.routing;
			return `## Codex routing\n\n- Preferred account: ${routing?.preferredAccount ?? "unknown"}.\n- Last response account: ${routing?.selectedAccount ?? "unknown"}.\n- Blocked-until time: unknown.\n- Quota cache duration: unknown.\n- ${routing?.summary ?? "Gateway status unavailable."}`;
		},
	};
}
