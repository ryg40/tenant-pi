# Pi update checks

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.
Replace `<new version>` with the detected version before running an example command.

`scripts/pi_update.py` detects releases, tests a candidate, and reads release notes. It does not change the kit pin or an installed profile.

Python 3.11+, Node and npm are required. Qualification of a Git checkout also requires `git` on the runner's allow-list PATH. Qualification is Linux-first. Each action prints one JSON object on standard output, including failures.

## Commands

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py detect
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version "<new version>" --workdir /tmp/pi-qualification
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version "<new version>" --workdir /tmp/pi-qualification --strict-baseline
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py notes --from "<pin>" --to "<new version>" --workdir /tmp/pi-notes
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

Each pair has `component`, `package`, `spec`, `pinned`, `latest`, and `different`. An unpinned module has `pinned: null` and `different: null`. It cannot trigger exit 10 because there is no stored version to compare. The `questions` module has an exact version: another registry version of it sets `different: true` and exit 10, and the core pin does not move for it.

`new` means that a pinned version differs. It is not a semantic version ordering check. A registry rollback can also set it.

The Python function `detect(latest=...)` accepts an injected registry reader. Unit tests use that reader and make no registry request.

## Qualify

The work directory must have an existing parent. The script creates a private `pi-update-*` run directory inside it. Each run keeps its logs and outputs.

The script refuses work directories inside the kit clone or the live `~/.pi/agent` directory. It also refuses their ancestors and symbolic-link paths.

Each step has `name`, `exitCode`, and an absolute `log` path. A skipped dependent step has exit code 125. A timeout has exit code 124. An unavailable process has exit code 127.

1. Record a metadata baseline of `~/.pi/agent`, when it exists. No file content is read.
2. Copy tracked kit files into the run's `kit` directory and move its pin to the requested version.
3. Install the requested version under the run's `prefix` directory with `npm install --ignore-scripts`.
4. Run `check-runtime --pi`, the full check set through `scripts/check.py`, then `PACKAGE_PY` from the candidate copy.
5. Copy `packages/tenantext`, `packages/promptr`, and `packages/openviking-pi` into the run directory.
6. Run `npm ci --ignore-scripts` in each copy.
7. Link each copy's Pi dependencies to the candidate installation. The links cover `pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core`.
8. Run Tenantext's type check and tests. Run Promptr's build and tests. The Tenantext test file `test/pi-package-install.test.ts` checks three rules of the candidate Pi that the setup lines of the plan depend on. `update()` installs no missing npm source with an exact version. `update()` installs a missing npm source without a version. An install of a declared source by its identical string runs one install and leaves the bytes of `settings.json` equal. A failure of that file means that the setup lines of `scripts/profile_plan.py` need a review.
9. Run every OpenViking package test, including loopback MCP fixtures and SDK lifecycle checks, with candidate Pi dependencies.
10. Check OpenViking's explicit file source with the candidate package resolver and extension factory loader, without starting a session.
11. Generate a core-only profile from the candidate copy in the run directory.
12. Launch that profile in print mode against the built-in loopback endpoint for the successful reply contract.
13. For candidate versions 1.2.0 and later, run a separate loopback launch for the output-limit truncation contract.
14. Compare the live directory with its baseline, also after a failed step.

Qualification does not rebuild or check page currency. The publisher checks both public pages before a snapshot.
Generate the local edition separately with `python3 scripts/architecture_build.py --local` after preparing its untracked values file.

A failed step fails qualification. Independent later steps still run. Each package log includes its native test output.

The `check-set` step runs unit shards and both publish checks without Git metadata; it skips the diff check and writes no stamp.
The `PACKAGE_PY` step runs four package Python suites in order:

- Tracker: `python3 -m unittest discover -s tracker/tests -t .` from `packages/tenantext`.
- Herdr: `python3 -m unittest discover -s skills/herdr/tests` from `packages/tenantext`.
- Herdr relay: `python3 -m unittest discover -s skills/herdr-relay/tests` from `packages/tenantext`.
- Watch: `python3 scripts/test_watch.py` from `packages/promptr/skills/watch-herdr-agents`.

