import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES_BLOCK, RULES_VERSION, estimateTokensFromText } from "../src/rules.ts";

test("rule block stays within the per-turn budget", () => {
	const tokens = estimateTokensFromText(RULES_BLOCK);
	assert.ok(tokens <= 500, `rule block is ~${tokens} tokens, budget is 500`);
});

test("rule block carries the core STE constraints", () => {
	for (const needle of ["One idea per sentence", "Active voice", "one meaning only", "No greetings", "Fenced code blocks"]) {
		assert.ok(RULES_BLOCK.includes(needle), `missing: ${needle}`);
	}
});

test("rule block itself obeys the 25-word descriptive limit per bullet sentence", () => {
	const bullets = RULES_BLOCK.split("\n").filter((l) => l.startsWith("- "));
	for (const bullet of bullets) {
		for (const sentence of bullet.slice(2).split(/(?<=[.!?])\s+/)) {
			const words = sentence.trim().split(/\s+/).filter(Boolean).length;
			assert.ok(words <= 25, `${words} words: ${sentence}`);
		}
	}
});

test("Claude Code plugin carries the identical rule block", async () => {
	const cc = (await import("../claude-code/scripts/rules.mjs")) as { RULES_BLOCK: string; RULES_VERSION: number };
	assert.equal(cc.RULES_BLOCK, RULES_BLOCK);
	assert.equal(cc.RULES_VERSION, RULES_VERSION);
});
