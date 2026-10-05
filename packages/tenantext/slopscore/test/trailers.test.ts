import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsePrArgs } from "../src/pr.ts";
import { planTrailers, proposeModel, providerDomain, trailerText } from "../src/trailers.ts";
import { loadConfig } from "../src/tiers.ts";
import type { CallRecord } from "../src/types.ts";
import { branchRepo, runWithEnv, setRemoteRef, withTraceEnv, writePiTrace } from "./helpers.ts";

const cfg = loadConfig("/nonexistent/tiers.json");

/** Branch of three commits: one with a trailer, one with sessions in its window, one with none. */
function trailerRepo() {
	const r = branchRepo();
	r.commit("Docs #4", "docs/notes.md", "notes", "2026-09-04");
	const piDir = mkdtempSync(join(tmpdir(), "slopscore-trailers-pi-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "slopscore-trailers-claude-"));
	writePiTrace(piDir, "sol", r.dir, [{ time: "2026-09-02T13:00:00Z", cost: 2, model: "gpt-5.6-sol" }]);
	writePiTrace(piDir, "fable", join(r.dir, "src"), [{ time: "2026-09-02T14:00:00Z", cost: 5, model: "claude-fable-5-1" }]);
	writePiTrace(piDir, "sub", r.dir, [{ time: "2026-09-02T15:00:00Z", cost: 50, model: "gpt-5.6-luna" }], "reviewer");
	writePiTrace(piDir, "old", r.dir, [{ time: "2026-09-01T11:00:00Z", cost: 90, model: "old-model" }, { time: "2026-09-02T16:00:00Z", cost: 90, model: "old-model" }]);
	const env = { ...process.env, PI_CODING_AGENT_DIR: piDir, CLAUDE_CONFIG_DIR: claudeDir, SLOPSCORE_CONFIG: join(piDir, "isolated-config.json") };
	const trailers = (...args: string[]) => runWithEnv(r.dir, env, "--add-trailers", "--base", "main", ...args);
	return { ...r, piDir, claudeDir, env, trailers };
}

test("provider domains come from the model id prefix, then the provider, then the fallback", () => {
	assert.equal(providerDomain("gpt-5.6-sol"), "openai.com");
	assert.equal(providerDomain("claude-fable-5-1", "anthropic"), "anthropic.com");
	assert.equal(providerDomain("gemini-3-pro"), "google.com");
	assert.equal(providerDomain("qwen3-35b", "openai-compatible"), "openai.com");
	assert.equal(providerDomain("qwen3-35b", "ollama"), "slopscore.local");
	assert.equal(trailerText("gpt-5.6-sol"), "Co-Authored-By: gpt-5.6-sol <noreply@openai.com>");
});

test("the proposal is the main-role model with the most spend inside the commit window", () => {
	const record = (model: string, time: string, cost: number, role = "main"): CallRecord => ({
		harness: "pi", sessionId: "s", sessionFile: "f", role, model, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, tools: [], timestamp: Date.parse(time),
	});
	const records = [
		record("a-model", "2026-09-02T12:00:00Z", 9),
		record("b-model", "2026-09-02T12:00:01Z", 1),
		record("b-model", "2026-09-02T18:00:00Z", 1),
		record("c-model", "2026-09-02T19:00:00Z", 2),
		record("z-model", "2026-09-02T20:00:00Z", 99, "subagent:reviewer"),
		record("bad model", "2026-09-02T20:00:00Z", 99),
		record("d-model", "2026-09-03T12:00:00Z", 99),
		record("e-model", "2026-09-03T12:00:01Z", 99),
	];
	const from = Date.parse("2026-09-02T12:00:00Z");
	const to = Date.parse("2026-09-03T12:00:00Z");
	assert.equal(proposeModel(records, from, to)?.model, "d-model");
	assert.equal(proposeModel(records.filter((r) => r.model !== "d-model"), from, to)?.model, "b-model");
	assert.equal(proposeModel(records, to, to + 1), undefined);
});

test("dry run lists existing, proposed and no proposal and changes nothing", () => {
	const r = trailerRepo();
	const before = r.git("rev-parse", "HEAD");
	const result = withTraceEnv(r.piDir, r.claudeDir, () => planTrailers(r.dir, { base: "main", yes: false, force: false, json: false }, cfg));
	assert.ok(result.ok);
	if (!result.ok) return;
	assert.deepEqual(result.plan.rows.map((row) => row.existing.length ? "existing" : row.proposed ?? "none"), [
		"existing",
		"Co-Authored-By: claude-fable-5-1 <noreply@anthropic.com>",
		"none",
	]);
	assert.deepEqual(result.plan.remotes, []);
	const cliResult = r.trailers();
	assert.equal(cliResult.status, 0, cliResult.stderr);
	assert.match(cliResult.stdout, /\| Build #3 \| existing: gpt-5\.6-sol \|/);
	assert.match(cliResult.stdout, /\| Fix #4 review \| proposed: Co-Authored-By: claude-fable-5-1 <noreply@anthropic\.com> \|/);
	assert.match(cliResult.stdout, /\| Docs #4 \| no proposal \|/);
	assert.match(cliResult.stdout, /Dry run\. 1 commit would gain a trailer\. Rerun with --yes to rebase\./);
	assert.ok(!cliResult.stdout.includes("git push"));
	assert.equal(r.git("rev-parse", "HEAD"), before);
	const json = r.trailers("--json");
	assert.equal(JSON.parse(json.stdout).rows.length, 3);
});

test("--yes adds the trailer, leaves the untouched ancestor byte-identical and prints the push line", () => {
	const r = trailerRepo();
	const hashes = r.git("rev-list", "--reverse", "main..HEAD").split("\n");
	const docsBody = r.git("log", "-1", "--format=%B", hashes[2]);
	const docsTree = r.git("log", "-1", "--format=%T", hashes[2]);
	const result = r.trailers("--yes");
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stdout, /Rewrote 1 commit on feature\/pr\. Nothing was pushed\./);
	assert.ok(result.stdout.trimEnd().endsWith("git push --force-with-lease origin feature/pr\n```"));
	const after = r.git("rev-list", "--reverse", "main..HEAD").split("\n");
	assert.equal(after[0], hashes[0]);
	assert.notEqual(after[1], hashes[1]);
	assert.equal(r.git("log", "-1", "--format=%(trailers:key=Co-Authored-By,valueonly)", after[1]), "claude-fable-5-1 <noreply@anthropic.com>");
	assert.equal(r.git("log", "-1", "--format=%s", after[1]), "Fix #4 review");
	assert.equal(r.git("log", "-1", "--format=%B", after[2]), docsBody);
	assert.equal(r.git("log", "-1", "--format=%T", after[2]), docsTree);
	assert.equal(r.git("status", "--porcelain"), "");
	const rerun = r.trailers();
	assert.match(rerun.stdout, /\| Fix #4 review \| existing: claude-fable-5-1 \|/);
	assert.match(rerun.stdout, /Nothing to add\./);
});

test("--yes refuses a branch that exists on a remote unless --force is given, and never pushes", () => {
	const r = trailerRepo();
	const head = r.git("rev-parse", "HEAD");
	setRemoteRef(r, "origin/feature/pr", head);
	const dry = r.trailers();
	assert.match(dry.stdout, /Branch feature\/pr exists on remote origin\. --force is required\./);
	const refused = r.trailers("--yes");
	assert.equal(refused.status, 1);
	assert.equal(refused.stdout.trim(), "Branch feature/pr exists on remote origin. Rerun with --force to rewrite it.");
	assert.equal(r.git("rev-parse", "HEAD"), head);
	const forced = r.trailers("--yes", "--force");
	assert.equal(forced.status, 0, forced.stderr + forced.stdout);
	assert.notEqual(r.git("rev-parse", "HEAD"), head);
	assert.equal(r.git("rev-parse", "refs/remotes/origin/feature/pr"), head);
	assert.match(forced.stdout, /git push --force-with-lease origin feature\/pr/);
});

test("--yes refuses a branch whose configured upstream has another name, and the push line targets it", () => {
	const r = trailerRepo();
	const head = r.git("rev-parse", "HEAD");
	setRemoteRef(r, "origin/dev/feature-pr", head);
	r.git("config", "branch.feature/pr.remote", "origin");
	r.git("config", "branch.feature/pr.merge", "refs/heads/dev/feature-pr");
	assert.equal(r.trailers("--yes").status, 1);
	const forced = r.trailers("--yes", "--force");
	assert.equal(forced.status, 0, forced.stderr + forced.stdout);
	assert.match(forced.stdout, /git push --force-with-lease origin HEAD:dev\/feature-pr/);
});

test("a branch with a merge commit is reported in the dry run and refused on --yes", () => {
	const r = trailerRepo();
	r.git("switch", "-q", "main");
	r.commit("main moves on", "src/main.ts", "main2", "2026-09-05");
	r.git("switch", "-q", "feature/pr");
	execFileSync("git", ["merge", "-q", "--no-ff", "-m", "Merge main", "main"], { cwd: r.dir, env: r.env });
	const dry = r.trailers();
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /The branch has 1 merge commit\. --add-trailers does not rewrite merges/);
	const head = r.git("rev-parse", "HEAD");
	const refused = r.trailers("--yes");
	assert.equal(refused.status, 1);
	assert.match(refused.stdout, /merge commits/);
	assert.equal(r.git("rev-parse", "HEAD"), head);
});

test("--yes refuses while another rebase is in progress and leaves it alone", () => {
	const r = trailerRepo();
	const rebaseDir = join(r.dir, ".git", "rebase-merge");
	execFileSync("mkdir", ["-p", rebaseDir]);
	writeFileSync(join(rebaseDir, "head-name"), "refs/heads/other\n");
	const head = r.git("rev-parse", "HEAD");
	const result = r.trailers("--yes");
	assert.equal(result.status, 1);
	assert.equal(result.stdout.trim(), "A rebase is already in progress. Finish or abort it first.");
	assert.equal(r.git("rev-parse", "HEAD"), head);
	assert.equal(spawnSync("test", ["-f", join(rebaseDir, "head-name")]).status, 0);
});

test("signed commits at or after the first rewrite are counted and gate --yes behind --force", { skip: spawnSync("ssh-keygen", ["-h"]).error ? "ssh-keygen unavailable" : false }, () => {
	const r = trailerRepo();
	const keyDir = mkdtempSync(join(tmpdir(), "slopscore-sign-"));
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keyDir, "key")]);
	r.git("config", "gpg.format", "ssh");
	r.git("config", "user.signingkey", join(keyDir, "key"));
	// Amend the last branch commit (no trailer, no proposal) into a signed one. No allowed-signers file: %G? would say N.
	execFileSync("git", ["commit", "-q", "-S", "--amend", "--no-edit"], { cwd: r.dir, env: { ...r.env, GIT_COMMITTER_DATE: "2026-09-04T12:00:00Z" } });
	assert.match(r.git("cat-file", "commit", "HEAD"), /^gpgsig /m);
	const dry = r.trailers();
	assert.match(dry.stdout, /1 signed commit at or after the first rewrite will be re-created/);
	assert.equal(JSON.parse(r.trailers("--json").stdout).signedAfterRewrite, 1);
	const refused = r.trailers("--yes");
	assert.equal(refused.status, 1);
	assert.equal(refused.stdout.trim(), "1 signed commits would be re-created. Rerun with --force to accept that.");
	const forced = r.trailers("--yes", "--force");
	assert.equal(forced.status, 0, forced.stderr + forced.stdout);
	assert.match(forced.stdout, /Rewrote 1 commit/);
	assert.equal(r.git("log", "-1", "--format=%s"), "Docs #4");
});

test("--yes works when TMPDIR holds an apostrophe and a space", () => {
	const r = trailerRepo();
	const tmp = mkdtempSync(join(tmpdir(), "slopscore o'tmp "));
	const result = runWithEnv(r.dir, { ...r.env, TMPDIR: tmp }, "--add-trailers", "--base", "main", "--yes");
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stdout, /Rewrote 1 commit/);
	assert.equal(r.git("log", "-1", "--format=%(trailers:key=Co-Authored-By,valueonly)", "HEAD~1"), "claude-fable-5-1 <noreply@anthropic.com>");
});

