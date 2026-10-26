# Cross-session recall

The `cross-session-recall` extension keeps each interactive input of the user in one SQLite store and brings it back in two ways: the newest distinct inputs seed the Up/Down history of the editor, and `/recall [query]` searches the whole store. The extension makes no model call, no network request, no user message and no session entry.

## The store

| Item | Value |
| --- | --- |
| Directory | `CROSS_SESSION_RECALL_DIR`, else `~/.pi/agent/cross-session-recall` |
| File | `history.sqlite3`, with the `-wal` and `-shm` files of SQLite |
| Modes | directory `0700`, files `0600`: the user reads them, nobody else |
| Scope | one store for all Pi profiles of the user; a kit profile and the base profile share one history |
| Limits | none: no count and no age limit; only `/recall-clear` deletes |

The store is in the home of the user and not in the profile, because the input history is personal, like a shell history. A profile that wants its own history sets `CROSS_SESSION_RECALL_DIR` in its launcher.

The schema: `inputs` keeps every accepted input with its time, working directory and session file. `recall_items` has one row per distinct text with its latest input. `recall_fts` (FTS5, trigram) indexes `recall_items` for the search. Writers in parallel are safe: each write is one `BEGIN IMMEDIATE` transaction with a busy timeout of five seconds, and the schema sets the busy timeout before it turns on WAL, so two sessions that open a new store at the same moment wait for each other.

On the first launch with a store that has the old `history.json`, the extension imports its entries in one transaction, writes a marker in the `metadata` table and renames the file to `history.json.migrated`. The marker keeps the import one-time, also when the rename fails. A `history.json` that appears after the marker stays untouched.

The schema sets `PRAGMA secure_delete = ON`: SQLite overwrites deleted content with zeros, so after `/recall-clear` the file and its WAL hold no text of the deleted inputs.

## One copy per process

A user copy of this extension in the agent directory (`<agent dir>/extensions/cross-session-recall.ts` or `<agent dir>/extensions/cross-session-recall/index.ts`) is the same extension on the same store. When Pi loads both, the commands become `recall:1` and `recall:2`, each input gets two rows and the second copy drops the editor layer of the first. So the kit copy checks the agent directory at load time and stands down when the user copy exists: no store, no commands, no editor factory. The user copy keeps `/recall`. When the user copy is removed, the kit copy takes over at the next start.

## Profiles with an extension list

A profile that lists the extensions of `packages/tenantext` in an `extensions` list loads only what the list names. Such a profile needs `extensions/cross-session-recall/index.ts` in the list, or the extension stays off after an upgrade. The installer keeps an existing list unchanged.

## What is stored

An input is stored when the Pi `input` event has the source `interactive`, after a normalization of line endings and surrounding space. Not stored: an empty text, a delegated-subagent envelope, a handoff block (`FINAL_COMPRESSED_CONTEXT` with `SUBAGENT_COMPLETE`), the built-in commands of Pi and the commands of extensions (Pi handles them before the event), and inputs of the print, JSON and RPC modes. Pi sends those with the source `interactive` too, so the `input` handler also checks the mode; in those modes the extension opens no store and stores nothing.

Warning: a pasted credential is stored in clear text. The file modes keep it to the user, and `/recall-clear` removes it with everything else, also from the free pages of the file (`secure_delete`). The extension has no redaction.

## The commands

| Command | Result |
| --- | --- |
| `/recall` | A list of the 200 newest distinct inputs. The chosen one goes into the editor; nothing is sent. |
| `/recall <query>` | The same list, limited to the inputs that contain the query. The argument completion offers 20 matches. |
| `/recall-clear` | After a yes in the confirm dialog, deletes every stored input and empties the live Up/Down history. Without the yes, nothing changes. |

## The editor

At `session_start` in the interactive terminal mode the extension puts its editor factory on the current one, or on the Pi `CustomEditor` when no extension set one. Each time the factory runs, it builds the editor from the factory below and adds the 100 newest distinct inputs of the store to the native history, oldest first. The native history drops a consecutive duplicate and caps itself at 100.

The factory reads the store each time it runs, not once at the start. Pi builds a new editor each time an extension sets a factory, and the in-memory history of the old editor is gone then. With the fresh read, an editor that another extension builds later has the inputs of this session too.

The extension never wraps its own factory: a `session_start` that finds the own factory on top uses its base. Pi removes extension editors on `/reload` and on a session change, and the next `session_start` puts the factory back.

With `next-prompt` in the same profile the chain after the first settled run is `next-prompt`, then `cross-session-recall`, then `CustomEditor`, in either load order: `next-prompt` wraps at `agent_settled`, this extension at `session_start`. Up/Down comes from the seed, the faint draft from the top layer. The package test `test/cross-session-recall.test.ts` runs both orders on a fake editor.

The status line shows `<n> recalled` after the start: the count of the seeded inputs.

## If the store does not open

The extension opens the store once per process, at `session_start` in the interactive terminal mode. When the open fails (an unwritable directory, a corrupt file), it shows one warning and stays inert: the editor of Pi works as before, `/recall` and `/recall-clear` answer `Cross-session recall is off`, and no input is stored. An input that arrives after `session_shutdown` closed the store is dropped; nothing reopens the store. A failed import of `history.json` gives a warning, and the store stays open.

A Node without `node:sqlite` is a different case: the import of the module fails, so the Pi loader reports `Failed to load extension: No such built-in module: node:sqlite` in its load errors and the extension has no commands and no handlers. The editor of Pi works as before.

Pi-Bolt 1.0.3 (Pi 1.4.0 as one native executable) ships Node 26 with SQLite 3.53; a manual load proved `node:sqlite`, WAL and the FTS5 trigram tokenizer there. The kit pins Node 24 for the `pi` runtime, which has `node:sqlite` too.

## Limits

- The search is a substring search: a query of one or two characters uses `instr`, a longer one the trigram index and then `instr`.
- An input of a session that ended with a crash before the write is not stored.
- Not verified: the extension in the interactive terminal of Pi with the kit pin; the package test uses a fake editor.
