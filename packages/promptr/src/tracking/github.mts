/**
 * GitHub tracking adapter (free-standing Gitea/GitHub issues).
 *
 * Same shapes as the Gitea adapter (`TrackingSnapshot`, `IssuePage`,
 * `IssueDetail`), read from the GitHub REST API:
 *
 * - Issues: `GET /repos/{owner}/{repo}/issues?state=all` (pull requests are
 *   returned too and filtered out by their `pull_request` field).
 * - Milestones: `GET /repos/{owner}/{repo}/milestones?state=all`.
 * - Native dependencies: `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by`
 *   (issue dependencies API, `X-GitHub-Api-Version: 2026-03-10`). A deployment
 *   or repository without that API returns 404/410, which is reported as
 *   `unavailable`, never as "no blockers".
 *
 * Read-only, GET only, bounded pages, token never echoed. The API origin is
 * `https://api.github.com` for `https://github.com`; a GitHub Enterprise host
 * uses `<host>/api/v3`.
 */
import {
  buildSnapshot, isValidIssueNumber, isValidTrackingRepo, parseIssueDetail, parseMilestoneCounts, sanitizeLine,
  toTrackedIssueRecord, toIssueComments, ISSUE_PAGE_SIZE, SINCE_PAGE_SIZE, SINCE_MAX_PAGES, SINCE_MAX_COMMENTS,
  type DependencyRead, type IssueDependency, type IssueDetail, type IssueDetailOptions, type IssuePage,
  type IssuePageOptions, type IssueReadOptions, type FetchTrackingOptions, type TrackedIssue, type TrackingRepo,
  type TrackingSnapshot, type SinceReadOptions, type SinceRead, type IssueComment,
} from "./gitea.mts";

export const GITHUB_API_VERSION = "2026-03-10";
const DEPENDENCY_PER_PAGE = 50;
const DEPENDENCY_MAX_PAGES = 4;

