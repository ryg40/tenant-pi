import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { allocate, type ContextState } from "./snapshot.ts";

/**
 * Segmented bar primitive shared by the standalone meter and the operations footer.
 *
 * Design traits:
 * - one full-width bar of solid background blocks; block width encodes share of the window;
 * - labels sit inside their blocks and use the longest form that fits the block, not the terminal;
 * - the free block stays dark and calm; thresholds are thin markers, not a text legend;
 * - totals sit right-aligned inside the bar instead of consuming another row;
 * - no rulers, dashes, or text-made progress bars.
 */
export type Rgb = string; // "r;g;b" truecolor triplet
/**
 * v4 palette: muted, low-chroma hues at one perceived luminance (Rec. 601 luma 155–190), so the used blocks read as data, not alerts.
 * Hue order walks cool to warm along the bar: frost sys, sage prompt, blue assistant, lavender think, sand tools. Adjacent blocks differ
 * in hue by at least 30°, and saturated amber and red belong only to stage words, alerts, and threshold bands. The largest block (tools)
 * gets the calmest color. Every used block takes dark label ink; the free block and its bands stay dark for light ink.
 */
export const palette: Record<"sys" | "prompt" | "assistant" | "think" | "tools" | "free", Rgb> = {
  sys: "129;161;193", prompt: "136;192;176", assistant: "122;162;247", think: "170;150;232", tools: "202;182;146", free: "27;33;46",
};
/** Dark-theme fallback inks. Bars use explicit truecolor because Pi's theme has no bar backgrounds. */
export const ink = {
  dark: "12;20;30", light: "205;214;228", muted: "150;162;180", marker: "118;134;160", unknown: "60;68;82",
  accent: "138;180;255", warning: "255;196;96", error: "255;122;122", sysWarning: "132;18;30",
};
/** Free-block base colors per stage. Bands add a small lightness step per crossed threshold. */
export const freeBase: Record<ContextState["stage"], Rgb> = { OK: palette.free, PLAN: "32;46;76", WARN: "72;54;28", CRIT: "88;32;44", UNKNOWN: ink.unknown };
/** Texture: the first cell of a used block is one step lighter; free-band cells alternate a faint step. Color mode only; widths never change. */
export const texture = { edge: 26, stipple: 5 };
export const labels = [
  ["sys", "sys", "S"], ["prompt", "pr", "P"], ["assistant", "as", "A"],
  ["think", "th", "T"], ["tools", "tl", "R"], ["free", "fr", "F"],
];

export interface Segment { cells: number; forms: readonly string[]; bg: Rgb; fg?: Rgb; bold?: boolean; fill?: string; free?: boolean }
export interface TextPart { text: string; fg?: Rgb; bold?: boolean }
export interface BarInput {
  width: number;
  color: boolean;
  segments: Segment[];
  /** Columns that hold a threshold marker. */
  markers?: number[];
  /** Background overrides for the free segment, applied from `at` onward. */
  bands?: { at: number; bg: Rgb }[];
  /** Candidates from verbose to terse. The first that fits inside the free segment wins; otherwise the first that fits the bar. */
  rightText?: TextPart[][];
}
interface Cell { text: string; width: number; bg: Rgb; fg: Rgb; bold: boolean; filler: boolean }

const lift = (rgb: Rgb, step: number): Rgb => rgb.split(";").map(n => Math.min(255, Number(n) + step)).join(";");
const light = (rgb: Rgb): boolean => { const [r, g, b] = rgb.split(";").map(Number); return 0.299 * r + 0.587 * g + 0.114 * b > 140; };
const graphemes = (text: string): string[] => [...new Intl.Segmenter().segment(stripTerminalSequences(text))].map(s => s.segment).filter(g => visibleWidth(g) > 0);
const partsWidth = (parts: TextPart[]): number => parts.reduce((n, p) => n + visibleWidth(stripTerminalSequences(p.text)), 0);

