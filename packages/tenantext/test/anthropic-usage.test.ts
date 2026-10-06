import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { claudeCredentialsPath, detectAnthropicCredentials, normalizePlan } from "../extensions/anthropic-usage/detect.ts";
import { loadAnthropicSettings, parseAnthropicSettings } from "../extensions/anthropic-usage/settings.ts";
import { ANTHROPIC_STATUS_EVENT, CACHED_READING_MS, createAnthropicStatus, type AnthropicStatusSnapshot } from "../extensions/anthropic-usage/status.ts";
import { ANTHROPIC_USAGE_URL, fetchAnthropicUsage, parseAnthropicUsage, resetDate } from "../extensions/anthropic-usage/usage.ts";
import { runChecks } from "../extensions/doctor/checks.ts";
import { anthropicStatus, codexStatus, copilotStatus, freshness } from "../extensions/ops-footer/adapters.ts";
import { layouts } from "../extensions/ops-footer/layouts/index.ts";
import { dashboardRows, detailedReport, droppedQuotaAccounts } from "../extensions/ops-footer/render.ts";
import { ansiPaint } from "../extensions/ops-footer/paint.ts";
import { quotaLifetimeFloor } from "../extensions/ops-footer/runtime.ts";
import { defaults } from "../extensions/ops-footer/settings.ts";
import { buildView } from "../extensions/ops-footer/view.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropic, codexNoLogin, contextStub, copilot, fixtures, healthy, integration, NOW } from "./footer-fixtures.ts";

// Sentinel values, built in parts. They are not credentials. No test may show them in a snapshot, a report or a row.
const SENTINEL = ["sk", "ant", "oat01", "SENTINEL".repeat(4)].join("-"), SENTINEL_PI = ["sk", "ant", "oat01", "PISENTINEL".repeat(3)].join("-");
const HOME = "/home/fixture";
const claudeFile = (oauth: unknown) => () => ({ claudeAiOauth: oauth });
const login = (extra: Record<string, unknown> = {}) => ({ accessToken: SENTINEL, expiresAt: NOW + 3_600_000, subscriptionType: "max", rateLimitTier: "ignored", ...extra });
// The shape of the endpoint, with fixture numbers. `resets_at` has an offset and microseconds.
const PAYLOAD = {
	five_hour: { utilization: 28, resets_at: "2026-09-22T10:12:00.123456+00:00" },
	seven_day: { utilization: 59.5, resets_at: "2026-09-26T09:00:00.000000+02:00" },
	seven_day_opus: { utilization: 45, resets_at: "2026-09-26T09:00:00.000000+02:00" },
	seven_day_sonnet: null,
	seven_day_oauth_apps: null, extra_usage: { is_enabled: false, monthly_limit: null }, note: "ignored free text",
};
const settings = parseAnthropicSettings({});
const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const all = { ...defaults, maximumRows: 12 };
const rowsOf = (data: ReturnType<typeof healthy>, width = 200) => dashboardRows(data, contextStub(), all, width, undefined, NOW).map(stripTerminalSequences);

test("parses the usage payload: remaining percent, clamped, null windows dropped, other keys ignored", () => {
	const usage = parseAnthropicUsage(PAYLOAD);
	assert.deepEqual(usage.windows.map(w => [w.label, w.remainingPercent]), [["5h", 72], ["7d", 40.5], ["opus", 55]]);
	assert.equal(usage.windows[0].resetsAt, "2026-09-22T10:12:00.123Z", "microseconds and offset become toISOString");
	assert.equal(usage.windows[1].resetsAt, "2026-09-26T07:00:00.000Z");
	assert.ok(!JSON.stringify(usage).includes("ignored"));
	assert.deepEqual(parseAnthropicUsage({ five_hour: { utilization: 140 }, seven_day: { utilization: -5 } }).windows.map(w => w.remainingPercent), [0, 100]);
	assert.equal(resetDate("soon"), undefined);
	assert.equal(resetDate("2026-09-22T10:12:00Z"), "2026-09-22T10:12:00.000Z");
});

test("a malformed payload yields no window and no payload text", () => {
	for (const bad of [null, [], "text", 42, {}, { five_hour: null, seven_day: null }, { five_hour: "Bearer leaked", seven_day: { utilization: "59" } },
		{ five_hour: { utilization: Number.NaN }, seven_day: { resets_at: "2026-09-26T09:00:00Z" } }]) {
		assert.deepEqual(parseAnthropicUsage(bad), { windows: [] }, JSON.stringify(bad));
	}
});

