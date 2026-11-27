import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { AntigravityAbsence, LimitsWindow } from "./types.ts";

/**
 * The Antigravity quota row. The source is `agy -p "/usage" --output-format json`: a read-only slash command in print mode,
 * with no agent turn, no quota use and no saved conversation. The kit opens no sign-in or token file of `agy`: it only checks
 * with `stat` that the sign-in file exists, and reads its modification time.
 */
/** At most one `agy` run in this time, for every Pi session of the computer (the shared reading). */
export const ANTIGRAVITY_POLL_MS = 5 * 60_000;
/** The whole `agy` run, after which the footer stops it. */
const AGY_RUN_MS = 15_000;
/** A claim younger than this, with no reading, is a run of another session that is still going: ask again soon. */
const AGY_CLAIM_RUNNING_MS = AGY_RUN_MS + 5_000;
/** The runtime asks again after this time when another session is still running `agy`. One file read, not an `agy` run. */
export const ANTIGRAVITY_RETRY_MS = 20_000;
/** No run in this time after a sign-in request or a run that the time limit stopped. */
export const ANTIGRAVITY_BACKOFF_MS = 6 * 60 * 60_000;
/** `agy` exits with this code when it signs in with an API key: that sign-in has no account quota. */
const AGY_NO_ACCOUNT = 2;
/**
 * The text of `agy` on stderr when it has no sign-in, in any case: "Authentication required. Please visit the URL" when it waits
 * for a browser sign-in, "Error: authentication required. Run 'agy' to log in" when it exits at once. Not a contract of `agy`:
 * a run that the time limit stops also backs off.
 */
const AGY_SIGN_IN_TEXT = /authentication required/i;

/** A group that is not on the row: only `/ops-footer report` shows it. */
export interface AntigravityGroup { name: string; windows: LimitsWindow[] }
/** `windows`: the `5h` and `7d` windows of the Gemini group. No windows: no row. */
export interface AntigravityReading { windows: LimitsWindow[]; other: AntigravityGroup[] }
/**
 * `none`: no row, with the reason for the report. `failed`: keep the last reading; `retryMs`: another session is still
 * running `agy`, so ask again after this time.
 */
export type AntigravityResult = { kind: "reading"; at: number; reading: AntigravityReading } | ({ kind: "none" } & AntigravityAbsence)
  | { kind: "failed"; retryMs?: number };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
/**
 * Group names are short plain labels of a model group: up to 48 letters, digits, spaces and `.,&()+-`, and the last word is
 * `models` in any case ("Gemini Models", "Claude and GPT models"). Any other text never crosses to the footer or the shared file.
 */
const groupName = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 .,&()+-]{0,47}$/.test(value) && /(?:^|\s)models$/i.test(value) ? value : undefined;
const BUCKET_WINDOWS: Readonly<Record<string, string>> = { "5h": "5h", weekly: "7d" };
const resetEpoch = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};
/** The `5h` window, then the `7d` window. A bucket of another window, or with no valid fraction, is left out. */
function bucketWindows(buckets: unknown): LimitsWindow[] {
  const found = new Map<string, LimitsWindow>();
  for (const raw of Array.isArray(buckets) ? buckets.slice(0, 8) : []) {
    const b = record(raw), name = BUCKET_WINDOWS[String(b?.window)];
    const fraction = finite(b?.remaining_fraction);
    if (!b || !name || found.has(name) || fraction === undefined || fraction < 0 || fraction > 1) continue;
    found.set(name, { name, percent: fraction * 100, unavailable: false, resetsAt: resetEpoch(b.reset_time) });
  }
  return ["5h", "7d"].flatMap(name => found.has(name) ? [found.get(name)!] : []);
}
/**
 * The reading of the `/usage` payload. `undefined`: an unknown shape. A known shape with no Gemini group gives a reading
 * with no windows, so no row. Only the group names, the windows, the fractions and the reset times are read.
 */
export function parseAntigravityUsage(payload: unknown): AntigravityReading | undefined {
  const groups = record(record(record(payload)?.command)?.data)?.groups;
  if (!Array.isArray(groups)) return;
  const reading: AntigravityReading = { windows: [], other: [] };
  for (const raw of groups.slice(0, 8)) {
    const g = record(raw), name = groupName(g?.name);
    if (!g || !name) continue;
    const windows = bucketWindows(g.buckets);
    // The first group whose name starts with Gemini gives the row; a later Gemini group goes nowhere.
    if (/^Gemini\b/i.test(name)) { if (!reading.windows.length) reading.windows = windows; }
    else if (windows.length) reading.other.push({ name, windows });
  }
  return reading;
}

