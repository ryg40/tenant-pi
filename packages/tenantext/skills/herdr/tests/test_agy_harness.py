"""The harness agy (the Antigravity CLI): the start command, the model check, and the reply from its transcript.

A fake `agy` program on a scratch PATH and the fake `hc` of test_core_layout.py; no agy session starts.
The transcript fixture holds invented text only.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import datetime
import json
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_core_layout import CoreCase, FakeCore, spawn, terminal  # noqa: E402
from test_core_ask import ASK, AskCase, AskCore, agent, ask  # noqa: E402

MODELS = "example-alpha-high\tExample Alpha (High)\nexample-beta\tExample Beta\n"
# Arguments that start a mode of agy that the skill must never start, and the flags of a role prompt.
REFUSED = {"-p", "--print", "--prompt", "-i", "--prompt-interactive", "acp",
           "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--dangerously-skip-permissions"}


class AgyCase(CoreCase):
    def setUp(self):
        super().setUp()
        bin_dir = os.path.join(self.home, "bin")
        os.makedirs(bin_dir)
        fake = os.path.join(bin_dir, "agy")
        with open(fake, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nif [ \"$1\" = models ]; then printf '%s' \"$AGY_FAKE_MODELS\"; exit 0; fi\nexit 9\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        patch = mock.patch.dict(os.environ, {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""),
                                             "AGY_FAKE_MODELS": MODELS})
        patch.start()
        self.addCleanup(patch.stop)

    def spawn_agy(self, *args):
        """(exit code, stdout, core) of one spawn.py run with the harness agy."""
        core = FakeCore(terminal("t1"))
        argv = ["spawn.py", "--harness", "agy", "--role", "worker", "--cwd", self.home, *args]
        with mock.patch.multiple(spawn, app_wait=lambda a, s: "idle"), mock.patch.object(spawn, "herdr") as herdr:
            code, out = self.run_main(spawn, core, core.terminals["t1"], argv)
        herdr.assert_not_called()
        return code, out, core


class StartCommand(AgyCase):
    def test_the_dry_run_starts_plain_agy_with_no_prompt_mode_no_prompt_flag_and_no_model(self):
        code, out, core = self.spawn_agy("--dry-run")
        self.assertEqual(code, 0, out)
        command = json.loads(out)["command"]
        program = command[command.index("--") + 1:]
        self.assertIn("agy", program)
        self.assertFalse(REFUSED & set(program), program)
        self.assertNotIn("--model", program)
        self.assertEqual(core.did("run"), [])

    def test_each_spelling_of_a_print_prompt_or_acp_mode_after_the_separator_starts_no_pane(self):
        for arg in ("-p", "--print", "--prompt", "-i", "--prompt-interactive", "acp",
                    "-print", "-prompt=x", "-prompt-interactive", "--print=x"):
            with self.subTest(arg=arg):
                code, out, core = self.spawn_agy("--", arg)
                self.assertEqual(code, spawn.EXIT["invalid"], out)
                self.assertEqual(core.did("run"), [])
        code, out, core = self.spawn_agy("--dry-run", "--", "--mode", "plan")
        self.assertEqual(code, 0, out)


class RolePrompt(AgyCase):
    def first_turn(self, run):
        """(exit code, stdout, the ask.py calls) of one spawn.py run whose subprocess.run is `run`."""
        state = os.path.join(self.home, "state")
        asks = []

        def recorded(argv, **kwargs):
            if any(os.path.basename(a) == "ask.py" for a in argv):
                asks.append(argv)
            return run(argv, **kwargs)
        with mock.patch.object(spawn, "STATE_DIR", state), mock.patch.object(spawn.subprocess, "run", recorded):
            code, out, core = self.spawn_agy()
        return code, out, asks

    def test_the_first_message_through_ask_py_names_the_role_prompt_file_of_the_role(self):
        code, out, asks = self.first_turn(
            lambda argv, **kw: mock.Mock(returncode=0, stdout="--- reply ---\nworker\n", stderr=""))
        self.assertEqual(code, 0, out)
        result = json.loads(out)
        self.assertEqual(len(asks), 1, asks)  # one delivery, to the returned pane
        self.assertIn(result["pane_id"], asks[0])
        path = result["role_prompt"]
        self.assertIn(path, asks[0][asks[0].index("--text") + 1])
        with open(os.path.join(spawn.SKILL, "roles.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        with mock.patch.dict(os.environ, {"HOME": self.home, "XDG_CONFIG_HOME": os.path.join(self.home, "config")}):
            built = spawn.system_prompt(result, cfg)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), built + "\n")

    def test_a_first_turn_that_cannot_start_gives_the_pane_id_and_exit_1(self):
        def run(argv, **kwargs):
            raise OSError("no python")
        code, out, asks = self.first_turn(run)
        self.assertEqual(code, spawn.EXIT["failed"], out)
        result = json.loads(out.strip().splitlines()[-1])
        self.assertEqual(result["status"], "role prompt not confirmed")
        self.assertEqual(len(asks), 1, asks)  # no second send
        self.assertIn(result["pane_id"], asks[0])


class ModelCheck(AgyCase):
    def test_a_model_that_agy_models_does_not_list_starts_no_pane_and_exits_with_2(self):
        code, out, core = self.spawn_agy("--model", "example-gamma")
        self.assertEqual(code, spawn.EXIT["invalid"], out)
        self.assertEqual(core.did("run"), [])


class TranscriptReply(AskCase):
    PROMPT = "Count the invented widgets in the sample folder and answer in one sentence."

    def conversation(self, cid, rows):
        folder = os.path.join(self.home, ".gemini", "antigravity-cli", "brain", cid, ".system_generated", "logs")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "transcript.jsonl"), "a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")

    @staticmethod
    def row(kind, **fields):
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return dict(fields, type=kind, status="DONE", created_at=now)

    def user(self, text):
        return self.row("USER_INPUT", content=f'<USER_REQUEST>\n<hc from="t1">{text}</hc>\n</USER_REQUEST>\n'
                                              "<ADDITIONAL_METADATA>invented</ADDITIONAL_METADATA>")

    def test_the_reply_is_the_last_final_planner_response_after_the_sent_prompt(self):
        self.conversation("c-mine", [self.user("An earlier invented question that is long enough."),
                                     self.row("PLANNER_RESPONSE", content="the earlier invented answer")])
        self.conversation("c-other", [])

        def turn():
            self.conversation("c-mine", [
                self.user(self.PROMPT),
                self.row("PLANNER_RESPONSE", tool_calls=[{"name": "list_dir", "args": {}}]),
                self.row("GENERIC", content="invented tool output"),
                self.row("PLANNER_RESPONSE", content="There are seven invented widgets.")])
            self.conversation("c-other", [self.user("Another invented prompt of another pane, long enough."),
                                          self.row("PLANNER_RESPONSE", content="the answer of another pane")])
        t2 = agent("t2")
        t2["status"]["app"] = "antigravity"
        core = AskCore(agent("t1"), t2, on_send=turn)
        code, out = self.run_main(ask, core, core.terminals["t1"], ["ask.py", "t2", "--text", self.PROMPT])
        self.assertEqual(code, ASK["reply"], out)
        self.assertEqual(len(core.did("send")), 1)
        reply = out.split("--- reply ---", 1)[1].strip()
        self.assertEqual(reply, "There are seven invented widgets.")


if __name__ == "__main__":
    unittest.main()
