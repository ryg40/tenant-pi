import "./no-outer-config.js"; // First: no test reads the artifacts config of the outer user.
import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REMOTE_GRACE_MS, remoteCommand } from "../src/compare-remote.js";
import { tmpRoot } from "./tmp-root.js";

// Remote mode with a fake ssh through the seam ARTIFACTS_SSH_COMMAND. The fake records its arguments and its
// standard input, then runs the remote command line through a real `sh -c`, as the remote shell does. On the
// "remote" PATH a fake walkr-compare records the words and the standard input that reach it.
const CLI = fileURLToPath(new URL("../src/walkr-compare.js", import.meta.url));
const HOST = "markerhost";
const MODULE = new URL("../src/compare-remote.js", import.meta.url).href;

async function setup(t, { remote = HOST } = {}) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-remote-"));
  const home = path.join(dir, "home");
  const config = path.join(dir, "config");
  const bin = path.join(dir, "bin");
  const stateDir = path.join(dir, "state");
  for (const folder of [home, path.join(config, "tenant-artifacts"), bin]) await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(stateDir, { mode: 0o700 });
  const data = remote === null ? { port: 6790 } : { port: 6790, remote };
  await fs.writeFile(path.join(config, "tenant-artifacts", "config.json"), JSON.stringify(data));
  const sshLog = path.join(dir, "ssh.json");
  const remoteLog = path.join(dir, "remote.json");
  // The fake ssh: FAKE_SSH=lost ends as a lost connection (exit 255).
  await fs.writeFile(path.join(bin, "fake-ssh"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0);
fs.writeFileSync(${JSON.stringify(sshLog)}, JSON.stringify({ argv, stdin: stdin.toString("utf8") }));
if (process.env.FAKE_SSH === "lost") { process.stderr.write("Connection closed by remote host\\n"); process.exit(255); }
const done = spawnSync("sh", ["-c", argv[argv.length - 1]], { input: stdin, stdio: ["pipe", "inherit", "inherit"] });
process.exit(done.status ?? 1);
`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "walkr-compare"), `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(remoteLog)}, JSON.stringify({ argv, stdin: fs.readFileSync(0).toString("utf8") }));
const id = "20260101T000000Z-000000000000";
process.stdout.write(argv[1] === "create" ? JSON.stringify({ sessionId: id, url: "http://127.0.0.1:1/x#" + id }) + "\\n" : '{"sessions":[]}\\n');
`, { mode: 0o755 });
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH}`,
    ARTIFACTS_SSH_COMMAND: `'${path.join(bin, "fake-ssh")}'`,
    HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_COMPARE_ROOT: path.join(dir, "compare"), HUMAN_REVIEW_IDLE_MS: "0",
  };
  delete env.HUMAN_REVIEW_HOSTED;
  t.after(async () => {
    try { process.kill(JSON.parse(await fs.readFile(path.join(stateDir, "server.json"), "utf8")).pid); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const read = async (file) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } };
  const cli = (args, extra = {}, input = "") => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  return {
    dir, stateDir, env, root: env.HUMAN_REVIEW_COMPARE_ROOT, cli, ssh: () => read(sshLog), remote: () => read(remoteLog),
    server: () => existsSync(path.join(stateDir, "server.json")),
  };
}

