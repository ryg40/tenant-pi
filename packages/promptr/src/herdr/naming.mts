import { createHash } from "node:crypto";

export type HerdrRole = "coordinator" | "researcher" | "planner" | "reviewer" | "worker" | "generator";

export interface HerdrWorkspaceNameInput {
  id: string;
  label?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one complete, bounded `herdr workspace list` response. */
export function parseHerdrWorkspaceList(stdout: string, limit = 64): HerdrWorkspaceNameInput[] | undefined {
  let root: unknown;
  try { root = JSON.parse(stdout); } catch { return undefined; }
  if (!isRecord(root) || "error" in root || !isRecord(root.result)) return undefined;
  const raw = root.result.workspaces;
  if (!Array.isArray(raw) || raw.length > limit) return undefined;
  const workspaces: HerdrWorkspaceNameInput[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.workspace_id !== "string" || ids.has(item.workspace_id)) return undefined;
    const label = typeof item.label === "string" ? item.label : undefined;
    ids.add(item.workspace_id);
    workspaces.push({ id: item.workspace_id, ...(label === undefined ? {} : { label }) });
  }
  return workspaces;
}

const SUFFIX: Readonly<Record<HerdrRole, string>> = Object.freeze({
  coordinator: "coord",
  researcher: "resea",
  planner: "plan",
  reviewer: "revie",
  worker: "work",
  generator: "gener",
});

function hash(value: string, length = 5): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Human workspace prefix; `promptr` deliberately shortens to `prompt`. */
export function workspacePrefix(label: string): string | undefined {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || !/^[a-z]/.test(normalized)) return undefined;
  if (normalized === "promptr") return "prompt";
  return normalized;
}

/**
 * Deterministic, valid Herdr tracking name. The complete bounded workspace
 * list disambiguates labels that normalize/shorten alike; without it an
 * opaque-ID hash is always included so two unknown workspaces are not guessed
 * to be the same.
 */
export function herdrRoleName(
  workspace: HerdrWorkspaceNameInput,
  role: HerdrRole,
  liveWorkspaces?: readonly HerdrWorkspaceNameInput[],
): string {
  const suffix = SUFFIX[role];
  const natural = workspace.label ? workspacePrefix(workspace.label) : undefined;
  const maxPrefix = 32 - suffix.length - 1;
  let prefix = natural?.slice(0, maxPrefix);
  const completeList = liveWorkspaces !== undefined;
  const collision = prefix !== undefined && completeList && liveWorkspaces.some((other) => {
    if (other.id === workspace.id || !other.label) return false;
    return workspacePrefix(other.label)?.slice(0, maxPrefix) === prefix;
  });
  if (!prefix || !completeList || collision || (natural?.length ?? 0) > maxPrefix) {
    const idHash = hash(workspace.id);
    const base = prefix ?? "workspace";
    prefix = `${base.slice(0, Math.max(1, maxPrefix - idHash.length - 1))}-${idHash}`;
  }
  const name = `${prefix}-${suffix}`.slice(0, 32);
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : `workspace-${hash(workspace.id)}-${suffix}`.slice(0, 32);
}

/** Use the live human label when the bounded list is valid; otherwise fail closed to the opaque-ID name. */
export function herdrRoleNameFromList(workspaceId: string, role: HerdrRole, stdout: string | undefined): string {
  const live = stdout === undefined ? undefined : parseHerdrWorkspaceList(stdout);
  const workspace = live?.find((item) => item.id === workspaceId);
  return workspace ? herdrRoleName(workspace, role, live) : herdrRoleName({ id: workspaceId }, role);
}
