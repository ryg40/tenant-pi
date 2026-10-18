---
type: Checklist
title: The release checklist
description: A portable release records one offline check-set stamp and the remaining gates, with release notes on the snapshot tag.
tags: [release, gates, checklist, documentation-check]
generated: {by: pi/astra, at: 2026-10-18T04:35:00Z}
sources:
  - id: checklist
    resource: ../../docs/guides/release-checklist.md
    title: The release checklist (docs/guides/release-checklist.md)
  - id: pin-move
    resource: ../../docs/guides/pin-move-release.md
    title: Pin move and release (docs/guides/pin-move-release.md)
---
# The release checklist

A portable release is a snapshot of the reviewed publish set on the branch `portable`. The checklist lists the gates before a snapshot and the steps that publish it. A passed gate is a fact for this release only.

## The gates

| Gate | Evidence | Required |
| --- | --- | --- |
| 1. The check set (replaces gates 1 to 4) | `python3 scripts/check.py` ends with `check: passed`; record the stamp | Yes |
| 5. Scanner | `scripts/scan.sh all` exits with 0 | Yes |
| 6. Clean Linux core trial | A core-only profile on a clean Linux user, stages 1 to 9 | Yes |
| 7. Optional live services | Each optional module, the gateway and each MCP server | Report only |
| 8. Compose seat | The Compose files read and build | Report only |

Gate 1 replaces the former gates 1 to 4. Gates 5 to 8 keep their numbers.
The unit suite includes examples, the sample overlay, documentation and generated-page checks.
The full check set also checks the publish set, public reader rules and whitespace.
The publisher reuses a matching clean-tree stamp instead of repeating the check set.
Run the tests with `unittest`, not `pytest`: a pytest cache directory fails the publish check.

## The rules

- Record each gate as passed, failed, blocked or not run.
- Never write "passed" for a gate that did not run.
- Do not write "all modules work" when only the core trial ran.
- A pin move with a fast track records gate 6 as not run; it is not a full qualification.

## The publish steps

1. Commit every change on the source branch.
2. Run the check set once and gate 5. Keep the stamp and scanner result lines.
3. Build the snapshot with `--no-push`, and inspect it with `git show portable --stat`.
4. Run the publisher once to push after approval. Both publisher runs reuse the matching stamp.
5. Write the release notes after the last gate, as a release entry on the tag.

The release notes copy the stamp's tree hash, time, result lines, client and skipped count into one check-set block.
The snapshot holds no notes file, because a later file changes the tested tree. Check the notes against the public reader rules before you create the entry; the publish check does not read them.

## The documentation check

`scripts/doc_check.py` checks the Markdown files of `PUBLISH`: links, anchors, JSON examples, and the actions and flags of `tenant_pi.py`. It prints `doc check valid: ...` or one finding per line. The package documents under `packages/` and the pages of this bundle are not in its file list.

## Links

- [The publishing flow and the snapshot](publishing.md)
- [The scan and the hooks](../security/scan-and-hooks.md)
- Source document: [the release checklist](../../docs/guides/release-checklist.md)
