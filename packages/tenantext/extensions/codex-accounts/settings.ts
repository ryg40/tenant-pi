export interface CodexAccountConfig {
	provider: string;
	label: string;
	/** Read-only auth file of the client that owns this account's login, for example LiteLLM. Replaces the Pi login for limits. */
	tokenFile?: string;
}

export interface CodexAccountsSettings {
	accounts: CodexAccountConfig[];
	/** True when the accounts come from a settings file. An account that the user listed shows `no login` when it has no credential. */
	explicit?: boolean;
}

export const PRIMARY_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_ACCOUNTS: CodexAccountConfig[] = [
	{ provider: PRIMARY_CODEX_PROVIDER, label: "Codex 1" },
	{ provider: "openai-codex-2", label: "Codex 2" },
	{ provider: "openai-codex-3", label: "Codex 3" },
];

export function validateCodexAccounts(value: unknown): CodexAccountsSettings {
	if (!value || typeof value !== "object" || !Array.isArray((value as { accounts?: unknown }).accounts)) {
		throw new Error("codex-accounts settings must contain an accounts array");
	}

	const accounts = (value as { accounts: unknown[] }).accounts.map((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`codex-accounts account ${index + 1} must be an object`);
		}
		const { provider, label, tokenFile } = entry as { provider?: unknown; label?: unknown; tokenFile?: unknown };
		if (typeof provider !== "string" || !/^openai-codex(?:-[1-9][0-9]*)?$/.test(provider)) {
			throw new Error(`codex-accounts account ${index + 1} has an invalid provider id`);
		}
		if (typeof label !== "string" || label.trim().length === 0) {
			throw new Error(`codex-accounts account ${index + 1} requires a label`);
		}
		if (tokenFile !== undefined && (typeof tokenFile !== "string" || !tokenFile.startsWith("/"))) {
			throw new Error(`codex-accounts account ${index + 1} tokenFile must be an absolute path`);
		}
		return { provider, label: label.trim(), ...(tokenFile ? { tokenFile } : {}) };
	});

	if (!accounts.some(({ provider }) => provider === PRIMARY_CODEX_PROVIDER)) {
		throw new Error(`codex-accounts settings must include ${PRIMARY_CODEX_PROVIDER}`);
	}
	if (new Set(accounts.map(({ provider }) => provider)).size !== accounts.length) {
		throw new Error("codex-accounts provider ids must be unique");
	}
	return { accounts };
}
