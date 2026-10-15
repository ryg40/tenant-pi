# AgentCore memory admin

This package holds the registry script of the shared AgentCore Memory. The script reads the private registry of the owner and renders, for each person, one IAM user, one inline policy and the person config file. It also renders the two service policies, the offboarding plan, the purge of rejected records and the one-time migration of the old owner namespace.

A dry run is the default. A dry run changes nothing. The apply step runs only with `--apply --profile <admin>`. Only the coordinator runs it, with the owner's admin login, after a dry run and the owner's word.

The security review of the design is [the shared memory security document](../../docs/shared-memory-security.md). The namespace scope of each identity comes from the scope functions of the core contract (`packages/agentcore-memory-core/src/types.ts`), so the IAM policies and the local checks have one source.

## The registry

The registry follows the `Registry` type of the core contract: the memory (`region`, `memoryId`), the two service identities (`submitUser`, `workerReadUser`), the people (`actorId`, `name`, `email`, optional `pin`, `status`) and the projects (`projectId`, `maintainers`, `members`, optional `remotes`).

`registry.example.json` is the only registry in the repository. It holds four fake people (Alice, Bruno, Chen and Dana) and two fake projects. The PIN is a person number for a human reader, `XYZ` and four digits. It is not a credential.

The owner keeps the private registry on the owner host at `~/.config/agentcore-memory-admin/registry.json`, file mode 0600, outside every repository. It holds the real memory id and the real IAM user names of the two service identities. Give its path with `--registry`.

The validation refuses, with the field name and never the value:

- an id outside `[a-z0-9][a-z0-9-]{0,63}`, for example an id with `*`, `?` or `/`;
- a duplicate person id, project id or PIN;
- a member or a maintainer who is not an active person of the registry;
- a maintainer who is not a member of the project, and a project without a maintainer;
- an unknown field.

## The commands

```sh
node packages/agentcore-memory-admin/bin/registry.mjs <command> --registry <file> [options]
```

| Command | Dry run (default) | `--apply --profile <admin>` |
| --- | --- | --- |
| `render --person <actorId>` | The IAM user name `pi-memory-person-<actorId>`, the inline policy, its character count without white space, the person config and the handoff note. Fails above 2,048 characters. | Not an apply command. |
| `render --service submit\|worker` | The policy of the submit identity or of the worker identity. | Not an apply command. |
| `provision --person <actorId>` | The plan and the rendered policy. No AWS call, also with `--profile`. | Creates the user without console access, puts the inline policy `agentcore-memory`, tags `purpose=agentcore-memory` and `actorId=<actorId>`, and creates one access key. Each step runs only on a difference: a second apply makes no IAM write. |
| `rotate --person <actorId>` | The plan. No AWS call. | Creates the second access key and prints the command that deletes the first key after the handoff. Refuses when the user does not have exactly one key. |
| `offboard --person <actorId>` | The namespaces of the person. With `--profile`: the records, the user, its keys and its inline policies (read-only calls). | Deletes the records in batches of 100, then the access keys, the inline policy and the user, in that order. Then sets `status` to `offboarded` and removes the person from every member and maintainer list of the registry file. |
| `purge --project <projectId> [--person <actorId>]` | The rejected tree to purge. With `--profile`: id, actor, date and first line of each record. | Deletes the records of `/project/<p>/rejected/` (or of one actor below it) in batches of 100 with `BatchDeleteMemoryRecords`. |
| `migrate --owner <actorId> [--smoke-record-id <id>]` | The namespaces and the two target policies. With `--profile`: the test records, the smoke record, the records to move and the current policies. | Deletes the live-check records and the smoke record, moves each other `/owner/<a>/` record to `/actor/<a>/`, then gives each service policy a new default version and deletes the old version. |
| `check --profile <admin>` | The differences between the live IAM users, policies, keys and tags and the registry. Read-only IAM calls. | Not an apply command. |

Options:

- `--account <12 digits>`: the account id of the memory ARN. Without it, a command with `--profile` reads it with `sts get-caller-identity`. A dry run without both prints `<account>` and counts the policy size with a 12-digit value.
- `--show-values`: print the memory id, the account id and the service user names. A dry run without it prints `<memoryId>`, `<account>` and `<submit user>` in their place. Do not paste a `--show-values` output into the tracker.
- `--key-dir <dir>`: the private key directory. The default is `~/.local/state/agentcore-memory-admin/keys`. It must be outside the repository.

The exit code is 0 when the command is done, 1 when it refuses or fails, and 2 for a usage error. The apply step refuses `--apply` without `--profile`, and refuses the example registry and any registry file inside the repository. A diagnostic of an AWS call prints the error class name only, because the error text can carry request data.

## The rendered policies

Every policy names one resource: `arn:aws:bedrock-agentcore:<region>:<account>:memory/<memoryId>`.

