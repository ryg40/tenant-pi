# Accepted drift in the overlay

Status: offline implementation. The kit validates the list, records it, and uses it to sort the `compare` report. It writes no accepted value into a profile. Concept and tier model: [the profile lifecycle](profile-lifecycle.md).

Accepted drift is a `settings.json` difference that the user reviewed one time and decided to keep outside the overlay, for example an `npmCommand` wrapper for package updates. The overlay key `unmanaged` records the decision. Each later `compare` reports the difference under `accepted` with the reason, not under `changes` or `unsupported`.

Acceptance covers the field, not the reviewed value. A later change of an accepted field stays accepted, and `compare` shows no value for it. This also applies to `defaultProjectTrust`, `enableAnalytics` and `enableInstallTelemetry`. `drift.fields` of the side that carries the edit is the only place where the edit still shows, and it shows the field name only. List a pointer only when every later value of that field is acceptable.

## Overlay form

`unmanaged` is an optional top-level key of the overlay. Its value is a list of at most 200 objects with exactly two keys:

```json
{
  "unmanaged": [
    { "key": "/npmCommand", "reason": "Reviewed npm wrapper; kept on purpose." },
    { "key": "/llm-wiki/taskModel", "reason": "Reviewed model setting; kept on purpose." }
  ]
}
```

- `key` is a pointer into `settings.json`. The whole grammar is `^/[A-Za-z0-9_.:@-]+(/[A-Za-z0-9_.:@-]+)*$`. There is no wildcard, no `~0` or `~1` escape, and no empty segment.
- `reason` is free text for the user. It is not empty and not only whitespace, it has at most 200 characters, and it has no control character.

The example overlay `config/config.example.json` does not carry the key, and `scripts/examples.py` output is unchanged.

## Validation rules

Each diagnostic is static: the rule and the field path, never the input value.

| Rule | Field | Cause |
| --- | --- | --- |
| `array` | `overlay.unmanaged` | The value is not a list. |
| `unmanaged_count` | `overlay.unmanaged` | The list has more than 200 items. This rule is checked before any item. |
| `object` | `overlay.unmanaged.item` | An item is not an object. |
| `required_fields` | `overlay.unmanaged.item` | An item has no `key` or no `reason`. |
| `unknown_fields` | `overlay.unmanaged.item` | An item has a key other than `key` and `reason`. |
| `pointer` | `overlay.unmanaged.item.key` | The key is not a string or does not match the grammar. A trailing newline also fails. |
| `reason_required` | `overlay.unmanaged.item.reason` | The reason is not a string, is empty, or is empty after Python `str.strip()` (only whitespace). |
| `reason_length` | `overlay.unmanaged.item.reason` | The reason has more than 200 characters. A character is one Unicode code point. |
| `reason_control_character` | `overlay.unmanaged.item.reason` | The reason has a character of Unicode category `Cc`: U+0000 to U+001F, U+007F, or U+0080 to U+009F. |
| `duplicate_pointer` | `overlay.unmanaged.item.key` | Two items have the same `key`. The comparison is an exact string comparison. |

The validator does not check that a pointer names a field that exists, and it does not check that the kit leaves the field alone. A pointer that matches no difference has no effect.

A reason is not a Pi list entry and is never written to `settings.json`, so a reason that starts with `-` or `!` has no special meaning. A pointer always starts with `/`.

## Plan and generate

- `plan` and `generate` echo the list under `unmanaged` in their output, in overlay order. The list is empty without the key. The output is ASCII JSON: a non-ASCII character of a reason shows as a `\u` escape.
- `.tenant-pi/choices.json` records the list at `/overlay/unmanaged`. The guarded writer rebuilds the plan from that record, so a changed record or an extra settings key in the plan is rejected before a write.
- The list changes nothing else. `settings.json`, the readiness gaps and the commands are the same as without the key. The kit does not copy an accepted value into a new candidate. The user applies the value by hand after review, or Pi writes it.

## Comparison

`compare` reads the list from `.tenant-pi/choices.json` of each side. A pointer that either side lists is accepted for both sides. A side without metadata, for example a live profile with only `settings.json`, is covered by the record of the other side.

### The field-path form

