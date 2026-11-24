"""Tests for role_set.py (herdr-role-set), the Start helper for a space's role set.

Uses a fake herdr-core / hc executable first on a restricted PATH. Never calls the real hc.
"""
import contextlib
import hashlib
import inspect
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")
SCRIPT = os.path.join(SCRIPTS, "role_set.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
import role_set  # noqa: E402

MUTATING_VERBS = frozenset({"send", "run", "kill", "label", "rm", "rename", "close", "write", "type"})


def parse_opts(rest, value_flags):
    """Parse CLI options regardless of flag order, `--flag=val`, or optional `--`."""
    flags, pos, i = {}, [], 0
    while i < len(rest):
        a = rest[i]
        if a == "--":
            return flags, pos + rest[i + 1:]
        k, eq, v = a.partition("=")
        if eq and k in value_flags: flags.setdefault(k, []).append(v)
        elif a in value_flags and i + 1 < len(rest): flags.setdefault(a, []).append(rest[i + 1]); i += 1
        elif a.startswith("--"): flags[a] = True
        else: pos.append(a)
        i += 1
    return flags, pos


def role_tab(space, role):
    return "tb" + hashlib.md5(f"{space}:{role}".encode()).hexdigest()


FAKE_HC = '''#!{python}
import json, os, sys
{parse_opts_src}
args = sys.argv[1:]
with open(os.environ["FAKE_HC_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps([os.path.basename(sys.argv[0])] + args) + "\\n")
sp = os.environ["FAKE_HC_STATE"]
with open(sp, encoding="utf-8") as f: state = json.load(f)
terms, muts, sub = state.get("terminals", {{}}), state.get("mutations", {{}}), (args[0] if args else "")
def reply(obj, code=0): print(json.dumps(obj)); sys.exit(code)
if sub == "ls" and "ls_reply" in state:
    reply(state["ls_reply"])
if sub == "ls":
    fl, _ = parse_opts(args[1:], {{"--label"}})
    want = [p.split("=", 1) for p in fl.get("--label", []) if "=" in p]
    reply({{"terminals": [{{"address": a}} for a, r in terms.items()
            if r.get("state") == "live" and all((r.get("labels") or {{}}).get(k) == v for k, v in want)]}})
fl, pos = parse_opts(args[1:], {{"--if", "--timeout"}} if sub == "send" else set())
rec = terms.get(pos[0] if pos else "")
if sub in ("get", "send") and rec is None: reply({{"error": {{"kind": "not_found"}}}}, 3)
if sub == "get":
    snap = json.loads(json.dumps(rec))
    if muts.get(pos[0]):
        patch = muts[pos[0]].pop(0)
        if patch is not None: rec.update(patch)
        with open(sp, "w", encoding="utf-8") as f: json.dump(state, f)
    reply(snap)
if sub == "send":
    if pos[0] in state.get("send_errors", {{}}):
        err = state["send_errors"][pos[0]]
        reply({{"error": {{"kind": err[0]}}}}, err[1])
    if "--if" in fl and (rec.get("status") or {{}}).get("state") != fl["--if"][-1]:
        reply({{"error": {{"kind": "status_mismatch"}}}}, 10)
    reply({{"started": True, "terminal": pos[0]}})
if sub == "label":
    if rec is None: reply({{"error": {{"kind": "not_found"}}}}, 3)
    if pos[0] in state.get("label_errors", []): reply({{"error": {{"kind": "failed"}}}}, 1)
    labels = rec.setdefault("labels", {{}})
    for kv in pos[1:]:
        k, _, v = kv.partition("=")
        if v: labels[k] = v
        else: labels.pop(k, None)
    with open(sp, "w", encoding="utf-8") as f: json.dump(state, f)
    reply({{"terminal": pos[0]}})
reply({{"error": {{"kind": "unsupported", "message": sub}}}}, 1)
'''


FAKE_PI = '''#!{python}
import os, sys
with open(os.environ["FAKE_PI_LOG"], "a", encoding="utf-8") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:2] != ["--list-models"]:
    sys.exit(3)
with open(os.environ["FAKE_PI_LISTING"], encoding="utf-8") as f:
    sys.stdout.write(f.read())
'''

FAKE_AGY = '''#!{python}
import sys
if sys.argv[1:2] == ["models"]:
    print("gemini-4-neon-xhigh\\tGemini 4 Neon xhigh")
    sys.exit(0)
sys.exit(3)
'''

PI_HEADER = "provider        model             context  max-out  thinking  images\n"


class RoleSetTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-role-set-test-")
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.home, self.state_dir, self.bin_dir, self.work_cwd = [os.path.join(self.root, d) for d in ("home", "state", "bin", "work")]
        for d in (self.home, self.state_dir, self.bin_dir, self.work_cwd):
            os.makedirs(d, exist_ok=True)
        core_bin = os.path.join(self.bin_dir, "herdr-core")
        with open(core_bin, "w", encoding="utf-8") as f:
            f.write(FAKE_HC.format(python=sys.executable, parse_opts_src=inspect.getsource(parse_opts)))
        os.chmod(core_bin, 0o755)
        os.symlink(core_bin, os.path.join(self.bin_dir, "hc"))
        pi_bin = os.path.join(self.bin_dir, "pi")
        with open(pi_bin, "w", encoding="utf-8") as f:
            f.write(FAKE_PI.format(python=sys.executable))
        os.chmod(pi_bin, 0o755)
        agy_bin = os.path.join(self.bin_dir, "agy")
        with open(agy_bin, "w", encoding="utf-8") as f:
            f.write(FAKE_AGY.format(python=sys.executable))
        os.chmod(agy_bin, 0o755)
        self.pi_listing, self.pi_log = os.path.join(self.root, "pi-listing.txt"), os.path.join(self.root, "pi-log.txt")
        self.write_listing([])
        self.log_path, self.state_path = os.path.join(self.root, "hc-log.jsonl"), os.path.join(self.root, "hc-state.json")
        self.env = {"PATH": self.bin_dir + os.pathsep + "/usr/bin:/bin", "HOME": self.home, "SHELL": "/bin/sh",
                    "XDG_CONFIG_HOME": os.path.join(self.root, "config"), "HERDR_SKILL_STATE_DIR": self.state_dir,
                    "HERDR_SKILL_RESOURCES": os.path.join(self.root, "no-machine-file.json"),
                    "FAKE_HC_LOG": self.log_path, "FAKE_HC_STATE": self.state_path,
                    "FAKE_PI_LISTING": self.pi_listing, "FAKE_PI_LOG": self.pi_log}
        self.write_state({})

    def term(self, addr, tab, *, space="sp-demo", app=None, status_state=None, role=None, pid=4242, fg_pid=None, fg_name="bash", name=None):
        labels = {"herdr.space": space, "herdr.tab": tab, "where": "demo / 1", **({"skill.role": role} if role else {})}
        fg = {"pid": pid if fg_pid is None else fg_pid, "cwd": self.work_cwd, **({"name": fg_name} if fg_name is not None else {})}
        rec = {"address": addr, "state": "live", "cwd": self.work_cwd, "pid": pid, "created_ms": (time.time() - 60) * 1000,
               "labels": labels, "foreground": fg, "status": {k: v for k, v in (("app", app), ("state", status_state)) if v is not None}}
        return dict(rec, name=name) if name else rec

    def write_listing(self, rows):
        with open(self.pi_listing, "w", encoding="utf-8") as f:
            f.write(PI_HEADER + "".join(f"{p}  {m}  200K  32K  yes  no\n" for p, m in rows))

    def write_state(self, terminals, *, mutations=None, send_errors=None):
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({"terminals": terminals, "mutations": mutations or {}, "send_errors": send_errors or {}}, f)

    def calls(self):
        with open(self.log_path, encoding="utf-8") as f: return [json.loads(line) for line in f if line.strip()]

    def sends(self):
        return [(fl, pos[0] if pos else None, pos[1] if len(pos) > 1 else "")
                for c in self.calls() if len(c) > 1 and c[1] == "send" for fl, pos in (parse_opts(c[2:], {"--if", "--timeout"}),)]

    def run_raw(self, raw_args):
        with open(self.log_path, "w", encoding="utf-8"): pass
        return subprocess.run([sys.executable, SCRIPT, *raw_args], env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)

    def run_helper(self, payload, *, dry_run=False):
        return self.run_raw(["--set", json.dumps(payload)] + (["--dry-run"] if dry_run else []))

    def run_inprocess(self, payload, *patches):
        with open(self.log_path, "w", encoding="utf-8"): pass
        out, err, code = io.StringIO(), io.StringIO(), 0
        with contextlib.ExitStack() as stack:
            for ctx in (mock.patch.dict(os.environ, self.env, clear=True),
                        mock.patch.object(role_set.spawn, "STATE_DIR", self.state_dir),
                        mock.patch.object(role_set.spawn._common, "STATE_DIR", self.state_dir),
                        mock.patch.object(role_set.spawn._common, "MACHINE_CATALOG", self.env["HERDR_SKILL_RESOURCES"]),
                        *patches, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
                stack.enter_context(ctx)
            try: role_set.main(["--set", json.dumps(payload)])
            except SystemExit as exc: code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def assert_no_mutation(self):
        self.assertEqual([c for c in self.calls() if len(c) > 1 and c[1] in MUTATING_VERBS], [])

    def assert_bad_input(self, proc):
        lines = proc.stdout.strip().splitlines()
        self.assertEqual((proc.returncode, len(lines)), (2, 1), proc.stdout + proc.stderr)
        out = json.loads(lines[0])
        self.assertTrue((out.get("version"), out.get("ok")) == (1, False) and "done" not in out and isinstance(out.get("error"), str) and out["error"])
        self.assertEqual(self.calls(), [])

    def assert_real_stdout(self, stdout_text):
        lines = [json.loads(line) for line in stdout_text.strip().splitlines()]
        self.assertTrue(lines, stdout_text)
        for line in lines[:-1]:
            self.assertTrue((line.get("version"), line.get("ok")) == (1, True)
                            and line.get("action") in ("launch", "handoff") and isinstance(line.get("terminal"), str) and line["terminal"])
        return lines[:-1], lines[-1]

    def assert_action_fail(self, code, stdout_text, done):
        self.assertEqual(code, 1, stdout_text)
        actions, last = self.assert_real_stdout(stdout_text)
        self.assertTrue((last.get("version"), last.get("ok"), last.get("done")) == (1, False, done) and isinstance(last.get("error"), str) and last["error"])
        return actions, last

    def record_file(self, addr):
        return os.path.join(self.state_dir, "panes", f"{addr}.json")

    def record(self, addr):
        """The pane record of `addr` through the record functions of _common, or None."""
        with mock.patch.object(role_set.spawn._common, "STATE_DIR", self.state_dir):
            return role_set.spawn._common.read_record(addr)

    def put_record(self, addr, data):
        with mock.patch.object(role_set.spawn._common, "STATE_DIR", self.state_dir):
            role_set.spawn._common.write_record(addr, data)

    def write_coordinator_record(self, addr, space):
        self.put_record(addr, {"pane_id": addr, "role": "coordinator", "workspace_id": space, "backend": "herdr-core",
                               "created_at_epoch": time.time()})

    def coordinator_space(self, tab="tb-main"):
        """t1 (older) and t2 (newer) agents and a newest shell in `tab`, an old coordinator t3 in another tab,
        and a coordinator t4 of another space."""
        t1, t2 = self.term("t1", tab, app="claude-code"), self.term("t2", tab, app="pi")
        t1["created_ms"] -= 30000
        shell = self.term("t5", tab)
        shell["created_ms"] += 30000
        t3 = self.term("t3", "tb-old", app="claude-code", role="coordinator")
        t4 = self.term("t4", tab, space="sp-other", app="claude-code", role="coordinator")
        self.write_state({"t1": t1, "t2": t2, "t3": t3, "t4": t4, "t5": shell})
        for addr, space in (("t3", "sp-demo"), ("t4", "sp-other")):
            self.write_coordinator_record(addr, space)

    def labels_now(self):
        with open(self.state_path, encoding="utf-8") as f:
            return {a: r.get("labels", {}).get("skill.role") for a, r in json.load(f)["terminals"].items()}

    def label_calls(self):
        return [c[2:] for c in self.calls() if len(c) > 1 and c[1] == "label"]

    def test_coordinator_flags_newest_agent_and_clears_other_coordinators(self):
        self.coordinator_space()
        proc = self.run_raw(["--coordinator", "sp-demo", "tb-main"])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"version": 1, "ok": True, "space": "sp-demo", "tab": "tb-main",
                                                    "coordinator": "t2", "cleared": ["t3"], "changed": True,
                                                    "dry_run": False})
        self.assertEqual(self.label_calls(), [["t2", "skill.role=coordinator"], ["t3", "skill.role="]])
        self.assertEqual(self.labels_now(), {"t1": None, "t2": "coordinator", "t3": None, "t4": "coordinator", "t5": None})
        rec = self.record("t2")
        self.assertEqual((rec["role"], rec["workspace_id"], rec["backend"], rec["pane_id"]),
                         ("coordinator", "sp-demo", "herdr-core", "t2"))
        self.assertIsNone(self.record("t3"))
        self.assertEqual(self.record("t4")["workspace_id"], "sp-other")
        with self.subTest(case="second run"):
            proc = self.run_raw(["--coordinator", "sp-demo", "tb-main"])
            out = json.loads(proc.stdout)
            self.assertEqual((proc.returncode, out["coordinator"], out["cleared"], out["changed"]), (0, "t2", [], False))
            self.assertEqual(self.label_calls(), [])

    def test_coordinator_never_flags_or_changes_task_role_terminals(self):
        tab = "tb-main"
        labelled = self.term("t6", tab, app="claude-code", role="worker")
        named = self.term("t7", tab, app="pi", name="demo-reviewer-1")
        for only in (labelled, named):
            with self.subTest(only=only["address"]):
                self.write_state({only["address"]: only})
                proc = self.run_raw(["--coordinator", "sp-demo", tab])
                out = json.loads(proc.stdout)
                self.assertEqual((proc.returncode, out["coordinator"], out["cleared"], out["changed"]), (0, None, [], False))
                self.assert_no_mutation()
        with self.subTest(case="beside an older agent"):
            older = self.term("t8", tab, app="claude-code")
            older["created_ms"] -= 30000
            self.write_state({"t6": labelled, "t7": named, "t8": older})
            proc = self.run_raw(["--coordinator", "sp-demo", tab])
            self.assertEqual(json.loads(proc.stdout)["coordinator"], "t8", proc.stdout + proc.stderr)
            self.assertEqual(self.label_calls(), [["t8", "skill.role=coordinator"]])
            self.assertEqual(self.labels_now(), {"t6": "worker", "t7": None, "t8": "coordinator"})

    def test_coordinator_dry_run_changes_nothing(self):
        self.coordinator_space()
        proc = self.run_raw(["--coordinator", "sp-demo", "tb-main", "--dry-run"])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual((out["coordinator"], out["cleared"], out["changed"], out["dry_run"]), ("t2", ["t3"], True, True))
        self.assert_no_mutation()
        self.assertIsNone(self.record("t2"))
        self.assertEqual(self.record("t3")["role"], "coordinator")

    def test_coordinator_keeps_the_chosen_pane_with_duplicate_rows(self):
        self.write_state({"t1": self.term("t1", "tb-main", app="pi", role="coordinator")})
        self.write_coordinator_record("t1", "sp-demo")
        with open(self.state_path, encoding="utf-8") as f:
            state = json.load(f)
        state["ls_reply"] = {"terminals": [{"address": "t1"}, {"address": "t1"}]}
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
        proc = self.run_raw(["--coordinator", "sp-demo", "tb-main"])
        out = json.loads(proc.stdout)
        self.assertEqual((proc.returncode, out["coordinator"], out["cleared"]), (0, "t1", []), proc.stdout + proc.stderr)
        self.assertEqual(self.labels_now(), {"t1": "coordinator"})
        self.assertEqual(self.record("t1")["role"], "coordinator")

    def test_coordinator_skips_a_shell_with_an_old_agent_record(self):
        old = self.term("t1", "tb-old", app="claude-code", role="coordinator")
        shell = self.term("t2", "tb-main")
        self.write_state({"t1": old, "t2": shell})
        self.write_coordinator_record("t1", "sp-demo")
        self.put_record("t2", {"pane_id": "t2", "harness": "pi", "session": "primary", "self": True,
                               "backend": "herdr-core", "created_at_epoch": time.time()})
        proc = self.run_raw(["--coordinator", "sp-demo", "tb-main"])
        out = json.loads(proc.stdout)
        self.assertEqual((proc.returncode, out["coordinator"], out["cleared"], out["changed"]), (0, None, [], False),
                         proc.stdout + proc.stderr)
        self.assert_no_mutation()
        self.assertEqual(self.labels_now(), {"t1": "coordinator", "t2": None})
        self.assertEqual(self.record("t1")["role"], "coordinator")

    def test_coordinator_failure_after_the_label_keeps_the_fields(self):
        for case, labeled, want_changed in (("clear label fails", False, True), ("identical label, record write fails", True, False)):
            with self.subTest(case=case):
                self.setUp()  # a fresh state folder for each case
                self.coordinator_space()
                with open(self.state_path, encoding="utf-8") as f:
                    state = json.load(f)
                if labeled:  # the record path is a directory, so the record write fails
                    state["terminals"]["t2"]["labels"]["skill.role"] = "coordinator"
                    os.makedirs(self.record_file("t2"), exist_ok=True)
                else:
                    state["label_errors"] = ["t3"]
                with open(self.state_path, "w", encoding="utf-8") as f:
                    json.dump(state, f)
                proc = self.run_raw(["--coordinator", "sp-demo", "tb-main"])
                last = json.loads(proc.stdout.strip().splitlines()[-1])
                self.assertEqual((proc.returncode, last["ok"], last["coordinator"], last["flagged"], last["cleared"], last["changed"]),
                                 (1, False, "t2", True, [], want_changed), proc.stdout + proc.stderr)

    def write_claude_transcript(self, pid, sid, inp=0, cache_r=0, cache_c=0):
        sdir, pdir = os.path.join(self.home, ".claude", "sessions"), os.path.join(self.home, ".claude", "projects", "-work-demo")
        os.makedirs(sdir, exist_ok=True); os.makedirs(pdir, exist_ok=True)
        with open(os.path.join(sdir, f"{pid}.json"), "w", encoding="utf-8") as f:
            json.dump({"pid": pid, "sessionId": sid, "cwd": self.work_cwd}, f)
        with open(os.path.join(pdir, f"{sid}.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "assistant", "message": {"role": "assistant", "usage": {
                "input_tokens": inp, "cache_read_input_tokens": cache_r, "cache_creation_input_tokens": cache_c}}}) + "\n")

    def test_unknown_label_or_version_exits_2_with_no_action(self):
        space = "sp-demo"
        self.write_state({"t12": self.term("t12", role_tab(space, "worker"))})
        valid = json.dumps({"version": 1, "space": space, "roles": {}})
        for label, item in (
            ("unknown version", {"version": 2, "space": space, "roles": {}}),
            ("bool version", {"version": True, "space": space, "roles": {}}),
            ("missing space", {"version": 1, "roles": {}}),
            ("empty space", {"version": 1, "space": "", "roles": {}}),
            ("space whitespace", {"version": 1, "space": "sp demo", "roles": {}}),
            ("space control char", {"version": 1, "space": "sp\x07demo", "roles": {}}),
            ("space lone surrogate", ["--set", '{"version":1,"space":"sp\\ud800","roles":{}}']),
            ("unknown role", {"version": 1, "space": space, "roles": {"scout": {"model": "codex/luna"}}}),
            ("unknown model", {"version": 1, "space": space, "roles": {"worker": {"model": "vendor/unknown"}}}),
            ("role-specific model", {"version": 1, "space": space, "roles": {"researcher": {"model": "claude/opus"}}}),
            ("provider effort", {"version": 1, "space": space, "roles": {"worker": {"model": "claude/opus", "thinking": "minimal"}}}),
            ("repeated dry-run", ["--set", valid, "--dry-run", "--dry-run"]),
            ("equals set form", [f"--set={valid}"]),
        ):
            with self.subTest(case=label):
                self.assert_bad_input(self.run_raw(["--set", json.dumps(item)] if isinstance(item, dict) else item))

    def test_models_lists_copilot_without_claude_ids(self):
        self.write_listing([("openai-codex", "gpt-6-sol"), ("github-copilot", "gpt-6-sol"), ("github-copilot", "claude-opus-5.5"),
                            ("github-copilot", "grok-4.7"), ("anthropic", "claude-opus-5-5")])
        proc = self.run_raw(["--models"])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        out = json.loads(proc.stdout.strip())
        self.assertEqual((out["version"], out["ok"], out["providers"]["copilot"]["models"]),
                         (1, True, ["copilot/gpt-6-sol", "copilot/grok-4.7"]))
        self.assertEqual(self.calls(), [])
        with self.subTest(case="no github-copilot line"):
            self.write_listing([("openai-codex", "gpt-6-sol")])
            proc = self.run_raw(["--models"])
            out = json.loads(proc.stdout.strip())
            self.assertEqual((proc.returncode, out["ok"], out["providers"]["copilot"]["models"]), (0, True, []))

    def test_copilot_key_not_in_listing_refuses_whole_set(self):
        space, wtab = "sp-demo", role_tab("sp-demo", "worker")
        self.write_listing([("github-copilot", "gpt-6-sol"), ("github-copilot", "claude-opus-5.5")])
        self.write_state({"t12": self.term("t12", wtab), "t13": self.term("t13", role_tab(space, "reviewer"))})
        for model in ("copilot/gpt-9-none", "copilot/claude-opus-5.5"):
            with self.subTest(model=model):
                payload = {"version": 1, "space": space, "roles": {"worker": {"model": "claude/opus"},
                                                                   "reviewer": {"model": model}}}
                with mock.patch.object(role_set.spawn, "resolve") as resolve:
                    code, out, _ = self.run_inprocess(payload)
                self.assertEqual((code, resolve.call_count, self.calls()), (2, 0, []))
                self.assertFalse(json.loads(out.strip())["ok"])

    def test_copilot_key_spawns_github_copilot_model_on_pi(self):
        space, wtab = "sp-demo", role_tab("sp-demo", "worker")
        self.write_listing([("github-copilot", "gpt-6-sol"), ("github-copilot", "grok-4.7")])
        self.write_state({"t12": self.term("t12", wtab)})
        payload = {"version": 1, "space": space, "roles": {"worker": {"model": "copilot/grok-4.7", "thinking": "max"}}}
        with mock.patch.object(role_set.spawn, "resolve", wraps=role_set.spawn.resolve) as resolve:
            code, out, err = self.run_inprocess(payload)
        self.assertEqual(code, 0, out + err)
        self.assertEqual([(c.args[0]["harness"], c.args[0]["model"], c.args[0]["thinking"]) for c in resolve.call_args_list],
                         [("pi", "github-copilot/grok-4.7", "max")])
        self.assertEqual(len(self.sends()), 1)

    def test_dry_run_sends_nothing_and_changes_no_terminal(self):
        space = "sp-demo"
        self.write_claude_transcript(4100, "sess-coord-dry", 10000, 200000, 4000)
        self.write_state({
            "t10": self.term("t10", "tb-coord", app="claude-code", status_state="idle", role="coordinator", pid=4100, fg_name="claude", name="demo-coordinator-1"),
            "t12": self.term("t12", role_tab(space, "worker")), "t14": self.term("t14", role_tab(space, "scout")),
            "t13": self.term("t13", role_tab(space, "reviewer")), "t15": self.term("t15", "tb-user"),
        })
        proc = self.run_helper({"version": 1, "space": space, "roles": {
            "coordinator": {"model": "claude/opus", "thinking": "max"},
            "researcher": {"model": "codex/luna"}, "worker": {"model": "agy/neon", "thinking": "xhigh"}}}, dry_run=True)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual((proc.returncode, len(lines)), (0, 1), proc.stdout + proc.stderr)
        out = json.loads(lines[0])
        self.assertEqual((out["version"], out["ok"], out["space"], out["coordinator_tokens"], out["handoff"]), (1, True, space, 214000, True))
        self.assertTrue(isinstance(out.get("preview"), str) and 0 < len(out["preview"]) <= 120)
        self.assertEqual({x["terminal"]: x for x in out["launch"]}, {
            "t12": {"terminal": "t12", "role": "worker", "model": "agy/neon", "thinking": "xhigh"},
            "t14": {"terminal": "t14", "role": "scout", "model": "codex/luna"}})
        skipped = {s["terminal"]: s for s in out["skip"]}
        self.assertTrue(skipped["t13"]["role"] == "reviewer" and isinstance(skipped["t13"]["reason"], str) and bool(skipped["t13"]["reason"].strip()))
        self.assertTrue(skipped["t15"]["role"] is None and isinstance(skipped["t15"]["reason"], str) and bool(skipped["t15"]["reason"].strip()))
        self.assert_no_mutation()

        with self.subTest(case="agy coordinator disables handoff with reason"):
            proc = self.run_helper({"version": 1, "space": space, "roles": {"coordinator": {"model": "agy/neon", "thinking": "xhigh"}}}, dry_run=True)
            out = json.loads(proc.stdout.strip())
            self.assertEqual((proc.returncode, out["coordinator_tokens"], out["handoff"]), (0, 214000, False))
            self.assertIn("agy", (out["preview"] + " " + next((s["reason"] for s in out["skip"] if s["terminal"] == "t10"), "")).lower())
            self.assert_no_mutation()

        with self.subTest(case="opaque empty space exits 0"):
            empty_space = "sp_empty:1/" + "a" * 130
            ep = {"version": 1, "space": empty_space, "roles": {"worker": {"model": "claude/opus"}}}
            dry = self.run_helper(ep, dry_run=True)
            self.assert_no_mutation()
            d = json.loads(dry.stdout.strip())
            self.assertEqual((dry.returncode, d["space"], d["launch"], d["skip"], d["handoff"], d["coordinator_tokens"]), (0, empty_space, [], [], False, None))
            real = self.run_helper(ep)
            self.assert_no_mutation()
            self.assertEqual((real.returncode, self.assert_real_stdout(real.stdout)), (0, ([], {"version": 1, "ok": True, "done": 0})))

    def test_terminal_with_an_agent_never_gets_a_launch(self):
        space, wtab = "sp-demo", role_tab("sp-demo", "worker")
        pdir = os.path.join(self.state_dir, "panes")
        os.makedirs(pdir, exist_ok=True)
        with open(os.path.join(pdir, "t27.json"), "w", encoding="utf-8") as f:
            json.dump({"pane_id": "t27", "name": "demo-worker-1", "role": "worker", "harness": "claude",
                       "backend": "herdr-core", "created_at_epoch": time.time() - 30}, f)
        self.write_state({
            "t20": self.term("t20", wtab, app="claude-code", pid=4200, fg_pid=4200, fg_name="bash"),
            "t21": self.term("t21", "tb-user", pid=4210), "t22": self.term("t22", wtab, status_state="busy\nagain\x07", pid=4220),
            "t24": self.term("t24", wtab, fg_name=None), "t25": self.term("t25", wtab, pid=4250, fg_pid=4251),
            "t26": self.term("t26", wtab, pid=4260, fg_name="vim"), "t27": self.term("t27", wtab, pid=4270),
            "t23": self.term("t23", wtab, pid=4242, fg_name="zsh"),
        })
        payload = {"version": 1, "space": space, "roles": {"worker": {"model": "claude/opus", "thinking": "high"}}}
        proc = self.run_helper(payload)
        self.assertEqual((proc.returncode, self.assert_real_stdout(proc.stdout)),
                         (0, ([{"version": 1, "action": "launch", "terminal": "t23", "ok": True}], {"version": 1, "ok": True, "done": 1})))
        err_lines = proc.stderr.splitlines()
        self.assertTrue(err_lines and all(line.startswith("skip ") for line in err_lines), proc.stderr)
        self.assertTrue(any("t21" in line for line in err_lines) and any("t22" in line and "busy again" in line for line in err_lines))
        self.assertNotIn("t23", proc.stderr)
        sends = self.sends()
        self.assertTrue(len(sends) == 1 and sends[0][1] == "t23" and sends[0][2].strip() and "--force" not in sends[0][0])

        with self.subTest(case="reread skips when foreground or space changes"):
            self.write_state({"t28": self.term("t28", wtab, pid=4280), "t29": self.term("t29", wtab, pid=4290)},
                             mutations={"t28": [{"foreground": {"pid": 4281, "name": "python3", "cwd": self.work_cwd}}],
                                        "t29": [{"labels": {"herdr.space": "sp-other", "herdr.tab": wtab, "where": "o / 1"}}]})
            proc = self.run_helper(payload)
            self.assertEqual((proc.returncode, self.assert_real_stdout(proc.stdout)), (0, ([], {"version": 1, "ok": True, "done": 0})))
            self.assertTrue("t28" in proc.stderr and "t29" in proc.stderr and self.sends() == [])

        with self.subTest(case="injected IO failure after one finished action keeps partial done"):
            self.write_state({"t23a": self.term("t23a", wtab, pid=4242, fg_name="zsh"), "t23b": self.term("t23b", wtab, pid=4243, fg_name="zsh")})
            orig, calls = role_set.build_shell_launch, [0]
            def flaky(*a, **kw):
                calls[0] += 1
                if calls[0] == 2: raise OSError("injected disk error")
                return orig(*a, **kw)
            code, out, err = self.run_inprocess(payload, mock.patch.object(role_set, "build_shell_launch", side_effect=flaky))
            self.assertNotIn("Traceback", err)
            self.assertEqual((len(self.assert_action_fail(code, out, done=1)[0]), len(self.sends())), (1, 1))

        with self.subTest(case="broken roles.json fails without traceback"):
            self.write_state({"t23": self.term("t23", wtab, pid=4242, fg_name="zsh")})
            bad_dir = os.path.join(self.root, "bad-skill")
            os.makedirs(bad_dir, exist_ok=True)
            for raw in (b"\xff\xfe", b"{}"):
                with open(os.path.join(bad_dir, "roles.json"), "wb") as f:
                    f.write(raw)
                code, out, err = self.run_inprocess(payload, mock.patch.object(role_set.spawn._common, "SKILL_DIR", bad_dir))
                self.assertNotIn("Traceback", err)
                actions, last = self.assert_action_fail(code, out, done=0)
                self.assertNotIn("internal error", last["error"])
                self.assertEqual((actions, self.sends()), ([], []))

    def test_agy_launch_sends_the_first_message_of_spawn_to_the_new_pane(self):
        space, wtab = "sp-demo", role_tab("sp-demo", "worker")
        agy_fg = {"foreground": {"pid": 4301, "cwd": self.work_cwd, "name": "agy", "argv": ["agy", "--model", "x"]}}
        ready = dict(agy_fg, status={"app": "antigravity", "state": "idle"})
        payload = {"version": 1, "space": space, "roles": {"worker": {"model": "agy/neon", "thinking": "xhigh"}}}
        self.write_state({"t30": self.term("t30", wtab, pid=4300), "t31": self.term("t31", "tb-user", pid=4310)},
                         mutations={"t30": [None, ready]})
        proc = self.run_helper(payload)
        actions, last = self.assert_real_stdout(proc.stdout)
        self.assertEqual((proc.returncode, last), (0, {"version": 1, "ok": True, "done": 1}), proc.stderr)
        prompt_file = actions[0]["role_prompt"]
        self.assertEqual((actions[0]["terminal"], actions[0]["first_message"]), ("t30", "sent"))
        self.assertTrue(os.path.isfile(prompt_file))
        self.assertEqual([addr for _, addr, text in self.sends() if prompt_file in text], ["t30"])

        with self.subTest(case="a failed first message keeps the pane address"):
            working = dict(agy_fg, status={"app": "antigravity", "state": "working"})
            self.write_state({"t30": self.term("t30", wtab, pid=4300)}, mutations={"t30": [None, ready, working]})
            proc = self.run_helper(payload)
            actions, last = self.assert_real_stdout(proc.stdout)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual((actions[0]["terminal"], actions[0]["first_message"]), ("t30", "not sent"))
            self.assertTrue(actions[0]["first_message_error"])

    def test_agy_launch_sends_no_first_message_to_a_terminal_that_runs_another_app(self):
        space, wtab = "sp-demo", role_tab("sp-demo", "worker")
        other = {"status": {"app": "claude-code", "state": "idle"},
                 "foreground": {"pid": 4301, "cwd": self.work_cwd, "name": "claude"}}
        payload = {"version": 1, "space": space, "roles": {"worker": {"model": "agy/neon", "thinking": "xhigh"}}}
        self.write_state({"t30": self.term("t30", wtab, pid=4300)}, mutations={"t30": [None, other]})
        code, out, err = self.run_inprocess(payload, mock.patch.object(role_set, "AGY_READY_SECONDS", 2))
        actions, last = self.assert_real_stdout(out)
        self.assertEqual((code, last["ok"]), (0, True), err)
        self.assertEqual((actions[0]["terminal"], actions[0]["first_message"]), ("t30", "not sent"))
        self.assertIn("claude", actions[0]["first_message_error"])
        self.assertEqual([addr for _, addr, text in self.sends() if actions[0]["role_prompt"] in text], [])

    def test_no_handoff_at_or_below_200000_tokens_or_with_unknown_tokens(self):
        space = "sp-demo"
        payload = {"version": 1, "space": space, "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}
        c_msg = lambda u, **kw: {"type": "assistant", **kw, "message": {"role": "assistant", "usage": u}}
        p_msg = lambda u: {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "usage": u}}
        for idx, (label, agent, entries, want) in enumerate((
            ("claude boundary", "claude", [c_msg({"input_tokens": 50000, "cache_read_input_tokens": 140000, "cache_creation_input_tokens": 10000})], 200000),
            ("claude above", "claude", [c_msg({"input_tokens": 100001, "cache_read_input_tokens": 100000})], 200001),
            ("claude zero after high", "claude", [c_msg({"input_tokens": 250000}), c_msg({"input_tokens": 0, "cache_read_input_tokens": 0})], 0),
            ("claude sidechain ignored", "claude", [c_msg({"input_tokens": 180000}), {"type": "system", "subtype": "compact_boundary", "isSidechain": True}, c_msg({"input_tokens": 260000}, isSidechain=True)], 180000),
            ("claude main compaction", "claude", [c_msg({"input_tokens": 250000}), {"type": "system", "subtype": "compact_boundary"}], None),
            ("pi boundary", "pi", [p_msg({"input": 10000, "cacheRead": 190000, "cacheWrite": 0, "output": 300})], 200000),
            ("pi totalTokens only", "pi", [p_msg({"totalTokens": 250000, "output": 400})], None),
        )):
            with self.subTest(case=label):
                tpath = os.path.join(self.root, f"tok-{idx}.jsonl")
                with open(tpath, "w", encoding="utf-8") as f: f.writelines(json.dumps(e) + "\n" for e in entries)
                self.assertEqual(role_set.transcript_tokens(tpath, agent), want)
        self.assertIsNone(role_set.transcript_tokens(os.path.join(self.root, "missing.jsonl"), "claude"))

        coord = lambda a, app, st, pid, **kw: self.term(a, "tb-coord", app=app, status_state=st, role="coordinator", pid=pid, fg_name="claude" if app == "claude-code" else "pi", **kw)
        self.write_claude_transcript(5101, "sess-5101", 50000, 140000, 10000)
        for label, term, want_tok in (("real no-send at boundary", coord("t30", "claude-code", "idle", 5101), 200000),
                                      ("real no-send unknown count", coord("t32", "pi", "idle", 5202, name="demo-coordinator-3"), None)):
            with self.subTest(case=label):
                self.write_state({term["address"]: term})
                dry_proc = self.run_helper(payload, dry_run=True)
                self.assert_no_mutation()
                dry = json.loads(dry_proc.stdout.strip())
                real = self.run_helper(payload)
                self.assertEqual((dry_proc.returncode, dry["coordinator_tokens"], dry["handoff"], real.returncode, self.assert_real_stdout(real.stdout), self.sends()),
                                 (0, want_tok, False, 0, ([], {"version": 1, "ok": True, "done": 0}), []))

        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        for label, st, muts, send_errs, want_sends in (
            ("blocked refuses", "blocked", None, None, 0), ("missing refuses", None, None, None, 0), ("unrecognized refuses", "error", None, None, 0),
            ("idle to working refuses", "idle", {"t33": [{"status": {"app": "claude-code", "state": "working"}}]}, None, 0),
            ("hc send exit 10", "idle", None, {"t33": ["status_mismatch", 10]}, 1),
        ):
            with self.subTest(case=label):
                self.write_state({"t33": coord("t33", "claude-code", st, 5104)}, mutations=muts, send_errors=send_errs)
                real = self.run_helper(payload)
                self.assert_action_fail(real.returncode, real.stdout, done=0)
                self.assertEqual(len(self.sends()), want_sends)

        with self.subTest(case="done flips to working during transcript scan without send"):
            self.write_state({"t33": coord("t33", "claude-code", "done", 5104)})
            orig, scans = role_set.transcript_tokens, [0]
            def flip(*a, **kw):
                scans[0] += 1
                if scans[0] == 2: self.write_state({"t33": coord("t33", "claude-code", "working", 5104)})
                return orig(*a, **kw)
            code, out, _ = self.run_inprocess(payload, mock.patch.object(role_set, "transcript_tokens", side_effect=flip))
            self.assert_action_fail(code, out, done=0)
            self.assertEqual(self.sends(), [])

        for label, run_p, muts, marker in (
            ("changed session skips on stderr", payload, {"t33": [{"pid": 5999, "foreground": {"pid": 5999, "name": "claude", "cwd": self.work_cwd}}]}, "t33"),
            ("agy coordinator skips on stderr", {"version": 1, "space": space, "roles": {"coordinator": {"model": "agy/neon", "thinking": "xhigh"}}}, None, "agy"),
        ):
            with self.subTest(case=label):
                self.write_state({"t33": coord("t33", "claude-code", "idle", 5104)}, mutations=muts)
                real = self.run_helper(run_p)
                self.assertEqual((real.returncode, self.assert_real_stdout(real.stdout), self.sends()), (0, ([], {"version": 1, "ok": True, "done": 0}), []))
                self.assertIn(marker, real.stderr.lower())

        turn = coord("t33", "claude-code", "working", 5104)
        turn["records"] = {"b1": {"app": "claude-code", "state": "working", "title": "wait"}}
        for label, msg, records, want_sends in (
                ("at the prompt with a background shell delivers handoff", "1 shell still running", turn["records"], 1),
                ("at the prompt with a string child record delivers handoff", "1 shell still running", {"b1": "working"}, 1),
                ("real turn refuses", "Run the tests", turn["records"], 0)):
            with self.subTest(case=label):
                self.write_state({"t33": dict(turn, records=records, status=dict(turn["status"], msg=msg))})
                real = self.run_helper(payload)
                sends = self.sends()
                self.assertEqual((real.returncode, len(sends)), (0 if want_sends else 1, want_sends), real.stdout + real.stderr)
                if want_sends:
                    self.assertTrue(sends[0][1] == "t33" and sends[0][0].get("--if") is None and "--force" not in sends[0][0])
                else:
                    self.assert_action_fail(real.returncode, real.stdout, done=0)

        for st, want_if in (("done", None), ("idle", ["idle"])):
            with self.subTest(case=f"above 200000 {st} delivers handoff"):
                self.write_state({"t33": coord("t33", "claude-code", st, 5104)})
                real = self.run_helper(payload)
                self.assertEqual((real.returncode, self.assert_real_stdout(real.stdout)),
                                 (0, ([{"version": 1, "action": "handoff", "terminal": "t33", "ok": True}], {"version": 1, "ok": True, "done": 1})))
                self.assertEqual(real.stderr.strip(), "")
                sends = self.sends()
                self.assertTrue(len(sends) == 1 and sends[0][1] == "t33" and sends[0][0].get("--if") == want_if and "--force" not in sends[0][0])
                self.assertEqual(sends[0][2].split(), ["/tenantext:handoff_coordinator", "claude", "claude-opus-5-5", "max"])


if __name__ == "__main__":
    unittest.main()
