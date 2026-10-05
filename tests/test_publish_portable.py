"""Portable snapshot builder tests in a disposable Git repository."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from publish_portable import (  # noqa: E402
    DEFAULT_EMAIL, DEFAULT_NAME, EMAIL_VARIABLE, NAME_VARIABLE, push_command, resolve_identity, snapshot,
    snapshot_tags, tag_snapshot,
)

MARKER_NAME = "HOST_MARKER_NAME"
MARKER_EMAIL = "host-marker@marker.invalid"


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=True).stdout.strip()


class RepositoryCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-portable-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.email", "test@example.invalid")
        git(self.root, "config", "user.name", "test")
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

    def test_new_root_starts_a_history_without_the_earlier_snapshots(self):
        first, tree, _ = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="one")
        # The same tree: the chain makes no commit, a new root makes one with no parent.
        root, tree2, changed = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="root",
                                        new_root=True)
        self.assertEqual((tree, True), (tree2, changed))
        self.assertNotEqual(first, root)
        self.assertEqual(root, git(self.root, "rev-parse", "portable"))
        self.assertEqual("1", git(self.root, "rev-list", "--count", "portable"))
        self.assertEqual(root, git(self.root, "log", "-1", "--format=%H %P", "portable"))
        self.assertNotIn(first, git(self.root, "rev-list", "portable").split())
        # The next snapshot chains onto the new root.
        (self.root / "keep.txt").write_text("next\n")
        git(self.root, "commit", "-q", "-am", "second")
        after, _, _ = snapshot(self.root, ("keep.txt", "script.sh"), "HEAD", "portable", message="two")
        self.assertEqual(root, git(self.root, "rev-parse", f"{after}^"))
        # On a branch with no snapshot a new root is the first commit.
        only, _, changed = snapshot(self.root, ("keep.txt",), "HEAD", "portable-other", message="x", new_root=True)
        self.assertTrue(changed)
        self.assertEqual(only, git(self.root, "log", "-1", "--format=%H %P", "portable-other"))

    def test_tag_collision_moves_no_ref_on_second_new_root(self):
        tag = "portable/20300101-abcdef0"
        snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="first", new_root=True, tag=tag)
        before = git(self.root, "show-ref")
        with self.assertRaises(SystemExit):
            snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="second", new_root=True, tag=tag)
        self.assertEqual(before, git(self.root, "show-ref"))
        self.assertEqual("", git(self.root, "status", "--porcelain"))

    def test_second_new_root_command_leaves_all_refs_unchanged(self):
        import publish_portable
        import contextlib
        import io
        real_git = publish_portable.git

        def local_git(*args, **kwargs):
            kwargs.setdefault("root", self.root)
            return real_git(*args, **kwargs)

        with mock.patch.object(publish_portable, "ROOT", self.root), \
                mock.patch.object(publish_portable, "git", side_effect=local_git), \
                mock.patch.object(publish_portable, "publish_files", return_value=("keep.txt",)), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, publish_portable.main(["--new-root", "--no-push", "--skip-checks"]))
            before = git(self.root, "show-ref")
            with self.assertRaises(SystemExit):
                publish_portable.main(["--new-root", "--no-push", "--skip-checks"])
            self.assertEqual(before, git(self.root, "show-ref"))

    def test_both_modes_refuse_non_snapshot_and_checked_out_branches(self):
        for branch in ("main", "topic/demo", "portablelookalike"):
            if branch != "main":
                git(self.root, "branch", branch, "HEAD")
            before = git(self.root, "show-ref")
            for new_root in (False, True):
                with self.subTest(branch=branch, new_root=new_root):
                    with self.assertRaisesRegex(SystemExit, "snapshot branch must be named"):
                        snapshot(self.root, ("keep.txt",), "HEAD", branch, message="x", new_root=new_root)
                    self.assertEqual(before, git(self.root, "show-ref"))
        git(self.root, "checkout", "-q", "-b", "portable-current")
        for new_root in (False, True):
            with self.assertRaisesRegex(SystemExit, "checked out"):
                snapshot(self.root, ("keep.txt",), "HEAD", "portable-current", message="x", new_root=new_root)
        git(self.root, "checkout", "-q", "main")
        linked = self.root / "linked"
        git(self.root, "worktree", "add", "-q", "-b", "portable-linked", str(linked))
        before = git(self.root, "show-ref")
        for new_root in (False, True):
            with self.assertRaisesRegex(SystemExit, "checked out"):
                snapshot(self.root, ("keep.txt",), "HEAD", "portable-linked", message="x", new_root=new_root)
        self.assertEqual(before, git(self.root, "show-ref"))

    def test_transaction_refuses_branch_race_and_leaves_tag_absent(self):
        import publish_portable
        first, _, _ = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="first")
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
                snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="next", new_root=True,
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

    def test_new_root_option_needs_no_push(self):
        script = Path(__file__).resolve().parents[1] / "scripts/publish_portable.py"
        result = subprocess.run([sys.executable, str(script), "--new-root"], cwd=self.root, text=True, capture_output=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertNotEqual(0, result.returncode)
        self.assertIn("--new-root needs --no-push", result.stderr)

    def test_missing_or_non_file_paths_stop_before_any_ref_moves(self):
        for paths in (("keep.txt", "absent.txt"), ("private",)):
            with self.assertRaises(SystemExit):
                snapshot(self.root, paths, "HEAD", "portable", message="x")
        self.assertEqual("", subprocess.run(["git", "rev-parse", "--verify", "--quiet", "portable"], cwd=self.root,
                                            text=True, capture_output=True).stdout.strip())
        self.assertEqual("keep\n", (self.root / "keep.txt").read_text())


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
        commit, _, changed = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="one")
        self.assertTrue(changed)
        tag_snapshot(self.root, "portable/test", commit, message="tag one")
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
        self.assertEqual("tag one", git(self.root, "for-each-ref", "--format=%(contents:subject)", "refs/tags/"))
        # Every other Git call keeps the host identity.
        self.assertEqual(MARKER_NAME, git(self.root, "config", "user.name"))

    def test_atomic_snapshot_tag_has_neutral_identity_and_no_signature(self):
        commit, _, _ = snapshot(self.root, ("keep.txt",), "HEAD", "portable", message="snapshot",
                                 new_root=True, tag="portable/20300101-abcdef0")
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

    def test_force_adds_the_lease_option_after_the_refs(self):
        command = push_command("github", "portable", "main", ["portable/x"], force=True)
        self.assertEqual(command[-1], "--force-with-lease")
        self.assertEqual(len(command), 5)

    def test_no_form_of_the_command_follows_tags(self):
        for tags in ((), ["portable/x"], ["portable/x", "portable/y"]):
            for force in (False, True):
                self.assertNotIn("--follow" + "-tags", push_command("github", "portable", "main", tags, force=force))

    def test_the_script_source_has_no_follow_tags_option(self):
        source = (Path(__file__).resolve().parents[1] / "scripts" / "publish_portable.py").read_text(encoding="utf-8")
        self.assertNotIn("--follow" + "-tags", source)


class SnapshotTagTests(RepositoryCase):
    """The push sends the snapshot tags of the snapshot commit, also on a run that makes no new snapshot."""

    def test_only_snapshot_tags_of_the_commit_are_listed(self):
        head = git(self.root, "rev-parse", "HEAD")
        commit, _, changed = snapshot(self.root, ["keep.txt"], head, "portable", message="first snapshot")
        self.assertTrue(changed)
        self.assertEqual(snapshot_tags(self.root, commit), [])
        tag_snapshot(self.root, "portable/20300101-0000aaa", commit, message="tag")
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
