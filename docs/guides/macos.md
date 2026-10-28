# macOS guide for Apple silicon

Scope: Apple silicon (arm64). macOS stays **Not qualified**.
This is an adaptation of [INSTALL.md](../../INSTALL.md), not a second procedure.
Follow its steps in order. Use the differences here at the named step.

No live stage or module is `ready`. Use the setup labels:

| Label | Meaning here |
| --- | --- |
| `unverified` | The instructions have no accepted live macOS trial. |
| `blocked` | A required tool, version or service is missing. |
| `skipped` | You did not install the module or run the step. |

An offline check that passes is recorded as passed, not as platform qualification.

## Before you start

macOS uses zsh as its login shell; put all PATH and variable lines in `~/.zshrc`; reload with `exec zsh`.

An update needs no macOS adaptation: run [Get a new version of the kit](../../POST_INSTALL.md#get-a-new-version-of-the-kit) in zsh.

The examples keep the kit at `~/tenant-pi` and the profile at `~/.pi/profiles/main`.
Use `"$HOME/..."` in commands. In JSON, use the expanded absolute path, not `~` or `$HOME`.
A kit path under `/tmp` or `$TMPDIR` must be the resolved `/private/...` form; the tests handle this on their own.

The kit Node and Python ranges are `runtime.nodeRange` and `runtime.pythonRange` in `config/manifest.json`. This adaptation selects `node@24` and `python@3.12`.
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
| [Betterleaks](https://github.com/betterleaks/betterleaks/releases/tag/v1.9.0) 1.9.0 | The release has a `darwin_arm64` archive; the Homebrew cask `betterleaks/tap/betterleaks@1` installs the command `betterleaks-v1`; version output on a Mac not verified | The scanner of the scan hook. See [the scanner section](#scanner-the-betterleaks-binary). |
| nvm with Node 24 | Not verified here; nvm is a shell version manager, not a native bottle | Optional per-user alternative to Homebrew Node; initialize nvm in `~/.zshrc`. |
| Xcode Command Line Tools | Not verified here; Apple supplies the toolchain, not a Homebrew bottle | Compile native addons when needed. |
| Pi and the npm modules | Not verified on arm64; npm packages, not Homebrew bottles | Install only the modules that you want. |

## Prerequisites

Follow [the prerequisites](../../INSTALL.md#prerequisites) with the adaptations below.

Warning: installation commands change the machine. Review each command before running it.

### Node and Python

Select Homebrew Node 24, Git and Python:

```sh
brew install git python@3.12 node@24
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:$PATH"
node --version
python3 --version
file "$(command -v node)"
node -p 'process.arch'
```

Use Homebrew's installation instructions first if `brew` is missing.
The Python path makes `python3` select this formula rather than the system Python.
Node must report a 24.x version. The `file` output should show `arm64`; `process.arch` must print `arm64`.
If `file` reports a symbolic link, inspect its target with `file -L "$(command -v node)"`.
Stop on `x86_64` or `x64`; correct the terminal and tool paths rather than adding Rosetta.
`node@24` is keg-only, so its explicit `PATH` line matters.
The export changes this zsh only. Review adding the export line to `~/.zshrc` yourself.

Alternatively, use a per-user nvm installation instead of Homebrew Node. For a home that has no nvm:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | PROFILE=/dev/null bash
. "$HOME/.nvm/nvm.sh"
nvm install 24 && nvm use 24
```

The first line installs nvm `v0.40.8` into `~/.nvm`. Before you run it, read the release page <https://github.com/nvm-sh/nvm/releases/tag/v0.40.8> and the script at the URL of the first line. The kit gives no checksum for the script.
When `nvm` is already a command in your zsh, run the third line only.

The kit never edits a shell startup file. Make one of two choices:

- Option one: run the first line without `PROFILE=/dev/null`. The nvm install script then adds the nvm lines to `~/.zshrc`, never `~/.bashrc`. Run `touch ~/.zshrc` first when the file is absent. Run `exec zsh` after the install to reload the file.
- Option two: keep `PROFILE=/dev/null`. The script prints `Profile not found` and edits no file. Run `. "$HOME/.nvm/nvm.sh"` in each zsh that runs a kit command or starts Pi.

Repeat the Node version and architecture checks after selecting it.
Not verified: this nvm route on macOS with the kit.

### Pi

Install Pi with the line of [the prerequisites](../../INSTALL.md#prerequisites), from the kit root `"$HOME/tenant-pi"`.

Warning: a global install replaces the `pi` command for every profile of the user.

Use the user-owned prefix of INSTALL.md if the global prefix is not writable or replacement is not wanted.
Do not run npm with `sudo` to work around that check.
Then run `python3 scripts/check_runtime.py`.

### Pi-Bolt

[Pi-Bolt](../../INSTALL.md#pi-bolt-an-alternative-runtime) has a build for Apple silicon and macOS 13 or later. Run its install line in zsh. The installer links `pi-bolt` into `~/.local/bin`. When that directory is not on `PATH`, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and run `exec zsh`. Then run `python3 scripts/check_runtime.py --pi "$(command -v pi-bolt)"`.

In the macOS build, `pi` is a small launcher that starts `pi-bin` beside its real path. The launcher of `install.sh --runtime pi-bolt` starts that `pi` through its real path. Herdr 0.9.5 detects the agent from the process name, and on macOS that name can be `pi-bin`. Not verified: Herdr detects a Pi-Bolt pane on macOS as `pi`. A file downloaded with a browser can carry a quarantine attribute; see the Pi-Bolt troubleshooting page. Not verified: Pi-Bolt with the kit on macOS.

## Clone and install.sh

Follow [the clone](../../INSTALL.md#clone) and [install.sh](../../INSTALL.md#run-installsh) unchanged.
`install.sh` is a POSIX `sh` script; macOS runs it with its `/bin/sh`.
It resolves `/tmp` and `/var` links on its own, so a profile under `/tmp` is checked in its `/private/...` form.

## Optional modules

Follow [the optional modules](../../INSTALL.md#optional-modules) unchanged. Run only the lines of the modules that you want.

Do not run the `computer-use` line on macOS. Its package supports Linux only. `install.sh --with computer-use` stops on macOS before its first write. The computer-use module for macOS is `computer-use-macos`. Read [computer use on macOS](modules.md#computer-use-on-macos) first: screenshots, accessibility text and typed text go to the model provider, and the module is not verified on a Mac, and Cua Driver sends telemetry by default. Install it into an existing profile, in zsh:

```zsh
./install.sh --upgrade main --shell zsh --with computer-use-macos
```

The install asks for no macOS grant. At the first desktop tool call, macOS asks you to grant Accessibility and Screen Recording to `CuaDriver.app`.

For OpenKnowledge, install the `okknow` module into an existing profile. Set the origin of your own OpenKnowledge server and the two credential variables in `~/.zshrc` first, then start a new shell:

```sh
export OKKNOW_ORIGIN='https://ok.example.com'
export OPENKNOWLEDGE_USERNAME='<user>'
export OPENKNOWLEDGE_PASSWORD='<password>'
```

```sh
./install.sh --upgrade <profile> --with okknow
```

Add `mcp` to `--with` (`--with mcp,okknow`) for the MCP server `okknow` of the profile. The installer links `~/.local/bin/okknow` and runs `okknow setup`, which probes the origin and writes `~/.config/okknow/config.json`. Without `OKKNOW_ORIGIN`, the wizard asks for the origin in the terminal. Then run `okknow doctor`; its last line must be `doctor: PASS`. See [okknow](modules.md#okknow). Not verified on macOS: the install, the wizard and the CLI.

The packages `pi-hermes-memory` and `wiki` use the native module `better-sqlite3`. Observed with `better-sqlite3` 13.0.3 and npm 11.19.0 on Linux x64: the package holds prebuilt binaries for `darwin-arm64`, `darwin-x64`, Linux and Windows. It has no install script, so npm compiles nothing. The binaries use Node-API, so one binary loads in Node 24 (`NODE_MODULE_VERSION` 137) and in the Node 26 of Pi-Bolt 1.0.4 to 1.0.6 (147). Not verified on macOS: the `darwin-arm64` binary loads.

The `wiki` package indexes and searches with `@tobilu/qmd`. Under Pi-Bolt, which runs on Bun, qmd opens SQLite with `bun:sqlite` and not with `better-sqlite3`. Observed on Linux x64: that SQLite loads the vector extension `sqlite-vec`. The qmd source states: on macOS, `bun:sqlite` uses the SQLite of the system, and that build cannot load an extension. qmd then looks for a Homebrew SQLite at `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` or `/usr/local/opt/sqlite/lib/libsqlite3.dylib`. Without it, wiki vector search fails with `sqlite-vec extension is unavailable`; keyword search still works. With `--runtime pi-bolt --with wiki`, `install.sh` prints a note when neither file exists. For a Pi-Bolt profile with `wiki`, install Homebrew SQLite:

```sh
brew install sqlite
```

Not verified on macOS: Pi-Bolt loads `sqlite-vec` through that SQLite. The `pi` runtime with Node 24 uses `better-sqlite3` and needs no Homebrew SQLite.

Only when no prebuilt binary fits the platform, a build from source needs a compiler toolchain. With npm 11, npm does not start that build on its own. For a build from source, install the Apple toolchain when absent:

```sh
xcode-select --install
```

Not verified: the native addon build with this toolchain and Node 24 on macOS.

Warning: do not run `npm audit fix` in the profile.

### Scanner: the Betterleaks binary

The scan hook uses [scripts/scan.sh](../../scripts/scan.sh); see [secret handling](../secret-handling.md#scanner).
The script runs only the Betterleaks binary at the version that it pins.
The scan starts no container and no virtual machine.

Choose one of two routes: the release archive or the Homebrew cask. Run each step in zsh.

#### Route 1: the release archive

Follow [Install Betterleaks](../secret-handling.md#install-betterleaks) with its macOS differences: the `darwin_arm64` archive, `shasum -a 256 -c` and no check of the extracted binary. Then use these differences in zsh:

- Install the binary into a directory of your own: `mkdir -p "$HOME/.local/bin"`, then `install -m 755 betterleaks "$HOME/.local/bin/betterleaks"`.
- Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`, and run `exec zsh`. Then `command -v betterleaks` must print the path of the binary.

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

The command must end with exit code 0. Exit code 2 shows a missing binary or another version.
Keep `PATH` or `BETTERLEAKS_BIN` in the zsh that runs Git hooks. In kitty on macOS, this is the zsh of the window.
Not verified: a complete scan-hook run on macOS.
A failure leaves the scan `blocked`; do not skip the hook.

## First start

Follow [the first start](../../INSTALL.md#first-start) unchanged:

```sh
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi
```

Export a gateway key in the same zsh that starts Pi. In kitty on macOS, this is the zsh of the window.
An app started from Finder or the Dock does not see the variables of `~/.zshrc`; start Pi from a terminal.
To keep the start line, add an alias line to `~/.zshrc` yourself.

## Test

Follow the check of [the first start](../../INSTALL.md#first-start), including the explicit model choice.
Record checks as passed, failed, blocked or not run. A skipped command is not evidence.
Not verified: a complete macOS run of these steps.

## Evidence that would change the status

The [release checklist](release-checklist.md#platforms-that-are-not-qualified) requires Gate 6 on a clean macOS user with Homebrew or nvm Node.
It also requires the tests and publish check on that machine.
Record exact commands, versions, and each check as passed, failed, blocked or not run.
Record the model reply separately.
The release maintainer must accept the record before macOS changes from **Not qualified**.
Bottle listings and this documentation review do not change that status.
