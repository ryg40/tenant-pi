/**
 * Reading the shared workspace before overwriting it.
 *
 * The workspace page is a current-state mirror. A fresh client connecting to
 * a project must not replace what another client last mirrored without at
 * least reading it: `parseWorkspacePage` extracts the writing client and
 * timestamp from the page's header lines, and `workspaceImportDecision` says
 * whether that remote content should be archived to the prompt-log as a
 * `workspace-import` entry before this client's first mirror write.
 *
 * Pure: no I/O.
 */

export interface RemoteWorkspace {
  readonly client: string | undefined;
  readonly updated: string | undefined;
  readonly project: string | undefined;
  readonly markdown: string;
}

const CLIENT_RULE = /^Client: (\S+)\s*$/m;
const UPDATED_RULE = /^Updated: (\S+)\s*$/m;
const PROJECT_RULE = /^Project: (.+?)\s*$/m;

export function parseWorkspacePage(markdown: string): RemoteWorkspace {
  return {
    client: CLIENT_RULE.exec(markdown)?.[1],
    updated: UPDATED_RULE.exec(markdown)?.[1],
    project: PROJECT_RULE.exec(markdown)?.[1],
    markdown,
  };
}

export type ImportDecision =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "import"; readonly reason: string };

/**
 * Import when the remote workspace was written by another client (or by an
 * unknown writer) and carries more than the seed. Our own earlier mirror is
 * not imported: the prompt-log already holds what it contained.
 */
export function workspaceImportDecision(remote: RemoteWorkspace | null, ourClient: string, alreadyImported: string | undefined): ImportDecision {
  if (remote === null) return { action: "none", reason: "no remote workspace page" };
  if (remote.client === ourClient) return { action: "none", reason: "remote workspace was mirrored by this client" };
  const signature = `${remote.client ?? "unknown"}@${remote.updated ?? "unknown"}`;
  if (alreadyImported === signature) return { action: "none", reason: "remote workspace already imported" };
  if (/Nothing mirrored yet\./.test(remote.markdown) && !UPDATED_RULE.test(remote.markdown)) {
    return { action: "none", reason: "remote workspace is the untouched seed" };
  }
  return { action: "import", reason: `remote workspace written by ${remote.client ?? "an unknown client"} at ${remote.updated ?? "an unknown time"}` };
}

export function workspaceSignature(remote: RemoteWorkspace): string {
  return `${remote.client ?? "unknown"}@${remote.updated ?? "unknown"}`;
}

/** Read the machine-written Notebook section, ignoring headings inside payload fences.
 * Legacy mirrors add a terminating LF; retain it rather than trimming user text.
 */
export function workspaceNotebook(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence !== undefined) {
      if (line === fence) fence = undefined;
      continue;
    }
    if (/^`{3,}$/.test(line)) { fence = line; continue; }
    if (line !== "## Notebook" || lines[i + 1] !== "" || !/^`{3,}$/.test(lines[i + 2] ?? "")) continue;
    const end = lines.indexOf(lines[i + 2]!, i + 3);
    if (end < 0) return undefined;
    return lines.slice(i + 3, end).join("\n") + "\n";
  }
  return undefined;
}

/** Latest complete note-revision payload from the append-only shared prompt-log. */
export function latestPromptLogNotebook(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  let latest: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^### \d+ ([a-z-]+) · /.exec(lines[i] ?? "");
    if (!heading || lines[i + 1] !== "" || !/^`{3,}$/.test(lines[i + 2] ?? "")) continue;
    const fence = lines[i + 2]!;
    const end = lines.indexOf(fence, i + 3);
    if (end < 0) return latest;
    if (heading[1] === "note-revision") latest = `${lines.slice(i + 3, end).join("\n")}\n`;
    i = end;
  }
  return latest;
}
