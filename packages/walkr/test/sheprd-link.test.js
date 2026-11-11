import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpRoot } from "./tmp-root.js";

// A fake `sheprd` records its arguments and its standard input. The real `sheprd` never runs:
// PATH holds only the directory of the fake, or an empty directory.
const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/walkr-compare.js", import.meta.url));
const BASE_KEYS = ["sessionId", "replay", "status", "url"];

async function setup(t, { exit = 0, hang = false } = {}) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-sheprd-"));
  const stateDir = path.join(dir, "state");
  const bin = path.join(dir, "bin");
  const empty = path.join(dir, "empty");
  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.mkdir(bin);
  await fs.mkdir(empty);
  const args = path.join(dir, "args.txt");
  const input = path.join(dir, "input.txt");
  const body = hang ? "exec /bin/sleep 30" : `/bin/cat > '${input}'\nexit ${exit}`;
  await fs.writeFile(path.join(bin, "sheprd"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n${body}\n`, { mode: 0o755 });
  const request = path.join(dir, "request.json");
  await fs.writeFile(request, JSON.stringify({
    actionId: "link-1", workflow: "text-revision", title: "Link", brief: "Link check.",
    options: [
      { optionId: "a", label: "A", format: "text", content: "First version." },
      { optionId: "b", label: "B", format: "text", content: "Second version." },
    ],
  }));
  t.after(async () => {
    try { process.kill(JSON.parse(await fs.readFile(path.join(stateDir, "server.json"), "utf8")).pid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const env = (extra) => {
    const value = { ...process.env, HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_COMPARE_ROOT: path.join(dir, "compare"),
      HUMAN_REVIEW_IDLE_MS: "0", PATH: bin, ...extra };
    for (const name of ["HUMAN_REVIEW_HOSTED", "HUMAN_REVIEW_ALLOWED_HOSTS", "WALKR_SHEPRD_CONNECT", "HERDR_ENV"]) {
      if (!(name in extra)) delete value[name];
    }
    return value;
  };
  const cli = async (extra, ...rest) => (await run(process.execPath, [CLI, ...rest], { env: env(extra) })).stdout;
  const recorded = async (file) => { try { return await fs.readFile(file, "utf8"); } catch { return null; } };
  return { dir, stateDir, bin, empty, request, cli, args: () => recorded(args), input: () => recorded(input) };
}

const ON = { WALKR_SHEPRD_CONNECT: "1", HERDR_ENV: "1" };

test("the link is off when one of its three conditions is missing", async (t) => {
  const f = await setup(t);
  const cases = [
    { HERDR_ENV: "1" },
    { WALKR_SHEPRD_CONNECT: "1" },
    { ...ON, PATH: f.empty },
  ];
  for (const extra of cases) {
    const made = JSON.parse(await f.cli(extra, "create", f.request));
    assert.deepEqual(Object.keys(made), BASE_KEYS);
    // The URL holds the page secret: compare it without putting either value into a failure message.
    assert.ok(await f.cli(extra, "open") === `${made.url.split("#")[0]}\n`, "the open output is not the page url");
    assert.equal(await f.args(), null);
  }
});

test("with the link on, create tells Sheprd the address on standard input only", async (t) => {
  const f = await setup(t);
  const made = JSON.parse(await f.cli(ON, "create", f.request));
  assert.equal(made.sheprd, "connected");
  const args = (await f.args()).split("\n").filter(Boolean);
  const expected = ["walkr", "connect", "-", "--show"];
  assert.ok(args.length === expected.length && args.every((arg, i) => arg === expected[i]),
    "the recorded arguments are not walkr connect - --show");
  assert.ok((await f.input()).trimEnd() === made.url, "the recorded input is not the printed url");
});

for (const [name, fake] of [["exits 3", { exit: 3 }], ["hangs past the limit", { hang: true }]]) {
  test(`a sheprd that ${name} does not fail create`, async (t) => {
    const f = await setup(t, fake);
    const made = JSON.parse(await f.cli(ON, "create", f.request));
    assert.equal(made.sheprd, "failed");
  });
}

test("close runs only sheprd walkr disconnect when the link is on, and nothing when it is off", async (t) => {
  const f = await setup(t);
  assert.deepEqual(JSON.parse(await f.cli({ HERDR_ENV: "1" }, "close")), { sheprd: null });
  assert.equal(await f.args(), null);
  assert.deepEqual(JSON.parse(await f.cli(ON, "close")), { sheprd: "disconnected" });
  assert.deepEqual((await f.args()).split("\n").filter(Boolean), ["walkr", "disconnect"]);
});
