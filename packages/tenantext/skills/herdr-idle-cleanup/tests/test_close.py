"""The close of herdr-idle-cleanup closes only idle, unprotected workspaces with a handoff entry, by ID.

Run: python3 -m unittest discover -s skills/herdr-idle-cleanup/tests
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import idle_cleanup  # noqa: E402
import test_scan as ts  # noqa: E402  (the stub Herdr of the scan tests)

NOW = ts.NOW
ENV = {"HERDR_PANE_ID": "w-own:p1", "HERDR_WORKSPACE_ID": "w-own"}


class StubHerdrWithClose(ts.StubHerdr):
    """The read stub of the scan tests, plus `workspace close <id>`. It records each close."""

    def __init__(self, *args):
        super().__init__(*args)
        self.closed = []

    def __call__(self, *args, timeout=None):
        if tuple(args[:2]) == ("workspace", "close"):
            self.closed.append(args[2])
            return 0, {"result": {}}, ""
        return super().__call__(*args, timeout=timeout)


class CloseFixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="idle-cleanup-close-test-")
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.handoffs = os.path.join(self.tmp, "handoffs")
        self.scan_path = os.path.join(self.handoffs, "scan.json")
        self.index_path = os.path.join(self.handoffs, "index.json")

    def pane(self, wid, n, status, minutes_ago):
        path = os.path.join(self.tmp, f"{wid}-{n}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "message": {
                "role": "assistant", "content": [{"type": "text", "text": f"Reply of {wid} pane {n}."}]}}) + "\n")
        os.utime(path, (NOW - minutes_ago * 60, NOW - minutes_ago * 60))
        return {"pane_id": f"{wid}:p{n}", "tab_id": f"{wid}:t1", "workspace_id": wid, "agent": "claude",
                "agent_status": status, "cwd": "/work/repo-a", "foreground_cwd": "/work/repo-a",
                "agent_session": {"kind": "path", "value": path}}

    def setup_round(self):
        """Scan, then harvest, from one stub. All workspaces share one label: close must use the ID.

        scan.json is edited to call the caller's workspace `idle`, so the harvest writes its records too.
        """
        panes = [self.pane("w-own", 1, "idle", 120), self.pane("w-idle", 1, "idle", 120),
                 self.pane("w-idle", 2, "done", 90), self.pane("w-relay", 1, "idle", 300),
                 self.pane("w-later", 1, "idle", 120), self.pane("w-busy", 1, "working", 1),
                 self.pane("w-gap", 1, "idle", 120), self.pane("w-gap", 2, "idle", 120)]
        wids = ["w-own", "w-idle", "w-relay", "w-later", "w-busy", "w-gap"]
        stub = StubHerdrWithClose([{"workspace_id": w, "label": "repo"} for w in wids], panes, {})
        with mock.patch.object(idle_cleanup, "HERDR_RUNNER", stub), mock.patch.dict(os.environ, ENV):
            scan = idle_cleanup.scan(idle_minutes=30, protected=["w-relay"], now=NOW)
        for ws in scan["workspaces"]:
            if ws["workspace_id"] == "w-own":
                ws["class"] = "idle"
        idle_cleanup.write_json_atomic(self.scan_path, scan)
        idle_cleanup.harvest(self.scan_path, self.handoffs, now=NOW)
        # Pane 2 of w-gap has no record in index.json.
        with open(self.index_path, encoding="utf-8") as f:
            index = json.load(f)
        index["entries"] = [r for r in index["entries"] if r["pane"] != "w-gap:p2"]
        idle_cleanup.write_json_atomic(self.index_path, index)
        # After the scan, the pane of w-later starts to work again.
        next(p for p in panes if p["pane_id"] == "w-later:p1")["agent_status"] = "working"
        return stub

    def run_close(self, stub, do_close):
        with mock.patch.object(idle_cleanup, "HERDR_RUNNER", stub), mock.patch.dict(os.environ, ENV):
            r = idle_cleanup.close(self.scan_path, self.index_path, do_close=do_close, now=NOW)
        return {row["workspace_id"]: (row["result"], row["reason"]) for row in r["rows"]}

    def test_plan_closes_nothing_and_close_yes_closes_only_the_idle_unprotected_workspaces_with_an_entry(self):
        stub = self.setup_round()
        plan = self.run_close(stub, do_close=False)
        self.assertEqual(stub.closed, [])
        self.assertEqual(plan["w-idle"], ("close", None))
        self.assertEqual(plan["w-later"], ("keep", "changed since the scan"))
        self.assertEqual(plan["w-own"], ("keep", "protected"))
        self.assertEqual(plan["w-relay"], ("keep", "protected"))
        self.assertEqual(plan["w-busy"], ("keep", "active"))
        done = self.run_close(stub, do_close=True)
        self.assertEqual(stub.closed, ["w-idle"])
        self.assertEqual(done["w-idle"], ("closed", None))
        self.assertEqual(done["w-own"], ("keep", "protected"))
        self.assertEqual(done["w-later"], ("keep", "changed since the scan"))

    def test_a_workspace_with_an_agent_pane_without_a_record_is_kept_with_no_handoff_entry(self):
        stub = self.setup_round()
        done = self.run_close(stub, do_close=True)
        self.assertEqual(done["w-gap"], ("keep", "no handoff entry"))
        self.assertNotIn("w-gap", stub.closed)

    def test_each_closed_record_holds_its_resume_data_and_closed_at(self):
        stub = self.setup_round()
        self.run_close(stub, do_close=True)
        with open(self.index_path, encoding="utf-8") as f:
            index = json.load(f)
        closed = {r["pane"]: r for r in index["entries"] if r.get("closed_at")}
        self.assertEqual(sorted(closed), ["w-idle:p1", "w-idle:p2"])
        for pid, r in closed.items():
            n = pid.rsplit("p", 1)[1]
            self.assertEqual(r["resume"], {
                "workspace": "w-idle", "workspace_label": "repo", "pane": pid, "agent": "claude",
                "name": pid + "-agent", "cwd": "/work/repo-a",
                "session_file": os.path.join(self.tmp, f"w-idle-{n}.jsonl")})
            self.assertEqual(r["closed_at"], "2027-01-15T08:00:00+00:00")

    def test_the_command_line_closes_only_with_close_and_yes(self):
        stub = self.setup_round()
        cfg = os.path.join(self.tmp, "cfg")
        os.makedirs(os.path.join(cfg, "herdr-idle-cleanup"))
        with open(os.path.join(cfg, "herdr-idle-cleanup", "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"handoff_dir": self.handoffs}, f)
        env = dict(ENV, HERDR_ENV="1", XDG_CONFIG_HOME=cfg)
        with mock.patch.object(idle_cleanup, "HERDR_RUNNER", stub), mock.patch.dict(os.environ, env), \
                mock.patch.object(idle_cleanup.time, "time", return_value=NOW), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(idle_cleanup.main(["close", "--close"]), 0)
            self.assertEqual(stub.closed, [])
            with self.assertRaises(SystemExit) as stop:
                idle_cleanup.main(["close", "--yes"])
            self.assertNotIn(stop.exception.code, (0, None))
            self.assertEqual(stub.closed, [])
            # The same fixture closes a workspace with both flags, so the two runs above had one to close.
            self.assertEqual(idle_cleanup.main(["close", "--close", "--yes"]), 0)
            self.assertEqual(stub.closed, ["w-idle"])


if __name__ == "__main__":
    unittest.main()
