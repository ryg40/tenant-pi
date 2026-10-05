import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaults, loadSettings, saveSettings, settingsPath, validateSettings } from "../extensions/context-meter/settings.ts";
import { allocate, contextState, emptyEstimates, estimateSources, providerSystemTokens, reconciledWeights, snapshot } from "../extensions/context-meter/snapshot.ts";
import { renderMeter } from "../extensions/context-meter/render.ts";
import { createContextMeter } from "../extensions/context-meter/service.ts";
import extension, { OWNERSHIP, QUERY } from "../extensions/context-meter/index.ts";

const settings = { ...defaults };
const make = (used: unknown = 75000, window: unknown = 100000, system = 10000) => snapshot("model", used, window, system,
  { sys: system, prompt: 20000, assistant: 10000, think: 5000, tools: 30000 }, settings);

test("stages and system warnings use exact boundaries", () => {
  for (const [used, stage] of [[5999, "OK"], [6000, "PLAN"], [7499, "PLAN"], [7500, "WARN"], [8999, "WARN"], [9000, "CRIT"]] as const) {
    assert.equal(make(used, 10000).stage, stage);
  }
  assert.ok(!renderMeter(make(100, 1000, 9999), settings, 80).join("\n").includes("SYS!"));
  assert.ok(renderMeter(make(100, 1000, 10000), settings, 80).join("\n").includes("SYS!"));
  for (const unknown of [undefined, null, NaN, Infinity, -1]) assert.equal(make(unknown).stage, unknown === undefined ? "WARN" : "UNKNOWN");
  for (const window of [null, NaN, Infinity, 0, -1]) assert.equal(make(100, window).stage, "UNKNOWN");
  assert.equal(snapshot("m", undefined, undefined, undefined, emptyEstimates(), settings).stage, "UNKNOWN");
});

test("width safety, full width, dynamic ANSI and Unicode labels, rapid resize", () => {
  const widths = [0, 1, 8, 12, 20, 30, 40, 50, 80, 120, 200];
  for (const color of [true, false]) for (const label of ["normal", "\x1b[31mred\x1b[0m", "e\u0301", "中文", "👩‍💻"]) {
    for (const width of [...widths, ...[...widths].reverse(), ...widths]) {
      for (const state of [make(), make(null), make(110000), make(0)]) {
        const lines = renderMeter(state, settings, width, { color, labels: Array.from({ length: 6 }, () => [label, label, label]) });
        assert.ok(lines.length <= 2);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
        if (width >= 20) assert.equal(visibleWidth(lines[0]), width);
        if (width === 0) assert.deepEqual(lines, []);
        if (width >= 8 && state.percent === 75) assert.match(lines.at(-1)!, /WARN\s?75%/);
        if (state.percent === undefined && width >= 8) assert.match(lines.at(-1)!, /UNK.*\?%/);
      }
    }
  }
  const lines = renderMeter(make(), settings, 200, { color: false });
  assert.equal((lines[0].match(/│/g) ?? []).length, 3, "three threshold markers, no pipe ruler");
  assert.ok(!lines[0].includes("-") && !lines[0].includes("|"));
  for (const label of ["sys", "prompt", "assistant", "think", "tools", "free"]) assert.ok(lines[0].includes(label));
  assert.ok(lines[1].includes("Start a new session or compact"));
  const state = contextState(make(), settings);
  assert.equal(state.stage, "WARN"); assert.equal(state.systemWarning, true); assert.equal(state.weights!.length, 6);
  assert.deepEqual(state.thresholds, { prepare: 60, transition: 75, critical: 90 });
});

test("largest remainder conserves columns and reconciles to measured usage", () => {
  assert.deepEqual(allocate([1, 1, 1], 5), [2, 2, 1]);
  for (let width = 0; width <= 200; width++) {
    const weights = reconciledWeights(make())!;
    assert.equal(weights.reduce((a, b) => a + b, 0), 100000);
    assert.equal(weights.at(-1), 25000);
    assert.equal(allocate(weights, width).reduce((a, b) => a + b, 0), width);
  }
  assert.equal(reconciledWeights(make(null)), undefined);
  assert.equal(reconciledWeights(make(110000))!.at(-1), 0);
});

test("source estimates separate reasoning, tool calls, images and summaries", () => {
  const result = estimateSources([
    { role: "system", content: "not counted again" },
    { role: "user", content: [{ type: "image", data: "a".repeat(1000000) }, { type: "text", text: "abcd" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "abcd", thinkingSignature: "ignored" }, { type: "text", text: "abcd" }, { type: "toolCall", name: "read", arguments: {} }] },
    { role: "toolResult", content: [{ type: "text", text: "abcd" }] },
    { role: "bashExecution", excludeFromContext: true, output: "ignored" },
    { role: "compactionSummary", summary: "abcd" },
  ], 10);
  assert.deepEqual(result, { sys: 10, prompt: 1026, assistant: 3, think: 1, tools: 1 });
});

