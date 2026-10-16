"""Public wizard, file boundaries and automated PTY trials. No live installation."""
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import pwd
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from unittest.mock import patch

from scripts import models_input, tenant_pi
from scripts.check_runtime import check
from scripts.validate import Invalid
from scripts.wizard_state import State, fresh
from scripts.wizard_scan import scan

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
MANIFEST = json.loads((ROOT / "config/manifest.json").read_text())


class WizardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wizard fixture ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.target = self.home / "new profile"
        self.private = self.home / "private choices"
        self.identity = {"destination": "local", "account": pwd.getpwuid(os.geteuid()).pw_name,
                         "home": str(self.home), "target": str(self.target), "clone": str(ROOT), "sshTarget": None}
        def fake(argv, **kwargs):
            version = {"pi": "1.3.1", "node": "v24.1.0", "python3": "Python 3.11.2"}[Path(argv[0]).name]
            return subprocess.CompletedProcess(argv, 0, version.encode(), b"")
        runtime = check(MANIFEST["runtime"], run=fake, which=lambda name: "/fixture/" + name, environ={})
        self.evidence = {"schemaVersion": 1, "identity": self.identity, "runtime": runtime,
                         "components": {key: "compatible" if key == "core" else "unknown" for key in MANIFEST["components"]}, "targetAbsent": True}
        self.file = self.root / "evidence.json"
        self.file.write_text(json.dumps(self.evidence))
        self.env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
        self.args = [sys.executable, str(CLI), "wizard", "--account", self.identity["account"], "--home", str(self.home),
                     "--target", str(self.target), "--private-dir", str(self.private), "--evidence", str(self.file)]

    def cli(self, args=None, data=""):
        return subprocess.run(args or self.args, input=data, text=True, capture_output=True, env=self.env, timeout=15)

    def state(self):
        return State(MANIFEST, self.identity, scan=self.evidence)

    def test_data_defaults_manifest_and_no_writes(self):
        result = self.cli([*self.args, "--format", "json"])
        self.assertEqual(0, result.returncode, result.stderr)
        data = json.loads(result.stdout)
        self.assertNotIn("\x1b", result.stdout)
        rows = data["components"]
        self.assertEqual(list(MANIFEST["components"]), [row["id"] for row in rows])
        self.assertEqual(["core"], [row["id"] for row in rows if row["marked"]])
        self.assertEqual("Core features", rows[0]["group"])
        self.assertEqual("reuse", rows[0]["action"])
        self.assertFalse(self.private.exists())
        self.assertFalse(self.target.exists())

    def test_state_dependencies_reuse_and_approval_invalidation(self):
        state = self.state()
        state.toggle("ops-footer")
        self.assertIn("context-meter", state.selected)
        self.assertIn("context-meter", state.added)
        self.assertIn("Required by", state.toggle("context-meter"))
        plan = state.review(str(self.private))
        self.assertFalse(any("npm install --global" in command for command in plan["ordinaryCommandsDisplayOnly"]))
        self.assertIn("core_runtime_untested_in_range", [gap["code"] for gap in plan["readiness"]["readinessGaps"]])
        self.assertTrue(state.approve(plan, "SAVE " + plan["digest"]))
        state.answers["launcher"] = str(self.home / "launch")
        with self.assertRaisesRegex(Invalid, "approval_invalidated"):
            state.check_approval(state.review(str(self.private)))
        wrong = copy.deepcopy(self.evidence)
        wrong["identity"]["account"] = "another"
        with self.assertRaisesRegex(Invalid, "identity_mismatch"):
            State(MANIFEST, self.identity, scan=wrong)

    def test_saved_overlay_keeps_memory_and_unrelated_choices(self):
        state = self.state()
        data = state.overlay
        data["selection"]["enable"] += ["hermes", "wiki"]
        data["selection"]["disable"] = [cid for cid in data["selection"]["disable"] if cid not in ("hermes", "wiki")]
        data["consent"]["memoryCapture"] = True
        data["memory"] = {"schemaVersion": 1, "hermes": {"backgroundReview": False}, "wiki": {"ambientPersonalVault": True, "backgroundTasks": False}, "openviking": None}
        data["ownerResources"] = {"skills": [str(self.home / "owned skills")]}
        state = State(MANIFEST, self.identity, data, self.evidence)
        self.assertIn("wiki", state.selected)
        self.assertEqual(data, state.review(str(self.private))["overlayAfter"])

    def test_eof_and_refusal_do_not_save(self):
        for data in ("", "no\n", "evidence\nq\n", "evidence\nc\n\nno\nno\nno\n"):
            result = self.cli(data=data)
            self.assertEqual(1, result.returncode, result.stderr)
            self.assertEqual("cancelled", json.loads(result.stdout)["status"])
            self.assertFalse(self.private.exists())

    def test_saved_handoff_regenerates_and_files_are_private(self):
        state = self.state()
        state.answers = {"launcher": "", "modelListing": "no", "inference": "no"}
        plan = state.review(str(self.private))
        result = self.cli(data="evidence\nc\n\nno\nno\nSAVE " + plan["digest"] + "\n")
        self.assertEqual(0, result.returncode, result.stderr[-1000:])
        self.assertEqual("saved_handoff", json.loads(result.stdout)["status"])
        self.assertFalse(self.target.exists())
        for path in (self.private, *self.private.rglob("*")):
            self.assertEqual(0o700 if path.is_dir() else 0o600, stat.S_IMODE(path.stat().st_mode))
        report = (self.private / "INSTALLER_KIT_RESULTS.md").read_text()
        self.assertIn("not run", report)
        self.assertIn("POST_INSTALL.md", report)
        result = self.cli([sys.executable, str(CLI), "generate", "--overlay", str(self.private / "overlay.json"), "--target", str(self.target)])
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["core"], json.loads((self.target / ".tenant-pi/choices.json").read_text())["overlay"]["selection"]["enable"])

    def test_probe_isolated_home_no_credentials_and_unknown_failure(self):
        binary = self.root / "bin"
        binary.mkdir()
        for name, version in (("pi", "1.3.1"), ("node", "v24.2.0"), ("python3", "Python 3.11.2"), ("herdr", "")):
            file = binary / name
            file.write_text("#!/bin/sh\n[ -z \"$OPENAI_API_KEY\" ] || exit 8\n[ ! -e \"$HOME/.pi/agent/auth.json\" ] || exit 9\n" + ("echo " + version + "\n" if version else "exit 2\n"))
            file.chmod(0o700)
        (self.home / ".pi/agent").mkdir(parents=True)
        (self.home / ".pi/agent/auth.json").write_text("SECRET_CANARY")
        with patch.dict(os.environ, {"PATH": str(binary), "OPENAI_API_KEY": "SECRET_CANARY"}):
            result = scan(self.identity, MANIFEST)
        self.assertEqual("untested_in_range", result["runtime"]["pi"]["status"])
        self.assertEqual("unknown", result["components"]["herdr"])
        (binary / "node").unlink()
        with patch.dict(os.environ, {"PATH": str(binary)}):
            result = scan(self.identity, MANIFEST)
        self.assertEqual("missing", result["runtime"]["node"]["status"])
        self.assertNotIn("SECRET_CANARY", json.dumps(result))

    def start_pty(self):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 90, 0, 0))
        process = subprocess.Popen(self.args, stdin=slave, stderr=slave, stdout=subprocess.PIPE, env=self.env)
        os.close(slave)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        self.addCleanup(process.stdout.close)
        self.addCleanup(lambda: os.close(master) if master >= 0 else None)
        return process, master

    def wait_text(self, process, master, text):
        data = b""
        end = time.monotonic() + 10
        while text.encode() not in data and time.monotonic() < end:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data += os.read(master, 65536)
                except OSError:
                    break
            if process.poll() is not None:
                break
        self.assertIn(text.encode(), data, data[-1000:])
        return data

    def test_pty_navigation_resize_details_back_cancel(self):
        process, master = self.start_pty()
        self.wait_text(process, master, "Confirm target")
        os.write(master, b"evidence\n")
        self.wait_text(process, master, "Optional features")
        # Arrow to the routing component; its selection triggers provider questions.
        os.write(master, b"\x1b[B ")
        self.wait_text(process, master, "Selection changed")
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 10, 22, 0, 0))
        self.wait_text(process, master, "q Cancel")
        os.write(master, b"d")
        self.wait_text(process, master, "model-routing")
        os.write(master, b"cc")
        self.wait_text(process, master, "launcher path")
        os.write(master, b"/back\n")
        self.wait_text(process, master, "[x] model-routing")
        os.write(master, b"q")
        self.assertEqual(1, process.wait(timeout=10))
        self.assertEqual("cancelled", json.loads(process.stdout.read())["status"])
        self.assertFalse(self.private.exists())

    def test_pty_eof_and_terminal_loss(self):
        for key in (b"\x04", None):
            process, master = self.start_pty()
            self.wait_text(process, master, "Confirm target")
            os.write(master, b"evidence\n")
            self.wait_text(process, master, "Optional features")
            if key:
                os.write(master, key)
            else:
                process.send_signal(signal.SIGHUP)
            self.assertEqual(1, process.wait(timeout=10))
            self.assertFalse(self.private.exists())

    def test_changed_evidence_refuses_save(self):
        process = subprocess.Popen(self.args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=self.env, text=True, bufsize=1)
        try:
            process.stdin.write("evidence\nc\n\nno\nno\n")
            process.stdin.flush()
            token = None
            while True:
                line = process.stderr.readline()
                if line.startswith("Type SAVE "):
                    token = re.search(r"SAVE ([a-f0-9]{64})", line).group(1)
                    break
                self.assertTrue(line)
            self.file.write_text(self.file.read_text() + " ")
            process.stdin.write("SAVE " + token + "\n")
            process.stdin.flush()
            out, err = process.communicate(timeout=10)
            self.assertEqual(2, process.returncode, (out, err))
            self.assertIn("input_changed", err)
            self.assertFalse(self.private.exists())
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()

    def test_blocked_and_probe_actions_are_distinct(self):
        data = copy.deepcopy(MANIFEST)
        data["components"]["tracker-site"].update(status="blocked", reason="fixture blocked")
        data["components"]["tracker-site"]["configOwnership"].update(status="blocked", claims=[])
        state = State(data, self.identity, scan=self.evidence)
        with self.assertRaisesRegex(Invalid, "blocked_component"):
            state.toggle("tracker-site")
        for status, action in (("missing", "install"), ("unknown", "configure"), ("incompatible", "blocked"), ("present", "reuse")):
            state.scan["components"]["core"] = status
            self.assertEqual(action, state.rows()[0]["action"])

    def test_partial_save_and_existing_destination(self):
        from scripts import wizard
        with patch.object(wizard, "_create_file", side_effect=OSError("SECRET_CANARY")):
            with self.assertRaisesRegex(Exception, "save_failed_partial") as result:
                wizard._save(str(self.private), {"overlay.json": b"{}"})
            self.assertTrue(result.exception.candidate_created)
            self.assertNotIn("SECRET_CANARY", str(result.exception))
        self.assertTrue(self.private.is_dir())
        self.assertFalse(self.target.exists())
        with self.assertRaisesRegex(Exception, "target_exists"):
            wizard._save(str(self.private), {"overlay.json": b"{}"})

    def test_no_private_reads_or_network_before_cancel(self):
        forbidden = [self.home / ".pi/agent", self.home / ".llm-wiki"]
        for directory in forbidden:
            directory.mkdir(parents=True)
            (directory / "auth.json").write_text("SECRET_CANARY")
        hook = self.root / "sitecustomize.py"
        hook.write_text("import sys\n"
                        "def guard(event, args):\n"
                        " if event.startswith(('socket.connect', 'subprocess.Popen')): raise AssertionError('forbidden operation')\n"
                        " if event == 'open' and isinstance(args[0], str) and args[0].startswith(" + repr(tuple(map(str, forbidden))) + "): raise AssertionError('private read')\n"
                        "sys.addaudithook(guard)\n")
        self.env["PYTHONPATH"] = str(self.root)
        result = self.cli(data="evidence\nc\n\nno\nno\nno\n")
        self.assertEqual(1, result.returncode, result.stderr[-500:])
        self.assertNotIn("SECRET_CANARY", result.stderr + result.stdout)
        self.assertNotIn("forbidden operation", result.stderr)
        self.assertNotIn("private read", result.stderr)
        self.assertFalse(self.private.exists())

    def test_question_answers_survive_back(self):
        from scripts.wizard import _questions
        from scripts.wizard_terminal import Back
        state = self.state()
        state.toggle("model-routing")
        class Answers:
            def __init__(self):
                self.items = iter(("", "fixture-provider", "fixture-model"))
            def show(self, text):
                pass
            def ask(self, label, default=""):
                try:
                    return next(self.items)
                except StopIteration:
                    raise Back()
        with self.assertRaises(Back):
            _questions(state, Answers())
        self.assertEqual("fixture-model", state.answers["model"])
        state.toggle("ops-footer")
        self.assertEqual("fixture-provider", state.answers["provider"])

    def test_remote_no_local_probe_and_target_binding(self):
        args = [*self.args[:-2], "--destination", "remote", "--clone", "/home/fixture/kit", "--ssh-target", self.identity["account"] + "@fixture.invalid"]
        result = self.cli(args, "scan\n")
        self.assertEqual(1, result.returncode, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual("remote_evidence_required", data["reason"])
        self.assertEqual("unchanged", data["remoteHandoff"]["hostKeyChecking"])
        self.assertFalse(self.private.exists())


class ModelsTests(unittest.TestCase):
    setUp = WizardTests.setUp
    cli = WizardTests.cli

    def test_models_public_commands_preserve_other_provider_and_regenerate(self):
        data = models_input.merge(None, "fixture-one", "http://127.0.0.1:8080/v1", "model-one")
        data = models_input.merge(data, "fixture-two", "https://example.invalid/v1", "model-two", "FIXTURE_KEY")
        changed = models_input.merge(data, "fixture-one", "http://127.0.0.1:8081/v1", "model-three")
        self.assertEqual(data["providers"]["fixture-two"], changed["providers"]["fixture-two"])
        self.private.mkdir(mode=0o700)
        (self.private / "inputs").mkdir(mode=0o700)
        (self.private / "inputs/models.json").write_text(json.dumps(changed))
        overlay = fresh(str(self.target), MANIFEST["components"])
        overlay["inputs"]["modelsFile"] = "inputs/models.json"
        path = self.private / "overlay.json"
        path.write_text(json.dumps(overlay))
        base = [sys.executable, str(CLI)]
        for action in ("validate", "plan", "generate"):
            args = [*base, action, "--overlay", str(path), "--local-dir", str(self.private)]
            if action == "generate":
                args += ["--target", str(self.target)]
            result = self.cli(args)
            self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(changed, json.loads((self.target / "models.json").read_text()))
        self.assertEqual(0o600, stat.S_IMODE((self.target / "models.json").stat().st_mode))
        second = self.home / "second profile"
        overlay["target"]["agentDir"] = str(second)
        path.write_text(json.dumps(overlay))
        result = self.cli([*base, "generate", "--overlay", str(path), "--local-dir", str(self.private), "--target", str(second)])
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual((self.target / "models.json").read_bytes(), (second / "models.json").read_bytes())
        result = self.cli([*base, "compare", "--left", str(self.target), "--right", str(second)])
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("fixture-two", result.stdout)
        self.assertEqual("none", json.loads(result.stdout)["right"]["drift"]["status"])

    def test_saved_provider_defaults_keep_auth_reference(self):
        from scripts.wizard import _questions
        state = State(MANIFEST, self.identity, scan=self.evidence)
        state.toggle("model-routing")
        state.overlay["roles"]["interactive"] = {"provider": "fixture", "model": "served", "thinking": "off"}
        state.models = models_input.merge(None, "fixture", "https://example.invalid/v1", "served", "FIXTURE_KEY", {"contextWindow": 8192})
        before = copy.deepcopy(state.models)
        class Defaults:
            def show(self, text):
                pass
            def ask(self, label, default=""):
                return default
        _questions(state, Defaults())
        self.assertEqual(before, state.models)
        self.assertEqual("no", state.answers["modelListing"])
        self.assertEqual("no", state.answers["inference"])

    def test_models_refuse_secret_commands_unknown_metadata(self):
        data = models_input.merge(None, "fixture", "http://127.0.0.1:8080/v1", "fixture")
        for key in ("SECRET_CANARY", "!printf secret", "${BAD-NAME}"):
            bad = copy.deepcopy(data)
            bad["providers"]["fixture"]["apiKey"] = key
            with self.assertRaisesRegex(Invalid, "env_reference_only") as context:
                models_input.validate(bad)
            self.assertNotIn(key, str(context.exception))
        for url in ("https://user:password@example.invalid/v1", "https://example.invalid/v1?token=SECRET_CANARY"):
            with self.assertRaises(Invalid):
                models_input.merge(data, "fixture", url, "fixture")


if __name__ == "__main__":
    unittest.main()
