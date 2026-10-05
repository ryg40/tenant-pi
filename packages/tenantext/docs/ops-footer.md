# Operations footer

The operations footer replaces Pi's footer with stable status rows. It reads local session data and optional status sources without model calls.

## Rows and priorities

The footer is visual first. The prompt editor comes first. Below it sit the model row, the directory row, one full-width color bar, and quiet text rows. Each row appears only when it has something to say. This is layout v4, the default. No row sits above the editor. `/ops-footer layout v3` restores the earlier composition with the directory row and the bar above the editor; `/ops-footer layout v2` restores the bar-first v2 composition, all below the editor.

All rows are the Pi footer below the editor. Layout v4 sets no widget. In layout v3 the directory row and the bar are a Pi widget above the editor (`ops-footer-top`), and the model row is the first row below the editor.

| Row | Content | Present |
| --- | --- | --- |
| 1 Prompt editor | Pi's editor | Always |
| 2 Model | `example-provider/example-model · high` on the left: provider muted, model in text weight, thinking level bold. Usage and costs stay on the right | From 40 columns |
| 3 Location and repository | Directory name, branch, original `pwd`, changed `cwd`, and Git facts on the left. Right: agent state, `queued`, duration, session name, `@host`, and the `/ops-footer report` hint | From 40 columns |
| 4 Context bar | Proportional `sys`, `prompt`, `assistant`, `think`, `tools`, and `free` blocks; threshold markers; totals inside the bar | Always |
| 5 and later: Quota | One row per configured account: `Codex1`, `Codex2`, `Codex3`, then `Claude`, then `Copilot`. A Copilot-only machine has one Copilot row | When quotas exist and the row budget permits |
| Right of the quota rows: Memory | OpenViking connectivity and activity; LLM Wiki status, assigned model, and manual capture advice below it. In layout v3 this place is directly below the costs | When either integration is present |
| Last: Services and alerts | Failed or stale services, MCP problems, pending prompts, blocked work, reviews, deployments, flagged output, footer conflict | When it has content |

A healthy session with two Codex accounts shows five rows below the editor at 138 columns: model, directory, bar, `Codex1`, `Codex2`. Below 40 columns the footer shows one compact row and then the bar. Below 20 columns it shows the bar only.

Layout v3 holds the same rows with the same text. Its order is: directory row, bar, prompt editor, model row, then the quota, memory, and services rows.

### Information hierarchy

| Priority | State | Treatment |
| --- | --- | --- |
| 1 | Input request, model failure, blocked work, failed service | Bright error or warning text with a glyph: `⌨ input needed`, `✗ model error`, `⛔ 1 blocked`, `OV ✗ unavailable` |
| 2 | Thinking level | Bold: `warning` for `high` and `xhigh`, `accent` otherwise. The most distinct element, because the level drives spend and quality |
| 3 | Context pressure and quota pressure | Stage word and tinted free block inside the bar; amber or red quota chips with `⚠` or `✗` |
| 4 | Repository changes, divergence, multiple worktrees | Accent words: `2 staged · 4 modified · 1 untracked · ahead 3 · behind 2 · 3 worktrees` |
| 5 | Model name | Text weight, provider prefix muted; `working` and `compacting` in accent; `idle` dim; branch and chips muted |
| 6 | Healthy services, tool counts, host, session, diagnostics | Hidden, except the memory stack. `/ops-footer report` retains them |

### Context bar

The shared context service owns all estimates, thresholds, and the stage. The footer reads `state()` and draws; it computes no percentage of its own.

