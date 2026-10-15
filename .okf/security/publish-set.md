---
type: Security Control
title: The publish set and the public reader rules
description: scripts/publish_check.py accepts only the explicit publish list and the directory rules, scans each published file for key and token patterns, and refuses content of four classes that a public reader must not see.
tags: [security, publish-set, public-reader-rules, publishing]
resource: ../../scripts/publish_check.py
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: publishing
    resource: ../../docs/publishing.md
    title: Publishing portable snapshots, sections on the publish set and the public reader rules (docs/publishing.md)
  - id: checklist
    resource: ../../docs/guides/release-checklist.md
    title: Add a file to the publish set (docs/guides/release-checklist.md)
---
# The publish set and the public reader rules

A portable snapshot holds only the files of the publish set. The publish check decides which files that is, and it refuses content that would expose the private copy to a public reader. A reader of the published copy can run the same check.

## Which files publish

| Rule | Effect |
| --- | --- |
| `PUBLISH` | An explicit list of file paths in `scripts/publish_check.py`. |
| `PUBLISH_DIRS` | One rule per directory: every tracked file below it, except the listed excludes. This bundle has the rule `(".okf", ())`. |
| `scripts/dev-only-files.txt` | An optional, reviewed exclusion list of the private copy. It is never published. |

A tracked file outside these rules fails the check with `unreviewed_file`. An untracked file below a directory rule fails too. The check scans each published file for private-key and token patterns.

## The public reader rules

| Rule id | Finds |
| --- | --- |
| `tracker-reference` | The word for an issue or a ticket followed by a number, a planning map with a number, or a decision with a letter code. |
| `machine-path` | A path of the administrator's home directory or of the stack directory of one host. |
| `host-record` | A record of work on one host: a record word or a host phrase with a date in the same line. |
| `host-value-<n>`, `host-value-local-<n>` | A pattern of the tracked or the local deny list, in any case. |

Write the lasting fact in place of such content, for example "Not verified: ...". A finding line never holds text of the file or a pattern of a deny list.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public
```

The first command stops at the first finding. The second lists every finding of the whole publish set, then a count.

## Limits

- A pattern finds a form, not a meaning. An account name or a host name is a finding only when a deny list holds it.
- No rule finds a path in the home directory of a real user, a name of a person or an agent, or a provider or model choice of one host. Review a new file before you list it.
- The check reads the working tree, not the Git history or a commit message. The scan reads those.

## Why this bundle is in the publish set

The bundle is published with example names only. Each page must pass the public reader rules, so a page holds no real person name, account value, memory id, host name, host path or tracker number.

## Links

- [The scan and the hooks](scan-and-hooks.md)
- [The publishing flow and the snapshot](../process/publishing.md)
- Source document: [the public reader rules](../../docs/publishing.md#public-reader-rules)
