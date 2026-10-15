---
type: Module Group
title: The workflow modules
description: The MCP module uses pi-mcp-adapter with definitions from a private input file; Promptr is unverified with a readiness matrix; the Herdr, coordinator and knowledge skills are optional components.
tags: [mcp, promptr, herdr, skills, workflow]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: workflow-modules
    resource: ../../docs/workflow-modules.md
    title: Workflow modules - MCP adapter and Promptr (docs/workflow-modules.md)
  - id: packages
    resource: ../../docs/packages.md
    title: The in-tree packages, section Kit components (docs/packages.md)
---
# The workflow modules

The workflow modules add tools and skills to a profile. The kit renders them offline: it opens no MCP server, starts no process and touches no keyring. The kit has no `pi-subagents` component; agent fan-out uses the Herdr skill.

## MCP

The `mcp` module uses the npm package `pi-mcp-adapter`, not the native MCP of Pi.

- The server definitions come from a private input file, `inputs/mcp-adapter.json`, in the local directory of the kit run.
- The kit validates every server definition before it plans. One refused field stops the whole plan.
- The profile gets `"extensions": ["-builtin:mcp"]`, which turns the native MCP off.
- The launch line starts with `PI_MCP_CONFIG_MODE=exclusive`.
- A header or an environment value can hold a `${NAME}` reference. The gap `env_reference_not_checked` says that the kit does not check the variable.

The adapter stores OAuth and bearer tokens in the keyring of the operating system. Every profile of the same user shares that keyring: the gap `credential_store_shared`.

## Promptr

`promptr` is an in-tree Pi extension: a prompt queue, progress checkpoints, staged handoffs and tracker views. It stays `unverified`. Every plan records its readiness matrix under `workflow.promptr`.

| Prerequisite | Status |
| --- | --- |
| `build_step_required` | Open. Run `npm ci --ignore-scripts` and `npm run build` in `packages/promptr` before the first start. |
| `host_module_dependency` | Open. The package pins a Pi host module under `dependencies`. |
| `private_renderer_adapters` | Open. The sidebar uses private renderer adapters of Pi. |
| `automatic_dispatch_path_unverified` | Open. Queue sends are manual. |

Not verified: a session with a model, a queue send, a handoff and the four skills in use.

## Skill components

| Component | Content |
| --- | --- |
| `herdr` | The Herdr skill. The Herdr application is a host tool that the kit does not install. |
| `herdr-relay` | An optional relay skill. It needs `herdr`. |
| `coordinator-skills` | Several coordinator skills, one filter entry each. The component README lists them. |
| `knowledge-skills` | Four MIT knowledge skills, one filter entry each. |

A generated profile loads a skill only when the overlay enables its component.

## Links

- [The in-tree packages](in-tree-packages.md)
- [The credentials of the modules](../security/module-credentials.md)
- Source document: [the workflow modules](../../docs/workflow-modules.md)
