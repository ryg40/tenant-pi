/**
 * Project tracking, adapted from Omakase Bar for Promptr.
 *
 * Omakase source: itama8/omakase-skills `extensions/omakase-bar/` —
 * a checkpoint map plus `/work-status` cards with a progress bar that
 * counts accepted checkpoints (next counts 0.35). Promptr adapts the
 * *display* shape only:
 *
 * - Gitea issues are authoritative and read-only. This module never
 *   writes issues, milestones, or labels; it only groups open issues
 *   by milestone and renders progress from closed/(open+closed).
 * - No second writable task database. Snapshots are a display cache
 *   under the per-project state dir; staleness is always shown.
 * - Issue titles/bodies are untrusted data. Renderers sanitize control
 *   bytes; the companion view escapes them again on paint.
 *
 * Pure helpers + a thin fetch adapter. No filesystem, no Pi imports.
 */

export type IssueState = "open" | "closed";

export interface TrackedIssue {
  number: number;
  title: string;
  state: IssueState;
  milestone: string;
  labels: string[];
  url: string;
  /** Gitea assignee login, when set. Assignment is the Wayfinder claim. */
  assignee?: string;
  /** ISO stamp of the issue's last update, when the source supplied one. */
  updatedAt?: string;
  /**
   * Open native dependency blockers. `undefined` means the dependency graph
   * was not read for this issue; it must never be rendered as "unblocked".
   */
  blockers?: number;
}

export interface MilestoneGroup {
  name: string;
  open: number;
  closed: number;
  total: number;
  /** Integer 0..100, closed/total. No partial credit: Gitea has no "next". */
  progress: number;
  openIssues: TrackedIssue[];
}

/** Tracker providers Promptr can read. Absent means `gitea` (older caches). */
export type TrackingProvider = "gitea" | "github";

export interface TrackingRepo {
  host: string;
  owner: string;
  repo: string;
  /** Which adapter reads this repository. Identity, never inferred from an issue URL. */
  provider?: TrackingProvider;
}

/** Provider of a repo binding; `gitea` when unspecified. */
export function repoProvider(repo: Pick<TrackingRepo, "provider">): TrackingProvider {
  return repo.provider === "github" ? "github" : "gitea";
}

/** Copy the identity fields of a repo binding, host without trailing slashes. */
export function repoIdentity(repo: TrackingRepo): TrackingRepo {
  const out: TrackingRepo = { host: repo.host.replace(/\/+$/, ""), owner: repo.owner, repo: repo.repo };
  if (repo.provider === "github" || repo.provider === "gitea") out.provider = repo.provider;
  return out;
}

export interface TrackingOverall {
  open: number;
  closed: number;
  total: number;
  progress: number;
}

export interface TrackingSnapshot {
  version: 1;
  fetchedAt: string;
  repo: TrackingRepo;
  overall: TrackingOverall;
  groups: MilestoneGroup[];
  /**
   * Every open issue the fetch saw (bounded), independent of the per-milestone
   * display cap. Optional: older caches lack it and render the capped groups.
   */
  openIssues?: TrackedIssue[];
}

/** Bound for the full open-issue list carried by a snapshot. */
export const MAX_OPEN_ISSUES = 120;

export const NO_MILESTONE = "No milestone";
const MAX_TITLE_CHARS = 100;
const MAX_OPEN_ISSUES_PER_GROUP = 10;
/** Row-level title budgets. The pane never wraps, so long titles are cut here. */
const COMPACT_TITLE_CHARS = 56;
const BOARD_TITLE_CHARS = 72;
/** Milestone context is one rollup row, never one bar per milestone. */
const ROLLUP_MAX_GROUPS = 6;

