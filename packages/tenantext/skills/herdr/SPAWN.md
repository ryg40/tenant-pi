# Start a new agent

Set `S` to the absolute `scripts` directory beside the loaded `SKILL.md`, including a plugin cache copy.

## 1. Before you start a pane

- Start a pane only when the user asks for one.
- Run `python3 $S/panes.py`. If an agent for the same task runs already, use it with `herdr_watch_start` in Pi, else with `ask.py`. Do not start a second one.

## 2. Roles

| Role | Focus | Usual file access | Session | Tab |
| --- | --- | --- | --- | --- |
| `coordinator` | Plans, delegates, checks results, reports to the user | write | primary | `coordinator` |
| `researcher` | Context gatherer. The web first, then the machine | read, and result files outside the project | task session | `researcher` |
| `scout` | Context gatherer. The machine first, then the web. Finds and quotes facts; a judgement of a diff goes to a reviewer | read, and result files outside the project | task session | `scout` |
| `worker` | One bounded change, verified | write | task session | `worker` |
| `reviewer` | Review of a plan, a diff or code | read | task session | `reviewer` |

A role is an order of preference, not a set of limits. Each role prompt starts
with "The task has priority", then gives its methods in order, with a fallback
for each. `spawn.py` removes no tool unless you add `--strict`, with one
exception: the desktop tools.

The read roles (`researcher`, `scout`, `reviewer`) start without the desktop
tools of the computer-use modules. A pi pane gets `--exclude-tools
computer_use_*`, which matches the Linux tools `computer_use_linux_*` and the
macOS tools `computer_use_*`; a Claude Code pane gets `--disallowedTools
mcp__plugin_computer-use-linux_computer-use-linux`. Pi does not register an
excluded tool, so the deferred tool search of the macOS module cannot load it
either (source reading of Pi 1.4.0). The `coordinator` and the
`worker` keep them. These tools read the screen and send input to the desktop,
and the screen content goes to the model provider; a read role does not need
them. A pane without the module ignores the option (source reading for pi:
the option only filters tool names).

A task that needs the desktop in a read role has two ways:

- pi: add native arguments after `--`. A later `--exclude-tools` replaces the
  earlier list (source reading of the Pi 1.4.0 argument parser), so
  `-- --exclude-tools ''` keeps every tool, and `-- --exclude-tools edit,write`
  keeps the desktop tools under `--strict`.
- Claude Code: start a `worker` pane instead. Not verified: whether a later
  `--disallowedTools` replaces the earlier one.

The `researcher` and the `scout` are both context gatherers with the same tools.
The `researcher` starts with the web. The `scout` starts with the local machine,
and can read a repository on the web or the documentation of an app when the
task needs it. Use the role whose first focus fits the larger part of the task.

## 2a. Resources: tools and skills with their locations

`resources.json` is a catalog of the tools, skills and processes that a started
agent can use. It is a list of suggestions in order of preference, not a set of
limits.

| Step | What happens |
| --- | --- |
| Launch | `spawn.py` finds, for each entry, the first location that is present on the machine. It puts one line for each entry into the role prompt: title, when to use it, how to load it, location. |
| Work | The agent starts with the first entry that fits. It loads the full text of an entry only when it uses it. |
| Failure | The agent goes to the next entry and records the error. `resources.py` shows the list again with the state of each location at that time. |
| No entry works | The agent reports what it tried. The coordinator corrects the task or asks the user. |

```bash
python3 $S/resources.py                # all entries, with the location that is present
python3 $S/resources.py --group web    # one group: web or local
python3 $S/resources.py --role scout   # one role; omit --role to show every entry
python3 $S/resources.py --group web --role scout   # one group for one role
python3 $S/resources.py harness-web    # one entry, with all its locations
```

Default entry for the web: `harness-web`, the web tools of the harness. Default
order for the machine: `local-search`, `local-machine`, `local-services`.

A machine file at `~/.config/herdr-skill/resources.json` adds or replaces
entries for one machine. `resources.local.example.json` shows the format.
`install.sh` does not change the machine file.

An entry can have a `roles` list of names from `roles.json`, for example
`"roles": ["scout"]`. Only those roles see the entry in their prompts.
Without `roles`, every role can see it. An empty list shows it to no role.
This filters prompt suggestions, not tool access. Invalid `roles` values stop
the launch with the catalog path and the reason.

The catalog ships no entry that only one machine has. These entries are
optional. Add them to the machine file when the machine has them:

| Optional entry | What to set | Effect |
| --- | --- | --- |
| A search MCP server, for example `donsetch` in the example file | `kind` with the value `mcp`, a `url` location, and `mcp_server` when the server name is not the id of the entry. An optional `headers_helper` shell command supplies dynamic HTTP headers; use a helper that reads credentials from the environment. An `order` below 30 puts it before `harness-web`. | The role prompt lists it. For Claude Code, `spawn.py` writes an MCP configuration with each such server for a role with web access, includes `headersHelper` when `headers_helper` is set, and allows its tools as `mcp__<server>`. |
| A desktop browser skill, for example `desktop-browser` in the example file | `kind` with the value `skill` and a `file` location of the skill on the machine | The role prompt lists it with its location. |
| `launch.pi_mcp_config_strict` | The path of an MCP configuration file of pi, for example `~/.pi/agent/mcp-researcher.json` | With `--strict`, a pi session with web access starts with `--mcp-config <path>`. Not set: `spawn.py` adds no MCP option. |

With no MCP entry, `spawn.py` gives Claude Code no MCP configuration and allows
no MCP tool. The session keeps the MCP servers of the user.

For a Pi wrapper, set `launch.pi_executable` in the machine file to an absolute
executable path, such as the installed `tenant-pi` launcher. Model discovery
uses that executable. New POSIX shell panes receive a shell-local `pi` function
that calls the wrapper; Herdr still tracks the agent as `pi`. Existing panes
and shell startup files remain unchanged. Without this setting, `pi` remains
the launcher. An invalid path or unsupported shell fails without fallback.

