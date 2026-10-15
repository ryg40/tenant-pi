---
type: Configuration File
title: The private overlay
description: overlay.json holds the private choices of one client; the kit validates it offline, and it holds no secret value, only names and references.
tags: [overlay, configuration, private]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: readme
    resource: ../../README.md
    title: The stages and the facts of the release (README.md)
  - id: private-directory
    resource: ../../docs/private-directory.md
    title: The private directory (docs/private-directory.md)
  - id: privacy
    resource: ../../docs/guides/privacy.md
    title: The privacy guide, section Credentials (docs/guides/privacy.md)
  - id: example
    resource: ../../config/config.example.json
    title: The synthetic sample overlay (config/config.example.json)
---
# The private overlay

The overlay is one JSON file with the choices of one client: the target directory, the selected components, the consents and the module choices. It is the "local overlay" of the glossary. It lives in the private directory, outside the kit clone, and never in a tracked file of the kit.

## What the overlay holds

| Key | Holds |
| --- | --- |
| `target.agentDir` | The absolute path of the new profile directory. |
| `selection.enable`, `selection.disable` | The component ids of `config/manifest.json`. |
| `consent` | Explicit consents, for example `memoryCapture` and `remoteMemoryWrites`. |
| `roles` | Model choices for roles such as `interactive` and `memory`. |
| `endpoints`, `env` | A public endpoint URL and `${NAME}` references to environment variables. |
| `inputs` | Fixed input slots, for example the MCP definitions file. |
| `memory` | The choices of each enabled memory module. |
| `modelRoutes` | Optional model cycle and gateway choices. |

The tracked sample `config/config.example.json` enables only `core`. It is synthetic. Its target is the fake path `/home/EXAMPLE_USER/new-agent`, and `validate`, `plan` and `generate` refuse it.

## Rules

- The overlay has no field for a secret value. An `env` value is a `${NAME}` reference.
- The kit rejects `$`, backticks and `{{` outside such a reference.
- A configured credential name, an endpoint or a reachable service never enables memory capture. Each module needs its own selection, and a memory module also needs its consents and its choices.
- `compare` shows a marker, not a value, for a private field. A `carry` patch prints overlay values, so treat its output like the overlay.

## The private directory

`init-private` creates the private directory with the overlay, a model registry, an install log, an accepted-drift list, a `.gitignore` and an `inputs/` directory. These files are the record that a second host or a recovery starts from. The model registry here is the offline capability map of the model routes. It is not the registry of the shared memory.

## Links

- [The command line and the generator](generator.md)
- [The private directory](../security/private-directory.md)
- [The credentials of the modules](../security/module-credentials.md)
- Source documents: [the private directory](../../docs/private-directory.md), [the privacy guide](../../docs/guides/privacy.md#credentials)
