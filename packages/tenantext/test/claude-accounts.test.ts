import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsRoot, AccountError, adopt, use } from "../claude-code/scripts/claude-accounts.mjs";
import { createAnthropicMeter } from "../extensions/anthropic-usage/accounts.ts";
import { parseAnthropicSettings } from "../extensions/anthropic-usage/settings.ts";
import { fileSharedStore, sharedReadingPath } from "../extensions/anthropic-usage/shared.ts";
import type { AnthropicCredential } from "../extensions/anthropic-usage/detect.ts";
import { anthropicStatus } from "../extensions/ops-footer/adapters.ts";

// Fixture values, built in parts. They are not credentials.
const part = (name: string) => [name, "fixture", "value".repeat(4)].join("-");
const NOW = Date.parse("2026-11-17T12:00:00Z");
const oauth = (name: string) => ({ accessToken: part(`${name}access`), refreshToken: part(`${name}refresh`), expiresAt: NOW + 3_600_000, subscriptionType: "max", scopes: ["user:inference"] });
const account = (name: string) => ({ accountUuid: `uuid-${name}`, emailAddress: `fixture-${name}` });

function fixtureHome() {
	const home = mkdtempSync(join(tmpdir(), "claude-accounts-"));
	const env = { HOME: home } as NodeJS.ProcessEnv;
	mkdirSync(join(home, ".claude"), { recursive: true });
	const credentials = join(home, ".claude", ".credentials.json"), claudeJson = join(home, ".claude.json");
	const write = (path: string, value: unknown) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
	const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
	const slot = (n: string, file: string) => join(accountsRoot(env, home), n, file);
	return { home, env, credentials, claudeJson, write, read, slot, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("use saves the live login to its slot first, then changes only claudeAiOauth and oauthAccount in the live files", () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one"), mcpOAuth: { server: { kept: true } } });
		f.write(f.claudeJson, { oauthAccount: account("one"), projects: { kept: 1 }, theme: "dark" });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two"), onboarding: "slot-only" });
		// Claude Code renewed the live login after the adopt.
		const renewed = { ...oauth("one"), accessToken: part("onerenewed"), refreshToken: part("onerotated") };
		f.write(f.credentials, { claudeAiOauth: renewed, mcpOAuth: { server: { kept: true } } });

		use("2", { env: f.env, home: f.home, now: NOW + 1000 });
		assert.deepEqual(f.read(f.slot("1", ".credentials.json")).claudeAiOauth, renewed, "the renewed live login is saved to slot 1");
		assert.deepEqual(f.read(f.credentials), { claudeAiOauth: oauth("two"), mcpOAuth: { server: { kept: true } } });
		assert.deepEqual(f.read(f.claudeJson), { oauthAccount: account("two"), projects: { kept: 1 }, theme: "dark" });
		assert.equal(statSync(f.credentials).mode & 0o777, 0o600);
		assert.equal(statSync(f.claudeJson).mode & 0o777, 0o600);
	} finally { f.done(); }
});

test("use refuses with no write when the live login belongs to no slot", () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one") });
		f.write(f.claudeJson, { oauthAccount: account("one") });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two") });
		// A third account is logged in live, outside the store.
		f.write(f.credentials, { claudeAiOauth: oauth("three") });
		f.write(f.claudeJson, { oauthAccount: account("three") });
		const before = [f.credentials, f.claudeJson, f.slot("1", ".credentials.json"), f.slot("2", ".credentials.json"), join(accountsRoot(f.env, f.home), "state.json")]
			.map(path => [path, readFileSync(path, "utf8")]);
		assert.throws(() => use("2", { env: f.env, home: f.home, now: NOW + 1000 }), AccountError);
		for (const [path, text] of before) assert.equal(readFileSync(path, "utf8"), text, path);
	} finally { f.done(); }
});

/** The text of each file, to show that a refused command wrote nothing. */
const snapshot = (paths: string[]) => paths.map(path => [path, readFileSync(path, "utf8")]);
/** The names of every entry under a folder, sorted. A link is not followed. */
const listFiles = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

test("use refuses with no write when the live files name different accounts", () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one") });
		f.write(f.claudeJson, { oauthAccount: account("one") });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two") });
		// The live credentials hold the login of slot 2, but .claude.json still names the account of slot 1.
		f.write(f.credentials, { claudeAiOauth: oauth("two") });
		const before = snapshot([f.credentials, f.claudeJson, f.slot("1", ".credentials.json"), f.slot("2", ".credentials.json"), join(accountsRoot(f.env, f.home), "state.json")]);
		assert.throws(() => use("1", { env: f.env, home: f.home, now: NOW + 1000 }), AccountError);
		for (const [path, text] of before) assert.equal(readFileSync(path, "utf8"), text, path);
	} finally { f.done(); }
});

