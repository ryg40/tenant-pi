#!/usr/bin/env python3
"""Launch agents in empty role-tab terminals of a Herdr space and hand off a full coordinator.

Usage: herdr-role-set --set '<json>' [--dry-run]
       herdr-role-set --models
       herdr-role-set --coordinator <space> <tab> [--dry-run]
       herdr-role-set --coordinator-tokens

Runs on the computer of the space with no HC_TERMINAL_ID, no HERDR_ENV and no init.py record.
Takes the space only from --set JSON. --models prints the Copilot models of the live Pi listing
(read-only: no pane, no file, no hc call). --coordinator-tokens prints the coordinator token count
(or null) of every local space with live terminals in one read-only JSON line. --coordinator makes
<tab> the coordinator tab of <space>:
its newest agent terminal gets the coordinator label and record, and each other coordinator of the space
loses them (see SPAWN.md, "Role set launch"). Prints single-line JSON on stdout; real-run skip
reasons go to stderr as one plain line per skipped target. The final line of a real --set run, `ok` true or
false, has `times`: whole milliseconds of each step that ran (`total`, `discover`, `plan`, `launch`, and for a
handoff `context`, `get`, `send`), with the coordinator status read before the send. The handoff send runs in a
background terminal of herdr-core (`hc exec` ends each process that this script starts), so `send` is the time to
start it and `times` has `send_detached`: true. The handoff line has `pending` true and `result`, the path of the
JSON file where the child writes the outcome of `hc send`. When that terminal does not start, the send runs in the
run itself, with `send_result` and `send_fallback`: true in `times` and no `pending`.

A real --set run that sends no handoff to a live coordinator sends it one line with the task-role choices (the role
models notice) when the coordinator is at its prompt and the record `notice-last.json` shows no equal send to the same
coordinator session. The notice line has `action` "role_models"; `times` has `notice`. A dry run has `role_models`.

Delivery is best effort by the owner's decision: pre-send checks lower the risk of acting on
an occupied or changed terminal, but are not proof, and herdr-core performs no shell-prompt,
session-identity, or `done`-state check at delivery time.

Exit codes (see contract.json, entry role_set):
  0  dry run printed, empty or unknown space, or all actions finished
  1  an action, herdr-core call, or internal error failed
  2  bad input (unknown label, unknown version, or missing/invalid space)
"""
import contextlib
import io
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import traceback
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _common  # noqa: E402
from _common import (CLOCK_SLACK, CORE_APP_HARNESS, PI_AGENTS, ROLES, core_coordinator_record,  # noqa: E402
                     core_error_kind, core_info, core_local, core_project, core_record, core_role,
                     core_role_tab, exit_codes, hc, make_name, read_record, remove_record, skill_json,
                     write_record)
import ask  # noqa: E402
import spawn  # noqa: E402
from init import name_role  # noqa: E402

VERSION = 1
EXIT = exit_codes("role_set")
HANDOFF_TOKEN_LIMIT = 200_000
PREVIEW_MAX = 120
RUN_LIMIT_SECONDS = 600
COORDINATOR_TOKENS_LIMIT_SECONDS = 20
SEND_LIMIT_SECONDS = 90
# Claude Code reports `working` with "<count text> still running" (for example "1 shell still running")
# after a completed turn while it waits for background tasks; in a turn the message is the tool detail.
AWAITED_SUFFIX = " still running"
HC_STATUS_MISMATCH_EXIT = 10
# An agy pane gets the first message of spawn.py (the role prompt file) after the other actions of the run. The
# startups can overlap, so one shared wait covers them all; the run does not wait for the turn.
AGY_READY_SECONDS = 90
AGY_POLL_SECONDS = 1
HC_BLOCKED_EXIT = 9
# The handoff send runs in a background terminal of herdr-core (this script in a hidden mode) that writes its outcome to a result file.
SEND_HANDOFF_FLAG = "--send-handoff"
RESULT_FOLDER = "role-set"
RESULT_KEEP_SECONDS = 7 * 86400
NOTICE_RECORD = "notice-last.json"

# Fixed model labels per role button (researcher covers scout).
ROLE_MODELS = {
    "coordinator": ("claude/opus", "claude/fable", "codex/sol", "codex/astra", "agy/neon"),
    "researcher": ("claude/sonnet", "claude/haiku", "codex/luna", "codex/terra"),
    "worker": ("claude/opus", "claude/fable", "codex/sol", "codex/astra", "agy/neon"),
    "reviewer": ("claude/sonnet", "claude/opus", "codex/sol", "codex/astra", "codex/terra", "codex/luna", "agy/neon"),
}

# Fixed thinking levels per provider prefix.
PROVIDER_THINKING = {
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("minimal", "low", "medium", "high", "xhigh", "max"),
    "copilot": ("minimal", "low", "medium", "high", "xhigh", "max"),
    "agy": ("low", "medium", "high", "xhigh", "max"),
}

# Exact mapping from claude/<alias> labels to spawn.py model IDs.
CLAUDE_MODELS = {
    "claude/opus": "claude-opus-5-5",
    "claude/fable": "claude-fable-5-2",
    "claude/sonnet": "claude-sonnet-5-5",
    "claude/haiku": "claude-haiku-5-5",
}

# copilot/<id> labels come from the live Pi listing, not from a fixed table.
COPILOT_PREFIX = "copilot/"
COPILOT_PROVIDER = "github-copilot"
COPILOT_LEFT_OUT = "claude-"
LIST_TIMEOUT_SECONDS = 20

TASK_ROLES = tuple(r for r in ROLES if r != "coordinator")

SHELL_NAMES = frozenset({"bash", "zsh", "sh", "dash", "fish", "ksh"})
AGY_HOME = os.path.join("~", ".gemini", "antigravity-cli")
PROC_ROOT = "/proc"
AGY_CONV_ID = re.compile(r"[A-Za-z0-9._-]+")
PROC_MAX_DEPTH = 64
PROC_DEADLINE_CHECK_MASK = 255


class _DeadlineExceeded(Exception):
    """Raised when the single end-to-end 600-second deadline expires."""


class _ActionError(Exception):
    """Expected operational failure (herdr-core call or delivery failure)."""


class _ValidationError(_ActionError):
    """Explicitly validated configuration, catalog, or launch-builder error."""


def emit(obj):
    print(json.dumps(obj, separators=(",", ":")), flush=True)


def _sanitize_stderr_field(value):
    """Replace line breaks and control characters with spaces so one skip stays on one line."""
    text = str(value).replace("\r\n", " ")
    return "".join(" " if unicodedata.category(ch) in ("Cc", "Zl", "Zp", "Cs") else ch for ch in text)


def log_skip(terminal, reason):
    print(f"skip {_sanitize_stderr_field(terminal)}: {_sanitize_stderr_field(reason)}", file=sys.stderr, flush=True)


def bad_input(message):
    emit({"version": VERSION, "ok": False, "error": message})
    sys.exit(EXIT["invalid"])


# The agy panes whose launch line is not written yet. An entry leaves the list only after its line is written, so a
# failure line follows the lines of all panes. "result" holds (sent, error) once the outcome is known: the cleanup
# reports that outcome and never sends again.
_agy_pending = []


def emit_agy_launch(entry, sent, error=None):
    line = {"version": VERSION, "action": "launch", "terminal": entry["terminal"], "ok": True,
            "role_prompt": spawn.prompt_path(entry["name"]), "first_message": "sent" if sent else "not sent"}
    if error:
        line["first_message_error"] = error
    emit(line)


def flush_agy_entry(entry):
    """Write the launch line of a pending agy entry, then remove the entry."""
    sent, error = entry.get("result") or (False, "run stopped before the first message")
    emit_agy_launch(entry, sent, error)
    _agy_pending.remove(entry)


# Step times of a real --set run (None in every other mode): closed steps in ms, open steps by start time.
_times = None
_open_steps = {}
_run_start = 0.0


def start_step(step):
    if _times is not None:
        _open_steps[step] = time.monotonic()


def end_step(step):
    """Add the whole milliseconds since start_step(step) to `_times[step]`; a no-op for a step not started."""
    start = _open_steps.pop(step, None)
    if start is not None:
        _times[step] = _times.get(step, 0) + round((time.monotonic() - start) * 1000)


@contextlib.contextmanager
def timed(step):
    """Time the block as `step` in a real run; a no-op in other modes."""
    start_step(step)
    try:
        yield
    finally:
        end_step(step)


def with_times(obj):
    """Return obj with `times` (steps that ran, open steps up to now, and `total`) in a real run."""
    if _times is None:
        return obj
    now = time.monotonic()
    times = dict(_times)
    for step, start in _open_steps.items():
        times[step] = times.get(step, 0) + round((now - start) * 1000)
    times["total"] = round((now - _run_start) * 1000)
    return dict(obj, times=times)


def fail_run(message, done):
    while _agy_pending:
        flush_agy_entry(_agy_pending[0])
    emit(with_times({"version": VERSION, "ok": False, "done": done, "error": message}))
    sys.exit(EXIT["failed"])


def remaining_seconds(deadline, *, cap=None):
    rem = deadline - time.monotonic()
    if rem <= 0:
        raise _DeadlineExceeded()
    return min(rem, cap) if cap is not None else rem


def valid_space_id(space):
    """Space IDs are opaque non-empty UTF-8 strings with no whitespace and no control characters."""
    if not isinstance(space, str) or not space:
        return False
    if any(ch.isspace() or unicodedata.category(ch) == "Cc" for ch in space):
        return False
    try:
        space.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def parse_args(argv):
    raw_set = None
    dry_run = False
    if argv == ["--models"]:
        return None, False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--models":
            bad_input("--models takes no other argument")
        if arg == "--dry-run":
            if dry_run:
                bad_input("--dry-run may only be given once")
            dry_run = True
            i += 1
        elif arg == "--set":
            if i + 1 >= len(argv):
                bad_input("--set needs a JSON argument")
            if raw_set is not None:
                bad_input("--set may only be given once")
            raw_set = argv[i + 1]
            i += 2
        else:
            bad_input(f"unknown argument: {arg}")
    if raw_set is None:
        bad_input("--set is required")
    return raw_set, dry_run


