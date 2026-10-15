---
type: Module Group
title: The memory modules
description: Four optional memory modules (hermes, wiki, openviking, agentcore) each need a selection, a capture consent and explicit choices; agentcore is the shared memory of several people on AWS.
tags: [memory, consent, hermes, wiki, openviking, agentcore]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:10:00Z}
sources:
  - id: memory-modules
    resource: ../../docs/memory-modules.md
    title: Memory templates with explicit activation consent (docs/memory-modules.md)
  - id: architecture
    resource: ../../docs/architecture.md
    title: The installed environment architecture (docs/architecture.md)
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: The shared memory security review (docs/shared-memory-security.md)
---
# The memory modules

A memory module gives the agent recall of earlier work. Four modules exist: `hermes`, `wiki`, `openviking` and `agentcore`. The kit enables none of them by default, and a module is active only after three explicit acts.

## The three acts

1. The overlay selects the module in `selection.enable`.
2. The overlay sets `consent.memoryCapture` to true.
3. The overlay gives the choices of the module in the `memory` block.

`openviking` and `agentcore` write to a remote store. They also need `consent.remoteMemoryWrites`. Consent alone activates nothing: `consent.memoryCapture` with no enabled module fails with `memory_disabled`.

The install flow marks `hermes` and `wiki` in its checklist and asks for the consent with one sentence. The user keeps or removes each mark.

## The four modules

| Module | Source | Where the text is stored | What leaves the machine |
| --- | --- | --- | --- |
| `hermes` | npm `pi-hermes-memory` | Below the profile directory, including a session index | Review calls go to the model of the memory role, when background review is on. |
| `wiki` | npm `@zosmaai/pi-llm-wiki` | The personal vault `~/.llm-wiki`, or a vault that `WIKI_HOME` names | Embeddings send text only with `consent.embeddingTextTransfer`. |
| `openviking` | `packages/openviking-pi`, a vendored copy | An OpenViking server | Captured turns and recall requests. It is the primary memory. |
| `agentcore` | `packages/agentcore-pi` on the shared core | One Amazon Bedrock AgentCore Memory resource | The prompt as a search query; the text of each confirmed proposal. |

## AgentCore as the shared memory

`agentcore` connects Pi to the shared memory of several people. It stays unmarked in the install checklist, and OpenViking stays the primary memory. The overlay holds one field, `memory.agentcore.configFile`: the absolute path of the person config file.

- The launch line passes the path in `AGENTCORE_MEMORY_CONFIG_FILE` and removes an inherited `AGENTCORE_MEMORY_CONFIG`.
- The kit checks the form of the path only. It never opens the file.
- The fields of the single-person prototype fail with `agentcore_legacy_fields`.
- Recall runs before each typed prompt. The tool `agentcore_propose` writes only after the person confirms.

## Facts for every module

- A configured credential name, an endpoint or a reachable service never enables capture.
- The model receives recalled memory as prompt context. Local storage does not mean that recalled text stays local.
- The offline stages of the kit make zero model calls and zero network writes. Not verified: the live capture behaviour of each module.

Warning: recall sends prompts to a remote store for `openviking` and `agentcore`. Keep sensitive material out unless the owner approves its transfer.

## Links

- [The shared memory in one page](../shared-memory/overview.md)
- [The AgentCore Pi extension](../shared-memory/pi-extension.md)
- [The credentials of the modules](../security/module-credentials.md)
- Source documents: [the memory modules](../../docs/memory-modules.md), [the shared memory security review](../../docs/shared-memory-security.md)
