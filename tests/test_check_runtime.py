"""Runtime check contract: range grammar, the five statuses, exactly three processes, no leftover directory."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts import tenant_pi
from scripts.check_runtime import (HERDR_STATUSES, MAX_TOKEN, STATUSES, TIMEOUT, check, check_herdr, in_range, matches,
                                   parse_range, parse_version)
from scripts.profile_plan import runtime_report
from scripts.validate import Invalid, load

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
RUNTIME = load(ROOT / "config/manifest.json")["runtime"]
PIN = RUNTIME["piVersion"]
PI_RANGE = RUNTIME["piAcceptedRange"]
PI_FIELDS = {"tested": PIN, "acceptedRange": PI_RANGE}
LOWER, UPPER = parse_range(PI_RANGE, "f")
IN_RANGE = ".".join(map(str, (*LOWER[:2], LOWER[2] + 1)))
OUTSIDE = ".".join(map(str, UPPER))
CANARY = "CANARY_SECRET"
GOOD = {"pi": PIN, "node": "v24.21.0", "python3": "Python 3.11.2"}
# Every process-creation audit event of CPython; the hook of the fixture records each one.
SPAWN_EVENTS = ("subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty",
                "pty.spawn")


class Done:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


class GrammarTests(unittest.TestCase):
    def test_range_grammar_is_a_lower_bound_with_an_optional_upper_bound(self):
        self.assertEqual(((24, 0, 0), (25, 0, 0)), parse_range(">=24.0.0 <25", "f"))
        self.assertEqual(((3, 11, 0), None), parse_range(">=3.11", "f"))
        self.assertEqual(((1, 2, 3), (1, 4, 0)), parse_range(">=1.2.3 <1.4", "f"))
        for bad in ("", "22", ">=22", "^24.21.0", ">24.21.0", ">=24.21.0  <25", ">=24.0.0 <25 ", ">=24.21.0 <=25",
                    ">=24.21.0 || >=24", ">=a.b", ">=3.11\n", ">=1.2.3.4", ">=1.2.3 <1.2.3", ">=2.0 <1", None, 3, [">=3.11"], CANARY):
            with self.assertRaises(Invalid) as caught:
                parse_range(bad, "manifest.runtime.nodeRange")
            self.assertEqual("runtime_range: manifest.runtime.nodeRange", str(caught.exception))

    def test_bounded_range_requires_an_upper_bound(self):
        self.assertEqual(((1, 2, 3), (1, 4, 0)), parse_range(">=1.2.3 <1.4", "f", bounded=True))
        for unbounded in (">=3.11", ">=1.0.3"):
            with self.assertRaises(Invalid) as caught:
                parse_range(unbounded, "manifest.runtime.piAcceptedRange", bounded=True)
            self.assertEqual("range_without_upper_bound: manifest.runtime.piAcceptedRange", str(caught.exception))
        with self.assertRaises(Invalid) as caught:
            parse_range("^1.0.3", "manifest.runtime.piAcceptedRange", bounded=True)
        self.assertEqual("runtime_range: manifest.runtime.piAcceptedRange", str(caught.exception))

    def test_range_bounds(self):
        node = parse_range(RUNTIME["nodeRange"], "f")
        python = parse_range(RUNTIME["pythonRange"], "f")
        self.assertEqual([False, True, True, True, False, False],
                         [in_range(v, node) for v in ((22, 22, 3), (24, 0, 0), (24, 21, 0), (24, 99, 0), (25, 0, 0), (26, 1, 0))])
        self.assertEqual([False, False, True, True, True],
                         [in_range(v, python) for v in ((2, 7, 18), (3, 10, 14), (3, 11, 0), (3, 13, 1), (4, 0, 0))])

    def test_version_output_forms(self):
        self.assertEqual(("1.0.0", (1, 0, 0), False), parse_version(b"1.0.0\n"))
        self.assertEqual(("24.21.0", (24, 21, 0), False), parse_version(b"v24.21.0\n"))
        self.assertEqual(("3.11.2", (3, 11, 2), False), parse_version(b"Python 3.11.2\n"))
        self.assertEqual(("3.14.0rc1", (3, 14, 0), True), parse_version(b"Python 3.14.0rc1\n"))
        self.assertEqual(("3.11.0a1", (3, 11, 0), True), parse_version(b"Python 3.11.0a1\n"))
        self.assertEqual(("24.0.0-rc.1", (24, 0, 0), True), parse_version(b"v24.0.0-rc.1\n"))
        self.assertEqual(("1.0.0-beta.1+build.5", (1, 0, 0), True), parse_version(b"1.0.0-beta.1+build.5\n"))
        self.assertEqual(("3.12.3+", (3, 12, 3), False), parse_version(b"Python 3.12.3+\n"))
        self.assertEqual(("3.12", (3, 12, 0), False), parse_version(b"Python 3.12\nsecond line\n"))
        for bad in (b"", b"\n", b"version unknown", b"22", b"v22", b"pi version 1.0.0", b"1.0.0 " + CANARY.encode(),
                    b"\xff\xfe", b"x" * 300 + b"\n1.0.0", "1.0.0", None,
                    # Free text after the numbers is not a prerelease or a build.
                    b"1.0.0sk-ABCDEF0123456789ABCDEF012345", b"1.0.0sk", b"1.0.0A1", b"1.0.0.5", b"1.0.0_x",
                    b"1.0.0-", b"1.0.0-rc.1+a+b", b"1.0.0+a_b", b"22.1234567890", b"1.0.0" + CANARY.encode()):
            self.assertIsNone(parse_version(bad), bad)

    def test_version_token_has_a_length_bound(self):
        self.assertEqual(40, MAX_TOKEN)
        fits = b"1.0.0-" + b"a" * (MAX_TOKEN - 6)
        self.assertEqual(MAX_TOKEN, len(parse_version(fits)[0]))
        self.assertIsNone(parse_version(fits + b"a"))
        self.assertIsNone(parse_version(b"1.0.0+" + b"a" * (MAX_TOKEN - 5)))

    def test_prerelease_of_the_lower_bound_is_outside_the_range(self):
        node = parse_range(RUNTIME["nodeRange"], "f")
        python = parse_range(RUNTIME["pythonRange"], "f")
        self.assertFalse(in_range((24, 0, 0), node, True))
        self.assertFalse(in_range((3, 11, 0), python, True))
        self.assertTrue(in_range((24, 0, 0), node, False))
        # A prerelease above the lower bound is inside; one of the upper bound stays outside.
        self.assertTrue(in_range((24, 0, 1), node, True))
        self.assertTrue(in_range((3, 14, 0), python, True))
        self.assertFalse(in_range((25, 0, 0), node, True))


class CheckTests(unittest.TestCase):
    """The pure decision with an injected runner; no process starts here."""

    def setUp(self):
        self.calls = []
        self.output = {"/bin/pi": Done((PIN + "\n").encode()), "/bin/node": Done(b"v24.21.0\n"), "/bin/python3": Done(b"Python 3.11.2\n")}

    def run_fake(self, argv, **options):
        self.calls.append((argv, options))
        result = self.output[argv[0]]
        if isinstance(result, BaseException):
            raise result
        return result

    def check(self, paths=None, which=lambda name: "/bin/" + name):
        return check(RUNTIME, paths, run=self.run_fake, which=which, environ={"PATH": "/bin", "PI_CODING_AGENT_DIR": "/live"})

    def test_match_runs_three_fixed_commands_without_a_shell(self):
        report = self.check()
        self.assertEqual({"pi": {"installed": PIN, "required": PIN, "status": "match", **PI_FIELDS},
                          "node": {"installed": "24.21.0", "required": ">=24.0.0 <25", "status": "match"},
                          "python": {"installed": "3.11.2", "required": ">=3.11", "status": "match"}}, report)
        self.assertTrue(matches(report))
        self.assertEqual([["/bin/pi", "--version"], ["/bin/node", "--version"], ["/bin/python3", "--version"]],
                         [argv for argv, _ in self.calls])
        for _, options in self.calls:
            self.assertEqual((TIMEOUT, False, False, subprocess.DEVNULL),
                             (options["timeout"], options["shell"], options["check"], options["stdin"]))
        self.assertEqual(20, TIMEOUT)
        empty = self.calls[0][1]["env"]["PI_CODING_AGENT_DIR"]
        self.assertTrue(os.path.isabs(empty))
        self.assertNotEqual("/live", empty)
        self.assertFalse(os.path.lexists(empty))
        # Node and Python get the caller's environment unchanged.
        self.assertEqual({"PATH": "/bin", "PI_CODING_AGENT_DIR": "/live"}, self.calls[1][1]["env"])
        self.assertEqual("/bin", self.calls[0][1]["env"]["PATH"])

    def test_each_status(self):
        self.output = {"/bin/pi": Done(b"0.99.2\n"), "/bin/node": Done(b"v22.22.3\n"), "/bin/python3": Done(b"Python 3.10.14\n")}
        report = self.check()
        self.assertEqual({"mismatch"}, {r["status"] for r in report.values()})
        self.assertEqual(["0.99.2", "22.22.3", "3.10.14"], [report[k]["installed"] for k in ("pi", "node", "python")])
        self.assertFalse(matches(report))
        self.output = {"/bin/pi": Done((CANARY + "\n").encode()), "/bin/node": Done(b"v24.21.0\n", returncode=3),
                       "/bin/python3": subprocess.TimeoutExpired(["x"], TIMEOUT)}
        report = self.check()
        self.assertEqual({"unparsed"}, {r["status"] for r in report.values()})
        self.assertEqual({None}, {r["installed"] for r in report.values()})
        self.assertNotIn(CANARY, json.dumps(report))
        self.output = {"/bin/pi": FileNotFoundError(), "/bin/node": PermissionError(), "/bin/python3": OSError(8, "format")}
        report = self.check()
        self.assertEqual(["missing", "missing", "unparsed"], [report[k]["status"] for k in ("pi", "node", "python")])
        self.calls.clear()
        report = self.check(which=lambda name: None)
        self.assertEqual({"missing"}, {r["status"] for r in report.values()})
        self.assertEqual([], self.calls)
        self.assertEqual(set(STATUSES), {"match", "untested_in_range", "mismatch", "missing", "unparsed"})

    def test_each_report_is_a_valid_runtime_report_for_plan_and_generate(self):
        outputs = ({}, {"/bin/pi": Done(b"0.99.2\n"), "/bin/node": Done(b"v22.22.3\n"), "/bin/python3": Done(b"Python 3.10.14\n")},
                   {"/bin/pi": Done((PIN + "-beta.1\n").encode()), "/bin/node": Done(b"v24.0.0-rc.1\n"), "/bin/python3": Done(b"Python 3.14.0rc1\n")},
                   {"/bin/pi": Done((CANARY + "\n").encode()), "/bin/node": Done(b"v24.21.0\n", returncode=3),
                    "/bin/python3": subprocess.TimeoutExpired(["x"], TIMEOUT)},
                   {"/bin/pi": FileNotFoundError(), "/bin/node": PermissionError(), "/bin/python3": OSError(8, "format")})
        for output in outputs:
            self.output = {**self.output, **output}
            report = self.check()
            # The CLI prints the report as JSON; `plan` and `generate` read it back from a file.
            self.assertEqual(report, runtime_report(json.loads(json.dumps(report)), RUNTIME))
        absent = self.check(which=lambda name: None)
        self.assertEqual({"missing"}, {entry["status"] for entry in runtime_report(absent, RUNTIME).values()})

    def test_prerelease_pi_is_a_mismatch_and_stderr_is_read_when_stdout_is_empty(self):
        self.output["/bin/pi"] = Done((PIN + "-beta.1\n").encode())
        self.output["/bin/python3"] = Done(b"", b"Python 3.12.1\n")
        report = self.check()
        self.assertEqual((PIN + "-beta.1", "mismatch"), (report["pi"]["installed"], report["pi"]["status"]))
        self.assertEqual(("3.12.1", "match"), (report["python"]["installed"], report["python"]["status"]))

    def test_manifest_pin_matches_and_each_earlier_pin_is_a_mismatch(self):
        self.assertEqual({"installed": PIN, "required": PIN, "status": "match", **PI_FIELDS}, self.check()["pi"])
        for earlier in ("1.0.2", "1.0.0", "0.99.2"):
            self.output["/bin/pi"] = Done(earlier.encode() + b"\n")
            report = self.check()
            self.assertEqual({"installed": earlier, "required": PIN, "status": "mismatch", **PI_FIELDS}, report["pi"])
            self.assertFalse(matches(report))

    def test_pi_tested_accepted_and_outside_range_states(self):
        cases = ((PIN, "match"), (IN_RANGE, "untested_in_range"),
                 (IN_RANGE + "-rc.1", "untested_in_range"), (PIN + "+build.5", "untested_in_range"),
                 (".".join(map(str, LOWER)) + "-rc.1", "mismatch"),
                 (OUTSIDE, "mismatch"), (OUTSIDE + "-rc.1", "mismatch"), ("0.0.0", "mismatch"))
        for installed, status in cases:
            with self.subTest(installed=installed):
                self.output["/bin/pi"] = Done(installed.encode() + b"\n")
                report = self.check()
                self.assertEqual({"installed": installed, "required": PIN, "status": status, **PI_FIELDS}, report["pi"])
                self.assertEqual(status != "mismatch", matches(report))
                self.assertIs(report, runtime_report(report, RUNTIME))

    def test_lower_bound_prerelease_is_a_mismatch(self):
        self.output["/bin/node"] = Done(b"v24.0.0-rc.1\n")
        self.output["/bin/python3"] = Done(b"Python 3.11.0a1\n")
        report = self.check()
        self.assertEqual(("24.0.0-rc.1", "mismatch"), (report["node"]["installed"], report["node"]["status"]))
        self.assertEqual(("3.11.0a1", "mismatch"), (report["python"]["installed"], report["python"]["status"]))
        self.output["/bin/node"] = Done(b"v24.0.1-rc.1\n")
        self.output["/bin/python3"] = Done(b"Python 3.14.0rc1\n")
        report = self.check()
        self.assertEqual(["match", "match"], [report[k]["status"] for k in ("node", "python")])

    def test_free_text_suffix_is_unparsed_and_not_echoed(self):
        self.output["/bin/pi"] = Done(b"1.0.0sk-ABCDEF0123456789ABCDEF012345\n")
        self.output["/bin/node"] = Done(b"v24.21.0sk-ABCDEF0123456789ABCDEF012345\n")
        report = self.check()
        for key in ("pi", "node"):
            self.assertEqual((None, "unparsed"), (report[key]["installed"], report[key]["status"]))
        self.assertNotIn("ABCDEF", json.dumps(report))

    def test_cleanup_failure_is_a_static_diagnostic(self):
        made = []

        def refuse(path, *args, **kwargs):
            made.append(path)
            raise PermissionError(13, "denied", path)

        try:
            with patch("scripts.check_runtime.shutil.rmtree", refuse):
                with self.assertRaises(Invalid) as caught:
                    self.check()
            self.assertEqual("cleanup_failed: check-runtime.tmpdir", str(caught.exception))
            self.assertEqual(1, len(made))
            self.assertNotIn(made[0], str(caught.exception))
            # Node and Python do not start after the failure.
            self.assertEqual([["/bin/pi", "--version"]], [argv for argv, _ in self.calls])
        finally:
            for path in made:
                shutil.rmtree(path, ignore_errors=True)

    def test_real_timeout_is_unparsed_and_removes_the_directory(self):
        sleep = shutil.which("sleep")
        if not sleep:
            self.skipTest("no sleep command")
        with tempfile.TemporaryDirectory(prefix="tenant-pi-runtime-") as base:
            marker = Path(base, "dir")
            slow = Path(base, "pi")
            slow.write_text("#!/bin/sh\nprintf '%s' \"$PI_CODING_AGENT_DIR\" > '" + str(marker) + "'\nexec '" + sleep + "' 3\n")
            slow.chmod(0o700)
            started = time.monotonic()
            with patch("scripts.check_runtime.TIMEOUT", 1):
                report = check(RUNTIME, {"pi": str(slow)}, which=lambda name: None, environ={})
            elapsed = time.monotonic() - started
            self.assertEqual({"installed": None, "required": PIN, "status": "unparsed", **PI_FIELDS}, report["pi"])
            self.assertGreaterEqual(elapsed, 1)
            self.assertLess(elapsed, 2.5)
            self.assertFalse(os.path.lexists(marker.read_text()))

    def test_explicit_path_replaces_the_lookup(self):
        self.output["/opt/pin/pi"] = Done((PIN + "\n").encode())
        looked = []
        self.check({"pi": "/opt/pin/pi"}, which=lambda name: looked.append(name) or "/bin/" + name)
        self.assertEqual(["node", "python3"], looked)
        self.assertEqual(["/opt/pin/pi", "--version"], self.calls[0][0])

    def test_bad_range_starts_no_process(self):
        for field in ("piAcceptedRange", "nodeRange", "pythonRange"):
            with self.subTest(field=field), self.assertRaises(Invalid) as caught:
                check({**RUNTIME, field: "^3.11"}, run=self.run_fake, which=lambda name: "/bin/" + name, environ={})
            self.assertEqual("runtime_range: manifest.runtime." + field, str(caught.exception))
            self.assertEqual([], self.calls)

    def test_directory_is_removed_when_the_runner_fails(self):
        seen = []

        def broken(argv, **options):
            seen.append(options["env"]["PI_CODING_AGENT_DIR"])
            self.assertEqual([], os.listdir(seen[0]))
            Path(seen[0], "left-by-pi").write_text("x")
            raise RuntimeError("runner")

        with self.assertRaises(RuntimeError):
            check(RUNTIME, run=broken, which=lambda name: "/bin/" + name, environ={})
        self.assertEqual(1, len(seen))
        self.assertFalse(os.path.lexists(seen[0]))


class HerdrCheckTests(unittest.TestCase):
    """The pure Herdr decision with an injected runner; no process starts here."""

    def check(self, output, path=None, which=lambda name: "/bin/" + name):
        self.calls = []

        def run(argv, **options):
            self.calls.append((argv, options))
            if isinstance(output, BaseException):
                raise output
            return output
        return check_herdr(path, run=run, which=which, environ={"PATH": "/bin"})

    def test_present_runs_one_fixed_command_without_a_shell(self):
        self.assertEqual({"herdr": {"installed": "0.9.3", "status": "present"}}, self.check(Done(b"herdr 0.9.3\n")))
        self.assertEqual([["/bin/herdr", "--version"]], [argv for argv, _ in self.calls])
        options = self.calls[0][1]
        self.assertEqual((TIMEOUT, False, False, subprocess.DEVNULL, {"PATH": "/bin"}),
                         (options["timeout"], options["shell"], options["check"], options["stdin"], options["env"]))
        self.assertEqual(("present", "missing", "unparsed"), HERDR_STATUSES)

    def test_missing_starts_no_process(self):
        self.assertEqual({"herdr": {"installed": None, "status": "missing"}}, self.check(Done(), which=lambda name: None))
        self.assertEqual([], self.calls)
        self.assertEqual("missing", self.check(FileNotFoundError())["herdr"]["status"])

    def test_other_output_is_unparsed_and_not_echoed(self):
        for output in (Done(CANARY.encode()), Done(b"herdr 0.9.3 " + CANARY.encode()), Done(b"herdr 0.9.3\n", returncode=3),
                       subprocess.TimeoutExpired("herdr", TIMEOUT), Done(b"")):
            report = self.check(output)
            self.assertEqual({"herdr": {"installed": None, "status": "unparsed"}}, report)

    def test_explicit_path_replaces_the_lookup(self):
        report = self.check(Done(b"herdr 0.9.3\n"), path="/opt/tools/herdr", which=lambda name: self.fail("lookup"))
        self.assertEqual("present", report["herdr"]["status"])
        self.assertEqual([["/opt/tools/herdr", "--version"]], [argv for argv, _ in self.calls])


class CliTests(unittest.TestCase):
    """The real action with fake executables on PATH, an audit hook, and a disposable HOME."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-runtime-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        live = self.home / ".pi/agent"
        live.mkdir(parents=True, mode=0o700)
        for name in ("settings.json", "auth.json", "models.json"):
            (live / name).write_text(CANARY)
        self.tmp = self.base / "tmp"
        self.tmp.mkdir(mode=0o700)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.seen = self.base / "pi-saw"
        self.events = self.base / "events"
        self.opened = self.base / "opened"
        for name in ("npm", "git", "sh", "curl", "env", "which"):
            self.fake(name, "printf CALLED > '" + str(self.base / "called") + "'")
        # The hook loads before the CLI: it blocks the network and records each process and file open.
        (self.base / "sitecustomize.py").write_text(
            "import sys\nsys.dont_write_bytecode = True\nimport json, os, socket\n"
            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
            "socket.socket.connect = blocked\n"
            "_events = os.open(" + repr(str(self.events)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
            "_opened = os.open(" + repr(str(self.opened)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
            "def _audit(event, args):\n"
            "    if event in " + repr(SPAWN_EVENTS) + ":\n"
            "        os.write(_events, (json.dumps([event, repr(args[0]), repr(args[1]) if len(args) > 1 else None]) + '\\n').encode())\n"
            "    elif event == 'open':\n"
            "        os.write(_opened, (str(args[0]) + '\\n').encode('utf-8', 'replace'))\n"
            "sys.addaudithook(_audit)\n")
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "PYTHONPATH": str(self.base),
                    "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": str(self.tmp), "PI_CODING_AGENT_DIR": str(live),
                    "EXAMPLE_API_KEY": CANARY}

    def fake(self, name, body, directory=None):
        command = (directory or self.bin) / name
        command.write_text("#!/bin/sh\n" + body + "\n")
        command.chmod(0o700)
        return command

    def tools(self, **outputs):
        """Fake `pi`, `node` and `python3`. The fake `pi` records its directory, then writes into it."""
        for name, line in {**GOOD, **outputs}.items():
            if line is None:
                continue
            body = "echo '" + line + "'"
            if name == "pi":
                body = ('d="$PI_CODING_AGENT_DIR"\nstate=absent\nif [ -d "$d" ]; then state=empty\n'
                        'for f in "$d"/* "$d"/.[!.]*; do if [ -e "$f" ]; then state=filled; fi; done\nfi\n'
                        'printf \'%s\\n%s\\n\' "$d" "$state" > \'' + str(self.seen) + "'\n: > \"$d/written-by-pi\"\n" + body)
            self.fake(name, body)

    def run_cli(self, *extra):
        return subprocess.run([sys.executable, str(CLI), "check-runtime", *extra], cwd=self.base, env=self.env,
                              text=True, capture_output=True, check=False)

    def spawned(self):
        """`[event, executable]` of each process-creation event of the CLI process."""
        lines = self.events.read_text().splitlines() if self.events.exists() else []
        return [json.loads(line)[:2] for line in lines]

    def statuses(self, result):
        return {key: value["status"] for key, value in json.loads(result.stdout).items()}

    def check_no_other_process(self, expected):
        """Exactly the expected executables started, each once, and no decoy command ran."""
        events = self.spawned()
        self.assertEqual([repr(str(path)) for path in expected],
                         [executable for event, executable in events if event == "subprocess.Popen"])
        # CPython may implement Popen with posix_spawn; no other creation event is allowed.
        extra = [event for event in events if event[0] != "subprocess.Popen"]
        self.assertTrue(all(event == "os.posix_spawn" and executable in [repr(str(p)) for p in expected]
                            for event, executable in extra), extra)
        self.assertLessEqual(len(extra), len(expected))
        self.assertFalse((self.base / "called").exists())

    def test_match_is_deterministic_runs_three_processes_and_removes_the_directory(self):
        self.tools()
        manifest_before = hashlib.sha256((ROOT / "config/manifest.json").read_bytes()).hexdigest()
        result = self.run_cli()
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual('{"node":{"installed":"24.21.0","required":">=24.0.0 <25","status":"match"},'
                         f'"pi":{{"acceptedRange":"{PI_RANGE}","installed":"{PIN}","required":"{PIN}","status":"match","tested":"{PIN}"}},'
                         '"python":{"installed":"3.11.2","required":">=3.11","status":"match"}}\n', result.stdout)
        self.check_no_other_process([self.bin / "pi", self.bin / "node", self.bin / "python3"])
        directory, state = self.seen.read_text().splitlines()
        self.assertEqual("empty", state)
        self.assertEqual(str(self.tmp), os.path.dirname(directory))
        self.assertNotEqual(str(self.home / ".pi/agent"), directory)
        # The fake Pi wrote a file into the directory; the action still removes it.
        self.assertFalse(os.path.lexists(directory))
        self.assertEqual([], os.listdir(self.tmp))
        self.assertEqual(result.stdout, self.run_cli().stdout)
        self.assertEqual([], os.listdir(self.tmp))
        self.assertEqual(manifest_before, hashlib.sha256((ROOT / "config/manifest.json").read_bytes()).hexdigest())
        self.assertEqual(["auth.json", "models.json", "settings.json"], sorted(os.listdir(self.home / ".pi/agent")))
        opened = self.opened.read_text().splitlines()
        for private in ("auth.json", "models.json", "settings.json", "sessions"):
            self.assertFalse([path for path in opened if path.endswith(private)], private)
        self.assertNotIn(CANARY, result.stdout)

    def test_accepted_pi_exits_zero_and_outside_versions_exit_one(self):
        for installed, status, code in ((IN_RANGE, "untested_in_range", 0),
                                         (IN_RANGE + "-rc.1", "untested_in_range", 0),
                                         (OUTSIDE, "mismatch", 1), (OUTSIDE + "-rc.1", "mismatch", 1),
                                         (".".join(map(str, LOWER)) + "-rc.1", "mismatch", 1),
                                         ("0.0.0", "mismatch", 1)):
            with self.subTest(installed=installed):
                self.tools(pi=installed)
                result = self.run_cli()
                self.assertEqual((code, ""), (result.returncode, result.stderr))
                self.assertEqual({"installed": installed, "required": PIN, "status": status, **PI_FIELDS},
                                 json.loads(result.stdout)["pi"])
                self.assertEqual([], os.listdir(self.tmp))
        self.tools(pi=IN_RANGE, node="v22.22.3")
        self.assertEqual(1, self.run_cli().returncode)

    def test_mismatch_exits_1(self):
        self.tools(pi="0.99.2", node="v22.22.3", python3="Python 3.10.14")
        result = self.run_cli()
        self.assertEqual((1, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        self.assertEqual({"pi": "mismatch", "node": "mismatch", "python": "mismatch"}, self.statuses(result))
        self.assertEqual(["0.99.2", "22.22.3", "3.10.14"], [report[k]["installed"] for k in ("pi", "node", "python")])
        self.assertEqual([PIN, ">=24.0.0 <25", ">=3.11"], [report[k]["required"] for k in ("pi", "node", "python")])
        self.check_no_other_process([self.bin / "pi", self.bin / "node", self.bin / "python3"])
        self.assertEqual([], os.listdir(self.tmp))

    def test_one_mismatch_is_enough_for_exit_1(self):
        self.tools(node="v22.22.3")
        result = self.run_cli()
        self.assertEqual(1, result.returncode)
        self.assertEqual({"pi": "match", "node": "mismatch", "python": "match"}, self.statuses(result))

    def test_missing_exits_1_and_starts_no_process(self):
        result = self.run_cli()
        self.assertEqual((1, ""), (result.returncode, result.stderr))
        self.assertEqual({"pi": "missing", "node": "missing", "python": "missing"}, self.statuses(result))
        self.assertEqual({None}, {value["installed"] for value in json.loads(result.stdout).values()})
        self.check_no_other_process([])
        self.assertEqual([], os.listdir(self.tmp))
        # A file on PATH without the execute bit is not a command.
        self.tools()
        (self.bin / "node").chmod(0o600)
        result = self.run_cli()
        self.assertEqual({"pi": "match", "node": "missing", "python": "match"}, self.statuses(result))
        self.check_no_other_process([self.bin / "pi", self.bin / "python3"])

    def test_unparsed_exits_1_and_echoes_no_output(self):
        self.tools(pi=CANARY, python3="Python three")
        self.fake("node", "echo v24.21.0\nexit 4")
        result = self.run_cli()
        self.assertEqual((1, ""), (result.returncode, result.stderr))
        self.assertEqual({"pi": "unparsed", "node": "unparsed", "python": "unparsed"}, self.statuses(result))
        self.assertEqual({None}, {value["installed"] for value in json.loads(result.stdout).values()})
        self.assertNotIn(CANARY, result.stdout)
        self.assertEqual([], os.listdir(self.tmp))

    def test_explicit_paths_replace_path_lookup(self):
        self.tools(pi="0.99.2", node="v18.0.0", python3="Python 2.7.18")
        other = self.base / "other bin"
        other.mkdir()
        paths = [self.fake(name, "echo '" + GOOD[name] + "'", other) for name in ("pi", "node", "python3")]
        result = self.run_cli("--pi", str(paths[0]), "--node", str(paths[1]), "--python", str(paths[2]))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.check_no_other_process(paths)
        self.events.unlink()
        result = self.run_cli("--node", str(other / "absent"))
        self.assertEqual(1, result.returncode)
        self.assertEqual({"pi": "mismatch", "node": "missing", "python": "mismatch"}, self.statuses(result))
        # The absent path is tried and fails to start; nothing replaces it.
        self.check_no_other_process([self.bin / "pi", other / "absent", self.bin / "python3"])
        self.assertEqual([], os.listdir(self.tmp))

    def test_missing_interpreter_is_missing(self):
        self.tools()
        broken = self.base / "node-without-interpreter"
        broken.write_text("#!" + str(self.base / "absent-interpreter") + "\n")
        broken.chmod(0o700)
        result = self.run_cli("--node", str(broken))
        self.assertEqual(1, result.returncode)
        self.assertEqual({"pi": "match", "node": "missing", "python": "match"}, self.statuses(result))

    def test_cleanup_failure_exits_2_through_the_cli(self):
        self.tools()
        paths = {name: str(self.bin / name) for name in ("pi", "node", "python3")}
        made = []

        def refuse(path, *args, **kwargs):
            made.append(path)
            raise OSError(39, "not empty", path)

        out, err = io.StringIO(), io.StringIO()
        try:
            with patch("scripts.check_runtime.shutil.rmtree", refuse), patch.dict(os.environ, {"TMPDIR": str(self.tmp)}), \
                    patch("tempfile.tempdir", None), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = tenant_pi.main(["check-runtime", "--pi", paths["pi"], "--node", paths["node"], "--python", paths["python3"]])
        finally:
            for path in made:
                shutil.rmtree(path, ignore_errors=True)
        self.assertEqual((2, ""), (code, out.getvalue()))
        self.assertEqual({"error": "cleanup_failed: check-runtime.tmpdir", "candidate_created": False}, json.loads(err.getvalue()))
        self.assertEqual(1, len(made))
        self.assertEqual(str(self.tmp), os.path.dirname(made[0]))

    def test_bad_input_is_a_static_diagnostic_and_starts_no_process(self):
        self.tools()
        for extra, error in ((("--pi", "bin/pi"), "absolute_path: check-runtime.pi"),
                             (("--node", "../" + CANARY), "absolute_path: check-runtime.node"),
                             (("--python", "/usr/../bin/python3"), "absolute_path: check-runtime.python"),
                             (("--manifest", str(self.base / "absent.json")), "input_missing: manifest.file")):
            result = self.run_cli(*extra)
            self.assertEqual((2, ""), (result.returncode, result.stdout))
            self.assertEqual({"error": error, "candidate_created": False}, json.loads(result.stderr))
            self.assertNotIn(CANARY, result.stderr)
        changed = load(ROOT / "config/manifest.json")
        changed["runtime"]["nodeRange"] = ">=20"
        manifest = self.base / "manifest.json"
        manifest.write_text(json.dumps(changed))
        result = self.run_cli("--manifest", str(manifest))
        self.assertEqual("runtime_range: manifest.runtime", json.loads(result.stderr)["error"])
        link = self.base / "link.json"
        link.symlink_to(ROOT / "config/manifest.json")
        result = self.run_cli("--manifest", str(link))
        self.assertEqual((2, ""), (result.returncode, result.stdout))
        # The bounded loader names a final-component symlink `input_not_regular`.
        self.assertEqual({"error": "input_not_regular: manifest.file", "candidate_created": False}, json.loads(result.stderr))
        self.check_no_other_process([])
        self.assertEqual([], os.listdir(self.tmp))


class HerdrCliTests(unittest.TestCase):
    """The real `check-herdr` action with a fake `herdr` on PATH, an audit hook, and a disposable HOME."""

    setUp = CliTests.setUp
    fake = CliTests.fake
    spawned = CliTests.spawned
    check_no_other_process = CliTests.check_no_other_process

    def run_cli(self, *extra):
        return subprocess.run([sys.executable, str(CLI), "check-herdr", *extra], cwd=self.base, env=self.env,
                              text=True, capture_output=True, check=False)

    def test_present_exits_zero_and_starts_one_process(self):
        # The fake records each argument: a call other than `--version` would show here.
        self.fake("herdr", "printf '%s\\n' \"$@\" >> '" + str(self.base / "herdr-args") + "'\necho 'herdr 0.9.3'")
        result = self.run_cli()
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual({"herdr": {"installed": "0.9.3", "status": "present"}}, json.loads(result.stdout))
        self.assertEqual("--version\n", (self.base / "herdr-args").read_text())
        self.check_no_other_process([self.bin / "herdr"])
        self.assertEqual([], os.listdir(self.tmp))

    def test_missing_exits_one_and_starts_no_process(self):
        result = self.run_cli()
        self.assertEqual((1, ""), (result.returncode, result.stderr))
        self.assertEqual({"herdr": {"installed": None, "status": "missing"}}, json.loads(result.stdout))
        self.check_no_other_process([])

    def test_unparsed_exits_one_and_echoes_no_output(self):
        self.fake("herdr", "echo " + CANARY)
        result = self.run_cli()
        self.assertEqual((1, ""), (result.returncode, result.stderr))
        self.assertEqual({"herdr": {"installed": None, "status": "unparsed"}}, json.loads(result.stdout))
        self.assertNotIn(CANARY, result.stdout)

    def test_explicit_path_with_a_space_replaces_the_lookup(self):
        self.fake("herdr", "echo 'herdr 0.1.0'")
        other = self.base / "other bin"
        other.mkdir()
        path = self.fake("herdr", "echo 'herdr 0.9.3'", other)
        result = self.run_cli("--herdr", str(path))
        self.assertEqual((0, "0.9.3"), (result.returncode, json.loads(result.stdout)["herdr"]["installed"]))
        self.check_no_other_process([path])
        result = self.run_cli("--herdr", "relative/herdr")
        self.assertEqual(2, result.returncode)
        self.assertEqual("absolute_path: check-herdr.herdr", json.loads(result.stderr)["error"])


if __name__ == "__main__":
    unittest.main()
