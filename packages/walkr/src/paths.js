import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

// Bump this when the CLI and detached server no longer share the same request
// contract. A new CLI must not silently reuse an older background server.
export const SERVER_PROTOCOL = 10;

export function stateDir() {
  const override = process.env.HUMAN_REVIEW_STATE_DIR;
  return override ? path.resolve(override) : path.join(homedir(), ".human-review");
}

export function serverPath() {
  return path.join(stateDir(), "server.json");
}

export function ensureStateDir() {
  // The server record with the agent token lives here; keep it private to the user.
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}
