import type { ContextState } from "../../context-meter/snapshot.ts";
import { plainPaint, type Paint } from "../paint.ts";
import { compactRow, contextRow, never, paintAlert, quotaRow, servicesRow, unknownContext, type Aged } from "../render.ts";
import type { Settings } from "../settings.ts";
import type { ContextService, DashboardSnapshot } from "../types.ts";
import { buildView, type View } from "../view.ts";
import { fit, join as joinParts, justify, type Candidate } from "../widgets.ts";

/**
 * Layout v2: the bar first, repository and model on one row, quota chips on their own row, services last.
 * Kept verbatim for `/ops-footer layout v2`; the quota and services rows are shared with v3 through render.ts.
 */
/** Row 2: repository facts left, model and work state right. Stable facts stay muted; only changes and actionable state brighten. */
function repoModelRow(view: View, width: number, paint: Paint, aged: Aged, hint: boolean): string {
  const r = view.repo, m = view.model;
  const sep = paint.fg("dim", " · ");
  const join = (parts: readonly (string | undefined)[], separator = sep) => joinParts(parts, separator);
  const base = r.name ? paint.fg("muted", `${r.name} ${r.branch ?? ""}`.trim()) : undefined;
  const facts = r.facts.length ? paint.fg("accent", r.facts.join(" · ")) : undefined;
  const trees = r.worktrees ? paint.fg("accent", r.worktrees) : undefined;
  const cwd = r.cwd ? paint.fg("muted", r.cwd) : undefined;
  const error = r.error ? paintAlert(paint, r.error, aged) : undefined;
  const branch = r.branch ? paint.fg("muted", r.branch) : undefined;
  const compact = r.compactFacts.length ? paint.fg("accent", r.compactFacts.join(" · ")) : undefined;
  const terse = r.compactFacts.length ? paint.fg("accent", r.compactFacts[0]) : undefined;
  const lefts = [join([base, facts, trees, cwd, error]), join([base, facts, trees, error]), join([branch, facts, trees, error]), join([branch, compact, error]), join([branch, terse, error]), join([branch, error])];
  const stateText = m.state.alert ? paintAlert(paint, m.state.alert, aged) : paint.fg(m.state.kind, m.state.text);
  const queued = m.queued ? paint.fg("accent", "queued") : undefined;
  const report = hint ? paint.fg("warning", "/ops-footer report") : undefined;
  const dim = (text?: string) => text ? paint.fg("dim", text) : undefined;
  const model = (provider: boolean, thinking: boolean, extras: boolean) => join([
    paint.fg("muted", provider ? `${m.provider}/${m.model}` : m.model), thinking ? dim(m.thinking) : undefined, stateText, queued,
    extras ? dim(m.duration) : undefined, extras ? dim(m.session) : undefined, extras ? dim(m.host ? `@${m.host}` : undefined) : undefined, report,
  ]);
  const rights: Candidate[] = [
    { text: join([m.tokens ? paint.fg("muted", m.tokens) : undefined, model(true, true, true)], "  "), minWidth: 120 },
    { text: model(true, true, true), minWidth: 120 }, { text: model(false, true, true) }, { text: model(false, false, true) },
    { text: model(false, false, false) }, { text: join([stateText, queued, report]) }, { text: stateText },
  ];
  // Prefer the model name over verbose Git facts; compact facts still show that the tree changed.
  const pairs: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [2, 5], [3, 5], [4, 5], [4, 6], [5, 4], [5, 5], [5, 6]];
  for (const [l, r] of pairs) {
    if ((rights[r].minWidth ?? 0) > width) continue;
    const text = justify(lefts[l], rights[r].text, width);
    if (text !== undefined) return text;
  }
  return fit(join([lefts[5], rights[6].text], "  "), width);
}
/**
 * Compose the v2 footer. Pure: the same inputs give the same rows. `aged` reports which alert keys have decayed.
 * Row priority for the budget: bar, repository/model, services and alerts, quota. Display order: bar, repository/model, quota, services.
 */
export function dashboardRows(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return [];
  let ctx: ContextState, failed = false;
  try { ctx = context.state(); } catch { ctx = unknownContext; failed = true; }
  const view = buildView(data, ctx, settings, now);
  const rows: string[] = [contextRow(ctx, view, width, paint, failed)];
  if (width >= 40) {
    const quota = view.quota ? quotaRow(view.quota, width, paint, aged, now) : undefined;
    const services = servicesRow(view, width, paint, aged);
    const optional = [{ key: "services", row: services, priority: 2 }, { key: "quota", row: quota, priority: 3 }].filter(o => o.row);
    const kept = new Set(optional.sort((a, b) => a.priority - b.priority).slice(0, Math.max(0, settings.maximumRows - 2)).map(o => o.key));
    const hint = optional.some(o => !kept.has(o.key) && o.row!.alert);
    rows.push(repoModelRow(view, width, paint, aged, hint));
    if (quota && kept.has("quota")) rows.push(quota.text);
    if (services && kept.has("services")) rows.push(services.text);
  } else if (width >= 20) rows.push(compactRow(view, width, paint, aged));
  const lines = rows.slice(0, Math.max(1, settings.maximumRows)).map(line => fit(line, width));
  while (lines.length < settings.minimumRows) lines.push("");
  return lines;
}
