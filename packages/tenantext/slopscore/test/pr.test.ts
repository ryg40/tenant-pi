import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectClaude } from "../src/claude-trace.ts";
import { collectPi } from "../src/pi-trace.ts";
import { collectPrData, parsePrArgs, renderPrMarkdown, type PrData } from "../src/pr.ts";
import { DEFAULT_PRICES, DEFAULT_TIERS, THINKING_FACTORS, isDefaultConfig, loadConfig } from "../src/tiers.ts";

import { branchRepo, repo, run, setRemoteRef, withTraceEnv, writePiTrace } from "./helpers.ts";

const cfg = loadConfig("/nonexistent/tiers.json");
test("CLI reports only two branch commits with actual tickets and clear model provenance", () => {
	const r = branchRepo();
	setRemoteRef(r, "origin/main", r.base);
	const result = run(r.dir);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /branch feature\/pr vs origin\/main, 2 commits, 2 days/);
	assert.match(result.stdout, /2 code commits/);
	assert.match(result.stdout, /1 commits with model Co-Authored-By provenance/);
	assert.match(result.stdout, /tickets #3, #4/);
	assert.match(result.stdout, /1 fix or review commits/);
	assert.match(result.stdout, /no local traces; 1 commits without a model trailer/);
	assert.match(result.stdout, /^\*\*Bundle:\*\* none$/m);
	assert.ok(!result.stdout.includes("main history"));
	assert.ok(result.stdout.includes("No local traces for this branch."));
});

test("base resolution follows the required order and --base overrides it", () => {
	const r = branchRepo();
	for (const name of ["upstream/HEAD", "origin/HEAD", "origin/main"]) setRemoteRef(r, name, r.base);
	let data = collectPrData(r.dir, { json: false, help: false }, cfg);
	assert.equal(data.ok && data.data.scope.base, "upstream/HEAD");
	r.git("update-ref", "-d", "refs/remotes/upstream/HEAD");
	data = collectPrData(r.dir, { json: false, help: false }, cfg);
	assert.equal(data.ok && data.data.scope.base, "origin/HEAD");
	r.git("update-ref", "-d", "refs/remotes/origin/HEAD");
	data = collectPrData(r.dir, { json: false, help: false }, cfg);
	assert.equal(data.ok && data.data.scope.base, "origin/main");
	r.git("update-ref", "-d", "refs/remotes/origin/main");
	data = collectPrData(r.dir, { json: false, help: false }, cfg);
	assert.equal(data.ok && data.data.scope.base, "main");
	r.git("branch", "alternate", r.base);
	data = collectPrData(r.dir, { base: "alternate", json: false, help: false }, cfg);
	assert.equal(data.ok && data.data.scope.base, "alternate");
});

