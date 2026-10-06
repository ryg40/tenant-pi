---
schema: tracker-brief/1
repo: owner/demo
repo_url: https://git.example.com/owner/demo
ref: demo@a1b2c3d
snapshot: 2030-01-23T06:30:00Z
evidence_checked: 2030-01-23T06:25:00Z
previous_snapshot: 2030-01-20T18:00:00Z
scope: Invented demo project: parser, storage and export work.
synthesis: model
---

# Demo restart brief

## Where things stand

```position
id: pos-demo
text: The parser and validation rules are merged on demo; the storage layer is the active build, split into an adapter and a conflict check.
milestone: Storage layer (#3)
status: verified
evidence:
  - ev-commit-a1b2c3d
  - ev-issue-3
```

Owner note: keep this brief short. Long history belongs in the issue tracker.

## What changed

```change
id: chg-parser
title: Parser merged
summary: The parser reads Markdown records and reports syntax errors with line numbers. It runs offline and does not change the source file.
status: verified
evidence:
  - ev-pr-1
  - ev-commit-b2c3d4e
```

```change
id: chg-validation
title: Validation rules cover record links
summary: Validation checks record links and rejects unknown fields. The command reports all errors before it writes a new output file.
status: verified
evidence:
  - ev-commit-c3d4e5f
  - ev-commit-a1b2c3d
```

```change
id: chg-export
title: Export requires a destination
summary: The export command writes a file only when a destination is configured. Other setups receive a clear message and keep the previous output.
status: verified
evidence:
  - ev-pr-2
```

## Still active

```active
id: act-storage
title: Build the storage layer
readiness: ready-offline
next: Merge the adapter and conflict-check branches, then run the joint tests and review the example output.
owner: coordinator
priority: 1
evidence:
  - ev-issue-3
  - ev-file-schema
```

```active
id: act-reconcile
title: Reconcile validation tasks #5 and #6
readiness: needs-decision
next: Compare demo history with the closed pull requests, then update both tasks.
blocker: Pull requests 7 and 8 closed without merge.
owner: owner
priority: 2
evidence:
  - ev-issue-6
  - ev-pr-7
  - ev-pr-8
  - ev-commit-d4e5f6a
```

```active
id: act-export
title: Export configuration
readiness: approval-gated
next: Import sample records from read-only files. Publication waits for approval.
blocker: The owner has not approved publication.
priority: 3
evidence:
  - ev-issue-4
```

## Issues and work items

```issue
id: 3
title: Storage adapters and conflict checks
state: open
progress: in-progress
url: https://git.example.com/owner/demo/issues/3
checked: 2030-01-23T06:25:00Z
workstream: storage
note: The adapter and conflict check build in separate branches.
```

```issue
id: 4
title: Export configuration format
state: open
progress: implemented
url: https://git.example.com/owner/demo/issues/4
checked: 2030-01-23T06:25:00Z
workstream: export
blockers:
  - Owner approval for publication
note: Offline export works. Sample imports and compatibility checks remain.
```

```issue
id: 2
title: Markdown parser
state: closed
progress: merged
url: https://git.example.com/owner/demo/issues/2
checked: 2030-01-23T06:25:00Z
workstream: validation
```

```issue
id: 6
title: Record link validation
state: open
progress: implemented
url: https://git.example.com/owner/demo/issues/6
checked: 2030-01-23T06:25:00Z
workstream: validation
note: Commits are on demo, but pull request 8 closed without merge.
```

```issue
id: 5
title: Required field validation
state: open
progress: implemented
url: https://git.example.com/owner/demo/issues/5
checked: 2030-01-23T06:25:00Z
workstream: validation
note: Pull request 7 closed without merge.
```

```issue
id: 7
title: Input size limits
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/7
checked: 2030-01-23T06:25:00Z
workstream: input
```

## Approval boundaries

```gate
id: gate-offline
kind: allowed
text: Offline code, tests and docs in this repository.
```

