---
type: Package
title: The AgentCore Claude Code plugin
description: packages/agentcore-claude is a Claude Code plugin with a UserPromptSubmit recall hook and a stdio MCP server whose write tools always ask for a permission prompt.
tags: [agentcore, claude-code, plugin, mcp, recall]
resource: ../../packages/agentcore-claude/
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:10:00Z}
sources:
  - id: plugin-readme
    resource: ../../packages/agentcore-claude/README.md
    title: The plugin README (packages/agentcore-claude/README.md)
  - id: packages
    resource: ../../docs/packages.md
    title: The section AgentCore memory Claude Code plugin (docs/packages.md)
---
# The AgentCore Claude Code plugin

The plugin brings the shared memory into Claude Code. A hook recalls records for each prompt, and an MCP server gives the agent the propose and review tools. Both import the core package, so the plugin holds no AWS logic. It is not a kit component.

## The parts

| Part | Content |
| --- | --- |
| Plugin name | `agentcore-memory` |
| Recall hook | `UserPromptSubmit` runs `scripts/recall.mjs`. |
| MCP server | `agentcore-memory`, over stdio. |
| Dependencies | `@modelcontextprotocol/server` `2.3.1` and `zod` `4.6.7`, pinned with a lock file. The core brings the AWS SDK. |
| Kill switch | `AGENTCORE_MEMORY_DISABLE=1`: the hook prints `{}`, each tool answers `disabled`. |

## The recall hook

The hook reads `prompt`, `session_id` and `cwd` from standard input and prints the context block as `additionalContext`. It prints `{}` and exits 0 when the kill switch is set, when no config exists, for an empty prompt, a slash command or a prompt of fewer than 3 characters, when no record matches, and on any error. It ends its recall after 12 seconds, before the hook timeout of 15 seconds.

Claude Code keeps the additional context of a hook in the session transcript on the local disk. A recalled record is therefore in a local file of Claude Code after the prompt.

## The MCP tools

| Tool | Does |
| --- | --- |
| `memory_propose` | Proposes `text` to a project of the person. |
| `memory_list_proposals` | Lists the proposals of a project. Maintainers only. |
| `memory_show_proposal` | Shows one proposal. Maintainers only. |
| `memory_approve` | Moves a proposal to the shared namespace. |
| `memory_reject` | Moves a proposal to the rejected namespace. A reason is required. |

A refusal is a tool error with one static code, for example `not_member` or `not_maintainer`. No answer and no log line holds an SDK message, a query or a record text.

## The confirmation

The three write tools carry the flag `anthropic/requiresUserInteraction`. With it, Claude Code shows the permission prompt on every call, and an allow rule does not skip it. The confirm callback of the server returns true only for the same action, project, text, record id and reason as the dialog. The plugin ships no permission allow entry; never add one.

Warning: a session that skips permission prompts loses this gate. That is the case for a Claude Code version before v2.1.214, for an MCP client that ignores the flag, and for an Agent SDK application that approves the call without a person.

## Install

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
npm --prefix packages/agentcore-claude ci --ignore-scripts
claude --plugin-dir packages/agentcore-claude
```

The plugin finds the core through a relative path, so it works only when Claude Code loads it in place. A copy in the plugin cache of Claude Code does not find the core.

Not verified: the plugin with the real core; the forced permission prompt in a live session; every live AWS call.

## Links

- [The shared memory core](core.md), [the review flow](review-flow.md)
- [The AgentCore Pi extension](pi-extension.md)
- Source document: [in-tree packages](../../docs/packages.md)
