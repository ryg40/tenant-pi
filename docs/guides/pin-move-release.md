# Pi pin move and fast-track portable release

Use this guide to qualify a Pi version, move the kit pin, and publish a reviewed snapshot.
The first run moved Pi 1.0.3 to 1.0.4; these versions serve as the example.
`<pin>` means `runtime.piVersion` in `config/manifest.json`; replace `<new version>` with the candidate version.
Replace all angle-bracket placeholders before running commands from the kit root.

A fast track needs maintainer approval to leave gate 6 unrun; it is not a fully qualified release.
The [release checklist](release-checklist.md#gates) still requires the clean Linux core trial for full qualification.
The [update checks](../pi-update.md), [publisher](../publishing.md), and [runtime check](../check-runtime.md) define the underlying contracts.

## Preconditions

1. Confirm a clean development checkout on `main`, the intended remotes, and the previous snapshot.

   ```sh
   test "$(git branch --show-current)" = main
   test -z "$(git status --porcelain)"
   git remote -v
   PUBLICATION_REMOTE='<publication remote>'
   DEVELOPMENT_REMOTE='<development remote>'
   git rev-parse main portable
   ```

   Check that the selected remotes name your development repository and publication destination.
   Check that `portable` names the previous snapshot.

2. Run the four offline checks before starting the pin work.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
   ```

   Check every exit code and retain each last output line; stop on a failure.

3. List new files since the last snapshot for an independent public-reader review.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 -c 'import sys; sys.path.insert(0, "scripts"); from publish_check import publish_files, tracked_files; print("\n".join(publish_files(tracked_files())))' > /tmp/pi-publish-files
   git diff --name-only --diff-filter=A portable main | grep -Fx -f /tmp/pi-publish-files
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public
   ```

   Reviewers read every added publish-set file and its changed context as readers without access to the private development repository.
   The filter uses `PUBLISH`, `PUBLISH_DIRS`, and the reviewed exclusions; `grep` exits 1 when no added file belongs to the publish set.
   Review names, paths, tracker references, service choices, historical claims, licenses, and provenance, not just scanner matches.
   Divide the file list between reviewers without gaps; record coverage, findings, fixes, and verdicts in your release record.
   Repeat the review for files added by later merges.

4. Create a pin worktree and retain its base commit for review.

   ```sh
   BASE=$(git rev-parse main)
   git worktree add -b topic/pi-pin /tmp/pi-pin main
   cd /tmp/pi-pin
   ```

   Check that the worktree starts at `$BASE` and has no unrelated changes.

## Detect and read notes

1. Detect the candidate and save its JSON report.

   ```sh
   rc=0
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py detect > /tmp/pi-detect.json || rc=$?
   test "$rc" -eq 0 || test "$rc" -eq 10
   python3 -m json.tool /tmp/pi-detect.json
   ```

   Check `core.pinned`, `core.latest`, and `new`; exit 10 means a difference, not necessarily a newer version.
   Unpinned optional modules do not request a pin move.

2. Read the complete notes between the current pin and the candidate.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py notes --from "<pin>" --to "<new version>" --workdir /tmp/pi-notes > /tmp/pi-notes.json
   python3 -m json.tool /tmp/pi-notes.json
   ```

   Check every `entries` item and record its effect on generated profiles, the launcher, extensions, skills, and package APIs.
   `breaking: true` means an upstream `Breaking Changes` heading exists; false does not prove compatibility.
   Resolve any required migration before accepting the candidate.

## Qualify before editing

1. Run qualification outside the clone and outside the live agent directory.

   ```sh
   mkdir -p /tmp/pi-qualification
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version "<new version>" --workdir /tmp/pi-qualification > /tmp/pi-qualify.json
   python3 -m json.tool /tmp/pi-qualify.json
   ```

   Check `passed: true` and every ordered `steps` entry for `exitCode: 0`; read each failing step's `log` before continuing.
   The work directory needs an existing parent and cannot be a symlink, the clone, the live agent directory, or their ancestors.
   Qualification installs into a private run directory and edits only a candidate copy.
   It checks runtime versions, repository checks, package tests, generation, and one core-only loopback print reply.
   A failure blocks the move unless the proposed pin change itself fixes it and a fresh qualification proves that fix.

2. Inspect the isolation fields separately from the test result.

   ```sh
   python3 - <<'PY'
   import json
   report = json.load(open('/tmp/pi-qualify.json'))
   for key in ('passed', 'isolation', 'changedEntries', 'strictBaseline'):
       print(key, report.get(key))
   PY
   ```

   Check that the record preserves `isolation` rather than describing every passing qualification as unchanged.
   `changed_unattributed` means live-directory metadata changed; other active Pi sessions can cause drift, but the report cannot identify its cause.
   A passing qualification with this status does not prove content isolation.
   Use `qualify --strict-baseline` only when live-profile writes are quiescent; then baseline drift fails qualification.
   Process isolation is not an operating-system sandbox and proves neither interactive use nor optional live services.

## Move pins and measured facts

1. Apply the shared pin editor from the worktree root.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 - <<'EOF'
   from pathlib import Path
   from scripts.pi_update import pin_contents

   contents = pin_contents(Path("config/manifest.json").read_text(encoding="utf-8"),
                           Path("scripts/validate.py").read_text(encoding="utf-8"), "<new version>")
   for name, content in contents.items():
       Path(name).write_text(content, encoding="utf-8")
   EOF
   git diff -- config/manifest.json scripts/validate.py
   ```

   Check the tested version, core npm spec, validator anchor, and accepted range from the new pin to the next minor line.
   See the [pin move rule](release-checklist.md#gates) for separately reviewed ranges and prerelease pins.

   Warning: the pin editor replaces both tracked files; preserve unrelated edits before running it.

2. Move Promptr's two exact package pins and regenerate its lock file.

   ```sh
   (
     cd packages/promptr
     npm pkg set 'dependencies.@earendil-works/pi-tui=<new version>' 'devDependencies.@earendil-works/pi-coding-agent=<new version>'
     npm install
   )
   git diff -- packages/promptr/package.json packages/promptr/package-lock.json
   ```

   Check that both pins and the resolved lock entries use the candidate; do not hand-edit lock integrity values.

3. Search for current-pin claims and update their measured facts.

   ```sh
   git grep -n -F '<pin>' -- config scripts tests docs packages README.md INSTALL.md
   git diff --stat
   ```

   Check the pin commit's file inventory against this list, and preserve historical reviewed-release facts and fixed test fixtures.

   | Files | Review |
   | --- | --- |
   | `config/manifest.json`, `scripts/validate.py` | Core pin, range, core anchor, and Promptr readiness fact. |
   | `packages/promptr/package.json`, `packages/promptr/package-lock.json` | Exact package pins and resolved dependencies. |
   | `docs/packages.md`, `docs/workflow-modules.md` | Core and Promptr rows, package readiness, and version-scoped warnings. |
   | The foundation table of the development repository, if your copy has one | Core and Promptr rows. |
   | `scripts/workflow_modules.py`, `tests/test_workflow_modules.py` | Measured sentences and their exact assertions. |
   | `docs/check-runtime.md` | Version-probe evidence; preserve its explicitly defined historical reviewed release. |
   | A private chronology file, if your copy has one | Do not publish a dated machine record. |
   | `packages/promptr/README.md`, `packages/promptr/docs/sidebar-prototype.md`, `packages/promptr/src/doctor/doctor.mts` | Current compatibility statements and comments. |

   Add a changelog entry if the repository has a current changelog; do not rewrite archived history.
   Inspect changed key defaults against package bindings and documentation before changing any handler.
   Package tests are not proof of a live package load.

## Check, commit, review, and merge

1. Run the repository checks and the affected package checks in the pin worktree.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py
   (cd packages/promptr && npm run build && npm test && npm run typecheck && npm run smoke)
   (cd packages/tenantext && npm test && npm run typecheck)
   git diff --check
   ```

   Check each exit code and save each last output line; install dependencies only when missing, and never run installed smoke for qualification.
   If `npm ci` leaves optional Tenantext peers absent, link only the missing packages from the main checkout:

   ```sh
   MAIN_CHECKOUT='<absolute main checkout path>'
   mkdir -p packages/tenantext/node_modules/@earendil-works
   for package in pi-coding-agent pi-ai pi-tui pi-agent-core; do
     source="$MAIN_CHECKOUT/packages/tenantext/node_modules/@earendil-works/$package"
     target="packages/tenantext/node_modules/@earendil-works/$package"
     test -d "$source"
     if [ ! -e "$target" ] && [ ! -L "$target" ]; then
       ln -s "$source" "$target"
     fi
   done
   ```

   Check the linked versions; these links enable worktree tests but do not replace the isolated candidate qualification.
   Compare unexplained failures with the unchanged base and report them; do not silently waive a failed check.

2. Review the diff, stage only the pin files, and create one commit with the evidence in its body.

   ```sh
   git diff
   git add -- <reviewed pin files>
   scripts/scan.sh --level fail staged
   git commit
   scripts/scan.sh --level fail history main..HEAD
   ```

   Check that the body records detection, note titles and impact, qualification steps, isolation, check lines, decisions, and unproved behavior.
   Use a `pin: ` subject and the required co-author trailer; put no machine path or private value in the body.

3. Obtain an independent review of the pin diff and evidence before merging from the main checkout.

   ```sh
   git diff "$BASE"..topic/pi-pin
   cd <main checkout>
   test -z "$(git status --porcelain)"
   git switch main
   git merge --no-ff topic/pi-pin
   ```

   Check that the reviewer accepts the pin commit and that any conflict resolution preserves each reviewed change.
   Merge approved feature work before final gates, then merge the pin and public-reader fixes before snapshot construction.
   Repeat the checks on merged `main`; a branch pass does not prove the merge.

## Release gates and publication

Put this section's command blocks into one script outside the clone, such as `/tmp/release.sh`, with `set -euo pipefail` at its top.
Run it from the main checkout with `bash /tmp/release.sh /tmp/pi-release-evidence`; use a new evidence directory for each release.
Do not enable `set -e` in the interactive shell; a failed gate must stop the script, not close that shell.
After fixing a failure, rerun the script with the same evidence directory to read the saved release identity.
The commands match the release evidence, with explicit failure handling instead of output-only pipelines.

1. Save the prior snapshot and tag in the evidence directory before running any gate.

   ```sh
   set -euo pipefail
   PUBLICATION_REMOTE='<publication remote>'
   DEVELOPMENT_REMOTE='<development remote>'
   LOGDIR="${1:?Usage: bash release.sh <evidence directory>}"
   mkdir -p "$LOGDIR"
   if [ -f "$LOGDIR/release.env" ]; then
     source "$LOGDIR/release.env"
   else
     SRC=$(git rev-parse HEAD)
     OLD_PORTABLE=$(git rev-parse portable)
     TAG="portable/$(date -u +%Y%m%d)-${SRC:0:7}"
     printf 'SRC=%q\nOLD_PORTABLE=%q\nTAG=%q\n' "$SRC" "$OLD_PORTABLE" "$TAG" > "$LOGDIR/release.env"
   fi
   test "$(git branch --show-current)" = main
   test -z "$(git status --porcelain)"
   test "$(git rev-parse HEAD)" = "$SRC"
   ```

   Check that `$SRC` identifies the reviewed source; use only the trusted state file written by this script.
   The initial `$TAG` uses the publisher's UTC date and seven-character source ID.
   Never recompute `$OLD_PORTABLE` after a build moves `portable`; preserve `release.env` for every rerun.

2. Run gates 1 to 4 and the separate public-reader and documentation reports.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q 2>&1 | tee "$LOGDIR/unit.log"
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py | tee "$LOGDIR/examples.log"
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json | tee "$LOGDIR/overlay.log"
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py | tee "$LOGDIR/publish.log"
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py --public | tee "$LOGDIR/public.log"
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py | tee "$LOGDIR/docs.log"
   ```

   Check for `OK`, `examples valid`, structural validation, publish-set validation, zero public-reader findings, and a valid documentation report.

3. Run gate 5 on development history and record the fast-track gap explicitly.

   ```sh
   scripts/scan.sh all 2>&1 | tee "$LOGDIR/scan-all.log"
   printf '%s\n' 'gate 6 clean Linux core trial: not run (fast track)' | tee "$LOGDIR/gate-6.log"
   printf '%s\n' 'gate 7 optional live services: <one line for each module, route and service>' | tee "$LOGDIR/gate-7.log"
   printf '%s\n' 'gate 8 Compose seat: config not run, build not run, table check not run' | tee "$LOGDIR/gate-8.log"
   ```

   Check the scan exit code and its level; a development `level warn` result does not approve snapshot content.
   Record maintainer approval for the fast track, and record every gate 7 optional service separately as passed, failed, blocked, or not run.
   Replace the gate 7 placeholder in the script with one line for each optional module, route and service.
   Replace a `not run` part of gate 8 only with the result of the steps of [gate 8](release-checklist.md#gate-8-the-compose-seat).

4. Build without pushing and inspect the exact snapshot and tag.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_portable.py --no-push 2>&1 | tee "$LOGDIR/snapshot.log"
   git show portable --stat
   git tag --points-at portable --list 'portable/*'
   test "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse portable)"
   git ls-tree -r portable --name-only | wc -l
   ```

   Check the file inventory and saved tag against the publisher's output; never skip checks or choose an unrelated tag.
   If the UTC date changes before the build, correct only `TAG` in `release.env` to the printed tag before rerunning.
   For an unchanged snapshot, confirm its existing tag and save that `TAG` instead; keep `OLD_PORTABLE` unchanged.

5. Scan the new snapshot commit range at failure level.

   ```sh
   scripts/scan.sh --level fail history "$OLD_PORTABLE..portable" 2>&1 | tee "$LOGDIR/scan-snapshot.log"
   ```

   Check for zero secret, host-value, and policy findings; this history scan includes snapshot commit messages.
   An unchanged snapshot gives an empty range; do not claim it scanned a new commit.

6. Dry-run the public push, then push only the approved branch and snapshot tag to each remote.

   ```sh
   git push --dry-run "$PUBLICATION_REMOTE" refs/heads/portable:refs/heads/main refs/tags/$TAG:refs/tags/$TAG
   git push "$PUBLICATION_REMOTE" refs/heads/portable:refs/heads/main refs/tags/$TAG:refs/tags/$TAG
   git push "$DEVELOPMENT_REMOTE" refs/heads/portable:refs/heads/portable refs/tags/$TAG:refs/tags/$TAG
   ```

   Check that each push names only the intended snapshot branch and tag.
   Never use `git push --follow-tags` or push development `main` to the publication remote.

   Warning: a push publishes history; stop before the real pushes if approval, scan results, or remote destinations differ.

7. Check the remote refs, visibility, and public branch equality.

   ```sh
   git ls-remote "$PUBLICATION_REMOTE"
   git ls-remote "$DEVELOPMENT_REMOTE" refs/heads/portable "refs/tags/$TAG" "refs/tags/$TAG^{}"
   REMOTE_MAIN=$(git ls-remote "$PUBLICATION_REMOTE" refs/heads/main | cut -f1)
   SNAPSHOT=$(git rev-parse portable)
   printf 'remote main: %s\nlocal portable: %s\n' "$REMOTE_MAIN" "$SNAPSHOT"
   test "$REMOTE_MAIN" = "$SNAPSHOT"
   ```

   Check that only intended refs appear and both remotes resolve the tag to the snapshot.
   Open `<owner>/<repo>` on your publication service and check that its visibility matches the approved visibility.
   Use existing read-authorized access; never print or save credentials, and never change visibility as part of this check.
   A portable snapshot can remain private; portable content does not imply public repository visibility.

8. Collect the gate evidence for your release record.

   ```sh
   tail -n 1 "$LOGDIR"/*.log
   git rev-parse main portable "$TAG^{commit}"
   ```

   Check that the record contains source and snapshot IDs, tag, review coverage, gate statuses, scan levels, remote checks, and all gaps.
   Save it in your release record or your issue tracker, not the snapshot mirror.
   Do not report gate 6, interactive sessions, optional module loads, or native-provider authentication as proved by a loopback reply.

9. Write the release notes from the evidence, then create the release entry on the tag.

   ```sh
   LOGDIR='<evidence directory>'
   source "$LOGDIR/release.env" &&
     test -n "${TAG:-}" &&
     test -s "$LOGDIR/release-notes.md" &&
     gh release create "$TAG" --repo '<owner>/<repo>' --verify-tag --title "$TAG" --notes-file "$LOGDIR/release-notes.md" &&
     gh release view "$TAG" --repo '<owner>/<repo>' --json tagName,isDraft,url
   ```

   Each command runs only when the command before it succeeds.
   Run this block by hand after the script ends. You write the notes after the script, so the script cannot read them.
   Write `$LOGDIR/release-notes.md` first, with the content and the template of the [release checklist](release-checklist.md#release-notes).
   Check the notes against the [public reader rules](../publishing.md#public-reader-rules) before you create the entry. The publish check does not read the notes.
   Run `gh release create` only after the maintainer of the release approves the notes.
   The block uses the GitHub CLI. Replace `<owner>/<repo>` with the name of your publication repository.
   `--verify-tag` stops the command when the remote repository does not have the tag.
   Check that the view prints the saved tag, `isDraft` as `false`, and the URL of the entry.
   Do not add a notes file to the snapshot. A later file changes the tree that passed the gates.

   Warning: a release entry is public when the repository is public.

   Warning: the help of `gh release create` says that a published release locks its tag when the repository has release immutability on.

   Not verified: the commands for a publication service other than GitHub.

## After release

1. Reinstall changed installed skills from the durable main checkout, with separate approval for local writes.

   ```sh
   cd <main checkout>
   bash packages/tenantext/skills/herdr/install.sh
   bash packages/tenantext/skills/coordinator-skills/install.sh
   bash packages/tenantext/skills/knowledge-skills/install.sh
   ```

   Check installer output and skipped targets, then reload the consuming session or start a new one; run only installers for changed skills.

   Warning: the Herdr installer replaces its installed copy; preserve local customizations before running it.

2. Remove only clean task worktrees whose branch tips are ancestors of `main`.

   ```sh
   git worktree list
   BRANCH='<merged topic branch>'
   WORKTREE='<merged worktree path>'
   git merge-base --is-ancestor "$BRANCH" main
   test -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=all)"
   git worktree remove "$WORKTREE"
   git branch -d "$BRANCH"
   ```

   Check each branch separately, preserve ignored artifacts first, and stop if ancestry, cleanliness, or removal fails; never force cleanup.

3. Prepare a handoff or approved memory note.

   ```sh
   git rev-parse main portable "$TAG^{commit}"
   git status --short
   ```

   Check that the note records the release identity, evidence location, skipped gates, installed skill changes, remaining work, and next acceptance check.

## Pitfalls from the first run

1. A worktree can lack Pi peer packages after `npm ci`; link missing peers from the main checkout's `node_modules/@earendil-works/` and confirm their versions.
2. Tests can also fail at the unchanged baseline; record the comparison and block unexplained failures instead of blaming the pin.
   Footer tests must check complete paths at a sufficient width and test truncation separately; qualification work-directory lengths vary.
3. Check the foundation table of the development repository, if your copy has one, for merge conflicts.
   Resolve by row key and retain both reviewed changes.
4. A commit body must contain no machine path; the history scan reads commit messages, not only file content.
5. A development `scan all` host-value count at `level warn` is not the snapshot result; require the separate snapshot history scan at `level fail`.
