# In-tree packages

`packages/tenantext` holds the source of the optional Pi package. `packages/openviking-pi` holds a vendored copy of the OpenViking extension for Pi; it is the `openviking` memory module. `packages/agentcore-pi` holds the AgentCore Memory extension for Pi on the shared memory core: recall before each typed prompt and the confirmed propose tool `agentcore_propose`; it is the optional `agentcore` memory module. `packages/agentcore-memory-core` holds the shared memory core for several people: the contract, its implementation and the review CLI. `packages/agentcore-claude` holds the Claude Code plugin of the shared memory: a recall hook and an MCP server with the propose and review tools. `packages/agentcore-memory-admin` holds the registry script of the shared memory, an owner tool.
Each package has its own license metadata, tests and documentation. Each package names its Node range in the `engines` field of its `package.json`. Tenantext pins `@types/node` to a version of the Node line of that range.

## Kit components

Each extension and each skill of the packages is one component in `config/manifest.json`. The components `coordinator-skills` and `knowledge-skills` each hold several skills. The source kind is `tree`: `{"kind": "tree", "path": "packages/<name>"}`. The core install loads every component of `packages/tenantext`: `install.sh` names the package directory in the profile settings. The qualification of the kit resolves and loads each extension and skill of that package in a profile of `install.sh`, with no session and no `node_modules` of the package. Observed with Pi 0.99.1: a profile with the extension and skill components tested on that version starts and loads the extensions after `npm ci --ignore-scripts` in `packages/tenantext`; without that step the load fails on the missing `yaml` module. Not verified: the same on the kit pin in `config/manifest.json`, key `runtime.piVersion`, or on a clean client. This observation does not cover `resources`. Not verified: a profile with `resources` starts and loads the extension.

`config/manifest.json` holds the path, the resource paths, the requirements, the status and the gaps of each component, and each folder under `packages/` holds the code of one package.

Facts of the components:

