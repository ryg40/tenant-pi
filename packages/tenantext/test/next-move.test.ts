import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askNextMove, createBreaker, fetchNextMove, MESSAGE_CHARS, nextMoveChip, question, sessionState } from "../extensions/context-meter/next-move.ts";
import { DECISIONS_EVENT, saveSettings as saveTenantextSettings, settingsPath as tenantextSettingsPath } from "../src/settings.ts";
import tenantext from "../src/index.ts";
import { defaults, validateSettings } from "../extensions/context-meter/settings.ts";
import { snapshot, emptyEstimates } from "../extensions/context-meter/snapshot.ts";
import { renderMeter } from "../extensions/context-meter/render.ts";
import { createContextMeter } from "../extensions/context-meter/service.ts";
import { dashboardRows } from "../extensions/ops-footer/render.ts";
import { defaults as footerDefaults } from "../extensions/ops-footer/settings.ts";
import { contextStub, healthy, NOW } from "./footer-fixtures.ts";

const config = { url: "http://decision.test/choice", key: "k", timeoutMs: 150, minConfidence: 0.3 };
type Handler = (event: any, ctx: ExtensionContext) => unknown;
/** A minimal Pi API: lifecycle hooks, the shared event bus, and commands. Model or history writes fail the test. */
function fakePi(handlers: Map<string, Handler[]>, bus = new Map<string, Set<(value: unknown) => void>>(), commands = new Map<string, any>()) {
  return {
    on(name: string, fn: Handler) { handlers.set(name, [...handlers.get(name) ?? [], fn]); return () => {}; },
    events: {
      on(name: string, fn: (value: unknown) => void) { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name)!.add(fn); return () => { bus.get(name)!.delete(fn); }; },
      emit(name: string, value: unknown) { for (const fn of bus.get(name) ?? []) fn(value); },
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerEntryRenderer() {},
    appendEntry() { assert.fail("No session writes"); }, sendMessage() { assert.fail("No model context writes"); }, sendUserMessage() { assert.fail("No model calls"); },
  } as unknown as ExtensionAPI;
}
/** A decision server under test control: `status` per request, `hang` keeps requests open, `count` is every request seen. */
async function decisionServer(t: { after(fn: () => void): void }, options: { status?: number; hang?: boolean } = {}) {
  const box = { count: 0, closed: 0, url: "" };
  const server: Server = createServer((req, res) => {
    box.count++;
    req.on("close", () => { box.closed++; });
    if (options.hang) return;
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = options.status ?? 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(answer("compact", 0.99, 1)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  box.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/choice`;
  return box;
}
/** An isolated agent directory with the meter pointed at `url`. */
function agentDir(t: { after(fn: () => void): void }, url: string, decisions = true, timeoutMs = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "next-move-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  });
  mkdirSync(join(directory, "context-meter"), { recursive: true });
  writeFileSync(join(directory, "context-meter", "settings.json"), JSON.stringify({ nextMoveUrl: url, nextMoveTimeoutMs: timeoutMs }));
  saveTenantextSettings({ rules: true, guard: true, decisions }, tenantextSettingsPath());
  return directory;
}
function fakeCtx(): ExtensionContext {
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "ok now also add the tests", timestamp: 0 });
  return { model: { provider: "p", id: "m", contextWindow: 100_000 }, sessionManager: sm, hasUI: true, mode: "tui",
    getContextUsage: () => ({ tokens: 82_000 }), getSystemPrompt: () => "", ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const answer = (choice: string, confidence: number, probability = confidence) =>
  ({ answers: { next_move: { type: "choice", choice, confidence, probabilities: { [choice]: probability } } } });
const fakeFetch = (body: unknown, status = 200, seen: RequestInit[] = []) =>
  (async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init!); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;

test("session state counts user turns, keeps the last message end, and tracks the last tool error", () => {
  const long = "word ".repeat(200);
  const state = sessionState([
    { role: "user", content: "first" },
    { role: "toolResult", isError: true, content: [] },
    { role: "user", content: [{ type: "text", text: long }, { type: "image", data: "x" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "toolResult", isError: true, content: [] },
  ], 81.6);
  assert.equal(state.turns, 2);
  assert.equal(state.context_used_pct, 82);
  assert.equal(state.last_tool_error, true);
  assert.equal(state.last_user_message.length, MESSAGE_CHARS);
  assert.equal(sessionState([{ role: "toolResult", isError: true }, { role: "user", content: "hi" }], 10).last_tool_error, false);
});

test("askNextMove returns the choice with probability and confidence, and sends the key and question", async () => {
  const seen: RequestInit[] = [];
  const move = await askNextMove(config, sessionState([], 82), fakeFetch(answer("compact", 0.63, 0.74), 200, seen));
  assert.deepEqual(move, { choice: "compact", confidence: 0.63, probability: 0.74 });
  assert.equal(nextMoveChip(move!), "next: compact 0.74");
  assert.equal((seen[0].headers as Record<string, string>).Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(String(seen[0].body)).questions.next_move.criteria, question.criteria);
});

test("askNextMove shows nothing when off, not confident, unknown, failed, or late", async () => {
  const state = sessionState([], 50);
  assert.equal(await askNextMove({ ...config, url: "" }, state, fakeFetch(answer("commit", 0.9))), undefined);
  assert.equal(await askNextMove(config, state, fakeFetch(answer("commit", 0.2))), undefined);
  assert.equal(await askNextMove(config, state, fakeFetch(answer("rm -rf", 0.9))), undefined);
  assert.equal(await askNextMove(config, state, fakeFetch({ error: "x" }, 500)), undefined);
  assert.equal(await askNextMove(config, state, fakeFetch("not json")), undefined);
  const hang = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) =>
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as typeof fetch;
  // AbortSignal.timeout does not hold the event loop open; a real Pi process does.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  assert.equal(await askNextMove({ ...config, timeoutMs: 30 }, state, hang), undefined);
  assert.ok(Date.now() - started < 1000);
  clearTimeout(keepAlive);
});

test("settings: the chip is off by default, the URL must be http(s), confidence is 0 to 1", () => {
  assert.equal(defaults.nextMoveUrl, "");
  assert.equal(validateSettings({ nextMoveUrl: "http://decision.test:8000/choice" }).nextMoveUrl, "http://decision.test:8000/choice");
  assert.equal(validateSettings({ nextMoveMinConfidence: 0 }).nextMoveMinConfidence, 0);
  assert.throws(() => validateSettings({ nextMoveUrl: "file:///etc/passwd" }));
  assert.throws(() => validateSettings({ nextMoveUrl: 5 }));
  assert.throws(() => validateSettings({ nextMoveMinConfidence: 1.5 }));
  assert.throws(() => validateSettings({ nextMoveTimeoutMs: 0 }));
});

test("meter and footer show the chip only where it fits", () => {
  const move = { choice: "compact", probability: 1, confidence: 0.99 };
  const s = snapshot("m", 82_000, 100_000, 1000, emptyEstimates(), defaults);
  assert.match(renderMeter(s, defaults, 80, { nextMove: move }).at(-1)!, /next: compact 1\.00/);
  assert.doesNotMatch(renderMeter(s, defaults, 50, { nextMove: move }).at(-1)!, /next:/);
  const settings = { ...footerDefaults, healthUrls: {} };
  const context = contextStub({ used: 223_000, nextMove: move });
  for (const width of [40, 60, 80, 120, 160]) {
    const rows = dashboardRows(healthy(), context, settings, width, undefined, NOW);
    for (const row of rows) assert.ok(visibleWidth(row) <= width);
    assert.equal(rows[0].includes("next: compact 1.00"), width >= 80, `${width}: directory facts precede optional advice`);
  }
  assert.ok(!dashboardRows(healthy(), contextStub({ used: 223_000 }), settings, 160, undefined, NOW)[0].includes("next:"));
});

test("service asks once per agent_end, shows the answer, and clears it on compaction", async t => {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    calls++;
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      assert.equal(JSON.parse(body).state.context_used_pct, 82);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(answer("compact", 0.99, 1)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "next-move-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const port = (server.address() as { port: number }).port;
  mkdirSync(join(directory, "context-meter"), { recursive: true });
  writeFileSync(join(directory, "context-meter", "settings.json"), JSON.stringify({ nextMoveUrl: `http://127.0.0.1:${port}/choice`, nextMoveTimeoutMs: 2000 }));

  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => unknown)[]>();
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "user", content: "ok now also add the tests", timestamp: 0 });
  const ctx = { model: { provider: "p", id: "m", contextWindow: 100_000 }, sessionManager: sm,
    getContextUsage: () => ({ tokens: 82_000 }), getSystemPrompt: () => "" } as unknown as ExtensionContext;
  const pi = fakePi(handlers);
  const emit = async (name: string, event: object = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };

  const service = createContextMeter(pi);
  let updates = 0;
  service.subscribe(() => updates++);
  await emit("session_start");
  assert.equal(service.state().nextMove, undefined);
  await emit("agent_end");
  for (let i = 0; i < 100 && !service.state().nextMove; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 1);
  assert.equal(service.state().nextMove?.choice, "compact");
  assert.ok(updates >= 2);
  await emit("session_compact");
  assert.equal(service.state().nextMove, undefined);
  service.dispose();
});

