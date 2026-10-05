// Session-scoped telemetry for the Promptr sidebar. Observes Pi events through the vendored
// Atelier v0.12.0 runtime (state, run-activity, workspace-pulse, subagent-*) without owning the footer,
// the editor, or any tool-result text. Rendering reads the cached snapshot only.
import {
  estimateTokens, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { aggregateMetrics } from "./vendor/atelier/metrics.mts";
import type { OverlayLifetime } from "./vendor/atelier/overlay-lifecycle.mts";
import { RENDER_WORKING_INTERVAL_MS } from "./render-guard.mts";
import { createRunActivityTracker, type RunActivityTracker } from "./vendor/atelier/run-activity.mts";
import { buildSidebarSnapshot, type SidebarSnapshot } from "./vendor/atelier/sidebar.mts";
import type { SidebarPanelData } from "./vendor/atelier/sidebar-panels.mts";
import { AtelierRuntime } from "./vendor/atelier/state.mts";
import { emptySubagentUsage, type SubagentUsageSnapshot } from "./vendor/atelier/subagent-usage.mts";
import { DEFAULT_CONFIG, type AtelierConfig, type NormalizedTodo, type RpivTask, type TodoItem } from "./vendor/atelier/types.mts";
import type { WorkspacePulseInspection } from "./vendor/atelier/workspace-pulse.mts";

export type SidebarTelemetrySnapshot = SidebarSnapshot;

/**
 * One instance per Pi session. `snapshot()` returns cached data and must never block or touch disk,
 * so render stays cheap. `subscribe()` fires after the cache changes. `dispose()` is idempotent and
 * releases timers, watchers and event subscriptions on session_shutdown or session replacement.
 */
export interface SidebarTelemetrySource {
  snapshot(): SidebarTelemetrySnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Inert snapshot: every metric is reported unavailable instead of an invented zero. */
export function unavailableTelemetrySnapshot(cwd: string): SidebarTelemetrySnapshot {
  return buildSidebarSnapshot({
    state: { activity: "ready", dirty: false, workspacePulse: { status: "unavailable" },
      metrics: aggregateMetrics([], { subscription: false, autoCompact: null }), extensionStatuses: [] },
    cwd, branchEntryCount: 0, activeToolCount: 0, availableToolCount: 0, extensionStatuses: [],
  });
}

/** Fallback source with no timers, files or subscriptions. */
export function createUnavailableTelemetry(cwd: string): SidebarTelemetrySource {
  const cached = unavailableTelemetrySnapshot(cwd);
  return { snapshot: () => cached, subscribe: () => () => {}, dispose() {} };
}

export type TelemetryAlertLevel = "warning" | "error";
export interface TelemetryAlert { level: TelemetryAlertLevel; text: string }
export type TelemetrySourceState = "available" | "unavailable" | "untrusted" | "suspended";
/** Explicit per-source availability, so an empty panel is never presented as an all-clear. */
export interface TelemetrySources {
  /** Other extensions' setStatus() text: Pi 0.87.1 exposes it only to the footer owner. */
  extensionStatuses: "unavailable";
  workspace: TelemetrySourceState;
  subagents: TelemetrySourceState;
  autoCompact: "available" | "unavailable";
}

/** Shown in ALERTS while external statuses are unreadable. "degraded" keeps it a warning, not an error. */
export const STATUS_SOURCE_GAP_ALERT = "Ext statuses: footer-only (degraded)";
const ALERT_PATTERN = /\b(error|failed?|failure|warn(?:ing)?|offline|unavailable|blocked|degraded)\b/i;
const MAX_ALERTS = 8;
const MAX_ALERT_CHARS = 120;

export interface SidebarTelemetryOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  /** Display configuration for the vendored runtime (currency decimals, tool-name list, ...). */
  config?: AtelierConfig;
  /** Whole-sidebar state. Disabled suspends Git, accounting reads and render requests. Default true. */
  enabled?: boolean;
  /** Pi auto-compaction mode. Omitted: read once at attach from Pi settings; failure reports unknown. */
  autoCompact?: boolean | null;
  /** Add STATUS_SOURCE_GAP_ALERT to ALERTS. Default true. */
  reportStatusSourceGap?: boolean;
  /** Contributed panels (registry owned by the integration); read during snapshot, must be cached. */
  contributedPanels?: () => readonly SidebarPanelData[];
  /** Test seam: replaces Git inspection. */
  inspectWorkspace?: (signal: AbortSignal) => Promise<WorkspacePulseInspection>;
  random?: () => number;
}

export interface SidebarTelemetry extends SidebarTelemetrySource {
  readonly sessionId: string;
  /** True while attached and `ctx` (when given) belongs to the attached session. */
  isCurrent(ctx?: ExtensionContext): boolean;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  isRunning(): boolean;
  getConfig(): AtelierConfig;
  setConfig(config: AtelierConfig): void;
  /** Promptr workflow alerts (queue unreadable, ...). Replaces the previous Promptr set. */
  setPromptrAlerts(alerts: readonly TelemetryAlert[]): void;
  sources(): TelemetrySources;
  /** Re-read session-owned subagent accounting (trusted, enabled sessions only). */
  refreshSubagentUsage(): Promise<void>;
  subagentUsage(): SubagentUsageSnapshot;
  /** Lifetime for dialogs owned by this session; dispose cancels them. */
  overlayLifetime(): OverlayLifetime;
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const validId = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value);

/**
 * All-or-nothing validation: one malformed item rejects the whole update, so a bad result can
 * never clear or partly replace a valid list. A failed update (`details.error`, as in Pi's example
 * `todo` tool, which reports failures without `isError`) is rejected even when it carries a list.
 */
function todoItems(details: unknown): (TodoItem | RpivTask)[] | undefined {
  if (!isRecord(details) || (details.error !== undefined && details.error !== null)) return undefined;
  if (Array.isArray(details.todos) && details.todos.every((item) => isRecord(item) && validId(item.id)
    && typeof item.text === "string" && typeof item.done === "boolean")) return details.todos as TodoItem[];
  if (Array.isArray(details.tasks) && details.tasks.every((item) => isRecord(item) && validId(item.id)
    && typeof item.subject === "string" && typeof item.status === "string" && TODO_STATUSES.has(item.status))) return details.tasks as RpivTask[];
  return undefined;
}

function normalizeTodos(items: readonly (TodoItem | RpivTask)[]): NormalizedTodo[] {
  return items.map((item): NormalizedTodo => "done" in item
    ? { id: item.id, text: item.text, status: item.done ? "completed" : "pending" }
    : { id: item.id, text: item.subject, status: item.status as NormalizedTodo["status"] });
}

/** Parse one `todo` tool result. Errors and malformed details return undefined and keep prior state. */
export function todosFromToolResult(message: unknown): NormalizedTodo[] | undefined {
  if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
  const items = todoItems(message.details);
  return items && normalizeTodos(items);
}

/** Latest valid `todo` result on the active branch; abandoned branches never contribute. */
export function reconstructTodos(branch: readonly unknown[]): NormalizedTodo[] {
  let todos: NormalizedTodo[] = [];
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    todos = todosFromToolResult(entry.message) ?? todos;
  }
  return todos;
}

