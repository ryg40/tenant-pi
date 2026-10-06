---
schema: tracker-brief/1
repo: owner/demo
repo_url: https://git.example.com/owner/demo
ref: main@0a1b2c3
snapshot: 2030-01-23T06:00:00Z
evidence_checked: 2030-01-23T06:00:00Z
scope: A synthetic work register with many issues and paths. It is test data.
synthesis: model
---

# Example work register

## Where things stand

```position
id: pos-main
text: 72 issues: 33 open, 39 closed. The register is the test load for the issue table.
status: reported
evidence:
  - ev-register-snapshot
```

Synthetic fixture: a large issue register with 72 issues and 18 paths.

## What changed

```change
id: chg-1
title: Export command merged
summary: The export command and its tests are merged on main.
status: reported
evidence:
  - ev-register-snapshot
```

```change
id: chg-2
title: Schema and README updated
summary: The schema and the README describe the new records. No deployment.
status: reported
evidence:
  - ev-register-snapshot
```

## Still active

```active
id: act-1
title: Parity tests and a validation procedure for the export command
readiness: ready-offline
next: Add the parity tests, then write the validation procedure.
priority: 1
evidence:
  - ev-register-snapshot
```

## Issues and work items

```issue
id: 1
title: Add the CSV export
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/1
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 2
title: Fix the settings menu
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/2
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 3
title: Document the footer layout
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/3
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 4
title: Test the search filter
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/4
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 5
title: Simplify the report page
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/5
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 6
title: Speed up the issue table
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/6
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 7
title: Validate the path packets
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/7
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 8
title: Review the date parser
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/8
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 9
title: Add the config loader
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/9
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 10
title: Fix the CSV export
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/10
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 11
title: Document the settings menu
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/11
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 12
title: Test the footer layout
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/12
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 13
title: Simplify the search filter
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/13
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 14
title: Speed up the report page
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/14
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 15
title: Validate the issue table
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/15
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 16
title: Review the path packets
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/16
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Closed in the tracker.
```

```issue
id: 17
title: Add the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/17
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Closed in the tracker.
```

```issue
id: 18
title: Fix the config loader
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/18
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Closed in the tracker.
```

```issue
id: 19
title: Document the CSV export
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/19
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Closed in the tracker.
```

```issue
id: 20
title: Test the settings menu
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/20
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Closed in the tracker.
```

```issue
id: 21
title: Simplify the footer layout
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/21
checked: 2030-01-22T00:00:00Z
workstream: interface
note: Open in the tracker. No work started.
```

```issue
id: 22
title: Speed up the search filter
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/22
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 23
title: Validate the report page
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/23
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 24
title: Review the issue table
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/24
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 25
title: Add the path packets
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/25
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 26
title: Fix the date parser
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/26
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 27
title: Document the config loader
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/27
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 28
title: Test the CSV export
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/28
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 29
title: Simplify the settings menu
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/29
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 30
title: Speed up the footer layout
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/30
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 31
title: Validate the search filter
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/31
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 32
title: Review the report page
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/32
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 33
title: Add the issue table
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/33
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 34
title: Fix the path packets
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/34
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 35
title: Document the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/35
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 36
title: Test the config loader
state: open
progress: parked
url: https://git.example.com/owner/demo/issues/36
checked: 2030-01-22T00:00:00Z
workstream: other
note: Parked. A decision is necessary first.
```

```issue
id: 37
title: Simplify the CSV export
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/37
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 38
title: Speed up the settings menu
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/38
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 39
title: Validate the footer layout
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/39
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 40
title: Review the search filter
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/40
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 41
title: Add the report page
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/41
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 42
title: Fix the issue table
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/42
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 43
title: Document the path packets
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/43
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 44
title: Test the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/44
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 45
title: Simplify the config loader
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/45
checked: 2030-01-22T00:00:00Z
workstream: other
note: Open in the tracker. No work started.
```

```issue
id: 46
title: Speed up the CSV export
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/46
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 47
title: Validate the settings menu
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/47
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 48
title: Review the footer layout
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/48
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 49
title: Add the search filter
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/49
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 50
title: Fix the report page
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/50
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 51
title: Document the issue table
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/51
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 52
title: Test the path packets
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/52
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 53
title: Simplify the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/53
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 54
title: Speed up the config loader
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/54
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 55
title: Validate the CSV export
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/55
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 56
title: Review the settings menu
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/56
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 57
title: Add the footer layout
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/57
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 58
title: Fix the search filter
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/58
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 59
title: Document the report page
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/59
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 60
title: Test the issue table
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/60
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 61
title: Simplify the path packets
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/61
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 62
title: Speed up the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/62
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 63
title: Validate the config loader
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/63
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 64
title: Review the CSV export
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/64
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 65
title: Add the settings menu
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/65
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 66
title: Fix the footer layout
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/66
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 67
title: Document the search filter
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/67
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 68
title: Test the report page
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/68
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 69
title: Simplify the issue table
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/69
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 70
title: Speed up the path packets
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/70
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 71
title: Validate the date parser
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/71
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

```issue
id: 72
title: Review the config loader
state: closed
progress: implemented
url: https://git.example.com/owner/demo/issues/72
checked: 2030-01-22T00:00:00Z
workstream: other
note: Closed in the tracker.
```

## Approval boundaries

```gate
id: gate-1
kind: approval
text: Publication needs user approval and a rollback plan. Offline tests do not authorize publication.
```

```gate
id: gate-2
kind: forbidden
text: Do not deploy from this brief.
```

## Unknowns and conflicts

```unknown
id: unk-1
kind: conflict
severity: critical
text: Two issues cite pull requests that closed without merge. The tracker state and the delivery disagree.
```

```unknown
id: unk-2
kind: missing
severity: normal
text: The page load on a slow connection is not measured.
```

## Follow-up paths

```path
id: path-01
title: Finish the export command
role: recommended
readiness: ready-offline
issues:
  - #15
