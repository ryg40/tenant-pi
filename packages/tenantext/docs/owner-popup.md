# Owner-task rail (owner-popup)

When a Claude Code coordinator in a Herdr terminal ends a turn with a dummies report that has `Owner` or `Owner decides` actions, the owner-task producer streams those tasks as one A2UI v1.0 surface for each coordinator terminal (`owner-tasks:<address>`, for example `owner-tasks:t11y`) over a local WebSocket. The old shared surface ID `owner-tasks` is not sent. Each surface holds only the cards of its coordinator, with its own header naming the coordinator, its own focused card, its own status line, its own `Send answers` button, and its own `Close` button. The Herdr app draws each task as a native card in one row: compact cards sit beside one focused card that grows in place (`weight`) to show three answers, an "Other answer" field, and a "Confirm" button for risky rows. The focused card puts the label, tags, and state inline with the task text, and the surface has no footer note. When the owner clicks "Send answers", the producer sends one `[Owner popup]` line back to that coordinator terminal at once.

## When a card shows

A card shows only when two rules hold:

- Its row has no condition. A row with a condition (the text between the actor and the colon, for example `Owner decides, after the review: ...`) gets no card. A report whose owner rows all have a condition gives no surface. The header count and the send line count only the rows with a card. The coordinator repeats the row with no condition in a later report when it is ready for the answer.
- The coordinator sits at its prompt and can receive. The hook events give this state: the cards of a coordinator show from its Stop event (the end of a turn with a report) to its next turn-start event. A turn-start removes its surface. The cards come back only with the next report that has owner rows.

The status that `hc get` reports does not decide this state. A Claude Code coordinator that holds background waits (for example `ask.py` with its `hc send --wait` child, or a shell loop) sits at its prompt, but the core can report it as `working`. A press for a coordinator with cards therefore sends at once, whatever the status.

The `UserPromptSubmit` hook runs for each prompt that starts a turn: a line that a person types, a `<hc from=...>` message of another agent, and the notification of a background task. It also runs when a message arrives while a turn runs; the cards are already gone then. These cases can make the events differ from the real state, and each one hides cards rather than shows them:

- The Stop hook writes no event when the turn ends with no text. The Claude Code hook documentation says that the Stop hook does not run when a person stops the turn. In both cases the cards stay hidden until the next report.
- A prompt that starts no model turn still writes a turn-start event: the cards stay hidden until the next report.

A Stop hook of another plugin that blocks the end of a turn would let the turn go on after the Stop event. No Stop hook on the build host blocks a turn. Pi coordinators write no events, so the rail shows no cards of a Pi coordinator.

The feature is opt-in and runs from the kit checkout. Without its settings file, the hooks do nothing.

## How options are built

| Row kind | Source of options | Model calls |
| --- | --- | --- |
| `Owner decides` with named choices | Strict splitter on the first sentence (after the last `: ` when present, split on `, `, `, or `, or ` or `; 2 to 4 parts of 2 to 120 characters; splits explicit 3- or 4-term uniform-case single-word lists after `: ` such as `JSON, YAML or TOML`, and refuses ambiguous comma + bare `or` mixes such as `Paris, France or London`, two-part comma pairs with no `or`, and fragments with no standalone verb or noun) plus the two fixed answers `"Not now: ask me again later"` and `"Explain the trade-off first"`. | Decider only (loopback) |
| `Owner decides` with no split | Isolated Pi writer (`litellm-codex/codex-auto/luna`, thinking `medium`) writes candidate answers; the fixed answers join them. | Writer, then decider |
| `Owner decides` with `"needs a grilling round"` | `"Start a grilling round"` first, then any split choices as text. | None |
| `Owner` (owner step) | Fixed: `"Done"`, `"Not now"`, `"Ask the coordinator for another way"`. Never gets a recommended mark. | None |

The decider combines ranking (`choice`) and a risk gate (`noul`) in one request per row against `http://127.0.0.1:9301/v1/systemone` (loopback only, `redirect: "error"`, key from `DECISION_API_KEY`). No option is ever preselected. A `"recommended"` mark appears only on non-risky `Owner decides` rows when the top probability and margin pass the configured thresholds (start values: top probability 0.55 or more, margin 0.15 or more). A risky row (risk probability 0.30 or more, or a match on the fixed destructive-verb/object word list) never receives a recommended mark and requires clicking `Confirm` before `Send answers` includes it. Preflight checks `/health` with a 150 ms per-attempt cap and retries once after a timeout inside the 2 s phase budget (with no retry when the optional lock file is known to be held). When the decider is unreachable, slow (400 ms per row, 2 s phase limit), or blocked by its lock file, the header shows `no decider`, rows keep report or writer order without probabilities, and the fixed word list still enforces the risk gate.

