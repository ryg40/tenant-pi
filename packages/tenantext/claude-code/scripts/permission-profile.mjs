import { constants, accessSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { stateDir } from "./settings.mjs";

const MODES = {
	default: { label: "Default", native: "default" },
	auto: { label: "Auto", native: "auto" },
	yolo: { label: "YOLO", native: "bypassPermissions" },
};
export const YOLO_WARNING = "Warning: YOLO requests bypassPermissions, not Auto. Claude can act without routine permission checks. Use an isolated environment.";
const BOUNDARY = "Saved selection affects only future tenant-claude launches, not this conversation or ordinary claude/Herdr launches.\nFor the active conversation, use Claude's native Shift+Tab mode control and /config; check its mode indicator.";
const POLICY = "Claude's managed policy, mode availability, native confirmation and root refusal still apply. Auto may fall back to Manual.";
const DEFAULT_RULES = "Default retains existing allow and deny rules. Already allowed tools may run without another prompt.";
export const MODE_HELP = "Usage: tenant-claude mode [status|default|auto|yolo|reset|help]\nClaude: /claude-mode [status|default|auto|yolo|reset|help]\nNo argument shows status. reset saves Default.\n" + BOUNDARY;

export function profilePath() {
	const directory = stateDir();
	if (!isAbsolute(directory)) throw new Error("The Claude profile directory must be absolute.");
	return join(directory, "permission-profile.json");
}

function stateInfo(path) {
	try {
		const info = lstatSync(path);
		if (!info.isFile()) throw new Error("Not a regular state file");
		return info;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw new Error("Cannot use permission profile: expected a readable regular file, not a link.");
	}
}

export function loadMode() {
	const path = profilePath();
	const info = stateInfo(path);
	if (!info) return "default";
	try {
		if (info.size > 1024) throw new Error("Oversized state");
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (!state || state.version !== 1 || typeof state.mode !== "string" || !Object.hasOwn(MODES, state.mode)
			|| Object.keys(state).sort().join(",") !== "mode,version") throw new Error("Invalid state");
		return state.mode;
	} catch {
		throw new Error("Invalid or unreadable permission profile; no launch. Use tenant-claude mode reset to save Default.");
	}
}

function saveMode(mode) {
	const path = profilePath();
	stateInfo(path);
	let temporary;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		throw new Error("Cannot save permission profile; no launch.");
	} finally {
		if (temporary) {
			try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot remove temporary permission profile."); }
		}
	}
}

export function modeAction(args) {
	if (args.length > 1) throw new Error(MODE_HELP);
	const action = args[0] ?? "status";
	if (action === "help") return MODE_HELP;
	if (action === "status") {
		const mode = loadMode();
		return `${mode === "yolo" ? `${YOLO_WARNING}\n` : ""}Saved launch selection: ${MODES[mode].label}.\n${mode === "default" ? `${DEFAULT_RULES}\n` : ""}${BOUNDARY}\n${POLICY}`;
	}
	const mode = action === "reset" ? "default" : action;
	if (!Object.hasOwn(MODES, mode)) throw new Error(MODE_HELP);
	// Only an explicit safe selection repairs malformed state.
	if (mode !== "default") loadMode();
	if (mode === "yolo") console.error(YOLO_WARNING);
	saveMode(mode);
	return `Saved launch selection: ${MODES[mode].label}.\n${mode === "default" ? `${DEFAULT_RULES}\n` : ""}${BOUNDARY}\n${POLICY}`;
}

// Refuse all CLI settings inputs instead of opening files that can contain secrets
// or racing a settings-file edit between validation and Claude's own read.
const RESERVED = new Set([
	"--permission-mode", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--enable-auto-mode",
	"--permission-prompts", "--permission-prompt-tool", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
	"--settings", "--setting-sources",
	// Resuming can attach to a running session whose mode this launcher cannot set.
	"--resume", "-r", "--continue", "-c", "--from-pr", "--fork-session", "--session-id",
	"--desktop", "--cloud", "--teleport", "--remote", "--remote-control",
]);

// Native commands from Claude Code 2.1.322 help. Review this list on upgrades;
// exact tokens are refused even as values, without parsing upstream options.
const RESERVED_COMMANDS = new Set([
	"agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
	"plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
]);

export function launchArgs(args) {
	for (const arg of args) {
		// Scan even after --: a preceding value-taking Claude option can consume
		// that token as its value instead of ending option parsing.
		if (RESERVED_COMMANDS.has(arg)) {
			throw new Error("Native Claude subcommand refused. Use ordinary claude for session management, administration, or exact command words as values.");
		}
		if (/^-[^-].+/.test(arg)) throw new Error("Use separate short flags or full long flags, not combined or attached short forms.");
		if (RESERVED.has(arg.split("=", 1)[0])) {
			throw new Error("Permission override, settings input or session-routing option refused. Use ordinary claude for custom overrides or existing sessions.");
		}
	}
	const mode = loadMode();
	if (mode === "yolo") console.error(YOLO_WARNING);
	console.error(`Requested launch mode: ${MODES[mode].label}. ${mode === "default" ? `${DEFAULT_RULES} ` : ""}${POLICY}`);
	return ["--permission-mode", MODES[mode].native, ...args];
}

export function claudeExecutable() {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const path = resolve(directory, "claude");
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile()) return path;
		} catch { /* Try the next PATH entry, as an ordinary shell launch does. */ }
	}
	throw new Error("No claude executable on PATH. Install Claude Code separately.");
}
