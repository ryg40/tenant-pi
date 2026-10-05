/**
 * Per-project append-only prompt-log.
 *
 * "Complete history" for Promptr means: anything entered into a project
 * through `/coordinatr` (or the hosted `/promptr`) is appended to a local
 * JSONL log and, best effort, to the shared OpenKnowledge `prompt-log` page.
 * The log is append-only; editing or deleting a queue item adds entries, it
 * never rewrites earlier ones. The workspace page reflects current state; the
 * prompt-log preserves what it replaced.
 *
 * Local-first: `appendPromptLog` writes before any network. A sync cursor
 * (`prompt-log-sync.json`) records the highest sequence appended remotely, so
 * an offline session catches up after reconnect. Each remote batch carries a
 * marker `<!-- promptr:log <client> <from>-<to> -->`; before appending, the
 * syncer reads the page and skips a batch whose marker is already there
 * (an earlier write whose outcome was unknown), so a retry never duplicates.
 *
 * Pure helpers plus small injected-IO functions. No Pi imports, no process
 * env, no credentials: the client supplies a PagesClient.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { PendingQueue } from "../queue/pending.mts";
import type { PagesClient, ProjectPages } from "./project-pages.mts";

export type PromptLogKind =
  | "queue-add" | "queue-delete" | "send-attempt" | "note-revision" | "briefing-save"
  | "request-prepared" | "workspace-import" | "handoff" | "checkpoint";

export const PROMPT_LOG_KINDS: readonly PromptLogKind[] = Object.freeze([
  "queue-add", "queue-delete", "send-attempt", "note-revision", "briefing-save",
  "request-prepared", "workspace-import", "handoff", "checkpoint",
]);

export interface PromptLogEntry {
  readonly seq: number;
  readonly at: string;
  readonly client: string;
  readonly kind: PromptLogKind;
  readonly text: string;
  /** Provenance tag of a queued thought (`web`, `composer`, `note`). */
  readonly origin?: string;
  /** Queue item id for add/delete pairs. */
  readonly itemId?: string;
  /** Short free-form context (send outcome, request file), no secrets. */
  readonly meta?: Readonly<Record<string, string>>;
}

export type PromptLogInput = Omit<PromptLogEntry, "seq" | "at" | "client">;

export interface PromptLogFiles {
  readonly log: string;
  readonly cursor: string;
}

export const PROMPT_LOG_FILE = "prompt-log.jsonl";
export const PROMPT_LOG_CURSOR_FILE = "prompt-log-sync.json";
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_BATCH_ENTRIES = 40;
const MAX_BATCH_BYTES = 200 * 1024;
const MAX_READ_ENTRIES = 5000;

export function promptLogFiles(stateDir: string): PromptLogFiles {
  return { log: path.join(stateDir, PROMPT_LOG_FILE), cursor: path.join(stateDir, PROMPT_LOG_CURSOR_FILE) };
}

export interface PromptLogIo {
  readFile(file: string): string | undefined;
  appendFile(file: string, text: string): void;
  writeFile(file: string, text: string): void;
}

function boundedText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) return text;
  return `${text.slice(0, MAX_TEXT_BYTES / 2)}\n[truncated]`;
}

/** Tolerant JSONL parse: malformed lines are skipped, never fatal. */
export function parsePromptLog(text: string | undefined): PromptLogEntry[] {
  if (!text) return [];
  const out: PromptLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw.seq !== "number" || !Number.isSafeInteger(raw.seq) || raw.seq < 1) continue;
      if (typeof raw.at !== "string" || typeof raw.client !== "string" || typeof raw.text !== "string") continue;
      if (!PROMPT_LOG_KINDS.includes(raw.kind as PromptLogKind)) continue;
      const entry: PromptLogEntry = { seq: raw.seq, at: raw.at, client: raw.client, kind: raw.kind as PromptLogKind, text: raw.text };
      const extra: { origin?: string; itemId?: string; meta?: Record<string, string> } = {};
      if (typeof raw.origin === "string") extra.origin = raw.origin;
      if (typeof raw.itemId === "string") extra.itemId = raw.itemId;
      if (typeof raw.meta === "object" && raw.meta !== null) {
        const meta: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw.meta as Record<string, unknown>)) if (typeof v === "string") meta[k] = v;
        extra.meta = meta;
      }
      out.push(Object.freeze({ ...entry, ...extra }));
      if (out.length >= MAX_READ_ENTRIES) break;
    } catch { /* skip */ }
  }
  return out;
}

export function readPromptLog(files: PromptLogFiles, io: PromptLogIo): PromptLogEntry[] {
  return parsePromptLog(io.readFile(files.log));
}

function serializeEntry(entry: PromptLogEntry): string {
  const body: Record<string, unknown> = { seq: entry.seq, at: entry.at, client: entry.client, kind: entry.kind, text: entry.text };
  if (entry.origin !== undefined) body.origin = entry.origin;
  if (entry.itemId !== undefined) body.itemId = entry.itemId;
  if (entry.meta !== undefined) body.meta = entry.meta;
  return `${JSON.stringify(body)}\n`;
}

