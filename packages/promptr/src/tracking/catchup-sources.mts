/**
 * Catch-Me-Up sources: every read of the tracker, git, the
 * filesystem and OpenKnowledge goes through injected deps so the whole run
 * can be proven with fakes. A failing source never fails the run: it becomes
 * one line in `digest.gaps` and the digest stays complete.
 *
 * Bounds: one timeout per network call (the ports own it); tracker <= 3 pages
 * x 50 issues and <= 200 comments; git <= 200 commits and <= 100 files;
 * <= 40 worktrees; <= 50 wave files; <= 5 OpenKnowledge page reads.
 */
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { atomicWrite, appendText } from "../state/paths.mts";
import { parseProgress } from "../progress/tracker.mts";
import type { ProjectPaths } from "../state/paths.mts";
import { parseInboxBlocks } from "../sync/inbox.mts";
import { trackerLabel } from "./config.mts";
import { parseSnapshot, sanitizeLine, snapshotOpenIssues, type TrackingRepo, type TrackingSnapshot } from "./gitea.mts";
import type { TrackingReadPorts } from "./ports.mts";
import {
  MARKDOWN_LIMIT, catchUpForPacket, catchUpSummaryLine, diffIssues, emptyDigest, isCatchUpFresh, newestFirst,
  parseCatchUpDigest, renderCatchUpMarkdown, resolveWindow,
  type CatchUpDigest, type CatchUpForPacket, type CatchUpHandoff, type CatchUpWindow, type CatchUpWorktree,
} from "./catchup.mts";

export const MAX_COMMITS = 200;
export const MAX_CHANGED_FILES = 100;
export const MAX_WORKTREES = 40;
export const MAX_WAVE_FILES = 50;
export const MAX_OK_READS = 5;
export const MAX_HANDOFFS = 50;
export const TASK_RESULT_MARKER = "Marker: SUBAGENT_COMPLETE";
export const CATCHUP_MARKER_PREFIX = "<!-- promptr:catchup";

export interface CatchUpFs {
  readText(file: string): string | undefined;
  /** Epoch ms of the last modification, or undefined when missing. */
  mtimeMs(file: string): number | undefined;
  /** Directory entries (names only), or [] when missing. */
  list(dir: string): string[];
  isDir(file: string): boolean;
  exists(file: string): boolean;
  atomicWrite(file: string, text: string): void;
  append(file: string, text: string): void;
}

export interface CatchUpOpenKnowledge {
  readDocument(docName: string): Promise<string | null>;
  writeMarkdown(docName: string, markdown: string, position: "replace" | "append", summary: string): Promise<void>;
}

export interface CatchUpDeps {
  /** `git <args>` in `cwd`; resolves to stdout or rejects. */
  exec(args: string[], cwd: string): Promise<string>;
  fs: CatchUpFs;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** Home directory root for `~/.local/share/promptr-handoffs`. */
  homedir(): string;
  /** Tracker binding and ports; absent = tracker unbound. */
  tracker?: { repo: TrackingRepo; ports: Pick<TrackingReadPorts, "fetchIssuesSince" | "fetchCommentsSince"> };
  /** Local briefing store head; absent = no brief. */
  brief?: { text: string; updated?: string; target?: { origin: string; docName: string } };
  /** Bound OpenKnowledge pages plus a client; absent = offline. */
  openKnowledge?: { client: CatchUpOpenKnowledge | undefined; pages: { brief: string; inbox: string; workspace: string; handoffs: string } };
}

export interface CatchUpCursor { lastRunAt: string; lastFile: string; summary: string }

export interface CatchUpRunOptions { cwd: string; paths: ProjectPaths; explicitSince?: string; deps: CatchUpDeps }

export interface CatchUpRunResult {
  digest: CatchUpDigest;
  markdown: string;
  /** The `.md` written under `catchupDir`. */
  file: string;
  /** Outcome of the best-effort OpenKnowledge append. */
  openKnowledge: string;
}

