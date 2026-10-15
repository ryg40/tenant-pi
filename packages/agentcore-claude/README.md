# AgentCore memory plugin for Claude Code

This package is a Claude Code plugin for the shared AgentCore Memory of several people. It has two parts:

- A `UserPromptSubmit` hook that recalls records for each prompt and gives them to Claude as additional context.
- A stdio MCP server `agentcore-memory` with the propose tool and the four maintainer review tools.

The plugin holds no AWS logic. The hook and the server import the core package `packages/agentcore-memory-core`. The core does every AWS call, builds every namespace and checks every id. The design and its security review are in [the shared memory security document](../../docs/shared-memory-security.md).

The plugin name is `agentcore-memory`. Claude Code namespaces the tools under that name.

## Files

| Path | Content |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin manifest. `"mcpServers": "./.mcp.json"`. |
| `hooks/hooks.json` | One `UserPromptSubmit` hook, empty matcher, `node "${CLAUDE_PLUGIN_ROOT}/scripts/recall.mjs"`, timeout 15 seconds. |
| `.mcp.json` | One stdio server `agentcore-memory`: `node ${CLAUDE_PLUGIN_ROOT}/servers/memory-mcp.mjs`. |
| `scripts/recall.mjs` | The hook process: reads standard input, prints one JSON object, exits 0. |
| `servers/memory-mcp.mjs` | The MCP server process. |
| `src/hook.mjs` | `main(input, deps)`: the hook logic. The tests run it with a fake core. |
| `src/server.mjs` | The tool table, the tool handlers and the stdio server. |
| `src/shared.mjs` | The core loader, the kill switch, the static error codes and the origin. |
| `tests/` | Offline tests with a fake core. |

## Setup