Pi-Bolt (the Pi coding agent compiled to one native executable) works as
`launch.pi_executable`. Known limit of Herdr 0.9.5:

- Pi-Bolt has a built-in Herdr reporter. When `HERDR_ENV=1`, `HERDR_PANE_ID`
  and `HERDR_SOCKET_PATH` are all set, it reports the agent name `pi-bolt`.
  Herdr 0.9.5 does not know that name, so `herdr agent start --kind pi` fails
  with `agent_kind_mismatch: expected pi, detected pi-bolt`.
- `spawn.py` runs `<executable> --version` once. When the line names Pi-Bolt,
  the `pi` function of the new pane unsets `HERDR_SOCKET_PATH` for Pi-Bolt.
  Pi-Bolt then skips its reporter. No wrapper script is necessary.
- Herdr detects a Pi agent from the file name of the started program. It must
  be `pi`. Set the setting to an installed `tenant-pi` launcher with the
  Pi-Bolt runtime: `install.sh --runtime pi-bolt` makes the launcher start the
  release file `pi` of the Pi-Bolt installer. The `pi-bolt` link itself has
  the wrong name. The default Linux x86-64 build of Pi-Bolt 1.3.0 links
  `pi-bolt` to a start script. The launcher then starts the link, and the
  script ends in the release file `pi`, so the name is still `pi`.
- In the pane, Pi-Bolt and the commands that it starts have no
  `HERDR_SOCKET_PATH`. The scripts of this skill then do not reorder the tabs
  that the pane creates.
- Without the reporter, Herdr knows no transcript path of the pane. `ask.py`
  with a prompt (also the watch of `herdr_spawn` or `herdr_watch_start` with a
  prompt) then reads the session file of the pane on disk, in
  `<agent dir>/sessions/--<cwd with / as ->--/`, when exactly one file of the
  cwd matches. A file matches when a user entry ends with the prompt (a prompt
  of 20 to 200 characters) or holds the whole prompt (a longer prompt).
  Herdr shows the pane as idle and stalls on the prompt, so `ask.py` looks for
  the file for up to 60 seconds after the stall and then follows the turn in
  the file. The turn ends when the last message entry after the prompt is a
  final assistant reply (text, no tool call, no `error` or `aborted` stop) and
  the file has not changed for 5 seconds. A `custom_message` entry after the
  reply means that a new turn can run. No file in that time gives exit 5; a
  turn that still works at the timeout gives exit 124. Before it prints the
  reply, `ask.py` checks the file again by the rule that found it; a file that
  fails the check gives "no transcript path" and the screen.
  `ask.py` keeps the path of that file in the pane record. `ask.py
  --wait-only`, a wait-only watch and `last-reply.py` then read the file that
  an earlier prompt in this pane found. `--wait-only` follows it by the same rule. They read it only when the record of
  this pane id has the same agent name and a Pi harness, the file exists, and
  its header `cwd` is the current cwd of the pane. They also refuse the file
  when its header time is earlier than the pane record, or when another
  session file of the same folder has a later header time (after `/new`,
  `/resume` or a restart in the pane, or a later session in the same cwd).
  A new `spawn.py` record for a reused pane id has no path. Else they still say "no transcript path".
  The agent directories are `PI_CODING_AGENT_DIR` of the caller,
  `~/.pi/agent` and `~/.pi/profiles/*`. A `sessionDir` setting of Pi or
  `PI_CODING_AGENT_SESSION_DIR` moves the files out of reach of this search.

Remove this workaround when Herdr knows `pi-bolt` or Pi-Bolt reports `pi`.

The DonSeTch example uses `headers_helper` to read `DONSETCH_HTTP_TOKEN` when
Claude Code connects or reconnects. The generated MCP configuration stores only
the helper command, not the token. The desktop browser and
`mcp-researcher.json` path are also optional machine settings, as in
`resources.local.example.json`.

The source of truth is `roles.json`, `roles/<role>.md` and `resources.json` in this directory. A role sets no model. `contract.json` holds the exit codes of `ask.py` and `spawn.py` for the programs that start them.

| Session | Tab | Result format | Close after |
| --- | --- | --- | --- |
| primary (`coordinator`, or any role with `--interactive`) | The tab of the role | Normal answers to the user | Never. It belongs to the user. |
| task session | The tab of the role | `FINAL_COMPRESSED_CONTEXT` block | Yes, unless the user says "leave open" or "HITL" |

Optional `~/.config/herdr-skill/models.json` has the shape `{"roles":{"<role>":{"<harness>":{"model":"<name>","thinking":"<level>"}}}}`.
Each key is optional; `XDG_CONFIG_HOME` replaces `~/.config` when set. The order is request, then file.
With no model from either, `spawn.py` starts no pane and exits with 2; `agy` is the exception (section 3b). With no thinking level from either, the harness chooses.
A named model skips the file; a requested thinking level wins. The launch harness selects its entry.
The skill ships no model choice. Invalid files stop the launch with their path and reason.

- `--interactive` is for a session that the user works in. It gets no task session result format.
- "herdr fable" and "herdr opus" always mean `--harness claude`.
- pi: `spawn.py` checks the model against `pi --list-models`. A name that matches more than one provider gives exit 2 and the list of full names.
- Each agent that `spawn.py` starts can load this skill, so an agent in a task session can read and prompt other panes.
- The tab, the pane position and the name are fixed by `LAYOUT.md`. There is no input for them.

## 3. Start

In Pi with the `herdr_spawn` tool (the `herdr-watch` extension), start every
task session with `herdr_spawn`. One call does sections 3 and 4: it runs
`spawn.py`, sends the task with `ask.py` and watches the pane in the background.
Section 4 gives its parameters. Use the commands below for a dry run, for a
coordinator handoff, and in a session without the tool.

