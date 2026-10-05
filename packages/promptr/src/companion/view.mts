/**
 * Disposable interaction prototype: panel + composer + note in one offline view.
 *
 * SESSION ONLY. Nothing here persists, imports, sends, syncs or executes anything.
 * The queue is the real in-process queue module (src/queue/pending.mts) held in memory
 * and discarded on exit; selection uses the frozen selector (src/selection/lines.mts).
 *
 * Supported input is deliberately narrow: printable ASCII plus LF. Everything else
 * (control bytes, DEL, tabs, CR inside text, non-ASCII, lone surrogates, pasted
 * content) is rejected with a visible notice and never normalized into a buffer.
 */
import { randomUUID } from "node:crypto";
import {
  CURSOR_MARKER,
  Editor,
  ScrollView,
  VStack,
  isKeyRelease,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, EditorTheme, KeyId, TUI } from "@earendil-works/pi-tui";
// renderLayoutFrame is not re-exported from the package index; the height-bounded
// frame used by TuiAltScreen.doRender() is only reachable through this module path.
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import {
  clearQueue,
  duplicateItem,
  emptyQueue,
  enqueue,
  moveItem,
  removeItem,
  removeItemWithUndo,
  restoreItem,
} from "../queue/pending.mts";
import type { PendingQueue, RemovedItem } from "../queue/pending.mts";
import { selectLines } from "../selection/lines.mts";
import {
  archivedPromptBlock, entryMatching, newNoteBlock, notebookEntries, removeLines, stepEntry,
} from "./notebook-entries.mts";
import { ageLine } from "../tracking/gitea.mts";
import type { BoardIssue, BoardRow, WorkBoard, WorkStatus } from "./board-port.mts";
import { WORK_STATUS_ORDER } from "./board-port.mts";

export type { BoardIssue, BoardRow, WorkBoard, WorkStatus } from "./board-port.mts";

// The single physical-line selector for this module. Re-exported (not reimplemented)
// so callers and tests share the frozen `{text, startLine, endLine}` contract.
export { selectLines } from "../selection/lines.mts";

/** Banner shown at the top of every frame so the prototype is never mistaken for the product. */
export const SPIKE_BANNER = "PROMPTR COMPANION - INTERACTION PROTOTYPE (MOCK)";

/** Discard warning; the prototype has no storage at all. */
export const NOT_SAVED_BANNER = "NOT SAVED - discarded on exit; nothing is stored, sent or executed";

/** Accepted-input contract, shown in every frame. Composer accepts bracketed paste. */
export const INPUT_CONTRACT_BANNER =
  "Type ASCII + Enter · paste works in composer and notebook · Tab changes focus";

/**
 * Region names. Short, so a 40-column frame still shows the whole word next to
 * the content it labels, and so the footer can name the focused region in full.
 */
const REGION_NAME: Record<SpikeFocus, string> = {
  panel: "QUEUE",
  composer: "COMPOSE",
  editor: "NOTEBOOK",
  tracking: "TRACKING",
};

/** Keys forwarded to a focused buffer as editing commands rather than as text. */
const EDITING_KEYS = [
  "enter",
  "backspace",
  "delete",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
] as const satisfies readonly KeyId[];

const QUIT_PROMPT = "discard everything and quit? y = quit, n/Esc = keep working";
const CLEAR_PROMPT = (count: number): string =>
  `Clear ${count} queued item${count === 1 ? "" : "s"}? y = clear, n/Esc = keep`;
const DELETE_PROMPT = (index: number): string => `Delete thought ${index}? y = delete, n/Esc = keep`;
const ENTRY_DELETE_PROMPT = (range: SpikeSelection): string =>
  `Delete notebook lines ${range.startLine}-${range.endLine}? y = delete, n/Esc = keep`;
const EDIT_REFUSAL = "composer has a draft — queue or clear it before editing a card";

/** Panel rows spent on queue thought cards, so the queue region stays bounded. */
const PANEL_QUEUE_ROWS = 10;
/** Panel rows the `?` key reference may take in place of the cards. */
const HELP_ROWS = 14;
/** Text lines a focused (expanded, proqi-style) queue card shows before `+n lines`. */
const CARD_EXPANDED_LINES = 4;
/** Left bar painted on every row of the focused queue card. */
const CARD_BAR = "▎";
/** Status word column width on issue rows (`blocked` is the widest word). */
const STATUS_COLUMN = 7;
/** Upper bound for a collapsed queue card's first-line preview. */
const BOARD_PREVIEW_CHARS = 64;
/** Bottom-panel tracking rows: full milestone names plus open-issue titles. */
export const PANEL_TRACKING_ROWS = 14;

/** Rows the composer may occupy before it scrolls, so it never crowds the notebook. */
const COMPOSER_VISIBLE_LINES = 8;
/** Smallest notebook region worth drawing: both borders plus one text row. */
const MIN_NOTEBOOK_ROWS = 3;
/** Below this width the footer switches to its terse hint wording. */
const WIDE_HINT_COLUMNS = 72;
/** Absolute paths longer than this are condensed to their tail in status text. */
const PATH_CONDENSE_CHARS = 24;

/**
 * Measured in @earendil-works/pi-tui 0.85.0: Editor.render() shows at most
 * `max(5, floor(tui.terminal.rows * 0.3))` text lines and pages by the same
 * amount, regardless of the height the layout actually allocated to it. The
 * companion's notebook is the region that should absorb spare height, so the
 * editors are handed a viewport-scoped TUI whose reported `rows` makes that
 * cap match the rows the region really has. Kept as an integer ratio so the
 * inverse never drifts on floating point.
 */
const EDITOR_VISIBLE_NUMERATOR = 3;
const EDITOR_VISIBLE_DENOMINATOR = 10;

/** Reported terminal rows that give an Editor at most `lines` visible text rows. */
function rowsForVisibleLines(lines: number): number {
  const wanted = Math.max(1, Math.trunc(lines));
  return Math.max(1, Math.floor((wanted * EDITOR_VISIBLE_DENOMINATOR) / EDITOR_VISIBLE_NUMERATOR));
}

/**
 * A TUI façade that reports a different `terminal.rows` to one component.
 * Every other member is forwarded to the real TUI with the real `this`, so the
 * host keeps a single terminal, input loop and render scheduler.
 */
function viewportScopedTui(tui: TUI, rows: () => number): TUI {
  const forward = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(tui, {
    get(target, prop) {
      if (prop !== "terminal") return forward(target, prop);
      const terminal = Reflect.get(target, "terminal", target) as object;
      return new Proxy(terminal, {
        get: (inner, key) => (key === "rows" ? Math.max(1, Math.trunc(rows())) : forward(inner, key)),
      });
    },
  });
}

/**
 * Condense absolute paths inside a status line to `…/<last segment>`.
 * A private state root is noise in a one-line footer, but the sentence around
 * it — a send result, a refusal, a failure reason — is kept exactly.
 */
export function condensePaths(text: string): string {
  return text.replace(/~?(?:\/[^\s'"`,;]+){2,}/g, (match) => {
    if (match.length <= PATH_CONDENSE_CHARS) return match;
    const tail = match.slice(match.lastIndexOf("/") + 1);
    return tail.length === 0 ? match : `…/${tail}`;
  });
}

/** Byte bound for the note and composer buffers; matches the queue module's entry bound. */
export const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * `tracking` exists only when the host enables tracking navigation. Without
 * that option the view keeps its historical three regions exactly, so every
 * caller written against the old focus cycle behaves as it always did.
 */
export type SpikeFocus = "panel" | "editor" | "composer" | "tracking";

/**
 * What the focused tracking region is asking the host to do. The region owns
 * no list, page or selection state: the navigation controller does, so the
 * view only reports intent and renders the one line the host hands back.
 */
export type TrackingIntent =
  | { kind: "open"; issue: BoardIssue }
  | { kind: "generate"; issue: BoardIssue }
  | { kind: "refresh" };

/** Host-supplied header fragments (display only, single line each). */
export interface HeaderStatus {
  git?: string;
  pi?: string;
  /** OpenKnowledge binding: `OK 12s`, `OK offline`, `OK unbound`. */
  ok?: string;
}

export interface SpikeSelection {
  /** 1-based inclusive physical (newline-delimited) line numbers. */
  startLine: number;
  endLine: number;
}

export interface CompanionSessionState {
  noteText: string;
  composerText: string;
  queue: PendingQueue;
  documentRevision: number;
  selection: SpikeSelection;
  focus: SpikeFocus;
}

export interface CompanionSpikeViewOptions {
  /** Pi-hosted prototype: close retains memory; Ctrl+S opens explicit submission review. */
  hosted?: boolean;
  /** Project overview navigation for hosted and persistent companion views. */
  overviewNavigation?: boolean;
  /**
   * Structured tracking navigation. Off by default: enabling it
   * adds `tracking` to the Tab cycle, which changes the focus order every
   * existing caller depends on.
   */
  trackingNavigation?: boolean;
  /** Only internally produced session snapshots, never filesystem or external input. */
  sessionState?: CompanionSessionState;
  /** Inert note text. Never read from a real notebook. Printable ASCII + LF only. */
  noteText: string;
  /**
   * Short project identity for the header (e.g. a repository directory name).
   * Display only. Never a filesystem path: the header must not leak a private
   * state root, and the host already knows where the project lives.
   */
  projectLabel?: string;
  /** Legacy field from the state-directory spike. Accepted and ignored; there is no state root. */
  stateRootLabel?: string;
  /**
   * Omakase-adapted project tracking lines for the coordinatr window.
   * Display data only (Gitea read-only snapshot rendered to text by the host).
   * Never persisted as note/queue state; the host reloads it from tracking.json.
   */
  trackingLines?: string[];
}

/** Thrown when constructor text violates the accepted-input contract. */
export class UnsupportedTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTextError";
  }
}

/** Printable ASCII (0x20-0x7E) with no line breaks: what a keystroke chunk may carry. */
function isPrintableAscii(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

/** Accepted buffer content: printable ASCII plus LF. Empty text is accepted. */
export function isSupportedText(text: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(text);
}

/** Validate text destined for a buffer. Rejects instead of normalizing. */
function assertSupportedText(text: unknown, label: string, restored = false): string {
  if (typeof text !== "string") throw new UnsupportedTextError(`${label} must be a string`);
  if (restored ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text) : !isSupportedText(text)) {
    throw new UnsupportedTextError(
      `${label} contains unsupported bytes; this prototype accepts printable ASCII and LF only`,
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BUFFER_BYTES) {
    throw new UnsupportedTextError(`${label} exceeds the ${MAX_BUFFER_BYTES / 1024} KiB prototype bound`);
  }
  return text;
}

/** Render control bytes as caret notation for display only; the input is never modified. */
export function escapeForDisplay(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x7f) out += "^?";
    else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
    else out += char;
  }
  return out;
}

/**
 * Zero-dependency ANSI palette for the companion board (proqi-style).
 *
 * Whole-line wraps only: painters apply these to complete rendered rows so
 * embedded content substrings are never split by escape codes. Honors
 * NO_COLOR (present and non-empty disables all color).
 */
