/**
 * Automatic during-work progress checkpoints.
 *
 * Goal: an abrupt cutoff should not lose the whole session's direction.
 * Capture is derived from observable state only — oldest queued goal, git
 * progress, composer next-action draft — so it needs no model call and is
 * cheap enough to leave on. Entries are append-only progress records marked
 * `[auto]`; they never rewrite the editable briefing and never send, launch,
 * commit, or retry anything.
 *
 * Local-first: every capture saves locally via the existing progress tracker.
 * Best-effort history sync is injected by callers (hosted open, companion
 * timer); failures leave a single bounded pending pointer with a visible
 * status instead of blocking local continuation. Remote writes are
 * append-only history records, never blind replacements.
 *
 * Control: per-project `autocheck.json` (`/promptr-autocheck on|off|status|
 * interval <minutes>`) plus the global `PROMPTR_AUTO_CHECKPOINTS=0` kill
 * switch. This module never touches the network or child processes; callers
 * supply snapshots and the sync function.
 */
import { appendProgress } from "./tracker.mts";
import { atomicWrite, readText } from "../state/paths.mts";

/** Default cadence: often enough to bound loss, rare enough to stay quiet. */
export const AUTOCHECK_DEFAULT_INTERVAL_MS = 15 * 60_000;
/** Clamp: below a minute is noise, not a checkpoint. */
export const AUTOCHECK_MIN_INTERVAL_MS = 60_000;
/** Keep auto entries short; the tracker truncates far above this anyway. */
export const AUTOCHECK_MAX_ENTRY_CHARS = 600;
/** Global kill switch: 0/off/false/no/disable/disabled. */
export const AUTOCHECK_ENV_KILL = "PROMPTR_AUTO_CHECKPOINTS";

/** Everything a capture decision needs; callers compute it, never this module. */
export type AutoWorkState = {
  queueCount: number;
  /** First line of the oldest pending queue item (the working goal). */
  queueHead: string;
  /** First line of the composer draft (the likely next action). */
  composerHead: string;
  /** Git head ("unknown" when unavailable); progress evidence, not a trigger alone. */
  head: string;
  dirty: boolean;
  changedCount: number;
};

export type AutoCheckRecord = {
  enabled: boolean;
  intervalMs: number;
  lastAt?: number | undefined;
  lastSignature?: string | undefined;
  /** Visible sync outcome of the last capture/settle ("synced …" or "pending …"). */
  lastSync?: string | undefined;
  /** One bounded unsynced entry text; superseded by the next capture. */
  pendingEntry?: string | undefined;
};

export function defaultAutoCheckRecord(): AutoCheckRecord {
  return { enabled: true, intervalMs: AUTOCHECK_DEFAULT_INTERVAL_MS };
}

/** Tolerant parse: corrupt settings fall back to defaults, never throw. */
export function parseAutoCheckRecord(raw: string | undefined): AutoCheckRecord {
  const base = defaultAutoCheckRecord();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const record: AutoCheckRecord = {
      enabled: typeof v.enabled === "boolean" ? v.enabled : true,
      intervalMs:
        typeof v.intervalMs === "number" && Number.isFinite(v.intervalMs) && v.intervalMs >= AUTOCHECK_MIN_INTERVAL_MS
          ? v.intervalMs : AUTOCHECK_DEFAULT_INTERVAL_MS,
    };
    if (typeof v.lastAt === "number" && Number.isFinite(v.lastAt)) record.lastAt = v.lastAt;
    if (typeof v.lastSignature === "string") record.lastSignature = v.lastSignature;
    if (typeof v.lastSync === "string") record.lastSync = v.lastSync;
    if (typeof v.pendingEntry === "string" && v.pendingEntry.length > 0) record.pendingEntry = v.pendingEntry;
    return record;
  } catch {
    return base;
  }
}

export function loadAutoRecordFile(file: string): AutoCheckRecord {
  try {
    return parseAutoCheckRecord(readText(file));
  } catch {
    return defaultAutoCheckRecord();
  }
}

export function saveAutoRecordFile(file: string, record: AutoCheckRecord): void {
  atomicWrite(file, JSON.stringify(record, null, 2) + "\n");
}

const ENV_OFF = new Set(["0", "off", "false", "no", "disable", "disabled"]);

/** Per-project switch wins unless the global kill switch is set. */
export function autoCheckEnabled(record: AutoCheckRecord, env: NodeJS.ProcessEnv = process.env): boolean {
  const kill = env[AUTOCHECK_ENV_KILL]?.trim().toLowerCase();
  if (kill !== undefined && ENV_OFF.has(kill)) return false;
  return record.enabled;
}

/** First non-blank line, truncated; empty when there is nothing to say. */
export function firstContentLine(text: string, max = 120): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Observable working state from queue/composer/git fragments. */
export function buildAutoWorkState(input: {
  queueTexts: string[]; composerText: string;
  head: string; dirty: boolean; changedCount: number;
}): AutoWorkState {
  return {
    queueCount: input.queueTexts.length,
    queueHead: firstContentLine(input.queueTexts[0] ?? ""),
    composerHead: firstContentLine(input.composerText),
    head: input.head,
    dirty: input.dirty,
    changedCount: input.changedCount,
  };
}

