# Memory modules

The optional memory modules are `hermes`, `wiki`, `openviking` and `agentcore`. Each one is one `pi install` line of [the optional modules](../INSTALL.md#optional-modules).
The npm packages are `pi-hermes-memory` and `@zosmaai/pi-llm-wiki`. They have no version in their `pi install` lines, so each line installs the newest registry version. `pi update --extensions` then moves an installed module to the newest registry version.
The in-tree memory packages are `packages/openviking-pi` and `packages/agentcore-pi`. Pi loads each one from its `index.ts` file in the clone.

A memory module stores or sends text of your sessions. Install one only after you agree to that. The kit writes no setting of a memory module: the module starts with the defaults of its package, and you change them in the profile as this page says. Not verified: live capture behaviour.

| Module | Stores | Sends | Model calls of its own |
| --- | --- | --- | --- |
| `hermes` | Session index and memory files under `<profile>` | Nothing | Yes with the package defaults; see [the Hermes config file](#the-hermes-config-file) |
| `wiki` | Pages and metadata in the personal vault `~/.llm-wiki/`, or `$WIKI_HOME/.llm-wiki/` | Recall text in each prompt to the model provider; with embeddings, page text to the embedding endpoint | Only for an ingest task, with the session model or `taskModel` |
| `openviking` | A pending queue and a recall ledger under `~/.openviking/` | Each turn to the OpenViking server; tool results only with `captureToolResults` | No |
| `agentcore` | Nothing | Each typed prompt to AWS for recall, and each proposal that the person confirms | No |

### The Hermes config file

Without `<profile>/hermes-memory-config.json`, the package defaults turn on review every 10 turns or 15 tool calls, correction detection, the flush on compaction and on shutdown, and auto-consolidation. Each of them makes model calls. This file keeps local capture only:

```json
{"reviewEnabled": false, "correctionDetection": false, "flushOnCompact": false, "flushOnShutdown": false, "memoryOverflowStrategy": "reject", "autoConsolidate": false}
```

Write the file with mode 600 before the first start with the module. Set a switch to `true` only when you accept the model calls.

### The wiki settings

The wiki reads the `llm-wiki` section of `<profile>/settings.json`. A quiet start for an existing vault:

```json
{"llm-wiki": {"ambientPersonalVault": false, "trajectories": false}}
```

With `ambientPersonalVault: true`, the package default, the extension creates the personal vault on the first session start and adds recall from it to each prompt, in each working directory.

## Hermes: what the pinned source does

Source: `pi-hermes-memory@0.9.11`, `src/config.ts`, `src/paths.ts`, `src/index.ts`, `src/handlers/pi-child-process.ts`, `src/tools/memory-search-tool.ts`.

Against 0.9.9, `config.ts` of 0.9.10 adds four keys with defaults: `consolidationChunking` (off), `consolidationChunkChars`, `usageHitTrackingEnabled` (on: it records a recall count for each entry in the SQLite store) and `consolidationUsageSignals`. The keys of [the Hermes config file](#the-hermes-config-file) did not change. Against 0.9.10, 0.9.11 leaves `config.ts` unchanged. Its memory subprocesses get only the three memory write tools (`--tools memory_add,memory_replace,memory_remove`) and no MCP tool (`--exclude-tools 'mcp__*'`). `src/index.ts` and the store files changed too. At start, the markdown sync reads only the global files and the current project. On Pi 0.86 and later, the memory context goes into `appendSystemPrompt`. The store adds two columns for the recall counts.

| Behaviour | Source fact | Note |
| --- | --- | --- |
| Config file | `loadConfig()` reads `<agent dir>/hermes-memory-config.json`; unknown keys are ignored, absent keys take defaults. The defaults enable review every 10 turns or 15 tool calls, correction detection, flush on compaction and shutdown, and auto-consolidation. | Write the file of [the Hermes config file](#the-hermes-config-file) to keep each background path off. That file does not set `usageHitTrackingEnabled`, so it stays on. It counts recalls only in the `memory_search` tool that the model calls. |
| Local capture | `message_end` schedules live session indexing into `<agent dir>/pi-hermes-memory/sessions.db`; `session_shutdown` indexes the finished session; `session_start` schedules a backfill of every file under `<agent dir>/sessions`, and `/memory-index-sessions` reads `PI_CODING_AGENT_SESSION_DIR` when set. No config switch disables this. Memory tools write `MEMORY.md`, `USER.md`, and `projects-memory/<project>/` under the agent directory. | Installing Hermes at all is local capture. A new profile has no sessions to backfill. |
| Storage scope | `AGENT_ROOT` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Memory, skills, the SQLite store, and project memory all live under it. Legacy migration only moves `<agent dir>/memory`, which a new profile does not have. | The stores belong to one profile. `projectsMemoryDir` must stay a single segment under the agent directory. |
| Direct review | `reviewTransport: "direct"` uses `ctx.modelRegistry` and the parent's auth. `llmModelOverride` selects the model by exact `provider/id`; unresolved overrides fall back to the active session model. | With review on, set `llmModelOverride` and `llmThinkingOverride` for the review model. |
| Subprocess review | The child runs `pi -p --no-session --model <override> --thinking <level> --no-extensions -e <own index.ts> -e <childExtensionPaths...> -e <detected auth adapters>`. It inherits the process environment, so `PI_CODING_AGENT_DIR` still selects the profile. | Observed with Pi 0.99.1: `--no-extensions` also drops built-in extensions (Pi `docs/settings.md`, Resources). A `llama.cpp` memory model needs `builtin:llama.cpp` in `childExtensionPaths`; a `litellm-codex`, gateway, or `openai-codex-2` model needs an absolute path, which the user points at the Tenantext `codex-accounts` extension of the clone. The kit does not check what the path names. |
| Native addon | The package uses the native module `better-sqlite3`. Observed with `better-sqlite3` 13.0.3 and npm 11.19.0 on Linux x64: the module holds a prebuilt binary, `prebuilds/linux-x64.node`. npm runs no install script, nothing is compiled, and the module loads from that file. Not verified: a prebuilt binary for macOS and for other platforms. Only when no prebuilt binary fits the platform and the Node version, a build from source needs a compiler toolchain. With npm 11, npm does not start that build on its own. Observed with npm 11.19.0: the `npm warn install-scripts` line of the `wiki` install names `better-sqlite3`, and npm runs no install script. Not verified: a build from source in a profile. | The kit does not check that the module loads on the host. |
| Peer warning | At 0.9.9 the package lists `@earendil-works/pi-tui` under `dependencies`. Observed at 0.9.11: the manifest lists it under `peerDependencies`, and the override script makes no change. | Run `scripts/patch_extension_peers.mjs` after the install; see `docs/host-peer-overrides.md`. |

Model cost when review is on: one completion per review trigger, per detected correction, per compaction and shutdown flush, and per consolidation run. The direct transport shares the parent's auth; the subprocess pays for a separate Pi start each time. Review off disables every automatic path. The user-invoked commands `/memory-consolidate`, `/memory-interview`, `/learn-memory-tool`, and `/memory-index-sessions` stay registered and can still call a model when the user runs them. An `llmModelOverride` that the registry cannot resolve falls back to the active session model (`review-memory-ops.ts`, `resolveReviewModels`), so an unavailable memory model does not stop review, it moves the cost to the interactive model.

## Wiki: what the pinned source does

Source: `@zosmaai/pi-llm-wiki@0.12.4`, `extensions/llm-wiki/index.ts`, `lib/task-config.ts`, `lib/utils.ts`.

The facts of this table were read in the source of 0.12.4. A comparison of the sources of 0.12.4 and 0.12.5 found two changes: the key `autoRecall`, and the system prompt of the subagent (`lib/subagent.ts`). The facts of [an existing vault](#an-existing-vault) were run at 0.12.5. Not verified: a newer version.

| Behaviour | Source fact | Note |
| --- | --- | --- |
| Settings key | `loadTaskConfig` reads the `llm-wiki` section of `<agent dir>/settings.json`, then the project `.pi/settings.json`, which wins. | Set the keys in the `llm-wiki` section of `<profile>/settings.json`. A trusted project's `.pi/settings.json` can set `ambientPersonalVault`, `trajectories`, or a task model above it; project trust is a start-time choice, and `--no-approve` does not grant it. |
| Vault resolution | `resolveVaultRoot(cwd)`: a `.llm-wiki/` in the working directory or a parent wins; otherwise the personal root, `WIKI_HOME` or the HOME directory. The personal vault is `<root>/.llm-wiki/`. | Not under the agent directory: each profile of the account shares the vault, unless `WIKI_HOME` moves it. |
| Ambient creation | On `session_start`, when `ambientPersonalVault` is true (the Pi default) and no vault exists, `bootstrapVault` silently creates the personal vault and `before_agent_start` injects recall on every turn in every directory. | Write `ambientPersonalVault` yourself to choose; see [the wiki settings](#the-wiki-settings). |
| Background model | `taskModel` selects the model for ingest and synthesis; unset means the session model. The installed 0.12.5 reader ignores `taskThinkingLevel`. | Set `taskModel` only when you accept background model calls. |
| Trajectories | Off unless `trajectories: true`; the capture tools are not registered when off. | Off by default. |
| Credentials | `taskModelApiKey`, `embeddingApiKey`, and their base URLs are settings fields. | Write no key value into the settings. For embeddings, use an environment reference or a fixed non-secret placeholder, as described below. |
| Resources | The package declares extensions, skills, prompts, and an MCP server. | A plain `pi install` line loads each resource that the package declares: the extension, the skill, the `/wiki-*` prompt commands and the MCP server declaration. To load only `extensions/llm-wiki/index.ts`, replace the package entry of `settings.json` with an object that has the filters `"extensions": ["extensions/llm-wiki/index.ts"]`, `"skills": []` and `"prompts": []`. With the reviewed Pi 1.1.0, a filter entry that names the directory `extensions` loads no extension of this package. |
| Peer warning | At 0.12.4 the package lists `@earendil-works/pi-tui` and `typebox` under `dependencies`. Observed at 0.12.5: the manifest lists them under `peerDependencies`, and the override script makes no change. | Run `scripts/patch_extension_peers.mjs` after the install. |
| Audit summary of npm | The `pi install` line of the package prints an audit summary of npm for its dependency tree: a count of vulnerabilities, a hint to run `npm audit fix`, and an `npm warn install-scripts` line. Observed with 0.12.5 and npm 11.19.0: 8 vulnerabilities, 3 high and 5 critical. The count changes with the versions in the registry. The install-scripts line names the packages whose install scripts npm did not run: 6 packages with `wiki` alone, and 7 packages when `hermes` is in the same profile. Not verified: a function of the package that needs one of these install scripts. | The kit did not review these findings: it reviewed the package, not its dependency tree. Do not run `npm audit fix` in the profile; see [the optional modules](../INSTALL.md#optional-modules). |

With `ambientPersonalVault: false`, no `WIKI_HOME`, and no project vault, nothing in the wiki writes without an agent tool call. Recall injection, the session notice, and the periodic reminder all pass through the same ambient gate, and a project vault or a trusted project settings file reopens it.

### An existing vault

The facts of this section are from `@zosmaai/pi-llm-wiki@0.12.5` with Pi 1.1.0. Not verified: the same package behavior with Pi 1.2.0 or the kit pin from `runtime.piVersion` in `config/manifest.json`. Source places are relative to `extensions/llm-wiki/`. Against 0.12.4, the source of 0.12.5 adds the key `autoRecall` and changes the system prompt of the subagent (`lib/subagent.ts`). The vault resolution, the bootstrap, the metadata and the embedding store are equal. Not verified: a newer version. After an install or an update of the package, compare the vault before and after the first start to prove the installed version: see [the vault check](#the-vault-check).

| Fact | Source | Proof |
| --- | --- | --- |
| The personal vault is `<root>/.llm-wiki/`. The root is `WIKI_HOME` when the variable is set and not empty, else the home directory. | `lib/utils.ts`, `getPersonalWikiRoot` | Start runs with a fixture vault. |
| The agent directory does not change the vault. A new profile of the same account uses an existing `~/.llm-wiki/` with no extra setting. | `lib/host.ts`: `PI_CODING_AGENT_DIR` selects the settings files only. | A profile with the extension loaded it and used the fixture vault of its home directory. |
| A `WIKI_HOME` of the launching shell that names another directory makes a second, new vault there at the first session start. This occurs with `ambientPersonalVault` `true` and `false`. The vault of the home directory stays unchanged and is not used. | `lib/utils.ts`, `resolveProjectVaultRoot` | A start with a launch line that does not remove the variable made `<WIKI_HOME>/.llm-wiki/`. |
| With an existing vault and `ambientPersonalVault: true`, a session start rewrites no file of the vault. It makes `meta/qmd/` when that directory is absent, and it makes and removes a lock below it. | `index.ts`, `lib/qmd-indexing.ts`, `recoverQmdIndex` | Start runs of a profile with the extension, with two fixture vaults: one with `knowledge_format: "okf-0.2"`, one with a `config.json` that has no `knowledge_format` and no `vault_id`. Each file kept its SHA-256 and its modification time. Only `meta/qmd/` was new, and only the time of `meta/` changed. |
| With an existing vault, `ambientPersonalVault: false` and no project vault, a session start writes nothing. | `index.ts`: the ambient gate | The same two fixture vaults: no file, no directory and no time changed. |
| The wiki tools use the personal vault with each value of `ambientPersonalVault`. The switch stops only the start notice, the reminder and the recall injection. | `lib/tools.ts`, `resolveVaultPaths` | A tool run with a stub model. Not verified: a tool run from a Pi profile. |
| With embeddings off, the extension reads `meta/embeddings.json` and never writes it. Recall is then keyword-only. | `lib/recall.ts`, `lib/embeddings.ts` | Tool runs with a stub model: the store kept its bytes and its time, and no embedding request left. |
| With embeddings on and a model label other than the label in the store, the next write tool embeds all pages again and overwrites the store. | `lib/embeddings.ts`, `reindexEmbeddings` | Tool runs with a stub model. |
| At a session start, with each setting, the extension moves an inner vault one level up when `<root>/.llm-wiki/.llm-wiki/config.json` exists. | `lib/utils.ts`, `migrateDoubledPersonalVault` | Not verified: no run; the code only. |
| With no vault and `ambientPersonalVault: true`, a session start makes the vault. With `false`, the start makes nothing; only `wiki_bootstrap` makes a vault. | `index.ts`, `lib/bootstrap.ts` | Start runs with an empty home directory. |

The start runs used RPC mode with no provider key, so no model call was possible. Not verified: a start in interactive mode; the handler is the same code.

Warning: a `WIKI_HOME` that differs from the place of the existing vault makes a second vault, and the existing vault stays unused. Start Pi with `env -u WIKI_HOME` when the shell exports the variable and you want the vault of the home directory.

Warning: embeddings with a model label other than the label in `meta/embeddings.json` make the next write tool send each page to the endpoint again and overwrite each stored vector. The write of the store is not atomic. To keep a store, leave the embedding settings off, or give the exact model label of the store.

Warning: the tool `wiki_bootstrap` with no `root` makes a project vault in the working directory. On an existing vault it rewrites `config.json` and `WIKI_SCHEMA.md`. Not verified: no run; the code only (`lib/tools.ts`, `lib/bootstrap.ts`).

#### A quiet setup for an existing vault

The setup that uses an existing vault with the smallest number of writes has `"ambientPersonalVault": false`, no `taskModel`, no `WIKI_HOME` and no embedding settings; see [the wiki settings](#the-wiki-settings). Then a session start writes nothing, and the wiki tools use the vault.

With `"ambientPersonalVault": true`, at 0.12.5 a session start changes no existing file of a vault and makes only `meta/qmd/`. The extension then injects recall from the vault into each prompt, in each working directory. With no vault, the first start makes one.

#### The vault check

Before the first start with the module, look for the vault. The commands open no file:

```sh
ls -ld "$HOME/.llm-wiki" "$HOME/.llm-wiki/config.json"
test -n "${WIKI_HOME:-}" && ls -ld "$WIKI_HOME/.llm-wiki"
```

A `.llm-wiki` directory with a `config.json` is an existing vault. When `WIKI_HOME` is set and names a root with no vault while the home directory has one, the first start makes a second vault. To prove that a start changed nothing, list the vault with sizes and modification times before and after the start, for example with `find "$HOME/.llm-wiki" -printf '%p %s %T@\n' | sort` on Linux, and compare the two lists.

#### Files that the extension writes in an existing vault

The kit writes none of these. The extension writes them at the given trigger. Paths are relative to `.llm-wiki/`.

| Path | Action | Trigger | Setting | Proof |
| --- | --- | --- | --- | --- |
| `meta/qmd/`, `meta/qmd/index.lock/owner.json` | Make the directory; make and remove the lock | Session start | The ambient gate is open: `ambientPersonalVault: true`, a project vault, or `WIKI_HOME` | Start runs |
| `meta/qmd/current`, `previous`, `staging-*`, `swap.json` | Rename, remove | A session start with a swap journal; each reindex | The ambient gate is open; each write tool | Not verified: the code only (`lib/qmd-indexing.ts`) |
| Inner `.llm-wiki/*` | Move one level up, remove the inner directory | Session start | Each | Not verified: the code only (`lib/utils.ts`) |
| `wiki/sources/obs-<date>-<slug>.md` | Make a new page | `wiki_observe` | Each | Tool runs with a stub model |
| Other new pages, `raw/sources/SRC-*/` | Make | `wiki_retro`, `wiki_ensure_page`, `wiki_ingest`, `wiki_capture_source` | Each; `taskModel` selects the ingest model | Not verified: the code only (`lib/retro.ts`, `lib/tools.ts`, `lib/source-packet.ts`) |
| `meta/events.jsonl` | Add one line | Each write tool, `wiki_log_event` | Each | Tool runs with a stub model |
| `meta/registry.json`, `meta/backlinks.json`, `meta/index.md`, `meta/log.md` | Write the whole file again (temporary file, then rename) | The reindex after each write tool or page edit; `wiki_rebuild_meta`; `wiki_lint` | Each | Tool runs with a stub model |
| `wiki/index.md`, `wiki/log.md`, `wiki/<folder>/index.md` | Write again or make; remove the `index.md` of a folder with no page | The same reindex | Only a vault with `knowledge_format: "okf-0.2"` | Tool runs with a stub model |
| `config.json` | Write again one time, to add `vault_id` | The first reindex of a vault with no `vault_id` | Each | Tool runs with a stub model |
| `config.json`, `WIKI_SCHEMA.md` | Write again | `wiki_bootstrap` on the vault | Each | Not verified: the code only (`lib/bootstrap.ts`) |
| `meta/qmd/manifest.json`, `meta/qmd/current/index.sqlite`, `index-state.json`, `meta/qmd/documents/**` | Make, update | The same reindex | Each | Tool runs with a stub model |
| `meta/embeddings.json` | Write the whole file again; the write is not atomic | The reindex after a write tool; `wiki_ingest`; `wiki_reindex_embeddings` | Only with `embeddingProvider` and a key | Tool runs with a stub model |
| `.discoveries/gaps.json`, a report in `outputs/`, repaired pages with backups | Make, write again | `wiki_lint`; a repair only with `auto_fix=true` | Each | Not verified: the code only (`lib/lint.ts`, `lib/legacy-repair.ts`) |
| `raw/trajectories/**`, `wiki/skills`, `wiki/cases` | Make | The trajectory tools | Only `trajectories: true`; off by default | Not verified: the code only |

A session end and a compaction wait for pending background tasks and write nothing of their own. The read tools `wiki_recall`, `wiki_search` and `wiki_status` write nothing. Each prompt with an open ambient gate reads `meta/registry.json`, the pages and the whole `meta/embeddings.json`.

Outside the vault: `/wiki-model` and `/wiki-trajectories` write `.pi/settings.json` of the working directory, and `/wiki-settings` can write the `settings.json` of the agent directory again. Not verified: no run; the code only (`lib/task-config.ts`).

#### Other settings keys

- `autoRecall`: with `false`, the extension injects no recall before a prompt. Without the key, the default of the package applies: recall is on when the ambient gate is open.
- `taskThinkingLevel`: the reviewed package version does not read it; no file of the package names it.
- Other keys of the section: `notices`, `semanticWeight`, `recallLinksThreshold`, `recallSkillInlineMax`, `synthesisLanguage`, `synthesisMaxTokens`, `wikilinkValidation`, `customTypes`, `taskModelBaseUrl`, `taskModelApiKey` and `taskModelApiKeyEnv`.

Not verified: a vault that two accounts of the operating system share, a vault that is a symbolic link, and a start of the extension with a vault that the account cannot write.

### Switch wiki embeddings off

Wiki embeddings can compete with OpenViking for the same local embedding listener.
The doctor warns when both use the same host and port, or when wiki embeddings run beside the enabled `openviking` module.
Different URL paths do not mean different services.

1. Back up the profile's `settings.json` and the project's `.pi/settings.json` before editing them.
2. Remove these four settings from the `llm-wiki` section in both files:

   - `embeddingProvider`
   - `embeddingBaseUrl`
   - `embeddingModel`
   - `embeddingApiKey` or `embeddingApiKeyEnv`; remove both if both exist.

3. Keep the other `llm-wiki` settings unchanged.
4. Restart running Pi sessions before checking the result.

Running sessions can keep old settings and in-flight work until restart. Do not rely on a settings edit to stop current requests.
The installed 0.12.5 package also reloads settings at some operation boundaries.
A blank or `null` project value does not erase a nonempty global value. Remove the keys from both scopes.
Without `embeddingProvider`, the wiki falls back to keyword search and makes no embedding requests.
The vector store at `.llm-wiki/meta/embeddings.json` can stay for a later re-enable. Do not delete the vault or its metadata.

See [Wiki embeddings](#wiki-embeddings) for the keys and the requests.

Run `/tenantext-doctor` in the restarted session. Both `wiki_embeddings_on` and `wiki_embeddings_shared_endpoint` should be absent.
The doctor only reads configuration for these diagnostics. It does not read credential fields, test authentication, send embedding requests, or apply a fix.
An info line means a provider is configured, not that authentication or the endpoint works.
The doctor compares every readable OV endpoint, including the server URL and `embedding.dense.api_base` when available.
A client without readable server configuration cannot prove that the services use separate embedding endpoints.

### Wiki embeddings

The embedding contract is re-read from the installed 0.12.5 package. Other source facts above retain their stated review version.
References here are relative to `extensions/llm-wiki/`.

| Source | Verified fact | Note |
| --- | --- | --- |
| `lib/task-config.ts`, `readNamespacedConfig` | The five keys are `embeddingProvider`, `embeddingModel`, `embeddingBaseUrl`, `embeddingApiKey`, and `embeddingApiKeyEnv`. The reader accepts trimmed nonempty strings under `llm-wiki`. Project settings override global settings. | Set the provider, the exact model, the base URL, and exactly one authentication key. |
| `lib/embeddings.ts`, `resolveEmbedder` | Only `openai` and `openai-compatible` resolve. An absent provider disables embeddings despite ambient credentials. | Use `openai-compatible` for a local or gateway endpoint. Without `embeddingProvider`, no embedding request leaves. |
| `lib/embeddings.ts`, `resolveEmbedder` | Direct key wins, then the named variable, defaulting to `OPENAI_API_KEY`. An empty result silently disables embeddings. | Prefer `embeddingApiKeyEnv` with the name of a variable. Write no key value into the settings. |
| `lib/embeddings.ts`, `createOpenAIEmbedFn` | Every request sends `Authorization: Bearer <key>`. | For an endpoint with no authentication, `embeddingApiKey: "no-auth-required"` is a fixed value, not a secret. It does not remove the header. |
| `lib/embeddings.ts`, `resolveEmbedder` | Missing model defaults to `text-embedding-3-small`. Missing base URL uses `OPENAI_BASE_URL`, then `https://api.openai.com`. | Set both keys, so the package does not use these fallbacks. |
| `lib/embeddings.ts`, `embeddingsRequestPath` | Root becomes `/v1/embeddings`. A path ending in `/v1` gains `/embeddings`; other prefixes gain `/v1/embeddings`. One trailing slash is removed first. | Do not append `/v1`. Query parameters are not forwarded by this upstream request builder. |
| `lib/embeddings.ts`, `embeddingStorePath` | The function fixes storage at `meta/embeddings.json`. Neither function name is a settings key. Requests contain only `model` and `input`. | No store path, request path, or dimension setting exists. The dimensions of the model stay unverified. |
| `lib/task-config.ts`, `TaskConfig` and `readNamespacedConfig` | Neither declares or reads `taskThinkingLevel`. | Setting `taskThinkingLevel` has no effect at this version. |

An example `llm-wiki` section for a gateway embedding route.
Use the model name exactly as the gateway names its route, not the upstream model name.

```json
{
  "llm-wiki": {
    "ambientPersonalVault": false,
    "trajectories": false,
    "embeddingProvider": "openai-compatible",
    "embeddingBaseUrl": "https://embeddings.example.invalid/v1",
    "embeddingModel": "example-embedding-route",
    "embeddingApiKeyEnv": "EXAMPLE_EMBEDDING_KEY"
  }
}
```

For example, Qwen3 on a local llama-swap listener can use these keys:

```json
{
  "embeddingProvider": "openai-compatible",
  "embeddingBaseUrl": "http://127.0.0.1:8080/v1",
  "embeddingModel": "qwen3-embedding",
  "embeddingApiKey": "no-auth-required"
}
```

Replace `8080` with the listener port and `qwen3-embedding` with its configured Qwen3 route name.
The URL form is `http://127.0.0.1:<port>/v1`.
Use no-auth only when the listener accepts the fixed `no-auth-required` bearer placeholder.
These examples create no gateway route, embedding listener, or model deployment.

### Disable embeddings without removing data

Remove the embedding keys as [Switch wiki embeddings off](#switch-wiki-embeddings-off) says.
The installed 0.12.5 package uses keyword-only recall when no embedder is configured, even with stored vectors.
The kit never opens or deletes wiki pages or `meta/embeddings.json`.
Trusted project settings can enable embeddings again; review those settings before a start.

After a start, write-time requests can send page titles, metadata, and up to 8000 body characters (`lib/embeddings.ts`, `buildEmbeddingText`).
Query-time requests can send search queries when stored vectors exist (`lib/recall.ts`, `searchWikiHybrid`).
Repeated queries use a cache. Missing vectors, missing authentication, or embedding failures retain keyword search.

Backfill uses the separately requested upstream `wiki_reindex_embeddings` tool. It can send existing pages and incur endpoint costs.
Endpoint compatibility, dimensions, input limits, backfill completion, and retrieval quality remain unverified.

Warning: HTTP sends page content, queries, and the bearer header without transport encryption.
Trust the selected service before you set an endpoint. A local endpoint can still forward content to another service.
Trusted project settings can override the endpoint and other wiki settings at a start.

## OpenViking: what the vendored source does

Source: `packages/openviking-pi`, vendored from a fork of OpenViking's `examples/pi-coding-agent-extension`. The banner of [the package README](../packages/openviking-pi/README.md) records the fork commit, the upstream merge base, the package version, the changed files, the behaviour changes and the licence scope. The kit copies nothing from outside `examples/`.

| Behaviour | Source fact | Note |
| --- | --- | --- |
| Settings | `loadConfig()` reads no file beside the extension. `shared/config-schema.mjs` declares each setting and resolves it in this order: an `OPENVIKING_*` variable, the workspace file `.openviking/config.json`, the `plugin.pi` section of `~/.openviking/ovcli.conf`, its `plugin` section, the default. | The kit writes no settings file for the module. To set `captureToolResults` or the recall time limit for one start, put `OPENVIKING_CAPTURE_TOOL_RESULTS=true` or `OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=<n>` in front of the start line. A variable is the first layer, so it wins over each file. |
| Capture | With `autoCapture` (default on), the extension sends each turn to the server session. Tool result output is sent only when `captureToolResults` is `true` (default `false`). Credential fields and bearer values in tool inputs and outputs are redacted in both states (`lib/capture-utils-local.mjs`). An `s` rule of `captureFilters` also rewrites tool inputs and outputs. A commit outside takeover archives every captured message (`keep_recent_count` 0), so `commitKeepRecentCount` has no effect there. | Installing the module at all is capture to a remote store. Keep `captureToolResults` off unless you accept the transfer of tool output. |
| Recall | Before each prompt the extension asks the server for memories of the caller through `viking://~/memories` and `viking://~/skills` and adds the result to the prompt. | `recallContextTimeoutMs` is an integer from 0 to 600000; 0 keeps the built-in default. |
| Resume | `loadLocalConfig()` keeps `resumeArchiveInject` on unless a settings layer or `OPENVIKING_RESUME_ARCHIVE_INJECT` sets it. With takeover off, the newest archive overview is added to the prompt after a resume or a compaction. | The upstream default is off. The kit keeps the behaviour of package version 0.4.9. |
| Context takeover | `loadLocalConfig()` keeps takeover off unless a settings layer or `OPENVIKING_TAKEOVER` turns it on. Takeover trims history only when the server confirms Working Memory for the commit (`effective_enable_working_memory`). | The kit sets nothing for it. Takeover stays off unless you turn it on. OpenViking server v0.5.0 and later send the confirmation; with an older server, Pi compaction stays. |
| Credentials | The endpoint, the key and the identity come from `OPENVIKING_*` variables, then `~/.openviking/ovcli.conf`, then `~/.openviking/ov.conf`. `OPENVIKING_CLI_CONFIG_FILE` and `OPENVIKING_CONFIG_FILE` move the two files. | The kit writes none of them and reads none of them. Set up the credentials before the first start. |
| Local state | The pending queue (`~/.openviking/pending/`), the recall ledger (`~/.openviking/pi-recall-ledger/`), the workspace registry and the logs are under `~/.openviking/`. | Not under the agent directory. Each profile of one user shares this state. |
| Tools | The extension registers the MCP tools of the server as `openviking_*` tools after a handshake. A failed handshake does not stop the start. | Do not point the `mcp` module at the same server: the tools would appear twice. |
| Dependency | `package.json` lists `@modelcontextprotocol/client` at an exact version, with a committed lock file. `node_modules/` is not in the tree. | Run `npm ci --ignore-scripts` in `<clone>/packages/openviking-pi` before the first start. |
| Server | The extension needs an OpenViking server with `viking://~` home alias support. | The kit starts no server and makes no request. |

A setting from an older version of the extension can exist as a `config.json` beside an installed copy. This version does not read that file. To keep a choice from it, move the value to the `plugin.pi` section of `~/.openviking/ovcli.conf`.

Cost of `captureToolResults: true`: each tool part goes to the server, capped at `captureToolMaxChars` characters (default 1000000), and the server stores larger output outside the session. Not measured: the growth of session storage and the effect on memory extraction. The `capture_cost_unmeasured` gap of the manifest names it.

The kit does not run the files under `packages/openviking-pi/scripts/`. `e2e-live.mjs` and `e2e-live.sh` need a live server, a Pi and a model. `setup.mjs` is a wizard that writes credentials to `~/.openviking/`.

### The load path

The `pi install` line of the module declares `<clone>/packages/openviking-pi/index.ts` as a local-file source in `settings.json` `packages`.
Pi 1.1.0 resolves a file source directly as one extension. It does not apply directory resource discovery or filters to that file.
The package stays at its kit path, so `npm ci` installs its dependencies beside the extension.
No wrapper, copied package, extra file or symbolic link is needed. Keep the clone in place.

`DefaultPackageManager.resolve()` in Pi 1.1.0 gave these results with isolated profiles:

| Form | Result | Choice |
| --- | --- | --- |
| Package directory `<clone>/packages/openviking-pi` | No extension. The package has neither a `pi` manifest nor an `extensions/` directory. | Rejected. Filters only narrow discovered resources. |
| Top-level `settings.json` `extensions` with the kit `index.ts` path | One enabled kit `index.ts`. | Rejected. It shares the top-level `extensions` list with the `-builtin:mcp` entry of the MCP adapter. |
| `<agentDir>/extensions/openviking.ts` linked to the kit `index.ts` | One enabled `extensions/openviking.ts`. | Rejected. It needs a link. |
| `packages` entry whose `source` is the kit `index.ts` file | One enabled kit `index.ts`. | Selected. `pi install` writes it, and the dependency location stays. |

A manifest inside the vendored package could expose the entry, but would break byte equality with the fork.
The extension still adds its bundled skills through `resources_discover` at run time.

### Refresh the vendored copy

`pi update --extensions` moves an installed npm source without a version, and the kit update pipeline (`docs/pi-update.md`) moves the Pi pin. They do not change `packages/openviking-pi`. A refresh is a manual step, until the kit has a command for it. `<openviking checkout>` is a clone of the OpenViking repository and `<commit>` is the reviewed commit:

```sh
work="$(mktemp -d)"
git -C '<openviking checkout>' archive '<commit>' examples agent-plugins | tar -x -C "$work"
(cd "$work" && node examples/memory-plugin-shared/sync.mjs)
```

`sync.mjs` writes `examples/pi-coding-agent-extension/shared/` from `examples/memory-plugin-shared/lib/`. It also writes the copies of the other plugins, so the archive holds the whole `examples/` and `agent-plugins/` trees; with less, the script stops with an error after it wrote `shared/`. The directory holds the files that the extension imports. The OpenViking repository does not track it for this extension, so the kit commits it: Pi loads the package from the kit directory and can only see the files that are there. Then copy `examples/pi-coding-agent-extension/` to `packages/openviking-pi/`, without `node_modules/`, and `examples/LICENSE` to `packages/openviking-pi/LICENSE`. Keep the kit-only README edits and the added `LICENSE` at a refresh. The README banner records the fork commit, upstream merge base, changed files, licence scope and upstream-only references. Update those facts in the banner. The README corrects links and shortens "Local fork: differences" because the kit loads the package by its path. `LICENSE` is the file from `examples/`. Preserve the kit's Pi 1.2.0 user-only recall guard in `index.ts`, lifecycle tests, user-event handshake fixtures, and local recall-test helper. Also preserve the `resumeArchiveInject` default in `loadLocalConfig()` and the two test stubs that the banner names. When the fork commit is older than the upstream commit to vendor, merge the two extension trees with their merge base, then regenerate `shared/` at the upstream commit. These files are no longer byte-equal to the fork commit; other extension files retain the imported source. Each generated `shared/` file matches the corresponding shared source with its generated-file header added. The capture-adapter fixture stays unchanged; the kit scanner permits its exact placeholder header value through a narrow content allowlist. Read `shared/config-schema.mjs` again: the two variable names and the bounds of `recallContextTimeoutMs` on this page must agree with it. Run `npm ci --ignore-scripts` in the package directory of each clone after a refresh.

## AgentCore Memory

`agentcore` connects Pi to the shared AgentCore Memory of several people.
OpenViking stays the primary memory. Nothing is converted or removed from either local store.
Recall sends the user prompt to AWS for semantic search. The propose tool sends the text of each proposal that the person confirms.
The design, the IAM rules and the security review are in [the shared memory security document](shared-memory-security.md).

The extension reads the person config file from `AGENTCORE_MEMORY_CONFIG_FILE`. Give an absolute path:
a relative path resolves against the directory where Pi starts, so a checkout could supply its own file.

The person config file holds the memory id, the region, the AWS profile, the actor id and the projects of one person.
Its fields are `MemoryConfig` in `packages/agentcore-memory-core/src/types.ts`. It holds no key.
The registry script of the owner renders the file, and the owner hands it over with the key.
Keep the file outside every repository.

### Start and setup

1. Run `npm ci --ignore-scripts` in `<clone>/packages/agentcore-memory-core`. The lock file of the core installs `@aws-sdk/client-bedrock-agentcore` at the exact version of its `package.json`. The extension package has no dependency of its own.
2. Run the `pi install` line of the module from [the optional modules](../INSTALL.md#optional-modules). It declares `<clone>/packages/agentcore-pi/index.ts`. The extension imports the shared core by a relative path, so keep the clone in place.
3. Start Pi with the config file:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR -u AGENTCORE_MEMORY_CONFIG AGENTCORE_MEMORY_CONFIG_FILE="$HOME/.config/agentcore-memory/config.json" PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi
   ```

`-u AGENTCORE_MEMORY_CONFIG` removes an inherited inline value: the core reads that value before the file, so an old shell export could replace the file.
`AGENTCORE_MEMORY_DISABLE` and `AGENTCORE_PROJECT` pass through. The first is the kill switch: with the value `1`, the extension registers nothing.
The second overrides the project of the working directory.
No key goes into a file of the kit. The SDK uses the AWS profile that the person config names, else its default credential chain.
The entry `agentcore` of `config/manifest.json` names the gaps of the module.

### Recall and propose

`before_agent_start` runs for a typed user prompt only. A custom-message start and an empty prompt send nothing.
The extension resolves the project of the Pi working directory: `AGENTCORE_PROJECT`, then the `origin` remote, then the configured directories.
The core sends one retrieval per namespace: `/shared/`, `/actor/<actorId>/` and, with a project, `/project/<projectId>/shared/`.
Recall never reads a proposals namespace or a rejected namespace.
The records form one hidden context message (`display: false`) with the heading `AgentCore Memory recall`.
A failed or timed-out call logs one static line and does not block the turn.
An `AGENTCORE_PROJECT` outside the memberships logs one static line per session. Recall then runs without a project.

The tool `agentcore_propose` takes `text` and an optional `projectId`. Without `projectId`, it resolves the project of the working directory.
The core writes one record into `/project/<projectId>/proposals/<actorId>/` only after the person confirms.
The confirmation dialog shows the target namespace as its title and the text as its message.
Without a dialog, for example in `pi -p`, Pi answers no and nothing is written.
A refusal returns a static code, for example `project_none`, `not_member`, `text_too_long` or `not_confirmed`.
A maintainer of the project reviews the proposal with the review CLI of the core. Only a maintainer moves it into the shared namespace.
The extension has no capture path: it sends no answer, tool output or turn text.
`session_shutdown` closes the core.

### One memory for each stage

A deployment that makes one memory for each stage, for example `dev` and `prod`, writes one config file for each person and stage.
Each file names its own memory and its own AWS profile.
Give the file of one stage in `AGENTCORE_MEMORY_CONFIG_FILE`.
A second stage is a second start line with the file of that stage, or a second profile; see [POST_INSTALL.md](../POST_INSTALL.md#add-a-second-profile).
Store the key under the profile name of the config file, in the shared credentials file.
The deployment names and owns the IAM users, so the registry script does not provision them.

Such a config can list each project by `projectId` and `role` only, without `remotes` and `directories`.
Then the working directory gives no project. Recall skips the shared records of the project, and a proposal without `projectId` returns `project_none`.
Set `AGENTCORE_PROJECT` in the shell that starts Pi. The start line passes it through.
Or add `remotes` or `directories` to the projects of the private config file.

### Owner steps

1. Provision the person with the registry script. See [provisioning a person](shared-memory-security.md#provisioning-a-person).
   The result is one IAM user, one inline policy and one person config file.
2. Hand over the key and the config file. See [key handoff](shared-memory-security.md#key-handoff).
3. The person saves the key in the AWS profile that the config names, and the file at the `configFile` path.
4. The person runs the steps of [Start and setup](#start-and-setup).

References: [AgentCore service authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html)
and [Memory API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/Welcome.html).

Warning: recall sends prompts to AWS, and propose sends the confirmed text. Keep sensitive material out unless the owner approves its transfer.

Not verified: live recall or propose, IAM enforcement, a Pi session with this package, and a clean-client installation of the core.

## Distill, review and submit

The owner review is a required gate. `--send` records the operator's decision to cross that gate.
The script does not inspect, distill, convert, or delete the local LLM Wiki or OpenViking stores.
Create candidates separately and remove anything the owner does not approve for AWS storage.

JSON input is a list of objects with exactly `source`, `namespace`, and `text`.
Markdown input uses one `## ` section per record, with this exact header order:

```markdown
# Reviewed candidates

## Example title
source: wiki://example/notes/convention
namespace: /shared/

The reviewed text starts after the blank line.

Another paragraph belongs to the same record.
```

A `## ` heading starts a new record, including inside quoted or fenced text. Do not use that form inside record text.
The optional preamble is only a `# ` title. The section title is not sent.
Each source must be a URI without credentials or whitespace. Each source occurs once in a candidate file.
The namespace must match an explicit `--namespace-allow` value exactly. Namespace templates are not allowed here.

A long record splits at paragraph borders into `<source>#part-<n>` ledger entries.
A single oversized paragraph is refused. Edit it into paragraphs before submitting.
A recorded source keeps its identity when its text changes. Use `--update` to change a recorded source.

1. Distill only the facts needed for recall into a private candidate file.
2. Have the owner review every source, namespace, and text.
3. Run the dry run and check its namespaces, counts, sizes, and text previews.
4. Run `--send` only after the owner approves the reviewed file and its destination.
5. Keep the private ledger for later skips and updates.

The tracked sample contains synthetic records:

```sh
python3 scripts/memory_submit.py --dry-run --memory-id mem-EXAMPLE --region us-east-1 --namespace-allow /shared/ config/memory-candidates.example.md
```

This prints one JSON batch. It sends nothing and writes nothing.
Dry run is also the default when neither mode flag is given.
Add `--namespace-allow /actor/alice/` for reviewed private records of one person, here the example person `alice`, with that exact namespace.
The submit identity writes only `/shared/` and `/actor/{actorId}/`; see [the global submit by the owner](shared-memory-security.md#global-submit-by-the-owner).
The one-time migration of the registry script moves the old records of `/owner/{actorId}/` to `/actor/{actorId}/` and deletes the test records.
A submit ledger entry of a moved record still names `/owner/{actorId}/`.
The script refuses that source with the namespace `/actor/{actorId}/`; use a new source URI.
Use the actual reviewed candidate file and memory identifier for a live run:

```sh
python3 scripts/memory_submit.py --send --memory-id mem-EXAMPLE --region us-east-1 --namespace-allow /shared/ --ledger .local/memory-submit-ledger.json .local/reviewed-candidates.md
```

The CLI needs an installed AWS CLI version with `batch-create-memory-records` and `batch-update-memory-records`.
Python uses only its standard library. No boto3 dependency is needed.
New records do not expire. Updates keep the existing expiry state.

The default ledger is `.local/memory-submit-ledger.json`, relative to the working directory.
It binds each source and part to its memory record, memory resource, region and namespace.
Use a separate ledger per resource and region. The script refuses paths in this repository outside `.local/`.
The ledger and request files have mode `0600`. Keep an external ledger in a private, untracked directory too.

A repeated run skips recorded parts. `--update` updates recorded parts and creates new parts.
A changed namespace or reduced part count stops for owner review. No old record is deleted automatically.
Partial failures save successful IDs and return exit code 2. The next run skips those successes.

The ledger journals each pending batch before sending. An uncertain response needs the same file, order and update mode for an exact retry.
Do not edit pending batches by hand. A stale `.lock` needs owner inspection before removal.
Only one sender may use a ledger at once.

Warning: dry-run output includes the start of each record. Pending ledger entries contain the full pending text.

Not verified: live AWS CLI output, service idempotency duration, record listing, or record updates.
The offline tests use fake subprocess responses and never invoke AWS.

## Test coverage

The offline tests of `packages/openviking-pi` and `packages/agentcore-pi` run in the package folders; see [the in-tree packages](packages.md). `scripts/pi_update.py qualify` runs the OpenViking tests and a resolver and factory-load check with the Pi of the qualification.

Historical evidence with Pi 1.1.0: a no-model start of a core and OpenViking profile confirms that Pi loads the extension and handles `/viking`.
The check uses an isolated HOME, `PI_OFFLINE=1`, an unreachable local endpoint and a 60-second limit, then quits with exit code 0.
The check types `/viking` after the start.
The terminal prints these lines:

```text
[Extensions] user <kit>/packages/openviking-pi
Warning: OpenViking: server not reachable
Warning: No models available. Use /login to log into a provider via OAuth or
Warning: OpenViking: not connected
```

The last warning is the response to `/viking`, not a model reply. It proves command registration without a server connection.

Not verified for `openviking`: a start of a profile against a live server, `npm ci` of the package on a clean client, and the effect of `captureToolResults` on storage. The offline Python suite does not run the vendored package tests. The separate qualifier uses `runtime.piVersion` in `config/manifest.json`. The package tests pass with the dependencies of the qualification, including offline SDK lifecycle tests. Its network-blocked resolver and factory-load check confirms registration without a live session. Not verified: the published `dependencies` of the two npm packages before peer overrides; see `docs/host-peer-overrides.md`. Not run: any Pi start with the Hermes package, a wiki tool call from a Pi profile, the `direct` or `subprocess` review against a fixture provider, and the peer override on a fresh install. Those stay `unverified`. The start runs of the wiki package are in [an existing vault](#an-existing-vault).
