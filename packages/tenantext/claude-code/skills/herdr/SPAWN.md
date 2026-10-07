# Start a new agent

Set `S` to the absolute `scripts` directory beside the loaded `SKILL.md`, including a plugin cache copy.

## 1. Before you start a pane

- Start a pane only when the user asks for one.
- Run `python3 $S/panes.py`. If an agent for the same task runs already, use it with `ask.py`. Do not start a second one.

## 2. Roles

| Role | Focus | Usual file access | Session | Tab |
| --- | --- | --- | --- | --- |
| `coordinator` | Plans, delegates, checks results, reports to the user | write | primary | `coordinator` |
| `researcher` | Context gatherer. The web first, then the machine | read, and result files outside the project | task session | `researcher` |
| `scout` | Context gatherer. The machine first, then the web | read, and result files outside the project | task session | `scout` |
| `worker` | One bounded change, verified | write | task session | `worker` |
| `reviewer` | Review of a plan, a diff or code | read | task session | `reviewer` |

A role is an order of preference, not a set of limits. Each role prompt starts
with "The task has priority", then gives its methods in order, with a fallback
for each. `spawn.py` removes no tool unless you add `--strict`.

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
python3 $S/resources.py harness-web    # one entry, with all its locations
```

Default entry for the web: `harness-web`, the web tools of the harness. Default
order for the machine: `local-search`, `local-machine`, `local-services`.

A machine file at `~/.config/herdr-skill/resources.json` adds or replaces
entries for one machine. `resources.local.example.json` shows the format.
`install.sh` does not change the machine file.

The catalog ships no entry that only one machine has. These entries are
optional. Add them to the machine file when the machine has them:

| Optional entry | What to set | Effect |
| --- | --- | --- |
| A search MCP server, for example `donsetch` in the example file | `kind` with the value `mcp`, a `url` location, and `mcp_server` when the server name is not the id of the entry. An optional `headers_helper` shell command supplies dynamic HTTP headers; use a helper that reads credentials from the environment. An `order` below 30 puts it before `harness-web`. | The role prompt lists it. For Claude Code, `spawn.py` writes an MCP configuration with each such server for a role with web access, includes `headersHelper` when `headers_helper` is set, and allows its tools as `mcp__<server>`. |
| A desktop browser skill, for example `desktop-browser` in the example file | `kind` with the value `skill` and a `file` location of the skill on the machine | The role prompt lists it with its location. |
| `launch.pi_mcp_config_strict` | The path of an MCP configuration file of pi, for example `~/.pi/agent/mcp-researcher.json` | With `--strict`, a pi session with web access starts with `--mcp-config <path>`. Not set: `spawn.py` adds no MCP option. |

With no MCP entry, `spawn.py` gives Claude Code no MCP configuration and allows
no MCP tool. The session keeps the MCP servers of the user.

The DonSeTch example uses `headers_helper` to read `DONSETCH_HTTP_TOKEN` when
Claude Code connects or reconnects. The generated MCP configuration stores only
the helper command, not the token. The desktop browser and
`mcp-researcher.json` path are also optional machine settings, as in
`resources.local.example.json`.

The source of truth is `roles.json`, `roles/<role>.md` and `resources.json` in this directory. A role sets no model.

| Session | Tab | Result format | Close after |
| --- | --- | --- | --- |
| primary (`coordinator`, or any role with `--interactive`) | The tab of the role | Normal answers to the user | Never. It belongs to the user. |
| task session | The tab of the role | `FINAL_COMPRESSED_CONTEXT` block | Yes, unless the user says "leave open" or "HITL" |

Optional `~/.config/herdr-skill/models.json` has the shape `{"roles":{"<role>":{"<harness>":{"model":"<name>","thinking":"<level>"}}}}`.
Each key is optional; `XDG_CONFIG_HOME` replaces `~/.config` when set. The order is request, file, harness default.
A named model skips the file; a requested thinking level wins. The launch harness selects its entry.
The skill ships no model choice. Invalid files stop the launch with their path and reason.

- `--interactive` is for a session that the user works in. It gets no task session result format.
- "herdr fable" and "herdr opus" always mean `--harness claude`.
- pi: `spawn.py` checks the model against `pi --list-models`. A name that matches more than one provider gives exit 2 and the list of full names.
- Each agent that `spawn.py` starts can load this skill, so an agent in a task session can read and prompt other panes.
- The tab, the pane position and the name are fixed by `LAYOUT.md`. There is no input for them.

## 3. Start

```bash
python3 $S/spawn.py --harness pi --role researcher --model example-model --thinking medium --cwd "$PWD" --dry-run   # shows the resolved values
python3 $S/spawn.py --harness pi --role researcher --model example-model --thinking medium --cwd "$PWD"
python3 $S/spawn.py --harness claude --role coordinator --model claude-opus-5-5 --thinking medium --cwd "$PWD"
python3 $S/spawn.py --harness pi --role scout --cwd "$PWD"                                                # local file or default model of pi
```

The output is one JSON line with `name`, `model`, `model_source` and `thinking`.
`model_source` is `request`, `models.json` or `harness default`, including with `--dry-run`.
A live launch also reports `pane_id` and `placement`; a dry run reports `command` instead.
Standard error reports `model: <name> (from models.json)`, `model: <name> (from request)` or `model: harness default`.
The name is the handle for `ask.py` and `close.py`. Tell the user
the name, harness, role, model and thinking level.

### Coordinator handoff

To hand your work to the next coordinator session:

1. Write the handoff file: state of the work, open items, files, decisions. Use a path agreed with the user; Claude Code defines no handoff directory.
2. Start the next coordinator: `python3 $S/spawn.py --harness <h> --role coordinator [--model m] [--thinking t] --cwd "$PWD"`. It appears below your pane with the next number.
3. Send it the path of the handoff file with `ask.py`, and ask it to confirm what it will do next.
4. Tell the user the name of the new coordinator. Do not close your own pane and do not close the new one.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | The agent is ready | Go to step 4. |
| 2 | An input is not valid | Read the message. Correct the input. |
| 4 | The agent stopped at a startup question, for example folder trust | `herdr agent read <pane-id> --source visible`. Show the question to the user. Wait for the decision. |
| 1 | The start failed. The new pane is closed again | Read the error. |

`spawn.py` sets the role prompt and the result format. Do not add them to the
task file.

`--strict` applies hard tool limits: read roles cannot edit files, and a role
with web access gets only the MCP servers of the catalog. For Claude Code these
are the `mcp` entries; with none, the session has no MCP server. With no MCP
entry, a Claude researcher under `--strict` has no web tool, because
`WebSearch` and `WebFetch` are also disallowed. For pi it is
the file in `launch.pi_mcp_config_strict`; with none, pi keeps its MCP
servers. Use `--strict` only when the user asks for hard limits.

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

```bash
python3 $S/ask.py <name> --file /tmp/<task>.md --timeout 600
```

From a task session, use only the `FINAL_COMPRESSED_CONTEXT` block. Do not give the
raw transcript to the user.

Fan-out. Start all agents first, then run the prompts in parallel in one shell call:

```bash
python3 $S/ask.py proj-scout-1    --file /tmp/scout.md    --timeout 600 > /tmp/scout.out 2>&1 &
python3 $S/ask.py proj-reviewer-1 --file /tmp/reviewer.md --timeout 600 > /tmp/reviewer.out 2>&1 &
wait; tail -n +1 /tmp/scout.out /tmp/reviewer.out
```

## 5. Verify and close

- An idle agent is not proof of a result. Check that the files or the facts that you asked for exist.
- Close task panes after you have the result: `python3 $S/close.py <name> [<name> ...]`.
- `close.py` refuses coordinator panes, interactive sessions, and panes that `spawn.py` did not start. That is correct.
- Leave the pane open when the user says "leave open", "HITL" or "I'll review". Report the pane ID and the name.

## Permission questions in claude agents

`spawn.py` starts each claude session in the `auto` permission mode. In that
mode the agent decides on most commands itself. A model without that mode (for
example Haiku) asks before each shell command. When an agent asks, it shows the
status `blocked`, and `ask.py` exits with 4. Show the question to the user and
wait.

Only when the user asks for an unattended worker, add `--unattended`. It allows
all shell commands and edits in advance. It does not permit deploys, restarts,
deletion of live data, force-push, or output of secrets. State these limits in
the task file.
