# tracker-brief/1

`tracker-brief/1` is the Markdown contract for a project restart brief.
One document summarizes one repository.
A person reads it to find where the work stands.
An agent reads it to propose the next bounded session.
The HTML page is a view of this document. It is not a second source of truth.

The parser reads a small, strict Markdown subset. It does not read general Markdown.
Tools: `tracker/brief.py` (parse, validate, dump), `tracker/render.py` (HTML),
`tracker/paths.py` (agent packets), `tracker/handoff.py` (the next-session prompt).
Standard library only.
A copyable example is in `tracker/examples/tracker-brief.md`.

## Document layout

1. Frontmatter: a `---` line, `key: value` lines, a `---` line.
2. One title line: `# Title`.
3. Eight sections with fixed `## ` headings, in fixed order.
4. Inside each section: fenced records and, optionally, owner notes.

Line endings are LF. The parser changes CRLF to LF.

## Frontmatter

The document starts with `---` on line 1.
Each line is `key: value`. Values are single-line text.
The parser removes one pair of matching surrounding quotes (`"` or `'`).
No nesting. Blank lines are ignored.

| Key | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | exactly `tracker-brief/1` |
| `repo` | yes | `owner/name` identity |
| `repo_url` | yes | HTTPS URL of the repository |
| `ref` | yes | branch and commit, for example `demo@a1b2c3d` |
| `snapshot` | yes | UTC ISO 8601 `YYYY-MM-DDTHH:MM:SSZ` |
| `evidence_checked` | yes | UTC ISO 8601, last evidence check |
| `previous_snapshot` | no | UTC ISO 8601 of the brief this one replaces |
| `scope` | yes | one line: what this brief covers |
| `synthesis` | yes | `model` or `minimal` (minimal = scripted facts only, no new inferred next step) |
| `stale_after_days` | no | integer, default 7 |

## Sections

Exactly these `## ` headings, in this order. Each heading appears once.

| Order | Heading | Record type | Count limits |
| --- | --- | --- | --- |
| 1 | `## Where things stand` | `position` | exactly 1 |
| 2 | `## What changed` | `change` | 0 to 3 |
| 3 | `## Still active` | `active` | 0 to 3 |
| 4 | `## Issues and work items` | `issue` | 0 or more |
| 5 | `## Approval boundaries` | `gate` | 1 or more |
| 6 | `## Unknowns and conflicts` | `unknown` | 0 or more |
| 7 | `## Follow-up paths` | `path`, `handoff` | at most 1 `role: recommended`, at most 2 `role: alternative`, any `role: backlog`; exactly 1 `handoff` when a path is recommended, else none |
| 8 | `## Evidence` | `evidence` | 0 or more |

A `# ` line is the title. Only one title is allowed, and it comes before the first section.
A `### ` line (or deeper) is not structure. It is part of an owner note.

## Record syntax

A record is a fenced block. The info string is the record type.
The type must match the section. `## Follow-up paths` holds `path` records and the `handoff` record.

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

- A scalar field is `key: value` on one line. The value is plain text.
  The renderer escapes it. It never reads it as HTML or Markdown.
- A list field is `key:` alone, then lines `  - item` (two spaces, dash, space).
- Omit an empty optional field. Do not leave it blank. An empty list is an error.
- Blank lines inside a record are ignored, except inside a block value.
- A block value is `key: |` alone, then the value lines, each indented by exactly two spaces.
  The value does not keep the two-space indent. Blank lines inside the block are kept.
  Leading and trailing blank lines and trailing spaces are dropped. The block runs to the
  closing fence: a non-empty line without the two-space indent is an error
  (`block-indent`), so put the block field last. The model value is one string with `\n` line breaks.
  In `tracker-brief/1` only `text` in a `handoff` record takes a block value (`block-field` otherwise).
  The dump always writes `handoff.text` as a block.
- The closing fence is a line with only three backticks.
- `id` values match `[a-z0-9][a-z0-9-]{0,63}`. They are unique across the whole document.
  Issue records can use the issue number as the id, for example `id: 3`.

## Record fields

R = required, O = optional, L = list.

