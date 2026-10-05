import type { CodexAccountConfig } from "./settings.ts";
import { PRIMARY_CODEX_PROVIDER } from "./settings.ts";

export interface AccountCredentialIdentity {
	accountId?: string;
}

export function assertUniqueAccountIdentity(
	candidateAccountId: string | undefined,
	account: CodexAccountConfig,
	accounts: CodexAccountConfig[],
	readCredential: (provider: string) => AccountCredentialIdentity | undefined,
): void {
	if (!candidateAccountId) {
		throw new Error("OpenAI Codex returned credentials without a verifiable accountId; refusing to store them.");
	}
	if (account.provider !== PRIMARY_CODEX_PROVIDER && !readCredential(PRIMARY_CODEX_PROVIDER)?.accountId) {
		throw new Error("Authenticate openai-codex before authenticating an additional Codex account.");
	}
	for (const other of accounts) {
		if (other.provider === account.provider) continue;
		if (readCredential(other.provider)?.accountId === candidateAccountId) {
			throw new Error(
				`${account.label} resolved to the account already used by ${other.label}. ` +
				"Existing credentials were not changed. Retry in a private browser profile with the intended ChatGPT account.",
			);
		}
	}
}
