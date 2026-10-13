import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { MCP_PROTOCOL_VERSION } from "../lib/mcp-bridge.mjs";
import { RecallManager } from "../recall.ts";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionUrl = pathToFileURL(extensionDir + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(extensionUrl) || !specifier.startsWith(".") || !specifier.endsWith(".js")) {
      return nextResolve(specifier, context);
    }
    try { return nextResolve(specifier, context); }
    catch { return nextResolve(specifier.slice(0, -3) + ".ts", context); }
  },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "ov-pi-lifecycle-"));
  const cwd = process.cwd();
  const envKeys = [...new Set([...Object.keys(process.env).filter((key) => key.startsWith("OPENVIKING_")),
    "OPENVIKING_CREDENTIAL_SOURCE", "OPENVIKING_URL", "OPENVIKING_API_KEY", "OPENVIKING_PEER_ID",
    "OPENVIKING_CLI_CONFIG_FILE", "OPENVIKING_CONFIG_FILE", "OPENVIKING_PENDING_DIR", "OPENVIKING_STATE_DIR",
    "PI_CODING_AGENT_DIR", "OV_DEBUG_LOG", "HOME"])];
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    HOME: home, PI_CODING_AGENT_DIR: home,
    OPENVIKING_CREDENTIAL_SOURCE: "env", OPENVIKING_URL: "http://openviking.invalid",
    OPENVIKING_API_KEY: "offline-fixture-key", OPENVIKING_PEER_ID: "lifecycle-fixture",
    OPENVIKING_CLI_CONFIG_FILE: join(home, "ovcli.conf"), OPENVIKING_CONFIG_FILE: join(home, "ov.conf"),
    OPENVIKING_PENDING_DIR: join(home, "pending"), OPENVIKING_STATE_DIR: join(home, "state"),
  });
  process.chdir(home);
  let session;
  t.after(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(join(home, "ovcli.conf"), JSON.stringify({ plugin: { pi: {
    takeoverEnabled: false, recallLedger: false, skillCatalog: false, logLevel: "silent",
  } } }));

  const searches = [];
  const captures = [];
  const queued = [];
  const starts = [];
  const requests = [];
  const gate = { start: null };
  // Replace all HTTP, not just REST. Any unexpected host fails instead of using real credentials or servers.
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, "http://openviking.invalid", "no real network request is allowed");
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "content-type": "application/json" },
    });
    if (url.pathname === "/mcp") {
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(init.body);
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize"
        ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "offline", version: "1" } }
        : { tools: [{ name: "read", description: "Read a memory", inputSchema: { type: "object", properties: {} } }] };
      return json({ jsonrpc: "2.0", id: message.id, result });
    }
    let result = {};
    if (url.pathname === "/api/v1/system/status") result = { user: "lifecycle-fixture" };
    else if (url.pathname === "/api/v1/fs/ls") result = [];
    else if (url.pathname === "/api/v1/content/read") result = "STATIC PROFILE";
    else if (url.pathname.endsWith("/context")) result = { latest_archive_overview: "STATIC ARCHIVE" };
    else if (url.pathname.endsWith("/messages/batch")) captures.push(...JSON.parse(init.body).messages);
    else if (url.pathname === "/api/v1/search/search") {
      const body = JSON.parse(init.body);
      searches.push(body);
      result = { rendered: `- memory for ${body.query}` };
    }
    return json({ status: "ok", result });
  });
  const queueSearch = RecallManager.prototype.queueSearch;
  t.mock.method(RecallManager.prototype, "queueSearch", function (prompt) {
    queued.push(prompt);
    return queueSearch.call(this, prompt);
  });

  const { default: extension } = await import(join(extensionDir, "index.ts"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: home, agentDir: home, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "BASE", extensionFactories: [extension, (pi) => {
      pi.on("before_agent_start", async (event, ctx) => {
        starts.push({ messageType: event.messageType, hasPrompt: "prompt" in event, idle: ctx.isIdle(), prompt: event.systemPrompt });
        if (gate.start) { gate.start.entered.resolve(); await gate.start.release.promise; }
      });
    }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, refreshOnCreate: false });
  t.mock.method(modelRuntime, "hasConfiguredAuth", () => true);
  t.mock.method(modelRuntime, "streamSimple", () => assert.fail("no real model request is allowed"));
  ({ session } = await createAgentSession({
    cwd: home, agentDir: home, modelRuntime, resourceLoader, settingsManager,
    model: getModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off",
    noTools: "builtin", sessionManager: SessionManager.inMemory(home),
  }));
  // Use Pi's real run/context/queue machinery, but never call a model endpoint.
  session.agent.streamFunction = async (model, context) => {
    requests.push(structuredClone(context));
    const message = {
      role: "assistant", content: [{ type: "text", text: "offline reply" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  await session.bindExtensions({ onError: (error) => assert.fail(JSON.stringify(error)) });
  return { session, starts, requests, queued, searches, captures, gate };
}

const completion = (content = "background job completed") => ({ customType: "background-completion", content, display: true });
const text = (message) => typeof message.content === "string" ? message.content
  : message.content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";

function assertStatic(prompt) {
  assert.ok(prompt.startsWith("BASE\n\n"));
  assert.match(prompt, /STATIC PROFILE[\s\S]*STATIC ARCHIVE[\s\S]*OpenViking tools \(use these for viking:\/\/ URIs\): openviking_read\./);
}

test("idle custom completion runs startup and static additions without prompt recall", async (t) => {
  const f = await fixture(t);
  await f.session.sendCustomMessage(completion(), { triggerTurn: true });
  assert.equal(f.starts.length, 1);
  assert.deepEqual({ ...f.starts[0], prompt: undefined }, { messageType: "custom", hasPrompt: false, idle: false, prompt: undefined });
  assertStatic(f.starts[0].prompt);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.searches, []);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].messages.some((message) => text(message) === "background job completed"));
});

test("user recall waits for context and custom completion preserves the same static prompt", async (t) => {
  const f = await fixture(t);
  f.gate.start = { entered: deferred(), release: deferred() };
  const run = f.session.prompt("project conventions");
  await f.gate.start.entered.promise;
  assert.deepEqual(f.queued, ["project conventions"]);
  assert.deepEqual(f.searches, [], "before_agent_start queues recall without searching");
  f.gate.start.release.resolve();
  await run;
  f.gate.start = null;
  assert.deepEqual(f.searches.map((body) => body.query), ["project conventions"]);
  assert.match(f.requests[0].messages.map(text).join("\n"), /memory for project conventions/);
  assertStatic(f.starts[0].prompt);
  await f.session.sendCustomMessage(completion(), { triggerTurn: true });
  assert.equal(f.starts[1].prompt, f.starts[0].prompt, "static additions keep their text and order on custom turns");
  assert.deepEqual(f.queued, ["project conventions"]);
  assert.equal(f.searches.length, 1, "custom completions must not search the last user's prompt again");
});

for (const messageType of ["user", "custom"]) for (const deliverAs of ["steer", "followUp"]) {
  test(`messages queued during busy ${messageType} startup join the run (${deliverAs})`, async (t) => {
    const f = await fixture(t);
    f.gate.start = { entered: deferred(), release: deferred() };
    await f.session.sendCustomMessage(completion("next-turn context"), { deliverAs: "nextTurn" });
    const run = messageType === "user" ? f.session.prompt("starting user prompt")
      : f.session.sendCustomMessage(completion(), { triggerTurn: true });
    await f.gate.start.entered.promise;
    assert.equal(f.session.isIdle, false);
    await f.session.sendCustomMessage(completion("queued background completion"), { triggerTurn: true, deliverAs });
    await f.session.sendUserMessage("queued user prompt", { deliverAs });
    f.gate.start.release.resolve();
    await run;
    assert.equal(f.starts.length, 1, "busy startup must not start a nested custom or user run");
    const expectedQueries = messageType === "user" ? ["starting user prompt"] : [];
    assert.deepEqual(f.queued, expectedQueries);
    assert.deepEqual(f.searches.map((body) => body.query), expectedQueries);
    assert.ok(f.requests.length >= 2, "the queued messages must reach an offline provider request");
    const finalText = f.requests.at(-1).messages.map(text).join("\n");
    for (const content of ["next-turn context", "queued background completion", "queued user prompt"]) {
      assert.ok(finalText.includes(content), content);
    }
    assertStatic(f.starts[0].prompt);
    for (const request of f.requests) assertStatic(text(request.messages[0]));
    assert.ok(f.captures.length > 0, "capture still runs for queued turns");
    const capturedText = JSON.stringify(f.captures);
    assert.match(capturedText, /queued user prompt/);
    assert.ok(!capturedText.includes("queued background completion"), "custom content stays outside capture");
    assert.equal(f.session.isIdle, true);
  });
}
