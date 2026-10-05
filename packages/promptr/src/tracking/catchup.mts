/**
 * Catch-Me-Up digest: the bounded record of what actually
 * happened around a project (tracker, repository, worktrees, handoffs,
 * briefs, checkpoints) since the last run, rendered for the generator packet
 * and for the workboard pane.
 *
 * Pure: no fs, env, clock or network. Every string that enters a digest is
 * untrusted evidence; renderers sanitize again on the way out. Every list is
 * newest first and bounded, and every bound that cut something is named in
 * `gaps` so nothing downstream can claim it saw everything.
 */
import type { ProgressEntry } from "../progress/tracker.mts";
import { sanitizeLine, type TrackedIssue } from "./gitea.mts";

export interface CatchUpWindow { since: string; until: string; reason: "cursor" | "default" | "explicit" }

export type IssueChange = "opened" | "closed" | "labels" | "body" | "comments";

export interface CatchUpIssue {
  number: number; title: string; state: "open" | "closed"; labels: string[]; updatedAt: string; url: string; changed: IssueChange[];
}
export interface CatchUpComment { issue: number; author: string; createdAt: string; excerpt: string }
export interface CatchUpCommit { hash: string; date: string; subject: string; files?: string[] }
export interface CatchUpWorktree {
  path: string; lane?: string; wave?: string; branch: string; head: string; dirty: boolean;
  lastCommit?: { hash: string; date: string; subject: string };
  taskResult?: { present: boolean; complete: boolean; firstLine: string; mtime: string };
}
export interface CatchUpWaveFile { path: string; mtime: string; firstLine: string }
export interface CatchUpHandoff { name: string; mtime: string; title: string; firstStep: string; receiptState?: string }
export interface CatchUpHandoffMarker { name: string; at: string; runtime: string }

export interface CatchUpDigest {
  version: 1; kind: "promptr-catchup"; slug: string; cwd: string; generatedAt: string; window: CatchUpWindow;
  tracker: { repoLabel: string; reachable: boolean; issues: CatchUpIssue[]; comments: CatchUpComment[]; truncated: boolean };
  repo: { ref: string; head: string; dirty: boolean; aheadBehind?: string; commits: CatchUpCommit[]; uncommitted: string[]; truncated: boolean };
  worktrees: CatchUpWorktree[];
  waves: CatchUpWaveFile[];
  handoffs: { local: CatchUpHandoff[]; remoteMarkers: CatchUpHandoffMarker[]; continuationHead: string[] };
  briefs: { brief?: { updated?: string; head: string[] }; inboxUnqueued: number; workspaceHead: string[] };
  checkpoints: { progress: ProgressEntry[]; logHeadings: string[] };
  gaps: string[];
}

export const DEFAULT_WINDOW_MS = 72 * 60 * 60 * 1000;
export const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const MARKDOWN_LIMIT = 24_000;
export const PACKET_MARKDOWN_LIMIT = 16_000;
/** A digest older than this is not attached to a generator packet. */
export const CATCHUP_FRESH_MS = 24 * 60 * 60 * 1000;
const TRUNCATED = "[truncated]";

