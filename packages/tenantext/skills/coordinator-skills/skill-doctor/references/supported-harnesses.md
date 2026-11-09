# Supported harnesses

This file is the single source of truth for harness support in `skill-doctor`. Reference it instead of repeating harness lists in `SKILL.md`.

## Startup gate

| Harness | Collector ID | Local conversation source |
| --- | --- | --- |
| Warp | `warp` | Read-only Warp conversation databases |
| Claude Code | `claude` | Project-history JSONL |
| Codex | `codex` | Rollout JSONL |
| Pi | `pi` | Pi agent JSONL (`~/.pi/agent/sessions`) |
| Grok Build | `grok` | Grok Build chat_history JSONL (`~/.grok/sessions`) |
| ZCode | `zcode` | ZCode model-io rollout (`~/.zcode/cli/rollout`) |
| Hermes | `hermes` | Hermes Agent state.db (SQLite: `sessions` + `messages`) |

At startup, identify the harness executing the skill from the runtime context. Do not infer it from conversation files found on disk.

If the executing harness is not listed above, or cannot be identified confidently, stop before creating a report directory or reading conversation history. Tell the user:

> skill-doctor currently supports Warp, Claude Code, Codex, Pi, Grok Build, ZCode, and Hermes. This run appears to be using an unsupported harness, so no conversations were read.

## Collector source selection

- `--harness auto` scans every locally available supported source and is the default.
- `--harness all` also requests every supported source.
- `--harness <collector-id>` restricts collection to one source from the table.
- A report containing one source uses its collector ID in `inventory.json`; a report containing multiple sources uses `mixed`.

Harness-specific source overrides:

- `--claude-home PATH`: nonstandard Claude Code configuration directory.
- `--codex-home PATH`: nonstandard Codex home.
- `--warp-db PATH`: explicit Warp database; repeatable.
- `--warp-data-dir PATH`: nonstandard Warp channel-data directory.
- `--pi-home PATH`: nonstandard Pi agent home (default `~/.pi/agent`).
- `--grok-home PATH`: nonstandard Grok Build home (default `~/.grok`).
- `--zcode-home PATH`: nonstandard ZCode home (default `~/.zcode`).
- `--hermes-home PATH`: Hermes Agent home containing `state.db` (default discovery checks `HERMES_HOME`, `~/.hermes`, then `~`).

## Session sources

`--source` decides where the collector reads the sessions:

| Value | Source |
| --- | --- |
| `auto` (default) | Claude Code and Pi from the OpenViking server when its configuration names a server and the server answers; the other harnesses from their local files when those exist. When no server is configured or the server does not answer (a connection error, a timeout, HTTP 5xx, a health reply with `healthy: false`), the local files of every harness, with one `note:` line on stderr that gives the reason. |
| `openviking` | The OpenViking server only (Claude Code and Pi). The collector exits with code 1 and one `error:` line when the server cannot serve the sessions, or when `--harness` names a harness that OpenViking does not hold. |
| `local` | The local files of the table above only. |

Every other OpenViking failure ends the run with one `error:` line and exit code 1, with `auto` too: HTTP 401 or 403 or another HTTP status (a redirect too), also when the body of that reply is slow or incomplete; a certificate that fails the TLS check; a server address that is not an http or https URL; a key, an account or a user with a character that an HTTP header cannot carry; a body that is not JSON; an application error; or a missing identity. The `error:` line holds no value of the configuration.

The health check as a whole ends within a deadline of 5 s: the name lookup, the connection, the request and the reply. Each later request ends by a deadline of 30 s, also when the server sends its bytes slowly. Two waits of a later request are outside its deadline: a name lookup that stalls ends only by the timeout of the system resolver, and each address of the server name gets the full timeout for its connection attempt. After a failure, the other reads stop.

`inventory.json` records the source of each harness in `sources.<harness>.source` (`openviking` or `local`), the summary in `session_source` (`openviking`, `local` or `mixed`), and the fallback reason in `session_source_note`. The `session source` output line gives the same split. The collector exits with code 3 when it sampled no session.

### OpenViking

OpenViking holds the sessions that its clients capture: the Claude Code plugin `openviking-memory` (session IDs `cc-<id>`) and the Pi package (`pi-<id>`). With `--harness auto` or `all` the collector reads both; `--harness claude` or `pi` reads one. A child session of Claude Code is a separate OpenViking session; the child-session flag of Step 1 includes it. The collector gives each message of a session once, in order: the archives in the order of their numbers, then the live messages.

The collector reads the shared connection chain of the OpenViking clients, in this order:

1. `OPENVIKING_CREDENTIAL_SOURCE`: `env` reads the variables and no file, `cli` takes the connection values from the files only, any other value is `auto`. In `cli`, `OPENVIKING_AUTH_MODE` and the file-path variables of items 3 and 4 still apply.
2. The variables `OPENVIKING_URL` or `OPENVIKING_BASE_URL`, `OPENVIKING_BEARER_TOKEN` or `OPENVIKING_API_KEY`, `OPENVIKING_ACCOUNT`, `OPENVIKING_USER`, and `OPENVIKING_AUTH_MODE`.
3. `ovcli.conf` (`OPENVIKING_CLI_CONFIG_FILE`, default `~/.openviking/ovcli.conf`): `url`, `api_key`, `account` or `account_id`, `user` or `user_id`.
4. `ov.conf` (`OPENVIKING_CONFIG_FILE`, default `~/.openviking/ov.conf`): `server.url` or `server.host` and `server.port`, `server.root_api_key`, `server.auth_mode`.

In `auto`, an `ovcli.conf` with connection values pins the chain when no connection variable is set: as in `cli`, `server.root_api_key` then does not apply.

The harness clients read identity layers of their own too: the `plugin`, `plugin.claude_code` and `plugin.pi` keys of `ovcli.conf` and the `claude_code` and `pi` sections of `ov.conf`. The collector reads none of them. The run fails with one `error:` line when the server runs in trusted mode and the chain does not give both an account and a user, or when only a harness layer names the account or the user. Name the identity with `OPENVIKING_ACCOUNT` and `OPENVIKING_USER`, or with `account` and `user` in `ovcli.conf`. In `api_key` mode the key decides the user.

The collector sends GET requests only, with the key in the `Authorization` header, and uses no proxy and no redirect. The key stays out of argv, the output and `inventory.json`.

OpenViking keeps no working directory. Each message carries the peer ID of its repository: the `origin` remote in its peer form (for `git@host:owner/repo.git` the peer is `host-owner-repo`), or the repository path with each character that is not a letter or a digit as `-`. `--repo` matches these peer IDs exactly, so a worktree with the same remote matches too. The transcript gives the `--repo` path as `cwd`. With `--all-conversations` there is no path, so the collector finds only the global skills and `--skills-dir`.

The Pi package sends no tool results by default (`captureToolResults`). A Pi transcript from OpenViking then has the tool calls without tool output: its header says `tool output: not available`, and its `inventory.json` stats give `tool_output_available: false` and `error_outputs: null`, because the error count is unknown.

## Skill locations

Project skills are discovered from:

- `.agents/skills`
- `.claude/skills`
- `.codex/skills`

Global skills are discovered from the corresponding directories under the user's home and configured harness homes when `--include-global-skills` is set: `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, Pi's skill directory under its agent home (default `~/.pi/agent/skills`), Grok Build's `~/.grok/skills`, and ZCode's `~/.zcode/skills`.
