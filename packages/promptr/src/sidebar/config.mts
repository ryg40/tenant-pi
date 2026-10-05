// Promptr sidebar panel settings: one versioned file, pure validation and mutations.
// The settings screen and `/promptr panel|move|startup` commands share these functions.
// Array position in `sidebarPanelLayout` is the only ordering authority.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicWrite } from "../state/paths.mts";
import { DEFAULT_PROMPTR_PANEL_ORDER, defaultPromptrPanelLayout, panelTitle, type SidebarPanelId,
  type SidebarPanelLayout } from "./atelier-adapter.mts";
import { isSidebarPanelContributionId, isSidebarPanelId } from "./vendor/atelier/sidebar-panels.mts";

export const SIDEBAR_SETTINGS_VERSION = 1;
export const SIDEBAR_WIDTH_DEFAULT = 44;
export const SIDEBAR_WIDTH_MIN = 28;
export const SIDEBAR_WIDTH_MAX = 72;
/** Fingerprint of a settings file that does not exist yet. */
export const ABSENT_FINGERPRINT = "absent";
const KNOWN_KEYS = ["version", "showSidebarOnStartup", "sidebarWidth", "showSidebarToolNames", "sidebarPanelLayout",
  "sidebarCollapsedPanels"];

export interface SidebarSettings {
  version: typeof SIDEBAR_SETTINGS_VERSION;
  showSidebarOnStartup: boolean;
  sidebarWidth: number;
  showSidebarToolNames: boolean;
  sidebarPanelLayout: SidebarPanelLayout;
  /**
   * Panels drawn as one header row. Independent of `visible`. A top-level key, so earlier builds
   * keep it as an unknown field on save. IDs not in the layout are kept, so a contributed panel keeps its state.
   */
  sidebarCollapsedPanels: SidebarPanelId[];
}

/** Loaded file state. `error` means the file is invalid: defaults apply in memory and every save is refused. */
export interface SidebarSettingsState {
  path: string;
  settings: SidebarSettings;
  /** Unknown top-level fields, preserved on save. */
  extra: Record<string, unknown>;
  /** SHA-256 of the raw file at load time, or `absent`. Save refuses when the file changed since. */
  fingerprint: string;
  error?: string;
}

export type SettingsResult<T> = { ok: true; value: T; message: string } | { ok: false; error: string };
export type SaveOutcome = { ok: true; state: SidebarSettingsState; written: boolean } | { ok: false; error: string; stale?: true };

export function sidebarSettingsPath(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, "promptr", "sidebar.json");
}

export function defaultSidebarSettings(): SidebarSettings {
  return { version: SIDEBAR_SETTINGS_VERSION, showSidebarOnStartup: true, sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    showSidebarToolNames: false, sidebarPanelLayout: defaultPromptrPanelLayout(), sidebarCollapsedPanels: [] };
}

