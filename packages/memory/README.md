# memory

The memory viewer of the tenant-pi kit: a read-only web app that shows the memories of several agent memory systems in one place. It has a global view across all systems and a view for each system.

In the kit it is the optional module `memory`: the section `/memory/` of the local server of `packages/artifacts`, beside Artifacts and Walkr. `artifacts start` starts it, and `artifacts off` stops it. It listens on `127.0.0.1` only. Nothing that it reads leaves your computer.

| System | Adapter | What one entry is | Guide |
| --- | --- | --- | --- |
| OpenViking | `lib/adapters/openviking.mjs` | One memory file | [OpenViking](docs/sources/openviking.md) |
| okknow (OpenKnowledge) | `lib/adapters/okknow.mjs` | One page of the knowledge base | [okknow](docs/sources/okknow.md) |
| llm-wiki | `lib/adapters/llmwiki.mjs` | One wiki page of the vault | [llm-wiki](docs/sources/llm-wiki.md) |
| hermes-memory | `lib/adapters/hermes.mjs` | One row of the store, or one memory file | [hermes-memory](docs/sources/hermes-memory.md) |
| AgentCore memory | `lib/adapters/agentcore.mjs` | One memory record | [AgentCore](docs/sources/agentcore.md) |

## Read-only

The app is read-only toward every memory system. It sends no write, update or delete call, and it opens each file and each database for reading only. `node check-readonly.mjs` checks the sources for this rule, and the unit tests run it.

One exception exists, and the owner approved it: an AgentCore source with a `review` setting lets a person approve or reject a proposed record. That is the record move of `lib/adapters/agentcore-review.mjs` ([AgentCore: review](docs/sources/agentcore.md#review)). Add no other write.

Memory content is private. Use only the synthetic records of `sample/` in a test, a screenshot or a document.

## How the module runs

The local server of `packages/artifacts` starts `node server.mjs --child` as its child process (`server/memory_front.py` there) and passes the paths below `/memory/` to it.

- The child binds `127.0.0.1` with a free port. It has no sign-in of its own in this mode. The parent writes a secret of this start to the standard input of the child, and each request must carry it in the header `X-Tenant-Artifacts-Parent`. Only the pass of the parent adds that header; a browser never gets the secret. A request without it gets 401, the health check too.
- The child ends when its standard input closes, so it never runs without its parent.
- The pass sends only the page, its files and the API routes that the page uses, to this child only. See `packages/artifacts/README.md`.
- The page uses relative addresses, so it works below `/memory/` and at `/` of a standalone run.
- The module needs Node 24 or later and `npm ci --omit=dev --ignore-scripts` in this folder (`install.sh --with memory` of the kit runs it). When one of them is absent, the local server still starts, and the page `/memory/` says in one sentence what is missing.

## The settings file

The sources come from one file of your user, outside the repository:

```text
~/.config/tenant-artifacts/memory-sources.json
```

- With no such file, the app shows the synthetic sample data of `sample/`, and a line at the top of the page says so. It then sends no request to a memory system.
- The file must be a regular file of your user with mode 0600. The module refuses another mode with one sentence on the page.
- The file holds no credential value. Each credential is the path of its own file with mode 0600: `apiKeyFile` of an OpenViking source, `credentialFile` of an okknow source. A field that holds a value (`apiKey`, `token`, `password` and the like) stops the start. The module reads no credential from an environment variable.
- An AgentCore source names a sign-in profile of the AWS configuration of your user; see its guide.
- [`config/sources.example.json`](config/sources.example.json) shows each field with neutral values. `"mode": "sample"` shows the sample data of one source, and `"mode": "off"` leaves a source out.
- After a change of the file, run `artifacts off` and `artifacts start`.

```sh
mkdir -p ~/.config/tenant-artifacts/memory-secrets
chmod 700 ~/.config/tenant-artifacts/memory-secrets
cp packages/memory/config/sources.example.json ~/.config/tenant-artifacts/memory-sources.json
chmod 600 ~/.config/tenant-artifacts/memory-sources.json
```

Warning: with real sources the page shows private memory to each program of your user that reaches the local server, and on macOS to each local user (see the warning of the module guide). Keep the server on `127.0.0.1`.

## Layout

| Path | Content |
| --- | --- |
| `server.mjs` | The entry point. The comment at the top gives the flags of the child mode and of a standalone run. |
| `lib/hub.mjs` | The hub: the global overview, the recent list and the search over several sources. |
| `lib/adapters/` | One adapter for each source type, plus the sample adapter. |
| `lib/web.mjs` | The Host guard, the parent secret, the headers and the JSON API. |
| `lib/config.mjs` | The settings file and the credential files. |
| `ui/` | The browser UI. No framework and no `innerHTML`. |
| `sample/` | Synthetic records for sample mode. |
| `docs/design.md` | The design of the UI. |
| `tests/` | The unit tests. `tests/browser/` holds a manual browser check for a standalone sample server. |

## Checks

```sh
cd packages/memory
node --test 'tests/*.test.mjs'   # the unit tests; they need no network
node check-readonly.mjs          # the read-only guard
```

A standalone sample run, without the local server and without a sign-in, for work on the UI:

```sh
node server.mjs --sample --no-auth --port 8795
```

`--no-auth` works only on a loopback address. Stop the server with Ctrl-C.

## Where it comes from

The viewer was a separate container app with its own sign-in. In the kit it is a local module with no container, no proxy and no sign-in.