/** Single-line sanitizer for issue/milestone text. Control bytes become spaces. */
export function sanitizeTitle(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\x00-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

function sanitizeMilestone(text: unknown): string {
  const clean = sanitizeTitle(text);
  return clean.length > 0 ? clean.slice(0, 80) : NO_MILESTONE;
}

/** Omakase-style bar: `[████████░░░░]  67%`. Width counts cells, not effort/time. */
export function progressBar(progress: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(clamped).padStart(3)}%`;
}

function progressFor(open: number, closed: number): number {
  const total = open + closed;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((closed / total) * 100)));
}

function compareGroupNames(a: string, b: string): number {
  if (a === NO_MILESTONE && b !== NO_MILESTONE) return 1;
  if (b === NO_MILESTONE && a !== NO_MILESTONE) return -1;
  return new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare(a, b);
}

function toTrackedIssue(raw: unknown): TrackedIssue | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const number = typeof r.number === "number" && Number.isInteger(r.number) ? r.number : undefined;
  const title = sanitizeTitle(r.title);
  const state: IssueState = r.state === "closed" ? "closed" : "open";
  if (number === undefined || number <= 0 || title.length === 0) return undefined;
  let milestone = NO_MILESTONE;
  if (typeof r.milestone === "string") milestone = sanitizeMilestone(r.milestone);
  else if (typeof r.milestone === "object" && r.milestone !== null) {
    milestone = sanitizeMilestone((r.milestone as Record<string, unknown>).title);
  }
  const labels: string[] = Array.isArray(r.labels)
    ? r.labels
      .map((l) => (typeof l === "string" ? sanitizeTitle(l).slice(0, 40) : ""))
      .filter((l) => l.length > 0)
      .slice(0, 12)
    : [];
  const url = typeof r.url === "string" ? r.url.slice(0, 300) : "";
  const out: TrackedIssue = { number, title, state, milestone, labels, url };
  const assignee = typeof r.assignee === "string" ? sanitizeTitle(r.assignee).slice(0, 40) : "";
  if (assignee.length > 0) out.assignee = assignee;
  if (typeof r.updatedAt === "string" && !Number.isNaN(Date.parse(r.updatedAt))) out.updatedAt = new Date(r.updatedAt).toISOString();
  if (typeof r.blockers === "number" && Number.isInteger(r.blockers) && r.blockers >= 0) out.blockers = r.blockers;
  return out;
}

/** Validate one adapter-neutral issue record (used by the GitHub adapter too). */
export function toTrackedIssueRecord(raw: unknown): TrackedIssue | undefined {
  return toTrackedIssue(raw);
}

/** Validate an untrusted array (e.g. decoded tracking.json) into tracked issues. */
export function parseTrackedIssues(raw: unknown): TrackedIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedIssue[] = [];
  for (const item of raw.slice(0, 500)) {
    const parsed = toTrackedIssue(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseMilestoneCounts(raw: unknown): Map<string, { open: number; closed: number }> {
  const counts = new Map<string, { open: number; closed: number }>();
  if (!Array.isArray(raw)) return counts;
  for (const item of raw.slice(0, 100)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const name = sanitizeMilestone(r.title ?? r.name);
    if (name === NO_MILESTONE) continue;
    const open = typeof r.open_issues === "number" && r.open_issues >= 0 ? Math.floor(r.open_issues) : 0;
    const closed = typeof r.closed_issues === "number" && r.closed_issues >= 0 ? Math.floor(r.closed_issues) : 0;
    counts.set(name, { open, closed });
  }
  return counts;
}

/**
 * Group issues by milestone. When milestone counts are supplied (Gitea
 * `/milestones`), their open/closed totals are authoritative for the bar;
 * the issue list only supplies the visible open-issue rows. Otherwise the
 * bar is derived from the issue states present.
 */
export function groupIssues(
  issues: TrackedIssue[],
  milestoneCounts?: Map<string, { open: number; closed: number }>,
): MilestoneGroup[] {
  const byName = new Map<string, TrackedIssue[]>();
  for (const issue of issues) {
    const list = byName.get(issue.milestone) ?? [];
    list.push(issue);
    byName.set(issue.milestone, list);
  }
  if (milestoneCounts) {
    for (const name of milestoneCounts.keys()) {
      if (!byName.has(name)) byName.set(name, []);
    }
  }
  const groups: MilestoneGroup[] = [];
  for (const [name, list] of byName) {
    const counted = milestoneCounts?.get(name);
    const openIssues = list
      .filter((i) => i.state === "open")
      .sort((a, b) => a.number - b.number)
      .slice(0, MAX_OPEN_ISSUES_PER_GROUP);
    if (counted) {
      const total = counted.open + counted.closed;
      groups.push({
        name,
        open: counted.open,
        closed: counted.closed,
        total,
        progress: progressFor(counted.open, counted.closed),
        openIssues,
      });
    } else {
      const open = list.filter((i) => i.state === "open").length;
      const closed = list.filter((i) => i.state === "closed").length;
      groups.push({
        name,
        open,
        closed,
        total: open + closed,
        progress: progressFor(open, closed),
        openIssues,
      });
    }
  }
  groups.sort((a, b) => compareGroupNames(a.name, b.name));
  return groups;
}

export function buildSnapshot(
  repo: TrackingRepo,
  issues: TrackedIssue[],
  milestoneCounts: Map<string, { open: number; closed: number }> | undefined,
  fetchedAt: string,
): TrackingSnapshot {
  const groups = groupIssues(issues, milestoneCounts);
  let open = 0;
  let closed = 0;
  if (milestoneCounts && milestoneCounts.size > 0) {
    for (const c of milestoneCounts.values()) {
      open += c.open;
      closed += c.closed;
    }
    // Issues without a milestone are not in milestone counts; add them.
    const uncounted = groups.find((g) => g.name === NO_MILESTONE);
    if (uncounted) {
      open += uncounted.open;
      closed += uncounted.closed;
    }
  } else {
    for (const g of groups) {
      open += g.open;
      closed += g.closed;
    }
  }
  const total = open + closed;
  const openIssues = issues
    .filter((i) => i.state === "open")
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_OPEN_ISSUES);
  return {
    version: 1,
    fetchedAt,
    repo: repoIdentity(repo),
    overall: { open, closed, total, progress: progressFor(open, closed) },
    groups,
    openIssues,
  };
}

export function parseSnapshot(raw: unknown): TrackingSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return undefined;
  if (typeof r.fetchedAt !== "string") return undefined;
  if (typeof r.repo !== "object" || r.repo === null) return undefined;
  const repo = r.repo as Record<string, unknown>;
  if (typeof repo.host !== "string" || typeof repo.owner !== "string" || typeof repo.repo !== "string") {
    return undefined;
  }
  if (typeof r.overall !== "object" || r.overall === null) return undefined;
  const o = r.overall as Record<string, unknown>;
  if (typeof o.open !== "number" || typeof o.closed !== "number" || typeof o.total !== "number" || typeof o.progress !== "number") {
    return undefined;
  }
  if (!Array.isArray(r.groups)) return undefined;
  const groups: MilestoneGroup[] = [];
  for (const g of r.groups.slice(0, 50)) {
    if (typeof g !== "object" || g === null) continue;
    const gr = g as Record<string, unknown>;
    if (typeof gr.name !== "string" || typeof gr.open !== "number" || typeof gr.closed !== "number") continue;
    groups.push({
      name: sanitizeMilestone(gr.name),
      open: Math.max(0, Math.floor(gr.open)),
      closed: Math.max(0, Math.floor(typeof gr.closed === "number" ? gr.closed : 0)),
      total: Math.max(0, Math.floor(typeof gr.total === "number" ? gr.total : 0)),
      progress: Math.max(0, Math.min(100, Math.round(typeof gr.progress === "number" ? gr.progress : 0))),
      openIssues: parseTrackedIssues(gr.openIssues).slice(0, MAX_OPEN_ISSUES_PER_GROUP),
    });
  }
  const snapshot: TrackingSnapshot = {
    version: 1,
    fetchedAt: r.fetchedAt,
    repo: {
      host: repo.host.slice(0, 200), owner: repo.owner.slice(0, 100), repo: repo.repo.slice(0, 100),
      ...(repo.provider === "github" || repo.provider === "gitea" ? { provider: repo.provider } : {}),
    },
    overall: {
      open: Math.max(0, Math.floor(o.open)),
      closed: Math.max(0, Math.floor(o.closed)),
      total: Math.max(0, Math.floor(o.total)),
      progress: Math.max(0, Math.min(100, Math.round(o.progress))),
    },
    groups,
  };
  if (Array.isArray(r.openIssues)) {
    snapshot.openIssues = parseTrackedIssues(r.openIssues).filter((i) => i.state === "open").slice(0, MAX_OPEN_ISSUES);
  }
  return snapshot;
}

/**
 * Open issues for a workboard: the snapshot's full open list when it has
 * one, else the capped per-milestone rows. Ascending by number, deduped.
 */
export function snapshotOpenIssues(snapshot: TrackingSnapshot): TrackedIssue[] {
  if (snapshot.openIssues && snapshot.openIssues.length > 0) return [...snapshot.openIssues];
  return flattenOpenIssues(snapshot.groups);
}

/** Short milestone code for single-line displays: `S1.1 — Name…` → `S1.1`. */
export function shortMilestone(name: string): string {
  const short = name.split(/\s+[—–-]\s+|\s*:\s*/)[0]?.trim() ?? "";
  if (short.length > 0 && short.length <= 24) return short;
  return name.length <= 24 ? name : `${name.slice(0, 23)}…`;
}

/**
 * Trim a title to one row's budget. `…` marks that bytes were cut.
 * Re-sanitizes: snapshots normally arrive via parseSnapshot, but the row
 * contract is that a renderer never emits a control byte on its own.
 */
function clampTitle(title: string, max: number): string {
  const clean = sanitizeTitle(title);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Trailing milestone context for an issue row. `No milestone` adds nothing. */
function milestoneTag(milestone: string): string {
  const clean = sanitizeTitle(milestone);
  return clean === NO_MILESTONE || clean.length === 0 ? "" : ` · ${shortMilestone(clean)}`;
}

/**
 * Open issues across every milestone, deduped, ascending by issue number.
 *
 * This is a *display* order, not a plan: the snapshot carries no assignee,
 * dependency, or "in progress" field, so nothing here may be presented as
 * the next runnable task. Callers label these rows as open issues only.
 */
function flattenOpenIssues(groups: MilestoneGroup[]): TrackedIssue[] {
  const seen = new Set<number>();
  const out: TrackedIssue[] = [];
  for (const g of groups) {
    for (const issue of g.openIssues) {
      if (issue.state !== "open" || seen.has(issue.number)) continue;
      seen.add(issue.number);
      out.push(issue);
    }
  }
  out.sort((a, b) => a.number - b.number);
  return out;
}

/**
 * One-row milestone context: `Milestones · S1.1 0/7 · S2 0/9 · +2`.
 * Replaces the old per-milestone bar wall, which spent six rows to say 0%.
 * Milestones with no issues at all are omitted; they carry no signal.
 */
function milestoneRollup(groups: MilestoneGroup[]): string | undefined {
  const withWork = groups.filter((g) => g.total > 0);
  if (withWork.length === 0) return undefined;
  const shown = withWork.slice(0, ROLLUP_MAX_GROUPS);
  const parts = shown.map((g) => `${shortMilestone(g.name)} ${g.closed}/${g.total}`);
  const hidden = withWork.length - shown.length;
  if (hidden > 0) parts.push(`+${hidden}`);
  return `Milestones · ${parts.join(" · ")}`;
}

/**
 * Repository, counts, and snapshot age on one row. Both panes render under a
 * `TRACKING (Gitea, read-only)` region rule, so this row does not repeat the
 * word: the heading is the region's, the content is the repo's. Age is always
 * present and always explicit — a stale snapshot must never look live.
 */
function summaryLine(snapshot: TrackingSnapshot, _withBar: boolean): string {
  const age = ageLine(snapshot.fetchedAt);
  const repo = `${sanitizeTitle(snapshot.repo.owner)}/${sanitizeTitle(snapshot.repo.repo)}`;
  const o = snapshot.overall;
  if (o.total === 0) return `${repo} · no issues tracked · ${age}`;
  // A closed Gitea issue may be completed, superseded, or retired. Without
  // disposition data, even a progress bar would falsely imply delivered work.
  return `${repo} · ${o.closed}/${o.total} dispositioned · ${o.open} open · ${age}`;
}

const OPEN_ISSUES_HEADER = "Open issues · Gitea order, not a run queue:";

/**
 * Open issues the snapshot knows about but this pane did not list.
 *
 * `openIssues` is capped per milestone, so the listable rows are a subset of
 * the real open count. Reporting the row-list remainder would understate the
 * backlog (11 listable vs 43 actually open), so the authoritative
 * `overall.open` wins whenever it is larger.
 */
function remainingOpen(snapshot: TrackingSnapshot, listable: number, shown: number): number {
  return Math.max(0, Math.max(snapshot.overall.open, listable) - shown);
}

/**
 * Compact lines for the coordinatr window (right pane). Bounded, no wrapping.
 *
 * Shape: repo/counts/age summary, then real open issue numbers and titles,
 * then a `/work-status` hint, then milestone counts on one row if the budget
 * still allows. Rows are spent on work a human can act on, not on bars.
 * Never returns more than `maxRows` rows, including tiny budgets.
 */
export function renderCompactLines(snapshot: TrackingSnapshot, maxRows = 8): string[] {
  const budget = Math.max(0, Math.floor(maxRows));
  if (budget === 0) return [];
  const lines: string[] = [summaryLine(snapshot, false)];
  if (budget === 1) return lines;

  const open = flattenOpenIssues(snapshot.groups);
  const rollup = milestoneRollup(snapshot.groups);

  if (open.length === 0) {
    lines.push(
      snapshot.overall.total === 0
        ? `  /work-status refreshes; Gitea stays authoritative`
        : `  No open issues listed · /work-status refreshes; Gitea authoritative`,
    );
    if (rollup && lines.length < budget) lines.push(rollup);
    return lines.slice(0, budget);
  }

  // Reserve the trailing hint and (when there is room) the milestone rollup.
  // No `Open issues:` header here: the summary already counts them and the
  // narrow pane would rather spend that row on one more real issue.
  const wantHint = budget >= 3;
  const wantRollup = rollup !== undefined && budget >= 6;
  const listCap = budget - (wantHint ? 1 : 0) - (wantRollup ? 1 : 0);
  let shown = 0;
  for (const issue of open) {
    if (lines.length >= listCap) break;
    lines.push(`  #${issue.number} ${clampTitle(issue.title, COMPACT_TITLE_CHARS)}${milestoneTag(issue.milestone)}`);
    shown += 1;
  }
  const remaining = remainingOpen(snapshot, open.length, shown);
  if (wantHint && lines.length < budget) {
    lines.push(
      remaining > 0
        ? `+${remaining} more open · /work-status browses all`
        : `${shown} open issue(s) · /work-status browses milestones`,
    );
  }
  if (wantRollup && rollup && lines.length < budget) lines.push(rollup);
  return lines.slice(0, budget);
}

