"""Custom Pi launcher tests; no live Herdr server is needed."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("launcher_spawn", SCRIPTS / "spawn.py")
spawn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawn)


class PiLauncher(unittest.TestCase):
    def test_default_needs_no_shell_mutation(self):
        with patch.object(spawn, "load_launch", return_value={}):
            self.assertEqual(spawn.pi_executable(), "pi")
        with patch.object(spawn, "herdr") as call:
            spawn.prepare_pi_launcher("p1", "pi")
        call.assert_not_called()

    def test_absolute_executable_and_model_lookup(self):
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root) / "tenant pi"
            executable.write_text("#!/bin/sh\nprintf 'provider model\\nexample astra\\n'\n")
            executable.chmod(0o700)
            with patch.object(spawn, "load_launch", return_value={"pi_executable": str(executable)}):
                self.assertEqual(spawn.resolve_pi_model("example/astra"), "example/astra")

    def test_invalid_launcher_rejected(self):
        for value in ["tenant-pi", "/missing/tenant-pi", "/tmp/line\nbreak"]:
            with self.subTest(value=value), patch.object(spawn, "load_launch", return_value={"pi_executable": value}):
                with self.assertRaises(SystemExit):
                    spawn.pi_executable()

    def test_new_shell_wrapper_quotes_path_and_arguments(self):
        with tempfile.TemporaryDirectory() as root:
            executable = Path(root) / "tenant 'pi;"
            executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            executable.chmod(0o700)
            info = {"result": {"process_info": {"foreground_processes": [{"name": "bash"}]}}}
            with patch.object(spawn, "herdr", side_effect=[(0, info, ""), (0, {"result": {}}, "")]) as call:
                spawn.prepare_pi_launcher("new-pane", str(executable))
            command = call.call_args.args[-1]
            value = "literal ; $(echo wrong) ' text"
            result = subprocess.run(["bash", "-c", command + "; pi " + shlex.quote(value)], capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout, value + "\n")
            self.assertEqual(call.call_args.args[:3], ("pane", "run", "new-pane"))

    def test_pi_bolt_wrapper_unsets_the_herdr_socket(self):
        for line, kept in (("1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)", ""), ("1.4.0", "socket")):
            with self.subTest(line=line), tempfile.TemporaryDirectory() as root:
                executable = Path(root) / "pi"
                executable.write_text('#!/bin/sh\nif [ "$1" = --version ]; then echo "%s"; '
                                      'else printf "%%s\\n" "${HERDR_SOCKET_PATH-}"; fi\n' % line)
                executable.chmod(0o700)
                info = {"result": {"process_info": {"foreground_processes": [{"name": "bash"}]}}}
                with patch.object(spawn, "herdr", side_effect=[(0, info, ""), (0, {"result": {}}, "")]) as call:
                    spawn.prepare_pi_launcher("new-pane", str(executable))
                command = call.call_args.args[-1]
                result = subprocess.run(["bash", "-c", command + "; pi"], env=os.environ | {"HERDR_SOCKET_PATH": "socket"},
                                        capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout, kept + "\n")

    def test_unsupported_shell_is_not_modified(self):
        info = {"result": {"process_info": {"foreground_processes": [{"name": "fish"}]}}}
        with patch.object(spawn, "herdr", return_value=(0, info, "")) as call:
            with self.assertRaises(RuntimeError):
                spawn.prepare_pi_launcher("new-pane", "/bin/true")
        self.assertEqual(call.call_count, 1)

    def test_wrapper_delivery_error_fails(self):
        info = {"result": {"process_info": {"foreground_processes": [{"name": "bash"}]}}}
        with patch.object(spawn, "herdr", side_effect=[(0, info, ""), (1, None, "error")]):
            with self.assertRaises(RuntimeError):
                spawn.prepare_pi_launcher("new-pane", "/bin/true")


if __name__ == "__main__":
    unittest.main()
