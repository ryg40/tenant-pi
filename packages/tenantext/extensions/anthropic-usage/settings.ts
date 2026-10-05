import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOURCE_ORDER, type AnthropicSourceId } from "./detect.ts";

/**
 * `auto` (default): show the meter only when an active local credential gets a reading from the usage endpoint.
 * `on`: also show an error chip when detection or the request fails. `off`: never probe.
 */
export type AnthropicMode = "auto" | "on" | "off";
export interface AnthropicUsageSettings { mode: AnthropicMode; sources: AnthropicSourceId[]; pollSeconds: number }
export const defaults: AnthropicUsageSettings = { mode: "auto", sources: [...SOURCE_ORDER], pollSeconds: 300 };

/** Pi's agent directory without a Pi import, so the doctor CLI can share this module. */
export const agentDir = (env: NodeJS.ProcessEnv = process.env): string => {
	const dir = env.PI_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".pi", "agent");
};
export const anthropicSettingsPath = (dir = agentDir()): string => join(dir, "anthropic-usage", "settings.json");

export function parseAnthropicSettings(value: unknown): AnthropicUsageSettings {
	const out: AnthropicUsageSettings = { ...defaults, sources: [...defaults.sources] };
	if (!value || typeof value !== "object") return out;
	const v = value as Record<string, unknown>;
	if (v.mode === "auto" || v.mode === "on" || v.mode === "off") out.mode = v.mode;
	if (Array.isArray(v.sources)) {
		const sources = SOURCE_ORDER.filter(s => (v.sources as unknown[]).includes(s));
		if (sources.length) out.sources = sources;
	}
	if (typeof v.pollSeconds === "number" && Number.isFinite(v.pollSeconds)) out.pollSeconds = Math.max(60, Math.min(3600, Math.floor(v.pollSeconds)));
	return out;
}
export function loadAnthropicSettings(path = anthropicSettingsPath(), env: NodeJS.ProcessEnv = process.env): AnthropicUsageSettings {
	let settings: AnthropicUsageSettings;
	try { settings = parseAnthropicSettings(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}); }
	catch { settings = parseAnthropicSettings({}); }
	const mode = env.TENANTEXT_ANTHROPIC_USAGE;
	if (mode === "auto" || mode === "on" || mode === "off") settings.mode = mode;
	return settings;
}
