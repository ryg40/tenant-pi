# Install the kit

This page installs the kit into one Pi profile directory of your own. Pi loads `packages/tenantext` of the clone as a local package, with no copy. The kit never writes into `~/.pi/agent`.

The [question list](skills/tenant-pi-install/SKILL.md) is for an agent that installs the kit for a user. For Apple silicon, read the [macOS adaptation](docs/guides/macos.md) too.

Words used below:

- `<clone>`: the directory of this repository, for example `~/tenant-pi`.
- `<profile>`: the absolute path of your profile directory, for example `~/.pi/profiles/main`. Pi reads it from `PI_CODING_AGENT_DIR`.

## Prerequisites

`runtime` in `config/manifest.json` holds the required versions: `nodeRange`, `pythonRange`, `piAcceptedRange` and the tested Pi version `piVersion`. Python runs the checks of the kit. Git can be any current version. Linux is the first target. macOS is not qualified; see [the macOS adaptation](docs/guides/macos.md).

Install Pi at the tested version. Run the command in the clone, after the next step:

```sh
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Warning: a global install replaces the `pi` command of each profile of the user.

When the user cannot write the global npm prefix, add `--prefix "$HOME/.npm-global"` to the `npm install` command. Then put `"$HOME/.npm-global/bin"` on `PATH`.

The command can print `npm warn deprecated` and `npm warn install-scripts` lines. They are expected output, not a failure.

Check the versions:

```sh
python3 scripts/check_runtime.py
```

The script compares the installed Pi, Node and Python with `runtime` of the manifest. It does not open a live profile. For a status other than `match`, see [troubleshooting](docs/guides/troubleshooting.md#check_runtimepy-reports-mismatch-or-missing).

### Pi-Bolt, an alternative runtime

Pi-Bolt is the Pi coding agent compiled ahead of time to one native executable ([source](https://github.com/opensec-git/Pi-Bolt), npm package `pi-bolt`, MIT license). It has the commands, sessions, settings, providers and extensions of Pi. Builds exist for Linux x86-64 and ARM64, macOS on Apple silicon and Windows x64. The kit does not install it.

The install line of the Pi-Bolt README installs it to `~/.pi-bolt` and links the `pi-bolt` command into `~/.local/bin`. Its installer checks the release checksum.

```sh
curl -fsSL https://pi-bolt.opensec.in/install.sh | sh
```

One Pi-Bolt release carries one Pi version. `pi-bolt --version` prints the Pi version first, for example `1.5.2 (Pi-Bolt 1.2.1, linux-x64, JIT off)`. Use the Pi-Bolt release `runtime.piBoltVersion` of the manifest, the selected Pi-Bolt release. When the Pi-Bolt pin lags behind the Pi pin, it carries an older Pi than `runtime.piVersion`, and then `untested_in_range` is the expected result. Check it:

```sh
python3 scripts/check_runtime.py --pi "$(command -v pi-bolt)"
```

The `pi` entry of the report then has a `piBolt` field with the installed and the tested Pi-Bolt release. Select Pi-Bolt with `--runtime pi-bolt` of [install.sh](#run-installsh). The pin does not prove compiled-runtime qualification. Read the [Pi-Bolt update effects](UPDATE.md#with-pi-bolt-as-the-runtime) before an upgrade.

## Clone

```sh
git clone <kit repository URL> ~/tenant-pi
cd ~/tenant-pi
```

Keep the clone in its place. The profile names `packages/tenantext` inside it.

## Run install.sh

`install.sh` installs the question package, so the first start installs nothing.

```sh
./install.sh
```

The script offers an upgrade of an existing named profile or a new alternate profile in `~/.pi/profiles/<name>`. It asks for shell setup and optional modules, then shows the proposed changes for approval. In a terminal, the optional modules and the runtime come on [one screen](#choose-on-one-screen). The inherited `PI_CODING_AGENT_DIR` is only a suggestion. Without a terminal, supply every choice through the flags in `install.sh`.

The module question and `--with` accept `wiki`, `hermes`, `mcp`, `mcp-codemode`, `computer-use`, `computer-use-macos`, `okknow`, `artifacts`, `walkr` and the six AWS rows (`aws-core`, `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops`, `aws-startup-advisor`, `aws-emulator`), separated by commas, or `all` or `none`. `all` means every optional module of your platform, without `mcp-codemode` and without the AWS rows: `computer-use` on Linux, `computer-use-macos` on macOS. Without a terminal, `--with all` needs the okknow origin and the two artifacts variables, as `--with okknow` and `--with artifacts` do. Use `all` and `none` alone, not with other names:

```sh
./install.sh --new main --shell bash --with computer-use --yes
```

On a Mac, in zsh:

```zsh
./install.sh --new main --shell zsh --with computer-use-macos --yes
```

- `computer-use` is for Linux only, and `computer-use-macos` is for macOS only. The module question offers the module of your platform. On another platform the script stops before its first write.
- `--with computer-use`, `--with computer-use-macos` or `--with all` is your yes to desktop control. After one of them or `all` as an answer to the module question, the script asks about desktop control before the install. A no stops the script before its first write.
- `computer-use-macos` also writes the safe settings block `pi-computer-use` into the profile settings. See [computer use on macOS](docs/guides/modules.md#computer-use-on-macos).
- `walkr` installs the dependencies of `<clone>/packages/walkr` with `npm ci --ignore-scripts --omit=dev` links the six Walkr commands into `~/.local/bin` and runs the Walkr setup. The setup writes the Walkr skills to `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`, and the Walkr prompts to `<profile>/prompts`. It needs the `node` and `npm` commands. See [walkr](docs/guides/modules.md#walkr).
- `okknow` adds the package `<clone>/packages/okknow` to the profile, links the CLI to `~/.local/bin/okknow` and runs its setup wizard. Without a terminal, set `OKKNOW_ORIGIN` to the origin of your OpenKnowledge server. See [okknow](docs/guides/modules.md#okknow).
- `artifacts` adds the package `<clone>/packages/artifacts` to the profile, links the CLI to `~/.local/bin/artifacts` and runs `artifacts setup`. Without a terminal, set `ARTIFACTS_ORIGIN` to the origin of your artifact server and `ARTIFACTS_TOKEN_FILE` to the path of your token file. See [artifacts](docs/guides/modules.md#artifacts).
- When `~/.claude` exists and the `claude` command is on `PATH`, the Claude Code plugin of the module needs a separate yes: `--claude-plugin`, or a yes to its own question. `--yes` does not give it. See [the Claude Code plugin](docs/guides/modules.md#claude-code-plugin).
- The AWS rows add the skills of the [Agent Toolkit for AWS](docs/guides/aws-agent-toolkit.md) from one clone at the pinned commit. With `aws-core` and `mcp` or `mcp-codemode`, they also add the server `aws-mcp`, unsigned by default. They need `git` and network access, and `aws-mcp` needs `uv`. The plugin rows need `aws-core`. On an upgrade, the AWS rows follow the selection. A row that the selection leaves out is turned off. The run removes only the parts of the kit: the skills entries that name the kit clone, and the parts that a kit record names. The Claude Code parts of the AWS rows need their own yes: `--claude-aws`, or a yes to their question. `--yes` does not give it. `--adopt-aws` makes an AWS entry of your own the kit's and moves it to the kit pin.

`--dummies` turns on DUMMIES reports for the profile: a coordinator session ends each reply with a compact report for a junior developer, and `next-prompt` drafts the next action. It needs its own yes: `--dummies`, or a yes to its question. The question comes after the module question or after [the screen](#choose-on-one-screen). A run with `--with` on the command line needs `--dummies`. `--yes` does not give it, and a no changes nothing. See [DUMMIES](docs/guides/modules.md#dummies).

The script writes absent templates from `config/`. It refuses the live profile `~/.pi/agent` and each directory inside the clone. The settings template names `<clone>/packages/tenantext` as a local package and the question extension. The models template has no provider.

When the `herdr` command is on `PATH`, the script runs `herdr integration install pi` for the profile. Herdr writes its Pi reporter to `<profile>/extensions/herdr-agent-state.ts`. With it, the watch of a Pi pane gets the reply text. Without `herdr`, or with the runtime Pi-Bolt (it has its own Herdr reporter), the script prints one `herdr:` line and skips the step. A failed step prints a `herdr:` warning, and the install still exits 0. See [the Herdr Pi integration](docs/herdr-setup.md#the-herdr-pi-integration).

`--runtime pi|pi-bolt|<absolute path>` selects the Pi runtime of the profile. The script looks up `pi` and `pi-bolt` on `PATH`. Without the option, an upgrade keeps the runtime of its launcher. Else the script asks, or the screen offers the key `r`, when `pi` and `pi-bolt` are both on `PATH` and `--yes` is absent. Else it uses `pi`. To switch an existing profile, run an upgrade with the option:

```sh
./install.sh --upgrade main --runtime pi-bolt
```

Missing choices or cancellation exit before writes. `--yes` approves the displayed changes, but not a name conflict. Resolve a conflict separately with `--replace-alias` or an interactive yes.

The installer writes absent templates and keeps the selected directory. It preserves authentication, sessions, memory, models and unrelated settings. A missing or moved tenantext package entry gets an exact JSON proposal and a backup before the approved change. Existing package filters stay filtered. Optional modules use the npm specs in `config/manifest.json`; the installer never upgrades Pi itself.

The alias uses `~/.local/bin/<name>`. This launcher records the runtime choice and the absolute path of the runtime, puts its directory first on `PATH`, and forwards arguments. It clears the inherited session directory and stores no credentials. Run an upgrade after moving Pi, Pi-Bolt or Node. The Pi-Bolt installer links `pi-bolt` to a release file named `pi`. For `pi-bolt`, the launcher records that file when its name is `pi`. Herdr 0.9.5 detects the agent from the process name. On Linux, the Pi-Bolt executable is named `pi`. On macOS, `pi` starts `pi-bin`, and the detection there is not verified. See [the herdr skill](packages/tenantext/skills/herdr/SPAWN.md#2a-resources-tools-and-skills-with-their-locations). Run an upgrade after a change to another Pi-Bolt build, for example the JIT build.

After the profile succeeds, the installer backs up the startup file and writes one named managed block. Bash uses `~/.bashrc`; Zsh uses `${ZDOTDIR:-$HOME}/.zshrc`. A repeat upgrade replaces that block and keeps unrelated content. Symlink startup files and launchers require manual setup instead. The completion report gives the command to load the alias.

When `~/.claude` exists, the installer also links kit skills into `~/.claude/skills`. These are the skills that `config/manifest.json` declares for `packages/tenantext`, the skills of the Pi profile. A folder with a `SKILL.md` that the manifest does not declare gets no link. The installer keeps folders and links to other sources. These links are the default form of the kit skills in Claude Code. The `tenantext` plugin for Claude Code is for the Simplified English hook, `/ste` and `/spawn_agent`. When you have the links, skip the skill build of the plugin. The plugin skills are for a host that does not keep the kit clone. See [Claude Code](docs/guides/modules.md#claude-code).

### Choose on one screen

In a terminal, `install.sh` shows one screen (`--tui`). The screen replaces the module question and the runtime question. It reads the state of the profile with `scripts/kit_inventory.py` and the descriptions in `config/catalog.json`. The left pane lists each resource of the kit by group, with its state in the profile and the plan of this run. The right pane describes the selected row. It starts with the effect when the row is on and when it is off, then says what the row does. It also shows what the row needs and the files that show its state. The top line shows the runtime, its installed version and the pin of the kit. The selected row has reverse video. The drawing shows the first view of a new test profile, with `ops-footer` turned off in its settings file:

```text
 tenant-pi kit: resources of profile demo          runtime pi 1.5.2, pin 1.5.2
