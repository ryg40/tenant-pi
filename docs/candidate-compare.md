# Candidate comparison without profile modification

Status: offline implementation, not a qualified runtime workflow. `scripts/candidate_compare.py` is a pure module. The `compare` action of `scripts/tenant_pi.py` reads at most five declared files for each side. It writes nothing. No install, login, symlink switch, shell edit, process restart, or runtime-data copy exists in the kit.

## Update model

A newer kit release never updates a profile in place. The user regenerates from the reviewed kit source and the private local overlay into a new target, then compares the new candidate with the previous candidate or the active profile, then switches manually.

```sh
python3 scripts/tenant_pi.py generate --overlay /private/overlay.json --target '/owned/parent/candidate b'
python3 scripts/tenant_pi.py compare --left '/owned/parent/candidate a' --right '/owned/parent/candidate b'
```

Every candidate needs its own absent target. `generate` refuses an existing directory, so the previous candidate and the active profile cannot change. The overlay `target.agentDir` must equal the new `--target` value; edit only that field between regenerations when the choices are unchanged.

## What `compare` reads

Each side is an absolute path that the user names explicitly. The command opens only these paths, through the same bounded no-follow loader as the other actions (regular files, 1 MiB maximum, 64 nesting levels maximum, no symlink in any path component, unique JSON keys):

| File | Absent | Present |
| --- | --- | --- |
| `settings.json` | `settings_missing` error | Reviewed Pi fields compared; other top-level keys listed as unsupported |
| `.tenant-pi/choices.json` | Side kind `settings_only` or `incomplete_metadata` | Overlay, manifest pins, role status, and derived data compared |
| `.tenant-pi/state.json` | Side kind `settings_only` or `incomplete_metadata` | Status and provenance compared |
| `hermes-memory-config.json` | Nothing; the file exists only with the Hermes module | Switches and enumerations compared by value; model and child paths as markers |
| `mcp-adapter.json` | Nothing; the file exists only with the MCP module | `disabled`, `lifecycle`, transport kind, and `settings` by value; every server definition as a marker |

The command never lists a directory. `auth.json`, undeclared `models.json`, `mcp.json`, sessions, memory stores, queues, caches, and every other file stay unread. The test suite proves this with an audit hook that records every file open of the process while private canary files sit beside the declared files. A missing `.tenant-pi` directory is not an error: an unmanaged Pi profile with only `settings.json` compares as `settings_only`. A `.tenant-pi` that is a file or a symlink is an `input_path_unsafe` error.

Two sides with the same path fail with `same_directory`. A relative path fails with `absolute_path`.

## Report

The output is one deterministic JSON object. Two runs on unchanged inputs produce identical bytes.

- `left`, `right`: the given path, `kind` (`candidate`, `incomplete_metadata`, `settings_only`), `state` (`complete`, `incomplete`, or `null`), and `drift`.
- `changes`: one entry per declared field that differs, with `change` of `added`, `removed`, or `changed`. Fields use a JSON-pointer style path inside the named file.
- `unchanged`: the declared fields that are equal on both sides. Only names, never values.
- `unsupported`: fields the comparison does not interpret. `unsupported_field` names an unknown key, `unsupported_shape` marks a known key with an unexpected type, `missing_section` marks a known section that is absent, `unsupported_field_name` replaces a key name that contains characters outside `A-Za-z0-9_.:@-` with `<redacted>`.
- `accepted`: the `settings.json` differences that the overlay key `unmanaged` of either side lists. An entry keeps its `change`, or its `side` and `status`, and adds the recorded `reason`. It never carries a value. An accepted difference is not in `changes` or `unsupported`. The pointer is compared as an exact string with the `field` path of `settings.json`: `/<key>`, `/packages/<index>/source`, `/packages/<index>/resources`, `/llm-wiki/<key>`. See `docs/accepted-drift.md`.
- `markers`: the two provenance fields `/provenance/generatedAt` and `/provenance/kitCommit` of `state.json` when they differ, with `change` of `added`, `removed`, or `changed` and never a value. They differ between any two generations, so they are never in `changes`. Equal values are in `unchanged`. See `docs/candidate-compare.md#candidate-list`.
- `summary`: counts of each change class, plus `accepted` and `markers`. The other counts exclude the accepted and the marker entries.
- `manualSwitch`: the fixed statement that switching is a manual launch choice.

