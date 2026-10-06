import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertUniqueAccountIdentity } from "../extensions/codex-accounts/identity.ts";
import { readTokenFile, tokenFileNoLogin } from "../extensions/codex-accounts/token-file.ts";
import { loadCodexAccountsSettings } from "../extensions/codex-accounts/config.ts";
import { normalizeCodexPlan, parseCodexLimits, parseCodexUsage } from "../extensions/codex-accounts/parse-limits.ts";
import { limitsReport } from "../extensions/codex-accounts/index.ts";
import { accountLimits, NO_LOGIN_ERROR, presentAccounts } from "../extensions/codex-accounts/status.ts";
import {
	DEFAULT_CODEX_ACCOUNTS,
	validateCodexAccounts,
} from "../extensions/codex-accounts/settings.ts";

const accounts = [
	{ provider: "openai-codex", label: "Codex 1" },
	{ provider: "openai-codex-2", label: "Codex 2" },
];

test("defines three default Codex accounts", () => {
	assert.deepEqual(DEFAULT_CODEX_ACCOUNTS, [...accounts, { provider: "openai-codex-3", label: "Codex 3" }]);
});

test("accepts additional numbered Codex providers", () => {
	const settings = validateCodexAccounts({
		accounts: [...accounts, { provider: "openai-codex-3", label: "Codex 3" }],
	});
	assert.equal(settings.accounts[2].provider, "openai-codex-3");
});

test("rejects duplicate and malformed provider ids", () => {
	assert.throws(() => validateCodexAccounts({ accounts: [accounts[0], accounts[0]] }), /unique/);
	assert.throws(() => validateCodexAccounts({ accounts: [accounts[0], { provider: "codex-2", label: "bad" }] }), /invalid/);
});

test("rejects a secondary OAuth credential that duplicates the primary", () => {
	const stored = new Map([["openai-codex", { accountId: "primary-account" }]]);
	assert.throws(
		() => assertUniqueAccountIdentity(
			"primary-account",
			accounts[1],
			accounts,
			(provider) => stored.get(provider),
		),
		/already used by Codex 1/,
	);
});

test("accepts distinct primary and secondary OAuth credentials", () => {
	const stored = new Map([["openai-codex", { accountId: "primary-account" }]]);
	assert.doesNotThrow(() => assertUniqueAccountIdentity(
		"secondary-account",
		accounts[1],
		accounts,
		(provider) => stored.get(provider),
	));
});

test("parses current Codex limit windows", () => {
	const windows = parseCodexLimits({
		rate_limit: {
			primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
			secondary_window: { percent_left: 80, limit_window_seconds: 604_800, reset_time_ms: 1_800_000_000_000 },
		},
	});
	assert.deepEqual(windows.map(({ label, usedPercent, remainingPercent }) => ({ label, usedPercent, remainingPercent })), [
		{ label: "5h", usedPercent: 35, remainingPercent: 65 },
		{ label: "7d", usedPercent: 20, remainingPercent: 80 },
	]);
	assert.equal(windows[0].resetsAt?.toISOString(), "2027-01-15T08:00:00.000Z");
});

// Weekly-only Pro API shape: `prolite`,
// one 604800-second window in `primary_window`, and a null `secondary_window`.
const weeklyOnlyPro = (used: number, plan = "prolite") => ({
	plan_type: plan,
	rate_limit: { allowed: true, limit_reached: used >= 100,
		primary_window: { used_percent: used, limit_window_seconds: 604_800, reset_after_seconds: 3_600, reset_at: 1_800_000_000 },
		secondary_window: null },
});
// Known API shape (as in the pi-quotas fixtures): a 5h primary and a 7d secondary window.
const plusMixed = { plan_type: "plus", rate_limit: {
	primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
	secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
} };
const shape = (usage: ReturnType<typeof parseCodexUsage>) => ({ plan: usage.plan, windows: usage.windows.map((w) => [w.label, w.remainingPercent, w.unavailable ?? false]) });

test("a weekly-only Pro payload yields one 7d window and its plan", () => {
	const usage = parseCodexUsage(weeklyOnlyPro(100));
	assert.deepEqual(shape(usage), { plan: "pro_lite", windows: [["7d", 0, false]] });
	assert.equal(usage.windows[0].seconds, 604_800);
	assert.equal(usage.windows[0].resetsAt?.toISOString(), "2027-01-15T08:00:00.000Z");
});

