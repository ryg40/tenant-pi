import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, normalizeContext, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai/compat";
import { ALIASES, CONTINUATION_ERROR, FALLBACK_API_PRICES, GATEWAY_ERROR, GATEWAY_PROVIDER, gatewayConfig, gatewayHttpError, gatewayModels, gatewayStream, registerGateway } from "../extensions/codex-accounts/routing.ts";
import { canonicalCodexProvider } from "../extensions/codex-accounts/openai-codex.ts";
import { CODEX_REFRESH_EVENT, CODEX_REFRESH_MIN_MS, CODEX_STALE_AFTER_MS, CODEX_STATUS_EVENT, createCodexStatus, NO_LOGIN_ERROR, type AccountLimits, type CodexStatusSnapshot } from "../extensions/codex-accounts/status.ts";
import codexAccounts from "../extensions/codex-accounts/index.ts";
import { parseCodexLimits, parseCodexUsage } from "../extensions/codex-accounts/parse-limits.ts";

const accounts = [{ provider: "openai-codex", label: "Codex 1" }, { provider: "openai-codex-2", label: "Codex 2" }];
const emptyCredential = { type: "api_key" as const, key: "" };
function harness() {
	const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
	const bus = new EventEmitter();
	const providers = new Map<string, ProviderConfig>();
	const commands = new Map<string, any>();
	const entries: unknown[] = [];
	const api = {
		on(name: string, handler: any) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
		events: { on(name: string, handler: any) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name: string, data: unknown) => { bus.emit(name, data); } },
		registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config),
		registerCommand: (name: string, config: unknown) => commands.set(name, config),
		registerEntryRenderer() {}, appendEntry: (_name: string, data: unknown) => entries.push(data),
	} as unknown as ExtensionAPI;
	const ctx = { model: { provider: GATEWAY_PROVIDER }, modelRegistry: { getApiKeyForProvider() { throw new Error("Must not refresh OAuth"); } } } as unknown as ExtensionContext;
	return { api, ctx, bus, providers, commands, entries,
		async fire(name: string, event: unknown = {}, context = ctx) { for (const callback of hooks.get(name) ?? []) await callback(event, context); } };
}
function environment(t: any, configured: boolean) {
	const original = { url: process.env.TENANTEXT_LITELLM_BASE_URL, key: process.env.TENANTEXT_LITELLM_API_KEY };
	t.after(() => {
		for (const [name, value] of [["TENANTEXT_LITELLM_BASE_URL", original.url], ["TENANTEXT_LITELLM_API_KEY", original.key]]) {
			if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
		}
	});
	if (configured) { process.env.TENANTEXT_LITELLM_BASE_URL = "https://gateway.invalid/v1"; process.env.TENANTEXT_LITELLM_API_KEY = "fixture-only"; }
	else { delete process.env.TENANTEXT_LITELLM_BASE_URL; delete process.env.TENANTEXT_LITELLM_API_KEY; }
}

test("configuration fails closed without revealing supplied values", () => {
	assert.equal(gatewayConfig({}, emptyCredential), undefined);
	assert.equal(gatewayConfig({ TENANTEXT_LITELLM_BASE_URL: "https://gateway.invalid/v1" }, emptyCredential), undefined);
	for (const url of ["not a URL", "https:host", "https://@host/v1", "ftp://host/v1", "http://remote.invalid/v1", "https://user:secret@host/v1", "https://host/v1?key=secret", "https://host/#secret", "https://host/?", " https://host/v1", "https://host\\evil/v1"]) {
		assert.equal(gatewayConfig({ TENANTEXT_LITELLM_BASE_URL: url, TENANTEXT_LITELLM_API_KEY: "fixture-only" }, emptyCredential), undefined);
	}
	for (const url of ["https://gateway.invalid/v1", "http://127.0.0.1:4321/v1", "http://localhost:4321/v1", "http://[::1]:4321/v1"]) {
		const config = gatewayConfig({ TENANTEXT_LITELLM_BASE_URL: url, TENANTEXT_LITELLM_API_KEY: "fixture-only" }, emptyCredential);
		assert.ok(config);
		assert.equal(config.apiKey, "$TENANTEXT_LITELLM_API_KEY");
		assert.ok(!JSON.stringify(config).includes("fixture-only"));
	}
	assert.ok(gatewayConfig({ TENANTEXT_LITELLM_BASE_URL: "https://gateway.invalid/v1" }, { type: "api_key", key: "fixture-only" }));
	for (const key of ["", " ", "fixture\nvalue", "fixture\tvalue"]) {
		assert.equal(gatewayConfig({ TENANTEXT_LITELLM_BASE_URL: "https://gateway.invalid/v1", TENANTEXT_LITELLM_API_KEY: key }, emptyCredential), undefined);
	}
});