def parse_coordinator_args(argv):
    """--coordinator <space> <tab> [--dry-run]: return (space, tab, dry_run), or exit with bad input."""
    if argv.count("--coordinator") != 1:
        bad_input("--coordinator may only be given once")
    i = argv.index("--coordinator")
    ids = argv[i + 1:i + 3]
    if len(ids) < 2 or "--dry-run" in ids:
        bad_input("--coordinator needs a space ID and a tab ID")
    rest = argv[:i] + argv[i + 3:]
    for arg in rest:
        if arg != "--dry-run":
            bad_input(f"unknown argument with --coordinator: {arg}")
    if len(rest) > 1:
        bad_input("--dry-run may only be given once")
    space, tab = ids
    if not valid_space_id(space):
        bad_input("missing or invalid space")
    if not valid_space_id(tab):
        bad_input("missing or invalid tab")
    return space, tab, bool(rest)


def validate_payload(raw_set):
    try:
        data = json.loads(raw_set)
    except ValueError as exc:
        bad_input(f"invalid --set JSON: {exc}")
    if not isinstance(data, dict):
        bad_input("--set JSON must be an object")
    unknown_top = set(data) - {"version", "space", "roles"}
    if unknown_top:
        bad_input(f"unknown top-level keys: {', '.join(sorted(unknown_top))}")
    version = data.get("version")
    if type(version) is not int or version != VERSION:
        bad_input(f"unsupported version: {version!r}")
    space = data.get("space")
    if not valid_space_id(space):
        bad_input("missing or invalid space")
    roles = data.get("roles")
    if not isinstance(roles, dict):
        bad_input("roles must be an object")
    clean_roles = {}
    copilot_keys = []
    for role, spec in roles.items():
        if role not in ROLE_MODELS:
            bad_input(f"unknown role: {role}")
        if not isinstance(spec, dict):
            bad_input(f"roles.{role} must be an object")
        unknown_keys = set(spec) - {"model", "thinking"}
        if unknown_keys:
            bad_input(f"roles.{role} has unknown keys: {', '.join(sorted(unknown_keys))}")
        model = spec.get("model")
        if isinstance(model, str) and model.startswith(COPILOT_PREFIX) and len(model) > len(COPILOT_PREFIX):
            copilot_keys.append((role, model))
        elif not isinstance(model, str) or model not in ROLE_MODELS[role]:
            bad_input(f"unknown model label for {role}: {model!r}")
        provider = model.split("/", 1)[0]
        entry = {"model": model}
        if "thinking" in spec:
            thinking = spec["thinking"]
            if not isinstance(thinking, str) or thinking not in PROVIDER_THINKING[provider]:
                bad_input(f"unknown thinking level for {model}: {thinking!r}")
            entry["thinking"] = thinking
        clean_roles[role] = entry
    if copilot_keys:
        # One listing for each run, only for a set with a copilot/ key. A failed listing raises
        # _ActionError: main() refuses the set with exit "failed" before anything starts.
        try:
            known = set(copilot_models())
        except _ActionError as exc:
            raise _ActionError(f"could not list the Copilot models: {exc}") from None
        for role, model in copilot_keys:
            if model not in known:
                bad_input(f"unknown model label for {role}: {model!r} (not a Copilot model of this machine)")
    return space, clean_roles


