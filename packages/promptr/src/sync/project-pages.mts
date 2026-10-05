import path from "node:path";
import { briefingTarget } from "../briefing/openknowledge.mts";
import { parseGitRemote } from "../tracking/gitea.mts";

/**
 * Per-project OpenKnowledge page tree:
 * one current page (brief), one human inbox, one machine-written mirror
 * (workspace) and one append-only history (handoffs) under projects/<slug>.
 * Pure helpers plus async functions that only use the injected client.
 */
export const PROJECT_PAGE_KINDS = ["brief", "inbox", "workspace", "handoffs", "prompt-log"] as const;
export type ProjectPageKind = (typeof PROJECT_PAGE_KINDS)[number];

export interface ProjectPages {
  readonly origin: string;
  readonly label: string;
  readonly prefix: string;
  readonly brief: string;
  readonly inbox: string;
  readonly workspace: string;
  readonly handoffs: string;
  /** Append-only log of everything entered through /coordinatr. */
  readonly promptLog: string;
}

const SLUG_RULE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const BRIEF_RULE = /^projects\/[a-z0-9][a-z0-9_-]{0,79}\/brief$/;

/**
 * Stable project identity across checkout paths: the git remote's
 * repository name when there is one, else the directory basename. Two clients
 * cloning the same remote into differently named directories propose the
 * same `projects/<id>` pages.
 */
export function defaultProjectLabel(cwd: string, remoteUrl: string | undefined): string {
  if (remoteUrl !== undefined) {
    const parsed = parseGitRemote(remoteUrl);
    if (parsed && parsed.repo.length > 0) return parsed.repo;
  }
  return path.basename(cwd);
}

/** Human-typed URL segment: lowercase basename, `[^a-z0-9_-]` runs → `-`, trimmed, max 80. */
export function projectSlug(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  if (!SLUG_RULE.test(slug)) throw new Error("Project label yields no usable OpenKnowledge slug.");
  return slug;
}

export function projectPagesFor(origin: string, label: string, briefDocName?: string): ProjectPages {
  let prefix: string;
  if (briefDocName !== undefined) {
    if (!BRIEF_RULE.test(briefDocName)) throw new Error("Use projects/<project-id>/brief (lowercase letters, digits, - or _).");
    prefix = briefDocName.slice(0, -"/brief".length);
  } else {
    prefix = `projects/${projectSlug(label)}`;
  }
  const brief = `${prefix}/brief`;
  const checked = briefingTarget(origin, brief);
  return {
    origin: checked.origin, label, prefix, brief,
    inbox: `${prefix}/inbox`, workspace: `${prefix}/workspace`, handoffs: `${prefix}/handoffs`, promptLog: `${prefix}/prompt-log`,
  };
}

function asciiLabel(label: string): string {
  return label.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

export function seedPage(kind: Exclude<ProjectPageKind, "brief">, label: string): string {
  const name = asciiLabel(label);
  switch (kind) {
    case "inbox":
      return `# ${name} inbox\n\nType one thought per block: a \`## \` heading or a paragraph group separated by \`---\`. Promptr queues each new block once and appends a small trailer under it; it never edits your text.\n`;
    case "workspace":
      return `# ${name} workspace\n\nWritten by Promptr; edits here are overwritten. Nothing mirrored yet.\n`;
    case "handoffs":
      return `# ${name} handoffs\n\nAppend-only history of handoffs, wrap-ups and checkpoints.\n`;
    case "prompt-log":
      return `# ${name} prompt-log\n\nAppend-only history of everything entered through Promptr: queued thoughts, deletions, sends, note revisions, briefing saves. Never edited by Promptr; each client appends batches marked with its id.\n`;
  }
}

/** Page name for a kind. */
export function pageFor(pages: ProjectPages, kind: ProjectPageKind): string {
  return kind === "prompt-log" ? pages.promptLog : pages[kind];
}

export type OpenKnowledgeStatus =
  | { readonly state: "unbound"; readonly reason: string }
  | { readonly state: "offline"; readonly reason: string; readonly at: number }
  | { readonly state: "ok"; readonly at: number; readonly created: readonly ProjectPageKind[] };

/** Structural client; OpenKnowledgeClient satisfies it. */
export interface PagesClient {
  readDocument(docName: string): Promise<string | null>;
  createPage(docName: string): Promise<"created" | "exists">;
  writeMarkdown(docName: string, markdown: string, position: "replace" | "append", summary: string): Promise<void>;
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 80);
}

