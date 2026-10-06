import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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

test("suite language status preserves only fixed public fields", () => {
  assert.equal(languageStatus("STE on · guard passed"), "STE on guard passed");
  assert.equal(languageStatus("STE off · guard armed · 2 flagged"), "STE off guard armed 2 flagged");
  assert.equal(languageStatus("STE on · guard passed Bearer secret"), undefined);
  assert.equal(languageStatus("STE on · guard passed\n"), undefined);
});

for (const reverse of [false, true]) test(`real meter, footer and Codex bus compose in ${reverse ? "reverse" : "suite"} order`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tenantext-suite-"));
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
    const v4 = component!.render(120).map(stripTerminalSequences);
    assert.match(v4[0], /^openai-codex\/gpt-6-astra · low/, "v4: the model row is first below the editor");
    assert.match(v4[1], /pwd .*tenantext-suite-/, "v4: the directory row is second");
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
      if (width >= 80) assert.match(lines[0], /pwd .*tenantext-suite-/, "top row shows the session start directory");
      if (width >= 80) assert.match(lines[3], /Codex2 .*✗ 5h 0%.*◂ routed/);
      else if (width >= 40) assert.match(lines[3], /C(odex)?2 .*✗ 5h 0%/, "short or full account names below 80 columns, whichever fits");
      assert.ok(!lines.join("\n").includes("-----") && !lines.join("\n").includes("!1"));
    }
    const wide = text(200).join("\n");
    assert.match(wide, /fixture main · 3 worktrees/);
    assert.ok(!wide.includes("STE"), "a passing guard stays out of the footer");
    assert.ok(!/OK ok|OV ok|TOOLS|statuses:/.test(wide));
    statuses.set("tenantext", "STE on · guard armed · 2 flagged");
    await fire("tool_execution_end");
    assert.match(text(200).join("\n"), /STE 2 flagged/);
    tokens = 1000;
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