/** Render one bar line of exactly `width` cells. Never wider, never narrower, never multi-line. */
export function segmentBar(input: BarInput): string {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  if (width === 0) return "";
  const cells: Cell[] = [];
  const bounds: { start: number; end: number; segment: Segment }[] = [];
  let column = 0;
  for (const segment of input.segments) {
    const start = column, end = Math.min(width, column + Math.max(0, segment.cells));
    bounds.push({ start, end, segment });
    for (let c = start; c < end; c++) {
      let bg = segment.bg;
      if (segment.free) {
        let bandStart: number | undefined;
        for (const band of input.bands ?? []) if (c >= band.at) { bg = band.bg; bandStart = band.at; }
        // Alternating shade inside the threshold bands: a faint texture that keeps the bands visible but calm.
        if (input.color && bandStart !== undefined && (c - bandStart) % 2 === 1) bg = lift(bg, texture.stipple);
      } else if (input.color && c === start && end - start >= 2) bg = lift(bg, texture.edge); // lighter left edge on each used block
      const filler = input.color ? " " : segment.fill ?? (segment.free ? "·" : "▓");
      cells.push({ text: filler, width: 1, bg, fg: segment.fg ?? (light(bg) ? ink.dark : ink.light), bold: false, filler: true });
    }
    column = end;
  }
  while (cells.length < width) cells.push({ text: input.color ? " " : "·", width: 1, bg: palette.free, fg: ink.light, bold: false, filler: true });
  const write = (at: number, grapheme: string, style: { fg?: Rgb; bold?: boolean; onLight?: boolean }) => {
    const w = visibleWidth(grapheme);
    if (at < 0 || at + w > width) return false;
    const clear = (c: number) => { if (c >= 0 && c < width) cells[c] = { ...cells[c], text: input.color ? " " : "·", width: 1, filler: true }; };
    for (let c = at; c < at + w; c++) {
      // Clear any wide grapheme that straddles the target cells.
      if (cells[c].width === 0) { clear(c - 1); clear(c); }
      else if (cells[c].width === 2) { clear(c); clear(c + 1); }
    }
    const base = cells[at];
    const onLight = light(base.bg);
    cells[at] = { ...base, text: grapheme, width: w, filler: false, bold: style.bold ?? false, fg: onLight ? ink.dark : style.fg ?? base.fg };
    if (onLight && style.fg && style.fg !== ink.dark) cells[at].bold = true;
    for (let c = at + 1; c < at + w; c++) cells[c] = { ...cells[c], text: "", width: 0, filler: false };
    return true;
  };
  const writeParts = (at: number, parts: TextPart[]) => {
    let c = at;
    for (const part of parts) for (const g of graphemes(part.text)) { write(c, g, { fg: part.fg, bold: part.bold }); c += visibleWidth(g); }
  };
  // Right text sits inside the free block when it fits there; otherwise it overlays the bar's right end.
  const free = bounds.find(b => b.segment.free);
  let overlayStart = width;
  for (const candidates of [input.rightText ?? []]) {
    const inFree = free ? candidates.find(parts => partsWidth(parts) <= free.end - free.start) : undefined;
    const chosen = inFree ?? candidates.find(parts => partsWidth(parts) <= width);
    if (chosen) { overlayStart = width - partsWidth(chosen); writeParts(overlayStart, chosen); }
  }
  // Markers first: a threshold stays visible even inside a used segment.
  for (const m of input.markers ?? []) {
    if (m < 0 || m >= width || !cells[m].filler) continue;
    const inFree = free !== undefined && m >= free.start && m < free.end;
    cells[m] = { ...cells[m], text: input.color ? "▏" : "│", width: 1, filler: false, fg: inFree ? ink.marker : ink.dark };
  }
  // Labels: the longest form that fits the block's largest run of filler cells, centered.
  // Colored blocks delineate themselves, so their labels sit tight like nano-context; the free block and
  // no-color mode keep one cell of padding each side. Tiny blocks stay unlabeled.
  for (const { start, end, segment } of bounds) {
    const regionEnd = Math.min(end, overlayStart);
    let run = { at: start, cells: 0 }, best = run;
    for (let c = start; c <= regionEnd; c++) {
      if (c < regionEnd && cells[c].filler) { if (run.cells === 0) run = { at: c, cells: 0 }; run.cells++; }
      else { if (run.cells > best.cells) best = run; run = { at: c + 1, cells: 0 }; }
    }
    const padding = input.color && !segment.free ? 0 : 2;
    if (best.cells < 2 + padding) continue;
    const forms = segment.forms.map(f => stripTerminalSequences(f)).filter(f => visibleWidth(f) > 0);
    const form = forms.find(f => visibleWidth(f) + padding <= best.cells);
    if (!form) continue;
    const w = visibleWidth(form);
    writeParts(best.at + Math.floor((best.cells - w) / 2), [{ text: form, fg: segment.fg, bold: segment.bold }]);
  }
  if (!input.color) return cells.map(c => c.text).join("");
  let out = "";
  let run = "", style = "";
  for (const cell of cells) {
    const next = `\x1b[48;2;${cell.bg}m\x1b[38;2;${cell.fg}m${cell.bold ? "\x1b[1m" : ""}`;
    if (next !== style) { if (run) out += `${style}${run}\x1b[0m`; style = next; run = ""; }
    run += cell.text;
  }
  if (run) out += `${style}${run}\x1b[0m`;
  return out;
}

export interface ContextBarOptions { color: boolean; rightText?: TextPart[][]; labels?: readonly (readonly string[])[] }
/** Build the context bar from the semantic state. Both consumers share this layout; neither computes thresholds. */
export function contextBar(state: ContextState, width: number, options: ContextBarOptions): string {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return "";
  const names = options.labels ?? labels;
  if (!state.weights) {
    return segmentBar({ width, color: options.color, rightText: options.rightText, segments: [
      { cells: width, forms: ["context unknown", "unknown", "?"], bg: freeBase.UNKNOWN, fg: ink.light, free: true, fill: "·" },
    ] });
  }
  const counts = allocate(state.weights, width);
  const thresholds = [state.thresholds.prepare, state.thresholds.transition, state.thresholds.critical];
  const markers = thresholds.map(p => Math.min(width - 1, Math.floor(width * p / 100)));
  const base = freeBase[state.stage];
  const bands = markers.map((at, i) => ({ at, bg: lift(base, 8 * (i + 1)) }));
  const keys = ["sys", "prompt", "assistant", "think", "tools", "free"] as const;
  const segments: Segment[] = counts.map((cells, i) => {
    const key = keys[i];
    const forms = names[i] ?? labels[i];
    if (key === "sys" && state.systemWarning) return { cells, forms: ["sys!", "sys!", "S!"], bg: palette.sys, fg: ink.sysWarning, bold: true };
    if (key === "free") return { cells, forms, bg: base, fg: ink.muted, free: true };
    return { cells, forms, bg: palette[key] };
  });
  return segmentBar({ width, color: options.color, segments, markers, bands, rightText: options.rightText });
}
