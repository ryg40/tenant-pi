---
name: herdr
description: Control Herdr with the `herdr` CLI. Two functions. (1) Use an agent pane that exists - find it, read it, send it a prompt, wait, collect the reply. (2) Start a new agent in the tab of its role from four inputs - harness (pi or claude), role (coordinator, researcher, scout, worker, reviewer), model, thinking level. Use when the user names Herdr, a pane ("the pane to the right"), a tab, a workspace, another agent session, "herdr fable" / "herdr opus", or asks to spawn, launch, delegate or fan out. Works the same from Claude Code and from Pi.
---

# Herdr

Herdr is the terminal multiplexer that holds your pane. You control it with the
`herdr` CLI through your shell tool (`Bash` in Claude Code, `bash` in Pi).
There is no native `herdr` tool, no MCP server, and no `agent_spawn` tool.

Set `S` to the absolute `scripts` directory beside this loaded `SKILL.md`.
Use the loaded copy, including when Claude Code loads it from its plugin cache.

```bash
test "${HERDR_ENV:-}" = 1 || echo "not in Herdr"
S="<absolute skill directory>/scripts"
```

If the check fails, tell the user that you are not inside Herdr, and stop.

## 0. Start

```bash
python3 $S/init.py
```

It prints your workspace, tab, pane ID, name and role. On the first use in a
workspace it makes your tab the `coordinator` tab, moves it to position 1, and
names you `<project>-coordinator-1`. It is safe to run again. Tabs, panes and
names follow `LAYOUT.md`; the scripts apply it, so do not rename or move tabs
and panes by hand.

## 1. Choose the function from the user's words

| The user says | Function |
| --- | --- |
| "the pane to the right", "the other pane", "that session", "the existing agent", "use the pane" | A. Use a pane that exists. Do not start a pane. |
| "read the pane", "what is that agent doing" | A, steps A1 and A3 only. Send no input. |
| "spawn", "launch", "start", "new pane", "delegate", "fan out", "task session", "herdr fable", "herdr opus" | B. Start a new agent. |
| "solo", "no task sessions", "do it yourself" | Neither. Do the work yourself. |

A direction ("right", "left", "below") or the name of a pane always points to a
pane that exists. A large task is not a request for a new pane.

## A. Use a pane that exists

### A1. Identify the pane and tell the user

```bash
python3 $S/panes.py                           # panes in your workspace
python3 $S/panes.py --workspace "<label>"     # panes in a named workspace
herdr pane neighbor --pane "$HERDR_PANE_ID" --direction right | jq -r .result.neighbor.neighbor_pane_id
```

- The result `null` means that no pane exists in that direction. Ask the user which pane they mean.
- Always pass `--pane "$HERDR_PANE_ID"`. `--current` can resolve to the pane that has the UI focus.
- Tell the user in one line: pane ID, harness, status, working directory.

### A2. Send a prompt and collect the reply

Write the prompt to a file, then make one blocking call. For a prompt of one line, `--text "<prompt>"` replaces `--file`.

```bash
python3 $S/ask.py <pane-id-or-name> --file /tmp/task.md --timeout 600
```

Set the timeout of your shell tool above the `--timeout` value. In the prompt,
state the task, the limits (read-only or not), and the shape of the answer.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | The reply is printed | Use the reply. Continue the task of the user. A line `note: reply was an API error` means that the text is the last assistant message that the agent wrote after the prompt, not a final reply. When the note ends with `; from before this prompt`, the text is from an earlier turn. |
| 3 | The target works on another turn. Nothing was sent | `herdr agent wait <pane-id> --timeout 600000`, then call `ask.py` again. Or ask the user. |
| 4 | The target waits on a question or an approval | Show the screen text to the user. Do not answer it yourself. |
| 5 | Herdr wrote the prompt but no turn started | Read the screen. Do not send the prompt again before you know why. |
| 6 | The reply is an API error and the transcript holds no other reply | Read the commit of the agent for its record. Send the task again only in a new pane. |
| 124 | Time is up and the target still works | The prompt was delivered. Wait again, then use A3. |

### A3. Read the last reply without a prompt

```bash
python3 $S/last-reply.py <pane-id-or-name>
```

### A4. Finish the job

- The job is complete when you have the reply and you used it, not when the prompt is sent.
- Do not end your turn with "the pane is working on it" unless the user asked you only to send the prompt.
- Never close, interrupt or clear a pane that you did not start.

## B. Start a new agent

One command, four inputs. Read `SPAWN.md` in this skill directory before the first launch.