### Values and markers

A change entry carries a value only for a field with a closed public form. Every other field is a marker: the entry says that the field was added, removed, or changed and nothing more.

| Shown by value | Form |
| --- | --- |
| Consent flags, telemetry and analytics switches, Hermes background switches, wiki `ambientPersonalVault` and `trajectories`, the overlay `memory` switches `hermes.backgroundReview`, `wiki.ambientPersonalVault` and `wiki.backgroundTasks` | Booleans |
| `defaultProjectTrust`, `defaultThinkingLevel`, role and cycle `thinking`, `route`, gateway `auth`, component `status`, `roleStatus`, state `status`, Hermes `reviewTransport` (the rendered file and the overlay `memory.hermes` field), `memoryOverflowStrategy`, `llmThinkingOverride`, wiki `taskThinkingLevel` | Fixed enumerations from the reviewed contracts |
| Overlay, `modelRoutes`, overlay `memory`, manifest, and provenance `schemaVersion` values | Small integers |
| `piVersion` | Plain `X.Y.Z` version; a prerelease tag is not echoed |
| `nodeRange`, `pythonRange` | Only the exact range strings the reviewed manifest accepts |
| Package and pin sources in `settings.json`, the manifest, `pendingPackages`, and provenance | `npm:<spec>` for a reviewed package name, `git:<reviewed repository URL>@<40-hex commit>[#reviewed subdir]`, `builtin`, or `null`. The version or commit may differ from the current pin; any other package name or repository is `unsupported_value`. |
| Enabled and disabled component lists, `requiredRoles`, `credentialNames`, provenance `outputs` | Reviewed identifiers, the five role names, the environment names the kit manifest declares, and the three declared output paths |

A value that does not match its public form is reported as `unsupported_value` without the value. Markers cover the target path, provider and model identities, endpoints, environment references, local paths, `enabledModels`, `modelThinkingLevels`, package resource filters, the registry and its digest, the rendered routes, the recorded memory activation, each overlay `memory.hermes.childExtensionPaths` entry and `memory.wiki.wikiHome`, the Hermes `llmModelOverride` and `childExtensionPaths`, the wiki `taskModel`, and unknown fields. A nested secret canary in any of these positions never reaches stdout, stderr, or the report; the tests assert this for endpoints, environment references, model names, hostile URL fields, registry entries, route setup text, and unknown keys at every level.

The manifest field `piAcceptedRange` compares as a marker, never by value. An older record without that field still compares. Drift calculation then reports `required_fields: manifest.runtime`; regenerate from the current kit without changing the old candidate.

Unknown key names are shown when they use safe characters, so that an unsupported field is visible instead of silently discarded. Their values are never shown.

### The overlay `memory` block

`compare` reports the recorded overlay `memory` block field by field under `/overlay/memory`, with the policy of the other overlay keys. `/overlay/memory` is not under `unsupported` for a block that the validator accepts.

