// Promptr panel settings screen. Adapted in spirit from the Sidebar Editor section of pi-atelier
// v0.12.0 src/settings-workspace.ts (MIT, Copyright (c) 2026 Michael): toggle, reorder, restore
// defaults, one-step Undo, explicit Save. Footer and display-segment editing are deliberately absent.
// The screen edits a draft only. Save writes through saveSidebarSettings(); Cancel writes nothing.
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeSidebarPanels, panelTitle, type SidebarPanelId, type SidebarPanelLayout, type SidebarViewportState } from "./atelier-adapter.mts";
import {
  cloneSidebarSettings, defaultSidebarSettings, isPanelCollapsed, movePanel, movePanelBy, saveSidebarSettings, setPanelCollapsed,
  setPanelVisible,
  setSidebarWidthSetting, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, type SaveOutcome, type SidebarSettings,
  type SidebarSettingsState,
} from "./config.mts";
import { isSidebarPanelId, sanitizeSidebarPanelText } from "./vendor/atelier/sidebar-panels.mts";

export interface SettingsThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type PanelSettingsResult = { saved: true; state: SidebarSettingsState } | { saved: false };

export interface PanelSettingsDialogOptions {
  /** Settings loaded when the screen opened; its fingerprint fences stale saves. */
  state: SidebarSettingsState;
  /** Panel IDs with a current data source (Promptr and contributed). Built-ins are always available. */
  availableIds(): Iterable<string>;
  /** Last sidebar viewport, used to mark enabled panels that are currently outside the view. */
  viewport?(): SidebarViewportState | undefined;
  /** Live preview of the draft layout. Must not write anything. */
  preview?(layout: SidebarPanelLayout, width: number, height: number): string[];
  /** False after session shutdown or replacement; Save then refuses. */
  isCurrent?(): boolean;
  getViewportHeight?(): number;
  theme: SettingsThemeLike;
  requestRender(): void;
  done(result: PanelSettingsResult): void;
  /** Injectable for tests; defaults to saveSidebarSettings. */
  save?(base: SidebarSettingsState, next: SidebarSettings, options: { isCurrent?: () => boolean }): SaveOutcome;
}

export interface PanelSettingsDialog extends Component {
  handleInput(data: string): void;
  /** Current draft (a copy). */
  draft(): SidebarSettings;
}

type Row = { kind: "panel"; id: SidebarPanelId } | { kind: "startup" } | { kind: "width" } | { kind: "toolNames" };

const fit = (text: string, width: number) => {
  const short = truncateToWidth(text, Math.max(0, width), "");
  return short + " ".repeat(Math.max(0, width - visibleWidth(short)));
};

/** Same viewport rule as the upstream settings overlay: 95% height with a one-row margin. */
export function panelSettingsViewportHeight(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 0;
  return Math.max(1, Math.min(Math.floor((rows * 95) / 100), Math.max(1, rows - 2)));
}

/** Append panels that became available but are absent from the layout, hidden, like upstream settings. */
export function withDiscoveredPanels(layout: SidebarPanelLayout, ids: Iterable<string>): SidebarPanelLayout {
  const next = layout.map((entry) => ({ ...entry }));
  for (const id of ids) if (isSidebarPanelId(id) && !next.some((entry) => entry.id === id)) next.push({ id, visible: false });
  return next;
}

/** Product defaults plus any other saved or discovered IDs, hidden, so they stay restorable. */
export function defaultsKeepingExtras(current: SidebarSettings): SidebarSettings {
  const defaults = defaultSidebarSettings();
  return { ...defaults, sidebarPanelLayout: withDiscoveredPanels(defaults.sidebarPanelLayout,
    current.sidebarPanelLayout.map((entry) => entry.id)) };
}