```bash
python3 $S/spawn.py --harness <pi|claude> --role <role> [--model <name>] [--thinking <level>] --cwd "$PWD"
```

| Input | Values | If the user does not give it |
| --- | --- | --- |
| harness | `pi`, `claude` | `claude` for "fable", "opus", "sonnet", "haiku", "claude". `pi` for a model name that `pi --list-models` finds. Otherwise your own harness. |
| role | `coordinator`, `researcher` (context gatherer, the web first), `scout` (context gatherer, local files and repositories first), `worker`, `reviewer` | Choose from the task. Ask only if two roles fit. |
| model | The name that the user gives. pi: `provider/model` or a name that `pi --list-models` finds one time. claude: a model ID or a CLI alias. | Leave it out. The local file can supply a default. |
| thinking | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Leave it out. The local file can supply a level. |

The user usually names the model and the thinking level. Pass them as given;
do not replace them.

Optional `~/.config/herdr-skill/models.json` supplies defaults in the shape `{"roles":{"<role>":{"<harness>":{"model":"<name>","thinking":"<level>"}}}}`.
Each key is optional; `XDG_CONFIG_HOME` replaces `~/.config` when set.
The order is request, file, harness default. A named model skips the file; a requested thinking level wins.
The skill ships no model choice. See `models.example.json`.

A role gives the agent an order of preference for its tools, with fallbacks.
It removes no tool. The task that you send has priority over the role.
The tools and skills come from the catalog `resources.json`, with the location
of each on this machine. `python3 $S/resources.py` shows the catalog. A search
MCP server and a desktop browser skill are optional entries of a machine file;
`SPAWN.md` section 2a explains them.

`spawn.py` chooses the tab, the pane and the name:

- Each role has its own tab: `coordinator`, `researcher`, `scout`, `worker`, `reviewer`.
- A new coordinator (a handoff) goes below the active coordinator pane.
- The name is `<project>-<role>-<n>`, for example `proj-scout-2`. Use it as the handle.

Then: send the task with `ask.py` (A2), verify the result, and close the pane
with `python3 $S/close.py <name>`. Details are in `SPAWN.md`.

## Rules from observed failures

| Do not | Do | Why |
| --- | --- | --- |
| Start a pane when the user names a pane that exists | A1 | A direction or a pane name points to a pane that exists. A new pane is not what the user asked for. |
| `herdr pane run <pane> "<prompt>"` or `send-text` to an agent | `ask.py` | `pane run` is for shell commands. It skips the blocked check and the paste mode. |
| `herdr pane wait-output` to wait for an agent | `ask.py` or `herdr agent wait` | The screen shows your own prompt. Words from the prompt match at once. |
| Send the prompt again after a timeout | `herdr agent get <pane-id>`, then wait again | A second prompt makes duplicate work. |
| `herdr pane read` for a long reply | `last-reply.py` | The screen of a TUI holds only the last page. |
| Run `herdr pane list` or `herdr agent list` with no filter | `panes.py` | The output holds all workspaces. |
| Read `--help` of each subcommand | `herdr --skill` one time | One call prints the full reference for the installed version. |
| Write `pi ...` or `claude ...` launch commands by hand | `spawn.py` | `spawn.py` checks the model and sets the flags, the role prompt and the layout. |
| `herdr pane split`, `herdr tab create` or `herdr pane rename` by hand | `spawn.py` | The layout and the names follow `LAYOUT.md`. |
| Write "use only X, no replacement" in a task | "Prefer X. If X fails, use Y and say so." | An agent stops with no result when the task and the role each forbid the other method. |
| Ask the user at the first blocker of an agent | Read the error, correct the task or the method, send it again | The agent often has a fallback that the task forbade. |

## Direct CLI use

Use the CLI directly only when the scripts do not cover the job. Verified on herdr 0.9.1:

```bash
herdr agent get <pane-id>                                     # harness, status, cwd, transcript
herdr agent wait <pane-id> --timeout 600000                   # settles on idle, done or blocked
herdr agent read <pane-id> --source recent-unwrapped --lines 120   # plain text, not JSON
herdr agent send-keys <pane-id> esc
herdr pane run <shell-pane-id> "<shell command>"              # shell panes only
```

Status values: `idle` and `done` both mean ready for input. `working` means a
turn runs. `blocked` means a question or an approval is on the screen.
`unknown` proves nothing.

These forms do not exist: `herdr wait agent-status`, `herdr wait output`,
`herdr action:"..."`, `herdr workspace list --json`, and tools named
`agent_spawn`, `agent_wait`, `agent_read`, `spawn_agent`, `spawn_manual`.
