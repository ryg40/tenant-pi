# Owner-task rail (owner-popup)

When a Claude Code coordinator in a Herdr terminal ends a turn with a dummies report that has `Owner` or `Owner decides` actions, the owner-task producer streams those tasks as one A2UI v1.0 surface for each coordinator terminal (`owner-tasks:<address>`, for example `owner-tasks:t11y`) over a local WebSocket. The old shared surface ID `owner-tasks` is not sent. Each surface holds only the rows of its coordinator, with its own header naming the coordinator, its own status line, its own `Send N answers` button, and its own `Close` button. A locked surface has no `Send N answers` button, and the pending form of a send has no button.

The surface has two columns:

- The left column shows all open rows of the coordinator, stacked in report order. An open row has no answer yet, or it is a risky row whose answer waits for its Confirm. Each open row has its label, tags and text, one button for each answer side by side (at most three), and one "Other answer" field with a "Use text" button beside it. A risky row with a chosen answer also has a "Confirm" row. A writer row that is still writing shows its text only. When every row has an answer, the left column holds one line that says so.
- The right column lists only the answered rows, in report order. Each answered row has a check box, its label and full text, and its answer.

A click on an answer answers that row and checks it. The row leaves the left column, and the rows below it move up. A click on "Use text" makes the text in the field of that row the answer of that row, by the same rule; with an empty field no answer changes, the press keeps the drafts of the other fields, and the status line says why. A risky row stays in the left column after its answer, with a "Confirm" row that names the whole answer; it moves to the right column at its Confirm. No component of a risky row shows a check mark before its Confirm: its chosen answer button has the variant `primary` and the prefix `Chosen: `. The Confirm button approves only the answer that its surface shows. When the answer changed after that surface (a new answer, a new "Use text" or a cleared check box) and the row shows a Confirm button again, the producer refuses the press, draws the surface again, and the status line says that the answer changed. When the row shows no Confirm button now, for example after a cleared check box and no new answer, the press of the old Confirm stays silent. A Confirm is never kept for a later answer. When the decider marks an answered row risky later, the row goes back to the left column with its answer and a "Confirm" row, and it leaves the header count and the send line until its Confirm; a send that has already started keeps its list. A click on the check box of an answered row clears the answer and the typed text of that row, and the row goes back to its place in the left column. Text typed in the field of a row is no answer until "Use text"; it stays in the field while the owner clicks in other rows. When the owner clicks "Send N answers", the producer sends one `[Owner popup]` line back to that coordinator terminal at once. The line holds only the answered rows, so a risky row only after its Confirm.

The layout is the contract with the owner-rail mod of the Herdr app. The `root` Column carries the extension `owner_rail_layout: "two-column"` in `@metadata.extensions`. Its children are `header`, optional lines such as `status_line`, and `body`, a Row of the Columns `left` and `right`; `body` is the last child. The surface uses only standard components (`Text`, `Row`, `Column`, `Button`, `TextField`), so a mod that does not know the contract draws it stacked, and its buttons still work. The ids, with `<label>` the row label and `<optionId>` the option ID (`o1` to `o5`: the decider ranks up to five candidates, and the three answer buttons show the first three of the ranking):

| Place | Ids |
| --- | --- |
| Header | `header`, `hdr_title`, `hdr_coord`, `hdr_status`, `hdr_count`, `btn_send`, `btn_close` |
| Root lines | `status_line` |
| `left`, for each open row, as direct children of `left` | `open_text_<label>` (Text), `answers_<label>` (Row of the Buttons `answer_<label>_<optionId>`), `confirm_row_<label>` (Row of `confirm_msg_<label>` and the Button `confirm_<label>`, only for a risky row with an answer), `other_row_<label>` (Row of the TextField `other_<label>` and the Button `use_text_<label>`) |
| `left`, other lines | `pending_text` (the pending forms), `all_answered_text` (no open row) |
| `right`, for each answered row | `row_<label>`, a Row of the check box Button `toggle_<label>`, the Text `focus_<label>` (the row text) and the Text `chip_<label>` (the answer) |

