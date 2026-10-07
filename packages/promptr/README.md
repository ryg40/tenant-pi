# Promptr Pi extension

**Promptr sidebar:** `/promptr` and `/coordinatr` show the Promptr sidebar beside the Pi transcript.
It adapts the pi-atelier v0.12.0 sidebar (MIT) with 14 configurable panels, each of which can be collapsed to one row
(`/promptr-collapse`, `/promptr-expand`, `/promptr-fold`), and the full-width Pi editor,
widgets and footer stay below it. See [the sidebar guide](docs/sidebar-prototype.md) for controls, panel
settings, limits and the isolated preview. `/promptr workspace` opens the full hosted view;
`/coordinatr-herdr` explicitly launches the legacy Herdr companion. The companion instructions below
describe that legacy view.

Promptr is a companion for Pi + Herdr: a proqi-style prompt queue and composer,
a per-project notebook, Gitea/GitHub tracking with a Wayfinder tree, an explicit
Generate Prompt flow for Coordinator prompts, per-project checkpoints and
handoffs, and shared project continuity through OpenKnowledge pages. Every send
is explicit, one item at a time; attempted is never delivered; nothing drains,
retries or launches on its own.

This directory is the published source. The installed copy under
`<agent dir>/extensions/promptr/` is separate: editing here changes nothing
until you rebuild and reinstall (see *Install*).

## Bounded Herdr role handoff

The internal role handoff API starts one explicitly requested visible Pi role
with a full interactive session. A shared adapter builds Herdr arguments and
checks identities. Write-once run receipts distinguish attempted, submitted,
uncertain and collected outcomes. Collection requires a fresh, session-bound
report with a completion marker. Uncertain sends never replay automatically.
See [the handoff guide](docs/herdr-handoff.md) for the API boundary and evidence.
The live Pi pilot, its measurements and the Claude path are not proved.

## Requirements and versions

| Piece | Required | Checked by |
| --- | --- | --- |
| Node | `>=24.0.0 <25` (`engines`) | `promptr-doctor` |
| Pi (`@earendil-works/pi-coding-agent`) | 1.0.x. The build, 756 tests, typecheck and offline smoke pass with the 1.0.4 pins. A start without a model is historical evidence from 1.0.2. The sidebar uses private Pi renderer adapters. A package load or a session with a model on 1.0.4 is not verified | `promptr-doctor`, `/promptr-doctor` |
| Herdr | 0.9.x; needed for `/coordinatr-herdr`, Start fresh and the standalone generator. The sidebar works without it | `promptr-doctor` |
| OpenKnowledge | an HTTPS origin plus `OPENKNOWLEDGE_USERNAME` / `OPENKNOWLEDGE_PASSWORD` exported in the shell that launches Pi and the companion. Optional: everything works locally without it | `promptr-doctor` (presence only), `--online` reads the bound brief |
| Tracker | Gitea (default) or GitHub, read-only, chosen per project or machine with `promptr-tracker-init` / `/promptr-tracker init`; tokens `GITEA_TOKEN` / `GITHUB_TOKEN` for private repositories | `promptr-doctor`, `/promptr-tracker status`, `--online` reads page 1 |
| Providers/models | whatever Pi has loaded and authenticated; the shipped workflow matrix uses neutral provider and model ids, a local override names the real ones (see *Workflow overrides*) | `/promptr-workflows check` |

Credentials are never bundled, stored or printed. Promptr reads them from the
environment of the process that runs it; a companion pane needs them exported
in its own shell (Herdr inherits the launching shell).

## Install (fresh client)

```sh
git clone <this repository> && cd <clone directory>/packages/promptr
npm ci --ignore-scripts
# pi-tui 1.0.4 is a pinned runtime dependency; pi-coding-agent 1.0.4 is a build/test dependency.
npm run build && npm run typecheck && npm test && npm run smoke
npm run smoke:installed        # isolated install into a temporary agent dir (needs npm registry access)
npm run install:local          # → <agent dir>/extensions/promptr, previous copy backed up
```

