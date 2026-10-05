/**
 * Workflow catalog — the Generate Prompt role matrix.
 *
 * This module is the single source of the named workflow templates the
 * companion offers after a task is selected. It is deliberately inert:
 *
 * - Pure functions only. No process/env, filesystem, network, child
 *   processes or Pi APIs. Expanding a workflow launches nothing and
 *   sends nothing; it describes a prompt template.
 * - Provider/model/thinking values are *static candidates* taken from
 *   provider source. They are not runtime auth qualification, so
 *   every expansion carries an explicit "runtime unverified" warning.
 * - Runtime availability is a separate, explicit step:
 *   `validateWorkflowCapabilities`. A missing capability list is a
 *   visible failure, never implicit all-supported.
 * - Inputs are validated at runtime even though they are typed: the
 *   caller is a TUI reading untrusted selections, not a compiler.
 *
 * Returned data is deeply frozen and serialization is stable (no
 * timestamps, no randomness), so a preview can be diffed and a packet
 * can be attributed.
 */

export type WorkflowRoleName =
  | "coordinator" | "scout" | "researcher" | "worker" | "reviewer" | "generator";
export type WorkflowThinking = "low" | "medium" | "high" | "xhigh";
export type WorkflowRoute = "pi" | "herdr-claude";
export type WorkflowReadiness = "ready" | "unresolved-design" | "unknown";
/** Structurally identical to `tracking/workflow-port.mts`; this module imports nothing. */
export type WorkflowExecution = "pi-subagents" | "herdr-native";

export interface WorkflowChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface WorkflowRole {
  readonly role: WorkflowRoleName;
  readonly provider: string;
  readonly model: string;
  readonly thinking: WorkflowThinking;
  readonly route: WorkflowRoute;
}

export interface WorkflowExpansion {
  readonly version: 1;
  readonly template: string;
  readonly provider: string;
  /** Absent in older packets: read as `pi-subagents`. */
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
  readonly readiness: WorkflowReadiness;
  /** Omitted means `pi-subagents`. */
  readonly execution?: WorkflowExecution;
}

/**
 * One runtime-discovered capability. `thinking` is the set of levels the
 * provider/model/route actually accepts. Matching is exact: no aliasing,
 * no "close enough" model families, no auth inference.
 */
export interface WorkflowCapability {
  readonly provider: string;
  readonly model: string;
  readonly thinking: readonly string[];
  readonly route: WorkflowRoute;
}

export interface WorkflowCatalogPort {
  listWorkflows(): readonly WorkflowChoice[];
  listProviders(): readonly WorkflowChoice[];
  expandWorkflow(input: WorkflowInput): WorkflowResult;
}

/*
 * Pre-authorized provider quota fallback. Shared with the
 * configured catalog so both emit the same line for the same provider list.
 * Only the quota case is pre-authorized: the fallback is the next provider in
 * picker order with the same model and thinking level; a single-provider list
 * yields an explicit "no fallback" line so the absence stays visible.
 */

/** Stable prefix so a catalog consumer can recognise and recompute the line. */
export const QUOTA_FALLBACK_PREFIX = "Provider quota fallback (pre-authorized):";

const NO_FALLBACK_SUFFIX =
  " no fallback provider is configured; a usage-limit or quota error is a stop condition to report to the user.";

/**
 * The fallback provider for `selected`: the next entry in `providers` order,
 * wrapping around. `undefined` when there is no other provider.
 */
export function quotaFallbackProvider(
  selected: string, providers: readonly string[],
): string | undefined {
  const at = providers.indexOf(selected);
  if (at < 0) return providers.find((id) => id !== selected);
  for (let step = 1; step < providers.length; step += 1) {
    const candidate = providers[(at + step) % providers.length];
    if (candidate !== undefined && candidate !== selected) return candidate;
  }
  return undefined;
}

