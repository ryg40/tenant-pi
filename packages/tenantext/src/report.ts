import { estimateTokensFromText } from "./rules.ts";

export interface SkillLike {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

export interface ContextFileLike {
	path: string;
	content: string;
}

export interface PromptOptionsLike {
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	contextFiles?: ContextFileLike[];
	skills?: SkillLike[];
}

export interface ReportInput {
	/** Base system prompt string, captured at session_start before any extension modified it. */
	baseSystemPrompt: string;
	/** Exact skills section length when the host formatter is available; falls back to an estimate. */
	skillsChars?: number;
	options: PromptOptionsLike;
	/** Length in chars of the chained system prompt seen by tenantext on the last turn, before its own append. */
	lastTurnChainedChars?: number;
	/** Length in chars of the tenantext rule block. */
	rulesChars: number;
	rulesEnabled: boolean;
	/** Actual input tokens of the first assistant reply in this session, if any. */
	firstRequestInputTokens?: number;
	/** Estimated tokens of messages currently in the session context. */
	messageTokens?: number;
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function xmlLength(str: string): number {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").length;
}

/**
 * Approximate the skills section size the way pi's formatSkillsForPrompt lays it out.
 * Constants measured against Pi 0.85.1: 368 chars of header and footer, 97 chars of
 * XML wrapper per skill. Not re-verified on the kit pin, Pi 1.0.3.
 * Used only when the exact formatter is not available.
 */
export function estimateSkillsChars(skills: SkillLike[] | undefined): number {
	if (!skills) return 0;
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return 0;
	let chars = 368;
	for (const s of visible) {
		chars += 97 + xmlLength(s.name) + xmlLength(s.description) + xmlLength(s.filePath);
	}
	return chars;
}

/** Size of pi's project_context section: wrapper plus each file's tag and content. */
export function estimateContextFilesChars(files: ContextFileLike[]): number {
	if (files.length === 0) return 0;
	let chars = 80; // "<project_context>" block header and footer text
	for (const f of files) {
		chars += 55 + f.path.length + f.content.length; // <project_instructions path="..."> ... </project_instructions>
	}
	return chars;
}

/** Build a Markdown report of the startup context by source. */
export function buildContextReport(input: ReportInput): string {
	const { options } = input;
	const baseChars = input.baseSystemPrompt.length;
	const skillsChars = input.skillsChars ?? estimateSkillsChars(options.skills);
	const contextFiles = options.contextFiles ?? [];
	const contextChars = estimateContextFilesChars(contextFiles);
	const appendChars = options.appendSystemPrompt?.length ?? 0;
	const guidelinesChars = (options.promptGuidelines ?? []).reduce((n, g) => n + g.length + 3, 0);
	const coreChars = Math.max(0, baseChars - skillsChars - contextChars - appendChars - guidelinesChars);
	const extensionChars =
		input.lastTurnChainedChars !== undefined ? Math.max(0, input.lastTurnChainedChars - baseChars) : undefined;

	const rows: Array<[string, number, string]> = [
		["Core prompt + tool guidance", coreChars, `${options.selectedTools?.length ?? 0} tools active`],
		["Skills listing", skillsChars, `${(options.skills ?? []).filter((s) => !s.disableModelInvocation).length} skills visible to the model`],
		["Context files (AGENTS.md etc.)", contextChars, `${contextFiles.length} files`],
		["Prompt guidelines", guidelinesChars, `${options.promptGuidelines?.length ?? 0} bullets`],
		["--append-system-prompt", appendChars, appendChars ? "set" : "none"],
	];
	if (extensionChars !== undefined) {
		rows.push(["Other extensions (last turn)", extensionChars, "before_agent_start additions by earlier-loaded extensions"]);
	}
	rows.push(["tenantext rules", input.rulesEnabled ? input.rulesChars : 0, input.rulesEnabled ? "prepended every turn" : "off"]);

	const lines: string[] = [];
	lines.push("## Startup context by source");
	lines.push("");
	lines.push("| Source | ~Tokens | Note |");
	lines.push("| --- | ---: | --- |");
	let total = 0;
	for (const [name, chars, note] of rows) {
		const t = estimateTokensFromText("x".repeat(chars));
		total += t;
		lines.push(`| ${name} | ${fmt(t)} | ${note} |`);
	}
	lines.push(`| **System prompt total** | **${fmt(total)}** | estimate, 4 chars per token |`);
	if (input.messageTokens !== undefined) {
		lines.push(`| Messages in context | ${fmt(input.messageTokens)} | pi estimate |`);
	}
	if (input.firstRequestInputTokens !== undefined) {
		lines.push(`| First request, actual input | ${fmt(input.firstRequestInputTokens)} | provider usage, includes tool schemas |`);
	}
	lines.push("");
	if (contextFiles.length > 0) {
		lines.push("### Context files");
		for (const f of contextFiles) {
			lines.push(`- \`${f.path}\`: ~${fmt(estimateTokensFromText(f.content))} tokens`);
		}
		lines.push("");
	}
	const heavy = [...(options.skills ?? [])]
		.filter((s) => !s.disableModelInvocation)
		.sort((a, b) => b.description.length - a.description.length)
		.slice(0, 5);
	if (heavy.length > 0) {
		lines.push("### Longest skill descriptions");
		for (const s of heavy) {
			lines.push(`- \`${s.name}\`: ${s.description.length} chars`);
		}
		lines.push("");
	}
	lines.push("Pi sends no request before the first prompt. The first request carries the full system prompt.");
	lines.push("Base prompt measured before the first turn. Run /reload after changing skills or tools to refresh it.");
	return lines.join("\n");
}