test("three supported aliases copy GPT-6 metadata without direct OAuth endpoints", () => {
	const models = gatewayModels();
	assert.deepEqual(models.map((model) => model.id), Object.keys(ALIASES).map((alias) => `codex-auto/${alias}`));
	for (const [index, id] of Object.values(ALIASES).entries()) {
		const exact = canonicalCodexProvider.getModels().find((model) => model.id === id);
		const source = exact ?? canonicalCodexProvider.getModels().find((model) => model.id === "gpt-6-astra")!;
		for (const field of ["contextWindow", "maxTokens", "reasoning", "thinkingLevelMap", "input", "inputLimits"] as const) assert.deepEqual(models[index][field], source[field]);
		assert.deepEqual(models[index].cost, exact ? exact.cost : FALLBACK_API_PRICES[id.replace("gpt-6-", "") as keyof typeof FALLBACK_API_PRICES]);
		assert.ok(models[index].cost.input > 0 && models[index].cost.output > 0);
		assert.match(models[index].name, /^GPT-6 /);
		assert.equal(models[index].api, "openai-completions");
		assert.ok(!("baseUrl" in models[index]));
		assert.ok(!("headers" in models[index]));
	}
});

test("uncataloged aliases use published API-equivalent estimates instead of zero", (t) => {
	const astra = canonicalCodexProvider.getModels().find((entry) => entry.id === "gpt-6-astra")!;
	t.mock.method(canonicalCodexProvider, "getModels", () => [astra]);
	for (const [index, alias] of ["luna", "sol", "astra"].entries()) {
		const expected = alias === "astra" ? astra.cost : FALLBACK_API_PRICES[alias as "luna" | "sol"];
		assert.deepEqual(gatewayModels()[index].cost, expected);
	}
});

test("extension keeps direct providers and commands when gateway is missing", async (t) => {
	environment(t, false);
	const h = harness();
	codexAccounts(h.api);
	assert.ok(h.providers.has("openai-codex-2"));
	assert.ok(!h.providers.has("openai-codex")); // Never replace the built-in owner.
	assert.ok(!h.providers.has(GATEWAY_PROVIDER));
	await h.fire("session_start");
	await h.commands.get("codex-accounts").handler("routing", h.ctx);
	assert.match(JSON.stringify(h.entries), /Gateway disabled/);
	await h.fire("session_shutdown");
});

test("the preferred account is a setting with no default", async (t) => {
	environment(t, true);
	const dir = mkdtempSync(join(tmpdir(), "codex-preferred-"));
	const original = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => { if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original; rmSync(dir, { recursive: true, force: true }); });
	const report = async () => {
		const h = harness();
		codexAccounts(h.api);
		await h.commands.get("codex-accounts").handler("routing", h.ctx);
		await h.fire("session_shutdown");
		return JSON.stringify(h.entries);
	};
	assert.match(await report(), /Preferred account: not set\./);
	mkdirSync(join(dir, "codex-accounts"));
	writeFileSync(join(dir, "codex-accounts", "settings.json"), JSON.stringify({ accounts, preferredAccount: "codex3" }));
	assert.match(await report(), /Preferred account: codex3\./);

	const states: NonNullable<CodexStatusSnapshot["routing"]>[] = [];
	const h = harness();
	registerGateway(h.api, (state) => states.push(state));
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "codex1" } });
	assert.equal(states.at(-1)?.preferredAccount, undefined);
	registerGateway(h.api, (state) => states.push(state), "codex3");
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "codex1" } });
	assert.equal(states.at(-1)?.preferredAccount, "codex3");
	assert.equal(states.at(-1)?.selectedAccount, "codex1");
});