export function quotaFallbackInstruction(selected: string, providers: readonly string[]): string {
  const fallback = quotaFallbackProvider(selected, providers);
  if (fallback === undefined) return `${QUOTA_FALLBACK_PREFIX}${NO_FALLBACK_SUFFIX}`;
  return `${QUOTA_FALLBACK_PREFIX} when a Pi-route role fails with a usage-limit or quota error, `
    + `relaunch that role on ${fallback} with the same model and thinking level, record the switch in its report, `
    + "and continue without asking. This is the only pre-authorized runtime change; roles on other routes stop.";
}

/** True for the line `quotaFallbackInstruction` produced, whatever its provider. */
export function isQuotaFallbackInstruction(line: string): boolean {
  return line.startsWith(QUOTA_FALLBACK_PREFIX);
}

/** Static candidates taken from provider source, not availability. */
const MODEL_SOL = "gpt-5.6-sol";
const MODEL_LUNA = "gpt-5.6-luna";
const MODEL_ASTRA = "gpt-6-astra";
const CLAUDE_PROVIDER = "anthropic";
const CLAUDE_WORKER_MODEL = "claude-opus-5";
const CLAUDE_REVIEWER_MODEL = "claude-sonnet-5";

/** Role order is stable everywhere: preview, serialization and packets. */
const ROLE_ORDER: readonly WorkflowRoleName[] = [
  "coordinator", "scout", "researcher", "worker", "reviewer", "generator",
];

const READINESS_VALUES: readonly WorkflowReadiness[] = ["ready", "unresolved-design", "unknown"];
const EXECUTION_VALUES: readonly WorkflowExecution[] = ["pi-subagents", "herdr-native"];
const DEFAULT_EXECUTION: WorkflowExecution = "pi-subagents";

const PROVIDERS: readonly WorkflowChoice[] = [
  {
    id: "openai-codex",
    label: "openai-codex",
    description: "Primary OpenAI provider for every OpenAI role, including the generator.",
  },
  {
    id: "openai-codex-2",
    label: "openai-codex-2",
    description: "Second OpenAI provider (its own custom extension) for every OpenAI role.",
  },
];

/**
 * A role slot before the OpenAI provider is bound. Claude slots carry
 * their own provider and never redirect through the OpenAI selection.
 */
interface RoleSpec {
  readonly role: WorkflowRoleName;
  readonly model: string;
  readonly thinking: WorkflowThinking;
  readonly herdrClaude: boolean;
}

interface TemplateSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Simple is for well-developed tasks only: an unresolved design is an error. */
  readonly requiresResolvedDesign: boolean;
  readonly roles: readonly RoleSpec[];
}

function pi(role: WorkflowRoleName, model: string, thinking: WorkflowThinking): RoleSpec {
  return { role, model, thinking, herdrClaude: false };
}

function claude(role: WorkflowRoleName, model: string, thinking: WorkflowThinking): RoleSpec {
  return { role, model, thinking, herdrClaude: true };
}

/** Evidence stages are identical across templates; only the tiers move. */
const EVIDENCE_ROLES: readonly RoleSpec[] = [
  pi("scout", MODEL_LUNA, "xhigh"),
  pi("researcher", MODEL_LUNA, "xhigh"),
];

/** The generator is fixed: selected OpenAI provider, Sol medium, Pi route. */
const GENERATOR_ROLE: RoleSpec = pi("generator", MODEL_SOL, "medium");

