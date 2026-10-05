import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contextBar, labels } from "./bar.ts";
import { nextMoveChip, type NextMove } from "./next-move.ts";
import type { Settings } from "./settings.ts";
import { contextState, guidance, type Snapshot } from "./snapshot.ts";

export { labels, palette } from "./bar.ts";
export const formatTokens = (value: number | undefined): string => value === undefined ? "?" : value < 1000 ? `${Math.round(value)}` : `${(value / 1000).toFixed(1)}k`;
export const formatPercent = (value: number | undefined): string => value === undefined ? "?%" : `${Math.floor(value * 100) / 100}%`;
const fit = (text: string, width: number): string => truncateToWidth(text, width, "");

/** Standalone widget: the shared segmented bar plus one status row. The footer replaces this widget when it owns the footer. */
export function renderMeter(s: Snapshot, settings: Settings, width: number, options: { color?: boolean; labels?: string[][]; nextMove?: NextMove } = {}): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return [];
  const state = contextState(s, settings);
  const warning = state.systemWarning ? " SYS!" : "";
  const percent = formatPercent(s.percent);
  const stage = s.stage === "UNKNOWN" ? "UNK" : s.stage;
  let status = `${stage} ${percent}${warning}`;
  if (width < 20) {
    // Keep stage and percentage before spending columns on the secondary system warning.
    status = `${stage} ${percent}`;
    if (visibleWidth(status) > width) status = `${stage}${percent}`;
    if (visibleWidth(status) > width) status = `${stage[0]}${percent}`;
    if (visibleWidth(status + warning) <= width) status += warning;
    return [fit(status, width)];
  }
  if (width >= 40) status += ` ${formatTokens(s.used)}/${formatTokens(s.window)} sys ${formatTokens(s.system)}`;
  if (width >= 60 && options.nextMove) status += ` | ${nextMoveChip(options.nextMove)}`;
  if (width >= 80) status += ` | ${guidance[s.stage]}`;
  if (width >= 120) status += ` | markers ${settings.preparePercent}/${settings.transitionPercent}/${settings.criticalPercent}`;
  return [contextBar(state, width, { color: options.color !== false, labels: options.labels }), fit(status, width)];
}
