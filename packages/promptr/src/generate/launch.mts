/**
 * Generator launch through Herdr.
 *
 * Fully injectable: every fs, clock and Herdr call goes through `GeneratorDeps`
 * so tests run with a scripted executor and no real Pi. The sequence mirrors
 * briefing-fresh: packet on disk first, tab create, agent start, identity
 * check, one prompt, then poll to idle and validate the produced file. Every
 * failure returns `{ ok: false, reason }` without retry; the generator pane
 * stays open for inspection in every outcome.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratePromptRequest } from "../tracking/selection.mts";
import type { WorkflowExpansion } from "../tracking/workflow-port.mts";
import { validateWorkflowCapabilities, type WorkflowCapability } from "../workflow/catalog.mts";
import { NEUTRAL_PROVIDER_ID, NO_OVERRIDE_HINT, resolveCapabilityProbeFile, loadWorkflowConfig } from "../workflow/load.mts";
export { defaultCapabilityProbePath, CAPABILITY_PROBE_FILE_NAME } from "../workflow/load.mts";
import { parseCapabilityProbe } from "../workflow/registry.mts";
import { buildGeneratorPrompt, validateGeneratorOutput, type GeneratorCatchUp, type GeneratorContext, type GeneratorPacket } from "./packet.mts";
import { loadFreshCatchUp } from "../tracking/catchup-sources.mts";
import type { ProjectPaths } from "../state/paths.mts";
import { isHerdrWorkspaceId } from "../herdr/identity.mts";
import { buildTabCreateArgs, buildInteractiveStartArgs, buildPromptArgs, parseAgent, parseTabCreate, matchesAgentIdentity, type AgentRecord } from "../herdr/adapter.mts";
export { buildTabCreateArgs, parseAgent, parseTabCreate, type AgentRecord } from "../herdr/adapter.mts";
import { herdrRoleNameFromList } from "../herdr/naming.mts";

/**
 * Attach the latest Catch-Me-Up digest when it is younger than 24 h.
 * Never runs a catch-up: an older or missing digest leaves `ctx` unchanged.
 * Hosts call this once when building the packet at dispatch.
 */
export function withFreshCatchUp(
  ctx: GeneratorContext,
  paths: Pick<ProjectPaths, "catchup">,
  readFile: (file: string) => string | undefined,
  nowMs: number,
): GeneratorContext {
  const loaded = loadFreshCatchUp(paths, readFile, nowMs);
  if (!loaded) return ctx;
  const catchUp: GeneratorCatchUp = {
    generatedAt: loaded.packet.generatedAt, since: loaded.packet.since, file: loaded.file,
    summary: loaded.packet.summary, markdown: loaded.packet.markdown,
  };
  return { ...ctx, catchUp };
}

export interface GeneratorRuntime { provider: string; model: string; thinking: string }

/** The `generator` role of an expansion, only when it runs on the Pi route. */
export function generatorRuntime(expansion: WorkflowExpansion): GeneratorRuntime | undefined {
  const role = expansion.roles.find((r) => r.role === "generator");
  if (!role || role.route !== "pi") return undefined;
  return { provider: role.provider, model: role.model, thinking: role.thinking };
}

/**
 * User-directed runtime override for trials: `PROMPTR_GENERATOR_RUNTIME=<provider>/<model>:<thinking>`
 * (for example `example-provider/vendor/example-model:medium`). Malformed values are ignored.
 */
export function generatorRuntimeOverride(env: NodeJS.ProcessEnv): GeneratorRuntime | undefined {
  const raw = env.PROMPTR_GENERATOR_RUNTIME?.trim();
  if (!raw) return undefined;
  const match = /^([a-z0-9-]+)\/(.+?):(off|minimal|low|medium|high|xhigh|max)$/.exec(raw);
  if (!match) return undefined;
  return { provider: match[1] as string, model: match[2] as string, thinking: match[3] as string };
}

export function runtimeLabel(runtime: GeneratorRuntime): string {
  return `${runtime.provider}/${runtime.model}:${runtime.thinking}`;
}

/** Reason of the early stop when the shipped neutral catalog would launch without a local override. */
export const NO_OVERRIDE_REASON = `no workflow override file; ${NO_OVERRIDE_HINT}`;

