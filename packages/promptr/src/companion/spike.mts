#!/usr/bin/env node
/**
 * Promptr companion entrypoint: session-only demo or shared-files coordinatr window.
 *
 * - Without `--state-dir`: disposable interaction prototype. Sample note,
 *   in-memory queue, nothing saved, nothing sent (historical demo behavior).
 * - With `--state-dir <projectDir>`: full-parity coordinatr window. Loads and
 *   saves the same `scratch.md` / `queue.json` / `composer.md` files the
 *   Pi-hosted `/promptr` view uses, shows the same board/composer/note UI with
 *   `hosted:true` (persistent banner, Ctrl+S review, `s` submit, Ctrl+U / `x`
 *   Clear Queue), and offers explicit direct send to the left Pi pane via
 *   `herdr agent prompt <pi-pane> <text>` after an in-window review.
 *
 * Direct send is always explicit, one item at a time, with the full text
 * visible before confirmation. Attempted != delivered: the queue item is
 * retained, and Pi may fail asynchronously. No automatic draining or retries.
 *
 * Optional `--tracking-file <tracking.json>` reads one Gitea display snapshot
 * (written by the Pi extension) for the coordinatr window. Best-effort,
 * never writes; without the flag the demo reads nothing extra. In persistent
 * mode the tracking section refreshes every 5s from the same file.
 *
 * Optional `--pi-pane <paneId>` sets the left Pi target for direct send
 * (`herdr agent prompt`). Without it, review explains how to submit via
 * `/promptr` in the left Pi pane; nothing is sent.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, existsSync, appendFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { execFile, spawnSync } from "node:child_process";
import { ProcessTerminal, TuiAltScreen, visibleWidth, isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { CompanionSpikeView, NOT_SAVED_BANNER, SPIKE_BANNER, boardColors, isSupportedText, keyReferenceText, sectionRule } from "./view.mts";
import type { CompanionSessionState } from "./view.mts";
import { emptyQueue, parseQueue, serializeQueue } from "../queue/pending.mts";
import type { PendingQueue, PendingItem } from "../queue/pending.mts";
import { BriefingStore } from "../briefing/store.mts";
import { OpenKnowledgeBriefing, OpenKnowledgeClient } from "../briefing/openknowledge.mts";
import {
  checkProjectPages, createOpenKnowledgePoller, defaultProjectLabel, okHeaderLabel, projectPagesFor,
  type OpenKnowledgeStatus, type ProjectPages,
} from "../sync/project-pages.mts";
import {
  appendPromptLog, createPromptLogSyncer, diffQueueEvents, promptLogFiles, textHash,
  type PromptLogInput, type PromptLogSyncResult,
} from "../sync/prompt-log.mts";
import { latestPromptLogNotebook, parseWorkspacePage, workspaceImportDecision, workspaceSignature, workspaceNotebook } from "../sync/workspace-hydrate.mts";
import { clientIdentity } from "../state/client.mts";
import { createInboxPoller, readSeen, serializeSeen } from "../sync/inbox.mts";
import { createWorkspaceMirrorScheduler, type WorkspaceMirrorStatus } from "../sync/workspace-mirror.mts";
import { buildGeneratorPacket } from "../generate/packet.mts";
import {
  DEFAULT_GENERATOR_SKILL, createGeneratorRegistry, generatorRuntime, generatorRuntimeOverride,
  loadCapabilityProbe, resolveSkillPath, runGenerator, runtimeLabel, withFreshCatchUp,
} from "../generate/launch.mts";
import { BriefingController } from "../briefing/overview.mts";
import { projectPaths, stateRoot } from "../state/paths.mts";
import { appendProgress } from "../progress/tracker.mts";
import {
  autoCheckEnabled, autoStatusLine, buildAutoWorkState, defaultAutoCheckRecord,
  firstContentLine, loadAutoRecordFile, maybeAutoCheckpoint, saveAutoRecordFile,
  type AutoCheckRecord,
} from "../progress/autoCheckpoint.mts";
import { gitRemoteUrl, gitSnapshot, type GitSnapshot } from "../git/snapshot.mts";
import { CompanionBriefingDialogs } from "./briefing-dialogs.mts";
import { resumeBriefingInMainPi } from "./briefing-send.mts";
import { executeHerdrFresh, startFreshBriefingInNewPi } from "./briefing-fresh.mts";
import { isHerdrPaneId } from "../herdr/identity.mts";
import {
  isValidTrackingRepo, parseSnapshot, renderCompactLines, renderPlaceholderLines,
} from "../tracking/gitea.mts";
import type { TrackedIssue, TrackingRepo, TrackingSnapshot } from "../tracking/gitea.mts";
import { trackingPorts, type TrackingReadPorts } from "../tracking/ports.mts";
import { trackerLabel } from "../tracking/config.mts";
import { bindingSourceSuffix } from "../tracking/binding.mts";
import { loadTrackerBinding } from "../tracking/binding-io.mts";
import { repoIdentity } from "../tracking/gitea.mts";
import { catchUpDraftLines, catchUpSummaryLine } from "../tracking/catchup.mts";
import { loadFreshCatchUp, loadLatestCatchUp, nodeCatchUpFs, nodeGitExec, runCatchUp, type CatchUpDeps } from "../tracking/catchup-sources.mts";
import { TrackingNavigationController } from "../tracking/selection.mts";
import { TrackingModal } from "./tracking-dialogs.mts";
import { catalogPort } from "../workflow/catalog.mts";
import { createReloadingCatalog, nodeWorkflowLoadDeps } from "../workflow/load.mts";
import { buildWorkBoard, type BoardIssue, type WorkBoard } from "../tracking/board.mts";
import { buildTaskPromptDraft } from "../tracking/prompt-draft.mts";
import { draftFor, nodeRequestsPort } from "../tracking/requests.mts";
import { loadTrackingSnapshotForRepo, sameTrackingRepo } from "../tracking/cache.mts";
import {
  createTrackingRefresher, gitHeaderLabel, invalidateTracking, parseAgentStatus, piHeaderLabel, requestFileName } from "./host-tracking.mts";
import type { AgentStatus, CatchUpPort, CatchUpResult } from "./host-tracking.mts";
import { readPiStatusNow, reviewStatusLine, sendGuardDecision } from "./send-guard.mts";

/** Built-in curated sample note for session-only demo. Never touches real notes. */
const SAMPLE_NOTE = [
  "# Curated sample note (in memory only)",
  "",
  "First paragraph: edit this line to see the note change while the",
  "queue above stays exactly as you left it.",
  "",
  "Second paragraph: move to the panel with Tab, then use Up/Down and",
  "Shift+Up/Down to select whole physical lines.",
  "",
  "Third paragraph: press Enter in the panel to copy the selection into",
  "the session queue. Copying never edits or removes note text.",
  "",
  "Last line.",
].join("\n");

const HELP = `${SPIKE_BANNER}

Usage:
  promptr-companion-spike --help
  promptr-companion-spike demo
  promptr-companion-spike demo --self-check
  promptr-companion-spike demo --tracking-file <tracking.json>
  promptr-companion-spike demo --state-dir <projectDir> [--tracking-file <tracking.json>] [--pi-pane <paneId>]

Session-only demo (no --state-dir):
  - ${NOT_SAVED_BANNER}.
  - There is no state directory, no import, no send, no sync and no execution.
  - Supported input is printable ASCII plus Enter. Unsupported text and marked
    paste are refused with a visible notice and never inserted.
  - Marked paste is rejected. Use a bracketed-paste-capable terminal; unmarked
    paste cannot be distinguished from typing. Do not paste into this demo.
  - --tracking-file reads one Gitea display snapshot for the coordinatr window.
    Read-only, best-effort, never writes; Gitea stays authoritative.

Shared-files coordinatr window (--state-dir):
  - Loads/saves the same scratch.md / queue.json / composer.md as /promptr.
  - Same board/composer/note UI, persistent banner, tracking section.
  - Ctrl+O project briefing: edit/save, OpenKnowledge, Resume to main Pi,
    or Start fresh (explicit Herdr successor launch, source-only, uninstalled).
  - Esc / Ctrl+C step back through briefing dialogs to the workspace; they
    never exit the companion window itself.
  - Ctrl+S queues the composer (if non-empty) and reviews one item.
  - Panel s reviews the focused thought; j/k move thought focus. [ ] walk the
    notebook entries (marked '-- ... --' / '-- end --' blocks or paragraphs);
    Enter queues the highlighted entry, S queues and reviews it, E copies it
    to the composer, D deletes it. Ctrl+N in the notebook inserts a note block.
  - Ctrl+U (any focus) or x (panel) clears the queue after y/n confirmation.
  - Review shows the exact text; Enter submits via herdr to --pi-pane.
  - Review checks the left Pi's Herdr status: working needs a second Enter, blocked refuses.
  - Without --pi-pane nothing is sent; the review says to use /promptr left.
  - Attempted != delivered: items are retained, no auto-drain, no retries.
  - Last-write-wins with /promptr left. The workboard refreshes from Gitea
    every 5 minutes (r refreshes now) and re-reads the cache file every 5s.
  - OpenKnowledge inbox: every 30 s (and on r) new blocks on projects/<slug>/inbox are queued once as [web] thoughts; a trailer is appended to the page; inbox-seen.json remembers what was queued.
  - Tab also reaches the WORKBOARD when the snapshot names a usable repository.
    Up/Down, PgUp/PgDn, Home/End move over issue cards; Enter opens the issue
    detail (native dependency state), g starts Generate Prompt, r refreshes,
    Esc returns to the workspace. Reads are GET-only; nothing launches.
  - Generate Prompt: workflow, then provider, then an inert role preview.
    Enter = "Prepare request -> draft to composer (no launch)": the packet is
    saved under requests/ and a deterministic draft lands in the composer.
    g = the same, then a fresh generator Pi is started in a new Herdr tab
    (Sol medium on the selected provider, one skill, read/write tools only);
    when it finishes, its output replaces the draft only if you have not
    edited it. Ctrl+S reviews before anything is sent. Closed, retired,
    natively blocked or unreadable issues block the request.
    PROMPTR_GENERATOR_RUNTIME=<provider>/<model>:<thinking> overrides the
    generator runtime for trials; PROMPTR_GENERATOR_SKILL overrides the skill.
  - In the issue detail, p lists the saved requests/ packets for that issue
    (newest first); Enter reopens the generated text (or the deterministic
    draft) into an empty composer. Nothing launches or sends.
  - Header shows git ref/head (refreshed every 60s), the Pi pane's Herdr
    agent status (every 10s) and the OpenKnowledge binding (OK <age> after a
    successful check every 60s, OK offline, OK unbound) when --project-cwd /
    --pi-pane are set. Ctrl+O -> Connect OpenKnowledge binds the project pages.

Keys (? in the QUEUE panel or WORKBOARD shows the same list in place):
${keyReferenceText()}

Options:
  --help          Show this help and exit.
  --self-check    Run a bounded offline check and exit; no TTY needed.
  --tracking-file <f>  Gitea display snapshot (read-only, best-effort).
  --state-dir <dir>    Project state dir with scratch.md/queue.json/composer.md.
  --pi-pane <id>       Left Pi pane for direct send (herdr agent prompt).
  --project-cwd <dir>  Project-local briefing root (set by /coordinatr-herdr).
  --pi-session <file>  Original main Pi session for guarded briefing Resume.
`;

