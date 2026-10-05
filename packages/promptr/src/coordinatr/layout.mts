import path from "node:path";
import {
  isHerdrPaneId, isHerdrTabId, isHerdrWorkspaceId,
} from "../herdr/identity.mts";

/**
 * /coordinatr right-column layout helpers (pure, no I/O).
 *
 * Design: original Pi stays left. One ordinary terminal companion sits
 * right, with queue/composer above and perpetual Markdown editor below.
 * It is not another Pi agent.
 *
 * - Split is always `right` so the promptr screen stays in the right column.
 * - CLI is invoked without an outer shell (pi.exec shell:false).
 * - Launcher strings contain only fixed code + user-controlled quoted paths.
 *   Note text and secrets never appear there.
 * - Parsers accept only the documented Herdr JSON envelopes and reject
 *   missing/mismatched identity rather than guessing.
 */

export type SplitDirection = "right";

export interface CallerIdentity {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string | undefined;
  cwd: string;
  sessionId: string | undefined;
  leafId: string | undefined;
}

export interface OwnedCompanion {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string | undefined;
  /** Pi session/leaf this binding was created for. Never reused across sessions. */
  sessionId: string | undefined;
  leafId: string | undefined;
  /** Runtime nonce fencing reloads. */
  nonce: string;
  createdAt: number;
  /** Human-only tracking label; opaque IDs remain authoritative. */
  trackingName?: string;
}

export type SchedulerState = "off" | "paused" | "armed" | "awaiting-recovery";

export type CoordinatrSubcommand = "ensure" | "status" | "pause" | "resume" | "off" | "recover" | "help";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True when Herdr caller context is present. Requires HERDR_ENV=1. */
export function isHerdrAvailable(env: NodeJS.ProcessEnv): boolean {
  return env.HERDR_ENV === "1" && (env.HERDR_PANE_ID?.length ?? 0) > 0;
}

/** Parse `/coordinatr [subcommand]`. Bare invocation ensures the right pane. */
export function parseCoordinatrArgs(args: string): CoordinatrSubcommand {
  const first = args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (first) {
    case "": return "ensure";
    case "status": return "status";
    case "pause": return "pause";
    case "resume": return "resume";
    case "off": return "off";
    case "recover": return "recover";
    case "help": return "help";
    default: return "help";
  }
}

/**
 * Build `herdr pane split` argv (no shell). Always right, explicit target,
 * explicit cwd, focus:false so the user's Pi stays left and focused.
 */
export function buildSplitArgs(caller: { paneId: string; cwd: string }): string[] {
  const target = caller.paneId;
  // Prefer --current when the caller is the current pane; the CLI also accepts
  // an explicit --pane id. We always pass an explicit target plus --no-focus.
  // Callers that know they are current pass paneId == $HERDR_PANE_ID and get
  // `--current`; anything else gets `--pane <id>` to avoid touching UI focus.
  void target;
  return [
    "pane", "split",
    "--current",
    "--direction", "right",
    "--cwd", caller.cwd,
    "--no-focus",
  ];
}

/** Build `herdr pane split` argv for an explicit non-current target pane. */
export function buildSplitArgsForPane(paneId: string, cwd: string): string[] {
  return ["pane", "split", "--pane", paneId, "--direction", "right", "--cwd", cwd, "--no-focus"];
}

/** POSIX single-quote a path. Only user-controlled absolute paths go here. */
export function posixQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Fixed launcher for `herdr pane run <paneId> <command>`.
 * Contains only fixed code + quoted user-controlled paths/ids:
 * `node <entry> demo [--tracking-file <snapshot>] [--state-dir <dir>] [--pi-pane <id>]`
 * — no note text, no secrets, no user input. The companion renders queue
 * above editor plus the Omakase-adapted Gitea tracking section. With
 * --state-dir it shares scratch/queue/composer with /promptr; with --pi-pane
 * Ctrl+S reviews one item and sends it via `herdr agent prompt` (explicit,
 * one item, attempted != delivered).
 */