/**
 * Human-usable bottom-panel lines for the hosted /promptr view.
 *
 * Same shape as renderCompactLines with a wider row budget: longer titles and
 * more open issues. Closed counts are dispositioned rather than progress:
 * retired/superseded issues must not look like delivered work. The previous
 * version spent a header plus a 12-cell bar on every milestone before showing
 * two issues; that wall of bars hid the work.
 * Bounded to maxRows; overflow always names /work-status as the next step.
 */
export function renderBoardLines(snapshot: TrackingSnapshot, maxRows = 14): string[] {
  const budget = Math.max(0, Math.floor(maxRows));
  if (budget === 0) return [];
  const lines: string[] = [summaryLine(snapshot, true)];
  if (budget === 1) return lines;

  const open = flattenOpenIssues(snapshot.groups);
  const rollup = milestoneRollup(snapshot.groups);

  if (open.length === 0) {
    lines.push(
      snapshot.overall.total === 0
        ? `No issues tracked yet · /work-status refreshes; Gitea stays authoritative`
        : `No open issues listed · ${snapshot.overall.closed}/${snapshot.overall.total} dispositioned · /work-status refreshes`,
    );
    if (rollup && lines.length < budget) lines.push(rollup);
    return lines.slice(0, budget);
  }

  const wantHint = budget >= 3;
  const wantRollup = rollup !== undefined && budget >= 5;
  const listCap = budget - (wantHint ? 1 : 0) - (wantRollup ? 1 : 0);
  if (budget >= 5 && lines.length < listCap) lines.push(OPEN_ISSUES_HEADER);
  let shown = 0;
  for (const issue of open) {
    if (lines.length >= listCap) break;
    lines.push(`  #${issue.number} ${clampTitle(issue.title, BOARD_TITLE_CHARS)}${milestoneTag(issue.milestone)}`);
    shown += 1;
  }
  const remaining = remainingOpen(snapshot, open.length, shown);
  if (wantHint && lines.length < budget) {
    lines.push(
      remaining > 0
        ? `+${remaining} more open · /work-status browses all`
        : `/work-status browses milestones → issue → queues an explicit start prompt`,
    );
  }
  if (wantRollup && rollup && lines.length < budget) lines.push(rollup);
  return lines.slice(0, budget);
}

