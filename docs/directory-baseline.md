# Directory baseline

Status: offline implementation. The `baseline` and `check-baseline` actions of `scripts/tenant_pi.py` show whether one directory changed between two points in time. The logic is in `scripts/baseline.py`. No install, login, network request or process start exists in it.

## Purpose

The kit never writes into the live agent directory: `~/.pi/agent`, or the directory in `PI_CODING_AGENT_DIR`. Without a record, no step can prove this after a launch: a check such as "Nothing new appeared in `~/.pi/agent`" has nothing to compare with.

- `baseline` records the state of one directory before the first launch.
- `check-baseline` compares the directory with that record after the launch. It gives one of three results: `unchanged`, `changed` or `no_baseline`.

```sh
python3 scripts/tenant_pi.py baseline --dir /home/EXAMPLE_USER/.pi/agent --out /home/EXAMPLE_USER/.config/tenant-pi/live-baseline.json
python3 scripts/tenant_pi.py check-baseline --dir /home/EXAMPLE_USER/.pi/agent --baseline /home/EXAMPLE_USER/.config/tenant-pi/live-baseline.json
```

| Option | Action | Rule |
| --- | --- | --- |
| `--dir <path>` | both | One absolute path that the user names explicitly. It follows the absolute-path rule of the kit. The directory can be absent. |
| `--out <path>` | `baseline` | An absolute path of a file that does not exist. Its parent exists and is owned by the caller. 1024 characters maximum. |
| `--baseline <path>` | `check-baseline` | The absolute path of the file of an earlier `baseline` run. |

`baseline` reads `HOME` to find `~/.pi/agent` and `~/.llm-wiki`, as `init-private` and `--launcher` do. It reads `WIKI_HOME` to find the wiki vault of that root. It reads no other environment value. It does not read `PI_CODING_AGENT_DIR`: the user names that directory with `--dir`. `check-baseline` reads no environment value.

The actions are not specific to the live agent directory. The same two commands work for the directory in `PI_CODING_AGENT_SESSION_DIR`, with another baseline file.

## Why an action and not guide commands

Two forms are possible: commands in the guide, or a kit action.

Stage 0 keeps a shell command for the line `present` or `absent`. The clone does not exist at Stage 0 on a first install, so no kit action can run there.

The baseline and the comparison are a kit action, for these reasons:

- The result is one fixed word. A shell listing needs a second listing, a `diff`, and an agent that reads the `diff`. An agent can read "no output" as "absent".
- The tests prove that no file is opened. A guide command has no test.
- The action is the same on Linux and on macOS. `find -printf` and `stat -c` are GNU forms.
- A baseline is never replaced. A shell redirect replaces the file when the step runs a second time, after the launch. The comparison then says `unchanged` for a directory that did change.
- The output has a bound. A live directory can hold more than 50 000 entries.

## What the actions read

| Path | Operation |
| --- | --- |
| `--dir` and each directory above it | Opened as a directory without following a symbolic link. |
| Each directory below `--dir` | Opened as a directory without following a link, and listed. |
| Each entry at each level | One status call that follows no link: kind, size and modification time. |
| The `--baseline` file | `check-baseline` only. Opened and parsed through the bounded no-follow loader of `compare`: a regular file, 1 MiB maximum, unique JSON keys. |

- No file of the directory is opened. `auth.json`, `models.json`, `settings.json`, each session and each memory store get one status call and stay unopened. The tests prove this with an audit hook: each open of a scan has the directory flag and the no-follow flag.
- A symbolic link is one entry. Its target is not read, resolved or followed. A change behind a link is outside the baseline.
- The actions change no entry, no size and no modification time of the directory. The listing of a directory can change its access time. The baseline does not record access times.
- `baseline` applies its refusals and checks the `--out` path before it lists the directory.
- `check-baseline` checks that the baseline names `--dir` before it lists the directory. Without a baseline file it lists nothing.

## The baseline file

`baseline` creates the `--out` file with mode `0600`. It uses the ancestor walk and the exclusive file creation of the guarded writer (`scripts/profile_write.py`), as the launcher file does. It never replaces a file. For a second baseline, give another file name.

The file is one JSON object on one line, with sorted keys:

