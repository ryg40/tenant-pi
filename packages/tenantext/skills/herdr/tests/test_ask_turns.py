"""ask.py: a stall on the first turn, a compaction inside a turn, and a wait-only run.

A fake clock and fake Herdr calls drive each case. No Herdr server is needed.
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

spec = importlib.util.spec_from_file_location("ask_turns", os.path.join(SKILL, "scripts", "ask.py"))
ask = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask)


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


if __name__ == "__main__":
    unittest.main()
