import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { renderPrMarkdown, type PrData } from "../src/pr.ts";

/** Copies and documented formats stay byte-identical to their sources. */

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), "utf8");

test("the GitHub PR template mirrors the Gitea one byte for byte and both carry the slopscore section", () => {
	const gitea = read(".gitea/PULL_REQUEST_TEMPLATE.md");
	assert.equal(read(".github/PULL_REQUEST_TEMPLATE.md"), gitea);
	assert.match(gitea, /^## slopscore$/m);
	assert.match(gitea, /skills\/slopscore-pr\/SKILL\.md/);
});

test("the README block format is exactly what the renderer prints for the documented example", () => {
	const example: PrData = {
		scope: { branch: "feature/x", base: "origin/main", commits: 3, days: 2 },
		localTraces: true,
		trace: { sessions: 4, calls: 61, spend: 7.2, effortShare: 0.88, modelPoints: 18, roles: [
			{ role: "main", mainModel: "claude-fable-5-1", topThinking: "high", share: 0.74 },
			{ role: "subagent:reviewer", mainModel: "gpt-5.6-luna", topThinking: "xhigh", share: 0.26 },
		] },
		provenance: { codeCommits: 3, modelTrailerCommits: 3, ticketReferences: ["#12"], fixOrReviewCommits: 2 },
		bundle: { concepts: 12, keptCurrentShare: 1 },
		flags: [],
		generatedOn: "2026-09-19",
	};
	const readme = read("README.md");
	assert.ok(readme.includes("```markdown\n" + renderPrMarkdown(example) + "\n```"), "README carries the rendered example block");
	assert.match(readme, /\[`skills\/slopscore-pr\/SKILL\.md`\]\(skills\/slopscore-pr\/SKILL\.md\)/);
	for (const row of ["| Pi | `/slopscore pr", "| Claude Code | `/slopscore pr", "| Shell | `node --experimental-strip-types slopscore/src/cli.ts pr"]) assert.ok(readme.includes(row), row);
	assert.match(read("slopscore/effort-score.md"), /^### Reading a PR block$/m);
});