The default model ID of the decider, `pplx-decider-flash-v1.3-Q4_K_M`, names the model of the reference setup. Set the model ID to one that your local decision endpoint serves. The `model` field of the decider settings (`DeciderConfig.model`) sets it for a program that starts the producer, and `measure-decider.ts --model` sets it for a measurement. The producer command has no option or environment variable for the model: it always sends the default.

The producer accepts only a loopback decider address. When the decision model runs on another computer, a local forward gives it a loopback address, for example this command as a kept systemd user unit:

```sh
socat TCP-LISTEN:9301,bind=127.0.0.1,reuseaddr,fork TCP:<model host>:<port>
```

Warning: through this forward, the report excerpts cross the network in plain HTTP. Use it only in a trusted network.

## What leaves the session

| Path | Text | Where it goes |
| --- | --- | --- |
| Decider | Bounded excerpt (at most 800 characters; see exact rule below) and one task text per request; never `## Checks` or any other `## ` section, code fence, `>` quote line, or transcript | Loopback (`http://127.0.0.1:9301`), local container, no gateway |
| Writer | The same bounded excerpt and the task texts of unsplit `Owner decides` rows only | The LiteLLM gateway, then the configured Codex model (`TENANTEXT_LITELLM_BASE_URL`, `TENANTEXT_LITELLM_API_KEY`) |

How the bounded excerpt is extracted (`rows.ts:extractExcerpt`):

- Code fences and `>` quote lines are stripped first.
- Compact format (`**REPORT ...**` or `**OUTCOME**`) is recognized only at the report's legal start (the first non-empty readable line, or the first non-empty line after an `added:` line), never by searching later text; for a compact report, the excerpt holds that header line and any `**Warning:**` lines before `**Next:**` or any `## ` heading.
- Any other report is read as detailed format: the excerpt holds only the first paragraph and any `**Warning:**` lines appearing before the first `## ` heading. A `**REPORT ...**` or `**OUTCOME**` line inside `## Checks` never enters the excerpt.

A report whose `Owner decides` rows all split never invokes the writer, so no text leaves the computer.

## Producer socket, actions, and remote SSH forward

The producer listens on `127.0.0.1` only:

- Default port: `18766` (override with `--port <port>`).
- Single-instance lock: the bound loopback TCP port (`127.0.0.1:<port>`) is the OS-released lock (no `producer.lock` PID file). A second daemon whose bind fails with `EADDRINUSE` retries the bind a few times over about 3 seconds before exiting 0 without touching event files, so a Stop event during an idle shutdown takes over once the old listener closes. Another program on the port turns the rail off until the port is free; the event files of that time stay in the private `events/` folder until the next producer start, which drops Stop events older than 10 minutes without a card.
- WebSocket path: `/a2ui`.
- Local gate: refuses any non-loopback peer, any `Host` other than loopback on the bound port, any `Origin` header, any query or fragment, and any plain HTTP route. No client message or HTTP request can add a task.
- Limits: at most 4 connected clients, 16 KiB pre-payload client frame cap, 1 MiB send queue cap, at most 8 queued actions per client (newest dropped while `hc` is slow), 2-minute idle timeout (periodic WebSocket ping; clients that send nothing and answer no ping for 2 minutes are closed), and `checkA2uiMessages` validation on every outgoing frame.
- Per-coordinator surfaces: each coordinator terminal has its own surface ID `owner-tasks:<address>`. A client that connects gets one `createSurface` batch for each live surface. A new report of a coordinator creates or replaces only its own surface, and a send, `Close`, turn-start, or end of cards deletes only its own surface; other coordinators' surfaces stay unchanged and are not re-sent. A client gets `createSurface` for a surface ID only when it does not already have that surface; changes to a live surface go as `updateComponents` and `updateDataModel`, or as `deleteSurface` followed by `createSurface` in one batch when replacing it.
- Action validation: each coordinator report carries a fresh revision bound as a literal in every rendered `Button` context (`focus`, `confirm`, `send`, and `close`). Before any state changes, the producer validates `surfaceId` (must name a live surface matching the coordinator in the context), `sourceComponentId`, action name, bound coordinator/row/revision literals, focused card state, and option IDs against that coordinator's currently rendered surface. Actions for a surface that does not exist, or with a mismatched `surfaceId`, stale revision, unknown source component, non-focused `confirm` target, unknown coordinator/row/option, or wrong target change nothing and send nothing. A client context value never becomes an `hc` destination unless that address currently holds cards from an event.
- Auto-exit: drains pending events and ends itself after 10 minutes with no open cards and no connected client.

