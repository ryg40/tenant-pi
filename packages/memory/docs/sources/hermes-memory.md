# hermes-memory

## One item

One item is a row from the `memories` table or an entry from a Markdown memory file.
A line containing the section sign (`U+00A7`) separates file entries.
The app keeps store rows and active entries separate because they describe different views of memory.

The reader shows native text and metadata, including the row number for a store item.
An active or project entry also shows each matching row number when its text equals a store row's text.
The comparison excludes the file entry's date comment and surrounding whitespace.
It does not remove duplicate entries or merge their metadata.

## Folders

| Folder | Contents |
| --- | --- |
| `store/<target>` | Rows from `sessions.db`, grouped by the native target |
| `active/memory` | Entries from `MEMORY.md` |
| `active/user` | Entries from `USER.md` |
| `active/failure` | Entries from `failures.md` |
| `projects/<project>` | Entries from `<project>/MEMORY.md` under the configured `projectsPath` |

The configured `path` is the hermes root.
The existing `projectsPath` option is optional.
If configured, the projects directory must be readable.
Hidden project directories and symbolic-link project directories stay out.
Missing individual memory files and a missing store are allowed.
An unreadable or corrupt store fails the load instead of silently hiding rows.

## Dates

A file entry can end with `<!-- created=2026-07-01, last=2026-10-30 -->`.
The displayed date uses `last`, then `created`, then the file modification time.
For a store row, it uses `last_referenced`, then `created`.
The date label identifies the chosen field.
Store metadata retains the available dates, category, project, failure details and hit counts.

## Refresh

The hub calls `warm()` at startup.
The first request waits if that initial load has not finished.
Later requests use the cached index while one background reload runs.
The next request starts a reload when the refresh interval expires.
The existing `refreshSeconds` option defaults to 60 seconds.
There is no periodic timer or file watcher.

A reload checks file access, modification times, sizes and identities.
It reads only new or changed Markdown files and removes entries for missing files.
File reads use at most 16 active operations.
The store reloads when its database, write-ahead log (WAL), or shared-memory index changes.
An unchanged store keeps its parsed rows.
Row matches update after each successful reload, even when the active file has not changed.

The scan skips Markdown files only for `EACCES`, `EPERM`, `ENOENT`, a path outside the root, or a path that is not a file.
This includes refused files below project directories.
A successful partial load stays `ok` and removes skipped entries from the index.
Its detail includes nonzero skip counts, never skipped names or paths.
Readable store rows count as data, even when every Markdown file is skipped.

A missing mount, an unreadable configured root, or no Markdown documents or store rows after a skip fails the reload.
Any failed reload keeps the previous index and reports an error.
Store failures, transient read errors and parser errors also fail the reload.
The adapter's `status()` reports the error without exposing paths or content.
After any failed load, including the initial load, another request can retry only when the refresh interval expires.

## SQLite access

Mount the hermes root and projects directory read-only.
The app opens SQLite with `readOnly: true` and closes each connection after reading.
It reads schema metadata and the `memories` table only.
It never reads the `sessions` or `messages` tables.

Existing readable WAL sidecars can expose rows that have not reached the main database file.
If SQLite cannot access the WAL index, the app retries with `mode=ro` and `immutable=1`.
That fallback sees only the checkpointed database, not pending WAL rows.
A corrupt database remains an error; it does not trigger this fallback.
A read-only SQLite connection is not a replacement for a read-only mount.
SQLite can otherwise create or update WAL sidecars.

## Limits

- The scan includes at most 25,000 active and project Markdown files.
- The app reads files up to 2 MiB (2,097,152 bytes).
- An oversized file shows a size notice instead of entries.
- Store rows have no count or text-size cap. SQLite reads them synchronously.
- Each browse page contains at most 200 items.
- The cache stays in process memory. The app writes nothing to the memory source.

File entry identifiers use their position within the file, so an insertion can change later identifiers.
The cache can miss an in-place edit that preserves the file identity, size and modification time.
A large store read can briefly block the Node event loop even though requests do not await the background reload.
