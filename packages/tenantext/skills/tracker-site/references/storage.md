# Canonical storage

Every summarized repository keeps one canonical brief. The tool writes it only through a storage adapter with a read-before-write check.

## Adapter contract

- `read()` returns `(text, revision)`. A missing brief returns `(None, None)`.
- `write(text, expected_revision)` writes only when the stored revision still equals `expected_revision`. Otherwise it raises `ConflictError` and changes nothing.
- An unreachable backend raises `StoreUnavailable`. The tool then keeps the brief in the pending queue.

The revision is `sha256:` plus the content hash.

## Local file (verified)

`store.backend: local` keeps the brief as a Markdown file in the repository. The default path is `docs/tracker-brief.md` when `docs/` is a directory, else `tracker-brief.md` at the repository root. An explicit `store.path` overrides the default. The file is a normal repository file: the requester reviews and commits it. The tool never commits, pushes or merges.

## OpenKnowledge (not verified)

The intended canonical store is the repository's OpenKnowledge project. The OpenKnowledge page API is not available to this tool yet, so the adapter only detects what is installed:

- an `ok` CLI on `PATH` (or `TRACKER_OK_CLI`),
- an `open-knowledge` MCP server in the agent configuration.

In every case `read` and `write` report the store as unavailable, with the reason. The refresh then keeps a pending brief and the last-good copy, and `status` shows the reason. The tool does not guess CLI commands or page paths.

An agent that has the OpenKnowledge MCP tools can copy `last-good.md` into the project by hand, after it reads the current page and checks that the requester did not change it.

To add a real adapter later:

1. Verify the OpenKnowledge project and page API.
2. Implement `read` and `write` with a revision check from that API.
3. Test conflict handling against a real project before use.

## Requester edits

The requester may edit the canonical brief at any time.

- Prose paragraphs between records are requester notes. Refreshes keep them byte for byte.
- To write your own next-session prompt, set `source: requester` in the `handoff` record and edit its `text: |` block (two-space indent). Refreshes keep it while its path stays recommended. A generated prompt is rebuilt on every refresh.
- A refresh builds on the brief read at checkpoint time. An edit after the checkpoint makes the store refuse the write. Run `tracker checkpoint` and refresh again.
