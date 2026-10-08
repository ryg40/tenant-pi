# Install a Pi profile from this kit

This file is for an agent that a user points at this repository: Claude Code, Pi, or another coding agent. Read the whole file first. Then walk the user through the stages in order. Each stage has a goal, the commands, and the check that proves it is done.

The kit prepares a separate Pi profile in a new directory. It never writes into an existing Pi profile directory. The companion guide `skills/tenant-pi-install/SKILL.md` follows the same order and asks a question at each stage. Its stage names and numbers differ from the ones here.

The order differs from `docs/guides/setup.md`, the guide for a person without an agent. That guide does the offline stages of the kit first, and it installs Node, Pi and the package dependencies after `generate`. This file installs first, so that `plan` and `generate` get a runtime report with the measured versions. Both orders give the same generated files.

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

`runtime.piAcceptedRange` is the accepted Pi range. `runtime.piVersion` is the tested version.
A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.
With `untested_in_range`, keep the installed Pi and record `core_runtime_untested_in_range` as a readiness gap.
The Pi install line stays a plain command with `not_needed`, not `replaces_installed`.

Words used below:

- `<clone>`: the directory of this repository, for example `~/tenant-pi`.
- `<private dir>`: a directory outside the clone that only the user can read, for example `~/.config/tenant-pi`. It holds the overlay, the input files, the install log and the results file.
- `<target>`: the absolute path of the new profile directory from `target.agentDir` in the overlay.

## Rules for the agent

1. Ask before each command that changes the machine: an install, a new directory, a shell file, a credential. Show the command. Run it when the user says yes. Running it yourself is allowed; running it without a yes is not.
2. Never write, print, or paste a secret. Name a credential by its environment variable only.
3. Never write into `~/.pi/agent` or into the directory in `PI_CODING_AGENT_DIR`. The kit generates into a new, absent directory only. `init-private --target`, `validate`, `plan` and `generate` refuse a target that is `~/.pi/agent` or is under it, with the rule `under_pi_agent`. The kit does not read `PI_CODING_AGENT_DIR`: when Stage 0 printed that variable, keep the target outside that directory yourself.
4. Adapt the syntax of a command to the machine (see "Local differences"). Do not adapt the rules of the kit: no secret in a file, no generation into an existing directory, no edit of a live profile.
5. Record what you ran, what you skipped, and every adaptation in `<private dir>/install-log.md`. A live check that did not run is "not run", never "passed".
6. If a stage fails, keep the earlier stages, say what failed, and stop at a state the user can resume from.
7. At the end of Stage 9, and at each earlier stop, write the results file: see "The results file" in Stage 9. The last line of your work is the full path of that file. Exception: when the clone does not exist yet, do not run `results`. Tell the user in plain text the last stage, the reason and the next step.

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
| Node | `>=24.0.0 <25` |
| Python | `>=3.11` |
| Git | any current version |
| Pi | `runtime.piAcceptedRange`; Stage 3 installs the tested `<pin>` when needed |
| Linux | first target; not verified: a complete live run |
| macOS | not qualified; the adaptations below are unqualified, see `docs/guides/release-checklist.md` |

Done when you can state the OS, Node, Python, Git and Pi, and for each live agent directory the word `present` or `absent` from its line.

## Stage 1: requirements

Goal: Node, Python and Git at the required versions. Show the command for the machine, then run it on yes.

| Machine | Node 24 | Python 3.11+ | Git |
| --- | --- | --- | --- |
| macOS, Homebrew | `brew install node@24`, then `brew link --overwrite node@24` | `brew install python@3.12` | `xcode-select --install` |
| macOS or Linux, nvm | see the nvm block below | distribution package or Homebrew | distribution package |
| Debian or Ubuntu | NodeSource 24 repository, or nvm | `apt install python3` | `apt install git` |
| Fedora | `dnf install nodejs24` | `dnf install python3` | `dnf install git` |

The nvm block, for a user home that has no nvm:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
. "$HOME/.nvm/nvm.sh"
nvm install 24 && nvm use 24
```

The first line installs nvm `v0.40.3` into `~/.nvm`. Before you run it, read the release page <https://github.com/nvm-sh/nvm/releases/tag/v0.40.3> and the script at the URL of the first line. The kit gives no checksum for the script. When `nvm` is already a command in the shell, run the third line only.

The kit never edits a shell startup file, so the user makes one of two choices:

- Option one: the user runs the first line without `PROFILE=/dev/null`. The nvm install script then adds the nvm lines to a shell startup file of the user. The script selects the file from `$SHELL` and edits only a file that exists, for example `~/.bashrc` for bash. When no such file exists, the script prints `Profile not found` and edits nothing. Create the file first when it is absent, for example with `touch ~/.bashrc` for bash.
- Option two: the user keeps `PROFILE=/dev/null`. The script prints `Profile not found` and edits no file. The user runs `. "$HOME/.nvm/nvm.sh"` in each shell that runs a kit command or the launcher.

The launcher runs `pi` from the `PATH` of the shell that starts it. With option two, run the `. "$HOME/.nvm/nvm.sh"` line before the launcher too. Record the choice as an adaptation.

Warning: `brew link --overwrite node@24` and `nvm use` change the default `node` of the user. A Pi that another Node installed can stop working. Ask first.

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

With npm 11, this command and the prefix form below can print two warning lines. The lines start with `npm warn install-scripts` and `npm warn deprecated`. Both lines are expected output and are not a failure. The user runs no `allowScripts` command for the kit.

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

Goal: the in-tree Tenantext package can load. Run this stage now. The recommended set of the checklist of Stage 5 enables Tenantext components. Skip it only if the user later switches every Tenantext component off in Stage 5.

```sh
cd ~/tenant-pi/packages/tenantext && npm ci --ignore-scripts
```

Observed with Pi 0.99.1: without this step Pi fails at start with `Cannot find module 'yaml'`. The kit has no test for this; see `docs/packages.md`.

The step leaves `packages/tenantext/node_modules/` in the clone. `scripts/publish_check.py` ignores each `node_modules/` directory.

The Promptr package needs a build when you enable `promptr`: run `npm ci --ignore-scripts` and `npm run build` in `packages/promptr`. The build leaves `packages/promptr/node_modules/` and `packages/promptr/dist/` in the clone; `scripts/publish_check.py` ignores both. When no tracker binding exists, set `GITEA_HOST`, `GITEA_OWNER` and `OPENKNOWLEDGE_ORIGIN` in the shell that starts Pi: without them Promptr shows placeholder defaults. Without `promptr` in `enable` the package needs no step.

Done when `packages/tenantext/node_modules/yaml` exists.

## Stage 4a: Herdr and the question tool

Goal: a coordination setup that the user approved item by item. Optional. Run this stage when the user wants Herdr, the Herdr skill, or structured questions in Pi. Skip it otherwise.

This stage has three parts with separate results: the Herdr application (a host tool), the Herdr skill (a component of the profile, or a shared install), and the Pi question extension (a component of the profile). `docs/herdr-setup.md` has the facts of each part.

Ask the questions of this stage with the question tool of your harness. Claude Code has its own question tool: use it, and install no Pi extension into Claude Code. When no question tool is loaded, ask in plain text: one question, its numbered options, the recommended option first. A headless or bootstrap session always uses plain text. Never make a step wait for the Pi question extension.

The Herdr facts below come from the `herdr` command itself, version 0.9.3: `herdr --help`, `herdr update --help`, `herdr channel --help` and `herdr --skill`.

| Fact | Source |
| --- | --- |
| `herdr --version` prints `herdr <version>`. | the command |
| The home page is `https://herdr.dev`. | `herdr --help` |
| `herdr update` downloads and installs the latest version. | `herdr update --help` |
| `herdr channel show` prints the update channel. `herdr channel set <stable|preview>` changes it. | `herdr channel --help` |
| `herdr --skill` prints the agent skill file of the installed version. | `herdr --help` |
| The configuration file is `~/.config/herdr/config.toml`; `HERDR_CONFIG_PATH` names another file. | `herdr --help` |

