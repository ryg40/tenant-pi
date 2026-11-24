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
# The in-process runs of main() take the Herdr 1 path, also when the tests run in a herdr-core terminal.
os.environ.pop("HC_TERMINAL_ID", None)

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


class HerdrAppPane(unittest.TestCase):
    """spawn.py uses `hc run` only in a pane of the Herdr app; a classic Herdr pane keeps the herdr CLI.

    The backend comes from detect_backend(): the app pane is a live herdr-core terminal whose pid is this
    process (an ancestor of the caller); a stale terminal has a pid that is no ancestor.
    """
    ME = {"address": "t1", "cwd": "/work/proj", "state": "live", "pid": os.getpid(),
          "labels": {"herdr.space": "sp1", "herdr.tab": "tb1", "where": "proj / 1"}}
    NO_ANCESTOR = 2 ** 22 + 12345

    def test_a_classic_herdr_pane_never_takes_the_hc_path(self):
        stale = dict(self.ME, pid=self.NO_ANCESTOR)
        with mock.patch.dict(os.environ, {"HERDR_ENV": "1", "HC_TERMINAL_ID": "t1"}), \
                mock.patch.object(spawn._common, "_herdr1_candidate", lambda: (True, "valid", os.getpid())), \
                mock.patch.object(spawn._common, "hc", return_value=(0, stale, "")) as hc:
            self.assertIsNone(spawn.herdr_app_pane())
        # Only the read of the detection; no hc run or hc ls.
        self.assertEqual({c.args[0] for c in hc.call_args_list}, {"get"})

    def test_an_app_pane_starts_the_agent_with_hc_run_in_the_space_of_the_caller(self):
        calls = []

        def hc(*args, timeout=None):
            calls.append(args)
            return 0, {"ls": {"terminals": []}, "get": self.ME}.get(args[0], {"address": "t2"}), ""

        with tempfile.TemporaryDirectory(prefix="herdr-spawn-test-") as home:
            argv = ["spawn.py", "--harness", "claude", "--role", "worker", "--model", "m", "--cwd", home]
            env = {k: v for k, v in os.environ.items() if k != "HERDR_ENV"}
            env.update(HOME=home, SHELL="/bin/sh", HC_TERMINAL_ID="t1")
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(spawn._common, "hc", hc), \
                    mock.patch.multiple(spawn, hc=hc, app_wait=lambda a, s: "idle",
                                        system_prompt=lambda r, cfg=None: "prompt", write_record=lambda *a: None), \
                    mock.patch.object(spawn, "herdr") as herdr, mock.patch.object(sys, "argv", argv), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                spawn.main()
        herdr.assert_not_called()
        run = next(c for c in calls if c[0] == "run")
        command = run[run.index("--") + 1:]
        self.assertIn("herdr.space=sp1", run)
        self.assertNotIn("herdr.tab=tb1", run)  # a worker gets the tab of its role, not the tab of the caller
        self.assertEqual(command[:2], ("/bin/sh", "-ic"))
        self.assertIn("OPENVIKING_RECALL_COMPRESS=off", command)


if __name__ == "__main__":
    unittest.main()
