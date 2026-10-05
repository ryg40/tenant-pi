import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PRIMARY_CODEX_PROVIDER } from "./config.ts";

const foundCodexProvider = builtinProviders().find(({ id }) => id === PRIMARY_CODEX_PROVIDER);
const foundCodexOAuth = foundCodexProvider?.auth.oauth;

if (!foundCodexProvider || !foundCodexOAuth) {
	throw new Error("The installed pi-ai OpenAI Codex provider does not expose OAuth");
}

export const canonicalCodexProvider = foundCodexProvider;
export const canonicalCodexOAuth = foundCodexOAuth;
export type StoredOAuthCredential = OAuthCredentials & { type?: string; accountId?: string };

export function storedCodexCredential(provider: string): StoredOAuthCredential | undefined {
	const credential = readStoredCredential(provider) as StoredOAuthCredential | undefined;
	return credential?.type === "oauth" ? credential : undefined;
}

export function codexModelsForAccount(label: string) {
	const canonical = canonicalCodexProvider.getModels();
	const astra = canonical.find((model) => model.id === "gpt-6-astra");
	if (!astra) throw new Error("The installed Pi Codex catalog does not expose GPT-6 Astra");
	const added = ["luna", "sol"]
		.filter((variant) => !canonical.some((model) => model.id === `gpt-6-${variant}`))
		.map((variant) => ({ ...structuredClone(astra), id: `gpt-6-${variant}`, name: `GPT-6 ${variant.charAt(0).toUpperCase()}${variant.slice(1)}`,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
	return [...canonical, ...added].map((model) => {
		const { provider: _provider, ...config } = model;
		return { ...config, name: `${model.name} (${label})` };
	});
}