/** Absolute path of a JSON capability probe: `[{provider, model, thinking[], route}]`. */
export const CAPABILITY_PROBE_ENV = "PROMPTR_WORKFLOW_CAPABILITIES";

export type CapabilityProbe =
  | { ok: true; capabilities: readonly WorkflowCapability[]; path: string }
  | { ok: false; reason: string; path: string };

/**
 * Runtime capabilities the dispatching side was given.
 *
 * Promptr's companion runs outside Pi, so it cannot read `ctx.modelRegistry`
 * itself. Rather than invent an IPC channel, it accepts a bounded probe file
 * written by whoever *can* enumerate the registry. The probe carries only
 * provider/model/thinking/route — never a key, token or base URL — and this
 * loader makes no model call of its own.
 *
 * Unset means "no probe", which keeps the existing behaviour: the expansion
 * is a static candidate and the agent start is what actually proves the
 * combination. A probe that is present but unreadable or malformed is a
 * failure, not an implicit all-supported.
 */
export function loadCapabilityProbe(
  env: NodeJS.ProcessEnv, readFile: (p: string) => string | undefined,
): CapabilityProbe | undefined {
  const resolved = resolveCapabilityProbeFile(env);
  if (resolved.error) return { ok: false, reason: resolved.error, path: resolved.path };
  const explicit = env[CAPABILITY_PROBE_ENV]?.trim();
  let file: string;
  if (explicit !== undefined && explicit.length > 0) {
    if (!path.isAbsolute(explicit)) {
      return { ok: false, reason: `${CAPABILITY_PROBE_ENV} must be an absolute path`, path: explicit };
    }
    file = explicit;
  } else {
    // Default probe written by the hosted `/promptr-workflows probe` command.
    // Absent means "no probe" (existing behaviour); present means it is used.
    file = resolved.path;
    if (readFile(file) === undefined) {
      const config = loadWorkflowConfig(env, { readFile, exists: (p) => readFile(p) !== undefined });
      if (!config.ok) return { ok: false, reason: config.error, path: file };
      if (config.config !== undefined) return { ok: false, reason: "Configured workflows require a readable capability probe; run /promptr-workflows probe", path: file };
      return undefined;
    }
  }
  const text = readFile(file);
  if (text === undefined) return { ok: false, reason: "capability probe could not be read", path: file };
  const parsed = parseCapabilityProbe(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, path: file };
  return { ok: true, capabilities: parsed.capabilities, path: file };
}

/**
 * Exact-match gate on the one role about to be dispatched. Reuses the
 * catalog's capability matching so nothing is aliased or "close enough".
 * Returns a reason when dispatch must be blocked.
 */
export function capabilityBlock(
  runtime: GeneratorRuntime, capabilities: readonly WorkflowCapability[],
): string | undefined {
  const role = {
    version: 1 as const,
    template: "generator-dispatch",
    provider: runtime.provider,
    roles: [{
      role: "generator" as const,
      provider: runtime.provider,
      model: runtime.model,
      thinking: runtime.thinking as "low" | "medium" | "high" | "xhigh",
      route: "pi" as const,
    }],
    instructions: [] as readonly string[],
    warnings: [] as readonly string[],
  };
  const checked = validateWorkflowCapabilities(role, capabilities);
  return checked.ok ? undefined : checked.error;
}

/** Relative location of the packaged generator skill inside this package. */
export const PACKAGED_GENERATOR_SKILL = path.join("skills", "promptr-generate-task-prompt", "SKILL.md");

/**
 * The skill shipped with this package, resolved beside the built module
 * (`dist/src/generate/launch.mjs` → `<package>/skills/...`). No user home,
 * no private skill store: a fresh client gets the skill from the package.
 */
export function packagedSkillPath(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(here, "..", "..", "..", PACKAGED_GENERATOR_SKILL);
}

export const DEFAULT_GENERATOR_SKILL = packagedSkillPath();

/** `PROMPTR_GENERATOR_SKILL` when set, else the packaged skill; must be absolute and exist. */
export function resolveSkillPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  const candidate = env.PROMPTR_GENERATOR_SKILL?.trim() || DEFAULT_GENERATOR_SKILL;
  if (!path.isAbsolute(candidate) || !exists(candidate)) return undefined;
  return candidate;
}

