/**
 * Saved Generate Prompt request packets.
 *
 * Pure listing and loading of `<n>-<YYYYMMDDTHHMMSSZ>.json` packets written
 * by the host beside a generated `<name>.md`. The file system is injected so
 * tests never touch a disk; the Node port at the bottom never throws. Nothing
 * here writes, sends, launches or enqueues.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeLine } from "./gitea.mts";
import { buildTaskPromptDraft } from "./prompt-draft.mts";
import type { PromptDraftContext } from "./prompt-draft.mts";
import type { GeneratePromptRequest } from "./selection.mts";

export interface RequestsFS {
  /** Basenames in `dir`; a missing directory yields `[]`. */
  list(dir: string): string[];
  /** File text, or `undefined` when it cannot be read. */
  read(file: string): string | undefined;
}

export interface RequestEntry {
  readonly name: string;
  readonly file: string;
  readonly issue: number;
  readonly stamp: string;
  readonly template: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly generatedFile: string | undefined;
}

export type LoadedRequest =
  | { ok: true; entry: RequestEntry; packet: GeneratePromptRequest; generated: string | undefined }
  | { ok: false; reason: string };

export interface RequestsPort {
  list(issue: number): { entries: RequestEntry[]; skipped: number };
  load(entry: RequestEntry): LoadedRequest;
}

const PACKET_NAME = /^(\d+)-(\d{8}T\d{6}Z)\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check of a parsed packet against the packet contract for `issue`. */
function validPacket(value: unknown, issue: number): value is GeneratePromptRequest {
  if (!isRecord(value)) return false;
  if (value.kind !== "generate-prompt-request" || value.version !== 1) return false;
  if (!isRecord(value.task) || value.task.number !== issue) return false;
  if (!isRecord(value.workflow)) return false;
  if (typeof value.workflow.template !== "string" || typeof value.workflow.provider !== "string") return false;
  return typeof value.createdAt === "string";
}

function parsePacket(text: string, issue: number): GeneratePromptRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validPacket(parsed, issue) ? parsed : undefined;
}

/** Composer contract: non-empty, printable ASCII plus LF, nothing else. */
function composerSafe(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code !== 0x0a && (code < 0x20 || code > 0x7e)) return false;
  }
  return true;
}

export function listRequests(dir: string, issue: number, fs: RequestsFS): { entries: RequestEntry[]; skipped: number } {
  const names = fs.list(dir);
  const present = new Set(names);
  const entries: RequestEntry[] = [];
  let skipped = 0;
  for (const name of names) {
    const match = PACKET_NAME.exec(name);
    if (!match || Number(match[1]) !== issue) continue;
    const file = join(dir, name);
    const text = fs.read(file);
    const packet = text === undefined ? undefined : parsePacket(text, issue);
    if (!packet) {
      skipped += 1;
      continue;
    }
    const sibling = `${name.slice(0, -".json".length)}.md`;
    entries.push({
      name,
      file,
      issue,
      stamp: match[2] ?? "",
      template: packet.workflow.template,
      provider: packet.workflow.provider,
      createdAt: packet.createdAt,
      generatedFile: present.has(sibling) ? join(dir, sibling) : undefined,
    });
  }
  entries.sort((a, b) => (a.stamp === b.stamp ? (a.name < b.name ? 1 : a.name > b.name ? -1 : 0) : a.stamp < b.stamp ? 1 : -1));
  return { entries, skipped };
}

export function describeRequest(entry: RequestEntry): string {
  const generated = entry.generatedFile ? " · generated" : "";
  return sanitizeLine(`${entry.stamp} · ${entry.template} · ${entry.provider}${generated}`, 120);
}

export function loadRequest(entry: RequestEntry, fs: RequestsFS): LoadedRequest {
  const text = fs.read(entry.file);
  if (text === undefined) return { ok: false, reason: "packet unreadable" };
  const packet = parsePacket(text, entry.issue);
  if (!packet) return { ok: false, reason: "packet malformed" };
  let generated: string | undefined;
  if (entry.generatedFile !== undefined) {
    const body = fs.read(entry.generatedFile);
    generated = body !== undefined && composerSafe(body) ? body : undefined;
  }
  return { ok: true, entry, packet, generated };
}

export function draftFor(loaded: Extract<LoadedRequest, { ok: true }>, context: PromptDraftContext): string {
  return loaded.generated ?? buildTaskPromptDraft(loaded.packet, context);
}

/** Real-fs port; every failure reads as "nothing there" rather than a throw. */
export function nodeRequestsPort(dir: string): RequestsPort {
  const fs: RequestsFS = {
    list: (target) => {
      try {
        return readdirSync(target);
      } catch {
        return [];
      }
    },
    read: (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
  };
  return {
    list: (issue) => listRequests(dir, issue, fs),
    load: (entry) => loadRequest(entry, fs),
  };
}