const SEEDED_KINDS = ["inbox", "workspace", "handoffs", "prompt-log"] as const;

/**
 * Verifies auth via the brief (never created or replaced here), then creates
 * only the missing inbox/workspace/handoffs pages with their seeds. Existing
 * pages get no write. Any throw maps to `offline`; the reason is an error
 * message, never a credential.
 */
export async function bootstrapProjectPages(client: PagesClient, pages: ProjectPages, now: () => number): Promise<OpenKnowledgeStatus> {
  try {
    await client.readDocument(pages.brief);
  } catch (error) {
    return { state: "offline", reason: reasonOf(error), at: now() };
  }
  const created: ProjectPageKind[] = [];
  for (const kind of SEEDED_KINDS) {
    const docName = pageFor(pages, kind);
    try {
      const existing = await client.readDocument(docName);
      if (existing !== null) continue;
      const outcome = await client.createPage(docName);
      if (outcome === "created") {
        await client.writeMarkdown(docName, seedPage(kind, pages.label), "replace", `Promptr bootstrap: ${kind} page`);
        created.push(kind);
      }
      // "exists" is a lost race: another client created it; read back either way.
      if (await client.readDocument(docName) === null) {
        return { state: "offline", reason: `${kind} create/read-back failed`, at: now() };
      }
    } catch (error) {
      return { state: "offline", reason: reasonOf(error), at: now() };
    }
  }
  return { state: "ok", at: now(), created };
}

/** Exactly one bounded read of the inbox; a missing page still counts as reachable. */
export async function checkProjectPages(client: PagesClient, pages: ProjectPages, now: () => number): Promise<OpenKnowledgeStatus> {
  try {
    await client.readDocument(pages.inbox);
    return { state: "ok", at: now(), created: [] };
  } catch (error) {
    return { state: "offline", reason: reasonOf(error), at: now() };
  }
}

export function okAge(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Exact spellings: the view paints by these words. */
export function okHeaderLabel(status: OpenKnowledgeStatus, nowMs: number): string {
  if (status.state === "unbound") return "OK unbound";
  if (status.state === "offline") return "OK offline";
  return `OK ${okAge(status.at, nowMs)}`;
}

export interface OpenKnowledgePollerDeps {
  pages: () => ProjectPages | undefined;
  client: () => PagesClient | undefined;
  check: typeof checkProjectPages;
  now: () => number;
  onStatus: (status: OpenKnowledgeStatus) => void;
}

export interface OpenKnowledgePoller {
  refresh(): Promise<void>;
  current(): OpenKnowledgeStatus;
}

function labelRelevant(status: OpenKnowledgeStatus): string {
  return status.state === "ok" ? `ok:${status.created.join(",")}` : status.state;
}

/** Coalescing poller (mirrors createTrackingRefresher): emits only on label-relevant change, always on the first call. */
export function createOpenKnowledgePoller(deps: OpenKnowledgePollerDeps): OpenKnowledgePoller {
  let status: OpenKnowledgeStatus = { state: "unbound", reason: "not connected" };
  let emitted = false;
  let inFlight: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    const pages = deps.pages();
    let next: OpenKnowledgeStatus;
    if (!pages) next = { state: "unbound", reason: "not connected" };
    else {
      const client = deps.client();
      if (!client) next = { state: "unbound", reason: "credentials not exported" };
      else next = await deps.check(client, pages, deps.now);
    }
    const changed = !emitted || labelRelevant(next) !== labelRelevant(status);
    status = next;
    if (changed) { emitted = true; deps.onStatus(next); }
  };

  return {
    refresh(): Promise<void> {
      if (inFlight) return inFlight;
      const promise = run().finally(() => { if (inFlight === promise) inFlight = undefined; });
      inFlight = promise;
      return promise;
    },
    current: () => status,
  };
}
