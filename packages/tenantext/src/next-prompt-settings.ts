import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./agent-dir.ts";

/** Settings of the next-prompt suggestion, in `<agent dir>/next-prompt/settings.json`. They live in `src/` because the settings menu changes them. */

export interface Settings {
  /** Proposed default: on. The suggestion still needs dummies on and a coordinator session. */
  enabled: boolean;
}
export const defaults: Readonly<Settings> = Object.freeze({ enabled: true });
/** The event that the settings menu sends after a change: `{ enabled: boolean }`. */
export const SETTINGS_EVENT = "tenantext:next-prompt:settings";

export function settingsPath(): string {
  return join(agentDir(), "next-prompt", "settings.json");
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
  const input = value as Record<string, unknown>;
  if ("enabled" in input && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  return { ...defaults, ...("enabled" in input ? { enabled: input.enabled as boolean } : {}) };
}
export function loadSettings(path = settingsPath()): { settings: Settings; warning?: string } {
  try { return { settings: validateSettings(JSON.parse(readFileSync(path, "utf8"))) }; }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { settings: { ...defaults }, ...(!missing ? { warning: "Invalid or unreadable next-prompt settings; defaults apply." } : {}) };
  }
}
export function saveSettings(settings: Settings, path = settingsPath()): void {
  const safe = validateSettings(settings);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