| Field | Form in the report |
| --- | --- |
| `/overlay/memory/schemaVersion` | Small integer, by value |
| `/overlay/memory/<module>` for a module that is `null` | The fixed word `disabled`. A module that changes between `null` and an object is one `added` or `removed` entry here, plus one entry per field. |
| `/overlay/memory/hermes/backgroundReview`, `/overlay/memory/wiki/ambientPersonalVault`, `/overlay/memory/wiki/backgroundTasks`, `/overlay/memory/openviking/captureToolResults` | Boolean, by value |
| `/overlay/memory/openviking/recallContextTimeoutMs` | Small integer, by value |
| `/overlay/memory/hermes/reviewTransport` | `direct` or `subprocess`, by value |
| `/overlay/memory/hermes/childExtensionPaths/<index>` | Marker per entry, never a value, also for a `builtin:<name>` entry |
| `/overlay/memory/wiki/wikiHome` | Marker, never a value |
| `/overlay/memory/wiki/embedding` when explicitly `null` | The fixed word `disabled`; omission has no entry |
| `/overlay/memory/wiki/embedding/baseUrl`, `/model`, `/auth/envVar` | Each full embedding field path is a marker, never a value |
| `/overlay/memory/wiki/embedding/provider` | `openai-compatible`, by value |
| `/overlay/memory/wiki/embedding/auth/mode` | `none`, by value |
| `/overlay/memory/wiki/embedding/expectedDimensions` | Positive integer, by value |

- A value outside its public form is `unsupported_value` without the value.
- An unknown module or field name is `unsupported_field` when it uses safe characters, and `<redacted>` with `unsupported_field_name` otherwise. Its value is never shown.
- A block, a module or a `childExtensionPaths` value of the wrong type is one `unsupported_shape` entry. `openviking` has no field for an endpoint or a key: such a name is `unsupported_field`.
- The derived activation record stays in the report as the one marker `/memory`.
- A missing `activation.wiki.embeddings` record equals the exact disabled record emitted by the current generator. This also applies to drift metadata.
- Other activation shapes still differ. Unknown fields and malformed shapes are not normalized away.
- Generated `llm-wiki.embeddingProvider` compares by value. `embeddingBaseUrl`, `embeddingModel`, `embeddingApiKeyEnv`, and `embeddingApiKey` remain markers.
- `consent.embeddingTextTransfer` compares as a boolean. Neither comparison nor its offline diagnostics checks credential values.
- `carry` maps each field entry to one overlay patch; see `docs/carry.md`.

### Drift: owner edits inside a candidate

For a `candidate` side, the report rebuilds the settings that the recorded choices produce, with the same pure planner the generator used, and compares them with the actual `settings.json`:

- `status: "none"`: the file still matches its recorded choices.
- `status: "owner_edits"`: `fields` lists the settings keys that differ, for example after `/model` inside Pi or a manual edit. Values are not shown. Differences in the Hermes or adapter file are listed as `<file>:/<key>`; a deleted file is `<file>:/<missing>`.
- `status: "not_computable"`: the recorded choices do not pass the current kit's validation, with the static rule. A recorded pin that differs from the reviewed constants can cause this; compare the public pins in the report instead.

The `drift` section is not filtered by the `unmanaged` list: an accepted hand edit still appears in `fields`.

`metadata` is `unchanged` when `choices.json` still equals the planner's record, and `changed` when it was edited after generation.

A candidate is derived from the overlay, not from the previous candidate. A user edit inside Pi does not flow into the next regeneration. To keep an approved edit, carry it into the overlay first. For a change of the right side's recorded overlay in an owner-owned key, `carry` prints the overlay patches; see `docs/carry.md`. For a hand edit, use this table:

| Edited `settings.json` field | Overlay field |
| --- | --- |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel` | `roles.interactive` `provider`, `model`, `thinking`; with `modelRoutes`, also the first `cycle` entry |
| `enabledModels` order or members | `modelRoutes.cycle` |
| `modelThinkingLevels` | `thinking` of the matching role or cycle entry |
| `packages` | A kit declaration is not editable: the reviewed manifest owns it. Enable or disable the component in `selection` instead. A repo-owned local package path goes into `ownerPackages`; see `docs/owner-extensions.md#owner-package-paths-in-the-overlay`. |
| `skills`, `prompts` | An owner directory goes into `ownerResources`; see `docs/owner-extensions.md#owner-skill-and-prompt-directories-in-the-overlay`. A `-<path>` or `!pattern` entry has no overlay field: it stays accepted drift. |
| `llm-wiki`, `hermes-memory-config.json` | `memory.wiki` and `memory.hermes` choices plus `roles.memory`; see `docs/memory-modules.md`. |
| `extensions`, `mcp-adapter.json` | The `inputs.mcpFile` document under `--local-dir`; see `docs/workflow-modules.md`. |
| `defaultProjectTrust`, `enableInstallTelemetry`, `enableAnalytics` | Not editable in this release: core keeps `ask`, `false`, `false`. |
| Any other key, for example `npmCommand` or `deviceId` | Not represented. Re-apply it by hand in the new candidate after review. To stop the repeated report of a reviewed key, list its pointer in `unmanaged`; see `docs/accepted-drift.md`. `deviceId` is account state and must never enter an overlay or template. |

