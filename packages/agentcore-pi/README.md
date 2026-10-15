# AgentCore Memory for Pi

This optional prototype recalls reviewed records from Amazon Bedrock AgentCore Memory.
OpenViking stays the primary memory. This package changes no local memory store.
Capture defaults to off. The module is unmarked in the install checklist.

## Install

Use Node `>=24.0.0 <25`, as the kit requires.
Run the dependency step from the kit root after approval:

```sh
npm --prefix packages/agentcore-pi ci --ignore-scripts
```

The generated profile loads `packages/agentcore-pi/index.ts` as a local-file package source.
Keep the kit directory in place.
`node_modules/` stays untracked and excluded from publication.

## Configuration

The private overlay supplies `memory.agentcore`.
Both `consent.memoryCapture` and `consent.remoteMemoryWrites` must be true, even for recall-only use.
The launch line passes the complete object as shell-quoted JSON in `AGENTCORE_MEMORY_CONFIG`.
This is the process-environment mechanism used for the OpenViking module.
No config file or key is copied into the package.

| Field | Meaning |
| --- | --- |
| `memoryId` | Required nonempty resource identifier. |
| `region` | Required AWS region, for example `us-east-1`. |
| `namespaces` | Required nonempty list of slash-delimited namespaces. `/owner/{actorId}/` and `/shared/` are supported together. |
| `topK` | Required in the overlay, integer 1 to 100. Direct extension configuration defaults to 10. |
| `capture` | Required boolean in the overlay. Keep `false`. Direct extension configuration defaults to false. |
| `actorId` | Optional actor identifier. Letters, digits, dots, underscores and hyphens are accepted. |
| `recallTimeoutMs` | Optional integer 1 to 600000. Default 3000 milliseconds per call. |

Without `AGENTCORE_MEMORY_CONFIG`, the extension registers nothing.
Invalid configuration disables it with one static log line.
A missing actor skips each namespace containing `{actorId}` and logs the reason.
The shared namespace still works.

## AWS client

The package pins `@aws-sdk/client-bedrock-agentcore` to `3.1152.0`.
The registry checks return:

```text
npm view @aws-sdk/client-bedrock-agentcore version
3.1152.0
npm view @aws-sdk/client-bedrock-agentcore-control version
3.1152.0
```

The data-plane client exists, so the extension needs no AWS CLI fallback.
It does not use or install the control-plane client.
The SDK uses its default credential chain, including environment credentials, `AWS_PROFILE`, and shared AWS files.
The launch line adds no credential. An existing `AWS_PROFILE` passes through unchanged.
The extension supplies only `region` and `maxAttempts: 1` to the SDK client.

## Hooks

`before_agent_start` queries each configured namespace once for a user prompt.
Each call sets `searchCriteria.topK` and `maxResults` to `topK`. It follows no pagination token.
Results form one custom context message with the heading `AgentCore Memory recall`.
Each JSON line identifies its record and namespaces. Records are reference data, not instructions.
Custom-message starts and empty prompts send no query.
A call failure logs one static line and lets the turn continue.
A deadline aborts the request and bounds local waiting, including credential resolution.
SDK retries are disabled. A timed-out operation may still finish remotely.

`turn_end` returns immediately when capture is off. It reads no event and creates no client.
The experimental on switch sends only assistant text through `CreateEvent`, with `extractionMode: SKIP`.
It sends no tool output, thinking, user prompt, or recall block.
It needs `actorId` and separate `CreateEvent` permission. It is not the reviewed-record submit path.
The same per-call deadline bounds capture. Capture has no replay queue.
`session_shutdown` aborts pending calls and destroys an initialized SDK client.

Warning: recall sends the user's prompt to AWS. Experimental capture sends assistant text, which can contain sensitive data.

## Offline checks

```sh
node --test packages/agentcore-pi/tests/
```

The tests use fake clients. They require neither installed AWS dependencies nor AWS credentials.
The suite checks two namespaces, context format, consent-related configuration, capture off, errors, deadlines, and shutdown.

See [the memory module guide](../../docs/memory-modules.md#agentcore-memory) for the owner setup and reviewed submit gate.

Not verified: live AWS recall, capture, IAM enforcement, clean-client installation, or a generated Pi session using this package.
