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
        self.root = Path(self.directory.name).resolve()
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

    def test_stamp_path_git_failure_keeps_checks_green(self):
        real_run = check.run
        def failed_git(command, root, env=None, timeout=None):
            if "--git-common-dir" in command:
                return subprocess.CompletedProcess(command, 1, stdout="", stderr="fixture failure")
            return real_run(command, root, env, timeout=timeout)

        with patch.object(check, "run", side_effect=failed_git) as run:
            code, lines, err = self.invoke()
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[-2:], [
            "stamp: not written (OSError: Git metadata is unavailable)", "check: passed"])
        self.assertEqual(sum("--git-common-dir" in call.args[0] for call in run.call_args_list), 2)
        self.assertEqual(err, "")
        self.assertEqual(self.stamps(), [])

    def test_shard_timeout_fails_run_without_stamp_and_keeps_other_checks(self):
        (self.root / "tests/test_sleep.py").write_text(
            "import time, unittest\nclass Sleep(unittest.TestCase):\n"
            "    def test_sleep(self): time.sleep(10)\n")
        self.commit()
        code, lines, err = self.invoke("--jobs", "1", "--shard-timeout", "0.5")
        self.assertEqual(code, 1)
        self.assertEqual(lines[1:], ["FAILED", "publish: passed", "public: passed",
                                    "diff: passed", "check: FAILED"])
        self.assertIn("unittest tests.test_sleep: FAILED (timed out after 0.5s)", err)
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
        self.assertEqual(self.invoke("--stamp-status"),
                         (1, ["stamp: not available (not a Git work tree)"], ""))

    def test_no_git_fast_tier_reports_no_stamp(self):
        (self.root / ".git").rename(self.root / "git-metadata")
        code, lines, err = self.invoke("--tier", "fast")
        self.assertEqual(code, 0, err)
        self.assertEqual(lines[-2:], ["stamp: not written (not a Git work tree)", "check: passed"])
        self.assertEqual(err, "")

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

    def test_default_jobs_timeout_and_explicit_overrides(self):
        with patch.object(check, "default_jobs", return_value=3), \
                patch.object(check, "checks", return_value=0) as checks:
            self.assertEqual(self.invoke()[0], 0)
            checks.assert_called_once_with(self.root, "full", 3, 900)
            checks.reset_mock()
            self.assertEqual(self.invoke("--jobs", "5", "--shard-timeout", "1.5")[0], 0)
            checks.assert_called_once_with(self.root, "full", 5, 1.5)

    def test_nonpositive_jobs_and_invalid_timeout_are_refused(self):
        for args in (["--jobs", "0"], *(["--shard-timeout", value]
                     for value in ("0", "-1", "nan", "inf", "bad"))):
            with self.subTest(args=args), redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as error:
                check.main(args, root=self.root)
            self.assertEqual(error.exception.code, 2)

    def test_excessive_shard_timeout_is_refused_before_checks(self):
        err = io.StringIO()
        with redirect_stderr(err), patch.object(check, "checks") as checks, \
                self.assertRaises(SystemExit) as error:
            check.main(["--shard-timeout", "1e30"], root=self.root)
        self.assertEqual(error.exception.code, 2)
        self.assertIn("error: argument --shard-timeout:", err.getvalue())
        self.assertIn("at most 86400 seconds", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())
        checks.assert_not_called()

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


class CpuLimitTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.membership = self.root / "membership"

    def quota(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def test_cgroup_v2_nested_and_parent_limits(self):
        self.membership.write_text("0::/user.slice/task.scope\n")
        self.quota("cpu.max", "max 100000\n")
        self.quota("user.slice/cpu.max", "200000 100000\n")
        self.quota("user.slice/task.scope/cpu.max", "400000 100000\n")
        self.assertEqual(check.cgroup_jobs(self.root, self.membership), 2)
        self.quota("user.slice/task.scope/cpu.max", "50000 100000\n")
        self.assertEqual(check.cgroup_jobs(self.root, self.membership), 1)
        self.quota("user.slice/task.scope/cpu.max", "150000 100000\n")
        self.assertEqual(check.cgroup_jobs(self.root, self.membership), 2)

    def test_cgroup_v1_mount_names_and_unlimited_quota(self):
        self.membership.write_text("2:cpu,cpuacct:/job\n3:memory:/ignored\n")
        for mount in ("cpu", "cpu,cpuacct"):
            with self.subTest(mount=mount):
                self.quota(f"{mount}/job/cpu.cfs_quota_us", "250000\n")
                self.quota(f"{mount}/job/cpu.cfs_period_us", "100000\n")
                self.assertEqual(check.cgroup_jobs(self.root, self.membership), 3)
                self.quota(f"{mount}/job/cpu.cfs_quota_us", "-1\n")
                self.assertIsNone(check.cgroup_jobs(self.root, self.membership))

    def test_cgroup_root_limit_without_membership(self):
        self.quota("cpu.max", "200000 100000\n")
        self.assertEqual(check.cgroup_jobs(self.root, self.membership), 2)

    def test_missing_unlimited_malformed_and_unreadable_limits_are_ignored(self):
        self.assertIsNone(check.cgroup_jobs(self.root, self.membership))
        for text in ("max 100000", "bad", "0 100000", "100000 0", "bad 100000", "\xff"):
            with self.subTest(text=text):
                self.quota("cpu.max", text)
                self.assertIsNone(check.cgroup_jobs(self.root, self.membership))
        with patch.object(Path, "read_text", side_effect=PermissionError):
            self.assertIsNone(check.cgroup_jobs(self.root, self.membership))

    def test_default_jobs_uses_the_smallest_available_cpu_limit(self):
        for cpu, affinity, quota, expected in ((8, {0, 1}, None, 2), (8, set(range(8)), 3, 3),
                                              (8, {0, 1}, 3, 2), (2, set(range(8)), 4, 2),
                                              (None, {0, 1}, None, 1)):
            with self.subTest(cpu=cpu, affinity=affinity, quota=quota), \
                    patch.object(check.os, "cpu_count", return_value=cpu), \
                    patch.object(check.os, "sched_getaffinity", return_value=affinity, create=True), \
                    patch.object(check, "cgroup_jobs", return_value=quota):
                self.assertEqual(check.default_jobs(), expected)

    def test_default_jobs_without_affinity_support(self):
        for error in (AttributeError, OSError):
            with self.subTest(error=error), patch.object(check.os, "cpu_count", return_value=4), \
                    patch.object(check.os, "sched_getaffinity", side_effect=error, create=True), \
                    patch.object(check, "cgroup_jobs", return_value=None):
                self.assertEqual(check.default_jobs(), 4)
