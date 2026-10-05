import { createHash } from "node:crypto";
import { validateBriefing } from "../briefing/openknowledge.mts";
import type { PagesClient, ProjectPages } from "./project-pages.mts";

/**
 * OpenKnowledge inbox consumption: the human types one thought per
 * block on projects/<slug>/inbox; Promptr queues each new block once and
 * appends a trailer comment at the page end. User text is never edited.
 * Pure helpers plus `pollInbox`, which only uses injected deps.
 */
export interface InboxBlock {
  readonly index: number;
  readonly hash: string;
  readonly text: string;
}

const TRAILER_RULE = /^<!-- promptr:queued ([0-9a-f]{16}) (\S+) -->$/;
const HEADING_RULE = /^## /;
const SEPARATOR_RULE = /^---\s*$/;
const MAX_THOUGHT_BYTES = 256 * 1024;
const MAX_SEEN = 2000;

export function inboxTrailer(hash: string, iso: string): string {
  return `<!-- promptr:queued ${hash} ${iso} -->`;
}

function blockHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function normalizeBlock(lines: readonly string[]): string {
  const copy = [...lines];
  if (copy.length > 0 && HEADING_RULE.test(copy[0]!)) copy[0] = copy[0]!.replace(HEADING_RULE, "");
  while (copy.length > 0 && copy[0]!.trim() === "") copy.shift();
  while (copy.length > 0 && copy[copy.length - 1]!.trim() === "") copy.pop();
  const out: string[] = [];
  let blanks = 0;
  for (const line of copy) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks <= 1) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  return out.join("\n");
}

export function parseInboxBlocks(markdown: string): { readonly blocks: readonly InboxBlock[]; readonly consumed: ReadonlySet<string>; readonly malformed?: string } {
  const consumed = new Set<string>();
  try {
    validateBriefing(markdown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { blocks: [], consumed, malformed: `inbox page rejected: ${reason}` };
  }
  const lines: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const trailer = TRAILER_RULE.exec(line);
    if (trailer) consumed.add(trailer[1]!);
    else lines.push(line);
  }
  const groups: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (HEADING_RULE.test(line)) {
      current = [line];
      groups.push(current);
    } else if (SEPARATOR_RULE.test(line)) {
      current = [];
      groups.push(current);
    } else if (current) {
      current.push(line);
    }
    // Lines before the first heading/separator are the preamble (seed text).
  }
  const blocks: InboxBlock[] = [];
  for (const group of groups) {
    const text = normalizeBlock(group);
    if (text.length === 0) continue;
    blocks.push({ index: blocks.length, hash: blockHash(text), text });
  }
  return { blocks, consumed };
}

/** Composer contract: printable ASCII + LF only, bounded size. */
export function toThoughtText(block: InboxBlock): string {
  let text = block.text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/[^\x00-\x7f]/g, "?");
  if (text.length > MAX_THOUGHT_BYTES) {
    text = text.slice(0, MAX_THOUGHT_BYTES).replace(/\n+$/, "") + "\n[truncated]";
  }
  return text;
}

export function readSeen(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return new Set();
    const hashes = (parsed as { hashes?: unknown }).hashes;
    if (!Array.isArray(hashes)) return new Set();
    return new Set(hashes.filter((h): h is string => typeof h === "string"));
  } catch {
    return new Set();
  }
}

export function serializeSeen(hashes: ReadonlySet<string>): string {
  const list = [...hashes];
  return `${JSON.stringify({ version: 1, hashes: list.slice(Math.max(0, list.length - MAX_SEEN)) })}\n`;
}

export type InboxPollResult =
  | { readonly state: "unbound"; readonly reason: string }
  | { readonly state: "offline"; readonly reason: string }
  | { readonly state: "ok"; readonly queued: number; readonly skipped: number; readonly trailerFailures: number; readonly notice?: string };

export interface InboxPollDeps {
  pages: () => ProjectPages | undefined;
  client: () => PagesClient | undefined;
  readSeen: () => Set<string>;
  writeSeen: (hashes: ReadonlySet<string>) => void;
  enqueue: (text: string, hash: string) => boolean;
  now: () => number;
}

export async function pollInbox(deps: InboxPollDeps): Promise<InboxPollResult> {
  const pages = deps.pages();
  if (!pages) return { state: "unbound", reason: "not connected" };
  const client = deps.client();
  if (!client) return { state: "unbound", reason: "credentials not exported" };
  let markdown: string | null;
  try {
    markdown = await client.readDocument(pages.inbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "offline", reason: message.slice(0, 80) };
  }
  if (markdown === null) return { state: "ok", queued: 0, skipped: 0, trailerFailures: 0 };
  const parsed = parseInboxBlocks(markdown);
  if (parsed.malformed !== undefined) return { state: "ok", queued: 0, skipped: 0, trailerFailures: 0, notice: parsed.malformed };
  const seen = deps.readSeen();
  let queued = 0;
  let skipped = 0;
  let trailerFailures = 0;
  for (const block of parsed.blocks) {
    if (seen.has(block.hash) || parsed.consumed.has(block.hash)) continue;
    if (!deps.enqueue(toThoughtText(block), block.hash)) { skipped += 1; continue; }
    queued += 1;
    seen.add(block.hash);
    deps.writeSeen(seen);
    const iso = new Date(deps.now()).toISOString();
    try {
      await client.writeMarkdown(pages.inbox, `\n\n${inboxTrailer(block.hash, iso)}\n`, "append", `Promptr queued ${block.hash}`);
    } catch {
      trailerFailures += 1;
    }
  }
  return { state: "ok", queued, skipped, trailerFailures };
}

export interface InboxPoller {
  refresh(): Promise<void>;
  current(): InboxPollResult | undefined;
}

/** Coalescing poller (mirrors createOpenKnowledgePoller); `onResult` after every completed poll. */
export function createInboxPoller(deps: InboxPollDeps & { onResult: (result: InboxPollResult) => void }): InboxPoller {
  let result: InboxPollResult | undefined;
  let inFlight: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    const next = await pollInbox(deps);
    result = next;
    deps.onResult(next);
  };

  return {
    refresh(): Promise<void> {
      if (inFlight) return inFlight;
      const promise = run().finally(() => { if (inFlight === promise) inFlight = undefined; });
      inFlight = promise;
      return promise;
    },
    current: () => result,
  };
}
