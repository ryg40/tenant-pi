"""Portable snapshot builder tests in a disposable Git repository."""
import contextlib
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from publish_portable import (  # noqa: E402
    DEFAULT_EMAIL, DEFAULT_NAME, EMAIL_VARIABLE, NAME_VARIABLE, push_command, resolve_identity, snapshot,
    snapshot_tags, release_tags,
)

MARKER_NAME = "HOST_MARKER_NAME"
MARKER_EMAIL = "host-marker@marker.invalid"


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=True).stdout.strip()


class RepositoryCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-portable-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.notes = Path(self.temp.name) / "notes.md"
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "test@example.invalid")
        git(self.root, "config", "user.name", "test")
        (self.root / "config").mkdir()
        (self.root / "config/manifest.json").write_text(json.dumps({
            "runtime": {"piVersion": "1.2.3", "piAcceptedRange": ">=1.2.3 <1.3"}}))
        (self.root / "scripts").mkdir()
        (self.root / "docs").mkdir()
        (self.root / "keep.txt").write_text("keep\n")
        (self.root / "private").mkdir()
        (self.root / "private/draft.md").write_text("PRIVATE_CANARY\n")
        (self.root / "script.sh").write_text("#!/bin/sh\n")
        (self.root / "script.sh").chmod(0o755)
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "first")

    def files(self, ref):
        return {line.split("\t")[1]: line.split()[0] for line in git(self.root, "ls-tree", "-r", ref).splitlines()}


