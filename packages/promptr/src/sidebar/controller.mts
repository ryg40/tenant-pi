import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type AutocompleteItem, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { PasteGuard } from "../companion/view.mts";
import type { PendingQueue } from "../queue/pending.mts";
import { loadTrackerBinding, nodeBindingIoDeps } from "../tracking/binding-io.mts";
import { loadTrackingSnapshotForRepo } from "../tracking/cache.mts";
import { renderBoardLines } from "../tracking/gitea.mts";
import {
  panelTitle, PROMPTR_PANEL_IDS, sidebarTimeDependent, type SidebarRenderResult, type SidebarTelemetrySnapshot, type SidebarViewportState, type ThemeLike,
} from "./atelier-adapter.mts";
import {
  ABSENT_FINGERPRINT, applySidebarSettingsCommand, isPanelCollapsed, loadSidebarSettings, parseSidebarSettingsCommand,
  runSidebarSettingsCommand, saveSidebarSettings, setAllCollapsed, setPanelCollapsed, setSidebarWidthSetting, sidebarSettingsPath,
  SIDEBAR_SETTINGS_USAGE, type SettingsResult, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, type SidebarSettings, type SidebarSettingsState,
} from "./config.mts";
import { createRenderGuard } from "./render-guard.mts";
import { openPanelSettings } from "./settings.mts";
import { SidebarStore, type SidebarData } from "./store.mts";
import { attachSidebarTelemetry, type SidebarTelemetry, type SidebarTelemetryOptions } from "./telemetry.mts";
import { openPromptrUsage } from "./usage-dialog.mts";
import { nextPanelOffset, renderComposedSidebar, sidebarInput, type SidebarAction, type SidebarSnapshot } from "./view.mts";
import { createSidebarPanelRegistry, type SidebarPanelEventTransport, type SidebarPanelRegistry } from "./vendor/atelier/sidebar-panels.mts";
import { hasCapturingOverlay } from "./vendor/image-compositor.mts";
import { createSplitPaneController, MIN_MAIN_WIDTH, MIN_SIDEBAR_WIDTH, UNSUPPORTED_LAYOUT_MESSAGE } from "./vendor/split-pane.mts";

/** What `/promptr status` names as the running sidebar; the pin is recorded in docs/atelier-adaptation.md. */
export const SIDEBAR_IMPLEMENTATION = "Promptr sidebar adapted from pi-atelier v0.12.0 (MIT), in-process; no Herdr companion";
export const SIDEBAR_MODE_NOTICE = "The Promptr sidebar needs interactive Pi (terminal UI). Nothing was shown, saved or sent.";
const NARROW_COLUMNS = MIN_MAIN_WIDTH + MIN_SIDEBAR_WIDTH;
export const FOREIGN_OVERLAY_NOTICE = "Promptr: another extension's overlay is open. Nothing was opened or changed; try again after it closes.";
/** `/promptr` subcommands offered by argument completion. */
const PROMPTR_SUBCOMMANDS: readonly (readonly [string, string])[] = [
  ["on", "show the sidebar"], ["off", "hide the sidebar"], ["toggle", "show or hide"], ["focus", "focus the sidebar"],
  ["panels", "panel settings screen"], ["panel", "<name> on|off"], ["move", "<name> <position>"],
  ["collapse", "<name>|all to one row"], ["expand", "<name>|all"], ["fold", "<name>: collapse or expand"],
  ["startup", "on|off"], ["width", `${SIDEBAR_WIDTH_MIN}-${SIDEBAR_WIDTH_MAX}`], ["resize", "drag or arrows"],
  ["usage", "subagent cost view"], ["workspace", "full hosted view"], ["status", "state and settings path"], ["help", "usage"],
];
export const SIDEBAR_HELP = `/promptr [on|off|toggle|focus|width ${SIDEBAR_WIDTH_MIN}-${SIDEBAR_WIDTH_MAX}|resize|usage|workspace|status]`
  + ` · ${SIDEBAR_SETTINGS_USAGE} · /coordinatr is the same sidebar · /coordinatr-herdr opens the legacy Herdr companion`;

export interface SidebarHooks {
  attempts: Set<string>;
  /** `isCurrent` turns false on session change or when another extension's dialog opens; stop at the next boundary. */
  workspace(ctx: ExtensionContext, isCurrent: () => boolean): Promise<void>;
  review(ctx: ExtensionContext, queue: PendingQueue, isCurrent: () => boolean): Promise<unknown>;
  refresh(cwd: string): Promise<string[]>;
  record(cwd: string, before: PendingQueue, after: PendingQueue, note?: string): void;
  /** Test seam; defaults to attachSidebarTelemetry. */
  attachTelemetry?(options: SidebarTelemetryOptions): SidebarTelemetry;
}

/** Local actions delegate to SidebarStore and hooks.review (explicit one-item send); never auto-send. */
export interface SidebarActionBoundary {
  run(action: SidebarAction): Promise<void>;
}

type InputResult = { consume?: boolean; data?: string } | undefined;
/** While a turn runs, telemetry changes per streamed token; the sidebar rebuilds at most this often. */
const WORKING_REBUILD_MS = 250;
const sameKey = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const plainTheme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
const message = (error: unknown) => (error instanceof Error ? error.message : "Sidebar action failed");

/**
 * Subagent graph graphics for one render. A visible capturing dialog suspends the plot,
 * which keeps its rows; the sidebar's own overlay is non-capturing. Unknown renderers also suspend.
 */
export function sidebarChartGraphics(tui: Parameters<typeof hasCapturingOverlay>[0], imageOwner: object) {
  return { imageOwner, suspendPlot: hasCapturingOverlay(tui) };
}

type HideOverlayHost = { hideOverlay(): void };
type OverlayStackHost = { overlayStack?: unknown };

/** Entries of the renderer's overlay stack, or undefined when the renderer does not expose them. */
function overlayEntries(tui: TUI | undefined): readonly unknown[] | undefined {
  const stack = (tui as OverlayStackHost | undefined)?.overlayStack;
  return Array.isArray(stack) ? stack : undefined;
}

const RENDERER_PROBE = Symbol("promptr.renderer");

