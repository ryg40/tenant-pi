/**
 * Persisted tracker binding. Pure: no fs, network or Pi.
 *
 * A project (or this machine) can name its tracker in a small JSON file so the
 * provider is a *selectable choice* rather than an environment convention.
 * The file carries no secrets: tokens (`GITEA_TOKEN`/`GITHUB_TOKEN`) always come
 * from the real environment. Precedence, first hit wins:
 *
 *   env (`PROMPTR_TRACKER` set) > project file > global file > origin remote >
 *   historical Promptr-only fallback > unbound
 *
 * `resolveTrackerBinding` wraps `resolveTracker` from `config.mts` by building
 * an overlay environment from the chosen binding, so ports and adapters keep
 * reading the same variables they always did.
 */
import path from "node:path";
import { defaultRepo, isValidTrackingRepo, parseGitRemote, type TrackingProvider } from "./gitea.mts";
import { resolveTracker, TRACKER_ENV, type TrackerResolution } from "./config.mts";

export interface TrackerBinding {
  version: 1;
  provider: TrackingProvider;
  host: string;
  owner: string;
  repo: string;
  apiOrigin?: string;
  boundAt: string;
  note?: string;
}

export type BindingSource = "env" | "project" | "global" | "remote" | "promptr-fallback" | "unbound" | "default";

export const TRACKER_BINDING_FILE = "tracker.json";
export const DEFAULT_GITEA_HOST = "https://git.example.com";
export const DEFAULT_GITEA_OWNER = "owner";
export const DEFAULT_GITHUB_HOST = "https://github.com";

export type ParsedBinding =
  | { ok: true; binding: TrackerBinding }
  | { ok: false; error: string };

/** `<cwd>/.promptr/tracker.json` and `<stateRoot>/tracker.json`. */
export function trackerBindingFiles(cwd: string, stateRoot: string): { project: string; global: string } {
  return {
    project: path.join(cwd, ".promptr", TRACKER_BINDING_FILE),
    global: path.join(stateRoot, TRACKER_BINDING_FILE),
  };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\/+$/, "");
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

/** Default web host for a provider. */
export function providerDefaultHost(provider: TrackingProvider, env: NodeJS.ProcessEnv = {}): string {
  if (provider === "github") return normalizeHost(env.GITHUB_HOST?.trim() || DEFAULT_GITHUB_HOST);
  return normalizeHost(env.GITEA_HOST?.trim() || DEFAULT_GITEA_HOST);
}

/** Default text of the "Owner" input for a provider: `GITEA_OWNER` or the neutral placeholder for Gitea, empty for GitHub. */
export function providerDefaultOwner(provider: TrackingProvider, env: NodeJS.ProcessEnv = {}): string {
  if (provider === "github") return "";
  return env.GITEA_OWNER?.trim() || DEFAULT_GITEA_OWNER;
}

/** Token variable a provider expects; the value is never read here. */
export function tokenVariableFor(provider: TrackingProvider): "GITEA_TOKEN" | "GITHUB_TOKEN" {
  return provider === "github" ? "GITHUB_TOKEN" : "GITEA_TOKEN";
}

/** Validate a candidate binding; returns the normalized binding or an error line. */
export function validateTrackerBinding(input: unknown): ParsedBinding {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "binding must be a JSON object" };
  const r = input as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "version must be 1" };
  if (r.provider !== "gitea" && r.provider !== "github") return { ok: false, error: `provider must be gitea or github, got '${String(r.provider).slice(0, 20)}'` };
  const provider: TrackingProvider = r.provider;
  if (typeof r.host !== "string" || !isHttpOrigin(r.host.trim())) return { ok: false, error: "host must be an http(s) origin such as https://github.com" };
  const host = normalizeHost(r.host);
  const owner = typeof r.owner === "string" ? r.owner.trim() : "";
  const repo = typeof r.repo === "string" ? r.repo.trim() : "";
  if (!isValidTrackingRepo({ host, owner, repo, provider })) return { ok: false, error: "owner/repo are not usable repository names" };
  let apiOrigin: string | undefined;
  if (r.apiOrigin !== undefined) {
    if (typeof r.apiOrigin !== "string" || !isHttpOrigin(r.apiOrigin.trim())) return { ok: false, error: "apiOrigin must be an http(s) origin" };
    apiOrigin = normalizeHost(r.apiOrigin);
  }
  const boundAt = typeof r.boundAt === "string" && r.boundAt.trim() !== "" ? r.boundAt.trim() : new Date(0).toISOString();
  const note = typeof r.note === "string" && r.note.trim() !== "" ? r.note.trim().slice(0, 200) : undefined;
  const binding: TrackerBinding = {
    version: 1, provider, host, owner, repo,
    ...(apiOrigin === undefined ? {} : { apiOrigin }),
    boundAt,
    ...(note === undefined ? {} : { note }),
  };
  return { ok: true, binding };
}