/** REST origin for a repo host: api.github.com for github.com, `<host>/api/v3` otherwise. */
export function githubApiBase(repo: TrackingRepo, apiOrigin?: string): string {
  const host = repo.host.replace(/\/+$/, "");
  const origin = apiOrigin?.replace(/\/+$/, "")
    ?? (/^https?:\/\/(www\.)?github\.com$/i.test(host) ? "https://api.github.com" : `${host}/api/v3`);
  return `${origin}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function headers(token: string | undefined): Record<string, string> {
  const out: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token && token.length > 0) out.Authorization = `Bearer ${token}`;
  return out;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`GitHub ${String(status)} for ${path}`);
    this.status = status;
  }
}

async function getJson(fetchFn: typeof fetch, url: string, token: string | undefined, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers: headers(token), signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status, new URL(url).pathname);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function isPullRequest(item: Record<string, unknown>): boolean {
  return item.pull_request !== undefined && item.pull_request !== null;
}

/** GitHub issue JSON → the adapter-neutral record the Gitea parser validates. */
function toIssueList(raw: unknown, repo: TrackingRepo): TrackedIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedIssue[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (isPullRequest(r)) continue;
    const milestone = typeof r.milestone === "object" && r.milestone !== null
      ? (r.milestone as Record<string, unknown>).title : undefined;
    const labels = Array.isArray(r.labels)
      ? r.labels.map((l) => (typeof l === "object" && l !== null ? (l as Record<string, unknown>).name : l))
      : [];
    const assignee = typeof r.assignee === "object" && r.assignee !== null
      ? (r.assignee as Record<string, unknown>).login : undefined;
    const tracked = toTrackedIssueRecord({
      number: r.number,
      title: r.title,
      state: r.state,
      milestone: typeof milestone === "string" ? milestone : undefined,
      labels,
      url: typeof r.html_url === "string" ? r.html_url : `${repo.host}/${repo.owner}/${repo.repo}/issues/${String(r.number ?? "")}`,
      assignee: typeof assignee === "string" ? assignee : undefined,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
    });
    if (tracked) out.push(tracked);
  }
  return out;
}

export interface GitHubOptions {
  /** REST origin override (`GITHUB_API`); default derives from the repo host. */
  apiOrigin?: string;
}

/** Milestones + issues for one GitHub repository. Throws Error(reason) on failure. */
export async function fetchTrackingGitHub(options: FetchTrackingOptions & GitHubOptions): Promise<TrackingSnapshot> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? 8000;
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 50));
  const maxPages = Math.max(1, Math.min(5, options.maxPages ?? 5));
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const base = githubApiBase(repo, options.apiOrigin);

  const milestonesRaw = await getJson(fetchFn, `${base}/milestones?state=all&per_page=100`, token, timeoutMs).catch(() => undefined);
  const milestoneCounts = milestonesRaw === undefined ? undefined : parseMilestoneCounts(milestonesRaw);

  const issues: TrackedIssue[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await getJson(fetchFn, `${base}/issues?state=all&per_page=${String(perPage)}&page=${String(page)}`, token, timeoutMs);
    if (!Array.isArray(raw) || raw.length === 0) break;
    issues.push(...toIssueList(raw, repo));
    if (raw.length < perPage || issues.length >= 250) break;
  }
  if (options.withBlockers) {
    const limit = Math.max(0, Math.min(200, Math.trunc(options.blockerReadLimit ?? 40)));
    const open = issues.filter((i) => i.state === "open").sort((a, b) => a.number - b.number).slice(0, limit);
    for (const issue of open) {
      const read = await fetchIssueDependenciesGitHub({
        repo, number: issue.number, fetchFn, timeoutMs,
        ...(token === undefined ? {} : { token }),
        ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
      });
      if (read.status === "complete") issue.blockers = read.blockers;
      // The dependencies API is repository-wide: once it is missing, stop probing.
      if (read.status === "unavailable" && /GitHub 4(04|10)/.test(read.reason)) break;
    }
  }
  const fetchedAt = options.now ? options.now() : new Date().toISOString();
  return buildSnapshot({ ...repo, provider: "github" }, issues, milestoneCounts, fetchedAt);
}

/** One explicit page of issues (pull requests filtered). Throws on network/HTTP failure. */
export async function fetchIssuePageGitHub(options: IssuePageOptions & GitHubOptions): Promise<IssuePage> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const page = Math.max(1, Math.trunc(options.page));
  const perPage = Math.max(1, Math.min(100, Math.trunc(options.perPage ?? ISSUE_PAGE_SIZE)));
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const raw = await getJson(fetchFn, `${githubApiBase(repo, options.apiOrigin)}/issues?state=all&per_page=${String(perPage)}&page=${String(page)}`, options.token, timeoutMs);
  const rawCount = Array.isArray(raw) ? raw.length : 0;
  return {
    repo: { host: repo.host.replace(/\/+$/, ""), owner: repo.owner, repo: repo.repo, provider: "github" },
    page,
    perPage,
    items: toIssueList(raw, repo),
    hasMore: rawCount >= perPage,
    fetchedAt: options.now ? options.now() : new Date().toISOString(),
  };
}

function toDependency(raw: unknown, fallback: TrackingRepo): IssueDependency | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isValidIssueNumber(r.number)) return undefined;
  const state = r.state === "open" ? "open" : r.state === "closed" ? "closed" : undefined;
  if (state === undefined) return undefined;
  let repoName = `${fallback.owner}/${fallback.repo}`;
  const repository = r.repository;
  if (typeof repository === "object" && repository !== null) {
    const full = (repository as Record<string, unknown>).full_name;
    if (typeof full === "string" && /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(full)) repoName = full;
  } else if (typeof r.repository_url === "string") {
    const m = /\/repos\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/.exec(r.repository_url);
    if (m) repoName = `${m[1] as string}/${m[2] as string}`;
  }
  return { number: r.number, title: sanitizeLine(r.title, 120), state, repo: repoName };
}

/**
 * Issues this one is blocked by (GitHub issue dependencies API). Never
 * throws: 404/410 (API or repository without dependencies) and every other
 * failure report `unavailable`, so an unread graph is never shown as clear.
 */
export async function fetchIssueDependenciesGitHub(
  options: IssueReadOptions & GitHubOptions & { number: number; maxPages?: number; perPage?: number },
): Promise<DependencyRead> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo) || !isValidIssueNumber(options.number)) {
    return { status: "unavailable", items: [], blockers: 0, reason: "invalid issue reference" };
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const perPage = Math.max(1, Math.min(100, Math.trunc(options.perPage ?? DEPENDENCY_PER_PAGE)));
  const maxPages = Math.max(1, Math.min(10, Math.trunc(options.maxPages ?? DEPENDENCY_MAX_PAGES)));
  const items: IssueDependency[] = [];
  const seen = new Set<string>();
  const open = (): number => items.filter((d) => d.state === "open").length;
  for (let page = 1; page <= maxPages; page++) {
    let raw: unknown;
    try {
      raw = await getJson(
        fetchFn,
        `${githubApiBase(repo, options.apiOrigin)}/issues/${String(options.number)}/dependencies/blocked_by?per_page=${String(perPage)}&page=${String(page)}`,
        options.token, timeoutMs,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 120) : "read failed";
      const hint = error instanceof HttpError && (error.status === 404 || error.status === 410)
        ? `${detail}; issue dependencies API unavailable for this repository` : detail;
      return { status: "unavailable", items, blockers: open(), reason: hint };
    }
    if (!Array.isArray(raw)) return { status: "unavailable", items, blockers: open(), reason: "unexpected dependency payload" };
    for (const entry of raw) {
      const dep = toDependency(entry, repo);
      if (!dep) return { status: "incomplete", items, blockers: open(), reason: "unreadable dependency entry" };
      const key = `${dep.repo}#${String(dep.number)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(dep);
    }
    if (raw.length < perPage) return { status: "complete", items, blockers: open(), reason: "" };
  }
  return { status: "incomplete", items, blockers: open(), reason: `more than ${String(maxPages * perPage)} dependencies; read bounded` };
}