| Statement | Action | Condition |
| --- | --- | --- |
| `Read` | `RetrieveMemoryRecords`, `ListMemoryRecords` | `StringLike` on `bedrock-agentcore:namespace` with the `read` patterns |
| `Write` | `BatchCreateMemoryRecords` | `ForAllValues:StringLike` with the `write` patterns, and `Null` `false` |
| `Move` | `BatchUpdateMemoryRecords` | `ForAllValues:StringLike` with the `move` patterns, and `Null` `false` |

A member has `Read` and `Write`. A maintainer also has `Move`, with the proposals, shared and rejected trees of each project that the person maintains. The submit identity has the three statements on `/shared/*` and `/actor/*`. The worker identity has `Read` on `/shared/*` and `/project/*/shared/*` only. No policy holds `GetMemoryRecord`, `DeleteMemoryRecord` or `BatchDeleteMemoryRecords`. The tests check each rule.

IAM counts at most 2,048 characters, without white space, for the inline policies of one user. The renderer prints the count and refuses a policy above the limit. In the example registry, Bruno (member of one project, maintainer of one) has 1,331 characters and Chen (member of two projects) has 861.

## The key file and the handoff

The provision apply opens a new file in the key directory before it creates the key, so a file error cannot lose a key. The file has mode 0600 and the form of the AWS shared credentials file:

```text
[pi-memory-person-<actorId>]
aws_access_key_id = <id>
aws_secret_access_key = <secret>
```

Beside it, the apply writes the person config with `"profile": "pi-memory-person-<actorId>"`. The output names the two file paths, never the key. A file is never overwritten.

The handoff is a manual step of the coordinator and the owner:

1. Save the key in the owner's Bitwarden with the credential sync scripts of the host. This keeps the one copy that the owner can reach again.
2. Create a Bitwarden Send with the key file and the config file: a deletion date of one day, a maximum access count of one, and a password. Tell the password to the person by voice, not in the message with the link.
3. The person stores the key in the AWS profile `pi-memory-person-<actorId>` of `~/.aws/credentials` (mode 0600) and the config as `~/.config/agentcore-memory/config.json`. A maintainer adds `ledgerPath`.
4. The owner removes the key file from the key directory after the Send is opened.

## Offboarding, purge and migration

Offboarding lists `/actor/<a>/` and, for every project of the registry, `/project/<p>/proposals/<a>/` and `/project/<p>/rejected/<a>/`. A record that also names a namespace outside these trees stays and is reported. The apply refuses before the first delete when the user has an item that this tool never creates: console access, a group, an attached managed policy, an MFA device, a signing certificate, an SSH key, a service-specific credential or another inline policy. The last maintainer of a project cannot be offboarded; name another maintainer first.

The purge lists one rejected tree. When a listed record names a namespace outside that tree, the apply refuses and deletes nothing.

The migration lists `/owner/<a>/` with the request field `namespace` as a prefix and prints the form and the count. The records of `/shared/livecheck/` and `/owner/<a>/livecheck/` and the smoke record are test records. The move of each other record is one `BatchUpdateMemoryRecords` entry with `sourceNamespaces` the old namespace, `namespaces` the same path below `/actor/<a>/`, and the metadata `actorId`, `harness` `migration` and `proposedAt` (the creation time of the record). A move keeps the record id. The apply refuses before the first write when a service user does not have exactly one customer managed policy, or when a policy that needs a change has five versions.

Run the migration after the owner's person user works in Pi: the narrowed policy of the worker identity no longer reads `/owner/<a>/`.

## Dependencies and tests

The package pins `@aws-sdk/client-iam`, `@aws-sdk/client-sts` and `@aws-sdk/client-bedrock-agentcore` to `3.1152.0` with a lock file. Node `>=24.0.0 <25`.

```sh
npm --prefix packages/agentcore-memory-admin ci --ignore-scripts
node --test packages/agentcore-memory-admin/tests/
```

The tests use fake IAM, STS and memory clients. They need no AWS credential and no network. A blocked client factory proves that the dry runs without `--profile` make no AWS call.

`src/core.mjs` takes the registry functions from the core by the relative path `../../agentcore-memory-core/src/index.mjs`: the id rule, the namespace builder, the registry validation, `personScope`, `submitScope`, `workerScope` and `renderPersonConfig`. The core needs no installed dependency for these functions. The module adds two things that the core does not give. First, a refusal names the field and the rule, because a core refusal is the static code `config`. Second, the script refuses a duplicate PIN and a project without a maintainer; the core accepts both. The script checks a registry with its own rules first, then with the validation of the core.

Not verified:

- Every apply step against IAM and the live store. The live proof of the project covers them.
- The condition key value of `BatchUpdateMemoryRecords` for the migration move and for the submit identity.
- The prefix semantics of the request field `namespace` on `ListMemoryRecords` for `/owner/<a>/`.
- That an update without `content` keeps the text, and whether the metadata of an update replaces or merges the stored metadata.
- The `namespace` field of a `BatchDeleteMemoryRecords` entry: the script sends the namespace of the record.
- The submit ledger of the owner still names `/owner/<a>/` for a moved record. The submit script refuses a later update of such a source, because its namespace changed.