| Type | Fields |
| --- | --- |
| `position` | `id` R, `text` R (one sentence, max 40 words), `milestone` O, `status` R, `evidence` L O |
| `change` | `id` R, `title` R, `summary` R (max 40 words), `status` R, `evidence` L R (at least 1) |
| `active` | `id` R, `title` R, `readiness` R, `next` R (max 30 words), `owner` O, `blocker` O, `priority` R (integer 1..3, unique in the section), `evidence` L O |
| `issue` | `id` R, `title` R, `state` R, `progress` R, `url` R (credential-free HTTPS), `checked` R (UTC ISO), `workstream` O, `blockers` L O, `note` O |
| `gate` | `id` R, `kind` R, `text` R, `evidence` L O |
| `unknown` | `id` R, `kind` R, `severity` R, `text` R, `evidence` L O |
| `path` | `id` R, `title` R, `role` R, `readiness` R, `issues` L O, `repo` R, `cwd` O, `revision` O, `objective` R, `depends` L O, `prerequisites` L O, `read_first` L O (evidence ids), `scope` R, `authority` R, `needs_approval` L O, `acceptance` L R, `validate` L O, `output` R, `next_action` R |
| `handoff` | `id` R, `path` R (id of the recommended path), `source` R, `generated` R (UTC ISO), `basis` R, `text` R (block value, max 450 words) |
| `evidence` | `id` R, `label` R, `kind` R, `ref` R, `confidence` R, `revision` O, `checked` O (UTC ISO), `note` O |

The dump writes fields in the order of this table. It writes the `handoff` record after the `path` records.

### Enums

| Field | Values |
| --- | --- |
| `status`, `confidence` | `verified`, `reported`, `estimate`, `proposal` |
| `readiness` | `ready-offline`, `needs-decision`, `approval-gated`, `blocked`, `parked`, `optional` |
| issue `state` | `open`, `closed` |
| issue `progress` | `not-started`, `in-progress`, `implemented`, `merged`, `deployed`, `validated`, `parked`, `abandoned` |
| gate `kind` | `allowed`, `forbidden`, `approval` |
| unknown `kind` | `stale`, `missing`, `conflict`, `inaccessible` |
| unknown `severity` | `critical`, `normal` |
| path `role` | `recommended`, `alternative`, `backlog` |
| evidence `kind` | `issue`, `pr`, `commit`, `okf`, `test`, `file`, `url`, `note` |
| `synthesis` | `model`, `minimal` |
| handoff `source` | `generated` (built by `tracker/handoff.py`), `owner` (written by the owner) |
| handoff `basis` | `current` (built from this brief), `carried-forward` (the path comes from an earlier brief and was not re-checked) |

Issue `state` is the tracker state. Issue `progress` is the delivery state.
Keep them separate. A closed issue does not prove a merge or a deployment.
Issue numbers and pull request numbers are separate. Name each pull request and cite its own evidence record.
The example cites merged pull requests 1 and 2 with evidence ids `ev-pr-1` and `ev-pr-2`.
Pull requests 7 and 8 closed without merge and have separate evidence ids `ev-pr-7` and `ev-pr-8`.
Validation tasks #5 and #6 refer to pull requests 7 and 8, respectively.
Storage and export use issue records #3 and #4.

### References

- Every id in an `evidence` list or a `read_first` list must be the id of an `evidence` record.
- Every item in a path `issues` list is an `issue` record id or `#<number>` text.
- `depends`, `prerequisites`, `needs_approval`, `acceptance` and `validate` items are free text.
  `validate` items are commands as text. No tool runs them.
- A `handoff` `path` is the id of the recommended path. With a recommended path the document
  holds exactly one `handoff` record. Without one it holds none.

### Links

- An `evidence` `ref` that starts with `https://` renders as a link.
  It must have a host and no user name, password, space, quote or backslash.
- Any other `ref` (repository path, commit hash, OpenKnowledge id) renders as labeled text.
  It never becomes a link.
- `http:`, `javascript:`, `data:`, `vbscript:`, `file:`, `ftp:`, `blob:`, `ws:`, `wss:`,
  protocol-relative `//host` refs and credential-bearing URLs are errors.
- `repo_url` and issue `url` must be credential-free `https://` URLs.

