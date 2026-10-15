import test from "node:test";
import assert from "node:assert/strict";
import { renderService } from "../src/render.mjs";
import { parsePolicy } from "../src/iam.mjs";
import { ACCOUNT, fakeIam, fakeMemory, privateRegistry, record, run } from "./fakes.mjs";

const OLD_READ = { Version: "2012-10-17", Statement: [{ Sid: "Read", Effect: "Allow",
  Action: ["bedrock-agentcore:RetrieveMemoryRecords"], Resource: "*",
  Condition: { "ForAllValues:StringLike": { "bedrock-agentcore:namespace": ["/shared/*", "/owner/*"] } } }] };

function setup({ versions = 1, extra = [], lagging = [], failures = {} } = {}) {
  const registry = privateRegistry();
  const iam = fakeIam();
  for (const [kind, user] of [["submit", "example-memory-submit"], ["worker", "example-memory-worker"]]) {
    const arn = `arn:aws:iam::${ACCOUNT}:policy/example-${kind}`;
    iam.users.set(user, { policies: new Map(), keys: ["EXAMPLEKEYID9"], tags: [], login: false,
      attached: [{ PolicyArn: arn }, { PolicyArn: "arn:aws:iam::aws:policy/IAMUserChangePassword" }] });
    iam.managed.set(arn, { versions: Array.from({ length: versions }, (_, n) => ({ id: `v${n + 1}`,
      document: JSON.stringify(OLD_READ), default: n === versions - 1 })) });
  }
  const memory = fakeMemory([
    record("mem-smoke", "/shared/", "smoke"),
    record("mem-shared-keep", "/shared/", "global fact"),
    ...Array.from({ length: 3 }, (_, n) => record(`mem-check-${n}`, "/shared/livecheck/")),
    record("mem-owner-check", "/owner/alice/livecheck/"),
    record("mem-owner-1", "/owner/alice/", "private fact one"),
    record("mem-owner-2", "/owner/alice/notes/", "private fact two"),
    record("mem-owner-mixed", "/owner/alice/", "mixed", { namespaces: ["/owner/alice/", "/shared/"] }),
    record("mem-other-owner", "/owner/alice-two/"),
    ...extra,
  ], { lagging, failures });
  const sequence = [];
  for (const client of [iam, memory]) {
    const send = client.send;
    client.send = (name, input) => { sequence.push(name); return send(name, input); };
  }
  const deps = { readRegistry: registry.read, createIam: () => iam, createMemory: () => memory,
    createSts: () => ({ send: async () => ({ Account: ACCOUNT }), destroy() {} }) };
  return { registry, iam, memory, sequence, deps };
}

const WRITES = new Set(["BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords", "BatchCreateMemoryRecords",
  "CreatePolicyVersion", "DeletePolicyVersion"]);
const NOTES = ["--old-namespace", "/owner/alice/notes/"];
const argv = (s, ...extra) => ["migrate", "--registry", s.registry.file, "--owner", "alice", "--smoke-record-id", "mem-smoke",
  "--profile", "admin-example", ...extra];
const listed = (memory) => memory.calls.filter((call) => call.name === "ListMemoryRecords").map((call) => call.input.namespace);