test("fetchNextMove separates an endpoint failure from an answer the gate hides", async () => {
  const state = sessionState([], 50);
  assert.deepEqual(await fetchNextMove({ ...config, url: "" }, state, fakeFetch(answer("commit", 0.9))), { failed: false });
  assert.equal((await fetchNextMove(config, state, fakeFetch(answer("commit", 0.2)))).failed, false);
  assert.equal((await fetchNextMove(config, state, fakeFetch(answer("rm -rf", 0.9)))).failed, false);
  assert.equal((await fetchNextMove(config, state, fakeFetch({ error: "x" }, 503))).failed, true);
  assert.equal((await fetchNextMove(config, state, fakeFetch("not json"))).failed, true);
  assert.equal((await fetchNextMove(config, state, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch)).failed, true);
  const outside = new AbortController();
  const hang = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) =>
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as typeof fetch;
  const pending = fetchNextMove({ ...config, timeoutMs: 5000, signal: outside.signal }, state, hang);
  outside.abort();
  assert.equal((await pending).failed, true);
});

test("breaker: an offline endpoint gets a bounded number of calls, the cooldown doubles to a cap, and success or a new URL resets it", () => {
  let now = 0;
  const breaker = createBreaker({ baseMs: 30_000, maxMs: 600_000 }, () => now);
  const url = "http://127.0.0.1:1/choice";
  let calls = 0;
  const gaps: number[] = [];
  let last = 0;
  for (let trigger = 0; trigger < 10_000; trigger++) {
    now = trigger * 10_000; // one agent run every 10 s for about 28 hours
    if (!breaker.allow(url)) continue;
    calls++; gaps.push(now - last); last = now;
    breaker.failure();
  }
  assert.ok(calls <= 175 && calls >= 160, `${calls} calls`);
  assert.deepEqual(gaps.slice(1, 6), [30_000, 60_000, 120_000, 240_000, 480_000]);
  assert.ok(gaps.slice(7).every(gap => gap === 600_000), "capped at ten minutes");
  assert.equal(breaker.state().failures, calls);
  breaker.success();
  assert.deepEqual(breaker.state(), { failures: 0, resumeAt: 0 });
  assert.ok(breaker.allow(url));
  breaker.failure();
  assert.ok(!breaker.allow(url));
  assert.ok(breaker.allow("http://127.0.0.1:2/choice"), "a new endpoint starts with a clean record");
  assert.equal(breaker.state().failures, 0);
});

