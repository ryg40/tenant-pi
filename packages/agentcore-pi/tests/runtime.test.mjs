import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSdkClient, readConfig, registerAgentCore } from "../runtime.mjs";
import extension from "../index.ts";

const config = { memoryId: "mem-EXAMPLE", region: "us-east-1", namespaces: ["/owner/{actorId}/", "/shared/"],
  actorId: "example", topK: 7, capture: false };
const user = { messageType: "user", prompt: "Example query" };
function fixture(extra = {}, retrieve) {
  const hooks = {}, calls = [], logs = [];
  const client = {
    retrieve: async (body, options) => {
      calls.push({ method: "retrieve", body, options });
      return retrieve ? retrieve(body, options) : { memoryRecordSummaries: [
        { memoryRecordId: "record-example", namespaces: [body.namespace], content: { text: "Example reference" } },
      ] };
    },
    capture: async (body, options) => { calls.push({ method: "capture", body, options }); },
    destroy: () => calls.push({ method: "destroy" }),
  };
  registerAgentCore({ on: (name, handler) => hooks[name] = handler }, { ...config, ...extra },
    { createClient: () => client, log: (line) => logs.push(line) });
  return { hooks, calls, logs };
}

test("two namespaces receive one query each and return one reference block", async () => {
  const f = fixture();
  const result = await f.hooks.before_agent_start(user, {});
  assert.deepEqual(f.calls.map(({ body }) => body), ["/owner/example/", "/shared/"].map((namespace) => ({
    memoryId: "mem-EXAMPLE", namespace, searchCriteria: { searchQuery: "Example query", topK: 7 }, maxResults: 7,
  })));
  assert.equal(result.message.customType, "agentcore-memory-recall");
  assert.equal(result.message.display, false);
  assert.match(result.message.content, /^## AgentCore Memory recall\n/);
  assert.match(result.message.content, /record-example/);
  assert.match(result.message.content, /\/owner\/example\//);
  assert.match(result.message.content, /\/shared\//);
  assert.equal(result.message.content.split("## AgentCore Memory recall").length, 2);
  assert.deepEqual(f.logs, []);
});

test("missing actor skips only the owner namespace with one log line", async () => {
  const f = fixture({ actorId: "" });
  await f.hooks.before_agent_start(user, {});
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.namespace, "/shared/");
  assert.deepEqual(f.logs, ["AgentCore Memory: owner namespace skipped; actorId missing"]);
});

test("capture off does not read the event or context and creates no client", async () => {
  const f = fixture();
  const unreadable = new Proxy({}, { get() { assert.fail("capture read while off"); } });
  await f.hooks.turn_end(unreadable, unreadable);
  assert.deepEqual(f.calls, []);
});

test("capture on sends assistant text only and skips extraction", async () => {
  const f = fixture({ capture: true });
  await f.hooks.turn_end({ message: { role: "assistant", content: [
    { type: "text", text: "Example answer" }, { type: "thinking", thinking: "private reasoning" },
  ] }, toolResults: ["private output"] }, { sessionManager: { getSessionId: () => "example-session" } });
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].body;
  assert.equal(body.actorId, "example");
  assert.equal(body.extractionMode, "SKIP");
  assert.deepEqual(body.payload, [{ conversational: { role: "ASSISTANT", content: { text: "Example answer" } } }]);
  assert.ok(body.eventTimestamp instanceof Date);
  assert.ok(!JSON.stringify(body).includes("private"));
});

test("a failed namespace logs no error data and does not drop the next namespace", async () => {
  const f = fixture({}, (body) => {
    if (body.namespace.startsWith("/owner/")) throw new Error("CANARY_SECRET");
    return { memoryRecordSummaries: [{ memoryRecordId: "ok", content: { text: "Shared result" } }] };
  });
  const result = await f.hooks.before_agent_start(user, {});
  assert.equal(f.calls.length, 2);
  assert.match(result.message.content, /Shared result/);
  assert.equal(f.logs.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes("CANARY"));
});

test("timeouts abort each request even when a client never settles", async () => {
  const f = fixture({ recallTimeoutMs: 10 }, () => new Promise(() => {}));
  assert.equal(await f.hooks.before_agent_start(user, {}), undefined);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.options.abortSignal.aborted));
  assert.equal(f.logs.length, 2);
});