```bash
python3 $S/spawn.py --harness pi --role researcher --model example-model --thinking medium --cwd "$PWD" --dry-run   # shows the resolved values
python3 $S/spawn.py --harness pi --role researcher --model example-model --thinking medium --cwd "$PWD"
python3 $S/spawn.py --harness claude --role coordinator --model claude-opus-5-5 --thinking medium --cwd "$PWD"
python3 $S/spawn.py --harness pi --role scout --cwd "$PWD"                                                # model from the local file, else exit 2
```

The output is one JSON line with `name`, `model`, `model_source` and `thinking`.
`model_source` is `request` or `models.json`, including with `--dry-run`.
A live launch also reports `pane_id` and `placement`; a dry run reports `command` instead.
Standard error reports `model: <name> (from models.json)` or `model: <name> (from request)`.
The name is the handle for `ask.py` and `close.py`. Tell the user
the name, harness, role, model and thinking level.

Before the agent starts, `spawn.py` sets the variables of the session in the shell
of the new pane, so the agent and each command that it runs inherit them (also
Pi-Bolt through the `pi` function). `session_env` in the output shows them.

| Session | `OPENVIKING_RECALL_COMPRESS` |
| --- | --- |
| Task session (`worker`, `reviewer`, `scout`, `researcher`) | `off` |
| Primary session (`coordinator`, or `--interactive`) | default of the harness |

`OPENVIKING_RECALL_COMPRESS=off` turns the recall compressor of the memory
plugin off, so a task session makes no compressor model call.

## 3a. In a pane of the Herdr app

The Herdr app (`herdr-app`) keeps each pane as a terminal of herdr-core, and
`hc` is the CLI of herdr-core. Such a pane has `HC_TERMINAL_ID`. `spawn.py`
chooses the path from the backend (the `backend` entry of `contract.json`).
With no `HC_TERMINAL_ID` the backend is Herdr 1 with no check. When
`HC_TERMINAL_ID` is set, a candidate counts only when its pane or terminal is
live and is an ancestor of `spawn.py`; then a stale `HERDR_ENV` or
`HERDR_PANE_ID` does not count.

| The backend | Path |
| --- | --- |
| Herdr 1 (a classic Herdr pane, for example in kitty) | the `herdr` CLI, as section 3 says |
| herdr-core, and the terminal has the labels `herdr.space` and `herdr.tab` | `hc run` |
| herdr-core without these labels, or not clear | exit with an error; nothing starts |

When both candidates count, the nearer one (the inner one) wins. The `hc run`
path needs only `hc` (or `herdr-core`), not `herdr-app`.

On the `hc run` path the inputs, the name, the role prompt and the output line
are the same. These points differ:

- The new terminal gets the labels `herdr.space` and `herdr.tab`, so the app
  shows it as a pane in the space of the caller. Each role has one tab in a
  space, and a coordinator goes into the tab of the caller (`LAYOUT.md`,
  section "On herdr-core"). The label `herdr.tab.name=<role>` names a new
  role tab in an app that reads it; an older app shows a number.
- The new coordinator of a handoff gets the label `herdr.split=down`, so the
  app puts its pane below the pane of the caller. No other role gets this
  value. An older app ignores it and puts the pane to the right.
- Each role other than coordinator gets the label `herdr.split=auto`, so the
  app splits the largest pane of the role tab, with the same split rule as
  Herdr 1. The app reuses no free pane. An older app ignores the value and
  puts the pane to the right of the last pane.
- herdr-core gives a new terminal its own environment. `spawn.py` starts the
  agent through an interactive shell of the user (`$SHELL -ic`), so the agent
  gets the same `PATH` and variables as a pane that the user opens.
- `pane_id` in the output is the herdr-core address, for example `t13`. The
  output has `"backend": "herdr-core"`.
- `init.py` and `panes.py` work there too: `init.py` prints the space, the
  tab, the role and the role tabs, and `panes.py` lists the live local
  terminals of the space. `ask.py`, `last-reply.py` and `close.py` work as
  sections 4 and 5 say; `handoff.py` works as the section "Coordinator
  handoff" says.
- These scripts act only on a local, live terminal (no address with `/`).
  `ask.py` sends the prompt one time with `hc send --wait`. A message to you
  ends that wait early: `ask.py` prints one line on stderr and waits again
  with `hc wait`, never with a second send. The hint after a timeout is
  `ask.py <address> --wait-only`.
- Transcripts: herdr-core wraps the sent text, so the user entry of the
  target is `<hc from="...">prompt</hc>`. The `from` value is your address,
  or your address and your name, for example
  `<hc from="t1f tenant-pi-worker-1">`. A Claude Code pane names
  its session in `~/.claude/sessions/<pid>.json`; `ask.py` reads the session
  of the same pid, also after `/clear` or a resume. A Pi pane writes to
  `<agent dir>/sessions/<folder of the cwd>/` (a `spawn.py` pane has
  the profile folder under `~/.pi/profiles/` in `PI_CODING_AGENT_DIR`). On
  herdr-core the end of a Pi turn comes from the status of the core, not from
  the session file. After the turn, `ask.py` searches for the one file that
  holds the prompt, inside or outside the wrapper, every 2 seconds for up to
  20 seconds, inside `--timeout`.
- `close.py` ends a terminal with `hc kill` only when `spawn.py` wrote a
  valid record for it on herdr-core in your space. Its refusal line names
  `hc kill <address>` as the command that the user can order.
- Exit 4 also covers an agent that gave no status in the start time. Read its
  screen with `hc read <name>`.

### Role set launch (`herdr-role-set`)

`scripts/role_set.py` (linked at `~/.local/bin/herdr-role-set` by the kit
installer) is the helper that the Start button of the Herdr app runs on the
computer of the space. It runs with no `HC_TERMINAL_ID`, no `HERDR_ENV` and no
`init.py` record, and takes its space and role settings from `--set '<json>'`
(plus optional `--dry-run`). The space ID is an opaque non-empty UTF-8 string
with no whitespace and no control characters, passed to `hc` as one argument
without a shell; a well-formed space ID with no live local terminals exits `0`
with zero actions.

An overview for people, with a picture of the Herdr app, is in
[`docs/role-set.md`](../../docs/role-set.md).

