import { contextBar, freeBase, ink, segmentBar, type TextPart } from "../context-meter/bar.ts";
import type { ContextState } from "../context-meter/snapshot.ts";
import { freshness, safeText } from "./adapters.ts";
import { plainPaint, type Paint } from "./paint.ts";
import type { Settings } from "./settings.ts";
import type { ContextService, DashboardSnapshot, IntegrationSnapshot, StatusSnapshot } from "./types.ts";
import { buildView, formatRelative, formatWhen, isCodexLabel, memoryGroups, type Alert, type QuotaView, type View } from "./view.ts";
import { fit, join as joinParts, justify, pick, quotaChip, width as visibleWidth, type Candidate } from "./widgets.ts";

export { fit } from "./widgets.ts";
export type { Paint } from "./paint.ts";
/** An unchanged alert paints in the muted variant after this long. Glyph and word stay. */
export const ALERT_DECAY_MS = 10 * 60 * 1000;
export type Aged = (key: string) => boolean;
export const never: Aged = () => false;
export const unknownContext: ContextState = { used: undefined, window: undefined, percent: undefined, stage: "UNKNOWN", system: undefined, systemWarning: false, weights: undefined, thresholds: { prepare: 60, transition: 75, critical: 90 }, guidance: "" };

export const paintAlert = (paint: Paint, alert: Alert, aged: Aged, text = alert.text): string => paint.fg(aged(alert.key) ? "muted" : alert.kind, text);

/** Row 1: the shared bar with totals and the stage word right-aligned inside it. The word, not only the color, carries the stage. */
export function contextRow(ctx: ContextState, view: View, width: number, paint: Paint, failed: boolean): string {
  if (failed) return segmentBar({ width, color: paint.color, segments: [{ cells: width, forms: ["context error", "ctx error", "!"], bg: freeBase.CRIT, fg: ink.light, free: true, fill: "·" }] });
  const c = view.context;
  const stageInk = c.kind === "error" ? ink.error : c.kind === "warning" ? ink.warning : ink.accent;
  const stage: TextPart[] = c.stage ? [{ text: c.stage, fg: stageInk, bold: true }, { text: " " }] : [];
  const totals: TextPart[] = c.totals ? [{ text: c.totals, fg: ink.light }, { text: " " }] : [];
  const pct: TextPart = { text: c.percent, fg: c.stage ? stageInk : ink.light, bold: Boolean(c.stage) };
  const sys: TextPart[] = c.sys ? [{ text: " · " }, { text: c.sys, fg: ink.error, bold: true }] : [];
  const candidates: TextPart[][] = width >= 40 ? [[...stage, ...totals, pct, ...sys], [...stage, ...totals, pct], [...stage, pct], [pct]] : [[...stage, pct], [pct]];
  return contextBar(ctx, width, { color: paint.color, rightText: candidates });
}
/**
 * Quota chip groups from verbose to terse: full account names with resets, full names, short names, only the low windows, then bare alerts.
 * A reset at least a day away shows its date: for a low window in every row, for a normal window only in a stacked row.
 * Accounts stay in identity order at every level. Shared by the v2 and v3 quota rows.
 */
