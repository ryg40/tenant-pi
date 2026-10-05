import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import slopscore from "../src/index.ts";
import { runOkf } from "../src/okf.ts";
import { collectPrData, renderPrMarkdown } from "../src/pr.ts";
import { loadConfig } from "../src/tiers.ts";
import { branchRepo, cli, repo } from "./helpers.ts";

/** The bundle line in the PR block over branch commits only, and `slopscore okf` in the CLI, Pi and Claude Code. */

const cfg = loadConfig("/nonexistent/tiers.json");
const pluginRoot = fileURLToPath(new URL("../../claude-code", import.meta.url));
const index = `---\nokf_version: "0.2"\n---\n# Index\n`;
const concept = (metadata = "type: Reference") => `---\n${metadata}\n---\n# Fact\n`;

/** Branch: bundle added (09-02), Build (09-02), Fix (09-03). Code days 2, bundle touch days 1: 50% kept current. */
function bundleBranch() {
	const r = repo();
	r.commit("main history #1", "src/main.ts", "main", "2026-09-01", "old-model");
	r.git("switch", "-q", "-c", "feature/pr");
	r.commit("Bundle", ".okf/index.md", index, "2026-09-02");
	r.commit("Concept", ".okf/a.md", concept(), "2026-09-02");
	r.commit("Build #3", "src/feature.ts", "one", "2026-09-02", "gpt-5.6-sol");
	r.commit("Fix #4 review", "src/feature.ts", "two", "2026-09-03");
	return r;
}

test("the PR block carries the bundle line measured over the branch commits, and none without a bundle", () => {
	const r = bundleBranch();
	const result = collectPrData(r.dir, { base: "main", json: false, help: false }, cfg);
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.deepEqual(result.data.bundle, { concepts: 1, keptCurrentShare: 0.5 });
	const markdown = renderPrMarkdown(result.data);
	assert.match(markdown, /^\*\*Bundle:\*\* 1 concepts, 50% kept current on this branch$/m);
	assert.ok(markdown.split("\n").length < 40);
	// A branch that never touches an existing bundle reads 0%, not none: the bundle exists and was not kept current.
	const untouched = repo();
	untouched.commit("bundle on main", ".okf/index.md", index, "2026-09-01");
	untouched.git("switch", "-q", "-c", "feature/pr");
	untouched.commit("Build #3", "src/feature.ts", "one", "2026-09-02");
	const zero = collectPrData(untouched.dir, { base: "main", json: false, help: false }, cfg);
	assert.ok(zero.ok);
	if (zero.ok) assert.match(renderPrMarkdown(zero.data), /^\*\*Bundle:\*\* 0 concepts, 0% kept current on this branch$/m);
	const plain = branchRepo();
	const none = collectPrData(plain.dir, { base: "main", json: false, help: false }, cfg);
	assert.ok(none.ok && none.data.bundle === undefined);
	if (none.ok) assert.match(renderPrMarkdown(none.data), /^\*\*Bundle:\*\* none$/m);
});

test("slopscore okf prints the table and the failing concepts with exit 0, and one line with exit 1 outside a repo", () => {
	const r = bundleBranch();
	r.commit("Broken concept", ".okf/broken.md", "no frontmatter\n", "2026-09-03");
	const ok = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "okf"], { cwd: r.dir, encoding: "utf8" });
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /^### Context bundle$/m);
	assert.match(ok.stdout, /\| \.okf \| 0\.2 \| 2 \| no \|/);
	assert.match(ok.stdout, /^- Conformance: \.okf\/broken\.md: missing YAML frontmatter$/m);
	const byPath = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "okf", "--repo", r.dir, "--json"], { cwd: tmpdir(), encoding: "utf8" });
	assert.equal(JSON.parse(byPath.stdout).conceptCount, 2);
	const notRepo = mkdtempSync(join(tmpdir(), "slopscore-not-repo-"));
	const bad = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "okf"], { cwd: notRepo, encoding: "utf8" });
	assert.equal(bad.status, 1);
	assert.equal(bad.stdout.trim().split("\n").length, 1);
	assert.match(bad.stdout, /^slopscore okf: cannot read repository: /);
	assert.equal(runOkf(["--bogus"], r.dir).exitCode, 1);
	assert.equal(runOkf(["--repo", "."], r.dir).exitCode, 0);
	const oneShot = repo();
	oneShot.commit("all at once", ".okf/index.md", index, "2026-09-01");
	oneShot.commit("code", "src/a.ts", "1", "2026-09-01");
	assert.match(runOkf([], oneShot.dir).output, /\| 0\.0 \/ 10 \|\n- One-shot: calculated 8\.0 points, awarded 0\./);
	assert.match(runOkf(["--repo", "."], r.dir).output, /\| \.okf \| 0\.2 \|/);
});

test("Pi and Claude Code print byte-identical okf output for the same repo", async () => {
	const r = bundleBranch();
	const shown: string[] = [];
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let completions: ((prefix: string) => Array<{ value: string }> | null) | undefined;
	slopscore({
		registerEntryRenderer() {},
		appendEntry(_type: string, data: { body: string }) { shown.push(data.body); },
		on() {},
		registerCommand(_name: string, spec: { handler: typeof handler; getArgumentCompletions: typeof completions }) { handler = spec.handler; completions = spec.getArgumentCompletions; },
	} as never);
	assert.ok(completions!("ok")?.some((item) => item.value === "okf"));
	await handler!("okf", { cwd: r.dir, ui: { notify() {} }, sessionManager: { getSessionFile: () => undefined } });
	const piOutput = shown.join("\n");
	assert.match(piOutput, /^### Context bundle$/m);
	const command = readFileSync(join(pluginRoot, "commands", "slopscore.md"), "utf8");
	assert.match(command, /argument-hint: ".*okf \[--repo PATH\] \[--json\]/);
	const template = command.split("\n").find((line) => line.startsWith("!`"))!.slice(2, -1);
	const claude = spawnSync("bash", ["-c", template.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replace("$ARGUMENTS", "okf")], { cwd: r.dir, encoding: "utf8" });
	assert.equal(claude.status, 0, claude.stderr);
	assert.equal(claude.stdout.trimEnd(), piOutput);
	assert.equal(piOutput, runOkf([], r.dir).output);
});
