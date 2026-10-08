# Offline profile CLI

Python 3.11+ standard library. Use explicit synthetic or private JSON inputs, never a live Pi settings file:

```sh
python3 scripts/tenant_pi.py validate --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --registry /path/to/registry.json --require-role review --target '/existing/owned/parent/new profile'
python3 scripts/tenant_pi.py check-runtime [--pi /path/to/pi] [--node /path/to/node] [--python /path/to/python3]
python3 scripts/tenant_pi.py carry --report /path/to/report.json --overlay /path/to/overlay.json --right '/existing/candidate'
```

`--registry` is optional for core-only, legacy, or empty `modelRoutes` choices. It is required for selected `modelRoutes` role or cycle models. Its entire JSON shape is `{ "provider": { "model": ["supportedThinkingLevel"] } }`. It is explicit offline capability evidence, not `models.json`, authentication evidence, or a runtime catalog. The kit never emits it as `models.json`. `--require-role` repeats for `interactive`, `review`, `worker`, `research`, or `memory`; missing selections remain `required_missing` and add `required_role_missing`. No fallback is chosen. An omitted role does not activate a module. `--manifest` defaults to the pinned manifest and accepts only reviewed source and resource claims. `inputs.modelsFile` remains unsupported. `inputs.mcpFile` is required exactly when `mcp` is enabled. The CLI reads it from `--local-dir` (default: the kit's `.local/`) as `inputs/mcp-adapter.json` through the same bounded loader. The CLI validates every server definition before planning; see `docs/workflow-modules.md`.

All three JSON inputs use a maximum 1 MiB regular-file, no-follow loader through real ancestor directories. The loader also refuses a JSON text that nests objects and arrays deeper than 64 levels, with the rule `input_too_deep`; the bound is the kit's own and is the same on each Python version. This input boundary belongs to `scripts/tenant_pi.py` only. Direct `scripts/validate.py` checks structure only: it follows symlinks and sets no size limit, so use it for the repository samples and use `tenant_pi.py validate` for private input. Duplicate object keys, deep JSON, oversized integers, symlinks, FIFOs, and malformed data fail with static diagnostics; each cause has its own rule, see [input file errors](#input-file-errors). The read-only `inventory` action uses the same loader for `settings.json` and lists three resource directories by name; see `docs/profile-inventory.md`. The read-only `list` action reads only `<child>/.tenant-pi/state.json` of each direct child of one parent directory; see `docs/candidate-list.md`. The print-only `carry` action reads a `compare` report, the overlay and the declared files of the right side through the same loader and prints overlay patches; it writes nothing; see `docs/carry.md`. `validate`, `plan`, and `--help` make no filesystem changes. They do not run a dependency command, network request, model call, or login. `validate`, `plan`, `generate`, `compare`, `carry`, `list` and `inventory` start no process and do not read environment values or credential files, with two exceptions: `validate`, `plan` and `generate` read `HOME` to find `~/.pi/agent`, and `plan` tests a fixed list of provider key variable names for presence, never for a value; see [the warning](profile-plan.md#the-warning-for-a-provider-key-variable). `validate` checks offline supported-input rules. `plan` lists output paths and modes, readiness gaps, route setup facts, and display-only setup and launch instructions.

| Path | Offline result | Runtime status |
| --- | --- | --- |
| Core-only | No provider, model, cycle, thinking, or gateway forced. | Core and Node unverified. |
| Native route | Exact provider and slash-containing model ID; interactive defaults and explicit ordered cycle. | Provider existence, authentication, model catalog, and supported thinking unverified. Pi owns native `/login` after a separate review. |
| Gateway with `auth: "env"` | One local-path package declaration per package, with the filter of each enabled component (`codex-accounts` is required); process-local `TENANTEXT_LITELLM_BASE_URL` launch assignment. | `TENANTEXT_LITELLM_API_KEY` must be provided to the same Pi process by the user. Missing names and upstream availability remain visible. |
| Gateway with `auth: "login"` | Preview includes `pi_login_blocked`; `generate` fails without creating a target. | Fresh URL-only `/login litellm-codex` cannot bootstrap provider registration at this pin. Do not use it as setup guidance. |
| Owner packages (`ownerPackages`) | Each item appended to `settings.packages` after every kit declaration, in overlay order: a plain path as a string, a filtered item as an object. `plan` lists the items under `ownerPackages`. | One `owner_package_unqualified` gap per item. The kit does not check that the path exists or that Pi loads it; see `docs/owner-packages.md`. |
| Accepted drift (`unmanaged`) | `plan` and `generate` echo the list under `unmanaged`; `.tenant-pi/choices.json` records it at `/overlay/unmanaged`. `settings.json`, the gaps and the commands do not change. | No accepted value is written. `compare` reports a listed difference under `accepted`; see `docs/accepted-drift.md`. |
| Owner resources (`ownerResources`) | Each `skills` and `prompts` directory appended to the Pi `skills` and `prompts` arrays of `settings.json`, after any kit entry, in overlay order. An empty list renders no key. `plan` lists the entries under `ownerResources`. | One `owner_resource_unqualified` gap per entry. The kit does not open a directory or check that Pi loads it; see `docs/owner-resources.md`. |
| Missing required role | `required_role_missing` and `required_missing`; no invented model. | The downstream consumer remains inactive. |

The gateway URL must be a credential-free HTTPS URL ending exactly `/v1`. The portable contract excludes loopback HTTP and non-443 ports even though the in-tree Tenantext package supports some loopback forms. `TENANTEXT_LITELLM_BASE_URL` belongs to the launched Pi process, not to `settings.json`. The single display-only launch line places the URL assignment before `env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=... pi --no-approve` in the same process. Do not run a standalone URL assignment and expect a later process to inherit it. The API key is a symbolic name only; the kit never prints, resolves, stores, or supplies its value. Native OAuth state and gateway bearer credentials stay separate. Do not copy quota `tokenFile` paths or start another process that refreshes the same OAuth token.

`generate` requires a second explicit absent target matching the overlay byte-for-byte. Its immediate parent must exist and be owned by the caller. The guarded writer refuses any existing target and unsafe ancestors. It writes only `settings.json`, `.tenant-pi/choices.json`, `.tenant-pi/state.json`, and at most two module files. The module files are `hermes-memory-config.json` when the Hermes module is enabled, and `mcp-adapter.json` when the MCP module is enabled. Directories have mode `0700` and files have mode `0600`. It never installs the declared package or launches Pi. It declares the reviewed Tenantext Git source once in `settings.packages`, with exact `extensions` and empty `skills`, `prompts`, and `themes`. The pinned package needs Node `>=24.0.0 <25`, Pi peers and the declared `yaml@2.9.1` runtime dependency. Package startup and clean-client behavior remain unverified. The memory modules add their package declarations, the `llm-wiki` settings section, and the Hermes file only with explicit consent and choices; see `docs/memory-modules.md`. The MCP module adds its package, `"extensions": ["-builtin:mcp"]`, the adapter file, and the `PI_MCP_CONFIG_MODE=exclusive` launch prefix; see `docs/workflow-modules.md`. Every plan records a `workflow` readiness matrix; Promptr stays blocked in it.

`validate`, `plan` and `generate` refuse an overlay whose `target.agentDir` is the kit clone or a path under it, before any write, with `under_kit: overlay.target.agentDir` and exit code 2. A profile inside the clone would enter its publish set with the user's choices in `.tenant-pi/choices.json`. The rule compares path text after the overlay is valid, so an invalid overlay is reported first. The kit root counts as written and with its symbolic links resolved. The target also counts as written and with its symbolic links resolved, so a linked name that leads into the clone is refused (this reads link targets only, no file content). As for `--launcher`, `under_kit` covers only the root of the kit that runs the action: a second clone, or the main clone when the action runs from a Git worktree, is not protected.

`validate`, `plan` and `generate` also refuse an overlay whose `target.agentDir` is the sample target of `config/config.example.json`, `/home/EXAMPLE_USER/new-agent`, with `sample_target: overlay.target.agentDir` and exit code 2. The rule runs at the same place as `under_kit`: after the overlay is valid and before any write. An overlay that `init-private` writes without `--target` has the sample target. Direct `scripts/validate.py` accepts the tracked example, because it checks structure only.

`validate`, `plan` and `generate` also refuse an overlay whose `target.agentDir` is `~/.pi/agent` or a path under it, before any write, with `under_pi_agent: overlay.target.agentDir` and exit code 2. `~/.pi/agent` is the live profile: the directory that a bare `pi` command opens. The rule name is the one of `init-private --target` and of `--launcher`. The root and the target each count as written and with their symbolic links resolved, as for `under_kit` (this reads link targets only, no file content). A target through a linked name is refused, and so is a target in the directory behind a linked `~/.pi/agent`. The rule runs after the overlay is valid, after `under_kit` and `sample_target`, and after the location rules of `--launcher`.

For this rule the three actions read `HOME`. The rule reads no other environment value. `HOME` must be set and must be an absolute path without a trailing slash; else the action stops with `home_required: target.home` or `absolute_path: target.home` and exit code 2. With `--launcher`, the launcher rules read `HOME` first and name the field `launcher.home`. Limit: the rule knows only `~/.pi/agent`. The kit does not read `PI_CODING_AGENT_DIR`, so a live agent directory that only this variable names is not refused. `tests/test_cli.py` covers the directory itself, a path under it, a path through a link, a linked `~/.pi/agent`, a linked `HOME`, a target beside the directory, a missing or relative `HOME`, and the limit.

`.tenant-pi/state.json` also carries a minimal non-secret provenance record (kit schema, Pi pin, Node range, enabled components and their pins, declared outputs, the UTC generation time `generatedAt` and the kit commit `kitCommit`); see `docs/candidate-compare.md`. `generate` reads `kitCommit` from the Git metadata files of the kit clone through the bounded loader, not with `git rev-parse HEAD`, and records `unknown` when they are absent or malformed; see `docs/candidate-list.md`. A complete state marker means only that files were published. `filesComplete` can be true while `runtimeReady` remains false. A pre-publication failure leaves an incomplete candidate and no launch instruction. Cleanup failures after publication return a completion warning. Inspect incomplete candidates manually; do not retry in place or delete uncertain paths. No automatic rollback occurs. The agent directory is not an OS sandbox: HOME, working directory, environment, and trusted project resources can affect Pi. Review every gap before manually qualifying runtime under separate authorization.

## Input file errors

Each JSON input goes through the same loader: the overlay (`overlay.file`), the manifest (`manifest.file`), the registry (`registry.file`), the MCP input (`mcp.file`), and the files that `compare`, `carry`, `inventory`, `list` and `init-private` read. When the loader cannot use a file, the rule names one cause and the field names the input. The diagnostic holds no path and no file content.

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
- A row of `list` shows the rule only, without `line` and `column`; see `docs/candidate-list.md`.

`python3 -m json.tool <file> >/dev/null` checks the syntax of a file without the kit.

Warning: without `>/dev/null`, `json.tool` prints the whole file when the syntax is correct.

Direct `scripts/validate.py` uses the same parser. It prints a rule as text, with the field `file`, and the place after the field: `invalid_json: file line=6 column=3`. It follows links and has no size bound and no 64-level bound. So it prints `input_missing`, `input_unreadable`, `input_encoding`, `invalid_json`, `duplicate_key` and `number`, and it prints `input_too_deep` only at the recursion limit of Python.

The rule `read_or_json` stays for a directory that `inventory` or `list` cannot open or list. See `docs/profile-inventory.md` and `docs/candidate-list.md`.

## `check-runtime` and `check-herdr`: the actions that start a process

```sh
python3 scripts/tenant_pi.py check-runtime [--pi <path>] [--node <path>] [--python <path>]
```

`check-runtime` and `check-herdr` are the only actions that run a subprocess. `check-herdr` runs one `herdr --version` and reports `present`, `missing` or `unparsed`; see [Herdr and the question tool](herdr-setup.md). `remote-plan` prints SSH command lines and runs none. `compose-plan` prints Compose command lines and runs none. `check-runtime` runs at most three commands (one for each tool that it finds) without a shell, each with a 20 second timeout: `pi --version` with `PI_CODING_AGENT_DIR` set to an empty temporary directory that it removes, `node --version`, and `python3 --version`. It compares the results with `manifest.runtime` and prints one deterministic JSON object. Exit code 0 accepts Pi `match` or `untested_in_range` when Node and Python match. A failed requirement gives exit code 1. It reads `PATH` to find a tool that has no explicit path, and the three processes inherit the environment. It runs no other command, no network request and no install, and it reads no credential file. A failed removal of the temporary directory gives `cleanup_failed: check-runtime.tmpdir` and exit code 2. See `docs/check-runtime.md`.

## `baseline` and `check-baseline`: the directory baseline

```sh
python3 scripts/tenant_pi.py baseline --dir /home/EXAMPLE_USER/.pi/agent --out /existing/owned/dir/live-baseline.json
python3 scripts/tenant_pi.py check-baseline --dir /home/EXAMPLE_USER/.pi/agent --baseline /existing/owned/dir/live-baseline.json
```

`baseline` records the name, kind, size and modification time of each entry of one explicitly named directory, at all levels. It opens directories only and follows no link, so it reads no file content. Its one write is the absent `--out` file, mode `0600`, exclusive create. It refuses an existing file and a path under `--dir`, under `~/.pi/agent` or under the kit clone, before it lists the directory. It reads `HOME`. `check-baseline` compares the directory with that file and prints `unchanged`, `changed` (with the names of the direct entries that differ) or `no_baseline`. It writes nothing, and its exit code is 1 when the result is not `unchanged`. Neither action starts a process. See `docs/directory-baseline.md`.

## `--launcher`: the launcher file

```sh
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --target '/existing/owned/parent/new profile' --launcher /existing/owned/dir/launch-main.sh
```

`plan` and `generate` take an optional `--launcher <absolute file path>`. `plan` prints the path as `commands.launcherDisplayOnly` and writes nothing. `generate` writes the file only after a complete generation: `#!/bin/sh` and one line `exec env <commands.launchDisplayOnly>`, mode `0700`, exclusive create. It refuses an existing file, a relative path, and a path under the target, under `~/.pi/agent` or under the kit clone, before any write. With `--launcher`, `plan` and `generate` read `HOME`. A launcher failure after a complete generation gives exit code 1 and the full report with a static diagnostic under `launcher`. See `docs/launcher.md`.

## `--runtime-report`: the measured runtime versions

```sh
python3 scripts/tenant_pi.py check-runtime > /path/to/runtime.json
python3 scripts/tenant_pi.py generate --overlay /path/to/overlay.json --target '/existing/owned/parent/new profile' --runtime-report /path/to/runtime.json
```

`plan` and `generate` take an optional `--runtime-report <file>`: the JSON output of a previous `check-runtime` run. They read the file through the same bounded no-follow loader and validate it against `manifest.runtime` before any write. They start no process. A `match` for Node or Pi removes `node_runtime_unverified` or `core_runtime_unverified` from `readinessGaps`. Pi `untested_in_range` keeps `core_runtime_untested_in_range`, with the installed version, tested version, accepted range and test limit. The kit tests ran on the tested version only. A failed requirement replaces the gap with `<node|core>_runtime_<mismatch|missing|unparsed>`, with the keys `installed` and `required`. Without the option both `*_unverified` gaps stay. The output of a complete `generate` does not list `target_absence_unverified`, with or without the option. `runtimeReady` is always `false`: this kit has no live trial of a generated profile. The report changes the printed output only: the generated files are the same with and without it. See `docs/profile-plan.md`.

`plan` and `generate` also take an optional `--herdr-report <file>`: the JSON output of a previous `check-herdr` run. With the `herdr` component enabled, `present` removes `herdr_cli_unverified` from `readinessGaps`, and `missing` or `unparsed` replaces it with `herdr_cli_missing` or `herdr_cli_unparsed`. `herdr_session_unverified` stays with every report. A file that is not such a report stops the action with `herdr_report_status` or `herdr_report_installed` before any write. See [Herdr and the question tool](herdr-setup.md#verification-results).

`commands.piInstall` marks the global Pi install line in each `plan` and `generate` output: `installed_version_unknown` without a report, `needed` for a `missing` Pi, `not_needed` for a `match` or Pi `untested_in_range`, and `replaces_installed` for a `mismatch`, with the `installed` and the `required` version and the `change` (`downgrade`, `upgrade` or `unordered`). Its `warning` is `global_install_replaces_pi_for_all_profiles`. With `not_needed` and `replaces_installed` the line is not in `commands.setupDisplayOnly`.

## `compose-plan`: the files and the commands of a Compose seat

```sh
python3 scripts/tenant_pi.py compose-plan --account pi --uid 1000 --gid 1000 --public-key /home/EXAMPLE_USER/.ssh/id_ed25519.pub --gateway-url https://gateway.example.invalid/v1 --private-dir /home/EXAMPLE_USER/.config/tenant-pi --model codex-auto/astra [--provider litellm-codex] [--thinking high] [--ssh-port 2222] [--projects-dir /home/EXAMPLE_USER/projects] [--key-var TENANTEXT_LITELLM_API_KEY] [--enable herdr] [--clone /home/EXAMPLE_USER/tenant-pi] [--write]
```

`compose-plan` turns the answers of the container destination into one JSON object. Without `--write` it writes nothing. It starts no process with and without `--write`. `scripts/compose_plan.py` is a pure module: no process, no file, no environment value. The action reads two files through the bounded no-follow loader: the manifest and the public key file (64 KiB maximum). See [the Compose seat](../deploy/compose/README.md).

`--model` is mandatory: the model of the interactive role. `--provider` (default `litellm-codex`) and `--thinking` (default `high`) are the two other parts of that role. Under `litellm-codex` the model is `codex-auto/luna`, `codex-auto/sol` or `codex-auto/astra`. The thinking level is `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The three values stay separate: the overlay never holds a joined `<provider>/<model>` string.

| Key | Content |
| --- | --- |
| `answers` | The validated answers, with `provider`, `model` and `thinking`. `componentsAdded` names each component that a chosen component requires. |
| `overlay` | The overlay of the seat. `target.agentDir` is `/home/<account>/.pi/profiles/main`. `selection.enable` holds `core`, `model-routing`, `codex-accounts`, the `--enable` IDs and their `requires` of the manifest. `modelRoutes.gateway` is `{"auth":"env"}`. `roles.interactive` holds `provider`, `model`, `thinking` and `"route":"gateway"`, and `modelRoutes.cycle` holds that one choice. |
| `registry` | The content of `registry.json`: `{"<provider>":{"<model>":["<thinking>"]}}`. `validate`, `plan` and `generate` need it with `--registry` for the role model. |
| `seatEnv`, `composeEnv` | The lines of `seat.env` and `compose.env`. The key line of `compose.env` is `<key variable>=''`: empty, in single quotes. `SEAT_USERNS` is empty, and a comment line gives the Podman value with the UID and the GID of the answers. |
| `authorizedKeys` | The public key file (`source`) and `<private dir>/authorized_keys` (`destination`). |
| `commands` | For `docker` and for `podman`: `build`, `up`, `ps`, `logs` and `down`. Then the `login` line of `ssh`. Each entry has `argv` and `display`. A Compose entry has `kitCommit`, the `git` argument list whose output is `KIT_COMMIT`; its `display` starts with that assignment. An entry with `"changes": true` has `"approval": "user_approval_required"`. |
| `warnings` | Static codes: `inspect_shows_key_value`, `bind_0_0_0_0_opens_seat_to_network`, and by answer `gid_20_is_dialout_in_image`, `uid_below_1000`, `gid_below_1000`, `mcp_input_file_required`. |
| `written` | The paths that `--write` created, else an empty list. |

Each Compose command carries `--env-file <private dir>/seat.env` and `-f <clone>/deploy/compose/compose.yaml`. With `--projects-dir` each one also carries `-f <clone>/deploy/compose/compose.projects.yaml`. No command has `-v`.

| Rule | Cause |
| --- | --- |
| `account`, `reserved_account`: `compose-plan.account` | The name is not `[a-z_][a-z0-9_-]{0,31}`, or it is `root` or an account of the base image: `node`, `sshd`, `daemon`, `www-data`, `nobody`, `bin`, `sys`, `sync`, `games`, `man`, `lp`, `mail`, `news`, `uucp`, `proxy`, `backup`, `list`, `irc` or `_apt`. |
| `integer`: `compose-plan.uid`, `.gid`, `.ssh_port` | The option value is not a decimal number. |
| `account_id`: `compose-plan.uid`, `.gid` | The value is outside 500 to 65533. The GID 20 is accepted. A value below 1000 gives a warning. |
| `port: compose-plan.ssh_port` | The port is outside 1024 to 65535. |
| `absolute_path`, `shell_or_template`: `compose-plan.public_key`, `.private_dir`, `.clone`, `.projects_dir` | The path is not absolute, ends in `/`, or holds a character that the path rule of the overlay refuses. A path can hold spaces and quotes. |
| `under_kit: compose-plan.private_dir` | The private directory is the clone, is under it, or holds it. With `--write`: it is under the kit that runs the action. |
| `credential_free_https_url`, `gateway_api_prefix`: `compose-plan.gateway_url` | The URL breaks the gateway rule of the overlay, or does not end in `/v1`. |
| `env_name: compose-plan.key_var` | The name is not a variable name, or it is `TENANTEXT_LITELLM_BASE_URL` or a `SEAT_` name. |
| `undeclared_component`, `duplicate_component`: `compose-plan.components` | An `--enable` ID is not in the manifest, or is given twice. |
| `model_id`: `compose-plan.provider`, `.model` | The value is not an ID of the form `[A-Za-z0-9][A-Za-z0-9._/:-]*`. |
| `thinking: compose-plan.thinking` | The value is not a thinking level. |
| `unsupported_gateway_model: compose-plan.model` | The provider is `litellm-codex`, and the model is not one of its three aliases. |
| `unsupported_gateway_model: overlay.modelRoutes.choice` | The provider is not `litellm-codex`. The action runs the route rules with the registry of the plan, and the seat has the gateway route only. |
| A rule with the field `overlay.<name>` | The action runs the overlay validator on the plan. For example `undeclared_env: overlay.env` for a key name other than `TENANTEXT_LITELLM_API_KEY`, and `memory_choices_required: overlay.memory` for a memory module. |
| `input_missing`, `input_not_regular` and the other input rules: `compose-plan.public_key` | The loader cannot use the public key file. See [input file errors](#input-file-errors). |
| `public_key_count: compose-plan.public_key has <n> key lines` | The file has more than one key line. The seat takes exactly one; comment lines and empty lines are allowed. |
| `private_key`, `public_key_missing`, `public_key_line`: `compose-plan.public_key` | The file holds the text `PRIVATE KEY`; it has no key line; a line is not `<type> <key> [comment]` with the type `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-*` or `sk-*`. A line with an option before the type is refused. |

With `--write` the action creates `overlay.json`, `seat.env`, `compose.env`, `authorized_keys` and, as the fifth file, `registry.json` in the existing private directory, each with mode `0600` and with exclusive creation. `authorized_keys` is a byte-for-byte copy of the public key file. The entrypoint of the seat passes `--registry /private/registry.json` when the file exists. Every refusal comes before the first write:

| Rule | Cause |
| --- | --- |
| `target_exists: compose-plan.<file>` | One of the five files exists. A link counts as a file. |
| `private_dir_missing`, `private_dir_unsafe`: `compose-plan.private_dir` | The directory does not exist; the directory or a directory above it is a symbolic link or is not a directory. |
| `under_pi_agent: compose-plan.private_dir` | The directory is `~/.pi/agent` or is under it. For this rule `--write` reads `HOME` (`home_required`, `absolute_path`: `compose-plan.home`). |
| `write_failed: compose-plan.private_dir` | The system refuses a write. Some of the five files can then exist. |

The action never reads the value of the key variable, and no output and no file holds a key value. The user pastes the value into `compose.env`. Exit code 0 with the plan, exit code 2 with one JSON diagnostic line on standard error. Limits: the action does not check that the projects directory exists, that the gateway is reachable from a container, or that a runtime is installed. Not verified: how Docker Compose and `podman-compose` read a `seat.env` value with a space or a quote.

## `init-private`: the private directory

```sh
python3 scripts/tenant_pi.py init-private --dir /existing/owned/parent/new-private-dir [--target '/existing/owned/parent/new profile'] [--overlay /path/to/overlay.json]
```

`init-private` creates one absent directory (mode `0700`) with a byte-for-byte copy of `config/config.example.json` as `overlay.json`, the four templates of `config/private/`, and an empty `inputs/` directory. With `--target <absolute path>`, the new `overlay.json` has that path as `target.agentDir` and no other difference from the example; the action refuses a target that is `~/.pi/agent`, the private directory or the kit clone, or that is under one of them. Files have mode `0600`. It uses the ancestor checks and the file creation of the guarded writer. It refuses an existing path, an absent or unsafe parent, and a path under the kit clone, under `~/.pi/agent` or under an overlay target. It reads `HOME` and no other environment value. It prints one deterministic JSON object with the created paths and three display-only command lines (edit, `validate`, `git init`); it starts no process and runs no Git command. See `docs/private-directory.md`.
