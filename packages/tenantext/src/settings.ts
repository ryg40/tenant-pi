import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TenantextSettings {
	/** Append the language rules to the system prompt. */
	rules: boolean;
	/** Block extension-started runs until the first human prompt of a session. */
	guard: boolean;
	/** Allow calls to decision servers that answer choice questions. Off: every tenantext decision caller stays silent. */
	decisions: boolean;
}

export const DEFAULT_SETTINGS: TenantextSettings = { rules: true, guard: true, decisions: true };

/** Pi event bus name for a decisions toggle. The value is `{ enabled: boolean }`. Callers apply it without a restart. */
export const DECISIONS_EVENT = "tenantext:decisions";

export function stateDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "tenantext");
}

export function settingsPath(): string {
	return join(stateDir(), "settings.json");
}

/** Parse a settings document. Unknown keys are ignored, missing keys take defaults. */
export function parseSettings(raw: unknown): TenantextSettings {
	const out: TenantextSettings = { ...DEFAULT_SETTINGS };
	if (raw && typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		if (typeof obj.rules === "boolean") out.rules = obj.rules;
		if (typeof obj.guard === "boolean") out.guard = obj.guard;
		if (typeof obj.decisions === "boolean") out.decisions = obj.decisions;
	}
	return out;
}

export function loadSettings(path = settingsPath()): TenantextSettings {
	try {
		if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
		return parseSettings(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: TenantextSettings, path = settingsPath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** Create discoverable defaults, but never replace an existing nonempty user file. */
export function ensureSettings(path = settingsPath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!existsSync(path) || !readFileSync(path, "utf8").trim()) saveSettings(DEFAULT_SETTINGS, path);
	const guide = join(dirname(path), "settings.example.jsonc");
	if (!existsSync(guide)) writeFileSync(guide, `// Tenantext options. Copy values into settings.json (plain JSON, without comments).\n{\n  // rules: true | false — add simplified English rules to the system prompt.\n  "rules": true,\n  // guard: true | false — block extension prompts before the first human prompt.\n  "guard": true,\n  // decisions: true | false — allow calls to decision models (the next-move chip). /tenantext-decisions on|off changes this.\n  "decisions": true\n}\n`, { flag: "wx", mode: 0o600 });
}
