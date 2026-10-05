# Codex automatic routing

The optional `litellm-codex` provider sends complete conversations through LiteLLM's automatic Codex routes.
Direct OAuth providers remain separate and available.

## Configuration

The extension reads `TENANTEXT_LITELLM_BASE_URL` and `TENANTEXT_LITELLM_API_KEY` from the process environment.
The base URL must include the gateway's API prefix, usually `/v1`.
There is no default URL or tracked credential.
HTTPS is required, except for loopback HTTP addresses.
URLs cannot contain user information, queries, fragments, spaces, or backslashes.
Missing or invalid configuration disables only the gateway provider.

A saved Pi API key for `litellm-codex` can replace the environment key.
The base URL still comes from the environment.
The extension does not copy the saved key into its provider configuration.
Pi resolves the saved key when it sends a request.
Reload the extension after changing configuration or adding a saved key.

Warning: Do not put gateway keys in tracked files, shell command arguments, or session messages.

Warning: Do not copy Pi OAuth refresh tokens into LiteLLM token directories.

## Model entries

| Pi model ID | Upstream catalog model |
| --- | --- |
| `codex-auto/luna` | `gpt-6-luna` |
| `codex-auto/sol` | `gpt-6.1-sol` |
| `codex-auto/astra` | `gpt-6-astra` |

GPT-6 Terra is excluded because ChatGPT Codex rejects `gpt-6-terra` for subscription accounts.
The provider copies GPT-6 Astra limits for uncataloged GPT-6 variants.
It uses exact Pi catalog prices when available and pinned API-equivalent estimates for uncataloged variants.
A missing GPT-6 Astra catalog entry disables the gateway instead of inventing limits.
The gateway uses `openai-completions`, not native Responses or Codex WebSockets.
The provider sends the Pi session ID as `extra_body.litellm_session_id`.
The Codex account proxies turn that value into the ChatGPT `session_id` header, which selects the prompt-cache server.
Without it each request gets a random session ID, and the cache-read rate drops to about half of the direct providers.
Only `extra_body` carries the value through the gateway; a top-level `litellm_session_id` is consumed by the gateway.
The standard Pi serializer and stream parser handle messages, reasoning settings, images, and function tools.
Grammar tools use Pi's function-tool fallback because gateway grammar support is not verified.
Price rates are USD per million tokens. The fallback rates come from Pi's GPT-6 catalog. Not verified: whether these fallback rates match current API prices.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| Luna | $0.10 | $0.50 | $0.01 | $0.125 |
| Sol | $2 | $10 | $0.20 | $2.50 |
| Astra | $10 | $50 | $1 | $12.50 |

Pi uses these rates for session costs, footer totals, subagent costs, and stored assistant-message usage.
These values estimate equivalent API token spend, not gateway billing or incremental subscription charges.
Existing sessions retain their recorded cost. The change does not reprice past session records.
Reload Pi after updating this extension to use the new fallback rates.

## Route choices

| Route | Credential owner | Account choice |
| --- | --- | --- |
| `litellm-codex/codex-auto/*` | Separate gateway bearer key | Gateway prefers Codex 2 and can fall back to Codex 1 |
| Gateway `codex1/<model>` | Separate gateway bearer key | Gateway account 1 only |
| Gateway `codex2/<model>` | Separate gateway bearer key | Gateway account 2 only |
| `openai-codex` | Pi's built-in OAuth provider | Direct Pi account 1 |
| `openai-codex-2` | Pi's isolated second OAuth provider | Direct Pi account 2 |

Only the automatic aliases enter the new Pi catalog.
Explicit gateway routes require separate client configuration; this extension does not register duplicate entries for them.
Direct Pi account credentials and gateway account credentials have separate refresh owners.
The extension does not assume those independent logins represent the same accounts.

The gateway falls back once before response bytes reach the client.
A reported Codex 2 limit or HTTP 429 can cause fallback.
A later reset can return safe requests to Codex 2.
Authentication errors and mid-stream failures do not cause an account switch.

Warning: Fallback cannot complete a request when both accounts have exhausted their allowance.

## Conversation safety

Every automatic request sends the full active Pi conversation, including its compaction summary when applicable.
The provider wrapper restores the complete serialized message list after request hooks run.
Sampling overrides cannot replace messages or select a continuation.
The wrapper removes top-level `previous_response_id` and `conversation` fields before transmission.
It does not remove matching words inside tool arguments or message text.
It also preserves the automatic model ID and streaming mode.

HTTP 409 produces a fixed explanation about account-scoped continuations.
Other recognized HTTP failures retain the status code with a fixed, safe explanation.
Pi uses these messages to classify failures for its existing retry policy.
A generic message without the status code prevents classification of upstream HTTP 503 errors.
HTTP errors, network errors, and stream errors do not expose raw error bodies or credentials.

