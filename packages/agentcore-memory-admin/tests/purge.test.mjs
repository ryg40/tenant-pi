import test from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE, fakeMemory, privateRegistry, record, run } from "./fakes.mjs";

function setup(extra = [], change = undefined, options = {}) {
  const registry = privateRegistry(change);
  const memory = fakeMemory([
    record("mem-rejected-chen", "/project/example-site/rejected/chen/", "Duplicate fact\nsecond line",
      { metadata: { rejectedAt: { stringValue: "2026-01-05T00:00:00.000Z" } } }),
    record("mem-rejected-bruno", "/project/example-site/rejected/bruno/"),
    record("mem-proposal-chen", "/project/example-site/proposals/chen/"),
    record("mem-shared", "/project/example-site/shared/"),
    record("mem-other-project", "/project/example-project/rejected/chen/"),
    ...extra,
  ], options);
  const deps = { readRegistry: registry.read, createMemory: () => memory,
    createSts: () => ({ send: async () => ({ Account: "111122223333" }), destroy() {} }) };
  return { registry, memory, deps };
}

const deletes = (memory) => memory.calls.filter((call) => call.name === "BatchDeleteMemoryRecords");
const listed = (memory) => memory.calls.filter((call) => call.name === "ListMemoryRecords").map((call) => call.input.namespace);
const SITE = ["alice", "bruno", "chen", "dana"].map((actor) => `/project/example-site/rejected/${actor}/`);

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

test("the purge of a project lists one exact namespace for each person of the registry and deletes the records of two persons", async () => {
  // Dana is offboarded: the purge lists every status. Zoe is not in the registry.
  const offboarded = (value) => ({ ...value, people: value.people.map((person) => person.actorId === "dana" ? { ...person, status: "offboarded" } : person),
    projects: value.projects.map((project) => ({ ...project, members: project.members.filter((id) => id !== "dana") })) });
  const s = setup([record("mem-rejected-dana", "/project/example-site/rejected/dana/"),
    record("mem-rejected-zoe", "/project/example-site/rejected/zoe/")], offboarded);
  const plan = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--profile", "admin-example"], s.deps);
  assert.equal(plan.code, 0, plan.err);
  assert.ok(plan.out.includes(["purge: /project/example-site/rejected/", "namespaces listed (exact form):",
    `  ${SITE[0]} 0 record(s)`, `  ${SITE[1]} 1 record(s)`, `  ${SITE[2]} 1 record(s)`, `  ${SITE[3]} 1 record(s)`,
    "an actor outside the registry is not listed; give --person <actorId> for that namespace",
    "records to delete: 3 (request field namespace, exact form)"].join("\n")));
  assert.ok(!plan.out.includes("mem-rejected-zoe") && !plan.out.includes("prefix"));
  assert.deepEqual([...new Set(listed(s.memory))], SITE);
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /deleted 3 rejected record\(s\) of \/project\/example-site\/rejected\//);
  assert.deepEqual(deletes(s.memory).flatMap((call) => call.input.records).map((item) => [item.memoryRecordId, item.namespace]).sort(), [
    ["mem-rejected-bruno", SITE[1]], ["mem-rejected-chen", SITE[2]], ["mem-rejected-dana", SITE[3]]]);
  assert.ok(s.memory.store.some((item) => item.memoryRecordId === "mem-rejected-zoe"));
  const zoe = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--person", "zoe", "--apply",
    "--profile", "admin-example"], s.deps);
  assert.equal(zoe.code, 0, zoe.err);
  assert.ok(!s.memory.store.some((item) => item.memoryRecordId === "mem-rejected-zoe"));
});

test("the purge dry run without a profile names the exact namespaces that it lists", async () => {
  let result = await run(["purge", "--registry", EXAMPLE, "--project", "example-site"]);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(["purge: /project/example-site/rejected/", "namespaces to list (exact form):", ...SITE.map((ns) => `  ${ns}`),
    "an actor outside the registry is not listed; give --person <actorId> for that namespace",
    "records: not listed; give --profile <admin> to list them (read-only calls)"].join("\n")));
  result = await run(["purge", "--registry", EXAMPLE, "--project", "example-site", "--person", "chen"]);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(["purge: /project/example-site/rejected/chen/", "namespaces to list (exact form):", `  ${SITE[2]}`,
    "records: not listed; give --profile <admin> to list them (read-only calls)"].join("\n")));
});

test("the purge counts a record that is gone as done, and the dry run names the lag of the list index", async () => {
  const s = setup([], undefined, { lagging: [record("mem-rejected-gone", "/project/example-site/rejected/alice/")] });
  const plan = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--profile", "admin-example"], s.deps);
  assert.match(plan.out, /records to delete: 3 /);
  assert.match(plan.out, /^list index: it lags one to five minutes behind a write; a record that a step deleted or moved in that time can still be listed\napply: delete/m);
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^deleted 2 rejected record\(s\) of \/project\/example-site\/rejected\/\n1 record\(s\) were gone already \(error code 404\); counted as done\napply: done$/m);
  const again = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /deleted 0 rejected record\(s\)/);
});

test("a purge delete that fails with another code stops and prints the code and the message", async () => {
  const s = setup([], undefined, { failures: { "mem-rejected-bruno": { errorCode: 403, errorMessage: "not allowed" } } });
  const result = await run(["purge", "--registry", s.registry.file, "--project", "example-site", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 1);
  assert.equal(result.err, "error: 1 record delete(s) failed after 1 deleted; run the step again\n  mem-rejected-bruno: error code 403: not allowed");
});
