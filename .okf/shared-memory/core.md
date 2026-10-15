---
type: Package
title: The shared memory core
description: packages/agentcore-memory-core is the one library of the shared memory - config, namespace builder, project resolution, recall, propose, the review moves, the registry scopes and the review CLI - with no delete action.
tags: [agentcore, package, library, cli]
resource: ../../packages/agentcore-memory-core/
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T19:33:00Z}
sources:
  - id: core-readme
    resource: ../../packages/agentcore-memory-core/README.md
    title: The core package README (packages/agentcore-memory-core/README.md)
  - id: packages
    resource: ../../docs/packages.md
    title: The section AgentCore memory core (docs/packages.md)
---
# The shared memory core

The core is the one library of the shared memory. The Pi extension, the Claude Code plugin, the review CLI and the admin tool use it, so every harness and the IAM renderer keep the same rules. It is not a kit component: no manifest entry names it.

## The contract

The contract is `src/types.ts`; `src/index.mjs` implements it.

| Part | Functions | Rule |
| --- | --- | --- |
| Config | `loadConfig`, `validateConfig` | One file for every harness. It holds no key. |
| Ids | `validateId` | `[a-z0-9][a-z0-9-]{0,63}`, no wildcard. |
| Namespaces | `namespaces` | Every namespace comes from the builder. |
| Project | `resolveProject` | The environment variable, then the Git remote, then the directory. |
| Recall | `recall`, `formatContext` | One query per namespace of the recall set; one context block for both harnesses. |
| Propose | `propose` | One record into the person's proposals namespace, after the confirm callback. |
| Review | `listProposals`, `showProposal`, `approve`, `reject` | Maintainer actions. Show, approve and reject take the proposer and list its one exact proposals namespace. Approve and reject are moves. |
| Registry | `validateRegistry`, `personScope`, `submitScope`, `workerScope`, `renderPersonConfig` | The one place that decides the `read`, `write` and `move` patterns of an identity. No scope has a delete. |

## How it behaves

- The config comes from `AGENTCORE_MEMORY_CONFIG` (inline JSON), else from the file in `AGENTCORE_MEMORY_CONFIG_FILE`, else from `~/.config/agentcore-memory/config.json`.
- `AGENTCORE_MEMORY_DISABLE=1` is the kill switch. It comes first and gives no config.
- The SDK client has one attempt per call and a deadline that also covers credential resolution.
- The client has four methods: `retrieve`, `list`, `batchCreate` and `batchUpdate`. It has no delete method.
- A failed recall query logs one static line, `AgentCore Memory: recall failed (<code>); turn continues`.
- The context block holds one JSON line per record, so a record text cannot add a line of its own.

## The review CLI

`bin/agentcore-memory.mjs` gives the review actions on the terminal.

| Command | Does |
| --- | --- |
| `proposals list --project <id> [--actor <id>]` | One JSON line per proposal of the member `--actor`. Without `--actor` the live store returns no record. |
| `proposals show --project <id> --actor <id> --id <recordId>` | One proposal of the proposer `--actor`. |
| `proposals approve --project <id> --actor <id> --id <recordId>` | Shows the target, asks `y/N`, moves the record to the shared namespace. |
| `proposals reject --project <id> --actor <id> --id <recordId> --reason <text>` | Shows the target, asks `y/N`, moves the record to the rejected namespace. |
| `scope --registry <file> --person <actorId>` | Prints the scope and the person config. No AWS call. |

The live store reads the namespace of `ListMemoryRecords` as an exact match: a list on the proposals tree of a project returns no record. So `--actor` names the proposer, and the record id alone is not enough.

The CLI also has `resolve-project`, `recall` and `propose`. An error prints one line `agentcore-memory: <code>` and exits with 1.

## Dependency and tests

The package pins `@aws-sdk/client-bedrock-agentcore` `3.1152.0` with a lock file. The tests use fake clients and need no AWS credential and no network:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
node --test packages/agentcore-memory-core/tests/
```

Not verified: the core against a live store; show, approve and reject with `--actor` on the live store.

## Links

- [The namespaces](namespaces.md), [the review flow](review-flow.md)
- [The AgentCore Pi extension](pi-extension.md), [the AgentCore Claude Code plugin](claude-code-plugin.md)
- Source documents: [the core README](../../packages/agentcore-memory-core/README.md), [in-tree packages](../../docs/packages.md#agentcore-memory-core-packagesagentcore-memory-core)
