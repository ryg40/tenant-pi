# AgentCore Memory prototype design

## Boundaries

`index.ts` is the Pi factory. It reads one environment variable and registers the hooks.
`runtime.mjs` validates configuration, builds requests, bounds calls, and formats context.
The SDK adapter is lazy and injectable. Tests replace it without opening a socket.
No factory-time process, timer, credential read, or network request is needed.
The runtime owns no memory files and replaces no OpenViking or LLM Wiki hook.

The pure Python module renders `AGENTCORE_MEMORY_CONFIG` on the launch line.
It does not read environment values, credential files, or AWS state.
A complete JSON value avoids inherited per-field defaults enabling capture or changing namespaces.
Missing `actorId` is explicit as an empty string. Missing timeout becomes 3000 milliseconds.
Old overlays without `agentcore` remain valid and keep it off.

## Recall

Each user-started run receives at most one request per configured namespace.
The SDK request uses `namespace`, not `namespacePath`, and one semantic query with `topK`.
Calls run in configuration order. A failed namespace does not discard a successful namespace.
The context message preserves the record identifier and returned namespaces.
JSON encoding separates record data from the heading and quotes embedded newlines.
The extension does not replace the system prompt or alter local memory state.

A timer races the whole operation, including lazy SDK loading and credential resolution.
An abort signal also reaches the SDK send operation.
A late client cannot send after its request expires because the signal is checked after client initialization.
The SDK has one attempt. Custom starts do not reuse an earlier user query.
Shutdown aborts outstanding calls and prevents late initialization from keeping a client alive.

## Capture

Capture is off by default and requires an explicit boolean to turn it on.
The off branch exits before reading the event, context, or client.
The experimental branch sends assistant text only and disables long-term extraction for that event.
It does not submit reviewed records and does not create a local retry queue.
A separate owner approval and IAM action are needed before a live capture trial.

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

Not verified: AWS idempotency duration, partial-success behavior, capture retention, strategy behavior, or IAM enforcement on a live resource.
