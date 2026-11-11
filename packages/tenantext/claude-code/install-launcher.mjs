#!/usr/bin/env node
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
	if (process.argv.length !== 2) throw new Error("Usage: node packages/tenantext/claude-code/install-launcher.mjs");
	if (!process.env.HOME || !isAbsolute(process.env.HOME)) throw new Error("HOME must be absolute.");
	const target = fileURLToPath(new URL("./bin/tenant-claude.mjs", import.meta.url));
	const directory = join(process.env.HOME, ".local", "bin");
	const link = join(directory, "tenant-claude");
	let exists = false;
	try { lstatSync(link); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
	if (exists) {
		if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
			throw new Error("tenant-claude already exists at the install path; kept unchanged. Choose its location manually.");
		}
	} else {
		mkdirSync(directory, { recursive: true });
		// Exclusive creation also preserves an entry that appears after the check.
		symlinkSync(target, link);
	}
	console.log("tenant-claude is linked in ~/.local/bin. Add that directory to PATH if needed. No mode was selected.");
} catch (error) {
	console.error(error.code ? "Launcher install failed; existing entries were not replaced." : error.message);
	process.exitCode = 2;
}