test("the migration plan lists each exact namespace with its count, the test records, the smoke record, the moves and the policy differences", async () => {
  const s = setup();
  const result = await run(argv(s, ...NOTES), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^move: \/owner\/alice\/ to \/actor\/alice\/$/m);
  assert.match(result.out, /^move: \/owner\/alice\/notes\/ to \/actor\/alice\/notes\/$/m);
  assert.match(result.out, /a record in another path below \/owner\/alice\/ is not listed; give each such path with its own --old-namespace option/);
  assert.ok(result.out.includes(["namespaces listed (exact form):", "  /shared/livecheck/ 3 record(s)", "  /owner/alice/livecheck/ 1 record(s)",
    "  /owner/alice/ 2 record(s)", "  /owner/alice/notes/ 1 record(s)", "  /shared/ 3 record(s)"].join("\n")));
  assert.ok(!result.out.includes("prefix"));
  assert.deepEqual([...new Set(listed(s.memory))], ["/shared/livecheck/", "/owner/alice/livecheck/", "/owner/alice/", "/owner/alice/notes/",
    "/shared/"]);
  assert.match(result.out, /test records to delete: 4/);
  assert.match(result.out, /smoke record: mem-smoke \/shared\//);
  assert.match(result.out, /records to move: 2/);
  assert.match(result.out, /mem-owner-2 \/owner\/alice\/notes\/ -> \/actor\/alice\/notes\//);
  assert.match(result.out, /records kept, because they name another or a second namespace: 1/);
  assert.ok(!result.out.includes("mem-other-owner") && !result.out.includes("mem-shared-keep"));
  assert.match(result.out, /read identity policy: target namespaces \/shared\/\*, \/project\/\*\/shared\/\*/);
  assert.match(result.out, /submit identity policy: target namespaces \/shared\/\*, \/actor\/\*/);
  assert.match(result.out, /current namespaces \/shared\/\*, \/owner\/\*; 1 version\(s\); new default version/);
  assert.ok(!s.sequence.some((name) => WRITES.has(name)), "no write in a dry run");
  assert.ok(!result.out.includes("mem-PRIVATE01"));
});

test("the migration apply deletes the tests, moves the owner records, then narrows both policies", async () => {
  const s = setup();
  const result = await run(argv(s, ...NOTES, "--apply"), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(s.sequence.filter((name) => WRITES.has(name)), ["BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords",
    "CreatePolicyVersion", "DeletePolicyVersion", "CreatePolicyVersion", "DeletePolicyVersion"]);
  const deleted = s.memory.calls.find((call) => call.name === "BatchDeleteMemoryRecords").input.records;
  assert.deepEqual(deleted.map((item) => [item.memoryRecordId, item.namespace]).sort(), [["mem-check-0", "/shared/livecheck/"],
    ["mem-check-1", "/shared/livecheck/"], ["mem-check-2", "/shared/livecheck/"], ["mem-owner-check", "/owner/alice/livecheck/"],
    ["mem-smoke", "/shared/"]]);
  const moves = s.memory.calls.find((call) => call.name === "BatchUpdateMemoryRecords").input.records;
  assert.deepEqual(moves.map((move) => [move.memoryRecordId, move.sourceNamespaces, move.namespaces]), [
    ["mem-owner-1", ["/owner/alice/"], ["/actor/alice/"]],
    ["mem-owner-2", ["/owner/alice/notes/"], ["/actor/alice/notes/"]],
  ]);
  for (const move of moves) {
    assert.ok(!("content" in move), "a move sends no text");
    assert.deepEqual(move.metadata, { actorId: { stringValue: "alice" }, harness: { stringValue: "migration" },
      proposedAt: { stringValue: "2026-01-02T03:04:05.000Z" } });
  }
  const store = Object.fromEntries(s.memory.store.map((item) => [item.memoryRecordId, item.namespaces]));
  assert.deepEqual(store["mem-owner-1"], ["/actor/alice/"]);
  assert.deepEqual(store["mem-owner-mixed"], ["/owner/alice/", "/shared/"]);
  assert.ok(store["mem-shared-keep"] && store["mem-other-owner"]);
  for (const kind of ["submit", "worker"]) {
    const versions = s.iam.managed.get(`arn:aws:iam::${ACCOUNT}:policy/example-${kind}`).versions;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].id, "v2");
    assert.deepEqual(parsePolicy(versions[0].document), renderService(JSON.parse(s.registry.read()), kind, { account: ACCOUNT }).real);
    assert.ok(!versions[0].document.includes("/owner/"));
  }
  const again = await run(argv(s, ...NOTES, "--apply"), s.deps);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /moved 0 record\(s\)/);
  assert.match(again.out, /read identity policy is current/);
});

test("a policy with five versions stops the apply before the first write", async () => {
  const s = setup({ versions: 5 });
  const plan = await run(argv(s), s.deps);
  assert.match(plan.out, /apply refuses: the policy has five versions/);
  const result = await run(argv(s, "--apply"), s.deps);
  assert.equal(result.code, 1);
  assert.match(result.err, /policy has five versions; delete an old version first/);
  assert.ok(!s.sequence.some((name) => WRITES.has(name)));
});

test("the owner must be an active person of the registry and the smoke id must be valid", async () => {
  const s = setup();
  let result = await run(["migrate", "--registry", s.registry.file, "--owner", "zoe"], { readRegistry: s.registry.read });
  assert.equal(result.code, 1);
  assert.match(result.err, /--owner must be an active person of the registry/);
  result = await run(["migrate", "--registry", s.registry.file, "--owner", "alice", "--smoke-record-id", "mem smoke"],
    { readRegistry: s.registry.read });
  assert.equal(result.code, 2);
});

