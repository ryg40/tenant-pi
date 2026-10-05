/**
 * Local workflow override configuration — schema and parser.
 *
 * A client machine can select its own provider/model/thinking per workflow
 * level and role without editing shipped source. This module owns the
 * *shape* of that file and nothing else:
 *
 * - Pure functions only. No process/env, filesystem, network or Pi APIs.
 *   Reading the file is `load.mts`; applying it is `configured.mts`.
 * - Validation is strict and visible. Unknown keys, wrong types, empty
 *   identifiers, unsupported thinking levels or routes and unreplaced
 *   `<placeholder>` values are configuration *errors*. Nothing is silently
 *   dropped, defaulted or aliased: an invalid file blocks selection instead
 *   of quietly reverting to shipped defaults.
 * - Nothing here proves a provider is loaded or authenticated. The file
 *   states intent; runtime availability is a separate, explicit check.
 *
 * Credentials never belong in this file and the parser has no field for one:
 * keys, tokens and base URLs stay in Pi's own auth/model configuration.
 */

export const WORKFLOW_CONFIG_VERSION = 1;

/** File name under the Pi agent directory's `promptr/` state root. */
export const WORKFLOWS_FILE_NAME = "workflows.json";

/** Absolute-path override for the whole file. */
export const WORKFLOWS_FILE_ENV = "PROMPTR_WORKFLOWS_FILE";

export type ConfigThinking = "low" | "medium" | "high" | "xhigh";
export type ConfigRoute = "pi" | "herdr-claude";

export const CONFIG_THINKING_LEVELS: readonly ConfigThinking[] =
  Object.freeze(["low", "medium", "high", "xhigh"] as const);
export const CONFIG_ROUTES: readonly ConfigRoute[] =
  Object.freeze(["pi", "herdr-claude"] as const);

export interface RoleOverride {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ConfigThinking;
  readonly route?: ConfigRoute;
}

export interface WorkflowOverride {
  readonly label?: string;
  readonly description?: string;
  readonly roles?: Readonly<Record<string, RoleOverride>>;
}

export interface WorkflowConfig {
  readonly version: 1;
  /** Provider IDs this machine offers. Presence here is intent, not proof. */
  readonly providers?: readonly string[];
  /** Listed first in the picker. Must be one of `providers`. Never substituted. */
  readonly defaultProvider?: string;
  readonly workflows?: Readonly<Record<string, WorkflowOverride>>;
}

export type ConfigResult =
  | { readonly ok: true; readonly value: WorkflowConfig }
  | { readonly ok: false; readonly error: string };

const CONFIG_KEYS = ["version", "providers", "defaultProvider", "workflows"] as const;
const WORKFLOW_KEYS = ["label", "description", "roles"] as const;
const ROLE_KEYS = ["provider", "model", "thinking", "route"] as const;

/** Printable, space-free ASCII. Model IDs legitimately carry `/`, `.`, `:` and `-`. */
const IDENTIFIER = /^[!-~]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_IDENTIFIER = 120;
const MAX_TEXT = 300;

function fail(error: string): ConfigResult {
  return Object.freeze({ ok: false, error } as const);
}

function quote(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], where: string): string | undefined {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra === undefined) return undefined;
  return `${where}: unknown key ${quote(extra)}. Known keys: ${allowed.join(", ")}.`;
}

/**
 * Identifier check shared by provider and model values. A packaged example
 * ships `<angle-bracket>` placeholders on purpose; leaving one in place is a
 * configuration error rather than a model ID that would later fail at launch
 * with a confusing provider message.
 */
function identifierProblem(value: unknown, where: string): string | undefined {
  if (typeof value !== "string") return `${where} must be a string; received ${quote(value)}.`;
  if (value.length === 0 || value !== value.trim()) {
    return `${where} must be a non-empty identifier with no surrounding whitespace.`;
  }
  if (value.startsWith("<") && value.endsWith(">")) {
    return `${where} is still the example placeholder ${quote(value)}. `
      + "Replace it with the exact ID this machine loads (see `pi --list-models`); no alias is substituted.";
  }
  if (value.length > MAX_IDENTIFIER) return `${where} is longer than ${String(MAX_IDENTIFIER)} characters.`;
  if (!IDENTIFIER.test(value)) return `${where} must be printable ASCII with no spaces; received ${quote(value)}.`;
  return undefined;
}

