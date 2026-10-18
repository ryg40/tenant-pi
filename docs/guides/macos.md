# macOS guide for Apple silicon

Scope: Apple silicon (arm64). macOS stays **Not qualified**.
This is an adaptation of [INSTALL.md](../../INSTALL.md), not a second procedure.
Follow its stages in order. Use the differences here at the named stage.

No live stage or module is `ready`. Use the setup labels:

| Label | Meaning here |
| --- | --- |
| `unverified` | The instructions have no accepted live macOS trial. |
| `blocked` | A required tool, version or service is missing. |
| `skipped` | You did not select the module or run the step. |

An offline check that passes is recorded as passed, not as platform qualification.

## Before you start

macOS uses zsh as its login shell; put all PATH and variable lines in `~/.zshrc`; reload with `exec zsh`.

Read [inventory](../../INSTALL.md#stage-0-inventory), including the live-profile and environment checks.
The examples keep the kit at `~/tenant-pi` and the private directory at `~/.config/tenant-pi`.
Use `"$HOME/..."` in commands. In JSON, use the expanded absolute path, not `~` or `$HOME`.

The kit Node range is `>=24.0.0 <25`. Python must be 3.11 or later; this adaptation selects `python@3.12`.
Use a native terminal and the [Apple silicon Homebrew prefix](https://docs.brew.sh/Installation), `/opt/homebrew`.
Rosetta is not needed for the native tools listed here.

### Package architecture

A bottle is a prebuilt Homebrew package. The formula links list the macOS versions with native Apple silicon bottles.
A bottle listing proves package availability, not a successful kit installation.
Check the formula for your macOS version before installing. Do not infer support for an older macOS release.

| Suggested package or tool | arm64 status | Use |
| --- | --- | --- |
| [git](https://formulae.brew.sh/formula/git) | Native arm64 bottles: macOS 15 (Sequoia), 26 (Tahoe); none for 14 (Sonoma) | Clone and scan history. |
| [python@3.12](https://formulae.brew.sh/formula/python@3.12) | Native arm64 bottles: macOS 15 (Sequoia), 26 (Tahoe); none for 14 (Sonoma) | Run the kit. |
| [node@24](https://formulae.brew.sh/formula/node@24) | Native arm64 bottles: macOS 15 (Sequoia), 26 (Tahoe); none for 14 (Sonoma) | Run Pi and build optional packages. |
| [podman](https://formulae.brew.sh/formula/podman) | Native arm64 bottles: macOS 15 (Sequoia), 26 (Tahoe); none for 14 (Sonoma) | The [Compose seat](compose-seat.md) only. The scan does not use it. |
| [Betterleaks](https://github.com/betterleaks/betterleaks/releases/tag/v1.9.0) 1.9.0 | The release has a `darwin_arm64` archive; the Homebrew cask `betterleaks/tap/betterleaks@1` installs the command `betterleaks-v1`; version output on a Mac not verified | The scanner of the scan hook. See [the scanner section](#scanner-the-betterleaks-binary). |
| nvm with Node 24 | Not verified here; nvm is a shell version manager, not a native bottle | Optional per-user alternative to Homebrew Node; initialize nvm in `~/.zshrc`. |
| Xcode Command Line Tools | Not verified here; Apple supplies the toolchain, not a Homebrew bottle | Compile native addons when needed. |
| Pi and the selected npm packages | Not verified on arm64; npm packages, not Homebrew bottles | Install only the selected modules. |

## Obtain the sources

Follow [INSTALL.md](../../INSTALL.md#stage-2-clone-and-check-the-kit) without changing its checks.
If Git or Python is missing, install only those bootstrap tools first:

```sh
brew install git python@3.12
export PATH="/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:$PATH"
python3 --version
git --version
```

The Python path makes `python3` select this formula rather than the system Python.
Use Homebrew's installation instructions first if `brew` is missing.
Use the dependency adaptations below with the install stages.

## Edit the local choices

Follow [INSTALL.md](../../INSTALL.md#stage-5-the-private-overlay), including `init-private` and the absent target requirement.
Its `"$HOME/..."` commands also apply on macOS.
For a manual JSON edit, use your expanded macOS home path instead of the `/home/EXAMPLE_USER` example.
Keep the target outside the kit, the private directory and the live profile.

## Validate

Run [INSTALL.md](../../INSTALL.md#validate) unchanged. Stop on a validation error.

## Plan

Run [INSTALL.md](../../INSTALL.md#stage-6-plan-and-generate) unchanged, including the runtime report and the launcher path.
Read each readiness gap. A version match does not prove a macOS launch.

## Generate

Run [INSTALL.md](../../INSTALL.md#stage-6-plan-and-generate) unchanged.
Keep `--launcher "$HOME/.config/tenant-pi/launch-main.sh"` and the separate target.
The generated runtime stays `unverified`.

## Install the dependencies by hand

Follow [INSTALL.md](../../INSTALL.md#stage-1-requirements).
The kit installs nothing. Run only the commands for the modules you select.

Warning: installation commands change the machine. Review each command before running it.

### Node and Python

Git and Python may already be present from the source prerequisites. Select Homebrew Node 24:

```sh
brew install git python@3.12 node@24
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:$PATH"
node --version
python3 --version
file "$(command -v node)"
node -p 'process.arch'
```

Node must report a 24.x version. The `file` output should show `arm64`; `process.arch` must print `arm64`.
If `file` reports a symbolic link, inspect its target with `file -L "$(command -v node)"`.
Stop on `x86_64` or `x64`; correct the terminal and tool paths rather than adding Rosetta.
`node@24` is keg-only, so its explicit `PATH` line matters.
The export changes this zsh only. Review adding the export line to `~/.zshrc` yourself.

Alternatively, use a per-user nvm installation instead of Homebrew Node. For a home that has no nvm:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
. "$HOME/.nvm/nvm.sh"
nvm install 24 && nvm use 24
```

The first line installs nvm `v0.40.3` into `~/.nvm`. Before you run it, read the release page <https://github.com/nvm-sh/nvm/releases/tag/v0.40.3> and the script at the URL of the first line. The kit gives no checksum for the script.
When `nvm` is already a command in your zsh, run the third line only.

The kit never edits a shell startup file. Make one of two choices:

- Option one: run the first line without `PROFILE=/dev/null`. The nvm install script then adds the nvm lines to `~/.zshrc`, never `~/.bashrc`. Run `touch ~/.zshrc` first when the file is absent. Run `exec zsh` after the install to reload the file.
- Option two: keep `PROFILE=/dev/null`. The script prints `Profile not found` and edits no file. Run `. "$HOME/.nvm/nvm.sh"` in each zsh that runs a kit command or the launcher.

The launcher runs `pi` from the `PATH` of the zsh that starts it. With option two, run the `. "$HOME/.nvm/nvm.sh"` line before the launcher too.

Repeat the Node version and architecture checks after selecting it.
Not verified: this nvm route on macOS with the kit.

### Pi and module dependencies

Keep the Pi decision rules of [INSTALL.md](../../INSTALL.md#stage-3-install-pi).
Skip installation for `match` or `untested_in_range`; record the untested-version gap.
For `missing`, check the npm prefix first. For `mismatch` or `unparsed`, make INSTALL.md's explicit decision.

```sh
# Run from the kit root, only after the install decision.
cd "$HOME/tenant-pi"
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Warning: a global install replaces the `pi` command for every profile of the user.

Use INSTALL.md's user-owned prefix alternative if the global prefix is not writable or replacement is not wanted.
Do not run npm with `sudo` to work around that check.

Only for an enabled Tenantext component:

```sh
cd "$HOME/tenant-pi/packages/tenantext" && npm ci --ignore-scripts
```

Only for `promptr`:

```sh
cd "$HOME/tenant-pi/packages/promptr" && npm ci --ignore-scripts && npm run build
```

The package `pi-hermes-memory` uses the native module `better-sqlite3`. Observed with `better-sqlite3` 13.0.3 and npm 11.19.0 on Linux x64: the module holds a prebuilt binary. npm runs no install script, nothing is compiled, and the module loads from that file. Not verified: a prebuilt binary for macOS. Only when no prebuilt binary fits the platform and the Node version, a build from source needs a compiler toolchain. With npm 11, npm does not start that build on its own. Observed with npm 11.19.0: the `npm warn install-scripts` line of the `wiki` install names `better-sqlite3`, and npm runs no install script. For a build from source, install the Apple toolchain when absent:

```sh
xcode-select --install
```

Not verified: the native addon build with this toolchain and Node 24 on macOS.

Before the first Pi command that names the target, record [the baseline](../../INSTALL.md#stage-9-first-launch-and-checks).
Run from the kit root:

```sh
cd "$HOME/tenant-pi"
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

Keep the extra baselines for inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` as INSTALL.md specifies.
Do not replace an existing baseline or record it after a target Pi command.

Only for `mcp`, `hermes`, `wiki` or `questions`. Run only the `pi install` lines that your plan prints, with each source string as the plan prints it:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-hermes-memory
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@zosmaai/pi-llm-wiki
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-mcp-adapter
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@juicesharp/rpiv-ask-user-question@2.13.8
```

Only for `hermes`, `wiki` or `questions`, also, after the `pi install` lines:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

The plan prints this line with the absolute path of the script of the clone, so the line runs from each directory. Run the line as the plan prints it. With `wiki`, read [the audit summary of npm](../../INSTALL.md#the-audit-summary-of-npm) before the `pi install` line.

Warning: do not run `npm audit fix` in the profile.

Keep INSTALL.md's declared-package version caveats and compare the profile after native Pi operations.
Regenerate the runtime report and run `plan` again after changing Node or Pi.
The runtime stays `unverified`. A dependency step that you omit is `skipped`.

### Scanner: the Betterleaks binary

The scan hook uses [scripts/scan.sh](../../scripts/scan.sh); see [secret handling](../secret-handling.md#scanner).
The script runs only the Betterleaks binary. It needs the version output `1.9.0` or `v1.9.0`.
The scan starts no container and no virtual machine.

Choose one of two routes: the release archive or the Homebrew cask. Run each step in zsh.

#### Route 1: the release archive

1. Make an empty directory and go into it.

   ```sh
   cd "$(mktemp -d)"
   ```

   `pwd` must print the new directory.

2. Download the `darwin_arm64` archive.

   ```sh
   curl -fsSLO https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/betterleaks_1.9.0_darwin_arm64.tar.gz
   ```

   The command must end with exit code 0.

3. Check the archive against the pinned line.

   ```sh
   echo '83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2  betterleaks_1.9.0_darwin_arm64.tar.gz' | shasum -a 256 -c
   ```

   The command must print `betterleaks_1.9.0_darwin_arm64.tar.gz: OK`. Stop at any other output.

4. Extract the binary.

   ```sh
   tar -xzf betterleaks_1.9.0_darwin_arm64.tar.gz betterleaks
   ```

   The command extracts only the binary. The checksum of the archive covers it.

5. Install the binary into a directory of your own.

   ```sh
   mkdir -p "$HOME/.local/bin"
   install -m 755 betterleaks "$HOME/.local/bin/betterleaks"
   ```

   `ls -l "$HOME/.local/bin/betterleaks"` must show the file with mode `-rwxr-xr-x`.

6. Put the directory on `PATH`. Add this line to `~/.zshrc`:

   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   ```

   Run `exec zsh`. Then `command -v betterleaks` must print the path of step 5.

7. Check the version.

   ```sh
   betterleaks version
   ```

   The command must print `1.9.0`.

Not verified: the output of `betterleaks version` on a Mac. Not verified: macOS Gatekeeper accepts the binary without a prompt.

#### Route 2: the Homebrew cask

1. Install the cask.

   ```sh
   brew install --cask betterleaks/tap/betterleaks@1
   ```

   The cask installs the command `betterleaks-v1`, not `betterleaks`.

2. Name the command for the scan. Add this line to `~/.zshrc`:

   ```sh
   export BETTERLEAKS_BIN=betterleaks-v1
   ```

   Run `exec zsh`. Then `echo "$BETTERLEAKS_BIN"` must print `betterleaks-v1`.

3. Check the version.

   ```sh
   betterleaks-v1 version
   ```

   The command must print `1.9.0`. Another version stops the scan. Then use route 1.

Not verified: the version that the cask installs, and the output of `betterleaks-v1 version`.
The cask has no pinned checksum in this kit. Route 1 checks the pinned checksum.

#### Check the scan

Run the scan in the kit:

```sh
cd "$HOME/tenant-pi"
scripts/scan.sh --level fail tree
```

The command must end with exit code 0. Exit code 2 with `no Betterleaks binary` or `need 1.9.0` shows a missing binary or another version.
Keep `PATH` or `BETTERLEAKS_BIN` in the zsh that runs Git hooks. In kitty on macOS, this is the zsh of the window.
Not verified: a complete scan-hook run on macOS.
A failure leaves the scan `blocked`; do not skip the hook.

## Authenticate

Follow [INSTALL.md](../../INSTALL.md#stage-8-authentication) unchanged.
Keep credentials out of the overlay. Check variable names in the same shell that runs the launcher.
In kitty on macOS, this is the zsh of the window.
Label: `skipped` until you run this stage.

## Launch

Follow [INSTALL.md](../../INSTALL.md#stage-9-first-launch-and-checks), including every baseline not already recorded before dependency installation.
Keep the generated launcher file unchanged:

```sh
"$HOME/.config/tenant-pi/launch-main.sh"
```

It selects `PI_CODING_AGENT_DIR` for one process and removes the inherited session directory.
Do not replace it with a bare `pi` command.

## Test

Follow [INSTALL.md](../../INSTALL.md#stage-9-first-launch-and-checks), including the explicit model choice and each baseline comparison.
Record checks as passed, failed, blocked or not run. A skipped command is not evidence.
Not verified: a complete macOS run of these stages.

## Evidence that would change the status

The [release checklist](release-checklist.md#platforms-that-are-not-qualified) requires Gate 6 on a clean macOS user with Homebrew or nvm Node.
It also requires the tests and publish check on that machine.
Record exact commands, versions, and each check as passed, failed, blocked or not run.
Record the model reply separately and keep the live-profile baseline comparison.
The release maintainer must accept the record before macOS changes from **Not qualified**.
Bottle listings and this documentation review do not change that status.
