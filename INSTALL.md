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

One Pi-Bolt release carries one Pi version. `pi-bolt --version` prints the Pi version first, for example `1.4.0 (Pi-Bolt 1.0.6, linux-x64, JIT off)`. Use the Pi-Bolt release that carries `runtime.piVersion`. `runtime.piBoltVersion` in the manifest is the tested Pi-Bolt release. Check it:

```sh
python3 scripts/check_runtime.py --pi "$(command -v pi-bolt)"
```

The `pi` entry of the report then has a `piBolt` field with the installed and the tested Pi-Bolt release. Select Pi-Bolt with `--runtime pi-bolt` of [install.sh](#run-installsh).

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

The script offers an upgrade of an existing named profile or a new alternate profile in `~/.pi/profiles/<name>`. It asks for shell setup and optional modules, then shows the proposed changes for approval. The inherited `PI_CODING_AGENT_DIR` is only a suggestion. Without a terminal, supply every choice through the flags in `install.sh`.

The module question and `--with` accept `wiki`, `hermes`, `mcp`, `computer-use`, `computer-use-macos` and `okknow`, separated by commas, or `all` or `none`. `all` means every optional module of your platform: `computer-use` on Linux, `computer-use-macos` on macOS. Without a terminal, `--with all` needs the okknow origin, as `--with okknow` does. Use `all` and `none` alone, not with other names:

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
- `okknow` adds the package `<clone>/packages/okknow` to the profile, links the CLI to `~/.local/bin/okknow` and runs its setup wizard. Without a terminal, set `OKKNOW_ORIGIN` to the origin of your OpenKnowledge server. See [okknow](docs/guides/modules.md#okknow).
- When `~/.claude` exists and the `claude` command is on `PATH`, the Claude Code plugin of the module needs a separate yes: `--claude-plugin`, or a yes to its own question. `--yes` does not give it. See [the Claude Code plugin](docs/guides/modules.md#claude-code-plugin).

`--dummies` turns on DUMMIES reports for the profile: a coordinator session ends each reply with a compact report for a junior developer, and `next-prompt` drafts the next action. It needs its own yes: `--dummies`, or a yes to its question. The question comes only when the installer asks the module question; a run with `--with` on the command line needs `--dummies`. `--yes` does not give it, and a no changes nothing. See [DUMMIES](docs/guides/modules.md#dummies).

The script writes absent templates from `config/`. It refuses the live profile `~/.pi/agent` and each directory inside the clone. The settings template names `<clone>/packages/tenantext` as a local package and the question extension. The models template has no provider.

When the `herdr` command is on `PATH`, the script runs `herdr integration install pi` for the profile. Herdr writes its Pi reporter to `<profile>/extensions/herdr-agent-state.ts`. With it, the watch of a Pi pane gets the reply text. Without `herdr`, or with the runtime Pi-Bolt (it has its own Herdr reporter), the script prints one `herdr:` line and skips the step. A failed step prints a `herdr:` warning, and the install still exits 0. See [the Herdr Pi integration](docs/herdr-setup.md#the-herdr-pi-integration).

`--runtime pi|pi-bolt|<absolute path>` selects the Pi runtime of the profile. The script looks up `pi` and `pi-bolt` on `PATH`. Without the option, an upgrade keeps the runtime of its launcher. Else the script asks when `pi` and `pi-bolt` are both on `PATH` and `--yes` is absent. Else it uses `pi`. To switch an existing profile, run an upgrade with the option:

```sh
./install.sh --upgrade main --runtime pi-bolt
```

Missing choices or cancellation exit before writes. `--yes` approves the displayed changes, but not a name conflict. Resolve a conflict separately with `--replace-alias` or an interactive yes.

The installer writes absent templates and keeps the selected directory. It preserves authentication, sessions, memory, models and unrelated settings. A missing or moved tenantext package entry gets an exact JSON proposal and a backup before the approved change. Existing package filters stay filtered. Optional modules use the npm specs in `config/manifest.json`; the installer never upgrades Pi itself.

The alias uses `~/.local/bin/<name>`. This launcher records the runtime choice and the absolute path of the runtime, puts its directory first on `PATH`, and forwards arguments. It clears the inherited session directory and stores no credentials. Run an upgrade after moving Pi, Pi-Bolt or Node. The Pi-Bolt installer links `pi-bolt` to a release file named `pi`. For `pi-bolt`, the launcher records that file when its name is `pi`. Herdr 0.9.5 detects the agent from the process name. On Linux, the Pi-Bolt executable is named `pi`. On macOS, `pi` starts `pi-bin`, and the detection there is not verified. See [the herdr skill](packages/tenantext/skills/herdr/SPAWN.md#2a-resources-tools-and-skills-with-their-locations). Run an upgrade after a change to another Pi-Bolt build, for example the JIT build.

After the profile succeeds, the installer backs up the startup file and writes one named managed block. Bash uses `~/.bashrc`; Zsh uses `${ZDOTDIR:-$HOME}/.zshrc`. A repeat upgrade replaces that block and keeps unrelated content. Symlink startup files and launchers require manual setup instead. The completion report gives the command to load the alias.

When `~/.claude` exists, the installer also links kit skills into `~/.claude/skills`. These are the skills that `config/manifest.json` declares for `packages/tenantext`, the skills of the Pi profile. A folder with a `SKILL.md` that the manifest does not declare gets no link. The installer keeps folders and links to other sources. These links are the default form of the kit skills in Claude Code. The `tenantext` plugin for Claude Code is for the Simplified English hook, `/ste` and `/spawn_agent`. When you have the links, skip the skill build of the plugin. The plugin skills are for a host that does not keep the kit clone. See [Claude Code](docs/guides/modules.md#claude-code).

## Optional modules

Each optional module is one `pi install` line. Use the `PI_CODING_AGENT_DIR` of the profile. Run only the lines of the modules that you want. With Pi-Bolt as the runtime, use `pi-bolt install` in place of `pi install`. Like Pi, it adds the package to the shared `packages` list of the profile. It uses `npm` on `PATH`, or its own built-in package manager when `npm` is absent. The launcher `~/.local/bin/<name> install <spec>` runs the runtime of the profile with the profile directory.

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-mcp-adapter@7.0.0
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-hermes-memory@0.9.11
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@zosmaai/pi-llm-wiki@0.12.5
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@agent-sh/computer-use-linux@0.7.27
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@amaster.ai/pi-computer-use@0.1.32
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
| `hermes` | Write [the Hermes config file](docs/memory-modules.md#the-hermes-config-file); without it, the package defaults make model calls of their own. | Stores memory of the sessions in `<profile>/pi-hermes-memory/`. |
| `wiki` | Read [an existing vault](docs/memory-modules.md#an-existing-vault). | Uses the personal vault `~/.llm-wiki` of the account, or `$WIKI_HOME/.llm-wiki`. An existing vault stays as it is. With the default settings, text of the vault goes into each prompt and so to the model provider. |
| `computer-use` | Read [computer use](docs/guides/modules.md#computer-use). The module needs Linux, a graphical session with AT-SPI accessibility, and network access for its binary download. | The official computer-use module of the kit for Linux. Its tools read the accessibility tree, take screenshots and send input to your desktop. Screen content goes into the conversation and so to the model provider. |
| `computer-use-macos` | Read [computer use on macOS](docs/guides/modules.md#computer-use-on-macos). The module needs macOS 13 or later. Status: not verified on a Mac. Cua Driver sends telemetry by default; see the [open gaps](docs/guides/modules.md#open-gaps). | The computer-use module of the kit for macOS: Cua Driver through a Pi extension. Its tools read the accessibility tree, take screenshots and send input to your Mac. Screen content and typed text go into the conversation and so to the model provider. macOS asks for the grants at the first tool call. |
| `okknow` | An OpenKnowledge server of your own, and `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` in your shell. Install it with `install.sh --with okknow`; it has no `pi install` line. See [okknow](docs/guides/modules.md#okknow). | The skill and the CLI `okknow` for that one server, over MCP first, then the CLI. The kit skills `dummies`, `research`, `to-spec`, `to-tickets` and `get-status` use it. |
| `openviking` | `npm ci --ignore-scripts` in `<clone>/packages/openviking-pi`, and an OpenViking server that you set up. | Sends session content to that server and recalls it. See [OpenViking](docs/memory-modules.md#openviking-what-the-vendored-source-does). |
| `agentcore` | `npm ci --ignore-scripts` in `<clone>/packages/agentcore-memory-core`, and the AWS resources of the owner. | Recalls and proposes memories in AWS AgentCore Memory. Start Pi with `AGENTCORE_MEMORY_CONFIG_FILE`; see [start and setup](docs/memory-modules.md#start-and-setup). |

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
- The first start installs the question extension. It needs network access.
- Pi can download `fd` and `ripgrep` into `<profile>/bin/` when they are not on `PATH`.
- Log in with `/login` and select a model with `/model`. Pi stores the login in `<profile>/auth.json`. The kit writes no credential.
- For the Tenantext gateway, export `TENANTEXT_LITELLM_BASE_URL` (the gateway URL, usually with `/v1`) and `TENANTEXT_LITELLM_API_KEY` in the shell that starts Pi. The `codex-accounts` extension then registers the provider `litellm-codex`. Its models are in `packages/tenantext/docs/codex-routing.md`.
- For a direct provider, such as llama-swap or vLLM, add it to `<profile>/models.json`. See [the provider guide](docs/guides/providers.md).
- A non-interactive SSH command, a browser terminal, a desktop launcher or a service does not always read your startup file. Check a key in the shell that starts Pi, without printing it: `test -n "${TENANTEXT_LITELLM_API_KEY:-}" && echo set || echo unset`.
- In Claude Code, start a new session to load the linked skills.

Done when Pi starts with no extension error, and the chosen model replies to a prompt.

## Updates

An update is `git pull` in the clone, then `/reload` in each Pi session. See [UPDATE.md](UPDATE.md) and [POST_INSTALL.md](POST_INSTALL.md).