test("a weekly-only window in the secondary slot yields one 7d window", () => {
	// Synthetic secondary-only case, not verified against the API. The slot never implies a duration.
	const usage = parseCodexUsage({ plan_type: "pro", rate_limit: { primary_window: null, secondary_window: { used_percent: 25, limit_window_seconds: 604_800 } } });
	assert.deepEqual(shape(usage), { plan: "pro", windows: [["7d", 75, false]] });
});

test("a mixed Plus payload keeps its real short and weekly windows", () => {
	assert.deepEqual(shape(parseCodexUsage(plusMixed)), { plan: "plus", windows: [["5h", 65, false], ["7d", 80, false]] });
});

test("windows sort by reported duration, not by response slot", () => {
	const usage = parseCodexUsage({ rate_limit: {
		primary_window: { used_percent: 10, limit_window_seconds: 604_800 },
		secondary_window: { used_percent: 30, limit_window_seconds: 18_000 },
	} });
	assert.deepEqual(usage.windows.map((w) => w.label), ["5h", "7d"]);
});

test("does not invent a 5h label or a weekly placeholder when the duration is absent", () => {
	const windows = parseCodexLimits({ rate_limit: { primary_window: { percent_left: 50 } } });
	assert.deepEqual(windows.map(({ label, remainingPercent, unavailable }) => ({ label, remainingPercent, unavailable })), [
		{ label: "window", remainingPercent: 50, unavailable: undefined },
	]);
});

test("legacy key names keep the duration they state", () => {
	assert.deepEqual(parseCodexLimits({ rate_limit: { weekly_limit: { used_percent: 40 } } }).map((w) => w.label), ["7d"]);
	assert.deepEqual(parseCodexLimits({ rate_limits: { five_hour: { used_percent: 40 }, weekly: { used_percent: 1 } } }).map((w) => w.label), ["5h", "7d"]);
});

test("malformed durations fall back to a neutral label and other durations keep their size", () => {
	const label = (limit_window_seconds: unknown) => parseCodexLimits({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds } } })[0].label;
	for (const bad of ["abc", "", -5, 0, 1.5, Number.NaN, 10 ** 12, null, {}]) assert.equal(label(bad), "window", String(bad));
	assert.equal(label("604800"), "7d");
	assert.equal(label(86_400), "1d");
	assert.equal(label(2_592_000), "30d");
	assert.equal(label(5_400), "90m");
	assert.equal(label(3_601), "window");
});

test("malformed percentages stay unavailable and are never fabricated", () => {
	for (const used_percent of ["not numeric", "", null, Number.POSITIVE_INFINITY, {}]) {
		const [window] = parseCodexLimits({ rate_limit: { primary_window: { used_percent, limit_window_seconds: 604_800 } } });
		assert.deepEqual([window.label, window.unavailable, window.remainingPercent], ["7d", true, 0]);
	}
	assert.deepEqual(parseCodexLimits({ rate_limit: { primary_window: { used_percent: 140, limit_window_seconds: 18_000 } } })[0].remainingPercent, 0);
	assert.deepEqual(parseCodexLimits({}), []);
	assert.deepEqual(parseCodexLimits(null), []);
});

test("plans are normalized through an allowlist and server strings never pass through", () => {
	assert.equal(normalizeCodexPlan("pro"), "pro");
	assert.equal(normalizeCodexPlan("ProLite"), "pro_lite");
	assert.equal(normalizeCodexPlan("pro_lite"), "pro_lite");
	assert.equal(normalizeCodexPlan("PLUS"), "plus");
	assert.equal(normalizeCodexPlan("self_serve_business_usage_based"), "business");
	assert.equal(normalizeCodexPlan(undefined), undefined);
	assert.equal(normalizeCodexPlan(null), undefined);
	assert.equal(normalizeCodexPlan(42), "unknown");
	assert.equal(normalizeCodexPlan("__proto__"), "unknown");
	assert.equal(normalizeCodexPlan("constructor"), "unknown");
	const secret = parseCodexUsage({ plan_type: "Bearer sk-private-token user@example.com", rate_limit: plusMixed.rate_limit });
	assert.equal(secret.plan, "unknown");
	assert.ok(!JSON.stringify(secret).includes("private"));
	assert.equal("plan" in parseCodexUsage({ rate_limit: plusMixed.rate_limit }), false);
});

