"""New-directory-only creation of the private directory that holds the overlay and its records."""
import json
import os
import shlex
import stat
from dataclasses import dataclass

from scripts.profile_write import MAX_PATH, WriteError, DIR_FLAGS, check_location, create_new_file, open_new_parent
from scripts.validate import SAMPLE_TARGET, absolute, fail

FIELD = "init-private.dir"
TARGET = "init-private.target"
# Created file name -> tracked template, relative to the kit root. The overlay is the example itself,
# or the example with the `target.agentDir` of `--target`.
TEMPLATES = {
    "overlay.json": "config/config.example.json",
    "registry.json": "config/private/registry.json",
    "install-log.md": "config/private/install-log.md",
    "accepted-drift.md": "config/private/accepted-drift.md",
    ".gitignore": "config/private/gitignore",
}
INPUTS = "inputs"  # Holds the fixed overlay.inputs slots; the .gitignore template ignores it.


@dataclass(frozen=True)
class InitResult:
    directory: str
    complete: bool
    warnings: tuple[str, ...] = ()


def check_target(target):
    """Static refusal of a bad `--target` form, before any filesystem access; the caller checks its location."""
    absolute(target, TARGET)
    if len(target) > MAX_PATH:
        fail("path_too_long", TARGET)
    if target == SAMPLE_TARGET:
        fail("sample_target", TARGET)


def with_target(template, target):
    """The overlay bytes with `target.agentDir` replaced, in the form that `scripts/examples.py` renders.

    `template` is the parsed overlay template. Only that one value differs from the template file.
    """
    data = {**template, "target": {**template["target"], "agentDir": target}}
    return (json.dumps(data, indent=2) + "\n").encode("utf-8")


def _renamed(exc, created):
    return WriteError(exc.rule, FIELD + exc.field[len("target"):], candidate_created=created)


def init(directory, contents, forbidden=()):
    """Create the absent private directory with exactly the files of TEMPLATES, or raise.

    `contents` maps each created file name to its bytes. Raises Invalid before any
    filesystem access and WriteError after; nothing existing is adopted or changed.
    """
    check_location(directory, forbidden, FIELD)
    if (type(contents) is not dict or set(contents) != set(TEMPLATES)
            or any(type(data) is not bytes for data in contents.values())):
        fail("fields", "init-private.templates")
    try:
        parent_fd, leaf = open_new_parent(directory)
    except WriteError as exc:
        raise _renamed(exc, False) from None
    except FileNotFoundError:
        raise WriteError("parent_missing", FIELD + ".parent") from None
    except OSError:
        raise WriteError("unsafe_path", FIELD + ".parents") from None
    created = False
    complete = False
    dir_fd = inputs_fd = None
    failure = None
    warnings = []
    try:
        # Exclusive directory creation is the ownership boundary. Never adopt it.
        os.mkdir(leaf, 0o700, dir_fd=parent_fd)
        created = True
        dir_fd = os.open(leaf, DIR_FLAGS, dir_fd=parent_fd)
        info = os.fstat(dir_fd)
        if (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
                or not stat.S_ISDIR(info.st_mode)):
            raise WriteError("dir_privacy", "target")
        os.fsync(parent_fd)
        os.mkdir(INPUTS, 0o700, dir_fd=dir_fd)
        inputs_fd = os.open(INPUTS, DIR_FLAGS, dir_fd=dir_fd)
        inputs = os.fstat(inputs_fd)
        if inputs.st_uid != os.geteuid() or stat.S_IMODE(inputs.st_mode) != 0o700:
            raise WriteError("dir_privacy", "target.inputs")
        for name in TEMPLATES:
            create_new_file((dir_fd, name), contents[name], 0o600, FIELD)
        os.fsync(inputs_fd)
        os.fsync(dir_fd)
        named = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise WriteError("target_changed", "target")
        complete = True
    except WriteError as exc:
        failure = _renamed(exc, created)
    except OSError:
        failure = WriteError("write_failed" if created else "target_unavailable", FIELD, candidate_created=created)
    finally:
        # Close each owned descriptor once. A failure after the last file is a static warning
        # in the result, not an incomplete directory; before that, the primary error stays.
        for fd in (inputs_fd, dir_fd, parent_fd):
            if fd is None:
                continue
            try:
                os.close(fd)
            except OSError:
                if complete:
                    warnings.append("cleanup_failed: init-private.descriptors")
    if failure is not None:
        raise failure from None
    return InitResult(directory, True, tuple(dict.fromkeys(warnings)))


def report(result, kit_root, target=None):
    """The deterministic report: created paths with modes, and three display-only lines.

    With `target`, also the `target.agentDir` that the new overlay holds.
    """
    directory = result.directory
    overlay = directory + "/overlay.json"
    return {
        "directory": directory,
        "complete": result.complete,
        "warnings": list(result.warnings),
        "created": ([{"path": directory, "mode": "0700", "kind": "directory"},
                     {"path": directory + "/" + INPUTS, "mode": "0700", "kind": "directory"}]
                    + [{"path": directory + "/" + name, "mode": "0600", "kind": "file"} for name in sorted(TEMPLATES)]),
        "commands": {
            "editDisplayOnly": "${EDITOR:-vi} " + shlex.quote(overlay),
            "validateDisplayOnly": ("python3 " + shlex.quote(kit_root + "/scripts/tenant_pi.py") + " validate --overlay "
                                    + shlex.quote(overlay) + " --local-dir " + shlex.quote(directory)),
            "gitInitDisplayOnly": "git init " + shlex.quote(directory),
        },
        **({} if target is None else {"targetAgentDir": target}),
    }
