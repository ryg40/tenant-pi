import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, formatSkillsForPrompt, ModelRuntime, SessionManager, SettingsManager,
  type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext, type Skill,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import tenantext from "../src/index.ts";
import { estimateContextFilesChars, type PromptOptionsLike } from "../src/report.ts";
import { RULES_BLOCK, estimateTokensFromText } from "../src/rules.ts";

async function fixture(t: test.TestContext, basePrompt = "BASE", options: PromptOptionsLike = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tenantext-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const notes: Array<{ title: string; body: string }> = [];
  const notifications: string[] = [];
  tenantext({
    on(name: string, handler: any) { handlers.set(name, handler); return () => handlers.delete(name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerEntryRenderer() {},
    appendEntry(_name: string, data: { title: string; body: string }) { notes.push(data); },
  } as unknown as ExtensionAPI);
  let currentPrompt = basePrompt;
  const ctx = {
    isIdle: () => false,
    getSystemPrompt: () => currentPrompt,
    getSystemPromptOptions: () => options,
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => [] },
    ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  return { dir, handlers, commands, notes, notifications, ctx,
    setSystemPrompt(prompt: string) { currentPrompt = prompt; },
  };
}

function startEvent(messageType: "user" | "custom"): BeforeAgentStartEvent {
  const base = {
    type: "before_agent_start" as const,
    systemPrompt: "BASE\n\nSTATIC MEMORY",
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  };
  return messageType === "user"
    ? { ...base, messageType, prompt: "project conventions" }
    : { ...base, messageType, message: {
      role: "custom", customType: "background-completion", content: "background job completed", display: true, timestamp: 1,
    } };
}

for (const messageType of ["user", "custom"] as const) {
  test(`the actual handler preserves static rules and prompt order for ${messageType} turns`, async (t) => {
    const f = await fixture(t);
    const event = startEvent(messageType);
    const result = await f.handlers.get("before_agent_start")!(event, f.ctx);
    assert.deepEqual(result, { systemPrompt: `${RULES_BLOCK}\n\n${event.systemPrompt}` });
    assert.equal(event.systemPrompt, "BASE\n\nSTATIC MEMORY", "the incoming prompt stays unchanged");
    await f.commands.get("tenantext")!.handler("off", f.ctx);
    assert.equal(await f.handlers.get("before_agent_start")!(event, f.ctx), undefined);
    await f.commands.get("tenantext")!.handler("on", f.ctx);
    assert.deepEqual(await f.handlers.get("before_agent_start")!(event, f.ctx), result);
  });
}

test("custom before_agent_start injects rules without treating a completion as human input", async (t) => {
  const f = await fixture(t);
  assert.ok(await f.handlers.get("before_agent_start")!(startEvent("custom"), f.ctx));
  await f.handlers.get("agent_start")!({}, f.ctx);
  await f.handlers.get("before_provider_request")!({}, f.ctx);
  assert.deepEqual(f.notes.map((note) => note.title), [
    "tenantext guard: unverified run", "tenantext guard: request before human prompt",
  ]);
  assert.equal(f.notifications.length, 2);
  assert.deepEqual(await f.handlers.get("input")!({ source: "extension", text: "queued extension prompt" }, f.ctx), { action: "handled" });
  assert.deepEqual(await f.handlers.get("input")!({ source: "interactive", text: "human prompt" }, f.ctx), { action: "continue" });
  const count = f.notes.length;
  await f.handlers.get("before_agent_start")!(startEvent("user"), f.ctx);
  await f.handlers.get("agent_start")!({}, f.ctx);
  await f.handlers.get("before_provider_request")!({}, f.ctx);
  assert.equal(f.notes.length, count, "the human prompt clears the audit condition, not the custom lifecycle event");
});

const reportSkills: Skill[] = [{
  name: "fixture", description: "Read the fixture", filePath: "/fixture/SKILL.md",
  baseDir: "/fixture", sourceInfo: { path: "/fixture/SKILL.md", source: "fixture", scope: "temporary", origin: "top-level" },
  disableModelInvocation: false,
}];
const reportOptions = {
  selectedTools: ["read"], skills: reportSkills,
  contextFiles: [{ path: "/fixture/AGENTS.md", content: "fixture context" }],
  appendSystemPrompt: "fixture appendix", promptGuidelines: ["fixture guideline"],
};
const baseChars = 4000;
const reportBase = "b".repeat(baseChars);
const extensionAddition = "\n\n" + "e".repeat(198);
const expectedCore = estimateTokensFromText("x".repeat(baseChars
  - formatSkillsForPrompt(reportSkills).length
  - estimateContextFilesChars(reportOptions.contextFiles)
  - reportOptions.appendSystemPrompt.length
  - reportOptions.promptGuidelines.reduce((n, rule) => n + rule.length + 3, 0)));

async function report(f: Awaited<ReturnType<typeof fixture>>) {
  await f.commands.get("tenantext")!.handler("context", f.ctx);
  return f.notes.at(-1)!.body;
}

function assertReport(body: string, hasTurn: boolean) {
  assert.ok(body.includes(`| Core prompt + tool guidance | ${expectedCore.toLocaleString("en-US")} |`), body);
  if (hasTurn) assert.ok(body.includes("| Other extensions (last turn) | 50 |"), body);
  else assert.ok(!body.includes("Other extensions (last turn)"), body);
  const total = expectedCore + estimateTokensFromText(formatSkillsForPrompt(reportSkills))
    + estimateTokensFromText("x".repeat(estimateContextFilesChars(reportOptions.contextFiles)))
    + estimateTokensFromText(reportOptions.appendSystemPrompt)
    + estimateTokensFromText("x".repeat(reportOptions.promptGuidelines.reduce((n, rule) => n + rule.length + 3, 0)))
    + estimateTokensFromText(RULES_BLOCK) + (hasTurn ? 50 : 0);
  assert.ok(body.includes(`| **System prompt total** | **${total.toLocaleString("en-US")}** |`), body);
}

async function startReportedTurn(f: Awaited<ReturnType<typeof fixture>>, messageType: "user" | "custom") {
  const event = { ...startEvent(messageType), systemPrompt: reportBase + extensionAddition };
  // Pi replaces this getter only on the turn context; the session getter still reads the base.
  const turnCtx = { ...f.ctx, getSystemPrompt: () => event.systemPrompt };
  const result = await f.handlers.get("before_agent_start")!(event, turnCtx);
  assert.equal(result.systemPrompt, `${RULES_BLOCK}\n\n${event.systemPrompt}`);
  f.setSystemPrompt(result.systemPrompt);
}

test("custom-first context report keeps the base separate from earlier extension additions", async (t) => {
  const f = await fixture(t, "before resource discovery", reportOptions);
  f.setSystemPrompt(reportBase);
  await startReportedTurn(f, "custom");
  assertReport(await report(f), true);
  await f.handlers.get("input")!({ source: "interactive", text: "first user prompt" }, f.ctx);
  assertReport(await report(f), true);
  await startReportedTurn(f, "user");
  assertReport(await report(f), true);
});

test("user-first context report snapshots resources rather than a later chained prompt", async (t) => {
  const f = await fixture(t, "before resource discovery", reportOptions);
  f.setSystemPrompt(reportBase);
  await f.handlers.get("input")!({ source: "interactive", text: "first user prompt" }, f.ctx);
  assertReport(await report(f), false);
  await startReportedTurn(f, "user");
  assertReport(await report(f), true);
});

for (const messageType of ["custom", "user"] as const) {
  test(`real Pi runner preserves the base report when ${messageType} starts first`, async (t) => {
    const f = await fixture(t);
    t.mock.method(globalThis, "fetch", () => assert.fail("no real network request is allowed"));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: f.dir, agentDir: f.dir, settingsManager, systemPrompt: reportBase,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + extensionAddition }));
      }, tenantext],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(f.dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    t.mock.method(modelRuntime, "hasConfiguredAuth", () => true);
    t.mock.method(modelRuntime, "streamSimple", () => assert.fail("no real model request is allowed"));
    const { session } = await createAgentSession({
      cwd: f.dir, agentDir: f.dir, modelRuntime, resourceLoader, settingsManager,
      model: getModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off",
      tools: [], sessionManager: SessionManager.inMemory(f.dir),
    });
    t.after(() => session.dispose());
    const base = session.systemPrompt;
    session.agent.streamFunction = async (model, context) => {
      assert.equal(context.messages[0].content, `${RULES_BLOCK}\n\n${base}${extensionAddition}`);
      const message = {
        role: "assistant" as const, content: [{ type: "text" as const, text: "offline reply" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };
    await session.bindExtensions({ onError: (error) => assert.fail(JSON.stringify(error)) });
    const checkReport = async () => {
      await session.prompt("/tenantext context");
      const note = session.sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "tenantext-note");
      assert.ok(note?.type === "custom");
      const body = (note.data as { body: string }).body;
      assert.ok(body.includes(`| Core prompt + tool guidance | ${estimateTokensFromText(base).toLocaleString("en-US")} |`), body);
      assert.ok(body.includes("| Other extensions (last turn) | 50 |"), body);
    };
    if (messageType === "custom") {
      await session.sendCustomMessage({ customType: "background-completion", content: "done", display: true }, { triggerTurn: true });
      await checkReport();
    }
    await session.prompt("first user prompt");
    await checkReport();
  });
}
