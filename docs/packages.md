# In-tree packages

`packages/tenantext` and `packages/promptr` hold the sources of the two optional Pi packages. `packages/openviking-pi` holds a vendored copy of the OpenViking extension for Pi; it is the `openviking` memory module. Each package has its own license metadata, tests and documentation.

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
| `coordinator-skills` | `packages/tenantext` | Each skill directory below `skills/coordinator-skills/`. `config/manifest.json` names them; [the component README](../packages/tenantext/skills/coordinator-skills/README.md) lists them | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `knowledge-skills` | `packages/tenantext` | Each skill directory below `skills/knowledge-skills/`. [The component README](../packages/tenantext/skills/knowledge-skills/README.md) lists them | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `slopscore-pr` | `packages/tenantext` | `skills/slopscore-pr` | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `tracker-site` | `packages/tenantext` | `skills/tracker-site` | `core` | `unverified` | `host_tool_required` (Git on `PATH`; Python 3.11 or later is checked), `pi_line_unqualified`, `kit_test_missing` |
| `promptr` | `packages/promptr` | `index.ts` | `core` | `unverified` | `build_step_required`, `host_module_dependency`, `placeholder_defaults`, `private_renderer_adapters`, `automatic_dispatch_path_unverified`, `kit_test_missing` |
| `promptr-generate-task-prompt` | `packages/promptr` | `skills/promptr-generate-task-prompt` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-handoff` | `packages/promptr` | `skills/promptr-handoff` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-openknowledge-project-pages` | `packages/promptr` | `skills/openknowledge-project-pages` | `core`, `promptr` | `unverified` | `host_service_required`, `skill_use_unverified`, `kit_test_missing` |
| `promptr-watch-herdr-agents` | `packages/promptr` | `skills/watch-herdr-agents` | `core`, `promptr` | `unverified` | `host_tool_required`, `skill_use_unverified`, `kit_test_missing` |
| `openviking` | `packages/openviking-pi` | `index.ts` | `core` | `unverified` | `install_step_required`, `server_required`, `package_runtime_unverified`, `kit_test_missing`, `capture_cost_unmeasured` |

Facts for a selection:

- An `unverified` component can be enabled. The plan lists each of its gaps as a readiness gap with the component ID as the subject.
- `openviking` is a memory module: it also needs `consent.memoryCapture`, `consent.remoteMemoryWrites` and a `memory.openviking` block. Its package declaration comes after the other in-tree packages. See [the memory modules](memory-modules.md).
- A `blocked` component cannot be enabled. The validator fails with `blocked_component`.
- A generated profile declares each package one time in `settings.packages`. The `source` is the absolute path of the package directory in this kit. Each enabled component adds only its own entry to the `extensions` or `skills` filter. An empty filter list loads nothing of that kind.
- The profile depends on the location of the kit. If you move the kit, generate a new profile.
- `codex-accounts` declares `TENANTEXT_LITELLM_BASE_URL` and `TENANTEXT_LITELLM_API_KEY`: `extensions/codex-accounts/routing.ts` reads both. `doctor` declares `TENANTEXT_LITELLM_BASE_URL`: `extensions/doctor/checks.ts` reads it for one information line. `coordinator-skills` declares `GITEA_TOKEN`: the skills `to-spec` and `to-tickets` send it to the Gitea API of the issue tracker.
- The gateway keys of the overlay are `endpoints.codex-accounts` and `env.codex-accounts`. The old key `tenantext` fails with `moved_key`.
- `ops-footer` and `doctor` import files of other extensions of the package. The import of a file does not need the other component to be enabled. The only runtime import of `ops-footer` is a file import of `context-meter/service.ts`. `ops-footer` and `context-meter` exchange ownership events. The manifest keeps `context-meter` as a requirement of `ops-footer`: this is a safe choice, not a proven need. Not verified: the behaviour of `ops-footer` and `doctor` when the other extensions are off.
- `resources` adds the `/resources` command. The command shows the extensions, skills, prompts and MCP servers of the agent directory, turns each one on or off, and saves named profiles. `docs/resources.md` has the command and the settings syntax. The component declares no environment variable. It follows the reviewed resource settings syntax. Not verified: a load of the component with the kit pin.
- Install the Node dependencies of a package before Pi loads it (the "Test" and "Build and test" commands below). Not verified: which components need `node_modules/` at load time.

## Tenantext (`packages/tenantext`)

Tenantext is a Pi extension suite with a Claude Code plugin under `claude-code/`. The package README is `packages/tenantext/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/tenantext` |
| Claude Code plugin | `claude-code/`, including the `herdr` and `slopscore-pr` skills |
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

