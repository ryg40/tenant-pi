const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Epoch milliseconds of an ISO 8601 timestamp with a real calendar date and an explicit zone (`Z` or `+hh:mm`).
 * Undefined for a nonstring, a missing zone, a date such as `02-30`, or a time such as `24:00`. No Pi import.
 */
export function parseZonedTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = TIMESTAMP.exec(value);
	if (!match) return undefined;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (year < 1000 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return undefined;
	const offsetHours = match[10] ? Number(match[10]) : 0, offsetMinutes = match[11] ? Number(match[11]) : 0;
	if (offsetHours > 23 || offsetMinutes > 59) return undefined;
	const offset = (match[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
	const millis = match[7] ? Number(match[7].padEnd(3, "0").slice(0, 3)) : 0;
	const time = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset;
	return Number.isFinite(time) ? time : undefined;
}

/** A provider check time later than this after the local clock contradicts the reading. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Provider evidence older than this is stale. The threshold does not prove the current subscription state. */
export const PERIOD_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * The state of a saved period end at `now`. Every state is cached evidence: none of them verifies a billing date.
 * `past`: the period end is at or before `now`. `stale`: the provider check is older than a day or its time is unknown.
 */
export type PeriodState = "cached" | "stale" | "past";
export function periodState(endsAt: number, checkedAt: number | undefined, now: number): PeriodState {
	if (endsAt <= now) return "past";
	return checkedAt === undefined || now - checkedAt > PERIOD_STALE_MS ? "stale" : "cached";
}
