/**
 * Progress tracking: tiny append-only checkpoint log per project.
 * Pure helpers + thin file adapters. No network, no execution.
 */
import { randomUUID } from "node:crypto";
import { appendText, readText, atomicWrite } from "../state/paths.mts";

export type ProgressEntry = {
  id: string;
  at: string;
  text: string;
  cwd: string;
  head: string;
  ref: string;
  dirty: boolean;
  changed: string[];
};

export type ProgressFile = {
  version: 1;
  entries: ProgressEntry[];
};

export function emptyProgress(): ProgressFile {
  return { version: 1, entries: [] };
}

export function parseProgress(raw: string | undefined): ProgressFile {
  if (!raw) return emptyProgress();
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return emptyProgress();
    const rec = v as Record<string, unknown>;
    if (rec.version !== 1 || !Array.isArray(rec.entries)) return emptyProgress();
    const entries: ProgressEntry[] = [];
    for (const e of rec.entries.slice(-200)) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      if (typeof r.id !== "string" || typeof r.at !== "string" || typeof r.text !== "string") continue;
      entries.push({
        id: r.id,
        at: r.at,
        text: r.text.slice(0, 4000),
        cwd: typeof r.cwd === "string" ? r.cwd : "",
        head: typeof r.head === "string" ? r.head : "unknown",
        ref: typeof r.ref === "string" ? r.ref : "",
        dirty: r.dirty === true,
        changed: Array.isArray(r.changed) ? r.changed.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
      });
    }
    return { version: 1, entries };
  } catch {
    return emptyProgress();
  }
}

export function loadProgress(file: string): ProgressFile {
  return parseProgress(readText(file));
}

export function appendProgress(
  file: string,
  logFile: string,
  input: { text: string; cwd: string; head: string; ref: string; dirty: boolean; changed: string[] },
): ProgressEntry {
  const current = loadProgress(file);
  const entry: ProgressEntry = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    text: input.text.slice(0, 4000),
    cwd: input.cwd,
    head: input.head,
    ref: input.ref,
    dirty: input.dirty,
    changed: input.changed.slice(0, 50),
  };
  const next: ProgressFile = { version: 1, entries: [...current.entries.slice(-199), entry] };
  atomicWrite(file, JSON.stringify(next, null, 2));
  // Append-only human log. Never rewritten.
  const block = `\n## Checkpoint ${entry.at} (${entry.id})\n- cwd: \`${entry.cwd}\`\n- ref: \`${entry.ref || "?"}\` head: \`${entry.head}\`${entry.dirty ? " (dirty)" : ""}\n${entry.changed.length > 0 ? `- changed: ${entry.changed.map((c) => `\`${c}\``).join(", ")}\n` : ""}\n${entry.text}\n`;
  try { appendText(logFile, block); } catch { /* log is best effort */ }
  return entry;
}

/** Short human-readable status for /promptr-status. */
export function renderStatus(input: {
  slug: string; cwd: string; head: string; ref: string; dirty: boolean; changed: string[];
  queueCount: number; handoffCount: number; latestHandoff?: string;
  entries: ProgressEntry[];
}): string {
  const lines: string[] = [];
  lines.push(`Promptr — ${input.slug}`);
  lines.push(`cwd: ${input.cwd}`);
  lines.push(`git: ${input.ref || "?"} @ ${input.head}${input.dirty ? " (dirty)" : " (clean)"}`);
  if (input.changed.length > 0) lines.push(`changed: ${input.changed.slice(0, 10).join(", ")}${input.changed.length > 10 ? ` (+${input.changed.length - 10} more)` : ""}`);
  lines.push(`queue: ${input.queueCount} pending | handoffs staged: ${input.handoffCount}${input.latestHandoff ? ` (latest: ${input.latestHandoff})` : ""}`);
  const recent = input.entries.slice(-5).reverse();
  if (recent.length === 0) {
    lines.push(`progress: no checkpoints yet — /promptr-save "did X, next Y"`);
  } else {
    lines.push(`recent checkpoints:`);
    for (const e of recent) lines.push(`- [${e.at.slice(0, 16).replace("T", " ")} ${e.id}] ${e.text.split("\n")[0]?.slice(0, 120)}`);
  }
  return lines.join("\n");
}