- `herdr-relay` needs the herdr skill at `~/.agents/skills/herdr`, or the folder of `HERDR_SKILL_HOME`. No component requires it. A kit without the relay directory remains valid, as for the folder of each `tree` component.
- `herdr-watch` starts a task session in a Herdr pane, or prompts a pane, and delivers the reply as a task notification. In Pi with the component, the watch is the default way to start a task session and to prompt a pane. The `herdr` command, Python 3 and the herdr skill scripts are host tools that the kit does not install. [The extension document](../packages/tenantext/docs/herdr-watch.md) names its tools. Not verified: a load of the component with the kit pin, and a live session with a Herdr pane.
- An `unverified` component names its gaps in the manifest: the facts that no test proves.
- `openviking` is a memory module and one `pi install` line: its local-file source is `packages/openviking-pi/index.ts`. See [the memory modules](memory-modules.md).
- `herdr` holds the skill only. The Herdr application is a host tool: the kit does not install it. See [Herdr and the question tool](herdr-setup.md).
- `questions` is not an in-tree package. Its source is the npm package of its `source.spec` in `config/manifest.json`, at an exact version. Its entry names its gaps. The settings template of the core install declares it.
- A profile declares each package one time in `settings.packages`. The `source` of Tenantext is the absolute package directory path; OpenViking and AgentCore use their `index.ts` files. A package entry with filters loads only the named resources; see [the package README](../packages/tenantext/README.md#one-extension).
- The profile depends on the location of the kit. If you move the kit, change the paths of `settings.packages`.
- The `env` list of each component in `config/manifest.json` names the environment variables that it reads. `coordinator-skills` sends its token to the API of the issue tracker; see [the issue tracker document](agents/issue-tracker.md).
- `ops-footer` and `doctor` import files of other extensions of the package. The import of a file does not need the other component to be enabled. The only runtime import of `ops-footer` is a file import of `context-meter/service.ts`. `ops-footer` and `context-meter` exchange ownership events. The manifest keeps `context-meter` as a requirement of `ops-footer`: this is a safe choice, not a proven need. Not verified: the behaviour of `ops-footer` and `doctor` when the other extensions are off.
- `resources` adds the `/resources` command. The command shows the extensions, skills, prompts and MCP servers of the agent directory, turns each one on or off, and saves named profiles. `docs/resources.md` has the command and the settings syntax. The component declares no environment variable. It follows the reviewed resource settings syntax. Not verified: a load of the component with the kit pin.
- The extensions of `packages/tenantext` need no `node_modules/` at load time. OpenViking and AgentCore need `npm ci --ignore-scripts` before their first start; see [the memory modules](memory-modules.md).

## Decision-server credential

`context-meter` reads the variable named by `nextMoveKeyEnv`; its default is `TENANTEXT_NEXT_MOVE_KEY` (source reading).
The key goes in the Bearer header of a POST to `nextMoveUrl`, when that URL is set.
The default URL is empty.
The component also sends session counters and the last 300 characters of the last user message, after whitespace normalization (source reading).

Not verified: these requests in a Pi profile.

## Tenantext (`packages/tenantext`)

Tenantext is a Pi extension suite with a Claude Code plugin under `claude-code/`. The package README is `packages/tenantext/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/tenantext` |
| Claude Code plugin | `claude-code/`; `build-skills.py` builds `herdr` from the package source skill |
| License | MIT, `packages/tenantext/LICENSE`; third-party notices in `packages/tenantext/THIRD_PARTY_NOTICES.md` and `packages/tenantext/licenses/` |

### Publish set

`PUBLISH_DIRS` in `scripts/publish_check.py` publishes tracked package files except installed dependencies and build output.
A maintainer can keep reviewed private-copy exclusions in an optional list; see [publishing](publishing.md#adding-a-file-to-the-portable-set).
The list and the excluded files are absent from a portable copy. No list is necessary there.

`docs/publishing.md` describes the rule format.

`PATTERN_ALLOW` in `scripts/publish_check.py` holds the exact text of reviewed package lines that match a token pattern of the publish check and hold no secret, for example a line that names an environment variable. An exception is the exact line text in one file, not a line number. A changed line is a new finding.

### Tests

Run the tests from the package directory. `npm ci` reads the committed `package-lock.json`.

```sh
cd packages/tenantext
npm ci --ignore-scripts
npm test
npm run typecheck
```

The three Pi packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) are optional peer dependencies. The lock file does not install them. Test files and the typecheck import them, so link them from the host Pi installation first. `G` is the `@earendil-works` directory of the global Node modules:

```sh
mkdir -p node_modules/@earendil-works
ln -sfn "$G/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$G/pi-coding-agent/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -sfn "$G/pi-coding-agent/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
```

`python3 scripts/check.py` runs these suites when a file of the package changes, and `--all` runs them always. Without the dependencies or the links, it fails with a line that points to this step.

A host can have more than one global Node modules directory, with a different Pi version in each. The links decide which Pi the tests use, so read the version of the linked package before a run:

```sh
node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"
```

Two tests need Pi `1.0.1` or later, because they compare the project MCP override with the code of Pi. One is in `test/resources-inventory.test.ts`; its name ends with `agrees with the Pi loader`. One is in `test/resources-writers.test.ts`; its name ends with `as Pi does`. Observed: with links to a Pi `0.99.1`, these two tests fail while the remaining package tests pass. Pi `0.99.1` has no project override, and its `updateMcpServerConfig()` has no fourth parameter. With links to Pi `1.0.2` and with links to Pi `1.0.3`, the package tests pass. The fix is new links to a Pi `1.0.1` or later. It is not a change of the tests.

A Pi from `npm install --prefix <dir>` without `--global` has the three packages side by side in `<dir>/node_modules/@earendil-works`. Link each one from there.

`scripts/publish_check.py` ignores each `node_modules/` directory, so `packages/tenantext/node_modules/` can stay. A tracked file under `node_modules/` fails the check with `tracked_in_node_modules`.

## AgentCore Memory extension (`packages/agentcore-pi`)

This package connects Pi to the shared AgentCore Memory of several people. It changes no local memory store.
OpenViking stays the primary memory. AgentCore is an optional module: one `pi install` line, and `AGENTCORE_MEMORY_CONFIG_FILE` at the start of Pi.
The extension recalls before each typed prompt and adds the tool `agentcore_propose`, which writes only after the person confirms.
See [the memory guide](memory-modules.md#agentcore-memory), [the security document](shared-memory-security.md) and [the package README](../packages/agentcore-pi/README.md).

| Item | Value |
| --- | --- |
| Source | Own code at `packages/agentcore-pi/index.ts`, loaded after OpenViking as a local-file source. |
| License | The repository MIT license covers this code. |
| Dependency | None of its own. It imports the core `packages/agentcore-memory-core` by a relative path; the lock file of the core installs `@aws-sdk/client-bedrock-agentcore`. |
| Configuration | The person config file. The start line names it in process-local `AGENTCORE_MEMORY_CONFIG_FILE` and removes an inherited `AGENTCORE_MEMORY_CONFIG`. No credential is rendered. |
| Credentials | The AWS profile that the person config names, else the default AWS SDK credential chain. |
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

Not verified: live AWS calls, IAM enforcement, clean-client installation, or loading this package in a Pi session.

## AgentCore memory core (`packages/agentcore-memory-core`)

The core of the shared AgentCore Memory for several people. It is a library, not a kit component: no manifest entry names it. The Pi extension, the Claude Code plugin and the registry script import it by a relative path. The review CLI is part of the package.
The contract is `src/types.ts`; `src/index.mjs` implements it. The package also holds the review CLI `bin/agentcore-memory.mjs` and offline tests with fake clients.
The design and its security review are in [the shared memory security document](shared-memory-security.md). The package README is `packages/agentcore-memory-core/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/agentcore-memory-core`, own code. |
| License | The repository MIT license covers this code. |
| Dependency | `@aws-sdk/client-bedrock-agentcore` at the exact version of `package.json`, with a lock file. The Pi extension and the Claude Code plugin get the SDK through the core. |
| AWS actions | `RetrieveMemoryRecords`, `ListMemoryRecords`, `BatchCreateMemoryRecords` and `BatchUpdateMemoryRecords`. No delete action. |
| Tests | `npm --prefix packages/agentcore-memory-core ci --ignore-scripts`, then `node --test packages/agentcore-memory-core/tests/`. No AWS credential, no network. |

Not verified: the core against a live store, until the live proof of the shared memory.

## AgentCore memory Claude Code plugin (`packages/agentcore-claude`)

A Claude Code plugin for the shared AgentCore Memory of several people. A `UserPromptSubmit` hook recalls records for each prompt. A stdio MCP server `agentcore-memory` has the propose and review tools; the package README names them. Both import the core package; the plugin holds no AWS logic. It is not a kit component: no manifest entry names it.
The package README is `packages/agentcore-claude/README.md`. The security review is in [the shared memory security document](shared-memory-security.md).

| Item | Value |
| --- | --- |
| Source | `packages/agentcore-claude`, own code. |
| License | The repository MIT license covers this code. |
| Dependencies | `@modelcontextprotocol/server` and `zod` at the exact versions of `package.json`, with a lock file. The core package brings `@aws-sdk/client-bedrock-agentcore`. |
| Core | Imported by the relative path `../agentcore-memory-core/src/index.mjs`. The plugin works only when Claude Code loads it in place, for example with `--plugin-dir`. |
| Confirmation | The permission dialog of Claude Code. Each tool that writes carries `anthropic/requiresUserInteraction`. The plugin ships no permission allow entry. |
| Kill switch | `AGENTCORE_MEMORY_DISABLE=1`. |

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
| Dependency | `@aws-sdk/client-iam`, `@aws-sdk/client-sts` and `@aws-sdk/client-bedrock-agentcore` at the exact versions of `package.json`, with a lock file. |
| Core | Imported by the relative path `../../agentcore-memory-core/src/index.mjs`, for the shared rules of ids, namespaces, the registry and the person config. |
| Registry | The tracked `registry.example.json` holds example people only. The private registry stays outside every repository. |
| Credentials | The admin profile with `--apply --profile <admin>`; a dry run without `--profile` makes no AWS call. |

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
| Source | `packages/openviking-pi`, vendored from a fork of OpenViking's `examples/pi-coding-agent-extension`. The banner of [the package README](../packages/openviking-pi/README.md) records the fork commit, the upstream merge base, the package version, the changed files and the behaviour changes. |
| License | Apache-2.0 covers upstream `examples/`; its `examples/LICENSE` is vendored as `packages/openviking-pi/LICENSE`. The OpenViking repository root uses AGPL-3.0. |
| Node | The `engines` range of the package is wider than the kit range. |
| Dependency | `@modelcontextprotocol/client` at the exact version of `package.json`, from the committed `package-lock.json` |
| `shared/` | Committed source: the output of `examples/memory-plugin-shared/sync.mjs` at the same commit. It is not build output, and no rule of `scripts/publish_check.py` treats it as build output. |
| Kit module | `openviking`; fields, consent, outputs and the refresh steps are in [the memory modules](memory-modules.md#openviking-what-the-vendored-source-does) |

The banner also separates the fork changes from the kit changes, the vendored licence and the generated shared files.

### Install step and tests

A profile loads the package by its path. Install its one dependency in the clone before the first start:

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

Historical evidence from Pi 1.1.0: the local-file `packages` entry resolves and loads the OpenViking extension.
At that version, the kit test checks the installed resolver and rejects the former directory form. A no-model start confirms `/viking` registration.
With the Pi pin from `runtime.piVersion` in `config/manifest.json`, the package tests pass in isolated qualification.
A network-blocked resolver and factory-load check also passes.
It checks the selected file source, rejects the directory source, and confirms registration without starting a live session.
The package stays at its kit path for dependency resolution. The profile needs no wrapper or extra file.
Full strict OpenViking typing still reports baseline diagnostics: missing JavaScript declarations, recall-option typing, and MCP schema typing.
The lifecycle callback passes strict typing against Pi 1.2.0; the unchanged baseline diagnostics remain outside that proof.
Capture, recall and tools against a live server remain unverified.

Not verified: a profile connected to a live server, and `npm ci` on a clean client.
