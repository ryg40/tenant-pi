---
description: Hand the work of this coordinator to a new Herdr coordinator pane, then close this pane
argument-hint: "[pi|claude] [model] [thinking] [handoff file]"
---

Hand off my coordinator work for: $ARGUMENTS

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Read `SPAWN.md`, section "Coordinator handoff", in the skill directory.

1. Take harness, model and thinking level from the arguments. Pass them as I give them. Without a harness, `handoff.py` uses your own. Without a model, it uses the local models file; when that names none, ask me for a model.
2. Write the handoff file: state of the work, open items, files, decisions, and the next step. Use the path in the arguments, else the session folder of this work.
3. Stop your own background waits on task panes, or leave them for the new coordinator: the command lists the open panes in the file.
4. Run `python3 $S/handoff.py --file <handoff file> [--harness h] [--model m] [--thinking t]`. In Claude Code, call the `Bash` tool with `run_in_background: true`.
5. On success the command closes this pane; there is nothing more to do. On a failure, tell me its one line: both panes stay open, and the line names the new pane.
