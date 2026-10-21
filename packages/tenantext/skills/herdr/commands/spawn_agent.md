---
description: Start a new Herdr agent pane from harness, role, model and thinking level
argument-hint: "[pi|claude] [coordinator|researcher|scout|worker|reviewer] [model] [thinking] <task>"
---

Start a new Herdr agent for: $ARGUMENTS

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Use function B. Read `SPAWN.md` in the skill directory.

1. Take harness, role, model and thinking level from the arguments. Pass the model and the thinking level as I give them. If I give no model, leave it out only when the local models file names one for the role and the harness; else ask me for it, because `spawn.py` starts no pane without a model. If I give no thinking level, leave it out. Ask me only if two roles fit the task.
2. If the request names a pane that exists already, do not start a pane. Use function A of the skill.
3. Run `spawn.py` with `--dry-run` first and tell me the resolved harness, role, model and thinking level in one line.
4. In Pi with the `herdr_spawn` tool, start a task session and send the task with one `herdr_spawn` call. Do not wait: the reply arrives as a `<herdr-task-notification>` message. For a coordinator, or without the tool, run `spawn.py` without `--dry-run`, then send the task with `ask.py --file`. Report the result, the model used, and the blockers.
5. Close task panes with `close.py` unless I ask you to leave them open. After a notification of `herdr_spawn`, run its `close:` line. Never close a coordinator or an interactive session.

The tab, the pane position and the name follow `LAYOUT.md` in the skill directory. `spawn.py` applies them.
