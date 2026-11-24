"""ask.py, last-reply.py and close.py on herdr-core: one send, the transcript of the right session, safe close.

The fake `hc` of test_core_layout.py, extended with send, wait, read and kill. No herdr-core is needed.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import datetime
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_core_layout import CoreCase, FakeCore, load, terminal  # noqa: E402

import _common  # noqa: E402

ask, close = load("ask.py"), load("close.py")
CONTRACT = _common.CONTRACT
ASK = {name: entry["code"] for name, entry in CONTRACT["ask"]["exit"].items()}


def agent(address, state="idle", pid=4242, space="sp1", role=None, age=60):
    t = terminal(address, space=space, role=role, age=age)
    t.update(status={"app": "claude-code", "state": state}, turn=1, name=f"proj-{address}",
             foreground={"pid": pid, "cwd": "/work/proj"})
    return t


class AskCore(FakeCore):
    """A fake core that answers `hc send` and each `hc wait` from a list, and calls `on_send` at the send."""

    def __init__(self, *terminals, send_wait=None, waits=(), on_send=None):
        super().__init__(*terminals)
        self.send_wait = send_wait or {"reason": "status", "ended": True, "status": "done", "turn": 2}
        self.waits = list(waits)
        self.on_send = on_send

    def __call__(self, *args, timeout=None):
        if args[0] == "send":
            self.calls.append(args)
            if self.on_send:
                self.on_send()
            return 0, {"started": True, "status": "idle", "turn": 1, "wait": self.send_wait}, ""
        if args[0] == "wait":
            self.calls.append(args)
            nxt = self.waits.pop(0) if self.waits else {"reason": "status", "ended": True, "status": "done", "turn": 2}
            return 0, nxt, ""
        if args[0] == "read":
            self.calls.append(args)
            return 0, None, "screen text"
        if args[0] == "kill":
            self.calls.append(args)
            self.terminals.pop(args[1], None)
            return 0, {}, ""
        return super().__call__(*args, timeout=timeout)

    def after_send(self):
        """The commands after the first send, except the reads of `hc get`."""
        i = next(n for n, c in enumerate(self.calls) if c[0] == "send")
        return [c[0] for c in self.calls[i + 1:] if c[0] != "get"]


class AskCase(CoreCase):
    def setUp(self):
        super().setUp()
        patch = mock.patch.object(ask.time, "sleep", lambda s: None)
        patch.start()
        self.addCleanup(patch.stop)

    def claude_session(self, sid, pid=None, lines=()):
        """A Claude Code transcript of session `sid`; with `pid`, the sessions file of that process names it."""
        folder = os.path.join(self.home, ".claude", "projects", "-work-proj")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"{sid}.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            for line in lines:
                f.write(json.dumps(line) + "\n")
        if pid:
            os.makedirs(os.path.join(self.home, ".claude", "sessions"), exist_ok=True)
            with open(os.path.join(self.home, ".claude", "sessions", f"{pid}.json"), "w", encoding="utf-8") as f:
                json.dump({"pid": pid, "sessionId": sid, "cwd": "/work/proj"}, f)
        return path

    @staticmethod
    def reply(text):
        return {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}

    def append(self, path, text):
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(self.reply(text)) + "\n")


class OneSend(AskCase):
    def test_the_prompt_is_sent_once_and_then_only_waited_for(self):
        for early in ({"reason": "timeout", "ended": False, "status": "working"},
                      {"reason": "message", "ended": False, "from": "far/t1", "status": "working"}):
            with self.subTest(reason=early["reason"]):
                path = self.claude_session("s-one", pid=4242, lines=[self.reply("old")])
                core = AskCore(agent("t1"), agent("t2"), send_wait=early,
                               on_send=lambda: self.append(path, "new reply"))
                code, out = self.run_main(ask, core, core.terminals["t1"], ["ask.py", "t2", "--text", "do the task"])
                self.assertEqual(code, ASK["reply"], out)
                self.assertEqual(len(core.did("send")), 1)
                after = core.after_send()
                self.assertTrue(after)
                self.assertEqual(set(after), {"wait"})
                self.assertIn("new reply", out)

    def test_a_working_or_blocked_target_gets_no_send(self):
        for state, want in (("working", ASK["busy"]), ("blocked", ASK["blocked"])):
            with self.subTest(state=state):
                core = AskCore(agent("t1"), agent("t2", state=state))
                code, out = self.run_main(ask, core, core.terminals["t1"], ["ask.py", "t2", "--text", "do the task"])
                self.assertEqual(code, want, out)
                self.assertEqual(core.did("send"), [])

    def test_a_remote_ended_agentless_or_own_target_gets_no_send(self):
        bare = terminal("t4")
        bare["status"] = {}
        core = AskCore(agent("t1"), agent("t3", state="done"), bare)
        core.terminals["t3"]["state"] = "exited"
        for target in ("far/t2", "t3", "t4", "t1"):
            with self.subTest(target=target):
                code, out = self.run_main(ask, core, core.terminals["t1"], ["ask.py", target, "--text", "do the task"])
                self.assertEqual(code, 2, out)
                self.assertEqual(core.did("send"), [])


class SessionOfThePid(AskCase):
    def test_the_reply_comes_from_the_session_that_the_sessions_file_of_the_pid_names(self):
        other = self.claude_session("s-other")
        mine = self.claude_session("s-mine", pid=4242)

        def turn():
            self.append(other, "reply of another session")
            self.append(mine, "reply of this session")
        core = AskCore(agent("t1"), agent("t2"), on_send=turn)
        code, out = self.run_main(ask, core, core.terminals["t1"], ["ask.py", "t2", "--text", "do the task"])
        self.assertEqual(code, ASK["reply"], out)
        self.assertIn("reply of this session", out)
        self.assertNotIn("reply of another session", out)


class PiWrapper(unittest.TestCase):
    def test_a_wrapped_user_entry_matches_its_prompt_and_not_another_prompt(self):
        with tempfile.TemporaryDirectory(prefix="herdr-core-pi-") as agent_dir:
            cwd = os.path.realpath(agent_dir)
            folder = os.path.join(agent_dir, "sessions", _common.pi_session_dir_name(cwd))
            os.makedirs(folder)
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            prompt = "Summarize the open tickets of the tracker in five lines."
            with open(os.path.join(folder, "a.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps({"type": "session", "cwd": cwd, "timestamp": now}) + "\n")
                f.write(json.dumps({"type": "message", "timestamp": now, "message": {
                    "role": "user", "content": [{"type": "text", "text": f'<hc from="t11">{prompt}</hc>'}]}}) + "\n")
            since = time.time() - 30
            self.assertIsNotNone(_common.find_pi_session([cwd], since, prompt, agent_dirs=[agent_dir]))
            self.assertIsNone(_common.find_pi_session([cwd], since, "Write a release note for the next version.",
                                                      agent_dirs=[agent_dir]))


class CloseCore(CoreCase):
    def record(self, address, **over):
        rec = {"pane_id": address, "role": "worker", "harness": "claude", "session": "subagent", "name": "n",
               "workspace_id": "sp1", "backend": "herdr-core", "created_at_epoch": time.time()}
        rec.update(over)
        _common.write_record(address, rec)

    def test_close_kills_only_a_task_terminal_with_a_valid_record_of_the_callers_space(self):
        core = AskCore(agent("t1"), agent("t2"), agent("t3"), agent("t4", age=10), agent("t5", space="sp2"),
                       agent("t6", role="coordinator"))
        self.record("t2")
        self.record("t4", created_at_epoch=time.time() - 3600)  # older than its terminal: stale
        self.record("t5", workspace_id="sp2")
        self.record("t6", role="coordinator", session="primary")
        self.record("t7")
        _common.write_record("t7", dict(_common.read_record("t7"), self=True))  # as init.py writes for a coordinator
        core.terminals["t7"] = agent("t7")
        self.record("t1")  # the caller's own terminal, even with a valid record
        for target in ("t1", "t3", "t4", "t5", "t6", "t7", "far/t5"):
            with self.subTest(target=target):
                code, out = self.run_main(close, core, core.terminals["t1"], ["close.py", target])
                self.assertEqual(code, 1, out)
                self.assertEqual(core.did("kill"), [])
        code, out = self.run_main(close, core, core.terminals["t1"], ["close.py", "t2"])
        self.assertEqual(code, 0, out)
        self.assertEqual([c[1] for c in core.did("kill")], ["t2"])
        self.assertIsNone(_common.read_record("t2"))


if __name__ == "__main__":
    unittest.main()
