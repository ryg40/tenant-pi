/**
 * Pi model registry → workflow capabilities, and the capability probe file
 * that carries them to the companion.
 *
 * The hosted extension runs inside Pi and can read `ctx.modelRegistry`. The
 * companion runs outside Pi and cannot. This module is the pure bridge:
 *
 * - `capabilitiesFromRegistry` turns registry models (provider, id,
 *   reasoning flag, optional `thinkingLevelMap`) into exact
 *   `WorkflowCapability` rows on the `pi` route. Nothing is aliased.
 * - `serializeCapabilityProbe` / `parseCapabilityProbe` define the probe file
 *   the hosted `/promptr-workflows probe` command writes and the companion's
 *   dispatch reads. The file carries provider/model/thinking/route only —
 *   never a key, token, header or base URL.
 * - `checkExpansion` reports, per role, whether the registry covers it. Roles
 *   on the `herdr-claude` route are *unverifiable* here (Claude runs through
 *   Herdr, not through Pi's registry) and are reported as such, never as ok.
 *
 * Pure: no fs, env, network or Pi imports.
 */
import type { WorkflowCapability, WorkflowExpansion, WorkflowRole } from "./catalog.mts";

/** The thinking levels the workflow catalog can ask for. `off`/`minimal`/`max` are never requested. */
export const CATALOG_THINKING_LEVELS: readonly string[] = Object.freeze(["low", "medium", "high", "xhigh"]);

/** The registry fields this module reads; a Pi `Model` satisfies it structurally. */
export interface RegistryModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<string, string | null | undefined>>> | undefined;
}

/**
 * Thinking levels a registry model accepts, restricted to the catalog's set.
 * A non-reasoning model accepts none (the catalog always names a level). A
 * `thinkingLevelMap` entry of `null` marks a level unsupported; missing keys
 * use Pi's provider defaults for low/medium/high; xhigh requires an explicit mapping.
 */
export function thinkingLevelsOf(model: RegistryModel): readonly string[] {
  if (!model.reasoning) return Object.freeze([]);
  const map = model.thinkingLevelMap;
  return Object.freeze(CATALOG_THINKING_LEVELS.filter((level) =>
    level === "xhigh" ? typeof map?.[level] === "string" : map?.[level] !== null));
}

