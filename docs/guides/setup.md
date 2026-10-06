# Setup guide

This guide takes one user from an empty machine to a generated Pi profile. The kit does the offline stages. The user does the dependency, authentication and launch stages by hand.

The stages stay separate and keep this order:

1. [Obtain the sources](#stage-1-obtain-the-sources)
2. [Edit the local choices](#stage-2-edit-the-local-choices)
3. [Validate](#stage-3-validate)
4. [Plan](#stage-4-plan)
5. [Generate](#stage-5-generate)
6. [Install the dependencies by hand](#stage-6-install-the-dependencies-by-hand)
7. [Authenticate](#stage-7-authenticate)
8. [Launch](#stage-8-launch)
9. [Test](#stage-9-test)

Stages 1 to 5 are offline and the kit runs them. Stages 6 to 9 are the user's. The kit runs none of their commands.

The plan prints some commands as display text. `commands.setupDisplayOnly` holds the Pi install line, `pi update --extensions` when `mcp`, `hermes` or `wiki` is enabled, and the peer-override line when `hermes` or `wiki` is enabled. With a `--runtime-report` that has `match`, `untested_in_range` or `mismatch` for Pi, the Pi install line is not there; `commands.piInstall` always holds it, with a mark. `commands.launchDisplayOnly` holds the launch line. The plan does not print the Node and Python installs or the `npm ci` of the in-tree packages. Those commands are in Stage 6 of this guide only.

Status: Linux is the first target. Not verified: a complete run of stages 6 to 9 on a clean client.

## Words in this guide

- **Kit**: this repository, cloned on the machine. The examples use `"$HOME/tenant-pi"`.
- **Private directory**: a directory outside the kit that only the user can read. It holds the overlay, the registry, the install log and the accepted-drift list. The examples use `"$HOME/.config/tenant-pi"`.
- **Overlay**: the JSON file with the user's choices, `overlay.json` in the private directory.
- **Target**: the new profile directory. It must not exist before `generate`. The examples use `"$HOME/.pi/profiles/main"`.
- **Live profile**: `~/.pi/agent`, or the directory in `PI_CODING_AGENT_DIR`. The kit never writes into `~/.pi/agent`. It does not read `PI_CODING_AGENT_DIR`: keep the target outside that directory yourself.

The kit takes absolute paths only. It does not expand `~`. Write `"$HOME/..."` in a command and let the shell expand it. Put each path in double quotes, because a path can hold a space.

## Labels for a prerequisite

Each prerequisite and each stage gets one of four labels. The labels are the same in [the module guide](modules.md).

| Label | Meaning |
| --- | --- |
| `ready` | The step passed an accepted live trial on the qualified platform. No module or live stage has this label in this release. |
| `unverified` | The kit can do its offline part, but no accepted live trial proves the runtime part. |
| `blocked` | The kit refuses the choice, or a prerequisite is missing and nothing in the kit can supply it. |
| `skipped` | The user did not select the module or did not run the step. A skipped step is never "passed". |

An offline stage that passes its own check on this machine is recorded as passed, not as `ready`. Example: `check-runtime` prints `match` for `node`.

## Before you start

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

`runtime.piAcceptedRange` is the accepted Pi range. `runtime.piVersion` is the tested version.
A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.
With `untested_in_range`, keep the installed Pi and record `core_runtime_untested_in_range` as a readiness gap.
The Pi install line stays a plain command with `not_needed`, not `replaces_installed`.

Requirements of this release (`config/manifest.json`, `runtime`):

| Item | Required | Notes |
| --- | --- | --- |
| Linux | the first target | Not verified: a complete live run on Linux. |
| Python | `>=3.11` | Standard library only. The kit has no Python dependency. |
| Node | `>=22.22.0 <23` | The same Node installs Pi and builds native addons later. |
| Pi | `runtime.piAcceptedRange` | Stage 6 installs the tested `<pin>` when needed. |
| Git | any current version | Only to clone the kit. |

macOS, Windows, browser-hosted Pi and Pi inside Herdr are not qualified. See [the release checklist](release-checklist.md#platforms-that-are-not-qualified).

Warning: a bare `pi` command opens the live profile `~/.pi/agent`. To read the Pi version without that, use `check-runtime` (Stage 1) or set `PI_CODING_AGENT_DIR` to an empty temporary directory.

Print every `PI_CODING_AGENT_*` variable of the shell that will launch Pi, and record each name:

```sh
env | grep '^PI_CODING_AGENT_' || echo "no PI_CODING_AGENT_ variable"
for d in "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] || [ -L "$d" ]; then echo "live agent directory present: $d"; else echo "live agent directory absent: $d"; fi
done
```

The `for` loop prints one line for `~/.pi/agent`, and one more line for the directory in `PI_CODING_AGENT_DIR` when the variable is set. Each line says `present` or `absent`. No line is not `absent`.

`PI_CODING_AGENT_DIR` names the live profile. `PI_CODING_AGENT_SESSION_DIR` moves the sessions of every profile to one directory. The launch line of the kit removes it for the generated profile; see [the launcher file](../launcher.md). Do not edit a shell startup file to remove it.

## Stage 1: obtain the sources

Goal: a clean clone of the kit that passes its own offline checks.

```sh
git clone '<kit repository URL>' "$HOME/tenant-pi"
cd "$HOME/tenant-pi"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
python3 scripts/tenant_pi.py check-runtime
```

- The tests print `OK`. The publish check prints `publish set valid`. If one fails, stop: the clone is not the reviewed kit.
- `check-runtime` prints one JSON object with a `status` of `match`, `untested_in_range` (Pi only), `mismatch`, `missing` or `unparsed` for `pi`, `node` and `python`. Exit code 1 at this stage is a finding, not a failure. See [the runtime check](../check-runtime.md).
- Do not move or delete the clone later. A generated profile names `packages/` inside the clone by its absolute path.
- Use `PYTHONDONTWRITEBYTECODE=1` for the checks. Do not run the tests with `pytest`: its cache directory makes the publish check fail. See [troubleshooting](troubleshooting.md#the-publish-check-fails-after-pytest).

Result: passed when the tests and the publish check pass.

## Stage 2: edit the local choices

Goal: a private directory with an overlay that names a new target.

1. Create the private directory with the kit, and give it the target of the new profile. The parent of the private directory must exist.

   ```sh
   mkdir -p "$HOME/.config"
   python3 scripts/tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/main"
   ```

   The action creates the directory with mode `0700` and five files with mode `0600`: `overlay.json`, `registry.json`, `install-log.md`, `accepted-drift.md` and `.gitignore`, plus an empty `inputs/`. It prints an edit line, a `validate` line and a `git init` line as display text. It runs no Git command. See [the private directory](../private-directory.md).

   With `--target`, the new `overlay.json` has that path as `target.agentDir`. The path is absolute and expanded: the shell expands `"$HOME/..."` in double quotes, and the kit refuses `~`. The action does not create the target. It refuses a target inside `~/.pi/agent`, inside the private directory or inside the clone.

   When an older overlay exists on the machine, add `--overlay "<that overlay file>"` once for each file. The action then refuses a directory inside the target of that overlay.

2. Create the parent of the target, beside the live profile and not inside it.

   ```sh
   mkdir -p "$HOME/.pi/profiles"
   ```

   If `~/.pi` belongs to another user, for example root, use a parent such as `"$HOME/.pi-profiles"`. The kit refuses a parent that the caller does not own.

3. A core-only profile needs no edit of the overlay: go to Stage 3. Without `--target` in step 1, `overlay.json` has the sample target `/home/EXAMPLE_USER/new-agent`, and Stage 3 stops with `sample_target: overlay.target.agentDir`. Then open `"$HOME/.config/tenant-pi/overlay.json"` with a text editor and change one value: `target.agentDir`. Write the expanded absolute path, for example `/home/EXAMPLE_USER/.pi/profiles/main`. Change nothing else, and do not paste a JSON fragment into the file. Check the syntax after each edit by hand:

   ```sh
   python3 -m json.tool "$HOME/.config/tenant-pi/overlay.json" >/dev/null && echo "JSON valid"
   ```

   A core-only overlay looks like this:

   ```json
   {
     "schemaVersion": 1,
     "target": {"agentDir": "/home/EXAMPLE_USER/.pi/profiles/main"},
     "selection": {
       "enable": ["core"],
       "disable": ["anthropic-usage", "codex-accounts", "context-meter", "coordinator-skills", "copilot-usage", "doctor", "herdr",
                   "hermes", "mcp",
                   "model-routing", "openviking", "ops-footer", "promptr", "promptr-generate-task-prompt",
                   "promptr-handoff", "promptr-openknowledge-project-pages", "promptr-watch-herdr-agents",
                   "resources", "slopscore", "slopscore-pr", "tenantext", "tracker-site", "wiki"]
     },
     "paths": {},
     "roles": {},
     "endpoints": {},
     "env": {},
     "inputs": {"modelsFile": null, "mcpFile": null},
     "consent": {"memoryCapture": false, "remoteMemoryWrites": false, "telemetry": false}
   }
   ```

4. Add optional modules only after you read [the module guide](modules.md). Move each chosen ID from `selection.disable` to `selection.enable`. Each module lists the overlay fields it needs.

A core-only profile needs no credential, no model choice, no registry and no optional service. Generation works without any of them.

Warning: do not write a secret value into the overlay, the registry or the Markdown files. An `env` value is a `${NAME}` reference only. The kit rejects other forms.

Result: passed when the overlay names an absent target under an existing parent that you own.

## Stage 3: validate

```sh
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json"
```

The command prints `{"scope":"offline structural and supported-input checks only","valid":true}` and exits with 0.

Add these options only when the overlay needs them:

| Option | When |
| --- | --- |
| `--registry "$HOME/.config/tenant-pi/registry.json"` | The overlay has `modelRoutes` with a role or a cycle model. Without the option, `validate` stops with `registry_required: registry`. With the option and without `modelRoutes`, it stops with `registry_without_routes: registry`. |
| `--local-dir "$HOME/.config/tenant-pi"` | The `mcp` module is enabled. The CLI then reads `inputs/mcp-adapter.json` from that directory. |
| `--require-role <role>` | A later stage needs a role, for example `review`. |

An error is one line on standard error: `{"candidate_created": false, "error": "<rule>: <field>"}`. It never holds a value. See [troubleshooting](troubleshooting.md) for the fixes.

When the kit cannot read the overlay, the rule names the cause, for example `input_missing: overlay.file`. For a JSON syntax error the line also has the place:

```json
{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}
```

Correct the syntax at that line and column, or at the end of the line before. See [troubleshooting](troubleshooting.md#overlay-and-input).

Result: passed when `validate` prints `"valid":true`.

## Stage 4: plan

```sh
python3 scripts/tenant_pi.py check-runtime > "$HOME/.config/tenant-pi/runtime.json"
python3 scripts/tenant_pi.py plan --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --launcher "$HOME/.config/tenant-pi/launch-main.sh" --runtime-report "$HOME/.config/tenant-pi/runtime.json"
```

The first line saves the runtime versions for the plan, because `plan` and `generate` start no process. Run it in the shell that will launch Pi. Exit code 1 is a finding here, not a failure: the file holds the report.

The report shows the state before Stage 6. Stage 6 changes the facts: after each install or change of Node or Pi, make the report again and run `plan` again. The kit cannot tell an old report from a current one.

`plan` writes nothing. Read these keys of its JSON output:

- `files`: the paths and modes that `generate` will write.
- `readinessGaps`: the facts that no offline step can prove. Without `--runtime-report`, a core-only plan has three: `target_absence_unverified`, `node_runtime_unverified` and `core_runtime_unverified`. These are facts to carry, not errors. With the report, a `match` removes the gap of that tool, and an `untested_in_range`, `mismatch`, `missing` or `unparsed` shows the measured state in place of `unverified`; see [the plan](../profile-plan.md#readiness-after-measured-facts).
- `commands.setupDisplayOnly`: the dependency commands for Stage 6. Display text only.
- `commands.piInstall`: the Pi install line with its mark and a warning. Read it before you run that line in Stage 6.
- `commands.launchDisplayOnly`: the launch line for Stage 8. Display text only.
- `commands.launcherDisplayOnly`: the launcher path, when you give `--launcher`.
- `commands.providerKeyWarning`: the names of the known provider key variables that are set in this shell. The key is absent when none is set; see [the warning](../profile-plan.md#the-warning-for-a-provider-key-variable).

Use the same options as in Stage 3. `validate` does not take `--runtime-report`.

## Stage 5: generate

```sh
python3 scripts/tenant_pi.py generate --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --target "$HOME/.pi/profiles/main" --launcher "$HOME/.config/tenant-pi/launch-main.sh"
```

- `--target` must equal `target.agentDir` of the overlay, byte for byte. Else the command stops with `invalid_plan: target_mismatch: plan.targetAgentDir`.
- `target.agentDir` must be outside the kit clone. Else `validate`, `plan` and `generate` stop with `under_kit: overlay.target.agentDir` before any write.
- `target.agentDir` must be outside the live profile `~/.pi/agent`. Else `validate`, `plan` and `generate` stop with `under_pi_agent: overlay.target.agentDir` before any write. The three actions read `HOME` for this rule.
- The target must not exist. Its parent must exist and belong to you.
- The command writes `settings.json`, `.tenant-pi/choices.json` and `.tenant-pi/state.json`. It writes `hermes-memory-config.json` and `mcp-adapter.json` only with those modules. Directories get mode `0700`, files get mode `0600`.
- With `--launcher`, it writes the launcher file with mode `0700` after the profile is complete. The file holds `#!/bin/sh` and one `exec env` line with the plan launch line. See [the launcher file](../launcher.md).
- Add `--runtime-report "$HOME/.config/tenant-pi/runtime.json"` to get the measured gaps of Stage 4 in this output too. The generated files are the same with and without the report.

The output has `"filesComplete":true`. It does not list `target_absence_unverified`: `generate` has just created the target. `runtimeReady` is always `false`: this kit has no live trial of a generated profile. Read `readinessGaps`: the list is empty only with `--runtime-report` with `match` for Node and Pi, and a profile without another gap. The report compares version numbers only: the kit cannot prove a launch.

If the output has `"candidate_created": true` with an error, the directory exists but is incomplete. Inspect it. The kit has no rollback and does not delete it.

Result: passed when `filesComplete` is `true`. The runtime stays `unverified`.

## Stage 6: install the dependencies by hand

The kit installs nothing. This stage lists reviewed commands for you to copy, read and run yourself. Run only the commands for the modules you enabled. The plan prints the declared-package lines under `commands.setupDisplayOnly`. It prints the Pi line there too, unless a `--runtime-report` with `match`, `untested_in_range` or `mismatch` for Pi takes it out; `commands.piInstall` always holds the Pi line. The Node, Python and in-tree package commands come from this guide only.

Warning: each command below changes the machine. Read it before you run it.

### Node and Python

Use the package source of your distribution or a version manager. Examples:

| Distribution | Node 22 | Python 3.11 or later |
| --- | --- | --- |
| Fedora | `dnf install nodejs22` | `dnf install python3` |
| Debian or Ubuntu | NodeSource 22 repository, or nvm | `apt install python3` |
| Any, per user | `nvm install 22 && nvm use 22` | distribution package |

Not verified: the exact package name `nodejs22` on every Fedora release.

### Pi

After the overlay exists, `python3 scripts/tenant_pi.py plan --overlay <file>` prints the same line in `commands.piInstall`, key `command`.

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Warning: a global install replaces the `pi` command of every profile of the user.

`commands.piInstall` always holds this line, with a mark. Without `--runtime-report` the line is also under `commands.setupDisplayOnly`, and its `status` is `installed_version_unknown`. With a saved `check-runtime` report the `status` is `needed` for `missing`, `not_needed` for `match` or `untested_in_range`, `replaces_installed` for `mismatch`, and `installed_version_unknown` for `unparsed`. The line then stays under `commands.setupDisplayOnly` only when the report has `missing` or `unparsed` for Pi. With `replaces_installed`, `change` says whether the line is a `downgrade` or an `upgrade` of the installed Pi. See [the mark of the Pi install line](../profile-plan.md#the-mark-of-the-pi-install-line).

The command fixes the version of the Pi package, not all versions of its dependencies. See [what the install command fixes](../check-runtime.md#what-the-install-command-fixes).

Which command you run depends on the `pi` status of `check-runtime` (Stage 1, or the report of Stage 4).
With `match` or `untested_in_range`, skip the Pi install.

With `missing`, first see whether you can write the global npm prefix:

```sh
p="$(npm config get prefix)"; test -w "$p/lib/node_modules" && test -w "$p/bin" && echo writable || echo "not writable"
```

It prints `writable` when you can write `lib/node_modules` and `bin` of the prefix, and `not writable` otherwise. A directory that does not exist gives `not writable`. The user `root` gets `writable`.

The test writes nothing into the npm prefix. `npm config get prefix` writes one debug log file into the npm cache directory of the user (default `~/.npm/_logs`), and makes that directory when it is absent.

If it prints `writable`, run the global command above. You can refuse the global command and use the prefix form below in its place.

If it prints `not writable` (for example a user without root on a Node that root owns), the global command fails. Use the prefix form:

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@"${pin:?}"
export PATH="$HOME/.npm-global/bin:$PATH"
```

The directory `"$HOME/.npm-global"` is the example; you can name another directory that you own. The `export` line changes the current shell only. To keep it, add the line to your shell startup file yourself. The kit never edits a shell startup file. Record the prefix and its `PATH` line as an adaptation.

With `mismatch` (outside the accepted range) or `unparsed`, make a decision. With `unparsed`, run `PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version` and read its output first. Three options:

- Stop.
- Keep the existing Pi, and record the version mismatch as a gap.
- Install the pin with the prefix form above, under a prefix that you name. The existing Pi stays in its place. Record the prefix and its `PATH` line as an adaptation.

The global install command is not the default for a `mismatch`: it replaces the installed Pi for every profile of the user, and it is a downgrade when the installed Pi is newer.

Do not use `npm config set prefix`. It changes the npm configuration for every later global install.

### In-tree packages

Only when you enabled a Tenantext component (`tenantext`, `codex-accounts`, `slopscore`, `context-meter`, `ops-footer`, `copilot-usage`, `anthropic-usage`, `doctor`, `resources`, `herdr`, `coordinator-skills`, `slopscore-pr`):

```sh
cd "$HOME/tenant-pi/packages/tenantext" && npm ci --ignore-scripts
```

Observed with Pi 0.99.1: without this step, Pi fails at start with `Cannot find module 'yaml'`. See [in-tree packages](../packages.md).

Only when you enabled `promptr`:

```sh
cd "$HOME/tenant-pi/packages/promptr" && npm ci --ignore-scripts && npm run build
```

Without the build Pi cannot load the extension, because `packages/promptr/dist/` is not in the tree. `scripts/publish_check.py` ignores `packages/promptr/dist/`. When no tracker binding exists, set `GITEA_HOST`, `GITEA_OWNER` and `OPENKNOWLEDGE_ORIGIN` in the shell that starts Pi. Without them Promptr shows placeholder defaults.

### Declared npm packages

Only when you enabled `mcp`, `hermes` or `wiki`. Record the baseline of the live profile first: see [Stage 8](#stage-8-launch). `pi update --extensions` is the first Pi command that names the target.

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi update --extensions
```

Only when you enabled `hermes` or `wiki`, also:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

The plan prints the second line only with a memory module. `pi-mcp-adapter` lists no host module under `dependencies`, so `mcp` alone needs no peer override.

- The first command installs the current registry version of each declared package. The kit reviewed `pi-mcp-adapter` 3.2.0, `pi-hermes-memory` 0.9.9 and `@zosmaai/pi-llm-wiki` 0.12.4. A newer version is not verified.
- The second command corrects the host-provided peers in the installed manifests of the memory packages. See [host peer overrides](../host-peer-overrides.md).
- Hermes builds `better-sqlite3`. That needs a compiler toolchain for the Node that runs Pi.

### Native Pi operations rewrite the profile

`pi update`, `pi install`, `pi remove`, `/model` and settings changes inside Pi can write to `settings.json` of the profile. After each such operation, run `compare` again and read the drift. Do not hide the drift. See [the candidate update guide](candidate-update.md#after-a-native-pi-operation).

Not verified: the exact list of Pi commands that rewrite `settings.json` at Pi `<pin>`.

Result: passed when Node and Python are `match`, and Pi is `match` or `untested_in_range`. Record the gap for an untested version. The runtime stays `unverified`. A module whose dependency step you did not run is `skipped`.

## Stage 7: authenticate

The kit writes no credential and requires no credential store.

| Route | What you do |
| --- | --- |
| Core only | Nothing at generation. Pi asks for a provider when you use it. |
| Native provider | Launch Pi (Stage 8) and run `/login` inside Pi. Pi stores the result in `<target>/auth.json`. |
| Tenantext gateway (`auth: "env"`) | Export `TENANTEXT_LITELLM_API_KEY` in the shell that launches Pi. The launch line carries `TENANTEXT_LITELLM_BASE_URL`. |
| Tenantext gateway (`auth: "login"`) | `blocked` at this pin. `generate` refuses it with `pi_login_blocked`. |
| MCP server tokens | Export each `${NAME}` that `inputs/mcp-adapter.json` references. |

How the key reaches the process is your choice. Examples:

- Export it by hand in the terminal before you run the launcher.
- Read it from a secret store that you already use. A password manager, `pass` and an OS keyring are examples. None is required.

Check that a name is set without printing its value:

```sh
test -n "${TENANTEXT_LITELLM_API_KEY:-}" && echo set || echo unset
```

### Shells that do not inherit your variables

A variable that your interactive shell exports does not reach every process. These starts often miss it:

- A command through SSH without a terminal, for example `ssh host 'command'`. Many `~/.bashrc` files stop early for a shell that is not interactive.
- A terminal inside a browser page, a web IDE or a remote desktop session. It can start a login shell with another startup file, or no startup file.
- A desktop launcher, a systemd unit, a cron job or a tmux server that started before you exported the name.

In each of these, run the check above in the same shell that runs the launcher. Also run `check-runtime` there: a `PATH` line for `"$HOME/.npm-global/bin"` can be missing in the same way. Do not fix this with an edit of a shell startup file that you did not review.

Label: `skipped` until you run it. The kit cannot check a credential.

## Stage 8: launch

Before the first launch, record a baseline of the live profile. Stage 9 uses it to prove that the launch did not change the live profile.

```sh
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

- The action does not change the directory. It lists the directory and reads the name, the kind, the size and the modification time of each entry. It opens no file. See [the directory baseline](../directory-baseline.md).
- The one write is the new baseline file, with mode `0600`. The action never replaces a baseline: an existing file stops it with `target_exists: baseline.out`.
- Run it also when `~/.pi/agent` is absent. The baseline then records that the directory is absent.
- When the shell has `PI_CODING_AGENT_DIR`, record a second baseline for that directory: `--dir "$PI_CODING_AGENT_DIR"` and `--out "$HOME/.config/tenant-pi/live-baseline-env.json"`. When the shell has `PI_CODING_AGENT_SESSION_DIR`, record one more: `--dir "$PI_CODING_AGENT_SESSION_DIR"` and `--out "$HOME/.config/tenant-pi/session-dir-baseline.json"`.
- If the action stops with `not_directory: baseline.dir`, the directory or a directory above it is a symbolic link. Run `realpath "$HOME/.pi/agent"`, give that path as `--dir` to `baseline` and to `check-baseline`, and record both paths.
- Close each Pi that runs in the live profile, or note that one runs. A Pi in the live profile also changes the directory.

Run the launcher file of Stage 5:

```sh
"$HOME/.config/tenant-pi/launch-main.sh"
```

The file runs the exact `commands.launchDisplayOnly` line, for example:

```sh
exec env env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve
```

Rule: the profile keeps its sessions in its own `sessions/` directory. The part `env -u PI_CODING_AGENT_SESSION_DIR` removes an inherited session directory for the one `pi` process. Do not remove that part.

- Without a launcher file, type the `commands.launchDisplayOnly` line from the plan. Do not split it: each assignment belongs to the same `pi` process.
- With the gateway, the line also holds `TENANTEXT_LITELLM_BASE_URL`. With `mcp`, it holds `PI_MCP_CONFIG_MODE=exclusive`. With a relocated wiki vault, it holds `WIKI_HOME`.
- The file holds no key. The key comes from the environment of the shell that runs the file.
- A provider key variable of this shell reaches Pi too, and Pi uses it when the profile has no login: see the rule in [check 3](#check-3-the-model-reply). The launch line and the launcher file do not clear such a variable. The plan of Stage 4 names the known ones that are set, under `commands.providerKeyWarning`.

Pi starts with its own native terminal interface. The kit does not wrap or replace it.

## Stage 9: test

Record each check as passed, failed, blocked or not run in `install-log.md` of the private directory. Check 4 has one more value, not verified.

1. `PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --version` prints `<pin>` or an accepted version. Record the untested-version gap when needed.
2. Pi starts with no extension error and no peer warning.
3. The chosen model replies to the fixed prompt, and the reply holds the expected number: see [check 3](#check-3-the-model-reply).
4. `ls -la "$HOME/.pi/profiles/main"` shows the generated files plus what Pi wrote: `auth.json`, `sessions/`, `npm/`. The live profile did not change: the comparison below prints `"result":"unchanged"`.
5. With Hermes: `<target>/pi-hermes-memory/` exists after the first session. With the wiki and ambient off: `~/.llm-wiki` was not created.
6. With `mcp`: `/mcp-adapter status` inside Pi lists only the servers of the input file.

A check that did not run is "not run". Never write "passed" for it.

### Check 3: the model reply

The fixed prompt is:

```text
What is 17 plus 26? Reply with the number only.
```

The expected reply is the number `43`. The prompt text does not hold that number.

Check 3 has two results: "Model replied" and "Reply matched". Record them as two lines of `install-log.md`, each with yes, no or not run. Check 3 is passed only when both are yes.

Preferred form: print mode. With `-p`, Pi sends one prompt, writes the final reply of the model to standard output, and exits. The output holds no user line, no thinking text and no screen frame. See [print mode](../launcher.md#print-mode).

1. Print mode cannot log in. With a native provider, launch the profile one time, run `/login`, select the model, and exit Pi.
2. Add `-p` and the prompt in single quotes to the `commands.launchDisplayOnly` line of the plan. The launcher file takes no argument. Example:

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"
   ```

3. Read the output:

| Output | Model replied | Reply matched |
| --- | --- | --- |
| Text that holds `43`, then `exit status: 0` | yes | yes |
| Text without `43`, then `exit status: 0` | yes | no |
| An error text, no text, or an exit status that is not 0 | no | no |

Print mode uses the default model of the profile. Rule: Pi reads a provider key from the environment of the launching shell, including in a profile with no login. The reply can then come from a provider that you did not choose. So name the model for this check: add `--model '<provider>/<model>'` before `-p`. The plan warns when a known provider key variable is set, under `commands.providerKeyWarning`. Not verified: which variable names Pi reads for each provider. Use the name that the Pi documentation gives.

Other form: a pasted screen of an interactive session. A Pi screen has no labels. Its lines come in this order: the user line (the text that you typed), then thinking text when the model shows it, then the model line. The user line must be the fixed prompt. "Reply matched" is yes only when `43` is in the model line. A `43` in the user line or in the thinking text is not a reply.

### Check 4: the comparison with the baseline

```sh
python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"
```

| `result` | Meaning | Record check 4 as |
| --- | --- | --- |
| `unchanged` | No entry was added, removed or modified after the baseline. A directory that was absent is still absent. | passed |
| `changed` | The directory differs from the baseline. `added`, `removed` and `modified` name the direct entries that differ. | failed, or not verified |
| `no_baseline` | The baseline file does not exist. The action compared nothing. | not run |

Record check 4 as passed only when `recordedAt` is before the first Pi command that names the target. With a later baseline, record check 4 as not run: that comparison proves nothing about the launch.

A Pi that ran in the live profile after the baseline also changes the directory: a session writes under `sessions`. A `pi` command without `PI_CODING_AGENT_DIR` counts as a Pi in the live profile, also `pi --version`, and also when the installing agent ran it. Observed with Pi 1.0.2 and a `settings.json` in the directory: a `pi --version` without `PI_CODING_AGENT_DIR` gives `changed` with empty name lists and `"directoryModified":true`. Not verified: other Pi versions. The comparison does not show which process made a change.

- With `changed` and no Pi in the live profile, from you or from an installing agent: the check failed. A command of the install wrote outside the target.
- With `changed` and such a Pi: the check is not verified. Record the names and the command. For a proof, close that Pi, record a second baseline in a new file, launch the profile again, and compare with the second baseline.

Run the same comparison for each other baseline of Stage 8, with its own `--dir` and `--baseline`.

## Related guides

- [Module guide](modules.md): each component, its inputs, credentials, state and status.
- [Candidate update guide](candidate-update.md): regenerate, compare and switch.
- [Privacy guide](privacy.md): what the kit separates and what it does not.
- [Troubleshooting](troubleshooting.md): each diagnostic and its fix.
- [Release checklist](release-checklist.md): the gates of a release.
- The agent-facing guide is `skills/tenant-pi-install/SKILL.md`. [INSTALL.md](../../INSTALL.md) is the agent walk-through of the same stages.
