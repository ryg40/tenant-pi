/**
 * Workboard (companion tracking region): pure classification of open tracked
 * issues into status buckets, plus the ordered row list the view renders.
 *
 * Everything here derives from `TrackedIssue` fields only. Nothing parses a
 * display string, reads the clock, or touches the network. Returned values are
 * deeply frozen. `blockers === undefined` is *unknown*, never "clear".
 */
import {
  NO_MILESTONE,
  sanitizeLine,
  snapshotOpenIssues,
  type TrackedIssue,
  type TrackingSnapshot,
} from "./gitea.mts";

export type WorkStatus = "active" | "ready" | "review" | "blocked" | "later" | "unknown";
export const WORK_STATUS_ORDER: readonly WorkStatus[] = Object.freeze([
  "active",
  "ready",
  "review",
  "blocked",
  "later",
  "unknown",
] as const);

export interface BoardIssue {
  readonly number: number;
  readonly title: string;
  readonly status: WorkStatus;
  readonly priority: "P1" | "P2" | "P3" | "";
  readonly assignee: string;
  readonly blockers: number | undefined;
  readonly mapNumber: number | undefined;
  readonly labels: readonly string[];
  readonly milestone: string;
  readonly url: string;
  readonly updatedAt: string;
}

/**
 * Board rows form a tree, not a flat list:
 *
 * - `map` rows are Wayfinder maps; their children follow immediately at
 *   `depth: 1`. Hierarchy is the `wayfinder:parent:<n>` label, which is
 *   *membership*, never a blocking dependency: `blockers` alone says blocked.
 * - a `section` row separates free-standing issues (no open map claims them)
 *   from the maps, so nothing is omitted for lacking map membership.
 * - `heading` rows bucket free-standing issues by status, as before.
 */
export type BoardRow =
  | {
      readonly kind: "map";
      readonly number: number;
      readonly title: string;
      readonly childCount: number;
      readonly counts: Readonly<Record<WorkStatus, number>>;
    }
  | { readonly kind: "section"; readonly label: string; readonly count: number }
  | { readonly kind: "heading"; readonly status: WorkStatus; readonly count: number }
  | { readonly kind: "issue"; readonly issue: BoardIssue; readonly depth: 0 | 1 };

export const FREE_STANDING_LABEL = "FREE-STANDING";

export interface WorkBoard {
  readonly version: 1;
  /** Tracker provider the snapshot came from; absent on older caches. */
  readonly provider?: string;
  readonly repoLabel: string;
  readonly fetchedAt: string;
  readonly openCount: number;
  readonly counts: Readonly<Record<WorkStatus, number>>;
  readonly rows: readonly BoardRow[];
  readonly summary: string;
}

const MAP_LABEL = "wayfinder:map";
const REVIEW_LABEL = "status:needs-review";
const LATER_LABELS: readonly string[] = ["route:follow-up", "scope:later"];
const PARENT_RE = /^wayfinder:parent:(\d{1,9})$/;
const PRIORITY_RE = /^priority:(P[123])$/;
const PRIORITY_RANK: Record<BoardIssue["priority"], number> = { P1: 0, P2: 1, P3: 2, "": 3 };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

function emptyCounts(): Record<WorkStatus, number> {
  return { active: 0, ready: 0, review: 0, blocked: 0, later: 0, unknown: 0 };
}

function isMap(issue: TrackedIssue): boolean {
  return issue.labels.includes(MAP_LABEL);
}

/** Status of one open, non-map issue. Precedence is fixed; see the module note. */
export function classifyIssue(issue: TrackedIssue): WorkStatus {
  if (issue.labels.includes(REVIEW_LABEL)) return "review";
  if (typeof issue.assignee === "string" && issue.assignee.length > 0) return "active";
  const blockers = issue.blockers;
  if (typeof blockers === "number" && blockers > 0) return "blocked";
  if (issue.labels.some((l) => LATER_LABELS.includes(l))) return "later";
  if (blockers === 0) return "ready";
  return "unknown";
}

function priorityOf(labels: readonly string[]): BoardIssue["priority"] {
  for (const label of labels) {
    const m = PRIORITY_RE.exec(label);
    if (m) return m[1] as BoardIssue["priority"];
  }
  return "";
}