## Provenance record

The guarded writer stores a minimal non-secret record inside the writer-owned `.tenant-pi/state.json`: `kitSchemaVersion`, `piVersion`, `nodeRange`, the sorted `enabled` component list, the `pins` of those components, the declared `outputs`, `generatedAt` and `kitCommit`. It contains no target path, endpoint, role, credential name, or registry data.

- `generatedAt` is the UTC time of the generation as `YYYY-MM-DDTHH:MM:SSZ`.
- `kitCommit` is the commit of the kit clone as 40 hex characters, or `unknown`. It is the value that `git rev-parse HEAD` prints; the kit reads it from the Git metadata files and starts no process. See `docs/candidate-compare.md#candidate-list` for the steps and the limits.
- `compare` lists both fields under `markers`, never under `changes`, and never shows their values. Two candidates of the same overlay and kit differ only in `/overlay/target/agentDir` and in these markers.
- The `list` action shows both values per candidate under one parent directory; see `docs/candidate-compare.md#candidate-list`. The record documents what produced the files. It is not authority to overwrite any installed file, and no hash or record in the kit claims ongoing ownership of a field.

## Schema versions and migration

The comparison stops with `unsupported_schema_version` when a side's `state.json`, `choices.json` overlay, or recorded manifest carries a `schemaVersion` other than `1`. It does not guess. The migration guide for this release is:

1. Keep the unknown-version candidate unchanged. Nothing in this kit rewrites it.
2. Regenerate from your current overlay with this kit into a new target. If validation blocks a value, correct the overlay as the table below says.
3. Compare the new candidate against the active profile as a `settings_only` side, or against another schema-1 candidate. A future release that changes the schema must ship a migration note here before it can compare across versions.

### Migration note: `ownerPackages`

The overlay key `ownerPackages` is optional. Overlay `schemaVersion` stays `1`, and the schema of `choices.json` and `state.json` does not change.

- An overlay without the key validates and renders without that resource list.
- A candidate with the key records it at `/overlay/ownerPackages` in `choices.json`. `compare` reports each item as a marker at `/overlay/ownerPackages/<index>` and each rendered entry at `/packages/<index>/source` in `settings.json`. An added or removed owner package is an `added` or `removed` change. The path is never shown: the source reports `unsupported_value`.
- `compare` accepts a plain string entry in `settings.packages`, which is the form Pi uses for a source without a filter. A string entry has a `source` field and no `resources` field.
- Use a kit version that accepts the recorded overlay keys. An unsupported key prevents drift calculation.

### Migration note: `unmanaged`

The overlay key `unmanaged` is optional. Overlay `schemaVersion` stays `1`, and the schema of `choices.json` and `state.json` does not change.

- An overlay without the key validates and renders with an empty `unmanaged` list in the `plan` and `generate` output.
- Every `compare` report includes the list `accepted` and the count `summary.accepted`. Both are empty and `0` when no side records the key. A consumer that reads `changes`, `unsupported` and the other counts needs no change for such a report.
- A candidate with the key records it at `/overlay/unmanaged` in `choices.json`. `compare` reports each item as a marker at `/overlay/unmanaged/<index>`. A recorded list that fails the overlay rules is one `unsupported_shape` entry and accepts nothing.
- A validator that does not accept `unmanaged` cannot calculate drift from a candidate that records it.

