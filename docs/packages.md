# In-tree packages

`packages/tenantext` and `packages/promptr` hold the sources of the two optional Pi packages. Each package has its own license metadata, tests and documentation.

## Kit components

Each extension and each skill of the two packages is one component in `config/manifest.json`. The source kind is `tree`: `{"kind": "tree", "path": "packages/<name>"}`. The example overlay enables none of them. Observed with Pi 0.99.1: a profile with the extension and skill components tested on that version starts and loads the extensions after `npm ci --ignore-scripts` in `packages/tenantext`; without that step the load fails on the missing `yaml` module. Not verified: the same on Pi 1.0.3, the kit's pin, or on a clean client. This observation does not cover `resources`. Not verified: a profile with `resources` starts and loads the extension.

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
| `slopscore-pr` | `packages/tenantext` | `skills/slopscore-pr` | `core` | `unverified` | `pi_line_unqualified`, `host_tool_required`, `kit_test_missing` |
| `tracker-site` | `packages/tenantext` | `skills/tracker-site` | `core` | `blocked` | `python_package_required`, `pi_line_unqualified`, `kit_test_missing` |
| `promptr` | `packages/promptr` | `index.ts` | `core` | `unverified` | `build_step_required`, `host_module_dependency`, `placeholder_defaults`, `private_renderer_adapters`, `automatic_dispatch_path_unverified`, `kit_test_missing` |
| `promptr-generate-task-prompt` | `packages/promptr` | `skills/promptr-generate-task-prompt` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-handoff` | `packages/promptr` | `skills/promptr-handoff` | `core`, `promptr` | `unverified` | `skill_use_unverified`, `kit_test_missing` |
| `promptr-openknowledge-project-pages` | `packages/promptr` | `skills/openknowledge-project-pages` | `core`, `promptr` | `unverified` | `host_service_required`, `skill_use_unverified`, `kit_test_missing` |
| `promptr-watch-herdr-agents` | `packages/promptr` | `skills/watch-herdr-agents` | `core`, `promptr` | `unverified` | `host_tool_required`, `skill_use_unverified`, `kit_test_missing` |

Facts for a selection:

- An `unverified` component can be enabled. The plan lists each of its gaps as a readiness gap with the component ID as the subject.
- A `blocked` component cannot be enabled. The validator fails with `blocked_component`.
- A generated profile declares each package one time in `settings.packages`. The `source` is the absolute path of the package directory in this kit. Each enabled component adds only its own entry to the `extensions` or `skills` filter. An empty filter list loads nothing of that kind.
- The profile depends on the location of the kit. If you move the kit, generate a new profile.
- `codex-accounts` declares `TENANTEXT_LITELLM_BASE_URL` and `TENANTEXT_LITELLM_API_KEY`: `extensions/codex-accounts/routing.ts` reads both. `doctor` declares `TENANTEXT_LITELLM_BASE_URL`: `extensions/doctor/checks.ts` reads it for one information line.
- The gateway keys of the overlay are `endpoints.codex-accounts` and `env.codex-accounts`. The old key `tenantext` fails with `moved_key`.
- `ops-footer` and `doctor` import files of other extensions of the package. The import of a file does not need the other component to be enabled. The only runtime import of `ops-footer` is a file import of `context-meter/service.ts`. `ops-footer` and `context-meter` exchange ownership events. The manifest keeps `context-meter` as a requirement of `ops-footer`: this is a safe choice, not a proven need. Not verified: the behaviour of `ops-footer` and `doctor` when the other extensions are off.
- `resources` adds the `/resources` command. The command shows the extensions, skills, prompts and MCP servers of the agent directory, turns each one on or off, and saves named profiles. `docs/resources.md` has the command and the settings syntax. The component declares no environment variable. It uses the resource settings syntax of Pi 1.0.3, the kit pin. Not verified: a load of the component in a generated profile on Pi 1.0.3.
- Install the Node dependencies of a package before Pi loads it (the "Test" and "Build and test" commands below). Not verified: which components need `node_modules/` at load time.

## Tenantext (`packages/tenantext`)

Tenantext is a Pi extension suite with a Claude Code plugin under `claude-code/`. The package README is `packages/tenantext/README.md`.

| Item | Value |
| --- | --- |
| Source | `packages/tenantext` |
| License | MIT, `packages/tenantext/LICENSE`; third-party notices in `packages/tenantext/THIRD_PARTY_NOTICES.md` and `packages/tenantext/licenses/` |
| Node | `>=22.22.0 <23` (`engines` in `packages/tenantext/package.json`) |

### Publish set

`PUBLISH_DIRS` in `scripts/publish_check.py` publishes tracked package files except installed dependencies and build output.
A maintainer can keep reviewed private-copy exclusions in an optional list; see [publishing](publishing.md#adding-a-file-to-the-portable-set).
The list and the excluded files are absent from a portable copy. No list is necessary there.

The two pull request templates `.gitea/PULL_REQUEST_TEMPLATE.md` and `.github/PULL_REQUEST_TEMPLATE.md` are published: `slopscore/test/docs.test.ts` reads both, and the package test suite must pass in a portable clone.

`docs/publishing.md` describes the rule format.

`PATTERN_ALLOW` in `scripts/publish_check.py` holds the exact line text of two reviewed lines of the package that match `PATTERNS` and hold no secret. Line 43 of `extensions/codex-accounts/routing.ts` refers to the name of an environment variable, not to a value. Line 26 of `tracker/tests/test_publish.py` is a canary fixture of the tracker publish test, not a token. An exception is the exact line text in one file, not a line number. A changed line is a new finding.

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
| Pi version | The package pins `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` `1.0.2`. The build, the tests, the two smoke scripts and a start without a model are verified on that line. A session with a model is not verified. The kit pins Pi `1.0.3`. Not verified: the package on Pi `1.0.3`. |

### Build and test

Node `>=22.22.0 <23` is necessary.

```sh
cd packages/promptr
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
```

`node_modules/` and `dist/` are not tracked. `scripts/publish_check.py` ignores `node_modules/` and `packages/promptr/dist/`, and fails when a file under one of them is tracked.

Warning: `npm run install:local` and `npm run doctor` read or change the Pi directory of the host. Do not run them as a repository check. `npm run smoke:installed` installs into a new directory under the temporary directory and starts `pi` there without a prompt.

A generated profile loads `packages/promptr` by its path, so the build must be in the clone: run `npm ci --ignore-scripts` and `npm run build` there before the first start. Pi prints one warning at each start, because `@earendil-works/pi-tui` is under `dependencies`. The companion process needs that copy. For the built files, Pi also loads that second copy of `pi-tui` (verified on 1.0.2). Both copies were 1.0.2 then. With the kit pin 1.0.3 the copy of Pi is `pi-tui` 1.0.3 or later, and the two copies differ in the default keys of `Home` and `End`. Not verified: the effect on key handling.

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