```gate
id: gate-publication
kind: approval
text: Publication needs owner approval, a backup and a rollback plan.
evidence:
  - ev-issue-4
```

```gate
id: gate-publish
kind: approval
text: Publishing the brief is opt-in. Tokens stay out of Markdown, HTML, logs and Git.
```

```gate
id: gate-no-launch
kind: forbidden
text: Do not start follow-up paths from this brief without a new owner request.
```

## Unknowns and conflicts

```unknown
id: unk-validation-merge
kind: conflict
severity: critical
text: Validation tasks #5 and #6 cite pull requests 7 and 8 that closed without merge. Demo has validation commits. Tracker state and delivery disagree.
evidence:
  - ev-issue-6
  - ev-pr-7
  - ev-pr-8
  - ev-commit-d4e5f6a
```

```unknown
id: unk-publication-path
kind: missing
severity: normal
text: The publication path for this brief is not chosen yet.
```

## Follow-up paths

```path
id: path-merge-storage
title: Merge and test the storage layer
role: recommended
readiness: ready-offline
issues:
  - 3
repo: owner/demo
cwd: ~/git/demo
revision: demo@a1b2c3d
objective: Merge the adapter and conflict-check branches and prove one save operation end to end.
prerequisites:
  - Both feature branches are committed.
read_first:
  - ev-issue-3
  - ev-file-schema
scope: The storage module, its command and their tests.
authority: Local branches and tests only. No push, publication or global install.
needs_approval:
  - Publishing the rendered brief
acceptance:
  - The tracker unit tests pass.
  - The example brief renders inside the word budget.
validate:
  - python3 -m unittest discover -s tracker/tests -t .
  - npm test
output: A merged local branch and a short test report.
next_action: Merge the adapter branch first, then the conflict-check branch, then run both test suites.
```

```path
id: path-reconcile
title: Reconcile validation delivery
role: alternative
readiness: needs-decision
issues:
  - 5
  - 6
  - #8
repo: owner/demo
objective: Decide whether validation landed by another route, then update the tasks.
read_first:
  - ev-issue-6
  - ev-pr-7
  - ev-pr-8
  - ev-commit-d4e5f6a
scope: Read-only audit of history, pull requests and issue claims.
authority: Issue comments need owner approval. No code changes.
acceptance:
  - Each validation task cites the commit that delivered it, or states what is missing.
output: An evidence-backed issue update proposal.
next_action: List validation commits on demo since the parser merge.
```

```path
id: path-export
title: Finish the offline export command
role: alternative
readiness: ready-offline
issues:
  - 4
repo: owner/demo
objective: Import sample records from read-only files and add parity tests.
read_first:
  - ev-issue-4
scope: Export code and tests. No publication.
authority: Offline work only.
acceptance:
  - Parity tests cover every generated setting.
output: A reviewed render and a list of unknown measurements.
next_action: Read the export README and the last handoff.
```

```path
id: path-input-limits
title: Add input size limits
role: backlog
readiness: optional
issues:
  - 7
repo: owner/demo
objective: Label an input set, add size limits and propose boundary tests.
scope: Offline fixtures and rules only.
authority: Offline tests only. Existing permission gates stay in place.
acceptance:
  - Fail-closed tests pass.
output: A rule set and an evaluation proposal.
next_action: Collect labeled examples of oversized inputs.
```

