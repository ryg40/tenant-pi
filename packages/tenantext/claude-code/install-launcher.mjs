#!/usr/bin/env node
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
	// No flag: tenant-claude. `--claude`: the ordinary claude launcher. `--account`: the claude-account command.
	// `--slots`: claude1 and claude2, one launcher for each account slot.
	const LAUNCHERS = {
		"": [["tenant-claude", "./bin/tenant-claude.mjs"]],
		"--claude": [["claude", "./bin/claude.sh"]],
		"--account": [["claude-account", "./bin/claude-account.mjs"]],
		"--slots": [["claude1", "./bin/claude-slot.sh"], ["claude2", "./bin/claude-slot.sh"]],
	};
	const flag = process.argv.length === 3 && process.argv[2] ? process.argv[2] : process.argv.length === 2 ? "" : undefined;
	if (flag === undefined || !Object.hasOwn(LAUNCHERS, flag)) throw new Error("Usage: node packages/tenantext/claude-code/install-launcher.mjs [--claude | --account | --slots]");
	if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error("HOME must be absolute.");
	const directory = join(process.env.HOME, ".local", "bin");
	const links = LAUNCHERS[flag].map(([name, file]) => ({ name, target: fileURLToPath(new URL(file, import.meta.url)), link: join(directory, name) }));
	// Check every link first, so a conflict leaves no partial install.
	const missing = [];
	for (const { name, target, link } of links) {
		let exists = false;
		try { lstatSync(link); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
		if (!exists) missing.push({ target, link });
		else if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
			throw new Error(`${name} already exists at the install path; kept unchanged. Choose its location manually.`);
		}
	}
	if (missing.length) mkdirSync(directory, { recursive: true });
	// Exclusive creation also preserves an entry that appears after the check.
	for (const { target, link } of missing) symlinkSync(target, link);
	const names = links.map(({ name }) => name).join(" and ");
	console.log(`${names} ${links.length > 1 ? "are" : "is"} linked in ~/.local/bin. Add that directory to PATH if needed. No mode was selected.`);
} catch (error) {
	console.error(error.code ? "Launcher install failed; existing entries were not replaced." : error.message);
	process.exitCode = 2;
}
