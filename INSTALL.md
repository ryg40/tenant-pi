# Install a Pi profile from this kit

This file is for an agent that a user points at this repository: Claude Code, Pi, or another coding agent. Read the whole file first. Then walk the user through the stages in order. Each stage has a goal, the commands, and the check that proves it is done.

The kit prepares a separate Pi profile in a new directory. It never writes into an existing Pi profile directory. The companion guide `skills/tenant-pi-install/SKILL.md` follows the same order and asks a question at each stage. Its stage names and numbers differ from the ones here.

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

`runtime.piAcceptedRange` is the accepted Pi range. `runtime.piVersion` is the tested version.
A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.
With `untested_in_range`, keep the installed Pi and record `core_runtime_untested_in_range` as a readiness gap.
The Pi install line stays a plain command with `not_needed`, not `replaces_installed`.

Words used below:

- `<clone>`: the directory of this repository, for example `~/tenant-pi`.
- `<private dir>`: a directory outside the clone that only the user can read, for example `~/.config/tenant-pi`. It holds the overlay, the input files and the install log.
- `<target>`: the absolute path of the new profile directory from `target.agentDir` in the overlay.

## Rules for the agent

1. Ask before each command that changes the machine: an install, a new directory, a shell file, a credential. Show the command. Run it when the user says yes. Running it yourself is allowed; running it without a yes is not.
2. Never write, print, or paste a secret. Name a credential by its environment variable only.
3. Never write into `~/.pi/agent` or into the directory in `PI_CODING_AGENT_DIR`. The kit generates into a new, absent directory only. `init-private --target`, `validate`, `plan` and `generate` refuse a target that is `~/.pi/agent` or is under it, with the rule `under_pi_agent`. The kit does not read `PI_CODING_AGENT_DIR`: when Stage 0 printed that variable, keep the target outside that directory yourself.
4. Adapt the syntax of a command to the machine (see "Local differences"). Do not adapt the rules of the kit: no secret in a file, no generation into an existing directory, no edit of a live profile.
5. Record what you ran, what you skipped, and every adaptation in `<private dir>/install-log.md`. A live check that did not run is "not run", never "passed".
6. If a stage fails, keep the earlier stages, say what failed, and stop at a state the user can resume from.

Warning: `.local/` inside the clone is ignored by Git but is not a security control. Keep the overlay and the input files in `<private dir>`, outside the clone.

## Stage 0: inventory

Goal: know the machine. Run read-only:

```sh
uname -sm; node --version; npm --version; python3 --version; git --version
command -v pi && PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version
env | grep '^PI_CODING_AGENT_' || echo "no PI_CODING_AGENT_ variable"
for d in "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] || [ -L "$d" ]; then echo "live agent directory present: $d"; else echo "live agent directory absent: $d"; fi
done
```

Run `pi --version` with `PI_CODING_AGENT_DIR` set to an empty temporary directory, because a bare `pi` command opens the live `~/.pi/agent`.

The `env` line prints every `PI_CODING_AGENT_*` variable. Run it in the shell that will launch Pi (a login shell, if the user starts Pi from one). Record each name. `PI_CODING_AGENT_DIR` names the live agent directory. `PI_CODING_AGENT_SESSION_DIR` moves the sessions of every profile. The launch line of the kit removes it for the generated profile (see `docs/launcher.md`). Never edit a shell startup file to remove a variable.

The `for` loop prints one line for `~/.pi/agent`. When `PI_CODING_AGENT_DIR` is set, it prints one more line for that directory. Each line says `present` or `absent`, then the path. No line is not `absent`: when a line is missing from the output, run the loop again. Record each line.

The clone does not exist at this stage on a first install, so these manual commands are the usual path here. After Stage 2, and on each later run of this stage, one command replaces the three version commands:

```sh
python3 <clone>/scripts/tenant_pi.py check-runtime
```

`check-runtime` runs `pi --version`, `node --version` and `python3 --version`, and compares each with the requirements below. It prints one JSON object with `installed`, `required` and `status` for each tool. The Pi entry also has `tested` and `acceptedRange`. The status is `match`, `untested_in_range` (Pi only), `mismatch`, `missing` or `unparsed`. The exit code is 0 with `match` for all tools, or `untested_in_range` for Pi and `match` for the others. It is 1 otherwise; at this stage that is a finding, not a failure. `--pi`, `--node` and `--python` take the absolute path of another executable. See `docs/check-runtime.md`.

