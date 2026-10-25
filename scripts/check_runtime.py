#!/usr/bin/env python3
"""Runtime version check: three fixed `--version` processes compared with `manifest.runtime`.

It runs no shell, no network request, no install and no other command. It writes one empty
temporary directory and removes it. The output echoes a version token only; other process
output never enters a result or a diagnostic.

Run from the kit root: `python3 scripts/check_runtime.py [--pi PATH | --launcher PATH] [--node PATH]
[--python PATH]`. `--launcher` reads the runtime path from the `exec` line of a kit launcher.
Pi-Bolt prints the Pi version first; the check compares that and reports the Pi-Bolt version.
It prints one JSON object. The exit code is 0 when each tool matches (Pi may be `untested_in_range`),
1 otherwise, and 2 for a refusal, which goes to standard error.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.validate import Invalid, absolute, fail, hint_field, in_range, load, manifest, parse_range

TIMEOUT = 20
# (result key, command name on PATH, manifest.runtime field)
TOOLS = (("pi", "pi", "piVersion"), ("node", "node", "nodeRange"), ("python", "python3", "pythonRange"))
STATUSES = ("match", "untested_in_range", "mismatch", "missing", "unparsed")
# Only the first line of the output counts, and only this many bytes of it.
MAX_OUTPUT = 256
# The longest version token that the output echoes.
MAX_TOKEN = 40
# `1.0.0`, `v24.21.0`, `Python 3.11.2`: an optional name, an optional `v`, then the token.
# The token is two or three numbers, an optional prerelease (`-rc.1`, `a1`) and an optional
# build (`+abc`). Free text after the numbers is not a version.
VERSION = re.compile(r"(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?v?((\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?"
                     r"(-[0-9A-Za-z.-]+|[a-z]+\d+)?(?:\+[0-9A-Za-z.-]*)?)\Z")
# Pi-Bolt: `1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)`. The build text is not echoed.
BOLT = re.compile(r"(\S{1,40}) \(Pi-Bolt (\S{1,40}), [0-9A-Za-z_., -]{1,40}\)\Z")
LAUNCHER_MARK = "# tenant-pi launcher: "


def _triple(parts):
    return tuple(int(part or 0) for part in parts)


def parse_version(output):
    """Return `(token, number triple, prerelease)` from the first output line, or None."""
    if not isinstance(output, bytes):
        return None
    lines = output[:MAX_OUTPUT].decode("ascii", "replace").strip().splitlines()
    found = VERSION.match(lines[0].strip()) if lines else None
    if not found or len(found.group(1)) > MAX_TOKEN:
        return None
    return found.group(1), _triple(found.groups()[1:4]), found.group(5) is not None


def parse_pi_version(output):
    """Return `(Pi version as parse_version gives it, Pi-Bolt token or None)`, or None.

    Pi prints its version alone; Pi-Bolt prints the Pi version, then its own in parentheses.
    """
    found = parse_version(output)
    if found:
        return found, None
    lines = output[:MAX_OUTPUT].decode("ascii", "replace").strip().splitlines() if isinstance(output, bytes) else []
    bolt = BOLT.match(lines[0].strip()) if lines else None
    if not bolt:
        return None
    pi, build = parse_version(bolt.group(1).encode()), parse_version(bolt.group(2).encode())
    return (pi, build[0]) if pi and build else None


def pi_status(found, runtime, bounds, bolt=None):
    """Separate the exact tested token from an accepted, untested version.

    A Pi-Bolt that carries the tested Pi but is not the tested Pi-Bolt release is untested.
    """
    token, version, prerelease = found
    if token == runtime["piVersion"]:
        return "match" if bolt in (None, runtime.get("piBoltVersion")) else "untested_in_range"
    return "untested_in_range" if in_range(version, bounds, prerelease) else "mismatch"


def launcher_runtime(path):
    """The runtime path of a kit launcher: the argument of its `exec` line."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        fail("launcher_unreadable", "check-runtime.launcher")
    for line in lines if len(lines) > 1 and lines[1].startswith(LAUNCHER_MARK) else ():
        if line.startswith("exec "):
            try:
                words = shlex.split(line)
            except ValueError:
                break
            if len(words) == 3 and words[2] == "$@" and os.path.isabs(words[1]):
                return words[1]
    fail("not_a_launcher", "check-runtime.launcher")


