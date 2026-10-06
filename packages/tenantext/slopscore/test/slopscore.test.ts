import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate, parseClaudeSession } from "../src/claude-trace.ts";
import { parsePiSession, piRole } from "../src/pi-trace.ts";
import { aggregate, effortShare, points, renderReport } from "../src/report.ts";
import { DEFAULT_PRICES, DEFAULT_TIERS, loadConfig, priceCall, thinkingFactor, tierFor } from "../src/tiers.ts";

const cfg = loadConfig("/nonexistent/tiers.json");

test("tiers: fable top, gpt-6-astra next, gpt-5.6-sol group interchangeable, small local lowest, unknown flagged", () => {
	assert.equal(tierFor("claude-fable-5-1").weight, 1.0);
	assert.equal(tierFor("gpt-6-astra").weight, 0.9);
	assert.equal(tierFor("gpt-5.6-sol").weight, 0.8);
	assert.equal(tierFor("gpt-5.6-luna").weight, 0.8);
	assert.equal(tierFor("gpt-5.6-terra").weight, 0.45);
	for (const id of ["gpt-6.1-sol", "gpt-6-luna"]) assert.equal(tierFor(id).weight, 0.8);
	assert.equal(tierFor("gpt-6-terra").weight, 0.45);
	assert.equal(tierFor("moonshotai/kimi-k3").weight, 0.8);
	assert.equal(tierFor("zai/glm-5.3").weight, 0.8);
	assert.equal(tierFor("meta/muse-spark-1.3").weight, 0.8);
	assert.equal(tierFor("Qwen3.6-27B-Q6_K.gguf").weight, 0.45);
	assert.equal(tierFor("qwen3-8b-fp16").weight, 0.3);
	assert.equal(tierFor("mystery-model").name, "unknown");
	for (const nickname of ["astra", "sol", "luna", "terra"]) assert.equal(tierFor(nickname).name, "unknown");
	const withNickname = [{ name: "T2 frontier", weight: 0.9, patterns: ["astra"] }, ...DEFAULT_TIERS];
	assert.equal(tierFor("astra", withNickname).weight, 0.9);
	assert.equal(thinkingFactor("xhigh"), 1.0);
	assert.equal(thinkingFactor("medium"), 0.85);
	assert.equal(thinkingFactor(undefined), 0.9);
});

test("priceCall uses list prices and returns null for unknown models", () => {
	const c = priceCall("claude-sonnet-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, DEFAULT_PRICES);
	assert.equal(c, 2);
	assert.equal(priceCall("gpt-5.6-sol", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
});

const piSession = [
	{ type: "session", version: 3, id: "s1", timestamp: "2026-09-19T00:00:00.000Z", cwd: "/p" },
	{ type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" },
	{ type: "thinking_level_change", thinkingLevel: "medium" },
	{ type: "session_info", name: "subagent-reviewer-abc-1" },
	{ type: "message", timestamp: "2026-09-19T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
	{ type: "message", timestamp: "2026-09-19T00:01:05.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", stopReason: "toolUse", usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } }, content: [{ type: "toolCall", name: "read" }, { type: "toolCall", name: "bash" }] } },
	{ type: "message", timestamp: "2026-09-19T00:01:10.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", stopReason: "aborted", usage: { input: 1, output: 1, cost: { total: 9 } }, content: [] } },
	{ type: "message", timestamp: "2026-09-19T00:01:20.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", stopReason: "stop", usage: { input: 1200, output: 80, cacheRead: 900, cacheWrite: 0, cost: { total: 0.2 } }, content: [{ type: "text", text: "done" }] } },
].map((e) => JSON.stringify(e)).join("\n");

test("pi parser: role from session_info, thinking tracked, aborted turns skipped, tools captured", () => {
	const recs = parsePiSession("/x/sessions/subagent/abc/run-0/session.jsonl", piSession);
	assert.equal(recs.length, 2);
	assert.equal(recs[0].role, "subagent:reviewer");
	assert.equal(recs[0].thinking, "medium");
	assert.equal(recs[0].cost, 0.4);
	assert.deepEqual(recs[0].tools, ["read", "bash"]);
	assert.equal(recs[0].cwd, "/p");
	assert.equal(piRole(undefined, "/x/sessions/--home--/a.jsonl"), "main");
});

