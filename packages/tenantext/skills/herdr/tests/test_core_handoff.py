"""handoff.py and the coordinator name of spawn.py on herdr-core.

The fake `hc` of test_core_layout.py keeps the terminals. A fake `subprocess` stands for spawn.py and ask.py.
No herdr-core is needed.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import json
import os
import subprocess
import sys
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_core_layout import CoreCase, FakeCore, load, terminal  # noqa: E402

import _common  # noqa: E402

handoff = load("handoff.py")
EXIT = {name: entry["code"] for name, entry in _common.CONTRACT["handoff"]["exit"].items()}
MARKER = _common.CONTRACT["handoff"]["accepted_marker"]


class FakeScripts:
    """Stands for the `subprocess` module of handoff.py: spawn.py starts t9, ask.py answers from a list."""

    TimeoutExpired = subprocess.TimeoutExpired
    SubprocessError = subprocess.SubprocessError
    DEVNULL = subprocess.DEVNULL
    PIPE = subprocess.PIPE

    def __init__(self, replies, core):
        self.replies = list(replies)  # (exit code, reply text) for each ask.py call
        self.core = core
        self.calls = []
        self.spawns = []  # the command of each spawn.py call
        self.helpers = []  # each helper that handoff.py started

    def Popen(self, cmd, **kwargs):
        # The intermediate process that starts the helper and exits.
        self.helpers.append(types.SimpleNamespace(address=cmd[-1], space=cmd[-2],
                                                  after_kill=bool(self.core.did("kill"))))
        self.calls.append("helper")
        return types.SimpleNamespace(wait=lambda timeout=None: 0)

    def run(self, cmd, **kwargs):
        script = os.path.basename(cmd[1])
        self.calls.append(script)
        if script == "spawn.py":
            self.spawns.append(cmd)
            out = json.dumps({"pane_id": "t9", "name": "proj-coordinator-2"})
            return types.SimpleNamespace(returncode=0, stdout=out + "\n", stderr="")
        code, reply = self.replies.pop(0)
        return types.SimpleNamespace(returncode=code, stdout=f"pane=t9\n--- reply ---\n{reply}\n", stderr="")


def coordinator_record(address, space="sp1", **extra):
    _common.write_record(address, dict({"pane_id": address, "role": "coordinator", "harness": "claude",
                                        "workspace_id": space, "session": "primary", "self": True,
                                        "backend": "herdr-core", "created_at_epoch": time.time()}, **extra))


class FailingCore(FakeCore):
    """A FakeCore whose answer to one command is the given (exit code, JSON, raw text)."""

    def __init__(self, *terminals, fail=None, answer=None):
        super().__init__(*terminals)
        self.fail, self.answer = fail, answer

    def __call__(self, *args, timeout=None):
        if args[0] == self.fail:
            self.calls.append(args)
            return self.answer
        return super().__call__(*args, timeout=timeout)


class CoreHandoff(CoreCase):
    def setUp(self):
        super().setUp()
        self.file = os.path.join(self.home, "handoff.md")
        with open(self.file, "w", encoding="utf-8") as f:
            f.write("# Handoff\n\nState of the work.\n")

    def handoff(self, core, replies=((0, f"{MARKER} first step"), (124, ""))):
        scripts = FakeScripts(replies, core)
        with mock.patch.object(handoff, "subprocess", scripts):
            code, out = self.run_main(handoff, core, core.terminals["t1"],
                                      ["handoff.py", "--file", self.file, "--timeout", "5"])
        self.helpers, self.spawns = scripts.helpers, scripts.spawns
        return code, scripts.calls

    def removed(self, core, address, space="sp1"):
        """The `hc rm` calls of the helper for `address` after the kill, in the fake core."""
        with mock.patch.object(handoff, "hc", core):
            handoff.remove_when_finished(address, space, seconds=0, pause=0)
        return [c[:2] for c in core.did("rm")]

    def test_a_caller_without_a_valid_coordinator_record_starts_nothing(self):
        for case, write in (("no record", lambda: None),
                            ("a stale record", lambda: coordinator_record("t1", created_at_epoch=time.time() - 3600)),
                            ("a worker record", lambda: coordinator_record("t1", role="worker", self=False)),
                            ("a coordinator record of another space", lambda: coordinator_record("t1", space="sp2"))):
            with self.subTest(case=case):
                _common.remove_record("t1")
                write()
                core = FakeCore(terminal("t1"), terminal("t2"))
                code, scripts = self.handoff(core)
                self.assertEqual(code, EXIT["usage"])
                self.assertEqual(scripts, [])
                self.assertEqual((core.did("run"), core.did("kill")), ([], []))

    def test_a_confirmed_handoff_kills_only_the_own_terminal_as_the_last_step(self):
        coordinator_record("t1")
        core = FakeCore(terminal("t1", role="coordinator"), terminal("t2"))
        code, scripts = self.handoff(core)
        self.assertEqual(code, EXIT["done"])
        self.assertEqual([c[:2] for c in core.did("kill")], [("kill", "t1")])
        self.assertEqual(core.calls[-1][:2], ("kill", "t1"))
        self.assertIsNone(_common.read_record("t1"))
        self.assertIn(("t1", "sp1"), [(h.address, h.space) for h in self.helpers if not h.after_kill])

    def test_a_failed_kill_of_the_own_terminal_writes_the_record_back(self):
        for case, answer in (("exit 1", (1, None, "kill failed")),
                             ("an error object", (0, {"error": {"kind": "io"}}, "kill failed"))):
            with self.subTest(case=case):
                coordinator_record("t1")
                core = FailingCore(terminal("t1"), terminal("t2"), fail="kill", answer=answer)
                code, _ = self.handoff(core)
                self.assertEqual(code, EXIT["close_failed"])
                self.assertEqual([c[:2] for c in core.did("kill")], [("kill", "t1")])
                self.assertEqual((_common.read_record("t1") or {}).get("role"), "coordinator")

    def test_the_helper_removes_only_a_finished_coordinator_terminal_of_the_space(self):
        for case, t, want in (
                ("a live coordinator terminal", terminal("t1", role="coordinator"), []),
                ("a finished coordinator terminal of another space",
                 terminal("t1", space="sp2", state="finished", role="coordinator"), []),
                ("a finished worker terminal", terminal("t1", state="finished", role="worker"), []),
                ("a finished terminal with no role", terminal("t1", state="finished"), []),
                ("a finished coordinator terminal of the space",
                 terminal("t1", state="finished", role="coordinator"), [("rm", "t1")])):
            with self.subTest(case=case):
                self.assertEqual(self.removed(FakeCore(t), "t1"), want)

    def test_the_new_coordinator_starts_in_the_start_folder_of_the_terminal_not_in_the_folder_of_the_shell(self):
        # The shell of the caller is in a subfolder; the terminal started in /work/proj (`cwd` of `hc get`).
        for cwd, want in (("/work/proj", "/work/proj"),
                          (None, "/work/proj/packages")):  # no start folder in the record: os.getcwd() stays
            with self.subTest(cwd=cwd):
                coordinator_record("t1")
                me = terminal("t1")
                me["cwd"] = cwd
                with mock.patch.object(handoff.os, "getcwd", return_value="/work/proj/packages"):
                    code, _ = self.handoff(FakeCore(me, terminal("t2")))
                self.assertEqual(code, EXIT["done"])
                cmd = self.spawns[-1]
                self.assertEqual(cmd[cmd.index("--cwd") + 1], want)

    def test_a_failed_list_of_the_terminals_starts_nothing(self):
        coordinator_record("t1")
        with open(self.file, encoding="utf-8") as f:
            before = f.read()
        core = FailingCore(terminal("t1"), terminal("t2"), fail="ls", answer=(1, None, "ls failed"))
        code, scripts = self.handoff(core)
        self.assertEqual(code, EXIT["usage"])
        self.assertEqual(scripts, [])
        self.assertEqual((core.did("run"), core.did("kill")), ([], []))
        with open(self.file, encoding="utf-8") as f:
            self.assertEqual(f.read(), before)

    def test_a_start_prompt_without_the_marker_kills_nothing(self):
        coordinator_record("t1")
        core = FakeCore(terminal("t1"), terminal("t2"))
        code, _ = self.handoff(core, replies=((0, "I read the file."),))
        self.assertEqual(code, EXIT["not_accepted"])
        self.assertEqual(core.did("kill"), [])
        self.assertIsNotNone(_common.read_record("t1"))
        self.assertEqual(self.helpers, [])

    def test_the_open_panes_are_the_task_terminals_of_the_space(self):
        coordinator_record("t1")
        coordinator_record("t4")
        idle_shell = terminal("t6")
        idle_shell["status"] = {}
        core = FakeCore(terminal("t1"), terminal("t2", tab="tb2"), terminal("t3", space="sp2"), terminal("t4"),
                        terminal("far/t5"), idle_shell, terminal("t7", role="coordinator"))
        code, _ = self.handoff(core)
        self.assertEqual(code, EXIT["done"])
        with open(self.file, encoding="utf-8") as f:
            section = f.read().split(handoff.SECTION, 1)[1]
        listed = {line.split("`")[1] for line in section.splitlines() if line.startswith("- `")}
        self.assertEqual(listed, {"t2"})

    def test_the_new_coordinator_after_an_unnamed_first_one_gets_number_2(self):
        coordinator_record("t1")
        code, run = self.spawn_run(terminal("t1"), "coordinator")
        self.assertEqual(code, 0)
        self.assertEqual(run[run.index("--name") + 1], "proj-coordinator-2")


if __name__ == "__main__":
    unittest.main()
