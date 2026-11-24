# okknow

## One item

One item is one OpenKnowledge page.
Its identifier is the document name without `.md` or `.mdx`, such as `projects/gateway/brief`.
The reader shows the Markdown body and the page metadata separately.
The title comes from frontmatter, the first heading, or the document name.

The `wiki/` folder mirrors llm-wiki pages.
One page can therefore appear in both the okknow source and the llm-wiki source.
The app does not remove these duplicates.

## Access

The preferred access mode is `http`.
It uses the Model Context Protocol (MCP) endpoint at `/mcp` and the document API at `/api/document`.
Both endpoints use the configured HTTPS origin and the same Basic-auth credential file.
The origin contains only a host and an optional port.
The adapter refuses embedded credentials, paths, queries, fragments, and redirects.
It never falls back to the unauthenticated container port.

The `credentialFile` holds `user:password` for this stack.
The adapter does not read credentials from shell environment variables.
Host values and credential files stay outside tracked files.

Each MCP read initializes a session and sends `notifications/initialized` before the tool call.
The adapter passes the `mcp-session-id` header on later requests.
It accepts JSON and server-sent events (SSE), including open streams with notifications.
It closes the session with `DELETE /mcp` after the read or a failure.
This DELETE closes protocol state; it does not delete a page.
A cleanup failure does not replace the read result.

## Folders and recent pages

The adapter lists a folder with exactly `ls -l '<dir>'` through the `exec` tool.
It accepts relative paths with ASCII letters, digits, spaces, dots, underscores, hyphens, and slashes.
It refuses quotes, parent segments (`..`), shell operators, backticks, line breaks, absolute paths, and leading hyphens before any request.

Folder counts use `enrichedPaths[].recursiveMdCount` when the server provides it.
The overview counts Markdown files by their top-level folder with this fixed command:

```sh
find . -type f -name "*.md" | cut -d/ -f2 | sort | uniq -c
```

The overview groups root Markdown files under `Top level`.
It excludes the top-level folders `.ok`, `.git`, `.pi`, `.obsidian`, `node_modules`, and `assets`.
Folder lists also hide those names.

Recent pages come from each folder's `mostRecentMd` entry.
Their dates come from `mostRecentMd.updatedAt`, not a file-time field.
This list samples one page per reported folder; it is not a complete newest-page ranking.
The overview has no single newest date.

The listing parser accepts English month names and either a time or an explicit year.
It ignores warning lines before the listing.
It treats listing dates as UTC.
For a time without a year, it uses the current year unless that date is in the future.
In that case, it uses the previous year.

## Search and document reads

Search calls only the `search` tool with a query and the `page` and `content` scopes.
The query stays in a JSON argument; it never becomes a shell command.
Results keep the server's document name, title, score, and available preview.
The app does not compare this score with scores from another source.
A cold index produces a note that results can be incomplete.
HTTP search covers the base; it does not apply a folder filter.

A page read uses `GET /api/document?docName=<name>`.
The response must contain the exact requested `docName`.
A mismatch gives `bad_reply`; HTTP 404 gives no item.
HTTP 401 and 403 give `denied`.
MCP tool failures give `failed` without exposing the server's error text.

## File access

The optional `files` mode indexes a read-only content mount instead of using the server.
It needs owner approval because it bypasses server authentication and attribution.
It does not use a credential or make a network request.

This mode reads `.md` and `.mdx` files, skips hidden entries and the excluded folders, and does not follow symbolic links.
It searches the local index and supports a folder filter.
Its date uses frontmatter `updated`, `date`, or `created`, then the file modification time.
It keeps the index in process memory and writes nothing to the source.

The scan skips files only for `EACCES`, `EPERM`, `ENOENT`, a path outside the root, or a path that is not a file.
It skips subdirectories only when listing fails with `EACCES`, `EPERM` or `ENOENT`.
A successful partial load removes skipped entries and reports nonzero skip counts without names or paths.
No documents with any skip fails the reload, as does an unreadable root or any other read or parser error.
A failed reload keeps the previous index with an error status.
Failed loads, including the initial load, retry only after the refresh interval.

## Limits

| Limit | HTTP mode | Files mode |
| --- | --- | --- |
| Browse page | 200 items | 200 items |
| Search request | Default 20; maximum 100 | Default 20 |
| Refresh | Top-level counts: 120 seconds by default | Full index: 120 seconds by default |
| Timeout | 15 seconds per request by default, including the response body | No adapter-specific deadline |
| File coverage | Overview counts lowercase `.md`; browsing also lists lowercase `.mdx` | At most 25,000 Markdown files |
| Large files | No adapter-specific response size cap | Files over 2 MiB have an empty body |

`refreshSeconds` changes the refresh interval.
`timeoutMs` changes the HTTP request deadline.
One MCP read makes several requests; the timeout is not a deadline for the whole session.
The hub applies its own deadline to source operations.

## Verification

The tests use local HTTPS stubs and synthetic page content from `sample/okknow.json`.
They generate a temporary certificate with OpenSSL and trust it only in the isolated test process.
They close the stub servers and remove their temporary files.
They do not contact the live server or use shell credentials.

Run the approved check from the repository root:

```sh
cd app && node --test 'tests/*.test.mjs'
```

The suite checks the allowed tool calls, session cleanup, JSON and SSE responses, error states, redirects, and timeouts.
It also checks path refusal, listing dates, counts, recent dates, document identity, and file access.

The live check is skipped: it needs a stack credential.
`node check-readonly.mjs` in the package runs the read-only guard.