export function createPanelSettingsDialog(options: PanelSettingsDialogOptions): PanelSettingsDialog {
  const theme = options.theme;
  const save = options.save ?? saveSidebarSettings;
  let draft = cloneSidebarSettings(options.state.settings);
  draft.sidebarPanelLayout = withDiscoveredPanels(draft.sidebarPanelLayout, options.availableIds());
  let undo: SidebarSettings | undefined;
  let focus = 0;
  let scroll = 0;
  let positionInput: string | undefined;
  let dirty = false;
  let closed = false;
  let feedback = options.state.error ? options.state.error : "";
  let feedbackRole = options.state.error ? "error" : "muted";

  const rows = (): Row[] => [...draft.sidebarPanelLayout.map((entry): Row => ({ kind: "panel", id: entry.id })),
    { kind: "startup" }, { kind: "width" }, { kind: "toolNames" }];
  const tell = (message: string, role = "muted") => { feedback = message; feedbackRole = role; };
  const change = (next: SidebarSettings, message: string) => {
    undo = cloneSidebarSettings(draft);
    draft = next;
    dirty = true;
    tell(message);
  };
  const changeLayout = (result: { ok: true; value: SidebarPanelLayout; message: string } | { ok: false; error: string }) => {
    if (result.ok) change({ ...cloneSidebarSettings(draft), sidebarPanelLayout: result.value }, result.message);
    else tell(result.error, "warning");
  };
  const finish = (result: PanelSettingsResult) => {
    if (closed) return;
    closed = true;
    options.done(result);
  };
  const selectedPanel = (): SidebarPanelId | undefined => {
    const row = rows()[focus];
    return row?.kind === "panel" ? row.id : undefined;
  };
  const keepFocusOn = (id: SidebarPanelId) => {
    const index = rows().findIndex((row) => row.kind === "panel" && row.id === id);
    if (index >= 0) focus = index;
  };
  const doSave = () => {
    const outcome = save(options.state, draft, options.isCurrent ? { isCurrent: () => options.isCurrent!() } : {});
    if (outcome.ok) finish({ saved: true, state: outcome.state });
    else tell(outcome.error, "error");
  };
  const toggle = () => {
    const row = rows()[focus];
    if (!row) return;
    if (row.kind === "panel") {
      const entry = draft.sidebarPanelLayout.find((item) => item.id === row.id);
      if (entry) changeLayout(setPanelVisible(draft.sidebarPanelLayout, entry.id, !entry.visible));
    } else if (row.kind === "startup")
      change({ ...cloneSidebarSettings(draft), showSidebarOnStartup: !draft.showSidebarOnStartup },
        `Startup ${!draft.showSidebarOnStartup ? "shows" : "hides"} the sidebar`);
    else if (row.kind === "toolNames")
      change({ ...cloneSidebarSettings(draft), showSidebarToolNames: !draft.showSidebarToolNames },
        `Tool names ${!draft.showSidebarToolNames ? "shown" : "hidden"}`);
    else tell("Use Left/Right to change the width", "warning");
  };
  const resize = (delta: number) => {
    if (rows()[focus]?.kind !== "width") return;
    const result = setSidebarWidthSetting(draft, draft.sidebarWidth + delta);
    if (result.ok) change(result.value, result.message);
    else tell(result.error, "warning");
  };
  const fold = () => {
    const id = selectedPanel();
    if (!id) return tell("Select a panel to collapse or expand", "warning");
    const result = setPanelCollapsed(draft, id, !isPanelCollapsed(draft, id));
    if (result.ok) change(result.value, result.message);
    else tell(result.error, "warning");
  };
  const move = (delta: number) => {
    const id = selectedPanel();
    if (!id) return tell("Select a panel to move", "warning");
    changeLayout(movePanelBy(draft.sidebarPanelLayout, id, delta));
    keepFocusOn(id);
  };

  const input = (data: string) => {
    if (closed) return;
    if (positionInput !== undefined) {
      if (/^\d$/.test(data) && positionInput.length < 3) positionInput += data;
      else if (matchesKey(data, "backspace")) positionInput = positionInput.slice(0, -1);
      else if (matchesKey(data, "escape")) { positionInput = undefined; tell("Move cancelled"); }
      else if (matchesKey(data, "enter")) {
        const id = selectedPanel();
        const position = Number(positionInput);
        positionInput = undefined;
        if (id) { changeLayout(movePanel(draft.sidebarPanelLayout, id, position)); keepFocusOn(id); }
      }
      return;
    }
    const count = rows().length;
    if (matchesKey(data, "up")) focus = (focus + count - 1) % count;
    else if (matchesKey(data, "down")) focus = (focus + 1) % count;
    else if (matchesKey(data, "shift+up") || data === "[") move(-1);
    else if (matchesKey(data, "shift+down") || data === "]") move(1);
    else if (matchesKey(data, "left")) resize(-1);
    else if (matchesKey(data, "right")) resize(1);
    else if (matchesKey(data, "enter") || data === " ") toggle();
    else if (data === "f" || data === "F") fold();
    else if (matchesKey(data, "escape") || data === "q") { tell("Cancelled"); finish({ saved: false }); }
    else if (data === "s" || data === "S") doSave();
    else if (data === "d" || data === "D") change(defaultsKeepingExtras(draft), "Defaults loaded into the draft. Press S to save.");
    else if (data === "u" || data === "U") {
      if (!undo) tell("Nothing to undo", "warning");
      else { draft = undo; undo = undefined; dirty = true; tell("Undid the last change"); }
    } else if (data === "m" || data === "M") {
      if (selectedPanel()) { positionInput = ""; tell(`Type a position 1-${draft.sidebarPanelLayout.length}, then Enter`); }
      else tell("Select a panel to move", "warning");
    }
  };

  const render = (width: number): string[] => {
    width = Math.max(0, Math.trunc(width));
    if (width < 4) return [];
    const inner = width - 2;
    const available = [...options.availableIds()].filter(isSidebarPanelId);
    const descriptors = describeSidebarPanels(draft.sidebarPanelLayout, available);
    const viewport = options.viewport?.();
    const outside = new Set([...(viewport?.above ?? []), ...(viewport?.below ?? [])]);
    const allRows = rows();
    const line = (row: Row, text: string) => {
      const focused = allRows[focus] === row;
      return { text: `${focused ? theme.fg("accent", "›") : " "} ${focused ? theme.bold(text) : text}`, focused };
    };
    const numberWidth = String(descriptors.length).length;
    const list = [
      ...descriptors.map((entry, index) => {
        const title = sanitizeSidebarPanelText(entry.title || panelTitle(entry.id), 24);
        const state = entry.visible ? theme.fg("success", "● on ") : theme.fg("dim", "○ off");
        const folded = isPanelCollapsed(draft, entry.id) ? theme.fg("muted", "▸ folded") : theme.fg("dim", "▾ open  ");
        const notes = [!entry.available ? theme.fg("warning", "unavailable") : "",
          entry.visible && entry.available && outside.has(entry.id) ? theme.fg("muted", "outside view") : "",
          theme.fg("dim", entry.id)].filter(Boolean).join("  ");
        return line(allRows[index]!, `${String(index + 1).padStart(numberWidth)} ${state} ${folded} ${fit(title, 12)} ${notes}`);
      }),
      { text: "", focused: false },
      line(allRows[descriptors.length]!, `Startup     ${draft.showSidebarOnStartup ? "show sidebar" : "stay hidden"}`),
      line(allRows[descriptors.length + 1]!, `Width       ${draft.sidebarWidth}  (${SIDEBAR_WIDTH_MIN}-${SIDEBAR_WIDTH_MAX}, Left/Right)`),
      line(allRows[descriptors.length + 2]!, `Tool names  ${draft.showSidebarToolNames ? "shown" : "hidden"}`),
    ];
    const visibleTitles = descriptors.filter((entry) => entry.visible && entry.available).map((entry) => entry.title);
    const order = visibleTitles.length ? visibleTitles.join(" › ") : "All panels off. The sidebar will name /promptr panels.";
    const status = positionInput !== undefined ? `Move to position: ${positionInput}_`
      : feedback ? theme.fg(feedbackRole, feedback) : "";
    const header = [
      `${theme.bold(theme.fg("accent", "PROMPTR PANELS"))}  ${dirty ? theme.fg("warning", "draft · not saved") : theme.fg("success", "saved")}`,
      theme.fg("muted", "↑/↓ select · Enter on/off · f fold · [ ] move · m pos · S save · D defaults · U undo · Esc cancel"),
    ];
    const footer = [theme.fg("muted", `Preview: ${order}`), status];
    const previewWidth = options.preview && inner >= 84 ? Math.min(44, Math.floor(inner * 0.4)) : 0;
    const listWidth = previewWidth ? inner - previewWidth - 2 : inner;
    const previewLines = previewWidth ? options.preview!(draft.sidebarPanelLayout.map((entry) => ({ ...entry })), previewWidth, list.length) : [];
    const body = list.map((entry, index) => ({
      text: previewWidth ? `${fit(entry.text, listWidth)}  ${fit(previewLines[index] ?? "", previewWidth)}` : entry.text,
      focused: entry.focused,
    }));

    const frame = (lines: string[]) => [
      theme.fg("borderAccent", `╭${"─".repeat(inner)}╮`),
      ...lines.map((text) => `${theme.fg("borderAccent", "│")}${fit(text, inner)}${theme.fg("borderAccent", "│")}`),
      theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
    ].map((text) => truncateToWidth(text, width, ""));
    const viewportHeight = options.getViewportHeight?.();
    if (viewportHeight === undefined || !Number.isFinite(viewportHeight)) return frame([...header, "", ...body.map((b) => b.text), "", ...footer]);
    const height = Math.max(0, Math.floor(viewportHeight));
    if (height < 3) return height ? [fit(theme.bold("PROMPTR PANELS"), width)] : [];
    const interior = height - 2;
    const fixed = [...header, ...footer];
    if (interior <= fixed.length) return frame([...header.slice(0, 1), ...footer].slice(0, interior));
    // Keep header and footer fixed; scroll the list so the focused row stays visible.
    const room = interior - fixed.length;
    const focusedIndex = Math.max(0, body.findIndex((entry) => entry.focused));
    if (body.length <= room) scroll = 0;
    else {
      if (focusedIndex < scroll) scroll = focusedIndex;
      if (focusedIndex >= scroll + room) scroll = focusedIndex - room + 1;
      scroll = Math.max(0, Math.min(scroll, body.length - room));
    }
    const shown = body.slice(scroll, scroll + room).map((entry) => entry.text);
    if (scroll > 0 && shown.length) shown[0] = theme.fg("dim", "↑ more");
    if (scroll + room < body.length && shown.length > 1) shown[shown.length - 1] = theme.fg("dim", "↓ more");
    return frame([...header, ...shown, ...Array(Math.max(0, room - shown.length)).fill(""), ...footer]);
  };

  return {
    render,
    invalidate() {},
    handleInput(data) { input(data); options.requestRender(); },
    draft: () => cloneSidebarSettings(draft),
  };
}

/** Open the settings screen as a Pi overlay. Resolves when the user saves or cancels. */
export function openPanelSettings(ui: Pick<ExtensionUIContext, "custom">,
  options: Omit<PanelSettingsDialogOptions, "theme" | "requestRender" | "done" | "getViewportHeight">): Promise<PanelSettingsResult> {
  return ui.custom<PanelSettingsResult>((tui, theme, _keybindings, done) => createPanelSettingsDialog({
    ...options,
    theme: { fg: (color, text) => theme.fg(color as never, text), bold: (text) => theme.bold(text) },
    requestRender: () => tui.requestRender(),
    getViewportHeight: () => panelSettingsViewportHeight(tui.terminal.rows),
    done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "95%", margin: 1 } });
}
