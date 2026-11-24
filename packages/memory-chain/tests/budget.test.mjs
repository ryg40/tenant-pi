// Behavior 2: one clock. A stalled store cannot extend the budget, a late ranker gives links only,
// no ready store gives only the timeout line, and the stores stop at the budget minus the time that
// the ranker declares.
import test from "node:test";
import assert from "node:assert/strict";
import { BUDGET_MS, TIMEOUT_LINE, runChain } from "../src/core.mjs";
import { fakeClock, ranker, readyStore, stalledStore } from "./helpers.mjs";

const projects = new Set(["p:alpha"]);
const hit = (n, score) => ({ source: `note-${n}`, text: `EXCERPTMARK${n} body text`, score, project: "p:alpha" });

async function settle(clock, promise, ms = BUDGET_MS) {
	let done = false;
	promise.then(() => { done = true; }, () => { done = true; });
	await clock.advance(ms);
	return { done, result: await (done ? promise : Promise.resolve(null)) };
}

test("a stalled store cannot extend the budget, and its late reply is dropped", async () => {
	const clock = fakeClock();
	let lateAnswer;
	const lateStore = { name: "late-store", search: () => new Promise((resolve) => { lateAnswer = resolve; }) };
	const chain = runChain({ query: "q", stores: [readyStore("fast", [hit(1, 0.9)]), stalledStore("stalled"), lateStore],
		projects, approved: new Set(), clock });
	const { done, result } = await settle(clock, chain);
	assert.equal(done, true);
	assert.ok(result.totalMs <= BUDGET_MS);
	assert.equal(result.kind, "partial");
	assert.deepEqual(result.omitted.map((item) => item.store).sort(), ["late-store", "stalled"]);
	const before = result.block;
	lateAnswer({ status: "ready", hits: [{ ...hit(2, 1), source: "note-late" }] });
	await clock.advance(10);
	assert.equal(result.block, before);
	assert.ok(!result.block.includes("EXCERPTMARK2"));
	assert.ok(result.block.includes("EXCERPTMARK1"));
});

test("a ranker that answers after the budget gives links only, without excerpts", async () => {
	const clock = fakeClock();
	const rank = ranker(() => new Promise(() => {}));
	const chain = runChain({ query: "q", stores: [readyStore("fast", [hit(1, 0.9), hit(2, 0.4)])], projects,
		approved: new Set(), clock, rank });
	const { done, result } = await settle(clock, chain);
	assert.equal(done, true);
	assert.ok(result.totalMs <= BUDGET_MS);
	assert.equal(result.kind, "links");
	assert.ok(result.block.includes("note-1") && result.block.includes("note-2"));
	assert.ok(!result.block.includes("EXCERPTMARK"));
});

test("the declared ranker time sets the store deadline; no valid declaration gives links", async () => {
	// A store that answers shortly before the end of the budget.
	const nearEnd = BUDGET_MS - 100;
	const cases = [
		{ rank: ranker((candidates) => candidates.map((c) => c.id), 0), deadline: BUDGET_MS, ready: true, kind: "full" },
		{ rank: ranker((candidates) => candidates.map((c) => c.id), 400), deadline: BUDGET_MS - 400, ready: false },
		{ rank: (candidates) => candidates.map((c) => c.id), deadline: BUDGET_MS, ready: true, kind: "links" },
	];
	for (const item of cases) {
		const clock = fakeClock();
		const slow = { name: "slow", search: () => new Promise((resolve) => {
			clock.setTimeout(() => resolve({ status: "ready", hits: [hit(1, 0.9)] }), nearEnd);
		}) };
		const chain = runChain({ query: "q", stores: [slow], projects, approved: new Set(), clock, rank: item.rank });
		const { done, result } = await settle(clock, chain);
		assert.equal(done, true);
		assert.equal(result.storeDeadlineMs, item.deadline);
		assert.equal(result.steps.stores.slow.status, item.ready ? "ready" : "late");
		if (item.kind) assert.equal(result.kind, item.kind);
	}
});

test("no ready store gives only the timeout line", async () => {
	const clock = fakeClock();
	const chain = runChain({ query: "q", stores: [stalledStore("a"), stalledStore("b")], projects, approved: new Set(), clock });
	const { done, result } = await settle(clock, chain);
	assert.equal(done, true);
	assert.ok(result.totalMs <= BUDGET_MS);
	assert.equal(result.kind, "timeout");
	assert.equal(result.block, TIMEOUT_LINE);
});