test("detects the Claude Code login first, then the Pi OAuth login, and honours CLAUDE_CONFIG_DIR", () => {
	assert.equal(claudeCredentialsPath({}, HOME), "/home/fixture/.claude/.credentials.json");
	assert.equal(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: "/srv/claude" }, HOME), "/srv/claude/.credentials.json");
	const paths: string[] = [];
	const found = detectAnthropicCredentials({ env: { CLAUDE_CONFIG_DIR: "/srv/claude" }, home: HOME, now: NOW,
		readClaudeFile: path => { paths.push(path); return { claudeAiOauth: login() }; },
		readPiCredential: () => ({ type: "oauth", access: SENTINEL_PI, refresh: "unused", expires: NOW + 60_000 }) });
	assert.deepEqual(paths, ["/srv/claude/.credentials.json"]);
	assert.deepEqual(found.map(c => [c.source, c.plan]), [["claude-code", "max"], ["pi", undefined]]);
	assert.equal(normalizePlan("Team"), "team");
	assert.equal(normalizePlan("Bearer something"), undefined);
});

test("absent, expired and API-key credentials are absent", () => {
	const detect = (oauth: unknown, pi?: unknown) => detectAnthropicCredentials({ env: {}, home: HOME, now: NOW, readClaudeFile: claudeFile(oauth), readPiCredential: () => pi });
	assert.deepEqual(detect(undefined), []);
	assert.deepEqual(detectAnthropicCredentials({ env: {}, home: HOME, now: NOW, readClaudeFile: () => undefined }), [], "no file");
	assert.deepEqual(detectAnthropicCredentials({ env: {}, home: HOME, now: NOW, readClaudeFile: () => { throw new Error("unreadable"); } }), []);
	assert.deepEqual(detect(login({ expiresAt: NOW - 1 })), [], "a token past its expiry is absent");
	assert.deepEqual(detect(login({ expiresAt: undefined })), [], "an unknown expiry is not an active login");
	assert.deepEqual(detect(login({ accessToken: "" })), []);
	assert.deepEqual(detect(login({ accessToken: "has a space in the value" })), []);
	assert.deepEqual(detect(undefined, { type: "api_key", key: SENTINEL_PI }), [], "an API key has no subscription quota");
	assert.deepEqual(detect(undefined, { type: "oauth", access: SENTINEL_PI, expires: NOW - 1 }), []);
	assert.deepEqual(detect(undefined, { type: "oauth", access: SENTINEL_PI, expires: NOW + 1 }).map(c => c.source), ["pi"]);
});

test("the request is one read-only GET with the bearer header, and an error body is never read", async () => {
	const [credential] = detectAnthropicCredentials({ env: {}, home: HOME, now: NOW, readClaudeFile: claudeFile(login()) });
	const calls: { url: string; init: RequestInit }[] = [];
	const fetcher = (async (input: string | URL, init: RequestInit) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch;
	const ok = await fetchAnthropicUsage(credential, undefined, fetcher);
	assert.equal(ok.success, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, ANTHROPIC_USAGE_URL);
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.redirect, "error");
	assert.equal(calls[0].init.body, undefined);
	assert.deepEqual(calls[0].init.headers, { Accept: "application/json", "anthropic-beta": "oauth-2025-04-20", Authorization: `Bearer ${SENTINEL}` });
	assert.ok(!JSON.stringify(ok).includes(SENTINEL));
	const refused = await fetchAnthropicUsage(credential, undefined, respond({ error: { message: `token ${SENTINEL} refused` } }, 401));
	assert.deepEqual(refused, { success: false, error: "HTTP 401", auth: true });
	assert.deepEqual(await fetchAnthropicUsage(credential, undefined, respond({ error: "busy" }, 429)), { success: false, error: "HTTP 429", auth: false });
	assert.deepEqual(await fetchAnthropicUsage(credential, undefined, respond({ message: "private text" })), { success: false, error: "Usage payload not recognized", auth: false });
	assert.deepEqual(await fetchAnthropicUsage(credential, undefined, (async () => { throw new Error(`socket ${SENTINEL}`); }) as unknown as typeof fetch),
		{ success: false, error: "Network request failed", auth: false });
});