### Migration note: overlay `memory` fields

The overlay and `choices.json` retain schema version 1. The comparison report describes each memory field separately.

- A `choices.json` without an overlay `memory` block, or without the `/memory` record, and a `state.json` without a `provenance` record still compare. Against a side with the block, each memory field is an `added` or `removed` change.
- A report for a candidate with a valid `memory` block includes `/overlay/memory/...` entries under `changes` or `unchanged`. It has no `unsupported_field` entry at `/overlay/memory`. The counts in `summary` include the field entries.
- A report without `/overlay/memory/...` entries gives no memory field patch. Run `compare` again before `carry`.

### Migration note: Wiki embeddings

The overlay schema stays at version 1. An old overlay without embeddings stays valid.
The exact disabled activation record introduces no comparison change against an older candidate without that record.
An explicitly null overlay `embedding` still differs from an omitted field, so carry can reproduce either form.
Run `compare` again to get nested embedding fields before carry.
An old whole-object embedding marker cannot replace an existing target embedding object; it gives `overlay_matches` instead.
No offline action resolves the credential reference or probes the endpoint.

### Migration note: `ownerResources`

The overlay key `ownerResources` is optional. Overlay `schemaVersion` stays `1`, and the schema of `choices.json` and `state.json` does not change.

- An overlay without the key validates and renders without that resource list.
- A candidate with the key records it at `/overlay/ownerResources` in `choices.json`. `compare` reports each entry as a marker at `/overlay/ownerResources/skills/<index>` or `/overlay/ownerResources/prompts/<index>`, and each rendered entry at `/skills/<index>` or `/prompts/<index>` in `settings.json`. An added or removed entry is an `added` or `removed` change. The path is never shown.
- `compare` reads the `skills` and `prompts` arrays of `settings.json` on each side, also on a `settings_only` side. Each entry is a marker. An array that is not a list of strings is `unsupported_shape`.
- Use a kit version that accepts the recorded overlay keys. An unsupported key prevents drift calculation.

### Migration note: `generatedAt` and `kitCommit`

The schema of `state.json` is `1`. The two fields are optional keys of `provenance`.

- A `state.json` without the two fields still compares. Against a side with the fields, each field is an `added` or `removed` entry under `markers`.
- Every `compare` report includes the list `markers` and the count `summary.markers`. A consumer that reads `changes`, `unsupported` and the other counts needs no change.
- Consumers must accept the `markers` list to read differences in `generatedAt` and `kitCommit`.

## Overlay compatibility corrections

Local overlay choices persist across kit updates when the schema still accepts them. An incompatible value blocks `validate`, `plan`, and `generate` with a static rule; nothing is generated. Common corrections:

| Rule | Correction |
| --- | --- |
| `unknown_fields: overlay` | Remove keys that this schema version does not define. |
| `duplicate_package: overlay.ownerPackages.item.source` | The path is a package directory of the kit. Remove the item and enable the component in `selection` instead. |
| `unmanaged_count: overlay.unmanaged` | The list has more than 200 items. Remove items. |
| `pointer: overlay.unmanaged.item.key` | Use the exact `field` path of the `compare` report, for example `/npmCommand`. No wildcard and no escape is permitted. |
| `resource_directive: overlay.ownerResources.skills` or `.prompts` | The entry starts with `!`, `+` or `-`. Give the absolute directory path only. |
| `resource_whitespace: overlay.ownerResources.skills` or `.prompts` | The entry starts or ends with whitespace, or has a segment that is only whitespace. Remove the whitespace. |
| `kit_package: overlay.ownerResources.skills` or `.prompts` | The directory is in, at or above `packages/` of the kit. Remove the entry and enable the component in `selection` instead. |
| `inside_target: overlay.ownerResources.skills` or `.prompts` | The directory is in the target profile. Move it to a repository of its own and list that path. |
| `blocked_component: overlay.selection.enable` | The module is not qualified at this pin. Move it to `disable`. |
| `undeclared_component: overlay.selection` | The component was renamed or removed from the manifest. Remove it from both lists. |
| `missing_dependency: overlay.selection.enable` | Add the required component to `enable`. |
| `unselected_endpoint` or `unselected_env` | Remove the endpoint or environment reference of a component that is no longer enabled. |
| `undeclared_env: overlay.env` | Use only the environment names the manifest declares for that component. |
| `thinking: overlay.roles.entry.thinking` | Use one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `interactive_not_first_in_cycle` | Put the interactive role's model first in `modelRoutes.cycle`. |
| `reviewed_source` or `core_runtime_pin` on `--manifest` | The manifest override does not match the reviewed anchors. Use the kit's `config/manifest.json`. |

