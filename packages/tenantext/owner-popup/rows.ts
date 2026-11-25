import { parseReport, type Action } from "../extensions/next-prompt/report.ts";

/**
 * Pure extraction of owner-task rows from a dummies report (compact syntax 2 or detailed syntax 1).
 * Reuses `parseReport` of `extensions/next-prompt/report.ts`; performs no I/O.
 */

export const FIXED_DECISION_OPTIONS = [
	"Not now: ask me again later",
	"Explain the trade-off first",
] as const;

export const OWNER_STEP_OPTIONS = [
	"Done",
	"Not now",
	"Ask the coordinator for another way",
] as const;

export const GRILLING_FIRST_OPTION = "Start a grilling round";
export const EXCERPT_MAX_CHARS = 800;
export const COMPACT_TASK_CHARS = 60;

export type RowKind = "split" | "open" | "grilling" | "owner_step";

export interface RowOption {
	id: string;
	text: string;
	probability?: number;
	recommended?: boolean;
}

export interface OwnerRow {
	label: string;
	actor: "Owner" | "Owner decides";
	condition?: string;
	text: string;
	kind: RowKind;
	riskByWords: boolean;
	risky: boolean;
	riskProbability?: number;
	noClearPick: boolean;
	writing: boolean;
	needsWriter: boolean;
	needsDecider: boolean;
	/** Full candidate pool sent to the decider (up to 5). */
	candidates: RowOption[];
	/** Shown options (up to 3), in current display order. */
	options: RowOption[];
	deciderApplied: boolean;
}

