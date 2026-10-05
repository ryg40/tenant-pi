/**
 * Automatic 200k current-context wrap-up (a safeguard).
 *
 * Smallest viable trigger: when Pi's current-context measurement reports at or
 * above threshold, claim once per source session, build the normal handoffr
 * packet, save locally first, best-effort sync it to OpenKnowledge history,
 * then prompt Save for later / Continue now inside the TUI.
 *
 * - Unknown measurement (undefined tokens) never triggers; cumulative usage is
 *   never substituted — `getContextUsage` already reports current context.
 * - No response / Save for later launches nothing; the handoff stays saved.
 * - Continue now delegates to the shared Start-fresh Herdr flow (explicit
 *   binding confirmation + packet-before-launch + replay block).
 * - Failures retain the handoff with a visible notice; never blind-retry.
 */
import { buildHandoffPrompt } from "./builder.mts";
import type { ProgressEntry } from "../progress/tracker.mts";

/** Threshold: 200,000 CURRENT context tokens, not cumulative usage. */
export const WRAP_THRESHOLD_TOKENS = 200_000;

/**
 * Normalize Pi's `getContextUsage()` result to observed tokens.
 * Returns undefined when unknown (missing usage, null tokens after compaction,
 * non-numeric) — unknown must show as unknown, never trigger, never substitute.
 */
export function currentTokensOf(usage: { tokens?: unknown } | null | undefined): number | undefined {
  const tokens = usage?.tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

/** Trigger only on an observed at-or-above reading, once per source session. */
export function shouldAutoWrap(tokens: number | undefined, alreadyTriggered: boolean): boolean {
  return !alreadyTriggered && tokens !== undefined && tokens >= WRAP_THRESHOLD_TOKENS;
}

/**
 * Claim the once-per-session trigger. Returns true when this call claims it;
 * refreshes or compaction afterwards see the claim and stay quiet.
 */
export function claimAutoWrap(triggered: Set<string>, sessionId: string): boolean {
  if (triggered.has(sessionId)) return false;
  triggered.add(sessionId);
  return true;
}

/** Auto wrap-up filenames sort with manual handoffs but stay identifiable. */
export function autoWrapFilename(now = new Date(), rand = ""): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = (rand || Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]+/gi, "").slice(0, 4) || "x";
  return `200k-${stamp}-${suffix}.md`;
}

export interface AutoWrapSnapshot { ref: string; head: string; dirty: boolean; changed: string[] }

/** The normal handoffr packet, marked as an automatic wrap-up with the observed reading. */
export function buildAutoWrapPrompt(input: {
  slug: string; cwd: string; snapshot: AutoWrapSnapshot;
  progress: ProgressEntry[]; queueTexts: string[];
  provider?: string | undefined; model?: string | undefined; thinking?: string | undefined;
  observedTokens: number;
}): string {
  const runtime = [input.provider, input.model, input.thinking].filter((part) => part !== undefined && part !== "").join(" / ");
  const focus =
    `AUTOMATIC 200k-context wrap-up (observed ${input.observedTokens} current-context tokens, ` +
    `threshold ${WRAP_THRESHOLD_TOKENS}). Stop taking on new work in the source session; ` +
    `unfinished items below are explicitly not started. If continuing, verify the git state first.` +
    (runtime.length > 0 ? ` Source runtime for a same-runtime successor: ${runtime}.` : "");
  return buildHandoffPrompt({
    slug: input.slug, cwd: input.cwd,
    ref: input.snapshot.ref, head: input.snapshot.head,
    dirty: input.snapshot.dirty, changed: input.snapshot.changed,
    focus,
    progress: input.progress, queueTexts: input.queueTexts,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
  });
}

export type AutoWrapOutcome = "skipped" | "saved" | "continued" | "requested";

/** Focus text handed to the Coordinator-authored handoff (/handoffr Phase A). */
export function autoWrapFocus(observedTokens: number): string {
  return `AUTOMATIC 200k-context wrap-up (observed ${observedTokens} tokens)`;
}

