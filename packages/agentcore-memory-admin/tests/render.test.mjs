import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../../agentcore-memory-core/src/index.mjs";
import { namespaces, personScope, renderPersonConfig, submitScope, validateRegistry, workerScope } from "../src/core.mjs";
import { POLICY_LIMIT, memoryArn, policySize, renderPerson, renderService } from "../src/render.mjs";
import { ACCOUNT, example } from "./fakes.mjs";

const CANARY = "canary-value-of-the-registry";
const KEY = "bedrock-agentcore:namespace";
const DELETES = ["bedrock-agentcore:DeleteMemoryRecord", "bedrock-agentcore:BatchDeleteMemoryRecords", "bedrock-agentcore:GetMemoryRecord"];

function rejects(change, pattern) {
  const value = example();
  change(value);
  assert.throws(() => validateRegistry(value), (error) => {
    assert.equal(error.code, "config");
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(CANARY), "the message names the field, never the value");
    return true;
  });
}

test("the example registry is valid", () => {
  assert.equal(validateRegistry(example()).people.length, 4);
});

test("a maintainer who is not a member is refused", () => {
  rejects((value) => { value.people.push({ actorId: "eve", name: CANARY, email: "eve@example.com", status: "active" });
    value.projects[1].maintainers.push("eve"); }, /projects\[1\]\.maintainers\[1\] is not a member/);
});

test("an inactive member is refused", () => {
  rejects((value) => { value.people[3].status = "offboarded"; value.people[3].name = CANARY; },
    /projects\[0\]\.members\[3\] is not an active person/);
});

test("a duplicate id is refused", () => {
  rejects((value) => { value.people.push({ ...value.people[2], name: CANARY, pin: "XYZ1009" }); }, /people\[4\]\.actorId is a duplicate/);
  rejects((value) => { value.projects.push({ ...value.projects[0], remotes: [CANARY] }); }, /projects\[2\]\.projectId is a duplicate/);
});

test("an id with a wildcard or a slash is refused", () => {
  rejects((value) => { value.people[0].actorId = `${CANARY}*`; }, /people\[0\]\.actorId must match/);
  rejects((value) => { value.projects[0].projectId = `example/${CANARY}`; }, /projects\[0\]\.projectId must match/);
  rejects((value) => { value.projects[0].members[1] = "bru?no"; }, /projects\[0\]\.members\[1\] must match/);
});

test("other registry errors name the field only", () => {
  rejects((value) => { value.surplus = CANARY; }, /registry\.surplus is not a known field/);
  rejects((value) => { value.people[0].pin = CANARY; }, /people\[0\]\.pin has an invalid value/);
  rejects((value) => { value.people[1].email = CANARY; }, /people\[1\]\.email has an invalid value/);
  rejects((value) => { value.projects[0].members.push("zoe"); }, /is not a person of the registry/);
  rejects((value) => { value.projects[0].maintainers = []; }, /needs at least one maintainer/);
  rejects((value) => { value.memory.memoryId = `${CANARY} x`; }, /memory\.memoryId has an invalid value/);
  rejects((value) => { value.service.workerReadUser = value.service.submitUser; }, /service needs two different users/);
});

test("the namespace builder gives the rejected trees and never a wildcard", () => {
  assert.equal(namespaces.rejected("example-site", "chen"), "/project/example-site/rejected/chen/");
  assert.equal(namespaces.rejectedOfProject("example-site"), "/project/example-site/rejected/");
  // The builder of the core refuses with its static code, never with the value.
  assert.throws(() => namespaces.actor("a*"), { name: "MemoryError", code: "config", message: "agentcore-memory: config" });
  assert.deepEqual(namespaces.recallSet("chen", "example-site"), ["/shared/", "/actor/chen/", "/project/example-site/shared/"]);
});

test("the namespace builder, the scopes and the person config are the functions of the core", () => {
  const registry = example();
  assert.equal(namespaces, core.namespaces);
  for (const { actorId } of registry.people) {
    assert.deepEqual(personScope(registry, actorId), core.personScope(registry, actorId));
    assert.deepEqual(renderPersonConfig(registry, actorId), core.renderPersonConfig(registry, actorId));
  }
  assert.deepEqual(submitScope(registry), core.submitScope(registry));
  assert.deepEqual(workerScope(registry), core.workerScope(registry));
});

test("the script refuses two registries that the core accepts: a duplicate PIN and a project without a maintainer", () => {
  const twinPin = (value) => { value.people[1].pin = value.people[0].pin; };
  const noMaintainer = (value) => { value.projects[0].maintainers = []; };
  for (const change of [twinPin, noMaintainer]) {
    const value = example();
    change(value);
    assert.doesNotThrow(() => core.validateRegistry(value));
  }
  rejects(twinPin, /people has a duplicate pin/);
  rejects(noMaintainer, /projects\[0\]\.maintainers needs at least one maintainer/);
});

function invariants(document) {
  const text = JSON.stringify(document);
  assert.deepEqual(JSON.parse(text), document);
  const resources = new Set(document.Statement.map((statement) => statement.Resource));
  assert.equal(resources.size, 1, "one resource");
  assert.ok(![...resources][0].includes("*"), "the resource is not a wildcard");
  for (const statement of document.Statement) {
    if (statement.Condition?.["ForAllValues:StringLike"]) assert.deepEqual(statement.Condition.Null, { [KEY]: "false" });
    for (const action of statement.Action) assert.ok(!DELETES.includes(action), `no ${action}`);
  }
  for (const action of DELETES) assert.ok(!text.includes(action));
  assert.ok(!text.includes("namespacePath"));
  assert.ok(policySize(document) < POLICY_LIMIT);
}