When the Herdr app runs on another computer (for example a laptop connecting to a build host), forward the loopback port over SSH so the producer stays bound to `127.0.0.1`:

```sh
ssh -N -L 18766:127.0.0.1:18766 <host>
```

To keep the forward open, run it as a systemd user unit on the computer of the Herdr app. An example unit, `~/.config/systemd/user/owner-popup-forward.service`:

```ini
[Unit]
Description=SSH forward of the owner-task producer port
After=network-online.target

[Service]
ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 18766:127.0.0.1:18766 <build host>
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Start it with `systemctl --user enable --now owner-popup-forward.service`. `BatchMode=yes` needs a key that SSH can use without a prompt. `ExitOnForwardFailure=yes` ends the unit when the local port is in use, and `Restart=always` starts it again.

## Opt-in settings, hooks, and child environments

The Claude Code plugin registers two hooks in `claude-code/hooks/hooks.json` backed by `claude-code/scripts/owner-popup-hook.mjs`:

- `Stop` (`"async": true`): checks opt-in settings before reading stdin (stdin bounded to 1 MiB and 2 s), reads `last_assistant_message` (never opens the transcript), publishes `stop-<16-digit ms>-<8 lowercase hex>.json` to `~/.local/state/owner-popup/events/` (folder mode `0700`, file mode `0600`) with a sub-millisecond timestamp via temporary file + atomic rename, and spawns the detached producer.
- `UserPromptSubmit`: writes at most one file per terminal (`turn-start-<address>.json`, allowing only letters, digits, `.`, `_`, and `-` in `<address>`, never starting with `-`, and writing nothing for another address) with a sub-millisecond timestamp via temporary file + atomic rename over any earlier file whenever the feature is enabled.

Both hooks write nothing when `CLAUDE_CODE_ENTRYPOINT` starts with `sdk-`. A `claude -p` or SDK run that a hook or a tool of the coordinator starts (for example the memory recall of a `UserPromptSubmit` hook) inherits `HC_TERMINAL_ID`. Its turns are not turns of the coordinator, and its Stop would end the receipt of an answer that the coordinator did not verify yet.

Both hooks stay silent and exit 0 unless `~/.config/owner-popup/settings.json` and its parent folder belong to the current user, are not symlinks, and are not writable by group or others (`mode & 0o022 === 0`), with `"enabled": true` and an absolute `kitRoot` whose directory path to `producer.ts` passes `isTrustedEntry` (each entry belongs to the current user or `root`, is not a symlink, and is not writable by group or others, `mode & 0o022 === 0`). A kit checkout with group-writable folders is refused silently by the `isTrustedEntry` check:

```json
{
  "enabled": true,
  "kitRoot": "/path/to/tenant-pi"
}
```

The producer takes only files matching the two hook event file name forms or its own reader-taken form (`reading-<pid>-<12 lowercase hex>.json`, left behind if an earlier producer crashed) in `events/` (never opening, renaming, or removing temporary files or unrelated files such as `notes.json`), renaming each matched file to a fresh private reader name before reading and removing it. It drains pending events on startup and directly before each send decision ordered by event time rather than by filename. The time of an event is its `timeMs` value, else its `at` value, else the modification time of its file. For each coordinator address, the producer tracks the time of the latest applied event (Stop or turn-start) and ignores any older event before removing receipts or changing cards; a newer Stop always clears any previous cards for its address before eligibility checks (dropping Stop events older than 10 minutes without a card), checks that `dummies` is `on` for `claude`, and checks that `hc get <address> --json` reports the coordinator role (`skill.role=coordinator`, a `-coordinator-<n>` name, or, with neither a role label nor a role name, a `where` label that ends in ` / coordinator` or ` / 1`, the first tab of a Herdr app space). Task sessions and unknown roles get no cards.

Child processes receive minimal allowlisted environments:

- Hook -> producer: `PATH`, `HOME`, locale/temp/XDG/CA paths, herdr-core routing variables (`HC_SOCKET`, `HC_SCOPE`, `HC_RUNTIME_DIR`, `HC_DRAFT_MS`), `DECISION_API_KEY`, and `TENANTEXT_LITELLM_*` (never `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, or unrelated session credentials).
- Producer -> `hc`: `PATH`, `HOME`, locale/temp/XDG paths, and herdr-core routing variables only (never `HC_TERMINAL_ID`, `DECISION_API_KEY`, or `TENANTEXT_LITELLM_*`).
- Producer -> `pi` writer: `PATH`, `HOME`, locale/temp/XDG/CA paths, `TENANTEXT_LITELLM_BASE_URL`, `TENANTEXT_LITELLM_API_KEY`, and a fresh empty `PI_CODING_AGENT_DIR` (never `DECISION_API_KEY` or `HC_*`).
- Producer -> `flock`: `PATH`, `HOME`, locale/temp paths only.