/** Read-only tracking snapshot for the coordinatr window. Never throws, never writes. */
export function loadTrackingLines(file: string | undefined): string[] {
  if (!file) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const snapshot = parseSnapshot(JSON.parse(raw) as unknown);
    if (!snapshot) return renderPlaceholderLines("snapshot unreadable");
    return renderCompactLines(snapshot);
  } catch {
    return renderPlaceholderLines("snapshot unavailable");
  }
}

/** Persistent startup lines are scoped by the already-resolved binding. */
export function loadPersistentTrackingLines(
  file: string | undefined,
  repo: TrackingRepo | undefined,
  unboundReason: string,
): string[] {
  if (!repo) return renderPlaceholderLines(unboundReason);
  if (!file) return renderPlaceholderLines("snapshot unavailable");
  const snapshot = loadTrackingSnapshotForRepo(file, repo);
  return snapshot ? renderCompactLines(snapshot) : renderPlaceholderLines("snapshot unavailable");
}

/**
 * Decide what to do with a tracking snapshot that has just arrived.
 *
 * The in-memory binding is not enough on its own. This companion coalesces
 * refreshes, so while one request is in flight there is no second refresh to
 * notice that the binding file changed: `boundRepo`, the generation and the
 * dead flag all still describe repository A. The effective binding must
 * therefore be re-resolved from disk/env *after* the await, and the result
 * compared against the identity that was actually asked for.
 *
 * `resolveEffective` is the same project-cwd/env resolution the pre-fetch
 * check uses, injected so this decision is provable without a terminal.
 * Returning `"accept"` means the answer still belongs to the live binding;
 * anything else is a terminal reason the caller hands to the single
 * `endTrackingSession` path before any cache write or board emission.
 */
export function trackingFetchDisposition(asked: {
  repo: TrackingRepo;
  generation: number;
}, session: {
  generation: number;
  dead: boolean;
}, resolveEffective: () => { ok: true; repo: TrackingRepo; label: string } | { ok: false; reason: string }): { accept: true } | { accept: false; reason: string } {
  // A session that ended while the request was in flight resumes nothing,
  // even for its own identity.
  if (session.dead || asked.generation !== session.generation) {
    return { accept: false, reason: "tracker binding changed while reading" };
  }
  const effective = resolveEffective();
  if (!effective.ok) return { accept: false, reason: effective.reason };
  // Exact provider/normalized host/owner/repo identity: a same-identity
  // completion (including a legacy/normalized spelling) is still usable.
  if (!sameTrackingRepo(asked.repo, effective.repo)) {
    return { accept: false, reason: `tracker binding changed to ${effective.label}` };
  }
  return { accept: true };
}

/**
 * Repo binding for structured navigation, taken from the snapshot the Pi
 * extension wrote. Never from an issue's own HTML URL: identity and every
 * authenticated read stay pinned to the repository the snapshot names.
 */
export function loadTrackingRepo(file: string | undefined): TrackingRepo | undefined {
  if (!file) return undefined;
  try {
    const snapshot = parseSnapshot(JSON.parse(readFileSync(file, "utf8")) as unknown);
    if (!snapshot || !isValidTrackingRepo(snapshot.repo)) return undefined;
    return snapshot.repo;
  } catch {
    return undefined;
  }
}

function readTextBestEffort(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function ensureDirBestEffort(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* best effort */ }
  try {
    chmodSync(dir, 0o700);
  } catch { /* best effort */ }
}

