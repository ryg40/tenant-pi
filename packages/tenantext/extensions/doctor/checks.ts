import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir } from "../../src/agent-dir.ts";
import { readAnthropicMeter } from "../anthropic-usage/reader.ts";
import { readCodexMeter } from "../codex-accounts/reader.ts";
import { readCopilotMeter } from "../copilot-usage/reader.ts";
import { computerUseChecks } from "./computer-use.ts";
import { wikiEmbeddingChecks } from "./wiki.ts";

/**
 * Environment checks for the tenantext suite. No Pi import: the same checks run inside Pi (`/tenantext-doctor`) and
 * from a shell (`npm run doctor`). Reports name files, providers, and sources; they never print a credential value.
 * Each meter gives one reader (`reader.ts` in its folder). The checks call these functions, so they work when a meter extension is disabled.
 */
export type CheckStatus = "ok" | "info" | "warn" | "fail";
export interface Fix { description: string; apply: () => void }
export interface Check { id: string; status: CheckStatus; message: string; fix?: Fix }
export interface DoctorOptions {
	dir?: string;
	/** Working directory for the project's wiki settings. Defaults to process.cwd(). */
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Pi's stored credential for a provider. Defaults to reading `auth.json`. */
	readCredential?: (provider: string) => unknown;
	/** The repository root, for package wiring checks. Omitted inside Pi, where the suite is already loaded. */
	repo?: string;
	fetcher?: typeof fetch;
	/** The home directory that holds `.claude`. Defaults to `HOME` of `env`, then the home of the user. */
	home?: string;
	/** Reads and parses the Claude Code credential file. Injected so tests read no real file. */
	readClaudeFile?: (path: string) => unknown;
	which?: (command: string) => Promise<boolean>;
}

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Write JSON atomically, private mode, after copying any previous file to `<file>.bak`. */
export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	renameSync(temporary, path);
}
const onPath = (command: string): Promise<boolean> => new Promise(resolve => {
	execFile(command, ["--version"], { timeout: 3000 }, error => resolve(!error || (error as NodeJS.ErrnoException).code !== "ENOENT"));
});

