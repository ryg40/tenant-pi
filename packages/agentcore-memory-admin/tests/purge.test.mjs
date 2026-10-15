import test from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE, fakeMemory, privateRegistry, record, run } from "./fakes.mjs";

function setup(extra = []) {
  const registry = privateRegistry();
  const memory = fakeMemory([
    record("mem-rejected-chen", "/project/example-site/rejected/chen/", "Duplicate fact\nsecond line",
      { metadata: { rejectedAt: { stringValue: "2026-01-05T00:00:00.000Z" } } }),
    record("mem-rejected-bruno", "/project/example-site/rejected/bruno/"),
    record("mem-proposal-chen", "/project/example-site/proposals/chen/"),
    record("mem-shared", "/project/example-site/shared/"),
    record("mem-other-project", "/project/example-project/rejected/chen/"),
    ...extra,
  ]);
  const deps = { readRegistry: registry.read, createMemory: () => memory,
    createSts: () => ({ send: async () => ({ Account: "111122223333" }), destroy() {} }) };
  return { registry, memory, deps };
}

const deletes = (memory) => memory.calls.filter((call) => call.name === "BatchDeleteMemoryRecords");

test("the purge dry run lists id, actor, date and first line of the rejected tree", async () => {
  const s = setup();
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /purge: \/project\/example-site\/rejected\//);
  assert.match(result.out, /records to delete: 2/);
  assert.match(result.out, /mem-rejected-chen chen 2026-01-05T00:00:00.000Z Duplicate fact$/m);
  assert.match(result.out, /mem-rejected-bruno bruno 2026-01-02T03:04:05.000Z text of mem-rejected-bruno$/m);
  assert.ok(!result.out.includes("second line"));
  assert.ok(!result.out.includes("mem-proposal-chen") && !result.out.includes("mem-other-project"));
  assert.deepEqual(deletes(s.memory), []);
});

test("the purge apply deletes the rejected tree of the project, or of one actor, and nothing else", async () => {
  let s = setup();
  let result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--person", "chen", "--apply",
    "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(deletes(s.memory).flatMap((call) => call.input.records),
    [{ memoryRecordId: "mem-rejected-chen", namespace: "/project/example-site/rejected/chen/" }]);
  s = setup();
  result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(s.memory.store.map((item) => item.memoryRecordId).sort(), ["mem-other-project", "mem-proposal-chen", "mem-shared"]);
});

test("the purge refuses a record that names a namespace outside the rejected tree", async () => {
  const s = setup([record("mem-mixed", "/project/example-site/rejected/dana/", "mixed",
    { namespaces: ["/project/example-site/rejected/dana/", "/project/example-site/shared/"] })]);
  const plan = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--profile", "admin-example"], s.deps);
  assert.match(plan.out, /apply refuses: 1 record\(s\) name a namespace outside \/project\/example-site\/rejected\//);
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 1);
  assert.match(result.err, /name a namespace outside \/project\/example-site\/rejected\/; nothing deleted/);
  assert.deepEqual(deletes(s.memory), []);
});

test("the purge builds the tree from valid ids only", async () => {
  for (const argv of [["--project", "example-*"], ["--project", "example-site/../"], ["--project", "example-site", "--person", "*"]]) {
    const result = await run(["purge", "--registry", EXAMPLE, ...argv]);
    assert.equal(result.code, 1);
    assert.match(result.err, /must match \[a-z0-9\]/);
  }
  assert.equal((await run(["purge", "--registry", EXAMPLE])).code, 2);
});

test("purge makes no STS call", async () => {
  const s = setup();
  s.deps.createSts = () => { throw new Error("blocked: no STS call"); };
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
});