`install:local` runs `npm pack`, unpacks the tarball into
`<PI_CODING_AGENT_DIR|~/.pi/agent>/extensions/promptr`, installs the runtime
dependency (`@earendil-works/pi-tui`, pinned 1.0.4) there, and moves any previous copy to
`~/.local/share/promptr-handoffs/install-backups/<stamp>-<tag>/`. Flags:
`--agent-dir <dir>`, `--backup-root <dir>`, `--tag <label>`, `--dry-run`,
`--uninstall`. The package carries `dist/`, `skills/` (the
`promptr-generate-task-prompt` skill the generator needs) and `examples/`;
no machine path is baked in.

Then bind the tracker: `promptr-tracker-init --provider gitea|github` from the
project directory (owner/repo default from the `origin` remote; `--check` adds
one bounded read), or `/promptr-tracker init` in Pi. Then quit Pi and start a
fresh Pi process: `/reload` can keep cached compiled modules. A legacy companion
pane that was already open keeps the old code: close it (`Ctrl+C`, `y`) and run
`/coordinatr-herdr` again. Run `/promptr-doctor` (or
`promptr-doctor --online` from a shell) to confirm.

Uninstall: `node scripts/install.mjs --uninstall` (or delete
`<agent dir>/extensions/promptr`). Durable data is untouched: the state root
`<agent dir>/promptr/` (queues, notebooks, prompt-logs, workflow override,
capability probe) and every project's `.promptr/` (briefing, retained
revisions, attempt packets).

## Configure

Environment plus one optional tracker binding file; nothing is written to Pi's
`settings.json`.

| Variable | Meaning |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Pi agent dir (default `~/.pi/agent`); Promptr state lives in `<agent dir>/promptr/` |
| `OPENKNOWLEDGE_ORIGIN` | HTTPS origin (default `https://openknowledge.example.com`) |
| `OPENKNOWLEDGE_USERNAME`, `OPENKNOWLEDGE_PASSWORD` | Basic-auth credentials, read at request time |
| `PROMPTR_TRACKER` | `gitea` or `github`; when set it overrides every tracker binding file |
| `.promptr/tracker.json`, `<agent dir>/promptr/tracker.json` | tracker binding written by `promptr-tracker-init` / `/promptr-tracker init` (`{version, provider, host, owner, repo, apiOrigin?, boundAt}`). Precedence: env `PROMPTR_TRACKER` > project file > global file > `origin` remote on a known host > Gitea default. The file holds no secrets and a project may commit it to share the binding; tokens stay in the environment |
| `GITEA_HOST`, `GITEA_OWNER`, `GITEA_REPO`, `GITEA_TOKEN` | Gitea repository binding |
| `GITHUB_HOST`, `GITHUB_OWNER`, `GITHUB_REPO` (or `GITHUB_REPOSITORY=owner/repo`), `GITHUB_API`, `GITHUB_TOKEN` | GitHub binding; `GITHUB_OWNER`/`GITHUB_REPO` fall back to the `origin` remote when it points at the same host |
| `PROMPTR_WORKFLOWS_FILE` | absolute path of the workflow override (default `<agent dir>/promptr/workflows.json`) |
| `PROMPTR_WORKFLOW_CAPABILITIES` | absolute path of a capability probe (default `<agent dir>/promptr/capabilities.json`, written by `/promptr-workflows probe`) |
| `PROMPTR_GENERATOR_SKILL` | absolute path overriding the packaged generator skill |
| `PROMPTR_GENERATOR_RUNTIME` | `provider/model:thinking` override for generator trials |
| `PROMPTR_AUTO_CHECKPOINTS=0` | global kill switch for automatic checkpoints |

Workflow overrides (intelligence level, provider, model and thinking per role)
are documented in [`docs/workflow-overrides.md`](docs/workflow-overrides.md).
Quick start for a GitHub Copilot-only machine:

```sh
promptr-workflows-init --example copilot
# in Pi: /login (github-copilot), then /promptr-workflows check, then /promptr-workflows probe
```

## Use

**Legacy Herdr companion:** in Pi run `/coordinatr-herdr`. Pi stays left; the companion opens
in a right Herdr pane bound to this Pi (`--pi-pane`, `--project-cwd`,
`--pi-session`). `/coordinatr-herdr status|pause|resume|off|recover|help` manage it;
`off` clears status and keeps the pane, queue and notebook.

Companion keys (`promptr-companion-spike --help` prints the same list):

| Key | Effect |
| --- | --- |
| `?` | in the queue panel or workboard: show every key for the focused region in place of the cards; any key closes it |
| `Tab` | cycle focus: notebook → queue panel → composer (→ workboard when a tracker is bound) |
| notebook entries (panel) | `[` / `]` select the previous / next entry and highlight it whole; `Enter` queues it, `S` queues and reviews it, `E` copies it into an empty composer, `D` deletes it after `y/n`. An entry is a `-- <label> --` … `-- end --` block or a paragraph |
| `↑↓`, `Shift+↑↓` | move / extend the notebook line selection by single lines; `Enter` queues the selection |
| `Ctrl+N` (notebook) | insert a new `-- Note <stamp> --` … `-- end --` block at the cursor, cursor on its body line |
| `Ctrl+Enter`, `Ctrl+E` | enqueue the composer text and clear the composer (archived into the notebook as a closed `-- Queued <stamp> --` block) |
| `Ctrl+S` | queue the composer (if any) and review one item; in review `Enter` submits, `Esc` cancels. Review re-reads the bound Pi's Herdr status: `working` needs a second `Enter`, `blocked` refuses |
| `Ctrl+U`, `x` (panel) | clear the queue after `y/n` |
| queue cards (panel) | `j/k` focus, `Ctrl+J/K` reorder, `e` edit in the composer, `d` delete, `s` review then send, `y` duplicate, `u` undo last delete, `n`/`w` jump to COMPOSE/NOTEBOOK |
| `Ctrl+O` | project briefing overview (see below) |
| workboard | `↑↓ PgUp PgDn Home End` move over issue rows, `Enter` opens the issue, `g` Generate Prompt, `f` folds or expands a map, `r` refresh, `c` Catch-Me-Up, `Esc` back |
| issue detail | `g` starts workflow → provider → execution (Pi subagents or Herdr native sessions) → role preview; `Enter` prepares the packet and places the deterministic draft in the composer; `g` in the preview also launches the generator; `p` lists saved requests; `c` Catch-Me-Up |
| `Esc` | cancel review/confirmation, leave the workboard, else close (state kept) |
| `Ctrl+C` | ask, then close the companion (persistent state kept) |

The workboard shows the tracker as a tree: each Wayfinder map (`wayfinder:map`)
with its children (`wayfinder:parent:<n>`) beneath it, then a `FREE-STANDING`
section for issues on no open map, bucketed by status (`active`, `ready`,
`review`, `blocked`, `later`, `unknown`). Membership is not blocking: only
native dependencies mark `blocked`; an unread dependency graph stays `unknown`.
Each map row shows the count of its open children. When more than one map is
open, `f` on a child folds its map to that one row (`+Map`), and `f` or `Enter`
on the folded row expands it. A map starts expanded; the fold is view state and
is not saved.
The rule names the provider and repository, the open count and the snapshot
age; an unreachable provider shows `offline · <reason>` with the cached rows.