```json
{"dir":"/home/EXAMPLE_USER/.pi/agent","entries":[{"kind":"file","mtimeNs":1791215087721505623,"name":"auth.json","size":952},{"digest":"e7dbf35eac9308f5690ed0e4497542608a9db565f81a209cc7958331727672b8","entries":2,"kind":"dir","mtimeNs":1791215087721505623,"name":"sessions","size":2048}],"mtimeNs":1791215087721505623,"present":true,"recordedAt":"2030-01-01T12:00:00Z","schemaVersion":1}
```

| Key | Content |
| --- | --- |
| `schemaVersion` | `1`. |
| `dir` | The given path. |
| `recordedAt` | The UTC time of the record. |
| `present` | `false` when the directory does not exist. Then `mtimeNs` is `null` and `entries` is empty. |
| `mtimeNs` | The modification time of the directory itself, in nanoseconds. |
| `entries` | One row for each direct entry of the directory, sorted by name. |

A row has these keys:

| Key | Content |
| --- | --- |
| `name` | The entry name, as the file system returns it. |
| `kind` | `file`, `dir`, `symlink` or `other` (for example a FIFO or a socket). |
| `size` | For a file: its size in bytes. For a link: the length of the link text. For a directory: the sum of the sizes of the entries below it that are not directories. |
| `mtimeNs` | The modification time of the entry, in nanoseconds. |
| `entries` | A directory only. The count of the entries below it, at all levels. |
| `digest` | A directory only. The SHA-256 of one line for each entry below it: path, kind, size and modification time. The lines are in sorted order, depth first. |

The file holds no file content and no credential value. It holds the names of the direct entries. Below the first level it holds a count, a size and a digest, not the names. There are two reasons:

- A digest keeps the baseline compact even when a live directory has many entries.
- A name below the first level can show a working directory of the user, for example the name of a session directory.

A change at any level still changes the row of its direct entry, because the digest covers every level.

Treat the file as private, like the overlay. A digest does not hide a name that a reader can guess.

## Output

Each action prints one JSON object on standard output, with sorted keys and fixed separators.

`baseline`:

```json
{"baseline":{"complete":true,"fileCreated":true,"mode":"0600","path":"/home/EXAMPLE_USER/.config/tenant-pi/live-baseline.json","warnings":[]},"dir":"/home/EXAMPLE_USER/.pi/agent","present":true,"recordedAt":"2030-01-01T12:00:00Z","summary":{"below":2,"entries":2}}
```

`summary.entries` is the count of the direct entries. `summary.below` is the count of the entries below them. The output holds no entry name.

`check-baseline`:

```json
{"added":["models-store.json"],"dir":"/home/EXAMPLE_USER/.pi/agent","directoryModified":true,"modified":["sessions"],"now":"present","recordedAt":"2030-01-01T12:00:00Z","removed":[],"result":"changed","scope":"Compares the name, kind, size and modification time of each entry at all levels, and names the direct entries only. Opens no file. Covers the time after recordedAt only.","was":"present"}
```

| Key | Content |
| --- | --- |
| `result` | `unchanged`, `changed` or `no_baseline`. |
| `dir` | The given path. |
| `recordedAt` | The time of the baseline. `null` with `no_baseline`. |
| `was`, `now` | `present` or `absent`: the directory at the baseline and now. `null` with `no_baseline`. |
| `added` | The names of the direct entries that are new. |
| `removed` | The names of the direct entries that are gone. |
| `modified` | The names of the direct entries whose kind, size or modification time differs, or that have a difference at a level below them. |
| `directoryModified` | `true` when the modification time of the directory itself differs. An entry was made, removed or renamed in the directory. |
| `scope` | A fixed sentence that says what the comparison covers. |

| Exit code | Meaning |
| --- | --- |
| 0 | `baseline`: the file is written. `check-baseline`: the result is `unchanged`. |
| 1 | `check-baseline` only: the result is `changed` or `no_baseline`. The JSON object is on standard output. |
| 2 | A refusal. Standard error has `{"candidate_created": <bool>, "error": "<rule>: <field>"}`. For `baseline`, `candidate_created` is `true` when a file stays at the `--out` path. |

## How to read the result