## Switching profiles

Switching is a manual launch choice. Start Pi with `PI_CODING_AGENT_DIR` set to the candidate you want; return to the previous candidate by starting Pi with its path. The `plan` action prints the display-only launch line for a candidate's overlay, including the process-local gateway URL assignment when a gateway route is selected.

Limits:

- The kit copies no auth, sessions, memory, queues, keychain state, or installed packages between candidates. Each candidate authenticates and installs its declared packages separately.
- Returning to a previous candidate is not a data rollback. Runtime data that a Pi session wrote inside a candidate stays there.
- A candidate directory is not an OS sandbox. HOME, the working directory, environment variables, and trusted project resources still affect a launch.
- `filesComplete` and a `complete` state mean only that files were published. Runtime readiness remains unverified until a separate qualification.

## Test coverage

`tests/test_unmanaged.py` covers the `accepted` list. `tests/test_candidate_compare.py` covers the `markers` list, also for an older `state.json` without the two fields. Offline tests in `tests/test_candidate_compare.py` cover unchanged generation, a changed source pin, added and removed modules, user edits, malformed shapes, unknown schema versions, settings-only and incomplete sides, nested secret canaries in every value position, the overlay `memory` block field by field with canary paths, hostile `memory` shapes, and an older `choices.json` and `state.json` without a memory block. `tests/test_cli.py` runs the command in a disposable HOME with private canary files beside the declared files, an audit hook that records every file open, blocked sockets and subprocesses, and a source and fixture inventory check before and after. Not verified: comparison against a real candidate with another pin; the fixture simulates it with an edited pin.

A candidate with `modelsDefinitions` in its kit choices also declares `models.json`. Compare reads that file through the bounded loader and emits only change markers. An unmanaged model file stays unread.

## Candidate list

Status: offline implementation, read-only. `scripts/candidate_list.py` is a pure module. The `list` action of `scripts/tenant_pi.py` reads at most one file per child directory and writes nothing. It starts no process and opens no network connection.

### Question

Which candidate is current, and which kit commit produced each one? The `list` action gives the facts for that decision. It does not make the decision: it writes no "current" marker, and it deletes or prunes nothing.

```sh
python3 scripts/tenant_pi.py list --parent '/owned/parent'
```

### What `list` reads

`--parent` is one absolute path that the user names explicitly. It has the same form as every other path of the kit: no `.` or `..` segment, no trailing `/`, no shell or template characters. A relative path fails with `absolute_path: list.parent`. An absent parent fails with `parent_missing: list.parent`. A parent that is a file, or that has a symlink in any path component, fails with `read_or_json: list.parent`.

The action lists the direct entries of the parent through a directory descriptor. It does not follow a symlink. For each child directory it reads only `<child>/.tenant-pi/state.json`, through the bounded no-follow loader of the other actions: a regular file, 1 MiB maximum, 64 nesting levels maximum, unique JSON keys, no symlink in any path component. `settings.json`, `choices.json`, `auth.json`, `models.json`, sessions, memory stores and every other file stay unread. The tests prove this with an audit hook that records every file open, directory listing and process start, while private canary files sit in the children.

