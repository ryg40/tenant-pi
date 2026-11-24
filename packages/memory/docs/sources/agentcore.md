# AgentCore memory

This adapter reads long-term records from the dev stage with the explorer's existing person sign-in.
It sends only `ListMemoryRecords` and `RetrieveMemoryRecords` requests.
It neither creates records nor changes records.
One exception exists: a source with the `review` setting can move a proposed record. See [Review](#review).

## Configuration

Keep real values in the settings file of the user, `~/.config/tenant-artifacts/memory-sources.json`.
This example uses synthetic names and paths:

```json
{
  "id": "agentcore",
  "type": "agentcore",
  "mode": "live",
  "memoryId": "ExampleMemory",
  "region": "us-east-1",
  "profile": "example-person-alice",
  "actorId": "alice",
  "scope": { "kind": "stage-file", "path": "/run/config/memory-dev.yaml" },
  "maxPages": 10,
  "refreshSeconds": 300
}
```

| Field | Meaning |
| --- | --- |
| `memoryId` | The ID of the dev memory resource. A stage file does not contain this value. |
| `region` | The AWS region. It must match the stage file when the adapter derives namespaces. |
| `profile` | The required person profile in the mounted AWS directory. The SDK resolves it only on a requested read; a failed profile never selects host credentials. |
| `actorId` | An active person in the stage file. Required for stage derivation. |
| `scope` | `kind` is `stage-file`. `path` names the mounted dev stage file. Relative paths start at the process working directory. |
| `namespaces` | An optional array of exact paths, or objects with `namespace`, `label` and an optional `group`. A `group` is a section name of the rail; the namespaces of one group stand together under that name. This array replaces stage derivation, including when empty. |
| `preload` | Optional `true`. The source root then reads each namespace, so each folder shows its count with no click. This costs one list request for each namespace when the reader enters the source, and again after the cache age. Default: off. |
| `maxPages` | Positive integer. Default: 10. Each list page requests at most 100 records. |
| `refreshSeconds` | Nonnegative cache age in seconds. Default: 300. Zero reloads each browse but keeps the latest records readable. |
| `timeoutMs` | Existing per-call deadline, including credential resolution. Default: 10000. |
| `maxSearchNamespaces` | Existing limit on namespaces per search. Default: 8. The result note reports skipped namespaces. |

An explicit namespace must start and end with `/`.
It contains only letters, digits, `_`, `-` and path separators.
Wildcards and unresolved placeholders fail configuration.
Duplicates keep the first label.
An explicit list bypasses stage validation; the operator must verify its dev resource and person scope.
AWS remains the permission authority.

## Review

A review is the decision of a person for a proposed record: approve or reject.
Only a source with the `review` setting has it. Without the setting, the source is read-only.

```json
{
  "id": "agentcore-review",
  "type": "agentcore",
  "mode": "live",
  "memoryId": "ExampleMemory",
  "region": "us-east-1",
  "profile": "example-reader",
  "review": { "profile": "example-reviewer" },
  "namespaces": [
    "/proposals/alice/preferences/",
    "/shared/alice/preferences/",
    "/rejected/alice/preferences/"
  ]
}
```

| Decision | Move |
| --- | --- |
| Approve | `/proposals/<developer>/<kind>/` to `/shared/<developer>/<kind>/` |
| Reject | `/proposals/<developer>/<kind>/` to `/rejected/<developer>/<kind>/` |

`<kind>` is `preferences`, `entities` or `events`.

Rules:

- `review.profile` names the profile of the reviewer role. It must differ from `profile`. All reads keep the read profile.
- The move is one `BatchUpdateMemoryRecords` request. It changes the namespace only. The text and the event time stay.
- The reader shows `Approve` and `Reject` only for a proposal whose target namespace is in `namespaces`. Each button needs a second click.
- The record must be in a loaded list or search result. An unknown identifier causes no AWS request.
- After a move, the other loaded proposals stay readable. The target namespace loads again at its next read.
- AWS can list a moved record at its old place for a short time. For 120 seconds after a move, each browse of the two namespaces reads AWS again, and the moved record stays out of its old list.
- The rail shows three sections: `Waiting for approval` (the proposals), `Approved` (the shared tree) and `Rejected`. A `group` of the configuration wins over these names.
- There is no delete, no text edit and no bulk action.
- AWS remains the permission authority. Limit the reviewer role to moves between these three trees.

The route is `POST /api/sources/<id>/review` with the JSON body `{ "id": "<item id>", "decision": "approve" }`.
A browser sends the Basic credential by itself, also for a request that another site starts.
The route therefore needs all of these: the JSON content type, the header `X-Tenant-Memory-Action: review`, and an `Origin` header that equals the `Host`.
A `Sec-Fetch-Site` header, when present, must say `same-origin`.

The reviewer profile needs a credential in the mounted AWS directory.

## Scope rules

`lib/agentcore-scope.mjs` implements the namespace rules of the AgentCore memory explorer that this app started from.
It builds the namespaces and checks their identifiers locally.
There is no runtime import from another checkout.

The strict parser accepts the stage file's mappings, lists and scalar values.
It rejects unsupported YAML forms, duplicate keys, invalid rosters, inactive members and unknown fields.
Stage derivation rejects any stage other than `dev`.
The optional person field `iamUser` does not change read scope.

| Scope | Exact namespaces |
| --- | --- |
| Global shared | `/shared/` |
| Own private | `/actor/<actorId>/` |
| Every joined project | `/project/<projectId>/shared/` and `/project/<projectId>/proposals/<actorId>/` |
| Maintained projects | Proposal and rejected namespaces for every current member and every offboarded person in the stage roster. |
| Event person strategies | The person's strategy namespaces with `{actorId}` replaced. |
| Session strategies | Not enumerated automatically. Supply exact session paths in `namespaces`, together with every other wanted namespace. |

A normal member gets no rejected namespace from stage derivation.
A maintainer can check the offboarded namespaces even when offboarding removed that person from the project roster.
The adapter lists exact namespaces, not every deeper path covered by an IAM read pattern.

## Person sign-in files

Use only the existing explorer sign-in files approved for this dev memory.
Keep paths and profile values in the settings file of the user, never in a tracked file.
The module runs as your user on your computer. It needs Python 3 for the explorer's standard-library sign-in helper.
The adapter uses the SDK dependency `@aws-sdk/credential-provider-ini` to select only the named profile of the AWS configuration of your user.

The package does not supply the sign-in helper or the sign-in file. The user supplies them.
The local module reads these files as your user:

| Input | Example path | Supplied by | Access of the module |
| --- | --- | --- | --- |
| The dev stage file | The `scope.path` of the source settings | The user | Read |
| AWS directory with the person profile | `~/.aws` | The user | Read |
| Sign-in helper `memory-signin.py` | `/opt/memory-signin/memory-signin.py` | The user | Run through `credential_process` |
| The person's sign-in file | `/opt/memory-signin/signin.json` | The user | Read by the helper |
| Sign-in cache directory | `~/.cache/example-memory-signin` | The helper | Read and write by the helper |

The AWS directory contains a `config` file, not an access key or a `credentials` file.
The profile uses `credential_process`:

```ini
[profile example-person-alice]
region = us-east-1
credential_process = /usr/bin/python3 /opt/memory-signin/memory-signin.py credential-process --signin /opt/memory-signin/signin.json
```

The cache contains a subdirectory named for the profile.
The helper checks file owners, modes and link counts.
Use the same numeric user as the existing files; do not change their owners or permissions.
Cache directories require mode `0700`; cache files require mode `0600`.
The adapter resolves only the named profile; a failed profile never selects another credential of the AWS directory.
Never pass an access key or token through environment variables.

Warning: the explorer helper writes its cache when it renews a session.

A valid cached session works without a cache write.
When the session has less than 900 seconds left, the helper attempts renewal and writes `session.json`.
It can also write `token.json` if the provider rotates the refresh token.
In a container with a read-only mount of the cache, those writes fail. As a local module, the helper runs as your user and can write its own cache.
The app itself starts no login.
The existing explorer can renew its own cache; a later app request can then reuse the renewed session.
The adapter reports a credential failure if no usable session is available.
Automatic renewal through a read-only cache is not verified or promised.

The person profile can allow writes outside this app.
The adapter's read-only command boundary does not turn that profile into a read-only AWS identity.

## Reads and cache

The global view, recent list, root folder list and unknown item lookup never read AWS.
A namespace browse loads that namespace only.
The list stops at `maxPages`; a remaining service token sets `partial: true`.
The count is then a lower bound, not the namespace total.
The global total stays unknown until every configured namespace has a fresh, complete list.
With a positive refresh age, expired cache entries do not appear as current counts or recent items.
With zero, every namespace browse reloads; the latest successful list and search remain available until replacement or failure.
No timer starts a remote read.

Search runs only when the caller explicitly selects this source.
It uses `RetrieveMemoryRecords` with `searchCriteria.topK`, bounded from 1 to 20 per namespace.
It searches at most `maxSearchNamespaces` namespaces concurrently.
Each namespace result keeps its own failure; one denial does not discard results from other namespaces.
The returned `errors` array names failed namespace paths and safe error codes.
The result note reports failures, skipped namespaces and remaining service pages.
The global hub currently forwards the note but not the structured `errors` or `partial` fields.

Each AWS call has one attempt and a deadline.
The hub has a separate request deadline and does not cancel an adapter load when that deadline expires.
A multi-page load can therefore finish after its HTTP request reports a timeout.
The deadline aborts the request and rejects even if credential resolution ignores the abort signal.
The adapter serializes reads of one namespace and coalesces concurrent list loads.
A failed read clears cached list and search records for that namespace only.
A live record whose ID starts with `sample-` fails the entire namespace, as in the explorer.
An error message never includes upstream details or credentials.

Record detail comes from a retained list or search cache entry only.
With a positive refresh age, the entry must still be fresh.
An unknown or expired record returns no item and makes no AWS request.
A search keeps its latest record set for each namespace, without claiming a complete namespace count.
Text stays complete in the detail result; only list titles and snippets are shortened.
Content stays in process memory, with no persistent cache, content log or automatic export.
A cached record is a past observation, not proof of current authorization.

## Checks and remaining integration

The tests use fake SDK clients and synthetic content from `sample/agentcore.json`.
They cover scope rules, configuration refusals, pagination, denial isolation, search, cache expiry, unknown records, deadlines and the sample guard.
A zero-age regression test keeps the latest records readable while each namespace browse reloads.
No test resolves a real AWS profile.

The optional live read is skipped in this package.
The existing helper can renew credentials and write the live cache.
Not verified: a count-only dev read with the approved sign-in files and an existing usable session.
No live sign-in and no AWS call forms part of this package's evidence.

The UI package should render namespace `state`, `partial` and `error` fields beside folders.
It should preserve the folder navigation when one namespace fails.
The server package should forward structured search `partial` and `errors` fields in global search results.
It should also align its request deadline with bounded multi-page loads, or propagate cancellation to the adapter.
The UI must leave AgentCore unselected in the default global search.