export function buildCompanionCommand(companionEntryMjs: string, trackingFile?: string, stateDir?: string, piPane?: string, projectCwd?: string, piSession?: string): string | undefined {
  if (!path.isAbsolute(companionEntryMjs) || !path.isAbsolute(stateDir ?? "") || !isHerdrPaneId(piPane)
    || !path.isAbsolute(projectCwd ?? "") || !path.isAbsolute(piSession ?? "")) return undefined;
  const requiredStateDir = stateDir as string;
  const requiredPiPane = piPane as string;
  const requiredProjectCwd = projectCwd as string;
  const requiredPiSession = piSession as string;
  let command = `node ${posixQuote(companionEntryMjs)} demo`;
  if (trackingFile) command += ` --tracking-file ${posixQuote(trackingFile)}`;
  command += ` --state-dir ${posixQuote(requiredStateDir)}`;
  command += ` --pi-pane ${posixQuote(requiredPiPane)}`;
  command += ` --project-cwd ${posixQuote(requiredProjectCwd)}`;
  command += ` --pi-session ${posixQuote(requiredPiSession)}`;
  return command;
}

/** Extract a pane record from the several envelope shapes Herdr emits. */
function findPaneRecord(root: unknown): Record<string, unknown> | undefined {
  if (!isRecord(root)) return undefined;
  const result = root.result;
  if (!isRecord(result)) return undefined;
  // pane.split success: {result:{pane:{...}}}
  if (isRecord(result.pane) && typeof result.pane.pane_id === "string") return result.pane;
  // pane.get/current: {result:{pane:{...}, type:"pane_info"|"pane_current"|...}}
  if (isRecord(result.pane)) return result.pane;
  // Fallbacks for hypothetical shapes: {result:{new_pane:{...}}}, {result:{pane_id}}
  if (isRecord(result.new_pane)) return result.new_pane;
  return undefined;
}

export interface ParsedPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string | undefined;
  cwd: string | undefined;
  focused: boolean | undefined;
  agentStatus: string | undefined;
}

function parsePaneRecord(rec: Record<string, unknown>): ParsedPane | undefined {
  const paneId = asNonEmptyString(rec.pane_id);
  const workspaceId = asNonEmptyString(rec.workspace_id);
  const tabId = asNonEmptyString(rec.tab_id);
  if (!paneId || !workspaceId || !tabId) return undefined;
  if (!isHerdrPaneId(paneId) || !isHerdrWorkspaceId(workspaceId) || !isHerdrTabId(tabId)) return undefined;
  if (!paneId.startsWith(`${workspaceId}:`) || !tabId.startsWith(`${workspaceId}:`)) return undefined;
  return {
    paneId,
    workspaceId,
    tabId,
    terminalId: asNonEmptyString(rec.terminal_id),
    cwd: asNonEmptyString(rec.cwd) ?? asNonEmptyString(rec.foreground_cwd),
    focused: typeof rec.focused === "boolean" ? rec.focused : undefined,
    agentStatus: typeof rec.agent_status === "string" ? rec.agent_status : undefined,
  };
}

/** Parse `herdr pane split` stdout. New pane must differ from caller. */
export function parseSplitOutput(stdout: string, callerPaneId?: string): ParsedPane | undefined {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return undefined; }
  if (isRecord(json) && "error" in json) return undefined;
  const rec = findPaneRecord(json);
  if (!rec) return undefined;
  const pane = parsePaneRecord(rec);
  if (!pane) return undefined;
  if (callerPaneId && pane.paneId === callerPaneId) return undefined;
  return pane;
}

/** Parse a bounded `herdr pane list --workspace` response. */
export function parsePaneListOutput(stdout: string, workspaceId: string, limit = 32): ParsedPane[] | undefined {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return undefined; }
  if (!isRecord(json) || "error" in json || !isRecord(json.result)) return undefined;
  const raw = json.result.panes;
  if (!Array.isArray(raw) || raw.length > limit) return undefined;
  const panes: ParsedPane[] = [];
  for (const item of raw) {
    const pane = isRecord(item) ? parsePaneRecord(item) : undefined;
    if (!pane) return undefined;
    if (pane.workspaceId === workspaceId) panes.push(pane);
  }
  return panes;
}

