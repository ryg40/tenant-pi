# Installed environment architecture

`docs/architecture.html` shows the environment that a selected Pi profile uses after installation.
Git does not track the page: build it with `python3 scripts/architecture_build.py`, then open `docs/architecture.html` from disk in a browser. The page needs no server, network, font download or other file.
A repository web view can show HTML source instead of the rendered page.

This is a runtime map, not a scan of your machine or an installer pipeline.
The architecture page describes the resulting process, files and possible data recipients.

## Runtime map

You interact with Pi in a terminal, optionally inside a Herdr workspace.
The start line selects a profile through `PI_CODING_AGENT_DIR` and starts the `pi` command from your shell.
Pi reads that profile's settings and loads its enabled extensions and skills.
Core Pi does not require any optional module.

A profile is a configuration directory, not an operating-system sandbox.
Pi tools keep the account's file and shell permissions. Trusted project settings can override profile settings.

| Scope | What lives there |
| --- | --- |
| Selected profile | Settings, native login in `auth.json`, sessions, installed npm modules, caches and optional Hermes memory. |
| Clone | The in-tree runtime modules. The profile settings refer to absolute paths inside the clone. |
| Account or project | The LLM Wiki vault, OpenViking client state, the OS keyring and working project files. Their exact scopes differ. |
| Service endpoint | A chosen model provider, direct inference server, optional gateway, remote memory store or tool service. |

A second profile gets no copied authentication, sessions or profile-local memory.
Other profiles can share account state outside their directories. Switching profiles does not roll that data back.
The start line can inherit provider keys from its shell, independently of a native login.

Native provider login, direct inference and an optional gateway are alternative model routes.
Only the gateway route forwards through that gateway to its upstream provider.
The model receives prompt context, including recalled memory and tool results included in the conversation.
Local memory storage therefore does not mean that recalled content stays local.

Optional services receive data only through their enabled, configured clients and the relevant operation.
Some modules make automatic calls, not just explicit tool calls.
OpenViking can capture turns. AgentCore sends each typed prompt to AWS as a recall query and has no capture path. Its propose tool sends a text to AWS only after the person confirms it.
Wiki embeddings need their own settings. Usage modules can send account tokens to provider usage endpoints.
The node details link to the current source documents for these conditions.

## Views and evidence

The public page has progressively detailed views, one tab each, from the installed environment to a catalog of each manifest component. Each view opens with its summary. The catalog shows availability, not a detected selection.

| Term | Meaning on this page |
| --- | --- |
| Core | Required for a Pi session. |
| Optional | Available only when selected and supplied with its prerequisites. The page does not imply installation. |
| Configured | Settings, references and credentials have been supplied. This does not prove a successful connection. |
| Verified | A recorded check proves a stated behavior for a stated version. This page performs no live verification. |
| Manifest status | The repository's status for a component, not a health result for your machine. |

The public page uses portable placeholders such as `$HOME/tenant-pi` and `$HOME/.pi/profiles/main`.
Neither those paths nor an example endpoint identify a detected installation.
The development-only edition can add a Local records view from an untracked values file.
Its recorded values are not a fresh host scan.

## Navigation

1. Select a tab, or press its number key, to change the view.
2. Click a node to read its summary, conditions, files and connections.
3. Double-click a node to open its context and files. A selected node also opens with `Enter`.
4. Press `/` to search all views. Use the arrow keys and `Enter` to choose a result.
5. Select Path and two nodes to inspect their relationship path. Reverse traversal is explicitly identified.
6. Select Tour for the runtime walkthrough. Use the arrow keys to move; changing a tab ends the tour.
7. Drag to pan, scroll to zoom, or press `f` to fit. Press `Esc` to leave a selection, path or drill-down.

On narrow screens, details appear below the diagram. The node buttons there provide readable navigation without precise diagram taps.
Arrow labels stay visible and name the operation. Colors distinguish interaction, loading, model requests, local writes and optional memory or service calls.
An arrow identifies the operation's direction; node details describe returned data.
Secondary relationships and catalog dependencies appear in the connection panel rather than as crossing arrows.
Drill-down uses context columns and the same connection panel, without copying routes from the parent view.