/** Cheap equality for "did the work change"; git fields included. */
export function workSignature(state: AutoWorkState): string {
  return JSON.stringify([state.queueCount, state.queueHead, state.composerHead, state.head, state.dirty, state.changedCount]);
}

/** Nothing queued, no draft, clean tree: nothing worth recording. */
export function hasWork(state: AutoWorkState): boolean {
  return state.queueCount > 0 || state.composerHead.length > 0 || state.dirty;
}

/**
 * Capture when there is work and the state is new: immediately for the first
 * capture (no baseline yet), afterwards only on change after the interval.
 */
export function shouldAutoCapture(record: AutoCheckRecord, state: AutoWorkState, nowMs: number = Date.now()): boolean {
  if (!hasWork(state)) return false;
  if (record.lastSignature === undefined) return true;
  if (workSignature(state) === record.lastSignature) return false;
  return nowMs - (record.lastAt ?? 0) >= record.intervalMs;
}

/** Short goal/progress/next snapshot; labeled so it never poses as authored. */
export function formatAutoEntry(state: AutoWorkState): string {
  const goal = state.queueHead.length > 0 ? state.queueHead : "(no queued goal)";
  const progress = state.head === "unknown" && !state.dirty && state.changedCount === 0
    ? "(git state unknown)"
    : `${state.head}${state.dirty ? ` (dirty, ${state.changedCount} changed)` : " (clean)"}${state.queueCount > 0 ? ` · ${state.queueCount} queued` : ""}`;
  const next = state.composerHead.length > 0 ? state.composerHead : "(no draft next action)";
  const text = `[auto] working-state snapshot\n- goal: ${goal}\n- progress: ${progress}\n- next: ${next}`;
  return text.length > AUTOCHECK_MAX_ENTRY_CHARS ? `${text.slice(0, AUTOCHECK_MAX_ENTRY_CHARS)}…` : text;
}

/** One-line overview status: switch, cadence, last capture, last sync. */
export function autoStatusLine(record: AutoCheckRecord, env: NodeJS.ProcessEnv = process.env): string {
  const every = `every ${Math.round(record.intervalMs / 60_000)}m`;
  if (!record.enabled) return `Auto-checkpoints: off (${every})`;
  // The global kill disables capture without touching the record; surface it so
  // the menu never claims "on" while nothing is being captured.
  if (!autoCheckEnabled(record, env)) return `Auto-checkpoints: off (disabled by ${AUTOCHECK_ENV_KILL})`;
  const last = record.lastAt === undefined
    ? "no capture yet"
    : `last ${new Date(record.lastAt).toISOString().slice(11, 16)}Z`;
  const sync = (record.lastSync ?? "local only").slice(0, 80);
  return `Auto-checkpoints: on · ${every} · ${last} · ${sync}`;
}

export interface AutoCaptureIo {
  readRecord(): AutoCheckRecord;
  writeRecord(next: AutoCheckRecord): void;
  appendEntry(text: string): { id: string; at: string };
  /** Best-effort history sync; resolves the visible status. May reject. */
  syncHistory?: ((text: string) => Promise<string>) | undefined;
}

function pendingReason(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown error";
  return `pending — ${detail}`;
}

/**
 * One capture decision plus a ride-along retry of a single pending sync.
 * Never throws, never sends, never launches: the only effects are a local
 * progress entry, a settings-file update, and the injected history sync.
 */
export async function maybeAutoCheckpoint(
  input: { state: AutoWorkState; nowMs?: number | undefined; env?: NodeJS.ProcessEnv | undefined },
  io: AutoCaptureIo,
): Promise<{ captured: boolean; sync: string }> {
  try {
    const now = input.nowMs ?? Date.now();
    const record = io.readRecord();
    if (!autoCheckEnabled(record, input.env)) return { captured: false, sync: record.lastSync ?? "local only" };
    if (shouldAutoCapture(record, input.state, now)) {
      const text = formatAutoEntry(input.state);
      const entry = io.appendEntry(text);
      void entry;
      let sync = "local only — no connected history target";
      let pending: string | undefined = text;
      if (io.syncHistory) {
        try {
          sync = await io.syncHistory(text);
          pending = undefined;
        } catch (error) {
          sync = pendingReason(error);
        }
      }
      io.writeRecord({
        ...record, lastAt: now, lastSignature: workSignature(input.state),
        lastSync: sync, pendingEntry: pending,
      });
      return { captured: true, sync };
    }
    if (record.pendingEntry && io.syncHistory) {
      try {
        const sync = await io.syncHistory(record.pendingEntry);
        io.writeRecord({ ...record, lastSync: sync, pendingEntry: undefined });
        return { captured: false, sync };
      } catch (error) {
        const sync = pendingReason(error);
        io.writeRecord({ ...record, lastSync: sync });
        return { captured: false, sync };
      }
    }
    return { captured: false, sync: record.lastSync ?? "local only" };
  } catch {
    return { captured: false, sync: "local only" };
  }
}
