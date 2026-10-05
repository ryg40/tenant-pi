# Carry wanted drift into the overlay

Status: offline implementation. `carry` prints JSON patches for the overlay. It never applies a patch and never writes a file. Concept and tier model: [the profile lifecycle](profile-lifecycle.md).

A `compare` report shows which fields differ between two candidates. When the user wants to keep a difference of the right side, the overlay must change, because the next candidate is generated from the overlay. `carry` turns the owner-owned differences of a report into RFC 6902 patches for the overlay, so the user does not transcribe them by hand.

## Command

```sh
python3 scripts/tenant_pi.py compare --left /owned/parent/candidate-a --right /owned/parent/candidate-b > /private/report.json
python3 scripts/tenant_pi.py carry --report /private/report.json --overlay /private/overlay.json --right /owned/parent/candidate-b
```

- `--report` is the JSON output of an earlier `compare` run.
- `--overlay` is the overlay that the patches target.
- `--right` is the right side of the report. It must be the exact `right.path` string of the report, or the action stops with `report_right_mismatch: report.right.path`.
- `--manifest` is optional and defaults to the kit manifest. The action validates `--overlay` and the right overlay copy against it.

The report, the overlay and the manifest load through the bounded no-follow loader of the other actions (regular file, 1 MiB, 64 nesting levels, unique keys). From `--right`, the action opens only the declared files that `compare` opens, through the same loader. It never opens `auth.json`, `models.json`, sessions, memory stores, or any other file. It starts no process and makes no network request; the CLI test blocks sockets and subprocesses. The `carry` code path has no environment read. Not verified: no test probes `os.environ`, so the claim "reads no environment value" rests on reading the code.

## Output

One deterministic JSON object (`sort_keys`, separators `,` and `:`, ASCII). Two runs on unchanged inputs print identical bytes.

```json
{"notCarried":[{"field":"/packages/0/source","file":"settings.json","reason":"rendered_field"}],"patchedOverlay":{"status":"valid"},"patches":[{"op":"add","path":"/ownerPackages","value":["/home/EXAMPLE_USER/git/owner-skills"]}],"scope":{"note":"...","ownerOwned":["roles","modelRoutes","selection","endpoints","env","ownerPackages","unmanaged","memory","ownerResources"]}}
```

- `patches`: a list of `{"op": "add" | "replace" | "remove", "path": "<overlay pointer>", "value": ...}`, sorted by `path`. A `remove` patch has no `value`. No two paths nest, so the order of application does not matter.
- `notCarried`: each report change that gives no patch, as `{"file", "field", "reason"}`. The `field` is the report's field path. A segment is shown only when it is a name that `compare` prints for a kit field, a reviewed component ID, a role name or a list index (at most six digits); every other segment shows as `<redacted>`, so a hand-edited report cannot print a secret-shaped name. An MCP server name also shows as `<redacted>`. No value is shown.
- `patchedOverlay`: the result of the overlay validator on the overlay with all patches applied: `{"status": "valid"}`, or `{"status": "invalid", "rule": "<rule>: <field>"}` with a static diagnostic.
- `scope`: the fixed owner-owned table and a fixed note.

## The owner-owned table

Only changes in `.tenant-pi/choices.json` under `/overlay/<key>` give a patch. Only these keys are in the table: `roles`, `modelRoutes`, `selection`, `endpoints`, `env`, `ownerPackages`, `unmanaged`, `memory`, `ownerResources`. `memory` maps field by field. The table is fixed in `scripts/carry.py`. `consent` is not in the table: a consent change is a user decision and never a patch.

