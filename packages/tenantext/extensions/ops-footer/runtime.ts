import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { anthropicStatus, codexStatus, copilotStatus, HealthAdapter, integrationStatus, languageStatus, publicStatuses, unknown } from "./adapters.ts";
import { collectSession } from "./collector.ts";
import { GitAdapter } from "./git.ts";
import { MemoryTracker, vikingCounters } from "./memory.ts";
import { themePaint } from "./paint.ts";
import { defaultLayout, hasRowsAbove, isLayoutName, layoutNames, layouts, type LayoutName } from "./layouts/index.ts";
import { detailedReport, FooterRenderer } from "./render.ts";
import { defaults, ensureSettings, loadSettings, saveSettings, settingsPath, type Settings } from "./settings.ts";
import { ANTHROPIC_REFRESH, ANTHROPIC_STATUS, CODEX_REFRESH, CODEX_STATUS, COPILOT_REFRESH, COPILOT_STATUS, INTEGRATION_STATUS, OWNERSHIP, OWNERSHIP_QUERY,
  type AgentState, type ContextService, type DashboardSnapshot, type IntegrationSnapshot, type IntegrationSource } from "./types.ts";

export interface RuntimeDependencies {
  context: (pi: ExtensionAPI) => ContextService;
  load?: () => Promise<Settings>;
  save?: (settings: Settings) => Promise<void>;
  git?: (settings: Settings) => GitAdapter;
  health?: () => HealthAdapter;
}
const HELP = "/ops-footer [report|on|off|refresh|settings|save|layout v4|v3|v2|a|b|c|help]\nOff restores Pi's default footer, not an earlier custom footer.\nlayout switches the row composition for this session only; v4 is the default with every row below the editor, v3 puts the directory row and the bar above the editor, v2 is the bar-first footer, a, b, and c are prototype layouts.\nOnly one extension can own the footer. Disable Powerline's footer before enabling this footer.";

const TOP_WIDGET = "ops-footer-top";
/**
 * How much longer one fetch of a quota source can take than the fetch before it. `codex-accounts` stops a collection after
 * 16 seconds. A Claude or Copilot probe stops at its first request that times out (15 and 10 seconds), after the fast auth
 * refusals of its other logins. Two requests of 15 seconds cover the three sources; a slower probe is not covered.
 */
const QUOTA_FETCH_MS = 30_000;
/** Timer steps of one second at the request and at the paint. */
const QUOTA_MARGIN_MS = 3000;
/**
 * The shortest lifetime of a quota reading in the footer. The footer asks each quota source one time in a poll period, and a
 * source can skip a request for a reading that is a little younger than its own skip time. A reading gets its time when the
 * fetch ends. So a reading is stale only when two poll periods and one fetch passed with no newer reading.
 */