The label Text of a Button has the id of the Button with `_lbl` added. A check box Button has the extensions `owner_rail_role: "check"` and `owner_rail_checked`; the row text `focus_<label>` has `owner_rail_role: "row-text"`. Its id keeps the old name for the mod; it is a plain Text now, and a click on it does nothing.

![The owner-task rail of the Herdr app with four cards of one example report. The focused card B asks "How the footer shows the quota: as a percent, or as a bar." and shows the answers "As a percent", "As a bar" and "Not now: ask me again later" and the field "Other answer". The compact cards C and D have the mark "risk", card E has the mark "owner step", and each has a Focus button. The header shows "Owner tasks", the coordinator name, "no decider", "0 of 4 answered", Send answers and Close.](images/owner-rail-suggestion.png)

The picture shows the old layout of one row of cards, before the two-column surface and its stacked rows. It is from the Herdr app, with the demo report of the kit (`owner-popup/fixtures/mockup-report.md`) and no decider in reach.

## When a row shows, and when Send works

A row shows only when it has no condition. A row with a condition (the text between the actor and the colon, for example `Owner decides, after the review: ...`) gets no row on the surface. A report whose owner rows all have a condition gives no surface. The header count and the send line count only the rows on the surface. The coordinator repeats the row with no condition in a later report when it is ready for the answer.

Send works only while the coordinator sits at its prompt and can receive. The hook events give this state: from its Stop event (the end of a turn with a report) to its next turn-start event. A delivered send starts a turn, and a line that the owner types in the terminal starts one too. From a delivered send that leaves rows, or from a turn-start, to the next report, the surface is locked:

- The rows that were not sent stay on the surface.
- The status line says that the coordinator works and that Send is possible again after its next report.
- The header has no Send button, and the producer refuses a `send` action.
- Answers, "Use text", Confirm, the check boxes and typed text still work, so the owner can prepare answers.

The next Stop report of the coordinator replaces the rows. A new row whose text (the whole text after the actor, not the label) is equal to the text of an old row takes over the answer, the typed text and the check box of that row. This happens only when the text occurs one time among the old rows and one time among the new rows; else the new row starts with no answer. An old row in the line of a send that still runs, or in the line of a send with an unknown result since the last report, gives nothing to a new row, because its answer can have arrived. This holds also when a turn-start came after the unknown send, or when the unknown result came on a locked surface. A later delivered send of the same surface ends these possibly-sent marks, so a row of the unknown line that is still on the surface can give its answer again. The exception is a row that a press unchecked because the old receipt of its line was already gone (see the retry rules below): its mark stays until the next report, unless a delivered send holds that row itself. A retry whose line is unchanged reuses the line and its receipt only while the receipt is young enough and still present. A receipt verifies at most one time, so at most one copy of the line verifies; this is not a promise that one copy verifies. When the young receipt of the first line is already gone at a later press, the first line arrived: the rail removes the rows of that line, sends nothing in that press, and locks the surface until the next report. When an old receipt is already gone, the rail cannot tell whether the line arrived: the rows stay and are unchecked, nothing is sent, and the surface does not lock. An answer whose button the new row does not have with the same text becomes the typed text, so the answer stays the same. A risky row needs a new Confirm, because the report revision is new. A taken-over answer of a row that was risky in the old report, by its words or by the decider, also needs a new Confirm: it stays in the left column, out of the header count and out of the send line, until its Confirm or until the decider of the new report says that the row is not risky. An old row with no equal new row ends. A report with no owner rows ends the surface. With no next report, the locked surface stays until `Close`, or until herdr-core says that the terminal of the coordinator does not exist or is not live.

The status that `hc get` reports does not decide this state. A Claude Code coordinator that holds background waits (for example `ask.py` with its `hc send --wait` child, or a shell loop) sits at its prompt, but the core can report it as `working`. A press for a coordinator whose surface is not locked therefore sends at once, whatever the status.

The `UserPromptSubmit` hook runs for each prompt that starts a turn: a line that a person types, a `<hc from=...>` message of another agent, and the notification of a background task. It also runs when a message arrives while a turn runs; the surface is already locked then. These cases can make the events differ from the real state, and each one locks the surface rather than unlocks it:

