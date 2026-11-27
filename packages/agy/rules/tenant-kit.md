---
trigger: always_on
description: Rules of the tenant-pi kit for Antigravity CLI - the terms line and the kit skills
---
## Terms of the Antigravity service

- Do not copy, print or reuse the Antigravity login (the files under `~/.gemini/` that hold the login) in another program, harness or proxy.

## Kit skills

- The skills of the tenant-pi kit are in the skills folder `~/.gemini/config/skills/`. Read the `SKILL.md` of a skill before you use it.

## Kit scripts and the terminal sandbox

- The scripts of the herdr skill that control panes check that they descend from the terminal of this pane. The terminal sandbox hides that process, so inside the sandbox these scripts stop.
- Run each script of the herdr skill with `BypassSandbox` set to true. Write it as one plain command with the interpreter and the absolute path of the script: `python3 <absolute path>/<script>`, for example `python3 ~/.gemini/config/skills/herdr/scripts/<script>` with your real home folder in place of `~`. Use no shell variable for the path and chain no other command to it: the allow rule matches the words of the command.
- Run `okknow read`, `okknow ls`, `okknow search` and `page.py` of the dummies skill the same way. They read settings that the sandbox hides, and they need the network. The kit adds no rule for another `okknow` command, so the normal approval applies.
- `ask.py` waits for the reply of the other pane. Give it `--timeout`, and start it as a background command when the wait is longer than your command limit.
- Each other command follows the normal sandbox and approval rules.
