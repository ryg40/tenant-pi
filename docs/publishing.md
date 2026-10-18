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
2. Calls `python3 scripts/check.py --stamp-status`. A matching stamp prints its tree, time, client, skipped count and result lines. Otherwise, it runs the full `python3 scripts/check.py` check set. A failure stops before the snapshot build. It then checks public page currency and calls the publish check directly to validate the snapshot file list.
3. Builds a Git tree from `HEAD` that contains only the files in `PUBLISH` and in the `PUBLISH_DIRS` rules in `scripts/publish_check.py`, through a temporary index. The working tree is not touched.
4. Builds the snapshot commit and annotated tag objects. The commit uses the previous snapshot as parent, unless `--new-root` is set.
5. Updates the branch and creates `portable/<yyyymmdd>-<source sha>` in one Git transaction. A tag collision or changed branch value moves neither ref.
6. Pushes the snapshot branch to the destination named by `--remote` and `--remote-branch`, with the snapshot tags named explicitly. A refused push stops the command.
   An unchanged tree creates no commit or tag unless `--new-root` is set. The next push still includes existing tags of that snapshot.
   The snapshot commit and the tag carry the neutral identity `tenant-pi portable <portable@tenant-pi.invalid>` and no signature; `TENANT_PI_PUBLISH_NAME`, `TENANT_PI_PUBLISH_EMAIL`, `--identity-name` and `--identity-email` change it (`docs/secret-handling.md`).

`scripts/publish_check.py` accepts a private copy with reviewed exclusions and a portable copy without those files.
A reader of the published copy can run the same checks.

## Offline checks and local stamps

