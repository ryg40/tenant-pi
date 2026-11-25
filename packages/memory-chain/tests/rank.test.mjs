// The decider ranker: the fallback, the placeholder strip and the refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { rankWithDecider } from "../src/decider-rank.mjs";
import { closedPort, fakeDecider } from "./helpers.mjs";

const KEY = { apiKey: "k" };
const CANDIDATES = ["a", "b", "c", "d", "e"].map((id) => ({ id, text: `memory ${id}` }));
const FIRST_THREE = [{ id: "a", p: null, rank: 1 }, { id: "b", p: null, rank: 2 }, { id: "c", p: null, rank: 3 }];
const VALID = (body) => ({ status: 200, json: { answers: { pick: { probabilities: Object.fromEntries(
	Object.keys(body.questions.pick.criteria).map((key) => [key, key === "c1" ? 0.9 : 0.05])) } } } });

test("fallback: a decider that is down or slow gives the first 3 in the given order and no throw", async (t) => {
	const down = await rankWithDecider("q", CANDIDATES, { ...KEY, baseUrl: await closedPort() });
	assert.equal(down.fallback, true);
	assert.deepEqual(down.ranked, FIRST_THREE);

	// The slow fake sends a valid answer after its delay: only the client limit (600 ms) makes this a fallback.
	const slow = await fakeDecider(t, { delayMs: 1500, reply: VALID });
	const started = Date.now();
	const late = await rankWithDecider("q", CANDIDATES, { ...KEY, baseUrl: slow.base });
	assert.equal(late.fallback, true);
	assert.deepEqual(late.ranked, FIRST_THREE);
	assert.ok(Date.now() - started < 1100, "the client limit ends the wait well before the delay");
});

test("placeholder strip: a privacy token in the query or a text does not reach the decider", async (t) => {
	const decider = await fakeDecider(t, { reply: VALID });
	const result = await rankWithDecider("QUERYMARK {{ov_privacy:sample:key}} steps", [
		{ id: "x", text: "the {{ov_privacy:sample:key}} ALPHAMARK build runs" },
		{ id: "y", text: "name {{ov_privacy_sample_key}} BETAMARK.md" },
	], { ...KEY, baseUrl: decider.base });
	assert.equal(result.fallback, false);
	const sent = JSON.stringify(decider.requests[0]);
	for (const marker of ["QUERYMARK", "ALPHAMARK", "BETAMARK"]) assert.ok(sent.includes(marker), marker);
	assert.equal(sent.includes("ov_privacy"), false);
});

test("refusal: a base URL that is not loopback, or no key, gives the fallback and sends no request", async (t) => {
	// A non-loopback address of this computer reaches the listening fake when the check fails; with none, a documentation address.
	const own = Object.values(networkInterfaces()).flat().find((item) => item && item.family === "IPv4" && !item.internal);
	const listener = await fakeDecider(t, { reply: VALID, host: own ? "0.0.0.0" : "127.0.0.1" });
	const outside = own ? own.address : [192, 0, 2, 1].join(".");
	const refused = await rankWithDecider("q", CANDIDATES, { ...KEY, baseUrl: `http://${outside}:${listener.port}` });
	assert.deepEqual(refused, { ranked: FIRST_THREE, fallback: true, reason: "not loopback" });
	const keyless = await rankWithDecider("q", CANDIDATES, { baseUrl: listener.base, env: {} });
	assert.deepEqual(keyless, { ranked: FIRST_THREE, fallback: true, reason: "no key" });
	assert.equal(listener.count(), 0);
});
