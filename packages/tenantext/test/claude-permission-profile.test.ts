import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const plugin = join(import.meta.dirname, "..", "claude-code");
const launcher = join(plugin, "bin", "tenant-claude.mjs");
const controller = join(plugin, "scripts", "claude-mode.mjs");
const installer = join(plugin, "install-launcher.mjs");

function fixture() {
	// Keep scratch artifacts for a failed probe. No inherited credentials or Claude settings.
	const home = mkdtempSync(join(tmpdir(), "tenant-claude-mode-"));
	const bin = join(home, "bin");
	const state = join(home, ".claude", "tenantext", "permission-profile.json");
	const capture = join(home, "argv.json");
	mkdirSync(bin);
	mkdirSync(dirname(state), { recursive: true });
	const settings = join(home, ".claude", "settings.json");
	const credentials = join(home, ".claude", ".credentials.json");
	writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: "auto", allow: ["Read(./fixture-a)", "Read(./fixture-b)"], deny: ["Write(./protected)"] }, enabledPlugins: { fixture: true } }));
	writeFileSync(credentials, randomBytes(32));
	const originalSettings = readFileSync(settings);
	const originalCredentials = readFileSync(credentials);
	writeFileSync(join(bin, "claude"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR ?? null }));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`, { mode: 0o700 });
	const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CAPTURE: capture };
	function run(script: string, args: string[] = [], extra: Record<string, string> = {}, cwd = home) {
		return spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, cwd, encoding: "utf8", timeout: 10_000 });
	}
	function ok(script: string, args: string[] = [], extra: Record<string, string> = {}, cwd = home) {
		const result = run(script, args, extra, cwd);
		assert.equal(result.status, 0, result.stderr);
		return result;
	}
	function unchanged() {
		assert.deepEqual(readFileSync(settings), originalSettings);
		assert.deepEqual(readFileSync(credentials), originalCredentials);
	}
	return { home, bin, state, capture, env, run, ok, unchanged };
}

function assertDefaultRules(output: string) {
	assert.match(output, /Default.*retain.*allow.*deny/i);
	assert.match(output, /already allowed.*without.*prompt/i);
}

test("unset Default and each shared selection round-trip without changing Claude settings or credentials", () => {
	const f = fixture();
	const status = f.ok(launcher).stdout;
	assert.match(status, /Saved launch selection: Default/);
	assertDefaultRules(status);
	assertDefaultRules(f.ok(controller).stdout);
	assert.equal(existsSync(f.state), false);
	assert.equal(existsSync(f.capture), false);
	assertDefaultRules(f.ok(launcher, ["launch"]).stderr);
	assert.deepEqual(JSON.parse(readFileSync(f.capture, "utf8")).args, ["--permission-mode", "default"]);
	const cache = join(f.home, "plugin-cache");
	cpSync(join(plugin, "scripts"), join(cache, "scripts"), { recursive: true });
	const worktree = join(f.home, "worktree");
	mkdirSync(worktree);
	for (const [mode, label, native] of [["auto", "Auto", "auto"], ["yolo", "YOLO", "bypassPermissions"], ["default", "Default", "default"]]) {
		const selected = f.ok(join(cache, "scripts", "claude-mode.mjs"), [mode], { PI_CODING_AGENT_DIR: join(f.home, "unrelated-pi-profile") }, worktree);
		assert.match(selected.stdout, /not this conversation/);
		if (mode === "yolo") assert.match(selected.stderr, /Warning: YOLO.*not Auto/);
		assert.match(f.ok(launcher, ["mode"]).stdout, new RegExp(`Saved launch selection: ${label}`));
		const launched = f.ok(launcher, ["launch"]);
		if (mode === "yolo") assert.match(launched.stderr, /Warning: YOLO/);
		if (mode === "default") {
			assertDefaultRules(selected.stdout);
			assertDefaultRules(launched.stderr);
		}
		assert.deepEqual(JSON.parse(readFileSync(f.capture, "utf8")).args, ["--permission-mode", native]);
		assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), { version: 1, mode });
		assert.equal(lstatSync(f.state).mode & 0o777, 0o600);
	}
	f.ok(launcher, ["mode", "auto"]);
	assert.match(f.ok(controller, ["status"]).stdout, /Saved launch selection: Auto/);
	assertDefaultRules(f.ok(controller, ["reset"]).stdout);
	assert.match(f.ok(launcher).stdout, /Saved launch selection: Default/);
	f.unchanged();
});

test("both entry points reuse the existing absolute Claude state-directory overrides", () => {
	const f = fixture();
	const config = join(f.home, "alternate-claude");
	const override = { CLAUDE_CONFIG_DIR: config };
	f.ok(controller, ["auto"], override);
	assert.equal(existsSync(join(config, "tenantext", "permission-profile.json")), true);
	assert.match(f.ok(launcher, ["mode"], override).stdout, /selection: Auto/);
	f.ok(launcher, ["launch"], override);
	assert.equal(JSON.parse(readFileSync(f.capture, "utf8")).config, config);
	const explicit = { ...override, TENANTEXT_CLAUDE_DIR: join(f.home, "chosen-profile") };
	f.ok(launcher, ["mode", "default"], explicit);
	assert.match(f.ok(controller, [], explicit).stdout, /selection: Default/);
	assert.equal(existsSync(f.state), false);
	assert.equal(f.run(launcher, ["launch"], { TENANTEXT_CLAUDE_DIR: "relative" }).status, 2);
	f.unchanged();
});

test("launch forwards ordinary argv, cwd, exit status and signals without shell evaluation or fallback", () => {
	const f = fixture();
	const args = ["--model", "fixture-model", "-p", "--append-system-prompt", "a quoted 'value'\nand $(touch marker); attach logs to the update", "", "--", "explain --permission-mode=yolo and install plugins", "list: - list item; temperature: -1 degree"];
	f.ok(launcher, ["launch", ...args]);
	assert.deepEqual(JSON.parse(readFileSync(f.capture, "utf8")), { args: ["--permission-mode", "default", ...args], cwd: f.home, config: null });
	assert.equal(existsSync(join(f.home, "marker")), false);
	f.ok(controller, ["yolo"]);
	assert.equal(f.run(launcher, ["launch"], { STUB_EXIT: "42" }).status, 42);
	assert.equal(JSON.parse(readFileSync(f.state, "utf8")).mode, "yolo");
	writeFileSync(join(f.bin, "claude"), `#!${process.execPath}\nprocess.kill(process.pid, "SIGTERM");\n`, { mode: 0o700 });
	assert.equal(f.run(launcher, ["launch"]).signal, "SIGTERM");
	f.unchanged();
});

