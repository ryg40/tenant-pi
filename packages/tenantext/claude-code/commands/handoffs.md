---
description: List the handoff entries of idle panes (this repository first), show one, or set ack, done, dismiss or reopen
argument-hint: "[list] | show <id> | ack <id> | done <id> | dismiss <id> | reopen <id>"
---

Run the handoffs form: $ARGUMENTS

The script is `idle_cleanup.py` of the herdr-idle-cleanup skill. Take the first path that exists:

1. `$HERDR_IDLE_CLEANUP_DIR/scripts/idle_cleanup.py`, when that variable is set (then this path alone).
2. `$HOME/.agents/skills/herdr-idle-cleanup/scripts/idle_cleanup.py`.
3. `${CLAUDE_PLUGIN_ROOT}/skills/herdr-idle-cleanup/scripts/idle_cleanup.py`, the copy in this plugin.

1. Map the form to one command. An empty form is `list`.

   | Form | Command |
   | --- | --- |
   | `list` | `python3 <script> entries list --cwd "$PWD"` |
   | `show <id>` | `python3 <script> entries show <id>` |
   | `ack <id>` | `python3 <script> entries set <id> acknowledged` |
   | `done <id>` | `python3 <script> entries set <id> done` |
   | `dismiss <id>` | `python3 <script> entries set <id> dismissed` |
   | `reopen <id>` | `python3 <script> entries set <id> open` (only for a `presented` entry whose assessment did not arrive) |

   Any other form: show the argument hint above, and stop.
2. Run the command once. Show its output as it is. The script writes `index.json` under its own lock, so it is the only writer of a state.
3. If the script is missing, say that the herdr-idle-cleanup skill is not installed, and stop.
