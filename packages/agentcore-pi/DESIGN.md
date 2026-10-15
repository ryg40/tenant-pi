# AgentCore Memory for Pi: design

## Boundaries

`index.ts` is the Pi factory. It imports `loadConfig` and `createCore` from `../agentcore-memory-core/src/index.mjs` and hands them to `runtime.mjs`.
`runtime.mjs` maps two Pi events and one Pi tool onto the core. It builds no namespace and sends no AWS request of its own.
The core is injectable. Tests replace it without a socket, a credential or an SDK installation.
No factory-time process, timer, credential read, or network request is needed. The core creates its client on the first call.
The runtime owns no memory files and replaces no OpenViking or LLM Wiki hook.

The pure Python module renders `AGENTCORE_MEMORY_CONFIG_FILE` on the launch line and removes an inherited `AGENTCORE_MEMORY_CONFIG`.
It does not read the config file, environment values, credential files, or AWS state.
Old overlays without `agentcore` remain valid and keep it off. Old overlays with the prototype fields fail with one static rule.

## Recall

Each user-started run resolves the project once and asks the core for one recall.
The resolution uses `process.cwd()` and `process.env`, as the core contract describes.
The core sends one request per namespace of the recall set and reports a failed namespace in `failed`.
The extension turns the result into one custom message with `display: false`. The core writes the heading and the JSON lines.
A thrown resolution, recall or format logs one static line. The turn continues.
The recall signal follows the turn signal and the shutdown signal.
A refused `AGENTCORE_PROJECT` logs one static line once per session.

## Propose

The tool resolves the project when the model gives no `projectId`.
The core calls the confirmation gate with the preview. The gate answers `true` only when the preview is a proposal and `ctx.ui.confirm` returned `true`.
Any other answer, a throw, or a missing dialog stops the write.
A refusal returns the static code of the core. An unknown error becomes `aws_failed`; its text is never returned.
The tool runs sequentially, so two confirmation dialogs never overlap.

## Shutdown

`session_shutdown` marks the extension closed, aborts a pending recall and calls `core.close()`.
It waits at most one second, so a pending credential load cannot hold the exit.
After shutdown, recall sends nothing and the tool refuses with `disabled`.

## Removed

The prototype capture path (`turn_end`, `CreateEvent`) is removed. The extension has no `turn_end` hook.
The package has no AWS SDK dependency. The core pins it.

## Submit path

`scripts/memory_submit.py` is independent of Pi and uses the Python standard library.
The owner reviews the candidate file before `--send`.
The script validates all records before writing request files or starting the AWS CLI.
Paragraph splitting refuses an oversized single paragraph rather than cutting text without a review boundary.
The source URI and part number identify a record. Changing text alone does not change that identity.

A private ledger binds record identifiers to one memory resource and region.
Create requests use stable per-record identifiers and a batch `clientToken`.
The ledger journals the exact pending batches before sending, including their required timestamps.
An uncertain result is retried with the same payload and token, not a new timestamp.
This matters because `requestIdentifier` correlates records; it is not a documented batch idempotency token.
Update requests use stored record IDs and `sourceNamespaces`; that API has no `requestIdentifier` field.
Successful results are matched by identity, not response order.
Partial failures preserve successful IDs and return a failure status.

Ledger writes use private files and atomic replacement. An exclusive lock prevents concurrent senders with the same ledger.
A crash can leave a lock. The owner must confirm no sender remains before removing that lock.
Namespace moves and reduced part counts stop for owner review. The prototype never deletes remote records.
The script sends no expiry field. Updates assume the original records still have no expiry.

Not verified: a live recall or propose, IAM enforcement on a live resource, and the Pi load of the relative core import in a generated profile.
