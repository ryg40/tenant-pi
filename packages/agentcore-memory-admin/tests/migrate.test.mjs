import test from "node:test";
import assert from "node:assert/strict";
import { renderService } from "../src/render.mjs";
import { parsePolicy } from "../src/iam.mjs";
import { ACCOUNT, fakeIam, fakeMemory, privateRegistry, record, run } from "./fakes.mjs";

const OLD_READ = { Version: "2012-10-17", Statement: [{ Sid: "Read", Effect: "Allow",
  Action: ["bedrock-agentcore:RetrieveMemoryRecords"], Resource: "*",
  Condition: { "ForAllValues:StringLike": { "bedrock-agentcore:namespace": ["/shared/*", "/owner/*"] } } }] };

function setup({ versions = 1 } = {}) {
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
  ]);
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
const argv = (s, ...extra) => ["migrate", "--registry", s.registry.file, "--owner", "alice", "--smoke-record-id", "mem-smoke",
  "--profile", "admin-example", ...extra];

test("the migration plan lists the test records, the smoke record, the moves and the policy differences", async () => {
  const s = setup();
  const result = await run(argv(s), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /list form: request field namespace with the prefix \/owner\/alice\/; 4 record\(s\) listed/);
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
  const result = await run(argv(s, "--apply"), s.deps);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(s.sequence.filter((name) => WRITES.has(name)), ["BatchDeleteMemoryRecords", "BatchUpdateMemoryRecords",
    "CreatePolicyVersion", "DeletePolicyVersion", "CreatePolicyVersion", "DeletePolicyVersion"]);
  const deleted = s.memory.calls.find((call) => call.name === "BatchDeleteMemoryRecords").input.records.map((item) => item.memoryRecordId);
  assert.deepEqual(deleted.sort(), ["mem-check-0", "mem-check-1", "mem-check-2", "mem-owner-check", "mem-smoke"]);
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
  const again = await run(argv(s, "--apply"), s.deps);
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