/**
 * The renderer object behind `tui`, or undefined when it cannot be reached safely. Pi 0.87.1 gives extensions
 * a stable Proxy (`createInteractiveTuiReference`): each read returns a fresh forwarding function, writes go to
 * the current renderer, and it has no own-property or delete traps. A method called through it runs with
 * `this` bound to the current renderer, so a temporary symbol-keyed method returns that object; the probe is
 * then deleted from it. A raw renderer returns itself. The result is accepted only when the probe is visible
 * as its own property, i.e. property identity, descriptors and delete behave normally on it.
 */
function currentRenderer(tui: TUI): object | undefined {
  const host = tui as unknown as Record<symbol, unknown>;
  const probe = function (this: unknown) { return this; };
  let target: unknown;
  try {
    host[RENDERER_PROBE] = probe;
    target = (host[RENDERER_PROBE] as () => unknown)();
  } catch { target = undefined; }
  const real = typeof target === "object" && target !== null
    && Object.getOwnPropertyDescriptor(target, RENDERER_PROBE)?.value === probe ? target : undefined;
  try {
    if (real) delete (real as Record<symbol, unknown>)[RENDERER_PROBE];
    else host[RENDERER_PROBE] = undefined;
  } catch { /* best effort; a symbol key is invisible to Pi */ }
  return real;
}

/**
 * Pi 0.87.1 completes a `ctx.ui.custom(..., { overlay: true })` interaction by calling `tui.hideOverlay()`,
 * which pops the TOP overlay even when it belongs to another extension. During this overlay's own
 * completion only, route that single synchronous call to this overlay's `OverlayHandle.hide()`
 * (removal by identity), then restore the previous method exactly. A completion before the overlay was
 * shown removes nothing. No other overlay operation is patched and nothing outlives the call.
 *
 * The patch is applied to the renderer object that is current at completion (Pi calls `hideOverlay` on the
 * current renderer), never through Pi's stable proxy: its reads have no identity and it cannot delete. If the
 * renderer cannot be reached, completion is left to Pi unchanged. A routing function that outlives its call
 * (someone replaced it meanwhile) forwards to the previous method, so a leak can never swallow `hideOverlay`.
 */
function completeOwnedOverlay(tui: TUI, handle: () => OverlayHandle | undefined, complete: () => void): void {
  const renderer = currentRenderer(tui);
  if (!renderer) { complete(); return; }
  const host = renderer as HideOverlayHost;
  const hadOwn = Object.prototype.hasOwnProperty.call(host, "hideOverlay");
  const previous = host.hideOverlay;
  let routing = true;
  const removeOwn = () => {
    if (!routing) return Reflect.apply(previous, renderer, []);
    routing = false;
    handle()?.hide();
  };
  host.hideOverlay = removeOwn;
  try { complete(); }
  finally {
    routing = false;
    if (host.hideOverlay === removeOwn) {
      if (hadOwn) host.hideOverlay = previous;
      else delete (host as Partial<HideOverlayHost>).hideOverlay;
    }
  }
}

export interface OwnedOverlayOptions {
  /** Result delivered when the overlay is cancelled because another overlay is present. */
  cancelValue?: unknown;
  /** Called once, before the cancelled result is delivered. */
  onBlocked?(tui: TUI): void;
  /** Called with the renderer each time an overlay starts. */
  onTui?(tui: TUI): void;
}

/**
 * A UI whose overlay `custom()` interactions (a) remove only their own overlay on completion and (b) never
 * stay mounted above any other overlay entry, capturing or passive. The stack is checked when the factory
 * runs and again at `onHandle`, right after Pi shows the overlay; a foreign overlay shown in between cancels
 * the interaction there: the own entry is removed by identity and the promise resolves with `cancelValue`.
 * Non-overlay calls pass through unchanged.
 */
export function ownedOverlayUi<U extends Pick<ExtensionUIContext, "custom">>(ui: U, policy: OwnedOverlayOptions = {}): U {
  const custom: ExtensionUIContext["custom"] = (factory, options) => {
    if (!options?.overlay) return ui.custom(factory, options);
    let handle: OverlayHandle | undefined;
    let host: TUI | undefined;
    let finish: ((result: unknown) => void) | undefined;
    let blocked = false;
    const block = () => {
      if (blocked || !host) return;
      blocked = true;
      try { policy.onBlocked?.(host); } finally { finish?.(policy.cancelValue); }
    };
    const others = (tui: TUI | undefined, own: number) => (overlayEntries(tui)?.length ?? 0) > own;
    return ui.custom((tui, theme, keybindings, done) => {
      host = tui;
      policy.onTui?.(tui);
      finish = (result) => completeOwnedOverlay(tui, () => handle, () => (done as (value: unknown) => void)(result));
      if (others(tui, 0)) {
        // Not shown yet: completing now removes nothing, and Pi never shows a closed interaction.
        block();
        return { render: () => [], invalidate() {} };
      }
      return factory(tui, theme, keybindings, (result) => finish!(result));
    }, { ...options, onHandle: (next) => {
      handle = next;
      if (blocked) return;
      if (others(host, 1)) { block(); return; }
      options.onHandle?.(next);
    } });
  };
  const owned = Object.create(ui) as U;
  Object.defineProperty(owned, "custom", { value: custom, configurable: true, enumerable: true, writable: true });
  return owned;
}

/** Cached tracker summary only: no network. An untrusted project does not run `git remote` to infer a binding. */
/** Cached tracker lines, and the open issue count (Tasks badge) when a snapshot exists. */
function cachedTracking(cwd: string, trackingFile: string, trusted: boolean): { lines: string[]; open?: number } {
  try {
    const deps = trusted ? nodeBindingIoDeps : { ...nodeBindingIoDeps, gitRemote: () => undefined };
    const binding = loadTrackerBinding(cwd, process.env, deps);
    const cached = loadTrackingSnapshotForRepo(trackingFile, binding.resolution.ok ? binding.resolution.config.repo : undefined);
    if (cached) return { lines: renderBoardLines(cached, 4), open: Math.max(0, cached.overall.total - cached.overall.closed) };
    return { lines: [binding.resolution.ok ? "No snapshot / r to refresh" : "Tracker unbound / workspace to configure"] };
  } catch {
    return { lines: ["Tracker summary unavailable / r to refresh"] };
  }
}

