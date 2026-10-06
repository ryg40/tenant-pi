/**
 * Effective workflow catalog: shipped defaults with a local override
 * applied.
 *
 * This is a *factory over the existing port*, not a second workflow engine.
 * It calls the shipped catalog to expand a template and then rebinds the
 * roles the override names. Consequences that are deliberate:
 *
 * - With no config the shipped port is returned unchanged, so existing
 *   behaviour and identity are byte-for-byte the same.
 * - Role order, the role set, readiness refusals and the shipped warnings all
 *   come from the base expansion. An override can retune a role; it cannot
 *   add, drop or reorder one, and it cannot talk a `simple` template into
 *   accepting an unresolved design.
 * - Nothing is substituted. A provider-only override leaves model IDs alone,
 *   an unknown workflow/role is an error, and a route change must name its
 *   provider rather than inherit one silently.
 * - Static instructions are recomputed from the *effective* roles, so a
 *   single-provider client is never told a route summary that is no longer true.
 *
 * Pure module: no process/env, filesystem, network or Pi APIs. Reading the
 * file is `load.mts`.
 */
import type {
  WorkflowCatalogPort, WorkflowChoice, WorkflowExpansion, WorkflowInput,
  WorkflowResult, WorkflowRole,
} from "../tracking/workflow-port.mts";
import type { WorkflowConfig } from "./config.mts";
import { isQuotaFallbackInstruction, quotaFallbackInstruction } from "./catalog.mts";

/**
 * The shipped catalog appends exactly one route-summary line to its
 * instructions. When roles are rebound that line can become false, so it is
 * dropped and recomputed. Matching by text keeps the base module untouched;
 * a test pins the two shipped phrasings so a reword shows up as a failure.
 */
const ROUTE_SUMMARY = /^Every role runs as a Pi session\b|^Claude worker and reviewer run through Herdr\b/;

const PROVIDER_DESCRIPTION =
  "Local workflow override provider. Roles that do not pin their own provider use it. "
  + "Listed because it is configured, which is not proof that it is loaded or authenticated.";
const DEFAULT_PROVIDER_SUFFIX = " Marked defaultProvider in the override file.";

export interface ConfiguredCatalogOptions {
  /** Human-readable origin of the override, quoted in the warning. */
  readonly source: string;
}

export type ConfiguredCatalogResult =
  | { readonly ok: true; readonly catalog: WorkflowCatalogPort; readonly configured: boolean }
  | { readonly ok: false; readonly error: string };