## Demo mode and CLI client

Run the producer on a free port with a synthetic fixture and `--print` (prints the `[Owner popup]` line with no receipt and no suffix instead of calling `hc send`):

```sh
node packages/tenantext/owner-popup/producer.ts \
  --demo packages/tenantext/owner-popup/fixtures/mockup-report.md \
  --parent t11y \
  --port 18776 \
  --print
```

In a second terminal, use the built-in `--client` command to inspect the surface and send actions without the Herdr app:

```sh
# Print the initial surface and live updates
node packages/tenantext/owner-popup/producer.ts --client --port 18776

# Focus row C while recording option o1 on the currently focused row B
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action focus --row C --pick o1

# Confirm risky row C after selecting its option
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action confirm --row C --pick o1

# Send the confirmed answers (prints one [Owner popup] line under --print)
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action send
```

## Answer delivery, private receipts, and privacy log

Before building the `[Owner popup]` line, control characters, format characters, and line breaks are collapsed to spaces in every field (label, subject, selected option, and custom text), and `;`, `[`, and `]` inside field values are replaced with `,`, `(`, and `)` so no custom answer or field can imitate another row boundary.

A risky row needs its `Confirm` press before `Send answers` includes it. When `Send answers` runs without `--print`, the surface shows at once the line `Sending the answer to <address> ...`. The producer drains pending events first, then reads `hc get <address> --json` (and drains pending events again). Then it checks, with no wait before the receipt:

- The cards are still the cards of the press (a new report, a turn-start or a `Close` ends them).
- No action for that coordinator arrived after the press. Any action on the cards of that coordinator withdraws the press while it waits in its lookup: a focus move with no change, a refused action, `Close` of that surface, or a new press. An action that names no coordinator counts for every known coordinator. The producer counts each action when it arrives, before it waits in the queue. The surface shows one status line, and the cards stay.
- `hc get` found the terminal, and its state is `live`. Else the producer sends nothing, keeps the cards, and shows one status line.

Then it writes a single-use receipt, appends ` (receipt <id>)`, and runs `hc send <address> "<line>"`. The producer never passes `--force` or `--if`: a coordinator at its prompt reports `idle`, `done`, or `working`, and `--if idle` refuses `done` and `working`. `hc send` itself refuses a `blocked` terminal. In `--print` mode the producer writes no receipt.

herdr-core holds a send while a person's draft sits unsent in the terminal, up to 60 seconds after the last key (`draft_wait` in `~/.config/herdr-core/config.toml`), and for a quiet pause of a few seconds after a key. A line that a person submitted, or a draft that a person erased, holds no longer than the quiet pause. The setting belongs to the core: an `HC_DRAFT_MS` value in the environment of the `hc` client changes nothing, and `--force` does not skip the hold. The limit of one `hc send` is 75 seconds, above that hold. When `hc send` stops at its limit, herdr-core types nothing.

When a new Stop report of the coordinator arrives while its `hc send` waits, the producer aborts that send: the `hc` client ends, and herdr-core types nothing. The aborted send counts as not sent. The producer removes its receipt and writes a `delivery` event with the result `aborted-new-report`. The new cards get no status line from it. A turn-start event does not abort a send, because the delivered line itself starts a turn.

