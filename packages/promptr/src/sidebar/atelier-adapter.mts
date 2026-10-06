// Promptr adapter over the vendored pi-atelier v0.12.0 sidebar renderer.
// Upstream panel IDs stay stable; Promptr panels use the `promptr:<name>` namespace.
// See packages/promptr/docs/atelier-adaptation.md for ownership and provenance.
import type { ThemeLike } from "./vendor/atelier/footer.mts";
import {
  renderSidebarView, type SidebarChartGraphics, type SidebarSnapshot, type SidebarViewportState,
} from "./vendor/atelier/sidebar.mts";
import {
  BUILTIN_SIDEBAR_PANEL_IDS, SIDEBAR_PANEL_EVENT_CHANNEL, SIDEBAR_PANEL_MAX_ROWS, SIDEBAR_PANEL_PROTOCOL_VERSION,
  isSidebarPanelRole, sanitizeSidebarPanelText, SIDEBAR_PANEL_MAX_TITLE_CHARS,
  type SidebarPanelData, type SidebarPanelRole, type SidebarPanelRow,
} from "./vendor/atelier/sidebar-panels.mts";
import { DEFAULT_CONFIG, type AtelierConfig, type SidebarPanelId, type SidebarPanelLayout } from "./vendor/atelier/types.mts";

export type {
  ThemeLike, SidebarChartGraphics, SidebarPanelId, SidebarPanelLayout, SidebarPanelRole, SidebarPanelRow, SidebarViewportState,
};
/** Cached telemetry snapshot rendered by the upstream sidebar (see ./telemetry.mts). */
export type SidebarTelemetrySnapshot = SidebarSnapshot;

/** Extension-to-extension contribution protocol: channel `promptr:sidebar-panels`, version 1. */
export const PROMPTR_SIDEBAR_CHANNEL = SIDEBAR_PANEL_EVENT_CHANNEL;
export const PROMPTR_SIDEBAR_PROTOCOL_VERSION = SIDEBAR_PANEL_PROTOCOL_VERSION;
/** Source name for Promptr's own panels; contributed panels from other extensions keep theirs. */
export const PROMPTR_PANEL_SOURCE = "promptr";

export const PROMPTR_PANEL_IDS = ["promptr:tasks", "promptr:notebook", "promptr:queue", "promptr:draft", "promptr:controls"] as const;
export type PromptrPanelId = typeof PROMPTR_PANEL_IDS[number];
export type BuiltinPanelId = typeof BUILTIN_SIDEBAR_PANEL_IDS[number];

const TITLES: Record<BuiltinPanelId | PromptrPanelId, string> = {
  agent: "Agent", activity: "Activity", alerts: "Alerts", todos: "TODOs", context: "Context", workspace: "Workspace",
  usage: "Usage", subagents: "Subagents", tools: "Tools",
  "promptr:tasks": "Tasks", "promptr:notebook": "Notebook", "promptr:queue": "Queue", "promptr:draft": "Draft",
  "promptr:controls": "Controls",
};

/** Initial order: all fourteen panels, all enabled. */
export const DEFAULT_PROMPTR_PANEL_ORDER: readonly (BuiltinPanelId | PromptrPanelId)[] = [
  "agent", "activity", "promptr:tasks", "promptr:notebook", "promptr:queue", "promptr:draft", "alerts", "todos",
  "context", "workspace", "usage", "subagents", "tools", "promptr:controls",
];

export function defaultPromptrPanelLayout(): SidebarPanelLayout {
  return DEFAULT_PROMPTR_PANEL_ORDER.map((id) => ({ id, visible: true }));
}

/** Settings-facing view of one box. `available` is false for a saved panel with no current data source. */
export interface SidebarPanelDescriptor {
  id: SidebarPanelId;
  title: string;
  visible: boolean;
  order: number;
  available: boolean;
  builtin: boolean;
}

/** Promptr-owned panel content, produced by the controller from the existing store. */
export interface PromptrPanelRows {
  id: PromptrPanelId;
  title?: string;
  rows: readonly (string | SidebarPanelRow)[];
  role?: SidebarPanelRole;
  /** Short count shown after the title while the panel is collapsed. Omit when the data is unknown. */
  badge?: string;
}

const isBuiltin = (id: string): id is BuiltinPanelId => (BUILTIN_SIDEBAR_PANEL_IDS as readonly string[]).includes(id);

export function panelTitle(id: SidebarPanelId): string {
  return (TITLES as Record<string, string>)[id] ?? id;
}

