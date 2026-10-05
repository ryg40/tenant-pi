#!/usr/bin/env node
/**
 * `promptr-tracker-init` — bind a project (or this machine) to a tracker
 * provider by writing one small JSON file.
 *
 * The file names the provider, host, owner and repository. It carries no
 * secrets: the token (`GITEA_TOKEN`/`GITHUB_TOKEN`) stays in the environment
 * and is only reported as present or absent. The command never launches
 * anything, never edits `settings.json` or a shell profile, and refuses to
 * clobber an existing file without `--force`. `--check` performs one bounded
 * page-1 read through the provider-routed ports and reports the count or the
 * failure reason.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultRepo, type TrackingProvider } from "./gitea.mts";
import { trackingPorts, type TrackingReadPorts } from "./ports.mts";
import {
  DEFAULT_GITEA_HOST, DEFAULT_GITHUB_HOST, inferBindingFromRemote, providerDefaultHost, resolveTrackerBinding,
  serializeTrackerBinding, tokenVariableFor, trackerBindingFiles, validateTrackerBinding, type TrackerBinding,
} from "./binding.mts";
import { loadTrackerBinding, nodeBindingIoDeps, writeTrackerBinding, type BindingIoDeps } from "./binding-io.mts";

export interface TrackerInitDeps extends BindingIoDeps {
  log: (line: string) => void;
  /** Interactive question; undefined means no TTY (never ask). */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Provider-routed read ports for `--check`; injectable so tests never reach a network. */
  ports: (env: NodeJS.ProcessEnv) => TrackingReadPorts;
  now: () => string;
}

export interface TrackerInitOptions {
  readonly provider?: TrackingProvider;
  readonly owner?: string;
  readonly repo?: string;
  readonly host?: string;
  readonly api?: string;
  readonly scope: "project" | "global";
  readonly cwd?: string;
  readonly force: boolean;
  readonly print: boolean;
  readonly check: boolean;
  readonly help: boolean;
}

export type TrackerInitParse =
  | { readonly ok: true; readonly value: TrackerInitOptions }
  | { readonly ok: false; readonly error: string };

export const TRACKER_INIT_HELP = [
  "promptr-tracker-init - bind a project or this machine to a Gitea or GitHub tracker.",
  "",
  "Usage:",
  "  promptr-tracker-init [--provider gitea|github] [--owner <o>] [--repo <r>] [--host <https://…>]",
  "                       [--api <https://…>] [--scope project|global] [--cwd <dir>] [--force] [--print] [--check]",
  "",
  "Options:",
  "  --provider <p>    gitea or github. Without it, on a TTY, the provider is asked;",
  "                    the default comes from the origin remote when it points at a known host.",
  "  --owner <o>       Repository owner (default: origin remote; Gitea keeps its configured owner default).",
  "  --repo <r>        Repository name (default: origin remote, otherwise basename(cwd)).",
  `  --host <url>      Web origin. Defaults: ${DEFAULT_GITEA_HOST} / ${DEFAULT_GITHUB_HOST}.`,
  "  --api <url>       GitHub REST origin for GitHub Enterprise (optional).",
  "  --scope <s>       project (<cwd>/.promptr/tracker.json, default) or global (<state root>/tracker.json).",
  "  --cwd <dir>       Project directory (default: current directory).",
  "  --force           Overwrite an existing file. Without it an existing file is refused.",
  "  --print           Print the file that would be written; write nothing.",
  "  --check           After binding, one bounded page-1 read; reports the issue count or the reason.",
  "  --help            Show this help.",
  "",
  "Precedence at runtime: PROMPTR_TRACKER > project file > global file > recognized origin > Promptr-only fallback; otherwise unbound.",
  "The file holds no secrets; tokens stay in GITEA_TOKEN / GITHUB_TOKEN. Nothing is launched or logged in.",
].join("\n");