function atomicWriteBestEffort(file: string, text: string): void {
  ensureDirBestEffort(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

function appendBestEffort(file: string, text: string): void {
  ensureDirBestEffort(dirname(file));
  appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
}

/** Load shared note/queue/composer for --state-dir mode. Never throws. */
export function loadSharedState(stateDir: string): { noteText: string; queue: PendingQueue; noteSeeded: boolean } {
  let queue = emptyQueue();
  const rawQueue = readTextBestEffort(join(stateDir, "queue.json"));
  if (rawQueue !== undefined) {
    try {
      queue = parseQueue(rawQueue);
    } catch {
      queue = emptyQueue();
    }
  }
  const rawNote = readTextBestEffort(join(stateDir, "scratch.md"));
  // noteSeeded marks the in-memory SAMPLE_NOTE fallback (missing, empty or
  // out-of-contract file). Callers must not persist it: writing the sample
  // would destroy real notes another client saved after our load.
  const noteSeeded = !(rawNote !== undefined && rawNote.length > 0 && isSupportedText(rawNote));
  return { noteText: noteSeeded ? SAMPLE_NOTE : (rawNote as string), queue, noteSeeded };
}

/** Save shared note/queue/composer. Best effort; throws on failure for caller notice. */
export function saveSharedState(stateDir: string, snapshot: CompanionSessionState, opts?: { skipNote?: boolean }): void {
  // skipNote keeps a seeded in-memory sample display-only until the user
  // types real notes. Queue and composer still save; only the notebook waits.
  if (!opts?.skipNote) {
    atomicWriteBestEffort(join(stateDir, "scratch.md"), snapshot.noteText);
  }
  atomicWriteBestEffort(join(stateDir, "queue.json"), serializeQueue(snapshot.queue));
  atomicWriteBestEffort(join(stateDir, "composer.md"), snapshot.composerText);
}

/** Tiny integration seam enforcing local-first persistence before any remote scheduling. */
export function saveThenScheduleWorkspaceMirror(save: () => void, schedule: () => void): void {
  save();
  schedule();
}

/** Pending mirror work outranks a healthy reachability age until a write succeeds. */
export function workspaceOkHeaderLabel(
  reachable: OpenKnowledgeStatus,
  mirror: WorkspaceMirrorStatus,
  nowMs: number,
): string {
  return mirror === "pending" ? "OK pending" : okHeaderLabel(reachable, nowMs);
}

/** Exact direct-send argv for a valid Herdr pane; prompt text is one argv item. */
export function buildHerdrPromptArgs(piPane: string, text: string): string[] | undefined {
  return isHerdrPaneId(piPane) ? ["agent", "prompt", piPane, text] : undefined;
}

/**
 * Direct send via Herdr agent surface. No shell: argv only, user-explicit text.
 * Never throws; returns a short notice-safe message.
 */
export function sendViaHerdr(piPane: string, text: string): { ok: boolean; message: string } {
  const args = buildHerdrPromptArgs(piPane, text);
  if (!args) {
    return { ok: false, message: "no valid --pi-pane — queue saved; submit via /promptr left" };
  }
  if (!text.trim()) {
    return { ok: false, message: "whitespace-only prompt not sent; queue kept" };
  }
  try {
    const res = spawnSync("herdr", args, {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const err = res.error ? String((res.error as Error).message).slice(0, 160) : "";
    const stderr = typeof res.stderr === "string" ? res.stderr.slice(0, 200).trim() : "";
    const stdout = typeof res.stdout === "string" ? res.stdout.slice(0, 200).trim() : "";
    if (res.error) {
      const msg = err.includes("ENOENT") ? "herdr not found — queue saved; submit via /promptr left" : `send failed (${err}) — queue kept`;
      return { ok: false, message: msg.slice(0, 280) };
    }
    if (res.status === 0) {
      return { ok: true, message: "submitted to left Pi — attempted/unknown, verify its reply; item kept" };
    }
    const detail = stderr || stdout || `exit ${String(res.status)}`;
    if (/agent_blocked/i.test(detail)) {
      return { ok: false, message: "left Pi is blocked (approval/question) — inspect it first; queue kept" };
    }
    if (/agent_prompt_stalled/i.test(detail)) {
      return { ok: false, message: "left Pi did not start — inspect left pane; queue kept" };
    }
    return { ok: false, message: `send rejected (${detail.slice(0, 140)}) — queue kept` };
  } catch (error) {
    return { ok: false, message: `send threw (${String((error as Error).message).slice(0, 120)}) — queue kept` };
  }
}

/**
 * Provider-routed reads; tokens stay in the environment, never in a
 * notice, packet or log. Rebuilt from the tracker binding at start and
 * on `r`, so a new tracker.json is picked up without restarting.
 */
let reads: TrackingReadPorts = trackingPorts(process.env, { timeoutMs: 8000, withBlockers: true });

/** Bounded, non-interactive proof that the view renders and responds. Prints only. */
function runSelfCheck(trackingLines: string[] = []): void {
  const view = newView(trackingLines);
  process.stdout.write(`${SPIKE_BANNER}\nself-check: no TTY required, no state directory, nothing stored\n`);
  for (const [width, height] of [[80, 16], [20, 8], [3, 3]] as const) {
    const frame = view.renderFrame(width, height);
    const widest = Math.max(0, ...frame.map((line) => visibleWidth(line)));
    const fits = frame.length === height && widest <= width;
    process.stdout.write(`frame ${width}x${height}: rows=${frame.length} widest=${widest} fits=${fits}\n`);
  }

  const noteBefore = view.getNoteText();
  view.setFocus("panel");
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[1;2B");
  view.handleInput("\r");
  view.handleInput("\r");
  view.setFocus("composer");
  view.handleInput("composer line");
  view.handleInput("\x05");
  view.handleInput("\x1b[200~pasted\ttext\x1b[201~");
  const pasteNotice = view.getNotice();
  view.handleInput("é");
  const rejectNotice = view.getNotice();
  // Clear Queue: Ctrl+U arms confirmation, y clears, composer/note kept.
  const queuedBeforeClear = view.getMockQueue().length;
  view.handleInput("\x15");
  const confirmingClear = view.isConfirmingClear();
  view.handleInput("y");
  const queuedAfterClear = view.getMockQueue().length;
  const clearNotice = view.getNotice();
  view.handleInput("\x03");
  const confirming = view.isConfirmingQuit();
  view.handleInput("n");

  // Hosted review flag is consumable for the coordinatr direct-send loop.
  const hosted = new CompanionSpikeView(new TuiAltScreen(new ProcessTerminal()), { noteText: "a\n", hosted: true });
  hosted.setFocus("composer");
  hosted.handleInput("hello");
  hosted.handleInput("\x13");
  const hadReview = hosted.getReviewRequested();
  const consumedIndex = hosted.consumeReviewRequest();
  const clearedAfterConsume = !hosted.getReviewRequested();
  const archived = hosted.getNoteText().includes("-- Queued ") && hosted.getNoteText().includes("hello");

  process.stdout.write(
    [
      `queue items: ${view.getMockQueue().length} (session only)`,
      `note unchanged by copying: ${view.getNoteText() === noteBefore}`,
      `composer cleared after enqueue: ${view.getComposerText() === ""}`,
      `paste refused: ${pasteNotice}`,
      `non-ASCII refused: ${rejectNotice}`,
      `clear queue: before=${queuedBeforeClear} confirming=${confirmingClear} after=${queuedAfterClear} notice=${clearNotice}`,
      `ctrl+c asks first: ${confirming}, exit requested after cancel: ${view.getExitRequested()}`,
      `hosted review consumable: requested=${hadReview} index=${String(consumedIndex)} cleared=${clearedAfterConsume}`,
      `composer archived to note: ${archived}`,
      "",
    ].join("\n"),
  );
  process.stdout.write(`${view.renderFrame(72, 20).join("\n")}\n`);
}

function newView(trackingLines: string[] = []): CompanionSpikeView {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  return new CompanionSpikeView(tui, { noteText: SAMPLE_NOTE, trackingLines });
}

function newPersistentView(
  tui: TuiAltScreen,
  noteText: string,
  queue: PendingQueue,
  trackingLines: string[],
  projectLabel?: string,
  trackingNavigation = false,
): CompanionSpikeView {
  const sessionState: CompanionSessionState = {
    noteText,
    composerText: queue.composer,
    queue,
    documentRevision: 0,
    selection: { startLine: 1, endLine: 1 },
    focus: "editor",
  };
  return new CompanionSpikeView(tui, {
    noteText,
    hosted: true,
    sessionState,
    trackingLines,
    overviewNavigation: true,
    trackingNavigation,
    ...(projectLabel === undefined ? {} : { projectLabel }),
  });
}

/** In-window review component for direct send: full exact text, scroll, Enter SUBMIT. */
class SendReview implements Component {
  private offset = 0;
  private readonly text: string;
  private readonly piPane: string | undefined;
  private readonly queueCount: number;
  private status: AgentStatus = "unknown";
  private warning = "";
  constructor(text: string, piPane: string | undefined, queueCount: number) {
    this.text = text;
    this.piPane = piPane;
    this.queueCount = queueCount;
  }
  invalidate(): void {}
  setStatus(status: AgentStatus): void {
    this.status = status;
  }
  setWarning(text: string): void {
    this.warning = text;
  }
  setOffsetMax(max: number): void {
    this.offset = Math.max(0, Math.min(this.offset, max));
  }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", safeWidth));
    const total = rows.length;
    const height = 24;
    const pageSize = Math.max(1, height - 6);
    this.offset = Math.min(this.offset, Math.max(0, total - pageSize));
    const slice = rows.slice(this.offset, this.offset + pageSize);
    const c = boardColors;
    // Same tint as the header's Pi fragment (view.mts paintHeaderLine).
    const tint = !this.piPane ? c.muted
      : this.status === "blocked" ? (text: string) => c.yellow(c.bold(text))
      : this.status === "working" ? c.yellow : this.status === "idle" ? c.green : c.dim;
    const statusRow = `${reviewStatusLine(this.piPane, this.status)} · queue holds ${this.queueCount} item(s) · one item only`;
    return [
      c.accentBold(sectionRule("REVIEW · explicit send", safeWidth)),
      c.bold(truncateToWidth("Submit this prompt? (exact text below, read only)", safeWidth, "")),
      tint(truncateToWidth(statusRow, safeWidth, "")),
      ...slice.map((line) => truncateToWidth(line, safeWidth, "")),
      c.dim(truncateToWidth(`Rows ${this.offset + 1}-${Math.min(total, this.offset + pageSize)}/${total}; ${this.text.length} bytes — starts a turn, may run tools`, safeWidth, "")),
      ...(this.warning.length > 0 ? [c.yellow(truncateToWidth(this.warning, safeWidth, ""))] : []),
      c.accent(truncateToWidth("Arrows/PgUp/PgDn scroll | Enter SUBMIT | Esc cancel", safeWidth, "")),
    ];
  }
  scroll(delta: number, pageSize: number, total: number): void {
    this.offset = Math.max(0, Math.min(Math.max(0, total - pageSize), this.offset + delta));
  }
}

function pickReviewItem(items: readonly PendingItem[], preferredIndex: number | undefined, focused: number): PendingItem | undefined {
  if (items.length === 0) return undefined;
  if (preferredIndex !== undefined) {
    const picked = items[preferredIndex];
    if (picked) return picked;
  }
  if (items.length === 1) return items[0];
  const fallback = items[Math.min(Math.max(0, focused), items.length - 1)];
  return fallback ?? items[0];
}

function runInteractive(trackingLines: string[] = [], opts?: { stateDir?: string; piPane?: string; trackingFile?: string; projectCwd?: string; piSession?: string }): void {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal);
  const stateDir = opts?.stateDir;
  const piPane = opts?.piPane;
  const trackingFile = opts?.trackingFile;

  if (!stateDir) {
    const view = new CompanionSpikeView(tui, { noteText: SAMPLE_NOTE, trackingLines });
    tui.setLayoutRoot(view.layoutRoot);
    tui.addInputListener((data: string) => {
      // Kitty key-release events reach listeners unfiltered (the framework only
      // filters them for focused components). Ignore releases: press already acted.
      if (!isKeyRelease(data)) view.handleInput(data);
      if (view.getExitRequested()) {
        tui.stop();
        process.stdout.write(`${NOT_SAVED_BANNER}\n`);
        process.exit(0);
      }
      tui.requestRender();
      return { consume: true };
    });
    tui.start();
    tui.requestRender(true);
    return;
  }

  // Persistent coordinatr window: shared files + direct send review.
  ensureDirBestEffort(stateDir);
  const initial = loadSharedState(stateDir);
  let currentTracking: string[];
  // Effective workflow catalog: shipped defaults, plus the local
  // override file when one exists. An invalid override leaves a catalog that
  // offers nothing and refuses every expansion, so selection and dispatch are
  // blocked rather than silently falling back to the shipped matrix.
  const workflowCatalog = createReloadingCatalog(catalogPort, process.env, nodeWorkflowLoadDeps);

  // Structured navigation needs a repository to read from. Without a usable
  // binding the pane keeps its historical three-region focus cycle.
  // The tracker binding (env > project file > global file > origin
  // remote > Promptr-only fallback > unbound) is authoritative and carries
  // the provider. Cache data never establishes a binding.
  let bound = loadTrackerBinding(opts?.projectCwd ?? process.cwd(), process.env);
  reads = trackingPorts(bound.effectiveEnv, { timeoutMs: 8000, withBlockers: true });
  const resolved = bound.resolution;
  const trackingRepo = resolved.ok ? resolved.config.repo : undefined;
  currentTracking = loadPersistentTrackingLines(trackingFile, trackingRepo, resolved.ok ? "tracker unavailable" : resolved.reason);
  // Keep board and navigation identity in sync on a binding change; routing
  // new-provider reads through an old-provider selection corrupts provenance.
  let boundRepo: TrackingRepo | undefined = trackingRepo;
  const bindingSuffix = (): string => bindingSourceSuffix(bound.source);
  /**
   * One terminal invalidation path for this companion's tracking session.
   * Any effective repository identity change — bound to unbound, or
   * repository A to repository B — ends the session for good: the old board,
   * navigation and modal are finished, and nothing resumes or switches
   * repositories in place. The user reopens the companion to track the new
   * binding, which is the intended behavior and keeps the old
   * repository unreachable instead of growing a live-rebind path.
   *
   * `trackingGeneration` fences work that was already in flight when this ran:
   * a fetch, cache write or board emission stamped with an older generation is
   * dropped rather than allowed to resurrect repository A.
   */
  let trackingGeneration = 0;
  let trackingDead = false;
  /** Reason shown for a session that ended; also what late callers report. */
  let trackingDeadReason = "";
  /** Assigned once the view, navigation and modal exist (see below). */
  let endTrackingSession = (_reason: string): void => {};
  /** Re-read the binding on `r`; returns a notice when the session ended. */
  const rebindTracker = (): string | undefined => {
    if (trackingDead) return trackingDeadReason;
    const next = loadTrackerBinding(opts?.projectCwd ?? process.cwd(), process.env);
    const before = boundRepo ? JSON.stringify(repoIdentity(boundRepo)) : "";
    bound = next;
    if (!next.resolution.ok) {
      endTrackingSession(next.resolution.reason);
      return trackingDeadReason;
    }
    const after = JSON.stringify(repoIdentity(next.resolution.config.repo));
    // A same-identity refresh stays usable: only the ports are rebuilt.
    if (before === after) {
      reads = trackingPorts(bound.effectiveEnv, { timeoutMs: 8000, withBlockers: true });
      return undefined;
    }
    // Identity changed. Fail closed on the old repository rather than
    // following the new one inside a session that is already showing A.
    endTrackingSession(`tracker binding changed to ${trackerLabel(next.resolution.config.repo)} ${bindingSourceSuffix(next.source)}`);
    return trackingDeadReason;
  };
  const nav = trackingRepo
    ? new TrackingNavigationController({
      repo: trackingRepo,
      ports: {
        listPage: (repo, page) => reads.listPage(repo, page),
        loadDetail: (repo, issueNumber) => reads.loadDetail(repo, issueNumber),
        now: () => new Date().toISOString(),
        // Coordinator integration: the effective workflow catalog
        // — shipped defaults with the local override applied. The port reads
        // a cached snapshot; `workflowCatalog.refresh()` re-reads the file at
        // the workflow-open boundary so a reopened picker sees edits. The
        // controller still shows "unavailable" if the port ever fails its
        // structural guard rather than inventing a matrix.
        catalog: workflowCatalog.port,
      },
    })
    : undefined;
  const view = newPersistentView(tui, initial.noteText, initial.queue, currentTracking, opts?.projectCwd, nav !== undefined);
  view.setNotice(workflowCatalog.current().error !== undefined
    ? workflowCatalog.describe()
    : `shared workspace · ${initial.queue.items.length} queued · Ctrl+S reviews, Ctrl+U clears`);
  tui.setLayoutRoot(view.layoutRoot);

  let mode: "main" | "review" | "overview" | "tracking" = "main";
  const dialogs = new CompanionBriefingDialogs(tui);
  let review: SendReview | undefined;
  let reviewItem: PendingItem | undefined;
  let armed = false;
  const projectCwd = opts?.projectCwd;

  // Catch-Me-Up: the companion `c` key runs the deterministic gather for
  // the bound project. Same deps as the hosted /promptr-catchup; no model run.
  const catchUpPaths = projectCwd ? projectPaths(projectCwd) : undefined;
  const catchUpDeps = (cwd: string): CatchUpDeps => {
    const binding = loadTrackerBinding(cwd, process.env);
    const deps: CatchUpDeps = {
      exec: nodeGitExec(), fs: nodeCatchUpFs(), now: () => Date.now(), env: binding.effectiveEnv, homedir: () => homedir(),
    };
    if (binding.resolution.ok) deps.tracker = { repo: binding.resolution.config.repo, ports: trackingPorts(binding.effectiveEnv, { timeoutMs: 8000 }) };
    let store: BriefingStore | undefined;
    try { store = new BriefingStore(cwd, "# Project briefing\n\nNot recorded yet.\n"); } catch { store = undefined; }
    if (store?.saved) deps.brief = { text: store.text, updated: store.updated, ...(store.target ? { target: store.target } : {}) };
    const target = store?.target;
    if (target) {
      try {
        const pages = projectPagesFor(target.origin, basename(cwd), target.docName);
        deps.openKnowledge = { client: OpenKnowledgeClient.fromEnv(target.origin), pages };
      } catch { /* unusable binding = offline gap inside the run */ }
    }
    return deps;
  };
  const catchUpPort: CatchUpPort | undefined = catchUpPaths
    ? {
      run: async (): Promise<CatchUpResult> => {
        const result = await runCatchUp({ cwd: catchUpPaths.cwd, paths: catchUpPaths, deps: catchUpDeps(catchUpPaths.cwd) });
        return { generatedAt: result.digest.generatedAt, summary: catchUpSummaryLine(result.digest, Date.now()), markdown: result.markdown, file: result.file };
      },
      latest: (): CatchUpResult | undefined => {
        const loaded = loadLatestCatchUp(catchUpPaths, readTextBestEffort);
        return loaded
          ? { generatedAt: loaded.digest.generatedAt, summary: catchUpSummaryLine(loaded.digest, Date.now()), markdown: loaded.packet.markdown, file: loaded.file }
          : undefined;
      },
      now: () => Date.now(),
    }
    : undefined;
  const trackingModal = nav
    ? new TrackingModal(nav, {
      rows: () => Math.max(8, tui.terminal.rows),
      onChange: () => tui.requestRender(),
      // Requests browser: saved packets and generated drafts under requests/.
      requests: nodeRequestsPort(join(stateDir, "requests")),
      ...(catchUpPort === undefined ? {} : { catchUp: catchUpPort }),
    })
    : undefined;

  // The terminal invalidation declared above, now that the view, navigation
  // and modal exist. Everything that could still reach the old repository is
  // stopped here in one place: the generation fence drops in-flight work, the
  // controller abandons its reads, an open tracking modal is left for the
  // workspace, and the board is cleared with reopen guidance.
  endTrackingSession = (reason: string): void => {
    if (trackingDead) return;
    trackingDead = true;
    trackingGeneration += 1;
    boundRepo = undefined;
    trackingDeadReason = `${reason} · tracking stopped — close and reopen the companion to track it`;
    // Abandon in-flight list/detail reads; a late response resolves into nothing.
    nav?.cancel();
    // An open modal must not outlive the binding it was opened against.
    if (mode === "tracking") {
      mode = "main";
      tui.setLayoutRoot(view.layoutRoot);
    }
    currentBoard = undefined;
    view.setWorkBoard(undefined, trackingDeadReason);
    view.setNotice(trackingDeadReason);
    refreshWorkspaceMirror();
    tui.requestRender(true);
  };

  // OpenKnowledge pages always derive from the saved briefing binding. The
  // workspace mirror never infers a second target from cwd or environment.
  const okPages = (): ProjectPages | undefined => {
    if (!projectCwd) return undefined;
    try {
      const store = new BriefingStore(projectCwd, "# Project briefing\n\nNot recorded yet.\n");
      if (!store.target) return undefined;
      return projectPagesFor(store.target.origin, basename(projectCwd), store.target.docName);
    } catch { return undefined; }
  };
  const okClient = (): OpenKnowledgeClient | undefined => {
    const pages = okPages();
    return pages ? OpenKnowledgeClient.fromEnv(pages.origin) : undefined;
  };

  // ---- append-only prompt-log: local first, shared page best effort ----
  const fileIo = { readFile: readTextBestEffort, appendFile: appendBestEffort, writeFile: atomicWriteBestEffort };
  let clientId = "companion";
  try { clientId = clientIdentity(stateRoot(), fileIo); } catch { /* id stays generic; log still works */ }
  const logFiles = promptLogFiles(stateDir);
  let logStatus: PromptLogSyncResult | undefined;
  let pushHeader = (): void => {};
  const promptLog = createPromptLogSyncer({
    files: logFiles, io: fileIo, clientId, pages: okPages, client: okClient,
    nowIso: () => new Date().toISOString(),
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      if (typeof handle.unref === "function") handle.unref();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    onResult: (result) => { logStatus = result; pushHeader(); },
  });
  const logInputs = (inputs: readonly PromptLogInput[]): void => {
    if (inputs.length === 0) return;
    try {
      appendPromptLog(logFiles, fileIo, clientId, new Date().toISOString(), inputs);
      if (projectCwd) promptLog.observe();
    } catch { /* history capture is advisory; the local save already happened */ }
  };
  let lastLoggedQueue = initial.queue;
  let lastNoteHash = textHash(initial.noteText);
  /** Note revisions are logged at boundaries (exit, overview, every 5 min), not per keystroke. */
  const logNoteIfChanged = (): void => {
    const text = view.getNoteText();
    const hash = textHash(text);
    if (hash === lastNoteHash) return;
    lastNoteHash = hash;
    logInputs([{ kind: "note-revision", text, meta: { hash } }]);
  };

  const notice = (text: string): void => {
    view.setNotice(text);
    if (mode === "main") tui.requestRender();
  };

  // ---- workboard: tracker fetch every 5 min, cache file poll every 5 s ----
  let currentBoard: WorkBoard | undefined;
  let mirrorGit: GitSnapshot = { head: "unknown", ref: "", dirty: false, changed: [] };
  let mirrorPiStatus: AgentStatus = "unknown";
  let mirrorStatus: WorkspaceMirrorStatus = "unbound";
  // The mirror writes only after the shared workspace was read once:
  // another client's current state is archived to the prompt-log first.
  let hydratedFor: string | undefined;
  let refreshWorkspaceMirror = (): void => {};
  const workspaceMirror = createWorkspaceMirrorScheduler({
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      if (typeof handle.unref === "function") handle.unref();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    onStatus: (status) => { mirrorStatus = status; pushHeader(); },
  });
  refreshWorkspaceMirror = (): void => {
    const pages = okPages();
    const client = okClient();
    if (!projectCwd || !pages || !client) { workspaceMirror.observe(undefined); return; }
    if (hydratedFor !== `${pages.origin}\n${pages.workspace}`) return; // read before write
    const shot = view.snapshot();
    // Never publish the fallback sample, including failed/unsupported recovery.
    if (initial.noteSeeded && shot.noteText === initial.noteText) return;
    workspaceMirror.observe({
      pages,
      client,
      content: {
        project: basename(projectCwd),
        gitRef: mirrorGit.ref,
        gitHead: mirrorGit.head,
        gitDirty: mirrorGit.dirty,
        piStatus: piPane ? `${piPane} ${mirrorPiStatus}` : "unbound",
        queue: shot.queue.items.map((item) => ({ text: item.text })),
        composer: shot.composerText,
        ...(currentBoard === undefined ? {} : { board: currentBoard }),
        client: clientId,
        note: shot.noteText,
      },
    });
  };
  const importFile = join(stateDir, "workspace-import.json");
  let hydrating = false;
  /** One bounded read of the shared workspace per binding; archives another client's mirror before ours replaces it. */
  const hydrateWorkspace = async (): Promise<void> => {
    const pages = okPages();
    const client = okClient();
    if (!pages || !client || hydrating) return;
    const key = `${pages.origin}\n${pages.workspace}`;
    if (hydratedFor === key) return;
    hydrating = true;
    try {
      const markdown = await client.readDocument(pages.workspace);
      const currentPages = okPages();
      if (!currentPages || `${currentPages.origin}\n${currentPages.workspace}` !== key) return;
      const remote = markdown === null ? null : parseWorkspacePage(markdown);
      let imported: string | undefined;
      try { imported = (JSON.parse(readTextBestEffort(importFile) ?? "{}") as { signature?: unknown }).signature as string | undefined; } catch { imported = undefined; }
      const decision = workspaceImportDecision(remote, clientId, imported);
      if (decision.action === "import" && remote) {
        logInputs([{ kind: "workspace-import", text: remote.markdown, meta: { client: remote.client ?? "unknown", updated: remote.updated ?? "unknown" } }]);
        atomicWriteBestEffort(importFile, `${JSON.stringify({ version: 1, signature: workspaceSignature(remote), at: new Date().toISOString() })}\n`);
        notice(`shared workspace from ${remote.client ?? "another client"} (${remote.updated ?? "unknown time"}) archived to the prompt-log; Ctrl+O → Shared workspace reads it`);
      }
      // Recovery is independent of archive deduplication and writer identity.
      // A seeded unsupported/empty file is still user data: only absence is fresh.
      const beforeRestore = view.snapshot();
      const canRecover = initial.noteSeeded && !existsSync(join(stateDir, "scratch.md"))
        && beforeRestore.documentRevision === 0 && beforeRestore.noteText === initial.noteText;
      let note = remote ? workspaceNotebook(remote.markdown) : undefined;
      // A fallback sample is not a saved notebook. On a fresh client,
      // recover the latest append-only note revision instead.
      if (canRecover && (note === undefined || note.trimEnd() === SAMPLE_NOTE.trimEnd())) {
        const history = await client.readDocument(pages.promptLog);
        const latestPages = okPages();
        if (!latestPages || `${latestPages.origin}\n${latestPages.workspace}` !== key) return;
        note = history === null ? undefined : latestPromptLogNotebook(history);
      }
      if (canRecover && note !== undefined && isSupportedText(note)) {
        // Save before changing the view: a failed save leaves recovery retryable.
        saveSharedState(stateDir, { ...beforeRestore, noteText: note });
        view.restoreNotebook(initial.noteText, note);
        logNoteIfChanged();
        notice("notebook restored from OpenKnowledge and saved locally");
      } else if (initial.noteSeeded && view.getNoteText() === initial.noteText) {
        notice("notebook recovery unavailable or local file preserved; shared mirror paused — Ctrl+O → Shared workspace");
      }
      hydratedFor = key;
      refreshWorkspaceMirror();
    } catch { /* stays unhydrated; the next OK tick retries */ } finally { hydrating = false; }
  };
  // A dead session reads no cache: cache data must never resurrect a board
  // for a repository this companion has stopped tracking.
  const readCache = (): TrackingSnapshot | undefined =>
    (trackingFile && !trackingDead ? loadTrackingSnapshotForRepo(trackingFile, boundRepo) : undefined);
  const refresher = trackingRepo
    ? createTrackingRefresher({
      repo: trackingRepo,
      fetch: async (_repo) => {
        if (trackingDead) return invalidateTracking(trackingDeadReason);
        const latest = loadTrackerBinding(opts?.projectCwd ?? process.cwd(), process.env);
        if (!latest.resolution.ok || !boundRepo || JSON.stringify(repoIdentity(latest.resolution.config.repo)) !== JSON.stringify(repoIdentity(boundRepo))) {
          bound = latest;
          endTrackingSession(latest.resolution.ok
            ? `tracker binding changed to ${trackerLabel(latest.resolution.config.repo)} ${bindingSourceSuffix(latest.source)}`
            : latest.resolution.reason);
          return invalidateTracking(trackingDeadReason);
        }
        // Fence the await: the binding can be removed or repointed while this
        // request is in flight, and the old repository's answer must not be
        // written or shown after that.
        const asked = { repo: boundRepo, generation: trackingGeneration };
        const snapshot = await reads.fetch(asked.repo);
        // Refreshes coalesce, so no concurrent refresh exists to notice that
        // the binding file changed under this one: re-resolve from disk/env
        // here rather than trusting the in-memory boundRepo.
        const disposition = trackingFetchDisposition(
          asked,
          { generation: trackingGeneration, dead: trackingDead },
          () => {
            const latest = loadTrackerBinding(opts?.projectCwd ?? process.cwd(), process.env);
            bound = latest;
            return latest.resolution.ok
              ? { ok: true, repo: latest.resolution.config.repo, label: `${trackerLabel(latest.resolution.config.repo)} ${bindingSourceSuffix(latest.source)}` }
              : { ok: false, reason: latest.resolution.reason };
          },
        );
        if (!disposition.accept) {
          endTrackingSession(disposition.reason);
          return invalidateTracking(trackingDeadReason);
        }
        return snapshot;
      },
      readCache,
      writeCache: (snapshot) => {
        if (trackingFile && !trackingDead) atomicWriteBestEffort(trackingFile, JSON.stringify(snapshot, null, 2));
      },
      onBoard: (board, note) => {
        currentBoard = board;
        view.setWorkBoard(board, note);
        refreshWorkspaceMirror();
        if (mode === "main") tui.requestRender();
      },
      onClear: (note) => {
        currentBoard = undefined;
        view.setWorkBoard(undefined, note);
        refreshWorkspaceMirror();
        if (mode === "main") tui.requestRender();
      },
      onNote: (note) => {
        view.setWorkBoard(currentBoard, note);
        if (mode === "main") tui.requestRender();
      },
      now: () => Date.now(),
    })
    : undefined;
  if (refresher) {
    const cached = readCache();
    if (cached) {
      currentBoard = buildWorkBoard(cached);
      view.setWorkBoard(currentBoard, `cached · refreshing… ${bindingSuffix()}`.trim());
    } else {
      view.setWorkBoard(undefined, `refreshing… ${bindingSuffix()}`.trim());
    }
  } else {
    view.setWorkBoard(undefined, resolved.ok ? "tracker unavailable" : resolved.reason);
  }

  /** Workboard card back to the identity `selectIssue` binds to. Display fields stay behind. */
  const toTrackedIssue = (issue: BoardIssue): TrackedIssue => ({
    number: issue.number,
    title: issue.title,
    state: "open",
    milestone: issue.milestone,
    labels: [...issue.labels],
    url: issue.url,
  });

  const showTrackingModal = (): void => {
    if (!trackingModal) return;
    // An await inside applyTrackingIntent can span an invalidation; never
    // reopen the modal onto a repository this session has stopped tracking.
    if (trackingDead) {
      view.setNotice(trackingDeadReason);
      return;
    }
    // Workflow-open boundary: re-read the override so an edit made
    // while the pane was open is what the picker offers.
    const effective = workflowCatalog.refresh();
    if (effective.error !== undefined) view.setNotice(workflowCatalog.describe());
    mode = "tracking";
    tui.setLayoutRoot(trackingModal);
  };

  /**
   * Apply one intent from the focused workboard. Reads are bounded GETs;
   * nothing here sends, launches or enqueues.
   */
  const applyTrackingIntent = async (intent: ReturnType<CompanionSpikeView["consumeTrackingIntent"]>): Promise<void> => {
    if (!nav || !intent) return;
    // A companion whose binding changed never navigates the old repository again.
    if (trackingDead) {
      view.setNotice(trackingDeadReason);
      tui.requestRender();
      return;
    }
    if (intent.kind === "refresh") {
      const rebound = rebindTracker();
      if (rebound !== undefined) view.setNotice(rebound);
      if (trackingDead) { tui.requestRender(true); return; }
      if (refresher) await refresher.refresh("manual");
      refreshInbox();
      tui.requestRender(true);
      return;
    }
    if (nav.selectIssue(toTrackedIssue(intent.issue)) !== "applied") {
      view.setNotice(nav.getState().notice);
      tui.requestRender();
      return;
    }
    await nav.openDetail();
    if (intent.kind === "generate") await nav.startGenerate();
    showTrackingModal();
    tui.requestRender(true);
  };

  /** Type the draft into the composer through the view's own input path (ASCII + Enter). */
  const insertIntoComposer = (text: string): void => {
    view.setFocus("composer");
    const lines = text.replace(/\n+$/, "").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) view.handleInput("\r");
      if (line.length > 0) view.handleInput(line);
    });
  };

  const generators = createGeneratorRegistry();

  /**
   * Generator launch: a fresh Pi in a new Herdr tab reads the saved
   * packet and writes output.md; the deterministic draft already in the
   * composer is replaced only if the user has not touched it. Every failure
   * keeps the draft and says why. Never sends.
   */
  const launchGenerator = async (packet: NonNullable<ReturnType<TrackingNavigationController["consumeRequest"]>>, draft: string, requestFile: string): Promise<void> => {
    const n = packet.task.number;
    if (!generators.start(n)) { notice(`generator already running for #${String(n)} — wait for it or inspect its tab`); return; }
    // Dispatch boundary: an override that became invalid since the
    // packet was frozen blocks the launch visibly instead of running the
    // shipped defaults the operator did not choose.
    const effective = workflowCatalog.refresh();
    if (effective.error !== undefined) {
      notice(`generator for #${String(n)} blocked — ${workflowCatalog.describe()}`);
      generators.finish(n);
      return;
    }
    try {
      const skillPath = resolveSkillPath(process.env, existsSync) ?? DEFAULT_GENERATOR_SKILL;
      const workspace = process.env.HERDR_WORKSPACE_ID?.trim() || (piPane ? piPane.split(":")[0] ?? "" : "");
      const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
      let git: GitSnapshot = { head: "unknown", ref: "", dirty: false, changed: [] };
      if (projectCwd) { try { git = gitSnapshot(projectCwd); } catch { /* unknown stays unknown */ } }
      const nowIso = new Date().toISOString();
      const stamp = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const scratchDir = join(stateDir, "generator", `${String(n)}-${stamp}`);
      const outputPath = join(scratchDir, "output.md");
      const generatorContext = {
        cwd: projectCwd ?? "", ref: git.ref, head: git.head, dirty: git.dirty,
        targetLabel: piPane ? `main Pi ${piPane}` : "unbound", nowIso, skillPath, outputPath,
      };
      // Catch-Me-Up: attach the latest digest only when younger than 24 h; never run one here.
      const built = buildGeneratorPacket(packet, catchUpPaths
        ? withFreshCatchUp(generatorContext, catchUpPaths, readTextBestEffort, Date.now())
        : generatorContext);
      const runtime = generatorRuntimeOverride(process.env) ?? generatorRuntime(packet.workflow);
      // Capability probe: written by `/promptr-workflows probe` in Pi.
      // Absent means the launch is a static candidate and says so.
      const probe = loadCapabilityProbe(process.env, readTextBestEffort);
      const verified = probe === undefined
        ? "runtime unverified: no capability probe (run /promptr-workflows probe in Pi)"
        : probe.ok ? `checked against ${probe.path}` : "capability probe unusable — dispatch will be blocked";
      notice(`generator for #${String(n)}: launching ${runtime ? runtimeLabel(runtime) : "(no runtime)"} · ${verified} — draft kept until output is verified`);
      const result = await runGenerator(
        { request: packet, packet: built, scratchDir, workspace, env: process.env, agentDir },
        {
          exec: executeHerdrFresh,
          readFile: readTextBestEffort,
          exists: existsSync,
          writeFile: atomicWriteBestEffort,
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          now: () => Date.now(),
          onProgress: (note) => notice(`${note} · #${String(n)}`),
        },
      );
      if (!result.ok) {
        notice(`generator for #${String(n)} failed: ${result.reason} — deterministic draft kept${result.pane ? ` · inspect ${result.pane}` : ""}`);
        return;
      }
      // Keep the generated text beside its request packet (requests/<name>.md)
      // so the requests browser can reopen it later.
      if (requestFile.length > 0) {
        try { atomicWriteBestEffort(join(stateDir, "requests", requestFile.replace(/\.json$/, ".md")), `${result.text}\n`); } catch { /* best effort */ }
      }
      if (mode === "main" && view.replaceComposerText(draft, result.text)) {
        notice(`generated prompt for #${String(n)} in COMPOSE (${result.pane}) — edit, then Ctrl+S reviews + sends`);
      } else {
        notice(`generated prompt for #${String(n)} ready at ${result.outputPath} — composer was edited, not replaced`);
      }
      persist();
    } catch (error) {
      notice(`generator for #${String(n)} threw: ${String((error as Error).message).slice(0, 120)} — draft kept`);
    } finally {
      generators.finish(n);
    }
  };

  const leaveTracking = (outcome: "exit" | "prepared" | "generate" | "reopen"): void => {
    const prepared = outcome === "prepared" || outcome === "generate";
    mode = "main";
    tui.setLayoutRoot(view.layoutRoot);
    if (outcome === "reopen" && trackingModal) {
      // Reopen a saved request: generated text when it exists, else the
      // deterministic draft rebuilt from the packet. Never sends or launches.
      const loaded = trackingModal.consumeReopen();
      if (!loaded) {
        view.setNotice("No saved request was reopened. Nothing launched or sent.");
      } else if (view.getComposerText().length > 0) {
        view.setNotice(`composer busy — clear or queue it, then press p again to reopen requests/${loaded.entry.name}`);
      } else {
        let git: GitSnapshot = { head: "unknown", ref: "", dirty: false, changed: [] };
        if (projectCwd) { try { git = gitSnapshot(projectCwd); } catch { /* unknown stays unknown */ } }
        const draft = draftFor(loaded, {
          cwd: projectCwd ?? "", ref: git.ref, head: git.head, dirty: git.dirty,
          targetLabel: piPane ? `main Pi ${piPane}` : "unbound", nowIso: new Date().toISOString(),
        });
        insertIntoComposer(draft);
        view.setNotice(`reopened requests/${loaded.entry.name}${loaded.generated ? " (generated text)" : " (deterministic draft)"} for #${String(loaded.packet.task.number)} in COMPOSE — edit, then Ctrl+S reviews + sends`);
        persist();
      }
      tui.requestRender(true);
      return;
    }
    if (prepared && nav) {
      const packet = nav.consumeRequest();
      if (!packet) {
        view.setNotice("No request was prepared. Nothing launched or sent.");
      } else {
        const nowIso = new Date().toISOString();
        const fileName = requestFileName(packet.task.number, nowIso);
        let saved = "";
        try {
          atomicWriteBestEffort(join(stateDir, "requests", fileName), JSON.stringify(packet, null, 2));
          saved = `requests/${fileName}`;
        } catch { /* the draft still lands; the packet stays in memory via nav.getLastRequest */ }
        logInputs([{
          kind: "request-prepared",
          text: `#${String(packet.task.number)} ${packet.task.title}\nworkflow ${packet.workflow.template} on ${packet.workflow.provider}`,
          meta: { file: saved || "(unsaved)", outcome: outcome === "generate" ? "generate" : "prepared" },
        }]);
        let git: GitSnapshot = { head: "unknown", ref: "", dirty: false, changed: [] };
        if (projectCwd) {
          try { git = gitSnapshot(projectCwd); } catch { /* unknown stays unknown */ }
        }
        const freshCatchUp = catchUpPaths ? loadFreshCatchUp(catchUpPaths, readTextBestEffort, Date.now()) : undefined;
        const draft = buildTaskPromptDraft(packet, {
          cwd: projectCwd ?? "",
          ref: git.ref,
          head: git.head,
          dirty: git.dirty,
          targetLabel: piPane ? `main Pi ${piPane}` : "unbound",
          nowIso,
          ...(freshCatchUp === undefined ? {} : {
            catchUp: { since: freshCatchUp.packet.since, summary: freshCatchUp.packet.summary, lines: catchUpDraftLines(freshCatchUp.packet.markdown) },
          }),
        });
        const n = String(packet.task.number);
        if (view.getComposerText().length === 0) {
          insertIntoComposer(draft);
          view.setNotice(`draft for #${n} in COMPOSE — edit, then Ctrl+S reviews + sends${saved ? ` · packet ${saved}` : ""}`);
          if (outcome === "generate") void launchGenerator(packet, view.getComposerText(), saved ? fileName : "");
        } else if (outcome === "generate") {
          view.setNotice(`composer busy — clear or queue it, then press g again${saved ? ` · packet ${saved}` : ""}; generator not launched`);
        } else {
          view.setNotice(saved
            ? `composer busy — draft saved to ${saved}; clear or queue the composer and press g again`
            : `composer busy — packet for #${n} could not be saved; clear or queue the composer and press g again`);
        }
        persist();
      }
    } else if (nav) {
      view.setNotice(nav.getState().notice);
    }
    tui.requestRender(true);
  };

  const persist = (): void => {
    try {
      const snapshot = view.snapshot();
      // Seeded-sample guard: a session that started with no readable
      // notebook keeps the sample in memory only until the user types real
      // notes. Persisting the sample would clobber another client's save.
      const skipNote = initial.noteSeeded && snapshot.noteText === initial.noteText;
      saveThenScheduleWorkspaceMirror(
        () => saveSharedState(stateDir, snapshot, skipNote ? { skipNote: true } : undefined),
        refreshWorkspaceMirror,
      );
      // Prompt-log: every queue add/delete is history, after the local save.
      const queue = snapshot.queue;
      if (queue !== lastLoggedQueue) {
        const events = diffQueueEvents(lastLoggedQueue, queue);
        lastLoggedQueue = queue;
        logInputs(events);
      }
    } catch (error) {
      view.setNotice(`save failed (${String((error as Error).message).slice(0, 120)}) — retry or copy text out`);
    }
  };

  const enterReview = (): void => {
    const reviewIndex = view.consumeReviewRequest();
    const snapshot = view.snapshot();
    const items = snapshot.queue.items;
    if (items.length === 0) {
      view.setNotice("Queue is empty. Type in the composer and hit Ctrl+S — it queues and reviews in one.");
      tui.requestRender();
      return;
    }
    const picked = pickReviewItem(items, reviewIndex, view.getFocusedQueue());
    if (!picked) {
      view.setNotice("Nothing to review — queue kept.");
      tui.requestRender();
      return;
    }
    reviewItem = picked;
    review = new SendReview(picked.text, piPane, items.length);
    armed = false;
    review.setStatus(piPane ? readPiStatusNow(piPane) : "unknown");
    mode = "review";
    tui.setLayoutRoot(review);
    tui.requestRender(true);
  };

  const exitReview = (confirmed: boolean): void => {
    const item = reviewItem;
    review = undefined;
    reviewItem = undefined;
    armed = false;
    mode = "main";
    tui.setLayoutRoot(view.layoutRoot);
    if (!confirmed) {
      view.setNotice("submit cancelled; queue kept");
      tui.requestRender();
      return;
    }
    if (!item) {
      view.setNotice("nothing to submit; queue kept");
      tui.requestRender();
      return;
    }
    if (!piPane) {
      view.setNotice("no --pi-pane — queue saved; run /promptr in left Pi to review and send");
      persist();
      tui.requestRender();
      return;
    }
    const result = sendViaHerdr(piPane, item.text);
    view.setNotice(result.message);
    logInputs([{ kind: "send-attempt", text: item.text, itemId: item.id, meta: { target: piPane, outcome: result.message.slice(0, 160) } }]);
    persist();
    tui.requestRender();
  };

  let overviewClosed: () => void = () => {};
  let refreshInbox: () => void = () => {};
  const enterOverview = async (): Promise<void> => {
    mode = "overview";
    try {
      const cwd = opts?.projectCwd;
      if (!cwd) { view.setNotice("No project binding; reopen with /coordinatr-herdr for briefings."); return; }
      // Reload on entry so edits made outside this companion are visible.
      const store = new BriefingStore(cwd, `# Project briefing

## Goal / task link
Not recorded yet.

## Next action / blockers
Review AGENTS.md and project continuation references, then record the next action.
`);
      logNoteIfChanged();
      const controller = new BriefingController(store, {
        onSave: (text) => logInputs([{ kind: "briefing-save", text }]),
        sharedReader: (origin) => OpenKnowledgeClient.fromEnv(origin),
        projectLabel: (dir) => defaultProjectLabel(dir, gitRemoteUrl(dir)),
      });
      const target = { cwd, pane: piPane ?? "", sessionFile: opts?.piSession ?? "" };
      let autoStatus = "";
      try { autoStatus = autoStatusLine(loadAutoRecordFile(projectPaths(cwd).autocheck)); } catch { /* menu shows without it */ }
      const result = await controller.show({ cwd, targetLabel: `main Pi ${piPane ?? "unbound"}`, ui: dialogs }, () => mode === "overview",
        text => resumeBriefingInMainPi(text, target, dialogs),
        text => startFreshBriefingInNewPi(text, target, dialogs),
        autoStatus);
      await dialogs.showPendingNotice();
      if (result === "new-task") view.setFocus("composer");
      view.setNotice(result === "fresh"
        ? "Fresh Pi Coordinator launched via Herdr — transfer recorded; old session stops writing. If prompt was uncertain, inspect the new pane before any manual recovery. Ctrl+O overview."
        : result === "sent" ? "Briefing submission attempted — inspect main Pi; packet retained. Ctrl+O overview." : "Workspace kept · Ctrl+O project briefing");
    } catch (error) { view.setNotice(`Briefing unavailable: ${String((error as Error).message).slice(0, 160)}`); }
    finally { mode = "main"; tui.setLayoutRoot(view.layoutRoot); tui.requestRender(true); overviewClosed(); }
  };

  tui.addInputListener((data: string) => {
    // Same Kitty release filtering as above; without it every arrow press would
    // act twice (press + release both match), e.g. choice lists jumping two rows.
    if (isKeyRelease(data)) return { consume: true };
    if (mode === "overview") { dialogs.handleInput(data); return { consume: true }; }
    // While the tracking modal owns input, the workspace underneath sees
    // nothing: no queue send, no compose, no briefing launch.
    if (mode === "tracking" && trackingModal) {
      // Invalidation already left tracking mode; this is the belt-and-braces
      // refusal for a key that races it. No modal operation reaches the old
      // repository once the session is dead.
      if (trackingDead) {
        mode = "main";
        tui.setLayoutRoot(view.layoutRoot);
        view.setNotice(trackingDeadReason);
        tui.requestRender(true);
        return { consume: true };
      }
      void trackingModal.handleKey(data).then((outcome) => {
        if (outcome === "exit" || outcome === "prepared" || outcome === "generate" || outcome === "reopen") leaveTracking(outcome);
        else tui.requestRender();
      });
      return { consume: true };
    }
    if (mode === "review" && review) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        exitReview(false);
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        const fresh = piPane ? readPiStatusNow(piPane) : "unknown";
        review.setStatus(fresh);
        const decision = sendGuardDecision(fresh, armed);
        if (decision.action === "submit") {
          exitReview(true);
          return { consume: true };
        }
        if (decision.action === "arm") armed = true;
        review.setWarning(decision.message);
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "up")) review.scroll(-1, 18, reviewItem?.text.split("\n").length ?? 1);
      else if (matchesKey(data, "down")) review.scroll(1, 18, reviewItem?.text.split("\n").length ?? 1);
      else if (matchesKey(data, "pageUp")) review.scroll(-18, 18, reviewItem?.text.split("\n").length ?? 1);
      else if (matchesKey(data, "pageDown")) review.scroll(18, 18, reviewItem?.text.split("\n").length ?? 1);
      else {
        // Ignore other keys in review; the exact text is read-only.
      }
      tui.requestRender();
      return { consume: true };
    }
    view.handleInput(data);
    persist();
    if (nav) {
      const intent = view.consumeTrackingIntent();
      if (intent) { void applyTrackingIntent(intent); return { consume: true }; }
    }
    if (view.consumeOverviewRequest()) { void enterOverview(); return { consume: true }; }
    if (view.getReviewRequested()) {
      enterReview();
      return { consume: true };
    }
    if (view.getExitRequested()) {
      try {
        persist();
        logNoteIfChanged();
      } catch { /* exit anyway; state best effort */ }
      // Local-only parting capture: no awaits on this path (no history sync
      // injected), so the synchronous append/record complete before exit.
      try {
        const cwd = opts?.projectCwd;
        if (cwd) {
          const shot = view.snapshot();
          const git = gitSnapshot(cwd);
          const paths = projectPaths(cwd);
          void maybeAutoCheckpoint(
            {
              state: buildAutoWorkState({
                queueTexts: shot.queue.items.map((i) => i.text), composerText: shot.composerText,
                head: git.head, dirty: git.dirty, changedCount: git.changed.length,
              }),
            },
            {
              readRecord: () => loadAutoRecordFile(paths.autocheck),
              writeRecord: (next) => { saveAutoRecordFile(paths.autocheck, next); },
              appendEntry: (text) => appendProgress(paths.progress, paths.log, {
                text, cwd, head: git.head, ref: git.ref, dirty: git.dirty, changed: git.changed,
              }),
            },
          );
        }
      } catch { /* exit anyway */ }
      try {
        const count = view.snapshot().queue.items.length;
        tui.stop();
        process.stdout.write(`coordinatr closed; shared state kept in ${stateDir} (${count} queued)\n`);
      } catch { /* ignore */ }
      process.exit(0);
    }
    tui.requestRender();
    return { consume: true };
  });

  // Automatic during-work checkpoints: once a minute, capture a short
  // goal/progress/next snapshot when the work changed and is due. Local-first
  // via the progress tracker; best-effort history sync with visible pending.
  // Never sends, launches, or interrupts the companion. Silent by design —
  // state shows in the overview menu and /promptr-autocheck.
  if (opts?.projectCwd) {
    const autoCwd = opts.projectCwd;
    let autoCheapSig = "";
    let autoGitAt = 0;
    let autoGit: GitSnapshot | undefined;
    const syncAutoHistory = async (text: string): Promise<string> => {
      let store: BriefingStore;
      try {
        store = new BriefingStore(autoCwd, "# Project briefing\n\nNot recorded yet.\n");
      } catch {
        return "pending — local briefing unreadable; checkpoint retained locally";
      }
      if (!store.target) return "pending — no connected OpenKnowledge target; checkpoint retained locally";
      let remote: OpenKnowledgeBriefing;
      try {
        remote = new OpenKnowledgeBriefing(store.target);
      } catch {
        return "pending — OpenKnowledge credentials unavailable; checkpoint retained locally";
      }
      try {
        await remote.appendHistory(text);
        return `synced to ${store.target.origin} history`;
      } catch (error) {
        const detail = error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown error";
        return `pending — ${detail}`;
      }
    };
    const autoTimer = setInterval(() => {
      void (async () => {
        try {
          const shot = view.snapshot();
          const cheap = `${shot.queue.items.length}\n${firstContentLine(shot.composerText)}`;
          const now = Date.now();
          const paths = projectPaths(autoCwd);
          let record: AutoCheckRecord;
          try {
            record = loadAutoRecordFile(paths.autocheck);
          } catch {
            record = defaultAutoCheckRecord();
          }
          if (!autoCheckEnabled(record)) { autoCheapSig = cheap; return; }
          // Git costs process spawns: refresh only when the cheap state moved
          // or the cached snapshot is stale. The capture itself stays gated.
          if (cheap !== autoCheapSig || now - autoGitAt > 15 * 60_000 || !autoGit) {
            try {
              autoGit = gitSnapshot(autoCwd);
            } catch {
              autoGit = undefined;
            }
            autoGitAt = now;
            autoCheapSig = cheap;
          }
          const git = autoGit;
          if (!git) return;
          await maybeAutoCheckpoint(
            {
              state: buildAutoWorkState({
                queueTexts: shot.queue.items.map((i) => i.text), composerText: shot.composerText,
                head: git.head, dirty: git.dirty, changedCount: git.changed.length,
              }),
              nowMs: now,
            },
            {
              readRecord: () => record,
              writeRecord: (next) => {
                try {
                  saveAutoRecordFile(paths.autocheck, next);
                } catch { /* capture already saved; settings advisory */ }
              },
              appendEntry: (text) => appendProgress(paths.progress, paths.log, {
                text, cwd: autoCwd, head: git.head, ref: git.ref, dirty: git.dirty, changed: git.changed,
              }),
              syncHistory: syncAutoHistory,
            },
          );
        } catch { /* companion stays usable; capture is advisory */ }
      })();
    }, 60_000);
    if (typeof (autoTimer as unknown as { unref?: () => void }).unref === "function") {
      (autoTimer as unknown as { unref: () => void }).unref();
    }
  }

  const unref = (timer: NodeJS.Timeout): void => {
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  };

  // Live workboard: Gitea every 5 minutes, same-identity cache every 5 s.
  // An unbound companion never polls the raw cache because cache data cannot
  // establish repository identity or resurrect an old board.
  if (refresher) {
    unref(setInterval(() => { void refresher.refresh("timer"); }, 5 * 60_000));
    unref(setInterval(() => {
      try { refresher.pollCache(); } catch { /* advisory */ }
    }, 5000));
  }

  // Header status: git ref/head every 60 s, Pi agent status every 10 s. Never
  // blocks the input loop; failures read as "unknown".
  let gitLabel = "";
  let piLabel = piHeaderLabel(piPane, "unknown");
  let okStatus: OpenKnowledgeStatus = { state: "unbound", reason: "not connected" };
  pushHeader = (): void => {
    const logPending = logStatus !== undefined && logStatus.state !== "unbound" && logStatus.pending > 0;
    const ok = workspaceOkHeaderLabel(okStatus, logPending ? "pending" : mirrorStatus, Date.now());
    view.setHeaderStatus({ git: gitLabel, pi: piLabel, ...(projectCwd ? { ok } : {}) });
    if (mode === "main") tui.requestRender();
  };
  // OpenKnowledge binding: pages come from the saved briefing target,
  // credentials only from this process's environment; one bounded read per
  // minute, never blocking input. Re-read the target each tick so Ctrl+O →
  // Connect binds without a restart.
  const okPoller = createOpenKnowledgePoller({
    pages: okPages,
    client: okClient,
    check: checkProjectPages,
    now: () => Date.now(),
    onStatus: (status) => { okStatus = status; pushHeader(); },
  });
  const refreshOk = (): void => {
    if (!projectCwd) return;
    void okPoller.refresh().then(() => {
      okStatus = okPoller.current();
      pushHeader();
      // Reconnect reconciliation: read the shared workspace once, then
      // retry a failed mirror write and any pending prompt-log batches.
      if (okStatus.state === "ok") {
        void hydrateWorkspace();
        workspaceMirror.retryPending();
        void promptLog.retry();
      }
    }).catch(() => { /* advisory */ });
  };
  overviewClosed = refreshOk;
  // OpenKnowledge inbox consumption: new blocks become [web] thoughts
  // once; duplicate protection is inbox-seen.json plus the trailers already
  // appended on the page. Never sends, never edits user text.
  const inboxSeenFile = join(stateDir, "inbox-seen.json");
  const inboxPoller = createInboxPoller({
    pages: okPages,
    client: () => { const p = okPages(); return p ? OpenKnowledgeClient.fromEnv(p.origin) : undefined; },
    readSeen: () => readSeen(readTextBestEffort(inboxSeenFile)),
    writeSeen: (h) => atomicWriteBestEffort(inboxSeenFile, serializeSeen(h)),
    enqueue: (text) => { const ok = view.enqueueExternalText(text, "web"); if (ok) persist(); return ok; },
    now: () => Date.now(),
    onResult: (r) => {
      if (r.state === "ok" && r.queued > 0) notice(`web: ${r.queued} new thought(s) from the inbox — Ctrl+S reviews`);
      else if (r.state === "ok" && r.notice) notice(r.notice);
      else if (mode === "main") tui.requestRender();
    },
  });
  refreshInbox = (): void => {
    if (!projectCwd) return;
    void inboxPoller.refresh().catch(() => { /* advisory */ });
  };
  overviewClosed = () => { refreshOk(); refreshInbox(); refreshWorkspaceMirror(); };
  const refreshGitLabel = (): void => {
    if (!projectCwd) return;
    let next = "";
    try {
      mirrorGit = gitSnapshot(projectCwd);
      next = gitHeaderLabel(mirrorGit);
    } catch {
      mirrorGit = { head: "unknown", ref: "", dirty: false, changed: [] };
      next = "";
    }
    if (next !== gitLabel) { gitLabel = next; pushHeader(); refreshWorkspaceMirror(); }
  };
  const refreshPiLabel = (): void => {
    if (!piPane) return;
    try {
      execFile("herdr", ["pane", "get", piPane], { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        const status = error ? "unknown" : parseAgentStatus(typeof stdout === "string" ? stdout : String(stdout));
        mirrorPiStatus = status;
        const next = piHeaderLabel(piPane, status);
        if (next !== piLabel) { piLabel = next; pushHeader(); refreshWorkspaceMirror(); }
      });
    } catch {
      mirrorPiStatus = "unknown";
      const next = piHeaderLabel(piPane, "unknown");
      if (next !== piLabel) { piLabel = next; pushHeader(); refreshWorkspaceMirror(); }
    }
  };
  refreshGitLabel();
  view.setHeaderStatus({ git: gitLabel, pi: piLabel });
  refreshWorkspaceMirror();
  if (projectCwd) unref(setInterval(refreshGitLabel, 60_000));
  if (projectCwd) unref(setInterval(logNoteIfChanged, 5 * 60_000));
  if (projectCwd) { refreshOk(); unref(setInterval(refreshOk, 60_000)); }
  if (projectCwd) { refreshInbox(); unref(setInterval(refreshInbox, 30_000)); }
  if (piPane) {
    refreshPiLabel();
    unref(setInterval(refreshPiLabel, 10_000));
  }

  tui.start();
  // Keep ProcessTerminal's bracketed-paste reporting enabled: PasteGuard needs the
  // markers to reject pasted bytes. Disabling reporting makes paste look like typing.
  tui.requestRender(true);
  if (refresher) void refresher.refresh("start");
}

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", default: false },
        "self-check": { type: "boolean", default: false },
        "tracking-file": { type: "string" },
        "state-dir": { type: "string" },
        "pi-pane": { type: "string" },
        "project-cwd": { type: "string" },
        "pi-session": { type: "string" },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const command = parsed.positionals[0] ?? "demo";
  if (parsed.values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command !== "demo") {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  if (parsed.values["self-check"] || !process.stdout.isTTY || !process.stdin.isTTY) {
    const trackingLines = loadTrackingLines(parsed.values["tracking-file"]);
    if (!parsed.values["self-check"]) {
      process.stdout.write("no TTY detected: running bounded self-check instead of the interactive demo\n");
    }
    runSelfCheck(trackingLines);
    return 0;
  }
  runInteractive([], {
    ...(parsed.values["state-dir"] === undefined ? {} : { stateDir: parsed.values["state-dir"] }),
    ...(parsed.values["pi-pane"] === undefined ? {} : { piPane: parsed.values["pi-pane"] }),
    ...(parsed.values["project-cwd"] === undefined ? {} : { projectCwd: parsed.values["project-cwd"] }),
    ...(parsed.values["pi-session"] === undefined ? {} : { piSession: parsed.values["pi-session"] }),
    ...(parsed.values["tracking-file"] === undefined ? {} : { trackingFile: parsed.values["tracking-file"] }),
  });
  return 0;
}

// Compare real paths: npm installs the bin as a symlink under node_modules/.bin.
// This is module resolution, not application state.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(import.meta.filename)) {
  const code = main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
