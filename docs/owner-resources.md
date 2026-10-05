# Owner skill and prompt directories in the overlay

Status: offline implementation. The kit validates the form of each entry and writes it into a new candidate. It does not open, list, copy or load an owner directory. Concept and tier model: [the profile lifecycle](profile-lifecycle.md).

An owner resource directory is a directory of skills or of prompt templates that the user maintains in a separate repository. The overlay key `ownerResources` adds such a directory to the Pi `skills` or `prompts` array in `settings.json` of a generated profile. The directory stays in one place. No copy enters the profile, and no hand edit of `settings.json` is necessary.

Use [`ownerPackages`](owner-packages.md) for a directory that is a Pi package (it can hold extensions and has filter lists). Use `ownerResources` for a plain directory of skills or prompts.

## Overlay form

`ownerResources` is an optional top-level key of the overlay. Its value is an object with two optional keys:

```json
{
  "ownerResources": {
    "skills": ["/home/EXAMPLE_USER/git/owner-skills/skills"],
    "prompts": ["/home/EXAMPLE_USER/git/owner-prompts"]
  }
}
```

- `skills`: a list of absolute directory paths.
- `prompts`: a list of absolute directory paths.
- No other key is permitted. `extensions` and `themes` are not part of this contract.
- An entry is a path only. A glob, a `~` path, a relative path and a Pi filter directive are rejected.
- One path can be in the two lists. A duplicate is counted inside one list.

The kit adds no default entry. Pi reads `~/.agents/skills` on its own; do not list it. The kit does not detect that directory in a list: the validator does not know the home directory, so the absolute form of that path passes. Not verified: the result is a name collision warning for each skill.

The example overlay `config/config.example.json` does not carry the key, and `scripts/examples.py` output is unchanged.

## Validation rules

Each diagnostic is static: the rule and the field path, never the input value. `<kind>` is `skills` or `prompts`.

| Rule | Field | Cause |
| --- | --- | --- |
| `object` | `overlay.ownerResources` | The value is not an object. |
| `unknown_fields` | `overlay.ownerResources` | The object has a key other than `skills` and `prompts`. |
| `array` | `overlay.ownerResources.<kind>` | The value is not a list. |
| `resource_count` | `overlay.ownerResources.<kind>` | The list has more than 64 entries. |
| `resource_whitespace` | `overlay.ownerResources.<kind>` | An entry starts or ends with whitespace, or has a segment that is only whitespace. Pi 1.0.3 trims an entry before it resolves the path, so such an entry names a different directory. A space inside a segment is permitted. |
| `resource_directive` | `overlay.ownerResources.<kind>` | An entry starts with `!`, `+` or `-`. Pi reads such an entry as a filter directive, not as a path. |
| `text`, `shell_or_template`, `absolute_path` | `overlay.ownerResources.<kind>` | The existing absolute-path rules of the overlay: absolute POSIX path, no `.` or `..` segment, no empty segment, no trailing `/`, no `$`, backtick, `{{`, `}}` or control character. The permitted segment characters exclude `*`, `?`, `~` and `:`. |
| `resource_path_length` | `overlay.ownerResources.<kind>` | An entry has more than 1024 characters. |
| `inside_target` | `overlay.ownerResources.<kind>` | An entry is `target.agentDir` or a path below it. The profile directory is host-only, and Pi discovers its `skills/` and `prompts/` directories on its own. |
| `kit_package` | `overlay.ownerResources.<kind>` | An entry is `packages/` of the kit root, a path below it, or a directory above it. A kit skill loads through its component in `selection` only. |
| `duplicate_resource` | `overlay.ownerResources.<kind>` | The list holds the same entry two times. |

The comparison for `inside_target`, `kit_package` and `duplicate_resource` is a string comparison. The validator does not resolve a symlink. Two different strings that name the same directory through a link are not detected; a link to a package directory of the kit passes. The validator does not compare an entry with an `ownerPackages` source.

The bounds (64 entries, 1024 characters) and the character class limit each path that `plan` prints.

## Rendering

`scripts/profile_plan.py` appends each `skills` entry to the `skills` array and each `prompts` entry to the `prompts` array of `settings.json`, after any kit entry, in overlay order. At this release the kit renders no entry of its own into these two arrays: a kit skill is a filter of its package entry in `packages`. An empty or omitted list renders no key.

- `plan` and `generate` list the entries under `ownerResources` in their output, always with the two keys `skills` and `prompts`. Each list is empty without the key. The output is deterministic JSON: sorted keys and fixed separators.
- Each entry adds the readiness gap `owner_resource_unqualified`. The subject is `skills:<path>` or `prompts:<path>`. The gap is permanent: the kit cannot prove that the directory exists or that Pi loads it.
- `.tenant-pi/choices.json` records the object at `/overlay/ownerResources`. The guarded writer rebuilds the plan from that record, so a changed entry in the plan is rejected with `invalid_plan: plan_mismatch: plan` before a write.
- No setup command and no launch line changes. `git pull` in the user repository is the update.
- The candidate holds no skill and no prompt file. `generate` writes the same files as before.

