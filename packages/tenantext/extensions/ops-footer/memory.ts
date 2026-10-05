import { safeText } from "./adapters.ts";
import type { MemoryActivity, MemorySnapshot } from "./types.ts";

const operations: Record<string, string> = {
  viking_search: "search", viking_read: "read", viking_browse: "browse", viking_remember: "remember",
  viking_forget: "forget", viking_add_resource: "ingest", viking_archive_expand: "archive",
  wiki_recall: "recall", wiki_search: "search", wiki_observe: "observe", wiki_retro: "retro",
  wiki_ingest: "ingest", wiki_capture_source: "capture", wiki_ensure_page: "page", wiki_lint: "lint",
  wiki_status: "status", wiki_bootstrap: "setup", wiki_rebuild_meta: "rebuild", wiki_reindex: "reindex",
  wiki_reindex_embeddings: "embed", wiki_log_event: "log", wiki_watch: "watch",
  wiki_recall_skill: "recall skill", wiki_capture_trajectory: "capture trajectory", wiki_distill_skills: "distill skills",
};
const clean = (value?: string): string => (value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const label = (value: string): string | undefined =>
  /^[a-zA-Z0-9][a-zA-Z0-9._:/@\[\]-]{0,159}$/.test(value) && !value.includes("://") && safeText(value) === value ? value : undefined;

/** Read the published model label only. Never retain arbitrary wiki status prose. */
export function wikiModel(value?: string): { model?: string; sessionModel?: boolean } {
  const match = /^\u{1f9e0} wiki model: (.+)$/u.exec(clean(value));
  if (!match) return {};
  const text = match[1];
  if (text === "session model" || /^session model \([^\r\n]*\)$/.test(text)) return { sessionModel: true };
  return { model: label(text) };
}

/** Known OpenViking counters stop before the session-ID suffix. */
export function vikingCounters(value?: string): Pick<NonNullable<MemorySnapshot["ov"]>, "added" | "pendingTokens" | "threshold"> {
  const match = /^OV [\u2713\u2717] \u00b7 \u21a9(\d{1,6}) \u00b7 (?:ctx \d{1,6} \u00b7 ~(\d{1,9})\/(\d{1,9})|\u270e (\d{1,9}))(?: \u00b7 |$)/u.exec(clean(value));
  if (!match) return {};
  return { added: Number(match[1]), pendingTokens: match[2] === undefined ? undefined : Number(match[2]), threshold: Number(match[3] ?? match[4]) };
}

export function wikiStatus(value?: string): { state: "ok" | "error" | "unknown"; recalled?: number } {
  const text = clean(value);
  if (text === "error" || /^\u{1f9e0} Wiki setup blocked:/u.test(text)) return { state: "error" };
  const recall = /^\u{1f9e0} LLM Wiki \u2014 recalled (\d{1,6}) pages? for this task$/u.exec(text);
  if (recall) return { state: "ok", recalled: Number(recall[1]) };
  if (text === "ok" || /^\u{1f9e0} LLM Wiki \(\d+ tools, (?:trajectory \+ )?observe \+ recall active\)$/u.test(text)) return { state: "ok" };
  return { state: "unknown" };
}

type Source = "ov" | "wiki";
/** Tool activity is not a connectivity probe or a claim that detached work completed. */
export class MemoryTracker {
  private running = new Map<string, { source: Source; operation: string }>();
  private last: Partial<Record<Source, { last: string; failed: boolean }>> = {};
  private suggestCapture = false;

  reset(): void { this.running.clear(); this.last = {}; this.suggestCapture = false; }
  start(id: string, name: string): void {
    if (operations[name]) this.running.set(id, { source: name.startsWith("viking_") ? "ov" : "wiki", operation: operations[name] });
  }
  end(id: string, name: string, isError: boolean, result?: unknown): void {
    const active = this.running.get(id);
    this.running.delete(id);
    const output = result as { isError?: boolean; details?: { error?: unknown } } | undefined;
    const failed = isError || output?.isError === true || Boolean(output?.details?.error);
    if (active) this.last[active.source] = { last: active.operation, failed };
    if (!failed && (name === "write" || name === "edit")) this.suggestCapture = true;
    if (!failed && (name === "wiki_observe" || name === "wiki_retro")) this.suggestCapture = false;
  }
  settle(): void { this.running.clear(); }
  reminder(): void { this.suggestCapture = true; }
  snapshot(statuses: ReadonlyMap<string, string>, tools: readonly string[]): MemorySnapshot {
    const activity = (source: Source): MemoryActivity => ({
      running: [...this.running.values()].filter(v => v.source === source).map(v => v.operation), ...this.last[source],
    });
    const ov = activity("ov"), wiki = activity("wiki");
    const hasOv = statuses.has("openviking") || tools.some(t => t.startsWith("viking_")) || ov.running.length || ov.last;
    const hasWiki = statuses.has("llm-wiki") || statuses.has("llm-wiki-model") || tools.includes("wiki_recall") || wiki.running.length || wiki.last;
    return {
      ...(hasOv ? { ov: { ...ov, ...vikingCounters(statuses.get("openviking")) } } : {}),
      ...(hasWiki ? { wiki: { ...wiki, ...wikiStatus(statuses.get("llm-wiki")), ...wikiModel(statuses.get("llm-wiki-model")), suggestCapture: this.suggestCapture } } : {}),
    };
  }
}
