"""spawn.py --account starts claude1 or claude2 in place of claude, and only for the harness claude.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
# The same isolation as test_herdr_skill.py, for either order of the test files: _common reads both at import.
os.environ.setdefault("HERDR_SKILL_STATE_DIR", tempfile.mkdtemp(prefix="herdr-skill-test-"))
os.environ.setdefault("HERDR_SKILL_RESOURCES", os.path.join(os.environ["HERDR_SKILL_STATE_DIR"], "no-machine-file.json"))

spec = importlib.util.spec_from_file_location("spawn_account", os.path.join(SKILL, "scripts", "spawn.py"))
spawn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawn)

with open(os.path.join(SKILL, "roles.json"), encoding="utf-8") as f:
    CFG = json.load(f)


def opts(**kw):
    base = {"harness": "claude", "role": "worker", "account": None, "model": "haiku", "thinking": "low",
            "interactive": False, "strict": False}
    base.update(kw)
    return base


class Account(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="herdr-account-test-")
        self.addCleanup(temp.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": temp.name, "XDG_CONFIG_HOME": os.path.join(temp.name, "config")})
        env.start()
        self.addCleanup(env.stop)

    def test_account_2_launches_claude2_and_no_account_launches_claude(self):
        with mock.patch.object(spawn.shutil, "which", side_effect=lambda name: f"/fixture/{name}"):
            r = spawn.resolve(opts(account="2"), CFG)
            executable, args, argv = spawn.build_command(r, CFG, "proj-worker-1", None, write=False)
            self.assertEqual(executable, "claude2")
            self.assertIn("claude2", argv)
            self.assertNotIn("claude", argv)
            plain = spawn.resolve(opts(), CFG)
            self.assertEqual(spawn.build_command(plain, CFG, "proj-worker-1", None, write=False)[0], "claude")
            self.assertNotIn("account", plain)

    def test_account_with_another_harness_or_value_is_refused(self):
        for harness, account in (("pi", "2"), ("agy", "1"), ("claude", "3")):
            with self.subTest(harness=harness, account=account), \
                    mock.patch.object(spawn.shutil, "which", side_effect=lambda name: f"/fixture/{name}"), \
                    mock.patch.object(spawn, "resolve_pi_model", side_effect=lambda model, **kw: model), \
                    mock.patch.object(spawn, "resolve_agy", side_effect=lambda model, thinking, o, **kw: (model, thinking)), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exc:
                spawn.resolve(opts(harness=harness, account=account), CFG)
            self.assertEqual(exc.exception.code, spawn.EXIT["invalid"])

    def test_account_without_its_program_on_path_is_refused(self):
        with mock.patch.object(spawn.shutil, "which", return_value=None), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exc:
            spawn.resolve(opts(account="1"), CFG)
        self.assertEqual(exc.exception.code, spawn.EXIT["invalid"])


if __name__ == "__main__":
    unittest.main()
