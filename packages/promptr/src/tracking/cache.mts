/**
 * Tracking snapshot cache. The snapshot is display data only: Gitea stays
 * authoritative, and staleness is always surfaced next to the numbers.
 * Reads never throw; missing/corrupt state yields undefined.
 */
import { atomicWrite, readText } from "../state/paths.mts";
import { parseSnapshot, type TrackingRepo, type TrackingSnapshot } from "./gitea.mts";

export const TRACKING_TTL_MS = 5 * 60 * 1000;

export function loadTrackingSnapshot(file: string): TrackingSnapshot | undefined {
  const raw = readText(file);
  if (!raw) return undefined;
  try {
    return parseSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function normalizedHost(host: string): string {
  return host.trim().replace(/\/+$/, "").toLowerCase();
}

/** Exact repository identity; legacy snapshots without provider are Gitea. */
export function sameTrackingRepo(left: TrackingRepo, right: TrackingRepo): boolean {
  return (left.provider ?? "gitea") === (right.provider ?? "gitea")
    && normalizedHost(left.host) === normalizedHost(right.host)
    && left.owner === right.owner
    && left.repo === right.repo;
}

/** Load display/navigation cache only for the effective repository. */
export function loadTrackingSnapshotForRepo(file: string, repo: TrackingRepo | undefined): TrackingSnapshot | undefined {
  if (!repo) return undefined;
  const snapshot = loadTrackingSnapshot(file);
  return snapshot && sameTrackingRepo(snapshot.repo, repo) ? snapshot : undefined;
}

export function saveTrackingSnapshot(file: string, snapshot: TrackingSnapshot): void {
  atomicWrite(file, JSON.stringify(snapshot, null, 2));
}

/** True when no snapshot or older than TTL. Missing time counts as stale. */
export function isTrackingStale(snapshot: TrackingSnapshot | undefined, nowMs?: number, ttlMs = TRACKING_TTL_MS): boolean {
  if (!snapshot) return true;
  const then = Date.parse(snapshot.fetchedAt);
  if (Number.isNaN(then)) return true;
  return (nowMs ?? Date.now()) - then > ttlMs;
}
