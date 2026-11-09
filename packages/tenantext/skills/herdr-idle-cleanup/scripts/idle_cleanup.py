#!/usr/bin/env python3
"""herdr-idle-cleanup: find idle Herdr workspaces. Standard library only.

Usage:
  idle_cleanup.py scan [--idle-minutes N] [--protect <workspace-name-or-id>]... [--out <path>]
  idle_cleanup.py harvest [--scan <path>] [--summarize] [--model-rank]
  idle_cleanup.py close [--scan <path>] [--protect <workspace-name-or-id>]... [--close [--yes]]
  idle_cleanup.py startup --cwd <dir> [--format text|json]
  idle_cleanup.py entries list [--cwd <dir>] | show <id> | set <id> open|acknowledged|done|dismissed
  idle_cleanup.py publish <handoff stem or path> [--upload]
  idle_cleanup.py switch [on|off|status] [--json]

scan     Lists every workspace, tab and pane, classifies each workspace, prints a table and writes
         scan.json (default ~/.local/share/tenant-pi/handoffs/scan.json). It changes nothing in Herdr.
harvest  Reads scan.json, takes the final reply of each agent pane of an `idle` workspace, parses its
         Dummies report, ranks the entries P1 to P3 and writes <stamp>.md, <stamp>.json and index.json
         to the handoff directory. It makes no Herdr call. The schema: references/handoff-schema.md.
close    Plans by default: lists each workspace of scan.json that it would close and each one that it keeps,
         with the keep reason. A fresh read of Herdr checks each candidate again. Only `--close --yes` closes,
         by workspace ID, after it writes the resume data into index.json. The plan code is in idle_close.py.
startup  Claims the open entries of the repository of --cwd (at most 3) and prints the assessment prompt;
         prints nothing when no entry matches. Code in entries.py.
entries  Lists, shows and sets the state of the entries of index.json. Code in entries.py.
publish  Renders a handoff to self-contained HTML beside it and runs the secret scanner on both files. Only with
         --upload and a clean scan: one upload to the artifact service of the settings. Code in publish.py.
switch   Turns the startup check (the claim and the assessment of `startup`) on or off for Pi and Claude Code
         together, through the key startup_assessment, or prints its state. No argument means status.

Settings file (optional): ${XDG_CONFIG_HOME:-~/.config}/herdr-idle-cleanup/settings.json with the keys
idle_minutes, protected_workspaces, handoff_dir, model_command, startup_assessment,
startup_assessment_before_off (written by switch), startup_other_count, secret_scan_command, publish_url,
publish_token_file.
A flag wins over the file.
"""
import argparse
import datetime
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time

HERDR_SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                             "herdr", "scripts")
sys.path.insert(0, HERDR_SCRIPTS)
import _common  # noqa: E402
import idle_close as cl  # noqa: E402  (the folder of this script is on sys.path; herdr/scripts has its own close.py)
import harvest as hv  # noqa: E402
import entries  # noqa: E402
import publish as pb  # noqa: E402

SCAN_VERSION = 1
DEFAULT_IDLE_MINUTES = 30
DEFAULT_HANDOFF_DIR = os.path.join("~", ".local", "share", "tenant-pi", "handoffs")
# Seconds that one Herdr call may take. A call that times out counts as a failed read.
HERDR_TIMEOUT = 30

# The classes in the order of precedence: when more than one applies, the first one wins.
CLASSES = ("protected", "blocked", "active", "unknown", "idle")

# The only Herdr subcommands that the scan may run. Each one reads state; nothing else runs.
READ_ALLOWLIST = frozenset({
    ("workspace", "list"),
    ("tab", "list"),
    ("pane", "list"),
    ("agent", "list"),
    ("agent", "get"),
    ("agent", "read"),
})

# Screen text that shows a pending question or approval. A match on the visible screen of an agent
# pane makes its workspace `blocked`, also when Herdr reports `idle` or `done`. Case-insensitive.
# Covers the permission and question dialogs of Claude Code and the confirm prompts of Pi. Each line is
# matched after its leading and trailing spaces are removed. A false match only turns `idle` into `blocked`,
# the safe direction, so the patterns are wide.
PENDING_QUESTION_PATTERNS = (
    r"\bdo you want to\b",
    r"\bwould you like to\b",
    r"\bdo you trust\b",
    r"\[y/n\]",
    r"^[❯>]?\s*\d+\.\s+(yes|no)\b",
    r"enter to select",
    r"esc to cancel",
    r"\byes, and don't ask again\b",
    r"\b(allow|approve|deny)\b.*\?\s*$",
    r"\((y/n|yes/no)\)",
    r"waiting for (your )?(approval|answer|input|confirmation)",
    r"press enter to (confirm|continue)",
)
_PENDING_RE = re.compile("|".join(f"(?:{p})" for p in PENDING_QUESTION_PATTERNS), re.IGNORECASE | re.MULTILINE)

