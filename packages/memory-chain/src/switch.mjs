// The switch of the memory chain and its folders. This module imports nothing from
// `packages/openviking-pi`, so `off` works when a vendored helper is missing or renamed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function home(env = process.env) {
	return env.HOME || homedir();
}

export function configDir(env = process.env) {
	return join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "tenant-pi", "memory-chain");
}

/** The base folder of the record and the folders that the chain creates under it. */
export function stateBase(env = process.env) {
	return env.XDG_STATE_HOME || join(home(env), ".local", "state");
}

export const STATE_PARTS = Object.freeze(["tenant-pi", "memory-chain"]);

export function stateDir(env = process.env) {
	return join(stateBase(env), ...STATE_PARTS);
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** The switch. No file, a broken file or any other value means `off`. */
export function readMode(env = process.env) {
	const settings = readJson(join(configDir(env), "settings.json"));
	return settings?.mode === "shadow" ? "shadow" : "off";
}
