import test from "node:test";
import assert from "node:assert/strict";
import { fakeIam, fakeMemory, privateRegistry, record, run } from "./fakes.mjs";

const WRITES = new Set(["BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords", "BatchCreateMemoryRecords", "DeleteAccessKey",
  "DeleteUserPolicy", "DeleteUser", "CreateUser", "PutUserPolicy", "CreateAccessKey", "TagUser"]);

function setup(options = {}) {
  const registry = privateRegistry();
  const iam = fakeIam();
  iam.users.set("pi-memory-person-dana", { policies: new Map([["agentcore-memory", "{}"]]), keys: ["EXAMPLEKEYID1"], tags: [],
    attached: [], login: false });
  const records = [
    ...Array.from({ length: 150 }, (_, n) => record(`mem-actor-${n}`, "/actor/dana/")),
    record("mem-proposal-1", "/project/example-project/proposals/dana/"),
    record("mem-rejected-1", "/project/example-site/rejected/dana/"),
    record("mem-two-namespaces", "/actor/dana/", "kept", { namespaces: ["/actor/dana/", "/shared/"] }),
    record("mem-other-actor", "/actor/dana-two/"),
    record("mem-shared", "/project/example-project/shared/", "approved by alice", { metadata: { actorId: { stringValue: "dana" } } }),
    record("mem-proposal-chen", "/project/example-project/proposals/chen/"),
  ];
  const memory = fakeMemory(records, options);
  const sequence = [];
  for (const client of [iam, memory]) {
    const send = client.send;
    client.send = (name, input) => { sequence.push(name); return send(name, input); };
  }
  const deps = { readRegistry: registry.read, createIam: () => iam, createMemory: () => memory,
    createSts: () => ({ send: async () => ({ Account: "111122223333" }), destroy() {} }) };
  return { registry, iam, memory, sequence, deps };
}

test("the dry run with a profile lists the records, the user, its keys and policy, with read-only calls", async () => {
  const s = setup();
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /records to delete: 152 \(request field namespace, exact form\)/);
  assert.match(result.out, /mem-rejected-1 \/project\/example-site\/rejected\/dana\//);
  assert.match(result.out, /records kept, because they also name another namespace: 1/);
  assert.match(result.out, /iam user pi-memory-person-dana: 1 access key\(s\), inline policies: agentcore-memory/);
  assert.ok(!result.out.includes("mem-other-actor") && !result.out.includes("mem-shared"));
  assert.ok(!s.sequence.some((name) => WRITES.has(name)), "no write in a dry run");
  assert.deepEqual(result.written, []);
  const listed = s.memory.calls.filter((call) => call.name === "ListMemoryRecords").map((call) => call.input.namespace);
  assert.ok(listed.every((namespace) => namespace.endsWith("/")));
  assert.deepEqual([...new Set(listed)].sort(), ["/actor/dana/", "/project/example-project/proposals/dana/",
    "/project/example-project/rejected/dana/", "/project/example-site/proposals/dana/", "/project/example-site/rejected/dana/"]);
});

test("the apply deletes the records in batches of 100, then the keys, the policy and the user", async () => {
  const s = setup();
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  const writes = s.sequence.filter((name) => WRITES.has(name));
  assert.deepEqual(writes, ["BatchDeleteMemoryRecords", "BatchDeleteMemoryRecords", "DeleteAccessKey", "DeleteUserPolicy", "DeleteUser"]);
  const batches = s.memory.calls.filter((call) => call.name === "BatchDeleteMemoryRecords").map((call) => call.input.records);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 52]);
  assert.ok(batches.flat().every((item) => item.namespace && item.memoryRecordId));
  assert.deepEqual(batches.flat().find((item) => item.memoryRecordId === "mem-rejected-1").namespace, "/project/example-site/rejected/dana/");
  assert.deepEqual(s.memory.store.map((item) => item.memoryRecordId).sort(),
    ["mem-other-actor", "mem-proposal-chen", "mem-shared", "mem-two-namespaces"]);
  assert.ok(!s.iam.users.has("pi-memory-person-dana"));
  assert.equal(result.written.length, 1);
  const next = result.written[0].registry;
  assert.equal(next.people.find((person) => person.actorId === "dana").status, "offboarded");
  assert.ok(next.projects.every((project) => !project.members.includes("dana") && !project.maintainers.includes("dana")));
});

test("a user with an item that the tool never creates stops the apply before the first delete", async () => {
  const s = setup();
  s.iam.users.get("pi-memory-person-dana").attached = [{ PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess" }];
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 1);
  assert.match(result.err, /has an attached managed policy; remove it by hand first/);
  assert.ok(!s.sequence.some((name) => WRITES.has(name)));
  assert.deepEqual(result.written, []);
});

test("the last maintainer of a project cannot be offboarded", async () => {
  const s = setup();
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "bruno"], { readRegistry: s.registry.read });
  assert.equal(result.code, 1);
  assert.match(result.err, /bruno is the last maintainer of example-site/);
});

test("a second apply after a finished offboarding finds nothing and keeps the registry valid", async () => {
  const s = setup();
  const first = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(first.code, 0);
  s.deps.readRegistry = () => JSON.stringify(first.written[0].registry);
  const second = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /deleted 0 record\(s\)/);
  assert.match(second.out, /user pi-memory-person-dana was absent/);
});

const LAG = /^list index: it lags one to five minutes behind a write; a record that a step deleted or moved in that time can still be listed$/m;

test("a record that the list index still holds after its delete counts as done, and the apply goes on to the IAM steps", async () => {
  // The live proof of 2026-10-15, round 4: a purge deleted the rejected record; offboarding one minute later still listed it.
  const s = setup({ lagging: [record("mem-purged", "/project/example-project/rejected/dana/")] });
  const plan = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--profile", "admin-example"], s.deps);
  assert.match(plan.out, /records to delete: 153 /);
  assert.match(plan.out, LAG);
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^deleted 152 record\(s\)\n1 record\(s\) were gone already \(error code 404\); counted as done$/m);
  assert.deepEqual(s.sequence.filter((name) => WRITES.has(name)),
    ["BatchDeleteMemoryRecords", "BatchDeleteMemoryRecords", "DeleteAccessKey", "DeleteUserPolicy", "DeleteUser"]);
  assert.equal(result.written.length, 1);
});

test("any other failed delete stops the apply before the IAM steps and names the code and the message of each failed record", async () => {
  const s = setup({ failures: {
    "mem-rejected-1": { errorCode: 500, errorMessage: "internal\nfailure \u001b[31mred" },
    "mem-proposal-1": {},
  } });
  const result = await run(["offboard", "--registry", s.registry.file, "--person", "dana", "--apply", "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 1);
  assert.match(result.err, /^error: 2 record delete\(s\) failed after 150 deleted; run the step again$/m);
  assert.match(result.err, /^  mem-rejected-1: error code 500: internal failure {2}\[31mred$/m);
  assert.match(result.err, /^  mem-proposal-1: error code none: no message$/m);
  assert.ok(!/[\x00-\x09\x0b-\x1f]/.test(result.err), "no control character reaches the terminal");
  assert.ok(!s.sequence.some((name) => ["DeleteAccessKey", "DeleteUserPolicy", "DeleteUser"].includes(name)));
  assert.deepEqual(result.written, []);
});
