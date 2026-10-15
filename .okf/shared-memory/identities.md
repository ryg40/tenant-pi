---
type: Identity Model
title: The identities
description: Four identities use the store - a person user per person, a submit identity, a worker identity and the owner's admin login; no person and no maintainer holds a delete action or GetMemoryRecord.
tags: [agentcore, iam, identities, policy]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The identities and the policy rules (docs/shared-memory-security.md)
  - id: core-readme
    resource: ../../packages/agentcore-memory-core/README.md
    title: The registry part of the contract (packages/agentcore-memory-core/README.md)
---
# The identities

An identity is an AWS IAM user or session that calls the store. Each identity holds only the actions and the namespaces that its role needs. The registry of the owner is the one source of every person policy.

## The four identities

| Identity | IAM user | Holds | Used by |
| --- | --- | --- | --- |
| Person | `pi-memory-person-<actorId>`, one inline policy | Read of the own scope, propose, and for a maintainer the review moves | The agents of the person in Pi and Claude Code, and the review CLI |
| Submit identity | One fixed user named in the private registry | Write and move in `/shared/` and `/actor/*` | The owner, with the reviewed submit script only |
| Worker identity | One fixed user named in the private registry | Read of `/shared/*` and `/project/*/shared/*` | Agent workers of the owner, for read-only checks |
| Admin login | The account administrator session of the owner | IAM changes and every delete | The coordinator, after a dry run and the owner's word |

The owner is a person too. Alice has a person user for her agents, and her global writes use the separate submit identity. The reason is blast radius: the key of an agent turn holds no write right on a namespace that every person reads.

## The statements of a person policy

| Statement | Action | Condition on `bedrock-agentcore:namespace` |
| --- | --- | --- |
| `Read` | `RetrieveMemoryRecords`, `ListMemoryRecords` | `StringLike` with the read patterns of the person |
| `Write` | `BatchCreateMemoryRecords` | `ForAllValues:StringLike` with the person's proposals namespaces, plus a `Null` condition |
| `Move` | `BatchUpdateMemoryRecords` | Only for a maintainer: the proposals, shared and rejected trees of the project, plus a `Null` condition |

Example: Chen is a member of two projects and a maintainer of none. Chen reads `/shared/*`, `/actor/chen/*` and the shared and own proposals namespaces of both projects. Chen writes only `/project/example-project/proposals/chen/*` and `/project/example-site/proposals/chen/*`. Bruno, the maintainer of `example-site`, also reads the proposals and rejected trees of `example-site` and holds the `Move` statement for its three trees.

## The rules in short

- Every statement names one resource: the ARN of the one memory.
- Every `ForAllValues` condition has a `Null` companion, because `ForAllValues` returns true when the key is absent.
- No identity holds `GetMemoryRecord`. It has no namespace condition key, so it would read any record by id.
- No person and no maintainer holds `DeleteMemoryRecord` or `BatchDeleteMemoryRecords`. The delete actions have no namespace condition key.
- A person has one inline policy below the IAM limit of 2,048 characters. The renderer refuses a larger policy.
- The design uses the condition key `bedrock-agentcore:namespace` only, never `namespacePath`.

The security review numbers these rules R1 to R10 and gives the source of each.

Not verified: the read form with the single-valued `StringLike`, and the move under the namespace condition key. The live proof tests both. The named fallback for the move is a copy and a delete by a maintainer. That fallback is a contract change and needs the coordinator's word.

## Links

- [The namespaces](namespaces.md)
- [The AgentCore admin tool](admin-tool.md)
- [The shared memory security review](../security/shared-memory-review.md)
- Source document: [the policy rules](../../docs/shared-memory-security.md#the-policy-rules)
