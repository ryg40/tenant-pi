# Context meter

The context meter shows current context pressure without making a provider request. It works without the main Tenantext extension.

## Installation

1. Add `extensions/context-meter/index.ts` to Pi's extension paths.
   Pi loads the meter as an independent extension.
2. Place the meter after extensions that change provider payloads.
   Its request hook then sees their final changes.
3. Run `/reload`.
   The meter appears below the editor.

For an isolated local smoke session, use:

```bash
pi --offline --no-session --no-extensions \
  --provider example-provider --model example-model --thinking low \
  -e ./extensions/context-meter/index.ts
```

Replace the example provider and model with a configured pair. This command still loads other configured resources unless you disable them separately. Do not submit a prompt during a no-inference smoke test.

## Display

The meter uses a full-width source bar and a separate compact status row.

| Stage | Default percentage | Action |
| --- | --- | --- |
| `OK` | Below 60% | Continue normally |
| `PLAN` | 60% to below 75% | Finish this unit and prepare a handoff |
| `WARN` | 75% to below 90% | Start a new session or compact |
| `CRIT` | 90% and above | Stop adding large context and transition now |
| `UNK` | Unknown usage or window | Check the model and wait for usage data |

`SYS!` appears when the estimated system prompt reaches the configured warning threshold. The default threshold is 10,000 tokens.

| Source | Meaning | Dark-theme background |
| --- | --- | --- |
| `sys` | Complete system instructions | Mint `#7DD3A8` |
| `prompt` | User messages, images, custom messages, and summaries | Rose `#F0A6CA` |
| `assistant` | Visible assistant text and tool calls | Cyan `#7CC4D8` |
| `think` | Stored thinking text | Violet `#A78BFA` |
| `tools` | Tool results and included shell output | Amber `#F2C26B` |
| `free` | Remaining model context | Slate `#273244` |

The bar is the shared segmented-bar primitive in `extensions/context-meter/bar.ts`. The operations footer draws the same bar.

Thin `▏` markers sit at the configured thresholds. Inside a used block the marker is dark, so a crossed threshold stays visible. The free block lightens slightly at each threshold.

Labels sit inside their blocks and use the longest form that fits the block: `assistant`, `as`, or none. Tiny blocks stay unlabeled. Markers take priority over labels.

The standalone widget keeps its status row for stage, totals, guidance, and marker positions. The footer puts totals inside the bar instead.

| Width | Display |
| --- | --- |
| At least 120 | Full labels where possible, totals, guidance, and marker positions |
| 80–119 | Short labels, totals, and guidance |
| 40–79 | Short labels, totals, and active warning |
| 20–39 | Letter labels, stage, percentage, and active warning |
| Below 20 | One status row; stage and percentage take priority |
| 0 | No rows |
| 1 | One stage letter; the full status cannot fit |

At tiny widths, `O`, `P`, `W`, `C`, and `U` mean the corresponding stages. `U` never means normal usage.

The renderer uses the exact supplied width. It measures and truncates styled text through Pi's ANSI-safe TUI helpers.

### Palette

The meter and the operations footer share one palette in `extensions/context-meter/bar.ts`. The used blocks are muted, low-chroma hues at one perceived luminance (Rec. 601 luma 155 to 190), so they read as data and never as a warning. Hue walks cool to warm along the bar, and adjacent blocks differ by at least 30°.

| Block | RGB | Role |
| --- | --- | --- |
| sys | `129;161;193` frost | System prompt: infrastructure, the coolest color |
| prompt | `136;192;176` sage | User prompts |
| assistant | `122;162;247` blue | Model output |
| think | `170;150;232` lavender | Reasoning |
| tools | `202;182;146` sand | Tool results, usually the largest block, so the calmest color |
| free | `27;33;46` slate | Remaining window; tints indigo at PLAN, amber at WARN, red at CRIT |

Saturated amber (`255;196;96`) and red (`255;122;122`) appear only in stage words, alert glyphs, and threshold bands. Every used block takes dark label ink.

Set `NO_COLOR` or use `TERM=dumb` to disable meter colors. Used blocks fill with `▓`, free space with `·`, and markers use `│`. Labels and stage text remain visible.

## Commands

| Command | Result |
| --- | --- |
| `/context-meter` | Open the local report |
| `/context-meter report` | Open the local report |
| `/context-meter on` | Show the standalone meter for this session |
| `/context-meter off` | Hide the standalone meter for this session |
| `/context-meter save` | Save current settings as defaults |
| `/context-meter help` | Show command help |

