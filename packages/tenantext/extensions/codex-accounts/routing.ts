import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Credential, type SimpleStreamOptions, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { canonicalCodexProvider } from "./openai-codex.ts";
import { ACCOUNT_NAME } from "./settings.ts";
import type { CodexStatusSnapshot } from "./status.ts";

export { ACCOUNT_NAME };

export const GATEWAY_PROVIDER = "litellm-codex";
// The gateway maps the short name sol to the newest Sol, gpt-6.1-sol. The pinned names do not move.
export const ALIASES = { luna: "gpt-6-luna", sol: "gpt-6.1-sol", astra: "gpt-6-astra", terra: "gpt-6.1-terra" } as const;
// USD per million tokens from the Pi GPT-6 catalog; current API prices are not verified.
// These are API-equivalent estimates, not charges to a Codex subscription.
export const FALLBACK_API_PRICES: Record<keyof typeof ALIASES, Model<"openai-completions">["cost"]> = {
	luna: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	sol: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	astra: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	// https://developers.openai.com/api/docs/models/gpt-6.1-terra (2026-10-26).
	terra: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
		tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }] },
} as const;
const TERRA_METADATA = {
	reasoning: true, input: ["text", "image"] as ("text" | "image")[],
	// The API advertises 1.05M; keep the Codex limit conservative until its catalog confirms it.
	contextWindow: 272000, maxTokens: 128000,
	thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	cost: FALLBACK_API_PRICES.terra,
};
export const CONTINUATION_ERROR = "Codex gateway rejected an account-scoped continuation (HTTP 409; client error). Send full history or use an explicit account route.";
export const GATEWAY_ERROR = "Codex gateway request failed. Check configuration, account limits, and gateway availability.";

// Pi classifies retries from errorMessage. Keep status, never upstream bodies.
export function gatewayHttpError(status: number | undefined, detail?: string): string {
	if (status === 409) return CONTINUATION_ERROR;
	if (status === 400 || status === 422) return `Codex gateway rejected the request (HTTP ${status}; client error). Check model parameters.`;
	if (status === 401 || status === 403) return `Codex gateway denied access (HTTP ${status}; authentication). Check gateway and account authentication.`;
	if (status === 404) return "Codex gateway route not found (HTTP 404; client error). Check the endpoint and model.";
	if (status === 429) return "Codex gateway reports a rate or account limit (HTTP 429; rate limit). Wait for the limit to reset.";
	if (status === 408 || status === 504) return `Codex gateway request timed out before streaming (HTTP ${status}; ${status === 408 ? "client" : "upstream"} error).`;
	if (status === 500 || status === 502 || status === 503) return `Codex gateway or upstream service is unavailable before streaming (HTTP ${status}; upstream error).`;
	if (status !== undefined && Number.isInteger(status)) {
		if (status >= 400 && status < 500) return `Codex gateway rejected the request (HTTP ${status}; client error).`;
		if (status >= 500 && status < 600) return `Codex gateway request failed (HTTP ${status}; upstream error).`;
	}
	// Match only known markers. Do not copy details or make partial streams retryable.
	if (detail && /\bMidStreamFallbackError\b|\bResponse payload is not completed\b/i.test(detail)) {
		return "Codex gateway response failed (interrupted stream). The response is incomplete.";
	}
	return GATEWAY_ERROR;
}

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env, stored?: Credential) {
	const raw = env.TENANTEXT_LITELLM_BASE_URL;
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
		if (!/^https?:\/\//.test(raw) || /[\s\\]/.test(raw) || /^https?:\/\/[^/]*@/.test(raw)
			|| url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) return undefined;
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
		const credential = env.TENANTEXT_LITELLM_API_KEY ? undefined : stored ?? readStoredCredential(GATEWAY_PROVIDER);
		const key = env.TENANTEXT_LITELLM_API_KEY || (credential?.type === "api_key" ? credential.key : undefined);
		if (!key || /[\x00-\x20\x7f]/.test(key)) return undefined;
		return { baseUrl: url.toString().replace(/\/$/, ""), apiKey: env.TENANTEXT_LITELLM_API_KEY ? "$TENANTEXT_LITELLM_API_KEY" : undefined };
	} catch { return undefined; }
}

