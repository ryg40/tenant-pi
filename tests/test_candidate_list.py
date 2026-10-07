"""Candidate list contract: state fields only, symlinks not entered, bounds, and determinism."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import candidate_list, tenant_pi
from scripts.candidate_list import child, report, safe_name, select
from scripts.profile_plan import prepare
from scripts.profile_write import write
from scripts.validate import Invalid, load

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
PIN = load(ROOT / "config/manifest.json")["runtime"]["piVersion"]
CANARY = "CANARY_SECRET"
A = "a" * 40
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", "os.scandir", "os.listdir", *PROCESS_EVENTS):
        EVENTS.append((event, args[0]))


sys.addaudithook(_audit)


def dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def state(**provenance):
    record = {"kitSchemaVersion": 1, "piVersion": PIN, "nodeRange": ">=24.0.0 <25", "enabled": ["core"],
              "pins": {}, "outputs": [], **provenance}
    return {"schemaVersion": 1, "status": "complete", "provenance": record}


class PureListTests(unittest.TestCase):
    def test_candidate_row_fields(self):
        row = child("candidate 2026-10-02", "dir", state(generatedAt="2026-10-02T08:00:00Z", kitCommit=A))
        self.assertEqual({"name": "candidate 2026-10-02", "status": "candidate", "kitSchemaVersion": 1, "piVersion": PIN,
                          "filesComplete": True, "generatedAt": "2026-10-02T08:00:00Z", "kitCommit": A, "unsupported": []}, row)
        incomplete = state(kitCommit="unknown")
        incomplete["status"] = "incomplete"
        self.assertEqual((False, "unknown", None), tuple(child("c", "dir", incomplete)[k] for k in ("filesComplete", "kitCommit", "generatedAt")))

    def test_older_state_without_new_fields(self):
        self.assertEqual({"name": "old", "status": "candidate", "kitSchemaVersion": 1, "piVersion": PIN,
                          "filesComplete": True, "generatedAt": None, "kitCommit": None, "unsupported": []},
                         child("old", "dir", state()))
        self.assertEqual({"name": "bare", "status": "candidate", **dict.fromkeys(candidate_list.FIELDS), "unsupported": []},
                         child("bare", "dir", {"schemaVersion": 1}))

    def test_hostile_values_are_not_echoed(self):
        hostile = state(generatedAt=CANARY, kitCommit=CANARY, piVersion="1.0.0-" + CANARY, kitSchemaVersion=[CANARY])
        hostile["status"] = CANARY
        row = child("c", "dir", hostile)
        self.assertEqual(["filesComplete", "generatedAt", "kitCommit", "kitSchemaVersion", "piVersion"], row["unsupported"])
        self.assertEqual([None] * 5, [row[k] for k in candidate_list.FIELDS])
        self.assertNotIn(CANARY, dump(row))
        for value in ("2026-13-01T00:00:00Z", "2026-10-02T08:00:00+00:00", "2026-10-02T08:00:00.5Z", "2026-10-02 08:00:00Z",
                      "2026-10-02T08:00:00Z\n", 20261002):
            self.assertEqual(["generatedAt"], child("c", "dir", state(generatedAt=value))["unsupported"])
        self.assertEqual(["provenance"], child("c", "dir", {"schemaVersion": 1, "provenance": [CANARY]})["unsupported"])

    def test_status_rows(self):
        self.assertEqual({"name": "u", "status": "unmanaged"}, child("u", "dir"))
        self.assertEqual({"name": "s", "status": "symlink"}, child("s", "symlink", state()))
        self.assertEqual({"name": "x", "status": "invalid", "reason": "input_not_regular"}, child("x", "dir", error="input_not_regular"))
        self.assertEqual({"name": "x", "status": "invalid", "reason": "read_or_json"}, child("x", "dir", error=CANARY))
        # Each rule of the input loader has the public rule form. A rule outside it would show as `read_or_json`.
        for rule in ("input_missing", "input_unreadable", "input_path_unsafe", "input_path", "input_not_regular",
                     "input_too_large", "input_encoding", "invalid_json", "input_too_deep", "number", "duplicate_key"):
            self.assertEqual(rule, child("x", "dir", error=rule)["reason"])
        self.assertEqual("read_or_json", child("x", "dir", error="input_not_utf8")["reason"])
        self.assertEqual({"name": "x", "status": "invalid", "reason": "unsupported_shape"}, child("x", "dir", [CANARY]))
        for bad in ({"schemaVersion": 2}, {}, {"schemaVersion": "1"}, {"schemaVersion": True}):
            self.assertEqual("unsupported_schema_version", child("x", "dir", bad)["reason"])
        with self.assertRaises(Invalid):
            child("f", "file")

    def test_names(self):
        for name in ("candidate 2026-10-02", "a", "it's", "x" * 255, ".hidden", "-dash", "+plus", "!bang"):
            with self.subTest(name=name):
                self.assertEqual(name in ("candidate 2026-10-02", "a", "it's", "x" * 255, ".hidden", "-dash"), safe_name(name))
        for name in ("x" * 256, " lead", "trail ", "a$b", "a`b", "a\nb", "a\tb", "café", "a\udcffb", "..", ".", "", None):
            with self.subTest(name=name):
                self.assertFalse(safe_name(name))
                if name:
                    self.assertEqual({"name": None, "status": "unsupported_name"}, child(name, "dir", state()))

    def test_select_report_order_and_bound(self):
        entries = [("b", "dir"), ("a", "symlink"), ("f", "file"), ("p", "other"), ("c", "dir")]
        self.assertEqual(([("a", "symlink"), ("b", "dir"), ("c", "dir")], 0, 2), select(entries))
        self.assertEqual(select(entries), select(list(reversed(entries))))
        with patch.object(candidate_list, "MAX_CHILDREN", 2):
            self.assertEqual(([("a", "symlink"), ("b", "dir")], 1, 2), select(entries))
        rows = [child("b", "dir"), child("a$", "dir"), child("a", "symlink")]
        result = report("/p", rows, 1, 2, [])
        self.assertEqual([{"name": "a", "status": "symlink"}, {"name": "b", "status": "unmanaged"},
                          {"name": None, "status": "unsupported_name"}], result["children"])
        self.assertEqual({"candidate": 0, "unmanaged": 1, "symlink": 1, "invalid": 0, "unsupported_name": 1,
                          "children": 3, "omitted": 1, "notDirectory": 2}, result["summary"])
        self.assertEqual(["child_limit: list.parent"], result["diagnostics"])
        self.assertEqual(dump(result), dump(report("/p", list(reversed(rows)), 1, 2, [])))
        for entries, rule in (("x", "array: list.entries"), ([("a", "link")], "entry: list.entries"),
                              ([("", "dir")], "entry: list.entries"), ([("a", "dir"), ("a", "file")], "duplicate_entry: list.entries")):
            with self.assertRaises(Invalid) as caught:
                select(entries)
            self.assertEqual(rule, str(caught.exception))


class ParentDirectoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-list-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.parent = self.base / "candidates"
        self.parent.mkdir(mode=0o700)
        self.outside = self.base / "outside"
        self.outside.mkdir()

    def generate(self, name, commit="unknown"):
        target = self.parent / name
        overlay = load(ROOT / "config/config.example.json")
        overlay["target"]["agentDir"] = str(target)
        write(prepare(load(ROOT / "config/manifest.json"), overlay), str(target),
              clock=lambda: datetime(2026, 10, 2, 8, 0, 0, tzinfo=timezone.utc), kit_commit=commit)
        return target

    def read(self, parent=None):
        return tenant_pi._list(str(self.parent if parent is None else parent))

    def rule(self, parent):
        with self.assertRaises(Invalid) as caught:
            self.read(parent)
        return str(caught.exception)

    def test_two_candidates_one_unmanaged_and_a_symlink_not_entered(self):
        first = self.generate("candidate 2026-10-01", A)
        self.generate("candidate 2026-10-02")
        unmanaged = self.parent / "live copy"
        unmanaged.mkdir()
        for private in ("settings.json", "auth.json", "models.json", "mcp.json"):
            (unmanaged / private).write_text(CANARY)
            if private != "settings.json":
                (first / private).write_text(CANARY)
        (unmanaged / "sessions").mkdir()
        (unmanaged / "sessions" / "s.jsonl").write_text(CANARY)
        (self.parent / "linked").symlink_to(first, target_is_directory=True)
        (self.parent / "note.txt").write_text(CANARY)
        del EVENTS[:]
        RECORDING.append(True)
        try:
            result = self.read()
            again = self.read()
        finally:
            del RECORDING[:]
        self.assertEqual(dump(result), dump(again))
        common = {"status": "candidate", "kitSchemaVersion": 1, "piVersion": PIN, "filesComplete": True,
                  "generatedAt": "2026-10-02T08:00:00Z", "unsupported": []}
        self.assertEqual([{"name": "candidate 2026-10-01", **common, "kitCommit": A},
                          {"name": "candidate 2026-10-02", **common, "kitCommit": "unknown"},
                          {"name": "linked", "status": "symlink"}, {"name": "live copy", "status": "unmanaged"}],
                         result["children"])
        self.assertEqual({"candidate": 2, "unmanaged": 1, "symlink": 1, "invalid": 0, "unsupported_name": 0,
                          "children": 4, "omitted": 0, "notDirectory": 1}, result["summary"])
        self.assertEqual((str(self.parent), []), (result["parent"], result["diagnostics"]))
        self.assertNotIn(CANARY, dump(result))
        self.assertEqual([], [event for event, _ in EVENTS if event in PROCESS_EVENTS])
        # The parent is listed by descriptor; per child only the ancestors, `.tenant-pi` and `state.json` open.
        opened = [arg for event, arg in EVENTS if event == "open" and type(arg) is str]
        self.assertEqual(set(), set(opened) - {"/", *self.parent.parts[1:], "candidate 2026-10-01", "candidate 2026-10-02",
                                               "live copy", ".tenant-pi", "state.json"}, opened)
        self.assertNotIn("linked", opened)
        self.assertEqual(4, opened.count("state.json"))
        listed = [arg for event, arg in EVENTS if event in ("os.scandir", "os.listdir")]
        self.assertEqual(2, len(listed))
        self.assertTrue(all(type(arg) is int for arg in listed), listed)

    def test_invalid_state_files_report_static_reasons(self):
        for name, setup, reason in (
                ("bad json", lambda m: (m / "state.json").write_text('{"x": "' + CANARY), "invalid_json"),
                ("duplicate", lambda m: (m / "state.json").write_text('{"a": 1, "a": 2}'), "duplicate_key"),
                ("not utf", lambda m: (m / "state.json").write_bytes(b'{"x": "\xff"}'), "input_encoding"),
                ("deep", lambda m: (m / "state.json").write_bytes(b"[" * 65 + b"]" * 65), "input_too_deep"),
                ("linked state", lambda m: (m / "state.json").symlink_to(self.outside / "s.json"), "input_not_regular"),
                ("state dir", lambda m: (m / "state.json").mkdir(), "input_not_regular"),
                ("large", lambda m: (m / "state.json").write_bytes(b" " * (tenant_pi.MAX_INPUT + 1)), "input_too_large"),
                ("schema two", lambda m: (m / "state.json").write_text('{"schemaVersion": 2}'), "unsupported_schema_version"),
                ("array", lambda m: (m / "state.json").write_text('["' + CANARY + '"]'), "unsupported_shape")):
            meta = self.parent / name / ".tenant-pi"
            meta.mkdir(parents=True)
            setup(meta)
        (self.outside / "s.json").write_text('{"schemaVersion": 1}')
        (self.parent / "meta file").mkdir()
        (self.parent / "meta file" / ".tenant-pi").write_text(CANARY)
        (self.parent / "meta link").mkdir()
        (self.parent / "meta link" / ".tenant-pi").symlink_to(self.outside, target_is_directory=True)
        (self.parent / "no meta").mkdir()
        (self.parent / "empty meta" / ".tenant-pi").mkdir(parents=True)
        rows = {row["name"]: row for row in self.read()["children"]}
        self.assertEqual({"bad json": "invalid_json", "duplicate": "duplicate_key", "linked state": "input_not_regular",
                          "not utf": "input_encoding", "deep": "input_too_deep",
                          "state dir": "input_not_regular", "large": "input_too_large",
                          "schema two": "unsupported_schema_version", "array": "unsupported_shape",
                          "meta file": "input_path_unsafe", "meta link": "input_path_unsafe"},
                         {name: row["reason"] for name, row in rows.items() if row["status"] == "invalid"})
        self.assertEqual({"unmanaged"}, {rows["no meta"]["status"], rows["empty meta"]["status"]})
        self.assertNotIn(CANARY, dump(rows))
        # A row holds the rule only: the place of a syntax error stays out of the list.
        self.assertEqual({"name": "bad json", "status": "invalid", "reason": "invalid_json"}, rows["bad json"])

    def test_unsupported_names_are_not_entered(self):
        hostile = "x$" + CANARY
        (self.parent / hostile / ".tenant-pi").mkdir(parents=True)
        (self.parent / hostile / ".tenant-pi" / "state.json").write_text(json.dumps(state()))
        (self.parent / " lead").mkdir()
        del EVENTS[:]
        RECORDING.append(True)
        try:
            result = self.read()
        finally:
            del RECORDING[:]
        self.assertEqual([{"name": None, "status": "unsupported_name"}] * 2, result["children"])
        self.assertNotIn(CANARY, dump(result))
        self.assertFalse({hostile, " lead"} & {arg for event, arg in EVENTS if event == "open"})

    def test_parent_boundaries(self):
        self.assertEqual("absolute_path: list.parent", self.rule("relative/dir"))
        self.assertEqual("absolute_path: list.parent", self.rule(str(self.parent) + "/../candidates"))
        self.assertEqual("absolute_path: list.parent", self.rule(str(self.parent) + "/"))
        self.assertEqual("absolute_path: list.parent", self.rule("/"))
        self.assertEqual("parent_missing: list.parent", self.rule(self.base / "absent"))
        (self.base / "linked").symlink_to(self.parent, target_is_directory=True)
        self.assertEqual("read_or_json: list.parent", self.rule(self.base / "linked"))
        (self.base / "file").write_text(CANARY)
        self.assertEqual("read_or_json: list.parent", self.rule(self.base / "file"))
        self.assertEqual({"children": 0, "omitted": 0}, {k: self.read()["summary"][k] for k in ("children", "omitted")})

    def test_entry_and_child_bounds(self):
        for index in range(3):
            (self.parent / f"c{index}").mkdir()
        (self.parent / "f").write_text("")
        with patch.object(tenant_pi, "MAX_ENTRIES", 3):
            self.assertEqual("input_too_large: list.parent", self.rule(self.parent))
        with patch.object(tenant_pi, "MAX_ENTRIES", 4), patch.object(candidate_list, "MAX_CHILDREN", 2):
            result = self.read()
        self.assertEqual(["c0", "c1"], [row["name"] for row in result["children"]])
        self.assertEqual((1, 1, ["child_limit: list.parent"]),
                         (result["summary"]["omitted"], result["summary"]["notDirectory"], result["diagnostics"]))

    def test_cleanup_failure_is_a_diagnostic_not_a_lost_report(self):
        (self.parent / "u").mkdir()
        real_open_dir, real_close, held = tenant_pi._open_dir, os.close, []

        def open_dir(path):
            fd = real_open_dir(path)
            held.append(fd)
            return fd

        def close(fd):
            if fd in held:
                held.remove(fd)
                real_close(fd)
                raise OSError("close failed")
            real_close(fd)

        with patch.object(tenant_pi, "_open_dir", open_dir), patch.object(os, "close", close):
            result = self.read()
        self.assertEqual(["cleanup_failed: list.parent"], result["diagnostics"])
        self.assertEqual([{"name": "u", "status": "unmanaged"}], result["children"])


class ListCliTests(unittest.TestCase):
    def test_cli_output_is_deterministic_and_starts_no_process(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-list-cli-") as temp:
            base = Path(temp).resolve()
            parent = base / "candidates"
            (parent / "plain").mkdir(parents=True)
            (parent / "linked").symlink_to(base, target_is_directory=True)
            generated = parent / "generated"
            overlay = load(ROOT / "config/config.example.json")
            overlay["target"]["agentDir"] = str(generated)
            write(prepare(load(ROOT / "config/manifest.json"), overlay), str(generated),
                  clock=lambda: datetime(2026, 10, 2, 8, 0, 0, tzinfo=timezone.utc), kit_commit=A)
            hook = base / "sitecustomize.py"
            hook.write_text("import sys\nsys.dont_write_bytecode = True\nimport socket, subprocess\n"
                            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                            "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
            env = dict(os.environ, HOME=str(base), PYTHONPATH=str(base), PYTHONDONTWRITEBYTECODE="1")
            runs = [subprocess.run([sys.executable, str(CLI), "list", "--parent", str(parent)], cwd=base, env=env,
                                   text=True, capture_output=True, check=False) for _ in range(2)]
            self.assertEqual([0, 0], [run.returncode for run in runs], runs[0].stderr)
            self.assertEqual(runs[0].stdout, runs[1].stdout)
            result = json.loads(runs[0].stdout)
            self.assertEqual(runs[0].stdout.strip(), dump(result))
            self.assertEqual([{"name": "generated", "status": "candidate", "kitSchemaVersion": 1, "piVersion": PIN,
                               "filesComplete": True, "generatedAt": "2026-10-02T08:00:00Z", "kitCommit": A, "unsupported": []},
                              {"name": "linked", "status": "symlink"}, {"name": "plain", "status": "unmanaged"}], result["children"])
            failed = subprocess.run([sys.executable, str(CLI), "list", "--parent", "relative"], cwd=base, env=env,
                                    text=True, capture_output=True, check=False)
            self.assertEqual((2, ""), (failed.returncode, failed.stdout))
            self.assertEqual({"error": "absolute_path: list.parent", "candidate_created": False}, json.loads(failed.stderr))
            help_text = subprocess.run([sys.executable, str(CLI), "--help"], cwd=base, env=env, text=True,
                                       capture_output=True, check=False).stdout
            self.assertIn("list", help_text)


if __name__ == "__main__":
    unittest.main()