test("aggregate: tool split, role and model buckets, effort share and points", () => {
	const recs = parsePiSession("/x/main.jsonl", piSession);
	const agg = aggregate(recs, cfg);
	assert.ok(Math.abs(agg.total.cost - 0.6) < 1e-9);
	assert.ok(Math.abs(agg.byTool.get("read")!.cost - 0.2) < 1e-9);
	assert.ok(Math.abs(agg.byTool.get("bash")!.cost - 0.2) < 1e-9);
	assert.ok(Math.abs(agg.byTool.get("(no tool)")!.cost - 0.2) < 1e-9);
	// gpt-5.6-sol 0.8 × medium 0.85
	assert.ok(Math.abs(effortShare(agg.total) - 0.68) < 1e-9);
	assert.equal(points(agg.total), 14);
	const md = renderReport(agg, cfg, "t");
	assert.ok(md.includes("| pi/gpt-5.6-sol | T3 frontier commodity | 0.80 | medium ×2 |"));
	assert.ok(md.includes("Reviewer roles seen: subagent:reviewer"));
});

const claudeSession = [
	{ type: "user", timestamp: "2026-09-19T00:00:00.000Z", sessionId: "c1", cwd: "/p", message: { role: "user", content: "go" } },
	{ type: "assistant", requestId: "r1", uuid: "u1", effort: "high", timestamp: "2026-09-19T00:00:01.000Z", sessionId: "c1", message: { model: "claude-fable-5-1", usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 }, content: [{ type: "text", text: "x" }] } },
	{ type: "assistant", requestId: "r1", uuid: "u2", effort: "high", timestamp: "2026-09-19T00:00:02.000Z", sessionId: "c1", message: { model: "claude-fable-5-1", usage: { input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 }, content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Review it", model: "fable" } }] } },
	{ type: "user", timestamp: "2026-09-19T00:00:03.000Z", sessionId: "c1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched. agentId: abc123def456 (internal)" }] } },
	{ type: "assistant", requestId: "r2", uuid: "u3", effort: "high", timestamp: "2026-09-19T00:00:04.000Z", sessionId: "c1", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1000, output_tokens: 10 }, content: [{ type: "text", text: "title" }] } },
	{ type: "cost-state", sessionId: "c1", modelUsage: { "claude-fable-5-1": { costUSD: 1.0 }, "claude-haiku-4-5-20251001": { costUSD: 0.002 } } },
].map((e) => JSON.stringify(e)).join("\n");

test("claude parser: one record per requestId with max counts, Agent description mapped, calibration matches cost-state", () => {
	const parsed = parseClaudeSession("/x/projects/p/c1.jsonl", claudeSession, DEFAULT_PRICES);
	assert.equal(parsed.records.length, 2);
	const fable = parsed.records.find((r) => r.model === "claude-fable-5-1")!;
	assert.equal(fable.output, 400);
	assert.deepEqual(fable.tools, ["Agent"]);
	assert.equal(fable.thinking, "high");
	assert.equal(parsed.agentNames.get("abc123def456"), "Review it");
	assert.ok(fable.cost! > 0);
	calibrate(parsed.records, parsed.costState);
	assert.ok(Math.abs(fable.cost! - 1.0) < 1e-9);
	const haiku = parsed.records.find((r) => r.model.startsWith("claude-haiku"))!;
	assert.ok(Math.abs(haiku.cost! - 0.002) < 1e-9);
	assert.equal(tierFor(haiku.model, DEFAULT_TIERS).weight, 0.45);
});

test("subagent file gets the role hint and sidechain entries are subagents", () => {
	const sub = parseClaudeSession("/x/projects/p/c1/subagents/agent-abc.jsonl", claudeSession, DEFAULT_PRICES, "subagent:Review it");
	assert.ok(sub.records.every((r) => r.role === "subagent:Review it"));
});
