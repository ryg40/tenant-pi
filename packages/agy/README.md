# agy

The files of the kit component `agy`. They set up Antigravity CLI (`agy`) with the kit: two always-on rules, the kit skills, the kit command rules, the terminal sandbox rules of three kit skills, the OpenViking memory hooks, and the `ops-footer` status line. The installer script is `scripts/kit_agy.py`.

## What the component installs

`agy` reads its user files from `~/.gemini/`. The installer writes only the parts below.

| Place | What |
| --- | --- |
| `~/.gemini/config/rules/style.md` | Link to `rules/style.md`: the plain-English reply style, always on. The result format of a role prompt and the report form of the dummies skill come first; the plain-English rule applies to their content. |
| `~/.gemini/config/rules/tenant-kit.md` | Link to `rules/tenant-kit.md`: the terms line and a pointer to the kit skills, always on. |
| `~/.gemini/config/rules/tenant-kit-artifacts.md` | Link to `rules/tenant-kit-artifacts.md`, only with the module `artifacts`. |
| `~/.gemini/config/skills/<name>` | One link for each kit skill of the chosen modules. |
| `~/.gemini/config/hooks.json`, key `tenant-kit` | A `PreToolUse` handler for `run_command`: `hooks/pre-tool-use.mjs`. |
| `~/.gemini/config/hooks.json`, key `openviking` | `SessionStart`, `PreInvocation` and `Stop` handlers: the three OpenViking hooks. Only with the plugin, see below. |
| `~/.gemini/config/mcp_config.json`, `mcpServers.openviking` | `node <plugin>/servers/mcp-proxy.mjs`. Only with the plugin. |
| `~/.gemini/antigravity-cli/settings.json`, `permissions.allow` | `mcp(openviking/find)`, `mcp(openviking/search)`, `mcp(openviking/read)`. Only with the plugin. |
| `permissions.allow`, with the skill `herdr` | Mounts: `read_file(<config home>/herdr-skill)`, `write_file(<state home>/herdr-skill)` and `write_file(<herdr-core runtime folder>)`. Commands: `command(python3 <dir>/<script>)` for `init.py`, `panes.py`, `spawn.py`, `ask.py`, `last-reply.py`, `close.py`, `handoff.py` and `resources.py`, in `~/.gemini/config/skills/herdr/scripts` and in the folder of the skill in the kit clone. |
| `permissions.allow`, with the skill `dummies` | Mount: `read_file(<config home>/dummies-skill)`. Commands: `command(python3 <dir>/page.py)` in the two kinds of folder. |
| `permissions.allow`, with the skill `okknow` | `command(okknow read)`, `command(okknow ls)`, `command(okknow search)`. The other `okknow` commands keep the normal approval. |
| `~/.gemini/antigravity-cli/settings.json`, `statusLine` | `{"type": "command", "command": "node --no-warnings <clone>/packages/agy/scripts/statusline-ops-footer.mjs", "enabled": true, "padding": 0, "stack_with_default": false}`. Only when the key is absent or equal to the value of the record `tenant-kit-statusline.json`. See [The status line](#the-status-line). |
| `~/.gemini/config/tenant-kit-allow-rules.json` | The record of the allow rules that the installer added: `{"version": 1, "rules": [...]}`. See [Allow rules](#allow-rules). |
| `~/.gemini/config/tenant-kit-statusline.json` | The record of the `statusLine` value that the installer wrote: `{"version": 1, "statusLine": <object or null>}`, mode `0600`, no backup. See [The status line](#the-status-line). |

The terminal sandbox of `agy` hides `~/.config`, the host processes and the network. A `read_file(<path>)` rule mounts a folder read-only, a `write_file(<path>)` rule mounts it read-write. A `command(<prefix>)` rule lets a command run with no question, also outside the sandbox when the agent sets `BypassSandbox`; the prefix matches the words of the command. `<config home>` is `XDG_CONFIG_HOME` when it is absolute, else `~/.config`. `<state home>` is `XDG_STATE_HOME` when it is absolute, else `~/.local/state`. The herdr-core runtime folder is the installer's choice `<XDG_RUNTIME_DIR>/herdr-core`, when `XDG_RUNTIME_DIR` is absolute; else the installer writes no such rule and prints one line. The rules hold absolute paths. A path gives a rule only when it holds only the characters `A-Z a-z 0-9 . _ / + @ -`; another path (for example with a space, a bracket or a quote) gives no rule and one `skipped:` line. With a home folder that is not absolute, the installer writes no sandbox rule. The rules of the path `~/.gemini/config/skills/<name>/scripts` come only when that place is the kit's link to the skill; a skipped skill place gets no such rule and one line, and the rules of the folder in the kit clone stay. The always-on rule `tenant-kit.md` tells the agent how to run these commands.

Warning: the `command(...)` rules let the named Herdr scripts, `page.py` and three read-only `okknow` commands leave the `agy` terminal sandbox with no question. The plan says so before the yes. The rules apply to a new `agy` session.

The installer also runs `herdr integration install antigravity-cli` when the `herdr` command is on `PATH`. It warns when `~/.bashrc`, `~/.bash_profile`, `~/.zshrc` or `~/.zprofile` holds the line `# Added by Antigravity CLI installer`: the `PATH` line below it can put plain `pi` and `claude` before the kit shims. It changes no shell file.

The component never touches `~/.gemini/GEMINI.md`, never writes the key `model`, and never installs the `agy` program.

## Preconditions

- The folder `~/.gemini/config` exists. It exists after `agy` ran one time and the user signed in. Without it, the installer prints one line and creates nothing.
- The OpenViking parts need the OpenViking Claude Code plugin: `~/.claude/plugins/cache/openviking/openviking-memory/<version>/servers/mcp-proxy.mjs`. The installer takes the newest version folder. Without the plugin, it writes no OpenViking part, removes its own older ones, and prints one line. The kit does not install the plugin.

## Remove

`kit_agy.py remove` deletes only the fixed names of the component, and only while they are the kit's: the links in `rules/` and `skills/` that point into the kit clone, the `hooks.json` keys `tenant-kit` and `openviking` when each command runs a file of the kit, `mcpServers.openviking` when it has the shape above, and each allow rule of the record. Everything else stays: each rule of the user (also one that is equal to a rule of the kit), the login, each other file under `~/.gemini/antigravity-cli/`, each other key, the `*.bak-<time>` backups, `~/.gemini/GEMINI.md` and the OpenViking cursors in `~/.local/state/agy-openviking/`.

`remove` deletes the key `statusLine` only while it equals, as JSON, the value of the record `tenant-kit-statusline.json`, and then sets the `statusLine` of the record to `null`. A `statusLine` of the user stays: one with another command, one of another clone that the record does not name, and the kit value with a change of the user (for example `"enabled": false` or an extra key).

`remove` leaves the parts that it cannot tell from the user's own: the empty `rules/` and `skills/` folders, and the empty keys and files that `apply` made (for example `hooks.json` as `{}`, `mcpServers` as `{}` and `permissions.allow` as `[]`). The record stays with an empty `rules` list.

An install by an older kit wrote no record. Its rules count as the user's: after `remove`, the three OpenViking rules and the sandbox rules of that install stay. The plan names how many entries are equal to a rule of the kit and are not in the record. Delete them by hand when you want.

## Allow rules

The record `~/.gemini/config/tenant-kit-allow-rules.json` holds each allow rule that the installer itself put into `permissions.allow` and that is still there. Only these rules are the kit's.

- `apply` adds a wanted rule that is not in `permissions.allow`, and records it.
- A wanted rule that is in `permissions.allow` and not in the record is the user's. The installer leaves it and does not record it.
- `apply` deletes each rule of the record that it no longer writes, for example after the skill `herdr` left the list, or after a path changed.
- A rule that is not in the record is never deleted, also when its text is equal to a rule of the kit.
- A rule of the record that the user deleted from `permissions.allow` leaves the record at the next run.
- The installer writes `settings.json` first and the record after it. A run that stops between the two leaves a rule of the kit as the user's, never a rule of the user in the record.
- When the edit of `settings.json` is skipped, the record does not change. A record that is a link, invalid JSON or of another shape gives one `skipped:` line; the installer then adds and deletes no allow rule.

A link in `rules/` or `skills/` is the kit's when its own target path lies in the kit clone. The installer does not follow a chain of links, so a user's link to a second link into the kit stays. A user link straight to a file of the kit clone counts as the kit's, because the kit must replace its own older links after a file moves inside the clone.

## JSON files

- A JSON file gets one backup `<name>.bak-<UTC time>` just before a write, and only when its content changes. When that name exists, the backup gets a counter: `<name>.bak-<UTC time>-2`, `-3`, and so on. A backup never writes over a file.
- A changed file is written again in full, with an indent of two spaces. The data and the key order stay; the spacing can change.
- The record of the allow rules is written the same way and gets no backup.
- The allow rules and the key `statusLine` of `settings.json` change in one write, so a run makes at most one backup of that file.
- A link, a file with invalid JSON, or a file that is not a JSON object is skipped with one line. A file whose `mcpServers`, `permissions` or `permissions.allow` has the wrong type (for example a list for `mcpServers`) is skipped the same way. For `settings.json` this check runs on each edit, also when no rule is wanted: a wrong `permissions` or `permissions.allow` stops the whole write, the `statusLine` too. An invalid record stops only its own part.
- `apply` replaces a `hooks.json` key `tenant-kit` or `openviking` whose command is not in the kit, and prints one line `replaced: ...` for it. Older installers wrote these keys with commands outside the kit, so the kit must take the keys over.

## Run apply again

- After an update of the OpenViking plugin: the `mcp_config.json` entry names the version folder of the plugin.
- After the kit clone moves: the `hooks.json` keys, the `command(...)` rules and the `statusLine` command name the path of the clone. `apply` deletes the recorded rules with the old path and sets the `statusLine` command to the new path while the key equals its record. `remove` leaves `hooks.json` keys with the old path, because they no longer point into the kit.
- After a change of `XDG_CONFIG_HOME`, `XDG_STATE_HOME` or `XDG_RUNTIME_DIR`: the mount rules name these folders. `apply` deletes the recorded rules with the old folders.
- Then start a new `agy` session: a running session does not read a changed `settings.json`.

## The hooks

- `hooks/pre-tool-use.mjs` applies the kit command rules (`packages/tenantext/claude-code/scripts/command-rules.mjs`) to `run_command`. It finds the rule table by a path relative to its own real file. A denied command gets `{"decision":"deny","reason":...}` with the reason of the table; each other command gets `{"decision":"allow"}`, and `agy` applies its normal permission policy. A missing rule table allows the command and prints one line to stderr. The hook never blocks a session by its own error.
- `hooks/openviking-session-start.mjs`, `openviking-prompt-recall.mjs` and `openviking-capture.mjs` give `agy` the memory behavior of the OpenViking Claude Code plugin: session recall, prompt recall and capture. `hooks/openviking-lib.mjs` holds their shared code and the commit sweep of idle conversations. They import modules of the installed plugin at run time and never read the OpenViking connection themselves. Each one fails open: valid JSON on stdout, one line on stderr.

Variables of the OpenViking hooks:

| Variable | Effect |
| --- | --- |
| `AGY_OV_PLUGIN_ROOT` | The plugin folder, instead of the newest version folder of the plugin cache. The installer reads it too. |
| `AGY_OV_STATE_DIR` | The state folder, instead of `~/.local/state/agy-openviking/`. |
| `AGY_OV_DRY_RUN=1` | Send and save nothing; report on stderr. |

## The status line

`scripts/statusline-ops-footer.mjs` is the status line of `agy`. `agy` runs it and sends one JSON object on stdin: `session_id` or `conversation_id`, `transcript_path`, `model`, `effort`, `agent_state`, `workspace`, `cwd`, `context_window`, `cost`, `terminal_width` and `theme`. The script prints the rows of the Pi footer `ops-footer` with the renderers of `packages/tenantext/extensions/ops-footer`:

- the model row: `antigravity/<model>`, the effort, the token totals and the cost
- the folder and Git row, the agent state and the duration
- the context bar
- the quota rows of the active Pi profile: Codex, Claude, Copilot and Antigravity
- the memory and service rows: OpenViking, OpenKnowledge through `okknow`, and the artifact server

It reads the `agy` transcript (JSONL lines of the types `USER_INPUT`, `SYSTEM_MESSAGE`, `GENERIC` and `PLANNER_RESPONSE`) from the last offset only. It finds `packages/tenantext` by a path relative to its own real file. The Pi profile of the quota rows is `PI_FOOTER_PROFILE`, else `PI_CODING_AGENT_DIR`, else `~/.pi/profiles/tenant-pi-full`, else the first profile in `~/.pi/profiles/` with `ops-footer/settings.json` (then with `settings.json`), else `~/.pi/agent`. The health URLs are the `healthUrls` of `~/.pi/agent/ops-footer/settings.json` and of `<profile>/ops-footer/settings.json`; the profile wins. The global settings are always the folder `~/.pi/agent`, also when `PI_CODING_AGENT_DIR` names a profile. The Codex and Copilot readings of a profile other than `~/.pi/profiles/tenant-pi-full` go to `codex-usage-<key>.json` and `copilot-usage-<key>.json`, with `<key>` the first 8 hex digits of the SHA-256 of the profile path (no secret), so two profiles never share a reading.

The transcript must be a regular file and not a link. Below `~/.gemini/antigravity-cli/` the script reads only `brain/<id>/.system_generated/logs/transcript.jsonl`, by the path and by its real path; it never opens `settings.json`, the sign-in file or another file there. A new file at the transcript path (another device or inode) starts a new scan.

The record `~/.gemini/config/tenant-kit-statusline.json` holds the exact `statusLine` value that `apply` wrote. The key is the kit's only while it equals that value as JSON; with no record, no `statusLine` is the kit's. `apply` sets the key when it is absent or the kit's, and records the new value; each other `statusLine` stays with one `skipped:` line. The installer writes `settings.json` first and the record after it. When the edit of `settings.json` is skipped, the record does not change. A record that is a link, invalid JSON or of another shape gives one `skipped:` line, and the installer then sets and deletes no `statusLine`; the allow rules still change.

The script shares the cache folder `~/.cache/claude-pi-footer/` with `ops-footer`. A run in the foreground waits on no network call: it reads the cache, and a stale reading starts one detached run with `--refresh-quota <meter>` or `--refresh-usage [slot]` under a lock file. A `python3` child holds a kernel `flock` lock on `<name>.lock` (mode `0600`) for the run; the kernel ends the lock when the run ends or crashes, and no run deletes the lock file. Without `python3`, no refresh runs. `PI_FOOTER_NO_REFRESH=1` stops these runs. When `packages/tenantext` or one of its modules does not load (for example `@earendil-works/pi-tui` is not in `packages/tenantext/node_modules`; see [the package guide](../../docs/packages.md)), the script prints one plain line, `agy · <model> · <percent> · <folder>`, and exits 0.

Other variables: `PI_FOOTER_TENANTEXT` (the tenantext folder), `PI_FOOTER_WIDTH`, `PI_FOOTER_MARGIN`, `PI_FOOTER_THEME`, `PI_FOOTER_CODEX_POLL`, `PI_FOOTER_SYS_WARN` and `PI_FOOTER_DEBUG=1` (errors on stderr).

## Terms of the Antigravity service

The component installs files only. It never reads, copies, moves or prints the Antigravity login. Under `~/.gemini/antigravity-cli/`, `settings.json` is the only existing file that the installer reads or edits (it writes a backup and a temporary file beside it), and only for `permissions.allow` and `statusLine`. The status line script never opens `settings.json` or a login file of `agy`; it checks the sign-in file with `stat` only. The rule `tenant-kit.md` tells the agent not to copy, print or reuse the login in another program, harness or proxy. No part of the kit runs `agy -p` or `agy acp` behind a model endpoint.

## Tests

```sh
npm test
```

The tests need no OpenViking plugin and no network.

## Not verified

Verified in a live `agy` session on Linux with `agy` 1.5.18:

- A denied command. The `PreToolUse` hook `hooks/pre-tool-use.mjs` denied `find / -maxdepth 0` at once with the reason of the rule table, `Use rg instead of find`.
- The OpenViking hooks `SessionStart` and `PreInvocation`. They put the context and the memories of OpenViking into the live session.
- The OpenViking MCP tools. `find`, `search` (a tiered recall of the skill `tenant-design`) and `read` of the `openviking` MCP server ran with no approval question.
- The skills list. The session loaded the kit skills, for example `herdr` and `tenant-design`.
- The sandbox rules that the installer wrote. Each of the eight Herdr pane scripts ran with no approval question, and a live delegation reached the three harnesses `claude`, `pi` and `agy`. `okknow read`, `okknow ls`, `okknow search` and `page.py` of the skill `dummies` also ran with no approval question.

Not verified:

- The rows of the status line inside a running `agy` terminal screen. The script was run with a synthetic `agy` input against a live Pi profile, outside the `agy` screen.
- The OpenViking hook `Stop`: the capture of the session in OpenViking.
- macOS. The setup ran only on Linux: the installer tests with `agy` 1.5.15 in scratch homes, and the live proofs with `agy` 1.5.18. Whether herdr-core on macOS keeps its socket below `XDG_RUNTIME_DIR` is not known.
- Classic Herdr with an `agy` pane.
- A terminal sandbox with other defaults than the mode `auto` of `agy` 1.5.18.
- A mount rule for a folder that does not exist yet.
- Whether `agy update` writes the installer `PATH` line again.