class SnapshotTests(RepositoryCase):
    def test_snapshot_holds_only_listed_files_and_chains(self):
        commit, tree, changed = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="one")
        self.assertTrue(changed)
        self.assertEqual({"keep.txt": "100644", "script.sh": "100755"}, self.files("portable"))
        self.assertNotIn("PRIVATE_CANARY", git(self.root, "show", "portable:keep.txt"))
        self.assertEqual("1", git(self.root, "rev-list", "--count", "portable"))
        # Unchanged source: no new commit.
        again, tree2, changed2 = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="two")
        self.assertEqual((commit, tree, False), (again, tree2, changed2))
        # Working tree edits are ignored; only the committed HEAD counts.
        (self.root / "keep.txt").write_text("edited but uncommitted\n")
        same, _, changed3 = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="three")
        self.assertEqual(commit, same)
        self.assertFalse(changed3)
        git(self.root, "commit", "-q", "-am", "second")
        new, _, changed4 = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="four")
        self.assertTrue(changed4)
        self.assertEqual("2", git(self.root, "rev-list", "--count", "portable"))
        self.assertEqual(commit, git(self.root, "rev-parse", "portable^"))
        self.assertEqual("edited but uncommitted", git(self.root, "show", "portable:keep.txt"))
        self.assertEqual("first", git(self.root, "log", "-1", "--format=%s", "main^"))

    def test_tag_collision_moves_no_ref_on_the_next_snapshot(self):
        tag = "portable/20300101-abcdef0"
        snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="first", tag=tag)
        (self.root / "keep.txt").write_text("next\n")
        git(self.root, "commit", "-q", "-am", "second")
        before = git(self.root, "show-ref")
        with self.assertRaises(SystemExit):
            snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="second", tag=tag)
        self.assertEqual(before, git(self.root, "show-ref"))
        self.assertEqual("", git(self.root, "status", "--porcelain"))

    def test_snapshot_refuses_non_snapshot_and_checked_out_branches(self):
        for branch in ("main", "topic/demo", "portablelookalike"):
            if branch != "main":
                git(self.root, "branch", branch, "HEAD")
            before = git(self.root, "show-ref")
            with self.subTest(branch=branch):
                with self.assertRaisesRegex(SystemExit, "snapshot branch must be named"):
                    snapshot(self.root, ("keep.txt",), "HEAD", branch, message="x")
                self.assertEqual(before, git(self.root, "show-ref"))
        git(self.root, "checkout", "-q", "-b", "portable-current")
        with self.assertRaisesRegex(SystemExit, "checked out"):
            snapshot(self.root, ("keep.txt",), "HEAD", "portable-current", message="x")
        git(self.root, "checkout", "-q", "main")
        linked = self.root / "linked"
        git(self.root, "worktree", "add", "-q", "-b", "portable-linked", str(linked))
        before = git(self.root, "show-ref")
        with self.assertRaisesRegex(SystemExit, "checked out"):
            snapshot(self.root, ("keep.txt",), "HEAD", "portable-linked", message="x")
        self.assertEqual(before, git(self.root, "show-ref"))

    def test_transaction_refuses_branch_race_and_leaves_tag_absent(self):
        import publish_portable
        first, _, _ = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="first")
        (self.root / "keep.txt").write_text("next\n")
        git(self.root, "commit", "-q", "-am", "next")
        concurrent = git(self.root, "rev-parse", "HEAD")
        real_git = publish_portable.git
        transactions = []

        def race(*args, **kwargs):
            if args[:2] == ("update-ref", "--stdin"):
                transactions.append(kwargs["input"])
                git(self.root, "update-ref", "refs/heads/portable", concurrent, first)
            return real_git(*args, **kwargs)

        with mock.patch.object(publish_portable, "git", side_effect=race):
            with self.assertRaises(SystemExit):
                snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="next",
                         tag="portable/20300101-abcdef0")
        self.assertIn(f" {first}\n", transactions[0])
        self.assertEqual(concurrent, git(self.root, "rev-parse", "portable"))
        self.assertEqual("", git(self.root, "tag", "--list"))

    def test_invalid_tag_and_tag_object_failure_move_no_refs(self):
        import publish_portable
        before = git(self.root, "show-ref")
        with self.assertRaises(SystemExit):
            snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="x", tag="invalid tag")
        real_git = publish_portable.git

        def fail_tag(*args, **kwargs):
            if args[0] == "mktag":
                raise SystemExit("tag object failed")
            return real_git(*args, **kwargs)

        with mock.patch.object(publish_portable, "git", side_effect=fail_tag):
            with self.assertRaises(SystemExit):
                snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="x", tag="portable/test")
        self.assertEqual(before, git(self.root, "show-ref"))

    def test_no_option_replaces_or_restarts_the_history(self):
        script = Path(__file__).resolve().parents[1] / "scripts/publish_portable.py"
        result = subprocess.run([sys.executable, str(script), "--help"], cwd=self.root, text=True, capture_output=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(0, result.returncode)
        for option in ("--force", "--new-root"):
            self.assertNotIn(option, result.stdout)
        for option in ("--force", "--new-root"):
            refused = subprocess.run([sys.executable, str(script), option, "--no-push"], cwd=self.root, text=True,
                                     capture_output=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(2, refused.returncode)
            self.assertIn("unrecognized arguments", refused.stderr)

    def test_missing_or_non_file_paths_stop_before_any_ref_moves(self):
        for paths in (("keep.txt", "absent.txt"), ("private",)):
            with self.assertRaises(SystemExit):
                snapshot(self.root, paths, "HEAD", "portable", message="x")
        self.assertEqual("", subprocess.run(["git", "rev-parse", "--verify", "--quiet", "portable"], cwd=self.root,
                                            text=True, capture_output=True).stdout.strip())
        self.assertEqual("keep\n", (self.root / "keep.txt").read_text())


class CheckSetTests(RepositoryCase):
    """Exercise the publisher with a subprocess fixture and real snapshot refs."""

    def setUp(self):
        super().setUp()
        (self.root / "scripts/check.py").write_text(
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "mode = Path('.git/check-mode').read_text()\n"
            "with Path('.git/check-calls').open('a') as log:\n"
            "    log.write(json.dumps([sys.argv[1:], os.environ.get('PYTHONDONTWRITEBYTECODE')]) + '\\n')\n"
            "if sys.argv[1:] == ['--stamp-status']:\n"
            "    raise SystemExit(0 if mode == 'stamp' else 1)\n"
            "print('check: passed' if mode in ('pass', 'bad-exit') else 'check: FAILED')\n"
            "raise SystemExit(1 if mode in ('fail', 'bad-exit') else 0)\n")
        git(self.root, "add", "scripts/check.py")
        git(self.root, "commit", "-qm", "check fixture")

    def calls(self):
        path = self.root / ".git/check-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def make_stamp(self):
        tree = git(self.root, "rev-parse", "HEAD^{tree}")
        directory = self.root / ".git/check-stamps"
        directory.mkdir(exist_ok=True)
        stamp = {"when": "2030-01-01T00:00:00Z", "client": {"root": False}, "tests": 4,
                 "skipped": 1, "resultLines": ["select: all (--all)", "Ran 4 tests in 0.001s", "OK (skipped=1)",
                                              "scan: passed", "diff: passed", "check: passed"]}
        (directory / tree).write_text(json.dumps(stamp))
        return tree, stamp

    def invoke(self, mode, *options, push=False, default_notes=False, public=0):
        import publish_portable
        (self.root / ".git/check-mode").write_text(mode)
        real_git = publish_portable.git

        def local_git(*args, **kwargs):
            kwargs.setdefault("root", self.root)
            return real_git(*args, **kwargs)

        output = io.StringIO()
        with mock.patch.object(publish_portable, "ROOT", self.root), \
                mock.patch.object(publish_portable, "git", side_effect=local_git), \
                mock.patch.object(publish_portable, "check", return_value=("keep.txt",)) as direct_check, \
                mock.patch.object(publish_portable, "public_report", return_value=public) as public_check, \
                mock.patch.object(publish_portable, "publish_files", return_value=("keep.txt",)), \
                contextlib.redirect_stdout(output):
            arguments = [] if push else ["--no-push"]
            if not default_notes:
                arguments += ["--notes", str(self.notes)]
            self.assertEqual(0, publish_portable.main([*arguments, *options]))
            public_check.assert_called_once_with()
            direct_check.assert_called_once_with()
        return output.getvalue()

    def test_first_release_without_portable_tags(self):
        self.make_stamp()
        self.assertEqual([], release_tags(self.root))
        self.invoke("stamp")
        notes = self.notes.read_text()
        self.assertIn("## Changes since <first snapshot>", notes)
        self.assertIn("Gates 6-7: unchanged from <no full tag recorded>", notes)
        self.assertIn("## Update\n\n- First release: no update data.\n", notes)

    def test_notes_inside_checkout_are_refused_before_checks_or_ref_changes(self):
        linked = Path(self.temp.name) / "linked-repo"
        linked.symlink_to(self.root, target_is_directory=True)
        outward = self.root / ".git/outside"
        outward.symlink_to(Path(self.temp.name), target_is_directory=True)
        for path in (self.root / "notes.md", self.root / ".git/notes.md", linked / "notes.md", outward / "notes.md"):
            with self.subTest(path=path):
                before = git(self.root, "show-ref")
                with self.assertRaisesRegex(SystemExit, "--notes must be outside the checkout"):
                    self.invoke("stamp", "--notes", str(path))
                self.assertEqual([], self.calls())
                self.assertEqual(before, git(self.root, "show-ref"))
                self.assertFalse(path.exists())

    def test_matching_stamp_prints_record_and_skips_full_run(self):
        tree, stamp = self.make_stamp()
        output = self.invoke("stamp")
        for line in (f"tree: {tree}", f"when: {stamp['when']}", 'client: {"root": false}',
                     "skipped: 1", "resultLines:", *stamp["resultLines"]):
            self.assertIn(line, output)
        self.assertEqual(self.calls(), [[["--stamp-status"], "1"]])
        self.assertEqual({"keep.txt": "100644"}, self.files("portable"))
        self.assertIn("no change:", self.invoke("stamp"))
        self.assertEqual(self.calls(), [[["--stamp-status"], "1"]] * 2)

    def test_no_stamp_runs_full_check_before_build(self):
        self.make_stamp()  # The full-check fixture leaves this stamp for the publisher to read.
        output = self.invoke("pass")
        self.assertEqual(self.calls(), [[["--stamp-status"], "1"], [["--all"], "1"]])
        self.assertIn("check: passed", output)
        self.assertLess(output.index("check: passed"), output.index("portable commit"))
        self.assertEqual({"keep.txt": "100644"}, self.files("portable"))

    def test_failed_check_stops_build_even_with_false_success_exit_or_line(self):
        for mode in ("fail", "bad-exit", "bad-line"):
            with self.subTest(mode=mode):
                before = git(self.root, "show-ref")
                with self.assertRaisesRegex(SystemExit, "check set failed; no snapshot built"):
                    self.invoke(mode)
                self.assertEqual(before, git(self.root, "show-ref"))

    def test_public_reader_finding_stops_build(self):
        self.make_stamp()
        before = git(self.root, "show-ref")
        with self.assertRaisesRegex(SystemExit, "public reader check failed; no snapshot built"):
            self.invoke("stamp", public=1)
        self.assertEqual(before, git(self.root, "show-ref"))

    def test_dirty_tree_refuses_before_stamp_check(self):
        (self.root / "keep.txt").write_text("dirty\n")
        before = git(self.root, "show-ref")
        with self.assertRaisesRegex(SystemExit, "working tree not clean"):
            self.invoke("stamp")
        self.assertEqual(self.calls(), [])
        self.assertEqual(before, git(self.root, "show-ref"))

    def test_unreadable_matching_stamp_stops_build(self):
        before = git(self.root, "show-ref")
        with self.assertRaisesRegex(SystemExit, "matching stamp could not be read"):
            self.invoke("stamp")
        self.assertEqual(before, git(self.root, "show-ref"))


class ReleaseClassTests(RepositoryCase):
    """Stamped main fixtures, legacy/full and patch tags, and actual merge subjects."""

    make_stamp = CheckSetTests.make_stamp
    invoke = CheckSetTests.invoke

    def setUp(self):
        super().setUp()
        (self.root / "scripts/check.py").write_text("raise SystemExit(0)\n")
        git(self.root, "add", "scripts/check.py")
        git(self.root, "commit", "-qm", "check fixture")
        self.full_tag = "portable/20290101-0000aaa"
        self.patch_tag = "portable/20290102-0000bbb"
        self.add_tag(self.full_tag, "full")
        git(self.root, "commit", "--allow-empty", "-qm", "previous patch")
        self.add_tag(self.patch_tag, "patch")
        for number in (21, 22):
            git(self.root, "checkout", "-qb", f"topic-{number}")
            (self.root / "keep.txt").write_text(f"change {number}\n")
            git(self.root, "commit", "-qam", f"change {number}")
            git(self.root, "checkout", "-q", "main")
            git(self.root, "merge", "--no-ff", "-qm", f"Merge change (issue {number})", f"topic-{number}")
        self.make_stamp()

    def add_tag(self, tag, kind):
        source = git(self.root, "rev-parse", "HEAD")
        message = f"Portable snapshot of {source[:7]} (2029-01-01)\n"
        if kind:
            message += f"\nclass: {kind}\n"
        git(self.root, "tag", "-a", tag, "-m", message)

    def test_patch_and_full_notes_from_stamp(self):
        tree, stamp = self.make_stamp()
        for kind in ("patch", "full"):
            with self.subTest(kind=kind):
                # Separate branches still collide on the tag name, so use independent fixtures.
                if kind == "full":
                    git(self.root, "commit", "--allow-empty", "-qm", "full qualification")
                    git(self.root, "update-ref", "-d", "refs/heads/portable")
                output = self.invoke("stamp", "--class", kind)
                notes = self.notes.read_text()
                tag = snapshot_tags(self.root, "portable")[0]
                self.assertIn(f"# Portable release: {kind}", notes)
                self.assertIn(f"- Tag: {tag}", notes)
                self.assertIn(f"- Source commit: {git(self.root, 'rev-parse', 'HEAD')}", notes)
                self.assertIn(f"- Snapshot commit: {git(self.root, 'rev-parse', 'portable')}", notes)
                self.assertIn(f"- Kind of release: {kind} release", notes)
                self.assertIn("Pi pin (runtime.piVersion): 1.2.3", notes)
                for line in (f"tree: {tree}", f"when: {stamp['when']}", "skipped: 1", *stamp["resultLines"]):
                    self.assertIn(line, notes)
                self.assertIn("Snapshot range: not run (no push)", notes)
                self.assertIn("## Known defects\n\n<none recorded>", notes)
                self.assertIn(f"notes: {self.notes}", output)
                self.assertIn(f"\nclass: {kind}\n", git(self.root, "cat-file", "-p", tag))
                if kind == "patch":
                    self.assertIn(f"Gates 6-7: unchanged from {self.full_tag}", notes)
                    self.assertIn(f"Changes since {self.patch_tag}", notes)
                    for number in (21, 22):
                        self.assertEqual(notes.count(f"- Merge change (issue {number})"), 1)
                    self.assertNotIn("scan.sh all", notes)
                    self.assertNotIn("6. Clean Linux", notes)
                else:
                    for line in ("scan.sh all: <", "6. Clean Linux core trial: <", "7. Optional live services",
                                 "Platforms that are not qualified: <", "## Open gaps"):
                        self.assertIn(line, notes)
                    self.assertNotIn("Gates 6-7: unchanged", notes)

    def test_legacy_tag_is_last_full_and_default_class_is_patch(self):
        legacy = "portable/20290103-0000ccc"
        self.add_tag(legacy, None)
        self.assertEqual(release_tags(self.root)[0], (legacy, "full", git(self.root, "rev-parse", "HEAD")[:7]))
        self.invoke("stamp")
        notes = self.notes.read_text()
        self.assertIn("# Portable release: patch", notes)
        self.assertIn(f"Gates 6-7: unchanged from {legacy}", notes)

    def test_update_block_without_relevant_changes(self):
        self.invoke("stamp")
        notes = self.notes.read_text()
        for line in ("- Pi pin: unchanged (1.2.3)", "- No package line needed.", "- Install templates: unchanged.",
                     "- Run: `git pull`, then `/reload` in Pi."):
            self.assertIn(f"\n{line}\n", notes)

    def test_update_block_names_a_changed_lock_file_and_pin(self):
        (self.root / "packages/demo").mkdir(parents=True)
        (self.root / "packages/demo/package-lock.json").write_text("{}\n")
        (self.root / "config/manifest.json").write_text(json.dumps({
            "runtime": {"piVersion": "1.3.0", "piAcceptedRange": ">=1.2.3 <1.3"}}))
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "pin and lock")
        self.make_stamp()
        self.invoke("stamp")
        notes = self.notes.read_text()
        for line in ("- Pi pin: 1.2.3 -> 1.3.0; install the new Pi first.",
                     "- npm ci --ignore-scripts needed in: packages/demo",
                     "- Install templates: unchanged."):
            self.assertIn(f"\n{line}\n", notes)
        self.assertNotIn("No package line needed", notes)

    def test_update_block_skips_a_deleted_lock_file_and_names_a_changed_template(self):
        import publish_portable
        (self.root / "packages/demo").mkdir(parents=True)
        (self.root / "packages/demo/package-lock.json").write_text("{}\n")
        (self.root / "config/models.example.json").write_text('{"providers": {}}\n')
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "lock and template")
        old = git(self.root, "rev-parse", "HEAD")
        (self.root / "packages/demo/package-lock.json").unlink()
        (self.root / "config/models.example.json").write_text('{"providers": {"demo": {}}}\n')
        (self.root / "scripts/other.py").write_text("\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "no lock, a changed template, another script")
        lines = publish_portable.update_block(self.root, ("portable/old", "patch", old), "HEAD")
        self.assertIn("- No package line needed.", lines)
        self.assertIn("- Install templates changed: config/models.example.json; a profile keeps its own copy.", lines)

    def test_update_block_is_first_in_notes_and_in_the_tag_message(self):
        self.invoke("stamp")
        notes = self.notes.read_text()
        heading = f"Update from {self.patch_tag}"
        self.assertEqual([f"## {heading}", "## Gates"], re.findall(r"^## .*", notes, re.MULTILINE)[:2])
        tag = snapshot_tags(self.root, "portable")[0]
        message = git(self.root, "for-each-ref", "--format=%(contents)", f"refs/tags/{tag}")
        self.assertEqual(message, git(self.root, "log", "-1", "--format=%B", "portable"))
        self.assertIn(f"\nclass: patch\n\n{heading}\n- Pi pin: unchanged (1.2.3)\n", message)
        # The block keeps the source and class lines that the next run reads.
        self.assertIn((tag, "patch", git(self.root, "rev-parse", "HEAD")[:7]), release_tags(self.root))

    def test_default_notes_are_outside_repository(self):
        output = self.invoke("stamp", default_notes=True)
        path = Path(next(line.removeprefix("notes: ") for line in output.splitlines() if line.startswith("notes: ")))
        self.addCleanup(path.unlink)
        self.assertEqual(path.parent, Path(tempfile.gettempdir()))
        self.assertFalse(path.is_relative_to(self.root))
        self.assertIn("not run (no push)", path.read_text())

    def test_retry_keeps_original_change_range_and_class(self):
        self.invoke("stamp")
        first = self.notes.read_text()
        self.invoke("stamp")
        self.assertEqual(first, self.notes.read_text())
        with self.assertRaisesRegex(SystemExit, "different class; no notes or push"):
            self.invoke("stamp", "--class", "full")

    def test_unchanged_snapshot_names_source_and_combined_mismatches(self):
        self.invoke("stamp")
        first = self.notes.read_text()
        git(self.root, "commit", "--allow-empty", "-qm", "private-only change")
        self.make_stamp()
        before = git(self.root, "show-ref")
        for kind, difference in (("patch", "source"), ("full", "class and source")):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(SystemExit, f"different {difference}; no notes or push"):
                    self.invoke("stamp", "--class", kind)
                self.assertEqual(before, git(self.root, "show-ref"))
                self.assertEqual(first, self.notes.read_text())

    def test_push_copies_hook_stdout_and_stderr_without_real_push(self):
        import publish_portable
        real_run = subprocess.run
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                line = "pre-push: result pass; range abc..def; level fail"

                def run(command, *args, **kwargs):
                    if command[:2] == ["git", "push"]:
                        return subprocess.CompletedProcess(command, 0, **{stream: line + "\n",
                                                           "stderr" if stream == "stdout" else "stdout": ""})
                    return real_run(command, *args, **kwargs)

                with mock.patch.object(publish_portable.subprocess, "run", side_effect=run):
                    output = self.invoke("stamp", push=True)
                self.assertIn(line, output.splitlines())
                self.assertIn(f"Snapshot range: {line}", self.notes.read_text())

    def test_missing_hook_line_does_not_claim_scan_passed(self):
        import publish_portable
        with mock.patch.object(publish_portable.subprocess, "run", return_value=(
                subprocess.CompletedProcess([], 0, "", "Everything up-to-date"))):
            _, lines = publish_portable.push_snapshot(self.root, ["push", "unused"])
        self.assertEqual(lines, ["not recorded (no pre-push result line)"])

    def test_failed_push_keeps_failure_record(self):
        import publish_portable
        line = "pre-push: result fail; range abc..def; level fail"
        real_run = subprocess.run

        def run(command, *args, **kwargs):
            if command[:2] == ["git", "push"]:
                return subprocess.CompletedProcess(command, 1, "stdout reason\n", line + "\nrefused")
            return real_run(command, *args, **kwargs)

        output = io.StringIO()
        with mock.patch.object(publish_portable.subprocess, "run", side_effect=run), \
                contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as caught:
                self.invoke("stamp", push=True)
        self.assertEqual(f"push failed: stdout reason\n{line}\nrefused", str(caught.exception))
        self.assertIn(f"Snapshot range: {line}", self.notes.read_text())


class IdentityTests(RepositoryCase):
    """The snapshot commit and the tag carry the neutral identity, never the one of the Git config."""

    def setUp(self):
        super().setUp()
        git(self.root, "config", "user.name", MARKER_NAME)
        git(self.root, "config", "user.email", MARKER_EMAIL)
        # A signing request of the host must not reach the snapshot: no key exists here.
        git(self.root, "config", "commit.gpgsign", "true")
        git(self.root, "config", "tag.gpgsign", "true")
        git(self.root, "config", "tag.forceSignAnnotated", "true")
        git(self.root, "config", "user.signingkey", "HOST_MARKER_KEY")
        clean = {key: value for key, value in os.environ.items()
                 if key not in (NAME_VARIABLE, EMAIL_VARIABLE) and not key.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_"))}
        clean["TZ"] = "Asia/Tokyo"  # a host offset that must not reach the snapshot
        patch = mock.patch.dict(os.environ, clean, clear=True)
        patch.start()
        self.addCleanup(patch.stop)

    def identities(self):
        commit, _, changed = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="one", tag="portable/test")
        self.assertTrue(changed)
        return (git(self.root, "log", "-1", "--format=%an|%ae|%cn|%ce", "portable"),
                git(self.root, "for-each-ref", "--format=%(taggername)|%(taggeremail)", "refs/tags/"))

    def assert_no_marker(self, *texts):
        for text in texts:
            self.assertNotIn(MARKER_NAME, text)
            self.assertNotIn(MARKER_EMAIL, text)
            self.assertNotIn("marker", text.lower())

    def test_snapshot_and_tag_carry_the_neutral_identity_and_no_signature(self):
        log, tagger = self.identities()
        self.assertEqual(f"{DEFAULT_NAME}|{DEFAULT_EMAIL}|{DEFAULT_NAME}|{DEFAULT_EMAIL}", log)
        self.assertEqual(f"{DEFAULT_NAME}|<{DEFAULT_EMAIL}>", tagger)
        self.assertEqual("tenant-pi portable|portable@tenant-pi.invalid", f"{DEFAULT_NAME}|{DEFAULT_EMAIL}")
        self.assert_no_marker(log, tagger)
        for obj in ("portable", "refs/tags/portable/test"):
            raw = git(self.root, "cat-file", "-p", obj)
            self.assertNotIn("gpgsig", raw)
            self.assertNotIn("BEGIN ", raw)
            self.assert_no_marker(raw)
        # The dates carry no host offset; a commit of the host keeps it.
        self.assertTrue(git(self.root, "log", "-1", "--format=%ai", "portable").endswith("+0000"))
        self.assertTrue(git(self.root, "log", "-1", "--format=%ci", "portable").endswith("+0000"))
        self.assertTrue(git(self.root, "for-each-ref", "--format=%(taggerdate:iso)", "refs/tags/").endswith("+0000"))
        self.assertEqual("Asia/Tokyo", os.environ["TZ"])
        self.assertEqual("one", git(self.root, "log", "-1", "--format=%B", "portable"))
        self.assertEqual("one", git(self.root, "for-each-ref", "--format=%(contents:subject)", "refs/tags/"))
        # Every other Git call keeps the host identity.
        self.assertEqual(MARKER_NAME, git(self.root, "config", "user.name"))

    def test_atomic_snapshot_tag_has_neutral_identity_and_no_signature(self):
        commit, _, _ = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="snapshot",
                                 tag="portable/20300101-abcdef0")
        self.assertEqual(commit, git(self.root, "rev-parse", "portable/20300101-abcdef0^{commit}"))
        self.assertEqual(f"{DEFAULT_NAME}|<{DEFAULT_EMAIL}>",
                         git(self.root, "for-each-ref", "--format=%(taggername)|%(taggeremail)", "refs/tags/"))
        raw = git(self.root, "cat-file", "-p", "refs/tags/portable/20300101-abcdef0")
        self.assert_no_marker(raw)
        self.assertNotIn("BEGIN ", raw)
        self.assertIn("+0000", raw)

    def test_environment_overrides_the_identity_and_an_option_overrides_the_environment(self):
        with mock.patch.dict(os.environ, {NAME_VARIABLE: "release bot", EMAIL_VARIABLE: "bot@example.invalid"}):
            log, tagger = self.identities()
            self.assertEqual(("option", "bot@example.invalid"), resolve_identity("option", None))
            self.assertEqual(("release bot", "o@example.invalid"), resolve_identity(None, "o@example.invalid"))
        self.assertEqual("release bot|bot@example.invalid|release bot|bot@example.invalid", log)
        self.assertEqual("release bot|<bot@example.invalid>", tagger)
        self.assert_no_marker(log, tagger)

    def test_empty_name_or_email_is_an_error_and_moves_no_ref(self):
        for variable in (NAME_VARIABLE, EMAIL_VARIABLE):
            for value in ("", "  "):
                with mock.patch.dict(os.environ, {variable: value}):
                    with self.assertRaises(SystemExit) as caught:
                        snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="x")
                    self.assertIn(variable, str(caught.exception))
        for arguments in (("", None), (None, ""), (" ", "a@example.invalid")):
            with self.assertRaises(SystemExit):
                resolve_identity(*arguments)
        self.assertEqual("", subprocess.run(["git", "rev-parse", "--verify", "--quiet", "portable"], cwd=self.root,
                                            text=True, capture_output=True).stdout.strip())


