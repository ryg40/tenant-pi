---
name: memory-search
description: Search the memory stores (OpenViking, Hermes, the personal LLM Wiki) for one question, ranked by the local decision model. Use when a question is about earlier work, a decision, a preference or a stored fact.
---

# Memory search

Run one Bash command with the question in your own words. Put the question after `--` as ONE single-quoted Bash word, and write each single quote inside it as `'\''`, so no character of the question is expanded:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs" -- 'Why does $PATH differ in the owner'\''s profile?'
```

Options go before `--`. The plugin works only in place from the clone, because the command imports `../openviking-pi/shared/`.

It prints one block of at most 1,600 characters and exits 0 also when a store or the decision model is down.

- `[n] store | id | title` and the line below it: an excerpt, in rank order. `(id too long)` stands in place of an id that is too long to print; that hit has no lookup.
- `Pointers`: further hits with no excerpt. Read one in full only when its title bears on the question: an OpenViking `viking://` id with the OpenViking `read` tool, a `~/.llm-wiki/...` id with Read. A `hermes:` or `hermes-db:` id has no follow-up reader in this skill: to learn more, run the search again with a narrower question.
- `Not available`: stores that failed, were late or are missing. Name them in the answer: a missing store is not "nothing known".
- `Ranking fell back`: the decision model did not rank; the excerpts are the first hits, the stores in turn.

The search reads more than the automatic memory recall: all OpenViking memories of the user, all Hermes facts and the personal wiki `~/.llm-wiki`. Add `--no-personal-wiki` before `--` to leave out `~/.llm-wiki`. The search changes no memory data and adds no file beside the Hermes database.

The ranking request holds the question, at most 200 characters of each hit in total (title included; a short hit can fit whole) and the decider key. The client connects only to loopback; a forward on the computer can carry the request in plain HTTP to another host.
