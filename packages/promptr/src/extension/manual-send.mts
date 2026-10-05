import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PendingItem } from "../queue/pending.mts";

/** Void public send API cannot establish delivery or task success. Never retry automatically. */
export async function attemptSingleDialog(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: ExtensionContext,
  item: PendingItem,
  attempts: Set<string>,
  isCurrent: () => boolean,
  reviewAndConfirm: () => Promise<boolean>,
): Promise<boolean> {
  const session = ctx.sessionManager.getSessionId();
  const leaf = ctx.sessionManager.getLeafId();
  const ready = (): boolean => isCurrent() && ctx.sessionManager.getSessionId() === session
    && ctx.sessionManager.getLeafId() === leaf && ctx.isIdle() && !ctx.hasPendingMessages();
  if (attempts.has(item.id)) {
    ctx.ui.notify("Already attempted; inspect the Pi conversation. No automatic retry.", "warning");
    return false;
  }
  if (!item.text.trim()) {
    ctx.ui.notify("Cannot submit a whitespace-only prompt. Queue unchanged.", "warning");
    return false;
  }
  if (!ready()) {
    ctx.ui.notify("Pi must be idle with no pending messages. Queue retained.", "warning");
    return false;
  }
  // Single explicit review-and-confirm dialog (full text visible, Enter submits).
  if (!await reviewAndConfirm()) return false;
  if (!ready() || attempts.has(item.id)) {
    ctx.ui.notify("Session/readiness changed. Nothing attempted; reopen /promptr.", "warning");
    return false;
  }
  // Record BEFORE crossing the API boundary, even if the call throws. Ambiguous failures stay locked.
  attempts.add(item.id);
  try {
    pi.sendUserMessage(item.text, { expandPromptTemplates: false });
    ctx.ui.notify("Submission attempted. Check Pi's response; item retained, not marked successful.", "info");
  } catch {
    ctx.ui.notify("Submission threw; delivery unknown. Item retained; inspect Pi before any new enqueue.", "error");
  }
  return true;
}

/** Void public send API cannot establish delivery or task success. Never retry automatically. */
export async function attemptReviewedItem(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: ExtensionContext,
  item: PendingItem,
  attempts: Set<string>,
  isCurrent: () => boolean,
  review: () => Promise<boolean>,
): Promise<boolean> {
  const session = ctx.sessionManager.getSessionId();
  const leaf = ctx.sessionManager.getLeafId();
  const ready = () => isCurrent() && ctx.sessionManager.getSessionId() === session
    && ctx.sessionManager.getLeafId() === leaf && ctx.isIdle() && !ctx.hasPendingMessages();
  if (attempts.has(item.id)) {
    ctx.ui.notify("Already attempted; inspect the Pi conversation. No automatic retry.", "warning");
    return false;
  }
  if (!item.text.trim()) {
    ctx.ui.notify("Cannot submit a whitespace-only prompt. Queue unchanged.", "warning");
    return false;
  }
  if (!ready()) {
    ctx.ui.notify("Pi must be idle with no pending messages. Queue retained.", "warning");
    return false;
  }
  if (!await review()) return false;
  if (!ready()) {
    ctx.ui.notify("Session/readiness changed during review. Nothing attempted.", "warning");
    return false;
  }
  if (!await ctx.ui.confirm("Submit this prompt to the current Pi session?",
    "This starts an agent turn and may run tools. Only this item; no automatic queue draining.")) return false;
  if (!ready() || attempts.has(item.id)) {
    ctx.ui.notify("Session/readiness changed. Nothing attempted; reopen /promptr.", "warning");
    return false;
  }
  // Record BEFORE crossing the API boundary, even if the call throws. Ambiguous failures stay locked.
  attempts.add(item.id);
  try {
    pi.sendUserMessage(item.text, { expandPromptTemplates: false });
    ctx.ui.notify("Submission attempted. Check Pi's response; item retained, not marked successful.", "info");
  } catch {
    ctx.ui.notify("Submission threw; delivery unknown. Item retained; inspect Pi before any new enqueue.", "error");
  }
  return true;
}