const UNIT_MS: Record<string, number> = { h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/** `48h`, `7d` or an ISO stamp → epoch ms, or undefined when unparseable. */
export function parseSince(text: string | undefined, nowMs: number): number | undefined {
  const raw = (text ?? "").trim();
  if (raw.length === 0) return undefined;
  const rel = /^(\d{1,4})([hd])$/i.exec(raw);
  if (rel) return nowMs - Number(rel[1]) * (UNIT_MS[rel[2]!.toLowerCase()] ?? 0);
  const abs = Date.parse(raw);
  return Number.isNaN(abs) ? undefined : abs;
}

/**
 * Window for one run. Explicit beats cursor beats the 72 h default; every
 * choice is capped at 14 d back and never reaches past `now`.
 */
export function resolveWindow(cursor: string | undefined, now: string, explicitSince?: string): CatchUpWindow {
  const nowMs = Date.parse(now);
  const until = Number.isNaN(nowMs) ? now : new Date(nowMs).toISOString();
  const base = Number.isNaN(nowMs) ? 0 : nowMs;
  const clamp = (ms: number): number => Math.min(base, Math.max(base - MAX_WINDOW_MS, ms));
  const explicit = parseSince(explicitSince, base);
  if (explicit !== undefined) return { since: new Date(clamp(explicit)).toISOString(), until, reason: "explicit" };
  const cursorMs = cursor === undefined ? Number.NaN : Date.parse(cursor);
  if (!Number.isNaN(cursorMs)) return { since: new Date(clamp(cursorMs)).toISOString(), until, reason: "cursor" };
  return { since: new Date(clamp(base - DEFAULT_WINDOW_MS)).toISOString(), until, reason: "default" };
}

export function emptyDigest(slug: string, cwd: string, generatedAt: string, window: CatchUpWindow): CatchUpDigest {
  return {
    version: 1, kind: "promptr-catchup", slug, cwd, generatedAt, window,
    tracker: { repoLabel: "", reachable: false, issues: [], comments: [], truncated: false },
    repo: { ref: "", head: "unknown", dirty: false, commits: [], uncommitted: [], truncated: false },
    worktrees: [], waves: [],
    handoffs: { local: [], remoteMarkers: [], continuationHead: [] },
    briefs: { inboxUnqueued: 0, workspaceHead: [] },
    checkpoints: { progress: [], logHeadings: [] },
    gaps: [],
  };
}

/** Sort key: newest first by an ISO stamp; unparseable stamps sink. */
export function newestFirst<T>(items: readonly T[], stampOf: (item: T) => string): T[] {
  const ms = (item: T): number => {
    const v = Date.parse(stampOf(item));
    return Number.isNaN(v) ? Number.NEGATIVE_INFINITY : v;
  };
  return [...items].sort((a, b) => ms(b) - ms(a));
}

function line(text: unknown, max = 200): string {
  return sanitizeLine(text, max);
}

function stamp(iso: string): string {
  return line(iso, 40) || "(unknown)";
}

/** `2h ago`, `3d ago`, `just now`; unparseable stamps are shown as given. */
export function ageLabel(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return line(iso, 40) || "unknown";
  const diff = Math.max(0, nowMs - then);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** `catch-up 2h ago · 4 issues · 2 worktrees · 1 handoff` (stamp instead of age without `nowMs`). */
export function catchUpSummaryLine(digest: CatchUpDigest, nowMs?: number): string {
  const when = nowMs === undefined ? stamp(digest.generatedAt).slice(0, 16) : ageLabel(digest.generatedAt, nowMs);
  const handoffs = digest.handoffs.local.length + digest.handoffs.remoteMarkers.length;
  return `catch-up ${when} · ${plural(digest.tracker.issues.length, "issue")} · ${plural(digest.worktrees.length, "worktree")} · ${plural(handoffs, "handoff")}`;
}

function section(title: string, body: string[]): string[] {
  return [`## ${title}`, "", ...(body.length > 0 ? body : ["- (nothing in window)"]), ""];
}

function sectionsOf(digest: CatchUpDigest): string[][] {
  const w = digest.window;
  const sources = [
    `- Window: ${stamp(w.since)} → ${stamp(w.until)} (${w.reason})`,
    `- Project: ${line(digest.slug, 80)} at ${line(digest.cwd, 300)}`,
    `- Tracker: ${line(digest.tracker.repoLabel, 80) || "(unbound)"} · ${digest.tracker.reachable ? "reachable" : "unreachable"}`,
    `- Sources: tracker, repository, worktrees, wave files, handoffs, briefs, checkpoints · ${plural(digest.gaps.length, "gap")}`,
  ];
  const tracker: string[] = [];
  for (const issue of newestFirst(digest.tracker.issues, (i) => i.updatedAt)) {
    const changed = issue.changed.length > 0 ? issue.changed.join(",") : "updated";
    tracker.push(`- #${String(issue.number)} ${issue.state} [${changed}] ${line(issue.title, 120)} · ${stamp(issue.updatedAt)}${issue.labels.length > 0 ? ` · ${issue.labels.map((l) => line(l, 40)).join(", ")}` : ""}`);
  }
  for (const comment of newestFirst(digest.tracker.comments, (c) => c.createdAt)) {
    tracker.push(`- comment on #${String(comment.issue)} by ${line(comment.author, 40) || "?"} · ${stamp(comment.createdAt)}: ${line(comment.excerpt, 200)}`);
  }
  if (digest.tracker.truncated) tracker.push("- (tracker lists truncated)");
  const repo: string[] = [
    `- Checkout: ${line(digest.repo.ref, 80) || "(detached)"} @ ${line(digest.repo.head, 40)}${digest.repo.dirty ? " (dirty)" : " (clean)"}${digest.repo.aheadBehind ? ` · ${line(digest.repo.aheadBehind, 40)}` : ""}`,
  ];
  for (const commit of newestFirst(digest.repo.commits, (c) => c.date)) {
    repo.push(`- ${line(commit.hash, 12)} ${stamp(commit.date)} ${line(commit.subject, 120)}${commit.files && commit.files.length > 0 ? ` · ${commit.files.map((f) => line(f, 100)).join(", ")}` : ""}`);
  }
  if (digest.repo.uncommitted.length > 0) repo.push(`- Uncommitted: ${digest.repo.uncommitted.map((f) => line(f, 100)).join(", ")}`);
  if (digest.repo.truncated) repo.push("- (commit list truncated)");
  const worktrees: string[] = [];
  const wtStamp = (t: CatchUpWorktree): string => t.taskResult?.mtime ?? t.lastCommit?.date ?? "";
  for (const tree of newestFirst(digest.worktrees, wtStamp)) {
    const lane = tree.wave || tree.lane ? ` (${[tree.wave, tree.lane].filter(Boolean).map((v) => line(v, 60)).join("/")})` : "";
    const last = tree.lastCommit ? ` · last ${line(tree.lastCommit.hash, 12)} ${stamp(tree.lastCommit.date)} ${line(tree.lastCommit.subject, 100)}` : "";
    const result = tree.taskResult
      ? tree.taskResult.present
        ? ` · task-result ${tree.taskResult.complete ? "COMPLETE" : "incomplete"} ${stamp(tree.taskResult.mtime)}: ${line(tree.taskResult.firstLine, 120)}`
        : " · no task-result"
      : "";
    worktrees.push(`- ${line(tree.path, 300)}${lane} · ${line(tree.branch, 80) || "(detached)"} @ ${line(tree.head, 40)}${tree.dirty ? " (dirty)" : ""}${last}${result}`);
  }
  for (const file of newestFirst(digest.waves, (f) => f.mtime)) {
    worktrees.push(`- wave file ${line(file.path, 200)} · ${stamp(file.mtime)}: ${line(file.firstLine, 120)}`);
  }
  const handoffs: string[] = [];
  for (const h of newestFirst(digest.handoffs.local, (x) => x.mtime)) {
    handoffs.push(`- ${line(h.name, 100)} · ${stamp(h.mtime)}${h.receiptState ? ` · ${line(h.receiptState, 20)}` : ""}: ${line(h.title, 120)}${h.firstStep ? ` · next: ${line(h.firstStep, 160)}` : ""}`);
  }
  for (const m of newestFirst(digest.handoffs.remoteMarkers, (x) => x.at)) {
    handoffs.push(`- remote ${line(m.name, 100)} · ${stamp(m.at)} · ${line(m.runtime, 80)}`);
  }
  if (digest.handoffs.continuationHead.length > 0) {
    handoffs.push("- Continuation snapshot:");
    for (const row of digest.handoffs.continuationHead) handoffs.push(`  ${line(row, 200)}`);
  }
  const briefs: string[] = [];
  if (digest.briefs.brief) {
    briefs.push(`- Brief updated ${digest.briefs.brief.updated ? stamp(digest.briefs.brief.updated) : "(unknown)"}:`);
    for (const row of digest.briefs.brief.head) briefs.push(`  ${line(row, 200)}`);
  }
  briefs.push(`- Inbox: ${plural(digest.briefs.inboxUnqueued, "unqueued block")}`);
  if (digest.briefs.workspaceHead.length > 0) {
    briefs.push("- Workspace head:");
    for (const row of digest.briefs.workspaceHead) briefs.push(`  ${line(row, 200)}`);
  }
  const checkpoints: string[] = [];
  for (const entry of newestFirst(digest.checkpoints.progress, (e) => e.at)) {
    checkpoints.push(`- ${stamp(entry.at)} ${line(entry.id, 12)} @ ${line(entry.head, 40)}: ${line(entry.text.split("\n")[0] ?? "", 160)}`);
  }
  for (const heading of digest.checkpoints.logHeadings) checkpoints.push(`- log: ${line(heading, 160)}`);
  const gaps = digest.gaps.map((g) => `- ${line(g, 300)}`);
  return [
    section("Window and sources", sources),
    section("Tracker activity", tracker),
    section("Repository", repo),
    section("Worktrees and workers", worktrees),
    section("Handoffs and continuation", handoffs),
    section("Briefs, inbox and workspace", briefs),
    section("Checkpoints and log", checkpoints),
    section("Gaps and staleness", gaps),
  ];
}

/**
 * Fixed heading order; at most `limit` characters. When the body must be cut
 * the Gaps section survives intact, carries a line naming the cut, and the
 * cut section ends with `[truncated]`.
 */
export function renderCatchUpMarkdown(digest: CatchUpDigest, limit = MARKDOWN_LIMIT): string {
  const title = `# Catch-Me-Up — ${line(digest.slug, 80)} — ${stamp(digest.generatedAt)}`;
  const parts = sectionsOf(digest);
  const full = [title, "", ...parts.flat()].join("\n");
  if (full.length <= limit) return full;
  const gapsPart = parts[parts.length - 1]!;
  const cutNote = `- rendered Markdown cut at ${String(limit)} chars`;
  const gapsText = [...gapsPart.slice(0, -1), cutNote, ""].join("\n");
  const tail = `\n${TRUNCATED}\n${gapsText}`;
  const bodyBudget = Math.max(0, limit - tail.length);
  const body = [title, "", ...parts.slice(0, -1).flat()].join("\n").slice(0, bodyBudget);
  return `${body}${tail}`;
}

export interface CatchUpForPacket {
  generatedAt: string; since: string; summary: string; markdown: string;
  counts: { issues: number; comments: number; commits: number; worktrees: number; handoffs: number; gaps: number };
}

/** The bounded copy that enters a generator packet. */
export function catchUpForPacket(digest: CatchUpDigest): CatchUpForPacket {
  return {
    generatedAt: digest.generatedAt,
    since: digest.window.since,
    summary: catchUpSummaryLine(digest),
    markdown: renderCatchUpMarkdown(digest, PACKET_MARKDOWN_LIMIT),
    counts: {
      issues: digest.tracker.issues.length,
      comments: digest.tracker.comments.length,
      commits: digest.repo.commits.length,
      worktrees: digest.worktrees.length,
      handoffs: digest.handoffs.local.length + digest.handoffs.remoteMarkers.length,
      gaps: digest.gaps.length,
    },
  };
}

/** True when `generatedAt` is within the freshness window of `nowMs`. */
export function isCatchUpFresh(generatedAt: string, nowMs: number, freshMs = CATCHUP_FRESH_MS): boolean {
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return false;
  const age = nowMs - then;
  return age >= 0 && age <= freshMs;
}

// ---- parsing (never throws) ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4000): string => (typeof v === "string" ? sanitizeLine(v, max) : "");
const strs = (v: unknown, max = 200, count = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, count).map((x) => sanitizeLine(x, max)) : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const CHANGES: readonly IssueChange[] = ["opened", "closed", "labels", "body", "comments"];

function objs(v: unknown, count: number): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObj).slice(0, count) : [];
}

