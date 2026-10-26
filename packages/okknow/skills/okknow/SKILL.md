---
name: okknow
description: okknow is the one path to the OpenKnowledge (OK) server of the user. Use when an agent reads, searches, writes, or deletes OK pages (for example projects/<slug>/handoffs), uploads an OK asset, or an OK connection fails.
---

# okknow

OpenKnowledge (OK) is a markdown knowledge base with an MCP server. `okknow` is the name of each path to the one OK server of the user. The user chose that server with `okknow setup`; `okknow origin` prints it. Never use another OK server or a vendor cloud OK service.

## Choose the path

Use the first path that works.

| Order | Path | How |
|---|---|---|
| 1 | MCP server `okknow` | Claude Code: tools `mcp__okknow__<tool>`. Pi: `mcp({ tool: "okknow_<tool>", args: {...} })`; if Pi says "not connected", call `mcp({ connect: "okknow" })` once. Omit the `cwd` argument. |
| 2 | CLI `okknow` | `okknow read <doc>`, `ls <dir>`, `search <query>`, `write <doc> <file> --summary ...`, `asset put <file> <dest>`, `doctor`. When `okknow` is not on `PATH`, run `~/.local/bin/okknow`. |
| Never | Write, edit, move, or delete files in the content directory of the server | Writes bypass the collaboration server, lose attribution, and conflict with open editors. |
| Never | `ok mcp`, `ok start` or `npx @inkeep/open-knowledge` against the content directory of a running server | OK allows one server process per project. |

Claude Code has the MCP server only after a step of the user; the kit installer does not add it. Until then, a Claude Code session uses path 2. The step:

```sh
claude mcp add-json -s user okknow "{\"type\":\"http\",\"url\":\"$(~/.local/bin/okknow origin)/mcp\",\"headersHelper\":\"$HOME/.local/bin/okknow --json auth-header\"}"
```

Credentials come from `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` at run time. Do not print, copy, or pass them. Do not run `okknow auth-header`; it exists only for the agent harness.

## Write rules

1. Read the page before you change it. Use `replace` only after you compare the page with what you read.
2. Use `append` for logs, handoffs, and inbox trailers. Use `edit` (find and replace) for a small change in a page that another writer owns.
3. Give each write a `summary` of at most 80 characters: `<agent>/<model> <project>: <intent>`, for example `pi/<model> okknow: add test results`.
4. Start each new page with frontmatter that has `type`, `title`, and `description`. An `index.md` has no frontmatter.
5. Never write credentials, tokens, cookies, or raw environment output in a page or a summary. Write the name of the secret store item instead.
6. Read the page back after a write when the result matters. If the server answers "Concurrent overwrite refused", wait the stated seconds, read again, and retry.
7. Delete only pages that you created, for example a scratch page.

Addresses: `write`, `edit`, and `delete` take a document name without `.md` (`projects/demo/handoffs`). `exec` takes a file path with `.md` (`cat projects/demo/handoffs.md`).
Argument shape: `write { document: { path, content, position }, summary }`. The `document` value is an object, not a string.
A write answer can say "No UI is running ... `ok start`". Ignore it when the server runs.

## Pages that kit skills use

| Path | Rules |
|---|---|
| `projects/<slug>/brief` | Replace after a comparison. |
| `projects/<slug>/handoffs` | Append only. |
| `projects/<slug>/DUMMIES` | The session log of the `dummies` skill. Its script `page.py` writes it. |

## Check the path

Run `okknow doctor`. The last line must be `doctor: PASS`. `okknow setup --check` prints the state of the saved origin without credentials.
For tool names, the configuration, troubleshooting, and the install steps, read [references/details.md](references/details.md).
