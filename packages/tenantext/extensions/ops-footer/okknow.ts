import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { OkknowState } from "./types.ts";

/** One reading of `okknow --json doctor` serves the footer for this long. */
export const OKKNOW_CACHE_MS = 5 * 60_000;
/** The whole doctor run, after which the footer stops it. Each request of the CLI has its own shorter limit. */
const OKKNOW_RUN_MS = 30_000;
const STATES: ReadonlySet<string> = new Set<OkknowState>(["connected", "no-credentials", "unreachable", "auth-failed", "error"]);

const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};
/** The okknow CLI: the first on PATH, else the kit link `~/.local/bin/okknow`. */
export function okknowCommand(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isAbsolute(dir) && executable(join(dir, "okknow"))) return join(dir, "okknow");
  }
  const link = join(home, ".local/bin/okknow");
  return executable(link) ? link : undefined;
}

/**
 * The footer state from the exit code and the JSON of `okknow --json doctor`. `undefined`: no origin is configured, so no row.
 * Only the `state` word is read; the check details can name the origin and stay out of the footer.
 */
export function okknowState(code: number | null, stdout: string): OkknowState | undefined {
  if (code === 4) return undefined;
  let state: unknown;
  try { state = (JSON.parse(stdout) as { state?: unknown })?.state; } catch { /* not JSON */ }
  if (state === "not-configured") return undefined;
  return typeof state === "string" && STATES.has(state) ? state as OkknowState : "error";
}

/**
 * Run the doctor of the okknow CLI in the background. The CLI sends the credentials only to its configured origin.
 * `track` receives a stop function so dispose can end a running check.
 */
export function checkOkknow(track: (stop: () => void) => () => void = () => () => {}): Promise<OkknowState | undefined> {
  const command = okknowCommand();
  if (!command) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let untrack = () => {};
    const child = execFile(command, ["--json", "doctor"], {
      timeout: OKKNOW_RUN_MS, maxBuffer: 256 * 1024, windowsHide: true, env: { ...process.env, OKKNOW_TIMEOUT: "8" },
    }, (error, stdout) => {
      untrack();
      if (!error) return resolve(okknowState(0, String(stdout)));
      const code = (error as { code?: unknown }).code;
      // A stopped run (timeout) reads as unreachable; a CLI that cannot start shows no row.
      if (typeof code === "number") resolve(okknowState(code, String(stdout)));
      else resolve(typeof code === "string" ? undefined : "unreachable");
    });
    child.stdin?.end();
    untrack = track(() => child.kill());
  });
}
