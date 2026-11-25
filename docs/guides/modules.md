# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one module of the kit. The core install of [install.sh](../../INSTALL.md#run-installsh) loads `core`, every component of `packages/tenantext` and the question extension. Each other module is one `pi install` line of [the optional modules](../../INSTALL.md#optional-modules). In a terminal, `install.sh` shows each module on [one screen](../../INSTALL.md#choose-on-one-screen), with its state, its plan and the effect of on and off.

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
- `next-prompt` shows the next action of the final dummies report as faint text in the empty editor of a coordinator session. It makes no model call and no request; see [its document](../../packages/tenantext/docs/next-prompt.md).
  It needs DUMMIES on for Pi; see [DUMMIES](#dummies).
- `command-rules` blocks a shell command that matches a deny rule. The first rule denies `find / *` and sends the agent to `rg`. In Pi and Claude Code, it denies `credsync allow` as the command to run, not a mention in an argument. It accepts executable paths, leading assignments, and one `sudo` or `env` prefix with options and assignments. Only the owner approves projects, in an owner terminal. With the same prefixes, it denies the AWS CLI read of a Secrets Manager secret value (`secretsmanager` with `get-secret-value` or `batch-get-secret-value`), also with global options before the service or the operation. The rule is in each profile, with or without an AWS row: the rule table cannot depend on a module. It makes no model call and no request.
- `cross-session-recall` keeps each interactive input in one SQLite store of the user, shared by all Pi profiles of that user: `~/.local/share/tenant-pi/cross-session-recall/history.sqlite3` (or below `$XDG_DATA_HOME`), or the directory in `CROSS_SESSION_RECALL_DIR`. It copies the inputs of an old store in `~/.pi/agent/cross-session-recall` one time and leaves that directory unchanged. It seeds the Up/Down history of the editor and adds `/recall [query]` and `/recall-clear`. The inputs are clear text, readable by the user only; see [its document](../../packages/tenantext/docs/cross-session-recall.md).

Warning: the command guard is not a security boundary. A root agent with intent can bypass it through another spelling, a script file, quoted `bash -c`, or a direct write.

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [providers](providers.md).

## DUMMIES

The `dummies` skill is installed with the kit and is off by default. `install.sh --dummies`, or a yes to its question, turns it on for the profile. After the profile step, the installer runs the script of the skill:

```sh
PI_CODING_AGENT_DIR=<profile> python3 <clone>/packages/tenantext/skills/coordinator-skills/dummies/scripts/state.py on --harness pi --autostart
```

- The state file `~/.config/dummies-skill/state.json` (in `XDG_CONFIG_HOME` when it is set) records on or off for each harness. Every Pi profile of the user shares it.
- The autostart block is a marked block in the instruction file of the profile: the first that exists of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD`, in the order of `state.py`. When none exists, the script creates `AGENTS.md`. It appends the block when the file has no block. Each new coordinator session reads the block and starts the report form.
- `state.py log off` turns off the entry on the page `DUMMIES` for each harness; the reports stay. `log on` (the default) turns it on again.
- A repeat install finds the block and changes neither file.
- The inventory and the installer screen show DUMMIES on for a profile only when the profile has the block and the state file says on for Pi. A profile without the block shows off, also when the switch is on for Pi. After the screen, a profile with DUMMIES on gets no DUMMIES question.
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
- **MCP with codemode** (`mcp-codemode`): the MCP client and the `codemode` tool of Pi, without the adapter. Read [MCP with codemode](#mcp-with-codemode) first.
- **Own packages and directories**: add a Pi package that you maintain with `pi install <path>`, or a skills directory to the `skills` list of the profile settings.
- **Agent fan-out**: no subagents module exists. Use the Herdr skill of `packages/tenantext`. Pi inside Herdr is not qualified. The Herdr application is a host tool that the kit does not install. Read [Herdr and the question tool](../herdr-setup.md) first.
- **Questions** (`questions`): the Pi extension with the `ask_user_question` tool, in the core install. It needs an interactive session. Without it, a skill asks in plain text. It is not an extension for Claude Code.
- **Computer use** (`computer-use`): control of the desktop on Linux. Ask about desktop control before you install it. Read [computer use](#computer-use) first.
- **Computer use on macOS** (`computer-use-macos`): control of the desktop on a Mac. Ask about desktop control before you install it. Read [computer use on macOS](#computer-use-on-macos) first.
- **OpenKnowledge** (`okknow`): the skill and the CLI for one OpenKnowledge server of the user. Read [okknow](#okknow) first.
- **Artifacts** (`artifacts`): the skill, the CLI and a local server that store an HTML or Markdown file on this computer, or over SSH on another one, and give the view link. Read [artifacts](#artifacts) first.
- **Walkr** (`walkr`): Walkr Compare, a browser page where the user picks one of 2 or 3 prepared options of a change or of a short text. Read [walkr](#walkr) first.
- **Memory viewer** (`memory`): a read-only page for the memories of your memory systems, as the section `/memory/` of the local artifacts server. It can show private memory. Read [memory](#memory) first.
- **Antigravity CLI** (`agy`): the kit rules, skills and command rules for the `agy` command, and the OpenViking memory hooks with the OpenViking Claude Code plugin. `--with all` leaves it out. Read [agy](#agy) first.
- **Agent Toolkit for AWS** (`aws-core`, `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops`, `aws-startup-advisor`, `aws-emulator`): the AWS skills of the five plugins and the `aws-emulator` skill from one clone at the pinned commit, the server `aws-mcp` with `aws-core` and `mcp` or `mcp-codemode`, and the Claude Code plugins after their own yes. They need `git`, network access and `uv`. Read [Agent Toolkit for AWS](aws-agent-toolkit.md) first.

## Computer use

The `computer-use` module is agent-sh `computer-use-linux` 0.7.59, the npm package `@agent-sh/computer-use-linux`. It is the current official computer-use module of tenant-pi for Linux. Its manifest status is `unverified`. For macOS, see [computer use on macOS](#computer-use-on-macos). The qualification of the kit installs the pinned spec without its install script and loads the extension and the skill in a profile of `install.sh`. No test of the kit runs a tool on a desktop; the manifest gaps name the open facts.

Against 0.7.49, the verified npm tarballs leave the installer, extension loader, MCP client bundle and tool schemas unchanged. Version 0.7.50 adds an optional HTTP MCP listener and updates `rustix` to 1.1.6. Version 0.7.51 fixes AT-SPI application ownership, unmatched-pid scoping and background-action readback. Version 0.7.59 keeps the same default tool names and installer. It adds background pointer input on KDE Plasma. The Pi extension still starts stdio MCP, not HTTP.

Warning: `mcp --listen` exposes desktop tools over plain HTTP. The kit does not enable it.

The upstream listener requires a bearer token, checks `Host`, rejects `Origin`, and refuses shell-enabled mode. It needs TLS before it crosses a trust boundary. These source checks are not a runtime qualification of HTTP or desktop access.

Since 0.7.48, tree results include `snapshot_id`. Pass it with tree-based actions and `get_tree_page` to reject a replaced snapshot before input. Without it, indices refer to the latest tree. Full capture-space coordinates and direct AT-SPI identifiers do not use this check. These are upstream source facts, not desktop test results.

The package gives Pi native tools and a skill. The tools read the AT-SPI accessibility tree, take screenshots and list windows. They also send clicks, keys and text to the desktop of the user. Screenshots and accessibility trees that a tool returns go into the conversation, and so to the model provider.

The module needs these things:

- Linux on x64 or arm64. The `package.json` of the package sets `os` to `linux`, so npm refuses another platform.
- A graphical session with the AT-SPI accessibility bridge, and an input backend. When `ydotool` is absent and the session bus answers that it has no RemoteDesktop portal, as on wlroots compositors such as Sway, labwc, river or cage, `wtype` sends `press_key` chords since 0.7.36 (from the package README, not run). Since 0.7.47 a coordinate pointer action on Wayland needs `/dev/uinput` or the RemoteDesktop portal; since 0.7.48, targeted scrolling sends movement and wheel events through the same uinput device, without `ydotool`. `ydotool` remains an untargeted-scroll route (from the README and release notes, not run). The kit does not install these backends. The doctor tool of the package names each blocker. Its setup tools can turn on AT-SPI and install a GNOME Shell extension; they change the desktop settings of the user.
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

## Computer use on macOS

The `computer-use-macos` module is the npm package `@amaster.ai/pi-computer-use` 0.1.40, a Pi extension for Cua Driver 0.37.0, with the skill `computer-use`. On macOS, npm installs its optional runtime `@amaster.ai/pi-computer-use-cua-driver-darwin-universal` 0.1.4. That runtime holds `CuaDriver.app` of the upstream release, signed by upstream (bundle ID `com.trycua.driver`), as a universal binary for Apple silicon (arm64) and Intel (x86_64). The `Info.plist` of the app names macOS 13.0 as the minimum. Its manifest status is `unverified`.

Status: not verified on a Mac. The checks of the kit are source checks only: the exact pin, the install into a profile, the default settings and the extension load. The qualification step of the update path installs and loads the module only when it runs on macOS. The live desktop qualification waits for a Mac check that the owner approves.

The package gives Pi native `computer_use_*` tools. The tools list apps and windows, read the accessibility tree of a window, take screenshots, and send clicks, keys, text and drags to a window. Screenshots, accessibility text and the text that the agent types go into the conversation, and so to the model provider.

Read the [open gaps](#open-gaps) before you install. Cua Driver sends telemetry by default, and no opt-out for the bundled copy is proven. The model can also activate the tool groups that the `core` profile hides.

### Install

1. Run `./install.sh --with computer-use-macos` in zsh (see [install.sh](../../INSTALL.md#run-installsh)). `--with computer-use-macos` is your yes to desktop control. After `computer-use-macos` as an answer to the module question, the script asks about desktop control first. On Linux the script stops before its first write.
2. Type `/reload` in the Pi session. Pi loads the extension.
3. Run `/tenantext-doctor`. It reports the installed version against the kit pin, the bundled `CuaDriver.app` and the settings. It starts no driver, so it does not check the macOS grants.

The install and the extension load start no driver and ask for no macOS grant. The package has no install script. The extension starts `CuaDriver.app` through LaunchServices at the first `computer_use_*` tool call. That call asks macOS for the Accessibility and Screen Recording grants for `CuaDriver.app`, not for the terminal. Grants that exist already raise no new dialog.

The installer writes this block into the profile settings. A value that you set already stays.

```json
{
  "pi-computer-use": {
    "mode": "bundled",
    "toolProfile": "core",
    "confirmAppLaunch": true,
    "confirmDangerousActions": true
  }
}
```

The extension reads this block from the `settings.json` of the profile (`PI_CODING_AGENT_DIR`). A key there wins over the same key in `~/.pi/agent/settings.json`. A key that only `~/.pi/agent/settings.json` sets applies too. This fact comes from the source of `@amaster.ai/pi-shared` 0.1.38; it is not verified on a Mac. That version rejects malformed or unreadable settings and null sections instead of using defaults. Fix invalid settings before reloading. The kit's settings block stays unchanged.

Version 0.1.38 also returns sanitized error categories and browser recovery hints. A failed request can have an unknown execution outcome. Read the current target state before retrying an action. Version 0.1.40 sends vision requests through Pi's model registry when available. The skill, approval settings and bundled runtime remain unchanged.

- `mode` `bundled`: the extension uses the driver of the runtime package. The kit installs no second Cua app.
- `toolProfile` `core`: the model sees only the everyday tools at the start.
- `confirmAppLaunch`: Pi asks you once for each app before the agent launches it.
- `confirmDangerousActions`: Pi asks you before a high-risk tool, for example `kill_app`, `run_script`, or `install_extension` with `confirm:true`.

The kit does not install the optional Cua Perception extension. The ordinary accessibility and screenshot tools do not need it.

### Open gaps

- Telemetry: Cua Driver sends telemetry by default. The extension passes only two variables to the driver app, so an opt-out variable in your shell does not reach it. No opt-out for the bundled copy is proven.
- Display: main display only is not proven for driver 0.37.0. Prefer window-scoped captures.
- SSH: not verified: the behavior over SSH without a logged-in GUI session.
- Tool exposure: the `core` profile is not an allowlist. The model can activate the other tool groups itself, for example with `computer_use_tools` or the tool search of Pi. The app-launch confirmation covers the launch of an app, not each action on an app that runs already.
- Background input: the driver sends input to a window in the background where it can. Some shortcuts and app controls can still bring a window to the front.
- Signature: not verified on a Mac: the code signature and the notarization of `CuaDriver.app`.

### Herdr panes on macOS

The Herdr skill removes the `computer_use_*` tools from the read roles, as for the Linux module; see [Herdr panes](#herdr-panes). The macOS module has no Claude Code form in the kit.

### A new version

The pin moves in two places: the manifest spec and the line of each Pi profile. [The computer-use version](../../UPDATE.md#the-computer-use-version) gives the steps.

## MCP with codemode

The module `mcp-codemode` lets Pi manage the MCP servers instead of `pi-mcp-adapter`. `codemode` is a Pi tool: the model writes a script that calls the other tools, and only the output of the script reaches the model. Each server gets `codemode` exposure, so the prompt lists no MCP tool.

`install.sh` refuses `mcp` together with `mcp-codemode`, because the adapter replaces the MCP support of Pi. The value `all` does not include `mcp-codemode`.

A new profile or an upgrade. The name `codemode` is an example:

```sh
sh install.sh --new codemode --shell bash --with mcp-codemode --yes
sh install.sh --upgrade codemode --shell bash --with mcp-codemode
```

The module installs no package. It adds `+codemode` to `defaultTools` in the settings, and it removes the adapter package, `-builtin:mcp` and `-builtin:codemode`. The kit entries that it writes to `mcp.json` (okknow, and aws-mcp with `aws-core`) have `codemode` exposure.

### The switch of an adapter profile

When the profile has `mcp-adapter.json`, and the adapter is selected or no `mcp.json` exists, the installer runs `scripts/mcp_to_native.py --profile <profile>`. The plan shows its lines first; the switch starts after the approval:

1. It saves `mcp-adapter.json`, `settings.json`, `mcp.json`, `mcp-onboarding.json` and `kit-aws.json` as they are to a new folder `<profile>/backups/mcp-native-<UTC time>/`. A second run in the same second adds a suffix such as `-02`. The folder has mode 0700 and each file mode 0600. `backup.json` names the SHA-256 of each file, or `absent`, and the SHA-256 of the new `mcp.json`.
2. It writes `<profile>/mcp.json` with mode 0600. Each server gets `"exposure": "codemode"`; `directTools` and other tool overrides are dropped. Each tool of `excludeTools` gets `"hidden"` in `toolExposure`, so no script can call it.
3. It changes the settings as above. Other settings keep their values.

`-builtin:mcp` is in the backup: the adapter writes it only once for each adapter version (`mcp-onboarding.json`), so the restore puts both back.

The tool refuses, and changes no file, in these cases:

- `mcp.json` exists and does not hold the bytes that the last switch of the tool wrote. A hand edit after the switch counts, so a second switch never overwrites it. Move the file aside, or keep the adapter profile.
- A file of the switch is a symlink.
- A required server would be lost. The okknow entry of the kit and the kit aws-mcp entry of `kit-aws.json` are required. `--require <name>` adds a server; repeat it for more. Repair the entry, or keep the adapter profile.

Read the printed lines. They name fields, never values:

- `dropped lifecycle`, `idleTimeout`, `toolPrefix`: Pi connects to each enabled server at session start, keeps it for the session, and names each tool `mcp__<server>__<tool>`.
- `disabled in the adapter file`: the server gets `"enabled": false`.
- `not safe in codemode` with a reason: the server needs `requestHeadersCommand`, `socket`, `caFile`, a sign-in field with no native equal (`auth`, `bearerToken`, `bearerTokenEnv`, `bearerTokenStore`, `oauth.grantType`, `clientMetadataUrl`, `authorizationParams`, `clientUri`), or a tool limit with no native equal (`approveTools`, `includeTools`, or an `excludeTools` entry that is not a tool name or a `*` pattern). A `type` that Pi does not support, such as `sse`, is not safe too. The server gets `"enabled": false` and no direct tool. A login of the adapter does not transfer.
- `warning: dropped inheritEnv false`: Pi has no field that keeps its own environment from a stdio server. Check that the server can see the environment of Pi before you turn it on.

To turn on a server with `"enabled": false` after you repair it, set `"enabled": true` in `<profile>/mcp.json`, or enable it in `/mcp` in a Pi session. Make the repair in `mcp.json` too: after the switch, Pi reads only that file. After a hand edit, the tool refuses a second switch of the profile.

`oauth.clientId`, `clientSecret`, `scope` and `clientName` stay. `oauth.redirectUri` becomes `callbackUrl` when it is an HTTP address on the local machine.

Then run `PI_CODING_AGENT_DIR="$HOME/.pi/profiles/codemode" pi mcp list`. Pi connects to each enabled server and reports each invalid entry.

To switch a profile without the installer, or to print the plan only:

```sh
python3 scripts/mcp_to_native.py --profile "$HOME/.pi/profiles/codemode" --dry-run
python3 scripts/mcp_to_native.py --profile "$HOME/.pi/profiles/codemode"
```

The switch writes `mcp.json`, then `kit-aws.json`, then `settings.json`. When it stops between these writes, the adapter stays selected beside the new `mcp.json`. Run the same `--profile` command again, or the restore below: each one repairs the profile. A temporary file `.<name>.mcp-native-<number>` can stay in the profile folder; move it aside.

### Go back to the adapter

Give the backup folder that the switch printed:

```sh
python3 scripts/mcp_to_native.py --restore "$HOME/.pi/profiles/codemode/backups/mcp-native-<UTC time>"
```

The restore puts back each saved file with its old bytes and mode: the adapter file, the settings with the adapter package and `-builtin:mcp`, `mcp-onboarding.json` and `kit-aws.json`. A file that was `absent`, for example the new `mcp.json`, moves into the backup folder as `after-mcp.json`; the tool deletes no file. The adapter then does not import it. The tool refuses a folder that it restored before, or a saved file whose SHA-256 differs from `backup.json`.

The restore returns the state of the moment of the backup. A later change, for example a module that you installed after the switch, is not in the restored files. The tool keeps each current file that differs from its saved copy in the backup folder as `after-<name>` (mode 0600) before it puts the saved copy back, so nothing is lost. Copy a later change back from there by hand. When an `after-<name>` file exists already, the tool refuses and changes no file.

To copy the servers of one adapter file into a new file only, with no backup and no settings change:

```sh
python3 scripts/mcp_to_native.py --from "$HOME/.pi/profiles/main/mcp-adapter.json" --to "$HOME/.pi/profiles/codemode/mcp.json"
```

This form refuses a target that exists.

Pi and the adapter read some values in different ways:

| Form | Adapter | Pi |
| --- | --- | --- |
| `${NAME}` in `env` or `headers` | The value, or empty when `NAME` is not set | The value; the server does not connect when `NAME` is empty or not set |
| `!command` as a whole value | The trimmed output | The same |
| `${NAME:-text}` | The value, or `text` | Plain text, not expanded |
| `$env:NAME`, `{env:NAME}` | The value | Not expanded in the same way; write `${NAME}` |
| `$NAME`, `$$`, `$!` | Plain text | The value of `NAME`, `$`, `!` |
| `!!text` | The plain text `!text` | A shell command; do not use it |
| A variable in `command`, `args`, `url` or `cwd` | Expanded | Not expanded; only a leading `~/` is expanded in `command`, `args` and `cwd` |

To hide the other tools from the model, so that it reaches them only through scripts, set `codemode.mode` in `<profile>/settings.json`. The value `only` also hides `read`, `bash`, `edit` and `write`:

```json
{
  "codemode": { "mode": "only" }
}
```

To compare the two profiles:

1. Choose one prompt that needs an MCP tool, and one model.
2. Run the prompt once in each profile, each time in a new session. The profiles must have the same servers.
3. Export each session with `/export` to an HTML file, then compare the tool count. The export has the block System Prompt and, beside it, the list Available Tools.
4. Compare the input tokens of the first turn and of the full session.
5. Compare the results. A smaller token count has no value when the result is worse.

## okknow

The `okknow` module is the in-tree package `packages/okknow`: the skill `okknow` and its CLI `scripts/okknow`, for one OpenKnowledge (OK) server of the user. Its manifest status is `unverified`; the manifest gaps name the open facts. The kit installs no OK server.

Several kit skills use it when it is present: the log page of `dummies` (its script `page.py` runs the `okknow` command), `research`, `to-spec`, `to-tickets`, `wayfinder`, `retro` and `get-status`. Without it, each of them skips the OpenKnowledge step.

The package is separate from `packages/tenantext`, because Pi loads every skill of a package entry. A separate package keeps the skill out of a profile without the module.

`install.sh --with okknow` does these steps:

1. It adds `<clone>/packages/okknow` to the `packages` list of the profile settings. Pi then loads the skill.
2. It links `~/.local/bin/okknow` to the CLI of the clone. It keeps another file or link of that name. When `~/.local/bin` is not on `PATH`, the profile launcher adds it at the end of `PATH`.
3. When `~/.claude` exists, it links the skill to `~/.claude/skills/okknow`, as for the other kit skills.
4. It runs the setup wizard `okknow setup`. With `OKKNOW_ORIGIN` set, it runs `okknow setup --origin "$OKKNOW_ORIGIN" --yes`: that run sends no credential (the installer does not pass `--probe-auth`) and keeps every key of an existing config. When the config has a different origin, the installer stops before its first write; run `okknow setup --origin <url> --yes --replace-origin` to replace it. When a user config exists and `OKKNOW_ORIGIN` is not set, it keeps that config. Else it runs the wizard in the terminal. Without a terminal, `OKKNOW_ORIGIN` or a config, it stops before its first write. The plan of the installer prints the origin.
5. With the `mcp` module too, it adds the server `okknow` to `<profile>/mcp-adapter.json`. With `mcp-codemode`, it adds the server to `<profile>/mcp.json`. Its header is `Authorization: !<home>/.local/bin/okknow auth-header`: the adapter or Pi runs the CLI for the header at connect time. An existing `okknow` entry with another header stays.

The wizard asks for the origin of your OK server: `https://<host>[:port]`, or `http://127.0.0.1:<port>` for a server on the same computer. It suggests no default. It checks the form, then probes the origin without credentials and prints one line for each check: `reachable` and `mcp`. Then it asks `Send OPENKNOWLEDGE_USERNAME/PASSWORD to <origin>? [y/N]`; only after a yes does it run the `authenticated` check. With `--yes`, it sends the credentials only with `--probe-auth`. It names each missing credential variable. Then it writes `~/.config/okknow/config.json` (mode 0600). It sets the origin and keeps every other key of an existing config. With `--yes`, it refuses an origin that differs from the saved origin unless `--replace-origin` is given. A failed probe does not stop the write; run `okknow doctor` later. `okknow setup --check` prints the state of the saved origin in words and sends no credential.

The CLI talks only to the configured origin. It refuses another origin from `--origin`, `OKKNOW_ORIGIN` or `OPENKNOWLEDGE_ORIGIN`, refuses redirects and ignores proxy variables. With no origin configured, each command exits 4 before any request.

The kit writes no credential. Keep `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` in the environment of the shell that starts the agent, for example in its startup file or from a password manager. The CLI reads them at run time.

Claude Code MCP is a separate step; [the okknow details](../../packages/okknow/skills/okknow/references/details.md#install-with-the-kit) give the `claude mcp add-json` line with a header helper.

A server host keeps the content directory of the server on its disk. There, `okknow setup --volume <dir>` turns on the checks of that directory in `okknow doctor` and the write guard `scripts/okknow-guard`. A client has no such directory; see [the okknow details](../../packages/okknow/skills/okknow/references/details.md#server-host).

To remove the module: delete the `packages/okknow` entry from the profile settings, the link `~/.local/bin/okknow`, the link `~/.claude/skills/okknow` and the `okknow` entry of `<profile>/mcp-adapter.json` or `<profile>/mcp.json`.

## artifacts

The `artifacts` module is the in-tree package `packages/artifacts`: the skill `artifacts` with its CLI `scripts/artifacts`, the command `/artifacts-server`, and a small web server on `127.0.0.1` with a root page, the page `/artifacts` of the stored pages and the Walkr page `/walkr`. The archive and restore routes change the archive status in the store. The Walkr pass sends three page writes to the live Walkr server. The artifacts part uses Python 3 and its standard library only. An agent stores an HTML or Markdown file with `artifacts upload <file>` and gives the user the view link. Its manifest status is `unverified`; the manifest gaps name the open facts. See [the package README](../../packages/artifacts/README.md) for the store, the routes and the exit codes.

`install.sh --with artifacts` asks nothing and does these steps:

1. It adds `<clone>/packages/artifacts` to the `packages` list of the profile settings. Pi then loads the skills and the prompt `/artifacts-server`.
2. It links `~/.local/bin/artifacts` to the CLI of the clone. It keeps another file or link of that name. The profile launcher adds `~/.local/bin` at the end of `PATH`.
3. When `~/.claude` exists, it links the skills `artifacts` and `artifacts-server` into `~/.claude/skills`, as for the other kit skills.

The run writes no configuration and starts no server.

`artifacts upload` runs the secret scanner of the kit (`scripts/scan.sh --level warn tree`) on the file first. A finding stops the upload. Then the CLI writes the file into the store `~/.local/share/tenant-artifacts/store/`. An upload needs no running server. The view link is confidential: each holder of the link on this computer can read the page.

The view link is the viewer page `/v/<slug>`. Its bar shows the facts of the artifact and links to the index. Outside the archive, it also links to newer and older items on the main list. Below the bar, a sandboxed frame shows the artifact. In a Markdown page, a fenced code block with a language name gets syntax colors. `artifacts upload <file> --replace <slug>` stores a new version under the same slug, so the link stays. `artifacts delete <slug> [<slug> ...]` deletes the named artifacts.

`artifacts open [slug]` prints the URL of the index page `/artifacts` or of the viewer page of one artifact. In a Herdr pane (`HERDR_ENV=1`) with the Sheprd command, it also runs `sheprd browser open <url>`. It starts no other browser.

With `artifacts setup --remote HOST`, `upload`, `list`, `archive`, `restore`, `delete` and `open` work on the store of another computer over SSH, for example the computer where you run Sheprd. An upload scans the file on this computer first; then the file goes to HOST, and this computer stores nothing. The view link is then valid on HOST. `artifacts setup --local` removes the setting, and `artifacts --here <command>` ignores it for one call. See [a remote store over SSH](../../packages/artifacts/README.md#a-remote-store-over-ssh).

### Local server

`/artifacts-server start` in Pi or Claude Code, or `artifacts start` in a shell, starts the server on `127.0.0.1:6790`. It is the one local web app of the kit: each page shows the same band with the links Artifacts, Walkr and Memory and the theme choice. The output has the line `root:` with the URL of the root page `/`, which links to `/artifacts`, `/walkr` and `/memory/`. With the `memory` module, the line `memory:` names the section [Memory](#memory). When Walkr is installed, the line `walkr:` names the Walkr page `/walkr`. The last line is the URL of the index page `/artifacts`: a table of pages outside the archive with the type, the repo, and the date and time of the upload. The row under the pointer shows a live preview of its page. The index can also show the pages as a gallery of cards, with a live preview of each card in view. At most 2 gallery previews start at one time. A preview that needs more than 4 seconds frees its place for the next one and continues to load. The pages have the Torch Light design of Walkr; a dark theme that you choose in Walkr, or in the `Theme` list of a page, gives Torch Dark. The index and the viewer page ask the JSON route `/api/state` of the server every few seconds and show a new or changed artifact without a reload. `artifacts setup --port N` sets another port. `off` (or `stop`) stops this server and stops Walkr only when Linux proves that your Walkr process owns the listener; the saved Compare sessions stay. `off --keep-walkr` leaves the live Walkr server running. `status` prints `running` or `stopped` and the URLs of the pages; `artifacts --json status` prints the same facts as one JSON object (see [the package README](../../packages/artifacts/README.md#the-server)). The server accepts only loopback requests. It answers `GET` and `HEAD`, archive and restore writes, and the requests it passes to Walkr and Memory. `/d/<slug>` downloads the stored file of an artifact. It writes its state file `server.json` and its log `server.log` in `~/.local/state/tenant-artifacts`.

`artifacts retention <days>` makes the server delete each artifact whose last upload or replace is older than that number of days; `artifacts retention none` keeps all. With no setting, the server deletes nothing.

The server has one live channel for a desktop app such as the Herdr app: `GET /events/v1`, an event stream with a token of the file `~/.local/state/tenant-artifacts/events-token` (mode 0600). It sends the counts and one message for each new artifact, each Compare session that waits for a pick, each submitted result and each receipt of the agent. No page in a browser can open it. `artifacts events` prints the messages. See [the contract](../../packages/artifacts/docs/events.md).

The operations footer of Pi shows the state of the server in one row below the OpenKnowledge row. See [the artifact server row](../../packages/tenantext/docs/ops-footer.md#artifact-server-row).

With Walkr installed, the server also passes the Walkr Compare page to the live Walkr server, so the page works on port 6790 and through a port forward. `/artifacts-server walkr` in Pi or Claude Code, or `artifacts walkr-url [SESSION-ID]` in a shell, prints the private address of the page on the port of the artifacts server (6790 by default). The command starts the live Walkr server when none runs; it does not start the artifacts server. The link `Walkr` of the root page opens the same page in the browser: `/walkr` redirects to it and starts the live Walkr server first when none runs. `/walkr` refuses a request whose `Sec-Fetch-Site`, `Origin` or `Referer` header names a page of another site; a request with none of these headers passes. On Linux, it also refuses each request whose client socket the TCP tables do not name as one of your user. It refuses to run `walkr-compare open` when it cannot show that only the recorded Walkr server listens on the port of the Walkr record: on Linux by a look at each listening socket of that port and at the open sockets of the recorded process, which is a snapshot and not a proof; on macOS only by the PID and the protocol that the `/health` answer of that program names. On Linux, an unrelated listener of another program on the same port number also makes it refuse. The text page of such a refusal names `artifacts walkr-url` for a shell. See [the page /walkr](../../packages/artifacts/README.md#the-page-walkr). The pass covers Compare sessions only: Core, Double, Trainer and Coinflip stay on the port of the live Walkr server. It passes only the page, its files, its read requests and the three page writes `seen`, `submit` and `rate`; each other request stays on port 6790. Exit codes of `walkr-url`: 0 done, 2 the session is unknown or the ID is not valid, 3 no server answer (the live Walkr server did not start in time, or the artifacts server does not run: run `artifacts start`) or an artifacts server from before the update (run `artifacts off`, then `artifacts start`), 4 Walkr or Node is absent. The address is valid for one run of the live Walkr server, which ends after 45 minutes with no use. A plain browser tab then needs a new address: open `/walkr` again, or run `artifacts walkr-url`. See [the Walkr pass](../../packages/artifacts/README.md#the-walkr-pass).

Warning: the pages need no login. Each local user of the computer can read them through the loopback address. On macOS, this includes the Walkr page through `/walkr`. On Linux, `/walkr` gives the Walkr page only when the TCP tables name your user for the client socket; it refuses each other request.

From another computer, use a port forward that you authorized, for example `ssh -L 6790:127.0.0.1:6790 <user>@<server-computer>`, then open `http://127.0.0.1:6790/artifacts`. The kit sets up no proxy and opens no port.

To remove the module: run `artifacts off`. Then delete the `packages/artifacts` entry from the profile settings, the link `~/.local/bin/artifacts` and the links `~/.claude/skills/artifacts` and `~/.claude/skills/artifacts-server`. The folders `tenant-artifacts` of the configuration, data and state homes stay; they hold the stored pages and the settings.

Verified by hand in the web view of Sheprd on Linux, with Servo 0.8.0 and through an SSH port forward, before the pages got the Torch design and the previews on demand: the index, the viewer, the code colors and the gallery. A click on a link failed there while the web view held a Ctrl key state from an earlier key combination: the web view then asked for a new window, and Sheprd refused it. Not verified: the pages of now in the web view of Sheprd (the Torch design and its theme script, the index with the preview card of a table row and the previews of the gallery cards in view, and the frame of a Markdown view, whose address a script sets), which only a Chromium browser showed; `/artifacts-server` in a live Pi or Claude Code session, `artifacts open` in a Herdr pane with Sheprd on the same computer, the root page and the page `/walkr` in Sheprd, Sheprd on macOS, and the module on macOS.

## walkr

The `walkr` module is the in-tree package `packages/walkr`: Walkr Compare with its command `walkr-compare`. The agent prepares 2 or 3 options of one change, you open a private page in a browser and pick one, and the agent reads your pick, your notes and your rating. [The package README](../../packages/walkr/README.md) and [the Compare guide](../../packages/walkr/docs/compare.md) describe it. The source of Walkr lives in this kit; the kit has no second copy of it.

Compare is the one mode of Walkr. Core, Double, Coinflip, Trainer, the shared GUI and hosted mode are retired since 2026-11-23. The release tag `portable/20261122-548259a` is the last release with their code. A saved record of a retired mode stays on disk untouched.

`install.sh --with walkr` does these steps:

1. It checks that the `node` command is on the `PATH`. The package has no runtime dependency, so the step runs no npm command and needs no network.
2. It links the two commands `walkr` and `walkr-compare` into `~/.local/bin`. The step replaces a link only when its target belongs to a package named `walkr` in `package.json`. It keeps each unidentified link or other file of these names, then ends with an error that names the file. A failed link creation also makes the install fail and skips the Walkr setup. The profile launcher adds `~/.local/bin` at the end of `PATH`.
3. It removes the links `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer` of an earlier install, each one only when its target belongs to a package named `walkr`. A file or a link of another owner with such a name stays.
4. It runs the setup of Walkr for your account. The setup writes the skills `walkr` and `walkr-compare` to `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`, and their prompts to `<profile>/prompts`. Each Pi prompt names its skill file in `~/.agents/skills`; Claude Code reads `~/.claude/skills`. The setup removes the skills and the prompts of the retired modes that an earlier setup wrote and that are unchanged; a retired file that you changed stays, and the setup prints its path.
5. It prints one line for each written or removed file. A file of `walkr` or `walkr-compare` that you changed stops the setup; the line names the file.

The setup makes `~/.claude`, `~/.codex` and `~/.agents` when they are absent. On an account without `~/.claude` before the install, that run makes no Claude Code skill link of the kit. A later run of `install.sh` finds the directory and makes the links, as for each account with `~/.claude`.

The skills and the prompts in the package are templates. The setup writes the absolute path of this clone into each skill, so the package is not an entry of `settings.packages`. After you move the clone, run `install.sh --upgrade <name> --with walkr` again.

In Pi or Pi-Bolt, type `/walkr` with a request, for example `/walkr compare cfn options` or `/walkr simplify ticket`. In Claude Code, the same line loads the same skill. Each Compare workflow asks its questions before it prepares the options: with `AskUserQuestion` in Claude Code, and with `ask_user_question` of the `questions` component in Pi.

Sheprd is a separate tool that receives Walkr page URLs; the kit neither installs nor requires it.
The link is optional and off by default. Set `export WALKR_SHEPRD_CONNECT=1` in the shell or the profile that starts Pi or Claude Code.
In a Herdr pane with `sheprd` on the `PATH`, `walkr-compare create` and `walkr-compare open` request a page display.
See [the Sheprd link](../../packages/walkr/docs/compare.md#sheprd-link-optional).

The package also holds an optional [Compare mirror](../../packages/walkr/mirror/README.md): a persistent, read-only page for the session records of more than one computer. `install.sh --with walkr` does not install, link or start it, on Linux or on macOS. You start it by hand when you want it.

`walkr setup --help` prints help without writing files. A retired command name of an earlier install (`walkr-core`, `walkr-double`, `walkr-coinflip`, `walkr-trainer`) prints one line that names `walkr-compare` and the tag, and exits with code 2.

The page `/walkr` of the artifacts server redirects to the Compare page on the port of the artifacts server, and starts the live Walkr server first when none runs. Without Walkr, or when no address comes, it is a text page that says so and names `artifacts walkr-url`. That command prints the address of the Compare page on the port of the artifacts server (6790 by default) (see [Local server](#local-server)). The page and the command need the `artifacts` module too. Walkr installed alone gets no server on port 6790: it works on its own port, as before. `artifacts off` also stops the live Walkr server when Linux proves the listener belongs to it; `artifacts off --keep-walkr` leaves it running.

The Walkr server listens on `127.0.0.1`. It has the Compare routes, the two theme files and a health check; each other path answers 404. To open the Compare page from another computer, read [the Compare limits](../../packages/walkr/docs/compare.md#limits) for `HUMAN_REVIEW_BIND` and `HUMAN_REVIEW_ALLOWED_HOSTS` first.

Warning: with `HUMAN_REVIEW_BIND=0.0.0.0`, each device of your networks can reach the server over plain HTTP. Only the secret in the page URL protects a page.

To remove the module: run no step of the kit. Delete the six command links of `~/.local/bin`, the `walkr*` folders of the three skill folders, the `walkr*.md` files of `<profile>/prompts` and the file `.walkr-setup.json` beside them.

Not verified: a Walkr workflow in a Pi or Pi-Bolt session from this package, the Pi extensions of `packages/walkr/integrations/pi` with Pi-Bolt, and the module on macOS.

## memory

The `memory` module is the in-tree package `packages/memory`: the memory viewer. It is a read-only web page for the memories of several agent memory systems: OpenViking, OpenKnowledge (okknow), llm-wiki, hermes-memory and AgentCore memory. It is the section `/memory/` of the local server of the `artifacts` module, beside Artifacts and Walkr, so it needs `artifacts`: `install.sh --with artifacts,memory`. [The package README](../../packages/memory/README.md) has the sources and the settings file.

`install.sh --with memory` does one step: it checks that Node 24 or later can load the two dependencies of the package (the AWS SDK of the AgentCore source). When one is missing, it runs `npm ci --ignore-scripts --omit=dev` in the package and checks again. This step needs the network. It links no command, writes no skill and changes no profile: the package holds no Pi resource.

`artifacts start` then starts the viewer as a child process of the local server, on `127.0.0.1` with a free port, and `artifacts off` stops it. `artifacts status` shows the line `memory:`, and `artifacts --json status` has `memory` in `modules`. The viewer has no sign-in of its own: it answers only its parent server, which adds a secret of the start to each request that it passes. When Node 24 or the dependencies are absent, the local server still starts, and the page `/memory/` says in one sentence what is missing.

The sources come from the settings file `~/.config/tenant-artifacts/memory-sources.json` of your user (mode 0600). Each credential in it is the path of its own file with mode 0600, never a value, and no credential comes from an environment variable. With no settings file, the viewer shows synthetic sample data and says so on the page. The installer writes no settings file.

Warning: with a settings file, the page shows private memory, and the pages of the local server need no login. On Linux, the Memory pass accepts only a client socket that belongs to your user; on macOS, each local user can read the page. The viewer is read-only toward each memory system, with one exception that the owner approved: the review of an AgentCore source with a `review` setting moves one proposed record. Nothing that the viewer reads leaves the computer. See [the privacy guide](privacy.md#component-reads-requests-and-writes).

Not verified: a read of a live source through the settings file in the kit, the page in the web view of Sheprd, and macOS.

To remove the module: delete the settings file and the folder `packages/memory/node_modules`. The memory systems do not change.

## agy

The `agy` module is the in-tree package `packages/agy` for Antigravity CLI, the `agy` command. It gives `agy` the plain reply style of the kit, the kit rules, the kit skills, the kit command rules and the OpenViking memory hooks. Its installer script is `scripts/kit_agy.py`. Its manifest status is `unverified`; the manifest gaps name the open facts. See [the package README](../../packages/agy/README.md) for each file and key.

`--with all` leaves the module out: only `install.sh --with agy`, or its choice on the installer screen, installs it. The kit never installs the `agy` program and never touches its login.

Precondition: run `agy` one time and sign in. Then the folder `~/.gemini/config` exists. Without that folder, the run prints one line: `Run agy one time and sign in, then run the installer again.` It creates nothing under `~/.gemini` and finishes the other modules.

`install.sh --with agy` asks nothing more and does these steps:

1. It links the rule files `style.md` (the plain reply style) and `tenant-kit.md` (the terms line and a pointer to the kit skills) into `~/.gemini/config/rules/`. With the `artifacts` module, it also links `tenant-kit-artifacts.md`.
2. It links each kit skill of the chosen modules into `~/.gemini/config/skills/<name>`. These are the skills that the installer links into `~/.claude/skills`. It replaces a broken link or a link into the clone, and keeps each other file or link with one `skipped:` line. It removes a link into the clone whose skill left the list.
3. It sets the `hooks.json` key `tenant-kit`: a `PreToolUse` handler for `run_command` that applies the kit command rules.
4. It writes the OpenViking part only when the OpenViking Claude Code plugin is in `~/.claude/plugins/cache/openviking/openviking-memory/`. The part has three items. The `hooks.json` key `openviking` holds the session recall, the prompt recall and the capture. The entry `mcpServers.openviking` goes into `mcp_config.json`. Three read-only allow rules go into `~/.gemini/antigravity-cli/settings.json`. Without the plugin, it writes none of them and removes its own older ones. It says so in one line. The kit does not install the plugin.
5. When the `herdr` command is on `PATH`, it runs `herdr integration install antigravity-cli`.
6. It warns when a shell start file holds the `PATH` line of the `agy` installer. That line can put plain `pi` and `claude` before the kit launchers. It changes no shell file.

The plan of the run (`--dry-run`, and the plan before the yes) shows each of these steps on a line that starts with `agy:`. A JSON file gets one backup, and only when its content changes. Each other key and file stays.

Warning: with the OpenViking part, the hooks send the conversation of each `agy` session to your OpenViking server. The Claude Code plugin does the same for Claude Code. The plan says so on its `agy: openviking:` line, before the yes.

The kit never touches `~/.gemini/GEMINI.md`; that file stays yours. To turn DUMMIES on for `agy`, run the script of the skill; it writes a marked block into `~/.gemini/GEMINI.md`:

```sh
python3 <clone>/packages/tenantext/skills/coordinator-skills/dummies/scripts/state.py on --harness agy --autostart
```

An `agy` session writes no DUMMIES report; it uses only the page log.

Terms of the Antigravity service: the module installs files only. It never reads, copies, moves or prints the Antigravity login. The only file under `~/.gemini/antigravity-cli/` that it opens is `settings.json`, and only for the three allow rules. No part of the kit runs `agy -p` or `agy acp` behind a model endpoint. The module never writes the model of `agy`.

A later run without `agy` removes nothing. To remove the module, run:

```sh
python3 <clone>/scripts/kit_agy.py remove
```

It deletes only the parts of the kit. These are the links into the clone in `rules/` and `skills/`, and the kit entry `mcpServers.openviking`. They are also the `hooks.json` keys `tenant-kit` and `openviking` while their commands run files of the clone, and the three allow rules. The login, each other file and key, the backups and `~/.gemini/GEMINI.md` stay.

Run the installer again after an update of the OpenViking plugin or after a move of the clone. The written keys name the plugin folder and the path of the clone.

Not verified: a live `agy` session with these files, macOS, and classic Herdr with an `agy` pane. The live session must show the skills list, a denied command and an OpenViking recall. The tests ran with `agy` 1.5.15 on Linux, in scratch homes.

## Claude Code

The Pi profile is the reference. The Claude Code form of the kit carries each component that has a Claude Code form, and nothing else.

| Component | Claude Code form | Source of the form |
| --- | --- | --- |
| `tenantext` | The `SessionStart` hook of the Simplified English rules, and `/ste` | The `tenantext` plugin |
| `herdr` | The skill, `/spawn_agent` and `/handoff_coordinator` | The skill: a link of `install.sh`, or the plugin. The command: the plugin |
| `coordinator-skills`, `knowledge-skills`, `tracker-site` | The skills | The links of `install.sh`, or the plugin |
| `okknow` | The skill; the MCP server is a step of the user | The link of `install.sh --with okknow` |
| `artifacts` | The skills `artifacts` and `artifacts-server` | The links of `install.sh --with artifacts` |
| `walkr` | The skills `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip`, `walkr-trainer` and `walkr-compare` | The files that the Walkr setup of `install.sh --with walkr` writes; they are not links |
| `agentcore` | The plugin `packages/agentcore-claude` | `claude --plugin-dir`; see [in-tree packages](../packages.md) |
| `computer-use` | The plugin of the package | [The Claude Code plugin](#claude-code-plugin) |
| `aws-core`, `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops`, `aws-startup-advisor` | The upstream plugin of the row, with its skills, MCP servers and hooks. The kit server `aws-mcp` replaces the `aws-mcp` servers of the plugins | `install.sh --claude-aws`: a folder marketplace at the kit clone; see [the Claude Code AWS plugins](aws-agent-toolkit.md#claude-code) |
| `aws-emulator` | The skill; with `aws-core`, the plugin carries it | The link `~/.claude/skills/aws-emulator` of `install.sh --claude-aws` |

The skill links of `install.sh` are the default form of the kit skills. A pull of the kit updates them at once.
The `tenantext` plugin is for the `SessionStart` hook, `/ste`, `/spawn_agent` and `/handoff_coordinator`.
When you have the links, skip the skill build of the plugin: with both forms, Claude Code lists each skill twice, as `<name>` and as `tenantext:<name>`.
The plugin skills are for a host that does not keep the kit clone, because the links point into the clone.
[The package README](../../packages/tenantext/README.md#claude-code-plugin) gives the build and the install of the plugin.

The Claude Code form has these gaps today:

- `ops-footer`, `context-meter`, `codex-accounts`, `copilot-usage` and `anthropic-usage` have no Claude Code form in the kit. A Claude Code status line could show them.
- `agentcore` is not in the marketplace file. Its plugin `packages/agentcore-claude` loads in place with `claude --plugin-dir`.
- The memory chain `packages/memory-chain` is not a component yet. Its plugin loads in place with `claude --plugin-dir`. Its on-demand search has a Pi form (the tool `memory_find`, which calls the native store tools of OpenViking and Hermes and reads the personal wiki `~/.llm-wiki` itself, with `wiki_recall` and its layered vault only as the fallback, and the skill `memory-search`) and a Claude Code form (the command `scripts/search.mjs` and the plugin skill `memory-search`); see [in-tree packages](../packages.md#memory-chain-packagesmemory-chain).

The other components have no Claude Code form in the kit:

- Claude Code has its own model selection, MCP client and question tool: `model-routing`, `mcp` and `questions`.
- `doctor`, `resources` and `herdr-watch` act on the Pi profile or on Pi sessions.
- `hermes`, `wiki` and `openviking` are Pi packages. The kit has no Claude Code form of them.
- `agy` is the form of the kit for Antigravity CLI; see [agy](#agy).

## Change a selection

To switch a single extension or skill off or on, use `/resources` inside Pi. To remove an optional module, run `pi remove` with its source; see [POST_INSTALL.md](../../POST_INSTALL.md#add-or-remove-an-optional-module). To turn an AWS row off, run an upgrade with a selection without it; see [Agent Toolkit for AWS](aws-agent-toolkit.md#turn-a-row-off-or-move-the-pin). To remove the `agy` module, run `python3 <clone>/scripts/kit_agy.py remove`; see [agy](#agy).
