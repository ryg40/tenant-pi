import type { PagesClient, ProjectPages } from "./project-pages.mts";
import type { WorkBoard } from "../tracking/board.mts";

/** The workspace page is a disposable, machine-written view of active companion state. */
export interface WorkspaceMirrorContent {
  readonly project: string;
  readonly gitRef: string;
  readonly gitHead: string;
  readonly gitDirty: boolean;
  readonly piStatus: string;
  readonly queue: readonly { readonly text: string }[];
  readonly composer: string;
  readonly board?: WorkBoard;
  /** Writing client id; other clients read it before overwriting. */
  readonly client?: string;
  /** Current notebook text: the workspace reflects current state, the prompt-log keeps history. */
  readonly note?: string;
}

export interface WorkspaceMirrorObservation {
  readonly pages: ProjectPages;
  readonly client: PagesClient;
  readonly content: WorkspaceMirrorContent;
}

export type WorkspaceMirrorStatus = "unbound" | "pending" | "synced";

/** A fence strictly longer than every backtick run in the payload. */
export function markdownFence(text: string): string {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const fence = markdownFence(text);
  return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

function activeBoardRows(board: WorkBoard | undefined): string[] {
  if (!board) return [];
  return board.rows.flatMap((row) => {
    if (row.kind !== "issue" || (row.issue.status !== "active" && row.issue.status !== "ready")) return [];
    return [`- #${String(row.issue.number)} [${row.issue.status}] ${row.issue.title}`];
  });
}

/** Pure renderer. `updatedIso` is supplied only when a write is actually attempted. */
export function renderWorkspaceMirror(content: WorkspaceMirrorContent, updatedIso: string): string {
  const queue = content.queue.flatMap((thought, index) => [
    `### ${String(index + 1)}.`,
    "",
    fenced(thought.text),
    "",
  ]);
  const boardRows = activeBoardRows(content.board);
  return [
    `# ${content.project} workspace`,
    "",
    `Project: ${content.project}`,
    `Git: ${content.gitRef || "(detached)"} @${content.gitHead || "unknown"}${content.gitDirty ? "*" : ""}`,
    `Pi: ${content.piStatus || "unknown"}`,
    `Updated: ${updatedIso}`,
    ...(content.client === undefined ? [] : [`Client: ${content.client}`]),
    "",
    "> Machine-written by Promptr. Edits to this page are overwritten; history lives on the prompt-log page.",
    "",
    "## Queue",
    "",
    ...(queue.length > 0 ? queue : ["(empty)", ""]),
    "## Composer",
    "",
    fenced(content.composer),
    "",
    "## Workboard",
    "",
    content.board?.summary ?? "No workboard snapshot.",
    "",
    ...(boardRows.length > 0 ? boardRows : ["(no active or ready issues)"]),
    "",
    ...(content.note === undefined ? [] : ["## Notebook", "", fenced(content.note), ""]),
  ].join("\n");
}

function copyContent(content: WorkspaceMirrorContent): WorkspaceMirrorContent {
  const board = content.board === undefined ? undefined : JSON.parse(JSON.stringify(content.board)) as WorkBoard;
  return {
    project: String(content.project),
    gitRef: String(content.gitRef),
    gitHead: String(content.gitHead),
    gitDirty: Boolean(content.gitDirty),
    piStatus: String(content.piStatus),
    queue: Object.freeze(content.queue.map((thought) => Object.freeze({ text: String(thought.text) }))),
    composer: String(content.composer),
    ...(board === undefined ? {} : { board }),
    ...(content.client === undefined ? {} : { client: String(content.client) }),
    ...(content.note === undefined ? {} : { note: String(content.note) }),
  };
}

/** Canonical identity intentionally excludes the changing write timestamp and board age. */
export function workspaceMirrorIdentity(content: WorkspaceMirrorContent): string {
  const copied = copyContent(content);
  return JSON.stringify({
    project: copied.project,
    gitRef: copied.gitRef,
    gitHead: copied.gitHead,
    gitDirty: copied.gitDirty,
    piStatus: copied.piStatus,
    queue: copied.queue.map((thought) => thought.text),
    composer: copied.composer,
    note: copied.note,
    board: copied.board === undefined ? undefined : {
      summary: copied.board.summary,
      rows: activeBoardRows(copied.board),
    },
  });
}

export interface WorkspaceMirrorSchedulerDeps {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly onStatus: (status: WorkspaceMirrorStatus) => void;
}

export interface WorkspaceMirrorScheduler {
  /** Observe after the local save. Undefined means unbound/demo/no credentials. */
  observe(observation: WorkspaceMirrorObservation | undefined): void;
  /** Reconnect hook: retry a failed identity without waiting for a content change. */
  retryPending(): void;
  current(): WorkspaceMirrorStatus;
}

const DEBOUNCE_MS = 10_000;
const THROTTLE_MS = 30_000;

/**
 * Small single-flight scheduler: latest changed content after 10 s quiet, at
 * most one attempt per 30 s. Failures wait for a later content change or an
 * explicit `retryPending()` from the reconnect poll.
 */
export function createWorkspaceMirrorScheduler(deps: WorkspaceMirrorSchedulerDeps): WorkspaceMirrorScheduler {
  type Captured = WorkspaceMirrorObservation & { readonly content: WorkspaceMirrorContent; readonly identity: string; readonly targetKey: string };
  let latest: Captured | undefined;
  let generation = 0;
  let changedAt = 0;
  let lastAttemptAt: number | undefined;
  let successfulIdentity: string | undefined;
  let failedIdentity: string | undefined;
  let timer: unknown;
  let inFlight = false;
  let status: WorkspaceMirrorStatus = "unbound";

  const emit = (next: WorkspaceMirrorStatus): void => {
    if (next === status) return;
    status = next;
    deps.onStatus(next);
  };
  const cancelTimer = (): void => {
    if (timer === undefined) return;
    deps.clearTimer(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    cancelTimer();
    if (!latest || inFlight || latest.identity === successfulIdentity || latest.identity === failedIdentity) return;
    const earliest = Math.max(changedAt + DEBOUNCE_MS, (lastAttemptAt ?? -THROTTLE_MS) + THROTTLE_MS);
    timer = deps.setTimer(() => {
      timer = undefined;
      void attempt();
    }, Math.max(0, earliest - deps.now()));
  };
  const attempt = async (): Promise<void> => {
    const captured = latest;
    if (!captured || inFlight || captured.identity === successfulIdentity || captured.identity === failedIdentity) return;
    inFlight = true;
    lastAttemptAt = deps.now();
    const attemptGeneration = generation;
    const markdown = renderWorkspaceMirror(captured.content, new Date(lastAttemptAt).toISOString());
    try {
      await captured.client.writeMarkdown(captured.pages.workspace, markdown, "replace", "Update Promptr workspace mirror");
      if (attemptGeneration === generation) {
        successfulIdentity = captured.identity;
        failedIdentity = undefined;
        if (latest?.identity === captured.identity) emit("synced");
      }
    } catch {
      if (attemptGeneration === generation) {
        failedIdentity = captured.identity;
        emit("pending");
      }
    } finally {
      inFlight = false;
      schedule();
    }
  };

  return {
    observe(observation): void {
      if (!observation) {
        generation += 1;
        latest = undefined;
        successfulIdentity = undefined;
        failedIdentity = undefined;
        cancelTimer();
        emit("unbound");
        return;
      }
      const content = copyContent(observation.content);
      const identity = workspaceMirrorIdentity(content);
      const targetKey = `${observation.pages.origin}\n${observation.pages.workspace}`;
      const bindingChanged = latest !== undefined && latest.targetKey !== targetKey;
      if (bindingChanged) {
        generation += 1;
        successfulIdentity = undefined;
        failedIdentity = undefined;
        cancelTimer();
      }
      if (!bindingChanged && latest?.identity === identity) return;
      latest = { pages: { ...observation.pages }, client: observation.client, content, identity, targetKey };
      changedAt = deps.now();
      failedIdentity = undefined;
      emit("pending");
      schedule();
    },
    retryPending(): void {
      if (!latest || inFlight || failedIdentity === undefined || latest.identity !== failedIdentity) return;
      failedIdentity = undefined;
      changedAt = deps.now();
      schedule();
    },
    current: () => status,
  };
}