function service(options: { oauth?: unknown; pi?: unknown; fetcher: typeof fetch; mode?: string; clock?: () => number; pollSeconds?: number }) {
	const events: AnthropicStatusSnapshot[] = [];
	let requests = 0;
	const status = createAnthropicStatus({
		settings: () => parseAnthropicSettings({ mode: options.mode, pollSeconds: options.pollSeconds }), clock: options.clock ?? (() => NOW),
		detect: () => ({ env: {}, home: HOME, readClaudeFile: claudeFile(options.oauth), readPiCredential: () => options.pi }),
		emit: (event, value) => { assert.equal(event, ANTHROPIC_STATUS_EVENT); events.push(value as AnthropicStatusSnapshot); },
		fetcher: (credential, signal) => { requests++; return fetchAnthropicUsage(credential, signal, options.fetcher); },
	});
	return { status, events, requests: () => requests };
}

test("an active login publishes windows, plan and source, and never the token", async () => {
	const { status, events } = service({ oauth: login(), pi: { type: "oauth", access: SENTINEL_PI, expires: NOW + 60_000 }, fetcher: respond(PAYLOAD) });
	const snapshot = await status.refresh(true);
	assert.deepEqual({ state: snapshot.state, source: snapshot.source, plan: snapshot.plan, windows: snapshot.windows.map(w => w.label) },
		{ state: "ok", source: "claude-code", plan: "max", windows: ["5h", "7d", "opus"] });
	assert.equal(snapshot.staleAfter, settings.pollSeconds * 2000);
	const data = healthy();
	data.anthropic = anthropicStatus(events.at(-1), NOW);
	const text = [JSON.stringify(events), JSON.stringify(data.anthropic), status.report(), detailedReport(data, contextStub(), NOW), ...rowsOf(data)].join("\n");
	for (const secret of [SENTINEL, SENTINEL_PI, "SENTINEL", "ignored free text"]) assert.ok(!text.includes(secret), secret);
	assert.match(status.report(), /Source: Claude Code login\. Plan: max\./);
	assert.match(status.report(), /\| 5h \| 28% \| 72% \| 2026-09-22T10:12:00\.123Z \|/);
});

test("absent, expired and API-key credentials send no request and give no row", async () => {
	for (const [name, oauth, pi] of [["absent", undefined, undefined], ["expired", login({ expiresAt: NOW - 1 }), { type: "oauth", access: SENTINEL_PI, expires: NOW - 1 }],
		["api key", undefined, { type: "api_key", key: SENTINEL_PI }]] as const) {
		const { status, events, requests } = service({ oauth, pi, fetcher: respond(PAYLOAD) });
		const snapshot = await status.refresh(true);
		assert.equal(snapshot.state, "absent", name);
		assert.equal(requests(), 0, name);
		assert.equal(anthropicStatus(events.at(-1), NOW), undefined, name);
		const data = healthy(); data.anthropic = anthropicStatus(events.at(-1), NOW);
		assert.doesNotMatch(rowsOf(data).join("\n"), /Claude/, name);
		assert.ok(!JSON.stringify(events).includes("SENTINEL"), name);
	}
});

test("a malformed payload and a refused login give no row and leak no text; mode on gives an error chip", async () => {
	for (const fetcher of [respond({ five_hour: `leak ${SENTINEL}`, message: "private payload text" }), respond({ error: "private payload text" }, 401), respond("private payload text", 500)]) {
		const { status, events } = service({ oauth: login(), fetcher });
		assert.equal((await status.refresh(true)).state, "absent");
		const data = healthy(); data.anthropic = anthropicStatus(events.at(-1), NOW);
		const text = [JSON.stringify(events), status.report(), detailedReport(data, contextStub(), NOW), ...rowsOf(data)].join("\n");
		assert.doesNotMatch(rowsOf(data).join("\n"), /Claude/);
		assert.ok(!text.includes("private") && !text.includes("SENTINEL"));
	}
	const loud = service({ oauth: login(), fetcher: respond({}, 401), mode: "on" });
	assert.equal((await loud.status.refresh(true)).state, "error");
	const data = healthy(); data.anthropic = anthropicStatus(loud.events.at(-1), NOW);
	assert.match(rowsOf(data).join("\n"), /^Claude +✗ error$/m);
	const off = service({ oauth: login(), fetcher: respond(PAYLOAD), mode: "off" });
	assert.equal((await off.status.refresh(true)).state, "absent");
	assert.equal(off.requests(), 0);
});