| Element | Meaning |
| --- | --- |
| Colored blocks | Share of the model window per source in one muted, even-luminance family (frost sys, sage prompt, blue assistant, lavender think, sand tools); saturated amber and red belong only to stages and alerts. The first cell of each block is one step lighter. Labels use the longest form that fits the block: `assistant`, `as`, or none |
| Dark free block | Remaining window in deep slate. Three slightly lighter bands begin at 60%, 75%, and 90%; inside a band every other cell is a faint step lighter |
| `▏` markers | The 60%, 75%, and 90% thresholds. Inside a used block the marker is dark; the crossed threshold stays visible |
| Right-aligned totals | `72.5k/272k 27%` in muted text. `PLAN 62%`, `WARN 78%`, or `CRIT 91%` replace the quiet form and tint the free block |
| `sys!` | The system prompt estimate reached the warning threshold. ` · sys 20.8k!` follows the totals when space permits |

The bar has no text legend. Guidance text stays in `/ops-footer report` and `/context-meter report`.

### Alerts

An alert appears only for actionable or threshold-crossed state. Steady healthy state has no `!N` counter, no `WARN` prefix, and no warning color.

| Rule | Behavior |
| --- | --- |
| Placement | Inline, next to its group: agent state on the directory row, quota chips on their account row, services on the last row. No row starts with an alert word |
| Signal | A word or glyph always accompanies the color: `✗`, `⚠`, `⏳`, `⛔`, `⌨` |
| Decay | An unchanged alert paints in the muted color after ten minutes. Its glyph and word remain |
| Row budget | `maximumRows` counts all rows (in layout v3: the rows above and below the editor). Model, location, and bar rows stay. Alert rows keep priority, followed by memory rows, then quiet quota rows; kept rows stay in display order. A `no login` quota row drops before other quota rows, and the last quota row shows `+N` for dropped accounts. A dropped alert, memory row, or quota displaced by memory adds `/ops-footer report` to the directory row |

### Quota rows

Each account has its own row. Labels pad to one width, and a relative reset before a later chip pads to one width, so the chips line up in columns across rows. An account without windows and without an error takes no row, except a configured Codex account that has no login.

Accounts appear in identity order: `Codex1`, then `Codex2`, then later Codex accounts, then `Claude` (short form `CL`), then `Copilot` (short form `CP`). An account appears only when this machine has it: a Codex account needs a `tokenFile` or a stored login, Claude needs an active Anthropic login that gives a reading, and Copilot needs a credential the usage endpoint accepts. Severity, remaining quota, reset time, route, and refresh order never reorder accounts. Every window of an account sits under its name.

| Chip | Fill | Text |
| --- | --- | --- |
| Normal | Calm teal, width equals remaining percent | `5h 80%` |
| Low, 25% or less | Amber | `⚠ 5h 20%` |
| Exhausted, 10% or less | Red, bright text | `✗ 5h 2%` |
| Unavailable | Dim, full width | `7d n/a` |

Without color, chips render as `[5h 80%]`.

A configured Codex account that has no login shows its label and `no login` in the dim style: `Codex3  no login`. It keeps its place in the identity order. It raises no alert and it does not change the state of the quota group. Two cases count as no login. In the first case, the `tokenFile` of the account exists, but its `access_token` or `account_id` is empty or null. In the second case, the account is in `codex-accounts/settings.json`, it has no `tokenFile`, and Pi has no stored login for it. An expired token is not this case: it keeps the last good reading and then shows an error chip. With no settings file, an account with no credential stays hidden.

#### Row budget for quota rows

`maximumRows` is the row budget. The location row, the bar and the model row always stay, so the other rows share `maximumRows` minus 3. The default is 8. It holds five quota rows: three Codex accounts, Claude and Copilot.

When the quota rows do not fit, these rules apply:

1. An account with an alert stays first.
2. A `no login` row drops before an account that has a reading.
3. The accounts that stay keep the identity order.
4. The last quota row that stays shows a dim `+N`. `N` is the count of accounts that are not shown.
5. `/ops-footer report` adds one line: `Quota rows not shown: <labels>`, with the value of `maximumRows`.

Example with `maximumRows` 6 and five accounts: the footer shows `Codex1`, `Codex2` and `Claude ... +2`. The report names `Codex3` and `Copilot`.

