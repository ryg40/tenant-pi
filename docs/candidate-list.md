# Candidate list

Status: offline implementation, read-only. `scripts/candidate_list.py` is a pure module. The `list` action of `scripts/tenant_pi.py` reads at most one file per child directory and writes nothing. It starts no process and opens no network connection.

## Question

Which candidate is current, and which kit commit produced each one? The `list` action gives the facts for that decision. It does not make the decision: it writes no "current" marker, and it deletes or prunes nothing.

```sh
python3 scripts/tenant_pi.py list --parent '/owned/parent'
```

## What `list` reads

`--parent` is one absolute path that the user names explicitly. It has the same form as every other path of the kit: no `.` or `..` segment, no trailing `/`, no shell or template characters. A relative path fails with `absolute_path: list.parent`. An absent parent fails with `parent_missing: list.parent`. A parent that is a file, or that has a symlink in any path component, fails with `read_or_json: list.parent`.

The action lists the direct entries of the parent through a directory descriptor. It does not follow a symlink. For each child directory it reads only `<child>/.tenant-pi/state.json`, through the bounded no-follow loader of the other actions: a regular file, 1 MiB maximum, 64 nesting levels maximum, unique JSON keys, no symlink in any path component. `settings.json`, `choices.json`, `auth.json`, `models.json`, sessions, memory stores and every other file stay unread. The tests prove this with an audit hook that records every file open, directory listing and process start, while private canary files sit in the children.

## Output

The output is one deterministic JSON object, with sorted keys and fixed separators. Two runs on an unchanged tree give identical bytes.

- `parent`: the given path.
- `children`: one row per child, sorted by the child name.
- `summary`: the count of each status, plus `children` (rows shown), `omitted` (rows over the bound) and `notDirectory` (regular files and other entries that are not a child).
- `diagnostics`: sorted static `rule: field` lines. Empty when nothing went wrong.
- `scope`: a fixed statement of what the action reads.

Each row has `name` and `status`:

| `status` | Meaning | Other keys |
| --- | --- | --- |
| `candidate` | The child has a schema-1 `state.json`. | `kitSchemaVersion`, `piVersion`, `filesComplete`, `generatedAt`, `kitCommit`, `unsupported` |
| `unmanaged` | The child has no `.tenant-pi/state.json`, or no `.tenant-pi` directory. An unmanaged Pi profile is listed this way. | none |
| `symlink` | The child is a symlink. The action does not enter it, also when it points to a candidate. | none |
| `invalid` | `state.json` failed the loader or the schema check. | `reason`: a static rule code |
| `unsupported_name` | The child name is outside the safe form. The action does not enter the child. | `name` is `null` |

### Candidate fields

| Field | Source in `state.json` | Public form; otherwise `null` and listed in `unsupported` |
| --- | --- | --- |
| `kitSchemaVersion` | `provenance.kitSchemaVersion` | Small integer |
| `piVersion` | `provenance.piVersion` | Plain `X.Y.Z`; a prerelease tag is not echoed |
| `filesComplete` | `status` | `true` for `complete`, `false` for `incomplete` |
| `generatedAt` | `provenance.generatedAt` | `YYYY-MM-DDTHH:MM:SSZ`, a real calendar instant |
| `kitCommit` | `provenance.kitCommit` | 40 lowercase hex characters, or `unknown` |

A field that is absent is `null` and is not listed in `unsupported`. A `state.json` without `generatedAt` and `kitCommit` shows `null` for both. A `provenance` value that is not an object adds `provenance` to `unsupported`.

### Reasons of an `invalid` row

`reason` is the rule part of the loader diagnostic, for example `invalid_json`, `input_encoding`, `input_not_regular`, `input_too_large` or `duplicate_key`, or one of two schema codes: `unsupported_schema_version` (a `schemaVersion` other than the integer `1`) and `unsupported_shape` (the file is not a JSON object). `docs/generator.md` ("Input file errors") lists the loader rules. A `.tenant-pi` that is a file or a symlink gives `input_path_unsafe`. A `state.json` that is a symlink or a directory gives `input_not_regular`. The row never carries a value or a path from the file, and it has no `line` or `column` of a syntax error. A rule that is not lower-case letters and `_` (40 characters maximum) shows as `read_or_json`; no loader rule has another form.

### Child names

A child name is echoed and entered only in the target segment form of the kit: letters, digits, `_`, `.`, space, `'`, `"` and `-`, at most 255 characters, no leading or trailing space, not `.` or `..`. This is the same form that `generate --target` accepts for a path segment. Every other name, for example one with `$`, a backtick, a control character or a non-ASCII character, gives a row with `name: null` and status `unsupported_name`. These rows sort after the named rows.

