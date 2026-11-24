---
name: dummies
description: The switch for the junior-developer report, the outcome report at the end of the work and the DUMMIES session log of a coordinator session. The words are on, off and status.
argument-hint: "[on|off|status|log on|log off|format compact|format detailed]"
disable-model-invocation: true
---

# dummies

When `dummies` is on, a coordinator session reports its work in a form that teaches a junior developer, ends its work with an outcome report, and adds one entry to the human session log `DUMMIES` of the project. Set `D` to the absolute `scripts` directory beside this loaded `SKILL.md`.

Run the state check first. `<word>` is `on`, `off` or `status` when the user gave that word after the skill name. Else it is `status`.

```sh
python3 D/state.py <word>
```

| Case | What to do |
| --- | --- |
| The user gave `on`, `off` or `status` | Give the user the output. After `on`, ask one time if the autostart block that it prints goes into the file that it names. Run `python3 D/state.py on --autostart` only after a yes. After `off`, stop the report form in this session too. |
| The user gave `log on` or `log off` | Run `python3 D/state.py log on` or `log off` and give the user the output. With the log off, the reports stay, and the page `DUMMIES` gets no entry. With no `okknow` command, the entry goes to a local file in the config directory of the user. |
| The user gave `format compact` or `format detailed` | Run `python3 D/state.py format compact` or `format detailed` and give the user the output. The value is shared by Claude Code, Pi and agy. The next report of a session uses the new form: `compact` is the form of `REPORT.md`, `detailed` the form of `DETAILED.md` beside this file. |
| The output starts with `dummies: off` | Stop. Use no other part of this skill. One exception: the user asks where the project stands. Then give the log summary of `LOG.md` beside this file. |
| The output starts with `dummies: on` | Read `REPORT.md` beside this file and apply it from its section 3: you ran the state check, and sections 1 and 2 hold. |

## agy

`agy` is the Antigravity CLI. An `agy` coordinator session writes the report and the outcome report, as a Claude Code or Pi session does. Its instruction file is GEMINI.md in the directory ~/.gemini. Give `--harness agy` to `state.py`, and `--harness agy --model <identifier>` to `page.py add`, as `LOG.md` says. When GEMINI.md is a link, `on --autostart` writes the block through the link into the file that the link names, and the output names that file.
