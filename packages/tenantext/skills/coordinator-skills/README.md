# coordinator-skills

`coordinator-skills` is one skill component of the kit. It ships skills for an agent that plans and coordinates work with the user: each skill is one directory with a `SKILL.md`, an `agents/openai.yaml` and a `CREDITS.md`. The skills work the same in Claude Code and in Pi. One shipped copy serves both harnesses.

| Skill | Use |
| --- | --- |
| `grilling` | Interview the user about a plan, three questions for each round, with a recommended answer first. |
| `grill-me` | The user command that loads `grilling`. |
| `wayfinder` | The user command that charts a large effort as a map of decision tickets on the issue tracker, and works the tickets. |
| `research` | Answer a question from primary sources in a researcher pane. The findings go to a comment on the ticket. |
| `prototype` | Build a throwaway prototype that answers a design question, on a branch that is never merged. |
| `domain-modeling` | Sharpen the terms of the project and write them to `GLOSSARY.md` at the repository root. |
| `to-spec` | The user command that turns the conversation into a spec and publishes it as one Gitea issue. |
| `to-tickets` | The user command that breaks a spec into tracer-bullet tickets and publishes them on Gitea with native dependencies. |
| `pr` | The template of a merge record: the comment on the Gitea issue of a merged topic branch, and the body of a Gitea pull request. |
| `show-me` | Visual forms for conversation and Gitea comments: pseudocode, trees, Mermaid, diff, and an HTML artifact. |
| `retro` | The user command for a retrospective: findings from the last OpenViking sessions of both harnesses, each mapped to the file that enforces it. |
| `writing-for-agents` | The style reference for a document that an agent reads: a skill, a steering file, a doc behind a pointer. |

The separate [knowledge-skills component](../knowledge-skills/README.md) ships OpenKnowledge discovery, skill authoring and OKF guidance.

## Install

For one generated profile, enable the component `coordinator-skills` in the overlay. The profile then loads each skill of the component.

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

`grilling`, `to-spec` and `to-tickets` on Pi use the tool `ask_user_question` of the extension `@juicesharp/rpiv-ask-user-question`. Its guidance file is `~/.config/rpiv-ask-user-question/config.json`. The kit component `questions` declares the extension as a package of a generated profile. The kit does not write that file. Without the tool, the skill asks in plain text.

`to-spec` and `to-tickets` publish through the tracker contract `docs/agents/issue-tracker.md` of the repository. They need the token that the contract names.

`wayfinder` reads the tracker document `docs/agents/issue-tracker.md` of the repository. Without that file it stops. `wayfinder`, `research` and `prototype` start Herdr panes with the kit skill `herdr`. They name knowledge sources and review tools that the kit does not install: OpenViking, OpenKnowledge with the `okknow` skill, the LLM-WIKI tools of Pi, the `walkr` skill, `pidesktop` and an artifact server.

`pr` names `pidesktop` for a screenshot. `show-me` names the `walkr` skill and `pidesktop` for the review of an HTML artifact. The kit does not install them. Without them, use the text forms and Mermaid.

## Rules for a cross-skill call

A skill that needs another skill says: "Load the <name> skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi." The case of the first letter is free. The rest is exact, with single spaces. `<name>` is a skill of this component, or one of the kit skills `herdr` and `slopscore-pr`. A skill that only the user starts is never loaded from another skill: `grill-me`, `to-spec`, `to-tickets`, `wayfinder`, `retro`.

The test `tests/test_skill_invariants.py` of the kit checks these rules in each `.md` file of a skill directory and in this file.

## Credits rule

Each skill directory has a `CREDITS.md`. It names the upstream source, the upstream path, the upstream version and commit, and the licence, and it lists the changes from that upstream commit in two to five bullets. The upstream licence text is in `licenses/mattpocock-skills-MIT.txt` of this package, and `THIRD_PARTY_NOTICES.md` names the source. The skill `show-me` and the visual menu of `pr` come from `humanlayer/skills`, with credit to Dex Horthy; that licence text is in `licenses/humanlayer-skills-MIT.txt`. A new skill directory without `CREDITS.md` fails the test `tests/test_skill_invariants.py` of the kit.
