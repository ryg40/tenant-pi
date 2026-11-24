// Behavior 3: oversized input with long citations gives at most four excerpts and 3,000 characters.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CHARS, MAX_EXCERPTS, runChain, testRanker } from "../src/core.mjs";
import { fakeClock, ranker, readyStore, stalledStore } from "./helpers.mjs";

const projects = new Set(["p:alpha"]);

function bigHits(store, count) {
	return Array.from({ length: count }, (_, n) => ({
		source: `${store}-source-${n}-${"long-citation-".repeat(80)}`,
		text: `${store}MARK${n} ${"word ".repeat(1200)}`,
		score: 1 - n / 100,
		project: "p:alpha",
	}));
}

async function run(options) {
	const clock = fakeClock();
	const chain = runChain({ query: "q", projects, approved: new Set(), clock, ...options });
	await clock.advance(2000);
	return chain;
}

test("an oversized ranked input stays within four excerpts and the character limit", async () => {
	const result = await run({ stores: [readyStore("one", bigHits("one", 9)), readyStore("two", bigHits("two", 9))], rank: testRanker });
	assert.equal(result.kind, "full");
	assert.ok(result.selected.length >= 1 && result.selected.length <= MAX_EXCERPTS);
	assert.ok(result.block.length <= MAX_CHARS, `block of ${result.block.length} characters`);
	assert.equal(result.chars, result.block.length);
});

test("a long omission line counts in the total", async () => {
	const stores = [readyStore("one", bigHits("one", 9)),
		...Array.from({ length: 40 }, (_, n) => stalledStore(`stalled-store-with-a-long-name-${n}`))];
	const result = await run({ stores, rank: testRanker });
	assert.equal(result.kind, "partial");
	assert.ok(result.selected.length <= MAX_EXCERPTS);
	assert.ok(result.block.length <= MAX_CHARS, `block of ${result.block.length} characters`);
});

test("the links fallback with long citations stays within the character limit", async () => {
	const result = await run({ stores: [readyStore("one", bigHits("one", 30))], rank: ranker(() => new Promise(() => {})) });
	assert.equal(result.kind, "links");
	assert.ok(result.block.length <= MAX_CHARS, `block of ${result.block.length} characters`);
	assert.ok(!result.block.includes("oneMARK"));
});
