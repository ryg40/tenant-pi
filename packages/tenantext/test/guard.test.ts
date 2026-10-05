import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuardState, onAgentStart, onInput, onProviderRequest, statusText } from "../src/guard.ts";

test("human input passes and arms nothing", () => {
	const s = createGuardState();
	assert.equal(onInput(s, "interactive", true), "allow");
	assert.equal(s.humanPromptSeen, true);
	assert.equal(onInput(s, "extension", true), "allow");
	assert.equal(s.blockedInputs, 0);
});

test("extension input before a human prompt is blocked when guard is on", () => {
	const s = createGuardState();
	assert.equal(onInput(s, "extension", true), "block");
	assert.equal(s.blockedInputs, 1);
	assert.equal(s.humanPromptSeen, false);
});

test("extension input before a human prompt passes when guard is off", () => {
	const s = createGuardState();
	assert.equal(onInput(s, "extension", false), "allow");
	assert.equal(s.blockedInputs, 0);
});

test("rpc input counts as human", () => {
	const s = createGuardState();
	assert.equal(onInput(s, "rpc", true), "allow");
	assert.equal(s.humanPromptSeen, true);
});

test("resumed session with prior human message starts passed", () => {
	const s = createGuardState(true);
	assert.equal(onInput(s, "extension", true), "allow");
});

test("agent start without a human prompt is flagged every time and keeps the guard armed", () => {
	const s = createGuardState();
	assert.equal(onAgentStart(s), true);
	assert.equal(onAgentStart(s), true);
	assert.equal(s.unverifiedRuns, 2);
	assert.equal(s.humanPromptSeen, false);
	assert.equal(onInput(s, "extension", true), "block");
	onInput(s, "interactive", true);
	assert.equal(onAgentStart(s), false);
	assert.equal(s.unverifiedRuns, 2);
});

test("provider requests before human prompt are counted", () => {
	const s = createGuardState();
	assert.equal(onProviderRequest(s), true);
	assert.equal(s.requestsBeforeHuman, 1);
	onInput(s, "interactive", true);
	assert.equal(onProviderRequest(s), false);
	assert.equal(s.requestsTotal, 2);
});

test("status text reflects state", () => {
	const s = createGuardState();
	assert.equal(statusText(s, true, true), "STE on · guard armed");
	onInput(s, "extension", true);
	assert.equal(statusText(s, true, true), "STE on · guard armed · 1 flagged");
	onInput(s, "interactive", true);
	assert.equal(statusText(s, false, false), "STE off · guard off · 1 flagged");
});
