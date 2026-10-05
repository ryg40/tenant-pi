/**
 * Project-neutral workstream and checkpoint routing index.
 *
 * A small routing map for a new Coordinator: project/worktree → one
 * workstream → status + current/last/next checkpoint + read-first links +
 * code entry + validation + blockers. Derived LOCAL cache, rebuildable from
 * sources; it never silently overrules them.
 *
 * Evidence honesty rules (no fabricated completion):
 * - Every checkpoint/blocker/status carries an explicit EvidenceKind:
 *   declared (human/prose sources), observed (measured facts), inferred
 *   (a documented rule applied to evidence, e.g. recency → active).
 * - No percentages, no confidence numbers. Unknowns stay absent with a
 *   coverage note, never filled in.
 * - Unsupported/malformed maps yield partial coverage + a draft proposal,
 *   not invented checkpoints.
 * - No-map projects get one explicitly marked draft workstream. One-off
 *   edits merge into the same entry; duplicate workstreams are never
 *   created for them.
 *
 * Pure helpers + injected read-only adapters. No Pi, Herdr, network, or
 * editor imports. The default node adapter lives at the bottom.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { parseProgress } from "../progress/tracker.mts";
import { projectSlug } from "../state/paths.mts";
import { atomicWrite, readText } from "../state/paths.mts";
import { underPrefixes, type DiscoveredProject } from "./discovery.mts";
import { issueUrl, repoProvider, type TrackingRepo } from "../tracking/gitea.mts";

export type EvidenceKind = "declared" | "observed" | "inferred";

export type TaggedText = { text: string; kind: EvidenceKind };

export type ReadFirstLink = { label: string; path: string };

export type ValidationReceipt = { command: string; ref: string; result: string; at: string };

export type SourceRef = { locator: string; revision: string; observedAt: string; kind: string };

export type WorkstreamEntry = {
  workstreamId: string;
  projectKey: string;
  status: string;
  statusKind: EvidenceKind;
  /** Absent when unknown — never invented. */
  current?: TaggedText;
  last?: TaggedText;
  next?: TaggedText;
  readFirst: ReadFirstLink[];
  /** "" when unknown. */
  codeEntry: string;
  validation: ValidationReceipt[];
  blockers: TaggedText[];
  sources: SourceRef[];
  coverage: { complete: boolean; missing: string[] };
  /** Count of checkpoints tagged observed. */
  evidencedCheckpoints: number;
  /** True when no routing source yielded content. */
  draft: boolean;
  /** sha1 over this entry's source contents; rebuilds match. */
  fingerprint: string;
};

export type RoutingIndex = {
  version: 1;
  entries: WorkstreamEntry[];
  skipped: string[];
  partial: boolean;
  stoppedBy: string;
  fingerprint: string;
};

export const ROUTING_DEFAULT_MAX_SOURCES_PER_PROJECT = 8;
export const ROUTING_DEFAULT_MAX_BYTES_PER_SOURCE = 65_536;
export const ROUTING_DEFAULT_MAX_READ_FIRST = 12;
export const ROUTING_DEFAULT_MAX_ENTRIES = 50;
export const ROUTING_ACTIVE_DAYS = 7;
const DAY_MS = 86_400_000;

export type RoutingConfig = {
  projectRoots: string[];
  maxSourcesPerProject: number;
  maxBytesPerSource: number;
  maxReadFirst: number;
  maxEntries: number;
  activeDays: number;
};

export function defaultRoutingConfig(overrides?: {
  projectRoots?: string[];
  maxSourcesPerProject?: number;
  maxBytesPerSource?: number;
  maxReadFirst?: number;
  maxEntries?: number;
  activeDays?: number;
}): RoutingConfig {
  return {
    projectRoots: overrides?.projectRoots ?? [],
    maxSourcesPerProject: Math.max(1, overrides?.maxSourcesPerProject ?? ROUTING_DEFAULT_MAX_SOURCES_PER_PROJECT),
    maxBytesPerSource: Math.max(1024, overrides?.maxBytesPerSource ?? ROUTING_DEFAULT_MAX_BYTES_PER_SOURCE),
    maxReadFirst: Math.max(0, overrides?.maxReadFirst ?? ROUTING_DEFAULT_MAX_READ_FIRST),
    maxEntries: Math.max(1, overrides?.maxEntries ?? ROUTING_DEFAULT_MAX_ENTRIES),
    activeDays: Math.max(1, overrides?.activeDays ?? ROUTING_ACTIVE_DAYS),
  };
}