- Empty shell terminals in role tabs (`LAYOUT.md`, with `researcher` covering
  `scout`) get the configured harness, model and thinking through the same
  command builder as `spawn.py`. A terminal is treated as empty only when it is
  live, reports no app, agent, valid skill record or status state, and its
  foreground process is a known shell with `foreground.pid == terminal.pid`.
  Terminals that already host an agent, have an unknown foreground, or lie
  outside a role tab are skipped. Each launch command and prompt is built and
  the pane record is read from disk before the final `hc get` of the terminal;
  after that read, validation checks fresh metadata against the pre-read record
  and saved terminal identity in memory only (no disk read between the final
  `hc get` and `hc send`), and `hc send` follows directly. If the space, role
  tab, foreground, or agent state changed, the terminal is skipped.
- When the coordinator role is set and the live coordinator terminal's
  input-side transcript context size is above 200000 tokens (from the
  transcript lookup of `ask.py`), `herdr-role-set` sends the handoff command
  (`/tenantext:handoff_coordinator <harness> <model> [<thinking>] [roles=...]`
  for Claude Code, `/handoff_coordinator <harness> <model> [<thinking>]
  [roles=...]` for Pi) without waiting. When one or more task roles are set,
  the last argument is `roles=<role>:<harness>:<model>[:<thinking>],...`: the
  `spawn.py` inputs of researcher, worker and reviewer, in this order, for each
  role that is not on Any. A value with a space, a comma or a colon refuses the
  run before any launch. When the token count is above 200000 (so the threshold would
  otherwise allow a handoff), a coordinator choice with the `agy` harness cannot
  hand off (`handoff.py` refuses `agy`): `herdr-role-set` sets `handoff` to
  `false`, sends nothing, and gives the reason in dry-run output or on stderr;
  at or below 200000 tokens (or with unknown tokens), no `agy` reason is shown.
  Unknown tokens give `null` and no handoff. Before delivery, the command build,
  transcript lookup, token count, and pane record read all finish before the
  final cheap `hc get`; after that read, validation checks fresh metadata
  against the pre-read record and cached original coordinator identity in memory
  only (no disk read between the final `hc get` and `hc send`), and `hc send`
  follows directly: a coordinator whose space, role tab, harness, PID,
  transcript or token threshold changed is skipped (reason on stderr, exit `0`);
  a still-eligible coordinator at its prompt gets the command: state `idle`
  with `--if idle`; state `done`, or state `working` with a `status.msg` that
  ends in ` still running` and at least one child record in state `working`
  (`hc get` gives a child record as an object with `state` or as its bare
  state string), with no `--if`. Claude Code reports that `working` form after a completed
  turn while it waits for background shells, agents or monitors (for example
  `1 shell still running`); in a turn the message is the detail of the tool
  call. Any other `working`, `blocked`, missing or other state refuses with
  exit `1` and a line that says what the owner can do (for a turn: wait for
  the end of the turn and press Start again). Never `--force`, no retry. A
  tool detail that itself ends in ` still running` while a background task
  runs looks like the prompt; then the command arrives in the turn.
- A real run that sends no handoff (for each reason above, or with no
  coordinator choice) sends the live coordinator one line, the role models
  notice, when one or more task roles are set. The line starts with
  `[Herdr app Start]` and gives the `spawn.py` inputs of researcher (also
  scout), worker and reviewer, and the rule that they come before the local
  models file. The checks before the send are the final `hc get`, the same
  metadata check as for the handoff (space, tab, harness, PIDs) and the prompt
  state; no transcript or token check. A coordinator that is not at its prompt
  or that changed gets nothing: a skip line on stderr, exit `0`. The send uses
  the background terminal of the handoff, with the files
  `<state>/role-set/notice-send-<run id>.json` and `notice-job-<run id>.json`
  (the child removes the job file when it reads it; result files older than
  7 days go at a later send), `--if idle` for `idle` and never `--force`. In the
  fallback in the run, a send that fails is a skip line and exit `0`. The line
  is `{"version":1,"action":"role_models","terminal":"<address>","ok":true,"pending":true,"result":"<path>"}`
  (no `pending` and `result` in the fallback), it does not count in `done`, and
  `times` has `notice`. After the start of the background send or a delivered
  send, the record `<state>/role-set/notice-last.json` (mode 600) keeps the
  address, the roles value, the coordinator program PID and the terminal PID;
  a later Start with the same four values sends no notice. Entries older than
  7 days go; a record that cannot be read or written never fails the run. A
  dry run has `role_models`: `true` when these conditions hold at plan time
  (the prompt state is not part of it).
- Delivery is best effort by the owner's decision (the owner presses Start and
  watches the terminals). The pre-send checks lower the risk of acting on an
  occupied or changed terminal, but are no proof (for example, a shell waiting
  in a builtin such as `read`, or a change after the final read, is not ruled
  out), and `herdr-core` performs no prompt-readiness, session-identity or
  `done`-state check at delivery time. Each `hc send` waits for the smaller of
  90 seconds and the remaining 10-minute run deadline; on timeout, the helper
  reports an unknown delivery outcome and never sends again; the background
  handoff send waits 90 seconds and writes that outcome to its result file.
  `herdr-core` holds a send up to 60 seconds after a person's last key in the
  terminal, so a draft near the end of the run can give that unknown outcome.
- An `agy` pane gets the role prompt file and the first message of
  `spawn.py` (`agy_first_message`), after the other launches and the
  handoff. The startups of the panes can overlap; the helper waits at most
  90 seconds in total for their ready status: `status.app` is the `agy` app
  of `herdr-core` (`antigravity`), the `foreground` program is `agy`, and
  the state is `idle` or `done`. Then the helper tries to deliver the
  message with `hc send` (`--if idle` for `idle`) and does not wait for the
  turn. The launch line of an `agy` pane reports the outcome and has two
  more keys: `role_prompt` (the file, as in `spawn.py`) and
  `first_message` (`"sent"`: delivered, the turn is not confirmed; or `"not
  sent"`). A `"not sent"` line also has `first_message_error` (for example a
  startup question, no ready status in 90 seconds with what the terminal
  runs, a failed send, or a run that stopped first). The line keeps
  `ok: true` and the terminal address, and the run goes on. Check
  `first_message` before a task goes to the pane: for `"not sent"`, read
  the terminal and send the first message by hand if it is needed.