- The Stop hook writes no event when the turn ends with no text. The Claude Code hook documentation says that the Stop hook does not run when a person stops the turn. In both cases the surface stays locked until the next report.
- A prompt that starts no model turn still writes a turn-start event: the surface stays locked until the next report.

A Stop hook of another plugin that blocks the end of a turn would let the turn go on after the Stop event. Pi coordinators write no events, so the rail shows no surface of a Pi coordinator.

The feature is opt-in and runs from the kit checkout. Without its settings file, the hooks do nothing.

## How options are built

| Row kind | Source of options | Model calls |
| --- | --- | --- |
| `Owner decides` with named choices | Strict splitter on the first sentence (after the last `: ` when present, split on `, `, `, or `, or ` or `; 2 to 4 parts of 2 to 120 characters; splits explicit 3- or 4-term uniform-case single-word lists after `: ` such as `JSON, YAML or TOML`, and refuses ambiguous comma + bare `or` mixes such as `Paris, France or London`, two-part comma pairs with no `or`, and fragments with no standalone verb or noun; a comma or `or` inside balanced `( )`, `[ ]` or a backtick code span is not a split point) plus the two fixed answers `"Not now: ask me again later"` and `"Explain the trade-off first"`. | Decider only (loopback) |
| `Owner decides` with no split | Isolated Pi writer (`litellm-codex/codex-auto/luna`, thinking `medium`) writes candidate answers; the fixed answers join them. | Writer, then decider |
| `Owner decides` with `"needs a grilling round"` | `"Start a grilling round"` first, then any split choices as text. | None |
| `Owner` (owner step) | Fixed: `"Done"`, `"Not now"`, `"Ask the coordinator for another way"`. Never gets a recommended mark. | None |