# Screen text of a Claude Code footer while a background agent runs, for example `← 1 agent` or `← 2 agents`.
# The pane can show `idle` or `done` with an old transcript then. A match makes its workspace `active`.
BACKGROUND_AGENT_PATTERNS = (
    r"←\s*\d+\s+agents?\b",
)
_BACKGROUND_RE = re.compile("|".join(f"(?:{p})" for p in BACKGROUND_AGENT_PATTERNS), re.IGNORECASE)

# Time fields that a Herdr version may give for the last activity of a pane (epoch seconds or ISO 8601).
# Herdr 0.9 gives none; then the scan uses the modification time of the transcript or Pi session file.
HERDR_TIME_KEYS = ("last_activity_at", "last_activity", "last_output_at", "updated_at")


# The only state-changing Herdr subcommand of this skill. Only close_workspace() runs it.
CLOSE_ALLOWLIST = frozenset({("workspace", "close")})


class HerdrWriteRefused(RuntimeError):
    """A Herdr subcommand outside READ_ALLOWLIST was requested."""


# The low-level runner: (exit_code, parsed_json_or_None, raw_text). Tests replace it with a stub.
HERDR_RUNNER = _common.herdr


def read_herdr(*args):
    """Run one read subcommand of Herdr. Refuse each subcommand outside READ_ALLOWLIST."""
    if tuple(args[:2]) not in READ_ALLOWLIST:
        raise HerdrWriteRefused(f"refused Herdr call outside the read allowlist: herdr {' '.join(args)}")
    return HERDR_RUNNER(*args, timeout=HERDR_TIMEOUT)


def close_workspace(workspace_id):
    """Close one Herdr workspace by its ID. The only state-changing Herdr call; (exit_code, data, raw)."""
    args = ("workspace", "close", workspace_id)
    if args[:2] not in CLOSE_ALLOWLIST or not isinstance(workspace_id, str) or not workspace_id \
            or workspace_id.startswith("-"):
        raise HerdrWriteRefused(f"refused Herdr close call: herdr {' '.join(map(str, args))}")
    return HERDR_RUNNER(*args, timeout=HERDR_TIMEOUT)


def _result(args, key):
    code, data, raw = read_herdr(*args)
    if code != 0 or not data or _common.error_code(data):
        return None, raw
    return data.get("result", {}).get(key), raw


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
def positive_minutes(value):
    """value as a float when it is a finite number above 0; ValueError otherwise."""
    if isinstance(value, bool):
        raise ValueError("not a number")
    minutes = float(value)
    if not math.isfinite(minutes) or minutes <= 0:
        raise ValueError("not a finite number above 0")
    return minutes


def _minutes_arg(text):
    try:
        return positive_minutes(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a finite number of minutes above 0")


def settings_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "herdr-idle-cleanup", "settings.json")


# `switch off` keeps the value before the off here, and `switch on` restores it. The state of the switch is
# startup_assessment alone.
BEFORE_OFF_KEY = "startup_assessment_before_off"
BEFORE_OFF_VALUES = ("all", "p1")


def load_settings(path=None):
    """The settings file as a dict. A missing file gives {}; an invalid file stops with its path and reason."""
    path = path or settings_path()
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        sys.exit(f"error: invalid settings file {path}: {e}")
    problems = []
    if not isinstance(data, dict):
        problems.append("the top level is not an object")
    else:
        v = data.get("idle_minutes")
        if v is not None:
            try:
                if not isinstance(v, (int, float)):
                    raise ValueError
                positive_minutes(v)
            except ValueError:
                problems.append("idle_minutes is not a finite number above 0")
        v = data.get("protected_workspaces")
        if v is not None and (not isinstance(v, list) or not all(isinstance(x, str) for x in v)):
            problems.append("protected_workspaces is not a list of strings")
        v = data.get("handoff_dir")
        if v is not None and not isinstance(v, str):
            problems.append("handoff_dir is not a string")
        v = data.get("model_command")
        if v is not None and (not isinstance(v, list) or not v or not all(isinstance(x, str) and x for x in v)):
            problems.append("model_command is not a non-empty list of non-empty strings")
        v = data.get(BEFORE_OFF_KEY)
        if v is not None and v not in BEFORE_OFF_VALUES:
            problems.append(f"{BEFORE_OFF_KEY} is not one of {', '.join(BEFORE_OFF_VALUES)}")
        v = data.get("secret_scan_command")
        if v is not None and (not isinstance(v, list) or not v or not all(isinstance(x, str) and x for x in v)):
            problems.append("secret_scan_command is not a non-empty list of non-empty strings")
        for key in ("publish_url", "publish_token_file"):
            v = data.get(key)
            if v is not None and (not isinstance(v, str) or not v):
                problems.append(f"{key} is not a non-empty string")
    if problems:
        sys.exit(f"error: invalid settings file {path}: {'; '.join(problems)}")
    return data


