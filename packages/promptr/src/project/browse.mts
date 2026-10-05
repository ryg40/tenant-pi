/**
 * Recent-project and checkpoint browsing controller (pure).
 *
 * Explicit actions only: build rows, inspect, build an editable resume
 * draft, refresh, cancel, and guard resume. Selecting, inspecting, or
 * refreshing a row NEVER sends, queues, or launches anything — this module
 * has no import path to any send/launch code (briefing-send,
 * briefing-fresh, manual-send, extension wiring, Herdr, child processes).
 * A test enforces that import boundary with a static source scan.
 *
 * Consumes discovery and routing-index outputs read-only.
 * Resume drafts are built with the handoff builder and returned as text
 * for the EXISTING review/confirm UI; guards must pass before submission.
 */
import path from "node:path";
import { buildHandoffPrompt } from "../handoff/builder.mts";
import { describeProject, type DiscoveredProject } from "./discovery.mts";
import { describeWorkstream, type EvidenceKind, type RoutingIndex, type WorkstreamEntry } from "./workstreams.mts";

export type BrowseRow = {
  key: string;
  slug: string;
  cwd: string;
  worktreeRoot: string;
  ref: string;
  head: string;
  lastActivity: string;
  /** "active now" | "3h ago" | "5d ago" | "on 2026-08-01" | "unknown". */
  staleness: string;
  pinned: boolean;
  /** Another session is actively writing here: duplicate-writer block. */
  activeWriter: boolean;
  missing: boolean;
  workstreamId: string;
  status: string;
  statusKind: EvidenceKind;
  current?: string;
  next?: string;
  blockers: number;
  readFirst: number;
  draft: boolean;
  fingerprint: string;
};

export type BrowseModel = {
  rows: BrowseRow[];
  generatedAt: string;
  partial: boolean;
  stoppedBy: string;
};

/**
 * Caller-owned draft state threaded through browse transitions. Opaque to
 * this module: transitions return the same reference, never mutate or read
 * workspace contents. UI layers pass their live scratch/composer/queue and
 * selection handles; tests pass fakes and assert identity is preserved.
 */
export type BrowseDrafts = {
  scratch: unknown;
  composer: unknown;
  queue: unknown;
  selection: unknown;
};

export type BrowseSession = {
  model: BrowseModel;
  drafts: BrowseDrafts;
  selectedKey?: string;
};

export type RowGuard = {
  ok: boolean;
  warnings: string[];
};

export type ResumeDraft = {
  title: string;
  text: string;
  projectKey: string;
  cwd: string;
};

export type ResumeCard = {
  title: string;
  lines: string[];
  actions: ["inspect", "refresh", "copy", "explicit-start"];
};

const DAY_MS = 86_400_000;

/** Human staleness for a row. Invalid stamps stay "unknown", never recent. */
export function stalenessLabel(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = nowMs - then;
  if (diff < 0 || diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 2 * DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return `on ${iso.slice(0, 10)}`;
}

function entryFor(index: RoutingIndex, key: string): WorkstreamEntry | undefined {
  return index.entries.find((e) => e.projectKey === key);
}

/**
 * Join discovered projects with routing entries. Active writers first,
 * then most recent, missing directories trailing. Unindexed projects get
 * a marked draft row (never dropped, never invented content).
 */
export function buildBrowseModel(
  discovered: DiscoveredProject[],
  index: RoutingIndex,
  opts?: { now?: number },
): BrowseModel {
  const now = opts?.now ?? Date.now();
  const rows: BrowseRow[] = discovered.map((p) => {
    const entry = entryFor(index, p.slug);
    return {
      key: p.slug,
      slug: p.slug,
      cwd: p.cwd,
      worktreeRoot: p.worktreeRoot || p.cwd,
      ref: p.ref,
      head: p.head,
      lastActivity: p.lastActivity,
      staleness: p.activeSessionIds.length > 0 ? "active now" : stalenessLabel(p.lastActivity, now),
      pinned: p.pinned,
      activeWriter: p.activeSessionIds.length > 0,
      missing: p.isMissing,
      workstreamId: entry?.workstreamId ?? `ws-${p.slug}`,
      status: entry?.status ?? "draft — no map found",
      statusKind: entry?.statusKind ?? "inferred",
      ...(entry?.current ? { current: entry.current.text } : {}),
      ...(entry?.next ? { next: entry.next.text } : {}),
      blockers: entry?.blockers.length ?? 0,
      readFirst: entry?.readFirst.length ?? 0,
      draft: entry?.draft ?? true,
      fingerprint: entry?.fingerprint ?? `draft:${p.slug}`,
    };
  });
  const rank = (r: BrowseRow): number => (r.missing ? 2 : r.activeWriter ? 0 : 1);
  rows.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0;
  });
  return {
    rows,
    generatedAt: new Date(now).toISOString(),
    partial: index.partial,
    stoppedBy: index.stoppedBy,
  };
}

