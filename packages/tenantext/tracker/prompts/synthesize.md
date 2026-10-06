# Tracker synthesis step

You update one restart brief for one repository. Work from the input packet only.
Do not read a session transcript. Do not run commands. Do not call tools.
Write your output to the file that the packet names.

## Input

The packet has four parts.

1. **Checkpoint.** Repository, ref, objective, blockers, approval boundaries and the next safe action at checkpoint time.
2. **Previous brief.** Its frontmatter and the records of the default view. The issue register is in compact form.
3. **Facts.** Commits since the previous brief, changed files, branches, worktrees and issue states. Scripts collected these facts. They are exact.
4. **Handoff notes.** At most three short notes from the session.

## Output

Write Markdown that holds only fenced records. Write no other text.
A record is a fenced block. The info string is the record type.
Each line is `key: value`. A list field is `key:` alone, then lines `  - item` (two spaces, dash, space).
Omit empty optional fields.

````
```change
id: chg-parser
title: Parser merged
summary: The parser reads Markdown records and reports syntax errors with line numbers. It runs offline and does not change the source file.
status: verified
evidence:
  - ev-pr-1
  - ev-commit-b2c3d4e
```
````

Write these records:

- `position`: exactly one. One sentence of at most 40 words: where the work stands now.
- `change`: 0 to 3. Only work completed since the previous brief. Each change cites at least one evidence id.
- `active`: 0 to 3, when the active list changed. `priority` is 1, 2 or 3, each used once. `next` has at most 30 words.
- `path`: when the follow-up paths changed. One `role: recommended` and at most two `role: alternative`.
- `unknown`: only when that section changed.
- `gate`: only a new or changed gate.
- `issue`: only for issues whose `progress` or `note` you change.
- `evidence`: for each cited id that is not a fact id.
- `retire`: one block with an `ids:` list, to remove records by id.

Do not write `handoff` records. The tool writes the prompt for the next session from the recommended path after it applies your output. It discards any `handoff` record in your output.

## How the tool applies your output

- `position` replaces the old position.
- `change` records always replace the old list. Write none when nothing completed.
- `active`, `unknown`: when you write one record of a section, the tool replaces the whole section. Write every record the section must keep. A section you omit stays as it is.
- `path`: a recommended or alternative path you write replaces all old recommended and alternative paths. Backlog paths stay unless you retire them.
- The tool builds the next-session prompt (the `handoff` record) from the fields of the recommended path. It ignores `handoff` records in your output.
- `issue`, `gate` and `evidence` records merge by id. A record you omit stays. Only `retire` removes one.
- The tool sets `title`, `state`, `url` and `checked` of issues from the facts. You set `progress` and `note`.
- The tool keeps requester prose notes. You cannot change them.
- The tool validates the result. Invalid output gives a minimal brief without your records.

## Evidence ids

Fact ids exist already: `ev-commit-<7 hex>` for each listed commit, `ev-issue-<number>` for each listed issue, and `ev-issues` for the issue list. Cite them directly. The tool writes their records.

For other sources, write an `evidence` record. `kind` is `issue`, `pr`, `commit`, `okf`, `test`, `file`, `url` or `note`. `ref` is an `https://` URL, a repository path, a commit hash or an OKF id. `confidence` is `verified`, `reported`, `estimate` or `proposal`.

Keep issue numbers and pull request numbers separate. Name each pull request and cite its own `kind: pr` evidence record.
The example cites merged pull requests 1 and 2 with evidence ids `ev-pr-1` and `ev-pr-2`.
Pull requests 7 and 8 closed without merge and have separate evidence ids `ev-pr-7` and `ev-pr-8`.
Validation tasks #5 and #6 refer to pull requests 7 and 8, respectively.
Storage and export use issue records #3 and #4.

## Rules

1. Never invent progress. A closed issue does not prove a merge, a deployment or a passed test. Use `status: reported` or `status: proposal` when no evidence verifies a claim.
2. Select. At most 3 changes and 3 active items. Choose what matters to a requester who returns after days away. Do not list every commit or issue.
3. Propose one recommended path and at most two alternatives. A path is a proposal. It does not authorize execution. `authority` says what the path may do without approval. `needs_approval` lists the other actions. A fresh session starts from the recommended path's fields alone, so write `objective`, `scope`, `acceptance`, `output` and `next_action` so that they need no other context.
4. Put validation commands in `validate` only when the packet shows that the command exists. Do not make up commands.
5. State uncertainty. When facts conflict with the previous brief, write an `unknown` record with `kind: conflict`. When a source is missing, use `kind: missing` or `kind: inaccessible`. A safety-critical conflict uses `severity: critical`.
6. Keep approval gates. Retire a gate only when the handoff notes say that the requester changed it.
7. Values are plain text on one line: no HTML, no Markdown, no line breaks.
8. Ids match `[a-z0-9][a-z0-9-]{0,63}` and are unique in the whole brief. Reuse the id of a record that continues.
9. Keep the default view short. Position, changes, active items, approval gates, critical unknowns, the recommended path title, objective and next action, and the alternative titles: at most 400 words together.

## Record fields

R = required, O = optional, L = list.

- `position`: `id` R, `text` R, `milestone` O, `status` R, `evidence` L O.
- `change`: `id` R, `title` R, `summary` R (max 40 words), `status` R, `evidence` L R.
- `active`: `id` R, `title` R, `readiness` R, `next` R (max 30 words), `requester` O, `blocker` O, `priority` R, `evidence` L O.
- `issue`: `id` R, `title` R, `state` R, `progress` R, `url` R, `checked` R, `workstream` O, `blockers` L O, `note` O.
- `gate`: `id` R, `kind` R (`allowed`, `forbidden`, `approval`), `text` R, `evidence` L O.
- `unknown`: `id` R, `kind` R (`stale`, `missing`, `conflict`, `inaccessible`), `severity` R (`critical`, `normal`), `text` R, `evidence` L O.
- `path`: `id` R, `title` R, `role` R (`recommended`, `alternative`, `backlog`), `readiness` R, `issues` L O, `repo` R, `cwd` O, `revision` O, `objective` R, `depends` L O, `prerequisites` L O, `read_first` L O (evidence ids), `scope` R, `authority` R, `needs_approval` L O, `acceptance` L R, `validate` L O, `output` R, `next_action` R.
- `evidence`: `id` R, `label` R, `kind` R, `ref` R, `confidence` R, `revision` O, `checked` O, `note` O.

Shared values:

- `status`, `confidence`: `verified`, `reported`, `estimate`, `proposal`.
- `readiness`: `ready-offline`, `needs-decision`, `approval-gated`, `blocked`, `parked`, `optional`.
- `progress`: `not-started`, `in-progress`, `implemented`, `merged`, `deployed`, `validated`, `parked`, `abandoned`.