export function cloneSidebarSettings(settings: SidebarSettings): SidebarSettings {
  return { ...settings, sidebarPanelLayout: settings.sidebarPanelLayout.map((entry) => ({ ...entry })),
    sidebarCollapsedPanels: [...settings.sidebarCollapsedPanels] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fingerprintOf = (raw: string | undefined) =>
  raw === undefined ? ABSENT_FINGERPRINT : createHash("sha256").update(raw).digest("hex");

/**
 * Add catalog panels missing from a saved layout (for example after an upgrade) after their nearest
 * default predecessor. Saved entries keep their order and visibility; nothing is forced visible.
 */
export function normalizePanelLayout(layout: SidebarPanelLayout): SidebarPanelLayout {
  const next = layout.map((entry) => ({ ...entry }));
  DEFAULT_PROMPTR_PANEL_ORDER.forEach((id, index) => {
    if (next.some((entry) => entry.id === id)) return;
    const before = DEFAULT_PROMPTR_PANEL_ORDER.slice(0, index).reverse().find((prior) => next.some((entry) => entry.id === prior));
    next.splice(before === undefined ? 0 : next.findIndex((entry) => entry.id === before) + 1, 0, { id, visible: true });
  });
  return next;
}

/** Strict: any invalid field rejects the whole file, so a later Save never overwrites what the user wrote. */
export function parseSidebarSettings(raw: string): { ok: true; settings: SidebarSettings; extra: Record<string, unknown> } | { ok: false; error: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { return { ok: false, error: `not valid JSON (${error instanceof Error ? error.message : "parse error"})` }; }
  if (!isRecord(value)) return { ok: false, error: "must be a JSON object" };
  if (value.version !== SIDEBAR_SETTINGS_VERSION) return { ok: false, error: `unsupported version ${JSON.stringify(value.version)}; expected ${SIDEBAR_SETTINGS_VERSION}` };
  const settings = defaultSidebarSettings();
  for (const key of ["showSidebarOnStartup", "showSidebarToolNames"] as const) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "boolean") return { ok: false, error: `${key} must be true or false` };
    settings[key] = value[key];
  }
  if ("sidebarWidth" in value) {
    const width = value.sidebarWidth;
    if (typeof width !== "number" || !Number.isInteger(width) || width < SIDEBAR_WIDTH_MIN || width > SIDEBAR_WIDTH_MAX)
      return { ok: false, error: `sidebarWidth must be an integer from ${SIDEBAR_WIDTH_MIN} to ${SIDEBAR_WIDTH_MAX}` };
    settings.sidebarWidth = width;
  }
  if ("sidebarPanelLayout" in value) {
    const layout = value.sidebarPanelLayout;
    if (!Array.isArray(layout)) return { ok: false, error: "sidebarPanelLayout must be an array" };
    const seen = new Set<string>();
    const entries: SidebarPanelLayout = [];
    for (const [index, item] of layout.entries()) {
      if (!isRecord(item) || !isSidebarPanelId(item.id)) return { ok: false, error: `sidebarPanelLayout[${index}] has no valid panel id` };
      if (typeof item.visible !== "boolean") return { ok: false, error: `sidebarPanelLayout[${index}] (${item.id}) visible must be true or false` };
      if (seen.has(item.id)) return { ok: false, error: `sidebarPanelLayout lists ${item.id} twice` };
      seen.add(item.id);
      entries.push({ id: item.id, visible: item.visible });
    }
    settings.sidebarPanelLayout = normalizePanelLayout(entries);
  }
  if ("sidebarCollapsedPanels" in value) {
    const collapsed = value.sidebarCollapsedPanels;
    if (!Array.isArray(collapsed)) return { ok: false, error: "sidebarCollapsedPanels must be an array of panel IDs" };
    const ids: SidebarPanelId[] = [];
    for (const [index, id] of collapsed.entries()) {
      if (!isSidebarPanelId(id)) return { ok: false, error: `sidebarCollapsedPanels[${index}] is not a valid panel id` };
      if (!ids.includes(id)) ids.push(id);
    }
    settings.sidebarCollapsedPanels = ids;
  }
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_KEYS.includes(key)));
  return { ok: true, settings, extra };
}

