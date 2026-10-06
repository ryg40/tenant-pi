"""Update pipeline tests use fake npm/Pi executables and a loopback endpoint only."""
import contextlib
import io
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import pi_update as update

ROOT = Path(__file__).resolve().parents[1]
PIN = json.loads((ROOT / "config/manifest.json").read_text())["runtime"]["piVersion"]

FAKE_PI = '''import json, os, pathlib, sys, urllib.request
home = pathlib.Path(os.environ["HOME"])
with (home / "pi-env.jsonl").open("a") as out:
    out.write(json.dumps(dict(os.environ)) + "\\n")
agent = pathlib.Path(os.environ["PI_CODING_AGENT_DIR"])
if "--version" in sys.argv:
    assert not list(agent.iterdir())
    print(VERSION)
else:
    assert "--provider" in sys.argv and "local-test" in sys.argv
    models = json.loads((agent / "models.json").read_text())
    url = models["providers"]["local-test"]["baseUrl"] + "/chat/completions"
    request = urllib.request.Request(url, data=json.dumps({"model":"sum-model", "stream":True}).encode())
    with urllib.request.urlopen(request) as response:
        assert b'43' in response.read()
    print("43")
'''

FAKE_NPM = '''import json, pathlib, sys
args = sys.argv[1:]
control = pathlib.Path(__file__).parent
with (control / "calls.jsonl").open("a") as out:
    out.write(json.dumps(args) + "\\n")
if "install" in args:
    if (control / "fail-install").exists():
        sys.exit(9)
    prefix = pathlib.Path(args[args.index("--prefix") + 1])
    modules = prefix / "node_modules"
    scope = modules / "@earendil-works"
    for name in ("pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"):
        path = scope / name
        path.mkdir(parents=True)
        (path / "package.json").write_text(json.dumps({"version": VERSION}))
    (scope / "pi-coding-agent/CHANGELOG.md").write_text("## [1.0.3] - example\\n### Fixed\\nA fix.\\n### Breaking Changes\\nAn API changed.\\n## [1.0.2] - example\\nOlder.\\n")
    binary = modules / ".bin/pi"
    binary.parent.mkdir()
    binary.write_text(PI_SCRIPT)
    binary.chmod(0o700)
elif "ci" in args:
    pathlib.Path("node_modules").mkdir(exist_ok=True)
elif "test" in args and (control / "fail-test").exists():
    sys.exit(7)
'''


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-update-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "caller-home"
        self.live = self.home / ".pi/agent"
        self.live.mkdir(parents=True)
        (self.live / "auth.json").write_text("synthetic-canary")
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.work = self.base / "work"
        pi_script = "#!" + sys.executable + "\nVERSION = " + repr(PIN) + "\n" + FAKE_PI
        npm_script = ("#!" + sys.executable + "\nVERSION = " + repr(PIN) + "\nPI_SCRIPT = " + repr(pi_script) + "\n" + FAKE_NPM)
        (self.bin / "npm").write_text(npm_script)
        (self.bin / "npm").chmod(0o700)
        # check-runtime tests the real Python, but does not need the caller's Node version.
        (self.bin / "node").write_text("#!/bin/sh\nprintf '22.22.3\\n'\n")
        (self.bin / "node").chmod(0o700)
        self.env = patch.dict(os.environ, {"HOME": str(self.home), "PATH": str(self.bin) + ":/usr/bin:/bin",
                             "OPENAI_API_KEY": "synthetic-canary", "NODE_OPTIONS": "synthetic-canary",
                             "PI_CODING_AGENT_DIR": str(self.live), "PI_CODING_AGENT_SESSION_DIR": str(self.live)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def qualify(self, requested=PIN, **kwargs):
        # Do not recursively launch this test suite from the qualification unit test.
        offline = (("offline-fixture", ["-c", "print('offline fixture')"]),)
        with patch.object(update, "OFFLINE", offline):
            return update.qualify(requested, str(self.work), **kwargs)

    def test_detect_no_new_and_new_exit_codes(self):
        for newest, code in ((PIN, 0), ("99.0.0", 10)):
            calls = []
            def latest(name):
                calls.append(name)
                return newest
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(update.main(["detect"], latest=latest), code)
            report = json.loads(out.getvalue())
            self.assertEqual(calls[0], update.PACKAGE)
            self.assertEqual(report["core"]["pinned"], PIN)
            self.assertEqual(report["new"], code == 10)
            self.assertEqual(len(report["modules"]), 3)
            self.assertTrue(all(row["different"] is None for row in report["modules"]))

    def test_qualify_environment_links_and_baseline(self):
        before = update._dir_state(str(self.live), "test")
        report = self.qualify()
        self.assertTrue(report["passed"], report)
        run = Path(report["workdir"])
        rows = [json.loads(line) for line in (run / "home/pi-env.jsonl").read_text().splitlines()]
        self.assertEqual(len(rows), 2)
        for child in rows:
            self.assertEqual(set(child), set(update.PI_KEYS))
            self.assertTrue(Path(child["HOME"]).is_relative_to(run))
            self.assertTrue(Path(child["TMPDIR"]).is_relative_to(run))
            self.assertTrue(Path(child["PI_CODING_AGENT_DIR"]).is_relative_to(run))
            self.assertNotIn("synthetic-canary", json.dumps(child))
        self.assertFalse(Path(rows[0]["PI_CODING_AGENT_DIR"]).exists())
        self.assertEqual(before, update._dir_state(str(self.live), "test"))
        for package in ("tenantext", "promptr"):
            link = run / "packages" / package / "node_modules/@earendil-works/pi-coding-agent"
            self.assertEqual(link.resolve(), run / "prefix/node_modules" / update.PACKAGE)
        for step in report["steps"]:
            self.assertTrue(Path(step["log"]).is_file())
        self.assertEqual((run / "logs/print-mode.log").read_text(), "43\n")
        calls = [json.loads(line) for line in (self.bin / "calls.jsonl").read_text().splitlines()]
        self.assertEqual(sum("ci" in call for call in calls), 2)
        self.assertTrue(all("--ignore-scripts" in call for call in calls if "ci" in call or "install" in call))
        self.assertTrue(all("--global" not in call for call in calls))

    def test_candidate_uses_new_pin_without_changing_checkout(self):
        requested = "99.0.0"
        npm = self.bin / "npm"
        npm.write_text(npm.read_text().replace(PIN, requested))
        before = {name: (ROOT / name).read_bytes() for name in ("config/manifest.json", "scripts/validate.py")}
        report = self.qualify(requested)
        self.assertTrue(report["passed"], report)
        candidate = Path(report["workdir"]) / "kit"
        data = json.loads((candidate / "config/manifest.json").read_text())
        self.assertEqual(data["runtime"]["piVersion"], requested)
        self.assertEqual(data["components"]["core"]["source"]["spec"], update.PACKAGE + "@" + requested)
        for name, content in before.items():
            self.assertEqual((ROOT / name).read_bytes(), content)
        self.assertFalse((candidate / ".git").exists())
        self.assertFalse((candidate / ".local").exists())
        runtime = json.loads((Path(report["workdir"]) / "logs/check-runtime.log").read_text())
        self.assertEqual(runtime["pi"]["required"], requested)
        self.assertEqual(runtime["pi"]["status"], "match")

    def test_baseline_drift_is_informational_unless_strict(self):
        real_scan = update._dir_state
        def changed_scan(path, field):
            state = real_scan(path, field)
            if getattr(changed_scan, "seen", False):
                state["entries"][0]["mtimeNs"] += 1
            changed_scan.seen = True
            return state
        for strict in (False, True):
            changed_scan.seen = False
            with patch.object(update, "_dir_state", side_effect=changed_scan):
                report = self.qualify(strict_baseline=strict)
            self.assertEqual(report["passed"], not strict)
            self.assertEqual(report["isolation"], "changed_unattributed")
            self.assertEqual(report["changedEntries"], ["auth.json"])
            self.assertEqual(report["strictBaseline"], strict)

    def test_endpoint_rejects_malformed_requests_without_traceback(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), update.endpoint() as (port, calls):
            for length, body in (("bad", b""), ("1", b"{"), ("2", b"[]"), ("1", b"\xff")):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                connection.request("POST", "/v1/chat/completions", body=body, headers={"Content-Length": length})
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                response.read()
                connection.close()
            self.assertEqual(calls, [])
        self.assertEqual(errors.getvalue(), "")

    def test_failed_install_continues_independent_steps(self):
        (self.bin / "fail-install").touch()
        report = self.qualify()
        self.assertFalse(report["passed"])
        codes = {step["name"]: step["exitCode"] for step in report["steps"]}
        self.assertEqual(codes["install"], 9)
        self.assertEqual(codes["check-runtime"], 125)
        self.assertEqual(codes["offline-fixture"], 0)
        self.assertEqual(codes["generate"], 0)
        self.assertEqual(codes["print-mode"], 125)
        self.assertEqual(codes["baseline-compare"], 0)

    def test_failed_test_continues_print_mode(self):
        (self.bin / "fail-test").touch()
        report = self.qualify()
        self.assertFalse(report["passed"])
        codes = {step["name"]: step["exitCode"] for step in report["steps"]}
        self.assertEqual(codes["tenantext-test"], 7)
        self.assertEqual(codes["promptr-test"], 7)
        self.assertEqual(codes["print-response"], 0)

    def test_notes_breaking_first_from_fake_npm(self):
        report = update.notes("1.0.2", "1.0.3", str(self.work))
        self.assertTrue(report["passed"])
        self.assertTrue(report["breaking"])
        self.assertTrue(report["entries"][0]["text"].startswith("### Breaking Changes"))
        self.assertTrue(report["entries"][1]["text"].startswith("### Fixed"))
        self.assertEqual({row["version"] for row in report["entries"]}, {"1.0.3"})

    def test_notes_bounds_and_no_breaking(self):
        text = "## [1.0.3]\n### Fixed\nNew.\n## [1.0.2]\nOld.\n"
        self.assertFalse(update.changelog_entries(text, "1.0.2", "1.0.3")["breaking"])
        self.assertEqual(update.changelog_entries(text, "1.0.3", "1.0.3")["entries"], [])
        for start, end in (("1.0.0", "1.0.3"), ("1.0.3", "1.0.2")):
            with self.assertRaisesRegex(update.Invalid, "notes_range"):
                update.changelog_entries(text, start, end)

    def test_static_errors_and_protected_paths(self):
        for args in (["unknown"], ["qualify", "--version", "bad", "--workdir", str(self.work)],
                     ["qualify", "--version", PIN, "--workdir", str(self.live / "nested")],
                     ["qualify", "--version", PIN, "--workdir", str(ROOT / ".local/update")]):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(update.main(args), 2)
            self.assertNotIn(str(self.live), out.getvalue())
            self.assertIn("error", json.loads(out.getvalue()))
        self.assertFalse(self.work.exists())
        self.assertFalse((self.bin / "calls.jsonl").exists())

    def test_symlink_workdir_is_refused(self):
        self.work.symlink_to(self.home, target_is_directory=True)
        with self.assertRaisesRegex(update.Invalid, "unsafe_path"):
            update.workspace(str(self.work))

    def test_git_failures_have_a_step_log_and_one_json_result(self):
        source = self.base / "source"
        (source / ".git").mkdir(parents=True)
        cases = (
            (FileNotFoundError("synthetic-canary"), "git_unavailable", 127),
            (subprocess.TimeoutExpired(["git"], 30, stderr=b"synthetic-canary"), "git_timeout", 124),
            (subprocess.SubprocessError("synthetic-canary"), "git_failed", 1),
            (subprocess.CompletedProcess(["git"], 128, b"", b"dubious ownership synthetic-canary"), "git_failed", 128),
        )
        for outcome, error, code in cases:
            with self.subTest(error=error, code=code):
                out, err = io.StringIO(), io.StringIO()
                with patch.object(update, "ROOT", source), patch.object(update.subprocess, "run") as run:
                    if isinstance(outcome, Exception):
                        run.side_effect = outcome
                    else:
                        run.return_value = outcome
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        status = update.main(["qualify", "--version", PIN, "--workdir", str(self.work)])
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(run.call_args.args[0], ["git", "ls-files", "-z"])
                self.assertEqual(status, 1)
                self.assertEqual(err.getvalue(), "")
                self.assertEqual(len(out.getvalue().splitlines()), 1)
                report = json.loads(out.getvalue())
                self.assertFalse(report["passed"])
                steps = {step["name"]: step for step in report["steps"]}
                self.assertEqual(steps["candidate-copy"]["exitCode"], code)
                self.assertEqual(json.loads(Path(steps["candidate-copy"]["log"]).read_text()), {"error": error})
                self.assertEqual(steps["baseline-compare"]["exitCode"], 0)
                self.assertNotIn("install", steps)
                self.assertNotIn("synthetic-canary", out.getvalue())
                for step in report["steps"]:
                    self.assertTrue(Path(step["log"]).is_file())
                    self.assertNotIn("synthetic-canary", Path(step["log"]).read_text())

    def test_main_qualify_failure_exit(self):
        with patch.object(update, "qualify", return_value={"passed": False}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(update.main(["qualify", "--version", PIN, "--workdir", str(self.work)]), 1)

    def test_timeout_is_reported(self):
        log = self.base / "timeout.log"
        code = update.execute([sys.executable, "-c", "import time; time.sleep(5)"],
                              cwd=self.base, env={}, log=log, timeout=0.05)
        self.assertEqual(code, 124)
        self.assertIn("step_timeout", log.read_text())


if __name__ == "__main__":
    unittest.main()
