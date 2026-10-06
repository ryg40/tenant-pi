/**
 * Filesystem loader for the local workflow override.
 *
 * Kept apart from `catalog.mts` (pure) and `config.mts` (schema) so the
 * shipped catalog stays inert and testable with no I/O. This module owns:
 *
 * - where the file lives: `<PI_CODING_AGENT_DIR|~/.pi/agent>/promptr/workflows.json`,
 *   or the absolute path in `PROMPTR_WORKFLOWS_FILE`. The agent directory
 *   follows the same host convention as the rest of Promptr's state; no user
 *   home is hardcoded.
 * - precedence: shipped defaults, then the single local override. There is no
 *   implicit project-level override.
 * - reload: `refresh()` re-reads at the workflow-open/prepare boundaries, so
 *   editing the file and reopening the picker shows the new matrix. Renders
 *   read the cached snapshot and never touch the disk.
 *
 * A missing file means shipped defaults. A malformed or unknown-named file is
 * an error state: the picker offers nothing and every expansion returns the
 * configuration error, so an invalid override blocks selection and dispatch
 * instead of silently reverting to defaults.
 *
 * This module never writes the file, never reads credentials, and never
 * touches `settings.json` or any OpenKnowledge sync.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WorkflowCatalogPort, WorkflowInput, WorkflowResult } from "../tracking/workflow-port.mts";
import { WORKFLOWS_FILE_ENV, WORKFLOWS_FILE_NAME, parseWorkflowConfigText, type WorkflowConfig } from "./config.mts";
import { createConfiguredCatalog } from "./configured.mts";

export const CAPABILITY_PROBE_FILE_NAME = "capabilities.json";
export const CAPABILITY_PROBE_ENV = "PROMPTR_WORKFLOW_CAPABILITIES";

export interface WorkflowLoadDeps {
  readFile: (file: string) => string | undefined;
  exists: (file: string) => boolean;
}

export const nodeWorkflowLoadDeps: WorkflowLoadDeps = Object.freeze({
  readFile(file: string): string | undefined {
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  },
  exists(file: string): boolean {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  },
});

export interface WorkflowsFile {
  readonly path: string;
  /** True when `PROMPTR_WORKFLOWS_FILE` selected it. */
  readonly explicit: boolean;
  /** Set when the environment named an unusable path. */
  readonly error?: string;
}

/** `<PI_CODING_AGENT_DIR|~/.pi/agent>/promptr/`, the same root the rest of Promptr uses. */
export function workflowStateRoot(env: NodeJS.ProcessEnv): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  const base = override !== undefined && override.length > 0 ? override : path.join(homedir(), ".pi", "agent");
  return path.join(base, "promptr");
}

/** Provider id of the shipped catalog. No Pi serves it; a local override names the real provider. */
export const NEUTRAL_PROVIDER_ID = "default-provider";
/** Shown wherever the shipped defaults would be used without a local override. */
export const NO_OVERRIDE_HINT = "run promptr-workflows-init (for example `--example copilot` or `--provider <id>`)";

export function resolveWorkflowsFile(env: NodeJS.ProcessEnv): WorkflowsFile {
  const explicit = env[WORKFLOWS_FILE_ENV]?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (!path.isAbsolute(explicit)) {
      return {
        path: explicit,
        explicit: true,
        error: `${WORKFLOWS_FILE_ENV} must be an absolute path; received '${explicit}'.`,
      };
    }
    return { path: explicit, explicit: true };
  }
  return { path: path.join(workflowStateRoot(env), WORKFLOWS_FILE_NAME), explicit: false };
}

export function defaultCapabilityProbePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workflowStateRoot(env), CAPABILITY_PROBE_FILE_NAME);
}

/** Keep probe, launch, status and doctor on one exact capability-file path. */
export function resolveCapabilityProbeFile(env: NodeJS.ProcessEnv): WorkflowsFile {
  const explicit = env[CAPABILITY_PROBE_ENV]?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (!path.isAbsolute(explicit)) {
      return {
        path: explicit,
        explicit: true,
        error: `${CAPABILITY_PROBE_ENV} must be an absolute path; received '${explicit}'.`,
      };
    }
    return { path: explicit, explicit: true };
  }
  return { path: defaultCapabilityProbePath(env), explicit: false };
}

export type WorkflowConfigLoad =
  | { readonly ok: true; readonly config: WorkflowConfig | undefined; readonly file: WorkflowsFile }
  | { readonly ok: false; readonly error: string; readonly file: WorkflowsFile };

