```position
id: pos-main
text: The storage layer is merged on main; publication is the next decision.
milestone: Publication
status: verified
evidence:
  - ev-commit-@HEAD@
```

```change
id: chg-storage
title: Storage layer merged
summary: The storage adapters and the conflict check are merged on main.
status: verified
evidence:
  - ev-commit-@HEAD@
  - ev-issue-3
```

```change
id: chg-tests
title: Offline tests cover conflicts
summary: The offline tests now cover the read-before-write conflict path.
status: reported
evidence:
  - ev-note-tests
```

```change
id: chg-issues
title: Issue tracker is current
summary: Issue states were checked against the tracker during this refresh.
status: verified
evidence:
  - ev-issues
```

```active
id: act-publish
title: Decide the publication target
readiness: needs-decision
next: Ask the owner which artifact service to use.
blocker: The owner has not chosen a service.
priority: 1
evidence:
  - ev-issue-4
```

```issue
id: 3
title: Storage layer
state: open
progress: merged
url: https://git.example.com/owner/demo/issues/3
checked: 2026-01-01T00:00:00Z
workstream: storage
note: Merged on main; the issue is still open.
```

```path
id: path-publish
title: Choose a publication target
role: recommended
readiness: needs-decision
issues:
  - 4
repo: owner/demo
objective: Record the owner's choice of artifact service.
read_first:
  - ev-issue-4
scope: A decision note only.
authority: Draft the question for the owner.
needs_approval:
  - Any publication
acceptance:
  - The owner answers
output: A decision note.
next_action: Draft two options for the owner.
```

```path
id: path-close-3
title: Close issue 3 after review
role: alternative
readiness: approval-gated
issues:
  - 3
repo: owner/demo
objective: Close the storage issue once the owner reviews the merge.
scope: Issue state only.
authority: Draft the closing comment.
needs_approval:
  - Closing the issue
acceptance:
  - The owner approves the close
output: A closing comment draft.
next_action: Draft the closing comment with the merge commit.
```

```evidence
id: ev-note-tests
label: Session note on the conflict tests
kind: note
ref: handoff note from the storage session
confidence: reported
```
