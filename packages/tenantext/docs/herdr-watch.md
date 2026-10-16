# herdr-watch

`herdr-watch` is a Pi extension. It waits on an agent in a Herdr pane in the background. The coordinator gets control back at once and keeps taking prompts. When the pane finishes, the reply arrives in the session as a task notification. The model reads it and acts on it.

Without the extension, a coordinator calls `ask.py` of the herdr skill in its shell tool. That call blocks the turn for the whole run of the worker.

`herdr_spawn` also starts the pane. One call runs `spawn.py` of the herdr skill, sends the task and starts the watch.

## The rule

In Pi with this extension, the watch is the default:

- Start every task session with `herdr_spawn`.
- Send a prompt to a pane that exists with `herdr_watch_start`.
- Use the blocking `ask.py` only when the user says to wait for the reply or not to use the watch, or in a session without these tools.

The tools give this rule to the model as prompt guidelines. The herdr skill (`SKILL.md` section B, `SPAWN.md` sections 3 to 5) and the role prompt of the coordinator say the same.

## How it works

1. The model calls `herdr_spawn` with the inputs of a new pane and a prompt, or `herdr_watch_start` with a pane that exists and a prompt.
2. `herdr_spawn` only: the extension runs `spawn.py` of the herdr skill and waits for it, at most 180 seconds. `spawn.py` starts the agent in a new pane and prints the pane id and the name. When the start fails, the tool returns an error and stops here.
3. The extension writes the prompt to a file and starts `ask.py` of the herdr skill as a child process. The tool returns with a task id. It does not wait for the reply.
4. The session goes on. The owner can send other prompts.
5. `ask.py` sends the prompt to the pane, waits for the reply and exits.
6. The extension sends one custom message of the type `herdr-watch` into the session. When Pi is idle, the message starts a turn. When a turn runs, the message waits as a follow-up until that turn ends.

The extension starts no process when it loads. A pane or a watch starts only from a tool.

## Requirements

The kit does not install or check these host tools:

- The `herdr` command. `ask.py` uses it.
- Python 3 as `python3` on `PATH`.
- The scripts of the herdr skill.
- A Pi session that runs inside a Herdr pane. `ask.py` stops when `HERDR_ENV` is not `1`.

The extension looks for the scripts of the skill in this order:

1. `$HERDR_SKILL_DIR/scripts/`, when `HERDR_SKILL_DIR` is set. Then no other place is searched.
2. `~/.agents/skills/herdr/scripts/`, the installed skill.
3. `skills/herdr/scripts/` of this package, the kit copy.

`herdr_watch_start` takes the first directory with `ask.py`. `herdr_spawn` takes the first directory with `spawn.py`, and then uses `ask.py` and `close.py` of the same directory. When a script is not found, the tool fails with an error that names each searched path. No process starts then.

## Tools and the command

| Name | What it does |
| --- | --- |
| `herdr_spawn` | Starts a task session with `spawn.py`, then starts a watch on its pane. Parameters: see the next section. The call returns when `spawn.py` has started the pane: after about 10 to 60 seconds, at most 180 seconds. Then the watch runs in the background. Returns the spawn facts (pane id, name, model, thinking level, placement), the task id, the process id and the file paths. |
| `herdr_watch_start` | Starts a watch. Parameters: `pane` (pane id or agent name), `prompt` or `prompt_file` (exactly one), `timeout_seconds` (default 1500), `label` (optional short text). Returns the task id, the pane, the process id and the file paths. |
| `herdr_watch_status` | Without `id`: one line for each watch of the session, with the state, the elapsed time and the exit code. With `id`: one watch, its files and the last 2000 characters of its output. |
| `herdr_watch_stop` | Sends `SIGTERM` to the process group of one watch: `ask.py` and the `herdr` command that it waits on. The pane keeps running. No notification follows for a stopped watch. |
| `/herdr-watch [id]` | Shows the same list, or one watch, to the user. |

### Parameters of `herdr_spawn`

