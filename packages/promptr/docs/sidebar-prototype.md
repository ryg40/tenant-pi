# Promptr sidebar guide

The sidebar adapts the released pi-atelier v0.12.0 sidebar. The pin, copied modules and changes are in [atelier-adaptation.md](atelier-adaptation.md).
It changes the Promptr surface, not the orchestration architecture.

## Layout

```text
+------------------------------------+-------------------+
| Pi conversation / transcript       | Promptr sidebar   |
|                                    | ordered panels    |
+------------------------------------+-------------------+
| Pi pending messages, statuses and widgets              |
| Pi editor                                              |
| Existing footer (for example Tenantext), unchanged     |
+--------------------------------------------------------+
```

- The sidebar runs in the same Pi process beside the transcript, in regular and fullscreen mode.
- Its height is the terminal height minus the real dock (widgets, editor and footer rows), so it never covers the editor or the footer.
- Below 92 columns, or on a Pi layout the sidebar does not recognize, no sidebar is drawn and Pi keeps the whole width. `/promptr workspace` still works.
- Default width 44; range 28-72; the transcript keeps at least 64 columns.

## Try it in isolation

```bash
cd packages/promptr
npm ci && npm run build
bash scripts/preview-sidebar.sh              # fullscreen; add --tui-mode regular to compare
```

- The preview uses `~/.local/state/promptr-sidebar-preview` as its Pi agent directory (`PROMPTR_PREVIEW_AGENT_DIR` selects another). That directory holds the preview's own settings, notebook and queue.
- It loads the Tenantext footer when a checkout is found (`<stack-dir>/tenantext` when `PROMPTR_STACK_DIR=<stack-dir>` is set, else `packages/tenantext` beside this package). It also falls back to `packages/tenantext` when `<stack-dir>` is set but has no footer. `PROMPTR_PREVIEW_FOOTER=<path>` selects another footer; `none` runs stock Pi. The footer's quota row needs its normal account providers, which the preview does not load.
- If Pi asks whether to trust the project, choose session-only trust or dismiss it.
- Do not submit a real prompt during a UI trial. Start a new Pi process after each rebuild: `/reload` can keep cached compiled modules.

## Commands and keys

| Control | Result |
| --- | --- |
| `/promptr`, `/promptr on`, `/coordinatr` | Show the sidebar |
| `/promptr off`, `/promptr toggle`, `Alt+Shift+P` | Hide or toggle; stored data is kept |
| `Alt+P`, `/promptr focus` | Focus the sidebar; press again to return to Pi |
| `Esc`, `Tab` (focused) | Return keyboard input to Pi |
| `PgUp`/`PgDn`, `[`/`]` (focused) | Page through panels that do not fit |
| Left/Right, `k`/`j` (focused) | Move the panel cursor (`◂` after the title); pages to the cursor panel |
| Space, `z` (focused) | Collapse or expand the cursor panel; collapse all shown panels, or expand all. Saved at once |
| Up/Down, Enter (focused) | Choose and run a Controls action |
| `c` `q` `s` `n` `w` `r` `d` (focused) | Compose draft, queue draft, review/send one, edit notebook, workspace, refresh tracker, remove one queued item |
| `p`, `u` (focused) | Panel settings, subagent usage |
| `/promptr panels` | Open the panel settings screen |
| `/promptr panel <name> on\|off`, `/promptr move <name> <position>` | Change one panel; saved at once |
| `/promptr-collapse <name>\|all`, `/promptr-expand <name>\|all`, `/promptr-fold <name>` | Collapse, expand or toggle panels; saved at once; never shows a hidden sidebar. Also `/promptr collapse\|expand\|fold`. Pi completes panel names and shows each state |
| `/promptr startup on\|off` | Show or keep hidden at Pi startup |
| `/promptr width <28-72>`, `/promptr resize` | Save a width; resize with arrows or a drag (Enter accepts, Esc restores) |
| `/promptr usage` | Subagent cost view (the sidebar must be shown) |
| `/promptr status`, `/promptr help` | State, settings path, overflow, layout; usage |
| `/promptr workspace` | Full hosted view: briefing, tasks, resume, new task |
| `/coordinatr-herdr` | Explicit legacy Herdr companion (never started by the sidebar) |

The sidebar reads keys only while it is focused. `Esc`, `Tab`, `Alt+P`, hiding, a narrow terminal and every dialog release focus.
Each focus session starts a fresh paste parser. Text pasted while the sidebar is focused is dropped and never runs an action.
Dialogs unmount the sidebar while they are open and restore it afterwards.