**Execution modes.** After the provider, the picker asks how delegated roles
run. `pi-subagents` (default) keeps the headless `subagent` tool: async runs,
workflow scripts, structured output. `herdr-native` makes every delegated role
a full interactive Pi in its own Herdr tab of the Coordinator's workspace,
named `<prefix>-<suffix>` (`prompt-resea`, `prompt-work`, `prompt-revie`), so
you can watch it, type into it and switch its model with `/model` when a
quota stop hits instead of losing the run. The draft and the generator skill
carry the launch recipe per role (`herdr_layout tab_create` → `herdr_agent
start` with the exact `--provider/--model/--thinking` → one `herdr_agent
prompt`), the keep-it-interactive rule (no `--no-extensions`, `--no-skills`,
`--tools` or print mode), the quota rule (keep the pane, name it, try
`/model <fallback>/<same model>` then `continue` once, otherwise wait for the
user) and the collect-then-close cycle. The choice travels in the packet as
`workflow.execution`; older packets read as `pi-subagents`.

**Catch-Me-Up** (`c` in the issue list or detail, or `/promptr-catchup
[--since 48h|7d|<iso>]` in Pi) gathers real-world progress without a model
run: tracker issues and comments updated since the last run (Gitea by default;
`PROMPTR_TRACKER=github` with `GITHUB_OWNER`/`GITHUB_REPO` or
`GITHUB_REPOSITORY=owner/repo` and `GITHUB_TOKEN` reads a GitHub repository the
same way), commits and uncommitted paths, every `git worktree` and every lane
under `~/.local/share/promptr-handoffs/<wave>/<lane>` with its
`.promptr/task-result.md` status, `.promptr/<wave>/` files changed in the
window, local handoffs and their receipts, `docs/continuation.md`, the brief,
the OpenKnowledge inbox and workspace heads, and checkpoints. The window is the
last run's cursor, else 72 h, capped at 14 d. It writes
`<state>/projects/<slug>/catchup/<stamp>.md` + `.json`, the `catchup.json`
cursor and a `## Catch-Me-Up` heading in `promptr.md`, and appends the digest
to the OpenKnowledge `handoffs` page when connected (offline is a gap line, not
an error). A digest younger than 24 h is attached to the next generator packet
and to the deterministic draft as `## Recent progress (catch-up)`; older ones
are not, the preview hint says `no fresh catch-up · press c`, and nothing runs
a catch-up implicitly. Unreachable trackers, missing credentials and every cut
bound are listed under `Gaps and staleness`; `/promptr-status` shows the cursor.

**Hosted `/promptr`** is the same board/composer/notebook inside Pi with the
same explicit one-item send (`sendUserMessage`, template expansion off) and the
same tracking navigation; the generator launch stays companion-only.

Other commands: `/promptr-save "did X, next Y"`, `/promptr-status`,
`/promptr-catchup [--since 48h|7d|<iso>]`,
`/promptr-autocheck on|off|status|interval <min>`, `/handoffr [focus]`,
`/handoffr finish [name]`, `/promptr-resume`, `/work-status`, `/promptr-workflows status|check|probe`,
`/promptr-tracker [status|init|check]` (bind Gitea or GitHub interactively; the
open companion picks the new binding up on `r`), `/promptr-doctor [init]`.


**Handoff to a same-runtime successor (`/handoffr`).** The running Pi
authors the handoff from its own context; the extension only supplies
evidence, validates, syncs and launches. Phase A: `/handoffr [focus]` refuses
while Pi is busy, otherwise writes `handoffs/<name>.evidence.md` (git snapshot,
checkpoints, queue, provider/model/thinking, session file, context tokens) and
a receipt `handoffs/<name>.json`, then sends one message asking the
Coordinator to read the exact packaged `promptr-handoff/SKILL.md` path and write
`handoffs/<name>.md` (ten fixed `## ` sections; reply `HANDOFF READY <name>`).
Phase B runs after Pi fully settles (`agent_settled`, after retries/follow-ups),
or on `/handoffr finish [name]` in the idle source session: the file
is validated (title, headings in order, non-empty "How to continue", <=64 KiB,
no control characters), appended to the OpenKnowledge `projects/<id>/handoffs`
page behind a `<!-- promptr:handoff ... -->` marker (offline is `pending`),
then a select offers `Launch successor now` / `Save only`. Launch needs Herdr
(`HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`) and an exact runtime
triple (from `ctx.model` + thinking level, else `PI_PROVIDER`/`PI_MODEL`/
`PI_REASONING_LEVEL`; never a default). It verifies the exact source Pi/session
and waits up to 4 s for Herdr's asynchronous idle report, then creates a
new tab in the same workspace and cwd, starts a full interactive Pi with the
same `--provider/--model/--thinking`, waits for readiness (up to 60 s), and
prompts it once to read the handoff and verify git state. The source session
stays open as read-only by convention; close it after the successor confirms
git state. The 200k automatic wrap-up (`/promptr` at >=200,000 current tokens)
runs the same Phase A when Pi is idle and falls back to the deterministic
packet with a `Coordinator busy` notice otherwise.

