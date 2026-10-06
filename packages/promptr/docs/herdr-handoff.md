# Bounded Herdr role handoff

The internal `src/herdr/role-handoff.mts` module exposes `startRoleHandoff` and
`collectRoleHandoff`. It is a fixture-backed pilot API, not a new automatic
workflow or a user-facing command. A coordinator must explicitly request one
visible role and write its packet before calling start.

## Adapter boundary

`src/herdr/adapter.mts` builds tab, full interactive Pi start, prompt and wait
arguments. It parses bounded Herdr JSON envelopes and checks pane, working
directory, session, terminal and ownership identity. It rejects error envelopes.
For every caller, the shared parsers are stricter: they reject envelopes with an `error` key and output over 1 MiB.

The generator, successor handoff and companion briefing paths use these shared
parts. Their existing readiness policies and argument sequences stay intact.
The generator still appends its existing tool restrictions. The role pilot
starts a full interactive Pi session without restrictions on tools or skills.

Start requires an explicit role, a stable run ID, an absolute packet path, a
working directory, a task reference and exact harness/provider/model/thinking
values. Only the Pi harness is enabled. No runtime fallback applies.

Each run creates a new tab in the requested workspace. The role appears in its
label and receipt. This pilot never reuses panes. A future reuse path must match
recorded role, session, working directory and ownership before any send.

The default executor bounds each command and limits output to 1 MiB. Readiness
has a 60-second deadline and at most 30 probes. One slow probe can extend that
deadline by its five-second command timeout. Collection waits at most ten
seconds in Herdr. An injected executor must enforce equivalent command bounds.

## Run receipts

Receipts live under the existing Promptr state root:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/promptr/herdr-runs/<run-id>/
```

Directories use mode `0700`. Receipt files use mode `0600` and exclusive creation.
An existing run directory refuses a second start, even after a process crash.
Files are write-once. No automatic cleanup closes or replaces a session.

| File | Meaning |
| --- | --- |
| `attempted.json` | Durable launch intent, before any Herdr mutation. |
| `pane.json` | Created pane identity, before agent start. |
| `prompt-attempted.json` | Verified harness identity and prompt time, before the only send. |
| `launch.json` | `submitted`, `uncertain` or `failed-before-send` launch outcome. |
| `collection-attempted-<n>.json` | Write-once intent for collection attempt number `n`, starting at 1. |
| `collection-<n>.json` | Write-once attempt outcome, with a safe rejection reason and report hash when read. |
| `collection.json` | Write-once final `collected` receipt with the report hash. |
| `report.json` | Bounded worker artifact, not a receipt or a transcript. |

The receipt carries the run ID, SHA-256 packet hash, task reference, role,
working directory, exact runtime choice, ownership name, pane, terminal,
harness session, prompt outcome and timestamps. Fields not yet known remain
absent. The completion marker includes a unique per-run value.

Receipts store no packet body, prompt body, raw transcript or raw CLI errors.
Use task references and runtime identifiers, not credentials. A successful CLI
acknowledgement records `submitted`; it does not prove work started or succeeded.
A failure before the send records `failed-before-send`; its `stage` identifies the failed launch step.
A lost acknowledgement remains `uncertain`. Collection refuses an uncertain
send. Inspect the open session manually. Do not replay or replace it.

## Collection checks

1. Refuse collection after a final receipt exists, then claim a numbered collection attempt.
2. Read the launch receipt and validate its field types and identity; reject a wrong shape as `invalid-receipt`.
3. Require a confirmed submission and matching live pane, session, directory, terminal and ownership.
4. Refuse blocked sessions, then perform one bounded wait and check identity again.
5. Read a regular report file of at most 32 KiB without following a symlink.
6. Match its run ID, packet hash, harness session and unique completion marker.
7. Require its completion timestamp and file modification time to follow the prompt and not exceed the collection time.
8. Require non-empty report text of at most 24000 characters and check live identity and readiness again.
9. Record the SHA-256 report hash and collection outcome without copying report text into a receipt.

A report has `runId`, `packetHash`, `session`, `completedAt` (ISO timestamp),
`marker` and `report` fields. Start puts these requirements in the prompt.
Idle alone is not completion. A report shape is not proof of correctness.
The coordinator reviews the returned report and independently checks its claims.
A rejected or crashed collection retains its numbered evidence.
The coordinator can retry collection after a recoverable rejection, such as `not-settled`, `blocked` or a missing report.
Each retry creates new write-once files; it never sends the prompt again.
A successful collection creates the final receipt and refuses all later collection calls.

## Fixture evidence

`test/herdr/fixtures/agent-get.json` and `agent-list.json` retain the shapes of
read-only CLI captures. Values are neutral and the list contains one agent.
The prompt-wait and wait fixtures use the corresponding Herdr response serializer
shapes (`agent_prompted` and `agent_info`) with the same neutral agent record.
They are contract fixtures, not recordings of a live prompt or completed pilot.
No fixture test sends input to a real pane.

## Owner-run measurement plan

1. Write one small packet with an independently checkable result and an explicit Pi role request.
2. Record the selected runtime, packet hash and starting tool-call and token counters.
3. Call start once and retain the receipt and the open interactive pane.
4. Call collect once after the report is present, then independently check its claims.
5. Record tool calls, input/output tokens and elapsed start-to-collection latency.
6. Report failures, uncertain sends and manual interventions as separate outcomes.

Compare equivalent packets and exact runtimes. Separate launch overhead from
worker effort. Small samples support no general performance claim.

Not proved: the live pilot with one Pi role, tool-call/token/latency measurements,
and the Claude path. The package's blocked runtime status is unchanged.
