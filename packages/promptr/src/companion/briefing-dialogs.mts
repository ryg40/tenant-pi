import { Editor, SelectList, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, TuiAltScreen } from "@earendil-works/pi-tui";
import type { BriefingDialogs } from "../briefing/overview.mts";
import { validateBriefing } from "../briefing/openknowledge.mts";
import { PasteGuard, boardColors, minimumSafeEditorWidth, sectionRule } from "./view.mts";

type NoticeLevel = "info" | "warning" | "error";
type DialogKind = "select" | "confirm" | "editor";

const c = boardColors;

/**
 * One cyan focus accent, shared with the workspace board.
 *
 * `selectedText` receives the whole selected row *including* SelectList's own
 * `→ ` prefix, so the choice stays unambiguous with color stripped (NO_COLOR,
 * monochrome terminals, piped capture) — the arrow is the marker, cyan bold is
 * reinforcement. `selectedPrefix` is unused by pi-tui 0.85.0's renderItem but
 * is required by SelectListTheme, so it mirrors `selectedText`.
 */
const focusListTheme = {
  selectedPrefix: (text: string): string => c.accentBold(text),
  selectedText: (text: string): string => c.accentBold(text),
  description: (text: string): string => c.muted(text),
  scrollInfo: (text: string): string => c.muted(text),
  noMatch: (text: string): string => c.muted(text),
};

/** Notices carry a marker as well as a color so level survives NO_COLOR. */
const noticeText = (message: string, level: NoticeLevel): string =>
  level === "info" ? message : `⚠ ${message}`;
const noticePaint = (level: NoticeLevel): ((text: string) => string) =>
  level === "info" ? c.yellow : (text: string): string => c.bold(c.yellow(text));

/** Widths below this cannot carry a `── LABEL ───` rule without truncating it. */
const MIN_RULE_WIDTH = 14;
/**
 * A live in-dialog notice pins above the heading. It is bounded so it can never
 * crowd out the actions, but generously enough that the longest one this adapter
 * raises (the narrow-save block) wraps in full at the widths a pane can reach.
 */
const liveNoticeRows = (rows: number): number => Math.max(3, Math.floor(rows / 4));

/**
 * Footer help, richest first. A truncated footer would silently drop the way
 * out of a modal, so narrow panes step down to a shorter phrasing instead —
 * every tier still names Esc. The read-position variant is offered only while
 * there is unread text.
 */
function hintTiers(kind: DialogKind, scrollable: boolean): string[] {
  if (kind === "editor") {
    return [...(scrollable ? ["Ctrl+S save · Enter newline · PgUp/PgDn read · Esc cancel"] : []),
      "Ctrl+S save · Enter newline · Esc cancel", "Ctrl+S save · Esc cancel", "Esc cancel", "Esc"];
  }
  if (kind === "confirm") {
    return [...(scrollable ? ["↑↓ choose · Enter confirms · PgUp/PgDn read · Esc cancels — Cancel is selected"] : []),
      "↑↓ choose · Enter confirms · Esc cancels — Cancel is selected",
      "Enter confirms · Esc cancels (Cancel default)", "Esc cancels (Cancel)", "Esc cancel", "Esc"];
  }
  return [...(scrollable ? ["↑↓ choose · Enter select · PgUp/PgDn read · Esc cancel"] : []),
    "↑↓ choose · Enter select · Esc cancel", "Enter select · Esc cancel", "Esc cancel", "Esc"];
}