export interface CompanionProcessEvidence {
  entry: string;
  stateDir: string;
  projectCwd: string;
  piPane: string;
  piSession: string;
}

/** Validate live foreground argv for the packaged `spike.mjs demo` companion. */
export function parseCompanionProcessInfo(stdout: string): CompanionProcessEvidence | undefined {
  let root: unknown;
  try { root = JSON.parse(stdout); } catch { return undefined; }
  const argvArrays: string[][] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      if (value.every((part) => typeof part === "string")) argvArrays.push(value as string[]);
      else value.forEach((part) => visit(part, depth + 1));
    } else if (isRecord(value)) Object.values(value).forEach((part) => visit(part, depth + 1));
  };
  visit(root, 0);
  for (const argv of argvArrays) {
    const entryIndex = argv.findIndex((part) => /(?:^|\/)spike\.mjs$/.test(part));
    if (entryIndex < 0 || argv[entryIndex + 1] !== "demo") continue;
    const option = (name: string): string | undefined => {
      const index = argv.indexOf(name, entryIndex + 2);
      return index >= 0 && typeof argv[index + 1] === "string" && !argv[index + 1]?.startsWith("--") ? argv[index + 1] : undefined;
    };
    const stateDir = option("--state-dir");
    const projectCwd = option("--project-cwd");
    const piPane = option("--pi-pane");
    const piSession = option("--pi-session");
    if (path.isAbsolute(stateDir ?? "") && path.isAbsolute(projectCwd ?? "")
      && isHerdrPaneId(piPane) && path.isAbsolute(piSession ?? "")) {
      return {
        entry: argv[entryIndex] as string,
        stateDir: stateDir as string,
        projectCwd: projectCwd as string,
        piPane,
        piSession: piSession as string,
      };
    }
  }
  return undefined;
}

/** Parse `herdr pane current --current` / `pane get` stdout. */
export function parsePaneInfoOutput(stdout: string): ParsedPane | undefined {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return undefined; }
  if (isRecord(json) && "error" in json) return undefined;
  const rec = findPaneRecord(json);
  if (!rec) return undefined;
  return parsePaneRecord(rec);
}

/**
 * Reuse check: the recorded companion is usable only when workspace, tab,
 * pane and (when known) terminal still match, and the Pi session/leaf that
 * created the binding is still current. Anything else must not redirect
 * submission — create a fresh split instead of reusing a moved/reused pane.
 */
export function isOwnedPaneUsable(binding: OwnedCompanion, live: ParsedPane, sessionId?: string | undefined, leafId?: string | undefined): boolean {
  if (live.paneId !== binding.paneId) return false;
  if (live.workspaceId !== binding.workspaceId) return false;
  if (live.tabId !== binding.tabId) return false;
  if (binding.terminalId && live.terminalId && live.terminalId !== binding.terminalId) return false;
  if (binding.sessionId && sessionId && binding.sessionId !== sessionId) return false;
  if (binding.leafId && leafId && binding.leafId !== leafId) return false;
  return true;
}

/** Short namespaced status for ctx.ui.setStatus("promptr:coordinatr", ...). */
export function statusText(state: SchedulerState, binding?: OwnedCompanion | undefined): string {
  switch (state) {
    case "off": return "coordinatr off";
    case "paused": return binding ? `coordinatr paused · right ${binding.paneId}` : "coordinatr paused (no companion)";
    case "armed": return binding ? `coordinatr armed · right ${binding.paneId}` : "coordinatr armed (no companion)";
    case "awaiting-recovery": return binding ? `coordinatr paused · recover ${binding.paneId}` : "coordinatr needs recovery";
  }
}

/** Human notice after ensure. Honest: initially paused, no auto-dispatch. */
export function ensureNotice(binding: OwnedCompanion, reused: boolean): string {
  return reused
    ? `Coordinator reuses right pane ${binding.paneId} (Pi stays left). Paused; no automatic sends.`
    : `Coordinator right pane ${binding.paneId} ready (Pi stays left). Paused; no automatic sends. Quit the companion with Ctrl+C y; /coordinatr-herdr off clears status without closing panes.`;
}
