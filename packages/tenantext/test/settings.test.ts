import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, ensureSettings, loadSettings, parseSettings, saveSettings } from "../src/settings.ts";

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