export interface ExtractedReport {
	eligible: boolean;
	reason?: string;
	excerpt: string;
	rows: OwnerRow[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^>/;
const EMPTY = /^ *$/;
const HEADING = /^## \S/;
const REPORT_HEAD = /^\*\*REPORT [1-9][0-9]*(?: \((?:[2-9]|[1-9][0-9]+) turns\))?\*\* \S(?:.*\S)?$/;
const OUTCOME_HEAD = /^\*\*OUTCOME\*\* \S(?:.*\S)?$/;
const WARNING_LINE = /^\*\*Warning:\*\*/;
const COMPACT_NEXT = /^\*\*Next:\*\*(?: None\..*)?$/;
const ADDED_LINE = /^added: \S/;
const GRILLING_MARKER = /\bneeds a grilling round\b/i;

// Fixed risk word list (PLAN-2 section 2.2, item 3). Fails closed when the decider is down.
// Bare words cover verbs/nouns that are inherently destructive or external; object patterns
// cover verbs (`drop`, `reset`, `force`, `stop`, `kill`, `restart`, `rotate`, `release`, `remove`,
// `rm`, `prune`) whose bare form tags harmless text at other positions. A row or option whose first
// word is one of those bare action words is risky with or without a known object; Markdown `*`, `_`
// or `` ` `` around that word is skipped. A false "risky" costs the owner one more click and is accepted.
const RISK_LEADING_ACTION =
	/^\s*[*_`]*(?:drop|reset|force|stop|kill|restart|rotate|release|remove|rm|prune)(?=[*_`]*\b)/i;
const RISK_WORD_PATTERN =
	/\b(?:push|pushed|pushing|deploy|deployed|deploying|deployment|deployments|publish|published|publishing|reboot|rebooted|rebooting|shutdown|delete|deleted|deleting|deletion|truncate|truncated|truncating|truncation|purge|purged|purging|destroy|destroyed|destroying|wipe|wiped|wiping|overwrite|overwrote|overwritten|overwriting|revoke|revoked|revoking|revocation|uninstall|uninstalled|uninstalling|secret|secrets|credential|credentials|password|passwords|production)\b/i;
const RISK_RELEASE_ACTION =
	/\b(?:cut|make|ship|tag|publish|create|approve|run|start)\s+(?:a\s+|the\s+|this\s+)?release\b|\brelease\s+(?:now|entry|to\b|it\b|this\b|v?\d)/i;
const RISK_REMOVE_ACTION =
	/\b(?:remove|removed|removing|rm|prune|pruned|pruning)\s+[^\n.?!]{0,40}\b(?:branch|branches|tag|tags|data|secret|secrets|key|keys|token|tokens|credential|credentials|volume|volumes|database|databases|db|table|tables|schema|schemas|bucket|buckets|cluster|clusters|container|containers|service|services|backup|backups|snapshot|snapshots|user|users|prod|production)\b/i;
const RISK_DROP_ACTION =
	/\bdrop(?:ped|ping)?\s+(?:(?:the|a|an|all|old|existing|stale|this|that)\s+)?(?:[\w-]+\s+){0,3}(?:table|tables|database|databases|db|schema|schemas|index|indexes|indices|column|columns|view|views|collection|collections|bucket|buckets|volume|volumes|branch|branches|tag|tags|data|backup|backups|snapshot|snapshots|user|users|role|roles|secret|secrets|key|keys|container|containers|pod|pods|cluster|clusters|queue|queues)\b/i;
const RISK_RESET_ACTION =
	/\breset(?:ting)?\s+(?:(?:the|a|an|all|this|that)\s+)?(?:[\w-]+\s+){0,3}(?:hard|branch|branches|head|repo|repository|git|database|databases|db|table|tables|schema|schemas|state|data|password|passwords|secret|secrets|token|tokens|key|keys|credential|credentials|config|configuration|cluster|server|service|host|vm|node|volume|index|cache|migrations?)\b|\b(?:hard|factory)\s+reset\b|\bgit\s+reset\b/i;
const RISK_FORCE_ACTION =
	/\bforce[- ](?:push(?:ed|ing)?|delete|remove|drop|merge|reset|overwrite|recreate|rebuild|update|upgrade|reinstall|uninstall|stop|kill|restart|deploy|publish|release|sync|clean|prune|checkout)\b|(?:^|\s)--force(?=\s|$|[.,;?!])/i;
const RISK_LIFECYCLE_ACTION =
	/\b(?:stop(?:ped|ping)?|kill(?:ed|ing)?|restart(?:ed|ing)?)\s+(?:(?:the|a|an|all|this|that|old|stuck|hung|running|live|active)\s+)?(?:[\w-]+\s+){0,3}(?:service|services|server|servers|daemon|daemons|worker|workers|container|containers|pod|pods|cluster|clusters|runner|runners|node|nodes|host|hosts|vm|vms|machine|machines|database|databases|db|proxy|proxies|gateway|gateways|queue|queues|broker|brokers|process|processes|pid|pids|job|jobs|task|tasks|agent|agents|stack|stacks|instance|instances|unit|units|session|sessions|pane|panes|terminal|terminals|app|apps)\b|\bkill\s+-[A-Za-z0-9]+\b/i;
const RISK_ROTATE_ACTION =
	/\b(?:rotate|rotated|rotating|rotation\s+of)\s+(?:(?:the|a|an|all|old|existing|this|that)\s+)?(?:[\w-]+\s+){0,3}(?:key|keys|secret|secrets|token|tokens|credential|credentials|cert|certs|certificate|certificates|password|passwords|passphrase|passphrases)\b|\b(?:key|keys|secret|secrets|token|tokens|credential|credentials|cert|certs|certificate|certificates|password|passwords|passphrase|passphrases)\s+rotation\b/i;

export function isRiskyByWords(text: string): boolean {
	return (
		RISK_LEADING_ACTION.test(text) ||
		RISK_WORD_PATTERN.test(text) ||
		RISK_RELEASE_ACTION.test(text) ||
		RISK_REMOVE_ACTION.test(text) ||
		RISK_DROP_ACTION.test(text) ||
		RISK_RESET_ACTION.test(text) ||
		RISK_FORCE_ACTION.test(text) ||
		RISK_LIFECYCLE_ACTION.test(text) ||
		RISK_ROTATE_ACTION.test(text)
	);
}

/** Strip code fences and quote lines using the same fence rule as `report.ts`. */
function unfencedLines(text: string): string[] {
	const out: string[] = [];
	let close: RegExp | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (close) {
			if (close.test(line)) close = undefined;
			continue;
		}
		const fence = FENCE_OPEN.exec(line);
		if (fence) {
			close = new RegExp(`^ {0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},} *$`);
			continue;
		}
		if (!QUOTE.test(line)) out.push(line);
	}
	return out;
}

/**
 * Bounded excerpt for model requests (at most `maxChars`, default 800):
 * - Strips code fences and `>` quote lines first.
 * - Recognizes compact format (`**REPORT ...**` / `**OUTCOME**`) only at the report's legal start
 *   (the first non-empty readable line, or the first non-empty line after an `added:` line), never by
 *   searching later sections; takes that header line and any `**Warning:**` lines before `**Next:**` or `## `.
 * - Otherwise treats the text as detailed format and takes only the first paragraph and any `**Warning:**`
 *   lines before the first `## ` heading. Never reads `## Checks`, later `## ` sections, code fences, or transcript.
 */