const TEMPLATES: readonly TemplateSpec[] = [
  {
    id: "openai-codex-simple",
    label: "OpenAI Codex — simple",
    description: "Well-developed Wayfinder task. Sol xhigh coordinator, Sol medium worker.",
    requiresResolvedDesign: true,
    roles: [
      pi("coordinator", MODEL_SOL, "xhigh"),
      ...EVIDENCE_ROLES,
      pi("worker", MODEL_SOL, "medium"),
      pi("reviewer", MODEL_LUNA, "xhigh"),
    ],
  },
  {
    id: "openai-codex-medium",
    label: "OpenAI Codex — medium",
    description: "Astra low coordinator for design work, Sol medium worker.",
    requiresResolvedDesign: false,
    roles: [
      pi("coordinator", MODEL_ASTRA, "low"),
      ...EVIDENCE_ROLES,
      pi("worker", MODEL_SOL, "medium"),
      pi("reviewer", MODEL_LUNA, "xhigh"),
    ],
  },
  {
    id: "openai-codex-high",
    label: "OpenAI Codex — high",
    description: "Astra medium coordinator and Astra low worker for harder design.",
    requiresResolvedDesign: false,
    roles: [
      pi("coordinator", MODEL_ASTRA, "medium"),
      ...EVIDENCE_ROLES,
      pi("worker", MODEL_ASTRA, "low"),
      pi("reviewer", MODEL_LUNA, "xhigh"),
    ],
  },
  {
    id: "openai-claude-simple",
    label: "OpenAI Codex + Claude — simple",
    description: "Well-developed Wayfinder task. Sol xhigh coordinator; Claude Opus 5 worker and Claude Sonnet 5 reviewer via Herdr.",
    requiresResolvedDesign: true,
    roles: [
      pi("coordinator", MODEL_SOL, "xhigh"),
      ...EVIDENCE_ROLES,
      claude("worker", CLAUDE_WORKER_MODEL, "high"),
      claude("reviewer", CLAUDE_REVIEWER_MODEL, "high"),
    ],
  },
  {
    id: "openai-claude",
    label: "OpenAI Codex + Claude",
    description: "Astra low coordinator; Claude Opus 5 worker and Claude Sonnet 5 reviewer via Herdr.",
    requiresResolvedDesign: false,
    roles: [
      pi("coordinator", MODEL_ASTRA, "low"),
      ...EVIDENCE_ROLES,
      claude("worker", CLAUDE_WORKER_MODEL, "high"),
      claude("reviewer", CLAUDE_REVIEWER_MODEL, "high"),
    ],
  },
];

const BASE_INSTRUCTIONS: readonly string[] = [
  "Coordinator designs the solution and writes a detailed implementation packet before dispatching any worker: the smallest functional deliverable, exact files, and the checks that prove it.",
  "Workers implement the bounded design in their packet; they do not redesign it or widen its scope. Unresolved design returns to the Coordinator.",
  "Reviewer checks the actual work independently rather than restating the packet's claims: its input is the diff plus the solution brief and it reads only files in that diff; it verifies the risks the Coordinator ranked first, reports only source-backed P1/P2 findings with file:line, and skips style and unrelated files. Concurrency or in-flight-transition hardening the issue does not name is a FOLLOW-UP line, not a finding. A re-review sees the prior findings and the repair diff only and marks each FIXED or NOT FIXED.",
  "Route sizing: a change touching at most 5 source files with no new module is the Coordinator's own solo implementation plus one diff-scoped review, with no implementation packet or workflow script; larger changes get one worker packet and one review. A diff under 200 changed lines is self-reviewed by the Coordinator.",
  "Scout gathers local repository evidence; researcher gathers web evidence. Neither is a local inference provider. Each answers the Coordinator's numbered questions with citations and returns UNKNOWN rather than a guess.",
  "No stage is mandatory: omit an evidence stage the task does not need and record the rationale instead of running busywork fanout.",
  "Generation is not execution. The result is an editable prompt draft and needs an explicit send.",
  "A runtime provider, model or thinking mismatch blocks the send unless it is separately approved; the quota fallback line is that approval for usage-limit errors only.",
  "The generator writes a prompt draft only: it does not implement the task, design the solution, launch workers or modify tracking.",
];

