/**
 * Discover recently active ~/git projects from Pi sessions.
 *
 * Goal: a bounded, accurate set of local projects the user actually worked
 * on recently, from genuine conversation activity (message timestamps, not
 * directory mtime). Session cwd resolves to canonical Git repository /
 * worktree identity; aliases merge without collapsing distinct worktrees.
 *
 * Pure helpers + injected filesystem/git adapters. No Pi, Herdr, network,
 * child-process, or editor imports here — the default node adapter lives at
 * the bottom and callers may inject fakes. Scanning is synchronous,
 * read-only, and bounded: byte/file/project/wall-clock budgets plus an
 * optional cancellation predicate. Early stops report `partial: true` with
 * the stopping reason and a resume cursor (last fully processed file).
 *
 * Session schema (Pi JSONL, version-aware): first line
 * `{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}`,
 * then event lines each carrying an ISO `"timestamp"`. Only header and
 * timestamp fields are read — never message content, thinking, or tool
 * output. Truncated files yield whatever complete timestamps survive.
 *
 * Refresh policy belongs to callers (app open, manual refresh, session
 * settle). This module never schedules, launches agents, or writes.
 */
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { projectSlug } from "../state/paths.mts";

/** Default recency window: two weeks of genuine activity. */
export const DISCOVERY_DEFAULT_RECENT_DAYS = 14;
export const DISCOVERY_MIN_RECENT_DAYS = 1;
export const DISCOVERY_MAX_RECENT_DAYS = 90;
/** Bytes of head/tail read per session file (header + latest timestamps). */
export const DISCOVERY_HEAD_BYTES = 4096;
export const DISCOVERY_TAIL_BYTES = 8192;

export type DiscoveryBudgets = {
  /** Cap on distinct projects returned. */
  maxProjects: number;
  /** Cap on session files opened. */
  maxSessionFiles: number;
  /** Cap on total bytes read across files. */
  maxTotalBytes: number;
  /** Cap on bytes read per session file (head + tail). */
  maxBytesPerSession: number;
  /** Wall-clock budget for one scan. */
  wallClockMs: number;
};

export const DISCOVERY_DEFAULT_BUDGETS: DiscoveryBudgets = {
  maxProjects: 50,
  maxSessionFiles: 500,
  maxTotalBytes: 20 * 1024 * 1024,
  maxBytesPerSession: 2 * 1024 * 1024,
  wallClockMs: 5000,
};

export type DiscoveryConfig = {
  /** Roots containing `*.jsonl` session files (one level of subdirs). */
  sessionRoots: string[];
  /** Approved project roots; default `~/git`. */
  projectRoots: string[];
  /** Recency window in days, clamped to 1..90. */
  recentDays: number;
  /** Canonical path prefixes always included (still bounded by budgets). */
  pinned: string[];
  /** Canonical path prefixes never included; win over pins. */
  excluded: string[];
  /** Include session cwds outside projectRoots (default false). */
  includeOutsideRoots: boolean;
  /** Session ids considered live writers (caller-supplied, e.g. current). */
  activeSessionIds: string[];
  budgets: DiscoveryBudgets;
};

export function defaultSessionRoots(): string[] {
  return [path.join(homedir(), ".pi", "agent", "sessions")];
}

export function defaultProjectRoots(): string[] {
  return [path.join(homedir(), "git")];
}

export function defaultDiscoveryConfig(overrides?: {
  sessionRoots?: string[];
  projectRoots?: string[];
  recentDays?: number;
  pinned?: string[];
  excluded?: string[];
  includeOutsideRoots?: boolean;
  activeSessionIds?: string[];
  budgets?: Partial<DiscoveryBudgets>;
}): DiscoveryConfig {
  const recentRaw = overrides?.recentDays ?? DISCOVERY_DEFAULT_RECENT_DAYS;
  const recentDays = Math.max(
    DISCOVERY_MIN_RECENT_DAYS,
    Math.min(DISCOVERY_MAX_RECENT_DAYS, Math.floor(recentRaw) || DISCOVERY_DEFAULT_RECENT_DAYS),
  );
  return {
    sessionRoots: overrides?.sessionRoots ?? defaultSessionRoots(),
    projectRoots: overrides?.projectRoots ?? defaultProjectRoots(),
    recentDays,
    pinned: overrides?.pinned ?? [],
    excluded: overrides?.excluded ?? [],
    includeOutsideRoots: overrides?.includeOutsideRoots ?? false,
    activeSessionIds: overrides?.activeSessionIds ?? [],
    budgets: { ...DISCOVERY_DEFAULT_BUDGETS, ...(overrides?.budgets ?? {}) },
  };
}

