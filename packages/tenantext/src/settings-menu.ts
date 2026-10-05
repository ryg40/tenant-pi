import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureSettings as ensureFooterSettings, healthUrl, loadLocalSettings, saveSettings as saveFooterSettings, type Settings } from "../extensions/ops-footer/settings.ts";
import { ensureSettings as ensureMainSettings, loadSettings as loadMainSettings, saveSettings as saveMainSettings, type TenantextSettings } from "./settings.ts";

export interface SettingsMenuActions {
  mainChanged: (settings: TenantextSettings) => void;
  footerChanged: () => void;
}

const numbers: Record<string, [number, number, string]> = {
  minimumRows: [1, 12, "Minimum footer rows"], maximumRows: [3, 12, "Maximum footer rows"],
  healthPollSeconds: [10, 3600, "Health poll interval (seconds)"],
  healthTimeoutMs: [100, 10000, "Health request timeout (ms)"], gitCacheMs: [250, 60000, "Git cache time (ms)"],
  gitIdlePollSeconds: [2, 3600, "Idle Git poll interval (seconds)"],
};
const flags = [
  ["rules", "Simplified English rules"], ["guard", "First-prompt guard"], ["decisions", "Decision-server calls"],
  ["enabled", "Operations footer"], ["showHealthyServices", "Show healthy services"],
  ["showUnavailableOptionalSources", "Show unavailable sources"],
] as const;
const endpoints = [["OK", "OpenKnowledge health URL"], ["OV", "OpenViking health URL"]] as const;

/** An interactive menu built from the same names that the JSON parser accepts. */
export async function settingsMenu(ctx: ExtensionContext, actions: SettingsMenuActions): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/tenantext settings requires the TUI.", "warning"); return; }
  try { ensureMainSettings(); await ensureFooterSettings(); }
  catch { ctx.ui.notify("Cannot initialize Tenantext settings files.", "error"); return; }
  let main = loadMainSettings();
  let footer = await loadLocalSettings(); // Do not show or save environment endpoint overrides.
  while (true) {
    const items: { key: string; label: string }[] = [
      ...flags.map(([key, label]) => ({ key, label: `${label}: ${
        key === "rules" || key === "guard" || key === "decisions" ? main[key] ? "on" : "off" : footer[key] ? "on" : "off"}` })),
      ...Object.entries(numbers).map(([key, [, , label]]) => ({ key, label: `${label}: ${footer[key as keyof Settings]}` })),
      ...endpoints.map(([key, label]) => ({ key: `healthUrls.${key}`, label: `${label}: ${footer.healthUrls[key] ? "configured" : "unset"}` })),
    ];
    const selected = await ctx.ui.select("Tenantext settings (Esc to close)", items.map(item => item.label));
    if (!selected) return;
    const key = items.find(item => item.label === selected)?.key;
    if (!key) continue;
    try {
      if (key === "rules" || key === "guard" || key === "decisions") {
        const value = await ctx.ui.select(key, ["on", "off"]);
        if (!value) continue;
        const next = { ...main, [key]: value === "on" };
        saveMainSettings(next); main = next; actions.mainChanged(next);
      } else if (key === "enabled" || key === "showHealthyServices" || key === "showUnavailableOptionalSources") {
        const value = await ctx.ui.select(key, ["on", "off"]);
        if (!value) continue;
        const next = { ...footer, [key]: value === "on" };
        await saveFooterSettings(next, undefined, true); footer = next; actions.footerChanged();
      } else if (key in numbers) {
        const [low, high] = numbers[key];
        const text = await ctx.ui.input(`${key} (${low}–${high}; now ${footer[key as keyof Settings]})`, "Enter an integer");
        if (text === undefined) continue;
        const value = Number(text.trim());
        if (!/^[0-9]+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < low || value > high ||
          (key === "minimumRows" && value > footer.maximumRows) || (key === "maximumRows" && value < footer.minimumRows)) {
          ctx.ui.notify(`${key} must be an integer from ${low} to ${high}, with minimumRows ≤ maximumRows.`, "warning");
          continue;
        }
        const next = { ...footer, [key]: value };
        await saveFooterSettings(next, undefined, true); footer = next; actions.footerChanged();
      } else if (key === "healthUrls.OK" || key === "healthUrls.OV") {
        const source = key.endsWith("OK") ? "OK" : "OV";
        const text = await ctx.ui.input(`${key} (blank clears; Esc keeps current value)`, "http://host/health");
        if (text === undefined) continue;
        const url = text.trim() ? healthUrl(text.trim()) : undefined;
        if (text.trim() && !url) { ctx.ui.notify("Use an HTTP(S) URL without credentials, query, or fragment.", "warning"); continue; }
        const next = { ...footer, healthUrls: { ...footer.healthUrls, [source]: url } };
        await saveFooterSettings(next, undefined, true); footer = next; actions.footerChanged();
      }
    } catch { ctx.ui.notify("Cannot save Tenantext settings.", "error"); }
  }
}
