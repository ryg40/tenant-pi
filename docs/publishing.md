# Publishing portable snapshots

You can keep a private copy of the kit with your own notes and publish a clean copy.
The publisher builds a separate snapshot history containing only reviewed files.
`python3 scripts/publish_portable.py --help` describes the command and lists its options, with the default destination.
The publisher requires Git 2.36 or later.

## The command

```sh
python3 scripts/publish_portable.py --no-push  # build and tag locally, inspect first
python3 scripts/publish_portable.py            # checks, snapshot, tag, push to the selected remote
```

- The snapshot comes from the committed `HEAD`, never from unsaved edits. The command refuses a dirty working tree.
- Before the build, the publisher reads a matching stamp or runs the full check set. Then it runs the public reader report and the publish check. A failure or a finding stops the command before the build.
- Each snapshot commit has the previous snapshot as its parent. The commit message and the annotated tag carry the update block of the release notes, so a client reads it with `git log -1`.
- The branch and the tag `portable/<yyyymmdd>-<source sha>` move together. A tag collision or a changed branch value moves neither ref.
- An unchanged tree creates no commit and no tag. The next push still includes the existing tag of that snapshot.
- The snapshot commit and the tag carry a neutral identity; see [secret handling](secret-handling.md#identities-that-leave-with-a-portable-snapshot).

`scripts/publish_check.py` accepts a private copy with reviewed exclusions and a portable copy without those files.
A reader of the published copy can run the same checks.

## Offline checks and local stamps

[The combined offline check](guides/release-checklist.md#combined-offline-check) describes `scripts/check.py`.

- A run of everything (`--all`, tier `full`, no skipped part) on a clean tree writes a stamp for the hash of that tree into the Git metadata. All worktrees of one clone share the stamps. A stamp stays local and is never pushed.
- Other runs write no stamp, and they do not remove an existing stamp. A missing stamp does not fail the checks.
- `python3 scripts/check.py --stamp-status` exits 0 for a matching stamp on a clean tree, or 1 otherwise. A match also needs the same check-set version, Python version and client details.
- The stamp records offline evidence, not live-service qualification or approval to publish.

The publisher reads a matching stamp and prints its record. Otherwise, it runs the full check set and requires `check: passed`.
Run the full check set once per clean tree and client.
Build with `--no-push`, inspect the snapshot, then run the publisher once to push after approval.
Before the next build, publish that snapshot or delete its local `portable/*` tag after review.
Local unpublished tags count as previous releases and can shorten the next changes list.

## History

The public history only moves forward. Each snapshot has the previous snapshot as its parent, so a downstream repository merges a new snapshot with `git fetch` and `git merge`. The publisher has no option to replace or restart that history.
Removing a value from a later snapshot does not remove it from history. Run the public reader review before each snapshot.
A normal push to a divergent remote chain is refused.

## Adding a file to the portable set

`PUBLISH` (exact paths) and `PUBLISH_DIRS` (directory rules) in `scripts/publish_check.py` select the publish set.

- A new file under a directory rule enters automatically unless `scripts/dev-only-files.txt` excludes it. The rules cover `scripts/`, `tests/`, `docs/` and the in-tree packages. A package rule leaves out its technical folders, such as installed dependencies and build output.
- A file outside the directory rules needs an exact path in `PUBLISH` after review, before the next snapshot. Else the publish check fails with `unreviewed_file: repository inventory`.
- The publisher checks the set when it cuts a snapshot; the everyday check does not. Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py` to check it by hand.
- Review each new file before committing it. The pre-commit host-value scan and the [public reader rules](#public-reader-rules) still apply. The publish check also scans each selected file for private-key and token patterns.

For your private copy, use `scripts/dev-only-files.txt` as the optional deny list after reviewing each exclusion. Its header gives the format. Each entry must match a tracked file, and an entry cannot remove a required `PUBLISH` file. The list itself is never published. A portable copy needs no list because the excluded files are absent.

Warning: without a list, all tracked files selected by directory rules publish, including private files with no detectable content finding.

## Public reader rules

A portable snapshot is for a reader outside your private copy. `scripts/publish_check.py` fails when a file of the publish set holds content of a class that a pattern can find:

| Rule id | Finds |
| --- | --- |
| `tracker-reference` | A reference to an entry of a private tracker: the word for an issue or a ticket and then a number, a planning map with a number, or a decision with a letter code. |
| `machine-path` | A path of the home directory of the administrator, or of the stack directory of one host. |
| `host-record` | A record of work on one host: the phrase for one reference machine, a record word such as "observed" or "verified" with a date in the same line, or a date with a phrase for one host in the same line. |
| `host-value-<n>`, `host-value-local-<n>` | A literal pattern of a deny list of [the scan](secret-handling.md#deny-lists), in any case. |

Write the lasting fact in place of such content, for example "Observed with Pi 1.0.2: ..." or "Not verified: ...".

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public --hashes
```

- The first command is the publish check. It stops at the first finding.
- `--public` prints one line `<rule id>: <path>:<line>` for each finding of the whole publish set. A line never holds text of the file or a pattern of a deny list. The last line says whether a local deny list was used.
- `--public --hashes` prints `<path><TAB><sha256>` for each line with a finding. This is the form of an entry of `scripts/host-values.allow-lines`.
- The check finds the local deny list as `scripts/scan.sh` does. A clone of the published snapshot has no local list.
- The two exception lists of the scan apply. A line of `scripts/host-values.allow-lines` gives no finding of any rule. Add a line only after review.

Limits of the rules:

- A pattern finds a form, not a meaning. An account name, a domain or a host name is a finding only when a deny list holds it. Keep such a value in `.local/host-values.deny`. Do not write it into a tracked file.
- These classes have no rule: a path in the home directory of a real user, a name of a person or an agent, and a provider or model choice of one host. Review a new file before you list it.
- A letter code with a number, without the word "decision" before it, is not a finding.
- The check reads the files of the working tree. It does not read the Git history or a commit message. `scripts/scan.sh` reads those for the deny lists.

## In-tree components and the publish set

The components with the source kind `tree` in `config/manifest.json` point at directories under `packages/`. The directory rules publish these directories, so each `tree` path exists in a portable snapshot. A kit can leave out the folder of a `tree` component entirely; the validator fails for a folder that is only partly absent. If you add a `tree` component for a new package, add its directory rule in the same change. The manifest holds no repository URL for these components.

## Limits

- The snapshot copies selected files. Its history contains snapshots, not the source history.
- The pattern scan is not a secret audit. Review a new file before committing it.
- Pushing needs a credential for the destination in the environment that runs the command (for GitHub, `gh auth status` shows it). The script never reads or prints it.

## Continuous integration

Continuous integration (CI) runs checks after a change.
The GitHub workflow `.github/workflows/checks.yml` runs the full check set, `python3 scripts/check.py --all`, on each push and pull request. It has no branch filter.
It runs one job on Linux and one job on macOS (Apple silicon). One failed job does not cancel the other job.
Each job installs Node, the package dependencies and Pi at `runtime.piVersion` of `config/manifest.json`. It also installs the Betterleaks archive of the pin and stops when the SHA-256 checksum of the archive differs from [the pinned checksum](secret-handling.md#pinned-checksums). The `scan` part of `check.py --all` then runs `scripts/scan.sh tree`.
The workflow makes no model request, uploads no artifact and references no repository secret. It never publishes a snapshot or proposes a Pi update. The workflow file holds the action pins as full commit hashes.

The maintainer creates the release entry of a tag only after both jobs of the run on its snapshot pass ([publish steps](guides/release-checklist.md#publish-steps)).
The GitHub workflow runs both OS jobs. The maintainer's development repository runs only the Linux job, from a workflow file that this snapshot does not hold.
The stamp of `check.py --all` is the check of development `main`. A CI run does not replace that stamp.

A rerun uses the workflow from the original commit. A development change does not change an existing snapshot tag.
Publish a new snapshot after approval to include a workflow fix; do not move an old tag.

`tests/test_ci_workflows.py` checks the workflow offline. Not verified offline: the hash-to-tag mapping of the action pins or execution on a GitHub runner.

### GitHub runs and cost

The workflow runs a Linux job and a macOS job on GitHub-hosted runners for each push and pull request.
In a private repository, the jobs use the account's Actions minutes. Included minutes and charges depend on the account plan and the runner type.
Check the account's Actions usage before enabling the workflow.

A branch update with an open pull request can start both a push run and a pull request run.
These two runs can use minutes twice.

### Turn the GitHub workflow off

1. Open Actions in the repository on GitHub.
2. Select the workflow "Offline checks".
3. Choose "Disable workflow" from its menu.

Alternatively, remove `.github/workflows/checks.yml` from each branch where you do not want a run.
