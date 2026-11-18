import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseAnthropicUsage, type AnthropicWindow } from "./usage.ts";

/**
 * One usage reading for every client of the Claude Code login on this host. Each Pi meter, and a Claude Code status line
 * that uses the same file, reads it before it asks the endpoint, because the endpoint answers HTTP 429 when several
 * clients poll. Shape: `{ attemptAt, at, limits: [{ kind, percent, resets_at, scope: { model: { display_name } } }] }`.
 * `at` is the time of the last good reading. `attemptAt` is the time of the last request of any client. No token is in the file.
 * With an account store the file of a slot also has `account`, a short hash of the account id of the reading.
 */
export const ATTEMPT_MS = 5 * 60_000;
export interface SharedReading { at?: number; attemptAt?: number; windows: AnthropicWindow[] }
export interface SharedStore {
	read(): SharedReading;
	/** Claim the next request. False when any client asked less than `ATTEMPT_MS` ago. */
	claim(now: number): boolean;
	write(now: number, windows: AnthropicWindow[]): void;
}

export const sharedCacheDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
	join(env.XDG_CACHE_HOME || join(home, ".cache"), "claude-pi-footer");
/** With an account store (`claude-account`), each slot has its own file, so a reading never crosses to the other account. */
export const sharedReadingPath = (env: NodeJS.ProcessEnv = process.env, home = homedir(), slot?: string): string =>
	join(sharedCacheDir(env, home), slot ? `usage-${slot}.json` : "usage.json");

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
function load(path: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch { return {}; }
}
/** A rename replaces the file in one step, so a reader never sees half a file. */
function save(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Windows as the `limits` list of the endpoint: `5h` is `session`, `7d` is `weekly_all`, any other label is a model-scoped weekly limit. */
export function limitsOf(windows: AnthropicWindow[]) {
	return windows.map(w => {
		const fixed = w.label === "5h" ? "session" : w.label === "7d" ? "weekly_all" : undefined;
		return { kind: fixed ?? "weekly_scoped", percent: 100 - w.remainingPercent, resets_at: w.resetsAt ?? null,
			scope: { model: fixed ? {} : { display_name: w.label } } };
	});
}

/** `account`: the hash of the account id that the reading must have. A reading of another account reads as no reading. */
export function fileSharedStore(path = sharedReadingPath(), account: () => string | undefined = () => undefined): SharedStore {
	return {
		read() {
			const v = load(path), key = account();
			if (key !== undefined && v.account !== key) return { attemptAt: finite(v.attemptAt), windows: [] };
			return { at: finite(v.at), attemptAt: finite(v.attemptAt), windows: parseAnthropicUsage({ limits: v.limits }).windows };
		},
		claim(now) {
			const v = load(path), since = now - (finite(v.attemptAt) ?? -Infinity);
			if (since >= 0 && since < ATTEMPT_MS) return false;
			// A file that cannot be written does not stop the meter: it then asks on its own poll, as before.
			try { save(path, { ...v, attemptAt: now }); } catch { /* The shared file is optional. */ }
			return true;
		},
		write(now, windows) {
			const key = account();
			try { save(path, { attemptAt: now, at: now, limits: limitsOf(windows), ...(key !== undefined ? { account: key } : {}) }); } catch { /* The shared file is optional. */ }
		},
	};
}