export function quotaCandidates(quota: QuotaView, paint: Paint, aged: Aged, now: number, stacked = false): { candidates: (Candidate | undefined)[]; compact?: Candidate; alert: boolean } {
  const alert = quota.alerts.length > 0;
  // A stacked row pads a relative reset before a later chip, so the next chips line up in a column across rows.
  const reset = (at: number | undefined, level: ResetForm, pad: boolean) => {
    if (level === "none") return "";
    if (at === undefined) return pad ? " ".repeat(RESET_WIDTH + 1) : "";
    const relative = `↺ ${formatRelative(at - now)}`;
    // The absolute form helps only for a far reset (7d, premium); a 5h reset stays relative.
    const text = level === "absolute" && (!stacked || at - now >= DAY_MS) ? `${relative} · ${formatWhen(at)}` : pad ? relative.padEnd(RESET_WIDTH) : relative;
    return " " + paint.fg("dim", text);
  };
  const account = (a: QuotaView["accounts"][number], short: boolean, chip: number, low: ResetForm, normal: ResetForm, onlyLow: boolean) => {
    const name = paint.fg("muted", short ? a.short : a.label);
    if (a.alert) return `${name} ${paintAlert(paint, a.alert, aged, "✗ error")}`;
    // A configured account with no login: dim text, never an alert. The low-only level drops it.
    if (a.login === false) return onlyLow ? undefined : `${name} ${paint.fg("dim", NO_LOGIN)}`;
    const windows = a.windows.filter(w => !onlyLow || w.alert);
    if (!windows.length) return undefined;
    const chips = windows.map((w, i) => quotaChip(w, paint, { width: chip, aged: w.alert ? aged(w.alert.key) : false }) + reset(w.resetsAt, w.alert ? low : normal, stacked && i < windows.length - 1));
    return `${name} ${chips.join(" ")}`;
  };
  const tail = (route: boolean) => [route && quota.route ? (quota.route.alert ? paintAlert(paint, quota.route.alert, aged) : paint.fg(quota.route.kind, quota.route.text)) : undefined, quota.stale ? paint.fg("dim", "stale") : undefined,
    quota.more ? paint.fg("dim", `+${quota.more}`) : undefined];
  const level = (short: boolean, chip: number, low: ResetForm, normal: ResetForm, onlyLow: boolean, route: boolean, minWidth = 0): Candidate | undefined => {
    const groups = quota.accounts.map(a => account(a, short, chip, low, normal, onlyLow)).filter(Boolean);
    if (!groups.length) return undefined;
    // A stacked row holds one account, so reset times fit without the wide-terminal minimum.
    return { text: joinParts([...groups, ...tail(route)], "  "), minWidth: stacked ? 0 : minWidth };
  };
  const compact = alert ? { text: quota.alerts.map(a => paintAlert(paint, a, aged, `${a.glyph} ${a.compact}`)).join("  ") } : undefined;
  // Below full-chip width, keep one representative window per account in identity order.
  const narrow = { text: joinParts(quota.accounts.map(a => a.alert
    ? `${paint.fg("muted", a.short)} ${paintAlert(paint, a.alert, aged, "✗ error")}`
    : a.windows.length ? `${paint.fg("muted", a.short)} ${quotaChip(a.windows.find(w => w.alert) ?? a.windows[0], paint)}` : undefined), "  ") };
  const candidates = [
    // A stacked row has room for the date of a far reset on a normal window too. It keeps every relative reset before it drops the normal ones.
    stacked ? level(false, 10, "absolute", "absolute", false, true) : undefined,
    level(false, 10, "absolute", "relative", false, true, 160), stacked ? level(false, 10, "relative", "relative", false, true) : undefined, level(false, 10, "absolute", "none", false, true, 120), level(false, 10, "relative", "none", false, true),
    level(false, 10, "none", "none", false, true), level(true, 8, "none", "none", false, false), alert ? level(true, 8, "none", "none", true, false) : undefined, narrow, compact,
  ];
  return { candidates, compact, alert };
}
type ResetForm = "none" | "relative" | "absolute";
const RESET_WIDTH = "↺ 23h 59m".length;
const NO_LOGIN = "no login";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Quota row: accounts in identity order; each window is a chip whose fill width is the remaining quota. */
export function quotaRow(quota: QuotaView, width: number, paint: Paint, aged: Aged, now: number, stacked = false): { text: string; alert: boolean } | undefined {
  const { candidates, compact, alert } = quotaCandidates(quota, paint, aged, now, stacked);
  const text = pick(candidates, width) ?? (alert && compact ? fit(compact.text, width) : undefined);
  return text === undefined ? undefined : { text, alert };
}
/** `account` names the quota account of a row. `quiet` marks a `no login` row: the row budget drops it first. */
export interface QuotaRow { text: string; alert: boolean; account?: string; quiet?: boolean; memory?: boolean }
/**
 * One quota row per account, stacked in identity order (Codex1, Codex2, ..., Claude, Copilot). Only configured providers have accounts,
 * so a Copilot-only machine gets one row. Labels pad to one width so the chips line up. Route and staleness go on the last Codex row.
 */
