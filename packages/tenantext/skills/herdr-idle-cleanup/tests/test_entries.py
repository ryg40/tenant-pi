"""The startup claim and the entries commands of herdr-idle-cleanup.

Run: python3 -m unittest discover -s skills/herdr-idle-cleanup/tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(SKILL, "scripts", "idle_cleanup.py")
MARKER_A = "MARKER-REPORT-A"


def record(rid, repo, state="open", priority="P1", created="2026-01-01T00:00:00+00:00"):
    return {"id": rid, "repo": repo, "workspace": "w-1", "workspace_label": "ws-idle", "pane": "p-" + rid,
            "agent": "pi", "cwd": repo.get("top"), "source": None, "priority": priority,
            "reason": "P1 rule test", "state": state, "created_at": created, "handoff": "20260101-000000.json",
            "extra_field": "kept"}


class EntriesFixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="idle-cleanup-entries-test-")
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        self.repo = os.path.join(root, "repo-a")
        os.makedirs(self.repo)
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.handoffs = os.path.join(root, "handoffs")
        os.makedirs(self.handoffs, mode=0o700)
        config = os.path.join(root, "config")
        os.makedirs(os.path.join(config, "herdr-idle-cleanup"))
        with open(os.path.join(config, "herdr-idle-cleanup", "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"handoff_dir": self.handoffs}, f)
        self.env = dict(os.environ, XDG_CONFIG_HOME=config, PYTHONDONTWRITEBYTECODE="1")
        self.env.pop("HERDR_SKILL_SESSION", None)  # a test run inside a task pane must still claim
        self.mine = {"top": self.repo, "origin": None, "name": "repo-a"}
        self.other = {"top": "/work/repo-b", "origin": None, "name": "repo-b"}

    def write_index(self, records):
        with open(os.path.join(self.handoffs, "index.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "entries": records}, f)
        entries = [{"id": r["id"], "report_state": "report", "headline": "**REPORT 1** Test",
                    "items": [{"number": 1, "state": "Blocked", "text": "Waits."}], "warnings": [],
                    "next": {"actions": []}, "report_text": MARKER_A if r["repo"] is self.mine else "other"}
                   for r in records]
        with open(os.path.join(self.handoffs, "20260101-000000.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "entries": entries}, f)

    def index(self):
        with open(os.path.join(self.handoffs, "index.json"), encoding="utf-8") as f:
            return {r["id"]: r for r in json.load(f)["entries"]}

    def run_cli(self, *args):
        return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, env=self.env,
                              timeout=60)


class StartupTest(EntriesFixture):
    def test_startup_claims_a_matching_record_once(self):
        self.write_index([record("aaaa000000000001", self.mine), record("bbbb000000000002", self.other)])
        first = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn(MARKER_A, first.stdout)
        self.assertIn("aaaa000000000001", first.stdout)
        index = self.index()
        self.assertEqual(index["aaaa000000000001"]["state"], "presented")
        self.assertEqual(index["bbbb000000000002"]["state"], "open")
        second = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual((second.returncode, second.stdout), (0, ""))

    def test_startup_with_the_switch_off_claims_nothing_and_with_it_on_claims(self):
        self.write_index([record("aaaa000000000001", self.mine)])
        self.assertEqual(self.run_cli("switch", "off").returncode, 0)
        off = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual((off.returncode, off.stdout), (0, ""))
        self.assertEqual(self.index()["aaaa000000000001"]["state"], "open")
        self.assertEqual(self.run_cli("switch", "on").returncode, 0)
        on = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual(on.returncode, 0, on.stderr)
        self.assertEqual(self.index()["aaaa000000000001"]["state"], "presented")

    def test_a_switch_write_keeps_the_other_keys(self):
        path = os.path.join(self.env["XDG_CONFIG_HOME"], "herdr-idle-cleanup", "settings.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"handoff_dir": self.handoffs, "idle_minutes": 45, "unknown_key": "kept"}, f)
        os.chmod(path, 0o640)
        self.assertEqual(self.run_cli("switch", "off").returncode, 0)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["startup_assessment"], "off")
        for key, value in (("handoff_dir", self.handoffs), ("idle_minutes", 45), ("unknown_key", "kept")):
            self.assertEqual(data[key], value)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)

    def test_switch_on_after_off_restores_p1(self):
        path = os.path.join(self.env["XDG_CONFIG_HOME"], "herdr-idle-cleanup", "settings.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"startup_assessment": "p1", "idle_minutes": 45}, f)
        for state in ("off", "off", "on"):  # a second off keeps p1
            self.assertEqual(self.run_cli("switch", state).returncode, 0)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual((data["startup_assessment"], data["idle_minutes"]), ("p1", 45))

    def test_startup_without_a_match_prints_nothing_and_changes_nothing(self):
        self.write_index([record("bbbb000000000002", self.other)])
        path = os.path.join(self.handoffs, "index.json")
        with open(path, "rb") as f:
            before = f.read()
        out = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual((out.returncode, out.stdout), (0, ""))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_startup_in_a_task_session_prints_nothing_and_changes_nothing(self):
        self.write_index([record("aaaa000000000001", self.mine)])
        path = os.path.join(self.handoffs, "index.json")
        with open(path, "rb") as f:
            before = f.read()
        self.env["HERDR_SKILL_SESSION"] = "task"
        out = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual((out.returncode, out.stdout, out.stderr), (0, "", ""))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_a_record_with_a_malformed_item_stays_open(self):
        self.write_index([record("aaaa000000000001", self.mine)])
        handoff = os.path.join(self.handoffs, "20260101-000000.json")
        with open(handoff, encoding="utf-8") as f:
            data = json.load(f)
        data["entries"][0]["items"] = ["not an object"]
        with open(handoff, "w", encoding="utf-8") as f:
            json.dump(data, f)
        out = self.run_cli("startup", "--cwd", self.repo)
        self.assertEqual((out.returncode, out.stdout), (0, ""), out.stderr)
        self.assertEqual(self.index()["aaaa000000000001"]["state"], "open")

    def test_two_startups_at_once_claim_the_record_once(self):
        records = [record("aaaa000000000001", self.mine)] + [
            record(f"cccc00000000{n:04d}", self.other) for n in range(20)]
        self.write_index(records)
        procs = [subprocess.Popen([sys.executable, SCRIPT, "startup", "--cwd", self.repo], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=self.env) for _ in range(2)]
        outs = [p.communicate(timeout=60) for p in procs]
        self.assertEqual([p.returncode for p in procs], [0, 0], [e for _, e in outs])
        printed = sorted(bool(o) for o, _ in outs)
        self.assertEqual(printed, [False, True])
        index = self.index()
        self.assertEqual(sorted(index), sorted(r["id"] for r in records))
        self.assertEqual(index["aaaa000000000001"]["state"], "presented")
        self.assertTrue(all(r["extra_field"] == "kept" for r in index.values()))


class EntriesCommandTest(EntriesFixture):
    def test_set_done_and_list_this_repository_first(self):
        self.write_index([record("bbbb000000000002", self.other, priority="P1"),
                          record("aaaa000000000001", self.mine, priority="P3")])
        out = self.run_cli("entries", "set", "aaaa000000000001", "done")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(self.index()["aaaa000000000001"]["state"], "done")
        listed = self.run_cli("entries", "list", "--cwd", self.repo)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        ids = [line.split("\t")[0] for line in listed.stdout.splitlines() if "\t" in line and not line.startswith("ID")]
        self.assertEqual(ids, ["aaaa000000000001", "bbbb000000000002"])


if __name__ == "__main__":
    unittest.main()
