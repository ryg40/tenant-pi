---
type: Command-Line Tool
title: The command line and the generator
description: scripts/tenant_pi.py validates the overlay, plans the profile and writes it with a guarded writer into a new target that it refuses in four unsafe places.
tags: [cli, generator, validate, plan, generate]
resource: ../../scripts/tenant_pi.py
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: generator
    resource: ../../docs/generator.md
    title: The offline profile CLI (docs/generator.md)
  - id: readme
    resource: ../../README.md
    title: The command line table (README.md)
  - id: privacy
    resource: ../../docs/guides/privacy.md
    title: The privacy guide (docs/guides/privacy.md)
---
# The command line and the generator

`scripts/tenant_pi.py` is the one command line of the kit. It uses the Python 3.11 standard library. Its actions read explicit JSON inputs and never a live Pi settings file.

## The main actions

| Action | What it does |
| --- | --- |
| `validate` | Checks the overlay offline. Writes nothing. |
| `plan` | Lists the files, the readiness gaps and the display-only commands. Writes nothing. |
| `generate` | Writes a new profile into an absent target. With `--launcher`, also a launcher file. |
| `init-private` | Creates the private directory from templates. |
| `compare`, `carry` | Compare two profiles; print overlay patches from the report. |
| `inventory`, `list`, `components` | Read-only lists of resources, candidates and components. |
| `check-runtime`, `check-herdr` | Compare the installed Pi, Node and Python with the pins; report the `herdr` command. |

`python3 scripts/tenant_pi.py --help` lists every action. Each action has its own `--help`.

## What `generate` writes

- `settings.json`, `.tenant-pi/choices.json` and `.tenant-pi/state.json`.
- At most two module files: `hermes-memory-config.json` with the Hermes module and `mcp-adapter.json` with the MCP module.
- Directories get mode `0700`. Files get mode `0600`.

The target must not exist, and its parent must exist and belong to the caller. The writer never installs a package and never launches Pi. A failure before publication leaves an incomplete candidate and no launch instruction. No automatic rollback happens.

`.tenant-pi/state.json` holds a provenance record with no secret: the kit schema, the Pi pin, the Node range, the enabled components, the declared outputs, the generation time `generatedAt` and the kit commit `kitCommit`.

## The target refusals

`validate`, `plan` and `generate` refuse a `target.agentDir` in four places, before any write, with exit code 2:

| Rule | Refused target |
| --- | --- |
| `under_kit` | The kit clone, or a path under it. |
| `sample_target` | The sample target of `config/config.example.json`. |
| `under_pi_agent` | The live profile `~/.pi/agent`, or a path under it. |
| `under_wiki_vault` | The personal wiki vault `~/.llm-wiki`, or a vault that `WIKI_HOME` or `memory.wiki.wikiHome` names. |

Limit: `under_kit` covers only the clone that runs the action. A second clone, or the main clone when the action runs from a Git worktree, is not protected.

## The input loader

Each JSON input goes through one loader. It reads a regular file of at most 1 MiB, follows no symbolic link, and refuses JSON that nests deeper than 64 levels. A refusal names one cause, for example `input_missing`, `input_too_large` or `duplicate_key`. The diagnostic holds no path and no file content.

## Links

- [The profile plan](profile-plan.md)
- [The private overlay](private-overlay.md)
- [The private directory](../security/private-directory.md)
- Source documents: [the offline profile CLI](../../docs/generator.md), [the privacy guide](../../docs/guides/privacy.md#what-the-kit-never-does)