def _probe(path, env, run, parse=parse_version):
    """Run `<path> --version` once. Return the parsed version, or a status name."""
    try:
        done = run([path, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                   stderr=subprocess.PIPE, env=env, timeout=TIMEOUT, shell=False, check=False)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return "missing"
    except (subprocess.TimeoutExpired, OSError):
        return "unparsed"
    if done.returncode != 0:
        return "unparsed"
    return parse(done.stdout or done.stderr) or "unparsed"


def _probe_pi(path, environ, run):
    """Pi reads its agent directory at start, so point it at an empty directory and remove that."""
    empty = tempfile.mkdtemp(prefix="tenant-pi-check-runtime-")
    try:
        return _probe(path, {**environ, "PI_CODING_AGENT_DIR": empty}, run, parse_pi_version)
    finally:
        try:
            shutil.rmtree(empty)
        except OSError:
            # The directory stays; say so with a static diagnostic, not a traceback.
            fail("cleanup_failed", "check-runtime.tmpdir")


def check(runtime, paths=None, *, run=subprocess.run, which=shutil.which, environ=None):
    """Compare the installed Pi, Node and Python with a validated `manifest.runtime`.

    `paths` maps a result key to an explicit absolute executable path; a key without one is
    looked up on PATH. At most three processes start, one for each tool that is found.
    """
    paths = paths or {}
    environ = dict(os.environ if environ is None else environ)
    # Read every requirement before a process starts; a bad range starts none.
    bounds = {key: parse_range(runtime["piAcceptedRange" if key == "pi" else field],
                               "manifest.runtime." + ("piAcceptedRange" if key == "pi" else field))
              for key, _, field in TOOLS}
    report = {}
    for key, command, field in TOOLS:
        result = {"installed": None, "required": runtime[field], "status": "missing"}
        if key == "pi":
            result.update(tested=runtime["piVersion"], acceptedRange=runtime["piAcceptedRange"])
        report[key] = result
        path = paths.get(key) or which(command)
        if not path:
            continue
        path = os.path.abspath(path)
        found = _probe_pi(path, environ, run) if key == "pi" else _probe(path, environ, run)
        if isinstance(found, str):
            result["status"] = found
            continue
        bolt = None
        if key == "pi":
            found, bolt = found
        token, version, prerelease = found
        result["installed"] = token
        if bolt:
            result["piBolt"] = {"installed": bolt, "tested": runtime.get("piBoltVersion")}
        result["status"] = (pi_status(found, runtime, bounds[key], bolt) if key == "pi" else
                            "match" if in_range(version, bounds[key], prerelease) else "mismatch")
    return report


def matches(report):
    return all(result["status"] == "match" or (key == "pi" and result["status"] == "untested_in_range")
               for key, result in report.items())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    for key, command, _ in TOOLS:
        parser.add_argument("--" + key, metavar="PATH",
                            help=f"absolute path of the {command} executable (default: {command} on PATH)")
    parser.add_argument("--launcher", metavar="PATH",
                        help="absolute path of a kit launcher; its runtime replaces --pi")
    args = parser.parse_args(argv)
    try:
        paths = {key: getattr(args, key) for key, _, _ in TOOLS if getattr(args, key) is not None}
        for key, path in paths.items():
            absolute(path, "check-runtime." + key)
        if args.launcher is not None:
            absolute(args.launcher, "check-runtime.launcher")
            if "pi" in paths:
                fail("one_of_pi_and_launcher", "check-runtime.launcher")
            paths["pi"] = launcher_runtime(args.launcher)
        data = load(ROOT / "config/manifest.json")
        manifest(data)
        report = check(data["runtime"], paths)
    except Invalid as exc:
        # A refusal goes to standard error; standard output stays empty.
        print(json.dumps({"error": str(exc), **hint_field(exc)}, sort_keys=True, ensure_ascii=True,
                         separators=(",", ":")), file=sys.stderr)
        return 2
    print(json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
    return 0 if matches(report) else 1


if __name__ == "__main__":
    sys.exit(main())