## Shared project history (OpenKnowledge)

`Ctrl+O → Connect OpenKnowledge` binds the project to
`projects/<id>/{brief,inbox,workspace,handoffs,prompt-log}`; the proposed `<id>`
is the git remote's repository name (stable across checkout paths), else the
directory name. Connect reads the brief and creates missing pages with short
seeds; it never replaces the brief.

- **prompt-log** (append-only): every queue add and delete, send attempt,
  briefing save, prepared request, notebook revision (at exit, on opening the
  overview, every 5 minutes when changed) and imported remote workspace is
  appended locally to `<state dir>/prompt-log.jsonl` first, then pushed in
  batches marked `<!-- promptr:log <client> <from>-<to> -->`. A client id
  (`<state root>/client.json`) names the writer. Offline entries stay local and
  catch up on the next reachability tick; a batch whose marker is already on the
  page is never appended twice.
- **workspace** (current state): queue, composer, workboard, notebook, git and
  Pi status, `Client:` and `Updated:` lines. Before this client's first mirror
  write to a binding it reads the page; a workspace written by another client is
  archived to the prompt-log as `workspace-import` and announced. Deleting or
  editing here never erases history: the prompt-log kept it.
- **Fresh client:** after install and credentials, `Ctrl+O → Connect` with the
  same project id, then `Shared workspace` / `Shared history` read the pages
  (read-only; `Esc` closes). Saving the view turns it into a resume draft that
  goes through the normal review → `Continue here` / `Start fresh` choice.
  Browsing or syncing never submits a prompt or launches a Coordinator.
- Header fragment: `OK <age>` (reachable), `OK pending` (mirror or log batches
  waiting), `OK offline`, `OK unbound`.

Limits, stated honestly: last-write-wins on the workspace and brief (read
comparison before write, no CAS or locks); one writer per project directory per
machine; the prompt-log page is append-only Markdown and grows without
rotation; nothing here uploads Pi transcripts or private wiki content.

## Reload versus reopen

| Change | Do |
| --- | --- |
| reinstalled extension | quit and start a fresh Pi process (`/reload` can keep cached compiled modules); close and reopen any `/coordinatr-herdr` companion |
| edited `workflows.json` | reopen the workflow picker (companion: leave and re-enter the tracking modal; hosted: reopen the board flow) |
| wrote a capability probe (`/promptr-workflows probe`) | nothing: the next generator dispatch reads it |
| new credentials in the shell | restart Pi from that shell (the companion inherits it via Herdr) |

## Diagnostics

`promptr-doctor [--cwd <dir>] [--json] [--online] [--init-tracker | --tracker gitea|github]`
and `/promptr-doctor [init]` report
Node/Pi/Herdr versions, the installed copy and its drift from source, packaged
skills, workflow override validity, capability probe age, OpenKnowledge origin
and credential *presence*, the project binding, tracker provider/repository and
token presence, state ownership (owner-only mode) and prompt-log pending
counts. The tracker check names the binding source (`env`, `project`,
`global`, `remote`, `default`) and hints at `promptr-tracker-init` when the
tracker is not bound explicitly. `--online` adds two bounded reads.
`--init-tracker` runs the interactive binding first (TTY required; exit 2
otherwise); `--tracker gitea|github` binds the project non-interactively from
the `origin` remote. Tokens, notes and prompts never appear in the report.