A pointer is compared as an exact string with the `field` value that the report uses for `settings.json`. `compare` does not resolve a pointer into a value and does not compare by prefix. The forms are:

| Report `field` | Meaning |
| --- | --- |
| `/<key>` | A top-level key. A reviewed key (`defaultProjectTrust`, `enableInstallTelemetry`, `enableAnalytics`, `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`, `modelThinkingLevels`, `extensions`) is one field with its whole value. A key that the comparison does not know, for example `/npmCommand`, is one `unsupported_field` entry. |
| `/packages/<index>/source`, `/packages/<index>/resources` | One entry of `packages`, by position. A plain string entry has only `source`. |
| `/packages` | Only when `packages` has an unexpected shape. |
| `/llm-wiki/<key>` | One key of the `llm-wiki` section. `/llm-wiki` alone is used only when the section is not an object. |

Consequences:

- `/packages` does not accept `/packages/0/source`. Each field path needs its own item.
- A package index is positional. An entry inserted before an accepted entry moves the index, and the acceptance no longer matches.
- A key name with a character outside `A-Za-z0-9_.:@-` shows as `/<redacted>` in the report. No pointer can match it, so it cannot be accepted.
- A pointer applies to `settings.json` only. A field with the same path in another file is not accepted.

### The `accepted` list

An accepted difference leaves `changes` or `unsupported` and enters `accepted`:

```json
{"file": "settings.json", "field": "/npmCommand", "side": "right", "status": "unsupported_field", "reason": "Reviewed npm wrapper; kept on purpose."}
{"file": "settings.json", "field": "/defaultProjectTrust", "change": "changed", "reason": "Reviewed; kept on purpose."}
```

- An entry that comes from `unsupported` keeps its `side` and `status`. A key that both sides carry gives one entry for each side.
- An entry that comes from `changes` keeps its `change` (`added`, `removed`, `changed`). It never carries a `left` or `right` value, also for a field with a public form.
- A listed field that is equal on both sides stays in `unchanged`.
- `summary.accepted` is the length of the list. `summary.added`, `summary.removed`, `summary.changed` and `summary.unsupported` count only the entries that are not accepted.
- When both sides list the same pointer with different reasons, the report shows the reason of the right side.
- The list is sorted by file, field, change, side and status. Two runs on unchanged inputs print identical bytes.

The recorded list itself is compared as markers at `/overlay/unmanaged/<index>` of `.tenant-pi/choices.json`. An added, removed or reordered item is a change there. The item content is not shown in `changes`.

### A hand-edited record

`compare` applies the validation rules again before it uses a recorded list. A list that fails any rule accepts nothing, and the report has one `unsupported_shape` entry at `/overlay/unmanaged` of `.tenant-pi/choices.json` for that side. No part of the invalid list is echoed.

### What does not change

`left.drift` and `right.drift` are not filtered. An accepted hand edit still appears in `drift.fields` of the side that carries it, and `drift.status` stays `owner_edits`. Because acceptance covers the field and not a value, this section is the only signal of a later edit of an accepted field.

## Limits and unproven claims

- Not verified: any behavior on a real host. All tests use synthetic candidates and a temporary settings-only directory. No test reads a live Pi profile.
- A validator that does not accept `unmanaged` cannot calculate drift from the recorded overlay.
- Not verified: the field paths above cover every key that Pi 1.x writes to `settings.json`. A nested key outside `packages` and `llm-wiki` is reported only at its top-level key.
- The reason is user text. The kit bounds its length and character class and does not inspect its content. Do not put a secret value into a reason: `plan`, `generate` and `compare` print it.
- Characters of Unicode categories other than `Cc`, for example format characters, are permitted in a reason. They reach the output only as `\u` escapes.
- Out of scope: wildcard pointers, acceptance of a file other than `settings.json`, and any write of an accepted value to a profile.

## Tests

`tests/test_unmanaged.py` covers each rule with a positive and a negative test and its exact diagnostic, the plan echo and the choices record, the guarded writer, a comparison with one accepted and one unaccepted difference, the exact-path matching, the either-side rule for an unsupported key and for a changed field, the item bound, a hand-edited record, and byte equality of two reports through the module and through the CLI.