test("malformed gateway configuration leaves the direct provider active", async (t) => {
	environment(t, true);
	process.env.TENANTEXT_LITELLM_BASE_URL = "https://private:secret@gateway.invalid/v1";
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Factory must not use the network"); });
	const h = harness();
	codexAccounts(h.api);
	assert.ok(h.providers.has("openai-codex-2"));
	assert.ok(!h.providers.has(GATEWAY_PROVIDER));
	await h.commands.get("codex-accounts").handler("routing", h.ctx);
	assert.ok(!JSON.stringify(h.entries).includes("secret"));
	await h.fire("session_shutdown");
});

test("registered response hook validates selected accounts and ignores unrelated providers", async (t) => {
	environment(t, true);
	const h = harness();
	const states: NonNullable<CodexStatusSnapshot["routing"]>[] = [];
	assert.equal(registerGateway(h.api, (state) => states.push(state)), true);
	assert.equal(h.providers.get(GATEWAY_PROVIDER)?.models?.length, 3);
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "codex2" } });
	assert.equal(states.at(-1)?.selectedAccount, "codex2");
	assert.equal(states.at(-1)?.state, "unknown");
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "codex3" } });
	assert.equal(states.at(-1)?.selectedAccount, "codex3");
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "codex0" } });
	assert.equal(states.at(-1)?.selectedAccount, undefined);
	await h.fire("after_provider_response", { status: 200, headers: { "x-codex-account": "secret\nvalue" } });
	assert.equal(states.at(-1)?.selectedAccount, undefined);
	const count = states.length;
	await h.fire("after_provider_response", { status: 409, headers: {} }, { model: { provider: "unrelated" } } as ExtensionContext);
	assert.equal(states.length, count);
	await h.fire("after_provider_response", { status: 409, headers: {} });
	assert.equal(states.at(-1)?.summary, CONTINUATION_ERROR);
	await h.fire("after_provider_response", { status: 503, headers: {} });
	assert.equal(states.at(-1)?.summary, gatewayHttpError(503));
	assert.equal(states.at(-1)?.state, "error");
	assert.ok(!JSON.stringify(states).includes("secret"));
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<"openai-completions"> = { ...gatewayModels()[0], provider: GATEWAY_PROVIDER, baseUrl: "https://gateway.invalid/v1" };
const history: TranscriptContext = normalizeContext({ messages: [
	{ role: "system", content: "System instructions", timestamp: 1, toolsAdded: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] },
	{ role: "user", content: "First user message", timestamp: 2 },
	{ role: "assistant", content: [{ type: "toolCall", id: "call_a", name: "lookup", arguments: { value: "previous_response_id" } }], timestamp: 3, provider: GATEWAY_PROVIDER, model: model.id, api: model.api, stopReason: "toolUse", usage },
	{ role: "toolResult", toolCallId: "call_a", toolName: "lookup", content: [{ type: "text", text: "Tool result" }], isError: false, timestamp: 4 },
	{ role: "user", content: "Second user message", timestamp: 5 },
] });
function sse() {
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", content: "Result " }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_b", type: "function", function: { name: "lookup", arguments: '{"value":' } }] }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }] }, finish_reason: "tool_calls" }] },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "x-codex-account": "codex1" } });
}

