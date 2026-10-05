import type { ContextState } from "../../context-meter/snapshot.ts";
import type { Paint } from "../paint.ts";
import { contextRow, never, unknownContext, type Aged } from "../render.ts";
import type { Settings } from "../settings.ts";
import type { ContextService, DashboardSnapshot } from "../types.ts";
import { buildView, type Alert, type View } from "../view.ts";
import { fit } from "../widgets.ts";

/**
 * Shared scaffolding for the prototype layouts. Each layout composes rows; this module owns the
 * contract that every layout shares with v2: width sanitising, the view model, the bar, and the row budget.
 */
export interface Scene { width: number; view: View; bar: string; paint: Paint; aged: Aged; now: number; settings: Settings }

/** Sanitise the width and build the view model plus the full-width bar. Undefined at width 0. */
export function prepare(data: DashboardSnapshot, context: ContextService, settings: Settings, width: number, paint: Paint, now = Date.now(), aged: Aged = never): Scene | undefined {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return undefined;
  let ctx: ContextState, failed = false;
  try { ctx = context.state(); } catch { ctx = unknownContext; failed = true; }
  const view = buildView(data, ctx, settings, now);
  view.services.push(...view.memory);
  view.memory = [];
  return { width, view, bar: contextRow(ctx, view, width, paint, failed), paint, aged, now, settings };
}
/** Apply the row budget: cap at `maximumRows`, pad to `minimumRows`, fit every line. */
export function finish(rows: readonly (string | undefined)[], scene: Scene): string[] {
  const lines = rows.filter((r): r is string => r !== undefined).slice(0, Math.max(1, scene.settings.maximumRows)).map(line => fit(line, scene.width));
  while (lines.length < scene.settings.minimumRows) lines.push("");
  return lines;
}
/** `openai-codex/gpt-5.6-sol · high`: provider prefix at 120 columns or more, thinking hidden when off. */
export function modelIdentity(view: View, width: number, thinking = true): string {
  const m = view.model;
  const name = width >= 120 ? `${m.provider}/${m.model}` : m.model;
  return thinking && m.thinking ? `${name} · ${m.thinking}` : name;
}
/** Bright unless the alert has aged; the glyph and word stay either way. */
export const alertInk = (scene: Scene, alert: Alert, text = alert.text): string => scene.paint.fg(scene.aged(alert.key) ? "muted" : alert.kind, text);
/** One upper-case word per alert family, for layouts that lead with a single loud word. */
export function alertWord(alert: Alert): string {
  const family = alert.key.split(":")[0];
  const words: Record<string, string> = {
    "agent": alert.key === "agent:waiting" ? "INPUT" : "MODEL", blocked: "BLOCKED", prompts: "PROMPTS", background: "BACKGROUND", review: "REVIEW", deploy: "DEPLOY",
    work: "WORK", mcp: "MCP", quota: "QUOTA", route: "ROUTE", git: "GIT", conflict: "FOOTER", ste: "STE",
  };
  return words[family] ?? family.toUpperCase();
}
export const agentAlert = (alert: Alert): boolean => alert.key === "agent:waiting" || alert.key === "agent:failed";
