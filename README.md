# tenant-pi

tenant-pi is a guided kit for a Pi profile. You write your choices into a private JSON overlay. The kit checks them offline and generates a new, separate Pi profile directory. It never edits an existing profile, installs nothing, and stores no credential.

Status: portable release candidate. Linux is the first target. The offline stages are tested. Not verified: a complete live run on a clean client, with authentication and a model reply. No optional module is `ready` in this release. macOS, Windows, browser-hosted Pi and Pi inside Herdr are not qualified; see [the release checklist](docs/guides/release-checklist.md#platforms-that-are-not-qualified). See [the module guide](docs/guides/modules.md#status-labels) for the labels.

## The stages

1. Obtain the sources: clone the kit and run its offline checks.
2. Edit the local choices: create the private directory and edit the overlay.
3. Validate: `python3 scripts/tenant_pi.py validate`.
4. Plan: `python3 scripts/tenant_pi.py plan`.
5. Generate: `python3 scripts/tenant_pi.py generate` into a new, absent target.
6. Install the dependencies by hand: Node 24 (`>=24.0.0 <25`), Pi and the packages of the enabled modules.
7. Authenticate: Pi `/login`, or a key in the launching shell.
8. Launch: run the launcher file or the plan launch line.
9. Test: record each check as passed, failed, blocked or not run.

The kit runs stages 1 to 5. Stages 6 to 9 are yours, and the kit runs none of their commands. The plan prints the Pi install line, the `pi update --extensions` and peer-override lines of the enabled npm modules, and the launch line as display text. The Node and Python installs and the `npm ci` of the in-tree packages are in [the setup guide](docs/guides/setup.md#stage-6-install-the-dependencies-by-hand) only.

## Guides

| Guide | For |
| --- | --- |
| [Setup](docs/guides/setup.md) | The nine stages with exact commands. Start here. |
| [macOS on Apple silicon](docs/guides/macos.md) | Homebrew arm64 and Podman adaptations; macOS stays not qualified. |
| [Compose seat](docs/guides/compose-seat.md) | A Pi profile in a container that you reach over SSH, with Docker Compose or Podman; not qualified. |
| [Explainer](EXPLAINER.md) | The installation explainer covers footprints, prerequisites, 15 steps with Drill-down tables, optional components, Mac differences, components, removal and maintenance. |
| [Providers](docs/guides/providers.md) | Codex login, and llama-swap and vLLM as direct providers in `models.json` of the profile. |
| [Modules](docs/guides/modules.md) | Each component: inputs, source, credentials, state, consent and status. |
| [Candidate update](docs/guides/candidate-update.md) | Regenerate, compare, carry choices, switch profiles. |
| [Pi update checks](docs/pi-update.md) | Detect npm releases, qualify an isolated candidate, and read breaking changes. |
| [Continuous integration](docs/ci.md) | Offline checks, scheduled Pi qualification, and update pull requests. |
| [Privacy](docs/guides/privacy.md) | What the kit separates, what it never does, what the scanner checks. |
| [Troubleshooting](docs/guides/troubleshooting.md) | Each diagnostic and its fix. |
| [Release checklist](docs/guides/release-checklist.md) | The gates and steps of a portable release. |
| [Pin move and release](docs/guides/pin-move-release.md) | Qualify a Pi pin, review the change, and publish a fast-track snapshot. |

An agent that installs a profile for a user reads [INSTALL.md](INSTALL.md) and `skills/tenant-pi-install/SKILL.md`. Both follow the same stages and ask before each change.

## The command line

`python3 scripts/tenant_pi.py --help` lists the actions. Each action has its own `--help`.

| Action | What it does | Reference |
| --- | --- | --- |
| `validate` | Offline check of the overlay. | [the CLI contract](docs/generator.md) |
| `plan` | Lists the files, readiness gaps and display-only commands. Writes nothing. | [the CLI contract](docs/generator.md) |
| `generate` | Writes a new profile into an absent target. With `--launcher`, also a launcher file. | [the CLI contract](docs/generator.md), [the launcher file](docs/launcher.md) |
| `init-private` | Creates the private directory from templates. | [the private directory](docs/private-directory.md) |
| `compare` | Redacted comparison of two profile directories. Read-only. | [candidate comparison](docs/candidate-compare.md) |
| `carry` | Prints overlay patches from a `compare` report. Writes nothing. | [carrying drift into the overlay](docs/carry.md) |
| `inventory` | Names-only list of the resources of one profile. Read-only. | [profile inventory](docs/profile-inventory.md) |
| `list` | Lists the candidates under one parent directory. Read-only. | [the candidate list](docs/candidate-list.md) |
| `check-runtime` | Compares the installed Pi, Node and Python with the pins. | [the runtime version check](docs/check-runtime.md) |
| `check-herdr` | Reports the `herdr` command of the host: present with its version, or missing. Installs nothing. | [Herdr and the question tool](docs/herdr-setup.md) |
| `remote-plan` | Prints the SSH command lines of the remote stages as data. Runs none of them. | [Herdr and the question tool](docs/herdr-setup.md#the-remote-plan) |
| `baseline` | Records the entry names, sizes and modification times of one directory in a new file. Opens no file of the directory. | [the directory baseline](docs/directory-baseline.md) |
| `check-baseline` | Compares one directory with its baseline: `unchanged`, `changed` or `no_baseline`. Writes nothing. | [the directory baseline](docs/directory-baseline.md) |

`python3 scripts/doc_check.py` checks the links, the JSON examples and the CLI names of the published documents. The unit tests run the same check, so it is not a separate release check. See [the release checklist](docs/guides/release-checklist.md#documentation-check).

## Reference documents

- [The profile lifecycle](docs/profile-lifecycle.md).
- [Memory modules](docs/memory-modules.md), [workflow modules](docs/workflow-modules.md), [model routes](docs/model-routes.md) and [in-tree packages](docs/packages.md).
- [Owner package paths](docs/owner-packages.md), [owner skill and prompt directories](docs/owner-resources.md) and [accepted drift](docs/accepted-drift.md).
- [Host peer overrides](docs/host-peer-overrides.md), [secret handling](docs/secret-handling.md) and [publishing](docs/publishing.md).

The kit uses the MIT license in [LICENSE](LICENSE).

## Facts about this release

- The Python 3.11+ offline validator checks versioned module sources and a local JSON overlay. Only synthetic examples are tracked.
- Core Pi is the only enabled example component. Model routes need an explicit offline registry file. The kit imports no host defaults.
- Optional memory is off by default. Hermes and LLM Wiki need selection, `consent.memoryCapture` and a `memory` block together. OpenViking needs `consent.remoteMemoryWrites` too, because it writes to a server.
- The MCP module uses `pi-mcp-adapter` with definitions from a private input file and disables the native Pi MCP. Promptr is `unverified` with a readiness matrix: it needs a build step, and no session with a model is verified.
- No pi-subagents module exists. Agent fan-out uses the Herdr skill of the `herdr` component. The Herdr application is a host tool that the kit does not install.
- The `questions` component declares the Pi question extension at an exact version. It is `unverified` and off by default. See [Herdr and the question tool](docs/herdr-setup.md).
- The two in-tree packages under `packages/` are optional. Each extension and each skill is one component of `config/manifest.json` with the source kind `tree`. `packages/tenantext` has eight extensions and three skills. `packages/promptr` has one extension and four skills.
- A source pin does not prove that a clean client can use a module.
- `scripts/publish_portable.py` publishes the reviewed publish set as a portable snapshot branch.
- No install, capture, update or live service command exists. `scripts/capture.py` and `scripts/install.py` stop at once with retirement messages.

Pi warns about extension packages that list host-provided modules under `dependencies`. The warning was observed on Pi 0.99.x. Not verified: the warning on the kit pin in `config/manifest.json`, key `runtime.piVersion`. `scripts/patch_extension_peers.mjs` corrects the installed manifests. See [host peer overrides](docs/host-peer-overrides.md) for the packages and for how to reapply it after each extension update.

Warning: `.local/` may contain private client state. Its Git ignore rule is not a security or publication control.