### Output

The output is one deterministic JSON object, with sorted keys and fixed separators. Two runs on an unchanged tree give identical bytes.

- `parent`: the given path.
- `children`: one row per child, sorted by the child name.
- `summary`: the count of each status, plus `children` (rows shown), `omitted` (rows over the bound) and `notDirectory` (regular files and other entries that are not a child).
- `diagnostics`: sorted static `rule: field` lines. Empty when nothing went wrong.
- `scope`: a fixed statement of what the action reads.

Each row has `name` and `status`:

| `status` | Meaning | Other keys |
| --- | --- | --- |
| `candidate` | The child has a schema-1 `state.json`. | `kitSchemaVersion`, `piVersion`, `filesComplete`, `generatedAt`, `kitCommit`, `unsupported` |
| `unmanaged` | The child has no `.tenant-pi/state.json`, or no `.tenant-pi` directory. An unmanaged Pi profile is listed this way. | none |
| `symlink` | The child is a symlink. The action does not enter it, also when it points to a candidate. | none |
| `invalid` | `state.json` failed the loader or the schema check. | `reason`: a static rule code |
| `unsupported_name` | The child name is outside the safe form. The action does not enter the child. | `name` is `null` |

#### Candidate fields

| Field | Source in `state.json` | Public form; otherwise `null` and listed in `unsupported` |
| --- | --- | --- |
| `kitSchemaVersion` | `provenance.kitSchemaVersion` | Small integer |
| `piVersion` | `provenance.piVersion` | Plain `X.Y.Z`; a prerelease tag is not echoed |
| `filesComplete` | `status` | `true` for `complete`, `false` for `incomplete` |
| `generatedAt` | `provenance.generatedAt` | `YYYY-MM-DDTHH:MM:SSZ`, a real calendar instant |
| `kitCommit` | `provenance.kitCommit` | 40 lowercase hex characters, or `unknown` |

A field that is absent is `null` and is not listed in `unsupported`. A `state.json` without `generatedAt` and `kitCommit` shows `null` for both. A `provenance` value that is not an object adds `provenance` to `unsupported`.

#### Reasons of an `invalid` row

`reason` is the rule part of the loader diagnostic, for example `invalid_json`, `input_encoding`, `input_not_regular`, `input_too_large` or `duplicate_key`, or one of two schema codes: `unsupported_schema_version` (a `schemaVersion` other than the integer `1`) and `unsupported_shape` (the file is not a JSON object). `docs/generator.md` ("Input file errors") lists the loader rules. A `.tenant-pi` that is a file or a symlink gives `input_path_unsafe`. A `state.json` that is a symlink or a directory gives `input_not_regular`. The row never carries a value or a path from the file, and it has no `line` or `column` of a syntax error. A rule that is not lower-case letters and `_` (40 characters maximum) shows as `read_or_json`; no loader rule has another form.

#### Child names

A child name is echoed and entered only in the target segment form of the kit: letters, digits, `_`, `.`, space, `'`, `"` and `-`, at most 255 characters, no leading or trailing space, not `.` or `..`. This is the same form that `generate --target` accepts for a path segment. Every other name, for example one with `$`, a backtick, a control character or a non-ASCII character, gives a row with `name: null` and status `unsupported_name`. These rows sort after the named rows.

### Bounds

- The action lists at most 4096 direct entries of the parent (`MAX_ENTRIES`, the bound of `inventory`). More entries fail with `input_too_large: list.parent`; no partial report is printed.
- The report shows at most 1000 children (`MAX_CHILDREN`), the first 1000 in name order. The rest count in `summary.omitted`, and `diagnostics` contains `child_limit: list.parent`.
- A failure to close the parent descriptor adds `cleanup_failed: list.parent` to `diagnostics`. The report is still printed.