Run the combined offline check from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py
python3 scripts/check.py --tier fast
python3 scripts/check.py --stamp-status
```

The full tier runs one unittest process per test module, then the publish check, the public reader check and `git diff --check`.
Without `.git`, it runs the unit and publish checks, prints `diff: skipped (not a Git work tree)`, and writes no stamp.
The unit suite already includes the examples, sample overlay, documentation and builder determinism tests, but not page currency checks.
The worker pool defaults to `os.cpu_count()`, or one worker when that value is unavailable.
Use `python3 scripts/check.py --jobs 4` to set a smaller pool.
The combined unit result prints `Ran N tests` and `OK (skipped=K)`, or `FAILED`.
Each other check prints one result line. The final line is `check: passed` or `check: FAILED`.
A failed check gives exit code 1. Failure details go to standard error.
Both offline CI workflows use this command.

The fast tier skips tests marked with `slow` in `tests/support.py`.
These markers identify tests measured at 0.3 seconds or more; they do not remove tests from the full tier.
For a sequential fast run, use:

```sh
TENANT_PI_TIER=fast PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
```

`check.py` defaults to the full tier and sets the selected tier explicitly for its children.
It sets `PYTHONDONTWRITEBYTECODE=1` for each child process.
A fast run is feedback for development, not release qualification.

A successful full run on a clean tree writes `.git/check-stamps/<tree sha>` as JSON.
The tree must be clean before and after the checks, and its hash must stay unchanged.
The hash comes from `git rev-parse HEAD^{tree}`.
All worktrees of one clone share the stamp directory in the common Git metadata directory.
The fields are `checkSetVersion`, `python`, `client`, `skipped`, `tests`, `resultLines` and `when`.
The client records root status, Docker command availability and the Node version when available.
Docker availability does not prove that a daemon is running.
The stamp stays local and is never pushed.
Dirty trees, failed runs and fast runs write no stamp.
A fast run does not remove an existing full-run stamp.

`python3 scripts/check.py --stamp-status` exits 0 for a matching stamp on a clean tree, or 1 otherwise.
It also requires the current check-set version, Python version and client details to match.
The stamp records offline evidence, not live-service qualification or approval to publish.
The publisher reads a matching stamp and prints `tree`, `when`, `client`, `skipped` and `resultLines`.
Otherwise, it runs the full check set and requires exit code 0 with the final line `check: passed`.
The publish check remains a direct call because the snapshot build needs its file list.
Run the full check set once per clean tree and client.
Build with `--no-push`, inspect the snapshot, then run the publisher once to push after approval.
Both publisher runs reuse the stamp while the tree, check-set version, Python version and client details still match.
If a stamp is missing or stale, the publisher runs the full check set again.

## Public pages

Both release classes compare the public pages after the check set and before any snapshot ref changes.
The publisher runs `python3 scripts/architecture_build.py --check` and `python3 scripts/explainer_build.py --check` without writing pages.
A stale page stops publication with one line, such as `page stale: EXPLAINER.html`.
Regenerate the page with its builder and commit it before publishing.

## Options

| Option | Use |
| --- | --- |
| `--remote`, `--remote-branch` | Another destination. Defaults: `github`, `main`. |
| `--branch` | Local snapshot branch: `portable`, `portable-*` or `portable/*` in both modes. Default `portable`. No worktree may check it out. |
| `--no-push` | Inspect with `git show portable --stat` before publishing. |
| `--class` | Select `patch` (the default) or `full` for the release record. |
| `--notes` | Write draft release notes to this path instead of a new system temporary file. |
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

`PUBLISH_DIRS` in `scripts/publish_check.py` publishes tracked files under `scripts/`, `tests/` and `docs/`, including `docs/explainer/`.
A new file under those directories enters automatically unless `scripts/dev-only-files.txt` excludes it.
Review each new file before committing it. The pre-commit host-value scan and the [public reader rules](#public-reader-rules) still apply.
The publish check scans each selected file for private-key and token patterns and rejects an `.env.example` with values.
Files outside directory rules need an exact path in `PUBLISH` after review.
The kit's `.okf/` bundle stays in the development tree, excluded through the deny list.

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
- An untracked file under the directory fails the check with `unreviewed_file`.
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

The components with the source kind `tree` in `config/manifest.json` point at `packages/tenantext` and `packages/promptr`. The `PUBLISH_DIRS` rules publish these directories, so each `tree` path exists in a portable snapshot. `scripts/validate.py` fails with `tree_path_missing` when a path is absent. If you add a `tree` component for a new package, add the `PUBLISH_DIRS` rule in the same change. The manifest holds no repository URL for these components.

## Limits

- The snapshot copies selected files. Its history contains snapshots, not the source history.
- The pattern scan is not a secret audit. Review a new file before committing it.
- Pushing needs a credential for the destination in the environment that runs the command (for GitHub, `gh auth status` shows it). The script never reads or prints it.

## Continuous integration

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Continuous integration (CI) runs checks after a change. These workflows check the kit and propose Pi updates. They never publish a portable snapshot.

### Workflows

| File | Trigger | Result |
| --- | --- | --- |
| `.gitea/workflows/checks.yml` | Each push and pull request | Runs `python3 scripts/check.py`. |
| `.github/workflows/checks.yml` | Each push and pull request | Runs `python3 scripts/check.py` without secrets or package installs. |
| `.gitea/workflows/pi-update.yml` | Daily at `04:23` UTC, or a manual run | Detects a core update, qualifies it, reads its notes, and proposes a pull request. |

All three files use JSON-form YAML. JSON is a subset of YAML 1.2. This lets the Python standard library check their syntax.

All action references use full commit hashes. The public workflow requests only `contents: read`. Checkout does not keep a token in Git configuration.

| Action | Pinned commit hash | Tag |
| --- | --- | --- |
| `checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | `v4.2.2` |
| `setup-python` | `a26af69be951a213d495a4c3e4e4022e16d87065` | `v5.6.0` |
| `setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |
| `upload-artifact` | `c6a366c94c3e0affe28c06c8df20a878f24da3cf` | `v3.2.2` |
| `download-artifact` | `9bc31d5ccc31df68ecc42ccf4149144866c47d8a` | `v3.0.2` |

Not verified offline: the hash-to-tag mapping.

The two Gitea files are also in the publish set. They contain no private configuration and let a user run the same workflows on a Gitea fork. GitHub ignores the `.gitea/workflows` directory. A Gitea fork can enable the scheduled workflow when it has the required runner and secret.

The update workflow runs only from `main`. A manual run on another branch skips detection. If your default branch differs, change the branch guard and `UPDATE_BASE` together.

#### GitHub runs and cost

On GitHub, `.github/workflows/checks.yml` runs one job on a GitHub-hosted runner for each push and pull request. It has no branch filter: each branch that holds the file can start a run.

In a private repository, the job uses the Actions minutes of the account. The included minutes and charges depend on the account plan. Check the Actions usage of the account before you enable the workflow.

A branch update with an open pull request can start both a push run and a pull request run. These two runs can use minutes twice.

The Gitea workflows run only on a registered runner of the Gitea server. They use no GitHub minutes.

#### Turn the GitHub workflow off

1. Open Actions in the repository on GitHub.
2. Select the workflow "Offline checks".
3. Choose "Disable workflow" from its menu.

Or remove `.github/workflows/checks.yml` from each branch where you do not want a run.

### Runner requirements

Use an isolated, disposable Linux job container. Do not mount a live Pi profile, a provider credential directory, or the Docker socket into it.

| Requirement | Offline checks | Update jobs |
| --- | --- | --- |
| Runner label | `ubuntu-latest` | `ubuntu-latest` |
| Python | Gitea: Python 3.11 in the image; GitHub: set by `setup-python` | Python 3.11 in the image |
| Node | Node 20 or later for JavaScript actions | Node 24.21.0 and its npm, set by `setup-node` |
| Other tools | Git and Bash | Git, Bash and the package test prerequisites |
| Network | Checkout and language/action setup only | Also the npm registry, package archives and the Gitea API |
| Credentials | Checkout token only | Checkout token; preflight and request steps also need `PI_UPDATE_TOKEN` |

The label is a requirement, not a claim that a registered runner has it. Check the runner label and container image before enabling scheduled runs.

Each Gitea job checks the installed `python3` before running repository commands. It accepts Python 3.11 patch releases and fails with a clear message for another version. A missing `python3` also fails the step. The job installs no Python package or interpreter.

A Gitea label named `ubuntu-latest` can select a Debian image. `setup-python` does not provide a matching download for Debian Bookworm. For example, `node:20-bookworm` already includes Python 3.11. Use an image with that interpreter rather than an unsupported download. The GitHub workflow keeps `setup-python` on its Ubuntu runner.

A rerun uses the workflow from the original commit. Fixing the development branch does not change an existing snapshot tag. Publish a new snapshot after approval to include a workflow fix; do not move an old tag.

The offline commands use only the Python standard library. They install no package and make no model request. The memory-submit tests use `unittest.TestCase`, so discovery runs them without `pytest`. The public job uploads no artifact.

The update adapter starts `scripts/pi_update.py` with a new temporary `HOME` and a short environment allowlist. It forwards no job token or provider key. Qualification and notes use a temporary work directory outside the checkout. The adapter copies only step logs into the artifact directory. It removes that work directory after the stage. The update command must also isolate each Pi process. It installs Pi under its work directory, not globally.

The updater compares `<temporary HOME>/.pi/agent`, which normally does not exist; it does not watch your live Pi directory. Its `isolation` report is informational; the adapter does not pass `--strict-baseline`.

Warning: npm packages can execute install scripts. Use a disposable runner without provider credentials, even when the command clears its child environment.

### Update stages

| Job | Condition | Work |
| --- | --- | --- |
| `detect` | Default branch only | Calls `python3 scripts/pi_update.py detect`. Exit 0 means no update; exit 10 means an update exists. |
| `preflight` | Core version differs | Uses GET requests to check open requests and the version branch. |
| `qualify` | Preflight reports `eligible=true` | Calls `qualify --version <v> --workdir <dir>`. A nonzero exit fails the job. |
| `notes` | Preflight reports `eligible=true` | Calls `notes --from <old> --to <new> --workdir <dir>`. Requires a Boolean `breaking` and release text. |
| `request` | Qualification and notes jobs succeed | Uses the Gitea API to create a version branch and a pull request. |

`scripts/ci_update.py` adapts the command output to job outputs and artifacts. Detection reads `core.latest` from the JSON report. Notes accept a `text` string or ordered `entries` with `version` and `text` fields. Module-only updates stay in the detection report and do not move the core pin. Update targets must be stable numeric `major.minor.patch` values. Changelog labels also accept prereleases such as `1.0.4-rc.1`, with the updater's 80-character bound.

Qualification and notes run independently after a successful preflight with `eligible=true`. Each retains its JSON reports and `.log` files, even after failure, for 14 days. No profile, authentication file or installed package tree is uploaded. Detection also retains its report and log. Preflight retains its status report. Failed qualification produces a failed run, not an issue, and cannot start the request job.

The request imports `scripts/pi_update.py` by path and calls `pin_contents`.
That function changes `runtime.piVersion`, `runtime.piAcceptedRange` and the core package spec in `config/manifest.json`. A stable pin move sets `>=<new version> <next minor>` as the accepted range. It also changes the matching core anchor in `scripts/validate.py`; without this change, the strict validator refuses the new pin.

The pull request body contains the notes. A breaking change adds `BREAKING:` to the title and `Breaking changes: YES` to the body. Current-pin test fixtures read the candidate manifest. The request does not approve a merge. Run the full checks before merging.

The branch name is `automation/pi-<version>`. Preflight checks open pull requests with bounded pagination, then checks the branch. An existing open request or a claimed branch gives `eligible=false`, so qualification and notes are skipped. Preflight makes no server write. API failures stop preflight without enabling qualification.

Atomic branch creation gives only one run permission to create the request. This does not rely on workflow `concurrency`. A second run that cannot create the branch cannot create a pull request. A changed base commit also stops the request.

A request closed without merge leaves a claimed branch. An interrupted run after branch creation can also leave one. Preflight writes its output and report, then exits 1 for `branch_claimed_review_required`, making the run red while qualification and notes stay skipped. An open request gives `existing` and exit 0, so that case stays green. Reopen or complete the request, or remove the unused branch after review before retrying. The request action keeps its atomic branch check because another run can claim the branch after preflight. The workflow never deletes or force-updates a branch.

### Gitea token

Set one repository Actions secret named `PI_UPDATE_TOKEN`. Use a dedicated account and a repository-scoped personal access token. Give it only the repository permissions required to read files, create a branch, commit files and create a pull request. On servers with scoped tokens, this requires `write:repository` and access to this repository.

Only the preflight and request steps receive this secret. Detection, qualification and notes do not receive it. Preflight uses the token for GET requests only. The API client requires an `https` server URL and refuses redirects. The workflow takes this URL from `gitea.server_url`; an `http` server fails with `api_url`. It prints static errors, not API response bodies or token values.

The runner supplies a separate temporary job token for checkout and artifacts. Gitea versions differ in how they apply `permissions`. The workflow does not rely on that field to grant API writes. The named token makes the write requirement explicit. Never use a provider API key for this secret.

Warning: a user who can change a trusted workflow can use its repository secrets. Protect the default branch and review workflow changes.

### Gitea differences

The [Gitea comparison](https://docs.gitea.com/usage/actions/comparison/) and [Gitea FAQ](https://docs.gitea.com/usage/actions/faq/) describe the compatibility rules.

- Gitea accepts both `gitea` and `github` contexts. These Gitea workflows use `gitea` for repository identity and revision.
- The adapter writes step outputs through `GITHUB_OUTPUT`, the compatibility variable that actions use. Confirm job outputs on your runner.
- Gitea accepts extra schedule forms such as `@daily`. This workflow uses a five-field cron expression instead.
- Scheduled workflows must be on the default branch. Confirm the server timezone and the first scheduled run before relying on the daily time.
- Gitea pulls action sources from a configurable host. These files use explicit `https://github.com/` action URLs to avoid that ambiguity.
- Gitea pull request checks use the head revision, not GitHub's synthetic merge revision. A passing Gitea check does not prove the merged tree passes.
- Gitea 1.24 documents ignored `permissions`, `concurrency` and job timeouts. Newer versions differ. The adapter uses a process-group timeout and an atomic branch claim. Child processes that create separate process groups need their own timeouts.

The [artifact documentation](https://docs.gitea.com/usage/actions/artifacts/) describes storage and access. Gitea artifact support differs from GitHub's artifact service. These workflows pin `upload-artifact` v3.2.2 and `download-artifact` v3.0.2 for the older artifact protocol. They do not assume that GitHub's v4 protocol works on Gitea.

Warning: the workflows under `.gitea/` are for Gitea, not GitHub; their update workflow uses artifact actions v3, which GitHub no longer runs.

Not verified without a server run: artifact upload/download compatibility, the server's retention policy, token scopes, schedule delivery and the selected runner image. A failed artifact download blocks the request job.

### Run by hand

Run the offline check from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py
```

For quick local feedback, use `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py --tier fast`.

Run each update stage without the request stage:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/ci_update.py detect --directory .local/ci/detect
UPDATE_VERSION="<new version>" PYTHONDONTWRITEBYTECODE=1 python3 scripts/ci_update.py qualify --directory .local/ci/qualify
UPDATE_FROM="<pin>" UPDATE_VERSION="<new version>" PYTHONDONTWRITEBYTECODE=1 python3 scripts/ci_update.py notes --directory .local/ci/notes
```

Replace `<pin>` and `<new version>` with the current pin and the detected version. Detection returns success after either valid outcome and writes `selection.json` with `new`, `current` and `version`.

To run the read-only preflight, set `UPDATE_SERVER`, `UPDATE_REPOSITORY`, `UPDATE_VERSION` and `UPDATE_TOKEN` as described below. Then run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/ci_update.py preflight --directory .local/ci/preflight
```

Continue qualification only when its JSON report has `eligible` equal to `true` as a string.

The underlying command interface is:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py detect
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version "<new version>" --workdir /tmp/pi-qualification
PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py notes --from "<pin>" --to "<new version>" --workdir /tmp/pi-notes
```

The adapter is safer in a shell with credentials because it clears the child environment. The underlying command must provide its own Pi isolation.

The request action writes to the Git server. Run it only after approval, with the same checkout and successful stage reports. Set `UPDATE_SERVER`, `UPDATE_REPOSITORY`, `UPDATE_BASE`, `UPDATE_REVISION`, `UPDATE_FROM` and `UPDATE_VERSION`. Supply `UPDATE_TOKEN` from a secret store without printing it. Then run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/ci_update.py request --directory .local/ci
```

For example, `UPDATE_SERVER` can be `https://git.example.invalid` and `UPDATE_REPOSITORY` can be `example-owner/example-repo`. The server value is the root URL, not an `/api/v1` URL. `UPDATE_REVISION` is the full commit hash of the qualified checkout.

### Turn the schedule off

1. Remove the `schedule` member from `on` in `.gitea/workflows/pi-update.yml`.
2. Commit that change to the default branch.
3. Check that the manual trigger remains available.

Removing the secret makes preflight fail and skips qualification. It does not stop detection. Disabling Actions for the whole repository also stops the offline checks.

### Evidence and limits

`tests/test_ci_workflows.py` parses all workflow files as JSON-form YAML, rejects duplicate keys and checks command paths, action pins, triggers, dependencies and secret placement. It requires the Python check in every Gitea job and keeps `setup-python` on GitHub. It executes the version check with supported and unsupported version tuples.

The adapter tests use a temporary stub for `scripts/pi_update.py`. They cover no update, a new core version, a module-only update, failed stages, breaking notes, and child environment filtering. A fake API checks both manifest pins, the validation anchor, duplicate requests, branch races and stale revisions. No test writes to a Git server.

These tests do not prove that a Gitea runner executes the workflow. They do not qualify a real Pi version. Run the manual workflow once and inspect its artifacts before relying on the schedule.

Portable publication stays a separate, manually approved operation. See [publishing](publishing.md).