## Recovery

- Local state per project: `<agent dir>/promptr/projects/<slug>/` with
  `scratch.md`, `queue.json`, `composer.md`, `progress.json`, `promptr.md`
  (append-only human log), `handoffs/`, `requests/`, `generator/`,
  `tracking.json`, `prompt-log.jsonl`, `prompt-log-sync.json`,
  `workspace-import.json`, `inbox-seen.json`. Project-local:
  `<cwd>/.promptr/briefing.md`, `briefing.json`, `briefing-history/`.
- A send whose outcome is unknown keeps the item and records an attempt; inspect
  the Pi pane before retrying. Briefing Resume records a packet under
  `.promptr/briefing-history/` before its single submission.
- Prompt-log `pending`: entries are safe locally; they sync on the next `OK`
  tick (every minute) or the next `/promptr` open/close.
- Conflicting brief: `Refresh remote` retains the remote copy in
  `briefing-history/`; adopt it explicitly or keep local.
- Handoff `invalid` (`/promptr-status` shows the receipt state and reason):
  fix `handoffs/<name>.md` by hand to match the skill's section contract and
  run `/handoffr finish <name>`. Nothing was synced or launched.
- Handoff launch `refused`: the saved document remains usable through
  `/promptr-resume`. Read the receipt reason; do not change source identity or
  replay a partially started launch. Inspect any pane named by the warning.
- Handoff launch `uncertain`: the successor Pi started (receipt records
  workspace, pane and agent name) but the single prompt did not confirm.
  Inspect the new tab; if it is idle and empty, paste the successor message
  yourself. Never resubmit through `/handoffr`; it does not retry.

## Development

```sh
npm run build        # tsc → dist/
npm run typecheck
npm test             # node --test test/**/*.test.mjs
npm run smoke        # offline: companion self-check, init, doctor, package inventory
npm pack --dry-run   # inspect the shipped file list
```

Layout: `src/companion/` (view + persistent entrypoint), `src/extension/`
(Pi commands), `src/coordinatr/` (Herdr split helpers), `src/tracking/`
(Gitea/GitHub adapters, board tree, navigation, requests), `src/workflow/`
(catalog, overrides, registry bridge, init CLI), `src/generate/` (generator
launch and packet), `src/sync/` (OpenKnowledge pages, inbox, workspace mirror,
prompt-log, hydration), `src/briefing/` (store, overview, OpenKnowledge
client), `src/doctor/`, `src/state/`, `src/progress/`, `src/handoff/`,
`src/queue/`, `src/selection/`, `src/project/`.

Fixture tests establish behaviour, not compatibility with a deployed API.

## Generator launch contract

How the companion starts the Generate Prompt generator (`src/generate/launch.mts`);
the skill itself no longer carries this, it only describes the prompt. Use a fresh
normal interactive Pi session in Herdr, not a pi-subagents child and not an
implicit `--continue`. Load exactly the one skill with `--no-skills --skill
<absolute SKILL.md>`, suppress unrelated discovery with `--no-prompt-templates
--no-context-files`, and pass `--no-extensions` plus only the required `-e`
extension (`herdr-agent-state.ts`).
These flags are resource controls, not a sandbox: the generator gets a private
scratch cwd, the bounded packet on disk, and `--tools read,write` only. Task text
and output paths never enter argv; the first message names paths and identifiers.
Validate the produced file (identity, freshness, size) and keep the editable draft
on failure; a pane going idle is not a result. After review, a separate explicit
Send revalidates the bound Coordinator and runtime and submits the reviewed text
once. Generate Prompt never launches a Coordinator or worker.
