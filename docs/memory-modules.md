# Memory templates with explicit activation consent

Status: offline implementation, not a qualified runtime. `scripts/memory_modules.py` is a pure module: no file, environment, subprocess, or network access. Validation, planning, and generation make zero model calls and zero network writes; the tests prove this with a blocked-socket, blocked-subprocess fixture. Not verified: live capture behaviour. Get explicit consent before a live capture test.

Two modules can be enabled: `hermes` (`pi-hermes-memory`) and `wiki` (`@zosmaai/pi-llm-wiki`). Both are declared without a version, so `pi update --extensions` installs the current registry version. The source facts below were read at `pi-hermes-memory@0.9.9` and `@zosmaai/pi-llm-wiki@0.12.4`; a newer version can change them. `openviking` stays blocked; see the gap below. Enabling either module is a three-part explicit act. The default example enables none of them and emits no memory extension.

## Activation truth table

| Overlay state | Result |
| --- | --- |
| Module not in `selection.enable` | Nothing is emitted for it, whatever `consent` or `memory` says. A `memory.<module>` object for an unselected module fails with `memory_module_disabled`. |
| Module enabled, `consent.memoryCapture` false | `memory_consent_required`. Nothing is generated. |
| Module enabled, consent true, no `memory` block or `memory.<module>` is `null` | `memory_choices_required`. Nothing is generated. |
| `consent.memoryCapture` true with no memory module enabled | `memory_disabled`. Consent alone activates nothing. |
| `consent.remoteMemoryWrites` true | `remote_memory_disabled`. No enabled module writes to a remote store at this pin. |
| Module enabled, consent true, explicit choices | The package declaration, its settings or config file, and readiness gaps are emitted as the tables below say. |

A configured credential name, an endpoint, or a reachable service never enables capture: neither module has an endpoint or credential field in the overlay.

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
| `wiki.wikiHome` | absolute path | Optional, and only with `ambientPersonalVault: true`. Moves the personal vault to `<wikiHome>/.llm-wiki/` through a process-local `WIKI_HOME` assignment on the launch line. At this pin `resolveProjectVaultRoot` treats `WIKI_HOME` as the project's own vault, so every ambient surface fires wherever Pi starts; a quiet wiki with a relocated vault is not possible, and the validator fails `wiki_home_is_ambient`. |
| `openviking` | `null` only | The component is blocked. |

`roles.memory` is the one model choice both modules share. With `modelRoutes` it is checked against the explicit registry like any other role. Without a registry, the model and its authentication remain `unverified`.

Not verified: the Pi 0.99.1 behaviour described below with Pi 1.0.3, the current kit pin.

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

| Behaviour | Source fact | Kit handling |
| --- | --- | --- |
| Settings key | `loadTaskConfig` reads the `llm-wiki` section of `<agent dir>/settings.json`, then the project `.pi/settings.json`, which wins. | The kit owns `/llm-wiki` in the candidate's `settings.json` only. A trusted project's `.pi/settings.json` can set `ambientPersonalVault`, `trajectories`, or a task model above it; project trust is a launch-time choice outside the kit, and `--no-approve` does not grant it. |
| Vault resolution | `resolveVaultRoot(cwd)`: a `.llm-wiki/` in the working directory or a parent wins; otherwise the personal root, `WIKI_HOME` or the HOME directory. The personal vault is `<root>/.llm-wiki/`. | Not under the agent directory. The `shared_home_state` gap names this unless `wikiHome` is set. |
| Ambient creation | On `session_start`, when `ambientPersonalVault` is true (the Pi default) and no vault exists, `bootstrapVault` silently creates the personal vault and `before_agent_start` injects recall on every turn in every directory. | The kit always writes `ambientPersonalVault` explicitly; the default example value is `false`. |
| Background model | `taskModel` and `taskThinkingLevel` select the model for ingest and synthesis; unset means the session model. Accepted levels are `low`, `medium`, `high`, `xhigh`. | Written from `roles.memory` only with `backgroundTasks: true`; other thinking levels fail `unsupported_wiki_thinking`. |
| Trajectories | Off unless `trajectories: true`; the capture tools are not registered when off. | The kit writes `trajectories: false`. |
| Credentials | `taskModelApiKey`, `embeddingApiKey`, and their base URLs are settings fields. | Never written. The kit has no field for them. |
| Resources | The package declares extensions, skills, prompts, and an MCP server. | Only `extensions` loads. The `/wiki-*` prompt commands and the skill are filtered out; widening the filter is a manifest review, not an overlay choice. |
| Peer warning | The package lists `@earendil-works/pi-tui` and `typebox` under `dependencies`. | `peer_override_required` gap and setup line. |

