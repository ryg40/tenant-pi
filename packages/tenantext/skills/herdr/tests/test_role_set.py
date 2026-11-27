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
import json, os, sys, time
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
if sub == "run":
    if state.get("run_fails"): reply({{"error": {{"kind": "failed"}}}}, 1)
    import subprocess
    subprocess.Popen(args[args.index("--") + 1:], env=dict(os.environ, HC_TERMINAL_ID="t90"), start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    reply({{"address": "t90", "state": "live"}})
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
    time.sleep(state.get("send_delay", 0))
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

    def term(self, addr, tab, *, space="sp-demo", app=None, status_state=None, role=None, pid=4242, fg_pid=None, fg_name="bash", name=None, where="demo / 1"):
        labels = {"herdr.space": space, "herdr.tab": tab, **({"where": where} if where is not None else {}), **({"skill.role": role} if role else {})}
        fg = {"pid": pid if fg_pid is None else fg_pid, "cwd": self.work_cwd, **({"name": fg_name} if fg_name is not None else {})}
        rec = {"address": addr, "state": "live", "cwd": self.work_cwd, "pid": pid, "created_ms": (time.time() - 60) * 1000,
               "labels": labels, "foreground": fg, "status": {k: v for k, v in (("app", app), ("state", status_state)) if v is not None}}
        return dict(rec, name=name) if name else rec

    def write_listing(self, rows):
        with open(self.pi_listing, "w", encoding="utf-8") as f:
            f.write(PI_HEADER + "".join(f"{p}  {m}  200K  32K  yes  no\n" for p, m in rows))

    def write_state(self, terminals, *, mutations=None, send_errors=None, send_delay=0, run_fails=False):
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({"terminals": terminals, "mutations": mutations or {}, "send_errors": send_errors or {},
                       "send_delay": send_delay, "run_fails": run_fails}, f)

    def wait_result(self, path, limit=30):
        """The JSON of the result file of a detached handoff send, polled until it appears (at most `limit` s)."""
        end = time.monotonic() + limit
        while not os.path.exists(path):
            self.assertLess(time.monotonic(), end, f"no result file after {limit} s")
            time.sleep(0.05)
        with open(path, encoding="utf-8") as f: return json.load(f)

    def handoff_result(self, stdout_text):
        """Wait for the result file named by the handoff line of a real run and return its JSON."""
        line = next(json.loads(l) for l in stdout_text.splitlines() if json.loads(l).get("action") == "handoff")
        self.assertTrue(line.get("pending") is True and os.path.dirname(line["result"]) == os.path.join(self.state_dir, "role-set"), line)
        return self.wait_result(line["result"])

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
                            and line.get("action") in ("launch", "handoff", "role_models") and isinstance(line.get("terminal"), str) and line["terminal"])
        # The final line of a real run has `times`: whole milliseconds per step, plus the handoff status and reply.
        last = dict(lines[-1])
        times = last.pop("times", None)
        self.assertIsInstance(times, dict, stdout_text)
        self.assertTrue(all(type(v) is int and v >= 0 for k, v in times.items() if k not in ("coordinator_status", "send_detached", "send_fallback", "send_result"))
                        and type(times.get("total")) is int, times)
        return lines[:-1], last

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
                if want_sends:
                    self.handoff_result(real.stdout)
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
                self.assertEqual(self.handoff_result(real.stdout)["ok"], True)
                actions, last = self.assert_real_stdout(real.stdout)
                self.assertEqual((real.returncode, [dict(a, result=None) for a in actions], last),
                                 (0, [{"version": 1, "action": "handoff", "terminal": "t33", "ok": True, "pending": True, "result": None}],
                                  {"version": 1, "ok": True, "done": 1}))
                self.assertEqual(real.stderr.strip(), "")
                sends = self.sends()
                self.assertTrue(len(sends) == 1 and sends[0][1] == "t33" and sends[0][0].get("--if") == want_if and "--force" not in sends[0][0])
                self.assertEqual(sends[0][2].split(), ["/tenantext:handoff_coordinator", "claude", "claude-opus-5-5", "max"])

    def test_real_handoff_run_reports_step_times(self):
        payload = {"version": 1, "space": "sp-demo", "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")})
        real = self.run_helper(payload)
        times = json.loads(real.stdout.strip().splitlines()[-1])["times"]
        self.assertEqual((real.returncode, times.get("coordinator_status"), times.get("send_detached"), "send_result" in times),
                         (0, "done", True, False), real.stdout + real.stderr)
        self.assertTrue(all(type(times.get(k)) is int for k in ("total", "discover", "plan", "context", "get", "send")), times)
        self.assertNotIn("launch", times)
        self.assertEqual(self.handoff_result(real.stdout)["send_result"], {"started": True, "terminal": "t33"})

    def test_handoff_command_carries_the_task_role_choices_last(self):
        roles = {"coordinator": {"model": "claude/fable", "thinking": "medium"},
                 "reviewer": {"model": "codex/astra", "thinking": "low"},
                 "worker": {"model": "claude/opus", "thinking": "medium"},
                 "researcher": {"model": "claude/sonnet", "thinking": "high"}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")})
        real = self.run_helper({"version": 1, "space": "sp-demo", "roles": roles})
        self.assertEqual(real.returncode, 0, real.stdout + real.stderr)
        self.handoff_result(real.stdout)
        self.assertEqual(len(self.sends()), 1)  # a run with a handoff sends no role models notice
        self.assertEqual(self.sends()[0][2].split(), [
            "/tenantext:handoff_coordinator", "claude", "claude-fable-5-2", "medium",
            "roles=researcher:claude:claude-sonnet-5-5:high,worker:claude:claude-opus-5-5:medium,reviewer:pi:astra:low"])

    def test_an_agy_coordinator_choice_hands_off_and_a_live_agy_coordinator_does_not(self):
        payload = {"version": 1, "space": "sp-demo", "roles": {"coordinator": {"model": "agy/neon", "thinking": "xhigh"}}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")})
        real = self.run_helper(payload)
        self.assertEqual(real.returncode, 0, real.stdout + real.stderr)
        self.handoff_result(real.stdout)
        # The slug carries the effort, so the command gives no second thinking level (spawn.py refuses another
        # effort and accepts the same one).
        self.assertEqual(self.sends()[0][2].split(), ["/tenantext:handoff_coordinator", "agy", "gemini-4-neon-xhigh"])

        # A live agy coordinator has no slash command: no handoff, a reason that names agy, no send.
        self.write_state({"t34": self.term("t34", "tb-coord", app="antigravity", status_state="idle", role="coordinator", pid=5105, fg_name="agy")})
        code, out, err = self.run_inprocess(payload, mock.patch.object(role_set, "coordinator_context", return_value=(None, 250000)))
        self.assertEqual(code, 0, out + err)
        self.assertFalse([send for send in self.sends() if "handoff_coordinator" in send[2]], out + err)
        self.assertIn("agy", err)

    def test_detached_handoff_send_ends_the_run_before_a_slow_send(self):
        payload = {"version": 1, "space": "sp-demo", "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")},
                         send_delay=3)
        real = self.run_helper(payload)
        actions, last = self.assert_real_stdout(real.stdout)
        self.assertEqual((real.returncode, last["ok"], last["done"]), (0, True, 1), real.stdout + real.stderr)
        # The run ended while the fake send still sleeps: the child has written no result yet.
        self.assertFalse(os.path.exists(actions[0]["result"]))
        result = self.wait_result(actions[0]["result"])
        self.assertEqual((result["ok"], result["outcome"], result["terminal"]), (True, "ok", "t33"))
        self.assertGreaterEqual(result["send_ms"], 2500)

    def test_detached_handoff_send_failure_is_in_the_result_file(self):
        payload = {"version": 1, "space": "sp-demo", "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")},
                         send_errors={"t33": ["blocked", 9]})
        real = self.run_helper(payload)
        self.assertEqual(real.returncode, 0, real.stdout + real.stderr)
        result = self.handoff_result(real.stdout)
        self.assertEqual((result["ok"], result["outcome"], bool(result.get("error"))), (False, "not_delivered", True))

    def test_handoff_is_sent_in_the_run_when_the_background_terminal_fails(self):
        payload = {"version": 1, "space": "sp-demo", "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}
        self.write_claude_transcript(5104, "sess-5104", 100001, 100000, 0)
        self.write_state({"t33": self.term("t33", "tb-coord", app="claude-code", status_state="done", role="coordinator", pid=5104, fg_name="claude")},
                         run_fails=True)
        real = self.run_helper(payload)
        actions, last = self.assert_real_stdout(real.stdout)
        self.assertEqual((real.returncode, len(self.sends()), actions, last["ok"]),
                         (0, 1, [{"version": 1, "action": "handoff", "terminal": "t33", "ok": True}], True), real.stdout + real.stderr)
        times = json.loads(real.stdout.strip().splitlines()[-1])["times"]
        self.assertEqual((times.get("send_fallback"), "send_detached" in times), (True, False))
        self.assertEqual(os.listdir(os.path.join(self.state_dir, "role-set")), [])

    NOTICE_ROLES = {"coordinator": {"model": "claude/fable", "thinking": "medium"},
                    "reviewer": {"model": "codex/astra", "thinking": "low"},
                    "worker": {"model": "claude/opus", "thinking": "medium"},
                    "researcher": {"model": "claude/sonnet", "thinking": "high"}}
    NOTICE_TEXT = ('[Herdr app Start] The owner chose these role models in the window "Role models": '
                   "researcher (also scout): --harness claude --model claude-sonnet-5-5 --thinking high; "
                   "worker: --harness claude --model claude-opus-5-5 --thinking medium; "
                   "reviewer: --harness pi --model astra --thinking low. Start each pane of these roles with these "
                   "inputs. They come before the local models file and before your memory of earlier defaults. A later "
                   "word of the owner for one task or one role comes before them. A role that this line does not name "
                   "uses the request or the local models file. No reply is needed; continue your work.")

    def notice_coordinator(self, state, msg=None):
        coord = self.term("t33", "tb-coord", app="claude-code", status_state=state, role="coordinator", pid=5101, fg_name="claude")
        if msg is not None:
            coord["status"]["msg"] = msg
        self.write_state({"t33": coord})

    def test_start_with_no_handoff_tells_the_coordinator_the_role_models_once(self):
        self.write_claude_transcript(5101, "sess-5101", 50000, 0, 0)
        self.notice_coordinator("idle")
        payload = {"version": 1, "space": "sp-demo", "roles": self.NOTICE_ROLES}
        real = self.run_helper(payload)
        actions, last = self.assert_real_stdout(real.stdout)
        self.assertEqual((real.returncode, [a["action"] for a in actions], last["ok"]), (0, ["role_models"], True), real.stdout + real.stderr)
        self.assertTrue(self.wait_result(actions[0]["result"])["ok"])
        sends = self.sends()
        self.assertEqual([(s[1], s[0].get("--if"), s[2]) for s in sends], [("t33", ["idle"], self.NOTICE_TEXT)])
        again = self.run_helper(payload)
        self.assertEqual((again.returncode, self.assert_real_stdout(again.stdout)[0], self.sends()), (0, [], []), again.stdout + again.stderr)

    def test_role_models_notice_waits_for_the_end_of_a_turn(self):
        self.write_claude_transcript(5101, "sess-5101", 50000, 0, 0)
        self.notice_coordinator("working", msg="Run the tests")
        payload = {"version": 1, "space": "sp-demo", "roles": self.NOTICE_ROLES}
        real = self.run_helper(payload)
        self.assertEqual((real.returncode, self.assert_real_stdout(real.stdout)[0], self.sends()), (0, [], []), real.stdout + real.stderr)
        self.assertIn("t33", real.stderr)
        self.notice_coordinator("idle")
        later = self.run_helper(payload)
        actions, _ = self.assert_real_stdout(later.stdout)
        self.assertTrue(self.wait_result(actions[0]["result"])["ok"])
        self.assertEqual([(s[1], s[2]) for s in self.sends()], [("t33", self.NOTICE_TEXT)])

    def test_coordinator_tokens_reports_every_space_in_one_call_with_fallback(self):
        self.write_claude_transcript(6101, "sess-exp", 100000, 20000, 0)
        self.write_claude_transcript(6102, "sess-exp-fb", 350000, 0, 0)
        self.write_claude_transcript(6103, "sess-fb1", 10000, 300000, 4662)
        self.write_claude_transcript(6104, "sess-fbc", 0, 0, 0)
        self.write_claude_transcript(6105, "sess-tab2", 99000, 0, 0)
        self.write_claude_transcript(6106, "sess-worker", 88000, 0, 0)
        self.write_claude_transcript(6107, "sess-wtab", 77000, 0, 0)
        self.write_claude_transcript(6108, "sess-named", 66000, 0, 0)

        exp_coord = self.term("t61", "tb-exp-2", space="sp-explicit", app="claude-code", status_state="idle", role="coordinator", pid=6101, fg_name="claude", where="exp / 2")
        exp_coord["created_ms"] -= 60000
        exp_fallback = self.term("t62", "tb-exp-1", space="sp-explicit", app="claude-code", status_state="idle", pid=6102, fg_name="claude", where="exp / 1")
        fb1 = self.term("t63", "tb-fb1", space="sp-fallback-one", app="claude-code", status_state="idle", pid=6103, fg_name="claude", where="tenant-herdr / 1")
        fbc = self.term("t64", "tb-fbc", space="sp-fallback-coord", app="claude-code", status_state="idle", pid=6104, fg_name="claude", where="proj / coordinator")
        nc_shell = self.term("t65", "tb-nc1", space="sp-no-coord", pid=6100, fg_name="bash", where="nc / 1")
        nc_tab2 = self.term("t66", "tb-nc2", space="sp-no-coord", app="claude-code", status_state="idle", pid=6105, fg_name="claude", where="nc / 2")
        nc_worker = self.term("t67", "tb-nc1", space="sp-no-coord", app="claude-code", status_state="idle", role="worker", pid=6106, fg_name="claude", where="nc / 1")
        nc_wtab = self.term("t68", role_tab("sp-no-coord", "worker"), space="sp-no-coord", app="claude-code", status_state="idle", pid=6107, fg_name="claude", where="nc / 1")
        nc_named = self.term("t69", "tb-nc1", space="sp-no-coord", app="claude-code", status_state="idle", pid=6108, fg_name="claude", name="nc-reviewer-1", where="nc / 1")
        pi_unknown = self.term("t70", "tb-pi1", space="sp-pi-unknown", app="pi", status_state="idle", pid=6109, fg_name="pi", where="pi / 1")
        no_space = {"address": "t71", "state": "live", "cwd": self.work_cwd, "pid": 6110, "created_ms": time.time() * 1000,
                    "labels": {}, "foreground": {"pid": 6110, "name": "bash"}, "status": {}}
        remote = self.term("prox3090/t99", "tb-r1", space="sp-remote", app="claude-code", status_state="idle", role="coordinator", pid=6111, fg_name="claude")

        self.write_state({
            "t61": exp_coord, "t62": exp_fallback, "t63": fb1, "t64": fbc,
            "t65": nc_shell, "t66": nc_tab2, "t67": nc_worker, "t68": nc_wtab, "t69": nc_named,
            "t70": pi_unknown, "t71": no_space, "prox3090/t99": remote,
        })
        proc = self.run_raw(["--coordinator-tokens"])
        lines = proc.stdout.strip().splitlines()
        self.assertEqual((proc.returncode, len(lines)), (0, 1), proc.stdout + proc.stderr)
        self.assertEqual(json.loads(lines[0]), {
            "version": 1,
            "ok": True,
            "spaces": {
                "sp-explicit": 120000,
                "sp-fallback-coord": 0,
                "sp-fallback-one": 314662,
                "sp-no-coord": None,
                "sp-pi-unknown": None,
            },
        })
        self.assert_no_mutation()
        self.assertFalse(any(len(c) > 2 and c[1] == "get" and c[2] == "prox3090/t99" for c in self.calls()))

        with self.subTest(case="empty core"):
            self.write_state({})
            proc = self.run_raw(["--coordinator-tokens"])
            self.assertEqual((proc.returncode, json.loads(proc.stdout.strip())), (0, {"version": 1, "ok": True, "spaces": {}}))

    def test_dry_run_uses_coordinator_fallback_without_sending_handoff(self):
        space = "sp-unlabeled"
        self.write_claude_transcript(6201, "sess-t1d7", 14662, 300000, 0)
        self.write_claude_transcript(6202, "sess-explicit", 50000, 0, 0)
        payload = {"version": 1, "space": space, "roles": {"coordinator": {"model": "claude/opus", "thinking": "max"}}}

        t1d7 = self.term("t1d7", "tb-first", space=space, app="claude-code", status_state="idle", pid=6201, fg_name="claude", where="tenant-herdr / 1")
        self.write_state({"t1d7": t1d7})
        dry = self.run_helper(payload, dry_run=True)
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        out = json.loads(dry.stdout.strip())
        self.assertEqual((out["ok"], out["coordinator_tokens"], out["handoff"], out["role_models"]), (True, 314662, False, False))
        self.assert_no_mutation()

        real = self.run_helper(payload)
        self.assertEqual((real.returncode, self.assert_real_stdout(real.stdout), self.sends()), (0, ([], {"version": 1, "ok": True, "done": 0}), []))

        with self.subTest(case="second tab unlabeled is not a coordinator"):
            tab2 = self.term("t1d8", "tb-second", space=space, app="claude-code", status_state="idle", pid=6201, fg_name="claude", where="tenant-herdr / 2")
            self.write_state({"t1d8": tab2})
            dry2 = self.run_helper(payload, dry_run=True)
            self.assertEqual((dry2.returncode, json.loads(dry2.stdout.strip())["coordinator_tokens"]), (0, None))

        with self.subTest(case="explicit coordinator wins over fallback in dry run"):
            explicit = self.term("t1d9", "tb-second", space=space, app="claude-code", status_state="idle", role="coordinator", pid=6202, fg_name="claude", where="tenant-herdr / 2")
            explicit["created_ms"] -= 60000
            self.write_state({"t1d7": t1d7, "t1d9": explicit})
            dry3 = self.run_helper(payload, dry_run=True)
            self.assertEqual((dry3.returncode, json.loads(dry3.stdout.strip())["coordinator_tokens"]), (0, 50000))

    def test_coordinator_tokens_rejects_extra_args_and_handles_failures_and_deadline(self):
        for bad_args in (["--coordinator-tokens", "--dry-run"], ["--coordinator-tokens", "sp-1"], ["--models", "--coordinator-tokens"]):
            with self.subTest(args=bad_args):
                self.assert_bad_input(self.run_raw(bad_args))

        def assert_tokens_fail(code, stdout_text, detail=""):
            lines = stdout_text.strip().splitlines()
            self.assertEqual((code, len(lines)), (1, 1), detail or stdout_text)
            out = json.loads(lines[0])
            self.assertEqual((out["version"], out["ok"]), (1, False))
            self.assertTrue(isinstance(out.get("error"), str) and out["error"])
            self.assertNotIn("spaces", out)

        with self.subTest(case="hc ls error exits 1"):
            with open(self.state_path, "w", encoding="utf-8") as f:
                json.dump({"terminals": {}, "ls_reply": {"error": {"kind": "failed"}}}, f)
            proc = self.run_raw(["--coordinator-tokens"])
            assert_tokens_fail(proc.returncode, proc.stdout, proc.stdout + proc.stderr)

        with self.subTest(case="hc get error exits 1"):
            self.write_state({"t1": self.term("t1", "tb-1")})
            out_buf, err_buf, code = io.StringIO(), io.StringIO(), 0
            orig_hc = role_set.hc
            def fail_get(*args, **kw):
                if args and args[0] == "get":
                    return 1, {"error": {"kind": "io_error"}}, "boom"
                return orig_hc(*args, **kw)
            with contextlib.ExitStack() as stack:
                for ctx in (mock.patch.dict(os.environ, self.env, clear=True),
                            mock.patch.object(role_set, "hc", side_effect=fail_get),
                            contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf)):
                    stack.enter_context(ctx)
                try:
                    role_set.main(["--coordinator-tokens"])
                except SystemExit as exc:
                    code = exc.code if isinstance(exc.code, int) else 1
            assert_tokens_fail(code, out_buf.getvalue(), out_buf.getvalue() + err_buf.getvalue())

        with self.subTest(case="malformed hc ls terminal list exits 1"):
            for bad_reply in ({}, {"terminals": None}, {"terminals": "bad"}, {"terminals": ["t1"]}, {"terminals": [{}]}):
                with open(self.state_path, "w", encoding="utf-8") as f:
                    json.dump({"terminals": {}, "ls_reply": bad_reply}, f)
                proc = self.run_raw(["--coordinator-tokens"])
                assert_tokens_fail(proc.returncode, proc.stdout, proc.stdout + proc.stderr)

        with self.subTest(case="deadline exceeded exits 1"):
            self.write_state({"t1": self.term("t1", "tb-1")})
            out_buf, err_buf, code = io.StringIO(), io.StringIO(), 0
            with contextlib.ExitStack() as stack:
                for ctx in (mock.patch.dict(os.environ, self.env, clear=True),
                            mock.patch.object(role_set, "COORDINATOR_TOKENS_LIMIT_SECONDS", 0),
                            contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf)):
                    stack.enter_context(ctx)
                try:
                    role_set.main(["--coordinator-tokens"])
                except SystemExit as exc:
                    code = exc.code if isinstance(exc.code, int) else 1
            assert_tokens_fail(code, out_buf.getvalue(), out_buf.getvalue() + err_buf.getvalue())

        with self.subTest(case="deadline expiring during transcript scan fails without partial success"):
            # Write a fast first space and a >1024-line second transcript so the deadline expires inside the scan.
            self.write_claude_transcript(6300, "sess-fast", 50000, 0, 0)
            sdir = os.path.join(self.home, ".claude", "sessions")
            pdir = os.path.join(self.home, ".claude", "projects", "-work-demo")
            os.makedirs(sdir, exist_ok=True)
            os.makedirs(pdir, exist_ok=True)
            with open(os.path.join(sdir, "6301.json"), "w", encoding="utf-8") as f:
                json.dump({"pid": 6301, "sessionId": "sess-slow-scan", "cwd": self.work_cwd}, f)
            slow_path = os.path.join(pdir, "sess-slow-scan.jsonl")
            with open(slow_path, "w", encoding="utf-8") as f:
                row = json.dumps({"type": "assistant", "message": {"role": "assistant", "usage": {"input_tokens": 12345}}}) + "\n"
                for _ in range(1100):
                    f.write(row)
            t1 = self.term("t1", "tb-1", space="sp-a", app="claude-code", status_state="idle", role="coordinator", pid=6300, fg_name="claude")
            t2 = self.term("t2", "tb-1", space="sp-b", app="claude-code", status_state="idle", role="coordinator", pid=6301, fg_name="claude")
            self.write_state({"t1": t1, "t2": t2})

            now = [1000.0]
            real_open = open
            slow_real = os.path.realpath(slow_path)

            class AdvancingReader:
                def __init__(self, fp):
                    self._fp = fp

                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return self._fp.__exit__(*exc)

                def __iter__(self):
                    for line in self._fp:
                        yield line
                        now[0] = 1000.0 + role_set.COORDINATOR_TOKENS_LIMIT_SECONDS + 1.0

            def fake_open(file, *args, **kwargs):
                fp = real_open(file, *args, **kwargs)
                if isinstance(file, (str, os.PathLike)) and os.path.realpath(file) == slow_real:
                    return AdvancingReader(fp)
                return fp

            out_buf, err_buf, code = io.StringIO(), io.StringIO(), 0
            with contextlib.ExitStack() as stack:
                for ctx in (mock.patch.dict(os.environ, self.env, clear=True),
                            mock.patch.object(role_set, "open", side_effect=fake_open, create=True),
                            mock.patch.object(role_set.time, "monotonic", side_effect=lambda: now[0]),
                            contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf)):
                    stack.enter_context(ctx)
                try:
                    role_set.main(["--coordinator-tokens"])
                except SystemExit as exc:
                    code = exc.code if isinstance(exc.code, int) else 1
            assert_tokens_fail(code, out_buf.getvalue(), out_buf.getvalue() + err_buf.getvalue())

    def write_agy_transcript(self, agy_home, conv_id, rows):
        tdir = os.path.join(agy_home, "brain", conv_id, ".system_generated", "logs")
        os.makedirs(tdir, exist_ok=True)
        path = os.path.join(tdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        return path

    def write_proc_entry(self, proc_root, agy_home, pid, comm, *, ppid=1, lock_ids=(), children=None, extra_fds=()):
        pdir = os.path.join(proc_root, str(pid))
        fd_dir = os.path.join(pdir, "fd")
        os.makedirs(fd_dir, exist_ok=True)
        with open(os.path.join(pdir, "comm"), "w", encoding="utf-8") as f:
            f.write(comm + "\n")
        with open(os.path.join(pdir, "stat"), "w", encoding="utf-8") as f:
            f.write(f"{pid} ({comm}) S {ppid} {pid} {pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {pid * 10}\n")
        p_dir = os.path.join(agy_home, "presence")
        os.makedirs(p_dir, exist_ok=True)
        fd_num = 10
        for conv_id in lock_ids:
            lock_path = os.path.join(p_dir, f"{conv_id}.lock")
            with open(lock_path, "w", encoding="utf-8"):
                pass
            os.symlink(lock_path, os.path.join(fd_dir, str(fd_num)))
            fd_num += 1
        for target in extra_fds:
            os.symlink(target, os.path.join(fd_dir, str(fd_num)))
            fd_num += 1
        if children is not None:
            tdir = os.path.join(pdir, "task", str(pid))
            os.makedirs(tdir, exist_ok=True)
            with open(os.path.join(tdir, "children"), "w", encoding="utf-8") as f:
                f.write(" ".join(str(c) for c in children))

    def run_coordinator_tokens_inprocess(self, *patches):
        with open(self.log_path, "w", encoding="utf-8"):
            pass
        out, err, code = io.StringIO(), io.StringIO(), 0
        with contextlib.ExitStack() as stack:
            for ctx in (mock.patch.dict(os.environ, self.env, clear=True),
                        mock.patch.object(role_set.spawn, "STATE_DIR", self.state_dir),
                        mock.patch.object(role_set.spawn._common, "STATE_DIR", self.state_dir),
                        *patches, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err)):
                stack.enter_context(ctx)
            try:
                role_set.main(["--coordinator-tokens"])
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def test_agy_coordinator_with_single_presence_lock_counts_transcript(self):
        proc_root = os.path.join(self.root, "proc")
        agy_home = os.path.join(self.root, "agy-home")
        self.write_agy_transcript(agy_home, "conv-explicit", [
            {"type": "USER_INPUT", "status": "DONE", "content": "hi"},
            {"type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 1000, "cache_read_tokens": 5000},
            {"type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 2858, "cache_read_tokens": 234915, "output_tokens": 900},
            {"type": "PLANNER_RESPONSE", "status": "RUNNING", "input_tokens": 999, "cache_read_tokens": 1},
        ])
        self.write_agy_transcript(agy_home, "conv-fallback", [
            {"type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 0, "cache_read_tokens": 0},
        ])
        self.write_proc_entry(proc_root, agy_home, 7000, "bash", children=[7001])
        self.write_proc_entry(proc_root, agy_home, 7001, "agy", ppid=7000, lock_ids=("conv-explicit",))
        self.write_proc_entry(proc_root, agy_home, 7100, "bash", children=[7101])
        self.write_proc_entry(proc_root, agy_home, 7101, "agy", ppid=7100, lock_ids=("conv-fallback",))
        self.write_proc_entry(proc_root, agy_home, 7102, "python3", ppid=7101)

        exp = self.term("t81", "tb-agy-exp", space="sp-agy-explicit", app="antigravity", status_state="done",
                        role="coordinator", pid=7000, fg_pid=7001, fg_name="agy", where="exp / 2")
        fb = self.term("t82", "tb-agy-fb", space="sp-agy-fallback", app="antigravity", status_state="idle",
                       pid=7100, fg_pid=7102, fg_name="python3", where="proj / 1")
        self.write_state({"t81": exp, "t82": fb})

        code, out, err = self.run_coordinator_tokens_inprocess(
            mock.patch.object(role_set, "PROC_ROOT", proc_root),
            mock.patch.object(role_set, "AGY_HOME", agy_home),
        )
        self.assertEqual((code, json.loads(out.strip())), (0, {
            "version": 1,
            "ok": True,
            "spaces": {
                "sp-agy-explicit": 237773,
                "sp-agy-fallback": 0,
            },
        }), out + err)
        self.assert_no_mutation()

    def test_agy_coordinator_without_unique_presence_lock_returns_null(self):
        proc_root = os.path.join(self.root, "proc")
        agy_home = os.path.join(self.root, "agy-home")
        self.write_agy_transcript(agy_home, "conv-a", [
            {"type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 50000, "cache_read_tokens": 10000},
        ])
        self.write_agy_transcript(agy_home, "conv-b", [
            {"type": "PLANNER_RESPONSE", "status": "DONE", "input_tokens": 80000, "cache_read_tokens": 20000},
        ])
        other_lock = os.path.join(self.root, "conv-a.lock")
        with open(other_lock, "w", encoding="utf-8"):
            pass
        self.write_proc_entry(proc_root, agy_home, 1, "init", ppid=0)
        self.write_proc_entry(proc_root, agy_home, 7200, "bash", children=[7201])
        self.write_proc_entry(proc_root, agy_home, 7201, "agy", ppid=7200, extra_fds=(other_lock,))
        self.write_proc_entry(proc_root, agy_home, 7210, "bash", children=[7202])
        self.write_proc_entry(proc_root, agy_home, 7202, "agy", ppid=7210, lock_ids=("conv-a", "conv-b"))
        self.write_proc_entry(proc_root, agy_home, 7220, "bash", children=[7203])
        self.write_proc_entry(proc_root, agy_home, 7203, "agy", ppid=7220, lock_ids=("conv-missing",))
        self.write_proc_entry(proc_root, agy_home, 7240, "bash", children=[])
        self.write_proc_entry(proc_root, agy_home, 7999, "bash", children=[7241])
        self.write_proc_entry(proc_root, agy_home, 7241, "agy", ppid=7999, lock_ids=("conv-a",))

        self.write_state({
            "t91": self.term("t91", "tb-1", space="sp-no-lock", app="antigravity", status_state="idle",
                             role="coordinator", pid=7200, fg_pid=7201, fg_name="agy"),
            "t92": self.term("t92", "tb-1", space="sp-two-locks", app="antigravity", status_state="idle",
                             role="coordinator", pid=7210, fg_pid=7202, fg_name="agy"),
            "t93": self.term("t93", "tb-1", space="sp-no-transcript", app="antigravity", status_state="idle",
                             role="coordinator", pid=7220, fg_pid=7203, fg_name="agy"),
            "t95": self.term("t95", "tb-1", space="sp-foreign-fg", app="antigravity", status_state="idle",
                             role="coordinator", pid=7240, fg_pid=7241, fg_name="agy"),
        })
        code, out, err = self.run_coordinator_tokens_inprocess(
            mock.patch.object(role_set, "PROC_ROOT", proc_root),
            mock.patch.object(role_set, "AGY_HOME", agy_home),
        )
        self.assertEqual((code, json.loads(out.strip())), (0, {
            "version": 1,
            "ok": True,
            "spaces": {
                "sp-foreign-fg": None,
                "sp-no-lock": None,
                "sp-no-transcript": None,
                "sp-two-locks": None,
            },
        }), out + err)
        self.assert_no_mutation()

        with self.subTest(case="missing proc root gives null"):
            self.write_proc_entry(proc_root, agy_home, 7230, "bash", children=[7204])
            self.write_proc_entry(proc_root, agy_home, 7204, "agy", ppid=7230, lock_ids=("conv-a",))
            self.write_state({
                "t94": self.term("t94", "tb-1", space="sp-no-proc", app="antigravity", status_state="idle",
                                 role="coordinator", pid=7230, fg_pid=7204, fg_name="agy"),
            })
            code, out, err = self.run_coordinator_tokens_inprocess(
                mock.patch.object(role_set, "PROC_ROOT", os.path.join(self.root, "no-proc")),
                mock.patch.object(role_set, "AGY_HOME", agy_home),
            )
            self.assertEqual((code, json.loads(out.strip())), (0, {
                "version": 1,
                "ok": True,
                "spaces": {"sp-no-proc": None},
            }), out + err)
            self.assert_no_mutation()


if __name__ == "__main__":
    unittest.main()
