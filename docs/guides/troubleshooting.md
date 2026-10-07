# Troubleshooting

Each kit command prints a failure as one static line. This guide lists the known failure classes, the exact text, and the fix.

## How to read a diagnostic

A refused action prints one JSON object on standard error and exits with code 2:

```json
{"candidate_created": false, "error": "registry_required: registry"}
```

- The `error` text has the form `rule: field`. It never holds a path, a value or a secret.
- A JSON syntax error (`invalid_json`) adds two keys, `line` and `column`. Both are integers, counted from 1. No other diagnostic has them.
- `candidate_created` is `true` only when a directory exists after the failure. Inspect that directory. The kit has no rollback and deletes nothing.
- `check-runtime` exits with 0 when Node and Python match, and Pi is `match` or `untested_in_range`. A failed requirement gives exit code 1. Its report is on standard output.
- `generate --launcher` exits with 1 when the profile is complete and the launcher file is not. The report is on standard output, with the rule under `launcher.error`.

The tables list diagnostic rules. A row marked "documented" has no runtime observation.

## Wiki embedding diagnostics

The Tenantext `/tenantext-doctor` command reports these configuration checks without sending embedding requests.
See [Switch wiki embeddings off](../memory-modules.md#switch-wiki-embeddings-off) for the settings keys, kit overlay path, and restart check.

| Diagnostic | Level | Meaning |
| --- | --- | --- |
| `wiki_embeddings_shared_endpoint` | warn | Wiki embeddings share an endpoint host and port with OpenViking, or the `openviking` module is also enabled. |
| `wiki_embeddings_on` | info | Wiki embeddings are configured. The line reports model and host only; it does not verify credentials or service health. |

## Overlay and input

| Diagnostic | Cause | Fix |
| --- | --- | --- |
| `input_missing: overlay.file` | The file, or a directory of its path, does not exist. A relative path that does not resolve gives this too. (documented) | Give the absolute path of the file. |
| `input_path_unsafe: overlay.file` | A directory of the path is a link or is not a directory. A shell process substitution such as `<(...)` gives such a path. | Give a path through real directories to a regular file. |
| `input_unreadable: overlay.file` | The system refuses the read, for example because you have no read permission. (documented) | Check the owner and the mode of the file and of each directory of its path. |
| `input_not_regular: overlay.file` | The last name of the path is a link, a directory or another entry that is not a regular file. (documented) | Give the path of the regular file itself. |
| `input_encoding: overlay.file` | The file is not UTF-8 text. (documented) | Save the file as UTF-8. |
| `invalid_json: overlay.file` with `line` and `column` | The file is not valid JSON. The parser refuses the character at that line and column. The cause is often at the end of the line before: a missing comma or brace, or a fragment that was pasted into the file. (documented) | Correct the syntax at that place. Then run `python3 -m json.tool "<file>" >/dev/null && echo "JSON valid"`. |
| `input_too_deep: overlay.file`, `input_too_large: overlay.file` | The JSON nests deeper than 64 levels, or the file is larger than 1 MiB. (documented) | Check that the path names the overlay. |
| `input_path: overlay.file` | The path has a `.` or `..` segment. (documented) | Write the normalized absolute path. |
| `registry_required: registry` | The overlay has `modelRoutes` with a role or a cycle model, and no `--registry`. | Add `--registry "$HOME/.config/tenant-pi/registry.json"` to `validate`, `plan` and `generate`. |
| `registry_without_routes: registry` | `--registry` is given, but the overlay has no `modelRoutes`. | Remove `--registry` for a core-only overlay. |
| `unsupported_model_thinking: overlay.modelRoutes.choice` | The registry has no entry for a provider, model and thinking level of the overlay. | Add `{"<provider>": {"<model>": ["<level>"]}}` for each model you confirm. |
| `blocked_component: overlay.selection.enable` | A `blocked` module is enabled. | Move it to `selection.disable`. See [the module guide](modules.md). |
| `missing_dependency: overlay.selection.enable` | An enabled module requires another module that is not enabled. Example: `ops-footer` needs `context-meter`. | Enable the required module. |
| `memory_disabled: overlay.consent` | `consent.memoryCapture` is `true`, and no memory module is enabled. | Set it to `false`, or enable `hermes` or `wiki` with a `memory` block. |
| `memory_consent_required: overlay.consent.memoryCapture` | A memory module is enabled without consent. (documented) | Set `consent.memoryCapture: true` after you read [memory modules](../memory-modules.md). |
| `moved_key: overlay.endpoints.tenantext is now overlay.endpoints.codex-accounts` | The overlay uses the old gateway key. | Rename the key to `codex-accounts` in `endpoints` and `env`. |
| `unknown_fields: overlay` | The overlay has a key that this kit does not define. (documented) | Remove the key. |
| `input_missing: runtime_report.file`, `invalid_json: runtime_report.file` | The `--runtime-report` file is absent (`input_missing`), or it is empty or not JSON (`invalid_json`). A `check-runtime` run that stops with exit code 2 leaves an empty file behind a `>` redirect. (documented) | Run `python3 scripts/tenant_pi.py check-runtime > "<file>"` again and read its exit code. Exit code 1 still writes the report. |
| `runtime_report_required: runtime_report.pi.required`, `runtime_report.pi.tested` or `runtime_report.pi.acceptedRange` | The report comes from another tested version or range. The `required` rule also exists for `node` and `python`. (documented) | Make the report again with this kit. |
| `runtime_report_status: runtime_report.pi.status`, `runtime_report_installed: runtime_report.pi.installed` | The file is not an unchanged `check-runtime` report: a status does not agree with its versions, or `installed` is not a version. (documented) | Make the report again. Do not edit the file. |

The same rules apply to each JSON input, with another field: `manifest.file`, `registry.file`, `mcp.file`. [The CLI contract](../generator.md#input-file-errors) has the full table.

[Candidate comparison](../candidate-compare.md#overlay-compatibility-corrections) has more overlay rules and their fixes.

## Target, private directory and launcher

| Diagnostic | Cause | Fix |
| --- | --- | --- |
| `invalid_plan: target_mismatch: plan.targetAgentDir` | `--target` differs from `target.agentDir` of the overlay. | Use the same absolute path in both places. |
| `sample_target: overlay.target.agentDir` | The overlay still has the sample target `/home/EXAMPLE_USER/new-agent`. `init-private` without `--target` writes it. `validate`, `plan` and `generate` refuse it. (documented) | Change the one value of `target.agentDir` to the absolute path of the new profile. Check the syntax with `python3 -m json.tool "<file>" >/dev/null`. For a new private directory, use `init-private` with `--target`. |
| `under_kit: overlay.target.agentDir` | `target.agentDir` is the kit clone or is under it, also through a symbolic link. `validate`, `plan` and `generate` refuse it before any write. | Choose a target outside the clone, for example `"$HOME/.pi-profiles/main"`. Edit `target.agentDir` to match. |
| `under_pi_agent: overlay.target.agentDir` | `target.agentDir` is the live profile `~/.pi/agent` or is under it, also through a symbolic link. `validate`, `plan` and `generate` refuse it before any write. (documented) | Choose a target beside the live profile, for example `"$HOME/.pi/profiles/main"`. Edit `target.agentDir` to match. |
| `target_exists: target` | The target exists. `generate` never writes into an existing directory. | Choose a new target name, for example with a date. Edit `target.agentDir` to match. |
| `unsafe_path: target.parents` | The parent of the target does not exist, or a directory above it is a link or not a directory. | Create the parent with `mkdir -p`. Do not use a linked parent. |
| `unsafe_parent_owner: target.parent` | The immediate parent of the target is not owned by the caller. A parent of another non-root user fails earlier with `unsafe_owner`, so in practice root owns the parent and you are not root. (documented) | Use a parent that you own, for example `"$HOME/.pi-profiles"` when root owns `~/.pi`. |
| `unsafe_owner: target.parents`, `unsafe_permissions: target.parents` | A directory above the target belongs to another user, or others can write to it without a sticky bit. (documented) | Use a parent tree that only you own. |
| `pi_login_blocked: overlay.modelRoutes.gateway.auth` | The gateway uses `auth: "login"`. A fresh profile cannot log in to the gateway at this pin. (documented) | Use `{"auth": "env"}` and export `TENANTEXT_LITELLM_API_KEY`. |
| `target_exists: init-private.dir` | The private directory exists. | Keep the existing directory, or name a new one. The action never adopts a directory. |
| `under_pi_agent: init-private.dir` | The private directory is inside `~/.pi/agent`. | Use a directory outside the live profile, for example `"$HOME/.config/tenant-pi"`. |
| `under_kit: init-private.dir`, `under_overlay_target: init-private.dir` | The path is inside the kit clone or inside a profile target. (documented) | Use a directory outside both. |
| `absolute_path: init-private.target`, `shell_or_template: init-private.target` | The `--target` path is relative, starts with `~`, or has a `$`. The kit does not expand a path. (documented) | Give the expanded absolute path, for example `--target "$HOME/.pi/profiles/main"` in double quotes. |
| `under_pi_agent: init-private.target`, `under_private_dir: init-private.target`, `under_kit: init-private.target` | The `--target` path is inside the live profile, inside the private directory or inside the kit clone. (documented) | Choose a target outside the three, for example `"$HOME/.pi/profiles/main"`. |
| `home_required: init-private.home` | `HOME` is not set. `init-private` and `--launcher` need it. | Run the command in a shell with `HOME` set to an absolute path. |
| `home_required: target.home`, `absolute_path: target.home` | `HOME` is not set, or it is not an absolute path without a trailing slash. `validate`, `plan` and `generate` need it to find `~/.pi/agent`. (documented) | Run the command in a shell with `HOME` set to an absolute path. |
| `target_exists: launcher.path` | The launcher file exists. The check runs before the target is created. | Remove the old file after review, or use a new name, for example `launch-main-2.sh`. |
| `absolute_path: launcher.path` | The launcher path is relative. | Give an absolute path. |

## Comparison and carry

| Diagnostic | Cause | Fix |
| --- | --- | --- |
| `same_directory: compare.right` | `--left` and `--right` are the same path. | Name two different directories. |
| `absolute_path: compare.left` | A side is a relative path. | Give absolute paths. |
| `settings_missing` | A side has no `settings.json`. (documented) | Check the path. |
| `unsupported_schema_version` | A side comes from a kit with another schema. (documented) | Follow the migration steps of [candidate comparison](../candidate-compare.md#schema-versions-and-migration). |
| `report_right_mismatch: report.right.path` | `carry --right` differs from `right.path` of the report. (documented) | Use the exact `--right` path of the `compare` run. |

## Runtime and environment

These failures come from the runtime or from the environment of the launching shell.

### `pi --version` opens the live profile

A bare `pi` command reads `~/.pi/agent`, or the directory in `PI_CODING_AGENT_DIR`. A version check can then touch the live profile.

1. Run `python3 scripts/tenant_pi.py check-runtime`. It sets `PI_CODING_AGENT_DIR` to an empty temporary directory for `pi --version` and removes the directory.
2. Without the kit, run `PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version`.

### `check-baseline` reports `changed` or `no_baseline`

| Output | What to do |
| --- | --- |
| `"result":"no_baseline"` | The baseline file does not exist. Check the `--baseline` path. A baseline that you record after the launch proves nothing about the launch: record the check as not run. |
| `"result":"changed"` with names | A Pi in the live profile, or a command of the install, changed these direct entries. See [the directory baseline](../directory-baseline.md#a-pi-in-the-live-profile). |
| `"result":"changed"`, no names, `"directoryModified":true` | An entry was made and removed in the directory. A bare `pi --version` does this: observed with Pi 1.0.2 and a `settings.json` in the directory. The command counts also when the installing agent ran it. |
| `target_exists: baseline.out` | A baseline exists at that path. Keep it. For a second baseline, give another file name. |
| `not_directory: baseline.dir` | The directory, or a directory above it, is a symbolic link. Give the real path, for example from `realpath "$HOME/.pi/agent"`. |

### `PI_CODING_AGENT_DIR` points at the wrong profile

A shell that exports `PI_CODING_AGENT_DIR` changes every later `pi` command of that shell. The launch line sets the variable for one process only.

1. Run `echo "${PI_CODING_AGENT_DIR:-<unset>}"` before a manual `pi` command.
2. Start a profile only with its launcher file or the exact plan line. Do not export the variable in a startup file.

### `check-runtime` reports `mismatch` or `missing`

| Status | Fix |
| --- | --- |
| `untested_in_range` for `pi` | Keep the installed version and record `core_runtime_untested_in_range`. The kit tests ran on the tested version only. |
| `missing` for `pi` | Install the pin by hand (setup Stage 6), or add its directory to `PATH` in the launching shell. |
| `mismatch` for `pi` | Keep the other Pi and record the gap, or install the manifest pin (`runtime.piVersion`) under a prefix. Do not run the global install line as a default step: it replaces the other Pi for every profile. Example: an installed Pi `0.99.2` is a `mismatch`. |
| `mismatch` for `node` | Select Node 22 with your version manager in the launching shell. |
| `unparsed` | Run the tool with `--version` by hand and read the output. |

### The key or the `PATH` line is missing in another shell

A non-interactive SSH command, a browser terminal, a desktop launcher or a service does not always read your interactive startup file. See [the setup guide](setup.md#shells-that-do-not-inherit-your-variables). Run `check-runtime` and the `test -n` check in the shell that starts Pi.

### Pi starts with `Cannot find module 'yaml'`

The Node dependencies of `packages/tenantext` are absent. Run `npm ci --ignore-scripts` in that directory by hand. Observed with Pi 0.99.1.

### Pi warns about host-provided extension packages

Pi `0.99.x` printed this warning at start. Not verified: the warning on the kit pin in `config/manifest.json`, key `runtime.piVersion`.

```text
Warning: Extension package ".../package.json": Host-provided extension packages must be declared in
peerDependencies with a "*" range, not dependencies: typebox.
```

A memory package lists a host module under `dependencies`. Run the override by hand:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

An update of the package writes the old manifest again. See [host peer overrides](../host-peer-overrides.md) for the `npmCommand` wrapper. That wrapper adds `npmCommand` to `settings.json`, and the next `compare` shows it as drift. List `/npmCommand` in `unmanaged` to accept it. See [accepted drift](../accepted-drift.md).

## Kit checks

### The publish check fails after pytest

`pytest` writes a `.pytest_cache/` directory into the clone. The publish check counts every file that is not in its reviewed inventory, so it fails:

```text
unreviewed_file: repository inventory
.pytest_cache/.gitignore
```

One path line follows the finding line for each such file. The sample shows the first.

1. Remove the cache directory: `rm -rf .pytest_cache`. Check the path before you run it.
2. Run the tests with `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q`.

The same failure comes from any untracked file in the clone, for example `dist/` of `packages/promptr`.

### The documentation check fails

The unit tests run the documentation check. A finding fails the test `DocCheckRepoTests` of `tests/test_doc_check.py`, and the failure text holds each finding.

Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py` to see the findings alone. It prints one `rule: path:line` line for each finding. See [the release checklist](release-checklist.md#documentation-check) for each rule.

## When nothing here fits

1. Keep every directory as it is. Do not retry `generate` into the same target.
2. Write the exact diagnostic, the command and the stage into `install-log.md` of the private directory.
3. Read the document of the action: [generator](../generator.md), [private directory](../private-directory.md), [launcher](../launcher.md), [candidate comparison](../candidate-compare.md), [carry](../carry.md).
