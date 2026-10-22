# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one module of the kit. The core install of [install.sh](../../INSTALL.md#run-installsh) loads `core`, every component of `packages/tenantext` and the question extension. Each other module is one `pi install` line of [the optional modules](../../INSTALL.md#optional-modules).

The manifest is the state of this release. It is not a claim that a module works on a clean client.

## Status labels

The manifest has two statuses. This guide maps them to two labels.

| Label | Meaning | From |
| --- | --- | --- |
| `unverified` | The kit checks the module offline. No accepted live trial proves that it works in a Pi session. | Manifest status `tested` or `unverified`. |
| `ready` | The module passed an accepted live trial on the qualified platform. | No module has this label in this release. |

The manifest status `tested` means: the pin and the structure passed an offline review. It does not mean a clean-client trial. The manifest status `unverified` means: the entry names its `gaps`, the facts that no test proves. So both map to `unverified`.

## Components

Each entry of `components` in `config/manifest.json` holds the source and its pin, the `requires` IDs, the `env` names, the status, the gaps and the resources of one component. The folder of an in-tree component is the `source.path` of its entry under `packages/`, with the docs of the package. [The privacy guide](privacy.md) names the credentials and the requests of the components that send data.

Observed with Pi 1.1.0: the first launch downloaded `fd` and `ripgrep` into `<profile>/bin/`.

Rule from the Pi 1.1.0 source: Pi checks each tool in `<profile>/bin/` first, then on the `PATH`. It checks `fd` locally and `fd` or `fdfind` on the `PATH`. For `ripgrep`, it checks `rg` in both places. At the start of an interactive session, Pi downloads only a missing tool. If both tools are available, Pi downloads neither. With both on the `PATH`, Pi creates no `bin/` in a new profile. The download needs network access. Without network access, Pi warns that the download failed and continues. With offline mode enabled, Pi warns and skips the download.

"Source reading" means a fact read in the source code of the package, not seen at run time.

Facts that hold for every component:

- An in-tree (`tree`) module points at the package directory of the clone by its path. Keep the clone in place.
- `copilot-usage`, `anthropic-usage` and `doctor` read login files, environment tokens and the `gh` login of the account. When a login exists, they send its token to the usage endpoint of the provider (source reading). Switch them off with `/resources` when you do not agree to that.
- `herdr-relay` needs the herdr skill at `~/.agents/skills/herdr`, or the folder in `HERDR_SKILL_HOME`.

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [providers](providers.md).

## The Tenantext path

The Tenantext path is the components of `packages/tenantext`, with or without the gateway route.

| Item | Requirement | Source |
| --- | --- | --- |
| Pi | `<pin>`. Each component keeps the gap `pi_line_unqualified`. | `config/manifest.json`, `packages/tenantext/README.md` |
| Node | The `engines` range of the package | `packages/tenantext/package.json`; the kit range is `runtime.nodeRange` in `config/manifest.json` |
| Source | `packages/tenantext` in the kit clone | [in-tree packages](../packages.md) |
| Gateway | `TENANTEXT_LITELLM_BASE_URL` with the `/v1` URL and `TENANTEXT_LITELLM_API_KEY`, exported in the shell that starts Pi | [the first start](../../INSTALL.md#first-start) |

The native terminal interface stays. Pi loads each Tenantext component as a normal extension or skill through one `packages` entry of the profile settings. The kit installs no wrapper program, no other interface and no copy of the extensions.

With both gateway names set, the `codex-accounts` extension registers the provider `litellm-codex`; `packages/tenantext/docs/codex-routing.md` names its models. Select one with `/model`. Not verified: a reply through a real gateway with a profile of this kit.

## Optional modules in short

- **Memory** (`hermes`, `wiki`, `openviking`, `agentcore`): each one stores or sends text of the sessions. Ask about storage and recall before you install one. Read [memory modules](../memory-modules.md) first. With `wiki`, read [an existing vault](../memory-modules.md#an-existing-vault): the profile uses an existing vault as it is.
- **MCP** (`mcp`): the adapter reads its server list from its own configuration file; see the README of `pi-mcp-adapter`. To use only the adapter, add `"-builtin:mcp"` to the `extensions` list of the profile settings. For the AWS MCP server and the AWS skills, see [Agent Toolkit for AWS](aws-agent-toolkit.md).
- **Own packages and directories**: add a Pi package that you maintain with `pi install <path>`, or a skills directory to the `skills` list of the profile settings.
- **Agent fan-out**: no subagents module exists. Use the Herdr skill of `packages/tenantext`. Pi inside Herdr is not qualified. The Herdr application is a host tool that the kit does not install. Read [Herdr and the question tool](../herdr-setup.md) first.
- **Questions** (`questions`): the Pi extension with the `ask_user_question` tool, in the core install. It needs an interactive session. Without it, a skill asks in plain text. It is not an extension for Claude Code.

## Change a selection

To switch a single extension or skill off or on, use `/resources` inside Pi. To remove an optional module, run `pi remove` with its source; see [POST_INSTALL.md](../../POST_INSTALL.md#add-or-remove-an-optional-module).
