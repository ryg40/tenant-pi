# Pure profile preparation

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
| `mismatch` | `node_runtime_mismatch` | `core_runtime_mismatch` |
| `missing` | `node_runtime_missing` | `core_runtime_missing` |
| `unparsed` | `node_runtime_unparsed` | `core_runtime_unparsed` |

A gap from the report keeps the `subject` of the plan gap and has two more keys, `installed` and `required`. `installed` is `null` for `missing` and `unparsed`. Example, Pi `1.0.4` on a kit that requires `1.0.3`:

```json
{"code": "core_runtime_mismatch", "subject": "@earendil-works/pi-coding-agent@1.0.3", "installed": "1.0.4", "required": "1.0.3"}
```

The `python` entry of the report adds no gap. Python runs the kit, not the profile. No other gap changes: no kit action measures a package, a model catalog, a provider login or a gateway.

`runtimeReady` is always `false`: this kit has no live trial of a generated profile. The measured facts are in `readinessGaps`: an empty list after a complete generation says that the kit knows no open gap before the launch. An empty list is not a launch proof and it is not the label `ready` of [the setup guide](guides/setup.md#labels-for-a-prerequisite): the report compares version numbers only.

### The report file

`plan` and `generate` start no process and do not run the probe themselves. `check-runtime` stays the only action that starts a process. The caller runs it first and gives its output as a file:

```sh
python3 scripts/tenant_pi.py check-runtime > /path/to/runtime.json
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --runtime-report /path/to/runtime.json
```

`check-runtime` exits with 1 when a tool is not `match`. The file then holds the report all the same.

`runtime_report(data, runtime)` validates the parsed file against `manifest.runtime` after the overlay is valid and before any write. A refusal exits with code 2 and creates no target.

| Diagnostic | Cause |
| --- | --- |
| `input_missing: runtime_report.file`, `invalid_json: runtime_report.file`, `input_not_regular: runtime_report.file`, `input_too_large: runtime_report.file` | The bounded no-follow loader of the other inputs refuses the file. An empty file gives `invalid_json` with `line` 1 and `column` 1. See [input file errors](generator.md#input-file-errors) for each rule. |
| `object`, `required_fields` or `unknown_fields`, with the field `runtime_report` or `runtime_report.<tool>` | The file is not one object with exactly `pi`, `node` and `python`, each with exactly `installed`, `required` and `status`. |
| `runtime_report_required: runtime_report.<tool>.required` | `required` is not the value of `manifest.runtime`. The report belongs to another pin or range. |
| `runtime_report_status: runtime_report.<tool>.status` | The status is not one of the four status names, or it does not agree with `installed` and `required`. |
| `runtime_report_installed: runtime_report.<tool>.installed` | `installed` is not one version token of the `check-runtime` grammar, or it is `null` with `match` or `mismatch`, or it has a value with `missing` or `unparsed`. |

Limits:

- The report is evidence that the caller supplies, like the registry. The kit cannot tell a current report from an old one, or from the report of another shell or machine. Make the report in the shell that will launch Pi, and make it again after each change of Node or Pi.
- The report changes the printed output only. `settings.json`, `.tenant-pi/choices.json` and `.tenant-pi/state.json` have the same content with and without it.
- A `match` is a version fact. It does not prove that Pi starts, loads a package or gets a model reply.

Tests: `tests/test_profile_plan.py` (`ReadinessTests`) covers no report, `match`, `mismatch`, an absent Pi, `unparsed`, a profile with another gap and each refusal of the validator. `tests/test_cli.py` runs `plan` and `generate` with a report file while every process of the CLI is blocked, and compares the bytes of the generated files with and without a report. `tests/test_check_runtime.py` gives each report of `check` to the validator.

## The mark of the Pi install line

`commands.setup` of the plan starts with the global install line of the pinned Pi. One `pi` command serves every profile of the user, so this line changes Pi for all of them. When another Pi version is installed, the line replaces it. `setup_commands(plan, report=None)` gives the two values that `plan` and `generate` print in its place. It is pure and it does not change the plan.

- `commands.setupDisplayOnly`: the setup lines that are default steps.
- `commands.piInstall`: the global install line with its mark. The line is always there, so the reader sees what the kit pins.

| Pi status in the report | `status` | Line in `setupDisplayOnly` | `installed` | `change` |
| --- | --- | --- | --- | --- |
| No report, or `unparsed` | `installed_version_unknown` | yes | `null` | `null` |
| `missing` | `needed` | yes | `null` | `null` |
| `match` | `not_needed` | no | the version | `null` |
| `mismatch`, installed Pi newer than the pin | `replaces_installed` | no | the version | `downgrade` |
| `mismatch`, installed Pi older than the pin | `replaces_installed` | no | the version | `upgrade` |
| `mismatch`, equal numbers and another build or prerelease text | `replaces_installed` | no | the version | `unordered` |

Example, Pi `1.0.4` on a kit that requires `1.0.3`:

```json
{"command": "npm install --global -- @earendil-works/pi-coding-agent@1.0.3", "status": "replaces_installed", "installed": "1.0.4", "required": "1.0.3", "change": "downgrade", "warning": "global_install_replaces_pi_for_all_profiles"}
```

- `change` names what the line does to the installed Pi. The order uses the three numbers of each version. A prerelease is before its release, so `1.0.3-beta.1` is older than `1.0.3`.
- `warning` has the same value in each case: `global_install_replaces_pi_for_all_profiles`. It is a fact of the command, not of the report.
- With `replaces_installed` the line is not a default step. Stage 3 of `INSTALL.md` has the three choices: stop, keep the installed Pi and record the gap, or install the pin under a separate prefix. The kit prints no prefix line, because the user names the prefix.
- Without a report the kit does not know the installed version. The line stays in `setupDisplayOnly`, and `installed_version_unknown` tells the reader to run `check-runtime` first.
- The other setup lines (`pi update --extensions`, the peer override) do not change.

Tests: `tests/test_profile_plan.py` (`PiInstallTests`) covers no report, `match`, a newer installed Pi, an older installed Pi, an absent Pi, `unparsed`, a prerelease and a build text. `tests/test_cli.py` reads the mark from the output of `plan` and `generate`.
