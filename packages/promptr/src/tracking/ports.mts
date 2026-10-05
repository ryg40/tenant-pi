/**
 * Provider dispatch for tracking reads. One place decides which
 * adapter serves a repository, keyed by the binding's `provider` field — never
 * by an issue's URL. Tokens are read from the environment here and passed
 * down; they are never echoed into notices, packets or caches.
 */
import type { IssueComment, IssueDetail, IssuePage, SinceRead, TrackedIssue, TrackingRepo, TrackingSnapshot } from "./gitea.mts";
import { fetchCommentsSince, fetchIssueDetail, fetchIssuePage, fetchIssuesSince, fetchTracking, repoProvider } from "./gitea.mts";
import {
  fetchCommentsSinceGitHub, fetchIssueDetailGitHub, fetchIssuePageGitHub, fetchIssuesSinceGitHub, fetchTrackingGitHub,
} from "./github.mts";

export interface TrackingReadPorts {
  fetch(repo: TrackingRepo): Promise<TrackingSnapshot>;
  listPage(repo: TrackingRepo, page: number): Promise<IssuePage>;
  loadDetail(repo: TrackingRepo, number: number): Promise<IssueDetail | undefined>;
  /** Issues updated since an ISO stamp (Catch-Me-Up); bounded pages. */
  fetchIssuesSince(repo: TrackingRepo, sinceIso: string): Promise<SinceRead<TrackedIssue>>;
  /** Repository-wide issue comments since an ISO stamp (Catch-Me-Up); <= 200. */
  fetchCommentsSince(repo: TrackingRepo, sinceIso: string): Promise<SinceRead<IssueComment>>;
}

export interface TrackingPortOptions {
  timeoutMs?: number;
  withBlockers?: boolean;
}

function tokenFor(repo: TrackingRepo, env: NodeJS.ProcessEnv): string | undefined {
  const raw = repoProvider(repo) === "github" ? env.GITHUB_TOKEN : env.GITEA_TOKEN;
  const token = raw?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

function apiOriginFor(repo: TrackingRepo, env: NodeJS.ProcessEnv): string | undefined {
  if (repoProvider(repo) !== "github") return undefined;
  const api = env.GITHUB_API?.trim();
  return api !== undefined && api.length > 0 ? api : undefined;
}

/** Ports for the companion and hosted flows; every read routes by `repo.provider`. */
export function trackingPorts(env: NodeJS.ProcessEnv, options: TrackingPortOptions = {}): TrackingReadPorts {
  const timeoutMs = options.timeoutMs ?? 8000;
  const withBlockers = options.withBlockers ?? true;
  const common = (repo: TrackingRepo) => {
    const token = tokenFor(repo, env);
    const apiOrigin = apiOriginFor(repo, env);
    return {
      timeoutMs,
      ...(token === undefined ? {} : { token }),
      ...(apiOrigin === undefined ? {} : { apiOrigin }),
    };
  };
  return {
    fetch(repo) {
      return repoProvider(repo) === "github"
        ? fetchTrackingGitHub({ repo, withBlockers, ...common(repo) })
        : fetchTracking({ repo, withBlockers, ...common(repo) });
    },
    listPage(repo, page) {
      return repoProvider(repo) === "github"
        ? fetchIssuePageGitHub({ repo, page, ...common(repo) })
        : fetchIssuePage({ repo, page, ...common(repo) });
    },
    loadDetail(repo, number) {
      return repoProvider(repo) === "github"
        ? fetchIssueDetailGitHub({ repo, number, ...common(repo) })
        : fetchIssueDetail({ repo, number, ...common(repo) });
    },
    fetchIssuesSince(repo, since) {
      return repoProvider(repo) === "github"
        ? fetchIssuesSinceGitHub({ repo, since, ...common(repo) })
        : fetchIssuesSince({ repo, since, ...common(repo) });
    },
    fetchCommentsSince(repo, since) {
      return repoProvider(repo) === "github"
        ? fetchCommentsSinceGitHub({ repo, since, ...common(repo) })
        : fetchCommentsSince({ repo, since, ...common(repo) });
    },
  };
}
