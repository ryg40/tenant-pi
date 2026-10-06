/**
 * Promptr one-shot Pi extension.
 *
 * proqi-style prompt queue + composer inside Pi, plus:
 * - per-project progress checkpoints (`/promptr-save`, `/promptr-status`)
 * - staged continuation prompts for successor sessions (`/handoffr`, `/promptr-resume`)
 *
 * All submission is explicit, one item at a time, via Pi's public
 * `sendUserMessage` with template expansion disabled. Attempted != delivered.
 */
import { BriefingStore } from "../briefing/store.mts";
import { BriefingOverview } from "./briefing.mts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CompanionSpikeView, PANEL_TRACKING_ROWS, PasteGuard, isSupportedText, type CompanionSessionState } from "../companion/view.mts";
import { attemptReviewedItem, attemptSingleDialog } from "./manual-send.mts";
import { emptyQueue, enqueue, parseQueue, serializeQueue, type PendingItem, type PendingQueue } from "../queue/pending.mts";
import {
  projectPaths, ensureDir, atomicWrite, readText, appendText, listFiles, stateRoot,
  type ProjectPaths,
} from "../state/paths.mts";
import { clientIdentity } from "../state/client.mts";
import {
  appendPromptLog, diffQueueEvents, promptLogFiles, syncPromptLog, type PromptLogInput,
} from "../sync/prompt-log.mts";
import { defaultProjectLabel, projectPagesFor } from "../sync/project-pages.mts";
import { OpenKnowledgeClient } from "../briefing/openknowledge.mts";
import { gitRemoteUrl } from "../git/snapshot.mts";
import { buildProbe } from "../doctor/cli.mts";
import { renderDoctor, runDoctor } from "../doctor/doctor.mts";
import { loadProgress, appendProgress, renderStatus } from "../progress/tracker.mts";
import {
  autoStatusLine, buildAutoWorkState, defaultAutoCheckRecord, loadAutoRecordFile,
  maybeAutoCheckpoint, saveAutoRecordFile,
  type AutoCheckRecord, type AutoWorkState,
} from "../progress/autoCheckpoint.mts";
import type { GitSnapshot } from "../git/snapshot.mts";
import { handoffFilename } from "../handoff/builder.mts";
import {
  autoWrapFilename, currentTokensOf, runAutoWrap, shouldAutoWrap, WRAP_THRESHOLD_TOKENS,
} from "../handoff/autoWrap.mts";
import { startFreshBriefingInNewPi } from "../companion/briefing-fresh.mts";
import {
  buildHandoffAuthorPrompt, buildHandoffEvidence, handoffSyncMarker, parseReceipt, resolveHandoffRuntime,
  runtimeTriple, validateHandoff, type HandoffReceipt,
} from "../handoff/packet.mts";
import { launchHandoffSuccessor } from "../handoff/launch.mts";
import { OpenKnowledgeBriefing } from "../briefing/openknowledge.mts";
import { gitSnapshot } from "../git/snapshot.mts";
import { registerCoordinatr } from "./coordinatr.mts";
import { registerSidebar } from "../sidebar/controller.mts";
import {
  buildIssueStartPrompt, renderBoardLines,
  renderFullText, renderPlaceholderLines, sanitizeLine, shortMilestone, type TrackingSnapshot,
} from "../tracking/gitea.mts";
import { homedir } from "node:os";
import { trackingPorts } from "../tracking/ports.mts";
import { trackerLabel } from "../tracking/config.mts";
import { bindingSourceSuffix, providerDefaultHost, providerDefaultOwner, tokenVariableFor, trackerBindingFiles, validateTrackerBinding, DEFAULT_GITHUB_HOST } from "../tracking/binding.mts";
import { loadTrackerBinding, nodeBindingIoDeps, writeTrackerBinding } from "../tracking/binding-io.mts";
import { TrackingNavigationController } from "../tracking/selection.mts";
import { TrackingModal } from "../companion/tracking-dialogs.mts";
import { catalogPort } from "../workflow/catalog.mts";
import { loadEffectiveCatalog, nodeWorkflowLoadDeps } from "../workflow/load.mts";
import {
  capabilitiesFromRegistry, checkExpansion, describeRoleChecks, serializeCapabilityProbe, summarizeRoleChecks,
  type RegistryModel,
} from "../workflow/registry.mts";
import { resolveCapabilityProbeFile } from "../workflow/load.mts";
import { buildTaskPromptDraft } from "../tracking/prompt-draft.mts";
import { requestFileName } from "../companion/host-tracking.mts";
import type { BoardIssue } from "../tracking/board.mts";
import { HOSTED_GENERATE_NOTICE, hostedBoard, parseCatchUpArgs, placeDraft } from "./hosted-tracking.mts";
// Catch-Me-Up: deterministic gather, hosted command and packet attach.
import { catchUpDraftLines } from "../tracking/catchup.mts";
import {
  catchUpCursorLine, loadFreshCatchUp, nodeCatchUpFs, nodeGitExec, parseCatchUpCursor, runCatchUp, type CatchUpDeps,
} from "../tracking/catchup-sources.mts";
import { isTrackingStale, loadTrackingSnapshotForRepo, saveTrackingSnapshot } from "../tracking/cache.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_FALLBACK = "Write a sample note here.\n\nTab to panel; arrows select lines, Enter queues a copy.\n\nTab to composer; type a prompt, Ctrl+S queues it and reviews in one step.\nCtrl+S reviews the queue and offers explicit submission to Pi.\n";

// ---- durable helpers (never throw outward; fall back to memory) ----

function loadQueueFile(file: string): PendingQueue {
  const raw = readText(file);
  if (!raw) return emptyQueue();
  try { return parseQueue(raw); } catch { return emptyQueue(); }
}

function saveQueueFile(file: string, queue: PendingQueue): void {
  try { atomicWrite(file, serializeQueue(queue)); } catch { /* memory-only fallback */ }
}

function loadScratch(file: string): { text: string; seeded: boolean } {
  const raw = readText(file);
  if (typeof raw === "string" && raw.length > 0 && isSupportedText(raw)) return { text: raw, seeded: false };
  // seeded marks the in-memory fallback: display-only until the user types
  // real notes, so persist() must not write it over scratch.md (see below).
  return { text: SCRATCH_FALLBACK, seeded: true };
}

function saveScratch(file: string, text: string): void {
  if (!isSupportedText(text)) return; // never persist out-of-contract bytes
  try { atomicWrite(file, text); } catch { /* ignore */ }
}

function enqueueText(queue: PendingQueue, text: string): PendingQueue {
  return enqueue(queue, { expectedRevision: queue.revision, requestId: randomUUID(), text });
}

function queueTexts(queue: PendingQueue): string[] {
  return queue.items.map((i) => i.text);
}

// ---- append-only prompt-log: hosted capture, local first ----

const logIo = { readFile, appendFile: appendText, writeFile: atomicWrite };

function readFile(file: string): string | undefined {
  return readText(file);
}

function hostClientId(): string {
  try { return clientIdentity(stateRoot(), logIo); } catch { return "pi-host"; }
}

function logPrompt(paths: ProjectPaths, inputs: readonly PromptLogInput[]): void {
  if (inputs.length === 0) return;
  try { appendPromptLog(promptLogFiles(paths.dir), logIo, hostClientId(), new Date().toISOString(), inputs); } catch { /* advisory */ }
}

/** One bounded catch-up of pending prompt-log entries; hosted has no poller, so open/close are the ticks. */
async function syncPromptLogOnce(paths: ProjectPaths): Promise<string> {
  let store: BriefingStore;
  try { store = new BriefingStore(paths.cwd, "# Project briefing\n\nNot recorded yet.\n"); } catch { return "log local (briefing unreadable)"; }
  const target = store.target;
  if (!target) return "log local (not connected)";
  let pages;
  try { pages = projectPagesFor(target.origin, path.basename(paths.cwd), target.docName); } catch { return "log local (binding unusable)"; }
  const client = OpenKnowledgeClient.fromEnv(target.origin);
  const result = await syncPromptLog(promptLogFiles(paths.dir), logIo, client, pages, hostClientId(), () => new Date().toISOString());
  return `log ${result.state}${result.pending > 0 ? ` ${String(result.pending)} pending` : ""}${result.reason ? ` (${result.reason})` : ""}`;
}

// ---- automatic during-work checkpoints (local-first, never sends/launches) ----

function autoStateFor(queue: PendingQueue, composerText: string, snap: GitSnapshot): AutoWorkState {
  return buildAutoWorkState({
    queueTexts: queueTexts(queue), composerText,
    head: snap.head, dirty: snap.dirty, changedCount: snap.changed.length,
  });
}

function autoIoForPaths(paths: ProjectPaths, snap: GitSnapshot) {
  return {
    readRecord: (): AutoCheckRecord => {
      try {
        return loadAutoRecordFile(paths.autocheck);
      } catch {
        return defaultAutoCheckRecord();
      }
    },
    writeRecord: (next: AutoCheckRecord): void => {
      try {
        saveAutoRecordFile(paths.autocheck, next);
      } catch { /* capture already saved locally; settings are advisory */ }
    },
    appendEntry: (text: string): { id: string; at: string } => appendProgress(paths.progress, paths.log, {
      text, cwd: paths.cwd, head: snap.head, ref: snap.ref, dirty: snap.dirty, changed: snap.changed,
    }),
    syncHistory: (text: string): Promise<string> => syncWrapHistory(paths.cwd, text, "checkpoint"),
  };
}

