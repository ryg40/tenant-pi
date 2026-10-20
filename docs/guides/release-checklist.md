# Release checklist

A portable release is a snapshot of the reviewed publish set on the branch `portable`. This checklist lists the gates before a snapshot and the steps that publish it. A passed gate is a fact for this release only. It is not a claim about a later release.

Record each gate as passed, failed, blocked or not run. Never write "passed" for a gate that did not run.
For a pin change followed by a snapshot, use the [pin move and release guide](pin-move-release.md).
It records a maintainer-approved fast track with gate 6 not run, not full release qualification.

## Release classes

The publisher accepts --class patch or --class full. The default is patch.
It records the class in the notes header and as `class: patch` or `class: full` in the annotated tag.

- A patch release records the check-set stamp and the snapshot-range pre-push lines.
- A patch release carries forward gates 6 to 8 from the last full tag.
- A full release records every gate, including `scripts/scan.sh all` and the clean Linux core trial.
- Use full at each pin move or on request. A new component also needs a full release.

Publish at most one patch release per day; it bundles every ticket merged since the last tag.
This is a maintainer policy, not a command-line limit.
A full-class tag records the checks; its class alone does not mean that every gate passed.
A legacy portable tag without a `class:` line counts as full.
The publisher finds the last full tag in newest-first tag order.

## Combined offline check

Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py` for the parallel unit suite, publish checks and whitespace check.
The final line is `check: passed` only when every check succeeds.
Use `python3 scripts/check.py --tier fast` for development feedback; it skips measured slow tests and gives no release qualification.
A clean full run records a local Git-tree stamp. Check it with `python3 scripts/check.py --stamp-status`.
See [offline checks and local stamps](../publishing.md#offline-checks-and-local-stamps) for the fields and matching rules.
The publisher reads a matching stamp instead of repeating the check set.
A missing or stale stamp triggers a full check set. Live-trial requirements remain unchanged.

## Gates

| Gate | Command or evidence | Required |
| --- | --- | --- |
| 1. The check set (replaces gates 1 to 4) | `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check.py` ends with `check: passed`; record the clean-tree stamp | Yes |
| 5. Scanner | Both classes: record the snapshot-range pre-push lines at level `fail`. Full only: also run `scripts/scan.sh all` and require exit 0. | Yes |
| 6. Clean Linux core trial | A core-only profile on a clean Linux user: INSTALL.md Stages 0 to 9, with Stage 9 checks 1, 2 and 4 recorded. Patch carries forward the last full record. | Full |
| 7. Optional live services | Each optional module, the gateway and each MCP server: passed, failed, blocked or not run. Patch carries forward the last full record. | Report only |
| 8. Compose seat | Record `docker compose config`, `docker compose build` and the [qualification table](compose-seat.md#qualification) check. Patch carries forward the last full record. | Report only |

Gate 1 replaces the former gates 1 to 4 with one check set and one stamp record.
Gates 5 to 8 keep their numbers.
The unit suite includes the examples, sample overlay, builder determinism tests and [documentation check](#documentation-check).
The test `DocCheckRepoTests` of `tests/test_doc_check.py` checks the publish set documentation. A finding fails the unit tests.
Run the tests with `unittest`, not `pytest`: see [troubleshooting](troubleshooting.md#the-publish-check-fails-after-pytest).

Gate 1 also checks the text of `coordinator-skills` and `knowledge-skills` under `packages/tenantext/skills/`.
The test `tests/test_skill_invariants.py` reads their Markdown and the label table of [the issue tracker document](../agents/issue-tracker.md).
A finding fails the unit tests.

A pin move changes two tracked files: `config/manifest.json` and the reviewed core anchor in `scripts/validate.py`.
Use `scripts/pi_update.py` function `pin_contents` for both edits.
`runtime.piVersion` is the tested version. `runtime.piAcceptedRange` is the accepted range.
A changed stable pin automatically sets `>=<new version> <next minor>` in the same manifest edit.
The range therefore moves with the pin, including a move to another minor or major line.
A same-pin call preserves a separately reviewed range. The validator requires the tested version inside the range.
Replace `<new version>` with the approved version. Run this block from the kit root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 - <<'EOF'
from pathlib import Path
from scripts.pi_update import pin_contents

contents = pin_contents(Path("config/manifest.json").read_text(encoding="utf-8"),
                        Path("scripts/validate.py").read_text(encoding="utf-8"), "<new version>")
for name, content in contents.items():
    Path(name).write_text(content, encoding="utf-8")
EOF
```

