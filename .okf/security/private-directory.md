---
type: Security Control
title: The private directory
description: init-private creates one private directory per host, outside the clone, with the overlay, the model registry, the install log and the accepted-drift list; its .gitignore is not a security control.
tags: [security, private-directory, overlay, init-private]
resource: ../../scripts/private_init.py
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: private-directory
    resource: ../../docs/private-directory.md
    title: Private directory (docs/private-directory.md)
  - id: privacy
    resource: ../../docs/guides/privacy.md
    title: The privacy guide, section What each location holds (docs/guides/privacy.md)
---
# The private directory

The private directory holds the choices of one host: the files that a second host or a recovery starts from. The kit clone holds no user value, so the private directory lives outside it. `init-private` creates it in one fixed shape.

## The command

```sh
python3 scripts/tenant_pi.py init-private --dir /home/EXAMPLE_USER/.config/tenant-pi --target /home/EXAMPLE_USER/.pi/profiles/main
```

The `--dir` path must be absolute and must not exist yet. The action refuses a directory inside the clone, inside `~/.pi/agent` and inside a known overlay target.

## What it creates

| Path | Mode | Content |
| --- | --- | --- |
| `<dir>` | `0700` | The directory. |
| `overlay.json` | `0600` | A copy of the sample overlay, with the target of `--target`. |
| `registry.json` | `0600` | An empty model registry. |
| `install-log.md`, `accepted-drift.md` | `0600` | Templates. |
| `.gitignore` | `0600` | Ignore rules for secrets and local state. |
| `inputs/` | `0700` | The input slots, for example `inputs/mcp-adapter.json`. |

## Where private state lives

| Location | Holds | Tracked by Git |
| --- | --- | --- |
| The kit clone | Reviewed source and synthetic examples. No user value. | Yes |
| `.local/` in the clone | Optional local state and the local deny list of the scanner. | No |
| The private directory | The overlay, the registry, logs, launcher files and results files. | Only if the user runs `git init` there |
| A generated profile | `settings.json`, `.tenant-pi/`, and after launch `auth.json`, sessions and module state. | No |

Warning: the `.gitignore` of the private directory and the ignore rule of `.local/` are not security controls. A secret in a file with another name is not ignored. Read `git status` before each commit, and do not write a secret value into the overlay, the registry or the two Markdown files.

## Links

- [The private overlay](../kit/private-overlay.md)
- [The credentials of the modules](module-credentials.md)
- Source documents: [the private directory](../../docs/private-directory.md), [the privacy guide](../../docs/guides/privacy.md#what-each-location-holds)
