---
type: Security Control
title: The credentials of the modules
description: The kit stores, prints and resolves no secret; modules get credentials at run time from the launching shell, Pi's own login, the keyring or an AWS profile, and every profile of one user shares those sources.
tags: [security, credentials, modules, sandbox]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: privacy
    resource: ../../docs/guides/privacy.md
    title: The privacy guide, sections Credentials and Component reads, requests and writes (docs/guides/privacy.md)
  - id: packages
    resource: ../../docs/packages.md
    title: In-tree packages, facts for a selection (docs/packages.md)
  - id: memory-modules
    resource: ../../docs/memory-modules.md
    title: The memory modules (docs/memory-modules.md)
  - id: model-routes
    resource: ../../docs/model-routes.md
    title: The model-route contract (docs/model-routes.md)
---
# The credentials of the modules

The kit writes, prints and resolves no secret value. A module that needs a credential reads it at run time, after the user launches Pi. This page lists where each kind of credential comes from and what the kit does with it.

## What the kit does

- The overlay has no field for a secret value. An `env` value is a `${NAME}` reference.
- No credential store is required. The user exports the name in the launching shell, or reads it from a store that the user already has.
- `.tenant-pi/choices.json` holds names and references, never a resolved secret.
- `plan` tests a fixed list of provider key names for presence, never for a value.

## Where each module gets its credential

| Module or route | Credential source | The kit |
| --- | --- | --- |
| Native model route | Pi `/login` writes `auth.json` in the profile. | Writes no auth file and copies none between profiles. |
| Gateway route (`codex-accounts`) | `TENANTEXT_LITELLM_API_KEY` in the launching shell. | Holds the name only. The base URL is public configuration. |
| `mcp` | `${NAME}` references in the definitions; OAuth and bearer tokens in the keyring of the operating system. | Checks no reference. Gap `credential_store_shared`. |
| `openviking` | `OPENVIKING_*` variables or the user's OpenViking client files. | Writes and reads none of them; has no overlay field for them. |
| `agentcore` | The AWS profile that the person config names, else the default AWS SDK credential chain. | Never opens the person config; the config holds no key. |
| `wiki` embeddings | An environment reference or a fixed non-secret placeholder. | Needs `consent.embeddingTextTransfer`. |
| `context-meter` | The variable that `nextMoveKeyEnv` names, as a Bearer header to `nextMoveUrl`. | Sends nothing while the URL is empty. |
| `copilot-usage`, `anthropic-usage`, `doctor` | The existing logins of the user, sent to provider usage endpoints. | The checklist marks them; their login reads need the user's agreement. |
| `coordinator-skills` | `GITEA_TOKEN` for the Gitea API of the issue tracker. | Declares the name. |

## A profile is not a sandbox

Every profile of one operating-system user shares these sources:

- `HOME` and every file below it, including the logins that the usage modules read.
- The keyring of the operating system.
- The environment of the launching shell.
- A remote account: two profiles with the same login see the same account data.

For a real boundary, run each profile as a separate user, in a container or in a virtual machine, with separate remote accounts. Not verified: any container or sandbox setup with this kit.

## The shared memory keys

Each person has one access key in an AWS profile named `pi-memory-person-<actorId>`, in the shared credentials file with mode `0600`. The key travels once, in a one-time link with a password told on a second channel. The repository, the person config and every log hold no key. The scan hooks refuse a commit with a key pattern.

## Links

- [The private overlay](../kit/private-overlay.md)
- [The identities of the shared memory](../shared-memory/identities.md)
- [The shared memory security review](shared-memory-review.md)
- Source documents: [the privacy guide](../../docs/guides/privacy.md#credentials), [secret handling](../../docs/secret-handling.md)