function autoStatusFor(paths: ProjectPaths): string {
  try {
    return autoStatusLine(loadAutoRecordFile(paths.autocheck));
  } catch {
    return "";
  }
}

// ---- automatic 200k-context wrap-up (Save for later / Continue now) ----

function describeWrapContext(ctx: ExtensionContext): string {
  const tokens = currentTokensOf(
    typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined,
  );
  if (tokens === undefined) return "context: unknown (current-context measurement unavailable)";
  const over = tokens >= WRAP_THRESHOLD_TOKENS ? " — wrap-up triggers on next /promptr" : "";
  return `context: ${tokens.toLocaleString("en-US")} current tokens${over}`;
}

/** Best-effort history sync. Never throws: resolves the visible status line. */
async function syncWrapHistory(cwd: string, text: string, noun = "handoff"): Promise<string> {
  let store: BriefingStore;
  try {
    store = new BriefingStore(cwd, "# Project briefing\n\nNot recorded yet.\n");
  } catch {
    return `pending — local briefing unreadable; ${noun} retained locally`;
  }
  if (!store.target) return `pending — no connected OpenKnowledge target; ${noun} retained locally`;
  let remote: OpenKnowledgeBriefing;
  try {
    remote = new OpenKnowledgeBriefing(store.target);
  } catch {
    return `pending — OpenKnowledge credentials unavailable; ${noun} retained locally`;
  }
  try {
    await remote.appendHistory(text);
    return `synced to ${store.target.origin} history`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return `pending — ${detail}`;
  }
}

