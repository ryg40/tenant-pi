"""ask.py: a stall on the first turn, a compaction inside a turn, a wait-only run, and the Pi session file on disk.

A fake clock and fake Herdr calls drive each case. No Herdr server is needed.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import datetime
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

spec = importlib.util.spec_from_file_location("ask_turns", os.path.join(SKILL, "scripts", "ask.py"))
ask = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask)
import _common  # noqa: E402  (the module object that ask.py uses)


def entry(role, text):
    return {"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}}


PI_COMPACTION = {"type": "compaction", "id": "c1", "summary": "earlier work", "firstKeptEntryId": "c1"}
CLAUDE_COMPACTION = {"type": "system", "subtype": "compact_boundary", "isSidechain": False}


class Pane:
    """A fake pane: a transcript file, a status, a clock, and the Herdr calls that ask.py makes."""

    def __init__(self, test, status="idle", lines=()):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-ask-test-")
        test.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "session.jsonl")
        self.write(*lines)
        self.status, self.clock, self.calls, self.events = status, 1000.0, [], []
        self.agent_dirs = []  # no Pi session file on disk unless a test adds an agent directory

    def write(self, *lines):
        with open(self.path, "a", encoding="utf-8") as f:
            for line in lines:
                f.write(json.dumps(line) + "\n")

    def at(self, seconds, action):
        """Run `action(pane)` when the clock reaches `seconds` after the start."""
        self.events.append((1000.0 + seconds, action))

    def advance(self, seconds):
        self.clock += seconds
        for event in [e for e in self.events if e[0] <= self.clock]:
            self.events.remove(event)
            event[1](self)

    def info(self, target):
        return {"pane_id": "p-2", "agent": "pi", "agent_status": self.status, "cwd": "/tmp",
                "agent_session": {"kind": "path", "value": self.path}}

    def herdr(self, *args, **kw):
        self.calls.append(args[:2])
        if args[:2] == ("agent", "prompt"):
            return self.on_prompt()
        if args[:2] == ("agent", "wait"):
            # A wait ends at the next event of the pane, or at its timeout.
            limit = self.clock + int(args[args.index("--timeout") + 1]) / 1000
            while self.status == "working" and self.clock < limit:
                self.advance(1)
        return 0, {}, ""

    def on_prompt(self):
        return 0, {}, ""

    def run(self, *argv):
        out = io.StringIO()
        with mock.patch.multiple(ask, require_herdr_env=lambda: None, ensure_layout=lambda quiet: None,
                                 agent_info=self.info, herdr=self.herdr,
                                 screen_tail=lambda target, lines=60: "the screen"), \
                mock.patch.object(ask.time, "time", lambda: self.clock), \
                mock.patch.object(_common, "pi_agent_dirs", lambda: self.agent_dirs), \
                mock.patch.object(ask.time, "sleep", self.advance), \
                mock.patch.object(sys, "argv", ["ask.py", "proj-worker-1", *argv]), \
                mock.patch.dict(os.environ, {"HERDR_PANE_ID": "p-1"}), contextlib.redirect_stdout(out):
            try:
                ask.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue()


def reply_and_idle(text):
    def action(pane):
        pane.write(entry("assistant", text))
        pane.status = "idle"
    return action


class Compaction(unittest.TestCase):
    def check(self, compaction):
        pane = Pane(self, lines=[entry("user", "earlier task"), entry("assistant", "earlier reply")])

        def on_prompt():
            # The turn compacts the context and Pi sets done before the reply.
            pane.write(entry("user", "do the task"), compaction)
            pane.status = "done"
            pane.at(20, reply_and_idle("Status: complete"))
            return 0, {}, ""
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)
        self.assertEqual(pane.calls.count(("agent", "prompt")), 1)

    def test_a_pi_compaction_with_done_and_no_reply_waits_for_the_reply(self):
        self.check(PI_COMPACTION)

    def test_a_claude_code_compact_boundary_waits_for_the_reply_too(self):
        self.check(CLAUDE_COMPACTION)

    def test_a_compaction_with_no_reply_waits_until_the_deadline(self):
        pane = Pane(self, lines=[entry("user", "earlier task")])

        def on_prompt():
            pane.write(entry("user", "do the task"), PI_COMPACTION)
            pane.status = "done"
            return 0, {}, ""
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task", "--timeout", "30")
        self.assertEqual(code, 0)
        self.assertIn(ask.NO_NEW_REPLY_LINE, out)
        self.assertGreaterEqual(pane.clock, 1030)

    def test_a_done_status_with_no_compaction_ends_at_once(self):
        pane = Pane(self, lines=[entry("user", "earlier task")])

        def on_prompt():
            pane.write(entry("user", "do the task"))
            pane.status = "done"
            return 0, {}, ""
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertIn(ask.NO_NEW_REPLY_LINE, out)
        self.assertLess(pane.clock, 1010)

    def test_a_pane_with_no_transcript_path_says_so_and_keeps_exit_0(self):
        pane = Pane(self, lines=[entry("assistant", "a reply that ask.py cannot find")])
        pane.info = lambda target: {"pane_id": "p-2", "agent": "pi", "agent_status": "done", "cwd": "/tmp"}
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertIn(ask.NO_TRANSCRIPT_LINE, out)
        self.assertNotIn(ask.NO_NEW_REPLY_LINE, out)



STALLED = (1, {"error": {"code": "agent_prompt_stalled"}}, "agent_prompt_stalled")


class Stall(unittest.TestCase):
    def test_a_turn_that_starts_after_the_stall_gives_its_reply_and_the_prompt_goes_once(self):
        pane = Pane(self, lines=[entry("user", "earlier task"), entry("assistant", "earlier reply")])

        def on_prompt():
            def start(p):
                p.status = "working"
                p.at(40, reply_and_idle("Status: complete"))
            pane.at(15, start)
            return STALLED
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)
        self.assertEqual(pane.calls.count(("agent", "prompt")), 1)

    def test_new_transcript_lines_after_the_stall_count_as_a_started_turn(self):
        pane = Pane(self, lines=[entry("user", "earlier task")])

        def on_prompt():
            pane.at(10, lambda p: p.write(entry("user", "do the task"), entry("assistant", "done fast")))
            return STALLED
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\ndone fast\n"), out)

    def test_no_turn_in_60_seconds_gives_exit_5_and_no_second_prompt(self):
        pane = Pane(self, lines=[entry("user", "earlier task")])
        pane.on_prompt = lambda: STALLED
        code, out = pane.run("--text", "do the task", "--timeout", "600")
        self.assertEqual(code, ask.EXIT["no_turn"])
        self.assertIn("NO TURN STARTED", out)
        self.assertGreaterEqual(pane.clock, 1060)
        self.assertLess(pane.clock, 1100)
        self.assertEqual(pane.calls.count(("agent", "prompt")), 1)

    def test_the_stall_poll_ends_at_the_timeout(self):
        pane = Pane(self, lines=[entry("user", "earlier task")])
        pane.on_prompt = lambda: STALLED
        code, out = pane.run("--text", "do the task", "--timeout", "20")
        self.assertEqual(code, ask.EXIT["no_turn"])
        self.assertLess(pane.clock, 1030)



class WaitOnly(unittest.TestCase):
    def test_a_wait_only_run_sends_no_prompt_and_prints_the_reply_of_the_running_turn(self):
        pane = Pane(self, status="working", lines=[entry("user", "the task"), entry("assistant", "a first step")])
        pane.at(30, reply_and_idle("Status: complete"))
        code, out = pane.run("--wait-only", "--timeout", "600")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)
        self.assertNotIn(("agent", "prompt"), pane.calls)

    def test_a_wait_only_run_on_a_settled_pane_prints_its_last_reply(self):
        pane = Pane(self, lines=[entry("user", "the task"), entry("assistant", "the last reply")])
        code, out = pane.run("--wait-only")
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\nthe last reply\n"), out)
        self.assertLess(pane.clock, 1010)

    def test_a_wait_only_run_keeps_the_exit_codes(self):
        pane = Pane(self, status="working", lines=[entry("user", "the task")])
        self.assertEqual(pane.run("--wait-only", "--timeout", "30")[0], ask.EXIT["timeout"])
        blocked = Pane(self, status="blocked", lines=[entry("user", "the task")])
        self.assertEqual(blocked.run("--wait-only")[0], ask.EXIT["blocked"])

    def test_a_wait_only_run_takes_no_prompt(self):
        pane = Pane(self)
        code, _ = pane.run("--wait-only", "--text", "do the task")
        self.assertIn("--wait-only", code)
        self.assertEqual(pane.calls, [])


def stamp(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class PiFiles:
    """Pi session files of a pane cwd in a temporary agent directory."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-pi-disk-")
        self.addCleanup(tmp.cleanup)
        root = os.path.realpath(tmp.name)
        self.agent_dir = os.path.join(root, "agent")
        self.cwd = os.path.join(root, "work.tree-a")
        os.makedirs(self.cwd)
        self.now = time.time()

    def session(self, name, cwd, *entries, started=None):
        folder = os.path.join(self.agent_dir, "sessions", _common.pi_session_dir_name(cwd))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name + ".jsonl")
        header = {"type": "session", "cwd": cwd, "timestamp": stamp(self.now + 1 if started is None else started)}
        with open(path, "w", encoding="utf-8") as f:
            for e in (header,) + entries:
                f.write(json.dumps(e) + "\n")
        return path

    def said(self, role, text, epoch):
        return dict(entry(role, text), timestamp=stamp(epoch))