const NO_COLOR = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
const ansi = (code: string) => (text: string): string =>
  NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`;
export const boardColors = {
  /** Focused section headers, cursor row, primary actions. */
  accent: ansi("36"),
  accentBold: ansi("1;36"),
  /** Unfocused chrome, rules, secondary text. */
  muted: ansi("2;37"),
  /** Counts, progress fill, invitations to act. */
  green: ansi("32"),
  /** Confirmations and banners that deserve attention. */
  yellow: ansi("33"),
  bold: ansi("1"),
  dim: ansi("2"),
  /** Whole-row highlight of the notebook entry the queue panel is standing on. */
  inverse: ansi("7"),
};

/**
 * Full-width section rule: `── TITLE ───…` padded with ─ to exactly `width`
 * visible columns. Title must stay plain (painters colorize afterwards).
 */
export function sectionRule(title: string, width: number): string {
  const edge = Math.max(1, Math.trunc(width));
  const pad = Math.max(0, edge - visibleWidth(title) - 4);
  return `── ${title} ${"─".repeat(pad)}`;
}

/**
 * Display-only progress tint for tracking rows: filled blocks go green, the
 * empty track recedes dim. Whole-character wraps only, so surrounding
 * substrings (issue titles, counts) are never split by escape codes.
 */
function tintProgressBars(line: string): string {
  const c = boardColors;
  if (!line.includes("█") && !line.includes("░")) return line;
  return line.replaceAll("█", c.green("█")).replaceAll("░", c.dim("░"));
}

/**
 * Sanitize the host-supplied project identity for the header.
 * Display data only: single line, bounded, and never a path — a caller that
 * passes one gets its last segment, so a private state root cannot reach the
 * header by accident.
 */
export function sanitizeProjectLabel(label: unknown): string {
  if (typeof label !== "string") return "";
  const flat = label.replace(/[\r\n\t]+/g, " ").trim();
  const tail = flat.includes("/") ? (flat.split("/").filter((part) => part.length > 0).pop() ?? "") : flat;
  return tail.slice(0, 40);
}

/**
 * Sanitize host-supplied tracking lines for the coordinatr window.
 * Display data only (Gitea snapshot text): single-line, bounded, no LF.
 * Control bytes are left for StatusPanel's escapeForDisplay on paint;
 * here we enforce type, length, and row bounds.
 */
export function sanitizeTrackingLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const line of lines.slice(0, PANEL_TRACKING_ROWS)) {
    if (typeof line !== "string") continue;
    out.push(line.replace(/\r?\n/g, " ").slice(0, 240));
  }
  return out;
}

/**
 * Collapsed proqi-style summary of one queued thought: first-line preview plus
 * honest line/char counts. A trailing LF is shown as ⏎ so the exact queued
 * bytes (including a selection's terminator) stay visible on one row.
 */
function summarizeThought(text: string, maxChars = BOARD_PREVIEW_CHARS): { preview: string; suffix: string; lineCount: number; chars: number } {
  const lineCount = physicalLineCount(text);
  const budget = Math.max(8, Math.min(BOARD_PREVIEW_CHARS, Math.trunc(maxChars)));
  const first = text.split("\n")[0] ?? "";
  const preview = first.length === 0
    ? "(blank first line)"
    : first.length > budget
      ? `${first.slice(0, budget - 1)}…`
      : first;
  const extra = lineCount > 1 ? ` +${lineCount - 1} line${lineCount - 1 === 1 ? "" : "s"}` : "";
  const eol = text.endsWith("\n") && text.length > 0 ? " ⏎" : "";
  return { preview, suffix: `${extra}${eol}`, lineCount, chars: text.length };
}

/**
 * Physical line count under the frozen selector's rule: a trailing LF terminates
 * its line and does not open an extra zero-byte line. Counting only; the selector
 * itself is never reimplemented here.
 */
export function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n").length;
  return text.endsWith("\n") ? parts - 1 : parts;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Longest suffix of `text` that is a proper prefix of `marker` (length >= 2). */
function heldMarkerPrefix(text: string, marker: string): string {
  for (let length = Math.min(marker.length - 1, text.length); length >= 2; length--) {
    if (marker.startsWith(text.slice(text.length - length))) return text.slice(text.length - length);
  }
  return "";
}

/** Bound for one bracketed paste body; matches the composer/note buffer bound. */
export const MAX_PASTE_BYTES = 256 * 1024;

/**
 * Bracketed-paste reporting stays enabled so this guard can separate marked paste
 * from ordinary key input, even when markers arrive split across input events.
 * Ordinary key bytes are returned as segments (commands/text); completed paste
 * bodies are returned as pastes for the caller to accept or reject by focus.
 * Partial bodies accumulate until PASTE_END; oversized pastes overflow and are
 * reported as a single oversized body the caller must reject.
 */
export class PasteGuard {
  private inPaste = false;
  private held = "";
  private trailingEscape = false;
  private pasteBuffer = "";
  private pasteOverflow = false;

  get active(): boolean {
    return this.inPaste;
  }

  /**
   * Split one input event into ordinary segments plus completed paste bodies.
   * `sawMarkers` is true when paste markers or an open paste were observed.
   */
  consumeWithPaste(data: string): { segments: string[]; pastes: string[]; sawMarkers: boolean } {
    // A lone ESC is delivered as its own event; it stays a command, but if the rest
    // of a marker follows in the next event those bytes must still be treated as markers.
    let buffer = this.held + (this.trailingEscape && data.startsWith("[") ? "\x1b" : "") + data;
    this.held = "";
    this.trailingEscape = false;
    const segments: string[] = [];
    const pastes: string[] = [];
    let sawMarkers = this.inPaste;

    for (;;) {
      if (this.inPaste) {
        const end = buffer.indexOf(PASTE_END);
        sawMarkers = true;
        if (end === -1) {
          this.held = heldMarkerPrefix(buffer, PASTE_END);
          const part = this.held.length > 0 ? buffer.slice(0, buffer.length - this.held.length) : buffer;
          if (part.length > 0) this.accumulatePaste(part);
          return { segments, pastes, sawMarkers };
        }
        const body = buffer.slice(0, end);
        this.accumulatePaste(body);
        pastes.push(this.takePaste());
        this.inPaste = false;
        buffer = buffer.slice(end + PASTE_END.length);
        continue;
      }
      const start = buffer.indexOf(PASTE_START);
      if (start === -1) break;
      if (start > 0) segments.push(buffer.slice(0, start));
      this.inPaste = true;
      sawMarkers = true;
      buffer = buffer.slice(start + PASTE_START.length);
    }

    this.held = heldMarkerPrefix(buffer, PASTE_START);
    if (this.held.length > 0) buffer = buffer.slice(0, buffer.length - this.held.length);
    this.trailingEscape = buffer.endsWith("\x1b");
    if (buffer.length > 0) segments.push(buffer);
    return { segments, pastes, sawMarkers };
  }

  private accumulatePaste(part: string): void {
    if (this.pasteOverflow) return;
    if (Buffer.byteLength(this.pasteBuffer + part, "utf8") > MAX_PASTE_BYTES) {
      this.pasteOverflow = true;
      return;
    }
    this.pasteBuffer += part;
  }

  private takePaste(): string {
    // Overflow marker: a body the caller must reject as too large. NUL cannot
    // appear in a real paste body after normalization, so it is unambiguous.
    const out = this.pasteOverflow ? "\x00PASTE_TOO_LARGE" : this.pasteBuffer;
    this.pasteBuffer = "";
    this.pasteOverflow = false;
    return out;
  }

  /**
   * Split one input event into ordinary segments, dropping any paste bytes.
   * `dropped` is true when paste markers or paste body bytes were discarded.
   */
  consume(data: string): { segments: string[]; dropped: boolean } {
    const { segments, sawMarkers } = this.consumeWithPaste(data);
    return { segments, dropped: sawMarkers };
  }
}

/** Minimal uncoloured theme; the prototype does not ship a colour scheme. */
const plainEditorTheme: EditorTheme = {
  borderColor: (str: string) => str,
  selectList: {
    selectedPrefix: (str: string) => str,
    selectedText: (str: string) => str,
    description: (str: string) => str,
    scrollInfo: (str: string) => str,
    noMatch: (str: string) => str,
  },
};

/**
 * Every key the companion answers to, per region, with the words the footer
 * has no room for. The `?` reference, the footer tiers, `--help` and the
 * README key table all read from this one list.
 */
export const KEY_REFERENCE: Readonly<Record<SpikeFocus | "global", ReadonlyArray<readonly [string, string]>>> = Object.freeze({
  panel: Object.freeze([
    ["[ ]", "prev / next notebook entry"],
    ["↑↓", "select notebook lines"],
    ["Shift+↑↓", "extend selection"],
    ["Enter", "queue selection"],
    ["S", "queue + review selection"],
    ["E", "copy selection to composer"],
    ["D", "delete selection (y/n)"],
    ["j/k", "focus card"],
    ["Ctrl+J/K", "move card down / up"],
    ["e", "edit card in composer"],
    ["d", "delete card (y/n)"],
    ["s", "review card, then send"],
    ["y", "duplicate card"],
    ["u", "undo card delete"],
    ["x", "clear queue (y/n)"],
    ["n / w", "go to COMPOSE / NOTEBOOK"],
    ["?", "this list"],
  ] as const),
  editor: Object.freeze([
    ["type", "edit the notebook"],
    ["Enter", "new line"],
    ["Ctrl+N", "insert a new note block"],
    ["↑↓ ←→", "move the cursor"],
    ["Home / End", "line start / end"],
  ] as const),
  composer: Object.freeze([
    ["type / paste", "draft a thought"],
    ["Ctrl+S", "queue draft + review"],
    ["Ctrl+E", "queue draft only"],
  ] as const),
  tracking: Object.freeze([
    ["↑↓", "move over tasks"],
    ["PgUp/PgDn", "page over tasks"],
    ["Home / End", "first / last task"],
    ["Enter", "open the task"],
    ["g", "Generate Prompt"],
    ["r", "refresh from tracker"],
    ["c", "Catch-Me-Up: scan tracker, worktrees, handoffs"],
    ["?", "this list"],
    ["Esc", "back to workspace"],
  ] as const),
  global: Object.freeze([
    ["Tab", "next region"],
    ["Ctrl+S", "queue composer + review"],
    ["Ctrl+E", "queue composer"],
    ["Ctrl+U", "clear queue (y/n)"],
    ["Ctrl+O", "project overview"],
    ["Esc", "cancel / back / close"],
    ["Ctrl+C", "quit"],
  ] as const),
});

/** Rows of the `?` reference for one region: a header, then `key  meaning` cells in as many columns as fit. */
export function keyReferenceLines(focus: SpikeFocus, width: number, maxRows: number): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const entries = [...KEY_REFERENCE[focus], ...KEY_REFERENCE.global];
  const keyWidth = Math.max(...entries.map(([key]) => visibleWidth(key)));
  const labelWidth = Math.max(...entries.map(([, label]) => visibleWidth(label)));
  const cell = keyWidth + 2 + labelWidth + 3;
  const columns = Math.max(1, Math.floor((safeWidth - 2) / cell));
  const rows = Math.ceil(entries.length / columns);
  const lines = [truncateToWidth(`  KEYS · ${REGION_NAME[focus]} · any key closes`, safeWidth, "")];
  const budget = Math.max(1, maxRows - 1);
  const shown = rows > budget ? budget - 1 : rows;
  for (let row = 0; row < shown; row++) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column++) {
      const entry = entries[row + column * rows];
      if (entry === undefined) continue;
      const [key, label] = entry;
      cells.push(`${key}${" ".repeat(keyWidth - visibleWidth(key) + 2)}${label}`.padEnd(cell - 1));
    }
    lines.push(truncateToWidth(`  ${cells.join("").trimEnd()}`, safeWidth, ""));
  }
  if (rows > budget) lines.push(truncateToWidth(`  … ${entries.length - shown * columns} more · --help lists every key`, safeWidth, ""));
  return lines;
}

/** Plain-text key list for `--help` and docs, in region order. */
export function keyReferenceText(): string {
  const order: Array<[SpikeFocus | "global", string]> = [
    ["global", "Any region"], ["panel", "QUEUE panel"], ["editor", "NOTEBOOK"], ["composer", "COMPOSE"], ["tracking", "WORKBOARD"],
  ];
  const lines: string[] = [];
  for (const [region, title] of order) {
    lines.push(`  ${title}:`);
    for (const [key, label] of KEY_REFERENCE[region]) lines.push(`    ${key.padEnd(22)}${label}`);
  }
  return lines.join("\n");
}

/**
 * Footer hints per region, richest first. The first tier that fits the width
 * wins, so a narrow frame shortens the wording instead of cutting it mid-word.
 * Every key named here has its meaning next to it; `?` opens the full list.
 */
const HINT_TIERS: Readonly<Record<SpikeFocus, readonly string[]>> = Object.freeze({
  composer: [
    "type or paste · Ctrl+S queues + reviews · Ctrl+E queues only · Tab next region · Esc closes",
    "type/paste · Ctrl+S send · Ctrl+E queue · Tab · Esc",
    "type · Ctrl+S send · Ctrl+E queue · Esc",
  ],
  editor: [
    "type to edit the notebook · Ctrl+N new note · Tab next region · Ctrl+S queues composer + reviews · Ctrl+U clears queue",
    "type to edit · Ctrl+N new note · Tab next region · Ctrl+S send · Ctrl+U clear",
    "edit · Ctrl+N note · Tab · Ctrl+S send",
  ],
  panel: [
    "[ ] entry · ↑↓ lines · Enter queue · S send · E copy · D delete · j/k card · e edit · d delete · s send · ? all keys",
    "[ ] entry · Enter queue · S send · E copy · D delete · j/k card · e edit · d delete · s send · ? keys",
    "[ ] entry · Enter queue · S send · E copy · D delete · j/k card · ? keys",
    "[ ] entry · Enter queue · S send · j/k card · ? keys",
    "Enter queue · S send · j/k · s · ? keys",
  ],
  tracking: [
    "↑↓ move · Enter opens the task · g Generate Prompt · r refresh · ? all keys · Esc back",
    "↑↓ · Enter opens · g generate · r refresh · ? keys · Esc",
    "Enter open · g · r · ? · Esc",
  ],
});

/** Key tokens painted green in hint rows when they stand as their own whitespace-delimited word. */
const KEY_TOKEN = /^(?:Ctrl\+[A-Za-z]|Ctrl\+Enter|Ctrl\+J\/K|Shift\+↑↓|↑↓|←\/→|PgUp|PgDn|PgUp\/PgDn|Enter|Esc|Tab|Home|End|j\/k|n\/w|\[\/\]|\[|\]|\?|[edsxgrwnyuEDS])$/;

/**
 * Paint the key tokens of a hint row green and everything else dim. Operates
 * on the plain, already-fitted line and splits on whitespace only, so no
 * multi-column grapheme is ever cut by an escape code.
 */
export function paintKeyHints(line: string): string {
  const c = boardColors;
  return line
    .split(/(\s+)/)
    .map((part) => (part.length === 0 ? part : KEY_TOKEN.test(part) ? c.green(part) : c.dim(part)))
    .join("");
}

/** Top region: queue, selection preview, focus and notices. Library width utilities only. */
class StatusPanel implements Component {
  private readonly supplier: (width: number) => string[];
  private readonly paint: ((line: string) => string) | undefined;
  constructor(supplier: (width: number) => string[], paint?: (line: string) => string) {
    this.supplier = supplier;
    this.paint = paint;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [];
    return this.supplier(width).map((line) => {
      // Escape + truncate first so painters only ever wrap safe, fitted text.
      const plain = truncateToWidth(escapeForDisplay(line), width, "");
      return this.paint ? this.paint(plain) : plain;
    });
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Plain-text clamp for a row fragment: cuts by visible width and appends `…`.
 * `truncateToWidth(text, w, "…")` may emit an ANSI reset around its ellipsis,
 * which the display escaper would then print as `^[[0m`; fragments here are
 * sanitized plain text, so a code-free clamp is both safe and sufficient.
 */
function clampPlain(text: string, max: number): string {
  const limit = Math.max(1, Math.trunc(max));
  if (visibleWidth(text) <= limit) return text;
  let out = "";
  let used = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const w = visibleWidth(segment);
    if (used + w > limit - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

/**
 * Narrowest width at which pi-tui's Editor can wrap `text` without crashing.
 *
 * Measured defect in @earendil-works/pi-tui 0.85.0: wordWrapLine() recurses on a
 * grapheme wider than the wrap width and never terminates, so a 2-column glyph
 * throws RangeError at width 1-2. Accepted text is single-column ASCII, so this
 * guard is defensive only.
 */
export function minimumSafeEditorWidth(text: string): number {
  let widest = 1;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    widest = Math.max(widest, visibleWidth(segment));
  }
  return widest === 1 ? 1 : widest + 1;
}

/**
 * An Editor whose own top border is its region's label rule, so a region name
 * is literally the top edge of the content it names: no separate label row and
 * no rule stacked on a rule. The bottom edge stays blank (a calm gap between
 * regions) unless it has something honest to say — `↓ n more` hidden below, or
 * a closing rule for the region that owns the frame's spare height.
 *
 * `borderColor` is the library's per-instance focus hook, so the focused
 * region's label glows accent while the idle ones recede, for free.
 */
class LabelledEditor extends Editor {
  private label: (width: number) => string = () => "";
  private closeBottom = false;
  /** Lines scrolled above the viewport at the last render (the top border is told this count). */
  private hiddenAbove = 0;
  private pendingReveal: SpikeSelection | undefined = undefined;
  /**
   * 1-based physical lines painted inverse. The companion refuses to render a
   * notebook narrower than its longest line (EditorRegion), so the library
   * never wraps here and each text row is exactly one physical line.
   */
  highlight: SpikeSelection | undefined = undefined;

  setRegionLabel(label: (width: number) => string, closeBottom: boolean): void {
    this.label = label;
    this.closeBottom = closeBottom;
  }

  override render(width: number): string[] {
    const reveal = this.pendingReveal;
    if (reveal !== undefined) {
      // Visit the last line so the library scrolls to it, then the first, so
      // the entry shows from its start (or fills the viewport when longer).
      this.pendingReveal = undefined;
      this.moveCursorToLine(reveal.endLine);
      super.render(width);
      this.moveCursorToLine(reveal.startLine);
    }
    const rows = super.render(width);
    const range = this.highlight;
    if (range === undefined || rows.length < 3) return rows;
    return rows.map((row, index) => {
      if (index === 0 || index === rows.length - 1) return row;
      const line = this.hiddenAbove + index;
      if (line < range.startLine || line > range.endLine) return row;
      // The library's fake cursor ends with a reset; keep the row inverse after it.
      return boardColors.inverse(row.split("\x1b[0m").join("\x1b[0m\x1b[7m"));
    });
  }

  /** Ask the next render to scroll so `startLine..endLine` shows from its first line. */
  revealLines(startLine: number, endLine: number): void {
    this.pendingReveal = { startLine, endLine };
  }

  private moveCursorToLine(line: number): void {
    const target = Math.max(0, line - 1);
    for (let guard = 0; guard < 100000; guard++) {
      const current = this.getCursor().line;
      if (current === target) break;
      this.handleInput(current < target ? "\x1b[B" : "\x1b[A");
      if (this.getCursor().line === current) break;
    }
    this.handleInput("\x1b[H");
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    this.hiddenAbove = hiddenLineCount;
    const more = hiddenLineCount > 0 ? ` · ↑ ${hiddenLineCount} more` : "";
    return this.borderColor(truncateToWidth(sectionRule(`${this.label(width)}${more}`, width), width, ""));
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (hiddenLineCount > 0) {
      return boardColors.dim(truncateToWidth(sectionRule(`↓ ${hiddenLineCount} more`, width), width, ""));
    }
    return this.closeBottom ? boardColors.muted("─".repeat(Math.max(1, Math.trunc(width)))) : "";
  }
}

/**
 * Wraps the library Editor so a too-narrow viewport shows a notice instead of
 * crashing, and so a region that owns spare height renders as one surface.
 *
 * `fillRows` (when given) is the row budget the layout will hand this region.
 * The editor is asked for its text first; any leftover rows are added *before*
 * the editor's bottom border, so the region reads as a bordered writing area
 * ending where the region ends, instead of a short box followed by a hole.
 */
class EditorRegion implements Component {
  private readonly editor: Editor;
  private readonly label: string;
  private readonly fillRows: ((width: number) => number) | undefined;

  constructor(editor: Editor, label: string, fillRows?: (width: number) => number) {
    this.editor = editor;
    this.label = label;
    this.fillRows = fillRows;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    // Resolve the budget before rendering: the editor reads its visible-line
    // cap from the viewport-scoped TUI, which is derived from this same budget.
    const target = this.fillRows?.(width) ?? 0;
    if (width < minimumSafeEditorWidth(this.editor.getText())) {
      return [truncateToWidth(`${this.label}: viewport too narrow`, width, "")];
    }
    const rows = this.editor.render(width);
    if (target <= rows.length || rows.length < 2) return rows;
    const last = rows[rows.length - 1] ?? "";
    return [...rows.slice(0, -1), ...Array.from({ length: target - rows.length }, () => ""), last];
  }
}

export class CompanionSpikeView {
  private readonly tui: TUI;
  private readonly panel: StatusPanel;
  private readonly trackingPanel: StatusPanel;
  private readonly editor: LabelledEditor;
  private readonly composer: LabelledEditor;
  private readonly composerRegion: EditorRegion;
  private readonly pasteGuard = new PasteGuard();
  /** Short project identity for the header; never a filesystem path. */
  private readonly projectLabel: string;
  /** Frame height last requested through renderFrame(); the layout root falls back to the terminal. */
  private frameRows: number | undefined = undefined;
  /** Width the notebook region is currently rendering at, for its viewport-scoped TUI. */
  private notebookWidth = 80;
  /** Memoized notebook row budget; recomputed whenever the frame is resized. */
  private notebookBudget: { width: number; height: number; rows: number } | undefined = undefined;
  private queue: PendingQueue = emptyQueue();
  private documentRevision = 0;
  private focusTarget: SpikeFocus = "editor";
  private selection: SpikeSelection = { startLine: 1, endLine: 1 };
  private notice = "ready - this prototype stores nothing";
  private confirmingQuit = false;
  private confirmingClear = false;
  private clearCount = 0;
  /** Card delete confirmation: the 0-based queue index armed for `d`. */
  private confirmingDelete: number | undefined = undefined;
  /** Notebook entry delete confirmation: the physical line range armed for `D`. */
  private confirmingEntryDelete: SpikeSelection | undefined = undefined;
  /** `?` key reference shown in place of the queue cards until the next key. */
  private helpVisible = false;
  /** Last confirmed single-card deletion. Session-only and consumed only by a successful restore. */
  private deleteUndo: RemovedItem | undefined = undefined;
  private exitRequested = false;
  private reviewRequested = false;
  private overviewRequested = false;
  private readonly overviewNavigation: boolean;
  private readonly trackingNavigation: boolean;
  /** Where Escape from the tracking region returns focus to. Never an exit. */
  private trackingReturnFocus: SpikeFocus = "editor";
  /** Pending navigation intents for the host, oldest first. */
  private readonly trackingIntents: TrackingIntent[] = [];
  /** One host-supplied row naming the current selection. Display only (legacy, no-navigation views). */
  private trackingSelectionLine = "";
  /** Live workboard for the navigable tracking region. Display only; Gitea stays authoritative. */
  private board: WorkBoard | undefined = undefined;
  /** Short host status appended to the tracking rule (`refreshing…`, `offline · cached 11h ago`). */
  private boardNote = "";
  /** Display cursor over the board's issue rows, kept by issue number across setWorkBoard. */
  private boardCursorNumber: number | undefined = undefined;
  /** First board row currently scrolled into view. */
  private boardWindowStart = 0;
  /** Board rows shown by the last render, for PgUp/PgDn paging. */
  private boardWindowSize = 1;
  /** Header fragments set by the host (git state, Pi state). */
  private headerStatus: { git: string; pi: string; ok: string } = { git: "", pi: "", ok: "" };
  /** Board cursor: which collapsed thought card j/k focus. Ephemeral, never persisted. */
  private focusedQueue = 0;
  /** Queue index the operator asked to submit (panel `s`); read once per review. */
  private reviewIndex: number | undefined = undefined;
  private readonly hosted: boolean;
  /** Omakase-adapted tracking display lines (Gitea snapshot text from host). */
  private trackingLines: string[];

  /** Layout root for TuiAltScreen.setLayoutRoot(). */
  readonly layoutRoot: Component;

  constructor(tui: TUI, options: CompanionSpikeViewOptions) {
    this.tui = tui;
    this.hosted = options.hosted ?? false;
    this.overviewNavigation = options.overviewNavigation ?? false;
    this.trackingNavigation = options.trackingNavigation ?? false;
    this.projectLabel = sanitizeProjectLabel(options.projectLabel);
    this.trackingLines = sanitizeTrackingLines(options.trackingLines);
    const state = options.sessionState;
    const noteText = assertSupportedText(state?.noteText ?? options.noteText, "noteText", state !== undefined);
    this.panel = new StatusPanel((width) => this.buildPanelLines(width), (line) => this.paintPanelLine(line));
    this.trackingPanel = new StatusPanel((width) => this.buildTrackingLines(width), (line) => this.paintTrackingLine(line));
    // The notebook owns whatever height the other regions do not need, so its
    // editor is scoped to a TUI that reports the rows that budget implies.
    this.editor = new LabelledEditor(
      viewportScopedTui(tui, () => rowsForVisibleLines(this.notebookTargetRows(this.notebookWidth) - 2)),
      plainEditorTheme,
    );
    this.editor.setRegionLabel((width) => this.notebookLabel(width), true);
    this.editor.disableSubmit = true;
    this.editor.setText(noteText);
    // The composer stays a compact drafting strip: a long draft scrolls inside
    // it rather than pushing the notebook off the frame.
    this.composer = new LabelledEditor(
      viewportScopedTui(tui, () => rowsForVisibleLines(COMPOSER_VISIBLE_LINES)),
      plainEditorTheme,
    );
    this.composer.setRegionLabel((width) => this.composeLabel(width), false);
    this.composer.disableSubmit = true;
    this.composerRegion = new EditorRegion(this.composer, "COMPOSE");
    if (state) {
      this.composer.setText(assertSupportedText(state.composerText, "composerText", true));
      this.queue = state.queue;
      this.documentRevision = state.documentRevision;
      this.selection = { ...state.selection };
    }
    // Board cursor starts on the newest thought, like a proqi board.
    this.focusedQueue = Math.max(0, this.queue.items.length - 1);
    // Top to bottom: identity + queue, then each region's label immediately
    // above the content it names, then read-only tracking, then the footer.
    // Shrink weights order what yields first when the frame gets short:
    // tracking, then the queue and composer, and the footer never shrinks.
    this.layoutRoot = new VStack([
      {
        component: new ScrollView(this.panel, { follow: "none", primary: true }),
        basis: "auto",
        shrink: 2,
        minSize: 1,
      },
      { component: this.composerRegion, basis: "auto", shrink: 2, minSize: 1 },
      // The notebook absorbs leftover height and fills it with editable rows.
      {
        component: new EditorRegion(this.editor, "NOTEBOOK", (width) => this.planNotebookRows(width)),
        basis: 0,
        grow: 1,
        shrink: 1,
        minSize: MIN_NOTEBOOK_ROWS,
      },
      // Read-only project tracking keeps its own region so the queue above stays
      // about queued thoughts, not milestone numbers. First to yield when short.
      {
        component: new ScrollView(this.trackingPanel, { follow: "none" }),
        basis: "auto",
        shrink: 3,
        minSize: 0,
      },
      // Focus, notice and context hints never shrink: the line that says what
      // just happened and which keys apply must survive every frame size.
      { component: new StatusPanel((width) => this.buildStatusLines(width), (line) => this.paintStatusLine(line)), basis: "auto", shrink: 0, minSize: 2 },
    ]);
    this.setFocus(state?.focus ?? "editor");
  }

  snapshot(): CompanionSessionState {
    return {
      noteText: this.getNoteText(), composerText: this.getComposerText(),
      queue: this.queue, documentRevision: this.documentRevision,
      selection: { ...this.getSelection() }, focus: this.focus,
    };
  }

  getOverviewRequested(): boolean { return this.overviewRequested; }
  consumeOverviewRequest(): boolean { const requested = this.overviewRequested; this.overviewRequested = false; return requested; }

  getReviewRequested(): boolean { return this.reviewRequested; }

  /**
   * Queue index chosen for submission via panel `s`, if any. The host reads
   * this once when review is requested and submits that thought to the main
   * session after the single review-and-confirm dialog. Undefined means the
   * standard flow (single item, else picker).
   */
  getReviewIndex(): number | undefined { return this.reviewIndex; }

  /** Proqi-style board cursor: which collapsed thought card is focused. */
  getFocusedQueue(): number {
    return this.clampQueueFocus();
  }

  private clampQueueFocus(): number {
    const count = this.queue.items.length;
    if (count === 0) return 0;
    return Math.min(Math.max(0, this.focusedQueue), count - 1);
  }

  private moveQueueFocus(delta: number): void {
    const count = this.queue.items.length;
    if (count === 0) {
      this.notice = "queue is empty — Tab to COMPOSE and type the first thought";
      return;
    }
    this.focusedQueue = Math.min(count - 1, Math.max(0, this.clampQueueFocus() + delta));
    this.notice = `thought ${this.focusedQueue + 1}/${count} focused · s reviews it for the main session · Ctrl+S reviews the queue`;
  }

  /** Host-set header fragments. Empty parts are omitted from the header. */
  setHeaderStatus(status: { git?: string; pi?: string; ok?: string }): void {
    const flat = (value: unknown): string =>
      typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60) : "";
    this.headerStatus = { git: flat(status?.git), pi: flat(status?.pi), ok: flat(status?.ok) };
    this.invalidateLayoutBudget();
  }

  /**
   * Replace the navigable workboard. The cursor survives by issue number and
   * falls back to the first issue row. `note` is a short host status shown on
   * the region rule (`refreshing…`, `offline · cached 11h ago`).
   */
  setWorkBoard(board: WorkBoard | undefined, note?: string): void {
    this.board = board;
    this.boardNote = typeof note === "string" ? note.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) : "";
    const issues = this.boardIssueIndexes();
    const keep = issues.find((row) => this.issueAt(row)?.number === this.boardCursorNumber);
    const first = issues[0];
    this.boardCursorNumber = keep !== undefined
      ? this.boardCursorNumber
      : first !== undefined ? this.issueAt(first)?.number : undefined;
    this.invalidateLayoutBudget();
  }

  getWorkBoard(): WorkBoard | undefined {
    return this.board;
  }

  /** The issue under the workboard cursor, if the board has any issue rows. */
  getBoardCursor(): BoardIssue | undefined {
    const row = this.boardCursorRow();
    return row === undefined ? undefined : this.issueAt(row);
  }

  private boardRows(): readonly BoardRow[] {
    return this.board?.rows ?? [];
  }

  private issueAt(row: number): BoardIssue | undefined {
    const entry = this.boardRows()[row];
    return entry?.kind === "issue" ? entry.issue : undefined;
  }

  /** Row indexes of issue rows only: map and heading rows are never a cursor stop. */
  private boardIssueIndexes(): number[] {
    const out: number[] = [];
    this.boardRows().forEach((row, index) => {
      if (row.kind === "issue") out.push(index);
    });
    return out;
  }

  /** Row index of the cursor issue; repairs a cursor whose issue left the board. */
  private boardCursorRow(): number | undefined {
    const issues = this.boardIssueIndexes();
    if (issues.length === 0) return undefined;
    const found = issues.find((row) => this.issueAt(row)?.number === this.boardCursorNumber);
    if (found !== undefined) return found;
    const first = issues[0] as number;
    this.boardCursorNumber = this.issueAt(first)?.number;
    return first;
  }

  private moveBoardCursor(delta: number): void {
    const issues = this.boardIssueIndexes();
    const current = this.boardCursorRow();
    if (current === undefined) {
      this.notice = this.board ? "workboard has no open tasks" : "no workboard yet · r refreshes";
      return;
    }
    const position = issues.indexOf(current);
    const next = Math.min(issues.length - 1, Math.max(0, position + delta));
    const issue = this.issueAt(issues[next] as number);
    this.boardCursorNumber = issue?.number;
    if (issue) this.notice = `#${issue.number} ${issue.status === "unknown" ? "?" : issue.status} · ${issue.title}`;
  }

  private jumpBoardCursor(where: "home" | "end"): void {
    const issues = this.boardIssueIndexes();
    if (issues.length === 0) return this.moveBoardCursor(0);
    const row = where === "home" ? (issues[0] as number) : (issues[issues.length - 1] as number);
    const issue = this.issueAt(row);
    this.boardCursorNumber = issue?.number;
    if (issue) this.notice = `#${issue.number} ${issue.status === "unknown" ? "?" : issue.status} · ${issue.title}`;
  }

  /** Replace the coordinatr-window tracking display (Gitea snapshot text). */
  setTrackingLines(lines: string[]): void {
    this.trackingLines = sanitizeTrackingLines(lines);
    this.invalidateLayoutBudget();
  }

  getTrackingLines(): readonly string[] {
    return this.trackingLines;
  }

  /**
   * One row describing the host's current tracking selection (`#1 title ·
   * open · read 2m ago`). The view never derives this from `trackingLines`:
   * those are a capped compact summary, not the task list.
   */
  setTrackingSelectionLine(line: string): void {
    this.trackingSelectionLine = sanitizeTrackingLines([line])[0] ?? "";
    this.invalidateLayoutBudget();
  }

  /** True when the host enabled structured tracking navigation. */
  hasTrackingNavigation(): boolean {
    return this.trackingNavigation;
  }

  /** Take the oldest pending navigation intent, if any. */
  consumeTrackingIntent(): TrackingIntent | undefined {
    return this.trackingIntents.shift();
  }

  get focus(): SpikeFocus {
    return this.focusTarget;
  }

  setFocus(focus: SpikeFocus): void {
    this.invalidateLayoutBudget();
    // Without the navigation option there is no tracking region to focus, so
    // the request lands on the notebook rather than on a focus that renders
    // nothing and traps Tab.
    const target: SpikeFocus = focus === "tracking" && !this.trackingNavigation ? "editor" : focus;
    if (target === "tracking" && this.focusTarget !== "tracking") this.trackingReturnFocus = this.focusTarget;
    this.focusTarget = target;
    this.editor.focused = target === "editor";
    this.composer.focused = target === "composer";
    // Section definition: the focused editor's top/bottom rules glow accent
    // while the idle one recedes to muted. Border color is live per instance.
    this.editor.borderColor = target === "editor" ? boardColors.accentBold : boardColors.muted;
    this.composer.borderColor = target === "composer" ? boardColors.accentBold : boardColors.muted;
    this.syncHighlight();
  }

  /** Full note text. Paste markers cannot exist here; expansion is defensive. */
  getNoteText(): string {
    return this.editor.getExpandedText();
  }

  /**
   * Host-driven enqueue of a thought that arrived from outside the TUI (the
   * OpenKnowledge inbox). `origin` becomes the card badge (`[web]`). Refuses
   * unsupported or empty text and reports through the notice; never sends.
   */
  enqueueExternalText(text: string, origin: string): boolean {
    if (text.length === 0 || !isSupportedText(text)) {
      this.notice = `${origin} thought refused: unsupported characters or empty text`;
      return false;
    }
    if (!this.pushToQueue(text, undefined, origin)) return false;
    this.notice = `${origin} thought queued as ${this.queue.items.length} — Ctrl+S reviews it`;
    return true;
  }

  /** Card badge for a queue index: `[web] ` for browser-inbox thoughts, else empty. */
  private cardBadge(index: number): string {
    const origin = this.queue.items[index]?.origin;
    return origin === undefined ? "" : `[${origin}] `;
  }

  /**
   * Host-driven composer replacement (generator output). Only replaces when the
   * composer still holds exactly `expected` (the user has not edited it);
   * returns false and changes nothing otherwise or when the text is unsupported.
   */
  replaceComposerText(expected: string, next: string): boolean {
    if (this.getComposerText() !== expected || !isSupportedText(next)) return false;
    this.composer.setText(next);
    this.reviewIndex = undefined;
    this.setFocus("composer");
    return true;
  }

  /** Restore only an untouched initial notebook; even edit-then-undo counts as edited. */
  restoreNotebook(expected: string, next: string): boolean {
    if (this.documentRevision !== 0 || this.getNoteText() !== expected || !isSupportedText(next)) return false;
    this.editor.setText(next);
    this.documentRevision += 1;
    this.selection = { startLine: 1, endLine: 1 };
    this.invalidateLayoutBudget();
    return true;
  }

  getComposerText(): string {
    return this.composer.getExpandedText();
  }

  /** The selection actually in effect: always in range for the current note. */
  getSelection(): SpikeSelection {
    return this.clampSelection();
  }

  /** Exact selected lines, including each line's own terminator, from the frozen selector. */
  getSelectedText(): string {
    const note = this.getNoteText();
    if (physicalLineCount(note) === 0) return "";
    const { startLine, endLine } = this.clampSelection();
    return selectLines(note, startLine, endLine).text;
  }

  /** Text adapter over the in-process queue items; the queue itself stays authoritative. */
  getMockQueue(): readonly string[] {
    return Object.freeze(this.queue.items.map((item) => item.text));
  }

  getNotice(): string {
    return this.notice;
  }

  /** Host-set notice (send results, external sync). Never touches buffers/queue. */
  setNotice(text: string): void {
    this.notice = text.length > 0 ? text.slice(0, 300) : "ready";
    this.invalidateLayoutBudget();
  }

  /** True once the operator confirmed the discard prompt. The CLI exits only then. */
  getExitRequested(): boolean {
    return this.exitRequested;
  }

  /** True while the Ctrl+C discard confirmation is open. */
  isConfirmingQuit(): boolean {
    return this.confirmingQuit;
  }

  /** True while the Clear Queue confirmation is open. */
  isConfirmingClear(): boolean {
    return this.confirmingClear;
  }

  /**
   * Consume a pending review request (Ctrl+S or panel `s`).
   * Returns the focused queue index when the operator chose a specific
   * thought via panel `s`, or undefined for the standard flow (single item
   * skips the picker, else the host shows the picker). Resets the flag so a
   * long-lived view (coordinatr window) can request review more than once.
   */
  consumeReviewRequest(): number | undefined {
    if (!this.reviewRequested) return undefined;
    const index = this.reviewIndex;
    this.reviewRequested = false;
    this.reviewIndex = undefined;
    return index;
  }

  /** Peek without consuming (Pi-hosted loop uses get + consume separately). */
  peekReviewIndex(): number | undefined {
    return this.reviewRequested ? this.reviewIndex : undefined;
  }

  /**
   * Drop the memoized notebook budget. Called from every entry point that can
   * change a region's height (input, notice, tracking snapshot, focus) so the
   * notebook is re-measured before the next frame instead of one frame late.
   */
  private invalidateLayoutBudget(): void {
    this.notebookBudget = undefined;
  }

  /** Single input entry point. Returns true when the view consumed the data. */
  handleInput(data: string): boolean {
    this.invalidateLayoutBudget();
    if (typeof data !== "string" || data.length === 0) return false;
    // Pi normally filters Kitty releases for components that do not opt in.
    // Keep direct/embedded callers safe too: a release must never repeat an action.
    if (isKeyRelease(data)) return true;
    const { segments, pastes, sawMarkers } = this.pasteGuard.consumeWithPaste(data);
    let consumed = false;
    for (const paste of pastes) {
      this.handlePaste(paste);
      consumed = true;
    }
    if (sawMarkers && pastes.length === 0 && this.pasteGuard.active) {
      // Paste still arriving across events; hold without a rejection notice.
      consumed = true;
    } else if (sawMarkers && pastes.length === 0) {
      this.notice = "paste lands in the composer or the notebook; Tab to one of them, then paste";
      consumed = true;
    }
    for (const segment of segments) {
      if (this.handleSegment(segment)) consumed = true;
    }
    return consumed;
  }

  /** Insert a completed bracketed paste into the focused composer or notebook; reject elsewhere. */
  private handlePaste(body: string): void {
    if (body === "\x00PASTE_TOO_LARGE") {
      this.notice = "paste too large; nothing was inserted";
      return;
    }
    if (this.confirmingQuit || this.confirmingClear || this.confirmingDelete !== undefined || this.confirmingEntryDelete !== undefined) {
      this.notice = "paste ignored while a confirm asks y/n";
      return;
    }
    if (this.focusTarget !== "composer" && this.focusTarget !== "editor") {
      this.notice = "paste lands in the composer or the notebook; Tab to one of them, then paste";
      return;
    }
    const target = this.focusTarget === "composer" ? this.composer : this.editor;
    const where = this.focusTarget === "composer" ? "composer" : "notebook";
    // Normalize without silently changing meaning: CRLF/CR become LF, tabs
    // become two spaces (Tab is the focus key), other C0 controls are stripped.
    const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "  ").replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    if (normalized.length === 0) {
      this.notice = "paste had no insertable text; nothing was inserted";
      return;
    }
    if (Buffer.byteLength(this.textOf(target), "utf8") + Buffer.byteLength(normalized, "utf8") > MAX_BUFFER_BYTES) {
      this.notice = `${where} is full at ${MAX_BUFFER_BYTES / 1024} KiB; nothing was inserted`;
      return;
    }
    const before = this.textOf(target);
    target.insertTextAtCursor(normalized);
    if (this.textOf(target) === before) {
      this.notice = "paste was not inserted by the editor; nothing changed";
      return;
    }
    if (target === this.editor) {
      this.documentRevision += 1;
      this.notice = `pasted ${normalized.length} chars into the notebook (${this.hosted ? "saved" : "in memory only"})`;
    } else {
      this.notice = `pasted ${normalized.length} chars into composer; Ctrl+S queues + reviews`;
    }
  }

  private handleSegment(data: string): boolean {
    if (this.confirmingDelete !== undefined) return this.handleDeleteConfirmation(data);
    if (this.confirmingEntryDelete !== undefined) return this.handleEntryDeleteConfirmation(data);
    if (this.helpVisible) {
      // The reference closes on any key; `?` and Esc do nothing else, other keys act as usual.
      this.helpVisible = false;
      this.invalidateLayoutBudget();
      if (data === "?" || matchesKey(data, "escape")) { this.notice = "key reference closed"; return true; }
    }
    if (this.confirmingClear) return this.handleClearConfirmation(data);
    if (this.confirmingQuit) return this.handleQuitConfirmation(data);
    if (this.overviewNavigation && matchesKey(data, "ctrl+o")) {
      this.overviewRequested = true;
      return true;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.requestClearQueue();
      return true;
    }
    if (this.hosted && matchesKey(data, "ctrl+s")) {
      // Composer combo: Ctrl+S queues a non-empty composer first, then reviews.
      // This collapses Ctrl+E + Ctrl+S into one key for the common case.
      const composer = this.getComposerText();
      if (composer.length > 0) this.enqueueComposer();
      this.reviewRequested = true;
      return true;
    }
    // Escape in the tracking region steps back to the workspace. Leaving the
    // companion from here would discard the focus the operator came from.
    if (this.focusTarget === "tracking" && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
      const back = this.trackingReturnFocus === "tracking" ? "editor" : this.trackingReturnFocus;
      this.setFocus(back);
      this.notice = `focus: ${REGION_NAME[back]} · tracking left open, nothing changed`;
      return true;
    }
    if (this.hosted && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
      this.exitRequested = true;
      return true;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.confirmingQuit = true;
      this.notice = QUIT_PROMPT;
      return true;
    }
    if (matchesKey(data, "tab")) {
      const order: SpikeFocus[] = this.trackingNavigation
        ? ["editor", "panel", "composer", "tracking"]
        : ["editor", "panel", "composer"];
      const next = order[(order.indexOf(this.focusTarget) + 1) % order.length] ?? "editor";
      this.setFocus(next);
      this.notice = `focus: ${REGION_NAME[next]}`;
      return true;
    }
    if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+e")) {
      this.enqueueComposer();
      return true;
    }
    if (this.focusTarget === "tracking") return this.handleTrackingInput(data);
    if (this.focusTarget === "panel") return this.handlePanelInput(data);
    return this.handleTextInput(data, this.focusTarget === "composer" ? this.composer : this.editor);
  }

  /**
   * Tracking region keys. Every one of them records an intent for the host
   * and changes nothing else: this region reads Gitea, so the view must not
   * pretend to move through data it does not own.
   */
  private handleTrackingInput(data: string): boolean {
    const page = Math.max(1, this.boardWindowSize);
    if (matchesKey(data, "up")) this.moveBoardCursor(-1);
    else if (matchesKey(data, "down")) this.moveBoardCursor(1);
    else if (matchesKey(data, "pageUp")) this.moveBoardCursor(-page);
    else if (matchesKey(data, "pageDown")) this.moveBoardCursor(page);
    else if (matchesKey(data, "home")) this.jumpBoardCursor("home");
    else if (matchesKey(data, "end")) this.jumpBoardCursor("end");
    else if (matchesKey(data, "enter") || data === "g" || data === "G") {
      const issue = this.getBoardCursor();
      if (!issue) this.notice = this.board ? "workboard has no open tasks" : "no workboard yet · r refreshes";
      else this.pushTrackingIntent(matchesKey(data, "enter") ? { kind: "open", issue } : { kind: "generate", issue });
    } else if (data === "r" || data === "R") this.pushTrackingIntent({ kind: "refresh" });
    else if (data === "?") this.showHelp();
    else this.notice = `TRACKING ignores ${escapeForDisplay(data)} — ? lists the keys`;
    return true;
  }

  private pushTrackingIntent(intent: TrackingIntent): void {
    // Bounded: a held key must not build an unbounded backlog of reads.
    if (this.trackingIntents.length >= 8) this.trackingIntents.shift();
    this.trackingIntents.push(intent);
  }

  private handleClearConfirmation(data: string): boolean {
    if (data === "y" || data === "Y") {
      const cleared = this.clearCount;
      try {
        this.queue = clearQueue(this.queue);
        this.deleteUndo = undefined;
        this.focusedQueue = 0;
        this.reviewIndex = undefined;
        this.notice = cleared === 0
          ? "queue already empty — nothing cleared"
          : `cleared ${cleared} queued item${cleared === 1 ? "" : "s"} — composer and note kept`;
      } catch (error) {
        this.notice = `clear failed: ${(error as Error).message}`;
      }
      this.confirmingClear = false;
      this.clearCount = 0;
    } else if (data === "n" || data === "N" || matchesKey(data, "escape")) {
      this.confirmingClear = false;
      this.clearCount = 0;
      this.notice = "clear cancelled; queue kept";
    } else {
      this.notice = `${CLEAR_PROMPT(this.clearCount)} (unrecognised answer)`;
    }
    return true;
  }

  private handleDeleteConfirmation(data: string): boolean {
    const index = this.confirmingDelete as number;
    if (data === "y" || data === "Y") {
      const item = this.queue.items[index];
      try {
        if (item === undefined) {
          this.notice = "delete skipped — that thought is no longer queued";
        } else {
          const removed = removeItemWithUndo(this.queue, item.id);
          this.queue = removed.queue;
          if (removed.undo !== undefined) this.deleteUndo = removed.undo;
          this.notice = `deleted thought ${index + 1} — ${this.queue.items.length} queued`;
        }
        this.focusedQueue = this.clampQueueFocus();
        this.reviewIndex = undefined;
      } catch (error) {
        this.notice = `delete failed: ${(error as Error).message}`;
      }
      this.confirmingDelete = undefined;
    } else if (data === "n" || data === "N" || matchesKey(data, "escape")) {
      this.confirmingDelete = undefined;
      this.notice = "delete cancelled; thought kept";
    } else {
      this.notice = `${DELETE_PROMPT(index + 1)} (unrecognised answer)`;
    }
    return true;
  }

  private moveFocusedItem(delta: -1 | 1): void {
    const item = this.queue.items[this.clampQueueFocus()];
    if (item === undefined) {
      this.notice = "queue is empty — nothing to move";
      return;
    }
    const before = this.queue;
    try {
      this.queue = moveItem(before, item.id, delta);
      this.focusedQueue = this.queue.items.findIndex((entry) => entry.id === item.id);
      this.notice = this.queue.revision === before.revision
        ? `thought ${this.focusedQueue + 1} is already at the ${delta < 0 ? "top" : "bottom"}`
        : `moved thought to ${this.focusedQueue + 1}/${this.queue.items.length}`;
      this.reviewIndex = undefined;
    } catch (error) {
      this.notice = `move failed: ${(error as Error).message}`;
    }
  }

  private duplicateFocused(): void {
    const sourceIndex = this.clampQueueFocus();
    const item = this.queue.items[sourceIndex];
    if (item === undefined) {
      this.notice = "queue is empty — nothing to duplicate";
      return;
    }
    try {
      this.queue = duplicateItem(this.queue, item.id, randomUUID());
      this.focusedQueue = sourceIndex + 1;
      this.reviewIndex = undefined;
      this.notice = `duplicated thought ${sourceIndex + 1} as ${sourceIndex + 2}`;
    } catch (error) {
      this.notice = `duplicate failed: ${(error as Error).message}`;
    }
  }

  private restoreDeleted(): void {
    if (this.deleteUndo === undefined) {
      this.notice = "nothing to undo — delete a thought first";
      return;
    }
    try {
      const restoredId = this.deleteUndo.item.id;
      this.queue = restoreItem(this.queue, this.deleteUndo);
      this.focusedQueue = Math.max(0, this.queue.items.findIndex((item) => item.id === restoredId));
      this.deleteUndo = undefined;
      this.reviewIndex = undefined;
      this.notice = `restored thought ${this.focusedQueue + 1} — ${this.queue.items.length} queued`;
    } catch {
      this.notice = "undo failed — queue is full or identity conflicts; deleted thought kept for retry";
    }
  }

  /** `d` on a card: arm the y/n confirmation, same pattern as Clear Queue. */
  private requestDeleteFocused(): void {
    if (this.queue.items.length === 0) {
      this.notice = "queue is empty — nothing to delete";
      return;
    }
    const index = this.clampQueueFocus();
    this.confirmingDelete = index;
    this.notice = DELETE_PROMPT(index + 1);
  }

  /**
   * `e` on a card: move its exact text back into the composer for editing.
   * Refused while the composer holds a draft, so no text is ever overwritten.
   */
  private editFocused(): void {
    if (this.queue.items.length === 0) {
      this.notice = "queue is empty — nothing to edit";
      return;
    }
    if (this.getComposerText().length > 0) {
      this.notice = EDIT_REFUSAL;
      return;
    }
    const index = this.clampQueueFocus();
    const item = this.queue.items[index];
    if (item === undefined) return;
    try {
      this.queue = removeItem(this.queue, item.id);
    } catch (error) {
      this.notice = `edit failed: ${(error as Error).message}`;
      return;
    }
    this.composer.setText(item.text);
    this.focusedQueue = this.clampQueueFocus();
    this.reviewIndex = undefined;
    this.setFocus("composer");
    this.notice = `editing thought ${index + 1} — Ctrl+S queues + reviews`;
  }

  /** Arm the Clear Queue confirmation. Works in hosted and standalone views. */
  private requestClearQueue(): void {
    if (this.confirmingQuit) {
      this.notice = "quit asks first — answer y/n before clearing";
      return;
    }
    const count = this.queue.items.length;
    if (count === 0) {
      this.notice = "queue already empty — nothing to clear";
      return;
    }
    this.confirmingClear = true;
    this.clearCount = count;
    this.notice = CLEAR_PROMPT(count);
  }

  private handleQuitConfirmation(data: string): boolean {
    if (data === "y" || data === "Y") {
      this.exitRequested = true;
      this.notice = "quitting; the note, composer and queue are discarded";
    } else if (data === "n" || data === "N" || matchesKey(data, "escape")) {
      this.confirmingQuit = false;
      this.notice = "quit cancelled; nothing was discarded";
    } else {
      this.notice = `${QUIT_PROMPT} (unrecognised answer)`;
    }
    return true;
  }

  private handlePanelInput(data: string): boolean {
    const lineCount = physicalLineCount(this.getNoteText());
    const sel = this.clampSelection();
    if (matchesKey(data, "up")) {
      const start = Math.max(1, sel.startLine - 1);
      this.selection = { startLine: start, endLine: Math.max(start, sel.endLine - 1) };
    } else if (matchesKey(data, "down")) {
      const end = Math.min(Math.max(1, lineCount), sel.endLine + 1);
      this.selection = { startLine: Math.min(sel.startLine + 1, end), endLine: end };
    } else if (matchesKey(data, "shift+up")) {
      this.selection = { startLine: sel.startLine, endLine: Math.max(sel.startLine, sel.endLine - 1) };
    } else if (matchesKey(data, "shift+down")) {
      this.selection = { startLine: sel.startLine, endLine: Math.min(Math.max(1, lineCount), sel.endLine + 1) };
    } else if (matchesKey(data, "enter")) {
      this.enqueueSelection();
    } else if (data === "[" || data === "]") {
      this.stepNotebookEntry(data === "]" ? 1 : -1);
    } else if (data === "S") {
      this.sendSelectedEntry();
    } else if (data === "E") {
      this.copySelectedEntry();
    } else if (data === "D") {
      this.requestDeleteSelectedEntry();
    } else if (data === "?") {
      this.showHelp();
    } else if (data !== "\n" && matchesKey(data, "ctrl+j")) {
      // Raw LF is indistinguishable from legacy Ctrl+J and is also a normal
      // Enter encoding. Only an explicit extended key sequence may reorder.
      this.moveFocusedItem(1);
    } else if (matchesKey(data, "ctrl+k")) {
      this.moveFocusedItem(-1);
    } else if (data === "j" || data === "J") {
      this.moveQueueFocus(1);
    } else if (data === "k" || data === "K") {
      this.moveQueueFocus(-1);
    } else if (data === "y" || data === "Y") {
      this.duplicateFocused();
    } else if (data === "u" || data === "U") {
      this.restoreDeleted();
    } else if (data === "n" || data === "N") {
      this.setFocus("composer");
      this.notice = "COMPOSE — type or paste a thought, Ctrl+S queues + reviews";
    } else if (data === "w" || data === "W") {
      this.setFocus("editor");
      this.notice = "NOTEBOOK — the note selection stays where it was";
    } else if (data === "e") {
      this.editFocused();
    } else if (data === "d") {
      this.requestDeleteFocused();
    } else if (data === "s") {
      this.requestFocusedSubmit();
    } else if (data === "x" || data === "X") {
      this.requestClearQueue();
    } else {
      // Refusing is still handling: the view reacted with a notice and changed nothing.
      this.notice = `QUEUE ignores ${escapeForDisplay(data)} — ? lists the keys`;
    }
    this.syncHighlight();
    return true;
  }

  private showHelp(): void {
    this.helpVisible = true;
    this.invalidateLayoutBudget();
    this.notice = `keys for ${REGION_NAME[this.focusTarget]} — any key closes the list`;
  }

  /** The notebook entry the current selection covers exactly, if any. */
  private selectedEntry(): ReturnType<typeof entryMatching> {
    return entryMatching(notebookEntries(this.getNoteText()), this.clampSelection());
  }

  /** `[` / `]`: select the previous or next whole entry and scroll the notebook to it. */
  private stepNotebookEntry(delta: -1 | 1): void {
    const entries = notebookEntries(this.getNoteText());
    const step = stepEntry(entries, this.clampSelection(), delta);
    if (step === undefined) {
      this.notice = "the notebook has no entries yet — Ctrl+N in NOTEBOOK inserts one";
      return;
    }
    const { entry, index } = step;
    this.selection = { startLine: entry.startLine, endLine: entry.endLine };
    this.editor.revealLines(entry.startLine, entry.endLine);
    const label = entry.kind === "marked" ? entry.label : `"${clampPlain(entry.label, 32)}"`;
    this.notice = `entry ${index + 1}/${entries.length} · lines ${entry.startLine}-${entry.endLine} · ${label} · Enter queues, S sends, E copies, D deletes`;
  }

  /**
   * Text the selection stands for: a marked entry's body without its markers,
   * otherwise the exact selected lines. Empty when a marked block has no body.
   */
  private selectionPayload(): { text: string; range: SpikeSelection } | undefined {
    const note = this.getNoteText();
    if (physicalLineCount(note) === 0) return undefined;
    const entry = this.selectedEntry();
    if (entry !== undefined && entry.kind === "marked") {
      if (entry.bodyStart > entry.bodyEnd) return undefined;
      const range = { startLine: entry.bodyStart, endLine: entry.bodyEnd };
      return { text: selectLines(note, range.startLine, range.endLine).text, range };
    }
    const range = this.clampSelection();
    return { text: selectLines(note, range.startLine, range.endLine).text, range };
  }

  /** `S`: queue the selection and open its review at once. The send itself stays explicit. */
  private sendSelectedEntry(): void {
    if (!this.hosted) {
      this.notice = "session only, never sent — S lives in the hosted /promptr view";
      return;
    }
    const payload = this.selectionPayload();
    if (payload === undefined) { this.notice = "nothing to send: the selection has no text"; return; }
    if (!this.pushToQueue(payload.text, { documentRevision: this.documentRevision, ...payload.range })) return;
    this.reviewIndex = this.focusedQueue;
    this.reviewRequested = true;
  }

  /** `E`: copy the selection into an empty composer for editing. Never overwrites a draft. */
  private copySelectedEntry(): void {
    const payload = this.selectionPayload();
    if (payload === undefined) { this.notice = "nothing to copy: the selection has no text"; return; }
    if (this.getComposerText().length > 0) {
      this.notice = "composer has a draft — queue or clear it before copying an entry";
      return;
    }
    this.composer.setText(payload.text);
    this.setFocus("composer");
    this.notice = `copied notebook lines ${payload.range.startLine}-${payload.range.endLine} into the composer — Ctrl+S queues + reviews`;
  }

  private requestDeleteSelectedEntry(): void {
    if (physicalLineCount(this.getNoteText()) === 0) { this.notice = "the notebook is empty — nothing to delete"; return; }
    const range = this.clampSelection();
    this.confirmingEntryDelete = range;
    this.notice = ENTRY_DELETE_PROMPT(range);
  }

  private handleEntryDeleteConfirmation(data: string): boolean {
    const range = this.confirmingEntryDelete as SpikeSelection;
    if (data === "y" || data === "Y") {
      const before = this.getNoteText();
      const after = removeLines(before, range.startLine, range.endLine);
      this.confirmingEntryDelete = undefined;
      if (after === before) { this.notice = "delete skipped — those lines no longer exist"; return true; }
      this.editor.setText(after);
      this.documentRevision += 1;
      this.selection = { startLine: range.startLine, endLine: range.startLine };
      this.syncHighlight();
      this.notice = `deleted notebook lines ${range.startLine}-${range.endLine} · ${physicalLineCount(after)} lines left`;
    } else if (data === "n" || data === "N" || matchesKey(data, "escape")) {
      this.confirmingEntryDelete = undefined;
      this.notice = "delete cancelled; notebook kept";
    } else {
      this.notice = `${ENTRY_DELETE_PROMPT(range)} (unrecognised answer)`;
    }
    return true;
  }

  /** Ctrl+N in the notebook: a closed note block at the cursor, cursor on its blank body line. */
  private insertNoteBlock(): void {
    const cursor = this.editor.getCursor();
    const lineText = this.editor.getLines()[cursor.line] ?? "";
    const stamp = `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
    const block = `${lineText.length > 0 && cursor.col > 0 ? "\n" : ""}${newNoteBlock(stamp)}`;
    if (Buffer.byteLength(this.getNoteText(), "utf8") + Buffer.byteLength(block, "utf8") > MAX_BUFFER_BYTES) {
      this.notice = `buffer is full at ${MAX_BUFFER_BYTES / 1024} KiB; nothing was inserted`;
      return;
    }
    this.applyEdit(this.editor, () => {
      this.editor.insertTextAtCursor(block);
      this.editor.handleInput("\x1b[A");
      this.editor.handleInput("\x1b[A");
    });
    this.notice = "new note block inserted — type between the markers; [ ] in QUEUE walks entries";
  }

  /** The notebook paints the selection only while the queue panel is driving it. */
  private syncHighlight(): void {
    const show = this.focusTarget === "panel" && physicalLineCount(this.getNoteText()) > 0;
    this.editor.highlight = show ? this.clampSelection() : undefined;
  }

  /**
   * Board-level submit: the focused queued thought goes through the standard
   * single review-and-confirm dialog, then to the main session via the host's
   * explicit send. Never auto-sends; the host rechecks idle/session first.
   */
  private requestFocusedSubmit(): void {
    if (this.queue.items.length === 0) {
      this.notice = "queue is empty — nothing to submit";
      return;
    }
    if (!this.hosted) {
      this.notice = "session only, never sent — submit lives in the hosted /promptr view";
      return;
    }
    this.focusedQueue = this.clampQueueFocus();
    this.reviewIndex = this.focusedQueue;
    this.reviewRequested = true;
  }

  /** Editor/composer routing: known editing keys are commands, text must be printable ASCII. */
  private handleTextInput(data: string, target: Editor): boolean {
    if (target === this.editor && matchesKey(data, "ctrl+n")) {
      this.insertNoteBlock();
      return true;
    }
    if (matchesKey(data, "enter")) {
      // The library Editor submits on CR and inserts a line only on LF; Enter is a
      // command here, so it is mapped to the library's newline input, never to text.
      this.applyEdit(target, () => target.handleInput("\n"));
      return true;
    }
    if (EDITING_KEYS.some((key) => matchesKey(data, key))) {
      this.applyEdit(target, () => target.handleInput(data));
      return true;
    }
    if (isPrintableAscii(data)) {
      if (Buffer.byteLength(this.textOf(target), "utf8") + Buffer.byteLength(data, "utf8") > MAX_BUFFER_BYTES) {
        this.notice = `buffer is full at ${MAX_BUFFER_BYTES / 1024} KiB; nothing was inserted`;
        return true;
      }
      this.applyEdit(target, () => {
        // One keystroke takes the ordinary key path; a coalesced burst is inserted
        // in one call so fast typing cannot become quadratic.
        if (data.length === 1) target.handleInput(data);
        else target.insertTextAtCursor(data);
      });
      return true;
    }
    this.notice = `unsupported input ignored: ${escapeForDisplay(data)} (printable ASCII and Enter only)`;
    return true;
  }

  private textOf(target: Editor): string {
    return target === this.composer ? this.getComposerText() : this.getNoteText();
  }

  /** Run an edit and report it only when the buffer text actually changed. */
  private applyEdit(target: Editor, edit: () => void): void {
    const before = this.textOf(target);
    edit();
    const after = this.textOf(target);
    if (after === before) {
      this.notice = "cursor moved";
      return;
    }
    if (target === this.editor) {
      this.documentRevision += 1;
      this.notice = this.hosted ? "note edited (saved)" : "note edited (in memory only)";
    } else {
      this.notice = "composer edited; Ctrl+Enter or Ctrl+E enqueues it";
    }
  }

  private enqueueSelection(): void {
    const note = this.getNoteText();
    if (physicalLineCount(note) === 0) {
      this.notice = "nothing to copy: the note is empty";
      return;
    }
    const payload = this.selectionPayload();
    if (payload === undefined) {
      this.notice = "nothing to copy: the selected entry has no text between its markers";
      return;
    }
    this.pushToQueue(payload.text, { documentRevision: this.documentRevision, ...payload.range });
  }

  private enqueueComposer(): void {
    const text = this.getComposerText();
    if (text.length === 0) {
      this.notice = "composer is empty; type something before enqueuing";
      return;
    }
    if (!this.pushToQueue(text)) return;
    this.composer.setText("");
    this.archiveComposerToNote(text);
  }

  /**
   * Archive a queued composer prompt into the note (editor section) so queued
   * and submitted prompts accumulate as persistent history alongside working
   * notes. ASCII-only stamp keeps the note inside the accepted-input contract.
   * Appends at the end (existing lines and selection are undisturbed) and
   * honors the buffer bound: when the note is full the prompt stays queued
   * and the notice says so.
   */
  private archiveComposerToNote(text: string): void {
    const where = this.hosted ? "Ctrl+S to review/send" : "session only, never sent";
    const current = this.getNoteText();
    const stamp = `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`;
    const gap = current.endsWith("\n") ? "\n" : "\n\n";
    const entry = `${gap}${archivedPromptBlock(stamp, text)}`;
    if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(entry, "utf8") > MAX_BUFFER_BYTES) {
      this.notice = `queued item ${this.queue.items.length} (${where}) · note full, not archived`;
      return;
    }
    this.editor.setText(`${current}${entry}`);
    this.documentRevision += 1;
    this.notice = `queued item ${this.queue.items.length} (${where}) · stored in note`;
  }

  /** Enqueue through the queue module's public API. Bound violations become notices, not crashes. */
  private pushToQueue(text: string, source?: SpikeSelection & { documentRevision: number }, origin?: string): boolean {
    try {
      this.queue = enqueue(this.queue, {
        expectedRevision: this.queue.revision,
        requestId: randomUUID(),
        text,
        ...(source === undefined ? {} : { source }),
        ...(origin === undefined ? {} : { origin }),
      });
      // The board cursor follows the newest thought, like a proqi board.
      this.focusedQueue = Math.max(0, this.queue.items.length - 1);
      this.notice = `queued item ${this.queue.items.length} (${this.hosted ? "Ctrl+S to review/send" : "session only, never sent"})`;
      return true;
    } catch (error) {
      this.notice = `not queued: ${(error as Error).message}`;
      return false;
    }
  }

  private clampSelection(): SpikeSelection {
    const lineCount = Math.max(1, physicalLineCount(this.getNoteText()));
    const startLine = Math.min(Math.max(1, this.selection.startLine), lineCount);
    const endLine = Math.min(Math.max(startLine, this.selection.endLine), lineCount);
    return { startLine, endLine };
  }

  /** Textual focus marker. Two columns wide in both states so rules never shift. */
  private focusMark(name: SpikeFocus): string {
    return this.focusTarget === name ? "▶ " : "  ";
  }

  /**
   * Notebook row budget: the frame height minus every other region's natural
   * height. Called once per notebook render, and again through the editor's
   * viewport-scoped TUI, so it memoizes on (width, frame height).
   */
  private notebookTargetRows(width: number): number {
    const safeWidth = Math.max(1, Math.trunc(width));
    const height = this.frameHeight();
    const cached = this.notebookBudget;
    if (cached && cached.width === safeWidth && cached.height === height) return cached.rows;
    const used =
      this.buildPanelLines(safeWidth).length +
      this.composerRegion.render(safeWidth).length +
      this.buildTrackingLines(safeWidth).length +
      this.buildStatusLines(safeWidth).length;
    const rows = Math.max(MIN_NOTEBOOK_ROWS, height - used);
    this.notebookBudget = { width: safeWidth, height, rows };
    return rows;
  }

  /** Record the width the notebook is rendering at, then report its row budget. */
  private planNotebookRows(width: number): number {
    this.notebookWidth = Math.max(1, Math.trunc(width));
    return this.notebookTargetRows(this.notebookWidth);
  }

  /** Rows the whole view is being laid out into: renderFrame's height, else the terminal's. */
  private frameHeight(): number {
    if (this.frameRows !== undefined) return this.frameRows;
    const rows = this.tui.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? Math.trunc(rows) : 24;
  }

  /** One-line identity header: who this is, which project, and the way out. */
  private buildHeaderLine(): string {
    const parts = ["PROMPTR"];
    if (this.projectLabel.length > 0) parts.push(this.projectLabel);
    if (this.headerStatus.git.length > 0) parts.push(this.headerStatus.git);
    if (this.headerStatus.pi.length > 0) parts.push(this.headerStatus.pi);
    if (this.headerStatus.ok.length > 0) parts.push(this.headerStatus.ok);
    // Ctrl+O rides in the header so project navigation stays visible even when
    // a narrow frame truncates the footer's context hints.
    if (this.overviewNavigation) parts.push("Ctrl+O overview");
    return parts.join(" · ");
  }

  private buildPanelLines(width = 80): string[] {
    const lines = this.hosted
      ? [this.buildHeaderLine()]
      // Prototype mode keeps both safety banners and the accepted-input
      // contract: shortening must never cost a notice about what is real.
      : [SPIKE_BANNER, NOT_SAVED_BANNER, INPUT_CONTRACT_BANNER];
    lines.push(sectionRule(`${this.focusMark("panel")}QUEUE ${this.queue.items.length}`, width));
    if (this.helpVisible) {
      lines.push(...keyReferenceLines(this.focusTarget, width, HELP_ROWS));
      return lines;
    }
    const entries = this.getMockQueue();
    if (entries.length === 0) {
      lines.push(width >= WIDE_HINT_COLUMNS
        ? "  empty · Tab to COMPOSE, type, Ctrl+S queues + reviews · ? lists the keys"
        : "  empty · Tab to COMPOSE · ? keys");
    } else {
      // Proqi-style collapsed thought cards: one row per thought with a
      // first-line preview plus honest line/char counts. The board keeps a
      // bounded window around the j/k cursor so a long queue cannot push the
      // note region out of the frame; getMockQueue() still exposes every
      // item's exact bytes for review and submission.
      const focus = this.clampQueueFocus();
      const expanded = this.focusTarget === "panel";
      // The focused card opens to a few lines of its text (proqi-style); the
      // extra rows come out of the card budget so the region stays bounded.
      const focusedText = expanded ? (entries[focus] ?? "") : "";
      const focusedLines = expanded ? Math.min(CARD_EXPANDED_LINES, Math.max(1, physicalLineCount(focusedText))) : 1;
      const cardBudget = Math.max(1, PANEL_QUEUE_ROWS - (focusedLines - 1));
      const half = Math.floor(cardBudget / 2);
      let start = Math.max(0, Math.min(focus - half, entries.length - cardBudget));
      const end = Math.min(entries.length, start + cardBudget);
      start = Math.max(0, end - cardBudget);
      if (start > 0) lines.push(`  ... ${start} earlier not shown`);
      // Reserve room for `▶ 12. ` plus the ` · 2l · 41c` tail before deciding
      // how much of the first line a card may show at this width.
      const safeWidth = Math.max(1, Math.trunc(width));
      const previewBudget = safeWidth - 24;
      for (let index = start; index < end; index++) {
        const text = entries[index] ?? "";
        const badge = this.cardBadge(index);
        const card = summarizeThought(text, previewBudget - badge.length);
        if (expanded && index === focus) {
          lines.push(...this.expandedCardLines(index, text, card, safeWidth, badge));
          continue;
        }
        lines.push(`  ${index + 1}. ${badge}${card.preview}${card.suffix} · ${card.lineCount}l · ${card.chars}c`);
      }
      if (end < entries.length) lines.push(`  ... ${entries.length - end} later not shown`);
    }
    return lines;
  }

  /**
   * Focused queue card, proqi-style: a left bar on every row, the cursor and
   * counts on the first, then up to CARD_EXPANDED_LINES of the exact text with
   * an honest `+n lines` when more is hidden. Rows are width-fitted here so the
   * bar is never what truncation removes.
   */
  private expandedCardLines(
    index: number,
    text: string,
    card: { preview: string; suffix: string; lineCount: number; chars: number },
    width: number,
    badge = "",
  ): string[] {
    const head = `${CARD_BAR}▶ ${index + 1}. ${badge}${card.preview}${card.suffix} · ${card.lineCount}l · ${card.chars}c`;
    const rows = [truncateToWidth(head, width, "")];
    const all = text.split("\n");
    if (text.endsWith("\n")) all.pop();
    const shown = all.slice(1, CARD_EXPANDED_LINES);
    const hidden = Math.max(0, card.lineCount - CARD_EXPANDED_LINES);
    shown.forEach((line, offset) => {
      const last = offset === shown.length - 1;
      const tail = last && hidden > 0 ? ` +${hidden} line${hidden === 1 ? "" : "s"}` : "";
      const room = Math.max(1, width - visibleWidth(`${CARD_BAR}   `) - visibleWidth(tail));
      const body = line.length === 0 ? "" : clampPlain(line, room);
      rows.push(`${CARD_BAR}   ${body}${tail}`);
    });
    return rows;
  }

  /**
   * COMPOSE label, rendered immediately above the composer it names. The draft
   * itself is one row below, so the label carries size only — never a preview
   * of text the operator can already read.
   */
  private composeLabel(width: number): string {
    const chars = this.getComposerText().length;
    if (chars === 0) return `${this.focusMark("composer")}COMPOSE`;
    const size = width >= WIDE_HINT_COLUMNS ? `${chars} chars` : `${chars}c`;
    return `${this.focusMark("composer")}COMPOSE · ${size}`;
  }

  /**
   * NOTEBOOK label, rendered immediately above the note editor. Carries the
   * selection range that panel Enter would queue, so the six-row selection
   * preview the queue region used to duplicate is not needed.
   */
  private notebookLabel(width: number): string {
    const lineCount = physicalLineCount(this.getNoteText());
    const { startLine, endLine } = this.clampSelection();
    const mark = this.focusMark("editor");
    if (lineCount === 0) return `${mark}NOTEBOOK · empty`;
    // A narrow frame keeps the selection (what Enter would queue) and drops the
    // revision counter, rather than truncating the label mid-word.
    return width >= WIDE_HINT_COLUMNS
      ? `${mark}NOTEBOOK · sel ${startLine}-${endLine}/${lineCount} · rev ${this.documentRevision}`
      : `${mark}NOTEBOOK · ${startLine}-${endLine}/${lineCount}`;
  }

  /**
   * Bottom-region tracking: the host's pre-rendered Gitea snapshot text
   * (full milestone names + open-issue titles from renderBoardLines).
   * Display only; Gitea stays authoritative.
   */
  private buildTrackingLines(width = 80): string[] {
    if (this.trackingNavigation) return this.buildBoardLines(width);
    // Tracking is read-only reference data, so it takes at most a sixth of the
    // frame: on a short pane the notebook keeps the rows instead. What does not
    // fit is counted, never silently dropped.
    const budget = Math.min(PANEL_TRACKING_ROWS + 1, Math.floor(this.frameHeight() / 6));
    if (budget < 2) return [];
    const lines = [sectionRule(`${this.focusMark("tracking")}TRACKING · Gitea read-only`, width)];
    // The selection row names what Enter would open. It is host-supplied
    // (from the navigation controller), never parsed out of the summary rows.
    const selectionRow = this.trackingNavigation && this.trackingSelectionLine.length > 0
      ? `  ${this.trackingSelectionLine}`
      : undefined;
    if (this.trackingLines.length === 0) {
      if (selectionRow !== undefined && budget >= 3) lines.push(selectionRow);
      lines.push("  no snapshot · /work-status refreshes");
      return lines.slice(0, budget);
    }
    if (selectionRow !== undefined && budget >= 3) lines.push(selectionRow);
    const room = budget - lines.length;
    const shown = this.trackingLines.length <= room ? this.trackingLines : this.trackingLines.slice(0, room - 1);
    for (const line of shown) lines.push(`  ${line}`);
    const hidden = this.trackingLines.length - shown.length;
    if (hidden > 0) lines.push(`  ... ${hidden} more · Ctrl+O overview`);
    return lines;
  }

  /** Rule text for the workboard region: repo, open count, snapshot age and the host's note. */
  private boardRuleTitle(): string {
    const parts = [`${this.focusMark("tracking")}TRACKING`];
    if (this.board) {
      const repo = this.board.provider ? `${this.board.provider} ${this.board.repoLabel}` : this.board.repoLabel;
      parts.push(repo, `${this.board.openCount} open`, ageLine(this.board.fetchedAt));
    } else {
      parts.push("no board");
    }
    if (this.boardNote.length > 0) parts.push(this.boardNote);
    return parts.join(" · ");
  }

  /** Body row budget for the board: modest when idle, half the frame when it has focus. */
  private boardRowBudget(): number {
    const height = this.frameHeight();
    return this.focusTarget === "tracking"
      ? Math.max(8, Math.floor(height / 2))
      : Math.max(4, Math.floor(height / 5));
  }

  /**
   * Navigable workboard region: one rule, then a scrolled window of board rows
   * that keeps the cursor issue visible and counts what it could not fit.
   */
  private buildBoardLines(width = 80): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const lines = [sectionRule(this.boardRuleTitle(), safeWidth)];
    const rows = this.boardRows();
    if (rows.length === 0) {
      lines.push(this.board ? "  no open tasks · r refreshes" : "  no snapshot · r refreshes");
      this.boardWindowSize = 1;
      return lines;
    }
    const budget = Math.min(rows.length, this.boardRowBudget());
    const cursorRow = this.boardCursorRow() ?? 0;
    let start = 0;
    let end = rows.length;
    if (rows.length > budget) {
      // Indicator rows live inside the budget, so the content capacity depends on
      // where the window sits; iterate until the cursor row is inside it.
      const capacity = (from: number): number => {
        let room = budget - (from > 0 ? 1 : 0);
        if (from + room < rows.length) room -= 1;
        return Math.max(1, room);
      };
      start = Math.min(Math.max(0, this.boardWindowStart), rows.length - 1);
      if (cursorRow < start) start = cursorRow;
      while (cursorRow >= start + capacity(start)) start += 1;
      while (start > 0 && start + capacity(start - 1) - 1 >= rows.length) start -= 1;
      end = Math.min(rows.length, start + capacity(start));
    }
    this.boardWindowStart = start;
    this.boardWindowSize = Math.max(1, end - start);
    if (start > 0) lines.push(`  ↑ ${start} more`);
    for (let index = start; index < end; index++) {
      lines.push(this.boardRowLine(rows[index] as BoardRow, index === cursorRow, safeWidth));
    }
    if (end < rows.length) lines.push(`  ↓ ${rows.length - end} more`);
    return lines;
  }

  private boardRowLine(row: BoardRow, atCursor: boolean, width: number): string {
    if (row.kind === "map") {
      const counts = WORK_STATUS_ORDER.filter((status) => (row.counts[status] ?? 0) > 0)
        .map((status) => `${row.counts[status]} ${status}`);
      const head = `  Map #${row.number} `;
      const tasks = `${row.childCount} task${row.childCount === 1 ? "" : "s"}`;
      // Counts are a courtesy: when they would squeeze the title below a
      // readable width, keep the title and the task count only.
      let tail = [tasks, ...counts].join(" · ");
      if (width - visibleWidth(head) - visibleWidth(tail) - 3 < 24) tail = tasks;
      const title = clampPlain(row.title, Math.max(1, width - visibleWidth(head) - visibleWidth(tail) - 3));
      return truncateToWidth(`${head}${title} · ${tail}`, width, "");
    }
    if (row.kind === "section") return truncateToWidth(`  ${row.label} ${row.count} · not on an open map`, width, "");
    if (row.kind === "heading") return truncateToWidth(`  ${row.status.toUpperCase()} ${row.count}`, width, "");
    const issue = row.issue;
    const cursor = this.focusTarget === "tracking" && atCursor ? "▶" : " ";
    const priority = issue.priority.length > 0 ? issue.priority : "  ";
    const status = (issue.status === "unknown" ? "?" : issue.status).padEnd(STATUS_COLUMN);
    const indent = row.depth === 1 ? "  └ " : " ";
    const head = `${cursor}${indent}#${issue.number} ${priority} ${status} `;
    let tail = "";
    if (issue.status === "active" && issue.assignee.length > 0) tail = ` @${issue.assignee}`;
    else if (issue.status === "blocked" && issue.blockers !== undefined) tail = ` ⛔${issue.blockers}`;
    const room = Math.max(1, width - visibleWidth(head) - visibleWidth(tail));
    const title = clampPlain(issue.title, room);
    return truncateToWidth(`${head}${title}${tail}`, width, "");
  }

  /**
   * Whole-line painters: wrap complete rows only, so content substrings
   * (thought previews, issue titles, key hints) are never split by codes.
   */
  private paintPanelLine(line: string): string {
    const c = boardColors;
    if (line === SPIKE_BANNER || line === NOT_SAVED_BANNER) return c.yellow(line);
    if (line === INPUT_CONTRACT_BANNER) return c.dim(line);
    if (line.startsWith("PROMPTR")) return this.paintHeaderLine(line);
    if (line.includes("QUEUE ")) return (this.focusTarget === "panel" ? c.accentBold : c.muted)(line);
    if (line.startsWith(CARD_BAR)) return c.accent(line);
    if (/^  \d+\. /.test(line)) return line;
    if (line.startsWith("  empty ") || line.startsWith("  ... ")) return c.muted(line);
    return line;
  }

  /**
   * Header: bold throughout, with the Pi state fragment tinted by what it says.
   * The fragment is a whole ` · `-delimited part, so no grapheme is split.
   */
  private paintHeaderLine(line: string): string {
    const c = boardColors;
    const fragments: Array<{ text: string; tint: (text: string) => string }> = [];
    const pi = this.headerStatus.pi;
    if (pi.length > 0) {
      fragments.push({
        text: pi,
        tint: pi.includes(" blocked")
          ? (text: string) => c.yellow(c.bold(text))
          : pi.includes(" working") ? c.yellow : pi.includes(" idle") ? c.green : c.dim,
      });
    }
    // OpenKnowledge fragment: reachable → green, offline/pending → yellow, unbound → dim.
    const ok = this.headerStatus.ok;
    if (ok.length > 0) {
      fragments.push({
        text: ok,
        tint: ok.includes(" offline") || ok.includes(" pending") ? c.yellow : ok.includes(" unbound") ? c.dim : c.green,
      });
    }
    let out = "";
    let rest = line;
    for (const fragment of fragments) {
      const at = rest.indexOf(fragment.text);
      if (at < 0) continue;
      out += c.bold(rest.slice(0, at)) + fragment.tint(fragment.text);
      rest = rest.slice(at + fragment.text.length);
    }
    return rest.length > 0 ? out + c.bold(rest) : out;
  }

  private paintTrackingLine(line: string): string {
    const c = boardColors;
    if (line.includes("TRACKING · ")) return (this.focusTarget === "tracking" ? c.accentBold : c.muted)(line);
    if (line.startsWith("  no snapshot") || line.startsWith("  no open tasks") || line.startsWith("  ... ")) return c.dim(line);
    if (/^  [↑↓] \d+ more$/.test(line)) return c.dim(line);
    if (line.startsWith("▶ #")) return c.accent(line);
    if (/^  [A-Z?]+ \d+$/.test(line)) return c.bold(line);
    if (line.startsWith("  Map #")) return c.muted(line);
    return tintProgressBars(line);
  }

  private paintStatusLine(line: string): string {
    const c = boardColors;
    // A confirmation is the one thing that outranks the focus accent.
    if (line.includes("y = clear,") || line.includes("y = quit,") || line.includes("y = delete,")) return c.yellow(line);
    if (line.startsWith("▶ ")) return c.accent(line);
    return paintKeyHints(line);
  }

  /**
   * Two footer rows: what has focus plus the latest notice, then the keys that
   * apply to that region right now. Private state roots in a host-set notice
   * are condensed to their tail; the rest of the message is kept exactly.
   */
  private buildStatusLines(width = 80): string[] {
    const region = REGION_NAME[this.focusTarget];
    const notice = condensePaths(this.hosted ? this.notice : `${this.notice} · session only, never sent`);
    return [`▶ ${region} · ${notice}`, this.buildHintLine(Math.max(1, Math.trunc(width)))];
  }

  /** Keys for the focused region only: the richest tier that fits the width. */
  private buildHintLine(width: number): string {
    const tiers = HINT_TIERS[this.focusTarget];
    return tiers.find((tier) => visibleWidth(tier) <= width) ?? tiers[tiers.length - 1] ?? "?";
  }

  /**
   * Height- and width-bounded frame, matching what TuiAltScreen paints:
   * cursor marker stripped, last `height` rows kept, each row cut to `width`.
   */
  renderFrame(width: number, height: number): string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const safeHeight = Math.max(1, Math.trunc(height));
    // Hosts embed this view in a smaller box than the terminal, so the frame
    // height given here — not terminal.rows — is what the regions divide up.
    if (this.frameRows !== safeHeight) this.invalidateLayoutBudget();
    this.frameRows = safeHeight;
    const frame = renderLayoutFrame(this.layoutRoot, safeWidth, safeHeight, () => {});
    let rows = frame.lines.map((line) => line.split(CURSOR_MARKER).join(""));
    if (rows.length > safeHeight) rows = rows.slice(rows.length - safeHeight);
    while (rows.length < safeHeight) rows.push("");
    return rows.map((row) =>
      visibleWidth(row) <= safeWidth ? row : sliceByColumn(row, 0, safeWidth, true),
    );
  }
}
