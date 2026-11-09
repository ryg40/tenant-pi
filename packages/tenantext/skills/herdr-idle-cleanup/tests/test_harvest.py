"""The harvest of herdr-idle-cleanup parses the final reports of idle panes, ranks them and writes the handoff.

Run: python3 -m unittest discover -s skills/herdr-idle-cleanup/tests
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
import idle_cleanup  # noqa: E402

NOW = 1_800_000_000.0

FULL_BLOCK = """Status: the work is merged.

```markdown
**REPORT 9** An example inside a fence does not count
- **[1]** Failed: An example.
```

> **REPORT 8** A quote does not count either

**OUTCOME** The scan command is merged

- **[1]** Done: The scan is on main.
- **[2]** Done: The tests pass.

**Next:**
- **[a]** Agent: Start the harvest ticket.

The next ticket uses the same worktree layout."""

BLOCKED_BLOCK = """**REPORT 2** The release waits

- **[1]** Done: The tag is built.
- **[2]** Blocked: The upload waits for the release entry.

**Next:**
- **[a]** Agent: Read the log of the upload.
- **[b]** Owner, after the tag check passes: Make the release entry."""

NO_BLOCK = "I looked at the logs and the service runs again.\nNothing else changed."

PI_BLOCK = """**REPORT 1** The profile is installed

- **[1]** Unverified: The profile loads on a fresh login.