/**
 * Read and validate the override. Absent file plus default path means shipped
 * defaults; absent file at an explicitly requested path is an error, because
 * the operator asked for that file by name.
 */
export function loadWorkflowConfig(env: NodeJS.ProcessEnv, deps: WorkflowLoadDeps): WorkflowConfigLoad {
  const file = resolveWorkflowsFile(env);
  if (file.error !== undefined) return { ok: false, error: file.error, file };
  if (!deps.exists(file.path)) {
    if (file.explicit) {
      return { ok: false, error: `${WORKFLOWS_FILE_ENV} points at '${file.path}', which does not exist.`, file };
    }
    return { ok: true, config: undefined, file };
  }
  const text = deps.readFile(file.path);
  if (text === undefined) return { ok: false, error: `workflow override at '${file.path}' could not be read.`, file };
  const parsed = parseWorkflowConfigText(text);
  if (!parsed.ok) return { ok: false, error: `${file.path}: ${parsed.error}`, file };
  return { ok: true, config: parsed.value, file };
}

export interface EffectiveCatalogSnapshot {
  readonly catalog: WorkflowCatalogPort;
  /** True when a valid override file was applied. */
  readonly configured: boolean;
  readonly path: string;
  /** Configuration error; when set the catalog offers nothing and blocks. */
  readonly error: string | undefined;
}

/** Every call fails with the configuration error, so dispatch cannot proceed. */
function blockedCatalog(error: string): WorkflowCatalogPort {
  const result: WorkflowResult = Object.freeze({ ok: false, error } as const);
  return Object.freeze({
    listWorkflows: () => Object.freeze([]),
    listProviders: () => Object.freeze([]),
    expandWorkflow: (_input: WorkflowInput) => result,
  });
}

export function loadEffectiveCatalog(
  base: WorkflowCatalogPort, env: NodeJS.ProcessEnv, deps: WorkflowLoadDeps,
): EffectiveCatalogSnapshot {
  const load = loadWorkflowConfig(env, deps);
  if (!load.ok) {
    return { catalog: blockedCatalog(load.error), configured: false, path: load.file.path, error: load.error };
  }
  const built = createConfiguredCatalog(base, load.config, { source: load.file.path });
  if (!built.ok) {
    const error = `${load.file.path}: ${built.error}`;
    return { catalog: blockedCatalog(error), configured: false, path: load.file.path, error };
  }
  return { catalog: built.catalog, configured: built.configured, path: load.file.path, error: undefined };
}

export interface ReloadingCatalog {
  /** Inject this into the navigation controller; it reads the cached snapshot. */
  readonly port: WorkflowCatalogPort;
  /** Re-read the override. Call at workflow-open and prepare boundaries only. */
  refresh: () => EffectiveCatalogSnapshot;
  current: () => EffectiveCatalogSnapshot;
  /** One line for the operator: the source, or the configuration error. */
  describe: () => string;
}

/**
 * A catalog port whose backing snapshot is reloaded on demand. The port itself
 * does no I/O, so a render loop calling `listWorkflows()` per frame does not
 * hit the disk; `refresh()` is what makes a reopened picker see file edits.
 */
export function createReloadingCatalog(
  base: WorkflowCatalogPort, env: NodeJS.ProcessEnv, deps: WorkflowLoadDeps,
): ReloadingCatalog {
  let snapshot = loadEffectiveCatalog(base, env, deps);
  const port: WorkflowCatalogPort = Object.freeze({
    listWorkflows: () => snapshot.catalog.listWorkflows(),
    listProviders: () => snapshot.catalog.listProviders(),
    expandWorkflow: (input: WorkflowInput) => snapshot.catalog.expandWorkflow(input),
  });
  return Object.freeze({
    port,
    refresh: (): EffectiveCatalogSnapshot => {
      snapshot = loadEffectiveCatalog(base, env, deps);
      return snapshot;
    },
    current: (): EffectiveCatalogSnapshot => snapshot,
    describe: (): string => {
      if (snapshot.error !== undefined) {
        return `workflow override invalid — ${snapshot.error} Nothing is generated, launched or sent until it is fixed.`;
      }
      return snapshot.configured
        ? `workflow override active: ${snapshot.path} (configuration, not verified availability)`
        : `workflow overrides: none (shipped defaults do not launch); expected file ${snapshot.path}`;
    },
  });
}