type HostExec = (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/** Continue-now executor: the shared Start-fresh Herdr flow, called at most once. */
async function launchFreshFromHost(pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<boolean> {
  const exec = (pi as unknown as { exec?: HostExec }).exec?.bind(pi) as HostExec | undefined;
  if (process.env.HERDR_ENV !== "1" || !exec) {
    ctx.ui.notify("Continue now needs Herdr (HERDR_ENV=1) and the extension host exec capability; handoff retained, nothing launched.", "warning");
    return false;
  }
  const herdr = async (args: string[]): Promise<string> => (await exec("herdr", args, { timeout: 90000 })).stdout;
  let sessionFile = "";
  try { sessionFile = ctx.sessionManager.getSessionFile() ?? ""; } catch { sessionFile = ""; }
  return startFreshBriefingInNewPi(
    text, { pane: process.env.HERDR_PANE_ID ?? "", sessionFile, cwd: ctx.cwd }, ctx.ui, herdr,
  );
}


// ---- /handoffr v2: Coordinator-authored handoff, receipt-driven Phase B ----

type HandoffHostCtx = Pick<ExtensionContext, "cwd" | "ui" | "sessionManager" | "model" | "thinkingLevel" | "isIdle" | "hasPendingMessages"> & {
  getContextUsage?: ExtensionContext["getContextUsage"];
};

function hostRuntime(pi: ExtensionAPI, ctx: HandoffHostCtx) {
  let thinking: unknown = ctx.thinkingLevel;
  if (thinking === undefined) { try { thinking = pi.getThinkingLevel(); } catch { thinking = undefined; } }
  const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  return resolveHandoffRuntime({ ...(model === undefined ? {} : { model }), thinkingLevel: thinking, env: process.env });
}

function sessionFileOf(ctx: HandoffHostCtx): string {
  try { return ctx.sessionManager.getSessionFile() ?? ""; } catch { return ""; }
}

function receiptPath(paths: ProjectPaths, name: string): string {
  return path.join(paths.handoffsDir, `${name}.json`);
}

function writeReceipt(paths: ProjectPaths, receipt: HandoffReceipt): void {
  atomicWrite(receiptPath(paths, receipt.name), `${JSON.stringify(receipt, null, 2)}\n`);
}

function readReceipt(paths: ProjectPaths, name: string): HandoffReceipt | undefined {
  return parseReceipt(readText(receiptPath(paths, name)));
}

/** Receipts sorted by filename (timestamp-first names sort chronologically). */
function listReceipts(paths: ProjectPaths): HandoffReceipt[] {
  return listFiles(paths.handoffsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseReceipt(readText(path.join(paths.handoffsDir, f))))
    .filter((r): r is HandoffReceipt => r !== undefined);
}

/** True for produced handoff documents only (not evidence files or receipts). */
function isHandoffDocument(file: string): boolean {
  return file.endsWith(".md") && !file.endsWith(".evidence.md");
}

/**
 * Phase A: write evidence + pending receipt, then ask the Coordinator (one
 * `sendUserMessage`, templates off) to author the handoff via the packaged
 * skill. Returns true when the request was sent. Refuses when the source is
 * not idle; nothing is written then.
 */
async function requestHandoffPhaseA(
  pi: ExtensionAPI, ctx: HandoffHostCtx, focus: string | undefined, options: { automatic?: boolean } = {},
): Promise<boolean> {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.ui.notify("Coordinator is busy (streaming or pending messages). Run /handoffr when idle; nothing written.", "warning");
    return false;
  }
  const paths = projectPaths(ctx.cwd);
  ensureDir(paths.dir);
  ensureDir(paths.handoffsDir);
  const at = new Date();
  const name = (options.automatic ? autoWrapFilename(at) : handoffFilename(at)).replace(/\.md$/, "");
  const snap = gitSnapshot(paths.cwd);
  const progress = loadProgress(paths.progress);
  const queue = loadQueueFile(paths.queue);
  const runtime = hostRuntime(pi, ctx);
  const tokens = currentTokensOf(typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined);
  const evidencePath = path.join(paths.handoffsDir, `${name}.evidence.md`);
  const handoffPath = path.join(paths.handoffsDir, `${name}.md`);
  const evidence = buildHandoffEvidence({
    slug: paths.slug, cwd: paths.cwd, ref: snap.ref, head: snap.head, dirty: snap.dirty, changed: snap.changed,
    progress: progress.entries, queueTexts: queueTexts(queue), runtime, sessionFile: sessionFileOf(ctx),
    sessionId: ctx.sessionManager.getSessionId(), observedTokens: tokens, focus, at: at.toISOString(),
  });
  const receipt: HandoffReceipt = {
    version: 1, name, state: "requested", sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId() ?? "", requestedAt: at.toISOString(),
    evidence: evidencePath, target: handoffPath,
    ...(runtime === undefined ? {} : { runtime }),
    ...(tokens === undefined ? {} : { observedTokens: tokens }),
    ...(options.automatic ? { automatic: true } : {}),
  };
  try {
    atomicWrite(evidencePath, `${evidence}\n`);
    writeReceipt(paths, receipt);
  } catch {
    ctx.ui.notify("Could not persist the handoff evidence or receipt. Nothing requested.", "error");
    return false;
  }
  try {
    pi.sendUserMessage(buildHandoffAuthorPrompt(evidencePath, handoffPath, name,
      fileURLToPath(new URL("../../../skills/promptr-handoff/SKILL.md", import.meta.url))), { expandPromptTemplates: false });
  } catch {
    ctx.ui.notify(`Handoff request could not be sent; evidence retained at handoffs/${name}.evidence.md. Run /handoffr again when idle.`, "error");
    return false;
  }
  try { appendText(paths.log, `\n## Handoff requested ${name}\n- evidence: \`handoffs/${name}.evidence.md\`\n- target: \`handoffs/${name}.md\`\n`); } catch { /* advisory */ }
  ctx.ui.notify(`Handoff requested; the Coordinator is writing handoffs/${name}.md. Phase B runs automatically when it finishes (or run /handoffr finish).`, "info");
  return true;
}

/** Phase B: validate, log, sync, offer the launch. Runs at most once per receipt. */
async function finishHandoffPhaseB(pi: ExtensionAPI, ctx: HandoffHostCtx, name: string): Promise<void> {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.ui.notify("Coordinator is busy; run /handoffr finish when idle. Nothing launched.", "warning");
    return;
  }
  const paths = projectPaths(ctx.cwd);
  const receipt = readReceipt(paths, name);
  if (!receipt) { ctx.ui.notify(`No handoff receipt for ${name}.`, "warning"); return; }
  if (receipt.sessionId !== ctx.sessionManager.getSessionId()) {
    ctx.ui.notify("Finish this handoff in its source session; use /promptr-resume elsewhere.", "warning");
    return;
  }
  if (receipt.state !== "requested" && receipt.state !== "invalid") {
    ctx.ui.notify(`Handoff ${name} is already ${receipt.state}; nothing to finish.`, "info");
    return;
  }
  receipt.state = "finishing";
  try { writeReceipt(paths, receipt); } catch { ctx.ui.notify("Could not update the handoff receipt; aborting Phase B.", "error"); return; }
  const text = readText(receipt.target);
  const valid = validateHandoff(text);
  if (!valid.ok || text === undefined) {
    receipt.state = "invalid";
    receipt.reason = valid.ok ? "unreadable" : valid.reason;
    try { writeReceipt(paths, receipt); } catch { /* best effort */ }
    ctx.ui.notify(`Handoff invalid: ${receipt.reason}. Run /handoffr finish after fixing handoffs/${name}.md`, "warning");
    return;
  }
  const iso = new Date().toISOString();
  const runtimeText = receipt.runtime ? `${runtimeTriple(receipt.runtime)} (${receipt.runtime.source})` : "UNKNOWN";
  receipt.writtenAt = iso;
  receipt.bytes = Buffer.byteLength(text, "utf8");
  try {
    appendText(paths.log, `\n## Handoff written ${name}\n- size: ${receipt.bytes} bytes\n- observed tokens: ${receipt.observedTokens ?? "UNKNOWN"}\n- runtime: ${runtimeText}\n- file: \`handoffs/${name}.md\`\n`);
  } catch { /* advisory */ }
  const marker = handoffSyncMarker(name, iso, receipt.runtime);
  receipt.sync = await syncWrapHistory(paths.cwd, `${marker}\n\n${text}`, "handoff");
  receipt.state = "saved";
  try { writeReceipt(paths, receipt); } catch { /* best effort */ }
  const choice = await ctx.ui.select(
    `Handoff ${name} valid (${receipt.bytes} bytes)\nRuntime: ${runtimeText}\nOpenKnowledge: ${receipt.sync}\n` +
    `Launch successor now starts a same-runtime interactive Pi in a new Herdr tab and prompts it once. Save only launches nothing.`,
    ["Launch successor now", "Save only"],
  );
  if (choice !== "Launch successor now") {
    ctx.ui.notify(`Handoff saved as handoffs/${name}.md (${receipt.sync}). Nothing launched.`, "info");
    return;
  }
  const exec = (pi as unknown as { exec?: HostExec }).exec?.bind(pi) as HostExec | undefined;
  if (!exec) {
    receipt.launch = "refused";
    try { writeReceipt(paths, receipt); } catch { /* best effort */ }
    ctx.ui.notify("Extension host exec capability unavailable; handoff saved, nothing launched.", "warning");
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages() || receipt.sessionId !== ctx.sessionManager.getSessionId()) {
    ctx.ui.notify("Source session changed or became busy; handoff saved, nothing launched.", "warning");
    return;
  }
  const result = await launchHandoffSuccessor(
    {
      env: process.env, cwd: paths.cwd, slug: paths.slug, sessionFile: sessionFileOf(ctx), runtime: receipt.runtime,
      name, handoffPath: receipt.target, handoffText: text,
    },
    {
      exec: async (args) => {
        const result = await exec("herdr", args, { timeout: 90000 });
        if (result.code !== 0 || result.killed) throw new Error(`Herdr ${args.slice(0, 2).join(" ")} failed (exit ${result.code})`);
        return result.stdout;
      },
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  if (!result.ok) {
    receipt.launch = "refused";
    receipt.reason = result.reason;
    try { writeReceipt(paths, receipt); } catch { /* best effort */ }
    ctx.ui.notify(`Successor not launched (${result.stage}: ${result.reason}). Handoff saved as handoffs/${name}.md.${result.pane ? ` Inspect pane ${result.pane}.` : ""}`, "warning");
    return;
  }
  receipt.launch = result.launch;
  receipt.state = "launched";
  receipt.successor = {
    workspace: result.workspace, pane: result.pane, agentName: result.agentName, label: result.label,
    successorSession: result.successorSession, promptedAt: result.promptedAt,
  };
  try { writeReceipt(paths, receipt); } catch { /* best effort */ }
  if (result.launch === "uncertain") {
    ctx.ui.notify(`Successor ${result.agentName} started in pane ${result.pane} but the prompt outcome is uncertain: inspect the new tab, do not resubmit.`, "warning");
    return;
  }
  ctx.ui.notify(`Successor ${result.agentName} running in tab '${result.label}'. This session is read-only by convention; close it after the successor confirms git state.`, "info");
}

async function runAutoWrapFlow(
  pi: ExtensionAPI, ctx: ExtensionContext,
  triggered: Set<string>, tokens: number,
): Promise<void> {
  const paths = projectPaths(ctx.cwd);
  ensureDir(paths.dir);
  ensureDir(paths.handoffsDir);
  const snap = gitSnapshot(ctx.cwd);
  const progress = loadProgress(paths.progress);
  const queue = loadQueueFile(paths.queue);
  const outcome = await runAutoWrap(
    {
      tokens, sessionId: ctx.sessionManager.getSessionId(),
      cwd: paths.cwd, slug: paths.slug, handoffsDir: paths.handoffsDir,
      snapshot: { ref: snap.ref, head: snap.head, dirty: snap.dirty, changed: snap.changed },
      progress: progress.entries, queueTexts: queueTexts(queue),
      ...(process.env.PI_PROVIDER === undefined ? {} : { provider: process.env.PI_PROVIDER }),
      ...(process.env.PI_MODEL === undefined ? {} : { model: process.env.PI_MODEL }),
      ...(process.env.PI_REASONING_LEVEL === undefined ? {} : { thinking: process.env.PI_REASONING_LEVEL }),
      sourceIdle: ctx.isIdle() && !ctx.hasPendingMessages(),
    },
    {
      triggered,
      requestHandoff: (focus) => requestHandoffPhaseA(pi, ctx, focus, { automatic: true }),
      writeHandoff: (dir, name, text) => { atomicWrite(path.join(dir, name), `${text}\n`); },
      appendLog: (text) => { appendText(paths.log, text); },
      syncHistory: (text) => syncWrapHistory(paths.cwd, text),
      ui: {
        review: (text) => reviewText(ctx, text),
        choose: async (title) => {
          const choice = await ctx.ui.select(title, ["Save for later", "Continue now"]);
          return choice === "Continue now" ? "continue" : choice === "Save for later" ? "save" : undefined;
        },
        notify: (message, level) => { ctx.ui.notify(message, level); },
      },
      launchFresh: (text) => launchFreshFromHost(pi, ctx, text),
    },
  );
  // A continued wrap-up transfers writing to the Herdr successor: never fall
  // through to the normal queue UI in the same open. A saved wrap-up already
  // notified; the claimed trigger keeps the next /promptr on its normal UI.
  if (outcome === "continued") {
    ctx.ui.notify("Transferred — this session must stop mutating the project. Kept open as reference only.", "info");
  }
}

// ---- Omakase-adapted project tracking (Gitea/GitHub read-only, cache-backed) ----

type TrackingLoad = {
  snapshot: TrackingSnapshot | undefined;
  source: "live" | "cache" | "none";
  reason: string;
};

/** Best-effort refresh: live fetch saves cache; failure falls back to cache. Never throws. */
async function loadTracking(paths: ProjectPaths): Promise<TrackingLoad> {
  const bound = loadTrackerBinding(paths.cwd, process.env);
  const resolved = bound.resolution;
  const cached = loadTrackingSnapshotForRepo(paths.tracking, resolved.ok ? resolved.config.repo : undefined);
  const suffix = bindingSourceSuffix(bound.source);
  if (!resolved.ok) {
    return { snapshot: undefined, source: "none", reason: resolved.reason };
  }
  const repo = resolved.config.repo;
  try {
    const live = await trackingPorts(bound.effectiveEnv, { timeoutMs: 8000, withBlockers: false }).fetch(repo);
    try {
      ensureDir(paths.dir);
      saveTrackingSnapshot(paths.tracking, live);
    } catch { /* cache is best effort */ }
    return { snapshot: live, source: "live", reason: `live from ${trackerLabel(repo)}${suffix ? ` ${suffix}` : ""}` };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message.slice(0, 120) : "fetch failed";
    if (cached) {
      const stale = isTrackingStale(cached) ? "stale" : "cached";
      return { snapshot: cached, source: "cache", reason: `${stale} snapshot kept (${reason})` };
    }
    const tokenVar = resolved.config.provider === "github" ? "GITHUB_TOKEN" : "GITEA_TOKEN";
    const hint = resolved.config.tokenPresent ? reason : `${reason}; set ${tokenVar} for private repos`;
    return { snapshot: undefined, source: "none", reason: hint };
  }
}

/** Evidence bullets from a digest's Markdown: list items only, never headings or prose. */
function trackingLinesForView(load: TrackingLoad): string[] {
  if (load.snapshot) return renderBoardLines(load.snapshot, PANEL_TRACKING_ROWS);
  return renderPlaceholderLines(load.reason);
}

/**
 * Hosted board navigation: detail/workflow modal, then the deterministic
 * draft into the composer. Reads are bounded GETs; nothing launches or sends.
 */
async function hostedTrackingFlow(
  ctx: ExtensionContext,
  paths: ProjectPaths,
  snapshot: TrackingSnapshot,
  pending: { kind: "open" | "generate"; issue: BoardIssue },
  getState: () => CompanionSessionState,
  persist: (s: CompanionSessionState) => void,
): Promise<void> {
  // Tracker binding: reads route through the effective environment and
  // always target the bound repository (with its provider), never the identity
  // the navigation controller keeps.
  const bound = loadTrackerBinding(paths.cwd, process.env);
  if (!bound.resolution.ok) {
    ctx.ui.notify(`Project tracking unavailable — ${bound.resolution.reason}. Nothing opened.`, "warning");
    return;
  }
  const boundRepo = bound.resolution.config.repo;
  const reads = trackingPorts(bound.effectiveEnv, { timeoutMs: 8000 });
  // Workflow-open boundary: the effective catalog is loaded per flow, so
  // editing the local override and reopening the board picks up the change.
  // An invalid override yields a catalog that offers nothing and refuses every
  // expansion; the reason is shown rather than a silent fall back to defaults.
  const effective = loadEffectiveCatalog(catalogPort, process.env, nodeWorkflowLoadDeps);
  if (effective.error !== undefined) {
    ctx.ui.notify(`Workflow override invalid — ${effective.error} Nothing generated or sent.`, "error");
  } else if (effective.configured) {
    ctx.ui.notify(`Workflow override active: ${effective.path} (configuration, not verified availability).`, "info");
  }
  const nav = new TrackingNavigationController({
    repo: snapshot.repo,
    ports: {
      listPage: (_r, p) => reads.listPage(boundRepo, p),
      loadDetail: (_r, n) => reads.loadDetail(boundRepo, n),
      now: () => new Date().toISOString(),
      catalog: effective.catalog,
    },
  });
  const issue = pending.issue;
  if (nav.selectIssue({
    number: issue.number, title: issue.title, state: "open", milestone: issue.milestone,
    labels: [...issue.labels], url: issue.url,
  }) !== "applied") {
    ctx.ui.notify(nav.getState().notice, "info");
    return;
  }
  await nav.openDetail();
  if (pending.kind === "generate") await nav.startGenerate();
  const outcome = await ctx.ui.custom<"exit" | "prepared" | "generate">((tui, _t, _k, done) => {
    const modal = new TrackingModal(nav, { rows: () => Math.max(8, tui.terminal.rows - 6), onChange: () => tui.requestRender() });
    return {
      invalidate() {},
      render: (w) => modal.render(w),
      handleInput(data) {
        void modal.handleKey(data).then((o) => {
          if (o === "exit" || o === "prepared" || o === "generate") done(o);
          else tui.requestRender();
        });
      },
    };
  });
  if (outcome === "exit") return;
  const packet = nav.consumeRequest();
  if (!packet) { ctx.ui.notify("No request was prepared. Nothing launched or sent.", "info"); return; }
  const nowIso = new Date().toISOString();
  const fileName = requestFileName(packet.task.number, nowIso);
  let savedName: string | undefined;
  try {
    ensureDir(path.join(paths.dir, "requests"));
    atomicWrite(path.join(paths.dir, "requests", fileName), JSON.stringify(packet, null, 2));
    savedName = fileName;
  } catch { /* the draft still lands */ }
  let git: GitSnapshot = { head: "unknown", ref: "", dirty: false, changed: [] };
  try { git = gitSnapshot(ctx.cwd); } catch { /* unknown stays unknown */ }
  // Catch-Me-Up attach: the latest digest younger than 24 h joins the
  // draft as evidence; older or missing digests are not attached and never
  // trigger a run here.
  const fresh = loadFreshCatchUp(paths, readText, Date.now());
  const draft = buildTaskPromptDraft(packet, {
    cwd: ctx.cwd, ref: git.ref, head: git.head, dirty: git.dirty, targetLabel: "hosted /promptr", nowIso,
    ...(fresh === undefined ? {} : { catchUp: { since: fresh.packet.since, summary: fresh.packet.summary, lines: catchUpDraftLines(fresh.packet.markdown) } }),
  });
  if (fresh === undefined) ctx.ui.notify("no fresh catch-up · run /promptr-catchup (or c in the companion workboard) to attach real-world progress", "info");
  const state = getState();
  const placed = placeDraft(state.composerText, draft, packet.task.number, savedName);
  persist({ ...state, composerText: placed.composerText, focus: "composer" });
  ctx.ui.notify(placed.notice, "info");
  // Target-runtime check: the frozen expansion against Pi's live
  // registry. Informational here — the hosted view never launches — but it is
  // the same exact matching the companion's dispatch gate applies.
  const models = registryModels(ctx);
  if (models !== undefined) {
    const checks = checkExpansion(packet.workflow, capabilitiesFromRegistry(models));
    const totals = summarizeRoleChecks(checks);
    if (totals.missing > 0) {
      ctx.ui.notify(`Runtime check against Pi's registry: ${String(totals.missing)} role(s) NOT available; a launch would be blocked, nothing is substituted.\n${describeRoleChecks(checks).join("\n")}`, "warning");
    }
  }
  if (outcome === "generate") ctx.ui.notify(HOSTED_GENERATE_NOTICE, "info");
}

/** Pi's registry through the extension facade; undefined when the host offers none. */
function registryModels(ctx: Pick<ExtensionContext, "modelRegistry">): RegistryModel[] | undefined {
  try {
    const registry = (ctx as { modelRegistry?: { getAvailable?: () => readonly RegistryModel[] } }).modelRegistry;
    const list = registry?.getAvailable?.();
    if (!Array.isArray(list)) return undefined;
    return list.map((m) => ({
      provider: String(m.provider), id: String(m.id), reasoning: m.reasoning === true,
      ...(m.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: m.thinkingLevelMap }),
    }));
  } catch {
    return undefined;
  }
}

// ---- read-only review widget ----

async function reviewText(ctx: ExtensionContext, text: string): Promise<boolean> {
  return await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    const pasteGuard = new PasteGuard();
    let offset = 0;
    let pageSize = 1;
    let total = 0;
    return {
      invalidate() {},
      render(width) {
        const height = Math.max(1, tui.terminal.rows - 4);
        pageSize = Math.max(1, height - 4);
        const rows = text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
        total = rows.length;
        offset = Math.min(offset, Math.max(0, total - pageSize));
        return [
          theme.fg("accent", "Review exact prompt (read only)"),
          ...rows.slice(offset, offset + pageSize),
          theme.fg("muted", `Rows ${offset + 1}-${Math.min(total, offset + pageSize)}/${total}; ${text.length} bytes`),
          "Arrows/PgUp/PgDn scroll | Enter continue | Esc cancel",
        ].slice(0, height).map((line) => truncateToWidth(line, width, ""));
      },
      handleInput(raw) {
        const { segments, dropped } = pasteGuard.consume(raw);
        if (dropped || segments.length !== 1) return;
        const data = segments[0]!;
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(false);
        else if (matchesKey(data, "enter")) done(true);
        else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "down")) offset = Math.min(Math.max(0, total - pageSize), offset + 1);
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageSize);
        else if (matchesKey(data, "pageDown")) offset = Math.min(Math.max(0, total - pageSize), offset + pageSize);
        tui.requestRender();
      },
    };
  });
}

