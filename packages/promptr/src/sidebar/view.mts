import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  renderPromptrSidebarView, type PromptrPanelRows, type SidebarRenderResult, type SidebarTelemetrySnapshot,
  type SidebarChartGraphics, type SidebarViewportState, type ThemeLike,
} from "./atelier-adapter.mts";
import type { SidebarSettings } from "./config.mts";
import type { SidebarData } from "./store.mts";

export const SIDEBAR_ACTIONS = [
  ["compose", "c", "Compose draft"],
  ["queue", "q", "Queue draft"],
  ["review", "s", "Review / send one"],
  ["note", "n", "Edit notebook"],
  ["workspace", "w", "Tasks / briefing / resume"],
  ["refresh", "r", "Refresh tracker"],
  ["remove", "d", "Remove queued item"],
] as const;
/**
 * Panel settings and usage. Keyed while focused and named in the Controls hint row, which keeps
 * Controls within a 12-row viewport; /promptr panels and /promptr usage work when Controls is hidden.
 */
export const SIDEBAR_PANEL_ACTIONS = [
  ["panels", "p", "Panel settings"],
  ["usage", "u", "Subagent usage"],
] as const;
export type SidebarAction = typeof SIDEBAR_ACTIONS[number][0] | typeof SIDEBAR_PANEL_ACTIONS[number][0];
export interface SidebarSnapshot extends SidebarData {
  project: string;
  model: string;
  activity: string;
  context: string;
  git: string;
  tracking: string[];
  focused: boolean;
  busy: boolean;
  selected: number;
  attempted: ReadonlySet<string>;
  /** Open issues in the cached tracker snapshot; undefined when unknown. */
  trackingOpen?: number;
  notice: string;
}

/**
 * `scroll` pages the panel viewport: PageUp/PageDown, or `[` / `]` where page keys are unavailable.
 * `panel` moves the panel cursor (Left/Right, `k`/`j`); `fold` collapses or expands it; `foldAll` is `z`.
 */
export function sidebarInput(data: string, selected: number): {
  selected: number; action?: SidebarAction; release?: boolean; scroll?: -1 | 1; panel?: -1 | 1; fold?: true; foldAll?: true;
} {
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "tab")) return { selected, release: true };
  if (matchesKey(data, "pageUp") || data === "[") return { selected, scroll: -1 };
  if (matchesKey(data, "pageDown") || data === "]") return { selected, scroll: 1 };
  if (matchesKey(data, "left") || data === "k") return { selected, panel: -1 };
  if (matchesKey(data, "right") || data === "j") return { selected, panel: 1 };
  if (data === " ") return { selected, fold: true };
  if (data === "z") return { selected, foldAll: true };
  if (matchesKey(data, "up")) return { selected: (selected + SIDEBAR_ACTIONS.length - 1) % SIDEBAR_ACTIONS.length };
  if (matchesKey(data, "down")) return { selected: (selected + 1) % SIDEBAR_ACTIONS.length };
  const action = matchesKey(data, "enter") ? SIDEBAR_ACTIONS[selected]
    : [...SIDEBAR_ACTIONS, ...SIDEBAR_PANEL_ACTIONS].find((entry) => data === entry[1]);
  return action ? { selected, action: action[0] } : { selected };
}

