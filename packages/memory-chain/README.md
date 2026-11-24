# Memory chain (shadow)

One fixed, read-only memory search before each eligible user prompt, for Pi and Claude Code. This version runs in shadow only: it measures what the chain would return and writes one record line. It adds nothing to the prompt. The current recall hooks of OpenViking and the LLM Wiki still supply the prompt.

It is not a kit component: no manifest entry names it. The kit installer and the kit profiles do not load the memory chain.

## Parts

| File | Job |
| --- | --- |
| `src/core.mjs` | The chain: one clock, stores in parallel, the scope rule, the ranking step, one block. No import of Pi or Claude Code. |
| `src/stores.mjs` | The stores: OpenViking, the Hermes facts of the project, the approved Hermes global facts, the project wiki. |
| `src/shadow.mjs` | The eligibility rules, the store set of each harness and one run of the chain (`runPrompt`), for the shadow run and the replay. |
| `src/record.mjs` | The shadow record writer. It imports nothing from `packages/openviking-pi`. |
| `scripts/replay.mjs`, `src/replay.mjs` | The replay command. |
| `runtime.mjs`, `index.ts` | The Pi extension: a `before_agent_start` handler. |
| `hooks/hooks.json`, `scripts/shadow-hook.mjs`, `scripts/shadow-run.mjs`, `src/hook.mjs` | The Claude Code plugin: one `UserPromptSubmit` hook and its detached child. |
| `src/switch.mjs` | The switch and the folders. It imports nothing from `packages/openviking-pi`. |

The package imports the OpenViking helpers of `../openviking-pi/shared/` by relative path. Both entries work only when they load in place from the kit clone, for example with `claude --plugin-dir packages/memory-chain`.

Both entries load the helpers only after the switch says `shadow`. In `off`, a missing or renamed helper leaves the hook silent with exit 0 and the Pi extension loaded.

The Claude Code hook does not hold the prompt. In `shadow` it hands the hook input to a detached child process (`scripts/shadow-run.mjs`) through a pipe and exits at once. It hands at most 256 KiB (262,144 bytes). It reads a larger input to its end but keeps no more than the cap in memory, starts no child and writes one `skipped` record line. The child runs the chain and writes the record line about 2 seconds later at most. The Pi handler does not wait for the run either.

## The switch

`${XDG_CONFIG_HOME:-~/.config}/tenant-pi/memory-chain/settings.json`:

```json
{ "mode": "shadow" }
```

`mode` is `off` or `shadow`. No file, a broken file or another value means `off`. In `off` the chain reads no store and writes nothing. Both harnesses read the same file for each prompt.

## Eligible prompts

- A user prompt of a primary session. A session with `OPENVIKING_RECALL_COMPRESS=off` is a task session (`spawn.py` sets it) and is skipped.
- On Pi, only a prompt with `messageType` `user`.
- The bypass rules of OpenViking skip a prompt: `bypassSession`, `bypassSessionPatterns`, the drop rules of `recallQueryFilters` and `minQueryLength`.

## Stores and scope

| Store | Pi | Claude Code | Scope |
| --- | --- | --- | --- |
| OpenViking | yes | yes | `peer_scope: "actor"` with the project peer of `workspace-peer.mjs` (git remote, else git root). The chain also asks the legacy peer of the same folder (the path-derived peer of earlier sessions), as the live recall does. A hit under another peer is dropped, also the legacy peer of another folder. A hit outside any peer is a global fact. A refused scope skips the store; the chain never retries without the scope. An explicit peer (`OPENVIKING_PEER_ID`, `actor_peer_id` or `peerId`) is account-wide: the store is left out with the reason `account-wide peer` and sends no request. |
| Hermes project facts | yes | no | `<agent dir>/projects-memory/<project>/MEMORY.md`. `<project>` is the folder name of the git root, as in Hermes. Repositories with the same root folder name share one store of Hermes project facts; use distinct folder names when you need separate stores. |
| Project wiki | yes | no | `<project>/.llm-wiki/` or `<project>/.wiki/`. Never `~/.llm-wiki`. Symbolic links are not followed. |
| Hermes global facts | yes | no | Only the entries in the owner list. |
| OpenKnowledge | no | no | No read path with access limits exists. The omission line names it. |

The owner list of global facts is `${XDG_CONFIG_HOME:-~/.config}/tenant-pi/memory-chain/approved-facts.json`:

```json
{ "facts": ["viking://user/<user>/memories/<path>.md", "hermes-global:<16 hex>"] }
```

A file over 128 KB is left out with the reason `file over 128 KB`; in the wiki, only when no other page gives a hit.

The OpenViking request sends `score_threshold` as the live recall does and the headers of `OPENVIKING_EXTRA_HEADERS`. It sends no `session_id`: with a `session_id` the server starts a query expansion with a 5-second limit, which does not fit the 2-second clock.

An OpenViking fact is its URI. A Hermes global fact is `hermes-global:` and the first 16 hex characters of the SHA-256 of the trimmed entry (`hermesGlobalId` in `src/stores.mjs`). No file means no approved fact. The same limits apply to the ranking input, the links and the block.

