import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Settings {
  enabled: boolean;
  preparePercent: number;
  transitionPercent: number;
  criticalPercent: number;
  systemPromptWarningTokens: number;
  /** Decision-server URL for the next-move choice question. Empty: the chip is off. */
  nextMoveUrl: string;
  /** Name of the environment variable that holds the endpoint key. The key is never stored in this file. */
  nextMoveKeyEnv: string;
  nextMoveTimeoutMs: number;
  /** Minimum margin between the top two answers. Below it the chip shows nothing. */
  nextMoveMinConfidence: number;
}
export const defaults: Readonly<Settings> = Object.freeze({
  enabled: true, preparePercent: 60, transitionPercent: 75,
  criticalPercent: 90, systemPromptWarningTokens: 10000,
  nextMoveUrl: "", nextMoveKeyEnv: "TENANTEXT_NEXT_MOVE_KEY", nextMoveTimeoutMs: 150, nextMoveMinConfidence: 0.3,
});
const strings = new Set<keyof Settings>(["nextMoveUrl", "nextMoveKeyEnv"]);
export function settingsPath(): string {
  return join(getAgentDir(), "context-meter", "settings.json");
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
  const input = value as Record<string, unknown>;
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (!(key in input)) continue;
    if (key === "enabled") {
      if (typeof input[key] !== "boolean") throw new Error("enabled must be a boolean.");
      result.enabled = input[key];
    } else if (strings.has(key)) {
      if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
      (result as Record<string, unknown>)[key] = input[key];
    } else if (key === "nextMoveMinConfidence") {
      const n = input[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw new Error("nextMoveMinConfidence must be between 0 and 1.");
      result[key] = n;
    } else {
      const n = input[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 1) throw new Error("Invalid numeric setting.");
      (result as Record<string, unknown>)[key] = n;
    }
  }
  if (result.nextMoveUrl && !/^https?:\/\//.test(result.nextMoveUrl)) throw new Error("nextMoveUrl must start with http:// or https://.");
  if (!(result.preparePercent < result.transitionPercent && result.transitionPercent < result.criticalPercent && result.criticalPercent <= 100)) {
    throw new Error("Percentage thresholds must increase between 1 and 100.");
  }
  if (!Number.isSafeInteger(result.systemPromptWarningTokens)) throw new Error("System threshold must be a positive safe integer.");
  return result;
}
export function loadSettings(path = settingsPath()): { settings: Settings; warning?: string } {
  try { return { settings: validateSettings(JSON.parse(readFileSync(path, "utf8"))) }; }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { settings: { ...defaults }, ...(!missing ? { warning: "Invalid or unreadable context-meter settings; defaults apply." } : {}) };
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
