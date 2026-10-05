/**
 * Tracking navigation modal for the companion window.
 *
 * A separate component from the briefing dialogs on purpose: while this modal
 * owns input, *nothing* reaches the workspace. Ctrl+S cannot queue or send,
 * Ctrl+E cannot compose, `s` cannot submit a thought and Ctrl+O cannot launch
 * a briefing — those keys are named and refused here rather than falling
 * through to the board underneath.
 *
 * Panes: issue list → issue detail → workflow → provider → inert role
 * preview. The last pane offers one deliberately named action,
 * "Prepare request → draft to composer (no launch)", which asks the
 * controller for a packet; the host turns it into a composer draft. This file
 * never sends, launches, enqueues or writes anything.
 *
 * All text is treated as untrusted: every row goes through the tracking
 * sanitizer and `truncateToWidth`, and heights are bounded so the modal fits
 * a 40x24 pane as well as a 97x63 one.
 */
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { boardColors, sectionRule } from "./view.mts";
import { sanitizeLine } from "../tracking/gitea.mts";
import { describeRole, orderRoles } from "../tracking/workflow-port.mts";
import type { TrackingNavigationController, TrackingNavState } from "../tracking/selection.mts";
import { describeRequest } from "../tracking/requests.mts";
import type { LoadedRequest, RequestEntry, RequestsPort } from "../tracking/requests.mts";
import { ageLabel, isCatchUpFresh } from "../tracking/catchup.mts";
import type { CatchUpPort, CatchUpResult } from "./host-tracking.mts";

type ReopenedRequest = Extract<LoadedRequest, { ok: true }>;

const c = boardColors;

/** Rows the modal always spends on chrome: heading rule, notice, key hints. */
const CHROME_ROWS = 3;
/** Widest a body row is allowed to be before it is cut; panes never wrap sideways. */
const MIN_BODY_ROWS = 1;

/** Host-visible outcome of one key. `exit` means give focus back to the workspace. */
export type ModalOutcome = "handled" | "exit" | "prepared" | "generate" | "reopen";

export interface TrackingModalOptions {
  /** Rows this modal may occupy. Injected so tests can pin 24 and 63. */
  rows: () => number;
  /** Called after any state change so the host can request a render. */
  onChange?: () => void;
  /** Saved request packets for the `p` pane; absent means the pane is unavailable. */
  requests?: RequestsPort;
  /** Catch-Me-Up runner for the `c` key; absent means the key reports unavailable. */
  catchUp?: CatchUpPort;
}

const REQUESTS_HINTS = ["↑↓ choose · Enter reopens into the composer · Esc back to detail", "↑↓ · Enter reopen · Esc", "Enter · Esc"];
const CATCHUP_HINTS = ["↑↓ PgUp PgDn scroll the catch-up digest · Esc back", "↑↓ PgUp PgDn scroll · Esc back", "↑↓ · Esc"];

/** `catch-up 2h ago` when a digest younger than 24 h exists, else the nudge to press c. */
export function catchUpFreshnessHint(latest: CatchUpResult | undefined, nowMs: number): string {
  if (latest && isCatchUpFresh(latest.generatedAt, nowMs)) return `catch-up ${ageLabel(latest.generatedAt, nowMs)}`;
  return "no fresh catch-up · press c";
}

function hint(view: TrackingNavState["view"], width: number, freshness: string): string {
  const tiers: Record<TrackingNavState["view"], string[]> = {
    list: [
      "↑↓ move · Enter opens details · n/p page · r refresh · c catch-up · Esc back to workspace",
      "↑↓ · Enter details · n/p page · r refresh · c catch-up · Esc back",
      "↑↓ · Enter · n/p · c · Esc",
    ],
    detail: [
      "↑↓ scroll · Enter re-confirms review · g Generate Prompt · p requests · c catch-up · Esc back to board",
      "↑↓ scroll · Enter confirm · g generate · p requests · c catch-up · Esc back to board",
      "↑↓ · g gen · p req · c catch-up · Esc",
    ],
    workflow: ["↑↓ choose · Enter selects a workflow · Esc cancels", "↑↓ · Enter · Esc", "Esc"],
    provider: ["↑↓ choose · Enter selects a provider · Esc cancels", "↑↓ · Enter · Esc", "Esc"],
    execution: ["↑↓ choose · Enter selects how delegated roles run (Pi subagents or Herdr native) · Esc cancels", "↑↓ · Enter · Esc", "Esc"],
    preview: [
      `↑↓ scroll · Enter: Prepare request → draft to composer (no launch) · g: also launch generator (Sol medium, fresh Pi) · ${freshness} · Esc cancels`,
      `↑↓ · Enter prepares draft · g launches generator · ${freshness} · Esc`,
      `Enter · g · ${freshness} · Esc`,
    ],
  };
  return paneHint(tiers[view], width);
}

