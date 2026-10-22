# tenant-pi

tenant-pi is a kit for a Pi profile. `install.sh` writes a settings template and a models template into a profile directory of your own, and Pi loads `packages/tenantext` of the clone as a local package. An update is `git pull` and `/reload` in Pi. The kit never writes into `~/.pi/agent` and stores no credential.

Status: portable release candidate. Linux is the first target. The offline stages are tested. Not verified: a complete live run on a clean client, with authentication and a model reply. No optional module is `ready` in this release. macOS, Windows, browser-hosted Pi and Pi inside Herdr are not qualified; see [the release checklist](docs/guides/release-checklist.md#platforms-that-are-not-qualified). See [the module guide](docs/guides/modules.md#status-labels) for the labels.

The published copy of the kit is a snapshot mirror: the maintainer updates it with a reviewed snapshot of the kit. The published copy takes no issues. Each snapshot has a tag of the form `portable/<yyyymmdd>-<source sha>`. A tag can have a release entry: the release page of the tag on the publication service. The release entry holds [the release notes](docs/guides/release-checklist.md#release-notes) of that snapshot: the result of each gate of the release checklist and the open gaps. A tag with no release entry has no release notes.

Promptr and slopscore were removed on 2026-10-21. Their last state is in the tag `kit-legacy/20261021`. Restore with `git checkout kit-legacy/20261021 -- packages/promptr`.

The profile generator, the private overlay and the candidate lifecycle were removed on 2026-10-22. Their last state is in the tag `kit-legacy/20261022`.

## Install

[INSTALL.md](INSTALL.md) is the install path: the prerequisites, the clone, `install.sh`, the optional `pi install` lines and the first start.

```sh
git clone <kit repository URL> ~/tenant-pi && cd ~/tenant-pi
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" ./install.sh
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi
```

## Guides

| Guide | For |
| --- | --- |
| [Install](INSTALL.md) | The install stages with exact commands. Start here. |
| [macOS on Apple silicon](docs/guides/macos.md) | Homebrew arm64 and Betterleaks binary adaptations; macOS stays not qualified. |
| [Architecture](docs/architecture.md) | The installed environment: terminal, selected Pi profile, runtime modules, state and optional services. Build `docs/architecture.html` with `python3 scripts/architecture_build.py`, then open it from disk. |
| [Providers](docs/guides/providers.md) | Codex login, and llama-swap and vLLM as direct providers in `models.json` of the profile. |
| [Modules](docs/guides/modules.md) | Each component: source, credentials, state and status. |
| [Update](UPDATE.md) | Pull the changes, `/reload` in Pi, run the checks; where the Pi version lives and how to move it. |
| [After the install](POST_INSTALL.md) | The commands for each change after the install: a module, the npm modules, the model, a second profile. |
| [Pi update checks](docs/pi-update.md) | Detect npm releases, read breaking changes, move the pin and qualify a Pi version in isolation. |
| [Continuous integration](docs/publishing.md#continuous-integration) | GitHub offline checks of the published snapshot. |
| [Privacy](docs/guides/privacy.md) | What the kit separates, what it never does, what the scanner checks. |
| [Troubleshooting](docs/guides/troubleshooting.md) | Each diagnostic and its fix. |
| [Release checklist](docs/guides/release-checklist.md) | The gates and steps of a portable release, also after a pin move. |

An agent that installs the kit for a user reads [INSTALL.md](INSTALL.md) and `skills/tenant-pi-install/SKILL.md`. The skill is a short question list that points to the install steps.

## The scripts

| Script | What it is for | Reference |
| --- | --- | --- |
| `install.sh` | Writes the absent templates into the profile of `PI_CODING_AGENT_DIR` and links the Claude Code skills. | [INSTALL.md](INSTALL.md#run-installsh) |
| `scripts/check_runtime.py` | Compares the installed Pi, Node and Python with the pins. | [INSTALL.md](INSTALL.md#prerequisites) |
| `scripts/pi_update.py` | Detects new Pi releases, qualifies one in isolation, reads its notes and moves the pin. | [Pi update checks](docs/pi-update.md) |
| `scripts/check.py` | Runs the offline checks of the kit. | [Update](UPDATE.md#checks) |

The Python scripts of the table print their options with `--help`. `python3 scripts/doc_check.py` checks the links, the JSON examples and the environment names of the published documents. The unit tests run the same check. See [the documentation check](docs/guides/troubleshooting.md#the-documentation-check-fails).

## Reference documents

- [Memory modules](docs/memory-modules.md), [providers](docs/guides/providers.md) and [in-tree packages](docs/packages.md).
- [Host peer overrides](docs/host-peer-overrides.md), [secret handling](docs/secret-handling.md) and [publishing](docs/publishing.md).

The kit uses the MIT license in [LICENSE](LICENSE).

## Facts about this release

- `config/manifest.json` holds the Pi pin, the accepted Pi range and the source of each module. `scripts/validate.py` checks it offline.
- The core install is `packages/tenantext` and the question extension at an exact version. The models template has no provider: a provider in `models.json` needs a literal base URL.
- Each optional module is one `pi install` line of [the optional modules](INSTALL.md#optional-modules). Nothing is captured until you install a memory module.
- No pi-subagents module exists. Agent fan-out uses the Herdr skill of `packages/tenantext`. The Herdr application is a host tool that the kit does not install.
- `packages/` holds the in-tree packages. See [the in-tree packages](docs/packages.md).
- A source pin does not prove that a clean client can use a module.
- `scripts/publish_portable.py` publishes the reviewed publish set as a portable snapshot branch.

Pi warns about extension packages that list host-provided modules under `dependencies`. `scripts/patch_extension_peers.mjs` corrects the installed manifests. See [host peer overrides](docs/host-peer-overrides.md) for the packages and for how to reapply it after each extension update.

Warning: `.local/` may contain private client state. Its Git ignore rule is not a security or publication control.