/** Single review-and-confirm dialog: full exact text + explicit Submit in one step. */
async function reviewAndConfirmText(ctx: ExtensionContext, text: string): Promise<boolean> {
  return await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    const pasteGuard = new PasteGuard();
    let offset = 0;
    let pageSize = 1;
    let total = 0;
    return {
      invalidate() {},
      render(width) {
        const height = Math.max(1, tui.terminal.rows - 4);
        pageSize = Math.max(1, height - 6);
        const rows = text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
        total = rows.length;
        offset = Math.min(offset, Math.max(0, total - pageSize));
        return [
          theme.fg("accent", "Submit this prompt? (exact text below, read only)"),
          ...rows.slice(offset, offset + pageSize),
          theme.fg("muted", `Rows ${offset + 1}-${Math.min(total, offset + pageSize)}/${total}; ${text.length} bytes — starts a turn, may run tools; one item only`),
          "Arrows/PgUp/PgDn scroll | Enter SUBMIT | Esc cancel",
        ].slice(0, height).map((line) => truncateToWidth(line, width, ""));
      },
      handleInput(raw) {
        const { segments, dropped } = pasteGuard.consume(raw);
        if (dropped || segments.length !== 1) return;
        const data = segments[0]!;
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done(false);
        else if (matchesKey(data, "enter")) done(true);
        else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, "down")) offset = Math.min(Math.max(0, total - pageSize), offset + 1);
        else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - pageSize);
        else if (matchesKey(data, "pageDown")) offset = Math.min(Math.max(0, total - pageSize), offset + pageSize);
        tui.requestRender();
      },
    };
  });
}

/**
 * One-dialog submit: a board-chosen focused thought goes straight to review;
 * otherwise skip the picker when a single item is queued. Single
 * review-and-submit in all paths; attempted != delivered.
 */