test("an hourly Claude poll is never stale in the footer: before, during and after the refresh", async () => {
	let now = NOW;
	const fetcher = (async () => new Response(JSON.stringify(PAYLOAD))) as unknown as typeof fetch;
	const { status, requests } = service({ oauth: login({ expiresAt: NOW + 5 * 3_600_000 }), fetcher, clock: () => now, pollSeconds: 3600 });
	const floor = quotaLifetimeFloor(defaults);
	let reading = anthropicStatus(await status.refresh(), now, floor)!;
	assert.equal(reading.staleAfter, 7_200_000, "two times the poll time passes the footer cap");
	// The footer asks one time a minute. A fetch takes two seconds, so a new reading lands two seconds after the request.
	for (let minute = 1; minute <= 180; minute++) {
		now = NOW + minute * 60_000 + 2000;
		assert.equal(freshness(reading, now), "fresh", `minute ${minute}, just before the answer to this request`);
		reading = anthropicStatus(await status.refresh(), now, floor)!;
		assert.equal(freshness(reading, now), "fresh", `minute ${minute}, after the answer`);
	}
	assert.equal(requests(), 4, "the first reading and one fetch in each of the three hours");
});

test("a refused Claude Code login falls through to the Pi login; polls respect the interval and the turn minimum", async () => {
	let now = NOW;
	const fetcher = (async (_url: string, init: RequestInit) => (init.headers as Record<string, string>).Authorization === `Bearer ${SENTINEL}`
		? new Response("{}", { status: 401 }) : new Response(JSON.stringify(PAYLOAD))) as unknown as typeof fetch;
	const { status, requests } = service({ oauth: login(), pi: { type: "oauth", access: SENTINEL_PI, expires: NOW + 3_600_000 }, fetcher, clock: () => now });
	const snapshot = await status.refresh(true);
	assert.deepEqual([snapshot.state, snapshot.source, snapshot.plan], ["ok", "pi", undefined]);
	assert.equal(requests(), 2);
	now += 59_000; await status.refresh(false, 60_000);
	assert.equal(requests(), 2, "a settled turn refreshes at most once a minute");
	now += 2_000; await status.refresh(false, 60_000);
	assert.equal(requests(), 4);
	now += 200_000; await status.refresh();
	assert.equal(requests(), 4, "the poll interval is 300 seconds");
	assert.match(status.report(), /Tried Claude Code login \(\.credentials\.json claudeAiOauth\): HTTP 401\./);
});

test("the adapter whitelists every field of the Anthropic snapshot", () => {
	const snapshot = anthropicStatus({ checkedAt: NOW, staleAfter: 600_000, state: "ok", source: "claude-code", plan: "max", token: SENTINEL, error: "private text",
		windows: [{ label: "5h", remainingPercent: 72, resetsAt: "2026-09-22T10:12:00.123Z", note: "private text" }, { label: "7d", remainingPercent: 5 },
			{ label: "private window", remainingPercent: 50 }, { label: "opus", remainingPercent: "50" }] }, NOW)!;
	assert.deepEqual(snapshot.accounts, [{ label: "Claude", order: 900, state: "ok", plan: "max", windows: [
		{ name: "5h", percent: 72, unavailable: false, resetsAt: Date.parse("2026-09-22T10:12:00.123Z") }, { name: "7d", percent: 5, unavailable: false, resetsAt: undefined }] }]);
	assert.equal(snapshot.state, "warning");
	assert.ok(!JSON.stringify(snapshot).includes("private") && !JSON.stringify(snapshot).includes("SENTINEL"));
	const odd = anthropicStatus({ checkedAt: NOW, staleAfter: 1, state: "ok", source: "/home/fixture/.claude/.credentials.json", plan: "max_20x private", windows: [{ label: "5h", remainingPercent: 50 }] }, NOW)!;
	assert.deepEqual([odd.source, odd.plan, odd.accounts[0].plan], [undefined, undefined, undefined]);
	for (const plan of ["free", "pro", "max", "team", "enterprise"]) assert.equal(anthropicStatus({ state: "ok", plan, windows: [{ label: "5h", remainingPercent: 50 }] }, NOW)?.plan, plan);
	for (const bad of [undefined, null, "text", {}, { state: "absent", windows: [] }, { state: "ok", windows: [] }, { state: "ok", windows: [{ label: "private", remainingPercent: 1 }] }, { state: "ok", windows: "5h" }]) {
		assert.equal(anthropicStatus(bad, NOW), undefined, JSON.stringify(bad));
	}
});