Only rejected HTTP requests receive the retry classification.
Errors after a successful HTTP response keep the generic message, so partial output does not trigger automatic replay.
The wrapper adds no retry loop and does not override retry settings, account routing, models, or reasoning levels.
A disabled retry policy remains disabled; a persistent failure stops when the configured retry budget ends.
HTTP 429 identifies an account or rate limit without claiming which limit applies.
The wrapper does not change unrelated providers or replace global `fetch`.
Redirects fail instead of forwarding credentials to another URL.

## Local status

`/codex-accounts routing` displays local routing information without making a model call.
The `after_provider_response` hook accepts a gateway account name of the form `codexN` (`codex1`, `codex2`, `codex3`, ...) from `X-Codex-Account`.
The selected account means the last response account, not a promise about the next request.

The extension does not query the router's private status endpoint.
The public gateway does not provide a verified routing status endpoint.
Blocked-until time and gateway quota-cache duration therefore remain unknown.
A successful completion does not make routing status fully known.

`/codex-accounts limits` publishes the same parsed quota snapshot used by footer consumers.
Collection reads unexpired saved direct-account access tokens and queries the usage endpoint.
An account with a `tokenFile` setting uses the gateway's auth file instead of the Pi login.
Then a stale or invalidated Pi login for that account has no effect on the meter.
It does not refresh OAuth credentials or write credential files.
An expired token requires authentication or refresh by the login owner before a later quota check.
Until then, the snapshot keeps the account's last good plan and windows with state `unknown` for up to 24 hours, unless a window reset has passed.
Other failures, such as network errors, show an error at once.
Malformed or missing quota values appear unavailable, not as unused allowance.

The collector publishes only the windows in the response. `limit_window_seconds` sets each label, for example `5h`, `7d`, `1d`, or `90m`. The `primary_window` and `secondary_window` slots do not imply a duration. A window without a valid duration shows `window`. Windows sort from the shortest reported duration. The collector adds no placeholder for a window that the response omits.

`plan_type` becomes one allowlisted value: `free`, `go`, `plus`, `pro`, `pro_lite`, `team`, `business`, `enterprise`, `edu`, or `unknown`. The snapshot omits the plan when the response has none or the request fails. A cached last good reading keeps the plan it was read with. The server string never enters the snapshot. The plan does not change which windows appear.

| Response | Windows |
| --- | --- |
| `prolite`, `primary_window` of 604800 seconds, `secondary_window` null (observed) | `7d` |
| `plus`, 18000-second primary and 604800-second secondary | `5h`, `7d` |
| Weekly window in `secondary_window` only (not observed) | `7d` |
| Window without `limit_window_seconds` | `window` |

## Status bus

| Export | Event name |
| --- | --- |
| `CODEX_STATUS_EVENT` | `tenantext:codex:status` |
| `CODEX_REFRESH_EVENT` | `tenantext:codex:refresh` |

`extensions/codex-accounts/status.ts` exports `CodexStatusSnapshot` for consumers.
Consumers can import that type without loading provider registration.
Refresh requests carry no secrets.
The service coalesces concurrent requests and reuses recent results: a request inside the skip time gets the cached snapshot.
The skip time is shorter than the default poll time of the footer (60 seconds), so one request a minute gives one fetch a minute.
A consumer request received before `session_start` waits for the session context.
The extension starts no polling and sends no network request from its factory or renderer.
Shutdown removes the refresh listener and aborts collection.

| Bound | Value |
| --- | ---: |
| Request skip time | 30 seconds |
| Snapshot lifetime | 120 seconds |
| Individual usage request timeout | 15 seconds |
| Complete collection deadline | 16 seconds |

## Verification

The local tests use Pi's real chat serializer and stream parser with simulated HTTP responses.
They cover full history, tool arguments/results, reasoning, streaming tools, HTTP 409, header validation, and error suppression.
Retry tests use Pi's real retry helper with simulated Astra `xhigh` HTTP 503 responses.
They check recovery, unchanged payloads, the retry budget, cancellation, disabled retries, and no replay after partial output.
They also cover configuration, model metadata, direct-provider registration, coalescing, and shutdown cancellation.

Not verified: recovery from a naturally recurring upstream 503.

Observed with LiteLLM 1.101.0: streamed tool responses can report `stop` instead of `toolUse`, even when tool arguments are present.
The gateway must map a completed streamed response with tool calls to `finish_reason: "tool_calls"`, which Pi reads as `toolUse`.
Not verified: a streamed tool call through every gateway version.
Not verified: a non-streaming tool request.
Not verified: live requests for every alias, or preservation of `X-Codex-Account`.

## Node child loader compatibility

Import the stream dispatcher from `@earendil-works/pi-ai/compat`.
The Node extension loader aliases the package root to `compat.js`.
A nested `api/openai-completions` import can resolve below that file and prevent provider registration.
The bundled interactive CLI can still work while Node subagents fail.
`test/codex-loader.test.ts` checks the real Node loader and a slash-containing alias with `:xhigh`.

Register one copy of the package only; `pi list` should show one Tenantext source.
Run `/reload` in existing Pi sessions after validation; new sessions load the changed source.