export function capabilitiesFromRegistry(models: readonly RegistryModel[]): readonly WorkflowCapability[] {
  const out: WorkflowCapability[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
    if (model.provider.length === 0 || model.id.length === 0) continue;
    const key = `${model.provider} ${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ provider: model.provider, model: model.id, thinking: thinkingLevelsOf(model), route: "pi" }));
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return Object.freeze(out);
}

export const CAPABILITY_PROBE_VERSION = 1;

export interface CapabilityProbeFile {
  readonly version: 1;
  readonly writtenAt: string;
  /** Human-readable origin, e.g. `pi modelRegistry.getAvailable()`. Include the installed Pi version when known. */
  readonly source: string;
  readonly capabilities: readonly WorkflowCapability[];
}

const CONTROL_BYTES = /[\u0000-\u001f\u007f]+/g;

export function serializeCapabilityProbe(capabilities: readonly WorkflowCapability[], writtenAt: string, source: string): string {
  const body: CapabilityProbeFile = {
    version: CAPABILITY_PROBE_VERSION,
    writtenAt,
    source: source.replace(CONTROL_BYTES, " ").slice(0, 200),
    capabilities: capabilities.map((c) => ({ provider: c.provider, model: c.model, thinking: [...c.thinking], route: c.route })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export type ProbeParse =
  | { readonly ok: true; readonly capabilities: readonly WorkflowCapability[]; readonly writtenAt: string | undefined; readonly source: string | undefined }
  | { readonly ok: false; readonly reason: string };

function parseEntries(raw: unknown): readonly WorkflowCapability[] | string {
  if (!Array.isArray(raw)) return "capability probe must be a JSON array or a version-1 object with a capabilities array";
  const capabilities: WorkflowCapability[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return "capability probe entry is not an object";
    const record = entry as Partial<WorkflowCapability>;
    if (typeof record.provider !== "string" || record.provider.length === 0
      || typeof record.model !== "string" || record.model.length === 0
      || !Array.isArray(record.thinking)
      || (record.route !== "pi" && record.route !== "herdr-claude")) {
      return "capability probe entry needs provider, model, thinking[] and route";
    }
    if (record.thinking.some((level) => typeof level !== "string" || !CATALOG_THINKING_LEVELS.includes(level))) {
      return "capability probe thinking entries must be supported thinking levels";
    }
    capabilities.push(Object.freeze({
      provider: record.provider,
      model: record.model,
      thinking: Object.freeze([...record.thinking]),
      route: record.route,
    }));
  }
  return Object.freeze(capabilities);
}

/** Accepts a bare array (the earlier probe form) and the version-1 object the hosted probe writes. */
export function parseCapabilityProbe(text: string): ProbeParse {
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return { ok: false, reason: "capability probe is not valid JSON" }; }
  if (Array.isArray(parsed)) {
    const entries = parseEntries(parsed);
    return typeof entries === "string" ? { ok: false, reason: entries } : { ok: true, capabilities: entries, writtenAt: undefined, source: undefined };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "capability probe must be a JSON array or object" };
  const record = parsed as Record<string, unknown>;
  if (record.version !== CAPABILITY_PROBE_VERSION) return { ok: false, reason: `capability probe version must be ${String(CAPABILITY_PROBE_VERSION)}` };
  const entries = parseEntries(record.capabilities);
  if (typeof entries === "string") return { ok: false, reason: entries };
  return {
    ok: true,
    capabilities: entries,
    writtenAt: typeof record.writtenAt === "string" ? record.writtenAt : undefined,
    source: typeof record.source === "string" ? record.source.slice(0, 200) : undefined,
  };
}

export type RoleCheckStatus = "ok" | "missing" | "unverifiable";

export interface RoleCheck {
  readonly role: WorkflowRole["role"];
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly route: WorkflowRole["route"];
  readonly status: RoleCheckStatus;
  /** Short reason for `missing`/`unverifiable`; empty for `ok`. */
  readonly reason: string;
}

/**
 * Per-role verdicts for one expansion. Exact matching on provider, model,
 * route and thinking level. A registry that lacks the provider entirely says
 * so, so a Copilot-only client sees "provider github-copilot not in registry"
 * rather than a bare "missing".
 */
export function checkExpansion(expansion: WorkflowExpansion, capabilities: readonly WorkflowCapability[]): readonly RoleCheck[] {
  const providers = new Set(capabilities.map((c) => c.provider));
  return Object.freeze(expansion.roles.map((role): RoleCheck => {
    const base = { role: role.role, provider: role.provider, model: role.model, thinking: role.thinking, route: role.route };
    if (role.route !== "pi") {
      return Object.freeze({ ...base, status: "unverifiable", reason: "herdr-claude route runs outside Pi's registry" });
    }
    const match = capabilities.find((c) => c.route === "pi" && c.provider === role.provider && c.model === role.model);
    if (!match) {
      const reason = providers.has(role.provider)
        ? `model ${role.model} not available on ${role.provider}`
        : `provider ${role.provider} not in the registry (not loaded or not authenticated)`;
      return Object.freeze({ ...base, status: "missing", reason });
    }
    if (!match.thinking.includes(role.thinking)) {
      const supports = match.thinking.length > 0 ? ` (supports ${match.thinking.join(", ")})` : " (no thinking levels)";
      return Object.freeze({ ...base, status: "missing", reason: `thinking ${role.thinking} unsupported by ${role.provider}/${role.model}${supports}` });
    }
    return Object.freeze({ ...base, status: "ok", reason: "" });
  }));
}

/** One line per role: `ok           worker      example-provider/example-model:medium via pi`. */
export function describeRoleChecks(checks: readonly RoleCheck[]): string[] {
  return checks.map((check) => {
    const label = `${check.provider}/${check.model}:${check.thinking} via ${check.route}`;
    const status = check.status === "ok" ? "ok" : check.status === "missing" ? "MISSING" : "unverifiable";
    return `${status.padEnd(12)} ${check.role.padEnd(11)} ${label}${check.reason ? ` — ${check.reason}` : ""}`;
  });
}

export function summarizeRoleChecks(checks: readonly RoleCheck[]): { ok: number; missing: number; unverifiable: number } {
  let ok = 0; let missing = 0; let unverifiable = 0;
  for (const check of checks) {
    if (check.status === "ok") ok += 1;
    else if (check.status === "missing") missing += 1;
    else unverifiable += 1;
  }
  return { ok, missing, unverifiable };
}