test("a slow client initializer cannot send after its deadline", async () => {
  const hooks = {}, logs = [], calls = [];
  let release;
  registerAgentCore({ on: (name, fn) => hooks[name] = fn }, { ...config, namespaces: ["/shared/"], recallTimeoutMs: 5 }, {
    createClient: () => new Promise((resolve) => release = resolve), log: (line) => logs.push(line),
  });
  assert.equal(await hooks.before_agent_start(user, {}), undefined);
  release({ retrieve: () => calls.push("unexpected") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(logs.length, 1);
  await hooks.session_shutdown();
});

test("empty retrieval, missing capture actor, and capture failure stay nonfatal", async () => {
  const empty = fixture({}, () => ({ memoryRecordSummaries: [] }));
  assert.equal(await empty.hooks.before_agent_start(user, {}), undefined);
  const noActor = fixture({ capture: true, actorId: "" });
  await noActor.hooks.turn_end({}, {});
  assert.equal(noActor.calls.length, 0);
  assert.match(noActor.logs[0], /actorId missing/);
  const hooks = {}, logs = [];
  registerAgentCore({ on: (name, fn) => hooks[name] = fn }, { ...config, capture: true }, {
    createClient: () => ({ capture() { throw new Error("CANARY_SECRET"); } }), log: (line) => logs.push(line),
  });
  await hooks.turn_end({ message: { role: "assistant", content: [{ type: "text", text: "Example" }] } },
    { sessionManager: { getSessionId: () => "example" } });
  assert.deepEqual(logs, ["AgentCore Memory: capture failed or timed out; turn continues"]);
});

test("custom starts and empty prompts do not query; shutdown prevents new calls", async () => {
  const f = fixture();
  await f.hooks.before_agent_start({ messageType: "custom" }, {});
  await f.hooks.before_agent_start({ ...user, prompt: " " }, {});
  assert.deepEqual(f.calls, []);
  await f.hooks.before_agent_start(user, {});
  await f.hooks.session_shutdown();
  await f.hooks.session_shutdown();
  await f.hooks.before_agent_start(user, {});
  assert.equal(f.calls.filter((c) => c.method === "destroy").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "retrieve").length, 2);
});

test("environment config defaults capture off and timeout to 3000; invalid fields fail", () => {
  assert.equal(readConfig({}), null);
  const minimal = { memoryId: "mem-EXAMPLE", region: "us-east-1", namespaces: ["/shared/"] };
  assert.deepEqual(readConfig({ AGENTCORE_MEMORY_CONFIG: JSON.stringify(minimal) }),
    { ...minimal, capture: false, topK: 10, actorId: "", recallTimeoutMs: 3000 });
  for (const patch of [{ capture: "true" }, { topK: 101 }, { namespaces: [] }, { region: "invalid" },
    { actorId: "../shared" }, { recallTimeoutMs: 0 }, { accessKey: "CANARY_SECRET" }]) {
    assert.throws(() => readConfig({ AGENTCORE_MEMORY_CONFIG: JSON.stringify({ ...minimal, ...patch }) }));
  }
});

test("SDK adapter uses default credentials, no retry, and the real command shapes", async () => {
  const calls = [];
  class Command { constructor(input) { this.input = input; } }
  const client = await createSdkClient(config, {
    BedrockAgentCoreClient: class {
      constructor(options) { assert.deepEqual(options, { region: config.region, maxAttempts: 1 }); }
      send(command, options) { calls.push({ command, options }); }
      destroy() { calls.push("closed"); }
    }, RetrieveMemoryRecordsCommand: Command, CreateEventCommand: Command,
  });
  const options = { abortSignal: new AbortController().signal };
  await client.retrieve({ memoryId: config.memoryId }, options);
  await client.capture({ memoryId: config.memoryId }, options);
  client.destroy();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options, options);
  assert.equal(calls[1].command.input.memoryId, config.memoryId);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.dependencies["@aws-sdk/client-bedrock-agentcore"], "3.1152.0");
});

test("extension factory registers hooks without an AWS call", () => {
  const previous = process.env.AGENTCORE_MEMORY_CONFIG;
  process.env.AGENTCORE_MEMORY_CONFIG = JSON.stringify(config);
  try {
    const names = [];
    extension({ on: (name) => names.push(name) });
    assert.deepEqual(names, ["before_agent_start", "turn_end", "session_shutdown"]);
  } finally {
    if (previous === undefined) delete process.env.AGENTCORE_MEMORY_CONFIG;
    else process.env.AGENTCORE_MEMORY_CONFIG = previous;
  }
});