| `result` | Meaning | Stage 9 check 4 |
| --- | --- | --- |
| `unchanged` | No entry was added, removed or modified after `recordedAt`. A directory that was absent is still absent (`was` and `now` are `absent`). | passed |
| `changed` | The directory differs from the baseline. The three name lists and `directoryModified` say where. | failed, or not verified: see the next section |
| `no_baseline` | The baseline file does not exist. The action compared nothing. | not run |

Record check 4 as passed only when `recordedAt` is before the first Pi command that names the target. A baseline from a later time gives `unchanged` and proves nothing about the launch: the check is then not run. Nothing in the output ties `recordedAt` to the launch, so the reader compares the two times.

`changed` with three empty name lists and `"directoryModified":true` means that an entry was made and removed again, for example a lock file. No entry differs now.

### A Pi in the live profile

The comparison shows what changed. It does not show which process changed it.

A Pi that the user runs in the live profile during the install also changes the live agent directory:

- A session writes a file under `sessions`.
- Pi can write `auth.json`, `settings.json`, `models-store.json` and the state files of the extensions.
- A bare `pi --version` changes only the modification time of the directory. Observed with Pi 1.0.2: with a `settings.json` in the agent directory, `pi --version` gave `changed` with empty name lists and `"directoryModified":true`. With an empty agent directory it changed nothing.

So read `changed` in this way:

1. Find out whether a Pi ran in the live profile after `recordedAt`: ask the user, and read the commands of the installing agent. A `pi` command without `PI_CODING_AGENT_DIR` counts as a Pi in the live profile, also `pi --version`, and also when the installing agent ran it.
2. If no Pi ran there: the check failed. A command of the install wrote outside the target. Stop and report the names.
3. If a Pi ran there: the check is not verified. Record the names, the answer of the user and the command of the agent. Do not record the check as passed.
4. To get a proof, the user closes each Pi of the live profile. Record a second baseline in a new file. Launch the generated profile again and send one prompt. Then compare with the second baseline.

## Refusals

Each refusal is a static `rule: field` text. It contains no path and no value. Each refusal of this table fires before any write. The refusals of the `--out` path and of `HOME` fire before the directory is listed.

