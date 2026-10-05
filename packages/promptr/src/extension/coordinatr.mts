/**
 * /coordinatr wiring: idempotent right-column companion split.
 *
 * - Original Pi stays left; one ordinary companion terminal sits right.
 * - Never changes model/tools/context/name/draft/working role.
 * - Uses ctx.ui.setStatus("promptr:coordinatr", ...) — never setSessionName,
 *   setEditorText, setModel, setActiveTools or automatic system-prompt edits.
 * - Herdr CLI is invoked via pi.exec (shell:false). Launcher strings contain
 *   only fixed code + quoted user-controlled paths; note text never appears.
 * - Initially paused; automatic dispatch stays disabled (not qualified).
 * - `off` clears status and pauses; it never closes a pane on stale identity.
 *   The companion exits itself (Ctrl+C y).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildCompanionCommand, buildSplitArgs, ensureNotice, isHerdrAvailable,
  isOwnedPaneUsable, parseCompanionProcessInfo, parseCoordinatrArgs, parsePaneInfoOutput, parsePaneListOutput, parseSplitOutput,
  statusText, type OwnedCompanion, type ParsedPane, type SchedulerState,
} from "../coordinatr/layout.mts";
import { ensureDir, projectPaths } from "../state/paths.mts";
import { loadTrackingSnapshotForRepo } from "../tracking/cache.mts";
import { loadTrackerBinding } from "../tracking/binding-io.mts";
import { trackingStatusLine } from "../tracking/gitea.mts";
import { herdrRoleNameFromList } from "../herdr/naming.mts";

export const COORDINATR_STATUS_KEY = "promptr:coordinatr";
const HERDR_BIN = "herdr";
const EXEC_TIMEOUT_MS = 10_000;

type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
type StatusCtx = Pick<ExtensionContext, "ui">;

function currentCaller(ctx: Pick<ExtensionCommandContext, "cwd">): { paneId: string; workspaceId: string; tabId: string; terminalId: string | undefined; cwd: string } | undefined {
  const paneId = process.env.HERDR_PANE_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  if (!paneId || !workspaceId || !tabId) return undefined;
  return {
    paneId, workspaceId, tabId,
    terminalId: process.env.HERDR_TERMINAL_ID ?? undefined,
    cwd: ctx.cwd,
  };
}

/** Resolve the companion entry relative to this built module. No Pi aliases. */
export function resolveCompanionEntry(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url); // .../dist/src/extension/coordinatr.mjs
    const candidate = path.resolve(path.dirname(here), "../companion/spike.mjs");
    if (existsSync(candidate)) return candidate;
  } catch { /* fall through */ }
  return undefined;
}

export interface CoordinatrRuntime {
  state: SchedulerState;
  binding: OwnedCompanion | undefined;
  nonce: string;
  epoch: number;
}

export function createRuntime(): CoordinatrRuntime {
  return { state: "off", binding: undefined, nonce: randomUUID(), epoch: 0 };
}

async function herdrCurrent(exec: Exec): Promise<ParsedPane | undefined> {
  try {
    const res = await exec(HERDR_BIN, ["pane", "current", "--current"], { timeout: EXEC_TIMEOUT_MS });
    if (res.code !== 0 || res.killed) return undefined;
    return parsePaneInfoOutput(res.stdout);
  } catch { return undefined; }
}

async function herdrGet(exec: Exec, paneId: string): Promise<ParsedPane | undefined> {
  try {
    const res = await exec(HERDR_BIN, ["pane", "get", paneId], { timeout: EXEC_TIMEOUT_MS });
    if (res.code !== 0 || res.killed) return undefined;
    return parsePaneInfoOutput(res.stdout);
  } catch { return undefined; }
}

function toOpt(value: string | null): string | undefined {
  return value ?? undefined;
}