test("real serializer sends full history, reasoning, tools and valid streamed tool arguments", async (t) => {
	environment(t, true);
	const h = harness();
	const states: unknown[] = [];
	registerGateway(h.api, (state) => states.push(state));
	let sent: any;
	const stream = h.providers.get(GATEWAY_PROVIDER)!.streamSimple!({ ...model, samplingParams: { messages: [], previous_response_id: "unsafe" } }, history, {
		apiKey: "fixture-only", reasoning: "high", maxRetries: 0,
		onPayload(payload) { const value = payload as any; value.messages.length = 0; return { ...value, previous_response_id: "unsafe", conversation: "unsafe", stream: false }; },
		onResponse: (event) => h.fire("after_provider_response", event),
		fetch: async (_input, init) => { sent = JSON.parse(String(init?.body)); assert.equal(init?.redirect, "error"); return sse(); },
	});
	const events = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.ok(events.includes("text_delta"));
	assert.ok(events.includes("toolcall_delta"));
	assert.deepEqual(result.content.find((part) => part.type === "toolCall")?.arguments, { value: "ok" });
	assert.equal(sent.messages.length, 5);
	assert.equal(sent.messages[1].content, "First user message");
	assert.equal(sent.messages[3].content, "Tool result");
	assert.equal(sent.messages[4].content, "Second user message");
	assert.deepEqual(JSON.parse(sent.messages[2].tool_calls[0].function.arguments), { value: "previous_response_id" });
	assert.equal(sent.reasoning_effort, "high");
	assert.equal(sent.tools[0].function.name, "lookup");
	assert.equal(sent.stream, true);
	assert.ok(!("previous_response_id" in sent));
	assert.ok(!("conversation" in sent));
	assert.equal((states.at(-1) as any).selectedAccount, "codex1");
});

test("the Pi session id reaches the Codex account proxy as extra_body.litellm_session_id", async () => {
	const bodies: any[] = [];
	const fetcher = async (_input: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return sse(); };
	await gatewayStream(model, history, { apiKey: "fixture-only", maxRetries: 0, sessionId: "session-affinity-1", fetch: fetcher }).result();
	await gatewayStream(model, history, { apiKey: "fixture-only", maxRetries: 0, fetch: fetcher }).result();
	assert.deepEqual(bodies[0].extra_body, { litellm_session_id: "session-affinity-1" });
	assert.ok(!("litellm_session_id" in bodies[0]));
	assert.ok(!("extra_body" in bodies[1]));
});

test("Pi records the gateway token-price estimate from streamed usage", async () => {
	const priced = { ...model, ...gatewayModels()[0] };
	const chunk = { id: "fixture", object: "chat.completion.chunk", model: priced.id,
		choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125,
			prompt_tokens_details: { cached_tokens: 20 } } };
	const result = await gatewayStream(priced, history, { apiKey: "fixture-only", maxRetries: 0,
		fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } }),
	}).result();
	assert.equal(result.stopReason, "stop");
	assert.equal(result.usage.input, 100);
	assert.equal(result.usage.cacheRead, 20);
	assert.ok(Math.abs(result.usage.cost.total - (100 * priced.cost.input + 20 * priced.cost.cacheRead + 5 * priced.cost.output) / 1_000_000) < 1e-12);
});

test("HTTP 409 reaches the real response hook and returns only a safe error", async (t) => {
	environment(t, true);
	const h = harness();
	const states: any[] = [];
	registerGateway(h.api, (state) => states.push(state));
	const result = await gatewayStream(model, history, {
		apiKey: "fixture-only", maxRetries: 0,
		onResponse: (event) => h.fire("after_provider_response", event),
		fetch: async () => new Response("private response body", { status: 409 }),
	}).result();
	assert.equal(result.errorMessage, CONTINUATION_ERROR);
	assert.equal(states.at(-1).summary, CONTINUATION_ERROR);
	assert.ok(!JSON.stringify(result).includes("private response body"));
});

test("network, malformed stream and setup errors suppress raw details", async () => {
	for (const fetcher of [async () => { throw new Error("private network detail"); }, async () => new Response('data: {"error":{"message":"private stream error"}}\n\n', { headers: { "content-type": "text/event-stream" } })]) {
		const result = await gatewayStream(model, history, { apiKey: "fixture-only", maxRetries: 0, fetch: fetcher }).result();
		assert.equal(result.errorMessage, GATEWAY_ERROR);
		assert.ok(!JSON.stringify(result).includes("private"));
	}
	const result = await gatewayStream(model, history, { apiKey: "", maxRetries: 0 }).result();
	assert.equal(result.errorMessage, GATEWAY_ERROR);
});

