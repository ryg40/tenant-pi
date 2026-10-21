# Offline profile CLI

Python 3.11+ standard library. Use explicit synthetic or private JSON inputs, never a live Pi settings file:

```sh
python3 scripts/tenant_pi.py validate --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review --target '/existing/owned/parent/new profile'
python3 scripts/tenant_pi.py check-runtime [--pi /path/to/pi] [--node /path/to/node] [--python /path/to/python3]
```

`--registry` is optional for core-only, legacy, or empty `modelRoutes` choices. It is required for selected `modelRoutes` role or cycle models. Its entire JSON shape is `{ "provider": { "model": ["supportedThinkingLevel"] } }`. It is explicit offline capability evidence, not `models.json`, authentication evidence, or a runtime catalog. The kit never emits it as `models.json`. `--require-role` repeats for `interactive`, `review`, `worker`, `research`, or `memory`; missing selections remain `required_missing` and add `required_role_missing`. No fallback is chosen. An omitted role does not activate a module. `--manifest` defaults to the pinned manifest and accepts only reviewed source and resource claims. `inputs.modelsFile` accepts the fixed `inputs/models.json` slot under `--local-dir`; see [direct providers](guides/providers.md#direct-providers). `inputs.mcpFile` is required exactly when `mcp` is enabled. The CLI reads it from `--local-dir` (default: the kit's `.local/`) as `inputs/mcp-adapter.json` through the same bounded loader. The CLI validates every server definition before planning; see `docs/workflow-modules.md`.

All three JSON inputs use a maximum 1 MiB regular-file, no-follow loader through real ancestor directories. The loader also refuses a JSON text that nests objects and arrays deeper than 64 levels, with the rule `input_too_deep`; the bound is the kit's own and is the same on each Python version. This input boundary belongs to `scripts/tenant_pi.py` only. Direct `scripts/validate.py` checks structure only: it follows symlinks and sets no size limit, so use it for the repository samples and use `tenant_pi.py validate` for private input. Duplicate object keys, deep JSON, oversized integers, symlinks, FIFOs, and malformed data fail with static diagnostics; each cause has its own rule, see [input file errors](#input-file-errors). The read-only `inventory` action uses the same loader for `settings.json` and lists three resource directories by name; see `docs/profile-inventory.md`. `validate`, `plan`, and `--help` make no filesystem changes. They do not run a dependency command, network request, model call, or login. `validate`, `plan`, `compare` and `inventory` start no process. `generate` makes one read-only Git call (`git rev-parse HEAD`) in the kit directory; it records `unknown` without Git. Git inherits the shell environment, except `GIT_CEILING_DIRECTORIES`, which stops repository discovery at the kit root. The kit's Python logic does not inspect the environment values that it passes to Git. Python copies those values when it starts Git. The location checks read `HOME` and `WIKI_HOME`. `plan` tests a fixed list of provider key variable names for presence, never for a value; see [the warning](profile-plan.md#the-warning-for-a-provider-key-variable). These Python actions read no credential files. `validate` checks offline supported-input rules. `plan` lists output paths and modes, readiness gaps, route setup facts, and display-only setup and launch instructions.

| Path | Offline result | Runtime status |
| --- | --- | --- |
| Core-only | No provider, model, cycle, thinking, or gateway forced. | Core and Node unverified. |
| Native route | Exact provider and slash-containing model ID; interactive defaults and explicit ordered cycle. | Provider existence, authentication, model catalog, and supported thinking unverified. Pi owns native `/login` after a separate review. |
| Gateway with `auth: "env"` | One local-path package declaration per package, with the filter of each enabled component (`codex-accounts` is required); process-local `TENANTEXT_LITELLM_BASE_URL` launch assignment. | `TENANTEXT_LITELLM_API_KEY` must be provided to the same Pi process by the user. Missing names and upstream availability remain visible. |
| Gateway with `auth: "login"` | Preview includes `pi_login_blocked`; `generate` fails without creating a target. | Fresh URL-only `/login litellm-codex` cannot bootstrap provider registration at this pin. Do not use it as setup guidance. |
| Owner packages (`ownerPackages`) | Each item appended to `settings.packages` after every kit declaration, in overlay order: a plain path as a string, a filtered item as an object. `plan` lists the items under `ownerPackages`. | One `owner_package_unqualified` gap per item. The kit does not check that the path exists or that Pi loads it; see `docs/owner-extensions.md#owner-package-paths-in-the-overlay`. |
| Accepted drift (`unmanaged`) | `plan` and `generate` echo the list under `unmanaged`; `.tenant-pi/choices.json` records it at `/overlay/unmanaged`. `settings.json`, the gaps and the commands do not change. | No accepted value is written. `compare` reports a listed difference under `accepted`; see `docs/accepted-drift.md`. |
| Owner resources (`ownerResources`) | Each `skills` and `prompts` directory appended to the Pi `skills` and `prompts` arrays of `settings.json`, after any kit entry, in overlay order. An empty list renders no key. `plan` lists the entries under `ownerResources`. | One `owner_resource_unqualified` gap per entry. The kit does not open a directory or check that Pi loads it; see `docs/owner-extensions.md#owner-skill-and-prompt-directories-in-the-overlay`. |
| Missing required role | `required_role_missing` and `required_missing`; no invented model. | The downstream consumer remains inactive. |

The gateway URL must be a credential-free HTTPS URL ending exactly `/v1`. The portable contract excludes loopback HTTP and non-443 ports even though the in-tree Tenantext package supports some loopback forms. `TENANTEXT_LITELLM_BASE_URL` belongs to the launched Pi process, not to `settings.json`. The single display-only launch line places the URL assignment before `env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=... pi --no-approve` in the same process. Do not run a standalone URL assignment and expect a later process to inherit it. The API key is a symbolic name only; the kit never prints, resolves, stores, or supplies its value. Native OAuth state and gateway bearer credentials stay separate. Do not copy quota `tokenFile` paths or start another process that refreshes the same OAuth token.

`generate` requires a second explicit absent target matching the overlay byte-for-byte. Its immediate parent must exist and be owned by the caller. The guarded writer refuses any existing target and unsafe ancestors. It writes only `settings.json`, `.tenant-pi/choices.json`, `.tenant-pi/state.json`, and optional module/provider files, including validated `models.json`. The module files are `hermes-memory-config.json` when the Hermes module is enabled, and `mcp-adapter.json` when the MCP module is enabled. Directories have mode `0700` and files have mode `0600`. It never installs the declared package or launches Pi. It declares the reviewed Tenantext Git source once in `settings.packages`, with exact `extensions` and empty `skills`, `prompts`, and `themes`. The pinned package needs Node `>=24.0.0 <25`, Pi peers and the declared `yaml@2.9.1` runtime dependency. Package startup and clean-client behavior remain unverified. The memory modules add their package declarations, the `llm-wiki` settings section, and the Hermes file only with explicit consent and choices; see `docs/memory-modules.md`. The MCP module adds its package, `"extensions": ["-builtin:mcp"]`, the adapter file, and the `PI_MCP_CONFIG_MODE=exclusive` launch prefix; see `docs/workflow-modules.md`. Every plan records a `workflow` readiness record.

See the [refusal rules](private-directory.md#refusal-rules) for protected paths, symbolic links and environment variants.

`validate`, `plan` and `generate` refuse the sample target with `sample_target: overlay.target.agentDir` and exit code 2. The check follows overlay validation and precedes any write. `init-private` without `--target` writes the sample target. Direct `scripts/validate.py` accepts the tracked example because it checks structure only.

`.tenant-pi/state.json` also carries a minimal non-secret provenance record (kit schema, Pi pin, Node range, enabled components and their pins, declared outputs, the SHA-256 of each written output `outputDigests`, the UTC generation time `generatedAt` and the kit commit `kitCommit`); see `docs/candidate-compare.md`. `generate` reads `kitCommit` with one read-only Git call (`git rev-parse HEAD`) in the kit directory. It records `unknown` without Git, on failure, or outside a repository. A complete state marker means only that files were published. `filesComplete` can be true while `runtimeReady` remains false. A pre-publication failure leaves an incomplete candidate and no launch instruction. Cleanup failures after publication return a completion warning. Inspect incomplete candidates manually; do not retry in place or delete uncertain paths. No automatic rollback occurs. The agent directory is not an OS sandbox: HOME, working directory, environment, and trusted project resources can affect Pi. Review every gap before manually qualifying runtime under separate authorization.

## Input file errors

Each JSON input goes through the same loader: the overlay (`overlay.file`), the manifest (`manifest.file`), the registry (`registry.file`), the MCP input (`mcp.file`), and the files that `compare`, `inventory` and `init-private` read. When the loader cannot use a file, the rule names one cause and the field names the input. The `error` text holds no path and no file content.

| Rule | Cause | Correction |
| --- | --- | --- |
| `input_path` | The path has a `.` or `..` segment or a NUL character. | Write the normalized path. |
| `input_missing` | The file, or a directory of its path, does not exist. | Check the path. A relative path starts at the working directory. |
| `input_path_unsafe` | A directory of the path is a symbolic link or is not a directory. A shell process substitution such as `<(...)` gives such a path. | Give a path through real directories. |
| `input_unreadable` | The system refuses the read, for example because the caller has no read permission. | Check the owner and the mode of the file and of each directory of its path. |
| `input_not_regular` | The last name of the path is a symbolic link, a directory, a FIFO or another entry that is not a regular file. | Give a regular file. |
| `input_too_large` | The file is larger than 1 MiB. | Check that the path names the correct file. No kit input needs that size. |
| `input_encoding` | The file is not UTF-8 text. | Save the file as UTF-8. |
| `invalid_json` | The text is not valid JSON. The output has the `line` and the `column` of the first character that the parser refuses. | Correct the syntax at that place or just before it. |
| `input_too_deep` | Objects and arrays nest deeper than 64 levels. | Remove the deep value. No kit input needs that depth. |
| `duplicate_key` | An object has the same key twice. The field is `JSON object`. | Remove one of the two keys. |
| `number` | The text has `NaN`, `Infinity` or `-Infinity`, or an integer with more digits than the Python conversion limit (4300 by default). | Write a finite number. |

A JSON syntax error is the one diagnostic with two more keys:

```json
{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}
```

- `line` and `column` are integers, counted from 1. `column` counts characters; a tab is one character.
- The parser stops at the first character that it cannot accept. For a missing comma or a missing brace, that character is the start of the next entry, so the cause is often at the end of the line before.
- A file that starts with a byte order mark gives `invalid_json` with line 1 and column 1.
- The output never holds the parser message or a part of the file.

A link in the path adds one key, `hint`, to the refusals of this table. The `error` text and the exit code stay the same.

| Rule | Command and path |
| --- | --- |
| `input_path_unsafe` | Each input file of each command, for example `--overlay` and `--manifest` |
| `unsafe_path` | `generate --target`, `generate --launcher`, `init-private --dir`, `baseline --out`, `results --out-dir`, and `--workdir` of `scripts/pi_update.py` |
| `not_directory`, `unreadable` | `baseline --dir`, `check-baseline --dir` |
| `not_directory` | `results --target` |
| `read_or_json` | `list --parent` |

The resource lists of `inventory` and the `launcher` value of a `generate` report have no `hint`.
The hint names the first linked directory, its link target and the resolved path:

```json
{"candidate_created": false, "error": "input_path_unsafe: overlay.file", "hint": "/tmp is a link to private/tmp; give the resolved path /private/tmp/overlay.json"}
```

A dangling link or a link loop has no resolved path, so the hint names the link and its target only.
Each name has at most 200 characters, and each control or non-printable character shows as `?`.
The kit reads the link names only, never file content. On macOS, `/tmp`, `/var` and `/etc` are such links.

`python3 -m json.tool <file> >/dev/null` checks the syntax of a file without the kit.

Warning: without `>/dev/null`, `json.tool` prints the whole file when the syntax is correct.

Direct `scripts/validate.py` uses the same parser. It prints a rule as text, with the field `file`, and the place after the field: `invalid_json: file line=6 column=3`. It follows links and has no size bound and no 64-level bound. So it prints `input_missing`, `input_unreadable`, `input_encoding`, `invalid_json`, `duplicate_key` and `number`, and it prints `input_too_deep` only at the recursion limit of Python.

The rule `read_or_json` stays for a directory that `inventory` cannot open or list. See `docs/profile-inventory.md`.

## `check-runtime` and `check-herdr`: the actions that start a process

```sh
python3 scripts/tenant_pi.py check-runtime [--pi <path>] [--node <path>] [--python <path>]
```

`generate`, `results`, `check-runtime`, `check-herdr` and `update` can run a subprocess. `update` runs read-only Git calls and the calls of `check-runtime`; see [the update action](update.md). `generate` and `results` each make one read-only Git call (`git rev-parse HEAD`) in the kit directory. They record `unknown` without Git or when the call fails. The call uses no shell, a 5 second timeout, and `check=False`. `check-herdr` runs one `herdr --version` and reports `present`, `missing` or `unparsed`; see [Herdr and the question tool](herdr-setup.md). `check-wiki-vault` starts no process: it reports the personal LLM Wiki vault from `lstat` calls; see [the vault check](memory-modules.md#the-vault-check). `check-runtime` runs at most three commands (one for each tool that it finds) without a shell, each with a 20 second timeout: `pi --version` with `PI_CODING_AGENT_DIR` set to an empty temporary directory that it removes, `node --version`, and `python3 --version`. It compares the results with `manifest.runtime` and prints one deterministic JSON object. Exit code 0 accepts Pi `match` or `untested_in_range` when Node and Python match. A failed requirement gives exit code 1. It reads `PATH` to find a tool that has no explicit path, and the three processes inherit the environment. It runs no other command, no network request and no install, and it reads no credential file. A failed removal of the temporary directory gives `cleanup_failed: check-runtime.tmpdir` and exit code 2. See `docs/check-runtime.md`.

## `baseline` and `check-baseline`: the directory baseline

```sh
python3 scripts/tenant_pi.py baseline --dir /home/EXAMPLE_USER/.pi/agent --out /existing/owned/dir/live-baseline.json
python3 scripts/tenant_pi.py check-baseline --dir /home/EXAMPLE_USER/.pi/agent --baseline /existing/owned/dir/live-baseline.json
```

`baseline` records the name, kind, size and modification time of each entry of one explicitly named directory, at all levels. It opens directories only and follows no link, so it reads no file content. Its one write is the absent `--out` file, mode `0600`, exclusive create. It refuses an existing file and a path under `--dir`, before it lists the directory. It reads `HOME`. `check-baseline` compares the directory with that file and prints `unchanged`, `changed` (with the names of the direct entries that differ) or `no_baseline`. It writes nothing, and its exit code is 1 when the result is not `unchanged`. Neither action starts a process. See `docs/directory-baseline.md`.

## `results`: the results file of an install

```sh
python3 scripts/tenant_pi.py results --overlay /path/to/overlay.json --facts /path/to/results-facts.json --target '/existing/owned/parent/new profile' --out-dir /existing/owned/dir
```

`results` writes `<out-dir>/INSTALLER_KIT_RESULTS.md` with mode `0600`. It reads the manifest, overlay and closed-schema facts file.
For each target, it opens only `.tenant-pi/state.json` and `settings.json`, and checks each declared npm package's `package.json` metadata.
It reads `HOME` and `WIKI_HOME` for vault protection, and requires `HOME` only with `--out-dir`.
Without `--out-dir`, it prints the text without writing. An existing file requires `--replace`. See [the results file](install-results.md).

## `--launcher`: the launcher file

```sh
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --target '/existing/owned/parent/new profile' --launcher /existing/owned/dir/launch-main.sh
```

`plan` and `generate` take an optional `--launcher <absolute file path>`. `plan` prints the path as `commands.launcherDisplayOnly` and writes nothing. `generate` writes the file only after a complete generation: `#!/bin/sh` and one line `exec env <commands.launchDisplayOnly>`, mode `0700`, exclusive create. It refuses an existing file, a relative path, and a path under the target, before any write. With `--launcher`, `plan` and `generate` read `HOME`. A launcher failure after a complete generation gives exit code 1 and the full report with a static diagnostic under `launcher`. See `docs/launcher.md`.

## `--runtime-report`: the measured runtime versions

```sh
python3 scripts/tenant_pi.py check-runtime > /path/to/runtime.json
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --target '/existing/owned/parent/new profile' --runtime-report /path/to/runtime.json
```

`plan` and `generate` take an optional `--runtime-report <file>`: the JSON output of a previous `check-runtime` run. They read the file through the same bounded no-follow loader and validate it against `manifest.runtime` before any write. `plan` starts no process. `generate` makes only its read-only Git call for `kitCommit`, not a runtime probe. A `match` for Node or Pi removes `node_runtime_unverified` or `core_runtime_unverified` from `readinessGaps`. Pi `untested_in_range` keeps `core_runtime_untested_in_range`, with the installed version, tested version, accepted range and test limit. The kit tests ran on the tested version only. A failed requirement replaces the gap with `<node|core>_runtime_<mismatch|missing|unparsed>`, with the keys `installed` and `required`. Without the option both `*_unverified` gaps stay. The output of a complete `generate` does not list `target_absence_unverified`, with or without the option. `runtimeReady` is always `false`: this kit has no live trial of a generated profile. The report changes the printed output only: the generated files are the same with and without it. See `docs/profile-plan.md`.

`plan` and `generate` also take an optional `--herdr-report <file>`: the JSON output of a previous `check-herdr` run. With the `herdr` component enabled, `present` removes `herdr_cli_unverified` from `readinessGaps`, and `missing` or `unparsed` replaces it with `herdr_cli_missing` or `herdr_cli_unparsed`. `herdr_session_unverified` stays with every report. A file that is not such a report stops the action with `herdr_report_status` or `herdr_report_installed` before any write. See [Herdr and the question tool](herdr-setup.md#verification-results).

`commands.piInstall` marks the global Pi install line in each `plan` and `generate` output: `installed_version_unknown` without a report, `needed` for a `missing` Pi, `not_needed` for a `match` or Pi `untested_in_range`, and `replaces_installed` for a `mismatch`, with the `installed` and the `required` version and the `change` (`downgrade`, `upgrade` or `unordered`). Its `warning` is `global_install_replaces_pi_for_all_profiles`. With `not_needed` and `replaces_installed` the line is not in `commands.setupDisplayOnly`.

## `components`: the checklist of the components

```sh
python3 scripts/tenant_pi.py components [--format text] [--overlay /path/to/overlay.json]
python3 scripts/tenant_pi.py components --select ops-footer,13
```

`components` prints one entry for each component of `config/manifest.json`, in manifest order. It is the one source of the component list for an install: a document does not hold a second copy. `scripts/components.py` is a pure module: no process, no file, no environment value. The action reads the manifest and, with `--overlay`, that overlay through the bounded no-follow loader. It writes no file and it enables nothing.

The data form is the default: one JSON object with `count`, `marks`, `components` and `scope`. `marks` is `recommended` without `--overlay` and `overlay` with it. Each entry of `components` has these keys:

| Key | Content |
| --- | --- |
| `number` | The position in the manifest, from 1. The number is the handle of the checklist. |
| `id`, `kind`, `status` | The component ID, the kind of its manifest `source` and its manifest status. |
| `extensions`, `skills` | The names from `resources` of the manifest. A skill has the name of its directory. An extension has the name of its directory. A path that names no directory of its own, for example `index.ts`, gives the name of the package. A component with no resource has two empty lists. |
| `requires` | The IDs that the component needs. |
| `prerequisites` | Plain codes, in a fixed order. `overlay:<key>` is an overlay key that `validate` needs. `env:<NAME>` is a name of the manifest key `env`. `gap:<code>` is a readiness gap that names a step or a tool of the host. `setup:<line>` is a setup line that `plan` prints, without the directory of the profile and with the path of a kit file relative to the kit. It names the step. `plan` prints the line to run, with the directory of the profile and the absolute path. |
| `recommended` | `true` for an ID of the recommended set. The set is `RECOMMENDED` in `scripts/components.py`. |
| `marked` | The state of the checklist. Without `--overlay` it is `recommended`. With `--overlay` it is `true` for each ID in `selection.enable` of that overlay. |
| `locked` | `true` for `core`: the user cannot switch it off. |

A `gap:` code is a manifest gap whose code ends in `_required`. For the two npm memory modules it is also `peer_override_required`, and `native_addon_unverified` for `hermes`: the plan adds them. An `env:` name is a declared name, not a proof that the component fails without it. With `--overlay`, the action reads only `selection.enable`. It does not check the other rules of the overlay; use `validate` for that.

`--format text` prints the numbered checklist for a person: one line for each component, then one line that says how to answer. A line holds the number, `[x]` or `[ ]`, the ID, the names of the extensions and the skills, the status, the required IDs and a short note of the prerequisites. `core` is locked and each other component requires it, so a line names only the other required IDs. The note gives the count of the setup lines, not their text. The same command prints the same bytes on each run.

`--select <ids or numbers, separated by commas>` prints the `selection` object of an overlay for the chosen components. `enable` holds `core`, then the chosen IDs and each ID that one of them requires, by name. `disable` holds each other ID, by name. `added` names each ID that the requirement rule added. `prerequisites` holds the codes of each enabled component that has one. The action writes no file: copy the object into the overlay, add each `overlay:` key of the prerequisites, and then run `validate`.

| Rule | Cause |
| --- | --- |
| `undeclared_component: components.select` | An item of `--select` is not an ID of the manifest and not a number of the checklist. An empty item has the same rule. |
| `blocked_component: components.select` | A chosen or required component has the manifest status `blocked`. |
| `option_conflict: components.select` | `--select` is given with `--overlay` or with `--format text`. |
| `required_fields: overlay.selection`, `undeclared_component: overlay.selection` | The `--overlay` file has no `selection.enable`, or the list names an ID that the manifest does not have. |

Exit code 0 with the output, exit code 2 with one JSON diagnostic line on standard error. A diagnostic never holds an input value. `tests/test_components.py` covers the three forms, the recommended set and each kind of prerequisite code. Not verified: the use of the checklist in an install session.

## `init-private`: the private directory

```sh
python3 scripts/tenant_pi.py init-private --dir /existing/owned/parent/new-private-dir [--target '/existing/owned/parent/new profile'] [--overlay /path/to/overlay.json]
```

`init-private` creates one absent directory (mode `0700`) with a byte-for-byte copy of `config/config.example.json` as `overlay.json`, the four templates of `config/private/`, and an empty `inputs/` directory. With `--target <absolute path>`, the new `overlay.json` has that path as `target.agentDir` and no other difference from the example; the target must stay outside the private directory. Files have mode `0600`. It uses the ancestor checks and the file creation of the guarded writer. It refuses an existing path, an absent or unsafe parent, and a path under an overlay target.  It prints one deterministic JSON object with the created paths and three display-only command lines (edit, `validate`, `git init`); it starts no process and runs no Git command. See `docs/private-directory.md`.

## Guarded new-target writer

`write(plan, target_agent_dir)` accepts an in-memory `prepare()` plan and a second explicit target. It never reads the manifest, registry, host catalog, environment, auth file, or any existing profile. It validates every plan field before the first filesystem mutation. It rebuilds the full expected plan from the private manifest, overlay, registry, role requirements, and credential-name evidence. The manifest remains subject to independent reviewed pins and resource filters. It rejects changed settings, package identity or resources, routes, commands, gaps, and inconsistent private evidence. The registry digest detects accidental edits, not fabricated user capability data.

Only a missing target under an existing safe caller-owned parent may be created. Ancestors are checked without following symlinks; target creation is exclusive. The writer creates `settings.json`, `.tenant-pi/choices.json`, and writer-owned `.tenant-pi/state.json` only. Directories start `0700`; files start `0600`, including under umask `000`. JSON output is deterministic. A state marker starts `incomplete` and changes to `complete` only after sync and final replacement. Both states carry the same minimal non-secret provenance record (kit schema version, Pi pin, Node range, sorted enabled components with their public pins, declared output paths, `outputDigests`: the SHA-256 of the bytes of each other written file, the UTC generation time `generatedAt`, and `kitCommit`: a 40-hex commit or `unknown`). `write()` takes the clock as the parameter `clock` (default: the current UTC time) and the commit as `kit_commit` (default: `unknown`). A failed clock or a commit outside the form stops the write before the target is created. The record never contains the target path, an endpoint, a role, a credential name, or registry data, and it grants no authority to overwrite any file. A completed file set is not a working authenticated client.

`WriteError` reports static rule/field text and `candidate_created`. A pre-publication failure after target creation leaves an incomplete candidate for manual inspection, with no rollback or retry in place. A descriptor cleanup failure after publication reports `cleanup_failed: target.descriptors` as a warning while preserving success. The writer never runs commands, installs the Tenantext declaration, launches Pi, creates `auth.json`, or resolves gateway credentials.

This Linux-first boundary assumes local POSIX no-follow, exclusive creation, rename, and fsync semantics. It does not protect against another process with the same effective user, root, hostile mount changes, or a filesystem that ignores permissions. It is not a sandbox or proof of runtime readiness. See `docs/generator.md` for the CLI and supported setup paths.