export type ActivitySource = "messages" | "header";

export type SessionActivity = {
  id: string;
  cwd: string;
  lastActivity: string;
  source: ActivitySource;
  /** Session-file path (evidence locator, not content). */
  file: string;
};

export type GitIdentity = {
  /** Resolved `--git-common-dir` (shared repo identity across worktrees). */
  commonGitDir: string;
  /** Resolved `--git-dir` (per-worktree git metadata). */
  gitDir: string;
  /** Resolved `--show-toplevel` (this worktree's root). */
  worktreeRoot: string;
  /** Branch name, "" when detached or unborn. */
  ref: string;
  /** Short HEAD, "unknown" when unavailable. */
  head: string;
  detached: boolean;
};

export type DiscoveredProject = {
  slug: string;
  /** Canonical project/worktree root (or lexical cwd when missing). */
  cwd: string;
  commonGitDir: string;
  worktreeRoot: string;
  gitDir: string;
  ref: string;
  head: string;
  isWorktree: boolean;
  isDetached: boolean;
  /** Declared cwd no longer exists on disk. */
  isMissing: boolean;
  lastActivity: string;
  lastActivitySource: ActivitySource;
  sessionCount: number;
  sessionIds: string[];
  activeSessionIds: string[];
  /** Distinct observed session cwds, bounded (nested/symlinked aliases). */
  observedCwds: string[];
  pinned: boolean;
  /** Human reason: "active writer", "missing directory", "detached HEAD", ... */
  note: string;
};

export type DiscoveryResult = {
  /** Active first, then most recent; missing directories trail. */
  projects: DiscoveredProject[];
  scannedFiles: number;
  scannedBytes: number;
  skippedStale: number;
  skippedEphemeral: number;
  skippedOutsideRoots: number;
  skippedExcluded: number;
  skippedNonRepo: number;
  skippedUnreadable: number;
  partial: boolean;
  stoppedBy: string;
  /** Last fully processed file; resume scanning after it. */
  cursor: string;
  elapsedMs: number;
};

/** Injected read-only adapters; fakes make every edge testable. */
export interface DiscoveryFS {
  listSessionFiles(root: string): string[];
  readHead(file: string, maxBytes: number): string | undefined;
  readTail(file: string, maxBytes: number): string | undefined;
  /** Canonical path, following symlinks; undefined when missing/unresolvable. */
  realpath(p: string): string | undefined;
  isDirectory(p: string): boolean;
  /** Canonical Git identity; undefined when missing or not a checkout. */
  gitIdentity(cwd: string): GitIdentity | undefined;
}

export type DiscoverOptions = {
  nowMs?: () => number;
  isCancelled?: () => boolean;
};

/** Parse a session header line; undefined for blank/non-session/garbage. */
export function parseSessionHeader(firstLine: string): { id: string; timestamp: string; cwd: string } | undefined {
  const line = firstLine.split("\n", 1)[0]?.trim() ?? "";
  if (!line.startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (r.type !== "session") return undefined;
    if (typeof r.id !== "string" || r.id.length === 0) return undefined;
    if (typeof r.timestamp !== "string" || Number.isNaN(Date.parse(r.timestamp))) return undefined;
    if (typeof r.cwd !== "string" || r.cwd.length === 0) return undefined;
    return { id: r.id, timestamp: r.timestamp, cwd: r.cwd };
  } catch {
    return undefined;
  }
}

const TIMESTAMP_RE = /"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g;

/** Latest ISO timestamp found in a text chunk; undefined when none. */
export function maxChunkTimestamp(chunk: string): string | undefined {
  let best = 0;
  let bestRaw: string | undefined;
  TIMESTAMP_RE.lastIndex = 0;
  for (;;) {
    const m = TIMESTAMP_RE.exec(chunk);
    if (m === null) break;
    const raw = m[1] ?? "";
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t > best) {
      best = t;
      bestRaw = raw;
    }
  }
  return bestRaw;
}

/**
 * Latest message-activity timestamp in a chunk: the max timestamp strictly
 * after the session header's own. The header line itself (and any clock-skewed
 * earlier stamp) can never count as message activity; equal-or-earlier stamps
 * fall back to the header source.
 */