On a definite refusal from `hc send` (a non-zero exit that is not a timeout), the producer removes the receipt and the cards stay. When the result of `hc send` is unknown (a timeout or a killed process), the producer keeps the receipt so a line that did arrive can still verify, and the surface says that the result is unknown and the cards stay. A new press of `Send answers` on the same cards then sends the line of the first try with the same receipt, whatever the cards show now, also when no answer is picked now. The pick log gets the picks of the first try. When both lines arrive, the receipt verifies one time, so the coordinator applies the answer once. On a definite refusal of that new press, the producer keeps the receipt, because the first try can still arrive. A later lookup refusal of the new press keeps the unknown-result text and adds its reason.

The producer reuses the line of the first try only while its receipt can still verify when the line arrives: the age of the receipt plus the 75-second send limit is below the 10-minute receipt lifetime. After that, a new press is a new send: the producer removes the old receipt, forgets the first try, and sends the answers that the cards show with a new receipt. A late first copy then cannot verify, so the coordinator applies one answer.

Each receipt is written atomically under `<state dir>/receipts/<id>.json` (folder mode `0700`, file mode `0600`) with a 16-byte lowercase hex ID, the target coordinator address, the SHA-256 digest of the exact sent line without the ` (receipt <id>)` suffix, the SHA-256 digest of the report text, and the creation timestamp. When the producer processes a Stop event for an address, it removes every receipt file of that address; it also sweeps receipts older than 10 minutes on startup and before writing a new receipt.

Coordinators verify and consume a received `[Owner popup]` line with:

```sh
node <kitRoot>/packages/tenantext/owner-popup/receipt.ts verify --address <own address>
```

passing the received line on stdin (`<kitRoot>` is the `kitRoot` value of `~/.config/owner-popup/settings.json`). A receipt verifies one time, for this address, within 10 minutes, and only until the next report of this coordinator that the producer saw; when the producer does not run, only the 10 minutes hold. The command prints `valid` and exits 0 only when the ID is valid 32-char hex, the receipt file exists, the address matches, the SHA-256 digest of the line matches, and the receipt is at most 10 minutes old; it then deletes the receipt so replay fails. In every other case it prints a single-word reason and exits 1, removing nothing except an expired receipt.

A receipt proves that the owner-task producer of this user prepared this line for this coordinator, and it is no defense against a process that runs as the same user and can write the receipt folder. It is no proof of delivery, and after a crash between the write and the send a receipt can exist for a line that never arrived (it expires after 10 minutes).

The producer also appends one JSON line for each event to `<state dir>/producer-events.jsonl` (mode `0600`): the time, the event (`stop`, `turn-start`, `receipt`, `send`, `delivery`, `receipts-removed`), the address, the first 12 hex characters of the report digest, and the result or reason. It writes no report text, answer text, row text or receipt ID. At producer start, a log larger than 1 MiB becomes `producer-events.jsonl.1` (it replaces an older `.1`), and a failure to write the log never stops the producer.

On `send` or `close` in daemon mode, the producer appends one JSON line to `~/.local/state/owner-popup/picks.jsonl` (mode `0600`) with only the timestamp, row count, and per-row kind, decider word (`decider` or `no decider`), and picked rank (`1`, `2`, `3`, `custom`, or `none`). No report text, option text, or custom answer text is written.

## Limits

- Pi has no command-line flag for an output token limit and no separate thinking token cap. The writer reader stops the Pi process after 4,000 characters of assistant text or 10 seconds, keeping any complete rows already parsed.
- A turn that starts between the last events drain and `hc send` remains a limit. The send has no `--if`, so the line arrives during that turn; Claude Code keeps it as a message for the running turn.
- One press holds the action queue of the producer until `hc send` returns, so actions on other surfaces wait too, up to the 60-second draft hold.
- A stop of the producer during a send loses the cards and the outcome of that send: the producer keeps no state on disk.
- One socket has a budget of eight outstanding actions. While one press waits in the draft hold, a ninth action of that socket is dropped with no notice.
- Prototype 1 covers Claude Code coordinators on `herdr-core` with mouse-driven A2UI buttons. Keyboard shortcuts and the bottom rail block live in the Herdr app repository.