## Next-session prompt (`handoff` record)

The `handoff` record stores a copy/paste prompt for the next coordinator or orchestrator
session. It exists only for the recommended path. Alternative and backlog paths have none.

The backend pipeline writes it. `tracker/handoff.py` builds the text from the model, and the
refresh stores the record in the canonical Markdown with the rest of the brief.
The renderer, `tracker paths` and `tracker handoff` only read and show the stored record.
They never compose prompt text. The model synthesis step never writes a `handoff` record;
the refresh discards one when the model output holds it.

````
```handoff
id: handoff-path-merge-storage
path: path-merge-storage
source: generated
generated: 2030-01-23T06:30:00Z
basis: current
text: |
  You coordinate the next work session in the repository owner/demo.
  Start from this prompt. You have not seen the earlier session.

  Repository: owner/demo
  Revision: demo@a1b2c3d
  ...
  This path is a proposal. It gives no permission to deploy, publish, change issues or pass an approval gate. When a step needs approval, stop and ask the owner.
```
````

The full generated example is in `tracker/examples/tracker-brief.md`.

### Generated text

`tracker.handoff.build(model, basis="current")` is pure and deterministic. It reads no clock,
network, environment or configuration. `generated` is the brief's `snapshot`.
The plain text has short labeled parts, one fact per line:

1. With `basis: carried-forward`, a first line: the path comes from an earlier brief,
   was not re-checked, and must be confirmed against current sources first.