With `ambientPersonalVault: false`, no `WIKI_HOME`, and no project vault, nothing in the wiki writes without an agent tool call. Recall injection, the session notice, and the periodic reminder all pass through the same ambient gate, and a project vault or a trusted project settings file reopens it.

## OpenViking: blocked with a named gap

No reviewed source exists in this release; activation is blocked. The manifest source stays `null`.
A source review must establish capture defaults, credential storage, retrieval scope and file ownership before activation.

`consent.remoteMemoryWrites` therefore has no consumer. Setting it fails with `remote_memory_disabled`, and core Pi stays usable with the module disabled.

## Generated outputs

| Output | Present when | Content |
| --- | --- | --- |
| `settings.json` `packages` | either module | `npm:pi-hermes-memory` with `extensions: ["src/index.ts"]`; `npm:@zosmaai/pi-llm-wiki` with `extensions: ["extensions"]`; all other resource lists empty. Declared after the in-tree packages. |
| `settings.json` `llm-wiki` | wiki | `ambientPersonalVault`, `trajectories: false`, and with background tasks `taskModel` and `taskThinkingLevel`. |
| `hermes-memory-config.json` | hermes | Review off: `reviewEnabled`, `correctionDetection`, `flushOnCompact`, `flushOnShutdown`, `autoConsolidate` all `false`, `memoryOverflowStrategy: "reject"`. Review on: the same keys `true`, `memoryOverflowStrategy: "auto-consolidate"`, `reviewTransport`, `llmModelOverride`, `llmThinkingOverride`, and `childExtensionPaths` when given. |
| `.tenant-pi/choices.json` `memory` | either module | The activation record (`enabled`, `localCapture`, `backgroundModelCalls`, `remoteWrites`, transport, child source count, personal vault location) and the `WIKI_HOME` setup fact. |
| `.tenant-pi/state.json` `outputs` | hermes | Lists the Hermes file as a declared output. |
| Launch line | `wikiHome` | `WIKI_HOME='<path>'` precedes `PI_CODING_AGENT_DIR=...`. |
| Setup lines | either module | `pi update --extensions` to reconcile the declared packages, then `node scripts/patch_extension_peers.mjs`. Display only. |

Readiness gaps: `package_runtime_unverified` and `peer_override_required` per module, `native_addon_unverified` for `better-sqlite3`, `session_backfill_scope_unverified` for Hermes, `project_settings_override` for the wiki, `child_provider_unverified` when child sources are given, `shared_home_state` for the wiki without `wikiHome`. The `memory` role adds `model_catalog_unverified` and `provider_auth_unverified` like every role; it does not add `role_activation_unavailable` when a module consumes it.

## Carry

`compare` reports the recorded overlay `memory` block field by field under `/overlay/memory/<module>/<field>`: the three switches and `reviewTransport` by value, each `childExtensionPaths` entry and `wikiHome` as a marker without a value ([candidate comparison](candidate-compare.md)). `carry` prints one patch per reported field at `/memory/<module>/<field>`, with the value from the right side's overlay copy; the `childExtensionPaths` list is one unit. A memory field that the patched overlay sets, and that the report does not name, stays unchanged, unless the report names another field of the same module and the right side sets that module to `null` or has no block: then the module goes as a whole. A module object of the patched overlay with no field entry in the report is never set to `null` or removed. A module that is `null` in the patched overlay carries as one `/memory/<module>` patch. `carry` never patches `consent`, so a memory patch that needs a consent change leaves that decision to the user ([carrying drift](carry.md)). The field names of the three modules are one table, `MODULE_FIELDS` in `scripts/memory_modules.py`; the validator, `compare` and `carry` read it.

## Test coverage

`tests/test_memory_modules.py` covers: default generation with no memory module; no consent; consent without selection; selection without choices; local-only consent for both modules with every background switch off; remote-write refusal; OpenViking non-null and enable attempts; missing memory role; unsupported wiki thinking; missing child provider for `llama.cpp`, `openai-codex-2`, and a gateway role; every invalid choice shape with a secret canary, including `wikiHome` with a quiet wiki; the process-local `WIKI_HOME` fact; hostile Hermes file shapes in comparison; guarded publication of the Hermes file with tamper rejection; redacted comparison of the Hermes file and the wiki section; and a CLI generate-and-compare run in a disposable HOME with blocked sockets and subprocesses, ambient `~/.llm-wiki` and `~/.pi/agent/hermes-memory-config.json` canaries beside the candidate that stay unread and unchanged.

Not verified: the published `dependencies` of both packages before peer overrides; see `docs/host-peer-overrides.md`. Not run: any Pi start with either package, the `direct` or `subprocess` review against a fixture provider, the peer override on a fresh install, and the wiki vault creation. Those stay `unverified` in every plan.
