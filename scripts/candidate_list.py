"""Pure, read-only list of the candidate directories under one explicitly named parent.

Inputs are the already-listed direct entries of the parent and, per child directory, the
already-loaded `.tenant-pi/state.json` or the static rule of its loader failure. The module
reads no file, environment, or host state. From a state record it echoes only five fields,
each in a closed public form. It writes nothing and marks no candidate as current.
"""
from datetime import datetime
import re

from scripts.candidate_compare import PLAIN_VERSION
from scripts.kit_commit import commit
from scripts.profile_write import GENERATED_AT
from scripts.validate import fail, path_segment

MAX_CHILDREN = 1000
MAX_NAME = 255
KINDS = ("file", "dir", "symlink", "other")
STATUSES = ("candidate", "unmanaged", "symlink", "invalid", "unsupported_name")
FIELDS = ("kitSchemaVersion", "piVersion", "filesComplete", "generatedAt", "kitCommit")
RULE = re.compile(r"[a-z_]{1,40}\Z")


def safe_name(name):
    """Whether a child name may be echoed and entered: the kit's target segment form, no edge space."""
    return (type(name) is str and len(name) <= MAX_NAME and name == name.strip()
            and path_segment(name, quotes=True))


def select(entries):
    """Sorted child directories and symlinks, at most `MAX_CHILDREN`; plus omitted and other counts."""
    if type(entries) is not list:
        fail("array", "list.entries")
    for item in entries:
        if type(item) is not tuple or len(item) != 2 or type(item[0]) is not str or not item[0] or item[1] not in KINDS:
            fail("entry", "list.entries")
    if len({name for name, _ in entries}) != len(entries):
        fail("duplicate_entry", "list.entries")
    children = sorted(item for item in entries if item[1] in ("dir", "symlink"))
    return children[:MAX_CHILDREN], max(0, len(children) - MAX_CHILDREN), len(entries) - len(children)


def _generated_at(value):
    if type(value) is not str or not GENERATED_AT.fullmatch(value):
        return False
    try:
        # A real calendar instant; no `strptime`, which imports a module at first use.
        datetime(*(int(value[start:start + size]) for start, size in ((0, 4), (5, 2), (8, 2), (11, 2), (14, 2), (17, 2))))
    except ValueError:
        return False
    return True


PUBLIC = {
    "kitSchemaVersion": lambda v: type(v) is int and 0 <= v < 10 ** 6,
    "piVersion": lambda v: type(v) is str and bool(PLAIN_VERSION.fullmatch(v)),
    "generatedAt": _generated_at,
    "kitCommit": lambda v: commit(v) is not None,
}


def child(name, kind, state=None, error=None):
    """One row. `state` is the loaded record (`None` when absent); `error` is a loader rule."""
    if not safe_name(name):
        return {"name": None, "status": "unsupported_name"}
    if kind == "symlink":
        return {"name": name, "status": "symlink"}
    if kind != "dir":
        fail("entry", "list.entries")
    if error is not None:
        return {"name": name, "status": "invalid", "reason": error if type(error) is str and RULE.fullmatch(error) else "read_or_json"}
    if state is None:
        return {"name": name, "status": "unmanaged"}
    if type(state) is not dict:
        return {"name": name, "status": "invalid", "reason": "unsupported_shape"}
    if type(state.get("schemaVersion")) is not int or state["schemaVersion"] != 1:
        return {"name": name, "status": "invalid", "reason": "unsupported_schema_version"}
    row = {"name": name, "status": "candidate", **dict.fromkeys(FIELDS), "unsupported": []}
    status = state.get("status")
    if status in ("complete", "incomplete"):
        row["filesComplete"] = status == "complete"
    elif "status" in state:
        row["unsupported"].append("filesComplete")
    record = state.get("provenance")
    if "provenance" in state and type(record) is not dict:
        row["unsupported"].append("provenance")
    elif type(record) is dict:
        for field, public in PUBLIC.items():
            if field not in record:
                continue  # An older record has no `generatedAt` or `kitCommit`: the value stays null.
            if public(record[field]):
                row[field] = record[field]
            else:
                row["unsupported"].append(field)
    row["unsupported"].sort()
    return row


def report(parent, rows, omitted, other, diagnostics):
    """The deterministic list of one parent directory; `rows` are `child()` results."""
    rows = sorted(rows, key=lambda row: (row["name"] is None, row["name"] or ""))
    summary = {status: sum(row["status"] == status for row in rows) for status in STATUSES}
    summary.update(children=len(rows), omitted=omitted, notDirectory=other)
    if omitted:
        diagnostics = [*diagnostics, "child_limit: list.parent"]
    return {"parent": parent, "children": rows, "summary": summary, "diagnostics": sorted(diagnostics),
            "scope": "Reads only <child>/.tenant-pi/state.json of each direct child directory. Writes nothing and marks no candidate as current."}