def copilot_models():
    """Return the copilot/<id> labels of the live Pi listing, in its order, without the claude- IDs.

    Uses the Pi launcher of spawn.py (launch.pi_executable) and the environment of this process,
    as spawn.resolve_pi_model does. Raises _ActionError when the listing fails.
    """
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            executable = spawn.pi_executable()
    except SystemExit:
        raise _ActionError(f"could not find the Pi launcher: {err.getvalue().strip()[:200]}") from None
    try:
        proc = subprocess.run([executable, "--list-models"], stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=LIST_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise _ActionError(f"`{executable} --list-models` timed out after {LIST_TIMEOUT_SECONDS} s") from None
    except (OSError, UnicodeError) as exc:
        raise _ActionError(f"could not run `{executable} --list-models`: {type(exc).__name__}") from None
    if proc.returncode != 0:
        raise _ActionError(f"`{executable} --list-models` exited {proc.returncode}")
    models = []
    for line in proc.stdout.splitlines():
        cols = line.split()
        if len(cols) >= 2 and cols[0] == COPILOT_PROVIDER and not cols[1].startswith(COPILOT_LEFT_OUT):
            label = COPILOT_PREFIX + cols[1]
            if label not in models:
                models.append(label)
    return models


def list_models():
    """--models: print one JSON line with the Copilot models and their thinking levels."""
    try:
        models = copilot_models()
    except _ActionError as exc:
        emit({"version": VERSION, "ok": False, "error": str(exc)})
        sys.exit(EXIT["failed"])
    emit({"version": VERSION, "ok": True,
          "providers": {"copilot": {"models": models, "thinking": list(PROVIDER_THINKING["copilot"])}}})


def map_label(model, thinking=None):
    """Map a UI model label and optional thinking level to spawn.py (harness, model, thinking)."""
    if model in CLAUDE_MODELS:
        return "claude", CLAUDE_MODELS[model], thinking
    if model.startswith("codex/"):
        return "pi", model.split("/", 1)[1], thinking
    if model.startswith(COPILOT_PREFIX):
        return "pi", f"{COPILOT_PROVIDER}/{model[len(COPILOT_PREFIX):]}", thinking
    if model == "agy/neon":
        effort = thinking or "high"
        return "agy", f"gemini-4-neon-{effort}", thinking
    raise _ValidationError(f"unknown model label: {model!r}")


def _pos_int(value):
    return value if type(value) is int and value > 0 else None


def _base_proc(name):
    if not isinstance(name, str) or not name.strip():
        return ""
    return os.path.basename(name.strip()).lstrip("-").lower()


def _foreground_identity(terminal):
    """Return (foreground_pid, normalized_foreground_name) or (None, '') when absent."""
    fg = terminal.get("foreground")
    if not isinstance(fg, dict):
        return None, ""
    fg_pid = _pos_int(fg.get("pid"))
    fg_name = ""
    for key in ("name", "comm", "process", "command", "program"):
        val = fg.get(key)
        if isinstance(val, str) and val.strip():
            fg_name = _base_proc(val)
            break
    return fg_pid, fg_name


def _coordinator_pid(terminal):
    """The process ID representing the coordinator agent inside `terminal`, or None."""
    fg_pid, _ = _foreground_identity(terminal)
    return fg_pid if fg_pid is not None else _pos_int(terminal.get("pid"))


_UNSET = object()


def _read_raw_record(address):
    """Read the raw pane record JSON from disk before the final `hc get`, or None."""
    if not core_local(address):
        return None
    try:
        return read_record(address)
    except (OSError, ValueError):
        return None


def _valid_core_record(terminal, raw_record):
    """Validate an already-read pane record against `terminal` in memory (no disk I/O)."""
    if not core_local(terminal.get("address")):
        return None
    if not isinstance(raw_record, dict) or raw_record.get("backend") != "herdr-core":
        return None
    created, started = raw_record.get("created_at_epoch"), terminal.get("created_ms")
    if not isinstance(created, (int, float)) or not isinstance(started, (int, float)):
        return None
    return raw_record if created >= started / 1000 - CLOCK_SLACK else None


def _core_role_in_memory(terminal, raw_record):
    """Role of `terminal` using a pre-read pane record (no disk I/O)."""
    rec = _valid_core_record(terminal, raw_record)
    role = (rec or {}).get("role") or (terminal.get("labels") or {}).get("skill.role")
    return role if role in ROLES else None


def _core_harness_in_memory(terminal, raw_record):
    """Harness of `terminal` using a pre-read pane record (no disk I/O)."""
    app = (terminal.get("status") or {}).get("app")
    if app:
        return CORE_APP_HARNESS.get(app, app)
    rec = _valid_core_record(terminal, raw_record)
    return (rec or {}).get("harness")


def terminal_agent(terminal, *, record=_UNSET):
    """Return the normalized agent/harness running in `terminal`, or None when none is reported."""
    status = terminal.get("status")
    if isinstance(status, dict):
        app = status.get("app")
        if isinstance(app, str) and app.strip():
            return CORE_APP_HARNESS.get(app.strip(), app.strip())
    top_agent = terminal.get("agent")
    if isinstance(top_agent, str) and top_agent.strip():
        return CORE_APP_HARNESS.get(top_agent.strip(), top_agent.strip())
    rec = core_record(terminal) if record is _UNSET else _valid_core_record(terminal, record)
    if rec and rec.get("harness"):
        return rec["harness"]
    return None


def empty_shell_reason(terminal, *, record=_UNSET):
    """Check idle-shell signals for `terminal`; return None if eligible, else a skip reason.

    These checks lower the risk of typing into an occupied terminal, but are no proof:
    a shell waiting in a builtin (such as `read`) still matches its own PID and name, and a
    foreground program can start after the read. herdr-core has no prompt-readiness check at
    delivery time, and delivery is best effort by the owner's decision.

    Requires:
    - terminal state is "live"
    - no reported app (status.app), no top-level agent, no valid agent record (core_record), and no status.state
    - known foreground process name in SHELL_NAMES
    - known positive terminal PID and foreground PID, with foreground.pid == terminal.pid
    """
    if terminal.get("state") != "live":
        return "terminal is not live"
    status = terminal.get("status")
    if not isinstance(status, dict):
        status = {}
    app = status.get("app")
    if isinstance(app, str) and app.strip():
        return "agent running"
    top_agent = terminal.get("agent")
    if isinstance(top_agent, str) and top_agent.strip():
        return "agent running"
    rec = core_record(terminal) if record is _UNSET else _valid_core_record(terminal, record)
    if rec is not None:
        return "agent running"
    status_state = status.get("state")
    if isinstance(status_state, str) and status_state.strip():
        return f"terminal status is {status_state.strip()}"
    fg_pid, fg_name = _foreground_identity(terminal)
    if not fg_name:
        return "foreground process unknown"
    if fg_name not in SHELL_NAMES:
        return f"foreground is {fg_name}"
    term_pid = _pos_int(terminal.get("pid"))
    if term_pid is None or fg_pid is None:
        return "foreground process unknown"
    if fg_pid != term_pid:
        return "foreground process is not the terminal shell"
    return None


def terminal_tab_role(terminal, coordinator_tabs):
    """Role of a terminal from its herdr.tab ID (LAYOUT.md / panes.py), or None outside role tabs."""
    labels = terminal.get("labels") or {}
    tab = labels.get("herdr.tab") or ""
    if not tab:
        return None
    for role in ROLES:
        if role != "coordinator" and core_role_tab(labels, role) == tab:
            return role
    if tab in coordinator_tabs:
        return "coordinator"
    return None


def _where_is_first_tab(terminal):
    """True when `where` ends in ' / 1' or ' / coordinator' (the dummies-skill first-tab rule)."""
    where = (terminal.get("labels") or {}).get("where")
    return isinstance(where, str) and " / " in where and where.rsplit(" / ", 1)[1] in ("coordinator", "1")


def _in_task_role_tab(terminal):
    """True when `terminal` sits in one of the fixed task-role tabs of its space."""
    labels = terminal.get("labels") or {}
    tab = labels.get("herdr.tab") or ""
    if not tab or not labels.get("herdr.space"):
        return False
    return any(core_role_tab(labels, role) == tab for role in TASK_ROLES)


def _is_fallback_coordinator(terminal, raw_record):
    """Dummies-skill fallback for a coordinator with no role label: a live agent with no role label,
    no role record and no task role, outside task-role tabs, whose `where` ends in ' / 1' or ' / coordinator'."""
    if terminal.get("state") != "live":
        return False
    labels = terminal.get("labels") or {}
    skill_role = labels.get("skill.role")
    if isinstance(skill_role, str) and skill_role.strip():
        return False
    if _core_role_in_memory(terminal, raw_record) is not None or task_terminal(terminal, raw_record):
        return False
    if _in_task_role_tab(terminal):
        return False
    if not _where_is_first_tab(terminal):
        return False
    return bool(present_agent(terminal, raw_record))


def find_coordinator(terminals, *, raw_records=None, fallback=False):
    """The active live coordinator agent terminal of the space, or None.

    An explicit coordinator (valid coordinator record or `skill.role=coordinator`) always wins.
    With `fallback=True`, when no explicit coordinator exists, falls back to `_is_fallback_coordinator`.
    """
    raw = ({t["address"]: _read_raw_record(t["address"]) for t in terminals}
           if raw_records is None else raw_records)
    candidates = [
        t for t in terminals
        if _core_role_in_memory(t, raw.get(t["address"])) == "coordinator"
        and terminal_agent(t, record=raw.get(t["address"]))
    ]
    if not candidates and fallback:
        candidates = [t for t in terminals if _is_fallback_coordinator(t, raw.get(t["address"]))]
    if not candidates:
        return None
    return max(candidates, key=lambda t: (t.get("created_ms") if isinstance(t.get("created_ms"), (int, float)) else -1))


def task_terminal(terminal, raw_record):
    """True when a skill.role label, a -<role>-<n> name or a valid record gives `terminal` a task role."""
    rec = _valid_core_record(terminal, raw_record) or {}
    roles = ((terminal.get("labels") or {}).get("skill.role"), name_role(terminal.get("name")), rec.get("role"))
    return any(r in TASK_ROLES for r in roles)


def _coordinator_marks(terminal, raw_record):
    """(label, record, space): the coordinator label, a valid coordinator record, and the space of that record."""
    rec = _valid_core_record(terminal, raw_record) or {}
    record = rec.get("role") == "coordinator"
    return ((terminal.get("labels") or {}).get("skill.role") == "coordinator", record,
            rec.get("workspace_id") if record else None)


def present_agent(terminal, raw_record):
    """The harness of the agent that runs in `terminal` now, or None.

    Present evidence: the status app or the top-level agent of `hc get`, or a foreground program that is
    no shell (_foreground_identity, SHELL_NAMES as in empty_shell_reason) with the harness of a valid record.
    A saved record alone is no evidence: the terminal can be back at its shell after the agent ended.
    """
    agent = terminal_agent(terminal, record=None)
    if agent:
        return agent
    _, fg_name = _foreground_identity(terminal)
    if fg_name and fg_name not in SHELL_NAMES:
        return terminal_agent(terminal, record=raw_record)
    return None


def plan_coordinator(terminals, space, tab):
    """Choose the coordinator pane of `tab` and the other coordinators of `space` that lose the role.

    Candidates: the live agent terminals of the tab with no task role. The newest (greatest created_ms)
    wins; in a stack it is the bottom pane. With no candidate nothing changes. Return (chosen, flag, clear):
    `flag` is True when the chosen terminal lacks the label or the record, `clear` lists (terminal, label,
    record) for each other terminal of the space with a coordinator label or record and no task role.
    A terminal that `hc ls` lists more than one time counts one time (its first entry).
    """
    unique = {}
    for t in terminals:
        unique.setdefault(t["address"], t)
    terminals = list(unique.values())
    raw = {t["address"]: _read_raw_record(t["address"]) for t in terminals}
    candidates = [t for t in terminals
                  if (t.get("labels") or {}).get("herdr.tab") == tab and t.get("state") == "live"
                  and not task_terminal(t, raw[t["address"]]) and present_agent(t, raw[t["address"]])]
    if not candidates:
        return None, False, []
    chosen = max(candidates, key=lambda t: (t.get("created_ms") if isinstance(t.get("created_ms"), (int, float)) else -1))
    flag = _coordinator_marks(chosen, raw[chosen["address"]]) != (True, True, space)
    clear = []
    for t in terminals:
        if t["address"] == chosen["address"] or task_terminal(t, raw[t["address"]]):
            continue
        label, record, _ = _coordinator_marks(t, raw[t["address"]])
        if label or record:
            clear.append((t, label, record))
    return chosen, flag, clear


def set_coordinator(space, tab, dry_run, deadline):
    """--coordinator: flag the chosen pane first, then clear the others. Print one JSON line."""
    terminals = discover_terminals(space, deadline)
    chosen, flag, clear = plan_coordinator(terminals, space, tab)
    line = {"version": VERSION, "ok": True, "space": space, "tab": tab,
            "coordinator": chosen["address"] if chosen else None}
    if dry_run:
        emit(dict(line, cleared=[t["address"] for t, _, _ in clear], changed=bool(flag or clear), dry_run=True))
        return
    cleared = []
    # flagged: the chosen terminal has the coordinator label now; changed: this run changed something.
    state = {"flagged": bool(chosen) and (chosen.get("labels") or {}).get("skill.role") == "coordinator",
             "changed": False}

    def stop(message):
        emit(dict(line, ok=False, flagged=state["flagged"], cleared=cleared,
                  changed=bool(state["changed"] or cleared), dry_run=False, error=message))
        sys.exit(EXIT["failed"])

    try:
        if flag:
            address = chosen["address"]
            code, _, raw = hc("label", address, "skill.role=coordinator", timeout=remaining_seconds(deadline, cap=20))
            if code != 0:
                stop(f"hc label {address} skill.role=coordinator failed: {(raw or f'exit {code}')[:200]}")
            if not state["flagged"]:  # an identical label write changes nothing
                state["flagged"] = state["changed"] = True
            try:
                write_record(address, core_coordinator_record(chosen, space, present_agent(chosen, _read_raw_record(address))))
            except OSError as exc:
                stop(f"could not write the coordinator record of {address}: {exc.strerror}")
            state["changed"] = True
        for t, label, record in clear:
            address = t["address"]
            if label:
                code, _, raw = hc("label", address, "skill.role=", timeout=remaining_seconds(deadline, cap=20))
                if code != 0:
                    stop(f"hc label {address} skill.role= failed: {(raw or f'exit {code}')[:200]}")
                state["changed"] = True
            if record:
                remove_record(address)  # as handoff.py and close.py do: the old pane is no coordinator any more
            cleared.append(address)
        emit(dict(line, cleared=cleared, changed=bool(state["changed"] or cleared), dry_run=False))
    except _DeadlineExceeded:
        stop("run time limit exceeded")
    except (_ActionError, _ValidationError) as exc:
        stop(str(exc))
    except Exception as exc:  # keep flagged, cleared and changed in the failure line
        traceback.print_exc(file=sys.stderr)
        stop(f"internal error: {type(exc).__name__}")


def discover_all_terminals(deadline):
    """Return {space: [live local terminal records]} across all spaces, bounded by `deadline`.

    Raises _ActionError or _DeadlineExceeded.
    """
    timeout = remaining_seconds(deadline, cap=20)
    code, data, raw = hc("ls", "--json", timeout=timeout)
    if code == 124 and time.monotonic() >= deadline:
        raise _DeadlineExceeded()
    if code != 0 or not isinstance(data, dict) or core_error_kind(data):
        raise _ActionError("could not list herdr-core terminals")
    terminals = data.get("terminals")
    if not isinstance(terminals, list):
        raise _ActionError("invalid herdr-core terminal list")
    by_space = {}
    seen = set()
    for entry in terminals:
        if not isinstance(entry, dict) or not isinstance(entry.get("address"), str) or not entry["address"]:
            raise _ActionError("invalid herdr-core terminal list")
        address = entry["address"]
        if not core_local(address) or address in seen:
            continue
        seen.add(address)
        if isinstance(entry.get("state"), str) and entry["state"] != "live":
            continue
        entry_labels = entry.get("labels")
        if isinstance(entry_labels, dict) and not entry_labels.get("herdr.space"):
            continue
        timeout = remaining_seconds(deadline, cap=20)
        code, rec, raw = hc("get", address, "--json", timeout=timeout)
        if code == 124 and time.monotonic() >= deadline:
            raise _DeadlineExceeded()
        if code == 3 and core_error_kind(rec) == "not_found":
            continue
        if code != 0 or not isinstance(rec, dict) or core_error_kind(rec):
            raise _ActionError(f"could not read herdr-core terminal {address}")
        if rec.get("state") != "live":
            continue
        space = (rec.get("labels") or {}).get("herdr.space")
        if valid_space_id(space):
            by_space.setdefault(space, []).append(dict(rec, address=address))
    return by_space


def coordinator_tokens_all(deadline):
    """--coordinator-tokens: print one JSON line with each space's coordinator token count or null."""
    try:
        by_space = discover_all_terminals(deadline)
        spaces = {}
        for space in sorted(by_space):
            remaining_seconds(deadline)
            terminals = by_space[space]
            raw_records = {t["address"]: _read_raw_record(t["address"]) for t in terminals}
            coordinator = find_coordinator(terminals, raw_records=raw_records, fallback=True)
            _, tokens = coordinator_context(coordinator, deadline)
            spaces[space] = tokens
        remaining_seconds(deadline)
        emit({"version": VERSION, "ok": True, "spaces": spaces})
    except _DeadlineExceeded:
        emit({"version": VERSION, "ok": False, "error": "run time limit exceeded"})
        sys.exit(EXIT["failed"])
    except (_ActionError, _ValidationError) as exc:
        emit({"version": VERSION, "ok": False, "error": str(exc)})
        sys.exit(EXIT["failed"])
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"version": VERSION, "ok": False, "error": f"internal error: {type(exc).__name__}"})
        sys.exit(EXIT["failed"])