export function latestMessageTimestamp(chunk: string, headerIso: string): string | undefined {
  const floor = Date.parse(headerIso);
  if (Number.isNaN(floor)) return maxChunkTimestamp(chunk);
  let best = floor;
  let bestRaw: string | undefined;
  TIMESTAMP_RE.lastIndex = 0;
  for (;;) {
    const m = TIMESTAMP_RE.exec(chunk);
    if (m === null) break;
    const raw = m[1] ?? "";
    const t = Date.parse(raw);
    if (!Number.isNaN(t) && t > best) {
      best = t;
      bestRaw = raw;
    }
  }
  return bestRaw;
}

export function isWithinWindow(iso: string, nowMs: number, recentDays: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const days = Math.max(DISCOVERY_MIN_RECENT_DAYS, Math.min(DISCOVERY_MAX_RECENT_DAYS, Math.floor(recentDays)));
  return t <= nowMs && nowMs - t <= days * 86_400_000;
}

/** True when canonical path equals or nests under any prefix. */
export function underPrefixes(canonical: string, prefixes: string[]): boolean {
  const norm = canonical.endsWith(path.sep) && canonical.length > 1 ? canonical.slice(0, -1) : canonical;
  for (const raw of prefixes) {
    const p = raw.endsWith(path.sep) && raw.length > 1 ? raw.slice(0, -1) : raw;
    if (p.length === 0) continue;
    if (norm === p || norm.startsWith(p + path.sep)) return true;
  }
  return false;
}

function clampDays(recentDays: number): number {
  return Math.max(DISCOVERY_MIN_RECENT_DAYS, Math.min(DISCOVERY_MAX_RECENT_DAYS, Math.floor(recentDays)));
}

/** One-line human summary: recency, source, and exact identity. */
export function describeProject(p: DiscoveredProject): string {
  const where = p.isWorktree ? `${p.cwd} (worktree of ${path.dirname(p.commonGitDir)})` : p.cwd;
  const git = p.isMissing ? "missing" : `${p.ref || (p.isDetached ? "detached" : "?")} @ ${p.head}`;
  const live = p.activeSessionIds.length > 0 ? ` live:${p.activeSessionIds.length}` : "";
  return `${where} — ${git} — active ${p.lastActivity.slice(0, 10)} via ${p.lastActivitySource}, ${p.sessionCount} session${p.sessionCount === 1 ? "" : "s"}${live}${p.note ? ` (${p.note})` : ""}`;
}

type Accum = {
  key: string;
  canonicalCwd: string;
  identity: GitIdentity | undefined;
  missing: boolean;
  pinned: boolean;
  lastActivity: string;
  source: ActivitySource;
  sessionIds: string[];
  activeIds: string[];
  observedCwds: string[];
};