function textProblem(value: unknown, where: string): string | undefined {
  if (typeof value !== "string") return `${where} must be a string; received ${quote(value)}.`;
  if (value.trim().length === 0) return `${where} must not be empty.`;
  if (value.length > MAX_TEXT) return `${where} is longer than ${String(MAX_TEXT)} characters.`;
  if (CONTROL.test(value)) return `${where} must not contain control characters.`;
  return undefined;
}

type RoleParse = { ok: true; value: RoleOverride } | { ok: false; error: string };

function parseRole(raw: unknown, where: string): RoleParse {
  if (!isPlainObject(raw)) return { ok: false, error: `${where} must be an object.` };
  const extra = unknownKey(raw, ROLE_KEYS, where);
  if (extra !== undefined) return { ok: false, error: extra };
  if (Object.keys(raw).length === 0) {
    return { ok: false, error: `${where} is empty. Remove it or set at least one of ${ROLE_KEYS.join(", ")}.` };
  }
  const role: { provider?: string; model?: string; thinking?: ConfigThinking; route?: ConfigRoute } = {};
  if ("provider" in raw) {
    const problem = identifierProblem(raw.provider, `${where}.provider`);
    if (problem !== undefined) return { ok: false, error: problem };
    role.provider = raw.provider as string;
  }
  if ("model" in raw) {
    const problem = identifierProblem(raw.model, `${where}.model`);
    if (problem !== undefined) return { ok: false, error: problem };
    role.model = raw.model as string;
  }
  if ("thinking" in raw) {
    if (typeof raw.thinking !== "string" || !CONFIG_THINKING_LEVELS.includes(raw.thinking as ConfigThinking)) {
      return {
        ok: false,
        error: `${where}.thinking is ${quote(raw.thinking)}; supported levels are ${CONFIG_THINKING_LEVELS.join(", ")}.`,
      };
    }
    role.thinking = raw.thinking as ConfigThinking;
  }
  if ("route" in raw) {
    if (typeof raw.route !== "string" || !CONFIG_ROUTES.includes(raw.route as ConfigRoute)) {
      return {
        ok: false,
        error: `${where}.route is ${quote(raw.route)}; supported routes are ${CONFIG_ROUTES.join(", ")}.`,
      };
    }
    role.route = raw.route as ConfigRoute;
  }
  return { ok: true, value: Object.freeze(role) };
}

type WorkflowParse = { ok: true; value: WorkflowOverride } | { ok: false; error: string };

function parseWorkflow(raw: unknown, where: string): WorkflowParse {
  if (!isPlainObject(raw)) return { ok: false, error: `${where} must be an object.` };
  const extra = unknownKey(raw, WORKFLOW_KEYS, where);
  if (extra !== undefined) return { ok: false, error: extra };
  const override: { label?: string; description?: string; roles?: Readonly<Record<string, RoleOverride>> } = {};
  if ("label" in raw) {
    const problem = textProblem(raw.label, `${where}.label`);
    if (problem !== undefined) return { ok: false, error: problem };
    override.label = raw.label as string;
  }
  if ("description" in raw) {
    const problem = textProblem(raw.description, `${where}.description`);
    if (problem !== undefined) return { ok: false, error: problem };
    override.description = raw.description as string;
  }
  if ("roles" in raw) {
    if (!isPlainObject(raw.roles)) {
      return { ok: false, error: `${where}.roles must be an object keyed by role name.` };
    }
    const roles: Record<string, RoleOverride> = {};
    for (const [name, value] of Object.entries(raw.roles)) {
      if (name.trim().length === 0) return { ok: false, error: `${where}.roles has an empty role name.` };
      const parsed = parseRole(value, `${where}.roles.${name}`);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      roles[name] = parsed.value;
    }
    if (Object.keys(roles).length === 0) {
      return { ok: false, error: `${where}.roles is empty. Remove it or name at least one role.` };
    }
    override.roles = Object.freeze(roles);
  }
  if (Object.keys(override).length === 0) {
    return { ok: false, error: `${where} is empty. Remove it or set ${WORKFLOW_KEYS.join(", ")}.` };
  }
  return { ok: true, value: Object.freeze(override) };
}

