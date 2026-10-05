// Promptr `/promptr usage` adapter over the vendored Atelier v0.12.0 subagent usage view.
// The integration (./controller.mts) registers the command and calls openPromptrUsage.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSubagentUsage } from "./vendor/atelier/subagent-usage-view.mts";
import type { SidebarTelemetry } from "./telemetry.mts";

export type UsageDialogResult = "closed" | "not-tui" | "inactive" | "untrusted";
export const USAGE_COMMAND_HINT = "/promptr usage";

/** Same clamp as upstream: 0..6 currency decimals from the display configuration. */
export function usageDecimals(currencyDecimals: number): number {
  return Math.min(6, Math.max(0, Math.trunc(Number.isFinite(currencyDecimals) ? currencyDecimals : 0)));
}

/**
 * Refresh session-owned accounting, then show the larger per-child cost graph with the release
 * interactions (←→ agent, [ ] point, ↑↓ legend, A all, Esc). The dialog closes when the session retires.
 */
export async function openPromptrUsage(ctx: ExtensionContext, telemetry: SidebarTelemetry): Promise<UsageDialogResult> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Promptr usage needs interactive Pi.", "info");
    return "not-tui";
  }
  if (!telemetry.isCurrent(ctx) || !telemetry.isEnabled()) {
    ctx.ui.notify("Show the Promptr sidebar in this session to view usage.", "info");
    return "inactive";
  }
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("Subagent usage needs a trusted project. Nothing was read.", "info");
    return "untrusted";
  }
  await telemetry.refreshSubagentUsage();
  if (!telemetry.isCurrent(ctx) || !telemetry.isEnabled() || !ctx.isProjectTrusted()) return "inactive";
  await openSubagentUsage(ctx, telemetry.subagentUsage(), usageDecimals(telemetry.getConfig().currencyDecimals),
    telemetry.overlayLifetime());
  return "closed";
}
