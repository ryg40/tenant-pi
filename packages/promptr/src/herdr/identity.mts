/**
 * Shared validation for opaque Herdr identifiers.
 *
 * Herdr workspace, tab and pane suffixes are alphanumeric. Do not assume a
 * numeric workspace (live examples include `wR`, `wR:t1` and `wR:p1`).
 */
const WORKSPACE_ID_RE = /w[A-Za-z0-9]+/;
const TAB_ID_RE = /w[A-Za-z0-9]+:t[A-Za-z0-9]+/;
const PANE_ID_RE = /w[A-Za-z0-9]+:p[A-Za-z0-9]+/;

/** RegExp `$` accepts a final newline in JavaScript; compare the full match instead. */
function matchesExactly(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && value.match(pattern)?.[0] === value;
}

export function isHerdrWorkspaceId(value: unknown): value is string {
  return matchesExactly(WORKSPACE_ID_RE, value);
}

export function isHerdrTabId(value: unknown): value is string {
  return matchesExactly(TAB_ID_RE, value);
}

export function isHerdrPaneId(value: unknown): value is string {
  return matchesExactly(PANE_ID_RE, value);
}

/** Workspace prefix carried by a valid pane id. */
export function herdrWorkspaceFromPaneId(value: unknown): string | undefined {
  if (!isHerdrPaneId(value)) return undefined;
  return value.slice(0, value.indexOf(":"));
}

/** Require both a valid pane id and the exact expected workspace. */
export function isHerdrPaneInWorkspace(value: unknown, workspace: unknown): value is string {
  return isHerdrWorkspaceId(workspace)
    && isHerdrPaneId(value)
    && herdrWorkspaceFromPaneId(value) === workspace;
}