export interface AutoWrapUi {
  /** Read-only handoff review. true = proceed to the choice; false = Esc, stay saved. */
  review(text: string): Promise<boolean>;
  /** The explicit choice. undefined (Esc / no response) means saved, waiting. */
  choose(title: string): Promise<"save" | "continue" | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface AutoWrapIo {
  triggered: Set<string>;
  ui: AutoWrapUi;
  writeHandoff(dir: string, name: string, text: string): void;
  appendLog(text: string): void;
  /** Best-effort history sync. Never rejects: resolves the visible status line. */
  syncHistory(text: string): Promise<string>;
  /** Continue-now executor (shared Start-fresh Herdr flow). Called at most once. */
  launchFresh(text: string): Promise<boolean>;
  /**
   * /handoffr Phase A (Coordinator-authored handoff). When present and the
   * source is idle, it replaces the deterministic packet; Phase B later offers
   * the launch. Resolves true when the request was written and sent.
   */
  requestHandoff?(focus: string): Promise<boolean>;
}

/**
 * Run one automatic wrap-up. Claims the session trigger before any await so a
 * refresh or compaction racing the flow cannot start a second transition.
 * Launch happens only on an explicit "continue" choice, exactly once.
 */
export async function runAutoWrap(
  input: {
    tokens: number | undefined; sessionId: string;
    cwd: string; slug: string; handoffsDir: string;
    snapshot: AutoWrapSnapshot; progress: ProgressEntry[]; queueTexts: string[];
    provider?: string; model?: string; thinking?: string;
    /** Source Pi idle and without pending messages at trigger time. */
    sourceIdle?: boolean;
  },
  io: AutoWrapIo,
): Promise<AutoWrapOutcome> {
  if (!shouldAutoWrap(input.tokens, io.triggered.has(input.sessionId))) return "skipped";
  claimAutoWrap(io.triggered, input.sessionId);
  const observed = input.tokens as number;
  if (io.requestHandoff) {
    if (input.sourceIdle === true) {
      let requested = false;
      try { requested = await io.requestHandoff(autoWrapFocus(observed)); } catch { requested = false; }
      if (requested) return "requested";
      io.ui.notify("Coordinator-authored handoff could not be requested; saving the deterministic wrap-up instead.", "warning");
    } else {
      io.ui.notify("Coordinator busy: deterministic wrap-up saved; run /handoffr when idle for a full handoff", "warning");
    }
  }
  const text = buildAutoWrapPrompt({
    slug: input.slug, cwd: input.cwd, snapshot: input.snapshot,
    progress: input.progress, queueTexts: input.queueTexts,
    provider: input.provider, model: input.model, thinking: input.thinking,
    observedTokens: observed,
  });
  const name = autoWrapFilename();
  try {
    io.writeHandoff(input.handoffsDir, name, text);
  } catch {
    io.ui.notify("Automatic wrap-up reached 200k context but the handoff could not be persisted. Nothing launched.", "error");
    return "saved";
  }
  try {
    io.appendLog(`\n## Automatic 200k wrap-up ${name}\n- observed: ${observed} current-context tokens\n- file: \`handoffs/${name}\`\n`);
  } catch { /* log is advisory; the handoff file is authoritative */ }
  const syncStatus = await io.syncHistory(text);
  const proceed = await io.ui.review(text);
  if (!proceed) {
    io.ui.notify(`Wrap-up saved as handoffs/${name} (${syncStatus}). Reopen /promptr when ready to choose.`, "info");
    return "saved";
  }
  const choice = await io.ui.choose(
    `Context wrap-up — ${observed} current tokens\nHandoff saved: handoffs/${name}\nHistory: ${syncStatus}\n` +
    `Save for later launches nothing. Continue now launches a fresh Pi Coordinator through Herdr and submits once.`,
  );
  if (choice !== "continue") {
    io.ui.notify(`Wrap-up saved as handoffs/${name}, waiting for a choice. Nothing launched.`, "info");
    return "saved";
  }
  try {
    const ran = await io.launchFresh(text);
    return ran ? "continued" : "saved";
  } catch {
    io.ui.notify(`Continue-now failed or was uncertain; handoff retained as handoffs/${name}. No retry — inspect before any manual recovery.`, "warning");
    return "saved";
  }
}