┌─ Resources ────────────────────────────────┐┌─ Details ──────────────────────┐
│     Resource             Inst Act Plan     ││ Pi coding agent                │
│─ Core & model defaults ────────────────────││ Name  core                     │
│ (x) core                 yes  on  =keep    ││ Plan  =keep                    │
│ ( ) model-routing        yes  off  off     ││ On    Pi sends your            │
│─ Tenantext extensions ─────────────────────││       conversation to the      │
│ (x) tenantext            yes  on  =keep    ││       model provider with your │
│ (x) codex-accounts       yes  on  =keep    ││       login or key, and a      │
│ (x) context-meter        yes  on  =keep    ││       request can cost money.  │
│ ( ) ops-footer           yes  off  off     ││       Pi writes sessions and   │
│ (x) copilot-usage        yes  on  =keep    ││       logins into the profile  │
│ (x) anthropic-usage      yes  on  =keep    ││       and can download a       │
│ (x) doctor               yes  on  =keep    ││       missing search tool. The │
│ (x) resources            yes  on  =keep    ││       installer does not       │
│ (x) command-rules        yes  on  =keep    ││       install Pi; install it   │
│ (x) next-prompt          yes  on  =keep    ││       at the pin first.        │
│ (x) cross-session-recall yes  on  =keep    ││ Off   No Pi session starts     │
│─ Memory ───────────────────────────────────││       with this profile. Core  │
│ [ ] hermes               no   -    off     ││       cannot be turned off.    │
│ [ ] wiki                 no   -    off     ││ State installed, active        │
└──────────────────────────────────────────v─┘└─────────────────── d more 1/2 ─┘
 +install 0  ^upgrade 1  =keep 20  -remove 0  off 19
 Up/Dn move  Space toggle  a all  n none  ? help  Enter plan  q abort