function paneHint(options: readonly string[], width: number): string {
  return options.find((tier) => visibleWidth(tier) <= width) ?? options[options.length - 1] ?? "Esc";
}

export class TrackingModal implements Component {
  private readonly controller: TrackingNavigationController;
  private readonly rows: () => number;
  private readonly onChange: () => void;
  /** Read position for the scrollable panes (detail body, preview, long lists). */
  private offset = 0;
  /** Cursor inside the workflow/provider choice lists. */
  private choice = 0;
  private lastKeyNotice = "";
  private readonly requestsPort: RequestsPort | undefined;
  /** Open requests pane (over the detail view). */
  private requests: { entries: RequestEntry[]; skipped: number; cursor: number; issue: number } | undefined = undefined;
  /** One-shot result of the last successful Enter in the requests pane. */
  private reopen: ReopenedRequest | undefined = undefined;
  private readonly catchUpPort: CatchUpPort | undefined;
  /** Open catch-up pane (over list or detail) showing the rendered digest. */
  private catchUpPane: { lines: string[]; summary: string } | undefined = undefined;
  /** A run in flight; a second `c` waits instead of starting another. */
  private catchingUp = false;
  /** Rule text after the last run (`catchUpSummaryLine`); empty until one ran. */
  private catchUpRule = "";

  constructor(controller: TrackingNavigationController, options: TrackingModalOptions) {
    this.controller = controller;
    this.rows = options.rows;
    this.onChange = options.onChange ?? ((): void => {});
    this.requestsPort = options.requests;
    this.catchUpPort = options.catchUp;
  }

  /** How many catch-up runs the modal started; tests count intents with it. */
  private catchUpRuns = 0;
  get catchUpRunCount(): number {
    return this.catchUpRuns;
  }

  /** True while the `c` pane is open. */
  get catchUpPaneOpen(): boolean {
    return this.catchUpPane !== undefined;
  }

  /** Hands back the loaded request from the last `"reopen"` outcome, once. */
  consumeReopen(): ReopenedRequest | undefined {
    const value = this.reopen;
    this.reopen = undefined;
    return value;
  }

  invalidate(): void {}

  getState(): TrackingNavState {
    return this.controller.getState();
  }

