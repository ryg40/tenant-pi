---
name: off-the-rails
description: Score the open issues and the recent deliveries of a project from 1 to 10 for the critical path to a working version in dev with the user in the loop, then say whether the current work is on the rails. Read-only; it changes no label, no assignee and no state. Use for /off-the-rails. Arguments are an optional window in days (`<n>d`) and an optional map or issue number.
argument-hint: "[<n>d] [map or issue number]"
disable-model-invocation: true
---

# off-the-rails

Find where the work stands, then judge whether it runs toward the deliverable or beside it. The standing goal of the owner, for every project: build, get a working prototype up and running in dev with a secure design from the start, and re-assess the hardening only after the first version works in a real environment. Everything here is measured against that goal.

Read-only: the skill reads the repository, the tracker and the session notes. It writes nothing to the tracker unless the user asks for the comment of [section 6](#6-the-comment-on-request).

Needs / Optional: the tracker document `docs/agents/issue-tracker.md` and its token are needed for the issue reads; without them, score the repository and the session notes only and say so under Sources. Herdr and `.local/` session notes are optional.

## 1. Arguments

`<n>d` is the window in days for the closed issues and the merges; absent, 14. A bare number is a map or an issue: a map scores its children, an issue scores its spec and siblings; absent, the whole open set. `/off-the-rails 7d` is a seven-day window; a number alone is never a window.

## 2. The goal and the deliverable

Read, in this order, and stop at the first clear statement of what a user gets when the project works: the `README.md` status and purpose lines, `GLOSSARY.md`, each open issue with the label `wayfinder:map` or a title that starts with `Spec:` (its Destination), the newest `.local/*/NOTES.md` goal lines, and the user's own words in the session. Write the deliverable in one line: who uses it, where it runs, what they see. When no source states it, ask the user one question for it and wait; do not guess. No user in the session: stop and return the question as the result.

Then state in one line whether a first version already runs in dev, and where. The rubric of section 4 turns on that line.

## 3. The position

Read, with the operations of the tracker document, all pages:

- The open issues, with labels, assignees and `updated_at`. The triage labels are in the tracker document, Labels.
- The issues closed inside the window (`closed_at`), with the last comment of each: it names the merge or says why it stopped.
- `git log --merges --since=<window>` on the integration branch (`git config kit.integration`, else `main`), and `git worktree list` with `git branch --no-merged` for the live branches.
- The active sessions: each `.local/*/NOTES.md` of the main checkout (the parent of `git rev-parse --git-common-dir`), newest first, with its goal, branch and pane lines. In Herdr (`HERDR_ENV` is `1`), `herdr pane list` gives the panes that run now; read only.

Group the rows by the label `wayfinder:parent:<map>`; name the map or spec of each claimed item and its frontier (tracker document, Frontier). Without the label, the rows are a flat list. Name each issue as [Refer by name](../wayfinder/SKILL.md#refer-by-name) says: its title in a named link.

## 4. The score

Score each open issue and each item delivered inside the window. An issue, its merge and its release tag are one row. One score, one sentence that says what the item does for "working in dev, user in the loop". A delivered item is scored by what it did, not by what it promised.

| Band | Meaning | Example |
| --- | --- | --- |
| 9-10 | The critical path. The item puts the working deliverable in front of the user in dev, or removes what stops that run. | The install that fails on a fresh client is fixed and a user gets a model reply. |
| 7-8 | On the path, one step back. It is needed before the next run, it is the secure design of the first version, or it is a defect that a user met. | A scoped credential for the dev service; a pin that the next install needs. |
| 4-6 | Useful but off the path. It improves a thing that already runs, or it prepares for a case that no user has met. | A second test suite for a module that works; a more elaborate backup strategy. |
| 2-3 | Hardening or polish before the first working version runs, and work on the agents' own process. | A retry matrix for a service nobody has used; a faster check script; a report form. |
| 1 | A supplemental deliverable. It is fine to have and changes nothing about the running version. | A nicer report format; an explainer page. |

Rules of the rubric:

- Secure design from the start is on the path: scoped keys, isolated data, a cost cap, owner approval for live actions. Hardening before the first working version is off the path. The two differ by the question "does the first user need it to run safely today?"
- After a first version runs: a defect or a hardening need that a user met scores as the item it blocks (7-10); a need nobody met scores 2-3.
- Inside a band, 10 is the single next step that gets the working deliverable in front of the user in dev; 9 is the rest of the band. In each lower band, the higher score goes to the item that the next run needs first.
- Work that lets the user interact with the running version scores higher than work of the same size that does not: real use improves the later planning.
- A blocker inherits the band of the item it blocks, when that item is on the path. A `needs-approval` item is scored as if approved, and the verdict says that it waits.
- A fix round or a review follow-up scores with its parent: on the path when the parent is, else one band lower. A release scores as the best item it ships. An open item that is already done scores 1 and says "close it".
- Work on the agents' own process (roles, check speed, report forms, session files) scores 2-3, unless it removes a stop on the run.
- A test earns a score by the risk it closes for the first user; a test of a case no user meets is 4-6 at most.

## 5. Output

One table, sorted by score, highest first, open and delivered items together. Show the 10 highest rows, the open rows of the bands 1-3, and one counted row for each other group (by parent map or spec, else by kind). Give a one-line reason for each shown row.

```markdown
| Score | Item | State | Why |
| --- | --- | --- | --- |
| 9 | [title](url) | open, claimed by <login> on <branch> | <one sentence> |
| 3 | [title](url) | merged <short hash> <date> | <one sentence> |
| 4-6 | 7 rows of [map title](url) | closed <date> to <date> | <one sentence for the group> |
```

`State` is one of: `open`, `open, claimed`, `open, waits on the owner` (a `needs-approval` label or an owner step named in the last comment), `merged <hash> <date>`, `closed <date>`, `closed, not merged`, `released <tag>`.

Then the verdict, three parts, each one to three sentences:

1. **On the rails?** Yes, partly or no, with the share of open work in the bands 7-10 and the share in 1-3.
2. **Stop or wait.** The open items of the bands 1-3 that are claimed or in a pane now, by name, and the reason each one can wait.
3. **The shortest path.** The ordered list of the items that get a running version in front of the user, with the first step the user can take today.

End with one line under Sources: the window, the issue count read, each source that failed.

Where `dummies` applies, end with the report of `../dummies/REPORT.md` after the verdict. Make no DUMMIES log entry for this read.

## 6. The comment, on request

Only when the user asks to record the result on the tracker: post one comment on the issue that the user names (the map, the spec, or the issue of the current round) with the comment operation of the tracker document. Its body is the table and the verdict, with the date and the window. Without a named issue, ask which one.
