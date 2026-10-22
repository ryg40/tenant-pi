# Provider guide: Codex, llama-swap and vLLM

This guide adds three providers to one Pi profile of the kit. Use each part that you need. No part needs a LiteLLM gateway: Pi connects to the provider directly.

| Provider | What it is | How Pi reaches it |
| --- | --- | --- |
| Codex | The hosted Codex models of a ChatGPT subscription. | A provider that Pi includes. You log in inside Pi. |
| llama-swap | A local proxy that starts and stops model servers. It serves an OpenAI-compatible API. | A provider that you register in `models.json` of the profile. |
| vLLM | A local or LAN inference server. It serves an OpenAI-compatible API. | A provider that you register in `models.json` of the profile. |

The kit runs none of these steps and writes no credential. `install.sh` writes a `models.json` with no provider. You do each step by hand, or an agent does it after you say yes.

## Words in this guide

- `<target>`: the profile directory of `PI_CODING_AGENT_DIR`. The examples use `"$HOME/.pi/profiles/main"`.
- `<pin>`: `runtime.piVersion` in `config/manifest.json`.
- Model alias: the name that the server uses for one model in its API. It is the `id` value in `GET /v1/models`.

## Rules

1. Work in `<target>` only. Do not edit `~/.pi/agent` or another profile.
2. Write no secret into a file. Name a credential by its environment variable.
3. Copy no `auth.json` and no login state between profiles.
4. Keep the real endpoint, the real model alias and the variable name in `<target>`. Do not put them into the clone. The examples here are synthetic.
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

1. Start the profile with the start line of [the first start](../../INSTALL.md#first-start).
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

A Codex login belongs to Pi and to one profile. The optional Tenantext gateway uses another credential: a gateway key in `TENANTEXT_LITELLM_API_KEY`. One does not replace the other. A profile can use the native login with no gateway. See [the first start](../../INSTALL.md#first-start) for the gateway key.

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

This is not the gateway rule. The `codex-accounts` extension of `packages/tenantext` accepts a gateway address with HTTPS, or with plain HTTP on a loopback address only, and with no user information, query or fragment.

Warning: plain HTTP sends the prompt, the reply and the key without encryption. Use it on the loopback address or on a network that you trust.

### Authentication

Ask the user: "Does the server need a key?"

- No key: Pi lists a custom model only when the provider has a key value. Give a placeholder such as `"apiKey": "none"`. The server ignores it.
- With a key: write a reference, `"apiKey": "$LLAMA_SWAP_API_KEY"`. Pi reads the variable from the environment of the process that starts Pi. The file then holds a name and no secret. Export the variable in the shell that starts Pi. See [the first start](../../INSTALL.md#first-start) for shells that do not inherit your variables.

Observed with Pi 1.0.4: a model whose key variable is not set is not in the output of `pi --list-models`. A provider with no `apiKey` field is not listed.

The variable name is your choice. Do not write the key value into `models.json`, a note or a command line.

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

Pi reads `models.json` from `<target>` only. `install.sh` writes it with no provider when it is absent.

1. Read the file that exists. Do not replace it without a read:

   ```sh
   cat "$HOME/.pi/profiles/main/models.json"
   ```

2. Add your provider key to its `providers` object and keep each other provider. One provider name can occur one time. The subshell keeps the `umask` of your shell unchanged:

   ```sh
   (umask 077 && "${EDITOR:-vi}" "$HOME/.pi/profiles/main/models.json")
   ```

Both providers of this guide can be in one file, as two keys of `providers`. A provider name of your own does not replace a provider that Pi includes. Do not use the name of a provider that Pi includes, such as `openai`, unless you want to change that provider.

Pi reads the file again when you open `/model`. A restart is not necessary.

## Select a registered model

Three ways give the same result. Each uses the provider name and the model alias as two separate values.

- For one command: add `--model 'llama-swap/local-chat'` to the start line.
- Inside Pi: open `/model`, select the model, and press `Ctrl+S` to save it as the default. Pi writes the default into `<target>/settings.json`.
- In `<target>/settings.json`: set `defaultProvider` and `defaultModel` yourself.

Use thinking `off` for a model without a thinking mode.

## Verify

Ask before each step. The first step sends no model request. The second step sends one small prompt to the provider.

1. The model is visible. Run this in the shell that has the key variable, when a key is in use:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --list-models local-chat
   ```

   Passed: one line with your provider name and your model alias, for example `llama-swap  local-chat`. Read the `context` and `max-out` columns: they show the metadata that Pi uses. `No models matching` means that the file did not load, the alias is different, or the key variable is not set. A text that starts with `Warning: errors loading models.json` names the wrong field.

2. The model replies. Send this fixed prompt and name the model:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --no-approve --model 'llama-swap/local-chat' -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"
   ```

   Passed: exit status 0, and the reply holds `43`. Record "Model replied" and "Reply matched".

3. The other providers are still there. Run `pi --list-models` with the same two assignments in front and no search word. Each provider that had a credential before is still in the list.

For Codex, run step 1 with `openai-codex` as the search word after the login, and step 2 with `--model 'openai-codex/<model>'`.

Record each step in your notes as passed, failed or not run, with the provider name and the model alias. Never record the key or the address of a private server in a file inside the clone. A step that did not run is "not run": write that the provider is unverified, never that it works.

## Problems

| Sign | Cause | What to do |
| --- | --- | --- |
| `No models matching` | The key variable is not set in this shell, the `apiKey` field is missing, or the alias is different. | Check the variable with `test -n "${LLAMA_SWAP_API_KEY:-}" && echo set`. Compare the `id` with `GET /v1/models`. |
| `Warning: errors loading models.json` | The file is not valid JSON, or a field has the wrong type. | Read the field path in the text. Correct the file. |
| An HTTP 404 error on the prompt | `baseUrl` has the wrong prefix. | Run the `curl` line of [the base path](#the-base-path). |
| An HTTP 401 or 403 error on the prompt | The key is wrong, or the server needs a key and the file has a placeholder. | Set the reference and export the variable. |
| A model-not-found error from the server | The `id` is not the served name. | Use the exact `id` of `GET /v1/models`. |
| The Codex model is not in the list | No login in this profile. | Run `/login` in this profile. A login of another profile does not count. |

Not verified: the exact error text of each server.

## Related guides

- [INSTALL.md](../../INSTALL.md): the install and the first start.
- [Module guide](modules.md): `codex-accounts` and the gateway.
- [POST_INSTALL.md](../../POST_INSTALL.md): the changes after the install.
- [Secret handling](../secret-handling.md): how the kit treats a credential.
