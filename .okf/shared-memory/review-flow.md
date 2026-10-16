---
type: Workflow
title: The review flow
description: A person proposes a record after a confirmation, a maintainer approves or rejects it by a move with a ledger line before and after, and the owner's admin login purges the rejected namespace of each person after a dry run.
tags: [agentcore, propose, approve, reject, purge, ledger]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-16T00:45:00Z}
sources:
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The interactions (docs/shared-memory-security.md)
  - id: core-readme
    resource: ../../packages/agentcore-memory-core/README.md
    title: How the core works (packages/agentcore-memory-core/README.md)
---
# The review flow

The review flow is the only path from an agent to a shared record. A model cannot write a shared record: a person confirms each proposal, and a maintainer decides about it. The flow moves records and deletes nothing until the owner purges.

## 1. Propose

Example: Dana's agent finds a durable fact about `example-project`. Dana confirms the text and the target. The core writes one record into `/project/example-project/proposals/dana/`.

- The core writes only when the confirmation callback returns true.
- The record metadata holds `actorId`, `projectId`, `agent`, `harness`, `host`, `session` and `proposedAt`.
- The text has at most 16,000 characters, counted in Unicode code points. The core does not split a proposal.
- Propose is refused without a resolved project and when the person is not a member.
- A proposal is not visible in any recall.

## 2. Approve or reject

Example: Alice approves Dana's proposal. Bruno rejects a proposal of Chen in `example-site` with the reason "duplicate of an existing record".

| Step | Approve | Reject |
| --- | --- | --- |
| Target namespace | `/project/{projectId}/shared/` | `/project/{projectId}/rejected/{actorId}/` |
| Call | One `BatchUpdateMemoryRecords` of one record | The same call |
| Metadata added | `approvedBy`, `approvedAt` | `rejectedBy`, `rejectedAt` |
| Reason | Optional, in the ledger only | Required, in the ledger only |

- The move keeps the record id and the text. The request has no `content`.
- The core takes `actorId` and `projectId` from the proposal namespace, not from the metadata that the proposer wrote, and drops every other key.
- A wrong approve or reject is reversible: a maintainer or the owner moves the record back.
- Recall never reads the rejected namespace. Only the maintainers of the project list it.
- Show, approve and reject find the proposal through a list of the proposer's exact namespace. The list index lags one to five minutes behind a write, so right after a propose they give `proposal_missing`. Wait a few minutes and run the command again.

## The private ledger

Each move writes a journal line before the call and a second line after it. The ledger is a JSON Lines file with mode `0600`. The core refuses a ledger path in the Git work tree of the current directory or of the core package, except below the ignored `.local/` directory, so a commit does not take the ledger. When the first line fails, the core makes no call. The ledger holds the text before the move, so a wrong review is recoverable.

## The confirmation in each harness

| Harness | Confirmation |
| --- | --- |
| Pi | The extension shows the target namespace and the text in a dialog. Without a dialog, for example in print mode, the answer is no. |
| Claude Code | The permission dialog of the MCP tool shows the text and the target. |
| Review CLI | A `y/N` question on the terminal. Without a terminal the answer is no, and no flag skips the question. |

## 3. Purge

The owner purges the rejected records of a project with the admin tool. The dry run lists one exact rejected namespace for each person of the registry, `/project/{projectId}/rejected/{actorId}/`, and shows each record. A rejected record of an actor outside the registry needs `--person` with that actor. The coordinator runs the apply step with the admin login after the owner's word, and the records are deleted in batches of 100.

The live proof ran each step of this flow: propose in round 1, show and approve in round 2, reject in round 3, and the purge of one person's rejected namespace in round 4. Not verified: the purge of a whole project with rejected records of several people.

## Links

- [The namespaces](namespaces.md), [the identities](identities.md)
- [The shared memory core](core.md), [the AgentCore admin tool](admin-tool.md)
- Source document: [the interactions](../../docs/shared-memory-security.md#the-interactions)