# ---------------------------------------------------------------------------
# Facts of one pane
# ---------------------------------------------------------------------------
def _epoch(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) / 1000 if value > 1e11 else float(value)
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def last_activity(info):
    """(epoch, source, transcript_path) of the last activity of an agent pane; epoch None when unknown."""
    for key in HERDR_TIME_KEYS:
        when = _epoch(info.get(key))
        if when is not None:
            return when, f"herdr:{key}", _common.session_file(info)
    path = _common.session_file(info)
    source = "transcript"
    if not path and info.get("agent") in _common.PI_AGENTS:
        # The fallback of last-reply.py: the Pi session file that an earlier prompt matched in this pane.
        path = _common.saved_pi_session(info)
        source = "pi-session-file"
    if path:
        try:
            return os.path.getmtime(path), source, path
        except OSError:
            pass
    return None, "none", None


def screen_facts(pane_id):
    """(readable, question_line, background_line) of the visible screen of a pane.

    readable is False when the screen could not be read: a non-zero exit (124 for a timeout), an error
    object or no text. Then both lines are None and the pane cannot prove that no question is pending.
    Otherwise question_line is the first line that matches PENDING_QUESTION_PATTERNS and background_line
    the first line that matches BACKGROUND_AGENT_PATTERNS, each one or None.
    """
    code, data, raw = read_herdr("agent", "read", pane_id, "--source", "visible")
    if code != 0 or _common.error_code(data):
        return False, None, None
    text = raw or ""
    if isinstance(data, dict):
        r = data.get("result") or {}
        text = (r.get("read") or r).get("text") or ""
    if not text.strip():
        return False, None, None
    question = background = None
    for line in text.splitlines():
        line = line.strip()
        if question is None and _PENDING_RE.search(line):
            question = line[:120]
        if background is None and _BACKGROUND_RE.search(line):
            background = line[:120]
    return True, question, background


