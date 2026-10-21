# Publishing portable snapshots

You can keep a private copy of the kit with your own notes and publish a clean copy.
The publisher builds a separate snapshot history containing only reviewed files.
Choose a destination remote; the default name is `github`.
The publisher requires Git 2.36 or later for `git worktree list --porcelain -z`.

## The command

```sh
python3 scripts/publish_portable.py            # checks, snapshot, tag, push to the selected remote
python3 scripts/publish_portable.py --no-push  # build and tag locally, inspect first
```

What it does, in order:

1. Refuses a dirty working tree. The snapshot comes from the committed `HEAD`, never from unsaved edits.
2. Calls `python3 scripts/check.py --stamp-status`. For a matching stamp, the publisher prints its tree, time, client, skipped count and result lines. Otherwise, it runs the full check set, `python3 scripts/check.py --all`. A failure stops before the snapshot build. It then runs the public reader report (`publish_check.py --public`) and the publish check. A finding of either stops before the snapshot build.
3. Builds a Git tree from `HEAD` that contains only the files in `PUBLISH` and in the `PUBLISH_DIRS` rules in `scripts/publish_check.py`, through a temporary index. The working tree is not touched.
4. Builds the snapshot commit and annotated tag objects. The commit uses the previous snapshot as parent, unless `--new-root` is set. Their message carries the update block of the release notes, so that a client reads it with `git log -1` or through the `update` action of `scripts/tenant_pi.py`.
5. Updates the branch and creates `portable/<yyyymmdd>-<source sha>` in one Git transaction. A tag collision or changed branch value moves neither ref.
6. Pushes the snapshot branch to the destination named by `--remote` and `--remote-branch`, with the snapshot tags named explicitly. A refused push stops the command.
   An unchanged tree creates no commit or tag unless `--new-root` is set. The next push still includes existing tags of that snapshot.
   The snapshot commit and the tag carry the neutral identity `tenant-pi portable <portable@tenant-pi.invalid>` and no signature; `TENANT_PI_PUBLISH_NAME`, `TENANT_PI_PUBLISH_EMAIL`, `--identity-name` and `--identity-email` change it (`docs/secret-handling.md`).

`scripts/publish_check.py` accepts a private copy with reviewed exclusions and a portable copy without those files.
A reader of the published copy can run the same checks.

## Offline checks and local stamps