test("invalid or absent bases and an empty branch return one sanitized line", () => {
	const missing = branchRepo();
	missing.git("branch", "-D", "main");
	let result = run(missing.dir);
	assert.equal(result.status, 1);
	assert.equal(result.stdout.trim(), "No base ref resolves.");
	assert.equal(result.stdout.trim().split("\n").length, 1);
	result = run(missing.dir, "--base", "/home/private/nope");
	assert.equal(result.status, 1);
	assert.equal(result.stdout.trim(), "Base ref does not resolve.");
	assert.ok(!result.stdout.includes("/home/private"));

	const empty = repo();
	empty.commit("base", "src/a.ts", "a", "2026-09-01");
	result = run(empty.dir, "--base", "main");
	assert.equal(result.status, 1);
	assert.equal(result.stdout.trim(), "No commits exist on this branch.");

	const unrelated = branchRepo();
	unrelated.git("switch", "-q", "--orphan", "unrelated");
	unrelated.commit("unrelated root", "src/other.ts", "other", "2026-09-04");
	result = run(unrelated.dir, "--base", "feature/pr");
	assert.equal(result.status, 1);
	assert.equal(result.stdout.trim(), "The base ref has no merge base with HEAD.");
	assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("JSON is exactly the renderer data and Markdown stays private and bounded", () => {
	const r = branchRepo();
	const jsonResult = run(r.dir, "--base", "main", "--json");
	assert.equal(jsonResult.status, 0, jsonResult.stderr);
	const data = JSON.parse(jsonResult.stdout) as PrData;
	const markdownResult = run(r.dir, "--base", "main");
	assert.equal(markdownResult.status, 0, markdownResult.stderr);
	assert.equal(markdownResult.stdout.trimEnd(), renderPrMarkdown(data));
	assert.ok(markdownResult.stdout.trimEnd().split("\n").length < 40);
	assert.ok(!markdownResult.stdout.includes(r.dir));
	assert.doesNotMatch(markdownResult.stdout, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b|tokens?\b/i);
	assert.deepEqual(data.provenance.ticketReferences, ["#3", "#4"]);
	assert.equal(data.localTraces, false);
	const unsafe = structuredClone(data);
	unsafe.scope.branch = `bad|name\n## injected${"x".repeat(300)}`;
	const safeMarkdown = renderPrMarkdown(unsafe);
	assert.ok(safeMarkdown.includes("bad\\|name?## injected"));
	assert.ok(!safeMarkdown.includes("\n## injected"));
	assert.ok(safeMarkdown.length < 1_000);
});

test("CLI help works and missing or unknown arguments fail concisely", () => {
	const r = branchRepo();
	assert.equal(run(r.dir, "--help").status, 0);
	assert.equal(run(r.dir, "--base").stdout.trim(), "--base requires a ref.");
	assert.equal(run(r.dir, "--unknown").stdout.trim(), "Unknown argument.");
	assert.equal(run(r.dir, "/home/private/unknown").stdout.trim(), "Unknown argument.");
});

test("trace filters preserve exact cwd and per-record since while session controls use path boundaries", () => {
	const root = mkdtempSync(join(tmpdir(), "slopscore-filter-"));
	const inside = join(root, "repo", "pkg");
	const sibling = join(root, "repo-copy");
	const cutoff = Date.parse("2026-09-01T12:00:00Z");
	const file = writePiTrace(root, "legacy", inside, [
		{ time: "2026-09-01T11:59:59Z", cost: 1 },
		{ time: "2026-09-01T12:00:01Z", cost: 1 },
	]);
	assert.equal(collectPi({ cwd: inside, since: cutoff, sessionFiles: [file] }).length, 1);
	assert.equal(collectPi({ cwd: join(root, "repo"), sessionFiles: [file] }).length, 0);
	assert.equal(collectPi({ cwdInside: join(root, "repo"), sessionFiles: [file] }).length, 2);
	assert.equal(collectPi({ cwdInside: sibling, sessionFiles: [file] }).length, 0);
	assert.equal(collectPi({ cwdInside: join(root, "repo"), sessionStartedSince: cutoff, sessionFiles: [file] }).length, 0);
	const equal = writePiTrace(root, "equal", join(root, "repo"), [{ time: "2026-09-01T12:00:00Z", cost: 1 }]);
	assert.equal(collectPi({ cwdInside: join(root, "repo"), sessionStartedSince: cutoff, sessionFiles: [equal] }).length, 1);
});

test("PR traces include root and subdirectory sessions but exclude old and sibling sessions", () => {
	const r = branchRepo();
	const subdir = join(r.dir, "src");
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-pi-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-claude-"));
	writePiTrace(piDir, "root", r.dir, [{ time: "2026-09-01T12:00:00Z", cost: 1, thinking: "medium" }], "worker");
	writePiTrace(piDir, "sub", subdir, [{ time: "2026-09-02T12:00:00Z", cost: 2, thinking: "high" }], "reviewer");
	writePiTrace(piDir, "old", r.dir, [
		{ time: "2026-09-01T11:59:59Z", cost: 9 },
		{ time: "2026-09-03T12:00:00Z", cost: 9 },
	], "old");
	writePiTrace(piDir, "sibling", `${r.dir}-copy`, [{ time: "2026-09-02T12:00:00Z", cost: 9 }], "outside");
	const claudeProject = join(claudeDir, "projects", "fixture");
	mkdirSync(claudeProject, { recursive: true });
	writeFileSync(join(claudeProject, "current.jsonl"), [
		{ type: "user", sessionId: "current", cwd: r.dir, message: { content: "go" } },
		{ type: "assistant", requestId: "current-call", timestamp: "2026-09-03T12:00:00Z", message: { model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
		{ type: "cost-state", modelUsage: { "claude-fable-5-1": { costUSD: 4 } } },
	].map((event) => JSON.stringify(event)).join("\n"));
	const result = withTraceEnv(piDir, claudeDir, () => collectPrData(subdir, { base: "main", json: false, help: false }, cfg));
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.equal(result.data.trace?.sessions, 3);
	assert.equal(result.data.trace?.calls, 3);
	assert.equal(result.data.trace?.spend, 7);
	assert.deepEqual(result.data.trace?.roles.map((row) => row.role), ["main", "subagent:reviewer", "subagent:worker"]);
});

test("Claude parent scope keeps calibration and names but excludes an outside subagent cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "slopscore-claude-scope-"));
	const projects = join(root, "projects", "fixture");
	mkdirSync(join(projects, "c1", "subagents"), { recursive: true });
	const main = [
		{ type: "user", sessionId: "private-session", cwd: "/repo", message: { content: "go" } },
		{ type: "assistant", requestId: "r1", timestamp: "2026-09-01T12:00:00Z", message: { model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "tool1", name: "Agent", input: { description: "reviewer" } }] } },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool1", content: "agentId: abc123def456" }] } },
		{ type: "cost-state", modelUsage: { "claude-fable-5-1": { costUSD: 3 } } },
	];
	const sub = [
		{ type: "user", cwd: "/outside", message: { content: "go" } },
		{ type: "assistant", requestId: "s1", effort: "high", timestamp: "2026-09-01T12:01:00Z", agentId: "abc123def456", message: { model: "claude-fable-5-1", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
	];
	writeFileSync(join(projects, "c1.jsonl"), main.map((event) => JSON.stringify(event)).join("\n"));
	writeFileSync(join(projects, "c1", "subagents", "agent-abc123def456.jsonl"), sub.map((event) => JSON.stringify(event)).join("\n"));
	const traceRoot = join(root, "projects");
	const legacyRecords = collectClaude({ cwd: "/repo" }, traceRoot, DEFAULT_PRICES);
	assert.equal(legacyRecords.length, 2);
	const records = collectClaude({ cwdInside: "/repo", sessionStartedSince: Date.parse("2026-09-01T12:00:00Z") }, traceRoot, DEFAULT_PRICES);
	assert.equal(records.length, 1);
	assert.equal(records[0].role, "main");
	assert.equal(records[0].cost, 1.5);
	assert.ok(!records.some((record) => record.role.includes("abc123def456")));
});

test("role folding, no-spend, zero spend, and config comparison are deterministic", () => {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-roles-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-empty-"));
	for (let index = 0; index < 8; index++) {
		writePiTrace(piDir, `role-${index}`, r.dir, [{ time: "2026-09-02T12:00:00Z", cost: index === 7 ? null : index + 1, model: index === 6 ? "/home/private/model" : `model-${index}`, thinking: index === 5 ? "bad|level\nnext" : undefined }], `role${index}`);
	}
	const visible = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, cfg));
	const hidden = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false, noSpend: true }, cfg));
	assert.ok(visible.ok && hidden.ok);
	if (!visible.ok || !hidden.ok || !visible.data.trace || !hidden.data.trace) return;
	assert.equal(visible.data.trace.roles.length, 7);
	assert.equal(visible.data.trace.roles.at(-1)?.role, "other");
	assert.ok(Math.abs(visible.data.trace.roles.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
	assert.equal(hidden.data.trace.spend, null);
	assert.deepEqual({ ...hidden.data.trace, spend: visible.data.trace.spend }, visible.data.trace);
	assert.match(renderPrMarkdown(hidden.data), /\| n\/a \|/);
	assert.deepEqual(Object.keys(hidden.data.trace).sort(), ["calls", "effortShare", "modelPoints", "roles", "sessions", "spend"]);
	assert.ok(!JSON.stringify(hidden.data).match(/"(?:cost|weighted|tokens?)"/i));
	assert.ok(!JSON.stringify(visible.data).includes("/home/private"));
	assert.ok(!renderPrMarkdown(visible.data).includes("\nnext"));

	const reordered = { tiers: DEFAULT_TIERS.map((tier) => ({ patterns: tier.patterns, weight: tier.weight, name: tier.name, ...(tier.note ? { note: tier.note } : {}) })), prices: Object.fromEntries(Object.entries(DEFAULT_PRICES).reverse()), thinkingFactors: Object.fromEntries(Object.entries(THINKING_FACTORS).reverse()) };
	assert.equal(isDefaultConfig(reordered), true);
	const modified = { ...reordered, thinkingFactors: { ...reordered.thinkingFactors, high: 0.5 } };
	assert.equal(isDefaultConfig(modified), false);
	const reorderedResult = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, reordered));
	const modifiedResult = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, modified));
	assert.ok(reorderedResult.ok && !reorderedResult.data.flags.includes("tiers.json differs from defaults"));
	assert.ok(modifiedResult.ok && modifiedResult.data.flags.includes("tiers.json differs from defaults"));
	assert.equal(parsePrArgs(["--no-spend"]).noSpend, true);
});

