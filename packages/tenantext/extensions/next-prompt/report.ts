/**
 * The reader of the two report forms of the dummies skill: "Compact report syntax 2" (section 6 of REPORT.md)
 * and "Detailed report syntax 1" (DETAILED.md). This module is the only place that knows the syntax.
 * It reads text and session entries; it has no side effect.
 */

/** The accepted text of a suggestion has at most this count of characters. A longer candidate gives no suggestion. */
export const MAX_CHARS = 100;

const REPORT = /^\*\*REPORT [1-9][0-9]*(?: \((?:[2-9]|[1-9][0-9]+) turns\))?\*\* \S(?:.*\S)?$/;
const OUTCOME = /^\*\*OUTCOME\*\* \S(?:.*\S)?$/;
const ITEM = /^- \*\*\[([1-9][0-9]*)\]\*\* (Done|Failed|Unverified|Running|Blocked|Proposal|Needs approval|Retired): \S(?:.*\S)?$/;
const WARNING = /^\*\*Warning:\*\* \S(?:.*\S)?$/;
const NEXT = /^\*\*Next:\*\*$/;
const ACTION = /^- \*\*\[([a-z]+)\]\*\* (Agent|Owner decides|Owner)(?:, ([^:]+))?: (\S(?:.*\S)?)$/;
const NONE = /^\*\*Next:\*\* None\. \S(?:.*\S)?$/;
// Detailed report syntax 1. A heading of level 2, the Next heading, its action and none lines, and the page entry line.
const HEADING = /^## \S/;
const DETAILED_NEXT = "## Next";
const DETAILED_ACTION = /^- \*\*\[([A-Z]+)\]\*\* (Agent|Owner decides|Owner)(?:, ([^:]+))?: (\S(?:.*\S)?)$/;
const DETAILED_NONE = /^None\. \S(?:.*\S)?$/;
const ADDED = /^added: \S/;
// A warning of the detailed form anywhere in the message. A loose test: a line with a wrong end still counts.
const WARNING_START = /^\*\*Warning:\*\*/;
// A fence opens with three or more backticks or tildes after at most three spaces.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^>/;
// An empty line holds nothing or spaces only.
const EMPTY = /^ *$/;
// The characters that a draft never holds, in both syntaxes: each control character (the tab too), each format
// character (the zero-width, hidden and bidirectional controls are format characters), and the line and paragraph
// separators. A test of the categories also covers each new character of these categories.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// The characters that make a detailed message ambiguous in both readers: the unsafe characters other than the tab.
// A carriage return that is not before a line feed stays in its line, so it is one of them. The regular expressions
// of the two readers read some of these characters in different ways, so no reader parses a line that holds one.
const HIDDEN = /[^\P{Cc}\t]|[\p{Cf}\p{Zl}\p{Zp}]/u;

export interface Action { label: string; actor: "Agent" | "Owner decides" | "Owner"; condition?: string; text: string }
export type Report =
  | { status: "missing" }
  | { status: "ambiguous"; detail: string }
  | { status: "none" }
  | { status: "next"; items: ReadonlyMap<string, string>; actions: readonly Action[]; warning: boolean; unsafe: boolean };

export type Suggestion =
  | { kind: "suggestion"; action: string; text: string }
  | { kind: "none"; reason: "no-final-message" | "missing" | "ambiguous" | "no-next" | "owner" | "conditional" | "approval" | "unlinked" | "unsafe" | "overlong" };

/**
 * The lines that a program reads: each line outside a code fence that is not a quote. A line ends at a line feed,
 * with an optional carriage return before it.
 * A fence closes at the next line of only the same character, at least as many times, after at most
 * three spaces and before spaces only. An open fence runs to the end of the message.
 */