Two tests need Pi `1.0.1` or later, because they compare the project MCP override with the code of Pi. One is in `test/resources-inventory.test.ts`; its name ends with `agrees with the Pi loader`. One is in `test/resources-writers.test.ts`; its name ends with `as Pi does`. Observed: with links to a Pi `0.99.1`, these two tests fail and 304 of 306 tests pass. Pi `0.99.1` has no project override, and its `updateMcpServerConfig()` has no fourth parameter. With links to Pi `1.0.2` and with links to Pi `1.0.3`, all 306 tests pass. The fix is new links to a Pi `1.0.1` or later. It is not a change of the tests.

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
| Pi version | The package pins `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` `1.0.4`. The build, the 756 tests, the typecheck and `npm run smoke` pass with both dependencies at 1.0.4. Not verified on 1.0.4: `npm run smoke:installed`, a package load in Pi, or a session with a model. |

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

A generated profile loads `packages/promptr` by its path, so the build must be in the clone: run `npm ci --ignore-scripts` and `npm run build` there before the first start. Pi 1.0.2 and Pi 1.0.3 print one warning at each start, because `@earendil-works/pi-tui` is under `dependencies`. The companion process needs that copy. For the built files, Pi also loads that second copy of `pi-tui` (verified on 1.0.2). Both copies were 1.0.2 then. The package now pins 1.0.4, matching the kit pin. Pi's caret dependency can still select a later `pi-tui`.
The version-specific evidence is in [the Promptr matrix](workflow-modules.md#promptr-unverified-with-a-readiness-matrix). Not verified: interactive key handling on 1.0.4.

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

## OpenViking extension (`packages/openviking-pi`)

A vendored copy of the OpenViking memory extension for Pi. It sends session turns to an OpenViking server and adds memories from that server to each prompt. The package README is `packages/openviking-pi/README.md`; `DESIGN.md` beside it describes the modules.

| Item | Value |
| --- | --- |
| Source | `packages/openviking-pi`, vendored from a fork of OpenViking's `examples/pi-coding-agent-extension`; fork commit `e9b05366` (`e9b053666a52fd02975017f0dc56e59719ff5529`); package version 0.4.3 |
| Upstream base | `c9a869cb` (`c9a869cb145aac98f4be1586da32174d220c8800`), the merge base with upstream. The fork commit is not a commit of the public `volcengine/OpenViking` repository. |
| License | Apache-2.0 covers upstream `examples/`; its `examples/LICENSE` is vendored as `packages/openviking-pi/LICENSE`. The OpenViking repository root uses AGPL-3.0. |
| Node | `>=22.19.0` (`engines` in `packages/openviking-pi/package.json`); the kit range is narrower |
| Dependency | `@modelcontextprotocol/client` `2.0.0`, from the committed `package-lock.json` |
| `shared/` | Committed source: the output of `examples/memory-plugin-shared/sync.mjs` at the same commit. It is not build output, and no rule of `scripts/publish_check.py` treats it as build output. |
| Publish rule | `("packages/openviking-pi", ("node_modules/", "LICENSE"))`; `packages/openviking-pi/LICENSE` is explicit in `PUBLISH`. |
| Kit module | `openviking`; fields, consent, outputs and the refresh steps are in [the memory modules](memory-modules.md#openviking-what-the-vendored-source-does) |

The fork edits nine files relative to `examples/pi-coding-agent-extension/`: `README.md`, `config.ts`, `index.ts`, `sync.ts`, `lib/capture-adapter.mjs`, `lib/capture-utils-local.mjs`, `tests/capture-adapter.test.mjs`, `tests/config.test.mjs`, and `tests/sync-barrier.test.mjs`.

Its four behaviour changes are:

- Context takeover defaults off and requires explicit activation.
- Tool-result capture defaults off; tool inputs and outputs receive credential redaction in both states.
- Keyword capture keeps only turns that match a durable-memory trigger.
- Additive mode persists the capture watermark across resume. Session creation and reads use `auto_create` and fail closed on errors.

The [package banner](../packages/openviking-pi/README.md) separates these fork changes from kit-only README edits, the vendored licence, and generated shared files.

`PATTERN_ALLOW` in `scripts/publish_check.py` holds the exact text of three reviewed lines of the package that match `PATTERNS` and hold no secret: one line in `shared/credentials.mjs` and the same line in `shared/plugin-config.mjs` copy a property that says whether a key is set, and one line of `tests/config.test.mjs` names an environment variable.

### Install step and tests

A generated profile loads the package by its path. Install its one dependency in the clone before the first start:

```sh
cd packages/openviking-pi
npm ci --ignore-scripts
```

The package has a test suite under `tests/`; `package.json` has no `test` script, so the command is `node --test tests/*.test.mjs` after the install step. The kit checks do not run it. One file, `tests/recall-deferred.test.mjs`, imports a helper from `examples/memory-plugin-shared/testing/` of the OpenViking repository. That helper is not in the kit copy, so this file fails to load here and passes only in an OpenViking checkout. The files under `scripts/` are not repository checks: `e2e-live.mjs` and `e2e-live.sh` need a live server, a Pi and a model, and `setup.mjs` writes credentials to `~/.openviking/`.

Not verified: a start of a generated profile with this package, and `npm ci` on a clean client.