export function quotaRows(quota: QuotaView, width: number, paint: Paint, aged: Aged, now: number): QuotaRow[] {
  // An account with no windows, no error and a login has nothing to show and takes no row.
  const accounts = quota.accounts.filter(a => a.alert || a.windows.length || a.login === false);
  const labelWidth = Math.max(...accounts.map(a => a.label.length));
  const shortWidth = Math.max(...accounts.map(a => a.short.length));
  // The route belongs to Codex: it marks the routed account's row, or the last Codex row for a route error or staleness.
  const routed = accounts.findIndex(a => quota.route?.selected === a.label.toLowerCase());
  // Claude and Copilot are not Codex. A Codex row with a login is the better place for the route than a `no login` row.
  const loggedIn = accounts.map(a => isCodexLabel(a.label) && a.login !== false).lastIndexOf(true);
  const lastCodex = loggedIn >= 0 ? loggedIn : accounts.map(a => isCodexLabel(a.label)).lastIndexOf(true);
  const home = routed >= 0 ? routed : lastCodex;
  return accounts.flatMap((account, index) => {
    const own = (alert: Alert) => alert.key.startsWith(`quota:${account.label}:`);
    const tail = index === (home >= 0 ? home : accounts.length - 1);
    const route = tail && quota.route ? (index === routed ? { ...quota.route, text: "◂ routed" } : quota.route) : undefined;
    const single: QuotaView = {
      accounts: [{ ...account, label: account.label.padEnd(labelWidth), short: account.short.padEnd(shortWidth) }],
      route, stale: tail && quota.stale,
      alerts: quota.alerts.filter(a => own(a) || (tail && a.key === quota.route?.alert?.key)),
      // The count of dropped accounts goes on the last quota row.
      more: index === accounts.length - 1 ? quota.more : undefined,
    };
    const row = quotaRow(single, width, paint, aged, now, true);
    return row?.text ? [{ ...row, account: account.label, quiet: account.login === false }] : [];
  });
}
/** Services row: small colored groups, two spaces apart. Only present when it has content. */
export function servicesRow(view: View, width: number, paint: Paint, aged: Aged, includeMemory = true): { text: string; alert: boolean } | undefined {
  const groups = [...view.services, ...(includeMemory ? view.memory : [])];
  if (!groups.length) return undefined;
  const alert = groups.some(g => g.alert);
  const paintGroup = (g: View["services"][number], text: string) => g.alert ? paintAlert(paint, g, aged, text) : paint.fg("dim", text);
  const full = groups.map(g => paintGroup(g, g.text)).join("  ");
  const compact = groups.map(g => paintGroup(g, g.compact)).join("  ");
  const glyphs = groups.filter(g => g.glyph).map(g => paintGroup(g, g.glyph)).join(" ");
  const text = pick([full, compact, glyphs], width) ?? (alert ? fit(compact, width) : undefined);
  return text === undefined ? undefined : { text, alert };
}
/** Below 40 columns: branch, state, and alert glyphs on one row. */
export function compactRow(view: View, width: number, paint: Paint, aged: Aged): string {
  const branch = view.repo.branch ? paint.fg("muted", view.repo.branch) : undefined;
  const state = view.model.state.alert ? paintAlert(paint, view.model.state.alert, aged) : paint.fg(view.model.state.kind, view.model.state.text);
  const glyphs = [...new Set(view.alerts.filter(a => a.key !== "agent:waiting" && a.key !== "agent:failed").map(a => a.glyph))].map(g => paint.fg("warning", g)).join(" ");
  const sep = paint.fg("dim", " · ");
  return pick([joinParts([joinParts([branch, state], sep), glyphs], " "), joinParts([branch, state], sep), joinParts([state, glyphs], " "), state], width) ?? fit(state, width);
}
export function alertKeys(data: DashboardSnapshot, context: ContextService, settings: Settings, now = Date.now()): string[] {
  let ctx: ContextState;
  try { ctx = context.state(); } catch { ctx = unknownContext; }
  return buildView(data, ctx, settings, now).alerts.map(a => a.key);
}
/** Bold thinking level: `high` and `xhigh` in warning, other levels in accent. Off is hidden upstream. The most distinct element on the footer. */
export function thinkingLevel(paint: Paint, level: string): string {
  return paint.bold(paint.fg(level === "high" || level === "xhigh" ? "warning" : "accent", level));
}
/** The location row: above the editor in v3, below the model row in v4. The original right-hand agent facts stay on this row. */
export function locationRow(view: View, width: number, paint: Paint, aged: Aged, hint: boolean): string {
  const m = view.model;
  const sep = paint.fg("dim", " · ");
  const join = (parts: readonly (string | undefined)[]) => joinParts(parts, sep);
  const dim = (text?: string) => text ? paint.fg("dim", text) : undefined;
  const lefts = repoCandidates(view, paint, aged);
  const state = m.state.alert ? paintAlert(paint, m.state.alert, aged) : paint.fg(m.state.kind, m.state.text);
  const queued = m.queued ? paint.fg("accent", "queued") : undefined;
  const report = hint ? paint.fg("warning", "/ops-footer report") : undefined;
  // The next-move chip is advice: it sits before the state and is the first part to drop.
  const next = width >= 60 && view.context.next ? paint.fg("accent", view.context.next) : undefined;
  const rights = [
    join([next, state, queued, dim(m.duration), dim(m.session), dim(m.host ? `@${m.host}` : undefined), report]),
    join([next, state, queued, dim(m.duration), report]), join([next, state, queued, report]),
    join([state, queued, dim(m.duration), report]), join([state, queued, report]), join([state, report]),
  ];
  // Drop optional right-hand metadata before repository facts, changed cwd, or errors.
  const protectedLefts = view.repo.error ? lefts.slice(0, 5) : lefts;
  for (const left of protectedLefts) for (const right of rights) {
    const text = justify(left, right, width);
    if (text !== undefined) return text;
  }
  const right = pick([rights.at(-1)], Math.max(0, width - 6)) ?? "";
  const remaining = width - visibleWidth(right) - (right ? 2 : 0);
  const error = view.repo.error ? paintAlert(paint, view.repo.error, aged) : undefined;
  const tail = pick([join([dim(view.repo.cwd), error]), error], Math.max(0, remaining - 6)) ?? "";
  const path = fit(lefts.at(-1)!, Math.max(0, remaining - visibleWidth(tail) - (tail ? 3 : 0)));
  return justify(join([path, tail]), right, width) ?? fit(join([path, tail]), width);
}
/** Repository candidates keep the opening directory ahead of optional Git facts. */
function repoCandidates(view: View, paint: Paint, aged: Aged): string[] {
  const r = view.repo;
  const sep = paint.fg("dim", " · ");
  const join = (parts: readonly (string | undefined)[]) => joinParts(parts, sep);
  // The directory name leads in bold text weight; branch, worktree count, and path recede so the name reads at a glance.
  const name = r.name ? paint.bold(paint.fg("text", r.name)) : undefined;
  const base = name ? joinParts([name, r.branch ? paint.fg("dim", r.branch) : undefined], " ") : undefined;
  const branch = r.branch ? paint.fg("dim", r.branch) : undefined;
  const facts = r.facts.length ? paint.fg("accent", r.facts.join(" · ")) : undefined;
  const compact = r.compactFacts.length ? paint.fg("accent", r.compactFacts.join(" · ")) : undefined;
  const trees = r.worktrees ? paint.fg("dim", r.worktrees) : undefined;
  const path = r.pwd.replace(/^pwd /, "");
  const pwd = paint.fg("dim", "pwd ") + (name ? paint.fg("dim", path) : paint.bold(paint.fg("text", path)));
  const cwd = r.cwd ? paint.fg("dim", r.cwd) : undefined;
  const error = r.error ? paintAlert(paint, r.error, aged) : undefined;
  return [join([base, facts, trees, pwd, cwd, error]), join([base, compact, pwd, cwd, error]),
    join([base, pwd, cwd, error]), join([branch, pwd, cwd, error]), join([pwd, cwd, error]), join([pwd, cwd]), pwd];
}
/** Model identity replaces the lower-left directory. Usage and costs stay on the right. */
export function modelUsageRow(view: View, width: number, paint: Paint): string {
  const m = view.model;
  const level = m.thinking ? thinkingLevel(paint, m.thinking) : undefined;
  const identity = (provider: boolean, thinking: boolean) => joinParts([
    (provider ? paint.fg("muted", `${m.provider}/`) : "") + paint.fg("text", m.model), thinking ? level : undefined,
  ], paint.fg("dim", " · "));
  const lefts = [identity(width >= 80, true), identity(false, true), identity(false, false)];
  const usage = m.tokens ? paint.fg("muted", m.tokens) : "";
  for (const left of lefts) {
    if (width >= 120) {
      const text = justify(left, usage, width);
      if (text !== undefined) return text;
    }
    if (visibleWidth(left) <= width) return left;
  }
  return fit(lefts.at(-1)!, width);
}
/** Pair the memory stack with quota rows. On narrow terminals keep separate rows, not overlapping columns. */
function quotaMemoryRows(view: View, width: number, paint: Paint, aged: Aged, now: number): QuotaRow[] {
  const quotas = view.quota ? quotaRows(view.quota, width, paint, aged, now) : [];
  const memory = view.memory.map(g => ({ group: g, candidates: [g.text, g.compact, g.minimal].map(text => g.alert ? paintAlert(paint, g, aged, text) : paint.fg("muted", text)) }));
  if (!memory.length) return quotas;
  if (width >= 100) {
    // Reserve the minimum memory width first; try richer forms in the remaining space.
    const reserve = Math.max(...memory.map(m => visibleWidth(m.candidates[2])));
    const leftWidth = width - reserve - 2;
    const lefts = view.quota && leftWidth >= 25 ? quotaRows(view.quota, leftWidth, paint, aged, now) : [];
    if (!quotas.length || lefts.length === quotas.length) {
      const paired = Array.from({ length: Math.max(lefts.length, memory.length) }, (_, i) => {
        const left = lefts[i], right = memory[i];
        if (!right) return quotas[i];
        const text = right.candidates.map(candidate => justify(left?.text ?? "", candidate, width)).find(s => s !== undefined);
        return text === undefined ? undefined : { text, alert: Boolean(left?.alert || right.group.alert), memory: true, account: left?.account, quiet: left?.quiet };
      });
      if (paired.every(row => row !== undefined)) return paired as QuotaRow[];
    }
  }
  return [...quotas, ...memory.map(m => ({ text: justify("", pick(m.candidates, width) ?? fit(m.candidates[2], width), width)!, alert: m.group.alert, memory: true }))];
}
/** Rows above the editor (location, bar) and rows below it (model, quotas, memory, services). */
export interface Sections { above: string[]; below: string[] }
/** The location, bar and model rows always stay. The other rows share what is left of `maximumRows`. */
const FIXED_ROWS = 3;
interface Budget { kept: QuotaRow[]; hint: boolean; dropped: string[] }
/**
 * Fit the optional rows into the row budget. Alert rows keep priority, then memory rows, then quiet rows in display order.
 * When quota rows do not fit, `no login` accounts drop first and the other accounts keep identity order.
 * The last quota row that stays shows `+N` for the N dropped accounts. `dropped` holds their labels for the report.
 */