class PiSessionOnDisk(PiFiles, unittest.TestCase):
    """A Pi pane that Herdr gives no transcript path: the one session file on disk that is certain, or none."""

    def find(self, prompt, since=None):
        return _common.find_pi_session([self.cwd], self.now if since is None else since, prompt, [self.agent_dir])

    def test_the_folder_name_follows_the_rule_of_pi(self):
        self.assertEqual(_common.pi_session_dir_name("/opt/my.app-wt/x"), "--opt-my.app-wt-x--")
        self.assertEqual(_common.pi_session_dir_name("C:\\work\\a"), "--C--work-a--")

    def test_the_file_with_the_prompt_wins_over_another_pane_in_the_same_cwd(self):
        mine = self.session("a", self.cwd, self.said("user", "xyTask one: build the parser", self.now + 1),
                            self.said("assistant", "built", self.now + 5))
        self.session("b", self.cwd, self.said("user", "Task two: test the parser", self.now + 1),
                     self.said("assistant", "tested", self.now + 5))
        self.assertEqual(self.find("Task one:\n build the parser"), (mine, 2))

    def test_two_files_with_the_prompt_or_no_file_with_it_give_none(self):
        for name in ("a", "b"):
            self.session(name, self.cwd, self.said("user", "continue with the next step", self.now + 1))
        self.assertIsNone(self.find("continue with the next step"))
        self.assertIsNone(self.find("another prompt for the pane"))

    def test_a_prompt_from_before_the_send_does_not_count(self):
        self.session("a", self.cwd, self.said("user", "the task of the worker", self.now - 600))
        self.assertIsNone(self.find("the task of the worker"))

    def test_a_cwd_with_the_same_folder_name_is_not_taken(self):
        other = self.cwd.replace("work.tree-a", "work.tree/a")
        self.assertEqual(_common.pi_session_dir_name(other), _common.pi_session_dir_name(self.cwd))
        self.session("a", other, self.said("user", "the task of the worker", self.now + 1))
        self.assertIsNone(self.find("the task of the worker"))

    def test_without_a_prompt_no_file_on_disk_is_taken(self):
        self.session("b", self.cwd, self.said("user", "the task of another pane", self.now + 1))
        self.assertIsNone(_common.pi_disk_session({"pane_id": "p-2", "agent": "pi-bolt", "cwd": self.cwd}))

    def test_a_short_prompt_must_end_the_user_entry_and_a_very_short_one_is_refused(self):
        mine = self.session("a", self.cwd, self.said("user", "xycontinue with the next step", self.now + 1))
        self.session("b", self.cwd, self.said("user", "continue with the next step, then stop", self.now + 1))
        self.assertEqual(self.find("continue with the next step"), (mine, 2))
        self.session("c", self.cwd, self.said("user", "continue", self.now + 1))
        self.assertIsNone(self.find("continue"))

    def test_a_long_prompt_must_be_whole_in_the_user_entry(self):
        head = "word " * 50
        mine = self.session("a", self.cwd, self.said("user", head + "task one", self.now + 1))
        self.session("b", self.cwd, self.said("user", head + "task two", self.now + 1))
        self.assertEqual(self.find(head + "task one"), (mine, 2))

    def test_ask_reads_the_reply_from_the_session_file_and_says_so(self):
        pane = Pane(self)
        pane.agent_dirs = [self.agent_dir]
        pane.info = lambda target: {"pane_id": "p-2", "agent": "pi-bolt", "agent_status": pane.status, "cwd": self.cwd}
        written = []

        def on_prompt():
            written.append(self.session("a", self.cwd, self.said("user", "do the task of the worker", pane.clock + 1),
                                        self.said("assistant", "Status: complete", pane.clock + 2)))
            pane.status = "done"
            return 0, {}, ""
        pane.on_prompt = on_prompt
        code, out = pane.run("--text", "do the task of the worker")
        self.assertEqual(code, 0)
        self.assertIn("note: Herdr gave no transcript path; the reply below is from the Pi session file on disk: "
                      + written[0] + "\n", out)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)


