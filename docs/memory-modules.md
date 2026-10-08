# Memory templates with explicit activation consent

Status: offline implementation, not a qualified runtime. `scripts/memory_modules.py` is a pure module: no file, environment, subprocess, or network access. Validation, planning, and generation make zero model calls and zero network writes; the tests prove this with a blocked-socket, blocked-subprocess fixture. Not verified: live capture behaviour. Get explicit consent before a live capture test.

Three modules can be enabled: `hermes` (`pi-hermes-memory`), `wiki` (`@zosmaai/pi-llm-wiki`) and `openviking` (the vendored package `packages/openviking-pi`). The two npm modules are declared without a version, so the `pi install` line of the plan installs the newest registry version. `pi update --extensions` then moves an installed module to the newest registry version. The source facts below were read at `pi-hermes-memory@0.9.9` and `@zosmaai/pi-llm-wiki@0.12.4`; a newer version can change them. `openviking` is a copy of one reviewed commit inside the kit; see its section below. Enabling a module is a three-part explicit act: the selection, `consent.memoryCapture` and the `memory` choices. `openviking` also needs `consent.remoteMemoryWrites`, because each capture is a write to a server. The default example enables none of them and emits no memory extension. The install flow marks `hermes` and `wiki` in its checklist and asks for the consent with one sentence; the user keeps or removes each mark. See [INSTALL.md](../INSTALL.md#stage-5-the-private-overlay), Stage 5.

## Activation truth table

| Overlay state | Result |
| --- | --- |
| Module not in `selection.enable` | Nothing is emitted for it, whatever `consent` or `memory` says. A `memory.<module>` object for an unselected module fails with `memory_module_disabled`. |
| Module enabled, `consent.memoryCapture` false | `memory_consent_required`. Nothing is generated. |
| Module enabled, consent true, no `memory` block or `memory.<module>` is `null` | `memory_choices_required`. Nothing is generated. |
| `consent.memoryCapture` true with no memory module enabled | `memory_disabled`. Consent alone activates nothing. |
| `consent.remoteMemoryWrites` true without `openviking` in `selection.enable` | `remote_memory_disabled`. `hermes` and `wiki` write to no remote store. |
| `openviking` enabled, `consent.memoryCapture` true, `consent.remoteMemoryWrites` false | `remote_memory_consent_required`. Nothing is generated. |
| `consent.embeddingTextTransfer` true without selected `wiki` or a non-null `wiki.embedding` | `embedding_consent_unused`. Nothing is generated. |
| Non-null `wiki.embedding` without `consent.embeddingTextTransfer: true` | `embedding_consent_missing`. Capture consent does not grant embedding consent. |
| `wiki.embedding` omitted or `null`, embedding consent omitted or false | Embeddings stay off. Old overlays remain valid, even with ambient endpoint and credential variables. |
| Module enabled, consent true, explicit choices | The package declaration, its settings or config file, and readiness gaps are emitted as the tables below say. |

A configured credential name, an endpoint, or a reachable service never enables capture. Wiki embeddings require their own explicit choices and text-transfer consent.

## Overlay block

```json
{
  "memory": {
    "schemaVersion": 1,
    "hermes": {"backgroundReview": false},
    "wiki": {"ambientPersonalVault": false, "backgroundTasks": false},
    "openviking": null
  }
}
```

| Field | Values | Effect |
| --- | --- | --- |
| `hermes.backgroundReview` | `false` | Local capture only: session indexing and agent-called memory tools. Every path that makes a model call from Hermes is off. |
| `hermes.backgroundReview` | `true` | Background review, correction detection, compaction and shutdown flush, and automatic consolidation are on. Requires `roles.memory`. |
| `hermes.reviewTransport` | `direct`, `subprocess` | Required when review is on, forbidden when it is off. `direct` uses the parent session's model registry in process; Hermes falls back to a `pi -p` subprocess when the direct path fails. `subprocess` forces the child process. |
| `hermes.childExtensionPaths` | absolute paths or `builtin:<name>` | Extension sources the child `pi -p` process must load. Only allowed when review is on. The validator checks the form and the presence of a path, not that a path names the right extension. |
| `wiki.ambientPersonalVault` | boolean | `true` lets the extension create `~/.llm-wiki/` on the first session start and inject recall in every directory. `false` keeps the extension quiet until a project vault exists or a tool is called. |
| `wiki.backgroundTasks` | boolean | `true` sets the wiki background task model from `roles.memory`. `false` leaves the wiki on the session model when the agent invokes an ingest tool. |
| `wiki.wikiHome` | absolute path | Optional, and only with `ambientPersonalVault: true`. Moves the personal vault to `<wikiHome>/.llm-wiki/` through a process-local `WIKI_HOME` assignment on the launch line. At this pin `resolveProjectVaultRoot` treats `WIKI_HOME` as the project's own vault, so every ambient surface fires wherever Pi starts; a quiet wiki with a relocated vault is not possible, and the validator fails `wiki_home_is_ambient`. Without `wikiHome`, the launch line removes an inherited `WIKI_HOME`, so the vault is the one of the home directory. Do not set `wikiHome` to use an existing `~/.llm-wiki/`; see [an existing vault](#an-existing-vault). |
| `wiki.embedding` | object or `null` | Optional. Omitted or `null` disables embeddings. An object requires selection, capture consent, and `consent.embeddingTextTransfer: true`. |
| `wiki.embedding.provider` | `openai-compatible` | Required. The user selects the protocol explicitly. The kit selects no service. |
| `wiki.embedding.baseUrl` | HTTP(S) URL | Required. Emitted unchanged as `embeddingBaseUrl`. Credentials, fragments, underscore host labels, Unicode IDN hosts, and encoded `%23` fail validation. The seven rejected query names are `key`, `token`, `api_key`, `apikey`, `secret`, `password`, `authorization` (case-insensitive). This list is not a complete credential detector; never put credentials in a URL. |
| `wiki.embedding.model` | nonempty model identifier without whitespace | Required. Emitted unchanged as `embeddingModel`. No model default is selected. |
| `wiki.embedding.auth` | `{"envVar": "EXAMPLE_EMBEDDING_KEY"}` or `{"mode": "none"}` | Required. Exactly one form. The variable name emits `embeddingApiKeyEnv`; no-auth emits only the documented placeholder in `embeddingApiKey`. |
| `wiki.embedding.expectedDimensions` | positive integer | Optional. Stored in the private overlay and activation record for later verification. Never emitted as an upstream setting. |
| `consent.embeddingTextTransfer` | boolean | Optional, beside the three existing consent fields. Permits page content and search queries to reach the selected embedding endpoint. |
| `openviking.captureToolResults` | boolean | Required. `true` lets the extension send the output of each tool call to the server with the turn. `false` sends the turn without tool result output. The launch line carries the value in both states. |
| `openviking.recallContextTimeoutMs` | integer, 0 to 600000 | Optional. The time limit of one context recall request in milliseconds. `0` keeps the built-in default of the extension. Without the field, the launch line has no value for it. |

`roles.memory` is the one model choice that `hermes` and `wiki` share. `openviking` uses no role. With `modelRoutes` it is checked against the explicit registry like any other role. Without a registry, the model and its authentication remain `unverified`.

Not verified: the Pi 0.99.1 behaviour described below with the kit pin in `config/manifest.json`, key `runtime.piVersion`.

## Hermes: what the pinned source does

Source: `pi-hermes-memory@0.9.9`, `src/config.ts`, `src/paths.ts`, `src/index.ts`, `src/handlers/pi-child-process.ts`.

| Behaviour | Source fact | Kit handling |
| --- | --- | --- |
| Config file | `loadConfig()` reads `<agent dir>/hermes-memory-config.json`; unknown keys are ignored, absent keys take defaults. The defaults enable review every 10 turns or 15 tool calls, correction detection, flush on compaction and shutdown, and auto-consolidation. | The kit writes the whole file as a fourth profile output, mode `0600`. Every background switch is set explicitly in both states, so a package default cannot re-enable a path. |
| Local capture | `message_end` schedules live session indexing into `<agent dir>/pi-hermes-memory/sessions.db`; `session_shutdown` indexes the finished session; `session_start` schedules a backfill of every file under `<agent dir>/sessions`, and `/memory-index-sessions` reads `PI_CODING_AGENT_SESSION_DIR` when set. No config switch disables this. Memory tools write `MEMORY.md`, `USER.md`, and `projects-memory/<project>/` under the agent directory. | Enabling Hermes at all is local capture. It requires `consent.memoryCapture`. A fresh candidate has no sessions to backfill; the `session_backfill_scope_unverified` gap reminds the user to launch without an ambient `PI_CODING_AGENT_SESSION_DIR`, since the kit cannot see the launch environment. The launch line removes the variable (`env -u`, see [the launcher file](launcher.md)); a manual `pi` command does not. |
| Storage scope | `AGENT_ROOT` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Memory, skills, the SQLite store, and project memory all live under it. Legacy migration only moves `<agent dir>/memory`, which a fresh candidate does not have. | Stores are candidate-scoped. `projectsMemoryDir` must stay a single segment under the agent directory. |
| Direct review | `reviewTransport: "direct"` uses `ctx.modelRegistry` and the parent's auth. `llmModelOverride` selects the model by exact `provider/id`; unresolved overrides fall back to the active session model. | The kit sets `llmModelOverride` and `llmThinkingOverride` from `roles.memory`. |
| Subprocess review | The child runs `pi -p --no-session --model <override> --thinking <level> --no-extensions -e <own index.ts> -e <childExtensionPaths...> -e <detected auth adapters>`. It inherits the process environment, so `PI_CODING_AGENT_DIR` still selects the candidate. | Observed with Pi 0.99.1: `--no-extensions` also drops built-in extensions (Pi `docs/settings.md`, Resources). A `llama.cpp` memory model needs `builtin:llama.cpp` in `childExtensionPaths`; a `litellm-codex`, gateway, or `openai-codex-2` model needs an absolute path, which the user points at the Tenantext `codex-accounts` extension inside the candidate's installed package. The validator fails `missing_child_provider` when no source of the needed kind is present; it does not check what the path names. The path itself is `child_provider_unverified`. |
| Native addon | `better-sqlite3` is compiled for the Node that runs Pi. | `native_addon_unverified` gap. |
| Peer warning | The package lists `@earendil-works/pi-tui` under `dependencies`. | `peer_override_required` gap and the display-only `patch_extension_peers.mjs` setup line; see `docs/host-peer-overrides.md`. |

Model cost when review is on: one completion per review trigger, per detected correction, per compaction and shutdown flush, and per consolidation run. The direct transport shares the parent's auth; the subprocess pays for a separate Pi start each time. Review off disables every automatic path. The user-invoked commands `/memory-consolidate`, `/memory-interview`, `/learn-memory-tool`, and `/memory-index-sessions` stay registered and can still call a model when the user runs them. An `llmModelOverride` that the registry cannot resolve falls back to the active session model (`review-memory-ops.ts`, `resolveReviewModels`), so an unavailable memory model does not stop review, it moves the cost to the interactive model.

## Wiki: what the pinned source does

Source: `@zosmaai/pi-llm-wiki@0.12.4`, `extensions/llm-wiki/index.ts`, `lib/task-config.ts`, `lib/utils.ts`.

The facts of this table were read in the source of 0.12.4. A comparison of the sources of 0.12.4 and 0.12.5 found two changes: the key `autoRecall`, and the system prompt of the subagent (`lib/subagent.ts`). The facts of [an existing vault](#an-existing-vault) were run at 0.12.5. Not verified: a newer version.

| Behaviour | Source fact | Kit handling |
| --- | --- | --- |
| Settings key | `loadTaskConfig` reads the `llm-wiki` section of `<agent dir>/settings.json`, then the project `.pi/settings.json`, which wins. | The kit owns `/llm-wiki` in the candidate's `settings.json` only. A trusted project's `.pi/settings.json` can set `ambientPersonalVault`, `trajectories`, or a task model above it; project trust is a launch-time choice outside the kit, and `--no-approve` does not grant it. |
| Vault resolution | `resolveVaultRoot(cwd)`: a `.llm-wiki/` in the working directory or a parent wins; otherwise the personal root, `WIKI_HOME` or the HOME directory. The personal vault is `<root>/.llm-wiki/`. | Not under the agent directory. The `shared_home_state` gap names this unless `wikiHome` is set. |
| Ambient creation | On `session_start`, when `ambientPersonalVault` is true (the Pi default) and no vault exists, `bootstrapVault` silently creates the personal vault and `before_agent_start` injects recall on every turn in every directory. | The kit always writes `ambientPersonalVault` explicitly. The example block above has `false`; the install flow writes `true`. |
| Background model | `taskModel` selects the model for ingest and synthesis; unset means the session model. The installed 0.12.5 reader ignores `taskThinkingLevel`. | Existing emission from `roles.memory` stays unchanged. The kit still restricts thinking to `low`, `medium`, `high`, `xhigh`. This source gap is not runtime qualification. |
| Trajectories | Off unless `trajectories: true`; the capture tools are not registered when off. | The kit writes `trajectories: false`. |
| Credentials | `taskModelApiKey`, `embeddingApiKey`, and their base URLs are settings fields. | No chat credential is written. Embeddings use an environment reference or a fixed non-secret placeholder, as described below. |
| Resources | The package declares extensions, skills, prompts, and an MCP server. | Only the extension file `extensions/llm-wiki/index.ts` loads. The filter entry names the file: with the Pi version of the kit pin, an entry that names the directory `extensions` loads no extension of this package. The `/wiki-*` prompt commands and the skill are filtered out; widening the filter is a manifest review, not an overlay choice. |
| Peer warning | The package lists `@earendil-works/pi-tui` and `typebox` under `dependencies`. | `peer_override_required` gap and setup line. |

With `ambientPersonalVault: false`, no `WIKI_HOME`, and no project vault, nothing in the wiki writes without an agent tool call. Recall injection, the session notice, and the periodic reminder all pass through the same ambient gate, and a project vault or a trusted project settings file reopens it.

### An existing vault

The facts of this section are from `@zosmaai/pi-llm-wiki@0.12.5` with the Pi version of the kit pin. Source places are relative to `extensions/llm-wiki/`. Against 0.12.4, the source of 0.12.5 adds the key `autoRecall` and changes the system prompt of the subagent (`lib/subagent.ts`). The vault resolution, the bootstrap, the metadata and the embedding store are equal. Not verified: a newer version. After an install or an update of the package, the vault check of the install flow is the proof for the installed version.

The rule of the kit: an established vault of the user is used as it is. The kit makes no second vault. It refuses a target, a launcher file, a results directory or a results target, a baseline file, a private directory and a Compose directory that is a vault or is below one, with `under_wiki_vault`. The vaults are `.llm-wiki` in the home directory, `<WIKI_HOME>/.llm-wiki`, and, for an action that reads the overlay, `<wikiHome>/.llm-wiki` of `memory.wiki.wikiHome`. `baseline` and `init-private` read no overlay, so they know the first two only.

| Fact | Source | Proof |
| --- | --- | --- |
| The personal vault is `<root>/.llm-wiki/`. The root is `WIKI_HOME` when the variable is set and not empty, else the home directory. | `lib/utils.ts`, `getPersonalWikiRoot` | Start runs with a fixture vault. |
| The agent directory does not change the vault. A new profile of the same account uses an existing `~/.llm-wiki/` with no extra setting. | `lib/host.ts`: `PI_CODING_AGENT_DIR` selects the settings files only. | A profile that the kit generated loaded the extension and used the fixture vault of its home directory. |
| A `WIKI_HOME` of the launching shell that names another directory makes a second, new vault there at the first session start. This occurs with `ambientPersonalVault` `true` and `false`. The vault of the home directory stays unchanged and is not used. | `lib/utils.ts`, `resolveProjectVaultRoot` | A start with a launch line that does not remove the variable made `<WIKI_HOME>/.llm-wiki/`. |
| With an existing vault and `ambientPersonalVault: true`, a session start rewrites no file of the vault. It makes `meta/qmd/` when that directory is absent, and it makes and removes a lock below it. | `index.ts`, `lib/qmd-indexing.ts`, `recoverQmdIndex` | Start runs of a profile that the kit generated, with two fixture vaults: one with `knowledge_format: "okf-0.2"`, one with a `config.json` that has no `knowledge_format` and no `vault_id`. Each file kept its SHA-256 and its modification time. Only `meta/qmd/` was new, and only the time of `meta/` changed. |
| With an existing vault, `ambientPersonalVault: false` and no project vault, a session start writes nothing. | `index.ts`: the ambient gate | The same two fixture vaults: no file, no directory and no time changed. |
| The wiki tools use the personal vault with each value of `ambientPersonalVault`. The switch stops only the start notice, the reminder and the recall injection. | `lib/tools.ts`, `resolveVaultPaths` | A tool run with a stub model. Not verified: a tool run from a profile that the kit generated. |
| With embeddings off, the extension reads `meta/embeddings.json` and never writes it. Recall is then keyword-only. | `lib/recall.ts`, `lib/embeddings.ts` | Tool runs with a stub model: the store kept its bytes and its time, and no embedding request left. |
| With embeddings on and a model label other than the label in the store, the next write tool embeds all pages again and overwrites the store. | `lib/embeddings.ts`, `reindexEmbeddings` | Tool runs with a stub model. |
| At a session start, with each setting, the extension moves an inner vault one level up when `<root>/.llm-wiki/.llm-wiki/config.json` exists. | `lib/utils.ts`, `migrateDoubledPersonalVault` | Not verified: no run; the code only. |
| With no vault and `ambientPersonalVault: true`, a session start makes the vault. With `false`, the start makes nothing; only `wiki_bootstrap` makes a vault. | `index.ts`, `lib/bootstrap.ts` | Start runs with an empty home directory. |

The start runs used RPC mode with no provider key, so no model call was possible. Not verified: a start in interactive mode; the handler is the same code.

Warning: a `WIKI_HOME` that differs from the place of the existing vault makes a second vault, and the existing vault stays unused. The launch line of a wiki profile with no `wikiHome` removes an inherited `WIKI_HOME`. A `wikiHome` in the overlay, or a manual `pi` command in a shell that exports the variable, still moves the vault.

Warning: embeddings with a model label other than the label in `meta/embeddings.json` make the next write tool send each page to the endpoint again and overwrite each stored vector. The write of the store is not atomic. To keep a store, leave `memory.wiki.embedding` off, or give the exact model label of the store.

Warning: the tool `wiki_bootstrap` with no `root` makes a project vault in the working directory. On an existing vault it rewrites `config.json` and `WIKI_SCHEMA.md`. Not verified: no run; the code only (`lib/tools.ts`, `lib/bootstrap.ts`).

#### What the kit does for an existing vault

- The overlay is the one source of the vault place. With no `memory.wiki.wikiHome`, the vault is `~/.llm-wiki/`, and the launch line removes an inherited `WIKI_HOME`. With `wikiHome`, the vault is `<wikiHome>/.llm-wiki/`.
- The profile target, the launcher file, the `--out` file of `baseline`, the private directory of `init-private`, the private directory of `compose-plan --write` and the `--out-dir` directory of `results` are refused with `under_wiki_vault` when they are `<home>/.llm-wiki` or are under it. With `WIKI_HOME` set, the same rule covers `<WIKI_HOME>/.llm-wiki`. Trailing `/` characters of `WIKI_HOME` do not count. The rule compares path text, and each root counts as written and with its links resolved.
- An action that reads an overlay also knows the vault of that overlay. With `memory.wiki.wikiHome`, the same rule covers `<wikiHome>/.llm-wiki` for the profile target of `validate`, `plan` and `generate`, for the launcher file, and for the `--out-dir` directory and each `--target` of `results` with `--overlay`. `compose-plan --write` applies the rule to the overlay of its plan; that overlay has no `wikiHome`.
- `baseline` and `init-private` have no overlay of a profile. They know the vault of the home directory and the vault of `WIKI_HOME` only. Limit: they do not refuse a place below the vault of a `wikiHome` that only an overlay names.
- `validate`, `plan` and `generate` open no file of a vault. `results` refuses a `--target` that is a vault or is under one, with `under_wiki_vault: results.target`, before it opens a file of the target. `baseline` on a vault opens its directories to list them and opens no file.
- The action `check-wiki-vault` reports the vault before a profile is generated.

The profile that uses an existing vault with the smallest number of writes has `"ambientPersonalVault": false`, `"backgroundTasks": false`, no `wikiHome` and no `embedding`. Then a session start writes nothing, and the wiki tools use the vault. This is the quiet form.

The install flow writes `"ambientPersonalVault": true` for a vault that exists and for no vault. At 0.12.5, a session start then changes no existing file of a vault and makes only `meta/qmd/`. The extension then injects recall from the vault into each prompt, in each working directory. With no vault, the first start makes one. The flow sets no `embedding`. It sets `wikiHome` only when `WIKI_HOME` is set in the environment of the user, and not for the result `second_vault`: [INSTALL.md](../INSTALL.md#the-llm-wiki-vault) has the table. The flow records a baseline of the vault before the first Pi command and compares it after the first launch.

#### The vault check

```sh
python3 scripts/tenant_pi.py check-wiki-vault
```

The action has no option. It reads `HOME`, and `WIKI_HOME` when that variable is set and not empty. It uses `lstat` calls only. It opens no file and no directory, it lists nothing, and it writes nothing. It starts no process.

One JSON object on standard output, here for a home directory with a vault and no `WIKI_HOME`:

```json
{"home":{"config":true,"doubled":false,"embeddings":{"exists":true,"size":1048576},"exists":true,"kind":"directory","ownedByUser":true,"root":"/home/EXAMPLE_USER","vault":"/home/EXAMPLE_USER/.llm-wiki"},"personalVault":"home","result":"vault_exists","wikiHome":null}
```

| Key | Value |
| --- | --- |
| `home` | The facts of `<HOME>/.llm-wiki`. |
| `wikiHome` | The facts of `<WIKI_HOME>/.llm-wiki`, or `null` when the variable is not set or is empty. |
| `personalVault` | `wikiHome` when the variable is set, else `home`: the vault that the extension uses as the personal vault. |
| `result` | `vault_exists`: the personal vault is there. `no_vault`: no vault is at either root. `second_vault`: `WIKI_HOME` names a root with no vault, and the home directory has a vault; a session start then makes a second vault. |
| `root`, `vault` | The root and the vault directory, as text. |
| `kind` | `directory`, `symlink`, `other` (for example a file), `absent`, or `unreadable` when the system refuses the call. |
| `exists` | `true` for `directory` and `symlink`. The keys below are then measured; else they are `false` or `null`. |
| `config` | Whether `<vault>/config.json` is there. The extension makes no new vault in a directory that has no `config.json`; it reports a blocked setup. |
| `doubled` | Whether `<vault>/.llm-wiki/config.json` is there: the layout that the extension moves at a session start. |
| `embeddings` | Whether `<vault>/meta/embeddings.json` is there, and its `size` in bytes when it is a regular file. |
| `ownedByUser` | Whether the owner of the vault directory is the user that runs the action. For a `symlink`, this is the owner of the link. |

The exit code is 0 for each result. A `WIKI_HOME` with trailing `/` characters names the same root as the value without them. A `HOME` or a `WIKI_HOME` that is not an absolute path gives exit code 2, with `home_required: check-wiki-vault.home`, `absolute_path: check-wiki-vault.home` or `absolute_path: check-wiki-vault.wiki_home` on standard error. The report shows no content of a vault. It shows the paths of the two roots.

Limits: the action does not read `config.json`, so it does not know the format of the vault. It does not find a project vault of a working directory. It does not read the `llm-wiki` settings of a profile. A vault of another account is outside the action.

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
| `raw/trajectories/**`, `wiki/skills`, `wiki/cases` | Make | The trajectory tools | Only `trajectories: true`; the kit writes `false` | Not verified: the code only |

A session end and a compaction wait for pending background tasks and write nothing of their own. The read tools `wiki_recall`, `wiki_search` and `wiki_status` write nothing. Each prompt with an open ambient gate reads `meta/registry.json`, the pages and the whole `meta/embeddings.json`.

Outside the vault: `/wiki-model` and `/wiki-trajectories` write `.pi/settings.json` of the working directory, and `/wiki-settings` can write the `settings.json` of the agent directory again. Not verified: no run; the code only (`lib/task-config.ts`).

#### Settings keys that the kit does not emit or that the package does not read

- `autoRecall`: with `false`, the extension injects no recall before a prompt. The kit does not emit this key, so the default of the package applies: recall is on when the ambient gate is open.
- `taskThinkingLevel`: the kit emits this key with `backgroundTasks: true`. The reviewed package version does not read it; no file of the package names it.
- The kit also does not emit `notices`, `semanticWeight`, `recallLinksThreshold`, `recallSkillInlineMax`, `synthesisLanguage`, `synthesisMaxTokens`, `wikilinkValidation`, `customTypes`, `taskModelBaseUrl`, `taskModelApiKey` and `taskModelApiKeyEnv`.

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

For a kit overlay, omit `memory.wiki.embedding` or set it to `null`.
Remove `consent.embeddingTextTransfer` or set it to `false`, then generate a fresh candidate.
Generation does not edit an existing profile or the project's settings.
See [Wiki embeddings](#wiki-embeddings) for the opt-in contract.

Run `/tenantext-doctor` in the restarted session. Both `wiki_embeddings_on` and `wiki_embeddings_shared_endpoint` should be absent.
The doctor only reads configuration for these diagnostics. It does not read credential fields, test authentication, send embedding requests, or apply a fix.
An info line means a provider is configured, not that authentication or the endpoint works.
The doctor compares every readable OV endpoint, including the server URL and `embedding.dense.api_base` when available.
A client without readable server configuration cannot prove that the services use separate embedding endpoints.

### Wiki embeddings

The embedding contract is re-read from the installed 0.12.5 package. Other source facts above retain their stated review version.
References here are relative to `extensions/llm-wiki/`.

| Source | Verified fact | Kit mapping |
| --- | --- | --- |
| `lib/task-config.ts`, `readNamespacedConfig` | The five keys are `embeddingProvider`, `embeddingModel`, `embeddingBaseUrl`, `embeddingApiKey`, and `embeddingApiKeyEnv`. The reader accepts trimmed nonempty strings under `llm-wiki`. Project settings override global settings. | Emit provider, exact model, unchanged base URL, and exactly one authentication key. Existing `/llm-wiki` ownership and resource filters stay unchanged. |
| `lib/embeddings.ts`, `resolveEmbedder` | Only `openai` and `openai-compatible` resolve. An absent provider disables embeddings despite ambient credentials. | Accept the explicit `openai-compatible` choice. Omission or `null` emits no embedding settings. |
| `lib/embeddings.ts`, `resolveEmbedder` | Direct key wins, then the named variable, defaulting to `OPENAI_API_KEY`. An empty result silently disables embeddings. | `auth.envVar` maps to `embeddingApiKeyEnv`. The kit never reads the variable value. |
| `lib/embeddings.ts`, `createOpenAIEmbedFn` | Every request sends `Authorization: Bearer <key>`. | `auth.mode: "none"` maps to `embeddingApiKey: "no-auth-required"`. This fixed value is not a secret. It does not remove the header. |
| `lib/embeddings.ts`, `resolveEmbedder` | Missing model defaults to `text-embedding-3-small`. Missing base URL uses `OPENAI_BASE_URL`, then `https://api.openai.com`. | Both choices are required, so generation never relies on these fallbacks. |
| `lib/embeddings.ts`, `embeddingsRequestPath` | Root becomes `/v1/embeddings`. A path ending in `/v1` gains `/embeddings`; other prefixes gain `/v1/embeddings`. One trailing slash is removed first. | Do not append `/v1`. Query parameters are not forwarded by this upstream request builder. |
| `lib/embeddings.ts`, `embeddingStorePath` | The function fixes storage at `meta/embeddings.json`. Neither function name is a settings key. Requests contain only `model` and `input`. | No store path, request path, or dimension setting is emitted. Expected dimensions remain an unverified kit expectation. |
| `lib/task-config.ts`, `TaskConfig` and `readNamespacedConfig` | Neither declares or reads `taskThinkingLevel`. | Record the existing gap without changing the chat role or its emission. |

Example fragment for a selected wiki with capture consent and a gateway embedding route.
Use the model name exactly as the gateway names its route, not the upstream model name.
The example expects 1536 dimensions; the kit does not verify that expectation.

```json
{
  "consent": {
    "memoryCapture": true,
    "remoteMemoryWrites": false,
    "telemetry": false,
    "embeddingTextTransfer": true
  },
  "memory": {
    "schemaVersion": 1,
    "hermes": null,
    "wiki": {
      "ambientPersonalVault": false,
      "backgroundTasks": false,
      "embedding": {
        "provider": "openai-compatible",
        "baseUrl": "https://embeddings.example.invalid/v1",
        "model": "example-embedding-route",
        "auth": {"envVar": "EXAMPLE_EMBEDDING_KEY"},
        "expectedDimensions": 1536
      }
    },
    "openviking": null
  }
}
```

For example, Qwen3 on a local llama-swap listener can use this `embedding` object:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3-embedding",
  "auth": {"mode": "none"},
  "expectedDimensions": 1024
}
```

Replace `8080` with the listener port and `qwen3-embedding` with its configured Qwen3 route name.
The URL form is `http://127.0.0.1:<port>/v1`. This example expects 1024 dimensions, without configuring the server's output dimensions.
Use no-auth only when the listener accepts the fixed `no-auth-required` bearer placeholder.
These fragments create no gateway route, embedding listener, or model deployment.
Neither fragment changes the disabled default in `config/config.example.json`.

### Disable embeddings without removing data

1. Omit `memory.wiki.embedding` or set it to `null` in the private overlay.
2. Remove `consent.embeddingTextTransfer` or set it to `false`.
3. Set `target.agentDir` to a new absent candidate directory.
4. Generate the candidate with the command below.

```sh
python3 scripts/tenant_pi.py generate --overlay /private/overlay.json --target /owned/parent/keyword-only
```

Use `/owned/parent/keyword-only` as the overlay target for this command.
The candidate emits no embedding settings. The installed 0.12.5 package uses keyword-only recall when no embedder is configured, even with stored vectors.
Generation never opens or deletes wiki pages or `meta/embeddings.json`. Existing candidates and vaults remain unchanged.
Trusted project settings can enable embeddings again; review those settings before a manual launch.

After launch, write-time requests can send page titles, metadata, and up to 8000 body characters (`lib/embeddings.ts`, `buildEmbeddingText`).
Query-time requests can send search queries when stored vectors exist (`lib/recall.ts`, `searchWikiHybrid`).
Repeated queries use a cache. Missing vectors, missing authentication, or embedding failures retain keyword search.
The activation booleans describe possible requests, not measured requests or successful retrieval.

Backfill uses the separately requested upstream `wiki_reindex_embeddings` tool. It can send existing pages and incur endpoint costs.
Generation starts no request and no backfill. It does not run QMD indexing or download a model.
Endpoint compatibility, dimensions, input limits, backfill completion, and retrieval quality remain unverified.

Warning: HTTP sends page content, queries, and the bearer header without transport encryption.
Trust the selected service before granting transfer consent. A local endpoint can still forward content to another service.
Trusted project settings can override the generated endpoint and other wiki settings at launch.

## OpenViking: what the vendored source does

Source: `packages/openviking-pi`, vendored from a fork of OpenViking's `examples/pi-coding-agent-extension`, package version 0.4.3. The fork commit is `e9b05366` (`e9b053666a52fd02975017f0dc56e59719ff5529`), not a commit of the public `volcengine/OpenViking` repository. Its upstream merge base is `c9a869cb` (`c9a869cb145aac98f4be1586da32174d220c8800`).

The fork edits nine files relative to `examples/pi-coding-agent-extension/`: `README.md`, `config.ts`, `index.ts`, `sync.ts`, `lib/capture-adapter.mjs`, `lib/capture-utils-local.mjs`, `tests/capture-adapter.test.mjs`, `tests/config.test.mjs`, and `tests/sync-barrier.test.mjs`.

Its four behaviour changes are:

- Context takeover defaults off and requires explicit activation.
- Tool-result capture defaults off; tool inputs and outputs receive credential redaction in both states.
- Keyword capture keeps only turns that match a durable-memory trigger.
- Additive mode persists the capture watermark across resume. Session creation and reads use `auto_create` and fail closed on errors.

Licence: Apache-2.0 covers upstream `examples/`; the kit carries its `examples/LICENSE` as `packages/openviking-pi/LICENSE`. The OpenViking repository root uses AGPL-3.0. The kit copies nothing from outside `examples/`.

| Behaviour | Source fact | Kit handling |
| --- | --- | --- |
| Settings | `loadConfig()` reads no file beside the extension. `shared/config-schema.mjs` declares each setting and resolves it in this order: an `OPENVIKING_*` variable, the workspace file `.openviking/config.json`, the `plugin.pi` section of `~/.openviking/ovcli.conf`, its `plugin` section, the default. | The kit writes no settings file for the module. It renders the two overlay fields as variables on the launch line. The variable names come from the schema: `OPENVIKING_CAPTURE_TOOL_RESULTS` and `OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS`. A variable is the first layer, so the overlay value wins over each file. Each other setting keeps the value that the files or the defaults give. |
| Capture | With `autoCapture` (default on), the extension sends each turn to the server session. Tool result output is sent only when `captureToolResults` is `true` (default `false`). Credential fields and bearer values in tool inputs and outputs are redacted in both states (`lib/capture-utils-local.mjs`). | Enabling the module at all is capture to a remote store. It needs `consent.memoryCapture` and `consent.remoteMemoryWrites`. `captureToolResults` is a required overlay field, so the choice is explicit. |
| Recall | Before each prompt the extension asks the server for memories of the caller through `viking://~/memories` and `viking://~/skills` and adds the result to the prompt. | Not a kit setting, except the time limit `recallContextTimeoutMs`. |
| Context takeover | `loadLocalConfig()` keeps takeover off unless a settings layer or `OPENVIKING_TAKEOVER` turns it on. | The kit sets nothing for it. Takeover stays off unless the user turns it on outside the kit. |
| Credentials | The endpoint, the key and the identity come from `OPENVIKING_*` variables, then `~/.openviking/ovcli.conf`, then `~/.openviking/ov.conf`. `OPENVIKING_CLI_CONFIG_FILE` and `OPENVIKING_CONFIG_FILE` move the two files. | The kit writes none of them, reads none of them, and has no overlay field for an endpoint, a key or a user. `endpoints.openviking` and `env.openviking` fail validation. The user sets up the credentials outside the kit before the first start. |
| Local state | The pending queue (`~/.openviking/pending/`), the recall ledger (`~/.openviking/pi-recall-ledger/`), the workspace registry and the logs are under `~/.openviking/`. | Not under the agent directory. Each profile of one user shares this state: the `shared_home_state` gap. |
| Tools | The extension registers the MCP tools of the server as `openviking_*` tools after a handshake. A failed handshake does not stop the start. | Do not point the `mcp` module at the same server: the tools would appear twice. |
| Dependency | `package.json` lists `@modelcontextprotocol/client` at `2.0.0`, with a committed lock file. `node_modules/` is not in the tree. | The `install_step_required` gap and the setup line `npm --prefix <kit>/packages/openviking-pi ci --ignore-scripts`. Display only: the kit does not run it. |
| Server | The extension needs an OpenViking server with `viking://~` home alias support. | The `server_required` gap. The kit starts no server and makes no request. |

A setting from an older version of the extension can exist as a `config.json` beside an installed copy. This version does not read that file. To keep a choice from it, set the overlay field when the module has one, or move the value to the `plugin.pi` section of `~/.openviking/ovcli.conf`.

Cost of `captureToolResults: true`: each tool part goes to the server, capped at `captureToolMaxChars` characters (default 1000000), and the server stores larger output outside the session. Not measured: the growth of session storage and the effect on memory extraction. The `capture_cost_unmeasured` gap is in each plan with the module.

The kit does not run the files under `packages/openviking-pi/scripts/`. `e2e-live.mjs` and `e2e-live.sh` need a live server, a Pi and a model. `setup.mjs` is a wizard that writes credentials to `~/.openviking/`.

### Refresh the vendored copy

`pi update --extensions` moves an installed npm source without a version, and the kit update pipeline (`docs/pi-update.md`) moves the Pi pin. They do not change `packages/openviking-pi`. A refresh is a manual step, until the kit has a command for it. `<openviking checkout>` is a clone of the OpenViking repository and `<commit>` is the reviewed commit:

```sh
work="$(mktemp -d)"
git -C '<openviking checkout>' archive '<commit>' examples agent-plugins | tar -x -C "$work"
(cd "$work" && node examples/memory-plugin-shared/sync.mjs)
```

`sync.mjs` writes `examples/pi-coding-agent-extension/shared/` from `examples/memory-plugin-shared/lib/`. It also writes the copies of the other plugins, so the archive holds the whole `examples/` and `agent-plugins/` trees; with less, the script stops with an error after it wrote `shared/`. The directory holds the files that the extension imports. The OpenViking repository does not track it for this extension, so the kit commits it: Pi loads the package from the kit directory and can only see the files that are there. Then copy `examples/pi-coding-agent-extension/` to `packages/openviking-pi/`, without `node_modules/`, and `examples/LICENSE` to `packages/openviking-pi/LICENSE`. Keep the kit-only README edits and the added `LICENSE` at a refresh. The README banner records the fork commit, upstream merge base, changed files, licence scope and upstream-only references. Update those facts here and in `docs/packages.md` too. The README corrects links and shortens "Local fork: differences" because the kit loads the package by its path. `LICENSE` is the file from `examples/`. All other extension files stay byte-equal to the fork commit. Each generated `shared/` file matches the corresponding shared source with its generated-file header added. The capture-adapter fixture stays unchanged; the kit scanner permits its exact placeholder header value through a narrow content allowlist. Read `shared/config-schema.mjs` again: the two variable names and the bounds of `recallContextTimeoutMs` in `scripts/memory_modules.py` must agree with it, and a test compares them. Run `npm ci --ignore-scripts` in the package directory of each clone after a refresh.

## Generated outputs

| Output | Present when | Content |
| --- | --- | --- |
| `settings.json` `packages` | any module | `npm:pi-hermes-memory` with `extensions: ["src/index.ts"]`; the absolute path of `packages/openviking-pi` in this kit with `extensions: ["index.ts"]`; `npm:@zosmaai/pi-llm-wiki` with `extensions: ["extensions/llm-wiki/index.ts"]`; all other resource lists empty. Declared after the other in-tree packages, in this order. |
| `settings.json` `llm-wiki` | wiki | `ambientPersonalVault`, `trajectories: false`, and with background tasks `taskModel` and `taskThinkingLevel`. Explicit embeddings add `embeddingProvider`, `embeddingBaseUrl`, `embeddingModel`, and exactly one of `embeddingApiKeyEnv` or placeholder-only `embeddingApiKey`. |
| `hermes-memory-config.json` | hermes | Review off: `reviewEnabled`, `correctionDetection`, `flushOnCompact`, `flushOnShutdown`, `autoConsolidate` all `false`, `memoryOverflowStrategy: "reject"`. Review on: the same keys `true`, `memoryOverflowStrategy: "auto-consolidate"`, `reviewTransport`, `llmModelOverride`, `llmThinkingOverride`, and `childExtensionPaths` when given. |
| `.tenant-pi/choices.json` `memory` | any module | The activation record (`enabled`, `localCapture`, `backgroundModelCalls`, `remoteWrites`, transport, child source count, personal vault location, and `captureToolResults` for `openviking`) and the setup facts: `WIKI_HOME` and the two `OPENVIKING_*` variables. For `openviking`, `remoteWrites` is `true` and `localCapture` is `false`: the module keeps no memory store on the client. |
| `.tenant-pi/choices.json` `memory.activation.wiki.embeddings` | wiki | `enabled`, `writeTimeRequests`, and `queryTimeRequests` are booleans. `backfill` is `"separate action"`. Optional `expectedDimensions` records the later verification expectation. The plan shows this same activation record. |
| `.tenant-pi/state.json` `outputs` | hermes | Lists the Hermes file as a declared output. |
| Launch line | `wikiHome` | `WIKI_HOME='<path>'` precedes `PI_CODING_AGENT_DIR=...`. |
| Launch line | wiki without `wikiHome` | `-u WIKI_HOME` follows `-u PI_CODING_AGENT_SESSION_DIR`: the line removes an inherited `WIKI_HOME`. See [the wiki home](launcher.md#the-wiki-home). |
| Launch line | openviking | `OPENVIKING_CAPTURE_TOOL_RESULTS=true` or `=false` precedes `PI_CODING_AGENT_DIR=...`, and `OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=<n>` when the overlay has `recallContextTimeoutMs`. Both are process-local: the kit exports nothing and writes no shell file. A manual `pi` command without them uses the files and the defaults of the extension. |
| Setup lines | hermes or wiki | One `pi install <source>` line for each declared npm source, with the source string of `settings.json`, then `node scripts/patch_extension_peers.mjs`. Display only. |
| Setup lines | openviking | `npm --prefix <kit>/packages/openviking-pi ci --ignore-scripts`. Display only. The module adds no `pi install` line and no peer override line: Pi installs nothing for a path package, and the package lists no host module as a dependency. |
| Extra file | openviking | None. No generated file holds an endpoint, a key or a user of the server. |

Readiness gaps of `openviking`: the gaps of its manifest entry (`install_step_required`, `server_required`, `package_runtime_unverified`, `kit_test_missing`, `capture_cost_unmeasured`) and `shared_home_state`. Readiness gaps of the two npm modules: `package_runtime_unverified` and `peer_override_required` per module, `native_addon_unverified` for `better-sqlite3`, `session_backfill_scope_unverified` for Hermes, `project_settings_override` for the wiki, `child_provider_unverified` when child sources are given, `shared_home_state` for the wiki without `wikiHome`. The `memory` role adds `model_catalog_unverified` and `provider_auth_unverified` like every role; it does not add `role_activation_unavailable` when a module consumes it.

Enabled wiki embeddings add `embedding_endpoint_unverified`, plus `embedding_dimensions_unverified` when `expectedDimensions` is set. Generation closes neither gap.

## Carry

`compare` reports the recorded overlay `memory` block field by field under `/overlay/memory/<module>/<field>`: the three switches and `reviewTransport` by value, `openviking.captureToolResults` and `openviking.recallContextTimeoutMs` by value, each `childExtensionPaths` entry and `wikiHome` as a marker without a value ([candidate comparison](candidate-compare.md)). `carry` prints one patch per reported field at `/memory/<module>/<field>`, with the value from the right side's overlay copy; the `childExtensionPaths` list is one unit. A memory field that the patched overlay sets, and that the report does not name, stays unchanged, unless the report names another field of the same module and the right side sets that module to `null` or has no block: then the module goes as a whole. A module object of the patched overlay with no field entry in the report is never set to `null` or removed. A module that is `null` in the patched overlay carries as one `/memory/<module>` patch. `carry` never patches `consent`, so a memory patch that needs a consent change (`memoryCapture`, and `remoteMemoryWrites` for `openviking`) leaves that decision to the user ([carrying drift](carry.md)). The field names of the three modules are one table, `MODULE_FIELDS` in `scripts/memory_modules.py`; the validator, `compare` and `carry` read it.

Embedding comparison reports nested fields. `baseUrl`, `model`, and `auth.envVar` are markers without values, like `wikiHome`.
`provider`, `auth.mode`, and `expectedDimensions` compare by value. The generated `embeddingProvider` also compares by value; other embedding settings remain markers.
The transfer consent compares as a boolean. An older missing activation record equals the exact disabled embeddings record.
Carry patches include selected private values from the validated right overlay copy. Keep this output private.
Only reported embedding leaves carry when both overlays contain embedding objects. Removing the embedding object removes its fields together.
Carry never patches `consent.embeddingTextTransfer`. A carried object without target consent reports `embedding_consent_missing`; removing it with consent still true reports `embedding_consent_unused`.
Offline diagnostics check only overlay structure. They never check credential values, endpoint access, or model availability.

## Test coverage

Embedding fixtures validate, plan, and generate candidates with environment authentication and no-auth mode.
They cover missing choices, both consent requirements, malformed URLs, credential query parameters, invalid dimensions, and disabled choices with ambient credentials.
The CLI fixtures block network calls and subprocesses, guard credential environment reads, and reject reads of existing profiles and vaults.
Secret canaries remain absent from diagnostics, generated files, and comparison reports.
Tests also check unchanged chat settings, vault choices, trajectories, ownership filters, and unverified readiness.

`tests/test_memory_modules.py` covers: default generation with no memory module; no consent; consent without selection; selection without choices; local-only consent for both modules with every background switch off; remote-write refusal without `openviking`; `openviking` without the capture consent, without the remote consent, without selection and without choices; its package declaration after the in-tree packages, its two launch variables in both states, its activation record, its gaps and its setup line; the variable names and the bounds against `shared/config-schema.mjs` of the vendored package; its invalid choice shapes with a secret canary, and the refusal of an endpoint or a credential name; missing memory role; unsupported wiki thinking; missing child provider for `llama.cpp`, `openai-codex-2`, and a gateway role; every invalid choice shape with a secret canary, including `wikiHome` with a quiet wiki; the process-local `WIKI_HOME` fact; the removal of an inherited `WIKI_HOME` for a wiki with no `wikiHome`, and no removal with `wikiHome` or without the wiki; hostile Hermes file shapes in comparison; guarded publication of the Hermes file with tamper rejection; redacted comparison of the Hermes file and the wiki section; and a CLI generate-and-compare run in a disposable HOME with blocked sockets and subprocesses, ambient `~/.llm-wiki` and `~/.pi/agent/hermes-memory-config.json` canaries beside the candidate that stay unread and unchanged; and a CLI plan, generate and compare run of an `openviking` profile in a disposable HOME with blocked sockets and subprocesses, with canary values in `~/.openviking/ovcli.conf`, `~/.openviking/ov.conf` and the `OPENVIKING_*` credential variables that reach no output. `tests/test_carry.py` covers the carry of the two `openviking` fields.

Not verified for `openviking`: a start of a generated profile against a live server, `npm ci` of the package on a clean client, and the effect of `captureToolResults` on storage. The kit tests do not run the test suite of the vendored package. Not verified: the published `dependencies` of the two npm packages before peer overrides; see `docs/host-peer-overrides.md`. Not run: any Pi start with the Hermes package or the OpenViking package, a wiki tool call from a profile that the kit generated, the `direct` or `subprocess` review against a fixture provider, and the peer override on a fresh install. Those stay `unverified` in every plan. The start runs of the wiki package are in [an existing vault](#an-existing-vault).