| Report field | Patch path |
| --- | --- |
| `/overlay/roles/<role>` or `/overlay/roles/<role>/<key>` | `/roles/<role>`: the whole role object, or `null` |
| `/overlay/selection/enable/<id>`, `/overlay/selection/disable/<id>` | `/selection/enable`, `/selection/disable`: the whole list |
| `/overlay/endpoints/<id>`, `/overlay/env/<id>` | `/endpoints/<id>`, `/env/<id>` |
| `/overlay/modelRoutes/schemaVersion`, `/overlay/modelRoutes/cycle/...`, `/overlay/modelRoutes/gateway...` | `/modelRoutes/schemaVersion`, `/modelRoutes/cycle` (the whole list), `/modelRoutes/gateway` |
| `/overlay/ownerPackages/<index>` | `/ownerPackages`: the whole list |
| `/overlay/unmanaged/<index>` | `/unmanaged`: the whole list |
| `/overlay/memory/schemaVersion` | `/memory/schemaVersion` |
| `/overlay/memory/<module>/<field>`, for example `/overlay/memory/wiki/wikiHome` | `/memory/<module>/<field>` |
| `/overlay/memory/hermes/childExtensionPaths/<index>` | `/memory/hermes/childExtensionPaths`: the whole list |
| `/overlay/memory/<module>` (the module is `null` on one side of the report) | `/memory/<module>`: the module object when the module is `null` in `--overlay`; `null` only when the report also names a field of the module |
| `/overlay/ownerResources/skills/<index>`, `/overlay/ownerResources/prompts/<index>` | `/ownerResources/skills`, `/ownerResources/prompts`: the whole list |

Rules:

- A list is positional. A patch replaces the whole list, so an inserted entry cannot shift a later index.
- Several report changes of one patch path give one patch.
- When the parent object of a patch path is absent in `--overlay` or in the right overlay copy, the patch moves up to the parent. Example: `modelRoutes` is new on the right side, so the patch is one `add` of `/modelRoutes`.
- The operation compares `--overlay` with the right overlay copy, not with the left side of the report: `add` when `--overlay` lacks the path, `remove` when the right copy lacks it, `replace` otherwise.

### `memory` and `consent`

`compare` reports the overlay `memory` block field by field under `/overlay/memory/<module>/<field>` (see `docs/candidate-compare.md`). `carry` maps each reported field to one patch at `/memory/<module>/<field>`. The module names are `hermes`, `wiki` and `openviking`; the field names are the ones of `docs/memory-modules.md`.

- A memory field that `--overlay` sets, and that the report does not name, is in no patch and stays unchanged, with one condition: the report names no other field of the same module that the right side removes together with the module. Example: the report names only `/overlay/memory/hermes/reviewTransport`; the `hermes.childExtensionPaths` list of `--overlay` stays as it is.
- The condition: when the report names at least one field of a module, and the module is `null` or absent in the right overlay copy, the report shows a real removal of the module. The patch is then `replace` of `/memory/<module>` with `null` (or `remove` of `/memory`, see below), and every field of that module in `--overlay` goes, also one that the report does not name.
- A module object of `--overlay` with no field entry in the report is never set to `null` and never removed. The entry `/overlay/memory/<module>` is then under `notCarried` with the reason `overlay_matches`. Example: the left side has no `memory` block and the right side has an all-null block, or the reverse; the `hermes` object of `--overlay` stays, and no patch prints.
- `remove` of `/memory` prints only when every module object of `--overlay` has a field entry in the report. Else the block stays: each module with a field entry gets `replace` of `/memory/<module>` with `null`, which is how the kit reads an absent block, and each other module is `overlay_matches`.
- In that case the `selection` patch can still take the kept module out of the selection, because `selection.enable` is one unit and the patch is the whole list of the right copy. `patchedOverlay` is then `invalid`; one run on synthetic candidates named `memory_disabled: overlay.consent` first. Put the module back into `selection.enable` by hand, or remove its memory object (set the module to `null`). Not verified: the rule that the validator names after the consent is correct; the code gives `memory_module_disabled: overlay.memory.<module>`.
- `hermes.childExtensionPaths` is a positional list and one unit. A replaced entry with the same count gives one `replace` of `/memory/hermes/childExtensionPaths`.
- A module that is `null` in `--overlay` has no field to keep: the patch is one `replace` of `/memory/<module>` with the module object of the right copy. This is the general parent rule above. With no `memory` block in `--overlay`, the patch is one `add` of `/memory`.
- A module that is an object in both overlays never carries as a whole. The report entry `/overlay/memory/<module>` is then under `notCarried` with the reason `overlay_matches`, and only the named fields give patches.
- `/memory` under `notCarried` with no `/overlay/memory` entry in the report does not describe memory field changes; run `compare` again.
- The recorded activation record `/memory` of `.tenant-pi/choices.json` stays in the report as one marker. The kit derives it from the `memory` block and `selection`, and each of its causes has its own report entry under `/overlay/memory` or `/overlay/selection`. The record therefore gives no patch: it is under `notCarried` with the reason `not_owner_owned`. The record value is never printed.
- A change under `/overlay/consent` is under `notCarried` with the reason `consent_decision`; `carry` never prints a patch under `/consent`.
- A newly selected or deselected memory module comes with a consent change. The validator requires `consent.memoryCapture` true when a memory module is selected, and false when none is. The patches still print, and `patchedOverlay` names the rule, for example `memory_consent_required: overlay.consent.memoryCapture` or `memory_disabled: overlay.consent`. Set `consent` in the overlay by hand after your own decision; then the overlay validates.
- Field patches can leave a combination that the memory rules reject, because a field of `--overlay` that the report does not name stays. Example: the patch sets `wiki.ambientPersonalVault` to `false`, and `--overlay` has its own `wiki.wikiHome`. `patchedOverlay` then names the rule, here `wiki_home_is_ambient: overlay.memory.wiki.wikiHome`; the user decides about the remaining field by hand.