test("service: many agent runs against a failing endpoint make one call, then the report shows the pause", async t => {
  const server = await decisionServer(t, { status: 503 });
  agentDir(t, server.url);
  const handlers = new Map<string, Handler[]>();
  const ctx = fakeCtx();
  const service = createContextMeter(fakePi(handlers));
  const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  await emit("session_start");
  for (let i = 0; i < 200; i++) await emit("agent_end");
  await settle(100);
  for (let i = 0; i < 200; i++) await emit("agent_end");
  await settle(100);
  assert.equal(server.count, 1);
  assert.equal(service.state().nextMove, undefined);
  assert.match(service.report(), /Next-move chip: paused after 1 failed call; next try in (29|30) s\./);
  service.dispose();
});

test("service: /tenantext-ifs-enable off stops calls and clears the chip; on resumes; a saved off never asks", async t => {
  const server = await decisionServer(t);
  agentDir(t, server.url);
  let handlers = new Map<string, Handler[]>();
  const pi = fakePi(handlers);
  const ctx = fakeCtx();
  const service = createContextMeter(pi);
  const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  await emit("session_start");
  await emit("agent_end");
  await settle(100);
  assert.equal(server.count, 1);
  assert.equal(service.state().nextMove?.choice, "compact");
  pi.events.emit(DECISIONS_EVENT, { enabled: false });
  assert.equal(service.state().nextMove, undefined, "off clears the chip at once");
  for (let i = 0; i < 20; i++) await emit("agent_end");
  await settle(100);
  assert.equal(server.count, 1, "off makes no calls");
  pi.events.emit(DECISIONS_EVENT, { enabled: true });
  await emit("agent_end");
  await settle(100);
  assert.equal(server.count, 2, "on resumes without a restart");
  assert.equal(service.state().nextMove?.choice, "compact");
  pi.events.emit(DECISIONS_EVENT, "junk");
  assert.equal(service.state().nextMove?.choice, "compact", "a malformed event changes nothing");
  service.dispose();

  saveTenantextSettings({ rules: true, guard: true, decisions: false }, tenantextSettingsPath());
  const quiet = createContextMeter(fakePi(handlers = new Map()));
  await emit("session_start");
  for (let i = 0; i < 20; i++) await emit("agent_end");
  await settle(100);
  assert.equal(server.count, 2, "a saved off is read at session start");
  assert.match(quiet.report(), /Next-move chip: off by \/tenantext-ifs-enable off\./);
  quiet.dispose();
});

