/**
 * Host-side tracking glue for the workboard of the companion window.
 * Pure and injectable: nothing here touches a TTY, the clock, Herdr or
 * the network directly. The refresher fetches through an injected function,
 * caches through injected readers/writers and reports boards and notes
 * through callbacks, so it can be proven without a terminal.
 */
import { buildWorkBoard, type WorkBoard } from "../tracking/board.mts";
import type { TrackingRepo, TrackingSnapshot } from "../tracking/gitea.mts";

/** Whichever snapshot has the later parseable `fetchedAt`; ties keep `current`; unparseable loses. */
export function newerSnapshot(
  current: TrackingSnapshot | undefined,
  next: TrackingSnapshot | undefined,
): TrackingSnapshot | undefined {
  if (!next) return current;
  if (!current) return Number.isNaN(Date.parse(next.fetchedAt)) ? undefined : next;
  const a = Date.parse(current.fetchedAt);
  const b = Date.parse(next.fetchedAt);
  if (Number.isNaN(b)) return current;
  if (Number.isNaN(a)) return next;
  return b > a ? next : current;
}

export type AgentStatus = "idle" | "working" | "blocked" | "unknown";

/** Reads Herdr `pane get` JSON (`result.pane.agent_status`); anything unrecognized is `unknown`. */
/**
 * Which repository the companion reads: the environment binding (it carries
 * the provider and is what the user configured) wins; a cached snapshot's
 * repository only fills in when the environment does not resolve.
 */
export function pickTrackingRepo(
  fromEnvironment: TrackingRepo | undefined,
  fromCache: TrackingRepo | undefined,
): TrackingRepo | undefined {
  return fromEnvironment ?? fromCache;
}

export function parseAgentStatus(stdout: string): AgentStatus {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) return "unknown";
    const result = (parsed as Record<string, unknown>).result;
    if (typeof result !== "object" || result === null) return "unknown";
    const pane = (result as Record<string, unknown>).pane;
    if (typeof pane !== "object" || pane === null) return "unknown";
    const status = (pane as Record<string, unknown>).agent_status;
    if (status === "idle" || status === "working" || status === "blocked") return status;
    // Herdr reports a finished turn as "done": the pane is free, so treat it as idle.
    if (status === "done") return "idle";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** `main @9fcbee3` (head cut to 7) plus `*` when dirty; empty ref → `@<head>`. */
export function gitHeaderLabel(snap: { ref: string; head: string; dirty: boolean }): string {
  const head = `@${snap.head.slice(0, 7)}`;
  const ref = snap.ref.length > 0 ? `${snap.ref} ${head}` : head;
  return snap.dirty ? `${ref}*` : ref;
}

/** `Pi w8:p2 idle`, or `Pi unbound` when no pane. */
export function piHeaderLabel(pane: string | undefined, status: string): string {
  if (!pane) return "Pi unbound";
  return `Pi ${pane} ${status}`;
}

/** `<n>-<YYYYMMDDTHHMMSSZ>.json`; an unparseable stamp falls back to the raw digits. */
export function requestFileName(issueNumber: number, nowIso: string): string {
  const ms = Date.parse(nowIso);
  const stamp = Number.isNaN(ms)
    ? nowIso.replace(/[^0-9TZ]/g, "").slice(0, 16)
    : new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${String(issueNumber)}-${stamp}.json`;
}

export type RefreshReason = "start" | "timer" | "manual" | "catchup";

/**
 * Catch-Me-Up port for the workboard modal. The host owns the run
 * (`runCatchUp` with real deps); the modal only asks for one and reads the
 * latest result. `run` must resolve, never reject: a failed gather is a
 * digest full of gaps, not an exception.
 */
export interface CatchUpResult {
  generatedAt: string;
  summary: string;
  markdown: string;
  file: string;
}

export interface CatchUpPort {
  run(): Promise<CatchUpResult>;
  /** The most recent digest on disk, if any (the host applies no freshness rule here). */
  latest(): CatchUpResult | undefined;
  now(): number;
}

export interface TrackingInvalidation {
  kind: "invalidated";
  reason: string;
}

export function invalidateTracking(reason: string): TrackingInvalidation {
  return { kind: "invalidated", reason };
}

function isTrackingInvalidation(value: TrackingSnapshot | TrackingInvalidation): value is TrackingInvalidation {
  return "kind" in value && value.kind === "invalidated";
}

export interface TrackingRefresherDeps {
  repo: TrackingRepo;
  fetch: (repo: TrackingRepo) => Promise<TrackingSnapshot | TrackingInvalidation>;
  readCache: () => TrackingSnapshot | undefined;
  writeCache: (snapshot: TrackingSnapshot) => void;
  onBoard: (board: WorkBoard, note: string) => void;
  onClear: (note: string) => void;
  onNote: (note: string) => void;
  now: () => number;
}

export interface TrackingRefresher {
  refresh(reason: RefreshReason): Promise<void>;
  pollCache(): void;
  /** The snapshot currently shown, if any. */
  current(): TrackingSnapshot | undefined;
}

function failureReason(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : String(error);
  return text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
}

export function createTrackingRefresher(deps: TrackingRefresherDeps): TrackingRefresher {
  let shown: TrackingSnapshot | undefined;
  let inFlight: Promise<void> | undefined;
  let disabled = false;

  const show = (snapshot: TrackingSnapshot, note: string): void => {
    shown = snapshot;
    deps.onBoard(buildWorkBoard(snapshot), note);
  };

  const run = async (): Promise<void> => {
    deps.onNote("refreshing…");
    let next: TrackingSnapshot;
    try {
      const outcome = await deps.fetch(deps.repo);
      if (isTrackingInvalidation(outcome)) {
        disabled = true;
        shown = undefined;
        deps.onClear(outcome.reason);
        return;
      }
      next = outcome;
    } catch (error) {
      const note = `offline · ${failureReason(error)}`;
      const fallback = shown ?? safeRead();
      if (fallback) show(fallback, note);
      else deps.onNote(note);
      return;
    }
    try {
      deps.writeCache(next);
    } catch { /* best effort: the board still updates */ }
    show(next, "");
  };

  const safeRead = (): TrackingSnapshot | undefined => {
    try {
      return deps.readCache();
    } catch {
      return undefined;
    }
  };

  return {
    refresh(_reason: RefreshReason): Promise<void> {
      if (disabled) return Promise.resolve();
      if (inFlight) return inFlight;
      const promise = run().finally(() => {
        if (inFlight === promise) inFlight = undefined;
      });
      inFlight = promise;
      return promise;
    },
    pollCache(): void {
      if (disabled) return;
      const cached = safeRead();
      if (!cached) return;
      const picked = newerSnapshot(shown, cached);
      if (picked === cached && picked !== shown) show(cached, "");
    },
    current(): TrackingSnapshot | undefined {
      return shown;
    },
  };
}
