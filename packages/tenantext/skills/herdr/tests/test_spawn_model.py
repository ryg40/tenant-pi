"""spawn.py starts no pane when neither the request nor models.json names a model. No Herdr server is needed.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import importlib.util
import io
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

spec = importlib.util.spec_from_file_location("spawn_model", os.path.join(SKILL, "scripts", "spawn.py"))
spawn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawn)


class NoModel(unittest.TestCase):
    def test_no_model_from_the_request_or_models_json_starts_nothing_and_exits_with_2(self):
        me = {"workspace": "proj", "workspace_id": "w1", "tab_id": "t1", "pane_id": "p1"}
        with tempfile.TemporaryDirectory(prefix="herdr-spawn-test-") as home:
            for harness in ("pi", "claude"):
                for dry_run in (False, True):
                    with self.subTest(harness=harness, dry_run=dry_run):
                        argv = ["spawn.py", "--harness", harness, "--role", "worker", "--cwd", home] + (["--dry-run"] if dry_run else [])
                        out, err = io.StringIO(), io.StringIO()
                        with mock.patch.dict(os.environ, {"HOME": home, "XDG_CONFIG_HOME": os.path.join(home, "config")}), \
                                mock.patch.multiple(spawn, require_herdr_env=lambda: None, ensure_layout=lambda quiet: me,
                                                    ensure_layout_readonly=lambda: me, live_agents=lambda: []), \
                                mock.patch.object(spawn, "place") as place, mock.patch.object(spawn, "herdr") as herdr, \
                                mock.patch.object(spawn, "system_prompt") as prompt, \
                                mock.patch.object(sys, "argv", argv), \
                                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                                self.assertRaises(SystemExit) as exc:
                            spawn.main()
                        self.assertEqual(exc.exception.code, spawn.EXIT["invalid"])
                        message = err.getvalue()
                        self.assertIn(f"no model for the role worker and the harness {harness}", message)
                        self.assertIn("--model", message)
                        self.assertIn(os.path.join(home, "config", "herdr-skill", "models.json"), message)
                        self.assertIn("No pane was started.", message)
                        self.assertEqual(out.getvalue(), "")
                        place.assert_not_called()
                        herdr.assert_not_called()
                        prompt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