/** How delegated roles are executed. One block per mode; the draft renders the role-specific recipe. */
const PI_SUBAGENTS_INSTRUCTIONS: readonly string[] = [
  "Execution: delegated roles run headless through the integrated pi-subagents `subagent` tool (async runs, workflow scripts, structured output); the Coordinator stays in its own session and is woken by native completion.",
];
const HERDR_NATIVE_INSTRUCTIONS: readonly string[] = [
  "Execution: delegated roles run as interactive Herdr-native Pi sessions, one new tab per role in the Coordinator's own workspace and cwd, named <workspace-prefix>-<role-suffix> (resea, plan, work, revie; the Promptr workspace prefix is `prompt`). The `subagent` tool is not used.",
  "Launch each role with herdr_layout tab_create {workspace, label: <name>, cwd, focus: false}, then herdr_agent start {pane, name: <name>, kind: 'pi', agentArgs: ['--provider', <provider>, '--model', <model>, '--thinking', <thinking>]} using the exact role runtime and no flag that strips interactivity (no --no-extensions, --no-skills, --tools or print mode); then submit the brief once with herdr_agent prompt {target: <name>, prompt, wait: true, until: ['idle', 'done', 'blocked'], timeout}.",
  "Every role pane is a normal interactive Pi the user can watch, type into and retarget with /model mid-run. On a usage-limit or quota stop keep the pane open, name the pane id to the user, submit `/model <fallback provider>/<model>` then `continue` once through herdr_agent prompt; if the session does not resume, wait for the user instead of relaunching.",
  "Collect the report with herdr_agent read {target, source: 'recent-unwrapped', lines}; pane text is evidence, not acceptance. Close a finished role's pane with herdr_pane close only after its report is captured; leave blocked, quota-stopped or user-flagged panes open.",
  "Before creating a tab, list the workspace's agents and reuse your own idle same-role pane instead of creating a duplicate. One writer at a time in the shared checkout; scout, researcher and reviewer panes are read-only.",
];

const PI_ONLY_INSTRUCTION =
  "Every role runs as a Pi session on the selected OpenAI provider.";
const HERDR_CLAUDE_INSTRUCTION =
  "Claude worker and reviewer run through Herdr; their Claude permissions stay independently controlled and are not granted by this workflow.";

const RUNTIME_UNVERIFIED_WARNING =
  "Static preview only: provider, model and thinking values are catalog candidates, not verified runtime availability. Validate capabilities before any launch or send.";
const SIMPLE_UNKNOWN_WARNING =
  "Task readiness is unknown: confirm the task is well developed before execution. Readiness is never inferred from an issue title or body.";
const UNKNOWN_WARNING =
  "Task readiness is unknown: the Coordinator must resolve the remaining evidence and design before dispatching workers.";
const UNRESOLVED_DESIGN_WARNING =
  "Task design is unresolved: the Coordinator must complete the solution design before worker dispatch.";

function findTemplate(id: string): TemplateSpec | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

function findProvider(id: string): WorkflowChoice | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

function knownIds(choices: readonly WorkflowChoice[]): string {
  return choices.map((choice) => choice.id).join(", ");
}

function freezeChoices(choices: readonly WorkflowChoice[]): readonly WorkflowChoice[] {
  return Object.freeze(choices.map((choice) => Object.freeze({ ...choice })));
}

const FROZEN_PROVIDERS = freezeChoices(PROVIDERS);
const FROZEN_WORKFLOWS = freezeChoices(TEMPLATES.map((template) => ({
  id: template.id, label: template.label, description: template.description,
})));

export function listWorkflows(): readonly WorkflowChoice[] {
  return FROZEN_WORKFLOWS;
}

export function listProviders(): readonly WorkflowChoice[] {
  return FROZEN_PROVIDERS;
}

function bindRole(spec: RoleSpec, providerId: string): WorkflowRole {
  return Object.freeze({
    role: spec.role,
    provider: spec.herdrClaude ? CLAUDE_PROVIDER : providerId,
    model: spec.model,
    thinking: spec.thinking,
    route: spec.herdrClaude ? "herdr-claude" : "pi",
  } as const);
}

