import type { Rgb } from "../context-meter/bar.ts";

export type PaintKind = "muted" | "dim" | "text" | "accent" | "success" | "warning" | "error";
/** Presentation boundary. Rows ask for semantic kinds; the runtime maps them to Pi's theme, tests to plain or fixed ANSI. */
export interface Paint {
  color: boolean;
  fg(kind: PaintKind, text: string): string;
  bold(text: string): string;
  /** Solid truecolor block. Bars and chips use explicit colors because Pi's theme has no bar backgrounds. */
  block(bg: Rgb, fg: Rgb, text: string): string;
}
export const plainPaint: Paint = { color: false, fg: (_, text) => text, bold: text => text, block: (_bg, _fg, text) => text };
const ansiInks: Record<PaintKind, Rgb> = {
  muted: "150;162;180", dim: "104;114;130", text: "205;214;228", accent: "138;180;255", success: "125;211;168", warning: "255;196;96", error: "255;122;122",
};
/** Fixed truecolor paint for previews and tests. */
export const ansiPaint: Paint = {
  color: true,
  fg: (kind, text) => `\x1b[38;2;${ansiInks[kind]}m${text}\x1b[39m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
  block: (bg, fg, text) => `\x1b[48;2;${bg}m\x1b[38;2;${fg}m${text}\x1b[0m`,
};
interface ThemeLike { fg(kind: PaintKind, text: string): string; bold?(text: string): string }
/** Colors are off under NO_COLOR or TERM=dumb. Labels and glyphs carry meaning without color. */
export const colorEnabled = (): boolean => process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
export function themePaint(theme: ThemeLike, color = colorEnabled()): Paint {
  if (!color) return plainPaint;
  return {
    color: true,
    fg: (kind, text) => theme.fg(kind, text),
    bold: text => typeof theme.bold === "function" ? theme.bold(text) : text,
    block: ansiPaint.block,
  };
}