- Dry run prints one preview JSON line on stdout (including `launch` and
  `skip`). A real run writes only finished `launch`/`handoff`/`role_models` action lines
  (`ok: true`) and the final summary line on stdout, with one plain line on
  stderr for each skipped terminal (both plan-time and delivery-time skips,
  combining reasons, excluding a coordinator that receives a handoff, and
  replacing line breaks and control characters in dynamic fields with spaces).
  The final summary line of a real run, `ok` true or false, has `times`: the
  whole milliseconds of each step that ran (`total`, `discover`, `plan`,
  `launch`, and for a handoff `context`, `get`, `send`), with
  `coordinator_status` (the status read before the send).
  The handoff `hc send` runs in a background terminal of `herdr-core`
  (`hc run --bg --no-parent --rm --no-notify`, with no space or tab label),
  because `hc exec` ends each process that the helper starts when the helper
  ends. So the run does not wait for a send that `herdr-core` holds: `send` is
  the time to start the terminal, and `times` has `send_detached: true`. The handoff line has `pending: true`
  and `result`, the path of the file
  `<state>/role-set/handoff-send-<run id>.json` where the child writes `ok`,
  `outcome`, `error`, `send_ms` and `send_result` (the JSON object of
  `hc send --json`) when the send ends. When the background terminal does not
  start, the helper sends in the run itself, with `send_result` and
  `send_fallback: true` in `times` and no `pending`.
  Exit codes are in `contract.json` (`role_set`: `0` ok, `1` action or internal
  error, `2` bad input).
- The fixed model keys are `claude/<alias>`, `codex/<name>` and `agy/neon`.
  The thinking levels are `low` to `max` for `claude` and `agy`, and `minimal`
  to `max` for `codex` and `copilot`.
- `herdr-role-set --models` is read-only. It starts no pane, writes no file and
  calls no `hc` command. It runs `--list-models` with the Pi launcher of
  `spawn.py` (`launch.pi_executable`, else `pi`) and prints one JSON line:

  ```json
  {"version":1,"ok":true,"providers":{"copilot":{"models":["copilot/<id>"],"thinking":["minimal","low","medium","high","xhigh","max"]}}}
  ```

  `models` holds each `github-copilot` model of the listing as `copilot/<id>`,
  in the order of the listing. The Claude models of Copilot (IDs that start
  with `claude-`) are left out. A listing with no `github-copilot` line gives
  `"models":[]` and exit `0`. A failed listing (no Pi, a non-zero exit, or no
  result in 20 seconds) prints `{"version":1,"ok":false,"error":"<cause>"}`
  and exits `1`.
- Each of the four roles also takes a key `copilot/<id>`. For a set with a
  `copilot/` key, the helper lists the models one time and accepts the key
  only when `--models` would show it. The key starts the harness `pi` with the
  model `github-copilot/<id>`. A key that is not in the list refuses the whole
  set before anything starts, with exit `2` and the key in the message. A failed
  listing refuses the set with exit `1` and the cause.
- A machine gets the Copilot models after `/login` for GitHub Copilot in Pi
  with the kit profile.
- `herdr-role-set --coordinator <space> <tab> [--dry-run]` makes a tab the
  coordinator tab of its space. The menu item "Set coordinator" of a tab runs
  it. `<space>` is the value of the label `herdr.space`, `<tab>` the value of
  the label `herdr.tab`. Both IDs follow the rule of the space ID. The skill
  stores no tab: the coordinator tab is the tab of the terminal with the
  coordinator role.
  - The candidates are the live terminals of the tab that run an agent. A
    terminal with a task role is never a candidate and never changes: a
    `skill.role` label, a `-<role>-<n>` name or a valid record of `worker`,
    `reviewer`, `researcher` or `scout`. A plain shell is no candidate, also
    when a saved record names the agent of an earlier session.
  - One candidate becomes the coordinator pane. Of two or more, the newest
    (the greatest `created_ms`) becomes the coordinator pane; in a stack it is
    the bottom pane. With no candidate, nothing changes.
  - The chosen terminal gets the label `skill.role=coordinator` and the
    coordinator record of `init.py`. Then each other terminal of the space with
    a coordinator label or record and no task role loses them: `hc label <t>
    skill.role=` and the removal of its record, as `handoff.py` does. Terminals
    of other spaces never change.
  - A second run changes nothing and prints `"changed":false`. A handoff from
    the chosen pane works as usual: the new coordinator goes below it and gets
    the label and the record, and the old pane ends.
  - Output is one JSON line:

    ```json
    {"version":1,"ok":true,"space":"<space>","tab":"<tab>","coordinator":"<address>","cleared":["<address>"],"changed":true,"dry_run":false}
    ```

    `coordinator` is `null` when the tab has no candidate. An unknown space or
    tab gives `"coordinator":null`, `"changed":false` and exit `0`.
    `--dry-run` makes no `hc label` call, writes no file, and prints the line
    of a real run with `"dry_run":true`.
  - Bad input (a missing ID, an invalid ID, or another argument) prints
    `{"version":1,"ok":false,"error":"<cause>"}` and exits `2`. A failed
    `hc label` or record write stops the run with exit `1` and the line with
    `"ok":false`, `"flagged"` (the chosen terminal has the label), the
    `cleared` terminals so far and `"error"`. The run time limit and an
    internal error after the start of the changes, or an output error of the
    success line, give the same line, with `coordinator`, `flagged`, `cleared`
    and `changed`. `changed` is `true` when a label really changed (set or
    cleared) or a record write ended, also when a later step failed.

### Coordinator handoff

