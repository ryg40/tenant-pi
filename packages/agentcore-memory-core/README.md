# AgentCore memory core

This package is the one core of the shared AgentCore Memory for several people. The Pi extension, the Claude Code plugin, the review CLI and the registry script use it. It holds the config, the namespace builder, recall, propose, the proposal list, approve, reject and the record metadata.

The contract is `src/types.ts`. It holds types and function signatures only. `src/index.mjs` implements it. The other tickets build against `src/types.ts` and do not change it.

The security review of the whole design is [the shared memory security document](../../docs/shared-memory-security.md). It names the IAM rules and the namespace rules that the core keeps.

## The contract in short

| Part | Function | Rule |
| --- | --- | --- |
| Config | `loadConfig`, `validateConfig` | One file for every harness. It holds no key. `AGENTCORE_MEMORY_DISABLE=1` stops every call. |
| Ids | `validateId` | `[a-z0-9][a-z0-9-]{0,63}`. No wildcard. |
| Namespaces | `namespaces` | Every namespace comes from the builder. Recall never names a proposals or a rejected namespace. |
| Project | `resolveProject` | The environment variable, then the Git remote, then the directory. No match: global and private recall only; propose refused. |
| Recall | `recall`, `formatContext` | One query per namespace of the recall set. A failure is reported; the turn continues. One context block for both harnesses. |
| Propose | `propose` | One record into the person's proposals namespace of the project. The confirm callback gates the write. |
| Review | `listProposals`, `showProposal`, `approve`, `reject` | A maintainer action. Approve moves the proposal to the shared namespace of the project; reject moves it to the rejected namespace of its actor. Both are one `BatchUpdateMemoryRecords` call with `sourceNamespaces` and `namespaces`. Nothing is copied or deleted. The private ledger gets a journal line before and after each move. |
| Registry | `validateRegistry`, `personScope`, `submitScope`, `workerScope`, `renderPersonConfig` | The one place that decides the namespace scope of an identity: `read`, `write` and `move` patterns. No scope has a delete. The IAM renderer reads it. |

## Files

| File | Holds |
| --- | --- |
| `src/types.ts` | The contract. |
| `src/index.mjs` | The config, the namespace builder, the project resolution, the SDK client, recall, propose and the review moves. It exports every function of `MemoryCoreModule`. |
| `src/registry.mjs` | The registry check and the scope of each identity. `src/index.mjs` exports it. |
| `src/ledger.mjs` | The private review ledger. |
| `src/cli.mjs` | `main(argv, deps)` of the review CLI. The tests call it with fakes. |
| `bin/agentcore-memory.mjs` | The CLI entry. |
| `tests/` | Offline tests with fake clients and a fake Git remote reader. `tests/fixtures/registry.example.json` is the registry of the example people. |

## How the core works