A shortened card label ends with an ellipsis. The tooltip and details retain its complete text.
A repository file link works when this page stays in the clone's `docs/` directory.
The address preserves the view and node, for example `architecture.html#view=components&node=mcp`.

## Rebuild and checks

The Python standard-library builder reads `docs/architecture/model.json` and `config/manifest.json`.
Edit the model or renderer, then regenerate. Do not edit generated HTML alone.

```sh
python3 scripts/architecture_build.py
python3 scripts/architecture_build.py --check
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_architecture_build -q
python3 scripts/doc_check.py
python3 scripts/publish_check.py
python3 scripts/publish_check.py --public
```

`python3 scripts/architecture_build.py --help` lists the options. The `--check` command writes nothing and fails when generated bytes differ.
The tests check determinism, manifest coverage, file references, public-content rules and connector routes.

The optional browser checks require an existing Python Playwright installation and its Chromium browser.
They render both available editions at desktop and narrow sizes, inspect actual text geometry and test navigation.
They install nothing. Missing browser capability is a failed check when explicitly requested.

```sh
ARCHITECTURE_BROWSER_TESTS=1 PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_architecture_build -q
```

Set `ARCHITECTURE_SCREENSHOT_DIR` to an existing external directory to retain screenshots from that check.
The browser tests block network requests and open the generated files directly.

## Local edition

1. Create `docs/architecture/local-values.json` with your host values, never in the public model.
2. Use `values` for placeholder replacements, `views` for additions and `tour` for extra steps.
3. Add a complete view with its own `id`, `label`, `summary`, `groups`, `nodes` and `edges` when local records need a separate tab.
4. Mark planned placeholder names in `planned`. A node using one receives the tag `planned value, not a record`.
5. Keep both local files untracked. `.gitignore` names them, and the publish check excludes them.
6. Generate the local page on demand with `python3 scripts/architecture_build.py --local`.

```sh
python3 scripts/architecture_build.py --local
python3 scripts/architecture_build.py --local --check
```

The values file is an untracked input, not generated output. The builder does not discover host services or recorded plans.
Start with `{"values": {}, "planned": [], "views": {}, "tour": []}` and add the values you need.
The command reads that file and writes `docs/architecture-local.html`; it does not overwrite the values file.
The local file can define a placeholder used only by its added views or tour.
The public model must use every public placeholder. Unknown placeholder names fail the build.

Warning: the local edition holds host values. Never publish it.

## Model and geometry

| Field | Contract |
| --- | --- |
| Group `x`, `y`, `cols`, `nodeW`, `gapY` | Position and grid dimensions. Groups must not overlap. |
| View `boundaries` | Optional outer scope frames with explicit dimensions. These describe scope, not sandbox enforcement. |
| Node `id`, `group`, `kind` | Unique identity, containing group and legend color. |
| Node `label`, `sub`, `summary`, `tags` | Card text and detailed explanation. |
| Node `files`, `doc`, `script` | Evidence paths. Public repository paths must exist in the publish set. |
| Node `drill` | Related view offered in the details panel. |
| Node `component` | Manifest ID. Exactly one catalog node represents each manifest component. |
| Edge `from`, `to`, `label`, `style` | Endpoints, operation and line style. |
| Edge `points`, `labelAt` | Orthogonal route coordinates and label baseline. Required for a visible connection. |
| Edge `detailOnly` | Keep a secondary relationship in details, search context and path finding without drawing it. |

Visible connectors use explicit lanes, not curves that pass through unrelated cards.
A connector can cross its source or destination frame at right angles.
It must not run along a frame border or pass through another card, frame title or label.
Labels must clear cards, all frame borders and other labels.
The browser checks use actual SVG text bounds; component-card collision checks alone do not satisfy this contract.

A refused model gives one `rule: field` line on standard error and exit code 2, and the builder writes nothing.