A settings file that holds `maximumRows` keeps its value. The default applies only when the key is absent. Set `maximumRows` to 8 in `~/.pi/agent/ops-footer/settings.json` to allow five quota rows.

Reset times are never raw ISO text. Every window shows a relative reset, such as `↺ 2h 47m`, when the row fits. A window with a reset at least 24 hours away also shows the local absolute form: `↺ 5d 7h · Sat 10/3 · 23:35 UTC`. On an account row this applies to every window, so a healthy `7d` window shows its reset date. The one-row quota of layout `v2` adds the absolute form only for a low or exhausted window. A row that is too narrow drops the absolute form first, then the resets of the normal windows.

Each row picks its own form. Candidates run from full account names with resets to short names `C1 C2`, then one window. Narrow rows prefer an alert window. Usage on the location row never displaces a quota chip.

`◂ routed` marks the row of the account that served the last gateway response. `route ✗` marks routing failure and `stale` marks an expired snapshot; both sit on the last Codex row that has a login. A quota reading expires at its lifetime, and not before two poll periods plus 33 seconds: the footer asks each source one time in a poll period, so one late or skipped poll shows no `stale`. The 33 seconds are 30 seconds for one fetch and a margin of 3 seconds. The Codex collection stops after 16 seconds, and a Claude or Copilot probe stops at its first request that times out (15 and 10 seconds). With the default `healthPollSeconds` of 60 the floor is 153 seconds. When the refresh stops, `stale` shows at the larger of the lifetime and the floor: 153 seconds after the last Codex reading with the default settings. Known limit: when the poll time of the Claude or Copilot source is equal to `healthPollSeconds`, a probe that takes over 33 seconds longer than the probe before it shows `stale` for some seconds. The Claude row and the Copilot row never carry the Codex route. Routing with no selected account and no failure shows nothing.

Whole rows move between layouts. Agent facts stay on the right of the directory row; usage and costs stay on the right of the model row.
In layout v3, Pi keeps widgets above the editor in the order extensions add them. A widget that another extension adds later can sit between the bar and the editor. Layout v4 has no widget, so this does not apply.

### Memory status stack

OpenViking sits on the right of the first quota row, below the bar (in layout v3: below session costs). LLM Wiki sits directly below OpenViking.
At 100 columns or more, these rows share space with quota accounts when both columns fit.
At narrower widths, memory gets separate right-aligned rows within `maximumRows`.
Layouts `v2`, `a`, `b`, and `c` include memory in their shared services row instead.

| Signal | Meaning |
| --- | --- |
| `OpenViking ✓ connected` | The extension reports connectivity, or the configured health check succeeds |
| `unavailable`, `warning`, `stale`, `unknown` | Failure, warning, expired evidence, or no connectivity evidence |
| `search running`, `read returned`, `remember failed` | Observed tool execution; concurrent calls show a count |
| `synced 3`, `pending 900/8.0k` | Validated counts from the published OpenViking status; session identifiers remain hidden |
| `LLM Wiki · active · example-provider/example-model` | Known wiki status and its published assigned model |
| `model unknown` | No valid `llm-wiki-model` label; the footer does not guess the configuration |
| `suggest wiki_retro` | Manual advice after a successful `write` or `edit`, or a wiki capture reminder |

A successful `wiki_observe` or `wiki_retro` clears the capture suggestion. Failed captures keep it.
The suggestion is a simple edit/reminder signal, not a judgment that the work contains a durable insight.
Ask the agent to run `wiki_retro` when the work warrants it. The footer never starts wiki tasks.
A session-model assignment follows the current session model. A configured assignment displays the published provider/model label.
With wiki notices disabled, the extension may publish no model label; the footer then shows `model unknown`.
`returned` means the tool call ended, not that detached indexing or synthesis completed.
Automatic recall and detached work have no complete public activity protocol; the footer does not invent their running state.

### Model and agent facts

Model identity and thinking appear on the model row, the first row below the editor. The agent facts appear right-aligned on the directory row, the second row below the editor. In layout v3 the directory row is above the editor.


