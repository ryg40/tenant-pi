# coordinator-skills

`coordinator-skills` is one skill component of the kit. It ships skills for an agent that plans and coordinates work with the user: each skill is one directory with a `SKILL.md`, an `agents/openai.yaml` and a `CREDITS.md`. The skills work the same in Claude Code and in Pi. One shipped copy serves both harnesses.

Each folder of this directory is one skill. `resources.skills` of `coordinator-skills` in `config/manifest.json` names the shipped ones. The `description` of each `SKILL.md` says when to use the skill, and its `CREDITS.md` names the upstream source and the license.

The separate [knowledge-skills component](../knowledge-skills/README.md) ships OpenKnowledge discovery, skill authoring and OKF guidance.

## Install

The core install of the kit loads each skill of the component in the profile, and `install.sh` of the kit links each skill into `~/.claude/skills/`.

For every session of a user, run the install script:

```sh
packages/tenantext/skills/coordinator-skills/install.sh
```

- The script links each skill directory into `~/.claude/skills/` and into `~/.pi/agent/skills/`. It links a harness only when the directory of that harness exists (`~/.claude`, `~/.pi/agent`).
- A link points at the shipped directory. Do not move the kit after the install, or run the script again.
- It is safe to run again.
- A target that exists and is not a link stays as it is. The script reports it on standard error as `skipped: <path> exists and is not a link`. Move that copy away, then run the script again.
- `COORDINATOR_SKILLS_HOME` names another home directory. Use it for a test.

Start a new session, or run `/reload` in Pi, to load the skills.

`grilling`, `to-spec` and `to-tickets` on Pi use the tool `ask_user_question` of the extension `@juicesharp/rpiv-ask-user-question`. Its guidance file is `~/.config/rpiv-ask-user-question/config.json`. The settings template of the kit declares the extension. The kit does not write that file. Without the tool, the skill asks in plain text.

`to-spec` and `to-tickets` publish through the tracker contract `docs/agents/issue-tracker.md` of the repository. They need the token that the contract names.

`wayfinder` reads the tracker document `docs/agents/issue-tracker.md` of the repository. Without that file it stops. `wayfinder`, `research`, `prototype` and `get-status` start Herdr panes with the kit skill `herdr`. They name knowledge sources and review tools that the kit does not install: OpenViking, OpenKnowledge with the `okknow` skill, the LLM-WIKI tools of Pi, the `walkr` skill, `pidesktop` and an artifact server.

`pr` names `pidesktop` for a screenshot. `show-me` names the `walkr` skill and `pidesktop` for the review of an HTML artifact. The kit does not install them. Without them, use the text forms and Mermaid.

