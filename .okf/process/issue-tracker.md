---
type: Contract
title: The issue tracker contract
description: Issues live only in the Gitea development repository; an agent works them through the Gitea API with GITEA_TOKEN, applies only the labels of the table, and claims, resolves and links tickets by the wayfinding rules.
tags: [issue-tracker, gitea, labels, wayfinding]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: tracker
    resource: ../../docs/agents/issue-tracker.md
    title: Issue tracker - Gitea (docs/agents/issue-tracker.md)
  - id: agents
    resource: ../../AGENTS.md
    title: The agent instructions (AGENTS.md)
---
# The issue tracker contract

The issue tracker is the development repository on Gitea, the `origin` remote of a development checkout. Every skill that creates, reads or changes an issue follows this contract. A snapshot clone from GitHub has no issue tracker; an agent there reports that and opens nothing.

## Where issues live

| Place | Role |
| --- | --- |
| The development repository on Gitea | The only issue tracker. |
| The GitHub repository | A publish mirror. It has no issues. |
| `docs/wayfinder/issues/` in a private copy | Snapshots of old issues. Not a tracker. |

- Do not open an issue on GitHub. No `gh issue`, `gh pr` or `glab` command applies.
- Do not write a local ticket file.

## The token

The token is in `GITEA_TOKEN`, sent in the header `Authorization: token $GITEA_TOKEN`. Do not print it and do not write it into a file, an issue or a commit message. If it is not set, stop and report it; do not look for a token elsewhere.

## Labels

| Label | Meaning |
| --- | --- |
| `wayfinder:map` | The issue is a wayfinding map. |
| `wayfinder:parent:<map>` | The issue is a child of a map or of a spec issue. |
| `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` | The type of a ticket. |
| `ready-for-agent` | An agent can take the issue. |
| `needs-approval` | The owner approves before a worker starts. It wins over `ready-for-agent`. |

Do not apply a label outside the table. Do not put a size label on a new issue.

## Wayfinding

- A map is one issue; a child carries the label of its map, because Gitea has no sub-issues.
- Blocking relations are native Gitea dependencies, not prose.
- The frontier holds the open, unassigned children whose blockers are all closed, without `needs-approval`, and whose title does not start with `Spec:`.
- A claim is an assignment to the account of the token plus a claim comment. Do not claim an assigned issue.
- A resolution is a comment with the result and the evidence, then the close, then one line in the map body.
- Refer to an issue with a named link, never with a bare number.

## Publication safety

- List the existing maps, labels and issues before a create; do not create a duplicate.
- After an unclear network result, read the tracker before a second create.
- Do not overwrite an issue body that differs from the expected text.

## Links

- [The release checklist](release-checklist.md)
- Source documents: [the issue tracker document](../../docs/agents/issue-tracker.md), [AGENTS.md](../../AGENTS.md)
