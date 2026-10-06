---
name: openknowledge-project-pages
description: Read and write Promptr's per-project OpenKnowledge pages (brief, inbox, workspace, handoffs) through the pinned HTTP API without leaking credentials or clobbering user text.
---

# OpenKnowledge project pages

Use when an agent must read or update a project's shared pages at `https://openknowledge.example.com` (or `OPENKNOWLEDGE_ORIGIN`): orienting from a brief, queueing browser-typed thoughts, mirroring the workspace, or appending a handoff. Promptr's companion does this automatically; this skill is for agents doing it by hand or debugging a sync.

Repo copy (`packages/promptr/skills/openknowledge-project-pages/`) is distributable source; the installed global copy under `~/.pi/agent/skills/` is runtime state. Synchronize intentionally and `cmp` after updates.

## Page tree

```text
projects/<slug>/brief       current orientation. Humans and Promptr edit; "replace" after a read comparison; local copy in <cwd>/.promptr/briefing.md with history in briefing-history/.
projects/<slug>/inbox       user-typed thoughts, one block each (a `## ` heading or a `---`-separated paragraph group). Promptr only reads it and appends `<!-- promptr:queued <hash> <iso> -->` trailers at the page end (`position: append`, never a rewrite). Never edit user text.
projects/<slug>/workspace   Promptr-written mirror of queue/composer/notebook head ("replace"). Humans read; edits are overwritten.
projects/<slug>/handoffs    append-only: handoffs, 200k wrap-ups, automatic checkpoints. Corrections are appended, never rewritten.
```

`<slug>` is the project directory basename lowercased with `[^a-z0-9_-]` runs turned into `-`, max 80 characters (`promptr`, `my-project`). It is the URL segment a human types, not the hashed local state slug. The four pages are the whole schema; add a page only when actual use needs one.

## Procedure

1. Credentials come only from `OPENKNOWLEDGE_USERNAME` / `OPENKNOWLEDGE_PASSWORD` in the current environment. Never write them to files, argv, packets, notices or tracker comments. Build the header once: `Authorization: Basic base64(user:pass)`. Use `redirect: error`, an 8 s timeout, no retries.
2. Read: `GET /api/document?docName=projects/<slug>/<page>` → `{docName, content, lifecycle}`; 404 (`urn:ok:error:doc-not-found`) means missing, 401 means auth, anything else is "offline", never "missing". Check `docName` echoes what you asked for.
3. Create a missing page: `POST /api/create-page` with `{"path":"projects/<slug>/<page>.md"}`; 409 means it already exists (a lost race, not an error). Never create `brief` outside Save + sync: a seeded brief makes the next sync look like a conflict.
4. Write: `POST /api/agent-write-md` with `{"docName":..., "markdown":..., "position":"replace"|"append", "summary":"<short reason>", "clientName":"promptr"}`. `replace` only for `brief` (after comparing with what you read) and `workspace`; `append` for `handoffs` and inbox trailers. Read back after a write when the result matters.
5. Browse: `GET /api/documents?dir=projects` lists document/folder rows (names contain `/`).
6. Inbox consumption (Promptr convention): split the page into blocks, hash each block's text (sha256, first 16 hex), skip hashes already in the project state dir `inbox-seen.json`, enqueue the rest as thoughts, then append one trailer per queued block at the page end. Trailers on the page also count as consumed, so a lost state file never re-queues. A block whose text changes gets a new hash and is queued again. Everything before the first `## ` heading or `---` line is preamble (the seed text), never a block.

Quick read from a shell (credentials stay in the environment):

```sh
curl -s -o out.json -w '%{http_code}\n' -u "$OPENKNOWLEDGE_USERNAME:$OPENKNOWLEDGE_PASSWORD" \
  "https://openknowledge.example.com/api/document?docName=projects%2Fpromptr%2Fbrief"
```

## Pitfalls

- A read comparison is not compare-and-swap: another client can still race a write. Retain the previous revision locally before replacing and show a conflict instead of merging.
- Local-first always: a failed sync leaves the local copy authoritative and the status `pending`/`offline`; never block the user's TUI on the network.
- Do not migrate or touch the root `promptr.md` notebook; do not dump raw traces, environment or tool output into shared pages.
- Fixture tests do not prove deployed compatibility; a live read/write trial needs the user's separate authorization.
