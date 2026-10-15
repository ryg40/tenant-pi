import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, TOOL_NAME } from "../runtime.mjs";

const CANARY = "CANARY_SECRET";
const INDEX = new URL("../index.ts", import.meta.url).href;
const FAKE = new URL("./fake-core.mjs", import.meta.url).href;
const CORE = new URL("../../agentcore-memory-core/src/index.mjs", import.meta.url);

// Only the core import of `index.ts` goes to the fake. Other imports resolve as usual.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../agentcore-memory-core/src/index.mjs" && context.parentURL === INDEX) return { url: FAKE, shortCircuit: true };
    return next(specifier, context);
  },
});
const { state } = await import(FAKE);
const { default: extension } = await import(INDEX);

function load(config) {
  Object.assign(state, { config, env: null, created: [], resolved: [] });
  const names = [], lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    extension({ on: (name, handler) => names.push([name, handler]), registerTool: (tool) => names.push([tool.name, tool]) });
  } finally {
    console.error = original;
  }
  return { names: names.map(([name]) => name), handlers: Object.fromEntries(names), lines };
}

test("the factory without a config registers nothing and prints one static line", () => {
  const result = load(null);
  assert.deepEqual(result.names, []);
  assert.deepEqual(result.lines, [LINES.inactive]);
  assert.equal(state.env, process.env);
});

test("the factory with an invalid config prints one static line and no config value", () => {
  const result = load(Object.assign(new Error(CANARY), { code: "config" }));
  assert.deepEqual(result.names, []);
  assert.deepEqual(result.lines, [LINES.invalid]);
});

test("the factory with a config registers the hooks and the tool, and resolves from the process directory", async () => {
  const config = { schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "chen", projects: [] };
  const result = load(config);
  assert.deepEqual(result.names, ["before_agent_start", TOOL_NAME, "session_shutdown"]);
  assert.deepEqual(state.created, [config]);
  await result.handlers.before_agent_start({ messageType: "user", prompt: "Example query" }, {});
  assert.equal(state.resolved.length, 1);
  assert.equal(state.resolved[0].cwd, process.cwd());
  assert.equal(state.resolved[0].env, process.env);
  await result.handlers.session_shutdown();
  assert.deepEqual(result.lines, []);
});

// After the core implementation merges, this test loads `index.ts` with the real core in a clean
// process. It sends no AWS request: no prompt runs, and the core creates its client lazily.
test("index.ts resolves the real core beside it", { skip: existsSync(CORE) ? false : "the core implementation src/index.mjs is absent" }, () => {
  const home = mkdtempSync(join(tmpdir(), "agentcore-pi-home-"));
  try {
    const file = join(home, "config.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "chen",
      projects: [{ projectId: "example-project", role: "member" }] }), { mode: 0o600 });
    const script = "const { default: extension } = await import(process.argv[1]); const names = [];"
      + " extension({ on: (name) => names.push(name), registerTool: (tool) => names.push(tool.name) });"
      + " console.log(JSON.stringify(names));";
    const run = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, fileURLToPath(INDEX)], {
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), ...env }, encoding: "utf8", timeout: 20000,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.deepEqual(run({}), []);
    assert.deepEqual(run({ AGENTCORE_MEMORY_CONFIG_FILE: file, AGENTCORE_MEMORY_DISABLE: "1" }), []);
    assert.deepEqual(run({ AGENTCORE_MEMORY_CONFIG_FILE: file }), ["before_agent_start", TOOL_NAME, "session_shutdown"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
