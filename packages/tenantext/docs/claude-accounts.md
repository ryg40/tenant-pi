# Claude accounts

`claude-account` keeps the logins of two Claude subscription accounts and switches the live login of Claude Code between them. The Claude quota meters then show one row for each account.

Claude Code keeps one login in its config folder, `~/.claude` (or `CLAUDE_CONFIG_DIR`). The command swaps only that login. Both accounts share one set of memory, settings, plugins, skills and sessions.

## Store

| Path | Content |
| --- | --- |
| `${XDG_STATE_HOME:-~/.local/state}/claude-accounts/` | The store, mode `0700` |
| `<store>/1/`, `<store>/2/` | One minimal Claude config folder per slot, mode `0700`: `.credentials.json` with `claudeAiOauth`, and `.claude.json` with `oauthAccount`. Files are mode `0600` |
| `<store>/<slot>/.credentials.json.prev` | The slot credential file before the last write that replaced its login with another refresh token, mode `0600`. One generation |
| `<store>/state.json` | `active` (the slot of the last `adopt` or `use`) and `switchedAt` (epoch milliseconds) |

A slot folder works as `CLAUDE_CONFIG_DIR`, so `CLAUDE_CONFIG_DIR=<slot folder> claude auth status` works in it. The `claude` program can write more files into a slot folder. The command reads only the two objects.

The store exists when `state.json` names a slot. Without it, every meter works as with one login.

## Commands

Install the command link once, from the kit root:

```sh
node packages/tenantext/claude-code/install-launcher.mjs --account
```

This links `~/.local/bin/claude-account`. It keeps an unrelated entry of that name and reports a conflict.

| Command | Effect |
| --- | --- |
| `claude-account adopt <slot>` | Save the live login into the slot and mark it active. Use it for the account that is logged in now |
| `claude-account login <slot>` | Run `claude auth login` with `CLAUDE_CONFIG_DIR` set to the slot folder. You do the browser step. The live login does not change |
| `claude-account use <slot>` | Save the live login back to its slot, because Claude Code can have renewed it. Then write the slot login into the live files |
| `claude-account status` | Show the slots, the active slot, the plan and the token state. It shows no token. `--email` also shows the account email |
| `claude-account help` | Show the help |

`use` changes `claudeAiOauth` in the live `.credentials.json` and `oauthAccount` in the live `.claude.json`. It keeps every other key, for example `mcpOAuth`. Each write goes to a temp file in the same folder and then a rename, with mode `0600`. Claude Code keeps `.claude.json` in the home folder, or in `CLAUDE_CONFIG_DIR` when that is set.

A running Claude Code session can write the live files too. So `use` reads each live file again directly before the rename and changes only its one key in that fresh copy. When the file changed between that read and the temp file, `use` reads it again once. A write of a session in the short time between the last read and the rename is still lost.

Two logins are one account when `oauthAccount.accountUuid` matches. With no account id, the refresh tokens must match. The credential file has no account id. So `use` also compares the live tokens with the saved tokens of each slot.

When the second live write fails, `.credentials.json` already holds the new login. The error says so. Run `claude-account use <slot>` again: it sees the live tokens of the target slot and finishes the switch with no write to a slot.

These cases stop the command before it writes a file:

- The slot is not `1` or `2`.
- `use`: the target slot has no login.
- `use`: the live login belongs to no slot. The swap would lose it. Run `adopt` first.
- `use`: the live files name different accounts. The live tokens are the saved tokens of one slot, and `.claude.json` names the account of the other slot. This follows from a switch that stopped between the two writes, or from a running session that wrote its old data back. The error names the slot whose tokens are live. `use` of that slot finishes the switch.
- `adopt`: there is no live login, the live login is already in the other slot, or the slot holds the login of another account. This holds for the active slot too: its saved copy can be the only copy of that login. To put another account into a slot, use `login <slot>`.
- A login file exists but does not parse.

## Restore a saved login

Before a write replaces the saved login of a slot with another refresh token, the command keeps the old slot credential file as `.credentials.json.prev`. This happens in `use` (the save of the live login back to its slot) and before `login`. The copy keeps one generation.

1. `claude-account status`. Check which slot has the wrong login.
2. Copy the old file back, for slot 1: `cp ~/.local/state/claude-accounts/1/.credentials.json.prev ~/.local/state/claude-accounts/1/.credentials.json`. The target file keeps its mode `0600`.
3. `claude-account status`. The slot shows its login again.