function reason(error: unknown): string {
  const text = error instanceof Error && error.message ? error.message : String(error);
  return sanitizeLine(text, 100);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function firstNonEmptyLine(text: string | undefined): string {
  if (!text) return "";
  for (const row of text.split(/\r?\n/)) if (row.trim().length > 0) return sanitizeLine(row, 200);
  return "";
}

function inWindow(stampMs: number | undefined, window: { sinceMs: number; untilMs: number }): boolean {
  return stampMs !== undefined && !Number.isNaN(stampMs) && stampMs >= window.sinceMs && stampMs <= window.untilMs + 60_000;
}

export function parseCatchUpCursor(raw: string | undefined): CatchUpCursor | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (typeof r.lastRunAt !== "string" || typeof r.lastFile !== "string") return undefined;
    return { lastRunAt: sanitizeLine(r.lastRunAt, 40), lastFile: r.lastFile.slice(0, 500), summary: sanitizeLine(r.summary, 200) };
  } catch {
    return undefined;
  }
}

/** `catch-up 2h ago · …` for status lines, or `catch-up: never`. */
export function catchUpCursorLine(cursor: CatchUpCursor | undefined, nowMs: number): string {
  if (!cursor) return "catch-up: never";
  const then = Date.parse(cursor.lastRunAt);
  const age = Number.isNaN(then) ? cursor.lastRunAt : ageOf(nowMs - then);
  const rest = cursor.summary.replace(/^catch-up\s+(just now|\S+\s+ago|\S+)\s*(·\s*)?/, "");
  return `catch-up: ${age}${rest ? ` · ${rest}` : ""}`;
}