export const quotaLifetimeFloor = (settings: Pick<Settings, "healthPollSeconds">): number => 2 * settings.healthPollSeconds * 1000 + QUOTA_FETCH_MS + QUOTA_MARGIN_MS;
export function installOpsFooter(pi: ExtensionAPI, dependencies: RuntimeDependencies): void {
  const context = dependencies.context(pi);
  let settings: Settings = { ...defaults, healthUrls: {} };
  let ctx: ExtensionContext | undefined;
  let started = false, closed = false, active = false, version = 0;
  let startedIn: string | undefined;
  let working = false, waiting = false, compacting = false, failed = false;
  let data: DashboardSnapshot | undefined;
  let git: GitAdapter | undefined, health: HealthAdapter | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastExternal = 0;
  let healthFlight: Promise<void> | undefined;
  let generation = 0;
  let settingsEpoch = 0;
  let requestRender: (() => void) | undefined;
  let footerCleanup: (() => void) | undefined;
  let statuses: (() => ReadonlyMap<string, string>) | undefined;
  let compactAbortCleanup: (() => void) | undefined;
  let layout: LayoutName = defaultLayout;
  let renderer: FooterRenderer | undefined;
  let topWidget = false;
  let shown: { width: number; lines: string[] } | undefined, shownAbove: { width: number; lines: string[] } | undefined;
  let gitFlight = false, gitQueued = false, lastGit = 0;
  const memory = new MemoryTracker();
  const integrations = new Map<IntegrationSource, IntegrationSnapshot>();
  const published = new Map<IntegrationSource, IntegrationSnapshot>();
  const publicValues = new Map<IntegrationSource, { value: string; snapshot: IntegrationSnapshot }>();
  const cleanups: (() => void)[] = [];
  const announce = () => pi.events.emit(OWNERSHIP, { active });
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);
  // Pi repaints the whole screen for a request. Ask only when the rows at the painted width change; time text changes at its display step.
  const bump = () => {
    version++;
    if (renderer && shown && data && same(renderer.render(shown.width, version), shown.lines)
      && (!shownAbove || same(renderer.renderAbove(shownAbove.width, version), shownAbove.lines))) return;
    requestRender?.();
  };
  const currentState = (): AgentState => waiting ? "waiting" : compacting ? "compacting" : failed ? "failed" : working ? "working" : "idle";
  function refreshLocal() {
    if (!ctx || closed) return;
    const session = collectSession(pi, ctx, currentState(), startedIn ?? ctx.cwd);
    data = { session, git: git?.snapshot ?? data?.git ?? unknown("not checked"), limits: data?.limits, copilot: data?.copilot, anthropic: data?.anthropic,
      integrations: [], extensionStatuses: data?.extensionStatuses ?? 0, conflict: data?.conflict ?? false };
    refreshStatuses();
    bump();
  }
  function refreshStatuses() {
    if (!data) return;
    const values = statuses?.() ?? new Map<string, string>();
    data.extensionStatuses = values.size;
    data.languageStatus = languageStatus(values.get("tenantext"));
    data.memory = memory.snapshot(values, pi.getActiveTools());
    data.conflict = pi.getCommands().some(command => command.source === "extension" &&
      /(?:^|[:/@])pi-powerline-footer(?:$|[/@])/.test(command.sourceInfo.source)) || values.has("powerline");
    const next = publicStatuses(values);
    const present = new Set(next.map(s => s.source));
    for (const source of publicValues.keys()) if (!present.has(source)) publicValues.delete(source);
    for (const s of next) {
      const previous = publicValues.get(s.source);
      // Unchanged static status text is not proof of a fresh health check.
      const value = s.source === "OV" ? JSON.stringify([s.state, vikingCounters(values.get("openviking"))]) : s.state;
      if (!previous || previous.value !== value) publicValues.set(s.source, { value, snapshot: s });
    }
    const combined = new Map<IntegrationSource, IntegrationSnapshot>();
    for (const { snapshot } of publicValues.values()) combined.set(snapshot.source, snapshot);
    for (const snapshot of published.values()) combined.set(snapshot.source, snapshot);
    for (const snapshot of integrations.values()) combined.set(snapshot.source, snapshot);
    if (settings.showUnavailableOptionalSources) for (const source of ["MCP", "OK", "OV", "Wiki", "Hermes", "work"] as const) {
      if (!combined.has(source)) combined.set(source, { ...unknown(), source });
    }
    data.integrations = [...combined.values()];
  }
  function refreshGit(force = false) {
    if (!ctx || !git || closed) return;
    // One collection at a time. Requests during it queue one forced follow-up, because the running collection can predate the event.
    if (gitFlight) { gitQueued = true; return; }
    const adapter = git;
    gitFlight = true; lastGit = Date.now();
    void adapter.refresh(ctx.cwd, force).then(snapshot => {
      if (closed || git !== adapter || !data) return;
      data.git = snapshot; bump();
    }).catch(() => { if (!closed && data) { data.git = { ...data.git, state: "error", summary: "Git unavailable" }; bump(); } }).finally(() => {
      if (git !== adapter) return;
      gitFlight = false;
      if (gitQueued) { gitQueued = false; refreshGit(true); }
    });
  }
  function refreshExternal() {
    if (!started || closed || !health) return;
    lastExternal = Date.now();
    pi.events.emit(CODEX_REFRESH, undefined);
    pi.events.emit(COPILOT_REFRESH, undefined);
    pi.events.emit(ANTHROPIC_REFRESH, undefined);
    if (healthFlight) return;
    const currentGeneration = generation;
    const adapter = health;
    healthFlight = Promise.all((["OK", "OV"] as const).map(async source => {
      const url = settings.healthUrls[source];
      if (!url) return;
      const result = await adapter.check(source, url, settings.healthTimeoutMs, settings.healthPollSeconds * 1000);
      if (!closed && generation === currentGeneration) { integrations.set(source, result); refreshStatuses(); bump(); }
    })).then(() => {}).catch(() => {}).finally(() => { if (generation === currentGeneration) healthFlight = undefined; });
  }
  function startCollectors() {
    git = (dependencies.git ?? (s => new GitAdapter(s.healthTimeoutMs, s.gitCacheMs, s.gitIdlePollSeconds * 1000)))(settings);
    health = (dependencies.health ?? (() => new HealthAdapter()))();
    refreshGit(true); refreshExternal();
    timer = setInterval(() => {
      if (!ctx || !data || closed) return;
      data.session.pending = ctx.hasPendingMessages(); data.session.tools = pi.getActiveTools().length;
      refreshStatuses(); bump();
      // An agent turn polls at the Git cache time. An idle session polls slowly; agent_settled and tool events refresh at once.
      if (!gitFlight && (working || compacting || Date.now() - lastGit >= settings.gitIdlePollSeconds * 1000)) refreshGit();
      if (Date.now() - lastExternal >= settings.healthPollSeconds * 1000) refreshExternal();
    }, 1000);
    timer.unref?.();
  }
  function stopCollectors() {
    clearInterval(timer); timer = undefined; generation++;
    git?.dispose(); health?.dispose(); git = undefined; health = undefined; healthFlight = undefined;
    gitFlight = false; gitQueued = false; lastGit = 0;
  }
  function enable() {
    if (!ctx || !started || closed || active || ctx.mode !== "tui") { announce(); return; }
    active = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender(); statuses = () => footerData.getExtensionStatuses();
      const current = new FooterRenderer(() => data!, context, () => settings, themePaint(theme), Date.now, () => layouts[layout]);
      renderer = current;
      const unsubscribe = footerData.onBranchChange(() => refreshGit(true));
      let disposed = false;
      footerCleanup = () => {
        if (disposed) return;
        disposed = true; unsubscribe(); current.invalidate(); requestRender = undefined; statuses = undefined; shown = undefined; shownAbove = undefined;
        if (renderer === current) renderer = undefined;
        footerCleanup = undefined;
        if (active) { active = false; stopCollectors(); syncTopWidget(); announce(); }
      };
      refreshLocal();
      return {
        render: width => { const lines = current.render(width, version); shown = { width, lines }; return lines; },
        invalidate: () => current.invalidate(),
        dispose: footerCleanup,
      };
    });
    syncTopWidget();
    announce(); startCollectors();
    if (data?.conflict) ctx.ui.notify("Warning: Powerline may also own the footer. Disable one footer extension.", "warning");
  }
  /**
   * Only a layout with rows above the editor (v3) gets the widget. Pi draws the same single spacer line above the editor for
   * no widget and for a widget of zero lines, so the rule is for a clean widget list, not for a line of space.
   */
  function syncTopWidget() {
    if (!ctx || ctx.mode !== "tui") return;
    const wanted = active && hasRowsAbove(layout);
    if (wanted === topWidget) return;
    topWidget = wanted; shownAbove = undefined;
    ctx.ui.setWidget(TOP_WIDGET, wanted ? () => ({
      render: (width: number) => { const lines = renderer?.renderAbove(width, version) ?? []; shownAbove = { width, lines }; return lines; },
      invalidate: () => renderer?.invalidate(),
    }) : undefined, wanted ? { placement: "aboveEditor" } : undefined);
  }
  function disable() {
    const owned = active;
    active = false; stopCollectors(); footerCleanup?.();
    syncTopWidget();
    if (owned && ctx?.mode === "tui") ctx.ui.setFooter(undefined);
    announce();
  }
  cleanups.push(pi.events.on(OWNERSHIP_QUERY, announce));
  cleanups.push(pi.events.on(CODEX_STATUS, value => {
    if (!started || closed || !data) return;
    const snapshot = codexStatus(value, Date.now(), quotaLifetimeFloor(settings));
    if (snapshot) { data.limits = snapshot; bump(); }
  }));
  cleanups.push(pi.events.on(COPILOT_STATUS, value => {
    if (!started || closed || !data) return;
    // A malformed or `absent` snapshot clears the meter; the footer never shows a Copilot group it cannot fill.
    data.copilot = copilotStatus(value, Date.now(), quotaLifetimeFloor(settings)); bump();
  }));
  cleanups.push(pi.events.on(ANTHROPIC_STATUS, value => {
    if (!started || closed || !data) return;
    // A malformed or `absent` snapshot clears the meter; the footer never shows a Claude group it cannot fill.
    data.anthropic = anthropicStatus(value, Date.now(), quotaLifetimeFloor(settings)); bump();
  }));
  cleanups.push(pi.events.on(INTEGRATION_STATUS, value => {
    if (!started || closed) return;
    const snapshot = integrationStatus(value);
    if (snapshot) { published.set(snapshot.source, snapshot); refreshStatuses(); bump(); }
  }));
  cleanups.push(context.subscribe(bump));
  cleanups.push(pi.events.on("tenantext:ops-footer:settings-reload", () => {
    void (async () => {
      if (!started || closed) return;
      const epoch = ++settingsEpoch;
      const nextSettings = await (dependencies.load ?? loadSettings)();
      if (closed || epoch !== settingsEpoch) return;
      disable(); integrations.clear(); settings = nextSettings;
      refreshLocal();
      if (settings.enabled) enable(); else announce();
    })().catch(() => ctx?.ui.notify("Cannot reload ops-footer settings.", "error"));
  }));
  cleanups.push(pi.on("session_start", async (_event, next) => {
    if (closed) return;
    ctx = next; startedIn = ctx.cwd;
    memory.reset();
    if (!dependencies.load) {
      try { await ensureSettings(); } catch { ctx.ui.notify("Cannot initialize ops-footer settings files.", "warning"); }
    }
    settings = await (dependencies.load ?? loadSettings)();
    if (closed) return;
    started = true; working = !ctx.isIdle(); refreshLocal();
    if (settings.enabled) { if (active) { refreshGit(true); refreshExternal(); } else enable(); }
    else announce();
  }));
  cleanups.push(pi.on("agent_start", (_event, next) => { ctx = next; working = true; failed = false; refreshLocal(); }));
  cleanups.push(pi.on("agent_settled", (_event, next) => { ctx = next; working = false; compacting = false; memory.settle(); refreshLocal(); refreshGit(true); }));
  cleanups.push(pi.on("ui_prompt_start", (_event, next) => { ctx = next; waiting = true; refreshLocal(); }));
  cleanups.push(pi.on("ui_prompt_end", (_event, next) => { ctx = next; waiting = false; refreshLocal(); }));
  cleanups.push(pi.on("session_before_compact", (event, next) => {
    ctx = next; compacting = true; refreshLocal();
    // Compaction may be cancelled by a later extension before a terminal event.
    compactAbortCleanup?.();
    const onAbort = () => { if (!closed) { compacting = false; refreshLocal(); } };
    event.signal.addEventListener("abort", onAbort, { once: true });
    compactAbortCleanup = () => event.signal.removeEventListener("abort", onAbort);
  }));
  cleanups.push(pi.on("session_compact", (_event, next) => { compactAbortCleanup?.(); ctx = next; compacting = false; refreshLocal(); }));
  cleanups.push(pi.on("session_compact_failed", (event, next) => { compactAbortCleanup?.(); ctx = next; compacting = false; failed = !event.aborted; refreshLocal(); }));
  cleanups.push(pi.on("message_end", (event, next) => {
    ctx = next;
    if (event.message.role === "assistant") failed = event.message.stopReason === "error";
    if (event.message.role === "custom" && event.message.customType === "wiki-observe-reminder") memory.reminder();
    refreshLocal();
  }));
  cleanups.push(pi.on("tool_execution_start", (event, next) => {
    ctx = next; memory.start(event.toolCallId, event.toolName); refreshLocal();
  }));
  cleanups.push(pi.on("tool_execution_end", (event, next) => {
    ctx = next; memory.end(event.toolCallId, event.toolName, event.isError, event.result); refreshLocal(); refreshGit();
  }));
  const update = (_event: unknown, next: ExtensionContext) => { ctx = next; refreshLocal(); };
  cleanups.push(pi.on("thinking_level_select", update));
  cleanups.push(pi.on("model_select", update));
  cleanups.push(pi.on("session_info_changed", update));
  cleanups.push(pi.on("session_tree", update));
  cleanups.push(pi.on("session_shutdown", () => {
    if (closed) return;
    closed = true; compactAbortCleanup?.(); disable(); context.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
    memory.reset(); integrations.clear(); published.clear(); publicValues.clear(); data = undefined; ctx = undefined;
  }));
  pi.registerCommand("ops-footer", {
    description: "Local operations dashboard and source freshness",
    handler: async (args, next) => {
      if (closed) return;
      ctx = next;
      const command = args.trim() || "report";
      if (command === "on") { settings.enabled = true; refreshLocal(); enable(); }
      else if (command === "off") { settings.enabled = false; disable(); ctx.ui.notify("Pi's default footer is restored.", "info"); }
      else if (command === "refresh") {
        if (active) { refreshLocal(); refreshGit(true); refreshExternal(); }
        else ctx.ui.notify("Enable the footer before refreshing external sources.", "info");
      } else if (command === "save") {
        try { await (dependencies.save ?? saveSettings)(settings); ctx.ui.notify("Saved ops-footer defaults.", "info"); }
        catch { ctx.ui.notify("Cannot save ops-footer settings.", "error"); }
      } else if (command === "settings") {
        ctx.ui.notify(`Use /tenantext settings for the interactive editor.\nSettings: ${settingsPath()}\n${JSON.stringify({ ...settings, healthUrls: { OK: settings.healthUrls.OK ? "configured" : "unset", OV: settings.healthUrls.OV ? "configured" : "unset" } }, null, 2)}\nEnvironment: OPS_FOOTER_OK_HEALTH_URL, OPS_FOOTER_OV_HEALTH_URL.\nURLs must have no credentials, query, or fragment.`, "info");
      } else if (command === "layout" || command.startsWith("layout ")) {
        const name = command.slice("layout".length).trim();
        if (isLayoutName(name)) { layout = name; renderer?.invalidate(); syncTopWidget(); bump(); ctx.ui.notify(`Footer layout: ${name} (session only).`, "info"); }
        else ctx.ui.notify(`Footer layout: ${layout}. Use /ops-footer layout ${layoutNames.join("|")}.`, "info");
      } else if (command === "report") {
        refreshLocal();
        // The dropped-row line needs the painted width. It applies to the v4 and v3 layouts, which stack one row per account.
        if (data) ctx.ui.notify(detailedReport(data, context, Date.now(), (layout === "v4" || layout === "v3") && shown ? { settings, width: shown.width } : undefined), "info");
      } else ctx.ui.notify(HELP, "info");
    },
  });
}
