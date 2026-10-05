import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ink, palette, type Rgb } from "../context-meter/bar.ts";
import type { Paint } from "./paint.ts";
import type { QuotaWindow } from "./view.ts";

/** ANSI-aware layout helpers. Every function measures with Pi's `visibleWidth`. */
export const width = (text: string): number => visibleWidth(text);
export function fit(text: string, max: number): string {
  const w = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  return visibleWidth(text) <= w ? text : truncateToWidth(text, w, "");
}
export interface Candidate { text: string; minWidth?: number }
/** The first candidate that both fits and is allowed at this width. Candidates run from verbose to terse. */
export function pick(candidates: readonly (Candidate | string | undefined)[], max: number): string | undefined {
  for (const c of candidates) {
    if (c === undefined) continue;
    const { text, minWidth = 0 } = typeof c === "string" ? { text: c } : c;
    if (minWidth <= max && visibleWidth(text) <= max) return text;
  }
  return undefined;
}
/** Left and right groups with padding between them. Undefined when both do not fit with a two-cell gap. */
export function justify(left: string, right: string, max: number): string | undefined {
  const l = visibleWidth(left), r = visibleWidth(right);
  if (!right) return l <= max ? left : undefined;
  if (!left) return r <= max ? " ".repeat(max - r) + right : undefined;
  if (l + 2 + r > max) return undefined;
  return `${left}${" ".repeat(max - l - r)}${right}`;
}
export const join = (parts: readonly (string | undefined)[], separator = " · "): string => parts.filter((p): p is string => Boolean(p)).join(separator);

/** Quota chip colors. Normal quota stays calm; only low or exhausted quota brightens. Aged alerts keep the glyph but lose brightness. */
const chipInk: Record<"normal" | "low" | "exhausted" | "unavailable" | "lowAged" | "exhaustedAged", { fill: Rgb; onFill: Rgb; onRest: Rgb }> = {
  normal: { fill: "70;118;136", onFill: "226;236;242", onRest: "168;180;196" },
  low: { fill: "204;146;60", onFill: "24;18;8", onRest: "255;196;96" }, lowAged: { fill: "124;104;70", onFill: "236;228;214", onRest: "170;150;120" },
  exhausted: { fill: "196;64;64", onFill: "255;238;238", onRest: "255;122;122" }, exhaustedAged: { fill: "128;72;72", onFill: "240;226;226", onRest: "180;130;130" },
  unavailable: { fill: "56;62;74", onFill: "130;138;152", onRest: "130;138;152" },
};
const chipRest = palette.free;
export function chipText(w: QuotaWindow): string {
  if (w.level === "unavailable") return `${w.name} n/a`;
  const glyph = w.level === "exhausted" ? "✗ " : w.level === "low" ? "⚠ " : "";
  return `${glyph}${w.name} ${Math.round(w.percent ?? 0)}%`;
}
/** A chip whose fill width encodes remaining percent. Text sits inside the chip; the fill boundary passes under the text. */
export function quotaChip(w: QuotaWindow, paint: Paint, options: { width?: number; aged?: boolean } = {}): string {
  const text = chipText(w);
  if (!paint.color) return `[${text}]`;
  const chars = [...text];
  const cells = Math.max(options.width ?? 10, chars.length + 2);
  const fill = w.level === "unavailable" ? cells : Math.round(Math.min(100, Math.max(0, w.percent ?? 0)) / 100 * cells);
  const key = w.level === "normal" || w.level === "unavailable" ? w.level : options.aged ? `${w.level}Aged` as const : w.level;
  const colors = chipInk[key];
  let out = "", run = "", style = "";
  for (let i = 0; i < cells; i++) {
    const inFill = i < fill;
    const next = inFill ? `\x1b[48;2;${colors.fill}m\x1b[38;2;${colors.onFill}m` : `\x1b[48;2;${chipRest}m\x1b[38;2;${colors.onRest}m`;
    if (next !== style) { if (run) out += `${style}${run}\x1b[0m`; style = next; run = ""; }
    run += i === 0 ? " " : chars[i - 1] ?? " ";
  }
  return out + `${style}${run}\x1b[0m`;
}
/** A small solid label block, for account names and quiet chips. */
export function block(paint: Paint, text: string, bg: Rgb = "52;62;80", fg: Rgb = ink.light): string {
  return paint.color ? paint.block(bg, fg, ` ${text} `) : text;
}