test("the limits report shows the plan and only reported windows", () => {
	const report = limitsReport([
		{ account: accounts[0], result: { success: true, ...parseCodexUsage(weeklyOnlyPro(40)) } },
		{ account: accounts[1], result: { success: true, ...parseCodexUsage(plusMixed) } },
		{ account: { provider: "openai-codex-3", label: "Codex 3" }, result: { success: true, ...parseCodexUsage({ plan_type: "mystery", rate_limit: {} }) } },
		{ account: { provider: "openai-codex-4", label: "Codex 4" }, result: { success: false, error: "HTTP 401" } },
	]);
	assert.match(report, /\| Codex 1 \| Pro Lite \| 7d \| 40% \| 60% \|/);
	assert.match(report, /\| Codex 2 \| Plus \| 5h \| 35% \| 65% \|/);
	assert.match(report, /\| Codex 2 \| Plus \| 7d \| 20% \| 80% \|/);
	assert.match(report, /\| Codex 3 \| unrecognized \| none \|/);
	assert.match(report, /\| Codex 4 \| — \| error \|.*HTTP 401/);
	assert.doesNotMatch(report, /Codex 1 \| [^|]+ \| 5h/);
	assert.doesNotMatch(report, /mystery/);
});

test("accepts an absolute tokenFile and rejects a relative one", () => {
	const settings = validateCodexAccounts({ accounts: [accounts[0], { ...accounts[1], tokenFile: "/path/to/gateway/codex2/auth.json" }] });
	assert.equal(settings.accounts[1].tokenFile, "/path/to/gateway/codex2/auth.json");
	assert.equal("tokenFile" in settings.accounts[0], false);
	assert.throws(() => validateCodexAccounts({ accounts: [accounts[0], { ...accounts[1], tokenFile: "codex2/auth.json" }] }), /absolute/);
});

test("preferredAccount has no default and accepts only a gateway account name", () => {
	assert.equal("preferredAccount" in validateCodexAccounts({ accounts }), false);
	assert.equal(validateCodexAccounts({ accounts, preferredAccount: "codex1" }).preferredAccount, "codex1");
	for (const bad of ["", "codex0", "Codex 1", "openai-codex", 2]) {
		assert.throws(() => validateCodexAccounts({ accounts, preferredAccount: bad }), /preferredAccount/);
	}
});

test("reads LiteLLM and Codex CLI token files and skips expired ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-token-"));
	const write = (name: string, data: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(data)); return path; };
	const now = 1_800_000_000_000;
	assert.deepEqual(readTokenFile(write("litellm.json", { access_token: "a", account_id: "acct", expires_at: now / 1000 + 60 }), now), { access: "a", accountId: "acct" });
	assert.deepEqual(readTokenFile(write("cli.json", { tokens: { access_token: "b", account_id: "acct" } }), now), { access: "b", accountId: "acct" });
	assert.equal(readTokenFile(write("expired.json", { access_token: "a", account_id: "acct", expires_at: now / 1000 - 1 }), now), undefined);
	assert.equal(readTokenFile(join(dir, "missing.json"), now), undefined);
});

test("a token file replaces the Pi login for presence and limits", async () => {
	const withFile = { ...accounts[1], tokenFile: "/tokens/codex2/auth.json" };
	const staleLogin = () => ({ type: "oauth", access: "stale", expires: Date.now() + 60_000 });
	assert.deepEqual(presentAccounts([withFile], staleLogin, () => false), []);
	assert.deepEqual(presentAccounts([withFile], () => undefined, () => true), [withFile]);

	const calls: unknown[][] = [];
	const fetchLimits = async (...args: unknown[]) => { calls.push(args.slice(1)); return { success: true as const, windows: [] }; };
	const signal = new AbortController().signal;
	await accountLimits(withFile, signal, fetchLimits, () => ({ access: "fresh", accountId: "acct" }), staleLogin);
	assert.deepEqual(calls, [["fresh", signal, "acct"]]);
	assert.deepEqual(await accountLimits(withFile, signal, fetchLimits, () => undefined, staleLogin),
		{ success: false, error: "Token file unreadable or expired" });
	await accountLimits(accounts[1], signal, fetchLimits, () => undefined, staleLogin);
	assert.deepEqual(calls.at(-1), ["stale", signal]);
});

