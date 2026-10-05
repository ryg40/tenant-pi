"""Baseline of one explicitly named directory: entry names, kinds, sizes and modification times.

`scan` lists a directory tree through directory descriptors and reads the status of each
entry. It opens directories only and follows no symbolic link, so no file content can enter
a record. `record`, `saved_record` and `compare` are pure. `write` creates the absent
baseline file with mode 0600 through the ancestor walk and the file creation of the guarded
writer. The module starts no process and reads no environment value.
"""
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import timezone

from scripts.private_init import inside
from scripts.profile_write import GENERATED_AT, WriteError, _ancestors, _create_file
from scripts.validate import absolute, fail

DIR_FIELD = "baseline.dir"
OUT_FIELD = "baseline.out"
SAVED_FIELD = "check-baseline.baseline"
MODE = "0600"
KINDS = ("file", "dir", "symlink", "other")
RESULTS = ("unchanged", "changed", "no_baseline")
FIELDS = ("schemaVersion", "dir", "recordedAt", "present", "mtimeNs", "entries")
# Length bound of the one caller-supplied text that the report of `write` echoes.
MAX_PATH = 1024
# Bound of the direct entries of the directory: the rows of a record and the names of a result.
MAX_ENTRIES = 4096
# Bound of the entries of all levels, and of the directory levels below the directory.
MAX_TREE = 1_000_000
MAX_LEVELS = 64
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
SCOPE = ("Compares the name, kind, size and modification time of each entry at all levels, and names the direct "
         "entries only. Opens no file. Covers the time after recordedAt only.")


@dataclass(frozen=True)
class BaselineResult:
    path: str
    complete: bool
    warnings: tuple[str, ...] = ()


def _kind(mode):
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISDIR(mode):
        return "dir"
    return "file" if stat.S_ISREG(mode) else "other"


def _names(fd):
    """The sorted entry names of one open directory; a directory that went away has none."""
    try:
        with os.scandir(fd) as found:
            return sorted(entry.name for entry in found)
    except FileNotFoundError:
        return []


def _line(path, kind, size, mtime):
    return f"{path}\x00{kind}\x00{size}\x00{mtime}\n".encode("utf-8", "surrogateescape")


def scan(fd):
    """The state of the open directory `fd`: its modification time and one row for each direct entry.

    A row has the name, kind, size and modification time of the entry, from one status call
    that follows no link. The row of a directory also has the count and the total size of the
    entries below it, and a SHA-256 digest of their paths, kinds, sizes and modification
    times, depth first and sorted. Only directories are opened, each without following a link.
    An entry that goes away during the walk is left out. The caller keeps `fd`.
    """
    rows = []
    walked = 0
    stack = [(fd, iter(_names(fd)), "")]
    try:
        while stack:
            current, names, prefix = stack[-1]
            name = next(names, None)
            if name is None:
                stack.pop()
                if stack:
                    os.close(current)
                continue
            try:
                info = os.stat(name, dir_fd=current, follow_symlinks=False)
            except FileNotFoundError:
                continue
            walked += 1
            if walked > MAX_TREE or (len(stack) == 1 and len(rows) == MAX_ENTRIES):
                fail("input_too_large", DIR_FIELD)
            kind = _kind(info.st_mode)
            size = 0 if kind == "dir" else info.st_size
            if len(stack) == 1:
                rows.append({"name": name, "kind": kind, "size": size, "mtimeNs": info.st_mtime_ns,
                             **({"entries": 0, "digest": hashlib.sha256()} if kind == "dir" else {})})
            else:
                rows[-1]["entries"] += 1
                rows[-1]["size"] += size
                rows[-1]["digest"].update(_line(prefix + name, kind, size, info.st_mtime_ns))
            if kind != "dir":
                continue
            if len(stack) > MAX_LEVELS:
                fail("input_too_large", DIR_FIELD)
            try:
                child = os.open(name, _DIR_FLAGS, dir_fd=current)
            except (FileNotFoundError, NotADirectoryError):
                continue  # Gone or replaced since the status call: nothing below it counts.
            try:
                stack.append((child, iter(_names(child)), "" if len(stack) == 1 else prefix + name + "/"))
            except BaseException:
                os.close(child)
                raise
    finally:
        for other, _, _ in stack[1:]:
            os.close(other)
    for row in rows:
        if row["kind"] == "dir":
            row["digest"] = row["digest"].hexdigest()
    return {"mtimeNs": os.fstat(fd).st_mtime_ns, "entries": rows}


def _count(value):
    return type(value) is int and value >= 0


def _row(row):
    if type(row) is not dict or type(row.get("kind")) is not str or row["kind"] not in KINDS:
        return False
    below = row["kind"] == "dir"
    if set(row) != {"name", "kind", "size", "mtimeNs", *(("entries", "digest") if below else ())}:
        return False
    name = row["name"]
    return (type(name) is str and name not in ("", ".", "..") and "/" not in name and "\x00" not in name
            and _count(row["size"]) and type(row["mtimeNs"]) is int
            and (not below or (_count(row["entries"]) and type(row["digest"]) is str
                               and bool(DIGEST.fullmatch(row["digest"])))))


