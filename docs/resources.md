# Resources component

Status: `unverified`. The component is `resources` in `config/manifest.json`. The source is `packages/tenantext/extensions/resources/`. No test in this repository loads the component in a generated profile.

This page states the contract of the component. The package tests under `packages/tenantext/test/resources-*.test.ts` test the code against a temporary agent directory. Not verified: each behaviour on this page in a live Pi session.

## Purpose

A Pi resource is an extension, a skill, a prompt template or an MCP server. The `resources` component shows the resources of one agent directory in one list. It turns each resource on or off. It saves a set of states as a named profile and applies a profile later.

The current kit pin is `runtime.piVersion` in `config/manifest.json`.
The source facts below use `<reviewed release>`, Pi `1.0.3`; they do not qualify the current pin.

## Enable the component

1. Move `resources` from `selection.disable` to `selection.enable` in the overlay. The validator then accepts the component and lists its gaps in the plan.
2. Generate the profile. The profile adds `extensions/resources/index.ts` to the `extensions` filter of the `packages/tenantext` package declaration.
3. Run `npm ci --ignore-scripts` in `packages/tenantext`. Not verified: this component needs `node_modules/` at load time.

## Command

The command is `/resources`.

| Argument | Result |
| --- | --- |
| none | Opens the interactive menu. Without a user interface, the command prints the list. |
| `list` | Prints the inventory as text, one line for each item. |
| `save <name>` | Saves the current effective state as a profile. |
| `apply <name>` | Shows the items that change, asks for a confirmation, writes the files, then reloads. |
| `profiles` | Lists the profile names with their saved dates. |
| `delete <name>` | Deletes a profile after a confirmation. |

A line of `list` has these fields in this order: `[x]` or `[ ]`, kind, scope, source, id. `[x]` means enabled. An MCP row that the project file changes has a text in parentheses at its end. The section "MCP server" gives the texts.

### Menu

The menu is a selection list. The groups are in this order: extensions, MCP servers, skills, prompts. Each row has the form `[x] <kind> <scope> <source> <id>`. A selected row changes its state in memory only.

The last rows are these actions:

| Row | Result |
| --- | --- |
| `Set as default (write settings and reload)` | Writes the states to the files, then reloads. |
| `Save as profile...` | Asks for a name, then saves the states as a profile. |
| `Apply profile...` | Shows the profile names. After a selection it shows the changes and asks for a confirmation. |
| `Discard changes` | Leaves the files untouched. |

The Esc key has the same result as `Discard changes`.

## Item model

Each item of the inventory has these fields:

| Field | Value |
| --- | --- |
| `kind` | `extension`, `skill`, `prompt` or `mcp` |
| `scope` | `user` (the agent directory) or `project` (`<cwd>/.pi`) |
| `source` | `local`, `package` or `mcp` |
| `packageSource` | The `source` of the package entry. Only on a package item. |
| `id` | See the table below. An `id` is never an absolute path. |
| `label` | The text for the display |
| `enabled` | `true` or `false` |
| `path` | The file path, when the item has one |
| `projectState` | Only on an MCP user row whose state the project file decides. It holds `by` (`override` or `server`) and `enabled`, the state in this project. |
| `override` | Only on an MCP project row that is an override. It holds `setsEnabled` and, when Pi ignores the override, the reason in `ignored`. |

| Item | `id` |
| --- | --- |
| Local item, user scope | The path relative to the agent directory |
| Local item, project scope | The path relative to the `.pi` directory |
| Package item | The path relative to the package |
| MCP server | The server name |
| Built-in extension | `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode` or `builtin:tool-search`, with source `local` |

The agent directory is the value of `PI_CODING_AGENT_DIR`. Without that variable it is `~/.pi/agent`.

The inventory has these sources:

- The local files under `extensions/`, `skills/` and `prompts/` of the agent directory.
- The explicit entries of the resource arrays `extensions`, `skills` and `prompts` in `settings.json`.
- Each package of `packages[]` with its resources. A local path package resolves relative to the agent directory. An npm package is under `<agent dir>/npm/node_modules/<name>`. A git package is under `<agent dir>/git/`. The component reads the `pi` field of the package manifest. Without that field it reads the conventional directories.
- Each MCP server of `<agent dir>/mcp.json` and of `.pi/mcp.json`, and each project override of `.pi/mcp.json`.
- The four built-in extensions.

The enabled state follows the rules of Pi: the `-path` and `!glob` entries of the arrays, the filter lists of a package entry, `enabled: false` on an MCP entry, and the `disabledMcpServers` block.

## How each toggle is written

The component makes minimal edits. It keeps all other keys and the key order. It keeps the indent of the file that it read. It also keeps the end of that file: with a newline or without one. Only a new file gets an indent of 2 spaces and a newline at the end.

### How Pi reads a list