test("service: shutdown aborts the call in flight and a second trigger never stacks a call", async t => {
  const server = await decisionServer(t, { hang: true });
  agentDir(t, server.url, true, 5000);
  const handlers = new Map<string, Handler[]>();
  const ctx = fakeCtx();
  const service = createContextMeter(fakePi(handlers));
  const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  await emit("session_start");
  for (let i = 0; i < 5; i++) await emit("agent_end");
  for (let i = 0; i < 50 && server.count === 0; i++) await settle(10);
  assert.equal(server.count, 1, "one call in flight at most");
  await emit("session_shutdown");
  for (let i = 0; i < 50 && server.closed === 0; i++) await settle(10);
  assert.equal(server.closed, 1, "shutdown closes the request");
  assert.equal(service.state().nextMove, undefined);
});

test("/tenantext-ifs-enable saves the switch, emits the bus event, reports status, and completes its arguments", async t => {
  const dir = agentDir(t, "http://127.0.0.1:1/choice");
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Set<(value: unknown) => void>>();
  const commands = new Map<string, any>();
  const pi = fakePi(handlers, bus, commands);
  const seen: unknown[] = [];
  pi.events.on(DECISIONS_EVENT, value => seen.push(value));
  const notices: string[] = [];
  const ctx = { ...fakeCtx(), ui: { notify: (text: string) => notices.push(text), setStatus() {} } } as unknown as ExtensionContext;
  tenantext(pi);
  const command = commands.get("tenantext-ifs-enable");
  assert.ok(command, "command registered");
  assert.deepEqual(command.getArgumentCompletions("o"), [{ value: "on", label: "on" }, { value: "off", label: "off" }]);
  assert.equal(command.getArgumentCompletions("x"), null);
  await command.handler("off", ctx);
  assert.equal(JSON.parse(readFileSync(join(dir, "tenantext", "settings.json"), "utf8")).decisions, false);
  assert.deepEqual(seen, [{ enabled: false }]);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /decision-server calls: off/);
  assert.match(notices.at(-1)!, /nextMoveUrl configured/);
  await commands.get("tenantext").handler("", ctx);
  assert.match(notices.at(-1)!, /decisions: off/);
  await command.handler("on", ctx);
  assert.equal(JSON.parse(readFileSync(join(dir, "tenantext", "settings.json"), "utf8")).decisions, true);
  assert.deepEqual(seen, [{ enabled: false }, { enabled: true }]);
  await commands.get("tenantext").handler("save", ctx);
  assert.equal(JSON.parse(readFileSync(join(dir, "tenantext", "settings.json"), "utf8")).decisions, true, "save keeps the switch");
  await command.handler("maybe", ctx);
  assert.match(notices.at(-1)!, /usage/);
});
