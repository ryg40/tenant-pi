import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CODEX_ACCOUNTS, validateCodexAccounts, type CodexAccountsSettings } from "./settings.ts";

export {
	DEFAULT_CODEX_ACCOUNTS,
	PRIMARY_CODEX_PROVIDER,
	validateCodexAccounts,
	type CodexAccountConfig,
	type CodexAccountsSettings,
} from "./settings.ts";

export function codexAccountsSettingsPath(): string {
	return join(getAgentDir(), "codex-accounts", "settings.json");
}

export function loadCodexAccountsSettings(path = codexAccountsSettingsPath()): CodexAccountsSettings {
	if (!existsSync(path)) return { accounts: DEFAULT_CODEX_ACCOUNTS.map((account) => ({ ...account })) };
	return { ...validateCodexAccounts(JSON.parse(readFileSync(path, "utf8"))), explicit: true };
}
