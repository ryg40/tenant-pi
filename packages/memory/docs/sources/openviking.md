# OpenViking

One source represents one OpenViking agent user. One item represents one visible Markdown memory file under a configured root.

## Users and configuration

Create one `openviking` entry for each agent user except `pilocal`.
Use `openviking-<user>` as its id and `OpenViking \u00b7 <user>` as its JSON name.
The JSON escape `\u00b7` displays as a middle dot.
Each entry has its own `apiKeyFile` and explicit roots.
The existing configuration loader accepts repeated source types when their ids differ.

This example uses synthetic users, peer names, URLs and secret paths:

```json
{
  "sources": [
    {
      "id": "openviking-sample",
      "type": "openviking",
      "mode": "live",
      "name": "OpenViking \u00b7 sample",
      "baseUrl": "https://openviking.example.invalid",
      "apiKeyFile": "/home/me/.config/tenant-artifacts/memory-secrets/openviking-sample",
      "roots": [
        {
          "uri": "viking://user/sample/memories/",
          "label": "User memories"
        },
        {
          "uri": "viking://user/sample/peers/sample-peer/memories/",
          "label": "Peer sample-peer"
        }
      ]
    },
    {
      "id": "openviking-sample-two",
      "type": "openviking",
      "mode": "live",
      "name": "OpenViking \u00b7 sample-two",
      "baseUrl": "https://openviking.example.invalid",
      "apiKeyFile": "/home/me/.config/tenant-artifacts/memory-secrets/openviking-sample-two",
      "roots": [
        {
          "uri": "viking://user/sample-two/memories/",
          "label": "User memories"
        }
      ]
    }
  ]
}
```

Keep your values in the settings file of the user (`~/.config/tenant-artifacts/memory-sources.json`, mode 0600), never in a tracked file.
Each `apiKeyFile` is the path of a file with mode 0600 that holds one key.
The adapter reads only `apiKeyFile`; it does not read keys from the environment.
It caches the key until a request returns `denied`, including HTTP 401, HTTP 403 and structured permission errors.
That denial remains an error; the adapter does not retry it or hide it with the keyword fallback.
The next API call reloads `apiKeyFile`, so a rotated key works without a restart.
The adapter never logs the key.
The key must authenticate as the user whose private roots the source lists.
The app's read-only routes do not prove that the credential itself has read-only permissions.

## Roots

| Root | Meaning | Configuration |
| --- | --- | --- |
| `viking://user/<user>/memories/` | Memory of the authenticated user | Include for that user |
| `viking://user/<user>/peers/<peer>/memories/` | Memory about one interaction peer | Optional root in the same user source |
| `viking://agent/` | Account-shared capabilities and configuration | Not an agent user's memory root |

Each configured root appears as a folder in the source view.
Add an explicit memory root for each peer that the stack credential can read.
Do not use the whole `peers/` directory; it also contains peer resources.
The adapter does not discover peers or expand the source scope automatically.
Overlapping roots do not duplicate files in overview or search results.

Use explicit canonical URIs, not the `viking://~/` alias.
OpenViking returns canonical URIs, so the adapter compares them with explicit roots.
Root checks reject traversal, encoded paths, path variables, hidden paths and paths outside the configured roots before any request.
The adapter also filters returned list and search entries against the requested root.
It hides `.abstract.md`, `.overview.md`, other dotfiles, and files below hidden directories.
Only files ending in `.md` become items.

## Memory layout

A user memory space holds memory folders and files, for example the folders `entities`, `events` and `preferences` and the files `identity.md`, `profile.md` and `soul.md`.
A peer directory `viking://user/<user>/peers/<peer>/` holds a `memories/` folder with the same kind of memory files.
The adapter reads only the configured `memories/` roots and the `.md` files below them.
The shared agent space `viking://agent/` holds capabilities and configuration, not a memory root.
Not verified: a live qualification of the adapter.

The OpenViking checkout provides the API contracts:

- `docs/en/concepts/04-viking-uri.md`: user memory, peer memory, canonical responses, and shared agent space.
- `docs/en/concepts/11-multi-tenant.md`: private user boundaries and peer scope.
- `docs/en/api/03-filesystem.md`: entry arrays, `offset`, `limit`, `has_more`, and file metadata.
- `docs/en/api/06-retrieval.md`: scoped semantic `find` and regular-expression `grep`.
- `docs/en/api/12-content.md`: default reads preserve privacy placeholders; raw reads can restore values.
- `docs/en/api/08-admin.md`: user-name discovery with credentials disabled.
- `docs/en/api/12-acl.md`: access-control lists apply to shared resources, not private user memory sharing.

## Search and reading

The adapter first calls `find` under each selected root.
It requests memory files at level 2, the full-file level of the search index.
The result note identifies semantic search.
Results retain their source id and remain separate from other users' results.

Server errors, malformed replies, connection failures and timeouts can trigger the keyword fallback.
An empty, valid semantic result does not trigger the fallback.
A malformed fallback reply remains an error, not an empty success.
The fallback calls `grep` with a case-insensitive, escaped literal query.
Its result note identifies the keyword fallback.
HTTP 401 and 403, structured permission errors, and missing credentials remain errors.
The fallback never converts a denial into a successful empty result.
It discards partial semantic results before searching all selected roots with `grep`.

