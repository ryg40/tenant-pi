import type { Rgb } from "../../context-meter/bar.ts";
import { plainPaint, type Paint } from "../paint.ts";
import { never, type Aged } from "../render.ts";
import type { Settings } from "../settings.ts";
import type { ContextService, DashboardSnapshot } from "../types.ts";
import { formatRelative, type Alert, type QuotaAccount } from "../view.ts";
import { fit, join, justify, pick } from "../widgets.ts";
import { finish, modelIdentity, prepare, type Scene } from "./shared.ts";

/**
 * Layout C "status line": the bar, then one powerline-style row of solid segments. Each segment's background carries
 * its own severity; calm segments alternate two slates so they delineate without separators. Text stays short.
 */
const bg = { slate: "36;44;58" as Rgb, slateMid: "52;62;80" as Rgb, slateBright: "62;74;96" as Rgb, amber: "204;146;60" as Rgb, amberAged: "124;104;70" as Rgb, red: "196;64;64" as Rgb, redAged: "128;72;72" as Rgb };
const fg = { muted: "150;162;180" as Rgb, dim: "104;114;130" as Rgb, light: "226;236;242" as Rgb, accent: "138;180;255" as Rgb, onAmber: "24;18;8" as Rgb, onAmberAged: "236;228;214" as Rgb, onRed: "255;238;238" as Rgb, onRedAged: "240;226;226" as Rgb };
interface Part { text: string; fg: Rgb }
interface Block { parts: Part[]; bg?: Rgb; severity?: "warning" | "error"; aged?: boolean }
/** One solid segment. Plain mode brackets it: `[ ● idle ]`. Calm blocks alternate two slates by position. */
function segment(block: Block, index: number, paint: Paint): string {
  const parts = block.parts.filter(p => p.text);
  if (!paint.color) return `[ ${parts.map(p => p.text).join("")} ]`;
  const back = block.severity === "error" ? (block.aged ? bg.redAged : bg.red) : block.severity === "warning" ? (block.aged ? bg.amberAged : bg.amber) : block.bg ?? (index % 2 ? bg.slateMid : bg.slate);
  const onSeverity = block.severity === "error" ? (block.aged ? fg.onRedAged : fg.onRed) : block.severity === "warning" ? (block.aged ? fg.onAmberAged : fg.onAmber) : undefined;
  return parts.map((p, i) => paint.block(back, onSeverity ?? p.fg, `${i === 0 ? " " : ""}${p.text}${i === parts.length - 1 ? " " : ""}`)).join("");
}
const alertBlock = (scene: Scene, alert: Alert, text = alert.text): Block => ({ parts: [{ text, fg: fg.light }], severity: alert.kind === "accent" ? undefined : alert.kind, aged: scene.aged(alert.key) });
interface Level { provider: boolean; thinking: boolean; facts: "full" | "compact" | "none"; name: boolean; cwd: boolean; windows: "all" | "first" | "none"; resets: boolean; services: "full" | "compact" | "glyphs" | "none"; tail: "full" | "route" | "duration" | "none"; minWidth?: number; model?: false }
function stateBlock(scene: Scene): Block {
  const m = scene.view.model;
  const queued = m.queued ? { text: " · queued", fg: fg.accent } : { text: "", fg: fg.accent };
  if (m.state.alert) return { parts: [{ text: m.state.alert.key === "agent:waiting" ? "⌨ INPUT" : "✗ ERROR", fg: fg.light }, queued], severity: m.state.alert.kind === "accent" ? undefined : m.state.alert.kind, aged: scene.aged(m.state.alert.key) };
  const ink = m.state.kind === "dim" ? fg.muted : fg.accent;
  return { parts: [{ text: `● ${m.state.text}`, fg: ink }, queued], bg: bg.slateMid };
}
function branchBlock(scene: Scene, o: Level): Block | undefined {
  const r = scene.view.repo;
  if (r.error) return alertBlock(scene, r.error, "✗ git");
  const name = r.name && o.name ? `${r.name} ${r.branch ?? ""}`.trim() : r.branch;
  if (!name) return undefined;
  const facts = o.facts === "full" ? [...r.facts, ...(r.worktrees ? [r.worktrees] : [])] : o.facts === "compact" ? [...r.compactFacts.slice(0, 1), ...(r.worktrees ? [r.worktrees] : [])] : [];
  const dirty = facts.length > 0;
  return { parts: [{ text: name, fg: fg.muted }, { text: dirty ? ` · ${facts.join(" · ")}` : "", fg: fg.accent }, { text: o.cwd && r.cwd ? ` · ${r.cwd}` : "", fg: fg.muted }], bg: dirty ? bg.slateBright : undefined };
}
function quotaBlock(scene: Scene, a: QuotaAccount, o: Level): Block | undefined {
  if (a.alert) return alertBlock(scene, a.alert, `${a.short} ✗ error`);
  if (o.windows === "none") return undefined;
  if (a.login === false) return { parts: [{ text: `${a.short} `, fg: fg.muted }, { text: "no login", fg: fg.dim }], severity: undefined, aged: false };
  const windows = o.windows === "all" ? a.windows : a.windows.slice(0, 1);
  if (!windows.length) return undefined;
  const text = windows.map(w => {
    if (w.level === "unavailable") return `${w.name} n/a`;
    const reset = o.resets && w.alert && w.resetsAt !== undefined ? ` ↺ ${formatRelative(w.resetsAt - scene.now)}` : "";
    return `${w.alert ? `${w.alert.glyph} ` : ""}${w.name} ${Math.round(w.percent ?? 0)}%${reset}`;
  }).join(" · ");
  const worst = a.windows.find(w => w.level === "exhausted")?.alert ?? a.windows.find(w => w.level === "low")?.alert;
  return { parts: [{ text: `${a.short} `, fg: fg.muted }, { text, fg: fg.light }], severity: worst?.kind === "accent" ? undefined : worst?.kind, aged: worst ? scene.aged(worst.key) : false };
}
/** Row 2: model, state, branch, quota, alerting services as solid segments; a dim right-aligned tail. */
function statusRow(scene: Scene): { text: string; services: boolean; quota: boolean } {
  const { view, paint, width } = scene;
  const m = view.model;
  const levels: Level[] = [
    { provider: true, thinking: true, facts: "full", name: true, cwd: true, windows: "all", resets: true, services: "full", tail: "full", minWidth: 120 },
    { provider: true, thinking: true, facts: "full", name: true, cwd: true, windows: "all", resets: true, services: "full", tail: "route", minWidth: 120 },
    { provider: true, thinking: true, facts: "compact", name: true, cwd: false, windows: "all", resets: false, services: "compact", tail: "duration", minWidth: 120 },
    { provider: false, thinking: true, facts: "full", name: true, cwd: false, windows: "all", resets: false, services: "full", tail: "route" },
    { provider: false, thinking: true, facts: "compact", name: true, cwd: false, windows: "all", resets: false, services: "compact", tail: "duration" },
    { provider: false, thinking: false, facts: "compact", name: false, cwd: false, windows: "first", resets: false, services: "compact", tail: "duration" },
    { provider: false, thinking: false, facts: "compact", name: false, cwd: false, windows: "first", resets: false, services: "glyphs", tail: "none" },
    { provider: false, thinking: false, facts: "compact", name: false, cwd: false, windows: "none", resets: false, services: "glyphs", tail: "none" },
    { provider: false, thinking: false, facts: "none", name: false, cwd: false, windows: "none", resets: false, services: "none", tail: "none" },
    { provider: false, thinking: false, facts: "none", name: false, cwd: false, windows: "none", resets: false, services: "none", tail: "none", model: false },
  ];
  const build = (o: Level) => {
    const blocks: (Block | undefined)[] = [
      o.model === false ? undefined : { parts: [{ text: o.provider ? modelIdentity(view, 120, o.thinking) : modelIdentity(view, 80, o.thinking), fg: fg.muted }], bg: bg.slate },
      stateBlock(scene), branchBlock(scene, o),
      ...(view.quota?.accounts ?? []).map(a => quotaBlock(scene, a, o)),
      ...(o.services === "none" ? [] : view.services.filter(g => g.alert).map(g => alertBlock(scene, g, o.services === "full" ? g.text : o.services === "compact" ? g.compact : g.glyph || g.compact))),
    ];
    const left = blocks.filter((b): b is Block => b !== undefined).map((b, i) => segment(b, i, paint)).join("");
    const route = view.quota?.route ? (view.quota.route.alert ? scene.paint.fg(scene.aged(view.quota.route.alert.key) ? "muted" : "error", view.quota.route.text) : paint.fg("dim", view.quota.route.text)) : undefined;
    const stale = view.quota?.stale ? paint.fg("dim", "stale") : undefined;
    const dim = (text?: string) => text ? paint.fg("dim", text) : undefined;
    const tail = o.tail === "full" ? join([route, stale, dim(m.tokens), dim(m.duration)], paint.fg("dim", " · "))
      : o.tail === "route" ? join([route, stale, dim(m.duration)], paint.fg("dim", " · ")) : o.tail === "duration" ? dim(m.duration) ?? "" : "";
    return { left, tail, services: o.services !== "none", quota: o.windows !== "none" };
  };
  for (const level of levels) {
    if ((level.minWidth ?? 0) > width) continue;
    const { left, tail, services, quota } = build(level);
    const text = justify(left, tail, width);
    if (text !== undefined) return { text, services, quota };
  }
  const last = build(levels.at(-1)!);
  return { text: fit(last.left, width), services: false, quota: false };
}
/** Row 3 only when the status row had to drop alerting services or quota alerts. */
function overflowRow(scene: Scene, dropped: { services: boolean; quota: boolean }): string | undefined {
  const { view, paint, width } = scene;
  const alerts = [...(dropped.services ? view.services.filter(g => g.alert) : []), ...(dropped.quota ? view.quota?.alerts ?? [] : [])];
  if (!alerts.length) return undefined;
  const ink = (a: Alert, text: string) => paint.fg(scene.aged(a.key) ? "muted" : a.kind, text);
  const full = alerts.map(a => ink(a, a.text)).join("  "), compact = alerts.map(a => ink(a, a.compact)).join("  "), glyphs = alerts.filter(a => a.glyph).map(a => ink(a, a.glyph)).join(" ");
  return pick([full, compact, glyphs], width) ?? fit(compact, width);
}
export function dashboardRows(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint = plainPaint, now = Date.now(), aged: Aged = never): string[] {
  const scene = prepare(data, context, settings, width, paint, now, aged);
  if (!scene) return [];
  const { bar } = scene;
  if (scene.width < 20) return finish([bar], scene);
  if (scene.width < 40) {
    const narrow: Level = { provider: false, thinking: false, facts: "compact", name: false, cwd: false, windows: "none", resets: false, services: "none", tail: "none" };
    const blocks = [stateBlock(scene), branchBlock(scene, narrow)].filter((b): b is Block => b !== undefined).map((b, i) => segment(b, i, paint));
    return finish([bar, pick([blocks.join(""), blocks[0]], scene.width) ?? fit(blocks[0], scene.width)], scene);
  }
  const status = statusRow(scene);
  return finish([bar, status.text, overflowRow(scene, { services: !status.services, quota: !status.quota })], scene);
}
