import { palette, type Rgb } from "../../context-meter/bar.ts";
import { plainPaint, type Paint } from "../paint.ts";
import { compactRow, never, type Aged } from "../render.ts";
import type { Settings } from "../settings.ts";
import type { ContextService, DashboardSnapshot } from "../types.ts";
import { formatRelative, type QuotaView, type QuotaWindow } from "../view.ts";
import { fit, join, pick, type Candidate } from "../widgets.ts";
import { agentAlert, alertInk, alertWord, finish, modelIdentity, prepare, type Scene } from "./shared.ts";

/**
 * Layout A "nano minimal": the model identity alone on top, the bar, and one muted line for every other fact.
 * An alert is one bright word at the start of the fact line; quotas are five-cell fills; nothing else brightens.
 */
const FILL_CELLS = 5;
const fillInk: Record<"normal" | "low" | "exhausted" | "lowAged" | "exhaustedAged", Rgb> = { normal: "70;118;136", low: "204;146;60", exhausted: "196;64;64", lowAged: "124;104;70", exhaustedAged: "128;72;72" };
const unavailableInk: Rgb = "56;62;74";

/** A five-cell fill whose lit cells are the remaining percent. Plain mode: `▮▮▮▮▯`. */
function miniFill(w: QuotaWindow, paint: Paint, aged: boolean): string {
  if (w.level === "unavailable") return paint.color ? paint.block(unavailableInk, "130;138;152", " n/a ") : " n/a ";
  const lit = Math.round(Math.min(100, Math.max(0, w.percent ?? 0)) / 100 * FILL_CELLS);
  if (!paint.color) return "▮".repeat(lit) + "▯".repeat(FILL_CELLS - lit);
  const key = w.level === "normal" ? "normal" : aged ? `${w.level}Aged` as const : w.level;
  const fill = lit ? paint.block(fillInk[key], "226;236;242", " ".repeat(lit)) : "";
  const rest = lit < FILL_CELLS ? paint.block(palette.free, "168;180;196", " ".repeat(FILL_CELLS - lit)) : "";
  return fill + rest;
}
/** `C1 ▮▮▮▮▯ ▮▮▮▮▯  C2 ⚠▮▯▯▯▯ ↺ 35m ▮▮▮▯▯`: one fill per window in identity order, a glyph before a low window. */
function quotaFills(quota: QuotaView, scene: Scene, resets: boolean, tail: boolean): string | undefined {
  const { paint, aged, now } = scene;
  const groups = quota.accounts.map(a => {
    const name = paint.fg("muted", a.short);
    if (a.alert) return `${name} ${alertInk(scene, a.alert, "✗ error")}`;
    if (a.login === false) return `${name} ${paint.fg("dim", "no login")}`;
    const fills = a.windows.map(w => {
      const isAged = w.alert ? aged(w.alert.key) : false;
      const glyph = w.alert ? alertInk(scene, w.alert, w.alert.glyph) : "";
      const reset = resets && w.alert && w.resetsAt !== undefined ? " " + paint.fg("dim", `↺ ${formatRelative(w.resetsAt - now)}`) : "";
      return `${glyph}${miniFill(w, paint, isAged)}${reset}`;
    });
    return `${name} ${fills.join(" ")}`;
  });
  const extras = tail ? [quota.route ? (quota.route.alert ? alertInk(scene, quota.route.alert) : paint.fg(quota.route.kind, quota.route.text)) : undefined, quota.stale ? paint.fg("dim", "stale") : undefined] : [];
  return join([...groups, ...extras], "  ") || undefined;
}
interface FactOptions { facts: "full" | "compact" | "none"; name: boolean; cwd: boolean; resets: boolean; tail: boolean; quota: boolean; tokens: boolean }
/** Row 3: alert word, repository, quota fills, state, usage. Verbose to terse candidates; the first that fits wins. */
function factRow(scene: Scene): string {
  const { view, paint, width } = scene;
  const r = view.repo, m = view.model;
  const sep = paint.fg("dim", " · ");
  const [lead, ...rest] = view.alerts;
  const word = lead ? alertInk(scene, lead, `${lead.glyph} ${alertWord(lead)}`.trim()) : undefined;
  const glyphs = [...new Set(rest.map(a => a.glyph).filter(g => g && g !== lead?.glyph))].map(g => alertInk(scene, rest.find(a => a.glyph === g)!, g)).join(" ") || undefined;
  const alertLead = join([word, glyphs], " ");
  const state = m.state.alert ? undefined : paint.fg(m.state.kind, m.state.text);
  const queued = m.queued ? paint.fg("accent", "queued") : undefined;
  const build = (o: FactOptions): string => {
    const repo = r.name && o.name ? paint.fg("muted", `${r.name} ${r.branch ?? ""}`.trim()) : r.branch ? paint.fg("muted", r.branch) : undefined;
    const facts = o.facts === "full" && r.facts.length ? paint.fg("accent", r.facts.join(" · ")) : o.facts === "compact" && r.compactFacts.length ? paint.fg("accent", r.compactFacts[0]) : undefined;
    const trees = o.facts !== "none" && r.worktrees ? paint.fg("accent", r.worktrees) : undefined;
    const cwd = o.cwd && r.cwd ? paint.fg("muted", r.cwd) : undefined;
    const error = r.error ? alertInk(scene, r.error) : undefined;
    const repoGroup = join([repo, facts, trees, cwd, error], sep) || undefined;
    const quota = o.quota && view.quota ? quotaFills(view.quota, scene, o.resets, o.tail) : undefined;
    const tokens = o.tokens && m.tokens ? paint.fg("dim", m.tokens) : undefined;
    return join([alertLead, repoGroup, quota, join([state, queued], sep) || undefined, tokens], "  ");
  };
  const candidates: Candidate[] = [
    { text: build({ facts: "full", name: true, cwd: true, resets: true, tail: true, quota: true, tokens: true }), minWidth: 120 },
    { text: build({ facts: "full", name: true, cwd: true, resets: true, tail: true, quota: true, tokens: false }) },
    { text: build({ facts: "full", name: true, cwd: false, resets: true, tail: false, quota: true, tokens: false }) },
    { text: build({ facts: "compact", name: true, cwd: false, resets: false, tail: false, quota: true, tokens: false }) },
    { text: build({ facts: "compact", name: false, cwd: false, resets: false, tail: false, quota: true, tokens: false }) },
    { text: build({ facts: "compact", name: false, cwd: false, resets: false, tail: false, quota: false, tokens: false }) },
    { text: join([alertLead, state], "  ") },
  ];
  return pick(candidates, width) ?? fit(candidates.at(-1)!.text, width);
}
/** Row 4, only when a service alerts or more than one alert exists: every non-agent alert in words, then quiet service facts. */
function alertRow(scene: Scene): string | undefined {
  const { view, paint, width, now } = scene;
  const alerts = view.alerts.filter(a => !agentAlert(a));
  if (!view.services.some(g => g.alert) && view.alerts.length <= 1) return undefined;
  const resets = new Map<string, number>();
  for (const a of view.quota?.accounts ?? []) for (const w of a.windows) if (w.alert && w.resetsAt !== undefined) resets.set(w.alert.key, w.resetsAt);
  const reset = (key: string) => resets.has(key) ? " " + paint.fg("dim", `↺ ${formatRelative(resets.get(key)! - now)}`) : "";
  const quiet = view.services.filter(g => !g.alert);
  const full = join([...alerts.map(a => alertInk(scene, a) + reset(a.key)), ...quiet.map(g => paint.fg("dim", g.text))], "  ");
  const compact = join([...alerts.map(a => alertInk(scene, a, a.compact)), ...quiet.map(g => paint.fg("dim", g.compact))], "  ");
  const glyphs = alerts.filter(a => a.glyph).map(a => alertInk(scene, a, a.glyph)).join(" ");
  if (!full) return undefined;
  return pick([full, compact, glyphs], width) ?? fit(compact, width);
}
export function dashboardRows(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): string[] {
  const scene = prepare(data, context, settings, width, paint, now, aged);
  if (!scene) return [];
  const { view, bar } = scene;
  if (scene.width < 20) return finish([bar], scene);
  const duration = scene.width >= 80 && view.model.duration ? "  " + paint.fg("dim", view.model.duration) : "";
  const modelRow = fit(paint.fg("muted", modelIdentity(view, scene.width)) + duration, scene.width);
  if (scene.width < 40) return finish([modelRow, bar, compactRow(view, scene.width, paint, aged)], scene);
  return finish([modelRow, bar, factRow(scene), alertRow(scene)], scene);
}