repo: owner/demo
objective: Finish the export command. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-02
title: Reconcile the settings and the docs
role: alternative
readiness: ready-offline
issues:
  - #21
  - #14
  - #13
  - #12
  - #11
  - #10
repo: owner/demo
objective: Reconcile the settings and the docs. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-03
title: Measure the page load
role: alternative
readiness: approval-gated
issues:
  - #14
  - #13
  - #12
  - #11
  - #10
  - #9
repo: owner/demo
objective: Measure the page load. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Publication needs separate user approval.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-04
title: Review the search filter
role: backlog
readiness: ready-offline
issues:
  - #8
repo: owner/demo
objective: Review the search filter. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-05
title: Clean the date parser
role: backlog
readiness: approval-gated
issues:
  - #19
  - #7
repo: owner/demo
objective: Clean the date parser. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Publication needs separate user approval.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-06
title: Document the config loader
role: backlog
readiness: optional
issues:
  - #20
  - #6
repo: owner/demo
objective: Document the config loader. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-07
title: Test the issue table
role: backlog
readiness: optional
issues:
  - #5
  - #4
repo: owner/demo
objective: Test the issue table. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-08
title: Simplify the path packets
role: backlog
readiness: ready-offline
issues:
  - #18
  - #3
repo: owner/demo
objective: Simplify the path packets. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-09
title: Check the footer layout
role: backlog
readiness: blocked
issues:
  - #2
  - #1
  - #36
repo: owner/demo
objective: Check the footer layout. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: No work until the blocker is removed.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-10
title: Review the report page
role: backlog
readiness: ready-offline
issues:
  - #43
  - #42
  - #41
repo: owner/demo
objective: Review the report page. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-11
title: Add the import command
role: backlog
readiness: optional
issues:
  - #45
repo: owner/demo
objective: Add the import command. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-12
title: Check the error messages
role: backlog
readiness: ready-offline
issues:
  - #22
repo: owner/demo
objective: Check the error messages. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only. No push and no deployment.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-13
title: Review the test fixtures
role: backlog
readiness: optional
issues:
  - #33
  - #27
repo: owner/demo
objective: Review the test fixtures. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-14
title: Document the release steps
role: backlog
readiness: needs-decision
issues:
  - #34
  - #32
repo: owner/demo
objective: Document the release steps. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Read-only. The decision comes first.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-15
title: Check the accessibility
role: backlog
readiness: optional
issues:
  - #31
  - #28
repo: owner/demo
objective: Check the accessibility. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-16
title: Review the default settings
role: backlog
readiness: optional
issues:
  - #30
repo: owner/demo
objective: Review the default settings. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-17
title: Clean the old options
role: backlog
readiness: optional
issues:
  - #29
repo: owner/demo
objective: Clean the old options. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Offline work only.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```path
id: path-18
title: Plan the next release
role: backlog
readiness: needs-decision
issues:
  - #26
  - #40
  - #23
repo: owner/demo
objective: Plan the next release. Record each open question.
prerequisites:
  - Read the linked issues, the Git status and the last handoff first.
read_first:
  - ev-register-snapshot
scope: The files of the linked issues and their tests.
authority: Read-only. The decision comes first.
acceptance:
  - The tests pass and the open questions are listed.
output: A reviewed change and a list of open questions.
next_action: Read the linked issues, the Git status and the last handoff first.
```

```handoff
id: handoff-path-01
path: path-01
source: generated
generated: 2030-01-23T06:00:00Z
basis: current
text: |
  You coordinate the next work session in the repository owner/demo.
  Start from this prompt. You have not seen the earlier session.
  Source: restart brief "Example work register", recommended path path-01.

  Repository: owner/demo
  Repository URL: https://git.example.com/owner/demo
  Working directory: a checkout of owner/demo (the brief records no path)
  Revision: main@0a1b2c3 (the ref of the brief)

  Brief snapshot: 2030-01-23T06:00:00Z
  Evidence checked: 2030-01-23T06:00:00Z
  Confirm that the sources below are still current before you act.
  Code, issues and gates can change after the snapshot.

  Title: Finish the export command
  Readiness: ready-offline
  Objective: Finish the export command. Record each open question.
  Scope: The files of the linked issues and their tests.
  Next action: Read the linked issues, the Git status and the last handoff first.

  Read first:
  - Synthetic register (note, not a link): Invented records in this brief

  Related issues:
  - #15 Validate the issue table (open, not-started): https://git.example.com/owner/demo/issues/15

  Prerequisites:
  - Read the linked issues, the Git status and the last handoff first.

  Authority: Offline work only. No push and no deployment.
  Approval gates in force:
  - Needs approval: Publication needs user approval and a rollback plan. Offline tests do not authorize publication.
  - Forbidden: Do not deploy from this brief.

  Acceptance criteria:
  - The tests pass and the open questions are listed.
  Expected output: A reviewed change and a list of open questions.

  This path is a proposal. It gives no permission to deploy, publish, change issues or pass an approval gate. When a step needs approval, stop and ask the requester.
```

## Evidence

```evidence
id: ev-register-snapshot
label: Synthetic register
kind: note
ref: Invented records in this brief
confidence: reported
checked: 2030-01-23T06:00:00Z
note: Synthetic fixture.
```