function mapNumberOf(labels: readonly string[]): number | undefined {
  for (const label of labels) {
    const m = PARENT_RE.exec(label);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return undefined;
}

export function toBoardIssue(issue: TrackedIssue): BoardIssue {
  const labels = issue.labels.map((l) => sanitizeLine(l, 60)).filter((l) => l.length > 0);
  return deepFreeze<BoardIssue>({
    number: issue.number,
    title: sanitizeLine(issue.title, 200),
    status: classifyIssue(issue),
    priority: priorityOf(labels),
    assignee: typeof issue.assignee === "string" ? sanitizeLine(issue.assignee, 40) : "",
    blockers: typeof issue.blockers === "number" && issue.blockers >= 0 ? issue.blockers : undefined,
    mapNumber: mapNumberOf(labels),
    labels,
    milestone: issue.milestone.length > 0 ? sanitizeLine(issue.milestone, 100) : NO_MILESTONE,
    url: typeof issue.url === "string" ? issue.url : "",
    updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : "",
  });
}

/** `17 open · 3 active · 2 ready · 4 review · 1 blocked · 7 later`; zero buckets omitted. */
export function boardSummary(counts: Readonly<Record<WorkStatus, number>>, openCount: number): string {
  const parts = [`${String(openCount)} open`];
  for (const status of WORK_STATUS_ORDER) {
    const n = counts[status];
    if (n > 0) parts.push(`${String(n)} ${status}`);
  }
  return parts.join(" · ");
}

function compareIssues(a: BoardIssue, b: BoardIssue): number {
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : a.number - b.number;
}

export function buildWorkBoard(snapshot: TrackingSnapshot): WorkBoard {
  const open = snapshotOpenIssues(snapshot).filter((i) => i.state === "open");
  const maps = open.filter(isMap).sort((a, b) => a.number - b.number);
  const issues = open.filter((i) => !isMap(i)).map(toBoardIssue);

  const counts = emptyCounts();
  for (const issue of issues) counts[issue.status] += 1;

  const rows: BoardRow[] = [];
  const openMapNumbers = new Set(maps.map((m) => m.number));
  const claimed = new Set<number>();
  for (const map of maps) {
    // Children in status order, then priority, then number: the same reading
    // order as the free-standing buckets, so a map reads like a small board.
    const children = issues
      .filter((i) => i.mapNumber === map.number)
      .sort((a, b) => WORK_STATUS_ORDER.indexOf(a.status) - WORK_STATUS_ORDER.indexOf(b.status) || compareIssues(a, b));
    const mapCounts = emptyCounts();
    for (const child of children) mapCounts[child.status] += 1;
    rows.push({
      kind: "map",
      number: map.number,
      title: sanitizeLine(map.title, 200),
      childCount: children.length,
      counts: mapCounts,
    });
    for (const child of children) {
      claimed.add(child.number);
      rows.push({ kind: "issue", issue: child, depth: 1 });
    }
  }
  // Free-standing: no open map claims the issue. A `wayfinder:parent` label
  // pointing at a closed or unknown map still lands here rather than vanishing.
  const free = issues.filter((i) => !claimed.has(i.number) && (i.mapNumber === undefined || !openMapNumbers.has(i.mapNumber)));
  if (maps.length > 0 && free.length > 0) rows.push({ kind: "section", label: FREE_STANDING_LABEL, count: free.length });
  for (const status of WORK_STATUS_ORDER) {
    const bucket = free.filter((i) => i.status === status).sort(compareIssues);
    if (bucket.length === 0) continue;
    rows.push({ kind: "heading", status, count: bucket.length });
    for (const issue of bucket) rows.push({ kind: "issue", issue, depth: 0 });
  }

  const openCount = snapshot.overall.open;
  const provider = snapshot.repo.provider;
  return deepFreeze<WorkBoard>({
    version: 1,
    ...(provider === undefined ? {} : { provider }),
    repoLabel: `${snapshot.repo.owner}/${snapshot.repo.repo}`,
    fetchedAt: snapshot.fetchedAt,
    openCount,
    counts,
    rows,
    summary: boardSummary(counts, openCount),
  });
}