The reviewed source of the Herdr application is the open-source project `herdrdev/herdr` on GitHub, with the license Apache-2.0. Its stable release is 0.9.3. The install facts of part 5 come from the release page and the install script of the project. Do not use another URL or command. Not verified: an install with the commands of part 5 on a clean account. Not verified: the version range of Herdr that the bundled skill supports. The skill text names commands that were verified on Herdr 0.9.1.

### 1. Destination

Ask: "Where do you install: on this machine, on a remote Linux host over SSH, or in a container on this machine?"

- Local: every later command runs here.
- Remote: the user gives the SSH target, a host alias of their SSH configuration or `<user>@<host>`. Every later command of every stage runs on that host through `ssh`. The remote host is Linux. A remote install is not qualified: no trial on a disposable host is recorded.
- Container: the profile goes into a Compose seat on this machine. Skip parts 2 to 8 of this stage and continue with Stage 4c. A Compose seat is not qualified: no trial of a container is recorded.

Rules for SSH:

- Use the SSH configuration, the keys and the agent of the user. Do not ask for a password, a passphrase or a private key. Do not copy a key or a credential to the remote host.
- Do not turn off host key verification. Do not add `StrictHostKeyChecking=no` or a null `UserKnownHostsFile`. When the host key is unknown or changed, stop and let the user resolve it in their own terminal.
- Do not write the SSH target into a tracked file of the clone. It can go into `<private dir>/install-log.md`.

### 2. Account

Before you ask, look for an LLM Wiki vault of the user who installs. Run the probe as that user:

```sh
python3 <clone>/scripts/tenant_pi.py check-wiki-vault
```

The action reads `HOME` and `WIKI_HOME`, opens no file and writes nothing. When `exists` is `true` for a root of the output, tell the user these facts before the question:

- A profile of the user's own account uses that vault.
- A new account gets a new vault in its own home directory. The vault of the user stays unchanged and is not used.
- The kit does not share a vault between two accounts.

The user decides. "The LLM Wiki vault" in Stage 5 has the keys of the output.

Ask: "Which Linux account owns the install: an existing account, or a new account?"

- Existing account: the user names it. Local: it is the account that runs this session. Remote: it is the account of the SSH target.
- New account: account creation needs administrator rights. Write a list of the privileged actions, one command for each item. Add each missing system prerequisite of Stage 1 to the same list. Show the list. The user approves or refuses each item. An item that the user refused does not run. The user or an administrator can run the items in their own terminal.

An example of such a list, for the user to change:

```text
1. Create the account <name> with a home directory.   sudo useradd --create-home --shell /bin/bash <name>
2. Install Git from the system packages.              <package command of the distribution>
3. Allow SSH login for <name>.                        <the user adds their own public key>
```

The exact commands depend on the distribution. Do not give the new account administrator rights. Do not add it to a `sudo` or `wheel` group. After this list, no step of this guide needs administrator rights.

Every ordinary install step runs as the target account: Node, Pi, the clone, the Herdr application, the skill and the profile.

### 3. Home and paths

Check the identity before any write. Local:

```sh
id -un; printf '%s\n' "$HOME"; uname -sm
```

Remote, with the target of the user:

```sh
ssh '<ssh target>' 'id -un; printf "%s\n" "$HOME"; uname -sm'
```

Show the account name, the home directory and these paths. Ask the user to confirm them:

| Path | Default |
| --- | --- |
| The clone | `~/tenant-pi` |
| The private directory | `~/.config/tenant-pi` |
| The profile | `~/.pi/profiles/main` |
| The Herdr configuration | `~/.config/herdr/` |
| The shared skill directory, only with the shared install | `~/.agents/skills/herdr` |

With the clone present on this machine, one action prints the SSH command lines of the remote stages. It runs none of them:

```sh
python3 <clone>/scripts/tenant_pi.py remote-plan --ssh-target '<ssh target>' --remote-user '<account>' --remote-home '<remote home>'
```

Show each line before you run it. The `identity` line fails for a wrong account, a wrong home or a system that is not Linux. A line with `"changes": true` needs a yes from the user. `docs/herdr-setup.md` lists the stages and the limits.

Stop when the account name or the home directory is not the one that the user named. A wrong identity writes into another account. After each install step, check the owner of the new path: `stat -c '%U' '<path>'` on Linux prints the account name.

### 4. Detect Herdr

Read-only:

```sh
command -v herdr && herdr --version
```

With the clone present, the kit action gives the same fact as JSON:

```sh
python3 <clone>/scripts/tenant_pi.py check-herdr
```

- `present`: record the version. Do not install a second copy. Do not run `herdr update` and do not change the channel: an upgrade is a separate decision that the user approves by name. A running Herdr server keeps its version until it restarts; do not stop a server or a session of the user.
- `missing`: continue with part 5.
- `unparsed`: show the fact to the user and stop this part. Do not replace the file.

### 5. Install the Herdr application

Only with `missing` in part 4, and only after approval. The kit does not run this step: it has no install code for Herdr.