test("HTTP failures retain safe status messages and Pi retry classification", async () => {
	for (const status of [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]) {
		const result = await gatewayStream(model, history, {
			apiKey: "fixture-only", maxRetries: 0,
			fetch: async () => new Response("private credential or prompt detail", { status }),
		}).result();
		assert.equal(result.errorMessage, gatewayHttpError(status));
		assert.match(result.errorMessage!, new RegExp(`HTTP ${status}`));
		assert.ok(!JSON.stringify(result).includes("private"));
		assert.equal(isRetryableAssistantError(result), [408, 429, 500, 502, 503, 504].includes(status));
	}
});

test("Pi recovers from an Astra xhigh 503 using its existing retry policy", async () => {
	let calls = 0;
	const sent: any[] = [];
	const retries: number[] = [];
	const astra: typeof model = { ...model, ...gatewayModels()[2] };
	const result = await retryAssistantCall(() => gatewayStream(astra, history, {
		apiKey: "fixture-only", reasoning: "xhigh", maxRetries: 0,
		fetch: async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return ++calls === 1 ? new Response("private upstream access verification error", { status: 503 }) : sse();
		},
	}).result(), { enabled: true, maxRetries: 3, baseDelayMs: 0 }, undefined, {
		onRetryScheduled: async (attempt) => { retries.push(attempt); },
	});
	assert.equal(result.stopReason, "toolUse");
	assert.equal(calls, 2);
	assert.deepEqual(retries, [1]);
	assert.deepEqual(sent[0], sent[1]);
	assert.equal(sent[0].model, "codex-auto/astra");
	assert.equal(sent[0].reasoning_effort, "xhigh");
	assert.equal(sent[0].messages.length, 5);
});

test("persistent 503 failures respect the Pi retry budget", async () => {
	let calls = 0;
	const result = await retryAssistantCall(() => gatewayStream(model, history, {
		apiKey: "fixture-only", maxRetries: 0,
		fetch: async () => { calls++; return new Response("private", { status: 503 }); },
	}).result(), { enabled: true, maxRetries: 3, baseDelayMs: 0 }, undefined);
	assert.equal(calls, 4);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, gatewayHttpError(503));
});