| Fact | Shown when |
| --- | --- |
| `example-provider/example-model · high` | Always first. The provider prefix needs 80 columns; `off` thinking is hidden |
| `idle`, `working`, `compacting`, `⌨ input needed`, `✗ model error` | Always, right-aligned |
| `queued` | Pi reports pending messages |
| `27m` | The session is at least an hour old |
| Session name | The session has a name |
| `@hostname` | `SSH_CONNECTION` is set |

### Repository and usage facts

Repository facts appear on the directory row, below the model row. Usage and costs appear right-aligned on the model row, opposite the model. In layout v3 the repository facts are above the editor.


| Fact | Shown when |
| --- | --- |
| `pwd /home/dev/tenantext` | The original directory where Pi opened. It stays visible without a repository |
| `tenantext main` | A repository exists |
| `2 staged`, `4 modified`, `1 untracked`, `ahead 3`, `behind 2` | The value is not zero |
| `3 worktrees` | More than one worktree exists |
| `cwd ./sub/path` | The current directory differs from the original directory. It shortens to the repository root or `~` |
| `↑72.5k ↓5.8k R228k $0.478` | At 120 columns or more, right-aligned when space permits; zero values are hidden |

### Services row

| Group | Shown when |
| --- | --- |
| `OV ✗ unavailable`, `OK ⚠ stale` | The service failed or its check expired |
| `MCP 6/7 ✗ example-server`, `MCP 5/7 connecting` | A server failed or is missing |
| `⏳ 2 prompts`, `⛔ 1 blocked`, `⚠ 1 background`, `⚑ REVIEW`, `⚑ DEPLOY` | The published count is not zero or the flag is set |
| `STE 2 flagged` | The language guard flagged output |
| `⚠ footer conflict` | Powerline may also own the footer |
| `Wiki index building` | The index is building |
| `OK ✓  OV ✓  MCP 7/7 ✓` | Only with `showHealthyServices` |
| `Hermes · n/a` | Only with `showUnavailableOptionalSources` |

Tool counts, status counts, zero queues, and passing guards never appear in the footer.

### Width behavior

Each row builds candidates from verbose to terse and uses the first that fits. A very long directory path can be cut at narrow widths. The full paths remain in `/ops-footer report`.

| Terminal width | Display behavior |
| --- | --- |
| At least 120 | Full labels, usage and cost when space permits, provider prefix; healthy with two Codex accounts is five rows below the editor (v3: two rows above the editor and three below) |
| 80–119 | Provider prefix, full account names, no usage |
| 40–79 | Model without provider, state, bar, location, short account names `C1 C2`; one window per account when needed |
| 20–39 | One row, `main · idle` plus alert glyphs, then the bar (v3: the bar above the editor, the row below it) |
| Below 20 | Bar only; stage and percent inside it |

Each row stays within the exact width that Pi supplies. The renderer uses Pi's ANSI-aware width and truncation functions without word wrapping.

Set `NO_COLOR` or `TERM=dumb` to disable color. Blocks use `▓`, free space uses `·`, markers use `│`, and chips use brackets.

Use `/ops-footer report` for every value and source timestamp. The report keeps tokens, cache, cost, host, session, paths, worktrees, all windows with absolute resets, tool counts, status counts, routing, and freshness.

Layout v4 has the row texts of v3 in another order. Preview each layout with `node --experimental-strip-types scripts/footer-preview.ts --layout all` from the package directory.

## Enable the extension

1. Add `extensions/ops-footer/index.ts` as a Pi extension resource.
   The checkout must include the shared `extensions/context-meter/service.ts` module.
2. Disable other custom footer extensions.
   Pi permits only one owner of `ctx.ui.setFooter()`.
3. Reload Pi.
   The footer announces ownership after the session starts.

Only the selected entry point needs to load. The standalone context-meter entry point is optional.

The Codex provider entry point is also optional. Without it, the footer still shows session, context, repository, and integration state.