test("an embedded hex id in a Claude role name is redacted while dated model names stay public", () => {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-empty-pi-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-embedded-"));
	const projects = join(claudeDir, "projects", "fixture");
	mkdirSync(join(projects, "c1", "subagents"), { recursive: true });
	const main = [
		{ type: "user", sessionId: "c1", cwd: r.dir, message: { content: "go" } },
		{ type: "assistant", requestId: "r1", timestamp: "2026-09-02T12:00:00Z", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "tool1", name: "Agent", input: { description: "review abc123def456789" } }] } },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool1", content: "agentId: abc123def456" }] } },
		{ type: "cost-state", modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 2 } } },
	];
	const sub = [
		{ type: "user", cwd: r.dir, message: { content: "go" } },
		{ type: "assistant", requestId: "s1", timestamp: "2026-09-02T12:01:00Z", agentId: "abc123def456", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
	];
	writeFileSync(join(projects, "c1.jsonl"), main.map((event) => JSON.stringify(event)).join("\n"));
	writeFileSync(join(projects, "c1", "subagents", "agent-abc123def456.jsonl"), sub.map((event) => JSON.stringify(event)).join("\n"));
	const result = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, cfg));
	assert.ok(result.ok && result.data.trace);
	if (!result.ok || !result.data.trace) return;
	assert.deepEqual(result.data.trace.roles.map((row) => [row.role, row.mainModel]).sort(), [["main", "claude-haiku-4-5-20251001"], ["redacted", "claude-haiku-4-5-20251001"]]);
	assert.ok(!renderPrMarkdown(result.data).includes("abc123def456"));
});