export function discoverRecentProjects(
  config: DiscoveryConfig,
  io: DiscoveryFS,
  opts?: DiscoverOptions,
): DiscoveryResult {
  const now = opts?.nowMs ?? Date.now;
  const cancelled = opts?.isCancelled ?? (() => false);
  const start = now();
  const days = clampDays(config.recentDays);
  const budgets = config.budgets;
  const active = new Set(config.activeSessionIds);

  const result: DiscoveryResult = {
    projects: [],
    scannedFiles: 0,
    scannedBytes: 0,
    skippedStale: 0,
    skippedEphemeral: 0,
    skippedOutsideRoots: 0,
    skippedExcluded: 0,
    skippedNonRepo: 0,
    skippedUnreadable: 0,
    partial: false,
    stoppedBy: "",
    cursor: "",
    elapsedMs: 0,
  };

  const files: string[] = [];
  for (const root of config.sessionRoots) {
    let listed: string[];
    try {
      listed = io.listSessionFiles(root);
    } catch {
      continue;
    }
    for (const f of listed) files.push(f);
  }
  files.sort();

  const accum = new Map<string, Accum>();
  const stop = (reason: string): DiscoveryResult => {
    result.partial = true;
    result.stoppedBy = reason;
    result.elapsedMs = Math.max(0, now() - start);
    result.projects = finish(accum, config);
    return result;
  };

  for (const file of files) {
    if (cancelled()) return stop("cancelled");
    if (now() - start > budgets.wallClockMs) return stop("wall-clock");
    if (result.scannedFiles >= budgets.maxSessionFiles) return stop("max-session-files");
    if (result.scannedBytes >= budgets.maxTotalBytes) return stop("max-total-bytes");

    const perFile = Math.min(budgets.maxBytesPerSession, DISCOVERY_HEAD_BYTES + DISCOVERY_TAIL_BYTES);
    const head = io.readHead(file, Math.min(perFile, DISCOVERY_HEAD_BYTES));
    if (head === undefined) {
      result.skippedUnreadable += 1;
      result.cursor = file;
      continue;
    }
    const parsed = parseSessionHeader(head);
    if (parsed === undefined) {
      result.skippedEphemeral += 1;
      result.cursor = file;
      continue;
    }
    const tail = io.readTail(file, Math.min(perFile, DISCOVERY_TAIL_BYTES)) ?? "";
    // Message activity only: the header's own stamp never counts (a small
    // file's tail includes the header line). Falls back to the header.
    const latest = latestMessageTimestamp(tail, parsed.timestamp);
    const lastActivity = latest ?? parsed.timestamp;
    const source: ActivitySource = latest !== undefined ? "messages" : "header";
    result.scannedFiles += 1;
    result.scannedBytes += Math.min(perFile, head.length + tail.length);

    if (!isWithinWindow(lastActivity, now(), days)) {
      result.skippedStale += 1;
      result.cursor = file;
      continue;
    }

    const canonical = io.realpath(parsed.cwd);
    if (canonical === undefined) {
      // Declared cwd is gone: keep as a missing project, keyed lexically.
      const key = `missing:${path.resolve(parsed.cwd)}`;
      mergeSession(accum, key, {
        key,
        canonicalCwd: path.resolve(parsed.cwd),
        identity: undefined,
        missing: true,
        pinned: underPrefixes(path.resolve(parsed.cwd), config.pinned),
        lastActivity,
        source,
        sessionIds: [parsed.id],
        activeIds: active.has(parsed.id) ? [parsed.id] : [],
        observedCwds: [parsed.cwd],
      });
      if (accum.size >= budgets.maxProjects) return stop("max-projects");
      result.cursor = file;
      continue;
    }
    if (underPrefixes(canonical, config.excluded)) {
      result.skippedExcluded += 1;
      result.cursor = file;
      continue;
    }
    const pinned = underPrefixes(canonical, config.pinned);
    if (!pinned && !config.includeOutsideRoots && !underPrefixes(canonical, config.projectRoots)) {
      result.skippedOutsideRoots += 1;
      result.cursor = file;
      continue;
    }
    if (!io.isDirectory(canonical)) {
      const key = `missing:${canonical}`;
      mergeSession(accum, key, {
        key,
        canonicalCwd: canonical,
        identity: undefined,
        missing: true,
        pinned,
        lastActivity,
        source,
        sessionIds: [parsed.id],
        activeIds: active.has(parsed.id) ? [parsed.id] : [],
        observedCwds: [parsed.cwd],
      });
      if (accum.size >= budgets.maxProjects) return stop("max-projects");
      result.cursor = file;
      continue;
    }
    const identity = io.gitIdentity(canonical);
    if (identity === undefined) {
      result.skippedNonRepo += 1;
      result.cursor = file;
      continue;
    }
    // Dedup key: shared repo + this worktree root. Distinct live worktrees
    // stay distinct; nested cwds and symlinked aliases merge.
    const key = `git:${identity.commonGitDir}|${identity.worktreeRoot}`;
    mergeSession(accum, key, {
      key,
      canonicalCwd: identity.worktreeRoot,
      identity,
      missing: false,
      pinned,
      lastActivity,
      source,
      sessionIds: [parsed.id],
      activeIds: active.has(parsed.id) ? [parsed.id] : [],
      observedCwds: [parsed.cwd],
    });
    if (accum.size >= budgets.maxProjects) return stop("max-projects");
    result.cursor = file;
  }

  result.elapsedMs = Math.max(0, now() - start);
  result.projects = finish(accum, config);
  return result;
}

function mergeSession(into: Map<string, Accum>, key: string, next: Accum): void {
  const prev = into.get(key);
  if (prev === undefined) {
    into.set(key, next);
    return;
  }
  for (const id of next.sessionIds) {
    if (!prev.sessionIds.includes(id)) prev.sessionIds.push(id);
  }
  for (const id of next.activeIds) {
    if (!prev.activeIds.includes(id)) prev.activeIds.push(id);
  }
  for (const cwd of next.observedCwds) {
    if (!prev.observedCwds.includes(cwd) && prev.observedCwds.length < 5) prev.observedCwds.push(cwd);
  }
  if (Date.parse(next.lastActivity) > Date.parse(prev.lastActivity)) {
    prev.lastActivity = next.lastActivity;
    prev.source = next.source;
  }
  prev.pinned = prev.pinned || next.pinned;
  prev.missing = prev.missing && next.missing;
  if (prev.identity === undefined) prev.identity = next.identity;
}

