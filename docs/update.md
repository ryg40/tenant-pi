# The update action

`python3 scripts/tenant_pi.py update` tells a client in seconds what a new kit version needs. The client steps are in [Get a new version of the kit](../POST_INSTALL.md#get-a-new-version-of-the-kit).

```sh
python3 scripts/tenant_pi.py update --overlay '<overlay>' --local-dir '<private dir>'
```

The action is read only. It writes no file into the clone, the private directory or a candidate, and it makes no network call. Its processes are read-only Git calls in the clone and the three `--version` calls of [`check-runtime`](check-runtime.md). As in `check-runtime`, the `pi --version` call gets an empty temporary agent directory, which the action removes. `git status` runs with `GIT_OPTIONAL_LOCKS=0`, so Git writes no refreshed index.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--overlay <file>` | required | The overlay. Its `target.agentDir` names the candidate in use. The directory of the overlay is the private directory. |
| `--current <dir>` | `target.agentDir` of the overlay | The candidate in use, for an overlay that names a new target already. |
| `--launcher <file>` | the one `launch-*.sh` file of the private directory that names the candidate | The launcher of the candidate in use. No match or more than one match gives `not_checked`. The search skips a file name outside the path segment form of the kit: letters, digits, `_`, `.`, space, `'`, `"` and `-`. |
| `--manifest`, `--registry`, `--require-role`, `--local-dir` | as for `plan` | The inputs of the plan. |
| `--pi`, `--node`, `--python` | the command on `PATH` | As for `check-runtime`. |

## Fields

The output is one JSON object. Its first key, `summary`, is one short line.

| Field | Content |
| --- | --- |
| `clone` | `commit`; `tag`, a `portable/*` tag at `HEAD` or `null`; `clean`, from `git status` (ignored files do not count); `tests`, `none needed` for a clean clone at a release tag, else `python3 scripts/check.py --tier fast`; at a release tag, `releaseNotes`, the annotated tag message. |
| `runtime` | `status` (`match` or `action_needed`), the `check-runtime` report under `tools`, and `piInstall` with the global Pi line. |
| `plan` | The overlay, the private directory, the target of the overlay, and the profile files of the plan. |
| `comparison` | `reason` of a `new_candidate` verdict: `kit_changed`, `no_output_digests` or `not_comparable`, else `null`. `changes`: each file that needs a new candidate, by name, with `differs`, `added`, `extra`, `missing`, `incomplete`, `invalid` or `unreadable`. `drift`: each file that Pi or the user changed after generation, by name, with `differs` or `missing`; `null` without output digests. `note`: one sentence on the reason or the drift. `launcher`: the launcher file against the launcher text of the plan. |
| `packages` | For each in-tree package that the selection loads by path: `install` and the needed `lines`. |
| `verdict` | `same_profile`, `new_candidate` or `runtime_action_needed`. |
| `newTarget` | For `new_candidate`: the target of the overlay when it names an absent directory, else `<parent>/<name>-<YYYYMMDD>` beside the candidate in use. |
| `nextCommands` | Copy-ready lines with the real paths, each path quoted for the shell. A line that starts with `#` is an instruction for the user. |

`generate` records the SHA-256 of each file that it writes in `outputDigests` of `.tenant-pi/state.json` ([provenance fields](candidate-compare.md#provenance-fields-that-generate-writes)). `update` uses the record for an exact verdict:

- A kit change: the SHA-256 of the bytes that `generate` would write differs from the record, or only one of the plan and the record names the file. A kit change gives `new_candidate` with `kit_changed`.
- Drift: the bytes of a recorded file in the candidate differ from the record. Pi writes into `settings.json` at the first start (`deviceId`) and after `/model`, and the user can edit a file. Drift never changes the verdict: the files stay as they are with `same_profile`.
- A candidate of an earlier release has no `outputDigests`. It is the same profile only when its `choices.json` equals the new plan and no profile input of the kit changed since its `kitCommit` (`git diff` in the clone, also against the working tree). Else the verdict is `new_candidate` with `no_output_digests`: generate one new candidate; later updates compare exactly.
- A file or a record that cannot be read gives `new_candidate` with `not_comparable`, never `same_profile`.

The comparison leaves out `.tenant-pi/`: `choices.json` holds a copy of the manifest and the overlay, and `state.json` holds the generation record. A change there alone changes nothing that Pi loads.

`npm ci --ignore-scripts` is needed when `node_modules/.package-lock.json`, the lock file that npm writes at an install, is absent or lists other packages than `package-lock.json`. An optional package can be absent: npm skips it on another platform.

## Verdicts and exit codes

| Verdict | Meaning | `nextCommands` |
| --- | --- | --- |
| `runtime_action_needed` | Pi, Node or Python is outside the range of the manifest. This verdict comes before the others. | A `PATH` hint for Node or Python, the global Pi line, then `update` again. |
| `new_candidate` | The kit changed a profile file or the launcher, the candidate has no output digests, or a file cannot be read. | The overlay edit, `check-runtime`, `generate`, the baseline lines, the setup and package lines, the launcher with `/login`, `check-baseline`, `compare` and `results --replace`. |
| `same_profile` | `generate` would write the same files as at the generation of the candidate in use. Drift can remain. | The package lines, if any, then a restart of Pi. |

A clone without a clean release tag gets the fast check line first in `nextCommands`. A clean clone at a release tag gets no check line. The GitHub workflow `.github/workflows/checks.yml` runs `python3 scripts/check.py --all` on Linux and macOS for each snapshot that is pushed to GitHub. The maintainer creates the release entry of a tag only after both runs pass ([continuous integration](publishing.md#continuous-integration)).

Exit code 0 means `same_profile` with no package line and no check line. Exit code 1 is each other result: a finding, as for `check-runtime`. Exit code 2 is a usage or input error, with `rule: field` on standard error.

Not verified: a run of `update` on macOS.
