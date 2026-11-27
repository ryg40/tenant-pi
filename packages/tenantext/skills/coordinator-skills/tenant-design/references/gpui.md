# tenant-design: GPUI (Rust)

GPUI is the GPU-accelerated UI framework of the Zed editor. Facts were read on 2026-11-14 at crates.io, GitHub and the project sites. Check the site again before you state a version that is not written here.

GPUI has few independent libraries. One stack covers most roles: GPUI Kit of Longbridge (https://gpui-kit.com, https://github.com/longbridge/gpui-kit, Apache-2.0, 20,615 stars, version 0.9.1 of 2026-11-09). The older name of the repository is `gpui-component`.

| Crate | Layer |
| --- | --- |
| `gpui-kit` | The entry crate. It pins a matching GPUI snapshot and re-exports the core, the two layers below and the default assets. |
| `gpui-component` | Styled, ready components. The shadcn/ui of GPUI. |
| `gpui-base` | Unstyled behavior: focus, overlays, accessibility, motion, virtualization. The Base UI of GPUI. |

Install: `cargo add gpui-kit@0.9.1`.

## Core picks

| Task | Pick | Notes |
| --- | --- | --- |
| Styled components (buttons, forms, tables, dialogs, sidebar) | `gpui-component` through `gpui-kit` | The default for a new GPUI application. |
| Primitives with an own visual design (popover, menu, select, tabs, slider, tooltip, focus) | `gpui-base` | Reuse the behavior, own the visuals. |
| Toasts, notifications | `Notification` of `gpui-component` | In-app toasts and system delivery. |
| Drawers, sheets | `Sheet` of `gpui-component` | Four edges, overlay, resize. Not verified: drag to dismiss as in Vaul. |
| Command palette | `Command` of `gpui-component` | It uses GPUI actions and key bindings, and virtualizes the rows. |
| Animation | Motion of `gpui-base`, and the animation API of GPUI | Transitions, springs, keyframes, presence, reduced motion. |
| Animated numbers | none | No rolling-number component exists. Build it with the motion API. |
| Agent and chat screens | `Message`, `MessageScroller`, `TextView` and `Diff` of `gpui-component` | Chat layout, streamed rows of variable height, Markdown, code, diffs. The application owns agent states, tool calls and approvals. |
| Charts | Charts of `gpui-component` | Line, bar, area, pie, radar, candlestick, Sankey. |
| Drag and drop | none for sortable lists | Use the drag API of GPUI. The Dock and the GridLayout of the Kit are draggable. |
| Long lists, large tables | `VirtualList` of `gpui-base`; `DataTable` of `gpui-component` | Rows of one fixed height need only `uniform_list` of GPUI. |
| Shared state | `Entity<T>` and `Global` of GPUI | No separate store library. Use `Global` only for values of the whole application. |
| Theme, dark mode | Semantic `Theme` of `gpui-kit` | Light, dark and custom themes. |
| Text input, editor, syntax highlighting | `Input`, `Textarea` and `Editor` of `gpui-component` | Add a grammar feature, for example `--features tree-sitter-rust`. The feature `syntect` highlights without a syntax tree. |
| Icons | The Lucide set in the default assets of `gpui-kit` | |

## Alternatives

| Task | Library | When to choose it |
| --- | --- | --- |
| GPUI with no component system | `gpui` 0.2.2 (crates.io, Apache-2.0, released 2025-10-22) | A small application with own components. GPUI is before 1.0 and breaks its API. The crate is older than the snapshot that the Kit pins: do not mix both in one project. |
| The UI of Zed itself | The `ui` crate in https://github.com/zed-industries/zed | Only when the project accepts GPL-3.0-or-later and the coupling to the Zed workspace. No standalone install. |
| Community fork of the runtime | GPUI-CE https://github.com/gpui-ce/gpui-ce (Apache-2.0, 1,610 stars) | Only on the user's word. Its README says "mostly API-compatible", and that changes. |
| Smaller charts | `gpui-charts` 0.1.1 (MIT) | Line, bar or point plots without the Kit. Fewer than 100 downloads. |
| Smaller editor | `gpui_editor` 0.2.0 (MIT OR Apache-2.0) | It uses the fork `gpui-unofficial`: check runtime compatibility first. |
| Markdown view only | `gpui-markdown` 0.0.1 (MIT OR Apache-2.0) | Fewer than 100 downloads. The Kit has Markdown already. |

## Rules

1. Read `Cargo.toml` first. A project with `gpui-kit` or `gpui-component` uses them. A project with only `gpui` gets the Kit on the user's word, because the Kit pins its own GPUI snapshot.
2. Styled first: `gpui-component`. Go to `gpui-base` only when the design is custom.
3. Licenses: GPUI and the Kit are Apache-2.0. The Zed repository is mainly GPL-3.0-or-later. Copy no code from a Zed crate before you read the license of that crate.
4. Platforms: macOS, Linux and Windows. The WebAssembly build of the Kit runs its showcase only; do not plan a browser application on it.
5. Not verified: the companion crate for platform startup that the GPUI docs name. No crate `gpui_platform` exists on crates.io. Follow the Kit quick start.

## Inspiration sources

| Source | Good for | Access |
| --- | --- | --- |
| Story gallery of GPUI Kit https://gpui-kit.com | Native controls, themes, tables, editors, overlays. | Free. Clone the repository and run `cargo run`. |
| Zed https://github.com/zed-industries/zed | A large production application: panels, palette, editor, interaction patterns. | Free source, GPL: look, do not copy. |
| Magic UI, Aceternity UI, 21st.dev (see `SKILL.md`, part 2) | Visual ideas only. They ship React code. | Build the idea again in GPUI; nothing installs. |