## Where a value comes from

A patch value comes only from the overlay copy that the right side records at `/overlay` of `.tenant-pi/choices.json`. It never comes from `settings.json` or another rendered file, and never from the report. The report holds no private value: a marker field has no value.

- `env` values are the literal `${NAME}` references of the overlay copy. `carry` resolves nothing.
- Before it uses the copy, `carry` validates the whole copy with the overlay rules of the kit manifest. An env value must be a `${NAME}` reference, an endpoint a credential-free HTTPS URL, an `unmanaged` reason bounded text. A copy that fails gives no patch at all.
- The `--overlay` file must pass the same rules, or the action stops with the static rule of the validator.

Warning: a patch prints the overlay value of an owner-owned key: an endpoint URL, a provider and model name, an owner package path, an `unmanaged` reason, a `memory.wiki.wikiHome` path, a `memory.hermes.childExtensionPaths` entry, an `ownerResources` directory path. Treat the output like the overlay itself. It never holds a secret value when the overlay holds none.

## `notCarried` reasons

| Reason | Meaning |
| --- | --- |
| `rendered_field` | The change is in `settings.json`, `hermes-memory-config.json` or `mcp-adapter.json`. The kit renders these files from the overlay. When the right overlay copy changed, the overlay change has its own report entry and gives the patch. A hand edit inside Pi has no overlay value and is not carried. |
| `not_owner_owned` | The field is outside the table: for example `target`, `paths`, `inputs`, the manifest copy, derived metadata such as `/routes` or the memory activation record `/memory`, or `state.json`. |
| `consent_decision` | The change is under `/overlay/consent`. A consent is a user decision; `carry` never prints a patch for it. |
| `field_unmapped` | The key is in the table, but the field has a form that maps to no overlay path, for example `/overlay/roles/<redacted>`, `/overlay/ownerResources` without a kind, `/overlay/memory` without a field, or a memory module or field name that the kit does not declare. |
| `right_overlay_missing` | The right side has no `.tenant-pi/choices.json`, for example a settings-only live profile. |
| `right_overlay_invalid` | The right overlay copy fails the overlay rules of the kit manifest. |
| `overlay_matches` | `--overlay` already has the right value at the patch path. Also: the entry `/overlay/memory/<module>` when the module is an object in `--overlay`, and the right copy has an object too or the report names no field of the module. |

## Refusals

Each refusal happens before any output on stdout. The process prints one static diagnostic on stderr and exits with code 2. It writes nothing in every case.

| Rule | Cause |
| --- | --- |
| `absolute_path: carry.right` | `--right` is not an absolute path without `.` or `..` segments. |
| `input_missing`, `input_path_unsafe`, `input_unreadable`, `input_not_regular`, `input_too_large`, `input_encoding`, `invalid_json`, `input_too_deep`: `carry.report`, `carry.overlay`, `carry.right.<file>`, `manifest.file` | A loader rule failed. Each rule names one cause; see `docs/generator.md`, "Input file errors". |
| `report_shape: report` | The report is not an object with a `changes` list. |
| `report_right_mismatch: report.right.path` | The report has no `right.path`, or it differs from `--right`. The check runs before any file of `--right` is opened. |
| `report_shape: report.changes` | A change entry is not an object with a declared `file`, a `change` of `added`, `removed` or `changed`, and a `field` in the form that `compare` prints: segments of `A-Za-z0-9_.:@-` (at most 64 characters each) or `<redacted>`, at most 512 characters. An entry in any other form is not echoed. |
| A validator rule, for example `unselected_env: overlay.env` | `--overlay` fails the overlay rules. |