test("each of the four people renders a valid policy below the limit", () => {
  const registry = example();
  for (const person of registry.people) {
    const rendered = renderPerson(registry, person.actorId, { account: ACCOUNT });
    invariants(rendered.real);
    invariants(rendered.shown);
    assert.equal(rendered.userName, `pi-memory-person-${person.actorId}`);
    assert.equal(rendered.policyName, "agentcore-memory");
    assert.equal(rendered.real.Statement[0].Resource, memoryArn("us-east-1", ACCOUNT, "mem-EXAMPLE"));
    assert.equal(rendered.shown.Statement[0].Resource, "arn:aws:bedrock-agentcore:us-east-1:<account>:memory/<memoryId>");
    assert.equal(rendered.shownConfig.memoryId, "<memoryId>");
  }
});

test("Chen's policy is the example of the security document: no Move, both own proposals in Write", () => {
  const rendered = renderPerson(example(), "chen", {});
  const [read, write, ...rest] = rendered.shown.Statement;
  assert.deepEqual(rest, []);
  assert.deepEqual(read.Condition.StringLike[KEY], ["/shared/*", "/actor/chen/*", "/project/example-project/shared/*",
    "/project/example-project/proposals/chen/*", "/project/example-site/shared/*", "/project/example-site/proposals/chen/*"]);
  assert.deepEqual(write.Action, ["bedrock-agentcore:BatchCreateMemoryRecords"]);
  assert.deepEqual(write.Condition["ForAllValues:StringLike"][KEY],
    ["/project/example-project/proposals/chen/*", "/project/example-site/proposals/chen/*"]);
  assert.ok(!rendered.shown.Statement.some((statement) => statement.Sid === "Move"));
});

test("Bruno's policy has the Move statement with the three trees of example-site", () => {
  const rendered = renderPerson(example(), "bruno", {});
  const read = rendered.shown.Statement.find((statement) => statement.Sid === "Read").Condition.StringLike[KEY];
  assert.ok(read.includes("/project/example-site/proposals/*"));
  assert.ok(read.includes("/project/example-site/rejected/*"));
  assert.ok(!read.includes("/project/example-project/proposals/*"), "a member does not read other proposals");
  const write = rendered.shown.Statement.find((statement) => statement.Sid === "Write").Condition["ForAllValues:StringLike"][KEY];
  assert.ok(!write.some((pattern) => pattern.includes("/shared/")), "a maintainer promotes by a move, never by a create");
  const move = rendered.shown.Statement.find((statement) => statement.Sid === "Move");
  assert.deepEqual(move.Action, ["bedrock-agentcore:BatchUpdateMemoryRecords"]);
  assert.deepEqual(move.Condition["ForAllValues:StringLike"][KEY],
    ["/project/example-site/proposals/*", "/project/example-site/shared/*", "/project/example-site/rejected/*"]);
  assert.deepEqual(move.Condition.Null, { [KEY]: "false" });
});

test("Dana's scope names her own trees of example-project and nothing else", () => {
  assert.deepEqual(personScope(example(), "dana"), {
    read: ["/shared/*", "/actor/dana/*", "/project/example-project/shared/*", "/project/example-project/proposals/dana/*"],
    write: ["/project/example-project/proposals/dana/*"],
    move: [],
  });
});

test("the two service policies come from submitScope and workerScope", () => {
  const registry = example();
  const submit = renderService(registry, "submit", { account: ACCOUNT });
  invariants(submit.real);
  assert.deepEqual(submit.scope, submitScope(registry));
  assert.deepEqual(submit.real.Statement.map((statement) => statement.Sid), ["Read", "Write", "Move"]);
  for (const statement of submit.real.Statement) {
    assert.deepEqual(Object.values(statement.Condition).find((block) => Array.isArray(block[KEY]))[KEY], ["/shared/*", "/actor/*"]);
  }
  const worker = renderService(registry, "worker", { account: ACCOUNT });
  invariants(worker.real);
  assert.deepEqual(worker.scope, workerScope(registry));
  assert.deepEqual(worker.real.Statement.map((statement) => statement.Sid), ["Read"]);
  assert.deepEqual(worker.real.Statement[0].Condition.StringLike[KEY], ["/shared/*", "/project/*/shared/*"]);
  assert.throws(() => renderService(registry, "admin", {}), /--service must be submit or worker/);
});

test("the person config holds the memberships and no key, profile or ledger", () => {
  const config = renderPersonConfig(example(), "bruno");
  assert.deepEqual(config.projects.map((project) => [project.projectId, project.role]),
    [["example-project", "member"], ["example-site", "maintainer"]]);
  assert.deepEqual(Object.keys(config).sort(), ["actorId", "memoryId", "projects", "region", "schemaVersion"]);
  assert.match(renderPerson(example(), "bruno", {}).note, /"profile": "pi-memory-person-bruno"/);
});

test("the count is the real policy without white space, and a large policy passes the limit", () => {
  const registry = example();
  const shown = renderPerson(registry, "bruno", {});
  const real = renderPerson(registry, "bruno", { account: ACCOUNT, showValues: true });
  assert.equal(shown.size, real.size);
  assert.equal(shown.size, JSON.stringify(real.real).length);
  for (let n = 0; n < 6; n += 1) {
    registry.projects.push({ projectId: `long-project-name-number-${n}`, maintainers: ["chen"], members: ["chen"] });
  }
  assert.ok(renderPerson(registry, "chen", {}).size > POLICY_LIMIT);
});