Warning: Powerline and this extension can replace each other's footer.

Pi cannot return the previous custom footer factory. `/ops-footer off` restores Pi's default footer, not Powerline's footer.

The extension checks supported command provenance and the known `powerline` status key for conflicts. Pi exposes no universal custom-footer ownership query.

This extension does not replace Powerline's editor, stash, bash mode, welcome display, or queue storage.

## Commands

| Command | Result |
| --- | --- |
| `/ops-footer` | Shows the detailed local report |
| `/ops-footer report` | Shows the same report |
| `/ops-footer on` | Enables the footer and collectors for this session |
| `/ops-footer off` | Restores the default footer and stops external collectors |
| `/ops-footer refresh` | Refreshes enabled external collectors |
| `/ops-footer settings` | Shows current settings without endpoint values; `/tenantext settings` opens the interactive editor |
| `/ops-footer save` | Saves current display defaults |
| `/ops-footer layout v4\|v3\|v2\|a\|b\|c` | Switches the row composition for this session only: `v4` is the default with every row below the editor, `v3` puts the directory row and the bar above the editor, `v2` is the bar-first footer, `a`, `b`, and `c` are alternate layouts available through the preview command |
| `/ops-footer help` | Shows command help |

Reports use local UI notifications. They do not create session entries or model context.

## Settings

The default file is `~/.pi/agent/ops-footer/settings.json`. Pi's public `getAgentDir()` also honors `PI_CODING_AGENT_DIR` for isolated profiles. Startup fills a missing or blank file with the defaults below. It writes `settings.example.jsonc` beside it with commented option names and allowed values. Existing nonempty files and examples remain unchanged. The main settings file under `~/.pi/agent/tenantext/` follows the same rule.

```json
{
  "enabled": true,
  "placement": "belowEditor",
  "minimumRows": 1,
  "maximumRows": 8,
  "healthPollSeconds": 60,
  "healthTimeoutMs": 2000,
  "gitCacheMs": 1000,
  "gitIdlePollSeconds": 15,
  "showHealthyServices": false,
  "showUnavailableOptionalSources": false,
  "healthUrls": {}
}
```

`placement` describes the footer location below the editor. Layout v4, the default, puts every row there. Layout v3 also adds the directory and bar widget above the editor; the setting does not move it.

`minimumRows` pads with blank rows only when the content has fewer rows. The default of 1 never pads.

| Setting | Allowed range |
| --- | --- |
| minimumRows | 1–12, no more than maximumRows |
| maximumRows | 3–12 |
| healthPollSeconds | 10–3600 seconds |
| healthTimeoutMs | 100–10000 milliseconds |
| gitCacheMs | 250–60000 milliseconds; the Git poll interval during an agent turn |
| gitIdlePollSeconds | 2–3600 seconds; the Git poll interval while the agent is idle |

1. Run `/tenantext settings` in an interactive Pi session.
   The menu lists main rules, guard, footer display options, polling limits, and optional health URLs.
2. Select a setting and choose or enter a value.
   The menu checks the value, saves it to valid JSON, and applies it without a Pi restart.

You can also edit the local JSON files manually. Copy options from the commented `settings.example.jsonc` files without copying comments. Reload Pi after manual edits. `/ops-footer save` preserves existing local endpoint settings. Environment endpoint values never enter saved settings.

## Read-only health checks

Set `healthUrls.OK` and `healthUrls.OV` in the local settings file. Alternatively, use these environment variables:

```bash
export OPS_FOOTER_OK_HEALTH_URL=http://127.0.0.1:4317/readyz
export OPS_FOOTER_OV_HEALTH_URL=http://127.0.0.1:1933/health
```

These values are examples. Use the read-only health URLs of your own services.

Checks use GET requests with a short timeout. They reject redirects and URLs with user information, queries, or fragments.

Checks send no Authorization header. Configure a safe local health endpoint when the remote service requires authentication.

