import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_SETTINGS = { rules: true };

export function stateDir() {
	return process.env.TENANTEXT_CLAUDE_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "tenantext");
}

export function settingsPath() {
	return join(stateDir(), "settings.json");
}

export function lastInjectionPath() {
	return join(stateDir(), "last-injection.json");
}

export function parseSettings(raw) {
	const out = { ...DEFAULT_SETTINGS };
	if (raw && typeof raw === "object" && typeof raw.rules === "boolean") out.rules = raw.rules;
	return out;
}

export function loadSettings(path = settingsPath()) {
	try {
		if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
		return parseSettings(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings, path = settingsPath()) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function writeJson(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
