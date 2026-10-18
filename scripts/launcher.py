"""Write-once launcher file of one generated profile: `#!/bin/sh` and one `exec` line."""
import re
from dataclasses import dataclass

from scripts.profile_write import create_new_file
from scripts.validate import fail

FIELD = "launcher.path"
MODE = "0700"
# The launch line is one line of printable ASCII; the plan builds it from validated values only.
LINE = re.compile(r"[\x20-\x7e]+\Z")
# `exec NAME=value cmd` fails in a POSIX shell: `exec` takes a command, not an assignment.
# `env` applies the assignments of the line to the one `pi` process, as the line does when typed.
PREFIX = "exec env "


@dataclass(frozen=True)
class LauncherResult:
    path: str
    complete: bool
    warnings: tuple[str, ...] = ()


def text(launch):
    """The exact launcher bytes: the shebang, then one `exec` line that holds `launch` byte for byte."""
    if type(launch) is not str or not LINE.fullmatch(launch):
        fail("launch_line", "launcher.content")
    return ("#!/bin/sh\n" + PREFIX + launch + "\n").encode("ascii")


def write(path, launch):
    """Create the absent launcher with mode 0700."""
    result = create_new_file(path, text(launch), 0o700, FIELD)
    return LauncherResult(result.path, result.complete, result.warnings)


def report(result):
    """The `launcher` value of a successful `generate` report."""
    return {"path": result.path, "mode": MODE, "complete": True, "fileCreated": True, "warnings": list(result.warnings)}


def failure(path, exc):
    """The `launcher` value after a failed write: the profile stays complete, the diagnostic is static."""
    return {"path": path, "complete": False, "fileCreated": getattr(exc, "candidate_created", False), "error": str(exc)}
