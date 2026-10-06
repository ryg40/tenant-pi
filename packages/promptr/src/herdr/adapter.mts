import { isHerdrPaneId, isHerdrPaneInWorkspace, herdrWorkspaceFromPaneId } from "./identity.mts";

export interface HerdrRuntime { provider: string; model: string; thinking: string }
export interface AgentRecord {
  agent?: unknown; pane_id?: unknown; cwd?: unknown; foreground_cwd?: unknown;
  agent_status?: unknown; agent_session?: { kind?: unknown; value?: unknown };
  terminal_id?: unknown; name?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A complete CLI envelope, not terminal text or an error with a result attached. */
export function parseHerdrResult(stdout: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(stdout) > 1024 * 1024) return undefined;
  try {
    const root: unknown = JSON.parse(stdout);
    return record(root) && !("error" in root) && record(root.result) ? root.result : undefined;
  } catch { return undefined; }
}

export function parseAgent(stdout: string): AgentRecord | undefined {
  const agent = parseHerdrResult(stdout)?.agent;
  return record(agent) ? agent as AgentRecord : undefined;
}

export function parseAgentList(stdout: string): AgentRecord[] | undefined {
  const agents = parseHerdrResult(stdout)?.agents;
  return Array.isArray(agents) && agents.length <= 256 && agents.every(record) ? agents : undefined;
}

export function parseTabCreate(stdout: string, workspace?: string): string | undefined {
  const pane = parseHerdrResult(stdout)?.root_pane;
  const id = record(pane) ? pane.pane_id : undefined;
  return isHerdrPaneId(id) && (workspace === undefined || isHerdrPaneInWorkspace(id, workspace)) ? id : undefined;
}

export function parseSplitPane(stdout: string, sourcePane: string): string | undefined {
  const pane = parseHerdrResult(stdout)?.pane;
  const id = record(pane) ? pane.pane_id : undefined;
  return id !== sourcePane && isHerdrPaneInWorkspace(id, herdrWorkspaceFromPaneId(sourcePane)) ? id : undefined;
}

export interface AgentIdentity {
  pane: string;
  cwd: string;
  session?: string;
  terminal?: string;
  name?: string;
  foreground?: boolean;
}

/** Optional expectations let existing callers keep their readiness policy. */
export function matchesAgentIdentity(agent: AgentRecord | undefined, expected: AgentIdentity): boolean {
  return agent !== undefined && agent.agent === "pi" && agent.pane_id === expected.pane
    && agent.cwd === expected.cwd && agent.agent_session?.kind === "path"
    && (expected.foreground !== true || agent.foreground_cwd === expected.cwd)
    && (expected.session === undefined || agent.agent_session.value === expected.session)
    && (expected.terminal === undefined || agent.terminal_id === expected.terminal)
    && (expected.name === undefined || agent.name === expected.name);
}

export function buildTabCreateArgs(workspace: string, cwd: string, label: string): string[] {
  return ["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label, "--no-focus"];
}

/** No restricted tools, skills or extensions unless the caller explicitly appends flags. */
export function buildInteractiveStartArgs(name: string, pane: string, runtime: HerdrRuntime): string[] {
  return ["agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "60000",
    "--", "--provider", runtime.provider, "--model", runtime.model, "--thinking", runtime.thinking];
}

export function buildPromptArgs(pane: string, text: string, wait = true): string[] {
  return ["agent", "prompt", pane, text, ...(wait ? ["--wait", "--until", "working", "--timeout", "10000"] : [])];
}

export function buildWaitArgs(pane: string, timeoutMs: number): string[] {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid wait bound");
  return ["agent", "wait", pane, "--timeout", String(timeoutMs)];
}
