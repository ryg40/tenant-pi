---
type: Process
title: The publishing flow and the snapshot
description: The publisher reuses a clean-tree check stamp or runs the full check set before it builds and pushes a portable snapshot.
tags: [publishing, snapshot, release, portable]
resource: ../../scripts/publish_portable.py
generated: {by: pi/astra, at: 2026-10-18T04:35:00Z}
sources:
  - id: publishing
    resource: ../../docs/publishing.md
    title: Publishing portable snapshots (docs/publishing.md)
  - id: readme
    resource: ../../README.md
    title: The snapshot mirror (README.md)
  - id: secret-handling
    resource: ../../docs/secret-handling.md
    title: Identities that leave with a portable snapshot (docs/secret-handling.md)
---
# The publishing flow and the snapshot

The maintainer keeps a private copy of the kit and publishes a clean copy. The publisher builds a separate snapshot history that holds only reviewed files. The published copy is a snapshot mirror: it takes no issues, and its history holds snapshots, not the source history.

## The command

```sh
python3 scripts/publish_portable.py --no-push   # build and tag locally, inspect first
python3 scripts/publish_portable.py             # checks, snapshot, tag, push
```

## What it does, in order

1. It refuses a dirty working tree. The snapshot comes from the committed `HEAD`.
2. It calls `check.py --stamp-status`. A matching stamp prints the tree, time, client, skipped count and result lines. Otherwise, it runs the full check set and requires `check: passed` with exit code 0. It also calls the publish check directly.
3. It builds a Git tree from `HEAD` with only the files of `PUBLISH` and of the `PUBLISH_DIRS` rules, through a temporary index.
4. It builds the snapshot commit, with the previous snapshot as its parent.
5. It moves the branch `portable` and creates the tag `portable/<yyyymmdd>-<source sha>` in one Git transaction.
6. It pushes the branch and the snapshot tag to the destination of `--remote` and `--remote-branch`.

An unchanged tree creates no commit and no tag.
A clean full check writes a local stamp in the common Git metadata directory, keyed by the source tree hash.
The stamp must match the check-set version, Python version and client details.
Build with `--no-push`, inspect, then run the publisher once to push after approval.
Both runs reuse the matching stamp. A missing or stale stamp triggers a new full check set.

## The neutral identity

The snapshot commit and the tag carry the identity `tenant-pi portable <portable@tenant-pi.invalid>` and no signature. The reason: a commit carries the Git identity of the host that writes it, and the scan does not read commit metadata. `TENANT_PI_PUBLISH_NAME` and `TENANT_PI_PUBLISH_EMAIL` change the identity.

## Options

| Option | Use |
| --- | --- |
| `--no-push` | Inspect with `git show portable --stat` before publishing. |
| `--new-root` | A parentless snapshot for a new, empty repository. Needs `--no-push`. |
| `--force` | Replaces the remote branch with `--force-with-lease`. Not for routine runs. |

Warning: `--force` can replace a remote history, but earlier remote tags can still expose its commits.

## The release entry

A tag can have a release entry on the publication service. The release entry holds the release notes of the snapshot: the result of each gate and the open gaps. A tag with no release entry has no release notes.

## Links

- [The release checklist](release-checklist.md)
- [The publish set and the public reader rules](../security/publish-set.md)
- [The scan and the hooks](../security/scan-and-hooks.md)
- Source document: [publishing portable snapshots](../../docs/publishing.md)
