"""Shared helpers for the herdr skill scripts. Standard library only."""
import datetime
import glob
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time


def herdr(*args, timeout=None):
    """Run the herdr CLI. Return (exit_code, parsed_json_or_None, raw_text)."""
    try:
        p = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        sys.exit("error: herdr CLI not found in PATH")
    except subprocess.TimeoutExpired:
        return 124, None, "herdr call exceeded the local timeout"
    raw = (p.stdout or "").strip() or (p.stderr or "").strip()
    data = None
    for chunk in (p.stdout, p.stderr):
        chunk = (chunk or "").strip()
        if chunk.startswith("{"):
            try:
                data = json.loads(chunk)
                break
            except json.JSONDecodeError:
                pass
    return p.returncode, data, raw


# ---------------------------------------------------------------------------
# The backend: Herdr 1 (`herdr`) or herdr-core (`herdr-core`, with the Herdr app `herdr-app`).
# See the `backend` entry of contract.json.
# ---------------------------------------------------------------------------
def _run_json(argv, timeout):
    """Run a CLI with no shell and no stdin. Return (exit_code, parsed_json_or_None, raw_text); 127 when it is missing."""
    try:
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except OSError:  # missing, not executable, or a broken file (for example ENOEXEC): the candidate fails
        return 127, None, f"{os.path.basename(argv[0])} not found"
    except subprocess.TimeoutExpired:
        return 124, None, f"{os.path.basename(argv[0])} call exceeded the local timeout"
    raw = (p.stdout or "").strip() or (p.stderr or "").strip()
    data = None
    for chunk in (p.stdout, p.stderr):
        chunk = (chunk or "").strip()
        if chunk.startswith(("{", "[")):
            try:
                data = json.loads(chunk)
                break
            except json.JSONDecodeError:
                pass
    return p.returncode, data, raw


def hc_command():
    """The herdr-core CLI: `herdr-core`, else its link `hc`. None when neither is in PATH."""
    return shutil.which("herdr-core") or shutil.which("hc")


def hc(*args, timeout=30):
    """Run the herdr-core CLI (`herdr-core`, else `hc`) with no stdin, the only helper for it.

    Return (exit_code, parsed_json_or_None, raw_text). 127: the CLI is missing or cannot run. 124: the call
    passed `timeout` seconds. Each call has a finite timeout (default 30 s). The JSON is the first of stdout,
    stderr that starts with "{" or "["; a caller checks exit_code before it trusts the data.
    """
    cmd = hc_command()
    if not cmd:
        return 127, None, "herdr-core not found in PATH"
    return _run_json([cmd, *args], timeout)


def app(*args, timeout=30):
    """Run the Herdr app CLI `herdr-app`. Return (exit_code, parsed_json_or_None, raw_text); 127 when it is missing."""
    cmd = shutil.which("herdr-app")
    if not cmd:
        return 127, None, "herdr-app not found in PATH"
    return _run_json([cmd, *args], timeout)