export function renderPlaceholderLines(reason: string): string[] {
  const clean = sanitizeTitle(reason).slice(0, 90) || "unavailable";
  return [`TRACKING (Gitea, read-only): ${clean}`, `  /work-status refreshes; Gitea stays authoritative`];
}

/** One-line summary for `/coordinatr status`. Short enough for setStatus. */
export function trackingStatusLine(snapshot: TrackingSnapshot): string {
  const parts = snapshot.groups.slice(0, 6).map((g) => `${shortMilestone(g.name)} ${g.closed}/${g.total}`);
  return `tracking ${snapshot.overall.closed}/${snapshot.overall.total} closed · ${parts.join(" · ")}`;
}

/** Full detail for `/work-status` notify output. */
export function renderFullText(snapshot: TrackingSnapshot): string {
  const lines: string[] = [];
  lines.push(`Project tracking — ${snapshot.repo.owner}/${snapshot.repo.repo} (Gitea read-only, ${ageLine(snapshot.fetchedAt)})`);
  lines.push(`Overall ${progressBar(snapshot.overall.progress)} ${snapshot.overall.closed}/${snapshot.overall.total} closed, ${snapshot.overall.open} open`);
  lines.push(`Progress shows closed Gitea issues, not effort or time.`);
  for (const g of snapshot.groups) {
    lines.push(``);
    lines.push(`${g.name} ${progressBar(g.progress)} ${g.closed}/${g.total} closed`);
    if (g.openIssues.length === 0) {
      lines.push(`  (no open issues listed)`);
    } else {
      for (const issue of g.openIssues) {
        lines.push(`  #${issue.number} ${issue.title}`);
      }
      const hidden = g.total - g.closed - g.openIssues.length;
      if (hidden > 0) lines.push(`  ... ${hidden} more open — see Gitea`);
    }
  }
  return lines.join("\n");
}

/**
 * Explicit start prompt for one issue. Read-only context: the agent must
 * verify git + issue state first. Never auto-sent; the caller reviews.
 */
export function buildIssueStartPrompt(issue: TrackedIssue, repo: TrackingRepo): string {
  const host = repo.host.replace(/\/+$/, "");
  const link = issue.url || `${host}/${repo.owner}/${repo.repo}/issues/${issue.number}`;
  const tracker = repo.provider === "github" ? "GitHub" : "Gitea";
  return [
    `Continue Promptr work on ${tracker} #${issue.number}: ${issue.title}.`,
    ``,
    `Milestone: ${issue.milestone} · state: ${issue.state} · ${link}`,
    ``,
    `First verify: \`git status --short --branch\` and \`git log --oneline -5\`.`,
    `Then fetch the live issue (it may have moved since this snapshot) and restate`,
    `the smallest runnable next step before editing. Record progress with`,
    `\`/promptr-save "did X, next Y"\`. ${tracker} stays authoritative; do not invent closure.`,
  ].join("\n");
}