export function parseTrackerInitArgs(argv: readonly string[]): TrackerInitParse {
  const value: {
    provider?: TrackingProvider; owner?: string; repo?: string; host?: string; api?: string; cwd?: string;
    scope: "project" | "global"; force: boolean; print: boolean; check: boolean; help: boolean;
  } = { scope: "project", force: false, print: false, check: false, help: false };
  const take = (index: number, flag: string): string | { error: string } => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) return { error: `${flag} needs a value.` };
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case "--help": case "-h": value.help = true; break;
      case "--force": value.force = true; break;
      case "--print": value.print = true; break;
      case "--check": value.check = true; break;
      case "--provider": {
        const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error };
        const p = v.toLowerCase();
        if (p !== "gitea" && p !== "github") return { ok: false, error: `--provider must be gitea or github; received '${v.slice(0, 20)}'.` };
        value.provider = p; index += 1; break;
      }
      case "--owner": { const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error }; value.owner = v; index += 1; break; }
      case "--repo": { const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error }; value.repo = v; index += 1; break; }
      case "--host": { const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error }; value.host = v; index += 1; break; }
      case "--api": { const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error }; value.api = v; index += 1; break; }
      case "--cwd": { const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error }; value.cwd = v; index += 1; break; }
      case "--scope": {
        const v = take(index, arg); if (typeof v !== "string") return { ok: false, error: v.error };
        if (v !== "project" && v !== "global") return { ok: false, error: `--scope must be project or global; received '${v.slice(0, 20)}'.` };
        value.scope = v; index += 1; break;
      }
      default:
        return { ok: false, error: `unknown argument '${arg}'. Run with --help.` };
    }
  }
  return { ok: true, value: Object.freeze(value) };
}

export type TrackerInitOutcome =
  | { readonly ok: true; readonly path: string; readonly written: boolean; readonly binding?: TrackerBinding }
  | { readonly ok: false; readonly error: string; readonly usage?: boolean };

async function askWithDefault(ask: (q: string) => Promise<string>, label: string, fallback: string | undefined): Promise<string> {
  const answer = (await ask(fallback === undefined || fallback === "" ? `${label}: ` : `${label} [${fallback}]: `)).trim();
  return answer === "" ? (fallback ?? "") : answer;
}

/**
 * Collect the binding from flags, the origin remote and (on a TTY) the user.
 * Exported so the Pi command and the doctor share the same rules.
 */
export async function collectBinding(
  options: TrackerInitOptions, env: NodeJS.ProcessEnv, remote: string | undefined, deps: Pick<TrackerInitDeps, "ask" | "now">,
): Promise<{ ok: true; binding: TrackerBinding; scope: "project" | "global" } | { ok: false; error: string }> {
  const inferred = inferBindingFromRemote(remote, env, deps.now());
  let provider = options.provider;
  let scope = options.scope;
  const interactive = provider === undefined && deps.ask !== undefined;
  if (provider === undefined && !interactive) {
    if (inferred === undefined) return { ok: false, error: "name the provider with --provider gitea|github (no TTY and the origin remote does not point at a known host)." };
    provider = inferred.provider;
  }
  const ask = deps.ask;
  if (interactive && ask) {
    const defaultChoice = (inferred?.provider ?? "gitea") === "gitea" ? "1" : "2";
    for (;;) {
      const raw = (await ask(`Tracker provider: 1) Gitea  2) GitHub  [${defaultChoice}]: `)).trim().toLowerCase();
      const pick = raw === "" ? defaultChoice : raw;
      if (pick === "1" || pick === "gitea") { provider = "gitea"; break; }
      if (pick === "2" || pick === "github") { provider = "github"; break; }
    }
  }
  const chosen = provider as TrackingProvider;
  const sameProvider = inferred?.provider === chosen;
  const defaultHost = options.host ?? (sameProvider ? inferred.host : providerDefaultHost(chosen, env));
  let owner = options.owner ?? inferred?.owner ?? (chosen === "gitea" ? defaultRepo(env).owner : undefined);
  let repo = options.repo ?? inferred?.repo ?? path.basename(path.resolve(options.cwd ?? process.cwd()));
  let host = defaultHost;
  let api = options.api;
  if (interactive && ask) {
    owner = await askWithDefault(ask, "Owner", owner);
    repo = await askWithDefault(ask, "Repository", repo);
    const customHost = (await askWithDefault(ask, "Host (Enter keeps the default)", host)).trim();
    host = customHost === "" ? host : customHost;
    if (chosen === "github" && host.replace(/\/+$/, "").toLowerCase() !== DEFAULT_GITHUB_HOST) {
      const answer = (await askWithDefault(ask, "GitHub REST origin (Enter derives it from the host)", api)).trim();
      api = answer === "" ? undefined : answer;
    }
    const s = (await askWithDefault(ask, "Save to: 1) this project (.promptr/tracker.json)  2) global", scope === "project" ? "1" : "2")).trim().toLowerCase();
    scope = s === "2" || s === "global" ? "global" : "project";
  }
  if (!owner || !repo) return { ok: false, error: "owner and repository are required (--owner/--repo, or an origin remote on a known host)." };
  const checked = validateTrackerBinding({
    version: 1, provider: chosen, host, owner, repo,
    ...(api === undefined || api === "" ? {} : { apiOrigin: api }),
    boundAt: deps.now(),
  });
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, binding: checked.binding, scope };
}