function readRaw(file: string): { raw?: string; error?: string } {
  try { return { raw: fs.readFileSync(file, "utf8") }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: `cannot read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

/** Read-only. A missing file yields defaults and creates nothing; an invalid file is reported, never replaced. */
export function loadSidebarSettings(file: string = sidebarSettingsPath()): SidebarSettingsState {
  const { raw, error: readError } = readRaw(file);
  const base = { path: file, settings: defaultSidebarSettings(), extra: {}, fingerprint: fingerprintOf(raw) };
  if (readError) return { ...base, fingerprint: `unreadable:${readError}`, error: `${file}: ${readError}. Using defaults; saving is blocked.` };
  if (raw === undefined) return base;
  const parsed = parseSidebarSettings(raw);
  if (!parsed.ok) return { ...base, error: `${file}: ${parsed.error}. Using defaults; fix or move the file, then reopen. Nothing was overwritten.` };
  return { ...base, settings: parsed.settings, extra: parsed.extra };
}

function validationError(settings: SidebarSettings): string | undefined {
  const raw = JSON.stringify({ ...settings, version: SIDEBAR_SETTINGS_VERSION });
  const parsed = parseSidebarSettings(raw);
  return parsed.ok ? undefined : parsed.error;
}

export function serializeSidebarSettings(settings: SidebarSettings, extra: Record<string, unknown> = {}): string {
  const known = { version: SIDEBAR_SETTINGS_VERSION, showSidebarOnStartup: settings.showSidebarOnStartup,
    sidebarWidth: settings.sidebarWidth, showSidebarToolNames: settings.showSidebarToolNames,
    sidebarPanelLayout: settings.sidebarPanelLayout.map(({ id, visible }) => ({ id, visible })),
    // Written only when used, so files without collapsed panels stay byte-identical to earlier builds.
    ...(settings.sidebarCollapsedPanels.length ? { sidebarCollapsedPanels: [...settings.sidebarCollapsedPanels] } : {}) };
  const preserved = Object.fromEntries(Object.entries(extra).filter(([key]) => !KNOWN_KEYS.includes(key)));
  return `${JSON.stringify({ ...known, ...preserved }, null, 2)}\n`;
}

/**
 * Explicit save only. Refuses a retired session, an invalid loaded file, an invalid draft, and a file that
 * changed after `base` was loaded (stale save). Writes atomically; an unchanged draft writes nothing.
 */
export function saveSidebarSettings(base: SidebarSettingsState, next: SidebarSettings,
  options: { isCurrent?: () => boolean } = {}): SaveOutcome {
  if (options.isCurrent && !options.isCurrent()) return { ok: false, error: "This Pi session has ended. Nothing saved." };
  if (base.error) return { ok: false, error: base.error };
  const invalid = validationError(next);
  if (invalid) return { ok: false, error: `Invalid settings: ${invalid}. Nothing saved.` };
  const { raw, error } = readRaw(base.path);
  if (error) return { ok: false, error: `${base.path}: ${error}. Nothing saved.` };
  if (fingerprintOf(raw) !== base.fingerprint)
    return { ok: false, stale: true, error: "Sidebar settings changed elsewhere since they were loaded. Nothing saved. Reopen /promptr panels to reload." };
  const text = serializeSidebarSettings(next, base.extra);
  const settings = cloneSidebarSettings(next);
  if (text === raw) return { ok: true, written: false, state: { ...base, settings } };
  atomicWrite(base.path, text);
  return { ok: true, written: true, state: { path: base.path, settings, extra: { ...base.extra }, fingerprint: fingerprintOf(text) } };
}

// ---- Pure mutations shared by the settings screen and commands ----

const shortName = (id: string) => (isSidebarPanelContributionId(id) ? id.slice(id.indexOf(":") + 1) : id);

/** Resolve a full ID, a `promptr:` short name, or a display name. Unknown and ambiguous references fail. */
export function resolvePanelRef(layout: SidebarPanelLayout, ref: string): { ok: true; id: SidebarPanelId } | { ok: false; error: string } {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return { ok: false, error: "Name a panel, for example notebook or promptr:notebook." };
  const ids = layout.map((entry) => entry.id);
  const exact = ids.find((id) => id === wanted);
  if (exact) return { ok: true, id: exact };
  const matches = ids.filter((id) => shortName(id) === wanted || panelTitle(id).toLowerCase() === wanted);
  if (matches.length === 1) return { ok: true, id: matches[0]! };
  if (matches.length > 1) return { ok: false, error: `"${ref}" is ambiguous: ${matches.join(", ")}. Use the full panel ID.` };
  return { ok: false, error: `Unknown panel "${ref}". Panels: ${ids.join(", ")}.` };
}

export function setPanelVisible(layout: SidebarPanelLayout, id: SidebarPanelId, visible: boolean): SettingsResult<SidebarPanelLayout> {
  if (!layout.some((entry) => entry.id === id)) return { ok: false, error: `Unknown panel "${id}".` };
  return { ok: true, value: layout.map((entry) => (entry.id === id ? { ...entry, visible } : { ...entry })),
    message: `${panelTitle(id)} ${visible ? "on" : "off"}` };
}

/** Move to a one-based position in the full list, hidden entries included. */
export function movePanel(layout: SidebarPanelLayout, id: SidebarPanelId, position: number): SettingsResult<SidebarPanelLayout> {
  const from = layout.findIndex((entry) => entry.id === id);
  if (from < 0) return { ok: false, error: `Unknown panel "${id}".` };
  if (!Number.isInteger(position) || position < 1 || position > layout.length)
    return { ok: false, error: `Position must be a whole number from 1 to ${layout.length}.` };
  const next = layout.map((entry) => ({ ...entry }));
  const [moved] = next.splice(from, 1);
  next.splice(position - 1, 0, moved!);
  return { ok: true, value: next, message: `${panelTitle(id)} moved to position ${position}` };
}

export function movePanelBy(layout: SidebarPanelLayout, id: SidebarPanelId, delta: number): SettingsResult<SidebarPanelLayout> {
  const from = layout.findIndex((entry) => entry.id === id);
  if (from < 0) return { ok: false, error: `Unknown panel "${id}".` };
  const target = from + 1 + delta;
  if (target < 1 || target > layout.length) return { ok: false, error: `${panelTitle(id)} is already ${delta < 0 ? "first" : "last"}.` };
  return movePanel(layout, id, target);
}

export function setSidebarWidthSetting(settings: SidebarSettings, width: number): SettingsResult<SidebarSettings> {
  if (!Number.isInteger(width) || width < SIDEBAR_WIDTH_MIN || width > SIDEBAR_WIDTH_MAX)
    return { ok: false, error: `Width must be a whole number from ${SIDEBAR_WIDTH_MIN} to ${SIDEBAR_WIDTH_MAX}.` };
  return { ok: true, value: { ...cloneSidebarSettings(settings), sidebarWidth: width }, message: `Width ${width}` };
}

/** Collapse or expand one panel. A hidden panel keeps the state for when it is shown again. */
export function setPanelCollapsed(settings: SidebarSettings, id: SidebarPanelId, collapsed: boolean): SettingsResult<SidebarSettings> {
  const entry = settings.sidebarPanelLayout.find((item) => item.id === id);
  if (!entry) return { ok: false, error: `Unknown panel "${id}".` };
  const rest = settings.sidebarCollapsedPanels.filter((item) => item !== id);
  const value = { ...cloneSidebarSettings(settings), sidebarCollapsedPanels: collapsed ? [...rest, id] : rest };
  const state = collapsed ? "collapsed" : "expanded";
  return { ok: true, value, message: entry.visible ? `${panelTitle(id)} ${state}` : `${panelTitle(id)} is hidden; ${state} state saved` };
}

/** Collapse every shown panel, or expand every panel. Other collapsed IDs stay listed when collapsing. */
export function setAllCollapsed(settings: SidebarSettings, collapsed: boolean): SettingsResult<SidebarSettings> {
  const shown = settings.sidebarPanelLayout.filter((entry) => entry.visible).map((entry) => entry.id);
  const ids = collapsed ? [...settings.sidebarCollapsedPanels.filter((id) => !shown.includes(id)), ...shown] : [];
  return { ok: true, value: { ...cloneSidebarSettings(settings), sidebarCollapsedPanels: ids },
    message: collapsed ? "All shown panels collapsed" : "All panels expanded" };
}

export function isPanelCollapsed(settings: Pick<SidebarSettings, "sidebarCollapsedPanels">, id: string): boolean {
  return settings.sidebarCollapsedPanels.includes(id as SidebarPanelId);
}

// ---- Command API for the integration (./controller.mts) ----

export type SidebarSettingsCommand =
  | { kind: "panels" }
  | { kind: "panel"; ref: string; visible: boolean }
  | { kind: "move"; ref: string; position: number }
  | { kind: "startup"; value: boolean }
  /** `ref` "all" is valid for collapse and expand. `collapsed` undefined toggles (fold). */
  | { kind: "collapse"; ref: string; collapsed: boolean | undefined };

export const SIDEBAR_SETTINGS_USAGE =
  "/promptr panels | panel <name> on|off | move <name> <position> | startup on|off | collapse|expand <name>|all | fold <name>";

const ON = new Set(["on", "show", "true"]);
const OFF = new Set(["off", "hide", "false"]);

/** `undefined` when `args` is not a settings subcommand; otherwise a parsed command or a usage error. */
export function parseSidebarSettingsCommand(args: string): { ok: true; command: SidebarSettingsCommand } | { ok: false; error: string } | undefined {
  const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const lowerVerb = verb?.toLowerCase();
  const fail = (error: string) => ({ ok: false as const, error: `${error} Usage: ${SIDEBAR_SETTINGS_USAGE}` });
  if (lowerVerb === "panels") return rest.length ? fail("/promptr panels takes no arguments.") : { ok: true, command: { kind: "panels" } };
  if (lowerVerb === "panel") {
    const state = rest[1]?.toLowerCase() ?? "";
    if (rest.length !== 2 || (!ON.has(state) && !OFF.has(state))) return fail("Expected: /promptr panel <name> on|off.");
    return { ok: true, command: { kind: "panel", ref: rest[0]!, visible: ON.has(state) } };
  }
  if (lowerVerb === "move") {
    if (rest.length !== 2 || !/^\d+$/.test(rest[1]!)) return fail("Expected: /promptr move <name> <position>.");
    return { ok: true, command: { kind: "move", ref: rest[0]!, position: Number(rest[1]) } };
  }
  if (lowerVerb === "collapse" || lowerVerb === "expand" || lowerVerb === "fold") {
    const all = rest[0]?.toLowerCase() === "all";
    if (rest.length !== 1 || (all && lowerVerb === "fold"))
      return fail(lowerVerb === "fold" ? "Expected: /promptr fold <name>." : `Expected: /promptr ${lowerVerb} <name>|all.`);
    return { ok: true, command: { kind: "collapse", ref: all ? "all" : rest[0]!,
      collapsed: lowerVerb === "fold" ? undefined : lowerVerb === "collapse" } };
  }
  if (lowerVerb === "startup") {
    const state = rest[0]?.toLowerCase() ?? "";
    if (rest.length !== 1 || (!ON.has(state) && !OFF.has(state))) return fail("Expected: /promptr startup on|off.");
    return { ok: true, command: { kind: "startup", value: ON.has(state) } };
  }
  return undefined;
}

/** Apply one mutating command to settings. `panels` opens the screen and is not a mutation. */
export function applySidebarSettingsCommand(settings: SidebarSettings, command: SidebarSettingsCommand): SettingsResult<SidebarSettings> {
  const layout = settings.sidebarPanelLayout;
  if (command.kind === "panels") return { ok: false, error: "/promptr panels opens the settings screen." };
  if (command.kind === "startup") return { ok: true, value: { ...cloneSidebarSettings(settings), showSidebarOnStartup: command.value },
    message: `Sidebar ${command.value ? "shows" : "stays hidden"} on startup` };
  if (command.kind === "collapse" && command.ref === "all") return setAllCollapsed(settings, command.collapsed !== false);
  const resolved = resolvePanelRef(layout, command.ref);
  if (!resolved.ok) return resolved;
  if (command.kind === "collapse")
    return setPanelCollapsed(settings, resolved.id, command.collapsed ?? !isPanelCollapsed(settings, resolved.id));
  const result = command.kind === "panel" ? setPanelVisible(layout, resolved.id, command.visible)
    : movePanel(layout, resolved.id, command.position);
  return result.ok ? { ok: true, value: { ...cloneSidebarSettings(settings), sidebarPanelLayout: result.value }, message: result.message } : result;
}

export type SidebarSettingsCommandOutcome =
  | { kind: "open-panels" }
  | { kind: "saved"; message: string; state: SidebarSettingsState }
  | { kind: "error"; message: string };

/**
 * Parse, load, apply and save one `/promptr` settings subcommand. Returns `undefined` for other subcommands.
 * Any failure leaves the file unchanged.
 */
export function runSidebarSettingsCommand(args: string, options: { file?: string; isCurrent?: () => boolean } = {}): SidebarSettingsCommandOutcome | undefined {
  const parsed = parseSidebarSettingsCommand(args);
  if (!parsed) return undefined;
  if (!parsed.ok) return { kind: "error", message: parsed.error };
  if (parsed.command.kind === "panels") return { kind: "open-panels" };
  const state = loadSidebarSettings(options.file ?? sidebarSettingsPath());
  if (state.error) return { kind: "error", message: state.error };
  const applied = applySidebarSettingsCommand(state.settings, parsed.command);
  if (!applied.ok) return { kind: "error", message: `${applied.error} Nothing changed.` };
  const saved = saveSidebarSettings(state, applied.value, options.isCurrent ? { isCurrent: options.isCurrent } : {});
  return saved.ok ? { kind: "saved", message: `${applied.message}. Saved.`, state: saved.state } : { kind: "error", message: saved.error };
}
