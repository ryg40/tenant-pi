---
type: Security Control
title: The scan and the hooks
description: scripts/scan.sh runs a pinned gitleaks in a container without network to stop secrets, host values and unreadable files before they reach a remote; Git hooks run it on each commit, merge and push.
tags: [security, scan, gitleaks, hooks, host-values]
resource: ../../scripts/scan.sh
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: secret-handling
    resource: ../../docs/secret-handling.md
    title: Secret handling (docs/secret-handling.md)
  - id: privacy
    resource: ../../docs/guides/privacy.md
    title: The privacy guide, section What the scanner checks (docs/guides/privacy.md)
---
# The scan and the hooks

`scripts/scan.sh` stops a secret or a host value before it goes to a remote. A host value is text that identifies a private host: its private network, host names, owner names and state directories. The scan needs no network.

## What the scan finds

| Finding | Source | Result |
| --- | --- | --- |
| Secret | The default rules of gitleaks v8.28.0 in `.gitleaks.toml` | Always fails. |
| Host value | The deny lists and `scripts/host-values.regex` (private address ranges) | Fails at level `fail`, warns at level `warn`. |
| Policy | A tracked `.gitleaksignore` or baseline, a tracked file in `.local/`, a tracked archive or database dump | Always fails. |

The output gives the file, the line and the rule, never the secret value.

## The deny lists

| File | Tracked | Content |
| --- | --- | --- |
| `scripts/host-values.deny` | Yes | Generic patterns only. |
| `.local/host-values.deny` | No | The values of one host. |

A value of a real host goes only into the local list of that host. Do not copy a line of the local list into a tracked file, a report or a commit message. For a local rule, the scan prints the rule id only, so the value never appears on a screen or in a log.

An allow list of exact URLs and a list of accepted lines by hash can drop a host-value finding. Neither list hides a secret or a policy finding. A maintainer adds an entry only after a decision.

## Modes and levels

| Mode | Reads |
| --- | --- |
| `tree` | Tracked files and the staged content. |
| `staged` | The staged changes only. |
| `history [<range>]` | Each commit of the range, including the commit messages. |
| `all` | `tree` and `history`. |
| `selftest` | The negative control. |

The level is `fail` on the branch `portable` and on a tag `portable/*`, and `warn` on other branches.

## The hooks

`scripts/install-hooks.sh` installs a dispatcher and sets `core.hooksPath`. `--check` exits 0 when the hooks are installed and current.

| Hook | Scan |
| --- | --- |
| `pre-commit`, `pre-merge-commit` | `scan.sh staged` |
| `pre-push` | `scan.sh history` for the commits that the push sends |

A hook fails closed: without Docker or the scanner image, the commit or the push stops.

Warning: `git commit --no-verify` and `git push --no-verify` skip the hooks. Run `scripts/scan.sh all` before a publication.

## Blind spots

- An encoded or encrypted secret is not found, unless a rule matches the encoded form.
- Author and committer names, tag messages and notes are not scanned.
- The scan does not read untracked files, the private directory or a generated profile.

## Links

- [The publish set and the public reader rules](publish-set.md)
- [The publishing flow and the snapshot](../process/publishing.md)
- Source document: [secret handling](../../docs/secret-handling.md)
