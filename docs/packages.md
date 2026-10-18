# In-tree packages

`packages/tenantext` and `packages/promptr` hold the sources of the two optional Pi packages. `packages/openviking-pi` holds a vendored copy of the OpenViking extension for Pi; it is the `openviking` memory module. `packages/agentcore-pi` holds the AgentCore Memory extension for Pi on the shared memory core: recall before each typed prompt and the confirmed propose tool `agentcore_propose`; it is the optional `agentcore` memory module. `packages/agentcore-memory-core` holds the shared memory core for several people: the contract, its implementation and the review CLI. `packages/agentcore-claude` holds the Claude Code plugin of the shared memory: a recall hook and an MCP server with the propose and review tools. `packages/agentcore-memory-admin` holds the registry script of the shared memory, an owner tool.
Each package has its own license metadata, tests and documentation.

Tenantext and Promptr pin `@types/node` to `24.19.2` for their Node `>=24.0.0 <25` requirement.

## Kit components

Each extension and each skill of the packages is one component in `config/manifest.json`. The components `coordinator-skills` and `knowledge-skills` each hold several skills, with one filter entry for each. The source kind is `tree`: `{"kind": "tree", "path": "packages/<name>"}`. The example overlay enables none of them. Observed with Pi 0.99.1: a profile with the extension and skill components tested on that version starts and loads the extensions after `npm ci --ignore-scripts` in `packages/tenantext`; without that step the load fails on the missing `yaml` module. Not verified: the same on the kit pin in `config/manifest.json`, key `runtime.piVersion`, or on a clean client. This observation does not cover `resources`. Not verified: a profile with `resources` starts and loads the extension.

