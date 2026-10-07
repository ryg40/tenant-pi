# Pure profile preparation

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

`prepare(manifest_data, overlay_data, *, registry=None, required_roles=(), credential_names=frozenset())` accepts only in-memory inputs. It validates the manifest and overlay before rendering. It reads no files, environment values, or host catalog. `registry` is the strict pure-route capability map `{provider: {model: [thinkingLevels]}}`. A selected `modelRoutes` model needs this separate explicit map. Core-only, legacy, and empty-choice overlays do not need it. No registry is converted to Pi `models.json`. `required_roles` contains only distinct reviewed role names. `credential_names` contains only selected component-declared names, not values.

The pure renderer in `scripts/model_routes.py` owns model and gateway rules. Its `settings` contribution supplies only reviewed Pi defaults, ordered `enabledModels`, and exact `modelThinkingLevels`. Provider and model stay separate in private choices; slash IDs round-trip. Legacy core/role overlays still work without a registry but have unverified availability. Legacy choices cannot use reserved `litellm-codex`, or `openai-codex-2` without `codex-accounts`. New `modelRoutes` choices require the explicit registry and route checks. Non-interactive role selections stay inert metadata. A required role without a selected model remains missing; it never activates a downstream module.

The plan has `schemaVersion`, `targetAgentDir`, `files`, `commands`, and `readinessGaps`. Output paths are only `settings.json` and `.tenant-pi/choices.json`. Each uses mode `0600`. Core settings retain `defaultProjectTrust: "ask"` and disable telemetry and analytics. A selection of in-tree components adds one local-path package declaration per package to `settings.packages`. Each declaration holds the filter of each enabled component and explicit empty lists for the other resource kinds. It does not install or run the package. Other optional modules cannot be selected until qualified.

Private `choices.json` holds validated overlay, pinned manifest, optional registry and its integrity digest, required role names, credential names, route result, role status, and pending package list. The digest detects accidental registry edits; it does not authenticate user-declared capability evidence. The writer independently rebuilds the plan from these inputs before mutation. Package source, filters, setup strings, readiness gaps, and route claims cannot be replaced without rejection unless the entire input evidence is deliberately replaced; capability truth remains a runtime question.

`commands.setup` is a display-only pinned core npm instruction. `commands.launch` is a single display-only process-local Pi invocation: `env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=<quoted target> pi --no-approve`. The `env -u` part removes an inherited session directory (see [the launcher file](launcher.md)). With a gateway it prefixes `TENANTEXT_LITELLM_BASE_URL=<quoted URL>` on that same line. It never includes a resolved key or an executable `/login` instruction. The gateway env-key path requires the user to supply `TENANTEXT_LITELLM_API_KEY` to that same process; the login alternative reports `pi_login_blocked` in preview; the CLI refuses to generate it. `readinessGaps` always distinguishes file preparation from unverified runtime, package, provider, model catalog, authentication, gateway upstream, and missing required roles. A model listed only in `modelRoutes.cycle` gets `model_catalog_unverified` and `provider_auth_unverified` gaps with the subject `cycle:<provider>/<model>`; a model already selected by a role is reported under that role only. No plan authenticates or tests a provider.

## Readiness after measured facts

The plan of `prepare` starts with three fixed gaps: `target_absence_unverified`, `node_runtime_unverified` and `core_runtime_unverified`. The reason is the rule above. `prepare` opens no file and starts no process, so it cannot know the target directory or an installed version. The writer rebuilds the plan from the private record and refuses a plan that differs. A plan that held a measurement of the host would fail that check, and two machines would get different files from the same choices. So the plan keeps the three gaps.

`readiness(plan, *, report=None, generated=False)` gives the gaps that `plan` and `generate` print. It is pure and it does not change the plan. It applies two facts that the caller has:

| Fact | Where it comes from | Effect |
| --- | --- | --- |
| The target was absent | `generate`, after the writer created the target. The exclusive directory creation of the writer is the proof. | `target_absence_unverified` leaves the list. `plan` writes nothing and proves nothing about the target, so its output keeps the gap. |
| The installed Node and Pi versions | The report of `check-runtime`, given as a file with `--runtime-report` | The two runtime gaps follow the status of the report; see the next table. |

| Status in the report | Node gap | Pi gap |
| --- | --- | --- |
| No report | `node_runtime_unverified` | `core_runtime_unverified` |
| `match` | none | none |
| `untested_in_range` | invalid for Node | `core_runtime_untested_in_range` |
| `mismatch` | `node_runtime_mismatch` | `core_runtime_mismatch` |
| `missing` | `node_runtime_missing` | `core_runtime_missing` |
| `unparsed` | `node_runtime_unparsed` | `core_runtime_unparsed` |

