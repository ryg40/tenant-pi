# Architecture diagrams

[docs/architecture.html](architecture.html) shows the architecture of the kit as one interactive page.
To see the page, clone or download the kit. Then open `docs/architecture.html` from disk in a browser.
A web view of the repository shows only the HTML source of the file, not the page.
The page needs no network and no server. It loads no other file.
The explainer shows the same diagrams as text, in [its overview](../EXPLAINER.md#overview) and in [its components section](../EXPLAINER.md#components).

## What the page shows

The page has five views. The tabs at the top select a view.

| View | What it shows |
| --- | --- |
| System overview | The clone, the private directory, the generated profile, the Pi runtime and the live profile, with the flows between them. |
| Pipeline | The stages from the manifest and the overlay to a running profile, and the update path. Each node names its script and its document. |
| Components | Each component of `config/manifest.json`, grouped by kind, with its status, its source, its inputs and its readiness gaps. |
| Development and release | The checks, the scans and hooks, the publish set, the portable snapshot and its tags. |
| Runtime and services | The services that a generated profile uses at run time: the gateway route, memory, tools and the Compose seat. |

The public page uses the placeholders of the explainer, for example `$HOME/tenant-pi` and "the gateway". Read each placeholder as the value of your host.

## How to use the page

- Click a node. The right panel shows its summary, tags, facts, files and connections.
- Double-click a node to drill in. The drill-down shows the nodes before the node, the nodes after it and its files.
- Press `/` to search the nodes of all views. Press a number key to select a view.
- Press "Path" and choose two nodes. The page shows the shortest path between them. When no path connects the two nodes, the panel tells you so.
- Press "Tour" for a guided tour of the main ideas. The arrow keys move between the steps. A click on a view tab ends the tour.
- Drag to pan the diagram. Scroll to zoom. Press `f` to fit the view. Press `Esc` to go back.
- A label that is too long for its box ends with "…". Hover the node to read the full label, or click the node to see it in the panel.

A file link opens the file in your clone. The link works when the page is in the `docs/` directory of the clone.
The address of the page holds the view and the node, for example `architecture.html#view=components&node=mcp`.

## How to rebuild the page

`scripts/architecture_build.py` writes the page from `docs/architecture/model.json` and `config/manifest.json`. The script uses only the Python standard library.

```sh
python3 scripts/architecture_build.py
python3 scripts/architecture_build.py --check
```

The first command writes `docs/architecture.html`. The second command writes nothing. It exits with code 1 when the page is not current.
The unit tests compare the page with a new build. Thus, a change of the model or of the manifest needs a rebuild in the same commit.

A private copy of the kit can also have a local edition with the real values of one host:

1. Write `docs/architecture/local-values.json`. Its `values` object holds a value for each placeholder name of the model. Its `views` object can add groups, nodes and edges to a view. Its `tour` list can add tour steps.
2. Optional: put a name in the `planned` list of the file when its value is a plan, not a record. An example is the address of a trial that has not run. The build adds the tag "planned value, not a record" to each node that uses the value.
3. List `docs/architecture/local-values.json` and `docs/architecture-local.html` in `scripts/dev-only-files.txt`. A portable snapshot then holds neither file.
4. Run `python3 scripts/architecture_build.py --local`. The command writes `docs/architecture-local.html`.

Warning: the local edition holds the values of your host. Never publish it.

## How to add a node

1. Add one object to the `nodes` list of a view in `docs/architecture/model.json`.

   ```json
   {"id": "my-node", "group": "g-actions", "label": "My node", "sub": "scripts/my_script.py", "kind": "action",
    "summary": "One sentence about the node.", "tags": ["offline"], "files": ["scripts/my_script.py"],
    "script": "scripts/my_script.py", "doc": "docs/generator.md"}
   ```

2. Add the edges of the node to the `edges` list of the same view, for example `{"from": "my-node", "to": "validate", "label": "the overlay"}`.
3. Rebuild the page and run the unit tests.

| Key | Use |
| --- | --- |
| `id` | A name that is unique in the view. |
| `group` | The group box of the node. The nodes of a group fill its grid in list order. The `cols` key of the group sets the number of columns. The `nodeW` key of the group sets the width of its nodes in pixels, for long labels. |
| `label`, `sub` | The two lines of the node. The page measures each line. A line that is too long ends with "…" on the diagram. The tooltip and the panel show the full text. |
| `kind` | A key of `kinds`. The kind sets the color and the legend entry. |
| `summary`, `tags` | The text and the labels of the panel. |
| `files`, `script`, `doc` | Paths. A path relative to the clone becomes a link. The path must exist in the publish set. |
| `drill` | Optional: the id of a view that the panel can open. |
| `component` | Only in the Components view: the id of a manifest component. The build reads the status, the source, the requirements and the gaps from the manifest. |

An edge has `from`, `to`, an optional `label` and an optional `style`: `flow`, `writes`, `reads`, `optional`, `requires` or `refuses`.
A text can hold a placeholder in the form `{{name}}`. A name has lowercase letters, digits and underscores. The `placeholders` object of the model holds the public value of each name.

The model is public text. Write placeholders, never a value of your host. The unit tests apply the public reader rules of `scripts/publish_check.py` to the page.

The build refuses a bad model with an error. It then writes nothing.

| Error | Meaning |
| --- | --- |
| `edge_endpoint` | An edge names a node that the view does not have. |
| `file_missing` | A path of a node does not exist in the clone. |
| `group_overlap` | Two group boxes of a view overlap. Move a group with its `x` and `y` keys. |
| `component_missing`, `unknown_component` | The Components view does not have exactly one node for each component of the manifest. |
| `unknown_placeholder`, `placeholder_unused` | A text names a placeholder that the model does not define, or the model defines a placeholder that no text uses. |
| `local_value_unknown`, `local_planned_unknown` | The local values name a placeholder that the model does not define, or the `planned` list names a value that the file does not have. |
| `unknown_kind`, `unknown_group`, `unknown_drill`, `tour_target` | A node or a tour step names a kind, a group, a view or a node that does not exist. |