| Component | Path | Filter | Requires | Status | Gaps |
| --- | --- | --- | --- | --- | --- |
| `tenantext` | `packages/tenantext` | `extensions/tenantext/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `kit_test_missing` |
| `codex-accounts` | `packages/tenantext` | `extensions/codex-accounts/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `gateway_upstream_unverified`, `kit_test_missing` |
| `slopscore` | `packages/tenantext` | `extensions/slopscore/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `kit_test_missing` |
| `context-meter` | `packages/tenantext` | `extensions/context-meter/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `kit_test_missing` |
| `ops-footer` | `packages/tenantext` | `extensions/ops-footer/index.ts` | `core`, `context-meter` | `unverified` | `pi_line_unqualified`, `sibling_extension_imports`, `kit_test_missing` |
| `copilot-usage` | `packages/tenantext` | `extensions/copilot-usage/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `kit_test_missing` |
| `anthropic-usage` | `packages/tenantext` | `extensions/anthropic-usage/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `usage_endpoint_unverified`, `kit_test_missing` |
| `doctor` | `packages/tenantext` | `extensions/doctor/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `sibling_extension_imports`, `kit_test_missing` |
| `resources` | `packages/tenantext` | `extensions/resources/index.ts` | `core` | `unverified` | `pi_line_unqualified`, `kit_test_missing` |
| `herdr` | `packages/tenantext` | `skills/herdr` | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `herdr-relay` | `packages/tenantext` | `skills/herdr-relay` | `core`, `herdr` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `herdr-watch` | `packages/tenantext` | `extensions/herdr-watch/index.ts` | `core`, `herdr` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `coordinator-skills` | `packages/tenantext` | Each skill directory below `skills/coordinator-skills/`. `config/manifest.json` names them; [the component README](../packages/tenantext/skills/coordinator-skills/README.md) lists them | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `knowledge-skills` | `packages/tenantext` | Each skill directory below `skills/knowledge-skills/`. [The component README](../packages/tenantext/skills/knowledge-skills/README.md) lists them | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `slopscore-pr` | `packages/tenantext` | `skills/slopscore-pr` | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `tracker-site` | `packages/tenantext` | `skills/tracker-site` | `core` | `unverified` | `host_tool_required` (Git on `PATH`; Python 3.11 or later is checked), `pi_line_unqualified`, `kit_test_missing` |
| `promptr` | `packages/promptr` | `index.ts` | `core` | `unverified` | `build_step_required`, `host_module_dependency`, `placeholder_defaults`, `private_renderer_adapters`, `automatic_dispatch_path_unverified`, `kit_test_missing` |
| `promptr-generate-task-prompt` | `packages/promptr` | `skills/promptr-generate-task-prompt` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-handoff` | `packages/promptr` | `skills/promptr-handoff` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-openknowledge-project-pages` | `packages/promptr` | `skills/openknowledge-project-pages` | `core`, `promptr` | `unverified` | `host_service_required`, `skill_use_unverified`, `kit_test_missing` |
| `promptr-watch-herdr-agents` | `packages/promptr` | `skills/watch-herdr-agents` | `core`, `promptr` | `unverified` | `host_tool_required`, `skill_use_unverified`, `kit_test_missing` |
| `openviking` | `packages/openviking-pi` | Local-file source `index.ts`, not a directory filter | `core` | `unverified` | `install_step_required`, `server_required`, `package_runtime_unverified`, `capture_cost_unmeasured` |
| `agentcore` | `packages/agentcore-pi` | Local-file source `index.ts` | `core` | `unverified` | `install_step_required`, `aws_resource_required`, `package_runtime_unverified` |

Facts for a selection:

- The `components` action prints one line for each component of the manifest, with the names of its extensions and skills, its required IDs and its prerequisites. See [the CLI contract](generator.md#components-the-checklist-of-the-components).
- `herdr-relay` is optional and disabled by default. No component requires it. Enable `herdr` too when you select it. A kit without the relay directory remains valid while the relay stays disabled. Enabling an absent relay fails with `tree_resource_missing`.
- `herdr-watch` adds the tools `herdr_spawn`, `herdr_watch_start`, `herdr_watch_status` and `herdr_watch_stop`, and the command `/herdr-watch`. `herdr_spawn` starts a task session with `spawn.py` of the herdr skill and watches it. A watch runs `ask.py` of the herdr skill in the background, and the reply of the pane arrives as a task notification. In Pi with the component, the watch is the default way to start a task session and to prompt a pane. The `herdr` command, Python 3 and the herdr skill scripts are host tools that the kit does not install. See [the extension document](../packages/tenantext/docs/herdr-watch.md). Not verified: a load of the component with the kit pin, and a live session with a Herdr pane.
- An `unverified` component can be enabled. The plan lists each of its gaps as a readiness gap with the component ID as the subject.
- `openviking` is a memory module: it also needs `consent.memoryCapture`, `consent.remoteMemoryWrites` and a `memory.openviking` block. Its local-file package declaration names `packages/openviking-pi/index.ts` and comes after the other in-tree packages. See [the memory modules](memory-modules.md).
- `herdr` holds the skill only. The Herdr application is a host tool: the kit does not install it, and the `check-herdr` action reports the `herdr` command. See [Herdr and the question tool](herdr-setup.md).
- `questions` is not an in-tree package. Its source is the npm package `@juicesharp/rpiv-ask-user-question@2.13.8` with the filter `index.ts`. It requires `core` and is `unverified`. Its gaps are `pi_line_unqualified`, `package_source_unreviewed`, `peer_package_unverified`, `question_ui_unverified`, `shared_config_outside_profile` and `kit_test_missing`. The example overlay disables it.
- A `blocked` component cannot be enabled. The validator fails with `blocked_component`.
- A generated profile declares each package one time in `settings.packages`. The `source` is the absolute package directory path, except OpenViking and AgentCore, whose sources are their `index.ts` files. For a directory source, each enabled component adds its own `extensions` or `skills` filter entry. An empty directory filter loads nothing of that kind.
- The profile depends on the location of the kit. If you move the kit, generate a new profile.
- `codex-accounts` declares `TENANTEXT_LITELLM_BASE_URL` and `TENANTEXT_LITELLM_API_KEY`: `extensions/codex-accounts/routing.ts` reads both. `doctor` declares `TENANTEXT_LITELLM_BASE_URL`: `extensions/doctor/checks.ts` reads it for one information line. `coordinator-skills` declares `GITEA_TOKEN`: the skills `to-spec` and `to-tickets` send it to the Gitea API of the issue tracker.
- The gateway keys of the overlay are `endpoints.codex-accounts` and `env.codex-accounts`. The old key `tenantext` fails with `moved_key`.
- `ops-footer` and `doctor` import files of other extensions of the package. The import of a file does not need the other component to be enabled. The only runtime import of `ops-footer` is a file import of `context-meter/service.ts`. `ops-footer` and `context-meter` exchange ownership events. The manifest keeps `context-meter` as a requirement of `ops-footer`: this is a safe choice, not a proven need. Not verified: the behaviour of `ops-footer` and `doctor` when the other extensions are off.
- `resources` adds the `/resources` command. The command shows the extensions, skills, prompts and MCP servers of the agent directory, turns each one on or off, and saves named profiles. `docs/resources.md` has the command and the settings syntax. The component declares no environment variable. It follows the reviewed resource settings syntax. Not verified: a load of the component with the kit pin.
- Install the Node dependencies of a package before Pi loads it (the "Test" and "Build and test" commands below). Not verified: which components need `node_modules/` at load time.

## Decision-server credential

`context-meter` reads the variable named by `nextMoveKeyEnv`; its default is `TENANTEXT_NEXT_MOVE_KEY` (source reading).
The key goes in the Bearer header of a POST to `nextMoveUrl`, when that URL is set.
The default URL is empty.
The component also sends session counters and the last 300 characters of the last user message, after whitespace normalization (source reading).

Not verified: these requests in a generated profile.

## Tenantext (`packages/tenantext`)

Tenantext is a Pi extension suite with a Claude Code plugin under `claude-code/`. The package README is `packages/tenantext/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/tenantext` |
| Claude Code plugin | `claude-code/`; `build-skills.py` builds `herdr` and `slopscore-pr` from the package source skills |
| License | MIT, `packages/tenantext/LICENSE`; third-party notices in `packages/tenantext/THIRD_PARTY_NOTICES.md` and `packages/tenantext/licenses/` |
| Node | `>=24.0.0 <25` (`engines` in `packages/tenantext/package.json`) |

### Publish set

`PUBLISH_DIRS` in `scripts/publish_check.py` publishes tracked package files except installed dependencies and build output.
A maintainer can keep reviewed private-copy exclusions in an optional list; see [publishing](publishing.md#adding-a-file-to-the-portable-set).
The list and the excluded files are absent from a portable copy. No list is necessary there.

The two pull request templates `.gitea/PULL_REQUEST_TEMPLATE.md` and `.github/PULL_REQUEST_TEMPLATE.md` are published: `slopscore/test/docs.test.ts` reads both, and the package test suite must pass in a portable clone.

`docs/publishing.md` describes the rule format.

`PATTERN_ALLOW` in `scripts/publish_check.py` holds the exact line text of two reviewed lines of the package that match `PATTERNS` and hold no secret. The line of `extensions/codex-accounts/routing.ts` that returns the API key reference refers to the name of an environment variable, not to a value. Line 26 of `tracker/tests/test_publish.py` is a canary fixture of the tracker publish test, not a token. An exception is the exact line text in one file, not a line number. A changed line is a new finding.

### Tests

Run the tests from the package directory. `npm ci` reads the committed `package-lock.json`.

```sh
cd packages/tenantext
npm ci --ignore-scripts
npm test
npm run typecheck
```

The three Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) are optional peer dependencies. The lock file does not install them. Twelve test files and the typecheck import them, so link them from the host Pi installation first. `G` is the `@earendil-works` directory of the global Node modules:

```sh
mkdir -p node_modules/@earendil-works
ln -sfn "$G/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$G/pi-coding-agent/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$G/pi-coding-agent/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
```

A host can have more than one global Node modules directory, with a different Pi version in each. The links decide which Pi the tests use, so read the version of the linked package before a run:

```sh
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
```

Two tests need Pi `1.0.1` or later, because they compare the project MCP override with the code of Pi. One is in `test/resources-inventory.test.ts`; its name ends with `agrees with the Pi loader`. One is in `test/resources-writers.test.ts`; its name ends with `as Pi does`. Observed: with links to a Pi `0.99.1`, these two tests fail while the remaining package tests pass. Pi `0.99.1` has no project override, and its `updateMcpServerConfig()` has no fourth parameter. With links to Pi `1.0.2` and with links to Pi `1.0.3`, the package tests pass. The fix is new links to a Pi `1.0.1` or later. It is not a change of the tests.

A Pi from `npm install --prefix <dir>` without `--global` has the three packages side by side in `<dir>/node_modules/@earendil-works`. Link each one from there.

`scripts/publish_check.py` ignores each `node_modules/` directory, so `packages/tenantext/node_modules/` can stay. A tracked file under `node_modules/` fails the check with `tracked_in_node_modules`.

## Promptr (`packages/promptr/`)

Promptr is a Pi extension: a prompt queue, progress checkpoints, staged handoffs and tracker views.

| Item | Value |
| --- | --- |
| Source | `packages/promptr` |
| License | MIT, `packages/promptr/LICENSE`; declared in `packages/promptr/package.json`. |
| Skills | `packages/promptr/skills/`: `promptr-generate-task-prompt`, `promptr-handoff`, `openknowledge-project-pages` and `watch-herdr-agents` |
| Publish rule | `("packages/promptr", ("node_modules/", "dist/", "LICENSE"))`; `packages/promptr/LICENSE` is explicit in `PUBLISH`. |
| Pi version | The package pins `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` to `runtime.piVersion` in `config/manifest.json`. The package tests pass, as do the build, typecheck and `npm run smoke`. Not verified on the kit pin: `npm run smoke:installed`, a package load in Pi, or a session with a model. |

### Build and test

Node `>=24.0.0 <25` is necessary.

```sh
cd packages/promptr
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
```

`node_modules/` and `dist/` are not tracked. `scripts/publish_check.py` ignores `node_modules/` and `packages/promptr/dist/`, and fails when a file under one of them is tracked.

Warning: `npm run install:local` and `npm run doctor` read or change the Pi directory of the host. Do not run them as a repository check. `npm run smoke:installed` installs into a new directory under the temporary directory and starts `pi` there without a prompt.

A generated profile loads `packages/promptr` by its path, so the build must be in the clone: run `npm ci --ignore-scripts` and `npm run build` there before the first start. Pi 1.0.2 and Pi 1.0.3 print one warning at each start, because `@earendil-works/pi-tui` is under `dependencies`. The companion process needs that copy. For the built files, Pi also loads that second copy of `pi-tui` (verified on 1.0.2). Both copies were 1.0.2 then. The package now matches `runtime.piVersion` in `config/manifest.json`. Pi declares its `pi-tui` dependency at that exact version.
The version-specific evidence is in [the Promptr matrix](workflow-modules.md#promptr-unverified-with-a-readiness-matrix). Not verified: interactive key handling on the kit pin.
The kit pin move does not change an installed Promptr copy or resolve its dependency drift. A live reinstall needs separate approval.

### Placeholder defaults

Four defaults in `src/` are placeholders. Three have an override by environment variable, so set the value for your host:

| Setting | Placeholder default |
| --- | --- |
| `GITEA_HOST` | `https://git.example.com` |
| `GITEA_OWNER` | `owner` |
| `OPENKNOWLEDGE_ORIGIN` | `https://openknowledge.example.com`. The fallback origin in `src/doctor/doctor.mts` (line 198) has the same value. |
| `LEGACY_ISSUE_REPO` (`src/project/workstreams.mts`, line 129) | Host `https://git.example.com` and owner `owner`. No override, and none is necessary: the constant is the fallback of an issue input without a repository, and no code outside the tests creates an issue input (`src/briefing/overview.mts` gives `buildRoutingIndex` an empty list). A test in `test/project/workstreams.test.mjs` holds this fact. |