function fail(error: string): WorkflowResult {
  return Object.freeze({ ok: false, error } as const);
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

/**
 * A base expansion used only to discover a template's role set. `ready` is the
 * readiness every shipped template accepts, so this probe never doubles as a
 * readiness decision — the real expansion re-runs with the caller's readiness.
 */
function probeRoles(
  base: WorkflowCatalogPort, template: string, provider: string,
): readonly WorkflowRole[] | string {
  const result = base.expandWorkflow({ template, provider, readiness: "ready" });
  return result.ok ? result.value.roles : result.error;
}

function baseProviderId(base: WorkflowCatalogPort): string | undefined {
  return base.listProviders()[0]?.id;
}

/**
 * Cross-check the override against the shipped catalog. `config.mts` already
 * proved the shape; this proves the *names* exist, so the error can list the
 * workflows and roles the product actually has.
 */
function crossCheck(base: WorkflowCatalogPort, config: WorkflowConfig): string | undefined {
  const providers = config.providers ?? base.listProviders().map((choice) => choice.id);
  if (config.defaultProvider !== undefined && !providers.includes(config.defaultProvider)) {
    return `defaultProvider ${quote(config.defaultProvider)} is not in the effective providers (${providers.join(", ")}).`;
  }
  const known = base.listWorkflows().map((choice) => choice.id);
  const probeProvider = baseProviderId(base);
  if (probeProvider === undefined) return "shipped catalog offers no provider to expand against.";
  for (const [id, override] of Object.entries(config.workflows ?? {})) {
    if (!known.includes(id)) {
      return `workflows.${id} is not a known workflow. Known workflows: ${known.join(", ")}.`;
    }
    const roles = probeRoles(base, id, probeProvider);
    if (typeof roles === "string") return `workflows.${id} cannot be expanded: ${roles}`;
    for (const [name, role] of Object.entries(override.roles ?? {})) {
      const target = roles.find((entry) => entry.role === name);
      if (target === undefined) {
        return `workflows.${id}.roles.${name} is not a role of that workflow. `
          + `Its roles are: ${roles.map((entry) => entry.role).join(", ")}.`;
      }
      if (role.route !== undefined && role.route !== target.route && role.provider === undefined) {
        return `workflows.${id}.roles.${name} changes route to ${quote(role.route)} without naming a provider. `
          + "A route change must set 'provider' explicitly; no provider is inherited across routes.";
      }
    }
  }
  return undefined;
}

function effectiveProviders(base: WorkflowCatalogPort, config: WorkflowConfig): readonly WorkflowChoice[] {
  const ids = config.providers ?? base.listProviders().map((choice) => choice.id);
  const preferred = config.defaultProvider;
  const ordered = preferred !== undefined && ids.includes(preferred)
    ? [preferred, ...ids.filter((id) => id !== preferred)]
    : [...ids];
  return Object.freeze(ordered.map((id) => Object.freeze({
    id,
    label: id,
    // Shipped descriptions name the shipped provider. Once an override can rebind any
    // role that claim is no longer safe to repeat, so it is not reused.
    description: id === preferred ? `${PROVIDER_DESCRIPTION}${DEFAULT_PROVIDER_SUFFIX}` : PROVIDER_DESCRIPTION,
  })));
}

function effectiveWorkflows(base: WorkflowCatalogPort, config: WorkflowConfig): readonly WorkflowChoice[] {
  return Object.freeze(base.listWorkflows().map((choice) => {
    const override = config.workflows?.[choice.id];
    return Object.freeze({
      id: choice.id,
      label: override?.label ?? choice.label,
      description: override?.description ?? choice.description,
    });
  }));
}

/** One role rebound by the override. Anything the override omits is kept. */
function rebind(role: WorkflowRole, config: WorkflowConfig, template: string, selected: string): WorkflowRole {
  const override = config.workflows?.[template]?.roles?.[role.role];
  const route = override?.route ?? role.route;
  // A `pi` role follows the selected provider; a role that pins its own
  // provider (or a Claude role on the Herdr route) keeps it.
  const inherited = role.route === "pi" ? selected : role.provider;
  return Object.freeze({
    role: role.role,
    provider: override?.provider ?? inherited,
    model: override?.model ?? role.model,
    thinking: override?.thinking ?? role.thinking,
    route,
  });
}

function routeSummary(roles: readonly WorkflowRole[]): string {
  if (roles.some((role) => role.route === "herdr-claude")) {
    return "Roles on the herdr-claude route run through Herdr; their Claude permissions stay "
      + "independently controlled and are not granted by this workflow.";
  }
  const providers = [...new Set(roles.map((role) => role.provider))];
  if (providers.length === 1) {
    return `Every role runs as a Pi session on ${String(providers[0])}.`;
  }
  return `Every role runs as a Pi session; the roles use ${providers.join(", ")} as shown in the matrix above.`;
}

function expandConfigured(
  base: WorkflowCatalogPort, config: WorkflowConfig, options: ConfiguredCatalogOptions,
  providers: readonly WorkflowChoice[], input: WorkflowInput,
): WorkflowResult {
  if (typeof input !== "object" || input === null) {
    return fail("workflow input must be an object with template, provider and readiness.");
  }
  const { template, provider, readiness, execution } = input;
  if (typeof provider !== "string" || !providers.some((choice) => choice.id === provider)) {
    return fail(`unknown provider ${quote(provider)}. Known providers: ${providers.map((c) => c.id).join(", ")}.`);
  }
  const probeProvider = baseProviderId(base);
  if (probeProvider === undefined) return fail("shipped catalog offers no provider to expand against.");

  // Expand on a shipped provider so readiness rules, the role set and the
  // shipped warnings all still come from the base catalog, then rebind.
  const expanded = base.expandWorkflow(
    execution === undefined ? { template, provider: probeProvider, readiness } : { template, provider: probeProvider, readiness, execution },
  );
  if (!expanded.ok) return expanded;
  const value = expanded.value;

  const roles = Object.freeze(value.roles.map((role) => rebind(role, config, value.template, provider)));
  // The shipped quota-fallback line names a shipped provider; recompute it
  // from the effective provider list so an override never inherits a
  // fallback it did not configure.
  const instructions = Object.freeze([
    ...value.instructions.filter((line) => !ROUTE_SUMMARY.test(line) && !isQuotaFallbackInstruction(line)),
    quotaFallbackInstruction(provider, providers.map((choice) => choice.id)),
    routeSummary(roles),
  ]);
  const warnings = Object.freeze([
    ...value.warnings,
    `Effective roles come from the local workflow override at ${options.source}. `
    + "Configuration states intent; it is not verified runtime availability.",
  ]);

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      version: 1,
      requiresCapabilityProbe: true,
      template: value.template,
      provider,
      ...(value.execution === undefined ? {} : { execution: value.execution }),
      roles,
      instructions,
      warnings,
    } as WorkflowExpansion),
  } as const);
}

/**
 * Build the effective catalog. Returns the shipped port unchanged when there
 * is no config, and a configuration error (never a silent fallback) when the
 * override names something the catalog does not have.
 */
export function createConfiguredCatalog(
  base: WorkflowCatalogPort,
  config: WorkflowConfig | undefined,
  options: ConfiguredCatalogOptions,
): ConfiguredCatalogResult {
  if (config === undefined) return Object.freeze({ ok: true, catalog: base, configured: false } as const);
  const problem = crossCheck(base, config);
  if (problem !== undefined) return Object.freeze({ ok: false, error: problem } as const);

  const providers = effectiveProviders(base, config);
  const workflows = effectiveWorkflows(base, config);
  const catalog: WorkflowCatalogPort = Object.freeze({
    listWorkflows: () => workflows,
    listProviders: () => providers,
    expandWorkflow: (input: WorkflowInput) => expandConfigured(base, config, options, providers, input),
  });
  return Object.freeze({ ok: true, catalog, configured: true } as const);
}
