import type { AnthropicCredential } from "./detect.ts";

/** One quota window from `GET https://api.anthropic.com/api/oauth/usage`. */
export interface AnthropicWindow {
	label: "5h" | "7d" | "opus" | "sonnet";
	remainingPercent: number;
	resetsAt?: string;
}
export interface AnthropicUsage { windows: AnthropicWindow[] }
export type AnthropicUsageResult =
	| { success: true; usage: AnthropicUsage }
	| { success: false; error: string; auth: boolean };

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 15_000;
const HEADERS = { Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" };
/** Payload key to window label. Every other key of the payload is ignored. */
const WINDOWS: readonly (readonly [string, AnthropicWindow["label"]])[] = [
	["five_hour", "5h"], ["seven_day", "7d"], ["seven_day_opus", "opus"], ["seven_day_sonnet", "sonnet"],
];

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** The endpoint reports an offset and microseconds. Output is always `toISOString()`, which the footer accepts. */
export function resetDate(value: unknown): string | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
	// Keep milliseconds only: the date parser of an older runtime can reject six fraction digits.
	const time = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** `utilization` is the percent used, 0 to 100. A window that is null or has no numeric `utilization` is dropped. */
export function parseAnthropicUsage(value: unknown): AnthropicUsage {
	const v = record(value) ?? {};
	const windows: AnthropicWindow[] = [];
	for (const [key, label] of WINDOWS) {
		const w = record(v[key]);
		const used = finite(w?.utilization);
		if (!w || used === undefined) continue;
		const resetsAt = resetDate(w.resets_at);
		windows.push({ label, remainingPercent: clamp(100 - used), ...(resetsAt ? { resetsAt } : {}) });
	}
	return { windows };
}

/** One read-only request. It never follows a redirect and never reads an error body. */
export async function fetchAnthropicUsage(credential: AnthropicCredential, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AnthropicUsageResult> {
	const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
	if (signal) signals.push(signal);
	try {
		const response = await fetcher(ANTHROPIC_USAGE_URL, {
			method: "GET", headers: { ...HEADERS, Authorization: `Bearer ${credential.token}` }, redirect: "error", signal: AbortSignal.any(signals),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			// 401/403: this login is not accepted. The caller tries the next source.
			return { success: false, error: `HTTP ${response.status}`, auth: response.status === 401 || response.status === 403 };
		}
		const usage = parseAnthropicUsage(await response.json());
		// A payload with no known window is not a reading. The error text is fixed: no payload text crosses.
		return usage.windows.length ? { success: true, usage } : { success: false, error: "Usage payload not recognized", auth: false };
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return { success: false, error: name === "AbortError" || name === "TimeoutError" ? (signal?.aborted ? "Request cancelled" : "Request timed out") : "Network request failed", auth: false };
	}
}