export function gatewayModels() {
	const catalog = canonicalCodexProvider.getModels();
	return Object.entries(ALIASES).map(([alias, id]) => {
		const exact = catalog.find((model) => model.id === id);
		const source = exact ?? catalog.find((model) => model.id === "gpt-6-astra");
		if (!source) throw new Error("Codex gateway catalog is unavailable. Update Pi.");
		const { provider: _provider, api: _api, baseUrl: _url, headers: _headers, compat: _compat, ...metadata } = source;
		if (!exact && alias === "terra") Object.assign(metadata, TERRA_METADATA);
		const label = alias.charAt(0).toUpperCase() + alias.slice(1);
		return { ...structuredClone(metadata), id: `codex-auto/${alias}`, name: alias === "terra" ? "GPT-6.1 Terra (automatic)" : `GPT-6 ${label} (automatic)`,
			cost: exact ? structuredClone(exact.cost) : structuredClone(FALLBACK_API_PRICES[alias as keyof typeof ALIASES]),
			api: "openai-completions" as const,
			compat: { supportsStore: false, supportsReasoningEffort: true, thinkingFormat: "openai" as const, supportsOpenAIGrammarTools: false } };
	});
}

function safeSampling(params: Record<string, unknown> | undefined) {
	const copy = { ...params };
	for (const key of ["messages", "model", "stream", "previous_response_id", "conversation"]) delete copy[key];
	return copy;
}

// This wrapper runs after Pi's request hooks. Restore the complete serialized history,
// without retaining prompt content beyond this request or changing tool arguments.
export const gatewayStream: typeof streamSimple = (model, context, options) => {
	const output = createAssistantMessageEventStream();
	let status: number | undefined;
	const safeOptions: SimpleStreamOptions = { ...options, samplingParams: safeSampling(options?.samplingParams),
		onPayload: async (payload, currentModel) => {
			const original = structuredClone(payload) as Record<string, unknown>;
			const changed = await options?.onPayload?.(payload, currentModel);
			const next = { ...(changed === undefined ? payload : changed) as Record<string, unknown> };
			if (!Array.isArray(original.messages) || !original.messages.length) throw new Error(GATEWAY_ERROR);
			next.messages = original.messages;
			next.model = model.id;
			next.stream = true;
			delete next.previous_response_id;
			delete next.conversation;
			// ChatGPT Codex routes a request to a prompt-cache server by its `session_id` header.
			// The Codex account proxies set that header from `litellm_session_id`, which only
			// survives the gateway hop inside `extra_body`. Without it every request gets a random
			// session id and the cache hit rate falls to about half of the direct providers.
			if (options?.sessionId) next.extra_body = { ...(next.extra_body as Record<string, unknown> | undefined), litellm_session_id: options.sessionId };
			return next;
		},
		fetch: async (input, init) => {
			status = undefined;
			const response = await (options?.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
			status = response.status;
			if (!response.ok) {
				await response.body?.cancel();
				await options?.onResponse?.({ status, headers: { "x-codex-account": response.headers.get("x-codex-account") ?? "" } }, model);
				return new Response(JSON.stringify({ error: { message: gatewayHttpError(status) } }), {
					status, headers: { "content-type": "application/json" },
				});
			}
			return response;
		},
	};
	void (async () => {
		try {
			for await (const event of streamSimple({ ...model, samplingParams: safeSampling(model.samplingParams) }, context, safeOptions)) {
				if (event.type === "error") event.error.errorMessage = gatewayHttpError(status, event.error.errorMessage);
				output.push(event);
			}
		} catch (cause) {
			const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : typeof cause === "string" ? cause : undefined;
			const error: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				stopReason: options?.signal?.aborted ? "aborted" : "error", timestamp: Date.now(), errorMessage: gatewayHttpError(status, detail),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			output.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
		} finally { output.end(); }
	})();
	return output;
};

export function registerGateway(pi: ExtensionAPI, publish: (routing: NonNullable<CodexStatusSnapshot["routing"]>) => void, preferredAccount?: string) {
	const config = gatewayConfig();
	let enabled = false;
	if (config) {
		try {
			pi.registerProvider(GATEWAY_PROVIDER, { ...config, api: "openai-completions", models: gatewayModels(),
				streamSimple: (model, context, options) => gatewayStream(model as Model<"openai-completions">, context, options) });
			enabled = true;
		} catch { /* A missing catalog disables only the gateway. */ }
	}
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== GATEWAY_PROVIDER) return;
		const selected = event.headers["x-codex-account"];
		publish({ state: event.status >= 400 ? "error" : "unknown", preferredAccount,
			selectedAccount: typeof selected === "string" && ACCOUNT_NAME.test(selected) ? selected : undefined,
			summary: event.status >= 400 ? gatewayHttpError(event.status) : "Gateway status endpoint unavailable; account comes from the last response." });
	});
	return enabled;
}