1. Show the install command and the paths that it writes. The preferred form is the pinned release asset for Linux x86_64. It writes a new temporary directory and `~/.local/bin/herdr`:

   ```sh
   cd "$(mktemp -d)" &&
   curl -fsSLO https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64 &&
   echo '18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7  herdr-linux-x86_64' | sha256sum -c - &&
   mkdir -p ~/.local/bin &&
   install -m 755 herdr-linux-x86_64 ~/.local/bin/herdr
   ```

   The command stops when the digest does not match. The digest is the SHA-256 of the asset of release 0.9.3. Another release needs its own reviewed digest.

   The alternative form is the official install script `https://herdr.dev/install.sh`. It installs the latest release into `~/.local/bin` without root, and it verifies the checksum. The user saves the script to a file and reads it before it runs. Do not send the download directly into a shell.

   The release also has the macOS assets `herdr-macos-aarch64` and `herdr-macos-x86_64`; this guide gives no digest for them.
2. Ask: "Run this command as `<account>`?" Run it only after a yes. It runs as the target account, without `sudo`.
3. Run the check of part 4 again. The step is done only with `present`.
4. `~/.local/bin` can be missing from `PATH` in a non-login shell or in an SSH command. The check then reports `missing` after a correct install. The user adds the directory to `PATH` for that shell, then runs the check again:

   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   ```

   The kit never edits a shell startup file.

When Herdr needs something that the machine does not have, for example a terminal for the interactive application, report that as a blocker. Do not report the part as done.

### 6. The Herdr skill

The kit holds the skill at `packages/tenantext/skills/herdr`. Ask: "Where do you want the Herdr skill?"

| Option | What it changes | Scope |
| --- | --- | --- |
| Profile (recommended) | `herdr` moves to `selection.enable` in the overlay (Stage 5). The generated profile loads the skill from the clone. | The one generated profile |
| Shared install | `bash <clone>/packages/tenantext/skills/herdr/install.sh` copies the skill to `~/.agents/skills/herdr` and links it into `~/.claude/skills` and `~/.pi/agent/skills` when these directories exist. It also copies the `spawn_agent` command file into `~/.claude/commands` and `~/.pi/agent/prompts`. | Every Pi profile and Claude Code of the account |
| Both | Both changes. | Both scopes |
| None | Nothing. | none |

The shared install is a separate approval. Before it, show what exists at each of its paths. `install.sh` replaces the installed skill copy at `~/.agents/skills/herdr` with `rsync --delete`: a file that is only in the earlier copy is deleted. It overwrites an existing `spawn_agent.md` in `~/.claude/commands` and `~/.pi/agent/prompts`. It writes into the live `~/.pi/agent` when that directory exists. It leaves a `herdr` entry that is not a link in place and prints `skipped`. Run it only when the user approves these paths by name. The profile option writes none of them.

### 7. The question extension

Ask: "Do you want structured questions in Pi?" A yes moves `questions` to `selection.enable` in the overlay (Stage 5). The `pi install` line of Stage 7 then installs the package into the profile. The extension gives Pi the `ask_user_question` tool. It is `unverified`: tell the user the gaps of `docs/herdr-setup.md`.

- The extension reads a guidance file below the configuration directory of the user. The kit does not write it. Do not replace an existing file.
- A loaded extension is not a working question dialog. The dialog needs an interactive session.
- This choice is for Pi only. Claude Code keeps its own question tool.

### 8. Record

Write into `<private dir>/install-log.md`: the destination, the account, the confirmed paths, each approved and each refused item, and the result of each part. When a part fails, name the actions that are complete and the actions that are not. The user can then resume without a second run of a completed action.

Done when the user answered parts 1, 2, 6 and 7, part 3 shows the right identity, and part 4 shows `present` or the user accepted `missing` as an open item.

## Stage 4c: the Compose seat

Goal: the five files of a Compose seat in `<private dir>`, a built image, and a seat that the user reaches over SSH. Run this stage only with the answer "container" in Stage 4a, part 1.

The guided path supports the gateway route only, through the component `codex-accounts` ([modules guide](docs/guides/modules.md)). For a provider with a native login, write the private directory files by hand. Use the two env templates and the notes on the private directory in [the seat README](deploy/compose/README.md). Use the overlay rules of Stage 5. The `overlay` and `registry` keys of the plan in part 2 show the shape of these two files. The seat README permits an empty gateway key for a native login. Not verified: a native login in the seat.

A Compose seat is a container, started by Compose, that holds one generated Pi profile for one user and is reached over SSH. [The Compose seat document](deploy/compose/README.md) has the facts: the image, the two env files, the gateway key, the login and the limits. [The Compose seat guide](docs/guides/compose-seat.md) has the procedure for the operator. Not verified: a start of the container, a login, and each behaviour under Podman.

This machine needs Git, Python 3.11 or later, the clone of Stage 2, and Docker with Compose or Podman with a Compose provider. It does not need Node or Pi: the image holds them.

### 1. The eight questions

Ask each question with the question tool of your harness, the recommended answer first. Read-only commands give the defaults:

```sh
id -u; id -g; ls ~/.ssh/*.pub
```

| # | Question | Default | Rule |
| --- | --- | --- | --- |
| 1 | "Which account name does the seat use?" | `pi` | Lowercase letters, digits, `_` and `-`. Not `root` and not an account of the base image: `node`, `sshd`, `daemon`, `www-data`, `nobody`, `bin`, `sys`, `sync`, `games`, `man`, `lp`, `mail`, `news`, `uucp`, `proxy`, `backup`, `list`, `irc`, `_apt`. |
| 2 | "Which UID and GID does the account have?" | The output of `id -u` and `id -g` | 1000 to 65533. A value from 500 to 999 and the GID 20 are accepted with a warning: they are the values of a macOS account. |
| 3 | "Which SSH public key file opens the seat?" | A `.pub` file of `~/.ssh` | The absolute path of a public key file with exactly one key line. The action refuses a file with a private key. Never ask for a private key. |
| 4 | "Which port of this machine receives the SSH connections?" | `2222` | 1024 to 65535. The seat listens on `127.0.0.1` only. |
| 5 | "Do you want a projects directory in the seat?" | No | The absolute path of an existing directory. The seat gets it at `/projects`, with read and write access. |
| 6 | "Which gateway URL and which key variable name?" | The name `TENANTEXT_LITELLM_API_KEY` | The URL is HTTPS, has no credential, and ends in `/v1`. Ask for the name of the variable, never for the key value. The overlay accepts only the default name. |
| 7 | "Which components do you want?" | None more | The IDs of the checklist of Stage 5, item 2. The action adds `core`, `model-routing`, `codex-accounts` and each component that a chosen component requires. |
| 8 | "Which model for the interactive role?" | `litellm-codex`, `codex-auto/astra`, `high` | The provider, the model and the thinking level, as three separate values. Under `litellm-codex` the model is `codex-auto/astra` (recommended), `codex-auto/sol` or `codex-auto/luna`: the gateway registers only these three. The thinking level is `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The action refuses a model of another provider: the seat has the gateway route only. |

The registry file, `<private dir>/registry.json`, is the list of the models and the thinking levels that the user confirms: `validate`, `plan` and `generate` refuse a role model that it does not hold, and the action writes it with the one answer of question 8.

The gateway must be reachable from inside the container. A gateway on this machine has another name inside a container than `localhost`.

### 2. The plan

Print the plan first. This command writes nothing and runs nothing:

```sh
cd <clone> && python3 scripts/tenant_pi.py compose-plan --account pi --uid "$(id -u)" --gid "$(id -g)" \
  --public-key "$HOME/.ssh/id_ed25519.pub" --ssh-port 2222 --gateway-url '<gateway url>' \
  --private-dir "$HOME/.config/tenant-pi" --model codex-auto/astra [--provider litellm-codex] [--thinking high] \
  [--projects-dir '<projects dir>'] [--enable <component id>]
```

The output is one JSON object. Show the user these parts:

- `overlay`: the content of `<private dir>/overlay.json`. `target.agentDir` is `/home/<account>/.pi/profiles/main`, a path inside the container. `roles.interactive` and the one entry of `modelRoutes.cycle` hold the answer of question 8.
- `registry`: the content of `<private dir>/registry.json`: the provider, the model and the thinking level of question 8.
- `seatEnv` and `composeEnv`: the lines of `<private dir>/seat.env` and `<private dir>/compose.env`. The key line of `composeEnv` is empty.
- `authorizedKeys`: the public key file and its copy in `<private dir>`.
- `commands`: the Compose lines for `docker` and for `podman`, and the login line. A line with `"changes": true` needs a yes from the user.
- `warnings`: read each one to the user.

| Warning | Meaning |
| --- | --- |
| `inspect_shows_key_value` | `docker compose config`, `docker inspect` and `podman inspect` print the key value of `compose.env`. Do not run them in this session. |
| `bind_0_0_0_0_opens_seat_to_network` | The plan binds the port to `127.0.0.1`. A change of `SEAT_BIND` to `0.0.0.0` opens the seat to the network. |
| `gid_20_is_dialout_in_image` | In the image, the group `dialout` has the GID 20. The seat account uses that group. |
| `uid_below_1000`, `gid_below_1000` | The value is below the usual range of a Linux user account. |
| `mcp_input_file_required` | The seat needs `<private dir>/inputs/mcp-adapter.json` before its first start. See Stage 5, item 6. |

An error is one JSON line with `rule: field`, as in Stage 5. The action refuses a model other than the three under `litellm-codex` with `unsupported_gateway_model: compose-plan.model`, and a model of another provider with `unsupported_gateway_model: overlay.modelRoutes.choice`. A rule with the field `overlay.<name>` comes from the overlay validator: the action refuses a memory module before the write with `memory_choices_required`. Leave the module out, write the files, then add the module and its choices of Stage 5, item 5, to `overlay.json` by hand and run `validate`.

### 3. Write the files

`<private dir>` must exist, outside the clone. When it is absent, show and run on yes:

```sh
mkdir -p ~/.config/tenant-pi && chmod 700 ~/.config/tenant-pi
```

Ask: "Write these five files into `<private dir>`?" On yes, run the same command with `--write` as the last option. The action creates `overlay.json`, `seat.env`, `compose.env`, `authorized_keys` and `registry.json`, each with mode 600. It refuses when one of the five exists, for example `target_exists: compose-plan.overlay.json`, and then writes none. Do not delete a file of the user to make the action pass: the user moves the file, or names another private directory.

With Podman, the user sets one more value in `<private dir>/seat.env`: the comment line above `SEAT_USERNS=` gives the exact value.

The entrypoint of the seat gives `<private dir>/registry.json` to `validate`, `plan` and `generate` when the file exists. Another role model and each other choice of Stage 5 are edits of `<private dir>/overlay.json` by hand, before the first start; each model of the overlay also needs its entry in `<private dir>/registry.json`. After each edit, run the syntax check and the `validate` command of Stage 5 on this machine, with `--registry <private dir>/registry.json`.

### 4. The key value

Tell the user: "Open `<private dir>/compose.env` in your editor. Put the gateway key between the two single quotes of the `TENANTEXT_LITELLM_API_KEY=''` line. Save the file."

- The user does this step. Never ask for the value, and never read, print or copy `compose.env` after this step.
- The file keeps mode 600. Check the mode only: `ls -l <private dir>/compose.env`.
- The single quotes stay: Compose then keeps the value literal.

### 5. Build and start

Use the `display` lines of `commands` for the runtime of the user, `docker` or `podman`. Show each line and run it on yes: first `build`, then `up`. Each Compose line carries `KIT_COMMIT` and `--env-file`, also `ps`, `logs` and `down`. The lines have this form:

```sh
KIT_COMMIT="$(git -C <clone> rev-parse --short HEAD)" docker compose --env-file <private dir>/seat.env -f <clone>/deploy/compose/compose.yaml build
KIT_COMMIT="$(git -C <clone> rev-parse --short HEAD)" docker compose --env-file <private dir>/seat.env -f <clone>/deploy/compose/compose.yaml up -d
KIT_COMMIT="$(git -C <clone> rev-parse --short HEAD)" docker compose --env-file <private dir>/seat.env -f <clone>/deploy/compose/compose.yaml logs seat
```

With a projects directory, each line has a second `-f`, for `compose.projects.yaml`. The build runs the four offline checks of the kit and installs the pinned Pi. The `logs` line shows one line for each step of the first start.

Warning: `down -v` removes the home volume with the profile and the sessions, and the seat gets a new host key. The plan has no line with `-v`.

### 6. Which stages the seat replaces

| Stage | In a Compose seat |
| --- | --- |
| 3 (Pi), 4 (package dependencies) | Skip. The image build does them. |
| 4a, parts 2 to 8 | Skip. The image holds Herdr 0.9.3. `herdr` and `questions` are answers to question 7. |
| 5 (the overlay) | Parts 1 to 3 of this stage write the overlay. |
| 6 (plan and generate), 7 (declared npm packages) | Skip. The entrypoint of the seat runs `check-runtime`, `validate`, `plan` and `generate` at the first start. |
| 8 (authentication) | Part 4 of this stage: the key is in `compose.env`. |
| 9 (first launch) | The SSH login: the `login` line of the plan, `ssh -p <port> <account>@127.0.0.1`. |

The first login asks the user to accept the host key of the seat. It then opens the tmux session `seat`, in `/projects` when the projects directory is there. `pi-profile` starts Pi with the profile. Then do checks 1 to 3 of Stage 9 inside the seat. The live `~/.pi/agent` of this machine is not a part of the seat, so check 4 does not apply.

Record in `<private dir>/install-log.md`: the eight answers without a key value, the files that the action wrote, each command that ran, and each result. Record a login or a check that did not run as "not run".

Done when the action wrote the five files, the user confirmed that the key value is in `compose.env`, and the user saw the login or accepted it as an open item.

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
2. `selection`: do "The checklist" below. The action `components` is the one source of the component list, and this file holds no copy of it. The action marks the recommended set. That set holds the core, the in-tree extensions and skills for daily work, and the two local memory modules. Each in-tree component is `unverified`: no test of the kit loads it with the kit pin. `promptr` needs the build step of Stage 4. Stage 4a has the questions for `herdr` and `questions`.
3. `roles.interactive`: the model for the session, as `provider`, `model` and `thinking`. See `docs/model-routes.md`.
4. Gateway, only when the user routes through the Tenantext gateway: `modelRoutes.gateway` is `{"auth": "env"}`; `endpoints.codex-accounts` is the gateway URL that ends in `/v1`; `env.codex-accounts` is `${TENANTEXT_LITELLM_API_KEY}`. The user exports the key themselves.
5. `hermes`, `wiki` and `openviking`, the memory modules. The checklist marks `hermes` and `wiki`. It does not mark `openviking`. Each module that is on needs `consent.memoryCapture: true` and its object in the `memory` block.
   - For `hermes` and `wiki`, the answer of the user to the checklist is the consent. Ask no second question. With both modules on, the overlay gets these two keys:

   ```json
   {
     "consent": {"memoryCapture": true, "remoteMemoryWrites": false, "telemetry": false},
     "memory": {
       "schemaVersion": 1,
       "hermes": {"backgroundReview": false},
       "wiki": {"ambientPersonalVault": true, "backgroundTasks": false},
       "openviking": null
     }
   }
   ```

   - The `memory` block holds all three module keys. The key of a module that is off is `null`. With no memory module on, write no `memory` block and keep `consent.memoryCapture: false`.
   - With these values no module makes a model call of its own, and no `roles.memory` is necessary. Both modules store text and answer tool calls only. To switch the background model calls on later, see [POST_INSTALL.md](POST_INSTALL.md#switch-a-memory-module-on).
   - With `wiki` on, do "The LLM Wiki vault" below before you write `memory.wiki`.
   - `openviking`, only when the user switched it on: ask "Do you agree that session content goes to your OpenViking server?" A yes sets `consent.remoteMemoryWrites: true`. The module also needs an OpenViking server that the user set up, a `memory.openviking` object, and `npm ci --ignore-scripts` in `packages/openviking-pi`. Read `docs/memory-modules.md` with the user first.
6. `mcp`: optional. The checklist does not mark it. The server definitions go to `<private dir>/inputs/mcp-adapter.json`, and the overlay gets `inputs.mcpFile: "inputs/mcp-adapter.json"`. Every `validate`, `plan` and `generate` call then needs `--local-dir ~/.config/tenant-pi`. Read `docs/workflow-modules.md` with the user first.

7. Registry, required when `modelRoutes` names a model for a role or the cycle: edit `~/.config/tenant-pi/registry.json` (mode 600; `init-private` creates it as `{}`, the fallback does not create it).
   Its whole shape is `{"<provider>": {"<model>": ["<thinking level>"]}}`, with one entry for each model of `roles` and `modelRoutes.cycle`.
   The user confirms each entry. The file is evidence of the user's choice, not a model catalog. See `docs/generator.md`.

### The checklist

The checklist replaces a question with options. It shows each component of the kit, so that no component is hidden from the user.

1. Run the action. For a new overlay:

   ```sh
   cd ~/tenant-pi && python3 scripts/tenant_pi.py components --format text
   ```

   For an overlay that exists, add `--overlay <file>`. The marks are then the `selection.enable` list of that file.
2. Print the complete output to the user as plain text. Remove no line and change no line. The last line of the output says how to answer.
3. When the list marks `hermes` and `wiki`, print this sentence directly below the list: "`hermes` and `wiki` are marked. Both store text of your sessions on this machine. With the default setting, `wiki` also adds text from your vault to each prompt in each directory, and that text goes to your model provider. Keep a mark only when you agree to that. Switch off the number of a module that you do not want." When the list marks only one of the two, name that one. Without a mark at `wiki`, leave out the sentence about the vault.
4. Stop and wait for the answer of the user. Do not open a question dialog after the list: a dialog can hide the text before it. The user answers `ok`, or names the numbers to switch on and the numbers to switch off.
5. Turn the answer into the list of each component that is on: each marked line, plus each number that the user switched on, minus each number that the user switched off. `--select` takes that complete list, as IDs or as numbers, not only the changes. Run:

   ```sh
   python3 scripts/tenant_pi.py components --select <ids or numbers, separated by commas>
   ```

   The action writes no file. `core` is locked and is always in the output.
6. Read `added` of the output. Tell the user each ID of it: the action added that component because another one requires it.
7. Write the `selection` object of the output into `overlay.json`, in place of the `selection` object that is there.
8. Read `prerequisites` of the output. For each `overlay:` code, set the key: items 5 and 6 of the list above have the values. For each `env:` and `gap:` code, tell the user what the component needs; `docs/guides/modules.md` has one row for each component. An `env:` or `gap:` code does not block the install. A `setup:` code is a setup line of the plan: Stage 7 runs it.

### The LLM Wiki vault

Do this part when `wiki` is on, before you write `memory.wiki`. The rule of the kit: the profile uses an existing vault of the user as it is. The kit makes no second vault. It refuses a target, a launcher file, a results directory or a results target, a baseline file, a private directory and a Compose directory that is a vault or is below one, with `under_wiki_vault`. The vaults are `.llm-wiki` in the home directory, `<WIKI_HOME>/.llm-wiki`, and, for an action that reads the overlay, `<wikiHome>/.llm-wiki`. `baseline` and `init-private` read no overlay, so they know the first two only.

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py check-wiki-vault
```

The action has no option. It reads `HOME` and `WIKI_HOME`, uses `lstat` calls only, opens no file and writes nothing. Run it as the account that will run the profile, in the shell that will launch Pi. `docs/memory-modules.md`, section "The vault check", has each key of the output.

Read `result`, `personalVault` and the two roots `home` and `wikiHome`. Then tell the user the result in one or two sentences:

| Output | `memory.wiki.wikiHome` | Tell the user |
| --- | --- | --- |
| `vault_exists`, `personalVault` is `home`, `home.config` is `true` | Do not set it. | The profile uses the vault `~/.llm-wiki/` with no extra setting. The kit refuses each place of its own writes that is the vault or is below it. At `@zosmaai/pi-llm-wiki` 0.12.5 a start changes no existing file of a vault and adds only its index directory `meta/qmd/`. Not verified: a newer version. Pages change only when the agent of the user calls a wiki write tool. |
| `vault_exists`, `personalVault` is `wikiHome`, `wikiHome.config` is `true` | The value of `wikiHome.root`. | The same sentences, for the vault `<WIKI_HOME>/.llm-wiki/`. When `home.exists` is also `true`: the vault of the home directory stays unchanged and is not used. |
| `second_vault` | Do not set it. | `WIKI_HOME` names a directory with no vault, and a vault exists in the home directory. The profile uses the vault of the home directory. The launch line removes the inherited variable for the Pi process. |
| `no_vault`, `wikiHome` is `null` | Do not set it. | No vault exists. The extension makes `~/.llm-wiki/` at the first start. |
| `no_vault`, `wikiHome` is not `null` | The value of `wikiHome.root`. | No vault exists. The extension makes `<WIKI_HOME>/.llm-wiki/` at the first start, the place that the environment of the user names. |

- `ambientPersonalVault: true` is the value of this flow for each result. The extension then injects recall from the vault into each prompt, in each working directory. `false` is the quiet form: a start writes nothing, no recall goes into a prompt, and the tools still use the vault. Set `false` only when the user asks for it. `wikiHome` needs `true`.
- `doubled` is `true` for the vault that the profile uses: stop and ask the user. The vault holds an inner vault, `.llm-wiki/.llm-wiki/config.json`, and the extension moves the inner vault one level up at the first start. `wiki` stays off until the user agrees: run `components --select` again without `wiki`, and set `memory.wiki` to `null`. When this rule and the next rule both apply, this rule wins: do not give the message of the next rule.
- `config` is `false` for a vault that exists and that the profile uses: do not tell the user that the profile uses the vault. Tell the user that the directory has no `config.json`. The extension makes no new vault in such a directory, and it reports a blocked setup. For `memory.wiki.wikiHome`, use the row with the same `personalVault`.
- `embeddings.exists` is `true`: tell the user that embeddings stay off and that the store `meta/embeddings.json` stays unchanged. Never set `memory.wiki.embedding` on your own. See the second `Warning:` of [an existing vault](docs/memory-modules.md#an-existing-vault).
- `ownedByUser` is `false`: tell the user. Not verified: a start of the extension with a vault that the account cannot write.
- The probe sees the vault of one account only. Stage 4a, part 2, has the rule for a new account.
- Record `result` and the path of the vault in the install log. Stage 9 records the baseline of the vault before the first Pi command, and compares it after the first launch.

### Validate

Validate after each edit:

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py validate --overlay ~/.config/tenant-pi/overlay.json [--registry ~/.config/tenant-pi/registry.json]
```

Add `--registry` only when the overlay has `modelRoutes` with a model for a role or for the cycle. Without the option, such an overlay stops with `registry_required: registry`.
An overlay without `modelRoutes` refuses the option with `registry_without_routes: registry`. A core-only overlay is one, and so is the recommended set with no model route.

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
python3 scripts/tenant_pi.py plan --overlay ~/.config/tenant-pi/overlay.json [--registry ~/.config/tenant-pi/registry.json]
python3 scripts/tenant_pi.py generate --overlay ~/.config/tenant-pi/overlay.json [--registry ~/.config/tenant-pi/registry.json] --target '<target>'
```

Use the same `--registry` choice as in Stage 5 for both commands: give the option only when the overlay has `modelRoutes`.

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

Only when `mcp`, `hermes`, `wiki` or `questions` is enabled. The recommended set of the checklist holds `hermes` and `wiki`, so this stage applies to it. The plan prints one `pi install` line for each declared `npm:` source, in the order of `packages` in `settings.json`. It prints the last line, the peer override, only with `hermes`, `wiki` or `questions`.

Record the baseline of the live agent directory first, and with `wiki` the baseline of the vault: see the two "Before the first launch" parts of Stage 9. The first `pi install` line is the first Pi command that names `<target>`.

Run the lines of `commands.setupDisplayOnly` that name `<target>`, in the order of the plan. With all four components they are:

```sh
PI_CODING_AGENT_DIR='<target>' pi install npm:pi-hermes-memory
PI_CODING_AGENT_DIR='<target>' pi install npm:@zosmaai/pi-llm-wiki
PI_CODING_AGENT_DIR='<target>' pi install npm:pi-mcp-adapter
PI_CODING_AGENT_DIR='<target>' pi install npm:@juicesharp/rpiv-ask-user-question@2.11.0
PI_CODING_AGENT_DIR='<target>' node ~/tenant-pi/scripts/patch_extension_peers.mjs
```

- Use each source string as the plan prints it. `pi install` leaves `settings.json` unchanged only when the string is identical to the declared string. With a different string, or with a source that the profile does not declare, Pi rewrites `settings.json`, and `compare` shows the change as drift.
- `mcp`, `hermes` and `wiki` are declared without a version. Each `pi install` line installs the newest registry version of its package; tell the user which versions it installed. The kit reviewed `pi-mcp-adapter` 3.2.0, `pi-hermes-memory` 0.9.9 and `@zosmaai/pi-llm-wiki` 0.12.4. The facts of an existing vault are from `@zosmaai/pi-llm-wiki` 0.12.5. After an install or an update of the `wiki` package, check 8 of Stage 9 is the proof for the installed version.
- `questions` is declared at the exact version 2.11.0, and its line installs that version.
- `pi update --extensions` is not a setup command. With the kit pin it does not install or change a source with an exact version. It only moves an installed source without a version to the newest registry version.
- The last command corrects host-provided peers in the installed manifests. Run it after the `pi install` lines.

To reapply the correction after each update, `docs/host-peer-overrides.md` describes an `npmCommand` wrapper.

- The commands of that document write to `~/.pi/agent`. Replace `~/.pi/agent` with `<target>` in every path.
- Ask before each write.
- The wrapper is for Linux and macOS. The systemd unit of that document is for Linux only.
- The `npmCommand` key then shows as drift in `compare`; see "Keep an accepted difference" in [POST_INSTALL.md](POST_INSTALL.md#keep-an-accepted-difference). That is expected.

Hermes builds `better-sqlite3`. On macOS that needs the Xcode command line tools from Stage 1.

Done when `PI_CODING_AGENT_DIR='<target>' pi list` prints a path line that starts with `<target>/npm/node_modules/` below each declared `npm:` source, and a second run of the override script prints nothing. With `questions`, `python3 scripts/tenant_pi.py inventory --dir '<target>'` also shows `coordination.questionExtension` as `installed`.

- `pi list` prints a declared source also when the package is not installed. Only the path line below the source shows an installed package.
- Limit: no part of this check compares the installed version with the declared version.

## Stage 8: authentication

The kit writes no credential. Two paths:

- Native provider: launch Pi (Stage 9) and run `/login` inside it. Pi stores the result in `<target>/auth.json`.
- Tenantext gateway: the user exports `TENANTEXT_LITELLM_API_KEY` in the shell that launches Pi. The launch line carries `TENANTEXT_LITELLM_BASE_URL`.

For the gateway, ask how the key reaches the process: the launching shell, a launcher script the user writes, or a secret store the user already uses. Never edit a shell startup file yourself.

### Direct providers: Codex, llama-swap and vLLM

Goal: each provider that the user wants is in the profile, with no gateway.

Ask which of the three the user wants. `docs/guides/providers.md` has the complete steps, the examples and the verification. Follow it and do not write the commands from memory.

- Codex: a provider that Pi includes. The user runs `/login` inside Pi and selects the model with `/model`. The login is separate from the gateway key.
- llama-swap and vLLM: ask for the base address, the exact model alias, and whether the server needs a key. Use no default. Register the provider in `<target>/models.json` after generation. A key is a `$NAME` reference to an environment variable, never a value.
- A direct provider accepts local HTTP, a LAN address and each port. The gateway route stays HTTPS only: `docs/model-routes.md`.
- The kit writes no `models.json` and has no input for it: `inputs.modelsFile` stays `null`. Keep the master copy in `<private dir>` and copy it into each new target.
- Do not replace a `models.json` that exists, and do not copy `auth.json` between profiles.

Done when the user approved and ran the two verification steps of the provider guide, or the install log says "not run" and names the provider as unverified.

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

### Before the first launch: the baseline of the vault

Only with `wiki`. Goal: a record that can prove, after the launch, that the content of the vault stayed as it was. Record it one time, at the same moment as the baseline of the live agent directory. `<vault>` is the vault that the profile uses, from "The LLM Wiki vault" in Stage 5. `<vault>` is `<wikiHome>/.llm-wiki` when the overlay has `memory.wiki.wikiHome`, else the `.llm-wiki` directory in the home directory. Write it as an absolute path, for example `/home/<name>/.llm-wiki`.

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py baseline --dir '<vault>' --out "$HOME/.config/tenant-pi/wiki-vault-baseline.json"
```

- The action lists the directories of the vault and opens no file. The one write is the new file in `<private dir>`. The action refuses an `--out` file that is below the vault of the home directory or below `<WIKI_HOME>/.llm-wiki`. It does not know a vault that only the overlay names: keep `--out` in `<private dir>`.
- Run it also when no vault exists. The baseline then records that the vault is absent.
- When the vault is a symbolic link, the action stops with `not_directory: baseline.dir`. Use the `realpath` rule of the part above.
- The comparison of check 8 names the direct entries of the vault only. For a record of the entries below `meta/`, record a second baseline of an existing vault: `--dir '<vault>/meta'` and `--out "$HOME/.config/tenant-pi/wiki-vault-meta-baseline.json"`.

Done when the output has `"complete":true` under `baseline`.

### Launch

The recommended way to launch is the launcher file. Add `--launcher '<launcher file>'` to the `generate` command of Stage 6, for example `--launcher ~/.config/tenant-pi/launch-<name>.sh`. After a complete generation, the kit writes that file with mode `0700`: `#!/bin/sh` and one `exec` line with the exact `commands.launchDisplayOnly` line of the plan. Ask the user to run the file, or run it on yes. With the gateway, the shell that runs the file must export `TENANTEXT_LITELLM_API_KEY`; the file holds no key. See `docs/launcher.md`.

Without a launcher file, use the exact `commands.launchDisplayOnly` line from the plan.

Rule: the profile keeps its sessions in `<target>/sessions`. The launch line holds `env -u PI_CODING_AGENT_SESSION_DIR`, which removes an inherited session directory for the one `pi` process. Do not remove that part, and do not start the profile with a bare `PI_CODING_AGENT_DIR='<target>' pi` in a shell where Stage 0 found `PI_CODING_AGENT_SESSION_DIR`.

### Checks

1. `pi --version` in that environment prints `<pin>` or an accepted version. Record the untested-version gap when needed.
2. Startup prints no extension error and no peer warning.
3. The chosen model replies to the fixed prompt, and the reply holds the expected number: see "Check 3: the model reply" below. An auth error with the gateway means the key did not reach the process.
4. The profile stayed inside its directory. `ls -la '<target>'` shows the generated files plus what Pi wrote: `auth.json`, `models-store.json`, `sessions/`, the state directories of the extensions, and `npm/` only with a declared npm package. Pi also adds the key `lastChangelogVersion` to `settings.json`. Observed with Pi 1.1.0 and a core-only profile. The comparison of the live agent directory with its baseline gives `unchanged`: see "Check 4: the comparison with the baseline" below.
5. With Hermes: `<target>/pi-hermes-memory/` exists after the first session. With the wiki, `ambientPersonalVault: false` and no vault before the launch: `~/.llm-wiki` was not created.
6. With the MCP module: `/mcp-adapter status` inside Pi lists only the servers from the input file.
7. With `herdr` or `questions`: five separate results, each recorded on its own line. `python3 scripts/tenant_pi.py check-herdr` gives the Herdr command. `python3 scripts/tenant_pi.py inventory --dir '<target>'` gives `coordination.herdrSkill` and `coordination.questionExtension`. The question dialog and a temporary Herdr session are live checks that the user approves first; without them, record "not run". A present command and a readable skill file do not prove a session or a question dialog. `docs/herdr-setup.md` has the steps and the values.

8. With `wiki`: the content of the vault stayed as it was. The comparison of the vault with its baseline gives `unchanged` or only the expected difference: see "Check 8: the comparison of the vault" below.

Record each check as passed, failed, or not run. Check 4 has one more value, not verified. Check 8 has the same value.

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

### Check 8: the comparison of the vault

Only with `wiki`, after the first launch. `<vault>` is the directory of the vault baseline:

```sh
cd ~/tenant-pi && python3 scripts/tenant_pi.py check-baseline --dir '<vault>' --baseline "$HOME/.config/tenant-pi/wiki-vault-baseline.json"
```

With `ambientPersonalVault: true`, the first start of the extension makes the index directory `meta/qmd/` in an existing vault, and that changes the modification time of `meta/`. The comparison then prints `changed` with exit code 1. This one difference is expected:

```json
{"added":[],"dir":"/home/EXAMPLE_USER/.llm-wiki","directoryModified":false,"modified":["meta"],"now":"present","recordedAt":"2030-01-01T00:00:00Z","removed":[],"result":"changed","scope":"Compares the name, kind, size and modification time of each entry at all levels, and names the direct entries only. Opens no file. Covers the time after recordedAt only.","was":"present"}
```

| Output | Meaning | Record check 8 as |
| --- | --- | --- |
| `"result":"unchanged"` | No entry of the vault differs. This is the result with `ambientPersonalVault: false`, and with a vault that had `meta/qmd/` before. | passed |
| `"result":"changed"`, `"modified":["meta"]`, `"added":[]`, `"removed":[]`, `"directoryModified":false` | The expected difference of an existing vault with `ambientPersonalVault: true`. | passed |
| `"result":"changed"`, `"was":"absent"`, `"now":"present"` | No vault was there before, and the extension made one at the first start. `added` names its entries. | passed |
| Each other output with `changed` | Another entry of the vault differs: a name in `added` or `removed`, a name other than `meta` in `modified`, or `"directoryModified":true`. | failed, or not verified: see below |
| `"result":"no_baseline"` | The baseline file does not exist. | not run, never passed |

With another difference, stop. Do not launch the profile again. Tell the user the names. Then ask: did an agent of the user call a wiki write tool after `recordedAt`, in this profile or in another Pi of the account? Each profile of the account uses the same vault.

- No wiki tool ran. Record check 8 as failed, with the names, and report it.
- A wiki tool ran. Record check 8 as not verified, with the names and the answer of the user. Do not record it as passed.

Limit: the comparison names the direct entries only. `"modified":["meta"]` does not show which entry below `meta/` differs. With the second baseline of the part "Before the first launch", compare `meta/` itself: `--dir '<vault>/meta'` and `--baseline "$HOME/.config/tenant-pi/wiki-vault-meta-baseline.json"`. The expected output has `"added":["qmd"]`, `"modified":[]`, `"removed":[]` and `"directoryModified":true`.

Not verified: these outputs after a start of Pi with the wiki package. They come from `check-baseline` on a directory with the same change. Not verified: the names of the entries of a new vault.

### The results file

Write the results file at the end of this stage, and at each earlier stop of rule 6. The file is `<private dir>/INSTALLER_KIT_RESULTS.md`. It is the guide for the user: what the install did, the account, how to start Pi, where each part is, which components are on and off, and how to add a component that is off. `install-log.md` stays the record of the commands.

1. Write the facts file `<private dir>/results-facts.json`, with mode 600. It holds the facts that the kit cannot read: the date, your name, `complete` or `stopped`, the last stage, the next step, the account and the command that opens a shell of it, the launcher of each candidate, one row for each stage, one row for each check, the vault of Stage 5, and notes. `docs/install-results.md`, section "The facts file", has the schema and an example. The schema is closed.
2. Write no secret value into the facts file. Name a credential by its environment variable only. The action refuses a text that has the form of a secret.
3. Show the command and run it on yes:

   ```sh
   cd ~/tenant-pi && python3 scripts/tenant_pi.py results --facts ~/.config/tenant-pi/results-facts.json --overlay ~/.config/tenant-pi/overlay.json --target '<target>' --out-dir ~/.config/tenant-pi
   ```

   The output has `"complete":true` and the `path` of the file. The file has mode 600.
4. The file exists from an earlier stop or from an earlier candidate: add `--replace`, and name each candidate with its own `--target`. The action then writes the complete file again. Without `--replace`, an existing file stops the action with `target_exists: results.out_dir`.
5. The install stopped before an overlay or a target existed: leave out `--overlay` or `--target`, and give no launcher in the facts file. When `<private dir>` does not exist, use the home directory of the account as `--out-dir`, and keep the facts file there. When the clone does not exist yet, the action does not exist: do not run `results`. Tell the user in plain text the last stage, the reason and the next step. The last line of your work is then the next step.
6. The action refuses an `--out-dir` directory inside the clone, inside a target, and one that is a vault or is below one. It refuses a `--target` that is a vault or is below one. `<private dir>` is the right place.
7. The install made a new account, and the user who started you cannot read `<private dir>`: put a copy of the file into the home directory of that user too. The copy needs administrator rights, so show the command and run it only on yes, for example `sudo install -m 600 -o '<user>' '<private dir>/INSTALLER_KIT_RESULTS.md' '<home of that user>/INSTALLER_KIT_RESULTS.md'`. Not verified: this command on a clean host.

Then end your work with these lines:

- The file has the section "How to add a component that is off". Do not repeat its steps: name the file.
- [POST_INSTALL.md](POST_INSTALL.md) is the next document. It has the commands of each later update and change.
- The last line is the full path of the results file. With a copy, name both paths.

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

The first install ends with Stage 9. This stage is one message to the user, and it runs no command.

Tell the user the rule of each later change: the kit changes no profile in place. A new kit version, a new component or a new Pi pin gives a new candidate directory from the same overlay with another `target.agentDir`. The old candidate stays as the fallback. Auth, sessions and memory are not copied.

[POST_INSTALL.md](POST_INSTALL.md) is the guide for that time. The user, or an agent of the user, reads it in place of this file. It gives the loop of a change one time. Then it has one section with the commands of each task: a component, a memory module, the npm packages, an accepted difference, `compare` and `carry`, the baseline, a removal, a new kit version, a new Pi version, a provider, and the update of a Compose seat.

## Not in this kit

The kit does not install operating-system packages on its own, edit shell startup files, store credentials, run a service, or migrate an existing agent directory. The tracker skill is selectable but remains unverified in a generated profile. Subagent packages are not installable from this release. The kit ships the OpenViking extension for Pi as a memory module; it does not install or configure an OpenViking server. Not verified: a live qualification on a clean client.
