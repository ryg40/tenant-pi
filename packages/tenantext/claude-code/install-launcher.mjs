#!/usr/bin/env node
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
	// No flag: tenant-claude. `--claude`: the ordinary claude launcher. `--account`: the claude-account command.
	const LAUNCHERS = { "": ["tenant-claude", "./bin/tenant-claude.mjs"], "--claude": ["claude", "./bin/claude.sh"], "--account": ["claude-account", "./bin/claude-account.mjs"] };
	const flag = process.argv.length === 3 && process.argv[2] ? process.argv[2] : process.argv.length === 2 ? "" : undefined;
	if (flag === undefined || !Object.hasOwn(LAUNCHERS, flag)) throw new Error("Usage: node packages/tenantext/claude-code/install-launcher.mjs [--claude | --account]");
	if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error("HOME must be absolute.");
	const [name, file] = LAUNCHERS[flag];
	const target = fileURLToPath(new URL(file, import.meta.url));
	const directory = join(process.env.HOME, ".local", "bin");
	const link = join(directory, name);
	let exists = false;
	try { lstatSync(link); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
	if (exists) {
		if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
			throw new Error(`${name} already exists at the install path; kept unchanged. Choose its location manually.`);
		}
	} else {
		mkdirSync(directory, { recursive: true });
		// Exclusive creation also preserves an entry that appears after the check.
		symlinkSync(target, link);
	}
	console.log(`${name} is linked in ~/.local/bin. Add that directory to PATH if needed. No mode was selected.`);
} catch (error) {
	console.error(error.code ? "Launcher install failed; existing entries were not replaced." : error.message);
	process.exitCode = 2;
}
