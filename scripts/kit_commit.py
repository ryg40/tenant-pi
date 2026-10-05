"""Pure parsers of the Git metadata files that name the commit of the kit clone.

The caller reads each file through the bounded no-follow loader and passes its bytes here.
The module reads no file, environment, or host state, and it starts no process: the
generator stays process-free. Every parser returns `None` for any input outside its
closed form, and the caller then records `UNKNOWN`.
"""
import re

UNKNOWN = "unknown"
# Bound of `.git`, `HEAD`, `commondir` and one loose ref file. `packed-refs` uses the loader bound.
MAX_METADATA = 1024
MAX_REF = 255
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_SEGMENT = r"[A-Za-z0-9_-][A-Za-z0-9._-]*"
REF = re.compile(r"refs/(?:" + _SEGMENT + r"/)*" + _SEGMENT + r"\Z")


def commit(value):
    """`value` when it is a 40-hex commit or `UNKNOWN`, else `None`."""
    return value if type(value) is str and (value == UNKNOWN or COMMIT.fullmatch(value)) else None


def _line(data):
    """The single printable ASCII line of one small metadata file, or `None`."""
    if type(data) is not bytes or len(data) > MAX_METADATA:
        return None
    try:
        text = data.decode("ascii")
    except UnicodeError:
        return None
    if text.endswith("\n"):
        text = text[:-1]
    return text if text and text.isprintable() else None


def _ref(name):
    if len(name) > MAX_REF or ".." in name or name.endswith(".lock") or not REF.fullmatch(name):
        return None
    return name


def head(data):
    """`("commit", sha)` for a detached `HEAD`, `("ref", name)` for `ref: refs/...`, else `None`."""
    line = _line(data)
    if line is None:
        return None
    if COMMIT.fullmatch(line):
        return ("commit", line)
    if line.startswith("ref: ") and (name := _ref(line[5:])) is not None:
        return ("ref", name)
    return None


def pointer(data, prefix=""):
    """The path of a `.git` file (`prefix="gitdir: "`) or of a `commondir` file, else `None`."""
    line = _line(data)
    if line is None or not line.startswith(prefix) or not line[len(prefix):]:
        return None
    return line[len(prefix):]


def loose(data):
    """The commit of one loose ref file; a symbolic ref is not followed."""
    line = _line(data)
    return line if line is not None and COMMIT.fullmatch(line) else None


def packed(data, name):
    """The commit of ref `name` in a `packed-refs` file, else `None`."""
    if type(data) is not bytes:
        return None
    try:
        text = data.decode("ascii")
    except UnicodeError:
        return None
    for line in text.split("\n"):
        if line.startswith(("#", "^")):
            continue
        value, _, ref = line.partition(" ")
        if ref == name and COMMIT.fullmatch(value):
            return value
    return None