## Bounds

- The action lists at most 4096 direct entries of the parent (`MAX_ENTRIES`, the bound of `inventory`). More entries fail with `input_too_large: list.parent`; no partial report is printed.
- The report shows at most 1000 children (`MAX_CHILDREN`), the first 1000 in name order. The rest count in `summary.omitted`, and `diagnostics` contains `child_limit: list.parent`.
- A failure to close the parent descriptor adds `cleanup_failed: list.parent` to `diagnostics`. The report is still printed.

## Provenance fields that `generate` writes

`generate` adds two fields to the provenance record of `.tenant-pi/state.json`:

- `generatedAt`: the UTC time of the generation, in the form `YYYY-MM-DDTHH:MM:SSZ`. The writer calls its clock once, so the `incomplete` and the `complete` state carry the same value. The clock is one injectable parameter of `write()` and `main()`; its default is `datetime.now(timezone.utc)`. A clock that fails or that returns a time without a zone stops the generation with `clock: state.generatedAt` before the first write.
- `kitCommit`: the commit of the kit clone, or `unknown`.

`git -C <clone> rev-parse HEAD` prints the value of `kitCommit`. The kit reads the same value from the Git metadata files instead, because the generator starts no process. The steps are:

1. Read `<kit>/.git` as a file. A worktree or a separate Git directory has a `.git` file with the line `gitdir: <path>`. The kit follows that line once. A relative path resolves against the kit clone. When `.git` is a directory, it is the Git directory.
2. Read `<gitdir>/commondir` when it exists. A worktree keeps its branch refs in the common directory. The kit follows that line once.
3. Read `<gitdir>/HEAD`. A detached `HEAD` holds the commit. `ref: refs/...` names a ref.
4. Read the loose ref file in the common directory. When it is absent, look up the ref in `packed-refs`.

Every read uses the bounded no-follow loader. `.git`, `commondir`, `HEAD` and a loose ref file have a 1 KiB bound; `packed-refs` has the 1 MiB bound. A ref name must match `refs/<segment>[/<segment>...]` with letters, digits, `.`, `_` and `-`, no `..`, no leading `.` in a segment, and no `.lock` end. A branch name outside this closed grammar, for example `release+1`, `a@b` or `fix#1`, records `unknown`, although Git accepts it. A loose ref that is itself a symbolic ref is not followed. A loose ref file that exists but does not parse, or that fails the loader, records `unknown`; the kit does not fall back to `packed-refs` then. The result must be 40 lowercase hex characters. Every other case records `unknown`: no `.git`, a symlink in the path, a malformed or oversized file, a SHA-256 repository, or an absent ref.

The test `tests/test_kit_commit.py` compares the value with `git rev-parse HEAD` of the clone that runs the tests; the test itself runs Git, the kit does not. Not verified: shallow clones, a `HEAD` that names a ref in a `refs/worktree/` namespace, and Git reference backends other than files, such as `reftable`. In those cases the kit records `unknown` or the value of the files, which can differ from `git rev-parse HEAD`.

`compare` lists both fields under `markers`, never under `changes`; see `docs/candidate-compare.md`.

## Limits

- `list` shows recorded facts. It does not check that the files of a candidate are still the files that `generate` wrote; use `compare` for that.
- `kitCommit` names the commit of the kit clone at generation time. Not verified: that the working tree of the clone was clean at that time. Uncommitted kit changes are not visible in the record.
- The bounds are per file (1 MiB for each `state.json`) and per child count (1000 rows, 4096 entries). There is no bound on the total bytes that one run parses: at most 1000 files of 1 MiB each. This costs only CPU time and memory for one file at a time.
- `generatedAt` comes from the host clock. Not verified: that the host clock was correct.
- A candidate directory is not an OS sandbox, and a `complete` state means only that files were published; see `docs/candidate-compare.md`.

## Test coverage

`tests/test_candidate_list.py` covers a tree with two candidates, one unmanaged directory, a symlinked child that is reported as `symlink` and not entered, a regular file, private canary files that stay unopened, invalid state files, unsupported names, the entry and child bounds, a cleanup failure, an older state without the new fields, hostile field values, and two CLI runs with identical bytes in a process that blocks every subprocess and socket. `tests/test_kit_commit.py` covers the metadata parsers, a clone, a worktree, packed refs, symlinks and malformed files. `tests/test_profile_write.py` and `tests/test_cli.py` cover the two new fields in `state.json`.
