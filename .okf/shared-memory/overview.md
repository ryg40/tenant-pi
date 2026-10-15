---
type: System Design
title: The shared memory in one page
description: Several people share one Amazon Bedrock AgentCore Memory resource; their agents recall and propose, maintainers review each proposal by a move, and only the owner's admin login deletes.
tags: [agentcore, shared-memory, design, overview]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The shared memory security review (docs/shared-memory-security.md)
  - id: core-readme
    resource: ../../packages/agentcore-memory-core/README.md
    title: The core package README (packages/agentcore-memory-core/README.md)
  - id: packages
    resource: ../../docs/packages.md
    title: In-tree packages (docs/packages.md)
---
# The shared memory in one page

The shared memory lets the agents of several people use one store of memory records. A record is a short text that an agent recalls as reference data. A person's agent can propose a record for a project, and a maintainer of that project decides whether the record becomes shared.

## The design

- The store is one Amazon Bedrock AgentCore Memory resource. It uses no memory strategy and no extraction: each record is stored as it is written.
- Each person has one IAM user, one access key and one inline policy.
- A person's agents read records and propose records. A proposal goes into a namespace of that person only.
- A maintainer reviews proposals. Approve moves a record into the shared namespace of the project. Reject moves it into a rejected namespace.
- No person and no maintainer deletes a record. Only the owner's admin login deletes.
- The owner writes the global namespace `/shared/` through a separate submit identity.

## The example people

The examples of the design use four fake people and two fake projects.

| Person | actorId | Role in the examples |
| --- | --- | --- |
| Alice Archer | `alice` | Owner of the store; writes the global `/shared/`; maintainer of `example-project` |
| Bruno Brook | `bruno` | Member of `example-project`; maintainer of `example-site` |
| Chen Cole | `chen` | Member of both `example-project` and `example-site` |
| Dana Dunn | `dana` | Member of `example-project`; the offboarding example |

## The interactions

| Interaction | In one sentence |
| --- | --- |
| Provisioning | The owner adds a person to the private registry; the admin tool renders the IAM user and policy in a dry run first. |
| Key handoff | The new key travels once, in a one-time link that expires, with a password told on a second channel. |
| Recall | Before a prompt, the core queries `/shared/`, the person's `/actor/` namespace and the shared namespace of the project. |
| Propose | After the person confirms, the core writes one record into the person's proposals namespace. |
| Approve, reject | A maintainer moves a proposal to the shared or the rejected namespace, with a ledger line before and after. |
| Purge | The owner's admin login deletes the rejected records of a project after a dry run. |
| Offboarding | The admin login deletes the person's private records, proposals, key, policy and user; approved records stay. |

## The packages

| Package | Role |
| --- | --- |
| `packages/agentcore-memory-core` | The core library and the review CLI. |
| `packages/agentcore-pi` | The Pi extension. |
| `packages/agentcore-claude` | The Claude Code plugin. |
| `packages/agentcore-memory-admin` | The owner's registry script. |

Not verified: every live step of the design. The offline tests use fake clients. A live proof with a test person checks each step before the design counts as working.

## Links

- [The namespaces](namespaces.md), [the identities](identities.md), [the review flow](review-flow.md)
- [The shared memory security review](../security/shared-memory-review.md)
- Source document: [the shared memory security review](../../docs/shared-memory-security.md)
