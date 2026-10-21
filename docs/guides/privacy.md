# Privacy guide

The kit separates the configuration of one Pi profile from another. It does not isolate the profiles from each other at the operating-system level. This guide says what each layer protects and what it does not.

## Configuration separation is not isolation

| | Configuration separation | OS or remote-account isolation |
| --- | --- | --- |
| What it is | Each profile has its own directory. `PI_CODING_AGENT_DIR` selects it for one Pi process. | A separate OS user, container, virtual machine or remote account. The OS or the service enforces the boundary. |
| What the kit gives | Yes. A new directory for each candidate, mode `0700`, files mode `0600`. | No. The kit creates no user, container, sandbox or account. |
| What it stops | Choices of one profile leaking into the `settings.json` of another. An accidental write into the live profile by the kit. | A process of one profile reading the files of another. |
| What it does not stop | Any process of the same OS user can read every profile, the private directory and HOME. | Depends on the isolation that you choose. |

A profile directory is not an OS sandbox. These things are shared by every profile of one OS user:

- `HOME` and every file under it, for example `~/.llm-wiki/` of the wiki module, `~/.copilot` that `copilot-usage` reads, and `~/.claude/.credentials.json` that `anthropic-usage` reads.
- The OS keyring. The MCP adapter stores OAuth and bearer tokens there (gap `credential_store_shared`).
- The environment of the launching shell, for example `TENANTEXT_LITELLM_API_KEY`.
- The working directory and its project files. A trusted project `.pi/settings.json` can change Pi settings at launch.
- `$TMPDIR`. The MCP adapter writes spilled tool output there.
- A remote account. Two profiles that log in to the same provider or the same memory service see the same account data. A peer ID or a profile name is not an account boundary.

For a real boundary, run each profile as a separate OS user, in a container, or in a virtual machine, with separate remote accounts. Not verified: any container or sandbox setup with this kit.

## What each location holds

| Location | Holds | Tracked by Git |
| --- | --- | --- |
| The kit clone | Reviewed source, the manifest, the synthetic example overlay, the in-tree packages. No user value. | Yes |
| `.local/` in the clone | Optional. The default `--local-dir`, and the optional local deny list of the scanner. It can hold private state. | No. The Git ignore rule is not a security control. |
| The private directory | `overlay.json`, `registry.json`, `install-log.md`, `accepted-drift.md`, `.gitignore`, `inputs/` (for example `inputs/mcp-adapter.json`), launcher files, baseline files, saved `compare` reports, the facts file `results-facts.json` and the results file `INSTALLER_KIT_RESULTS.md`. | Only if you run `git init` there. The kit prints that line and never runs it. |
| A generated profile | `settings.json`, `.tenant-pi/choices.json`, `.tenant-pi/state.json`, optional module files. After launch, Pi adds `auth.json`, `models-store.json`, `sessions/`, `bin/` (only for a tool download) and module state. Pi adds `npm/` with a declared npm package. | No |
| The live profile `~/.pi/agent` | Your existing Pi setup. | The kit never writes it. It reads it only when you name it with `--dir`: `baseline` and `check-baseline` read the name, kind, size and modification time of each entry and open no file; `inventory` reads `settings.json` and lists three directories. |