/** Parse a binding file body. `undefined` means the file is missing. */
export function parseTrackerBinding(raw: string | undefined): ParsedBinding | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error instanceof Error ? error.message.slice(0, 60) : "parse failed"})` };
  }
  return validateTrackerBinding(parsed);
}

/** 2-space JSON + LF, keys in declaration order. Never carries a token. */
export function serializeTrackerBinding(binding: TrackerBinding): string {
  const ordered: Record<string, unknown> = {
    version: 1,
    provider: binding.provider,
    host: normalizeHost(binding.host),
    owner: binding.owner,
    repo: binding.repo,
  };
  if (binding.apiOrigin !== undefined) ordered.apiOrigin = normalizeHost(binding.apiOrigin);
  ordered.boundAt = binding.boundAt;
  if (binding.note !== undefined) ordered.note = binding.note;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Environment overlay for `resolveTracker`/`trackingPorts`. Never tokens. */
export function bindingEnv(binding: TrackerBinding): NodeJS.ProcessEnv {
  if (binding.provider === "github") {
    return {
      [TRACKER_ENV]: "github",
      GITHUB_HOST: normalizeHost(binding.host),
      GITHUB_OWNER: binding.owner,
      GITHUB_REPO: binding.repo,
      ...(binding.apiOrigin === undefined ? {} : { GITHUB_API: normalizeHost(binding.apiOrigin) }),
    };
  }
  return {
    [TRACKER_ENV]: "gitea",
    GITEA_HOST: normalizeHost(binding.host),
    GITEA_OWNER: binding.owner,
    GITEA_REPO: binding.repo,
  };
}

/**
 * Infer a binding from the `origin` remote. `github.com` or `GITHUB_HOST` →
 * github; the Gitea host (`GITEA_HOST` or the default) → gitea; anything else
 * → undefined, so an unknown forge never silently becomes a tracker.
 */
export function inferBindingFromRemote(remoteUrl: string | undefined, env: NodeJS.ProcessEnv, now?: string): TrackerBinding | undefined {
  if (remoteUrl === undefined) return undefined;
  const parsed = parseGitRemote(remoteUrl);
  if (!parsed) return undefined;
  const host = normalizeHost(parsed.host).toLowerCase();
  const githubHost = providerDefaultHost("github", env).toLowerCase();
  const giteaHost = normalizeHost(defaultRepo(env).host).toLowerCase();
  let provider: TrackingProvider | undefined;
  if (host === githubHost || host === DEFAULT_GITHUB_HOST) provider = "github";
  else if (host === giteaHost) provider = "gitea";
  if (provider === undefined) return undefined;
  const candidate = { version: 1 as const, provider, host: normalizeHost(parsed.host), owner: parsed.owner, repo: parsed.repo, boundAt: now ?? new Date().toISOString() };
  const checked = validateTrackerBinding(candidate);
  return checked.ok ? checked.binding : undefined;
}

export interface BindingResolveResult {
  resolution: TrackerResolution;
  source: BindingSource;
  effectiveEnv: NodeJS.ProcessEnv;
  problems: string[];
  /** The binding that won, when a file or the remote decided. */
  binding?: TrackerBinding;
}

/** Short suffix for rules and status lines; empty for `env`. */
export function bindingSourceSuffix(source: BindingSource): string {
  switch (source) {
    case "project": return "(project file)";
    case "global": return "(global file)";
    case "remote": return "(from origin remote)";
    case "promptr-fallback": return "(Promptr project fallback)";
    case "unbound": return "(unbound)";
    case "default": return "(legacy default)";
    default: return "";
  }
}

/**
 * Resolve the effective tracker. `files` are the raw bodies of the project and
 * global binding files (undefined = missing). A file that exists but does not
 * parse adds one line to `problems` and falls through.
 */
export function resolveTrackerBinding(
  env: NodeJS.ProcessEnv,
  files: { project?: string; global?: string },
  gitRemote?: string,
  cwd?: string,
): BindingResolveResult {
  const problems: string[] = [];
  const raw = (env[TRACKER_ENV] ?? "").trim();
  if (raw !== "") {
    return { resolution: resolveTracker(env, gitRemote), source: "env", effectiveEnv: env, problems };
  }
  for (const [source, body] of [["project", files.project], ["global", files.global]] as const) {
    const parsed = parseTrackerBinding(body);
    if (parsed === undefined) continue;
    if (!parsed.ok) {
      problems.push(`${source} tracker.json ignored: ${parsed.error}`);
      continue;
    }
    const effectiveEnv = { ...env, ...bindingEnv(parsed.binding) };
    return { resolution: resolveTracker(effectiveEnv, gitRemote), source, effectiveEnv, problems, binding: parsed.binding };
  }
  const inferred = inferBindingFromRemote(gitRemote, env);
  if (inferred) {
    const effectiveEnv = { ...env, ...bindingEnv(inferred) };
    return { resolution: resolveTracker(effectiveEnv, gitRemote), source: "remote", effectiveEnv, problems, binding: inferred };
  }
  if (cwd !== undefined && path.basename(path.resolve(cwd)).toLowerCase() === "promptr") {
    return { resolution: resolveTracker(env, gitRemote), source: "promptr-fallback", effectiveEnv: env, problems };
  }
  return {
    resolution: { ok: false, provider: "gitea", reason: "tracker unbound - run /promptr-tracker init" },
    source: "unbound",
    effectiveEnv: env,
    problems,
  };
}
