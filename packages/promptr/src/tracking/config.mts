/**
 * Tracker configuration: which provider and repository a project
 * is bound to, from the environment only. Pure: no fs, network or Pi.
 *
 * - `PROMPTR_TRACKER=gitea|github` selects the adapter. Default `gitea`, which
 *   keeps every existing setup working unchanged.
 * - Gitea: `GITEA_HOST`, `GITEA_OWNER`, `GITEA_REPO` (defaults as before),
 *   token `GITEA_TOKEN`.
 * - GitHub: `GITHUB_HOST` (default `https://github.com`), `GITHUB_OWNER`,
 *   `GITHUB_REPO` (both required, or parsed from `GITHUB_REPOSITORY=owner/repo`),
 *   optional `GITHUB_API` origin, token `GITHUB_TOKEN`.
 *
 * Tokens are reported as present/absent only; their values never leave the
 * environment through this module. An unusable configuration is a visible
 * reason, never a silent fallback to the other provider.
 */
import { defaultRepo, isValidTrackingRepo, parseGitRemote, type TrackingProvider, type TrackingRepo } from "./gitea.mts";

export interface TrackerConfig {
  readonly provider: TrackingProvider;
  readonly repo: TrackingRepo;
  readonly tokenPresent: boolean;
  /** REST origin override for GitHub (`GITHUB_API`); undefined derives from host. */
  readonly apiOrigin: string | undefined;
}

export type TrackerResolution =
  | { readonly ok: true; readonly config: TrackerConfig }
  | { readonly ok: false; readonly provider: TrackingProvider; readonly reason: string };

export const TRACKER_ENV = "PROMPTR_TRACKER";

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

export function trackerProviderOf(env: NodeJS.ProcessEnv): TrackingProvider | undefined {
  const raw = clean(env[TRACKER_ENV]).toLowerCase();
  if (raw === "") return undefined;
  if (raw === "gitea" || raw === "github") return raw;
  return undefined;
}

/**
 * Resolve the tracker binding. `gitRemote` (from `git remote get-url origin`)
 * only fills GitHub owner/repo when the environment names none; it never
 * switches providers by itself.
 */
export function resolveTracker(env: NodeJS.ProcessEnv, gitRemote?: string): TrackerResolution {
  const raw = clean(env[TRACKER_ENV]).toLowerCase();
  if (raw !== "" && raw !== "gitea" && raw !== "github") {
    return { ok: false, provider: "gitea", reason: `${TRACKER_ENV}='${raw.slice(0, 20)}' is not gitea or github` };
  }
  const provider: TrackingProvider = raw === "github" ? "github" : "gitea";
  if (provider === "gitea") {
    const repo = { ...defaultRepo(env), provider: "gitea" as const };
    if (!isValidTrackingRepo(repo)) return { ok: false, provider, reason: "GITEA_HOST/GITEA_OWNER/GITEA_REPO do not form a usable repository" };
    return { ok: true, config: { provider, repo, tokenPresent: clean(env.GITEA_TOKEN).length > 0, apiOrigin: undefined } };
  }
  const host = clean(env.GITHUB_HOST) || "https://github.com";
  let owner = clean(env.GITHUB_OWNER);
  let name = clean(env.GITHUB_REPO);
  const combined = clean(env.GITHUB_REPOSITORY);
  if ((owner === "" || name === "") && combined.includes("/")) {
    const [o, n] = combined.split("/", 2);
    owner = owner || clean(o);
    name = name || clean(n);
  }
  if ((owner === "" || name === "") && gitRemote !== undefined) {
    const parsed = parseGitRemote(gitRemote);
    if (parsed && parsed.host.replace(/\/+$/, "").toLowerCase() === host.replace(/\/+$/, "").toLowerCase()) {
      owner = owner || parsed.owner;
      name = name || parsed.repo;
    }
  }
  if (owner === "" || name === "") {
    return { ok: false, provider, reason: "GitHub tracker needs GITHUB_OWNER and GITHUB_REPO (or GITHUB_REPOSITORY=owner/repo)" };
  }
  const repo: TrackingRepo = { host: host.replace(/\/+$/, ""), owner, repo: name, provider: "github" };
  if (!isValidTrackingRepo(repo)) return { ok: false, provider, reason: "GITHUB_HOST/GITHUB_OWNER/GITHUB_REPO do not form a usable repository" };
  const api = clean(env.GITHUB_API);
  return {
    ok: true,
    config: { provider, repo, tokenPresent: clean(env.GITHUB_TOKEN).length > 0, apiOrigin: api === "" ? undefined : api },
  };
}

/** `gitea owner/promptr` — provider plus repository, for rules and status lines. */
export function trackerLabel(repo: TrackingRepo): string {
  return `${repo.provider ?? "gitea"} ${repo.owner}/${repo.repo}`;
}
