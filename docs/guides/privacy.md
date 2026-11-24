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
- `PATH`: no script changes the `PATH` of the shell of the user. The launcher `~/.local/bin/<name>` puts the directory of the selected runtime first on `PATH` for the runtime that it starts. With the okknow CLI link of the kit in `~/.local/bin`, the launcher also adds that directory at the end of `PATH`.
- Packages: after the approval, `install.sh` installs the question module and the optional modules of `--with`. It runs `<runtime> install <spec>` for each module, with the profile directory. No script runs `pip`, `git` or a system package manager.
- Runtime: `install.sh` runs the selected runtime (`pi`, `pi-bolt` or the path of `--runtime`) only for these module installs. `scripts/check_runtime.py` runs `pi --version` with an empty temporary `PI_CODING_AGENT_DIR`. With `--pi` or `--launcher`, the check runs that runtime, for example Pi-Bolt, the same way.

None of the scripts:

- starts, stops or configures a service, a timer or a daemon;
- opens a network connection itself or makes a model call. The runtime downloads the modules that `install.sh` installs, through `npm` or the package manager of Pi-Bolt;
- reads `auth.json`, a session or a memory store;
- copies auth, sessions, memory, queues, keyring state or installed packages between profiles;
- writes, prints or resolves a secret value.

Exception: only after a separate yes, `install.sh` also runs the `claude plugin` commands of the computer-use module. Two of them, the marketplace add and the plugin install, use the network.

