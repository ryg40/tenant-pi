import { apiHost, type CopilotCredential } from "./detect.ts";

/** One quota bucket from `GET https://api.<domain>/copilot_internal/user`. Unlimited buckets are dropped: they never run out. */
export interface CopilotWindow {
	label: "premium" | "chat" | "compl";
	remainingPercent: number;
	remaining?: number;
	entitlement?: number;
	overagePermitted?: boolean;
	resetsAt?: string;
}
export interface CopilotUsage { plan?: string; windows: CopilotWindow[]; resetsAt?: string }
export type CopilotUsageResult =
	| { success: true; usage: CopilotUsage }
	| { success: false; error: string; auth: boolean };

const FETCH_TIMEOUT_MS = 10_000;
const HEADERS = {
	Accept: "application/json",
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"X-GitHub-Api-Version": "2025-04-01",
};
const LABELS: Record<string, CopilotWindow["label"]> = { premium_interactions: "premium", chat: "chat", completions: "compl" };

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** Accept `2026-10-01` or a full ISO timestamp. Output is always a full ISO string. */
export function resetDate(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
	if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return;
	const time = Date.parse(iso);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Paid plans report `quota_snapshots`; the free plan reports `limited_user_quotas` (remaining) against `monthly_quotas` (entitlement). */
export function parseCopilotUsage(value: unknown): CopilotUsage {
	const v = record(value) ?? {};
	const resetsAt = resetDate(v.quota_reset_date_utc) ?? resetDate(v.quota_reset_date) ?? resetDate(v.limited_user_reset_date);
	// The free tier reports `copilot_plan: individual` with a `free_limited_copilot` SKU; the SKU is the more useful label there.
	const sku = typeof v.access_type_sku === "string" && /^[a-z_]{1,40}$/.test(v.access_type_sku) ? v.access_type_sku : undefined;
	const plan = sku?.includes("free") ? "free" : typeof v.copilot_plan === "string" && /^[a-z_]{1,40}$/.test(v.copilot_plan) ? v.copilot_plan : sku;
	const windows: CopilotWindow[] = [];
	const snapshots = record(v.quota_snapshots);
	if (snapshots) {
		for (const key of ["premium_interactions", "chat", "completions"]) {
			const q = record(snapshots[key]);
			if (!q || q.unlimited === true || q.has_quota === false) continue;
			const entitlement = finite(q.entitlement), remaining = finite(q.quota_remaining) ?? finite(q.remaining);
			const percent = finite(q.percent_remaining) ?? (entitlement && remaining !== undefined ? remaining / entitlement * 100 : undefined);
			if (percent === undefined || !entitlement) continue;
			windows.push({ label: LABELS[key], remainingPercent: clamp(percent), remaining, entitlement,
				overagePermitted: typeof q.overage_permitted === "boolean" ? q.overage_permitted : undefined, resetsAt: resetDate(q.reset_date) ?? resetsAt });
		}
	}
	const limited = record(v.limited_user_quotas), monthly = record(v.monthly_quotas);
	if (!windows.length && limited && monthly) {
		for (const key of ["chat", "completions"]) {
			const remaining = finite(limited[key]), entitlement = finite(monthly[key]);
			if (remaining === undefined || !entitlement) continue;
			windows.push({ label: LABELS[key], remainingPercent: clamp(remaining / entitlement * 100), remaining, entitlement, resetsAt });
		}
	}
	return { plan, windows, resetsAt };
}

export async function fetchCopilotUsage(credential: CopilotCredential, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<CopilotUsageResult> {
	const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
	if (signal) signals.push(signal);
	try {
		const response = await fetcher(`https://${apiHost(credential.domain)}/copilot_internal/user`, {
			headers: { ...HEADERS, Authorization: `token ${credential.token}` }, redirect: "error", signal: AbortSignal.any(signals),
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			// 401/403/404: this token has no Copilot seat or the wrong scope. The caller tries the next source.
			return { success: false, error: `HTTP ${response.status}`, auth: [401, 403, 404].includes(response.status) };
		}
		return { success: true, usage: parseCopilotUsage(await response.json()) };
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return { success: false, error: name === "AbortError" || name === "TimeoutError" ? (signal?.aborted ? "Request cancelled" : "Request timed out") : "Network request failed", auth: false };
	}
}