test("dated model names remain public while whole IDs and UUIDs stay redacted", () => {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-names-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-empty-"));
	const dated = "claude-haiku-4-5-20251001";
	const hex = "abc123def456";
	const uuid = "11111111-2222-7333-8444-555555555555";
	writePiTrace(piDir, "dated", r.dir, [{ time: "2026-09-02T12:00:00Z", cost: 4, model: dated }]);
	writePiTrace(piDir, "hex-model", r.dir, [{ time: "2026-09-02T12:00:00Z", cost: 2, model: hex }], "worker");
	writePiTrace(piDir, "uuid-model", r.dir, [{ time: "2026-09-02T12:00:00Z", cost: 1, model: `model-${uuid}` }], hex);
	const result = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, cfg));
	assert.ok(result.ok && result.data.trace);
	if (!result.ok || !result.data.trace) return;
	assert.equal(result.data.trace.roles[0].mainModel, dated);
	assert.equal(result.data.trace.roles[1].mainModel, "redacted");
	assert.equal(result.data.trace.roles[2].role, "redacted");
	assert.equal(result.data.trace.roles[2].mainModel, "redacted");
	const rendered = renderPrMarkdown(result.data);
	assert.ok(rendered.includes("claude-haiku-4-5-20251001"));
	assert.ok(JSON.stringify(result.data).includes(dated));
	for (const privateId of [hex, uuid]) {
		assert.ok(!JSON.stringify(result.data).includes(privateId));
		assert.ok(!rendered.includes(privateId));
	}
});