A gap from the report keeps the `subject` of the plan gap and has two more keys, `installed` and `required`. `installed` is `null` for `missing` and `unparsed`. This schematic example uses `<newer version>` for an installed version newer than `<pin>`:

```json
{"code": "core_runtime_mismatch", "subject": "@earendil-works/pi-coding-agent@<pin>", "installed": "<newer version>", "required": "<pin>"}
```

An accepted, untested Pi keeps a gap with `installed`, `tested`, `acceptedRange` and `fact`, plus the existing `required` field.
A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.
The `fact` says: "The installed Pi is accepted by the range rule. The kit tests ran on the tested version only."

```json
{"code":"core_runtime_untested_in_range","subject":"@earendil-works/pi-coding-agent@<pin>","installed":"<newer accepted version>","required":"<pin>","tested":"<pin>","acceptedRange":"<accepted range>","fact":"The installed Pi is accepted by the range rule. The kit tests ran on the tested version only."}
```

With the `herdr` component, the plan adds `herdr_cli_unverified` and `herdr_session_unverified` with the subject `herdr`. A `check-herdr` report through `--herdr-report` changes the first one only; see [Herdr and the question tool](herdr-setup.md#verification-results).

The `python` entry of the report adds no gap. Python runs the kit, not the profile. No other gap changes: no kit action measures a package, a model catalog, a provider login or a gateway.

`runtimeReady` is always `false`: this kit has no live trial of a generated profile. The measured facts are in `readinessGaps`: an empty list after a complete generation says that the kit knows no open gap before the launch. An empty list is not a launch proof and it is not the label `ready` of [the setup guide](guides/setup.md#labels-for-a-prerequisite): the report compares version numbers only.

### The report file

`plan` and `generate` start no process and do not run the probe themselves. `check-runtime` and `check-herdr` are the only actions that start a process. The caller runs `check-runtime` first and gives its output as a file:

```sh
python3 scripts/tenant_pi.py check-runtime > /path/to/runtime.json
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --runtime-report /path/to/runtime.json
```

`check-runtime` exits with 0 for Pi `match` or `untested_in_range` when Node and Python match. A failed requirement gives exit code 1. The file holds the report in both cases.

`runtime_report(data, runtime)` validates the parsed file against `manifest.runtime` after the overlay is valid and before any write. A refusal exits with code 2 and creates no target.

| Diagnostic | Cause |
| --- | --- |
| `input_missing: runtime_report.file`, `invalid_json: runtime_report.file`, `input_not_regular: runtime_report.file`, `input_too_large: runtime_report.file` | The bounded no-follow loader of the other inputs refuses the file. An empty file gives `invalid_json` with `line` 1 and `column` 1. See [input file errors](generator.md#input-file-errors) for each rule. |
| `object`, `required_fields` or `unknown_fields`, with the field `runtime_report` or `runtime_report.<tool>` | The file must have exactly `pi`, `node` and `python`. Each entry has `installed`, `required` and `status`. Pi also requires `tested` and `acceptedRange`. |
| `runtime_report_required: runtime_report.<tool>.required`, `runtime_report.pi.tested` or `runtime_report.pi.acceptedRange` | A requirement differs from `manifest.runtime`. The report belongs to another tested version or range. |
| `runtime_report_status: runtime_report.<tool>.status` | The status is not valid for the tool, or it disagrees with the installed version, tested version or range. |
| `runtime_report_installed: runtime_report.<tool>.installed` | `installed` is not one version token of the `check-runtime` grammar, or it is `null` with `match`, `untested_in_range` or `mismatch`, or it has a value with `missing` or `unparsed`. |

Limits:

- The report is evidence that the caller supplies, like the registry. The kit cannot tell a current report from an old one, or from the report of another shell or machine. Make the report in the shell that will launch Pi, and make it again after each change of Node or Pi.
- The report changes the printed output only. `settings.json`, `.tenant-pi/choices.json` and `.tenant-pi/state.json` have the same content with and without it.
- A `match` is a version fact. It does not prove that Pi starts, loads a package or gets a model reply.

Tests: `tests/test_profile_plan.py` (`ReadinessTests`) covers no report, `match`, `untested_in_range`, `mismatch`, an absent Pi, `unparsed`, a profile with another gap and each refusal of the validator. `tests/test_cli.py` runs `plan` and `generate` with a report file while every process of the CLI is blocked, and compares the bytes of the generated files with and without a report. `tests/test_check_runtime.py` gives each report of `check` to the validator.

## The mark of the Pi install line

`commands.setup` of the plan starts with the global install line of the pinned Pi. One `pi` command serves every profile of the user, so this line changes Pi for all of them. When another Pi version is installed, the line replaces it. `setup_commands(plan, report=None)` gives the two values that `plan` and `generate` print in its place. It is pure and it does not change the plan.

- `commands.setupDisplayOnly`: the setup lines that are default steps.
- `commands.piInstall`: the global install line with its mark. The line is always there, so the reader sees what the kit pins.

| Pi status in the report | `status` | Line in `setupDisplayOnly` | `installed` | `change` |
| --- | --- | --- | --- | --- |
| No report, or `unparsed` | `installed_version_unknown` | yes | `null` | `null` |
| `missing` | `needed` | yes | `null` | `null` |
| `match` | `not_needed` | no | the version | `null` |
| `untested_in_range` | `not_needed` | no | the version | `null` |
| `mismatch`, installed Pi newer than the pin | `replaces_installed` | no | the version | `downgrade` |
| `mismatch`, installed Pi older than the pin | `replaces_installed` | no | the version | `upgrade` |
| `mismatch`, equal version order | `replaces_installed` | no | the version | `unordered` |

This schematic example uses `<newer version>` for an installed version newer than `<pin>`:

```json
{"command": "npm install --global -- @earendil-works/pi-coding-agent@<pin>", "status": "replaces_installed", "installed": "<newer version>", "required": "<pin>", "change": "downgrade", "warning": "global_install_replaces_pi_for_all_profiles"}
```

- `change` names what the line does to the installed Pi. The order uses the three numbers of each version. A prerelease is before its release, so `<pin>-beta.1` is older than `<pin>`.
- `warning` has the same value in each case: `global_install_replaces_pi_for_all_profiles`. It is a fact of the command, not of the report.
- With `untested_in_range`, the line stays a plain command with `not_needed` and `change: null`. It is not a replacement or a default step. The readiness gap records the test limit.
- With `replaces_installed` the line is not a default step. Stage 3 of `INSTALL.md` has the three choices: stop, keep the installed Pi and record the gap, or install the pin under a separate prefix. The kit prints no prefix line, because the user names the prefix.
- Without a report the kit does not know the installed version. The line stays in `setupDisplayOnly`, and `installed_version_unknown` tells the reader to run `check-runtime` first.
- The other setup lines (`pi update --extensions`, the peer override) do not change.

Tests: `tests/test_profile_plan.py` (`PiInstallTests`) covers no report, `match`, an accepted untested Pi, a newer installed Pi, an older installed Pi, an absent Pi, `unparsed`, a prerelease and a build text. `tests/test_cli.py` reads the mark from the output of `plan` and `generate`.

## The warning for a provider key variable

Rule: Pi reads a provider key from the environment of the launching shell, including in a profile with no login. A model reply can then come from a provider that you did not choose, and a test launch can send a request that you did not intend.

The `plan` action prints `commands.providerKeyWarning` when a known provider key variable is set in the environment of the plan run. Without such a variable, the key is absent.

```json
{"code": "provider_key_in_launching_environment", "fact": "Pi reads a provider key from the environment of the launching shell, including in a profile with no login. A model reply can come from a provider that you did not choose.", "remedy": "Name the model on the launch line: --model '<provider>/<model>'", "variables": ["OPENAI_API_KEY"]}
```

- `variables` holds the names that are set, in the order of the list below. It never holds a value.
- The known names are the constant `PROVIDER_KEY_NAMES` of `scripts/profile_plan.py`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `AZURE_OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `ZAI_API_KEY`.
- The list holds common names. It is not complete, so a plan without the warning does not prove that Pi finds no key.
- The plan tests each name for presence only. It does not read, compare or print the value. A variable with an empty value counts as set.
- `provider_key_warning(names)` is pure: the CLI gives it the names that are set, and no value reaches it. `prepare` reads no environment value, and the plan and the generated files stay the same with and without the warning.
- The warning is a fact of the shell that runs `plan`. Run `plan` in the shell that will launch Pi.
- The launch line and the launcher file do not clear these variables. The remedy is the `--model '<provider>/<model>'` form on the launch line, or a shell without the variable.
- `generate` and `validate` do not test the names and print no warning.

Not verified: which variable names Pi reads for each provider, and that Pi reads each name of the list.

Tests: `tests/test_profile_plan.py` (`ProviderKeyWarningTests`) covers a name list with two known names, each known name alone, and a list without a known name. `tests/test_cli.py` runs `plan` in a controlled environment with and without a variable and checks that no value is in the output.