To hand your work to the next coordinator session, write the handoff file (state of the work, open items, files, decisions) at a path agreed with the user, then run one command:

```bash
python3 $S/handoff.py --file <handoff.md> [--harness claude|pi] [--model m] [--thinking t] [--timeout 900] [--roles <value>]
```

`--roles` takes the value of the `roles=` argument of the handoff command unchanged: `<role>:<harness>:<model>[:<thinking>]`, joined by commas. The roles are researcher, scout, worker and reviewer; the harness is `pi`, `claude` or `agy`. A bad value exits 2 and starts nothing.

In Claude Code, run it with `run_in_background: true`, because the wait can pass the 10-minute limit of a foreground call. In Pi, run it in `bash`.

| Step | What `handoff.py` does |
| --- | --- |
| Checks | Inside Herdr, your pane is a coordinator, the file exists and is not empty. A failed check starts nothing. |
| Panes | It appends the section "Open panes at the handoff" to the file: each open task pane of the workspace. A rerun replaces the section. With `--roles` it also writes the section "Role models of the owner": the `spawn.py` inputs of each role, which the new coordinator uses for each pane of these roles. Without `--roles` it removes that section. |
| Start | `spawn.py --role coordinator` with your inputs, else `models.json`. The harness defaults to yours. The new pane appears below yours with the next number. |
| Confirm | `ask.py` sends the start prompt and waits for a reply line that starts with `HANDOFF-ACCEPTED` (the marker of `contract.json`). |
| Success | It appends the record to `handoffs.jsonl` beside the file (`"status": "recorded"`, and `"roles"` with the raw `--roles` value when given), sends the second prompt with `ask.py --timeout 45`, prints one result line, and closes your pane by its ID. The second send succeeds on `ask.py` exit 124 (the turn still works) or exit 0 with a new reply. Exit 0 with the line `note: reply was an API error` before the reply is a failure. |
| Failure | It closes nothing, leaves both panes open, and prints the cause with the pane ID and the name of the new pane. A failed second send appends one more line for the same handoff with `"status": "failed"` and the cause. |

On herdr-core (a pane of the Herdr app) the steps and the exits are the same, with these points:

- Checks: your terminal is a local pane of the Herdr app, and its valid record of `init.py` or `spawn.py` has the role coordinator and your space. Else exit 2: run `init.py` first.
- Panes: the section lists the live local terminals of your space that are not you and no coordinator, and that host an agent or have a valid record. When the list of the core fails, exit 2 and nothing starts.
- Start: the new coordinator goes into your tab. The first coordinator of a space has no name, so it counts as number 1: the new one is `<project>-coordinator-2`, then `-3`.
- Start: the new coordinator gets the label `herdr.split=down`, so its pane appears below yours.
- Success: the last step removes the local record of the skill for your pane and runs `hc kill` on your own terminal only: it ends your terminal (the app then closes its pane). Directly before the kill, `handoff.py` starts a helper for a best-effort cleanup of the core record of your terminal. The helper waits up to 60 seconds until the core shows your terminal as finished, then removes that record with `hc rm`, only when its labels name the role coordinator and your space. A failed `hc rm` changes no exit code.
- Failed kill: the local record is written back and the exit is 8. While your terminal stays live, the helper removes nothing.
- To show a pane to the user, use `hc read <address>` in place of `herdr agent read`.

The command closes your own pane after a confirmed handoff; do not close it yourself. Stop your own background waits on task panes before you run it, or let the new coordinator collect those replies with `ask.py <pane-id> --wait-only`.

| Exit of `handoff.py` | Meaning | What to do |
| --- | --- | --- |
| 0 | The handoff is recorded. Your pane closes | Nothing. The new coordinator continues. |
| 2 | A check failed. Nothing was started | Read the line. Correct the file or the input, or run `init.py`. |
| 3 | `spawn.py` failed, or its output has no pane ID | Read the line, as for the `spawn.py` exits below. Without a pane ID, look for the new pane with `panes.py`. |
| 4 | The new coordinator stopped at a startup question | Show the question to the user (`herdr agent read <pane-id> --source visible`, in the Herdr app `hc read <address>`). |
| 5 | No reply with the marker | Read the new pane with `last-reply.py <pane-id>`. Tell the user; both panes stay open. |
| 6 | The record was not written | Tell the user the line; both panes stay open. |
| 7 | The second prompt failed: the new coordinator waits on a question (`ask.py` exit 4), is busy, started no turn, gave no new reply, gave an API error (also exit 0 with the note `note: reply was an API error`), or `ask.py` did not end or did not start | Show the new pane to the user (`herdr agent read <pane-id> --source visible`, in the Herdr app `hc read <address>`); both panes stay open. |
| 8 | Herdr did not close your pane | The handoff is done. Tell the user; stop work in this pane. |

The exits of `spawn.py`:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | The agent is ready | Send the task. |
| 2 | An input is not valid, for example no model from the request or `models.json` (for `pi` and `claude`), or `agy` is not in `PATH`. Nothing was started | Read the message. Correct the input: for a missing model, ask the user for one. |
| 4 | The agent stopped at a startup question, for example folder trust | `herdr agent read <pane-id> --source visible`, in the Herdr app `hc read <address>`. Show the question to the user. Wait for the decision. |
| 1 | The start failed. The new pane is closed again | Read the error. |

`herdr_spawn` gives the same exit codes. On exit 1, 2 or 4 it returns an error
result with the exit code, its meaning, and the last lines of the standard error
and the output of `spawn.py`. It starts no watch then. On exit 4 the error
result also names the pane ID and the name. It has no `close:` command, because
the pane waits for the decision of the user.

`spawn.py` sets the role prompt and the result format. Do not add them to the
task file.

`--strict` applies hard tool limits: read roles cannot edit files, and a role
with web access gets only the MCP servers of the catalog. For Claude Code these
are the `mcp` entries; with none, the session has no MCP server. With no MCP
entry, a Claude researcher under `--strict` has no web tool, because
`WebSearch` and `WebFetch` are also disallowed. For pi it is
the file in `launch.pi_mcp_config_strict`; with none, pi keeps its MCP
servers. Use `--strict` only when the user asks for hard limits.