test("Claude unnamed sidechains never publish fallback agent IDs", () => {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-empty-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-claude-ids-"));
	const project = join(claudeDir, "projects", "fixture");
	mkdirSync(project, { recursive: true });
	const ids = ["agent-abc123def456", "abc123def456", "11111111-2222-7333-8444-555555555555"];
	writeFileSync(join(project, "fallback.jsonl"), [
		{ type: "user", sessionId: "private-fallback-session", cwd: r.dir, message: { content: "go" } },
		...ids.map((agentId, index) => ({ type: "assistant", requestId: `r${index}`, isSidechain: true, agentId, timestamp: "2026-09-02T12:00:00Z", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 10, output_tokens: 2 }, content: [] } })),
	].map((event) => JSON.stringify(event)).join("\n"));
	const result = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, cfg));
	assert.ok(result.ok && result.data.trace);
	if (!result.ok || !result.data.trace) return;
	assert.equal(result.data.trace.calls, 3);
	assert.deepEqual(result.data.trace.roles.map((row) => row.role), ["subagent:unknown"]);
	assert.equal(result.data.trace.roles[0].mainModel, "claude-haiku-4-5-20251001");
	const json = JSON.stringify(result.data);
	const markdown = renderPrMarkdown(result.data);
	for (const id of [...ids, "private-fallback-session"]) {
		assert.ok(!json.includes(id));
		assert.ok(!markdown.includes(id));
	}
});

test("unpriced calls produce zero spend, zero shares, and unknown thinking", () => {
	const r = branchRepo();
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-zero-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-empty-"));
	writePiTrace(piDir, "unpriced", r.dir, [{ time: "2026-09-02T12:00:00Z", cost: null, model: "unknown-model" }], "worker");
	const result = withTraceEnv(piDir, claudeDir, () => collectPrData(r.dir, { base: "main", json: false, help: false }, cfg));
	assert.ok(result.ok && result.data.trace);
	if (!result.ok || !result.data.trace) return;
	assert.equal(result.data.trace.spend, 0);
	assert.equal(result.data.trace.effortShare, 0);
	assert.equal(result.data.trace.modelPoints, 0);
	assert.equal(result.data.trace.roles[0].share, 0);
	assert.equal(result.data.trace.roles[0].topThinking, "unknown");
});

test("fixed trace fixture renders exact bounded Markdown from its plain JSON data", () => {
	const data: PrData = {
		scope: { branch: "feature/pr", base: "main", commits: 2, days: 2 },
		localTraces: true,
		trace: { sessions: 2, calls: 3, spend: 1.25, effortShare: 0.8, modelPoints: 16, roles: [
			{ role: "main", mainModel: "gpt-5.6-sol", topThinking: "medium", share: 0.8 },
			{ role: "subagent:reviewer", mainModel: "claude-fable-5-1", topThinking: "high", share: 0.2 },
		] },
		provenance: { codeCommits: 2, modelTrailerCommits: 1, ticketReferences: ["#5"], fixOrReviewCommits: 1 },
		bundle: { concepts: 4, keptCurrentShare: 0.5 },
		flags: [],
		generatedOn: "2026-09-19",
	};
	const expected = String.raw`## slopscore

| Scope | Sessions | Calls | Spend | Effort share | Model points |
| --- | ---: | ---: | ---: | ---: | ---: |
| branch feature/pr vs main, 2 commits, 2 days | 2 | 3 | $1.25 | 80% | 16 / 20 |

| Role | Main model | Top thinking | Share |
| --- | --- | --- | ---: |
| main | gpt-5.6-sol | medium | 80% |
| subagent:reviewer | claude-fable-5-1 | high | 20% |

**Provenance:** 2 code commits; 1 commits with model Co-Authored-By provenance; tickets #5; 1 fix or review commits.
**Flags:** none
**Bundle:** 4 concepts, 50% kept current on this branch

_Generated by slopscore-pr on 2026-09-19. Traces stay on the contributor's machine._`;
	const rendered = renderPrMarkdown(JSON.parse(JSON.stringify(data)) as PrData);
	assert.equal(rendered, expected);
	assert.ok(rendered.split("\n").length < 40);
	assert.doesNotMatch(rendered, /\/home\/|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b|tokens?\b/i);
});