`check-runtime` sets `PI_CODING_AGENT_DIR` to an empty temporary directory itself and removes the directory. The manual commands stay the fallback when `python3` is absent or older than 3.11.

Requirements:

| Item | Required |
| --- | --- |
| Node | `>=22.22.0 <23` |
| Python | `>=3.11` |
| Git | any current version |
| Pi | `runtime.piAcceptedRange`; Stage 3 installs the tested `<pin>` when needed |
| Linux | first target; not verified: a complete live run |
| macOS | not qualified; the adaptations below are unqualified, see `docs/guides/release-checklist.md` |

Done when you can state the OS, Node, Python, Git and Pi, and for each live agent directory the word `present` or `absent` from its line.

## Stage 1: requirements

Goal: Node, Python and Git at the required versions. Show the command for the machine, then run it on yes.

| Machine | Node 22 | Python 3.11+ | Git |
| --- | --- | --- | --- |
| macOS, Homebrew | `brew install node@22`, then `brew link --overwrite node@22` | `brew install python@3.12` | `xcode-select --install` |
| macOS or Linux, nvm | `nvm install 22 && nvm use 22` | distribution package or Homebrew | distribution package |
| Debian or Ubuntu | NodeSource 22 repository, or nvm | `apt install python3` | `apt install git` |
| Fedora | `dnf install nodejs22` | `dnf install python3` | `dnf install git` |

Warning: `brew link --overwrite node@22` and `nvm use` change the default `node` of the user. A Pi that another Node installed can stop working. Ask first.

The same Node must install Pi and build native addons later. If several Node installs exist, ask which one, and use it for every later command.

Done when `node --version` and `python3 --version` print versions inside the required ranges and `git --version` prints a version. After Stage 2, `check-runtime` must report `match` for `node` and `python`.

## Stage 2: clone and check the kit

```sh
git clone <kit repository URL> ~/tenant-pi
cd ~/tenant-pi
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
```

Ask which URL when the user has more than one. The clone must not be the target directory. The user must not move or delete the clone later: the generated profile points at `packages/` inside it.

Done when the tests pass and the publish check prints `publish set valid`.

## Stage 3: install Pi

After the overlay exists, `python3 scripts/tenant_pi.py plan --overlay <file>` prints the same line in `commands.piInstall`, key `command`.

```sh
python3 scripts/tenant_pi.py check-runtime
```

Read the `pi` entry of the output. The action sets `PI_CODING_AGENT_DIR` to an empty temporary directory for `pi --version`, because a bare `pi` command opens the live `~/.pi/agent`.

Fallback, when the action cannot run:

```sh
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version
```

With `match` or `untested_in_range`, skip the Pi install.

If the status is `missing` (`pi` is absent), first see whether the user can write the global npm prefix:

```sh
p="$(npm config get prefix)"; test -w "$p/lib/node_modules" && test -w "$p/bin" && echo writable || echo "not writable"
```

It prints `writable` when the user can write `lib/node_modules` and `bin` of the prefix, and `not writable` otherwise. A directory that does not exist gives `not writable`. The user `root` gets `writable`.

The test writes nothing into the npm prefix. `npm config get prefix` writes one debug log file into the npm cache directory of the user (default `~/.npm/_logs`), and makes that directory when it is absent.

If it prints `writable`, show the global command and run it on yes:

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Warning: a global install replaces the `pi` command that every profile of the user runs.

The user can refuse the global command and use the prefix form below in its place.

