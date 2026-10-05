import { detectAnthropicCredentials, SOURCE_LABELS, type AnthropicCredential, type AnthropicPlan, type AnthropicSourceId, type DetectOptions } from "./detect.ts";
import type { AnthropicUsageSettings } from "./settings.ts";
import { fetchAnthropicUsage, type AnthropicUsageResult, type AnthropicWindow } from "./usage.ts";

export const ANTHROPIC_STATUS_EVENT = "tenantext:anthropic:status";
export const ANTHROPIC_REFRESH_EVENT = "tenantext:anthropic:refresh";

/** The longest time a last good reading stands in for a failed request. The Codex status uses the same limit. */
export const CACHED_READING_MS = 24 * 60 * 60 * 1000;
/**
 * Public bus shape. `absent` means no active credential gave a reading; the footer shows nothing. It never holds a token.
 * `unknown` means the last request failed and the windows are the last good reading; the footer shows them with no error chip.
 */
export interface AnthropicStatusSnapshot {
	checkedAt: number;
	staleAfter: number;
	state: "ok" | "error" | "absent" | "unknown";
	source?: AnthropicSourceId;
	plan?: AnthropicPlan;
	windows: AnthropicWindow[];
	error?: string;
}
export interface AnthropicProbe { credential?: AnthropicCredential; result?: AnthropicUsageResult; tried: { source: AnthropicSourceId; detail: string; error?: string }[] }
export type Fetcher = (credential: AnthropicCredential, signal: AbortSignal) => Promise<AnthropicUsageResult>;

/** Try each active credential until one is accepted. Any failure but a refused login stops the walk: the next token would fail the same way. */
export async function probeAnthropic(detect: DetectOptions, signal: AbortSignal, fetcher: Fetcher = fetchAnthropicUsage): Promise<AnthropicProbe> {
	const tried: AnthropicProbe["tried"] = [];
	let last: AnthropicProbe = { tried };
	for (const credential of detectAnthropicCredentials(detect)) {
		if (signal.aborted) break;
		const result = await fetcher(credential, signal);
		tried.push({ source: credential.source, detail: credential.detail, error: result.success ? undefined : result.error });
		if (result.success) return { credential, result, tried };
		last = { credential, result, tried };
		if (!result.auth) break;
	}
	return last;
}

export interface AnthropicStatusOptions {
	settings: () => AnthropicUsageSettings;
	detect: () => DetectOptions;
	emit: (event: string, value: unknown) => void;
	fetcher?: Fetcher;
	clock?: () => number;
}
export function createAnthropicStatus(options: AnthropicStatusOptions) {
	const clock = options.clock ?? Date.now;
	let snapshot: AnthropicStatusSnapshot = { checkedAt: 0, staleAfter: 300_000, state: "absent", windows: [] };
	let probe: AnthropicProbe | undefined;
	// The last successful reading. A failed request in `auto` shows it until a window resets or the reading is a day old.
	let lastGood: AnthropicStatusSnapshot | undefined;
	let pending: Promise<AnthropicStatusSnapshot> | undefined;
	let controller: AbortController | undefined;
	let stopped = false;
	const publish = () => { if (!stopped) options.emit(ANTHROPIC_STATUS_EVENT, structuredClone(snapshot)); };
	const refresh = (force = false, minimumMs?: number): Promise<AnthropicStatusSnapshot> => {
		const settings = options.settings();
		if (stopped || settings.mode === "off") {
			probe = undefined; lastGood = undefined;
			snapshot = { checkedAt: clock(), staleAfter: 300_000, state: "absent", windows: [], error: "Meter off" };
			publish(); return Promise.resolve(snapshot);
		}
		if (pending) return pending;
		const age = clock() - snapshot.checkedAt;
		if (!force && snapshot.checkedAt && age < (minimumMs ?? settings.pollSeconds * 1000)) { publish(); return Promise.resolve(snapshot); }
		controller = new AbortController();
		const signal = controller.signal;
		pending = (async () => {
			try {
				probe = await probeAnthropic({ ...options.detect(), sources: settings.sources, now: clock() }, signal, options.fetcher);
				if (stopped || signal.aborted) return snapshot;
				const staleAfter = settings.pollSeconds * 2000;
				if (probe.result?.success && probe.credential) {
					snapshot = { checkedAt: clock(), staleAfter, state: "ok", source: probe.credential.source,
						...(probe.credential.plan ? { plan: probe.credential.plan } : {}), windows: probe.result.usage.windows };
					lastGood = snapshot;
				} else if (!probe.tried.length) {
					// No active credential: the login is absent or expired. An earlier reading does not stand in for it.
					lastGood = undefined;
					snapshot = { checkedAt: clock(), staleAfter, state: settings.mode === "on" ? "error" : "absent", windows: [], error: "No active Anthropic credential found" };
				} else {
					const error = probe.result && !probe.result.success ? probe.result.error : "Request failed";
					const now = clock();
					const reset = lastGood?.windows.some(w => w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now);
					// `auto`: one failed request does not hide the row. `on` asks for an error chip.
					if (settings.mode !== "on" && lastGood && !reset && now - lastGood.checkedAt < CACHED_READING_MS) snapshot = { ...lastGood, checkedAt: now, staleAfter, state: "unknown", error };
					else snapshot = { checkedAt: now, staleAfter, state: settings.mode === "on" ? "error" : "absent", windows: [], error };
				}
				publish();
				return snapshot;
			} catch { return snapshot; }
			finally { pending = undefined; controller = undefined; }
		})();
		return pending;
	};
	return {
		refresh,
		snapshot: () => snapshot,
		stop() { stopped = true; controller?.abort(); },
		report(): string {
			const settings = options.settings();
			const lines = [`## Anthropic usage`, "", `- Mode: ${settings.mode}. Sources: ${settings.sources.join(", ")}.`];
			if (snapshot.state === "ok" && snapshot.source) lines.push(`- Source: ${SOURCE_LABELS[snapshot.source]}.${snapshot.plan ? ` Plan: ${snapshot.plan}.` : ""}`);
			else lines.push(`- State: ${snapshot.state}${snapshot.error ? ` (${snapshot.error})` : ""}.${snapshot.state === "unknown" ? " The windows are the last good reading." : ""}`);
			for (const t of probe?.tried ?? []) lines.push(`- Tried ${SOURCE_LABELS[t.source]} (${t.detail}): ${t.error ?? "accepted"}.`);
			if (snapshot.windows.length) {
				lines.push("", "| Window | Used | Remaining | Reset |", "| --- | ---: | ---: | --- |");
				for (const w of snapshot.windows) lines.push(`| ${w.label} | ${(100 - w.remainingPercent).toFixed(0)}% | ${w.remainingPercent.toFixed(0)}% | ${w.resetsAt ?? "not reported"} |`);
			}
			return lines.join("\n");
		},
	};
}