/**
 * Expand a template + provider + readiness into an inert role plan.
 *
 * Readiness is a caller-supplied fact, not something this module guesses.
 * `openai-codex-simple` refuses an unresolved design outright — silently
 * promoting the task to a heavier template would hide the decision.
 */
export function expandWorkflow(input: WorkflowInput): WorkflowResult {
  if (typeof input !== "object" || input === null) {
    return fail("workflow input must be an object with template, provider and readiness.");
  }
  const { template: templateId, provider: providerId, readiness, execution: rawExecution } = input as Partial<WorkflowInput>;
  if (typeof templateId !== "string") {
    return fail(`workflow template must be a string; received ${quote(templateId)}.`);
  }
  if (typeof providerId !== "string") {
    return fail(`workflow provider must be a string; received ${quote(providerId)}.`);
  }
  const template = findTemplate(templateId);
  if (template === undefined) {
    return fail(`unknown workflow ${quote(templateId)}. Known workflows: ${knownIds(FROZEN_WORKFLOWS)}.`);
  }
  if (findProvider(providerId) === undefined) {
    return fail(`unknown provider ${quote(providerId)}. Known providers: ${knownIds(FROZEN_PROVIDERS)}.`);
  }
  if (typeof readiness !== "string" || !READINESS_VALUES.includes(readiness as WorkflowReadiness)) {
    return fail(
      `unknown task readiness ${quote(readiness)}. Expected one of: ${READINESS_VALUES.join(", ")}.`,
    );
  }

  const execution: WorkflowExecution = rawExecution === undefined ? DEFAULT_EXECUTION : rawExecution;
  if (!EXECUTION_VALUES.includes(execution)) {
    return fail(`unknown execution ${quote(rawExecution)}. Expected one of: ${EXECUTION_VALUES.join(", ")}.`);
  }

  if (template.requiresResolvedDesign && readiness === "unresolved-design") {
    return fail(
      `${template.id} is for well-developed tasks only, but this task's design is unresolved. `
      + "Resolve the design first or choose openai-codex-medium, openai-codex-high or openai-claude. "
      + "No template is substituted automatically.",
    );
  }

  const roles = Object.freeze(
    [...template.roles, GENERATOR_ROLE].map((spec) => bindRole(spec, providerId)),
  );
  const usesHerdrClaude = roles.some((role) => role.route === "herdr-claude");
  const instructions = Object.freeze([
    ...BASE_INSTRUCTIONS,
    ...(execution === "herdr-native" ? HERDR_NATIVE_INSTRUCTIONS : PI_SUBAGENTS_INSTRUCTIONS),
    quotaFallbackInstruction(providerId, FROZEN_PROVIDERS.map((choice) => choice.id)),
    usesHerdrClaude ? HERDR_CLAUDE_INSTRUCTION : PI_ONLY_INSTRUCTION,
  ]);

  const warnings: string[] = [RUNTIME_UNVERIFIED_WARNING];
  if (readiness === "unknown") {
    warnings.push(template.requiresResolvedDesign ? SIMPLE_UNKNOWN_WARNING : UNKNOWN_WARNING);
  } else if (readiness === "unresolved-design") {
    warnings.push(UNRESOLVED_DESIGN_WARNING);
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      version: 1,
      template: template.id,
      provider: providerId,
      execution,
      roles,
      instructions,
      warnings: Object.freeze(warnings),
    } as const),
  } as const);
}

function fail(error: string): WorkflowResult {
  return Object.freeze({ ok: false, error } as const);
}

