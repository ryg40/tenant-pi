---
type: Namespace Layout
title: The namespaces
description: Five namespace trees separate global, project, proposal, rejected and private records; recall never reads a proposals or a rejected namespace, and every namespace comes from the namespace builder of the core.
tags: [agentcore, namespaces, recall]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The namespace layout (docs/shared-memory-security.md)
  - id: core-readme
    resource: ../../packages/agentcore-memory-core/README.md
    title: The contract in short (packages/agentcore-memory-core/README.md)
---
# The namespaces

A namespace is a path that groups records in the store, for example `/project/example-site/shared/`. IAM policies allow or deny each request by its namespace, so the namespace layout is the access model of the shared memory. A record has exactly one namespace.

## The layout

| Namespace | Holds | Who reads | Who writes or moves in | Who moves out or deletes |
| --- | --- | --- | --- | --- |
| `/shared/` | Global records for every person | Every person, the worker identity | The owner, through the submit script | The owner, admin login |
| `/project/{projectId}/shared/` | Approved records of one project | The members, the worker identity | The maintainers, through approve | The owner, admin login |
| `/project/{projectId}/proposals/{actorId}/` | Proposals of one person for one project | The person, the maintainers | The person, through propose | The maintainers, through approve and reject |
| `/project/{projectId}/rejected/{actorId}/` | Rejected proposals | The maintainers | The maintainers, through reject | The owner, admin login (purge) |
| `/actor/{actorId}/` | Private records of one person | The person | The owner, through the submit script | The owner, admin login |

## Rules

- A namespace has a leading and a trailing slash. The trailing slash stops prefix collisions: `/project/example-site/` does not match `/project/example-site-2/`.
- Recall never reads a proposals namespace or a rejected namespace.
- Approve and reject move a record. They make no copy and delete nothing.
- Every namespace comes from the namespace builder of the core, never from a model string.

## The recall set

The recall set of a person holds `/shared/`, `/actor/{actorId}/` and, with a resolved project, `/project/{projectId}/shared/`. The core sends one query per namespace. Example: Chen in a checkout of `example-project` recalls from `/shared/`, `/actor/chen/` and `/project/example-project/shared/`.

## The id rule

A `projectId` or an `actorId` matches `[a-z0-9][a-z0-9-]{0,63}`. The characters `*`, `?`, `/`, `{`, `}` and `:` are not allowed. The reason: an IAM `StringLike` pattern treats `*` and `?` as wildcards, so an id with a wildcard would widen a policy.

## Project resolution

The core resolves the project of a working directory in this order:

1. The environment variable `AGENTCORE_PROJECT`.
2. The `origin` Git remote, compared with the remotes of the person config.
3. The configured directories; the longest match wins.

A resolved project must be a membership of the person config. With no match, recall uses `/shared/` and `/actor/{actorId}/` only, and propose is refused.

## Links

- [The identities](identities.md)
- [The review flow](review-flow.md)
- [The shared memory core](core.md)
- Source document: [the namespace layout](../../docs/shared-memory-security.md#the-namespace-layout)
