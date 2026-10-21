import { copilotProvider, SOURCE_LABELS, type CopilotSourceId } from "./detect.ts";
import { copilotSettingsPath, loadCopilotSettings, type CopilotUsageSettings } from "./settings.ts";
import { probeCopilot } from "./status.ts";
import { fetchCopilotUsage, type CopilotWindow } from "./usage.ts";

/** One reading of the Copilot meter for the doctor. The doctor imports only this module of the meter. */
export interface CopilotReading {
	path: string;
	settings: CopilotUsageSettings;
	/** `mode on` or the Pi provider. Undefined when the mode is off or Pi has no Copilot provider; then nothing is probed. */
	provider?: string;
	/** The source that got a reading. Undefined when no credential got one. */
	source?: { id: CopilotSourceId; label: string; domain: string };
	plan?: string;
	windows: CopilotWindow[];
	/** Each tried source as `<label>: <error or accepted>`. */
	tried: string[];
}
export interface CopilotReaderOptions {
	dir: string;
	env: NodeJS.ProcessEnv;
	readCredential: () => unknown;
	readPiSettings: () => unknown;
	fetcher?: typeof fetch;
	signal?: AbortSignal;
}

/** Read the settings and probe each local source read-only, as the meter does. No Pi import, no write. */
export async function readCopilotMeter(options: CopilotReaderOptions): Promise<CopilotReading> {
	const path = copilotSettingsPath(options.dir);
	const settings = loadCopilotSettings(path, options.env);
	const reading: CopilotReading = { path, settings, windows: [], tried: [] };
	if (settings.mode === "off") return reading;
	reading.provider = settings.mode === "on" ? "mode on" : copilotProvider({ env: options.env, readPiCredential: options.readCredential, readPiSettings: options.readPiSettings });
	if (!reading.provider) return reading;
	const probe = await probeCopilot({ env: options.env, sources: settings.sources, domain: settings.domain, readPiCredential: options.readCredential },
		options.signal ?? AbortSignal.timeout(20_000), (credential, signal) => fetchCopilotUsage(credential, signal, options.fetcher));
	reading.tried = probe.tried.map(t => `${SOURCE_LABELS[t.source]}: ${t.error ?? "accepted"}`);
	if (probe.result?.success && probe.credential) {
		reading.source = { id: probe.credential.source, label: SOURCE_LABELS[probe.credential.source], domain: probe.credential.domain };
		reading.plan = probe.result.usage.plan;
		reading.windows = probe.result.usage.windows;
	}
	return reading;
}
