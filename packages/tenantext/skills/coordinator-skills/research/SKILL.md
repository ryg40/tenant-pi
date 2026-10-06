---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a comment on the research ticket. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a researcher pane.
---

Start a **researcher pane** to do the research, so you keep working while it reads.

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Write a task file that names the ticket, the question and the result form. Start a new Herdr pane of the role `researcher` with `spawn.py`. Select the model and thinking level from the request or the Herdr local defaults file, `~/.config/herdr-skill/models.json`. Follow `SPAWN.md` of the loaded `herdr` skill for precedence and harness defaults. A researcher needs a model with a web search tool. Send the task with one blocking `ask.py`, read the reply (`FINAL_COMPRESSED_CONTEXT`), and close the pane with `close.py`. The task file names `PI_CODING_AGENT_DIR` for any `pi` command, and the model or the cleared provider keys. One pane per research ticket. A pane is never reused: a second question or a fix round starts a new pane with its own task file.

Its job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it. Read what is already known first: the injected `<openviking-context>` block of the session, OpenViking `search` with `mode=context`, OpenKnowledge through the `okknow` skill (`okknow search` and the pages under `projects/<project>/`), and in Pi the LLM-WIKI tools `wiki_search` and `wiki_recall`, in that order.
2. Return the findings in its reply, citing each claim's source. A pane never writes a report file as its result channel. A Pi researcher may run `wiki_capture_source` for a cited web source.

Your job, when the reply arrives:

3. Post the findings as a comment on the research ticket; `docs/agents/issue-tracker.md` gives the operation. When the findings are long, put them on an OpenKnowledge page under `projects/<project>/` through the `okknow` skill and link the page from the comment. The findings never go to a file on `main`. With no ticket, give the findings to the user in the session.
