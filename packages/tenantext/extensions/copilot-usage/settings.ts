import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeDomain, SOURCE_ORDER, type CopilotSourceId } from "./detect.ts";

/**
 * `auto` (default): show the meter only when a local credential reaches the usage endpoint.
 * `on`: also show an error chip when detection or the request fails. `off`: never probe.
 */
export type CopilotMode = "auto" | "on" | "off";
export interface CopilotUsageSettings { mode: CopilotMode; sources: CopilotSourceId[]; domain?: string; pollSeconds: number }
export const defaults: CopilotUsageSettings = { mode: "auto", sources: [...SOURCE_ORDER], pollSeconds: 300 };

/** Pi's agent directory without a Pi import, so the doctor CLI can share this module. */
export const agentDir = (env: NodeJS.ProcessEnv = process.env): string => {
	const dir = env.PI_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".pi", "agent");
};
export const copilotSettingsPath = (dir = agentDir()): string => join(dir, "copilot-usage", "settings.json");

export function parseCopilotSettings(value: unknown): CopilotUsageSettings {
	const out: CopilotUsageSettings = { ...defaults, sources: [...defaults.sources] };
	if (!value || typeof value !== "object") return out;
	const v = value as Record<string, unknown>;
	if (v.mode === "auto" || v.mode === "on" || v.mode === "off") out.mode = v.mode;
	if (Array.isArray(v.sources)) {
		const sources = SOURCE_ORDER.filter(s => (v.sources as unknown[]).includes(s));
		if (sources.length) out.sources = sources;
	}
	const domain = normalizeDomain(v.domain);
	if (domain) out.domain = domain;
	if (typeof v.pollSeconds === "number" && Number.isFinite(v.pollSeconds)) out.pollSeconds = Math.max(60, Math.min(3600, Math.floor(v.pollSeconds)));
	return out;
}
export function loadCopilotSettings(path = copilotSettingsPath(), env: NodeJS.ProcessEnv = process.env): CopilotUsageSettings {
	let settings: CopilotUsageSettings;
	try { settings = parseCopilotSettings(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}); }
	catch { settings = parseCopilotSettings({}); }
	const mode = env.TENANTEXT_COPILOT_USAGE;
	if (mode === "auto" || mode === "on" || mode === "off") settings.mode = mode;
	return settings;
}