These rules are read in the source of the reviewed release: the function `applyPatterns` in `dist/core/package-manager.js`. That file is byte-equal in Pi 1.0.2 and the reviewed release. The comment at the top of `packages/tenantext/extensions/resources/writers.ts` has the line numbers. The package test `test/resources-inventory.test.ts` compares the inventory with the result of the installed Pi on four settings files.

| Entry | Meaning |
| --- | --- |
| plain path or glob | Include. A list with no plain entry includes all files. |
| `!pattern` | Exclude each file that the glob pattern matches. |
| `+path` | Add back one exact path. `+path` wins over `!pattern`. |
| `-path` | Remove one exact path. `-path` wins over all other entries. |

Pi applies the four entry classes in that order. The table below gives the result for a filter list of a package entry.

| Filter list | Result |
| --- | --- |
| The key is missing | All files of that kind load. |
| `[]` | No file of that kind loads. |
| Only `!` entries | All files load, except the files that the patterns match. |
| Only `+` entries | All files load. A `+` entry is not an include. |
| `autoload: false` on the package entry | The list is a delta. Only the files that an entry matches change, and the last entry that matches wins. |

### Local extension, skill or prompt

Off: the component adds `-<path>` to the array of that kind in `settings.json` of the user scope. The path is the item `id`. It removes a `+<path>` entry for the same item.

```json
{
  "extensions": ["-extensions/my-tool.ts"]
}
```

On: the component removes the `-<path>` entry. It also removes a `!` pattern that matches only this item. A `!` pattern that matches other items too stays, and the component adds `+<path>`. When the array becomes empty, the component always removes the key.

### Built-in extension

Off: the component adds `-builtin:<name>` to `extensions`.

```json
{
  "extensions": ["-builtin:mcp"]
}
```

On: the component removes that entry.

### Package resource

Off: the component changes the package entry to the object form, if it is a string. Then it adds `!<id>` to the list of that kind. No positive list is necessary, because a list with only `!` entries means all files except those.

```json
{
  "packages": [
    { "source": "npm:example-package", "extensions": ["!extensions/noisy/index.ts"] }
  ]
}
```

Three cases use a different entry:

- The `id` has glob characters: the component writes `-<id>`. A `-` entry is an exact match, and a `!` entry with those characters can match other files.
- The list holds only the plain path of this item: the component writes `[]`.
- The package entry has `autoload: false`: the component writes `-<id>` for off and `+<id>` for on, at the end of the list.

On: the component removes the `!<id>` or `-<id>` entry. The next steps depend on the list that remains:

- The list is empty after the removal: the component removes the key, because `[]` means none.
- The list was `[]` before, or it has plain entries: the component adds the plain path `<id>`. This turns on one item and keeps the others off.
- A `!` pattern that matches other files still excludes the item: the component adds `+<id>`.
- No filter key remains on the entry: the component changes the entry back to the string form.

### MCP server

Off: the component sets `enabled: false` on the entry `mcpServers.<name>` in the file that defines the server.

```json
{
  "mcpServers": {
    "example": { "command": "example-server", "enabled": false }
  }
}
```

On: the component deletes the `enabled` key. An entry without the key is enabled. The exception is a project override (see "Project override").

Some hosts have a `disabledMcpServers` block from `pi-mcp-adapter`. The component shows those servers as disabled. When you turn such a server on, the component moves the entry to `mcpServers`. It does not move an entry that you do not change.

#### Project override

From Pi 1.0.1, a `.pi/mcp.json` entry without `command`, `url` and `type` is an override. It is not a server. Pi merges it over the user server with the same name. It can set only `enabled`, `exposure` and `toolExposure` (`docs/mcp.md` line 34 of the reviewed release; `dist/extensions/mcp/config.js` lines 36 to 40 and 64 to 82).

The component models this merge. These are the rows for a user server `example` and a project override `{ "example": { "enabled": false } }`:

```text
[ ] mcp user mcp example (project override: off in a trusted project; user file: on)
[ ] mcp project override example (override of the user server)
```

| Case | User row | Project row |
| --- | --- | --- |
| The override sets `enabled` | The mark shows the state of the override. The text names the override and the state of the user file. | Source `override`. The mark shows the state of the override. |
| The override sets only `exposure` or `toolExposure`, or nothing | No change: the mark shows the state of the user file. | Source `override`, with the text `the user file sets the state`. The mark shows the state of the user file. |
| No user server has the name of the override | No row | Source `override`, off, with the text `Pi ignores this override: no user server has this name`. |
| The override has a key that is not permitted, or `enabled` is not `true` or `false` | No change | Source `override`, off, with the text `Pi ignores this override` and the reason. |
| The project entry is a full server (it has `command` or `url`) with the name of a user server | Off, with the text `replaced by the project server in a trusted project` and the state of the user file. | Source `mcp`, as for each project server. |

Pi does what the table says for the ignored cases. It reports an error for the entry and keeps the user server unchanged (`config.js` lines 64 to 82).

