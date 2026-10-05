import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContextReport, estimateContextFilesChars, estimateSkillsChars } from "../src/report.ts";
import { RULES_BLOCK } from "../src/rules.ts";

const skills = [
	{ name: "a", description: "x".repeat(100), filePath: "/s/a/SKILL.md" },
	{ name: "b", description: "y".repeat(50), filePath: "/s/b/SKILL.md", disableModelInvocation: true },
];

test("hidden skills do not count toward the listing size", () => {
	const both = estimateSkillsChars(skills);
	const visibleOnly = estimateSkillsChars([skills[0]]);
	assert.equal(both, visibleOnly);
	assert.equal(estimateSkillsChars([]), 0);
});

test("report is markdown with a table and totals", () => {
	const report = buildContextReport({
		baseSystemPrompt: "z".repeat(4000),
		options: { skills, contextFiles: [{ path: "/p/AGENTS.md", content: "c".repeat(800) }], selectedTools: ["read", "bash"] },
		lastTurnChainedChars: 6000,
		rulesChars: 1200,
		rulesEnabled: true,
		firstRequestInputTokens: 30633,
		messageTokens: 12,
	});
	assert.ok(report.startsWith("## Startup context by source"));
	assert.ok(report.includes("| Source | ~Tokens | Note |"));
	assert.ok(report.includes("| Skills listing |"));
	assert.ok(report.includes("Other extensions (last turn) | 500 |"));
	assert.ok(report.includes("| tenantext rules | 300 |"));
	assert.ok(report.includes("First request, actual input | 30,633 |"));
	assert.ok(report.includes("`/p/AGENTS.md`: ~200 tokens"));
	assert.ok(report.includes("| Context files (AGENTS.md etc.) | 237 |"), "wrapper chars counted");
	assert.ok(report.includes("### Longest skill descriptions"));
	assert.ok(!report.includes("`b`:"), "hidden skill listed");
});

test("report without a prior turn omits the extension row", () => {
	const report = buildContextReport({ baseSystemPrompt: "", options: {}, rulesChars: 10, rulesEnabled: false });
	assert.ok(!report.includes("Other extensions"));
	assert.ok(report.includes("| tenantext rules | 0 | off |"));
});

test("estimateSkillsChars matches pi's formatter layout for a plain skill", () => {
	// Layout from pi 0.85.1 formatSkillsForPrompt: 3 header lines, <available_skills>, per skill 4 lines, closing tag.
	const skill = { name: "n", description: "d & e", filePath: "/p/SKILL.md" };
	const header =
		"\n\nThe following skills provide specialized instructions for specific tasks.\n" +
		"Use the read tool to load a skill's file when the task matches its description.\n" +
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n" +
		"\n<available_skills>\n";
	const body = `  <skill>\n    <name>n</name>\n    <description>d &amp; e</description>\n    <location>/p/SKILL.md</location>\n  </skill>\n`;
	const exact = (header + body + "</available_skills>").length;
	const est = estimateSkillsChars([skill]);
	assert.ok(Math.abs(est - exact) <= 12, `estimate ${est} vs exact ${exact}`);
});

test("context file estimate covers the tags pi emits", () => {
	const exact = ("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n" +
		'<project_instructions path="/a/AGENTS.md">\nhello\n</project_instructions>\n\n' + "</project_context>\n").length;
	const est = estimateContextFilesChars([{ path: "/a/AGENTS.md", content: "hello" }]);
	assert.ok(Math.abs(est - exact) <= 12, `estimate ${est} vs exact ${exact}`);
	assert.equal(estimateContextFilesChars([]), 0);
});

test("skillsChars override replaces the estimate", () => {
	const report = buildContextReport({ baseSystemPrompt: "z".repeat(4000), options: { skills }, skillsChars: 2000, rulesChars: 0, rulesEnabled: false });
	assert.ok(report.includes("| Skills listing | 500 |"));
	assert.ok(report.includes("| Core prompt + tool guidance | 500 |"));
});

test("a base prompt captured at session start is not inflated by a later turn's rules append", () => {
	const base = "z".repeat(4000);
	const chained = base + "\n\nHERMES" + "\n\n" + RULES_BLOCK;
	const report = buildContextReport({ baseSystemPrompt: base, options: {}, lastTurnChainedChars: chained.length - RULES_BLOCK.length, rulesChars: RULES_BLOCK.length, rulesEnabled: true });
	assert.ok(report.includes("| Other extensions (last turn) | 3 |"), report);
	assert.ok(report.includes("| Core prompt + tool guidance | 1,000 |"));
});