test("three Codex accounts render in order, a no-login account says no login, and Claude sits between Codex and Copilot", () => {
	const limits = codexStatus({ checkedAt: NOW, staleAfter: 60_000, accounts: [
		{ provider: "openai-codex-3", label: "Codex 3", state: "unknown", login: false, windows: [] },
		{ provider: "openai-codex-2", label: "Codex 2", state: "ok", windows: [{ label: "5h", remainingPercent: 60 }, { label: "7d", remainingPercent: 60 }] },
		{ provider: "openai-codex", label: "Codex 1", state: "ok", windows: [{ label: "5h", remainingPercent: 80 }, { label: "7d", remainingPercent: 80 }] },
	], routing: { state: "unknown" } }, NOW)!;
	assert.deepEqual(limits.accounts.map(a => [a.label, a.login]), [["Codex1", undefined], ["Codex2", undefined], ["Codex3", false]]);
	assert.equal(limits.state, "ok", "no login is not a failure");
	assert.equal(codexStatus({ accounts: [{ provider: "openai-codex-3", state: "unknown", login: "false", windows: [] }] }, NOW)?.accounts[0].login, undefined, "only the literal boolean crosses");
	const data = healthy();
	data.limits = limits;
	data.copilot = copilotStatus({ checkedAt: NOW, staleAfter: 600_000, state: "ok", source: "pi", plan: "individual", windows: [{ label: "premium", remainingPercent: 83, remaining: 249, entitlement: 300 }] }, NOW);
	data.anthropic = anthropicStatus({ checkedAt: NOW, staleAfter: 600_000, state: "ok", source: "claude-code", plan: "max", windows: parseAnthropicUsage(PAYLOAD).windows }, NOW);
	const view = buildView(data, contextStub().state(), all, NOW);
	assert.deepEqual(view.quota?.accounts.map(a => [a.label, a.short]), [["Codex1", "C1"], ["Codex2", "C2"], ["Codex3", "C3"], ["Claude", "CL"], ["Copilot", "CP"]]);
	assert.deepEqual(view.alerts.filter(a => a.key.startsWith("quota:")), [], "no login raises no alert");
	const rows = rowsOf(data);
	const quota = rows.filter(r => /^(?:Codex\d|Claude|Copilot) /.test(r));
	assert.deepEqual(quota.map(r => r.split(" ")[0]), ["Codex1", "Codex2", "Codex3", "Claude", "Copilot"]);
	assert.match(quota[0], /^Codex1  \[5h 80%\] +\[7d 80%\]$/);
	assert.match(quota[2], /^Codex3  no login$/);
	assert.match(quota[3], /^Claude  \[5h 72%\] ↺ 3h 12m +\[7d 41%\] .*\[opus 55%\]/);
	assert.match(quota[4], /^Copilot \[premium 83%\]/);
	assert.doesNotMatch(rows.join("\n"), /✗/);
	const report = detailedReport(data, contextStub(), NOW);
	assert.match(report, /^Codex3: no login$/m);
	assert.match(report, /^ANTHROPIC: ok; .*\nsource:claude-code; plan:max\nClaude: ok; 5h 72% resets 2026-09-22T10:12:00\.123Z/m);
	assert.ok(report.indexOf("ANTHROPIC") < report.indexOf("COPILOT"));
	// The other layouts keep the same order and wording.
	for (const name of ["v2", "a", "b", "c"] as const) {
		const text = layouts[name](data, contextStub(), all, 200, undefined, NOW).below.map(stripTerminalSequences).join("\n");
		assert.ok(text.indexOf("C3") < text.indexOf("CL") || text.indexOf("Codex3") < text.indexOf("Claude"), name);
		assert.match(text, /no login/, name);
	}
});

test("the Codex route and the stale mark never go to the Claude row or to a no-login row", () => {
	const data = healthy();
	data.limits!.accounts.push(codexNoLogin());
	data.limits!.route = { state: "unknown", selected: "codex9" };
	data.anthropic = anthropic(); data.copilot = copilot();
	const rows = rowsOf(data);
	assert.match(rows.find(r => r.startsWith("Codex2"))!, /→ codex9$/, "the tail stays on the last Codex row that has a login");
	assert.doesNotMatch(rows.filter(r => /^(?:Codex3|Claude|Copilot)/.test(r)).join("\n"), /→|routed|stale/);
	// A machine with only a Claude login: one Claude row, no Codex text.
	data.limits = undefined; data.copilot = undefined;
	const alone = rowsOf(data, 120).join("\n");
	assert.match(alone, /^Claude \[5h 72%\]/m);
	assert.doesNotMatch(alone, /Codex|Copilot/);
	assert.match(detailedReport(healthy(), contextStub(), NOW), /ANTHROPIC not detected \(see \/anthropic-usage\)/);
});

