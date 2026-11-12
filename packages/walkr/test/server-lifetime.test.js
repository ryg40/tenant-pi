import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpRoot } from "./tmp-root.js";

// Each test runs a detached server process of its own: the sweep ends the process, not a test runner.
const ENTRY = fileURLToPath(new URL("../src/server-entry.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateDir(t) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "walkr-lifetime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state");
}

function readRecord(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Start server-entry.js for `dir`; the test stops it at the end if it still runs. */
async function startServer(t, dir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, HUMAN_REVIEW_STATE_DIR: dir, HUMAN_REVIEW_SWEEP_MS: "100", ...env },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  for (let i = 0; i < 100; i += 1) {
    const record = readRecord(dir);
    if (record?.pid === child.pid) return { child, exited, record };
    await sleep(50);
  }
  throw new Error("the server did not write its record");
}

async function health(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
  } catch {
    return false;
  }
}

/** True when the child exits within `ms`. */
const exitsWithin = (exited, ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);

test("a server with only health-check traffic stops after the idle time", async (t) => {
  const dir = stateDir(t);
  const { exited, record } = await startServer(t, dir, { HUMAN_REVIEW_IDLE_MS: "600" });
  let stop = false;
  const checks = (async () => {
    while (!stop) {
      await health(record.port);
      await sleep(100);
    }
  })();
  const ended = await exitsWithin(exited, 5000);
  stop = true;
  await checks;
  assert.equal(ended, true);
});

test("a server whose state directory is removed stops", async (t) => {
  const dir = stateDir(t);
  const { exited, record } = await startServer(t, dir, { HUMAN_REVIEW_IDLE_MS: "0" });
  assert.equal(await health(record.port), true);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(await exitsWithin(exited, 5000), true);
});

/** Run `fn` with the environment of an ensureServer call for `dir`, then restore the outer values. */
async function withServerEnv(dir, fn) {
  // An empty HUMAN_REVIEW_HOSTED: an outer HUMAN_REVIEW_HOSTED=1 must not turn the call into the hosted refusal.
  const vars = { HUMAN_REVIEW_STATE_DIR: dir, HUMAN_REVIEW_IDLE_MS: "0", HUMAN_REVIEW_HOSTED: "" };
  const previous = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("ensureServer replaces an older-protocol server of the same state directory", async (t) => {
  const dir = stateDir(t);
  const { exited, record } = await startServer(t, dir, { HUMAN_REVIEW_IDLE_MS: "0" });
  // The running server now looks like one of an older Walkr version: same pid and port, older protocol.
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ ...record, protocol: record.protocol - 1 }));

  const { ensureServer } = await import("../src/local-server.js");
  let fresh = null;
  t.after(async () => {
    if (fresh?.pid) {
      try {
        process.kill(fresh.pid);
      } catch {}
      for (let i = 0; i < 50 && (await health(fresh.port)); i += 1) await sleep(50);
    }
  });
  fresh = await withServerEnv(dir, () => ensureServer());
  assert.equal(await exitsWithin(exited, 3000), true);
  assert.notEqual(fresh.pid, record.pid);
  assert.equal(await health(fresh.port), true);
});

test("ensureServer never stops a newer-protocol server and starts no second one", async (t) => {
  const dir = stateDir(t);
  const { exited, record } = await startServer(t, dir, { HUMAN_REVIEW_IDLE_MS: "0" });
  // The running server now looks like one of a newer Walkr version: same pid and port, newer protocol.
  const newer = { ...record, protocol: record.protocol + 1 };
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify(newer));

  const { ensureServer } = await import("../src/local-server.js");
  await assert.rejects(withServerEnv(dir, () => ensureServer()));
  assert.equal(await exitsWithin(exited, 500), false);
  assert.equal(await health(record.port), true);
  assert.deepEqual(readRecord(dir), newer);
});
