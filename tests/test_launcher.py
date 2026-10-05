"""Launcher file: exact text, mode, every refusal, and the CLI in a disposable HOME."""
import copy
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts import launcher, profile_write, tenant_pi
from scripts.launcher import MAX_PATH, check_location, preflight, text, write
from scripts.profile_write import WriteError
from scripts.validate import Invalid, load
from tests.test_model_routes import GATEWAY, NATIVE, REGISTRY

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
LINE = "PI_CODING_AGENT_DIR=/a/profile pi --no-approve"


def tree(root):
    return {str(p.relative_to(root)): (os.lstat(p).st_mode, p.read_bytes() if p.is_file() and not p.is_symlink() else None)
            for p in root.rglob("*")}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.path = self.parent / "launch-main.sh"
        self.sentinel = self.base / "outside"
        self.sentinel.write_text("KEEP")


class ModuleTests(Fixture):
    def rejected(self, rule, field, call, *, created=False):
        with self.assertRaises((Invalid, WriteError)) as caught:
            call()
        self.assertEqual(f"{rule}: {field}", str(caught.exception))
        self.assertEqual(created, getattr(caught.exception, "candidate_created", False))
        self.assertNotIn(str(self.base), str(caught.exception))
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_text_is_the_shebang_and_one_exec_line(self):
        self.assertEqual(b"#!/bin/sh\nexec env " + LINE.encode() + b"\n", text(LINE))
        for bad in ("", "a\nb", "a\x00b", "café", None, ["pi"]):
            with self.subTest(bad=repr(bad)):
                self.rejected("launch_line", "launcher.content", lambda: text(bad))

    def test_location_rules(self):
        roots = [("under_kit", str(self.base / "kit")), ("under_target", str(self.base / "profile"))]
        for path, rule in (("relative.sh", "absolute_path"), ("/a/../launch.sh", "absolute_path"),
                           ("/a//launch.sh", "absolute_path"), ("/a/launch/", "absolute_path"),
                           ("/a/$HOME.sh", "shell_or_template"), ("/a/la\nunch", "text"), ("", "text"),
                           ("/a/launch;rm.sh", "absolute_path"), ("/" + "a" * MAX_PATH, "path_too_long"),
                           (str(self.base / "kit"), "under_kit"), (str(self.base / "kit/.local/l.sh"), "under_kit"),
                           (str(self.base / "profile"), "under_target"),
                           (str(self.base / "profile/bin/l.sh"), "under_target")):
            with self.subTest(path=path[:40]):
                self.rejected(rule, "launcher.path", lambda: check_location(path, roots))
        # A name that only starts with the text of a root is outside it.
        check_location(str(self.base / "profile2.sh"), roots)

    def test_write_creates_mode_0700_under_umask_zero(self):
        old = os.umask(0)
        try:
            result = write(str(self.path), LINE)
        finally:
            os.umask(old)
        self.assertEqual((str(self.path), True, ()), (result.path, result.complete, result.warnings))
        info = os.lstat(self.path)
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(0o700, stat.S_IMODE(info.st_mode))
        self.assertEqual(text(LINE), self.path.read_bytes())
        self.assertEqual({"path": str(self.path), "mode": "0700", "complete": True, "fileCreated": True,
                          "warnings": []}, launcher.report(result))

    def test_existing_entries_are_refused_and_unchanged(self):
        for kind in ("file", "dir", "link", "dangling", "fifo"):
            with self.subTest(kind=kind):
                if kind == "file":
                    self.path.write_text("KEEP")
                elif kind == "dir":
                    self.path.mkdir()
                elif kind in ("link", "dangling"):
                    self.path.symlink_to(self.sentinel if kind == "link" else self.base / "missing")
                else:
                    os.mkfifo(self.path)
                for call in (lambda: preflight(str(self.path)), lambda: write(str(self.path), LINE)):
                    self.rejected("target_exists", "launcher.path", call)
                if kind == "file":
                    self.assertEqual("KEEP", self.path.read_text())
                self.assertFalse((self.base / "missing").exists())
                if kind == "dir":
                    self.path.rmdir()
                else:
                    self.path.unlink()

    def test_parent_rules(self):
        link = self.base / "linked"
        link.symlink_to(self.parent, target_is_directory=True)
        loose = self.base / "writable"
        loose.mkdir()
        loose.chmod(0o777)
        for path, rule, field in ((self.base / "absent" / "l.sh", "parent_missing", "launcher.path.parent"),
                                  (link / "l.sh", "unsafe_path", "launcher.path.parents"),
                                  (self.sentinel / "l.sh", "unsafe_path", "launcher.path.parents"),
                                  (loose / "l.sh", "unsafe_permissions", "launcher.path.parents")):
            with self.subTest(rule=rule):
                for call in (lambda: preflight(str(path)), lambda: write(str(path), LINE)):
                    self.rejected(rule, field, call)
        self.assertEqual([], list(self.parent.iterdir()))
        self.assertEqual([], list(loose.iterdir()))
        # A parent that is not owned by the caller.
        with patch.object(profile_write.os, "geteuid", return_value=os.geteuid() + 4242):
            self.rejected("unsafe_owner" if os.lstat(self.parent).st_uid != 0 else "unsafe_parent_owner",
                          "launcher.path.parents" if os.lstat(self.parent).st_uid != 0 else "launcher.path.parent",
                          lambda: preflight(str(self.path)))
        self.assertFalse(os.path.lexists(self.path))

    def test_restrictive_umask_is_reported_not_repaired(self):
        old = os.umask(0o277)
        try:
            self.rejected("file_privacy", "launcher.path", lambda: write(str(self.path), LINE), created=True)
        finally:
            os.umask(old)
        self.assertEqual(0o500, stat.S_IMODE(os.lstat(self.path).st_mode))

    def test_entry_that_appears_after_the_walk_is_refused(self):
        original = launcher._ancestors

        def racing(path):
            result = original(path)
            self.path.write_text("KEEP")
            return result

        with patch.object(launcher, "_ancestors", side_effect=racing):
            self.rejected("target_exists", "launcher.path", lambda: write(str(self.path), LINE))
        self.assertEqual("KEEP", self.path.read_text())

    def test_write_failures(self):
        with patch.object(launcher, "_create_file", side_effect=OSError("CANARY")):
            self.rejected("target_unavailable", "launcher.path", lambda: write(str(self.path), LINE))
        self.assertFalse(os.path.lexists(self.path))
        with patch.object(launcher.os, "fsync", side_effect=OSError("CANARY")):
            self.rejected("write_failed", "launcher.path", lambda: write(str(self.path), LINE), created=True)
        self.assertEqual(text(LINE), self.path.read_bytes())

    def test_close_failure_before_and_after_completion(self):
        original_close = os.close

        def failing_close(fd):
            original_close(fd)
            raise OSError("CANARY")

        # Before completion: the primary error stays.
        with patch.object(launcher, "os", wraps=os) as wrapped:
            wrapped.fsync.side_effect = OSError("CANARY")
            wrapped.close.side_effect = failing_close
            self.rejected("write_failed", "launcher.path", lambda: write(str(self.path), LINE), created=True)
        self.path.unlink()
        # After completion: a static warning in the result. The file creation closes its own descriptor
        # through `profile_write.os.close`, so only the parent close of this module fails.
        with patch.object(launcher, "os", wraps=os) as wrapped:
            wrapped.close.side_effect = failing_close
            result = write(str(self.path), LINE)
        self.assertEqual(("cleanup_failed: launcher.descriptors",), result.warnings)
        self.assertEqual(text(LINE), self.path.read_bytes())
        with patch.object(launcher, "os", wraps=os) as wrapped:
            wrapped.close.side_effect = failing_close
            self.rejected("cleanup_failed", "launcher.descriptors", lambda: preflight(str(self.parent / "other.sh")))

    def test_failure_report_is_static(self):
        exc = WriteError("write_failed", "launcher.path", candidate_created=True)
        self.assertEqual({"path": "/a/l.sh", "complete": False, "fileCreated": True, "error": "write_failed: launcher.path"},
                         launcher.failure("/a/l.sh", exc))


