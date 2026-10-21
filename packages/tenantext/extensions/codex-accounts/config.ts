import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../../src/agent-dir.ts";
import { DEFAULT_CODEX_ACCOUNTS, validateCodexAccounts, type CodexAccountsSettings } from "./settings.ts";

export function codexAccountsSettingsPath(dir = agentDir()): string {
	return join(dir, "codex-accounts", "settings.json");
}

export function loadCodexAccountsSettings(path = codexAccountsSettingsPath()): CodexAccountsSettings {
	if (!existsSync(path)) return { accounts: DEFAULT_CODEX_ACCOUNTS.map((account) => ({ ...account })) };
	return { ...validateCodexAccounts(JSON.parse(readFileSync(path, "utf8"))), explicit: true };
}