The fallback uses cached modification times when available.
It does not require a fresh recursive list before returning matches.
A missing cached time appears as unknown, not as the current time.
Search totals count the distinct accepted matches, not every possible match in the store.

The reader preserves the default API response and counts privacy placeholders in its metadata.
Snippets replace placeholders with a private marker before shortening the text.
The adapter never requests `raw=true` or resolves a placeholder.

## Read routes

| Method | Route | Use |
| --- | --- | --- |
| GET | `/api/v1/fs/ls` | Browse folders and collect the recursive file list |
| GET | `/api/v1/fs/stat` | Check configured roots and read file metadata |
| GET | `/api/v1/content/read` | Read one file |
| POST | `/api/v1/search/find` | Semantic search |
| POST | `/api/v1/search/grep` | Keyword fallback |

The stub test asserts this exact set of received routes.
The adapter makes no write, update, delete, user-management or privacy-resolution call.

## Recursive discovery

The server limits recursive `ls` to three levels below the requested URI.
The adapter names this cap `RECURSIVE_DEPTH = 3`.
A direct child has depth 1; `events/<year>/<month>/` has depth 3 under a memory root.
`has_more=false` ends pagination, but does not prove that the full tree was returned.
Increasing `node_limit` does not remove the depth limit.
Dated event files can sit below it, for example `events/<year>/<month>/<day>/<file>.md`.

After collecting every page, the adapter descends only when the deepest returned directories reach the depth cap.
It lists those directories recursively and repeats the rule for each reply.
A shallower reply is complete, so the adapter does not list its directories again.
For 100 day folders across four months, an unpaged walk uses five calls: one root and four months.
The adapter deduplicates files and scheduled directories by URI.
Hidden and out-of-root directories never enter the walk.
A scheduled subdirectory that returns HTTP 404 counts as empty; a missing configured root still fails.
Other errors, including denials, still fail the refresh.

Concurrent overview and recent calls share one pending walk for this source, including its request budget.
They use the same result or receive the same failure.
Success replaces the cached tree; failure preserves the previous cache and allows the next caller to retry.

The exported `MAX_TREE_CALLS = 200` bounds `ls` calls across all roots, pages and deeper directories in one refresh.
The overview labels its count as partial when this bound leaves pages or directories unread.
Its newest date and facets then cover only the discovered files.
Recent items also cover only those files; that method returns no separate note.
The cache retains the partial-count note until a later complete refresh replaces it.
A refresh that completes on its last permitted call does not report a partial count.
The adapter keeps the five read routes and does not call `glob`.

## Limits

| Limit | Behavior |
| --- | --- |
| API list page | Requests 1,000 entries, then follows `has_more` using the number of returned entries |
| Browse page | Returns up to 200 visible files after collecting all API pages |
| Recursive discovery | Re-lists only the deepest directories that reach `RECURSIVE_DEPTH`; skips shallower complete replies |
| Refresh calls | At most `MAX_TREE_CALLS` (200) `ls` requests; includes pages and all configured roots |
| Recursive cache | Shares a pending walk; uses process memory only; retains partial-count notes; `refreshSeconds` defaults to 60 |
| Key rotation | A denial clears the cached key; the next API call reloads `apiKeyFile` |
| Request deadline | `timeoutMs` defaults to 10,000 milliseconds |
| List deadline | All pages of one directory share one `timeoutMs` budget |
| Search limit | Defaults to 20 returned items; the hub can request fewer |
| Keyword query | Uses the first 200 characters after trimming, then escapes regular-expression characters |
| Keyword matches | Requests at most 5,000 matches per root; uses the server's default depth limit |
| Snippet | Returns at most 220 characters |

The hub also applies its own deadline to each source operation.
A large root can still time out; a timeout remains an error rather than a partial-count result.
An empty or repeated page with `has_more=true` fails rather than looping or caching an incomplete tree.
Offset pagination is not a snapshot; concurrent changes on the server can change page contents.
A failed refresh preserves the previous cache; only the explicit call bound permits a labeled partial result.
Browsing collects the directory again on each call.
A source status check requires access to every configured root.

Keyword fallback matches literal text, not meaning or separate words across a document.
Its result count can be incomplete because of the match and depth limits.
The adapter does not paginate semantic or keyword search results.
The shared HTTP client reads each complete JSON response into memory without a response-byte cap.
No persistent content cache or content log exists in this adapter.

## Checks and live gate

Run the synthetic tests with Node 24:

```sh
cd app && node --test 'tests/*.test.mjs'
```

The quotes let Node expand the test glob.
The directory form `node --test tests/` does not discover these tests on Node 24.
Tests use `sample/openviking.json`, synthetic edge cases, and random loopback ports.
Their teardown closes the stub servers and connections.

The live adapter check is skipped: it needs a stack credential.
The [memory layout](#memory-layout) above is not a live adapter qualification.
No production agent credential may enter a test.
`node check-readonly.mjs` in the package runs the read-only guard.
