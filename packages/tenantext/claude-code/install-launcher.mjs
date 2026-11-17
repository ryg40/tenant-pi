#!/usr/bin/env node
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
	const ordinary = process.argv.length === 3 && process.argv[2] === "--claude";
	if (process.argv.length !== 2 && !ordinary) throw new Error("Usage: node packages/tenantext/claude-code/install-launcher.mjs [--claude]");
	if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error("HOME must be absolute.");
	const name = ordinary ? "claude" : "tenant-claude";
	const target = fileURLToPath(new URL(ordinary ? "./bin/claude.sh" : "./bin/tenant-claude.mjs", import.meta.url));
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
