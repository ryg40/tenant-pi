# Pi update checks

`scripts/pi_update.py` detects releases, tests a candidate, and reads release notes. It does not change the kit pin or an installed profile.

Python 3.11+, Node and npm are required. Qualification of a Git checkout also requires `git` on the runner's allow-list PATH. Qualification is Linux-first. Each action prints one JSON object on standard output, including failures.

## Commands

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py detect
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version 1.0.4 --workdir /tmp/pi-qualification
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version 1.0.4 --workdir /tmp/pi-qualification --strict-baseline
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py notes --from 1.0.3 --to 1.0.4 --workdir /tmp/pi-notes
```

| Action | Network use | Result |
| --- | --- | --- |
| `detect` | Public npm registry metadata | `core`, then a `modules` list, and the `new` flag |
| `qualify` | Public npm installs and a loopback test endpoint | `version`, `workdir`, `passed`, and ordered `steps` |
| `notes` | Public npm install of the destination version | `from`, `to`, `breaking`, and ordered `entries` |

| Exit code | Meaning |
| --- | --- |
| 0 | Detection finds no changed pin, qualification passes, or notes succeed. |
| 10 | Detection finds a version different from a pinned version. |
| 1 | A qualification step fails, or the notes install fails. |
| 2 | Invalid arguments, an unsafe directory, unreadable input, or an unavailable registry or changelog. |

Errors use static codes, such as `exact_version: pi-update.version` or `notes_range: pi-update.notes`. They do not echo invalid inputs.

## Detect

Detection reads `config/manifest.json`. It queries the `latest` metadata of the core npm package first, then the npm modules in component-name order.

Each pair has `component`, `package`, `spec`, `pinned`, `latest`, and `different`. An unpinned module has `pinned: null` and `different: null`. It cannot trigger exit 10 because there is no stored version to compare.

`new` means that a pinned version differs. It is not a semantic version ordering check. A registry rollback can also set it.

The Python function `detect(latest=...)` accepts an injected registry reader. Unit tests use that reader and make no registry request.

## Qualify

The work directory must have an existing parent. The script creates a private `pi-update-*` run directory inside it. Each run keeps its logs and outputs.

The script refuses work directories inside the kit clone or the live `~/.pi/agent` directory. It also refuses their ancestors and symbolic-link paths.

Each step has `name`, `exitCode`, and an absolute `log` path. A skipped dependent step has exit code 125. A timeout has exit code 124. An unavailable process has exit code 127.

1. Record a metadata baseline of `~/.pi/agent`, when it exists. No file content is read.
2. Copy tracked kit files into the run's `kit` directory and move its pin to the requested version.
3. Install the requested version under the run's `prefix` directory with `npm install --ignore-scripts`.
4. Run `check-runtime --pi` and the five repository checks from the candidate copy.
5. Copy `packages/tenantext` and `packages/promptr` into the run directory.
6. Run `npm ci --ignore-scripts` in each copy.
7. Link each copy's Pi dependencies to the candidate installation. The links cover `pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core`.
8. Run Tenantext's type check and tests. Run Promptr's build and tests.
9. Generate a core-only profile from the candidate copy in the run directory.
10. Launch that profile once in print mode against the built-in loopback endpoint.
11. Compare the live directory with its baseline, also after a failed step.

A failed step fails qualification. Independent later steps still run. Each package log includes its native test output.

The candidate copy changes `runtime.piVersion` and the core spec in `config/manifest.json`, plus the core anchor in `scripts/validate.py`. These match the pin edits of the update request adapter. The checkout stays unchanged.

With `.git` present, the copy takes the working-tree bytes of tracked files, including uncommitted edits. Without `.git`, it copies every file, except entries under `.git`, `.local`, `node_modules`, or `__pycache__`. Those directories are excluded in both cases. This includes untracked files such as `.env` in a tree without Git metadata. Symbolic-link sources are refused. The copy has no Git metadata.

A missing `git`, a Git timeout, or a nonzero Git exit fails the `candidate-copy` step. Its log records `git_unavailable`, `git_timeout`, or `git_failed`, without raw Git output. Qualification still prints one JSON object and records the final baseline comparison.

`check-runtime` compares against the candidate pin. Pin-dependent test fixtures can still fail the candidate's unit-test step. The report preserves that failure and its log. It does not edit tests to force a pass. See [the runtime check](check-runtime.md).

The print test selects `local-test/sum-model` explicitly. Its server binds only to `127.0.0.1` on an unused port. It returns a fixed reply, not a real model response. Success requires one request and exactly `43` plus a newline in the combined output log.

The print command disables tools, extensions, skills, prompt templates, themes and context-file discovery. It also disables project approval. This checks core-only print mode, not optional modules. See [the launcher](launcher.md).

## Isolation

Every Pi process starts through `env -i`. Only these variables reach it:

- `PATH`, with the Node/npm executable directories and system command directories.
- `HOME` and `TMPDIR`, both inside the run directory.
- `LANG=C.UTF-8` and `PI_CODING_AGENT_DIR`, inside the run directory.
- `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`.

The version probe uses a new empty agent directory. The print launch uses the generated profile. No caller provider key, session-directory override, Node option or proxy setting reaches either process.

npm receives empty user and global configuration files and a cache inside the run directory. Install lifecycle scripts do not run. Package test scripts run only in copied package directories. Python child processes have bytecode writing disabled.

The baseline compares names, kinds, sizes and modification times, including nested metadata digests. It does not prove content equality or identify the process responsible for a change.

The result has `isolation: unchanged` or `isolation: changed_unattributed`, with `changedEntries` naming changed top-level entries. A directory timestamp change alone can produce an empty list. Both baseline records remain in the logs.

By default, baseline drift does not change `passed`. Use `--strict-baseline` when live-profile writes are quiescent; a change then fails qualification. An unreadable baseline remains a failure. An unavailable final comparison reports `isolation: unavailable`.

The baseline path comes from the caller's `HOME`. A CI adapter that supplies a temporary `HOME` checks that temporary directory, not another live profile.

Warning: This is process configuration, not an operating-system sandbox. Run only trusted package versions and trusted kit tests.

Not verified: that arbitrary future package code cannot write outside these directories. The runner controls paths and credentials but does not enforce a filesystem or network sandbox.

## Notes

Notes install the destination package with lifecycle scripts disabled, then read its `CHANGELOG.md`. They do not launch Pi.

The range excludes `--from` and includes `--to`. Both version headings must exist in the changelog. Reversed ranges fail. Equal versions return an empty list.

Each entry has `version` and `text`. All `Breaking Changes` sections come first, newest release first. Remaining sections follow in release order. `breaking` is true when at least one such section exists. The flag depends on the upstream heading, not automated compatibility analysis.

## Evidence and limits

`tests/test_pi_update.py` uses fake npm and Pi programs. It checks changed and unchanged pins, qualification with a different pin, failed steps, dependency links, baseline policy, notes ordering, argument errors and timeouts. Malformed endpoint requests get HTTP 400 without a traceback.

The fake Pi records its complete child environment. The test checks the exact allow list and proves that caller credential canaries do not reach it. The fake print launch calls the real loopback helper.

Not verified: macOS, Windows, interactive sessions, optional module loading, or native-provider authentication. A passing candidate does not approve a pin change or a release.