/**
 * Append entries locally with fresh sequence numbers. Returns what was
 * written. Reads the existing log only to find the last sequence; the log
 * itself is never rewritten.
 */
export function appendPromptLog(
  files: PromptLogFiles, io: PromptLogIo, client: string, nowIso: string, inputs: readonly PromptLogInput[],
): PromptLogEntry[] {
  if (inputs.length === 0) return [];
  const existing = readPromptLog(files, io);
  let seq = existing.length > 0 ? (existing[existing.length - 1] as PromptLogEntry).seq : 0;
  const written: PromptLogEntry[] = [];
  let text = "";
  for (const input of inputs) {
    seq += 1;
    const entry: PromptLogEntry = Object.freeze({ ...input, text: boundedText(input.text), seq, at: nowIso, client });
    written.push(entry);
    text += serializeEntry(entry);
  }
  io.appendFile(files.log, text);
  return written;
}

/** `queue-add` / `queue-delete` events between two queue snapshots, by item id. */
export function diffQueueEvents(prev: PendingQueue, next: PendingQueue): PromptLogInput[] {
  const before = new Map(prev.items.map((item) => [item.id, item]));
  const after = new Map(next.items.map((item) => [item.id, item]));
  const events: PromptLogInput[] = [];
  for (const [id, item] of before) {
    if (!after.has(id)) events.push({ kind: "queue-delete", text: item.text, itemId: id, ...(item.origin === undefined ? {} : { origin: item.origin }) });
  }
  for (const [id, item] of after) {
    if (!before.has(id)) events.push({ kind: "queue-add", text: item.text, itemId: id, origin: item.origin ?? "composer" });
  }
  return events;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface PromptLogCursor {
  readonly syncedThrough: number;
  readonly lastAt?: string;
  readonly lastError?: string;
}

export function readSyncCursor(files: PromptLogFiles, io: PromptLogIo): PromptLogCursor {
  const raw = io.readFile(files.cursor);
  if (!raw) return { syncedThrough: 0 };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const syncedThrough = typeof parsed.syncedThrough === "number" && Number.isSafeInteger(parsed.syncedThrough) && parsed.syncedThrough >= 0
      ? parsed.syncedThrough : 0;
    return {
      syncedThrough,
      ...(typeof parsed.lastAt === "string" ? { lastAt: parsed.lastAt } : {}),
      ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    return { syncedThrough: 0 };
  }
}

export function writeSyncCursor(files: PromptLogFiles, io: PromptLogIo, cursor: PromptLogCursor): void {
  io.writeFile(files.cursor, `${JSON.stringify({ version: 1, ...cursor }, null, 2)}\n`);
}

export function batchMarker(client: string, from: number, to: number): string {
  return `<!-- promptr:log ${client} ${String(from)}-${String(to)} -->`;
}

const MARKER_RULE = /<!-- promptr:log (\S+) (\d+)-(\d+) -->/g;

/** Highest sequence the page already carries for this client, or 0. */
export function remoteSyncedThrough(markdown: string, client: string): number {
  let highest = 0;
  for (const match of markdown.matchAll(MARKER_RULE)) {
    if (match[1] !== client) continue;
    const to = Number(match[3]);
    if (Number.isSafeInteger(to) && to > highest) highest = to;
  }
  return highest;
}

function fence(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}\n${text}${text.endsWith("\n") ? "" : "\n"}${f}`;
}

/** One Markdown block per batch: marker, then one `### <seq> <kind>` section per entry. */
export function renderPromptLogBatch(entries: readonly PromptLogEntry[], client: string): string {
  if (entries.length === 0) return "";
  const first = entries[0] as PromptLogEntry;
  const last = entries[entries.length - 1] as PromptLogEntry;
  const lines: string[] = ["", "", batchMarker(client, first.seq, last.seq), ""];
  for (const entry of entries) {
    const tags = [entry.origin === undefined ? undefined : `origin ${entry.origin}`, entry.itemId === undefined ? undefined : `item ${entry.itemId.slice(0, 12)}`]
      .filter((t): t is string => t !== undefined);
    const meta = entry.meta === undefined ? [] : Object.entries(entry.meta).map(([k, v]) => `${k} ${v.replace(/[\r\n]+/g, " ").slice(0, 120)}`);
    lines.push(`### ${String(entry.seq)} ${entry.kind} · ${entry.at} · ${entry.client}${[...tags, ...meta].length > 0 ? ` · ${[...tags, ...meta].join(" · ")}` : ""}`, "", fence(entry.text), "");
  }
  return lines.join("\n");
}

export type PromptLogSyncState = "unbound" | "synced" | "pending" | "offline";

export interface PromptLogSyncResult {
  readonly state: PromptLogSyncState;
  readonly pending: number;
  readonly syncedThrough: number;
  readonly reason?: string;
}

/**
 * Push every unsynced local entry, in bounded batches, to the shared page.
 * Reads the page first to skip batches an unknown-outcome write already
 * landed. Any failure leaves the cursor where it was and reports pending.
 */
export async function syncPromptLog(
  files: PromptLogFiles, io: PromptLogIo, client: PagesClient | undefined, pages: ProjectPages | undefined,
  clientId: string, nowIso: () => string,
): Promise<PromptLogSyncResult> {
  const entries = readPromptLog(files, io);
  let cursor = readSyncCursor(files, io);
  const pendingOf = (): PromptLogEntry[] => entries.filter((e) => e.seq > cursor.syncedThrough);
  if (!pages || !client) return { state: "unbound", pending: pendingOf().length, syncedThrough: cursor.syncedThrough, reason: pages ? "credentials not exported" : "not connected" };
  if (pendingOf().length === 0) return { state: "synced", pending: 0, syncedThrough: cursor.syncedThrough };

  let remote: string | null;
  try {
    remote = await client.readDocument(pages.promptLog);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 80) : "read failed";
    writeSyncCursor(files, io, { ...cursor, lastError: reason });
    return { state: "offline", pending: pendingOf().length, syncedThrough: cursor.syncedThrough, reason };
  }
  // Recover from an earlier write whose outcome was unknown.
  if (remote !== null) {
    const already = remoteSyncedThrough(remote, clientId);
    if (already > cursor.syncedThrough) {
      cursor = { syncedThrough: already, lastAt: nowIso() };
      writeSyncCursor(files, io, cursor);
    }
  }
  if (remote === null) {
    try {
      await client.createPage(pages.promptLog);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 80) : "create failed";
      writeSyncCursor(files, io, { ...cursor, lastError: reason });
      return { state: "offline", pending: pendingOf().length, syncedThrough: cursor.syncedThrough, reason };
    }
  }
  for (;;) {
    const pending = pendingOf();
    if (pending.length === 0) break;
    const batch: PromptLogEntry[] = [];
    let bytes = 0;
    for (const entry of pending) {
      const size = Buffer.byteLength(entry.text, "utf8") + 200;
      if (batch.length > 0 && (batch.length >= MAX_BATCH_ENTRIES || bytes + size > MAX_BATCH_BYTES)) break;
      batch.push(entry);
      bytes += size;
    }
    const markdown = renderPromptLogBatch(batch, clientId);
    try {
      await client.writeMarkdown(pages.promptLog, markdown, "append", `Promptr prompt-log ${String((batch[0] as PromptLogEntry).seq)}-${String((batch[batch.length - 1] as PromptLogEntry).seq)}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 80) : "write failed";
      writeSyncCursor(files, io, { ...cursor, lastError: reason });
      return { state: "pending", pending: pending.length, syncedThrough: cursor.syncedThrough, reason };
    }
    cursor = { syncedThrough: (batch[batch.length - 1] as PromptLogEntry).seq, lastAt: nowIso() };
    writeSyncCursor(files, io, cursor);
  }
  return { state: "synced", pending: 0, syncedThrough: cursor.syncedThrough };
}

/** Human line for headers/status: `log synced · 12` / `log pending 3` / `log offline`. */
export function promptLogStatusLabel(result: PromptLogSyncResult | undefined): string {
  if (!result || result.state === "unbound") return "log local";
  if (result.state === "synced") return `log synced ${String(result.syncedThrough)}`;
  return `log ${result.state} ${String(result.pending)}`;
}

export interface PromptLogSyncerDeps {
  readonly files: PromptLogFiles;
  readonly io: PromptLogIo;
  readonly clientId: string;
  readonly pages: () => ProjectPages | undefined;
  readonly client: () => PagesClient | undefined;
  readonly nowIso: () => string;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly onResult: (result: PromptLogSyncResult) => void;
}

export interface PromptLogSyncer {
  /** Call after a local append; coalesces into one attempt after a short quiet period. */
  observe(): void;
  /** Call on reconnect ticks; attempts only when something is pending. */
  retry(): Promise<void>;
  current(): PromptLogSyncResult | undefined;
}

const DEBOUNCE_MS = 5_000;

export function createPromptLogSyncer(deps: PromptLogSyncerDeps): PromptLogSyncer {
  let timer: unknown;
  let inFlight: Promise<void> | undefined;
  let result: PromptLogSyncResult | undefined;
  const run = async (): Promise<void> => {
    result = await syncPromptLog(deps.files, deps.io, deps.client(), deps.pages(), deps.clientId, deps.nowIso);
    deps.onResult(result);
  };
  const attempt = (): Promise<void> => {
    if (inFlight) return inFlight;
    const promise = run().catch(() => { /* reported through result */ }).finally(() => { if (inFlight === promise) inFlight = undefined; });
    inFlight = promise;
    return promise;
  };
  return {
    observe(): void {
      if (timer !== undefined) deps.clearTimer(timer);
      timer = deps.setTimer(() => { timer = undefined; void attempt(); }, DEBOUNCE_MS);
    },
    async retry(): Promise<void> {
      if (result !== undefined && result.state === "synced" && result.pending === 0) {
        // Nothing pending as far as we know; a cheap local re-check keeps it honest.
        const pending = readPromptLog(deps.files, deps.io).filter((e) => e.seq > readSyncCursor(deps.files, deps.io).syncedThrough).length;
        if (pending === 0) return;
      }
      await attempt();
    },
    current: () => result,
  };
}
