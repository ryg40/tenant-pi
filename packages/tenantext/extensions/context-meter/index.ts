import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createContextMeter } from "./service.ts";
import { defaults, loadSettings, saveSettings } from "./settings.ts";

export const OWNERSHIP = "tenantext:ops-footer:ownership";
export const QUERY = "tenantext:ops-footer:query";
const WIDGET = "context-meter";
const HELP = "/context-meter [report|on|off|save|help]\nreport: Show local estimates. on/off: Change this session. save: Save current settings.";

export default function contextMeter(pi: ExtensionAPI): void {
  const service = createContextMeter(pi);
  let settings = { ...defaults };
  let ui: ExtensionUIContext | undefined;
  let owned = false;
  let disposed = false;
  const refreshWidget = () => {
    if (!ui || disposed) return;
    ui.setWidget(WIDGET, settings.enabled && !owned ? () => ({
      render: width => service.render(width), invalidate() {},
    }) : undefined, { placement: "belowEditor" });
  };
  const unsubscribe = service.subscribe(refreshWidget);
  const unown = pi.events.on(OWNERSHIP, (value: unknown) => {
    if (!value || typeof value !== "object" || !("active" in value) || typeof value.active !== "boolean") return;
    owned = value.active;
    refreshWidget();
  });
  pi.on("session_start", (_event, ctx) => {
    const loaded = loadSettings();
    settings = loaded.settings;
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
    pi.events.emit(QUERY, undefined);
    refreshWidget();
    if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
  });
  pi.registerCommand("context-meter", {
    description: "Show local context usage, or set on/off/save/help",
    handler: async (args, ctx) => {
      const action = args.trim() || "report";
      if (action === "on" || action === "off") {
        settings.enabled = action === "on";
        refreshWidget();
        if (ctx.hasUI) ctx.ui.notify(`Context meter ${action}; use save to persist.`, "info");
        return;
      }
      if (action === "save") {
        try {
          saveSettings(settings);
          if (ctx.hasUI) ctx.ui.notify("Context meter settings saved.", "info");
        } catch {
          if (ctx.hasUI) ctx.ui.notify("Cannot save context meter settings.", "error");
        }
        return;
      }
      const report = action === "report" ? service.report() : HELP;
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify(report, "info");
        return;
      }
      // A temporary dialog, not sendMessage/appendEntry/editor content.
      await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        let offset = 0;
        let maxOffset = 0;
        return {
          render(width: number) {
            if (width <= 0) return [];
            const lines = wrapTextWithAnsi(report, width);
            const height = Math.max(1, tui.terminal.rows - 6);
            maxOffset = Math.max(0, lines.length - height);
            offset = Math.min(offset, maxOffset);
            return [...lines.slice(offset, offset + height), "Up/Down: scroll. Enter/Esc: close."].map(line => truncateToWidth(line, width, ""));
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "escape") || matchesKey(data, "enter")) done();
            else if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
            else if (matchesKey(data, "down")) offset = Math.min(maxOffset, offset + 1);
            tui.requestRender();
          },
        };
      });
    },
  });
  pi.on("session_shutdown", () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    unown();
    service.dispose();
    ui?.setWidget(WIDGET, undefined);
    ui = undefined;
  });
}
