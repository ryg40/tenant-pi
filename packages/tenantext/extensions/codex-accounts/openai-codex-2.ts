import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type { CodexAccountConfig } from "./config.ts";
import { PRIMARY_CODEX_PROVIDER } from "./config.ts";
import { assertUniqueAccountIdentity } from "./identity.ts";
import {
	canonicalCodexOAuth,
	canonicalCodexProvider,
	codexModelsForAccount,
	storedCodexCredential,
} from "./openai-codex.ts";

export function assertUniqueCodexAccount(
	credential: OAuthCredentials,
	account: CodexAccountConfig,
	accounts: CodexAccountConfig[],
	readCredential: typeof storedCodexCredential = storedCodexCredential,
): void {
	const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
	assertUniqueAccountIdentity(accountId, account, accounts, readCredential);
}

function withPromptAbort(prompt: Promise<string>, signal?: AbortSignal): Promise<string> {
	if (!signal) return prompt;
	if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("Login cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		prompt.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function registerSecondaryProvider(pi: ExtensionAPI, account: CodexAccountConfig, accounts: CodexAccountConfig[]): void {
	async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		callbacks.onProgress?.(`Signing in only ${account.provider}; existing Codex credentials will not be replaced.`);
		const credential = await canonicalCodexOAuth.login({
			signal: callbacks.signal ?? new AbortController().signal,
			notify(event) {
				if (event.type === "auth_url") {
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
				} else if (event.type === "device_code") {
					callbacks.onDeviceCode({
						userCode: event.userCode,
						verificationUri: event.verificationUri,
						intervalSeconds: event.intervalSeconds,
						expiresInSeconds: event.expiresInSeconds,
					});
				} else {
					callbacks.onProgress?.(event.message);
				}
			},
			async prompt(prompt) {
				if (prompt.type === "select") {
					const selected = await callbacks.onSelect({
						message: prompt.message,
						options: prompt.options.map(({ id, label }) => ({ id, label })),
					});
					if (!selected) throw new Error("Login cancelled");
					return selected;
				}
				const response =
					prompt.type === "manual_code" && callbacks.onManualCodeInput
						? callbacks.onManualCodeInput()
						: callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
				return withPromptAbort(response, prompt.signal);
			},
		});
		assertUniqueCodexAccount(credential, account, accounts);
		return credential;
	}

	async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
		assertUniqueCodexAccount(credentials, account, accounts);
		const refreshed = await canonicalCodexOAuth.refresh({ ...credentials, type: "oauth" }, signal);
		assertUniqueCodexAccount(refreshed, account, accounts);
		return refreshed;
	}

	pi.registerProvider(account.provider, {
		name: `${account.label} (ChatGPT Codex subscription)`,
		baseUrl: canonicalCodexProvider.baseUrl,
		api: "openai-codex-responses",
		models: codexModelsForAccount(account.label),
		oauth: {
			name: `${account.label} (ChatGPT Codex subscription)`,
			login,
			refreshToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

export function registerCodexAccountProviders(pi: ExtensionAPI, accounts: CodexAccountConfig[]): void {
	for (const account of accounts) {
		if (account.provider !== PRIMARY_CODEX_PROVIDER) registerSecondaryProvider(pi, account, accounts);
	}
}