def _record(value):
    if (type(value) is not dict or set(value) != set(FIELDS) or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1 or type(value["dir"]) is not str
            or type(value["recordedAt"]) is not str or not GENERATED_AT.fullmatch(value["recordedAt"])
            or type(value["present"]) is not bool or type(value["entries"]) is not list
            or len(value["entries"]) > MAX_ENTRIES or not all(_row(row) for row in value["entries"])
            or len({row["name"] for row in value["entries"]}) != len(value["entries"])):
        return False
    if not value["present"]:
        return value["mtimeNs"] is None and not value["entries"]
    return type(value["mtimeNs"]) is int


def stamp(clock):
    """The record time as `YYYY-MM-DDTHH:MM:SSZ`, from one call of the injected clock."""
    return clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def record(directory, recorded_at, state):
    """The baseline record of one directory; `state` is a `scan` result, or None for an absent directory."""
    absolute(directory, DIR_FIELD)
    value = {"schemaVersion": 1, "dir": directory, "recordedAt": recorded_at, "present": state is not None,
             "mtimeNs": None if state is None else state["mtimeNs"],
             "entries": [] if state is None else sorted(state["entries"], key=lambda row: row["name"])}
    if not _record(value):
        fail("baseline_record", DIR_FIELD)
    return value


def encode(value):
    """The exact bytes of the baseline file: one JSON object with sorted keys, then a newline."""
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")


def saved_record(saved, directory):
    """Stop when a loaded baseline has another shape or names another directory than `directory`."""
    if not _record(saved):
        fail("baseline_record", SAVED_FIELD)
    if saved["dir"] != directory:
        fail("baseline_dir", "check-baseline.dir")
    return saved


def compare(saved, directory, state):
    """The result of one directory against its baseline.

    `saved` is the loaded baseline record, or None when the baseline file is absent; the
    directory is then not listed and `state` is not used. `state` is a `scan` result, or
    None for an absent directory.
    """
    report = {"dir": directory, "result": "no_baseline", "recordedAt": None, "was": None, "now": None,
              "added": [], "removed": [], "modified": [], "directoryModified": False, "scope": SCOPE}
    if saved is None:
        return report
    saved_record(saved, directory)
    before = {row["name"]: row for row in saved["entries"]}
    after = {row["name"]: row for row in ([] if state is None else state["entries"])}
    report.update(
        recordedAt=saved["recordedAt"], was="present" if saved["present"] else "absent",
        now="absent" if state is None else "present",
        added=sorted(set(after) - set(before)), removed=sorted(set(before) - set(after)),
        modified=sorted(name for name in set(before) & set(after) if before[name] != after[name]),
        # An entry was made, removed or renamed in the directory itself, also when no entry differs now.
        directoryModified=saved["present"] and state is not None and saved["mtimeNs"] != state["mtimeNs"])
    changed = (report["was"] != report["now"] or report["directoryModified"]
               or report["added"] or report["removed"] or report["modified"])
    report["result"] = "changed" if changed else "unchanged"
    return report


def check_location(path, forbidden):
    """Static refusal of a bad baseline path, before any filesystem access.

    `forbidden` is a sequence of (rule, absolute root), as in `private_init.check_location`.
    """
    absolute(path, OUT_FIELD)
    if len(path) > MAX_PATH:
        fail("path_too_long", OUT_FIELD)
    for rule, root in forbidden:
        if inside(path, root):
            fail(rule, OUT_FIELD)


def _parent(path):
    """The open parent directory and the leaf name, through the ancestor walk of the guarded writer."""
    try:
        return _ancestors(path)
    except WriteError as exc:
        raise WriteError(exc.rule, OUT_FIELD + exc.field[len("target"):]) from None
    except FileNotFoundError:
        raise WriteError("parent_missing", OUT_FIELD + ".parent") from None
    except OSError:
        raise WriteError("unsafe_path", OUT_FIELD + ".parents") from None


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
        raise WriteError("cleanup_failed", "baseline.descriptors") from None


def write(path, data):
    """Create the absent baseline file with mode 0600, or raise WriteError. Nothing existing is changed."""
    parent_fd, leaf = _parent(path)
    created = complete = False
    failure = None
    warnings = []
    try:
        # Exclusive creation is the ownership boundary: a baseline is never replaced.
        _create_file(parent_fd, leaf, data)
        created = True
        os.fsync(parent_fd)
        complete = True
    except FileExistsError:
        failure = WriteError("target_exists", OUT_FIELD)
    except WriteError as exc:
        # The shared file creation marks each of its failures as after creation.
        failure = WriteError(exc.rule, OUT_FIELD, candidate_created=True)
    except OSError:
        created = created or _present(parent_fd, leaf)
        failure = WriteError("write_failed" if created else "target_unavailable", OUT_FIELD, candidate_created=created)
    finally:
        try:
            os.close(parent_fd)
        except OSError:
            if complete:
                warnings.append("cleanup_failed: baseline.descriptors")
            elif failure is None:
                failure = WriteError("cleanup_failed", "baseline.descriptors", candidate_created=created)
    if failure is not None:
        raise failure from None
    return BaselineResult(path, True, tuple(warnings))


def report(value, result):
    """The report of a recorded baseline: the directory state in counts, and the created file."""
    return {"dir": value["dir"], "present": value["present"], "recordedAt": value["recordedAt"],
            "summary": {"entries": len(value["entries"]),
                        "below": sum(row.get("entries", 0) for row in value["entries"])},
            "baseline": {"path": result.path, "mode": MODE, "complete": True, "fileCreated": True,
                         "warnings": list(result.warnings)}}