| Diagnostic | Cause |
| --- | --- |
| `absolute_path: baseline.dir`, `absolute_path: check-baseline.dir` | `--dir` is relative or has a segment that the path rule refuses. |
| `not_directory: baseline.dir`, `not_directory: check-baseline.dir` | `--dir` or a directory above it is a symbolic link or is not a directory. Give the real path of the directory to both actions, for example from `realpath "$HOME/.pi/agent"`. The baseline names that path, so `check-baseline` needs the same `--dir`. |
| `unreadable: baseline.dir`, `unreadable: check-baseline.dir` | The caller cannot open or list the directory or a directory below it. This refusal comes during the listing. |
| `input_too_large: baseline.dir` | A bound is exceeded: 4096 direct entries, 1 000 000 entries at all levels, 64 directory levels, or a baseline of more than 1 MiB. This refusal comes during the listing. |
| `absolute_path: baseline.out`, `text: baseline.out`, `shell_or_template: baseline.out` | `--out` is not an absolute POSIX path of the kit form. |
| `path_too_long: baseline.out` | `--out` has more than 1024 characters. |
| `under_dir: baseline.out` | `--out` is `--dir` or is under it. A baseline never goes into the directory that it records. |
| `under_pi_agent: baseline.out` | `--out` is `~/.pi/agent` or is under it. |
| `under_wiki_vault: baseline.out` | `--out` is `~/.llm-wiki` or is under it. With `WIKI_HOME` set, also `<WIKI_HOME>/.llm-wiki`. The kit writes nothing below a personal wiki vault; `--dir` can name the vault. |
| `under_kit: baseline.out` | `--out` is the kit clone or is under it. This includes `.local/` of the clone. |
| `target_exists: baseline.out` | The `--out` path exists: a file, a directory, a link, a dangling link or another entry. The entry is not changed. |
| `parent_missing: baseline.out.parent` | The parent of `--out`, or a directory above it, does not exist. |
| `unsafe_parent_owner: baseline.out.parent`, `unsafe_owner: baseline.out.parents`, `unsafe_permissions: baseline.out.parents`, `unsafe_path: baseline.out.parents` | The ancestor rules of the guarded writer; see [the launcher file](launcher.md#refusals). |
| `home_required: baseline.home`, `absolute_path: baseline.home` | `HOME` is not set or is not an absolute path. |
| `absolute_path: check-baseline.baseline` | `--baseline` is relative or has a segment that the path rule refuses. |
| `baseline_record: check-baseline.baseline` | The baseline file is JSON of another shape. A baseline that someone edited by hand can give this. |
| `baseline_dir: check-baseline.dir` | The baseline names another directory than `--dir`. |
| A rule of the bounded loader with the field `check-baseline.baseline` | The baseline file is a link, is not a regular file, is larger than 1 MiB or is not JSON. |

After a complete listing, a failed write gives `file_privacy`, `short_write`, `write_failed` or `target_unavailable` with the field `baseline.out`. The kit has no rollback: when `candidate_created` is `true`, inspect the file and remove it yourself.

## Limits

- The baseline covers the time after `recordedAt` only. The private directory exists from Stage 5 of `INSTALL.md`, so the commands of Stage 0 to Stage 4 run before the first baseline.
- The comparison does not say which process made a change.
- The comparison uses the kind, the size and the modification time. It does not detect a change that keeps all three: a change of mode or owner, or new content of the same size with a restored modification time. A file system with coarse times can hide a second write in the same time unit.
- The comparison names the direct entries only. It does not name an entry at a lower level.
- An entry that goes away during the listing is left out. A Pi that runs in the directory during `baseline` can give a baseline that differs from the directory at once.
- One directory that the caller cannot list stops the action with `unreadable`.
- `under_kit` covers only the root of the kit that runs the action, as for `--launcher`.
- `under_pi_agent` knows only `~/.pi/agent`. `baseline` reads no `PI_CODING_AGENT_DIR`, so an `--out` path inside a live agent directory that only this variable names is refused only when that directory is the `--dir`. Keep `--out` in the private directory.
- The write boundary is the Linux-first boundary of the guarded writer; see [the launcher file](launcher.md#limits).

## Test coverage

`tests/test_baseline.py` covers:

- The record of a present and of an absent directory, the refusal of a bad row, and byte-identical output for the same state.
- Each result: `unchanged`; `changed` for a new, a removed and a modified entry, with each name one time; `changed` when only the directory itself was modified; an absent directory that stays absent, appears, or goes away; `no_baseline`.
- The scan on a real directory: the kinds, the sizes and the times; a change of size, of time and of name two levels down changes the row of the direct entry; a change behind a link changes nothing; an entry that goes away is left out; each bound, with no open descriptor after a refusal.
- The audit of a scan: each open has the directory flag and the no-follow flag, no open names a file or a link, each listing uses a descriptor, and no process starts. A canary text in `auth.json` and in a session file is not in the baseline or in the output.
- The file: mode `0600` with umask 0, each existing entry and each unsafe parent refused, static diagnostics for a failed creation, a failed write and a restrictive umask.
- The CLI in a disposable `HOME`: a full tree comparison of the directory before and after the two actions (kinds, sizes, modification times, change times and bytes); exit codes 0, 1 and 2; a second `baseline` on the same file is refused before the listing and leaves the file; each refusal of the `--out` path writes nothing; `no_baseline` lists nothing; a damaged baseline and a baseline of another directory; a directory that becomes a link after the record.

Observed with Pi 1.0.2 on Linux: core-only print-mode launches can leave the live profile unchanged.
This observation does not prove that an interactive launch or a launch with a module leaves it unchanged.

Not verified:

- A run on macOS or on another Unix. The tests ran on Linux only.
- A run in a complete install on a clean client, with an interactive launch and a provider login.
- A file system with coarse modification times.
- `unreadable` with a real directory that the caller may not list. Root can list each directory, so the tests force the refusal with a patch.
- `file_privacy`, `write_failed` and `target_unavailable` through a real file system fault. The tests force them with a patch or a umask.
- That a launch of a profile with `mcp`, `hermes`, `wiki` or an in-tree extension leaves the live directory unchanged. The observation covers core-only print mode only.