test("invalid state and ambiguous selections fail without a launch; reset repairs only regular state files", () => {
	const f = fixture();
	for (const raw of ["", "{", "null", '{"version":1,"mode":"bypassPermissions"}', '{"version":1,"mode":["yolo"]}', '{"version":2,"mode":"yolo"}', '{"version":1,"mode":"yolo","extra":true}', "x".repeat(1025)]) {
		writeFileSync(f.state, raw);
		assert.equal(f.run(launcher, ["launch"]).status, 2);
		assert.equal(f.run(controller, ["yolo"]).status, 2);
		assert.equal(readFileSync(f.state, "utf8"), raw);
		assert.equal(existsSync(f.capture), false);
	}
	f.ok(controller, ["reset"]);
	const before = readFileSync(f.state);
	for (const args of [[""], ["YOLO"], ["yes"], ["bypassPermissions"], ["auto", "yolo"], ["yolo; touch marker"], ["$(touch marker)"], ["toString"]]) {
		assert.equal(f.run(controller, args).status, 2);
		assert.equal(f.run(launcher, ["mode", ...args]).status, 2);
		assert.deepEqual(readFileSync(f.state), before);
	}
	const invalidAction = f.run(launcher, ["yolo"]);
	assert.equal(invalidAction.status, 2);
	assert.equal(invalidAction.stderr, f.ok(launcher, ["help"]).stdout);
	assert.equal(existsSync(f.capture), false);
	assert.equal(existsSync(join(f.home, "marker")), false);
	const linked = join(f.home, "linked-state");
	mkdirSync(linked);
	symlinkSync(f.state, join(linked, "permission-profile.json"));
	for (const args of [["launch"], ["mode", "reset"]]) {
		assert.equal(f.run(launcher, args, { TENANTEXT_CLAUDE_DIR: linked }).status, 2);
	}
	assert.deepEqual(readFileSync(f.state), before);
	f.unchanged();
});

