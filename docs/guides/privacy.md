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
| The private directory | `overlay.json`, `registry.json`, `install-log.md`, `accepted-drift.md`, `.gitignore`, `inputs/` (for example `inputs/mcp-adapter.json`), launcher files, baseline files, saved `compare` reports. | Only if you run `git init` there. The kit prints that line and never runs it. |
| A generated profile | `settings.json`, `.tenant-pi/choices.json`, `.tenant-pi/state.json`, optional module files. After launch, Pi adds `auth.json`, `sessions/`, `npm/` and module state. | No |
| The live profile `~/.pi/agent` | Your existing Pi setup. | The kit never writes it. It reads it only when you name it with `--dir`: `baseline` and `check-baseline` read the name, kind, size and modification time of each entry and open no file; `inventory` reads `settings.json` and lists three directories. |

Keep the private directory outside the clone. `init-private` refuses a path inside the clone, inside `~/.pi/agent` and inside a known overlay target. See [the private directory](../private-directory.md).

Keep each generated profile outside the clone too. `validate`, `plan` and `generate` refuse a `target.agentDir` inside the clone that runs them, with `under_kit: overlay.target.agentDir`. A second clone, or the main clone when you run the kit from a Git worktree, is not protected. See [the generator](../generator.md).

Keep each generated profile outside the live profile. `validate`, `plan` and `generate` refuse a `target.agentDir` that is `~/.pi/agent` or is under it, with `under_pi_agent: overlay.target.agentDir`. The kit does not read `PI_CODING_AGENT_DIR`: a live profile that only this variable names is not protected.

The `.gitignore` of the private directory ignores `inputs/`, `.env`, `.env.*`, `auth.json`, `models.json`, `mcp-adapter.json`, `sessions/`, `*.key`, `*.pem`, `*.db`, `*.sqlite` and `*baseline*.json`. It is not a security control. Read `git status` before each commit.

`.tenant-pi/choices.json` holds the whole overlay copy, the registry and the MCP definitions of a profile. It holds `${NAME}` references, never a resolved secret. Treat it as private like the overlay.

## What the kit never does

The kit commands are `validate`, `plan`, `generate`, `compare`, `carry`, `inventory`, `list`, `check-runtime`, `init-private`, `baseline` and `check-baseline`. None of them:

- edits a shell startup file such as `~/.bashrc`, `~/.zshrc` or `~/.profile`, or changes `PATH`;
- installs a package, runs `npm`, `pip`, `git` or a system package manager;
- starts, stops or configures a service, a timer or a daemon;
- runs `pi`, except `pi --version` inside `check-runtime` with an empty temporary `PI_CODING_AGENT_DIR`;
- opens a network connection or makes a model call;
- reads `auth.json`, `models.json`, a session, a memory store or the live `settings.json`. `baseline` and `check-baseline` read the status of each entry of the directory that you name (name, kind, size, modification time) and open no file; see [the directory baseline](../directory-baseline.md);
- reads an environment value other than `HOME` (`init-private`, `baseline`, `validate`, `plan`, `generate`) and `PATH` (`check-runtime`). Exception: `check-runtime` passes the full environment of the caller to its three child processes (`pi --version`, `node --version`, `python3 --version`), with `PI_CODING_AGENT_DIR` replaced for the Pi process;
- copies auth, sessions, memory, queues, keyring state or installed packages between profiles;
- writes, prints or resolves a secret value.

The plan prints dependency and launch commands as display text (`setupDisplayOnly`, `launchDisplayOnly`). The user reads them and runs them by hand. The kit test suite checks these limits with audit hooks for file opens, processes and sockets. Not verified: a proof that no other file is opened; the audit lists forbidden names.

## Credentials

- The overlay has no field for a secret value. An `env` value is a `${NAME}` reference. The kit rejects `$`, backticks and `{{` elsewhere.
- No credential store is required. Export the name in the launching shell, or read it from a store that you already use. A password manager is one example.
- `TENANTEXT_LITELLM_BASE_URL` is public configuration on the launch line. `TENANTEXT_LITELLM_API_KEY` is a secret and never enters a file of the kit.
- Pi native `/login` writes `<target>/auth.json`. That file belongs to Pi.
- A `compare` report shows a marker, not a value, for a private field. A `carry` patch prints overlay values such as an endpoint URL or a package path. Treat a `carry` output like the overlay.

## What the scanner checks

`scripts/scan.sh` checks the tracked files before they leave the host. See [secret handling](../secret-handling.md).

| Finding | Result |
| --- | --- |
| A secret pattern (gitleaks v8.28.0 default rules) | Always fails. |
| A host value: a pattern of the deny lists or a private network address | Fails on the branch `portable` and on a tag `portable/*`. Warns on other branches. |
| A tracked `.gitleaksignore`, a tracked file in `.local/`, a tracked archive or database dump | Always fails. |

Modes: `tree`, `staged`, `history`, `all` and `selftest`. The scanner runs gitleaks in a pinned container without network access, or a local gitleaks binary.

The scanner does not check untracked files, the private directory, a generated profile, encoded secrets, or commit author names. `scripts/publish_check.py` also scans each file of the publish set for private-key and token patterns, and for the content classes of [the public reader rules](../publishing.md#public-reader-rules). Neither check is a full secret audit.