export async function runChecks(options: DoctorOptions = {}): Promise<Check[]> {
	const env = options.env ?? process.env;
	const dir = options.dir ?? agentDir(env);
	const which = options.which ?? onPath;
	const auth = record(readJson(join(dir, "auth.json"))) ?? {};
	const readCredential = options.readCredential ?? ((provider: string) => auth[provider]);
	const checks: Check[] = [];
	const add = (id: string, status: CheckStatus, message: string, fix?: Fix) => checks.push({ id, status, message, fix });

	add("agent-dir", existsSync(dir) ? "ok" : "fail", existsSync(dir) ? `Pi agent directory: ${dir}` : `Pi agent directory ${dir} does not exist. Start Pi once.`);

	// Package wiring (shell only): Pi must list the repository, and the peer packages must resolve for tests and typecheck.
	if (options.repo) {
		const repo = resolve(options.repo);
		const settingsPath = join(dir, "settings.json");
		const settings = record(readJson(settingsPath));
		const packages = Array.isArray(settings?.packages) ? settings!.packages as unknown[] : [];
		const source = (p: unknown) => typeof p === "string" ? p : typeof record(p)?.source === "string" ? String(record(p)!.source) : "";
		const localPath = (p: string) => !p || /^(?:npm:|git:|https?:)/.test(p) ? undefined : resolve(dir, p.replace(/^~(?=\/)/, env.HOME ?? ""));
		const suites = new Map<string, string>();
		for (const p of packages.map(source)) {
			const path = localPath(p);
			if (path && (path === repo || record(readJson(join(path, "package.json")))?.name === "tenantext")) suites.set(path, p);
		}
		const listed = suites.get(repo) ?? suites.values().next().value;
		if (listed) add("pi-package", "ok", `Pi loads the suite from ${listed}${localPath(listed) === repo ? "" : " (another checkout: pull there to install)"}.`);
		else add("pi-package", "warn", `Pi settings do not list ${repo} in packages.`, { description: `Add ${repo} to ${settingsPath} packages`,
			apply: () => writeJson(settingsPath, { ...(settings ?? {}), packages: [...packages, repo] }) });
		if (suites.size > 1) add("pi-package-duplicates", "warn", `Pi lists ${suites.size} different Tenantext checkouts. Keep one package source; remove the others from ${settingsPath}.`);
		const missing = ["pi-ai", "pi-coding-agent", "pi-tui"].filter(p => !existsSync(join(repo, "node_modules", "@earendil-works", p, "package.json")));
		if (!missing.length) add("peer-packages", "ok", "Pi peer packages resolve for tests and typecheck.");
		else add("peer-packages", "info", `Peer packages not linked: ${missing.join(", ")}. Needed only for npm test and typecheck.`, { description: "Link the peer packages from the global Pi install",
			apply: () => linkPeers(repo, missing) });
		const powerline = packages.some(p => /pi-powerline-footer/.test(source(p)));
		if (powerline) add("footer-conflict", "warn", "pi-powerline-footer is installed. Only one extension can own the footer; disable one of them.");
	}

	checks.push(...wikiEmbeddingChecks({ dir, cwd: options.cwd ?? process.cwd(), env, home: options.home }));
	checks.push(...await computerUseChecks({ dir, env }));

	add("git", await which("git") ? "ok" : "warn", await which("git") ? "git is on PATH." : "git is not on PATH. The footer repository row stays empty.");

	// Codex accounts: the footer shows accounts with a token file (for example LiteLLM's) or a stored Pi login.
	const { path: codexPath, accounts: configuredAccounts, tokenFiles } = readCodexMeter(dir);
	const configured = configuredAccounts.length ? configuredAccounts.map(a => a.provider) : ["openai-codex", "openai-codex-2", "openai-codex-3"];
	const codexProviders = [...new Set([...tokenFiles.filter(a => a.state !== "missing").map(a => a.provider), ...Object.keys(auth).filter(k => /^openai-codex(?:-[1-9][0-9]*)?$/.test(k) && !tokenFiles.some(a => a.provider === k))])]
		.sort((a, b) => (a === "openai-codex" ? 1 : Number(a.split("-").at(-1))) - (b === "openai-codex" ? 1 : Number(b.split("-").at(-1))));
	const files = (state: string) => tokenFiles.filter(a => a.state === state).map(a => `${a.provider} (${a.tokenFile})`).join(", ");
	if (files("missing")) add("codex-token-files", "warn", `Codex token files not found: ${files("missing")}. Those meters stay hidden.`);
	if (files("no login")) add("codex-no-login", "info", `Codex token files with no login: ${files("no login")}. The footer shows \`no login\` for those accounts.`);
	if (files("unreadable")) add("codex-token-files", "warn", `Codex token files unreadable or expired: ${files("unreadable")}. Those meters show an error until the login owner refreshes the file.`);
	if (!codexProviders.length) add("codex", "info", "No Codex login or token file found. The Codex meter stays hidden. Use /login openai-codex or set tokenFile in codex-accounts settings.");
	else {
		const extra = codexProviders.filter(p => !configured.includes(p));
		// With no settings file, write only the primary and the accounts that have a credential: a listed account with no login shows a `no login` row.
		const listed = configuredAccounts.length ? configured.filter((p): p is string => Boolean(p)) : [];
		const accounts = [...new Set(["openai-codex", ...listed, ...codexProviders])]
			.map(provider => configuredAccounts.find(a => a.provider === provider) ?? { provider, label: provider === "openai-codex" ? "Codex 1" : `Codex ${provider.split("-").at(-1)}` });
		if (extra.length) add("codex", "warn", `Codex logins not in ${codexPath}: ${extra.join(", ")}.`, { description: `Write ${codexPath} with ${accounts.map(a => a.provider).join(", ")}`, apply: () => writeJson(codexPath, { ...record(readJson(codexPath)), accounts }) });
		else add("codex", "ok", `Codex meter: ${codexProviders.map(p => tokenFiles.some(a => a.provider === p) ? `${p} (token file)` : p).join(", ")}.`);
	}
	add("codex-gateway", "info", env.TENANTEXT_LITELLM_BASE_URL ? "Codex automatic routing: TENANTEXT_LITELLM_BASE_URL is set." : "Codex automatic routing is off (optional; set TENANTEXT_LITELLM_BASE_URL to enable).");

	// Copilot: probe every local source read-only and report which one the meter will use.
	const copilot = await readCopilotMeter({ dir, env, readCredential: () => readCredential("github-copilot"), readPiSettings: () => readJson(join(dir, "settings.json")), fetcher: options.fetcher });
	if (copilot.settings.mode === "off") add("copilot", "info", `Copilot meter is off in ${copilot.path}.`);
	else if (!copilot.provider) add("copilot", "info", "No Copilot provider configured in Pi. The Copilot meter stays hidden. Use /login github-copilot to add one.");
	else if (copilot.source) {
		const source = copilot.source;
		const windows = copilot.windows.map(w => `${w.label} ${Math.round(w.remainingPercent)}%`).join(", ") || "all quotas unlimited";
		const pinned = [source.id, ...copilot.settings.sources.filter(s => s !== source.id)];
		const fix = !existsSync(copilot.path) ? { description: `Write ${copilot.path} with ${source.id} first`,
			apply: () => writeJson(copilot.path, { mode: "auto", sources: pinned, ...(source.domain !== "github.com" ? { domain: source.domain } : {}), pollSeconds: copilot.settings.pollSeconds }) } : undefined;
		add("copilot", "ok", `Copilot meter: ${source.label}${copilot.plan ? `, plan ${copilot.plan}` : ""}, ${windows}.`, fix);
	} else if (!copilot.tried.length) add("copilot", "warn", `Copilot provider configured (${copilot.provider}), but no credential was found. Use /login github-copilot.`);
	else add("copilot", "warn", `Copilot provider configured (${copilot.provider}), but the usage endpoint refused every local credential (${copilot.tried.join("; ")}). The footer shows an error chip.`);
	// Anthropic: probe every active local login read-only and report which one the meter uses. No refresh, no write.
	const anthropic = await readAnthropicMeter({ dir, env, home: options.home ?? env.HOME, readCredential: () => readCredential("anthropic"), readClaudeFile: options.readClaudeFile, fetcher: options.fetcher });
	if (anthropic.settings.mode === "off") add("anthropic", "info", "The Anthropic meter is off (settings file or TENANTEXT_ANTHROPIC_USAGE).");
	else if (anthropic.source) {
		const windows = anthropic.windows.map(w => `${w.label} ${Math.round(w.remainingPercent)}%`).join(", ");
		add("anthropic", "ok", `Anthropic meter: ${anthropic.source.label}${anthropic.plan ? `, plan ${anthropic.plan}` : ""}, ${windows}.`);
	} else if (!anthropic.tried.length) add("anthropic", "info", "No active Anthropic subscription login found. The Claude meter stays hidden. Log in with Claude Code or use /login anthropic.");
	else add("anthropic", "warn", `An Anthropic login is present, but the usage endpoint gave no reading (${anthropic.tried.join("; ")}). ${anthropic.settings.mode === "on" ? "The footer shows an error chip." : "The Claude meter stays hidden."}`);
	if (!await which("gh")) add("gh", "info", "GitHub CLI is not on PATH. It is one optional Copilot credential source.");

	// Footer extras: every one is optional and off until configured.
	const footerPath = join(dir, "ops-footer", "settings.json");
	const footer = record(readJson(footerPath));
	const urls = ["OK", "OV"].filter(k => env[`OPS_FOOTER_${k}_HEALTH_URL`] || record(footer?.healthUrls)?.[k]);
	add("ops-footer", "ok", `Footer ${footer?.enabled === false ? "disabled" : "enabled"}${existsSync(footerPath) ? ` (${footerPath})` : " with defaults"}; health checks: ${urls.length ? urls.join(", ") : "none (optional)"}.`);
	return checks;
}