test("permission, settings and existing-session overrides fail before launch, including equals forms", () => {
	const f = fixture();
	f.ok(controller, ["auto"]);
	const before = readFileSync(f.state);
	for (const args of [
		["--permission-mode", "bypassPermissions"], ["--permission-mode=default"], ["--dangerously-skip-permissions"],
		["--allow-dangerously-skip-permissions"], ["--enable-auto-mode"], ["--permission-prompts=none"],
		["--permission-prompt-tool", "fixture"], ["--allowedTools=Bash"], ["--allowed-tools", "Bash"],
		["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'], ["--settings=./settings.json"],
		["--setting-sources=user"], ["-r", "fixture"], ["--continue"], ["--resume=fixture"], ["--cloud"], ["-pc"], ["-rfixture"],
		["--", "--permission-mode=yolo"], ["--model", "--", "--permission-mode=bypassPermissions"],
	]) {
		assert.equal(f.run(launcher, ["launch", ...args]).status, 2, JSON.stringify(args));
		assert.equal(existsSync(f.capture), false);
		assert.deepEqual(readFileSync(f.state), before);
	}
	f.unchanged();
});

test("native commands and dash-led values fail before state loading, banners or launch", () => {
	const f = fixture();
	const commands = [
		"agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
		"plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
	];
	const commandArgs = [
		...commands.map((command) => [command]),
		["--model", "fixture-model", "attach", "fixture"], ["--", "logs"], ["--model", "--", "kill", "fixture"],
		["-p", "install"], ["--append-system-prompt", "update"],
	];
	const cases: [string[], RegExp][] = [
		...commandArgs.map((args): [string[], RegExp] => [args, /subcommand refused.*ordinary claude/]),
		...["- list item", "-1 degree"].flatMap((value) => [
			[value], ["--append-system-prompt", value], ["--", value],
		].map((args): [string[], RegExp] => [args, /combined or attached short forms/])),
	];
	// A malformed profile must not mask argument rejection or print a launch banner.
	for (const raw of [null, '{"version":1,"mode":"yolo"}', "{"]) {
		if (raw !== null) writeFileSync(f.state, raw);
		for (const [args, reason] of cases) {
			const result = f.run(launcher, ["launch", ...args]);
			assert.equal(result.status, 2, JSON.stringify(args));
			assert.match(result.stderr, reason);
			assert.doesNotMatch(result.stderr, /Requested launch mode|Warning: YOLO/);
			assert.equal(result.stdout, "");
			assert.equal(existsSync(f.capture), false);
			assert.equal(existsSync(f.state) ? readFileSync(f.state, "utf8") : null, raw);
			f.unchanged();
		}
	}
});

test("missing executable and failed state writes report failure without changing Claude files", () => {
	const f = fixture();
	assert.equal(f.run(launcher, ["launch"], { PATH: join(f.home, "absent") }).status, 2);
	const parent = join(f.home, "not-a-directory");
	writeFileSync(parent, "unchanged");
	assert.equal(f.run(controller, ["auto"], { TENANTEXT_CLAUDE_DIR: parent }).status, 2);
	assert.equal(f.run(controller, ["default"], { TENANTEXT_CLAUDE_DIR: join(parent, "nested") }).status, 2);
	assert.equal(readFileSync(parent, "utf8"), "unchanged");
	f.ok(controller, ["auto"]);
	const before = readFileSync(f.state);
	const fault = join(f.home, "fault.mjs");
	writeFileSync(fault, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.renameSync = () => { throw new Error("scratch write refusal"); };
if (process.env.FAIL_CLEANUP) fs.unlinkSync = () => { throw new Error("scratch cleanup refusal"); };
syncBuiltinESMExports();\n`);
	const refused = f.run(controller, ["reset"], { NODE_OPTIONS: `--import=${fault}` });
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /Cannot save permission profile/);
	const cleanupRefused = f.run(controller, ["reset"], { NODE_OPTIONS: `--import=${fault}`, FAIL_CLEANUP: "1" });
	assert.equal(cleanupRefused.status, 2);
	assert.match(cleanupRefused.stderr, /Cannot remove temporary permission profile/);
	assert.deepEqual(readFileSync(f.state), before);
	assert.equal(existsSync(f.capture), false);
	f.unchanged();
});

test("standalone installation is opt-in, idempotent and preserves every unrelated entry", () => {
	const f = fixture();
	f.ok(installer);
	const link = join(f.home, ".local", "bin", "tenant-claude");
	assert.equal(readlinkSync(link), launcher);
	f.ok(installer);
	assert.equal(existsSync(f.state), false);
	assert.equal(existsSync(f.capture), false);
	const result = spawnSync(link, ["mode", "status"], { env: f.env, encoding: "utf8", timeout: 10_000 });
	assert.equal(result.status, 0, result.stderr);
	for (const kind of ["file", "directory", "link", "broken-link"]) {
		const home = join(f.home, kind);
		const target = join(home, ".local", "bin", "tenant-claude");
		mkdirSync(dirname(target), { recursive: true });
		if (kind === "file") writeFileSync(target, "unrelated");
		else if (kind === "directory") mkdirSync(target);
		else symlinkSync(kind === "link" ? launcher : join(home, "missing"), target);
		// Even a link to another checkout is kept; this case uses a spelling the installer does not own.
		if (kind === "link") {
			const differentInstaller = join(f.home, "copied-plugin", "install-launcher.mjs");
			cpSync(plugin, dirname(differentInstaller), { recursive: true, filter: (path) => !path.endsWith("skills") });
			assert.equal(f.run(differentInstaller, [], { HOME: home }).status, 2);
		} else assert.equal(f.run(installer, [], { HOME: home }).status, 2);
		if (kind === "file") assert.equal(readFileSync(target, "utf8"), "unrelated");
		else if (kind === "directory") assert.equal(lstatSync(target).isDirectory(), true);
		else assert.equal(readlinkSync(target), kind === "link" ? launcher : join(home, "missing"));
	}
	assert.equal(f.run(installer, ["unexpected"]).status, 2);
	assert.equal(f.run(installer, [], { HOME: "relative" }).status, 2);
	const blockedHome = join(f.home, "blocked-home");
	mkdirSync(blockedHome);
	writeFileSync(join(blockedHome, ".local"), "unchanged");
	assert.equal(f.run(installer, [], { HOME: blockedHome }).status, 2);
	assert.equal(readFileSync(join(blockedHome, ".local"), "utf8"), "unchanged");
	f.unchanged();
});

test("the shipped slash command is user-only and never expands untrusted arguments as shell code", () => {
	const command = readFileSync(join(plugin, "commands", "claude-mode.md"), "utf8");
	assert.match(command, /^disable-model-invocation: true$/m);
	assert.doesNotMatch(command, /!`/);
	assert.doesNotMatch(command, /^allowed-tools:/m);
	assert.match(command, /scripts\/claude-mode\.mjs/);
	assert.match(command, /Empty input means `status`/);
	const hooks = readFileSync(join(plugin, "hooks", "hooks.json"), "utf8");
	assert.doesNotMatch(hooks, /claude-mode|permission-profile|tenant-claude/);
	const packageJson = JSON.parse(readFileSync(join(plugin, "..", "package.json"), "utf8"));
	assert.ok(packageJson.files.includes("claude-code"));
	const marketplace = JSON.parse(readFileSync(join(plugin, "..", ".claude-plugin", "marketplace.json"), "utf8"));
	assert.equal(marketplace.plugins[0].source, "./claude-code");
});