function alertText(alert: TelemetryAlert): string {
  const text = alert.text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, MAX_ALERT_CHARS);
  if (!text) return "";
  // The ALERTS panel shows exception text only; make the requested severity explicit.
  return ALERT_PATTERN.test(text) ? text : `${alert.level === "error" ? "Error" : "Warning"}: ${text}`;
}

function readAutoCompact(ctx: ExtensionContext): boolean | null {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })
      .getCompactionSettings(ctx.model).enabled;
  } catch {
    return null;
  }
}

/**
 * Attach live telemetry to one session. Subscribes to Pi events for its own lifetime and
 * unsubscribes on dispose or on this session's session_shutdown. Never calls setFooter,
 * setEditorComponent, setHeader or setWidget, and never returns a tool_result change.
 */
export function attachSidebarTelemetry(options: SidebarTelemetryOptions): SidebarTelemetry {
  const { pi, ctx } = options;
  const sessionManager = ctx.sessionManager;
  const sessionId = sessionManager.getSessionId();
  const cwd = ctx.cwd;
  const inert = unavailableTelemetrySnapshot(cwd);
  const listeners = new Set<() => void>();
  const overlayCancellations = new Set<() => void>();
  const unsubscribers: (() => void)[] = [];
  const reportGap = options.reportStatusSourceGap ?? true;
  const autoCompact = options.autoCompact === undefined ? readAutoCompact(ctx) : options.autoCompact;
  let enabled = options.enabled ?? true;
  let disposed = false;
  let dirty = true;
  let cached = inert;
  let todos: NormalizedTodo[] = enabled ? reconstructTodos(sessionManager.getBranch()) : [];
  let promptrAlerts: string[] = [];
  let modelAlert: string | undefined;
  let compactionAlert: string | undefined;

  const notify = () => {
    dirty = true;
    if (disposed || !enabled) return;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A failed render request must not break event handling. */ }
    }
  };
  // Every streamed token changes the TPS estimate. Notifying per token sent 60-100 requests/s during a
  // fast turn, which the render guard reports as a storm (30/s); notify at most once per working frame.
  let streaming = false;
  let lastStreamNotify = Number.NEGATIVE_INFINITY;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  const streamNotify = () => { streamTimer = undefined; lastStreamNotify = Date.now(); notify(); };
  const activityChanged = () => {
    if (!streaming) return notify();
    dirty = true;
    const wait = lastStreamNotify + RENDER_WORKING_INTERVAL_MS - Date.now();
    if (wait <= 0) return streamNotify();
    if (streamTimer !== undefined) return;
    streamTimer = setTimeout(() => { if (!disposed) streamNotify(); }, wait);
    streamTimer.unref?.();
  };
  const runActivity: RunActivityTracker = createRunActivityTracker({ cwd, onChange: activityChanged });
  const runtime = new AtelierRuntime({
    pi, ctx, config: options.config ?? structuredClone(DEFAULT_CONFIG), autoCompact, enabled, requestRender: notify,
    ...(options.inspectWorkspace ? { inspectWorkspace: options.inspectWorkspace } : {}),
    ...(options.random ? { random: options.random } : {}),
  });

  const trusted = () => { try { return ctx.isProjectTrusted(); } catch { return false; } };
  const owns = (eventCtx: ExtensionContext | undefined) => {
    if (disposed || !eventCtx) return false;
    try { return eventCtx.sessionManager === sessionManager; } catch { return false; }
  };
  const alerts = (): string[] => {
    const list = [
      ...(modelAlert ? [modelAlert] : []),
      ...(compactionAlert ? [compactionAlert] : []),
      ...(trusted() ? [] : ["Untrusted project: Git/subagents blocked"]),
      ...promptrAlerts,
      ...(reportGap ? [STATUS_SOURCE_GAP_ALERT] : []),
    ];
    return list.slice(0, MAX_ALERTS);
  };
  const build = (): SidebarTelemetrySnapshot => {
    const sessionName = sessionManager.getSessionName();
    const sessionFile = sessionManager.getSessionFile();
    const activeTools = pi.getActiveTools();
    const extensionStatuses = alerts();
    return buildSidebarSnapshot({
      state: { ...runtime.getState(), extensionStatuses }, cwd,
      ...(sessionName ? { sessionName } : {}), ...(sessionFile ? { sessionFile } : {}),
      branchEntryCount: sessionManager.getBranch().length,
      activeToolCount: activeTools.length, availableToolCount: pi.getAllTools().length, activeToolNames: activeTools,
      extensionStatuses, runActivity: runActivity.getSnapshot(), todos,
      sidebarPanels: options.contributedPanels?.() ?? [],
    });
  };

  // Pi 0.87.1 `pi.on()` returns an unsubscribe function; handlers are removed on dispose.
  type Handler = (payload: any, eventCtx: ExtensionContext) => unknown;
  const on = (event: string, handler: Handler) => {
    const off = (pi.on as unknown as (name: string, fn: Handler) => (() => void) | undefined)(
      event, (payload, eventCtx) => {
        if (!owns(eventCtx)) return undefined;
        try { handler(payload, eventCtx); } catch { /* Observation must never fail a Pi lifecycle event. */ }
        return undefined;
      });
    if (typeof off === "function") unsubscribers.push(off);
  };

  on("agent_start", () => {
    modelAlert = undefined;
    runActivity.startRun();
    runtime.setActivity("working");
  });
  on("turn_start", (event: { turnIndex: number }) => {
    runActivity.startTurn(event.turnIndex);
    runtime.scheduleWorkspacePulseRefresh();
  });
  on("before_provider_request", () => { if (enabled) runActivity.startResponse(); });
  on("message_update", (event: { message: Parameters<typeof estimateTokens>[0] }) => {
    if (!enabled) return;
    const estimated = estimateTokens(event.message);
    if (estimated <= 0) return;
    streaming = true;
    try { runActivity.updateResponseEstimate(estimated); } finally { streaming = false; }
  });
  on("message_end", (event: { message: unknown }) => {
    const message = event.message;
    if (!isRecord(message)) return;
    if (message.role === "custom" && message.customType === "subagent-slash-result") runtime.observeSubagentMetadata(message.details);
    if (message.role === "toolResult" && enabled) {
      const next = todosFromToolResult(message);
      if (next) { todos = next; notify(); }
      return;
    }
    if (message.role !== "assistant") return;
    const usage = isRecord(message.usage) ? message.usage : undefined;
    runActivity.finishResponse(typeof usage?.output === "number" ? usage.output : 0);
    if (message.stopReason === "error") {
      const detail = typeof message.errorMessage === "string" ? message.errorMessage : "";
      modelAlert = alertText({ level: "error", text: `Model request failed${detail ? `: ${detail}` : ""}` });
      notify();
    }
  });
  on("tool_execution_start", (event: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }) => {
    runActivity.startTool(enabled ? event : { ...event, args: undefined });
  });
  on("tool_execution_end", (event: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }) => {
    runActivity.finishTool(event);
    runtime.scheduleWorkspacePulseRefresh();
  });
  on("agent_settled", (_event, eventCtx) => {
    if (!eventCtx.isIdle()) return;
    runActivity.settle();
    runtime.setActivity("ready");
    notify();
  });
  on("turn_end", () => {
    runtime.refreshUsage();
    // Never hold Pi's actionable turn boundary on a Git inspection.
    void runtime.flushWorkspacePulseRefresh();
  });
  for (const name of ["model_select", "thinking_level_select", "session_info_changed"] as const) on(name, () => runtime.refreshUsage());
  on("session_compact", () => { compactionAlert = undefined; runtime.refreshUsage(); notify(); });
  on("session_compact_failed", (event: { aborted: boolean }) => {
    if (event.aborted) return;
    compactionAlert = "Compaction failed";
    notify();
  });
  on("session_tree", (_event, eventCtx) => {
    if (!enabled) return;
    todos = reconstructTodos(eventCtx.sessionManager.getBranch());
    void runtime.refreshSubagentUsage();
    runtime.refreshUsage();
    notify();
  });
  on("session_shutdown", () => telemetry.dispose());

  const telemetry: SidebarTelemetry = {
    sessionId,
    snapshot() {
      if (disposed || !enabled) return inert;
      if (dirty) {
        try { cached = build(); } catch { cached = inert; }
        dirty = false;
      }
      return cached;
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isCurrent: (eventCtx) => !disposed && (eventCtx === undefined || owns(eventCtx)),
    isEnabled: () => enabled && !disposed,
    setEnabled(next) {
      if (disposed || enabled === next) return;
      enabled = next;
      runtime.setEnabled(next);
      if (!next) { runActivity.resetResponse(); todos = []; dirty = true; return; }
      todos = reconstructTodos(sessionManager.getBranch());
      notify();
    },
    isRunning: () => !disposed && enabled && runActivity.isRunning(),
    getConfig: () => runtime.getConfig(),
    setConfig(config) { if (!disposed) { runtime.setConfig(config); dirty = true; } },
    setPromptrAlerts(next) {
      if (disposed) return;
      promptrAlerts = next.map(alertText).filter(Boolean).slice(0, MAX_ALERTS);
      notify();
    },
    sources() {
      const suspended = disposed || !enabled;
      const pulse = runtime.getState().workspacePulse.status;
      const gated = (): TelemetrySourceState => suspended ? "suspended" : trusted() ? "available" : "untrusted";
      return {
        extensionStatuses: "unavailable",
        workspace: gated() === "available" && pulse === "unavailable" ? "unavailable" : gated(),
        subagents: gated(),
        autoCompact: autoCompact === null ? "unavailable" : "available",
      };
    },
    async refreshSubagentUsage() { if (!disposed && enabled) await runtime.refreshSubagentUsage(); },
    subagentUsage: () => (disposed || !enabled ? undefined : runtime.getState().subagentUsage) ?? emptySubagentUsage(),
    overlayLifetime: () => ({
      isActive: () => !disposed && enabled,
      register(cancel) {
        if (disposed) { try { cancel(); } catch { /* best-effort */ } return () => undefined; }
        overlayCancellations.add(cancel);
        return () => { overlayCancellations.delete(cancel); };
      },
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      const cleanup = (action: () => void) => { try { action(); } catch { /* Release every resource. */ } };
      for (const off of unsubscribers.splice(0)) cleanup(off);
      for (const cancel of [...overlayCancellations]) cleanup(cancel);
      overlayCancellations.clear();
      listeners.clear();
      clearTimeout(streamTimer);
      streamTimer = undefined;
      cleanup(() => runtime.dispose());
      cleanup(() => runActivity.reset());
      todos = [];
      promptrAlerts = [];
      cached = inert;
    },
  };
  if (enabled) void runtime.flushWorkspacePulseRefresh();
  return telemetry;
}