## Panels and settings

Default order, all shown: Agent, Activity, Tasks, Notebook, Queue, Draft, Alerts, TODOs, Context, Workspace, Usage, Subagents, Tools, Controls.

- Settings file: `<agent dir>/promptr/sidebar.json` (by default `$HOME/.pi/agent/promptr/sidebar.json`). It is created on the first save; startup never writes it. Upstream `pi-atelier.json` is never read or written.
- Collapse: a collapsed panel is one row, `▸ QUEUE · 3`, in its saved place. Queue, Tasks (open issues in the cached tracker snapshot) and Alerts show a count; unknown data shows none. The body is not rendered; its data keeps updating. Collapse is separate from on/off and is kept for hidden panels. `sidebarCollapsedPanels` in `sidebar.json` lists the collapsed IDs (omitted when empty). If a save is refused, the change stays for this session only and a notice says so.
- Settings screen: Up/Down select, Enter or Space toggles, `f` collapses or expands, `[`/`]` move, `m` types a position, Left/Right change the width, `S` saves, `D` loads defaults (all expanded) into the draft, `U` undoes, `Esc` or `q` cancels without saving.
- A save re-reads the file first. If another process changed it, the save is refused and nothing is written. An invalid file gives one warning, defaults are used in memory, and every save is refused until the file is fixed or removed.
- All panels off shows "All panels are off / Restore with /promptr panels". Hiding a panel never deletes its content or resets telemetry.
- Other extensions can contribute panels on the `promptr:sidebar-panels` event channel (protocol 1, `<source>:<name>` IDs). They appear in the settings screen.

## Telemetry panels

- The nine Atelier panels read only the current Pi session. Git inspection and subagent accounting run only in trusted projects and only while the sidebar is shown.
- Missing data is shown as unavailable ("Context unavailable", "Usage unavailable", "No subagent runs"), never as zero.
- External extension statuses are not shown. Observed with Pi 0.87.1: only the footer receives them. ALERTS shows "Ext statuses: footer-only (degraded)". Not verified: status access on newer Pi versions.
- `/promptr usage` opens the subagent cost graph. Terminals with Kitty or iTerm image support get a native image; other terminals get a text chart.

## Safety boundary

- Local first: queue, draft and notebook use the existing per-project files and prompt-log. No starter notebook is written.
- Sends are explicit and one item at a time: review shows the exact text, Enter submits once, Esc cancels. An attempted send stays queued (`?`) and is never treated as delivered. Nothing drains, retries or sends automatically.
- Corrupt queues refuse writes and raise an alert. Stale edits and stale removals refuse overwrites.
- Shutdown and session changes close Promptr dialogs, discard late editor text and remove timers, listeners and renderer adapters.
- Overlays: Promptr closes only its own overlay entry, including behind Pi's stable TUI proxy. It never mounts above another extension's overlay and refuses panels/usage while one is open.
- Do not run the legacy companion and the sidebar as simultaneous writers for the same project. Do not load standalone pi-atelier alongside the sidebar.

## Known limits

- Built and tested with the Pi 1.1.0 dependencies. The sidebar uses private Pi renderer adapters. A start on 1.0.2 showed the sidebar. A package load or a session with a model on 1.1.0 is not verified.
- A persistent overlay from another extension keeps the sidebar waiting and blocks panels/usage until it closes.
- Pi refuses a regular/fullscreen switch while any overlay is shown, including the sidebar. Hide the sidebar (`/promptr off`), switch, then show it again.
- A contributed panel taller than the sidebar is truncated; its lower rows cannot be reached. Very short terminals can leave room for only a panel header.
- Non-overlay Pi views (review confirm, workspace, tracking and catch-up) take focus the Pi way. A foreign dialog opened in the same instant can lose focus until that view closes.
- Not verified: native image rendering, real mouse selection and copy, and the footer quota row with normal account providers. These need a real terminal and a configured account.

## Attribution

Sidebar modules derive from [pi-atelier](https://github.com/michaelmjhhhh/pi-atelier) `v0.12.0` (annotated tag object `3ff521f618cf695c6e9f24df00174ee45b29e9b6`, commit `371b847e525f4a4f6bafce4266bab35259a32759`), by Michael, under the MIT license.
The full notice ships in [PI-ATELIER-LICENSE.txt](PI-ATELIER-LICENSE.txt). The Promptr view, store, settings, telemetry wiring and controller are separate code.
