"""Parsing, validation, rendering and path extraction run no network, command or agent."""

import contextlib
import io
import os
import socket
import subprocess
import tempfile
import unittest
import urllib.request
import webbrowser
from pathlib import Path
from unittest import mock

from tracker.__main__ import main
from tracker import handoff
from tracker.brief import dump, parse, validate
from tracker.paths import extract, format_text
from tracker.render import render

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"
FIXTURE = ROOT / "tests" / "fixtures" / "prototype-fleet-72.md"


class Forbidden(AssertionError):
    pass


def _refuse(name):
    def refuse(*args, **kwargs):
        raise Forbidden(f"{name} was called")

    return refuse


def _patches():
    targets = [
        (socket, "socket"),
        (socket, "create_connection"),
        (socket, "getaddrinfo"),
        (subprocess, "Popen"),
        (subprocess, "run"),
        (subprocess, "call"),
        (subprocess, "check_call"),
        (subprocess, "check_output"),
        (os, "system"),
        (os, "popen"),
        (urllib.request, "urlopen"),
        (webbrowser, "open"),
    ]
    for name in dir(os):
        if name.startswith(("exec", "spawn", "posix_spawn")) or name in ("fork", "forkpty"):
            if callable(getattr(os, name)):
                targets.append((os, name))
    return [mock.patch.object(owner, name, _refuse(f"{owner.__name__}.{name}")) for owner, name in targets]


class NoSideEffectTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        for patch in _patches():
            self.stack.enter_context(patch)
        self.addCleanup(self.stack.close)

    def test_guards_are_active(self):
        with self.assertRaises(Forbidden):
            socket.socket()
        with self.assertRaises(Forbidden):
            subprocess.Popen(["true"])
        with self.assertRaises(Forbidden):
            os.system("true")
        with self.assertRaises(Forbidden):
            os.execv("/bin/true", ["true"])

    def test_library_calls(self):
        for source in (EXAMPLE, FIXTURE):
            with self.subTest(source=source.name):
                model = parse(source.read_text(encoding="utf-8"))
                self.assertFalse([d for d in validate(model, now="2026-09-24T00:00:00Z") if d.level == "error"])
                self.assertIn("<main>", render(model))
                packets = extract(model)
                self.assertTrue(format_text(packets))
                self.assertEqual(parse(dump(model)), model)
                self.assertEqual(handoff.build(model), model["handoffs"][0])
                self.assertEqual(handoff.build(model, basis="carried-forward")["basis"], "carried-forward")
                self.assertEqual(handoff.refresh(model), model)

    def test_cli_calls(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main(["validate", str(EXAMPLE), "--now", "2026-09-24T00:00:00Z"]), 0)
            self.assertEqual(main(["render", str(EXAMPLE), str(Path(tmp) / "brief.html")]), 0)
            self.assertEqual(main(["paths", str(EXAMPLE), "--json"]), 0)
            self.assertEqual(main(["paths", str(EXAMPLE)]), 0)
            self.assertEqual(main(["handoff", str(EXAMPLE)]), 0)


if __name__ == "__main__":
    unittest.main()