test("provider instructions, forced text, patches, empty prompts and unknown schemas", () => {
  assert.equal(providerSystemTokens({ instructions: "abcd", input: [{ role: "developer", content: "efgh" }] }), 2);
  assert.equal(providerSystemTokens({ instructions: "abcd", messages: [{ role: "system", content: "abcd" }] }), 1);
  assert.equal(providerSystemTokens({ system: [{ type: "text", text: "abcdefgh" }], messages: [] }), 2);
  assert.equal(providerSystemTokens({ config: { systemInstruction: { parts: [{ text: "abcd" }] } }, contents: [] }), 1);
  assert.equal(providerSystemTokens({ system: [{ text: "abcd" }] }), 1);
  assert.equal(providerSystemTokens({ messages: [{ role: "user", content: "not system" }] }), 0);
  assert.equal(providerSystemTokens({ instructions: "", input: [] }), 0);
  assert.equal(providerSystemTokens({ custom: "unknown" }), undefined);
});

test("settings validate, recover safely, save only known keys and honor agent directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-meter-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    assert.equal(settingsPath(), join(directory, "context-meter", "settings.json"));
    assert.deepEqual(loadSettings().settings, defaults);
    for (const invalid of [null, [], { enabled: 1 }, { preparePercent: 0 }, { preparePercent: 80 }, { criticalPercent: 101 }, { transitionPercent: NaN }, { systemPromptWarningTokens: 1.2 }]) {
      assert.throws(() => validateSettings(invalid));
    }
    const path = join(directory, "settings.json");
    writeFileSync(path, "{broken");
    assert.ok(loadSettings(path).warning);
    assert.deepEqual(loadSettings(path).settings, defaults);
    saveSettings({ ...settings, enabled: false, secret: "not saved" } as typeof settings, path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...defaults, enabled: false });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