function budgetRows(view: View, settings: Settings, width: number, paint: Paint, aged: Aged, now: number): Budget {
  const slots = Math.max(0, settings.maximumRows - FIXED_ROWS);
  const services = servicesRow(view, width, paint, aged, false);
  const select = (current: View) => {
    const quotas = quotaMemoryRows(current, width, paint, aged, now);
    const optional: QuotaRow[] = [...quotas, ...(services ? [services] : [])];
    // Keep alerts first, then the memory stack, then quiet quota and service rows.
    const ranked = optional.map((row, i) => ({ row, i })).sort((a, b) => Number(b.row.alert) - Number(a.row.alert) || Number(Boolean(b.row.memory)) - Number(Boolean(a.row.memory)) || a.i - b.i);
    const keep = new Set(ranked.slice(0, slots).map(r => r.i));
    const hint = optional.some((row, i) => !keep.has(i) && (row.alert || row.memory || (current.memory.length > 0 && i < quotas.length)));
    return { optional, keep, hint };
  };
  const first = select(view);
  const rows = first.optional.filter(row => row.account !== undefined);
  const room = first.optional.filter((row, i) => row.account !== undefined && first.keep.has(i)).length;
  if (!view.quota || room >= rows.length) return { kept: first.optional.filter((_, i) => first.keep.has(i)), hint: first.hint, dropped: [] };
  // Choose the accounts for the rows that stay: alerts, then accounts with a login, then `no login`; identity order inside each group.
  const order = rows.map((row, i) => ({ row, i })).sort((a, b) => Number(b.row.alert) - Number(a.row.alert) || Number(Boolean(a.row.quiet)) - Number(Boolean(b.row.quiet)) || a.i - b.i);
  const stay = new Set(order.slice(0, room).map(r => r.row.account!.trim()));
  const dropped = rows.map(row => row.account!.trim()).filter(label => !stay.has(label));
  const quota = { ...view.quota, accounts: view.quota.accounts.filter(a => stay.has(a.label)), more: dropped.length };
  const second = select({ ...view, quota });
  return { kept: second.optional.filter((_, i) => second.keep.has(i)), hint: first.hint || second.hint, dropped };
}
/** Labels of the quota accounts that the row budget drops at this width. The report uses this. */
export function droppedQuotaAccounts(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, now = Date.now()): string[] {
  let ctx: ContextState;
  try { ctx = context.state(); } catch { ctx = unknownContext; }
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return width >= 40 ? budgetRows(buildView(data, ctx, settings, now), settings, width, plainPaint, never, now).dropped : [];
}
/**
 * Compose the footer rows. Pure: the same inputs give the same rows. `aged` reports which alert keys have decayed.
 * The row texts do not depend on `stacked`; only the order and the section do.
 * Not stacked (v3): location and bar above the editor; model, quotas, memory, services below it.
 * Stacked (v4): all rows below the editor: model, location, bar, quotas, memory, services.
 * `maximumRows` counts both parts; quota rows keep priority over services. `minimumRows` pads below the editor.
 * Below 80 columns the narrow rules apply with the model row kept to 40 columns; below 40 the bar and one compact row; below 20 the bar only.
 */
