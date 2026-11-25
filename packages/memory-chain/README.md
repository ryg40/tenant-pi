# Memory chain

Two parts, for Pi and Claude Code:

- The shadow chain: one fixed, read-only memory search before each eligible user prompt. It runs in shadow only: it measures what the chain would return and writes one record line. It adds nothing to the prompt. The current recall hooks of OpenViking and the LLM Wiki still supply the prompt.
- The on-demand search: for Pi, the tool `memory_find` and the skill `memory-search`; for Claude Code and any shell, the command `scripts/search.mjs` and the plugin skill `memory-search`. The model runs it only for a question about earlier work. See [the on-demand search](#the-on-demand-search).

It is not a kit component: no manifest entry names it. The kit installer and the kit profiles do not load the memory chain.

## Parts

| File | Job |
| --- | --- |
| `src/core.mjs` | The chain: one clock, stores in parallel, the scope rule, the ranking step, one block. No import of Pi or Claude Code. |
| `src/stores.mjs` | The stores: OpenViking, the Hermes facts of the project, the approved Hermes global facts, the project wiki. |
| `src/shadow.mjs` | The eligibility rules, the store set of each harness and one run of the chain (`runPrompt`), for the shadow run and the replay. |
| `src/record.mjs` | The shadow record writer. It imports nothing from `packages/openviking-pi`. |
| `scripts/replay.mjs`, `src/replay.mjs` | The replay command. |
| `src/decider-rank.mjs` | The decider ranker: `rankWithDecider` and the chain ranker `createDeciderRanker`. No import of Pi, Claude Code or `packages/tenantext`. |
| `runtime.mjs`, `index.ts` | The Pi extension: a `before_agent_start` handler and the tool `memory_find`. |
| `src/find.mjs` | The search of `memory_find`: the store calls, the parsers, the merge, the ranking step and the fitted result. No import of Pi. |
| `pi-skills/memory-search/SKILL.md` | The short Pi skill that points the model at `memory_find`. Only the `pi` key of `package.json` names this folder. |
| `scripts/search.mjs`, `src/ondemand.mjs`, `src/stores-ondemand.mjs` | The on-demand command, its run and block, and its store readers. |
| `skills/memory-search/SKILL.md` | The Claude Code skill of the plugin. Pi does not load it: the `pi` key names `pi-skills` only. |
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

The optional key `agentDir` names the Pi agent folder for the on-demand command only, for example `{ "mode": "off", "agentDir": "~/.pi/profiles/<profile>" }`. The shadow run does not read it.

## Eligible prompts

- A user prompt of a primary session. A session with `OPENVIKING_RECALL_COMPRESS=off` is a task session (`spawn.py` sets it) and is skipped.
- On Pi, only a prompt with `messageType` `user`.
- The bypass rules of OpenViking skip a prompt: `bypassSession`, `bypassSessionPatterns`, the drop rules of `recallQueryFilters` and `minQueryLength`.

## Stores and scope

This section is the scope of the automatic shadow run. The on-demand search (the Pi tool and the command) has a wider scope; see [the on-demand search](#the-on-demand-search).

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

`runChain` applies the scope rule unless its option `scope` is `"on-demand"`. Only the on-demand command sets it; `runPrompt` never does.

The ranker is one function: it takes the permitted candidates and returns their identifiers in rank order. The shadow run and the replay use `testRanker` (score order). `createDeciderRanker({ query })` of `src/decider-rank.mjs` is a decider ranker for this slot: it declares `reserveMs` 900 (two health attempts and the question), sends the candidate text only, and throws on a fallback, so the run gives links.

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

## The on-demand search

A search that the model starts for one question. It is independent of the switch: the tool registers in `off` and in `shadow`, and the `before_agent_start` handler and its scope rule stay as they are.

The on-demand search reads more than the automatic run. The command reads all memories of the user in OpenViking, all Hermes facts and the personal wiki `~/.llm-wiki` (see [the command](#the-command-scriptssearchmjs-claude-code-and-any-shell)). The Pi tool reads the same personal wiki `~/.llm-wiki` with the reader of the command, not the layered project vault of `wiki_recall`, and reads OpenViking and Hermes through their active native store tools. Only when the personal vault cannot be read does it fall back to `wiki_recall`, whose layered vault can hold a project page. The scope rule of [Stores and scope](#stores-and-scope) covers only the automatic run.

### The decider ranker

`rankWithDecider(query, candidates, options)` in `src/decider-rank.mjs` returns `{ ranked, fallback, reason }`.

- Input: `candidates` is `{ id, text }[]`. It takes the first 20 with a unique id and cuts each text to 200 characters. `options.maxCandidates` sets another count from 1 to 32 (`candidateLimit`); the on-demand searches send up to 32 candidates, so all their hits reach the decider. The automatic run keeps 20. The text is the whole candidate, so the cap is 200 characters in total, title included. It removes the OpenViking privacy placeholders (`{{ov_privacy:...}}` and the path form `{{ov_privacy_..._}}`) from each text and from the query. It resolves no placeholder.
- Request: one `POST /v1/systemone` with one `choice` question over all candidates plus a `none` option, model `pplx-decider-flash-v1.3-Q4_K_M`, key from `DECISION_API_KEY`. The criteria keys are `c1` to `cN`: no candidate id leaves the process. The default address is `http://127.0.0.1:9301`; `options.baseUrl` overrides it only when it passes the loopback check of `owner-popup/decider.ts`.
- Transport: both requests use `node:http` with no agent, to a numeric loopback address (`localhost` maps to `127.0.0.1`). No proxy setting of the process applies. A redirect is not followed: an answer other than 200 is a failure. `checkDeciderHealth` checks its own base URL and returns false for one that is not on loopback.
- Limits: `GET /health` with 150 ms for each attempt and one retry after a timeout (up to 300 ms), then 600 ms for the question. An option can only make a limit shorter; `deciderLimits(options)` gives the two limits and the `reserveMs` of a ranker. One call at a time in each process: a second call while one runs takes the fallback at once (`reason` `busy`).
- Keep rule: a candidate stays when its probability is 0.10 or more, or when it is in the top 2; at most 4 stay. `ranked` holds `{ id, p, rank }` in rank order. A ranked answer also holds `order`, every sent id from the highest probability down; both on-demand searches take their pointers in that order.
- Fallback: decider down, slow, not on loopback, no key, an HTTP error or a bad answer give `fallback: true`, a short `reason`, and the first 3 candidates in the given order with `p: null`. It never throws for these cases. It prints and logs nothing.

### The tool `memory_find` (Pi)

Input: `{ query: string }`. Output: one text block, the compact JSON of `{ excerpts, pointers, unavailable, partial, fallback }`, at most 3,000 characters: at most 4 excerpts of 300 characters, the next 6 hits as pointers (store, id, title; in the decider order, or in the merged order on a fallback), and the stores that failed. `src/find.mjs` holds the logic; `runtime.mjs` registers the tool in each mode of the switch.

- It calls two native store tools in parallel through `ctx.executeTool`, so the ranking and the limits of each store stay: `openviking_find` with `{ query, limit: 8, context_type: ["memory"] }` (no `target_uri`) and `memory_search` with `{ query, limit: 8 }`. At the same time it reads the personal wiki `~/.llm-wiki/wiki/` with `personalWikiStore` of `src/stores-ondemand.mjs`, the reader of the command, with the same bounds: the scan can list up to 10,000 page paths, a page read is 128 KB plus one byte, and the reader returns up to eight wiki hits. The owner's vault root can resolve through a link; it resolves one time, the reads stay below the resolved root, and a link below it is skipped. The limit on a replaced file or folder (see [Limits](#limits)) applies to the Pi tool too. The module loads on the first call. Then it calls `rankWithDecider` directly, in the same process, with all hits (up to 24).
- The wiki reader stops reading new pages after 3 seconds (`WIKI_READ_MS`) and keeps the pages that it scored; `partial` then names `wiki`. The limit is cooperative: the reader checks it before each batch of 64 pages and gives the event loop a turn after each batch, so a batch in progress and the excerpts of the top pages still finish. It scores with the first 32 distinct query terms (`MAX_WIKI_QUERY_TERMS`), so a long pasted text cannot make the excerpt choice slow. A page that the reader lists but cannot open or read also makes `wiki` partial.
- A wiki hit id is the page path in the `~/` form, which `read` opens. A page whose file or folder name below the vault root holds a character of `UNSAFE_WIKI_NAME` gets no id and is left out, never cut or rewritten: a control character (line breaks included), a format character (zero-width and bidirectional marks), a surrogate, a line or paragraph separator, a space other than U+0020 (Pi `read` changes U+00A0, U+2000 to U+200A, U+202F, U+205F and U+3000 to a plain space, so the id would name another file), or U+FFFD (a name that is not valid UTF-8). Pi strips a leading `@` and expands a leading `~` only at the start of the whole path, which is `~/` or `/` here. The command uses the same reader and the same rule.
- Only when the vault cannot be used (no vault folder, a root that cannot be listed, a reader that throws, a module that does not load, or a reply of a bad form: a hit that is not an object with string `source`, `title` and `text`) does the tool call `wiki_recall` with `{ query, max_results: 5 }`; its hit ids are `wiki:<page id>`. A readable vault with no hit, a partial read, or pages that the reader refuses (over 128 KB, a link, an unsafe name) stays local with no `wiki_recall` call: that tool can search its layered vault, another scope, and can send the query to a remote embedder. With `wiki_recall` not active, the wiki store is `unavailable`. The reader and its fallback share one 15-second store deadline: a reader that misses it is `unavailable`, and the fallback gets only the time that is left. The three tool names are literals in `src/find.mjs`; no tool name comes from a hit, a title or the ranker reply.
- Each store call has a deadline of 15 seconds, and the call also stops when the caller aborts. Its signal aborts then, and the tool stops the wait also when the store ignores the abort.
- A store is `unavailable` when its tool is not active in the session (no call then), returns `isError`, has text of an unknown form, claims hits (`Found N ...`) of which none parse, misses its deadline, or its parser throws. The hits that a parser read before a throw stay. An explicit empty reply is an available store with no hit.
- The ranker gets all hits with local ids (`c1` ...) and at most 200 characters of cleaned text for each hit; the lookup ids stay in the process. Only reply entries with a known local id count, each one time. With no usable entry, the excerpts are the first 3 hits of the merged list (the stores in turn) and `fallback` is true.
- A title is cut to 120 characters. A hit with an id over 300 characters is left out; an id is never cut. When the JSON is longer than 3,000 characters, pointers go first, then the excerpts get shorter, then the last excerpt goes.
- A store string over 6,000 characters is cut before the parse. An OpenViking string ends before the last hit header that starts inside the limit, so no half record is parsed. One exception: when the first OpenViking record has a complete header line and a very long body, that record stays, and its excerpt is shorter than the record. `partial` names each store whose string was cut, also when the cut string gives no hit; that store is then in `unavailable` too. `memory_search` of Hermes updates its usage counters for the hits; it changes no memory text.
- A Pi with no `ctx.executeTool` gets a short error text from the tool, not a throw.

Nested calls pass the `tool_call` handlers of other extensions like model calls, so a permission extension can block one store; that store is then `unavailable`.

The skill `pi-skills/memory-search/SKILL.md` names the tool and says how to read the result. `package.json` names its folder under `pi.skills`. Observed with Pi 1.6.0: a model did not call the tool from its description alone; with the skill, it read the skill and called the tool. One search with the tool used about 3,700 characters of context (the skill, the arguments and the result); three direct calls of the store tools used about 11,400.

No profile of the kit loads the package. A permanent load needs the package folder in the `packages` list of the Pi settings of one profile.

### The command `scripts/search.mjs` (Claude Code and any shell)

```sh
node /abs/path/of/the/clone/packages/memory-chain/scripts/search.mjs [--json] [--no-personal-wiki] [--pi-agent-dir <dir> | --pi-agent-dir=<dir>] -- '<query>'
```

It works from any folder when the path names the clone absolutely. It works only in place from the clone, because it imports `../openviking-pi/shared/`; a copied plugin fails at that import. The options go first; `--` ends them, and the query is one single-quoted Bash word in which each single quote is written as `'\''`. The plugin skill `skills/memory-search/SKILL.md` runs it in this form, for example:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/search.mjs" -- 'Why does $PATH differ in the owner'\''s profile?'
```

The on-demand scope is wider than the automatic scope. A search that a person or an agent starts on request reads:

| Store | Read | Hit id |
| --- | --- | --- |
| `openviking` | The request of the shadow run without `peer_scope` and without the actor header (one in `OPENVIKING_EXTRA_HEADERS` is dropped, in any letter case): all memories of the user, every peer. Resources and skills are dropped. A redirect is not followed; a redirect or a reply with no result array is `not available`. | The `viking://` URI |
| `personal-wiki` | The pages under `~/.llm-wiki/wiki/` as plain files (up to 10,000 page paths), ranked by the share of the first 32 query terms; the text is the best 200 characters around the terms. The vault root resolves one time (a root that is itself a link is valid), and the reads stay below it. A symbolic link inside the vault is not followed. A page is read up to 128 KB plus one byte and skipped when it is larger. A page with an unsafe name (the rule of [the tool](#the-tool-memory_find-pi)) is skipped. A root that cannot be listed is `not available`. `--no-personal-wiki` leaves it out. | `~/.llm-wiki/wiki/<page>.md` |
| `hermes-facts` | `<agent dir>/pi-hermes-memory/MEMORY.md` and every `<agent dir>/projects-memory/<project>/MEMORY.md`, approved or not. | `hermes:<file>#<n>` |
| `hermes-db` | The table `memories` through its FTS5 index `memory_fts` in `<agent dir>/pi-hermes-memory/sessions.db`, opened read-only. It writes no usage counter, and a search leaves no new file beside `sessions.db`: with no `-wal` file it opens with `immutable=1`; with `-wal` and `-shm` it opens read-only and sees the committed rows of the WAL; any other set of sidecar files is `not available`. | `hermes-db:memories.id=<n>` |

The agent folder is, in this order: `--pi-agent-dir`, `PI_CODING_AGENT_DIR`, the key `agentDir` of the switch file, then `~/.pi/agent`. A missing folder, file or database is `not available`, not an error. The automatic run keeps its scope: `runPrompt` builds its own store set and never uses these readers.

- One run: the stores in parallel for 2 seconds, then the decider (`reserveMs` 900). A slow or failed store goes into the `Not available` line and never stops the run. Each reader cuts the text of a hit to 600 characters.
- Merge: duplicate sources and duplicate texts go (a Hermes fact sits in `MEMORY.md` and in `sessions.db`). Two texts are the same only when the whole text that the reader kept is the same. The list takes the stores in turn: OpenViking, the personal wiki, the Hermes facts, the Hermes database. All of it (up to 32 hits) goes to the decider, so a hit at rank 8 of one store can still rank first. 32 candidates in place of 20 took about 100 ms more decider time in a probe (about 290 ms against 190 ms); the question limit stays 600 ms.
- Rank: `rankWithDecider` with the keep rule above. When the decider is down, slow or has no key, the block holds the first 3 hits of the merged list and the line `Ranking fell back (<reason>)`.
- Block: at most 4 excerpts of 300 characters (store, id, title, text), then at most 6 pointers (store, id, title; the next hits in the decider order, or in the merged order on a fallback), the `Not available` line and the fallback line; at most 1,600 characters. The two notice lines take their room first and always stay. A title is cut to 120 characters; an id is never cut: a hit with an id over 300 characters prints `(id too long)` in its place. When the block is longer, the excerpts get shorter first (to 80 characters), then pointers go, then excerpts. `--json` prints the same fitted fields as one object with `excerpts`, `pointers`, `unavailable`, `fallback`, `reason` and `stats` (times, hit counts and sizes for each store; no text); an id that is too long is `null` there. The JSON envelope and `stats` are extra to the 1,600 characters.
- Exit 0 also when every store or the decider is down. Exit 2 only for a wrong call: no query, an unknown option, `--pi-agent-dir` with no folder or followed by a word that starts with `--` (the form `--pi-agent-dir=<path>` takes any path). The error text is fixed text and the usage line; it never repeats an argument.
- "Read-only" means the search data: the command changes no memory text, no usage counter and no file of a store, and adds no file beside `sessions.db`.
- It reads `DECISION_API_KEY` and the OpenViking settings of the Claude Code harness (`loadOvConfig`) from the environment and the config, and prints no key.

### What leaves the computer

The request to the decider holds the query, the candidates (each at most 200 characters in total, title included, without privacy placeholders; a short hit can fit whole) and the bearer key `DECISION_API_KEY`. It has no candidate id field and no whole file, but a title, an excerpt or the query can still name an id or a source address.

The client connects only to a loopback address. That address can be a forward on the computer that carries the request in plain HTTP to another host that runs the decision model. The command `scripts/search.mjs` sends the same request; its OpenViking request goes to the configured OpenViking server, as the shadow run does. The tool `memory_find` sends the same ranking request. Its other data transfer is that of the two active native store tools: `openviking_find` sends the query to the OpenViking server of the profile. Its wiki reader reads local files and sends nothing. Only the fallback `wiki_recall` can send the query to an embedder for its embedding when the wiki config names a remote one.

### Limits

- The checks of the personal wiki do not guard against a file or a folder that is replaced after its check, in the command and in the Pi tool. That race is outside the threat model: the same user owns the vault.
- A writer that starts during an `immutable=1` read of `sessions.db` can give that read wrong rows or an error. The search adds no file then too.

## Tests

```sh
cd packages/memory-chain && npm test
```

The tests use isolated stores in a temporary home, a fake OpenViking server and a fake decider on loopback. They need no npm dependency and no network.

Not verified: a live Pi or Claude Code session with the switch on; the plugin skill `memory-search` in a live Claude Code session; the command from an installed plugin copy (it imports `../openviking-pi/shared/` by relative path, so it works only in place); `memory_find` in Pi-Bolt; the wiki preview form of the `memory_find` parser against a real result; the framing of wiki replies in that parser (a `---` line inside a preview ends the page text there, and a ` — ` inside a wiki path is read as the path and snippet separator); `createDeciderRanker` inside `runChain` against the live decider; the decider under load from the owner-task rail at the same moment.