function readableLines(text: string): string[] {
  const out: string[] = [];
  let close: RegExp | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (close) { if (close.test(line)) close = undefined; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence) { close = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},} *$`); continue; }
    if (!QUOTE.test(line)) out.push(line);
  }
  return out;
}

/**
 * Bijective base-26 from `first`: a..z, aa..az, ba..zz, aaa... for syntax 2, and A..Z, AA... for the detailed form.
 * No label-length or action-count cap.
 */
function nextActionLabel(label: string, first = "a"): string {
  const last = String.fromCharCode(first.charCodeAt(0) + 25);
  for (let i = label.length - 1; i >= 0; i--) {
    if (label[i] !== last) return label.slice(0, i) + String.fromCharCode(label.charCodeAt(i) + 1) + first.repeat(label.length - i - 1);
  }
  return first.repeat(label.length + 1);
}

/**
 * True when a line competes with a syntax 2 report: it holds no hidden character, and it matches the detailed
 * `action` or `none` pattern. The hidden test comes first. The regular expressions of the two readers read `.` and
 * `\S` in different ways only for hidden characters, so the answer is the same in both readers.
 */
function competes(line: string): boolean {
  return !HIDDEN.test(line) && (DETAILED_ACTION.test(line) || DETAILED_NONE.test(line));
}

/** True when a `## Next` line is followed, after at most one empty line, by a competing line. */
function hasDetailedBlock(lines: readonly string[]): boolean {
  return lines.some((line, i) => {
    if (line !== DETAILED_NEXT) return false;
    let below = i + 1;
    if (below < lines.length && EMPTY.test(lines[below])) below++;
    return below < lines.length && competes(lines[below]);
  });
}

/**
 * Parse detailed report syntax 1, for a message with no syntax 2 head line. The message needs one `## Next` line,
 * and it must be the last level-2 heading. The block ends at the first empty line after its last line; the text
 * after it gives no action, but a warning line there still counts.
 */
function parseDetailed(lines: readonly string[]): Report {
  const nexts = lines.flatMap((line, i) => line === DETAILED_NEXT ? [i] : []);
  if (nexts.length === 0) return { status: "missing" };
  if (lines.some(line => HIDDEN.test(line))) return { status: "ambiguous", detail: "a control, format or separator character in the text" };
  if (nexts.length > 1) return { status: "ambiguous", detail: "two Next headings" };
  const next = nexts[0];
  let last = lines.length - 1;
  while (!HEADING.test(lines[last])) last--;
  if (last !== next) return { status: "missing" };
  let first = lines.findIndex(line => !EMPTY.test(line));
  if (ADDED.test(lines[first])) first = lines.findIndex((line, i) => i > first && !EMPTY.test(line));
  if (lines[first].startsWith("#")) return { status: "ambiguous", detail: "no result paragraph before the first heading" };
  const actions: Action[] = [];
  let label = "A";
  let owner = false;
  let none = false;
  let end = next + 1;
  if (end < lines.length && EMPTY.test(lines[end])) end++;
  for (; end < lines.length && !EMPTY.test(lines[end]); end++) {
    const line = lines[end];
    if (none) return { status: "ambiguous", detail: "line after the None line" };
    if (actions.length === 0 && DETAILED_NONE.test(line)) { none = true; continue; }
    const match = DETAILED_ACTION.exec(line);
    if (!match) return { status: "ambiguous", detail: "line in the Next block matches no pattern" };
    const [, found, actor, condition, action] = match;
    if (found !== label) return { status: "ambiguous", detail: "action labels must restart at A and follow base-26 order" };
    if (owner && actor === "Agent") return { status: "ambiguous", detail: "Agent action after an Owner action" };
    owner ||= actor !== "Agent";
    actions.push({ label, actor: actor as Action["actor"], ...(condition ? { condition } : {}), text: action });
    label = nextActionLabel(label, "A");
  }
  if (none) return { status: "none" };
  if (actions.length === 0) return { status: "ambiguous", detail: "Next heading with no action and no None line" };
  return { status: "next", items: new Map(), actions, warning: lines.some(line => WARNING_START.test(line)),
    unsafe: lines.slice(first, end).some(line => UNSAFE.test(line)) };
}

/**
 * Parse syntax 2, or the detailed syntax when the message has no syntax 2 head line. A syntax 2 message is
 * ambiguous when it also holds a detailed Next block; a `## Next` heading over ordinary text leaves it syntax 2.
 * Each step reads the lines of `readableLines`.
 * Legacy uppercase and mixed blocks fail closed; no subject relation is inferred.
 */
