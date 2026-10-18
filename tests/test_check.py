"""Check-runner contracts against small, independent Git fixtures."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import check


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "tests").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "tests/__init__.py").write_text("")
        (self.root / "tests/test_one.py").write_text(
            "import os, unittest\n"
            "class One(unittest.TestCase):\n"
            "    def test_pass(self): self.assertTrue(True)\n"
            "    @unittest.skip('fixture')\n"
            "    def test_skip(self): pass\n"
            "    @unittest.skipIf(os.environ.get('TENANT_PI_TIER') == 'fast', 'release tier')\n"
            "    def test_release(self): pass\n")
        (self.root / "tests/test_two.py").write_text(
            "import unittest\nclass Two(unittest.TestCase):\n"
            "    def test_pass(self): self.assertTrue(True)\n")
        (self.root / "scripts/publish_check.py").write_text("print('fixture publish valid')\n")
        self.git("init", "-q")
        self.commit()

    def git(self, *args):
        return subprocess.run(("git", *args), cwd=self.root, capture_output=True,
                              text=True, check=True).stdout.strip()

    def commit(self):
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")

    def invoke(self, *args, root=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = check.main(list(args), root=self.root if root is None else root)
        return code, out.getvalue().splitlines(), err.getvalue()

    def stamps(self):
        return list((self.root / ".git/check-stamps").glob("*"))

    def test_full_result_lines_stamp_and_matching_status(self):
        code, lines, err = self.invoke("--jobs", "2")
        self.assertEqual(code, 0, err)
        self.assertRegex(lines[0], r"^Ran 4 tests in \d+\.\d{3}s$")
        self.assertEqual(lines[1:], ["OK (skipped=1)", "publish: passed",
                                   "public: passed", "diff: passed", "check: passed"])
        tree = self.git("rev-parse", "HEAD^{tree}")
        self.assertEqual([p.name for p in self.stamps()], [tree])
        stamp = json.loads(self.stamps()[0].read_text())
        self.assertEqual(set(stamp), {"checkSetVersion", "python", "client", "skipped",
                                     "tests", "resultLines", "when"})
        self.assertEqual(stamp["tests"], 4)
        self.assertEqual(stamp["skipped"], 1)
        self.assertEqual(stamp["resultLines"], lines)
        self.assertEqual(self.invoke("--stamp-status")[:2], (0, ["stamp: matches"]))

    def test_stamp_directory_failure_keeps_checks_green(self):
        directory = self.root / ".git/check-stamps"
        directory.write_text("not a directory\n")
        tree = self.git("rev-parse", "HEAD^{tree}")
        code, lines, err = self.invoke()
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[-2:], [
            f"stamp: not written (FileExistsError: {directory / tree})", "check: passed"])
        self.assertEqual(err, "")
        self.assertEqual(self.stamps(), [])
        self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_stamp_write_failure_keeps_checks_green(self):
        tree = self.git("rev-parse", "HEAD^{tree}")
        path = self.root / ".git/check-stamps" / tree
        with patch.object(Path, "write_text", side_effect=PermissionError):
            code, lines, err = self.invoke()
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[-2:], [
            f"stamp: not written (PermissionError: {path})", "check: passed"])
        self.assertEqual(err, "")
        self.assertEqual(self.stamps(), [])

    def test_discovery_includes_modules_without_underscore(self):
        (self.root / "tests/testextra.py").write_text(
            "import unittest\nclass Extra(unittest.TestCase):\n"
            "    def test_pass(self): self.assertTrue(True)\n")
        self.commit()
        code, lines, err = self.invoke()
        self.assertEqual(code, 0, err)
        self.assertRegex(lines[0], r"^Ran 5 tests in ")

    def test_no_git_runs_units_and_publish_checks_without_stamp(self):
        (self.root / ".git").rename(self.root / "git-metadata")
        code, lines, err = self.invoke()
        self.assertEqual(code, 0, err)
        self.assertRegex(lines[0], r"^Ran 4 tests in ")
        self.assertEqual(lines[1:], ["OK (skipped=1)", "publish: passed", "public: passed",
                                    "diff: skipped (not a Git work tree)",
                                    "stamp: not written (not a Git work tree)", "check: passed"])
        self.assertFalse((self.root / ".git").exists())
        self.assertFalse((self.root / "git-metadata/check-stamps").exists())
        for path in ("tests/test_two.py", "scripts/publish_check.py"):
            with self.subTest(path=path):
                target = self.root / path
                original = target.read_text()
                target.write_text("raise RuntimeError('fixture failure')\n")
                code, lines, _ = self.invoke()
                self.assertEqual(code, 1)
                self.assertEqual(lines[-1], "check: FAILED")
                target.write_text(original)
        self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_no_stamp_on_unit_failure(self):
        path = self.root / "tests/test_two.py"
        path.write_text(path.read_text().replace("self.assertTrue(True)", "self.fail('fixture failure')"))
        self.commit()
        code, lines, err = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(lines[1], "FAILED")
        self.assertEqual(lines[-1], "check: FAILED")
        self.assertIn("fixture failure", err)
        self.assertEqual(self.stamps(), [])

    def test_no_stamp_on_command_failure(self):
        (self.root / "scripts/publish_check.py").write_text("raise SystemExit(1)\n")
        self.commit()
        code, lines, _ = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn("publish: FAILED", lines)
        self.assertIn("public: FAILED", lines)
        self.assertEqual(self.stamps(), [])

    def test_no_stamp_on_dirty_tree(self):
        (self.root / "untracked").write_text("dirty\n")
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.stamps(), [])
        self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_no_stamp_in_fast_tier(self):
        code, lines, err = self.invoke("--tier", "fast")
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[1], "OK (skipped=2)")
        self.assertEqual(self.stamps(), [])

    def test_explicit_full_overrides_inherited_fast(self):
        with patch.dict(os.environ, {"TENANT_PI_TIER": "fast"}):
            code, lines, err = self.invoke("--tier", "full")
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[1], "OK (skipped=1)")
        self.assertEqual(len(self.stamps()), 1)

    def test_nonmatching_tree_and_dirty_status(self):
        self.assertEqual(self.invoke()[0], 0)
        (self.root / "new-file").write_text("new tree\n")
        self.assertEqual(self.invoke("--stamp-status")[0], 1)
        self.commit()
        self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_stale_version_and_corrupt_stamp(self):
        self.assertEqual(self.invoke()[0], 0)
        path = self.stamps()[0]
        stamp = json.loads(path.read_text())
        stamp["checkSetVersion"] += 1
        path.write_text(json.dumps(stamp))
        self.assertEqual(self.invoke("--stamp-status")[0], 1)
        for text in ("not json", "[]", "null"):
            path.write_text(text)
            self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_changed_client_does_not_match(self):
        self.assertEqual(self.invoke()[0], 0)
        with patch.object(check, "client", return_value={"root": "different"}):
            self.assertEqual(self.invoke("--stamp-status")[0], 1)

    def test_missing_summary_and_process_failure_fail_closed(self):
        for code, stderr in ((0, ""), (0, "Ran 1 test in 0.001s\nFAILED (errors=1)\n"),
                             (2, "Ran 1 test in 0.001s\nOK\n")):
            result = subprocess.CompletedProcess([], code, stdout="", stderr=stderr)
            self.assertFalse(check.unit_summary(result)[2])

    def test_empty_test_inventory_fails(self):
        with patch.object(Path, "glob", return_value=iter(())):
            code, lines, _ = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(lines[1], "FAILED")
        self.assertEqual(self.stamps(), [])

    def test_default_jobs_and_nonpositive_jobs(self):
        with patch.object(check.os, "cpu_count", return_value=3), \
                patch.object(check, "checks", return_value=0) as checks:
            self.assertEqual(self.invoke()[0], 0)
            checks.assert_called_once_with(self.root, "full", 3)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            check.main(["--jobs", "0"], root=self.root)
        self.assertEqual(error.exception.code, 2)

    def test_tree_changed_during_checks_does_not_get_stamp(self):
        before = check.clean_tree(self.root)
        with patch.object(check, "clean_tree", side_effect=[before, None]):
            self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.stamps(), [])

    def assert_shared_stamp(self, from_linked):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        linked = Path(directory.name) / "linked"
        self.git("worktree", "add", "--detach", str(linked))
        tree = check.clean_tree(linked)
        self.assertEqual(tree, check.clean_tree(self.root))
        self.assertEqual(check.stamp_path(linked, tree),
                         self.root / ".git/check-stamps" / tree)
        self.assertTrue((linked / ".git").is_file())
        source, destination = (linked, self.root) if from_linked else (self.root, linked)
        self.assertEqual(self.invoke("--stamp-status", root=destination)[0], 1)
        code, lines, err = self.invoke(root=source)
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[-1], "check: passed")
        self.assertEqual([path.name for path in self.stamps()], [tree])
        self.assertEqual(self.invoke("--stamp-status", root=destination)[:2],
                         (0, ["stamp: matches"]))

    def test_linked_stamp_matches_in_main_worktree(self):
        self.assert_shared_stamp(from_linked=True)

    def test_main_stamp_matches_in_linked_worktree(self):
        self.assert_shared_stamp(from_linked=False)

    def test_common_directory_fallback_for_older_git(self):
        real_run = check.run
        for result in (subprocess.CompletedProcess([], 129, stdout="", stderr="unknown option"),
                       subprocess.CompletedProcess([], 0, stdout="--path-format=absolute\n.git\n")):
            with self.subTest(returncode=result.returncode):
                def old_git(command, root, env=None):
                    if "--path-format=absolute" in command:
                        return result
                    return real_run(command, root, env)

                with patch.object(check, "run", side_effect=old_git):
                    self.assertEqual(check.stamp_path(self.root, "tree"),
                                     self.root / ".git/check-stamps/tree")