// ---- repo resolution (best-effort, never throws) ----

export function defaultRepo(env: NodeJS.ProcessEnv = process.env): TrackingRepo {
  const host = (env.GITEA_HOST ?? "https://git.example.com").trim() || "https://git.example.com";
  const owner = (env.GITEA_OWNER ?? "owner").trim() || "owner";
  const repo = (env.GITEA_REPO ?? "promptr").trim() || "promptr";
  return { host: host.replace(/\/+$/, ""), owner, repo, provider: "gitea" };
}

/** Parse `git remote get-url` output into host/owner/repo. Undefined when unrecognized. */
export function parseGitRemote(remoteUrl: string): TrackingRepo | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  let m = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (m?.[1] && m?.[2] && m?.[3]) {
    return { host: `https://${m[1]}`, owner: m[2], repo: m[3] };
  }
  m = trimmed.match(/^(https?:\/\/[^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (m?.[1] && m?.[2] && m?.[3]) {
    return { host: m[1], owner: m[2], repo: m[3] };
  }
  return undefined;
}

// ---- fetch adapter (thin, bounded, token never logged) ----

export interface FetchTrackingOptions {
  repo: TrackingRepo;
  token?: string;
  timeoutMs?: number;
  perPage?: number;
  maxPages?: number;
  fetchFn?: typeof fetch;
  now?: () => string;
  /**
   * Also read native dependencies for open issues (one bounded GET each, up
   * to `blockerReadLimit`), so the workboard can tell ready from blocked.
   * An issue whose read fails keeps `blockers` undefined: unknown, not clear.
   */
  withBlockers?: boolean;
  blockerReadLimit?: number;
}

/** Default bound on per-issue dependency reads in one tracking refresh. */
export const DEFAULT_BLOCKER_READ_LIMIT = 40;

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token && token.length > 0) headers.Authorization = `token ${token}`;
  return headers;
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers: authHeaders(token), signal: ctrl.signal });
    if (!res.ok) throw new Error(`Gitea ${res.status} for ${new URL(url).pathname}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function toIssueList(raw: unknown, repo: TrackingRepo): TrackedIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedIssue[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const milestoneTitle =
      typeof r.milestone === "object" && r.milestone !== null
        ? ((r.milestone as Record<string, unknown>).title as unknown)
        : undefined;
    const labels = Array.isArray(r.labels)
      ? r.labels.map((l) =>
        typeof l === "object" && l !== null ? ((l as Record<string, unknown>).name as unknown) : l,
      )
      : [];
    const assigneeLogin =
      typeof r.assignee === "object" && r.assignee !== null
        ? ((r.assignee as Record<string, unknown>).login as unknown)
        : undefined;
    const tracked = toTrackedIssue({
      number: r.number,
      title: r.title,
      state: r.state,
      milestone: typeof milestoneTitle === "string" ? milestoneTitle : NO_MILESTONE,
      labels,
      url: typeof r.html_url === "string" ? r.html_url : `${repo.host}/${repo.owner}/${repo.repo}/issues/${String(r.number ?? "")}`,
      assignee: typeof assigneeLogin === "string" ? assigneeLogin : undefined,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
    });
    if (tracked) out.push(tracked);
  }
  return out;
}

/**
 * Fetch milestones + issues for one repo. Throws Error(reason) on network,
 * auth, or parse failure; the caller decides cache fallback messaging.
 * Pull requests are excluded via type=issues.
 */
export async function fetchTracking(options: FetchTrackingOptions): Promise<TrackingSnapshot> {
  const repo = options.repo;
  const token = options.token ?? process.env.GITEA_TOKEN;
  const timeoutMs = options.timeoutMs ?? 8000;
  const perPage = Math.max(1, Math.min(50, options.perPage ?? 50));
  const maxPages = Math.max(1, Math.min(5, options.maxPages ?? 5));
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = `${repo.host.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

  const milestonesRaw = await fetchJson(fetchFn, `${base}/milestones?state=all&limit=50`, token, timeoutMs).catch(
    () => undefined,
  );
  const milestoneCounts = milestonesRaw === undefined ? undefined : parseMilestoneCounts(milestonesRaw);

  const issues: TrackedIssue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchJson(
      fetchFn,
      `${base}/issues?state=all&type=issues&limit=${perPage}&page=${page}`,
      token,
      timeoutMs,
    );
    const batch = toIssueList(raw, repo);
    // Empty page ends pagination. A short page may still be followed by an
    // empty one, so only stop on empty to avoid dropping a full tail page.
    if (batch.length === 0) break;
    issues.push(...batch);
    if (issues.length >= 250) break;
  }
  if (options.withBlockers) {
    const limit = Math.max(0, Math.min(200, Math.trunc(options.blockerReadLimit ?? DEFAULT_BLOCKER_READ_LIMIT)));
    const open = issues.filter((i) => i.state === "open").sort((a, b) => a.number - b.number).slice(0, limit);
    for (const issue of open) {
      const read = await fetchIssueDependencies({
        repo, number: issue.number, fetchFn, timeoutMs,
        ...(token === undefined ? {} : { token }),
      });
      // Only a complete graph read may claim a blocker count; anything else
      // stays unknown so the board never shows "ready" on a guess.
      if (read.status === "complete") issue.blockers = read.blockers;
    }
  }
  const fetchedAt = options.now ? options.now() : new Date().toISOString();
  return buildSnapshot(repo, issues, milestoneCounts, fetchedAt);
}