/** Standalone dialog adapter: only one modal owns input; pasted keys never confirm. */
export class CompanionBriefingDialogs implements BriefingDialogs {
  private active: Component | undefined;
  private notice = "";
  private noticeLevel: NoticeLevel = "info";
  private readonly tui: TuiAltScreen;
  constructor(tui: TuiAltScreen) { this.tui = tui; }
  handleInput(data: string): void { this.active?.handleInput?.(data); this.tui.requestRender(); }
  notify(message: string, level: NoticeLevel = "info"): void { this.notice = message; this.noticeLevel = level; }
  async showPendingNotice(): Promise<void> {
    if (this.notice) await this.select("Briefing outcome", ["Back to workspace"]);
  }
  select(title: string, choices: string[]): Promise<string | undefined> {
    return this.dialog("select", title, choices);
  }
  async confirm(title: string, message: string): Promise<boolean> {
    return await this.dialog("confirm", `${title}\n${message}`, ["Cancel", "Confirm"]) === "Confirm";
  }
  input(title: string, initial: string): Promise<string | undefined> { return this.editor(title, initial); }
  editor(title: string, text: string): Promise<string | undefined> { return this.dialog("editor", title, undefined, text); }

  private dialog(kind: DialogKind, title: string, choices?: string[], initial = ""): Promise<string | undefined> {
    const tui = this.tui;
    // The notice pending when the dialog opened (save confirmation, "View
    // sources", a send warning) belongs to this dialog's context region, not to
    // the next heading; capture level with it and clear the field so a notice
    // raised *during* the dialog can pin itself at the top instead.
    const pendingNotice = this.notice;
    const pendingLevel = this.noticeLevel;
    this.notice = "";
    return new Promise(resolve => {
      let finished = false;
      const done = (value: string | undefined): void => {
        if (finished) return;
        finished = true;
        this.active = undefined; // Drop repeated keys while the controller is awaiting I/O.
        this.notice = ""; // In-dialog notices served their purpose; never leak stale into the next heading.
        this.noticeLevel = "info";
        resolve(value);
      };
      const guard = new PasteGuard();
      const editor = choices ? undefined : new Editor(tui, { borderColor: c.accent, selectList: focusListTheme });
      if (editor) { editor.disableSubmit = true; editor.setText(initial); editor.focused = true; }
      // Show every choice a third of the pane can hold rather than a fixed 8:
      // a tall pane then lists the whole menu instead of nesting its own
      // "(1/9)" scroll inside a dialog that is already scrollable.
      const list = choices
        ? new SelectList(choices.map(value => ({ value, label: value })),
          Math.max(1, Math.min(choices.length, Math.floor(tui.terminal.rows / 3))), focusListTheme)
        : undefined;
      if (list) { list.onSelect = item => done(item.value); list.onCancel = () => done(undefined); }
      let offset = 0;
      let maxOffset = 0;
      let page = 1;
      let lastWidth = 0;
      const component: Component = {
        invalidate: () => { editor?.invalidate(); list?.invalidate(); },
        render: width => {
          if (width < 1) return [];
          lastWidth = width;
          const rows = Math.max(1, tui.terminal.rows);
          const wrapWidth = Math.max(2, width);
          const narrow = !!editor && width < minimumSafeEditorWidth(editor.getText());
          const body = editor
            ? narrow ? [c.yellow("⚠ Viewport too narrow — widen the pane to save; text kept, nothing saved")] : editor.render(width)
            : list?.render(width) ?? [];

          // Row budget, bottom-up: the footer (cancel help + read position) and
          // the actions must survive every heading length, so the heading is what
          // gives way — never the way out of the dialog.
          const spare = rows - body.length - 1;
          const live = this.notice
            ? wrapTextWithAnsi(noticeText(this.notice, this.noticeLevel), wrapWidth)
              .slice(0, Math.max(0, Math.min(liveNoticeRows(rows), spare - 1)))
              .map(noticePaint(this.noticeLevel))
            : [];
          const titleLines = title.split("\n");
          // Primary heading is pinned: scrolling the briefing must never cost
          // the user the answer to "which dialog am I in".
          const pinned = wrapTextWithAnsi(titleLines[0] || " ", wrapWidth)
            .slice(0, Math.max(1, spare - live.length))
            .map(text => c.accentBold(text));
          // Scrollable context: the opening notice, then target/session facts and
          // the briefing preview. Long prose lives here and only here.
          const context = [
            ...(pendingNotice
              ? [...wrapTextWithAnsi(noticeText(pendingNotice, pendingLevel), wrapWidth).map(noticePaint(pendingLevel)), ""]
              : []),
            ...titleLines.slice(1).flatMap(line => wrapTextWithAnsi(line || " ", wrapWidth)),
          ];

          // A labelled rule separates orientation prose from the actions, and a
          // blank line separates the actions from the footer. Both are the first
          // thing to go when the pane cannot afford them. The editor draws its
          // own accented border, so a rule there would only stack two rules.
          const fixed = live.length + pinned.length + body.length + 1;
          const decorated = rows - fixed >= 5;
          const ruleRows = decorated && !editor && width >= MIN_RULE_WIDTH ? 1 : 0;
          const gapRows = decorated ? 1 : 0;
          const available = rows - fixed - ruleRows - gapRows;
          page = Math.max(1, available);
          maxOffset = Math.max(0, context.length - page);
          offset = Math.min(offset, maxOffset);

          // Only claim a read position when text is actually unread; a permanent
          // "1-3/3" reads as a stuck indicator rather than as information.
          const scrollable = maxOffset > 0;
          const range = scrollable ? `↕ ${offset + 1}–${Math.min(context.length, offset + page)}/${context.length}` : "";
          const label = kind === "confirm" ? "CONFIRM" : "CHOOSE";
          const rule = ruleRows ? [c.muted(sectionRule(range ? `${label} · ${range}` : label, width))] : [];

          // Never truncate the footer: pick the richest help that fits, then add
          // the read position only if the rule could not carry it and it still
          // fits. Help about leaving the dialog outranks the indicator.
          const tiers = hintTiers(kind, scrollable);
          const hint = tiers.find(tier => visibleWidth(tier) <= width) ?? tiers[tiers.length - 1] ?? "Esc";
          const orphanRange = range && ruleRows === 0 && visibleWidth(`${hint} ${range}`) <= width ? range : "";
          const footer = orphanRange ? `${c.muted(hint)} ${c.accent(orphanRange)}` : c.muted(hint);

          return [...live, ...pinned, ...(available > 0 ? context.slice(offset, offset + page) : []),
            ...rule, ...body, ...(gapRows ? [""] : []), footer]
            .map(line => truncateToWidth(line, width, "")).slice(0, rows);
        },
        handleInput: data => {
          // Defense in depth: releases are dropped by the spike listener, but this
          // adapter must also behave when driven directly (tests, hosted reuse).
          if (isKeyRelease(data)) return;
          const parsed = guard.consumeWithPaste(data);
          if (parsed.sawMarkers) {
            if (editor) for (const paste of parsed.pastes) {
              try { validateBriefing(paste); editor.insertTextAtCursor(paste); } catch { this.notify("Paste rejected: unsupported control characters or size.", "warning"); }
            }
            return;
          }
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { done(undefined); return; }
          if (matchesKey(data, "pageUp")) { offset = Math.max(0, offset - page); return; }
          if (matchesKey(data, "pageDown")) { offset = Math.min(maxOffset, offset + page); return; }
          if (editor && matchesKey(data, "ctrl+s")) {
            // A narrow viewport hides unseen text; saving would bless what the
            // user cannot review. Block with a visible notice; text is kept.
            // lastWidth 0 means no render observed yet (tests, reuse): fail open.
            if (lastWidth > 0 && lastWidth < minimumSafeEditorWidth(editor.getText())) {
              this.notify("Viewport too narrow — widen the pane to save; text kept, nothing saved.", "warning");
              return;
            }
            done(editor.getExpandedText()); return;
          }
          if (editor) editor.handleInput(data);
          else list?.handleInput(data);
        },
      };
      this.active = component;
      tui.setLayoutRoot(component);
      tui.requestRender(true);
    });
  }
}
