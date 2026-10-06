# Configuration

The tool reads settings in this order. The first match wins.

1. Command flags: `--repo-path`, `--state-dir`, `--config`.
2. Environment variables (table below).
3. The config file: `--config FILE`, `TRACKER_CONFIG`, or `<state dir>/config.json`.
4. Defaults.

The repository identity comes from the `origin` remote when the config does not name it. The tool drops credentials from remote URLs.

## State directory

Default: `~/.pi/agent/tracker-state/<repo-slug>/`. The slug is the `owner/name` identity in lower case with `-` separators, for example `owner-tenantext`.

| File | Content |
| --- | --- |
| `config.json` | Optional configuration |
| `checkpoint.json` | The bounded checkpoint packet (at most 8192 bytes) |
| `run.json` | Stage status, attempts, errors, runtime, model calls and tokens |
| `runs/` | Earlier `run.json` files |
| `lock` | The run lock (pid, host, command, start time) |
| `base.md`, `base.json` | The brief and revision that the run started from |
| `facts.json` | Scripted Git and issue facts |
| `synthesis-input.md` | The packet for the model step (at most 32768 bytes) |
| `synthesis-output.md` | A copy of the applied model output |
| `candidate.md`, `candidate.html` | The brief of the current run |
| `last-good.md`, `last-good.html`, `last-good.json` | The last validated brief |
| `pending/` | A brief that waits for the canonical store, and archived ones |
| `publication.json` | Last publication: link, expiry, verification. No tokens. |
| `publish-queue.json` | A queued publication retry |
| `log.jsonl` | Events. No tokens. |

## Config file

```json
{
  "repo": "owner/tenantext",
  "repo_url": "https://git.example.com/owner/tenantext",
  "title": "Tenantext restart brief",
  "scope": "Tenantext Pi extension suite and the tracker work.",
  "store": {"backend": "local", "path": "docs/tracker-brief.md"},
  "issues": {"api": "https://git.example.com/api/v1", "token_env": "GITEA_TOKEN", "max_pages": 4, "page_size": 50},
  "git": {"max_commits": 30},
  "max_retries": 2,
  "stale_lock_seconds": 3600,
  "publish": {
    "endpoint": "https://artifacts.example.com",
    "credential_file": "/home/dev/.config/artifact-token",
    "receipt_dir": "~/.pi/agent/tracker-publications",
    "edit_token_header": "X-Edit-Token"
  }
}
```

- `store.path` is relative to the repository root. The default is `docs/tracker-brief.md` when `docs/` is a directory, else `tracker-brief.md` at the root.
- An explicit `store.path` overrides that default. `TRACKER_STORE_PATH` overrides the configured path.
- The default never uses `.okf/`: the brief has no OKF frontmatter. An explicit path can still select that directory.
- `store.backend: openknowledge` selects the OpenKnowledge adapter. It is detection only. See [storage.md](storage.md).
- `issues.api` is the Gitea API base. Without it, the tool skips issue collection and labels the brief with an `unknown` record.
- The issue token comes from the environment variable named in `issues.token_env` (default `GITEA_TOKEN`) or from `issues.token_file`. It travels only in a request header.
- `max_retries`: a stage may fail `max_retries + 1` times per run.
- `publish.edit_token_header` is the request header that carries the edit token on a refresh. The default is `X-Edit-Token`. Set the name that the artifact service documents. See [publication.md](publication.md).
- `publish` stays off until `endpoint` and `credential_file` are set, and runs only on an explicit publish command.

## Default view budgets

The validator keeps these defaults. See [the schema](../../../tracker/schema.md#budgets) for the fields included in the word count.

| Limit | Default |
| --- | --- |
| Word warning | More than 400 words |
| Word error | More than 550 words |
| Position | Exactly 1 record |
| Changes | At most 3 records |
| Active items | At most 3 records, with distinct priorities from 1 to 3 |
| Recommended path | At most 1 record |
| Alternative paths | At most 2 records |
| Handoff | Exactly 1 for a recommended path, else none |
| Approval boundaries | At least 1 gate record |

Approval gates and critical unknowns stay visible. Their item counts have no upper limit.

## Environment variables

| Variable | Setting |
| --- | --- |
| `TRACKER_REPO_PATH` | Repository path |
| `TRACKER_STATE_DIR` | State directory |
| `TRACKER_CONFIG` | Config file |
| `TRACKER_STORE_PATH` | Local store path |
| `TRACKER_ISSUES_API` | Issue API base |
| `TRACKER_ISSUES_TOKEN_FILE` | Issue token file |
| `TRACKER_PUBLISH_ENDPOINT` | Artifact service origin |
| `TRACKER_PUBLISH_CREDENTIAL_FILE` | Artifact service token file |
| `TRACKER_RECEIPT_DIR` | Publication receipt directory |
| `TRACKER_OK_CLI` | Path of an OpenKnowledge `ok` CLI, for detection only |

All URLs must be credential-free HTTPS.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | A stage failed; `status` shows why |
| 2 | Configuration error |
| 3 | Waiting for the model step |
| 4 | Another refresh holds the lock |