2. The session role, and the brief title and path id as the source.
3. Repository identity and URL, working directory (`cwd`, else a checkout of the repository),
   revision (`revision`, else the brief's `ref`).
4. The snapshot and evidence-check times, and a line that tells the agent to confirm that
   the sources are still current.
5. Title, readiness, objective, scope and next action.
6. Read-first evidence (label, kind and the HTTPS URL, or the ref labeled "not a link"),
   related issues (with state, progress and URL when an issue record exists),
   depends and prerequisites.
7. Authority, every `needs_approval` item, and the brief's `approval` and `forbidden` gates.
8. Acceptance criteria, validation commands and expected output.
9. A closing statement: the path is a proposal. It gives no permission to deploy, publish,
   change issues or pass an approval gate. Stop and ask the owner when a step needs approval.

The text stays within 450 words. For a very long path the generator shows fewer list items
("N more in the restart brief") and clips long values. It never clips commands or URLs.

### Refresh rules

`tracker.handoff.refresh(model, basis=...)` returns a copy of the model:

- An owner handoff (`source: owner`) that names the current recommended path is kept as it is.
- Any other handoff is replaced by `build(model, basis=...)`.
- Without a recommended path the copy has no handoff.

The refresh pipeline calls it for every candidate brief before validation:
`basis: current` for a model synthesis, `basis: carried-forward` for a `minimal` brief.

## Owner notes

Plain prose between records is an owner note.
A note is a run of non-blank lines outside a fence.
The renderer ignores notes. Writers must keep them byte for byte.
The model stores notes per section heading (heading text without `## `).
The dump writes each section's notes after its records, one blank line apart.
Text before the first section is an error. Put notes inside a section.

## Validation

`parse` checks syntax and raises `BriefError`.
`validate` checks meaning and returns diagnostics.
Each diagnostic has `level` (`error` or `warning`), `code`, `message` and `line` (1-based or `None`).
A hand-built model has no line numbers, so its diagnostics have `line=None`.

### Parser codes (errors)

| Code | Cause |
| --- | --- |
| `frontmatter` | no opening or closing `---`, or a line that is not `key: value` |
| `schema-unsupported` | `schema` is missing or is not `tracker-brief/1` |
| `title` | the `# Title` line is missing, repeated, empty or after a section |
| `heading-unknown` | a `## ` heading that is not in the section table |
| `heading-duplicate` | a section heading appears twice |
| `heading-order` | a section heading is out of order |
| `heading-missing` | a required section heading is missing |
| `outside-section` | a record or note before the first section |
| `record-type` | the fence type is empty or does not match the section |
| `record-syntax` | a record line is not `key: value`, `key:` or `  - item` |
| `fence-unclosed` | a record has no closing fence |
| `key-duplicate` | a key appears twice in the frontmatter or a record |
| `value-empty` | a key has no value and no list items |
| `value-int` | `priority` or `stale_after_days` is not a whole number |
| `count` | `## Where things stand` does not hold exactly one `position` record |
| `block-indent` | a non-empty line inside a `key: \|` block value lacks the two-space indent |
| `block-field` | a `key: \|` block value on a field other than `handoff.text` |

### Validator codes

| Code | Level | Cause |
| --- | --- | --- |
| `model-shape` | error | the model is not a dict or lacks a top-level key |
| `key-missing` | error | a required key is missing |
| `key-unknown` | error | a key is not in the schema |
| `value-type` | error | a list field holds one value, or a scalar field holds a list |
| `value-empty` | error | an empty value or an empty list |
| `value-format` | error | a value has a line break, a control character or surrounding spaces; `repo` is not `owner/name`; a block value starts or ends with blank space or has a line that ends with spaces |
| `value-int` | error | `priority` or `stale_after_days` is not a valid integer |
| `schema-unsupported` | error | `schema` is not `tracker-brief/1` |
| `id-format` | error | an id does not match the id pattern |
| `id-duplicate` | error | an id is used twice |
| `enum` | error | a value is not in its enum |
| `date-format` | error | a timestamp is not UTC `YYYY-MM-DDTHH:MM:SSZ` |
| `url-unsafe` | error | a link or ref breaks the link rules |
| `evidence-unresolved` | error | an `evidence` or `read_first` id has no evidence record |
| `issue-unresolved` | error | a path `issues` item is neither an issue id nor `#<number>` |
| `priority` | error | an `active` priority is outside 1..3 or used twice |
| `count` | error | a section breaks its count limit |
| `words` | error | a field is over its word limit |
| `handoff` | error | a recommended path has no `handoff`, there is more than one, its `path` does not name the recommended path, or a `handoff` exists without a recommended path |
| `budget` | warning or error | the default brief is over 400 words (warning) or 550 words (error) |
| `notes` | error | notes name an unknown section or hold a line that would not round-trip |
| `issue-state` | warning | a closed issue has progress `not-started` or `in-progress` |
| `time-order` | warning | `previous_snapshot` is not before `snapshot`, `evidence_checked` is after `snapshot`, or a time is after `--now` |
| `stale` | warning | with `--now` only: `snapshot` is older than `stale_after_days` |
| `stale-evidence` | warning | with `--now` only: `evidence_checked` is older than `stale_after_days` |

### Budgets

These budgets are initial values.

The default brief is the text a reader sees first. The budget counts these fields:

- `position`: `text`, `milestone`.
- every `change`: `title`, `summary`.
- every `active`: `title`, `next`, `owner`, `blocker`.
- every `gate` with `kind: approval`: `text`.
- every `unknown` with `severity: critical`: `text`.
- the `recommended` path: `title`, `objective`, `next_action`.
- every `alternative` path: `title`.

The `handoff` text does not count. It sits in a closed `<details>` element on the page.

A word is a run of characters between spaces.
Over 400 words is a warning. Over 550 words is an error. The target is 250 to 400 words.
Fixed page labels (headings, badges, dates) are not in the count.
The rendered page also shows the recommended path's `needs_approval` items without expansion.

### Staleness

Validation and rendering never read the clock.
`python3 -m tracker validate FILE --now 2030-01-30T00:00:00Z` reports stale timestamps as warnings.
The page prints the snapshot time and a static date after which it counts as stale
(`snapshot` + `stale_after_days`). It also prints notices from source fields only:
evidence checked long before the snapshot, and issue or evidence records checked long before the snapshot.

## Normalized model

`tracker.brief.parse(text)` returns:

```python
{
  "meta": {"schema": ..., "repo": ..., "repo_url": ..., "ref": ..., "snapshot": ...,
           "evidence_checked": ..., "previous_snapshot": ..., "scope": ...,
           "synthesis": ..., "stale_after_days": 7},
  "title": "...",
  "position": {...record...},
  "changes": [...], "active": [...], "issues": [...], "gates": [...],
  "unknowns": [...], "paths": [...], "handoffs": [...], "evidence": [...],
  "notes": {"<section heading>": ["<verbatim prose block>", ...]},
}
```

- Record dicts use the field names above. List fields are lists of strings.
  A block value is one string with `\n` line breaks.
- Missing optional fields are absent (not `None`). This includes `previous_snapshot`.
- `priority` and `stale_after_days` are integers. `stale_after_days` is always present.
- `notes` holds only sections that have notes. Keys are heading text without `## `.
- The dicts remember source lines for diagnostics. Equality ignores the lines,
  so a plain JSON copy of the model compares equal.
- `tracker.brief.dump(model)` writes canonical Markdown. For a valid model,
  `parse(dump(model)) == model`. The dump omits `stale_after_days` when it is 7.

## Path packets

`tracker.paths.extract(model)` returns one packet per path, in document order.
Extraction never runs anything. A packet holds every field of the path record, plus:

| Key | Content |
| --- | --- |
| `packet` | `tracker-path-packet/1` |
| `read_first_records` | the evidence records named in `read_first`, in order |
| `unresolved_read_first` | `read_first` ids without a record (empty for a valid brief) |
| `issue_records` | issue records for the `issues` items (`#3` resolves to issue `3`) |
| `unresolved_issues` | `issues` items without a record, kept as text |
| `brief` | `title`, `repo`, `repo_url`, `ref`, `snapshot`, `evidence_checked`, `synthesis` |
| `gates` | every gate record, each with its `evidence_records` |
| `execution` | a fixed note: the packet is a proposal and does not authorize execution |
| `handoff` | only in the recommended path's packet: the stored `handoff` record. Other packets have no `handoff` key |

`python3 -m tracker paths FILE --json` prints the packets as JSON.
The text form prints the recommended packet's prompt verbatim between
`----- begin prompt -----` and `----- end prompt -----` lines.

## Rendering

`tracker.render.render(model, template=None)` validates the model first.
It raises `BriefError` when the model has errors.
The same model and template give the same bytes.

Reading order:

1. Header: title, scope, repository, ref, snapshot, evidence check, previous snapshot,
   synthesis label, and notices. A `minimal` brief says that it holds scripted facts only.
2. Approval gates (`kind: approval`) and critical unknowns. Always visible.
3. Cards: Where things stand, What changed, Still active, Next session.
   Each factual item shows its conclusion first. A closed `<details>` element
   ("Evidence and details") holds its evidence records.
   Next session shows the recommended path, its stored prompt for the next session,
   then up to two alternatives as compact rows.
   The prompt block shows the `basis` and `source` labels, a visible
   "Copy prompt for the next session" button, a status line, and a closed
   `<details>` ("Show the prompt") with the escaped text in a wrapping `<pre>`.
4. Full records, each in a closed `<details>`: issue register with search and filters,
   all approval boundaries, all unknowns, backlog paths, full path packets, all evidence.

Visual states (`data-state`):

| State | Source |
| --- | --- |
| `completed` | every `change`; an issue with progress `deployed` or `validated`; a closed issue with progress `implemented` or `merged` |
| `active` | readiness `ready-offline`, `needs-decision` or `optional`; an open issue without blockers |
| `blocked` | readiness `blocked`; an open issue with `blockers` |
| `parked` | readiness `parked`; issue progress `parked` or `abandoned`; a closed issue with progress `not-started` or `in-progress` |
| `approval-gated` | readiness `approval-gated`; a gate with `kind: approval` |

### Templates

`python3 -m tracker render FILE OUT.html --template PATH` uses another template.
A template is an HTML file with exactly one `@@TITLE@@` marker and one `@@BODY@@` marker.
The renderer puts the escaped title at `@@TITLE@@` and the body markup at `@@BODY@@`.
User text never acts as a marker.
All interactive behavior (filters, reset, count, empty state, opening a closed target on
anchor navigation, the copy button) lives in the template `<script>`. A new template can replace it.

The copy button copies the text of the element that `data-copy-target` names.
It first copies synchronously inside the click handler, from a temporary off-screen
`<textarea>` with `document.execCommand("copy")`. That path works on the artifact service,
which sandboxes pages to a `null` origin where the async clipboard API is refused.
When it fails, the button tries `navigator.clipboard.writeText`. Either success shows "Copied".
When both fail, it opens the `<details>`, selects the prompt text and shows
"Press Ctrl+C or Cmd+C to copy". The script has no other effect.
The default template is `tracker/assets/template.html`. It has inline CSS and JS only.
It loads no external resource and uses no `fetch`, form or iframe.

## HTML hooks

The body uses only the names below. A template can style and script them.
Class names have the prefix `tb-`. Record elements have the id `rec-<record id>`.
Path packets have the id `packet-<path id>`.

### Element ids

| Id | Element |
| --- | --- |
| `tb-search` | issue search `<input type="search">` |
| `tb-filter-state` | tracker state `<select>`; option 0 is "all", then `open`, `closed` |
| `tb-filter-workstream` | workstream `<select>`; option 0 is "all", then sorted workstreams, then `""` for issues without one |
| `tb-reset` | reset `<button>` |
| `tb-count` | live count text, `N of M issues shown` (`aria-live="polite"`) |
| `tb-empty` | empty-state paragraph, `hidden` by default |
| `tb-attention` | approval gates and critical unknowns section |
| `tb-card-position`, `tb-card-changes`, `tb-card-active`, `tb-card-next` | the four cards (headings add `-h`) |
| `tb-more` | full records section |
| `tb-attention-h`, `tb-more-h` | section headings (targets of `aria-labelledby`) |
| `tb-handoff-text` | the `<pre>` with the stored next-session prompt; the copy button's `data-copy-target` |
| `tb-copy-status` | copy status text (`role="status"`, `aria-live="polite"`) |
| `tb-register`, `tb-gates`, `tb-unknowns`, `tb-backlog`, `tb-packets`, `tb-evidence-all` | the collapsed full-record `<details>` |

The script filters rows `tr.tb-issue` by `data-issue-state`, `data-workstream` and row text.

### Classes

| Class | Element |
| --- | --- |
| `tb-header`, `tb-eyebrow`, `tb-title`, `tb-scope` | header, its label, `<h1>`, scope line |
| `tb-meta`, `tb-meta-row` | header facts `<dl>` and each row |
| `tb-notice` | a header or card notice |
| `tb-nav` | links to the full records |
| `tb-attention`, `tb-attention-list` | always-visible gates and critical unknowns |
| `tb-cards`, `tb-card` | card container and each card `<section>` |
| `tb-item` | a position, change or active item |
| `tb-lead` | the position sentence |
| `tb-item-title`, `tb-item-text` | item heading and main text |
| `tb-items` | ordered list of change or active items |
| `tb-facts` | a row of state chips, badges and small facts |
| `tb-state` | visual state chip (with `data-state`) |
| `tb-badge` | enum badge (with `data-status`, `data-readiness`, `data-progress`, `data-issue-state` or `data-synthesis`) |
| `tb-key` | a bold field label ("Next:", "Blocker:") |
| `tb-label` | kind label in gate and unknown rows |
| `tb-text` | gate or unknown text |
| `tb-severity` | unknown severity word |
| `tb-milestone`, `tb-owner`, `tb-since` | position milestone, active owner, "since" line |
| `tb-blocker` | active item blocker line |
| `tb-path` | a path (recommended block, alternative row or backlog row) |
| `tb-alt`, `tb-alt-h`, `tb-alternatives` | alternative row, its heading and list |
| `tb-role` | path role line |
| `tb-path-title` | link from a path row to its packet |
| `tb-next-action`, `tb-needs-approval` | recommended path next action and approval list |
| `tb-issues-ref` | related issue text on a path |
| `tb-authority` | "a suggested path is a proposal" note |
| `tb-next-prompt` | the next-session prompt block under the recommended path (with `data-basis`, `data-source`) |
| `tb-handoff-meta`, `tb-handoff-generated` | prompt label line with the basis and source badges; its "As of" time |
| `tb-copy-row`, `tb-copy` | row of the copy button; the `<button type="button">` itself |
| `tb-copy-status` | copy status text |
| `tb-handoff` | the closed "Show the prompt" `<details>` |
| `tb-handoff-text` | the prompt `<pre>` (escaped, wrapping) |
| `tb-evidence` | the per-item "Evidence and details" `<details>` |
| `tb-ev-list`, `tb-ev` | evidence list and item |
| `tb-ev-link` | evidence label as an HTTPS link |
| `tb-ev-label`, `tb-ev-ref` | evidence label and labeled non-link ref (`<code>`) |
| `tb-ev-meta`, `tb-ev-note` | kind, confidence, revision, checked time; note |
| `tb-ev-none` | "No evidence recorded" text |
| `tb-fields`, `tb-field` | path packet `<dl>` and each field (with `data-field`) |
| `tb-more` | full records section |
| `tb-section` | each full-record `<details>` |
| `tb-register-note`, `tb-tools`, `tb-count`, `tb-empty` | register note, filter bar, count, empty state |
| `tb-table-wrap`, `tb-issues` | register table wrapper and `<table>` |
| `tb-issue` | register row `<tr>` |
| `tb-issue-id`, `tb-issue-work`, `tb-issue-state`, `tb-issue-progress`, `tb-issue-checked` | register cells |
| `tb-issue-title`, `tb-issue-note`, `tb-issue-blockers` | register cell parts |
| `tb-list`, `tb-group-h` | full-record lists and gate group headings |
| `tb-gate`, `tb-unknown` | gate and unknown items |
| `tb-packet` | full path packet `<article>` |
| `tb-empty-card` | empty text in a card or section |
| `tb-footer` | page footer |

### Data attributes

| Attribute | On | Values |
| --- | --- | --- |
| `data-card` | `.tb-card` | `position`, `changes`, `active`, `next` |
| `data-record` | items and paths | `position`, `change`, `active`, `path` |
| `data-state` | items, paths, packets, approval gates, issue rows, `.tb-state` | `completed`, `active`, `blocked`, `parked`, `approval-gated` |
| `data-status` | position, change, badges | `status` enum |
| `data-readiness` | active items, paths, badges | `readiness` enum |
| `data-priority` | active items | `1`, `2`, `3` |
| `data-role` | paths and packets | `recommended`, `alternative`, `backlog` |
| `data-issue-state` | issue rows and badges | `open`, `closed` |
| `data-progress` | issue rows and badges | `progress` enum |
| `data-workstream` | issue rows | workstream text or `""` |
| `data-kind` | gates, unknowns, evidence items, gate group headings | gate, unknown or evidence `kind` enum |
| `data-severity` | unknowns | `critical`, `normal` |
| `data-confidence` | evidence items | `confidence` enum |
| `data-stale` | evidence items | `true` when checked more than `stale_after_days` before the snapshot |
| `data-synthesis` | header and its badge | `model`, `minimal` |
| `data-notice` | `.tb-notice` | `freshness`, `minimal`, `minimal-paths`, `stale-evidence`, `stale-issues` |
| `data-meta` | `.tb-meta-row` | `repo`, `ref`, `snapshot`, `evidence-checked`, `previous-snapshot`, `synthesis` |
| `data-section` | `.tb-section` | `issues`, `gates`, `unknowns`, `backlog`, `packets`, `evidence` |
| `data-field` | `.tb-field` | a path field name |
| `data-basis` | `.tb-next-prompt` and its badge | `current`, `carried-forward` |
| `data-source` | `.tb-next-prompt` and its badge | `generated`, `owner` |
| `data-copy-target` | `.tb-copy` | id of the element whose text the button copies (`tb-handoff-text`) |

## Command line

```sh
python3 -m tracker validate FILE [--now 2030-01-30T00:00:00Z]
python3 -m tracker render FILE OUT.html [--template PATH]
python3 -m tracker paths FILE [--json]
python3 -m tracker handoff FILE
```

`handoff` prints only the stored prompt text of the recommended path, for piping into a
new session. It exits 1 with a message when the brief has no prompt.

Every command validates first. Diagnostics go to standard error as
`FILE:LINE: level [code] message`. Exit code 0 means success (warnings allowed),
1 means errors, 2 means a usage error. `render` writes to a temporary file and then
renames it, so a failed render keeps the old page.