test("a low Claude window raises a quota alert with the short label", () => {
	const data = healthy(); data.anthropic = anthropic(8);
	const alert = buildView(data, contextStub().state(), all, NOW).alerts.find(a => a.key === "quota:Claude:5h:exhausted");
	assert.equal(alert?.compact, "CL 5h 8%");
});

test("settings clamp the poll interval and the environment sets the mode", () => {
	assert.deepEqual(settings, { mode: "auto", sources: ["claude-code", "pi"], pollSeconds: 300 });
	assert.equal(parseAnthropicSettings({ pollSeconds: 1 }).pollSeconds, 60);
	assert.deepEqual(parseAnthropicSettings({ sources: ["pi", "other"], mode: "loud" }), { mode: "auto", sources: ["pi"], pollSeconds: 300 });
	assert.equal(loadAnthropicSettings("/nonexistent/anthropic-usage/settings.json", { TENANTEXT_ANTHROPIC_USAGE: "off" }).mode, "off");
});

test("the doctor reports the Anthropic meter from injected readers only", async () => {
	const base = { dir: "/nonexistent/agent", env: { HOME }, which: async () => true, readCredential: () => undefined };
	// The doctor uses the real clock, so this login expires one hour from now.
	const login = (extra: Record<string, unknown> = {}) => ({ accessToken: SENTINEL, expiresAt: Date.now() + 3_600_000, subscriptionType: "max", ...extra });
	let requests = 0;
	const counting = (async () => { requests++; return new Response(JSON.stringify(PAYLOAD)); }) as unknown as typeof fetch;
	const find = async (options: Parameters<typeof runChecks>[0]) => (await runChecks(options)).find(c => c.id === "anthropic")!;
	const none = await find({ ...base, readClaudeFile: () => undefined, fetcher: counting });
	assert.deepEqual([none.status, requests], ["info", 0]);
	const ok = await find({ ...base, readClaudeFile: claudeFile(login()), fetcher: counting });
	assert.equal(ok.status, "ok");
	assert.equal(ok.message, "Anthropic meter: Claude Code login, plan max, 5h 72%, 7d 41%, opus 55%.");
	const refused = await find({ ...base, readClaudeFile: claudeFile(login()), fetcher: respond({ error: `private ${SENTINEL}` }, 401) });
	assert.equal(refused.status, "warn");
	assert.match(refused.message, /Claude Code login: HTTP 401/);
	assert.ok(!refused.message.includes("private") && !refused.message.includes("SENTINEL"));
	assert.equal((await find({ ...base, readClaudeFile: claudeFile(login({ expiresAt: Date.now() - 1 })), fetcher: counting })).status, "info", "an expired login sends no request");
	assert.equal((await find({ ...base, env: { HOME, TENANTEXT_ANTHROPIC_USAGE: "off" }, readClaudeFile: claudeFile(login()), fetcher: counting })).status, "info");
	assert.equal(requests, 1);
});

const five = () => structuredClone(fixtures.find(f => f.name === "three codex, claude, copilot")!.data);
const quotaLines = (data: ReturnType<typeof healthy>, maximumRows: number, width = 160) =>
	dashboardRows(data, contextStub(), { ...defaults, maximumRows }, width, undefined, NOW).map(stripTerminalSequences).filter(r => /^(?:Codex\d|Claude|Copilot) /.test(r));

test("the default row budget of 8 shows five accounts in identity order with no hint", () => {
	assert.equal(defaults.maximumRows, 8);
	const rows = dashboardRows(five(), contextStub(), defaults, 160, undefined, NOW).map(stripTerminalSequences);
	assert.equal(rows.length, 8);
	assert.deepEqual(rows.slice(3).map(r => r.split(" ")[0]), ["Codex1", "Codex2", "Codex3", "Claude", "Copilot"]);
	assert.doesNotMatch(rows.join("\n"), /\+\d/);
	assert.deepEqual(droppedQuotaAccounts(five(), contextStub(), defaults, 160, NOW), []);
	assert.doesNotMatch(detailedReport(five(), contextStub(), NOW, { settings: defaults, width: 160 }), /Quota rows not shown/);
});

