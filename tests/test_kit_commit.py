"""Kit commit from Git metadata files: closed forms, bounded no-follow reads, and no process."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from scripts import kit_commit, tenant_pi
from scripts.kit_commit import UNKNOWN, commit, head, loose, packed, pointer

A = "a" * 40
B = "0123456789abcdef0123456789abcdef01234567"
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", *PROCESS_EVENTS):
        EVENTS.append((event, args[0]))


sys.addaudithook(_audit)


class ParserTests(unittest.TestCase):
    def test_commit_form(self):
        self.assertEqual(A, commit(A))
        self.assertEqual(UNKNOWN, commit(UNKNOWN))
        for value in (A.upper(), A[:39], A + "0", "g" * 40, "b" * 64, A + "\n", None, 7, ""):
            self.assertIsNone(commit(value))

    def test_head(self):
        self.assertEqual(("commit", B), head(B.encode() + b"\n"))
        self.assertEqual(("ref", "refs/heads/topic/l6-list"), head(b"ref: refs/heads/topic/l6-list\n"))
        self.assertEqual(("ref", "refs/heads/main"), head(b"ref: refs/heads/main"))
        for data in (b"", b"\n", b"ref: refs/heads/../../x\n", b"ref: refs/heads/a..b\n", b"ref: refs/heads/.hidden\n",
                     b"ref: refs/heads/x.lock\n", b"ref: refs/heads/\n", b"ref: heads/main\n", b"ref: /etc/passwd\n",
                     b"ref: refs/heads/a b\n", b"ref: refs//x\n", b"ref: refs/heads/x\n\n", b"ref:refs/heads/x\n",
                     b"ref: refs/heads/" + b"x" * 300 + b"\n", ("ref: refs/heads/é\n").encode(), b"b" * 64 + b"\n",
                     A.upper().encode(), b"x" * (kit_commit.MAX_METADATA + 1), None, "ref: refs/heads/main"):
            with self.subTest(data=data if data is None or len(data) < 80 else len(data)):
                self.assertIsNone(head(data))

    def test_pointer_loose_and_packed(self):
        self.assertEqual("/repo/.git/worktrees/w", pointer(b"gitdir: /repo/.git/worktrees/w\n", "gitdir: "))
        self.assertEqual("../..", pointer(b"../..\n"))
        self.assertIsNone(pointer(b"gitdir: \n", "gitdir: "))
        self.assertIsNone(pointer(b"/repo\n", "gitdir: "))
        self.assertIsNone(pointer(b"gitdir: /a\x00b\n", "gitdir: "))
        self.assertEqual(A, loose(A.encode() + b"\n"))
        self.assertIsNone(loose(b"ref: refs/heads/other\n"))
        data = ("# pack-refs with: peeled fully-peeled sorted \n" + B + " refs/heads/other\n"
                + A + " refs/heads/main\n^" + B + "\n").encode()
        self.assertEqual(A, packed(data, "refs/heads/main"))
        self.assertIsNone(packed(data, "refs/heads/absent"))
        self.assertIsNone(packed(b"zz refs/heads/main\n", "refs/heads/main"))
        self.assertIsNone(packed(b"\xff", "refs/heads/main"))
        self.assertIsNone(packed(None, "refs/heads/main"))


class MetadataTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-commit-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.kit = self.base / "kit"
        self.git = self.kit / ".git"
        (self.git / "refs/heads/topic").mkdir(parents=True)
        (self.git / "HEAD").write_text("ref: refs/heads/main\n")

    def read(self, root=None):
        return tenant_pi._kit_commit(self.kit if root is None else root)

    def test_clone_loose_packed_and_detached(self):
        self.assertEqual(UNKNOWN, self.read())
        (self.git / "packed-refs").write_text("# pack-refs with: peeled\n" + B + " refs/heads/main\n")
        self.assertEqual(B, self.read())
        (self.git / "refs/heads/main").write_text(A + "\n")
        self.assertEqual(A, self.read(), "a loose ref wins over packed-refs")
        (self.git / "HEAD").write_text(B + "\n")
        self.assertEqual(B, self.read())
        (self.git / "HEAD").write_text("ref: refs/heads/topic/x\n")
        (self.git / "refs/heads/topic/x").write_text("ref: refs/heads/main\n")
        self.assertEqual(UNKNOWN, self.read(), "a symbolic loose ref is not followed")

    def test_present_but_malformed_loose_ref_never_falls_back_to_packed_refs(self):
        (self.git / "packed-refs").write_text(B + " refs/heads/main\n")
        self.assertEqual(B, self.read())
        for content in ("garbage\n", A.upper() + "\n", "", "x" * (kit_commit.MAX_METADATA + 1)):
            with self.subTest(content=content[:20]):
                (self.git / "refs/heads/main").write_text(content)
                self.assertEqual(UNKNOWN, self.read())
        (self.git / "refs/heads/main").unlink()
        (self.git / "refs/heads/main").symlink_to(self.git / "packed-refs")
        self.assertEqual(UNKNOWN, self.read())
        (self.git / "refs/heads/main").unlink()
        (self.git / "refs/heads/main").mkdir()
        self.assertEqual(UNKNOWN, self.read())

    def test_worktree_follows_gitdir_and_commondir_once(self):
        worktree = self.git / "worktrees" / "w"
        worktree.mkdir(parents=True)
        (worktree / "HEAD").write_text("ref: refs/heads/topic/w\n")
        (worktree / "commondir").write_text("../..\n")
        (self.git / "refs/heads/topic/w").write_text(A + "\n")
        checkout = self.base / "checkout"
        checkout.mkdir()
        (checkout / ".git").write_text("gitdir: " + str(worktree) + "\n")
        self.assertEqual(A, self.read(checkout))
        (checkout / ".git").write_text("gitdir: ../kit/.git/worktrees/w\n")
        self.assertEqual(A, self.read(checkout), "a relative gitdir resolves against the checkout")
        (worktree / "HEAD").write_text(B + "\n")
        self.assertEqual(B, self.read(checkout))
        # A second `.git` file at the gitdir is not followed: the chain stops after one step.
        second = self.base / "second"
        second.mkdir()
        (second / ".git").write_text("gitdir: " + str(checkout / ".git") + "\n")
        self.assertEqual(UNKNOWN, self.read(second))

    def test_unknown_for_absent_symlinked_or_malformed_metadata(self):
        (self.git / "refs/heads/main").write_text(A + "\n")
        self.assertEqual(A, self.read())
        self.assertEqual(UNKNOWN, self.read(self.base / "absent"))
        plain = self.base / "plain"
        plain.mkdir()
        self.assertEqual(UNKNOWN, self.read(plain))
        linked = self.base / "linked"
        linked.mkdir()
        (linked / ".git").symlink_to(self.git, target_is_directory=True)
        self.assertEqual(UNKNOWN, self.read(linked))
        for name, content in (("HEAD", "garbage\n"), ("HEAD", "x" * (kit_commit.MAX_METADATA + 1)),
                              ("HEAD", "ref: refs/heads/../../../outside\n")):
            with self.subTest(name=name, content=content[:20]):
                (self.git / name).write_text(content)
                self.assertEqual(UNKNOWN, self.read())
        (self.git / "HEAD").unlink()
        (self.git / "HEAD").symlink_to(self.git / "refs/heads/main")
        self.assertEqual(UNKNOWN, self.read())
        (self.git / "HEAD").unlink()
        (self.git / "HEAD").write_text("ref: refs/heads/main\n")
        (self.git / "commondir").write_text("\n")
        self.assertEqual(UNKNOWN, self.read())
        (self.git / "commondir").unlink()
        (self.kit / "gitfile").mkdir()
        shutil.move(str(self.git), str(self.kit / "gitfile" / "real"))
        (self.kit / ".git").write_text("gitdir:" + str(self.kit / "gitfile" / "real") + "\n")
        self.assertEqual(UNKNOWN, self.read(), "the exact `gitdir: ` prefix is required")
        (self.kit / ".git").write_text("gitdir: " + str(self.kit / "gitfile" / "real") + "\n")
        self.assertEqual(A, self.read())

    def test_reads_only_metadata_and_starts_no_process(self):
        (self.git / "packed-refs").write_text(A + " refs/heads/main\n")
        (self.git / "config").write_text("CANARY")
        del EVENTS[:]
        RECORDING.append(True)
        try:
            self.assertEqual(A, self.read())
        finally:
            del RECORDING[:]
        self.assertEqual([], [event for event, _ in EVENTS if event in PROCESS_EVENTS])
        opened = {arg for event, arg in EVENTS if event == "open" and type(arg) is str}
        self.assertEqual(set(), opened - {"/", *self.kit.parts[1:], ".git", "HEAD", "commondir", "main", "refs", "heads",
                                          "packed-refs"}, opened)

    @unittest.skipUnless(shutil.which("git") and (tenant_pi.ROOT / ".git").exists(), "no Git clone of the kit")
    def test_same_value_as_git_rev_parse_for_this_clone(self):
        # The test, not the kit, runs Git: the kit reads the same value from the metadata files.
        result = subprocess.run(["git", "-C", str(tenant_pi.ROOT), "rev-parse", "HEAD"], text=True,
                                capture_output=True, check=False, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        if result.returncode != 0:
            self.skipTest("git rev-parse failed")
        self.assertEqual(result.stdout.strip(), tenant_pi._kit_commit())


if __name__ == "__main__":
    unittest.main()
