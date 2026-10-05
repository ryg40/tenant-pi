/**
 * Hosted /promptr tracking helpers (pure). The hosted view mirrors the
 * companion's board and navigation; the generator launch stays companion-only,
 * so the hosted `g` places the deterministic draft and says where the launch
 * lives. Nothing here reads files, launches or sends.
 */
import { buildWorkBoard, type WorkBoard } from "../tracking/board.mts";
import { isValidTrackingRepo, type TrackingSnapshot } from "../tracking/gitea.mts";

export const HOSTED_GENERATE_NOTICE =
  "generator launch lives in the /coordinatr-herdr companion (g there); deterministic draft placed here";

const NOTE_LIMIT = 80;

export function hostedBoard(
  snapshot: TrackingSnapshot | undefined,
  source: string,
  reason: string,
): { board: WorkBoard | undefined; note: string; navigation: boolean } {
  const board = snapshot ? buildWorkBoard(snapshot) : undefined;
  const navigation = !!snapshot && isValidTrackingRepo(snapshot.repo);
  const note = source === "live" ? "" : `${source} · ${reason}`.slice(0, NOTE_LIMIT);
  return { board, note, navigation };
}

export function placeDraft(
  composerText: string,
  draft: string,
  issue: number,
  savedName: string | undefined,
): { composerText: string; notice: string } {
  const n = String(issue);
  if (composerText.length === 0) {
    const packet = savedName ? ` · packet requests/${savedName}` : "";
    return { composerText: draft, notice: `draft for #${n} in COMPOSE — edit, then Ctrl+S reviews + sends${packet}` };
  }
  const notice = savedName
    ? `composer busy — draft saved to requests/${savedName}; clear or queue the composer and press g again`
    : `composer busy — packet for #${n} could not be saved; clear or queue the composer and press g again`;
  return { composerText, notice };
}

/** `/promptr-catchup [--since 48h|7d|<iso>]` → the explicit window, or an error string. */
export function parseCatchUpArgs(args: string | undefined): { since?: string } | { error: string } {
  const tokens = (args ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return {};
  const out: { since?: string } = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--since") {
      const value = tokens[i + 1];
      if (value === undefined) return { error: "Usage: /promptr-catchup [--since 48h|7d|<iso>]" };
      if (!/^(\d{1,4}[hd]|\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?)$/i.test(value)) return { error: `--since '${value.slice(0, 40)}' is not 48h, 7d or an ISO date` };
      out.since = value;
      i += 1;
    } else if (token.startsWith("--since=")) {
      out.since = token.slice("--since=".length);
    } else {
      return { error: "Usage: /promptr-catchup [--since 48h|7d|<iso>]" };
    }
  }
  return out;
}