```handoff
id: handoff-path-merge-storage
path: path-merge-storage
source: generated
generated: 2030-01-23T06:30:00Z
basis: current
text: |
  You coordinate the next work session in the repository owner/demo.
  Start from this prompt. You have not seen the earlier session.
  Source: restart brief "Demo restart brief", recommended path path-merge-storage.

  Repository: owner/demo
  Repository URL: https://git.example.com/owner/demo
  Working directory: ~/git/demo
  Revision: demo@a1b2c3d

  Brief snapshot: 2030-01-23T06:30:00Z
  Evidence checked: 2030-01-23T06:25:00Z
  Confirm that the sources below are still current before you act.
  Code, issues and gates can change after the snapshot.

  Title: Merge and test the storage layer
  Readiness: ready-offline
  Objective: Merge the adapter and conflict-check branches and prove one save operation end to end.
  Scope: The storage module, its command and their tests.
  Next action: Merge the adapter branch first, then the conflict-check branch, then run both test suites.

  Read first:
  - Task 3, storage specification (issue): https://git.example.com/owner/demo/issues/3
  - Tracker brief schema (file, not a link): tracker/schema.md

  Related issues:
  - #3 Storage adapters and conflict checks (open, in-progress): https://git.example.com/owner/demo/issues/3

  Prerequisites:
  - Both feature branches are committed.

  Authority: Local branches and tests only. No push, publication or global install.
  Needs separate owner approval:
  - Publishing the rendered brief
  Approval gates in force:
  - Needs approval: Publication needs owner approval, a backup and a rollback plan.
  - Needs approval: Publishing the brief is opt-in. Tokens stay out of Markdown, HTML, logs and Git.
  - Forbidden: Do not start follow-up paths from this brief without a new owner request.

  Acceptance criteria:
  - The tracker unit tests pass.
  - The example brief renders inside the word budget.
  Validation commands:
  - python3 -m unittest discover -s tracker/tests -t .
  - npm test
  Expected output: A merged local branch and a short test report.

  This path is a proposal. It gives no permission to deploy, publish, change issues or pass an approval gate. When a step needs approval, stop and ask the owner.
```

## Evidence

```evidence
id: ev-issue-3
label: Task 3, storage specification
kind: issue
ref: https://git.example.com/owner/demo/issues/3
confidence: verified
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-pr-1
label: Pull request 1, parser
kind: pr
ref: https://git.example.com/owner/demo/pulls/1
confidence: verified
revision: e5f6a7b
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-commit-b2c3d4e
label: Parser commit
kind: commit
ref: b2c3d4e
confidence: verified
checked: 2030-01-23T06:25:00Z
note: Local commit hash on demo. There is no public commit page.
```

```evidence
id: ev-commit-c3d4e5f
label: Validation commit
kind: commit
ref: https://git.example.com/owner/demo/commit/c3d4e5f
confidence: verified
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-commit-a1b2c3d
label: Export check, current head of demo
kind: commit
ref: a1b2c3d
confidence: verified
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-pr-2
label: Pull request 2, export destination
kind: pr
ref: https://git.example.com/owner/demo/pulls/2
confidence: verified
revision: f6a7b8c
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-pr-7
label: Pull request 7, required field validation
kind: pr
ref: https://git.example.com/owner/demo/pulls/7
confidence: verified
checked: 2030-01-23T06:25:00Z
note: Closed without merge.
```

```evidence
id: ev-pr-8
label: Pull request 8, record link validation
kind: pr
ref: https://git.example.com/owner/demo/pulls/8
confidence: verified
checked: 2030-01-23T06:25:00Z
note: Closed without merge.
```

```evidence
id: ev-issue-6
label: Task 6, record link validation
kind: issue
ref: https://git.example.com/owner/demo/issues/6
confidence: reported
checked: 2030-01-23T06:25:00Z
note: The issue reports the implementation. The pull request did not merge.
```

```evidence
id: ev-commit-d4e5f6a
label: Validation commit on demo
kind: commit
ref: d4e5f6a
confidence: verified
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-issue-4
label: Task 4, export configuration
kind: issue
ref: https://git.example.com/owner/demo/issues/4
confidence: reported
checked: 2030-01-23T06:25:00Z
```

```evidence
id: ev-file-schema
label: Tracker brief schema
kind: file
ref: tracker/schema.md
confidence: verified
revision: feature/demo-storage
```