async function submitOneItem(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  items: readonly PendingItem[],
  attempts: Set<string>,
  isCurrent: () => boolean,
  preferredIndex?: number,
): Promise<boolean> {
  if (items.length === 0) {
    ctx.ui.notify("Queue is empty. Type in the composer and hit Ctrl+S — it queues and reviews in one.", "info");
    return false;
  }
  if (preferredIndex !== undefined) {
    const preferred = items[preferredIndex];
    if (preferred && !attempts.has(preferred.id)) {
      return await attemptSingleDialog(pi, ctx, preferred, attempts, isCurrent, () => reviewAndConfirmText(ctx, preferred.text));
    }
    // Focused thought gone or already attempted: fall through to the standard flow.
  }
  let item: PendingItem | undefined;
  if (items.length === 1) {
    const only = items[0];
    if (!only) return false;
    if (attempts.has(only.id)) {
      ctx.ui.notify("Already attempted; inspect the Pi conversation. No automatic retry.", "warning");
      return false;
    }
    item = only;
  } else {
    const labels = items.map((entry, index) =>
      `${index + 1}. [${attempts.has(entry.id) ? "attempted/unknown" : "pending"}] ${entry.text.replaceAll("\n", "\\n").slice(0, 70)}`);
    const choice = await ctx.ui.select("Choose ONE queued prompt (Esc returns)", labels);
    if (!isCurrent()) return false;
    const index = choice === undefined ? -1 : labels.indexOf(choice);
    const picked = items[index];
    if (!picked) return false;
    item = picked;
  }
  return await attemptSingleDialog(pi, ctx, item, attempts, isCurrent, () => reviewAndConfirmText(ctx, item.text));
}