## The clock and the block

- The clock starts at prompt arrival. The stores run in parallel until 2 seconds minus the time that the ranker declares (`reserveMs` on the ranker function). `testRanker` declares 0, so the stores get the full 2 seconds. A ranker with no valid declaration counts as failed, and the run gives links.
- Late replies are dropped. Duplicate sources are merged.
- With a ranking answer: ranked excerpts, at most 4, with their sources. Without one: links to the ready hits, no excerpts.
- One line names the stores that were left out, and why.
- Nothing ready because a store was late or failed: only `memory search timed out`.
- A store answered with no permitted hit while another store was late or failed: the kind is `partial`, and the block is the omission line.
- At most 3,000 characters, with the header, the labels, the sources, the separators and the omission line counted.

The ranker is one function: it takes the permitted candidates and returns their identifiers in rank order. This version ships only `testRanker` (score order).

## The shadow record

One JSON line for each eligible prompt in `${XDG_STATE_HOME:-~/.local/state}/tenant-pi/memory-chain/shadow-<UTC date>.jsonl`. The folder has mode 0700 and the files 0600. The chain removes no record file.

A line holds the time, the harness, the result kind (`full`, `partial`, `links`, `timeout`, or `empty` when every store answered or was left out by rule and no hit is permitted), the status, time and hit count of each store, the ranker status and time, the build time, the total time, the store deadline of the run (`storeDeadlineMs`), the omitted stores, the character count of the block, and the selected items as `c<n>` with their scores and lengths. It never holds a prompt, a memory text, a source address or a digest.

A hook input over 256 KiB gives a line with only `v`, `at`, `harness`, the kind `skipped` and a fixed `reason` (`input over cap`). It holds no part of the input.

## The replay

The replay is an owner command. It runs the chain on a sample file and shows, for each prompt, the chain block beside the current recall of OpenViking.

```sh
node packages/memory-chain/scripts/replay.mjs --sample <file> [--out <file>]
```

The sample file is JSON. A ranker comparison can use the same format:

```json
{ "prompts": [ { "harness": "pi", "cwd": "/abs/project/folder", "prompt": "..." } ] }
```

- `harness` is `pi` or `claude-code`. `cwd` is the absolute project folder of the prompt.
- The command opens the sample file read-only. It never writes, copies, renames or moves it.
- The chain uses the same stores, scope rules, clock and ranker (`testRanker`) as the shadow run, through `runPrompt`. It runs when the switch says `off` too.
- The prompt rules of the sample harness apply. The task-session marker `OPENVIKING_RECALL_COMPRESS=off` of the replay process does not: a sample prompt stands for a prompt of a primary session. A skipped prompt shows its reason and runs no store and no recall.
- The current recall is the vendored OpenViking recall `buildRecallBlockDetailed` with the OpenViking config of the sample harness and the peer options of the Pi extension, with no session id. For a `claude-code` prompt it is not the recall of the Claude Code plugin: that plugin resolves the peer by session and folder, can skip a prompt by session, sends a session id for query expansion, and has its own fallback and rendering. The output says this for each prompt. The command does not call the plugin of the host. The chain and the recall of one prompt run one after the other.
- The current recall runs with a fresh memo state: a private state folder (mode 0700, below `TMPDIR`) that the command removes at its end, also after an error and after `SIGINT`, `SIGTERM` or `SIGHUP`. A kill with `SIGKILL` or a crash can leave the folder. At its end the command gives `OPENVIKING_STATE_DIR` back its earlier value.

The output is Markdown. Without `--out` it goes to standard output. `--out` names a new file outside every git repository; the command creates it with mode 0600. Its folder must exist. The command resolves the folder to its real path once, and checks the real folder and each real ancestor: a git work tree, a `.git` folder or a bare repository is refused. It asks `git rev-parse` and also looks for a `.git` entry or the files of a bare repository; when git cannot run, the output says so. An existing path, a symbolic link at the file, a missing folder or a path inside a git repository is refused: the command writes nothing and exits with a code other than 0. The command makes the file after it checks the sample and before the first request. When a run fails after that, the file keeps what was written and a last line that says that the run failed.

For each prompt the output shows its number, harness, project folder and text, the chain result (kind, omission line, the proposed block unchanged as the model would see it, then the items) and the current recall block with its label and item counts. Each chain item has a local label such as `P1.L1` with its `c<n>` id, score, store, source and excerpt. The label maps the `c<n>` id of this run to its source only in this output. Each item has empty marks `Useful` and `Unrelated`, and each prompt has one empty line `Missing facts:`. The command does not read the marks back.

The command writes no record line, no log line, no persistent cache and no file outside its private state folder, except the `--out` file. A prompt, a memory text, a source address or a digest appears only on standard output or in the `--out` file.

## Tests

```sh
cd packages/memory-chain && npm test
```

The tests use isolated stores in a temporary home and a fake OpenViking server on loopback. They need no npm dependency and no network.

Not verified: a live Pi or Claude Code session with the switch on, and a ranker other than `testRanker`.