function ageOf(diffMs: number): string {
  const minutes = Math.floor(Math.max(0, diffMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

export interface LoadedCatchUp { digest: CatchUpDigest; file: string; packet: CatchUpForPacket }

/** The latest digest from the cursor, or undefined when none or unreadable. */
export function loadLatestCatchUp(paths: Pick<ProjectPaths, "catchup">, readText: (file: string) => string | undefined): LoadedCatchUp | undefined {
  const cursor = parseCatchUpCursor(readText(paths.catchup));
  if (!cursor) return undefined;
  const jsonFile = cursor.lastFile.replace(/\.md$/, ".json");
  const digest = parseCatchUpDigest(readText(jsonFile));
  if (!digest) return undefined;
  return { digest, file: cursor.lastFile, packet: catchUpForPacket(digest) };
}

/** The latest digest only when younger than 24 h (packet freshness rule). */
export function loadFreshCatchUp(paths: Pick<ProjectPaths, "catchup">, readText: (file: string) => string | undefined, nowMs: number): LoadedCatchUp | undefined {
  const loaded = loadLatestCatchUp(paths, readText);
  return loaded && isCatchUpFresh(loaded.digest.generatedAt, nowMs) ? loaded : undefined;
}

// ---- sources ----

function readSnapshot(raw: string | undefined): TrackingSnapshot | undefined {
  if (!raw) return undefined;
  try {
    return parseSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

type Bounds = { sinceMs: number; untilMs: number };

async function readTracker(digest: CatchUpDigest, deps: CatchUpDeps, paths: ProjectPaths, window: CatchUpWindow): Promise<void> {
  const tracker = deps.tracker;
  if (!tracker) {
    digest.gaps.push("tracker: unbound (no repository resolved from the environment)");
    return;
  }
  digest.tracker.repoLabel = trackerLabel(tracker.repo);
  const provider = tracker.repo.provider ?? "gitea";
  const snapshot = readSnapshot(deps.fs.readText(paths.tracking));
  const previous = snapshot ? snapshotOpenIssues(snapshot) : [];
  if (!snapshot) digest.gaps.push("tracker: no cached tracking.json snapshot, so `changed` flags treat every issue as new");
  let comments: Set<number> = new Set();
  try {
    const read = await tracker.ports.fetchCommentsSince(tracker.repo, window.since);
    digest.tracker.comments = newestFirst(read.items, (c) => c.createdAt).slice(0, 200).map((c) => ({
      issue: c.issue, author: sanitizeLine(c.author, 60), createdAt: sanitizeLine(c.createdAt, 40), excerpt: sanitizeLine(c.excerpt, 200),
    }));
    comments = new Set(read.items.map((c) => c.issue));
    if (read.truncated) { digest.tracker.truncated = true; digest.gaps.push("tracker: comment read stopped at the 200-comment bound"); }
  } catch (error) {
    digest.gaps.push(`tracker (${provider}) comments: unreachable (${reason(error)})`);
  }
  try {
    const read = await tracker.ports.fetchIssuesSince(tracker.repo, window.since);
    digest.tracker.reachable = true;
    const current = read.items.map((i) => ({
      number: i.number, title: sanitizeLine(i.title, 200), state: i.state, labels: i.labels.map((l) => sanitizeLine(l, 60)),
      updatedAt: sanitizeLine(i.updatedAt ?? "", 40), url: sanitizeLine(i.url, 300),
    }));
    digest.tracker.issues = diffIssues(previous, current, comments).slice(0, 150);
    if (read.truncated) { digest.tracker.truncated = true; digest.gaps.push("tracker: issue read stopped at the 3-page bound"); }
  } catch (error) {
    digest.tracker.reachable = false;
    digest.gaps.push(`tracker (${provider}) issues: unreachable (${reason(error)})`);
  }
}

async function git(deps: CatchUpDeps, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await deps.exec(args, cwd);
  } catch {
    return undefined;
  }
}

async function readRepo(digest: CatchUpDigest, deps: CatchUpDeps, cwd: string, window: CatchUpWindow): Promise<void> {
  const head = (await git(deps, cwd, ["rev-parse", "--short=12", "HEAD"]))?.trim();
  if (head === undefined) {
    digest.gaps.push("repository: git unavailable in the project cwd");
    return;
  }
  digest.repo.head = sanitizeLine(head, 40) || "unknown";
  const ref = (await git(deps, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? "";
  digest.repo.ref = ref === "HEAD" ? "" : sanitizeLine(ref, 80);
  const status = (await git(deps, cwd, ["status", "--short"])) ?? "";
  const changed = status.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => sanitizeLine(l.slice(2).trim().split(" -> ").pop() ?? l, 200));
  digest.repo.dirty = changed.length > 0;
  digest.repo.uncommitted = changed.slice(0, MAX_CHANGED_FILES);
  if (changed.length > MAX_CHANGED_FILES) { digest.repo.truncated = true; digest.gaps.push(`repository: ${String(changed.length - MAX_CHANGED_FILES)} uncommitted paths beyond the 100-file bound`); }
  const ab = (await git(deps, cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))?.trim();
  if (ab) {
    const [ahead, behind] = ab.split(/\s+/);
    digest.repo.aheadBehind = `ahead ${sanitizeLine(ahead, 10) || "0"} · behind ${sanitizeLine(behind, 10) || "0"}`;
  }
  const log = await git(deps, cwd, ["log", `--since=${window.since}`, "--date=iso-strict", "--format=%h%x09%cI%x09%s", `-n`, String(MAX_COMMITS + 1)]);
  if (log === undefined) {
    digest.gaps.push("repository: git log failed");
    return;
  }
  const rows = log.split("\n").filter((l) => l.trim().length > 0);
  const commits = rows.slice(0, MAX_COMMITS).map((row) => {
    const [hash = "", date = "", ...subject] = row.split("\t");
    return { hash: sanitizeLine(hash, 12), date: sanitizeLine(date, 40), subject: sanitizeLine(subject.join("\t"), 200) };
  });
  digest.repo.commits = newestFirst(commits, (c) => c.date);
  if (rows.length > MAX_COMMITS) { digest.repo.truncated = true; digest.gaps.push("repository: commit list stopped at the 200-commit bound"); }
}

function laneOf(dir: string, root: string): { wave?: string; lane?: string } {
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return {};
  const [wave, lane] = rel.split(path.sep);
  return { ...(wave ? { wave: sanitizeLine(wave, 60) } : {}), ...(lane ? { lane: sanitizeLine(lane, 60) } : {}) };
}

async function readWorktrees(digest: CatchUpDigest, deps: CatchUpDeps, cwd: string, bounds: Bounds): Promise<void> {
  const candidates = new Set<string>();
  const porcelain = await git(deps, cwd, ["worktree", "list", "--porcelain"]);
  if (porcelain === undefined) digest.gaps.push("worktrees: `git worktree list` failed");
  else for (const row of porcelain.split("\n")) if (row.startsWith("worktree ")) candidates.add(path.resolve(row.slice("worktree ".length).trim()));
  const root = path.join(deps.homedir(), ".local", "share", "promptr-handoffs");
  for (const wave of deps.fs.list(root)) {
    if (wave === "install-backups") continue;
    const waveDir = path.join(root, wave);
    if (!deps.fs.isDir(waveDir)) continue;
    for (const lane of deps.fs.list(waveDir)) {
      const laneDir = path.join(waveDir, lane);
      if (deps.fs.isDir(laneDir) && deps.fs.exists(path.join(laneDir, ".git"))) candidates.add(path.resolve(laneDir));
    }
  }
  const all = [...candidates].sort();
  let scanned = 0;
  for (const dir of all) {
    if (scanned >= MAX_WORKTREES) { digest.gaps.push(`worktrees: ${String(all.length - MAX_WORKTREES)} beyond the 40-worktree bound`); break; }
    scanned += 1;
    const head = (await git(deps, dir, ["rev-parse", "--short=12", "HEAD"]))?.trim();
    if (head === undefined) { digest.gaps.push(`worktrees: ${sanitizeLine(dir, 200)} is not readable by git`); continue; }
    const branch = ((await git(deps, dir, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "").trim();
    const status = (await git(deps, dir, ["status", "--porcelain"])) ?? "";
    const dirty = status.split("\n").some((l) => l.trim().length > 0);
    const last = ((await git(deps, dir, ["log", "-1", "--date=iso-strict", "--format=%h%x09%cI%x09%s"])) ?? "").trim();
    const tree: CatchUpWorktree = { path: sanitizeLine(dir, 300), branch: branch === "HEAD" ? "" : sanitizeLine(branch, 80), head: sanitizeLine(head, 40), dirty, ...laneOf(dir, root) };
    if (last) {
      const [hash = "", date = "", ...subject] = last.split("\t");
      tree.lastCommit = { hash: sanitizeLine(hash, 12), date: sanitizeLine(date, 40), subject: sanitizeLine(subject.join("\t"), 200) };
    }
    const resultFile = path.join(dir, ".promptr", "task-result.md");
    const resultMtime = deps.fs.mtimeMs(resultFile);
    if (resultMtime !== undefined) {
      const text = deps.fs.readText(resultFile) ?? "";
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      tree.taskResult = { present: true, complete: lines[lines.length - 1] === TASK_RESULT_MARKER, firstLine: firstNonEmptyLine(text), mtime: iso(resultMtime) };
    } else {
      tree.taskResult = { present: false, complete: false, firstLine: "", mtime: "" };
    }
    const lastMs = tree.lastCommit ? Date.parse(tree.lastCommit.date) : undefined;
    const dirMtime = deps.fs.mtimeMs(dir);
    if (dirty || inWindow(lastMs, bounds) || inWindow(resultMtime, bounds) || inWindow(dirMtime, bounds)) digest.worktrees.push(tree);
  }
}

function readWaveFiles(digest: CatchUpDigest, deps: CatchUpDeps, cwd: string, bounds: Bounds): void {
  const root = path.join(cwd, ".promptr");
  const found: { path: string; mtime: string; mtimeMs: number; firstLine: string }[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const name of deps.fs.list(dir)) {
      const full = path.join(dir, name);
      if (deps.fs.isDir(full)) { walk(full, depth + 1); continue; }
      seen += 1;
      const mtime = deps.fs.mtimeMs(full);
      if (!inWindow(mtime, bounds)) continue;
      found.push({ path: sanitizeLine(path.relative(root, full), 200), mtime: iso(mtime!), mtimeMs: mtime!, firstLine: firstNonEmptyLine(deps.fs.readText(full)) });
    }
  };
  for (const name of deps.fs.list(root)) {
    const full = path.join(root, name);
    if (deps.fs.isDir(full)) walk(full, 1);
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  digest.waves = found.slice(0, MAX_WAVE_FILES).map(({ path: p, mtime, firstLine }) => ({ path: p, mtime, firstLine }));
  if (found.length > MAX_WAVE_FILES) digest.gaps.push(`wave files: ${String(found.length - MAX_WAVE_FILES)} more modified in window beyond the 50-file bound`);
  void seen;
}

function firstNumberedStep(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+How to continue/i.test(l.trim()));
  if (start < 0) return "";
  for (const row of lines.slice(start + 1)) {
    if (/^##\s/.test(row)) break;
    if (/^\s*1[.)]\s/.test(row)) return sanitizeLine(row.trim(), 300);
  }
  return "";
}

function receiptState(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).state === "string") return sanitizeLine((v as Record<string, unknown>).state, 20);
  } catch { /* unreadable receipt = no state */ }
  return undefined;
}

async function readHandoffs(digest: CatchUpDigest, deps: CatchUpDeps, cwd: string, paths: ProjectPaths, bounds: Bounds, okReads: { left: number }): Promise<void> {
  const local: (CatchUpHandoff & { ms: number })[] = [];
  for (const name of deps.fs.list(paths.handoffsDir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(paths.handoffsDir, name);
    const mtime = deps.fs.mtimeMs(file);
    if (!inWindow(mtime, bounds)) continue;
    const text = deps.fs.readText(file) ?? "";
    const base = name.slice(0, -3);
    const state = receiptState(deps.fs.readText(path.join(paths.handoffsDir, `${base}.json`)));
    local.push({ name: sanitizeLine(base, 100), mtime: iso(mtime!), ms: mtime!, title: firstNonEmptyLine(text), firstStep: firstNumberedStep(text), ...(state ? { receiptState: state } : {}) });
  }
  local.sort((a, b) => b.ms - a.ms);
  digest.handoffs.local = local.slice(0, MAX_HANDOFFS).map(({ ms, ...rest }) => { void ms; return rest; });
  if (local.length > MAX_HANDOFFS) digest.gaps.push("handoffs: local list stopped at the 50-file bound");
  const ok = deps.openKnowledge;
  if (ok?.client && okReads.left > 0) {
    okReads.left -= 1;
    try {
      const page = await ok.client.readDocument(ok.pages.handoffs);
      if (page === null) digest.gaps.push("handoffs page: not created on OpenKnowledge");
      else {
        for (const row of page.split(/\r?\n/)) {
          const marker = /^<!-- promptr:handoff (\S+) (\S+) (.+?) -->$/.exec(row.trim());
          if (marker) {
            if (inWindow(Date.parse(marker[2]!), bounds)) digest.handoffs.remoteMarkers.push({ name: sanitizeLine(marker[1], 100), at: sanitizeLine(marker[2], 40), runtime: sanitizeLine(marker[3], 80) });
            continue;
          }
          const wrap = /^##\s+Automatic 200k wrap-up\s*(\S+)?/.exec(row.trim());
          if (wrap && wrap[1] && inWindow(Date.parse(wrap[1]), bounds)) digest.handoffs.remoteMarkers.push({ name: "automatic-wrap-up", at: sanitizeLine(wrap[1], 40), runtime: "auto-wrap" });
        }
        digest.handoffs.remoteMarkers = digest.handoffs.remoteMarkers.slice(0, 50);
      }
    } catch (error) {
      digest.gaps.push(`handoffs page: unreadable (${reason(error)})`);
    }
  } else {
    digest.gaps.push("handoffs page: OpenKnowledge offline (no target or no credentials)");
  }
  const continuation = deps.fs.readText(path.join(cwd, "docs", "continuation.md"));
  if (continuation === undefined) digest.gaps.push("continuation: docs/continuation.md not found");
  else {
    const lines = continuation.split(/\r?\n/);
    const start = lines.findIndex((l) => /^##\s+Current snapshot/i.test(l.trim()));
    if (start < 0) digest.gaps.push("continuation: no `## Current snapshot` heading");
    else digest.handoffs.continuationHead = lines.slice(start + 1, start + 26).map((l) => sanitizeLine(l, 200));
  }
  const coordinator = path.join(cwd, ".promptr", "coordinator-handoff.md");
  const coordMtime = deps.fs.mtimeMs(coordinator);
  if (inWindow(coordMtime, bounds)) {
    const head = (deps.fs.readText(coordinator) ?? "").split(/\r?\n/).slice(0, 15).map((l) => sanitizeLine(l, 200));
    digest.handoffs.continuationHead.push(`-- .promptr/coordinator-handoff.md (${iso(coordMtime!)}) --`, ...head);
  }
}

async function readBriefs(digest: CatchUpDigest, deps: CatchUpDeps, okReads: { left: number }): Promise<void> {
  if (deps.brief) {
    const head = deps.brief.text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 10).map((l) => sanitizeLine(l, 200));
    digest.briefs.brief = { ...(deps.brief.updated ? { updated: sanitizeLine(deps.brief.updated, 40) } : {}), head };
  } else digest.gaps.push("brief: no local briefing text");
  const ok = deps.openKnowledge;
  if (!ok?.client) {
    digest.gaps.push("briefs: OpenKnowledge offline (no target or no credentials)");
    return;
  }
  const readPage = async (name: string, label: string): Promise<string | null | undefined> => {
    if (okReads.left <= 0) { digest.gaps.push(`${label}: skipped (OpenKnowledge read bound reached)`); return undefined; }
    okReads.left -= 1;
    try {
      return await ok.client!.readDocument(name);
    } catch (error) {
      digest.gaps.push(`${label}: unreadable (${reason(error)})`);
      return undefined;
    }
  };
  const brief = await readPage(ok.pages.brief, "brief page");
  if (typeof brief === "string" && !digest.briefs.brief) {
    digest.briefs.brief = { head: brief.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 10).map((l) => sanitizeLine(l, 200)) };
  }
  const inbox = await readPage(ok.pages.inbox, "inbox page");
  if (typeof inbox === "string") {
    const parsed = parseInboxBlocks(inbox);
    if (parsed.malformed) digest.gaps.push(`inbox page: ${sanitizeLine(parsed.malformed, 120)}`);
    digest.briefs.inboxUnqueued = parsed.blocks.filter((b) => !parsed.consumed.has(b.hash)).length;
  } else if (inbox === null) digest.gaps.push("inbox page: not created on OpenKnowledge");
  const workspace = await readPage(ok.pages.workspace, "workspace page");
  if (typeof workspace === "string") digest.briefs.workspaceHead = workspace.split(/\r?\n/).slice(0, 15).map((l) => sanitizeLine(l, 200));
  else if (workspace === null) digest.gaps.push("workspace page: not created on OpenKnowledge");
}

function readCheckpoints(digest: CatchUpDigest, deps: CatchUpDeps, paths: ProjectPaths, bounds: Bounds): void {
  const progress = parseProgress(deps.fs.readText(paths.progress));
  digest.checkpoints.progress = newestFirst(progress.entries.filter((e) => inWindow(Date.parse(e.at), bounds)), (e) => e.at).slice(0, 50);
  const log = deps.fs.readText(paths.log);
  if (log === undefined) return;
  const headings: string[] = [];
  for (const row of log.split(/\r?\n/)) {
    if (!row.startsWith("## ")) continue;
    const stamp = /(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/.exec(row);
    if (stamp && inWindow(Date.parse(stamp[1]!), bounds)) headings.push(sanitizeLine(row.slice(3), 160));
  }
  digest.checkpoints.logHeadings = headings.reverse().slice(0, 50);
  if (headings.length > 50) digest.gaps.push("log: headings stopped at the 50-heading bound");
}

// ---- run ----

export function catchUpStamp(nowMs: number): string {
  return iso(nowMs).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * One deterministic gather: reads every source through `deps`, writes the
 * digest pair and cursor atomically, appends a log heading, then tries the
 * OpenKnowledge `handoffs` append (status string, never a throw).
 */
export async function runCatchUp(options: CatchUpRunOptions): Promise<CatchUpRunResult> {
  const { cwd, paths, deps } = options;
  const nowMs = deps.now();
  const cursor = parseCatchUpCursor(deps.fs.readText(paths.catchup));
  const window = resolveWindow(cursor?.lastRunAt, iso(nowMs), options.explicitSince);
  const bounds: Bounds = { sinceMs: Date.parse(window.since), untilMs: Date.parse(window.until) };
  const digest = emptyDigest(paths.slug, cwd, iso(nowMs), window);
  const okReads = { left: MAX_OK_READS };
  const step = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); } catch (error) { digest.gaps.push(`${label}: failed (${reason(error)})`); }
  };
  await step("tracker", () => readTracker(digest, deps, paths, window));
  await step("repository", () => readRepo(digest, deps, cwd, window));
  await step("worktrees", () => readWorktrees(digest, deps, cwd, bounds));
  await step("wave files", () => readWaveFiles(digest, deps, cwd, bounds));
  await step("handoffs", () => readHandoffs(digest, deps, cwd, paths, bounds, okReads));
  await step("briefs", () => readBriefs(digest, deps, okReads));
  await step("checkpoints", () => readCheckpoints(digest, deps, paths, bounds));

  if (renderCatchUpMarkdown(digest, Number.MAX_SAFE_INTEGER).length > MARKDOWN_LIMIT) digest.gaps.push(`rendered Markdown cut at ${String(MARKDOWN_LIMIT)} chars`);
  const markdown = renderCatchUpMarkdown(digest);
  const stamp = catchUpStamp(nowMs);
  const file = path.join(paths.catchupDir, `${stamp}.md`);
  const summary = catchUpSummaryLine(digest, nowMs);
  deps.fs.atomicWrite(path.join(paths.catchupDir, `${stamp}.json`), JSON.stringify(digest, null, 2));
  deps.fs.atomicWrite(file, `${markdown}\n`);
  const next: CatchUpCursor = { lastRunAt: iso(nowMs), lastFile: file, summary };
  deps.fs.atomicWrite(paths.catchup, JSON.stringify(next, null, 2));
  try { deps.fs.append(paths.log, `\n## Catch-Me-Up ${stamp}\n${summary}\n`); } catch { /* log is best effort */ }

  let openKnowledge = "skipped: OpenKnowledge offline";
  const ok = deps.openKnowledge;
  if (ok?.client) {
    try {
      await ok.client.writeMarkdown(ok.pages.handoffs, `\n${CATCHUP_MARKER_PREFIX} ${stamp} -->\n${markdown}\n`, "append", `Catch-Me-Up ${stamp}`);
      openKnowledge = "appended";
    } catch (error) {
      openKnowledge = `pending: ${reason(error)}`;
    }
  }
  return { digest, markdown, file, openKnowledge };
}

// ---- node adapters (the only place real fs/git live; hosts pass these in) ----

/** Real filesystem behind `CatchUpFs`; every read swallows errors. */
export function nodeCatchUpFs(): CatchUpFs {
  return {
    readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return undefined; } },
    mtimeMs(file) { try { return fs.statSync(file).mtimeMs; } catch { return undefined; } },
    list(dir) { try { return fs.readdirSync(dir).filter((n) => !n.startsWith(".")).sort(); } catch { return []; } },
    isDir(file) { try { return fs.statSync(file).isDirectory(); } catch { return false; } },
    exists(file) { try { fs.statSync(file); return true; } catch { return false; } },
    atomicWrite(file, text) { atomicWrite(file, text); },
    append(file, text) { appendText(file, text); },
  };
}

/** `git <args>` with a bounded timeout; rejects on any failure. */
export function nodeGitExec(timeoutMs = 5000): CatchUpDeps["exec"] {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}