The command fixes the version of the Pi package, not all versions of its dependencies. See [what the install command fixes](docs/check-runtime.md#what-the-install-command-fixes).

If it prints `not writable` (for example a user without root on a Node that root owns), the global command fails. Show the prefix form and run its install command on yes:

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@"${pin:?}"
export PATH="$HOME/.npm-global/bin:$PATH"
```

The directory `"$HOME/.npm-global"` is the example; the user can name another directory that the user owns (`--prefix <dir>`). The `export` line changes the current shell only. The kit never edits a shell startup file. The `PATH` line is the user's step. Record the prefix and its `PATH` line as an adaptation.

If the status is `mismatch` (outside the accepted range), tell the user the installed and the tested version, and ask. If the status is `unparsed`, run the fallback command, read its output, and ask. Three options:

- Stop.
- Keep the existing Pi, and record the version mismatch as a gap.
- Install the pin with the prefix form above, under a prefix that the user names. The existing Pi stays in its place. Record the prefix and its `PATH` line as an adaptation.

The global install command is not the default for a `mismatch`: it replaces the installed Pi for every profile of the user, and it is a downgrade when the installed Pi is newer.

Run the global command for a `mismatch` only when the user asks for that replacement in clear words, after the warning above. For `unparsed`, make a new report before deciding whether to replace the installed Pi.

With the second option, Stage 6 shows the gap as `core_runtime_mismatch` with both versions. With the report of Stage 6, `commands.piInstall` marks the global command as `not_needed`, `needed` or `replaces_installed`, and a `mismatch` takes the command out of `commands.setupDisplayOnly`.

Warning: `npm config set prefix` changes the npm configuration of the user for every later global install. Use `--prefix` on the single install command instead.

Done when `check-runtime` reports `match` or `untested_in_range` for `pi` in the shell that will launch Pi. Record the gap for an untested version.

## Stage 4: package dependencies

Goal: the in-tree Tenantext package can load. Needed when any Tenantext component is enabled in Stage 5. The recommended selection enables them.

```sh
cd ~/tenant-pi/packages/tenantext && npm ci --ignore-scripts
```

Observed with Pi 0.99.1: without this step Pi fails at start with `Cannot find module 'yaml'`. The kit has no test for this; see `docs/packages.md`.

The step leaves `packages/tenantext/node_modules/` in the clone. `scripts/publish_check.py` ignores each `node_modules/` directory.

The Promptr package needs a build when you enable `promptr`: run `npm ci --ignore-scripts` and `npm run build` in `packages/promptr`. The build leaves `packages/promptr/node_modules/` and `packages/promptr/dist/` in the clone; `scripts/publish_check.py` ignores both. When no tracker binding exists, set `GITEA_HOST`, `GITEA_OWNER` and `OPENKNOWLEDGE_ORIGIN` in the shell that starts Pi: without them Promptr shows placeholder defaults. Without `promptr` in `enable` the package needs no step.

Done when `packages/tenantext/node_modules/yaml` exists.

## Stage 5: the private overlay

Goal: an overlay in `<private dir>` that names `<target>`, and an absent target directory under an existing parent.

Ask the user for `<target>` first: the absolute path of the new profile. Its parent exists; its last segment does not. Example: `/Users/<name>/.pi/profiles/<profile>` on macOS, `/home/<name>/.pi/profiles/<profile>` on Linux.

The parent of the target must exist before Stage 6. The recommended parent is `~/.pi/profiles`, a directory beside `~/.pi/agent`, not inside it. Show and run on yes:

```sh
mkdir -p ~/.pi/profiles
```

If `~/.pi` belongs to another user, use a parent beside it, for example `~/.pi-profiles`.

Create `<private dir>` with the `init-private` action, and give it the target with `--target`. The action needs an absent directory under an existing parent that the user owns. Both paths are expanded paths, not `~`. Write `"$HOME/..."` in double quotes: the shell then expands it.

```sh
mkdir -p ~/.config
cd ~/tenant-pi && python3 scripts/tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/<profile>" [--overlay <existing overlay>]
```

With `--target`, the new `overlay.json` has that path as `target.agentDir`, and the output shows it as `targetAgentDir`. A core-only profile then needs no edit and no editor: go to the `validate` command below. The action does not create the target. It refuses a target that is `~/.pi/agent` or is under it, that is inside `<private dir>`, or that is inside the clone. `validate`, `plan` and `generate` refuse the same two places for `target.agentDir`, also in an overlay that was edited by hand: `under_pi_agent: overlay.target.agentDir` and `under_kit: overlay.target.agentDir`.

When the host already has an overlay, for example of an earlier profile, pass `--overlay <existing overlay>` once for each such file: the action then refuses a directory under the target of that overlay. Without the option it knows only the sample target and the target of `--target`.

The action creates the directory with mode 700 and, with mode 600, `overlay.json` (`config/config.example.json` with the target of `--target`), `registry.json` (`{}`), `install-log.md`, `accepted-drift.md` and `.gitignore`, plus an empty `inputs/` directory. It prints the created paths, the edit and `validate` commands, and a `git init` line. It does not run Git: show the `git init` line and run it only on the user's yes. See `docs/private-directory.md` for the refusals.

Fallback, when `<private dir>` exists already (the action refuses it with `target_exists: init-private.dir`) or the action is not available:

```sh
mkdir -p ~/.config/tenant-pi && chmod 700 ~/.config/tenant-pi
cp ~/tenant-pi/config/config.example.json ~/.config/tenant-pi/overlay.json
```

The fallback creates only the overlay copy. Do not overwrite an `overlay.json` that exists.

The fallback copy, and an `init-private` run without `--target`, have the sample target `/home/EXAMPLE_USER/new-agent`. `validate`, `plan` and `generate` refuse it with `sample_target: overlay.target.agentDir`. Then the user changes the target by hand:

- Tell the user the one key and the one value: "In `overlay.json`, change the value of `target.agentDir` from `/home/EXAMPLE_USER/new-agent` to `<target>`. Change nothing else."
- Give the expanded path, not `~`.
- Do not give the user a JSON fragment to paste. A pasted fragment can make the file invalid.

After each edit by hand, check the syntax before `validate`:

```sh
python3 -m json.tool ~/.config/tenant-pi/overlay.json >/dev/null && echo "JSON valid"
```

The command prints `JSON valid`, or the line and the column of the first syntax error. With `>/dev/null` it does not print the file.

Edit `overlay.json` for the other answers of the user. A core-only profile needs none of them:

1. `target.agentDir`: `--target` sets it. Change it by hand only as described above.
2. `selection.enable` and `selection.disable`: move each chosen ID from `disable` to `enable`. Recommended full set: `core`, `model-routing`, `tenantext`, `codex-accounts`, `slopscore`, `context-meter`, `ops-footer`, `copilot-usage`, `anthropic-usage`, `doctor`, `resources`, `herdr`, `coordinator-skills`, `knowledge-skills`, `slopscore-pr`. `promptr` and its four skills are `unverified` and need the build step of Stage 4. `tracker-site` is selectable but `unverified`; it needs Python 3.11 or later and Git on `PATH`, with no third-party Python package. `check-runtime` checks Python, not Git. `openviking` is a memory module; see item 5.
3. `roles.interactive`: the model for the session, as `provider`, `model` and `thinking`. See `docs/model-routes.md`.
4. Gateway, only when the user routes through the Tenantext gateway: `modelRoutes.gateway` is `{"auth": "env"}`; `endpoints.codex-accounts` is the gateway URL that ends in `/v1`; `env.codex-accounts` is `${TENANTEXT_LITELLM_API_KEY}`. The user exports the key themselves.
5. `hermes`, `wiki` and `openviking`: optional, off by default. Each needs `consent.memoryCapture: true` and a `memory` block. `openviking` also needs `consent.remoteMemoryWrites: true`, an OpenViking server that the user set up, and `npm ci --ignore-scripts` in `packages/openviking-pi`. Read `docs/memory-modules.md` with the user first.
6. `mcp`: optional, off by default. The server definitions go to `<private dir>/inputs/mcp-adapter.json`, and the overlay gets `inputs.mcpFile: "inputs/mcp-adapter.json"`. Every `validate`, `plan` and `generate` call then needs `--local-dir ~/.config/tenant-pi`. Read `docs/workflow-modules.md` with the user first.

7. Registry, required when `modelRoutes` names a model for a role or the cycle: edit `~/.config/tenant-pi/registry.json` (mode 600; `init-private` creates it as `{}`, the fallback does not create it).
   Its whole shape is `{"<provider>": {"<model>": ["<thinking level>"]}}`, with one entry for each model of `roles` and `modelRoutes.cycle`.
   The user confirms each entry. The file is evidence of the user's choice, not a model catalog. See `docs/generator.md`.

Validate after each edit:

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py validate --overlay ~/.config/tenant-pi/overlay.json --registry ~/.config/tenant-pi/registry.json
```

Without `--registry`, a `modelRoutes` choice stops with `registry_required: registry`.
Omit `--registry` when the overlay sets no role and no cycle model.
An overlay without `modelRoutes` refuses the option with `registry_without_routes: registry`.

An error is one JSON line on standard error with `rule: field`, never a value. `docs/candidate-compare.md` lists the common corrections.

When the kit cannot use the overlay file, the rule names the cause:

| Error | Cause |
| --- | --- |
| `input_missing: overlay.file` | The file, or a directory of its path, does not exist. |
| `input_path_unsafe: overlay.file` | A directory of the path is a link or is not a directory. |
| `input_unreadable: overlay.file` | The system refuses the read, for example no read permission. |
| `input_not_regular: overlay.file` | The path names a link, a directory or another entry that is not a regular file. |
| `input_encoding: overlay.file` | The file is not UTF-8 text. |
| `invalid_json: overlay.file` | The file is not valid JSON. The line has the place of the error. |
| `input_too_deep: overlay.file`, `input_too_large: overlay.file` | The JSON nests deeper than 64 levels, or the file is larger than 1 MiB. |

A JSON syntax error has two more keys, `line` and `column`:

```json
{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}
```

Tell the user the line and the column. The parser refuses the character at that place; the cause is often at the end of the line before, for example a missing comma. The output holds no file content, and you need no script to find the place. The same rules apply to `registry.file`, `manifest.file` and `mcp.file`. See `docs/generator.md`, section "Input file errors".

Done when `validate` prints `"valid":true`.

## Stage 6: plan and generate

```sh
cd ~/tenant-pi
python3 scripts/tenant_pi.py plan --overlay ~/.config/tenant-pi/overlay.json --registry ~/.config/tenant-pi/registry.json
python3 scripts/tenant_pi.py generate --overlay ~/.config/tenant-pi/overlay.json --registry ~/.config/tenant-pi/registry.json --target '<target>'
```

Use the same `--registry` choice as in Stage 5 for both commands.

Add `--local-dir ~/.config/tenant-pi` to both commands when `mcp` is enabled.

Add `--launcher ~/.config/tenant-pi/launch-<name>.sh` to both commands to get the launcher file of Stage 9. The file must not exist. `plan` only prints the path; `generate` writes the file after the profile is complete.

Give both commands the runtime versions, so that the gaps show the measured state. `plan` and `generate` start no process, so save the report of `check-runtime` first, in the shell that will launch Pi:

```sh
python3 scripts/tenant_pi.py check-runtime > ~/.config/tenant-pi/runtime.json
```

Exit code 1 is a finding here, not a failure: the file holds the report. Then add `--runtime-report ~/.config/tenant-pi/runtime.json` to both commands. Make the report again after each change of Node or Pi. The kit cannot tell an old report from a current one.

Read the plan with the user before `generate`: the `files` list, `readinessGaps`, and `commands`. Every in-tree component shows `pi_line_unqualified` and `kit_test_missing`. These are facts to carry, not errors.

The first gaps of the list follow the facts:

| Gap | Meaning |
| --- | --- |
| `target_absence_unverified` | `plan` does not prove that `<target>` is absent. `generate` proves it when it creates the directory, so the output of a complete `generate` does not list this gap. |
| `node_runtime_unverified`, `core_runtime_unverified` | No `--runtime-report`: the Node or Pi version is not measured. |
| `core_runtime_untested_in_range` | The installed Pi is accepted but untested. The gap names `installed`, `tested` and `acceptedRange`. |
| `node_runtime_mismatch`, `core_runtime_mismatch` | The report has `mismatch`. The gap names the `installed` and the `required` version. |
| `node_runtime_missing`, `core_runtime_missing` | The report has `missing`: the shell did not find the tool. |
| `node_runtime_unparsed`, `core_runtime_unparsed` | The report has `unparsed`: the tool gave no readable version. |

A `match` in the report removes the gap of that tool. If the user kept another Pi in Stage 3, `core_runtime_mismatch` is that gap: record it in the install log with both versions. See `docs/profile-plan.md`.

`commands.piInstall` marks the global Pi install command of Stage 3. Read its `status` before you show the command:

| `status` | Meaning | Command in `commands.setupDisplayOnly` |
| --- | --- | --- |
| `installed_version_unknown` | No `--runtime-report`, or the report has `unparsed` for Pi. Do Stage 3 first. | yes |
| `needed` | The report has `missing` for Pi. | yes |
| `not_needed` | The report has `match` or `untested_in_range` for Pi. Skip the install. | no |
| `replaces_installed` | The report has `mismatch`: the command replaces the `installed` version with the `required` version. `change` is `downgrade` when the installed Pi is newer, `upgrade` when it is older, and `unordered` when the numbers are equal. The three choices of Stage 3 apply. | no |

`warning` is `global_install_replaces_pi_for_all_profiles` in each case: one `pi` command serves every profile of the user. Never run the command of a `replaces_installed` mark as a default step.

Done when `generate` prints `"filesComplete":true` and `<target>` holds `settings.json` and `.tenant-pi/`. `runtimeReady` is always `false`: this kit has no live trial of a generated profile. Read `readinessGaps`: the list of a complete `generate` is empty only with a report with `match` for Node and Pi, and a profile without another gap. The report compares version numbers only and is not a launch check: Stage 9 has the launch checks. With `--launcher`, exit code 1 with `launcher.error` in the output means that the profile is complete and the launcher file is not; see `docs/launcher.md`.

## Stage 7: declared npm packages

Only when `mcp`, `hermes` or `wiki` is enabled.

Record the baseline of the live agent directory first: see "Before the first launch" in Stage 9. `pi update --extensions` is the first Pi command that names `<target>`.

```sh
PI_CODING_AGENT_DIR='<target>' pi update --extensions
PI_CODING_AGENT_DIR='<target>' node ~/tenant-pi/scripts/patch_extension_peers.mjs
```

These three packages are declared without a version. The first command installs the current registry version of each; tell the user which versions it installed. The kit reviewed `pi-mcp-adapter` 3.2.0, `pi-hermes-memory` 0.9.9 and `@zosmaai/pi-llm-wiki` 0.12.4. The second command corrects host-provided peers in the installed manifests.

To reapply the correction after each update, `docs/host-peer-overrides.md` describes an `npmCommand` wrapper.

- The commands of that document write to `~/.pi/agent`. Replace `~/.pi/agent` with `<target>` in every path.
- Ask before each write.
- The wrapper is for Linux and macOS. The systemd unit of that document is for Linux only.
- The `npmCommand` key then shows as drift in `compare` (Stage 10). That is expected.

Hermes builds `better-sqlite3`. On macOS that needs the Xcode command line tools from Stage 1.

Done when `PI_CODING_AGENT_DIR='<target>' pi list` shows the declared sources.

## Stage 8: authentication

The kit writes no credential. Two paths:

- Native provider: launch Pi (Stage 9) and run `/login` inside it. Pi stores the result in `<target>/auth.json`.
- Tenantext gateway: the user exports `TENANTEXT_LITELLM_API_KEY` in the shell that launches Pi. The launch line carries `TENANTEXT_LITELLM_BASE_URL`.

For the gateway, ask how the key reaches the process: the launching shell, a launcher script the user writes, or a secret store the user already uses. Never edit a shell startup file yourself.

## Stage 9: first launch and checks

### Before the first launch: the baseline of the live agent directory

Goal: a record that can prove, after the launch, that the live agent directory did not change. Record it one time, before the first Pi command that names `<target>`: before Stage 7 when Stage 7 applies, else here.

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

- The action does not change the directory. It lists the directory and reads the name, the kind, the size and the modification time of each entry. It opens no file, so the baseline holds no file content and no credential value. See `docs/directory-baseline.md`.
- The one write is the new file in `<private dir>`, with mode 600. Ask before you run the command.
- The action never replaces a baseline. An existing file stops it with `target_exists: baseline.out`. Keep the first baseline: a baseline from a time after the launch proves nothing.
- Run it also when Stage 0 printed `absent`. The baseline then records that the directory is absent.
- When Stage 0 printed `PI_CODING_AGENT_DIR`, record a second baseline for that directory: `--dir "$PI_CODING_AGENT_DIR"` and `--out "$HOME/.config/tenant-pi/live-baseline-env.json"`. When Stage 0 printed `PI_CODING_AGENT_SESSION_DIR`, record one more: `--dir "$PI_CODING_AGENT_SESSION_DIR"` and `--out "$HOME/.config/tenant-pi/session-dir-baseline.json"`.
- If the action stops with `not_directory: baseline.dir`, the directory or a directory above it is a symbolic link. Run `realpath "$HOME/.pi/agent"`, give that path as `--dir` to `baseline` and to `check-baseline`, and record both paths.
- Ask the user whether a Pi runs in the live profile now. A Pi in the live profile also changes the directory. Ask the user to close it for the time of the install, or record that it runs.

Done when the output has `"complete":true` under `baseline`. Record `recordedAt` of the output.

### Launch

The recommended way to launch is the launcher file. Add `--launcher '<launcher file>'` to the `generate` command of Stage 6, for example `--launcher ~/.config/tenant-pi/launch-<name>.sh`. After a complete generation, the kit writes that file with mode `0700`: `#!/bin/sh` and one `exec` line with the exact `commands.launchDisplayOnly` line of the plan. Ask the user to run the file, or run it on yes. With the gateway, the shell that runs the file must export `TENANTEXT_LITELLM_API_KEY`; the file holds no key. See `docs/launcher.md`.

Without a launcher file, use the exact `commands.launchDisplayOnly` line from the plan.

Rule: the profile keeps its sessions in `<target>/sessions`. The launch line holds `env -u PI_CODING_AGENT_SESSION_DIR`, which removes an inherited session directory for the one `pi` process. Do not remove that part, and do not start the profile with a bare `PI_CODING_AGENT_DIR='<target>' pi` in a shell where Stage 0 found `PI_CODING_AGENT_SESSION_DIR`.

### Checks

1. `pi --version` in that environment prints `<pin>` or an accepted version. Record the untested-version gap when needed.
2. Startup prints no extension error and no peer warning.
3. The chosen model replies to the fixed prompt, and the reply holds the expected number: see "Check 3: the model reply" below. An auth error with the gateway means the key did not reach the process.
4. The profile stayed inside its directory. `ls -la '<target>'` shows the generated files plus what Pi wrote: `auth.json`, `sessions/`, `npm/`, the state directories of the extensions. The comparison of the live agent directory with its baseline gives `unchanged`: see "Check 4: the comparison with the baseline" below.
5. With Hermes: `<target>/pi-hermes-memory/` exists after the first session. With the wiki and ambient off: `~/.llm-wiki` was not created.
6. With the MCP module: `/mcp-adapter status` inside Pi lists only the servers from the input file.

Record each check as passed, failed, or not run. Check 4 has one more value, not verified.

### Check 3: the model reply

The fixed prompt is:

```text
What is 17 plus 26? Reply with the number only.
```

The expected reply is the number `43`. The prompt text does not hold that number, so the number comes from a reply and not from the prompt.

- Use the prompt as it is. Do not write a prompt that holds its own reply, such as "Reply with exactly: ...".
- Do not give the user the expected reply before the check. A user who types the expected reply puts it on the screen without a model.
- Check 3 has two results: "Model replied" and "Reply matched". Record them as two lines, each with yes, no or not run. Check 3 is passed only when both are yes. "Pi printed text" is not "Reply matched".

Preferred form: print mode. With `-p`, Pi sends one prompt, writes the final reply of the model to standard output, and exits. The output holds no user line, no thinking text and no screen frame. See "Print mode" in `docs/launcher.md`.

1. Print mode cannot log in. With a native provider, launch the profile one time, run `/login`, select the model, and exit Pi.
2. Add `-p` and the prompt in single quotes to the exact `commands.launchDisplayOnly` line of the plan. The launcher file takes no argument, so use the plan line. Example for a core-only profile:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"
   ```

3. Read the output:

| Output | Model replied | Reply matched |
| --- | --- | --- |
| Text that holds `43`, then `exit status: 0` | yes | yes |
| Text without `43`, then `exit status: 0` | yes | no |
| An error text, no text, or an exit status that is not 0 | no | no |

Print mode writes an error text to standard error. With the gateway, an auth error means that the key did not reach the process.

Print mode uses the default model of the profile. Pi reads a provider key from the environment of the launching shell, including in a profile with no login. Not verified: which variable names Pi reads for each provider. Use the name that the Pi documentation gives. To get the reply from one named model, add `--model '<provider>/<model>'` before `-p`.

Other form: a pasted screen. Use it when the user sends the prompt inside an interactive Pi session. The user types the fixed prompt and pastes the screen. A Pi screen has no labels. Its lines come in this order:

1. The user line: the text that the user typed.
2. Thinking text of the model, when the model shows it.
3. The model line: the reply of the model.

Separate the user line from the model line before you read the result:

- The user line must be the fixed prompt. If it holds other text, the check did not run: ask the user to send the fixed prompt.
- "Reply matched" is yes only when `43` is in the model line. A `43` in the user line or in the thinking text is not a reply.
- If you cannot tell the lines apart, ask for the print mode command.

### Check 4: the comparison with the baseline

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"
```

The action writes nothing. Read `result` in its output:

| `result` | Meaning | Record check 4 as |
| --- | --- | --- |
| `unchanged` | No entry was added, removed or modified after `recordedAt`. A directory that was absent is still absent. | passed, with the rule on `recordedAt` below |
| `changed` | The directory differs from the baseline. `added`, `removed` and `modified` name the direct entries that differ. `directoryModified` is `true` when an entry was made or removed in the directory itself. | failed, or not verified: see below |
| `no_baseline` | The baseline file does not exist. The action compared nothing. | not run, never passed |

Record check 4 as passed only when `recordedAt` is before the first Pi command that names the target. With a later baseline, record check 4 as not run: that comparison proves nothing about the launch.

Run the same comparison for each other baseline that you recorded before the launch, with its own `--dir` and `--baseline`.

A Pi that the user runs in the live profile during the install also changes the live agent directory. A session writes under `sessions`. Pi can write `auth.json` and the state files of the extensions. Observed with Pi 1.0.2 and a `settings.json` in the directory: a `pi --version` without `PI_CODING_AGENT_DIR` gives `changed` with empty name lists and `"directoryModified":true`. Not verified: other Pi versions. The comparison shows what changed. It does not show which process changed it.

With `changed`, find out whether a Pi ran in the live profile after `recordedAt`, from the user or from you. Read your own commands first: each command that you ran, and each command that you gave the user to run. Then ask the user: did a Pi run in the live profile after `recordedAt`? A `pi` command without `PI_CODING_AGENT_DIR` counts as a Pi in the live profile, also `pi --version`, and also when the installing agent ran it.

- No Pi ran there. Record check 4 as failed, with the names. Stop and report: a command of the install wrote outside `<target>`.
- A Pi ran there. Record check 4 as not verified, with the names, the answer of the user and your own command when you ran one. Do not record it as passed.
- To get a proof after that: the user closes each Pi of the live profile. Record a second baseline with a new file name, for example `live-baseline-2.json`. Launch the generated profile again and send one prompt. Then compare with the second baseline.

## Local differences

Adapt the syntax, keep the rule.

| Difference | Linux | macOS |
| --- | --- | --- |
| Home root | `/home/<name>` | `/Users/<name>` |
| Default shell | bash, mostly | zsh; `~/.zshrc`, not `~/.bashrc` |
| GUI apps and the shell environment | varies | an app started from Finder or the Dock does not see the variables of `~/.zshrc`; launch Pi from a terminal, or through a launcher script |
| Global npm without root | nvm, or an npm prefix in the user's home | Homebrew Node writes to `/opt/homebrew`, no sudo |
| Native addon build | `build-essential` or equivalent | Xcode command line tools |
| Peer override after updates | `npmCommand` wrapper, or the systemd path unit | `npmCommand` wrapper only |
| OS keyring (MCP OAuth stores) | Secret Service | Keychain; shared by every profile of the user |
| File system | case-sensitive | case-insensitive by default |
| sha256 of a line | `sha256sum` | `shasum -a 256` |
| `sed -i` | `sed -i 's/a/b/' f` | `sed -i '' 's/a/b/' f` |
| Other Unix (BSD, WSL) | not qualified; say so and continue only on the user's yes | |

If a command of the kit fails on the machine for a syntax reason, rewrite the syntax, note it in the install log, and continue. If a check of the kit fails for a content reason, stop and report.

## Stage 10: updates

A new kit version never changes a live profile. Pull the clone. Regenerate into a new target from the same overlay with another `target.agentDir`. Then compare:

```sh
cd ~/tenant-pi && git pull
python3 scripts/tenant_pi.py compare --left '<old target>' --right '<new target>'
```

Carry wanted drift into the overlay first (`docs/candidate-compare.md`). To list the package sources and the extension, skill and prompt names of one directory without any value, run `python3 scripts/tenant_pi.py inventory --dir '<target>'` (`docs/profile-inventory.md`). Switching is the launch line with the other path. Auth, sessions and memory are not copied.

## Not in this kit

The kit does not install operating-system packages on its own, edit shell startup files, store credentials, run a service, or migrate an existing agent directory. The tracker skill is selectable but remains unverified in a generated profile. Subagent packages are not installable from this release. The kit ships the OpenViking extension for Pi as a memory module; it does not install or configure an OpenViking server. Not verified: a live qualification on a clean client.