All four run even when one fails. The log ends with `PACKAGE_PY: passed` or `PACKAGE_PY: FAILED`.

OpenViking steps use the names `openviking-install`, `openviking-links`, `openviking-test-inventory`, `openviking-test`, and `openviking-load`.
The inventory records every `tests/*.test.mjs` file. No test file is excluded.
A missing test helper or a failing lifecycle contract fails qualification; the runner does not download external test helpers.
The SDK lifecycle checks require Pi 1.2.0's user/custom event discriminator and busy-startup queue behavior.
Older candidates still run every package test and can fail these newer contracts.
The separate print check preserves its pre-1.2.0 successful-print contract; that does not promise full older-candidate qualification.

The offline suite receives explicit `PI_SESSION_MANAGER` and `PI_PI_AI_TRANSCRIPT` paths from the candidate installation.
Missing candidate helpers fail the step; the tests cannot fall back to a host-global Pi.
The links log records the resolved package versions, which can differ from the candidate version when its dependencies use version ranges.
The resolver and loader also import candidate files by absolute path.
They use a private settings file with the same explicit `index.ts` source form as the existing repository resolver regression.
The former directory-source form is a negative control: it must resolve no extension.
The factory must load without errors and register `/viking` and `before_agent_start`.
The probe blocks fetch and socket connections and requires zero attempted connections.
It never dispatches session or model events, so this check does not prove lifecycle behavior.

