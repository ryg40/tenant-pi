"""handoff.py closes the calling coordinator pane only after a confirmed handoff, and never on a failure.

The fakes replace `herdr`, spawn.py and ask.py. No Herdr server is needed.
Run: python3 -m unittest discover -s skills/herdr/tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(SKILL, "contract.json"), encoding="utf-8") as _f:
    CONTRACT = json.load(_f)

# The fake herdr CLI. It logs each call; a close also logs whether the record of the handoff exists.
FAKE_HERDR = '''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
log = os.environ["FAKE_LOG"]
def out(result): print(json.dumps({"result": result}))
with open(log, "a") as f:
    f.write(json.dumps({"herdr": a[:3]}) + "\\n")
if a[:2] == ["agent", "get"]:
    out({"agent": {"pane_id": a[2], "agent": "claude", "agent_status": "idle"}})
elif a[:2] == ["pane", "list"]:
    out({"panes": [{"pane_id": "w:old", "tab_id": "t1", "agent": "claude", "agent_status": "idle", "cwd": "/w"},
                   {"pane_id": "w:task", "tab_id": "t2", "agent": "pi", "agent_status": "working", "cwd": "/w"}]})
elif a[:2] == ["agent", "list"]:
    out({"agents": [{"pane_id": "w:task", "name": "proj-worker-1"}]})
elif a[:2] == ["tab", "list"]:
    out({"tabs": [{"tab_id": "t1", "label": "coordinator"}, {"tab_id": "t2", "label": "worker"}]})
elif a[:2] == ["pane", "close"]:
    record = os.path.join(os.environ["FAKE_DIR"], "handoffs.jsonl")
    with open(log, "a") as f:
        f.write(json.dumps({"close": a[2], "record_present": os.path.exists(record)}) + "\\n")
    out({})
else:
    out({})
'''

FAKE_SPAWN = '''#!/usr/bin/env python3
import json
print(json.dumps({"name": "proj-coordinator-2", "pane_id": "w:new"}))
'''

# The fake ask.py counts its calls: call 1 is the start prompt, call 2 the second prompt.
FAKE_ASK = '''#!/usr/bin/env python3
import os, sys
counter = os.path.join(os.path.dirname(os.environ["FAKE_LOG"]), "ask-calls")
calls = (int(open(counter).read()) if os.path.exists(counter) else 0) + 1
open(counter, "w").write(str(calls))
print("pane=w:new agent=claude status=idle")
if calls == 2 and os.environ.get("FAKE_ASK2_NOTE"):
    print(os.environ["FAKE_ASK2_NOTE"])
print("--- reply ---")
print(os.environ.get("FAKE_REPLY", "HANDOFF-ACCEPTED first step: read the worker reply"))
sys.exit(int(os.environ.get("FAKE_ASK_EXIT" if calls == 1 else "FAKE_ASK2_EXIT", "0")))
'''


def fixture(root):
    """A copy of the skill with fake spawn.py and ask.py, a fake herdr on PATH, and a coordinator record."""
    scripts = os.path.join(root, "skill", "scripts")
    os.makedirs(scripts)
    for name in ("handoff.py", "_common.py"):
        shutil.copy(os.path.join(SKILL, "scripts", name), scripts)
    for name in ("contract.json", "roles.json"):
        shutil.copy(os.path.join(SKILL, name), os.path.join(root, "skill"))
    bin_dir = os.path.join(root, "bin")
    os.makedirs(bin_dir)
    for path, text in ((os.path.join(bin_dir, "herdr"), FAKE_HERDR), (os.path.join(scripts, "spawn.py"), FAKE_SPAWN),
                       (os.path.join(scripts, "ask.py"), FAKE_ASK)):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(path, 0o755)
    state = os.path.join(root, "state")
    os.makedirs(os.path.join(state, "panes"))
    with open(os.path.join(state, "panes", "w_old.json"), "w", encoding="utf-8") as f:
        json.dump({"pane_id": "w:old", "role": "coordinator", "harness": "claude", "workspace_id": "w",
                   "session": "primary"}, f)
    session = os.path.join(root, "session")
    os.makedirs(session)
    handoff = os.path.join(session, "handoff.md")
    with open(handoff, "w", encoding="utf-8") as f:
        f.write("# Handoff\n\nState of the work.\n")
    env = {"PATH": bin_dir + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"), "HOME": root,
           "HERDR_ENV": "1", "HERDR_PANE_ID": "w:old", "HERDR_WORKSPACE_ID": "w", "HERDR_SKILL_STATE_DIR": state,
           "FAKE_LOG": os.path.join(root, "log.jsonl"), "FAKE_DIR": session}
    return os.path.join(scripts, "handoff.py"), handoff, env


def run(script, handoff, env, **fake):
    env = dict(env, **fake)
    with open(os.path.join(os.path.dirname(env["FAKE_LOG"]), "ask-calls"), "w", encoding="utf-8") as f:
        f.write("0")  # each run starts with the start prompt
    p = subprocess.run([sys.executable, script, "--file", handoff, "--timeout", "5"], env=env,
                       capture_output=True, text=True, timeout=120)
    try:
        with open(env["FAKE_LOG"], encoding="utf-8") as f:
            log = [json.loads(line) for line in f]
    except OSError:
        log = []
    return p.returncode, p.stdout, [e for e in log if "close" in e]


class Handoff(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="herdr-handoff-test-")
        self.addCleanup(temp.cleanup)
        self.root = temp.name
        self.script, self.handoff, self.env = fixture(self.root)

    def test_a_confirmed_handoff_records_first_and_closes_only_the_calling_pane(self):
        code, out, closes = run(self.script, self.handoff, self.env)
        self.assertEqual(code, 0, out)
        self.assertEqual(closes, [{"close": "w:old", "record_present": True}])

    def test_a_failed_handoff_closes_no_pane(self):
        # The start prompt times out or has no marker (5); the second send finds a blocked pane or gives
        # exit 0 with the API-error note of contract.json over the older accepted reply (7).
        note = CONTRACT["ask"]["api_error_note"] + " (API Error: 429); from before this prompt"
        for fake, expected in (({"FAKE_ASK_EXIT": "124"}, 5), ({"FAKE_REPLY": "I read the file."}, 5),
                               ({"FAKE_ASK2_EXIT": "4"}, 7), ({"FAKE_ASK2_NOTE": note}, 7)):
            with self.subTest(fake=fake):
                code, out, closes = run(self.script, self.handoff, self.env, **fake)
                self.assertEqual(code, expected, out)
                self.assertEqual(closes, [])


if __name__ == "__main__":
    unittest.main()