## Comparison

`compare` reports each rendered entry at `/skills/<index>` and `/prompts/<index>` of `settings.json`, and each recorded entry at `/overlay/ownerResources/skills/<index>` and `/overlay/ownerResources/prompts/<index>` of `.tenant-pi/choices.json`. An added or removed entry is an `added` or `removed` change. Each entry is a marker: the report never shows a path. A hand edit of an array inside a candidate shows as `owner_edits` drift on `/skills` or `/prompts`. The migration note is in [candidate comparison](candidate-compare.md).

Each index is positional. An entry inserted before another entry shows as a change of each later index.

`carry` turns a change of the recorded entries into one patch of the whole `skills` or `prompts` list, from the right side's overlay copy ([carrying drift](carry.md)).

A `skills` or `prompts` value that is not a list of strings is reported as `unsupported_shape`. A recorded `ownerResources` key other than `skills` and `prompts` is reported as `unsupported_field`.

## The `/resources` command

The kit component `resources` ([the resources page](resources.md)) reads the explicit entries of the `skills` and `prompts` arrays in `settings.json` and lists each skill and prompt that it finds there. It turns one item off with a `-<path>` entry in the same array, where the path is the item `id`. The owner directory entry stays in the array. This is read in the component source. Not verified in a live Pi session: Pi applies that entry to an item of an owner directory.

- Enable the component `resources` in `selection.enable` to get the command. `ownerResources` does not require it: Pi loads the arrays without the component.
- A toggle is an edit of a generated `settings.json`. The next `compare` shows it as `owner_edits` drift on `/skills` or `/prompts`. `ownerResources` cannot record a `-<path>` entry; such a toggle is accepted drift; see [accepted drift](accepted-drift.md).
- Not verified: the `/resources` toggle of an item in a directory outside the agent directory. The item `id` is then a path relative to the agent directory that starts with `../`. No test in this repository runs the component against a generated profile with `ownerResources`.

## Pi field semantics

Source: the documentation files of the Pi package `@earendil-works/pi-coding-agent`, version `1.0.3` (read from its `package.json`): `docs/settings.md`, `docs/packages.md`, `docs/skills.md` and `docs/prompt-templates.md`. The four files of Pi `1.0.3` are byte-equal to those of Pi `1.0.2`. The agent directory holds no Pi documentation file.

The documentation says:

- `skills` is a `string[]` with the default `[]`: "Skill files or directories." `prompts` is a `string[]` with the default `[]`: "Prompt-template files or directories." (`settings.md`, Resources)
- A resource path in user settings resolves from the agent directory. Absolute paths and `~` are supported. (`settings.md`)
- A resource array supports `!pattern` (glob exclusion), `+path` (exact inclusion) and `-path` (exact exclusion). Pi loads the resources of the user settings and of the project settings. (`settings.md`)
- A skill is a directory that contains `SKILL.md`. Such directories are discovered recursively. Pi also reads `~/.agents/skills/` and the project `.agents/skills/` directories. A name collision keeps the first discovered skill and gives a warning. (`skills.md`)
- A conventional prompt directory loads its direct `.md` children only. Settings and packages can select nested Markdown files. (`prompt-templates.md`)

## Limits and unproven claims

- Not verified: Pi loads the rendered arrays. The statements above are read in documentation only. No test in this repository starts Pi.
- Not verified: behavior at the kit pin `1.0.3`. The documentation read is that of Pi `1.0.3`. No test starts Pi.
- Not verified: a directory entry in the `prompts` array loads nested Markdown files, or the direct `.md` children only.
- Not verified: the result when one skill name exists in an owner directory and in a package or in `~/.agents/skills`. The documentation names a warning and "first discovered"; the discovery order across sources is not documented there.
- Not verified: a directory exists, is readable by the Pi process, or holds safe content. The kit makes no existence check by design. A skill can instruct the model to run a program; review the directory before you list it.
- Not verified: the `/resources` toggle of an owner directory item; see above.
- Out of scope: a copy of any skill or prompt, a read of skill content, a default for `~/.agents/skills`, a single file entry, a glob, a filter directive, `extensions` and `themes` directories, and project settings.

## Tests

`tests/test_owner_resources.py` covers the key through `validate`, `plan` and `generate`, each rule with a negative test and its exact diagnostic (also the entries that Pi would trim and the kit package directories), the bounds, the render order, the gaps, the choices record, the guarded writer, and the added, removed and changed comparison with a canary path that must not reach the report. No test creates or opens an owner directory.