test("with the key remote a command goes to the host with --here; with --here or no key it stays local", async (t) => {
  const f = await setup(t);
  const listed = await f.cli(["list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout, '{"sessions":[]}\n');
  const { argv } = await f.ssh();
  assert.equal(argv[argv.indexOf("--") + 1], HOST);
  assert.deepEqual((await f.remote()).argv, ["--here", "list"]);
  assert.equal(f.server(), false, "remote mode starts no local server");
  assert.equal(existsSync(f.root), false, "remote mode writes no local store");

  const here = await setup(t);
  const local = await here.cli(["--here", "list"]);
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual(JSON.parse(local.stdout).sessions, []);
  assert.equal(await here.ssh(), null, "--here runs no ssh");
  assert.equal(here.server(), true);

  const none = await setup(t, { remote: null });
  const plain = await none.cli(["list"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(await none.ssh(), null, "no key remote runs no ssh");
  assert.equal(none.server(), true);
});

test("a shell character in a word or a request reaches the remote walkr-compare as text, the request on stdin only", async (t) => {
  // Each hostile word passes through the produced command line and a real sh; a canary file shows a run.
  const f = await setup(t);
  const canary = path.join(f.dir, "ran");
  const words = [`$(touch ${canary})`, `a; touch ${canary}`, "it's", '"q"', "`touch x`", "", "two words"];
  const ran = spawnSync("sh", ["-c", remoteCommand(words)], { env: f.env, cwd: f.dir, input: "" });
  assert.equal(ran.status, 0, String(ran.stderr));
  assert.deepEqual((await f.remote()).argv, ["--here", ...words]);
  assert.equal(existsSync(canary), false);

  const title = `$(touch ${canary}); echo 'quoted' "x"`;
  const body = JSON.stringify({ actionId: "remote-1", workflow: "text-revision", title, brief: "b",
    options: [{ optionId: "a", label: "A", format: "text", content: "x" }, { optionId: "b", label: "B", format: "text", content: "y" }] });
  const file = path.join(f.dir, "request.json");
  await fs.writeFile(file, body);
  const made = await f.cli(["create", file]);
  assert.equal(made.code, 0, made.stderr);
  const remote = await f.remote();
  assert.deepEqual(remote.argv, ["--here", "create", "-"]);
  assert.equal(remote.stdin, body);
  const { argv } = await f.ssh();
  assert.equal(argv.some((word) => word.includes("remote-1")), false, "no request content in the command line");
  assert.equal(existsSync(canary), false);
  assert.equal(JSON.parse(made.stdout).sessionId, "20260101T000000Z-000000000000", "stdout stays as the host wrote it");
});

test("a lost connection exits 3, writes nothing to the local store and starts no local server", async (t) => {
  const f = await setup(t);
  const file = path.join(f.dir, "request.json");
  await fs.writeFile(file, JSON.stringify({ actionId: "lost-1" }));
  for (const args of [["create", file], ["list"], ["wait", "20260101T000000Z-000000000000", "--timeout", "1"]]) {
    const lost = await f.cli(args, { FAKE_SSH: "lost" });
    assert.equal(lost.code, 3, `${args[0]}: ${lost.stderr}`);
    assert.equal(lost.stdout, "");
  }
  assert.equal(f.server(), false);
  assert.equal(existsSync(f.root), false);
});

test("a config that names an ssh option or is not JSON runs nothing: no ssh call and no local server", async (t) => {
  const option = await setup(t, { remote: "-oProxyCommand=x" });
  const broken = await setup(t);
  await fs.writeFile(path.join(broken.env.XDG_CONFIG_HOME, "tenant-artifacts", "config.json"), "{ not json");
  for (const f of [option, broken]) {
    const refused = await f.cli(["list"]);
    assert.notEqual(refused.code, 0, refused.stderr);
    assert.equal(await f.ssh(), null);
    assert.equal(f.server(), false);
  }
});

test("the answer of an ssh that ended comes complete and in time when a child of ssh keeps the pipes open", async (t) => {
  // The short limit goes through the option seconds of runRemote (the CLI gives each command 60 s or more).
  const f = await setup(t);
  const pidFile = path.join(f.dir, "child.pid");
  const fake = path.join(f.dir, "bin", "exit-with-child");
  await fs.writeFile(fake, `#!/bin/sh\nprintf '%s\\n' '{"sessions":[]}'\nsleep 8 &\necho $! > '${pidFile}'\nexit 0\n`, { mode: 0o755 });
  t.after(async () => { try { process.kill(Number(await fs.readFile(pidFile, "utf8"))); } catch {} });
  const seconds = 1;
  const script = `import { runRemote } from ${JSON.stringify(MODULE)};
try { await runRemote(${JSON.stringify(HOST)}, "list", ["list"], { seconds: ${seconds} }); }
catch (error) { process.stderr.write(String(error.message)); process.exitCode = error.exitCode ?? 1; }`;
  const started = Date.now();
  const done = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...f.env, ARTIFACTS_SSH_COMMAND: `'${fake}'` } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
  const elapsed = Date.now() - started;
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.stdout, '{"sessions":[]}\n');
  // The limit, the grace period and the start of node; the child of ssh lives 8 s.
  assert.ok(elapsed < seconds * 1000 + REMOTE_GRACE_MS + 2000, `${elapsed} ms`);
});