## Apply the patches

`carry` applies nothing. Review each patch, then edit the overlay by hand or with an RFC 6902 tool of your choice. Then:

1. Run `python3 scripts/tenant_pi.py validate --overlay /private/overlay.json`. The command proves that the edited overlay passes the rules.
2. Run `generate` into a new absent target and `compare` it with the right side. Only the target path and the `notCarried` fields should differ.

## Limits and unproven claims

- A report reflects the time of the `compare` run. `carry` takes values from the right side as it is now, and it uses the report only to select fields. Not verified: behavior when the right side changed after the report.
- A difference that `compare` does not report gives no patch. Example: a reordered `selection.enable` list is the same set and has no change entry.
- An empty `ownerResources` list or object that is added or removed gives no patch. `compare` reports nothing for it, and no rendered file changes. An all-null `memory` block is different: `compare` reports its fields. The patch is one `add` of `/memory` when `--overlay` has no block, and one `remove` when `--overlay` has an all-null block. An `--overlay` with a module object gets no patch for it.
- A `memory` block of the right overlay copy that is not field-for-field in the report is not carried as a whole. Not verified at runtime: a report that names only the `/memory` record; the code gives no memory patch. Run `compare` again with this release.
- A patch can depend on a key outside the table. Example: enabling `mcp` also needs `inputs.mcpFile`. `patchedOverlay` then names the rule; the user adds the missing key by hand.
- A hand edit of `settings.json` inside Pi, for example `/model`, is `rendered_field` and is not carried. `carry` does not derive an overlay value from a rendered value.
- Not verified: any behavior on a real host. All tests use synthetic candidates in temporary directories.

## Tests

`tests/test_carry.py` covers:

- Round trips: overlay A and candidates A and B, for one change of each owner-owned key, and for an `add`, `replace` and `remove` of whole sections. A small RFC 6902 applier inside the test applies the printed patches to overlay A. `prepare` on the result renders the files of candidate B byte for byte, and the patched overlay equals overlay B.
- The exact patch for one added owner package, and the `${NAME}` form of an env patch.
- An audit test with a secret-like canary in non-owned fields of both sides (`target`, `settings.json` keys, the `skills` and `prompts` entries of `settings.json`, `childExtensionPaths` and `llmModelOverride` of `hermes-memory-config.json`, and the `/memory` record). The canary never reaches stdout or stderr.
- More round trips: `ownerResources` with `add`, `replace` and `remove` of the key and of one kind; `memory` with `add` and `remove` of the block, where the patched overlay names the consent rule and renders candidate B after the user sets `consent`. A consent change alone gives no patch and the reason `consent_decision`.
- Memory fields: one patch per changed memory field, and one module patch when a module is `null` on one side, each as a byte-for-byte round trip. A same-count `childExtensionPaths` replacement gives one `replace` of the list and renders candidate B. A field that only `--overlay` sets (`hermes.childExtensionPaths`, `wiki.wikiHome`; A and B do not set it) is unchanged after a carry of another memory field; a second test covers a `childExtensionPaths` list that A, B and `--overlay` all set, with a value of its own in `--overlay`. A module that is an object in both overlays carries only the named fields, and the check names the rule that the remaining field breaks. An all-null block round trips. An all-null block that is added or removed gives no patch for an `--overlay` with a `hermes` object, in both directions. A module that the right side really sets to `null`, or removes with the block, still carries to an `--overlay` with that module object, with the consent rule named. A removed block keeps a module object of `--overlay` that the report does not name. A secret-like path in a memory field that does not change never prints, and a right copy that fails the memory rules gives no patch.
- Each `notCarried` reason, the `patchedOverlay` check, and each refusal with its exact diagnostic.
- The CLI with an audit hook that records every file open, blocked sockets and subprocesses, and canary `auth.json`, `models.json` and session files beside the declared files. No private file is opened and no file changes.