/** Structural runtime check: an expansion may arrive from a caller, not from us. */
function describeExpansionProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "expansion must be an object.";
  const candidate = value as Partial<WorkflowExpansion>;
  if (candidate.version !== 1) return `expansion version must be 1; received ${quote(candidate.version)}.`;
  if (typeof candidate.template !== "string") return "expansion template must be a string.";
  if (typeof candidate.provider !== "string") return "expansion provider must be a string.";
  if (candidate.execution !== undefined && !EXECUTION_VALUES.includes(candidate.execution)) {
    return `unknown execution ${quote(candidate.execution)}.`;
  }
  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    return "expansion roles must be a non-empty array.";
  }
  if (!Array.isArray(candidate.instructions)) return "expansion instructions must be an array.";
  if (!Array.isArray(candidate.warnings)) return "expansion warnings must be an array.";
  for (const role of candidate.roles) {
    if (typeof role !== "object" || role === null) return "each expansion role must be an object.";
    const entry = role as Partial<WorkflowRole>;
    if (typeof entry.role !== "string" || !ROLE_ORDER.includes(entry.role as WorkflowRoleName)) {
      return `unknown role ${quote(entry.role)}.`;
    }
    if (typeof entry.provider !== "string" || entry.provider.length === 0) {
      return `role ${entry.role} has no provider.`;
    }
    if (typeof entry.model !== "string" || entry.model.length === 0) {
      return `role ${entry.role} has no model.`;
    }
    if (typeof entry.thinking !== "string") return `role ${entry.role} has no thinking level.`;
    if (entry.route !== "pi" && entry.route !== "herdr-claude") {
      return `role ${entry.role} has unknown route ${quote(entry.route)}.`;
    }
  }
  return undefined;
}

/**
 * Stable JSON for previews, diffs and packet attribution: fixed key order,
 * no timestamps, no randomness, trailing newline.
 */
export function serializeWorkflow(value: WorkflowExpansion): string {
  const problem = describeExpansionProblem(value);
  if (problem !== undefined) throw new TypeError(`cannot serialize workflow: ${problem}`);
  const body = {
    version: 1,
    template: value.template,
    provider: value.provider,
    execution: value.execution ?? DEFAULT_EXECUTION,
    roles: value.roles.map((role) => ({
      role: role.role,
      provider: role.provider,
      model: role.model,
      thinking: role.thinking,
      route: role.route,
    })),
    instructions: [...value.instructions],
    warnings: [...value.warnings],
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function capabilityProblem(capabilities: unknown): string | undefined {
  if (!Array.isArray(capabilities)) {
    return "runtime capabilities were not supplied. Absence is not implicit support: discover the available provider/model/thinking combinations first.";
  }
  if (capabilities.length === 0) {
    return "runtime capabilities list is empty, so no role can be confirmed. Absence is not implicit support.";
  }
  return undefined;
}

function supports(capability: WorkflowCapability, role: WorkflowRole): boolean {
  return capability.provider === role.provider
    && capability.model === role.model
    && capability.route === role.route
    && Array.isArray(capability.thinking)
    && capability.thinking.includes(role.thinking);
}

/**
 * Exact capability matching. Kept separate from `expandWorkflow` on purpose:
 * a static preview must work with no model discovery or network, and must
 * say so, while an actual launch must not proceed on catalog candidates.
 */
export function validateWorkflowCapabilities(
  value: WorkflowExpansion,
  capabilities: readonly WorkflowCapability[],
): WorkflowResult {
  const shape = describeExpansionProblem(value);
  if (shape !== undefined) return fail(`cannot validate workflow: ${shape}`);
  const missing = capabilityProblem(capabilities);
  if (missing !== undefined) return fail(missing);

  const unsupported = value.roles.filter(
    (role) => !capabilities.some((capability) =>
      typeof capability === "object" && capability !== null && supports(capability, role)),
  );
  if (unsupported.length > 0) {
    const detail = unsupported
      .map((role) => `${role.role} (${role.provider}/${role.model} ${role.thinking} via ${role.route})`)
      .join("; ");
    return fail(`runtime capabilities do not cover: ${detail}. Missing capabilities block; nothing is substituted.`);
  }
  return Object.freeze({ ok: true, value } as const);
}

/** Convenience binding for callers that want the port shape directly. */
export const catalogPort: WorkflowCatalogPort = Object.freeze({
  listWorkflows,
  listProviders,
  expandWorkflow,
});
