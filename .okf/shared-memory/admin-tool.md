---
type: Package
title: The AgentCore admin tool
description: packages/agentcore-memory-admin is the owner's registry script; it renders the IAM user, the inline policy and the person config of each person, and plans offboarding, purge and migration, with a dry run as the default.
tags: [agentcore, admin, registry, iam, offboarding]
resource: ../../packages/agentcore-memory-admin/
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T22:30:00Z}
sources:
  - id: admin-readme
    resource: ../../packages/agentcore-memory-admin/README.md
    title: The admin package README (packages/agentcore-memory-admin/README.md)
  - id: packages
    resource: ../../docs/packages.md
    title: The section AgentCore memory admin (docs/packages.md)
  - id: security
    resource: ../../docs/shared-memory-security.md
    title: Provisioning, key handoff, offboarding and migration (docs/shared-memory-security.md)
---
# The AgentCore admin tool

The admin tool is the owner's registry script, `bin/registry.mjs`. It turns the private registry into IAM users, inline policies and person config files. It is an owner tool: no manifest entry names it, and no profile loads it.

## One source with the core

`src/core.mjs` imports the registry functions from the core by the relative path `../../agentcore-memory-core/src/index.mjs`: the id rule, the namespace builder, the registry validation, the three scope functions and the person config. So the IAM policies of the admin tool and the local checks of the core come from one source. The core needs no installed dependency for these functions.

## The registry

The registry lists the memory, the two service identities, the people and the projects with their maintainers and members. The tracked `registry.example.json` holds the four example people only. The private registry stays outside every repository, with file mode `0600`.

The script checks a registry with its own rules first, then with the validation of the core. Its own rules add two things:

- A refusal names the field and the rule. A refusal of the core is only the static code `config`.
- The script refuses a duplicate PIN and a project without a maintainer; the core accepts both.

Together the two checks refuse an id with a wildcard, a duplicate id, an inactive member, a maintainer who is not a member, a project without a maintainer and an unknown field. A diagnostic never holds the value.

## The commands

| Command | Dry run (the default) | Apply step |
| --- | --- | --- |
| `render --person <actorId>` | The user name, the inline policy, its size and the person config. | None. |
| `provision --person <actorId>` | The plan and the policy. No AWS call. | Creates the user without console access, the inline policy, the tags and one access key; each step runs only on a difference. |
| `rotate --person <actorId>` | The plan. | Creates the second key and prints the command that deletes the first one after the handoff. |
| `offboard --person <actorId>` | The namespaces, records, key and user of the person. | Deletes the records, then the access keys, the inline policy and the user. |
| `purge --project <projectId>` | The exact rejected namespace of each person of the registry, or of one `--person`. | Deletes the listed records in batches of 100. |
| `migrate --owner <actorId>` | The exact old namespaces with their counts, and the policy changes. A deeper old path needs its own `--old-namespace` option. | Deletes the test records, moves the other listed records to `/actor/<actorId>/` and narrows the two service policies. |
| `check --profile <admin>` | Differences between live IAM and the registry. | None. |

## Safety rules

- The apply step needs `--apply --profile <admin>`. Only the coordinator runs it, with the owner's admin login, after a dry run and the owner's word.
- The apply step refuses the example registry and any registry file inside the repository.
- The provision apply opens the key file, mode `0600`, before it creates the key, so a file error cannot lose a key. The output names the file, never the key.
- The default key directory is `~/.local/state/agentcore-memory-admin/keys`. A directory inside the repository is refused.
- A dry run prints `<memoryId>` and `<account>` in place of the private values.
- Offboarding refuses before the first delete when the user has an item that the tool never creates, or when the person is the last maintainer of a project.
- Every list names one exact namespace, because the live store reads the namespace of a list as an exact match. No command sends a tree prefix.
- The list index lags one to five minutes behind a write, so a step right after a delete can list a record that is gone. A failed delete with the error code 404 counts as done. Any other failed delete or move stops the step and prints the id, the error code and the message of each failed record.

## Tests

```sh
npm --prefix packages/agentcore-memory-admin ci --ignore-scripts
node --test packages/agentcore-memory-admin/tests/
```

The tests use fake IAM, STS and memory clients. They need no AWS credential and no network.

Not verified: every apply step against IAM and the live store; the policy size of a real person with three or more projects.

## Links

- [The identities](identities.md), [the namespaces](namespaces.md)
- [The shared memory security review](../security/shared-memory-review.md)
- Source document: [the shared memory security review](../../docs/shared-memory-security.md#provisioning-a-person)