The TUI report is a temporary scrollable dialog. Use the arrow keys to scroll, then Enter or Escape to close it.

RPC mode uses a UI notification. Print and JSON modes do not create a widget or inject a report into context.

## Settings

Pi's `getAgentDir()` determines the settings directory. `PI_CODING_AGENT_DIR` overrides its default, `~/.pi/agent`.

The default settings file is `~/.pi/agent/context-meter/settings.json`:

```json
{
  "enabled": true,
  "preparePercent": 60,
  "transitionPercent": 75,
  "criticalPercent": 90,
  "systemPromptWarningTokens": 10000,
  "nextMoveUrl": "",
  "nextMoveKeyEnv": "TENANTEXT_NEXT_MOVE_KEY",
  "nextMoveTimeoutMs": 150,
  "nextMoveMinConfidence": 0.3
}
```

Percentage thresholds must increase within the inclusive range from 1 to 100. The system warning threshold must be a positive safe integer.

Missing fields use defaults. Invalid JSON, invalid fields, or unreadable files cause a safe fallback to all defaults.

The meter reports invalid settings without exposing file contents. It does not overwrite an invalid file unless you run `save`.

Unknown keys never enter the saved file. Saving uses a temporary file and an atomic rename.

The `on` and `off` commands change only memory until `save`. Reload reads the saved defaults again.

### Next-move chip

The chip suggests the next move, for example `next: compact 0.99`. It is off until `nextMoveUrl` is set.

After each agent run, the meter sends one request to the decision server at `nextMoveUrl` with this state:

```json
{"context_used_pct": 82, "turns": 46, "last_tool_error": false, "last_user_message": "ok now also add the tests"}
```

The question is a `choice` over `continue`, `compact`, `handoff`, `commit` and `validate`. The number in the chip is the probability of the top answer.

| Setting | Meaning |
| --- | --- |
| `nextMoveUrl` | Full URL of a local decision server that answers a `choice` question. Use your server's port and path. Empty: off. |
| `nextMoveKeyEnv` | Name of the environment variable that holds the endpoint key. The key is never stored in the settings file. |
| `nextMoveTimeoutMs` | Request timeout. A late answer shows nothing. |
| `nextMoveMinConfidence` | Minimum margin between the top two answers (0 to 1). A less certain answer shows nothing. |

The call never blocks rendering. Timeouts, errors and low confidence show no chip. Compaction, tree changes and model changes clear the chip.

### Failure policy

The meter never retries a decision call and never loops. Each finished agent run allows at most one call.

| Rule | Behavior |
| --- | --- |
| Hard timeout | `nextMoveTimeoutMs` (default 150 ms) ends every call. |
| One in flight | A run that ends while a call is open makes no second call. |
| Cooldown | After a failed call (offline, timeout, HTTP error, bad body) the meter skips calls for 30 s. Each further failure doubles the pause, up to 10 minutes. One good answer clears it. A changed `nextMoveUrl` starts a clean record. |
| Shutdown | `session_shutdown` aborts the open call. |
| Render paths | `render()` and the footer never call the endpoint; they read the cached answer. |

An answer the confidence gate hides is not a failure. It does not start a cooldown.

`/context-meter report` shows the state on the `Next-move chip:` line: off, on, or `paused after N failed calls; next try in S s`.

### Switch: /tenantext-decisions

`/tenantext-decisions off` blocks every Tenantext call to a decision server. The meter clears the chip and makes no call until `on`. `status` or no argument shows the current state and whether `nextMoveUrl` is set.

The switch is the `decisions` key in `~/.pi/agent/tenantext/settings.json`. The command saves it at once, and the meter applies it without a restart through the `tenantext:decisions` event. The `/tenantext settings` menu offers the same switch as "Decision-server calls". The meter reads the saved value at session start, so the switch also holds when the main Tenantext extension is not loaded.
The operations footer shows the chip on the model row at 60 columns or more. The standalone meter shows it at 60 columns or more.

Check a server against labeled session states before you enable it:

```bash
TENANTEXT_NEXT_MOVE_KEY=... node --experimental-strip-types scripts/next-move-check.ts "<nextMoveUrl>"
```

Warning: the request contains the last 300 characters of your last message. Use a local decision server only. Do not point `nextMoveUrl` at a paid or remote service.

## Measurement and limits

