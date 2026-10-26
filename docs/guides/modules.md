# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one module of the kit. The core install of [install.sh](../../INSTALL.md#run-installsh) loads `core`, every component of `packages/tenantext` and the question extension. Each other module is one `pi install` line of [the optional modules](../../INSTALL.md#optional-modules).

With [Pi-Bolt](../../INSTALL.md#pi-bolt-an-alternative-runtime) as the runtime, `pi-bolt install` installs a module the same way. Source reading of Pi-Bolt: it reads the shared `packages` list of the profile, and an optional `piBolt.packages` list adds or removes packages for Pi-Bolt only. The kit writes no `piBolt` key. Observed with Pi-Bolt 1.0.1: the module install of `install.sh` with `--runtime pi-bolt` added the question package to `packages`. Not verified: each other module in a Pi-Bolt session. Pi-Bolt runs an extension without a JIT by default, so a heavy extension can be slower than in Pi.

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
- `next-prompt` shows the next action of the final dummies report as faint text in the empty editor of a coordinator session. It makes no model call and no request; see [its document](../../packages/tenantext/docs/next-prompt.md).
  It needs DUMMIES on for Pi; see [DUMMIES](#dummies).
- `cross-session-recall` keeps each interactive input in one SQLite store of the user, shared by all Pi profiles of that user: `~/.pi/agent/cross-session-recall/history.sqlite3`, or the directory in `CROSS_SESSION_RECALL_DIR`. It seeds the Up/Down history of the editor and adds `/recall [query]` and `/recall-clear`. The inputs are clear text, readable by the user only; see [its document](../../packages/tenantext/docs/cross-session-recall.md).

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [providers](providers.md).

## DUMMIES

The `dummies` skill is installed with the kit and is off by default. `install.sh --dummies`, or a yes to its question, turns it on for the profile. After the profile step, the installer runs the script of the skill:

```sh
PI_CODING_AGENT_DIR=<profile> python3 <clone>/packages/tenantext/skills/coordinator-skills/dummies/scripts/state.py on --harness pi --autostart
```

- The state file `~/.config/dummies-skill/state.json` (in `XDG_CONFIG_HOME` when it is set) records on or off for each harness. Every Pi profile of the user shares it.
- The autostart block is a marked block in the instruction file of the profile: the first that exists of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD`, in the order of `state.py`. When none exists, the script creates `AGENTS.md`. It appends the block when the file has no block. Each new coordinator session reads the block and starts the report form.
- `state.py log off` turns off the entry on the page `DUMMIES` for both harnesses; the reports stay. `log on` (the default) turns it on again.
- A repeat install finds the block and changes neither file.
- The completion report shows the line of `state.py status` and the file that got the block.
- The installer never turns DUMMIES off and does not change the Claude Code state or `~/.claude/CLAUDE.md`. For Claude Code, run `state.py on --harness claude --autostart`. To turn DUMMIES off for Pi, run the same line with `off --harness pi`. It turns Pi off for every profile and removes the block from every profile that got one.

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
- **Computer use** (`computer-use`): control of the desktop on Linux. Ask about desktop control before you install it. Read [computer use](#computer-use) first.

## Computer use

The `computer-use` module is agent-sh `computer-use-linux` 0.7.27, the npm package `@agent-sh/computer-use-linux`. It is the current official computer-use module of tenant-pi for Linux. The computer-use module for macOS is not chosen yet. Its manifest status is `unverified`. The qualification of the kit installs the pinned spec without its install script and loads the extension and the skill in a profile of `install.sh`. No test of the kit runs a tool on a desktop; the manifest gaps name the open facts.

The package gives Pi native tools and a skill. The tools read the AT-SPI accessibility tree, take screenshots and list windows. They also send clicks, keys and text to the desktop of the user. Screenshots and accessibility trees that a tool returns go into the conversation, and so to the model provider.

The module needs these things:

- Linux on x64 or arm64. The `package.json` of the package sets `os` to `linux`, so npm refuses another platform.
- A graphical session with the AT-SPI accessibility bridge, and an input backend. The doctor tool of the package names each blocker. Its setup tools can turn on AT-SPI and install a GNOME Shell extension; they change the desktop settings of the user.
- The postinstall download. The script `npm/install.js` of the npm package downloads the release binaries of the same version from GitHub. It checks each binary against its published `.sha256` file. The install needs network access.

Without the downloaded binary, the extension looks for `COMPUTER_USE_LINUX_BIN`, then for `computer-use-linux` on `PATH` (source: the Pi setup reference of the package skill). To get the binary again, run `pi remove` with the same source, then the `computer-use` line again.

To install the module in a Pi profile:

1. Run `install.sh --with computer-use` (see [install.sh](../../INSTALL.md#run-installsh)), or the `computer-use` line of [the optional modules](../../INSTALL.md#optional-modules). Both use the exact version, so `pi update --extensions` does not move it. On a platform other than Linux, `install.sh` stops before its first write.
2. Type `/reload` in the Pi session. Pi loads the loader tool `computer_use_linux_tools`.
3. Run `/tenantext-doctor`. It reports the installed version against the kit pin, the binary, and the blockers and warnings of the doctor of the package. It changes no desktop setting.
4. Or ask the agent to load and call the doctor tool: `computer_use_linux_tools({ tools: ["doctor"] })`, then `computer_use_linux_doctor({})`. The `readiness` block of the reply names each blocker.

### Claude Code plugin

Claude Code uses the same package as a plugin, `computer-use-linux@computer-use-linux`. When `~/.claude` exists and the `claude` command is on `PATH`, `install.sh --with computer-use` offers the plugin after a separate yes:

- `--claude-plugin` on the command line is that yes. `--yes` does not give it.
- In a terminal without `--claude-plugin`, the installer asks one question before it changes the profile.
- Without a terminal and without `--claude-plugin`, the installer prints one line and installs no plugin.

With the yes, the installer runs the two commands of the README of the package:

```sh
claude plugin marketplace add agent-sh/computer-use-linux
claude plugin install computer-use-linux@computer-use-linux
```

When the marketplace exists from an earlier run, the add can fail. The installer then continues with the plugin install when `claude plugin marketplace list` names the marketplace.

Then it reads the plugin version from `claude plugin list --json` and compares it with the kit pin. It prints a difference; it does not hide one. A failed plugin step ends the installer with exit 1 after the profile and the alias are in place.

The kit does not pin the plugin version. Decision of this release:

- The marketplace gives its newest release, so a later install or update can give a version after the kit pin. The installer reports that difference.
- The plugin launcher downloads the release binaries of its own version into `~/.cache/computer-use-linux/plugin/` at the first start. It needs `curl` or `wget`.
- To run the binary of the kit pin from the plugin, set `COMPUTER_USE_LINUX_BIN`. Its value is the absolute path of that binary.
  - Set it in the environment that starts Claude Code. The plugin launcher then starts that binary and downloads nothing (source reading of the launcher of version 0.7.24).
  - The binary of a Pi profile is `<profile>/npm/node_modules/@agent-sh/computer-use-linux/npm/bin/computer-use-linux-linux-<arch>`. `<arch>` is `x64` or `arm64`.
  - The skill text of the plugin still comes from the plugin version.
  - The Pi extension reads the same variable first. Pi panes started from that environment use the same binary.
- Not verified: a marketplace source fixed to a release tag. The kit does not use one.

Start a new Claude Code session after the install. Each new session then has the desktop tools.

### Herdr panes

Each new Pi pane of a profile with the module, and each new Claude Code pane with the plugin, has the desktop tools. The Herdr skill removes them from the read roles: `spawn.py` starts a `researcher`, `scout` or `reviewer` pane without them. A `coordinator` or `worker` pane keeps them. A read role does not need to act on the desktop, and the screen content of a desktop tool goes to the model provider. [Start an agent](../../packages/tenantext/skills/herdr/SPAWN.md) gives the options and the way to keep the tools for one task.

### A new version

The pin moves in three places: the manifest spec, the line of each Pi profile, and the Claude Code plugin. `pi update --extensions` does not move the exact spec of a profile line. [The computer-use version](../../UPDATE.md#the-computer-use-version) gives the steps.

## Claude Code

The Pi profile is the reference. The Claude Code form of the kit carries each component that has a Claude Code form, and nothing else.

| Component | Claude Code form | Source of the form |
| --- | --- | --- |
| `tenantext` | The `SessionStart` hook of the Simplified English rules, and `/ste` | The `tenantext` plugin |
| `herdr` | The skill, and `/spawn_agent` | The skill: a link of `install.sh`, or the plugin. The command: the plugin |
| `herdr-relay`, `coordinator-skills`, `knowledge-skills`, `tracker-site` | The skills | The links of `install.sh`, or the plugin |
| `agentcore` | The plugin `packages/agentcore-claude` | `claude --plugin-dir`; see [in-tree packages](../packages.md) |
| `computer-use` | The plugin of the package | [The Claude Code plugin](#claude-code-plugin) |

The skill links of `install.sh` are the default form of the kit skills. A pull of the kit updates them at once.
The `tenantext` plugin is for the `SessionStart` hook, `/ste` and `/spawn_agent`.
When you have the links, skip the skill build of the plugin: with both forms, Claude Code lists each skill twice, as `<name>` and as `tenantext:<name>`.
The plugin skills are for a host that does not keep the kit clone, because the links point into the clone.
[The package README](../../packages/tenantext/README.md#claude-code-plugin) gives the build and the install of the plugin.

The Claude Code form has these gaps today:

- `ops-footer`, `context-meter`, `codex-accounts`, `copilot-usage` and `anthropic-usage` have no Claude Code form in the kit. A Claude Code status line could show them.
- `agentcore` is not in the marketplace file. Its plugin `packages/agentcore-claude` loads in place with `claude --plugin-dir`.

The other components have no Claude Code form in the kit:

- Claude Code has its own model selection, MCP client and question tool: `model-routing`, `mcp` and `questions`.
- `doctor`, `resources` and `herdr-watch` act on the Pi profile or on Pi sessions.
- `hermes`, `wiki` and `openviking` are Pi packages. The kit has no Claude Code form of them.

## Change a selection

To switch a single extension or skill off or on, use `/resources` inside Pi. To remove an optional module, run `pi remove` with its source; see [POST_INSTALL.md](../../POST_INSTALL.md#add-or-remove-an-optional-module).
