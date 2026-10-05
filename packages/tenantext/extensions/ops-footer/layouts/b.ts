import { palette, segmentBar, type Rgb, type Segment } from "../../context-meter/bar.ts";
import { allocate } from "../../context-meter/snapshot.ts";
import { plainPaint, type Paint } from "../paint.ts";
import { compactRow, never, type Aged } from "../render.ts";
import type { Settings } from "../settings.ts";
import type { ContextService, DashboardSnapshot } from "../types.ts";
import type { QuotaView } from "../view.ts";
import { fit, join, justify } from "../widgets.ts";
import { alertInk, finish, modelIdentity, prepare, type Scene } from "./shared.ts";

/**
 * Layout B "instrument panel": the context bar, a second full-width quota strip with one proportional fill per window,
 * then two rows of chips whose right column is aligned so values line up. Facts read as gauges, not sentences.
 */
const strip: Record<"normal" | "low" | "exhausted" | "unavailable" | "lowAged" | "exhaustedAged", { fill: Rgb; onFill: Rgb; onRest: Rgb }> = {
  normal: { fill: "70;118;136", onFill: "226;236;242", onRest: "168;180;196" },
  low: { fill: "204;146;60", onFill: "24;18;8", onRest: "255;196;96" }, lowAged: { fill: "124;104;70", onFill: "236;228;214", onRest: "170;150;120" },
  exhausted: { fill: "196;64;64", onFill: "255;238;238", onRest: "255;122;122" }, exhaustedAged: { fill: "128;72;72", onFill: "240;226;226", onRest: "180;130;130" },
  unavailable: { fill: "56;62;74", onFill: "130;138;152", onRest: "130;138;152" },
};
const divider: Rgb = "20;28;40";
interface Region { forms: string[]; percent: number; ink: typeof strip[keyof typeof strip] }
/** Row 2: equal regions per window in identity order; the fill inside each region is the remaining percent with the label on it. */
function quotaStrip(quota: QuotaView, scene: Scene): string {
  const { paint, aged, width } = scene;
  const regions: Region[] = quota.accounts.flatMap(a => {
    if (a.alert) return [{ forms: [`${a.label} ✗ error`, `${a.short} ✗ error`, `${a.short} ✗`, "✗"], percent: 100, ink: strip[aged(a.alert.key) ? "exhaustedAged" : "exhausted"] }];
    if (a.login === false) return [{ forms: [`${a.label} no login`, `${a.short} no login`, a.short], percent: 100, ink: strip.unavailable }];
    return a.windows.map(w => {
      if (w.level === "unavailable") return { forms: [`${a.label} ${w.name} n/a`, `${a.short} ${w.name} n/a`, `${w.name} n/a`, "n/a"], percent: 100, ink: strip.unavailable };
      const pct = `${Math.round(w.percent ?? 0)}%`, glyph = w.alert ? `${w.alert.glyph} ` : "";
      const key = w.level === "normal" ? "normal" : w.alert && aged(w.alert.key) ? `${w.level}Aged` as const : w.level;
      return { forms: [`${glyph}${a.label} ${w.name} ${pct}`, `${glyph}${a.short} ${w.name} ${pct}`, `${glyph}${w.name} ${pct}`, `${glyph}${pct}`, pct], percent: w.percent ?? 0, ink: strip[key] };
    });
  });
  const cells = allocate(regions.map(() => 1), width);
  const segments: Segment[] = [];
  regions.forEach((r, i) => {
    let room = cells[i];
    if (i > 0 && room > 0) { segments.push({ cells: 1, forms: [], bg: divider, fg: "128;146;172", fill: "│" }); room--; }
    const filled = Math.round(Math.min(100, Math.max(0, r.percent)) / 100 * room);
    // The label sits in the larger half of the region so a low fill still names its account and window.
    const labelOnFill = filled >= room - filled;
    segments.push({ cells: filled, forms: labelOnFill ? r.forms : [], bg: r.ink.fill, fg: r.ink.onFill, bold: r.ink !== strip.normal && r.ink !== strip.unavailable });
    segments.push({ cells: room - filled, forms: labelOnFill ? [] : r.forms, bg: palette.free, fg: r.ink.onRest, fill: "·" });
  });
  return segmentBar({ width, color: paint.color, segments });
}
interface Level { provider: boolean; thinking: boolean; extras: boolean; tokens: boolean; facts: "full" | "compact" | "none"; name: boolean; cwd: boolean; services: "full" | "compact" | "glyphs"; route: boolean; minWidth?: number }
/** Rows 3 and 4: identity and repository on the left, state and usage on the right; the right column starts at one shared column. */
function chipRows(scene: Scene): string[] {
  const { view, paint, width } = scene;
  const m = view.model, r = view.repo, q = view.quota;
  const sep = paint.fg("dim", " · ");
  const stateGlyph = m.state.alert ? alertInk(scene, m.state.alert) : `${paint.fg(m.state.kind, "●")} ${paint.fg(m.state.kind, m.state.text)}`;
  const queued = m.queued ? paint.fg("accent", "queued") : undefined;
  const dim = (text?: string) => text ? paint.fg("dim", text) : undefined;
  const build = (o: Level): { lefts: string[]; rights: string[] } => {
    const left3 = paint.fg("muted", o.provider ? modelIdentity(view, 120, o.thinking) : modelIdentity(view, 80, o.thinking));
    const right3 = join([stateGlyph, queued, o.extras ? dim(m.duration) : undefined, o.extras ? dim(m.session) : undefined, o.extras ? dim(m.host ? `@${m.host}` : undefined) : undefined], sep);
    const repo = r.name && o.name ? paint.fg("muted", `${r.name} ${r.branch ?? ""}`.trim()) : r.branch ? paint.fg("muted", r.branch) : undefined;
    const facts = o.facts === "full" && r.facts.length ? paint.fg("accent", r.facts.join(" · ")) : o.facts === "compact" && r.compactFacts.length ? paint.fg("accent", r.compactFacts[0]) : undefined;
    const trees = o.facts !== "none" && r.worktrees ? paint.fg("accent", r.worktrees) : undefined;
    const left4 = join([repo, facts, trees, o.cwd && r.cwd ? paint.fg("muted", r.cwd) : undefined, r.error ? alertInk(scene, r.error) : undefined], sep);
    const groups = view.services.filter(g => o.services !== "glyphs" || g.alert);
    const services = groups.map(g => {
      const text = o.services === "full" ? g.text : o.services === "compact" ? g.compact : g.glyph;
      return text ? (g.alert ? alertInk(scene, g, text) : paint.fg("dim", text)) : undefined;
    });
    const route = o.route && q?.route ? (q.route.alert ? alertInk(scene, q.route.alert) : paint.fg(q.route.kind, q.route.text)) : undefined;
    const right4 = join([...services, route, o.route && q?.stale ? paint.fg("dim", "stale") : undefined, o.tokens ? dim(m.tokens) : undefined], "  ");
    return { lefts: [left3, left4], rights: [right3, right4] };
  };
  const levels: Level[] = [
    { provider: true, thinking: true, extras: true, tokens: true, facts: "full", name: true, cwd: true, services: "full", route: true, minWidth: 120 },
    { provider: true, thinking: true, extras: true, tokens: false, facts: "full", name: true, cwd: true, services: "full", route: true, minWidth: 120 },
    { provider: false, thinking: true, extras: true, tokens: false, facts: "full", name: true, cwd: false, services: "full", route: true },
    { provider: false, thinking: true, extras: true, tokens: false, facts: "compact", name: true, cwd: false, services: "compact", route: true },
    { provider: false, thinking: false, extras: false, tokens: false, facts: "compact", name: false, cwd: false, services: "compact", route: false },
    { provider: false, thinking: false, extras: false, tokens: false, facts: "compact", name: false, cwd: false, services: "glyphs", route: false },
    { provider: false, thinking: false, extras: false, tokens: false, facts: "none", name: false, cwd: false, services: "glyphs", route: false },
  ];
  // One terseness level for both rows, so the right column reads as one column: the same facts at the same density.
  for (const level of levels) {
    if ((level.minWidth ?? 0) > width) continue;
    const { lefts, rights } = build(level);
    const rows = lefts.map((l, i) => justify(l, rights[i], width));
    if (rows.every(r => r !== undefined)) return rows as string[];
  }
  const { lefts, rights } = build(levels.at(-1)!);
  return lefts.map((l, i) => justify(l, rights[i], width) ?? fit(join([l, rights[i]], "  "), width));
}
export function dashboardRows(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): string[] {
  const scene = prepare(data, context, settings, width, paint, now, aged);
  if (!scene) return [];
  const { view, bar } = scene;
  if (scene.width < 20) return finish([bar], scene);
  const quota = view.quota && view.quota.accounts.length ? quotaStrip(view.quota, scene) : undefined;
  if (scene.width < 40) return finish([bar, quota, compactRow(view, scene.width, paint, aged)], scene);
  return finish([bar, quota, ...chipRows(scene)], scene);
}