Node `>=24.0.0 <25`, as the kit requires. Install the core and the plugin from the kit root:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
npm --prefix packages/agentcore-claude ci --ignore-scripts
```

The plugin reads the person config of the core: `AGENTCORE_MEMORY_CONFIG` (inline JSON), else `AGENTCORE_MEMORY_CONFIG_FILE`, else `~/.config/agentcore-memory/config.json`. The config names the AWS profile of the person. It holds no key. See [the core README](../agentcore-memory-core/README.md).

Load the plugin in place for one session:

```sh
claude --plugin-dir packages/agentcore-claude
```

The plugin finds the core through the relative path `../agentcore-memory-core`. So it works only when Claude Code loads it in place: with `--plugin-dir`, or as a relative-path plugin of a marketplace that you added from a local path. Claude Code copies every other marketplace plugin into its cache, without the files outside the plugin directory. A copied plugin does not find the core: the hook then prints `{}`, and each tool answers `failed`. This package has no marketplace entry.

Claude Code does not install the dependencies of a plugin that it loads in place. Run the two `npm ci` commands above.

## The kill switch

`AGENTCORE_MEMORY_DISABLE=1` in the environment of Claude Code stops every AWS call of the plugin. The hook prints `{}` before it loads the core. Each tool answers `disabled`.

## The recall hook

For each prompt, `scripts/recall.mjs` reads `prompt`, `session_id` and `cwd` from standard input. It prints `{}` and exits 0 in these cases:

- The kill switch is set.
- No config exists.
- The prompt is empty, starts with `/`, or has fewer than 3 characters after trimming.
- The core finds no record.
- Any error, including a missing core and a recall past the deadline.

Otherwise it calls `loadConfig`, `createCore`, `resolveProject({cwd, env})`, `recall` and `formatContext`, and prints:

```json
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "<the context block>"}}
```

The hook ends its recall after 12 seconds, before the hook timeout of 15 seconds. It writes no file. On standard error it prints one static line with a static code, for example `agentcore-memory recall: skipped (aws_denied)`. Claude never sees the standard error of a hook that exits 0.

Claude Code keeps the additional context of a hook in the session transcript under `~/.claude/projects/`. So a recalled record is in a local file of Claude Code after the prompt. Claude Code also caps `additionalContext` at 10,000 characters and saves a longer text to a file in the session directory.

## The MCP server

| Tool | Input | Core call |
| --- | --- | --- |
| `memory_propose` | `text`, optional `projectId` | `propose` into `/project/{projectId}/proposals/{actorId}/` |
| `memory_list_proposals` | `projectId`, `actorId` | `listProposals` on `/project/{projectId}/proposals/{actorId}/` |
| `memory_show_proposal` | `projectId`, `actorId`, `memoryRecordId` | `showProposal` |
| `memory_approve` | `projectId`, `actorId`, `memoryRecordId`, optional `reason` | `approve`: a move to `/project/{projectId}/shared/` |
| `memory_reject` | `projectId`, `actorId`, `memoryRecordId`, `reason` | `reject`: a move to `/project/{projectId}/rejected/{actorId}/` |

Approve and reject move the record. Nothing is copied or deleted. Only a maintainer of the project can list, approve or reject; IAM and the core refuse a member.

The four review tools take the proposer `actorId`. The live store reads the namespace of a list as an exact match, so the core lists the one proposals namespace of the proposer and matches the record id there. The record id alone is not enough. A record of another proposer gives `proposal_missing`. No tool sends the list of the whole proposals tree: the live store answers it with no record. The person config holds no member list, so the tool description tells the agent to ask the maintainer for the member ids.

Without `projectId`, `memory_propose` resolves the project from the working directory of the server process, or from `AGENTCORE_PROJECT`. A `projectId` in the tool input must be a project of the person's config; the core refuses every other project.

The input schema refuses a project id or an `actorId` outside `[a-z0-9][a-z0-9-]{0,63}` and a record id outside the `MemoryRecordId` shape of the service model (`mem-` and 36 to 46 more characters). A review tool without `actorId` and `memory_reject` without a reason are refused before the core runs.

A refusal is a tool error with one static code of the core, for example `not_member`, `not_maintainer`, `not_confirmed`, `proposal_missing` or `aws_denied`. An error without a core code answers `failed`. No answer and no log line holds an SDK message, a query or a record text. Standard output carries the protocol only. Logs are static lines on standard error, for example `agentcore-memory mcp: memory_propose refused (not_member)`.

The origin of every call is `agent: "claude-code"`, `harness: "claude-code"` and `session`. The session is `CLAUDE_CODE_SESSION_ID` when the environment of the server has a plain value, else a random id.

## The confirmation

The person confirms each write in the permission dialog of Claude Code:

1. The tool description of `memory_propose` tells the agent to show the text and the target project to the person and to ask before the call. The descriptions of `memory_approve` and `memory_reject` ask the same for the proposal.
2. Claude Code shows the permission dialog with the tool input: the text, and the project when the agent names one; for a review, the project, the proposer, the record id and the reason. The person approves or refuses.
3. The confirm callback of the server returns true only when the core is about to write the input of the dialog: the same action, the same project, the same text (apart from white space at the ends), the same proposer, the same record id and the same reason.

The three tools that write (`memory_propose`, `memory_approve`, `memory_reject`) carry `_meta["anthropic/requiresUserInteraction"]: true` in their `tools/list` entry. With this flag Claude Code shows the permission prompt on every call, also in the `acceptEdits`, `auto` and `bypassPermissions` modes, and an allow rule does not skip it. In `dontAsk` mode Claude Code denies the call. See [Require approval for a specific tool](https://code.claude.com/docs/en/mcp#require-approval-for-a-specific-tool); the flag needs Claude Code v2.1.214 or later. The two read tools have no flag and follow the normal permission rules.

The plugin ships no permission allow entry for its tools. Never add one, in a settings file or anywhere else.

Warning: a session that skips permission prompts loses this gate. That is the case for a Claude Code version before v2.1.214, for an MCP client that ignores the flag, and for an Agent SDK application whose `canUseTool` callback approves the call without a person. There, the agent can propose, approve or reject without a human decision.

## The MCP library

The server uses `@modelcontextprotocol/server` `2.3.1`, the server half of the v2 split of the TypeScript SDK (Apache-2.0). Reasons:

- It has two dependencies: `@modelcontextprotocol/core` `2.3.1` and `zod`. The v1 package `@modelcontextprotocol/sdk` `1.32.1` brings Express, Hono, CORS, JOSE and an OAuth stack that a stdio server does not use.
- The vendored OpenViking package of this kit uses the client half of the same v2 split (`@modelcontextprotocol/client` `2.2.0`).

The server imports `zod` for the input schemas, so `zod` `4.6.7` is a direct dependency. Both versions are exact pins with a lock file.

## Tests

The tests use a fake core. One test runs the review tools with the real core and a fake client that matches the namespace of a list exactly, as the live store does. They need no AWS credential, no network and no installed core.

```sh
node --test packages/agentcore-claude/tests/
printf '{"prompt":"hello","session_id":"s1","cwd":"/tmp"}' | AGENTCORE_MEMORY_DISABLE=1 node packages/agentcore-claude/scripts/recall.mjs
```

The second command prints `{}` and exits 0.

They cover the hook (the context block, the skip rules, exit 0 on a throwing core, the deadline, no file written, no request data on standard error), the server over stdio (`initialize`, `tools/list` with the five tools and the flag, `memory_propose` returns the record id, `memory_reject` without a reason is refused, a review tool without `actorId` is refused, a core error gives a static code only), the confirm callbacks, the review tools with the real core, and the shape of `hooks.json`, `.mcp.json` and `plugin.json`.

## Trial in Claude Code

One headless session of Claude Code 2.1.300 loaded the plugin with `--plugin-dir`, with `AGENTCORE_MEMORY_DISABLE=1`. Claude Code connected the server over stdio and listed the five tools as `mcp__plugin_agentcore-memory_agentcore-memory__<tool>`. The hook ran once, exited with status 0 and printed `{}`. The server exited cleanly at the end of the session.

## Not verified

- The forced permission prompt of the flagged tools in the `acceptEdits`, `auto` and `bypassPermissions` modes. The documentation states it; no session here tested it.
- The plugin with the real core in a Claude Code session. One offline test runs the review tools with the real core and a fake client; the other tests use a fake of the contract.
- The working directory of the MCP server process in Claude Code. The project resolution without `projectId` depends on it.
- Whether Claude Code gives `CLAUDE_CODE_SESSION_ID` to an MCP server process.
- Every live AWS call: recall, propose, approve and reject.