def git_state(cwd, cache):
    """(top_level, dirty) of the checkout of cwd; (None, None) when cwd is not in a Git checkout."""
    if not cwd:
        return None, None
    if cwd in cache:
        return cache[cwd]
    top, dirty = None, None
    try:
        p = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            top = p.stdout.strip()
            # No index lock and no fsmonitor program from the configuration of the checkout.
            s = subprocess.run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", top,
                                "status", "--porcelain"],
                               capture_output=True, text=True, timeout=30)
            dirty = bool(s.stdout.strip()) if s.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        pass
    cache[cwd] = (top, dirty)
    return top, dirty


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------
def classify(ws, agent_panes, protected, caller_ws, now, idle_seconds):
    """(class, reason) of one workspace. The first class of CLASSES that applies wins."""
    wid, label = ws.get("workspace_id"), ws.get("label") or ""
    if wid == caller_ws:
        return "protected", "the caller's own workspace"
    if wid in protected or (label and label in protected):
        return "protected", "named in the protected setting"
    for p in agent_panes:
        if p["status"] == "blocked":
            return "blocked", f"pane {p['pane_id']} has Herdr status blocked"
    for p in agent_panes:
        if p["pending_question"]:
            return "blocked", f"pane {p['pane_id']} shows a pending question: {p['pending_question']}"
    for p in agent_panes:
        if p["status"] == "working":
            return "active", f"pane {p['pane_id']} is working"
    for p in agent_panes:
        if p.get("background_agent"):
            return "active", f"pane {p['pane_id']} runs a background agent: {p['background_agent']}"
    for p in agent_panes:
        if p["last_activity_epoch"] is not None and now - p["last_activity_epoch"] < idle_seconds:
            mins = int((now - p["last_activity_epoch"]) // 60)
            return "active", f"pane {p['pane_id']} was active {mins} min ago"
    if not agent_panes:
        return "unknown", "no agent detected"
    for p in agent_panes:
        if p["status"] not in ("idle", "done"):
            return "unknown", f"pane {p['pane_id']} has Herdr status {p['status'] or 'none'}"
    for p in agent_panes:
        if not p.get("screen_readable"):
            return "unknown", f"pane {p['pane_id']} screen could not be read, so a pending question is not ruled out"
    for p in agent_panes:
        if p["last_activity_epoch"] is None:
            return "unknown", f"pane {p['pane_id']} has no transcript or session file to prove idle"
    oldest = min(int((now - p["last_activity_epoch"]) // 60) for p in agent_panes)
    return "idle", f"{len(agent_panes)} agent pane(s) idle or done, last activity {oldest} min ago"


def caller_workspace(pane_list):
    me = os.environ.get("HERDR_PANE_ID")
    for p in pane_list:
        if me and p.get("pane_id") == me:
            return p.get("workspace_id")
    return os.environ.get("HERDR_WORKSPACE_ID")


def read_lists():
    """(workspaces, pane_list, agent names by pane, caller workspace) from the list calls of Herdr."""
    workspaces, raw = _result(("workspace", "list"), "workspaces")
    if workspaces is None:
        raise RuntimeError(f"herdr workspace list failed: {raw[:300]}")
    pane_list, raw = _result(("pane", "list"), "panes")
    if pane_list is None:
        raise RuntimeError(f"herdr pane list failed: {raw[:300]}")
    agents, _ = _result(("agent", "list"), "agents")
    names = {a.get("pane_id"): a.get("name") for a in agents or []}
    caller_ws = caller_workspace(pane_list)
    if caller_ws is None:
        raise RuntimeError("cannot name the caller's workspace: HERDR_PANE_ID is not in the pane list "
                           "and HERDR_WORKSPACE_ID is not set")
    return workspaces, pane_list, names, caller_ws


def scan_workspace(ws, pane_list, names, protected, caller_ws, now, idle_seconds, git_cache):
    """The scan.json record of one workspace: its tabs, its panes and its class. Only read calls."""
    wid = ws.get("workspace_id")
    tabs, _ = _result(("tab", "list", "--workspace", wid), "tabs")
    tab_labels = {t.get("tab_id"): t.get("label") for t in tabs or []}
    panes_out, agent_panes = [], []
    for p in (x for x in pane_list if x.get("workspace_id") == wid):
        pid = p.get("pane_id")
        entry = {"pane_id": pid, "tab_id": p.get("tab_id"), "tab": tab_labels.get(p.get("tab_id")),
                 "agent": p.get("agent"), "name": names.get(pid), "status": p.get("agent_status"),
                 "cwd": p.get("foreground_cwd") or p.get("cwd")}
        if p.get("agent"):
            info, _ = _result(("agent", "get", pid), "agent")
            info = info or dict(p, name=names.get(pid))
            entry["status"] = info.get("agent_status") or entry["status"]
            when, source, transcript = last_activity(info)
            top, dirty = git_state(entry["cwd"], git_cache)
            readable, question, background = (True, None, None) if entry["status"] == "blocked" \
                else screen_facts(pid)
            entry.update({
                "last_activity_epoch": when, "activity_source": source, "transcript": transcript,
                "idle_minutes": None if when is None else int((now - when) // 60),
                "pending_question": question, "background_agent": background, "screen_readable": readable,
                "git_top": top, "git_dirty": dirty,
            })
            agent_panes.append(entry)
        panes_out.append(entry)
    cls, reason = classify(ws, agent_panes, protected, caller_ws, now, idle_seconds)
    return {"workspace_id": wid, "label": ws.get("label"), "class": cls, "reason": reason,
            "herdr_status": ws.get("agent_status"),
            "tabs": [{"tab_id": t.get("tab_id"), "label": t.get("label")} for t in tabs or []],
            "panes": panes_out}


def scan(idle_minutes=DEFAULT_IDLE_MINUTES, protected=(), now=None):
    """The scan result as a dict (the content of scan.json). Only read calls go to Herdr."""
    idle_minutes = positive_minutes(idle_minutes)
    now = time.time() if now is None else now
    protected = set(protected)
    workspaces, pane_list, names, caller_ws = read_lists()
    git_cache = {}
    out_ws = [scan_workspace(ws, pane_list, names, protected, caller_ws, now, idle_minutes * 60, git_cache)
              for ws in workspaces]
    return {
        "version": SCAN_VERSION,
        "scanned_at": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(timespec="seconds"),
        "scanned_at_epoch": now,
        "idle_minutes": idle_minutes,
        "caller": {"pane_id": os.environ.get("HERDR_PANE_ID"), "workspace_id": caller_ws},
        "protected_setting": sorted(protected),
        "classes": {c: sum(1 for w in out_ws if w["class"] == c) for c in CLASSES},
        "workspaces": out_ws,
    }


def fresh_workspace(workspace_id, protected, idle_minutes, now=None):
    """(record, caller workspace) of one workspace from a new read of Herdr, as scan() gives it.

    record is None when the workspace is gone. The same classification as scan(); only read calls.
    """
    now = time.time() if now is None else now
    workspaces, pane_list, names, caller_ws = read_lists()
    ws = next((w for w in workspaces if w.get("workspace_id") == workspace_id), None)
    if ws is None:
        return None, caller_ws
    return scan_workspace(ws, pane_list, names, set(protected), caller_ws, now,
                          positive_minutes(idle_minutes) * 60, {}), caller_ws


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def write_json_atomic(path, data):
    """Write data to path through a temporary file and a rename. A new directory gets mode 0700, the file 0600."""
    write_text_atomic(path, json.dumps(data, indent=2) + "\n")


def make_private_dir(directory):
    """Create directory with mode 0700. An existing directory, also one that another process makes now, stays as it is."""
    if os.path.isdir(directory):
        return
    try:
        os.makedirs(directory, mode=0o700)
    except FileExistsError:
        return
    os.chmod(directory, 0o700)  # only a directory that this call creates


def write_text_atomic(path, text, mode=0o600):
    """Write text to path through a temporary file, an fsync and a rename. A new directory gets mode 0700, the file mode."""
    directory = os.path.dirname(os.path.abspath(path))
    make_private_dir(directory)
    fd, tmp = tempfile.mkstemp(prefix=".tmp.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def format_table(result):
    lines = ["CLASS\tWORKSPACE\tID\tREASON"]
    for w in result["workspaces"]:
        lines.append(f"{w['class']}\t{w['label'] or '-'}\t{w['workspace_id']}\t{w['reason']}")
    lines += ["", "PANE\tWORKSPACE\tAGENT\tSTATUS\tIDLE_MIN\tGIT_DIRTY\tGIT_TOP\tCWD"]
    for w in result["workspaces"]:
        for p in w["panes"]:
            if not p.get("agent"):
                continue
            dirty = {True: "yes", False: "no", None: "-"}[p["git_dirty"]]
            idle = "-" if p["idle_minutes"] is None else str(p["idle_minutes"])
            lines.append("\t".join([p["pane_id"], w["label"] or w["workspace_id"], p["agent"], p["status"] or "-",
                                    idle, dirty, p["git_top"] or "-", p["cwd"] or "-"]))
    counts = ", ".join(f"{c} {n}" for c, n in result["classes"].items())
    lines += ["", f"workspaces: {len(result['workspaces'])} ({counts})"]
    return "\n".join(lines)


def cmd_scan(args):
    settings = load_settings()
    idle_minutes = args.idle_minutes if args.idle_minutes is not None else settings.get(
        "idle_minutes", DEFAULT_IDLE_MINUTES)
    protected = list(settings.get("protected_workspaces") or []) + list(args.protect or [])
    out = args.out or os.path.join(os.path.expanduser(settings.get("handoff_dir") or DEFAULT_HANDOFF_DIR),
                                   "scan.json")
    try:
        result = scan(idle_minutes=idle_minutes, protected=protected)
    except RuntimeError as e:
        sys.exit(f"error: {e}")
    write_json_atomic(out, result)
    print(format_table(result))
    print(f"scan.json: {out}")
    return 0


# ---------------------------------------------------------------------------
# Harvest (the parse, rank, lock and format code is in harvest.py)
# ---------------------------------------------------------------------------
def _priority_rank(priority):
    """1 for P1, 2 for P2, 3 for P3; an unknown priority ranks above P1, so no record supersedes it."""
    return {"P1": 1, "P2": 2, "P3": 3}.get(priority, 0)


def update_index(index_path, entries, handoff_name, created):
    """Add the new entries to index.json under the lock. (total, added).

    Older entries keep their state and their unknown fields. A new entry of a pane supersedes each older `open`
    entry of the same pane with the same or a lower priority (P1 is the highest): that one gets the state
    `dismissed` and `superseded_by` with the new id. An older entry of a higher priority stays `open`.
    """
    with hv.IndexLock(index_path):
        index = hv.read_index(index_path)
        known = {r.get("id") for r in index["entries"]}
        added = 0
        for e in entries:
            if e["id"] in known:
                continue
            index["entries"].append({
                "id": e["id"], "repo": e["repo"], "workspace": e["workspace"], "workspace_label": e["workspace_label"],
                "pane": e["pane"], "agent": e["agent"], "cwd": e["cwd"], "source": e["source"]["path"],
                "priority": e["priority"], "reason": e["reason"], "state": "open", "created_at": created,
                "handoff": handoff_name})
            for r in index["entries"][:-1]:
                if (r.get("pane") == e["pane"] and r.get("state") == "open"
                        and _priority_rank(e["priority"]) <= _priority_rank(r.get("priority"))):
                    r["state"], r["superseded_by"] = "dismissed", e["id"]
            known.add(e["id"])
            added += 1
        write_json_atomic(index_path, index)
    return len(index["entries"]), added


def reserve_handoff_names(handoff_dir, stamp):
    """(base, md_path, json_path): reserve both file names with exclusive create; `-2`, `-3` on a clash."""
    n = 1
    while True:
        base = stamp if n == 1 else f"{stamp}-{n}"
        paths = [os.path.join(handoff_dir, base + ext) for ext in (".md", ".json")]
        made = []
        try:
            for path in paths:
                os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                made.append(path)
            return base, paths[0], paths[1]
        except FileExistsError:
            for path in made:  # our own empty reservation
                os.remove(path)
            n += 1


def load_scan(scan_path):
    """The content of scan.json; RuntimeError when it is not readable or has another version."""
    try:
        with open(scan_path, encoding="utf-8") as f:
            scan_data = json.load(f)
    except (OSError, ValueError) as e:
        raise RuntimeError(f"cannot read {scan_path}: {e}")
    if not isinstance(scan_data, dict) or scan_data.get("version") != SCAN_VERSION:
        raise RuntimeError(f"{scan_path} has version {scan_data.get('version') if isinstance(scan_data, dict) else None!r}; "
                           f"this script reads version {SCAN_VERSION}")
    return scan_data


def harvest(scan_path, handoff_dir, summarize_command=None, rank_command=None, now=None):
    """Write the handoff files and update index.json. Return a dict of paths and counts after the read-back."""
    scan_data = load_scan(scan_path)
    entries = hv.harvest_entries(scan_data)
    deadline = hv.model_deadline()
    if summarize_command:
        hv.summarize(entries, summarize_command, deadline)
    if rank_command:
        hv.model_rank(entries, rank_command, deadline)
    for e in entries:
        e.pop("_reply", None)
    now = time.time() if now is None else now
    when = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
    stamp, created = when.strftime("%Y%m%d-%H%M%S"), when.isoformat(timespec="seconds")
    make_private_dir(handoff_dir)
    base, md_path, json_path = reserve_handoff_names(handoff_dir, stamp)
    counts = {p: sum(1 for e in entries if e["priority"] == p) for p in ("P1", "P2", "P3")}
    write_json_atomic(json_path, {"version": hv.HANDOFF_VERSION, "created_at": created, "scan": {
        "path": os.path.abspath(scan_path), "scanned_at": scan_data.get("scanned_at")},
        "counts": counts, "entries": entries})
    write_text_atomic(md_path, hv.format_handoff(base, created, scan_data, entries))
    index_path = os.path.join(handoff_dir, "index.json")
    total, added = update_index(index_path, entries, os.path.basename(json_path), created)
    # Read the files back. Another harvest can add records between the lock release and this read, so the
    # check is that each id of this harvest is there, not an exact count of index.json.
    with open(json_path, encoding="utf-8") as f:
        back = json.load(f)
    with open(md_path, encoding="utf-8") as f:
        md = f.read()
    index = hv.read_index(index_path)
    ids = {r.get("id") for r in index["entries"]}
    if (len(back.get("entries", [])) != len(entries)
            or any(e["id"] not in ids or f"`{e['id']}`" not in md for e in entries)):
        raise RuntimeError("the read-back of the handoff files does not hold each entry of this harvest")
    return {"md": md_path, "json": json_path, "index": index_path, "entries": len(entries), "counts": counts,
            "index_total": total, "index_added": added}


def cmd_harvest(args):
    settings = load_settings()
    command = settings.get("model_command")
    if (args.summarize or args.model_rank) and not command:
        flag = "--summarize" if args.summarize else "--model-rank"
        sys.exit(f"error: {flag} needs the setting model_command (an argv list) in {settings_path()}")
    handoff_dir = os.path.expanduser(settings.get("handoff_dir") or DEFAULT_HANDOFF_DIR)
    scan_path = args.scan or os.path.join(handoff_dir, "scan.json")
    try:
        r = harvest(scan_path, handoff_dir, summarize_command=command if args.summarize else None,
                    rank_command=command if args.model_rank else None)
    except RuntimeError as e:
        sys.exit(f"error: {e}")
    print(f"handoff: {r['md']}")
    print(f"handoff json: {r['json']}")
    print(f"index.json: {r['index']} ({r['index_total']} entries, {r['index_added']} new)")
    c = r["counts"]
    print(f"entries: {r['entries']} (P1 {c['P1']}, P2 {c['P2']}, P3 {c['P3']})")
    return 0


# ---------------------------------------------------------------------------
# Close (the plan, the checks and the resume records are in idle_close.py)
# ---------------------------------------------------------------------------
def close(scan_path, index_path, protected=(), do_close=False, now=None):
    """The close plan of each workspace of scan.json; with do_close, close each workspace that passes.

    The fresh read uses the idle threshold of scan.json. now fixes the clock (tests); else the real time.
    """
    scan_data = load_scan(scan_path)
    clock = (lambda: now) if now is not None else time.time
    protected = set(protected)
    idle_minutes = scan_data.get("idle_minutes") or DEFAULT_IDLE_MINUTES

    def fresh_read(workspace_id):
        return fresh_workspace(workspace_id, protected | set(scan_data.get("protected_setting") or []),
                               idle_minutes, now=clock())

    return cl.run(scan_data, index_path, fresh_read, close_workspace, write_json_atomic, clock,
                  protected=protected, do_close=do_close)


def cmd_close(args):
    if args.yes and not args.close:
        sys.exit("error: --yes needs --close")
    settings = load_settings()
    handoff_dir = os.path.expanduser(settings.get("handoff_dir") or DEFAULT_HANDOFF_DIR)
    scan_path = args.scan or os.path.join(handoff_dir, "scan.json")
    protected = list(settings.get("protected_workspaces") or []) + list(args.protect or [])
    try:
        r = close(scan_path, os.path.join(handoff_dir, "index.json"), protected=protected,
                  do_close=args.close and args.yes)
    except RuntimeError as e:
        sys.exit(f"error: {e}")
    print(cl.format_result(r))
    n = r["counts"]["close"]
    if not args.close:
        print("plan only: nothing was closed.")
    elif not args.yes:
        print(f"nothing was closed. Question for the user: close the {n} workspace(s) of the rows `close`? "
              "After a yes, run again with --close --yes." if n else "nothing was closed: no workspace can close.")
    return 1 if r["counts"]["failed"] else 0
# Startup and entries (the claim, prompt and state code is in entries.py)
# ---------------------------------------------------------------------------
def _handoff_dir(settings):
    return os.path.expanduser(settings.get("handoff_dir") or DEFAULT_HANDOFF_DIR)


def cmd_startup(args):
    if entries.is_task_session():  # a task session of spawn.py claims nothing and prints nothing
        return 0
    settings = load_settings()
    return entries.main_startup(args, _handoff_dir(settings), settings, write_json_atomic)


def startup_assessment(settings):
    """The effective value of startup_assessment: a missing key or a missing file means `all`. Exits for a bad value."""
    value = settings.get("startup_assessment", "all")
    if value not in entries.ASSESSMENT_VALUES:
        sys.exit(f"error: invalid settings file {settings_path()}: startup_assessment is not one of "
                 f"{', '.join(entries.ASSESSMENT_VALUES)}")
    return value


def write_switch(on, path=None):
    """Set startup_assessment for the switch and keep every other key. An invalid file stops with no write.

    Off writes `off` and keeps the value before the off (`all` or `p1`) in startup_assessment_before_off; an off
    that is already off keeps the kept value. On writes only when the value is `off`: it restores the kept value
    (`all` when none is kept) and removes the kept key. `all`, `p1` or a missing key stay, with no write.
    The write goes through a temporary file and a rename in the directory of the real file, so a symlink stays.
    An existing file keeps its mode; a new directory gets 0700 and a new file 0600.
    """
    path = path or settings_path()
    data = load_settings(path)
    if on and startup_assessment(data) != "off":
        return data
    current = startup_assessment(data)  # a bad value stops the write
    if on:
        data["startup_assessment"] = data.pop(BEFORE_OFF_KEY, "all")
    else:
        if current != "off":
            data[BEFORE_OFF_KEY] = current
        data["startup_assessment"] = "off"
    real = os.path.realpath(path)
    try:
        mode = os.stat(real).st_mode & 0o7777
    except FileNotFoundError:
        mode = 0o600
    write_text_atomic(real, json.dumps(data, indent=2) + "\n", mode=mode)
    return data


def cmd_switch(args):
    path = settings_path()
    if args.state in ("on", "off"):
        write_switch(args.state == "on", path)
    value = startup_assessment(load_settings(path))
    on = value != "off"
    if args.json:
        print(json.dumps({"on": on, "startup_assessment": value, "settings": path}))
    else:
        verb = "set to" if args.state in ("on", "off") else "is"
        print(f"herdr-idle startup check {verb} {'on' if on else 'off'} (Pi and Claude Code).")
        print(f"startup_assessment: {value}")
        print(f"settings file: {path}")
        print("/herdr-idle-cleanup and /handoffs work in both states.")
    return 0


def cmd_entries(args):
    return entries.main_entries(args, _handoff_dir(load_settings()), write_json_atomic)


def cmd_publish(args):
    settings = load_settings()
    return pb.main_publish(args, _handoff_dir(settings), settings)


def add_entry_parsers(sub):
    p = sub.add_parser("startup", help="claim the open entries of a repository and print the assessment prompt")
    p.add_argument("--cwd", required=True, help="the directory of the session")
    p.add_argument("--format", choices=("text", "json"), default="text")
    p.set_defaults(func=cmd_startup)
    p = sub.add_parser("entries", help="list, show or set the state of handoff entries")
    acts = p.add_subparsers(dest="action", required=True)
    a = acts.add_parser("list", help="the entries, the repository of --cwd first")
    a.add_argument("--cwd", help="the directory of the session")
    a = acts.add_parser("show", help="one entry with its report")
    a.add_argument("id")
    a = acts.add_parser("set", help="set the state of one entry")
    a.add_argument("id")
    a.add_argument("state", choices=entries.SET_STATES)
    p.set_defaults(func=cmd_entries)
    p = sub.add_parser("publish", help="render a handoff to HTML and scan it; upload only with --upload")
    p.add_argument("handoff", help="the stem of a handoff (for example 20261109-120000) or the path of its .md file")
    p.add_argument("--upload", action="store_true", help="after a clean scan, upload the HTML file")
    p.set_defaults(func=cmd_publish)
    p = sub.add_parser("switch", help="turn the startup check on or off, or print its state")
    p.add_argument("state", nargs="?", choices=("on", "off", "status"), default="status")
    p.add_argument("--json", action="store_true", help="print the state as JSON")
    p.set_defaults(func=cmd_switch)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="idle_cleanup.py", description="Find idle Herdr workspaces.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("scan", help="list and classify all workspaces (read-only)")
    p.add_argument("--idle-minutes", type=_minutes_arg, default=None,
                   help=f"idle threshold in minutes (default {DEFAULT_IDLE_MINUTES})")
    p.add_argument("--protect", action="append", metavar="NAME_OR_ID", help="a workspace to protect (repeatable)")
    p.add_argument("--out", help="path of scan.json")
    p.set_defaults(func=cmd_scan)
    p = sub.add_parser("harvest", help="rank the final reports of the idle panes into a handoff")
    p.add_argument("--scan", help="path of scan.json (default: scan.json in the handoff directory)")
    p.add_argument("--summarize", action="store_true", help="model summary for a reply with no report (model_command)")
    p.add_argument("--model-rank", action="store_true", help="model order within each priority (model_command)")
    p.set_defaults(func=cmd_harvest)
    p = sub.add_parser("close", help="plan the close of idle workspaces; close them with --close --yes")
    p.add_argument("--scan", help="path of scan.json (default: scan.json in the handoff directory)")
    p.add_argument("--protect", action="append", metavar="NAME_OR_ID", help="a workspace to keep (repeatable)")
    p.add_argument("--close", action="store_true", help="close; without --yes only the plan and the question")
    p.add_argument("--yes", action="store_true", help="the user said yes: close the workspaces of the plan")
    p.set_defaults(func=cmd_close)
    add_entry_parsers(sub)
    args = parser.parse_args(argv)
    if args.command in ("scan", "close"):
        _common.require_herdr_env()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