### Provenance fields that `generate` writes

`generate` adds two fields to the provenance record of `.tenant-pi/state.json`:

- `generatedAt`: the UTC time of the generation, in the form `YYYY-MM-DDTHH:MM:SSZ`. The writer calls its clock once, so the `incomplete` and the `complete` state carry the same value. The clock is one injectable parameter of `write()` and `main()`; its default is `datetime.now(timezone.utc)`. A clock that fails or that returns a time without a zone stops the generation with `clock: state.generatedAt` before the first write.
- `kitCommit`: the commit of the kit clone, or `unknown`.

`git -C <clone> rev-parse HEAD` prints the value of `kitCommit`. The kit reads the same value from the Git metadata files instead, because the generator starts no process. The steps are:

1. Read `<kit>/.git` as a file. A worktree or a separate Git directory has a `.git` file with the line `gitdir: <path>`. The kit follows that line once. A relative path resolves against the kit clone. When `.git` is a directory, it is the Git directory.
2. Read `<gitdir>/commondir` when it exists. A worktree keeps its branch refs in the common directory. The kit follows that line once.
3. Read `<gitdir>/HEAD`. A detached `HEAD` holds the commit. `ref: refs/...` names a ref.
4. Read the loose ref file in the common directory. When it is absent, look up the ref in `packed-refs`.

Every read uses the bounded no-follow loader. `.git`, `commondir`, `HEAD` and a loose ref file have a 1 KiB bound; `packed-refs` has the 1 MiB bound. A ref name must match `refs/<segment>[/<segment>...]` with letters, digits, `.`, `_` and `-`, no `..`, no leading `.` in a segment, and no `.lock` end. A branch name outside this closed grammar, for example `release+1`, `a@b` or `fix#1`, records `unknown`, although Git accepts it. A loose ref that is itself a symbolic ref is not followed. A loose ref file that exists but does not parse, or that fails the loader, records `unknown`; the kit does not fall back to `packed-refs` then. The result must be 40 lowercase hex characters. Every other case records `unknown`: no `.git`, a symlink in the path, a malformed or oversized file, a SHA-256 repository, or an absent ref.

The test `tests/test_kit_commit.py` compares the value with `git rev-parse HEAD` of the clone that runs the tests; the test itself runs Git, the kit does not. Not verified: shallow clones, a `HEAD` that names a ref in a `refs/worktree/` namespace, and Git reference backends other than files, such as `reftable`. In those cases the kit records `unknown` or the value of the files, which can differ from `git rev-parse HEAD`.

`compare` lists both fields under `markers`, never under `changes`; see `docs/candidate-compare.md`.

### Limits

- `list` shows recorded facts. It does not check that the files of a candidate are still the files that `generate` wrote; use `compare` for that.
- `kitCommit` names the commit of the kit clone at generation time. Not verified: that the working tree of the clone was clean at that time. Uncommitted kit changes are not visible in the record.
- The bounds are per file (1 MiB for each `state.json`) and per child count (1000 rows, 4096 entries). There is no bound on the total bytes that one run parses: at most 1000 files of 1 MiB each. This costs only CPU time and memory for one file at a time.
- `generatedAt` comes from the host clock. Not verified: that the host clock was correct.
- A candidate directory is not an OS sandbox, and a `complete` state means only that files were published; see `docs/candidate-compare.md`.

### Test coverage

`tests/test_candidate_list.py` covers a tree with two candidates, one unmanaged directory, a symlinked child that is reported as `symlink` and not entered, a regular file, private canary files that stay unopened, invalid state files, unsupported names, the entry and child bounds, a cleanup failure, an older state without the new fields, hostile field values, and two CLI runs with identical bytes in a process that blocks every subprocess and socket. `tests/test_kit_commit.py` covers the metadata parsers, a clone, a worktree, packed refs, symlinks and malformed files. `tests/test_profile_write.py` and `tests/test_cli.py` cover the two new fields in `state.json`.
