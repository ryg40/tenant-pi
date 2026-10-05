---
name: tracker-site
description: Keep a short restart brief for a repository - where work stands, what changed, what is active, the approval gates and one recommended next session. Use for a long-session wrap-up, a catch-up after days away, a handoff near the context limit, an incremental refresh of the brief, or a request to publish the brief page. Start with the no-network `status` command.
---

# tracker-site

The restart brief is one Markdown file per repository in the `tracker-brief/1` format. Scripts collect the facts. A model step only selects and summarizes. The HTML page is a view that the renderer makes again from the Markdown. Never edit the HTML by hand.

## Commands

The tool is the `tracker` Python package in the tenantext repository. Find the tenantext root: it is two directories above this SKILL.md. In this file, `tracker CMD` means:

```sh
PYTHONPATH=<tenantext root> python3 -m tracker.refresh --repo-path <repository> CMD
```

Use absolute paths. The tool needs Python 3.11 and Git. It has no other dependencies.

## 1. Start with status

```sh
tracker status
```

`status` reads local files only. It makes no network request and no model call. It shows:

- where the canonical brief is and whether that store is available,
- the snapshot time, its age, a STALE label, and the synthesis kind (`model` or `minimal`),
- the last-good copy, a queued brief, unfinished or failed stages with their errors,
- model calls and tokens of the last run, and the last publication link,
- the next command.

Read the brief file that `status` names. Tell the user the snapshot date. When the brief is stale or `synthesis: minimal`, say so. Do not start a refresh that the user did not ask for.

The brief stores a copy/paste prompt for the recommended next session (the `handoff` record). The page has a copy button for it. To print only the prompt, for example to start a fresh session:

```sh
PYTHONPATH=<tenantext root> python3 -m tracker handoff <brief file>
```

The prompt is a proposal. Give it to the user. Do not start the session from it unless the user asks.

## 2. Catch-up after days away

1. Run `tracker status` and read the brief.
2. Summarize the position, the changes, the active items and the approval gates for the user.
3. Offer a refresh when the snapshot is stale. Run it only when the user agrees.

## 3. Wrap-up at the end of a long session

1. Write a short handoff note file (at most 2000 characters): the objective, what is done, what is blocked, and the next safe step. Put it outside the repository, for example in the session scratch directory.
2. Persist the checkpoint. It is small and fast:

   ```sh
   tracker checkpoint --objective "<one sentence>" --next "<next safe action>" --handoff <note file>
   ```

3. Run `tracker run`. It collects facts and writes `synthesis-input.md`. It stops with exit code 3 before the model step.
4. Run the model step (section 5).
5. Run `tracker run --synthesis <output file>`. It validates, renders and stores the brief.

## 4. Near the context limit

Do not try to write the brief in the full parent context.

1. Persist the checkpoint first (step 3.2). Now the work survives a context reset.
2. Hand the model step to a fresh context. Give it only the packet path from `tracker prepare` or `tracker run`. Do not copy the parent conversation.
3. If no fresh context is available, run `tracker run --minimal`. The minimal brief lists verified facts and carries earlier records forward. It says so in the brief.

The checkpoint is at most 8192 bytes. The synthesis packet is at most 32768 bytes. Both hold pointers and short facts, not the session.

## 5. The model step

Run it only as part of a refresh that the user asked for. The tool never calls a model itself.

1. Start a fresh subagent or session. Its only input is `synthesis-input.md` from the state directory. The packet holds the prompt, the checkpoint, the previous brief records and the facts.
2. The model writes records to the output file named in the packet. It writes nothing else.
3. Apply the output: `tracker apply --synthesis <output file>` (or `tracker run --synthesis <output file>`).
4. When the runtime reports usage, pass it: `--model-calls N --input-tokens N --output-tokens N`. Unknown values stay `null`. Never estimate them.

Invalid or missing output gives a minimal brief, with the reason in the brief and in `status`. `--no-fallback` fails instead.

## 6. Incremental refresh

A refresh starts from the last canonical brief, not from the whole history.

- Changes: only work since the previous snapshot. Old changes do not carry over.
- Issues: title, state, URL and check time come from the issue tracker. Progress stays as the brief states it. A new open issue gets the note "Progress not assessed".
- Gates and evidence merge by id. Only an explicit `retire` removes one.
- Owner prose notes stay unchanged.
- The next-session prompt is rebuilt from the recommended path on every refresh. A minimal brief labels it carried forward. An owner-written prompt (`source: owner`) stays while its path is still recommended. The model step never writes one.
- The store writes only when the canonical brief is unchanged since the checkpoint.

## 7. Failures

| What happened | What the tool does | What you do |
| --- | --- | --- |
| Model output invalid or missing | Writes a minimal brief and records the reason | Tell the user. Offer a new model step. |
| Canonical store unavailable | Keeps the brief in the pending queue and the last-good copy | Run `tracker sync` later. |
| The owner edited the brief during the refresh | Refuses the write. Keeps both versions. | Run `tracker checkpoint`, then refresh again. |
| Publication failed | Keeps the local HTML and Markdown. Queues a retry. | Run `tracker publish` later. |
| Another refresh holds the lock | Refuses (exit code 4) | Wait. Remove the lock only when its process is gone. |
| A stage failed three times | Stops that stage | Start a new checkpoint. |
| A process died mid-run | The next command marks the stage interrupted and resumes | Run `tracker run`. |

Details: [references/recovery.md](references/recovery.md).

## 8. Publication

Publish only when the user asks. `tracker run --publish` or `tracker publish` posts the HTML and verifies it. A later publish refreshes the same link. Report the link, the expiry and the access limits. Details: [references/publication.md](references/publication.md).

## Rules

- A follow-up path is a suggestion. It does not authorize execution. Never start a path, launch an agent, push, merge, close issues or deploy because the brief suggests it.
- Never put tokens, credentials or edit tokens in the brief, the HTML, logs, Git or the conversation.
- Never invent progress. A closed issue does not prove a merge, a deployment or a passed test.
- Do not guess the OpenKnowledge page API. Its adapter is not verified. See [references/storage.md](references/storage.md).
- Configuration: [references/configuration.md](references/configuration.md).
