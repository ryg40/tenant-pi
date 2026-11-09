// The idle_cleanup.py of the herdr-idle-cleanup skill, for the SessionStart hook and for /herdr-idle.
// HERDR_IDLE_CLEANUP_DIR alone when it is set, else the installed skill, else the copy of the installed plugin
// (build-skills.py puts the skills in skills/ of the plugin), else the kit copy. A path that resolves into an
// earlier one drops out.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function handoffScript() {
	const real = path => { try { return realpathSync(path); } catch { return path; } };
	const here = dirname(fileURLToPath(import.meta.url));
	const plugin = resolve(here, "../skills/herdr-idle-cleanup/scripts");
	const kit = resolve(here, "../../skills/herdr-idle-cleanup/scripts");
	const installed = join(homedir(), ".agents/skills/herdr-idle-cleanup/scripts");
	const dirs = process.env.HERDR_IDLE_CLEANUP_DIR ? [join(process.env.HERDR_IDLE_CLEANUP_DIR, "scripts")]
		: [...new Map([installed, plugin, kit].map(dir => [real(dir), dir])).values()];
	return dirs.map(dir => join(dir, "idle_cleanup.py")).find(file => existsSync(file));
}
