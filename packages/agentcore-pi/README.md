# AgentCore Memory for Pi

This extension connects Pi to the shared Amazon Bedrock AgentCore Memory of several people.
It recalls records before each typed prompt. It adds one tool, `agentcore_propose`, that proposes a fact to a project after the person confirms.
OpenViking stays the primary memory. This package changes no local memory store.
The module is unmarked in the install checklist.

The extension holds no AWS logic. It calls the shared core in `../agentcore-memory-core`.
The core owns the config, the namespaces, the AWS client, the deadlines and the record metadata.
The design and its security review are in [the shared memory security document](../../docs/shared-memory-security.md).

## Install

Use Node `>=24.0.0 <25`, as the kit requires.
This package has no dependency of its own. Run the dependency step of the core from the kit root after approval:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
```

The generated profile loads `packages/agentcore-pi/index.ts` as a local-file package source.
`index.ts` imports `../agentcore-memory-core/src/index.mjs` by its relative path. Keep the kit directory in place.
`node_modules/` stays untracked and excluded from publication.

## Configuration

The private overlay supplies `memory.agentcore.configFile`: the absolute path of the person config file.
With [one memory for each stage](../../docs/memory-modules.md#one-memory-for-each-stage), it is the file of one stage.
Both `consent.memoryCapture` and `consent.remoteMemoryWrites` must be true.
The launch line passes the path in the process-local `AGENTCORE_MEMORY_CONFIG_FILE`.
It removes an inherited `AGENTCORE_MEMORY_CONFIG`, which the core would read before the file.
The kit never opens the file. The registry script of the owner renders it. It holds no key.

| Variable | Effect |
| --- | --- |
| `AGENTCORE_MEMORY_CONFIG_FILE` | The person config file. The launch line sets it. |
| `AGENTCORE_MEMORY_DISABLE=1` | The kill switch. The extension registers no hook and no tool. |
| `AGENTCORE_PROJECT` | Overrides the project of the working directory. A value outside the memberships gives recall without a project. A config without `remotes` and `directories` finds a project only through it: see [one memory for each stage](../../docs/memory-modules.md#one-memory-for-each-stage). |

Without a config, or with the kill switch, the extension registers nothing and prints one static line.
An invalid config also registers nothing and prints one static line without the value.

## Hooks and the tool

`before_agent_start` runs for a typed user prompt.
It resolves the project of the working directory of the Pi process, asks the core for a recall, and formats the result.
The result is one custom message of the type `agentcore-memory-recall` with `display: false`: the model reads it, and the chat view does not show it.
The core sends one retrieval per namespace of the recall set: `/shared/`, `/actor/<actorId>/` and, with a project, `/project/<projectId>/shared/`.
Custom-message starts and empty prompts send no query.
A failure of the resolution or of the recall logs one static line and lets the turn continue.
The core logs each failed namespace with its own static line.

`agentcore_propose` takes `text` and an optional `projectId`.
Without `projectId`, the tool resolves the project of the working directory. With no project, it refuses with `project_none`.
The core builds the preview and calls the confirmation gate before any write.
The gate calls `ctx.ui.confirm` with the target namespace as the title and the text as the message.
Only the answer `true` lets the core write one record into `/project/<projectId>/proposals/<actorId>/`.
Without a dialog, for example in `pi -p`, Pi answers `false` and nothing is written.
The origin metadata is `agent: "pi"`, `harness: "pi"` and the Pi session id.
The tool returns the record id and the namespace, or the static code of the refusal.

`session_shutdown` aborts a pending recall and closes the core. It waits at most one second for the close.

The extension has no capture hook. It sends no answer, tool output, thinking or turn text to AWS.

Warning: recall sends the user's prompt to AWS. A confirmed proposal sends its text to AWS.

## Offline checks

```sh
node --test packages/agentcore-pi/tests/
```

The tests use a fake core. They need neither installed AWS dependencies nor AWS credentials.
They cover the registration with and without a config, the recall message, the order of resolution and recall, the confirmation before any write, the refusal codes, the static log lines and shutdown.
A Node resolve hook gives `index.ts` the fake core, so the factory itself is under test.
One test loads `index.ts` with the real core in a separate process when `../agentcore-memory-core/src/index.mjs` exists.

See [the memory module guide](../../docs/memory-modules.md#agentcore-memory) for the owner steps.

Rounds 0 to 2 of the live proof verified the extension against the live store.
Recall added the hidden block in a real turn, and the model quoted its records (rounds 0 and 2).
`agentcore_propose` showed the confirmation dialog and wrote one record after the answer yes (round 1).
IAM denied each namespace outside the policy. In round 0 the extension logged one static `aws_denied` line for each such namespace, and the turn continued.
In round 0 a confirmed proposal outside the policy also ended with `aws_denied`, and nothing was written.
In round 1 a person key got `AccessDeniedException` on the private and the proposals namespaces of another person.
Without a project, propose ended with `project_none` and made no AWS call (round 0).

Not verified: clean-client installation, or a generated Pi session using this package. The live proof started Pi with its own launch values.
