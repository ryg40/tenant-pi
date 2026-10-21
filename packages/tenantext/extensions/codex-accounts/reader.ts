import { existsSync, readFileSync } from "node:fs";
import { codexAccountsSettingsPath } from "./config.ts";
import { readTokenFile, tokenFileNoLogin } from "./token-file.ts";

export type TokenFileState = "ok" | "missing" | "no login" | "unreadable";
/** One reading of the Codex meter for the doctor. The doctor imports only this module of the meter. */
export interface CodexReading {
	path: string;
	/** The accounts of the settings file as written, not validated. Empty when the file is absent or has no list. */
	accounts: { provider?: string; label?: string; tokenFile?: string }[];
	/** Each account with a provider and a token file, and the state of that file. */
	tokenFiles: { provider: string; tokenFile: string; state: TokenFileState }[];
}

/** Read the settings file and each token file read-only. No Pi import, no network. */
export function readCodexMeter(dir: string): CodexReading {
	const path = codexAccountsSettingsPath(dir);
	let accounts: unknown;
	try { accounts = (JSON.parse(readFileSync(path, "utf8")) as { accounts?: unknown } | null)?.accounts; } catch { accounts = undefined; }
	const list = Array.isArray(accounts) ? accounts as CodexReading["accounts"] : [];
	const state = (file: string): TokenFileState => !existsSync(file) ? "missing" : tokenFileNoLogin(file) ? "no login" : readTokenFile(file) ? "ok" : "unreadable";
	const tokenFiles = list.filter(a => a.provider && a.tokenFile).map(a => ({ provider: a.provider!, tokenFile: a.tokenFile!, state: state(a.tokenFile!) }));
	return { path, accounts: list, tokenFiles };
}
