import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../claude-code/bin/claude-slot.sh", import.meta.url));

// Fixture values, built in parts. They are not credentials.
const part = (name: string) => [name, "fixture", "value".repeat(4)].join("-");
const oauth = (name: string) => ({ accessToken: part(`${name}access`), refreshToken: part(`${name}refresh`), subscriptionType: "max" });
const account = (name: string) => ({ accountUuid: `uuid-${name}`, emailAddress: `fixture-${name}` });

/**
 * A temp home with a store (slot 1 and 2 logged in, the live login is the login of the active slot) and a fake `claude`
 * first on PATH that records its environment.
 */
function fixtureHome(active: string) {
	const home = mkdtempSync(join(tmpdir(), "claude-slot-"));
	const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text, { mode }); };
	const json = (path: string, value: unknown) => write(path, JSON.stringify(value));
	const store = join(home, ".local", "state", "claude-accounts");
	json(join(store, "state.json"), { active, switchedAt: 1 });
	for (const slot of ["1", "2"]) {
		json(join(store, slot, ".credentials.json"), { claudeAiOauth: oauth(`slot${slot}`) });
		json(join(store, slot, ".claude.json"), { oauthAccount: account(`slot${slot}`) });
	}
	json(join(home, ".claude", ".credentials.json"), { claudeAiOauth: oauth(`slot${active}`) });
	json(join(home, ".claude", ".credentials.json.prev"), { claudeAiOauth: oauth("old") });
	json(join(home, ".claude", "settings.json"), { theme: "dark" });
	json(join(home, ".claude.json"), { oauthAccount: account(`slot${active}`), mcpServers: { fixture: { command: "true" } } });
	const seen = join(home, "seen");
	write(join(home, "fakebin", "claude"), `#!/bin/sh\nprintf '%s\\n%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "\${CLAUDE_ACCOUNT_SLOT-}" > '${seen}'\n`, 0o755);
	const start = (args: string[], extra: Record<string, string> = {}) => {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${join(home, "fakebin")}:${process.env.PATH}`, ...extra };
		delete env.XDG_STATE_HOME;
		if (!("CLAUDE_CONFIG_DIR" in extra)) delete env.CLAUDE_CONFIG_DIR;
		return spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
	};
	const run = (args: string[], extra: Record<string, string> = {}) => {
		const result = start(args, extra);
		assert.equal(result.status, 0, result.stderr);
		const [configDir, slot] = readFileSync(seen, "utf8").split("\n");
		return { configDir, slot };
	};
	return { home, store, seen, write, json, start, run, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("the other slot keeps its own login and account, keeps a real file, and starts claude in the slot folder", () => {
	const f = fixtureHome("1");
	try {
		const dir = join(f.store, "2");
		const credentials = join(dir, ".credentials.json");
		const before = readFileSync(credentials, "utf8");
		// A real file of the slot with the name of an entry of ~/.claude.
		f.write(join(f.home, ".claude", "CLAUDE.md"), "shared");
		f.write(join(dir, "CLAUDE.md"), "own");

		const seen = f.run(["2", "auth", "status"]);
		assert.equal(seen.configDir, dir);
		assert.equal(seen.slot, "2");
		assert.equal(readFileSync(credentials, "utf8"), before, "the slot login is unchanged");
		assert.equal(lstatSync(credentials).isSymbolicLink(), false, "the slot login is no link to ~/.claude");
		assert.equal(existsSync(join(dir, ".credentials.json.prev")), false, "no saved login of ~/.claude is linked in");
		const claudeJson = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
		assert.deepEqual(claudeJson.oauthAccount, account("slot2"));
		assert.deepEqual(claudeJson.mcpServers, { fixture: { command: "true" } });
		assert.equal(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink(), false);
		assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "own");
	} finally { f.done(); }
});

test("the active slot starts claude with no CLAUDE_CONFIG_DIR, also when the caller set one", () => {
	const f = fixtureHome("2");
	try {
		const seen = f.run(["2"], { CLAUDE_CONFIG_DIR: join(f.store, "1") });
		assert.equal(seen.configDir, "unset");
		assert.equal(seen.slot, "2");
	} finally { f.done(); }
});

/** Each file, link and folder under the home, with its content or its link target. The fake `claude` is left out. */
function tree(home: string) {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry), stat = lstatSync(path);
			if (path === join(home, "fakebin")) continue;
			if (stat.isSymbolicLink()) out[path] = `link:${readlinkSync(path)}`;
			else if (stat.isDirectory()) { out[path] = "folder"; walk(path); }
			else out[path] = `file:${readFileSync(path, "utf8")}`;
		}
	};
	walk(home);
	return out;
}

test("the launcher refuses a state or a login that does not agree, before any change", () => {
	type Fixture = ReturnType<typeof fixtureHome>;
	const cases: [string, (f: Fixture) => void][] = [
		["state.json is missing", f => rmSync(join(f.store, "state.json"))],
		["state.json is invalid", f => f.write(join(f.store, "state.json"), "{ not json")],
		["the live oauthAccount is another account", f => f.json(join(f.home, ".claude.json"), { oauthAccount: account("other") })],
		["the live refresh token is the saved token of the other slot", f => f.json(join(f.home, ".claude", ".credentials.json"), { claudeAiOauth: oauth("slot2") })],
		["the slot .credentials.json has no claudeAiOauth", f => f.json(join(f.store, "2", ".credentials.json"), { mcpOAuth: {} })],
		["the slot .credentials.json is a link to the live file", f => {
			rmSync(join(f.store, "2", ".credentials.json"));
			symlinkSync(join(f.home, ".claude", ".credentials.json"), join(f.store, "2", ".credentials.json"));
		}],
	];
	for (const [name, change] of cases) {
		const f = fixtureHome("1");
		try {
			change(f);
			const before = tree(f.home);
			const result = f.start(["2", "auth", "status"]);
			assert.notEqual(result.status, 0, name);
			assert.equal(existsSync(f.seen), false, `${name}: claude did not start`);
			assert.deepEqual(tree(f.home), before, `${name}: no file changed`);
		} finally { f.done(); }
	}
});
