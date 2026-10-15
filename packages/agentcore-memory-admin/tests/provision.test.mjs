import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPerson, renderService } from "../src/render.mjs";
import { parsePolicy } from "../src/iam.mjs";
import { ACCOUNT, SECRET, fakeIam, privateRegistry, run } from "./fakes.mjs";

function setup(change) {
  const registry = privateRegistry(change);
  const iam = fakeIam();
  const keyDir = mkdtempSync(path.join(tmpdir(), "agentcore-admin-keys-"));
  const deps = { readRegistry: registry.read, keyDir, createIam: () => iam,
    createSts: () => ({ send: async () => ({ Account: ACCOUNT }), destroy() {} }) };
  return { registry, iam, keyDir, deps };
}

const apply = (s, command, person, extra = []) =>
  run([command, "--registry", s.registry.file, "--person", person, "--apply", "--profile", "admin-example", ...extra], s.deps);

const names = (iam) => iam.calls.map((call) => call.name);

test("the provisioning plan lists the four steps and the rendered policy", async () => {
  const s = setup();
  const result = await run(["provision", "--registry", s.registry.file, "--person", "dana"], { readRegistry: s.registry.read });
  assert.equal(result.code, 0);
  assert.match(result.out, /1\. create user pi-memory-person-dana \(no console access\)/);
  assert.match(result.out, /2\. put inline policy agentcore-memory/);
  assert.match(result.out, /3\. tag purpose=agentcore-memory actorId=dana/);
  assert.match(result.out, /4\. create one access key/);
  assert.deepEqual(s.iam.calls, []);
});

test("the apply creates the user, the policy, the tags and one key; the key goes to the key file only", async () => {
  const s = setup();
  const result = await apply(s, "provision", "dana");
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(names(s.iam).filter((name) => !name.startsWith("List") && !name.startsWith("Get") && name !== "destroy"),
    ["CreateUser", "PutUserPolicy", "TagUser", "CreateAccessKey"]);
  assert.ok(!names(s.iam).includes("CreateLoginProfile"), "no console access");
  const user = s.iam.users.get("pi-memory-person-dana");
  assert.deepEqual(parsePolicy(user.policies.get("agentcore-memory")),
    renderPerson(JSON.parse(s.registry.read()), "dana", { account: ACCOUNT }).real);
  assert.deepEqual(user.tags, [{ Key: "purpose", Value: "agentcore-memory" }, { Key: "actorId", Value: "dana" }]);
  assert.ok(!result.out.includes(SECRET) && !result.err.includes(SECRET), "no key value in the output");

  const files = readdirSync(s.keyDir).sort();
  assert.equal(files.length, 2);
  const keyFile = path.join(s.keyDir, files.find((name) => name.endsWith(".credentials")));
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(statSync(s.keyDir).mode & 0o777, 0o700);
  assert.match(readFileSync(keyFile, "utf8"), new RegExp(`^\\[pi-memory-person-dana\\]\\naws_access_key_id = EXAMPLEKEYID1\\naws_secret_access_key = ${SECRET}\\n$`));
  assert.ok(result.out.includes(keyFile), "the output names the key file path");
  const configFile = path.join(s.keyDir, files.find((name) => name.endsWith(".config.json")));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  assert.equal(config.profile, "pi-memory-person-dana");
  assert.equal(config.memoryId, "mem-PRIVATE01");
  assert.ok(!readFileSync(configFile, "utf8").includes(SECRET));
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
});

test("a second apply is idempotent: no second user, no policy write, no second key", async () => {
  const s = setup();
  assert.equal((await apply(s, "provision", "dana")).code, 0);
  s.iam.calls.length = 0;
  const result = await apply(s, "provision", "dana");
  assert.equal(result.code, 0, result.err);
  for (const name of ["CreateUser", "PutUserPolicy", "TagUser", "CreateAccessKey"]) assert.ok(!names(s.iam).includes(name), name);
  assert.match(result.out, /inline policy agentcore-memory is current/);
  assert.match(result.out, /user has 1 access key\(s\); no new key/);
  assert.equal(readdirSync(s.keyDir).length, 2);
});

test("an existing user gets only the policy difference", async () => {
  const s = setup();
  assert.equal((await apply(s, "provision", "chen")).code, 0);
  const changed = JSON.parse(s.registry.read());
  changed.projects[1].maintainers.push("chen");
  s.deps.readRegistry = () => JSON.stringify(changed);
  s.iam.calls.length = 0;
  const result = await apply(s, "provision", "chen");
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(names(s.iam).filter((name) => ["CreateUser", "PutUserPolicy", "CreateAccessKey"].includes(name)), ["PutUserPolicy"]);
  assert.match(result.out, /updated inline policy agentcore-memory/);
  const document = parsePolicy(s.iam.users.get("pi-memory-person-chen").policies.get("agentcore-memory"));
  assert.ok(document.Statement.some((statement) => statement.Sid === "Move"));
});