Warning: a later `use` replaces `.credentials.json.prev`. Restore it before the next switch. Claude Code renews tokens, so an old refresh token can be no longer valid.

## Set up two accounts

1. `claude-account adopt 1`. The account that is logged in now becomes slot 1.
2. `claude-account login 2`. Log in the second account in the browser. Slot 2 now has its own login.
3. `claude-account status`. Both slots show a login, and slot 1 is active.
4. `claude-account use 2` when you want the second account. Start a new Claude Code session after the switch.

Warning: A running Claude Code session can keep the old login in memory. Not verified: whether it writes the old login back to the live files. Start new sessions after `use`, and check the result with `claude-account status`.

## claude1 and claude2

`claude1` and `claude2` start Claude Code with the login of slot 1 or slot 2. Use them to run both accounts at the same time. Both commands have the settings, plugins, skills, hooks, memory and sessions of plain `claude`. Only the login is different.

Install the two links once, from the kit root:

```sh
node packages/tenantext/claude-code/install-launcher.mjs --slots
```

This links `~/.local/bin/claude1` and `~/.local/bin/claude2` to `claude-code/bin/claude-slot.sh`. It keeps an unrelated entry of either name, reports the conflict and exits with 2.

The commands need `bash` and `node` on `PATH`. The shell script runs `claude-code/bin/claude-slot.mjs`, beside its own real path. That helper uses the store rules of `claude-code/scripts/claude-accounts.mjs`. It makes every check before it changes a link or a file. The commands support only the file login in `~/.claude/.credentials.json`, as `claude-account` does. A host that keeps the login in the macOS keychain gets a refusal.

These cases stop the command with exit 1 and a message. `claude` does not start, and no link or file changes:

- `state.json` is missing, does not parse, or names no slot `1` or `2`.
- The live login is not a file login: `~/.claude/.credentials.json` has no `claudeAiOauth`, or `~/.claude.json` has no `oauthAccount`.
- The live `oauthAccount` is not the account of the active slot (the account rule of `use`).
- The live refresh token is the saved refresh token of the non-active slot. This follows from a `use` that stopped before it wrote `state.json`.
- `~/.claude` is a slot folder, for example through a link.
- The slot has no login: its `.credentials.json` is missing or has no `claudeAiOauth` with a refresh token. The message names `claude-account login <slot>`.
- The slot `.credentials.json` is not a regular file (for example a link), does not parse, or is the live file.
- The non-active slot only: the slot folder is a link or no folder, `~/.claude` is no folder, `~/.claude.json` or `<slot folder>/.claude.json` does not parse, or the slot copy has no `oauthAccount`.

For the first five cases, the message names `claude-account status` and `claude-account use <slot>`. Check the slots, then finish or redo the switch.

- The active slot (`active` in `state.json`): the command removes `CLAUDE_CONFIG_DIR` from the environment and starts plain `claude`. The live login in `~/.claude` is that account. So one login is never used from two files. After `adopt`, the slot folder holds a copy of the same login, but only the live files are in use.
- The other slot: before each start, the command links each entry of `~/.claude` into the slot folder, except `.credentials.json`, `.credentials.json.*`, `.claude.json` and `backups`. It removes dead links that point into `~/.claude`. A real file or folder in the slot folder with the name of an entry stays, and the command warns. Then it copies `~/.claude.json` into `<slot folder>/.claude.json` and keeps the `oauthAccount` of the slot (a temp file and a rename, mode `0600`). Claude Code starts with `CLAUDE_CONFIG_DIR=<slot folder>`.

Both cases set `CLAUDE_ACCOUNT_SLOT=<slot>`. The command starts the `claude` on `PATH`, so a wrapper of `claude` on `PATH` still applies.

| Shared | Own to the slot |
| --- | --- |
| Each entry of `~/.claude` through a link: settings, plugins, skills, hooks, memory, sessions | The login: `.credentials.json` |
| The content of `~/.claude.json`, copied at each start | The copy `<slot folder>/.claude.json` with the `oauthAccount` of the slot |

Limits:

- Do not run `claude-account use` while a session of the non-active command runs. `adopt` and `use` refuse when the live config folder is a slot folder: `CLAUDE_CONFIG_DIR` is a slot folder, as in a session of the non-active command, or `~/.claude` is a link to a slot folder. Run them in a shell outside that session, with `~/.claude` as a real folder.
- At each start, the non-active command copies `~/.claude.json` over its slot copy. A top-level key that `~/.claude.json` also has gets its value from `~/.claude.json` again, so a change to it in the non-active command (for example `claude mcp add --scope user` in `mcpServers`) is lost. A top-level key that only the slot copy has stays. Make such changes in plain `claude`.
- When `.credentials.json` holds MCP logins (`mcpOAuth`), the non-active command does not have them and needs its own MCP login.
- Not verified: the status line meters inside a session of the non-active command.

Herdr starts a Claude pane with one of the two commands: `spawn.py --harness claude --account 1` or `2` (`skills/herdr/SPAWN.md`, section 3).

## Meters

With a store, the Pi operations footer and the Claude Code status line show `Claude1` and `Claude2` (short forms `CL1`, `CL2`) after the Codex accounts and before Copilot. A `*` marks the slot of the live login.

- The live slot reads the live login, as the meter does with no store.
- The other slot reads its slot folder.
- Each slot has its own shared reading, `~/.cache/claude-pi-footer/usage-<slot>.json`, with the claim rule of the [shared reading](anthropic-usage.md#shared-reading). So a reading of one account never shows on the row of the other.
- The file of a slot keeps `account`, a short hash of the account id of the reading. A reading with another hash is not used. So after `login` of another account into a slot, the old reading does not show.
- The kit sends no OAuth refresh request. When the token of the other slot is past expiry, the meter starts `CLAUDE_CONFIG_DIR=<slot folder> claude auth status` and does not wait for it. The next refresh reads the new token. The program gets SIGTERM after 20 seconds and SIGKILL 2 seconds later.
- The renewal runs at most once per hour of the clock for each slot, for every client. The claim is the exclusive create of `~/.cache/claude-pi-footer/renew-<slot>-<period>.json`. The claim of an earlier period is removed.
- The meter never renews the slot that the state names active: that would rotate the refresh token of the live login.
- When the token stays expired, the row shows the last reading as `unknown`, up to one day. The quota group shows the oldest reading as stale.
- In the status line, the `5h` and `7d` chips of the running session go on the row of the live slot only when the session started at or after `switchedAt`. The start is the time now minus `cost.total_duration_ms` of the status line JSON.
- A session that started before the last switch can still use the old account. Then the live row shows the slot's own reading, as the other slot does, and the chips of that session are not cached. With no `cost.total_duration_ms`, every row uses the slot's own reading.

The meter in Pi uses only the Claude Code login with a store. The Pi `anthropic` login is not a slot.

## Verification state

| Fact | State |
| --- | --- |
| `use` saves the live login first and changes only the two objects | Verified with a fixture test in a temp home |
| `use` refuses with no write when the live login belongs to no slot | Verified with a fixture test |
| `use` refuses with no write when the live files name different accounts | Verified with a fixture test |
| `adopt` refuses over a slot, active or not, that holds another account | Verified with a fixture test |
| `cost.total_duration_ms` counts from the start of the process, also for a resumed session | Not verified |
| The reading of one account stays on its own row after a switch | Verified with a fixture test and an injected fetch |
| A live swap in a running Claude Code session | Not verified |
| `claude auth status` renews an expired token in a slot folder | Not verified |
| `claude auth login` in an empty slot folder | Not verified |
| The macOS keychain login | Not supported. The command reads and writes only the files |
| The non-active launcher keeps the slot login and its `oauthAccount`, keeps a real file of the slot, and starts `claude` in the slot folder | Verified with a fixture test in a temp home and a fake `claude` |
| The active launcher starts `claude` with no `CLAUDE_CONFIG_DIR`, also when the caller set one | Verified with a fixture test |
| `adopt` and `use` refuse with no write when `CLAUDE_CONFIG_DIR` is a slot folder, or `~/.claude` is a link to a slot folder | Verified with a fixture test |
| The launcher refuses with no change for a missing or invalid `state.json`, a live account that is not the active slot's, the live token of the non-active slot, a slot login with no `claudeAiOauth`, and a slot login that is a link to the live file | Verified with a fixture test in a temp home and a fake `claude` |
| `install-launcher.mjs --slots` keeps an unrelated `claude2` and creates no `claude1` | Verified with a fixture test |
| `claude1 auth status` and `claude2 auth status` show two logged-in accounts | Verified on one machine |
| The status line meters inside a session of the non-active launcher | Not verified |
