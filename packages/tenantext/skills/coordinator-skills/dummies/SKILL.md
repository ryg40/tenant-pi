---
name: dummies
description: The switch for the junior-developer report, the outcome block at the end of the work and the DUMMIES session log of a coordinator session. The words are on, off and status.
argument-hint: "[on|off|status]"
disable-model-invocation: true
---

# dummies

When `dummies` is on, a coordinator session reports its work in a form that teaches a junior developer, ends its work with an outcome block, and adds one entry to the human session log `DUMMIES` of the project. Set `D` to the absolute `scripts` directory beside this loaded `SKILL.md`.

Run the state check first. `<word>` is `on`, `off` or `status` when the user gave that word after the skill name. Else it is `status`.

```sh
python3 D/state.py <word>
```

| Case | What to do |
| --- | --- |
| The user gave `on`, `off` or `status` | Give the user the output. After `on`, ask one time if the autostart block that it prints goes into the file that it names. Run `python3 D/state.py on --autostart` only after a yes. After `off`, stop the report form in this session too. |
| The output starts with `dummies: off` | Stop. Use no other part of this skill. One exception: the user asks where the project stands. Then give the log summary of `LOG.md` beside this file. |
| The output starts with `dummies: on` | Read `REPORT.md` beside this file and apply it from its section 2. |
