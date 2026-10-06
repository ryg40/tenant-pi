# Exploration history

Exploration history keeps questions, alternatives and changes of direction readable after a project changes course.
It is a set of hand-written, linked Markdown records in Git, not a task database or a service.
Start with one real pivot before adding a validator or a user interface.

## Record format

Each record is one Markdown file with short YAML front matter and a Markdown body.
Use a stable, unique `id`, a `type` and a `status` on every record.
Use lowercase type names: `experiment`, `artifact`, `evaluation`, `decision`, `pivot`.
Keep the id when the file moves. Use relative Markdown links between records.
Store compact fields in front matter. Put explanations and named evidence links in the body.

| Type | Minimum fields beyond id, type and status |
| --- | --- |
| Experiment | `parent` idea or specification, `question` |
| Artifact | `experiment` id, `location`, `revision` or hash, `model_or_role`, `run_reference` |
| Evaluation | `artifact` id, `evaluator`, `result`, `evidence` |
| Decision | `alternatives`, `selected_option`, `reason`, `approver`, `date`, `supersedes` when a previous decision exists |
| Pivot | `decision` id, `old_direction`, `new_direction`, `affected` specifications or tickets |

An id reference also needs a readable link in the body.
A location can be a repository path or an external URL.
Use a Git revision or content hash to distinguish an artifact from later changes at the same location.
Use ISO dates (`YYYY-MM-DD`). Use `unknown` when the date is not known.
The model or role and run reference preserve attribution when known.
An evaluator can be a person, a role or a named check. A result states what the evidence supports and its limits.

## States and authority

| Status | Meaning for this record |
| --- | --- |
| `proposed` | Draft for review or an exploration not yet endorsed. |
| `accepted` | Retained as the agreed record, within its stated evidence limits. |
| `parked` | Retained for possible later use. |
| `superseded` | Replaced by a linked successor, not deleted. |
| `abandoned` | No longer pursued; the record and reason remain. |

These states describe exploration records, not task progress or acceptance criteria.
Only the owner accepts a pivot. A model drafts it and cites the owner's approval; it does not grant approval.
A proposed decision uses `approver: unknown` until approval exists.
An accepted pivot must point to a decision with evidence of owner approval.

Write every missing fact as `unknown`. Never infer a missing approval, run id, hash or result.
Omit `supersedes` only when no previous decision exists; use `unknown` if that relationship is not known.
When replacing a record, keep it with `status: superseded` and a `successor` id plus a link to the new record.
The new record links back with `supersedes`. A changed direction does not erase an earlier result.

Link to the tracker issue and project page when known. Write `unknown` for an unavailable reference.
Do not copy their task status, checklists or acceptance criteria into a record.
Record historical approval evidence without claiming that current tasks are complete.
The tracker remains the source for task status and acceptance. Project pages remain the source for current project context.
Keep private trial records outside the published package. Publish only the neutral format when sharing the package.

## Read path

Start with a small index that links the experiment and its related records.
Read Experiment -> Artifact -> Evaluation -> Decision -> Pivot to reconstruct the evidence and choice.
For a later change, start at the Pivot, follow its Decision, then read the Evaluation and Artifact.
Follow successor links when a record is superseded. Consult linked tracker issues for current work.

## Neutral examples

Each fenced block below is the complete content of a separate sample file.
The files and external pages are illustrative, not supplied artifacts or live tracker records.
The examples form one chain. The decision and pivot stay proposed because owner approval is unknown.

### Experiment: `experiment-navigation.md`

```markdown
---
id: experiment-navigation
type: experiment
status: proposed
parent: navigation-spec
question: Can a compact index replace a nested menu?
---
# Compare navigation choices

Parent: [Navigation specification](https://example.invalid/specs/navigation).
Project: [Documentation project](https://example.invalid/projects/documentation).
Tracker: unknown.

Compare a compact index with a nested menu.
Read the [artifact](artifact-navigation.md) and [evaluation](evaluation-navigation.md).
```

### Artifact: `artifact-navigation.md`

```markdown
---
id: artifact-navigation
type: artifact
status: proposed
experiment: experiment-navigation
location: prototypes/compact-index.html
revision: unknown
model_or_role: designer
run_reference: unknown
---
# Compact index sketch

Experiment: [Compare navigation choices](experiment-navigation.md).
Artifact: [Compact index](prototypes/compact-index.html).
The revision and generating run are unknown. Do not treat this path as immutable evidence.
```

### Evaluation: `evaluation-navigation.md`

```markdown
---
id: evaluation-navigation
type: evaluation
status: proposed
artifact: artifact-navigation
evaluator: reviewer
result: unknown
evidence: unknown
---
# Navigation comparison

Artifact: [Compact index sketch](artifact-navigation.md).
No evaluation evidence is available. The comparison result remains unknown.
```

### Decision: `decision-navigation.md`

```markdown
---
id: decision-navigation
type: decision
status: proposed
alternatives: [nested-menu, compact-index]
selected_option: compact-index
reason: Try a single entry point before expanding the menu.
approver: unknown
date: unknown
supersedes: unknown
---
# Propose the compact index

Evaluation: [Navigation comparison](evaluation-navigation.md).
This is a draft choice, not an approved change. Comparative performance remains unknown.
The [pivot](pivot-navigation.md) needs owner approval.
```

### Pivot: `pivot-navigation.md`

```markdown
---
id: pivot-navigation
type: pivot
status: proposed
decision: decision-navigation
old_direction: Nested menu for each topic.
new_direction: One compact index for all topics.
affected: [navigation-spec]
---
# Proposed navigation pivot

Decision: [Propose the compact index](decision-navigation.md).
Affected specification: [Navigation specification](https://example.invalid/specs/navigation).
Affected tracker tickets: unknown.
Owner approval evidence: unknown. The model draft does not authorize the pivot.
```