Pi reads `.pi/mcp.json` only for a trusted project (`config.js` lines 105 to 117). The component does not read the trust state of the project, so the row text says `in a trusted project`. In a project that is not trusted, the state of the user file applies.

Fields: `enabled` of a user row is always the state of the user file. So a profile holds the state of the user file, and a profile from one project does not carry an override into a different project. `enabled` of an override row is the state after the merge. An override row that does not set `enabled` follows the user row. When a profile or a menu result asks for the state that the user row gives, the component writes only the user file. The `source` field of an override row stays `mcp`; only the display shows `override`.

Writes:

- A turn-on or turn-off of the user row writes the user file. When the project file decides the state, the result has one more line: `In a trusted project, the project override in <file> keeps mcp <name> off.` For a full project server the line says that the project server replaces the user server.
- The override row is read-only, as each project item. With the project write option of the code, the component writes an explicit `"enabled": true` or `"enabled": false` on the override, as the `/mcp` command of Pi does (`config.js` lines 123 to 138). It does not delete the key, because a deleted key gives the state of the user file. It does not change an override that Pi ignores.

The model applies only when the `builtin:mcp` row of the inventory is on. With `builtin:mcp` off, Pi does not read `mcp.json` in the native way, and each file gives its rows alone: an entry of `.pi/mcp.json` is a project row with the source `mcp`.

The package tests compare the rows with the result of `loadMcpConfig()` of the linked Pi package (the reviewed release), and the written override with the result of `updateMcpServerConfig()`. Not verified against a live Pi session: the MCP state. The rules for one file come from `docs/mcp.md` of the reviewed release (lines 69 and 90) and agree with the component.

Not modeled:

- The other checks of Pi on an entry. Examples are a server name with a character that is not permitted, and two names that differ only in `-` and `_`. A bad `exposure` value and a bad `url` are two more. Pi ignores such an entry. The component shows it as a row. For a full project server, the component tests only that the entry has `command` or `url`, and that an entry with `url` has no `auth`.
- An installed extension that registers `/mcp`, such as `pi-mcp-adapter`. It replaces the built-in MCP support while `builtin:mcp` can still show as on. Not verified: how a `pi-mcp-adapter` version later than the reviewed 3.2.0 reads an override entry.
- In the menu, a row keeps its text until the write. After a change of a user row in memory, the override row of the same server can show the old state.

A generated profile with the `mcp` module has `-builtin:mcp` and no `mcp.json`, so the native override has no effect there. A generated profile without the `mcp` module keeps the built-in MCP extension. There the override applies when `<agent dir>/mcp.json` exists. A `+builtin:mcp` entry in the settings of a trusted project turns the native path on again, unless an installed extension registers `/mcp` (not verified at runtime).

### Errors

A malformed `settings.json` or `mcp.json` stops the command. The message names the file. The component writes nothing.

## Profiles

A profile is one file: `<agent dir>/resource-profiles/<name>.json`. The name must match `^[a-z0-9][a-z0-9._-]{0,63}$`.

```json
{
  "schemaVersion": 1,
  "name": "minimal",
  "savedAt": "2030-01-01T12:00:00Z",
  "items": [
    { "kind": "extension", "scope": "user", "source": "local", "id": "builtin:mcp", "enabled": false },
    { "kind": "skill", "scope": "user", "source": "package", "packageSource": "npm:example-package", "id": "skills/example", "enabled": true },
    { "kind": "mcp", "scope": "user", "source": "mcp", "id": "example", "enabled": false }
  ]
}
```

`savedAt` is an ISO 8601 time in UTC. A profile holds no absolute path and no secret value.

`apply <name>` sets the state of each profile item that is in the current inventory. It reports two groups and changes neither:

- the profile items that are not in the inventory;
- the inventory items that the profile does not name.

## Limits

- Project scope is read-only. The menu shows the project items, and the component does not write `.pi/settings.json` or `.pi/mcp.json`.
- No themes. The component does not list or change the `themes` array.
- No model settings. The component does not change `defaultModel`, `enabledModels` or other model keys.
- No subagents. The component does not list or change subagent definitions.
- An untrusted project is in the list, although Pi does not load its settings, its `.pi/` directories or its `.pi/mcp.json`.
- Skills from `.agents/skills` directories of the ancestor directories of the project are not in the list.
- A user npm package at the legacy global npm path is not found. The component reads only `<agent dir>/npm/node_modules`.
- The component does not read the trust state of a project. An MCP row that the project file changes shows the state for a trusted project.
- With `builtin:mcp` off, a project MCP entry with the same name as a user server shows as a second server row.
- A turn-on does not always restore the first text of the file. A resource array that was `[]` before the turn-off is removed, and an explicit `enabled: true` on an MCP entry is deleted. Pi reads the two forms in the same way, so the loaded resources do not change.
- A state change applies after the reload. Not verified: the reload unloads an extension that is already loaded in the session.
- The component does not install, update or remove a package.
