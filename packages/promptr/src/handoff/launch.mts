/**
 * Same-runtime successor launch in a new Herdr tab.
 *
 * Every Herdr call goes through the injected `exec`; clock and sleep are
 * injected too, so tests run with a scripted executor and no real Herdr.
 * Order: preconditions, verify source identity, tab create, agent start,
 * poll readiness (<=60 s at 2 s; `agent_not_found` right after creation is
 * registration lag), submit the successor prompt exactly once. An uncertain
 * prompt outcome is reported as such and never retried.
 */
import { parseAgent, parseTabCreate } from "../generate/launch.mts";
import { isHerdrPaneInWorkspace, isHerdrWorkspaceId } from "../herdr/identity.mts";
import { herdrRoleNameFromList } from "../herdr/naming.mts";
import {
  buildSuccessorPrompt, successorName, type HandoffRuntime,
} from "./packet.mts";

export type HerdrExec = (args: string[]) => Promise<string>;

export interface HandoffLaunchDeps {
  exec: HerdrExec;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface HandoffLaunchInput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  slug: string;
  /** Absolute path of the source Pi session file (identity check). */
  sessionFile: string;
  runtime: HandoffRuntime | undefined;
  name: string;
  handoffPath: string;
  handoffText: string;
}

export type HandoffLaunchResult =
  | { ok: false; stage: "preconditions" | "source" | "tab" | "start" | "ready"; reason: string; pane?: string }
  | {
    ok: true; launch: "launched" | "uncertain"; workspace: string; pane: string; agentName: string; label: string;
    successorSession: string; promptedAt: string;
  };

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 2_000;

export function buildHandoffTabArgs(workspace: string, cwd: string, label: string): string[] {
  return ["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label, "--no-focus"];
}

/** Full interactive Coordinator peer: no extension, skill or tool restrictions. */
export function buildHandoffAgentStartArgs(name: string, pane: string, runtime: HandoffRuntime): string[] {
  return [
    "agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "60000",
    "--", "--provider", runtime.provider, "--model", runtime.model, "--thinking", runtime.thinking,
  ];
}

export function buildHandoffPromptArgs(pane: string, message: string): string[] {
  return ["agent", "prompt", pane, message, "--wait", "--until", "working", "--timeout", "10000"];
}

function isReadyStatus(status: unknown): boolean {
  return status === "idle" || status === "done";
}

export async function launchHandoffSuccessor(input: HandoffLaunchInput, deps: HandoffLaunchDeps): Promise<HandoffLaunchResult> {
  const workspace = input.env.HERDR_WORKSPACE_ID ?? "";
  const sourcePane = input.env.HERDR_PANE_ID ?? "";
  if (input.env.HERDR_ENV !== "1") return { ok: false, stage: "preconditions", reason: "not running under Herdr (HERDR_ENV != 1)" };
  if (!isHerdrWorkspaceId(workspace)) return { ok: false, stage: "preconditions", reason: "HERDR_WORKSPACE_ID missing or malformed" };
  if (!isHerdrPaneInWorkspace(sourcePane, workspace)) return { ok: false, stage: "preconditions", reason: "HERDR_PANE_ID missing, malformed or outside the workspace" };
  if (!input.runtime) return { ok: false, stage: "preconditions", reason: "runtime (provider/model/thinking) unresolved" };
  if (!input.sessionFile) return { ok: false, stage: "preconditions", reason: "source session file unknown" };
  const runtime = input.runtime;

  // Settled/UI-close status publication is asynchronous. Give the same source
  // a short window to report idle; never relax pane/cwd/session identity.
  const sourceDeadline = deps.now().getTime() + 4000;
  for (;;) {
    let source;
    try { source = parseAgent(await deps.exec(["agent", "get", sourcePane])); } catch { source = undefined; }
    if (!source || source.agent !== "pi" || source.pane_id !== sourcePane
      || source.cwd !== input.cwd || source.foreground_cwd !== input.cwd
      || source.agent_session?.kind !== "path" || source.agent_session?.value !== input.sessionFile) {
      return { ok: false, stage: "source", reason: "source Pi identity could not be verified" };
    }
    if (isReadyStatus(source.agent_status)) break;
    if (deps.now().getTime() >= sourceDeadline) {
      return { ok: false, stage: "source", reason: "source Pi did not become idle; handoff saved, nothing launched" };
    }
    await deps.sleep(250);
  }

  const at = deps.now();
  let workspaceList: string | undefined;
  try { workspaceList = await deps.exec(["workspace", "list"]); } catch { /* opaque-ID fallback */ }
  const label = herdrRoleNameFromList(workspace, "coordinator", workspaceList);
  const agentName = successorName(input.handoffText, at);
  let pane: string | undefined;
  try { pane = parseTabCreate(await deps.exec(buildHandoffTabArgs(workspace, input.cwd, label)), workspace); } catch { pane = undefined; }
  if (!pane || pane === sourcePane) return { ok: false, stage: "tab", reason: "herdr tab create returned no usable pane" };

  try { await deps.exec(buildHandoffAgentStartArgs(agentName, pane, runtime)); }
  catch (error) {
    return { ok: false, stage: "start", reason: `agent start failed: ${error instanceof Error ? error.message : "unknown"}`, pane };
  }

  const deadline = deps.now().getTime() + READY_TIMEOUT_MS;
  let successorSession: string | undefined;
  for (;;) {
    let out = "";
    try { out = await deps.exec(["agent", "get", pane]); } catch { out = ""; }
    const agent = parseAgent(out);
    if (agent && agent.agent === "pi" && agent.pane_id === pane && agent.cwd === input.cwd
      && agent.foreground_cwd === input.cwd && agent.agent_session?.kind === "path"
      && typeof agent.agent_session.value === "string" && isReadyStatus(agent.agent_status)) {
      successorSession = agent.agent_session.value;
      break;
    }
    // agent_not_found or a not-yet-idle record is registration lag; keep polling until the deadline.
    if (deps.now().getTime() >= deadline) {
      return { ok: false, stage: "ready", reason: "successor did not report ready within 60 s; inspect the new tab", pane };
    }
    await deps.sleep(READY_POLL_MS);
  }

  const message = buildSuccessorPrompt(input.name, input.handoffPath, input.sessionFile);
  const promptedAt = deps.now().toISOString();
  const base = { workspace, pane, agentName, label, successorSession, promptedAt };
  try {
    await deps.exec(buildHandoffPromptArgs(pane, message));
  } catch {
    return { ok: true, launch: "uncertain", ...base };
  }
  return { ok: true, launch: "launched", ...base };
}
