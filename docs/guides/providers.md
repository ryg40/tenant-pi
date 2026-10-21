# Provider guide: Codex, llama-swap and vLLM

This guide adds three providers to one generated Pi profile. Use each part that you need. No part needs a LiteLLM gateway: Pi connects to the provider directly.

| Provider | What it is | How Pi reaches it |
| --- | --- | --- |
| Codex | The hosted Codex models of a ChatGPT subscription. | A provider that Pi includes. You log in inside Pi. |
| llama-swap | A local proxy that starts and stops model servers. It serves an OpenAI-compatible API. | A provider that you register in `models.json` of the profile. |
| vLLM | A local or LAN inference server. It serves an OpenAI-compatible API. | A provider that you register in `models.json` of the profile. |

The kit runs none of these steps. `validate`, `plan` and `generate` write no credential. `generate` can now emit validated non-secret `models.json` input; see [direct providers](#direct-providers). You do each step by hand, or an agent does it after you say yes.

## Words in this guide

- `<target>`: the profile directory of `target.agentDir` in the overlay. The launcher sets `PI_CODING_AGENT_DIR` to this directory. The examples use `"$HOME/.pi/profiles/main"`.
- `<private dir>`: your private directory outside the clone. The examples use `~/.config/tenant-pi`.
- `<pin>`: `runtime.piVersion` in `config/manifest.json`.
- Model alias: the name that the server uses for one model in its API. It is the `id` value in `GET /v1/models`.

## Rules

1. Work in `<target>` only. Do not edit `~/.pi/agent` or another profile.
2. Write no secret into a file. Name a credential by its environment variable.
3. Copy no `auth.json` and no login state between profiles.
4. Keep the real endpoint, the real model alias and the variable name in `<private dir>`. Do not put them into the clone. The examples here are synthetic.
5. Ask the user for each endpoint and each model. Use no default endpoint and no default model.

## Where the facts come from

The kit pin is `<pin>` (`runtime.piVersion` in `config/manifest.json`). The Pi 1.0.4 facts in this guide were not read again on the pin. Read the Pi documentation of your installed version when a fact matters.

The Pi facts in this guide were read from the documentation and the source of Pi 1.0.4, and checked with `pi --list-models` on Pi 1.0.4 in an empty profile directory with no network and no provider key. No model request ran. Not verified: a login, a model reply, and each server behaviour.

## Codex

### What Pi includes

Pi 1.0.4 has two providers for a ChatGPT subscription:

| Provider name in Pi | Label in `/login` | Note |
| --- | --- | --- |
| `openai-codex` | OpenAI Codex (legacy) | The Codex provider of earlier Pi versions. The Tenantext components of the kit use this name. |
| `openai` | OpenAI, with the method "Sign in with ChatGPT" | The Pi changelog says that this sign-in replaces `openai-codex`. The same provider also accepts an API key. |

Ask the user which provider to use. Recommend `openai-codex` when the profile uses a Tenantext component that names it. Not verified: which models the `openai` sign-in gives with a subscription.

### Log in

1. Launch the profile with the launcher file or the plan launch line. See [INSTALL.md](../../INSTALL.md#stage-9-first-launch-and-checks).
2. Run this inside Pi:

   ```text
   /login
   ```

3. Select the provider. Pi opens a browser sign-in. On a remote machine, paste the final redirect address or the authorization code into Pi when Pi asks for it.
4. Pi stores the result in `<target>/auth.json`. The kit does not read, write or copy that file.

Print mode cannot log in. Log in one time in an interactive session.

### Select the model

Ask the user which model they want. Read the list from Pi after the login, because Pi shows a model only when its provider has a credential:

```sh
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --list-models openai-codex
```

Inside Pi, `/model` shows the same list. Press `Ctrl+S` on a model to save it as the default of the profile.

Observed in the bundled catalog of Pi 1.0.4 for `openai-codex`: `gpt-6.1-sol` (the default), `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` and `gpt-5.3-codex-spark`. Pi can replace this catalog with a newer one. Not verified: which of these models your subscription gives.

Do not register a Codex model in `models.json`. Pi has the model metadata.

### Codex login and the gateway are separate

A Codex login belongs to Pi and to one profile. The optional Tenantext gateway uses another credential: a gateway key in `TENANTEXT_LITELLM_API_KEY`. One does not replace the other. A profile can use the native login with no gateway. See [INSTALL.md](../../INSTALL.md#stage-8-authentication) for the gateway key.

### More than one Codex account

Core Pi gives one login for each provider name. A second direct account needs the `codex-accounts` component of `packages/tenantext`. It registers the provider `openai-codex-2` with its own login. That component needs the gateway settings and the key `TENANTEXT_LITELLM_API_KEY`. See [the module guide](modules.md) for the component and `packages/tenantext/docs/codex-routing.md` for the routes. Without that component, do not offer a second account.

## Local providers: llama-swap and vLLM

### The registration file

Pi reads custom providers from one file in the profile directory:

```text
<target>/models.json
```

This is the registration mechanism for a server that speaks an API that Pi supports. Pi 1.0.4 names the OpenAI chat completions API `openai-completions`. llama-swap and vLLM both serve it.

The file has one `providers` object. Each key is a provider name that you choose. These are the fields of one provider that this guide uses:

| Field | Needed | Meaning |
| --- | --- | --- |
| `baseUrl` | Yes, when the provider defines models | The API base address. See [the base path](#the-base-path). |
| `api` | Yes | `openai-completions` for llama-swap and vLLM. |
| `apiKey` | Yes, in practice | A reference to the key, or a placeholder. See [authentication](#authentication). |
| `models` | Yes | A list. Each entry needs `id`, the exact model alias of the server. |

Pi stops the load of the file with an error text when `api` or `baseUrl` is missing, and when a field has the wrong type.

### The base path

Pi adds `/chat/completions` to `baseUrl`. So `baseUrl` is the address up to and including the prefix under which the server serves `chat/completions`.

- The documentation of llama-swap and of vLLM puts the OpenAI API under `/v1`. Then `baseUrl` ends in `/v1`. Not verified in this kit: the request below is the proof for your server.
- Do not add `/v1` when a reverse proxy in front of the server already removes or changes the prefix. Use the prefix that the proxy serves.
- Do not put `/chat/completions` into `baseUrl`.

Prove the base path before you write it. This request must return the model list:

```sh
curl -fsS http://127.0.0.1:8080/v1/models
```

Replace the address with yours. When the server needs a key, add the header from a variable, and do not type the key into the command:

```sh
curl -fsS -H "Authorization: Bearer $LLAMA_SWAP_API_KEY" http://127.0.0.1:8080/v1/models
```

Each `id` in the reply is one model alias. Use the exact text of the one you want.

### Local HTTP, LAN addresses and other ports

A direct provider in `models.json` accepts the address that you give: `http` or `https`, a loopback address, a LAN address, and each port. Pi does not restrict it.

This is not the gateway contract. The Tenantext gateway route of the kit accepts only a credential-free HTTPS address on port 443 that ends in `/v1`, and that rule does not change. See [model routes](providers.md#pure-model-route-contract). The difference in one line: the kit checks a gateway address in the overlay, and the direct-provider input validates a credential-free HTTP or HTTPS endpoint separately.

Warning: plain HTTP sends the prompt, the reply and the key without encryption. Use it on the loopback address or on a network that you trust.

### Authentication

Ask the user: "Does the server need a key?"

- No key: Pi lists a custom model only when the provider has a key value. Give a placeholder such as `"apiKey": "none"`. The server ignores it.
- With a key: write a reference, `"apiKey": "$LLAMA_SWAP_API_KEY"`. Pi reads the variable from the environment of the process that starts Pi. The file then holds a name and no secret. Export the variable in the shell that runs the launcher. See [shells that do not inherit your variables](../../INSTALL.md#shells-that-do-not-inherit-your-variables).

Observed with Pi 1.0.4: a model whose key variable is not set is not in the output of `pi --list-models`. A provider with no `apiKey` field is not listed.

The variable name is your choice. Do not write the key value into `models.json`, the overlay, the install log or a command line.

### Model metadata

Pi needs only `id` for a model. Pi 1.0.4 accepts these optional fields, with these defaults when you leave a field out:

| Field | Meaning | Pi default |
| --- | --- | --- |
| `name` | The label in the model list. | The `id` |
| `contextWindow` | The context size in tokens. | `128000` |
| `maxTokens` | The largest reply in tokens. | `16384` |
| `reasoning` | The model has a thinking mode. | `false` |
| `input` | `["text"]` or `["text", "image"]`. | `["text"]` |
| `cost` | Prices for the cost display. | All zero |

The defaults are fixed numbers of Pi. They are not facts about your model. Rules:

1. Take each value from the server or from the configuration of the server. Do not take it from memory, and do not guess it.
2. Set `contextWindow` when the server reports it or when you set it in the server configuration. Pi uses it to decide when to compact a session. With a wrong large value, the server can refuse a long request.
3. Leave `reasoning` and `input` out when you do not know them. The defaults are the safe choice: no thinking mode, text only.
4. Record in the install log which fields you set, and from which source.

Pi 1.0.4 accepts more fields, for example `compat`, `headers`, `thinkingLevelMap` and `samplingParams`. Use one only when the Pi documentation and a test with your server show that it is needed.

### llama-swap

Ask the user:

1. "What is the base address of your llama-swap server?" There is no default.
2. "Which model alias do you want in Pi?" It is one `id` of `GET /v1/models`: a model name of the llama-swap configuration, or one of its aliases.
3. "Does the server need a key?" When yes: "Which variable name holds it?"

llama-swap is not the llama.cpp router. Pi has a built-in `llama.cpp` provider with the `/llama` command, which uses the management interface of the llama.cpp router. Not verified: that interface on a llama-swap server. Do not use `/login llama.cpp` or `/llama` for llama-swap. Register it in `models.json` as below.

A synthetic example:

```json
{
  "providers": {
    "llama-swap": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "$LLAMA_SWAP_API_KEY",
      "models": [
        { "id": "local-chat" }
      ]
    }
  }
}
```

From the llama-swap documentation, not verified in this kit: llama-swap loads a model at the first request for it, so the first reply can take the load time of the model. Not verified: whether `GET /v1/models` of your llama-swap version reports a context size. When it does not, read the context size from the server command of that model in the llama-swap configuration.

### vLLM

Ask the user:

1. "What is the base address of your vLLM server?" There is no default.
2. "Which served model name do you want in Pi?" It is one `id` of `GET /v1/models`.
3. "Does the server need a key?" When yes: "Which variable name holds it?"

The served model name is not always the download name. From the vLLM documentation, not verified in this kit: vLLM serves a model under the name that its start command gives with the served-model-name option. Without that option, the name is the model argument of the start command: a repository name such as `example-org/example-model`, or a filesystem path. Pi needs the served name, exactly as `GET /v1/models` shows it. Do not use the repository name or the path unless the model list shows that text. A slash in the name is valid.

A synthetic example with metadata from the server:

```json
{
  "providers": {
    "vllm": {
      "baseUrl": "http://192.0.2.10:8000/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        { "id": "served-model", "contextWindow": 32768, "maxTokens": 4096 }
      ]
    }
  }
}
```

The two numbers are examples, not values for your model. Not verified in this kit: the vLLM documentation says that `GET /v1/models` reports the context size of a model as `max_model_len`. Use that number for `contextWindow` when your server reports it. Set `maxTokens` to a number below it.

### Write the file

Pi reads `models.json` from `<target>` only. Prefer the validated `inputs/models.json` path described in [direct providers](#direct-providers). The following manual route is for Pi features outside that closed subset.

1. Keep the master copy in the private directory, with mode 600. The private directory must exist first. The subshell keeps the `umask` of your shell unchanged:

   ```sh
   (umask 077 && "${EDITOR:-vi}" "$HOME/.config/tenant-pi/models.json")
   ```

   The `.gitignore` template of the private directory ignores `models.json`.

2. Look for a file that exists. Do not replace it without a read:

   ```sh
   ls -l "$HOME/.pi/profiles/main/models.json"
   ```

   When the file exists, add your provider key to its `providers` object and keep each other provider. One provider name can occur one time.

3. Copy the master copy into the profile:

   ```sh
   install -m 600 "$HOME/.config/tenant-pi/models.json" "$HOME/.pi/profiles/main/models.json"
   ```

Both providers of this guide can be in one file, as two keys of `providers`. A provider name of your own does not replace a provider that Pi includes. Do not use the name of a provider that Pi includes, such as `openai`, unless you want to change that provider.

Pi reads the file again when you open `/model`. A restart is not necessary.

### Registration and a new candidate

Set `inputs.modelsFile` to `inputs/models.json` and pass `--local-dir` to preserve supported direct providers during regeneration. Generation writes the validated file with mode `0600`. Comparison includes redacted change markers. Unsupported custom Pi fields require the manual route and do not migrate automatically.

For the manual route only, after each generation into a new target:

1. Copy the master copy into the new target with the `install` line above and the new path.
2. Log in to Codex again in the new candidate. The kit copies no `auth.json`.
3. Run the verification below for the new candidate.

The old candidate keeps its own file. See [the candidate update guide](../../POST_INSTALL.md#the-one-rule-each-change-is-a-new-candidate).

## Direct providers

The supported durable input is `inputs.modelsFile: "inputs/models.json"`.
Every `validate`, `plan` and `generate` call needs the same `--local-dir`.
The input has a closed subset of Pi's `models.json` format:

```json
{
  "providers": {
    "local-server": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "${LOCAL_MODEL_KEY}",
      "models": [{"id": "served-model"}]
    }
  }
}
```

`apiKey` accepts an environment-variable reference or the fixed dummy value `none` for a server without authentication.
Literal keys, credential commands, headers and unknown fields are rejected. No environment value is resolved.
Provider and model updates preserve other providers and other model entries in the supplied validated input.
The kit does not import a live `models.json`. It copies no `auth.json`.

Optional metadata fields are `name`, `contextWindow`, `maxTokens`, `reasoning` and `input`.
Supply metadata from server documentation; the kit invents none. Omitted metadata uses Pi's defaults, not verified server capabilities.
Generation writes `models.json` privately into the new candidate and records the definitions for replay validation.
Comparison reports private values as change markers. Carry does not migrate authentication or arbitrary runtime registrations.
Keep the saved input for regeneration; candidate files are not the master copy.

## Select a registered model

Three ways give the same result. Each uses the provider name and the model alias as two separate values.

- For one command: add `--model 'llama-swap/local-chat'` to the launch line.
- Inside Pi: open `/model`, select the model, and press `Ctrl+S` to save it as the default. Pi writes the default into `<target>/settings.json`. `compare` shows this as drift from the overlay.
- In the overlay, for each new candidate: enable `model-routing` and set the role.

  ```json
  {
    "roles": {"interactive": {"provider": "llama-swap", "model": "local-chat", "thinking": "off"}}
  }
  ```

  The kit then writes the default provider and model into `settings.json` at generation. It does not check that the provider exists: the plan keeps the gaps `model_catalog_unverified` and `provider_auth_unverified`. With `modelRoutes`, the `--registry` file needs an entry for the provider and the model. See [the module guide](modules.md) and [model routes](providers.md#pure-model-route-contract).

Use thinking `off` for a model without a thinking mode.

## Verify

Ask before each step. The first step sends no model request. The second step sends one small prompt to the provider.

1. The model is visible. Run this in the shell that has the key variable, when a key is in use:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --list-models local-chat
   ```

   Passed: one line with your provider name and your model alias, for example `llama-swap  local-chat`. Read the `context` and `max-out` columns: they show the metadata that Pi uses. `No models matching` means that the file did not load, the alias is different, or the key variable is not set. A text that starts with `Warning: errors loading models.json` names the wrong field.

2. The model replies. Use the fixed prompt of [check 3 of INSTALL.md](../../INSTALL.md#check-3-the-model-reply) and name the model:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --no-approve --model 'llama-swap/local-chat' -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"
   ```

   Read the output with the table of check 3. Record "Model replied" and "Reply matched".

3. The other providers are still there. Run `pi --list-models` with the same two assignments in front and no search word. Each provider that had a credential before is still in the list.

For Codex, run step 1 with `openai-codex` as the search word after the login, and step 2 with `--model 'openai-codex/<model>'`.

Record each step in `install-log.md` as passed, failed or not run, with the provider name and the model alias. Never record the key or the address of a private server in a file inside the clone. A step that did not run is "not run": write that the provider is unverified, never that it works.

## Problems

| Sign | Cause | What to do |
| --- | --- | --- |
| `No models matching` | The key variable is not set in this shell, the `apiKey` field is missing, or the alias is different. | Check the variable with `test -n "${LLAMA_SWAP_API_KEY:-}" && echo set`. Compare the `id` with `GET /v1/models`. |
| `Warning: errors loading models.json` | The file is not valid JSON, or a field has the wrong type. | Read the field path in the text. Correct the master copy and copy it again. |
| An HTTP 404 error on the prompt | `baseUrl` has the wrong prefix. | Run the `curl` line of [the base path](#the-base-path). |
| An HTTP 401 or 403 error on the prompt | The key is wrong, or the server needs a key and the file has a placeholder. | Set the reference and export the variable. |
| A model-not-found error from the server | The `id` is not the served name. | Use the exact `id` of `GET /v1/models`. |
| The Codex model is not in the list | No login in this profile. | Run `/login` in this profile. A login of another profile does not count. |

Not verified: the exact error text of each server.

## Related guides

- [INSTALL.md](../../INSTALL.md): the install stages and authentication.
- [Module guide](modules.md): `model-routing` and `codex-accounts`.
- [Candidate update guide](../../POST_INSTALL.md#the-one-rule-each-change-is-a-new-candidate): regenerate, compare and switch.
- [Model routes](providers.md#pure-model-route-contract): the HTTPS-only gateway contract.
- [Secret handling](../secret-handling.md): how the kit treats a credential.

## Pure model-route contract

This is an offline implementation contract, not a qualified runtime setup. `scripts/model_routes.py` neither reads files nor the environment, starts a process, or tests connectivity. The planner in `scripts/profile_plan.py` calls it; see `docs/profile-plan.md`. The existing core-only overlay stays valid without this extension. No defaults are selected.

### Client JSON v1

The optional top-level `modelRoutes` key has an independent `schemaVersion: 1`, an explicit `cycle` array of model choices, and a `gateway` object or `null`. Each choice has separate `provider`, `model`, and `thinking` strings and an optional `route` of `native` (default) or `gateway`. The same optional `route` is accepted on existing `roles.interactive`, `review`, `worker`, `research`, and `memory` objects only when `modelRoutes` exists. This keeps the legacy v1 overlay valid. The provider and model are never parsed from a combined string. A slash in a model ID is valid.

An illustrative synthetic shape, **not** a default or a working route:

```json
{
  "modelRoutes": {
    "schemaVersion": 1,
    "cycle": [
      {"provider": "fake-native", "model": "team/slash-id", "thinking": "high", "route": "native"}
    ],
    "gateway": null
  }
}
```

The rest of the overlay remains subject to `scripts/validate.py`. To choose models, enable both `core` and `model-routing`. To configure the gateway, also enable `codex-accounts`: this extension of `packages/tenantext` registers the gateway provider and reads `TENANTEXT_LITELLM_BASE_URL` and `TENANTEXT_LITELLM_API_KEY`. A non-null gateway is `{ "auth": "login" }` or `{ "auth": "env" }`. Set `endpoints.codex-accounts` to a credential-free HTTPS URL ending **exactly** in `/v1`; the renderer does not add or change prefixes. For environment-key auth, set `env.codex-accounts` to the literal `${TENANTEXT_LITELLM_API_KEY}`. For the source-declared Pi gateway login alternative, omit that mapping. This path has a fresh-profile bootstrap blocker; do not present it as working setup. Other endpoint/env keys are not supported by this pure extension. The old key `tenantext` fails with `moved_key`. A disabled gateway cannot have Tenantext endpoint/env fields or gateway choices. No endpoint or credential name is required for the core-only path.

This deliberately narrow endpoint rule rejects HTTP (including loopback), user information, query and fragment parts, shell syntax, escapes, and non-443 ports. The in-tree Tenantext package permits loopback HTTP, but the portable contract does not qualify local addresses. A different reviewed endpoint form needs a separate contract update. The URL is intended for a process-local `TENANTEXT_LITELLM_BASE_URL` assignment, **not** Pi settings interpolation. No resolved key enters the output.

### Python API

`render(overlay, registry, *, required_roles=(), credential_names=frozenset())` takes an in-memory validated overlay plus a synthetic registry shaped as `{provider: {model: [supportedThinkingLevels]}}`. It rechecks extension fields. The caller must still run `manifest(...)` and `overlay(...)` for the entire input. The registry is explicit mock capability evidence, not a live catalog or proof a route exists. Unsupported provider/model/thinking combinations fail with static `rule: field` diagnostics. The gateway path permits only the three aliases registered by pinned Tenantext: `litellm-codex` with `codex-auto/luna`, `codex-auto/sol`, or `codex-auto/astra`. Explicit `codex1/*` and `codex2/*` routes are not registered aliases. `openai-codex-2` requires Tenantext selection. Other native provider/model pairs need an explicit mock registry entry. A selected role or cycle model with a conflicting thinking level fails. Ambiguous combined `provider/model` settings keys and duplicate cycle models fail.

The returned JSON-compatible dictionary contains `settings`, `roles`, `cycle`, `roleStatus`, `requiredRoles`, `credentialNames`, `credentialStatus`, `setup`, and `availability: "unverified"`. `settings` is a contribution, not a complete Pi settings file. Only an interactive role sets `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`. An explicit nonempty `cycle` sets `enabledModels` in input order. Observed with Pi 0.99.1 and 0.87.1: Pi starts on the first enabled model before the saved default. A selected interactive role must therefore be the first cycle entry; any other order fails with `interactive_not_first_in_cycle` and is never reordered. Selected role and cycle thinking levels set `modelThinkingLevels` by exact combined key. Unset roles remain `null` in `roles`; a name in `required_roles` becomes `required_missing`, with no fallback. `credential_names` are presence signals only; `name_supplied_unverified` does not mean the value is valid. For a configured gateway, `credentialNames` includes `TENANTEXT_LITELLM_BASE_URL` and includes `TENANTEXT_LITELLM_API_KEY` only for environment-key auth. `setup` carries a safely quoted process-local base-URL assignment plus a symbolic key name or a `pi_login_blocked` status for the stored-key option. Native selections get provider-specific Pi login guidance, without credential data. Authentication, upstream availability, capability metadata accuracy, and runtime status remain unverified.

### Source-backed mappings

These mappings use Pi 0.99.1 source observations. The kit pin is `runtime.piVersion` in `config/manifest.json`. Not verified: these runtime behaviours on the kit pin.

| Choice | Source observed with Pi 0.99.1 | Native destination and limit |
| --- | --- | --- |
| Interactive provider/model/thinking | Pi `docs/settings.md`, `docs/models.md` | `settings.json` `defaultProvider`, `defaultModel`, `defaultThinkingLevel`; separate model ID stays intact. |
| Explicit cycle | Pi `docs/settings.md#model-cycling`, `docs/models.md` | `settings.json` `enabledModels` uses `provider/modelId` patterns for cycling. No cycle is emitted when absent. |
| Model thinking | Pi `docs/settings.md` "Model and thinking" | `settings.json` `modelThinkingLevels` uses exact `provider/modelId` keys. Joined keys are checked for ambiguity. |
| Direct native auth | Pi `docs/providers.md`, `docs/configuration.md`, `docs/models.md` | Fresh `/login` belongs to Pi; Pi stores any result in its own `auth.json`. This kit writes no auth file. |
| Tenantext source and resource scope | `packages/tenantext/package.json`; Pi `docs/packages.md` | One local-path package declaration per package, with the filter of each enabled component. No copied provider extension. The planner owns activation. |
| Gateway URL and key | Same Tenantext pin `extensions/codex-accounts/routing.ts`, `docs/codex-routing.md` | `gatewayConfig` reads `TENANTEXT_LITELLM_BASE_URL` and optionally `TENANTEXT_LITELLM_API_KEY` from the process environment. Its base URL includes the gateway API prefix, usually `/v1`. Pinned source allows a previously stored Pi API key for `litellm-codex` instead of the env key, but a fresh login cannot bootstrap provider registration. See the blocker below. |
| Gateway aliases | Same Tenantext pin `extensions/codex-accounts/routing.ts` | `registerGateway` registers `litellm-codex`, `openai-completions`, and `codex-auto/{luna,sol,astra}` only when configuration and catalog permit. This contract does not build `models.json` or assert availability. |

**Fresh-login blocker:** In `packages/tenantext`, `extensions/codex-accounts/routing.ts:31-45` returns no gateway configuration without an existing key. Its `registerGateway` at lines 117-126 then skips provider registration. Observed with Pi 0.99.1: `dist/modes/interactive/interactive-mode.js:4721-4750` lists login choices only from registered providers. Lines 4762-4788 resolve `/login litellm-codex` from that same list. Therefore URL-only fresh-profile login cannot expose `litellm-codex`. This is not merely unverified availability. The `auth: "login"` choice stays visible as blocked contract data with `pi_login_blocked`, not as a runnable instruction. The environment-key bootstrap is a distinct supported offline setup route; its real connectivity remains unverified. Do not create auth files or copy credentials to work around this blocker.

Tenantext `docs/codex-routing.md` keeps direct OAuth providers separate from the gateway bearer credential. Its quota `tokenFile` path belongs to the process that refreshes the OAuth token. The kit does not read or render it, transfer OAuth refresh state, start another process that refreshes the same OAuth token, or generate `auth.json`. Pi `docs/models.md` describes `models.json` interpolation and command-backed keys, but this contract does not use those features. A configured URL is a process-local instruction, not a claim that arbitrary Pi fields expand `${...}`.

### Rules for a caller

1. Run the whole overlay validator before `render`. Supply an explicitly reviewed mock/qualified registry, required downstream role names, and only credential *names*. Do not use installed host catalog data.
2. Merge only declared model settings keys into `profile_plan.prepare`; preserve `enabledModels` and `modelThinkingLevels`. Inert role choices must remain private metadata. Do not silently choose a paid model for required roles.
3. Handle the process-local base URL instruction safely in display-only CLI output. Never execute or persist a resolved key. Use the symbolic environment-key route only for fresh profiles. Surface `pi_login_blocked` as a readiness gap until the upstream bootstrap path is fixed and reviewed.
4. Declare each in-tree package once, as a local path with the filter of each enabled component. The gateway needs the `codex-accounts` component. Preserve the native TUI and all existing disabled-module rules. Keep startup, auth, and connectivity checks pending a clean-client test with explicit consent.

Offline tests in `tests/test_model_routes.py` use synthetic endpoints and mock capabilities only. Do not treat a pure renderer result as a launchable profile.
