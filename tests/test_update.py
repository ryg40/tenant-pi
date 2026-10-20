"""The read-only `update` action: verdict, digest comparison and drift, package lines, clone state, and no write."""
import ast
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
from io import StringIO
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts import tenant_pi
from scripts.validate import load
from tests.support import slow

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
MANIFEST = load(ROOT / "config/manifest.json")
PIN = MANIFEST["runtime"]["piVersion"]
FAST = "python3 scripts/check.py --tier fast"
TODAY = datetime(2026, 10, 20, 8, 0, 0, tzinfo=timezone.utc)
RELEASE = {"path": str(ROOT), "commit": "a" * 40, "tag": "portable/20261020-aaaaaaa", "clean": True,
           "tests": "none needed", "releaseNotes": "Portable snapshot of aaaaaaa"}
GIT = ("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
       "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false")
CLONE_STATE = tenant_pi._clone_state
ROUTED = {"interactive": {"provider": "example", "model": "org/model", "thinking": "high"}}


def snapshot(*roots):
    """Mode, size and modification time of each path under the roots: a write or a new entry changes the result."""
    found = {}
    for root in roots:
        for directory, directories, files in os.walk(root):
            for path in [directory, *(os.path.join(directory, name) for name in directories + files)]:
                info = os.lstat(path)
                found[path] = (info.st_mode, info.st_size, info.st_mtime_ns)
    return found


def git_repo(path):
    """A temporary Git clone with one commit and an ignored `node_modules/`."""
    path.mkdir()
    subprocess.run([*GIT, "init", "-q"], cwd=path, check=True, capture_output=True)
    (path / ".gitignore").write_text("node_modules/\n")
    (path / "README.md").write_text("kit\n")
    subprocess.run([*GIT, "add", "."], cwd=path, check=True, capture_output=True)
    subprocess.run([*GIT, "commit", "-q", "-m", "first"], cwd=path, check=True, capture_output=True)
    return path


class UpdateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-update-")
        self.addCleanup(temp.cleanup)
        # The kit refuses a linked parent on purpose; the macOS temporary directory has one.
        self.base = Path(os.path.realpath(temp.name))
        self.home = self.base / "home"
        self.private = self.home / ".config/tenant-pi"
        self.parent = self.home / ".pi/profiles"
        for directory in (self.private, self.parent, self.base / "bin"):
            directory.mkdir(mode=0o700, parents=True)
        self.current = self.parent / "main"
        self.overlay = self.private / "overlay.json"
        self.launcher = self.private / "launch-main.sh"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.current)
        self.save()
        # Fixed version commands: the action never starts the real Pi in a test.
        self.tools = {"pi": self.stub("pi", PIN), "node": self.stub("node", "v24.21.0"),
                      "python": self.stub("python3", "Python 3.11.2")}
        # A call of `tenant_pi.main` reads `HOME`: the disposable one, never the real one.
        home = patch.dict(os.environ, {"HOME": str(self.home)})
        home.start()
        self.addCleanup(home.stop)
        release = patch.object(tenant_pi, "_clone_state", return_value=dict(RELEASE))
        release.start()
        self.addCleanup(release.stop)
        code, _ = self.main("generate", "--overlay", str(self.overlay), "--target", str(self.current),
                            "--launcher", str(self.launcher))
        self.assertEqual(0, code)

    def stub(self, name, output):
        path = self.base / "bin" / name
        path.write_text("#!/bin/sh\necho '" + output + "'\n")
        path.chmod(0o700)
        return str(path)

    def save(self):
        self.overlay.write_text(json.dumps(self.data), encoding="utf-8")

    def edit_state(self, change):
        """Apply `change` to the provenance record of the candidate in use."""
        state = self.current / ".tenant-pi/state.json"
        record = json.loads(state.read_text())
        change(record["provenance"])
        state.write_text(json.dumps(record))

    def route(self):
        """An overlay change that changes `settings.json`: model routing with an interactive role."""
        self.data["selection"]["enable"].append("model-routing")
        self.data["selection"]["disable"].remove("model-routing")
        self.data["roles"] = ROUTED
        self.save()

    def main(self, *argv):
        out = StringIO()
        with redirect_stdout(out):
            code = tenant_pi.main(list(argv), clock=lambda: TODAY)
        return code, out.getvalue()

    def update(self, *extra, tools=None):
        tools = {**self.tools, **(tools or {})}
        code, text = self.main("update", "--overlay", str(self.overlay),
                               *(item for key, path in tools.items() for item in ("--" + key, path)), *extra)
        return code, json.loads(text)

    def test_same_profile_keeps_the_candidate_and_exits_zero(self):
        code, result = self.update()
        self.assertEqual("summary", next(iter(result)))
        self.assertEqual((0, "same_profile", "same_profile: keep " + str(self.current) + "; no package line"),
                         (code, result["verdict"], result["summary"]))
        self.assertEqual({"path": str(self.launcher), "status": "same", "found": 1}, result["comparison"]["launcher"])
        self.assertEqual(([], []), (result["comparison"]["changes"], result["packages"]["lines"]))
        # Two launchers that name the candidate: the launcher is not checked, and the verdict stays.
        (self.private / "launch-copy.sh").write_bytes(self.launcher.read_bytes())
        code, result = self.update()
        self.assertEqual((0, "same_profile", {"path": None, "status": "not_checked", "found": 2}),
                         (code, result["verdict"], result["comparison"]["launcher"]))

    def test_a_launcher_name_outside_the_path_rule_is_skipped_and_paths_are_quoted(self):
        # A name with a newline would put a second line, outside the comment, into nextCommands.
        bad = self.private / "launch-x\necho INJECTED #.sh"
        self.launcher.rename(bad)
        code, result = self.update()
        self.assertEqual((0, {"path": None, "status": "not_checked", "found": 0}),
                         (code, result["comparison"]["launcher"]))
        self.assertFalse(any("INJECTED" in line or "\n" in line for line in result["nextCommands"]))
        # A space and a single quote are in the path rule: the path comes out quoted for the shell.
        named = self.private / "launch-it's main.sh"
        bad.rename(named)
        code, result = self.update()
        self.assertEqual(str(named), result["comparison"]["launcher"]["path"])
        quoted = shlex.quote(str(named))
        self.assertNotEqual(str(named), quoted)
        self.assertTrue(result["nextCommands"][-1].endswith(" " + quoted + "."), result["nextCommands"])

    def test_a_change_of_the_kit_metadata_alone_is_the_same_profile(self):
        manifest = json.loads(json.dumps(MANIFEST))
        manifest["components"]["core"]["configOwnership"]["boundary"] = "Another description of the same fields"
        path = self.base / "manifest.json"
        path.write_text(json.dumps(manifest))
        self.edit_state(lambda record: record.update(kitCommit="b" * 40))
        code, result = self.update("--manifest", str(path))
        self.assertEqual((0, "same_profile", []), (code, result["verdict"], result["comparison"]["changes"]))

    def test_pi_writes_are_drift_and_an_overlay_change_is_a_kit_change(self):
        # The first start of Pi and a /model inside Pi write into settings.json of the candidate.
        settings = self.current / "settings.json"
        written = json.loads(settings.read_text())
        written.update(deviceId="device-1", defaultModel="org/other")
        settings.write_text(json.dumps(written, indent=2))
        code, result = self.update()
        drift = [{"path": "settings.json", "change": "differs"}]
        self.assertEqual((0, "same_profile", None, [], drift), (code, result["verdict"], result["comparison"]["reason"],
                                                               result["comparison"]["changes"], result["comparison"]["drift"]))
        self.assertTrue(result["summary"].endswith("; drift in settings.json"))
        self.assertTrue(result["nextCommands"][0].startswith("# Drift in settings.json: Pi or the user changed"))
        self.assertNotIn("device-1", json.dumps(result))
        # A kit change still shows beside the drift.
        self.route()
        code, result = self.update()
        self.assertEqual((1, "new_candidate", "kit_changed", [{"path": "settings.json", "change": "differs"}], drift),
                         (code, result["verdict"], result["comparison"]["reason"], result["comparison"]["changes"],
                          result["comparison"]["drift"]))

    def test_a_candidate_without_digests_compares_its_choices_and_the_kit_commit(self):
        repo = git_repo(self.base / "repo")
        (repo / "config").mkdir()
        (repo / "config/manifest.json").write_text("{}\n")
        subprocess.run([*GIT, "add", "."], cwd=repo, check=True, capture_output=True)
        subprocess.run([*GIT, "commit", "-q", "-m", "manifest"], cwd=repo, check=True, capture_output=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
        self.edit_state(lambda record: (record.pop("outputDigests"), record.update(kitCommit=head)))
        note = "This candidate predates output digests; generate one new candidate; later updates compare exactly."
        with patch.object(tenant_pi, "_clone_state", return_value={**RELEASE, "path": str(repo)}):
            code, result = self.update()
            self.assertEqual((0, "same_profile", None, None), (code, result["verdict"], result["comparison"]["reason"],
                                                               result["comparison"]["drift"]))
            manifest = json.loads(json.dumps(MANIFEST))
            manifest["components"]["core"]["configOwnership"]["boundary"] = "Another description of the same fields"
            path = self.base / "manifest.json"
            path.write_text(json.dumps(manifest))
            code, result = self.update("--manifest", str(path))
            self.assertEqual((1, "new_candidate", "no_output_digests", [], note),
                             (code, result["verdict"], result["comparison"]["reason"], result["comparison"]["changes"],
                              result["comparison"]["note"]))
            self.assertEqual("# " + note, result["nextCommands"][0])
            self.assertTrue(result["summary"].startswith("new_candidate: no_output_digests; generate "))
            # A kit commit that is unknown or not in the clone, then a profile input changed after the recorded commit.
            for label, commit in (("unknown", "unknown"), ("not in the clone", "c" * 40)):
                with self.subTest(label):
                    self.edit_state(lambda record: record.update(kitCommit=commit))
                    self.assertEqual("no_output_digests", self.update()[1]["comparison"]["reason"])
            self.edit_state(lambda record: record.update(kitCommit=head))
            (repo / "config/manifest.json").write_text("{\"changed\": true}\n")
            self.assertEqual("no_output_digests", self.update()[1]["comparison"]["reason"])
            subprocess.run([*GIT, "commit", "-q", "-am", "manifest"], cwd=repo, check=True, capture_output=True)
            self.assertEqual("no_output_digests", self.update()[1]["comparison"]["reason"])

    @slow
    def test_a_settings_change_gives_a_new_candidate_and_lines_that_run(self):
        self.route()
        code, result = self.update()
        new = str(self.parent / "main-20261020")
        self.assertEqual((1, "new_candidate", new), (code, result["verdict"], result["newTarget"]))
        self.assertEqual([{"path": "settings.json", "change": "differs"}], result["comparison"]["changes"])
        lines = result["nextCommands"]
        order = ["# Edit ", " check-runtime ", " generate ", " baseline ", "/login", " check-baseline ", " compare ",
                 " results "]
        positions = [next(index for index, line in enumerate(lines) if part in line) for part in order]
        self.assertEqual(sorted(positions), positions)
        self.assertEqual(str(self.private / "launch-main-20261020.sh"), lines[positions[4] - 1])
        # After the overlay edit of the first line, the printed lines run as they are.
        self.data["target"]["agentDir"] = new
        self.save()
        python = self.base / "python"
        python.mkdir()
        (python / "python3").symlink_to(sys.executable)
        env = {**os.environ, "PATH": str(python) + os.pathsep + os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}
        for part in (" check-runtime ", " generate ", " compare "):
            line = next(line for line in lines if part in line)
            done = subprocess.run(["/bin/sh", "-c", line], env=env, capture_output=True, text=True)
            self.assertEqual(0, done.returncode, part + done.stderr)
        code, result = self.update()
        self.assertEqual((0, "same_profile", "same"), (code, result["verdict"], result["comparison"]["launcher"]["status"]))

    def test_missing_unreadable_and_extra_files_give_a_new_candidate(self):
        with self.subTest("missing candidate"):
            code, result = self.update("--current", str(self.parent / "absent"))
            self.assertEqual((1, "new_candidate", [{"path": ".", "change": "missing"}]),
                             (code, result["verdict"], result["comparison"]["changes"]))
        with self.subTest("extra file"):
            # The generation recorded a file that the new plan does not write.
            self.edit_state(lambda record: record["outputDigests"].update({"models.json": hashlib.sha256(b"{}\n").hexdigest()}))
            code, result = self.update()
            self.assertEqual((1, [{"path": "models.json", "change": "extra"}]), (code, result["comparison"]["changes"]))
        with self.subTest("unreadable file"):
            (self.current / "settings.json").rename(self.current / "settings.real")
            (self.current / "settings.json").symlink_to("settings.real")
            code, result = self.update()
            self.assertEqual("new_candidate", result["verdict"])
            self.assertIn({"path": "settings.json", "change": "unreadable"}, result["comparison"]["changes"])

    def test_the_npm_line_follows_the_installed_lock_file(self):
        package = self.base / "clone/packages/tenantext"
        (package / "node_modules").mkdir(parents=True)
        lock = {"name": "tenantext", "version": "1.0.0", "lockfileVersion": 3, "requires": True,
                "packages": {"": {"name": "tenantext", "version": "1.0.0"},
                             "node_modules/yaml": {"version": "2.8.1", "integrity": "sha512-a"}}}
        (package / "package-lock.json").write_text(json.dumps(lock))
        line = "npm --prefix " + str(package) + " ci --ignore-scripts"
        hidden = package / "node_modules/.package-lock.json"
        for installed, expected in ((None, [line]), ("2.8.0", [line]), ("2.8.1", [])):
            with self.subTest(installed=installed):
                if installed is not None:
                    packages = {"node_modules/yaml": {"version": installed, "integrity": "sha512-a"}}
                    hidden.write_text(json.dumps({**lock, "packages": packages}))
                checked = tenant_pi._package_check(self.base / "clone", "packages/tenantext")
                self.assertEqual((expected, None), (checked["lines"], checked["build"]))

    def test_the_promptr_build_line_follows_the_source_and_input_times(self):
        package = self.base / "clone/packages/promptr"
        source = package / "src/state/receipts.mts"
        output = package / "dist/src/state/receipts.mjs"
        # A compiler bump changes the lock file, a build input; a lock without dependencies needs no npm ci line.
        lock = package / "package-lock.json"
        source.parent.mkdir(parents=True)
        source.write_text("export {};\n")
        lock.write_text(json.dumps({"lockfileVersion": 3, "packages": {"": {"name": "promptr"}}}))
        line = "npm --prefix " + str(package) + " run build"
        steps = ((None, None, None, "not_built"), (1, 2, 1, "current"), (3, 2, 1, "source_newer"),
                 (1, 2, 3, "input_newer"))
        for source_time, output_time, input_time, reason in steps:
            with self.subTest(reason=reason):
                if source_time is not None:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_text("export {};\n")
                    for path, value in ((source, source_time), (output, output_time), (lock, input_time)):
                        os.utime(path, ns=(value * 10 ** 18, value * 10 ** 18))
                checked = tenant_pi._package_check(self.base / "clone", "packages/promptr")
                self.assertEqual(reason, checked["build"]["reason"] or checked["build"]["status"])
                self.assertEqual([line] if reason != "current" else [], checked["lines"])

    def test_the_clone_state_reads_the_tag_and_the_tree_without_a_write(self):
        repo = git_repo(self.base / "repo")
        state = CLONE_STATE(repo)
        self.assertEqual((None, True, FAST), (state["tag"], state["clean"], state["tests"]))
        self.assertNotIn("releaseNotes", state)
        subprocess.run([*GIT, "tag", "-a", "portable/20261020-abc1234", "-m",
                        "Portable snapshot of abc1234\n\nUpdate from portable/20261018-def5678: no new candidate"],
                       cwd=repo, check=True, capture_output=True)
        (repo / "node_modules").mkdir()
        (repo / "node_modules/module.js").write_text("ignored\n")
        # A tracked file with a new time: a plain `git status` writes a refreshed index here.
        later = time.time_ns() + 10 ** 10
        os.utime(repo / "README.md", ns=(later, later))
        before = snapshot(repo)
        state = CLONE_STATE(repo)
        self.assertEqual(before, snapshot(repo))
        self.assertEqual(("portable/20261020-abc1234", True, "none needed"), (state["tag"], state["clean"], state["tests"]))
        self.assertIn("Update from portable/20261018-def5678", state["releaseNotes"])
        (repo / "local.txt").write_text("a local change\n")
        state = CLONE_STATE(repo)
        self.assertEqual((False, FAST), (state["clean"], state["tests"]))

    def test_update_writes_nothing(self):
        repo = git_repo(self.base / "repo")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
        first = json.loads(json.dumps(self.data))
        with patch.object(tenant_pi, "_clone_state", lambda root: CLONE_STATE(repo)):
            # The last case reads a candidate without digests: the Git calls of the profile inputs run too.
            for routed, digests in ((False, True), (True, True), (False, False)):
                with self.subTest(routed=routed, digests=digests):
                    self.data = json.loads(json.dumps(first))
                    self.save()
                    if routed:
                        self.route()
                    if not digests:
                        self.edit_state(lambda record: (record.pop("outputDigests"), record.update(kitCommit=head)))
                    before = snapshot(self.home, repo)
                    code, result = self.update()
                    self.assertEqual(before, snapshot(self.home, repo))
                    self.assertEqual("new_candidate" if routed else "same_profile", result["verdict"])

    def test_a_runtime_outside_the_range_needs_an_action(self):
        code, result = self.update(tools={"pi": self.stub("pi-old", "1.2.0"), "node": str(self.base / "absent-node")})
        self.assertEqual((1, "runtime_action_needed", "runtime_action_needed: pi 1.2.0 mismatch; node missing"),
                         (code, result["verdict"], result["summary"]))
        lines = result["nextCommands"]
        self.assertIn("npm install --global -- " + MANIFEST["components"]["core"]["source"]["spec"], lines)
        self.assertTrue(any(line.startswith("# ") and "node@24" in line for line in lines))
        self.assertIn(" update ", lines[-1])

    def test_an_old_python_stops_with_one_line(self):
        # The guard must run on Python 3.9, so the file uses no newer syntax.
        ast.parse(CLI.read_text(encoding="utf-8"), feature_version=(3, 9))
        code = ("import runpy, sys\nsys.version_info = (3, 9, 6, 'final', 0)\n"
                "runpy.run_path(" + repr(str(CLI)) + ", run_name='__main__')\n")
        done = subprocess.run([sys.executable, "-c", code, "update"], capture_output=True, text=True,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual((1, ""), (done.returncode, done.stdout))
        self.assertEqual(1, len(done.stderr.splitlines()))
        self.assertIn("3.11", done.stderr)


if __name__ == "__main__":
    unittest.main()
