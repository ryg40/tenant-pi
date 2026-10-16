# herdr-watch

`herdr-watch` is a Pi extension. It waits on an agent in a Herdr pane in the background. The coordinator gets control back at once and keeps taking prompts. When the pane finishes, the reply arrives in the session as a task notification. The model reads it and acts on it.

Without the extension, a coordinator calls `ask.py` of the herdr skill in its shell tool. That call blocks the turn for the whole run of the worker.

## How it works

1. The model calls `herdr_watch_start` with a pane and a prompt.
2. The extension writes the prompt to a file and starts `ask.py` of the herdr skill as a child process. The tool returns at once with a task id.
3. The session goes on. The owner can send other prompts.
4. `ask.py` sends the prompt to the pane, waits for the reply and exits.
5. The extension sends one custom message of the type `herdr-watch` into the session. When Pi is idle, the message starts a turn. When a turn runs, the message waits as a follow-up until that turn ends.

The extension starts no process when it loads. A watch starts only from the tool.

## Requirements

The kit does not install or check these host tools:

- The `herdr` command. `ask.py` uses it.
- Python 3 as `python3` on `PATH`.
- The scripts of the herdr skill.
- A Pi session that runs inside a Herdr pane. `ask.py` stops when `HERDR_ENV` is not `1`.

The extension looks for `ask.py` in this order:

1. `$HERDR_SKILL_DIR/scripts/ask.py`, when `HERDR_SKILL_DIR` is set. Then no other place is searched.
2. `~/.agents/skills/herdr/scripts/ask.py`, the installed skill.
3. `skills/herdr/scripts/ask.py` of this package, the kit copy.

When no `ask.py` is found, `herdr_watch_start` fails with an error that names each searched path.

## Tools and the command

| Name | What it does |
| --- | --- |
| `herdr_watch_start` | Starts a watch. Parameters: `pane` (pane id or agent name), `prompt` or `prompt_file` (exactly one), `timeout_seconds` (default 1500), `label` (optional short text). Returns the task id, the pane, the process id and the file paths. |
| `herdr_watch_status` | Without `id`: one line for each watch of the session, with the state, the elapsed time and the exit code. With `id`: one watch, its files and the last 2000 characters of its output. |
| `herdr_watch_stop` | Sends `SIGTERM` to the process group of one watch: `ask.py` and the `herdr` command that it waits on. The pane keeps running. No notification follows for a stopped watch. |
| `/herdr-watch [id]` | Shows the same list, or one watch, to the user. |

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

- The label is in parentheses after the task id, when the watch has one.
- The notification holds at most 12000 characters of the output. Then one line says how many characters more are in the output file.
- When `stderr.txt` is not empty, a section `stderr` follows with its last 2000 characters.
- In the terminal, the message shows one headline and the first line of the reply. Expand the message to see all of it.
- When the session has a user interface, a short notice also tells the user that the pane finished.

### Status words

The `status` line gives the meaning of the exit code of `ask.py`:

| Exit | Status | What to do |
| --- | --- | --- |
| 0 | `reply` | Use the reply. |
| 1 | `error, read the stderr file` | Read `stderr.txt`. For example, the session does not run inside a Herdr pane. |
| 2 | `usage error or bad target, nothing sent` | Check the pane id with `panes.py` of the herdr skill. |
| 3 | `busy, the pane works on another turn, nothing sent` | Start the watch again later. |
| 4 | `blocked on a question, read the screen` | Show the screen text to the user. Do not answer it yourself. |
| 5 | `no turn started, read the screen` | Read the screen. Do not send the prompt again before you know why. |
| 6 | `API error, the transcript holds no other reply` | Read the commit of the agent. Send the task again only in a new pane. |
| 124 | `timeout, the pane still works` | The prompt was delivered. Wait, then read the reply with `last-reply.py` of the herdr skill. |
| none | `killed by signal <name>` | Another process ended `ask.py`. |

## Limits

- The watches live in the memory of the Pi process. A child process does not outlive its session. `session_shutdown` sends `SIGTERM` to each running watch: at quit, reload, new session, resume and fork. A hook on the exit of the Node process does the same when Pi exits without that event. After `SIGKILL` of Pi, a child runs until the timeout of `ask.py`, and no one reads its output.
- A stop or a shutdown ends only the wait. The pane keeps running, and the prompt can be delivered already. Read the reply later with `last-reply.py` of the herdr skill.
- After a reload or in a new session, the list of watches is empty. The notifications that arrived stay in the session.
- In print mode and JSON mode, Pi sends `session_shutdown` and exits when the run ends. A watch that runs at that time ends with Pi, and its notification does not arrive (source reading).
- A second watch on the same pane gets exit 3 while the first prompt runs.
- `promptr-watch-herdr-agents` of the `promptr` package is a different tool: a detached Python observer that wakes a coordinator one time with `herdr agent prompt`. `herdr-watch` runs inside the Pi process and has one watch for each task.

Not verified: a live Pi session that starts a watch on a Herdr pane, takes a second prompt during the wait, and reads the notification.

## Tests

`npm test` runs `test/herdr-watch.test.ts`. The test writes a fake `ask.py` and selects it with `HERDR_SKILL_DIR`. No test starts the real `ask.py` or a `herdr` command.
