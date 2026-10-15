import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as sdk from "@aws-sdk/client-bedrock-agentcore";
import * as core from "../src/index.mjs";
import { createSdkClient } from "../src/index.mjs";

const COMMANDS = ["RetrieveMemoryRecordsCommand", "ListMemoryRecordsCommand", "BatchCreateMemoryRecordsCommand",
  "BatchUpdateMemoryRecordsCommand"];

test("the pinned SDK has the four command classes of the core", () => {
  for (const name of COMMANDS) assert.equal(typeof sdk[name], "function", name);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@aws-sdk/client-bedrock-agentcore"], "3.1152.0");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.packages["node_modules/@aws-sdk/client-bedrock-agentcore"].version, "3.1152.0");
});

test("the core module never references a delete command or a delete method", () => {
  const source = new URL("../src/", import.meta.url);
  const files = readdirSync(source).filter((name) => name.endsWith(".mjs"));
  assert.ok(files.includes("index.mjs"));
  for (const name of files) {
    const text = readFileSync(new URL(name, source), "utf8");
    assert.doesNotMatch(text, /Delete[A-Za-z]*Command|DeleteMemoryRecord|BatchDeleteMemoryRecords|deleteRecord|\.delete\(/, name);
  }
});

test("the SDK adapter: default credentials or the config profile, no retry, the four commands and no delete method", async () => {
  const calls = [];
  const options = [];
  class Command { constructor(input) { this.input = input; } }
  const fakeSdk = {
    BedrockAgentCoreClient: class {
      constructor(value) { options.push(value); }
      send(command, value) { calls.push({ command, value }); return Promise.resolve({}); }
      destroy() { calls.push("closed"); }
    },
    ...Object.fromEntries(COMMANDS.map((name) => [name, class extends Command { static commandName = name; }])),
  };
  const client = await createSdkClient({ region: "us-east-1" }, fakeSdk);
  assert.deepEqual(Object.keys(client).sort(), ["batchCreate", "batchUpdate", "destroy", "list", "retrieve"]);
  const signal = { abortSignal: new AbortController().signal };
  for (const method of ["retrieve", "list", "batchCreate", "batchUpdate"]) await client[method]({ memoryId: "mem-EXAMPLE" }, signal);
  client.destroy();
  assert.deepEqual(calls.slice(0, 4).map((call) => call.command.constructor.commandName), COMMANDS);
  assert.ok(calls.slice(0, 4).every((call) => call.value === signal && call.command.input.memoryId === "mem-EXAMPLE"));
  assert.equal(calls[4], "closed");
  assert.deepEqual(options[0], { region: "us-east-1", maxAttempts: 1 });
  await createSdkClient({ region: "us-east-1", profile: "pi-memory-person-chen" }, fakeSdk);
  assert.deepEqual(options[1], { region: "us-east-1", maxAttempts: 1, profile: "pi-memory-person-chen" });
});

test("the module exports every function of MemoryCoreModule", () => {
  for (const name of ["loadConfig", "validateConfig", "validateId", "createCore", "requestIdentifier", "validateRegistry",
    "personScope", "submitScope", "workerScope", "renderPersonConfig"]) {
    assert.equal(typeof core[name], "function", name);
  }
  for (const name of ["global", "actor", "projectShared", "proposals", "proposalsOfProject", "rejected", "rejectedOfProject",
    "recallSet"]) {
    assert.equal(typeof core.namespaces[name], "function", name);
  }
  assert.equal(core.namespaces.rejected("example-site", "chen"), "/project/example-site/rejected/chen/");
  assert.equal(core.namespaces.rejectedOfProject("example-site"), "/project/example-site/rejected/");
  assert.ok(core.namespaces.recallSet("chen", "example-site").every((namespace) => !namespace.includes("/rejected/")));
});