class SavedPiSession(PiFiles, unittest.TestCase):
    """After a prompt match, a run without a prompt reads the saved file of the same pane and cwd only."""

    def setUp(self):
        super().setUp()
        _common.write_record("p-2", {"pane_id": "p-2", "harness": "pi", "role": "worker", "created_at_epoch": 1.0})
        self.addCleanup(_common.remove_record, "p-2")
        self.info = {"pane_id": "p-2", "agent": "pi-bolt", "agent_status": "idle", "cwd": self.cwd}

    def saved(self):
        path = self.session("a", self.cwd, self.said("user", "do the task of the worker", self.now + 1),
                            self.said("assistant", "Status: complete", self.now + 2))
        _common.save_pi_session(self.info, path)
        return path

    def test_a_wait_only_run_reads_the_file_that_the_prompt_found(self):
        pane = Pane(self)
        pane.agent_dirs = [self.agent_dir]
        pane.info = lambda target: dict(self.info, agent_status=pane.status)

        def on_prompt():
            self.session("a", self.cwd, self.said("user", "do the task of the worker", pane.clock + 1),
                         self.said("assistant", "Status: complete", pane.clock + 2))
            return 0, {}, ""
        pane.on_prompt = on_prompt
        self.assertEqual(pane.run("--text", "do the task of the worker")[0], 0)
        self.session("b", self.cwd, self.said("user", "the task of another pane", pane.clock + 1),
                     self.said("assistant", "the reply of another pane", pane.clock + 2))
        code, out = pane.run("--wait-only")
        self.assertEqual(code, 0)
        self.assertIn(_common.DISK_NOTE, out)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)

    def test_another_cwd_or_a_missing_file_is_refused(self):
        path = self.saved()
        self.assertEqual(_common.pi_disk_session(self.info), (path, 0))
        other = os.path.join(os.path.dirname(self.cwd), "other")
        os.makedirs(other)
        self.assertIsNone(_common.pi_disk_session(dict(self.info, cwd=other)))
        os.replace(path, path + ".moved")
        self.assertIsNone(_common.pi_disk_session(self.info))

    def test_a_new_record_for_a_reused_pane_id_drops_the_saved_file(self):
        self.saved()
        _common.write_record("p-2", {"pane_id": "p-2", "harness": "pi", "role": "worker", "created_at_epoch": 2.0})
        self.assertIsNone(_common.pi_disk_session(self.info))

    def test_a_later_session_in_the_folder_drops_the_saved_file(self):
        self.saved()
        self.session("c", self.cwd, self.said("assistant", "the reply after /new", self.now + 4), started=self.now + 3)
        self.assertIsNone(_common.pi_disk_session(self.info))


if __name__ == "__main__":
    unittest.main()
