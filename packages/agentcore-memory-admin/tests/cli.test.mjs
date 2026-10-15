import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { EXAMPLE, privateRegistry, run } from "./fakes.mjs";

const BIN = path.resolve(import.meta.dirname, "../bin/registry.mjs");

// The four script lines of the acceptance checks, and the other dry runs without a profile.
const DRY_RUNS = [
  ["render", "--registry", EXAMPLE, "--person", "bruno"],
  ["render", "--registry", EXAMPLE, "--person", "chen"],
  ["offboard", "--registry", EXAMPLE, "--person", "dana"],
  ["migrate", "--registry", EXAMPLE, "--owner", "alice"],
  ["render", "--registry", EXAMPLE, "--service", "submit"],
  ["render", "--registry", EXAMPLE, "--service", "worker"],
  ["provision", "--registry", EXAMPLE, "--person", "dana"],
  ["rotate", "--registry", EXAMPLE, "--person", "dana"],
  ["purge", "--registry", EXAMPLE, "--project", "example-site"],
  ["migrate", "--registry", EXAMPLE, "--owner", "alice", "--smoke-record-id", "mem-record-smoke"],
];

test("the dry runs without a profile create no AWS client", async () => {
  for (const argv of DRY_RUNS) {
    const result = await run(argv);
    assert.equal(result.code, 0, `${argv.join(" ")}: ${result.err}`);
    assert.match(result.out, /dry run: no AWS call; nothing changed$/);
  }
});

test("the provision and rotate plans create no AWS client, also with a profile", async () => {
  for (const command of ["provision", "rotate"]) {
    const result = await run([command, "--registry", EXAMPLE, "--person", "chen", "--profile", "admin-example"]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, new RegExp(`${command} plan for chen`));
    assert.match(result.out, /dry run: no AWS call; nothing changed$/);
  }
});

test("the script lines run as a process and exit 0", () => {
  for (const argv of DRY_RUNS.slice(0, 4)) {
    const output = execFileSync(process.execPath, [BIN, ...argv], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.match(output, /dry run: no AWS call; nothing changed\n$/);
  }
});

test("--apply without --profile is refused before any client", async () => {
  for (const argv of [["provision", "--person", "dana"], ["offboard", "--person", "dana"], ["migrate", "--owner", "alice"],
    ["rotate", "--person", "dana"], ["purge", "--project", "example-site"]]) {
    const registry = privateRegistry();
    const result = await run([...argv, "--registry", registry.file, "--apply"], { readRegistry: registry.read });
    assert.equal(result.code, 2);
    assert.match(result.err, /--apply needs --profile <admin>/);
  }
});

test("--apply refuses the example registry and is refused on render and check", async () => {
  let result = await run(["provision", "--registry", EXAMPLE, "--person", "dana", "--apply", "--profile", "admin-example"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /--apply refuses the example registry/);
  result = await run(["render", "--registry", EXAMPLE, "--person", "dana", "--apply", "--profile", "admin-example"]);
  assert.equal(result.code, 2);
  assert.match(result.err, /render is not an apply command/);
  result = await run(["check", "--registry", EXAMPLE]);
  assert.equal(result.code, 2);
  assert.match(result.err, /check needs --profile <admin>/);
});

test("usage errors exit 2", async () => {
  assert.equal((await run(["render", "--registry", EXAMPLE])).code, 2);
  assert.equal((await run(["render", "--registry", EXAMPLE, "--person", "chen", "--service", "worker"])).code, 2);
  assert.equal((await run(["render", "--person", "chen"])).code, 2);
  assert.equal((await run(["delete", "--registry", EXAMPLE])).code, 2);
  assert.equal((await run(["render", "--registry", EXAMPLE, "--unknown"])).code, 2);
  assert.equal((await run(["render", "--registry", EXAMPLE, "--person", "chen", "--account", "12"])).code, 2);
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--help"])).code, 0);
});

test("a person outside the registry, an invalid registry and a missing file fail with a static line", async () => {
  let result = await run(["render", "--registry", EXAMPLE, "--person", "zoe"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /registry: actorId is not a person of the registry/);
  result = await run(["render", "--registry", EXAMPLE, "--person", "chen"], { readRegistry: () => "{" });
  assert.equal(result.code, 1);
  assert.match(result.err, /registry: the file is missing or is not JSON/);
  result = await run(["render", "--registry", "/nonexistent/registry.json", "--person", "chen"]);
  assert.equal(result.code, 1);
});

test("a policy above 2,048 characters prints the count and fails", async () => {
  const registry = privateRegistry((value) => {
    for (let n = 0; n < 6; n += 1) value.projects.push({ projectId: `long-project-name-number-${n}`, maintainers: ["chen"], members: ["chen"] });
    return value;
  });
  const result = await run(["render", "--registry", registry.file, "--person", "chen"], { readRegistry: registry.read });
  assert.equal(result.code, 1);
  assert.match(result.out, /policy characters without white space: \d{4} of 2048/);
  assert.match(result.err, /IAM allows 2048 for the inline policies of one user/);
});

test("a dry run prints no memory id, account id or service user name without --show-values", async () => {
  const registry = privateRegistry((value) => ({ ...value, service: { submitUser: "private-submit-user", workerReadUser: "private-worker-user" } }));
  const hidden = ["mem-PRIVATE01", "111122223333", "private-submit-user", "private-worker-user"];
  for (const argv of DRY_RUNS) {
    const result = await run([argv[0], "--registry", registry.file, ...argv.slice(3), "--account", "111122223333"],
      { readRegistry: registry.read });
    assert.equal(result.code, 0, result.err);
    for (const value of hidden) assert.ok(!result.out.includes(value), `${argv[0]} prints a private value`);
  }
  const shown = await run(["render", "--registry", registry.file, "--service", "submit", "--account", "111122223333", "--show-values"],
    { readRegistry: registry.read });
  for (const value of ["mem-PRIVATE01", "111122223333", "private-submit-user"]) assert.ok(shown.out.includes(value));
});
