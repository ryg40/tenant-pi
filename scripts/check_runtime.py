"""Runtime version check: three fixed `--version` processes compared with `manifest.runtime`.

The only kit module that starts a process. It runs no shell, no network request, no install
and no other command. It writes one empty temporary directory and removes it. The output
echoes a version token only; other process output never enters a result or a diagnostic.
"""
import os
import re
import shutil
import subprocess
import tempfile

from scripts.validate import fail

TIMEOUT = 20
# (result key, command name on PATH, manifest.runtime field)
TOOLS = (("pi", "pi", "piVersion"), ("node", "node", "nodeRange"), ("python", "python3", "pythonRange"))
STATUSES = ("match", "mismatch", "missing", "unparsed")
# Only the first line of the output counts, and only this many bytes of it.
MAX_OUTPUT = 256
# The longest version token that the output echoes.
MAX_TOKEN = 40
# `1.0.0`, `v22.22.0`, `Python 3.11.2`: an optional name, an optional `v`, then the token.
# The token is two or three numbers, an optional prerelease (`-rc.1`, `a1`) and an optional
# build (`+abc`). Free text after the numbers is not a version.
VERSION = re.compile(r"(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?v?((\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?"
                     r"(-[0-9A-Za-z.-]+|[a-z]+\d+)?(?:\+[0-9A-Za-z.-]*)?)\Z")
# The minimal grammar of the manifest: `>=a.b.c <d` and `>=a.b`.
RANGE = re.compile(r">=(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?: <(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?)?\Z")


def _triple(parts):
    return tuple(int(part or 0) for part in parts)


def parse_range(value, field):
    """Return `(lower, upper)` as number triples; `upper` is None without a `<` bound."""
    found = RANGE.match(value) if isinstance(value, str) else None
    if not found:
        fail("runtime_range", field)
    return _triple(found.groups()[:3]), (_triple(found.groups()[3:]) if found.group(4) else None)


def in_range(version, bounds, prerelease=False):
    """A prerelease of the lower bound itself is before the bound, as in semver."""
    lower, upper = bounds
    if prerelease and version == lower:
        return False
    return version >= lower and (upper is None or version < upper)


def parse_version(output):
    """Return `(token, number triple, prerelease)` from the first output line, or None."""
    if not isinstance(output, bytes):
        return None
    lines = output[:MAX_OUTPUT].decode("ascii", "replace").strip().splitlines()
    found = VERSION.match(lines[0].strip()) if lines else None
    if not found or len(found.group(1)) > MAX_TOKEN:
        return None
    return found.group(1), _triple(found.groups()[1:4]), found.group(5) is not None


def _probe(path, env, run):
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
    return parse_version(done.stdout or done.stderr) or "unparsed"


def _probe_pi(path, environ, run):
    """Pi reads its agent directory at start, so point it at an empty directory and remove that."""
    empty = tempfile.mkdtemp(prefix="tenant-pi-check-runtime-")
    try:
        return _probe(path, {**environ, "PI_CODING_AGENT_DIR": empty}, run)
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
    bounds = {key: parse_range(runtime[field], "manifest.runtime." + field)
              for key, _, field in TOOLS if key != "pi"}
    report = {}
    for key, command, field in TOOLS:
        result = {"installed": None, "required": runtime[field], "status": "missing"}
        report[key] = result
        path = paths.get(key) or which(command)
        if not path:
            continue
        path = os.path.abspath(path)
        found = _probe_pi(path, environ, run) if key == "pi" else _probe(path, environ, run)
        if isinstance(found, str):
            result["status"] = found
            continue
        token, version, prerelease = found
        result["installed"] = token
        matched = token == runtime[field] if key == "pi" else in_range(version, bounds[key], prerelease)
        result["status"] = "match" if matched else "mismatch"
    return report


def matches(report):
    return all(result["status"] == "match" for result in report.values())
