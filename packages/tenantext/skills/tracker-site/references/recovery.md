# Stages, recovery and limits

## Stages

`collect -> synthesize -> validate -> render -> store -> publish`

`checkpoint` starts a run. It writes `checkpoint.json` and a fresh `run.json` before any other work. `run` resumes the first unfinished stage.

| Stage | Input | Output |
| --- | --- | --- |
| collect | The checkpoint | `facts.json`: commits since the previous brief, changed files, branches, worktrees, issues |
| synthesize | Packet and model output, or facts for a minimal brief | `candidate.md` |
| validate | `candidate.md` | Diagnostics. A valid brief becomes `last-good.md`. |
| render | `candidate.md` | `candidate.html` and `last-good.html` |
| store | `candidate.md` and the base revision | The canonical brief, or the pending queue |
| publish | `candidate.html` | A verified share link (opt-in) |

Each stage records its status, attempts, failures, error text, input hash, runtime, model calls and tokens.

- Scripted stages record zero model calls and zero tokens.
- The synthesize stage records what the model step reports, or `null` when it is unknown.
- `status` sums them. `unknown` means at least one value was not reported.

## Idempotency

A stage that is done for the same input hash does nothing on a rerun. A new input (for example new model output) runs it again.

- store: when the canonical brief already equals the candidate, the result is `unchanged`. No second write happens.
- publish: the idempotency key comes from the content hash. A retry with the same HTML reuses the key, so the service returns the same artifact. After the first success, publication uses PUT on the same link.

## Retries

A stage may fail `max_retries + 1` times per run (default 3). After that, the stage stops, and `status` says so. Start a new run with `checkpoint`. There is no automatic retry loop and no background polling.

## Lock

Every command except `status` takes the `lock` file.

- A second command refuses with exit code 4 while the holder lives.
- A lock is stale when its process is gone on the same host, or when a lock from another host is older than `stale_lock_seconds`. The tool renames a stale lock to `lock.stale-<time>` and continues.
- Stages left `running` by a dead process become `interrupted`, count as one failure, and run again.

## Model failure

Invalid or missing model output gives a minimal brief:

- The frontmatter says `synthesis: minimal`.
- An `unknown` record states the reason.
- Changes list at most three verified commits since the previous brief, merge commits first.
- Other records carry forward unchanged. An `unknown` record says that the follow-up paths are carried forward and unverified.
- The next-session prompt is rebuilt with `basis: carried-forward`. Its first line says that the path was not re-checked.
- No new next step is invented.

## Store failure and conflicts

- Store unavailable: the brief waits in `pending/` with its base revision. `last-good.md` keeps the brief. `tracker sync` writes it when the store is back and its revision still equals the base revision.
- Conflict: the canonical brief changed after the checkpoint (a requester edit). The tool refuses the write and keeps its brief in `pending/` with a conflict flag. Run `tracker checkpoint` and refresh again. The new run starts from the requester's version.
- The tool moves replaced or synced pending briefs to subdirectories of `pending/`. It does not delete them.

## Publication failure

The local `candidate.html` and `last-good.html` stay. `publish-queue.json` records the error. `tracker publish` retries. See [publication.md](publication.md).

## Size limits

| Packet | Limit | How it stays small |
| --- | --- | --- |
| `checkpoint.json` | 8192 bytes | Short text fields, at most 25 changed files, 5 blockers, 6 boundaries, 3 handoff pointers. Handoff notes are pointers, not content. |
| `synthesis-input.md` | 32768 bytes | At most 30 commits, 40 issues, 3 handoff notes of 2000 characters. It shrinks further when needed. |

These limits hold for any session length or repository size.

## Brief budgets

The validator in `tracker.brief` checks the counts and the word budget of the default view: over 400 words is a warning, over 550 words is an error. These are the documented defaults.
