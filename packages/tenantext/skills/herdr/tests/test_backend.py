"""Each script selects its backend before any terminal action (contract.json, entry `backend`).

Fakes of `herdr`, `herdr-core` and `herdr-app` on PATH log each call. No Herdr server is needed.
The process tree is real: a candidate is valid when its root pid is this test process, an ancestor of the script.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(SKILL, "scripts")
with open(os.path.join(SKILL, "contract.json"), encoding="utf-8") as _f:
    CONTRACT = json.load(_f)

# One fake for the three commands; the name of the file selects the command.
FAKE = '''#!{python}
import json, os, sys
cmd, a = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps([cmd] + a) + "\\n")
if cmd == "herdr" and a[:2] == ["pane", "process-info"]:
    if os.environ.get("FAKE_H1_LIVE") != "1":
        print(json.dumps({{"error": {{"code": "pane_not_found", "message": "pane not found"}}}}))
        sys.exit(1)
    print(json.dumps({{"result": {{"process_info": {{"shell_pid": int(os.environ["FAKE_H1_PID"])}}}}}}))
elif cmd == "herdr-core" and a[:1] == ["get"]:
    if os.environ.get("FAKE_HC_LIVE") != "1":
        print(json.dumps({{"error": {{"kind": "not_found", "message": "no terminal"}}}}))
        sys.exit(3)
    print(json.dumps({{"address": a[1], "state": "live", "pid": int(os.environ["FAKE_HC_PID"]),
                      "status": {{"state": "idle"}}, "labels": {{"herdr.space": "sp-test", "herdr.tab": "tb-test"}}}}))
elif cmd == "herdr-core" and a[:1] == ["ls"]:
    print(json.dumps({{"terminals": []}}))
elif cmd == "herdr-core" and a[:1] == ["run"]:
    print(json.dumps({{"address": "t9", "state": "live"}}))
else:
    print(json.dumps({{"result": {{}}}}))
'''

# The only calls that the detection may make. Any other call (agent start, pane split, hc run, herdr-app do ...)
# is a terminal action or a read that a refusing script must not reach.
DETECTION_CALLS = (("herdr", "pane", "process-info"), ("herdr-core", "get"))

RUNS = {
    "ask": ["ask.py", "proj-worker-1", "--text", "a prompt that the script must not send"],
    "spawn": ["spawn.py", "--harness", "pi", "--role", "worker", "--model", "example/model"],
    "handoff": ["handoff.py", "--file", "HANDOFF"],
    "init": ["init.py"],
    "panes": ["panes.py"],
    "close": ["close.py", "w:task"],
    "last-reply": ["last-reply.py", "w:task"],
}


class Backend(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-backend-test-")
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        bin_dir = os.path.join(self.root, "bin")
        os.makedirs(bin_dir)
        for name in ("herdr", "herdr-core", "herdr-app"):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(FAKE.format(python=sys.executable))
            os.chmod(path, 0o755)
        self.handoff = os.path.join(self.root, "handoff.md")
        with open(self.handoff, "w", encoding="utf-8") as f:
            f.write("# Handoff\n\nState of the work.\n")
        # A live process that is no ancestor of the script: its pid is a stale root.
        self.stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(self.stranger.wait)
        self.addCleanup(self.stranger.kill)
        self.log = os.path.join(self.root, "log.jsonl")
        # PATH holds only the fakes: no real herdr, herdr-core or herdr-app can run.
        self.env = {"PATH": bin_dir, "HOME": self.root, "FAKE_LOG": self.log,
                    "HERDR_SKILL_STATE_DIR": os.path.join(self.root, "state"),
                    "HERDR_SKILL_RESOURCES": os.path.join(self.root, "no-machine-file.json"),
                    "HC_TERMINAL_ID": "t7", "HERDR_ENV": "1", "HERDR_PANE_ID": "w0:p1", "HERDR_WORKSPACE_ID": "w0"}

    def calls(self):
        try:
            with open(self.log, encoding="utf-8") as f:
                return [json.loads(line) for line in f]
        except OSError:
            return []

    def detect(self, **fake):
        p = subprocess.run([sys.executable, "-c", "import json, _common; print(json.dumps(_common.detect_backend()))"],
                           cwd=SCRIPTS, env=dict(self.env, **fake), capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def run_script(self, argv, **fake):
        if os.path.exists(self.log):
            os.remove(self.log)
        argv = [self.handoff if a == "HANDOFF" else a for a in argv]
        return subprocess.run([sys.executable, os.path.join(SCRIPTS, argv[0]), *argv[1:]],
                              env=dict(self.env, **fake), capture_output=True, text=True, timeout=60)

    def assert_each_script_does_nothing(self, skip=(), **fake):
        for script, argv in RUNS.items():
            if script in skip:
                continue
            with self.subTest(script=script):
                p = self.run_script(argv, **fake)
                self.assertEqual(p.returncode, CONTRACT["backend"]["refusal_exit"][script], p.stderr)
                other = [c for c in self.calls() if not any(tuple(c[:len(d)]) == d for d in DETECTION_CALLS)]
                self.assertEqual(other, [])

    def test_a_live_ancestor_terminal_with_stale_herdr_values_is_core_and_acts_on_no_herdr1_pane(self):
        me = str(os.getpid())
        for stale in ({"FAKE_H1_LIVE": "0"}, {"FAKE_H1_LIVE": "1", "FAKE_H1_PID": str(self.stranger.pid)}):
            with self.subTest(stale=stale):
                fake = dict(stale, FAKE_HC_LIVE="1", FAKE_HC_PID=me)
                found = self.detect(**fake)
                self.assertEqual((found["backend"], found["terminal"], found["space"], found["tab"]),
                                 ("core", "t7", "sp-test", "tb-test"))
                # spawn.py, init.py and panes.py are ported (test_core_layout.py). handoff.py is ported
                # (test_core_handoff.py): the caller has no coordinator record, so it refuses with the usage exit.
                # ask.py, close.py and last-reply.py are ported (test_core_ask.py): the fake terminal of their target
                # hosts no agent and has no record, so they refuse it with the same exit and no action.
                self.assert_each_script_does_nothing(skip=("spawn", "init", "panes"), **fake)

    def test_spawn_on_a_live_ancestor_terminal_with_stale_herdr_values_starts_with_hc_run_only(self):
        me = str(os.getpid())
        for stale in ({"FAKE_H1_LIVE": "0"}, {"FAKE_H1_LIVE": "1", "FAKE_H1_PID": str(self.stranger.pid)}):
            with self.subTest(stale=stale):
                argv = ["spawn.py", "--harness", "claude", "--role", "worker", "--model", "m", "--cwd", self.root]
                p = self.run_script(argv, **stale, FAKE_HC_LIVE="1", FAKE_HC_PID=me)
                self.assertEqual(p.returncode, 0, p.stderr)
                calls = self.calls()
                self.assertEqual([c[:2] for c in calls if c[:2] == ["herdr-core", "run"]], [["herdr-core", "run"]])
                # No Herdr 1 call past the detection read, and no herdr-app call.
                h1 = [c for c in calls if c[0] == "herdr" and c[1:3] != ["pane", "process-info"]]
                self.assertEqual((h1, [c for c in calls if c[0] == "herdr-app"]), ([], []))

    def test_both_candidates_valid_refuses_and_runs_no_action(self):
        me = str(os.getpid())
        fake = {"FAKE_HC_LIVE": "1", "FAKE_HC_PID": me, "FAKE_H1_LIVE": "1", "FAKE_H1_PID": me}
        self.assertIsNone(self.detect(**fake)["backend"])
        self.assert_each_script_does_nothing(**fake)

    def test_nested_roots_select_the_nearer_root_and_continue_on_its_backend(self):
        # A wrapper process between this test and the script is the inner root: it puts its own pid into
        # FAKE_<inner>_PID, and this test process is the outer root. Both roots are ancestors of the script.
        wrapper = ("import os, subprocess, sys; env = dict(os.environ); env[env.pop('INNER')] = str(os.getpid()); "
                   "sys.exit(subprocess.run(sys.argv[1:], env=env).returncode)")
        me = str(os.getpid())
        detect = [sys.executable, "-c", "import json, _common; print(json.dumps(_common.detect_backend()))"]
        fakes = {"FAKE_HC_LIVE": "1", "FAKE_H1_LIVE": "1"}
        for inner, outer, backend, run in (("FAKE_HC_PID", "FAKE_H1_PID", "core", RUNS["ask"]),
                                           ("FAKE_H1_PID", "FAKE_HC_PID", "herdr1", RUNS["panes"])):
            with self.subTest(backend=backend):
                env = dict(self.env, **fakes, INNER=inner, **{outer: me})
                p = subprocess.run([sys.executable, "-c", wrapper, *detect], cwd=SCRIPTS, env=env,
                                   capture_output=True, text=True, timeout=60)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(json.loads(p.stdout)["backend"], backend)
                if os.path.exists(self.log):
                    os.remove(self.log)
                p = subprocess.run([sys.executable, "-c", wrapper, sys.executable, os.path.join(SCRIPTS, run[0]),
                                    *run[1:]], env=env, capture_output=True, text=True, timeout=60)
                other = [c for c in self.calls() if not any(tuple(c[:len(d)]) == d for d in DETECTION_CALLS)]
                if backend == "core":
                    # The fake target hosts no agent: ask.py on core refuses it (exit 2), with no call but `hc get`.
                    self.assertEqual(p.returncode, CONTRACT["backend"]["refusal_exit"]["ask"], p.stderr)
                    self.assertEqual(other, [])
                else:
                    # The Herdr 1 path of today: panes.py goes on past the detection with herdr calls only.
                    self.assertTrue(other, p.stderr)
                    self.assertEqual({c[0] for c in other}, {"herdr"})

    def test_neither_candidate_valid_refuses_and_runs_no_action(self):
        stranger = str(self.stranger.pid)
        for fake in ({"FAKE_HC_LIVE": "0", "FAKE_H1_LIVE": "0"},
                     {"FAKE_HC_LIVE": "1", "FAKE_HC_PID": stranger, "FAKE_H1_LIVE": "1", "FAKE_H1_PID": stranger}):
            with self.subTest(fake=fake):
                self.assertIsNone(self.detect(**fake)["backend"])
                self.assert_each_script_does_nothing(**fake)


if __name__ == "__main__":
    unittest.main()
