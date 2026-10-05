import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * GitHub Copilot credential discovery. Every source is local and read-only. Tokens never leave this module
 * except as the Authorization header of the usage request; reports name the source, never the value.
 */
export type CopilotSourceId = "pi" | "env" | "editor" | "copilot-cli" | "gh";
export const SOURCE_ORDER: readonly CopilotSourceId[] = ["pi", "env", "editor", "copilot-cli", "gh"];
export const SOURCE_LABELS: Record<CopilotSourceId, string> = {
	pi: "Pi github-copilot login",
	env: "environment variable",
	editor: "Copilot editor plugin config",
	"copilot-cli": "Copilot CLI config",
	gh: "GitHub CLI (gh auth token)",
};
export interface CopilotCredential { source: CopilotSourceId; token: string; domain: string; detail: string }
export interface DetectOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	platform?: NodeJS.Platform;
	/** Pi's stored credential for `github-copilot`. Injected so tests and the doctor CLI need no Pi runtime. */
	readPiCredential?: () => unknown;
	/** Pi's `settings.json`, for `defaultProvider` and `enabledModels`. */
	readPiSettings?: () => unknown;
	/** Runs `gh auth token`. Injected for tests. */
	ghToken?: (domain: string) => Promise<string | undefined>;
	sources?: readonly CopilotSourceId[];
	domain?: string;
}

const TOKEN = /^(?:gho|ghu|ghp|github_pat)_[A-Za-z0-9_]{20,255}$/;
export const isGitHubToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value.trim());

export function normalizeDomain(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return;
	try {
		const url = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`);
		return /^[a-z0-9.-]{1,253}$/i.test(url.hostname) ? url.hostname.toLowerCase() : undefined;
	} catch { return; }
}
/** `github.com` → `api.github.com`; a GHE Cloud domain `acme.ghe.com` → `api.acme.ghe.com`. */
export const apiHost = (domain: string): string => `api.${domain}`;

function readJson(path: string): unknown {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function piSource(options: DetectOptions): CopilotCredential[] {
	let credential: Record<string, unknown> | undefined;
	try { credential = record(options.readPiCredential?.()); } catch { return []; }
	// Pi keeps the GitHub OAuth token in `refresh`; `access` is the short-lived Copilot session token.
	if (!credential || credential.type !== "oauth" || !isGitHubToken(credential.refresh)) return [];
	const domain = normalizeDomain(credential.enterpriseUrl) ?? options.domain ?? "github.com";
	return [{ source: "pi", token: String(credential.refresh).trim(), domain, detail: "auth.json github-copilot" }];
}
function envSource(options: DetectOptions): CopilotCredential[] {
	const env = options.env ?? process.env;
	const domain = options.domain ?? normalizeDomain(env.GH_HOST) ?? "github.com";
	return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].filter(name => isGitHubToken(env[name]))
		.map(name => ({ source: "env" as const, token: env[name]!.trim(), domain, detail: name }));
}
/** copilot.vim, copilot.lua, JetBrains, and Xcode keep `oauth_token` in `github-copilot/apps.json` or `hosts.json`. */
function editorSource(options: DetectOptions): CopilotCredential[] {
	const env = options.env ?? process.env, home = options.home ?? homedir();
	const dirs = [env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "github-copilot") : "", join(home, ".config", "github-copilot"),
		(options.platform ?? process.platform) === "win32" && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "github-copilot") : ""].filter(Boolean);
	const out: CopilotCredential[] = [];
	for (const dir of [...new Set(dirs)]) for (const file of ["apps.json", "hosts.json"]) {
		const data = record(readJson(join(dir, file)));
		for (const [key, value] of Object.entries(data ?? {})) {
			const token = record(value)?.oauth_token;
			const domain = normalizeDomain(key.split(":")[0]);
			if (domain && isGitHubToken(token) && (!options.domain || options.domain === domain)) out.push({ source: "editor", token: token.trim(), domain, detail: file });
		}
	}
	return out;
}
/** The Copilot CLI stores tokens in the OS keychain by default and falls back to `~/.copilot/config.json`. Scan only token-named keys. */
function copilotCliSource(options: DetectOptions): CopilotCredential[] {
	const env = options.env ?? process.env;
	const dir = env.COPILOT_HOME || join(options.home ?? homedir(), ".copilot");
	const out: CopilotCredential[] = [];
	const walk = (value: unknown, key: string, depth: number) => {
		if (depth > 4) return;
		if (isGitHubToken(value) && /token/i.test(key)) {
			const domain = normalizeDomain(/https?:\/\/([^:/]+)/.exec(key)?.[1]) ?? options.domain ?? "github.com";
			out.push({ source: "copilot-cli", token: value.trim(), domain, detail: "config.json" });
		} else if (record(value)) for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${key}.${k}`, depth + 1);
	};
	walk(readJson(join(dir, "config.json")), "", 0);
	return out;
}
const GH_PATHS = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
export function runGhToken(domain: string): Promise<string | undefined> {
	const attempt = (index: number): Promise<string | undefined> => index >= GH_PATHS.length ? Promise.resolve(undefined) : new Promise(resolve => {
		execFile(GH_PATHS[index], ["auth", "token", "--hostname", domain], { timeout: 3000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") resolve(attempt(index + 1));
			else resolve(!error && isGitHubToken(stdout) ? stdout.trim() : undefined);
		});
	});
	return attempt(0);
}
async function ghSource(options: DetectOptions): Promise<CopilotCredential[]> {
	const domain = options.domain ?? "github.com";
	try {
		const token = await (options.ghToken ?? runGhToken)(domain);
		return token && isGitHubToken(token) ? [{ source: "gh", token: token.trim(), domain, detail: "gh auth token" }] : [];
	} catch { return []; }
}

/**
 * Whether Pi has a Copilot provider configured. Every GitHub account carries free-tier Copilot, so a GitHub token alone
 * (GH_TOKEN, GITHUB_TOKEN, `gh`) never turns the meter on. Signals: Pi's `github-copilot` login, Pi's own
 * `COPILOT_GITHUB_TOKEN` variable, or a `github-copilot` default provider or enabled model in Pi's settings.
 */
export function copilotProvider(options: DetectOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	try { if (record(options.readPiCredential?.())) return "Pi github-copilot login"; } catch { /* Unreadable credential store. */ }
	if (isGitHubToken(env.COPILOT_GITHUB_TOKEN)) return "COPILOT_GITHUB_TOKEN";
	let settings: Record<string, unknown> | undefined;
	try { settings = record(options.readPiSettings?.()); } catch { return; }
	if (settings?.defaultProvider === "github-copilot") return "Pi default provider";
	if (Array.isArray(settings?.enabledModels) && settings!.enabledModels.some(m => typeof m === "string" && m.startsWith("github-copilot/"))) return "Pi enabled models";
	return;
}

/** Every candidate credential in priority order, de-duplicated by token. The first that the usage endpoint accepts wins. */
export async function detectCopilotCredentials(options: DetectOptions = {}): Promise<CopilotCredential[]> {
	const sources = options.sources ?? SOURCE_ORDER;
	const found: CopilotCredential[] = [];
	for (const source of SOURCE_ORDER) {
		if (!sources.includes(source)) continue;
		if (source === "pi") found.push(...piSource(options));
		else if (source === "env") found.push(...envSource(options));
		else if (source === "editor") found.push(...editorSource(options));
		else if (source === "copilot-cli") found.push(...copilotCliSource(options));
		else found.push(...await ghSource(options));
	}
	const seen = new Set<string>();
	return found.filter(c => !seen.has(c.token) && Boolean(seen.add(c.token)));
}