const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};
/** The first `agy` on PATH. There is no other place: a row needs `agy` on the PATH of the session. */
export function agyCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isAbsolute(dir) && executable(join(dir, "agy"))) return join(dir, "agy");
  }
}

/** The home folder for the sign-in file and the default cache folder: the option, then `HOME` of `env`, then the process home. */
const homeOf = (env: NodeJS.ProcessEnv, home?: string): string => home ?? (env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir());
/** The sign-in file of `agy`. The footer only checks it with `stat`; it never opens it. */
export const antigravitySignInPath = (home: string): string => join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
/** The modification time of the sign-in file, or `undefined` when it does not exist. It calls `statSync` only and never opens the file. */
export const antigravitySignInMtime = (home: string): number | undefined => {
  try { const s = statSync(antigravitySignInPath(home)); return s.isFile() ? s.mtimeMs : undefined; } catch { return; }
};

/**
 * One reading for every Pi session of the computer, in the cache folder of the Claude meter
 * (`$XDG_CACHE_HOME/claude-pi-footer/antigravity-usage.json`). Shape: `{ attemptAt, at, windows, other, backoffAt, backoffUntil }`.
 * `attemptAt` is the claim time of the last run of any session, `at` the time of the last good reading, and `backoffAt` to
 * `backoffUntil` a back-off of every session. The file holds no account name or address.
 */
export const antigravityReadingPath = (env: NodeJS.ProcessEnv = process.env, home?: string): string =>
  join(env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homeOf(env, home), ".cache"), "claude-pi-footer", "antigravity-usage.json");
interface Stored { at?: number; attemptAt?: number; backoffAt?: number; backoffUntil?: number; reading?: AntigravityReading }
const storedWindows = (value: unknown): LimitsWindow[] => (Array.isArray(value) ? value.slice(0, 2) : []).flatMap(raw => {
  const w = record(raw), percent = finite(w?.percent);
  if (!w || (w.name !== "5h" && w.name !== "7d") || percent === undefined || percent < 0 || percent > 100) return [];
  return [{ name: w.name, percent, unavailable: false, resetsAt: finite(w.resetsAt) }];
});
function load(path: string): Record<string, unknown> {
  try { return record(JSON.parse(readFileSync(path, "utf8"))) ?? {}; } catch { return {}; }
}
function read(path: string): Stored {
  const v = load(path), at = finite(v.at);
  const other = (Array.isArray(v.other) ? v.other.slice(0, 8) : []).flatMap(raw => {
    const g = record(raw), name = groupName(g?.name);
    return g && name ? [{ name, windows: storedWindows(g.windows) }] : [];
  });
  return { at, attemptAt: finite(v.attemptAt), backoffAt: finite(v.backoffAt), backoffUntil: finite(v.backoffUntil),
    ...(at !== undefined ? { reading: { windows: storedWindows(v.windows), other } } : {}) };
}
/** A rename replaces the file in one step, so a reader never sees half a file. A file that cannot be written does not stop the row. */
function save(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { try { unlinkSync(temporary); } catch { /* no temporary file */ } }
}
const plain = (windows: LimitsWindow[]) => windows.map(w => ({ name: w.name, percent: w.percent, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) }));
/** The good reading of the shared file, without a back-off. */
const readingPart = (stored: Stored) => stored.reading && stored.at !== undefined
  ? { at: stored.at, windows: plain(stored.reading.windows), other: stored.reading.other.map(g => ({ name: g.name, windows: plain(g.windows) })) } : {};

/**
 * `undefined`: it did not start, or dispose stopped it. `signIn`: `agy` asked for a sign-in, or the time limit stopped it;
 * both start the back-off.
 */