function compose(stacked: boolean, data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint, now: number, aged: Aged): Sections {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return { above: [], below: [] };
  let ctx: ContextState, failed = false;
  try { ctx = context.state(); } catch { ctx = unknownContext; failed = true; }
  const view = buildView(data, ctx, settings, now);
  const bar = contextRow(ctx, view, width, paint, failed);
  const above: string[] = [], below: string[] = [];
  // The rows that v3 puts above the editor follow the first row below it in v4.
  const top = stacked ? below : above;
  if (width >= 40) {
    const { kept, hint } = budgetRows(view, settings, width, paint, aged, now);
    below.push(modelUsageRow(view, width, paint));
    top.push(locationRow(view, width, paint, aged, hint), bar);
    below.push(...kept.map(row => row.text));
  } else if (width >= 20) { below.push(compactRow(view, width, paint, aged)); top.push(bar); }
  else top.push(bar);
  const fitRows = (rows: string[]) => rows.map(line => fit(line, width));
  const lines = fitRows(below.slice(0, Math.max(0, settings.maximumRows - above.length)));
  while (above.length + lines.length < settings.minimumRows) lines.push("");
  return { above: fitRows(above), below: lines };
}
/** The v3 footer. Above the editor: location and agent state, bar. Below it: model and costs, quotas, memory, services. */
export function dashboardSections(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): Sections {
  return compose(false, data, context, settings, width, paint, now, aged);
}
/** The v4 footer. No row above the editor. Below it: model and costs, location and agent state, bar, quotas, memory, services. */
export const stackedSections: SectionLayout = (data, context, settings, width, paint = plainPaint, now = Date.now(), aged = never) =>
  compose(true, data, context, settings, width, paint, now, aged);