export function safeLine(value: string): string {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Pure bounded renderer; no disk, tracker, model or terminal writes. */
export function renderSidebar(snapshot: SidebarSnapshot, width: number, height: number, theme: Pick<Theme, "fg" | "bold">): string[] {
  width = Math.max(0, Math.trunc(width)); height = Math.max(0, Math.trunc(height));
  if (!width || !height) return [];
  const inner = Math.max(0, width - 5);
  const pad = (text: string, size = inner) => {
    const short = truncateToWidth(text, size, "");
    return short + " ".repeat(Math.max(0, size - visibleWidth(short)));
  };
  const compact = height < 42;
  const row = (text: string) => ` ${theme.fg("borderMuted", "\u2502")} ${pad(text)} ${theme.fg("borderMuted", "\u2502")}`;
  const card = (title: string, content: string[]) => [
    ` ${theme.fg("accent", "\u256d\u2500 " + title + " " + "\u2500".repeat(Math.max(0, width - title.length - 6)) + "\u256e")}`,
    ...content.map(row), ` ${theme.fg("borderMuted", "\u2570" + "\u2500".repeat(Math.max(0, width - 3)) + "\u256f")}`,
    ...(compact ? [] : [""]),
  ];
  const preview = (text: string, fallback: string, count = 2) => text.trim() ? text.split("\n").filter(Boolean).slice(0, count).map(safeLine) : [theme.fg("dim", fallback)];
  const content = [
    ...card("SESSION", [theme.bold(safeLine(snapshot.project)),
      theme.fg(snapshot.activity === "Working" ? "warning" : "success", snapshot.activity) + "  " + safeLine(snapshot.context),
      ...(compact ? [] : [theme.fg("muted", safeLine(snapshot.model)), theme.fg("dim", safeLine(snapshot.git))])]),
    ...card("TASKS", snapshot.tracking.slice(0, compact ? 1 : 3).map(safeLine)),
    ...card(`QUEUE / ${snapshot.queue.items.length}`, snapshot.queue.items.length ? snapshot.queue.items.slice(0, compact ? 1 : 3)
      .map((item, i) => `${snapshot.attempted.has(item.id) ? "?" : String(i + 1)} ${safeLine(item.text.split("\n")[0] ?? "")}`) : [theme.fg("dim", "No queued prompts")]),
    ...card("DRAFT", preview(snapshot.composer, "Compose a thought with c", compact ? 1 : 2)),
    ...card("NOTEBOOK", preview(snapshot.note, "Private project notes with n", compact ? 1 : 2)),
  ];
  const menu = SIDEBAR_ACTIONS.map(([_, key, label], index) => {
    const text = `${snapshot.focused && snapshot.selected === index ? ">" : " "} ${key}  ${label}`;
    return ` ${snapshot.focused && snapshot.selected === index ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)}`;
  });
  const footer = [
    snapshot.error ? theme.fg("error", safeLine(snapshot.error)) : theme.fg("dim", safeLine(snapshot.notice || "Local first / explicit send only")),
    theme.fg("accent", snapshot.busy ? "Dialog open..." : snapshot.focused ? "Esc / Tab: back to Pi" : "Alt+P: focus   Alt+Shift+P: hide"),
  ];
  const header = [theme.bold(theme.fg("accent", " PROMPTR")) + theme.fg("dim", " / sidebar study"), ""];
  // Keep the selected control visible even on a very short terminal.
  const controls = height < 18 ? [menu[snapshot.selected] ?? "", ...footer] : [...menu, "", ...footer];
  const bodyHeight = Math.max(0, height - header.length - controls.length);
  return [...header, ...content.slice(0, bodyHeight), ...Array(Math.max(0, bodyHeight - content.length)).fill(""), ...controls]
    .slice(0, height).map((line) => pad(line, width));
}

// ---- Panel composition over the adopted Atelier renderer ----

const previewRows = (text: string, fallback: string, count: number): PromptrPanelRows["rows"] => {
  const lines = text.split("\n").filter((line) => line.trim()).slice(0, count);
  return lines.length ? lines : [{ text: fallback, role: "dim" }];
};

/**
 * Promptr panel content from the existing store snapshot. Pure; empty content says so explicitly.
 * Controls lists the same actions as `sidebarInput`; `/promptr panels` stays available when Controls is off.
 */
export function promptrPanelRows(snapshot: SidebarSnapshot): PromptrPanelRows[] {
  const items = snapshot.queue.items;
  const queueRows: PromptrPanelRows["rows"] = snapshot.error ? [{ text: snapshot.error, role: "error" }]
    : items.length ? [
      ...items.slice(0, 5).map((item, index) => ({ text: `${snapshot.attempted.has(item.id) ? "?" : String(index + 1)} ${item.text.split("\n")[0] ?? ""}`,
        ...(snapshot.attempted.has(item.id) ? { role: "warning" as const } : {}) })),
      ...(items.length > 5 ? [{ text: `+${items.length - 5} more`, role: "dim" as const }] : []),
    ] : [{ text: "No queued prompts", role: "dim" }];
  const controls: PromptrPanelRows["rows"] = [
    ...SIDEBAR_ACTIONS.map(([_, key, label], index) => {
      const active = snapshot.focused && snapshot.selected === index;
      return { text: `${active ? ">" : " "} ${key}  ${label}`, role: active ? "accent" as const : "muted" as const };
    }),
    { text: snapshot.busy ? "Dialog open..." : snapshot.focused ? "Esc: back · PgUp/PgDn · p panels · u usage" : "Alt+P: focus · /promptr panels|usage", role: "dim" },
    // While focused, the second row names the fold keys. Actions release focus, so their notices still show.
    ...(snapshot.focused && !snapshot.busy ? [{ text: "←→/jk panel · Space fold · z all", role: "dim" as const }]
      : snapshot.notice ? [{ text: snapshot.notice, role: "dim" as const }] : []),
  ];
  return [
    { id: "promptr:tasks", rows: snapshot.tracking.length ? snapshot.tracking.slice(0, 6) : [{ text: "No tracker summary", role: "dim" }],
      ...(snapshot.trackingOpen === undefined ? {} : { badge: String(snapshot.trackingOpen) }) },
    { id: "promptr:notebook", rows: previewRows(snapshot.note, "Private project notes with n", 3) },
    { id: "promptr:queue", title: `Queue / ${items.length}`, rows: queueRows, ...(snapshot.error ? {} : { badge: String(items.length) }) },
    { id: "promptr:draft", rows: previewRows(snapshot.composer, "Compose a thought with c", 3) },
    { id: "promptr:controls", rows: controls },
  ];
}

export interface ComposedSidebarInput {
  telemetry: SidebarTelemetrySnapshot;
  settings: Pick<SidebarSettings, "sidebarPanelLayout" | "showSidebarToolNames"> & Partial<Pick<SidebarSettings, "sidebarCollapsedPanels">>;
  data: SidebarSnapshot;
  width: number;
  height: number;
  theme: ThemeLike;
  panelOffset?: number;
  /** Panel ID under the focused-sidebar cursor. */
  cursor?: string;
  colorEnabled?: boolean;
  now?: number;
  /** Forwarded to the subagent cost graph; see SidebarRenderInput.chartGraphics. */
  chartGraphics?: SidebarChartGraphics;
}

/** Saved order and visibility, Promptr and Atelier panels, bounded to width x height. Pure. */
export function renderComposedSidebar(input: ComposedSidebarInput): SidebarRenderResult {
  return renderPromptrSidebarView({
    telemetry: input.telemetry, layout: input.settings.sidebarPanelLayout, promptrPanels: promptrPanelRows(input.data),
    width: input.width, height: input.height, theme: input.theme,
    config: { showSidebarToolNames: input.settings.showSidebarToolNames },
    panelOffset: input.panelOffset ?? 0,
    collapsed: input.settings.sidebarCollapsedPanels ?? [],
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.colorEnabled === undefined ? {} : { colorEnabled: input.colorEnabled }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.chartGraphics === undefined ? {} : { chartGraphics: input.chartGraphics }),
  });
}

/**
 * Next panel offset for a page request. Down jumps to the first panel that did not fit; up steps back one.
 * The offset is session state only; it never changes saved settings.
 */
export function nextPanelOffset(viewport: SidebarViewportState, direction: -1 | 1): number {
  if (direction < 0) return Math.max(0, viewport.panelOffset - 1);
  const first = viewport.below[0];
  const index = first === undefined ? -1 : viewport.panelIds.indexOf(first);
  return index > viewport.panelOffset ? index : Math.min(Math.max(0, viewport.panelIds.length - 1), viewport.panelOffset + (viewport.below.length ? 1 : 0));
}