/** Describe every saved layout entry in order. Built-ins are always available (their content may be empty). */
export function describeSidebarPanels(layout: SidebarPanelLayout, availableIds: Iterable<SidebarPanelId>): SidebarPanelDescriptor[] {
  const available = new Set<string>(availableIds);
  return layout.map((entry, order) => ({ id: entry.id, title: panelTitle(entry.id), visible: entry.visible, order,
    available: isBuiltin(entry.id) || available.has(entry.id), builtin: isBuiltin(entry.id) }));
}

export function toSidebarPanelData(panel: PromptrPanelRows): SidebarPanelData {
  const rows = panel.rows.slice(0, SIDEBAR_PANEL_MAX_ROWS).map((row): SidebarPanelRow => {
    const text = sanitizeSidebarPanelText(typeof row === "string" ? row : row.text);
    return typeof row !== "string" && isSidebarPanelRole(row.role) ? { text, role: row.role } : { text };
  });
  return { id: panel.id, title: sanitizeSidebarPanelText(panel.title ?? panelTitle(panel.id), SIDEBAR_PANEL_MAX_TITLE_CHARS),
    rows, available: true, source: PROMPTR_PANEL_SOURCE, ...(panel.role ? { role: panel.role } : {}) };
}

export interface SidebarRenderInput {
  telemetry: SidebarTelemetrySnapshot;
  /** Ordered, already-normalized layout; hidden entries are skipped, unavailable ones render nothing. */
  layout: SidebarPanelLayout;
  promptrPanels: readonly PromptrPanelRows[];
  width: number;
  /** Rows above the preserved input/footer dock. */
  height: number;
  theme: ThemeLike;
  config?: Partial<Omit<AtelierConfig, "sidebarPanelLayout">>;
  colorEnabled?: boolean;
  now?: number;
  /** First rendered panel among the visible, available panels (overflow paging). Clamped. */
  panelOffset?: number;
  /** Panel IDs drawn as one header row. */
  collapsed?: readonly string[];
  /** Panel ID under the focused-sidebar cursor. */
  cursor?: string;
  /**
   * Subagent cost-graph graphics. Pass a stable `imageOwner` per sidebar session and
   * `suspendPlot: true` while a capturing overlay is open. A suspended plot keeps its rows reserved.
   */
  chartGraphics?: SidebarChartGraphics;
}

export interface SidebarRenderResult {
  lines: string[];
  viewport: SidebarViewportState;
}

/**
 * True when the rendered text depends on the clock: a running turn or tool shows its elapsed time and the
 * working Agent jewel blinks. Otherwise the same snapshot always renders the same lines.
 */
export function sidebarTimeDependent(snapshot: SidebarTelemetrySnapshot): boolean {
  const run = snapshot.runActivity;
  return snapshot.activity === "working" || run.phase === "running" || run.activeTools.length > 0
    || (run.phase === "settled" && run.durationMs === undefined);
}

/** Pure render with overflow state: no disk, timers, terminal writes, footer or editor changes. */
export function renderPromptrSidebarView(input: SidebarRenderInput): SidebarRenderResult {
  const collapsed = new Set(input.collapsed ?? []);
  // A collapsed Promptr panel shows its plain title; its count moves to the badge (`QUEUE · 3`, not `QUEUE / 3 · 3`).
  const promptr = input.promptrPanels.map((panel) =>
    toSidebarPanelData(collapsed.has(panel.id) && panel.badge !== undefined ? { ...panel, title: panelTitle(panel.id) } : panel));
  const badges = Object.fromEntries(input.promptrPanels.flatMap((panel) => (panel.badge === undefined ? [] : [[panel.id, panel.badge]])));
  const own = new Set<string>(promptr.map((panel) => panel.id));
  const contributed = (input.telemetry.sidebarPanels ?? []).filter((panel) => !own.has(panel.id));
  const config: AtelierConfig = { ...structuredClone(DEFAULT_CONFIG), ...input.config,
    sidebarPanelLayout: input.layout.map((entry) => ({ ...entry })) };
  return renderSidebarView({ ...input.telemetry, sidebarPanels: [...contributed, ...promptr] }, config, input.theme,
    input.width, input.height, input.colorEnabled ?? true, input.now ?? Date.now(), false, input.chartGraphics ?? {},
    { panelOffset: input.panelOffset ?? 0, collapsed, badges, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
}

/** Pure render: no disk, timers, terminal writes, footer or editor changes. */
export function renderPromptrSidebar(input: SidebarRenderInput): string[] {
  return renderPromptrSidebarView(input).lines;
}
