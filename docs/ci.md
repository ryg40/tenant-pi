# Continuous integration

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Continuous integration (CI) runs checks after a change. These workflows check the kit and propose Pi updates. They never publish a portable snapshot.

## Workflows

| File | Trigger | Result |
| --- | --- | --- |
| `.gitea/workflows/checks.yml` | Each push and pull request | Runs the five offline commands below. |
| `.github/workflows/checks.yml` | Each push and pull request | Runs the same commands without secrets or package installs. |
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

### GitHub runs and cost

On GitHub, `.github/workflows/checks.yml` runs one job on a GitHub-hosted runner for each push and pull request. It has no branch filter: each branch that holds the file can start a run.

In a private repository, the job uses the Actions minutes of the account. The included minutes and charges depend on the account plan. Check the Actions usage of the account before you enable the workflow.

A branch update with an open pull request can start both a push run and a pull request run. These two runs can use minutes twice.

The Gitea workflows run only on a registered runner of the Gitea server. They use no GitHub minutes.

### Turn the GitHub workflow off

1. Open Actions in the repository on GitHub.
2. Select the workflow "Offline checks".
3. Choose "Disable workflow" from its menu.

Or remove `.github/workflows/checks.yml` from each branch where you do not want a run.

## Runner requirements

Use an isolated, disposable Linux job container. Do not mount a live Pi profile, a provider credential directory, or the Docker socket into it.

| Requirement | Offline checks | Update jobs |
| --- | --- | --- |
| Runner label | `ubuntu-latest` | `ubuntu-latest` |
| Python | Python 3.11, set by `setup-python` | Python 3.11, set by `setup-python` |
| Node | Node 20 or later for JavaScript actions | Node 24.21.0 and its npm, set by `setup-node` |
| Other tools | Git and Bash | Git, Bash and the package test prerequisites |
| Network | Checkout and language/action setup only | Also the npm registry, package archives and the Gitea API |
| Credentials | Checkout token only | Checkout token; preflight and request steps also need `PI_UPDATE_TOKEN` |

The label is a requirement, not a claim that a registered runner has it. Check the runner label and container image before enabling scheduled runs.

The offline commands use only the Python standard library. They install no package and make no model request. The public job uploads no artifact.

The update adapter starts `scripts/pi_update.py` with a new temporary `HOME` and a short environment allowlist. It forwards no job token or provider key. Qualification and notes use a temporary work directory outside the checkout. The adapter copies only step logs into the artifact directory. It removes that work directory after the stage. The update command must also isolate each Pi process. It installs Pi under its work directory, not globally.

The updater compares `<temporary HOME>/.pi/agent`, which normally does not exist; it does not watch your live Pi directory. Its `isolation` report is informational; the adapter does not pass `--strict-baseline`.

Warning: npm packages can execute install scripts. Use a disposable runner without provider credentials, even when the command clears its child environment.

## Update stages

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

## Gitea token

Set one repository Actions secret named `PI_UPDATE_TOKEN`. Use a dedicated account and a repository-scoped personal access token. Give it only the repository permissions required to read files, create a branch, commit files and create a pull request. On servers with scoped tokens, this requires `write:repository` and access to this repository.

Only the preflight and request steps receive this secret. Detection, qualification and notes do not receive it. Preflight uses the token for GET requests only. The API client requires an `https` server URL and refuses redirects. The workflow takes this URL from `gitea.server_url`; an `http` server fails with `api_url`. It prints static errors, not API response bodies or token values.

The runner supplies a separate temporary job token for checkout and artifacts. Gitea versions differ in how they apply `permissions`. The workflow does not rely on that field to grant API writes. The named token makes the write requirement explicit. Never use a provider API key for this secret.

Warning: a user who can change a trusted workflow can use its repository secrets. Protect the default branch and review workflow changes.

## Gitea differences

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

## Run by hand

Run the offline commands from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py
```

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

## Turn the schedule off

1. Remove the `schedule` member from `on` in `.gitea/workflows/pi-update.yml`.
2. Commit that change to the default branch.
3. Check that the manual trigger remains available.

Removing the secret makes preflight fail and skips qualification. It does not stop detection. Disabling Actions for the whole repository also stops the offline checks.

## Evidence and limits

`tests/test_ci_workflows.py` parses all workflow files as JSON-form YAML, rejects duplicate keys and checks command paths, action pins, triggers, dependencies and secret placement.

The adapter tests use a temporary stub for `scripts/pi_update.py`. They cover no update, a new core version, a module-only update, failed stages, breaking notes, and child environment filtering. A fake API checks both manifest pins, the validation anchor, duplicate requests, branch races and stale revisions. No test writes to a Git server.

These tests do not prove that a Gitea runner executes the workflow. They do not qualify a real Pi version. Run the manual workflow once and inspect its artifacts before relying on the schedule.

Portable publication stays a separate, manually approved operation. See [publishing](publishing.md).