The candidate copy changes `runtime.piVersion`, `runtime.piAcceptedRange` and the core spec in `config/manifest.json`, plus the core anchor in `scripts/validate.py`. A changed stable pin sets the lower bound to that version and the upper bound to the next minor line. See [the pin move rule](guides/release-checklist.md#gates). The manual pin move guide uses the same `pin_contents` function. The checkout stays unchanged.

With `.git` present, the copy takes the working-tree bytes of tracked files, including uncommitted edits. Without `.git`, it copies every file, except entries under `.git`, `.local`, `node_modules`, or `__pycache__`. Those directories are excluded in both cases. This includes untracked files such as `.env` in a tree without Git metadata. Symbolic-link sources are refused. The copy has no Git metadata.

A missing `git`, a Git timeout, or a nonzero Git exit fails the `candidate-copy` step. Its log records `git_unavailable`, `git_timeout`, or `git_failed`, without raw Git output. Qualification still prints one JSON object and records the final baseline comparison.

`check-runtime` compares against the candidate pin. Current-pin test fixtures read the manifest of the candidate copy. A failed check still fails qualification; the report keeps its log. It does not edit tests to force a pass. See [the runtime check](check-runtime.md).

The wizard plan fixture `tests/fixtures/wizard_plan_tenant_pi.json` holds the current pin; the qualifier does not regenerate it.
Move the pins and regenerate the fixture from `tenant_pi_plan_text()` before the first qualification.
Review its diff, then qualify once from that worktree.
An old fixture fails `test_tenant_pi_plan_is_unchanged` in `check-set`.
The steps are in [the pin move guide](guides/pin-move-release.md#move-pins-and-measured-facts), step 4.

The print tests select `local-test/sum-model` explicitly. Each server binds only to `127.0.0.1` on an unused port.
They return fixed replies, not real model responses. Each launch has a 90-second timeout; request-body reads have a five-second timeout.
The successful reply requires one request and exactly `43` plus a newline in the combined `print-mode.log`.

The 1.2.0-and-later test sends `finish_reason: length` and reports usage equal to the model's configured output limit.
This tests output-limit truncation, not a below-limit response that Pi can treat as context recovery.
`print-length.log` must contain exactly `partial reply` plus a newline on stdout.
`print-length.stderr.log` must contain exactly `Response was truncated: the model reached its output token limit.` plus a newline.
No warning can appear on stdout.
The process must exit 1 and make exactly one request. The qualifier never retries this launch.
An exit 0, missing partial text, missing warning, or extra request fails qualification.

The `print-length` step records the actual `processExitCode`, the `expectedExitCode: 1`, and the separate `stderrLog` path.
Its qualification `exitCode` is 0 only when the process matches that expected exit.
`print-length-response` checks both streams and the request count.
Candidates before 1.2.0 retain the successful-print test and record `contract: not_applicable_before_1.2.0` for truncation.
The contract follows Pi 1.2.0's packaged `CHANGELOG.md`, `docs/cli-integration.md`, and `dist/modes/print-mode.js`.

The print command disables tools, extensions, skills, prompt templates, themes and context-file discovery. It also disables project approval. This checks core-only print mode, not optional modules. See [the launcher](launcher.md).

## Isolation

Every Pi process starts through `env -i`. Only these variables reach it:

- `PATH`, with the Node/npm executable directories and system command directories.
- `HOME` and `TMPDIR`, both inside the run directory.
- `LANG=C.UTF-8` and `PI_CODING_AGENT_DIR`, inside the run directory.
- `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`.

The version probe uses a new empty agent directory. The print launch uses the generated profile. No caller provider key, session-directory override, Node option or proxy setting reaches any Pi launch or the factory-load probe.

npm receives empty user and global configuration files and a cache inside the run directory. Install lifecycle scripts do not run. Package test scripts run only in copied package directories. Python child processes have bytecode writing disabled.

The baseline compares names, kinds, sizes and modification times, including nested metadata digests. It does not prove content equality or identify the process responsible for a change.

The result has `isolation: unchanged` or `isolation: changed_unattributed`, with `changedEntries` naming changed top-level entries. A directory timestamp change alone can produce an empty list. Both baseline records remain in the logs.

By default, baseline drift does not change `passed`. Use `--strict-baseline` when live-profile writes are quiescent; a change then fails qualification. An unreadable baseline remains a failure. An unavailable final comparison reports `isolation: unavailable`.

The baseline path comes from the caller's `HOME`. A temporary `HOME` checks that temporary directory, not another live profile.

Warning: This is process configuration, not an operating-system sandbox. Run only trusted package versions and trusted kit tests.

Not verified: that arbitrary future package code cannot write outside these directories. The runner controls paths and credentials but does not enforce a filesystem or network sandbox.

## Notes

Notes install the destination package with lifecycle scripts disabled, then read its `CHANGELOG.md`. They do not launch Pi.

The range excludes `--from` and includes `--to`. Both version headings must exist in the changelog. Reversed ranges fail. Equal versions return an empty list.

Each entry has `version` and `text`. All `Breaking Changes` sections come first, newest release first. Remaining sections follow in release order. `breaking` is true when at least one such section exists. The flag depends on the upstream heading, not automated compatibility analysis.

## Evidence and limits

`tests/test_pi_update.py` uses fake npm, Node and Pi programs.
It checks changed and unchanged pins, unchanged candidate pages, failed steps, candidate dependency links, baseline policy, notes ordering, argument errors and timeouts.
It checks the OpenViking install, selected test inventory, candidate helper paths, and isolated resolver/load invocation.
Missing candidate helpers cannot silently select host dependencies.
Negative print controls reject false success, missing partial text, missing warnings, warnings on stdout, and a second request.
Older candidates retain their successful-print test. Malformed endpoint requests get HTTP 400 without a traceback.

The fake Pi records its complete child environment. The test checks the exact allow list and proves that caller credential canaries do not reach it. The fake print launch calls the real loopback helper.

Not verified: macOS, Windows, interactive sessions, installed-extension copies, live OpenViking/MCP connections, or native-provider authentication.
The factory-load check does not qualify a generated memory profile against a real server.
Qualification does not prove release gate 6's clean non-root Linux trial.
A passing candidate does not approve a pin change or a release.
