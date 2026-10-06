---
description: Start a new Herdr agent pane from harness, role, model and thinking level
argument-hint: "[pi|claude] [coordinator|researcher|scout|worker|reviewer] [model] [thinking] <task>"
---

Start a new Herdr agent for: $ARGUMENTS

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Use function B. Read `SPAWN.md` in the skill directory.

1. Take harness, role, model and thinking level from the arguments. Pass the model and the thinking level as I give them. If I give none, leave them out; the local models file can supply defaults before the harness chooses. Ask me only if two roles fit the task.
2. If the request names a pane that exists already, do not start a pane. Use function A of the skill.
3. Run `spawn.py` with `--dry-run` first and tell me the resolved harness, role, model and thinking level in one line. Then run it without `--dry-run`.
4. Send the task with `ask.py --file`. Report the result, the model used, and the blockers.
5. Close task panes with `close.py` unless I ask you to leave them open. Never close a coordinator or an interactive session.

The tab, the pane position and the name follow `LAYOUT.md` in the skill directory. `spawn.py` applies them.