/**
 * Herdr learns Pi state only through herdr-agent-state. No provider adds an
 * extension file of its own.
 */
export function requiredExtensions(agentDir: string): string[] {
  return [path.join(agentDir, "extensions", "herdr-agent-state.ts")];
}

/** Herdr agent names: lowercase start, `[a-z0-9_-]`, 1-32 chars. */
export function generatorSessionName(taskNumber: number, requestId: string): string {
  return `promptr-gen-${String(taskNumber)}-${requestId.slice(0, 8)}`.slice(0, 32);
}

export function buildAgentStartArgs(
  name: string, pane: string, runtime: GeneratorRuntime, skillPath: string, extensions: readonly string[],
): string[] {
  return [
    ...buildInteractiveStartArgs(name, pane, runtime),
    "--no-skills", "--skill", skillPath, "--no-prompt-templates", "--no-context-files", "--no-extensions",
    ...extensions.flatMap((e) => ["-e", e]),
    "--tools", "read,write", "--name", name,
  ];
}

export type GeneratorResult =
  | { ok: true; text: string; outputPath: string; pane: string; session: string }
  | { ok: false; reason: string; pane?: string; outputPath: string };

export interface GeneratorDeps {
  exec: (args: string[]) => Promise<string>;
  readFile: (p: string) => string | undefined;
  exists: (p: string) => boolean;
  writeFile: (p: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onProgress?: (note: string) => void;
}

export interface GeneratorInput {
  request: GeneratePromptRequest;
  packet: GeneratorPacket;
  scratchDir: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  pollMs?: number;
  deadlineMs?: number;
}

export async function runGenerator(input: GeneratorInput, deps: GeneratorDeps): Promise<GeneratorResult> {
  const { request, packet, scratchDir, workspace } = input;
  const outputPath = packet.output.path;
  const taskNumber = request.task.number;
  const requestId = packet.requestId;
  const launchPath = path.join(scratchDir, "launch.json");
  const fail = (reason: string, pane?: string): GeneratorResult =>
    pane === undefined ? { ok: false, reason, outputPath } : { ok: false, reason, pane, outputPath };
  const record = (fields: Record<string, unknown>): void => {
    try {
      deps.writeFile(launchPath, JSON.stringify({ requestId, task: taskNumber, at: new Date(deps.now()).toISOString(), ...fields }, null, 2) + "\n");
    } catch { /* best effort */ }
  };
  const note = (text: string): void => { deps.onProgress?.(text); };

  const override = generatorRuntimeOverride(input.env);
  const runtime = override ?? generatorRuntime(request.workflow);
  if (!runtime) return fail("workflow has no generator role");
  // The shipped catalog names a neutral provider that no Pi serves. Without
  // an override file the launch can only fail inside Pi, so stop here.
  if (runtime.provider === NEUTRAL_PROVIDER_ID) {
    const config = loadWorkflowConfig(input.env, { readFile: deps.readFile, exists: (p) => deps.readFile(p) !== undefined });
    if (config.ok && config.config === undefined) {
      record({ outcome: "failed", reason: NO_OVERRIDE_REASON }); return fail(NO_OVERRIDE_REASON);
    }
  }
  // Capability gate: only when a probe was supplied. A failure blocks
  // the dispatch visibly; nothing is substituted and no tab is created.
  const probe = loadCapabilityProbe(input.env, deps.readFile);
  if (probe === undefined && request.workflow.requiresCapabilityProbe === true) {
    const reason = "Configured workflow requires a readable capability probe; dispatch blocked";
    record({ outcome: "failed", reason }); return fail(reason);
  }
  if (probe !== undefined) {
    if (!probe.ok) {
      const reason = `${probe.reason} (${probe.path}); dispatch blocked`;
      record({ outcome: "failed", reason }); return fail(reason);
    }
    const blocked = capabilityBlock(runtime, probe.capabilities);
    if (blocked !== undefined) {
      const reason = `runtime capability check failed: ${blocked}`;
      record({ outcome: "failed", reason }); return fail(reason);
    }
  }
  const skillPath = resolveSkillPath(input.env, deps.exists);
  if (!skillPath) return fail("generator skill not found");
  if (!isHerdrWorkspaceId(workspace)) return fail("workspace id unverified");

  const packetPath = path.join(scratchDir, "packet.json");
  try {
    deps.writeFile(packetPath, JSON.stringify(packet, null, 2) + "\n");
  } catch { return fail("packet could not be written"); }
  record({ outcome: "launching", runtime: runtimeLabel(runtime), overridden: override !== undefined });

  const session = generatorSessionName(taskNumber, requestId);
  note("generator: creating tab");
  let pane: string | undefined;
  try {
    let workspaceList: string | undefined;
    try { workspaceList = await deps.exec(["workspace", "list"]); } catch { /* opaque-ID fallback */ }
    const tabLabel = herdrRoleNameFromList(workspace, "generator", workspaceList);
    pane = parseTabCreate(await deps.exec(buildTabCreateArgs(workspace, scratchDir, tabLabel)), workspace);
  } catch { pane = undefined; }
  if (!pane) { record({ outcome: "failed", reason: "tab create failed" }); return fail("tab create failed"); }

  note(`generator: starting ${runtimeLabel(runtime)} in ${pane}`);
  try {
    await deps.exec(buildAgentStartArgs(session, pane, runtime, skillPath, requiredExtensions(input.agentDir)));
  } catch {
    const reason = `generator Pi failed to start in ${pane}`;
    record({ outcome: "failed", reason, pane }); return fail(reason, pane);
  }

  const get = async (): Promise<AgentRecord | undefined> => {
    try { return parseAgent(await deps.exec(["agent", "get", pane as string])); } catch { return undefined; }
  };
  const first = await get();
  if (!matchesAgentIdentity(first, { pane, cwd: scratchDir }) || first?.agent_status !== "idle") {
    const reason = `generator identity unverified in ${pane}`;
    record({ outcome: "failed", reason, pane }); return fail(reason, pane);
  }

  try {
    await deps.exec(buildPromptArgs(pane, buildGeneratorPrompt(packetPath, outputPath, requestId, taskNumber)));
  } catch {
    const reason = `generator prompt uncertain in ${pane}; inspect it`;
    record({ outcome: "uncertain", reason, pane }); return fail(reason, pane);
  }
  note("generator: prompted, waiting");
  record({ outcome: "prompted", pane, session });

  const pollMs = input.pollMs ?? 5000;
  const deadlineMs = input.deadlineMs ?? 360000;
  const start = deps.now();
  for (;;) {
    await deps.sleep(pollMs);
    const agent = await get();
    const status = agent?.agent_status;
    if (status === "blocked") {
      const reason = `generator blocked (approval/question) in ${pane}`;
      record({ outcome: "blocked", reason, pane, session }); return fail(reason, pane);
    }
    // Herdr reports a finished turn as `done` or `idle`.
    if (status === "idle" || status === "done") break;
    if (deps.now() - start > deadlineMs) {
      const reason = `generator timed out; inspect ${pane}`;
      record({ outcome: "timeout", reason, pane, session }); return fail(reason, pane);
    }
  }

  let text: string | undefined;
  try { text = deps.readFile(outputPath); } catch { text = undefined; }
  const validated = validateGeneratorOutput(text, requestId, taskNumber);
  if (!validated.ok) {
    record({ outcome: "failed", reason: validated.reason, pane, session }); return fail(validated.reason, pane);
  }
  record({ outcome: "ready", pane, session, output: outputPath });
  note("generator: done");
  return { ok: true, text: validated.text, outputPath, pane, session };
}

/** One in-flight generator per task; a duplicate start is refused. */
export function createGeneratorRegistry(): { start(taskNumber: number): boolean; finish(taskNumber: number): void; active(): readonly number[] } {
  const inFlight = new Set<number>();
  return {
    start(taskNumber) {
      if (inFlight.has(taskNumber)) return false;
      inFlight.add(taskNumber);
      return true;
    },
    finish(taskNumber) { inFlight.delete(taskNumber); },
    active() { return [...inFlight]; },
  };
}