class CliTests(Fixture):
    def setUp(self):
        super().setUp()
        self.home = self.base / "home"
        self.agent = self.home / ".pi/agent"
        self.agent.mkdir(parents=True, mode=0o700)
        for name in ("auth.json", "models.json", "settings.json"):
            (self.agent / name).write_text("CANARY_PRIVATE")
        self.target = self.parent / "new 'profile'"
        self.manifest = self.base / "manifest.json"
        self.manifest.write_bytes((ROOT / "config/manifest.json").read_bytes())
        self.registry = self.base / "registry.json"
        self.registry.write_text(json.dumps(REGISTRY))
        self.overlay = self.base / "overlay.json"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        self.data["selection"] = {"enable": ["core", "model-routing", "codex-accounts"], "disable": []}
        self.data["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": {"auth": "env"}}
        self.data["endpoints"] = {"codex-accounts": "https://gateway.example.invalid/v1"}
        self.data["env"] = {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
        self.data["roles"] = {"interactive": copy.deepcopy(NATIVE), "review": copy.deepcopy(GATEWAY)}
        self.overlay.write_text(json.dumps(self.data))
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("pi", "npm", "node", "git", "sh", "env"):
            command = self.bin / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base / "called") + "'\n")
            command.chmod(0o700)
        (self.base / "sitecustomize.py").write_text(
            "import sys\nsys.dont_write_bytecode = True\n"
            "import socket, subprocess\n"
            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
            "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "PYTHONPATH": str(self.base),
                    "PYTHONDONTWRITEBYTECODE": "1", "TENANTEXT_LITELLM_API_KEY": "CANARY_SECRET_VALUE"}

    def run_cli(self, action, *extra, env=None):
        args = ["--target", str(self.target)] if action == "generate" else []
        return subprocess.run([sys.executable, str(CLI), action, "--overlay", str(self.overlay),
                               "--manifest", str(self.manifest), "--registry", str(self.registry), *args, *extra],
                              cwd=self.base, env=self.env if env is None else env,
                              text=True, capture_output=True, check=False)

    def refused(self, error, *extra, env=None):
        before = tree(self.base)
        result = self.run_cli("generate", *extra, env=env)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertEqual("", result.stdout)
        self.assertEqual({"candidate_created": False, "error": error}, json.loads(result.stderr))
        self.assertNotIn(str(self.base), result.stderr)
        self.assertNotIn("CANARY", result.stderr)
        # Every refusal fires before any write: no target, no launcher, no other change.
        self.assertFalse(os.path.lexists(self.target))
        self.assertEqual(before, tree(self.base))
        self.assertFalse((self.base / "called").exists())

    def test_launcher_text_equals_the_plan_line(self):
        plan = self.run_cli("plan", "--launcher", str(self.path))
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        line = preview["commands"]["launchDisplayOnly"]
        self.assertEqual(str(self.path), preview["commands"]["launcherDisplayOnly"])
        self.assertIn("TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1 ", line)
        # `plan --launcher` writes nothing.
        self.assertFalse(os.path.lexists(self.path))
        self.assertFalse(os.path.lexists(self.target))
        result = self.run_cli("generate", "--launcher", str(self.path))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n", result.stdout)
        self.assertTrue(output["filesComplete"])
        self.assertEqual(line, output["commands"]["launchDisplayOnly"])
        self.assertEqual(str(self.path), output["commands"]["launcherDisplayOnly"])
        self.assertEqual({"path": str(self.path), "mode": "0700", "complete": True, "fileCreated": True, "warnings": []},
                         output["launcher"])
        # The file: the shebang and one exec line that holds the plan line byte for byte.
        content = self.path.read_bytes()
        self.assertEqual(("#!/bin/sh\nexec env " + line + "\n").encode("ascii"), content)
        self.assertEqual(["#!/bin/sh", "exec env " + line], content.decode("ascii").split("\n")[:-1])
        self.assertEqual(0o700, stat.S_IMODE(os.lstat(self.path).st_mode))
        for data in (content.decode(), result.stdout):
            self.assertNotIn("CANARY", data)
        self.assertNotIn("TENANTEXT_LITELLM_API_KEY", content.decode())
        self.assertFalse((self.base / "called").exists())
        self.assertEqual({"auth.json", "models.json", "settings.json"}, {p.name for p in self.agent.iterdir()})
        # The launcher runs the same command as the plan line: a recording `pi` sees the same arguments
        # and environment. The key reaches `pi` only from the launching shell.
        record = self.base / "record bin"
        record.mkdir()
        fake = record / "pi"
        fake.write_text('#!/bin/sh\nprintf "%s|" "$@" "$PI_CODING_AGENT_DIR" "$TENANTEXT_LITELLM_BASE_URL" '
                        '"${TENANTEXT_LITELLM_API_KEY-unset}"\nprintf "\\n"\nenv | sort\n')
        fake.chmod(0o700)
        run_env = {"PATH": str(record) + ":/usr/bin:/bin", "TENANTEXT_LITELLM_API_KEY": "from-shell"}
        by_line = subprocess.run(["/bin/sh", "-c", line], env=run_env, cwd=self.base,
                                 capture_output=True, text=True, check=True)
        by_file = subprocess.run([str(self.path)], env=run_env, cwd=self.base,
                                 capture_output=True, text=True, check=True)
        # The arguments and the full environment of `pi`, not only the three names.
        self.assertEqual(by_line.stdout, by_file.stdout)
        head, environment = by_file.stdout.split("\n", 1)
        self.assertEqual("--no-approve|" + str(self.target) + "|https://gateway.example.invalid/v1|from-shell|", head)
        for entry in ("PI_CODING_AGENT_DIR=" + str(self.target), "TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1",
                      "TENANTEXT_LITELLM_API_KEY=from-shell"):
            self.assertIn(entry, environment.splitlines())

    def test_inherited_session_dir_does_not_reach_pi(self):
        # A login shell exports PI_CODING_AGENT_SESSION_DIR. The plan line and the launcher
        # file remove it, so Pi uses its default `<agent dir>/sessions`. The target name has a space
        # and the two quote characters.
        self.target = self.parent / "new 'profile' \"two\""
        self.data["target"]["agentDir"] = str(self.target)
        self.overlay.write_text(json.dumps(self.data))
        plan = self.run_cli("plan", "--launcher", str(self.path))
        self.assertEqual(0, plan.returncode, plan.stderr)
        line = json.loads(plan.stdout)["commands"]["launchDisplayOnly"]
        self.assertEqual("TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1 "
                         "env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=" + shlex.quote(str(self.target))
                         + " pi --no-approve", line)
        for char in (" ", "'", '"'):
            self.assertIn(char, str(self.target))
        result = self.run_cli("generate", "--launcher", str(self.path))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(line, json.loads(result.stdout)["commands"]["launchDisplayOnly"])
        self.assertEqual(("#!/bin/sh\nexec env " + line + "\n").encode("ascii"), self.path.read_bytes())
        record = self.base / "record bin"
        record.mkdir()
        fake = record / "pi"
        fake.write_text('#!/bin/sh\nprintf "%s|" "$@" "$PI_CODING_AGENT_DIR" "${PI_CODING_AGENT_SESSION_DIR-unset}" '
                        '"${PI_CODING_AGENT_SESSION_DIR+set}" "$OTHER_NAME"\nprintf "\\n"\n')
        fake.chmod(0o700)
        elsewhere = str(self.base / "other agent" / "sessions")
        run_env = {"PATH": str(record) + ":/usr/bin:/bin", "PI_CODING_AGENT_SESSION_DIR": elsewhere,
                   "PI_CODING_AGENT_DIR": str(self.base / "other agent"), "OTHER_NAME": "kept"}
        expected = "--no-approve|" + str(self.target) + "|unset||kept|\n"
        by_line = subprocess.run(["/bin/sh", "-c", line], env=run_env, cwd=self.base,
                                 capture_output=True, text=True, check=True)
        by_file = subprocess.run([str(self.path)], env=run_env, cwd=self.base,
                                 capture_output=True, text=True, check=True)
        self.assertEqual(expected, by_line.stdout)
        self.assertEqual(expected, by_file.stdout)
        self.assertEqual(("", ""), (by_line.stderr, by_file.stderr))
        # Control: without the launch line, the recording `pi` gets the inherited value.
        bare = subprocess.run(["pi", "--no-approve"], env=run_env, cwd=self.base, capture_output=True, text=True, check=True)
        self.assertIn("|" + elsewhere + "|set|", bare.stdout)

    def test_core_only_profile(self):
        data = load(ROOT / "config/config.example.json")
        data["target"]["agentDir"] = str(self.target)
        self.overlay.write_text(json.dumps(data))
        result = subprocess.run([sys.executable, str(CLI), "generate", "--overlay", str(self.overlay),
                                 "--manifest", str(self.manifest), "--target", str(self.target),
                                 "--launcher", str(self.path)], cwd=self.base, env=self.env,
                                text=True, capture_output=True, check=False)
        self.assertEqual(0, result.returncode, result.stderr)
        line = json.loads(result.stdout)["commands"]["launchDisplayOnly"]
        self.assertEqual("env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=" + shlex.quote(str(self.target)) + " pi --no-approve", line)
        self.assertEqual(("#!/bin/sh\nexec env " + line + "\n").encode(), self.path.read_bytes())

    def test_plan_without_launcher_is_unchanged_and_plan_refuses_bad_paths(self):
        plan = json.loads(self.run_cli("plan").stdout)
        self.assertNotIn("launcherDisplayOnly", plan["commands"])
        self.assertNotIn("launcher", plan)
        before = tree(self.base)
        for path, error in (("relative.sh", "absolute_path: launcher.path"),
                            (str(self.target / "l.sh"), "under_target: launcher.path"),
                            (str(ROOT / ".local" / "tenant-pi-test-launcher-absent.sh"), "under_kit: launcher.path"),
                            (str(ROOT / "launch.sh"), "under_kit: launcher.path"),
                            (str(self.agent / "launch.sh"), "under_pi_agent: launcher.path"),
                            (str(self.agent) + "/launch2.sh", "under_pi_agent: launcher.path")):
            with self.subTest(path=path[-40:]):
                result = self.run_cli("plan", "--launcher", path)
                self.assertEqual(2, result.returncode)
                self.assertEqual("", result.stdout)
                self.assertEqual({"candidate_created": False, "error": error}, json.loads(result.stderr))
                self.assertFalse(os.path.lexists(path))
        self.assertEqual(before, tree(self.base))
        help_text = subprocess.run([sys.executable, str(CLI), "generate", "--help"], cwd=self.base, env=self.env,
                                   text=True, capture_output=True, check=False).stdout
        self.assertIn("--launcher", help_text)

    def test_refusals_before_any_write(self):
        (self.parent / "exists.sh").write_text("KEEP")
        kit = ROOT / ".local" / "tenant-pi-test-launcher-absent.sh"
        for path, error in (
                (self.parent / "exists.sh", "target_exists: launcher.path"),
                ("relative.sh", "absolute_path: launcher.path"),
                (self.target, "under_target: launcher.path"),
                (self.target / "launch.sh", "under_target: launcher.path"),
                (kit, "under_kit: launcher.path"),
                (ROOT / "launch.sh", "under_kit: launcher.path"),
                (self.agent / "launch.sh", "under_pi_agent: launcher.path"),
                (self.base / "absent" / "launch.sh", "parent_missing: launcher.path.parent"),
                ("/" + "a" * MAX_PATH, "path_too_long: launcher.path")):
            with self.subTest(path=str(path)[:60]):
                self.refused(error, "--launcher", str(path))
        self.assertFalse(os.path.lexists(kit))
        self.assertEqual("KEEP", (self.parent / "exists.sh").read_text())
        env = {name: value for name, value in self.env.items() if name != "HOME"}
        self.refused("home_required: launcher.home", "--launcher", str(self.path), env=env)
        self.refused("absolute_path: launcher.home", "--launcher", str(self.path), env=dict(env, HOME="relative"))

    def test_linked_roots_and_linked_ancestor(self):
        real = self.base / "real agent"
        real.mkdir(mode=0o700)
        home = self.base / "home2"
        (home / ".pi").mkdir(parents=True)
        (home / ".pi/agent").symlink_to(real, target_is_directory=True)
        self.refused("under_pi_agent: launcher.path", "--launcher", str(real / "l.sh"), env=dict(self.env, HOME=str(home)))
        (self.base / "to parent").symlink_to(self.parent, target_is_directory=True)
        self.refused("unsafe_path: launcher.path.parents", "--launcher", str(self.base / "to parent" / "l.sh"))

    def test_failed_generation_writes_no_launcher(self):
        self.target.mkdir()
        result = self.run_cli("generate", "--launcher", str(self.path))
        self.assertEqual(2, result.returncode)
        self.assertEqual({"candidate_created": False, "error": "target_exists: target"}, json.loads(result.stderr))
        self.assertFalse(os.path.lexists(self.path))
        self.target.rmdir()
        self.data["modelRoutes"]["gateway"] = {"auth": "login"}
        self.data["env"] = {}
        self.overlay.write_text(json.dumps(self.data))
        self.refused("pi_login_blocked: overlay.modelRoutes.gateway.auth", "--launcher", str(self.path))

    def main_in_process(self):
        out, err = StringIO(), StringIO()
        with patch.dict(os.environ, {"HOME": str(self.home)}), redirect_stdout(out), redirect_stderr(err):
            code = tenant_pi.main(["generate", "--overlay", str(self.overlay), "--manifest", str(self.manifest),
                                   "--registry", str(self.registry), "--target", str(self.target),
                                   "--launcher", str(self.path)])
        return code, out.getvalue(), err.getvalue()

    def test_launcher_failure_after_generation_keeps_the_report(self):
        for side_effect, error, created in ((OSError("CANARY"), "target_unavailable: launcher.path", False),
                                            (WriteError("short_write", "target.files", candidate_created=True),
                                             "short_write: launcher.path", True)):
            with self.subTest(error=error):
                with patch.object(launcher, "_create_file", side_effect=side_effect):
                    code, out, err = self.main_in_process()
                self.assertEqual((1, ""), (code, err))
                output = json.loads(out)
                self.assertTrue(output["filesComplete"])
                self.assertTrue(output["complete"])
                self.assertEqual({"path": str(self.path), "complete": False, "fileCreated": created, "error": error},
                                 output["launcher"])
                self.assertNotIn("CANARY", out)
                self.assertEqual("complete", json.loads((self.target / ".tenant-pi/state.json").read_text())["status"])
                self.assertFalse(os.path.lexists(self.path))
                for item in sorted(self.target.rglob("*"), reverse=True):
                    item.rmdir() if item.is_dir() else item.unlink()
                self.target.rmdir()
        # A launcher that appears during the generation is reported, not adopted.
        original = profile_write.write

        def generate_then_race(*args, **kwargs):
            result = original(*args, **kwargs)
            self.path.write_text("KEEP")
            return result

        with patch.object(tenant_pi, "write", side_effect=generate_then_race):
            code, out, err = self.main_in_process()
        self.assertEqual((1, ""), (code, err))
        self.assertEqual("target_exists: launcher.path", json.loads(out)["launcher"]["error"])
        self.assertEqual("KEEP", self.path.read_text())


if __name__ == "__main__":
    unittest.main()
