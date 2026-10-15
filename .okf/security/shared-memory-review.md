---
type: Security Review
title: The shared memory security review
description: docs/shared-memory-security.md reviews each interaction of the shared AgentCore memory - why it is secure, what cannot happen and why it is maintainable - with rules R1 to R10, a threat table and the open items.
tags: [security, agentcore, review, threats, iam]
resource: ../../docs/shared-memory-security.md
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: Shared AgentCore memory - security review (docs/shared-memory-security.md)
---
# The shared memory security review

The security review is the authority for every rule of the shared memory. It is written for a human reader, with the four example people in every example. This page gives its structure, its main controls and its open items; it repeats no policy document.

## The structure of the review

| Section | Content |
| --- | --- |
| The namespace layout | The five trees and who reads, writes and moves each one. |
| The identities | The person user, the submit identity, the worker identity and the admin login. |
| The policy rules | Rules R1 to R10, each with its source, and the example policies of Chen and Bruno. |
| The interactions | Provisioning, key handoff, recall in Pi and in Claude Code, propose, approve, reject, purge, the global submit, project resolution, offboarding, worker reads and the migration. |
| Threat table | Each threat with its control and its residual risk. |
| Data that leaves the machine | Each flow, its data, its recipient and its time. |
| Limits, maintenance duties, sources, not verified | The open questions, who updates which section, and the AWS sources `S1` and onwards. |

Each interaction has the same parts: an example, the IAM rule, the namespace rule, why it is secure, what cannot happen, and why it is maintainable.

## The main controls

- A person writes only into the own proposals namespaces. A shared record exists only after a maintainer's move.
- Approve and reject are moves with a human confirmation and a ledger line before and after. Nothing is copied or deleted.
- No identity holds `GetMemoryRecord`, and no person or maintainer holds a delete action, because these actions have no namespace condition key.
- Every `ForAllValues` condition has a `Null` companion.
- The registry is the one source of every policy, and the apply step runs only after a dry run and the owner's word.
- A record is reference data in the context block, not an instruction. The review gate is the main control against a record that tries to steer agents.

## Selected residual risks

| Threat | Residual risk |
| --- | --- |
| A person's key is stolen | The thief reads the person's scope until the rotation. |
| A maintainer's key is stolen | Wrongly promoted or rejected records of one project, until someone moves them back. |
| A prompt carries a secret | The prompt text reaches AWS as a search query. |
| Rejected records accumulate | Rejected text stays in AWS until the purge. |

## Not verified

- The read form with the single-valued `StringLike`.
- The move under the namespace condition key, and the denial of a mixed batch.
- The prefix semantics of `ListMemoryRecords` on a proposals tree.
- Every live step of the design, until the live proof with a test person.

A wrong fact in the review goes to its maintainer; this bundle changes no sentence of it.

## Links

- [The shared memory in one page](../shared-memory/overview.md)
- [The identities](../shared-memory/identities.md), [the review flow](../shared-memory/review-flow.md)
- Source document: [the shared memory security review](../../docs/shared-memory-security.md)