## 3b. The agy harness

`agy` is the Antigravity CLI of Google. herdr-core reports an `agy` pane with
the agent name `antigravity`; the scripts call it `agy`. Herdr 1 starts it
with `herdr agent start --kind agy`.

### Start

```bash
python3 $S/spawn.py --harness agy --role worker --cwd "$PWD"                                   # the default model of agy
python3 $S/spawn.py --harness agy --role worker --model gemini-4-neon-xhigh --cwd "$PWD"       # a slug of `agy models`
python3 $S/spawn.py --harness agy --role worker --thinking high --cwd "$PWD"                   # agy --effort high
```

- `spawn.py` starts `agy` in `--cwd` through the same shell start as the
  other harnesses. The tab, the name, the labels and the record follow
  `LAYOUT.md`. The output line has `"harness": "agy"` and the field
  `effort`, the value of `--effort` or `null`.
- An `agy` pane that `spawn.py` (or `herdr_spawn`) starts gets the role
  prompt and the result format of its role, as the other harnesses do. A
  role-set launch (`herdr-role-set`) tries to deliver the same first
  message without a wait for the turn, and its launch line reports the
  outcome in `first_message` ("Role set launch"). `agy` has no
  system-prompt flag, so `spawn.py` writes the role prompt to the same kind of file as for `claude` and `pi`. When
  the pane is ready, `spawn.py` sends one first message through `ask.py`:
  read that file and follow it for each task. The pane counts as ready
  after that turn ends. The output line then has the fields `role_prompt`
  (the file) and `first_reply`; `--dry-run` shows the message in
  `first_message` and writes no file. A question in that turn gives exit 4;
  another failure of the turn gives exit 1, and the pane stays open. Before
  that wait, `spawn.py` prints one flushed stderr line
  `spawn.py started pane: {"pane_id": ..., "name": ...}` (prefix
  `spawn.started_line_prefix` of `contract.json`); the last stdout line stays
  the one JSON result. `herdr_spawn` reads that stderr line when it stops
  `spawn.py` at its limit (600 seconds for `agy`) or on a cancel, and names
  the pane and its close command.
- `spawn.py` gives no `--dangerously-skip-permissions` and no `--mode`. Native arguments after
  `--` go to `agy`, for example `-- --mode plan`. `spawn.py` refuses `-p`,
  `--print`, `--prompt`, `-i`, `--prompt-interactive` and `acp`, also after
  `--`: exit 2. It refuses these modes in each spelling (for example
  `-print`, `--print=x` or `-prompt=x`) and in each position, and it does
  not check other native arguments.
- `--strict` gives exit 2, because the skill sets no tool limit for `agy`.
  `--unattended` stays a `claude` option.
- `spawn.py` waits for the ready status of the pane as for the other
  harnesses. A startup question (folder trust, a login) gives exit 4: show
  it to the user and answer nothing.
- An `agy` worker that edits a worktree outside `--cwd` needs
  `-- --add-dir <worktree>`; else each edit stops on an "outside
  workspace" question.

### Model and effort

| Input | Rule |
| --- | --- |
| No model | `agy` starts with its own default model. This is no error, unlike `pi` and `claude`. |
| `--model <slug>` | The slug must be in the first column of `agy models`, a line `slug<TAB>name`. An unknown slug gives exit 2 and the list. When `agy models` fails (for example before the sign-in), exit 2. |
| `--thinking` | `low`, `medium`, `high`, `xhigh` or `max` (the values of `agy --effort`) becomes `--effort <level>`. `off` or `minimal` gives exit 2. |
| A slug with an effort part, for example `-xhigh` | The slug carries the effort, so `spawn.py` adds no `--effort`. A thinking level that names another effort gives exit 2: give the slug with the effort that you want, or leave the thinking level out. |
| `agy` not in `PATH` | Exit 2 with a message that names `agy`. |

`models.json` takes an `agy` entry in a role, as `models.example.json` shows.

### The reply

The end of a turn comes from the status of herdr-core, as for the other
harnesses. The core gives no transcript path for an `agy` pane, and the
transcript names no working directory. `ask.py` with a prompt then searches
`~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript.jsonl`
every 2 seconds for up to 20 seconds, inside `--timeout`. It takes a file
only when exactly one file holds the sent prompt in a `USER_INPUT` entry
created after the send. The text inside `<USER_REQUEST>` must match by the
rule of the Pi search: a prompt of 20 to 200 characters must end it, a longer
prompt must be in it whole, and a shorter prompt never matches.

The reply is the `content` of the last `PLANNER_RESPONSE` after that entry
and before the next `USER_INPUT`, when that step is done and calls no tool. A reply that the file cuts (its
`truncated_fields` names `content`) ends with a line that says so; read the
rest on the screen. The line `note: the core gave no transcript path; the
reply below is from the agy transcript on disk: <path>` comes before the
reply. Without exactly one file, or when the file has a shape that the
reader does not know, `ask.py` prints `NO TRANSCRIPT PATH` and the screen
tail. `ask.py --wait-only` and `last-reply.py` keep no file for an
`agy` pane: they show the screen tail.

A task session of `agy` ends its reply with the result block, as the other
harnesses do, and `ask.py` prints the "no result block" note when it is
missing. Send the task in the same form as to a `claude` or `pi` pane
(section 4). `close.py` ends an `agy` pane that `spawn.py` recorded, as for
the other harnesses. `handoff.py` starts no `agy` coordinator: exit 2.
herdr-core puts the sender line `<hc from=...>` around each prompt, so the
transcript shows that an agent sent it.

### The limits of the Antigravity terms

- Start only the official `agy` program, with its own sign-in.
- The skill never reads, copies or reuses the Antigravity login. The only
  file under `~/.gemini/` that a script opens is the transcript above: no
  credential file, no token, no settings file.
