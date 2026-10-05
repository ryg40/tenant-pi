import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite } from "../state/paths.mts";
import { herdrWorkspaceFromPaneId, isHerdrPaneId } from "../herdr/identity.mts";
import { herdrRoleNameFromList } from "../herdr/naming.mts";
import type { BriefingDialogs } from "../briefing/overview.mts";
import { validateBriefing } from "../briefing/openknowledge.mts";
import type { HerdrExecutor } from "./briefing-send.mts";

/**
 * Start fresh: launch a normal interactive Pi Coordinator through Herdr and
 * submit the reviewed briefing once. Never a subagent, never a hosted-only
 * shortcut: both the split companion and hosted /promptr use this Herdr flow.
 *
 * Order is fixed: verify source identity, confirm explicitly, re-verify,
 * save the packet, then split/start/verify/prompt. Cancel or any failed
 * check launches nothing. An uncertain outcome retains the packet with
 * inspect guidance; replays are blocked, never blind-retried.
 */

export interface FreshSource { pane: string; sessionFile: string; cwd: string }
export interface FreshRuntime { provider: string; model: string; thinking: string }

const execute = promisify(execFile);
/** agent start waits up to 60s for readiness; the 15s prompt executor is too short. */
export const executeHerdrFresh: HerdrExecutor = async args => {
  const result = await execute("herdr", args, { timeout: 90000, maxBuffer: 1024 * 1024 });
  return result.stdout;
};

/** Exact runtime of the launching process. Missing binding refuses launch. */
export function readSourceRuntime(env: NodeJS.ProcessEnv = process.env): FreshRuntime | undefined {
  const provider = env.PI_PROVIDER?.trim();
  const model = env.PI_MODEL?.trim();
  const thinking = env.PI_REASONING_LEVEL?.trim();
  if (!provider || !model || !thinking) return undefined;
  return { provider, model, thinking };
}

function sanitizeNamePart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "project";
}

/** Lowercase-safe successor session name. Herdr display labels may differ. */
export function freshSessionName(cwd: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").toLowerCase();
  return `promptr-fresh-${sanitizeNamePart(path.basename(cwd))}-${stamp}`.slice(0, 80);
}

function freshNameForText(cwd: string, text: string): string {
  const base = freshSessionName(cwd);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 6);
  return `${base}-${hash}`.slice(0, 80);
}

/**
 * Split the SOURCE main pane right for the successor home. Explicit --pane
 * (never --current: the companion is not the source), explicit cwd, runtime
 * env pinned so the new shell inherits the exact source runtime.
 */
export function buildFreshSplitArgs(source: FreshSource, runtime: FreshRuntime): string[] {
  return [
    "pane", "split", "--pane", source.pane,
    "--direction", "right", "--cwd", source.cwd, "--no-focus",
    "--env", `PI_PROVIDER=${runtime.provider}`,
    "--env", `PI_MODEL=${runtime.model}`,
    "--env", `PI_REASONING_LEVEL=${runtime.thinking}`,
  ];
}

/** Start canonical Pi in the new pane with the exact source runtime flags. */
export function buildFreshAgentStartArgs(name: string, paneId: string, runtime: FreshRuntime, displayName?: string): string[] {
  return [
    "agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000",
    "--", "--provider", runtime.provider, "--model", runtime.model, "--thinking", runtime.thinking,
    ...(displayName ? ["--name", displayName] : []),
  ];
}

function packetPath(source: FreshSource, text: string): string {
  const key = createHash("sha256").update(source.sessionFile).update("\0").update(text).digest("hex");
  return path.join(source.cwd, ".promptr", "briefing-history", `${key}-fresh-attempt.json`);
}

interface AgentRecord {
  agent?: unknown; pane_id?: unknown; cwd?: unknown; foreground_cwd?: unknown;
  agent_status?: unknown; agent_session?: { kind?: unknown; value?: unknown }; terminal_id?: unknown;
}

function parseAgent(stdout: string): AgentRecord | undefined {
  try {
    const data = JSON.parse(stdout);
    return data?.result?.agent as AgentRecord | undefined;
  } catch { return undefined; }
}

async function readySource(source: FreshSource, exec: HerdrExecutor): Promise<string> {
  const agent = parseAgent(await exec(["agent", "get", source.pane]));
  if (!agent || agent.agent !== "pi" || agent.pane_id !== source.pane
    || agent.cwd !== source.cwd || agent.foreground_cwd !== source.cwd
    || agent.agent_status !== "idle" || agent.agent_session?.kind !== "path"
    || agent.agent_session?.value !== source.sessionFile || typeof agent.terminal_id !== "string") {
    throw new Error("Source Pi identity/readiness changed.");
  }
  return agent.terminal_id;
}

async function readySuccessor(paneId: string, cwd: string, exec: HerdrExecutor): Promise<{ terminal: string; session: string }> {
  const agent = parseAgent(await exec(["agent", "get", paneId]));
  if (!agent || agent.agent !== "pi" || agent.pane_id !== paneId
    || agent.cwd !== cwd || agent.foreground_cwd !== cwd || agent.agent_status !== "idle"
    || agent.agent_session?.kind !== "path" || typeof agent.agent_session?.value !== "string"
    || typeof agent.terminal_id !== "string") {
    throw new Error("Successor identity/readiness unverified.");
  }
  return { terminal: agent.terminal_id, session: agent.agent_session.value };
}