test("disabled retries and partial streams never replay requests", async () => {
	for (const partial of [false, true]) {
		let calls = 0;
		const result = await retryAssistantCall(() => gatewayStream(model, history, {
			apiKey: "fixture-only", maxRetries: 0,
			fetch: async () => {
				calls++;
				if (!partial) return new Response("private", { status: 503 });
				const chunk = { choices: [{ index: 0, delta: { content: "Partial output" }, finish_reason: null }] };
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: {"error":{"message":"private 503 service unavailable"}}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		}).result(), { enabled: partial, maxRetries: 3, baseDelayMs: 0 }, undefined);
		assert.equal(calls, 1);
		assert.equal(result.stopReason, "error");
		if (partial) {
			assert.equal(result.errorMessage, GATEWAY_ERROR);
			assert.ok(result.content.some((part) => part.type === "text" && part.text === "Partial output"));
			assert.equal(isRetryableAssistantError(result), false);
		}
	}
});

test("cancelling an HTTP retry stops before the next request", async () => {
	let calls = 0;
	const controller = new AbortController();
	const result = await retryAssistantCall(() => gatewayStream(model, history, {
		apiKey: "fixture-only", maxRetries: 0, signal: controller.signal,
		fetch: async () => { calls++; return new Response("private", { status: 503 }); },
	}).result(), { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, controller.signal, {
		onRetryScheduled: async () => { controller.abort(); },
	});
	assert.equal(calls, 1);
	assert.equal(result.stopReason, "aborted");
});

test("status bus stays idle, coalesces requests, shares command results and aborts shutdown", async () => {
	const h = harness();
	let calls = 0;
	let resolve!: (results: AccountLimits) => void;
	let signal!: AbortSignal;
	const service = createCodexStatus(h.api, accounts, async (_accounts, currentSignal) => { calls++; signal = currentSignal; return new Promise((done) => { resolve = done; }); });
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	assert.equal(calls, 0);
	await h.fire("session_start");
	assert.equal(calls, 0);
	h.bus.emit(CODEX_REFRESH_EVENT);
	h.bus.emit(CODEX_REFRESH_EVENT);
	const command = service.refresh(h.ctx);
	assert.equal(calls, 1);
	const results: AccountLimits = accounts.map((account) => ({ account, result: { success: true, windows: parseCodexLimits({ rate_limit: { primary_window: { used_percent: 30 } } }) } }));
	resolve(results);
	assert.deepEqual(await command, results);
	assert.equal(states.at(-1)?.accounts[0].windows[0].remainingPercent, 70);
	assert.equal(states.at(-1)?.accounts[0].state, "ok");
	h.bus.emit(CODEX_REFRESH_EVENT);
	assert.equal(calls, 1);
	const cancelled = service.refresh(h.ctx);
	assert.equal(calls, 2);
	await h.fire("session_shutdown");
	assert.equal(signal.aborted, true);
	assert.deepEqual(await cancelled, []);
	assert.equal(h.bus.listenerCount(CODEX_REFRESH_EVENT), 0);
	const count = states.length;
	resolve(results);
	await Promise.resolve();
	assert.equal(states.length, count);
});

test("collection deadline aborts an unresponsive collector", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	let signal!: AbortSignal;
	const service = createCodexStatus(h.api, accounts, async (_accounts, current) => { signal = current; return new Promise(() => {}); });
	await h.fire("session_start");
	const pending = service.refresh(h.ctx);
	t.mock.timers.tick(16_000);
	assert.equal(signal.aborted, true);
	assert.deepEqual(await pending, []);
	await h.fire("session_shutdown");
});

test("Pi runtime lists the three supported aliases with saved provider authentication", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(GATEWAY_PROVIDER, async () => ({ type: "api_key", key: "fixture-only" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	runtime.registerProvider(GATEWAY_PROVIDER, {
		baseUrl: model.baseUrl, api: "openai-completions", models: gatewayModels(),
		streamSimple: (current, context, options) => gatewayStream(current as Model<"openai-completions">, context, options),
	});
	assert.equal((await runtime.getAvailable(GATEWAY_PROVIDER)).length, 3);
	assert.equal(runtime.getModels("openai-codex").length, canonicalCodexProvider.getModels().length);
	const result = await runtime.streamSimple(runtime.getModel(GATEWAY_PROVIDER, model.id)!, history, { fetch: async () => sse(), maxRetries: 0 }).result();
	assert.equal(result.stopReason, "toolUse");
});

test("an early footer request waits for session_start", async () => {
	const h = harness();
	let calls = 0;
	createCodexStatus(h.api, accounts, async () => { calls++; return []; });
	h.bus.emit(CODEX_REFRESH_EVENT);
	assert.equal(calls, 0);
	await h.fire("session_start");
	assert.equal(calls, 1);
	await h.fire("session_shutdown");
});

test("one request a minute gives one fetch each, and a request inside the skip time gives none", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
	const h = harness();
	let calls = 0;
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	// A fetch takes two seconds. The reading gets its time when the fetch ends, so it is younger than the time since the request.
	createCodexStatus(h.api, accounts, async (list) => {
		calls++; t.mock.timers.tick(2000);
		return list.map((account) => ({ account, result: { success: true as const, windows: parseCodexLimits({ rate_limit: { primary_window: { used_percent: 30 } } }) } }));
	});
	const request = async () => { h.bus.emit(CODEX_REFRESH_EVENT); await new Promise((resolve) => setImmediate(resolve)); };
	await h.fire("session_start");
	await request();
	assert.equal(calls, 1);
	assert.equal(states.at(-1)?.staleAfter, CODEX_STALE_AFTER_MS);
	assert.equal(CODEX_REFRESH_MIN_MS, 30_000, "the skip time is below one default poll of 60 seconds");
	assert.equal(CODEX_STALE_AFTER_MS, 120_000, "the lifetime covers two default polls");
	for (let poll = 1; poll <= 10; poll++) {
		t.mock.timers.tick(58_000);
		await request();
		assert.equal(calls, 1 + poll, `poll ${poll}, 60 seconds after the last request, fetches`);
		assert.equal(states.at(-1)?.checkedAt, Date.now());
	}
	await request(); await request();
	assert.equal(calls, 11, "a burst after a reading gives no fetch");
	t.mock.timers.tick(29_999); await request();
	assert.equal(calls, 11, "one millisecond before the skip time ends");
	t.mock.timers.tick(1); await request();
	assert.equal(calls, 12, "at the skip time");
	await h.fire("session_shutdown");
});

test("status errors omit raw errors, custom account labels, and unknown quota values", async () => {
	const h = harness();
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	const service = createCodexStatus(h.api, accounts, async () => [
		{ account: { ...accounts[0], label: "private account label" }, result: { success: false, error: "private credential path" } },
		{ account: accounts[1], result: { success: true, windows: parseCodexLimits({ rate_limit: { primary_window: { used_percent: "not numeric" } } }) } },
	]);
	await h.fire("session_start");
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)?.accounts[0].state, "error");
	assert.equal(states.at(-1)?.accounts[1].state, "unknown");
	assert.ok(!JSON.stringify(states).includes("private"));
	assert.ok(!JSON.stringify(states).includes("NaN"));
	await h.fire("session_shutdown");
});

