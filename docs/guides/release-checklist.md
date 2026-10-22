# Release checklist

A portable release is a snapshot of the reviewed publish set on the branch `portable`. This checklist lists the gates before a snapshot and the steps that publish it. A passed gate is a fact for this release only. It is not a claim about a later release.

Record each gate as passed, failed, blocked or not run. Never write "passed" for a gate that did not run.
For a pin move followed by a snapshot, also follow [the release after a pin move](#release-after-a-pin-move).

## Release classes

The `--class` option of `scripts/publish_portable.py` selects `patch` or `full`. The class is in the notes header and in the annotated tag.

- A patch release records the check-set stamp and the snapshot-range pre-push lines.
- A patch release carries forward gates 6 and 7 from the last full tag.
- A full release records every gate, including `scripts/scan.sh all` and the clean Linux core trial.
- Use full at each pin move or on request. A new component also needs a full release.

Publish at most one patch release per day; it bundles every change merged since the last tag.
This is a maintainer policy, not a command-line limit.
A full-class tag records the checks; its class alone does not mean that every gate passed.
A legacy portable tag without a `class:` line counts as full.

## Combined offline check

`python3 scripts/check.py --help` states which tests a run selects.

- The everyday command is `python3 scripts/check.py --tier fast`. It runs the tests of the changed files and gives no release qualification.
- The full check set is `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py --all`. CI runs the same command. The final line is `check: passed` only when every part succeeds.
- A run of everything on a clean tree, with no skipped part, records a local stamp. Without Betterleaks on `PATH` the scan part is skipped, so the release host needs Betterleaks. `python3 scripts/check.py --stamp-status` checks the stamp. The publisher reuses a matching stamp; see [local stamps](../publishing.md#offline-checks-and-local-stamps).
- A package suite needs Node, the `node_modules` of the package and, for `packages/tenantext`, the Pi links. See [the package tests](../packages.md#tests).
- The publish rules of `scripts/publish_check.py` run when the publisher cuts a snapshot, not in this check.

## Gates

| Gate | Command or evidence | Required |
| --- | --- | --- |
| 1. The check set (replaces gates 1 to 4) | `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py --all` ends with `check: passed`; record the clean-tree stamp | Yes |
| 5. Scanner | Both classes: record the snapshot-range pre-push lines at level `fail`. Full only: also run `scripts/scan.sh all` and require exit 0. | Yes |
| 6. Clean Linux core trial | A core install on a clean Linux user: each step of INSTALL.md, with the first start recorded. Patch carries forward the last full record. | Full |
| 7. Optional live services | Each optional module, the gateway and each MCP server: passed, failed, blocked or not run. Patch carries forward the last full record. | Report only |

Gate 1 replaces the former gates 1 to 4 with one check set and one stamp record.
Gates 5 to 7 keep their numbers.
The unit suite of gate 1 includes [the documentation check](troubleshooting.md#the-documentation-check-fails) and the text checks of the coordinator and knowledge skills against [the issue tracker document](../agents/issue-tracker.md).
Run the tests with `unittest`, not `pytest`: see [troubleshooting](troubleshooting.md#the-publish-check-fails-after-pytest).

### Gate 5: the scan record

For full, run `scripts/scan.sh all` and record its result and level. The publisher leaves this line as a placeholder.
For patch, record the pre-push lines only. Do not run `scripts/scan.sh all` for a patch release.
Without a previous full portable tag, make a full release first.
The pre-push hook prints one `pre-push: result` line for the commits of the push; see [the range of a push](../secret-handling.md#the-range-of-a-push).
The publisher copies this line from the push output into the notes.
A failed push keeps its failure line. A missing hook line is not a passed scan. An empty range is not a scan of a new commit.
Do not run a separate manual snapshot-range scan.
A build with `--no-push` has no pre-push record; mark the snapshot-range check as not run until the approved push.

### Gate 6: the clean Linux core trial

- Use a Linux user with no Pi profile of its own, no kit credentials and no optional services.
- Follow [INSTALL.md](../../INSTALL.md) with the core install and no optional module.
- Record the Pi version, the Node version and the Python version from `scripts/check_runtime.py`.
- Record that `~/.pi/agent` of that user is absent after the first start, or unchanged when it existed before.
- A model reply needs a credential. Report it separately as passed, failed, blocked or not run.

Not verified: this gate with the kit pin in `config/manifest.json`, key `runtime.piVersion`.

### Gate 7: optional live services are never implied

A release note names each optional module, route and service with its result. These are examples of honest lines:

- `wiki`: not run.
- Gateway route: blocked, no key on the test client.
- `mcp`, server `example`: not run.

Do not write "all modules work" when only the core trial ran. Do not describe a documentation review or an offline qualification as a live installation.

## Platforms that are not qualified

These platforms are not qualified in this release. A guide may give an adaptation for them, but marks it unqualified.

| Platform | Status | Evidence that would change the status |
| --- | --- | --- |
| [macOS on Apple silicon](macos.md) | Not qualified | Gate 6 on a clean macOS user with Homebrew or nvm Node, plus the tests and the publish check on that host. |
| Windows, also WSL | Not qualified | Gate 6 under WSL or native Windows; the kit uses POSIX paths and modes, so a native Windows run also needs a code review. |
| Browser-hosted Pi | Not qualified | Gate 6 with Pi started from a browser terminal, with the environment checks of [the first start](../../INSTALL.md#first-start). |
| Pi inside Herdr | Not qualified | Gate 6 with Pi started in a Herdr pane, plus the `herdr` component loaded and used once. |
| The `questions` component | Not qualified | An interactive session of a profile of the kit that loads the extension and shows one question dialog, plus the plain-text fallback in a session without it. |
| A temporary Herdr session | Not qualified | A named test session that starts, shows its state, stops and is deleted, with no model request, on a host that the maintainer of the release approves. |
| Install on a remote Linux host over SSH | Not qualified | The install steps run over SSH on a disposable Linux host that the maintainer of the release approves, with the identity and ownership checks recorded. |

Each run needs a record with the exact commands, the versions, and each check as passed, failed, blocked or not run. The maintainer of the release accepts the record before the status changes.

## Publish steps

[Publishing](../publishing.md) explains the publisher. `python3 scripts/publish_portable.py --help` lists its options.

1. Commit every change on your source branch. The publish command refuses a dirty working tree.
2. Run the check set once on the clean tree. For full, also run `scripts/scan.sh all` and keep its result.
3. Build the snapshot without a push. Select the class; this example builds a patch:

   ```sh
   python3 scripts/publish_portable.py --no-push --class patch
   ```

   The publisher prints the matching stamp without repeating the check set. It prints the path of the draft notes, `notes: <path>`. Keep the notes outside the checkout.

4. Inspect the snapshot: `git show portable --stat`. Check each new file against the [publish set rules](../publishing.md#adding-a-file-to-the-portable-set) and [the public reader rules](../publishing.md#public-reader-rules). Reviewers read each added file as readers without access to the private development repository: names, paths, tracker references, service choices, historical claims, licenses and provenance, not only scanner matches.
5. Run the publisher once to push, only after the maintainer approves the release:

   ```sh
   python3 scripts/publish_portable.py --class patch
   ```

   Use the same class on both runs. The second run reads the same stamp and does not repeat the check set.
   It writes a new notes file with the push record. Use that file for the release entry.
   A changed tree or client needs a new full check set and snapshot review before approval.
   The publisher pushes only the branch `portable` and the tag of this snapshot. When you also keep the snapshot on the development remote, push the same branch and tag there by name. Never use `git push --follow-tags`.
   Then check with `git ls-remote` that each remote resolves the tag to the snapshot commit. Check that the visibility of the publication repository matches the approved visibility; portable content does not imply a public repository.

6. Wait for the CI run of the snapshot on GitHub: the workflow "Offline checks" ([continuous integration](../publishing.md#continuous-integration)). Both matrix jobs, Linux and macOS, must pass before you create the release entry. A failed job stops the release entry.
7. Review [the release notes](#release-notes) from the publisher after the last gate. Fill the placeholders and publish the entry on the tag. Keep the tested snapshot unchanged.
8. Update the documentation site of the kit, if you maintain one: set the new tag in its version file and update the pages that changed.

The public history only moves forward; see [publishing](../publishing.md#history).

## Release after a pin move

A pin move changes the runtime contract, so it needs the full class and `scripts/scan.sh all`. A fast track leaves gate 6 not run. It needs the approval of the maintainer, and it is not a fully qualified release.

1. Detect the candidate and read its notes with [the update checks](../pi-update.md). Record the effect of each entry on `install.sh`, the settings template, the extensions, the skills and the package APIs. Resolve each required migration first.
2. On a topic branch, move the pin with `pin`, then run `qualify` once. Qualification runs the full check set in the candidate copy, so do not repeat it in the worktree. Record each step with its exit code in the commit body. Compare an unexplained failure with the unchanged base, and name each accepted baseline failure.
3. Get an independent review of the pin diff and its evidence. Then merge it.
4. On the merged `main`, run `python3 scripts/check.py --stamp-status`, or the full check set once when the stamp is missing. When the check set fails, revert the merge and stop the release until a fix passes.
5. Run gate 5 with `scripts/scan.sh all`. A development result at level `warn` is not the snapshot result; the snapshot needs the pre-push record at level `fail`.
6. For a fast track, record gate 6 as not run and the qualification as `fast track: gate 6 not run, approved by the maintainer`. Record each part of gate 7.
7. Follow [the publish steps](#publish-steps) with `--class full`.

Pitfalls:

- A worktree can lack the Pi peer packages after `npm ci`. Qualification links its own copies to the candidate installation.
- A commit body must contain no machine path: the history scan reads commit messages, not only file content.
- After the release, reinstall each changed skill that a host uses with the installer in its folder under `packages/tenantext/skills/`, after approval of the local writes.

## Release notes

The publication service is the Git host of the published repository, for example GitHub.
The publisher writes a draft notes file outside the snapshot, with the template of the class. It fills the identity, the pin, the update block for clients, the stamp record, the snapshot-range line and the changes. The maintainer fills each other placeholder in angle brackets after the last gate: the qualification, `scan.sh all`, gates 6 and 7, the full URL of [the platforms that are not qualified](#platforms-that-are-not-qualified) at the tag, the known defects and the open gaps.
The snapshot holds no notes file, because a later file changes the tested tree.

- Never write "passed" for a gate that did not run. Do not write "all modules work" when only the core trial ran.
- The skipped-test count depends on the client. Record the count and the client from the check result, not from another client.
- Check the notes against [the public reader rules](../publishing.md#public-reader-rules) before you create the entry. The publish check does not read them, because they are not in the publish set.
- The release entry is Markdown: each list item is one line on the release page.

Warning: a list of changes that you copy from commit messages can hold references to a private tracker. Check the list against the public reader rules.

Only the maintainer of the release creates the entry, after approval of the notes and after the CI run passed. With GitHub, from the saved notes file:

```sh
gh release create '<tag>' --repo '<owner>/<repo>' --verify-tag --title '<tag>' --notes-file '<notes file>'
gh release view '<tag>' --repo '<owner>/<repo>' --json tagName,isDraft,url
```

`--verify-tag` stops the command when the remote repository does not have the tag. The view must print the tag, `isDraft` as `false`, and the URL of the entry.

Warning: a release entry is public when the repository is public.

Warning: the help of `gh release create` says that a published release locks its tag when the repository has release immutability on.

Not verified: the commands for a publication service other than GitHub.