test("a user with another inline policy is refused before the policy write", async () => {
  const s = setup();
  s.iam.users.set("pi-memory-person-dana", { policies: new Map([["foreign", "{}"]]), keys: [], tags: [], attached: [], login: false });
  const result = await apply(s, "provision", "dana");
  assert.equal(result.code, 1);
  assert.match(result.err, /has another inline policy/);
  assert.ok(!names(s.iam).includes("PutUserPolicy"));
});

test("the account comes from --account or from STS with the admin profile", async () => {
  const s = setup();
  let sts = 0;
  s.deps.createSts = () => ({ send: async (name) => { sts += 1; assert.equal(name, "GetCallerIdentity"); return { Account: ACCOUNT }; }, destroy() {} });
  assert.equal((await apply(s, "provision", "dana")).code, 0);
  assert.equal(sts, 1);
  assert.equal((await apply(s, "provision", "chen", ["--account", "444455556666"])).code, 0);
  assert.equal(sts, 1);
  assert.match(s.iam.users.get("pi-memory-person-chen").policies.get("agentcore-memory"), /:444455556666:memory\/mem-PRIVATE01/);
});

test("the key directory must be outside the repository", async () => {
  const s = setup();
  const result = await apply(s, "provision", "dana", ["--key-dir", path.resolve(import.meta.dirname, "keys")]);
  assert.equal(result.code, 2);
  assert.match(result.err, /--key-dir must be outside the repository/);
  assert.ok(!names(s.iam).includes("CreateUser"));
});

test("rotate creates the second key into a new file and prints the delete command of the first", async () => {
  const s = setup();
  assert.equal((await apply(s, "provision", "dana")).code, 0);
  const result = await apply(s, "rotate", "dana");
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(s.iam.users.get("pi-memory-person-dana").keys, ["EXAMPLEKEYID1", "EXAMPLEKEYID2"]);
  assert.match(result.out, /aws iam delete-access-key --user-name pi-memory-person-dana --access-key-id EXAMPLEKEYID1 --profile admin-example/);
  assert.ok(!result.out.includes(SECRET));
  assert.equal(readdirSync(s.keyDir).filter((name) => name.endsWith(".credentials")).length, 2);
  const again = await apply(s, "rotate", "dana");
  assert.equal(again.code, 1);
  assert.match(again.err, /has 2 access keys; rotation needs exactly one/);
});

test("check reports no difference after provisioning, then each difference", async () => {
  const s = setup();
  const registry = JSON.parse(s.registry.read());
  for (const person of ["alice", "bruno", "chen", "dana"]) assert.equal((await apply(s, "provision", person)).code, 0);
  for (const kind of ["submit", "worker"]) {
    const rendered = renderService(registry, kind, { account: ACCOUNT });
    const arn = `arn:aws:iam::${ACCOUNT}:policy/example-${kind}`;
    s.iam.users.set(rendered.userName, { policies: new Map(), keys: ["EXAMPLEKEYID9"], tags: [], attached: [{ PolicyArn: arn }], login: false });
    s.iam.managed.set(arn, { versions: [{ id: "v1", document: JSON.stringify(rendered.real), default: true }] });
  }
  s.iam.calls.length = 0;
  let result = await run(["check", "--registry", s.registry.file, "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, /no difference/);
  assert.ok(names(s.iam).every((name) => name.startsWith("Get") || name.startsWith("List") || name === "destroy"), "read-only calls");

  s.iam.users.get("pi-memory-person-chen").policies.set("agentcore-memory", "{}");
  s.iam.users.get("pi-memory-person-dana").login = true;
  s.iam.users.set("pi-memory-person-zoe", { policies: new Map(), keys: [], tags: [], attached: [], login: false });
  s.iam.users.delete("pi-memory-person-bruno");
  result = await run(["check", "--registry", s.registry.file, "--profile", "admin-example"], s.deps);
  assert.equal(result.code, 1);
  assert.match(result.out, /pi-memory-person-chen inline policy agentcore-memory is not the rendered policy/);
  assert.match(result.out, /pi-memory-person-dana has console access/);
  assert.match(result.out, /pi-memory-person-zoe is not in the registry/);
  assert.match(result.out, /pi-memory-person-bruno is missing/);
  assert.match(result.out, /4 difference\(s\)/);
  assert.ok(!result.out.includes("mem-PRIVATE01"));
});

test("an SDK error prints its class name only, and a failed key creation leaves no key file", async () => {
  const s = setup();
  const send = s.iam.send;
  s.iam.send = async (name, input) => {
    if (name === "CreateAccessKey") {
      throw Object.assign(new Error(`denied for ${SECRET} and request data`), { name: "AccessDeniedException", $metadata: {} });
    }
    return send(name, input);
  };
  const result = await apply(s, "provision", "dana");
  assert.equal(result.code, 1);
  assert.equal(result.err, "error: aws or system call failed: AccessDeniedException");
  assert.ok(!result.out.includes(SECRET));
  assert.deepEqual(readdirSync(s.keyDir), []);
});
