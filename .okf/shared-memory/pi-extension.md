---
type: Package
title: The AgentCore Pi extension
description: packages/agentcore-pi connects Pi to the shared memory - recall before each typed prompt and the agentcore_propose tool with a confirmation dialog - and holds no AWS logic of its own.
tags: [agentcore, pi, extension, recall, propose]
resource: ../../packages/agentcore-pi/
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:10:00Z}
sources:
  - id: pi-readme
    resource: ../../packages/agentcore-pi/README.md
    title: The Pi extension README (packages/agentcore-pi/README.md)
  - id: memory-modules
    resource: ../../docs/memory-modules.md
    title: The section AgentCore Memory (docs/memory-modules.md)
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The section Recall in Pi (docs/shared-memory-security.md)
---
# The AgentCore Pi extension

The Pi extension is the kit component `agentcore`. It recalls shared records before each typed prompt and adds one tool that proposes a fact to a project. It holds no AWS logic: it calls the shared core in `packages/agentcore-memory-core`.

## Configuration

| Item | Value |
| --- | --- |
| Overlay field | `memory.agentcore.configFile`: the absolute path of the person config file. |
| Consents | `consent.memoryCapture` and `consent.remoteMemoryWrites`. |
| Launch | `AGENTCORE_MEMORY_CONFIG_FILE=<path>`, process-local; `env -u AGENTCORE_MEMORY_CONFIG` removes an inherited inline config. |
| Kill switch | `AGENTCORE_MEMORY_DISABLE=1`: the extension registers no hook and no tool. |
| Project override | `AGENTCORE_PROJECT`. A value outside the memberships gives recall without a project. |
| Credentials | The AWS profile that the person config names, else the default AWS SDK credential chain. |

The kit checks the form of the path and never opens the file. The registry script of the owner renders the file. It holds no key. The old prototype fields fail with `agentcore_legacy_fields`.

## Recall

- `before_agent_start` runs for a typed user prompt only. An empty prompt sends no query.
- The extension resolves the project of the working directory and asks the core for a recall.
- The result is one hidden custom message, `agentcore-memory-recall`, with `display: false`. The model reads it; the chat view does not show it.
- A failure logs one static line, and the turn continues.

## Propose

- The tool `agentcore_propose` takes `text` and an optional `projectId`.
- Without a project, the tool refuses with `project_none`.
- The confirmation dialog shows the target namespace as its title and the text as its message.
- Only the answer true lets the core write the record.
- Without a dialog, for example in `pi -p`, Pi answers false and nothing is written.
- The tool returns the record id and the namespace, or a static refusal code such as `not_member` or `not_confirmed`.

The extension has no capture path. It sends no answer, tool output or turn text. `session_shutdown` closes the core.

## Install and test

The extension has no dependency of its own. Install the dependencies of the core, then run the tests with a fake core:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
node --test packages/agentcore-pi/tests/
```

Not verified: a live recall or propose, and a start of a generated profile with this package.

## Links

- [The shared memory core](core.md), [the review flow](review-flow.md)
- [The memory modules](../modules/memory-modules.md)
- Source documents: [the memory modules](../../docs/memory-modules.md#agentcore-memory), [recall in Pi](../../docs/shared-memory-security.md#recall-in-pi)