type Handler = (event: any, ctx: ExtensionContext) => unknown;
function harness(bus = new Map<string, Set<(value: unknown) => void>>()) {
  const handlers = new Map<string, Set<Handler>>();
  const commands = new Map<string, any>();
  const widgets: unknown[] = [];
  const notices: string[] = [];
  let usage: number | null = 75000;
  let prompt = "p".repeat(40);
  const sm = SessionManager.inMemory();
  const ctx = {
    mode: "tui", hasUI: true,
    model: { provider: "test", id: "model", contextWindow: 100000 },
    sessionManager: sm,
    getContextUsage: () => ({ tokens: usage, contextWindow: 999999, percent: 0 }),
    getSystemPrompt: () => prompt,
    ui: { setWidget: (_key: string, widget: unknown) => { widgets.push(widget); }, notify: (text: string) => notices.push(text),
      custom: async (factory: any) => {
        const component = factory({ terminal: { rows: 24 }, requestRender() {} }, {}, {}, () => {});
        for (const width of [0, 1, 8, 80]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        component.handleInput("\r");
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return () => { handlers.get(name)!.delete(handler); };
    },
    events: {
      on(name: string, fn: (value: unknown) => void) {
        if (!bus.has(name)) bus.set(name, new Set());
        bus.get(name)!.add(fn);
        return () => { bus.get(name)!.delete(fn); };
      },
      emit(name: string, value: unknown) { for (const fn of bus.get(name) ?? []) fn(value); },
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    sendMessage() { assert.fail("No model context writes"); },
    appendEntry() { assert.fail("No session writes"); },
    sendUserMessage() { assert.fail("No model calls"); },
    exec() { assert.fail("No subprocess calls"); },
  } as unknown as ExtensionAPI;
  return { pi, ctx, sm, handlers, commands, widgets, notices, bus,
    usage: (value: number | null) => { usage = value; }, prompt: (value: string) => { prompt = value; },
    async emit(name: string, event: object = {}) { for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx); },
  };
}

test("lifecycle refresh uses active projection, compaction, context edits, model switch, cleanup", async () => {
  const h = harness();
  const service = createContextMeter(h.pi);
  assert.match(service.report(), /Stage: UNKNOWN/);
  assert.equal(service.state().stage, "UNKNOWN");
  let updates = 0;
  const unsubscribe = service.subscribe(() => updates++);
  const old = h.sm.appendMessage({ role: "user", content: "x".repeat(40000), timestamp: 0 });
  const kept = h.sm.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
  await h.emit("session_start");
  assert.match(service.report(), /75000 tokens \(75%\)/);
  assert.match(service.report(), /prompt=10001/);
  assert.equal(service.state().percent, 75); assert.equal(service.state().stage, "WARN");
  await h.emit("before_provider_request", { payload: { instructions: "x".repeat(40000) } });
  assert.match(service.report(), /System prompt: 10000/);
  assert.match(service.report(), /SYS! reached/);
  assert.equal(h.sm.getEntries().length, 2);
  h.sm.appendCompaction("abcd", kept, 75000);
  h.usage(null);
  await h.emit("session_compact");
  assert.match(service.report(), /Stage: UNKNOWN/);
  assert.match(service.report(), /prompt=2/);
  assert.doesNotMatch(service.report(), /prompt=10001/);
  h.usage(1000);
  await h.emit("message_end");
  await h.emit("turn_end", { context: { contextMessages: h.sm.buildSessionProjection().messages } });
  assert.match(service.report(), /1000 tokens \(1%\)/);
  h.ctx.model!.contextWindow = 1000;
  await h.emit("model_select");
  assert.match(service.report(), /Stage: CRIT/);
  await h.emit("session_compact_failed");
  assert.match(service.report(), /Stage: CRIT/);
  h.sm.branch(old);
  await h.emit("session_tree");
  assert.match(service.report(), /prompt=10000/);
  h.sm.appendContextEdit(old, null);
  await h.emit("agent_settled");
  assert.match(service.report(), /prompt=0/);
  assert.equal(h.sm.getEntry(old)!.type, "message");
  const before = h.sm.getEntries().length;
  const projection = h.sm.buildSessionProjection;
  h.sm.buildSessionProjection = () => { assert.fail("Render must not scan context"); };
  for (let i = 0; i < 50; i++) service.render(i);
  h.sm.buildSessionProjection = projection;
  assert.equal(h.sm.getEntries().length, before);
  assert.ok(updates >= 8);
  unsubscribe();
  await h.emit("session_shutdown");
  service.dispose();
  assert.deepEqual(service.render(80), []);
  assert.equal([...h.handlers.values()].reduce((sum, entries) => sum + entries.size, 0), 0);
});

test("context hooks and payload replace estimates without retaining text", async () => {
  const h = harness();
  const service = createContextMeter(h.pi);
  await h.emit("session_start");
  await h.emit("context_with_system", { messages: [
    { role: "system", content: "", sections: { header: "abcd", other: "efgh" }, timestamp: 0 },
    { role: "system", content: "", sections: { header: "ijkl" }, timestamp: 1 },
    { role: "user", content: "secret request", timestamp: 2 },
  ] });
  await h.emit("before_provider_request", { payload: { instructions: "forced secret", input: [{ role: "developer", content: "patch" }] } });
  assert.match(service.report(), /System prompt: 6 estimated tokens \(provider payload/);
  assert.doesNotMatch(service.report(), /forced secret|secret request/);
  await h.emit("before_provider_request", { payload: { notSupported: true } });
  assert.match(service.report(), /System prompt: 10 estimated tokens \(Pi prompt fallback/);
  assert.match(service.report(), /Later provider-request handlers/);
  await h.emit("before_provider_request", { payload: { instructions: "x".repeat(40000) } });
  h.prompt("short");
  await h.emit("session_start", { reason: "reload" });
  assert.match(service.report(), /System prompt: 2 estimated tokens/);
  service.dispose();
});

test("standalone ownership works with separate APIs in either load order; commands never write history", async () => {
  for (const footerFirst of [true, false]) {
    const bus = new Map<string, Set<(value: unknown) => void>>();
    const standalone = harness(bus);
    const footer = harness(bus);
    let footerActive = true;
    const startFooter = () => {
      footer.pi.events.on(QUERY, () => footer.pi.events.emit(OWNERSHIP, { active: footerActive }));
      footer.pi.events.emit(OWNERSHIP, { active: footerActive });
    };
    if (footerFirst) startFooter();
    extension(standalone.pi);
    if (!footerFirst) startFooter();
    await standalone.emit("session_start");
    assert.equal(standalone.widgets.at(-1), undefined);
    footerActive = false;
    footer.pi.events.emit(OWNERSHIP, { active: false });
    assert.equal(typeof standalone.widgets.at(-1), "function");
    const command = standalone.commands.get("context-meter");
    await command.handler("off", standalone.ctx);
    footer.pi.events.emit(OWNERSHIP, { active: true });
    footer.pi.events.emit(OWNERSHIP, { active: false });
    assert.equal(standalone.widgets.at(-1), undefined);
    await command.handler("on", standalone.ctx);
    assert.equal(typeof standalone.widgets.at(-1), "function");
    for (const args of ["", "report", "help", "invalid"]) await command.handler(args, standalone.ctx);
    assert.equal(standalone.sm.getEntries().length, 0);
    await standalone.emit("session_shutdown");
    assert.equal(standalone.widgets.at(-1), undefined);
    assert.equal(bus.get(OWNERSHIP)!.size, 0);
  }
});

test("on/off remains in memory until save", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-meter-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const h = harness();
    extension(h.pi);
    await h.emit("session_start");
    await h.commands.get("context-meter").handler("off", h.ctx);
    assert.equal(existsSync(settingsPath()), false);
    await h.commands.get("context-meter").handler("save", h.ctx);
    assert.equal(loadSettings().settings.enabled, false);
    await h.emit("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