test("a credential failure keeps the last good windows until a reset passes or a day ends", async () => {
	const h = harness();
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	const future = new Date(Date.now() + 3_600_000).toISOString();
	let next: AccountLimits[number]["result"] = { success: true, windows: [{ label: "7d", usedPercent: 37, remainingPercent: 63, resetsAt: new Date(future) }] };
	const service = createCodexStatus(h.api, [accounts[1]], async () => [{ account: accounts[1], result: next }]);
	await h.fire("session_start");
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)?.accounts[0].state, "ok");
	next = { success: false, error: "Token file unreadable or expired" };
	await service.refresh(h.ctx);
	assert.deepEqual(states.at(-1)?.accounts[0], { provider: "openai-codex-2", label: "Codex 2", state: "unknown",
		windows: [{ label: "7d", remainingPercent: 63, resetsAt: future, unavailable: undefined }] }, "the last reading stands in without an error");
	next = { success: false, error: "Network request failed" };
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)?.accounts[0].state, "error", "a non-credential failure stays an error");
	next = { success: true, windows: [{ label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: new Date(Date.now() - 1000) }] };
	await service.refresh(h.ctx);
	next = { success: false, error: "HTTP 401" };
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)?.accounts[0].state, "error", "a reading whose window has reset is not reused");
	await h.fire("session_shutdown");
});

test("an account with no login publishes login false, with no last reading and no error", async () => {
	const h = harness();
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	const third = { provider: "openai-codex-3", label: "Codex 3" };
	let next: AccountLimits[number]["result"] = { success: true, windows: [{ label: "7d", usedPercent: 37, remainingPercent: 63, resetsAt: new Date(Date.now() + 3_600_000) }] };
	const service = createCodexStatus(h.api, [third], async () => [{ account: third, result: next }]);
	await h.fire("session_start");
	await service.refresh(h.ctx);
	next = { success: false, error: NO_LOGIN_ERROR };
	await service.refresh(h.ctx);
	assert.deepEqual(states.at(-1)?.accounts[0], { provider: "openai-codex-3", label: "Codex 3", state: "unknown", login: false, windows: [] });
	next = { success: false, error: "Token file unreadable or expired" };
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)?.accounts[0].state, "error", "the reading from before the logout is not reused");
	assert.equal("login" in states.at(-1)!.accounts[0], false);
	await h.fire("session_shutdown");
});

