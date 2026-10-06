---
schema: tracker-brief/1
repo: owner/demo
repo_url: https://git.example.com/owner/demo
ref: main@@BASE@
snapshot: @SNAPSHOT@
evidence_checked: @SNAPSHOT@
scope: Demo repository: code, issues and follow-up work.
synthesis: model
---

# Demo restart brief

## Where things stand

```position
id: pos-main
text: The parser is merged on main; the storage layer is the active build.
milestone: Storage layer
status: verified
evidence:
  - ev-issue-3
```

Requester note: keep this brief short. Long history belongs in the issue tracker.

## What changed

```change
id: chg-parser
title: Parser merged
summary: The Markdown parser and validator are merged on main.
status: verified
evidence:
  - ev-issue-2
```

## Still active

```active
id: act-storage
title: Build the storage layer
readiness: ready-offline
next: Finish the conflict check, then run the offline tests.
requester: coordinator
priority: 1
evidence:
  - ev-issue-3
```

```active
id: act-publish
title: Decide the publication target
readiness: needs-decision
next: Ask the requester which artifact service to use.
blocker: The requester has not chosen a service.
priority: 2
```

## Issues and work items

```issue
id: 2
title: Parser and validator
state: closed
progress: merged
url: https://git.example.com/owner/demo/issues/2
checked: @SNAPSHOT@
```

```issue
id: 3
title: Storage layer
state: open
progress: in-progress
url: https://git.example.com/owner/demo/issues/3
checked: @SNAPSHOT@
workstream: storage
```

```issue
id: 4
title: Publication target
state: open
progress: not-started
url: https://git.example.com/owner/demo/issues/4
checked: @SNAPSHOT@
```

## Approval boundaries

```gate
id: gate-offline
kind: allowed
text: Offline code, tests and docs in this repository.
```

```gate
id: gate-deploy
kind: approval
text: Pushing, merging, deploying and publishing need requester approval.
```

Requester note: the requester reviews every publication.

## Unknowns and conflicts

```unknown
id: unk-publish-target
kind: missing
severity: normal
text: No publication target is chosen yet.
evidence:
  - ev-issue-4
```

## Follow-up paths

```path
id: path-storage
title: Finish the storage layer
role: recommended
readiness: ready-offline
issues:
  - 3
repo: owner/demo
cwd: ~/git/demo
objective: Complete the storage adapters and their conflict checks.
read_first:
  - ev-issue-3
scope: Storage code and its tests only.
authority: Edit code and run offline tests in this repository.
needs_approval:
  - Push or merge
acceptance:
  - Offline tests pass
output: A branch with the storage layer and tests.
next_action: Run the storage tests and fix the first failure.
```

```path
id: path-publish
title: Choose a publication target
role: alternative
readiness: needs-decision
issues:
  - 4
repo: owner/demo
objective: Record the requester's choice of artifact service.
scope: A decision note only.
authority: Draft the question for the requester.
acceptance:
  - The requester answers
output: A decision note.
next_action: Draft two options for the requester.
```

```path
id: path-docs
title: Tidy the docs
role: backlog
readiness: optional
repo: owner/demo
objective: Shorten the README.
scope: README only.
authority: Edit docs in this repository.
acceptance:
  - README under 200 lines
output: A shorter README.
next_action: List the README sections to cut.
```

```handoff
id: handoff-path-storage
path: path-storage
source: generated
generated: @SNAPSHOT@
basis: current
text: |
  You coordinate the next work session in the repository owner/demo.
  Start from this prompt. You have not seen the earlier session.
  Source: restart brief "Demo restart brief", recommended path path-storage.

  Repository: owner/demo
  Repository URL: https://git.example.com/owner/demo
  Working directory: ~/git/demo
  Revision: main@@BASE@ (the ref of the brief)

  Brief snapshot: @SNAPSHOT@
  Evidence checked: @SNAPSHOT@
  Confirm that the sources below are still current before you act.
  Code, issues and gates can change after the snapshot.

  Title: Finish the storage layer
  Readiness: ready-offline
  Objective: Complete the storage adapters and their conflict checks.
  Scope: Storage code and its tests only.
  Next action: Run the storage tests and fix the first failure.

  Read first:
  - Issue #3: Storage layer (issue): https://git.example.com/owner/demo/issues/3

  Related issues:
  - #3 Storage layer (open, in-progress): https://git.example.com/owner/demo/issues/3

  Authority: Edit code and run offline tests in this repository.
  Needs separate requester approval:
  - Push or merge
  Approval gates in force:
  - Needs approval: Pushing, merging, deploying and publishing need requester approval.

  Acceptance criteria:
  - Offline tests pass
  Expected output: A branch with the storage layer and tests.

  This path is a proposal. It gives no permission to deploy, publish, change issues or pass an approval gate. When a step needs approval, stop and ask the requester.
```

## Evidence

```evidence
id: ev-issue-2
label: Issue #2: Parser and validator
kind: issue
ref: https://git.example.com/owner/demo/issues/2
confidence: verified
checked: @SNAPSHOT@
```

```evidence
id: ev-issue-3
label: Issue #3: Storage layer
kind: issue
ref: https://git.example.com/owner/demo/issues/3
confidence: verified
checked: @SNAPSHOT@
```

```evidence
id: ev-issue-4
label: Issue #4: Publication target
kind: issue
ref: https://git.example.com/owner/demo/issues/4
confidence: verified
checked: @SNAPSHOT@
```

Requester note: evidence links point at the placeholder host.
