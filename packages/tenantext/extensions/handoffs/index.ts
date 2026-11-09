import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The startup assessment of handoff entries, and the commands /handoffs and /herdr-idle.
 * All logic about entries is in idle_cleanup.py of the herdr-idle-cleanup skill: this extension only runs the
 * script and passes its output on. It reads no Herdr variable, so it works in each Pi pane.
 */
export const CUSTOM_TYPE = "handoffs";
export const STARTUP_TIMEOUT_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30_000;
const SCRIPT = "idle_cleanup.py";
const KIT_SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/herdr-idle-cleanup/scripts");

export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface Dependencies {
	/** The idle_cleanup.py to run, or undefined. */
	findScript(): string | undefined;
	/** Run python3 with the arguments, with no shell. A failure to start gives code null. */
	run(args: string[], cwd: string, timeoutMs: number): Promise<RunResult>;
}

const realOrSelf = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/**
 * idle_cleanup.py: `HERDR_IDLE_CLEANUP_DIR` alone when it is set, else the installed skill, else the kit copy.
 * The installed skill drops out when it resolves into the kit copy.
 */
export function findScript(env: NodeJS.ProcessEnv = process.env, home = homedir(), kitScripts = KIT_SCRIPTS): string | undefined {
	const installed = join(home, ".agents/skills/herdr-idle-cleanup/scripts");
	const dirs = env.HERDR_IDLE_CLEANUP_DIR ? [join(env.HERDR_IDLE_CLEANUP_DIR, "scripts")]
		: realOrSelf(installed) === realOrSelf(kitScripts) ? [kitScripts] : [installed, kitScripts];
	return dirs.map(dir => join(dir, SCRIPT)).find(file => existsSync(file));
}

export function runPython(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
	return new Promise(done => {
		let stdout = "", stderr = "";
		let child;
		try {
			child = spawn("python3", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		} catch (error) {
			done({ code: null, stdout: "", stderr: String(error) });
			return;
		}
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.on("error", error => done({ code: null, stdout, stderr: stderr || String(error) }));
		child.on("close", code => done({ code, stdout, stderr }));
	});
}

const real: Dependencies = { findScript: () => findScript(), run: runPython };

/** The forms of /handoffs and the state of each set form. */
const SET_FORMS: Readonly<Record<string, string>> = { ack: "acknowledged", done: "done", dismiss: "dismissed", reopen: "open" };
export const USAGE = "Usage: /handoffs [list] | show <id> | ack <id> | done <id> | dismiss <id> | reopen <id>";

/** The arguments of the `entries` subcommand for one /handoffs form, or undefined for an unknown form. */
export function entriesArgs(input: string, cwd: string): string[] | undefined {
	const [form = "list", id, ...rest] = input.trim().split(/\s+/).filter(Boolean);
	if (rest.length) return undefined;
	if (form === "list" && !id) return ["entries", "list", "--cwd", cwd];
	if (!id) return undefined;
	if (form === "show") return ["entries", "show", id];
	const state = SET_FORMS[form];
	return state ? ["entries", "set", id, state] : undefined;
}

export const SWITCH_USAGE = "Usage: /herdr-idle [on|off|status]. No argument means status.";

/** The arguments of the `switch` subcommand for one /herdr-idle form, or undefined for an unknown form. */
export function switchArgs(input: string): string[] | undefined {
	const words = input.trim().split(/\s+/).filter(Boolean);
	const form = words[0] ?? "status";
	return words.length <= 1 && ["on", "off", "status"].includes(form) ? ["switch", form] : undefined;
}

export function createHandoffs(pi: ExtensionAPI, deps: Dependencies = real): void {
	let generation = 0;

	pi.on("session_start", (event, ctx: ExtensionContext) => {
		const turn = ++generation;
		// Only a new interactive session claims: no reload, new, resume or fork, and no print mode.
		if (event.reason !== "startup" || !ctx.hasUI) return;
		const script = deps.findScript();
		if (!script) return;
		// Not awaited: the start of the session does not wait for the script.
		void deps.run([script, "startup", "--cwd", ctx.cwd], ctx.cwd, STARTUP_TIMEOUT_MS).then(result => {
			const content = result.code === 0 ? result.stdout.trim() : "";
			if (turn !== generation || !content) return;
			try {
				pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			} catch { /* the runtime is gone */ }
		}, () => { /* no turn */ });
	});
	pi.on("session_shutdown", () => { generation++; });

	pi.registerCommand(CUSTOM_TYPE, {
		description: "List the handoff entries (this repository first), show one, or set ack, done, dismiss or reopen",
		handler: async (args, ctx) => {
			const argv = entriesArgs(args ?? "", ctx.cwd);
			if (!argv) { ctx.ui.notify(USAGE, "warning"); return; }
			const script = deps.findScript();
			if (!script) { ctx.ui.notify("The herdr-idle-cleanup skill is not installed: idle_cleanup.py was not found.", "warning"); return; }
			const result = await deps.run([script, ...argv], ctx.cwd, COMMAND_TIMEOUT_MS);
			const text = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() || `exit ${result.code}`;
			ctx.ui.notify(text, result.code === 0 ? "info" : "warning");
		},
	});

	// The switch of the startup check above, for Pi and Claude Code together. /handoffs works in both states.
	pi.registerCommand("herdr-idle", {
		description: "Turn the startup check of handoff entries on or off for Pi and Claude Code, or show its state",
		getArgumentCompletions: (prefix: string) => {
			const items = ["on", "off", "status"].filter(form => form.startsWith(prefix)).map(form => ({ value: form, label: form }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const argv = switchArgs(args ?? "");
			if (!argv) { ctx.ui.notify(SWITCH_USAGE, "warning"); return; }
			const script = deps.findScript();
			if (!script) { ctx.ui.notify("The herdr-idle-cleanup skill is not installed: idle_cleanup.py was not found.", "warning"); return; }
			const result = await deps.run([script, ...argv], ctx.cwd, COMMAND_TIMEOUT_MS);
			const text = (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim() || `exit ${result.code}`;
			ctx.ui.notify(text, result.code === 0 ? "info" : "warning");
		},
	});
}

export default function handoffs(pi: ExtensionAPI): void {
	createHandoffs(pi);
}
