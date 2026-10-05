export interface CodexLimitWindow {
	/** Derived from the reported duration, e.g. `5h` or `7d`. `window` when the duration is not reported. */
	label: string;
	usedPercent: number;
	remainingPercent: number;
	/** Reported window duration. Absent when the payload omits it or it is malformed. */
	seconds?: number;
	resetsAt?: Date;
	unavailable?: boolean;
}

/**
 * Normalized ChatGPT plan for a Codex account. `unknown` means the payload named a plan outside this allowlist.
 * The server string itself never crosses this boundary.
 */
export const CODEX_PLANS = ["free", "go", "plus", "pro", "pro_lite", "team", "business", "enterprise", "edu", "unknown"] as const;
export type CodexPlan = typeof CODEX_PLANS[number];

export interface CodexUsage {
	/** Absent when the payload does not report a plan. */
	plan?: CodexPlan;
	windows: CodexLimitWindow[];
}

const PLAN_ALIASES: Record<string, CodexPlan> = {
	free: "free", guest: "free", free_workspace: "free",
	go: "go",
	plus: "plus",
	pro: "pro",
	// `prolite` is a weekly-only Pro plan identifier in usage responses.
	prolite: "pro_lite", pro_lite: "pro_lite",
	team: "team",
	business: "business", self_serve_business_usage_based: "business",
	enterprise: "enterprise", enterprise_cbp_usage_based: "enterprise",
	edu: "edu", education: "edu", k12: "edu",
};

export function normalizeCodexPlan(value: unknown): CodexPlan | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") return "unknown";
	const key = value.trim().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_");
	return Object.hasOwn(PLAN_ALIASES, key) ? PLAN_ALIASES[key] : "unknown";
}

function parseDateish(value: unknown): Date | undefined {
	if (typeof value === "number") {
		const date = new Date(value > 10 ** 11 ? value : value * 1000);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	return undefined;
}

function usedPercent(limit: Record<string, unknown>): number {
	const remaining = limit.percent_left ?? limit.remaining_percent;
	const raw = remaining ?? limit.used_percent;
	if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return Number.NaN;
	const value = Number(raw);
	if (!Number.isFinite(value)) return Number.NaN;
	return remaining != null ? 100 - value : value;
}

const MINUTE = 60, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

function windowSeconds(limit: Record<string, unknown>): number | undefined {
	const raw = limit.limit_window_seconds;
	const seconds = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
	return Number.isInteger(seconds) && seconds > 0 && seconds <= 999 * DAY ? seconds : undefined;
}

/** The label names the reported duration only. The response slot (primary or secondary) never implies a duration. */
function windowLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined) return fallback;
	if (seconds % DAY === 0) return `${seconds / DAY}d`;
	if (seconds % HOUR === 0 && seconds / HOUR <= 999) return `${seconds / HOUR}h`;
	if (seconds % MINUTE === 0 && seconds / MINUTE <= 999) return `${seconds / MINUTE}m`;
	return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Derived from the Codex-only parser in @latentminds/pi-quotas.
 * See THIRD_PARTY_NOTICES.md and licenses/pi-quotas-MIT.txt.
 *
 * Returns only the windows the payload reports. A weekly-only plan reports one window, in either slot,
 * and the parser never adds a placeholder for a window the payload does not contain.
 */
export function parseCodexUsage(data: unknown): CodexUsage {
	const root = asRecord(data) ?? {};
	const rateLimit = asRecord(root.rate_limit) ?? asRecord(root.rate_limits) ?? {};
	// One window per slot, first matching key wins. Legacy key names state their duration; slot names do not.
	const slot = (keys: Array<[string, string]>): [Record<string, unknown>, string] | undefined => {
		for (const [key, fallback] of keys) {
			const limit = asRecord(rateLimit[key]);
			if (limit) return [limit, fallback];
		}
		return undefined;
	};
	const slots = [
		slot([["primary_window", "window"], ["primary", "window"], ["five_hour_limit", "5h"], ["five_hour", "5h"]]),
		slot([["secondary_window", "window"], ["secondary", "window"], ["weekly_limit", "7d"], ["weekly", "7d"]]),
	];
	const windows: CodexLimitWindow[] = [];
	for (const found of slots) {
		if (!found) continue;
		const [limit, fallback] = found;
		const parsed = usedPercent(limit);
		const unavailable = !Number.isFinite(parsed);
		const used = unavailable ? 0 : Math.min(100, Math.max(0, parsed));
		const seconds = windowSeconds(limit);
		windows.push({
			label: windowLabel(seconds, fallback),
			usedPercent: used,
			remainingPercent: unavailable ? 0 : Math.max(0, 100 - used),
			...(seconds !== undefined ? { seconds } : {}),
			...(unavailable ? { unavailable: true } : {}),
			resetsAt: parseDateish(limit.reset_at ?? limit.reset_time_ms),
		});
	}
	// Shortest window first. Unknown durations keep their slot order after the known ones.
	windows.sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity));
	const plan = normalizeCodexPlan(root.plan_type);
	return { ...(plan ? { plan } : {}), windows };
}

/** Windows only. Kept for callers and tests that do not need the plan. */
export function parseCodexLimits(data: unknown): CodexLimitWindow[] {
	return parseCodexUsage(data).windows;
}