test("a budget of 6 rows drops the no-login row first, keeps identity order, and marks the last quota row", () => {
	const six = { ...defaults, maximumRows: 6 };
	const rows = quotaLines(five(), 6);
	assert.deepEqual(rows.map(r => r.split(" ")[0]), ["Codex1", "Codex2", "Claude"]);
	assert.match(rows[2], /^Claude .*\[sonnet 90%\].*  \+2$/, "the last quota row counts the dropped accounts");
	assert.doesNotMatch(rows.slice(0, 2).join("\n"), /\+\d/);
	assert.deepEqual(droppedQuotaAccounts(five(), contextStub(), six, 160, NOW), ["Codex3", "Copilot"]);
	assert.match(detailedReport(five(), contextStub(), NOW, { settings: six, width: 160 }), /^Quota rows not shown: Codex3, Copilot\. The row budget is maximumRows:6 in the ops-footer settings; a larger value shows them\.$/m);
	// The hint is dim text, not an alert.
	const color = dashboardRows(five(), contextStub(), six, 160, ansiPaint, NOW).at(-1)!;
	assert.ok(color.endsWith("\x1b[38;2;104;114;130m+2\x1b[39m"));
	// Seven rows: the no-login row still goes first, so Copilot shows and the hint is +1.
	assert.deepEqual(quotaLines(five(), 7).map(r => r.split(" ")[0]), ["Codex1", "Codex2", "Claude", "Copilot"]);
	assert.match(quotaLines(five(), 7).at(-1)!, /^Copilot \[premium 83%\].*  \+1$/);
	assert.deepEqual(droppedQuotaAccounts(five(), contextStub(), { ...defaults, maximumRows: 7 }, 160, NOW), ["Codex3"]);
	for (const width of [40, 60, 80, 100, 138, 200]) for (const maximumRows of [3, 4, 5, 6, 7, 8]) {
		const all = dashboardRows(five(), contextStub(), { ...defaults, maximumRows }, width, undefined, NOW);
		assert.ok(all.length <= maximumRows, `${width} ${maximumRows}`);
	}
});

test("an alert row keeps priority over quiet rows when rows are short", () => {
	const data = five();
	data.copilot = copilot(5);
	const rows = quotaLines(data, 5);
	assert.deepEqual(rows.map(r => r.split(" ")[0]), ["Codex1", "Copilot"], "the alert account stays; the others keep identity order");
	assert.match(rows[1], /\+3$/);
	assert.deepEqual(droppedQuotaAccounts(data, contextStub(), { ...defaults, maximumRows: 5 }, 160, NOW), ["Codex2", "Codex3", "Claude"]);
	// A services alert row takes a slot before any quiet quota row.
	const busy = five();
	busy.integrations = [integration("OV", { state: "error", summary: "unavailable" })];
	assert.deepEqual(quotaLines(busy, 6).map(r => r.split(" ")[0]), ["Codex1", "Codex2"]);
	assert.deepEqual(droppedQuotaAccounts(busy, contextStub(), { ...defaults, maximumRows: 6 }, 160, NOW), ["Codex3", "Claude", "Copilot"]);
});