The decider combines ranking (`choice`) and a risk gate (`noul`) in one request per row against `http://127.0.0.1:9301/v1/systemone` (loopback only, `redirect: "error"`, key from `DECISION_API_KEY`). No option is ever preselected. A `"recommended"` mark appears only on non-risky `Owner decides` rows when the top probability and margin pass the configured thresholds (start values: top probability 0.55 or more, margin 0.15 or more). A risky row (risk probability 0.30 or more, or a match on the fixed destructive-verb/object word list) never receives a recommended mark and requires clicking `Confirm` before Send includes it. Preflight checks `/health` with a 150 ms per-attempt cap and retries once after a timeout inside the 2 s phase budget (with no retry when the optional lock file is known to be held). When the decider is unreachable, slow (400 ms per row, 2 s phase limit), or blocked by its lock file, the header shows `no decider`, rows keep report or writer order without probabilities, and the fixed word list still enforces the risk gate.

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
- Single-instance lock: the bound loopback TCP port (`127.0.0.1:<port>`) is the OS-released lock (no `producer.lock` PID file). A second daemon whose bind fails with `EADDRINUSE` retries the bind a few times over about 3 seconds before exiting 0 without touching event files, so a Stop event during an idle shutdown takes over once the old listener closes. Another program on the port turns the rail off until the port is free; the event files of that time stay in the private `events/` folder until the next producer start, which drops Stop events older than 10 minutes without a surface.
- WebSocket path: `/a2ui`.
- Local gate: refuses any non-loopback peer, any `Host` other than loopback on the bound port, any `Origin` header, any query or fragment, and any plain HTTP route. No client message or HTTP request can add a task.
- Limits: at most 4 connected clients, 16 KiB pre-payload client frame cap, 1 MiB send queue cap, at most 8 queued actions per client (newest dropped while `hc` is slow), 2-minute idle timeout (periodic WebSocket ping; clients that send nothing and answer no ping for 2 minutes are closed), and `checkA2uiMessages` validation on every outgoing frame.
- Per-coordinator surfaces: each coordinator terminal has its own surface ID `owner-tasks:<address>`. A client that connects gets one `createSurface` batch for each live surface. A new report of a coordinator creates or replaces only its own surface, and a send of the last rows, `Close`, a report with no owner rows, or the end of its terminal (see Auto-exit, and the press checks below) deletes only its own surface; other coordinators' surfaces stay unchanged and are not re-sent. A client gets `createSurface` for a surface ID only when it does not already have that surface; changes to a live surface go as `updateComponents` and `updateDataModel`, or as `deleteSurface` followed by `createSurface` in one batch when replacing it.
- Actions: `choose` (an answer button, `answer_<label>_<optionId>`), `other` ("Use text", `use_text_<label>`), `confirm` (`confirm_<label>`), `toggle` (a check box, `toggle_<label>`), `send` (`btn_send`) and `close` (`btn_close`). Each `choose`, `other`, `confirm` and `toggle` context names its own target row (`targetLabel`); a `choose` context also names its `optionId`.
- Action validation: each coordinator report carries a fresh revision bound as a literal in every rendered `Button` context, with the coordinator (`targetCoordinator`, `targetRevision`). A `confirm` context also binds `answerVersion`, a decimal string on the wire (for example `"2"`) that changes each time the answer of its row is set, replaced or cleared. Each context except the one of `btn_close` also binds the draft of each "Other answer" field drawn: the key `other_<label>` with the path `/rows/<label>/other`. So every press except Close carries the drafts of all open rows, and the producer keeps them in the data model that it sends back; a redraw then keeps a draft that the owner did not use yet. A missing draft key keeps the draft that the producer has. Before any state changes, the producer validates `surfaceId` (must name a live surface matching the coordinator in the context), `sourceComponentId`, action name, bound coordinator/row/revision/option literals, and each draft key against that coordinator's currently rendered surface, never against a row index from the client. The target row of `choose`, `other` and `confirm` must be drawn in `left`, and the target row of `toggle` in `right`. Actions for a surface that does not exist, or with a mismatched `surfaceId`, stale revision, unknown source component, a target row that is not drawn where the action needs it, an unknown coordinator/row/option, a draft key of a field that is not drawn (also with a `null` value), or a wrong target change nothing and send nothing. A `send` for a locked surface changes nothing and sends nothing. Only two refusals are visible. First, a press of a drawn `confirm_<label>` of the current revision whose `answerVersion` is another string: it changes nothing, applies no draft, and draws the surface again with a status line. This check comes before the draft keys, so a draft key of a field that is no longer drawn (another row was answered after the Confirm was drawn) does not hide it. A `confirm` with a missing or non-string `answerVersion` stays silent. Second, a press of a Button of a replaced view: it names the coordinator of a live surface and one of the last eight replaced revisions of that surface. The client that pressed gets the current surface again, with the status line "The view changed. Check the rows and press again."; the press changes no answer, keeps no draft and withdraws no press of Send. The list of replaced revisions lives only across successful replacements of an active surface: Close, a send with no row left, the removal for a terminal that does not exist or is not live and a new report that does not replace the surface end it. So a stale revision that is not in that list (a forged revision, or one of a surface that ended) stays silent. Every other refused action stays silent. A client context value never becomes an `hc` destination unless that address currently holds a surface from an event.
- Auto-exit: drains pending events and ends itself after 10 minutes with no open surface and no connected client. At each idle check (every 30 seconds with the default idle time), for each surface, locked or open, with no pending form and no send in flight, the producer runs `hc get <address> --json`. When herdr-core says that the terminal does not exist (an error of the kind `not_found`) or is not live (a record whose `state` is not `live`, for example `finished` after `hc kill` with no `hc rm`), the producer ends the surface and deletes it: a terminal that ended writes no later report, so its surface would stay until a restart of the producer. A failed or slow `hc get` removes nothing.

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

The producer takes only files matching the two hook event file name forms or its own reader-taken form (`reading-<pid>-<12 lowercase hex>.json`, left behind if an earlier producer crashed) in `events/` (never opening, renaming, or removing temporary files or unrelated files such as `notes.json`), renaming each matched file to a fresh private reader name before reading and removing it. It drains pending events on startup and directly before each send decision ordered by event time rather than by filename. The time of an event is its `timeMs` value, else its `at` value, else the modification time of its file. For each coordinator address, the producer tracks the time of the latest applied event (Stop or turn-start) and ignores any older event before removing receipts or changing rows; a newer Stop always replaces any previous rows for its address before eligibility checks (dropping Stop events older than 10 minutes without a surface), checks that `dummies` is `on` for `claude`, and checks that `hc get <address> --json` reports the coordinator role (`skill.role=coordinator`, a `-coordinator-<n>` name, or, with neither a role label nor a role name, a `where` label that ends in ` / coordinator` or ` / 1`, the first tab of a Herdr app space). Task sessions and unknown roles get no surface.

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