/** The v3 rows as one list in display order: the rows above the editor, then the rows below it. */
export function dashboardRows(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): string[] {
  const { above, below } = dashboardSections(data, context, settings, width, paint, now, aged);
  return [...above, ...below];
}
function marker(s: StatusSnapshot, now: number): string {
  const age = freshness(s, now);
  return s.state === "error" ? "ERR" : s.state === "warning" ? "WARN" : age === "stale" ? "STALE" : s.state === "unknown" ? "n/a" : "ok";
}
function serviceText(s: IntegrationSnapshot, now: number): string {
  const status = marker(s, now);
  if (s.source === "work") {
    const values = [status === "ok" ? "" : status,
      s.working === undefined ? "" : `working:${s.working}`, s.blocked === undefined ? "" : `blocked:${s.blocked}`,
      s.done === undefined ? "" : `done:${s.done}`, s.prompts === undefined ? "" : `prompts:${s.prompts}`,
      s.background === undefined ? "" : `background:${s.background}`, s.dirty === undefined ? "" : `dirty:${s.dirty}`,
      s.review ? "REVIEW" : "", s.deploy ? "DEPLOY" : ""];
    return `QUEUE ${values.filter(Boolean).join(" ")}`;
  }
  if (s.source === "MCP") return `MCP ${status} ${s.active ?? "?"}/${s.configured ?? "?"} failed:${s.failed ?? "?"}${s.failedNames?.length ? ` (${s.failedNames.join(",")})` : ""}`;
  return `${s.source} ${status}${s.index ? ` index:${s.index}` : ""}`;
}
/** Every value the footer hides stays here: tokens, cache, cost, host, session, paths, worktrees, all windows with absolute resets, counts, routing, freshness. */
export function detailedReport(data: DashboardSnapshot, context: ContextService, now = Date.now(), rows?: { settings: Settings; width: number }): string {
  const dropped = rows ? droppedQuotaAccounts(data, context, rows.settings, rows.width, now) : [];
  const s = data.session;
  let contextReport: string;
  try { contextReport = context.report().split("\n").map(safeText).join("\n"); }
  catch { contextReport = "CTX report unavailable"; }
  const freshnessLine = (name: string, snapshot: StatusSnapshot) => `${name}: ${marker(snapshot, now)}; checked:${snapshot.checkedAt || "never"}; lifetime:${snapshot.staleAfter}ms; ${snapshot.summary}`;
  const limits = data.limits;
  const windows = (a: NonNullable<typeof limits>["accounts"][number]) => a.windows.map(w => w.unavailable ? `${w.name} n/a` : `${w.name} ${Math.round(w.percent ?? 0)}%${w.resetsAt ? ` resets ${new Date(w.resetsAt).toISOString()} (${formatWhen(w.resetsAt)}, in ${formatRelative(w.resetsAt - now)})` : ""}`).join("; ");
  return [
    `MODEL ${s.state} ${s.provider}/${s.model} think:${s.thinking}`,
    `Session:${s.session}; host:${s.hostname}; remote:${s.remote ? "yes" : "no"}; duration:${Math.max(0, Math.floor((now - s.startedAt) / 1000))}s`,
    `Started in:${s.startedIn}`,
    `Cwd:${s.cwd}`,
    `Input:${s.input}; output:${s.output}; cache-read:${s.cacheRead}; cache-write:${s.cacheWrite}; reported cost:$${s.cost.toFixed(6)}`,
    `TOOLS active:${s.tools}; published extension statuses:${data.extensionStatuses}; prompts:${s.pending ? "pending (count unavailable)" : "none"}`,
    data.languageStatus ?? "",
    data.conflict ? "Warning: Powerline may also own the footer. Disable one footer extension." : "Footer ownership: ops-footer when enabled; Pi default when disabled.",
    freshnessLine("REPO", data.git),
    data.git.repo ? `Repository:${data.git.repo}; branch:${data.git.branch}; staged:${data.git.staged}; unstaged:${data.git.unstaged}; untracked:${data.git.untracked}; ahead:${data.git.ahead ?? "n/a"}; behind:${data.git.behind ?? "n/a"}; worktrees:${data.git.worktrees}; current:${data.git.worktree}` : "",
    limits ? [freshnessLine("LIMITS", limits), `route:${limits.route.selected ?? "n/a"} (${limits.route.state})`,
      ...limits.accounts.map(a => a.login === false ? `${a.label}: no login` : `${a.label}: ${a.state}; ${windows(a) || "no windows"}${a.plan ? `; plan:${a.plan}` : ""}`)].join("\n") : "LIMITS unavailable",
    data.anthropic ? [freshnessLine("ANTHROPIC", data.anthropic), `source:${data.anthropic.source ?? "n/a"}; plan:${data.anthropic.plan ?? "n/a"}`,
      ...data.anthropic.accounts.map(a => `${a.label}: ${a.state}; ${windows(a) || "no windows"}`)].join("\n") : "ANTHROPIC not detected (see /anthropic-usage)",
    data.copilot ? [freshnessLine("COPILOT", data.copilot), `source:${data.copilot.source ?? "n/a"}; plan:${data.copilot.plan ?? "n/a"}`,
      ...data.copilot.accounts.map(a => `${a.label}: ${a.state}; ${a.windows.map(w => w.unavailable ? `${w.name} n/a` : `${w.name} ${Math.round(w.percent ?? 0)}%${w.entitlement !== undefined && w.remaining !== undefined ? ` (${Math.round(w.entitlement - w.remaining)}/${Math.round(w.entitlement)} used)` : ""}${w.resetsAt ? ` resets ${new Date(w.resetsAt).toISOString()} (in ${formatRelative(w.resetsAt - now)})` : ""}`).join("; ") || "no windows"}`)].join("\n") : "COPILOT not detected (see /copilot-usage)",
    dropped.length ? `Quota rows not shown: ${dropped.join(", ")}. The row budget is maximumRows:${rows!.settings.maximumRows} in the ops-footer settings; a larger value shows them.` : "",
    ...data.integrations.map(i => freshnessLine(i.source, i) + "; " + serviceText(i, now)),
    ...memoryGroups(data, now).map(g => g.text),
    data.memory?.wiki ? "Wiki suggestions are manual advice after edits or capture reminders; no task runs automatically. Tool activity excludes unreported background work." : "",
    "Retry backoff has no public extension event. The state stays working until agent_settled.",
    "The footer hides healthy, zero-value, and implementation facts. This report retains them.",
    contextReport,
  ].filter(Boolean).join("\n");
}
export type Layout = typeof dashboardRows;
export type SectionLayout = typeof dashboardSections;
/** A single-list layout (v2 and the prototypes a, b, c) renders every row below the editor. */
export const belowOnly = (layout: Layout): SectionLayout => (...args) => ({ above: [], below: layout(...args) });
/** Width and version cache plus alert decay. The decay map is the only state; row composition stays pure. `layout` selects the row composer; the runtime passes the session layout. */
export class FooterRenderer {
  private cache?: { width: number; version: number; sections: Sections };
  private firstSeen = new Map<string, number>();
  private snapshot: () => DashboardSnapshot;
  private context: ContextService;
  private settings: () => Settings;
  private paint: Paint;
  private clock: () => number;
  private layout: () => SectionLayout;
  constructor(snapshot: () => DashboardSnapshot, context: ContextService, settings: () => Settings, paint: Paint, clock = Date.now, layout: () => SectionLayout = () => dashboardSections) {
    this.snapshot = snapshot; this.context = context; this.settings = settings; this.paint = paint; this.clock = clock; this.layout = layout;
  }
  sections(width: number, version: number): Sections {
    if (this.cache?.width === width && this.cache.version === version) return this.cache.sections;
    const now = this.clock(), data = this.snapshot(), settings = this.settings();
    const keys = new Set(alertKeys(data, this.context, settings, now));
    for (const key of [...this.firstSeen.keys()]) if (!keys.has(key)) this.firstSeen.delete(key);
    for (const key of keys) if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
    const aged: Aged = key => this.firstSeen.has(key) && now - this.firstSeen.get(key)! >= ALERT_DECAY_MS;
    const sections = this.layout()(data, this.context, settings, width, this.paint, now, aged);
    this.cache = { width, version, sections };
    return sections;
  }
  /** Rows below the editor (the Pi footer). */
  render(width: number, version: number): string[] { return this.sections(width, version).below; }
  /** Rows above the editor (a Pi widget). */
  renderAbove(width: number, version: number): string[] { return this.sections(width, version).above; }
  invalidate(): void { this.cache = undefined; }
}
