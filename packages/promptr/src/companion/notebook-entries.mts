/**
 * Notebook entries: bounded blocks of the free-form notebook that the queue
 * panel can walk, highlight, queue, send, copy and delete as one unit.
 *
 * Pure: no I/O, clock, randomness or view state. Notebook text is inert data.
 *
 * Two kinds of entry, both addressed by 1-based inclusive physical lines (the
 * same line model as the frozen selector in src/selection/lines.mts):
 * - marked: `-- <label> --` opens it and `-- end --` closes it. A block that
 *   was never closed ends before the next opener or at the end of the text,
 *   without its trailing blank lines. Archived prompts (`-- Queued <stamp> --`)
 *   and Ctrl+N notes (`-- Note <stamp> --`) both use this shape.
 * - paragraph: a maximal run of non-blank lines outside any marked block, so
 *   notes typed without markers can still be walked.
 */

export interface NotebookEntry {
  readonly kind: "marked" | "paragraph";
  /** Marker label (`Queued 2026-09-08 12:00Z`), or the first line of a paragraph. */
  readonly label: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Lines to queue or copy: the block without its markers. `bodyStart > bodyEnd` means no text. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export const NOTE_END_MARKER = "-- end --";
const BEGIN_MARKER = /^-- (.+?) --$/;

export function isEndMarker(line: string): boolean {
  return line.trim() === NOTE_END_MARKER;
}

export function isBeginMarker(line: string): boolean {
  return !isEndMarker(line) && BEGIN_MARKER.test(line.trim());
}

/** Physical lines with the selector's rule: a trailing LF opens no extra line. */
export function physicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The block Ctrl+N inserts. The blank middle line is where the cursor lands. */
export function newNoteBlock(stamp: string): string {
  return `-- Note ${stamp} --\n\n${NOTE_END_MARKER}\n`;
}

/** The archive block for a queued composer prompt, closed so it is one entry. */
export function archivedPromptBlock(stamp: string, text: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `-- Queued ${stamp} --\n${body}${NOTE_END_MARKER}\n`;
}

export function notebookEntries(text: string): readonly NotebookEntry[] {
  const lines = physicalLines(text);
  const entries: NotebookEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBeginMarker(line)) {
      const start = index + 1;
      const label = BEGIN_MARKER.exec(line.trim())?.[1] ?? "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < lines.length) {
        const candidate = lines[cursor] ?? "";
        if (isEndMarker(candidate)) { closed = true; break; }
        if (isBeginMarker(candidate)) break;
        cursor += 1;
      }
      // `cursor` is the end marker (closed), the next opener, or lines.length.
      let end = closed ? cursor + 1 : cursor;
      let bodyEnd = closed ? cursor : cursor;
      if (!closed) {
        while (bodyEnd > start && (lines[bodyEnd - 1] ?? "").trim().length === 0) bodyEnd -= 1;
        end = bodyEnd;
      }
      entries.push(Object.freeze({
        kind: "marked", label, startLine: start, endLine: Math.max(start, end),
        bodyStart: start + 1, bodyEnd,
      }));
      index = closed ? cursor + 1 : Math.max(cursor, end);
      continue;
    }
    // Blank lines and a stray `-- end --` outside any block separate entries.
    if (line.trim().length === 0 || isEndMarker(line)) { index += 1; continue; }
    const start = index + 1;
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = lines[cursor] ?? "";
      if (candidate.trim().length === 0 || isBeginMarker(candidate) || isEndMarker(candidate)) break;
      cursor += 1;
    }
    entries.push(Object.freeze({
      kind: "paragraph", label: line.trim(), startLine: start, endLine: cursor, bodyStart: start, bodyEnd: cursor,
    }));
    // A stray `-- end --` outside a block is skipped like a blank line.
    index = isEndMarker(lines[cursor] ?? "") ? cursor + 1 : cursor;
  }
  return Object.freeze(entries);
}

/** Index of the entry whose range contains `line`, else the last entry starting before it, else 0; -1 when there are none. */
export function entryIndexAt(entries: readonly NotebookEntry[], line: number): number {
  if (entries.length === 0) return -1;
  let best = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as NotebookEntry;
    if (entry.startLine <= line && line <= entry.endLine) return i;
    if (entry.startLine <= line) best = i;
  }
  return best;
}

/** The entry whose range equals the selection, if any. */
export function entryMatching(entries: readonly NotebookEntry[], selection: LineRange): NotebookEntry | undefined {
  return entries.find((entry) => entry.startLine === selection.startLine && entry.endLine === selection.endLine);
}

/**
 * Where `[` / `]` move the selection. A selection that is not exactly an entry
 * snaps to the entry around its first line first; an exact entry steps by
 * `delta` and stops at either end.
 */
export function stepEntry(
  entries: readonly NotebookEntry[], selection: LineRange, delta: -1 | 1,
): { entry: NotebookEntry; index: number } | undefined {
  if (entries.length === 0) return undefined;
  const at = entryIndexAt(entries, selection.startLine);
  const current = entries[at] as NotebookEntry;
  const exact = current.startLine === selection.startLine && current.endLine === selection.endLine;
  const index = exact ? Math.min(entries.length - 1, Math.max(0, at + delta)) : at;
  return { entry: entries[index] as NotebookEntry, index };
}

/** The text with physical lines `startLine..endLine` (inclusive, 1-based) removed. Out-of-range lines are ignored. */
export function removeLines(text: string, startLine: number, endLine: number): string {
  const lines = physicalLines(text);
  const from = Math.max(1, startLine) - 1;
  const to = Math.min(lines.length, endLine);
  if (from >= to) return text;
  const kept = [...lines.slice(0, from), ...lines.slice(to)];
  if (kept.length === 0) return "";
  return `${kept.join("\n")}\n`;
}
