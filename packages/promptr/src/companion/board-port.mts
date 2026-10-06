/**
 * Structural copy of the workboard contract.
 *
 * The data module (src/tracking/board.mts) is the authority on these shapes; the
 * view only needs their structure, so it declares them here and never imports
 * the builder. Display data only: the view never mutates a board. Which map
 * groups are folded is state of the view, not a field of these shapes.
 */
export type WorkStatus = "active" | "ready" | "review" | "blocked" | "later" | "unknown";

export const WORK_STATUS_ORDER: readonly WorkStatus[] = ["active", "ready", "review", "blocked", "later", "unknown"];

export interface BoardIssue {
  readonly number: number;
  /** Sanitized single line, <= 200 chars. */
  readonly title: string;
  readonly status: WorkStatus;
  readonly priority: "P1" | "P2" | "P3" | "";
  /** "" when unassigned. */
  readonly assignee: string;
  /** undefined = dependency graph not read (unknown, NOT clear). */
  readonly blockers: number | undefined;
  /** From label `wayfinder:parent:<n>`. */
  readonly mapNumber: number | undefined;
  readonly labels: readonly string[];
  /** NO_MILESTONE ("No milestone") when none. */
  readonly milestone: string;
  readonly url: string;
  /** ISO or "". */
  readonly updatedAt: string;
}

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
  /** `depth` 1 = child of the preceding map row; absent/0 = free-standing. */
  | { readonly kind: "issue"; readonly issue: BoardIssue; readonly depth?: 0 | 1 };

export interface WorkBoard {
  readonly version: 1;
  /** Tracker provider ("gitea" | "github"); absent on older caches. */
  readonly provider?: string;
  /** "owner/repo" */
  readonly repoLabel: string;
  /** ISO from the snapshot. */
  readonly fetchedAt: string;
  /** snapshot.overall.open */
  readonly openCount: number;
  readonly counts: Readonly<Record<WorkStatus, number>>;
  readonly rows: readonly BoardRow[];
  /** e.g. "17 open · 3 active · 2 ready · 4 review · 1 blocked · 7 later" */
  readonly summary: string;
}
