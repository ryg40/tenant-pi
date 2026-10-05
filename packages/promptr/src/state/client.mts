/**
 * Stable per-machine client identity.
 *
 * Shared pages are written by several clients. Each batch on the prompt-log
 * and each workspace mirror names the client that wrote it, so a second
 * client can tell "mine" from "theirs" without any coordination service.
 * The id is `<hostname>-<4 hex>`, created once under the Promptr state root
 * (`client.json`) and never synced. It carries no credential.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";

export const CLIENT_FILE = "client.json";
const ID_RULE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface ClientIo {
  readFile(file: string): string | undefined;
  writeFile(file: string, text: string): void;
}

export function clientIdFile(stateRoot: string): string {
  return path.join(stateRoot, CLIENT_FILE);
}

function sanitizeHost(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return clean.length > 0 ? clean : "client";
}

export function newClientId(host: string = hostname(), random: string = randomBytes(2).toString("hex")): string {
  return `${sanitizeHost(host)}-${random.replace(/[^a-f0-9]/g, "").slice(0, 4) || "0000"}`;
}

/** Read the stored id or create it. A corrupt file is replaced; the id itself never changes afterwards. */
export function clientIdentity(stateRoot: string, io: ClientIo, create: () => string = () => newClientId()): string {
  const file = clientIdFile(stateRoot);
  const raw = io.readFile(file);
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id === "string" && ID_RULE.test(parsed.id)) return parsed.id;
    } catch { /* fall through to create */ }
  }
  const id = create();
  io.writeFile(file, `${JSON.stringify({ version: 1, id, createdAt: new Date().toISOString() }, null, 2)}\n`);
  return id;
}