```

- `Inst` is `yes`, `part` (partly installed) or `no`. `Act` is `on`, `off` or `-` (no switch). `Plan` is `+install`, `^upgrade`, `=keep`, `-remove` or `off` (the run leaves the item absent or off).
- `[x]` is on and `[ ]` is off. `[?]` is on and waits for your consent. `[!]` needs another platform and stays off. `(x)` and `( )` are set by the installer, not a choice of this run.
- Colors repeat the glyphs. With `NO_COLOR` set, or on a terminal without color, the glyphs and bold, dim and underlined text remain.
- Up and Down move one row, and PgUp and PgDn move one page. Space turns a module on or off. `a` turns on each module, except a module that needs your consent, another platform or a one-of choice (`mcp` or `mcp-codemode`). `n` turns off each module. `?` shows the help with the installed version and the pin of Pi, Pi-Bolt, Node and Python.
- The plan comes from `scripts/kit_inventory.py` with the selection of the screen, as in the dry run. It includes each resource that a module brings, for example `artifacts-prompt` with `artifacts`. The screen asks for it when you stop for a moment after a change, and before it shows the plan table. When the planner fails, the screen shows its error, and Enter in the plan table asks it again instead of a confirmation.
- `r` switches the runtime. The screen then reads the state of the profile again for that runtime, and the state and the plan of each row change. Your module selection stays. An upgrade keeps the runtime that its launcher records, so the screen offers no other runtime for a profile with a launcher. To switch, run the upgrade with `--runtime`.
- When the details do not fit, the mark `d more 1/2` shows in the border of the right pane. `d` shows the next page.
- `p` and Enter show the plan as a table: the modules to install, upgrade, keep and remove, and the runtime. Up and Down scroll a long table, and a mark such as `rows 1-17 of 20` shows the position. Enter there confirms the plan. `q` aborts, and the script writes nothing.
- A profile with both `mcp` and `mcp-codemode` starts with `mcp` on and `mcp-codemode` off.
- An AWS plugin row needs `aws-core`: Space on the row turns `aws-core` on too, and Space on `aws-core` turns the plugin rows off. The Claude Code question of the AWS rows follows the screen.

A row starts on only when the item is active in the profile (`Act` is `on`). The plan never turns a row on. An installed item with its own switch off starts off, also when its plan is `^upgrade`. Then the run repairs the item and leaves its switch off. In the drawing, `ops-footer` is installed with its switch off, so its row starts off and the run leaves it off.

One exception: the kit step. An upgrade adds a new kit item once to a filter list of the Tenantext entry: a list of plain names, or a delta list (`autoload: false`), that does not name the item. In an entry without `autoload: false`, a missing key, an empty list (`[]`) and a list of only `!`, `+` or `-` entries stay as they are. A delta list gets the item in each of these forms. The step of `herdr-idle-cleanup` adds the `handoffs` extension, the skill and the prompt. When Pi loads the item after the step for the runtime of the run, its row shows `Act` `off` and `Plan` `+install`, and the item is on after the run. A `!` pattern, a disabled link in the profile or the Pi-Bolt package list can keep the item off after the step. Then the row shows `^upgrade`, and the item stays off. `kit-steps.json` of the profile records the step, so a later removal by you stays. See [resources](docs/resources.md).

When the profile uses the packages of another clone, each Tenantext row shows `^upgrade`: the run moves the package entries to this clone. A command link of okknow or artifacts that points to another place stays, and the dry run shows it as `skipped`.

The consent rule: a module with `consent` in its `needs` in `config/catalog.json` turns to `[?]` on Space, not to `[x]`. The selection of the screen lists it as requested. After the screen, the script asks for that consent before the first write. `computer-use` and `computer-use-macos` get the desktop control question, as after the module question. The other requested modules get one question together. A no cancels the run. A module that is on at the start shows `[x]`. It gets no new consent question, except the desktop control question.

DUMMIES is not a choice on the screen. Its mark shows the state of the profile: on only when the profile has the autostart block and the switch is on for Pi. The switch is shared by all your profiles, so a profile without the block shows off. With `--dummies`, the plan of the row shows that the run turns DUMMIES on or keeps it on. The mark does not change. Without `--dummies`, the DUMMIES question follows the screen. When DUMMIES is on in the profile already, the script prints one `DUMMIES:` line in place of the question and keeps it on. Then the selection takes the path of `--with`.

The installer removes no module that you turn off. An installed module that you turn off stays installed, and the plan shows `=keep`. Two exceptions. `mcp-codemode` replaces the MCP adapter: with `mcp-codemode` on, an installed `mcp` shows `-remove`, the run takes the adapter package out of `settings.json`, and its server file stays. An AWS row that the kit installed and that you turn off shows `-remove`: the run takes out only the entries that the kit wrote, and the clone stays. To remove another module, see [the optional modules](#optional-modules).

`--plain` keeps the questions. `--yes`, `--with` or no terminal skip the screen, also with `--tui`. Without `scripts/kit_inventory.py` or `config/catalog.json`, the script prints one `tui:` line and asks the questions. When the inventory fails, or the screen stops with an error, the script prints the error and one `tui:` line. Then it asks the questions. An unknown terminal type and an unexpected error in the screen take this path. An abort on the screen with `q` or Ctrl-C cancels the run. On a terminal smaller than 80x24, the screen asks you to make the terminal larger, or to press `q` to abort.

To see the state and the plan without the screen, use `--inventory`. It shows each resource of the kit for one profile, then exits 0. It asks no choice question and writes no file in the profile or in your home. The version check of Pi makes an empty temporary directory and removes it.

```sh
./install.sh --inventory --upgrade main
```

The table has one box for each group of `config/catalog.json`. A row shows whether the item is installed, whether it is active in the profile, the installed version against the kit pin, and the plan of a run. `●` means yes, `◐` partial, `○` no and `–` not applicable. The About column shows the start of the description; `config/catalog.json` has the full text and the effects of on and off. The last box counts the plan. Keep means that the item is on and the run leaves it; skip means that the run leaves the item absent or off. Upgrade means that the run repairs or updates the item; an item that is off stays off, so an upgrade row can show active `○`. An install row with installed `●` is the [kit step](#choose-on-one-screen): Pi loads the item after the step for the runtime of the run, so the run turns it on once. When the profile keeps the item off after the step, the row shows upgrade. Without `--with`, the plan keeps the optional modules that the profile has now. Without `--shell`, the plan leaves the launcher and the shell block; a run asks for the shell and rewrites a launcher that misses a line of this installer. Add `--with`, `--shell`, `--dummies`, `--claude-plugin`, `--claude-aws`, `--adopt-aws` or `--runtime` to see the plan of other choices. Without `--runtime`, the runtime is the one of the launcher, else `pi`. The table has color only in a terminal, and `NO_COLOR` turns the color off.

`--dry-run` asks the choice questions that a normal run asks before its first write. These are the screen or the module question, the consent questions, the DUMMIES question and the Claude Code plugin questions. The setup wizards of okknow and artifacts come after the first write. So a dry run does not ask their questions; it says when the wizard asks for the origin. It prints the proposed changes and the plan table of your choices, then exits 0 before the conflict question, the approval and the first write. After the screen, the plan table shows the selection of the screen.

```sh
./install.sh --upgrade main --shell bash --dry-run
./install.sh --upgrade main --shell bash --with wiki,mcp --dry-run
```

Both flags work without a terminal when the flags give each choice. `python3 scripts/kit_inventory.py --kit <clone> --profile <profile>` prints the same state as JSON. The top of the script describes the JSON form.

## Optional modules

Each optional module is one `pi install` line. Use the `PI_CODING_AGENT_DIR` of the profile. Run only the lines of the modules that you want. With Pi-Bolt as the runtime, use `pi-bolt install` in place of `pi install`. Like Pi, it adds the package to the shared `packages` list of the profile. It uses `npm` on `PATH`, or its own built-in package manager when `npm` is absent. The launcher `~/.local/bin/<name> install <spec>` runs the runtime of the profile with the profile directory.

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-mcp-adapter@7.0.1
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-hermes-memory@0.11.0
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@zosmaai/pi-llm-wiki@0.12.5
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@agent-sh/computer-use-linux@0.7.51
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@amaster.ai/pi-computer-use@0.1.38
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install "$HOME/tenant-pi/packages/openviking-pi/index.ts"
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install "$HOME/tenant-pi/packages/agentcore-pi/index.ts"
```

