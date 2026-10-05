import { copilotProvider, detectCopilotCredentials, SOURCE_LABELS, type CopilotCredential, type CopilotSourceId, type DetectOptions } from "./detect.ts";
import type { CopilotUsageSettings } from "./settings.ts";
import { fetchCopilotUsage, type CopilotUsage, type CopilotUsageResult, type CopilotWindow } from "./usage.ts";

export const COPILOT_STATUS_EVENT = "tenantext:copilot:status";
export const COPILOT_REFRESH_EVENT = "tenantext:copilot:refresh";

/** Public bus shape. `absent` means no local credential reached the endpoint; the footer shows nothing. */
export interface CopilotStatusSnapshot {
	checkedAt: number;
	staleAfter: number;
	state: "ok" | "error" | "absent";
	source?: CopilotSourceId;
	plan?: string;
	windows: CopilotWindow[];
	error?: string;
}
export interface CopilotProbe { credential?: CopilotCredential; result?: CopilotUsageResult; tried: { source: CopilotSourceId; detail: string; error?: string }[] }
export type Fetcher = (credential: CopilotCredential, signal: AbortSignal) => Promise<CopilotUsageResult>;

/** Try each detected credential until one is accepted. A network failure stops the walk: the next token would fail the same way. */
export async function probeCopilot(detect: DetectOptions, signal: AbortSignal, fetcher: Fetcher = fetchCopilotUsage, preferred?: CopilotCredential): Promise<CopilotProbe> {
	const tried: CopilotProbe["tried"] = [];
	const candidates = preferred ? [preferred, ...(await detectCopilotCredentials(detect)).filter(c => c.token !== preferred.token)] : await detectCopilotCredentials(detect);
	let last: CopilotProbe = { tried };
	for (const credential of candidates) {
		if (signal.aborted) break;
		const result = await fetcher(credential, signal);
		tried.push({ source: credential.source, detail: credential.detail, error: result.success ? undefined : result.error });
		if (result.success) return { credential, result, tried };
		last = { credential, result, tried };
		if (!result.auth) break;
	}
	return last;
}

export interface CopilotStatusOptions {
	settings: () => CopilotUsageSettings;
	detect: () => DetectOptions;
	emit: (event: string, value: unknown) => void;
	fetcher?: Fetcher;
	clock?: () => number;
}
export function createCopilotStatus(options: CopilotStatusOptions) {
	const clock = options.clock ?? Date.now;
	let snapshot: CopilotStatusSnapshot = { checkedAt: 0, staleAfter: 300_000, state: "absent", windows: [] };
	let usage: CopilotUsage | undefined;
	let credential: CopilotCredential | undefined;
	let probe: CopilotProbe | undefined;
	let pending: Promise<CopilotStatusSnapshot> | undefined;
	let controller: AbortController | undefined;
	let stopped = false;
	let provider: string | undefined;
	const publish = () => { if (!stopped) options.emit(COPILOT_STATUS_EVENT, structuredClone(snapshot)); };
	const refresh = (force = false, minimumMs?: number): Promise<CopilotStatusSnapshot> => {
		const settings = options.settings();
		// `auto` probes nothing until Pi has a Copilot provider; `on` probes regardless.
		provider = settings.mode === "on" ? "mode on" : settings.mode === "off" ? undefined : copilotProvider(options.detect());
		if (stopped || !provider) {
			probe = undefined; credential = undefined;
			snapshot = { checkedAt: clock(), staleAfter: 300_000, state: "absent", windows: [], error: settings.mode === "off" ? "Meter off" : "No Copilot provider configured in Pi" };
			publish(); return Promise.resolve(snapshot);
		}
		if (pending) return pending;
		const age = clock() - snapshot.checkedAt;
		if (!force && snapshot.checkedAt && age < (minimumMs ?? settings.pollSeconds * 1000)) { publish(); return Promise.resolve(snapshot); }
		controller = new AbortController();
		const signal = controller.signal;
		pending = (async () => {
			try {
				probe = await probeCopilot(options.detect(), signal, options.fetcher, credential);
				if (stopped || signal.aborted) return snapshot;
				const staleAfter = settings.pollSeconds * 2000;
				if (probe.result?.success) {
					credential = probe.credential; usage = probe.result.usage;
					snapshot = { checkedAt: clock(), staleAfter, state: "ok", source: credential!.source, plan: usage.plan, windows: usage.windows };
				} else {
					credential = undefined;
					// A configured provider that yields no quota is worth a chip: the user expects the meter.
					snapshot = { checkedAt: clock(), staleAfter, state: "error", windows: [],
						error: probe.result && !probe.result.success ? probe.result.error : "No Copilot credential found" };
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
			const lines = [`## Copilot usage`, "", `- Mode: ${settings.mode}. Provider: ${provider ?? "not configured in Pi"}. Sources: ${settings.sources.join(", ")}.${settings.domain ? ` Domain: ${settings.domain}.` : ""}`];
			if (snapshot.state === "ok" && snapshot.source) lines.push(`- Source: ${SOURCE_LABELS[snapshot.source]}.${snapshot.plan ? ` Plan: ${snapshot.plan}.` : ""}`);
			else lines.push(`- State: ${snapshot.state}${snapshot.error ? ` (${snapshot.error})` : ""}.`);
			for (const t of probe?.tried ?? []) lines.push(`- Tried ${SOURCE_LABELS[t.source]} (${t.detail}): ${t.error ?? "accepted"}.`);
			if (snapshot.windows.length) {
				lines.push("", "| Quota | Remaining | Used / entitlement | Reset |", "| --- | ---: | --- | --- |");
				for (const w of snapshot.windows) {
					const counts = w.entitlement !== undefined && w.remaining !== undefined ? `${Math.round(w.entitlement - w.remaining)} / ${Math.round(w.entitlement)}${w.overagePermitted ? " (overage on)" : ""}` : "—";
					lines.push(`| ${w.label} | ${w.remainingPercent.toFixed(0)}% | ${counts} | ${w.resetsAt ?? "not reported"} |`);
				}
			} else if (snapshot.state === "ok") lines.push("- Every quota on this plan is unlimited.");
			return lines.join("\n");
		},
	};
}