test("a signed commit before the first rewrite stays byte-identical and does not count as signed after rewrite", { skip: spawnSync("ssh-keygen", ["-h"]).error ? "ssh-keygen unavailable" : false }, () => {
	const r = trailerRepo();
	const keyDir = mkdtempSync(join(tmpdir(), "slopscore-sign-"));
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keyDir, "key")]);
	r.git("config", "gpg.format", "ssh");
	r.git("config", "user.signingkey", join(keyDir, "key"));
	// Re-create the branch so the first commit (existing trailer) is signed and the later ones are not.
	const [first, second, third] = r.git("rev-list", "--reverse", "main..HEAD").split("\n");
	r.git("reset", "-q", "--hard", first);
	execFileSync("git", ["commit", "-q", "-S", "--amend", "--no-edit"], { cwd: r.dir, env: { ...r.env, GIT_COMMITTER_DATE: "2026-09-02T12:00:00Z" } });
	r.git("cherry-pick", second, third);
	const signedFirst = r.git("rev-parse", "HEAD~2");
	assert.match(r.git("cat-file", "commit", signedFirst), /^gpgsig /m);
	assert.equal(JSON.parse(r.trailers("--json").stdout).signedAfterRewrite, 0);
	const result = r.trailers("--yes");
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.equal(r.git("rev-parse", "HEAD~2"), signedFirst);
});

test("trailer flags need --add-trailers and reject --no-spend", () => {
	assert.throws(() => parsePrArgs(["--yes"]), /need --add-trailers/);
	assert.throws(() => parsePrArgs(["--add-trailers", "--no-spend"]), /does not apply/);
	assert.equal(parsePrArgs(["--add-trailers", "--yes", "--force"]).force, true);
});