function parseSplitPane(stdout: string, sourcePane: string): string | undefined {
  try {
    const data = JSON.parse(stdout);
    if (data && typeof data === "object" && "error" in data) return undefined;
    const pane = (data as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane;
    const id = typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
    if (!isHerdrPaneId(id) || id === sourcePane
      || herdrWorkspaceFromPaneId(id) !== herdrWorkspaceFromPaneId(sourcePane)) return undefined;
    return id;
  } catch { return undefined; }
}

/** Explicit Start fresh. Returns true only when a launch sequence ran. */
export async function startFreshBriefingInNewPi(
  text: string, source: FreshSource, ui: BriefingDialogs,
  exec: HerdrExecutor = executeHerdrFresh, env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  validateBriefing(text);
  if (!isHerdrPaneId(source.pane) || !path.isAbsolute(source.sessionFile) || !path.isAbsolute(source.cwd)) {
    ui.notify("No verified source Pi binding. Reopen the companion with /coordinatr-herdr (or run /promptr workspace under Herdr); nothing launched.", "warning");
    return false;
  }
  if (!text.trim() || /^[\/!]/.test(text.trimStart())) {
    ui.notify("Use a non-empty Markdown briefing, not a slash or shell command. Nothing launched.", "warning");
    return false;
  }
  const runtime = readSourceRuntime(env);
  if (!runtime) {
    ui.notify("Source runtime (PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL) is unavailable; exact binding required. Nothing launched.", "warning");
    return false;
  }
  const packet = packetPath(source, text);
  if (existsSync(packet)) {
    ui.notify(`Start fresh already attempted for this briefing; inspect the recorded successor before any manual recovery. Packet: ${packet}. No retry.`, "warning");
    return false;
  }
  let sourceTerminal: string;
  try { sourceTerminal = await readySource(source, exec); }
  catch { ui.notify("Cannot verify idle source Pi in the original project/session. Nothing launched.", "warning"); return false; }
  const name = freshNameForText(source.cwd, text);
  if (!await ui.confirm("Start fresh Pi Coordinator through Herdr?",
    `Successor: ${name} (new right pane split from ${source.pane}; normal interactive Pi, not a subagent)\n`
    + `cwd: ${source.cwd}\nprovider: ${runtime.provider}\nmodel: ${runtime.model}\nthinking: ${runtime.thinking}\n`
    + `Source: ${source.pane} (${source.sessionFile}); must stay idle until launch.\n`
    + `Submits the reviewed briefing once via herdr agent prompt. Old session stops writing on transfer.\n\n${text}`)) return false;
  try {
    if (await readySource(source, exec) !== sourceTerminal || existsSync(packet)) throw new Error("Source changed");
    atomicWrite(packet, JSON.stringify({
      kind: "start-fresh", source: { ...source, terminal: sourceTerminal },
      runtime, successor: { name }, text, outcome: "attempted/unknown", at: new Date().toISOString(),
    }, null, 2) + "\n");
  } catch { ui.notify("Source changed or packet could not be saved; nothing launched.", "warning"); return false; }

  let freshPane: string;
  try {
    const splitOut = await exec(buildFreshSplitArgs(source, runtime));
    const id = parseSplitPane(splitOut, source.pane);
    if (!id) throw new Error("No usable pane");
    freshPane = id;
  } catch { ui.notify(`Successor pane split failed; nothing launched. Packet retained: ${packet}.`, "warning"); return false; }

  try {
    const workspace = herdrWorkspaceFromPaneId(source.pane) as string;
    let workspaceList: string | undefined;
    try { workspaceList = await exec(["workspace", "list"]); } catch { /* opaque-ID fallback */ }
    const displayName = herdrRoleNameFromList(workspace, "coordinator", workspaceList);
    await exec(buildFreshAgentStartArgs(name, freshPane, runtime, displayName));
  } catch { ui.notify(`Successor Pi failed to start in ${freshPane}; inspect the pane. Packet retained: ${packet}. No retry.`, "warning"); return false; }

  let successorSession: string;
  try {
    successorSession = (await readySuccessor(freshPane, source.cwd, exec)).session;
  } catch { ui.notify(`Successor in ${freshPane} failed identity/readiness; nothing submitted. Inspect the pane; prompt it manually if healthy. Packet retained: ${packet}.`, "warning"); return false; }

  try {
    await exec(["agent", "prompt", freshPane, text, "--wait", "--until", "working", "--timeout", "10000"]);
  } catch { ui.notify(`Successor prompt uncertain in ${freshPane}; inspect it before any manual recovery. Packet retained: ${packet}. No retry.`, "warning"); return true; }

  try {
    const prior = JSON.parse(readFileSync(packet, "utf8"));
    writeFileSync(packet, JSON.stringify({
      ...prior, successor: { name, pane: freshPane, session: successorSession },
      outcome: "transferred", transferredAt: new Date().toISOString(),
    }, null, 2) + "\n");
  } catch { /* transfer happened; packet update is best-effort */ }
  ui.notify(`Fresh Pi Coordinator ${name} running in ${freshPane} (session ${successorSession}); briefing submitted once. Transfer recorded — the old session must stop mutating this project. Packet: ${packet}.`, "info");
  return true;
}
