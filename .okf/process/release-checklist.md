---
type: Checklist
title: The release checklist
description: A portable release passes eight gates; each gate is recorded as passed, failed, blocked or not run, and the release notes go into a release entry on the snapshot tag.
tags: [release, gates, checklist, documentation-check]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
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
| 1. Offline unit tests | `python3 -m unittest discover -s tests -q` ends with `OK` | Yes |
| 2. Examples | `python3 scripts/examples.py` prints `examples valid` | Yes |
| 3. Sample overlay | `python3 scripts/validate.py --overlay config/config.example.json` prints `valid: ...` | Yes |
| 4. Publish set | `python3 scripts/publish_check.py` prints `publish set valid: ...` | Yes |
| 5. Scanner | `scripts/scan.sh all` exits with 0 | Yes |
| 6. Clean Linux core trial | A core-only profile on a clean Linux user, stages 1 to 9 | Yes |
| 7. Optional live services | Each optional module, the gateway and each MCP server | Report only |
| 8. Compose seat | The Compose files read and build | Report only |

Gates 1 to 4 are the four offline checks that the publisher runs itself. Gate 1 includes the documentation check of `scripts/doc_check.py`. Run the tests with `unittest`, not `pytest`: a pytest cache directory fails the publish check.

## The rules

- Record each gate as passed, failed, blocked or not run.
- Never write "passed" for a gate that did not run.
- Do not write "all modules work" when only the core trial ran.
- A pin move with a fast track records gate 6 as not run; it is not a full qualification.

## The publish steps

1. Commit every change on the source branch.
2. Run gates 1 to 5 and record the last line of each.
3. Build the snapshot with `--no-push`, and inspect it with `git show portable --stat`.
4. Push only after the maintainer approves the release.
5. Write the release notes after the last gate, as a release entry on the tag.

The snapshot holds no notes file, because a later file changes the tested tree. Check the notes against the public reader rules before you create the entry; the publish check does not read them.

## The documentation check

`scripts/doc_check.py` checks the Markdown files of `PUBLISH`: links, anchors, JSON examples, and the actions and flags of `tenant_pi.py`. It prints `doc check valid: ...` or one finding per line. The package documents under `packages/` and the pages of this bundle are not in its file list.

## Links

- [The publishing flow and the snapshot](publishing.md)
- [The scan and the hooks](../security/scan-and-hooks.md)
- Source document: [the release checklist](../../docs/guides/release-checklist.md)
