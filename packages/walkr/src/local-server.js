import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureStateDir, SERVER_PROTOCOL, serverPath } from "./paths.js";

// The background server of Core and Compare: one for each state directory. The commands of these two modes
// start it when no compatible server runs. Double, Coinflip and Trainer never use this: you start their server.
const here = path.dirname(fileURLToPath(import.meta.url));

export function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

/** The `/health` answer of the server on `port`, or null when none answers. */
export function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1200 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(raw) || {});
        } catch {
          resolve({});
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export async function alive(port) {
  return (await health(port)) !== null;
}

/**
 * A server of another protocol still runs for this state directory and holds its lock,
 * so a new server cannot start. Stop it when its protocol is older (a missing protocol
 * counts as older), but only when its own `/health` answer proves that it is the process
 * of the record. A newer server is never signalled: the command refuses instead.
 */
async function stopOlderServer(saved) {
  if (!saved?.port || !saved.pid || saved.protocol === SERVER_PROTOCOL) return;
  const answer = await health(saved.port);
  // No answer, or another process on the port: the record is stale and nothing here is ours to stop.
  if (answer?.pid !== saved.pid) return;
  if (Number(saved.protocol) > SERVER_PROTOCOL) {
    throw new Error(
      `A newer Walkr version runs for this state directory (pid ${saved.pid}, protocol ${saved.protocol}). Use that Walkr version, or set another HUMAN_REVIEW_STATE_DIR.`,
    );
  }
  try {
    process.kill(saved.pid, "SIGTERM");
  } catch (err) {
    // ESRCH: the server ended between the check and the signal, for example through another command.
    if (err.code === "ESRCH") return;
    throw new Error(`Could not stop the older Walkr server (pid ${saved.pid}): ${err.code || err.message}. Stop it by hand, then run the command again.`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await alive(saved.port))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The older Walkr server (pid ${saved.pid}) did not stop. Stop it by hand, then run the command again.`);
}

export async function ensureServer() {
  ensureStateDir();
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) return saved;
  if (process.env.HUMAN_REVIEW_HOSTED === "1") {
    throw new Error("The managed review server is unavailable. Check docker compose ps; do not start another server.");
  }
  await stopOlderServer(saved);

  const child = spawn(process.execPath, [path.join(here, "server-entry.js")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const record = readServerRecord();
    // Same protocol gate as above: a still-running server from an older
    // version answers /health too, and must not be adopted here.
    if (record?.protocol === SERVER_PROTOCOL && record.port && (await alive(record.port))) return record;
  }
  throw new Error("Could not start the local human-review server.");
}