After an `npm:` line, correct the host-provided peers of the installed manifests:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

The script prints one line for each manifest that it corrects, and nothing when no manifest needs a correction. See [host peer overrides](docs/host-peer-overrides.md).

| Module | Before the line | What it does |
| --- | --- | --- |
| `mcp` | Read the README of `pi-mcp-adapter` for its server file. | Connects MCP servers through the adapter. Pi has a built-in MCP client too; to use only the adapter, add `"-builtin:mcp"` to the `extensions` list of `<profile>/settings.json`. |
| `mcp-codemode` | Install it with `install.sh --with mcp-codemode`, in a second profile; it has no `pi install` line. `--with all` leaves it out, and `install.sh` refuses it together with `mcp`. See [MCP with codemode](docs/guides/modules.md#mcp-with-codemode). | Connects MCP servers through Pi itself and activates `codemode`, for a comparison with the adapter. An upgrade removes the adapter package from the settings. |
| `hermes` | Write [the Hermes config file](docs/memory-modules.md#the-hermes-config-file); without it, the package defaults make model calls of their own. | Stores memory of the sessions in `<profile>/pi-hermes-memory/`. |
| `wiki` | Read [an existing vault](docs/memory-modules.md#an-existing-vault). | Uses the personal vault `~/.llm-wiki` of the account, or `$WIKI_HOME/.llm-wiki`. An existing vault stays as it is. With the default settings, text of the vault goes into each prompt and so to the model provider. |
| `computer-use` | Read [computer use](docs/guides/modules.md#computer-use). The module needs Linux, a graphical session with AT-SPI accessibility, and network access for its binary download. | The official computer-use module of the kit for Linux. Its tools read the accessibility tree, take screenshots and send input to your desktop. Screen content goes into the conversation and so to the model provider. |
| `computer-use-macos` | Read [computer use on macOS](docs/guides/modules.md#computer-use-on-macos). The module needs macOS 13 or later. Status: not verified on a Mac. Cua Driver sends telemetry by default; see the [open gaps](docs/guides/modules.md#open-gaps). | The computer-use module of the kit for macOS: Cua Driver through a Pi extension. Its tools read the accessibility tree, take screenshots and send input to your Mac. Screen content and typed text go into the conversation and so to the model provider. macOS asks for the grants at the first tool call. |
| `okknow` | An OpenKnowledge server of your own, and `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` in your shell. Install it with `install.sh --with okknow`; it has no `pi install` line. See [okknow](docs/guides/modules.md#okknow). | The skill and the CLI `okknow` for that one server, over MCP first, then the CLI. The kit skills `dummies`, `research`, `to-spec`, `to-tickets`, `wayfinder`, `retro` and `get-status` use it. |
| `artifacts` | An artifact server of your own and a token file with its bearer token. Install it with `install.sh --with artifacts`; it has no `pi install` line. See [artifacts](docs/guides/modules.md#artifacts). | The skill and the CLI `artifacts`: an agent stores an HTML or Markdown file on that server and gives you the view link. The file goes to that server after a secret scan. |
| `walkr` | The `node` and `npm` commands, and a browser on the same computer or a reviewed network setting. Install it with `install.sh --with walkr`; it has no `pi install` line. See [walkr](docs/guides/modules.md#walkr). | The review tool Walkr: you look at pages, text and options of a change in a browser, and the agent gets your notes, picks and ratings. It starts a local web server on `127.0.0.1` of the account. |
| `openviking` | `npm ci --ignore-scripts` in `<clone>/packages/openviking-pi`, and an OpenViking server that you set up. | Sends session content to that server and recalls it. See [OpenViking](docs/memory-modules.md#openviking-what-the-vendored-source-does). |
| `agentcore` | `npm ci --ignore-scripts` in `<clone>/packages/agentcore-memory-core`, and the AWS resources of the owner. | Recalls and proposes memories in AWS AgentCore Memory. Start Pi with `AGENTCORE_MEMORY_CONFIG_FILE`; see [start and setup](docs/memory-modules.md#start-and-setup). |
| `aws-core`, `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops`, `aws-startup-advisor`, `aws-emulator` | `git`, network access, and `uv` for the server `aws-mcp`. AWS access for real AWS work. Install them with `install.sh --with`; they have no `pi install` line. `--with all` leaves them out. The Claude Code plugins need `--claude-aws` or a yes. See [Agent Toolkit for AWS](docs/guides/aws-agent-toolkit.md). | The skills of the five plugins of the Agent Toolkit for AWS and the `aws-emulator` skill, from one clone at the pinned commit. `aws-core` with `mcp` or `mcp-codemode` adds the AWS MCP server `aws-mcp`, unsigned unless AWS credentials are found. The skills guide the agent to run AWS commands with your access. |

- Each `npm:` line has the exact version that the kit reviewed, the `source.spec` of the module in `config/manifest.json`. The question extension of the core install has an exact version too. `pi update --extensions` does not move an exact version; see [the module versions](UPDATE.md#the-module-versions).
- The `computer-use` line can print an `npm warn install-scripts` line that names `npm/install.js`. Observed with version 0.7.24: the script still ran and downloaded the binary.
- `install.sh --with computer-use` installs the same spec, from `config/manifest.json`. Do not run the line on a platform other than Linux.
- Run the `computer-use-macos` line only on macOS. `install.sh --with computer-use-macos` installs the same spec and also writes the settings block `pi-computer-use`; the line alone uses the defaults of the package, which have the same values.
- A `pi install` line loads each resource that the package declares. The `wiki` package declares a skill, prompt commands and an MCP server too; see [the wiki facts](docs/memory-modules.md#wiki-what-the-pinned-source-does) for a filter.
- The `wiki` line prints an npm audit summary with a count of vulnerabilities. The output is expected. Do not run `npm audit fix` in the profile: it changes the installed packages, and it can undo the peer correction.
- Observed with Pi 1.3.0: `pi install` of a local path writes the path relative to `<profile>` into `settings.json`. Keep the clone and the profile in their places.
- To remove a module, run `pi remove` with the same source.

## First start

```sh
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi
```

- `env -u PI_CODING_AGENT_SESSION_DIR` keeps the sessions in `<profile>/sessions`. Without it, an inherited `PI_CODING_AGENT_SESSION_DIR` moves the sessions of each profile.
- `install.sh` installed the question extension, so the first start does not install it.
- Pi can download `fd` and `ripgrep` into `<profile>/bin/` when they are not on `PATH`.
- Log in with `/login` and select a model with `/model`. Pi stores the login in `<profile>/auth.json`. The kit writes no credential.
- For the Tenantext gateway, export `TENANTEXT_LITELLM_BASE_URL` (the gateway URL, usually with `/v1`) and `TENANTEXT_LITELLM_API_KEY` in the shell that starts Pi. The `codex-accounts` extension then registers the provider `litellm-codex`. Its models are in `packages/tenantext/docs/codex-routing.md`.
- For a direct provider, such as llama-swap or vLLM, add it to `<profile>/models.json`. See [the provider guide](docs/guides/providers.md).
- A non-interactive SSH command, a browser terminal, a desktop launcher or a service does not always read your startup file. Check a key in the shell that starts Pi, without printing it: `test -n "${TENANTEXT_LITELLM_API_KEY:-}" && echo set || echo unset`.
- In Claude Code, start a new session to load the linked skills.

Done when Pi starts with no extension error, and the chosen model replies to a prompt.

## Updates

An update is `git pull` in the clone, then `/reload` in each Pi session. See [UPDATE.md](UPDATE.md) and [POST_INSTALL.md](POST_INSTALL.md).
