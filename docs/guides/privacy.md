# Privacy guide

The kit separates the configuration of one Pi profile from another. It does not isolate the profiles from each other at the operating-system level. This guide says what each layer protects and what it does not.

## Configuration separation is not isolation

| | Configuration separation | OS or remote-account isolation |
| --- | --- | --- |
| What it is | Each profile has its own directory. `PI_CODING_AGENT_DIR` selects it for one Pi process. | A separate OS user, container, virtual machine or remote account. The OS or the service enforces the boundary. |
| What the kit gives | Yes. `install.sh` creates a new profile directory with mode `0700`, and the template files with mode `0600`. | No. The kit creates no user, container, sandbox or account. |
| What it stops | Choices of one profile leaking into the `settings.json` of another. An accidental write into the live profile by the kit. | A process of one profile reading the files of another. |
| What it does not stop | Any process of the same OS user can read every profile and HOME. | Depends on the isolation that you choose. |

A profile directory is not an OS sandbox. These things are shared by every profile of one OS user:

- `HOME` and every file under it, for example `~/.llm-wiki/` of the wiki module, `~/.copilot` that `copilot-usage` reads, and `~/.claude/.credentials.json` that `anthropic-usage` reads.
- The OS keyring. The MCP adapter stores OAuth and bearer tokens there.
- The environment of the launching shell, for example `TENANTEXT_LITELLM_API_KEY`.
- The working directory and its project files. A trusted project `.pi/settings.json` can change Pi settings at launch.
- `$TMPDIR`. The MCP adapter writes spilled tool output there.
- A remote account. Two profiles that log in to the same provider or the same memory service see the same account data. A peer ID or a profile name is not an account boundary.

For a real boundary, run each profile as a separate OS user, in a container, or in a virtual machine, with separate remote accounts. Not verified: any container or sandbox setup with this kit.

## What each location holds

| Location | Holds | Tracked by Git |
| --- | --- | --- |
| The kit clone | Reviewed source, the manifest, the templates, the in-tree packages. No user value. | Yes |
| `.local/` in the clone | Optional. The optional local deny list of the scanner. It can hold private state. | No. The Git ignore rule is not a security control. |
| The profile directory of `install.sh` | `settings.json` and `models.json` from the templates. After the first start, Pi adds `auth.json`, `models-store.json`, `sessions/`, `bin/` (only for a tool download), `npm/` for the npm modules, and module state. | No |
| The live profile `~/.pi/agent` | Your existing Pi setup. | `install.sh` refuses it and never writes it. |
| `~/.claude/skills` | The links of `install.sh` to the skills of `packages/tenantext`, when `~/.claude` exists. | No |