- No script of the skill puts `agy -p` (`--print`) or `agy acp` behind a
  model endpoint or uses them at all.
- The provider does not confirm in words that another agent may type
  prompts into `agy`. Decide with that fact before you use this harness.

### Not proven

- On herdr-core, the ready status and the first message have a live proof:
  a pane started from a trusted folder read the role prompt file and
  answered with its role. A pane in an untrusted folder stops at the
  folder-trust question with exit 4. Exit 4 at a sign-in question is not
  tested live.
- The transcript schema is not documented. The fields above come from real
  files of `agy` 1.5.15. A sent prompt in a `USER_INPUT` entry was seen
  wrapped as `<USER_REQUEST>`, then `<hc from=...>`.
- `--model` together with `--effort` is not tested with `agy`.
- Trust covers only the exact folder: start `agy` from a trusted folder and
  give the work folder with `-- --add-dir <folder>`.
- On Herdr 1, the agent name of an `agy` pane and a transcript path from
  Herdr are not known: expect `NO TRANSCRIPT PATH` and the screen.

## 4. Give the task and collect the result

Write the task to a file under `/tmp/`. State the objective, the files or
sources in scope, the checks, and the stop condition.

Write methods as a preference with a fallback, not as a ban:

| Do not write | Write |
| --- | --- |
| "Use only X. No replacement." | "Prefer X. If X fails, use Y and say so in the result." |
| "Stop if X is not available." | "If X is not available, try Y. Report a blocker only when no method works." |
| "Read-only." for an agent that must save a report | "Do not change files of the project. Save the report to `<path>`." |

Forbid a method only when the user forbade it. Then say that the user did.
When an agent reports a blocker, read its error, correct the task or the
method, and send it again before you ask the user.

### In Pi: `herdr_spawn`

| Parameter | Value |
| --- | --- |
| `harness`, `role`, `model`, `thinking` | As for `spawn.py`. `model` and `thinking` are optional. `herdr_spawn` refuses the role `coordinator`: a coordinator is a primary session. |
| `cwd` | The absolute working directory of the new agent |
| `prompt` or `prompt_file` | The task. Give exactly one. |
| `timeout_seconds` | Seconds that `ask.py` waits for the reply. Default 1500. |
| `label` | Optional. A short label for the notification. |
| `unattended`, `strict` | The options `--unattended` and `--strict` of `spawn.py`. Default false. |
| `extra_args` | Optional. Native arguments of the harness. `spawn.py` gets them after `--`. |

The call returns when `spawn.py` has started the pane (about 10 to 60 seconds,
at most 180). It names the pane ID, the name, the model and a task ID. Then the
watch runs in the background.
Tell the user the name, harness, role, model and thinking level. Then continue
with other work or end the turn. Do not wait, sleep or poll.

When the pane finishes, a `<herdr-task-notification>` message starts a turn:

- The `pane:` line names the pane ID and the name: `pane: <pane_id> (<name>)`.
- The `status:` line gives the meaning of the exit code of `ask.py`, as in the table of `SKILL.md`, section A2.
- The `close:` line is the command that closes the pane by its ID (section 5). After a timeout or a blocked status, the notification has no `close:` line: the pane still works.

### Without the tool: `ask.py`

Use the blocking `ask.py` only in Claude Code (there, call the `Bash` tool with
`run_in_background: true`), in a session without the tools, or when the user
says to wait for the reply or not to use the watch.

```bash
python3 $S/ask.py <name> --file /tmp/<task>.md --timeout 600
```

From a task session, use only the `FINAL_COMPRESSED_CONTEXT` block. Do not give the
raw transcript to the user.

Fan-out in Pi: call `herdr_spawn` one time for each task, all in one turn. Then
continue. The notifications arrive one by one, each with its pane ID.

Fan-out in Claude Code. Start all agents first. Then make one `Bash` call with
`run_in_background: true` for each line below, all in one turn:

```bash
python3 $S/ask.py proj-scout-1    --file /tmp/scout.md    --timeout 600
python3 $S/ask.py proj-reviewer-1 --file /tmp/reviewer.md --timeout 600
```

Each call reports when it ends. Continue with other work in the meantime.

Fan-out in a session without the tools and without a background shell. Run
the prompts in parallel in one blocking shell call, with a shell timeout above
`--timeout`:

```bash
python3 $S/ask.py proj-scout-1    --file /tmp/scout.md    --timeout 600 > /tmp/scout.out 2>&1 &
python3 $S/ask.py proj-reviewer-1 --file /tmp/reviewer.md --timeout 600 > /tmp/reviewer.out 2>&1 &
wait; tail -n +1 /tmp/scout.out /tmp/reviewer.out
```

## 5. Verify and close

- An idle agent is not proof of a result. Check that the files or the facts that you asked for exist.
- Close task panes after you have the result: `python3 $S/close.py <name> [<name> ...]`. On herdr-core, give the address or the name of a terminal.
- After a notification of `herdr_spawn`, run the command of its `close:` line. It closes the pane by its ID, not by its name. A name can come back for a later pane.
- Do not close a pane after the status `timeout, the pane still works` or `blocked on a question, read the screen`. The pane still works on the task or waits for the user.
- `close.py` refuses coordinator panes, interactive sessions, and panes that `spawn.py` did not start. That is correct.
- Leave the pane open when the user says "leave open", "HITL" or "I'll review". Report the pane ID and the name.

## Permission questions in claude agents

`spawn.py` starts each claude session in the `auto` permission mode. In that
mode the agent decides on most commands itself. A model without that mode (for
example Haiku) asks before each shell command. When an agent asks, it shows the
status `blocked`, and `ask.py` exits with 4. Show the question to the user and
wait.

Only when the user asks for an unattended worker, add `--unattended` (with
`herdr_spawn`: `unattended` true). It allows edits in advance. In the auto mode
the classifier still decides each shell command. It does not permit deploys,
restarts, deletion of live data, force-push, or output of secrets. State these
limits in the task file.