export function extractExcerpt(reportText: string, maxChars = EXCERPT_MAX_CHARS): string {
	const lines = unfencedLines(reportText);
	let start = lines.findIndex((line) => !EMPTY.test(line));
	if (start >= 0 && ADDED_LINE.test(lines[start])) {
		start = lines.findIndex((line, i) => i > start && !EMPTY.test(line));
	}
	if (start < 0) return "";

	const parts: string[] = [];

	if (REPORT_HEAD.test(lines[start]) || OUTCOME_HEAD.test(lines[start])) {
		parts.push(lines[start].trim());
		for (const line of lines.slice(start + 1)) {
			if (COMPACT_NEXT.test(line) || HEADING.test(line)) break;
			if (WARNING_LINE.test(line)) parts.push(line.trim());
		}
	} else {
		// Collect only lines before the first `## ` heading so `## Checks` and later sections never enter.
		const intro: string[] = [];
		for (let i = start; i < lines.length; i++) {
			if (HEADING.test(lines[i])) break;
			intro.push(lines[i]);
		}
		const firstParagraph: string[] = [];
		let inFirst = true;
		for (const line of intro) {
			if (EMPTY.test(line)) {
				if (firstParagraph.length > 0) inFirst = false;
				continue;
			}
			if (inFirst && !WARNING_LINE.test(line)) {
				firstParagraph.push(line.trim());
			} else if (WARNING_LINE.test(line)) {
				parts.push(line.trim());
			}
		}
		if (firstParagraph.length > 0) parts.unshift(firstParagraph.join(" "));
	}

	const joined = parts.join("\n").replace(/[ \t]+/g, " ").trim();
	if (joined.length <= maxChars) return joined;
	return `${joined.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function firstSentence(text: string): string {
	const trimmed = text.trim();
	const match = /[.?!](?=\s+[A-Z]|$)/.exec(trimmed);
	const raw = match ? trimmed.slice(0, match.index) : trimmed;
	return raw.replace(/[.?!]+$/, "").trim();
}

function sentenceCase(part: string): string {
	const trimmed = part.trim();
	return trimmed.replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

const CLAUSE_FRAGMENT_PREFIX =
	/^(?:if|when|while|unless|because|since|although|though|however|therefore|otherwise|which|that|who|where|whose|whom|including|especially|namely|such\s+as|for\s+example|e\.g\.|i\.e\.|etc\.?)\b/i;

// Closed function words that cannot carry a standalone choice (verb or noun) on their own.
const FUNCTION_WORDS = new Set([
	"a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "by", "from", "as",
	"into", "onto", "before", "after", "during", "until", "over", "under", "between",
	"through", "about", "against", "without", "and", "or", "but", "nor", "yet", "so",
	"if", "then", "else", "when", "while", "that", "this", "these", "those", "it", "its",
	"they", "them", "their", "we", "us", "our", "you", "your", "he", "him", "his", "she",
	"her", "my", "no", "not", "yes", "please", "maybe", "soon", "later", "now", "here",
	"there", "still", "already", "only", "just", "also", "too", "very", "more", "most",
	"less", "all", "any", "some", "each", "every", "both", "either", "neither", "other",
	"another", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
	"do", "does", "did", "will", "would", "shall", "should", "can", "could", "may",
	"might", "must",
]);

function hasSubstantiveWord(part: string): boolean {
	if (CLAUSE_FRAGMENT_PREFIX.test(part)) return false;
	const tokens = part.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g);
	if (!tokens || tokens.length === 0) return false;
	return tokens.some((tok) => !FUNCTION_WORDS.has(tok.toLowerCase()));
}

const SHORT_LOWER_TERM = /^[a-z0-9][a-z0-9._-]{1,23}$/;
const SHORT_UPPER_TERM = /^[A-Z0-9][A-Z0-9._-]{1,23}$/;

function isShortTermEnumAfterColon(body: string): boolean {
	const match = /^(.+?)\s+or\s+([^,\s]+)$/i.exec(body);
	if (!match) return false;
	const head = match[1].split(/,\s+/);
	if (head.length < 2 || head.length > 3) return false;
	const terms = [...head, match[2]];
	return terms.every((t) => SHORT_LOWER_TERM.test(t)) || terms.every((t) => SHORT_UPPER_TERM.test(t));
}

/**
 * Returns `text` with the inside of balanced `( )`, `[ ]` and backtick code spans replaced by `_`,
 * at the same length, so split tests and cut positions ignore them. An unbalanced bracket or
 * backtick protects nothing from that point on.
 */
function maskProtectedSpans(text: string): string {
	const out = text.split("");
	const stack: { close: string; start: number }[] = [];
	const mask = (from: number, to: number) => {
		for (let k = from; k < to; k++) out[k] = "_";
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			if (end >= 0) {
				if (stack.length === 0) mask(i + 1, end);
				i = end + 1;
				continue;
			}
		} else if (ch === "(" || ch === "[") {
			stack.push({ close: ch === "(" ? ")" : "]", start: i });
		} else if ((ch === ")" || ch === "]") && stack.length > 0 && stack[stack.length - 1].close === ch) {
			const open = stack.pop();
			if (open && stack.length === 0) mask(open.start + 1, i);
		}
		i++;
	}
	return out.join("");
}

/** Splits `text` at the matches of `separator` in `masked` (same length), keeping the original text of each part. */
function splitAtMasked(text: string, masked: string, separator: RegExp): string[] {
	const parts: string[] = [];
	const re = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : `${separator.flags}g`);
	let last = 0;
	for (const match of masked.matchAll(re)) {
		parts.push(text.slice(last, match.index));
		last = match.index + match[0].length;
	}
	parts.push(text.slice(last));
	return parts;
}

/**
 * Strict choice splitter (PLAN-2 section 2.1):
 * reads the first sentence, takes text after the last `: ` when present,
 * splits on `, or `, ` or `, and `, `, and accepts 2 to 4 distinct parts of 2 to 120 characters.
 *
 * Rejected cases (returned as `null` so the writer fills open answers):
 * - comma lists without `: ` and with no `or`;
 * - two-part comma pairs after `: ` with no `or` (e.g. `Paris, France`);
 * - comma + bare `or` mixes (e.g. `Paris, France or London`, `Austin, TX or Seattle`), except
 *   explicit 3- or 4-term uniform-case single-word lists after `: ` (e.g. `JSON, YAML or TOML`,
 *   `debug, info or warn`);
 * - duplicate parts, parts outside 2 to 120 characters, or fragments with no standalone verb or noun.
 *
 * A comma or `or` inside balanced `( )`, `[ ]` or a backtick code span is not a split point and does not count in the tests.
 */
export function splitChoices(text: string): string[] | null {
	const sentence = firstSentence(text);
	if (!sentence) return null;
	const colonIndex = sentence.lastIndexOf(": ");
	const hasColon = colonIndex >= 0;
	const body = hasColon ? sentence.slice(colonIndex + 2).trim() : sentence;
	if (!body) return null;

	const masked = maskProtectedSpans(body);
	const hasCommaOr = /,\s+or\s+/i.test(masked);
	const hasBareOr = /(?<!,)\s+or\s+/i.test(masked);
	const hasOr = hasCommaOr || hasBareOr;
	const hasPlainComma = /,\s+(?!or\s+)/i.test(masked);

	// Without `: `, require an explicit `or` alternative so ordinary comma clauses do not split.
	if (!hasColon && !hasOr) return null;
	// A plain comma mixed with a bare `or` is ambiguous (e.g. `Paris, France or London`),
	// except an explicit 3- or 4-term uniform-case single-word list after `: ` (e.g. `JSON, YAML or TOML`).
	if (hasPlainComma && hasBareOr && !(hasColon && isShortTermEnumAfterColon(masked))) return null;

	const rawParts = splitAtMasked(body, masked, /,\s+or\s+|\s+or\s+|,\s+/i).map((p) => p.trim());
	if (rawParts.length < 2 || rawParts.length > 4) return null;
	// Two comma-separated parts after `: ` with no `or` are often an appositive or date (`Paris, France`).
	if (!hasOr && rawParts.length === 2) return null;

	const parts: string[] = [];
	const seen = new Set<string>();
	for (const raw of rawParts) {
		const cleaned = sentenceCase(raw.replace(/[.?!;:]+$/, "").trim());
		if (cleaned.length < 2 || cleaned.length > 120) return null;
		if (!hasSubstantiveWord(cleaned)) return null;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) return null;
		seen.add(key);
		parts.push(cleaned);
	}
	return parts;
}

export function makeOptions(texts: readonly string[]): RowOption[] {
	return texts.slice(0, 5).map((text, index) => ({
		id: `o${index + 1}`,
		text,
	}));
}

export function buildRow(action: Action & { actor: "Owner" | "Owner decides" }): OwnerRow {
	const riskByWords = isRiskyByWords(action.text);

	if (action.actor === "Owner") {
		const options = makeOptions(OWNER_STEP_OPTIONS);
		return {
			label: action.label,
			actor: action.actor,
			...(action.condition ? { condition: action.condition } : {}),
			text: action.text,
			kind: "owner_step",
			riskByWords,
			risky: riskByWords,
			noClearPick: false,
			writing: false,
			needsWriter: false,
			needsDecider: false,
			candidates: options,
			options: options.slice(0, 3),
			deciderApplied: false,
		};
	}

	if (GRILLING_MARKER.test(action.text)) {
		const split = splitChoices(action.text);
		const rowRisk = riskByWords || (split?.some(isRiskyByWords) ?? false);
		const texts = [
			GRILLING_FIRST_OPTION,
			...(split ?? FIXED_DECISION_OPTIONS),
		].slice(0, 5);
		const candidates = makeOptions(texts);
		return {
			label: action.label,
			actor: action.actor,
			...(action.condition ? { condition: action.condition } : {}),
			text: action.text,
			kind: "grilling",
			riskByWords: rowRisk,
			risky: rowRisk,
			noClearPick: false,
			writing: false,
			needsWriter: false,
			needsDecider: false,
			candidates,
			options: candidates.slice(0, 3),
			deciderApplied: false,
		};
	}

	const split = splitChoices(action.text);
	if (split) {
		const rowRisk = riskByWords || split.some(isRiskyByWords);
		const combined = [...split];
		for (const fixed of FIXED_DECISION_OPTIONS) {
			if (combined.length < 5 && !combined.some((item) => item.toLowerCase() === fixed.toLowerCase())) {
				combined.push(fixed);
			}
		}
		const candidates = makeOptions(combined);
		return {
			label: action.label,
			actor: action.actor,
			...(action.condition ? { condition: action.condition } : {}),
			text: action.text,
			kind: "split",
			riskByWords: rowRisk,
			risky: rowRisk,
			noClearPick: false,
			writing: false,
			needsWriter: false,
			needsDecider: true,
			candidates,
			options: candidates.slice(0, 3),
			deciderApplied: false,
		};
	}

	return {
		label: action.label,
		actor: action.actor,
		...(action.condition ? { condition: action.condition } : {}),
		text: action.text,
		kind: "open",
		riskByWords,
		risky: riskByWords,
		noClearPick: false,
		writing: true,
		needsWriter: true,
		needsDecider: true,
		candidates: [],
		options: [],
		deciderApplied: false,
	};
}

/** Parse a dummies report and return eligible owner-task rows and the bounded excerpt. */
export function extractOwnerRows(reportText: string): ExtractedReport {
	const parsed = parseReport(reportText);
	if (parsed.status !== "next") {
		return { eligible: false, reason: parsed.status, excerpt: "", rows: [] };
	}
	if (parsed.unsafe) {
		return { eligible: false, reason: "unsafe", excerpt: "", rows: [] };
	}
	const ownerActions = parsed.actions.filter(
		(action): action is Action & { actor: "Owner" | "Owner decides" } =>
			action.actor === "Owner" || action.actor === "Owner decides",
	);
	if (ownerActions.length === 0) {
		return { eligible: false, reason: "no-owner-actions", excerpt: "", rows: [] };
	}
	return {
		eligible: true,
		excerpt: extractExcerpt(reportText),
		rows: ownerActions.map(buildRow),
	};
}

/** Cut text cleanly for compact cards (PLAN-3 section 8, item 2: about 60 characters). */
export function truncateTask(text: string, maxChars = COMPACT_TASK_CHARS): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return clean;
	const cut = clean.slice(0, Math.max(1, maxChars - 3));
	const lastSpace = cut.lastIndexOf(" ");
	const trimmed = lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut;
	return `${trimmed.trimEnd()}...`;
}

/** Short subject label for the `[Owner popup]` one-line answer format (mockup state 4). */
export function shortSubject(taskText: string, maxChars = 56): string {
	const clean = taskText.replace(/\s+/g, " ").trim();
	const colonIndex = clean.indexOf(": ");
	const base = (colonIndex > 0 ? clean.slice(0, colonIndex) : clean).replace(/[.?!]+$/, "").trim();
	if (base.length <= maxChars) return base;
	const cut = base.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