Warning: this block replaces both tracked files. Keep a copy of any uncommitted edits before you run it.

To use a separate reviewed range, pass `accepted_range="<reviewed range>"` to `pin_contents`.
This still changes only those two files. Review the range before accepting the candidate.
Bounds use stable versions. A prerelease pin needs an explicit range with a lower stable bound before its numeric version.
Otherwise the automatic lower bound excludes that prerelease and the editor refuses the move.
See [the prerelease rule](../check-runtime.md#comparison).

Tests read the current pin from the manifest. Guides point to `runtime.piVersion` instead of copying its value.
Historical observations and package-specific dependency pins stay fixed; review them before qualifying a new release.
Run the offline gates on the candidate copy before accepting the move.

The `questions` component has its own pin: the exact version 2.13.9 of `@juicesharp/rpiv-ask-user-question`. It is not a version range.
The source of that version was not reviewed.
`scripts/pi_update.py detect` exits 10 while the registry has a newer version.
This continues until the maintainer of the release reviews the newer version and moves the pin.

### Gate 5: the scan record

For full, run `scripts/scan.sh all` and record its result and level. The publisher leaves this line as a placeholder.
For patch, record the pre-push lines only. Do not run `scripts/scan.sh all` for a patch release.
Without a previous full portable tag, make a full release first.
The pre-push hook scans the union of the branch and tag commit sets once.
Use its `pre-push: result pass; range <revisions>; level fail` line as the snapshot-range record.
The publisher prints this line from the push output and copies it into the notes.
A failed push keeps its failure line. A missing hook line is not a passed scan.
Do not run a separate manual snapshot-range scan.
A build with `--no-push` has no pre-push record; mark the snapshot-range check as not run until the approved push.

### Gate 6: the clean Linux core trial

- Use a Linux user with no Pi profile of its own, no kit credentials and no optional services.
- Follow [INSTALL.md](../../INSTALL.md) with a core-only overlay.
- Record the Pi version, the Node version and the Python version from `check-runtime`.
- Record the `check-baseline` result for `~/.pi/agent` of that user (INSTALL.md Stage 9 check 4). For a user with no Pi profile the result is `unchanged`, with `was` and `now` both `absent`.
- A model reply (Stage 9 check 3) needs a credential. Report it separately as passed, failed, blocked or not run.

Not verified: this gate with the kit pin in `config/manifest.json`, key `runtime.piVersion`.

### Gate 7: optional live services are never implied

A release note names each optional module, route and service with its result. These are examples of honest lines:

- `wiki`: not run.
- Gateway route: blocked, no key on the test client.
- `mcp`, server `example`: not run.

Do not write "all modules work" when only the core trial ran. Do not describe a documentation review or an offline `generate` as a live installation.

### Gate 8: the Compose seat

- This gate is a report, like gate 7. It does not stop a snapshot. Record the `config` check, the build and the table check, each as passed, failed or not run.
- Set `KIT_COMMIT` first: `export KIT_COMMIT="$(git rev-parse --short HEAD)"`. Run `docker compose config` from the kit root, with a `seat.env` and a `compose.env` in a private directory. It is the short offline check. Use the options of [the build and start commands](compose-seat.md#step-2-build-and-start).
- Keep the key line of that `compose.env` empty: `docker compose config` prints each value of the file.
- `docker compose build` needs Docker and the network. A release without it records `build: not run`.
- The build runs the fast tier of the kit checks inside the image. A build that passes is not a trial of a container. The evidence of a container is in the trial records.
- Read each row of the qualification table. A row is `not qualified` unless an accepted trial record covers each item of the checklist of the guide.

## Platforms that are not qualified

These platforms are not qualified in this release. A guide may give an adaptation for them, but marks it unqualified.

| Platform | Status | Evidence that would change the status |
| --- | --- | --- |
| [macOS on Apple silicon](macos.md) | Not qualified | Gate 6 on a clean macOS user with Homebrew or nvm Node, plus the tests and the publish check on that host. |
| Windows, also WSL | Not qualified | Gate 6 under WSL or native Windows; the kit uses POSIX paths and modes, so a native Windows run also needs a code review. |
| Browser-hosted Pi | Not qualified | Gate 6 with Pi started from a browser terminal, with the launch environment checks of [INSTALL.md](../../INSTALL.md#shells-that-do-not-inherit-your-variables). |
| Pi inside Herdr | Not qualified | Gate 6 with Pi started in a Herdr pane, plus the `herdr` component loaded and used once. |
| The `questions` component | Not qualified | An interactive session of a generated profile that loads the extension and shows one question dialog, plus the plain-text fallback in a session without it. |
| A temporary Herdr session | Not qualified | A named test session that starts, shows its state, stops and is deleted, with no model request, on a host that the maintainer of the release approves. |
| [The Compose seat](compose-seat.md), each runtime | Not qualified | A trial record for the runtime that covers each item of [the checklist of the guide](compose-seat.md#what-a-trial-must-cover). |
| Install on a remote Linux host over SSH | Not qualified | The lines of `remote-plan` run on a disposable Linux host that the maintainer of the release approves, with the identity and ownership checks recorded. |

Each run needs a record with the exact commands, the versions, and each check as passed, failed, blocked or not run. The maintainer of the release accepts the record before the status changes.

## Publish steps

These steps come from [publishing](../publishing.md).

1. Commit every change on your source branch. The publish command refuses a dirty working tree.
2. Run the check set once on the clean tree. For full, also run `scripts/scan.sh all` and keep its result.
3. Build the snapshot without a push. Select the class; this example builds a patch:

   ```sh
   python3 scripts/publish_portable.py --no-push --class patch
   ```

   The publisher prints the matching stamp without repeating the check set.
   It writes notes to a new system temporary file and prints `notes: <path>`.
   The --notes option selects another path. Keep the notes outside the checkout.

4. Inspect the snapshot: `git show portable --stat`. Check each new file against the [publish set rules](#add-a-file-to-the-publish-set).
5. Run the publisher once to push, only after the maintainer approves the release:

   ```sh
   python3 scripts/publish_portable.py --class patch
   ```

   Use the same class on both runs. The second run reads the same stamp and does not repeat the check set.
   It writes a new notes file with the push record. Use that file for the release entry.
   A repeat build preserves the original changes list. It refuses a different source or class for an unchanged snapshot.
   A changed tree or client needs a new full check set and snapshot review before approval.

   The command pushes two refs by name: the branch `portable` to the destination named by `--remote` and `--remote-branch`, and the tag `portable/<yyyymmdd>-<source sha>` of this snapshot. It pushes no other tag and no other branch. When the snapshot did not change, for example after a build with `--no-push`, it pushes the snapshot tag that already points at the snapshot commit. The commit and the tag carry the neutral identity `tenant-pi portable`.

6. Wait for the CI run of the snapshot on GitHub: the workflow "Offline checks" ([continuous integration](../publishing.md#continuous-integration)). Both matrix jobs, Linux and macOS, must pass before you create the release entry. A failed job stops the release entry.
7. Review [the release notes](#release-notes) from the publisher after the last gate. Fill the placeholders and publish the entry on the tag. The publisher does not create the release entry. Keep the tested snapshot unchanged.
8. Update the documentation site of the kit, if you maintain one: set the new tag in its version file, run its capture script, and update the pages that changed. (The maintainers' site is tenant-docs; its `README.md` section `New release of a project` has the steps.)

Warning: `--force` can replace an existing remote snapshot chain, but it does not remove earlier tags.

Use a new, empty repository for a new-root publication; see [publishing](../publishing.md#a-new-history).

## Release notes

The publication service is the Git host of the published repository, for example GitHub.
The publisher writes a draft notes file outside the snapshot. The maintainer reviews it after the last gate.
The maintainer creates the release entry on the tag. The publisher does not create that entry.
The snapshot holds no notes file, because a later file changes the tested tree.

Both classes include the tag, source commit, snapshot commit, kind, Pi pin, changes and known defects.
Each changes line comes from a merge subject since the source commit of the previous portable tag.
The publisher copies the gate 1 lines from the matching stamp, including its client and skipped count.
It records gate 5 from the push output, or `not run (no push)` with --no-push.
The generated known-defects line is `<none recorded>`. Review it before publication.

Full notes also hold:

- The tag, the source commit and the snapshot commit.
- The Pi pin (`runtime.piVersion`) and the accepted range (`runtime.piAcceptedRange`).
- The qualification: full qualification, or a fast track with gate 6 not run.
- The update block for clients, before the gates.
- The check-set stamp from the `publish_portable.py` output: tree hash, time, result lines, client and skipped count.
- Gates 1, 5 and 6 with one word: passed, failed, blocked or not run. Include each gate's record.
- The stamp's public reader result. The unit result includes the documentation check.
- Gate 7 and gate 8 with one word for each part. These two gates have no word for the whole gate.
- For gate 7, one line for each optional module, route and service, as [the section of gate 7](#gate-7-optional-live-services-are-never-implied) says.
- The changes since the previous tag, as a short list.
- A link to the section [Platforms that are not qualified](#platforms-that-are-not-qualified) of this checklist at the tag. Write the full URL: the release entry is outside the tree.
- Each known defect and each open gap.

Never write "passed" for a gate that did not run. Do not write "all modules work" when only the core trial ran.

Check the notes against [the public reader rules](../publishing.md#public-reader-rules) before you create the entry. The publish check does not read them, because they are not in the publish set.

Warning: a list of changes that you copy from commit messages can hold references to a private tracker. Check the list against the public reader rules.

Warning: a release entry is public when the repository is public.

The skipped-test count depends on the client. Record the count from the check result, not from this guide.
Record the client alongside the actual count, rather than copying one count to another client.
Take the stamp fields for both templates from the `publish_portable.py` output.
`check.py --stamp-status` prints only the stamp status line, not those fields.

Replace each placeholder in angle brackets. Do not replace an unrun gate with a passed result.
In both templates, the update block for clients comes right after the header lines, before the gates.
The publisher writes the whole block from the two source commits.
The placeholders `<overlay>` and `<private dir>` of its `Run:` line stay for the client.
Without a previous tag, the block is `## Update` with the line `- First release: no update data.`
The release entry is Markdown: each list item is one line on the release page.

### Patch notes template

The publisher fills this template. Gates 6 to 8 refer to the last full tag, not the last patch tag.

```markdown
# Portable release: patch

- Tag: portable/<yyyymmdd>-<source sha>
- Source commit: <source sha>
- Snapshot commit: <snapshot sha>
- Kind of release: patch release
- Pi pin (runtime.piVersion): <version>

## Update from <previous tag>

- <"No new candidate expected." or "A new candidate may be needed: <reasons>.">
- Pi pin: <"unchanged (<version>)" or "<old> -> <new>; install the new Pi first.">
- <one line for each changed range: accepted range, Node range, Python range>
- <"npm ci --ignore-scripts needed in: <packages>", "npm run build needed in: packages/promptr", or "No package line needed.">
- Files that can change a generated profile: <paths and "removed: <path>" items, or none>
- Run: `python3 scripts/tenant_pi.py update --overlay <overlay> --local-dir <private dir>`
- A clean clone at this tag needs no test run.

## Gates

1. The check set (stamp record)
   - tree: <tree from the stamp>
   - when: <when from the stamp>
   - client: <client from the stamp>
   - skipped: <skipped from the stamp>
   - resultLines:
   - <every resultLines entry, unchanged>
5. Scanner
   - Snapshot range: <pre-push result line, or not run (no push)>
Gates 6-8: unchanged from <last full tag>

## Changes since <previous tag>

- <one merge subject per line, checked against the public reader rules>

## Known defects

<none recorded>
```

### Full notes template

The publisher fills the identity, pin, update block, stamp, changes and snapshot-range lines.
The maintainer fills the other records. The `scan.sh all` line remains a placeholder until that scan runs.

```markdown
# Portable release: full

- Tag: portable/<yyyymmdd>-<source sha>
- Source commit: <source sha>
- Snapshot commit: <snapshot sha>
- Pi pin (runtime.piVersion): <version>
- Accepted range (runtime.piAcceptedRange): <range>
- Kind of release: full release
- Qualification: <full qualification, or fast track: gate 6 not run, approved by the maintainer>

## Update from <previous tag>

- <"No new candidate expected." or "A new candidate may be needed: <reasons>.">
- Pi pin: <"unchanged (<version>)" or "<old> -> <new>; install the new Pi first.">
- <one line for each changed range: accepted range, Node range, Python range>
- <"npm ci --ignore-scripts needed in: <packages>", "npm run build needed in: packages/promptr", or "No package line needed.">
- Files that can change a generated profile: <paths and "removed: <path>" items, or none>
- Run: `python3 scripts/tenant_pi.py update --overlay <overlay> --local-dir <private dir>`
- A clean clone at this tag needs no test run.

## Gates

1. The check set (stamp record)
   - tree: <tree from the stamp>
   - when: <when from the stamp>
   - client: <client from the stamp>
   - skipped: <skipped from the stamp>
   - resultLines:
   - <every resultLines entry, unchanged>
5. Scanner
   - Snapshot range: <pre-push result line, or not run (no push)>
   - scan.sh all: <passed, failed, blocked or not run> - <result line with the level>
6. Clean Linux core trial: <passed, failed, blocked or not run> - <result line>
7. Optional live services (one line for each, no total result)
   - <module, route or service>: <passed, failed, blocked or not run> - <result line>
8. Compose seat (no total result): config <passed, failed or not run>, build <passed, failed or not run>, table check <passed, failed or not run>

## Changes since <previous tag>

- <one merge subject per line, checked against the public reader rules>

Platforms that are not qualified: <full URL of docs/guides/release-checklist.md at the tag>#platforms-that-are-not-qualified

## Known defects

<none recorded>

## Open gaps

- <gap, or none known>
```

## Add a file to the publish set

A new tracked file under `scripts/`, `tests/` or `docs/` enters through `PUBLISH_DIRS` unless `scripts/dev-only-files.txt` excludes it.
Package directories also have rules, with technical exclusions.
`PUBLISH` in `scripts/publish_check.py` keeps explicit entries for root files, workflow files, `config/`, selected package files, `extensions/`, `deploy/` and the install skill.
Files outside directory rules need an explicit entry after review.
For a private copy, the optional deny list names reviewed files or directory prefixes that must not publish.
A portable copy needs no list.
A file outside the publish rules and deny list fails with `unreviewed_file: repository inventory`.
Review each new file for secrets and host values before committing it.

The publish check also applies [the public reader rules](../publishing.md#public-reader-rules): no reference to a private tracker, no machine path, no dated record of one host and no value of a deny list. `python3 scripts/publish_check.py --public` lists each finding.

## Documentation check

`scripts/doc_check.py` selects explicit Markdown entries from `PUBLISH` and Markdown files under `docs/`, including subdirectories.
It checks only files that `published()` accepts, so denied docs are omitted.
It uses the Python 3.11 standard library, runs offline, starts no process and writes nothing.

The unit tests of gate 1 run the same check, so a release needs no separate command. Run the script directly to see the list of findings:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py
```

It prints `doc check valid: <n> files, <n> links, <n> json blocks, <n> actions (offline text checks only)` and exits with 0. Else it prints one line for each finding, sorted, then `doc check failed: <n> findings`, and exits with 1. A finding is `rule: path:line`. It never holds text of the file.

| Rule | Meaning |
| --- | --- |
| `link_missing` | A relative link names a file that does not exist. |
| `link_outside` | A relative link leaves the repository. |
| `link_unpublished` | A link names a file outside the publish set. A portable snapshot does not hold it. `DEV_ONLY_TARGETS` in `scripts/doc_check.py` can name an optional private-copy target that is permitted; the list is empty. |
| `anchor_missing` | A `#anchor` matches no heading of the target file. The anchor form is the GitHub heading form. |
| `json_example` | A fenced `json` block is not one JSON document and not JSON Lines. |
| `cli_action` | `tenant_pi.py <action>` names an action that the parser does not have. |
| `cli_flag` | A flag after `tenant_pi.py <action>` is not an option of that action. In `INSTALL.md`, the guides and `README.md`, a code span that holds only a flag must be a kit option or a reviewed flag of another program. |
| `env_name` | In `INSTALL.md`, the guides and `README.md`, a `TENANTEXT_*`, `PI_*` or `WIKI_*` name is not in the manifest and not a launch-line name. |
| `action_unguided` | An action of the parser is not named in `INSTALL.md` or a guide under `docs/guides/`. |
| `doc_missing`, `doc_text` | A selected Markdown file is absent, is a link, or is not UTF-8. |

The check reads the parser of `scripts/tenant_pi.py` in the same process: it imports the module and stops `main` at `parse_args`. So the check follows each change of the CLI.

Limits:

- The package documents under `packages/` are not checked. They have their own test suites.
- A flag in prose outside a code span is not checked.
- The check proves that a link resolves and that a command has a valid shape. It does not prove that a command works.
