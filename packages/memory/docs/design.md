# Design

The memory viewer is a reading room for several memory stores. The reader asks two questions:
"what do my agents remember about X, anywhere?" and "what is in this one store?".
The global view answers the first question. The source view answers the second.

## Foundation

The app started from an AgentCore memory explorer.
It keeps these rules of the explorer:

- Read-only toward every store. A source check (`check-readonly.mjs`) rejects write calls.
  One exception exists: the review of an AgentCore source that has the `review` setting. See [the AgentCore source](sources/agentcore.md#review).
- Service facts and app labels stay apart. The reader shows the native text, then the native metadata, then the labels of the app.
- No persistent cache, no content log, no automatic export. Content stays in process memory.
- Synthetic sample mode with no credential and no network call.
- Strict headers: no-store, CSP, nosniff, no-referrer. No `innerHTML` in the UI.

It changes these:

- One page holds several sources. Each source has an adapter with one interface.
- The global view loads at page open. A source with a cost per read (AgentCore) loads on request only.
- As a module of the local web app of the kit, the viewer has no sign-in of its own: it answers only its parent server, with a secret of the start (see the README of the package). A standalone run keeps HTTP Basic with a credential file.

## Sources

| Source | What one item is | Access |
| --- | --- | --- |
| OpenViking | One memory file under `viking://user/<user>/memories/` | HTTP API, API key |
| okknow (OpenKnowledge) | One page of the knowledge base | MCP and document API over HTTPS with Basic auth, or a read-only volume mount |
| llm-wiki | One wiki page under `wiki/` of the vault | Read-only directory mount |
| hermes-memory | One row of the `memories` table, or one memory file | Read-only directory mount (SQLite opened read-only) |
| AgentCore memory | One memory record in one namespace | AWS API with a person profile |

## Palette

The viewer is one section of the local web app of the kit, beside Artifacts and Walkr. It has their theme: Torch Light by default, and Torch Dark when the reader chose a dark theme. One stored choice (the key `human-review:theme`) serves each section.
`ui/theme.css` holds a copy of the Torch tokens; their source is `packages/walkr/src/theme.css` of the kit. `ui/app.css` gives its own names their Torch values in one block at its top.
The top bar is the navy band of each section: the name of the section, the links Artifacts, Walkr and Memory, the search, and the Theme list.

The five source hues and the logos are the identity of a source, not theme colors. A logo sits on a white plate in both themes.
A source hue marks a source only, as a 4 px rule and the color of its name.
Each source name is always written in text. The hue never carries meaning alone.

| Source | Light | Dark |
| --- | --- | --- |
| OpenViking | `#0B6F60` | `#4CC2AE` |
| okknow | `#7B4BC4` | `#B99AF0` |
| llm-wiki | `#855600` | `#E0B04F` |
| hermes-memory | `#B4335A` | `#F08AA8` |
| AgentCore | `#2660A0` | `#7FB2EA` |

Each light hue has a contrast of 4.5:1 or more on the white ground and on a pane, so the hue is valid for a source name in text.

The first version had its own palette and translucent glass panes. Both left with the move into the kit: the panes are flat Torch cards now, with no `backdrop-filter`.

## Type

| Role | Face | Size |
| --- | --- | --- |
| Interface | The sans stack of Sad News (Avenir Next, Nunito Sans and system fallbacks; no web font) | 14 px, 1.45 line height |
| Headings | The same stack, weight 700 | 20 px page title, 15 px section |
| Memory text | `ui-serif` stack (Charter, Georgia) | 16 px, 1.6 line height, at most 72 characters a line |
| Identifiers, URIs, dates | `ui-monospace` stack | 12.5 px |

Labels use sentence case. No all-caps labels.

## Layout

- Title bar: the product name, the search field (key `/` puts the focus there) and the theme choice. It stays at the top of a wide screen. The `theme-color` of the page follows the theme.
- Rail: a left column with one entry for each provider, each with its brand logo, and the global view at the top.
  - Every source of type OpenViking sits under the one entry "OpenViking". Its submenu has one item for each agent user. The entry is a button that opens and closes the submenu.
  - The group comes from the type and the name of each source in the source list of the API. No list of agents is fixed in the UI.
  - A logo is a local SVG file. A logo that does not load, or a source of an unknown type, shows a plain plate beside the name.
  - The folders of a source sit under its rail entry (for OpenViking: under the item of the agent user). A control beside the entry opens and closes them, and each folder opens its own level.
  - The rail reads folders on request only: when a route enters a source, or when the reader opens a level. The page open reads no folder. One level is one browse request.
  - Entering a folder reads the levels above it from the root down, one after the other, and at most 12 for one view. The reads stop at a level that does not list the next one, so a path that does not exist costs no read below its first missing part. A closed tree reads nothing. The path bar still shows the whole path.
  - Entering a folder opens each level above it. A tree that a route opened closes when the route enters another source; a tree that the reader opened stays.
  - A lazy source (AgentCore) reads its root only, which lists the namespaces without a read of AWS. A namespace has no control to open it; its link is the load action.
  - A folder shows its count when the source gives one, and the current folder has the one mark of the current place in the rail (the source has it when the tree does not show the folder). Loading, empty and failed reads say so in place; a failed read offers one more try, and the focus stays on that control when the read fails again.
  - The rail scrolls inside itself. A long folder name is cut and its title holds the whole name. Below the sixth level the tree stops moving right.
  - A reply for a level that the reader closed, or for a source that is no longer open in the rail, paints nothing.
  - A group or a tree that the reader closed stays closed while the rail redraws. Only the entry into a source opens them again.
  - At 900 px or less the rail hides behind the "Sources" button of the title bar. Opening it moves the focus into it. Escape or a chosen source closes it and gives the focus back. The folders stay available there.
- Global view:
  - The strata bar: one full-width bar, cut into one segment for each source, in proportion to its count of memories. This is the one memorable element of the page. A source with no count has no segment and says why in the ledger.
  - The ledger: one row for each source. Columns: source, state, entries, newest entry and largest scopes. The source name opens its view. A table, not a grid of cards.
  - Recent: the newest entries of all sources in one list, each with its source name.
- Search view: a filter row with one toggle and one count for each source, then the results grouped by source. Scores of different stores are not comparable, so the app does not merge them into one ranking.
- Source view: the path bar, then two columns. Left: the list of items. Right: the reader. The folders are in the rail. At 900 px or less, the columns stack and the reader opens as a page.
  - The path bar is one wide bar above the list and the reader. Its parts are the source, each folder of the path as a link to that folder, and the name of the open entry as the last part.
  - A long path wraps inside the bar. On a small screen the bar stays above the reader page.

## Motion and access

- No motion except a 120 ms fade of the reader. `prefers-reduced-motion` removes it.
- Each control has a visible focus ring in the action color.
- The page works with the keyboard alone: `/` for search, `Escape` to close the reader, arrow keys in the item list.
- Home and End select the first and last link of the current list. Arrow keys also work in the rail and in recent lists. In the rail, Right opens the folders of a row and Left closes them.
- The skip link moves focus to the content without changing the route.
- Search toggles are buttons. Focus stays on a toggle when the results arrive.
- The reader has a back link, including during a failed read. Closing it restores focus when its item remains visible.
- List requests and reader requests have separate generations. Closing a pending reader does not repeat or cancel a list read.

## Source identity and states

The configured source name stays visible. Two OpenViking users can appear as `OpenViking · Alice` and `OpenViking · Bob`.
Sources of one type share a hue. They remain adjacent in the ledger, filters and search results. The rail shows the OpenViking sources as one group, and each submenu item shows the agent user alone.
The strata bar keeps separate segments for their positive counts, with a 2 px separator.
Unknown counts and zero counts have no segment.

| State | Presentation |
| --- | --- |
| Loading | A status message describes the pending read. Entry lists also expose `aria-busy`. |
| Empty | The view explains whether a folder, search, recent list or source configuration is empty. |
| Partial | A notice says the read does not cover the whole source. The view preserves `note` and `notes`. |
| More | Browse offers the next page. Grouped search links to the source. Source search asks for a narrower term. |
| Failed source | The source keeps its own error. Other source rows and result groups remain usable. |
| Stale | The ledger and source view show `Stale`, the public error and the detail. Counts and available data stay visible. |
| On request | The ledger says `On request`. Only unloaded namespace links say `Load namespace · reads AWS`. |
| Namespace | Loaded, empty, partial, denied and failed states remain distinct. Failed reads keep their messages and disclose retry reads. |

Lazy sources remain off in global search until selected. An explicit empty selection sends no search request.
The UI never loads a lazy namespace just to open its source root.
The source view paints browse data without waiting for the overview status read. Status replies apply only to their original view.
An overview failure adds a notice without replacing the browse data.
A namespace read, refused or not, reloads only the namespace root for the rail. The refusal stays in the list and on the namespace in the rail, and the path bar keeps the namespace as its last part.
The root lists namespaces without loading records. Source search without a path explicitly covers all configured namespaces.
Global and scoped search show each failed namespace path and its public message beside the available results.
The sample banner explains that synthetic actions never read AWS.

The reader separates source text, source metadata and app labels.
Its raw toggle and clipboard action use the original body.
Formatted Markdown uses DOM text nodes, not HTML parsing. HTTP links open only after selection; images never load.
Quote nesting stops after eight levels. Deeper quote markers remain literal text.
Link and wiki labels have bounded matching lengths so unmatched brackets cannot cause quadratic scanning.
Heading suffixes use a backward scan. Inline forms use one combined scan instead of scanning each suffix for every token type.
Plain text stays literal, including line breaks. The app stores only the theme preference in local storage. A legacy value `system` gives the light theme.

## Test support

Runtime synthetic documents stay in `sample/`.
Browser-only tools and response scenarios stay in `tests/browser/`, outside the runtime sample directory.
`tests/browser/browser-check.py` uses host Chrome and Python Playwright against a loopback sample server.
It keeps the server assets and CSP, but replaces API responses using `browser-fixtures.mjs` and `scenarios.json` in the same directory.
These scenarios define stale sources, namespace states and per-namespace search errors without a live memory service.
Held overview replies prove that browse data appears first and that late status cannot change another source view.
Namespace refusal scenarios return HTTP errors, as the server does, rather than successful browse replies with error fields.
They check the UI contract, not integrated adapter behavior.

## Integration requests

The integrated server preserves search `partial`, `more`, `note`, `notes` and `errors`.
It supports two named OpenViking sample users, sample fixture selection and lazy AgentCore sample loading.
It masks privacy placeholders in snippets and serves the selection module through its fixed static route list.

| Path | Request |
| --- | --- |
| `lib/adapters/sample.mjs` | Give lazy sample facets the same namespace states as the AgentCore adapter. |