/** One-line TUI row, bounded, no control characters. Markers: * pinned, ! active writer, ? missing, ~ draft. Separators stay ASCII; row content (status, checkpoint text) may carry UTF-8. */
export function rowLabel(row: BrowseRow): string {
  const marks = `${row.pinned ? "*" : ""}${row.activeWriter ? "!" : ""}${row.missing ? "?" : ""}${row.draft ? "~" : ""}`;
  const step = row.next ? `next: ${row.next.slice(0, 60)}` : row.current ? `current: ${row.current.slice(0, 60)}` : "no checkpoints yet";
  const line = `${row.slug}${marks} - ${row.status} | ${step} | ${row.staleness}`;
  return line.replace(/[\x00-\x1F\x7F]+/g, " ").slice(0, 160);
}

/**
 * Detail lines for one row: identity, workstream summary, checkpoint
 * texts with evidence kinds, blockers, read-first links, validation
 * receipts, and coverage gaps. Read-only; inspects, never acts.
 */
export function inspectRow(model: BrowseModel, index: RoutingIndex, key: string): string[] {
  const row = model.rows.find((r) => r.key === key);
  if (!row) return [`No project row for ${key}; the model may have refreshed. Re-browse and try again.`];
  const entry = entryFor(index, key);
  const lines = [
    `${row.slug} — ${row.cwd}`,
    `git: ${row.ref || "?"} @ ${row.head}${row.missing ? " (directory missing — inspect only)" : ""}`,
    `activity: ${row.staleness} · pinned: ${row.pinned ? "yes" : "no"} · live writer: ${row.activeWriter ? "YES — duplicate start blocked" : "no"}`,
    `workstream: ${row.workstreamId} — ${row.status} [${row.statusKind}]${row.draft ? " (draft)" : ""}`,
  ];
  if (!entry) {
    lines.push("No routing entry yet — draft row from discovery only. Refresh after routing sources exist.");
    return lines;
  }
  if (entry.current) lines.push(`current [${entry.current.kind}]: ${entry.current.text.slice(0, 300)}`);
  if (entry.last) lines.push(`last [${entry.last.kind}]: ${entry.last.text.slice(0, 300)}`);
  if (entry.next) lines.push(`next [${entry.next.kind}]: ${entry.next.text.slice(0, 300)}`);
  for (const b of entry.blockers.slice(0, 5)) lines.push(`blocker [${b.kind}]: ${b.text.slice(0, 200)}`);
  for (const l of entry.readFirst.slice(0, 8)) lines.push(`read-first: ${l.label} → ${l.path}`);
  for (const v of entry.validation.slice(0, 5)) lines.push(`validated: ${v.command} @ ${v.ref || "?"} = ${v.result}`);
  for (const s of entry.sources.slice(0, 8)) lines.push(`source (${s.kind}): ${s.locator} @ ${s.revision || "?"}`);
  if (!entry.coverage.complete) {
    for (const m of entry.coverage.missing.slice(0, 5)) lines.push(`coverage gap: ${m}`);
  }
  return lines.map((l) => l.slice(0, 300));
}

/**
 * Build an editable resume draft for a row. Returns text for the EXISTING
 * review/confirm UI — it does not queue, stage, send, or launch anything.
 * The draft must still pass guardResume() with live git facts before use.
 */