`dummies` keeps its log page through the `okknow` command of OpenKnowledge, and it reads the role of a pane from the `herdr` CLI. The kit installs neither. Without the `okknow` command the report and the outcome block still work, and no log is written. The `okknow` command is a host tool, a command-line path to OpenKnowledge that the kit does not ship: `dummies/scripts/page.py` needs three forms of it (`okknow --json read <page>`, `okknow write <page> - --summary <text>` with and without `--append`, and `okknow call edit -`), and without it the option `--file <path>` keeps the log in a local file that the user names. A fourth form, `okknow call exec`, only looks for the zone of another `DUMMIES` page: when it fails, the script asks for the zone. The two scripts of `dummies` need Python 3.11 or later and no package. [The `dummies` switch](#the-dummies-switch) says how to turn it on.

## The `dummies` readout

Claude Code and Pi use the same bordered tables from `dummies/REPORT.md` and `dummies/LOG.md`.
The first table pairs `Field` with `Detail`, in this order: `Goal`, `Open`, `Next`, `Important`.
The second table, `What was done`, has `#`, `Action` and `Resource and result` columns.
Its actions use past tense and describe completed work, not instructions.
The third table, `What's next`, has `#`, `Owner` and `Next step` columns.
It lists up to three likely steps with conditions or approvals. It does not authorize those steps.
When no steps remain, its one row says `No further steps.`
Headers are centered, cells are left-aligned, and each logical row has a separator.
Text wraps inside cells. All three tables target 70 columns and shrink for narrow panes.
Reports keep up to four completed actions; outcomes keep five. The title and all tables share one untagged code fence.
The OpenKnowledge log keeps its Markdown labels and tables. Its label order remains `Important`, `Open`, `Next`, `Goal`.
Completed actions map to `Done`; likely next steps map to `Next`. Existing entries and the switch behavior do not change.

The offline tests check borders, alignment, continuation lines, limits and both harness installation links.
Not verified: model compliance and live terminal rendering in either harness.

## The `dummies` switch

`dummies` is off until the user turns it on, one time for each harness. The three words are the same in both harnesses.

| Harness | On | Off | State |
| --- | --- | --- | --- |
| Claude Code | `/dummies on` | `/dummies off` | `/dummies status` |
| Pi | `/skill:dummies on` | `/skill:dummies off` | `/skill:dummies status` |

- The state is one small file for each user, outside each repository: `dummies-skill/state.json` in `XDG_CONFIG_HOME`, or in `~/.config`. It holds one value for each harness, so `dummies` can be on in one harness and off in the other. No file means off. The script `dummies/scripts/state.py` reads and writes it. A relative `XDG_CONFIG_HOME` is not used: the file is then in `~/.config`. A state file that is a link is refused with exit 3 and is not written. After `on --autostart` the file also holds two lists for each harness: `autostart`, the instruction files that got the block, and `created`, the files that `on` created.
- On: a coordinator session of that harness uses the report form and adds the log entry at the end of its work. Off: no report form and no log entry. The three words still work, and so does a direct request of the user for one log summary: a short answer from the log page about where things stand.
- `on` changes the state file only. A session then uses the report form after the user starts `dummies` by name. `on` prints the autostart block and the file that the block goes into.
- `on --autostart` is the option that starts the report form in each new coordinator session with no word of the user. It adds a marked block of three lines to the user instruction file of the harness: `CLAUDE.md` in the configuration directory of Claude Code, or the context file in the agent directory of Pi. The block tells a coordinator session to read `dummies/REPORT.md`. The scripts change no other instruction file and no settings file.
- `off` removes the block. The two marker lines of the block are complete lines: a line of the user that quotes a marker is text of the user. After `on --autostart` and then `off`, the instruction file has the same bytes as before, with each line end and with the end of the file as they were. `off` removes a file only when `on` created it. `off` uses a path of the `autostart` list only when it is an absolute path with the file name that the harness loads; it names each other path and does not change it.
- `off` always sets the state to off. When it cannot change an instruction file, for example a file with one marker line only, it names the file that needs a repair by hand and ends with exit 4.
- `dummies` is a skill that only the user starts (`disable-model-invocation: true`). So neither harness puts its description into the context of a session. Not verified for Pi: this comes from the program text of Pi 1.1.0, and no Pi session showed it.

Not verified: the six command forms in a live session. Claude Code adds the words of the user after the skill text. Pi 1.1.0 adds them after the skill block, as its skills document says.

Not verified: that Pi loads only the first context file of its list that exists. The rule comes from the document of Pi 1.1.0, and no Pi session showed it. `on --autostart` uses the rule to choose the file for Pi.

A session can know the state at its start, without a load of the skill text, in these ways:

| Harness | Way | In this kit |
| --- | --- | --- |
| Claude Code | The user instruction file `CLAUDE.md` is in the context of each session. | The autostart block. |
| Claude Code | A `SessionStart` hook of a settings file or of a plugin can add one line to the context. It can stay silent when the state is off, and in a task pane. | Not built. It needs a change of a settings file, or of the plugin of this package. |
| Pi | The context file of the agent directory is in the system prompt of each session: `AGENTS.md`, or the first file of the list of Pi that exists. | The autostart block. |
| Pi | An extension can add text at the `session_start` or the `before_agent_start` event. | Not built. It needs new extension code. |

## Token cost of `dummies`

This section holds one estimate, made one time. `dummies` never measures and never prints a token count when it runs. Make the estimate again after a change of the skill text or of the report form. Divide characters by 4, rounding to the nearest whole token (a half rounds up). This character-based estimate is not a tokenizer measurement; box-drawing symbols can have different costs. The estimate holds while `dummies/REPORT.md` has fewer than 6 500 characters: `tests/test_dummies_contract.py` of the kit fails at that size.

| State | Cost |
| --- | --- |
| Off | 0 tokens in both harnesses: no description in the context, no block in an instruction file, no command. For Pi, the absent description is not verified: see the section above. |
| On, with no autostart block | 0 tokens until the user starts `dummies` in a session. Then `SKILL.md` (341 tokens) and `REPORT.md` (1 522 tokens) stay in that session. |
| On, with the autostart block | The block, about 93 tokens, in each session of that harness, also in a task session. A coordinator session then reads `REPORT.md` (1 522 tokens) and runs the state check (about 81 tokens). |

The base is one measured coordinator session that used pasted rules, with no grouping and no script: 84 model requests, 17 778 output tokens, and 9.5 million input tokens with cache reads. Its reports and trees were about 3 000 output tokens. The same tokens, read again in later requests, were about 120 000 input tokens. Without them the session has 14 778 output tokens and 9.38 million input tokens.

| Part of the same session with `dummies` on | Calculation | Tokens |
| --- | --- | --- |
| `REPORT.md`, read again in each later request | 1522 x 83 | 126 326 input |
| The autostart block | 93 x 84 | 7 812 input |
| The state check with its output line | 81 x 83 | 6 723 input |
| 9 reports of 520 tokens, each read again in half of the requests | 9 x 520 x 42 | 196 560 input |
| The end of the work, read again in 3 requests: `LOG.md` (2 416), the outcome block (698), the entry command (330), the script output (60) | 3 504 x 3 | 10 512 input |
| 9 reports | 9 x 520 | 4 680 output |
| The outcome block | 1 x 698 | 698 output |
| The entry: the body and the `add` command. An entry written by hand was about 800. | 1 x 330 | 330 output |
| Three tool calls of the skill | 3 x 40 | 120 output |
| Sum | | 347 933 input and 5 828 output |

| Measure | Estimate | Calculation |
| --- | --- | --- |
| All tokens of a session | About 3.8 % more (range 3.1 % to 4.5 %) | 353 761 / 9 394 778 = 3.8 %. With 6 reports: 286 681 / 9 394 778 = 3.1 %. With 12 reports: 420 841 / 9 394 778 = 4.5 %. The share is higher in a session with a small context: `REPORT.md` is 1 522 tokens in each request. |
| Output tokens of a session | About 39.4 % more (range 28.9 % to 50.0 %) | 5 828 / 14 778 = 39.4 %. With 6 reports: (6 x 520 + 698 + 330 + 120) / 14 778 = 4 268 / 14 778 = 28.9 %. With 12 reports: (12 x 520 + 698 + 330 + 120) / 14 778 = 7 388 / 14 778 = 50.0 %. |
| Cost | About 6.3 % more (range 4.9 % to 7.7 %) | An output token costs five input tokens, and a cached input token costs one tenth: (347 933 x 0.1 + 5 828 x 5) / (9 380 000 x 0.1 + 14 778 x 5) = 63 933.3 / 1 011 890 = 6.3 %. With 6 reports the fourth row is 6 x 520 x 42 = 131 040, so the sums are 282 413 input and 4 268 output: (282 413 x 0.1 + 4 268 x 5) / 1 011 890 = 49 581.3 / 1 011 890 = 4.9 %. With 12 reports the fourth row is 262 080, so the sums are 413 453 input and 7 388 output: (413 453 x 0.1 + 7 388 x 5) / 1 011 890 = 78 285.3 / 1 011 890 = 7.7 %. |

- A session with a high thinking level has more output tokens, so its percentage for output tokens is lower.
- The first setup of a new page is not in the estimate.
- The estimate has one end of the work. Each later task of a long session that ends adds 1 148 output tokens (698 + 330 + 120), 7.8 % of 14 778.
- The example report has 71 words and 520 tokens, including its two fence lines; the outcome block has 698 tokens.
- The outcome block replaces the report of the last turn. The estimate keeps 9 reports beside the outcome block, so it is one report too high.
- The new counts are `SKILL.md`: 1 364 characters / 4 = 341 tokens; `REPORT.md`: 6 087 / 4 = 1 522; `LOG.md`: 9 662 / 4 = 2 416; the fenced report: 2 081 / 4 = 520; the fenced outcome block: 2 791 / 4 = 698.
- The borders increase the estimate: the measured session wrote about 3 800 output tokens for its reports, trees and entry. These tables give about 5 828. Grouping still avoids repeated reports.

To make the estimate again:

1. Divide the characters of `dummies/REPORT.md`, `dummies/LOG.md`, one report and one outcome block by 4; round half up. Include both fence lines and no final newline in the report and outcome block counts.
2. Take one coordinator session with `dummies` on. Count its model requests, its output tokens, its input tokens with cache reads, and its reports. Both harnesses record the usage of each request in the session file.
3. Put the numbers into the two tables above.

## Rules for a cross-skill call

A skill that needs another skill says: "Load the <name> skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi." The case of the first letter is free. The rest is exact, with single spaces. `<name>` is a skill of this component, or the kit skill `herdr`. A skill that only the user starts is never loaded from another skill: `grill-me`, `to-spec`, `to-tickets`, `wayfinder`, `retro`, `get-status`, `dummies`.

The test `tests/test_skill_invariants.py` of the kit checks these rules in each `.md` file of a skill directory and in this file.

## Credits rule

An original skill says that it is original and names the kit parts that it uses.

Each skill directory has a `CREDITS.md`. For an adapted skill, it names the upstream source, the upstream path, the upstream version and commit, and the licence, and it lists the changes from that upstream commit in two to five bullets. The upstream licence text is in `licenses/mattpocock-skills-MIT.txt` of this package, and `THIRD_PARTY_NOTICES.md` names the source. The skill `show-me` and the visual menu of `pr` come from `humanlayer/skills`, with credit to Dex Horthy; that licence text is in `licenses/humanlayer-skills-MIT.txt`. A new skill directory without `CREDITS.md` fails the test `tests/test_skill_invariants.py` of the kit.
