import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { presentAccounts } from "../extensions/codex-accounts/status.ts";
import { copilotProvider, detectCopilotCredentials, isGitHubToken } from "../extensions/copilot-usage/detect.ts";
import { parseCopilotSettings } from "../extensions/copilot-usage/settings.ts";
import { createCopilotStatus, probeCopilot, type CopilotStatusSnapshot } from "../extensions/copilot-usage/status.ts";
import { fetchCopilotUsage, parseCopilotUsage } from "../extensions/copilot-usage/usage.ts";
import { copilotStatus } from "../extensions/ops-footer/adapters.ts";
import { dashboardRows, dashboardSections, detailedReport } from "../extensions/ops-footer/render.ts";
import { defaults } from "../extensions/ops-footer/settings.ts";
import { buildView } from "../extensions/ops-footer/view.ts";
import { contextStub, healthy, NOW } from "./footer-fixtures.ts";

const TOKEN_A = `gho_${"a".repeat(36)}`, TOKEN_B = `ghu_${"b".repeat(36)}`;
const PAID = {
	copilot_plan: "individual", quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
	quota_snapshots: {
		chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
		completions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 },
		premium_interactions: { unlimited: false, entitlement: 300, remaining: 250, quota_remaining: 250.5, percent_remaining: 83.5, overage_permitted: false },
	},
};
const FREE = { access_type_sku: "free_limited_copilot", limited_user_reset_date: "2026-10-05", limited_user_quotas: { chat: 10, completions: 1500 }, monthly_quotas: { chat: 50, completions: 2000 } };

test("parses paid quota snapshots and drops unlimited buckets", () => {
	const usage = parseCopilotUsage(PAID);
	assert.equal(usage.plan, "individual");
	assert.deepEqual(usage.windows.map(w => w.label), ["premium"]);
	assert.equal(usage.windows[0].remainingPercent, 83.5);
	assert.equal(usage.windows[0].entitlement, 300);
	assert.equal(usage.windows[0].resetsAt, "2026-10-01T00:00:00.000Z");
});

test("parses the free plan from limited and monthly quotas", () => {
	const usage = parseCopilotUsage(FREE);
	assert.equal(usage.plan, "free");
	assert.deepEqual(usage.windows.map(w => [w.label, w.remainingPercent]), [["chat", 20], ["compl", 75]]);
	assert.equal(usage.windows[0].resetsAt, "2026-10-05T00:00:00.000Z");
});