/** Injected read-only adapters; fakes make every edge testable. */
export interface WorkstreamFS {
  readFile(path: string, maxBytes: number): string | undefined;
  /** Canonical path, following symlinks; undefined when missing/unresolvable. */
  realpath(p: string): string | undefined;
}

export type SourceInput =
  | { kind: "progress"; path: string; projectKey: string; root?: string }
  | { kind: "markdown"; path: string; projectKey: string; root?: string }
  | {
      kind: "issue";
      projectKey: string;
      issue: { number: number; title: string; state: string; url?: string };
      /** Bound tracker repository; locator and fallback URL follow its provider and host. */
      repo?: TrackingRepo;
    };

/** Repository assumed when an issue input names none (historic default). */
const LEGACY_ISSUE_REPO: TrackingRepo = { host: "https://git.example.com", owner: "owner", repo: "promptr", provider: "gitea" };

/** `gitea#12` / `github#12`: provider-qualified issue locator. */
export function issueLocator(repo: TrackingRepo | undefined, n: number): string {
  return `${repoProvider(repo ?? LEGACY_ISSUE_REPO)}#${String(n)}`;
}

export type RoutingOptions = { nowMs?: () => number };

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function cleanLine(line: string, max = 300): string {
  return line.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Lexical + symlink traversal guard. Resolves p, requires it under an
 * approved root both lexically and after realpath. Undefined when rejected
 * or unresolvable; the caller records a coverage note.
 */
export function guardSourcePath(p: string, roots: string[], io: WorkstreamFS): string | undefined {
  if (roots.length === 0) return undefined;
  const abs = path.resolve(p);
  if (!underPrefixes(abs, roots)) return undefined;
  const real = io.realpath(abs);
  if (real === undefined) return undefined;
  if (!underPrefixes(real, roots)) return undefined;
  return real;
}

type AdapterOut = {
  current?: TaggedText;
  last?: TaggedText;
  next?: TaggedText;
  readFirst: ReadFirstLink[];
  codeEntry: string;
  validation: ValidationReceipt[];
  blockers: TaggedText[];
  source: SourceRef;
  contentHash: string;
  recognized: boolean;
};

function emptyOut(source: SourceRef, contentHash: string): AdapterOut {
  return { readFirst: [], codeEntry: "", validation: [], blockers: [], source, contentHash, recognized: false };
}

/** (a) promptr progress.json adapter. Entries are user checkpoints: declared. */
function progressAdapter(raw: string, locator: string, observedAt: string): AdapterOut {
  const hash = sha1(raw);
  const source: SourceRef = { locator, revision: `sha1:${hash.slice(0, 12)}`, observedAt, kind: "progress" };
  const out = emptyOut(source, hash);
  const file = parseProgress(raw);
  if (file.entries.length === 0) return out;
  out.recognized = true;
  const texts = file.entries.map((e) => cleanLine(e.text.split("\n", 1)[0] ?? "")).filter(Boolean);
  if (texts.length === 0) return out;
  const latest = texts[texts.length - 1] ?? "";
  if (latest) out.current = { text: latest, kind: "declared" };
  if (texts.length > 1) {
    const prev = texts[texts.length - 2] ?? "";
    if (prev) out.last = { text: prev, kind: "declared" };
  }
  return out;
}

const MD_CURRENT_RE = /current\s+(snapshot|work|state)|^current$/i;
const MD_NEXT_RE = /exact\s+next\s+action|^next(\s+(action|step|checkpoint))?$/i;
const MD_LAST_RE = /^(last|previous)\b|recent\s+progress|completed/i;
const MD_BLOCKER_RE = /blocker/i;
const MD_CODE_ENTRY_RE = /^\s*[-*]?\s*(?:code\s+entry|entry\s+point|start\s+here)\s*[:–-]\s*(.+)$/i;
const MD_VALIDATED_RE = /^\s*[-*]?\s*validated?\s*[:–-]\s*(.+)$/i;
const MD_LINK_RE = /\[([^\]]{1,80})\]\(([^)\s]{1,200})\)/g;
const MD_HEADING_RE = /^#{1,4}\s+(.+?)\s*$/;
const MD_MAX_SECTION_LINES = 12;

