# Owner package paths in the overlay

Status: offline implementation. The kit validates the form of each entry and writes it into a new candidate. It does not open, install or load an owner package. Concept and tier model: [the profile lifecycle](profile-lifecycle.md).

An owner package is a Pi package directory that the user maintains in a separate repository, for example a private skills repository. The overlay key `ownerPackages` adds such a directory to `settings.packages` of a generated profile. No hand edit of `settings.json` is necessary.

## Overlay form

`ownerPackages` is an optional top-level key of the overlay. Its value is a list. Each item has one of two forms:

```json
{
  "ownerPackages": [
    "/home/EXAMPLE_USER/git/owner-skills",
    {
      "source": "/home/EXAMPLE_USER/git/owner-tools",
      "extensions": ["extensions/index.ts"],
      "skills": ["skills/example", "!skills/draft-*"],
      "prompts": []
    }
  ]
}
```

- String form: one absolute path. Pi applies no filter.
- Object form: `source` is required. `extensions`, `skills` and `prompts` are optional filter lists. An omitted list stays omitted in `settings.json`. No other key is permitted; `themes` is not part of this contract.

A filter entry is one of two things:

- A relative POSIX path. Each segment uses the characters `A-Z a-z 0-9 _ . - space`. A segment `.` or `..`, an empty segment and a leading `/` are not permitted.
- A Pi exclusion: `!` followed by a relative pattern. The pattern also permits `*` and `?`. A `..` segment is not permitted.

A segment cannot start or end with a space, in a path or in a pattern.

Other Pi filter prefixes (`+`, `-`) and a glob without `!` are rejected. A list cannot hold the same entry two times.

The example overlay `config/config.example.json` does not carry the key, and `scripts/examples.py` output is unchanged.

## Validation rules

Each diagnostic is static: the rule and the field path, never the input value.

| Rule | Field | Cause |
| --- | --- | --- |
| `array` | `overlay.ownerPackages` | The value is not a list. |
| `object` | `overlay.ownerPackages.item` | An item is not a string and not an object. |
| `required_fields` | `overlay.ownerPackages.item` | An object has no `source`. |
| `unknown_fields` | `overlay.ownerPackages.item` | An object has a key other than `source`, `extensions`, `skills`, `prompts`. |
| `text`, `shell_or_template`, `absolute_path` | `overlay.ownerPackages.item.source` | The existing absolute-path rules of the overlay: absolute POSIX path, no `.` or `..` segment, no empty segment, no trailing `/`, no `$`, backtick, `{{`, `}}` or control character. An `npm:` or `git:` source fails with `absolute_path`. |
| `duplicate_source` | `overlay.ownerPackages.item.source` | Two items have the same `source`. |
| `duplicate_package` | `overlay.ownerPackages.item.source` | The `source` equals a package directory that the kit declares (each `tree` component path of the manifest, enabled or not). |
| `package_filter` | `overlay.ownerPackages.item.extensions`, `.skills`, `.prompts` | The filter is not a list, has a duplicate entry, or has an entry that is not a permitted path or exclusion. |

The comparison for `duplicate_source` and `duplicate_package` is an exact string comparison. The validator does not resolve a symlink and does not compare by containment. Two different strings that name the same directory through a link are not detected.

## Rendering

`scripts/profile_plan.py` appends each item to `settings.packages` after every kit declaration (in-tree packages, memory packages, the MCP adapter), in overlay order. A string item stays a string. An object item keeps exactly the keys the overlay gives.

- `plan` and `generate` list the items under `ownerPackages` in their output. The list is empty without the key.
- Each item adds the readiness gap `owner_package_unqualified` with the `source` path as the subject. The gap is permanent: the kit cannot prove that the path exists or that Pi loads it.
- `.tenant-pi/choices.json` records the items at `/overlay/ownerPackages`. The guarded writer rebuilds the plan from that record, so a changed owner entry in the plan is rejected with `invalid_plan: plan_mismatch: plan` before a write.
- No setup command changes. The kit prints no install or update command for an owner package. `git pull` in the user repository is the update.

## Comparison

`compare` reports each rendered entry at `/packages/<index>/source` of `settings.json` and each recorded item at `/overlay/ownerPackages/<index>` of `.tenant-pi/choices.json`. An added or removed owner package is an `added` or `removed` change. The path and the filter are private: the source shows `unsupported_value` and the other fields are markers. A hand edit of an owner entry inside a candidate shows as `owner_edits` drift on `/packages`. The migration note is in [candidate comparison](candidate-compare.md).

The two indexes count different lists: `/packages/<index>` counts the kit declarations first and then the user items, while `/overlay/ownerPackages/<index>` counts the user items only. Each index is positional. An item inserted before another item shows as a change of each later index.

## Limits and unproven claims

- Not verified: Pi 1.x loads a `settings.packages` entry of each rendered form. The form follows the Pi package settings form that this kit already renders for its in-tree packages (a `source` path with filter lists) and the plain string form. No test in this repository starts Pi.
- Not verified: the meaning Pi gives to a filter list that holds only `!pattern` exclusions, and the exact pattern grammar of Pi. The validator accepts a conservative subset.
- Not verified: an omitted filter list loads every resource of that kind. An empty list loads none in the kit's own declarations; see `docs/packages.md`.
- Not verified: the path exists, is a Pi package, is readable by the Pi process, or holds safe code. The kit makes no existence check by design.
- Not verified: behavior at the kit pin `1.0.3`. No test starts Pi.
- Out of scope: `npm:` and Git sources (they stay kit components), install, `npm ci`, and any change to `overlay.paths`, which stays the component path map.

## Tests

`tests/test_owner_packages.py` covers both forms through `validate`, `plan` and `generate`, each rule with a negative test and its exact diagnostic, the render order, the gaps, the choices record, and the added, removed and changed comparison with a canary path that must not reach the report.
