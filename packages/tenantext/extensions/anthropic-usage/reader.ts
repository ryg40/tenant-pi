import { SOURCE_LABELS, type AnthropicSourceId } from "./detect.ts";
import { anthropicSettingsPath, loadAnthropicSettings, type AnthropicUsageSettings } from "./settings.ts";
import { probeAnthropic } from "./status.ts";
import { fetchAnthropicUsage, type AnthropicWindow } from "./usage.ts";

/** One reading of the Anthropic meter for the doctor. The doctor imports only this module of the meter. */
export interface AnthropicReading {
	path: string;
	settings: AnthropicUsageSettings;
	/** The login that got a reading. Undefined when the mode is off or no login got one. */
	source?: { id: AnthropicSourceId; label: string };
	plan?: string;
	windows: AnthropicWindow[];
	/** Each tried login as `<label>: <error or accepted>`. */
	tried: string[];
}
export interface AnthropicReaderOptions {
	dir: string;
	env: NodeJS.ProcessEnv;
	home?: string;
	readCredential: () => unknown;
	readClaudeFile?: (path: string) => unknown;
	fetcher?: typeof fetch;
	signal?: AbortSignal;
}

/** Read the settings and probe each active local login read-only, as the meter does. No Pi import, no refresh, no write. */
export async function readAnthropicMeter(options: AnthropicReaderOptions): Promise<AnthropicReading> {
	const path = anthropicSettingsPath(options.dir);
	const settings = loadAnthropicSettings(path, options.env);
	const reading: AnthropicReading = { path, settings, windows: [], tried: [] };
	if (settings.mode === "off") return reading;
	const probe = await probeAnthropic({ env: options.env, home: options.home, sources: settings.sources, readClaudeFile: options.readClaudeFile, readPiCredential: options.readCredential },
		options.signal ?? AbortSignal.timeout(20_000), (credential, signal) => fetchAnthropicUsage(credential, signal, options.fetcher));
	reading.tried = probe.tried.map(t => `${SOURCE_LABELS[t.source]}: ${t.error ?? "accepted"}`);
	if (probe.result?.success && probe.credential) {
		reading.source = { id: probe.credential.source, label: SOURCE_LABELS[probe.credential.source] };
		reading.plan = probe.credential.plan;
		reading.windows = probe.result.usage.windows;
	}
	return reading;
}
