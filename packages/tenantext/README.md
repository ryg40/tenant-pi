# tenantext

Tenantext provides Pi extensions, skills and a Claude Code plugin. **slopscore** measures model effort and Git provenance from local traces and repository history. See [slopscore](#slopscore) for the scoring rules and commands.

Nine Pi extensions form the installable suite. Each extension can also load alone. A Claude Code plugin lives under `claude-code/`.

- **tenantext**: Simplified English output rules, a startup guard, and a context report.
- **slopscore**: Trace-based spend, model effort, Git provenance, PR reports, and OKF checks.
- **codex-accounts**: Isolated Codex OAuth accounts, subscription limits, and optional LiteLLM automatic routing.
- **context-meter**: Full-width context-source visualization, transition guidance, and system-prompt warnings.
- **ops-footer**: A multi-row session dashboard with context, quotas, Git worktrees, and integration health.
- **copilot-usage**: A GitHub Copilot quota meter that finds a local credential by itself and feeds the footer.
- **anthropic-usage**: An Anthropic subscription quota meter that reads an active Claude Code or Pi login and feeds the footer.
- **doctor**: `/tenantext-doctor` checks what this machine has and writes the matching settings.
- **resources**: `/resources` lists extensions, skills, prompts and MCP servers, with enable controls and saved profiles.

The suite also ships the **tracker-site** skill: restart briefs that tell you where a repository stands after a long session or days away. It is a Python package in `tracker/`, not a Pi extension.

The suite also ships the **herdr** skill: one skill for Claude Code and Pi that controls [Herdr](https://herdr.dev) panes. It uses an agent pane that exists, or starts a new agent from four inputs: harness, role, model and thinking level. See [Herdr skill](#herdr-skill).

The tenantext extension has three functions:

1. **Simplified English output.** Prepends an adapted ASD-STE001 rule block to the system prompt on every turn. The model writes one idea per sentence, active voice, present tense, one meaning per word, no greetings, apologies, closings or filler, and Markdown that pastes cleanly into notes.
2. **Startup guard.** Pi never calls the model before the first prompt. The guard keeps it that way when other extensions inject prompts, and it flags any provider request that happens before a human prompt.
3. **Context report.** `/tenantext context` shows where the first request's tokens come from: core prompt, skills listing, context files, other extensions, and tenantext itself.

## Requirements

| Piece | Version |
| --- | --- |
| Node | `>=22.22.0 <23` |
| Pi (`@earendil-works/pi-coding-agent`) | `runtime.piVersion` in `../../config/manifest.json`; runtime qualification remains incomplete |

No build step. Pi loads the TypeScript resource entry points directly.

## Install

### Enable kit components

This package lives at `packages/tenantext` inside the tenant-pi kit, not in a separate repository.
Follow the [kit installation guide](../../INSTALL.md) and [module guide](../../docs/guides/modules.md) to enable components through the kit generator.
The generator writes one package entry with the absolute package path and filters for the selected components.
Keep the kit checkout in place; regenerate the profile if you move it.

Install the package dependencies from the kit root before loading its components:

```sh
cd packages/tenantext
npm ci --ignore-scripts
```

Observed with Pi 0.99.1: a generated profile loads the components tested on that version after dependency installation.
Not verified: loading all selectable components with the kit pin, or on a clean client.
See [package tests and qualification limits](../../docs/packages.md#tenantext-packagestenantext).
No direct Git-subdirectory `pi install` command is verified for this kit.

Unless stated otherwise, paths and shell commands below are relative to `packages/tenantext`.

The suite loads these stable resources:

| Extension | Resource path |
| --- | --- |
| tenantext | `extensions/tenantext/index.ts` |
| slopscore | `extensions/slopscore/index.ts` |
| codex-accounts | `extensions/codex-accounts/index.ts` |
| context-meter | `extensions/context-meter/index.ts` |
| ops-footer | `extensions/ops-footer/index.ts` |
| copilot-usage | `extensions/copilot-usage/index.ts` |
| anthropic-usage | `extensions/anthropic-usage/index.ts` |
| doctor | `extensions/doctor/index.ts` |
| resources | `extensions/resources/index.ts` |
| slopscore-pr skill | `skills/slopscore-pr/SKILL.md` |
| herdr skill | `skills/herdr/SKILL.md` |
| coordinator skills (the table in [skills/coordinator-skills/README.md](skills/coordinator-skills/README.md)) | `skills/coordinator-skills/<skill>/SKILL.md` |
| knowledge skills (the table in [skills/knowledge-skills/README.md](skills/knowledge-skills/README.md)) | `skills/knowledge-skills/<skill>/SKILL.md` |

When the enabled extension loads, its status shows `STE on · guard armed` until the first prompt.

### First run on a new machine

Every default is generic. Nothing names a host, an account, or a service. Meters appear only for what the machine has:

| Meter | Shown when |
| --- | --- |
| Codex | An `openai-codex` or `openai-codex-N` login exists in Pi's `auth.json` |
| Copilot | Pi has a Copilot provider: a `github-copilot` login, `COPILOT_GITHUB_TOKEN`, or a `github-copilot` default provider or enabled model (see [Copilot usage](docs/copilot-usage.md)) |
| Claude | An active Anthropic subscription login exists: the Claude Code login file or a Pi `anthropic` OAuth login (see [Anthropic usage](docs/anthropic-usage.md)) |
| Health (OK, OV) | A health URL is set in the footer settings or the environment |
| Codex automatic routing | `TENANTEXT_LITELLM_BASE_URL` is set |

Then run the doctor:

```sh
npm run doctor            # from packages/tenantext: check packages, peers, logins, meters
npm run doctor -- --fix   # write the detected settings (existing files are copied to .bak first)
```

Inside Pi, `/tenantext-doctor` runs the same checks and `/tenantext-doctor fix` applies them. Run `/reload` after a fix.

### One extension

Select the component in the kit overlay and generate a profile, as described in the [module guide](../../docs/guides/modules.md#change-a-selection).
The generated package entry filters extensions and skills separately.
Keep the full package directory: entry points can import shared files.
Do not also register a second copy of the package in the same profile.

To stop loading a component, remove it from `selection.enable`, add it to `selection.disable`, and generate a new profile.
Saved Tenantext state remains in the previous profile.
Tenantext uses `tenantext/settings.json` relative to the profile's Pi agent directory.

## Commands

| Command | Effect |
| --- | --- |
| `/tenantext` | Status: rules, guard, flagged events, request count, settings path |
| `/tenantext on`, `/tenantext off` | Language rules for this session |
| `/tenantext guard on`, `/tenantext guard off` | Startup guard for this session |
| `/tenantext settings` | Interactive TUI menu for main and footer settings; changes save and apply now |
| `/tenantext-decisions on`, `off`, `status` | Allow or block calls to a decision server that answers a `choice` question at `nextMoveUrl`; saved and applied immediately |
| `/tenantext save` | Store the current on/off states as defaults for new sessions |
| `/tenantext context` | Startup context report by source (Markdown table) |
| `/tenantext rules` | Print the rule block sent to the model |
| `/tenantext help` | Command table |

Defaults: rules on, guard on.

## The language rules

The block lives in `src/rules.ts` and costs about 450 tokens per turn. The text is stable, so provider prompt caching absorbs it after the first request.

The block goes at the start of the system prompt, before Pi's own prompt and the skills listing. It ends with a short answer template to show the requested layout. Not verified: consistent adherence across models and prompt lengths.

Changes from ASD-STE001:

| STE rule | tenantext adaptation | Reason |
| --- | --- | --- |
| Approved dictionary of about 900 words | "Use the simplest common word. One meaning per word." | A fixed dictionary does not fit non-technical subjects |
| Technical names allowed as-is | Code identifiers, paths, commands, product names and quotes stay verbatim | Same principle, wider scope |
| 20 words procedural, 25 descriptive | Kept | |
| Active voice, present tense | Kept | |
| One instruction per sentence, warning before the step | Kept | |
| No rule on pleasantries | No greetings, thanks, apologies, praise, closings, offers of help, process commentary | The token and attention cost the extension exists to remove |
| No rule on layout | Markdown: `##` headings for explanation and steps, ordered lists for steps with one reason sentence each, tables for comparisons, fenced code for commands and errors, a `Warning:` line for risks | Copy-paste into notes and documents |

Print the current block with `/tenantext rules`.

## The guard

Observed with Pi 0.85.1: the guard relies on these lifecycle behaviors. Not verified on the kit pin: these lifecycle behaviors.

- Pi's lifecycle sends no provider request before the first prompt. The footer figure at startup is a local estimate of context size, not spend.
- Extensions can start a run with `pi.sendUserMessage` (goes through the `input` event with `source: "extension"`) or `pi.sendMessage({triggerTurn: true})`.

Behaviour:

| Event | Guard action |
| --- | --- |
| `input` with source `interactive` or `rpc` | Marks the session as human-initiated |
| `input` with source `extension` before that | Blocked with `{ action: "handled" }`, a warning, and a session note |
| `agent_start` with no prior human input | Counted as an unverified run and warned. This is the only signal for `pi.sendMessage({ triggerTurn: true })`, which bypasses the `input` event, so that path is detect-only |
| `before_provider_request` before a human prompt | Counted and warned |

Flagged counts show in the footer status and in `/tenantext`. Nothing is blocked after the first human prompt. A resumed session with a user message in its branch starts as passed. A CLI argument prompt and print mode arrive as `interactive` input.

`/tenantext guard off` stops both blocking and counting for the session. An RPC host that drives Pi only through an extension's `sendUserMessage`, with no `rpc` prompt first, is blocked until it turns the guard off.

## The context report

`/tenantext context` prints a Markdown table:

| Row | Source |
| --- | --- |
| Core prompt + tool guidance | Pi's built-in prompt minus the parts below |
| Skills listing | Every skill visible to the model: name, description, path |
| Context files | `AGENTS.md` and other loaded context files, with per-file sizes |
| Prompt guidelines, `--append-system-prompt` | As configured |
| Other extensions (last turn) | System prompt additions by earlier-loaded extensions, measured on the last turn |
| tenantext rules | This extension's block |
| First request, actual input | Provider-reported input tokens of the first reply in the session |

Estimates use 4 characters per token, the same heuristic Pi uses. The skills row uses Pi's own formatter, so it is exact in characters. The base prompt is captured before the first turn; run `/reload` after changing skills or tools to refresh it. The report also lists the five longest skill descriptions, the usual first thing to trim.

## Codex accounts

`codex-accounts` keeps the primary Codex login on Pi's built-in `openai-codex` provider. It registers each additional account as a separate provider.

The default accounts are:

| Account | Provider |
| --- | --- |
| Codex 1 | `openai-codex` |
| Codex 2 | `openai-codex-2` |
| Codex 3 | `openai-codex-3` |

Secondary providers copy Pi's current built-in Codex model catalog during startup. A Pi model-catalog update therefore adds models such as Astra without a second hand-maintained list.

Commands:

| Command | Effect |
| --- | --- |
| `/codex-accounts` | Fetch and display all configured Codex limits |
| `/codex-accounts limits` | Same limit report |
| `/codex-accounts providers` | Show provider IDs and authentication state |
| `/codex-accounts routing` | Show gateway configuration and the last reported route |
| `/codex-accounts help` | Show command help |

Each account shows only the windows that its usage response reports. The window label comes from the reported duration, not from the account or the response slot. A weekly-only Pro account shows one `7d` chip. A Plus account shows `5h` and `7d`. Two weekly-only Pro accounts therefore show one `7d` chip on each account row. The limits report adds a Plan column from an allowlist. An unlisted plan shows `unrecognized`; a missing plan shows `not reported`.

Limit requests run on command, or when the enabled operations footer requests a refresh.
The shared collector coalesces requests and caches results. It never refreshes OAuth credentials.
Expired credentials need provider-owned refresh or login. Reports show no token or account ID.

Automatic routes use the optional `litellm-codex` provider. Set `TENANTEXT_LITELLM_BASE_URL` outside Git.
Supply `TENANTEXT_LITELLM_API_KEY`, or save a separate gateway API key in Pi's credential storage.
The supported model IDs are `codex-auto/luna`, `codex-auto/sol`, and `codex-auto/astra`.
GPT-6 Terra is excluded because ChatGPT Codex rejects `gpt-6-terra` for subscription accounts.
Each request sends complete active history. The gateway applies its own account policy and can fall back once.
Fallback cannot succeed when both accounts are exhausted.
See [Codex routing](docs/codex-routing.md) for configuration, explicit account routes, and verification limits.

To change the account list, create `codex-accounts/settings.json` in the profile's Pi agent directory.
This example adds a fourth account:

```json
{
  "accounts": [
    { "provider": "openai-codex", "label": "Codex 1" },
    { "provider": "openai-codex-2", "label": "Codex 2" },
    { "provider": "openai-codex-3", "label": "Codex 3" },
    { "provider": "openai-codex-4", "label": "Codex 4" }
  ]
}
```

Run `/reload`, then use `/login` for the new provider. Complete browser logins serially because Codex OAuth uses one local callback port.

Use a private browser profile for each additional login. The extension rejects a login or refresh that resolves to another configured account.

Warning: Remove any separate `extensions/openai-codex-2.ts` package entry before enabling `codex-accounts`. Both extensions register the same provider ID.

When a gateway such as LiteLLM owns the Codex logins, Pi does not need its own login for the meter.
Set `tokenFile` on each account to the gateway's auth file for that account:

```json
{
  "accounts": [
    { "provider": "openai-codex", "label": "Codex 1", "tokenFile": "/path/to/gateway/state/codex1/auth.json" },
    { "provider": "openai-codex-2", "label": "Codex 2", "tokenFile": "/path/to/gateway/state/codex2/auth.json" }
  ]
}
```

The meter reads the access token and account ID from that file and ignores the Pi login for that account.
It accepts the LiteLLM layout (`access_token`, `account_id`) and the Codex CLI layout (`tokens.access_token`, `tokens.account_id`).
The file is read-only for Pi; the gateway refreshes and rewrites it.
A missing file hides that account's meter.
A gateway refreshes its token only when a request goes through, so an idle gateway's token can expire.
Then the meter keeps the last good reading, without an error chip, for up to 24 hours or until a window resets.
After that, or for an unreadable file with no earlier reading, the meter shows an error chip.

Warning: A `tokenFile` gives Pi read access to a live OAuth access token. Keep the file mode `0600` and owned by the Pi user.

The footer shows only accounts that have a token file or a stored login on this machine. A default account that was never logged in stays hidden instead of showing an error chip.
An account that you list in the settings file is different. When it has no login, the footer shows its label and `no login` in the dim style, with no alert. The same text shows when the `tokenFile` of an account exists but its `access_token` or `account_id` is empty or null. An expired token is not `no login`: the rules above apply to it. `/tenantext-doctor fix` writes the settings file when it finds more logins than the file lists.

The quota code is a Codex-only hard fork of `@latentminds/pi-quotas`. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Copilot usage

`copilot-usage` reads GitHub Copilot quota from `GET https://api.github.com/copilot_internal/user` and publishes it to the footer as a `Copilot` account after the Codex accounts. It needs no settings.

It turns on only when Pi has a Copilot provider configured: a `github-copilot` login (`/login github-copilot`), Pi's `COPILOT_GITHUB_TOKEN` variable, or a `github-copilot` default provider or enabled model in Pi's `settings.json`. A general GitHub token (`GH_TOKEN`, `GITHUB_TOKEN`, `gh`) never turns it on by itself, because every GitHub account carries free-tier Copilot. Without a provider, the meter sends no request.

With a provider configured, it tries local credentials in this order and keeps the first one the endpoint accepts:

1. Pi's own `github-copilot` login (`/login github-copilot`), including GitHub Enterprise domains.
2. `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.
3. Copilot editor plugin files: `~/.config/github-copilot/apps.json` or `hosts.json` (Vim, Neovim, JetBrains, Xcode).
4. The Copilot CLI fallback file `~/.copilot/config.json`.
5. `gh auth token` (the macOS keychain login of the GitHub CLI).

Paid plans show `premium 83%`. The free plan shows `chat` and `compl`. Unlimited quotas stay hidden. A low premium quota turns amber with its reset time, like a Codex window.

| Command | Effect |
| --- | --- |
| `/copilot-usage` | Probe the sources and show quota, plan, and the source in use |
| `/copilot-usage refresh` | Same, and update the footer |

Tokens never leave the request header. Reports name the source, not the value. See [Copilot usage](docs/copilot-usage.md) for settings and failure rules.

## Anthropic usage

`anthropic-usage` reads the Anthropic subscription quota from `GET https://api.anthropic.com/api/oauth/usage` and publishes it to the footer as a `Claude` account after the Codex accounts and before Copilot. It needs no settings.

It uses the first active login from these sources:

1. The Claude Code login file `~/.claude/.credentials.json` (or under `CLAUDE_CONFIG_DIR`).
2. Pi's own `anthropic` OAuth login.

The extension only reads. It never refreshes a token and never writes a file. An expired login, an absent login and an API key give no row.

The row shows `5h` and `7d`, and `opus` and `sonnet` when the response has them. Each chip is the remaining percent.

| Command | Effect |
| --- | --- |
| `/anthropic-usage` | Probe the sources and show the windows, the plan, and the source in use |
| `/anthropic-usage refresh` | Same, and update the footer |

The token never leaves the request header. Reports name the source, not the value. Not verified: a live request from this extension inside Pi. See [Anthropic usage](docs/anthropic-usage.md) for settings, failure rules and the verification state.

## Doctor

`/tenantext-doctor` (or `npm run doctor` from `packages/tenantext`) reports checks with `✓`, `·`, `⚠`, or `✗`. The shell doctor also checks package wiring, duplicate local Tenantext copies, and peer packages. `fix` writes only what it detected: the Pi package entry, peer package links, the Codex account list, and the Copilot source order. It copies an existing file to `<file>.bak` first and never prints a credential.

The wiki checks read global `settings.json` and project `.pi/settings.json`. Nonempty project embedding settings win.
They read only endpoint fields from `OPENVIKING_URL`, `OPENVIKING_BASE_URL`, `OPENVIKING_MCP_URL`, and OV configuration files.
The file paths come from `OPENVIKING_CLI_CONFIG_FILE`, `OPENVIKING_CONFIG_FILE`, and `~/.openviking/{ovcli.conf,ov.conf}`.
They compare host and effective port, not URL paths. Missing or unreadable OV files contribute no endpoint.
The module check uses the profile's OpenViking package declarations and extension filters, including project overrides.
These checks make no network request, access no credential field, and supply no automatic fix.

| Diagnostic | Level | Meaning |
| --- | --- | --- |
| `wiki_embeddings_on` | info | `embeddingProvider` is set. Reports model and host only, not authentication or endpoint health. |
| `wiki_embeddings_shared_endpoint` | warn | Wiki embeddings share a host and port with a readable OV endpoint, or the `openviking` module is enabled. |

See [Switch wiki embeddings off](../../docs/memory-modules.md#switch-wiki-embeddings-off) for the keys to remove and the restart check.
Neither diagnostic appears when `embeddingProvider` is absent. An independent endpoint without the module gives only the info line.

## Operations dashboard and context meter

The complete suite enables the operations dashboard. It embeds the context meter and hides the standalone context widget.
Disabling the dashboard restores Pi's default footer and the enabled standalone widget.

Warning: Only one extension can own `ctx.ui.setFooter()`. Disable `pi-powerline-footer` before using `ops-footer`.

Settings paths below are relative to the profile's Pi agent directory.

| Resource | Commands | Settings |
| --- | --- | --- |
| Context meter | `/context-meter`, `on`, `off`, `save`, `help` | `context-meter/settings.json` |
| Operations footer | `/ops-footer`, `on`, `off`, `refresh`, `settings`, `save`, `help` | `ops-footer/settings.json` |

The suite fills missing or blank main and footer settings files with valid JSON. Each folder also receives `settings.example.jsonc` with commented option names, allowed values, and examples. Existing nonempty files stay unchanged. `/tenantext settings` edits both sets of options in the TUI. The menu validates row limits, poll times, and health URLs before saving. Environment health URLs remain overrides and never enter the saved file.

The footer follows the nano-context visual language. This text sample uses layout v4, with all footer rows below the editor:

```text
> (prompt editor)
example-provider/example-model · high                   ↑72.5k ↓5.8k R228k $0.478
demo main · pwd ~/git/demo                                          idle · 27m
sys pr as th   tools          free       ▏          ▏          ▏      72.5k/272k 27%
Codex1 [5h 80%] ↺ 2h 47m  [7d 80%] ↺ 6d 22h   OpenViking ✓ connected · idle
Codex2 [5h 60%] ↺ 35m  [7d 60%] ◂ routed   LLM Wiki · example-model · suggest wiki_retro
```

The directory name is bold; the branch, worktree count, and path are dim. The row shows the directory where Pi opened, even without a repository, and `cwd` when the current directory changes. A machine with only Copilot shows one `Copilot` row. `◂ routed` marks the account that served the last gateway response.

OpenViking shows connectivity and observed tool activity. LLM Wiki shows its published assigned model and manual capture advice after edits. Successful `wiki_observe` or `wiki_retro` clears the advice; the footer never starts tasks. Missing model labels show `model unknown`. Narrow screens put memory on separate rows within the row budget. `/ops-footer report` retains hidden details.

The bar divides the active model window into system, prompt, assistant, thinking, tool-result, and free blocks.
Block width encodes share. Thin markers sit at 60%, 75%, and 90%. Totals sit inside the bar.
Source sizes are estimates. Pi's current context usage sets the total used size.

| Threshold | Bar | Action |
| --- | --- | --- |
| Below 60% | Muted totals `72.5k/272k 27%` | Continue normally |
| 60% | `PLAN 62%`, free block tinted blue | Finish the current unit and prepare a handoff |
| 75% | `WARN 78%`, free block tinted amber | Start a new session or compact |
| 90% | `CRIT 91%`, free block tinted red | Stop adding large context and transition |
| System prompt at 10,000 estimated tokens | `sys!` label and ` · sys 20.8k!` | Reduce startup prompt size |

Information hierarchy, from loudest to quietest:

1. Input requests, model failures, blocked work, and failed services: bright text with a glyph, such as `⌨ input needed` or `OV ✗ unavailable`.
2. Context and quota pressure: stage words in the bar; amber `⚠ 5h 20%` and red `✗ 5h 2%` quota chips.
3. Repository changes: accent words such as `2 staged · 4 modified · ahead 3`, and `3 worktrees`.
4. Model, branch, and work state: muted text.
5. Healthy memory services: visible in the right-hand stack. Other healthy services and diagnostics stay in `/ops-footer report`.

Alert rules: no `!N` counter and no warning color for steady state. Every alert carries a word or glyph, so color is never the only signal.
An unchanged alert fades to the muted color after ten minutes. Accounts keep identity order; a low window changes its chip, never the order.
Reset times use relative and friendly local forms, never raw UTC timestamps.

The language extension still owns `STE` and guard status. `/tenantext context` still reports startup sources.
The context meter owns context thresholds and visualization. The operations footer owns dashboard presentation.
Unavailable sources remain unknown; tool presence does not prove service health.

The context meter can also show a suggested next move, such as `next: compact 0.99`, from a local decision server. It is off by default; see "Next-move chip" in the context meter guide.

`/tenantext-decisions off` blocks every Tenantext decision-server call and clears the chip. `on` restores them.
The profile's `tenantext/settings.json` stores this switch.
The switch is the `decisions` key; the `/tenantext settings` menu lists it as "Decision-server calls".
A failing endpoint is called at most once per cooldown: 30 s after the first failure, doubling to 10 minutes.
One good answer clears the cooldown.

See the [context meter guide](docs/context-meter.md), [operations footer guide](docs/ops-footer.md), and [Codex routing guide](docs/codex-routing.md).

## Restart briefs

A restart brief answers four questions when you come back to a repository: where you left off, what changed, what matters now, and what you can safely do next.
One structured Markdown file per repository holds the brief (`tracker-brief/1`, see [tracker/schema.md](tracker/schema.md)).
The HTML page is a view that you can regenerate. Git, issues and the linked sources stay the source of truth.

| Part | Path | Job |
| --- | --- | --- |
| Parser, validator, renderer | `tracker/brief.py`, `tracker/render.py` | Strict Markdown subset, line-numbered diagnostics, deterministic self-contained HTML |
| Agent packets | `tracker/paths.py` | Follow-up paths with their evidence for a fresh agent; never executes anything |
| Next-session prompt | `tracker/handoff.py` | Stores a copy/paste prompt for the recommended path as a `handoff` record |
| Refresh pipeline | `tracker/refresh.py` | Resumable stages: checkpoint, collect, prepare, apply, validate, render, store, publish |
| Skill | `skills/tracker-site/SKILL.md` | Wrap-up, catch-up, near-context-limit handoff and incremental refresh |

Common commands (Python 3.11, standard library only):

```sh
python3 -m tracker validate tracker-brief.md   # diagnostics; exit 1 on errors
python3 -m tracker render tracker-brief.md out.html
python3 -m tracker handoff tracker-brief.md    # print the stored next-session prompt
python3 -m tracker.refresh status              # where the brief is and what is unfinished; no network, no model
python3 -m unittest discover -s tracker/tests -t .
```

The refresh pipeline never calls a model by itself. `prepare` writes a bounded input packet (at most 32 KiB) for a model step in a fresh context, and `apply --synthesis FILE` takes its output.
When the model step fails, `minimal` builds a brief from scripted facts and labels it as minimal.
The backend, not the renderer, writes the next-session prompt. A prompt that you edit (`source: requester`) survives refreshes.
Publication is opt-in. It sends the page to an artifact service with an idempotency key and keeps the edit-token receipt with mode 0600 outside Git.
A suggested path is a proposal. It never gives permission to deploy, publish or pass an approval gate.

Not verified: writing through the OpenKnowledge project API. The adapter only detects the `ok` CLI; briefs go to a local file or the pending queue.

## Claude Code plugin

`claude-code/` holds a Claude Code plugin that ships `herdr` and `slopscore-pr` and applies the same rule block. Claude Code has no per-turn system prompt hook, so the delivery differs:

| Pi extension | Claude Code plugin |
| --- | --- |
| Rules prepended to the system prompt every turn | Rules injected as additional context by a `SessionStart` hook: at startup and again after resume, `/clear` and compaction, so they survive context loss |
| `/tenantext on`, `off`, `save` | `/ste on`, `/ste off` set the default. Rules already in the current context stay until `/clear` |
| `/tenantext context` | Built-in `/context` and `/cost` |
| Startup guard | None. Claude Code exposes no hook before a provider request. It sends nothing before the first prompt on its own |
| `tenantext/settings.json` in the profile's Pi agent directory | `~/.claude/tenantext/settings.json` plus `last-injection.json` |

The marketplace manifest is `packages/tenantext/.claude-plugin/marketplace.json` from the kit root.
Its plugin source is the sibling `claude-code/` directory inside this package.

Not verified: Claude Code marketplace installation or a `--plugin-dir` launch from this kit layout.
The package tests cover rule-block consistency and hook behavior, not those installation paths.

Commands:

| Command | Effect |
| --- | --- |
| `/ste` | Status: default, block size, last hook run, settings path |
| `/ste on`, `/ste off` | Default for new sessions and for the next resume, `/clear` or compaction |
| `/ste rules` | Print the rule block |
| `/ste help` | Command table |

`/ste` is a slash command backed by a script, so Claude Code sends its output through the model once. The command tells the model to print it verbatim.

Files:

| Path | Content |
| --- | --- |
| `.claude-plugin/marketplace.json` | Marketplace manifest at the package root (`packages/tenantext`) |
| `claude-code/.claude-plugin/plugin.json` | Plugin manifest |
| `claude-code/hooks/hooks.json` | `SessionStart` hook, matcher `startup\|resume\|clear\|compact` |
| `claude-code/scripts/session-start.mjs` | Emits the rule block as `additionalContext`, records the run, exits 0 on every path |
| `claude-code/scripts/ste.mjs` | Backs `/ste` |
| `claude-code/scripts/rules.mjs` | Copy of `src/rules.ts`. A test asserts the two blocks are identical |

## slopscore

The effort-report extension in this package lives under `slopscore/`. See the [Effort Score rubric](slopscore/effort-score.md) for all seven criteria. It reads harness traces and reports spend by model, role and tool, weighted by a model tier table. It never calls a model. It answers the Effort Score question "which models did the work, at what thinking level, and how much of the spend went to them" from evidence instead of self-report.

Sources:

| Harness | Trace | Cost |
| --- | --- | --- |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`, including `sessions/subagent/` child sessions. Role from `session_info.name` (`subagent-reviewer-…` becomes `subagent:reviewer`). Thinking from `thinking_level_change` | From the trace: pi records cost per assistant message |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` plus `<session>/subagents/agent-*.jsonl`. Role from the parent's `Agent` tool call description. Effort from each entry | Priced from Anthropic list prices, then scaled per model so the session total equals the harness's own `cost-state` entry |

Model tiers. Models are a commodity; only the tier moves the score.

| Tier | Weight | Models |
| --- | ---: | --- |
| T1 frontier top | 1.00 | Fable 5.1, Mythos |
| T2 frontier | 0.90 | `gpt-6-astra`, Opus 5, Opus 4.8 |
| T3 frontier commodity | 0.80 | `gpt-5.6-sol`, `gpt-6.1-sol`, Kimi K3, GLM 5.3, Muse Spark 1.3, `gpt-5.6-luna`, `gpt-6-luna`, Sonnet 5. Interchangeable |
| T4 lesser | 0.45 | `gpt-5.6-terra`, `gpt-6-terra`, Haiku, Sonnet 4.x, Opus 4.x, Qwen 3.6 27B and 35B, Gemini, and other mid models |
| T5 small local | 0.30 | Qwen3 8B fp16 and other 8B class. Valid for researcher or reviewer with proper context |
| unknown | 0.40 | Anything unmatched. Add a pattern to the config |

Thinking factors: max and xhigh 1.0, high 0.95, medium 0.85, low 0.7, minimal or off 0.6, unknown 0.9.

Effort share = Σ spend × tier weight × thinking factor, divided by Σ spend. Model points = effort share × 20, the "Coordinator model" criterion of the Effort Score. Override any tier, price or factor in `~/.pi/agent/slopscore/tiers.json` (or `SLOPSCORE_CONFIG`). The default patterns hold model ids only; to score a nickname of your setup, add it as a pattern to the `tiers` list of that file, which replaces the default list.

Commands:

| Where | Command | Scope |
| --- | --- | --- |
| Pi | `/slopscore` | This session |
| Pi | `/slopscore project [days]` | Pi sessions started in this directory, default 30 days |
| Pi | `/slopscore all [days]` | All pi sessions, default 7 days |
| Pi | `/slopscore claude [days]` | Claude Code transcripts, default 7 days |
| Pi | `/slopscore pr [--base REF] [--no-spend] [--json]` | The PR block for this branch, see below |
| Pi | `/slopscore pr --add-trailers [--yes] [--force]` | Propose `Co-Authored-By` trailers per branch commit; `--yes` rebases, never pushes |
| Pi | `/slopscore okf [--repo PATH] [--json]` | The context bundle table and the failing concepts |
| Pi | `/slopscore config` | Config path and tier table |
| Claude Code | `/slopscore [--days N] [--pi\|--claude] [--cwd PATH]` | Both harnesses, default 7 days |
| Claude Code | `/slopscore pr ...`, `/slopscore okf ...` | Same flags as Pi, same output |
| Shell | `node --experimental-strip-types slopscore/src/cli.ts --days 7 [--json]` | Both harnesses |
| Shell | `node --experimental-strip-types slopscore/src/cli.ts --repo PATH` | Adds the git provenance of PATH: planning artifacts, history, iterations by model, one-shot flag |
| Shell | `node --experimental-strip-types slopscore/src/cli.ts pr ...` | The PR block, same flags as Pi |
| Shell | `node --experimental-strip-types slopscore/src/cli.ts okf [--repo PATH]` | The context bundle table, same as Pi |

Ledger: after each pi agent run, the extension writes a per-session summary to `~/.pi/agent/slopscore/sessions/<id>.json` (models, calls, cost, weighted cost, points). No model call, no network.

Report sections: totals with effort share and points; by model with tier, thinking levels, tokens and spend; by role with the main model per role and whether a reviewer role ran; by tool, where a turn's cost is split evenly across the tools it called.

Provenance (`--repo`): reads `git log` and scores three Effort Score criteria, 50 points, plus the context bundle criterion, 10 points. Planning artifacts (15): `docs/plan/map.md`, `spec.md`, `tickets/`, `decisions.md`, 3.75 each when committed before the first code commit, half after. History (15): five or more commits, ticket references in messages, fix and review commits, three or more active days. Iterations (20): 3 points per code commit after the first ship times the tier weight of the model in its `Co-Authored-By` trailer. One-shot flag: no history, one commit, or all commits inside 12 hours on one day. Flagged repos are capped at 39 (F), or 59 (D) when a spec is kept and a T1 or T2 model signed the commits.

### The PR block

`slopscore pr` applies the same rubric to a pull request. It reads the sessions started in this repository since the branch point (the merge base of `upstream/HEAD`, `origin/HEAD`, `origin/main` or `main`, or `--base REF`) and the provenance of the commits on the branch, and prints one block under 40 lines:

```markdown
## slopscore

| Scope | Sessions | Calls | Spend | Effort share | Model points |
| --- | ---: | ---: | ---: | ---: | ---: |
| branch feature/x vs origin/main, 3 commits, 2 days | 4 | 61 | $7.20 | 88% | 18 / 20 |

| Role | Main model | Top thinking | Share |
| --- | --- | --- | ---: |
| main | example-model | high | 74% |
| subagent:reviewer | example-review-model | xhigh | 26% |

**Provenance:** 3 code commits; 3 commits with model Co-Authored-By provenance; tickets #12; 2 fix or review commits.
**Flags:** none
**Bundle:** 12 concepts, 100% kept current on this branch

_Generated by slopscore-pr on 2030-01-19. Traces stay on the contributor's machine._
```

Sessions count when their first model call is at or after the merge-base commit time and their cwd is the repository or a subdirectory. Up to six role rows, sorted by share; the rest fold into `other`. `--no-spend` prints `n/a` for spend and keeps effort share and model points. Flags are `no local traces`, `N commits without a model trailer` and `tiers.json differs from defaults`. Without traces the block keeps the provenance half and one line, `No local traces for this branch.`. The block carries totals and names only: no path, session id or token count.

`slopscore pr --add-trailers` prints a per-commit table of existing or proposed `Co-Authored-By: <model> <noreply@provider>` trailers, proposed from the main-role model with the most spend between the previous commit and this one. `--yes` rebases and adds them; it refuses a branch that is on a remote without `--force`, prints the `git push --force-with-lease` line and never pushes.

The `slopscore-pr` skill in [`skills/slopscore-pr/SKILL.md`](skills/slopscore-pr/SKILL.md) runs the command, offers the trailers, and fills the `## slopscore` section of the open PR through `gh` or the Gitea API. The PR templates under `.gitea/` and `.github/` carry that section. Pi install: `ln -s "$PWD/skills/slopscore-pr" ~/.pi/agent/skills/slopscore-pr`. The Claude Code plugin ships a copy under `claude-code/skills/`.

Context bundle (`--repo`, 10 points): a repository earns points for keeping an [Open Knowledge Format](docs/okf/README.md) bundle in step with the code. A bundle is any directory whose `index.md` declares `okf_version`. Present and conformant earns 3 and a current `log.md` earns 2. Up to 5 points follow the share of code-commit days that also touched the bundle that day or the next. Each stale concept subtracts 1. A bundle written once and abandoned scores near zero. The checker reads committed git objects only. `slopscore okf` prints the table alone and names every failing concept.

Layout: `slopscore/src/tiers.ts` (tiers, prices, config), `pi-trace.ts`, `claude-trace.ts`, `provenance.ts` (git), `branch.ts` (branch point), `pr.ts` (the PR block), `trailers.ts` (`--add-trailers`), `report.ts`, `cli.ts`, `index.ts` (pi extension). Tests in `slopscore/test/`.

## Develop

From the kit root, install dependencies and link the three optional Pi peers as described in [package tests](../../docs/packages.md#tests).
Then run from `packages/tenantext`:

```sh
npm test
npm run typecheck
```

The tests and typecheck require the linked Pi packages; they are not dependency-free.

Layout:

| Path | Content |
| --- | --- |
| `extensions/` | Stable suite entry points, Codex routing, context meter, and operations footer |
| `src/index.ts` | Tenantext implementation: events, command, and status |
| `src/rules.ts` | Rule block and version |
| `src/guard.ts` | Guard state machine, pure |
| `src/report.ts` | Context report builder, pure |
| `src/settings.ts` | Settings defaults, load and save for `tenantext/settings.json` |
| `test/` | Unit tests for tenantext, codex-accounts, and Claude Code hooks |
| `slopscore/` | Spend, model effort, Git provenance, PR reports, and OKF checks |
| `skills/` | Pi skill resources included with the suite |
| `tracker/` | Restart brief parser, renderer, refresh pipeline, tests and fixtures |
| `claude-code/` | Claude Code plugin, see above |
| `licenses/` | Third-party license texts: the Codex quota fork and the adapted coordinator skills |

## Herdr skill

The `herdr` skill in [`skills/herdr/`](skills/herdr/SKILL.md) lets an agent control [Herdr](https://herdr.dev), the terminal multiplexer for coding agents. The same text and the same scripts serve Claude Code and Pi. The scripts are Python 3 with the standard library only.

| Function | Script | What it does |
| --- | --- | --- |
| Prepare | `init.py` | Prints who you are. On the first use in a workspace, your tab becomes the `coordinator` tab at position 1. |
| Find | `panes.py` | One compact table of the panes in a workspace |
| Use a pane that exists | `ask.py` | Sends one prompt, waits until the agent settles, prints the full reply from the transcript |
| Read | `last-reply.py` | The last complete reply of an agent, not cut by the terminal size |
| Start a new agent | `spawn.py` | Inputs: `--harness pi\|claude`, `--role`, `--model`, `--thinking` |
| Close | `close.py` | Closes subagent panes that the skill started. Refuses all others. |
| Look up | `resources.py` | The catalog of tools and skills with the location that is present on the machine |

| Role | Focus | Usual file access | Session |
| --- | --- | --- | --- |
| `coordinator` | Plans, delegates, checks results | write | primary |
| `researcher` | Context gatherer, the web first | read | subagent |
| `scout` | Context gatherer, local files and repositories first | read | subagent |
| `worker` | One bounded change, verified | write | subagent |
| `reviewer` | Review of a plan, a diff or code | read | subagent |

Layout and names ([`LAYOUT.md`](skills/herdr/LAYOUT.md)):

- Each role has its own tab. The tab label is the role word. The `coordinator` tab is tab 1.
- A coordinator handoff starts the next coordinator below the active coordinator pane.
- An agent name is `<project>-<role>-<n>`, for example `tenantext-scout-2`. The pane label starts with that name.

A role is an order of preference with fallbacks, not a set of limits. Each role prompt starts with "The task has priority". The researcher and the scout are both context gatherers with the same tools; the researcher starts with the web and the scout starts with the local machine. For the web, both use the web tools of the harness. A machine file can put optional entries before them, for example a search MCP server or a desktop browser skill; `skills/herdr/SPAWN.md` explains the entries. `spawn.py` removes no tool unless `--strict` is given, and starts each Claude Code session in the `auto` permission mode.

The skill ships no model choice. Optional `~/.config/herdr-skill/models.json` supplies defaults per role and harness; `models.example.json` shows the shape.
`XDG_CONFIG_HOME` replaces `~/.config` when set. A named model skips the file; a requested thinking level wins.
With no local choice, the harness uses its own default.

The Claude Code plugin ships the skill and `/spawn_agent`; plugin users do not need the installer.
Install at user level for Pi or Claude Code without the plugin:

```bash
skills/herdr/install.sh
```

The installer copies the skill to `~/.agents/skills/herdr`, links it into `~/.claude/skills/` and `~/.pi/agent/skills/`, and installs the `/spawn_agent` command. Pi can find the skill in more than one place; its user directory has priority, so Pi loads the installed copy. The tools and skills of the roles are a catalog in `skills/herdr/resources.json`. Each entry has an ordered list of locations; the launch uses the first one that is present and leaves out an entry that is absent. A machine file at `~/.config/herdr-skill/resources.json` adds or replaces entries for one machine; `resources.local.example.json` shows the format. No entry is required: an entry that is absent does not stop a launch.

Tests need no Herdr server:

```bash
python3 -m unittest discover -s skills/herdr/tests
```

## License

MIT