function finish(accum: Map<string, Accum>, config: DiscoveryConfig): DiscoveredProject[] {
  void config;
  const out: DiscoveredProject[] = [];
  for (const a of accum.values()) {
    const id = a.identity;
    // A main checkout's git dir IS the common dir; linked worktrees point
    // into <common>/.git/worktrees/<name>. Both resolved absolute above.
    const isWorktree = id !== undefined && id.gitDir !== id.commonGitDir;
    const notes: string[] = [];
    if (a.missing) notes.push("directory missing");
    else if (id !== undefined && id.detached) notes.push("detached HEAD");
    if (a.activeIds.length > 0) notes.push("active writer — inspect before resuming");
    out.push({
      slug: projectSlug(a.canonicalCwd),
      cwd: a.canonicalCwd,
      commonGitDir: id?.commonGitDir ?? "",
      worktreeRoot: id?.worktreeRoot ?? a.canonicalCwd,
      gitDir: id?.gitDir ?? "",
      ref: id?.ref ?? "",
      head: id?.head ?? "unknown",
      isWorktree,
      isDetached: id?.detached ?? false,
      isMissing: a.missing,
      lastActivity: a.lastActivity,
      lastActivitySource: a.source,
      sessionCount: a.sessionIds.length,
      sessionIds: [...a.sessionIds].sort(),
      activeSessionIds: [...a.activeIds].sort(),
      observedCwds: a.observedCwds,
      pinned: a.pinned,
      note: notes.join("; "),
    });
  }
  out.sort((x, y) => {
    const xa = x.activeSessionIds.length > 0 ? 0 : 1;
    const ya = y.activeSessionIds.length > 0 ? 0 : 1;
    if (xa !== ya) return xa - ya;
    if (x.isMissing !== y.isMissing) return x.isMissing ? 1 : -1;
    if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
    return Date.parse(y.lastActivity) - Date.parse(x.lastActivity);
  });
  return out;
}

// ---- Default node adapter (read-only, bounded, fixed git argv) ----

function runGit(args: string[], cwd: string, timeoutMs = 3000): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return typeof out === "string" ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

function nodeGitIdentity(cwd: string): GitIdentity | undefined {
  const commonRaw = runGit(["rev-parse", "--git-common-dir"], cwd);
  const gitRaw = runGit(["rev-parse", "--git-dir"], cwd);
  const topRaw = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (commonRaw === undefined || gitRaw === undefined || topRaw === undefined) return undefined;
  if (!commonRaw || !gitRaw || !topRaw) return undefined;
  const commonGitDir = path.resolve(cwd, commonRaw);
  const gitDir = path.resolve(cwd, gitRaw);
  const worktreeRoot = path.resolve(cwd, topRaw);
  const abbrev = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const head = runGit(["rev-parse", "--short=12", "HEAD"], cwd) || "unknown";
  const detached = abbrev === "HEAD" || abbrev === undefined;
  return { commonGitDir, gitDir, worktreeRoot, ref: detached ? "" : (abbrev ?? ""), head, detached };
}

function readChunk(file: string, maxBytes: number, fromEnd: boolean): string | undefined {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return "";
    if (!fromEnd) {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return buf.toString("utf8");
    }
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Real read-only adapter: one-level `*.jsonl` walk, bounded chunk reads. */
export function nodeDiscoveryFS(): DiscoveryFS {
  return {
    listSessionFiles(root: string): string[] {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: string[] = [];
      const pushJsonl = (dir: string): void => {
        let inner: string[];
        try {
          inner = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const name of inner) {
          if (name.endsWith(".jsonl")) out.push(path.join(dir, name));
        }
      };
      for (const e of entries) {
        const full = path.join(root, e.name);
        if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
        else if (e.isDirectory()) pushJsonl(full);
      }
      return out.sort();
    },
    readHead: (file, maxBytes) => readChunk(file, maxBytes, false),
    readTail: (file, maxBytes) => readChunk(file, maxBytes, true),
    realpath: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return undefined;
      }
    },
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    gitIdentity: nodeGitIdentity,
  };
}
