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

The script writes absent templates from `config/`. It refuses the live profile `~/.pi/agent` and each directory inside the clone. The settings template names `<clone>/packages/tenantext` as a local package and the question extension. The models template has no provider.

Missing choices or cancellation exit before writes. `--yes` approves the displayed changes, but not a name conflict. Resolve a conflict separately with `--replace-alias` or an interactive yes.

The installer writes absent templates and keeps the selected directory. It preserves authentication, sessions, memory, models and unrelated settings. A missing or moved tenantext package entry gets an exact JSON proposal and a backup before the approved change. Existing package filters stay filtered. Optional modules use the npm specs in `config/manifest.json`; the installer never upgrades Pi itself.

The alias uses `~/.local/bin/<name>`. This launcher records the absolute Pi path, puts its directory first on `PATH`, and forwards arguments. It clears the inherited session directory and stores no credentials. Run an upgrade after moving Pi or Node.

After the profile succeeds, the installer backs up the startup file and writes one named managed block. Bash uses `~/.bashrc`; Zsh uses `${ZDOTDIR:-$HOME}/.zshrc`. A repeat upgrade replaces that block and keeps unrelated content. Symlink startup files and launchers require manual setup instead. The completion report gives the command to load the alias.

When `~/.claude` exists, the installer also links kit skills into `~/.claude/skills`. It keeps folders and links to other sources.

## Optional modules

Each optional module is one `pi install` line. Use the `PI_CODING_AGENT_DIR` of the profile. Run only the lines of the modules that you want:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-mcp-adapter
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:pi-hermes-memory
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi install npm:@zosmaai/pi-llm-wiki
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
| `openviking` | `npm ci --ignore-scripts` in `<clone>/packages/openviking-pi`, and an OpenViking server that you set up. | Sends session content to that server and recalls it. See [OpenViking](docs/memory-modules.md#openviking-what-the-vendored-source-does). |
| `agentcore` | `npm ci --ignore-scripts` in `<clone>/packages/agentcore-memory-core`, and the AWS resources of the owner. | Recalls and proposes memories in AWS AgentCore Memory. Start Pi with `AGENTCORE_MEMORY_CONFIG_FILE`; see [start and setup](docs/memory-modules.md#start-and-setup). |

- An `npm:` line without a version installs the newest version of the registry. The question extension of the core install has an exact version.
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