test("detects credentials in priority order without duplicates", async () => {
	const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
	try {
		mkdirSync(join(home, ".config", "github-copilot"), { recursive: true });
		writeFileSync(join(home, ".config", "github-copilot", "apps.json"), JSON.stringify({ "github.com:Iv1.x": { user: "someone", oauth_token: TOKEN_B } }));
		const found = await detectCopilotCredentials({
			home, env: { GH_TOKEN: TOKEN_A }, platform: "darwin",
			readPiCredential: () => ({ type: "oauth", refresh: TOKEN_A, access: "tid=x;exp=1", expires: 0 }),
			ghToken: async () => TOKEN_B,
		});
		assert.deepEqual(found.map(c => c.source), ["pi", "editor"]);
		assert.equal(found[0].domain, "github.com");
		const none = await detectCopilotCredentials({ home: join(home, "missing"), env: {}, readPiCredential: () => undefined, ghToken: async () => undefined });
		assert.deepEqual(none, []);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("enterprise Pi logins use the enterprise API host", async () => {
	const [credential] = await detectCopilotCredentials({ env: {}, sources: ["pi"], readPiCredential: () => ({ type: "oauth", refresh: TOKEN_A, enterpriseUrl: "https://acme.ghe.com" }) });
	let url = "";
	const fetcher = (async (input: string | URL) => { url = String(input); return new Response(JSON.stringify(PAID)); }) as typeof fetch;
	const result = await fetchCopilotUsage(credential, undefined, fetcher);
	assert.equal(url, "https://api.acme.ghe.com/copilot_internal/user");
	assert.equal(result.success, true);
});

test("token shape check rejects prose and accepts GitHub token prefixes", () => {
	assert.equal(isGitHubToken(TOKEN_A), true);
	assert.equal(isGitHubToken("not a token"), false);
	assert.equal(isGitHubToken(`sk-${"a".repeat(40)}`), false);
});

test("probe falls through rejected tokens and stops on a network failure", async () => {
	const detect = { env: { COPILOT_GITHUB_TOKEN: TOKEN_A, GH_TOKEN: TOKEN_B }, sources: ["env" as const] };
	const calls: string[] = [];
	const ok = await probeCopilot(detect, new AbortController().signal, async c => {
		calls.push(c.detail);
		return c.token === TOKEN_A ? { success: false, error: "HTTP 404", auth: true } : { success: true, usage: parseCopilotUsage(PAID) };
	});
	assert.deepEqual(calls, ["COPILOT_GITHUB_TOKEN", "GH_TOKEN"]);
	assert.equal(ok.credential?.detail, "GH_TOKEN");
	const down = await probeCopilot(detect, new AbortController().signal, async () => ({ success: false, error: "Network request failed", auth: false }));
	assert.equal(down.tried.length, 1);
});

test("a GitHub token alone never turns the meter on", async () => {
	let calls = 0;
	const fetcher = async () => { calls++; return { success: true as const, usage: parseCopilotUsage(PAID) }; };
	const status = createCopilotStatus({ settings: () => parseCopilotSettings({}), emit: () => {}, fetcher,
		detect: () => ({ env: { GITHUB_TOKEN: TOKEN_A, GH_TOKEN: TOKEN_B }, readPiCredential: () => undefined, readPiSettings: () => ({ defaultProvider: "openai-codex" }), ghToken: async () => TOKEN_A }) });
	assert.equal((await status.refresh(true)).state, "absent");
	assert.equal(calls, 0, "no request without a configured Copilot provider");
	assert.match(status.report(), /not configured in Pi/);
});

test("Copilot provider signals: Pi login, COPILOT_GITHUB_TOKEN, default provider, enabled models", () => {
	assert.equal(copilotProvider({ env: {}, readPiCredential: () => ({ type: "oauth", refresh: TOKEN_A }) }), "Pi github-copilot login");
	assert.equal(copilotProvider({ env: { COPILOT_GITHUB_TOKEN: TOKEN_A } }), "COPILOT_GITHUB_TOKEN");
	assert.equal(copilotProvider({ env: {}, readPiSettings: () => ({ defaultProvider: "github-copilot" }) }), "Pi default provider");
	assert.equal(copilotProvider({ env: {}, readPiSettings: () => ({ enabledModels: ["github-copilot/claude-sonnet-5"] }) }), "Pi enabled models");
	assert.equal(copilotProvider({ env: { GITHUB_TOKEN: TOKEN_A, GH_TOKEN: TOKEN_A }, readPiSettings: () => ({ defaultProvider: "openai-codex", enabledModels: ["openai-codex/gpt-6-sol"] }) }), undefined);
});

test("a configured provider that yields no quota shows an error; off and absent stay silent", async () => {
	const events: CopilotStatusSnapshot[] = [];
	const reject = async () => ({ success: false as const, error: "HTTP 401", auth: true });
	const loud = createCopilotStatus({ settings: () => parseCopilotSettings({}), detect: () => ({ env: {}, sources: ["pi"], readPiCredential: () => ({ type: "oauth", refresh: TOKEN_A }) }), emit: (_e, v) => events.push(v as CopilotStatusSnapshot), fetcher: reject });
	assert.equal((await loud.refresh(true)).state, "error");
	const forced = createCopilotStatus({ settings: () => parseCopilotSettings({ mode: "on" }), detect: () => ({ env: { GH_TOKEN: TOKEN_A }, sources: ["env"] }), emit: () => {}, fetcher: reject });
	assert.equal((await forced.refresh(true)).state, "error", "mode on probes generic GitHub tokens too");
	const off = createCopilotStatus({ settings: () => parseCopilotSettings({ mode: "off" }), detect: () => ({ env: { COPILOT_GITHUB_TOKEN: TOKEN_A } }), emit: () => {}, fetcher: reject });
	assert.equal((await off.refresh(true)).state, "absent");
	assert.ok(!JSON.stringify(events).includes(TOKEN_A), "tokens never cross the event bus");
});

test("footer shows a Copilot chip after the Codex accounts and hides it when absent", async () => {
	const status = createCopilotStatus({ settings: () => parseCopilotSettings({}), detect: () => ({ env: { COPILOT_GITHUB_TOKEN: TOKEN_A }, sources: ["env"] }), emit: () => {}, clock: () => NOW,
		fetcher: async () => ({ success: true, usage: parseCopilotUsage(PAID) }) });
	const snapshot = await status.refresh(true);
	const data = healthy();
	data.copilot = copilotStatus(snapshot, NOW);
	assert.ok(data.copilot);
	const view = buildView(data, contextStub().state(), defaults, NOW);
	assert.deepEqual(view.quota?.accounts.map(a => a.label), ["Codex1", "Codex2", "Copilot"]);
	const rows = dashboardRows(data, contextStub(), defaults, 200, undefined, NOW).map(stripTerminalSequences).join("\n");
	assert.match(rows, /Copilot \[premium 84%\]/);
	assert.match(rows, /^Codex2 .*◂ routed$/m, "the route marks the Codex row it names");
	assert.doesNotMatch(rows, /^Copilot .*(routed|→)/m, "the Copilot row never carries the Codex route");
	assert.match(detailedReport(data, contextStub(), NOW), /Copilot: ok; premium 84% \(50\/300 used\)/);
	assert.equal(copilotStatus({ ...snapshot, state: "absent", windows: [] }, NOW), undefined);
	// A Copilot-only machine: no Codex group at all.
	data.limits = undefined;
	const alone = dashboardRows(data, contextStub(), defaults, 120, undefined, NOW).map(stripTerminalSequences).join("\n");
	assert.match(alone, /Copilot \[premium 84%\]/);
	assert.doesNotMatch(alone, /Codex/);
	const { below } = dashboardSections(data, contextStub(), defaults, 120, undefined, NOW);
	assert.equal(below.length, 2, "location row and one Copilot row");
	assert.match(stripTerminalSequences(below[1]), /^Copilot \[premium 84%\]/);
});

test("low Copilot premium quota raises a quota alert", () => {
	const data = healthy();
	data.copilot = copilotStatus({ checkedAt: NOW, staleAfter: 600_000, state: "ok", windows: [{ label: "premium", remainingPercent: 5, remaining: 15, entitlement: 300 }] }, NOW);
	const view = buildView(data, contextStub().state(), defaults, NOW);
	assert.ok(view.alerts.some(a => a.key === "quota:Copilot:premium:exhausted"));
});

test("Codex accounts without a stored login are omitted", () => {
	const accounts = [{ provider: "openai-codex", label: "Codex 1" }, { provider: "openai-codex-2", label: "Codex 2" }];
	assert.deepEqual(presentAccounts(accounts, p => p === "openai-codex-2" ? { type: "oauth" } : undefined).map(a => a.provider), ["openai-codex-2"]);
	assert.deepEqual(presentAccounts(accounts, () => undefined), []);
});
