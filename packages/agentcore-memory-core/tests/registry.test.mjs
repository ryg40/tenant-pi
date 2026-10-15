import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { personScope, renderPersonConfig, submitScope, validateConfig, validateRegistry, workerScope } from "../src/index.mjs";

const registry = JSON.parse(readFileSync(new URL("./fixtures/registry.example.json", import.meta.url), "utf8"));
const clone = () => JSON.parse(JSON.stringify(registry));

test("the fixture registry holds the four example people and the two example projects with the placeholder memory id", () => {
  const valid = validateRegistry(registry);
  assert.deepEqual(valid.people.map((person) => [person.actorId, person.pin]),
    [["alice", "XYZ1000"], ["bruno", "XYZ1001"], ["chen", "XYZ1002"], ["dana", "XYZ1003"]]);
  assert.ok(valid.people.every((person) => person.email.endsWith("@example.com")));
  assert.deepEqual(valid.projects.map((project) => project.projectId), ["example-project", "example-site"]);
  assert.equal(valid.memory.memoryId, "mem-EXAMPLE");
});

test("validateRegistry refuses bad ids, roles outside the members, inactive or unknown members and duplicates", () => {
  const cases = [
    (r) => { r.schemaVersion = 2; },
    (r) => { r.extra = true; },
    (r) => { r.memory.region = "nowhere"; },
    (r) => { r.service.workerReadUser = r.service.submitUser; },
    (r) => { r.service.submitUser = "bad user"; },
    (r) => { r.people[0].actorId = "Alice"; },
    (r) => { r.people[0].actorId = "ali*"; },
    (r) => { r.people[1].actorId = "alice"; },
    (r) => { r.people[0].pin = "1000"; },
    (r) => { r.people[0].email = "alice"; },
    (r) => { r.people[0].status = "paused"; },
    (r) => { r.people[0].role = "owner"; },
    (r) => { r.projects[0].projectId = "example/project"; },
    (r) => { r.projects[1].projectId = "example-project"; },
    (r) => { r.projects[0].maintainers = ["erin"]; },
    (r) => { r.projects[1].maintainers = ["alice"]; },
    (r) => { r.projects[0].members.push("erin"); },
    (r) => { r.projects[0].members.push("dana"); },
    (r) => { r.people[3].status = "offboarded"; },
    (r) => { r.projects[0].remotes = [""]; },
    (r) => { r.projects[0].owner = "alice"; },
  ];
  for (const change of cases) {
    const value = clone();
    change(value);
    assert.throws(() => validateRegistry(value), { code: "config" }, change.toString());
  }
  const offboarded = clone();
  offboarded.people[3].status = "offboarded";
  offboarded.projects[0].members = ["alice", "bruno", "chen"];
  assert.equal(validateRegistry(offboarded).people[3].status, "offboarded");
  assert.throws(() => personScope(offboarded, "dana"), { code: "config" });
  assert.throws(() => renderPersonConfig(offboarded, "dana"), { code: "config" });
  assert.throws(() => personScope(registry, "erin"), { code: "config" });
});

test("personScope of a maintainer reads the proposals and rejected trees and moves between the three trees", () => {
  assert.deepEqual(personScope(registry, "bruno"), {
    read: ["/shared/*", "/actor/bruno/*", "/project/example-project/shared/*", "/project/example-project/proposals/bruno/*",
      "/project/example-site/shared/*", "/project/example-site/proposals/bruno/*", "/project/example-site/proposals/*",
      "/project/example-site/rejected/*"],
    write: ["/project/example-project/proposals/bruno/*", "/project/example-site/proposals/bruno/*"],
    move: ["/project/example-site/proposals/*", "/project/example-site/shared/*", "/project/example-site/rejected/*"],
  });
});

test("personScope of a member has an empty move and writes its own proposals namespaces only", () => {
  assert.deepEqual(personScope(registry, "chen"), {
    read: ["/shared/*", "/actor/chen/*", "/project/example-project/shared/*", "/project/example-project/proposals/chen/*",
      "/project/example-site/shared/*", "/project/example-site/proposals/chen/*"],
    write: ["/project/example-project/proposals/chen/*", "/project/example-site/proposals/chen/*"],
    move: [],
  });
  assert.deepEqual(personScope(registry, "dana").move, []);
  assert.deepEqual(personScope(registry, "alice").move,
    ["/project/example-project/proposals/*", "/project/example-project/shared/*", "/project/example-project/rejected/*"]);
});

test("no scope holds a delete, a wildcard id or a write into a shared namespace of a project", () => {
  const scopes = [...["alice", "bruno", "chen", "dana"].map((actorId) => personScope(registry, actorId)),
    submitScope(registry), workerScope(registry)];
  for (const scope of scopes) {
    assert.deepEqual(Object.keys(scope), ["read", "write", "move"]);
    assert.ok(!/delete/i.test(JSON.stringify(scope)));
    assert.ok([...scope.read, ...scope.write, ...scope.move].every((pattern) => pattern.startsWith("/") && pattern.endsWith("/*")));
  }
  for (const actorId of ["alice", "bruno", "chen", "dana"]) {
    assert.ok(personScope(registry, actorId).write.every((pattern) => /^\/project\/[a-z0-9-]+\/proposals\/[a-z0-9-]+\/\*$/.test(pattern)));
  }
  assert.deepEqual(submitScope(registry), { read: ["/shared/*", "/actor/*"], write: ["/shared/*", "/actor/*"],
    move: ["/shared/*", "/actor/*"] });
  assert.deepEqual(workerScope(registry), { read: ["/shared/*", "/project/*/shared/*"], write: [], move: [] });
});

test("renderPersonConfig gives a valid person config without profile, ledgerPath and hostLabel", () => {
  const config = renderPersonConfig(registry, "bruno");
  assert.deepEqual(config, { schemaVersion: 1, memoryId: "mem-EXAMPLE", region: "us-east-1", actorId: "bruno", projects: [
    { projectId: "example-project", role: "member", remotes: ["https://git.example.com/example/example-project.git"] },
    { projectId: "example-site", role: "maintainer", remotes: ["git@git.example.com:example/example-site.git"] },
  ] });
  assert.equal(validateConfig(config).actorId, "bruno");
  for (const actorId of ["alice", "chen", "dana"]) {
    const rendered = renderPersonConfig(registry, actorId);
    assert.ok(!("profile" in rendered) && !("ledgerPath" in rendered) && !("hostLabel" in rendered));
    validateConfig(rendered);
  }
  assert.deepEqual(renderPersonConfig(registry, "dana").projects.map((project) => project.role), ["member"]);
});
