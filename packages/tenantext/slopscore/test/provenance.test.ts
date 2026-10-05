import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARTIFACT_MAX, HISTORY_MAX, ITERATION_MAX, readCommits, renderProvenance, scoreRepo, type Commit } from "../src/provenance.ts";
import { loadConfig } from "../src/tiers.ts";

const cfg = loadConfig("/nonexistent/tiers.json");

function repo(): { dir: string; commit: (msg: string, files: Record<string, string>, date: string, trailer?: string) => void } {
	const dir = mkdtempSync(join(tmpdir(), "slopscore-prov-"));
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	git("init", "-q", "-b", "main");
	return {
		dir,
		commit(msg, files, date, trailer) {
			for (const [f, body] of Object.entries(files)) {
				mkdirSync(join(dir, f, ".."), { recursive: true });
				writeFileSync(join(dir, f), body);
			}
			git("add", "-A");
			const full = trailer ? `${msg}\n\nCo-Authored-By: ${trailer} <x@y>` : msg;
			execFileSync("git", ["commit", "-q", "-m", full], { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
		},
	};
}

test("full provenance: artifacts before code, ticket refs, fixes over days, T1 trailers", () => {
	const r = repo();
	r.commit("Plan #1: map and spec", { "docs/plan/map.md": "m", "docs/plan/spec.md": "s", "docs/plan/decisions.md": "d", "docs/plan/tickets/t1.md": "t" }, "2026-09-01", "Claude Fable 5.1");
	r.commit("Ship #2", { "src/index.ts": "1" }, "2026-09-02", "Claude Fable 5.1");
	for (let i = 0; i < 7; i++) r.commit(`Fix #${i + 3} review finding`, { "src/index.ts": String(i + 2) }, `2026-09-0${(i % 4) + 3}`, "Claude Fable 5.1");
	const p = scoreRepo(r.dir, cfg);
	assert.equal(p.artifactPoints, ARTIFACT_MAX);
	assert.ok(p.artifacts.every((a) => a.beforeCode && a.file));
	assert.equal(p.historyPoints, HISTORY_MAX);
	assert.equal(p.rounds.length, 7);
	assert.equal(p.rounds[0].tier, "T1 frontier top");
	assert.equal(p.iterationPoints, ITERATION_MAX);
	assert.equal(p.total, ARTIFACT_MAX + HISTORY_MAX + ITERATION_MAX);
	const md = renderProvenance(p);
	assert.equal(ARTIFACT_MAX, 15);
	assert.match(md, /\| 15 \/ 15 \| 15 \/ 15 \| 20 \/ 20 \| 50 \/ 50 \|/);
	assert.match(md, /These 50 points join the context bundle \(10/);
	assert.match(md, /\| map \| docs\/plan\/map\.md /);
	assert.match(md, /Claude Fable 5\.1 \| T1 frontier top/);
});

test("one-off repo: one commit is flagged one-shot and capped at F", () => {
	const r = repo();
	r.commit("initial commit", { "main.py": "print(1)" }, "2026-09-01");
	const p = scoreRepo(r.dir, cfg);
	assert.equal(p.oneShot, true);
	assert.equal(p.scoreCap, 39);
	assert.equal(p.artifactPoints, 0);
	assert.equal(p.iterationPoints, 0);
	assert.equal(p.historyPoints, 1);
	assert.match(p.flags[0], /ONE-SHOT: one commit/);
	const md = renderProvenance(p);
	assert.match(md, /\*\*Flag\. ONE-SHOT/);
	assert.match(md, /One code commit, never touched again/);
});

test("one session of commits is one-shot; kept specs and a T1 trailer lift the cap to D", () => {
	const r = repo();
	r.commit("Spec and plan", { "docs/plan/spec.md": "s", "docs/plan/decisions.md": "d" }, "2026-09-01", "Claude Fable 5.1");
	for (let i = 0; i < 6; i++) r.commit(`Fix #${i} step ${i}`, { "src/a.ts": String(i) }, "2026-09-01", "Claude Fable 5.1");
	const p = scoreRepo(r.dir, cfg);
	assert.equal(p.oneShot, true);
	assert.equal(p.activeDays, 1);
	assert.equal(p.scoreCap, 59);
	assert.equal(p.total, 20);
	assert.match(p.flags[0], /7 commits inside 0\.0 hours on one day/);
	assert.match(p.flags[0], /Specs kept: small lift/);
	assert.match(p.flags[0], /T1 or T2 model in trailers: small lift/);
	// The same commits spread over two days are not one-shot.
	const r2 = repo();
	r2.commit("Spec", { "docs/plan/spec.md": "s" }, "2026-09-01", "Claude Fable 5.1");
	r2.commit("Ship", { "src/a.ts": "1" }, "2026-09-01", "Claude Fable 5.1");
	r2.commit("Fix", { "src/a.ts": "2" }, "2026-09-02", "Claude Fable 5.1");
	const q = scoreRepo(r2.dir, cfg);
	assert.equal(q.oneShot, false);
	assert.deepEqual(q.flags, []);
	assert.equal(q.scoreCap, undefined);
});

test("no repository at all is one-shot with no history", () => {
	const p = scoreRepo("/no-such-dir-slopscore", cfg);
	assert.equal(p.commits, 0);
	assert.equal(p.oneShot, true);
	assert.match(p.flags[0], /no git history/);
});

test("artifacts written after the code get half credit; unknown trailer weighs 0.4", () => {
	const r = repo();
	r.commit("code", { "src/a.ts": "1" }, "2026-09-01");
	r.commit("docs", { "docs/plan/spec.md": "s", "showcase/BRIEF.md": "b" }, "2026-09-01");
	r.commit("more code", { "src/a.ts": "2" }, "2026-09-02", "Some Bot");
	const p = scoreRepo(r.dir, cfg);
	const spec = p.artifacts.find((a) => a.kind === "spec")!;
	assert.equal(spec.beforeCode, false);
	assert.equal(spec.points, ARTIFACT_MAX / 8);
	assert.equal(p.rounds.length, 1);
	assert.equal(p.rounds[0].tier, "unknown");
	assert.equal(p.iterationPoints, Math.round(3 * 0.4));
});

test("readCommits keeps legacy full-history behavior and accepts an optional range", () => {
	const r = repo();
	r.commit("a #7", { "x.ts": "1", "test/x.test.ts": "t" }, "2026-09-01", "Claude Fable 5.1");
	const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.dir, encoding: "utf8" }).trim();
	r.commit("b #8", { "x.ts": "2" }, "2026-09-02");
	const cs = readCommits(r.dir);
	assert.equal(cs.length, 2);
	assert.deepEqual(cs[0].coauthors, ["Claude Fable 5.1"]);
	assert.deepEqual(cs[0].files.sort(), ["test/x.test.ts", "x.ts"]);
	assert.deepEqual(readCommits(r.dir, `${first}..HEAD`).map((commit) => commit.subject), ["b #8"]);
	const fake: Commit[] = [{ hash: "abc", date: "2026-09-01", time: 1, subject: "s", coauthors: [], files: ["src/a.go"] }];
	assert.equal(scoreRepo("/none", cfg, fake).codeCommits, 1);
	assert.equal(scoreRepo("/no-such-dir-slopscore", cfg).commits, 0);
});