test("status publishes each account's own plan and reported windows, and a refresh replaces a changed plan", async () => {
	const h = harness();
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	const weekly = (plan: string, used: number) => ({ plan_type: plan, rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604_800, reset_at: 1_800_000_000 }, secondary_window: null } });
	const mixed = (plan: string) => ({ plan_type: plan, rate_limit: {
		primary_window: { used_percent: 10, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 30, limit_window_seconds: 604_800 } } });
	let payloads: unknown[] = [];
	const service = createCodexStatus(h.api, accounts, async () => accounts.map((account, index) => ({ account, result: { success: true as const, ...parseCodexUsage(payloads[index]) } })));
	const view = () => states.at(-1)!.accounts.map((a) => ({ provider: a.provider, plan: a.plan, windows: a.windows.map((w) => `${w.label} ${w.remainingPercent}`) }));
	await h.fire("session_start");

	payloads = [weekly("prolite", 100), mixed("plus")];
	await service.refresh(h.ctx);
	assert.deepEqual(view(), [
		{ provider: "openai-codex", plan: "pro_lite", windows: ["7d 0"] },
		{ provider: "openai-codex-2", plan: "plus", windows: ["5h 90", "7d 70"] },
	]);

	// Swapped roles: plans follow the payload, never the account position or alias.
	payloads = [mixed("plus"), weekly("pro", 40)];
	await service.refresh(h.ctx);
	assert.deepEqual(view(), [
		{ provider: "openai-codex", plan: "plus", windows: ["5h 90", "7d 70"] },
		{ provider: "openai-codex-2", plan: "pro", windows: ["7d 60"] },
	]);

	// Both Pro: one weekly window each, no short window and no placeholder.
	payloads = [weekly("prolite", 100), weekly("prolite", 20)];
	await service.refresh(h.ctx);
	assert.deepEqual(view(), [
		{ provider: "openai-codex", plan: "pro_lite", windows: ["7d 0"] },
		{ provider: "openai-codex-2", plan: "pro_lite", windows: ["7d 80"] },
	]);

	// Unknown and absent plans stay honest; the server string is not published.
	payloads = [{ ...weekly("x", 5), plan_type: "Bearer private" }, { rate_limit: weekly("pro", 5).rate_limit }];
	await service.refresh(h.ctx);
	assert.deepEqual(view().map((a) => a.plan), ["unknown", undefined]);
	assert.equal("plan" in states.at(-1)!.accounts[1], false);
	assert.ok(!JSON.stringify(states).includes("private"));
	await h.fire("session_shutdown");
});

test("a credential failure keeps the last good plan with its windows; another failure drops both", async () => {
	const h = harness();
	const states: CodexStatusSnapshot[] = [];
	h.bus.on(CODEX_STATUS_EVENT, (state) => states.push(state));
	const future = 1_800_000_000;
	const good = () => ({ success: true as const, ...parseCodexUsage({ plan_type: "prolite", rate_limit: {
		primary_window: { used_percent: 37, limit_window_seconds: 604_800, reset_at: future }, secondary_window: null } }) });
	let next: AccountLimits[number]["result"] = good();
	const service = createCodexStatus(h.api, accounts.slice(1), async (list) => list.map((account) => ({ account, result: next })));
	await h.fire("session_start");
	await service.refresh(h.ctx);
	assert.equal(states.at(-1)!.accounts[0].plan, "pro_lite");
	next = { success: false as const, error: "HTTP 401" };
	await service.refresh(h.ctx);
	assert.deepEqual(states.at(-1)!.accounts[0], { provider: "openai-codex-2", label: "Codex 2", state: "unknown", plan: "pro_lite",
		windows: [{ label: "7d", remainingPercent: 63, resetsAt: new Date(future * 1000).toISOString(), unavailable: undefined }] },
		"the cached reading carries the plan it was read with");
	next = { success: false as const, error: "Network request failed" };
	await service.refresh(h.ctx);
	assert.deepEqual(states.at(-1)!.accounts[0], { provider: "openai-codex-2", label: "Codex 2", state: "error", windows: [] },
		"a non-credential failure publishes no plan and no windows");
	await h.fire("session_shutdown");
});