Exception: with an AWS row (`aws-core`, `aws-agents`, `aws-data-analytics`, `aws-agents-for-devsecops`, `aws-startup-advisor`, `aws-emulator`), `install.sh` runs `git clone` and `git fetch` of the Agent Toolkit for AWS from GitHub when the kit clone is absent or not at the pin. Only after the separate yes `--claude-aws`, it runs the `claude plugin` and `claude mcp` commands of the AWS rows. The plugin commands read the plugins from the kit clone. Not verified: whether Claude Code sends a request of its own during them. The server `aws-mcp` runs only in a session. It downloads the proxy with `uvx` and sends tool calls to the AWS MCP endpoint. The calls are unsigned unless `AWS_MCP_PROXY_PROFILES` names a profile. See [Agent Toolkit for AWS](aws-agent-toolkit.md#signing).

Exception: with `--with agy` and the OpenViking Claude Code plugin, the hooks of `agy` send the conversation of each session to your OpenViking server. This happens in each later `agy` session, not during the run of `install.sh`.

Exception: with `--with okknow`, `install.sh` runs `okknow setup`. The wizard probes the chosen origin once: a GET of `/` and a POST to `/mcp` without credentials. It sends an MCP `initialize` and `tools/list` with HTTP Basic authentication only after the user answers yes to `Send OPENKNOWLEDGE_USERNAME/PASSWORD to <origin>?`; with `--yes`, only with `--probe-auth`, which `install.sh` does not pass. It sends nothing to another host and writes no credential.

`install.sh` writes the absent files of the profile directory, the launcher, the managed block above and the links in `~/.claude/skills`. With `--with okknow`, it also writes the link `~/.local/bin/okknow`, the user config `~/.config/okknow/config.json` (the origin only) and the `okknow` entry (a header command, not a credential) of `<profile>/mcp-adapter.json` with `mcp`, or of `<profile>/mcp.json` with `mcp-codemode`. With `--with artifacts`, it writes the link `~/.local/bin/artifacts` and no configuration. With `--with agy`, it writes links in `~/.gemini/config/rules/` and `~/.gemini/config/skills/` and the kit keys of `~/.gemini/config/hooks.json`. With the OpenViking Claude Code plugin, it also writes the `openviking` entry of `~/.gemini/config/mcp_config.json` and three allow rules in `~/.gemini/antigravity-cli/settings.json`. Before it changes an existing JSON file, it makes one backup of that file. With the `herdr` command on `PATH`, it also runs `herdr integration install antigravity-cli`. With an AWS row, it writes the kit clone in `~/.local/share/tenant-pi/git` and the skills entries of the profile settings. With `aws-core` and `mcp` or `mcp-codemode`, it writes the `aws-mcp` entry (no credential and no profile name) and its record `<profile>/kit-aws.json`. With `--claude-aws`, it writes the `deniedMcpServers` entries of the kit into `~/.claude/settings.json`, the user-scope server `aws-mcp` with `claude mcp add-json`, and the record `~/.local/share/tenant-pi/kit-aws-claude.json`. Without `aws-core`, `--claude-aws` and `aws-emulator` write the link `~/.claude/skills/aws-emulator`. The run removes or replaces a skills entry only when it names the kit clone, and another part only when a kit record names it and the part equals the record. It writes `~/.claude/settings.json` again as a whole, with the indent that it found, and only while the file holds what the kit read. It changes an existing settings file only after an approved proposal, and it backs up the file first. `scripts/patch_extension_peers.mjs` rewrites only the `package.json` files of installed npm modules of the profile; see [host peer overrides](../host-peer-overrides.md).

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
| `ops-footer` | Sends unauthenticated GET requests to configured health URLs from `OPS_FOOTER_OK_HEALTH_URL`, `OPS_FOOTER_OV_HEALTH_URL` or its settings. Empty URLs disable requests. When the `okknow` CLI is present, runs `okknow --json doctor` at most once in 5 minutes; the CLI sends the credentials to its configured origin only, and the footer keeps only the state word. When `agy` is on the `PATH` and the setting `antigravityUsage` is not `off`, runs `agy -p "/usage" --output-format json` at most once in 5 minutes for all Pi sessions of the computer; `agy` sends its own sign-in to its provider. With `auto`, the footer first checks that the `agy` sign-in file `~/.gemini/antigravity-cli/antigravity-oauth-token` exists, with `stat` only; it never opens that file or any other `agy` file. Without a sign-in, `agy` itself can open a browser for the sign-in; the footer then stops it and runs no `agy` for 6 hours. `agy` also checks for its own updates. Receives usage readings from other components, not their login files. | Writes `<profile>/ops-footer/settings.json` and `settings.example.jsonc`, and the shared Antigravity reading `~/.cache/claude-pi-footer/antigravity-usage.json` (times, group names, percents and reset times; no account name or address). |
| `tracker-site` | Reads `GITEA_TOKEN`, the configured token variable or token file for GET headers to `issues.api` or `TRACKER_ISSUES_API`. Publication reads a credential file for Bearer-authenticated HTML POST or PUT requests. Updates also send the receipt edit token; a GET checks the share URL. OpenKnowledge detection reads `~/.claude.json` and `~/.pi/agent/mcp.json`; the store adapter makes no remote writes. | Writes the repository brief and, by default, `~/.pi/agent/tracker-state/<repo-slug>/`. Writes publication receipts with edit tokens under `~/.pi/agent/tracker-publications/`. Both defaults are in the live profile, not the profile of `PI_CODING_AGENT_DIR`. |
| `skill-doctor` | By default reads the Claude Code and Pi sessions from the OpenViking server that the OpenViking configuration names (`OPENVIKING_*` variables, `~/.openviking/ovcli.conf`, `~/.openviking/ov.conf`; with `OPENVIKING_CREDENTIAL_SOURCE=env` the variables only), and the sessions of your other agent harnesses from their local files. It sends GET requests only, with the API key of that configuration in the `Authorization` header and the account and user of that configuration in the identity headers, and uses no proxy and no redirect. Without a configured server, when the server does not answer (a connection error, a timeout, HTTP 5xx, a health reply with `healthy: false`), or with `--source local`, it reads the local session files of all your agent harnesses instead. A refused credential ends the run without a local read. Reads the installed skill files, read-only, and runs `git` to find the repositories and their `origin` remote. `--open` starts the default browser on the report file. | Writes the collected sessions, `report.json` and `report.html` to a new temporary directory from `mktemp -d`, never into a repository. The report holds excerpts of transcripts: share it only on purpose. |
| `okknow` | Reads `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` and sends them as HTTP Basic authentication to the configured origin only: MCP requests to `/mcp` and GET requests to `/api/document`. Refuses another origin, redirects and proxies. `auth-header` prints the header only to a pipe, for the MCP header command. | Writes `~/.config/okknow/config.json` with `okknow setup`, and a copy of a page under `~/.cache/okknow/backups/` before a replace. |
| `memory` | The memory viewer of the local server. With no settings file it reads only its synthetic sample data and sends no request. With `~/.config/tenant-artifacts/memory-sources.json` (mode 0600) it reads the private memory that the file names and shows it on the page `/memory/` of the local server, which needs no login: an OpenViking key and an OpenKnowledge user name and password from credential files of mode 0600, sent only to the server address of that source; the files of an llm-wiki vault and of hermes-memory; AgentCore memory records through the named sign-in profile of your AWS configuration. It reads no credential from an environment variable. Nothing that it reads goes to another computer or into a log line. | None toward a memory system, with one exception: the review of an AgentCore source with a `review` setting moves one proposed record. It writes no file. |
| `artifacts` | Reads and sends no credential. Without the key `remote`, it sends no request to another computer. With `artifacts setup --remote HOST`, an upload sends the file, the title, the file name and the repo name to HOST over SSH, after the local scan and only then; `list`, `delete`, `open` and `doctor` send the command and the slugs. `ssh` uses the SSH configuration and keys of the user. Runs the secret scanner of the kit on the file before an upload; the upload writes into the local store, or into the store of HOST. The server listens on `127.0.0.1` and answers `GET` and `HEAD` requests from a loopback address only, with no login: each local user can read the pages. The CLI sends `GET /healthz` to that port. `open` asks Sheprd to show the page in a Herdr pane. | Writes the store `~/.local/share/tenant-artifacts/store/`, the state file and the log in `~/.local/state/tenant-artifacts/`, `~/.config/tenant-artifacts/config.json` with `artifacts setup` or `artifacts retention`, and a scratch copy of the file for the scan in the temporary directory. `artifacts delete` deletes the named artifacts of the store. With a retention setting, the server deletes the older artifacts of the store. With the key `remote`, an upload writes only the scratch copy for the scan on this computer. |

The core install loads `copilot-usage`, `anthropic-usage` and `doctor`. Their login reads and token requests need the user's agreement; switch them off with `/resources` without it.

For the tool download into `<profile>/bin/`, see [the module guide](modules.md#components).

## What the scanner checks

`scripts/scan.sh` checks the tracked files before they leave the host: secrets, host values and files that hide content from the scan. It runs offline. See [secret handling](../secret-handling.md).

The scanner does not check untracked files, a profile directory, a secret that is split over lines or encrypted, or commit author names. `scripts/publish_check.py` also scans each file of the publish set for private-key and token patterns, and for the content classes of [the public reader rules](../publishing.md#public-reader-rules). Neither check is a full secret audit.