/** Parse a digest file; anything malformed yields undefined, never a throw. */
export function parseCatchUpDigest(raw: unknown): CatchUpDigest | undefined {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return undefined; }
  }
  if (!isObj(v) || v.version !== 1 || v.kind !== "promptr-catchup") return undefined;
  const w = isObj(v.window) ? v.window : {};
  const reason = w.reason === "cursor" || w.reason === "explicit" ? w.reason : "default";
  const digest = emptyDigest(str(v.slug, 80), str(v.cwd, 300), str(v.generatedAt, 40), { since: str(w.since, 40), until: str(w.until, 40), reason });
  const tr = isObj(v.tracker) ? v.tracker : {};
  digest.tracker.repoLabel = str(tr.repoLabel, 80);
  digest.tracker.reachable = tr.reachable === true;
  digest.tracker.truncated = tr.truncated === true;
  digest.tracker.issues = objs(tr.issues, 150).map((i) => ({
    number: num(i.number), title: str(i.title, 200), state: i.state === "closed" ? "closed" : "open",
    labels: strs(i.labels, 60, 30), updatedAt: str(i.updatedAt, 40), url: str(i.url, 300),
    changed: Array.isArray(i.changed) ? i.changed.filter((c): c is IssueChange => CHANGES.includes(c as IssueChange)) : [],
  }));
  digest.tracker.comments = objs(tr.comments, 200).map((c) => ({ issue: num(c.issue), author: str(c.author, 60), createdAt: str(c.createdAt, 40), excerpt: str(c.excerpt, 200) }));
  const rp = isObj(v.repo) ? v.repo : {};
  digest.repo.ref = str(rp.ref, 80);
  digest.repo.head = str(rp.head, 40) || "unknown";
  digest.repo.dirty = rp.dirty === true;
  if (typeof rp.aheadBehind === "string") digest.repo.aheadBehind = str(rp.aheadBehind, 40);
  digest.repo.truncated = rp.truncated === true;
  digest.repo.uncommitted = strs(rp.uncommitted, 200, 100);
  digest.repo.commits = objs(rp.commits, 200).map((c) => ({
    hash: str(c.hash, 12), date: str(c.date, 40), subject: str(c.subject, 200),
    ...(Array.isArray(c.files) ? { files: strs(c.files, 200, 100) } : {}),
  }));
  digest.worktrees = objs(v.worktrees, 40).map((t) => {
    const out: CatchUpWorktree = { path: str(t.path, 300), branch: str(t.branch, 80), head: str(t.head, 40), dirty: t.dirty === true };
    if (typeof t.lane === "string") out.lane = str(t.lane, 60);
    if (typeof t.wave === "string") out.wave = str(t.wave, 60);
    if (isObj(t.lastCommit)) out.lastCommit = { hash: str(t.lastCommit.hash, 12), date: str(t.lastCommit.date, 40), subject: str(t.lastCommit.subject, 200) };
    if (isObj(t.taskResult)) out.taskResult = { present: t.taskResult.present === true, complete: t.taskResult.complete === true, firstLine: str(t.taskResult.firstLine, 200), mtime: str(t.taskResult.mtime, 40) };
    return out;
  });
  digest.waves = objs(v.waves, 50).map((f) => ({ path: str(f.path, 200), mtime: str(f.mtime, 40), firstLine: str(f.firstLine, 200) }));
  const ho = isObj(v.handoffs) ? v.handoffs : {};
  digest.handoffs.local = objs(ho.local, 50).map((h) => ({
    name: str(h.name, 100), mtime: str(h.mtime, 40), title: str(h.title, 200), firstStep: str(h.firstStep, 300),
    ...(typeof h.receiptState === "string" ? { receiptState: str(h.receiptState, 20) } : {}),
  }));
  digest.handoffs.remoteMarkers = objs(ho.remoteMarkers, 50).map((m) => ({ name: str(m.name, 100), at: str(m.at, 40), runtime: str(m.runtime, 80) }));
  digest.handoffs.continuationHead = strs(ho.continuationHead, 200, 25);
  const br = isObj(v.briefs) ? v.briefs : {};
  if (isObj(br.brief)) digest.briefs.brief = { ...(typeof br.brief.updated === "string" ? { updated: str(br.brief.updated, 40) } : {}), head: strs(br.brief.head, 200, 10) };
  digest.briefs.inboxUnqueued = num(br.inboxUnqueued);
  digest.briefs.workspaceHead = strs(br.workspaceHead, 200, 15);
  const cp = isObj(v.checkpoints) ? v.checkpoints : {};
  digest.checkpoints.progress = objs(cp.progress, 50).map((e) => ({
    id: str(e.id, 12), at: str(e.at, 40), text: typeof e.text === "string" ? e.text.slice(0, 4000) : "", cwd: str(e.cwd, 300),
    head: str(e.head, 40) || "unknown", ref: str(e.ref, 80), dirty: e.dirty === true, changed: strs(e.changed, 200, 50),
  }));
  digest.checkpoints.logHeadings = strs(cp.logHeadings, 200, 50);
  digest.gaps = strs(v.gaps, 300, 100);
  return digest;
}