test("a token file with empty values is no login; an expired or unreadable file is not", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-nologin-"));
	const write = (name: string, data: string) => { const path = join(dir, name); writeFileSync(path, data); return path; };
	const now = 1_800_000_000_000;
	for (const [name, data] of [["empty", { access_token: "", account_id: "" }], ["null", { access_token: null, account_id: null }], ["bare", {}],
		["cli", { tokens: { access_token: "", account_id: null } }], ["half", { access_token: "a", account_id: "" }]] as const) {
		const path = write(`${name}.json`, JSON.stringify(data));
		assert.equal(tokenFileNoLogin(path), true, name);
		assert.equal(readTokenFile(path, now), undefined, name);
	}
	assert.equal(tokenFileNoLogin(write("expired.json", JSON.stringify({ access_token: "a", account_id: "acct", expires_at: now / 1000 - 1 }))), false);
	assert.equal(tokenFileNoLogin(write("valid.json", JSON.stringify({ access_token: "a", account_id: "acct" }))), false);
	assert.equal(tokenFileNoLogin(write("broken.json", "{ not json")), false);
	assert.equal(tokenFileNoLogin(write("array.json", "[]")), false);
	assert.equal(tokenFileNoLogin(join(dir, "missing.json")), false);
});

test("no login differs from an expired token, and never sends a request", async () => {
	const withFile = { provider: "openai-codex-3", label: "Codex 3", tokenFile: "/tokens/codex3/auth.json" };
	let calls = 0;
	const fetchLimits = async () => { calls++; return { success: true as const, windows: [] }; };
	const signal = new AbortController().signal;
	assert.deepEqual(await accountLimits(withFile, signal, fetchLimits, () => undefined, () => undefined, () => true), { success: false, error: NO_LOGIN_ERROR });
	assert.deepEqual(await accountLimits(withFile, signal, fetchLimits, () => undefined, () => undefined, () => false),
		{ success: false, error: "Token file unreadable or expired" }, "an expired token keeps the credential error");
	assert.deepEqual(await accountLimits(accounts[1], signal, fetchLimits, () => undefined, () => undefined), { success: false, error: NO_LOGIN_ERROR });
	assert.equal(calls, 0);
});

test("an account with no credential is hidden with the package default and listed with an explicit settings file", () => {
	const three = [...accounts, { provider: "openai-codex-3", label: "Codex 3" }];
	const read = (p: string) => p === "openai-codex-3" ? undefined : { type: "oauth" };
	assert.deepEqual(presentAccounts(three, read, () => false).map(a => a.provider), ["openai-codex", "openai-codex-2"]);
	assert.deepEqual(presentAccounts(three, read, () => false, true).map(a => a.provider), ["openai-codex", "openai-codex-2", "openai-codex-3"]);
	// A token file setting decides alone, also in an explicit file: a missing file stays hidden.
	assert.deepEqual(presentAccounts([{ ...three[2], tokenFile: "/tokens/codex3/auth.json" }], read, () => false, true), []);
	const dir = mkdtempSync(join(tmpdir(), "codex-settings-"));
	assert.equal(loadCodexAccountsSettings(join(dir, "missing.json")).explicit, undefined);
	assert.equal(loadCodexAccountsSettings(join(dir, "missing.json")).accounts.length, 3);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ accounts: three }));
	assert.equal(loadCodexAccountsSettings(join(dir, "settings.json")).explicit, true);
});

test("the limits report names an account with no login", () => {
	const report = limitsReport([{ account: { provider: "openai-codex-3", label: "Codex 3" }, result: { success: false, error: NO_LOGIN_ERROR } }]);
	assert.match(report, /\| Codex 3 \| — \| no login \|/);
	assert.doesNotMatch(report, /error/);
});