[The combined offline check](guides/release-checklist.md#combined-offline-check) describes `scripts/check.py`. `python3 scripts/check.py --help` lists its selection rules and options.

A successful run of everything (`--all`, tier `full`, no skipped part) on a clean tree writes `.git/check-stamps/<tree sha>` as JSON.
The tree must be clean before and after the checks, and its hash must stay unchanged.
The hash comes from `git rev-parse HEAD^{tree}`.
All worktrees of one clone share the stamp directory in the common Git metadata directory.
The fields are `checkSetVersion`, `python`, `client`, `skipped`, `tests`, `resultLines` and `when`.
The client records root status, Docker command availability and the Node version when available.
Docker availability does not prove that a daemon is running.
The stamp stays local and is never pushed.
Dirty trees, failed runs, fast runs, runs without `--all` and runs with a skipped part write no stamp.
Such a run does not remove an existing stamp.
A stamp path or write failure prints `stamp: not written (...)`.
A missing stamp does not fail the checks: a successful run still ends with `check: passed` and exits 0.

`python3 scripts/check.py --stamp-status` exits 0 for a matching stamp on a clean tree, or 1 otherwise.
Without `.git`, it prints only `stamp: not available (not a Git work tree)` and exits 1.
It also requires the current check-set version, Python version and client details to match.
The stamp records offline evidence, not live-service qualification or approval to publish.
The publisher reads a matching stamp and prints `tree`, `when`, `client`, `skipped` and `resultLines`.
Otherwise, it runs the full check set and requires exit code 0 with the final line `check: passed`.
The publish check remains a direct call because the snapshot build needs its file list.
Run the full check set once per clean tree and client.
Build with `--no-push`, inspect the snapshot, then run the publisher once to push after approval.
Before the next build, publish that snapshot or delete its local `portable/*` tag after review.
Local unpublished tags count as previous releases and can shorten the next changes list.
Both publisher runs reuse the stamp while the tree, check-set version, Python version and client details still match.
If a stamp is missing or stale, the publisher runs the full check set again.

## Options

| Option | Use |
| --- | --- |
| `--remote`, `--remote-branch` | Another destination. Defaults: `github`, `main`. |
| `--branch` | Local snapshot branch: `portable`, `portable-*` or `portable/*` in both modes. Default `portable`. No worktree may check it out. |
| `--no-push` | Inspect with `git show portable --stat` before publishing. |
| `--class` | Select `patch` (the default) or `full` for the release record. |
| `--notes` | Write draft release notes outside the checkout at this path instead of a new system temporary file. |
| `--force` | Replace the remote branch, including an existing snapshot chain, with `--force-with-lease`. It does not remove remote tags. Not for routine runs. |
| `--new-root` | Start a parentless snapshot. Needs `--no-push` and a branch named `portable`, `portable-*` or `portable/*` that no worktree checks out. |

## A new history

Each snapshot normally has the previous snapshot as its parent. Removing a value from a later snapshot does not remove it from history.
Use `--new-root` to prepare a history without earlier snapshots for a new, empty repository.

```sh
python3 scripts/publish_portable.py --new-root --no-push
```

- The snapshot commit has no parent, even when its tree equals the previous snapshot.
- The snapshot namespace is `portable`, `portable-*` or `portable/*` in both modes. This applies to absent and existing branches, without inspecting commit messages.
- The command refuses a branch checked out in any worktree. This refusal also applies to ordinary snapshots.
- The branch moves only when both ref updates can succeed. A second new-root run on the same source and date finds a tag collision and moves no ref.
- Earlier local `portable/*` tags and other refs stay unchanged. They can keep earlier commits and identities reachable. Do not push them.
- To keep a separate backup ref, create it before the command. The printed previous commit is informational, not a backup action.
- The command does not push. A normal push to an existing divergent chain is refused. A later `--force` run can replace that remote branch.
- The push names only tags pointing at the selected snapshot. It does not delete earlier remote tags or refs.
- The next run without `--new-root` chains onto the new root.

Warning: `--force` can replace an existing remote history, but earlier remote tags can still expose its commits.

The safe destination is a new, empty repository. Review or remove earlier remote tags separately if you reuse a destination.
The publisher cannot erase copies in other clones or forks. A force-with-lease push checks an expected ref value, not content privacy.
There is no remote-message guard: snapshot messages and identities are configurable and do not reliably identify a history to protect.

## Adding a file to the portable set

`PUBLISH` (exact paths) and `PUBLISH_DIRS` (directory rules) in `scripts/publish_check.py` select the publish set.
A new file under a directory rule enters automatically unless `scripts/dev-only-files.txt` excludes it.
A file outside the directory rules needs an exact path in `PUBLISH` after review, before the next snapshot. The publisher checks the set when it cuts a snapshot; the everyday check does not.
Review each new file before committing it. The pre-commit host-value scan and the [public reader rules](#public-reader-rules) still apply.
The publish check scans each selected file for private-key and token patterns and rejects an `.env.example` with values.
The kit's `.okf/` bundle exists only in the development repository; the deny list excludes it from snapshots.

For your private copy, use `scripts/dev-only-files.txt` as the optional deny list after reviewing each exclusion.
Use one repository-relative file path or directory prefix ending in `/` per line. Blank lines and full-line `#` comments are ignored.
Paths cannot contain whitespace or `#`; inline comments and other trailing text are errors. Trailing whitespace and CRLF line endings are accepted.
Each entry must match at least one tracked file. A directory needs a trailing `/`.
Without Git metadata, the checker uses the file inventory instead of tracked paths.
The list itself is never published. A portable copy needs no list because the excluded files are absent.
An exclusion cannot remove a required `PUBLISH` file. Invalid paths or an unreadable list stop publication.
`publish_check.py` alone reads the working-tree list; the snapshot reads it from committed `HEAD`.

Warning: without a list, all tracked files selected by directory rules publish, including private files with no detectable content finding.

An empty list has the same effect. The tools cannot infer which unlisted files you consider private.
Root-level files outside the explicit publish set still fail the inventory check.

| Error | Meaning |
| --- | --- |
| `private_exclude_list` | The list is a symlink or is not a regular file. |
| `private_exclude_unreadable` | The list cannot be read or decoded. |
| `private_exclude_path` | A path has an invalid shape. |
| `private_exclude_text` | A line contains whitespace or `#` inside its path text. |
| `private_exclude_directory` | A directory entry lacks its trailing `/`. |
| `private_exclude_unused` | An entry matches no tracked file. Correct a typo or remove a stale entry after review. |
| `private_excludes_explicit` | An entry tries to exclude a required explicit publish file. |

## Directory rules

The same `PUBLISH_DIRS` mechanism covers scripts, tests, docs and in-tree packages.
A package rule can include technical exclusions:

```python
PUBLISH_DIRS = (
    ("packages/<name>", ("node_modules/", "dist/")),
)
```

- A rule publishes every tracked file under the directory, except the excludes.
- An exclude is a path relative to the directory. A name that ends with `/` excludes a directory. Other names exclude one exact file.
- Keep technical exclusions in the directory rule. Put private-copy file and directory names only in the optional exclusion list.
- An untracked file under the directory fails the publish check with `unreviewed_file`.
- The inventory ignores four directory names at any depth: `.local`, `.git`, `__pycache__` and `node_modules`.
- The inventory excludes the untracked local architecture page and values file. Tracking either file fails with `tracked_local_file`.
- A tracked file under a `node_modules` directory fails the check with `tracked_in_node_modules`.
- A file in `PUBLISH` that is also under a rule fails the check with `publish_duplicates`.
- The check fails on any file outside `PUBLISH`, accepted directory rules and the optional exclusion list.
- The check scans each rule file for the private-key and token patterns. A rule file can be binary.

`scripts/publish_portable.py` uses the same rules and deny list on the files of committed `HEAD`. `tests/test_publish_rules.py` tests the rules. Run `scripts/scan.sh all` for a full release only (`docs/secret-handling.md`). The accepted host-value lines of the publish set are listed by hash in `scripts/host-values.allow-lines`; the scan at level `fail` on `portable` passes only with that list.

## Public reader rules

A portable snapshot is for a reader outside your private copy. `scripts/publish_check.py` fails when a file of the publish set holds content of a class that a pattern can find:

| Rule id | Finds |
| --- | --- |
| `tracker-reference` | A reference to an entry of a private tracker: the word for an issue or a ticket and then a number, a planning map with a number, or a decision with a letter code. |
| `machine-path` | A path of the home directory of the administrator, or of the stack directory of one host. |
| `host-record` | A record of work on one host: the phrase for one reference machine, a record word such as "observed" or "verified" with a date in the same line, or a date with a phrase for one host in the same line. |
| `host-value-<n>`, `host-value-local-<n>` | A literal pattern of `scripts/host-values.deny` or of the untracked `.local/host-values.deny`, in any case. These are the deny lists and the rule ids of `scripts/scan.sh` (`docs/secret-handling.md`). |

Write the lasting fact in place of such content, for example "Observed with Pi 1.0.2: ..." or "Not verified: ...". The regular expressions are `PUBLIC_RULES` in `scripts/publish_check.py`.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public --hashes
```

- The first command is the publish check. It stops at the first finding with `publish_public_reader: <path>`.
- `--public` prints one line `<rule id>: <path>:<line>` for each finding of the whole publish set, then a count. The exit code is 1 when it has a finding. A line never holds text of the file or a pattern of a deny list.
- `--public --hashes` prints `<path><TAB><sha256>` for each line with a finding. This is the form of an entry of `scripts/host-values.allow-lines`.
- The local deny list is optional. The check finds it as `scripts/scan.sh` does: `SCAN_LOCAL_DENY`, then `.local/host-values.deny` of the checkout, then the file of the main checkout for a linked worktree. A clone of the published snapshot has no local list. The check then uses the rules of the table and the tracked list. The last line of `--public` says `with a local deny list` or `without a local deny list`.
- The two exception lists of the scan apply. A deny-list pattern that is only inside an exact URL of `scripts/host-values.allow` gives no finding. A line of `scripts/host-values.allow-lines` gives no finding of any rule. Add a line only after review. A changed line is a finding again.
- `PUBLIC_PENDING` in `scripts/publish_check.py` holds the path prefixes that the publish check does not cover yet. It is empty now: the check covers each file of the publish set.

Limits of the rules:

- A pattern finds a form, not a meaning. An account name, a domain or a host name is a finding only when a deny list holds it. Keep such a value in `.local/host-values.deny`. Do not write it into a tracked file.
- These classes have no rule: a path in the home directory of a real user, a name of a person or an agent, and a provider or model choice of one host. Review a new file before you list it.
- A letter code with a number, without the word "decision" before it, is not a finding.
- The check reads the files of the working tree. It does not read the Git history or a commit message. `scripts/scan.sh` reads those for the deny lists.

`PublicReaderTests` in `tests/test_publish_rules.py` holds the negative control: a synthetic value of each class must give a finding, and similar clean text must give none. The test builds each value at run time from parts, because the test file is in the publish set too.

## In-tree components and the publish set

The components with the source kind `tree` in `config/manifest.json` point at directories under `packages/`. The `PUBLISH_DIRS` rules publish these directories, so each `tree` path exists in a portable snapshot. A kit can leave out the folder of a `tree` component: the validator accepts the absent folder while the overlay does not enable the component, and fails with `tree_resource_missing` when it does. A `tree` path that is a file fails with `tree_path_missing`. If you add a `tree` component for a new package, add the `PUBLISH_DIRS` rule in the same change. The manifest holds no repository URL for these components.

## Limits

- The snapshot copies selected files. Its history contains snapshots, not the source history.
- The pattern scan is not a secret audit. Review a new file before committing it.
- Pushing needs a credential for the destination in the environment that runs the command (for GitHub, `gh auth status` shows it). The script never reads or prints it.

## Continuous integration

Continuous integration (CI) runs checks after a change.
The GitHub workflow checks the published snapshot after a push. It never publishes a snapshot or proposes a Pi update.
The maintainer creates the release entry of a tag only after both jobs of the run on its snapshot pass. A failed job stops the release entry ([publish steps](guides/release-checklist.md#publish-steps)).
The stamp of `check.py --all` on development `main` records the check of that tree.
The development remote runs no CI; that stamp is the check of `main`. A GitHub run does not replace the stamp on development `main`.

### GitHub workflow

`.github/workflows/checks.yml` runs `python3 scripts/check.py --all`, the full check set, on each push and pull request.
It has no branch filter: each branch that holds the file can start a run.
Before the check, each job installs Node from the `engines` field of `packages/tenantext/package.json`, runs `npm ci --ignore-scripts` in each package with a `test` script, and installs Pi at `runtime.piVersion` of `config/manifest.json` under `$RUNNER_TEMP` with the links of [the package tests](packages.md#tests).
It installs no Betterleaks, so the scan line says `skipped`. It makes no model request. The jobs upload no artifact.

The job `offline` uses a matrix, so GitHub runs it as two jobs with the same steps. `setup-python` sets the Python version of each job.
The `ubuntu-latest` job uses Python 3.11, the lowest version that the kit supports. The `macos-15` job (Apple silicon) uses Python 3.12, the version of the [macOS guide](guides/macos.md).
One failed job does not cancel the other job.
The workflow uses JSON-form YAML, a subset of YAML 1.2 that the Python standard library can parse.
All action references use full commit hashes. Permissions are limited to `contents: read`.
Checkout does not keep its token in Git configuration. The workflow references no repository secrets.

| Action | Pinned commit hash | Tag |
| --- | --- | --- |
| `checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `v7.0.1` |
| `setup-python` | `5fda3b95a4ea91299a34e894583c3862153e4b97` | `v7.0.0` |
| `setup-node` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `v7.1.0` |

Not verified offline: the hash-to-tag mapping or execution on a GitHub runner.

A rerun uses the workflow from the original commit. A development change does not change an existing snapshot tag.
Publish a new snapshot after approval to include a workflow fix; do not move an old tag.

### GitHub runs and cost

The workflow runs two jobs on GitHub-hosted runners for each push and pull request: one on Linux and one on macOS.
In a private repository, the jobs use the account's Actions minutes. Included minutes and charges depend on the account plan and the runner type.
Check the account's Actions usage before enabling the workflow.

A branch update with an open pull request can start both a push run and a pull request run.
These two runs can use minutes twice.

### Turn the GitHub workflow off

1. Open Actions in the repository on GitHub.
2. Select the workflow "Offline checks".
3. Choose "Disable workflow" from its menu.

Alternatively, remove `.github/workflows/checks.yml` from each branch where you do not want a run.

### Evidence and limits

`tests/test_ci_workflows.py` parses the workflow as JSON-form YAML and rejects duplicate keys.
It checks the action pins, triggers, permissions, credential handling, the two platforms and Python setup.
It requires the workflow to run `python3 scripts/check.py --all` and to hold no copy of the Pi pin.
These offline tests do not prove that a GitHub runner executes the workflow or qualify a real Pi version.

Pi pin moves follow the [manual pin move guide](guides/pin-move-release.md).
The [update checks](pi-update.md) retain `detect`, `notes` and `qualify` for that guide.
Portable publication remains a separate, manually approved operation.