| Parameter | Value | `spawn.py` gets |
| --- | --- | --- |
| `harness` | `pi` or `claude` | `--harness` |
| `role` | `researcher`, `scout`, `worker` or `reviewer`. `coordinator` is refused. | `--role` |
| `model` | Optional. As for `spawn.py`. | `--model` |
| `thinking` | Optional. `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | `--thinking` |
| `cwd` | Required. The absolute working directory of the new agent. | `--cwd` |
| `prompt` or `prompt_file` | Exactly one. The task. | nothing; `ask.py` sends it |
| `timeout_seconds` | Default 1500 | nothing; `ask.py --timeout` |
| `label` | Optional short text for the notification | nothing |
| `unattended` | Default false. Claude write roles only. | `--unattended` |
| `strict` | Default false | `--strict` |
| `extra_args` | Optional list of native arguments of the harness | the list after `--` |

The extension runs `python3 spawn.py` with an argument list. No shell runs. The working directory of the process is the working directory of the session.

### Errors of `herdr_spawn`

These checks fail before any process starts. The tool throws an error:

- The role `coordinator`. A coordinator is a primary session, not a task session. For a coordinator handoff, run `spawn.py` in the shell (`SPAWN.md` of the skill).
- A `cwd` that is not an absolute path.
- Both or neither of `prompt` and `prompt_file`, an empty prompt, or a bad `timeout_seconds`.
- `--unattended` in `extra_args`. It is an option of `spawn.py`: set `unattended` to true.
- No `spawn.py`, or no `ask.py` beside it.

These cases return an error result (`isError: true`). No watch starts:

| Case | The result names |
| --- | --- |
| Exit 1: the start failed. `spawn.py` closed the new pane again. | The exit code, its meaning, the last 2000 characters of the standard error and of the output |
| Exit 2: an input is not valid. Nothing was started. | The same |
| Exit 4: the agent stopped at a startup question. The pane stays open. | The same, the pane id, the name, and the command that reads the question. No `close:` command: the pane waits for the decision of the user. |
| Exit 0, but no JSON line with `name` and `pane_id` | The same |
| `spawn.py` runs longer than 180 seconds | The same. The extension sends `SIGTERM` to the process group of `spawn.py`, and `SIGKILL` after 5 seconds when it still runs. A new pane can stay open without a task. |
| The user stops the tool call while `spawn.py` runs | The same. The extension sends `SIGTERM` to the process group of `spawn.py`, and `SIGKILL` after 5 seconds when it still runs. A new pane can stay open without a task. |

The details of an error result hold `spawn` (the facts, or null), `exitCode`, `signal`, `timedOut` and `aborted`.

A relative `prompt_file` is read from the working directory of the session. The extension copies the prompt into the task directory, so a later change of the file has no effect.

The task ids are `w1`, `w2` and so on, in the order of the start.

## Files

Each session that starts a watch makes one state directory `herdr-watch-<random>` in the temporary directory of the system. Each watch has one directory in it:

| File | Content |
| --- | --- |
| `<task>/prompt.md` | The prompt |
| `<task>/stdout.txt` | The output of `ask.py`: a status line, then `--- reply ---` and the complete reply |
| `<task>/stderr.txt` | The error output of `ask.py` |

The extension passes `--max-chars 1000000` to `ask.py`. Without it, `ask.py` clips the reply at 8000 characters. The extension does not delete the state directory.

## The notification

```text
<herdr-task-notification>
task: w1 (docs review)
pane: <pane>
status: reply
exit: 0
output file: <tmp>/herdr-watch-<random>/w1/stdout.txt
reply (first 412 characters):
pane=<pane> agent=pi status=idle cwd=<dir> elapsed=95s transcript=<file>
--- reply ---
<the reply of the pane>
</herdr-task-notification>
```

A notification for a pane that `herdr_spawn` started:

```text
<herdr-task-notification>
task: w2 (fix)
pane: <pane_id> (<project>-worker-1)
status: reply
exit: 0
output file: <tmp>/herdr-watch-<random>/w2/stdout.txt
reply (first 380 characters):
pane=<pane_id> agent=pi status=idle cwd=<dir> elapsed=240s transcript=<file>
--- reply ---
<the reply of the pane>
close: python3 <scripts>/close.py <pane_id>
</herdr-task-notification>
```

- The label is in parentheses after the task id, when the watch has one.
- The label, the pane id and the name are one line each. The extension replaces control characters, line breaks and bidirectional controls with a space. A label has at most 80 characters; a pane id and a name have at most 64. `ask.py` gets the pane as it was given.
- For a pane that `herdr_spawn` started, the `pane` line names the pane id and the name: `pane: <pane_id> (<name>)`. The last line before `</herdr-task-notification>` gives the command that closes the pane by its id: `close: python3 <scripts>/close.py <pane_id>`. `<scripts>` is the directory of the `spawn.py` that started the pane. Run it after you verify the result.
- After a timeout (exit 124) or a blocked status (exit 4), the notification has no `close:` line. The pane still works or waits for the user. Do not close it then.
- A watch from `herdr_watch_start` has only the pane that was given. Its notification has no name and no `close:` line.
- The notification holds at most 12000 characters of the output. Then one line says how many characters more are in the output file.
- When `stderr.txt` is not empty, a section `stderr` follows with its last 2000 characters.
- In the terminal, the message shows one headline and the first line of the reply. Expand the message to see all of it.
- When the session has a user interface, a short notice also tells the user that the pane finished.

### Status words

The `status` line gives the meaning of the exit code of `ask.py`:

| Exit | Status | What to do |
| --- | --- | --- |
| 0 | `reply` | Use the reply. |
| 0 | `no new reply, read the screen` | `ask.py` found no new reply in the transcript. The output holds the screen tail. Read it. Do not send the prompt again before you know why. |
| 1 | `error, read the stderr file` | Read `stderr.txt`. For example, the session does not run inside a Herdr pane. |
| 2 | `usage error or bad target, nothing sent` | Check the pane id with `panes.py` of the herdr skill. |
| 3 | `busy, the pane works on another turn, nothing sent` | Start the watch again later. |
| 4 | `blocked on a question, read the screen` | Show the screen text to the user. Do not answer it yourself. |
| 5 | `no turn started, read the screen` | Read the screen. Do not send the prompt again before you know why. |
| 6 | `API error, the transcript holds no other reply` | Read the commit of the agent. Send the task again only in a new pane. |
| 124 | `timeout, the pane still works` | The prompt was delivered. Wait, then read the reply with `last-reply.py` of the herdr skill. |
| none | `killed by signal <name>` | Another process ended `ask.py`. The extension then sends `SIGTERM` to the process group of `ask.py`, so the `herdr` command that it waited on ends too. |

## Limits

- The watches live in the memory of the Pi process. A child process does not outlive its session. `session_shutdown` sends `SIGTERM` to each running watch: at quit, reload, new session, resume and fork. A hook on the exit of the Node process does the same when Pi exits without that event. After `SIGKILL` of Pi, a child runs until the timeout of `ask.py`, and no one reads its output.
- A stop or a shutdown ends only the wait. The pane keeps running, and the prompt can be delivered already. Read the reply later with `last-reply.py` of the herdr skill.
- After a reload or in a new session, the list of watches is empty. The notifications that arrived stay in the session.
- In print mode and JSON mode, Pi sends `session_shutdown` and exits when the run ends. A watch that runs at that time ends with Pi, and its notification does not arrive (source reading).
- A second watch on the same pane gets exit 3 while the first prompt runs.
- `promptr-watch-herdr-agents` of the `promptr` package is a different tool: a detached Python observer that wakes a coordinator one time with `herdr agent prompt`. `herdr-watch` runs inside the Pi process and has one watch for each task.

Not verified: a live Pi session that starts a watch on a Herdr pane, takes a second prompt during the wait, and reads the notification. Not verified: a live `herdr_spawn` call that starts a real pane, gets control back after `spawn.py`, and closes the pane after the notification.

## Tests

`npm test` runs `test/herdr-watch.test.ts`. The test writes a fake `ask.py` and a fake `spawn.py` and selects them with `HERDR_SKILL_DIR`. The fake `ask.py` prints a given output and exits with a given code: 0, 1 to 6 or 124. It can wait for a gate file, and it can start a grandchild in its process group, like the `herdr` command of the real `ask.py`. The cases with a grandchild check that a stop, the exit hook and an external signal end it too. The fake `spawn.py` records its arguments and prints a JSON line, or exits with 1, 2 or 4. One case makes it ignore `SIGTERM`, so the `SIGKILL` step runs. No test starts the real `ask.py`, the real `spawn.py` or a `herdr` command.