test("use and adopt refuse with no write when CLAUDE_CONFIG_DIR is a slot folder", () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one") });
		f.write(f.claudeJson, { oauthAccount: account("one") });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two") });
		// A session of claude2 while slot 1 is active: its config folder is the slot 2 folder.
		const env = { ...f.env, CLAUDE_CONFIG_DIR: join(accountsRoot(f.env, f.home), "2") } as NodeJS.ProcessEnv;
		const before = snapshot([f.credentials, f.claudeJson, f.slot("1", ".credentials.json"), f.slot("1", ".claude.json"),
			f.slot("2", ".credentials.json"), f.slot("2", ".claude.json"), join(accountsRoot(f.env, f.home), "state.json")]);
		for (const slot of ["1", "2"]) {
			assert.throws(() => use(slot, { env, home: f.home, now: NOW + 1000 }), AccountError, `use ${slot}`);
			assert.throws(() => adopt(slot, { env, home: f.home, now: NOW + 1000 }), AccountError, `adopt ${slot}`);
		}
		for (const [path, text] of before) assert.equal(readFileSync(path, "utf8"), text, path);

		// ~/.claude is a link to the slot 2 folder, and CLAUDE_CONFIG_DIR is unset.
		rmSync(join(f.home, ".claude"), { recursive: true, force: true });
		symlinkSync(join(accountsRoot(f.env, f.home), "2"), join(f.home, ".claude"));
		const names = listFiles(f.home);
		const linked = snapshot([...before.map(([path]) => path).filter(path => path !== f.credentials)]);
		for (const slot of ["1", "2"]) {
			assert.throws(() => use(slot, { env: f.env, home: f.home, now: NOW + 1000 }), AccountError, `use ${slot}, ~/.claude linked`);
			assert.throws(() => adopt(slot, { env: f.env, home: f.home, now: NOW + 1000 }), AccountError, `adopt ${slot}, ~/.claude linked`);
		}
		for (const [path, text] of linked) assert.equal(readFileSync(path, "utf8"), text, path);
		assert.deepEqual(listFiles(f.home), names, "no new file, also no .prev file");
	} finally { f.done(); }
});

test("adopt refuses over a slot, active or not, that holds another account", () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one") });
		f.write(f.claudeJson, { oauthAccount: account("one") });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two") });
		// A third account is logged in live. Slot 1 is active and holds the only copy of account one.
		f.write(f.credentials, { claudeAiOauth: oauth("three") });
		f.write(f.claudeJson, { oauthAccount: account("three") });
		const before = snapshot([f.slot("1", ".credentials.json"), f.slot("2", ".credentials.json"), join(accountsRoot(f.env, f.home), "state.json")]);
		for (const slot of ["1", "2"]) assert.throws(() => adopt(slot, { env: f.env, home: f.home, now: NOW + 1000 }), AccountError, slot);
		for (const [path, text] of before) assert.equal(readFileSync(path, "utf8"), text, path);
	} finally { f.done(); }
});

test("the usage reading of one account never shows on the row of the other after a switch", async () => {
	const f = fixtureHome();
	try {
		f.write(f.credentials, { claudeAiOauth: oauth("one") });
		f.write(f.claudeJson, { oauthAccount: account("one") });
		adopt("1", { env: f.env, home: f.home, now: NOW });
		f.write(f.slot("2", ".credentials.json"), { claudeAiOauth: oauth("two") });
		f.write(f.slot("2", ".claude.json"), { oauthAccount: account("two") });
		// Each token has its own reading: account one 70% left, account two 20% left.
		const used: Record<string, number> = { [part("oneaccess")]: 30, [part("twoaccess")]: 80 };
		let fail = false;
		const fetcher = async (credential: AnthropicCredential) => {
			if (fail) return { success: false as const, error: "HTTP 429", auth: false };
			return { success: true as const, usage: { windows: [{ label: "5h", remainingPercent: 100 - used[credential.token] }] } };
		};
		let now = NOW;
		const meter = () => createAnthropicMeter({
			settings: () => parseAnthropicSettings({}), detect: () => ({ env: f.env, home: f.home }), emit: () => {}, fetcher, clock: () => now,
			sharedFor: slot => fileSharedStore(sharedReadingPath(f.env, f.home, slot)), claimRenew: () => true, renew: async () => {},
		});
		// One entry per row in slot order: the percent left of each window.
		const rows = (value: unknown) => anthropicStatus(value, now)?.accounts.map(a => a.windows.map(w => w.percent));

		const first = meter();
		assert.deepEqual(rows(await first.refresh(true)), [[70], [20]]);

		use("2", { env: f.env, home: f.home, now: now + 1000 });
		// Another client right after the switch: it takes each slot's shared reading.
		now += 60_000;
		assert.deepEqual(rows(await meter().refresh()), [[70], [20]]);
		// The first client after the switch, with failed requests: each row keeps its own last reading.
		now += 6 * 60_000; fail = true;
		assert.deepEqual(rows(await first.refresh(true)), [[70], [20]]);
	} finally { f.done(); }
});
