import { normalize, resolve, sep } from "node:path";
import type { CallRecord, TraceFilter } from "./types.ts";

/** Compare paths after resolving dot segments and with a directory boundary. */
export function pathIsInside(candidate: string | undefined, root: string): boolean {
	if (!candidate) return false;
	const normalizedCandidate = normalize(resolve(candidate));
	const normalizedRoot = normalize(resolve(root));
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + sep);
}

/** Apply session-level controls before the legacy per-record cutoff. */
export function filterSessionRecords(records: CallRecord[], filter: TraceFilter): CallRecord[] {
	if (!records.length) return [];
	// A record with an unparseable timestamp carries 0; it must not drag the session start to the epoch.
	const times = records.map((record) => record.timestamp).filter((time) => time > 0);
	const sessionStart = times.length ? Math.min(...times) : undefined;
	if (filter.sessionStartedSince !== undefined && (sessionStart === undefined || sessionStart < filter.sessionStartedSince)) return [];
	return records.filter((record) => {
		if (filter.cwd && record.cwd !== filter.cwd) return false;
		if (filter.cwdInside && !pathIsInside(record.cwd, filter.cwdInside)) return false;
		return filter.since === undefined || record.timestamp >= filter.since;
	});
}