// ---- diffing ----

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * `changed` flags for issues read since the window start, against the issues
 * the cached tracking snapshot knew. `commented` lists issue numbers that
 * received comments in the window.
 */
export function diffIssues(
  previous: readonly TrackedIssue[],
  current: readonly Omit<CatchUpIssue, "changed">[],
  commented: ReadonlySet<number> = new Set(),
): CatchUpIssue[] {
  const known = new Map(previous.map((p) => [p.number, p]));
  return current.map((issue) => {
    const before = known.get(issue.number);
    const changed: IssueChange[] = [];
    if (!before) {
      if (issue.state === "open") changed.push("opened");
      else changed.push("closed");
    } else {
      if (before.state === "open" && issue.state === "closed") changed.push("closed");
      if (before.state === "closed" && issue.state === "open") changed.push("opened");
      if (!sameLabels(before.labels, issue.labels)) changed.push("labels");
      if (changed.length === 0 && (before.updatedAt ?? "") !== issue.updatedAt) changed.push("body");
    }
    if (commented.has(issue.number)) changed.push("comments");
    return { ...issue, changed };
  });
}

/** Evidence bullets of a rendered digest, for the deterministic draft (`- ` rows, placeholders skipped). */
export function catchUpDraftLines(markdown: string, limit = 20): string[] {
  const out: string[] = [];
  for (const row of markdown.split("\n")) {
    if (!row.startsWith("- ") || row.startsWith("- (nothing")) continue;
    out.push(row.slice(2));
    if (out.length >= limit) break;
  }
  return out;
}
