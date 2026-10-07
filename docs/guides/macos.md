# macOS guide for Apple silicon

Scope: Apple silicon (arm64). macOS stays **Not qualified**.
This is an adaptation of [the setup guide](setup.md), not a second procedure.
Follow its nine stages in order. Use the differences here at the named stage.

No live stage or module is `ready`. Use the setup labels:

| Label | Meaning here |
| --- | --- |
| `unverified` | The instructions have no accepted live macOS trial. |
| `blocked` | A required tool, version or service is missing. |
| `skipped` | You did not select the module or run the step. |

An offline check that passes is recorded as passed, not as platform qualification.

## Before you start

macOS uses zsh as its login shell; put all PATH and variable lines in `~/.zshrc`; reload with `exec zsh`.

Read [setup: Before you start](setup.md#before-you-start), including the live-profile and environment checks.
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
| [podman](https://formulae.brew.sh/formula/podman) | Native arm64 bottles: macOS 15 (Sequoia), 26 (Tahoe); none for 14 (Sonoma) | Recommended container runtime. |
| [gitleaks](https://formulae.brew.sh/api/formula/gitleaks.json) | Native arm64 bottles: macOS 14 (Sonoma), 15 (Sequoia), 26 (Tahoe); current formula, not the required v8.28.0 | Homebrew binary cannot pass the scan version check. |
| [colima](https://formulae.brew.sh/formula/colima) | Native arm64 bottles: macOS 14 (Sonoma), 15 (Sequoia), 26 (Tahoe); kit use not verified | Potential alternative only. |
| nvm with Node 24 | Not verified here; nvm is a shell version manager, not a native bottle | Optional per-user alternative to Homebrew Node; initialize nvm in `~/.zshrc`. |
| Xcode Command Line Tools | Not verified here; Apple supplies the toolchain, not a Homebrew bottle | Compile native addons when needed. |
| Pi and the selected npm packages from setup Stage 6 | Not verified on arm64; npm packages, not Homebrew bottles | Install only the selected modules. |

## Stage 1: obtain the sources

Follow [setup Stage 1](setup.md#stage-1-obtain-the-sources) without changing its checks.
If Git or Python is missing, install only those bootstrap tools first:

```sh
brew install git python@3.12
export PATH="/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:$PATH"
python3 --version
git --version
```

The Python path makes `python3` select this formula rather than the system Python.
Use Homebrew's installation instructions first if `brew` is missing.
Keep the Node, Pi and module installations in Stage 6.

## Stage 2: edit the local choices

Follow [setup Stage 2](setup.md#stage-2-edit-the-local-choices), including `init-private` and the absent target requirement.
Its `"$HOME/..."` commands also apply on macOS.
For a manual JSON edit, use your expanded macOS home path instead of the `/home/EXAMPLE_USER` example.
Keep the target outside the kit, the private directory and the live profile.

## Stage 3: validate

Run [setup Stage 3](setup.md#stage-3-validate) unchanged. Stop on a validation error.

## Stage 4: plan

Run [setup Stage 4](setup.md#stage-4-plan) unchanged, including the runtime report and the launcher path.
Read each readiness gap. A version match does not prove a macOS launch.

## Stage 5: generate

Run [setup Stage 5](setup.md#stage-5-generate) unchanged.
Keep `--launcher "$HOME/.config/tenant-pi/launch-main.sh"` and the separate target.
The generated runtime stays `unverified`.

## Stage 6: install the dependencies by hand

Follow [setup Stage 6](setup.md#stage-6-install-the-dependencies-by-hand).
The kit installs nothing. Run only the commands for the modules you select.

Warning: installation commands change the machine. Review each command before running it.

### Node and Python

Git and Python may already be present from Stage 1. Select Homebrew Node 24:

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

Keep the Pi decision rules of [setup Stage 6: Pi](setup.md#pi).
Skip installation for `match` or `untested_in_range`; record the untested-version gap.
For `missing`, check the npm prefix first. For `mismatch` or `unparsed`, make the setup guide's explicit decision.

```sh
# Run from the kit root, only after the install decision.
cd "$HOME/tenant-pi"
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Warning: a global install replaces the `pi` command for every profile of the user.

Use the setup guide's user-owned prefix alternative if the global prefix is not writable or replacement is not wanted.
Do not run npm with `sudo` to work around that check.

Only for an enabled Tenantext component:

```sh
cd "$HOME/tenant-pi/packages/tenantext" && npm ci --ignore-scripts
```

Only for `promptr`:

```sh
cd "$HOME/tenant-pi/packages/promptr" && npm ci --ignore-scripts && npm run build
```

Hermes builds `better-sqlite3`. If a native addon needs compilation, install the Apple toolchain when absent:

```sh
xcode-select --install
```

Not verified: the native addon build with this toolchain and Node 24 on macOS.

Before the first Pi command that names the target, record the [setup Stage 8 baseline](setup.md#stage-8-launch).
Run from the kit root:

```sh
cd "$HOME/tenant-pi"
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

Keep the extra baselines for inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` as setup specifies.
Do not replace an existing baseline or record it after a target Pi command.

Only for `mcp`, `hermes`, `wiki` or `questions`:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi update --extensions
```

Only for `hermes`, `wiki` or `questions`, also:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

Keep the setup guide's declared-package version caveats and compare the profile after native Pi operations.
Regenerate the runtime report and run `plan` again after changing Node or Pi.
The runtime stays `unverified`. A dependency step that you omit is `skipped`.

### Scanner: recommended Podman container path

Use the pinned Podman container path for scanning; the Homebrew gitleaks binary cannot pass the script's version check.
The scan hook uses [scripts/scan.sh](../../scripts/scan.sh); see [secret handling](../secret-handling.md#scanner).
Verified by reading that script: `SCAN_ENGINE` accepts only `auto`, `docker` and `binary`, not `podman`.
With `auto`, it first tests an executable named `docker` with `docker info`.
A working engine needs the pinned image already present; a missing image stops the scan without a binary fallback.
If no working `docker` exists, `auto` tries the `gitleaks` binary.

Podman is the recommended replacement for Docker Desktop.
On macOS, it runs Linux containers in a virtual machine.
The [init command](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html) creates it;
the [start command](https://docs.podman.io/en/latest/markdown/podman-machine-start.1.html) starts it.

```sh
brew install podman
podman machine init
podman machine start
podman info
```

Run `init` once for a new machine. For an existing machine, check `podman machine list` before starting it.

The gitleaks image runs as a Linux container under Podman, not as a macOS executable.
The scan script still calls `docker`. An interactive `alias docker=podman` does not reach its separate shell or Git hooks.
Use a private executable symlink instead. After Stage 2 creates the private directory:

```sh
mkdir "$HOME/.config/tenant-pi/podman-bin"
ln -s "$(command -v podman)" "$HOME/.config/tenant-pi/podman-bin/docker"
export PATH="$HOME/.config/tenant-pi/podman-bin:$PATH"
export SCAN_ENGINE=docker
mkdir -p "$HOME/.config/tenant-pi/scan-tmp"
export TMPDIR="$HOME/.config/tenant-pi/scan-tmp"
docker info
```

Warning: this `PATH` makes `docker` invoke Podman for every command in the current zsh.
Warning: the `TMPDIR` export changes the temporary-directory setting for every command in the current zsh, not only the scan.

Review adding the `PATH`, `SCAN_ENGINE` and `TMPDIR` export lines to `~/.zshrc` yourself.

Do not overwrite an existing compatibility directory. Inspect it instead.
The repository, Git directory and scan temporary directory must be shared into the VM at the same absolute paths.
Using the home directory avoids relying on macOS temporary-directory sharing defaults.
Not verified: these mounts with the selected Podman machine provider.

Pull the pinned image explicitly before scanning. The scan itself never pulls and uses no container network:

```sh
image='docker.io/zricethezav/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854'
podman pull "$image"
docker image inspect zricethezav/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854
podman run --rm --network none "$image" version
cd "$HOME/tenant-pi"
scripts/scan.sh --level fail tree
```

The registry prefix makes the pull explicit; the script uses the same pinned image without that prefix.
The `docker image inspect` command checks the exact short name that the scan script inspects.
Not verified: Podman resolves the short name.
Stop if that inspection fails; the scan cannot use an image it cannot find.
Keep the compatibility `PATH`, `SCAN_ENGINE` and `TMPDIR` in the shell that runs Git hooks.
In kitty on macOS, this is the zsh of the window.
Not verified: the pinned image's arm64 execution, Podman command compatibility and complete scan-hook run on macOS.
A failure leaves the scan `blocked`; do not skip the hook or add emulation as an assumed fix.

### Scanner: direct binary path is unverified

`SCAN_ENGINE=binary` requires the exact output `v8.28.0` from `gitleaks version`, including the leading `v`.
The Homebrew formula sets its version string to `8.30.1`, without a leading `v`.
Thus `SCAN_ENGINE=binary` with Homebrew cannot pass this check.
`brew pin gitleaks` prevents upgrades; it does not install an older release or change the version string.

For native darwin arm64, only the upstream v8.28.0 release binary can match the required pin.
Look for `gitleaks_8.28.0_darwin_arm64.tar.gz` in the [gitleaks v8.28.0 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.28.0).
Not verified: that release asset name.
Not verified: the upstream binary prints `v8.28.0`.
Check the installed upstream binary before selecting this path:

```sh
gitleaks version
```

If the output differs from `v8.28.0`, this route is `blocked`; use the pinned container path instead.
Do not change the scan pin to make an installed binary pass.
Only with that exact output and the matching binary on `PATH`, run:

```sh
SCAN_ENGINE=binary scripts/scan.sh --level fail tree
```

Not verified: an exact-pin arm64 binary installation and a live macOS scan.

### Colima: potential alternative only

[Colima](https://github.com/abiosoft/colima) manages a Lima Linux VM and can expose a Docker-compatible socket with its Docker runtime.
It is a potential alternative, not a recommendation. Its Homebrew installation line is:

```sh
brew install colima
```

Not verified: Colima startup, client and socket configuration, image architecture, volume mounts or scan hooks with this kit.
Test those before choosing it. Installing Colima alone does not configure the scanner.

## Stage 7: authenticate

Follow [setup Stage 7](setup.md#stage-7-authenticate) unchanged.
Keep credentials out of the overlay. Check variable names in the same shell that runs the launcher.
In kitty on macOS, this is the zsh of the window.
Label: `skipped` until you run this stage.

## Stage 8: launch

Follow [setup Stage 8](setup.md#stage-8-launch), including every baseline not already recorded before dependency installation.
Keep the generated launcher file unchanged:

```sh
"$HOME/.config/tenant-pi/launch-main.sh"
```

It selects `PI_CODING_AGENT_DIR` for one process and removes the inherited session directory.
Do not replace it with a bare `pi` command.

## Stage 9: test

Follow [setup Stage 9](setup.md#stage-9-test), including the explicit model choice and each baseline comparison.
Record checks as passed, failed, blocked or not run. A skipped command is not evidence.
Not verified: a complete macOS run of these stages.

## Evidence that would change the status

The [release checklist](release-checklist.md#platforms-that-are-not-qualified) requires Gate 6 on a clean macOS user with Homebrew or nvm Node.
It also requires the tests and publish check on that machine.
Record exact commands, versions, and each check as passed, failed, blocked or not run.
Record the model reply separately and keep the live-profile baseline comparison.
The release maintainer must accept the record before macOS changes from **Not qualified**.
Bottle listings and this documentation review do not change that status.