The extension never reads OAuth credentials. It never prints response bodies, headers, endpoint values, or raw error messages.

A successful response proves endpoint accessibility only. Tool presence never proves service accessibility.

A failure appears after the next poll finishes, within one poll interval plus the configured timeout. Polling stops when the footer turns off.

## Public source contracts

Adapters return small in-memory snapshots:

```typescript
interface StatusSnapshot {
  state: "ok" | "warning" | "error" | "unknown";
  summary: string;
  details?: string[];
  checkedAt: number;
  staleAfter: number;
}
```

`checkedAt` uses epoch milliseconds. `staleAfter` is the lifetime in milliseconds.

The footer caps a lifetime from the bus: two hours for a quota source (Codex, Claude, Copilot), which is two times the longest poll time of a source, and one hour for the other sources. For a quota source the footer also applies its own floor, `2 x healthPollSeconds + 33` seconds.

### Integrations and work

Publish structured data on `tenantext:ops-footer:status`:

```typescript
pi.events.emit("tenantext:ops-footer:status", {
  source: "MCP",
  state: "warning",
  checkedAt: Date.now(),
  staleAfter: 60000,
  active: 6,
  configured: 7,
  failed: 1,
  failedNames: ["example-server"]
});
```

| Source | Accepted optional fields |
| --- | --- |
| MCP | active, configured, failed, failedNames |
| OK, OV | state and freshness |
| Wiki | index: ready, building, or unknown |
| Hermes | state and freshness |
| work | working, blocked, done, prompts, background, dirty, review, deploy |

Counts must be finite, non-negative integers within the adapter limit. `review` and `deploy` must be booleans.

`summary`, `details`, and unknown fields never enter the display. State values use a fixed vocabulary.

Failed MCP names require a local allow-list in `OPS_FOOTER_MCP_NAMES`. Use comma-separated simple names, not credentials or URLs.

```bash
export OPS_FOOTER_MCP_NAMES=example-server,local-memory
```

MCP counts come only from published data. The presence of an `mcp` tool does not supply server counts.

The footer accepts exact state tokens from known public status keys:

| Status key | Source |
| --- | --- |
| openknowledge | OK |
| openviking | OV |
| llm-wiki | Wiki |
| hermes-memory | Hermes |

Accepted tokens are `ok`, `warning`, `error`, and `unknown`.

The verified OpenViking prefixes `OV ✓` and `OV ✗` also supply health. A separate adapter accepts only known numeric counters.
It discards the trailing session identifier and all unrecognized prose.
Known LLM Wiki status forms supply activity labels, and `llm-wiki-model` supplies a validated model label.

Unchanged status text does not reset freshness. Changed OpenViking counters refresh the legacy publication timestamp. Structured publications should include timestamps when the source needs reliable freshness.

Configured health checks override bus state for their source. Bus state overrides legacy public status text.

### Codex limits

The footer consumes `tenantext:codex:status` from the account extension. It requests `tenantext:codex:refresh` after start, on manual refresh, and during bounded polling.

The footer never imports provider registration code. It reads only the shared snapshot type.

Account labels, window labels, reset timestamps, percentages, and routing fields pass strict validation. Arbitrary provider messages never enter the display.

Window labels must be a duration of one to three digits with `m`, `h`, or `d`, or one of `week`, `weekly`, and `daily`. Any other label, including the slot names `primary` and `secondary`, shows as `window`. The footer does not map a slot to a duration. The account plan passes only when it is one of the normalized Codex plan values. The footer row does not show the plan. The detailed report adds `plan:<value>` to the account line.

A valid selected account remains visible when routing health is unknown. This permits header-derived routing evidence without a gateway status endpoint.

The `login` field passes only as the literal `false`. Then the account has no windows, the row shows `no login`, and the detailed report shows `<label>: no login`.

Stale quotas show `stale`. Unavailable windows show `n/a` on a dim chip. Reset timestamps become epoch values and render as relative or friendly local text.