type RunResult = { code?: number; stdout: string; signIn: boolean } | undefined;
/** Run `agy` with no shell. A sign-in request on stderr stops it at once; the browser of `agy` may have opened by then. */
function runAgy(command: string, env: NodeJS.ProcessEnv, track: (stop: () => void) => () => void): Promise<RunResult> {
  return new Promise(resolve => {
    let untrack = () => {}, disposed = false, signIn = false, seen = "";
    const child = execFile(command, ["-p", "/usage", "--output-format", "json"], { timeout: AGY_RUN_MS, maxBuffer: 256 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
      untrack();
      if (disposed) return resolve(undefined);
      if (AGY_SIGN_IN_TEXT.test(String(stderr))) signIn = true;
      if (!error) return resolve({ code: 0, stdout: String(stdout), signIn });
      const e = error as { code?: unknown; killed?: boolean };
      // A stop at the time limit has no exit code: Node kills the child and gives `killed` with a null code.
      if (e.killed && (e.code === null || e.code === undefined)) return resolve({ stdout: String(stdout), signIn: true });
      resolve(typeof e.code === "number" ? { code: e.code, stdout: String(stdout), signIn } : signIn ? { stdout: String(stdout), signIn } : undefined);
    });
    child.stderr?.on("data", chunk => {
      seen = (seen + String(chunk)).slice(-4096);
      if (!signIn && AGY_SIGN_IN_TEXT.test(seen)) { signIn = true; child.kill(); }
    });
    child.stdin?.end();
    untrack = track(() => { disposed = true; child.kill(); });
  });
}

export interface AntigravityOptions {
  env?: NodeJS.ProcessEnv; home?: string; now?: () => number;
  /** The setting `antigravityUsage`. `auto` (the default) runs `agy` only when its sign-in file exists; `on` skips that check. */
  usage?: "auto" | "on";
}
/**
 * The Antigravity reading, through the shared file. In `auto`, no sign-in file gives no run. A back-off in the shared file gives
 * no row and no run, until it ends or the sign-in file changes after its start. A claim `attemptAt` younger than
 * `ANTIGRAVITY_POLL_MS` gives the last reading with no run; otherwise this session claims the run. `track` receives a stop
 * function so dispose can end a running `agy`.
 */
export async function checkAntigravity(track: (stop: () => void) => () => void = () => () => {}, options: AntigravityOptions = {}): Promise<AntigravityResult> {
  const env = options.env ?? process.env, clock = options.now ?? Date.now, home = homeOf(env, options.home);
  const command = agyCommand(env);
  if (!command) return { kind: "none", reason: "no-agy" };
  const signedIn = antigravitySignInMtime(home);
  if ((options.usage ?? "auto") === "auto" && signedIn === undefined) return { kind: "none", reason: "no-sign-in" };
  const path = antigravityReadingPath(env, home), stored = read(path), now = clock();
  const { backoffAt, backoffUntil } = stored;
  // A back-off from a clock that went back, or longer than the back-off time, does not hold.
  if (backoffAt !== undefined && backoffUntil !== undefined && backoffAt <= now && now < backoffUntil && backoffUntil - backoffAt <= ANTIGRAVITY_BACKOFF_MS
    && !(signedIn !== undefined && signedIn > backoffAt)) return { kind: "none", reason: "back-off", until: backoffUntil };
  // A back-off that ended early by a new sign-in needs no wait for its claim.
  const ended = backoffAt !== undefined && signedIn !== undefined && signedIn > backoffAt;
  const last: AntigravityResult = stored.reading && stored.at !== undefined && stored.at <= now ? { kind: "reading", at: stored.at, reading: stored.reading } : { kind: "failed" };
  const since = now - (stored.attemptAt ?? -Infinity);
  if (!ended && since >= 0 && since < ANTIGRAVITY_POLL_MS) {
    return last.kind === "failed" && since < AGY_CLAIM_RUNNING_MS ? { kind: "failed", retryMs: ANTIGRAVITY_RETRY_MS } : last;
  }
  save(path, { ...readingPart(stored), attemptAt: now });
  const result = await runAgy(command, env, track);
  const done = clock();
  if (result?.signIn) {
    // A sign-in request, or no answer in time: no session runs `agy` again before the back-off ends, so no new browser tab opens.
    save(path, { attemptAt: now, backoffAt: now, backoffUntil: now + ANTIGRAVITY_BACKOFF_MS });
    return { kind: "none", reason: "back-off", until: now + ANTIGRAVITY_BACKOFF_MS };
  }
  if (result?.code === AGY_NO_ACCOUNT) {
    // An API-key sign-in has no account quota: an empty reading, so every session drops the row.
    save(path, { attemptAt: now, at: done, windows: [], other: [] });
    return { kind: "none", reason: "api-key" };
  }
  let reading: AntigravityReading | undefined;
  if (result?.code === 0) try { reading = parseAntigravityUsage(JSON.parse(result.stdout)); } catch { /* not JSON */ }
  if (!reading) return last;
  save(path, { attemptAt: now, at: done, windows: plain(reading.windows), other: reading.other.map(g => ({ name: g.name, windows: plain(g.windows) })) });
  return { kind: "reading", at: done, reading };
}
