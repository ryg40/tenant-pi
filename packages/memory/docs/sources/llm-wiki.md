# llm-wiki

## One item

One item is one Markdown page under `wiki/` of the configured vault.
The app uses the relative file path as its identifier.
The title comes from front matter, the first heading, or the file name.
The reader shows the body, front matter, relative path, file time and size.

## Folders

Folders follow the directory tree under `wiki/`.
The app labels common folders, such as `wiki/concepts` and `wiki/entities`.
It skips hidden paths, symbolic links found during traversal, and files named `index.md`.
It never loads `meta/`.
Set the existing `includeRaw` option to `true` to include Markdown files under `raw/`.
Missing `raw/` is allowed.

## Dates

The displayed date uses this order: `updated`, `created`, `date`, then the file modification time.
The date label identifies the chosen field.
The reader also shows the file time separately.

## Refresh

The hub calls `warm()` at startup.
The first request waits if that initial load has not finished.
After the first load, requests use the cached index while one background reload runs.
The next request starts a reload when the refresh interval expires.
The existing `refreshSeconds` option defaults to 120 seconds.
There is no periodic timer or file watcher.

A reload checks file access, modification times, sizes and identities.
It reads and parses only new or changed files, and removes entries for missing files.
An unchanged readable file keeps its parsed entry without another content read.
Reads run in parallel with a maximum of 16 active file operations.

The scan skips files only for `EACCES`, `EPERM`, `ENOENT`, a path outside the root, or a path that is not a file.
It skips subdirectories only when listing fails with `EACCES`, `EPERM` or `ENOENT`.
A successful partial load stays `ok` and removes skipped entries from the index.
Its detail includes nonzero skip counts, never skipped names or paths.
It counts skipped directories separately because their file counts are unknown.

A reload fails if it loads no documents after a skip, cannot read `wiki/`, or loses its mount.
Any failed reload keeps the previous index and reports an error.
Transient read errors and parser errors also fail the reload.
The adapter's `status()` reports the failure without exposing paths or content in the error.
After any failed load, including the initial load, another request can retry only when the refresh interval expires.

## Limits

- The combined scan stops at 25,000 Markdown paths, including skipped `index.md` paths.
- The app reads files up to 2 MiB (2,097,152 bytes).
- An oversized file shows a size notice instead of its text.
- Each browse page contains at most 200 items.
- Search uses local text matching, not semantic retrieval.
- The cache stays in process memory. The app writes nothing to the vault.

Mount the vault read-only.
The cache can miss an in-place edit that preserves the file identity, size and modification time.
A file that changes during open or read fails that reload; the previous index remains available.
