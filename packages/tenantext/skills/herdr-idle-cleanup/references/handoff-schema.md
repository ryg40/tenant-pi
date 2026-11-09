# Handoff schema

The JSON files of the handoff directory (setting `handoff_dir`, default
`~/.local/share/tenant-pi/handoffs/`) and the lock rule of `index.json`. The
directory has mode 0700; each file has mode 0600. Each writer writes through a
temporary file in the same directory and a rename. A field with no value is
`null`.

## scan.json (version 1)

Written by `scan`. `harvest` and `close` read only version 1 and stop on another version.

| Field | Value |
| --- | --- |
| `version` | `1` |
| `scanned_at`, `scanned_at_epoch` | The scan time: ISO 8601 UTC, and epoch seconds. |
| `idle_minutes` | The idle threshold of the scan. |
| `caller` | `pane_id`, `workspace_id` of the caller. |
| `protected_setting` | The protected workspace names and ids. |
| `classes` | The count of workspaces for each class. |
| `workspaces[]` | `workspace_id`, `label`, `class` (`protected`, `blocked`, `active`, `unknown`, `idle`), `reason`, `herdr_status`, `tabs[]` (`tab_id`, `label`), `panes[]`. |

Each pane has `pane_id`, `tab_id`, `tab`, `agent` (null for a pane with no
agent), `name`, `status` and `cwd`. An agent pane adds:

| Field | Value |
| --- | --- |
| `last_activity_epoch`, `idle_minutes` | The last activity, or null when unknown. |
| `activity_source` | `herdr:<key>`, `transcript`, `pi-session-file` or `none`. |
| `transcript` | The transcript path, or the Pi session file when `activity_source` is `pi-session-file`. |
| `pending_question`, `screen_readable` | The matched screen line or null, and whether the screen was read. |
| `background_agent` | The screen line that matches `BACKGROUND_AGENT_PATTERNS` (a Claude Code footer such as `← 1 agent`), or null. A match makes the workspace `active`. |
| `git_top`, `git_dirty` | The Git top level of `cwd` and its uncommitted changes, or null. |

## The handoff file `<stamp>.json` (version 1)

Written by `harvest`, beside `<stamp>.md` with the same stem. `<stamp>` is
the harvest time in UTC as `YYYYMMDD-HHMMSS`; a second harvest in the same
second adds `-2`, `-3`. The harvest reserves both names with exclusive
create, so two harvests never write the same file. The Markdown file holds the same entries: the priority
index (P1 first), then one section for each workspace.

| Field | Value |
| --- | --- |
| `version` | `1` |
| `created_at` | The harvest time, ISO 8601 UTC. |
| `scan` | `path` and `scanned_at` of the scan.json that was read. |
| `counts` | `P1`, `P2`, `P3`: the count of entries for each priority. |
| `entries[]` | One entry for each agent pane of an `idle` workspace, ordered by priority. |

An entry:

| Field | Value |
| --- | --- |
| `id` | 16 hex characters: SHA-256 of the pane id, a NUL byte and the final reply text. The same pane with the same reply gives the same id. |
| `workspace`, `workspace_label`, `pane`, `agent`, `name`, `cwd` | From scan.json. |
| `source` | `kind` (`transcript`, `pi-session-file`, `none`) and `path` of the file that gave the reply. |
| `repo` | `top` (Git top level), `origin` (the `origin` URL with no user name or password) and `name` (the last path part of `origin` without `.git`, else the folder name of `top`). |
| `report_state` | `report` for a valid block of compact report syntax 2, else `no report`. |
| `parse_detail` | Only for `no report`: `missing: ...` or `ambiguous: ...`. |
| `kind`, `headline` | `REPORT` or `OUTCOME`, and the whole head line. Null headline for `no report`. |
| `items[]` | `number`, `state`, `text`. Empty for `no report`. |
| `warnings[]` | The text of each `**Warning:**` line. |
| `next` | `{"actions": [{label, actor, condition, text}]}`, or `{"none": "<reason>"}` for `**Next:** None.`, or null for `no report`. |
| `report_text` | The block lines only; for `no report` the first 12 lines of the reply, clipped. Never the transcript. |
| `priority`, `reason` | `P1`, `P2` or `P3`, and one line that names the rule. |
| `summary` | Only after `--summarize`: `{"by": "model", "text": ...}`. |
| `model_rank` | Only after a usable `--model-rank` answer: the place within the priority, from 1. |

The rank rules, the first that applies wins (constants in `scripts/harvest.py`):

1. P1: an item `Blocked` or `Failed`; a word of `SECURITY_WORDS`; an action of `Owner` or `Owner decides` with no condition (it waits on the owner now).
2. P2: an item `Running` (the pane stopped while work was running); an item `Unverified` or `Needs approval`; an action of `Owner` or `Owner decides` with a condition; a `**Warning:**` line.
3. P3: the rest.

A valid block is ranked from its parsed fields and `report_text`. A
`no report` entry is ranked by the same rules from the whole reply: an item
marker before a state word (`- **[2]** Failed:`, `2. FAILED:`), an `Owner`
actor before a colon, a `Warning:` line, a security word. Its parsed fields
stay empty, and its `reason` says that the block was not valid. Only `\n`,
`\r\n` and `\r` end a line.

## index.json (version 1)

One record for each entry that any harvest found. A harvest adds a record only
for a new `id`; an older record keeps its fields and its `state`, except
under the supersede rule below.

