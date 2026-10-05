"""Write-once launcher file of one generated profile: `#!/bin/sh` and one `exec` line."""
import os
import re
import stat
from dataclasses import dataclass

from scripts.private_init import inside
from scripts.profile_write import WriteError, _ancestors, _create_file
from scripts.validate import absolute, fail

FIELD = "launcher.path"
MODE = "0700"
# Length bound of the one caller-supplied text that the reports echo.
MAX_PATH = 1024
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


def check_location(path, forbidden):
    """Static refusal of a bad launcher path, before any filesystem access.

    `forbidden` is a sequence of (rule, absolute root), as in `private_init.check_location`.
    """
    absolute(path, FIELD)
    if len(path) > MAX_PATH:
        fail("path_too_long", FIELD)
    for rule, root in forbidden:
        if inside(path, root):
            fail(rule, FIELD)


def _renamed(exc, created):
    return WriteError(exc.rule, FIELD + exc.field[len("target"):], candidate_created=created)


def _parent(path):
    """The open parent directory and the leaf name, through the ancestor walk of the guarded writer."""
    try:
        return _ancestors(path)
    except WriteError as exc:
        raise _renamed(exc, False) from None
    except FileNotFoundError:
        raise WriteError("parent_missing", FIELD + ".parent") from None
    except OSError:
        raise WriteError("unsafe_path", FIELD + ".parents") from None


def _present(parent_fd, leaf):
    try:
        os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return True


def preflight(path):
    """Run the ancestor and absence checks without a write; raise WriteError on a refusal."""
    parent_fd, _ = _parent(path)
    try:
        os.close(parent_fd)
    except OSError:
        raise WriteError("cleanup_failed", "launcher.descriptors") from None


def write(path, launch):
    """Create the absent launcher file with mode 0700, or raise WriteError. Nothing existing is changed."""
    data = text(launch)
    parent_fd, leaf = _parent(path)
    created = complete = False
    failure = None
    warnings = []
    try:
        # Exclusive creation is the ownership boundary: an entry that appears after the preflight is refused.
        _create_file(parent_fd, leaf, data, 0o700)
        created = True
        os.fsync(parent_fd)
        named = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(named.st_mode) or stat.S_IMODE(named.st_mode) != 0o700 or named.st_uid != os.geteuid():
            raise WriteError("target_changed", "target")
        complete = True
    except FileExistsError:
        failure = WriteError("target_exists", FIELD)
    except WriteError as exc:
        # The shared file creation marks each of its failures as after creation.
        failure = WriteError(exc.rule, FIELD, candidate_created=True)
    except OSError:
        # The shared file creation does not say whether the open or the write failed; an entry
        # at the name after a failure other than "exists" is the file that this call created.
        created = created or _present(parent_fd, leaf)
        failure = WriteError("write_failed" if created else "target_unavailable", FIELD, candidate_created=created)
    finally:
        try:
            os.close(parent_fd)
        except OSError:
            if complete:
                warnings.append("cleanup_failed: launcher.descriptors")
            elif failure is None:
                failure = WriteError("cleanup_failed", "launcher.descriptors", candidate_created=created)
    if failure is not None:
        raise failure from None
    return LauncherResult(path, True, tuple(warnings))


def report(result):
    """The `launcher` value of a successful `generate` report."""
    return {"path": result.path, "mode": MODE, "complete": True, "fileCreated": True, "warnings": list(result.warnings)}


def failure(path, exc):
    """The `launcher` value after a failed write: the profile stays complete, the diagnostic is static."""
    return {"path": path, "complete": False, "fileCreated": getattr(exc, "candidate_created", False), "error": str(exc)}