/** One issue plus its blocked-by state. Throws on network/HTTP failure; undefined when malformed. */
export async function fetchIssueDetailGitHub(options: IssueDetailOptions & GitHubOptions): Promise<IssueDetail | undefined> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  if (!isValidIssueNumber(options.number)) throw new Error("invalid issue number");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const raw = await getJson(fetchFn, `${githubApiBase(repo, options.apiOrigin)}/issues/${String(options.number)}`, options.token, timeoutMs);
  const dependencies = options.dependencies ?? (await fetchIssueDependenciesGitHub({
    repo, number: options.number, fetchFn, timeoutMs,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
  }));
  const fetchedAt = options.now ? options.now() : new Date().toISOString();
  return parseIssueDetail(raw, { ...repo, provider: "github" }, options.number, dependencies, fetchedAt);
}

// ---- since-reads for Catch-Me-Up ----

/** Issues updated since `since` (pull requests dropped), at most `maxPages` × 50. */
export async function fetchIssuesSinceGitHub(options: SinceReadOptions & GitHubOptions): Promise<SinceRead<TrackedIssue>> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxPages = Math.max(1, Math.min(SINCE_MAX_PAGES, Math.trunc(options.maxPages ?? SINCE_MAX_PAGES)));
  const base = githubApiBase(repo, options.apiOrigin);
  const since = encodeURIComponent(options.since);
  const items: TrackedIssue[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await getJson(
      fetchFn,
      `${base}/issues?state=all&since=${since}&sort=updated&direction=desc&per_page=${String(SINCE_PAGE_SIZE)}&page=${String(page)}`,
      options.token,
      timeoutMs,
    );
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    items.push(...toIssueList(raw, repo));
    if (rawCount < SINCE_PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

/** Repository-wide issue comments since `since`, at most 200. */
export async function fetchCommentsSinceGitHub(options: SinceReadOptions & GitHubOptions): Promise<SinceRead<IssueComment>> {
  const repo = options.repo;
  if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxPages = Math.max(1, Math.min(Math.ceil(SINCE_MAX_COMMENTS / SINCE_PAGE_SIZE), Math.trunc(options.maxPages ?? SINCE_MAX_PAGES)));
  const base = githubApiBase(repo, options.apiOrigin);
  const since = encodeURIComponent(options.since);
  const items: IssueComment[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await getJson(fetchFn, `${base}/issues/comments?since=${since}&sort=updated&direction=desc&per_page=${String(SINCE_PAGE_SIZE)}&page=${String(page)}`, options.token, timeoutMs);
    const rawCount = Array.isArray(raw) ? raw.length : 0;
    items.push(...toIssueComments(raw));
    if (rawCount < SINCE_PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return { items: items.slice(0, SINCE_MAX_COMMENTS), truncated: truncated || items.length > SINCE_MAX_COMMENTS };
}
