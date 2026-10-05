import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readOkf, renderOkf } from "../src/okf.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

type Change = string | null;
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "slopscore-okf-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
	git("init", "-q", "-b", "main");
	return {
		dir, git,
		commit(message: string, changes: Record<string, Change>, date: string) {
			for (const [path, body] of Object.entries(changes)) {
				const full = join(dir, path);
				if (body === null) rmSync(full, { force: true });
				else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body); }
			}
			git("add", "-A");
			execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "ignore" });
			return git("rev-parse", "HEAD");
		},
	};
}

const index = (version = "0.2") => `---\nokf_version: "${version}"\n---\n# Index\n`;
const concept = (metadata = "type: Reference", body = "# Fact") => `---\n${metadata}\n---\n${body}\n`;

test("vendored v0.2 spec matches LOCK.json and keeps upstream license bytes", () => {
	const root = join(import.meta.dirname, "../..");
	const lock = JSON.parse(readFileSync(join(root, "docs/okf/LOCK.json"), "utf8"));
	const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
	assert.equal(lock.repository, "https://github.com/GoogleCloudPlatform/knowledge-catalog");
	assert.equal(lock.commit, "62432a095456147ee71e70ac6e4dc0d2dea3ac30");
	assert.equal(lock.path, "okf/SPEC.md");
	assert.equal(digest(join(root, "docs/okf/SPEC.md")), lock.sha256);
	assert.equal(digest(join(root, "docs/okf/LICENSE.md")), lock.license_sha256);
	assert.match(readFileSync(join(root, "docs/okf/SPEC.md"), "utf8"), /^# Open Knowledge Format \(OKF\)\n\n\*\*Version 0\.2\*\*/);
	assert.ok(readFileSync(join(root, "docs/okf/README.md"), "utf8").trimEnd().split("\n").length <= 10);
});

test("absent, arbitrary, multiple, and repository-root bundle discovery is deterministic", () => {
	const r = repo();
	r.commit("plain index", { "index.md": "# Not a bundle\n", "src/a.ts": "1" }, "2026-01-01T12:00:00Z");
	assert.equal(readOkf(r.dir).present, false);
	r.commit("nested bundles", {
		"docs/knowledge/index.md": index(), "docs/knowledge/a.md": concept(),
		"much/longer/bundle/index.md": index("0.1"), "much/longer/bundle/b.md": concept(),
	}, "2026-01-02T12:00:00Z");
	assert.equal(readOkf(r.dir).root, "docs/knowledge");
	r.commit("root bundle", { "index.md": index("0.1"), "root.md": concept() }, "2026-01-03T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.root, ".");
	assert.equal(summary.version, "0.1");
});

test("conformance accepts unknown types and extra keys, but names missing and malformed concepts", () => {
	const r = repo();
	r.commit("bundle", {
		".okf/index.md": index(),
		".okf/good.md": concept("type: Made Up\nextra: { nested: true }"),
		".okf/missing.md": concept("title: Missing"),
		".okf/bad|name.md": "---\ntype: [\n---\n",
		".okf/nested/index.md": "# Reserved without frontmatter\n",
	}, "2026-01-01T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.present, true);
	assert.equal(summary.conformant, false);
	assert.equal(summary.conformanceFailures.length, 2);
	assert.ok(summary.conformanceFailures.some((failure) => failure.includes("missing.md: missing non-empty type")));
	assert.ok(summary.conformanceFailures.some((failure) => failure.includes("bad|name.md: malformed YAML")));
	assert.match(renderOkf(summary), /bad\\\|name\.md/);
});

test("maintenance starts with bundle presence and counts same-day and next-day touches", () => {
	const abandoned = repo();
	abandoned.commit("bundle", { ".okf/index.md": index(), ".okf/a.md": concept() }, "2026-01-10T12:00:00Z");
	for (let day = 11; day <= 15; day++) {
		for (let round = 1; round <= 4; round++) {
			abandoned.commit(`code ${day}.${round}`, { "src/a.ts": `${day}.${round}` }, `2026-01-${day}T${String(8 + round).padStart(2, "0")}:00:00Z`);
		}
	}
	const zero = readOkf(abandoned.dir);
	assert.equal(zero.codeDays, 5);
	assert.equal(zero.keptCurrentShare, 0);

	const current = repo();
	current.commit("old code", { "src/a.ts": "old" }, "2026-01-01T12:00:00Z");
	current.commit("bundle and code", { ".okf/index.md": index(), ".okf/a.md": concept(), "src/a.ts": "2" }, "2026-01-10T12:00:00Z");
	current.commit("code day", { "src/a.ts": "3" }, "2026-01-11T12:00:00Z");
	current.commit("next day bundle touch", { ".okf/a.md": concept("type: Reference\ntitle: Updated") }, "2026-01-12T12:00:00Z");
	current.commit("same day code and touch", { "src/a.ts": "4", ".okf/a.md": concept("type: Reference\ntitle: Again") }, "2026-01-13T12:00:00Z");
	const full = readOkf(current.dir);
	assert.equal(full.codeDays, 3);
	assert.equal(full.maintainedDays, 3);
	assert.equal(full.keptCurrentShare, 1);
});

test("maintenance starts when an existing unversioned index becomes a bundle", () => {
	const r = repo();
	r.commit("plain index", { ".okf/index.md": "# Notes\n", "src/a.ts": "1" }, "2026-01-01T12:00:00Z");
	r.commit("pre-bundle code", { "src/a.ts": "2" }, "2026-01-02T12:00:00Z");
	r.commit("convert to bundle", { ".okf/index.md": index(), ".okf/a.md": concept(), "src/a.ts": "3" }, "2026-01-10T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.codeDays, 1);
	assert.equal(summary.maintainedDays, 1);
	assert.equal(summary.keptCurrentShare, 1);
});

test("requested revision bounds first-bundle history independently of current HEAD", () => {
	const r = repo();
	r.commit("plain index", { ".okf/index.md": "# Notes\n" }, "2026-01-01T12:00:00Z");
	r.git("checkout", "-q", "-b", "requested");
	r.commit("requested bundle", { ".okf/index.md": index(), ".okf/a.md": concept(), "src/a.ts": "1" }, "2026-01-10T12:00:00Z");
	const requested = r.commit("requested code", { "src/a.ts": "2" }, "2026-01-11T12:00:00Z");
	r.git("checkout", "-q", "main");
	r.commit("different branch bundle", { ".okf/index.md": index(), ".okf/a.md": concept() }, "2026-01-02T12:00:00Z");
	const summary = readOkf(r.dir, { revision: requested });
	assert.equal(summary.revision, requested);
	assert.equal(summary.codeDays, 2);
	assert.equal(summary.maintainedDays, 1);
});

test("zero code days stay at zero and a future log does not create maintenance history", () => {
	const r = repo();
	r.commit("docs only", { ".okf/index.md": index(), ".okf/a.md": concept(), ".okf/log.md": "## 2099-01-01\n* future\n" }, "2026-01-01T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.codeDays, 0);
	assert.equal(summary.keptCurrentShare, 0);
	assert.equal(summary.logCurrent, false);
});

test("staleness uses equality, date-only UTC, verified maps and lists, and local file or directory sources", () => {
	const r = repo();
	r.commit("sources", { "src/data.sql": "old", "refs/x.txt": "old" }, "2025-12-31T12:00:00Z");
	r.commit("bundle", {
		".okf/index.md": index(),
		".okf/date.md": concept("type: Fact\nstale_after: 2026-01-04"),
		".okf/file.md": concept("type: Fact\nverified: { by: process:test, at: 2026-01-02 }\nsources:\n  - resource: ../src/data.sql"),
		".okf/dir.md": concept("type: Fact\nverified:\n  - { by: human:test, at: 2026-01-02T00:00:00Z }\nsources:\n  - resource: ../refs"),
		".okf/no-trust.md": concept("type: Fact\nsources:\n  - resource: ../src/data.sql"),
		".okf/url.md": concept("type: Fact\nverified: { by: process:test, at: 2020-01-01T00:00:00Z }\nsources:\n  - resource: https://example.test/source"),
	}, "2026-01-02T12:00:00Z");
	r.commit("change sources", { "src/data.sql": "new", "refs/x.txt": "new" }, "2026-01-03T12:00:00Z");
	const summary = readOkf(r.dir, { now: new Date("2026-01-04T00:00:00Z") });
	assert.equal(summary.staleCount, 3);
	assert.deepEqual(summary.staleConcepts.sort(), [".okf/date.md", ".okf/dir.md", ".okf/file.md"]);
	// Conformant 3, no log 0, one code day (the source change) with no bundle touch 0, minus 3 stale: floor at 0.
	assert.equal(summary.calculatedPoints, 0);
	const before = readOkf(r.dir, { now: new Date("2026-01-03T23:59:59Z") });
	assert.equal(before.staleCount, 2);
	assert.equal(before.calculatedPoints, 1);
});

test("a deleted or renamed local source makes a verified concept stale, and log dates must be real calendar days", () => {
	const r = repo();
	r.commit("source", { "src/data.sql": "old" }, "2026-01-01T12:00:00Z");
	r.commit("bundle", {
		".okf/index.md": index(),
		".okf/file.md": concept("type: Fact\nverified: { by: process:test, at: 2026-01-02T00:00:00Z }\nsources:\n  - resource: ../src/data.sql"),
		".okf/log.md": "## 2026-99-99\n* bogus\n",
	}, "2026-01-02T12:00:00Z");
	assert.equal(readOkf(r.dir, { now: new Date("2026-01-02T12:00:00Z") }).staleCount, 0);
	r.commit("delete source", { "src/data.sql": null, "src/other.ts": "code" }, "2026-01-03T12:00:00Z");
	const summary = readOkf(r.dir, { now: new Date("2026-01-03T12:00:00Z") });
	assert.deepEqual(summary.staleConcepts, [".okf/file.md"]);
	assert.equal(summary.logCurrent, false);
	r.commit("real log date", { ".okf/log.md": "## 2026-01-03\n* real\n" }, "2026-01-03T13:00:00Z");
	assert.equal(readOkf(r.dir, { now: new Date("2026-01-03T14:00:00Z") }).logCurrent, true);
});

test("log currency compares against the latest code day even when history is out of date order", () => {
	const r = repo();
	r.commit("bundle", { ".okf/index.md": index(), ".okf/a.md": concept(), ".okf/log.md": "## 2026-01-02\n* entry\n" }, "2026-01-01T12:00:00Z");
	r.commit("later code", { "src/a.ts": "1" }, "2026-01-03T12:00:00Z");
	r.commit("earlier-dated code", { "src/a.ts": "2" }, "2026-01-02T12:00:00Z");
	assert.equal(readOkf(r.dir).logCurrent, false);
});

test("an unquoted numeric okf_version still declares a bundle", () => {
	const r = repo();
	r.commit("numeric", { ".okf/index.md": "---\nokf_version: 0.2\n---\n# Index\n", ".okf/a.md": concept() }, "2026-01-01T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.present, true);
	assert.equal(summary.version, "0.2");
});

test("a bundle that predates the branch range counts every branch commit, even when a branch commit edits the index", () => {
	const r = repo();
	r.commit("bundle on main", { ".okf/index.md": index(), ".okf/a.md": concept(), "src/a.ts": "0" }, "2026-01-01T12:00:00Z");
	const base = r.git("rev-parse", "HEAD");
	r.git("switch", "-q", "-c", "feature");
	r.commit("day 1 code", { "src/a.ts": "1" }, "2026-01-11T12:00:00Z");
	r.commit("day 3 code and index", { "src/a.ts": "3", ".okf/index.md": index() + "* [a](a.md)\n" }, "2026-01-13T12:00:00Z");
	r.commit("day 4 code", { "src/a.ts": "4" }, "2026-01-14T12:00:00Z");
	const branch = readOkf(r.dir, { range: `${base}..HEAD` });
	assert.equal(branch.codeDays, 3);
	assert.equal(branch.maintainedDays, 1);
	assert.equal(Math.round(branch.keptCurrentShare * 100), 33);
	r.commit("day 5 untouched", { "src/a.ts": "5" }, "2026-01-15T12:00:00Z");
	assert.equal(Math.round(readOkf(r.dir, { range: `${base}..HEAD` }).keptCurrentShare * 100), 25);
});

test("the CLI --repo path awards zero bundle points on a one-shot repository", () => {
	const r = repo();
	r.commit("everything at once", { ".okf/index.md": index(), ".okf/a.md": concept(), ".okf/log.md": "## 2026-01-01\n* one\n", "src/a.ts": "1" }, "2026-01-01T12:00:00Z");
	r.commit("same session", { "src/a.ts": "2" }, "2026-01-01T13:00:00Z");
	const root = join(import.meta.dirname, "../..");
	const cli = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "slopscore/src/cli.ts", "--repo", r.dir, "--days", "0", "--json"], { cwd: root, encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr);
	const out = JSON.parse(cli.stdout);
	assert.equal(out.provenance.oneShot, true);
	assert.equal(out.okf.oneShot, true);
	assert.equal(out.okf.points, 0);
	assert.ok(out.okf.calculatedPoints > 0);
});

test("points follow the sum formula, v0.1 has parity, and one-shot only changes awarded points", () => {
	for (const version of ["0.1", "0.2"]) {
		const r = repo();
		r.commit("complete", {
			".okf/index.md": index(version), ".okf/a.md": concept(), ".okf/log.md": "## 2026-01-01\n* current\n", "src/a.ts": "1",
		}, "2026-01-01T12:00:00Z");
		const summary = readOkf(r.dir, { now: new Date("2026-01-01T12:00:00Z") });
		assert.equal(summary.calculatedPoints, 10);
		assert.equal(summary.points, 10);
		const capped = readOkf(r.dir, { now: new Date("2026-01-01T12:00:00Z"), oneShot: true });
		assert.equal(capped.calculatedPoints, 10);
		assert.equal(capped.points, 0);
	}
});

test("reads the requested commit and ignores dirty working-tree files", () => {
	const r = repo();
	const old = r.commit("valid", { ".okf/index.md": index(), ".okf/a.md": concept() }, "2026-01-01T12:00:00Z");
	r.commit("later", { ".okf/a.md": concept("title: broken") }, "2026-01-02T12:00:00Z");
	writeFileSync(join(r.dir, ".okf/index.md"), "dirty and invalid");
	assert.equal(readOkf(r.dir, { revision: old }).conformant, true);
	assert.equal(readOkf(r.dir).conformant, false);
});

test("renderer has the required columns and verified concept count", () => {
	const r = repo();
	r.commit("bundle and plan", {
		".okf/index.md": index(),
		".okf/a.md": concept("type: Fact\nverified: { by: process:test, at: 2026-01-01 }"),
		".okf/b.md": concept("type: Fact\nverified: { by: process:test, at: not-a-date }"),
		"docs/plan/spec.md": "s", "src/a.ts": "1",
	}, "2026-01-01T12:00:00Z");
	const summary = readOkf(r.dir);
	assert.equal(summary.verifiedCount, 1);
	const rendered = renderOkf(summary);
	assert.ok(rendered.split("\n").length < 20);
	assert.equal(rendered.split("\n")[2], "| Root | Version | Concepts | Conformant | Log current | Kept current | Stale | Verified | Points |");
	assert.equal(rendered.split("\n")[4], "| .okf | 0.2 | 2 | yes | no | 100% (1/1) | 0 | 1 | 8.0 / 10 |");
	const root = join(import.meta.dirname, "../..");
	const cli = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "slopscore/src/cli.ts", "--repo", r.dir, "--days", "0"], { cwd: root, encoding: "utf8" });
	assert.equal(cli.status, 0, cli.stderr);
	assert.ok(cli.stdout.indexOf("### Planning artifacts") < cli.stdout.indexOf("### Context bundle"));
	assert.ok(cli.stdout.indexOf("### Context bundle") < cli.stdout.indexOf("### Iterations after first ship"));
});

test("invalid repository CLI failure is one line with exit code 1", () => {
	const root = join(import.meta.dirname, "../..");
	const cli = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "slopscore/src/cli.ts", "--repo", "/no/such/repository", "--days", "0"], { cwd: root, encoding: "utf8" });
	assert.equal(cli.status, 1);
	assert.equal(cli.stderr.trim().split("\n").length, 1);
	assert.match(cli.stderr, /^slopscore: cannot read repository:/);
});