class PushCommandTests(unittest.TestCase):
    """The push names its refs. The portable push rule forbids the option that follows tags."""

    def test_push_names_the_branch_ref_and_each_tag_ref(self):
        command = push_command("github", "portable", "main", ["portable/20300101-abcdef0"])
        self.assertEqual(command, ["push", "github", "refs/heads/portable:refs/heads/main",
                                   "refs/tags/portable/20300101-abcdef0:refs/tags/portable/20300101-abcdef0"])

    def test_push_without_a_tag_names_the_branch_ref_only(self):
        self.assertEqual(push_command("github", "portable", "main"),
                         ["push", "github", "refs/heads/portable:refs/heads/main"])

    def test_no_form_of_the_command_follows_tags(self):
        for tags in ((), ["portable/x"], ["portable/x", "portable/y"]):
            self.assertNotIn("--follow" + "-tags", push_command("github", "portable", "main", tags))

    def test_the_script_source_has_no_follow_tags_option(self):
        source = (Path(__file__).resolve().parents[1] / "scripts" / "publish_portable.py").read_text(encoding="utf-8")
        self.assertNotIn("--follow" + "-tags", source)


class SnapshotTagTests(RepositoryCase):
    """The push sends the snapshot tags of the snapshot commit, also on a run that makes no new snapshot."""

    def test_only_snapshot_tags_of_the_commit_are_listed(self):
        head = git(self.root, "rev-parse", "HEAD")
        self.assertEqual(snapshot_tags(self.root, head), [])
        commit, _, changed = snapshot(self.root, ["keep.txt"], head, "portable", message="first snapshot",
                                      tag="portable/20300101-0000aaa")
        self.assertTrue(changed)
        git(self.root, "tag", "portable/manual", commit)
        git(self.root, "tag", "junk", commit)
        git(self.root, "tag", "portable/20291231-0000bbb", head)
        self.assertEqual(snapshot_tags(self.root, commit), ["portable/20300101-0000aaa"])
        again, _, changed = snapshot(self.root, ["keep.txt"], head, "portable", message="second run")
        self.assertFalse(changed)
        self.assertEqual(again, commit)
        self.assertEqual(snapshot_tags(self.root, again), ["portable/20300101-0000aaa"])


if __name__ == "__main__":
    unittest.main()