export function parseReport(text: string): Report {
  const lines = readableLines(text);
  const heads = lines.flatMap((line, i) => REPORT.test(line) || OUTCOME.test(line) ? [i] : []);
  if (heads.length === 0) return parseDetailed(lines);
  if (hasDetailedBlock(lines)) return { status: "ambiguous", detail: "a compact head line and a detailed Next block" };
  if (heads.length > 1) return { status: "ambiguous", detail: "two report lines" };
  const items = new Map<string, string>();
  const actions: Action[] = [];
  let label = "a";
  let warning = false;
  let unsafe = UNSAFE.test(lines[heads[0]]);
  // 0 items, 1 warnings, 2 next actions, 3 after the none line. The block ends at an empty line after stage 2 or 3.
  let stage = 0;
  for (const line of lines.slice(heads[0] + 1)) {
    if (EMPTY.test(line)) {
      if (stage === 2 && actions.length === 0) return { status: "ambiguous", detail: "next line with no action below it" };
      if (stage >= 2) break;
      continue;
    }
    unsafe ||= UNSAFE.test(line);
    let match: RegExpExecArray | null;
    if (stage === 3) return { status: "ambiguous", detail: "line after the none line" };
    if (NONE.test(line)) {
      if (stage === 2) return { status: "ambiguous", detail: "second next line" };
      stage = 3;
    } else if ((match = ITEM.exec(line))) {
      if (stage > 0) return { status: "ambiguous", detail: "item out of order" };
      if (match[1] !== String(items.size + 1)) return { status: "ambiguous", detail: "item numbers must restart at 1 and increase by 1" };
      items.set(match[1], match[2]);
    } else if (WARNING.test(line)) {
      if (stage > 1) return { status: "ambiguous", detail: "warning out of order" };
      warning = true;
      stage = 1;
    } else if (NEXT.test(line)) {
      if (stage === 2) return { status: "ambiguous", detail: "second next line" };
      stage = 2;
    } else if (stage === 2 && (match = ACTION.exec(line))) {
      const [, found, actor, condition, action] = match;
      if (found !== label) return { status: "ambiguous", detail: "action labels must restart at a and follow base-26 order" };
      actions.push({ label, actor: actor as Action["actor"], ...(condition ? { condition } : {}), text: action });
      label = nextActionLabel(label);
    } else {
      return { status: "ambiguous", detail: "line in the block matches no pattern" };
    }
  }
  if (items.size === 0) return { status: "ambiguous", detail: "no report items" };
  if (stage === 3) return { status: "none" };
  if (stage < 2) return { status: "missing" };
  if (actions.length === 0) return { status: "ambiguous", detail: "next line with no action below it" };
  return { status: "next", items, actions, warning, unsafe };
}

/** The proposed accepted text. The owner confirms the form at acceptance. */
export function acceptedText(action: Action): string {
  return `Continue action ${action.label}: ${action.text}`;
}

/** Independent labels cannot establish safe subject linkage. Any report-wide restriction suppresses the draft. */
export function suggestFromReport(report: Report): Suggestion {
  if (report.status === "missing" || report.status === "ambiguous") return { kind: "none", reason: report.status };
  if (report.status === "none") return { kind: "none", reason: "no-next" };
  if (report.unsafe) return { kind: "none", reason: "unsafe" };
  if (report.actions.some(action => action.actor !== "Agent")) return { kind: "none", reason: "owner" };
  if (report.actions.some(action => action.condition !== undefined)) return { kind: "none", reason: "conditional" };
  const states = [...report.items.values()];
  if (states.includes("Needs approval")) return { kind: "none", reason: "approval" };
  if (report.warning || states.some(state => state === "Retired" || state === "Proposal" || state === "Blocked")) {
    return { kind: "none", reason: "unlinked" };
  }
  const first = report.actions[0];
  const text = acceptedText(first);
  if ([...text].length > MAX_CHARS) return { kind: "none", reason: "overlong" };
  return { kind: "suggestion", action: first.label, text };
}

interface EntryLike { type?: unknown; message?: { role?: unknown; stopReason?: unknown; content?: unknown } }

/**
 * The text of the final assistant message of a branch, or undefined.
 * The last message of the branch must be an assistant message that stopped normally. A later user message,
 * tool result or custom message means that the report is not the current one. Tool output is never read.
 */
export function finalAssistantText(branch: readonly unknown[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as EntryLike | undefined;
    if (!entry || (entry.type !== "message" && entry.type !== "custom_message")) continue;
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "assistant" || message.stopReason !== "stop") return undefined;
    if (!Array.isArray(message.content)) return undefined;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("\n");
  }
  return undefined;
}

/** The suggestion of a session branch. */
export function suggestFromBranch(branch: readonly unknown[]): Suggestion {
  const text = finalAssistantText(branch);
  if (text === undefined) return { kind: "none", reason: "no-final-message" };
  return suggestFromReport(parseReport(text));
}
