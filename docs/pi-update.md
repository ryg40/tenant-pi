# Pi update checks

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.
Replace `<new version>` with the detected version before running an example command.

`scripts/pi_update.py` detects releases, reads release notes, moves the kit pin and tests a candidate Pi version. Only `pin` changes a file of the checkout: `config/manifest.json`. No action changes an installed profile. `python3 scripts/pi_update.py <action> --help` lists the options of an action.

Python, Node and npm are required. Qualification of a Git checkout also requires `git`. Qualification is Linux-first. Each action prints one JSON object on standard output, including failures.

## Commands

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py detect
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py notes --from "<pin>" --to "<new version>" --workdir /tmp/pi-notes
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py pin --version "<new version>"
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version "<new version>" --workdir /tmp/pi-qualification
```

| Action | Network use |
| --- | --- |
| `detect` | Public npm registry metadata |
| `notes` | Public npm install of the destination version |
| `pin` | None |
| `qualify` | Public npm installs and a loopback test endpoint |

| Exit code | Meaning |
| --- | --- |
| 0 | Detection finds no changed pin, qualification passes, notes succeed, or the pin moves. |
| 10 | Detection finds a version different from a pinned version. |
| 1 | A qualification step fails, or the notes install fails. |
| 2 | Invalid arguments, an unsafe directory, unreadable input, or an unavailable registry or changelog. |

Errors use static codes, such as `exact_version: pi-update.version`. They do not echo invalid inputs.

## Detect

Detection compares the pinned versions of `config/manifest.json` with the `latest` versions of the npm registry: the core package and each npm module.

- Each npm module of the manifest has an exact version: `mcp`, `hermes`, `wiki`, `questions`, `computer-use` and `computer-use-macos`.
- Another registry version of any of them gives exit 10, and the core pin does not move for it. The exit stays 10 until the maintainer of the release reviews the newer version and edits its `source.spec`; see [the module versions](../UPDATE.md#the-module-versions).
- `new` means that a pinned version differs. It is not a semantic version ordering check. A registry rollback can also set it.

## Notes

Notes install the destination package with lifecycle scripts disabled, then read its `CHANGELOG.md`. They do not launch Pi.

The range excludes `--from` and includes `--to`. Both version headings must exist in the changelog. All `Breaking Changes` sections come first, newest release first. `breaking: true` means that at least one such section exists. The flag depends on the upstream heading, not on a compatibility analysis, so `false` does not prove compatibility.

## Pin

`pin` sets `runtime.piVersion`, the core npm spec and `runtime.piAcceptedRange` in `config/manifest.json`. It changes no other file.

Warning: this action replaces `config/manifest.json`. Keep a copy of any uncommitted edits before you run it.

- A changed stable pin sets the range `>=<new version> <next minor>`. The range moves with the pin, also to another minor or major line.
- `--range "<reviewed range>"` sets a separately reviewed range instead. A call with the same pin keeps a reviewed range. The validator requires the tested version inside the range.
- Bounds use stable versions. A prerelease pin needs an explicit range with a lower stable bound below its numeric version. A prerelease of the lower bound version is outside the range: `>=1.4.0 <1.5` excludes `1.4.0-rc.1`.
- Tests and guides read the pin from the manifest. Version-scoped evidence, for example an "Observed with Pi 1.1.0" line, stays as it is. Review it before you qualify a new release.

The `questions` component has its own exact pin: its `source.spec` in `config/manifest.json` and the same spec in `config/settings.example.json`. A test of the kit compares the two files.

## Qualify

Qualification tests a candidate Pi version in a private run directory. It installs the candidate under the run directory and copies the kit there with the pin of the candidate. It runs the full check set and the package suites with the candidate Pi, runs `install.sh` into a temporary profile, and loads the extensions and skills of that profile without a session. Then it checks print-mode replies against a built-in loopback endpoint. The checkout stays unchanged.

The report has `passed` and the ordered `steps`. Each step has its name, its exit code and the absolute path of its log. A failed step fails qualification, and the independent later steps still run. Read the log of each failed step before a new attempt.

- The work directory must have an existing parent. Give a short path: the run directory is below it, and some tests depend on the length of the path.
- The script refuses a work directory inside the kit clone or the live `~/.pi/agent` directory, an ancestor of them, and a path with a symbolic link. For macOS, see [a link in the path](guides/troubleshooting.md#a-link-in-the-path).
- With `.git` present, the copy takes the working-tree bytes of the tracked files, including uncommitted edits. Without `.git`, it copies every file except the entries under `.git`, `.local`, `node_modules` and `__pycache__`, so an untracked `.env` is copied too.
- Some contracts of the kit need Pi 1.2.0 or later. An older candidate can fail them.

### Isolation

Each Pi process of the run starts with a minimal environment: `HOME`, `TMPDIR` and the agent directory are inside the run directory, and Pi runs offline with telemetry off. No provider key, session-directory override, Node option or proxy setting of the caller reaches a Pi launch. npm gets empty configuration files and a cache inside the run directory, and install lifecycle scripts do not run.

The run records a metadata baseline of the live `~/.pi/agent` of the caller's `HOME` before and after the steps. It compares names, kinds, sizes and modification times, not content. The result is `isolation: unchanged`, `isolation: changed_unattributed` with the changed top-level entries in `changedEntries`, or `isolation: unavailable`. Another active Pi session can cause a change, and the report cannot name the cause.

By default, a change of the baseline does not change `passed`. Use `--strict-baseline` only when no other process writes the live profile; a change then fails qualification.

Warning: this is process configuration, not an operating-system sandbox. Run only trusted package versions and trusted kit tests.

## Limits

- Not verified: that package code cannot write outside these directories. The runner controls paths and credentials, but it does not enforce a filesystem or network sandbox.
- Not verified: macOS, Windows, interactive sessions, installed-extension copies, live OpenViking or MCP connections, and native-provider authentication.
- Qualification does not prove gate 6 of [the release checklist](guides/release-checklist.md#gates), the clean Linux core trial.
- A passing candidate does not approve a pin change or a release.