test("a record in a deeper path below /owner/<a>/ is not found without its own --old-namespace: a list is an exact match", async () => {
  const s = setup();
  const plan = await run(argv(s), s.deps);
  assert.equal(plan.code, 0, plan.err);
  assert.match(plan.out, /records to move: 1\n  mem-owner-1 \/owner\/alice\/ -> \/actor\/alice\/$/m);
  assert.ok(!plan.out.includes("mem-owner-2") && !plan.out.includes("/owner/alice/notes/"));
  assert.match(plan.out, /a record in another path below \/owner\/alice\/ is not listed/);
  assert.deepEqual([...new Set(listed(s.memory))], ["/shared/livecheck/", "/owner/alice/livecheck/", "/owner/alice/", "/shared/"]);
  const result = await run(argv(s, "--apply"), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /moved 1 record\(s\) from \/owner\/alice\/ to \/actor\/alice\//);
  const store = Object.fromEntries(s.memory.store.map((item) => [item.memoryRecordId, item.namespaces]));
  assert.deepEqual(store["mem-owner-1"], ["/actor/alice/"]);
  assert.deepEqual(store["mem-owner-2"], ["/owner/alice/notes/"]);
});

test("the migration dry run without a profile names each exact namespace that it lists", async () => {
  const s = setup();
  const result = await run(["migrate", "--registry", s.registry.file, "--owner", "alice", ...NOTES, ...NOTES],
    { readRegistry: s.registry.read });
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(["namespaces to list (exact form):", "  /shared/livecheck/", "  /owner/alice/livecheck/", "  /owner/alice/",
    "  /owner/alice/notes/", "records: not listed; give --profile <admin> to list them (read-only calls)"].join("\n")));
  assert.equal(result.out.match(/move: \/owner\/alice\/notes\//g).length, 1);
});

test("a test record that also names a namespace outside the test trees stays and is reported", async () => {
  const s = setup({ extra: [record("mem-check-mixed", "/shared/livecheck/", "mixed", { namespaces: ["/shared/livecheck/", "/actor/alice/"] })] });
  const plan = await run(argv(s), s.deps);
  assert.match(plan.out, /test records to delete: 4/);
  assert.match(plan.out, /records kept, because they name another or a second namespace: 2/);
  assert.match(plan.out, /mem-check-mixed \/shared\/livecheck\/,\/actor\/alice\//);
  const result = await run(argv(s, "--apply"), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.ok(s.memory.store.some((item) => item.memoryRecordId === "mem-check-mixed"));
});

test("--old-namespace takes a path below /owner/<owner>/ only", async () => {
  const s = setup();
  for (const value of ["/owner/alice/", "/owner/alice/livecheck/", "/owner/alice/notes", "/owner/alice-two/notes/", "/owner/alice/*/",
    "/owner/alice/../", "/owner/alice//", "/shared/notes/", "/actor/alice/notes/"]) {
    const result = await run(["migrate", "--registry", s.registry.file, "--owner", "alice", "--old-namespace", value],
      { readRegistry: s.registry.read });
    assert.equal(result.code, 2, value);
    assert.match(result.err, /--old-namespace must be a path below \/owner\/<owner>\//);
    assert.ok(!result.err.includes(value), "the diagnostic does not repeat the value");
  }
  const result = await run(argv(s, "--old-namespace", "/owner/alice/livecheck/", "--apply"), s.deps);
  assert.equal(result.code, 2);
  assert.ok(!s.sequence.some((name) => WRITES.has(name)));
});

test("a gone test record counts as done, and a failed move stops before the policies with its code and message", async () => {
  const s = setup({ lagging: [record("mem-check-gone", "/shared/livecheck/")],
    failures: { "mem-owner-1": { errorCode: 409, errorMessage: "conflict" } } });
  const plan = await run(argv(s), s.deps);
  assert.match(plan.out, /^list index: it lags one to five minutes behind a write/m);
  const result = await run(argv(s, "--apply"), s.deps);
  assert.equal(result.code, 1);
  assert.equal(result.err, "error: 1 record move(s) failed after 0 moved; run the step again\n  mem-owner-1: error code 409: conflict");
  assert.deepEqual(s.sequence.filter((name) => WRITES.has(name)), ["BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords"]);
  const plain = setup({ lagging: [record("mem-check-gone", "/shared/livecheck/")] });
  const done = await run(argv(plain, "--apply"), plain.deps);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^deleted 5 test record\(s\)\n1 record\(s\) were gone already \(error code 404\); counted as done$/m);
});
