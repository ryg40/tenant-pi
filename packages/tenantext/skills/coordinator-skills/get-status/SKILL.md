---
name: get-status
description: Gather the repository status into one bundle and start a Herdr coordinator for the next round. After PLAN, record the handoff when OpenKnowledge is present, send go, then close the sending pane only when go is confirmed delivered. Use for /get-status or "catch me up and hand off". Arguments are harness, model, thinking level, then optional focus words. Examples are "claude fable5.1 medium" or "pi astra high", only if the user's account has those models.
argument-hint: "<pi|claude> <model> <thinking> [focus words]"
disable-model-invocation: true
---

Warning: this command closes the pane that runs it after `go` is delivered.

# get-status

Gather the status and write one bundle with the work packet. Give the user a short status, then start a coordinator pane for the next round. Gather enough context for the coordinator to choose its round. After it sends `go`, the sending session closes after up to 60 seconds, but only when delivery is confirmed (section 6).

Needs / Optional: Herdr is needed for the launch step. An issue tracker, OpenViking (a memory service) and OpenKnowledge (`okknow`, a knowledge base) are optional. The kit installs none of them. For each absent source, write one line under Sources and continue. Without a tracker, skip section 2b. Without OpenViking, skip section 2d and read the local session files in [Session source, step 6](../retro/SKILL.md#session-source). Without OpenKnowledge, set `since` to seven days ago. Skip section 2e, the durable copy in section 3 and the handoff record in section 6.

## 1. Arguments

The arguments are the words after the command.

| Position | Value | Absent |
| --- | --- | --- |
| 1 | harness: `pi` or `claude` | your own harness |
| 2 | model, as the user writes it | left out; `~/.config/herdr-skill/models.json` can supply one |
| 3 | thinking: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | left out |
| 4 and later | the focus of the next round | none |

Model examples depend on the models of the user's account. Pass the requested model to `spawn.py`. For Claude, expand these aliases only if the user's account has the target model: `fable`, `fable5.1` and `fable 5.1` become `claude-fable-5-1`. The forms `opus`, `opus5.5` and `opus 5.5` become `claude-opus-5-5`; `sonnet` and `haiku` stay unchanged. `spawn.py` resolves a Pi model name against `pi --list-models`. On an ambiguous name (exit 2), use the matching `provider/model` form from its list. When two match, ask the user.

## 2. Gather

Set `since` to the time of the last entry of the OpenKnowledge handoffs page (section 2e), or seven days ago when the page is empty or absent. The bundle holds the facts since `since`, plus the standing state. Keep the source of each fact: a URL, a path or a `viking://` URI. A source that fails gives one line under Sources with the reason; continue with the next source. Read a whole document when a summary of it leaves a question open; the cost is yours, not the coordinator's.

The project slug is the basename of the repository directory in lower case, with each run of characters outside `a-z0-9_-` replaced by `-`.

### 2a. Repository and conventions

```sh
git status --short
git log --oneline -30
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads
git worktree list
git tag --sort=-creatordate | head -5
```

Read at the repository root, when present: `AGENTS.md` or `CLAUDE.md` (the check command, the merge target, the worktree and branch conventions), `GLOSSARY.md`, `HANDOFF.md`, `TODO.md`, and `docs/agents/issue-tracker.md`. The bundle restates the conventions that a worker breaks when it does not know them.

### 2b. Issue tracker

When present, `docs/agents/issue-tracker.md` decides where the tracker is and whether there is one. Never read a mirror as the tracker when the document names another place. Without the document, read issues from the `origin` host, Gitea or GitHub, when its token is present and the repository has issues. Use `curl` with `GITEA_TOKEN` for Gitea or `GITHUB_TOKEN` for GitHub.

Use these issue-list URLs. Replace the placeholders from the tracker document or `origin`:

| Tracker | Issue list |
| --- | --- |
| Gitea | `GET <gitea base URL>/api/v1/repos/<namespace>/<repository>/issues?state=all&type=issues&limit=50&page=<page>` |
| GitHub | `GET https://api.github.com/repos/<namespace>/<repository>/issues?state=all&per_page=50&page=<page>` |

For GitHub Enterprise, replace `https://api.github.com` with `<host URL>/api/v3`. Skip GitHub entries with a `pull_request` field. The shipped adapters `packages/promptr/src/tracking/gitea.mts` and `packages/promptr/src/tracking/github.mts` use these paths.

Skip this section when the document says the clone has no tracker, no token is present, or a request fails. Also skip it when the host is unsupported or the repository has no issue tracker. Write one line under Sources with the reason, then continue.

Read every page of open issues and the issues closed since `since`; check each `closed_at` field. Follow the tracker document's operations when present. If it defines a "Frontier", compute it as directed. Read the "Decisions so far" of each planning issue with `wayfinder:map`, when that convention applies. Read the full body and all comments of each available or claimed issue and each requirements issue it names. Gather the goal, acceptance criteria, research findings and review results. Refer to each issue by its named link, never by a bare number.

### 2c. Recent sessions

Read the last ten sessions of this project in both harnesses. The procedure is the section "Session source" of `../retro/SKILL.md`, the sibling skill directory: the OpenViking sessions of the project by `peer_id`, with the local session files as the fallback. Read the raw turns of the last three sessions and of each session whose summary leaves the outcome unclear. Take from each session: date, harness, role of the pane when it was one, what it did, the outcome, and each decision or blocker it recorded. Add one line for your own session.

### 2d. OpenViking memories

Read the injected `<openviking-context>` block first. Then search with `mode="context"` and `limit=10` for each of these queries:

- `<project> status decisions next steps`
- `<project> user rules preferences constraints`
- `<project> blockers environment quota`

In Pi the shipped package registers `openviking_search` and `openviking_read` from the server's tool definitions. In Claude Code these are `search` and `read` of the OpenViking MCP server. Check the available tools: the server supplies their names and parameters. Read each relevant abstract when the search result provides one. Read the memory text when the abstract names a rule or leaves a question open. `read` takes a list `uris` of file URIs and returns full text, with line-based `offset` and `limit` for paging. It has no abstract or overview level and cannot read a directory overview. See [the package upgrade notes](../../../../openviking-pi/README.md#upgrading-from-03x).

### 2e. OpenKnowledge

Through the `okknow` CLI or MCP server:

```sh
okknow ls projects/<slug>
okknow read projects/<slug>/handoffs
okknow read projects/<slug>/brief
okknow search "<project>"
```

Read the handoff entries since `since`, the brief when it exists, each page under the project changed since `since`, and each page that an available issue or a handoff entry names.

### 2f. Environment

Record what the coordinator can rely on: the names of the tokens that are set (`GITEA_TOKEN`, `GITHUB_TOKEN`, `OPENKNOWLEDGE_USERNAME`, and the ones the tracker document names; print a name and a length, never a value), the CLIs on `PATH` (`herdr`, `okknow`, `pi`, `claude`, `gh`), the panes that run now (`panes.py` of the herdr skill), and the environment blockers that the handoffs or the sessions record (a quota that is out, a red CI run with its cause, a service that is down).

## 3. Write the status and the bundle

Create the directory with `install -d -m 700 /tmp/get-status`. Create each file first with `install -m 600 /dev/null <file>`, then write into it. An overwrite keeps the mode. For a shell write, `umask 077` in the same command that writes the file is an alternative. Write the bundle to `/tmp/get-status/<slug>-<UTC time as YYYYMMDDTHHMMZ>.md`. Keep it within 400 lines, with a source for each fact.

```markdown
# Status bundle: <project>, <UTC time>

Sender: pane <your Herdr name>, <harness>. Repository: <path>, branch <name>, HEAD <short hash>.
Focus: <the focus words, or "none given">

## How to work here
- Check command: <command>. Merge target: <branch>. Worktrees: <convention>. Tracker: <document path>, <API host>.
- Tokens set: <names>. Panes that run now: <names, or none>.
- Model conventions: <workers, reviewers, coordinators, from the memories and the handoffs, with sources>
- User rules that bind: <each rule quoted, with its source>

## Done since <since> (verified)
- <fact>: evidence <merge hash, tag, or closed issue with its resolution comment>; <source>

## Active
- <named link>: <assignee or pane>, branch <name>, state <in work | in review | fix round>, last event <date>; <source>

## Next: the frontier
### <named link of the issue>
- Goal: <one line from the body>
- Done when: <the acceptance, from the body>
- Blockers: <closed blockers by name, or none>
- Prior findings: <research comments, requirements, review results, with sources>
- Files and areas: <paths the issue names or the findings touch>
- Labels: <`ready-for-agent` or `needs-approval`>
- Recommended pane: <harness, role, model, thinking, from the conventions>

## Recommended first action
- <the issue or work to take first and why; the first command or the first prompt>

## User gates and dated items
- <each item that waits on the user or on a date, with its source>

## Decisions that bind
- <recent decisions from the planning issues, the handoffs and the memories, one line each, with sources>

## Environment and blockers
- <each blocker with its cause, who can resolve it and its expected end>

## Sessions (last ten)
- <date> <harness> <role>: <what it did>, <outcome>, <decision or blocker recorded>

## Open questions (unverified)
- <each question you could not settle, with what you tried>

## Sources
- <each source read, with its URL, path or URI; each source that failed, with the reason>

## Suggested skills
- <the skills the coordinator should load for this round>
```

Rules for the bundle: each fact carries its source. Keep "reported" and "verified" apart: a closed issue does not prove a merge, a deployment or a passed test. Keep the user's own words from the handoffs or the sessions quoted, not paraphrased. Put unsettled questions under Open questions, never as facts. Include no credentials, raw transcripts or environment output.

Give the user the status in at most twenty lines: Done, Active and Next, the recommended first action, then the bundle path.

Durable copy, when `okknow` is present: follow its skill's write rules. Read `projects/<slug>/status`, then write the whole bundle there with `replace`. Include frontmatter `type: status`, `title` and `description`.

## 4. Start the coordinator pane

```sh
test "${HERDR_ENV:-}" = 1 || echo "not in Herdr"
```

Not in Herdr: report that the status and bundle are done, no coordinator started, and `go` was not sent. Keep this pane open and stop.

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Run `init.py` and keep your own name: it is the sender name of the bundle. Read the section "Coordinator handoff" of its `SPAWN.md`. Then:

```sh
python3 $S/spawn.py --harness <harness> --role coordinator --model <model> --thinking <thinking> --cwd "$PWD" --dry-run
python3 $S/spawn.py --harness <harness> --role coordinator --model <model> --thinking <thinking> --cwd "$PWD"
```

Leave out `--model` or `--thinking` when the argument is absent. Tell the user the resolved name, harness, model and thinking level in one line. The new pane appears below your pane. If the start fails or stops at a startup question, report the error or question to the user. Keep this pane open; do not send `go`.

## 5. Send the bundle and reach PLAN

Create the task file first with `install -m 600 /dev/null /tmp/get-status/<slug>-<time>-task.md`, then write into it. An overwrite keeps the mode. For a shell write, `umask 077` in the same command that writes the file is an alternative:

```markdown
Read the status bundle at <bundle path>. It covers <repository path> as of <UTC time>, sent by pane <sender name>. Assess it and choose the next round of work.

Reply before any work with one of these two forms:

- `MORE`, then numbered questions, when the bundle is not enough to choose the round.
- `PLAN`, then the work, the panes you start (harness, role, model, thinking), and each item that needs the user.

After it sends `go`, the sending session closes after up to 60 seconds, but only when delivery is confirmed. Put each question for it into your `MORE` reply. After `go`, gather the rest yourself from the bundle, the repository and the sources that the bundle names.

Wait for `go` after your PLAN reply. Then run the round under your coordinator role. Claim an issue before work when the tracker requires it. Use one pane per task and verify each result. Ask the user before a push, a deploy, a service restart, a secret change or data deletion. Report the round to the user in your own pane, or ask there when you need a decision.
```

Send it with one blocking call, with the timeout of your shell tool above `--timeout`:

```sh
python3 $S/ask.py <coordinator name> --file /tmp/get-status/<slug>-<time>-task.md --timeout 540
```

| Reply | What to do |
| --- | --- |
| `MORE` | Answer each question; gather more when needed. Send the answers with `ask.py` and ask for `PLAN`. After two `MORE` rounds, answer what you can and write "gather the rest yourself, then reply PLAN". |
| `PLAN` | Continue to section 6. Do not send `go` yet. |
| exit 124 | The pane still works. Run `herdr agent wait <pane-id> --timeout 540000`, then `last-reply.py`. This wait is for `PLAN`, not for the round. |
| exit 3, 4, 5, 6 | Follow the table in section A2 of the herdr skill. Report to the user and keep this pane open. |

Without `PLAN`, report to the user, keep this pane open and send no `go`. Never close the new coordinator pane.

## 6. Record the handoff, send go and close this pane

This command closes its own pane only after `go` is delivered, at the user's request. The rest of Herdr's "Coordinator handoff" section applies.

First, when `okknow` is present, append one line to `projects/<slug>/handoffs` with the write rules of its skill. Use summary `<harness>/<model> <project>: get-status handoff`:

```text
- <UTC time>: get-status handoff to <coordinator name> (<harness> <model>/<thinking>); bundle <path>; round: <one line from the PLAN>.
```

If this source fails, report one line under Sources and continue. Next tell the user: "Coordinator <name> is ready. If `go` is delivered, this pane closes after up to 60 seconds."

Send `go` with a short timeout. Set the timeout of your shell tool above 60 seconds:

```sh
python3 $S/ask.py <coordinator name> --text go --timeout 60
```

Use the exit code and the output together:

| Exit | What to do |
| --- | --- |
| 0 | Confirm delivery only when the output has a `--- reply ---` line followed by a reply. It must have no line that starts `note: reply was an API error` or `NO NEW REPLY in the transcript`. Otherwise keep this pane open and report the output. |
| 3 | Nothing was sent. Run `herdr agent wait <pane-id> --timeout 600000`, as section A2 of the herdr skill says. Use the pane ID from the output of `spawn.py` for `<pane-id>`. Set the timeout of your shell tool above 600 seconds for this wait. Then send `go` one more time with `ask.py`. Apply this table to that result, but do not retry again. |
| 4 | Keep this pane open and show the screen text to the user. Do not answer the question or approval yourself. |
| 5 | Keep this pane open and read the screen to find why no turn started. Report the output to the user. |
| 6 | Keep this pane open and read the coordinator's commit for its record, as section A2 says. Report the API error output to the user. |
| 124 | `go` is delivered. Do not wait for the round or run another wait. |
| Any other code | Keep this pane open and report the output to the user. |

After exit 4, 5, 6 or 124, never send `go` again. After an exit 0 that does not confirm delivery, never send `go` again. Retry exactly once, only after the first call returns exit 3.

When delivery is not confirmed, keep this pane open and report the output and the reason to the user. When `okknow` is present, append a second line to `projects/<slug>/handoffs` with its skill's write rules:

```text
- <UTC time>: go to <coordinator name> is not confirmed (ask.py exit <code>); the handoff is open. Read the coordinator pane before any new go.
```

If this write fails, report one line under Sources. Tell the user that this pane stays open because `go` delivery is not confirmed.

Only after confirmed delivery, close your own pane with the CLI as the last command. `close.py` refuses your own pane; its refusal names the direct CLI command for a user-requested close. Closing this pane ends the sending session; no other step is needed. Nothing follows the close:

```sh
herdr pane close "$HERDR_PANE_ID"
```