  // ---- rendering ----

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const height = Math.max(CHROME_ROWS + MIN_BODY_ROWS, Math.trunc(this.rows()));
    const state = this.controller.getState();
    const bodyRows = Math.max(MIN_BODY_ROWS, height - CHROME_ROWS);
    const body = this.buildBody(state, safeWidth);
    const maxOffset = Math.max(0, body.length - bodyRows);
    this.offset = Math.min(Math.max(0, this.offset), maxOffset);
    const window = body.slice(this.offset, this.offset + bodyRows);
    while (window.length < bodyRows) window.push("");
    const position = maxOffset > 0 ? ` · ${String(this.offset + 1)}-${String(Math.min(body.length, this.offset + bodyRows))}/${String(body.length)}` : "";
    const suffix = this.requests ? " · requests" : this.catchUpPane ? " · catch-up" : "";
    const rule = this.catchingUp ? " · catching up…" : this.catchUpRule ? ` · ${this.catchUpRule}` : "";
    const heading = sectionRule(`TRACKING · ${state.repo.owner}/${state.repo.repo} · ${state.view}${suffix}${rule}${position}`, safeWidth);
    const notice = this.lastKeyNotice || state.notice;
    const freshness = this.catchUpPort ? catchUpFreshnessHint(this.catchUpPort.latest(), this.catchUpPort.now()) : "no fresh catch-up · press c";
    const hints = this.requests ? paneHint(REQUESTS_HINTS, safeWidth) : this.catchUpPane ? paneHint(CATCHUP_HINTS, safeWidth) : hint(state.view, safeWidth, freshness);
    return [
      c.accentBold(truncateToWidth(heading, safeWidth, "")),
      ...window.map((line) => truncateToWidth(line, safeWidth, "")),
      c.yellow(truncateToWidth(`${state.busy || this.catchingUp ? "… " : ""}${sanitizeLine(notice, 400)}`, safeWidth, "")),
      c.muted(truncateToWidth(hints, safeWidth, "")),
    ];
  }

  private buildBody(state: TrackingNavState, width: number): string[] {
    if (this.requests) return this.buildRequests(this.requests);
    if (this.catchUpPane) return this.catchUpPane.lines;
    switch (state.view) {
      case "list":
        return this.buildList(state, width);
      case "detail":
        return this.buildDetail(state, width);
      case "workflow":
        return this.buildChoices(state, "workflow", width);
      case "provider":
        return this.buildChoices(state, "provider", width);
      case "execution":
        return this.buildChoices(state, "execution", width);
      case "preview":
        return this.buildPreview(state, width);
      default:
        return [];
    }
  }

  private buildList(state: TrackingNavState, width: number): string[] {
    const list = state.list;
    const lines: string[] = [];
    lines.push(
      `page ${String(list.page)}${list.hasMore ? "+" : ""} · ${String(list.items.length)} row(s) · read ${list.fetchedAt || "never"}${list.offline ? " · OFFLINE/CACHED" : ""}`,
    );
    if (state.selectedNumber !== undefined) {
      lines.push(`selected #${String(state.selectedNumber)} ${sanitizeLine(state.selectedTitle, 120)}`);
    }
    if (list.items.length === 0) {
      lines.push("  no issues on this page");
      return lines;
    }
    // Keep the cursor inside the visible window without moving the selection:
    // scrolling is a read position, never a change of what is selected.
    list.items.forEach((item, index) => {
      const marker = index === list.cursor ? "▶" : " ";
      const selected = state.selectedNumber === item.number ? "*" : " ";
      const head = `${marker}${selected}#${String(item.number)} ${item.state === "closed" ? "closed" : "open  "} `;
      const room = Math.max(4, width - visibleWidth(head));
      lines.push(`${head}${truncateToWidth(sanitizeLine(item.title, 200), room, "…")}`);
    });
    return lines;
  }

  private buildRequests(pane: NonNullable<TrackingModal["requests"]>): string[] {
    const lines: string[] = [];
    lines.push(`requests for #${String(pane.issue)} · ${String(pane.entries.length)} saved · ${String(pane.skipped)} skipped`);
    if (pane.entries.length === 0) {
      lines.push("  no saved requests for this issue");
      return lines;
    }
    pane.entries.forEach((entry, index) => {
      lines.push(`${index === pane.cursor ? "▶" : " "} ${describeRequest(entry)}`);
    });
    return lines;
  }

  private buildDetail(state: TrackingNavState, width: number): string[] {
    const detail = state.detail;
    const lines: string[] = [];
    if (!detail) {
      lines.push("Detail unavailable — nothing was read.");
      lines.push("An unreadable issue is unavailable, not open work. No request can be prepared.");
      return lines;
    }
    lines.push(`#${String(detail.number)} ${sanitizeLine(detail.title, 200)}`);
    lines.push(`state ${detail.state} · updated ${detail.updatedAt} · read ${detail.fetchedAt}`);
    lines.push(`milestone ${sanitizeLine(detail.milestone, 80)} · ${detail.url}`);
    lines.push(`labels ${detail.labels.length > 0 ? detail.labels.join(", ") : "(none)"}`);
    const deps = detail.dependencies;
    lines.push(
      `dependencies ${deps.status} · ${String(deps.items.length)} listed · ${String(deps.blockers)} open blocker(s)${deps.reason ? ` · ${sanitizeLine(deps.reason, 120)}` : ""}`,
    );
    for (const dep of deps.items.slice(0, 20)) {
      lines.push(`  ${dep.state === "open" ? "BLOCKS" : "done  "} ${dep.repo}#${String(dep.number)} ${sanitizeLine(dep.title, 90)}`);
    }
    if (state.detailStale) lines.push("! cached/offline detail — a request cannot be built from it");
    if (state.changed) lines.push("! this issue changed since you reviewed it — press Enter to re-confirm");
    const blockers = state.blockers;
    if (blockers.length > 0) {
      lines.push(`! blocked: ${blockers.join("; ")}`);
    } else {
      lines.push("no blockers found in native state · g starts Generate Prompt (nothing launches)");
    }
    lines.push("");
    lines.push(detail.bodyTruncated ? `body (truncated at ${String(detail.body.length)} chars):` : "body:");
    const wrapWidth = Math.max(2, width);
    for (const raw of detail.body.split("\n")) {
      const clean = sanitizeLine(raw, 4000);
      if (clean.length === 0) lines.push("");
      else lines.push(...wrapTextWithAnsi(clean, wrapWidth));
    }
    return lines;
  }

  private choicesFor(kind: "workflow" | "provider" | "execution") {
    if (kind === "workflow") return this.controller.listWorkflows();
    if (kind === "provider") return this.controller.listProviders();
    return this.controller.listExecutions();
  }

  private buildChoices(state: TrackingNavState, kind: "workflow" | "provider" | "execution", width: number): string[] {
    const choices = this.choicesFor(kind);
    const lines: string[] = [];
    if (!state.catalogAvailable || choices.length === 0) {
      lines.push(state.catalogAvailable ? `No ${kind}s offered by the catalog.` : "Workflow catalog unavailable.");
      lines.push("No workflow is shown because none was injected.");
      lines.push("Nothing is generated, launched or sent.");
      return lines;
    }
    if (kind === "workflow") lines.push("Choose a workflow:");
    else if (kind === "provider") lines.push(`Choose a provider for ${sanitizeLine(state.workflowId, 60)}:`);
    else lines.push(`Choose how delegated roles run for ${sanitizeLine(state.workflowId, 60)} on ${sanitizeLine(state.providerId, 60)}:`);
    this.choice = Math.min(Math.max(0, this.choice), choices.length - 1);
    choices.forEach((choice, index) => {
      const marker = index === this.choice ? "▶ " : "  ";
      lines.push(`${marker}${sanitizeLine(choice.label, 80)}`);
      const description = sanitizeLine(choice.description, 300);
      if (description.length > 0) {
        for (const row of wrapTextWithAnsi(description, Math.max(2, width - 4))) lines.push(`    ${row}`);
      }
    });
    return lines;
  }

  private buildPreview(state: TrackingNavState, width: number): string[] {
    const expansion = state.expansion;
    const lines: string[] = [];
    if (!expansion) {
      lines.push("No preview available.");
      return lines;
    }
    lines.push(`Workflow ${sanitizeLine(expansion.template, 60)} · provider ${sanitizeLine(expansion.provider, 60)} · execution ${sanitizeLine(expansion.execution ?? "pi-subagents", 20)}`);
    lines.push(`Task #${String(state.selectedNumber ?? 0)} ${sanitizeLine(state.selectedTitle, 120)}`);
    lines.push("");
    lines.push("Roles (static plan; runtime availability is unverified here):");
    for (const role of orderRoles(expansion.roles)) lines.push(`  ${sanitizeLine(describeRole(role), 160)}`);
    if (expansion.instructions.length > 0) {
      lines.push("");
      lines.push("Instructions:");
      for (const instruction of expansion.instructions) {
        for (const row of wrapTextWithAnsi(sanitizeLine(instruction, 1000), Math.max(2, width - 4))) lines.push(`    ${row}`);
      }
    }
    if (expansion.warnings.length > 0) {
      lines.push("");
      lines.push("Warnings:");
      for (const warning of expansion.warnings) {
        for (const row of wrapTextWithAnsi(sanitizeLine(warning, 1000), Math.max(2, width - 4))) lines.push(`  ! ${row}`);
      }
    }
    lines.push("");
    if (state.blockers.length > 0) lines.push(`! blocked: ${state.blockers.join("; ")}`);
    lines.push("Enter: Prepare request (no launch) -> draft to composer. g: same, then launch the generator; the draft is replaced only if you have not edited it. Generation is not execution.");
    return lines;
  }

  // ---- input ----

  /**
   * Keys that belong to the workspace underneath. Naming them here is the
   * point: a modal that silently swallowed Ctrl+S would look broken, and one
   * that let it through would send a prompt the operator never reviewed.
   */
  private refuseFallthrough(data: string): string | undefined {
    if (matchesKey(data, "ctrl+s")) return "Ctrl+S does nothing here — the tracking modal never queues or sends.";
    if (matchesKey(data, "ctrl+e") || matchesKey(data, "ctrl+enter")) return "Ctrl+E does nothing here — the composer is not reachable from tracking.";
    if (matchesKey(data, "ctrl+o")) return "Ctrl+O does nothing here — close tracking first to open the briefing.";
    if (matchesKey(data, "ctrl+u")) return "Ctrl+U does nothing here — the queue is not reachable from tracking.";
    return undefined;
  }

  handleInput(data: string): void {
    void this.handleKey(data);
  }

  /** Async form: the panes read pages and details, so tests await this. */
  async handleKey(data: string): Promise<ModalOutcome> {
    const refusal = this.refuseFallthrough(data);
    if (refusal !== undefined) {
      this.lastKeyNotice = refusal;
      this.onChange();
      return "handled";
    }
    this.lastKeyNotice = "";
    const state = this.controller.getState();
    if (this.requests) {
      const outcome = this.handleRequestsKey(data, this.requests);
      this.onChange();
      return outcome;
    }
    if (this.catchUpPane) {
      this.handleCatchUpPaneKey(data);
      this.onChange();
      return "handled";
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      const where = this.controller.back();
      this.offset = 0;
      this.choice = 0;
      this.onChange();
      return where === "exit" ? "exit" : "handled";
    }
    if (data === "c" || data === "C") {
      if (state.view === "list" || state.view === "detail") await this.runCatchUp();
      else this.lastKeyNotice = "TRACKING ignores c — ? lists the keys";
      this.onChange();
      return "handled";
    }
    let outcome: ModalOutcome = "handled";
    switch (state.view) {
      case "list":
        outcome = await this.handleListKey(data);
        break;
      case "detail":
        outcome = await this.handleDetailKey(data);
        break;
      case "workflow":
      case "provider":
      case "execution":
        outcome = this.handleChoiceKey(data, state.view);
        break;
      case "preview":
        outcome = this.handlePreviewKey(data);
        break;
      default:
        break;
    }
    this.onChange();
    return outcome;
  }

  private async handleListKey(data: string): Promise<ModalOutcome> {
    if (matchesKey(data, "up")) {
      this.controller.moveCursor(-1);
      this.followCursor();
    } else if (matchesKey(data, "down")) {
      this.controller.moveCursor(1);
      this.followCursor();
    } else if (matchesKey(data, "pageUp")) {
      this.offset = Math.max(0, this.offset - Math.max(1, this.rows() - CHROME_ROWS));
    } else if (matchesKey(data, "pageDown")) {
      this.offset += Math.max(1, this.rows() - CHROME_ROWS);
    } else if (data === "n" || data === "N") {
      this.offset = 0;
      await this.controller.nextPage();
    } else if (data === "p" || data === "P") {
      this.offset = 0;
      await this.controller.previousPage();
    } else if (data === "r" || data === "R") {
      await this.controller.refresh();
    } else if (matchesKey(data, "enter")) {
      // One deliberate act binds the identity and reads the issue.
      if (this.controller.select() === "applied") {
        this.offset = 0;
        await this.controller.openDetail();
      }
    }
    return "handled";
  }

  /** Keep the row cursor inside the visible window; never move the selection. */
  private followCursor(): void {
    const list = this.controller.getState().list;
    const bodyRows = Math.max(MIN_BODY_ROWS, Math.trunc(this.rows()) - CHROME_ROWS);
    // Two header rows precede the issue rows in the list pane.
    const row = list.cursor + 2;
    if (row < this.offset) this.offset = row;
    else if (row >= this.offset + bodyRows) this.offset = row - bodyRows + 1;
  }

  private async handleDetailKey(data: string): Promise<ModalOutcome> {
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - Math.max(1, this.rows() - CHROME_ROWS));
    else if (matchesKey(data, "pageDown")) this.offset += Math.max(1, this.rows() - CHROME_ROWS);
    else if (matchesKey(data, "enter")) this.controller.acceptReviewedDetail();
    else if (data === "g" || data === "G") {
      this.offset = 0;
      this.choice = 0;
      await this.controller.startGenerate();
    } else if (data === "r" || data === "R") {
      await this.controller.openDetail();
    } else if (data === "p" || data === "P") {
      const issue = this.controller.getState().selectedNumber;
      if (!this.requestsPort || issue === undefined) {
        this.lastKeyNotice = "Requests browser unavailable here.";
      } else {
        const listed = this.requestsPort.list(issue);
        this.requests = { entries: listed.entries, skipped: listed.skipped, cursor: 0, issue };
        this.offset = 0;
      }
    }
    return "handled";
  }

  /**
   * Catch-Me-Up: one deterministic gather through the host port. The
   * modal never reads the tracker, git or files itself; it shows what the
   * host hands back and says so while the run is in flight.
   */
  private async runCatchUp(): Promise<void> {
    if (!this.catchUpPort) {
      this.lastKeyNotice = "Catch-Me-Up unavailable here.";
      return;
    }
    if (this.catchingUp) {
      this.lastKeyNotice = "catch-up already running — wait for it";
      return;
    }
    this.catchingUp = true;
    this.catchUpRuns += 1;
    this.lastKeyNotice = "catching up…";
    this.onChange();
    try {
      const result = await this.catchUpPort.run();
      this.catchUpRule = sanitizeLine(result.summary, 120);
      const lines = result.markdown.split("\n").map((row) => sanitizeLine(row, 4000));
      this.catchUpPane = { lines, summary: this.catchUpRule };
      this.offset = 0;
      this.lastKeyNotice = `${this.catchUpRule} · ${sanitizeLine(result.file, 200)}`;
    } catch (error) {
      this.lastKeyNotice = `catch-up failed: ${sanitizeLine((error as Error).message, 120)} — nothing written`;
    } finally {
      this.catchingUp = false;
    }
  }

  /** Keys while the catch-up pane is open: scroll only; Esc closes only the pane. */
  private handleCatchUpPaneKey(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.catchUpPane = undefined;
      this.offset = 0;
      return;
    }
    const page = Math.max(1, this.rows() - CHROME_ROWS);
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
    else if (matchesKey(data, "pageDown")) this.offset += page;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
    else this.lastKeyNotice = "catch-up pane: ↑↓ PgUp PgDn scroll · Esc back";
  }

  /** Keys while the requests pane is open; Esc closes only the pane. */
  private handleRequestsKey(data: string, pane: NonNullable<TrackingModal["requests"]>): ModalOutcome {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.requests = undefined;
      this.offset = 0;
      return "handled";
    }
    if (matchesKey(data, "up")) pane.cursor = Math.max(0, pane.cursor - 1);
    else if (matchesKey(data, "down")) pane.cursor = Math.min(Math.max(0, pane.entries.length - 1), pane.cursor + 1);
    else if (matchesKey(data, "enter")) {
      const entry = pane.entries[pane.cursor];
      if (!entry || !this.requestsPort) return "handled";
      const loaded = this.requestsPort.load(entry);
      if (loaded.ok) {
        this.reopen = loaded;
        this.requests = undefined;
        this.offset = 0;
        return "reopen";
      }
      this.lastKeyNotice = `packet unreadable: ${loaded.reason} — nothing reopened`;
    }
    return "handled";
  }

  private handleChoiceKey(data: string, kind: "workflow" | "provider" | "execution"): ModalOutcome {
    const choices = this.choicesFor(kind);
    if (choices.length === 0) return "handled";
    if (matchesKey(data, "up")) this.choice = Math.max(0, this.choice - 1);
    else if (matchesKey(data, "down")) this.choice = Math.min(choices.length - 1, this.choice + 1);
    else if (matchesKey(data, "enter")) {
      const picked = choices[Math.min(Math.max(0, this.choice), choices.length - 1)];
      if (picked) {
        this.offset = 0;
        if (kind === "workflow") {
          this.choice = 0;
          this.controller.chooseWorkflow(picked.id);
        } else if (kind === "provider") {
          this.choice = 0;
          this.controller.chooseProvider(picked.id);
        } else {
          this.controller.chooseExecution(picked.id);
        }
      }
    }
    return "handled";
  }

  private handlePreviewKey(data: string): ModalOutcome {
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - Math.max(1, this.rows() - CHROME_ROWS));
    else if (matchesKey(data, "pageDown")) this.offset += Math.max(1, this.rows() - CHROME_ROWS);
    else if (matchesKey(data, "enter")) {
      const result = this.controller.prepareRequest();
      if (result.ok) return "prepared";
    } else if (data === "g" || data === "G") {
      const result = this.controller.prepareRequest();
      if (result.ok) return "generate";
    }
    return "handled";
  }
}