**Next:** None. No work is left."""

# Rows of (reply, expected priority, expected report state).
RANK_ROWS = [
    ("**REPORT 1** The build ran\n\n- **[1]** Failed: The build stops at the link step.\n\n"
     "**Next:**\n- **[a]** Agent: Read the build log.", "P1", "report"),
    ("**REPORT 1** The tag is built\n\n- **[1]** Done: The tag is built.\n\n"
     "**Next:**\n- **[a]** Owner: Make the release entry.", "P1", "report"),
    ("**REPORT 1** The tag is built\n\n- **[1]** Done: The tag is built.\n\n"
     "**Next:**\n- **[a]** Owner, after the check passes: Make the release entry.", "P2", "report"),
    ("The scan found an exposed credential in the old log.", "P1", "no report"),
    ("**REPORT 1** The build ran \n\n- **[1]** Failed: The build stops at the link step.\n\n"
     "**Next:**\n- **[a]** Agent: Read the build log.", "P1", "no report"),
]


class HarvestFixture(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="idle-cleanup-harvest-test-")
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.handoffs = os.path.join(self.tmp, "handoffs")

    def claude_transcript(self, name, *replies):
        path = os.path.join(self.tmp, name + ".jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "go"}}) + "\n")
            for text in replies:
                f.write(json.dumps({"type": "assistant", "message": {
                    "role": "assistant", "content": [{"type": "text", "text": text}]}}) + "\n")
        return path

    def pi_session(self, name, reply):
        path = os.path.join(self.tmp, name + ".jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "session", "cwd": "/work/repo-b", "timestamp": "2026-01-01T00:00:00Z"}) + "\n")
            f.write(json.dumps({"type": "message", "message": {
                "role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": reply}]}}) + "\n")
        return path

    def pane(self, pid, agent, transcript, source="transcript", cwd="/work/repo-a", top="/work/repo-a"):
        return {"pane_id": pid, "agent": agent, "name": pid + "-agent", "status": "idle", "cwd": cwd,
                "transcript": transcript, "activity_source": source, "git_top": top, "git_dirty": False}

    def standard_panes(self):
        return [
            self.pane("ws-idle:p1", "claude", self.claude_transcript("full", "An older reply.", FULL_BLOCK)),
            self.pane("ws-idle:p2", "claude", self.claude_transcript("blocked", BLOCKED_BLOCK)),
            self.pane("ws-idle:p3", "claude", self.claude_transcript("plain", NO_BLOCK)),
            # A Pi pane with no transcript path from Herdr: the scan found its Pi session file.
            self.pane("ws-idle:p4", "pi", self.pi_session("pi", PI_BLOCK), source="pi-session-file",
                      cwd="/work/repo-b", top="/work/repo-b"),
        ]

    def write_scan(self, idle_panes):
        scan = {"version": 1, "scanned_at": "2027-01-15T08:00:00+00:00", "workspaces": [
            {"workspace_id": "w1", "label": "ws-idle", "class": "idle", "panes": idle_panes},
            {"workspace_id": "w2", "label": "ws-working", "class": "active", "panes": [
                self.pane("ws-working:p1", "claude", self.claude_transcript("busy", BLOCKED_BLOCK))]},
        ]}
        path = os.path.join(self.tmp, "scan.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(scan, f)
        return path

    def run_harvest(self, panes, now=NOW):
        result = idle_cleanup.harvest(self.write_scan(panes), self.handoffs, now=now)
        with open(result["json"], encoding="utf-8") as f:
            handoff = json.load(f)
        with open(result["index"], encoding="utf-8") as f:
            index = json.load(f)
        return result, handoff, index

    def test_fixture_replies_give_the_right_items_priorities_and_states_and_the_index_lists_p1_first(self):
        panes = self.standard_panes()
        for n, (reply, _, _) in enumerate(RANK_ROWS, 1):
            panes.append(self.pane(f"ws-idle:r{n}", "claude", self.claude_transcript(f"row{n}", reply)))
        result, handoff, _ = self.run_harvest(panes)
        by_pane = {e["pane"]: e for e in handoff["entries"]}
        summary = {pid: (e["priority"], e["report_state"], [i["state"] for i in e["items"]], e["source"]["kind"])
                   for pid, e in by_pane.items() if not pid.startswith("ws-idle:r")}
        self.assertEqual(summary, {
            "ws-idle:p1": ("P3", "report", ["Done", "Done"], "transcript"),
            "ws-idle:p2": ("P1", "report", ["Done", "Blocked"], "transcript"),
            "ws-idle:p3": ("P3", "no report", [], "transcript"),
            "ws-idle:p4": ("P2", "report", ["Unverified"], "pi-session-file"),
        })
        rows = [(by_pane[f"ws-idle:r{n}"]["priority"], by_pane[f"ws-idle:r{n}"]["report_state"])
                for n in range(1, len(RANK_ROWS) + 1)]
        self.assertEqual(rows, [(prio, state) for _, prio, state in RANK_ROWS])
        self.assertEqual(by_pane["ws-idle:r5"]["items"], [])
        self.assertEqual([(a["label"], a["actor"], a["condition"]) for a in by_pane["ws-idle:p2"]["next"]["actions"]],
                         [("a", "Agent", None), ("b", "Owner", "after the tag check passes")])
        self.assertEqual(by_pane["ws-idle:p3"]["report_text"], NO_BLOCK)
        with open(result["md"], encoding="utf-8") as f:
            md = f.read()
        index_part = md.split("## Priority index", 1)[1].split("\n## ", 1)[0]
        order = re.findall(r"ws-idle:[a-z0-9]+", index_part)
        self.assertEqual(sorted(order), sorted(by_pane))
        priorities = [by_pane[pid]["priority"] for pid in order]
        self.assertEqual(priorities, sorted(priorities))

    def test_a_second_harvest_adds_new_entries_once_and_keeps_older_states(self):
        panes = self.standard_panes()
        _, _, index = self.run_harvest(panes)
        self.assertEqual(len(index["entries"]), 4)
        old_id = {r["pane"]: r["id"] for r in index["entries"]}
        states = {old_id["ws-idle:p2"]: "dismissed", old_id["ws-idle:p3"]: "presented"}
        index["entries"] = [dict(r, state=states.get(r["id"], r["state"])) for r in index["entries"]]
        with open(os.path.join(self.handoffs, "index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f)
        # Panes p1 and p3 give a new final reply; a new pane appears; p2 and p4 are unchanged.
        panes[0] = self.pane("ws-idle:p1", "claude", self.claude_transcript("full2", FULL_BLOCK, NO_BLOCK))
        panes[2] = self.pane("ws-idle:p3", "claude", self.claude_transcript("plain2", NO_BLOCK, PI_BLOCK))
        panes.append(self.pane("ws-idle:p5", "claude", self.claude_transcript("new", FULL_BLOCK)))
        result, _, index = self.run_harvest(panes, now=NOW + 60)
        self.assertEqual((len(index["entries"]), result["index_added"]), (7, 3))
        by_id = {r["id"]: r for r in index["entries"]}
        for rid, state in states.items():
            self.assertEqual((by_id[rid]["state"], by_id[rid].get("superseded_by")), (state, None))
        # The changed reply of p1 supersedes its older open entry.
        old_p1, new_p1 = [r for r in index["entries"] if r["pane"] == "ws-idle:p1"]
        self.assertEqual((old_p1["state"], old_p1.get("superseded_by")), ("dismissed", new_p1["id"]))
        rest = [r["state"] for r in index["entries"] if r["id"] not in (*states, old_p1["id"])]
        self.assertEqual(rest, ["open"] * 4)

    def test_the_handoff_directory_has_mode_0700_and_its_files_mode_0600(self):
        result, _, _ = self.run_harvest(self.standard_panes())
        self.assertEqual(stat.S_IMODE(os.stat(self.handoffs).st_mode), 0o700)
        for path in (result["md"], result["json"], result["index"]):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600, path)

    def test_a_remote_user_name_and_password_appear_in_no_output_file(self):
        repo = os.path.join(self.tmp, "repo-c")
        os.makedirs(repo)
        user, password = "harvestuser", "zebramarker5521"
        subprocess.run(["git", "init", "-q", repo], check=True)
        remote = "https://" + user + ":" + password + "@example.invalid/team/repo-c.git"
        subprocess.run(["git", "-C", repo, "remote", "add", "origin", remote], check=True)
        pane = self.pane("ws-idle:p1", "claude", self.claude_transcript("repo-c", FULL_BLOCK), cwd=repo, top=repo)
        _, handoff, _ = self.run_harvest([pane])
        clean = "https://example.invalid/team/repo-c.git"
        self.assertEqual(handoff["entries"][0]["repo"], {"top": repo, "origin": clean, "name": "repo-c"})
        for name in os.listdir(self.handoffs):
            with open(os.path.join(self.handoffs, name), encoding="utf-8") as f:
                text = f.read()
            self.assertNotIn(password, text, name)
            self.assertNotIn(user, text, name)


if __name__ == "__main__":
    unittest.main()
