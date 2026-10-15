---
type: Package Group
title: The in-tree packages
description: The packages under packages/ hold the sources of the optional Pi extensions, the vendored OpenViking copy and the shared AgentCore memory; each one has a directory rule of the publish set.
tags: [packages, components, publish-set]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:10:00Z}
sources:
  - id: packages
    resource: ../../docs/packages.md
    title: In-tree packages (docs/packages.md)
  - id: manifest
    resource: ../../config/manifest.json
    title: The component manifest (config/manifest.json)
  - id: publishing
    resource: ../../docs/publishing.md
    title: Directory rules for an in-tree package (docs/publishing.md)
---
# The in-tree packages

The directory `packages/` holds the source of each optional package that the kit ships. A package holds kit components, which a profile can load, or it is a library or a tool, which no profile loads. Each package has its own tests and documentation, and the kit requires Node `>=24.0.0 <25`.

## The packages

| Package | Kind | Content |
| --- | --- | --- |
| `packages/tenantext` | Kit components | A Pi extension suite with a Claude Code plugin. Each extension is one component; a skill component holds one skill or a group of skills. |
| `packages/promptr` | Kit components | The Promptr extension and four skills. |
| `packages/openviking-pi` | Kit component `openviking` | A vendored copy of the OpenViking extension for Pi. |
| `packages/agentcore-pi` | Kit component `agentcore` | The Pi extension of the shared AgentCore memory. |
| `packages/agentcore-memory-core` | Library | The core of the shared memory and the review CLI. |
| `packages/agentcore-claude` | Claude Code plugin | The recall hook and the MCP server of the shared memory. |
| `packages/agentcore-memory-admin` | Owner tool | The registry script for IAM provisioning, offboarding, purge and migration. |

## Kit components

Each extension and each skill or skill group of a package is one component of `config/manifest.json`, with the source kind `tree`: `{"kind": "tree", "path": "packages/<name>"}`. A generated profile declares each package once in `settings.packages`, with one filter entry for each enabled component. OpenViking and AgentCore are local-file sources: the profile names their `index.ts` file.

An `unverified` component can be enabled. The plan then lists each of its gaps as a readiness gap. A `blocked` component cannot be enabled.

## Install and test

- Install the Node dependencies of a package before Pi loads it, for example `npm --prefix packages/agentcore-memory-core ci --ignore-scripts`.
- The kit never runs this step. The plan prints it as a display-only setup line.
- The profile depends on the location of the kit. If you move the kit, generate a new profile.

## Publish rule

`PUBLISH_DIRS` in `scripts/publish_check.py` holds one rule for each package directory, for example `("packages/agentcore-pi", ("node_modules/",))`. A rule publishes every tracked file of the directory except its excludes. A new `tree` component of a new package needs its directory rule in the same change.

## Links

- [The workflow modules](workflow-modules.md)
- [The shared memory core](../shared-memory/core.md)
- [The publish set and the public reader rules](../security/publish-set.md)
- Source documents: [in-tree packages](../../docs/packages.md), [directory rules for an in-tree package](../../docs/publishing.md#directory-rules-for-an-in-tree-package)