export default function promptr(pi: ExtensionAPI) {
  const attempts = new Set<string>();
  let opened = false;
  let epoch = 0;

  const autoWrapSessions = new Set<string>();
  pi.on("session_shutdown", () => { epoch++; attempts.clear(); autoWrapSessions.clear(); });
  pi.on("session_tree", () => { epoch++; autoWrapSessions.clear(); });

  const cwdOf = () => process.cwd();
  const pathsOf = (): ProjectPaths => projectPaths(cwdOf());

  // ---- /promptr workspace: full task/briefing view with the persistent queue/composer (opened by the sidebar) ----
  const openWorkspace = async (_args: string, ctx: ExtensionContext, flowIsCurrent: () => boolean = () => true) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The Promptr workspace requires interactive Pi. Run /promptr workspace in the terminal UI.", "warning");
        return;
      }
      if (opened) { ctx.ui.notify("The Promptr workspace is already open.", "warning"); return; }
      // Automatic 200k wrap-up: checked on open (dialog-safe command context),
      // claimed once per source session. Unknown measurement never triggers.
      const wrapTokens = currentTokensOf(
        typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined,
      );
      if (shouldAutoWrap(wrapTokens, autoWrapSessions.has(ctx.sessionManager.getSessionId()))) {
        opened = true;
        try {
          await runAutoWrapFlow(pi, ctx, autoWrapSessions, wrapTokens as number);
        } finally {
          opened = false;
        }
        return;
      }
      opened = true;
      const generation = epoch;
      // The sidebar's guard also stops the flow at its next step when another extension's dialog opens.
      const isCurrent = () => epoch === generation && flowIsCurrent();
      const paths = projectPaths(ctx.cwd);
      ensureDir(paths.dir);
      ensureDir(paths.handoffsDir);
      let persistedQueue = loadQueueFile(paths.queue);
      // Coordinatr window tracking: cache-first for instant paint, then one
      // bounded live refresh before the first frame. The tracker stays authoritative.
      const initialBinding = loadTrackerBinding(paths.cwd, process.env);
      const initialTracking = loadTrackingSnapshotForRepo(paths.tracking, initialBinding.resolution.ok ? initialBinding.resolution.config.repo : undefined);
      let trackingLines = initialTracking
        ? renderBoardLines(initialTracking, PANEL_TRACKING_ROWS)
        : renderPlaceholderLines("loading tracker snapshot");
      let loaded: TrackingLoad = { snapshot: initialTracking, source: initialTracking ? "cache" : "none", reason: "loading tracker snapshot" };
      try {
        loaded = await loadTracking(paths);
        trackingLines = trackingLinesForView(loaded);
      } catch { /* keep initial lines */ }
      let hosted = hostedBoard(loaded.snapshot, loaded.source, loaded.reason);
      // Hosted board intent stash: the modal runs in its own ctx.ui.custom.
      let trackingIssue: { kind: "open" | "generate"; issue: BoardIssue } | undefined;
      const openedScratch = loadScratch(paths.scratch);
      let state: CompanionSessionState = {
        noteText: openedScratch.text,
        composerText: readText(paths.composer) ?? persistedQueue.composer,
        queue: persistedQueue,
        documentRevision: 0,
        selection: { startLine: 1, endLine: 1 },
        focus: "editor",
      };
      // During-work capture on open: records the resumed direction when due.
      // Advisory only — the UI below is authoritative and this never throws.
      try {
        const openSnap = gitSnapshot(ctx.cwd);
        await maybeAutoCheckpoint(
          { state: autoStateFor(state.queue, state.composerText, openSnap) },
          autoIoForPaths(paths, openSnap),
        );
      } catch { /* ignore */ }
      let loggedQueue = state.queue;
      const persist = (s: CompanionSessionState) => {
        state = s;
        // Seeded-sample guard (same as the companion): the in-memory fallback
        // is display-only until the user types real notes; writing it would
        // destroy notes another client saved after our load.
        if (!openedScratch.seeded || s.noteText !== openedScratch.text) {
          saveScratch(paths.scratch, s.noteText);
        }
        saveQueueFile(paths.queue, s.queue);
        try { atomicWrite(paths.composer, s.composerText); } catch { /* ignore */ }
        if (s.queue !== loggedQueue) {
          const events = diffQueueEvents(loggedQueue, s.queue);
          loggedQueue = s.queue;
          logPrompt(paths, events);
        }
      };
      const openedNote = state.noteText;
      // Pending prompt-log batches from an offline session catch up on open.
      void syncPromptLogOnce(paths).catch(() => { /* advisory */ });
      try {
        const snap = gitSnapshot(ctx.cwd);
        const recent = loadProgress(paths.progress).entries.at(-1);
        const initial = `# ${path.basename(ctx.cwd)} briefing

## Goal / task link
Not recorded yet.

## Last useful progress
${recent ? `${recent.at}: ${recent.text}` : "No checkpoint recorded."}

## Next action / blockers
Review project instructions and record the next action here.

## Read first
AGENTS.md (if present); project tracker and continuation references.

Observed ${new Date().toISOString()}
Git: ${snap.ref || "unknown"} @ ${snap.head}${snap.dirty ? " (dirty)" : ""}
`;
        const overview = new BriefingOverview(new BriefingStore(ctx.cwd, initial), {
          onSave: (text) => logPrompt(paths, [{ kind: "briefing-save", text }]),
          sharedReader: (origin) => OpenKnowledgeClient.fromEnv(origin),
          projectLabel: (dir) => defaultProjectLabel(dir, gitRemoteUrl(dir)),
        });
        const autoStatus = autoStatusFor(paths);
        let showOverview = true;
        while (isCurrent()) {
          if (showOverview) {
            const selected = await overview.show(pi, ctx, attempts, isCurrent, (text) => reviewAndConfirmText(ctx, text), autoStatus);
            // "fresh" releases the UI like "sent": the briefing moved to a Herdr
            // successor and the old session must stop writing. Never a second item.
            if (selected === "close" || selected === "sent" || selected === "fresh" || !isCurrent()) return;
            if (selected === "new-task") state = { ...state, focus: "composer" };
            showOverview = false;
          }
          let reviewIndex: number | undefined = undefined;
          const action = await ctx.ui.custom<"close" | "review" | "overview" | "refresh" | "tracking">((tui, _theme, _keys, done) => {
            const view = new CompanionSpikeView(tui, {
              noteText: state.noteText,
              hosted: true,
              sessionState: state,
              trackingLines,
              overviewNavigation: true,
              trackingNavigation: hosted.navigation,
              projectLabel: path.basename(ctx.cwd),
            });
            if (hosted.board) view.setWorkBoard(hosted.board, hosted.note);
            return {
              invalidate() { view.layoutRoot.invalidate(); },
              render(width) { return view.renderFrame(width, Math.max(1, tui.terminal.rows - 6)); },
              handleInput(data) {
                view.handleInput(data);
                persist(view.snapshot());
                const intent = view.consumeTrackingIntent();
                if (view.getOverviewRequested()) done("overview");
                else if (view.getReviewRequested()) { reviewIndex = view.getReviewIndex(); done("review"); }
                else if (view.getExitRequested()) done("close");
                else if (intent?.kind === "refresh") done("refresh");
                else if (intent) { trackingIssue = { kind: intent.kind, issue: intent.issue }; done("tracking"); }
                else tui.requestRender();
              },
            };
          });
          if (action === "overview") { showOverview = true; continue; }
          if (action === "refresh") {
            if (!isCurrent()) return;
            loaded = await loadTracking(paths);
            trackingLines = trackingLinesForView(loaded);
            hosted = hostedBoard(loaded.snapshot, loaded.source, loaded.reason);
            showOverview = false;
            continue;
          }
          if (action === "tracking") {
            if (!isCurrent()) return;
            const pending = trackingIssue;
            trackingIssue = undefined;
            const snapshot = loaded.snapshot;
            if (pending && snapshot) await hostedTrackingFlow(ctx, paths, snapshot, pending, () => state, persist);
            showOverview = false;
            continue;
          }
          if (!isCurrent() || action !== "review") return;
          const attempted = await submitOneItem(pi, ctx, state.queue.items, attempts, isCurrent, reviewIndex);
          if (attempted) return; // release UI to Pi; never drain a second item
        }
      } finally {
        opened = false;
        if (state.noteText !== openedNote) logPrompt(paths, [{ kind: "note-revision", text: state.noteText }]);
        void syncPromptLogOnce(paths).catch(() => { /* advisory */ });
        // Parting capture is local-only: no history sync here, so closing
        // stays bounded. A pending pointer lets the next open sync it.
        try {
          const closeSnap = gitSnapshot(ctx.cwd);
          void maybeAutoCheckpoint(
            { state: autoStateFor(state.queue, state.composerText, closeSnap) },
            { ...autoIoForPaths(paths, closeSnap), syncHistory: undefined },
          );
        } catch { /* ignore */ }
      }
  };

  // ---- /promptr-autocheck: automatic checkpoint switch and cadence ----
  pi.registerCommand("promptr-autocheck", {
    description: "Automatic during-work checkpoints: /promptr-autocheck on|off|status|interval <minutes>",
    handler: async (args, ctx) => {
      const paths = pathsOf();
      const read = (): AutoCheckRecord => {
        try {
          return loadAutoRecordFile(paths.autocheck);
        } catch {
          return defaultAutoCheckRecord();
        }
      };
      const write = (next: AutoCheckRecord): boolean => {
        try {
          ensureDir(paths.dir);
          saveAutoRecordFile(paths.autocheck, next);
          return true;
        } catch {
          ctx.ui.notify("Could not save automatic-checkpoint settings. Nothing changed.", "error");
          return false;
        }
      };
      const statusOf = (record: AutoCheckRecord): string => {
        const envKill = (process.env.PROMPTR_AUTO_CHECKPOINTS ?? "").trim().toLowerCase();
        const killed = ["0", "off", "false", "no", "disable", "disabled"].includes(envKill);
        return [
          `Automatic checkpoints: ${record.enabled && !killed ? "ON" : "OFF"} (every ${Math.round(record.intervalMs / 60_000)}m)`,
          `Last capture: ${record.lastAt === undefined ? "never" : new Date(record.lastAt).toISOString()}`,
          `Last sync: ${record.lastSync ?? "local only"}`,
          `Pending history: ${record.pendingEntry ? "yes — syncs on next /promptr open or companion tick" : "no"}`,
          ...(killed ? ["PROMPTR_AUTO_CHECKPOINTS disables capture globally."] : ["Set PROMPTR_AUTO_CHECKPOINTS=0 to disable globally."]),
        ].join("\n");
      };
      const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
      const verb = (parts[0] ?? "status").toLowerCase();
      if (verb === "" || verb === "status") {
        ctx.ui.notify(statusOf(read()), "info");
        return;
      }
      if (verb === "on" || verb === "off") {
        const record = { ...read(), enabled: verb === "on" };
        if (write(record)) ctx.ui.notify(statusOf(record), "info");
        return;
      }
      if (verb === "interval") {
        const minutes = Number(parts[1]);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          ctx.ui.notify("Usage: /promptr-autocheck interval <minutes 1-1440>", "warning");
          return;
        }
        const record = { ...read(), intervalMs: Math.round(minutes * 60_000) };
        if (write(record)) ctx.ui.notify(statusOf(record), "info");
        return;
      }
      ctx.ui.notify("Usage: /promptr-autocheck on|off|status|interval <minutes>", "warning");
    },
  });

  // ---- /promptr-workflows: effective catalog, registry check, capability probe ----
  pi.registerCommand("promptr-workflows", {
    description: "Workflow overrides: /promptr-workflows status|check|probe — inspect the effective catalog, check it against Pi's registry, write the capability probe",
    handler: async (args, ctx) => {
      const verb = (args.trim().split(/\s+/)[0] ?? "status").toLowerCase() || "status";
      const effective = loadEffectiveCatalog(catalogPort, process.env, nodeWorkflowLoadDeps);
      const describe = effective.error !== undefined
        ? `Workflow override INVALID — ${effective.error}\nThe picker offers nothing and dispatch is blocked until the file is fixed or deleted.`
        : effective.configured
          ? `Workflow override active: ${effective.path} (configuration, not verified availability).`
          : `Workflow overrides: none (shipped defaults do not launch); expected file ${effective.path}`;
      const probeFile = resolveCapabilityProbeFile(process.env);
      if (probeFile.error) { ctx.ui.notify(probeFile.error, "error"); return; }
      if (verb === "status") {
        const workflows = effective.catalog.listWorkflows().map((w) => `  ${w.id} — ${w.label}`);
        const providers = effective.catalog.listProviders().map((p) => `  ${p.id}`);
        ctx.ui.notify(`${describe}\nWorkflows:\n${workflows.join("\n") || "  (none)"}\nProviders:\n${providers.join("\n") || "  (none)"}\nProbe: ${probeFile.path}\nNothing is launched or sent by this command.`, effective.error !== undefined ? "error" : "info");
        return;
      }
      const models = registryModels(ctx);
      if (models === undefined) {
        ctx.ui.notify("Pi's model registry is not available from this host; nothing checked or written.", "warning");
        return;
      }
      const capabilities = capabilitiesFromRegistry(models);
      if (verb === "probe") {
        const target = probeFile.path;
        try {
          atomicWrite(target, serializeCapabilityProbe(capabilities, new Date().toISOString(), "pi modelRegistry.getAvailable()"));
        } catch (error) {
          ctx.ui.notify(`Could not write the capability probe: ${error instanceof Error ? error.message.slice(0, 120) : "write failed"}`, "error");
          return;
        }
        const providers = [...new Set(capabilities.map((c) => c.provider))];
        ctx.ui.notify(`Capability probe written: ${target}\n${String(capabilities.length)} provider/model rows across ${String(providers.length)} provider(s): ${providers.join(", ") || "(none)"}.\nThe companion's generator dispatch now checks against it. Re-run after /login or model changes. No credentials are written.`, "info");
        return;
      }
      if (verb === "check") {
        if (effective.error !== undefined) { ctx.ui.notify(describe, "error"); return; }
        const lines: string[] = [describe, `Registry: ${String(capabilities.length)} available provider/model rows.`];
        let missing = 0;
        for (const workflow of effective.catalog.listWorkflows()) {
          for (const provider of effective.catalog.listProviders()) {
            const expanded = effective.catalog.expandWorkflow({ template: workflow.id, provider: provider.id, readiness: "ready" });
            if (!expanded.ok) { lines.push(`${workflow.id} × ${provider.id}: ${expanded.error}`); continue; }
            const checks = checkExpansion(expanded.value, capabilities);
            const totals = summarizeRoleChecks(checks);
            missing += totals.missing;
            lines.push(`${workflow.id} × ${provider.id}: ${String(totals.ok)} ok · ${String(totals.missing)} missing · ${String(totals.unverifiable)} unverifiable`);
            for (const line of describeRoleChecks(checks.filter((c) => c.status !== "ok"))) lines.push(`    ${line}`);
          }
        }
        lines.push(missing > 0 ? "Missing roles block a launch; nothing is substituted. Fix the override or /login to the provider." : "Every Pi-route role is covered by the registry.");
        ctx.ui.notify(lines.join("\n"), missing > 0 ? "warning" : "info");
        return;
      }
      ctx.ui.notify("Usage: /promptr-workflows status|check|probe", "warning");
    },
  });

  // ---- /promptr-tracker: tracker binding status / init / check ----
  /** Interactive binding flow shared by /promptr-tracker init and /promptr-doctor init. Esc anywhere writes nothing. */
  const trackerInitFlow = async (ctx: ExtensionContext): Promise<boolean> => {
    const cwd = ctx.cwd;
    const current = loadTrackerBinding(cwd, process.env);
    const inferred = current.binding;
    const providerPick = await ctx.ui.select("Tracker provider", ["Gitea", "GitHub"]);
    if (providerPick === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
    const provider = providerPick === "GitHub" ? "github" : "gitea";
    const same = inferred?.provider === provider;
    const owner = await ctx.ui.input("Owner", same ? inferred.owner : providerDefaultOwner(provider, process.env));
    if (owner === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
    const repoName = await ctx.ui.input("Repository", same ? inferred.repo : path.basename(path.resolve(cwd)));
    if (repoName === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
    let host = same ? inferred.host : providerDefaultHost(provider, process.env);
    let apiOrigin: string | undefined = same ? inferred.apiOrigin : undefined;
    if (provider === "gitea") {
      const h = await ctx.ui.input("Host (https://…)", host);
      if (h === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
      host = h.trim() || host;
    } else {
      const kind = await ctx.ui.select("GitHub host", ["github.com", "GitHub Enterprise (custom host)"]);
      if (kind === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
      if (kind !== "github.com") {
        const h = await ctx.ui.input("Host (https://…)", host === DEFAULT_GITHUB_HOST ? "" : host);
        if (h === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
        host = h.trim() || host;
        const a = await ctx.ui.input("REST origin (empty derives from host)", apiOrigin ?? "");
        if (a === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
        apiOrigin = a.trim() || undefined;
      } else { host = DEFAULT_GITHUB_HOST; apiOrigin = undefined; }
    }
    const files = trackerBindingFiles(cwd, stateRoot());
    const scope = await ctx.ui.select("Save to", [`This project (${path.join(".promptr", "tracker.json")})`, `Global (${files.global})`]);
    if (scope === undefined) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
    const target = scope.startsWith("Global") ? files.global : files.project;
    const checked = validateTrackerBinding({
      version: 1, provider, host, owner: owner.trim(), repo: repoName.trim(),
      ...(apiOrigin === undefined ? {} : { apiOrigin }), boundAt: new Date().toISOString(),
    });
    if (!checked.ok) { ctx.ui.notify(`Tracker binding not written: ${checked.error}`, "error"); return false; }
    if (nodeBindingIoDeps.exists(target)) {
      const overwrite = await ctx.ui.confirm("Overwrite?", target);
      if (!overwrite) { ctx.ui.notify("Tracker binding unchanged.", "info"); return false; }
    }
    const written = writeTrackerBinding(target, checked.binding, { force: true });
    if (!written.ok) { ctx.ui.notify(written.error, "error"); return false; }
    const tokenVar = tokenVariableFor(provider);
    const present = (process.env[tokenVar] ?? "").trim().length > 0;
    const envNote = (process.env.PROMPTR_TRACKER ?? "").trim() !== "" ? "\nNote: PROMPTR_TRACKER is set and overrides the file (source env)." : "";
    ctx.ui.notify(
      `Tracker bound: ${trackerLabel(checked.binding)} → ${written.file}\n${tokenVar} ${present ? "present (value not shown)" : "not set; private repositories will fail"}`
      + `${envNote}\nClose and reopen the companion (and any hosted workboard) to use this binding; a companion that is already open does not pick it up.`, "info");
    return true;
  };

  pi.registerCommand("promptr-tracker", {
    description: "Tracker binding (Gitea/GitHub): /promptr-tracker [status|init|check]",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "init") { await trackerInitFlow(ctx); return; }
      const bound = loadTrackerBinding(ctx.cwd, process.env);
      if (sub === "check") {
        if (!bound.resolution.ok) { ctx.ui.notify(`Tracker ${bound.resolution.provider} unconfigured (source ${bound.source}): ${bound.resolution.reason}`, "warning"); return; }
        const repo = bound.resolution.config.repo;
        try {
          const page = await trackingPorts(bound.effectiveEnv, { timeoutMs: 8000, withBlockers: false }).listPage(repo, 1);
          ctx.ui.notify(`${trackerLabel(repo)} reachable: ${String(page.items.length)} issue(s) on page 1 (source ${bound.source}).`, "info");
        } catch (error) {
          ctx.ui.notify(`${trackerLabel(repo)} unreachable: ${error instanceof Error ? error.message.slice(0, 120) : "read failed"}`, "warning");
        }
        return;
      }
      if (sub !== "" && sub !== "status") { ctx.ui.notify("Usage: /promptr-tracker [status|init|check]", "warning"); return; }
      const lines: string[] = [];
      if (bound.resolution.ok) {
        const c = bound.resolution.config;
        lines.push(`Tracker ${c.provider} ${c.repo.host} ${c.repo.owner}/${c.repo.repo} · source ${bound.source}`);
        const tokenVar = tokenVariableFor(c.provider);
        lines.push(c.tokenPresent ? `${tokenVar} present (value not shown)` : `${tokenVar} not set; private repositories will fail`);
      } else {
        lines.push(`Tracker ${bound.resolution.provider} unconfigured · source ${bound.source}: ${bound.resolution.reason}`);
      }
      lines.push(`project file: ${bound.files.project} (${bound.present.project ? "present" : "absent"})`);
      lines.push(`global file: ${bound.files.global} (${bound.present.global ? "present" : "absent"})`);
      lines.push(`origin remote: ${bound.gitRemote ?? "none"}`);
      for (const problem of bound.problems) lines.push(`warning: ${problem}`);
      lines.push("precedence: env PROMPTR_TRACKER > project file > global file > recognized origin > Promptr-only fallback; otherwise unbound");
      if (bound.source === "promptr-fallback" || bound.source === "remote" || bound.source === "unbound") lines.push("Not bound explicitly: /promptr-tracker init or promptr-tracker-init --provider gitea|github");
      lines.push("A binding change needs a reopen: an already-open companion stops tracking the old repository and does not switch to the new one; hosted boards re-read it when reopened.");
      ctx.ui.notify(lines.join("\n"), bound.resolution.ok ? "info" : "warning");
    },
  });

  // ---- /promptr-doctor: sanitized environment check; `init` runs the tracker binding first ----
  pi.registerCommand("promptr-doctor", {
    description: "Sanitized checks: versions, install, skills, workflow overrides, capability probe, OpenKnowledge/tracker config, state ownership. /promptr-doctor init binds the tracker first",
    handler: async (args, ctx) => {
      if (args.trim() === "init") await trackerInitFlow(ctx);
      const models = registryModels(ctx);
      const probe = { ...buildProbe(ctx.cwd), ...(models === undefined ? {} : { registryModels: models.length }) };
      const report = runDoctor(probe);
      ctx.ui.notify(renderDoctor(report), report.ok ? "info" : "warning");
    },
  });

  // ---- /promptr-save: checkpoint progress ----
  pi.registerCommand("promptr-save", {
    description: 'Record a progress checkpoint: /promptr-save "did X, next Y"',
    handler: async (args, ctx) => {
      const text = args.trim().replace(/^["']|["']$/g, "");
      if (!text) {
        ctx.ui.notify('Usage: /promptr-save "did X, next Y"', "warning");
        return;
      }
      const paths = pathsOf();
      ensureDir(paths.dir);
      const snap = gitSnapshot(paths.cwd);
      const entry = appendProgress(paths.progress, paths.log, {
        text, cwd: paths.cwd, head: snap.head, ref: snap.ref, dirty: snap.dirty, changed: snap.changed,
      });
      ctx.ui.notify(`Checkpoint ${entry.id} saved (${entry.head}${snap.dirty ? ", dirty" : ""}).`, "info");
    },
  });

  // ---- /promptr-status: progress + queue at a glance ----
  // ---- Catch-Me-Up ----
  // Real deps for one gather: git, fs, the tracker binding from the
  // environment (dispatched by provider inside the ports) and, when the
  // briefing is connected and credentials exist, the OpenKnowledge pages.
  const catchUpDepsFor = (paths: ProjectPaths): CatchUpDeps => {
    const binding = loadTrackerBinding(paths.cwd, process.env);
    const deps: CatchUpDeps = {
      exec: nodeGitExec(), fs: nodeCatchUpFs(), now: () => Date.now(), env: binding.effectiveEnv, homedir: () => homedir(),
    };
    if (binding.resolution.ok) deps.tracker = { repo: binding.resolution.config.repo, ports: trackingPorts(binding.effectiveEnv, { timeoutMs: 8000 }) };
    let store: BriefingStore | undefined;
    try { store = new BriefingStore(paths.cwd, "# Project briefing\n\nNot recorded yet.\n"); } catch { store = undefined; }
    if (store?.saved) deps.brief = { text: store.text, updated: store.updated, ...(store.target ? { target: store.target } : {}) };
    const target = store?.target;
    if (target) {
      try {
        const pages = projectPagesFor(target.origin, path.basename(paths.cwd), target.docName);
        deps.openKnowledge = { client: OpenKnowledgeClient.fromEnv(target.origin), pages };
      } catch { /* unusable binding = offline gap inside the run */ }
    }
    return deps;
  };

  pi.registerCommand("promptr-catchup", {
    description: "Catch-Me-Up: gather tracker, repository, worktree, handoff and brief progress into a digest (no model run)",
    handler: async (args, ctx) => {
      const parsed = parseCatchUpArgs(args);
      if ("error" in parsed) { ctx.ui.notify(parsed.error, "warning"); return; }
      const paths = pathsOf();
      ensureDir(paths.dir);
      const result = await runCatchUp({ cwd: paths.cwd, paths, deps: catchUpDepsFor(paths), ...(parsed.since === undefined ? {} : { explicitSince: parsed.since }) });
      const summary = catchUpCursorLine(parseCatchUpCursor(readText(paths.catchup)), Date.now());
      const gaps = result.digest.gaps.length > 0 ? `\n${String(result.digest.gaps.length)} gap(s); first: ${result.digest.gaps[0] ?? ""}` : "";
      ctx.ui.notify(`${summary}\nfile: ${result.file}\nOpenKnowledge handoffs page: ${result.openKnowledge}${gaps}`, "info");
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select("Catch-Me-Up written. Review the digest?", ["Done", "Review"]);
      if (choice !== "Review") return;
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        const lines = result.markdown.split("\n");
        let offset = 0;
        return {
          invalidate() {},
          render(width) {
            const rows = Math.max(4, tui.terminal.rows - 4);
            const body = lines.slice(offset, offset + rows).map((l) => truncateToWidth(sanitizeLine(l, 4000), width, ""));
            while (body.length < rows) body.push("");
            return [truncateToWidth(`CATCH-ME-UP · ${result.file} · ↑↓ PgUp PgDn scroll · Esc closes`, width, ""), ...body];
          },
          handleInput(data) {
            const page = Math.max(1, tui.terminal.rows - 4);
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) { done(); return; }
            if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
            else if (matchesKey(data, "down")) offset = Math.min(Math.max(0, lines.length - 1), offset + 1);
            else if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - page);
            else if (matchesKey(data, "pageDown")) offset = Math.min(Math.max(0, lines.length - 1), offset + page);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.registerCommand("promptr-status", {
    description: "Show git snapshot, recent checkpoints, queue, staged handoffs, and tracker (Gitea/GitHub) status",
    handler: async (_args, ctx) => {
      const paths = pathsOf();
      const snap = gitSnapshot(paths.cwd);
      const progress = loadProgress(paths.progress);
      const queue = loadQueueFile(paths.queue);
      const handoffs = listFiles(paths.handoffsDir).filter(isHandoffDocument);
      const latest = handoffs[handoffs.length - 1];
      const receipts = listReceipts(paths);
      const lastReceipt = receipts[receipts.length - 1];
      const receiptLine = lastReceipt
        ? `\nhandoff receipt: ${lastReceipt.name} ${lastReceipt.state}${lastReceipt.launch ? ` (launch ${lastReceipt.launch})` : ""}${lastReceipt.reason ? ` - ${lastReceipt.reason}` : ""}`
        : "";
      const status = renderStatus({
        slug: paths.slug, cwd: paths.cwd, head: snap.head, ref: snap.ref,
        dirty: snap.dirty, changed: snap.changed,
        queueCount: queue.items.length, handoffCount: handoffs.length,
        ...(latest === undefined ? {} : { latestHandoff: latest }),
        entries: progress.entries,
      });
      const tracking = await loadTracking(paths);
      const trackingText = tracking.snapshot
        ? `\n\n${renderFullText(tracking.snapshot)}\n(${tracking.source}: ${tracking.reason})`
        : `\n\ntracking: unavailable — ${tracking.reason}. The tracker stays authoritative.`;
      const catchUp = catchUpCursorLine(parseCatchUpCursor(readText(paths.catchup)), Date.now());
      ctx.ui.notify(`${status}\n${catchUp}${trackingText}\n\n${describeWrapContext(ctx)}${receiptLine}`, "info");
    },
  });

  // ---- /handoffr: Coordinator-authored handoff (Phase A) + finish (Phase B) ----
  pi.registerCommand("handoffr", {
    description: "Ask this Coordinator to write a handoff, validate and sync it, then optionally launch a same-runtime successor tab; `finish [name]` reruns Phase B",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const finish = /^finish(\s+(\S+))?$/.exec(trimmed);
      if (finish) {
        const paths = pathsOf();
        let name = finish[2]?.replace(/\.md$/, "");
        if (!name) {
          const pending = listReceipts(paths).filter((r) => r.state === "requested" || r.state === "invalid");
          name = pending[pending.length - 1]?.name;
        }
        if (!name) { ctx.ui.notify("No handoff awaiting finish. Run /handoffr first.", "info"); return; }
        await finishHandoffPhaseB(pi, ctx, name);
        return;
      }
      await requestHandoffPhaseA(pi, ctx, trimmed.length > 0 ? trimmed : undefined);
    },
  });

  // Run after all settled handlers (including Herdr's idle publisher) return.
  // agent_end is too early: retries/follow-ups may remain and Herdr is working.
  let handoffFinishTimer: ReturnType<typeof setTimeout> | undefined;
  pi.on("session_shutdown", () => { clearTimeout(handoffFinishTimer); handoffFinishTimer = undefined; });
  pi.on("agent_settled", (_event, ctx) => {
    clearTimeout(handoffFinishTimer);
    const scheduledEpoch = epoch;
    handoffFinishTimer = setTimeout(() => {
      handoffFinishTimer = undefined;
      if (scheduledEpoch !== epoch || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      void finishSettledHandoff(ctx);
    }, 0);
  });
  const finishSettledHandoff = async (ctx: ExtensionContext): Promise<void> => {
    let paths: ProjectPaths;
    let sessionId: string;
    try { paths = projectPaths(ctx.cwd); sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
    const pending = listReceipts(paths).filter((r) => r.state === "requested" && r.sessionId === sessionId);
    const receipt = pending[pending.length - 1];
    if (!receipt) return;
    try { await finishHandoffPhaseB(pi, ctx, receipt.name); }
    catch (error) { ctx.ui.notify(`Handoff Phase B failed: ${error instanceof Error ? error.message : "unknown"}. Run /handoffr finish ${receipt.name}.`, "error"); }
  };

  // ---- /promptr-resume: successor session picks up a staged handoff ----
  pi.registerCommand("promptr-resume", {
    description: "List staged handoffs; review and explicitly submit one to continue work",
    handler: async (_args, ctx) => {
      const paths = pathsOf();
      const files = listFiles(paths.handoffsDir).filter(isHandoffDocument);
      if (files.length === 0) {
        ctx.ui.notify("No staged handoffs. In the previous session, run /handoffr to stage one.", "info");
        return;
      }
      const choice = await ctx.ui.select("Choose a staged handoff (Esc returns)", files);
      if (choice === undefined) return;
      const text = readText(path.join(paths.handoffsDir, choice));
      if (!text) {
        ctx.ui.notify("Could not read that handoff file.", "error");
        return;
      }
      if (!await reviewAndConfirmText(ctx, text)) return;
      const session = ctx.sessionManager.getSessionId();
      const leaf = ctx.sessionManager.getLeafId();
      if (ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf
        || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Session/readiness changed during review. Nothing attempted.", "warning");
        return;
      }
      try {
        pi.sendUserMessage(text, { expandPromptTemplates: false });
        ctx.ui.notify("Handoff submitted (attempted/unknown). Verify Pi acts on it.", "info");
      } catch {
        ctx.ui.notify("Submission threw; delivery unknown.", "error");
      }
    },
  });

  // ---- /work-status: Omakase-adapted tracker browse (read-only browse + explicit start) ----
  pi.registerCommand("work-status", {
    description: "Browse tracker (Gitea/GitHub) milestones/issues with progress; queue an explicit start prompt",
    handler: async (_args, ctx) => {
      const paths = pathsOf();
      ensureDir(paths.dir);
      const loaded = await loadTracking(paths);
      const snapshot = loaded.snapshot;
      if (!snapshot) {
        ctx.ui.notify(`Project tracking unavailable — ${loaded.reason}. The tracker stays authoritative.`, "warning");
        return;
      }
      ctx.ui.notify(`${renderFullText(snapshot)}\n(${loaded.source}: ${loaded.reason})`, "info");
      const milestoneLabels = snapshot.groups.map(
        (g) => `${shortMilestone(g.name)} — ${g.closed}/${g.total} closed (${g.open} open)`,
      );
      const pickedMilestone = await ctx.ui.select("Choose a milestone (Esc closes)", milestoneLabels);
      if (pickedMilestone === undefined) return;
      const group = snapshot.groups[milestoneLabels.indexOf(pickedMilestone)];
      if (!group || group.openIssues.length === 0) {
        ctx.ui.notify("No open issues listed in that milestone. Nothing queued.", "info");
        return;
      }
      const issueLabels = group.openIssues.map((i) => `#${i.number} ${i.title}`);
      const pickedIssue = await ctx.ui.select(`Choose an open issue in ${group.name} (Esc closes)`, issueLabels);
      if (pickedIssue === undefined) return;
      const issue = group.openIssues[issueLabels.indexOf(pickedIssue)];
      if (!issue) return;
      const prompt = buildIssueStartPrompt(issue, snapshot.repo);
      if (!await reviewAndConfirmText(ctx, prompt)) return;
      const queue = loadQueueFile(paths.queue);
      try {
        saveQueueFile(paths.queue, enqueueText(queue, prompt));
      } catch {
        ctx.ui.notify("Could not queue the start prompt. Nothing queued.", "error");
        return;
      }
      const fresh = loadQueueFile(paths.queue);
      const item = fresh.items[fresh.items.length - 1];
      if (!item) {
        ctx.ui.notify("Queue write produced no item. Nothing to submit.", "error");
        return;
      }
      ctx.ui.notify("Start prompt queued. One review-and-submit — attempted != delivered.", "info");
      const generation = epoch;
      await attemptSingleDialog(pi, ctx, item, attempts, () => epoch === generation, () => reviewAndConfirmText(ctx, item.text));
    },
  });

  // /promptr and /coordinatr show the integrated sidebar; the legacy Herdr pane launch stays explicit.
  registerCoordinatr(pi, undefined, "coordinatr-herdr");
  registerSidebar(pi, {
    attempts,
    workspace: (ctx, isCurrent) => openWorkspace("", ctx, isCurrent),
    review: (ctx, queue, isCurrent) => submitOneItem(pi, ctx, queue.items, attempts, isCurrent),
    refresh: async (cwd) => trackingLinesForView(await loadTracking(projectPaths(cwd))),
    record: (cwd, before, after, note) => {
      const paths = projectPaths(cwd);
      logPrompt(paths, [...diffQueueEvents(before, after), ...(note === undefined ? [] : [{ kind: "note-revision" as const, text: note }])]);
    },
  });
}
