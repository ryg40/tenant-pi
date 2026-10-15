import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig, namespaces, validateConfig, validateId } from "../src/index.mjs";
import { chen, scratch } from "./helpers.mjs";

const minimal = { schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "chen", projects: [] };

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return { code: error.code, message: error.message };
  }
  assert.fail("no error");
}

test("loadConfig reads the kill switch, then the inline config, then the config file, then the default path", () => {
  const home = scratch("config");
  const file = join(home, "file.json");
  writeFileSync(file, JSON.stringify({ ...minimal, actorId: "dana" }));
  mkdirSync(join(home, ".config", "agentcore-memory"), { recursive: true });
  writeFileSync(join(home, ".config", "agentcore-memory", "config.json"), JSON.stringify({ ...minimal, actorId: "bruno" }));
  const inline = JSON.stringify(minimal);

  assert.equal(loadConfig({ AGENTCORE_MEMORY_DISABLE: "1", AGENTCORE_MEMORY_CONFIG: inline, HOME: home }), null);
  assert.equal(loadConfig({ AGENTCORE_MEMORY_CONFIG: inline, AGENTCORE_MEMORY_CONFIG_FILE: file, HOME: home }).actorId, "chen");
  assert.equal(loadConfig({ AGENTCORE_MEMORY_CONFIG_FILE: file, HOME: home }).actorId, "dana");
  assert.equal(loadConfig({ HOME: home }).actorId, "bruno");
  assert.equal(loadConfig({ AGENTCORE_MEMORY_DISABLE: "0", HOME: home }).actorId, "bruno");
  assert.equal(loadConfig({ HOME: scratch("empty") }), null);
});

test("the default path follows XDG_CONFIG_HOME when it is absolute", () => {
  assert.equal(configPath({ HOME: "/home/example" }), "/home/example/.config/agentcore-memory/config.json");
  assert.equal(configPath({ HOME: "/home/example", XDG_CONFIG_HOME: "/xdg" }), "/xdg/agentcore-memory/config.json");
  assert.equal(configPath({ HOME: "/home/example", XDG_CONFIG_HOME: "relative" }),
    "/home/example/.config/agentcore-memory/config.json");
});

test("a missing named config file, bad JSON and an unknown field fail with the code config and echo no value", () => {
  const home = scratch("config-bad");
  for (const env of [
    { AGENTCORE_MEMORY_CONFIG_FILE: join(home, "absent.json") },
    { AGENTCORE_MEMORY_CONFIG: "{\"CANARY_SECRET\": " },
    { AGENTCORE_MEMORY_CONFIG: JSON.stringify({ ...minimal, accessKey: "CANARY_SECRET" }) },
    { AGENTCORE_MEMORY_CONFIG: JSON.stringify({ ...minimal, memoryId: "CANARY SECRET" }) },
  ]) {
    const error = codeOf(() => loadConfig({ HOME: home, ...env }));
    assert.equal(error.code, "config");
    assert.equal(error.message, "agentcore-memory: config");
  }
});

test("validateConfig fills the defaults and refuses each invalid field", () => {
  assert.deepEqual(validateConfig(minimal), { ...minimal, topK: 10, recallTimeoutMs: 3000, writeTimeoutMs: 10000 });
  const config = validateConfig(chen);
  assert.equal(config.topK, 5);
  assert.deepEqual(config.projects[0], chen.projects[0]);
  for (const patch of [
    { schemaVersion: 2 }, { region: "invalid" }, { memoryId: "" }, { actorId: "Chen" }, { actorId: "c*" },
    { profile: "bad profile" }, { topK: 0 }, { topK: 101 }, { recallTimeoutMs: 0 }, { writeTimeoutMs: 600001 },
    { ledgerPath: " " }, { hostLabel: "a host" }, { projects: {} },
    { projects: [{ projectId: "example-project", role: "owner" }] },
    { projects: [{ projectId: "example-project", role: "member", extra: true }] },
    { projects: [{ projectId: "example-project", role: "member", remotes: [""] }] },
    { projects: [{ projectId: "example-project", role: "member" }, { projectId: "example-project", role: "maintainer" }] },
  ]) {
    assert.equal(codeOf(() => validateConfig({ ...minimal, ...patch })).code, "config", JSON.stringify(patch));
  }
  assert.equal(codeOf(() => validateConfig([])).code, "config");
});

test("validateId accepts [a-z0-9][a-z0-9-]{0,63} only", () => {
  for (const id of ["a", "chen", "example-project", "0x", "a".repeat(64)]) assert.equal(validateId(id), id);
  for (const id of ["", "-a", "A", "a*", "a?", "a/b", "a:b", "{a}", "a b", "a".repeat(65), "ä", 7, null, undefined]) {
    assert.equal(codeOf(() => validateId(id)).code, "config", String(id));
  }
});

test("the namespace builder validates every id and the recall set holds no proposals namespace", () => {
  assert.equal(namespaces.global(), "/shared/");
  assert.equal(namespaces.actor("chen"), "/actor/chen/");
  assert.equal(namespaces.projectShared("example-site"), "/project/example-site/shared/");
  assert.equal(namespaces.proposals("example-site", "chen"), "/project/example-site/proposals/chen/");
  assert.equal(namespaces.proposalsOfProject("example-site"), "/project/example-site/proposals/");
  assert.deepEqual(namespaces.recallSet("chen", null), ["/shared/", "/actor/chen/"]);
  assert.deepEqual(namespaces.recallSet("chen", "example-site"), ["/shared/", "/actor/chen/", "/project/example-site/shared/"]);
  for (const [actorId, projectId] of [["chen", null], ["chen", "example-site"], ["dana", "example-project"]]) {
    assert.ok(namespaces.recallSet(actorId, projectId).every((namespace) => !namespace.includes("/proposals/")));
  }
  assert.throws(() => namespaces.actor("*"), { code: "config" });
  assert.throws(() => namespaces.proposals("example-site", "../chen"), { code: "config" });
  assert.throws(() => namespaces.recallSet("chen", "example/site"), { code: "config" });
});