# Choose option o1 for row B (row B moves to the right column)
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action choose --row B --pick o1

# Choose option o1 for risky row C, then confirm it
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action choose --row C --pick o1
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action confirm --row C

# Use a typed text as the answer of row D (--other is the text in the field of that row)
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action other --row D --other "Only the fixes"

# Uncheck row B (its answer ends, and it goes back to the left column)
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action toggle --row B

# Send the checked answers (prints one [Owner popup] line under --print)
node packages/tenantext/owner-popup/producer.ts --client --port 18776 --action send
```

After a send that leaves rows, the demo surface is not locked: no turn follows a print, so the rows left stay usable, with Send.

## Answer delivery, private receipts, and privacy log

Before building the `[Owner popup]` line, control characters, format characters, and line breaks are collapsed to spaces in every field (label, subject, selected option, and custom text), and `;`, `[`, and `]` inside field values are replaced with `,`, `(`, and `)` so no custom answer or field can imitate another row boundary.

The send line holds only the answered rows (checked, with an answer), in report order. A risky row needs its `Confirm` press before Send includes it. A press with no such row sends nothing and shows a status line.

When Send runs without `--print`, the surface changes at once to a small pending form: the header with no button, the line `Receipt pending for <coordinator>` in the left column, and no rows, so no second press can send. The form stays while `hc send` runs. After a good send, the producer removes only the sent rows:

- With no row left, the form ends (surface delete) at the turn-start event of that coordinator, or at the good send result when the turn-start came first. With no turn-start, it ends 20 seconds after the good send result.
- With rows left, the surface comes back locked. The left column shows `Receipt pending for <coordinator>: [B], [C]` with the sent labels until the same moment. When the turn-start came before the send result, this line does not show.

Each case below where no answer goes out brings the surface back in place of the form, with its status line and the answers unchanged, except a terminal that is not live: that surface ends. The producer drains pending events first, then reads `hc get <address> --json` (and drains pending events again). Then it checks, with no wait before the receipt:

- The surface is still the surface of the press (a new report or a `Close` ends it), and it is not locked (a turn-start locks it).
- No action for that coordinator arrived after the press. Any action on the surface of that coordinator withdraws the press while it waits in its lookup: a press that changes nothing, a refused action, `Close` of that surface, or a new press. An action that names no coordinator counts for every known coordinator. The producer counts each action when it arrives, before it waits in the queue. The surface shows one status line, and the rows stay.
- `hc get` found the terminal, and its state is `live`. With another state (for example `finished`), the producer sends nothing and ends the surface, as the idle check does. When `hc get` gives no record, the producer sends nothing, keeps the rows, shows one status line, and runs the idle check of that surface at once: a failed `hc get` also gives no record, so only an error of the kind `not_found` ends the surface.

Then, with no wait, it builds one list of the rows to send from the rows at that moment: checked, with an answer, and for a risky row confirmed. The line, the receipt, the pick log and the removal after the delivery all use this list. A row that the decider marked risky during the lookup is not in the list and stays on the surface. With an empty list, the producer sends nothing and shows a status line. Then it writes a single-use receipt, appends ` (receipt <id>)`, and runs `hc send <address> "<line>"`. The producer never passes `--force` or `--if`: a coordinator at its prompt reports `idle`, `done`, or `working`, and `--if idle` refuses `done` and `working`. `hc send` itself refuses a `blocked` terminal. In `--print` mode the producer writes no receipt.

herdr-core holds a send while a person's draft sits unsent in the terminal, up to 60 seconds after the last key (`draft_wait` in `~/.config/herdr-core/config.toml`), and for a quiet pause of a few seconds after a key. A line that a person submitted, or a draft that a person erased, holds no longer than the quiet pause. The setting belongs to the core: an `HC_DRAFT_MS` value in the environment of the `hc` client changes nothing, and `--force` does not skip the hold. The limit of one `hc send` is 75 seconds, above that hold. When `hc send` stops at its limit, herdr-core types nothing.

A press of Send can skip that hold. The skip needs two things: a successful detection that the running core has the option, and an `hc` client that knows the flag. The producer runs `hc schema` in the background: at start, when a report arrives, and when a press finds the kept answer older than about 60 seconds. A press never waits for that check; it uses the answer that is known at that moment. So after a core restart the answer can be up to about a minute old. When the method `terminal.send` has the parameter `no_draft_wait`, the producer runs `hc send <address> "<line>" --no-draft-wait`. Text that a person left in the prompt is then submitted together with the answer. `--no-draft-wait` is not `--force`: herdr-core still refuses a `blocked` terminal. A failed or unreadable `hc schema`, or no answer yet, counts as no option. An older core keeps the hold, and the producer sends with no flag. When an older `hc` client refuses the flag (exit 2 with a `usage` error), it sent nothing. The producer then drains pending events and checks again that the report is the same, that the surface is not locked, and that each row of the list is still checked, sendable and has the same answer (the decider can mark a row risky meanwhile). The row check runs with no wait before the start of the plain send. When the check passes, it sends the line one time again with no flag, within the same 75-second limit, and uses no flag until the next `hc schema` check. When the check fails, it sends nothing. After a turn-start the surface comes back locked; after a new report or a `Close` the new state stays. When a row changed or needs Confirm, the surface comes back with Send and a status line, and the owner presses Send again. The `send` event of the event log has the result `first-no-draft-wait` or `retry-no-draft-wait` for a send with the flag, and a second `send` event with the result `plain-after-usage` for that repeated send. Other `hc send` calls of the kit, for example handoff and agent sends, keep the hold.

When a new Stop report of the coordinator arrives while its `hc send` waits, the producer aborts that send: the `hc` client ends, and herdr-core types nothing. The aborted send counts as not sent. The producer removes its receipt and writes a `delivery` event with the result `aborted-new-report`. The new rows get no status line from it. A turn-start event does not abort a send, because the delivered line itself starts a turn; it locks the surface, and the pending form stays until the send result.

On a definite refusal from `hc send` (a non-zero exit that is not a timeout), the producer removes a new receipt and the rows stay. When the result of `hc send` is unknown (a timeout or a killed process), the producer keeps the receipt so a line that did arrive can still verify, and the surface says that the result is unknown and the rows stay. A new press of Send on the same surface sends the line of the first try with the same receipt only when its list gives exactly the same line (the same rows with the same answers). When both lines arrive, the receipt verifies one time, so the coordinator applies the answer once. When the line differs, the producer first removes the receipt of the first try, so a late first copy cannot verify, and then sends the new line with a new receipt. It sends the new line only when this press removed the old receipt file; when the removal fails, it sends nothing, keeps the retry, and the status line says to press Send again. An old receipt file that is already gone before the press removes it was consumed by a first copy that verified. While the receipt is younger than the reuse limit, no sweep can remove it, so only a verify explains a missing file: the first line arrived. The producer then sends nothing in that press, removes the rows of the first line, and locks the surface as a turn-start does, until the next report. The status line says that the first answer for these rows reached the coordinator, that the rows are removed and that nothing was sent now; the locked text says that Send is possible again after the next report. A press with the unchanged line makes the same check before it sends. These status lines are not a proof of delivery. A turn-start locks the surface and ends this retry, because no press can send until the next report; the rows of that line still give nothing to the next report. On a definite refusal of a press that reuses the first receipt, the producer keeps that receipt, because the first try can still arrive. A later lookup refusal of the new press keeps the unknown-result text and adds its reason.

The producer reuses the line of the first try only while its receipt can still verify when the line arrives: the age of the receipt plus the 75-second send limit is below the 10-minute receipt lifetime. After that, a new press is a new send: the producer removes the old receipt, forgets the first try, and sends the checked answers that the surface shows with a new receipt. A removal that fails leaves the old receipt: then the press sends nothing, as for a changed line. A late first copy then cannot verify, so the coordinator applies one answer. An old receipt that is already gone before the press is ambiguous: a verify consumed it, or it expired and a sweep before another send removed it. Then the press sends nothing and forgets the first try. The rows of the first line stay on the surface with their answers and typed text, but unchecked, so the next Send holds only the other checked rows. To send such a row again, the owner chooses its answer again (or presses "Use text"); a risky row then needs its Confirm again. The surface does not lock, and Send stays. The status line says that the result of the first try is not known, that it may have arrived, and that the owner checks the terminal. The event log has a `receipt` event with the result `old-receipt-gone-unresolved`.

Each receipt is written atomically under `<state dir>/receipts/<id>.json` (folder mode `0700`, file mode `0600`) with a 16-byte lowercase hex ID, the target coordinator address, the SHA-256 digest of the exact sent line without the ` (receipt <id>)` suffix, the SHA-256 digest of the report text, and the creation timestamp. When the producer processes a Stop event for an address, it removes every receipt file of that address; it also sweeps receipts older than 10 minutes on startup and before writing a new receipt.

Coordinators verify and consume a received `[Owner popup]` line with:

```sh
node <kitRoot>/packages/tenantext/owner-popup/receipt.ts verify --address <own address>
```

passing the received line on stdin (`<kitRoot>` is the `kitRoot` value of `~/.config/owner-popup/settings.json`). A receipt verifies one time, for this address, within 10 minutes, and only until the next report of this coordinator that the producer saw; when the producer does not run, only the 10 minutes hold. The command prints `valid` and exits 0 only when the ID is valid 32-char hex, the receipt file exists, the address matches, the SHA-256 digest of the line matches, and the receipt is at most 10 minutes old; it then deletes the receipt so replay fails. In every other case it prints a single-word reason and exits 1, removing nothing except an expired receipt.

A receipt proves that the owner-task producer of this user prepared this line for this coordinator, and it is no defense against a process that runs as the same user and can write the receipt folder. It is no proof of delivery, and after a crash between the write and the send a receipt can exist for a line that never arrived (it expires after 10 minutes).

The producer also appends one JSON line for each event to `<state dir>/producer-events.jsonl` (mode `0600`): the time, the event (`stop`, `turn-start`, `receipt`, `send`, `delivery`, `receipts-removed`, `terminal-gone`), the address, the first 12 hex characters of the report digest, and the result or reason. It writes no report text, answer text, row text or receipt ID. At producer start, a log larger than 1 MiB becomes `producer-events.jsonl.1` (it replaces an older `.1`), and a failure to write the log never stops the producer.

On `send` or `close` in daemon mode, the producer appends one JSON line to `~/.local/state/owner-popup/picks.jsonl` (mode `0600`) with only the timestamp, row count, and per-row kind, decider word (`decider` or `no decider`), and picked rank (`1`, `2`, `3`, `custom`, or `none`). A send writes only the sent rows; a `Close` writes all rows. No report text, option text, or custom answer text is written.

## Limits

- Pi has no command-line flag for an output token limit and no separate thinking token cap. The writer reader stops the Pi process after 4,000 characters of assistant text or 10 seconds, keeping any complete rows already parsed.
- A turn that starts between the last events drain and `hc send` remains a limit. The send has no `--if`, so the line arrives during that turn; Claude Code keeps it as a message for the running turn.
- One press holds the action queue of the producer until `hc send` returns, so actions on other surfaces wait too, up to the 60-second draft hold.
- A stop of the producer during a send loses the rows and the outcome of that send: the producer keeps no state on disk.
- A draft reaches the producer only with a press other than Close. A redraw that the producer starts itself (a decider or writer result, the end of a pending form) sends its kept drafts, so text typed after the last press is lost. Each press except Close carries the drafts of all open rows in one frame, so the drafts together must stay under the 16 KiB frame cap; the producer keeps at most 1,000 characters of each. `Close` carries no drafts, so it works at any draft size.
- One socket has a budget of eight outstanding actions. While one press waits in the draft hold, a ninth action of that socket is dropped with no notice.
- Prototype 1 covers Claude Code coordinators on `herdr-core` with mouse-driven A2UI buttons. Keyboard shortcuts and the bottom rail block live in the Herdr app repository.