/** Token line for output: presence only, never the value. */
export function tokenPresenceLine(provider: TrackingProvider, env: NodeJS.ProcessEnv): string {
  const variable = tokenVariableFor(provider);
  const present = (env[variable] ?? "").trim().length > 0;
  return present ? `${variable} present (value not shown)` : `${variable} not set; private repositories will fail`;
}

/** One bounded page-1 read through the effective env; count or reason. */
export async function checkBinding(binding: TrackerBinding, cwd: string, env: NodeJS.ProcessEnv, deps: Pick<TrackerInitDeps, "ports" | "readFile" | "gitRemote" | "stateRoot">): Promise<string> {
  const files = trackerBindingFiles(cwd, deps.stateRoot());
  const global = deps.readFile(files.global);
  const resolved = resolveTrackerBinding(
    { ...env, PROMPTR_TRACKER: undefined },
    { project: serializeTrackerBinding(binding), ...(global === undefined ? {} : { global }) },
    deps.gitRemote(cwd),
  );
  if (!resolved.resolution.ok) return `check skipped: ${resolved.resolution.reason}`;
  const label = binding.provider === "github" ? "GitHub" : "Gitea";
  try {
    const page = await deps.ports(resolved.effectiveEnv).listPage(resolved.resolution.config.repo, 1);
    return `${label} reachable: ${String(page.items.length)} issue(s) on page 1`;
  } catch (error) {
    return `${label} unreachable: ${error instanceof Error ? error.message.slice(0, 120) : "read failed"}`;
  }
}

export async function runTrackerInit(argv: readonly string[], env: NodeJS.ProcessEnv, deps: TrackerInitDeps): Promise<TrackerInitOutcome> {
  const parsed = parseTrackerInitArgs(argv);
  if (!parsed.ok) return { ok: false, error: parsed.error, usage: true };
  const options = parsed.value;
  if (options.help) {
    deps.log(TRACKER_INIT_HELP);
    return { ok: true, path: "", written: false };
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const remote = deps.gitRemote(cwd);
  const collected = await collectBinding({ ...options, cwd }, env, remote, deps);
  if (!collected.ok) return { ok: false, error: collected.error, usage: options.provider === undefined && deps.ask === undefined };
  const { binding, scope } = collected;
  const files = trackerBindingFiles(cwd, deps.stateRoot());
  const target = scope === "global" ? files.global : files.project;
  const text = serializeTrackerBinding(binding);

  if (options.print) {
    deps.log(text.trimEnd());
    deps.log(`# would write ${target}`);
    deps.log(`# ${tokenPresenceLine(binding.provider, env)}`);
    return { ok: true, path: target, written: false, binding };
  }

  const written = writeTrackerBinding(target, binding, { force: options.force }, deps);
  if (!written.ok) return { ok: false, error: written.error };
  deps.log(`wrote ${target}`);
  deps.log(`tracker ${binding.provider} ${binding.host} ${binding.owner}/${binding.repo} (${scope} scope)`);
  deps.log(tokenPresenceLine(binding.provider, env));
  const effective = loadTrackerBinding(cwd, env, deps);
  if (effective.source === "env") deps.log(`note: PROMPTR_TRACKER is set in this environment and overrides the file (source env).`);
  if (options.check) deps.log(await checkBinding(binding, cwd, env, deps));
  deps.log("nothing was launched or logged in; close and reopen the companion or workboard to use this binding (an open companion does not pick it up).");
  return { ok: true, path: target, written: true, binding };
}

// ---- node wiring ----

export function nodeTrackerInitDeps(interactive: boolean): TrackerInitDeps {
  let rl: readline.Interface | undefined;
  return {
    ...nodeBindingIoDeps,
    log(line: string): void { process.stdout.write(`${line}\n`); },
    ask: interactive
      ? async (question: string): Promise<string> => {
        rl ??= readline.createInterface({ input, output });
        return rl.question(question);
      }
      : undefined,
    ports: (env) => trackingPorts(env, { timeoutMs: 8000, withBlockers: false }),
    now: () => new Date().toISOString(),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const outcome = await runTrackerInit(argv, process.env, nodeTrackerInitDeps(interactive));
  if (!outcome.ok) {
    process.stderr.write(`promptr-tracker-init: ${outcome.error}\n`);
    return outcome.usage ? 2 : 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exit(code); }).catch((error: unknown) => {
    process.stderr.write(`promptr-tracker-init: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
