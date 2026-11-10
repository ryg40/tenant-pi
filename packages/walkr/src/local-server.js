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

export function alive(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export async function ensureServer() {
  ensureStateDir();
  const saved = readServerRecord();
  if (saved?.protocol === SERVER_PROTOCOL && saved.port && (await alive(saved.port))) return saved;
  if (process.env.HUMAN_REVIEW_HOSTED === "1") {
    throw new Error("The managed review server is unavailable. Check docker compose ps; do not start another server.");
  }

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