### Anthropic limits

The footer consumes `tenantext:anthropic:status` from `anthropic-usage` and requests `tenantext:anthropic:refresh` with the Codex refresh. The adapter accepts only the window labels `5h`, `7d`, `opus`, and `sonnet`, numeric percents, an ISO reset time, the source ids `claude-code` and `pi`, and the plan values `free`, `pro`, `max`, `team`, and `enterprise`. An `absent` snapshot, or a snapshot with no valid window, removes the `Claude` group. An `unknown` snapshot holds the last good reading after a failed request: the row stays and shows no error chip. The detailed report adds `ANTHROPIC` freshness, the source, the plan, and each window with its reset time. See [Anthropic usage](anthropic-usage.md).

### Copilot limits

The footer consumes `tenantext:copilot:status` from `copilot-usage` and requests `tenantext:copilot:refresh` with the Codex refresh. The adapter accepts only the window labels `premium`, `chat`, and `compl`, numeric percents and counts, an ISO reset time, the source id, and the plan id. An `absent` snapshot, or a plan whose every quota is unlimited, removes the Copilot group. The detailed report adds `COPILOT` freshness, the source, the plan, and used against entitlement per window.

### Context ownership

The footer publishes `tenantext:ops-footer:ownership` with `{ active: boolean }`. It answers `tenantext:ops-footer:query` with its current ownership.

The standalone context widget hides while the footer owns context presentation. It restores its previous enabled state when ownership ends.

## Collection and lifecycle

Git collection runs asynchronously in the current working directory. It uses porcelain status, repository-root lookup, and NUL-delimited worktree discovery.

Git does not fetch or scan other repositories. The worktree total comes from the current repository's worktree list.

The footer shows current-worktree identity. Dirty counts for other worktrees remain unavailable unless a work source publishes them.

Git requests coalesce while collection runs. A request during a collection queues one forced follow-up. Processes have time and output limits, and shutdown kills active Git processes.

During an agent turn, Git polls at `gitCacheMs`. While the agent is idle, Git polls every `gitIdlePollSeconds`. `agent_settled`, a branch change, and `/ops-footer refresh` refresh Git at once; `tool_execution_end` refreshes it when the cache time has passed.

A forced refresh, a new cwd, a failed collection, or 60 seconds since the last full lookup runs all three Git commands. Other polls run only `git status`.

Git cache expiry starts refresh. The freshness lifetime covers the slower poll interval plus timeout and scheduling allowance to prevent a stale-label flash during normal refresh.

Failures preserve the previous successful Git timestamp and values. The row shows the collection failure instead of claiming healthy cached state.

Events refresh agent, prompt-waiting, compaction, model, thinking, session-name, message, tool, and tree state.

Pi exposes only a boolean pending-message API to extensions. The footer shows `pending` or `none` unless a work source publishes a numeric count.

Pi does not expose retry-backoff events to extensions. The footer keeps `working` until `agent_settled`; it does not invent retry state.

Usage totals include assistant, nested tool, compaction, branch-summary, and usage entries on the active session branch. Cost is reported cost, not inferred subscription billing.

Render calls perform no network or Git work. Width and state-version caching keeps rendering synchronous.

Pi repaints the full screen for each render request. The footer composes its rows at the last painted width and requests a render only when a row changes. Time text, such as the session duration, changes at its display step, so an idle footer requests about one render each minute.

Shutdown removes event listeners, timers, context subscriptions, and footer subscriptions. The extension writes no telemetry history.

## Verification

1. Run the focused tests.
   They exercise real ANSI width helpers, adapters, lifecycle mocks, and temporary Git repositories.

```bash
node --experimental-strip-types --no-warnings --test test/ops-footer.test.ts test/footer-memory.test.ts
```

2. Run the suite tests.
   The complete suite needs a timeout longer than a minute.

```bash
npm test
npm run typecheck
```

Not verified: live Herdr mobile/full-screen resize, streaming, compaction, and model switching.
