"""The scan of herdr-idle-cleanup classifies workspaces from fixture Herdr data and runs only read calls.

Run: python3 -m unittest discover -s skills/herdr-idle-cleanup/tests
"""
import os
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
import idle_cleanup  # noqa: E402

NOW = 1_800_000_000.0
QUESTION_SCREEN = "Edit file src/app.py\nDo you want to make this edit to app.py?\n> 1. Yes\n  2. No\n"
QUIET_SCREEN = "Done. The report is above.\n> \n"
UNREADABLE = (1, {"error": {"code": "agent_not_found", "message": "no such pane"}}, "")
READ_SUBCOMMANDS = {("workspace", "list"), ("tab", "list"), ("pane", "list"), ("agent", "list"),
                    ("agent", "get"), ("agent", "read")}


class StubHerdr:
    """A Herdr runner from fixture data. It fails the test on any subcommand outside the read set."""

    def __init__(self, workspaces, panes, screens):
        self.workspaces, self.panes, self.screens, self.calls = workspaces, panes, screens, []

    def __call__(self, *args, timeout=None):
        self.calls.append(args)
        if tuple(args[:2]) not in READ_SUBCOMMANDS:
            raise AssertionError(f"state-changing Herdr call: {args}")
        sub = tuple(args[:2])
        if sub == ("workspace", "list"):
            return 0, {"result": {"workspaces": self.workspaces}}, ""
        if sub == ("pane", "list"):
            return 0, {"result": {"panes": self.panes}}, ""
        if sub == ("agent", "list"):
            return 0, {"result": {"agents": [dict(p, name=p["pane_id"] + "-agent") for p in self.panes
                                              if p.get("agent")]}}, ""
        if sub == ("tab", "list"):
            wid = args[3]
            return 0, {"result": {"tabs": [{"tab_id": f"{wid}:t1", "label": "main", "workspace_id": wid}]}}, ""
        if sub == ("agent", "get"):
            pane = next(p for p in self.panes if p["pane_id"] == args[2])
            return 0, {"result": {"agent": dict(pane, name=pane["pane_id"] + "-agent")}}, ""
        screen = self.screens.get(args[2], QUIET_SCREEN)
        return screen if isinstance(screen, tuple) else (0, None, screen)


class ScanFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="idle-cleanup-test-")
        self.addCleanup(self.tmp.cleanup)

    def transcript(self, name, minutes_ago):
        path = os.path.join(self.tmp.name, name + ".jsonl")
        with open(path, "w") as f:
            f.write("{}\n")
        os.utime(path, (NOW - minutes_ago * 60, NOW - minutes_ago * 60))
        return path

    def pane(self, wid, n, agent, status, minutes_ago=None):
        p = {"pane_id": f"{wid}:p{n}", "tab_id": f"{wid}:t1", "workspace_id": wid, "agent": agent,
             "agent_status": status, "cwd": "/work/repo-a", "foreground_cwd": "/work/repo-a"}
        if minutes_ago is not None:
            p["agent_session"] = {"kind": "path", "value": self.transcript(f"{wid}-{n}", minutes_ago)}
        return p

    def run_scan(self, workspaces, panes, screens=None, protected=()):
        stub = StubHerdr([{"workspace_id": w, "label": w} for w in workspaces], panes, screens or {})
        env = {"HERDR_PANE_ID": "ws-own:p1", "HERDR_WORKSPACE_ID": "ws-own"}
        with mock.patch.object(idle_cleanup, "HERDR_RUNNER", stub), mock.patch.dict(os.environ, env):
            result = idle_cleanup.scan(idle_minutes=30, protected=protected, now=NOW)
        return result, stub, {w["workspace_id"]: w["class"] for w in result["workspaces"]}

    def standard(self):
        """(workspaces, panes, screens, expected class of each workspace). One row for each workspace."""
        rows = [
            # (workspace, panes as (agent, status, minutes since the transcript changed), expected class)
            ("ws-own", [("claude", "working", 0)], "protected"),
            ("ws-idle", [("claude", "idle", 120), ("pi", "done", 90)], "idle"),
            ("ws-working", [("claude", "working", 1)], "active"),
            ("ws-blocked", [("claude", "blocked", 200)], "blocked"),
            ("ws-unknown", [(None, "unknown", None)], "unknown"),
            ("ws-relay", [("claude", "idle", 300)], "protected"),
            ("ws-recent-idle", [("claude", "idle", 5)], "active"),
            ("ws-long-working", [("claude", "working", 200)], "active"),
            ("ws-no-transcript", [("claude", "idle", None)], "unknown"),
            ("ws-status-unknown", [("claude", "unknown", 200)], "unknown"),
            ("ws-screen-unreadable", [("claude", "idle", 120)], "unknown"),
            ("ws-background", [("claude", "idle", 120)], "active"),
        ]
        panes = [self.pane(wid, n, *spec) for wid, specs, _ in rows for n, spec in enumerate(specs, 1)]
        screens = {"ws-screen-unreadable:p1": UNREADABLE,
                   "ws-background:p1": "Done. The report is above.\n> \n  \u2190 1 agent\n"}
        return [wid for wid, _, _ in rows], panes, screens, {wid: cls for wid, _, cls in rows}

    def test_each_workspace_gets_its_class_and_the_callers_workspace_is_protected(self):
        workspaces, panes, screens, expected = self.standard()
        _, _, classes = self.run_scan(workspaces, panes, screens, protected=["ws-relay"])
        self.assertEqual(classes, expected)

    def test_a_done_pane_with_a_pending_question_makes_its_workspace_blocked(self):
        for screen in (QUESTION_SCREEN,
                       "Do you want to overwrite notes.txt?\n",
                       "Ready to start. Would you like to proceed?\n",
                       "Do you trust the files in this folder?\n",
                       "Proceed? [Y/n]\n",
                       "Pick one\n \u276f 1. Yes\n   2. No\n"):
            with self.subTest(screen=screen):
                panes = [self.pane("ws-ask", 1, "claude", "done", 120),
                         self.pane("ws-ask", 2, "claude", "idle", 120)]
                _, _, classes = self.run_scan(["ws-ask"], panes, screens={"ws-ask:p1": screen})
                self.assertEqual(classes["ws-ask"], "blocked")

    def test_a_full_scan_makes_only_read_calls(self):
        workspaces, panes, screens, _ = self.standard()
        _, stub, _ = self.run_scan(workspaces, panes, screens)
        self.assertTrue(stub.calls)
        with mock.patch.object(idle_cleanup, "HERDR_RUNNER", stub):
            with self.assertRaises(idle_cleanup.HerdrWriteRefused):
                idle_cleanup.read_herdr("workspace", "close", "ws-idle")
        self.assertNotIn(("workspace", "close", "ws-idle"), stub.calls)

    def test_scan_json_has_mode_0600_in_a_directory_of_mode_0700(self):
        out = os.path.join(self.tmp.name, "handoffs", "scan.json")
        idle_cleanup.write_json_atomic(out, {"version": 1, "scanned_at_epoch": time.time()})
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(out)).st_mode), 0o700)


if __name__ == "__main__":
    unittest.main()
