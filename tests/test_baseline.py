"""Directory baseline: names, sizes and times only, each result, every refusal, and the guide commands."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts import baseline, tenant_pi
from scripts.baseline import MAX_PATH, check_location, compare, encode, record, saved_record, scan, write
from scripts.profile_write import WriteError
from scripts.validate import Invalid

ROOT = Path(__file__).resolve().parents[1]
CANARY = "CANARY_SECRET"
AT = "2026-10-05T12:00:00Z"
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", "os.scandir", "os.listdir", *PROCESS_EVENTS):
        EVENTS.append((event, args))


sys.addaudithook(_audit)


def clock():
    return datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def snapshot(root):
    """Every entry below `root` with its kind, size, times and bytes: the proof that a run changed nothing."""
    found = {".": (os.lstat(root).st_mode, os.lstat(root).st_mtime_ns)}
    for path in sorted(root.rglob("*")):
        info = os.lstat(path)
        content = path.read_bytes() if stat.S_ISREG(info.st_mode) else None
        found[str(path.relative_to(root))] = (info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, content)
    return found


def row(name, kind="file", size=1, mtime=10, **below):
    return {"name": name, "kind": kind, "size": size, "mtimeNs": mtime,
            **({"entries": 0, "digest": "0" * 64, **below} if kind == "dir" else {})}


def state(*rows, mtime=5):
    return {"mtimeNs": mtime, "entries": list(rows)}


class PureTests(unittest.TestCase):
    def rule(self, call):
        with self.assertRaises(Invalid) as caught:
            call()
        self.assertNotIn(CANARY, str(caught.exception))
        return str(caught.exception)

    def test_record_of_a_present_and_an_absent_directory(self):
        value = record("/home/example/.pi/agent", AT, state(row("b"), row("a", "dir", 3, 7, entries=2)))
        self.assertEqual({"schemaVersion": 1, "dir": "/home/example/.pi/agent", "recordedAt": AT, "present": True,
                          "mtimeNs": 5, "entries": [row("a", "dir", 3, 7, entries=2), row("b")]}, value)
        absent = record("/home/example/.pi/agent", AT, None)
        self.assertEqual((False, None, []), (absent["present"], absent["mtimeNs"], absent["entries"]))
        # Sorted keys, fixed separators, one line: the same state gives the same bytes.
        self.assertEqual(encode(value), encode(json.loads(encode(value))))
        self.assertTrue(encode(value).endswith(b"}\n"))
        self.assertEqual(1, encode(value).count(b"\n"))

    def test_record_refuses_a_bad_path_time_or_row(self):
        self.assertEqual("absolute_path: baseline.dir", self.rule(lambda: record("relative", AT, None)))
        self.assertEqual("absolute_path: baseline.dir", self.rule(lambda: record("/a/../b", AT, None)))
        for bad_time in ("2026-10-05", "2026-10-05T12:00:00+00:00", "", None, 7):
            with self.subTest(time=bad_time):
                self.assertEqual("baseline_record: baseline.dir", self.rule(lambda: record("/a", bad_time, None)))
        for bad in (row(""), row("a/b"), row("."), row(".."), row("a\x00b"), row("a", "link"), row("a", size=-1),
                    row("a", size=True), row("a", mtime="1"), {**row("a"), "content": CANARY},
                    row("a", "dir", digest=CANARY), row("a", "dir", entries=-1), {**row("a"), "digest": "0" * 64}):
            with self.subTest(row=repr(bad)[:50]):
                self.assertEqual("baseline_record: baseline.dir", self.rule(lambda: record("/a", AT, state(bad))))
        self.assertEqual("baseline_record: baseline.dir",
                         self.rule(lambda: record("/a", AT, state(row("a"), row("a", "dir")))))

    def test_unchanged(self):
        rows = (row("auth.json"), row("sessions", "dir", 9, 4, entries=3))
        saved = record("/a", AT, state(*rows))
        result = compare(saved, "/a", state(*reversed(rows)))
        self.assertEqual({"dir": "/a", "result": "unchanged", "recordedAt": AT, "was": "present", "now": "present",
                          "added": [], "removed": [], "modified": [], "directoryModified": False,
                          "scope": baseline.SCOPE}, result)

    def test_changed_names_each_direct_entry_one_time(self):
        saved = record("/a", AT, state(row("kept"), row("gone"), row("size"), row("time"), row("kind"),
                                         row("deep", "dir", 4, 2, entries=2, digest="a" * 64),
                                         row("count", "dir", 4, 2, entries=2)))
        now = state(row("kept"), row("new"), row("size", size=2), row("time", mtime=11), row("kind", "symlink"),
                    row("deep", "dir", 4, 2, entries=2, digest="b" * 64), row("count", "dir", 4, 2, entries=3))
        result = compare(saved, "/a", now)
        self.assertEqual(("changed", ["new"], ["gone"], ["count", "deep", "kind", "size", "time"], False),
                         (result["result"], result["added"], result["removed"], result["modified"],
                          result["directoryModified"]))

    def test_changed_when_only_the_directory_itself_was_modified(self):
        # An entry was made and removed again, for example a lock file: no entry differs now.
        saved = record("/a", AT, state(row("settings.json"), mtime=5))
        result = compare(saved, "/a", state(row("settings.json"), mtime=6))
        self.assertEqual(("changed", [], [], [], True), (result["result"], result["added"], result["removed"],
                                                         result["modified"], result["directoryModified"]))

    def test_absent_before_and_after_is_unchanged_and_a_new_directory_is_changed(self):
        saved = record("/a", AT, None)
        still = compare(saved, "/a", None)
        self.assertEqual(("unchanged", "absent", "absent"), (still["result"], still["was"], still["now"]))
        made = compare(saved, "/a", state(row("settings.json"), row("sessions", "dir")))
        self.assertEqual(("changed", "absent", "present", ["sessions", "settings.json"], False),
                         (made["result"], made["was"], made["now"], made["added"], made["directoryModified"]))
        gone = compare(record("/a", AT, state(row("x"))), "/a", None)
        self.assertEqual(("changed", "present", "absent", ["x"]), (gone["result"], gone["was"], gone["now"], gone["removed"]))

    def test_no_baseline(self):
        result = compare(None, "/a", None)
        self.assertEqual(("no_baseline", None, None, None), (result["result"], result["recordedAt"], result["was"], result["now"]))
        self.assertEqual(([], [], [], False), (result["added"], result["removed"], result["modified"], result["directoryModified"]))
        self.assertEqual(set(compare(record("/a", AT, None), "/a", None)), set(result))
        self.assertEqual({"unchanged", "changed", "no_baseline"}, set(baseline.RESULTS))

    def test_a_saved_record_of_another_shape_or_directory_is_refused(self):
        good = record("/a", AT, state(row("x"), row("d", "dir")))
        self.assertIs(good, saved_record(good, "/a"))
        self.assertEqual("baseline_dir: check-baseline.dir", self.rule(lambda: saved_record(good, "/b")))
        self.assertEqual("baseline_dir: check-baseline.dir", self.rule(lambda: compare(good, "/a/", None)))
        for bad in ([], CANARY, 7, {}, {**good, "schemaVersion": 2}, {**good, "schemaVersion": True},
                    {**good, "extra": CANARY}, {key: good[key] for key in good if key != "mtimeNs"},
                    {**good, "dir": [CANARY]}, {**good, "recordedAt": CANARY}, {**good, "present": "yes"},
                    {**good, "mtimeNs": None}, {**good, "mtimeNs": "5"}, {**good, "entries": CANARY},
                    {**good, "entries": [CANARY]}, {**good, "entries": [row("x"), row("x")]},
                    {**good, "entries": [{**row("x"), "kind": [CANARY]}]},
                    {**good, "present": False}, {**good, "present": False, "mtimeNs": None},
                    {**good, "entries": [row(str(index)) for index in range(baseline.MAX_ENTRIES + 1)]}):
            with self.subTest(saved=repr(bad)[:60]):
                self.assertEqual("baseline_record: check-baseline.baseline", self.rule(lambda: compare(bad, "/a", None)))

    def test_location_rules(self):
        roots = [("under_kit", "/k/kit"), ("under_pi_agent", "/h/.pi/agent"), ("under_dir", "/h/live")]
        for path, rule in (("relative.json", "absolute_path"), ("/a/../b.json", "absolute_path"),
                           ("/a/b/", "absolute_path"), ("/a/$HOME.json", "shell_or_template"), ("", "text"),
                           ("/" + "a" * MAX_PATH, "path_too_long"), ("/k/kit/.local/b.json", "under_kit"),
                           ("/h/.pi/agent/b.json", "under_pi_agent"), ("/h/live", "under_dir"),
                           ("/h/live/sessions/b.json", "under_dir")):
            with self.subTest(path=path[:40]):
                self.assertEqual(rule + ": baseline.out", self.rule(lambda: check_location(path, roots)))
        # A name that only starts with the text of a root is outside it.
        check_location("/h/live-baseline.json", roots)


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-baseline-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.home = self.base / "home"
        self.live = self.home / ".pi" / "agent"
        self.live.mkdir(parents=True, mode=0o700)
        self.private = self.home / "private dir"
        self.private.mkdir(mode=0o700)
        self.out = self.private / "live-baseline.json"
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "target.txt").write_text(CANARY)

    def populate(self):
        (self.live / "auth.json").write_text('{"token": "' + CANARY + '"}')
        (self.live / "settings.json").write_text("{}")
        (self.live / "sessions" / "--work--").mkdir(parents=True)
        (self.live / "sessions" / "--work--" / "one.jsonl").write_text(CANARY)
        (self.live / "skills").mkdir()
        (self.live / "skills" / "linked").symlink_to(self.outside, target_is_directory=True)
        (self.live / "dangling").symlink_to(self.base / ("absent-" + CANARY))
        os.mkfifo(self.live / "pipe")

    def scan(self, directory=None):
        fd = tenant_pi._open_dir(str(self.live if directory is None else directory))
        try:
            return scan(fd)
        finally:
            os.close(fd)

    def rows(self):
        return {item["name"]: item for item in self.scan()["entries"]}


class ScanTests(Fixture):
    def test_rows_hold_names_kinds_sizes_and_times_only(self):
        self.populate()
        found = self.scan()
        rows = {item["name"]: item for item in found["entries"]}
        self.assertEqual(["auth.json", "dangling", "pipe", "sessions", "settings.json", "skills"],
                         [item["name"] for item in found["entries"]])
        self.assertEqual({"auth.json": "file", "dangling": "symlink", "pipe": "other", "sessions": "dir",
                          "settings.json": "file", "skills": "dir"}, {name: item["kind"] for name, item in rows.items()})
        self.assertEqual(os.lstat(self.live).st_mtime_ns, found["mtimeNs"])
        info = os.lstat(self.live / "auth.json")
        self.assertEqual({"name": "auth.json", "kind": "file", "size": info.st_size, "mtimeNs": info.st_mtime_ns},
                         rows["auth.json"])
        self.assertEqual({"name", "kind", "size", "mtimeNs", "entries", "digest"}, set(rows["sessions"]))
        # `sessions` holds one directory and one file; the size is the size of the file.
        self.assertEqual((2, len(CANARY), os.lstat(self.live / "sessions").st_mtime_ns),
                         (rows["sessions"]["entries"], rows["sessions"]["size"], rows["sessions"]["mtimeNs"]))
        # A link counts as one entry with the size of the link itself; nothing behind it is listed.
        self.assertEqual((1, os.lstat(self.live / "skills" / "linked").st_size),
                         (rows["skills"]["entries"], rows["skills"]["size"]))
        text = encode(record(str(self.live), AT, found)).decode("ascii")
        for hidden in (CANARY, "token", "target.txt", "outside", "one.jsonl", "--work--"):
            self.assertNotIn(hidden, text)
        self.assertEqual(found, self.scan())

    def test_only_directories_are_opened_and_nothing_is_followed(self):
        self.populate()
        del EVENTS[:]
        RECORDING.append(True)
        try:
            self.scan()
        finally:
            del RECORDING[:]
        opened = [args for event, args in EVENTS if event == "open"]
        # Each open is a directory open that follows no link: no file can be read.
        self.assertTrue(opened)
        for path, _, flags in opened:
            self.assertEqual(os.O_DIRECTORY | os.O_NOFOLLOW, flags & (os.O_DIRECTORY | os.O_NOFOLLOW), path)
            self.assertEqual(0, flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT), path)
        names = {path for path, _, _ in opened}
        self.assertEqual(set(), {"auth.json", "settings.json", "one.jsonl", "linked", "dangling", "pipe"} & names)
        self.assertLessEqual({"sessions", "--work--", "skills"}, names)
        self.assertEqual([], [event for event, _ in EVENTS if event in PROCESS_EVENTS])
        # Every listing uses a descriptor, not a path.
        self.assertTrue(all(type(args[0]) is int for event, args in EVENTS if event in ("os.scandir", "os.listdir")))

    def test_a_change_at_any_level_changes_the_row_of_its_direct_entry(self):
        self.populate()
        deep = self.live / "sessions" / "--work--" / "one.jsonl"
        before = self.rows()
        with open(deep, "a") as stream:
            stream.write("more")
        after = self.rows()
        self.assertNotEqual(before["sessions"]["digest"], after["sessions"]["digest"])
        self.assertEqual(before["sessions"]["size"] + 4, after["sessions"]["size"])
        self.assertEqual({name: item for name, item in before.items() if name != "sessions"},
                         {name: item for name, item in after.items() if name != "sessions"})
        # The same size with another modification time.
        info = os.lstat(deep)
        os.utime(deep, ns=(info.st_atime_ns, info.st_mtime_ns + 1))
        timed = self.rows()
        self.assertNotEqual(after["sessions"]["digest"], timed["sessions"]["digest"])
        self.assertEqual(after["sessions"]["size"], timed["sessions"]["size"])
        # A new entry two levels down, and a rename.
        (self.live / "sessions" / "--work--" / "two.jsonl").write_text("")
        added = self.rows()
        self.assertEqual(timed["sessions"]["entries"] + 1, added["sessions"]["entries"])
        (self.live / "sessions" / "--work--" / "two.jsonl").rename(self.live / "sessions" / "--work--" / "2.jsonl")
        self.assertNotEqual(added["sessions"]["digest"], self.rows()["sessions"]["digest"])

    def test_a_change_behind_a_link_is_outside_the_directory(self):
        self.populate()
        before = self.rows()
        (self.outside / "target.txt").write_text(CANARY * 2)
        (self.outside / "new.txt").write_text("")
        self.assertEqual(before, self.rows())

    def test_an_entry_that_goes_away_during_the_walk_is_left_out(self):
        self.populate()
        real_stat, real_open = os.stat, os.open

        def stat_gone(path, *args, **kwargs):
            if path == "auth.json":
                raise FileNotFoundError(CANARY)
            return real_stat(path, *args, **kwargs)

        def open_gone(path, *args, **kwargs):
            if path == "sessions":
                raise FileNotFoundError(CANARY)
            return real_open(path, *args, **kwargs)

        with patch.object(baseline.os, "stat", stat_gone):
            self.assertNotIn("auth.json", self.rows())
        with patch.object(baseline.os, "open", open_gone):
            self.assertEqual(0, self.rows()["sessions"]["entries"])

    def test_bounds(self):
        (self.live / "a" / "b" / "c").mkdir(parents=True)
        (self.live / "z").write_text("")

        def rule():
            with self.assertRaises(Invalid) as caught:
                self.scan()
            return str(caught.exception)

        for name, low, exact in (("MAX_ENTRIES", 1, 2), ("MAX_TREE", 3, 4), ("MAX_LEVELS", 2, 3)):
            with self.subTest(bound=name):
                with patch.object(baseline, name, low):
                    self.assertEqual("input_too_large: baseline.dir", rule())
                # Exactly the bound passes.
                with patch.object(baseline, name, exact):
                    self.assertEqual(2, len(self.scan()["entries"]))
        # No descriptor of a lower directory stays open after a refusal.
        opened = []
        real_open = os.open

        def recording(path, *args, **kwargs):
            opened.append(real_open(path, *args, **kwargs))
            return opened[-1]

        with patch.object(baseline, "MAX_TREE", 3), patch.object(baseline.os, "open", recording):
            self.assertEqual("input_too_large: baseline.dir", rule())
        self.assertTrue(opened)
        for fd in opened[len(self.live.parts):]:
            with self.assertRaises(OSError):
                os.fstat(fd)


class WriteTests(Fixture):
    def rejected(self, rule, field, call, *, created=False):
        with self.assertRaises((Invalid, WriteError)) as caught:
            call()
        self.assertEqual(f"{rule}: {field}", str(caught.exception))
        self.assertEqual(created, getattr(caught.exception, "candidate_created", False))
        self.assertNotIn(str(self.base), str(caught.exception))

    def test_write_creates_mode_0600_and_never_replaces(self):
        old = os.umask(0)
        try:
            result = write(str(self.out), b"first\n")
        finally:
            os.umask(old)
        self.assertEqual((str(self.out), True, ()), (result.path, result.complete, result.warnings))
        info = os.lstat(self.out)
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual(0o600, stat.S_IMODE(info.st_mode))
        self.rejected("target_exists", "baseline.out", lambda: write(str(self.out), b"second\n"))
        self.rejected("target_exists", "baseline.out", lambda: baseline.preflight(str(self.out)))
        self.assertEqual(b"first\n", self.out.read_bytes())

    def test_each_existing_entry_and_each_unsafe_parent_is_refused(self):
        for make in (lambda p: p.mkdir(), lambda p: p.symlink_to(self.outside / "target.txt"),
                     lambda p: p.symlink_to(self.base / "absent"), lambda p: os.mkfifo(p)):
            path = self.private / "entry"
            make(path)
            self.rejected("target_exists", "baseline.out", lambda: write(str(path), b"x"))
            path.rmdir() if path.is_dir() and not path.is_symlink() else path.unlink()
        self.rejected("parent_missing", "baseline.out.parent", lambda: write(str(self.private / "no" / "b.json"), b"x"))
        (self.base / "linked").symlink_to(self.private, target_is_directory=True)
        self.rejected("unsafe_path", "baseline.out.parents", lambda: write(str(self.base / "linked" / "b.json"), b"x"))
        (self.private / "file").write_text("")
        self.rejected("unsafe_path", "baseline.out.parents", lambda: write(str(self.private / "file" / "b.json"), b"x"))
        open_dir = self.base / "open"
        open_dir.mkdir()
        open_dir.chmod(0o777)
        self.rejected("unsafe_permissions", "baseline.out.parents", lambda: write(str(open_dir / "b.json"), b"x"))
        self.assertEqual(["file"], sorted(p.name for p in self.private.iterdir()))
        self.assertEqual(CANARY, (self.outside / "target.txt").read_text())

    def test_failures_are_static_and_say_whether_a_file_stays(self):
        with patch.object(baseline, "_create_file", side_effect=OSError(CANARY)):
            self.rejected("target_unavailable", "baseline.out", lambda: write(str(self.out), b"x"))
        self.assertFalse(os.path.lexists(self.out))

        def partial(fd, name, data):
            os.close(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd))
            raise OSError(CANARY)

        with patch.object(baseline, "_create_file", side_effect=partial):
            self.rejected("write_failed", "baseline.out", lambda: write(str(self.out), b"x"), created=True)
        self.out.unlink()
        old = os.umask(0o277)
        try:
            self.rejected("file_privacy", "baseline.out", lambda: write(str(self.out), b"x"), created=True)
        finally:
            os.umask(old)


class CliTests(Fixture):
    def run_cli(self, *argv, home=None):
        out, err = StringIO(), StringIO()
        with patch.dict(os.environ, {"HOME": str(self.home if home is None else home)}), \
                redirect_stdout(out), redirect_stderr(err):
            code = tenant_pi.main(list(argv), clock=clock)
        return code, out.getvalue(), err.getvalue()

    def record(self, directory=None, out=None, **kwargs):
        return self.run_cli("baseline", "--dir", str(self.live if directory is None else directory),
                            "--out", str(self.out if out is None else out), **kwargs)

    def check(self, directory=None, saved=None):
        code, out, err = self.run_cli("check-baseline", "--dir", str(self.live if directory is None else directory),
                                      "--baseline", str(self.out if saved is None else saved))
        return code, (json.loads(out) if out else None), err

    def refused(self, rule, result, *, created=False):
        code, out, err = result
        self.assertEqual((2, ""), (code, out or ""))
        self.assertEqual({"candidate_created": created, "error": rule}, json.loads(err))
        self.assertNotIn(str(self.base), err)

    def test_record_then_unchanged_and_the_directory_is_not_touched(self):
        self.populate()
        before = snapshot(self.live)
        code, out, err = self.record()
        self.assertEqual((0, ""), (code, err))
        report = json.loads(out)
        self.assertEqual({"dir": str(self.live), "present": True, "recordedAt": AT,
                          "summary": {"entries": 6, "below": 3},
                          "baseline": {"path": str(self.out), "mode": "0600", "complete": True, "fileCreated": True,
                                       "warnings": []}}, report)
        self.assertEqual(0o600, stat.S_IMODE(os.lstat(self.out).st_mode))
        saved = json.loads(self.out.read_text())
        self.assertEqual((1, str(self.live), AT, True), (saved["schemaVersion"], saved["dir"], saved["recordedAt"], saved["present"]))
        for text in (out, self.out.read_text()):
            for hidden in (CANARY, "token", "target.txt", "one.jsonl", "--work--"):
                self.assertNotIn(hidden, text)
        code, result, err = self.check()
        self.assertEqual((0, "", "unchanged", AT, "present", "present"),
                         (code, err, result["result"], result["recordedAt"], result["was"], result["now"]))
        # The two actions changed no entry, no size, no time and no byte of the directory.
        self.assertEqual(before, snapshot(self.live))
        self.assertEqual(["live-baseline.json"], sorted(p.name for p in self.private.iterdir()))

    def test_changed_gives_the_names_and_exit_code_1(self):
        self.populate()
        self.assertEqual(0, self.record()[0])
        with open(self.live / "sessions" / "--work--" / "one.jsonl", "a") as stream:
            stream.write("x")
        (self.live / "models-store.json").write_text(CANARY)
        (self.live / "settings.json").unlink()
        code, result, err = self.check()
        self.assertEqual((1, ""), (code, err))
        self.assertEqual(("changed", ["models-store.json"], ["settings.json"], ["sessions"], True),
                         (result["result"], result["added"], result["removed"], result["modified"],
                          result["directoryModified"]))
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertNotIn("one.jsonl", json.dumps(result))

    def test_an_entry_that_was_made_and_removed_is_changed_without_a_name(self):
        self.populate()
        self.assertEqual(0, self.record()[0])
        info = os.lstat(self.live)
        (self.live / "settings.json.lock").mkdir()
        (self.live / "settings.json.lock").rmdir()
        os.utime(self.live, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000))
        code, result, _ = self.check()
        self.assertEqual((1, "changed", [], [], [], True), (code, result["result"], result["added"], result["removed"],
                                                            result["modified"], result["directoryModified"]))

    def test_no_baseline_lists_nothing_and_gives_exit_code_1(self):
        self.populate()
        del EVENTS[:]
        RECORDING.append(True)
        try:
            code, result, err = self.check()
        finally:
            del RECORDING[:]
        self.assertEqual((1, "", "no_baseline", None), (code, err, result["result"], result["recordedAt"]))
        self.assertEqual([], [event for event, _ in EVENTS if event in ("os.scandir", "os.listdir")])
        self.assertFalse(os.path.lexists(self.out))

    def test_an_absent_directory_has_a_baseline_too(self):
        absent = self.home / "no agent"
        self.assertEqual(0, self.record(absent)[0])
        self.assertFalse(json.loads(self.out.read_text())["present"])
        code, result, _ = self.check(absent)
        self.assertEqual((0, "unchanged", "absent", "absent"), (code, result["result"], result["was"], result["now"]))
        absent.mkdir()
        (absent / "auth.json").write_text(CANARY)
        code, result, _ = self.check(absent)
        self.assertEqual((1, "changed", "absent", "present", ["auth.json"]),
                         (code, result["result"], result["was"], result["now"], result["added"]))
        self.assertFalse(os.path.lexists(self.home / "no agent" / "live-baseline.json"))

    def test_a_baseline_is_never_replaced(self):
        self.populate()
        self.assertEqual(0, self.record()[0])
        first = self.out.read_bytes()
        (self.live / "later").write_text("")
        del EVENTS[:]
        RECORDING.append(True)
        try:
            self.refused("target_exists: baseline.out", self.record())
        finally:
            del RECORDING[:]
        # The refusal comes before the directory is listed.
        self.assertEqual([], [event for event, _ in EVENTS if event in ("os.scandir", "os.listdir")])
        self.assertEqual(first, self.out.read_bytes())
        self.assertEqual("changed", self.check()[1]["result"])

    def test_refusals_of_the_out_path_write_nothing(self):
        self.populate()
        other = self.home / "other agent"
        (other / "sessions").mkdir(parents=True)
        before = snapshot(self.home)
        # The baseline file never goes into the directory that it records, or into `~/.pi/agent`.
        self.refused("under_dir: baseline.out", self.record(other, out=other / "live-baseline.json"))
        self.refused("under_dir: baseline.out", self.record(other, out=other / "sessions" / "b.json"))
        self.refused("under_pi_agent: baseline.out", self.record(out=self.live / "live-baseline.json"))
        self.refused("under_pi_agent: baseline.out", self.record(other, out=self.live / "sessions" / "b.json"))
        self.refused("under_kit: baseline.out", self.record(out=ROOT / ".local" / "live-baseline.json"))
        self.refused("absolute_path: baseline.out", self.record(out="live-baseline.json"))
        self.refused("parent_missing: baseline.out.parent", self.record(out=self.home / "absent" / "b.json"))
        self.refused("absolute_path: baseline.dir", self.record("relative/agent"))
        self.refused("absolute_path: baseline.dir", self.record(str(self.live) + "/../agent"))
        self.assertEqual(before, snapshot(self.home))
        # A link cannot reach the directory from another name: the ancestor walk refuses each link.
        (self.home / "agent link").symlink_to(self.live, target_is_directory=True)
        self.refused("unsafe_path: baseline.out.parents",
                     self.record(self.outside, out=self.home / "agent link" / "b.json"))
        # A root that is a link does not hide its real place: the root counts as written and as resolved.
        linked_home = self.base / "linked home"
        linked_home.symlink_to(self.home, target_is_directory=True)
        self.refused("under_pi_agent: baseline.out",
                     self.record(self.outside, out=self.live / "b.json", home=linked_home))
        self.assertFalse(os.path.lexists(self.live / "b.json"))

    def test_home_is_required_for_the_record_only(self):
        self.populate()
        with patch.dict(os.environ), redirect_stdout(StringIO()), redirect_stderr(StringIO()) as err:
            del os.environ["HOME"]
            code = tenant_pi.main(["baseline", "--dir", str(self.live), "--out", str(self.out)], clock=clock)
        self.assertEqual((2, {"candidate_created": False, "error": "home_required: baseline.home"}),
                         (code, json.loads(err.getvalue())))
        self.refused("absolute_path: baseline.home", self.record(home="relative"))
        self.assertFalse(os.path.lexists(self.out))
        self.assertEqual(0, self.record()[0])
        with patch.dict(os.environ), redirect_stdout(StringIO()) as out, redirect_stderr(StringIO()):
            del os.environ["HOME"]
            code = tenant_pi.main(["check-baseline", "--dir", str(self.live), "--baseline", str(self.out)])
        self.assertEqual((0, "unchanged"), (code, json.loads(out.getvalue())["result"]))

    def test_a_directory_that_is_a_link_or_a_file_is_refused(self):
        self.populate()
        (self.home / "linked").symlink_to(self.live, target_is_directory=True)
        self.refused("not_directory: baseline.dir", self.record(self.home / "linked"))
        self.refused("not_directory: baseline.dir", self.record(self.home / "linked" / "sessions"))
        self.refused("not_directory: baseline.dir", self.record(self.live / "auth.json"))
        self.assertFalse(os.path.lexists(self.out))
        self.assertEqual(0, self.record()[0])
        # After the record, the directory becomes a link: the comparison stops, it does not follow the link.
        moved = self.home / ".pi" / "moved"
        self.live.rename(moved)
        self.live.symlink_to(moved, target_is_directory=True)
        self.refused("not_directory: check-baseline.dir", self.check())

    def test_an_unreadable_directory_is_a_static_diagnostic(self):
        self.populate()
        real_open = os.open

        def denied(path, *args, **kwargs):
            if path == "sessions":
                raise PermissionError(CANARY)
            return real_open(path, *args, **kwargs)

        with patch.object(baseline.os, "open", denied):
            self.refused("unreadable: baseline.dir", self.record())
        self.assertFalse(os.path.lexists(self.out))
        self.assertEqual(0, self.record()[0])
        with patch.object(baseline.os, "open", denied):
            self.refused("unreadable: check-baseline.dir", self.check())

    def test_a_damaged_or_foreign_baseline_is_refused(self):
        self.populate()
        self.assertEqual(0, self.record()[0])
        other = self.home / "other agent"
        other.mkdir()
        self.refused("baseline_dir: check-baseline.dir", self.check(other))
        self.refused("absolute_path: check-baseline.dir", self.check("relative"))
        self.refused("absolute_path: check-baseline.baseline", self.check(saved="relative.json"))
        saved = json.loads(self.out.read_text())
        for index, damage in enumerate(({**saved, "schemaVersion": 2}, {**saved, "entries": [{"name": CANARY}]},
                                        [saved], {**saved, "note": CANARY})):
            path = self.private / f"damaged-{index}.json"
            path.write_text(json.dumps(damage))
            with self.subTest(index=index):
                self.refused("baseline_record: check-baseline.baseline", self.check(saved=path))
        (self.private / "text.json").write_text(self.out.read_text()[:-20])
        code, _, err = self.check(saved=self.private / "text.json")
        self.assertEqual(2, code)
        self.assertNotIn(CANARY, err)
        (self.private / "link.json").symlink_to(self.out)
        code, _, err = self.check(saved=self.private / "link.json")
        self.assertEqual(2, code)
        self.assertIn("check-baseline.baseline", err)

    def test_a_record_larger_than_the_loader_bound_is_refused_before_the_write(self):
        self.populate()
        with patch.object(tenant_pi, "MAX_INPUT", 64):
            self.refused("input_too_large: baseline.dir", self.record())
        self.assertFalse(os.path.lexists(self.out))

    def test_the_real_cli_process(self):
        self.populate()
        env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}
        cli = [sys.executable, str(ROOT / "scripts/tenant_pi.py")]
        done = subprocess.run([*cli, "baseline", "--dir", str(self.live), "--out", str(self.out)],
                              env=env, capture_output=True, text=True)
        self.assertEqual((0, ""), (done.returncode, done.stderr))
        done = subprocess.run([*cli, "check-baseline", "--dir", str(self.live), "--baseline", str(self.out)],
                              env=env, capture_output=True, text=True)
        self.assertEqual((0, "unchanged"), (done.returncode, json.loads(done.stdout)["result"]))
        (self.live / "sessions" / "--work--" / "two.jsonl").write_text("")
        done = subprocess.run([*cli, "check-baseline", "--dir", str(self.live), "--baseline", str(self.out)],
                              env=env, capture_output=True, text=True)
        self.assertEqual((1, "changed", ["sessions"]),
                         (done.returncode, json.loads(done.stdout)["result"], json.loads(done.stdout)["modified"]))


class GuideTests(unittest.TestCase):
    """The three install documents give the same Stage 0 line and the same two baseline commands."""

    DOCS = ("INSTALL.md", "docs/guides/setup.md", "skills/tenant-pi-install/SKILL.md")
    FIRST = 'for d in "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do'
    TEXT = ('tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"',
            'tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"',
            "`unchanged`", "`changed`", "`no_baseline`", "not verified", "No line is not `absent`",
            "A Pi", "second baseline", "target_exists: baseline.out")
    # The old command printed nothing for an absent directory.
    ABSENT = ("ls -d ~/.pi/agent", "Nothing new appear", "Nothing appeared in `~/.pi/agent`")

    def loop(self, name):
        lines = (ROOT / name).read_text(encoding="utf-8").split("\n")
        start = [index for index, line in enumerate(lines) if line.strip() == self.FIRST]
        self.assertEqual(1, len(start), name)
        block = [line.strip() for line in lines[start[0]:start[0] + 4]]
        self.assertEqual("done", block[-1], name)
        return "\n".join(block)

    def test_same_text_in_each_document(self):
        loops = {self.loop(name) for name in self.DOCS}
        self.assertEqual(1, len(loops))
        for name in self.DOCS:
            text = (ROOT / name).read_text(encoding="utf-8")
            for expected in self.TEXT:
                with self.subTest(name=name, text=expected):
                    self.assertTrue(expected in text)
            for old in self.ABSENT:
                with self.subTest(name=name, absent=old):
                    self.assertFalse(old in text)
            # The baseline comes before the comparison.
            self.assertLess(text.index(self.TEXT[0]), text.index(self.TEXT[1]), name)

    def test_the_stage_0_loop_prints_one_explicit_line_for_each_directory(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-stage0-")
        self.addCleanup(temp.cleanup)
        home = Path(temp.name).resolve() / "home dir"
        other = home / "other agent"
        loop = self.loop("INSTALL.md")

        def run(**extra):
            done = subprocess.run(["/bin/sh", "-c", loop], env={"HOME": str(home), "PATH": "/usr/bin:/bin", **extra},
                                  capture_output=True, text=True)
            self.assertEqual((0, ""), (done.returncode, done.stderr))
            return done.stdout.splitlines()

        home.mkdir()
        live = home / ".pi" / "agent"
        # Absent is one explicit line, never an empty output.
        self.assertEqual([f"live agent directory absent: {live}"], run())
        self.assertEqual([f"live agent directory absent: {live}"], run(PI_CODING_AGENT_DIR=""))
        self.assertEqual([f"live agent directory absent: {live}", f"live agent directory absent: {other}"],
                         run(PI_CODING_AGENT_DIR=str(other)))
        live.mkdir(parents=True)
        (live / "auth.json").write_text(CANARY)
        self.assertEqual([f"live agent directory present: {live}"], run())
        other.symlink_to(home / "dangling target")
        # The variable names a second directory; a link counts as present, also when its target is absent.
        self.assertEqual([f"live agent directory present: {live}", f"live agent directory present: {other}"],
                         run(PI_CODING_AGENT_DIR=str(other)))
        self.assertEqual({"agent"}, {path.name for path in (home / ".pi").iterdir()})


if __name__ == "__main__":
    unittest.main()
