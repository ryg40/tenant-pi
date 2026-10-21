import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDir } from "../src/agent-dir.ts";
import { DEFAULT_SETTINGS, ensureSettings, loadSettings, parseSettings, saveSettings, stateDir } from "../src/settings.ts";
import { anthropicSettingsPath } from "../extensions/anthropic-usage/settings.ts";
import { codexAccountsSettingsPath } from "../extensions/codex-accounts/config.ts";
import { settingsPath as contextMeterSettingsPath } from "../src/context-meter-settings.ts";
import { copilotSettingsPath } from "../extensions/copilot-usage/settings.ts";
import { settingsPath as footerSettingsPath } from "../extensions/ops-footer/settings.ts";

test("parseSettings ignores unknown keys and fills defaults", () => {
	assert.deepEqual(parseSettings({ rules: false, junk: 1 }), { rules: false, guard: true, decisions: true });
	assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(parseSettings({ rules: "yes" }), DEFAULT_SETTINGS);
	assert.equal(parseSettings({ decisions: false }).decisions, false);
	assert.equal(parseSettings({ decisions: "off" }).decisions, true);
});

test("save then load round-trips through a file", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-"));
	const path = join(dir, "nested", "settings.json");
	saveSettings({ rules: false, guard: false, decisions: false }, path);
	assert.deepEqual(loadSettings(path), { rules: false, guard: false, decisions: false });
	assert.ok(readFileSync(path, "utf8").endsWith("\n"));
});

test("missing or corrupt file yields defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-"));
	assert.deepEqual(loadSettings(join(dir, "none.json")), DEFAULT_SETTINGS);
});

test("startup populates blank settings and a commented guide without replacing user values", () => {
	const dir = mkdtempSync(join(tmpdir(), "tenantext-settings-"));
	const path = join(dir, "settings.json");
	writeFileSync(path, "  \n");
	ensureSettings(path);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_SETTINGS);
	assert.match(readFileSync(join(dir, "settings.example.jsonc"), "utf8"), /\/\/ rules: true \| false/);
	assert.match(readFileSync(join(dir, "settings.example.jsonc"), "utf8"), /\/\/ decisions: true \| false/);
	saveSettings({ rules: false, guard: true, decisions: true }, path);
	ensureSettings(path);
	assert.equal(loadSettings(path).rules, false);
});

test("PI_CODING_AGENT_DIR=~/x gives <home>/x in every extension", (t) => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/x" }, "/home/u"), "/home/u/x");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~" }, "/home/u"), "/home/u");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }, "/home/u"), "/srv/pi");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "a~/b" }, "/home/u"), "a~/b", "only a leading tilde expands");
	assert.equal(agentDir({}, "/home/u"), "/home/u/.pi/agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "~/x";
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const home = join(homedir(), "x");
	assert.equal(stateDir(), join(home, "tenantext"));
	assert.equal(copilotSettingsPath(), join(home, "copilot-usage", "settings.json"));
	assert.equal(anthropicSettingsPath(), join(home, "anthropic-usage", "settings.json"));
	assert.equal(codexAccountsSettingsPath(), join(home, "codex-accounts", "settings.json"));
	assert.equal(contextMeterSettingsPath(), join(home, "context-meter", "settings.json"));
	assert.equal(footerSettingsPath(), join(home, "ops-footer", "settings.json"));
});