test("one failed poll in auto mode keeps the last good reading until a window resets or a day passes", async () => {
	let now = NOW, fail: number | undefined;
	const fetcher = (async () => fail ? new Response("private payload text", { status: fail }) : new Response(JSON.stringify(PAYLOAD))) as unknown as typeof fetch;
	let oauth: unknown = login({ expiresAt: NOW + 3 * CACHED_READING_MS });
	const events: AnthropicStatusSnapshot[] = [];
	const make = (mode?: string) => createAnthropicStatus({ settings: () => parseAnthropicSettings({ mode }), clock: () => now,
		detect: () => ({ env: {}, home: HOME, readClaudeFile: () => ({ claudeAiOauth: oauth }) }), emit: (_event, value) => events.push(value as AnthropicStatusSnapshot),
		fetcher: (credential, signal) => fetchAnthropicUsage(credential, signal, fetcher) });
	const status = make();
	const good = await status.refresh(true);
	assert.equal(good.state, "ok");
	fail = 500; now += 60_000;
	const kept = await status.refresh(true);
	assert.deepEqual([kept.state, kept.error, kept.source, kept.plan], ["unknown", "HTTP 500", "claude-code", "max"]);
	assert.deepEqual(kept.windows, good.windows);
	const data = healthy(); data.anthropic = anthropicStatus(events.at(-1), now);
	assert.deepEqual([data.anthropic?.state, data.anthropic?.accounts[0].state], ["unknown", "unknown"]);
	const rows = dashboardRows(data, contextStub(), all, 200, undefined, now).map(stripTerminalSequences).join("\n");
	assert.match(rows, /^Claude +\[5h 72%\]/m, "the row stays");
	assert.doesNotMatch(rows.split("\n").find(r => r.startsWith("Claude"))!, /✗|error|stale/, "no error chip");
	assert.match(status.report(), /State: unknown \(HTTP 500\)\. The windows are the last good reading\./);
	assert.ok(!JSON.stringify(events).includes("private"));
	fail = 401; now += 60_000;
	assert.equal((await status.refresh(true)).state, "unknown", "a refused login keeps the reading too");
	// The 5h window of the reading resets at 10:12 UTC. After that time the reading is not reused.
	now = Date.parse("2026-09-22T10:12:01Z");
	assert.deepEqual([(await status.refresh(true)).state, anthropicStatus(events.at(-1), now)], ["absent", undefined]);
	// A reading with far resets ends at the day limit.
	fail = undefined;
	const far = createAnthropicStatus({ settings: () => parseAnthropicSettings({}), clock: () => now, detect: () => ({ env: {}, home: HOME, readClaudeFile: () => ({ claudeAiOauth: oauth }) }), emit: () => {},
		fetcher: async () => fail ? { success: false, error: "Network request failed", auth: false } : { success: true, usage: { windows: [{ label: "7d", remainingPercent: 40, resetsAt: new Date(now + 5 * CACHED_READING_MS).toISOString() }] } } });
	assert.equal((await far.refresh(true)).state, "ok");
	fail = 1; now += CACHED_READING_MS - 1000;
	assert.equal((await far.refresh(true)).state, "unknown");
	now += 2000;
	assert.equal((await far.refresh(true)).state, "absent", "a reading older than a day is not reused");
	// An expired or absent login never reuses a reading, and mode on shows the error chip at once.
	fail = undefined; now = NOW;
	const gone = make();
	assert.equal((await gone.refresh(true)).state, "ok");
	oauth = login({ expiresAt: now - 1 });
	assert.equal((await gone.refresh(true)).state, "absent");
	oauth = login({ expiresAt: NOW + 3 * CACHED_READING_MS });
	const loud = make("on");
	assert.equal((await loud.refresh(true)).state, "ok");
	fail = 500;
	assert.equal((await loud.refresh(true)).state, "error");
});

test("an unknown Codex provider sorts before Claude", () => {
	const data = healthy();
	data.limits = codexStatus({ checkedAt: NOW, staleAfter: 60_000, accounts: [{ provider: "private provider", state: "ok", windows: [{ label: "5h", remainingPercent: 50 }] }] }, NOW);
	data.anthropic = anthropic(); data.copilot = copilot();
	assert.deepEqual(buildView(data, contextStub().state(), all, NOW).quota?.accounts.map(a => a.label), ["Codex", "Claude", "Copilot"]);
	assert.ok(data.limits!.accounts[0].order < 900);
});

test("the doctor fix with no settings file writes the primary and only accounts that have a credential", async () => {
	const dir = mkdtempSync(join(tmpdir(), "doctor-codex-"));
	try {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex-4": { type: "oauth" } }));
		const run = () => runChecks({ dir, env: { HOME: dir }, which: async () => true, readClaudeFile: () => undefined });
		const check = (await run()).find(c => c.id === "codex")!;
		assert.equal(check.status, "warn");
		check.fix!.apply();
		const written = JSON.parse(readFileSync(join(dir, "codex-accounts", "settings.json"), "utf8"));
		assert.deepEqual(written.accounts.map((a: { provider: string }) => a.provider), ["openai-codex", "openai-codex-4"]);
		// With a settings file, the fix keeps the listed accounts and adds the new login.
		mkdirSync(join(dir, "codex-accounts"), { recursive: true });
		writeFileSync(join(dir, "codex-accounts", "settings.json"), JSON.stringify({ accounts: [{ provider: "openai-codex", label: "Codex 1" }, { provider: "openai-codex-3", label: "Codex 3" }] }));
		const again = (await run()).find(c => c.id === "codex")!;
		again.fix!.apply();
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "codex-accounts", "settings.json"), "utf8")).accounts.map((a: { provider: string }) => a.provider), ["openai-codex", "openai-codex-3", "openai-codex-4"]);
		// The fix keeps the other keys of the settings file.
		writeFileSync(join(dir, "codex-accounts", "settings.json"), JSON.stringify({ accounts: [{ provider: "openai-codex", label: "Codex 1" }], preferredAccount: "codex1" }));
		(await run()).find(c => c.id === "codex")!.fix!.apply();
		const kept = JSON.parse(readFileSync(join(dir, "codex-accounts", "settings.json"), "utf8"));
		assert.equal(kept.preferredAccount, "codex1");
		assert.deepEqual(kept.accounts.map((a: { provider: string }) => a.provider), ["openai-codex", "openai-codex-4"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