export function registerSidebar(pi: ExtensionAPI, hooks: SidebarHooks) {
  let current: ReturnType<typeof createSession> | undefined;
  const dispose = () => { const session = current; current = undefined; session?.dispose(); };

  function createSession(ctx: ExtensionContext) {
    const sessionManager = ctx.sessionManager;
    const sessionId = sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const store = new SidebarStore(cwd);
    const aborter = new AbortController();
    /** One graphics owner per sidebar session (chartGraphics). */
    const imageOwner = {};
    // The settings preview is text-only under its own capturing dialog; it never shares the live graph owner.
    const previewOwner = {};
    let activeCtx = ctx;
    let disposed = false;
    let enabled = false;
    let focused = false;
    let busy = false;
    let attached = false;
    let selected = 0;
    let panelOffset = 0;
    let lastViewport: SidebarViewportState | undefined;
    let notice = "Local first / explicit send only";
    let activity = "Idle";
    try { activity = ctx.isIdle() ? "Idle" : "Working"; } catch { /* stale context */ }
    let generation = 0;
    let close: (() => void) | undefined;
    let closeDialog: (() => void) | undefined;
    let stopInput: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let columns = () => 0;
    let lastTheme: ThemeLike | undefined;
    let data: SidebarData | undefined;
    let tracking: string[] | undefined;
    let trackingOpen: number | undefined;
    /** Panel under the focused-sidebar cursor. Session state only. */
    let cursorId: string | undefined;
    let alertKey = "";
    let resizeFrom: number | undefined;
    let hostTui: TUI | undefined;
    let waitTimer: ReturnType<typeof setInterval> | undefined;
    let paste = new PasteGuard();

    const isCurrent = () => {
      if (disposed || current !== session) return false;
      try { return activeCtx.sessionManager === sessionManager && sessionManager.getSessionId() === sessionId; } catch { return false; }
    };
    const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
      try { activeCtx.ui.notify(text, level); } catch { /* stale context */ }
    };
    const report = (error: unknown) => {
      notice = message(error);
      notify(notice, "warning");
    };

    // One settings state per session; invalid files keep defaults in memory and block saves.
    let settings: SidebarSettingsState = loadSidebarSettings(sidebarSettingsPath());
    if (settings.error) notify(`Promptr sidebar settings: ${settings.error}`, "warning");

    const split = createSplitPaneController({
      defaultSidebarWidth: settings.settings.sidebarWidth,
      subscribeInput: (handler) => activeCtx.ui.onTerminalInput(handler),
      onError: report,
      onWarning: (text) => report(new Error(text)),
      // Persist only a finished resize; Esc, hide and dispose restore the start width and save nothing.
      onResizeChange: (resizing) => {
        if (resizing) { resizeFrom = split.getSidebarWidth(); return; }
        const from = resizeFrom;
        resizeFrom = undefined;
        if (from !== undefined && split.getSidebarWidth() !== from && isCurrent()) saveWidth(split.getSidebarWidth(), false);
      },
      onRenderRequest: (reason) => guard.count(`split:${reason}`),
    });

    // One telemetry runtime per session. It stays suspended (no Git, no accounting reads) while hidden.
    const telemetry = (hooks.attachTelemetry ?? attachSidebarTelemetry)({ pi, ctx, enabled: false });
    // Every sidebar request for a Pi frame goes through the guard: bounded rate, counted by source.
    const guard = createRenderGuard({
      flush: () => split.requestRender(),
      isWorking: () => activity === "Working" || telemetry.isRunning(),
      isResizing: () => split.isResizing(),
      warn: (text) => notify(text, "warning"),
    });
    const requestRender = (source: string, urgent = false) => guard.request(source, urgent);
    const stopTelemetry = telemetry.subscribe(() => { if (close) requestRender("telemetry"); });
    const events = (pi as { events?: Partial<SidebarPanelEventTransport> }).events;
    let registry: SidebarPanelRegistry | undefined;
    let registryVersion = 0;
    try {
      if (typeof events?.on === "function" && typeof events.emit === "function") {
        registry = createSidebarPanelRegistry({ events: events as SidebarPanelEventTransport,
          onChange: () => { registryVersion++; if (close) requestRender("panel-registry"); }, instanceId: `promptr-${sessionId}` });
        registry.requestDiscovery();
      }
    } catch { registry = undefined; }

    const applySettings = (state: SidebarSettingsState, keepOffset = false) => {
      settings = state;
      if (!keepOffset) panelOffset = 0;
      split.setSidebarWidth(state.settings.sidebarWidth);
      telemetry.setConfig({ ...telemetry.getConfig(), showSidebarToolNames: state.settings.showSidebarToolNames,
        showSidebarOnStartup: state.settings.showSidebarOnStartup,
        sidebarPanelLayout: state.settings.sidebarPanelLayout.map((entry) => ({ ...entry })) });
      requestRender("settings", true);
    };
    applySettings(settings);

    /** Save through the settings API against the file as it is now; a refused save changes nothing. */
    function saveWidth(width: number, announce: boolean): boolean {
      const fresh = loadSidebarSettings(settings.path);
      const next = fresh.error ? { ok: false as const, error: fresh.error } : setSidebarWidthSetting(fresh.settings, width);
      const saved = next.ok ? saveSidebarSettings(fresh, next.value, { isCurrent }) : next;
      if (!saved.ok) {
        split.setSidebarWidth(settings.settings.sidebarWidth);
        notify(`Promptr sidebar width not saved: ${saved.error}`, "warning");
        return false;
      }
      applySettings(saved.state);
      if (announce) notify(`Promptr sidebar width ${width}. Saved to ${settings.path}.`, "info");
      else notice = `Width ${width} saved`;
      return true;
    }

    /**
     * Collapse changes save at once against the file as it is now. A refused save (invalid file, conflict)
     * keeps the change in memory for this session and says so.
     */
    function changeCollapsed(apply: (base: SidebarSettings) => SettingsResult<SidebarSettings>, announce: boolean): void {
      const fresh = loadSidebarSettings(settings.path);
      const next = apply(fresh.error ? settings.settings : fresh.settings);
      if (!next.ok) { notify(`Promptr sidebar: ${next.error} Nothing changed.`, "warning"); return; }
      const saved = fresh.error ? { ok: false as const, error: fresh.error } : saveSidebarSettings(fresh, next.value, { isCurrent });
      if (!isCurrent()) return;
      if (saved.ok) {
        applySettings(saved.state, true);
        notice = next.message;
        if (announce) notify(`Promptr sidebar: ${next.message}. Saved.`, "info");
        return;
      }
      const local = apply(settings.settings);
      if (local.ok) { settings = { ...settings, settings: local.value }; requestRender("settings", true); }
      notice = `${next.message} for this session; settings not saved (${saved.error})`;
      notify(`Promptr sidebar: ${notice}`, "warning");
    }
    /** Shown, available panels in order, from the last render. */
    const cursorIds = () => lastViewport?.panelIds ?? [];
    const cursorPanel = () => {
      const ids = cursorIds();
      return cursorId !== undefined && ids.includes(cursorId) ? cursorId : lastViewport?.renderedIds[0] ?? ids[panelOffset];
    };
    const moveCursor = (delta: -1 | 1) => {
      const ids = cursorIds();
      if (!ids.length) return;
      const from = ids.indexOf(cursorPanel() ?? "");
      const index = Math.max(0, Math.min(ids.length - 1, (from < 0 ? 0 : from) + delta));
      cursorId = ids[index];
      // Page so the cursor panel is drawn; it becomes the first panel when it was outside the view.
      if (cursorId !== undefined && !lastViewport?.renderedIds.includes(cursorId)) panelOffset = index;
    };
    const foldCursor = () => {
      const id = cursorPanel();
      if (id === undefined) return;
      cursorId = id;
      changeCollapsed((base) => setPanelCollapsed(base, id as SidebarSettings["sidebarCollapsedPanels"][number], !isPanelCollapsed(base, id)), false);
    };
    const foldAll = () => {
      const current = settings.settings;
      const anyExpanded = current.sidebarPanelLayout.some((entry) => entry.visible && !isPanelCollapsed(current, entry.id));
      changeCollapsed((base) => setAllCollapsed(base, anyExpanded), false);
    };

    const contributed = (snapshot = telemetry.snapshot()): SidebarTelemetrySnapshot => {
      const panels = registry?.getAvailable();
      return panels && panels.length ? { ...snapshot, sidebarPanels: [...panels] } : snapshot;
    };
    const availableIds = () => [...PROMPTR_PANEL_IDS, ...(registry?.getAvailable() ?? []).map((panel) => panel.id)];
    /** Keeps the previous object when the store is unchanged, so its identity says whether anything changed. */
    const readData = () => {
      const next = store.read();
      if (data && isDeepStrictEqual(next, data)) return data;
      data = next;
      // Promptr workflow alerts: a corrupt queue is shown in ALERTS as well as in the Queue box.
      const key = data.error;
      if (key !== alertKey) { alertKey = key; telemetry.setPromptrAlerts(key ? [{ level: "error", text: key }] : []); }
      return data;
    };
    const snapshotData = (): SidebarSnapshot => {
      let model = "No model";
      let context = "context unknown";
      try {
        model = activeCtx.model?.id ?? model;
        const usage = activeCtx.getContextUsage();
        if (usage?.percent != null) context = `${Math.round(usage.percent)}% context`;
      } catch { /* stale context */ }
      // `git` stays empty: telemetry owns trusted workspace inspection (Workspace panel).
      return { ...(data ?? readData()), project: path.basename(cwd), model, activity, context, git: "",
        tracking: tracking ?? [], ...(trackingOpen === undefined ? {} : { trackingOpen }), focused, selected,
        attempted: hooks.attempts, busy, notice };
    };
    const renderLines = (width: number, height: number, theme: ThemeLike, chartGraphics: { imageOwner: object; suspendPlot: boolean },
      layout?: SidebarSettings["sidebarPanelLayout"], snapshot?: SidebarTelemetrySnapshot) =>
      renderComposedSidebar({
        telemetry: contributed(snapshot), data: snapshotData(), width, height, theme,
        settings: layout ? { ...settings.settings, sidebarPanelLayout: layout } : settings.settings,
        panelOffset: layout ? 0 : panelOffset,
        ...(!layout && focused && cursorId !== undefined ? { cursor: cursorId } : {}),
        chartGraphics,
      });
    /**
     * The mounted sidebar's lines, rebuilt only when an input changes. Promptr inputs (store data, focus,
     * selection, notice, size, theme, settings, offset, graphics, resize) rebuild at once. Telemetry, contributed
     * panels and elapsed-time text (1 s steps) rebuild at most every WORKING_REBUILD_MS while a turn runs.
     */
    let view: { local: readonly unknown[]; shared: readonly unknown[]; at: number; result: SidebarRenderResult } | undefined;
    const renderView = (width: number, height: number, theme: ThemeLike, chartGraphics: { imageOwner: object; suspendPlot: boolean }) => {
      const now = Date.now();
      const items = (data ?? readData()).queue.items;
      const local = [data, tracking, items.map((item) => (hooks.attempts.has(item.id) ? 1 : 0)).join(""), focused, selected, busy,
        notice, width, height, theme, settings.settings, panelOffset, cursorId, chartGraphics.imageOwner, chartGraphics.suspendPlot,
        split.isResizing()];
      const fresh = view !== undefined && sameKey(view.local, local);
      if (fresh && now - view!.at < WORKING_REBUILD_MS && (activity === "Working" || telemetry.isRunning())) return view!.result;
      const snapshot = telemetry.snapshot();
      const shared = [snapshot, registryVersion, sidebarTimeDependent(snapshot) ? Math.floor(now / 1000) : 0];
      if (fresh && sameKey(view!.shared, shared)) return view!.result;
      view = { local, shared, at: now, result: renderLines(width, height, theme, chartGraphics, undefined, snapshot) };
      return view.result;
    };

    /**
     * After Alt+P or Alt+Shift+P ends focus or hides the sidebar, the key may still be held.
     * Its repeats would reach Pi's shortcut again and toggle in a loop, so consume them until the key is released.
     */
    let stopSwallow: (() => void) | undefined;
    const swallowHeldKey = (keyId: "alt+p" | "alt+shift+p") => {
      stopSwallow?.();
      let stop: (() => void) | undefined;
      const done = () => {
        const current = stop;
        stop = undefined;
        if (stopSwallow === done) stopSwallow = undefined;
        try { current?.(); } catch { /* already released */ }
      };
      try {
        stop = activeCtx.ui.onTerminalInput((raw) => {
          if (matchesKey(raw, keyId) && (isKeyRepeat(raw) || isKeyRelease(raw))) {
            if (isKeyRelease(raw)) done();
            return { consume: true };
          }
          done();
          return undefined;
        });
      } catch { stop = undefined; }
      stopSwallow = done;
    };
    const releaseFocus = () => {
      focused = false;
      const stop = stopInput;
      stopInput = undefined;
      try { stop?.(); } catch { /* already released */ }
    };
    // Promptr's own overlays are gone whenever these run (the sidebar is unmounted or non-capturing, and
    // Promptr dialogs set `busy`), so any entry belongs to someone else.
    const foreignOverlayOpen = () => (overlayEntries(hostTui)?.length ?? 0) > 0;
    const foreignDialogOpen = () => hostTui !== undefined && overlayEntries(hostTui) !== undefined && hasCapturingOverlay(hostTui);
    // Input ownership exists only while focused; the mounted sidebar itself is passive.
    const onInput = (raw: string): InputResult => {
      if (!focused || busy || !enabled || !isCurrent()) { releaseFocus(); return undefined; }
      // Another extension's dialog keeps its keys and focus.
      if (foreignDialogOpen()) { releaseFocus(); requestRender("input", true); return undefined; }
      if (!split.isVisibleAtWidth(columns())) { releaseFocus(); requestRender("input", true); return undefined; }
      const { segments, dropped } = paste.consume(raw);
      if (dropped || segments.length !== 1) return { consume: true };
      const key = segments[0]!;
      // Kitty keyboard protocol: the key-up of the Alt+P that gave focus arrives here. Pi's editor ignores
      // release events; the sidebar must too, or the release ends focus at once.
      if (isKeyRelease(key)) return { consume: true };
      const repeat = isKeyRepeat(key);
      // Only the kitty protocol (CSI u) reports repeat and release; a legacy key has nothing to wait for.
      const kitty = /^\x1b\[[\d;:]+u$/.test(key);
      if (matchesKey(key, "alt+p")) {
        if (!repeat) { releaseFocus(); if (kitty) swallowHeldKey("alt+p"); requestRender("input", true); }
        return { consume: true };
      }
      if (matchesKey(key, "alt+shift+p")) {
        if (!repeat) { hide(); if (kitty) swallowHeldKey("alt+shift+p"); }
        return { consume: true };
      }
      const intent = sidebarInput(key, selected);
      // A held key repeats only movement (cursor, selection, paging); it never re-runs an action, fold or release.
      if (repeat && (intent.action || intent.fold || intent.foldAll || intent.release)) return { consume: true };
      selected = intent.selected;
      // Keys can arrive before the next coalesced render; page from the current offset.
      if (intent.scroll && lastViewport) panelOffset = nextPanelOffset({ ...lastViewport, panelOffset }, intent.scroll);
      if (intent.panel) moveCursor(intent.panel);
      if (intent.fold) foldCursor();
      if (intent.foldAll) foldAll();
      if (intent.release) releaseFocus();
      if (intent.action) void run(intent.action);
      requestRender("input", true);
      return { consume: true };
    };
    const takeFocus = () => {
      if (focused) return;
      focused = true;
      // The panel cursor starts on the first panel in view each time the sidebar gets focus.
      cursorId = lastViewport?.renderedIds[0];
      // Each focus starts with a fresh parser: a lone Esc that released the last focus must not join a later
      // `[` into a held `ESC[` paste prefix. Only a still-open bracketed paste carries over, so its
      // remaining bytes stay dropped.
      if (!paste.active) paste = new PasteGuard();
      try { stopInput = activeCtx.ui.onTerminalInput(onInput); }
      catch (error) { focused = false; report(error); }
      requestRender("focus", true);
    };

    const unmount = () => {
      generation++;
      const finish = close;
      close = undefined;
      releaseFocus();
      if (timer) clearInterval(timer);
      timer = undefined;
      try { finish?.(); } catch { /* already closed */ }
      split.hide();
    };
    const stopWaiting = () => {
      if (waitTimer) clearInterval(waitTimer);
      waitTimer = undefined;
    };
    /** Never stack the passive sidebar above another overlay: Pi's pop-top completion would remove the wrong one. */
    const waitForOverlays = () => {
      if (waitTimer) return;
      waitTimer = setInterval(() => {
        if (!isCurrent() || !enabled) { stopWaiting(); return; }
        if (busy || close || foreignOverlayOpen()) return;
        stopWaiting();
        mount();
      }, 250);
      waitTimer.unref?.();
    };
    const hide = () => {
      enabled = false;
      stopWaiting();
      telemetry.setEnabled(false);
      unmount();
    };

    const blockedNotice = () => notify(FOREIGN_OVERLAY_NOTICE, "info");
    const recordTui = (tui: TUI) => { hostTui = tui; };
    /** Session guard for multi-step flows: false after session change or once another extension's dialog is open. */
    const flowIsCurrent = () => isCurrent() && !foreignDialogOpen();
    /**
     * Context for Promptr-started flows. Native dialogs return their Esc result without opening while another
     * extension's dialog is open (they would take its focus); overlays are ownership-aware and never mount
     * above another overlay. Every other context member is inherited unchanged.
     */
    const guardedCtx = (cancelValue?: unknown): ExtensionContext => {
      const base = activeCtx.ui;
      const ui = ownedOverlayUi(base, { cancelValue, onTui: recordTui, onBlocked: blockedNotice });
      const guard = <T,>(cancelled: T, open: () => Promise<T>): Promise<T> => {
        if (!foreignDialogOpen()) return open();
        blockedNotice();
        return Promise.resolve(cancelled);
      };
      Object.defineProperties(ui, {
        select: { value: ((...args: Parameters<ExtensionUIContext["select"]>) => guard(undefined, () => base.select(...args))) as ExtensionUIContext["select"] },
        confirm: { value: ((...args: Parameters<ExtensionUIContext["confirm"]>) => guard(false, () => base.confirm(...args))) as ExtensionUIContext["confirm"] },
        input: { value: ((...args: Parameters<ExtensionUIContext["input"]>) => guard(undefined, () => base.input(...args))) as ExtensionUIContext["input"] },
        editor: { value: ((...args: Parameters<ExtensionUIContext["editor"]>) => guard(undefined, () => base.editor(...args))) as ExtensionUIContext["editor"] },
      });
      const ctx = Object.create(activeCtx) as ExtensionContext;
      Object.defineProperty(ctx, "ui", { value: ui, enumerable: true });
      return ctx;
    };
    /** Close the dialog on dispose. Pi's select/confirm take the abort signal; openPanelSettings needs its done callback. */
    const dialogUi = (): Pick<ExtensionUIContext, "custom"> => ({
      custom: (factory, options) => ownedOverlayUi(activeCtx.ui, { cancelValue: { saved: false }, onTui: recordTui, onBlocked: blockedNotice })
        .custom((tui, theme, keys, done) => {
          closeDialog = () => (done as (result: unknown) => void)({ saved: false });
          return factory(tui, theme, keys, (result) => { closeDialog = undefined; done(result); });
        }, options),
    });
    const openPanels = async () => {
      const state = loadSidebarSettings(settings.path);
      const result = await openPanelSettings(dialogUi(), {
        state,
        availableIds,
        viewport: () => lastViewport,
        preview: (layout, width, height) => renderLines(width, height, lastTheme ?? plainTheme, { imageOwner: previewOwner, suspendPlot: true }, layout).lines,
        isCurrent,
      });
      closeDialog = undefined;
      if (result.saved && isCurrent()) { applySettings(result.state); notice = "Panel settings saved"; }
    };

    const run = async (action: SidebarAction) => {
      if (busy || !isCurrent()) return;
      // Entry guard: native dialogs never open over a foreign dialog. Each flow rechecks at its own boundary.
      if (foreignDialogOpen()) { blockedNotice(); return; }
      busy = true;
      // Finish the passive overlay before any dialog; it is remounted in `finally`.
      unmount();
      try {
        // Promptr overlays (panels, usage) never open above any foreign overlay, passive ones included.
        if ((action === "panels" || action === "usage") && foreignOverlayOpen()) { blockedNotice(); return; }
        const before = readData();
        const flowCtx = guardedCtx();
        if (action === "compose" || action === "note") {
          const kind = action === "compose" ? "composer" : "note";
          const text = await flowCtx.ui.editor(action === "compose" ? "Promptr draft (save only; never sends)" : "Project notebook (ASCII + LF)", before[kind]);
          if (text !== undefined && isCurrent()) {
            store.saveText(kind, before[kind], text);
            if (kind === "note") hooks.record(cwd, before.queue, before.queue, text);
            notice = "Saved locally";
          }
        } else if (action === "queue") {
          const after = store.queueDraft();
          hooks.record(cwd, before.queue, after);
          notice = "Queued / draft retained / nothing sent";
        } else if (action === "remove") {
          if (before.error) throw new Error(before.error);
          if (!before.queue.items.length) { notice = "Queue is empty; nothing removed"; return; }
          const labels = before.queue.items.map((item, i) => `${i + 1}. ${item.text.replaceAll("\n", " ").slice(0, 70)}`);
          const choice = await flowCtx.ui.select("Remove ONE queued prompt (Esc cancels)", labels, { signal: aborter.signal });
          const item = choice === undefined ? undefined : before.queue.items[labels.indexOf(choice)];
          if (item && isCurrent() && await flowCtx.ui.confirm("Remove queued prompt?", "The draft and notebook stay unchanged.", { signal: aborter.signal }) && isCurrent()) {
            const after = store.remove(item.id, before.queue.revision);
            hooks.record(cwd, before.queue, after);
            notice = "Removed from queue";
          }
        } else if (action === "review") {
          if (before.error) throw new Error(before.error);
          if (!before.queue.items.length) { notice = "Queue is empty. Compose (c) and queue (q) first; nothing sent."; notify(notice, "info"); return; }
          await hooks.review(flowCtx, before.queue, flowIsCurrent);
          if (isCurrent() && foreignDialogOpen()) notify("Promptr: another extension's dialog opened; review stopped at the next step.", "info");
        } else if (action === "refresh") {
          const lines = await hooks.refresh(cwd);
          if (isCurrent()) {
            tracking = lines;
            let trusted = false;
            try { trusted = activeCtx.isProjectTrusted(); } catch { /* untrusted */ }
            trackingOpen = cachedTracking(cwd, store.paths.tracking, trusted).open;
            notice = "Tracker refreshed";
          }
        } else if (action === "panels") {
          await openPanels();
        } else if (action === "usage") {
          // The vendored usage view opens after an asynchronous refresh; its mount boundary is rechecked there.
          await openPromptrUsage(guardedCtx(undefined), telemetry);
        } else {
          await hooks.workspace(flowCtx, flowIsCurrent);
          if (isCurrent() && foreignDialogOpen()) notify("Promptr: another extension's dialog opened; the workspace stopped at its next step.", "info");
        }
      } catch (error) { if (isCurrent()) report(error); }
      finally {
        busy = false;
        closeDialog = undefined;
        if (isCurrent()) { readData(); if (enabled) mount(); }
      }
    };

    const mount = () => {
      if (disposed || busy || close || !enabled || !isCurrent()) return;
      if (foreignOverlayOpen()) { waitForOverlays(); return; }
      stopWaiting();
      const epoch = ++generation;
      split.show();
      try {
        // Checked at the factory (first mount: the stack was unknown) and again at onHandle, after Pi shows it.
        const deferMount = () => {
          if (generation !== epoch) return;
          generation++;
          close = undefined;
          releaseFocus();
          if (timer) clearInterval(timer);
          timer = undefined;
          split.hide();
          waitForOverlays();
        };
        const pending = ownedOverlayUi(activeCtx.ui, { onTui: recordTui, onBlocked: deferMount }).custom<void>((tui, theme, _keys, done) => {
          split.attach(tui);
          attached = true;
          columns = () => tui.terminal.columns;
          const themed = theme as unknown as ThemeLike;
          lastTheme = themed;
          close = () => done(undefined);
          // Store poll: a frame only when queue, draft, notebook or error changed on disk.
          timer = setInterval(() => {
            if (!isCurrent() || !close) return;
            const previous = data;
            if (readData() !== previous) requestRender("store-poll");
          }, 1500);
          timer.unref?.();
          return {
            invalidate() {},
            render(width) {
              if (focused && !split.isVisibleAtWidth(tui.terminal.columns)) releaseFocus();
              // A capturing dialog above the sidebar suspends the plot but keeps its rows.
              const result = renderView(width, split.getSidebarHeight(), themed, sidebarChartGraphics(tui, imageOwner));
              lastViewport = result.viewport;
              panelOffset = result.viewport.panelOffset;
              return result.lines;
            },
          };
        }, { overlay: true, overlayOptions: () => split.overlayOptions() });
        void pending.catch((error) => { if (isCurrent()) report(error); }).finally(() => {
          if (generation !== epoch) return;
          // Closed by Pi rather than by Promptr: treat it as hidden.
          hide();
        });
      } catch (error) { hide(); report(error); }
    };
    const show = () => {
      if (!isCurrent()) return;
      if (!enabled) { enabled = true; telemetry.setEnabled(true); }
      if (!tracking) {
        let trusted = false;
        try { trusted = activeCtx.isProjectTrusted(); } catch { /* untrusted */ }
        const cached = cachedTracking(cwd, store.paths.tracking, trusted);
        tracking = cached.lines;
        trackingOpen = cached.open;
      }
      readData();
      mount();
    };
    const focus = () => {
      if (busy || !isCurrent()) return;
      if (focused) { releaseFocus(); requestRender("focus", true); return; }
      if (!enabled) show();
      if (!close || foreignDialogOpen()) {
        if (waitTimer || foreignDialogOpen()) notify("Promptr sidebar is waiting for another overlay to close.", "info");
        return;
      }
      if (attached && !split.isLayoutSupported()) { notify(UNSUPPORTED_LAYOUT_MESSAGE, "info"); return; }
      if (!split.isVisibleAtWidth(columns())) {
        notify(`Promptr sidebar is hidden below ${NARROW_COLUMNS} columns. Use /promptr workspace for the full-screen view.`, "info");
        return;
      }
      takeFocus();
    };
    const status = () => {
      const s = settings.settings;
      const layout = s.sidebarPanelLayout;
      const on = layout.filter((entry) => entry.visible).length;
      const width = columns();
      const view = !enabled ? "hidden" : busy ? "on (dialog open)" : waitTimer ? "on (waiting for another overlay to close)"
        : !attached || close === undefined ? "on (not mounted)" : "shown";
      const layoutLine = !attached ? "Layout: not checked yet (sidebar not mounted in this session)"
        : !split.isLayoutSupported() ? `Layout: unsupported. ${UNSUPPORTED_LAYOUT_MESSAGE}`
          : split.isVisibleAtWidth(width) ? `Layout: recognized; terminal ${width} columns`
            : `Layout: recognized; terminal ${width} columns is below ${NARROW_COLUMNS}, so the sidebar is not drawn`;
      const guardStats = guard.stats();
      const requesters = Object.entries(guardStats.bySource).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([source, count]) => `${source} ${count}`).join(", ");
      const overflow = !lastViewport ? "Overflow: not rendered yet"
        : lastViewport.overflow ? `Overflow: ${lastViewport.above.length} panel(s) above, ${lastViewport.below.length} below (PgUp/PgDn or [ ] while focused)`
          : "Overflow: none";
      return [
        `Promptr sidebar: ${view}${focused ? ", focused" : ""}`,
        `Implementation: ${SIDEBAR_IMPLEMENTATION}`,
        `Width: ${split.getSidebarWidth()} (saved ${s.sidebarWidth}; ${SIDEBAR_WIDTH_MIN}-${SIDEBAR_WIDTH_MAX})`,
        `Settings: ${settings.path}${settings.error ? ` (invalid, defaults in use, saving blocked: ${settings.error})`
          : settings.fingerprint === ABSENT_FINGERPRINT ? " (not created yet; defaults in use)" : ""}`,
        `Startup: ${s.showSidebarOnStartup ? "shows the sidebar" : "stays hidden"}`,
        on === 0 ? `Panels: all ${layout.length} off. Restore with /promptr panels` : `Panels: ${on} of ${layout.length} on, ${layout.length - on} off`,
        s.sidebarCollapsedPanels.length ? `Collapsed: ${s.sidebarCollapsedPanels.join(", ")} (/promptr-expand <name>|all)` : "Collapsed: none",
        overflow,
        layoutLine,
        `Render requests: ${guardStats.requests}, ${guardStats.flushed} sent to Pi${guardStats.throttled ? " (throttled)" : ""}`
          + `${requesters ? `; top: ${requesters}` : ""}`,
        "Extension statuses: footer-only; not shown in the sidebar",
        "Legacy Herdr companion: /coordinatr-herdr (never started by the sidebar)",
      ].join("\n");
    };

    const session = {
      sessionId,
      matches(next: ExtensionContext) {
        try { return next.sessionManager === sessionManager && next.cwd === cwd && next.sessionManager.getSessionId() === sessionId; }
        catch { return false; }
      },
      startup() {
        if (settings.settings.showSidebarOnStartup) show();
      },
      run: run satisfies SidebarActionBoundary["run"],
      show, hide, focus,
      update(next: ExtensionContext, state?: string) {
        activeCtx = next;
        if (state) activity = state;
        if (enabled && !busy && close) { readData(); requestRender("session-event"); }
      },
      /** Layout and collapse state for slash-command completions. */
      completionSettings: () => settings.settings,
      async command(args: string) {
        const parsed = parseSidebarSettingsCommand(args);
        if (parsed?.ok && parsed.command.kind === "collapse") {
          const command = parsed.command;
          changeCollapsed((base) => applySidebarSettingsCommand(base, command), true);
          return;
        }
        const outcome = runSidebarSettingsCommand(args, { file: settings.path, isCurrent });
        if (outcome?.kind === "open-panels") { await run("panels"); return; }
        if (outcome?.kind === "saved") { applySettings(outcome.state); notify(`Promptr sidebar: ${outcome.message}`, "info"); return; }
        if (outcome?.kind === "error") { notify(`Promptr sidebar: ${outcome.message}`, "warning"); return; }
        const [rawVerb, value, ...extra] = args.trim().split(/\s+/).filter(Boolean);
        const verb = rawVerb?.toLowerCase() ?? "";
        if (verb === "" || verb === "on" || verb === "show") show();
        else if (verb === "off" || verb === "hide") hide();
        else if (verb === "toggle") { if (enabled) hide(); else show(); }
        else if (verb === "focus") focus();
        else if (verb === "width") {
          if (value !== undefined && /^\d+$/.test(value) && !extra.length) saveWidth(Number(value), true);
          else notify(`Usage: /promptr width ${SIDEBAR_WIDTH_MIN}-${SIDEBAR_WIDTH_MAX}. Nothing changed.`, "warning");
        } else if (verb === "resize") {
          show();
          if (attached && !split.isLayoutSupported()) notify(UNSUPPORTED_LAYOUT_MESSAGE, "info");
          else if (close) split.beginResize();
        }
        else if (verb === "usage") await run("usage");
        else if (verb === "workspace") await run("workspace");
        else if (verb === "status") notify(status(), "info");
        else if (verb === "help") notify(SIDEBAR_HELP, "info");
        else notify(`Unknown /promptr option "${rawVerb}". ${SIDEBAR_HELP}`, "warning");
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        aborter.abort();
        const dialog = closeDialog;
        closeDialog = undefined;
        try { dialog?.(); } catch { /* already closed */ }
        enabled = false;
        stopWaiting();
        unmount();
        stopSwallow?.();
        const cleanup = (action: () => void) => { try { action(); } catch { /* release every resource */ } };
        cleanup(stopTelemetry);
        cleanup(() => guard.dispose());
        cleanup(() => telemetry.dispose());
        cleanup(() => registry?.dispose());
        cleanup(() => split.dispose());
      },
    };
    return session;
  }

  /** The current TUI session's sidebar, recreated when the session or project changes. */
  const ensure = (ctx: ExtensionContext, quiet = false) => {
    if (ctx.mode !== "tui") { if (!quiet) ctx.ui.notify(SIDEBAR_MODE_NOTICE, "info"); return undefined; }
    if (current && !current.matches(ctx)) dispose();
    if (!current) {
      try { current = createSession(ctx); }
      catch (error) { ctx.ui.notify(`Promptr sidebar could not start: ${message(error)}`, "warning"); return undefined; }
    }
    current.update(ctx);
    return current;
  };
  /** Events never create a sidebar in non-TUI modes and never revive one after shutdown. */
  const follow = (ctx: ExtensionContext, state?: string) => {
    if (!current) return;
    if (current.matches(ctx)) { current.update(ctx, state); return; }
    dispose();
  };
  /** Completions read the live session's settings, or the file when no sidebar session exists yet. */
  const completionSettings = (): SidebarSettings => current?.completionSettings() ?? loadSidebarSettings(sidebarSettingsPath()).settings;
  const panelCompletions = (prefix: string, withAll: boolean, lead = ""): AutocompleteItem[] | null => {
    try {
      const s = completionSettings();
      const wanted = prefix.trim().toLowerCase();
      const items: AutocompleteItem[] = [
        ...(withAll ? [{ value: `${lead}all`, label: "all", description: "every shown panel" }] : []),
        ...s.sidebarPanelLayout.map((entry) => {
          const name = entry.id.startsWith("promptr:") ? entry.id.slice("promptr:".length) : entry.id;
          const state = isPanelCollapsed(s, entry.id) ? "▸ folded" : "▾ open";
          return { value: `${lead}${name}`, label: name, description: `${panelTitle(entry.id)} · ${state}${entry.visible ? "" : " · hidden"}` };
        }),
      ].filter((item) => item.label.toLowerCase().startsWith(wanted));
      return items.length ? items : null;
    } catch { return null; }
  };
  for (const name of ["promptr", "coordinatr"]) pi.registerCommand(name, {
    description: name === "promptr"
      ? "Promptr sidebar: on|off|toggle|focus|width|resize|panels|collapse|expand|fold|usage|workspace|status (explicit sends only)"
      : "Promptr sidebar (same as /promptr); /coordinatr-herdr opens the legacy Herdr companion",
    getArgumentCompletions: (prefix) => {
      const [verb, ...rest] = prefix.trimStart().split(/\s+/);
      if (rest.length === 0) {
        const wanted = (verb ?? "").toLowerCase();
        const items = PROMPTR_SUBCOMMANDS.filter(([sub]) => sub.startsWith(wanted)).map(([sub, description]) => ({ value: sub, label: sub, description }));
        return items.length ? items : null;
      }
      const sub = verb!.toLowerCase();
      if (rest.length === 1 && (sub === "collapse" || sub === "expand" || sub === "fold" || sub === "panel" || sub === "move"))
        return panelCompletions(rest[0]!, sub === "collapse" || sub === "expand", `${sub} `);
      return null;
    },
    handler: async (args, ctx) => { await ensure(ctx)?.command(args); },
  });
  // Collapse commands appear in Pi's `/` menu. They save the state and never show a hidden sidebar.
  for (const [name, verb, description] of [
    ["promptr-collapse", "collapse", "Collapse a Promptr sidebar panel to one row: <name>|all (saved)"],
    ["promptr-expand", "expand", "Expand a collapsed Promptr sidebar panel: <name>|all (saved)"],
    ["promptr-fold", "fold", "Collapse or expand one Promptr sidebar panel: <name> (saved)"],
  ] as const) pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) => panelCompletions(prefix, verb !== "fold"),
    handler: async (args, ctx) => {
      if (!args.trim()) { ctx.ui.notify(`Usage: /${name} ${verb === "fold" ? "<name>" : "<name>|all"}. Nothing changed.`, "warning"); return; }
      await ensure(ctx)?.command(`${verb} ${args.trim()}`);
    },
  });
  // F6 stays unclaimed: Atelier's default shortcut is not registered here.
  pi.registerShortcut("alt+p", { description: "Focus the Promptr sidebar / return to Pi", handler: async (ctx) => { ensure(ctx)?.focus(); } });
  pi.registerShortcut("alt+shift+p", { description: "Show or hide the Promptr sidebar", handler: async (ctx) => { await ensure(ctx)?.command("toggle"); } });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    dispose();
    ensure(ctx, true)?.startup();
  });
  pi.on("session_shutdown", dispose);
  pi.on("session_tree", (_event, ctx) => follow(ctx));
  pi.on("agent_start", (_event, ctx) => follow(ctx, "Working"));
  pi.on("agent_settled", (_event, ctx) => follow(ctx, "Idle"));
  pi.on("model_select", (_event, ctx) => follow(ctx));
  return { dispose };
}