/** Human age for a fetchedAt ISO stamp. Never throws; unknown stays "unknown age". */
export function ageLine(fetchedAt: string, nowMs?: number): string {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return "unknown age";
  const now = nowMs ?? Date.now();
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

// ---- structured navigation reads ----
//
// The summary snapshot above is *display* data: `openIssues` is capped at ten
// per milestone and the compact rows are text. Navigation must never parse
// those rows or treat that capped list as the task set, so everything below
// issues its own bounded, explicit-page reads and returns structured objects.
// GET only, one page per user action, token never echoed into any output.

/** Rows per explicit navigation page. One user action reads exactly one page. */
export const ISSUE_PAGE_SIZE = 25;
/** Bounded issue body kept in a detail record; longer bodies set `bodyTruncated`. */
export const MAX_ISSUE_BODY_CHARS = 24_000;
/** Dependency reads are bounded; hitting the bound reports `incomplete`, never `complete`. */
const DEPENDENCY_PER_PAGE = 50;
const DEPENDENCY_MAX_PAGES = 4;
/** Label that marks a not-planned/superseded issue. Never a delivered one. */
export const RETIRED_LABEL = "resolution:retired";

/**
 * Control, C1 and bidi-formatting code points. Issue text is untrusted: a
 * title carrying RLO or a C1 CSI introducer must not reach a terminal as an
 * escape, and must not silently reorder what the operator reads before they
 * approve a request.
 */
const HOSTILE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
];