def parent_pid(pid):
    """The parent pid of a process, or None."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8", errors="replace") as f:
            # Field 2 (the command) is in parentheses and can hold spaces; field 4 is the parent pid.
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except FileNotFoundError:
        if os.path.isdir("/proc"):
            return None  # the process is gone
    except (OSError, ValueError, IndexError):
        return None
    # No /proc (macOS): ask ps.
    code, _, raw = _run_json(["ps", "-o", "ppid=", "-p", str(pid)], 5)
    try:
        return int(raw.strip()) if code == 0 else None
    except ValueError:
        return None


def descends_from(root, pid=None):
    """True when the process `pid` (default: this process) is `root` or a descendant of it."""
    if not isinstance(root, int) or isinstance(root, bool) or root <= 1:
        return False
    pid = os.getpid() if pid is None else pid
    seen = set()
    while isinstance(pid, int) and pid > 1 and pid not in seen:
        if pid == root:
            return True
        seen.add(pid)
        pid = parent_pid(pid)
    return False


def _core_candidate(terminal):
    """(ok, why, record) for the herdr-core terminal `terminal`."""
    if terminal.startswith("-"):
        return False, "HC_TERMINAL_ID is not a terminal address", None
    code, data, raw = hc("get", terminal, "--json", timeout=15)
    if code == 127:
        return False, "no herdr-core command", None
    if code != 0 or not isinstance(data, dict) or data.get("error"):
        return False, f"herdr-core get failed (exit {code})", None
    if data.get("state") != "live":
        return False, "the terminal is not live", None
    if not descends_from(data.get("pid")):
        return False, "this process does not descend from the terminal", None
    return True, "valid", data


def _herdr1_candidate():
    """(ok, why, shell_pid) for the Herdr 1 pane of HERDR_PANE_ID."""
    if os.environ.get("HERDR_ENV") != "1":
        return False, "HERDR_ENV is not 1", None
    pane = os.environ.get("HERDR_PANE_ID")
    if not pane:
        return False, "HERDR_PANE_ID is not set", None
    if not shutil.which("herdr"):
        return False, "no herdr command", None
    code, data, raw = _run_json(["herdr", "pane", "process-info", "--pane", pane], 15)
    if code != 0 or not isinstance(data, dict) or error_code(data):
        return False, f"pane {pane} is not live ({error_code(data) or f'exit {code}'})", None
    info = (data.get("result") or {}).get("process_info") or {}
    shell_pid = info.get("shell_pid")
    if not descends_from(shell_pid):
        return False, f"this process does not descend from the shell of pane {pane}", None
    return True, "valid", shell_pid


def detect_backend():
    """Select the backend before any terminal action.

    Return a dict: "backend" is "herdr1", "core" or None (refuse), "line" names each candidate and its result.
    A "core" result also has "terminal" (the address), "space" and "tab" (the labels herdr.space and herdr.tab),
    and "record" (the `herdr-core get` record of the terminal).
    With no HC_TERMINAL_ID the result is "herdr1" with no check: the Herdr 1 path stays as it was.
    """
    terminal = os.environ.get("HC_TERMINAL_ID")
    if not terminal:
        return {"backend": "herdr1", "line": "herdr1: no HC_TERMINAL_ID"}
    core_ok, core_why, record = _core_candidate(terminal)
    h1_ok, h1_why, shell_pid = _herdr1_candidate()
    line = f"core (terminal {terminal}): {core_why}; herdr1: {h1_why}"
    if core_ok and h1_ok:
        # Both roots are ancestors of this process, so one contains the other: the nearer (inner) root wins.
        # Equal roots stay unclear.
        core_pid = record.get("pid")
        if shell_pid != core_pid and descends_from(core_pid, pid=shell_pid):
            core_ok = False  # the Herdr 1 pane runs inside the core terminal
        elif shell_pid != core_pid and descends_from(shell_pid, pid=core_pid):
            h1_ok = False  # the core terminal runs inside the Herdr 1 pane
    if core_ok == h1_ok:
        return {"backend": None, "line": line}
    if h1_ok:
        return {"backend": "herdr1", "line": line}
    labels = record.get("labels") or {}
    return {"backend": "core", "line": line, "terminal": record.get("address") or terminal,
            "space": labels.get("herdr.space"), "tab": labels.get("herdr.tab"), "record": record}


def require_backend(script, core=False):
    """Continue on the Herdr 1 backend, and on herdr-core when `core` is True (a ported script).

    Return the result of detect_backend(). Otherwise print one line and exit with the code of contract.json.
    `script` is the key of the script in contract.json backend.refusal_exit, for example "ask".
    """
    found = detect_backend()
    if found["backend"] == "herdr1" or (core and found["backend"] == "core"):
        return found
    code = CONTRACT["backend"]["refusal_exit"][script]
    if found["backend"] == "core":
        print(f"error: the herdr-core backend is detected ({found['line']}); this script is not ported to it yet. "
              "Nothing was done.", file=sys.stderr)
    else:
        print(f"error: cannot select the backend, so nothing was done. {found['line']}", file=sys.stderr)
    sys.exit(code)


def require_herdr_env():
    if os.environ.get("HERDR_ENV") != "1":
        sys.exit("error: not inside a Herdr pane (HERDR_ENV is not 1). Stop; do not control Herdr from outside.")


def herdr_app_pane(found=None):
    """The herdr-core record of the caller's terminal when it is a pane of the Herdr app, else None.

    `found` is the result of detect_backend() (it runs when `found` is None). The record comes only from a
    "core" result: a live terminal that is an ancestor of the caller. A pane of the Herdr app has the labels
    `herdr.space` and `herdr.tab`; a core terminal without them is no pane of the app. A terminal of another
    machine (an address with `/`) is never the caller's pane: the scripts act on nothing then.
    """
    found = detect_backend() if found is None else found
    if found.get("backend") != "core" or not found.get("space") or not found.get("tab"):
        return None
    if not core_local(found.get("terminal")) or not core_local((found.get("record") or {}).get("address") or found["terminal"]):
        return None
    return found["record"]


# ---------------------------------------------------------------------------
# Spaces, tabs and records on herdr-core. See LAYOUT.md, section "On herdr-core".
# ---------------------------------------------------------------------------
def core_local(address):
    """True for an address of this machine: `hc ls` also lists the terminals of other machines as `machine/t1`."""
    return isinstance(address, str) and bool(address) and "/" not in address


def core_role_tab(labels, role):
    """The herdr.tab ID for an agent of `role` in the space of the terminal with `labels`.

    A coordinator goes into the tab of the caller. Each other role has one tab for each space: its ID comes
    from the space and the role, so each agent of a role gets the same tab. The Herdr app makes a new tab
    for an ID that it does not know.
    """
    if role == "coordinator":
        return labels["herdr.tab"]
    return "tb" + hashlib.md5(f"{labels['herdr.space']}:{role}".encode()).hexdigest()


def core_project(terminal):
    """The project name of a terminal: the place that the Herdr app shows for it, else its folder."""
    where = ((terminal.get("labels") or {}).get("where") or "").split(" / ")[0].strip()
    return where or os.path.basename(terminal.get("cwd") or "") or "ws"


def core_record(terminal):
    """The record of the skill for a herdr-core terminal, or None when there is no valid one.

    The core can give an address to a new terminal later, so a record counts only when spawn.py or init.py
    wrote it on herdr-core for this terminal: `backend` is herdr-core and `created_at_epoch` is not earlier
    than the start of the terminal (`created_ms`, CLOCK_SLACK seconds of slack). Another record is ignored.
    """
    address = terminal.get("address")
    if not core_local(address):
        return None
    record = read_record(address)
    if not isinstance(record, dict) or record.get("backend") != "herdr-core":
        return None
    created, started = record.get("created_at_epoch"), terminal.get("created_ms")
    if not isinstance(created, (int, float)) or not isinstance(started, (int, float)):
        return None
    return record if created >= started / 1000 - CLOCK_SLACK else None


def core_role(terminal):
    """The role of a herdr-core terminal: its valid record, else its label skill.role, else None."""
    role = (core_record(terminal) or {}).get("role") or (terminal.get("labels") or {}).get("skill.role")
    return role if role in ROLES else None


# The agent name that herdr-core reports in status.app, for each harness name of the skill that differs.
CORE_APP_HARNESS = {"claude-code": "claude", "antigravity": "agy"}


def core_harness(terminal):
    """The harness of a herdr-core terminal: its status.app (CORE_APP_HARNESS), else its valid record, else None."""
    app = (terminal.get("status") or {}).get("app")
    if app:
        return CORE_APP_HARNESS.get(app, app)
    return (core_record(terminal) or {}).get("harness")


def core_coordinator_record(terminal, space, harness=None):
    """The record that makes the herdr-core terminal `terminal` the coordinator of `space`.

    init.py writes it when a terminal claims a space, role_set.py --coordinator when the owner sets a tab.
    `harness` is the harness that the caller found; without it the record takes core_harness(terminal).
    """
    return {"pane_id": terminal.get("address"), "role": "coordinator",
            "harness": harness or core_harness(terminal),
            "workspace_id": space, "session": "primary", "self": True,
            "backend": "herdr-core", "created_at_epoch": time.time()}


def core_terminals(space=None):
    """The `hc get` records of the live local terminals with a herdr.space label (of `space` when given).

    Each record carries the address of `hc ls`. A terminal that ends between the list and its read (`hc get`
    answers not_found) and a terminal that is not live are left out. Return None when `hc ls` fails or when
    `hc get` fails in another way (a timeout, another exit code, no JSON): a list with a hole is wrong.
    """
    args = ["ls", "--json"] + (["--label", f"herdr.space={space}"] if space else [])
    code, data, raw = hc(*args, timeout=20)
    if code != 0 or not isinstance(data, dict):
        return None
    out = []
    for t in data.get("terminals") or []:
        address = t.get("address") if isinstance(t, dict) else None
        if not core_local(address):
            continue
        code, rec, raw = hc("get", address, "--json", timeout=20)
        if code == 3 and isinstance(rec, dict) and isinstance(rec.get("error"), dict) \
                and rec["error"].get("kind") == "not_found":
            continue
        if code != 0 or not isinstance(rec, dict):
            return None
        if rec.get("state") != "live":
            continue
        got = (rec.get("labels") or {}).get("herdr.space")
        if got and (space is None or got == space):
            out.append(dict(rec, address=address))
    return out


def core_error_kind(data):
    """The `error.kind` of an `hc` answer, or None."""
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        return data["error"].get("kind") or "error"
    return None


def core_get(target):
    """(state, terminal) for a name or an address of herdr-core, read with `hc get`.

    state "ok": `terminal` is the record, with its address. "not_found": the core knows no such terminal.
    "remote": the target or its address is a terminal of another machine. "error": another failure;
    `terminal` is then the raw text.
    """
    if not isinstance(target, str) or not target or target.startswith("-") or not core_local(target):
        return "remote" if isinstance(target, str) and "/" in target else "error", target
    code, data, raw = hc("get", target, "--json", timeout=20)
    if code == 3 and core_error_kind(data) == "not_found":
        return "not_found", None
    if code != 0 or not isinstance(data, dict) or core_error_kind(data):
        return "error", raw
    data = dict(data, address=data.get("address") or target)
    if not core_local(data["address"]):
        return "remote", data
    return "ok", data


def core_info(terminal):
    """The agent info of a herdr-core terminal in the shape of `herdr agent get`, so the shared code can use it.

    pane_id is the address and agent is the harness (core_harness). A Claude Code terminal also gets
    `agent_session` from the sessions file of its process (claude_core_session), so session_file() finds its
    transcript.
    """
    status = terminal.get("status") or {}
    foreground = terminal.get("foreground") or {}
    info = {"pane_id": terminal.get("address"), "name": terminal.get("name"), "agent": core_harness(terminal),
            "agent_status": status.get("state"), "cwd": terminal.get("cwd"), "foreground_cwd": foreground.get("cwd"),
            "pid": foreground.get("pid") or terminal.get("pid"), "turn": terminal.get("turn")}
    if info["agent"] == "claude":
        sid = claude_core_session(info["pid"])
        if sid:
            info["agent_session"] = {"kind": "id", "value": sid}
    return info


def claude_core_session(pid):
    """The sessionId that Claude Code wrote in ~/.claude/sessions/<pid>.json for its process, or None.

    After /clear or a resume, the file names the new session of the same process.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        with open(os.path.expanduser(f"~/.claude/sessions/{pid}.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    sid = data.get("sessionId") if isinstance(data, dict) else None
    if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9-]+", sid):
        return None
    return sid


def core_screen(address, lines=60):
    """The screen and the last `lines` lines of history of a herdr-core terminal, as text (`hc read`)."""
    code, data, raw = hc("read", address, "--lines", str(lines), timeout=20)
    return raw if code == 0 else f"(hc read {address} failed: {raw[:300]})"


def error_code(data):
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        return data["error"].get("code") or "error"
    return None


def agent_info(target):
    """Return the agent record for a pane id or agent name, or None."""
    code, data, raw = herdr("agent", "get", target)
    if code != 0 or error_code(data) or not data:
        return None
    return data.get("result", {}).get("agent")


def session_file(info):
    """Resolve the transcript file of a Pi or Claude Code agent. Return path or None."""
    sess = (info or {}).get("agent_session") or {}
    value = sess.get("value")
    if not value:
        return None
    if sess.get("kind") == "path":
        return value if os.path.isfile(value) else None
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{value}.jsonl"))
    return hits[0] if hits else None


# ---------------------------------------------------------------------------
# Pi session files on disk, for a Pi pane that Herdr gives no transcript path
# (Pi-Bolt runs without HERDR_SOCKET_PATH, so it reports no session).
# ---------------------------------------------------------------------------
PI_AGENTS = ("pi", "pi-bolt")
# The prompt text that must be in the user entry. Pi can keep stray editor characters before it.
# A prompt up to this length must end the user entry; a longer one must be in it.
PROMPT_MATCH_CHARS = 200
# A shorter prompt (such as "continue") is too common to identify a session.
PROMPT_MIN_CHARS = 20
# Slack for the clock of the file system and the timestamp of the entry.
CLOCK_SLACK = 2


def pi_session_dir_name(cwd):
    """The folder name that Pi and Pi-Bolt give the sessions of a working directory.

    The same rule as getDefaultSessionDirPath of Pi: drop one leading separator, then each / \\ : becomes -.
    """
    return "--" + re.sub(r"[/\\:]", "-", re.sub(r"^[/\\]", "", cwd)) + "--"


def pi_agent_dirs():
    """The agent directories where a Pi pane can write: the caller's, the default and the kit profiles."""
    home = pathlib.Path.home()
    dirs = [os.environ.get("PI_CODING_AGENT_DIR"), home / ".pi" / "agent"]
    dirs += sorted((home / ".pi" / "profiles").glob("*"))
    out = []
    for d in dirs:
        if not d:
            continue
        d = pathlib.Path(os.path.expanduser(str(d))).resolve()
        if d not in out and d.is_dir():
            out.append(d)
    return out


def _entry_epoch(entry):
    try:
        return datetime.datetime.fromisoformat(str(entry["timestamp"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, TypeError):
        return None


def _user_text(entry):
    msg = entry.get("message")
    if entry.get("type") != "message" or not isinstance(msg, dict) or msg.get("role") != "user":
        return None
    content = msg.get("content")
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")


def _squash(text):
    return " ".join(text.split())


# herdr-core wraps the text that `hc send` types: the user entry is `<hc from="t11">prompt</hc>`.
HC_WRAPPER = re.compile(r'<hc from="[^"]*">(.*)</hc>$', re.DOTALL)


def _prompt_matches(text, needle):
    """True when the squashed user text ends with the needle (a short prompt) or holds it (a long prompt).

    The text inside a trailing herdr-core wrapper counts the same way, so a sent prompt matches its entry.
    """
    texts = [_squash(text)]
    wrapped = HC_WRAPPER.search(texts[0])
    if wrapped:
        texts.append(wrapped.group(1).strip())
    return any(needle in t if len(needle) > PROMPT_MATCH_CHARS else t.endswith(needle) for t in texts)


def _session_match(path, cwds, since, needle):
    """Return the line after the matching user entry, or None.

    The header must name one of `cwds`. A user entry written at or after `since` must end with the needle
    (a short prompt) or hold it (a long prompt).
    """
    found = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(d, dict):
                    continue
                if n == 0:
                    if d.get("type") != "session" or os.path.realpath(str(d.get("cwd") or "")) not in cwds:
                        return None
                    continue
                text = _user_text(d)
                if text is not None and _prompt_matches(text, needle):
                    when = _entry_epoch(d)
                    if when is not None and when >= since - CLOCK_SLACK:
                        found = n + 1
    except OSError:
        return None
    return found


def find_pi_session(cwds, since, prompt, agent_dirs=None):
    """Return (path, start line) of the one Pi session file of a pane, or None when it is not certain.

    A candidate is a *.jsonl file in <agent dir>/sessions/<folder of the cwd>, modified at or after `since`
    (epoch seconds), whose header names the cwd. With a prompt, the file must also hold a user entry
    written at or after `since` that ends with the prompt (up to PROMPT_MATCH_CHARS characters) or holds
    the whole prompt (a longer prompt); the start line is the line after it.
    A prompt shorter than PROMPT_MIN_CHARS, no file or more than one file gives None.
    """
    real = {os.path.realpath(c) for c in cwds if c}
    if not real:
        return None
    needle = _squash(prompt)
    if len(needle) < PROMPT_MIN_CHARS:
        return None
    names = {pi_session_dir_name(c) for c in set(cwds) | real if c}
    seen, hits = set(), []
    for agent_dir in pi_agent_dirs() if agent_dirs is None else agent_dirs:
        for name in names:
            for path in pathlib.Path(agent_dir, "sessions", name).glob("*.jsonl"):
                try:
                    key = path.resolve()
                    if key in seen or path.stat().st_mtime < since - CLOCK_SLACK:
                        continue
                except OSError:
                    continue
                seen.add(key)
                line = _session_match(path, real, since, needle)
                if line is not None:
                    hits.append((str(path), line))
    return hits[0] if len(hits) == 1 else None


DISK_NOTE = "note: Herdr gave no transcript path; the reply below is from the Pi session file on disk: "


# ---------------------------------------------------------------------------
# The transcript of an agy (Antigravity CLI) pane. The core gives no path and agy writes no cwd, so ask.py
# takes a file only when exactly one transcript holds the sent prompt after the send. The only file of
# ~/.gemini/ that the skill opens is this transcript: never a login, a token or a settings file.
# The schema is not documented; these fields come from real files of agy 1.5.15.
# ---------------------------------------------------------------------------
AGY_TRANSCRIPT = os.path.join(".system_generated", "logs", "transcript.jsonl")
# agy wraps the typed text: <USER_REQUEST>text</USER_REQUEST>, then metadata blocks.
AGY_REQUEST = re.compile(r"<USER_REQUEST>(.*?)</USER_REQUEST>", re.DOTALL)
AGY_NOTE = "note: the core gave no transcript path; the reply below is from the agy transcript on disk: "
AGY_CUT = "\n[... the agy transcript cut this reply; read the rest on the screen of the pane ...]"


def agy_brain_dir():
    return os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "brain")


def _agy_rows(path, start_line=0):
    """The JSON objects of an agy transcript after start_line, with their 0-based line numbers."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n < start_line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(d, dict):
                    yield n, d
    except OSError:
        return


def _agy_epoch(d):
    try:
        return datetime.datetime.fromisoformat(str(d["created_at"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, TypeError):
        return None


def find_agy_transcript(since, prompt, brain=None):
    """Return (path, start line) of the one agy transcript that holds the prompt, or None when it is not certain.

    A candidate is <brain>/<conversation id>/.system_generated/logs/transcript.jsonl, modified at or after
    `since`, with a USER_INPUT entry created at or after `since` whose request text matches the prompt by the
    rule of the Pi search (_prompt_matches). The start line is the line after that entry. A prompt shorter
    than PROMPT_MIN_CHARS, no file or more than one file gives None.
    """
    try:
        return _find_agy_transcript(since, prompt, brain)
    except Exception:  # noqa: BLE001 - an unknown transcript shape gives no path, never a traceback after the send
        return None


def _find_agy_transcript(since, prompt, brain):
    needle = _squash(prompt or "")
    if len(needle) < PROMPT_MIN_CHARS:
        return None
    hits = []
    for path in glob.glob(os.path.join(brain or agy_brain_dir(), "*", AGY_TRANSCRIPT)):
        try:
            if os.stat(path).st_mtime < since - CLOCK_SLACK:
                continue
        except OSError:
            continue
        found = None
        for n, d in _agy_rows(path):
            content = d.get("content")
            if d.get("type") != "USER_INPUT" or not isinstance(content, str):
                continue
            request = AGY_REQUEST.search(content)
            when = _agy_epoch(d)
            if (_prompt_matches(request.group(1) if request else content, needle)
                    and when is not None and when >= since - CLOCK_SLACK):
                found = n + 1
        if found is not None:
            hits.append((path, found))
    return hits[0] if len(hits) == 1 else None


def _agy_final(d):
    """True for a PLANNER_RESPONSE that ends a turn: done, with text, and no tool call."""
    content = d.get("content")
    return (d.get("type") == "PLANNER_RESPONSE" and d.get("status") == "DONE" and not d.get("tool_calls")
            and isinstance(content, str) and bool(content.strip()))


def agy_texts(path, start_line=0):
    """The final replies of an agy transcript after start_line; [] while the last PLANNER_RESPONSE is no final one.

    start_line is the line after the USER_INPUT of the prompt: the reading stops at the next USER_INPUT, so a
    later turn in the same conversation gives no reply. A reply that agy cut in the file (its field
    truncated_fields is a list that names content) ends with the AGY_CUT line. A row of another shape counts
    as no row. The reader never raises: a failure gives None, and the caller then shows the screen.
    """
    out, last = [], None
    try:
        for _, d in _agy_rows(path, start_line):
            if d.get("type") == "USER_INPUT":
                break
            if d.get("type") != "PLANNER_RESPONSE":
                continue
            last = d
            if _agy_final(d):
                fields = d.get("truncated_fields")
                cut = isinstance(fields, list) and "content" in fields
                out.append(d["content"].strip() + (AGY_CUT if cut else ""))
    except Exception:  # noqa: BLE001 - an unknown transcript shape must never lose the reply after the send
        return None
    return out if last is not None and _agy_final(last) else []


def _pane_cwds(info):
    return [c for c in (info.get("cwd"), info.get("foreground_cwd")) if c]


def _header(path):
    """The header of a Pi session file, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            d = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("type") == "session" else None


def _header_cwd(path):
    """The realpath of the cwd in the header of a Pi session file, or None."""
    d = _header(path)
    return os.path.realpath(str(d["cwd"])) if d and d.get("cwd") else None


def _newer_session(path, started):
    """True when another session file of the same folder, in any agent directory, has a later header time.

    After /new, /resume or a restart of the agent in the pane, that file is the current session of the pane.
    A file of another pane in the same cwd that started later also counts: the caller then refuses.
    """
    folder = pathlib.Path(path).parent
    me = pathlib.Path(path).resolve()
    for d in {folder} | {pathlib.Path(a, "sessions", folder.name) for a in pi_agent_dirs()}:
        for other in d.glob("*.jsonl"):
            try:
                if other.resolve() == me:
                    continue
            except OSError:
                continue
            when = _entry_epoch(_header(other) or {})
            if when is not None and when > started:
                return True
    return False


def save_pi_session(info, path):
    """Keep the session file that a prompt matched in the pane record, for later runs without a prompt.

    Only a record that spawn.py (or the first use of the skill) wrote for this pane gets it: the skill makes
    no record for a pane that it did not start. spawn.py writes a whole new record, so a reused pane id loses it.
    """
    pane_id = (info or {}).get("pane_id")
    record = read_record(pane_id) if pane_id else None
    if not record or record.get("pane_id") != pane_id:
        return
    cwd = _header_cwd(path)
    if cwd is None:
        return
    record["pi_session"] = {"pane_id": pane_id, "path": os.path.realpath(path), "cwd": cwd,
                            "saved_at_epoch": time.time()}
    if read_record(pane_id) is None:
        return  # close.py removed the record meanwhile: do not bring it back
    write_record(pane_id, record)


def saved_pi_session(info):
    """The session file that an earlier prompt in this pane matched, or None when it is not certain.

    The record and the saved entry name this pane id, the agent name and the harness of the record and the
    pane are the same and Pi, the file exists, and its header cwd is the current cwd of the pane.
    The header time of the file is not earlier than the record (a pane id that a hand-started pane reuses),
    and no other file of the same session folder has a later header time (_newer_session).
    """
    info = info or {}
    pane_id = info.get("pane_id")
    if not pane_id or info.get("agent") not in PI_AGENTS:
        return None
    record = read_record(pane_id) or {}
    saved = record.get("pi_session")
    if (not isinstance(saved, dict) or record.get("pane_id") != pane_id or saved.get("pane_id") != pane_id
            or record.get("harness") not in PI_AGENTS or record.get("name") != info.get("name")):
        return None
    path = saved.get("path")
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    cwd = _header_cwd(path)
    if cwd is None or cwd != saved.get("cwd") or cwd not in {os.path.realpath(c) for c in _pane_cwds(info)}:
        return None
    started, created = _entry_epoch(_header(path) or {}), record.get("created_at_epoch")
    if (started is None or not isinstance(created, (int, float)) or started < created - CLOCK_SLACK
            or _newer_session(path, started)):
        return None
    return path


def pi_disk_session(info, prompt=None, since=None):
    """The session file on disk of a Pi pane that Herdr gives no transcript path: (path, start line) or None.

    The file must hold the prompt in a user entry written at or after `since` (the send time).
    Without a prompt (a wait-only run, last-reply.py) only the file that an earlier prompt in this pane
    matched counts (saved_pi_session), from line 0: a search would be uncertain, because another Pi session
    in the same cwd can be the only file.
    """
    if (info or {}).get("agent") not in PI_AGENTS:
        return None
    if prompt is None:
        path = saved_pi_session(info)
        return (path, 0) if path else None
    return find_pi_session(_pane_cwds(info), since, prompt)


def pi_turn_done(path, start_line=0):
    """The final reply of the turn in a Pi session file after start_line, or "" while the turn works.

    The last message, compaction or custom_message entry must be a final reply: an assistant message with
    text that calls no tool and did not fail (stopReason is not toolUse, error or aborted). Pi retries after a
    failed attempt. A custom_message can start a new turn. Pi writes other entries (such as state-only custom
    ones) after the reply; they do not count. The text is the one that assistant_texts gives for the message.
    """
    last = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n < start_line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(d, dict) and d.get("type") in ("message", "compaction", "custom_message"):
                    last = d
    except OSError:
        return ""
    msg = (last or {}).get("message") if (last or {}).get("type") == "message" else None
    if (not isinstance(msg, dict) or msg.get("role") != "assistant"
            or msg.get("stopReason") in ("toolUse", "error", "aborted")):
        return ""
    content = msg.get("content")
    if isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "toolCall" for p in content):
        return ""
    return _message_text(content)


def _message_text(content):
    """The text of the content of a message, stripped."""
    if isinstance(content, str):
        return content.strip()
    return "\n".join(p.get("text", "") for p in content or []
                     if isinstance(p, dict) and p.get("type") == "text").strip()


def assistant_texts(path, start_line=0):
    """Return assistant text messages found after start_line (0-based line count)."""
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n < start_line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = d.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                if d.get("isSidechain"):
                    continue
                text = _message_text(msg.get("content"))
                if text:
                    out.append(text)
    except OSError:
        pass
    return out


def line_count(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def screen_tail(target, lines=60):
    code, data, raw = herdr("agent", "read", target, "--source", "recent-unwrapped", "--lines", str(lines))
    if data and not error_code(data):
        r = data.get("result", {})
        text = (r.get("read") or r).get("text")
        if text:
            return text
    return raw


def clip(text, max_chars, head=0):
    if len(text) <= max_chars:
        return text
    if head == 0:
        return f"[... first {len(text) - max_chars} characters omitted ...]\n" + text[len(text) - max_chars:]
    tail = max_chars - head
    return text[:head] + f"\n[... {len(text) - max_chars} characters omitted ...]\n" + text[len(text) - tail:]


# ---------------------------------------------------------------------------
# The contract of the scripts (contract.json) and the roles (roles.json).
# ---------------------------------------------------------------------------
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def skill_json(name):
    """A JSON file of this skill, for example contract.json or roles.json."""
    with open(os.path.join(SKILL_DIR, name), encoding="utf-8") as f:
        return json.load(f)


CONTRACT = skill_json("contract.json")


def exit_codes(script):
    """The exit codes of `ask` or `spawn` by name, from contract.json."""
    return {name: entry["code"] for name, entry in CONTRACT[script]["exit"].items()}


# ---------------------------------------------------------------------------
# Layout and names. See LAYOUT.md.
# ---------------------------------------------------------------------------
ROLES = list(skill_json("roles.json")["roles"])
STATE_DIR = os.environ.get("HERDR_SKILL_STATE_DIR") or os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "herdr-skill")
NAME_MAX = 32


def api(method, params):
    """Call a socket API method that the CLI does not expose (for example tab.move)."""
    path = os.environ.get("HERDR_SOCKET_PATH")
    if not path:
        return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect(path)
        s.sendall((json.dumps({"id": "skill:" + method, "method": method, "params": params}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        return json.loads(buf.decode().splitlines()[0])
    except (OSError, ValueError, IndexError):
        return None


def record_path(pane_id):
    return os.path.join(STATE_DIR, "panes", pane_id.replace(":", "_").replace("/", "_") + ".json")


def read_record(pane_id):
    try:
        return json.load(open(record_path(pane_id)))
    except (OSError, json.JSONDecodeError):
        return None


def write_record(pane_id, data):
    """Write the whole record through a temporary file, so a reader never sees half a record."""
    path = record_path(pane_id)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def remove_record(pane_id):
    try:
        os.remove(record_path(pane_id))
    except OSError:
        pass


def workspace_label(workspace_id):
    code, data, raw = herdr("workspace", "list")
    if data and not error_code(data):
        for w in data["result"]["workspaces"]:
            if w["workspace_id"] == workspace_id:
                return w.get("label") or workspace_id
    return workspace_id


def tabs(workspace_id):
    code, data, raw = herdr("tab", "list", "--workspace", workspace_id)
    if data and not error_code(data):
        return data["result"]["tabs"]
    return []


def panes(workspace_id):
    code, data, raw = herdr("pane", "list", "--workspace", workspace_id)
    if data and not error_code(data):
        return data["result"]["panes"]
    return []


def live_agents():
    code, data, raw = herdr("agent", "list")
    if data and not error_code(data):
        return data["result"]["agents"]
    return []


def project_slug(label):
    slug = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-") or "ws"
    if not slug[0].isalpha():
        slug = "w" + slug
    return slug


def make_name(label, role, agents):
    """<project>-<role>-<n>. n is one above the highest live number for this project and role."""
    # The project part has the same length for each role, so all names of a project align.
    room = NAME_MAX - max(len(r) for r in ROLES) - 4  # "-role-" and up to 2 digits
    project = project_slug(label)[:room].strip("-")
    stem = f"{project}-{role}-"
    used = [0]
    for a in agents:
        n = a.get("name") or ""
        if n.startswith(stem) and n[len(stem):].isdigit():
            used.append(int(n[len(stem):]))
    return f"{stem}{max(used) + 1}"


def pane_label(name, harness=None, model=None, thinking=None):
    """The first word is the agent name. The second word is for the human reader."""
    if not harness:
        return name
    if not model:
        return f"{name} {harness}:default/{thinking}" if thinking else f"{name} {harness}"
    short = model.split("/")[-1]
    return f"{name} {harness}:{short}/{thinking}" if thinking else f"{name} {harness}:{short}"


def place_role_tab(workspace_id, tab_id, role):
    """Keep role tabs at the front in the order of ROLES. The coordinator tab is tab 1."""
    rank = ROLES.index(role)
    index = 0
    for t in tabs(workspace_id):
        if t["tab_id"] == tab_id:
            continue
        if t.get("label") in ROLES and ROLES.index(t["label"]) < rank:
            index += 1
    current = [t["tab_id"] for t in tabs(workspace_id)]
    if tab_id in current and current.index(tab_id) == index:
        return True
    r = api("tab.move", {"tab_id": tab_id, "insert_index": index})
    return bool(r and not r.get("error"))


def ensure_layout(quiet=True):
    """First use of the skill in a workspace: the caller's tab becomes the coordinator tab.

    Returns a dict that describes the caller. Safe to call many times.
    """
    me = os.environ.get("HERDR_PANE_ID")
    ws = os.environ.get("HERDR_WORKSPACE_ID")
    if os.environ.get("HERDR_ENV") != "1" or not me or not ws:
        return {}
    code, data, raw = herdr("pane", "get", me)
    if not data or error_code(data):
        return {}
    pane = data["result"]["pane"]
    ws, tab_id, me = pane["workspace_id"], pane["tab_id"], pane["pane_id"]
    all_tabs = tabs(ws)
    my_tab = next((t for t in all_tabs if t["tab_id"] == tab_id), {})
    info = agent_info(me) or {}
    out = {"workspace_id": ws, "workspace": workspace_label(ws), "tab_id": tab_id,
           "tab": my_tab.get("label"), "pane_id": me, "name": info.get("name"), "claimed": False}
    record = read_record(me)
    if record:
        out["role"] = record.get("role")
        return out
    if my_tab.get("label") in ROLES:
        out["role"] = my_tab["label"]
    elif not any(t.get("label") == "coordinator" for t in all_tabs):
        herdr("tab", "rename", tab_id, "coordinator")
        place_role_tab(ws, tab_id, "coordinator")
        out.update(tab="coordinator", role="coordinator", claimed=True)
    else:
        return out
    if out.get("role") == "coordinator" and info and not info.get("name"):
        name = make_name(out["workspace"], "coordinator", live_agents())
        code, data, raw = herdr("agent", "rename", me, name)
        if code == 0 and not error_code(data):
            out["name"] = name
            herdr("pane", "rename", me, pane_label(name, info.get("agent")))
            write_record(me, {"pane_id": me, "name": name, "role": "coordinator", "harness": info.get("agent"),
                              "workspace_id": ws, "session": "primary", "self": True,
                              "created_at_epoch": time.time()})
    if out["claimed"] and not quiet:
        print(f"herdr: first use in workspace '{out['workspace']}'. Your tab is now 'coordinator' (tab 1). "
              f"Your name is {out.get('name')}.", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# Catalog of tools, skills and processes. See resources.json.
# ---------------------------------------------------------------------------
MACHINE_CATALOG = os.environ.get("HERDR_SKILL_RESOURCES") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr-skill", "resources.json")


def machine_file_data(machine_file=None):
    """Return the content of the machine file, or {} when it is absent or not valid."""
    path = MACHINE_CATALOG if machine_file is None else machine_file
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_catalog(machine_file=None):
    """Return the resources of the catalog, with the machine file on top."""
    path = os.path.join(SKILL_DIR, "resources.json")
    with open(path, encoding="utf-8") as f:
        resources = dict(json.load(f).get("resources", {}))
    extra = machine_file_data(machine_file).get("resources") or {}
    for source, entries in ((path, resources),
                            (MACHINE_CATALOG if machine_file is None else machine_file, extra)):
        for rid, entry in entries.items():
            if "roles" in entry and (not isinstance(entry["roles"], list) or any(
                    not isinstance(role, str) or role not in ROLES for role in entry["roles"])):
                print(f"error: {source}: resources.{rid}.roles must be a list of known role names: "
                      + ", ".join(ROLES), file=sys.stderr)
                sys.exit(2)
    for rid, entry in extra.items():
        if entry.get("remove"):
            resources.pop(rid, None)
        else:
            resources[rid] = entry
    return resources


def load_launch(cfg, machine_file=None):
    """Return the launch files of roles.json, with the machine file on top. A value that is not set is left out."""
    launch = dict(cfg.get("launch") or {})
    launch.update(machine_file_data(machine_file).get("launch") or {})
    return {k: os.path.expanduser(v.replace("{skill}", SKILL_DIR))
            for k, v in launch.items() if k != "comment" and isinstance(v, str) and v.strip()}


def mcp_servers(resources, group="web"):
    """Return MCP server settings for entries with a URL, in catalog order."""
    servers = {}
    for _, rid, e in sorted((e.get("order", 100), rid, e) for rid, e in resources.items()
                            if e.get("group") == group and e.get("kind") == "mcp"):
        name = e.get("mcp_server") or rid
        url = next((loc["url"] for loc in e.get("locations") or [] if loc.get("url")), None)
        if url and re.fullmatch(r"[A-Za-z0-9_-]+", name):
            settings = {"url": url}
            if "headers_helper" in e:
                settings["headers_helper"] = os.path.expanduser(e["headers_helper"])
            servers.setdefault(name, settings)
    return servers


def location_state(loc):
    """Return (text, found). found is True, False or None when there is no check."""
    if "file" in loc:
        path = os.path.expanduser(loc["file"])
        return loc["file"], os.path.isfile(path)
    if "url" in loc:
        import urllib.error
        import urllib.request
        try:
            with urllib.request.urlopen(loc["url"], timeout=2):
                return loc["url"], True
        except urllib.error.HTTPError:
            return loc["url"], True  # the server answered
        except (OSError, ValueError):
            return loc["url"], False
    if "command" in loc:
        from shutil import which
        return loc["command"], which(loc["command"]) is not None
    return "", None


def resolve_resource(entry):
    """Find the first location that is present. Return (location text or None, found)."""
    locations = entry.get("locations") or []
    if not locations:
        return None, None
    for loc in locations:
        text, found = location_state(loc)
        if found:
            return text, True
    return None, False


def role_matches(entry, role):
    """Without a role filter, include even an entry with an empty roles list."""
    return role is None or "roles" not in entry or role in entry["roles"]


def catalog_lines(resources, group, role=None):
    """Return (lines for the role prompt, titles that are not on the machine)."""
    lines, absent = [], []
    chosen = sorted((e.get("order", 100), rid, e) for rid, e in resources.items()
                    if e.get("group") == group and role_matches(e, role))
    for _, rid, e in chosen:
        where, found = resolve_resource(e)
        if found is False:
            absent.append(e.get("title", rid))
            continue
        line = f"{len(lines) + 1}. **{e.get('title', rid)}** (`{rid}`). {e.get('use_when', '')} How: {e.get('load', '')}"
        if where and not where.startswith("http"):
            line += f" Location: `{where}`."
        lines.append(line)
    return lines, absent