The tracker dialog of `/promptr-tracker init` shows `GITEA_OWNER` as the default owner for the Gitea provider (`providerDefaultOwner` in `src/tracking/binding.mts`). Without `GITEA_OWNER` it shows `owner`. Edit this value in the dialog. If you accept `owner`, the dialog binds a repository that does not exist.

`scripts/preview-sidebar.sh` looks for a Tenantext checkout beside the repository, then in `$PROMPTR_STACK_DIR/tenantext` when `PROMPTR_STACK_DIR` is set.

## AgentCore Memory extension (`packages/agentcore-pi`)

This package connects Pi to the shared AgentCore Memory of several people. It changes no local memory store.
OpenViking stays the primary memory. The checklist leaves AgentCore unmarked.
The module requires selection, both memory consents, and `memory.agentcore.configFile`.
The extension recalls before each typed prompt and adds the tool `agentcore_propose`, which writes only after the person confirms.
See [the memory guide](memory-modules.md#agentcore-memory), [the security document](shared-memory-security.md) and [the package README](../packages/agentcore-pi/README.md).

| Item | Value |
| --- | --- |
| Source | Own code at `packages/agentcore-pi/index.ts`, loaded after OpenViking as a local-file source. |
| License | The repository MIT license covers this code. |
| Node | `>=24.0.0 <25`. |
| Dependency | None of its own. It imports the core `packages/agentcore-memory-core` by a relative path; the lock file of the core installs `@aws-sdk/client-bedrock-agentcore` `3.1152.0`. |
| Configuration | The person config file. The launch line names it in process-local `AGENTCORE_MEMORY_CONFIG_FILE` and removes an inherited `AGENTCORE_MEMORY_CONFIG`. No credential is rendered. |
| Credentials | The AWS profile that the person config names, else the default AWS SDK credential chain. |
| Publish rule | `("packages/agentcore-pi", ("node_modules/",))`. |
| Capture | None. The capture switch of the prototype is removed. |

After approval, install the dependencies of the core from the kit root:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
```

The package tests need no AWS credential, SDK installation, or network. They use a fake core:

```sh
node --test packages/agentcore-pi/tests/
```

One test loads `index.ts` with the real core in a separate process. It runs only when `packages/agentcore-memory-core/src/index.mjs` exists, and it sends no AWS request.

Not verified: live AWS calls, IAM enforcement, clean-client installation, or loading this package in a generated Pi session.

## AgentCore memory core (`packages/agentcore-memory-core`)

The core of the shared AgentCore Memory for several people. It is a library, not a kit component: no manifest entry names it. The Pi extension, the Claude Code plugin and the registry script import it by a relative path. The review CLI is part of the package.
The contract is `src/types.ts`; `src/index.mjs` implements it. The package also holds the review CLI `bin/agentcore-memory.mjs` and offline tests with fake clients.
The design and its security review are in [the shared memory security document](shared-memory-security.md). The package README is `packages/agentcore-memory-core/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/agentcore-memory-core`, own code. |
| License | The repository MIT license covers this code. |
| Node | `>=24.0.0 <25`. |
| Dependency | `@aws-sdk/client-bedrock-agentcore` `3.1152.0`, with a lock file. The Pi extension and the Claude Code plugin get the SDK through the core. |
| AWS actions | `RetrieveMemoryRecords`, `ListMemoryRecords`, `BatchCreateMemoryRecords` and `BatchUpdateMemoryRecords`. No delete action. |
| Tests | `npm --prefix packages/agentcore-memory-core ci --ignore-scripts`, then `node --test packages/agentcore-memory-core/tests/`. No AWS credential, no network. |
| Publish rule | `("packages/agentcore-memory-core", ("node_modules/",))`. |

Not verified: the core against a live store, until the live proof after the four implementation tickets.

## AgentCore memory Claude Code plugin (`packages/agentcore-claude`)

A Claude Code plugin for the shared AgentCore Memory of several people. A `UserPromptSubmit` hook recalls records for each prompt. A stdio MCP server `agentcore-memory` has the tools `memory_propose`, `memory_list_proposals`, `memory_show_proposal`, `memory_approve` and `memory_reject`. Both import the core package; the plugin holds no AWS logic. It is not a kit component: no manifest entry names it.
The package README is `packages/agentcore-claude/README.md`. The security review is in [the shared memory security document](shared-memory-security.md).

| Item | Value |
| --- | --- |
| Source | `packages/agentcore-claude`, own code. |
| License | The repository MIT license covers this code. |
| Node | `>=24.0.0 <25`. |
| Dependencies | `@modelcontextprotocol/server` `2.3.1` and `zod` `4.6.7`, pinned with a lock file. The core package brings `@aws-sdk/client-bedrock-agentcore`. |
| Core | Imported by the relative path `../agentcore-memory-core/src/index.mjs`. The plugin works only when Claude Code loads it in place, for example with `--plugin-dir`. |
| Confirmation | The permission dialog of Claude Code. The three write tools carry `anthropic/requiresUserInteraction`. The plugin ships no permission allow entry. |
| Kill switch | `AGENTCORE_MEMORY_DISABLE=1`. |
| Publish rule | `("packages/agentcore-claude", ("node_modules/",))`. |

Install the core and the plugin from the kit root, then load the plugin for one session:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
npm --prefix packages/agentcore-claude ci --ignore-scripts
claude --plugin-dir packages/agentcore-claude
```

The package tests use a fake core and need no AWS credential and no network:

```sh
node --test packages/agentcore-claude/tests/
```

Not verified: the plugin with the real core, and every live AWS call.

## AgentCore memory admin (`packages/agentcore-memory-admin`)

The registry script of the shared AgentCore Memory. It is an owner tool, not a kit component: no manifest entry names it, and no profile loads it. It renders, from the private registry of the owner, one IAM user and one inline policy per person, the person config, the two service policies, the offboarding plan, the purge of rejected records and the one-time migration of the old owner namespace.
A dry run is the default and changes nothing. Only the coordinator runs the apply step, with the owner's admin login, after a dry run and the owner's word.
The design and its security review are in [the shared memory security document](shared-memory-security.md). The package README is `packages/agentcore-memory-admin/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/agentcore-memory-admin`, own code. The script is `bin/registry.mjs`. |
| License | The repository MIT license covers this code. |
| Node | `>=24.0.0 <25`. |
| Dependency | `@aws-sdk/client-iam`, `@aws-sdk/client-sts` and `@aws-sdk/client-bedrock-agentcore`, each `3.1152.0`, pinned with a lock file. |
| Core | Imported by the relative path `../../agentcore-memory-core/src/index.mjs`: the id rule, the namespace builder, the registry validation, the three scope functions and the person config. The script adds field names to a refusal and two registry rules (a duplicate PIN, a project without a maintainer). |
| Registry | The tracked `registry.example.json` holds the four example people only. The private registry stays outside every repository. |
| Credentials | The admin profile with `--apply --profile <admin>`; a dry run without `--profile` makes no AWS call. |
| Publish rule | `("packages/agentcore-memory-admin", ("node_modules/",))`. |

Install the dependencies and run the tests from the kit root:

```sh
npm --prefix packages/agentcore-memory-admin ci --ignore-scripts
node --test packages/agentcore-memory-admin/tests/
```

The tests use fake IAM, STS and memory clients. They need no AWS credential and no network.

Not verified: every apply step against IAM and the live store, until the live proof of the shared memory.

## OpenViking extension (`packages/openviking-pi`)

A vendored copy of the OpenViking memory extension for Pi. It sends session turns to an OpenViking server and adds memories from that server to each prompt. The package README is `packages/openviking-pi/README.md`; `DESIGN.md` beside it describes the modules.

| Item | Value |
| --- | --- |
| Source | `packages/openviking-pi`, vendored from a fork of OpenViking's `examples/pi-coding-agent-extension`; fork commit `5f25a844` (`5f25a8445fe0c36db4ca72cc5430bd3ed1166914`); package version 0.4.9 |
| Upstream base | `b20f192e` (`b20f192e61393e10fc9945306edf69fc25a58abe`), the merge base with upstream. The fork commit is not a commit of the public `volcengine/OpenViking` repository. |
| License | Apache-2.0 covers upstream `examples/`; its `examples/LICENSE` is vendored as `packages/openviking-pi/LICENSE`. The OpenViking repository root uses AGPL-3.0. |
| Node | `>=24.0.0` (`engines` in `packages/openviking-pi/package.json`); the kit range is narrower |
| Dependency | `@modelcontextprotocol/client` `2.2.0`, from the committed `package-lock.json` |
| `shared/` | Committed source: the output of `examples/memory-plugin-shared/sync.mjs` at the same commit. It is not build output, and no rule of `scripts/publish_check.py` treats it as build output. |
| Publish rule | `("packages/openviking-pi", ("node_modules/", "LICENSE"))`; `packages/openviking-pi/LICENSE` is explicit in `PUBLISH`. |
| Kit module | `openviking`; fields, consent, outputs and the refresh steps are in [the memory modules](memory-modules.md#openviking-what-the-vendored-source-does) |

The fork edits 14 files relative to `examples/pi-coding-agent-extension/`:

- `README.md`
- `config.ts`
- `index.ts`
- `lib/capture-adapter.mjs`
- `lib/capture-utils-local.mjs`
- `package-lock.json`
- `package.json`
- `skills/openviking-memory/SKILL.md`
- `skills/openviking-skills/SKILL.md`
- `skills/ov-experience-memory/SKILL.md`
- `sync.ts`
- `tests/capture-adapter.test.mjs`
- `tests/config.test.mjs`
- `tests/sync-barrier.test.mjs`

Its five behaviour changes are:

- Context takeover defaults off and requires explicit activation.
- Tool-result capture defaults off; tool inputs and outputs receive credential redaction in both states.
- Keyword capture keeps only turns that match a durable-memory trigger.
- Additive mode persists the capture watermark across resume. Session creation and reads use `auto_create` and fail closed on errors.
- The extension discovers three bundled skills through `resources_discover` when `mcpEnabled` is on.

The fork also raises the Node minimum to 24 and pins `@modelcontextprotocol/client` to `2.2.0`.

The [package banner](../packages/openviking-pi/README.md) separates these fork changes from kit changes, the vendored licence, and generated shared files.
The kit also guards user-only recall for Pi 1.2.0 and carries lifecycle tests, updated handshake fixtures, and a local recall-test helper.

`PATTERN_ALLOW` in `scripts/publish_check.py` holds the exact text of three reviewed lines of the package that match `PATTERNS` and hold no secret: one line in `shared/credentials.mjs` and the same line in `shared/plugin-config.mjs` copy a property that says whether a key is set, and one line of `tests/config.test.mjs` names an environment variable.

### Install step and tests

A generated profile loads the package by its path. Install its one dependency in the clone before the first start:

```sh
cd packages/openviking-pi
npm ci --ignore-scripts
```

The package has a test suite under `tests/`; `package.json` has no `test` script.
Use `scripts/pi_update.py qualify` from the kit root to install isolated candidate dependencies and run every package test.
The lifecycle tests need the candidate Pi SDK, beyond the one runtime dependency installed above.
The qualifier selects candidate session and transcript helpers explicitly. It excludes no test file.
The recall test includes its own loopback helper and needs no external checkout.

The files under `scripts/` are not repository checks: `e2e-live.mjs` and `e2e-live.sh` need a live server, a Pi and a model.
`setup.mjs` writes credentials to `~/.openviking/`.

Historical evidence from Pi 1.1.0: the generated local-file `packages` entry resolves and loads the OpenViking extension.
At that version, the kit test checks the installed resolver and rejects the former directory form. A no-model start confirms `/viking` registration.
With the Pi pin from `runtime.piVersion` in `config/manifest.json`, the package tests pass in isolated qualification.
A network-blocked resolver and factory-load check also passes.
It checks the selected file source, rejects the directory source, and confirms registration without starting a live session.
The package stays at its kit path for dependency resolution. The generated profile needs no wrapper or extra file.
Full strict OpenViking typing still reports four baseline diagnostics: two missing JavaScript declarations, recall-option typing, and MCP schema typing.
The lifecycle callback passes strict typing against Pi 1.2.0; the unchanged baseline diagnostics remain outside that proof.
Capture, recall and tools against a live server remain unverified.

Not verified: a generated profile connected to a live server, and `npm ci` on a clean client.