The numerator comes from `ctx.getContextUsage().tokens`. The denominator comes from the active `ctx.model.contextWindow`, not a catalog constant.

Unknown usage or window values stay unknown. After compaction, Pi can report unknown usage until its next response.

The meter reads `buildSessionProjection()` during lifecycle events. This active projection includes compaction summaries and context edits, not the full historical transcript.

The `context_with_system` event supplies the request projection after earlier context handlers. The meter keeps only numeric category estimates.

The `before_provider_request` hook measures supported provider instruction fields:

- OpenAI-style `instructions`, plus system and developer messages in `input` or `messages`.
- Anthropic and Bedrock `system` text blocks.
- Google `systemInstruction`, including `config.systemInstruction`.

Supported payloads replace the Pi prompt fallback. The meter never adds both measurements together.

Identical instruction text across fields counts once. Serialized prompt patches count as instruction text, not as extra user prompts.

Forced system prompts and earlier chained changes appear in the serialized payload. Unsupported payloads use `ctx.getSystemPrompt()` instead.

Not verified by the API: changes from later `before_provider_request` handlers. Pi provides no final-payload observer after that chain.

Load the active meter consumer last to observe earlier payload changes. The report always states its measurement source and this load-order limit.

Text estimates use four characters per token. Each image contributes a fixed estimate of 1,024 tokens; the meter never tokenizes base64 data.

Image dimensions, provider tokenization, hidden reasoning, tool schemas, and message framing can change actual counts. Image estimates are not billing estimates.

The bar scales source estimates to Pi's current usage. It then uses largest-remainder allocation to assign every terminal cell.

Largest-remainder allocation gives leftover cells to the largest fractional shares. This keeps the displayed total consistent with the model window.

If usage exceeds the window, the bar clamps used space to the full width. The status still shows the actual percentage.

If source evidence is empty, the estimated prompt category receives the residual used space. The report labels all source values as estimates.

## Ownership and lifecycle

The standalone extension owns only the `context-meter` below-editor widget and command. It does not replace Pi's footer or Tenantext status segments.

`/tenantext context` remains the separate startup-source report. The context meter does not replace that analysis.

The operations footer imports `createContextMeter` from `extensions/context-meter/service.ts`. It does not import the standalone entry point.

Each consumer can create its own service. The service owns no widget, command, footer, timer, or network connection.

The ownership bus uses these events:

- `tenantext:ops-footer:ownership` carries `{ active: boolean }`.
- `tenantext:ops-footer:query` requests the current ownership state.

The standalone widget hides when operations-footer ownership becomes active. It returns only when ownership ends and the user enabled it.

The standalone extension queries ownership at session start. This supports either extension load order and separate extension API objects.

The service refreshes on session start, tree changes, message completion, turn completion, context projection, provider requests, compaction outcomes, and model changes.

It also refreshes when the agent ends or settles. Reload creates fresh state from the current session.

Shutdown removes service hooks, subscriptions, and the widget. Pi handles resize delivery through `render(width)`; the meter creates no resize listeners.

Rendering reads only cached numeric data and settings. It does not read files or scan session entries.

## Privacy

The meter makes no provider requests and starts no background work. It never writes messages, history entries, token histories, or measured values to model context.

Exception: when `nextMoveUrl` is set, the meter sends one request per agent run to that URL. The request holds the context percentage, the turn count, the last tool-error flag, and the last 300 characters of the last user message.

It discards prompt and message text after each event. Saved data contains only known user settings.

## Verification

Automated tests cover threshold boundaries, unknown values, source allocation, settings failures, active projections, compaction, context edits, model changes, and ownership.

Decision-call tests prove the bounds: 400 agent runs against a failing endpoint make one call; 10,000 runs over 28 hours make about 170 breaker admissions; `off` makes none; shutdown closes the open request.

They also cover cleanup, command persistence, report privacy, and repeated resizing. Width tests measure styled output directly with `visibleWidth()`.

| Tested width |
| --- |
| 0 |
| 1 |
| 8 |
| 12 |
| 20 |
| 30 |
| 40 |
| 50 |
| 80 |
| 120 |
| 200 |

Dynamic label tests include ANSI colors, combining marks, CJK text, and emoji.

For interactive checks without inference, test a mobile-width pane, full-screen zoom, repeated idle resizing, and local commands.

Not verified interactively: resizing during inference, live compaction, or model switching. Deterministic lifecycle tests cover compaction and model changes without provider requests.
