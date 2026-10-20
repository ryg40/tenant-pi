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
| Review | `listProposals`, `showProposal`, `approve`, `reject` | A maintainer action. Show, approve and reject take the proposer `actorId` and find the record in the one exact proposals namespace of the proposer. Approve moves the proposal to the shared namespace of the project; reject moves it to the rejected namespace of its actor. Both are one `BatchUpdateMemoryRecords` call with `sourceNamespaces` and `namespaces`. Nothing is copied or deleted. The private ledger gets a journal line before and after each move. |
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
- The live store reads the request field `namespace` of `ListMemoryRecords` as an exact match. The API reference describes it as a prefix. Round 1 of the live proof showed the exact match: a list on the proposals tree of a project returned no record, and a list on the proposals namespace of the proposer returned the proposal. The AWS CLI gave the same answer.
- The live form of the proposal list is `listProposals({ projectId, actorId })`: one `ListMemoryRecords` on the exact namespace `/project/<p>/proposals/<actorId>/`, with 100 records per page and at most 10 pages. The CLI flag `--actor` uses it. The person config holds no member list, so the maintainer names each member.
- `listProposals({ projectId })` without an actor sends the prefix form `/project/<p>/proposals/`. The live store answers it with no record. Only the CLI command `proposals list` without `--actor` uses it. Both forms go through the one function `proposalListNamespaces`.
- The list keeps a record only when the record has exactly one namespace and that namespace is `/project/<p>/proposals/<actorId>/`. With an actor, it also drops a proposal of another actor.
- Show, approve and reject take the proposer: `actorId` in the input, the flag `--actor` of the CLI. They list the one exact namespace `/project/<p>/proposals/<actorId>/` and match the record id there. The record id alone is not enough on the live store. A record of another proposer gives `proposal_missing`. An `actorId` outside the id rule gives `config` before any call. No path of show, approve or reject sends the prefix form.
- A move sends one record: the id, `timestamp`, `sourceNamespaces` with the proposal namespace, `namespaces` with the target and the whole metadata map. The map holds the seven propose keys and the review keys. `actorId` and `projectId` come from the namespace of the proposal, not from the metadata that the proposer wrote. The move drops any other key of the proposal. The request has no `content`.
- The ledger is a JSON Lines file, append only, mode `0600`, in a directory that the core creates with mode `0700`. The default path is `~/.local/state/agentcore-memory/review-ledger.jsonl` (below `XDG_STATE_HOME` when it is set). `ledgerPath` of the config replaces it. Like `scripts/memory_submit.py`, the core refuses a ledger path in the Git work tree of the current directory and in the Git work tree of this package, except below `.local/` at the top of such a tree. A broken ledger line fails with the code `ledger`.
- A move writes the intent line (`approve` or `reject`) before the call and the end line (`approve-done` or `reject-done`) after it. Both lines hold `sourceNamespace`, the exact proposals namespace of the move, and `targetNamespace`. When the intent line fails, no call happens. When the end line fails after a move, the core logs one static line and returns the result. A later move of the same record logs one static line when its last ledger line is an intent without an end.

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
| `proposals list --project <id> [--actor <id>]` | Prints one JSON line per proposal. `--actor` lists the one proposals namespace of that member: the live form. Without `--actor` the live store returns no record. |
| `proposals show --project <id> --actor <id> --id <recordId>` | Prints one proposal of the proposer `--actor`. |
| `proposals approve --project <id> --actor <id> --id <recordId> [--reason <text>]` | Shows the preview with the source and the target namespace, asks `y/N`, moves the record to the shared namespace. |
| `proposals reject --project <id> --actor <id> --id <recordId> --reason <text>` | Shows the preview with the source and the target namespace, asks `y/N`, moves the record to the rejected namespace of its actor. |
| `scope --registry <file> --person <actorId>` | Prints the identity scope and the person config as JSON. No AWS call, no config. |

`--actor` names the proposer: the `actorId` of a line of `proposals list`. Show, approve and reject without `--actor` are a usage error. `--config <file>` sets the config file for one run. The preview and the question go to standard error. The result goes to standard output. The question reads one line from the terminal. Without a terminal the answer is no, and no flag skips the question, so an agent cannot confirm through a pipe. An error prints one line `agentcore-memory: <code>` and exits with 1. A usage error exits with 2.

## The live store

### The lag of the list index

The list index of the store lags one to five minutes behind a write (rounds 2 to 4 of the live proof). Show, approve and reject find the proposal through a list. So right after a propose, `proposals show`, `proposals approve` and `proposals reject` print `agentcore-memory: proposal_missing`. Right after a move, a list of the proposals namespace still shows the record, and a list of the target namespace does not show it yet. Wait a few minutes and run the command again. The security document names the whole effect in [the lag of the list index](../../docs/shared-memory-security.md#the-lag-of-the-list-index). Not verified: the upper bound of five minutes; the longest measured lag was about two minutes.

### The store keys

The store adds keys of its own to the metadata of each record. A list and a retrieve return two of them as text values: `x-amz-agentcore-memory-recordType` (`BASE`) and `x-amz-agentcore-memory-strategyType` (`NONE`). The core keeps each metadata value of text type, so the two keys reach the recall block, the lines of `proposals list`, the preview of approve and reject, and the intent line of the ledger. A move does not send them: its map holds the seven propose keys and the review keys only. The store keeps its four keys after a move: the two above, `x-amz-agentcore-memory-createdAt` and `x-amz-agentcore-memory-updatedAt`. Rounds 0 to 3 of the live proof show these facts; the preview part comes from the code. See [the store keys](../../docs/shared-memory-security.md#the-store-keys).

## The example people

The tests and the documentation use four fake people: Alice (`alice`, owner, maintainer of `example-project`), Bruno (`bruno`, member of `example-project`, maintainer of `example-site`), Chen (`chen`, member of both) and Dana (`dana`, member of `example-project`). The e-mail domain of the examples is `example.com`.

## Dependencies

The package pins `@aws-sdk/client-bedrock-agentcore` to `3.1154.0`, with a lock file. The Pi extension has no SDK dependency of its own; it uses the SDK of the core. Run:

```sh
npm --prefix packages/agentcore-memory-core ci --ignore-scripts
node --test packages/agentcore-memory-core/tests/
```

Node `>=24.0.0 <25`, as the kit requires. The tests use fake clients. They need no AWS credential and no network.

The live proof ran the core against the live store. Recall worked in round 0, propose in round 1, show and approve with the proposer in round 2, and reject with the proposer in round 3. The move with `sourceNamespaces` passed under the namespace condition key, and an update without `content` kept the text (round 2). A call with a deleted key gives `recall failed (aws_failed)` on each namespace and no record (round 4).

Not verified: whether the metadata map of an update replaces or merges the stored map. The move sends the whole map of the proposal, so both forms give the same keys.