/** (b) Markdown map adapter. Prose is declared, never observed. */
function markdownAdapter(raw: string, locator: string, observedAt: string, root?: string): AdapterOut {
  const hash = sha1(raw);
  const source: SourceRef = { locator, revision: `sha1:${hash.slice(0, 12)}`, observedAt, kind: "markdown" };
  const out = emptyOut(source, hash);
  let section = "";
  let taken = 0;
  for (const rawLine of raw.split("\n")) {
    const hm = MD_HEADING_RE.exec(rawLine.trim());
    if (hm) {
      section = (hm[1] ?? "").trim();
      taken = 0;
      continue;
    }
    if (!section) continue;
    const line = cleanLine(rawLine);
    if (!line) continue;
    if (MD_BLOCKER_RE.test(section)) {
      out.recognized = true;
      if (taken < MD_MAX_SECTION_LINES) {
        out.blockers.push({ text: line.replace(/^[-*]\s*/, ""), kind: "declared" });
        taken += 1;
      }
      continue;
    }
    const cm = MD_CODE_ENTRY_RE.exec(line);
    if (cm && !out.codeEntry) {
      out.recognized = true;
      const candidate = (cm[1] ?? "").trim().replace(/[`*_]/g, "");
      if (candidate && !isTraversalPath(candidate, root)) out.codeEntry = candidate;
      continue;
    }
    const vm = MD_VALIDATED_RE.exec(line);
    if (vm) {
      out.recognized = true;
      out.validation.push({ command: (vm[1] ?? "").trim().slice(0, 200), ref: "", result: "declared", at: "" });
      continue;
    }
    const isCurrent = MD_CURRENT_RE.test(section);
    const isNext = MD_NEXT_RE.test(section);
    const isLast = MD_LAST_RE.test(section);
    if (!isCurrent && !isNext && !isLast) continue;
    out.recognized = true;
    if (taken >= MD_MAX_SECTION_LINES) continue;
    taken += 1;
    const text = line.replace(/^[-*]\s*/, "");
    if (isCurrent && !out.current) out.current = { text, kind: "declared" };
    else if (isNext && !out.next) out.next = { text, kind: "declared" };
    else if (isLast && !out.last) out.last = { text, kind: "declared" };
    for (const link of extractLinks(line, root)) {
      if (!out.readFirst.some((l) => l.path === link.path)) out.readFirst.push(link);
    }
  }
  return out;
}

function isTraversalPath(candidate: string, root?: string): boolean {
  if (!candidate || candidate.length > 300) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) return true;
  if (path.isAbsolute(candidate)) return root === undefined ? false : !underPrefixes(path.resolve(candidate), [root]);
  if (root === undefined) return false;
  return !underPrefixes(path.resolve(root, candidate), [root]);
}

function extractLinks(line: string, root?: string): ReadFirstLink[] {
  const links: ReadFirstLink[] = [];
  MD_LINK_RE.lastIndex = 0;
  for (;;) {
    const m = MD_LINK_RE.exec(line);
    if (m === null) break;
    const target = (m[2] ?? "").trim();
    if (!target || target.startsWith("#") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
    if (isTraversalPath(target, root)) continue;
    links.push({ label: (m[1] ?? target).trim().slice(0, 80) || target, path: target });
  }
  return links;
}

/** (c) Explicit tracker-issue-link adapter (Gitea or GitHub). Caller payload only; no fetch. */
function issueAdapter(
  issue: { number: number; title: string; state: string; url?: string },
  observedAt: string,
  repo: TrackingRepo = LEGACY_ISSUE_REPO,
): AdapterOut {
  const n = Math.floor(issue.number);
  const title = cleanLine(issue.title, 120);
  const payload = JSON.stringify({ n, title, state: issue.state });
  const hash = sha1(payload);
  const locator = issueLocator(repo, n);
  const source: SourceRef = { locator, revision: issue.state === "closed" ? "closed" : "open", observedAt, kind: "issue" };
  const out = emptyOut(source, hash);
  if (!(n > 0) || !title) return out;
  out.recognized = true;
  const url = (issue.url ?? "").trim().slice(0, 300) || issueUrl(repo, n);
  out.readFirst.push({ label: `#${n} ${title}`.slice(0, 100), path: url });
  if (issue.state === "closed") {
    out.validation.push({ command: locator, ref: "", result: "closed", at: "" });
  }
  return out;
}

/** One-line routing summary for a TUI row. Names evidence, never a percent. */
export function describeWorkstream(e: WorkstreamEntry): string {
  const bits = [`${e.workstreamId}`, e.status];
  if (e.next) bits.push(`next: ${e.next.text.slice(0, 80)}`);
  else if (e.current) bits.push(`current: ${e.current.text.slice(0, 80)}`);
  else bits.push("no checkpoints yet");
  if (e.blockers.length > 0) bits.push(`${e.blockers.length} blocker(s)`);
  if (e.draft) bits.push("(draft)");
  return bits.join(" · ");
}

function takeOverSlot(slot: TaggedText | undefined, incoming: TaggedText | undefined): TaggedText | undefined {
  if (!incoming) return slot;
  if (!slot) return incoming;
  // Declared human sources outrank the draft's observed git-state fallback;
  // within the same kind, first wins (deterministic input order).
  if (incoming.kind === "declared" && slot.kind !== "declared") return incoming;
  return slot;
}

function mergeOut(
  entry: WorkstreamEntry,
  o: AdapterOut,
  maxReadFirst: number,
): void {
  const c = takeOverSlot(entry.current, o.current);
  if (c) entry.current = c;
  const l = takeOverSlot(entry.last, o.last);
  if (l) entry.last = l;
  const n = takeOverSlot(entry.next, o.next);
  if (n) entry.next = n;
  if (!entry.codeEntry && o.codeEntry) entry.codeEntry = o.codeEntry;
  entry.validation.push(...o.validation);
  entry.blockers.push(...o.blockers);
  for (const l of o.readFirst) {
    if (entry.readFirst.length >= maxReadFirst) break;
    if (!entry.readFirst.some((x) => x.path === l.path)) entry.readFirst.push(l);
  }
  entry.sources.push(o.source);
}

function draftEntry(p: DiscoveredProject, observedAt: string, missing: string[]): WorkstreamEntry {
  const gitLine = p.head && p.head !== "unknown"
    ? `observed state: ${p.ref || "detached"} @ ${p.head}${p.note ? ` (${p.note})` : ""}, seen ${p.lastActivity}`
    : "";
  return {
    workstreamId: `ws-${p.slug}`,
    projectKey: p.slug,
    status: "draft — no map found",
    statusKind: "inferred",
    ...(gitLine ? { current: { text: gitLine.slice(0, 300), kind: "observed" as const } } : {}),
    readFirst: [],
    codeEntry: "",
    validation: [],
    blockers: [],
    sources: [{ locator: `discovery:${p.slug}`, revision: p.head, observedAt, kind: "discovery" }],
    coverage: { complete: false, missing },
    evidencedCheckpoints: gitLine ? 1 : 0,
    draft: true,
    fingerprint: sha1(`draft:${p.slug}`),
  };
}

/**
 * Build the routing index. Deterministic: same inputs → same index (no
 * wall-clock output; recency uses injected nowMs only for status labels).
 * One entry per project; extra sources merge, never duplicate.
 */
export function buildRoutingIndex(
  projects: DiscoveredProject[],
  inputs: SourceInput[],
  io: WorkstreamFS,
  config: RoutingConfig,
  opts?: RoutingOptions,
): RoutingIndex {
  const now = opts?.nowMs ?? Date.now;
  const byProject = new Map<string, SourceInput[]>();
  for (const input of inputs) {
    const list = byProject.get(input.projectKey) ?? [];
    list.push(input);
    byProject.set(input.projectKey, list);
  }
  const entries: WorkstreamEntry[] = [];
  const skipped: string[] = [];
  let stoppedBy = "";
  const kinds: Record<SourceInput["kind"], number> = { progress: 0, markdown: 1, issue: 2 };

  for (const p of projects) {
    if (entries.length >= config.maxEntries) {
      stoppedBy = "max-entries";
      break;
    }
    const key = p.slug;
    const observedAt = p.lastActivity;
    const missing: string[] = [];
    const entry = draftEntry(p, observedAt, missing);
    const list = (byProject.get(key) ?? []).slice(0, config.maxSourcesPerProject).sort((a, b) => {
      const k = kinds[a.kind] - kinds[b.kind];
      if (k !== 0) return k;
      const la = a.kind === "issue" ? issueLocator(a.repo, a.issue.number) : a.path;
      const lb = b.kind === "issue" ? issueLocator(b.repo, b.issue.number) : b.path;
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    const hashes: string[] = [`draft:${key}`];
    for (const input of list) {
      if (input.kind === "issue") {
        const o = issueAdapter(input.issue, observedAt, input.repo);
        hashes.push(o.contentHash);
        if (!o.recognized) {
          missing.push(`issue payload unusable for ${key}`);
          continue;
        }
        mergeOut(entry, o, config.maxReadFirst);
        continue;
      }
      const root = input.root ?? p.cwd;
      const guarded = guardSourcePath(input.path, config.projectRoots, io);
      if (guarded === undefined) {
        missing.push(`rejected outside approved roots: ${input.path}`);
        continue;
      }
      const raw = io.readFile(guarded, config.maxBytesPerSource);
      if (raw === undefined) {
        missing.push(`unreadable source: ${input.path}`);
        continue;
      }
      const locator = guarded;
      const o = input.kind === "progress"
        ? progressAdapter(raw, locator, observedAt)
        : markdownAdapter(raw, locator, observedAt, root);
      hashes.push(o.contentHash);
      if (!o.recognized) {
        missing.push(`no recognized sections: ${input.path}`);
        continue;
      }
      mergeOut(entry, o, config.maxReadFirst);
    }
    const yielded = entry.sources.length > 1;
    if (yielded) {
      entry.draft = false;
      entry.coverage = { complete: missing.length === 0, missing: [...missing] };
      const recentMs = now() - Date.parse(p.lastActivity);
      const recent = !Number.isNaN(recentMs) && recentMs >= 0 && recentMs <= config.activeDays * DAY_MS;
      if (entry.blockers.length > 0) {
        entry.status = "blocked";
        entry.statusKind = "declared";
      } else if (recent) {
        entry.status = "active";
        entry.statusKind = "inferred";
      } else {
        entry.status = "idle";
        entry.statusKind = "inferred";
      }
    } else {
      if (missing.length === 0) missing.push("no routing sources");
    }
    entry.evidencedCheckpoints = [entry.current, entry.last, entry.next]
      .filter((c) => c?.kind === "observed").length;
    hashes.sort();
    entry.fingerprint = sha1(hashes.join("|"));
    entries.push(entry);
  }
  const fingerprint = sha1(entries.map((e) => `${e.workstreamId}:${e.fingerprint}`).join("|"));
  return {
    version: 1,
    entries,
    skipped,
    partial: stoppedBy !== "" || entries.some((e) => !e.coverage.complete),
    stoppedBy,
    fingerprint,
  };
}

// ---- Derived-cache persistence (clearly a cache: fingerprint recorded) ----

export type SavedRoutingIndex = { version: 1; fingerprint: string; entries: WorkstreamEntry[] };

export function saveRoutingIndex(file: string, index: RoutingIndex): void {
  const saved: SavedRoutingIndex = { version: 1, fingerprint: index.fingerprint, entries: index.entries };
  atomicWrite(file, JSON.stringify(saved, null, 2));
}

export function loadRoutingIndex(raw: string | undefined): SavedRoutingIndex | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (r.version !== 1 || typeof r.fingerprint !== "string" || !Array.isArray(r.entries)) return undefined;
    return { version: 1, fingerprint: r.fingerprint, entries: r.entries as WorkstreamEntry[] };
  } catch {
    return undefined;
  }
}

/** True when the saved cache matches a fresh build: safe to reuse. */
export function cacheMatches(saved: SavedRoutingIndex | undefined, fresh: RoutingIndex): boolean {
  if (!saved) return false;
  return saved.fingerprint === fresh.fingerprint;
}

// ---- Default node adapter (read-only, bounded) ----

export function nodeWorkstreamFS(): WorkstreamFS {
  return {
    readFile(p: string, maxBytes: number): string | undefined {
      let fd = -1;
      try {
        fd = fs.openSync(p, "r");
        const size = fs.fstatSync(fd).size;
        if (size <= 0) return "";
        const len = Math.min(size, Math.max(1, maxBytes));
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        return buf.toString("utf8");
      } catch {
        return undefined;
      } finally {
        if (fd >= 0) {
          try { fs.closeSync(fd); } catch { /* ignore */ }
        }
      }
    },
    realpath(p: string): string | undefined {
      try {
        return fs.realpathSync(p);
      } catch {
        return undefined;
      }
    },
  };
}

/** Project key for a checkout: stable slug plus short canonical hash. */
export function routingProjectKey(cwd: string): string {
  return projectSlug(cwd);
}