/**
 * Validate a parsed JSON value as a version-1 workflow override file.
 *
 * Known workflow IDs and role names are *not* checked here: this module has
 * no catalog. `configured.mts` cross-checks them against the shipped catalog
 * so the error can name the workflows and roles that actually exist.
 */
export function parseWorkflowConfig(raw: unknown): ConfigResult {
  if (!isPlainObject(raw)) return fail("workflow override file must contain a JSON object.");
  const extra = unknownKey(raw, CONFIG_KEYS, "workflow override");
  if (extra !== undefined) return fail(extra);
  if (raw.version !== WORKFLOW_CONFIG_VERSION) {
    return fail(`workflow override version must be ${String(WORKFLOW_CONFIG_VERSION)}; received ${quote(raw.version)}.`);
  }

  const value: {
    version: 1;
    providers?: readonly string[];
    defaultProvider?: string;
    workflows?: Readonly<Record<string, WorkflowOverride>>;
  } = { version: WORKFLOW_CONFIG_VERSION };

  if ("providers" in raw) {
    if (!Array.isArray(raw.providers)) {
      return fail("workflow override 'providers' must be an array of provider IDs.");
    }
    if (raw.providers.length === 0) {
      return fail("workflow override 'providers' is empty. Remove the key or name at least one provider ID.");
    }
    const seen = new Set<string>();
    for (const [index, entry] of raw.providers.entries()) {
      const problem = identifierProblem(entry, `providers[${String(index)}]`);
      if (problem !== undefined) return fail(problem);
      const id = entry as string;
      if (seen.has(id)) return fail(`workflow override lists provider ${quote(id)} twice.`);
      seen.add(id);
    }
    value.providers = Object.freeze([...(raw.providers as string[])]);
  }

  if ("defaultProvider" in raw) {
    const problem = identifierProblem(raw.defaultProvider, "workflow override 'defaultProvider'");
    if (problem !== undefined) return fail(problem);
    const id = raw.defaultProvider as string;
    if (value.providers !== undefined && !value.providers.includes(id)) {
      return fail(`defaultProvider ${quote(id)} is not listed in 'providers' (${value.providers.join(", ")}).`);
    }
    value.defaultProvider = id;
  }

  if ("workflows" in raw) {
    if (!isPlainObject(raw.workflows)) {
      return fail("workflow override 'workflows' must be an object keyed by workflow ID.");
    }
    const workflows: Record<string, WorkflowOverride> = {};
    for (const [id, entry] of Object.entries(raw.workflows)) {
      if (id.trim().length === 0) return fail("workflow override 'workflows' has an empty workflow ID.");
      const parsed = parseWorkflow(entry, `workflows.${id}`);
      if (!parsed.ok) return fail(parsed.error);
      workflows[id] = parsed.value;
    }
    if (Object.keys(workflows).length === 0) {
      return fail("workflow override 'workflows' is empty. Remove the key or name at least one workflow.");
    }
    value.workflows = Object.freeze(workflows);
  }

  if (value.providers === undefined && value.workflows === undefined) {
    return fail(
      "workflow override sets nothing. Add 'providers' and/or 'workflows', "
      + "or delete the file to use the shipped defaults.",
    );
  }

  return Object.freeze({ ok: true, value: Object.freeze(value) } as const);
}

/** Parse file text, reporting a JSON syntax error as a configuration error. */
export function parseWorkflowConfigText(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 160) : "invalid JSON";
    return fail(`workflow override file is not valid JSON: ${detail}`);
  }
  return parseWorkflowConfig(raw);
}