/** True for a C0/C1 control or a bidi/invisible formatting code point. */
function isHostileCode(code: number): boolean {
  for (const [low, high] of HOSTILE_RANGES) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

/**
 * Replace every hostile code point. Built from explicit ranges rather than a
 * regex literal so the source file itself stays free of the bytes it defends
 * against. Input is pre-bounded by the caller.
 */
function stripHostile(text: string, replacement: string): string {
  let out = "";
  for (const ch of text) {
    out += isHostileCode(ch.codePointAt(0) ?? 0) ? replacement : ch;
  }
  return out;
}

/** Single display line from untrusted text: no controls, no bidi, collapsed, bounded. */
export function sanitizeLine(text: unknown, max = 200): string {
  if (typeof text !== "string") return "";
  return stripHostile(text.slice(0, 100_000), " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, Math.trunc(max)));
}

/**
 * Multi-line body from untrusted text. Newlines survive (a body is prose the
 * operator reads before approving), every other control byte does not. The
 * truncation flag is explicit so nothing downstream can claim it read the
 * whole issue when it read the first 24k characters.
 */
export function sanitizeBody(text: unknown, max = MAX_ISSUE_BODY_CHARS): { text: string; truncated: boolean } {
  if (typeof text !== "string") return { text: "", truncated: false };
  const limit = Math.max(0, Math.trunc(max));
  // Pre-bound the scan itself; a body far past the budget is cut here and
  // still reports truncated even if stripping shrank it back under the cap.
  const scanned = limit * 4 + 1024;
  const overScan = text.length > scanned;
  const clean = stripHostile(
    text
      .slice(0, scanned)
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replaceAll("\t", "  "),
    "",
  );
  if (clean.length <= limit) return { text: clean, truncated: overScan };
  return { text: clean.slice(0, limit), truncated: true };
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Owner/repo path segment: no traversal, no slashes, no empty segment. */
function isSafeName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value) && value !== "." && value !== "..";
}

/** A positive, safely bounded issue index. Rejects 0, negatives and non-integers. */
export function isValidIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

/** Repo binding good enough to build an authenticated URL from. */
export function isValidTrackingRepo(repo: unknown): repo is TrackingRepo {
  if (typeof repo !== "object" || repo === null) return false;
  const r = repo as Record<string, unknown>;
  if (!isSafeName(r.owner) || !isSafeName(r.repo)) return false;
  if (typeof r.host !== "string" || r.host.length === 0 || r.host.length > 200) return false;
  try {
    const url = new URL(r.host);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Stable identity for a tracked issue: host + owner + repo + number.
 *
 * The repo half is bound from the tracking snapshot, never from an issue's
 * own `html_url`: a hostile or merely stale HTML URL must not be able to
 * repoint identity (or an authenticated fetch) at another repository.
 */
export function issueKey(repo: TrackingRepo, number: number): string {
  const host = repo.host.replace(/\/+$/, "");
  return `${host}|${repo.owner}|${repo.repo}|#${String(number)}`;
}

/** Canonical browse URL, built from the bound repo. Never issue-supplied. */
export function issueUrl(repo: TrackingRepo, number: number): string {
  return `${repo.host.replace(/\/+$/, "")}/${repo.owner}/${repo.repo}/issues/${String(number)}`;
}

export interface IssuePage {
  repo: TrackingRepo;
  /** 1-based page actually requested. */
  page: number;
  perPage: number;
  items: TrackedIssue[];
  /** True when the API returned a full page, so another page may exist. */
  hasMore: boolean;
  fetchedAt: string;
}

export interface IssueDependency {
  number: number;
  title: string;
  state: IssueState;
  /** `owner/repo` the dependency lives in; cross-repo dependencies are legal in Gitea. */
  repo: string;
}

/**
 * How much of the dependency graph was actually read.
 * `complete` is the only value that permits claiming an issue is unblocked.
 */
export type DependencyStatus = "complete" | "incomplete" | "unavailable";

export interface DependencyRead {
  status: DependencyStatus;
  items: IssueDependency[];
  /** Open dependencies: the native blockers. Not a parsed checklist. */
  blockers: number;
  /** Short human reason when the read was not complete. */
  reason: string;
}

export interface IssueDetail {
  key: string;
  repo: TrackingRepo;
  number: number;
  url: string;
  title: string;
  body: string;
  bodyTruncated: boolean;
  state: IssueState;
  labels: string[];
  milestone: string;
  updatedAt: string;
  fetchedAt: string;
  dependencies: DependencyRead;
}

export interface IssueReadOptions {
  repo: TrackingRepo;
  token?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => string;
}

export interface IssuePageOptions extends IssueReadOptions {
  /** 1-based. One user action reads exactly one page. */
  page: number;
  perPage?: number;
}

export interface IssueDetailOptions extends IssueReadOptions {
  number: number;
  /** Supply an already-read dependency state instead of reading it again. */
  dependencies?: DependencyRead;
}

function apiBase(repo: TrackingRepo): string {
  return `${repo.host.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/**
 * Gitea's issue endpoints return pull requests too when `type` is ignored by
 * an older deployment, so PR objects are filtered defensively rather than
 * trusted away by the query string alone.
 */
function withoutPullRequests(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const r = item as Record<string, unknown>;
    return r.pull_request === undefined || r.pull_request === null;
  });
}

/** One explicit page of issues. Throws Error(reason) on network/HTTP failure. */
export async function fetchIssuePage(options: IssuePageOptions): Promise<IssuePage> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const page = Math.max(1, Math.trunc(options.page));
  const perPage = Math.max(1, Math.min(50, Math.trunc(options.perPage ?? ISSUE_PAGE_SIZE)));
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const raw = await fetchJson(
    fetchFn,
    `${apiBase(repo)}/issues?state=all&type=issues&limit=${String(perPage)}&page=${String(page)}`,
    options.token,
    timeoutMs,
  );
  const rawCount = Array.isArray(raw) ? raw.length : 0;
  const items = toIssueList(withoutPullRequests(raw), repo);
  return {
    repo: repoIdentity(repo),
    page,
    perPage,
    items,
    // A full page from the API means another page may exist. Reported from the
    // raw count so filtering PRs out cannot hide a following page of issues.
    hasMore: rawCount >= perPage,
    fetchedAt: options.now ? options.now() : new Date().toISOString(),
  };
}

// ---- since-reads for Catch-Me-Up: bounded, GET only, token never echoed ----

export interface SinceReadOptions extends IssueReadOptions {
  /** ISO stamp; only items updated/created at or after it are read. */
  since: string;
  /** Pages of 50; default 3. */
  maxPages?: number;
}

export interface IssueComment {
  issue: number;
  author: string;
  createdAt: string;
  /** Sanitized single line, <= 200 chars. */
  excerpt: string;
}

export interface SinceRead<T> {
  items: T[];
  /** True when the page bound stopped the read before the API ran out. */
  truncated: boolean;
}

export const SINCE_PAGE_SIZE = 50;
export const SINCE_MAX_PAGES = 3;
export const SINCE_MAX_COMMENTS = 200;

/** Issue number from a Gitea/GitHub comment: `issue_url`/`html_url` ends in `/issues/<n>`. */
export function commentIssueNumber(raw: Record<string, unknown>): number | undefined {
  for (const key of ["issue_url", "html_url"]) {
    const url = raw[key];
    if (typeof url !== "string") continue;
    const m = /\/issues\/(\d{1,7})(?:#|$)/.exec(url);
    if (m) {
      const n = Number(m[1]);
      if (isValidIssueNumber(n)) return n;
    }
  }
  return undefined;
}

/** Shared comment shaping for both adapters: sanitized, bounded, issue bound from the URL. */
export function toIssueComments(raw: unknown): IssueComment[] {
  if (!Array.isArray(raw)) return [];
  const out: IssueComment[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const issue = commentIssueNumber(r);
    if (issue === undefined) continue;
    const login = typeof r.user === "object" && r.user !== null ? (r.user as Record<string, unknown>).login : undefined;
    out.push({
      issue,
      author: sanitizeLine(typeof login === "string" ? login : "", 60),
      createdAt: sanitizeLine(typeof r.created_at === "string" ? r.created_at : "", 40),
      excerpt: sanitizeLine(typeof r.body === "string" ? r.body : "", 200),
    });
  }
  return out;
}

/** Issues updated since `since`, newest-updated first, at most `maxPages` × 50. */
export async function fetchIssuesSince(options: SinceReadOptions): Promise<SinceRead<TrackedIssue>> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxPages = Math.max(1, Math.min(SINCE_MAX_PAGES, Math.trunc(options.maxPages ?? SINCE_MAX_PAGES)));
  const since = encodeURIComponent(options.since);
  const items: TrackedIssue[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchJson(
      fetchFn,
      `${apiBase(repo)}/issues?state=all&type=issues&since=${since}&sort=updated&limit=${String(SINCE_PAGE_SIZE)}&page=${String(page)}`,
      options.token,
      timeoutMs,
    );
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    items.push(...toIssueList(withoutPullRequests(raw), repo));
    if (rawCount < SINCE_PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

/** Repository-wide issue comments since `since`, at most 200. */
export async function fetchCommentsSince(options: SinceReadOptions): Promise<SinceRead<IssueComment>> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxPages = Math.max(1, Math.min(Math.ceil(SINCE_MAX_COMMENTS / SINCE_PAGE_SIZE), Math.trunc(options.maxPages ?? SINCE_MAX_PAGES)));
  const since = encodeURIComponent(options.since);
  const items: IssueComment[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchJson(
      fetchFn,
      `${apiBase(repo)}/issues/comments?since=${since}&limit=${String(SINCE_PAGE_SIZE)}&page=${String(page)}`,
      options.token,
      timeoutMs,
    );
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    items.push(...toIssueComments(raw));
    if (rawCount < SINCE_PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return { items: items.slice(0, SINCE_MAX_COMMENTS), truncated: truncated || items.length > SINCE_MAX_COMMENTS };
}

function toDependency(raw: unknown, fallbackRepo: TrackingRepo): IssueDependency | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isValidIssueNumber(r.number)) return undefined;
  const state: IssueState | undefined = r.state === "open" ? "open" : r.state === "closed" ? "closed" : undefined;
  if (state === undefined) return undefined;
  let repoName = `${fallbackRepo.owner}/${fallbackRepo.repo}`;
  const repoField = r.repository;
  if (typeof repoField === "object" && repoField !== null) {
    const rr = repoField as Record<string, unknown>;
    const full = typeof rr.full_name === "string" ? rr.full_name : undefined;
    if (full !== undefined && /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(full)) repoName = full;
  }
  return { number: r.number, title: sanitizeLine(r.title, 120), state, repo: repoName };
}

function openBlockers(items: readonly IssueDependency[]): number {
  return items.filter((d) => d.state === "open").length;
}

/**
 * Native issue dependencies (Gitea `/issues/{index}/dependencies`): the issues
 * this one depends on. Never throws — an unreadable graph reports
 * `unavailable`, because "we could not read the blockers" must never be
 * rendered as "there are no blockers".
 */
export async function fetchIssueDependencies(
  options: IssueReadOptions & { number: number; maxPages?: number; perPage?: number },
): Promise<DependencyRead> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo) || !isValidIssueNumber(options.number)) {
    return { status: "unavailable", items: [], blockers: 0, reason: "invalid issue reference" };
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const perPage = Math.max(1, Math.min(50, Math.trunc(options.perPage ?? DEPENDENCY_PER_PAGE)));
  const maxPages = Math.max(1, Math.min(10, Math.trunc(options.maxPages ?? DEPENDENCY_MAX_PAGES)));
  const items: IssueDependency[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    let raw: unknown;
    try {
      raw = await fetchJson(
        fetchFn,
        `${apiBase(repo)}/issues/${String(options.number)}/dependencies?limit=${String(perPage)}&page=${String(page)}`,
        options.token,
        timeoutMs,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 120) : "read failed";
      return { status: "unavailable", items, blockers: openBlockers(items), reason: detail };
    }
    if (!Array.isArray(raw)) {
      return { status: "unavailable", items, blockers: openBlockers(items), reason: "unexpected dependency payload" };
    }
    for (const entry of raw) {
      const dep = toDependency(entry, repo);
      if (!dep) {
        // A dependency we cannot parse is a dependency we cannot clear.
        return { status: "incomplete", items, blockers: openBlockers(items), reason: "unreadable dependency entry" };
      }
      const key = `${dep.repo}#${String(dep.number)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(dep);
    }
    if (raw.length < perPage) {
      return { status: "complete", items, blockers: openBlockers(items), reason: "" };
    }
  }
  return {
    status: "incomplete",
    items,
    blockers: openBlockers(items),
    reason: `more than ${String(maxPages * perPage)} dependencies; read bounded`,
  };
}

/**
 * Validate one raw Gitea issue object into a detail record.
 *
 * Strict on purpose: a missing or unrecognized `state`, a missing
 * `updated_at`, or a number that does not match the one requested makes the
 * detail *unavailable* (undefined). Defaulting any of those to "open" would
 * let an unreadable issue look like runnable work.
 */
export function parseIssueDetail(
  raw: unknown,
  repo: TrackingRepo,
  number: number,
  dependencies: DependencyRead,
  fetchedAt: string,
): IssueDetail | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!isValidTrackingRepo(repo) || !isValidIssueNumber(number)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.pull_request !== undefined && r.pull_request !== null) return undefined;
  if (!isValidIssueNumber(r.number) || r.number !== number) return undefined;
  const state: IssueState | undefined = r.state === "open" ? "open" : r.state === "closed" ? "closed" : undefined;
  if (state === undefined) return undefined;
  const updatedRaw = typeof r.updated_at === "string" ? r.updated_at : "";
  if (updatedRaw.length === 0 || Number.isNaN(Date.parse(updatedRaw))) return undefined;
  const title = sanitizeLine(r.title, 200);
  if (title.length === 0) return undefined;
  const body = sanitizeBody(r.body);
  const labels: string[] = Array.isArray(r.labels)
    ? r.labels
      .map((l) => {
        if (typeof l === "string") return sanitizeLine(l, 60);
        if (typeof l === "object" && l !== null) return sanitizeLine((l as Record<string, unknown>).name, 60);
        return "";
      })
      .filter((l) => l.length > 0)
      .slice(0, 24)
    : [];
  let milestone = NO_MILESTONE;
  if (typeof r.milestone === "object" && r.milestone !== null) {
    const clean = sanitizeLine((r.milestone as Record<string, unknown>).title, 80);
    if (clean.length > 0) milestone = clean;
  }
  return {
    key: issueKey(repo, number),
    repo: repoIdentity(repo),
    number,
    url: issueUrl(repo, number),
    title,
    body: body.text,
    bodyTruncated: body.truncated,
    state,
    labels,
    milestone,
    updatedAt: new Date(updatedRaw).toISOString(),
    fetchedAt,
    dependencies,
  };
}

