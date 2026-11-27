// The ops-footer status line of agy: the transcript scan, the input fields and the plain line. Run: node --test 'tests/*.test.mjs'
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	currentWindowUsed, fallbackLine, footerSettings, inferEffort, mapAgentState, mergeHealthUrls, openVikingMemory,
	profileCache, profileReading, resolveProfileDir, scanTranscript, transcriptAllowed, usageLimits, withLock,
} from "../scripts/statusline-ops-footer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "statusline-ops-footer.mjs");

function scratch(t) {
	const dir = mkdtempSync(join(tmpdir(), "agy-statusline-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const line = value => JSON.stringify(value) + "\n";

test("the scan adds each agy entry type once and reads only complete lines", t => {
	const path = join(scratch(t), "transcript.jsonl");
	writeFileSync(path, [
		line({ type: "USER_INPUT", created_at: "2026-01-01T12:00:00Z", content: "u".repeat(40) }),
		line({ type: "SYSTEM_MESSAGE", content: "s".repeat(8) }),
		line({ type: "GENERIC", content: "g".repeat(12) }),
		line({ type: "PLANNER_RESPONSE", model: "model-one", input_tokens: 100, cache_read_tokens: 20, output_tokens: 30,
			thinking: "t".repeat(16), tool_calls: [{ name: "run_command" }, { name: "read_file" }] }),
		"not json\n",
	].join(""));
	let scan = scanTranscript(path, null);
	assert.equal(scan.startedAt, Date.parse("2026-01-01T12:00:00Z"));
	assert.deepEqual(scan.estimates, { prompt: 12, assistant: 26, think: 4, tools: 3 });
	assert.deepEqual(scan.totals, { input: 100, output: 30, cacheRead: 20, cacheWrite: 0 });
	assert.equal(scan.sys, 85);
	assert.equal(scan.tools, 2);
	assert.equal(scan.state, "working");
	assert.equal(scan.model, "model-one");

	// A line without its end waits for the next run; the scan reads no byte twice.
	const last = line({ type: "PLANNER_RESPONSE", model: "model-two", input_tokens: 150, output_tokens: 5 });
	appendFileSync(path, last.slice(0, 20));
	scan = scanTranscript(path, scan);
	assert.equal(scan.totals.output, 30);
	appendFileSync(path, last.slice(20));
	scan = scanTranscript(path, scan);
	assert.deepEqual(scan.totals, { input: 250, output: 35, cacheRead: 20, cacheWrite: 0 });
	assert.equal(scan.sys, 85);
	assert.equal(scan.lastInputTokens, 150);
	assert.equal(scan.state, "idle");
	assert.equal(scan.model, "model-two");
	assert.equal(scanTranscript(path, scan).totals.input, 250);

	// A shorter file is a new transcript: the scan starts again.
	writeFileSync(path, line({ type: "PLANNER_RESPONSE", input_tokens: 7, status: "ERROR" }));
	scan = scanTranscript(path, scan);
	assert.equal(scan.totals.input, 7);
	assert.equal(scan.state, "failed");
});

test("the agent state of the input maps to a footer state, else the scan state stays", () => {
	assert.equal(mapAgentState("THINKING", "idle"), "working");
	assert.equal(mapAgentState("input_needed", "idle"), "waiting");
	assert.equal(mapAgentState("error", "idle"), "failed");
	assert.equal(mapAgentState("done", "working"), "idle");
	assert.equal(mapAgentState("something-new", "working"), "working");
	assert.equal(mapAgentState(undefined, "failed"), "failed");
});

test("the effort comes from the input fields first, then the model id", () => {
	assert.equal(inferEffort({ model: { effort: "High" }, effort: "low" }, "m-low"), "high");
	assert.equal(inferEffort({ effort: { level: "medium" } }, "m-low"), "medium");
	assert.equal(inferEffort({ effort_level: "max" }, "m"), "max");
	assert.equal(inferEffort({}, "gemini-4-neon-xhigh"), "xhigh");
	assert.equal(inferEffort({ thinking: { enabled: true } }, "m"), "on");
	assert.equal(inferEffort({}, "m"), "off");
});

test("the used context prefers current_usage, then used_percentage, then the scan", () => {
	const scan = { lastInputTokens: 900 };
	const usage = { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 };
	assert.equal(currentWindowUsed({ current_usage: usage, used_percentage: 50, context_window_size: 1000 }, scan), 123);
	assert.equal(currentWindowUsed({ current_usage: {}, used_percentage: 12.5, context_window_size: 1000 }, scan), 125);
	assert.equal(currentWindowUsed({ used_percentage: 12.5, total_input_tokens: 5 }, scan), 900);
});

test("a measured 0 is a reading, and the session total is never the window fill", () => {
	const scan = { lastInputTokens: 900 };
	assert.equal(currentWindowUsed({ current_usage: { input_tokens: 0 }, used_percentage: 50, context_window_size: 1000 }, scan), 0);
	assert.equal(currentWindowUsed({ current_usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, scan), 0);
	assert.equal(currentWindowUsed({ used_percentage: 0, context_window_size: 1000 }, scan), 0);
	assert.equal(currentWindowUsed({ current_usage: { input_tokens: "7" }, used_percentage: 1, context_window_size: 1000 }, scan), 10);
	assert.equal(currentWindowUsed({ total_input_tokens: 5 }, {}), undefined);
	assert.equal(currentWindowUsed({ current_usage: {}, total_input_tokens: 5 }, { lastInputTokens: null }), undefined);
});

test("the health URLs of the profile replace those of the Pi agent folder", () => {
	assert.deepEqual(mergeHealthUrls({ healthUrls: { OV: "marker-global", OK: "marker-ok" } }, { healthUrls: { OV: "marker-profile" } }),
		{ OV: "marker-profile", OK: "marker-ok" });
	assert.deepEqual(mergeHealthUrls({ healthUrls: ["bad"] }, undefined), {});
	assert.deepEqual(mergeHealthUrls(undefined, { healthUrls: { OK: "marker-ok" } }), { OK: "marker-ok" });
});

test("the profile folder: the variable, then the profiles folder, then ~/.pi/agent", t => {
	const home = scratch(t);
	const profiles = join(home, ".pi", "profiles");
	assert.equal(resolveProfileDir({}, home), join(home, ".pi", "agent"));
	mkdirSync(join(profiles, "a"), { recursive: true });
	writeFileSync(join(profiles, "a", "settings.json"), "{}");
	assert.equal(resolveProfileDir({}, home), join(profiles, "a"));
	mkdirSync(join(profiles, "b", "ops-footer"), { recursive: true });
	writeFileSync(join(profiles, "b", "ops-footer", "settings.json"), "{}");
	assert.equal(resolveProfileDir({}, home), join(profiles, "b"));
	assert.equal(resolveProfileDir({ PI_CODING_AGENT_DIR: join(profiles, "a") }, home), join(profiles, "a"));
	assert.equal(resolveProfileDir({ PI_CODING_AGENT_DIR: join(home, "missing") }, home), join(profiles, "b"));
	mkdirSync(join(profiles, "tenant-pi-full"));
	assert.equal(resolveProfileDir({}, home), join(profiles, "tenant-pi-full"));
	assert.equal(resolveProfileDir({ PI_FOOTER_PROFILE: join(home, "chosen") }, home), join(home, "chosen"));
});

test("without tenantext the command prints one plain line and exits 0", async t => {
	const home = scratch(t);
	const input = { model: { display_name: "Model X" }, context_window: { used_percentage: 41.6 }, cwd: join(home, "demo") };
	const env = { PATH: process.env.PATH, HOME: home, XDG_CACHE_HOME: join(home, "cache"), PI_FOOTER_NO_REFRESH: "1",
		PI_FOOTER_TENANTEXT: join(home, "nonexistent") };
	const result = await new Promise(resolve => {
		const child = execFile(process.execPath, ["--no-warnings", script], { env, timeout: 10000 },
			(error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
		child.stdin.end(JSON.stringify(input));
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "agy · Model X · 42% · demo");
	assert.equal(fallbackLine("not json"), "agy");
});

test("the plain line is one printable line", () => {
	const raw = JSON.stringify({ model: { display_name: "Mo\x1b[31mdel\x1b[0m\nX\r\u0007\u009b2J" },
		cwd: "/tmp/dir\x1b]0;title\x07name\nnext\u0085" });
	const out = fallbackLine(raw);
	assert.doesNotMatch(out, /[\x00-\x1f\x7f-\x9f]/);
	assert.equal(out.split("\n").length, 1);
	assert.match(out, /^agy · /);
	assert.doesNotMatch(fallbackLine("", "/tmp/x\ny"), /[\x00-\x1f]/);
});

test("a transcript path below antigravity-cli outside brain/<id>/.system_generated/logs is never read", t => {
	const home = scratch(t);
	const cli = join(home, ".gemini", "antigravity-cli");
	const logs = join(cli, "brain", "abc-1", ".system_generated", "logs");
	mkdirSync(logs, { recursive: true });
	const entry = line({ type: "PLANNER_RESPONSE", input_tokens: 11 });
	const good = join(logs, "transcript.jsonl");
	writeFileSync(good, entry);
	// Forbidden: settings.json, the sign-in file, another .jsonl in antigravity-cli, and links to them from outside.
	writeFileSync(join(cli, "settings.json"), entry);
	writeFileSync(join(cli, "antigravity-oauth-token"), entry);
	writeFileSync(join(cli, "other.jsonl"), entry);
	writeFileSync(join(logs, "transcript_full.jsonl"), entry);
	const outside = join(home, "outside");
	mkdirSync(outside);
	symlinkSync(join(cli, "settings.json"), join(outside, "settings-link.jsonl"));
	symlinkSync(join(cli, "other.jsonl"), join(outside, "other-link.jsonl"));
	symlinkSync(good, join(outside, "good-link.jsonl"));
	symlinkSync(cli, join(outside, "cli-dir"));
	const forbidden = [join(cli, "settings.json"), join(cli, "antigravity-oauth-token"), join(cli, "other.jsonl"),
		join(logs, "transcript_full.jsonl"), join(outside, "settings-link.jsonl"), join(outside, "other-link.jsonl"),
		join(outside, "good-link.jsonl"), join(outside, "cli-dir", "other.jsonl"), join(logs, "..", "..", "..", "other.jsonl")];
	for (const path of forbidden) {
		const scan = scanTranscript(path, null, home);
		assert.equal(scan.offset, 0, path);
		assert.equal(scan.totals.input, 0, path);
	}
	assert.equal(transcriptAllowed(join(cli, "settings.json"), home), false);
	assert.equal(scanTranscript(good, null, home).totals.input, 11);
	// A plain .jsonl file outside antigravity-cli is read (the unit tests use such files).
	writeFileSync(join(outside, "plain.jsonl"), entry);
	assert.equal(scanTranscript(join(outside, "plain.jsonl"), null, home).totals.input, 11);
});

test("a new file of the same size at the transcript path starts a fresh scan", t => {
	const dir = scratch(t);
	const path = join(dir, "transcript.jsonl");
	writeFileSync(path, line({ type: "PLANNER_RESPONSE", input_tokens: 100 }));
	const first = scanTranscript(path, null);
	assert.equal(first.totals.input, 100);
	const replacement = join(dir, "next.jsonl");
	writeFileSync(replacement, line({ type: "PLANNER_RESPONSE", input_tokens: 200 }));
	renameSync(replacement, path);
	// The cache round trip of the session file keeps dev and ino.
	const second = scanTranscript(path, JSON.parse(JSON.stringify(first)));
	assert.equal(second.totals.input, 200);
	assert.notEqual(second.ino, first.ino);
});

test("the global ~/.pi/agent health URLs apply also when PI_CODING_AGENT_DIR names a profile", t => {
	const home = scratch(t);
	const profile = join(home, ".pi", "profiles", "work");
	mkdirSync(join(home, ".pi", "agent", "ops-footer"), { recursive: true });
	mkdirSync(join(profile, "ops-footer"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "ops-footer", "settings.json"), JSON.stringify({ healthUrls: { OV: "marker-global" } }));
	writeFileSync(join(profile, "ops-footer", "settings.json"), JSON.stringify({ healthUrls: { OK: "marker-profile" } }));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = profile;
	t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
	assert.equal(resolveProfileDir(process.env, home), profile);
	assert.deepEqual(footerSettings(resolveProfileDir(process.env, home), home).healthUrls, { OV: "marker-global", OK: "marker-profile" });
});

test("a Claude usage response with only five_hour and seven_day gives two limits", () => {
	const limits = usageLimits({ five_hour: { utilization: 12, resets_at: "2026-11-27T18:00:00Z" },
		seven_day: { utilization: 40.5, resets_at: "2026-12-01T00:00:00Z" } });
	assert.deepEqual(limits.map(l => [l.kind, l.percent, l.resets_at]),
		[["session", 12, "2026-11-27T18:00:00Z"], ["weekly_all", 40.5, "2026-12-01T00:00:00Z"]]);
	assert.deepEqual(usageLimits({ limits: [{ kind: "session", percent: 3 }], five_hour: { utilization: 9 } }).map(l => [l.kind, l.percent]),
		[["session", 3]]);
	assert.deepEqual(usageLimits({}), []);
	assert.deepEqual(usageLimits(null), []);
});

test("the Codex and Copilot caches of two profiles never mix", t => {
	const home = scratch(t);
	const full = join(home, ".pi", "profiles", "tenant-pi-full");
	const other = join(home, ".pi", "profiles", "other");
	mkdirSync(full, { recursive: true });
	mkdirSync(other, { recursive: true });
	const a = profileCache("codex-usage", full, home), b = profileCache("codex-usage", other, home);
	assert.equal(a.file, "codex-usage.json");
	assert.match(b.file, /^codex-usage-[0-9a-f]{8}\.json$/);
	assert.notEqual(a.key, b.key);
	assert.match(profileCache("copilot-usage", other, home).name, new RegExp(`^copilot-usage-${b.key}$`));
	// A legacy entry without key is the default profile's only.
	const legacy = { attemptAt: 1, snapshot: {} };
	assert.equal(profileReading(legacy, a), legacy);
	assert.equal(profileReading(legacy, b), undefined);
	assert.equal(profileReading({ ...legacy, profileKey: a.key }, b), undefined);
	assert.deepEqual(profileReading({ ...legacy, profileKey: b.key }, b), { ...legacy, profileKey: b.key });
});

test("the lock: one of two overlapping runs runs, the lock file stays, and the next run takes it", async t => {
	const dir = scratch(t);
	const path = join(dir, "meter.lock");
	let entered, release;
	const started = new Promise(done => { entered = done; });
	const gate = new Promise(done => { release = done; });
	// A failed assertion still ends the first run, so its lock holder ends too.
	t.after(() => release());
	const first = withLock("meter", async () => { entered("entered"); await gate; return "ran"; }, dir);
	// Fail fast instead of hanging if the first lock attempt exits without entering the task (e.g. missing python3).
	assert.equal(await Promise.race([started, first.then(() => "exited")]), "entered");
	let secondRan = false;
	assert.equal(await withLock("meter", async () => { secondRan = true; return "ran"; }, dir), undefined);
	assert.equal(secondRan, false);
	release();
	assert.equal(await first, "ran");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	// The lock file is never deleted, and the kernel lock ended with the first run.
	assert.equal(await withLock("meter", async () => "again", dir), "again");
	assert.equal(existsSync(path), true);
	// No lock folder: no lock, and the task does not run.
	assert.equal(await withLock("meter", async () => "ran", join(dir, "absent")), undefined);
});

test("the OpenViking row needs a session id and takes the time of the cursor file", t => {
	const dir = scratch(t);
	const state = join(dir, "agy"), ov = join(dir, "ov");
	mkdirSync(state); mkdirSync(ov);
	writeFileSync(join(state, "s1.json"), JSON.stringify({ sentStep: 3, committedStep: 3 }));
	const at = Date.parse("2026-01-02T03:04:05Z");
	utimesSync(join(state, "s1.json"), at / 1000, at / 1000);
	writeFileSync(join(ov, "last-capture.json"), JSON.stringify({ cc_session_id: "", commit_count: 4, ts: at }));
	assert.deepEqual(openVikingMemory("", at + 1000, state, ov), { running: [] });
	assert.deepEqual(openVikingMemory(undefined, at + 1000, state, ov), { running: [] });
	const memory = openVikingMemory("s1", at + 1000, state, ov);
	assert.equal(memory.last, "commit");
	assert.equal(memory.added, undefined);
	// A recall after the mtime of the cursor and before now wins: the cursor counts at its file time, not at now.
	writeFileSync(join(ov, "last-recall.json"), JSON.stringify({ cc_session_id: "s1", count: 2, ts: at + 500 }));
	assert.equal(openVikingMemory("s1", at + 1000, state, ov).last, "recall");
});