def discover_terminals(space, deadline):
    """Return live local terminals in `space`, bounded by `deadline`. Raises _ActionError or _DeadlineExceeded."""
    timeout = remaining_seconds(deadline, cap=20)
    code, data, raw = hc("ls", "--json", "--label", f"herdr.space={space}", timeout=timeout)
    if code == 124 and time.monotonic() >= deadline:
        raise _DeadlineExceeded()
    if code != 0 or not isinstance(data, dict) or core_error_kind(data):
        raise _ActionError("could not list herdr-core terminals")
    out = []
    for entry in data.get("terminals") or []:
        address = entry.get("address") if isinstance(entry, dict) else None
        if not core_local(address):
            continue
        timeout = remaining_seconds(deadline, cap=20)
        code, rec, raw = hc("get", address, "--json", timeout=timeout)
        if code == 124 and time.monotonic() >= deadline:
            raise _DeadlineExceeded()
        if code == 3 and core_error_kind(rec) == "not_found":
            continue
        if code != 0 or not isinstance(rec, dict) or core_error_kind(rec):
            raise _ActionError(f"could not read herdr-core terminal {address}")
        if rec.get("state") != "live":
            continue
        got = (rec.get("labels") or {}).get("herdr.space")
        if got == space:
            out.append(dict(rec, address=address))
    return out


def bounded_core_get(target, deadline):
    """Read one local terminal via `hc get`, bounded by `deadline`. Return (state, record_or_error)."""
    if not isinstance(target, str) or not target or target.startswith("-") or not core_local(target):
        return ("remote" if isinstance(target, str) and "/" in target else "error"), str(target)
    timeout = remaining_seconds(deadline, cap=20)
    code, data, raw = hc("get", target, "--json", timeout=timeout)
    if code == 124 and time.monotonic() >= deadline:
        raise _DeadlineExceeded()
    if code == 3 and core_error_kind(data) == "not_found":
        return "not_found", None
    if code != 0 or not isinstance(data, dict) or core_error_kind(data):
        return "error", raw or core_error_kind(data) or f"exit {code}"
    data = dict(data, address=data.get("address") or target)
    if not core_local(data["address"]):
        return "remote", data
    return "ok", data


def _input_usage(usage, keys):
    """Sum integer input-side usage fields (preserving measured 0), or None when unknown/invalid."""
    if not isinstance(usage, dict):
        return None
    seen = False
    total = 0
    for key in keys:
        if key not in usage or usage[key] is None:
            continue
        value = usage[key]
        if type(value) is not int or value < 0:
            return None
        seen = True
        total += value
    return total if seen else None


def _proc_is_agy(pid):
    """True when `PROC_ROOT/<pid>` is `agy`, False when not or gone, None when unreadable."""
    pdir = os.path.join(PROC_ROOT, str(pid))
    try:
        with open(os.path.join(pdir, "comm"), encoding="utf-8", errors="replace") as f:
            if _base_proc(f.read().strip()) == "agy":
                return True
    except (FileNotFoundError, ProcessLookupError):
        pass
    except OSError:
        return None
    try:
        with open(os.path.join(pdir, "cmdline"), "rb") as f:
            argv0 = f.read().split(b"\x00", 1)[0].decode("utf-8", errors="replace")
            if _base_proc(argv0) == "agy":
                return True
    except (FileNotFoundError, ProcessLookupError):
        pass
    except OSError:
        return None
    return False


def _parse_proc_stat(text, pid):
    """Parse (ppid, starttime) from Linux `/proc/<pid>/stat` text, or None if invalid."""
    if ")" not in text:
        return None
    head, tail = text.rsplit(")", 1)
    if "(" not in head or head.split("(", 1)[0].strip() != str(pid):
        return None
    fields = tail.split()
    if len(fields) < 2:
        return None
    try:
        ppid = int(fields[1])
    except ValueError:
        return None
    if ppid < 0:
        return None
    starttime = None
    if len(fields) > 19:
        try:
            starttime = int(fields[19])
        except ValueError:
            return None
    return ppid, starttime