- The config comes from `AGENTCORE_MEMORY_CONFIG` (inline JSON), else from the file that `AGENTCORE_MEMORY_CONFIG_FILE` names, else from `~/.config/agentcore-memory/config.json` (below `XDG_CONFIG_HOME` when it is set). `AGENTCORE_MEMORY_DISABLE=1` comes first and gives no config. An unknown field, bad JSON or a missing named file fails with the code `config`. The error never holds a config value.
- The SDK client starts at the first call. It has `maxAttempts: 1` and the profile of the config, else the default credential chain. Each call has a deadline: `recallTimeoutMs` for a recall query, `writeTimeoutMs` for a propose, a move and each page of the proposal list. The deadline covers the client creation and the credential resolution.
- The client has four methods: `retrieve`, `list`, `batchCreate` and `batchUpdate`. It has no delete method. The core never calls a delete action.
- Recall sends the queries of the recall set at the same time, one per namespace. A failed or late query goes into `failed` and logs one static line: `AgentCore Memory: recall failed (<code>); turn continues`. The code is `aws_denied`, `aws_failed` or `timeout`.
- The context block holds one JSON line per record. A line break in a record text stays inside its JSON string, so a record cannot add a line of its own to the block.
- Propose counts the text in Unicode code points. The `requestIdentifier` is the SHA-256 of the actor, the project, the text and the time. The `clientToken` is the SHA-256 of the canonical JSON of the request without the token.
- The project resolution compares Git remotes after normalization: no scheme, no user, no `.git`, no trailing slash, the host in lower case. `git@host:path` and `ssh://git@host/path` give the same value. A port and the case of the path stay. The directory rule compares real paths. The longest configured directory wins.
- The proposal list is one `ListMemoryRecords` on `/project/<p>/proposals/`, the prefix form, with 100 records per page and at most 10 pages. It keeps a record only when the record has exactly one namespace and that namespace is `/project/<p>/proposals/<actorId>/`. The fallback, when the live store does not read `namespace` as a prefix, is `listProposals({ projectId, actorId })`: one exact proposals namespace per member. The CLI flag `--actor` uses it. Both forms go through the one function `proposalListNamespaces`.
- A move sends one record: the id, `timestamp`, `sourceNamespaces` with the proposal namespace, `namespaces` with the target and the whole metadata map. The map holds the seven propose keys and the review keys. `actorId` and `projectId` come from the namespace of the proposal, not from the metadata that the proposer wrote. The move drops any other key of the proposal. The request has no `content`.
- The ledger is a JSON Lines file, append only, mode `0600`, in a directory that the core creates with mode `0700`. The default path is `~/.local/state/agentcore-memory/review-ledger.jsonl` (below `XDG_STATE_HOME` when it is set). `ledgerPath` of the config replaces it. Like `scripts/memory_submit.py`, the core refuses a ledger path in the Git work tree of the current directory and in the Git work tree of this package, except below `.local/` at the top of such a tree. A broken ledger line fails with the code `ledger`.
- A move writes the intent line (`approve` or `reject`) before the call and the end line (`approve-done` or `reject-done`) after it. When the intent line fails, no call happens. When the end line fails after a move, the core logs one static line and returns the result. A later move of the same record logs one static line when its last ledger line is an intent without an end.

## The CLI

```sh
node packages/agentcore-memory-core/bin/agentcore-memory.mjs --help
node packages/agentcore-memory-core/bin/agentcore-memory.mjs scope --registry packages/agentcore-memory-core/tests/fixtures/registry.example.json --person bruno
```

| Command | Does |
| --- | --- |
| `resolve-project [--cwd <dir>]` | Prints the project resolution as JSON. |
| `recall --query <text> [--project <id>]` | Prints the context block. It prints nothing without records. |
| `propose (--text <text> \| --file <path>) [--project <id>]` | Shows the preview, asks `y/N`, writes, prints the result as JSON. |
| `proposals list --project <id> [--actor <id>]` | Prints one JSON line per proposal. `--actor` lists one proposals namespace. |
| `proposals show --project <id> --id <recordId>` | Prints one proposal. |
| `proposals approve --project <id> --id <recordId> [--reason <text>]` | Shows the preview with the target namespace, asks `y/N`, moves the record to the shared namespace. |
| `proposals reject --project <id> --id <recordId> --reason <text>` | Shows the preview with the target namespace, asks `y/N`, moves the record to the rejected namespace of its actor. |
| `scope --registry <file> --person <actorId>` | Prints the identity scope and the person config as JSON. No AWS call, no config. |

`--config <file>` sets the config file for one run. The preview and the question go to standard error. The result goes to standard output. The question reads one line from the terminal. Without a terminal the answer is no, and no flag skips the question, so an agent cannot confirm through a pipe. An error prints one line `agentcore-memory: <code>` and exits with 1. A usage error exits with 2.

## The example people

The tests and the documentation use four fake people: Alice (`alice`, owner, maintainer of `example-project`), Bruno (`bruno`, member of `example-project`, maintainer of `example-site`), Chen (`chen`, member of both) and Dana (`dana`, member of `example-project`). The e-mail domain of the examples is `example.com`.

## Dependencies

The package pins `@aws-sdk/client-bedrock-agentcore` to `3.1152.0`, with a lock file. The Pi extension has no SDK dependency of its own; it uses the SDK of the core. Run:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
node --test packages/agentcore-memory-core/tests/
```

Node `>=24.0.0 <25`, as the kit requires. The tests use fake clients. They need no AWS credential and no network.

Not verified: the core against a live store. The live proof of the project covers it after the four tickets merge. The open items: the prefix form of the proposal list; the move under the namespace condition key; whether an update without `content` keeps the text; whether the metadata map of an update replaces or merges.