export function buildResumeDraft(
  row: BrowseRow,
  entry: WorkstreamEntry | undefined,
  opts?: { focus?: string },
): ResumeDraft {
  const focus = opts?.focus?.trim()
    || entry?.next?.text
    || entry?.current?.text
    || undefined;
  const text = buildHandoffPrompt({
    slug: row.slug,
    cwd: row.cwd,
    ref: row.ref,
    head: row.head,
    dirty: false,
    changed: [],
    ...(focus ? { focus: focus.slice(0, 2000) } : {}),
    progress: [],
    queueTexts: [],
  });
  return { title: `Resume: ${row.slug}`, text, projectKey: row.key, cwd: row.cwd };
}

/**
 * Pre-submission guards. Wrong cwd, moved HEAD, missing directories, and
 * live writers all block with a visible reason; unknown git facts warn
 * without blocking on their own.
 */
export function guardResume(row: BrowseRow, live: { cwd: string; head: string }): RowGuard {
  const warnings: string[] = [];
  if (row.missing) {
    return { ok: false, warnings: [`Project directory is missing: ${row.cwd} — inspect only; nothing will launch.`] };
  }
  if (row.activeWriter) {
    return { ok: false, warnings: [`Another session is actively writing in ${row.cwd} — inspect or refresh; starting a second writer is blocked.`] };
  }
  const liveCwd = path.resolve(live.cwd);
  const here = liveCwd === path.resolve(row.cwd) || liveCwd === path.resolve(row.worktreeRoot);
  if (!here) {
    return { ok: false, warnings: [`Selected ${row.cwd} does not match this session's verified cwd ${liveCwd} — refusing to launch work elsewhere.`] };
  }
  const liveHead = live.head.trim();
  const rowHead = row.head.trim();
  if (!liveHead || liveHead === "unknown" || !rowHead || rowHead === "unknown") {
    warnings.push("Git HEAD is unknown on one side — verify `git status --short --branch` before continuing.");
    return { ok: true, warnings };
  }
  if (liveHead !== rowHead) {
    return { ok: false, warnings: [`HEAD moved since this row was built (${rowHead} → ${liveHead}) — refresh first; nothing launched.`] };
  }
  return { ok: true, warnings };
}

/**
 * Compact optional resume card for a project. TUI-only data: actions are
 * labels for the caller to wire, never auto-submit triggers. Card display
 * must offer inspect/refresh/copy/explicit-start and submit nothing.
 * Wiring TODO: surface from /promptr-status or the overview when a tracked
 * project context is active; the caller maps the four action labels to the
 * existing inspect/refresh/copy/explicit-start handlers.
 */
export function resumeCard(p: DiscoveredProject, entry: WorkstreamEntry | undefined): ResumeCard {
  const lines = [describeProject(p)];
  if (entry) {
    lines.push(describeWorkstream(entry));
    if (entry.next) lines.push(`next [${entry.next.kind}]: ${entry.next.text.slice(0, 160)}`);
    if (entry.blockers.length > 0) lines.push(`${entry.blockers.length} blocker(s) — inspect before resuming.`);
  } else {
    lines.push("No routing entry yet — draft row from discovery only.");
  }
  return {
    title: `Resume: ${p.slug}`,
    lines: lines.map((l) => l.slice(0, 300)),
    actions: ["inspect", "refresh", "copy", "explicit-start"],
  };
}

/**
 * Rebuild rows from fresh discovery+index output while keeping the
 * caller's draft handles and the selection when the project is still
 * listed. Cancel-safe: nothing is discarded on rebuild.
 */
export function refreshBrowseModel(
  fresh: { discovered: DiscoveredProject[]; index: RoutingIndex },
  prev: BrowseSession,
  opts?: { now?: number },
): BrowseSession {
  const model = buildBrowseModel(fresh.discovered, fresh.index, opts);
  const selectedKey = prev.selectedKey !== undefined && model.rows.some((r) => r.key === prev.selectedKey)
    ? prev.selectedKey
    : undefined;
  return { model, drafts: prev.drafts, ...(selectedKey === undefined ? {} : { selectedKey }) };
}

/** Cancel a browse session: state (including all draft handles) preserved, nothing acted on. */
export function cancelBrowse(session: BrowseSession): BrowseSession {
  return session;
}