| Field | Value |
| --- | --- |
| `version` | `1` |
| `entries[]` | The records. |

A record: `id`, `repo` (as in the entry), `workspace`, `workspace_label`,
`pane`, `agent`, `cwd`, `source` (the path, or null), `priority`, `reason`,
`state`, `created_at` (ISO 8601 UTC) and `handoff` (the file name of the
`<stamp>.json` that first held the entry). `state` is `open` for a new record;
`startup` sets `presented` (with `presented_at`), and `entries set` sets
`acknowledged`, `done` or `dismissed` (with `state_changed_at`). `entries set
<id> open` (the change `reopen`) takes a `presented` record back to `open`.

A new record of a pane supersedes each older record of the same `pane` with
the state `open` and the same or a lower priority (P1 is the highest): that
record gets the state `dismissed` and the field `superseded_by` with the `id`
of the new record. An older `open` record of a higher priority stays `open`,
so a short P3 reply does not hide an older P1. A record in another state
stays as it is.

`close` adds these fields to the record of each agent pane of a workspace
that it closes. It writes `resume` and `closed_at` before the Herdr close.

| Field | Value |
| --- | --- |
| `resume` | `workspace`, `workspace_label`, `pane`, `agent`, `name`, `cwd` and `session_file` (the transcript or the Pi session file) from the fresh read before the close. |
| `closed_at` | The close time, ISO 8601 UTC; null after a failed close. |
| `close_error` | Only after a failed close: `at` (ISO 8601 UTC) and `message`. A later successful close removes it. |

After a failed close, `resume` stays in the record. When the lock times out
for the failure write, `close_error` is not written; the `failed` row of the
output names the error.

`close` uses the record of the current final reply of each pane: the `id`
of the pane and its final reply now. A pane with no such record keeps its
workspace open with the reason `no handoff entry`.

## The lock of index.json

Each write of `index.json` goes through `idle_cleanup.py` and its lock:

1. Open `index.json.lock` in the same directory (create it with mode 0600 when it is missing) and take an exclusive kernel lock on it with `flock`. The lock file stays in place.
2. Read `index.json`, change it, and write it through a temporary file in the same directory, an `fsync` and a rename.
3. Release the lock. The kernel also releases it when the process ends, so a lock is never stale.

`harvest` and `close` wait for the lock and stop with an error after 30
seconds. Then `index.json` stays unchanged. `harvest` writes its handoff pair
`<stamp>.md` and `<stamp>.json` before it takes the lock, so after a lock
timeout the pair stays in the directory with no records in `index.json`; a
later harvest adds the records. `close` stops before the next close after a lock
timeout. A reader reads `index.json` with no lock: the rename makes
each read whole. A reader ignores the fields that it does not know, and a
writer keeps them. Node has no `flock`, so a later state change from a
TypeScript extension or a hook calls this script to write.

## startup and entries

`startup --cwd <dir> [--format text|json]` runs at the start of a Pi or
Claude Code session. It reads the repository key of `<dir>` as `harvest` does
for a pane, and finds the `open` records of that repository. A record matches
by the first rule that applies:

1. `top`: the same Git top level.
2. `origin`: the same `origin` URL (no user name or password).
3. `name`: the same repository name, only when neither side has an `origin`
   and the `top` of the record no longer exists. Two live checkouts with the
   same folder name are different repositories.

The claim rule: in one step under the lock, `startup` reads `index.json` and
builds the prompt text of each candidate, and changes `open` to `presented`
only for a record that is still `open` and whose text was built. A record
whose text fails to build (a malformed item or field) stays `open`. It claims
at most 3 records (`MAX_CLAIM` in `scripts/entries.py`), P1 first, then
the newest. Only the claimed records go into the output, so two sessions that
start at once never assess the same record. The rest stay `open`, and the
output names their count. `startup` writes nothing when it claims nothing.
Standard error gets one line `handoffs: claimed <id> ...`, so a lost delivery
can be traced and reopened. An error (for example an `OSError` of a read-only
handoff directory) gives one `error:` line and exit 1.

`startup` prints nothing and changes nothing when the environment variable
`HERDR_SKILL_SESSION` is `task`. `spawn.py` of the herdr skill sets it in each
task session. The Pi extension runs `startup` only for the `session_start`
reason `startup` in a session with a UI; the Claude Code hook runs it only for
the start source `startup` outside print mode.

The text output is empty when no record is claimed. Else it is the assessment
prompt: each claimed record with the report fields of its `<stamp>.json`
(report text, items, warnings, next actions, priority, reason, age, source,
workspace and pane), then the instruction `ASSESSMENT_INSTRUCTION` of
`scripts/entries.py`. `--format json` prints `claimed[]`, `remaining`,
`other_open`, `instruction` and `prompt`.

`entries list [--cwd <dir>]` prints the records, the records of the repository
of `<dir>` first. `entries show <id>` prints one record with its report.
`entries set <id> <state>` sets `acknowledged`, `done`, `dismissed` or `open`
under the lock; `open` only for a `presented` record. An id is the full id or a prefix that matches one record.

Two settings keys of the settings file control `startup`:

| Key | Values | Default |
| --- | --- | --- |
| `startup_assessment` | `all`: claim each matching record; `p1`: claim only P1 records; `off`: claim nothing and print nothing. `switch off` writes `off`; `switch on` writes `all` only after `off`, so a `p1` choice must be set again after an off | `all` |
| `startup_other_count` | `true`: with no claim, print one line with the count of open records of other repositories | `false` |