export function registerCoordinatr(pi: ExtensionAPI, rt: CoordinatrRuntime = createRuntime(), commandName = "coordinatr"): CoordinatrRuntime {
  const setStatus = (ctx: StatusCtx): void => {
    try {
      if (rt.state === "off") ctx.ui.setStatus(COORDINATR_STATUS_KEY, undefined);
      else ctx.ui.setStatus(COORDINATR_STATUS_KEY, statusText(rt.state, rt.binding));
    } catch { /* status is advisory */ }
  };

  pi.on("session_shutdown", (_event, ctx) => {
    rt.epoch++;
    if (rt.state !== "off") {
      rt.state = "awaiting-recovery";
      try { setStatus(ctx); } catch { /* ignore */ }
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    // Tree navigation invalidates active evidence and pauses. History is a
    // journal, never rewound with the conversation tree.
    rt.epoch++;
    if (rt.state === "armed") {
      rt.state = "paused";
      try { setStatus(ctx); } catch { /* ignore */ }
    }
  });

  pi.registerCommand(commandName, {
    description: `${commandName === "coordinatr" ? "" : "Legacy Herdr launcher: "}Keep Pi left, ensure the Promptr companion in the right column (paused; no auto-send)`,
    handler: async (args, ctx) => {
      const sub = parseCoordinatrArgs(args);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`Coordinatr needs the interactive Pi UI. Run /${commandName} in the terminal UI; offline notebook remains available.`, "warning");
        return;
      }
      if (!isHerdrAvailable(process.env)) {
        ctx.ui.notify("Coordinatr needs Herdr (HERDR_ENV=1). No split or fallback agent; offline standalone notebook remains available.", "warning");
        return;
      }
      const caller = currentCaller(ctx);
      if (!caller) {
        ctx.ui.notify("Cannot determine the current Herdr pane. No split performed.", "warning");
        return;
      }
      const exec = (pi as unknown as { exec?: Exec }).exec?.bind(pi) as Exec | undefined;
      if (!exec) {
        ctx.ui.notify("Extension host has no exec capability. No split performed.", "error");
        return;
      }
      const sessionId: string = ctx.sessionManager.getSessionId();
      const leafId: string | undefined = toOpt(ctx.sessionManager.getLeafId());
      const generation = rt.epoch;
      const isCurrent = (): boolean => rt.epoch === generation
        && ctx.sessionManager.getSessionId() === sessionId
        && toOpt(ctx.sessionManager.getLeafId()) === leafId;

      if (sub === "status") {
        const b = rt.binding ? ` right=${rt.binding.paneId} tab=${rt.binding.tabId}` : " (no companion)";
        let tracking = "tracking: no snapshot — /work-status refreshes (Gitea authoritative)";
        try {
          const paths = projectPaths(ctx.cwd);
          const binding = loadTrackerBinding(ctx.cwd, process.env);
          const snapshot = loadTrackingSnapshotForRepo(paths.tracking, binding.resolution.ok ? binding.resolution.config.repo : undefined);
          tracking = binding.resolution.ok
            ? (snapshot ? trackingStatusLine(snapshot) : `tracking: ${binding.resolution.config.repo.owner}/${binding.resolution.config.repo.repo} — no snapshot`)
            : `tracking: ${binding.resolution.reason}`;
        } catch { /* advisory only */ }
        ctx.ui.notify(`coordinatr ${rt.state}${b}. Pi stays left; companion is an ordinary terminal, not an agent. Auto-dispatch disabled.\n${tracking}`, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(`/${commandName} [status|pause|resume|off|recover] — bare /${commandName} ensures the right-column companion (paused) with Gitea tracking. /work-status browses milestones/issues. Auto-send stays off.`, "info");
        return;
      }
      if (sub === "pause") {
        if (rt.state !== "off") rt.state = "paused";
        setStatus(ctx);
        ctx.ui.notify("Coordinator paused. Companion stays right; nothing will auto-send.", "info");
        return;
      }
      if (sub === "resume") {
        if (rt.state === "off") {
          ctx.ui.notify(`Coordinator is off. Run bare /${commandName} to ensure the right pane first.`, "warning");
          return;
        }
        // Resume arms explicit work only. Qualified FIFO auto-dispatch
        // remains unavailable; this never starts background sends by itself.
        rt.state = "armed";
        setStatus(ctx);
        ctx.ui.notify("Coordinator armed for explicit sends only. Automatic queue draining stays disabled.", "info");
        return;
      }
      if (sub === "off") {
        // Pause, revoke auto capability and flush status. Preserve
        // notebook/queue/composer. Never pane.close on stale identity; the
        // companion exits itself (Ctrl+C y) or the user closes the pane.
        rt.state = "off";
        setStatus(ctx);
        ctx.ui.notify("Coordinator off. Status cleared; queue/note preserved. Right pane left open — quit the companion (Ctrl+C y) or close it manually.", "info");
        return;
      }
      const companionEntry = resolveCompanionEntry();
      if (!companionEntry) {
        ctx.ui.notify("Companion entry not found beside the extension. No split performed.", "error");
        return;
      }
      let paths: ReturnType<typeof projectPaths> | undefined;
      try { paths = projectPaths(ctx.cwd); } catch { paths = undefined; }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!paths || !sessionFile || !path.isAbsolute(sessionFile)) {
        rt.binding = undefined;
        if (rt.state !== "off") rt.state = "awaiting-recovery";
        ctx.ui.notify("Cannot determine the absolute Pi session/state binding. No split or companion launch performed.", "warning");
        return;
      }
      const processMatches = (process: NonNullable<ReturnType<typeof parseCompanionProcessInfo>>): boolean =>
        process.entry === companionEntry && process.projectCwd === ctx.cwd
        && process.stateDir === paths.dir && process.piPane === caller.paneId
        && process.piSession === sessionFile;
      const validateRecorded = async (bound: OwnedCompanion): Promise<ParsedPane | undefined> => {
        const live = await herdrGet(exec, bound.paneId);
        if (!live || !isOwnedPaneUsable(bound, live, sessionId, leafId)) return undefined;
        try {
          const info = await exec(HERDR_BIN, ["pane", "process-info", "--pane", bound.paneId], { timeout: EXEC_TIMEOUT_MS });
          if (info.code !== 0 || info.killed) return undefined;
          const process = parseCompanionProcessInfo(info.stdout);
          return process && processMatches(process) ? live : undefined;
        } catch { return undefined; }
      };

      if (sub === "recover") {
        const bound = rt.binding;
        if (!bound) {
          ctx.ui.notify(`No recorded companion. Run bare /${commandName} to create the right pane.`, "warning");
          return;
        }
        const live = await validateRecorded(bound);
        if (!isCurrent()) return;
        if (live) {
          rt.state = "paused";
          setStatus(ctx);
          ctx.ui.notify(`Recovered right pane ${bound.paneId}. Paused; no automatic sends.`, "info");
        } else {
          rt.binding = undefined;
          rt.state = "awaiting-recovery";
          setStatus(ctx);
          ctx.ui.notify(`Recorded pane ${bound.paneId} is missing/moved/reused. Run bare /${commandName} for a fresh right split; nothing was redirected.`, "warning");
        }
        return;
      }

      // sub === "ensure": idempotent right split, Pi stays left.
      // Reuse only after authenticated pane/process identity checks.
      const existing = rt.binding;
      if (existing) {
        const live = await validateRecorded(existing);
        if (!isCurrent()) return;
        if (live) {
          if (rt.state === "off") rt.state = "paused";
          setStatus(ctx);
          ctx.ui.notify(ensureNotice(existing, true), "info");
          return;
        }
        // Stale binding: clear it and discover from live process evidence.
        rt.binding = undefined;
      }

      let workspaceList: string | undefined;
      try {
        const listed = await exec(HERDR_BIN, ["workspace", "list"], { timeout: EXEC_TIMEOUT_MS });
        if (listed.code === 0 && !listed.killed) workspaceList = listed.stdout;
      } catch { /* opaque-ID fallback */ }
      const trackingName = herdrRoleNameFromList(caller.workspaceId, "coordinator", workspaceList);

      // Runtime/reload-safe discovery: labels are advisory; only live pane and
      // foreground argv evidence authorizes reuse. The list is hard-bounded.
      let liveCompanions: Array<{ pane: ParsedPane; process: ReturnType<typeof parseCompanionProcessInfo> }> = [];
      let discoveryReliable = false;
      try {
        const listed = await exec(HERDR_BIN, ["pane", "list", "--workspace", caller.workspaceId], { timeout: EXEC_TIMEOUT_MS });
        const panes = listed.code === 0 && !listed.killed ? parsePaneListOutput(listed.stdout, caller.workspaceId, 32) : undefined;
        if (panes) {
          discoveryReliable = true;
          for (const pane of panes) {
            const info = await exec(HERDR_BIN, ["pane", "process-info", "--pane", pane.paneId], { timeout: EXEC_TIMEOUT_MS });
            if (info.code !== 0 || info.killed) { discoveryReliable = false; break; }
            const process = parseCompanionProcessInfo(info.stdout);
            if (process) liveCompanions.push({ pane, process });
          }
        }
      } catch { discoveryReliable = false; }
      if (!isCurrent()) return;
      if (!discoveryReliable) {
        ctx.ui.notify(`Could not validate live panes in workspace ${caller.workspaceId}. No duplicate created; retry /${commandName} when Herdr is settled.`, "warning");
        return;
      }
      if (liveCompanions.length > 1) {
        ctx.ui.notify(`Multiple live Promptr companions already exist in workspace ${caller.workspaceId}. No duplicate created; resolve the conflict manually.`, "warning");
        return;
      }
      if (liveCompanions.length === 1) {
        const found = liveCompanions[0] as { pane: ParsedPane; process: NonNullable<ReturnType<typeof parseCompanionProcessInfo>> };
        const exact = processMatches(found.process);
        try { await exec(HERDR_BIN, ["pane", "focus", "--pane", found.pane.paneId, "--direction", "right"], { timeout: EXEC_TIMEOUT_MS }); } catch { /* best effort */ }
        if (!exact) {
          ctx.ui.notify(`Workspace ${caller.workspaceId} already has a live Promptr companion in ${found.pane.paneId} for another source/project. Focus attempted; no duplicate created and sends were not redirected.`, "warning");
          return;
        }
        rt.binding = {
          paneId: found.pane.paneId, workspaceId: found.pane.workspaceId, tabId: found.pane.tabId,
          terminalId: found.pane.terminalId, sessionId, leafId, nonce: rt.nonce, createdAt: Date.now(), trackingName,
        };
        if (rt.state === "off" || rt.state === "awaiting-recovery") rt.state = "paused";
        setStatus(ctx);
        ctx.ui.notify(ensureNotice(rt.binding, true), "info");
        return;
      }

      // Verify current pane identity before mutating layout.
      const current = await herdrCurrent(exec);
      if (!isCurrent()) return;
      if (!current || current.paneId !== caller.paneId) {
        rt.state = existing ? "awaiting-recovery" : rt.state;
        try { setStatus(ctx); } catch { /* ignore */ }
        ctx.ui.notify(`Current Herdr pane identity changed. No split performed; re-run /${commandName} when settled.`, "warning");
        return;
      }

      let splitRes;
      try {
        splitRes = await exec(HERDR_BIN, buildSplitArgs({ paneId: caller.paneId, cwd: caller.cwd }), { timeout: EXEC_TIMEOUT_MS });
      } catch {
        ctx.ui.notify("Herdr split failed to launch. No layout changed.", "error");
        return;
      }
      if (!isCurrent()) return;
      if (!splitRes || splitRes.code !== 0 || splitRes.killed) {
        ctx.ui.notify(`Herdr split failed (code ${splitRes?.code ?? "?"}). No layout changed.`, "error");
        return;
      }
      const created = parseSplitOutput(splitRes.stdout, caller.paneId);
      if (!created) {
        ctx.ui.notify("Herdr split returned no usable pane. No companion launched.", "error");
        return;
      }

      // Launch the ordinary companion process in the owned right pane.
      // Fixed code + quoted user paths/ids only; no note text or secrets.
      // The tracking snapshot path is user-controlled state; the companion
      // reads it best-effort (placeholder when missing) and never writes it.
      // --state-dir shares scratch/queue/composer with /promptr (full parity);
      // --pi-pane enables explicit one-item direct send via herdr agent prompt.
      let trackingFile: string | undefined;
      let stateDir: string | undefined;
      try {
        if (paths) {
          try { ensureDir(paths.dir); } catch { /* advisory */ }
          trackingFile = paths.tracking;
          stateDir = paths.dir;
        }
      } catch {
        trackingFile = undefined;
        stateDir = undefined;
      }
      const launcher = buildCompanionCommand(companionEntry, trackingFile, stateDir, caller.paneId, ctx.cwd, sessionFile);
      if (!launcher) {
        ctx.ui.notify("Companion runtime binding is incomplete. No companion launched.", "error");
        return;
      }
      const recordBinding = (): OwnedCompanion => ({
        paneId: created.paneId,
        workspaceId: created.workspaceId,
        tabId: created.tabId,
        terminalId: created.terminalId,
        sessionId,
        leafId,
        nonce: rt.nonce,
        createdAt: Date.now(),
        trackingName,
      });
      try {
        const runRes = await exec(HERDR_BIN, ["pane", "run", created.paneId, launcher], { timeout: EXEC_TIMEOUT_MS });
        if (!isCurrent()) return;
        if (!runRes || runRes.code !== 0 || runRes.killed) {
          ctx.ui.notify(`Right pane ${created.paneId} created but companion launch failed. Pane left open; nothing auto-sends.`, "error");
          rt.binding = undefined;
          rt.state = "awaiting-recovery";
          setStatus(ctx);
          return;
        }
      } catch {
        ctx.ui.notify(`Right pane ${created.paneId} created but companion launch threw. Pane left open; nothing auto-sends.`, "error");
        rt.binding = undefined;
        rt.state = "awaiting-recovery";
        setStatus(ctx);
        return;
      }

      rt.binding = recordBinding();
      try {
        await exec(HERDR_BIN, ["pane", "rename", created.paneId, trackingName], { timeout: EXEC_TIMEOUT_MS });
        await exec(HERDR_BIN, ["pane", "report-metadata", created.paneId, "--source", "promptr", "--agent", trackingName,
          "--token", `workspace=${caller.workspaceId}`, "--token", `project=${ctx.cwd}`], { timeout: EXEC_TIMEOUT_MS });
      } catch { /* display metadata is best effort */ }
      // Initially paused; no queue starts merely by enabling.
      if (rt.state === "off" || rt.state === "awaiting-recovery") rt.state = "paused";
      else if (rt.state !== "armed") rt.state = "paused";
      setStatus(ctx);
      const bound: OwnedCompanion | undefined = rt.binding;
      if (bound) ctx.ui.notify(ensureNotice(bound, false), "info");
    },
  });

  return rt;
}
