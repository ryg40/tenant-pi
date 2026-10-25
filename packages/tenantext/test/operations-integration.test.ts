import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import contextMeter from "../extensions/context-meter/index.ts";
import { createContextMeter } from "../extensions/context-meter/service.ts";
import codexAccounts from "../extensions/codex-accounts/index.ts";
import { installOpsFooter } from "../extensions/ops-footer/runtime.ts";
import { defaults } from "../extensions/ops-footer/settings.ts";
import type { GitAdapter } from "../extensions/ops-footer/git.ts";
import { languageStatus } from "../extensions/ops-footer/adapters.ts";
import { formatDay } from "../extensions/ops-footer/view.ts";
import { contextStub } from "./footer-fixtures.ts";

test("suite language status preserves only fixed public fields", () => {
  assert.equal(languageStatus("STE on · guard passed"), "STE on guard passed");
  assert.equal(languageStatus("STE off · guard armed · 2 flagged"), "STE off guard armed 2 flagged");
  assert.equal(languageStatus("STE on · guard passed Bearer secret"), undefined);
  assert.equal(languageStatus("STE on · guard passed\n"), undefined);
});

for (const longPath of [false, true]) for (const reverse of [false, true]) test(`real meter, footer and Codex bus compose in ${reverse ? "reverse" : "suite"} order (${longPath ? "long" : "short"} path)`, async () => {
  // Hexadecimal UUIDs avoid the adapter's credential-name redaction patterns.
  const dir = join(tmpdir(), `tenantext-suite-${longPath ? "x".repeat(140) : ""}${randomUUID()}`);
  mkdirSync(dir);
  const directoryWidth = visibleWidth(dir) + 200;
  // The adapter caps directory values before the renderer applies the row width.
  const expectedDirectory = dir.slice(0, 256);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map<string, Set<(event: any, ctx: any) => any>>();
  const bus = new EventEmitter();
  const commands = new Map<string, any>();
  const widgets = new Map<string, unknown>();
  const statuses = new Map<string, string>([["tenantext", "STE on · guard passed"]]);
  let component: { render(width: number): string[]; dispose?(): void } | undefined;
  let tokens = 75000;
  let gitDisposed = false;
  let healthDisposed = false;
  let requests = 0;
  let liveSettings = { ...defaults, healthUrls: {} };
  const sm = SessionManager.inMemory(dir);
  const theme = { fg: (_key: string, text: string) => `\x1b[36m${text}\x1b[0m` };
  const ctx = {
    mode: "tui", hasUI: true, cwd: dir, thinkingLevel: "low",
    model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 100000 },
    sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens }), getSystemPrompt: () => "system",
    modelRegistry: { getApiKeyForProvider: async () => { requests++; return undefined; } },
    ui: {
      theme, notify() {}, setStatus: (key: string, value: string | undefined) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
      setWidget: (key: string, value: unknown) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
      setFooter(factory: any) {
        component?.dispose?.();
        component = factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => statuses, onBranchChange: () => () => {}, getGitBranch: () => "main" });
      },
    },
  } as unknown as ExtensionContext;
  const api = () => ({
    on(name: string, handler: any) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return () => { handlers.get(name)!.delete(handler); };
    },
    events: { on(name: string, handler: any) { bus.on(name, handler); return () => bus.off(name, handler); }, emit(name: string, value: unknown) { bus.emit(name, value); } },
    registerCommand(name: string, command: unknown) { assert.ok(!commands.has(name)); commands.set(name, command); },
    registerProvider() {}, registerEntryRenderer() {}, getCommands: () => [], getActiveTools: () => ["read"],
    appendEntry() { assert.fail("Dashboard must not write history"); },
    sendMessage() { assert.fail("Dashboard must not add model context"); },
    sendUserMessage() { assert.fail("Dashboard must not invoke a model"); },
  } as unknown as ExtensionAPI);
  const fire = async (name: string, event = {}) => { for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx); };
  const gitSnapshot = { state: "ok" as const, summary: "local Git", checkedAt: Date.now(), staleAfter: 60000, repo: "fixture", branch: "main", staged: 0, unstaged: 0, untracked: 0, worktrees: 3, worktree: "fixture" };
  const startFooter = () => installOpsFooter(api(), {
    context: createContextMeter,
    load: async () => liveSettings,
    git: () => ({ snapshot: gitSnapshot, refresh: async () => gitSnapshot, dispose() { gitDisposed = true; } }) as unknown as GitAdapter,
    health: () => ({ check: async () => { throw new Error("No configured health source"); }, dispose() { healthDisposed = true; } }) as any,
  });
  try {
    if (reverse) { startFooter(); contextMeter(api()); codexAccounts(api()); }
    else { codexAccounts(api()); contextMeter(api()); startFooter(); }
    await fire("session_start", { reason: "startup" });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(component);
    assert.ok(!widgets.has("context-meter"), "standalone widget is hidden");
    await fire("before_provider_request", { payload: { instructions: "x".repeat(40000) } });
    bus.emit("tenantext:codex:status", { checkedAt: Date.now(), staleAfter: 60000, accounts: [{ provider: "openai-codex-2", label: "Codex 2", state: "ok", windows: [{ label: "5h", remainingPercent: 0 }] }], routing: { state: "unknown", selectedAccount: "codex2" } });
    assert.ok(!widgets.has("ops-footer-top"), "the default layout v4 sets no widget above the editor");
    const v4 = component!.render(directoryWidth).map(stripTerminalSequences);
    assert.match(v4[0], /^openai-codex\/gpt-6-astra · low/, "v4: the model row is first below the editor");
    assert.equal(v4[1].match(/pwd (.+?)(?: ·| {2,}|$)/)?.[1], expectedDirectory, "v4: the directory row shows the session start directory up to the adapter cap");
    assert.match(v4[2], /WARN 75\.0k\/100k 75%/, "v4: the bar is third");
    assert.match(v4[3], /Codex2 .*✗ 5h 0%.*◂ routed/);
    // The assertions below are for the v3 composition, selected by name.
    await commands.get("ops-footer").handler("layout v3", ctx);
    assert.ok(widgets.has("ops-footer-top"), "v3: the directory row and the bar sit in a widget above the editor");
    const top = (widgets.get("ops-footer-top") as (tui: unknown, theme: unknown) => { render(width: number): string[] })({ requestRender() {} }, theme);
    // Rows as the user reads them: the widget above the editor, then the footer below it.
    const rendered = (width: number) => [...top.render(width), ...component!.render(width)];
    const text = (width: number) => rendered(width).map(stripTerminalSequences);
    for (const width of [8, 12, 20, 30, 40, 50, 80, 120, 200]) {
      const raw = rendered(width);
      for (const line of raw) assert.ok(visibleWidth(line) <= width, `width ${width}`);
      const lines = text(width);
      assert.ok(lines.length >= 1 && lines.length <= 6);
      const bar = width >= 40 ? 1 : 0;
      if (width >= 40) { assert.ok(lines.length >= 3); assert.match(lines[2], /^(openai-codex\/)?gpt-6-astra · low/, "v3 keeps the model below the editor"); assert.match(lines[bar], /WARN .*75%/); assert.match(lines[bar], /sys!/); }
      if (width >= 80) assert.match(lines[bar], /WARN 75\.0k\/100k 75%/);
      // The renderer cuts a long path with no glyph, and the directory name can lead the row.
      if (width >= 80) { const shown = lines[0].match(/pwd (\S+)/)?.[1] ?? ""; assert.ok(shown.length > 0 && dir.startsWith(shown), "top row shows a non-empty prefix of the session start directory"); }
      if (width >= 80) assert.match(lines[3], /Codex2 .*✗ 5h 0%.*◂ routed/);
      else if (width >= 40) assert.match(lines[3], /C(odex)?2 .*✗ 5h 0%/, "short or full account names below 80 columns, whichever fits");
      assert.ok(!lines.join("\n").includes("-----") && !lines.join("\n").includes("!1"));
    }
    assert.equal(text(directoryWidth)[0].match(/pwd (.+?)(?: ·| {2,}|$)/)?.[1], expectedDirectory, "v3: the top row shows the session start directory up to the adapter cap");
    const wide = text(directoryWidth).join("\n");
    assert.match(wide, /fixture main · 3 worktrees/);
    assert.ok(!wide.includes("STE"), "a passing guard stays out of the footer");
    assert.ok(!/OK ok|OV ok|TOOLS|statuses:/.test(wide));
    statuses.set("tenantext", "STE on · guard armed · 2 flagged");
    await fire("tool_execution_end");
    assert.match(text(200).join("\n"), /STE 2 flagged/);
    tokens = 1000;
    await fire("agent_start");
    await fire("agent_settled", { aborted: true });
    assert.match(text(120)[1], /1\.0k\/100k 1%/, "cancelled turns still refresh context usage");
    await fire("session_compact");
    const compact = text(120)[1];
    assert.match(compact, /1\.0k\/100k 1%$/); assert.ok(!/OK|PLAN|WARN|CRIT/.test(compact));
    ctx.model!.contextWindow = 1000;
    await fire("model_select");
    assert.match(text(120)[1], /CRIT .*100%/);
    liveSettings = { ...liveSettings, enabled: false };
    bus.emit("tenantext:ops-footer:settings-reload");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(component, undefined, "saved footer off applies without restarting Pi");
    liveSettings = { ...liveSettings, enabled: true, maximumRows: 4 };
    bus.emit("tenantext:ops-footer:settings-reload");
    await new Promise(resolve => setTimeout(resolve, 10));
    const restored = component as { render(width: number): string[] } | undefined;
    assert.ok(restored && restored.render(120).length <= 4, "saved footer options apply live");
    await commands.get("ops-footer").handler("off", ctx);
    assert.equal(component, undefined);
    assert.ok(widgets.has("context-meter"));
    await commands.get("context-meter").handler("off", ctx);
    await commands.get("ops-footer").handler("on", ctx);
    await commands.get("ops-footer").handler("off", ctx);
    assert.ok(!widgets.has("context-meter"), "off preference survives ownership changes");
    assert.equal(sm.getEntries().length, 0);
    assert.equal(requests, 0, "quota collector must not refresh OAuth credentials");
  } finally {
    await fire("session_shutdown");
    assert.ok(gitDisposed && healthDisposed);
    assert.equal(bus.eventNames().length, 0);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each Codex period end reaches only its own row through the real collector, bus, footer and report", async () => {
  const dir = join(tmpdir(), `tenantext-period-${randomUUID()}`);
  mkdirSync(join(dir, "codex-accounts"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR, previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  const now = Date.now(), DAY = 86_400_000;
  // Local noon of a local day, and the day as the view formats it, so the expected date holds in every zone.
  const noon = (days: number) => { const date = new Date(now); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return date; };
  const day = (date: Date) => formatDay(date.getTime());
  const plusTwo = (date: Date) => `${new Date(date.getTime() + 7_200_000).toISOString().slice(0, 19)}+02:00`;
  const [one, two, past, later, retained] = [noon(20), noon(40), noon(-10), noon(60), noon(80)];
  // Synthetic logins. Only the claim names follow a saved Codex login; every value is a sentinel that must stay out of the footer.
  const login = (n: number, until: string, checkedAgo: number, expiresIn: number) => {
    const auth = { chatgpt_account_id: `sentinel-acct-${n}`, chatgpt_subscription_active_until: until, chatgpt_subscription_last_checked: new Date(now - checkedAgo).toISOString() };
    const idToken = ["{}", JSON.stringify({ email: `sentinel-${n}@example.invalid`, "https://api.openai.com/auth": auth })].map(part => Buffer.from(part).toString("base64url")).join(".") + ".sig";
    return { access_token: `sentinel-access-${n}`, account_id: `sentinel-acct-${n}`, expires_at: (now + expiresIn) / 1000, id_token: idToken };
  };
  const write = (n: number, data: unknown) => { const path = join(dir, `codex${n}.json`); writeFileSync(path, JSON.stringify(data)); return path; };
  const files = [
    write(1, login(1, plusTwo(one), 3_600_000, DAY)),
    write(2, { tokens: login(2, two.toISOString(), 3 * DAY, -DAY) }),
    write(3, login(3, past.toISOString(), 3_600_000, -DAY)),
    write(4, login(4, `${day(two)}T12:00:00`, 3_600_000, -DAY)),
    write(5, { ...login(5, retained.toISOString(), 3_600_000, DAY), access_token: "", account_id: "" }),
  ];
  writeFileSync(join(dir, "codex-accounts", "settings.json"), JSON.stringify({ accounts: files.map((tokenFile, i) => ({ provider: i ? `openai-codex-${i + 1}` : "openai-codex", label: `Codex ${i + 1}`, tokenFile })) }));
  globalThis.fetch = (async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000 } } }))) as typeof fetch;
  const handlers = new Map<string, Set<(event: any, ctx: any) => any>>();
  const bus = new EventEmitter();
  const commands = new Map<string, any>();
  const published: unknown[] = [], notes: string[] = [];
  bus.on("tenantext:codex:status", value => published.push(value));
  let component: { render(width: number): string[]; dispose?(): void } | undefined;
  const sm = SessionManager.inMemory(dir);
  const theme = { fg: (_key: string, text: string) => `\x1b[36m${text}\x1b[0m` };
  const ctx = {
    mode: "tui", hasUI: true, cwd: dir, thinkingLevel: "low", model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 100000 },
    sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      theme, notify: (text: string) => notes.push(text), setStatus() {}, setWidget() {},
      setFooter(factory: any) { component?.dispose?.(); component = factory?.({ requestRender() {} }, theme, { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {}, getGitBranch: () => "main" }); },
    },
  } as unknown as ExtensionContext;
  const api = () => ({
    on(name: string, handler: any) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler); return () => { handlers.get(name)!.delete(handler); }; },
    events: { on(name: string, handler: any) { bus.on(name, handler); return () => bus.off(name, handler); }, emit(name: string, value: unknown) { bus.emit(name, value); } },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerProvider() {}, registerEntryRenderer() {}, getCommands: () => [], getActiveTools: () => [],
    appendEntry() { assert.fail("Dashboard must not write history"); }, sendMessage() { assert.fail("Dashboard must not add model context"); },
  } as unknown as ExtensionAPI);
  const fire = async (name: string, event = {}) => { for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx); };
  const git = { state: "ok" as const, summary: "local Git", checkedAt: now, staleAfter: 60000, repo: "fixture", branch: "main" };
  try {
    codexAccounts(api());
    installOpsFooter(api(), {
      context: () => contextStub(), load: async () => ({ ...defaults, healthUrls: {}, maximumRows: 12 }),
      git: () => ({ snapshot: git, refresh: async () => git, dispose() {} }) as unknown as GitAdapter,
      health: () => ({ check: async () => { throw new Error("No configured health source"); }, dispose() {} }) as any,
    });
    await fire("session_start", { reason: "startup" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const rows = () => component!.render(200).map(stripTerminalSequences);
    const row = (label: string) => rows().find(line => line.startsWith(`${label} `)) ?? assert.fail(`no ${label} row`);
    const dates = (text: string): string[] => text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    assert.deepEqual(dates(row("Codex1")), [day(one)], "an offset timestamp shows its own calendar day");
    assert.deepEqual(dates(row("Codex2")), [day(two)]);
    assert.match(row("Codex2"), /stale/, "provider evidence older than a day is marked");
    assert.deepEqual(dates(row("Codex3")), [day(past)]);
    assert.match(row("Codex3"), /past/, "a past period end is not shown as upcoming");
    assert.deepEqual(dates(row("Codex4")), [], "a timestamp without a zone gives no date and keeps the row");
    assert.deepEqual(dates(row("Codex5")), [], "a no login row shows no retained date");

    await commands.get("ops-footer").handler("report", ctx);
    const report = notes.at(-1)!.split("\n").filter(line => / period end: /.test(line));
    const own = (n: number) => report.find(line => line.startsWith(`Codex${n} period end:`)) ?? assert.fail(`no Codex${n} report line`);
    const periods = [one, two, past, undefined, undefined].map(date => date && day(date));
    for (const [i, period] of periods.entries()) {
      const others = [...periods, day(retained)].filter(other => other && other !== period);
      const shownDates = dates(own(i + 1));
      assert.ok((!period || shownDates.includes(period)) && !shownDates.some(date => others.includes(date)), `the Codex${i + 1} report line names only its own date`);
    }
    assert.match(own(3), /past/);

    // A manual footer refresh reads the replaced file again.
    write(1, login(1, later.toISOString(), 60_000, DAY));
    await commands.get("ops-footer").handler("refresh", ctx);
    assert.deepEqual(dates(row("Codex1")), [day(later)]);
    const shown = [JSON.stringify(published), rows().join("\n"), notes.join("\n")].join("\n");
    assert.ok(!shown.includes("sentinel") && !shown.includes(Buffer.from("{}").toString("base64url") + "."), "no token, identity or claim crosses the bus or reaches the display");
  } finally {
    await fire("session_shutdown");
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