function linkPeers(repo: string, missing: string[]): void {
	const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	const agent = join(root, "@earendil-works", "pi-coding-agent");
	if (!existsSync(join(agent, "package.json"))) throw new Error("Global Pi install not found. Install @earendil-works/pi-coding-agent first.");
	mkdirSync(join(repo, "node_modules", "@earendil-works"), { recursive: true });
	for (const name of missing) {
		const nested = join(agent, "node_modules", "@earendil-works", name);
		const target = name === "pi-coding-agent" ? agent : existsSync(nested) ? nested : join(root, "@earendil-works", name);
		const link = join(repo, "node_modules", "@earendil-works", name);
		rmSync(link, { force: true, recursive: true });
		symlinkSync(target, link, "dir");
	}
}

const MARK: Record<CheckStatus, string> = { ok: "✓", info: "·", warn: "⚠", fail: "✗" };
export function formatChecks(checks: Check[], applied: string[] = []): string {
	const lines = checks.map(c => `${MARK[c.status]} ${c.id}: ${c.message}${c.fix && !applied.includes(c.id) ? `\n    fix: ${c.fix.description}` : ""}`);
	if (applied.length) lines.push("", `Applied: ${applied.join(", ")}. Reload Pi (/reload) to pick up the changes.`);
	else if (checks.some(c => c.fix)) lines.push("", "Run with `fix` to apply the fixes above. Existing files are copied to <file>.bak first.");
	return lines.join("\n");
}
export function applyFixes(checks: Check[]): { applied: string[]; failed: string[] } {
	const applied: string[] = [], failed: string[] = [];
	for (const c of checks) if (c.fix) { try { c.fix.apply(); applied.push(c.id); } catch { failed.push(c.id); } }
	return { applied, failed };
}