A vault check that opens no file is in [the memory modules](../memory-modules.md#the-vault-check).

The wiki extension itself writes into the vault when the agent uses a wiki tool; see [an existing vault](../memory-modules.md#an-existing-vault).

The core install has no memory module. Install one only after you agree to its storage and recall. Hermes stores text of the sessions below the profile, the wiki in the vault. With `ambientPersonalVault: true`, the package default, the wiki also adds text from the vault to each prompt in each directory, and that text goes to the model provider of the session.

## What the kit does and does not do

The scripts of the kit that a user runs are `install.sh`, `scripts/check_runtime.py` and `scripts/patch_extension_peers.mjs`. They do these things only after a choice of the user:

- Startup file: `install.sh` edits one startup file only after the approval, an interactive yes or `--yes`. It backs up the file and writes one managed block with the alias. Bash uses `~/.bashrc`; Zsh uses `${ZDOTDIR:-$HOME}/.zshrc`. With `--shell none`, it edits no startup file. No script edits `~/.profile`.
- `PATH`: no script changes the `PATH` of the shell of the user. The launcher `~/.local/bin/<name>` puts the directory of the selected runtime first on `PATH` for the runtime that it starts.
- Packages: after the approval, `install.sh` installs the question module and the optional modules of `--with`. It runs `<runtime> install <spec>` for each module, with the profile directory. No script runs `pip`, `git` or a system package manager.
- Runtime: `install.sh` runs the selected runtime (`pi`, `pi-bolt` or the path of `--runtime`) only for these module installs. `scripts/check_runtime.py` runs `pi --version` with an empty temporary `PI_CODING_AGENT_DIR`. With `--pi` or `--launcher`, the check runs that runtime, for example Pi-Bolt, the same way.

None of the scripts:

- starts, stops or configures a service, a timer or a daemon;
- opens a network connection itself or makes a model call. The runtime downloads the modules that `install.sh` installs, through `npm` or the package manager of Pi-Bolt;
- reads `auth.json`, a session or a memory store;
- copies auth, sessions, memory, queues, keyring state or installed packages between profiles;
- writes, prints or resolves a secret value.

Exception: only after a separate yes, `install.sh` also runs the `claude plugin` commands of the computer-use module. Two of them, the marketplace add and the plugin install, use the network.

`install.sh` writes the absent files of the profile directory, the launcher, the managed block above and the links in `~/.claude/skills`. It changes an existing settings file only after an approved proposal, and it backs up the file first. `scripts/patch_extension_peers.mjs` rewrites only the `package.json` files of installed npm modules of the profile; see [host peer overrides](../host-peer-overrides.md).

`scripts/check_runtime.py` starts child processes with the full environment of the caller. It replaces `PI_CODING_AGENT_DIR` for `pi --version`, and it reads `PATH` to find tools. Not verified: the behaviour of an arbitrary executable that the version checks start.

## Credentials

- No template of the kit has a field for a secret value. In `models.json`, write a key as a `$NAME` reference.
- No credential store is required. Export the name in the launching shell, or read it from a store that you already use. A password manager is one example.
- `TENANTEXT_LITELLM_BASE_URL` is public configuration of the start line. `TENANTEXT_LITELLM_API_KEY` is a secret and never enters a file of the kit.
- Pi native `/login` writes `<profile>/auth.json`. That file belongs to Pi.

## Component reads, requests and writes

The kit limits above do not apply to components after launch. The [module table](modules.md) gives their sources and conditions. The following facts come from source reading, not runtime checks.

| Component | Credential and request scope | Write scope |
| --- | --- | --- |
| `copilot-usage` | Reads the Pi login, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, editor `apps.json` and `hosts.json`, Copilot CLI `config.json`, and `gh auth token`. Reads `COPILOT_HOME`, `GH_HOST`, `XDG_CONFIG_HOME` and Windows `LOCALAPPDATA` for discovery. Sends candidate tokens in GET headers to `https://api.<domain>/copilot_internal/user` until one succeeds. Only an HTTP 401, 403 or 404 answer tries the next token. Mode `auto` needs a Copilot provider in Pi. Mode `on` probes regardless. Mode `off` sends nothing. | Refreshes and writes no credential. Reads profile and shared HOME state. |
| `anthropic-usage` | Reads the Claude Code login under `~/.claude` or `CLAUDE_CONFIG_DIR`, then the Pi `anthropic` OAuth login. Sends an active token as Bearer authentication in GET requests to `https://api.anthropic.com/api/oauth/usage`. An authentication refusal tries the other active login, when available; mode `off` sends nothing. | Refreshes and writes no credential. Reads profile and shared HOME state. |
| `doctor` | Reads profile `auth.json`, configured Codex token files and the credential sources of both usage components. Uses their usage endpoints, token headers, authentication fallback and mode conditions. Reads profile and project settings, plus OpenViking configuration when wiki embeddings are configured. | `fix` writes extension settings and copies existing files to `.bak`. The shell fix can add the package to `settings.json` and replace package peer entries under `node_modules/@earendil-works` with links. Without `PI_CODING_AGENT_DIR`, the shell form uses the live `~/.pi/agent`. |
| `context-meter` | With `nextMoveUrl` set, sends at most one POST after each agent run. Sends session counters and the last 300 characters of the last user message, after whitespace normalization. Reads the variable named by `nextMoveKeyEnv` for a Bearer header; [the credential reference](../packages.md#decision-server-credential) names the default key. Empty URL, disabled decisions, unknown context usage, active requests and failure cooldown prevent calls. | Reads and writes `<profile>/context-meter/settings.json`. |
| `ops-footer` | Sends unauthenticated GET requests to configured health URLs from `OPS_FOOTER_OK_HEALTH_URL`, `OPS_FOOTER_OV_HEALTH_URL` or its settings. Empty URLs disable requests. Receives usage readings from other components, not their login files. | Writes `<profile>/ops-footer/settings.json` and `settings.example.jsonc`. |
| `tracker-site` | Reads `GITEA_TOKEN`, the configured token variable or token file for GET headers to `issues.api` or `TRACKER_ISSUES_API`. Publication reads a credential file for Bearer-authenticated HTML POST or PUT requests. Updates also send the receipt edit token; a GET checks the share URL. OpenKnowledge detection reads `~/.claude.json` and `~/.pi/agent/mcp.json`; the store adapter makes no remote writes. | Writes the repository brief and, by default, `~/.pi/agent/tracker-state/<repo-slug>/`. Writes publication receipts with edit tokens under `~/.pi/agent/tracker-publications/`. Both defaults are in the live profile, not the profile of `PI_CODING_AGENT_DIR`. |

The core install loads `copilot-usage`, `anthropic-usage` and `doctor`. Their login reads and token requests need the user's agreement; switch them off with `/resources` without it.

For the tool download into `<profile>/bin/`, see [the module guide](modules.md#components).

## What the scanner checks

`scripts/scan.sh` checks the tracked files before they leave the host: secrets, host values and files that hide content from the scan. It runs offline. See [secret handling](../secret-handling.md).

The scanner does not check untracked files, a profile directory, a secret that is split over lines or encrypted, or commit author names. `scripts/publish_check.py` also scans each file of the publish set for private-key and token patterns, and for the content classes of [the public reader rules](../publishing.md#public-reader-rules). Neither check is a full secret audit.
