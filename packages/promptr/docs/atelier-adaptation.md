# pi-atelier adaptation manifest

Promptr adapts the released pi-atelier sidebar. This file records the upstream source, the copied modules and the Promptr changes.
The full MIT notice is in [PI-ATELIER-LICENSE.txt](PI-ATELIER-LICENSE.txt).

## Upstream pin

| Item | Value |
| --- | --- |
| Repository | https://github.com/michaelmjhhhh/pi-atelier |
| Release | `v0.12.0` (https://github.com/michaelmjhhhh/pi-atelier/releases/tag/v0.12.0) |
| Annotated tag object | `3ff521f618cf695c6e9f24df00174ee45b29e9b6` |
| Tagged commit | `371b847e525f4a4f6bafce4266bab35259a32759` ("chore: release v0.12.0") |
| License | MIT, Copyright (c) 2026 Michael; `LICENSE` sha256 `ddd19b6568834edec81aa7edec92c4eb6cba4ba01f96812f82d1ed9c06688eb7` |

`3ff521f6…` is the annotated tag object; it peels to commit `371b847e…`.
Do not follow upstream `main` or upgrade silently. A new pin is a separate, reviewed change.

## Imported modules

All modules live in `packages/promptr/src/sidebar/vendor/atelier/<module>.mts`, copied from the upstream path `src/<module>.ts` at the pin.
Every file starts with an attribution header. Relative `./x.js` imports became `./x.mts` for the Promptr build.
The upstream sha256 is the hash of the unmodified tagged file.

| Module | Upstream sha256 | Promptr adaptation |
| --- | --- | --- |
| `activity` | `4e65a14b6e463ee67e809db172e979e8e15851888bdb2d6ceacefc79a83b0c8b` | none |
| `config` | `b0ed0f61965748205b701f5fee22d18c8b634010379aae78841a85f27c38527b` | none |
| `display` | `82b058448caf9a992e2abef39c9d35b200eb223574945b38a4d19d0d466124cf` | none |
| `display-path` | `bfb90a37435a4a6162007f51be0edff0456059ce2f645f3ff0bc4090aa190470` | none |
| `footer` | `f295f19aaab64ab8382e71bb8f58db569028563ae8947f20ebf33aeacebc6aa2` | brand label `ATELIER` → `PROMPTR`; never installed as a footer; not wired at runtime |
| `image-compositor` | `31a07686c394a298116b1cbe4e0efc0351df29dea693604969195ff9932b1292` | symbol namespace `promptr.atelier.*`; optional frame `rows`, so image repair skips the dock rows; exports `hasCapturingOverlay` |
| `metrics` | `157095aff876ec9380073f1a101289766cad2ffbb4be445edaa7679688366303` | none |
| `overlay-lifecycle` | `07dfd67e4a090e741d9b91b6f034d9ee1bd4766ddef1742a156169a76802e825` | none |
| `palette` | `f497416c0ea57f1fe4eb3dac8eff9e8d070baf88cc79c9dd100ed27f94215edd` | none |
| `run-activity` | `4d2267a40a805d99a1ac52d861e9b6e35bf0ce7070f0a11adacf4c572843c064` | none |
| `sidebar` | `5d7b711ebad99fb4cddcc069d1a6eefab40e00287d5841b4b1e32f3666e80db6` | hints `/promptr usage`, `/promptr panels`; label "Promptr sidebar requires TUI mode"; `renderSidebarView(..., viewport)` pages panels in saved order (the first panel in the viewport is always kept; `↑N ↓M more · PgUp/PgDn` indicator); empty states for visible built-in panels; all-off and all-unavailable notices; unique name for the kept lead group; exported `SidebarChartGraphics`; `viewport.collapsed`/`cursor`/`badges`: a collapsed panel is one `▸ TITLE · badge` row (minimal height 1, counted by the viewport), the cursor panel gets a `◂` marker |
| `sidebar-panels` | `9f8228ec73afb9fb4c8b8a2a12990d6209839df57c01720168e24dcc020ef097` | channel `promptr:sidebar-panels`; built-in source `promptr`; discovery prefix `promptr`; `normalizeSidebarPanelLayout` no longer forces Agent on when every panel is hidden |
| `split-pane` | `3b90964208110c7f1b68be6f742397e2deea945750e25c1e2eeb43b8b8a16540` | symbol namespace `promptr.atelier.*`; "Promptr sidebar" warnings; `OverlayHandle.getBounds` passthrough; transcript-only split above Pi's real full-width dock (height = terminal rows minus the rendered dock); unrecognized-layout fallback with no sidebar; dock-bounded selection and images; cursor restore on a stopped renderer; teardown that continues after an error; renderer adapters re-synced on mount, resize and layout changes only (not on every data request); `onRenderRequest` reports its own requests for the render guard; the fullscreen split `HStack`/`VStack` answer mouse events with nothing, because Pi already dispatches to the transcript and sidebar boxes and the inherited handler of this second pi-tui copy re-rendered every child on each mouse move |
| `state` | `d27da2bad0fe341de1529d988f0554d66890fd5f1fcf8587b32b12136af7c1a2` | none |
| `subagent-cost-chart` | `af9ddc1c7545285c0b031e20ec9302844c034057be071f7750bc54dcff884920` | none |
| `subagent-cost-history` | `a8085f47c5fdd3b662168facd9d4193f0a5fea4ae331f0a6faac2c15755f43b6` | none |
| `subagent-cost-image` | `dc58b6dee780a0566c342fd120b8b4bbc00b71043fbfda9013f112739972ec85` | none |
| `subagent-usage` | `bb2815d3e3ca7ae2bfbcd89817106f95a618e047e72f2749cde6d748313bd861` | none |
| `subagent-usage-view` | `9e618aab9d4e92c83432b6f18c571187cc7359d62629b46b1b25d3b5f61e4a22` | none |
| `types` | `8344686fdc8695fc2e2958f938a1fe8078ebcb37dccf8478858a8a7b01257e77` | none |
| `workspace-pulse` | `56482a6eacfdb01617008bb3a794ebbd747ef1f8cd6c483ed1a8a1a9016cf4c3` | none |

Not imported: `extensions/index.ts` (installs the Atelier footer, editor and `/atelier`), `src/editor.ts`, `src/menu.ts`,
`src/settings-workspace.ts` (Control Center) and `src/completion-notifier.ts`. Upstream tests, scripts and agent rules are not imported.

## Runtime adapters and wiring

- `vendor/split-pane.mts` and `vendor/image-compositor.mts` are re-export bridges to the tagged copies in `vendor/atelier/`. One set of renderer hooks and one image-compositor symbol exist per renderer.
- Telemetry vendor modules (`activity`, `display-path`, `metrics`, `overlay-lifecycle`, `run-activity`, `state`, `subagent-*`, `workspace-pulse`) are unchanged. Upstream wired them in `extensions/index.ts`, which is not imported; `src/sidebar/telemetry.mts` adapts that wiring with these differences:
  1. No `setFooter` or `setEditorComponent`. Observed with Pi 0.87.1: only the footer receives extension statuses. The sidebar reports "Ext statuses: footer-only (degraded)". Not verified: status access on newer Pi versions.
  2. No `tool_result` handler; the `todo` tool output in the transcript stays unchanged. TODOs come from `message_end` and the session branch, and a failed or malformed update never replaces a valid list.
  3. `turn_end` never waits for the Git inspection.
  4. Extra alerts: model request error, compaction failure, untrusted project, and Promptr workflow alerts (for example an unreadable queue).
  5. Auto-compaction is read through `SettingsManager` with the project trust state. Git and subagent accounting run only in trusted projects.
- `src/sidebar/controller.mts` owns the lifecycle:
  - One session per Pi session; telemetry attaches disabled and runs only while the sidebar is shown.
  - Input is read only while focused. Each focus session gets a fresh paste parser; pasted text is dropped while focused.
  - Promptr overlays close only their own entry. Observed with Pi 0.87.1: extensions receive a stable TUI proxy (`createInteractiveTuiReference`). Completion resolves the real renderer and patches `hideOverlay` there for one call, then restores it by identity. If the renderer cannot be reached, Pi's normal completion runs and nothing is patched.
  - The sidebar never mounts above another overlay; it waits (250 ms polling) and `/promptr status` says so. Panels and usage are refused while another extension's overlay is open.
  - No `git status` snapshot runs at startup; tracker binding inference runs `git remote` only in trusted projects.

## Promptr interfaces

| Export | File |
| --- | --- |
| `renderPromptrSidebar(input: SidebarRenderInput): string[]` | `src/sidebar/atelier-adapter.mts` |
| `SidebarPanelDescriptor`, `describeSidebarPanels(layout, availableIds)` | `src/sidebar/atelier-adapter.mts` |
| `PROMPTR_PANEL_IDS`, `DEFAULT_PROMPTR_PANEL_ORDER`, `defaultPromptrPanelLayout()`, `PromptrPanelRows`, `toSidebarPanelData()` | `src/sidebar/atelier-adapter.mts` |
| `PROMPTR_SIDEBAR_CHANNEL` (`promptr:sidebar-panels`), `PROMPTR_SIDEBAR_PROTOCOL_VERSION` (`1`) | `src/sidebar/atelier-adapter.mts` |
| `SidebarSettings`, `sidebarSettingsPath()` (`<agent dir>/promptr/sidebar.json`), `loadSidebarSettings`, `saveSidebarSettings` (atomic, stale check), `setPanelVisible`, `movePanel`, `runSidebarSettingsCommand` | `src/sidebar/config.mts` |
| `openPanelSettings(ui, options)` | `src/sidebar/settings.mts` |
| `renderComposedSidebar`, `nextPanelOffset`, `sidebarInput`, `SIDEBAR_ACTIONS`, `SIDEBAR_PANEL_ACTIONS` | `src/sidebar/view.mts` |
| `SidebarTelemetrySource`, `createUnavailableTelemetry(cwd)`, `unavailableTelemetrySnapshot(cwd)`, `attachSidebarTelemetry(options)`, `STATUS_SOURCE_GAP_ALERT` | `src/sidebar/telemetry.mts` |
| `openPromptrUsage(ctx, telemetry)` | `src/sidebar/usage-dialog.mts` |
| `registerSidebar`, `SidebarActionBoundary` (`run(action)`), `SidebarHooks`, `ownedOverlayUi`, `sidebarChartGraphics`, `SIDEBAR_HELP` | `src/sidebar/controller.mts` |

Upstream panel IDs stay stable: `agent`, `activity`, `alerts`, `todos`, `context`, `workspace`, `usage`, `subagents`, `tools`.
Promptr panels use `promptr:tasks`, `promptr:notebook`, `promptr:queue`, `promptr:draft` and `promptr:controls`.
Other extensions contribute panels on `promptr:sidebar-panels` with protocol version 1 and a namespaced `<source>:<name>` ID.
