"""spawn.py, init.py and panes.py on herdr-core: role tabs, the first coordinator of a space, the pane list.

A fake `hc` in the process keeps the terminals; no herdr-core is needed. The backend is a fixed "core" result.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
# The same isolation as test_herdr_skill.py, for either order of the test files: _common reads both at import.
os.environ.setdefault("HERDR_SKILL_STATE_DIR", tempfile.mkdtemp(prefix="herdr-skill-test-"))
os.environ.setdefault("HERDR_SKILL_RESOURCES", os.path.join(os.environ["HERDR_SKILL_STATE_DIR"], "no-machine-file.json"))
os.environ.pop("HC_TERMINAL_ID", None)

import _common  # noqa: E402


def load(script):
    spec = importlib.util.spec_from_file_location("core_" + script.replace("-", "_"), os.path.join(SKILL, "scripts", script))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


spawn, init, panes = load("spawn.py"), load("init.py"), load("panes.py")


def terminal(address, space="sp1", tab="tb1", state="live", role=None, age=60, where="proj / 1", name=None):
    labels = {"where": where}
    if space:
        labels["herdr.space"] = space
    if tab:
        labels["herdr.tab"] = tab
    if role:
        labels["skill.role"] = role
    return {"address": address, "name": name, "state": state, "cwd": "/work/proj", "created_ms": (time.time() - age) * 1000,
            "labels": labels, "status": {"app": "claude-code", "state": "idle"}, "title": f"title of {address}"}


class FakeCore:
    """The terminals of a fake herdr-core and a log of each call."""

    def __init__(self, *terminals, list_all=False, timeout_get=()):
        self.terminals = {t["address"]: t for t in terminals}
        self.calls = []
        self.list_all = list_all  # `hc ls` also lists the terminals that are not live
        self.timeout_get = set(timeout_get)  # `hc get` of these addresses times out

    def __call__(self, *args, timeout=None):
        self.calls.append(args)
        if args[0] == "ls":
            want = [args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "--label"]
            shown = [{"address": a} for a, t in self.terminals.items()
                     if (self.list_all or t["state"] == "live") and all(t["labels"].get(k) == v for k, v in want)]
            return 0, {"terminals": shown}, ""
        if args[0] == "get":
            if args[1] in self.timeout_get:
                return 124, None, "timeout"
            t = self.terminals.get(args[1])
            return (0, t, "") if t else (3, {"error": {"kind": "not_found"}}, "no terminal")
        if args[0] == "label":
            k, v = args[2].split("=", 1)
            self.terminals[args[1]]["labels"][k] = v
            return 0, {}, ""
        if args[0] == "run":
            return 0, {"address": "t99"}, ""
        return 0, {}, ""

    def did(self, command):
        return [c for c in self.calls if c[0] == command]


class CoreCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-core-test-")
        self.addCleanup(tmp.cleanup)
        self.home = tmp.name
        patch = mock.patch.object(_common, "STATE_DIR", os.path.join(self.home, "state"))
        patch.start()
        self.addCleanup(patch.stop)

    def run_main(self, module, core, me, argv):
        """Run main() of a script on the core backend with `me` as the caller. Return (exit code, stdout)."""
        found = {"backend": "core", "line": "core", "terminal": me["address"], "record": me,
                 "space": me["labels"].get("herdr.space"), "tab": me["labels"].get("herdr.tab")}
        env = {k: v for k, v in os.environ.items() if k != "HERDR_ENV"}
        env.update(HOME=self.home, SHELL="/bin/sh", HC_TERMINAL_ID=me["address"],
                   XDG_CONFIG_HOME=os.path.join(self.home, "config"))
        out = io.StringIO()
        code = 0
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(_common, "hc", core), \
                mock.patch.object(_common, "detect_backend", lambda: found), \
                mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            with mock.patch.object(module, "hc", core) if hasattr(module, "hc") else contextlib.nullcontext():
                try:
                    module.main()
                except SystemExit as exc:
                    code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue()

    def spawn_run(self, me, role, harness="claude", core=None):
        """The `hc run` argv of one spawn.py run, or None when it ran none."""
        core = core or FakeCore(me)
        argv = ["spawn.py", "--harness", harness, "--role", role, "--model", "prov/m", "--cwd", self.home]
        with mock.patch.multiple(spawn, app_wait=lambda a, s: "idle", system_prompt=lambda r, cfg=None: "prompt",
                                 resolve_pi_model=lambda m: m, pi_executable=lambda: "/opt/fake-bin/pi-launcher"), \
                mock.patch.object(spawn, "herdr") as herdr:
            code, _ = self.run_main(spawn, core, me, argv)
        herdr.assert_not_called()
        runs = core.did("run")
        return code, (runs[0] if runs else None)


def label(run, key):
    return next(a.split("=", 1)[1] for a in run if a.startswith(key + "="))


class RoleTabs(CoreCase):
    def test_each_role_gets_its_own_tab_in_the_space_and_a_coordinator_the_tab_of_the_caller(self):
        me = terminal("t1")
        tabs = {}
        for role in ("scout", "scout", "researcher", "coordinator"):
            code, run = self.spawn_run(me, role)
            self.assertEqual(code, 0)
            tabs.setdefault(role, set()).add(label(run, "herdr.tab"))
        self.assertEqual(len(tabs["scout"]), 1)
        self.assertNotEqual(tabs["scout"], tabs["researcher"])
        self.assertEqual(tabs["coordinator"], {"tb1"})

    def test_a_handoff_coordinator_goes_below_the_caller_and_a_worker_splits_the_largest_pane(self):
        me = terminal("t1")
        _common.write_record("t1", {"pane_id": "t1", "role": "coordinator", "backend": "herdr-core",
                                    "created_at_epoch": time.time()})
        for role, want in (("coordinator", ["herdr.split=down"]), ("worker", ["herdr.split=auto"])):
            code, run = self.spawn_run(me, role)
            self.assertEqual(code, 0)
            self.assertEqual([a for a in run if a.startswith("herdr.split=")], want)
            self.assertNotIn("--no-parent", run)  # the parent stays the caller; for a handoff the app places the pane below it

    def test_the_core_launch_keeps_the_terminal_and_starts_pi_through_pi_executable(self):
        code, run = self.spawn_run(terminal("t1"), "worker", harness="pi")
        self.assertEqual(code, 0)
        options, command = run[:run.index("--")], run[run.index("--") + 1:]
        self.assertIn("--keep", options)
        self.assertIn("--outlive-parent", options)
        self.assertIn("/opt/fake-bin/pi-launcher", command)

    def test_a_core_terminal_without_space_and_tab_labels_starts_nothing(self):
        for missing in ({"space": None}, {"tab": None}):
            with self.subTest(missing=missing):
                core = FakeCore()
                code, run = self.spawn_run(terminal("t1", **missing), "worker", core=core)
                self.assertEqual(code, 2)
                self.assertIsNone(run)


class PanesList(CoreCase):
    def test_the_list_holds_only_the_live_local_terminals_of_the_callers_space(self):
        core = FakeCore(terminal("t1"), terminal("t2", tab="tb2"), terminal("t3", space="sp2"),
                        terminal("t4", state="finished"), terminal("far/t5"), list_all=True)
        code, out = self.run_main(panes, core, core.terminals["t1"], ["panes.py"])
        self.assertEqual(code, 0)
        shown = {line.split("\t")[0].split()[0] for line in out.splitlines()[1:]}
        self.assertEqual(shown, {"t1", "t2"})


class FirstUse(CoreCase):
    def test_init_claims_coordinator_only_when_the_space_has_none(self):
        core = FakeCore(terminal("t1", where="proj / 2"), terminal("t2", where="proj / 2"))
        code, first = self.run_main(init, core, core.terminals["t1"], ["init.py"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(first)["claimed"])
        self.assertEqual(_common.read_record("t1")["role"], "coordinator")
        code, second = self.run_main(init, core, core.terminals["t2"], ["init.py"])
        self.assertEqual(code, 0)
        self.assertEqual((json.loads(second)["role"], json.loads(second)["claimed"]), (None, False))
        self.assertIsNone(_common.read_record("t2"))

    def test_init_claims_nothing_when_hc_get_of_the_coordinator_times_out(self):
        core = FakeCore(terminal("t1", where="proj / 2"), terminal("t2", role="coordinator"), timeout_get={"t2"})
        code, out = self.run_main(init, core, core.terminals["t1"], ["init.py"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIsNone(_common.read_record("t1"))
        self.assertEqual(core.did("label"), [])


    def test_the_first_run_in_the_first_tab_claims_coordinator_also_beside_a_coordinator(self):
        core = FakeCore(terminal("t1", where="proj / 1"), terminal("t2", role="coordinator"))
        code, out = self.run_main(init, core, core.terminals["t1"], ["init.py"])
        self.assertEqual(code, 0)
        self.assertEqual((json.loads(out)["role"], json.loads(out)["claimed"]), ("coordinator", True))
        self.assertEqual(_common.read_record("t1")["role"], "coordinator")
        self.assertIn(("label", "t1", "skill.role=coordinator"), core.did("label"))

    def test_a_task_role_label_or_name_in_the_first_tab_is_never_claimed(self):
        for me in (terminal("t1", role="worker"), terminal("t1", name="proj-reviewer-2")):
            with self.subTest(me=me["name"] or me["labels"]["skill.role"]):
                core = FakeCore(me)
                code, out = self.run_main(init, core, core.terminals["t1"], ["init.py"])
                self.assertEqual(code, 0)
                result = json.loads(out)
                self.assertFalse(result["claimed"])
                self.assertNotEqual(result["role"], "coordinator")
                self.assertNotIn(("label", "t1", "skill.role=coordinator"), core.did("label"))


class Records(CoreCase):
    def test_a_record_older_than_its_terminal_is_ignored(self):
        t = terminal("t1", age=10)
        _common.write_record("t1", {"pane_id": "t1", "role": "reviewer", "backend": "herdr-core",
                                    "created_at_epoch": time.time() - 3600})
        self.assertIsNone(_common.core_record(t))
        self.assertIsNone(_common.core_role(t))
        _common.write_record("t1", {"pane_id": "t1", "role": "reviewer", "backend": "herdr-core",
                                    "created_at_epoch": time.time()})
        self.assertEqual(_common.core_role(t), "reviewer")


if __name__ == "__main__":
    unittest.main()