/**
 * One issue plus its native dependency state. Throws Error(reason) on
 * network/HTTP failure; returns undefined when the payload is malformed
 * (unavailable, not "open").
 */
export async function fetchIssueDetail(options: IssueDetailOptions): Promise<IssueDetail | undefined> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  if (!isValidIssueNumber(options.number)) throw new Error("invalid issue number");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const raw = await fetchJson(
    fetchFn,
    `${apiBase(repo)}/issues/${String(options.number)}`,
    options.token,
    timeoutMs,
  );
  const dependencies =
    options.dependencies ??
    (await fetchIssueDependencies({
      repo,
      number: options.number,
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    }));
  const fetchedAt = options.now ? options.now() : new Date().toISOString();
  return parseIssueDetail(raw, repo, options.number, dependencies, fetchedAt);
}

/** True when the issue carries the not-planned/superseded label. */
export function isRetired(labels: readonly string[]): boolean {
  return labels.some((label) => label.trim().toLowerCase() === RETIRED_LABEL);
}

/**
 * Fields that must be re-checked before a request is prepared. Any change
 * means the operator reviewed something else and has to look again.
 */
export function detailSignature(detail: IssueDetail): string {
  const deps = detail.dependencies;
  return [
    detail.key,
    detail.state,
    detail.updatedAt,
    detail.title,
    String(detail.body.length),
    detail.bodyTruncated ? "t" : "f",
    [...detail.labels].sort().join(","),
    deps.status,
    String(deps.blockers),
    deps.items.map((d) => `${d.repo}#${String(d.number)}:${d.state}`).sort().join(","),
  ].join("|");
}
