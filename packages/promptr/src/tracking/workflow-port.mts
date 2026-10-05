/**
 * Structural port for the workflow catalog, declared here so the
 * tracking navigation can build, type-check and test against the frozen
 * shape without importing the catalog implementation.
 *
 * These declarations are *structurally identical* to the ones the catalog
 * module exports. Nothing here knows the role matrix, the provider list, or
 * how a template expands: this module renders whatever a port returns and says
 * "unavailable" when no port is injected. Inventing a fallback matrix here
 * would show the operator a workflow the product does not actually have.
 *
 * Pure types plus two runtime helpers. No process/env/fs/network/Pi imports.
 */

export interface WorkflowChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface WorkflowRole {
  readonly role: "coordinator" | "scout" | "researcher" | "worker" | "reviewer" | "generator";
  readonly provider: string;
  readonly model: string;
  readonly thinking: "low" | "medium" | "high" | "xhigh";
  readonly route: "pi" | "herdr-claude";
}

/**
 * How delegated roles are executed. `pi-subagents` is the integrated
 * `subagent` tool (headless async runs); `herdr-native` starts one
 * interactive Pi session per role in a visible Herdr tab that the user can
 * watch, type into and retarget with `/model` mid-run.
 */
export type WorkflowExecution = "pi-subagents" | "herdr-native";

export const DEFAULT_WORKFLOW_EXECUTION: WorkflowExecution = "pi-subagents";

/** Picker choices for the execution step. Presentation only; the catalog validates the id. */
export const WORKFLOW_EXECUTIONS: readonly (WorkflowChoice & { readonly id: WorkflowExecution })[] = Object.freeze([
  Object.freeze({
    id: "pi-subagents",
    label: "Pi subagents (integrated)",
    description: "Delegated roles run headless through the pi-subagents `subagent` tool: async runs, workflow scripts, structured output.",
  }),
  Object.freeze({
    id: "herdr-native",
    label: "Herdr native sessions",
    description: "Each delegated role is a full interactive Pi in its own Herdr tab: watch it, type into it, switch its model with /model when a quota stop hits.",
  }),
]);

export interface WorkflowExpansion {
  /** Frozen provenance: deleting an override cannot remove its launch gate. */
  readonly requiresCapabilityProbe?: boolean;
  readonly version: 1;
  readonly template: string;
  readonly provider: string;
  /** Absent in packets saved before the execution step existed: read as `pi-subagents`. */
  readonly execution?: WorkflowExecution;
  readonly roles: readonly WorkflowRole[];
  readonly instructions: readonly string[];
  readonly warnings: readonly string[];
}

export type WorkflowResult =
  | { readonly ok: true; readonly value: WorkflowExpansion }
  | { readonly ok: false; readonly error: string };

export interface WorkflowInput {
  readonly template: string;
  readonly provider: string;
  readonly readiness: "ready" | "unresolved-design" | "unknown";
  /** Omitted means `pi-subagents`, so every existing caller keeps its behaviour. */
  readonly execution?: WorkflowExecution;
}

export interface WorkflowCatalogPort {
  listWorkflows(): readonly WorkflowChoice[];
  listProviders(): readonly WorkflowChoice[];
  expandWorkflow(input: WorkflowInput): WorkflowResult;
}

/**
 * Display order for roles. The catalog owns the same order; this copy exists
 * so the preview renders deterministically even if a port hands back roles in
 * another order. It is presentation only and assigns no model to any role.
 */
export const WORKFLOW_ROLE_ORDER: readonly WorkflowRole["role"][] = Object.freeze([
  "coordinator",
  "scout",
  "researcher",
  "worker",
  "reviewer",
  "generator",
] as const);

/** Shown wherever a workflow would be, when no catalog port was injected. */
export const CATALOG_UNAVAILABLE =
  "Workflow catalog unavailable — no catalog injected. Nothing generated, nothing sent.";

/**
 * Runtime shape check. TypeScript cannot police an injected object that came
 * from a host wiring step, and a half-wired port must fail visibly rather
 * than throw mid-preview.
 */
export function isWorkflowCatalogPort(value: unknown): value is WorkflowCatalogPort {
  if (typeof value !== "object" || value === null) return false;
  const port = value as Record<string, unknown>;
  return (
    typeof port.listWorkflows === "function" &&
    typeof port.listProviders === "function" &&
    typeof port.expandWorkflow === "function"
  );
}

/** Stable presentation order for a preview. Never adds or drops a role. */
export function orderRoles(roles: readonly WorkflowRole[]): readonly WorkflowRole[] {
  const rank = new Map(WORKFLOW_ROLE_ORDER.map((role, index) => [role, index]));
  return [...roles].sort((a, b) => (rank.get(a.role) ?? 99) - (rank.get(b.role) ?? 99));
}

/** One display row per role: `coordinator · example-provider/example-model · low · pi`. */
export function describeRole(role: WorkflowRole): string {
  return `${role.role} · ${role.provider}/${role.model} · ${role.thinking} · ${role.route}`;
}
