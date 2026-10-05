import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BriefingController, type BriefingHooks } from "../briefing/overview.mts";
import { BriefingStore } from "../briefing/store.mts";
import { startFreshBriefingInNewPi } from "../companion/briefing-fresh.mts";
import type { HerdrExecutor } from "../companion/briefing-send.mts";
import { attemptSingleDialog } from "./manual-send.mts";

/** Pi-hosted adapter; the split companion uses the same briefing controller. */
export class BriefingOverview {
  readonly store: BriefingStore;
  private readonly controller: BriefingController;
  constructor(store: BriefingStore, hooks: BriefingHooks = {}) { this.store = store; this.controller = new BriefingController(store, hooks); }
  show(pi: ExtensionAPI, ctx: ExtensionContext, attempts: Set<string>, isCurrent: () => boolean,
    review: (text: string) => Promise<boolean>, autoStatus?: string | undefined): Promise<"workspace" | "new-task" | "close" | "sent" | "fresh"> {
    // Hosted Start fresh uses the same Herdr successor flow as the companion;
    // there is deliberately no hosted-only launch path.
    type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
    const exec = (pi as unknown as { exec?: Exec }).exec?.bind(pi) as Exec | undefined;
    const herdr: HerdrExecutor | undefined = exec
      ? async args => (await exec("herdr", args, { timeout: 90000 })).stdout
      : undefined;
    const pane = process.env.HERDR_PANE_ID ?? "";
    let sessionFile = "";
    try { sessionFile = ctx.sessionManager.getSessionFile() ?? ""; } catch { sessionFile = ""; }
    return this.controller.show({ cwd: ctx.cwd, targetLabel: ctx.sessionManager.getSessionId(), ui: ctx.ui }, isCurrent,
      async text => {
        const id = `briefing-${createHash("sha256").update(ctx.cwd).update("\0").update(text).digest("hex")}`;
        // Same prefix guard as the companion Herdr path: a leading slash or
        // bang must never reach submission as an accidental command.
        if (!text.trim() || /^[\/!]/.test(text.trimStart())) {
          ctx.ui.notify("Use a non-empty Markdown briefing, not a slash or shell command. Nothing submitted.", "warning");
          return false;
        }
        return attemptSingleDialog(pi, ctx, { id, requestId: id, text }, attempts, isCurrent, () => review(text));
      },
      async text => {
        if (process.env.HERDR_ENV !== "1" || !herdr) {
          ctx.ui.notify("Start fresh needs Herdr (HERDR_ENV=1) and the extension host exec capability; nothing launched.", "warning");
          return false;
        }
        return startFreshBriefingInNewPi(text, { pane, sessionFile, cwd: ctx.cwd }, ctx.ui, herdr);
      }, autoStatus);
  }
}
