import { execFile } from "node:child_process";
import { kitCommand } from "./okknow.ts";
import type { ArtifactsServer, ArtifactsState } from "./types.ts";

/** One reading of `artifacts --json status` serves the footer for this long. `/artifacts start` shows in the row within this time. */
export const ARTIFACTS_CACHE_MS = 60_000;
/** The whole status run, after which the footer stops it. The health request of the CLI has its own limit of 5 seconds. */
const ARTIFACTS_RUN_MS = 15_000;
const STATES: ReadonlySet<string> = new Set<ArtifactsState>(["running", "stopped", "remote", "unreachable", "error"]);

/** The artifacts CLI: the first on PATH, else the kit link `~/.local/bin/artifacts`. */
export const artifactsCommand = (env: NodeJS.ProcessEnv = process.env, home?: string): string | undefined => kitCommand("artifacts", env, home);

/**
 * The link target of the row: only an `http` or `https` URL with no user name or password. A value with a control character
 * gives no link, so that the URL cannot end the OSC 8 sequence and start a sequence of its own.
 */
export function artifactsLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f-\x9f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return /[\x00-\x1f\x7f-\x9f]/.test(url.href) ? undefined : url.href;
  } catch { return; }
}

/**
 * The footer state from the JSON of `artifacts --json status`. `undefined`: the module has no configuration, so no row.
 * Only the `state` word and the `url` are read. An unknown word or a bad JSON is `error`.
 */
export function artifactsStatus(stdout: string): ArtifactsServer | undefined {
  let value: { state?: unknown; url?: unknown } | undefined;
  try { const parsed: unknown = JSON.parse(stdout); if (parsed && typeof parsed === "object") value = parsed; } catch { /* not JSON */ }
  if (value?.state === "unconfigured") return undefined;
  if (typeof value?.state !== "string" || !STATES.has(value.state)) return { state: "error" };
  const url = artifactsLink(value.url);
  return { state: value.state as ArtifactsState, ...(url ? { url } : {}) };
}

/**
 * Run `artifacts --json status` in the background. The footer sends no request of its own; the CLI checks only its configured origin.
 * `track` receives a stop function so dispose can end a running check. No CLI: `undefined`, so no row.
 */
export function checkArtifacts(track: (stop: () => void) => () => void = () => () => {}): Promise<ArtifactsServer | undefined> {
  const command = artifactsCommand();
  if (!command) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let untrack = () => {};
    const child = execFile(command, ["--json", "status"], { timeout: ARTIFACTS_RUN_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      untrack();
      if (!error) return resolve(artifactsStatus(String(stdout)));
      const code = (error as { code?: unknown }).code;
      // A CLI that cannot start shows no row. A failed or stopped run is an error.
      resolve(typeof code === "string" ? undefined : { state: "error" });
    });
    child.stdin?.end();
    untrack = track(() => child.kill());
  });
}