def _proc_stat(pid):
    """Read (ppid, starttime) from `PROC_ROOT/<pid>/stat`, or None when unreadable or invalid."""
    try:
        with open(os.path.join(PROC_ROOT, str(pid), "stat"), encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    return _parse_proc_stat(text, pid)


def _proc_owned_by(pid, tpid, *, deadline=None):
    """Verify `pid` is `tpid` or a descendant of `tpid` via `PROC_ROOT/<p>/stat`.

    Returns `(pid_stat, tpid_stat)` when ownership is established within `PROC_MAX_DEPTH`, else None.
    """
    if deadline is not None:
        remaining_seconds(deadline)
    if pid <= 0 or tpid <= 0:
        return None
    tpid_stat = _proc_stat(tpid)
    if tpid_stat is None:
        return None
    if pid == tpid:
        return tpid_stat, tpid_stat
    pid_stat = _proc_stat(pid)
    if pid_stat is None:
        return None
    cur_ppid = pid_stat[0]
    visited = {pid}
    for _ in range(PROC_MAX_DEPTH):
        if cur_ppid == tpid:
            return pid_stat, tpid_stat
        if cur_ppid <= 0 or cur_ppid in visited:
            return None
        visited.add(cur_ppid)
        st = _proc_stat(cur_ppid)
        if st is None:
            return None
        cur_ppid = st[0]
    return None


def _proc_children(pid, *, deadline=None):
    """Direct child PIDs of `pid` from PROC_ROOT (`task/*/children`, else `<p>/stat` ppid).

    Returns None when the child listing cannot be read completely.
    """
    if deadline is not None:
        remaining_seconds(deadline)
    children = []
    seen = set()
    task_dir = os.path.join(PROC_ROOT, str(pid), "task")
    tids = None
    try:
        tids = os.listdir(task_dir)
    except FileNotFoundError:
        tids = None
    except OSError:
        return None
    if tids:
        read_count = 0
        for idx, tid in enumerate(tids):
            if deadline is not None and (idx & PROC_DEADLINE_CHECK_MASK) == 0:
                remaining_seconds(deadline)
            try:
                with open(os.path.join(task_dir, tid, "children"), encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except FileNotFoundError:
                continue
            except OSError:
                return None
            read_count += 1
            for tok in text.split():
                try:
                    cpid = int(tok)
                except ValueError:
                    return None
                if cpid <= 0:
                    return None
                if cpid not in seen:
                    seen.add(cpid)
                    children.append(cpid)
        if read_count == len(tids):
            return children
        if read_count > 0:
            return None
    try:
        entries = os.listdir(PROC_ROOT)
    except OSError:
        return None
    for idx, name in enumerate(entries):
        if deadline is not None and (idx & PROC_DEADLINE_CHECK_MASK) == 0:
            remaining_seconds(deadline)
        if not name.isdigit():
            continue
        cpid = int(name)
        if cpid <= 0:
            continue
        try:
            with open(os.path.join(PROC_ROOT, name, "stat"), encoding="utf-8", errors="replace") as f:
                text = f.read()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            return None
        parsed = _parse_proc_stat(text, cpid)
        if parsed is None:
            return None
        if parsed[0] == pid and cpid not in seen:
            seen.add(cpid)
            children.append(cpid)
    return children


def _agy_process_pid(terminal, *, deadline=None):
    """Return `(pid, ident)` for the owned `agy` process in `terminal`, or `(None, None)`.

    Prefers `foreground.pid` when it is an `agy` process owned by `terminal.pid` (same PID or
    descendant via `PROC_ROOT/<pid>/stat`). Otherwise looks for a single owned `agy` child of
    `terminal.pid` (or `terminal.pid` itself if it is `agy` with no `agy` children).
    """
    if deadline is not None:
        remaining_seconds(deadline)
    if not PROC_ROOT or not os.path.isdir(PROC_ROOT):
        return None, None
    tpid = _pos_int(terminal.get("pid"))
    if tpid is None:
        return None, None
    fg_pid, _ = _foreground_identity(terminal)
    if fg_pid is not None:
        fg_agy = _proc_is_agy(fg_pid)
        if fg_agy is None:
            return None, None
        if fg_agy:
            ident = _proc_owned_by(fg_pid, tpid, deadline=deadline)
            if ident is not None:
                return fg_pid, ident
            return None, None
    children = _proc_children(tpid, deadline=deadline)
    if children is None:
        return None, None
    agy_children = []
    for idx, cpid in enumerate(children):
        if deadline is not None and (idx & PROC_DEADLINE_CHECK_MASK) == 0:
            remaining_seconds(deadline)
        child_agy = _proc_is_agy(cpid)
        if child_agy is None:
            return None, None
        if child_agy:
            ident = _proc_owned_by(cpid, tpid, deadline=deadline)
            if ident is None:
                return None, None
            agy_children.append((cpid, ident))
    if len(agy_children) == 1:
        return agy_children[0]
    if len(agy_children) > 1:
        return None, None
    if tpid != fg_pid and _proc_is_agy(tpid) is True:
        ident = _proc_owned_by(tpid, tpid, deadline=deadline)
        if ident is not None:
            return tpid, ident
    return None, None


def _agy_presence_id(pid, agy_home, *, deadline=None):
    """Conversation ID from the single open regular presence lock of `pid` in PROC_ROOT, or None."""
    if deadline is not None:
        remaining_seconds(deadline)
    fd_dir = os.path.join(PROC_ROOT, str(pid), "fd")
    try:
        fd_names = os.listdir(fd_dir)
    except OSError:
        return None
    presence_dir = os.path.abspath(os.path.join(agy_home, "presence"))
    try:
        presence_st = os.stat(presence_dir)
    except OSError:
        return None
    if not stat.S_ISDIR(presence_st.st_mode):
        return None
    presence_roots = {os.path.normpath(presence_dir), os.path.realpath(presence_dir)}
    locks = set()
    for idx, name in enumerate(fd_names):
        if deadline is not None and (idx & PROC_DEADLINE_CHECK_MASK) == 0:
            remaining_seconds(deadline)
        fd_path = os.path.join(fd_dir, name)
        try:
            target = os.readlink(fd_path)
        except FileNotFoundError:
            continue
        except OSError:
            return None
        if not os.path.isabs(target):
            continue
        parent, filename = os.path.split(os.path.normpath(target))
        if not filename.endswith(".lock"):
            continue
        if parent not in presence_roots and os.path.realpath(parent) not in presence_roots:
            continue
        try:
            fd_st = os.stat(fd_path)
        except FileNotFoundError:
            continue
        except OSError:
            return None
        if not stat.S_ISREG(fd_st.st_mode):
            continue
        entry_path = os.path.join(presence_dir, filename)
        try:
            entry_st = os.lstat(entry_path)
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError:
            return None
        if not stat.S_ISREG(entry_st.st_mode):
            continue
        if (fd_st.st_dev, fd_st.st_ino) != (entry_st.st_dev, entry_st.st_ino):
            continue
        locks.add(filename[:-5])
    if deadline is not None:
        remaining_seconds(deadline)
    if len(locks) != 1:
        return None
    conv_id = next(iter(locks))
    if not conv_id or conv_id in (".", "..") or not AGY_CONV_ID.fullmatch(conv_id):
        return None
    return conv_id


def agy_transcript(terminal, *, deadline=None):
    """Resolve the transcript path of a live `agy` terminal via its single open presence lock, or None."""
    if deadline is not None:
        remaining_seconds(deadline)
    if not AGY_HOME or not PROC_ROOT or not os.path.isdir(PROC_ROOT):
        return None
    agy_home = os.path.expanduser(os.fspath(AGY_HOME))
    tpid = _pos_int(terminal.get("pid"))
    if tpid is None:
        return None
    pid, ident = _agy_process_pid(terminal, deadline=deadline)
    if pid is None:
        return None
    conv_id = _agy_presence_id(pid, agy_home, deadline=deadline)
    if not conv_id:
        return None
    after = _proc_owned_by(pid, tpid, deadline=deadline)
    if after != ident or _proc_is_agy(pid) is not True:
        return None
    brain_dir = os.path.join(agy_home, "brain")
    transcript = os.path.join(brain_dir, conv_id, _common.AGY_TRANSCRIPT)
    if os.path.islink(transcript) or not os.path.isfile(transcript):
        return None
    expected = os.path.join(os.path.realpath(brain_dir), conv_id, _common.AGY_TRANSCRIPT)
    if os.path.realpath(transcript) != expected:
        return None
    if deadline is not None:
        remaining_seconds(deadline)
    return transcript


def transcript_tokens(path, agent, *, deadline=None):
    """Input-side context token count of the last valid assistant message, or None.

    Claude Code: input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
    Pi: input + cacheRead + cacheWrite.
    agy: input_tokens + cache_read_tokens of the last PLANNER_RESPONSE row with status DONE.
    Preserves a measured zero; returns None when input-side usage is absent or invalid.
    Sidechain and API-error records are ignored before compaction boundaries apply.
    Checks the deadline before, periodically during, and after the scan (local file reads
    are not supervised by a separate thread or process).
    """
    last = None
    if agent == "agy":
        keys = ("input_tokens", "cache_read_tokens")
    elif agent in PI_AGENTS:
        keys = ("input", "cacheRead", "cacheWrite")
    else:
        keys = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    if deadline is not None:
        remaining_seconds(deadline)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for idx, line in enumerate(f):
                if deadline is not None and (idx & 1023) == 0:
                    remaining_seconds(deadline)
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict):
                    continue
                if agent == "agy":
                    if entry.get("type") != "PLANNER_RESPONSE" or entry.get("status") != "DONE":
                        continue
                    last = _input_usage(entry, keys)
                    continue
                if entry.get("isSidechain") or entry.get("isApiErrorMessage"):
                    continue
                if (entry.get("type") == "compaction"
                        or (entry.get("type") == "system" and entry.get("subtype") == "compact_boundary")):
                    last = None
                    continue
                msg = entry.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                if agent in PI_AGENTS and msg.get("stopReason") in ("aborted", "error"):
                    continue
                last = _input_usage(msg.get("usage"), keys)
    except OSError:
        last = None
    if deadline is not None:
        remaining_seconds(deadline)
    return last


def coordinator_context(terminal, deadline):
    """Resolve coordinator transcript path and input-side token count: (path, tokens).

    Claude Code and Pi use ask.core_transcript; agy resolves its single open presence lock under PROC_ROOT.
    """
    if not terminal:
        return None, None
    remaining_seconds(deadline)
    try:
        info = core_info(terminal)
        agent = info.get("agent") or terminal_agent(terminal)
        if agent == "agy":
            path = agy_transcript(terminal, deadline=deadline)
            remaining_seconds(deadline)
        else:
            path, _, _ = ask.core_transcript(info, None, 0, None, 0, 0)
            remaining_seconds(deadline)
            if not path and agent == "claude":
                tpid = _pos_int(terminal.get("pid"))
                if tpid is not None and tpid != info.get("pid"):
                    path, _, _ = ask.core_transcript(dict(info, pid=tpid), None, 0, None, 0, 0)
                    remaining_seconds(deadline)
    except (OSError, UnicodeError):
        return None, None
    if not path:
        return None, None
    tokens = transcript_tokens(path, agent, deadline=deadline)
    return os.path.realpath(path), tokens


def format_tokens(tokens):
    if tokens >= 1000:
        return f"{round(tokens / 1000)}K"
    return str(tokens)


def build_preview(launch, roles, tokens, do_handoff, *, empty_space=False, handoff_skip_reason=None):
    """Build a short human preview line of at most PREVIEW_MAX (120) characters."""
    if empty_space:
        return "Start: empty space, nothing to do"
    n = len(launch)
    launch_part = f"launch {n} empty terminal{'s' if n != 1 else ''}" if n else ""
    coord_part = ""
    coord_spec = roles.get("coordinator")
    if do_handoff and coord_spec and tokens is not None:
        target = f"{coord_spec['model']} {coord_spec['thinking']}" if "thinking" in coord_spec else coord_spec["model"]
        coord_part = f"coordinator at {format_tokens(tokens)}, hand off to {target}"
    elif coord_spec and handoff_skip_reason:
        if tokens is not None:
            coord_part = f"coordinator at {format_tokens(tokens)}, no handoff ({handoff_skip_reason})"
        else:
            coord_part = f"no coordinator handoff ({handoff_skip_reason})"
    elif coord_spec:
        if tokens is None:
            coord_part = "coordinator tokens unknown, no handoff"
        else:
            coord_part = f"coordinator at {format_tokens(tokens)}, no handoff"

    if launch_part and coord_part:
        preview = f"Start: {launch_part}; {coord_part}"
    elif launch_part:
        preview = f"Start: {launch_part}"
    elif coord_part:
        preview = f"Start: {coord_part}" if do_handoff else f"Start: nothing to launch; {coord_part}"
    else:
        preview = "Start: nothing to do"

    if len(preview) > PREVIEW_MAX:
        preview = preview[:PREVIEW_MAX - 3] + "..."
    return preview


def plan_space(terminals, roles, deadline):
    """Compute launch plan, skip list, and coordinator handoff details."""
    raw_records = {t["address"]: _read_raw_record(t["address"]) for t in terminals}
    coordinator_tabs = {
        (t.get("labels") or {}).get("herdr.tab")
        for t in terminals
        if _core_role_in_memory(t, raw_records.get(t["address"])) == "coordinator"
        and (t.get("labels") or {}).get("herdr.tab")
    }
    launch = []
    launch_sources = {}
    skip = []
    for t in terminals:
        addr = t["address"]
        role = terminal_tab_role(t, coordinator_tabs)
        if role is None:
            skip.append({"terminal": addr, "role": None, "reason": "outside role tab"})
            continue
        reason = empty_shell_reason(t, record=raw_records.get(addr))
        if reason is not None:
            skip.append({"terminal": addr, "role": role, "reason": reason})
            continue
        config_role = "researcher" if role == "scout" else role
        spec = roles.get(config_role)
        if spec is None:
            skip.append({"terminal": addr, "role": role, "reason": "role on Any"})
            continue
        item = {"terminal": addr, "role": role, "model": spec["model"]}
        if "thinking" in spec:
            item["thinking"] = spec["thinking"]
        launch.append(item)
        launch_sources[addr] = t

    coordinator = find_coordinator(terminals, raw_records=raw_records)
    token_coordinator = coordinator or find_coordinator(terminals, raw_records=raw_records, fallback=True)
    coord_identity = None
    if coordinator:
        coord_rec = raw_records.get(coordinator["address"])
        coord_identity = {
            "tab": (coordinator.get("labels") or {}).get("herdr.tab") or "",
            "role": _core_role_in_memory(coordinator, coord_rec),
            "harness": _core_harness_in_memory(coordinator, coord_rec),
            "cpid": _coordinator_pid(coordinator),
            "tpid": _pos_int(coordinator.get("pid")),
        }
    coord_transcript, tokens = coordinator_context(token_coordinator, deadline)
    coord_spec = roles.get("coordinator")
    do_handoff = False
    handoff_skip_reason = None
    if coordinator and coord_spec and tokens is not None and tokens > HANDOFF_TOKEN_LIMIT:
        live_harness = coord_identity["harness"]
        if live_harness not in ("claude", *PI_AGENTS):
            handoff_skip_reason = f"{live_harness or 'unknown'} cannot hand off"
        else:
            do_handoff = True
    elif not coordinator and token_coordinator and coord_spec and tokens is not None and tokens > HANDOFF_TOKEN_LIMIT:
        handoff_skip_reason = "no coordinator role"
    if handoff_skip_reason and coordinator:
        coord_addr = coordinator["address"]
        for entry in skip:
            if entry["terminal"] == coord_addr:
                entry["reason"] = f"{entry['reason']}; {handoff_skip_reason}"
                break
        else:
            skip.append({"terminal": coord_addr, "role": "coordinator", "reason": handoff_skip_reason})
    return {
        "launch": launch,
        "launch_sources": launch_sources,
        "skip": skip,
        "coordinator": coordinator,
        "coord_identity": coord_identity,
        "coord_transcript": coord_transcript,
        "tokens": tokens,
        "do_handoff": do_handoff,
        "handoff_skip_reason": handoff_skip_reason,
    }


def _validate_roles_config(cfg):
    """Validate the required shape of roles.json before passing it to spawn.py."""
    if not isinstance(cfg, dict):
        raise _ValidationError("invalid roles.json: root must be an object")
    roles = cfg.get("roles")
    if not isinstance(roles, dict):
        raise _ValidationError("invalid roles.json: missing or invalid 'roles' object")
    missing = [role for role in ROLES if role not in roles]
    if missing:
        raise _ValidationError(f"invalid roles.json: missing role(s): {', '.join(missing)}")
    for role_name, entry in roles.items():
        if not isinstance(entry, dict):
            raise _ValidationError(f"invalid roles.json: roles.{role_name} must be an object")
        if entry.get("session") not in ("primary", "subagent"):
            raise _ValidationError(f"invalid roles.json: roles.{role_name}.session must be 'primary' or 'subagent'")
        if entry.get("access") not in ("read", "write"):
            raise _ValidationError(f"invalid roles.json: roles.{role_name}.access must be 'read' or 'write'")
        if not isinstance(entry.get("web"), bool):
            raise _ValidationError(f"invalid roles.json: roles.{role_name}.web must be a boolean")
        if not isinstance(entry.get("focus"), str):
            raise _ValidationError(f"invalid roles.json: roles.{role_name}.focus must be a string")
    if "launch" in cfg and cfg["launch"] is not None and not isinstance(cfg["launch"], dict):
        raise _ValidationError("invalid roles.json: 'launch' must be an object")
    return cfg


def load_roles_config():
    """Load and validate roles.json, converting I/O, UTF-8, JSON, or shape errors into _ValidationError."""
    try:
        cfg = skill_json("roles.json")
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise _ValidationError(f"could not read roles.json: {exc}") from None
    return _validate_roles_config(cfg)


def _validate_catalog():
    """Validate resources.json and optional machine catalog before spawn.build_command loads them."""
    try:
        data = skill_json("resources.json")
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise _ValidationError(f"could not read resources.json: {exc}") from None
    if not isinstance(data, dict):
        raise _ValidationError("invalid resources.json: root must be an object")
    resources = data.get("resources", {})
    if not isinstance(resources, dict) or any(not isinstance(v, dict) for v in resources.values()):
        raise _ValidationError("invalid resources.json: 'resources' must be an object of objects")
    machine_path = spawn._common.MACHINE_CATALOG
    if machine_path and os.path.exists(machine_path):
        try:
            with open(machine_path, encoding="utf-8") as f:
                extra = json.load(f)
        except (OSError, UnicodeError, json.JSONDecodeError):
            return
        if isinstance(extra, dict):
            extra_res = extra.get("resources")
            if extra_res is not None and (not isinstance(extra_res, dict)
                                          or any(not isinstance(v, dict) for v in extra_res.values())):
                raise _ValidationError(f"invalid {machine_path}: 'resources' must be an object of objects")
            extra_launch = extra.get("launch")
            if extra_launch is not None and not isinstance(extra_launch, dict):
                raise _ValidationError(f"invalid {machine_path}: 'launch' must be an object")


def build_shell_launch(terminal, item, cfg, seen_terminals, deadline):
    """Build the shell command line for launching an agent using spawn.py's shared builder.

    Sets item["harness"], item["name"] and item["program"] (the executable that the command starts); for agy,
    build_command writes the role prompt file of `name`.
    """
    harness, model, thinking = map_label(item["model"], item.get("thinking"))
    name = make_name(core_project(terminal), item["role"], seen_terminals)
    item["harness"], item["name"] = harness, name
    seen_terminals.append({"name": name})
    try:
        cwd = (terminal.get("foreground") or {}).get("cwd") or terminal.get("cwd") or os.getcwd()
    except OSError as exc:
        raise _ValidationError(f"could not determine working directory: {exc}") from None
    _validate_catalog()
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            # Compute model lookup budget right at the lookup call, after all setup work above.
            lookup_timeout = remaining_seconds(deadline, cap=60)
            resolved = spawn.resolve({
                "harness": harness,
                "role": item["role"],
                "model": model,
                "thinking": thinking,
                "interactive": False,
                "strict": False,
            }, cfg, lookup_timeout=lookup_timeout)
            remaining_seconds(deadline)
            executable, _, argv = spawn.build_command(resolved, cfg, name, cwd, write=True)
            item["program"] = executable
    except SystemExit as exc:
        if time.monotonic() >= deadline:
            raise _DeadlineExceeded() from None
        msg = err.getvalue().strip() or (str(exc.code) if isinstance(exc.code, str) else f"spawn builder exit {exc.code}")
        raise _ValidationError(msg) from None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise _ValidationError(f"could not build launch command: {exc}") from None
    return shlex.join(argv)


HANDOFF_TASK_ROLES = ("researcher", "worker", "reviewer")


def handoff_roles_value(roles):
    """Return `<role>:<harness>:<model>[:<thinking>],...` for the task roles of the payload, or None."""
    parts = []
    for role in HANDOFF_TASK_ROLES:
        spec = (roles or {}).get(role)
        if spec is None:
            continue
        fields = [role, *(f for f in map_label(spec["model"], spec.get("thinking")) if f)]
        for field in fields:
            if not field or any(ch in field for ch in " ,:\t\n"):
                raise _ValidationError(f"cannot pass the {role} choice to the handoff: bad value {field!r}")
        parts.append(":".join(fields))
    return ",".join(parts) or None


def handoff_command(coord_harness, coord_spec, roles=None):
    """Build the slash command matching handoff_coordinator.md: <prefix> <harness> <model> [<thinking>] [roles=...].

    `roles` is the validated payload roles; the task-role choices go into one `roles=` argument."""
    if coord_harness == "claude":
        prefix = "/tenantext:handoff_coordinator"
    elif coord_harness in PI_AGENTS:
        prefix = "/handoff_coordinator"
    else:
        raise _ValidationError(f"unsupported coordinator harness for handoff: {coord_harness or 'unknown'}")
    target_harness, target_model, target_thinking = map_label(coord_spec["model"], coord_spec.get("thinking"))
    parts = [prefix, target_harness, target_model]
    # The agy slug carries the effort (gemini-4-neon-<effort>), so the command gives no second thinking level.
    if target_thinking and target_harness != "agy":
        parts.append(target_thinking)
    roles_value = handoff_roles_value(roles)
    if roles_value:
        parts.append(f"roles={roles_value}")
    return " ".join(parts)


NOTICE_RULES = ("Start each pane of these roles with these inputs. They come before the local models file and before your "
                "memory of earlier defaults. A later word of the owner for one task or one role comes before them. A role "
                "that this line does not name uses the request or the local models file. No reply is needed; continue "
                "your work.")


def role_models_notice(roles):
    """The one-line role models notice for the task roles of the payload, or None with no task role."""
    parts = []
    for role in HANDOFF_TASK_ROLES:
        spec = (roles or {}).get(role)
        if spec is None:
            continue
        harness, model, thinking = map_label(spec["model"], spec.get("thinking"))
        inputs = f"--harness {harness} --model {model}" + (f" --thinking {thinking}" if thinking else "")
        parts.append(f"{'researcher (also scout)' if role == 'researcher' else role}: {inputs}")
    if not parts:
        return None
    return ('[Herdr app Start] The owner chose these role models in the window "Role models": '
            + "; ".join(parts) + ". " + NOTICE_RULES)


def _notice_record_path():
    return os.path.join(_result_folder(), NOTICE_RECORD)


def read_notice_record():
    """The notice record as a map of entries newer than RESULT_KEEP_SECONDS; {} when it cannot be read."""
    try:
        with open(_notice_record_path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    cutoff = time.time() - RESULT_KEEP_SECONDS
    return {k: v for k, v in data.items()
            if isinstance(v, dict) and isinstance(v.get("time"), (int, float)) and v["time"] >= cutoff}


def notice_already_sent(address, value, cpid, tpid):
    """True when the record holds this value for this address and both PIDs."""
    entry = read_notice_record().get(address)
    return (isinstance(entry, dict) and entry.get("value") == value and cpid is not None and tpid is not None
            and entry.get("pid") == cpid and entry.get("tpid") == tpid)


def write_notice_record(address, value, cpid, tpid):
    """Add the entry of a started or delivered notice; an OSError leaves the record as it was."""
    with contextlib.suppress(OSError):
        os.makedirs(_result_folder(), mode=0o700, exist_ok=True)
        data = read_notice_record()
        data[address] = {"value": value, "pid": cpid, "tpid": tpid, "time": round(time.time())}
        _write_private(_notice_record_path(), data)


def plan_notice(plan, roles):
    """The role models notice of a plan: None, {"skip": reason}, or {"value": ..., "text": ...}.

    A notice needs a live coordinator, no handoff, one or more task roles, and no equal entry in the record."""
    coordinator = plan["coordinator"]
    if not coordinator or plan["do_handoff"]:
        return None
    try:
        value = handoff_roles_value(roles)
    except _ValidationError as exc:
        return {"skip": f"role models notice not sent: {exc}"}
    if not value:
        return None
    ident = plan["coord_identity"]
    if notice_already_sent(coordinator["address"], value, ident["cpid"], ident["tpid"]):
        return None
    return {"value": value, "text": role_models_notice(roles)}


def validate_launch_reread(state, fresh, space, orig_tab, orig_fg, role, raw_record):
    """In-memory pre-send check on `fresh` for a launch target; return None if eligible, else a skip reason.

    Runs immediately after the final `hc get` using only in-memory data (`raw_record` was read
    from disk before `hc get`). Lowers the risk of typing into a moved or occupied terminal, but
    is no proof: herdr-core has no shell-prompt check at delivery time, and delivery is best
    effort by the owner's decision.
    """
    if state != "ok" or not isinstance(fresh, dict):
        return "terminal is no longer available"
    labels = fresh.get("labels") or {}
    if labels.get("herdr.space") != space:
        return "terminal moved to another space"
    fresh_tab = labels.get("herdr.tab") or ""
    if not fresh_tab or fresh_tab != orig_tab:
        return "terminal moved to another tab"
    if role != "coordinator" and core_role_tab(labels, role) != fresh_tab:
        return "terminal moved to another role tab"
    shell_err = empty_shell_reason(fresh, record=raw_record)
    if shell_err is not None:
        return shell_err
    if _foreground_identity(fresh) != orig_fg:
        return "terminal foreground changed before launch"
    return None


def validate_coordinator_transcript(orig_transcript, fresh_transcript, fresh_tokens):
    """Return None if the coordinator transcript is unchanged and still above 200000 tokens, else a skip reason."""
    if not fresh_transcript or fresh_transcript != orig_transcript:
        return "coordinator transcript changed before handoff"
    if fresh_tokens is None or fresh_tokens <= HANDOFF_TOKEN_LIMIT:
        return "coordinator token count is no longer above 200000"
    return None


def validate_coordinator_reread(state, fresh, space, orig_identity, raw_record):
    """In-memory pre-send metadata check on `fresh` for a handoff target; return None if eligible, else a skip reason.

    Runs immediately after the final `hc get` with no disk read or transcript scan afterward:
    `raw_record` was read from disk before `hc get` and `orig_identity` was cached at plan time.
    Lowers race risk only: herdr-core has no session-identity or `done`-state check at delivery
    time, and delivery is best effort by the owner's decision.
    """
    if state != "ok" or not isinstance(fresh, dict) or fresh.get("state") != "live":
        return "coordinator terminal is no longer live"
    labels = fresh.get("labels") or {}
    if labels.get("herdr.space") != space:
        return "coordinator terminal moved to another space"
    orig_tab = orig_identity["tab"]
    fresh_tab = labels.get("herdr.tab") or ""
    if (not fresh_tab or fresh_tab != orig_tab
            or orig_identity["role"] != "coordinator"
            or _core_role_in_memory(fresh, raw_record) != "coordinator"):
        return "coordinator terminal moved to another role tab"
    if (not terminal_agent(fresh, record=raw_record)
            or _core_harness_in_memory(fresh, raw_record) != orig_identity["harness"]):
        return "coordinator agent changed before handoff"
    orig_cpid = orig_identity["cpid"]
    orig_tpid = orig_identity["tpid"]
    if (orig_cpid is None or _coordinator_pid(fresh) != orig_cpid
            or orig_tpid is None or _pos_int(fresh.get("pid")) != orig_tpid):
        return "coordinator session PID changed before handoff"
    return None


def coordinator_prompt_state(terminal):
    """Return (True, state) when the coordinator sits at its prompt, else (False, refusal reason).

    At the prompt: status `idle` or `done`, or `working` with a message that ends in " still running"
    and at least one working child record (a completed turn that waits only for background work).
    """
    status = terminal.get("status") or {}
    state = status.get("state")
    if state in ("idle", "done"):
        return True, state
    shown = state.strip() if isinstance(state, str) and state.strip() else "missing"
    if state == "working":
        msg = status.get("msg")
        records = terminal.get("records")
        # `hc get` gives a child record as an object ({"state": "working", ...}) or as its bare state string.
        background = isinstance(records, dict) and any(
            (r.get("state") if isinstance(r, dict) else r) == "working" for r in records.values())
        if isinstance(msg, str) and msg.endswith(AWAITED_SUFFIX) and len(msg) > len(AWAITED_SUFFIX) and background:
            return True, state
        return False, "runs a turn (status working); wait for the end of the turn and press Start again"
    if state == "blocked":
        return False, "status is blocked; answer the question in the terminal and press Start again"
    return False, f"status is {shown}; look at the terminal and press Start again"


def run_hc_send(address, text, *, if_idle=False, deadline=None, reply=None):
    """Best-effort send via hc send (never --force, no --wait, no retry). Return (outcome, message).

    A dict `reply` gets the keys of the JSON object that `hc send --json` printed; the outcome does not change.

    Waits for the smaller of SEND_LIMIT_SECONDS (90 s) and the remaining deadline.
    outcome is "ok", "not_delivered" (exit 10 status_mismatch or exit 9 blocked), or "error".
    When a send times out, reports that the delivery outcome is unknown and never retries.
    """
    timeout = remaining_seconds(deadline, cap=SEND_LIMIT_SECONDS) if deadline is not None else SEND_LIMIT_SECONDS
    args = ["send", "--json"]
    if if_idle:
        args += ["--if", "idle"]
    code, data, raw = hc(*args, "--", address, text, timeout=timeout)
    if reply is not None and isinstance(data, dict):
        reply.update(data)
    kind = core_error_kind(data)
    if code == 124 or kind == "timeout":
        if deadline is not None and time.monotonic() >= deadline:
            return "error", f"hc send {address} timed out at run time limit; delivery outcome is unknown"
        return "error", f"hc send {address} timed out; delivery outcome is unknown"
    if code == HC_STATUS_MISMATCH_EXIT or kind == "status_mismatch":
        return "not_delivered", f"terminal {address} status changed before send"
    if code == HC_BLOCKED_EXIT or (kind and "block" in kind):
        return "not_delivered", f"terminal {address} is blocked"
    if code != 0 or not isinstance(data, dict) or kind:
        detail = raw or kind or f"exit {code}"
        return "error", f"hc send {address} failed: {detail[:200]}"
    return "ok", ""


def _result_folder():
    return os.path.abspath(os.path.join(_common.STATE_DIR, RESULT_FOLDER))


def _write_private(path, data):
    """Write `data` as JSON to `path`, mode 600, atomic: a temp file in the same folder, then os.replace."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def start_handoff_send(address, text, *, if_idle, kind="handoff"):
    """Start the handoff `hc send` in a background terminal of herdr-core; return its result file, or None.

    `kind` is the prefix of the file names: "handoff" (the app reads `handoff-send-*.json`) or "notice".

    `hc exec` ends each process that this script starts when the script ends, so the send runs in a terminal of
    herdr-core: `hc run --json --bg --no-parent --rm --no-notify -- <python> role_set.py SEND_HANDOFF_FLAG <job>`,
    with no herdr.space or herdr.tab label, so no space of the app shows it. The job file (mode 600) is deleted by
    the child. Result files older than RESULT_KEEP_SECONDS are deleted first. When the terminal does not start
    (an OSError on the job file, non-zero exit, no JSON with an address, a missing CLI, a timeout), the job file
    is deleted and None returned.
    """
    folder = _result_folder()
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    result = os.path.join(folder, f"{kind}-send-{run_id}.json")
    job = os.path.join(folder, f"{kind}-job-{run_id}.json")
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
        cutoff = time.time() - RESULT_KEEP_SECONDS
        for name in os.listdir(folder):
            if name.startswith(("handoff-send-", "notice-send-")) and name.endswith(".json"):
                with contextlib.suppress(OSError):
                    path = os.path.join(folder, name)
                    if os.path.getmtime(path) < cutoff:
                        os.unlink(path)
        _write_private(job, {"terminal": address, "text": text, "if_idle": bool(if_idle), "result": result})
    except OSError:
        return None
    # hc() returns 127 for a missing CLI or an OSError and 124 for a timeout of the call; --bg comes back at once.
    code, data, _raw = hc("run", "--json", "--bg", "--no-parent", "--rm", "--no-notify", "--",
                          sys.executable, os.path.abspath(__file__), SEND_HANDOFF_FLAG, job, timeout=15)
    if code == 0 and isinstance(data, dict) and isinstance(data.get("address"), str) and data["address"]:
        return result
    with contextlib.suppress(OSError):
        os.unlink(job)
    return None


def send_handoff_child(job):
    """Hidden mode of the background terminal: run the handoff send of `job`, then write its result file.

    main() has removed HC_TERMINAL_ID before this runs, so `hc send` does not wrap the text as a message between
    agents although the child runs inside a terminal of herdr-core.
    """
    if os.path.dirname(os.path.abspath(job)) != _result_folder():
        sys.exit(EXIT["failed"])
    with open(job, encoding="utf-8") as f:
        spec = json.load(f)
    with contextlib.suppress(OSError):
        os.unlink(job)
    start = time.monotonic()
    reply = {}
    try:
        outcome, detail = run_hc_send(spec["terminal"], spec["text"], if_idle=bool(spec.get("if_idle")), reply=reply)
    except Exception as exc:
        outcome, detail = "error", f"internal error: {type(exc).__name__}"
    data = {"version": VERSION, "terminal": spec["terminal"], "ok": outcome == "ok", "outcome": outcome}
    if outcome != "ok":
        data["error"] = detail
    data.update(send_ms=round((time.monotonic() - start) * 1000), send_result=reply,
                finished=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    _write_private(spec["result"], data)
    sys.exit(EXIT["ok"] if outcome == "ok" else EXIT["failed"])


def agy_ready_state(state, fresh, program):
    """(status, reason): "ready" with the status state, "wait" with what the terminal runs, or "failed" with the reason.

    Ready needs the agy app of herdr-core in `status.app` and the started program in `foreground`; a record with no
    foreground is not ready.
    """
    if state != "ok" or not isinstance(fresh, dict) or fresh.get("state") != "live":
        return "failed", "terminal is no longer available or the agent ended"
    status = fresh.get("status") if isinstance(fresh.get("status"), dict) else {}
    app, current = status.get("app"), status.get("state")
    fg = fresh.get("foreground") if isinstance(fresh.get("foreground"), dict) else {}
    argv = fg.get("argv") if isinstance(fg.get("argv"), list) else []
    names = {n for n in (fg.get("name"), argv[0] if argv else None) if isinstance(n, str) and n}
    runs_program = os.path.basename(program) in {os.path.basename(n) for n in names}
    is_agy = CORE_APP_HARNESS.get(app) == "agy"
    if is_agy and runs_program and current in spawn.APP_READY:
        return "ready", current
    if is_agy and runs_program and current == "blocked":
        return "failed", "agy stopped at a question (for example folder trust); answer it in the terminal"
    shown = ", ".join(sorted(names)) or "no reported program"
    return "wait", f"the terminal runs {shown} (app {app or 'none'}, status {current or 'none'})"


def send_agy_role_prompts(deadline):
    """Send the first message of spawn.py (agy_first_message) to each pending agy pane, without waiting for its turn.

    Waits at most AGY_READY_SECONDS in total for the ready status of the panes; each read is bounded by that shared
    cutoff, and a pane that is not ready at the cutoff gets "not sent" (the run goes on). A send that starts keeps the
    run deadline, so its outcome is known. Sends with `--if idle` for an idle pane. Emits one launch line for each
    pane: first_message "sent" (delivered, the turn is not confirmed) or "not sent" with first_message_error.
    """
    start = time.monotonic()
    ready_end = min(start + AGY_READY_SECONDS, deadline)
    seen = {}
    while _agy_pending:
        for entry in list(_agy_pending):
            if time.monotonic() >= ready_end:
                break
            try:
                status, reason = agy_ready_state(*bounded_core_get(entry["terminal"], ready_end), entry["program"])
            except _DeadlineExceeded:
                break
            if status == "wait":
                seen[entry["terminal"]] = reason
                continue
            if status == "ready":
                outcome, detail = run_hc_send(entry["terminal"], spawn.agy_first_message(entry["name"]),
                                              if_idle=(reason == "idle"), deadline=deadline)
                entry["result"] = (True, None) if outcome == "ok" else (False, detail)
            else:
                entry["result"] = (False, reason)
            flush_agy_entry(entry)
        if not _agy_pending:
            break
        if time.monotonic() + AGY_POLL_SECONDS >= ready_end:
            waited = round(time.monotonic() - start)
            for entry in list(_agy_pending):
                last = seen.get(entry["terminal"]) or "the terminal was not read"
                entry["result"] = (False, f"agy gave no ready status in {waited} seconds; {last}")
                flush_agy_entry(entry)
            break
        time.sleep(AGY_POLL_SECONDS)


def send_role_models_notice(coord_addr, notice, space, coord_identity, deadline, done):
    """Send the role models notice to the coordinator at its prompt; a skip goes to stderr and writes no record.

    The same checks as the handoff before the send, but no transcript or token check: the final `hc get`, then
    validate_coordinator_reread and coordinator_prompt_state. Only an error of that `hc get` fails the run."""
    remaining_seconds(deadline)
    raw_record = _read_raw_record(coord_addr)
    state, fresh = bounded_core_get(coord_addr, deadline)
    if state == "error":
        fail_run(f"could not read coordinator terminal {coord_addr}: {str(fresh)[:200]}", done)
    skip_reason = validate_coordinator_reread(state, fresh, space, coord_identity, raw_record)
    if skip_reason is None:
        at_prompt, status_state = coordinator_prompt_state(fresh)
        if not at_prompt:
            skip_reason = status_state
    if skip_reason is not None:
        log_skip(coord_addr, f"role models notice not sent: {skip_reason}")
        return
    pids = (coord_identity["cpid"], coord_identity["tpid"])
    if_idle = status_state == "idle"
    result = start_handoff_send(coord_addr, notice["text"], if_idle=if_idle, kind="notice")
    if result is not None:
        write_notice_record(coord_addr, notice["value"], *pids)
        emit({"version": VERSION, "action": "role_models", "terminal": coord_addr, "ok": True,
              "pending": True, "result": result})
        return
    outcome, detail = run_hc_send(coord_addr, notice["text"], if_idle=if_idle, deadline=deadline)
    if outcome != "ok":
        log_skip(coord_addr, f"role models notice not sent: {detail}")
        return
    write_notice_record(coord_addr, notice["value"], *pids)
    emit({"version": VERSION, "action": "role_models", "terminal": coord_addr, "ok": True})


def main(argv=None):
    global _times, _run_start
    _run_start = time.monotonic()
    deadline = _run_start + RUN_LIMIT_SECONDS
    _agy_pending.clear()
    _times = None
    _open_steps.clear()
    # Ensure hc send does not tag commands as agent-to-agent messages if invoked from a core terminal.
    os.environ.pop("HC_TERMINAL_ID", None)
    done = 0
    try:
        argv = sys.argv[1:] if argv is None else argv
        if len(argv) == 2 and argv[0] == SEND_HANDOFF_FLAG:
            send_handoff_child(argv[1])
        if "--coordinator-tokens" in argv:
            if argv != ["--coordinator-tokens"]:
                bad_input("--coordinator-tokens takes no other argument")
            coordinator_tokens_all(_run_start + COORDINATOR_TOKENS_LIMIT_SECONDS)
            return
        if "--coordinator" in argv:
            space, tab, dry_run = parse_coordinator_args(argv)
            set_coordinator(space, tab, dry_run, deadline)
            return
        raw_set, dry_run = parse_args(argv)
        if raw_set is None:
            list_models()
            return
        space, roles = validate_payload(raw_set)
        if not dry_run:
            _times = {}

        with timed("discover"):
            terminals = discover_terminals(space, deadline)
        if not terminals:
            remaining_seconds(deadline)
            if dry_run:
                emit({
                    "version": VERSION,
                    "ok": True,
                    "space": space,
                    "preview": build_preview([], roles, None, False, empty_space=True),
                    "coordinator_tokens": None,
                    "handoff": False,
                    "role_models": False,
                    "launch": [],
                    "skip": [],
                })
            else:
                emit(with_times({"version": VERSION, "ok": True, "done": 0}))
            return

        with timed("plan"):
            plan = plan_space(terminals, roles, deadline)
        launch = plan["launch"]
        launch_sources = plan["launch_sources"]
        skip = plan["skip"]
        coordinator = plan["coordinator"]
        coord_identity = plan["coord_identity"]
        coord_transcript = plan["coord_transcript"]
        tokens = plan["tokens"]
        do_handoff = plan["do_handoff"]
        handoff_skip_reason = plan["handoff_skip_reason"]
        notice = plan_notice(plan, roles)

        if dry_run:
            remaining_seconds(deadline)
            emit({
                "version": VERSION,
                "ok": True,
                "space": space,
                "preview": build_preview(launch, roles, tokens, do_handoff,
                                         handoff_skip_reason=handoff_skip_reason),
                "coordinator_tokens": tokens,
                "handoff": do_handoff,
                "role_models": bool(notice and "text" in notice),
                "launch": launch,
                "skip": skip,
            })
            return

        cfg = load_roles_config()
        seen_terminals = list(terminals)
        # Build the handoff command before any launch: a choice that cannot go into it refuses the run first.
        handoff_cmd = handoff_command(coord_identity["harness"], roles["coordinator"], roles) if do_handoff else None

        # Report plan-time skips on stderr (one line per skipped terminal, excluding a coordinator
        # scheduled for handoff; a handoff skip reason is already combined into the plan entry).
        handoff_target = coordinator["address"] if do_handoff and coordinator else None
        for entry in skip:
            if entry["terminal"] == handoff_target:
                continue
            log_skip(entry["terminal"], entry["reason"])

        if launch:
            start_step("launch")
        for item in launch:
            remaining_seconds(deadline)
            addr = item["terminal"]
            orig_terminal = launch_sources[addr]
            orig_tab = (orig_terminal.get("labels") or {}).get("herdr.tab") or ""
            orig_fg = _foreground_identity(orig_terminal)
            # Build command/prompt and read the pane record from disk before the final cheap `hc get`.
            # After `hc get`, validation stays strictly in memory (no disk read) and `hc send` follows directly.
            try:
                cmd_line = build_shell_launch(orig_terminal, item, cfg, seen_terminals, deadline)
            except (_ValidationError, OSError) as exc:
                fail_run(f"could not build launch for {addr}: {exc}", done)
            raw_record = _read_raw_record(addr)
            state, fresh = bounded_core_get(addr, deadline)
            if state == "error":
                fail_run(f"could not read terminal {addr}: {str(fresh)[:200]}", done)
            skip_reason = validate_launch_reread(state, fresh, space, orig_tab, orig_fg, item["role"], raw_record)
            if skip_reason is not None:
                log_skip(addr, skip_reason)
                continue
            outcome, detail = run_hc_send(addr, cmd_line, if_idle=False, deadline=deadline)
            if outcome != "ok":
                fail_run(detail, done)
            done += 1
            if item.get("harness") == "agy":
                _agy_pending.append({"terminal": addr, "name": item["name"], "program": item["program"]})
            else:
                emit({"version": VERSION, "action": "launch", "terminal": addr, "ok": True})
        end_step("launch")

        if do_handoff:
            remaining_seconds(deadline)
            coord_addr = coordinator["address"]
            # Finish command build, transcript lookup, token count, and pane record read before the final
            # cheap `hc get`. Validation after `hc get` stays strictly in memory and `hc send` follows directly.
            cmd = handoff_cmd
            with timed("context"):
                fresh_transcript, fresh_tokens = coordinator_context(coordinator, deadline)
            skip_reason = validate_coordinator_transcript(coord_transcript, fresh_transcript, fresh_tokens)
            if skip_reason is not None:
                log_skip(coord_addr, skip_reason)
            else:
                coord_raw_record = _read_raw_record(coord_addr)
                with timed("get"):
                    state, fresh = bounded_core_get(coord_addr, deadline)
                if state == "error":
                    fail_run(f"could not read coordinator terminal {coord_addr}: {str(fresh)[:200]}", done)
                skip_reason = validate_coordinator_reread(state, fresh, space, coord_identity, coord_raw_record)
                if skip_reason is not None:
                    log_skip(coord_addr, skip_reason)
                else:
                    coord_state = (fresh.get("status") or {}).get("state") if isinstance(fresh, dict) else None
                    if isinstance(coord_state, str):
                        _times["coordinator_status"] = coord_state
                    at_prompt, status_state = coordinator_prompt_state(fresh)
                    if not at_prompt:
                        fail_run(f"handoff not delivered: coordinator terminal {coord_addr} {status_state}", done)
                    # Best-effort delivery: `--if idle` for idle, no condition for done or for working with only
                    # background work, never `--force` (hc send still refuses a blocked terminal).
                    # The send runs in a background terminal of herdr-core: herdr-core can hold it up to 60 s while
                    # the terminal has a typed draft, and the app waits for this run. The child writes the outcome to
                    # `result`. When that terminal does not start, the send runs here, synchronously.
                    with timed("send"):
                        result = start_handoff_send(coord_addr, cmd, if_idle=(status_state == "idle"))
                    if result is not None:
                        _times["send_detached"] = True
                        done += 1
                        emit({"version": VERSION, "action": "handoff", "terminal": coord_addr, "ok": True,
                              "pending": True, "result": result})
                    else:
                        _times["send_fallback"] = True
                        send_result = _times["send_result"] = {}
                        with timed("send"):
                            outcome, detail = run_hc_send(coord_addr, cmd, if_idle=(status_state == "idle"),
                                                          deadline=deadline, reply=send_result)
                        if outcome == "not_delivered":
                            fail_run(f"handoff not delivered: {detail}; press Start again", done)
                        if outcome != "ok":
                            fail_run(f"{detail}; look at coordinator terminal {coord_addr} before you press Start "
                                     "again", done)
                        done += 1
                        emit({"version": VERSION, "action": "handoff", "terminal": coord_addr, "ok": True})

        if notice and "skip" in notice:
            log_skip(coordinator["address"], notice["skip"])
        elif notice:
            with timed("notice"):
                send_role_models_notice(coordinator["address"], notice, space, coord_identity, deadline, done)

        send_agy_role_prompts(deadline)
        remaining_seconds(deadline)
        emit(with_times({"version": VERSION, "ok": True, "done": done}))
    except _DeadlineExceeded:
        fail_run("run time limit exceeded", done)
    except (_ActionError, _ValidationError) as exc:
        fail_run(str(exc), done)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        fail_run(f"internal error: {type(exc).__name__}", done)


if __name__ == "__main__":
    main()