See the [refusal rules](../private-directory.md#refusal-rules) for protected paths, symbolic links and environment variants.

This command reports the vault from `lstat` calls and opens no file:

```sh
python3 scripts/tenant_pi.py check-wiki-vault
```

The wiki extension itself writes into the vault when the agent uses a wiki tool; see [an existing vault](../memory-modules.md#an-existing-vault).

The sample overlay enables no memory module. A fresh selection leaves optional memory unchecked, and the install flow asks separately for storage and recall consent. Both store text of the sessions on this machine: Hermes below the profile, the wiki in the vault. With the explicit choice `ambientPersonalVault: true`, the wiki also adds text from the vault to each prompt in each directory, and that text goes to the model provider of the session. Without `consent.memoryCapture: true`, nothing is captured.

The `.gitignore` of the private directory ignores `inputs/`, `.env`, `.env.*`, `auth.json`, `models.json`, `mcp-adapter.json`, `sessions/`, `*.key`, `*.pem`, `*.db`, `*.sqlite`, `*baseline*.json`, `INSTALLER_KIT_RESULTS.md` and `results-facts.json`. It is not a security control. Read `git status` before each commit.

`.tenant-pi/choices.json` holds the whole overlay copy, the registry and the MCP definitions of a profile. It holds `${NAME}` references, never a resolved secret. Treat it as private like the overlay.

## What the kit never does

The kit has 13 actions:

- `validate`, `plan`, `generate`, `compare`, `inventory`;
- `check-runtime`, `check-herdr`, `check-wiki-vault`;
- `components`, `init-private`, `baseline`, `check-baseline`, `results`.

None of them:

- edits a shell startup file such as `~/.bashrc`, `~/.zshrc` or `~/.profile`, or changes `PATH`;
- installs a package, runs `npm`, `pip`, `git` or a system package manager;
- starts, stops or configures a service, a timer or a daemon;
- runs `pi`, except `pi --version` inside `check-runtime` with an empty temporary `PI_CODING_AGENT_DIR`;
- opens a network connection or makes a model call;
- reads `auth.json`, a session or a memory store. Explicit validated model inputs and kit-declared candidate model files are the only model-registration reads. `inventory` and `compare` can read `settings.json` in a directory that the user names. `baseline` and `check-baseline` read entry metadata and open no file; see [the directory baseline](../directory-baseline.md);
- copies auth, sessions, memory, queues, keyring state or installed packages between profiles;
- writes, prints or resolves a secret value.

`check-runtime` and `check-herdr` start child processes with the full environment of the caller. `check-runtime` replaces `PI_CODING_AGENT_DIR` for `pi --version`. `check-herdr` runs `herdr --version`, not a Herdr session. Both read `PATH` to find tools. Not verified: the behaviour of an arbitrary executable that these version checks start.

Other Linux environment-value reads use only `HOME`, `WIKI_HOME`, `PATH`, `TMPDIR`, `TEMP`, `TMP`, `COLUMNS`, `LINES`, `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG` (source reading). This bound excludes the full-environment copies for the two version checks. Python's temporary-directory helper checks `TMPDIR`, `TEMP` and `TMP`. Its argument formatter checks `COLUMNS` and `LINES`. Its message translator checks `LANGUAGE`, `LC_ALL`, `LC_MESSAGES` and `LANG`. Not verified: environment reads during Python startup or on other platforms.

The path guards read `HOME` and `WIKI_HOME`. `check-wiki-vault` reads both to locate vaults. `plan` tests provider key names for presence; see [the warning](../profile-plan.md#the-warning-for-a-provider-key-variable).

The plan prints dependency and launch commands as display text (`setupDisplayOnly`, `launchDisplayOnly`). The user reads them and runs them by hand. The kit test suite checks these limits with audit hooks for file opens, processes and sockets. Not verified: a proof that no other file is opened; the audit lists forbidden names.

## Credentials

- The overlay has no field for a secret value. An `env` value is a `${NAME}` reference. The kit rejects `$`, backticks and `{{` elsewhere.
- No credential store is required. Export the name in the launching shell, or read it from a store that you already use. A password manager is one example.
- `TENANTEXT_LITELLM_BASE_URL` is public configuration on the launch line. `TENANTEXT_LITELLM_API_KEY` is a secret and never enters a file of the kit.
- Pi native `/login` writes `<target>/auth.json`. That file belongs to Pi.
- A `compare` report shows a marker, not a value, for a private field.

## Component reads, requests and writes

The kit limits above do not apply to components after launch. The [module table](modules.md) gives their sources and conditions. The following facts come from source reading, not runtime checks.

| Component | Credential and request scope | Write scope |
| --- | --- | --- |
| `copilot-usage` | Reads the Pi login, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, editor `apps.json` and `hosts.json`, Copilot CLI `config.json`, and `gh auth token`. Reads `COPILOT_HOME`, `GH_HOST`, `XDG_CONFIG_HOME` and Windows `LOCALAPPDATA` for discovery. Sends candidate tokens in GET headers to `https://api.<domain>/copilot_internal/user` until one succeeds. Only an HTTP 401, 403 or 404 answer tries the next token. Mode `auto` needs a Copilot provider in Pi. Mode `on` probes regardless. Mode `off` sends nothing. | Refreshes and writes no credential. Reads profile and shared HOME state. |
| `anthropic-usage` | Reads the Claude Code login under `~/.claude` or `CLAUDE_CONFIG_DIR`, then the Pi `anthropic` OAuth login. Sends an active token as Bearer authentication in GET requests to `https://api.anthropic.com/api/oauth/usage`. An authentication refusal tries the other active login, when available; mode `off` sends nothing. | Refreshes and writes no credential. Reads profile and shared HOME state. |
| `doctor` | Reads profile `auth.json`, configured Codex token files and the credential sources of both usage components. Uses their usage endpoints, token headers, authentication fallback and mode conditions. Reads profile and project settings, plus OpenViking configuration when wiki embeddings are configured. | `fix` writes extension settings and copies existing files to `.bak`. The shell fix can add the package to `settings.json` and replace package peer entries under `node_modules/@earendil-works` with links. Without `PI_CODING_AGENT_DIR`, the shell form uses the live `~/.pi/agent`. |
| `context-meter` | With `nextMoveUrl` set, sends at most one POST after each agent run. Sends session counters and the last 300 characters of the last user message, after whitespace normalization. Reads the variable named by `nextMoveKeyEnv` for a Bearer header; [the credential reference](../packages.md#decision-server-credential) names the default key. Empty URL, disabled decisions, unknown context usage, active requests and failure cooldown prevent calls. | Reads and writes `<target>/context-meter/settings.json`. |
| `ops-footer` | Sends unauthenticated GET requests to configured health URLs from `OPS_FOOTER_OK_HEALTH_URL`, `OPS_FOOTER_OV_HEALTH_URL` or its settings. Empty URLs disable requests. Receives usage readings from other components, not their login files. | Writes `<target>/ops-footer/settings.json` and `settings.example.jsonc`. |
| `tracker-site` | Reads `GITEA_TOKEN`, the configured token variable or token file for GET headers to `issues.api` or `TRACKER_ISSUES_API`. Publication reads a credential file for Bearer-authenticated HTML POST or PUT requests. Updates also send the receipt edit token; a GET checks the share URL. OpenKnowledge detection reads `~/.claude.json` and `~/.pi/agent/mcp.json`; the store adapter makes no remote writes. | Writes the repository brief and, by default, `~/.pi/agent/tracker-state/<repo-slug>/`. Writes publication receipts with edit tokens under `~/.pi/agent/tracker-publications/`. Both defaults are in the live profile, not the selected target. |

A fresh selection leaves `copilot-usage`, `anthropic-usage` and `doctor` unchecked. Their login reads and token requests need the user's agreement before selection, alongside the memory consent text.

Observed with Pi 1.1.0: the first launch downloaded `fd` and `ripgrep` into `<target>/bin/`.

Rule from the Pi 1.1.0 source: Pi checks each tool in `<target>/bin/` first, then on the `PATH`. It checks `fd` locally and `fd` or `fdfind` on the `PATH`. For `ripgrep`, it checks `rg` in both places. At the start of an interactive session, Pi downloads only a missing tool. If both tools are available, Pi downloads neither. With both on the `PATH`, Pi creates no `bin/` in a new profile. The download needs network access. Without network access, Pi warns that the download failed and continues. With offline mode enabled, Pi warns and skips the download.

## What the scanner checks

`scripts/scan.sh` checks the tracked files before they leave the host. See [secret handling](../secret-handling.md).

| Finding | Result |
| --- | --- |
| A secret pattern (the default rules of gitleaks v8.28.0 in `.gitleaks.toml`) | Always fails. |
| A host value: a pattern of the deny lists or a private network address | Fails on the branch `portable` and on a tag `portable/*`. Warns on other branches. |
| A tracked `.gitleaksignore`, `.gitleaksbaseline`, `.betterleaksignore` or `.betterleaksbaseline`, a tracked file in `.local/`, a tracked archive or database dump | Always fails. |

Modes: `tree`, `staged`, `history`, `all` and `selftest`. The scanner is the local Betterleaks 1.9.0 binary. It runs without network access and without a container.

The scanner does not check untracked files, the private directory, a generated profile, a secret that is split over lines or encrypted, or commit author names. `scripts/publish_check.py` also scans each file of the publish set for private-key and token patterns, and for the content classes of [the public reader rules](../publishing.md#public-reader-rules). Neither check is a full secret audit.
