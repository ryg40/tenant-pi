#!/usr/bin/env python3
"""Hand the work of this coordinator pane to a new coordinator, then close this pane.

Usage: handoff.py --file <handoff.md> [--harness claude|pi] [--model NAME] [--thinking LEVEL]
                  [--timeout SECONDS]

1. Checks: inside Herdr, this pane is a coordinator (a record of init.py or spawn.py), and the
   handoff file exists and is not empty. A failed check starts nothing.
2. Appends the open task panes of the workspace to the handoff file. A rerun replaces that section.
3. Starts the new coordinator with spawn.py --role coordinator (model and thinking: the request,
   else models.json, as spawn.py resolves them). The harness defaults to the harness of this pane.
4. Sends the start prompt with ask.py and waits up to --timeout seconds (default 900).
5. Success: ask.py exit 0 and a reply line that starts with the marker of contract.json. Then it
   appends the record to handoffs.jsonl beside the handoff file (status "recorded"), sends the second
   prompt with ask.py --timeout 45, prints the result line, and closes this pane by its ID as the last
   step. The second send succeeds on ask.py exit 124 (the turn still works) or exit 0 with a new reply
   that is no API error. A hung or missing ask.py is a failure.
   Any failure closes nothing and leaves both panes open. A failed second send appends a line with
   status "failed" and the cause.

Exit codes: see the `handoff` entry of contract.json.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _common import (CONTRACT, ROLES, agent_info, error_code, exit_codes, herdr, live_agents,  # noqa: E402
                     read_record, remove_record, tabs, write_record)

EXIT = exit_codes("handoff")
SPAWN_EXIT = exit_codes("spawn")
MARKER = CONTRACT["handoff"]["accepted_marker"]
ASK_EXIT = exit_codes("ask")
NO_REPLY_LINES = (CONTRACT["ask"]["no_new_reply_line"], CONTRACT["ask"]["no_transcript_line"])
API_ERROR_NOTE = CONTRACT["ask"]["api_error_note"]
REPLY_LINE = "--- reply ---\n"
HARNESSES = ("claude", "pi")
# The second prompt only has to start a turn: ask.py waits this long, then exit 124 means the turn still works.
SEND_SECONDS = 45
# ask.py ends by itself at --timeout; this extra time only guards against a hung ask.py.
ASK_GRACE = 300
SECTION = "## Open panes at the handoff"


def fail(msg, code):
    print(f"handoff failed: {msg}")
    sys.exit(code)


def parse(argv):
    opts = {"file": None, "harness": None, "model": None, "thinking": None, "timeout": "900"}
    i = 0
    while i < len(argv):
        key = argv[i][2:].replace("-", "_") if argv[i].startswith("--") else None
        if key not in opts or i + 1 >= len(argv):
            fail(f"bad argument '{argv[i]}'. {__doc__.splitlines()[2].strip()}", EXIT["usage"])
        opts[key] = argv[i + 1]
        i += 2
    if not opts["file"]:
        fail("--file is required", EXIT["usage"])
    if opts["harness"] and opts["harness"] not in HARNESSES:
        fail(f"--harness must be one of {', '.join(HARNESSES)}", EXIT["usage"])
    try:
        opts["timeout"] = int(opts["timeout"])
    except ValueError:
        opts["timeout"] = 0
    if opts["timeout"] <= 0:
        fail("--timeout must be a positive number of seconds", EXIT["usage"])
    return opts


def check_caller():
    """Return (pane id, workspace id, harness) of the calling coordinator pane. Exit with usage otherwise."""
    if os.environ.get("HERDR_ENV") != "1":
        fail("not inside a Herdr pane (HERDR_ENV is not 1)", EXIT["usage"])
    me = os.environ.get("HERDR_PANE_ID")
    record = read_record(me) if me else None
    if not record or record.get("pane_id") != me or record.get("role") != "coordinator":
        fail(f"pane {me} is not a coordinator: no coordinator record of init.py or spawn.py. Run init.py first.",
             EXIT["usage"])
    info = agent_info(me) or {}
    harness = info.get("agent") or record.get("harness")
    harness = "pi" if harness == "pi-bolt" else harness
    return me, record.get("workspace_id"), harness


def check_file(path):
    path = os.path.realpath(path)
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as exc:
        fail(f"cannot read the handoff file {path}: {exc.strerror}", EXIT["usage"])
    if not text.strip():
        fail(f"the handoff file {path} is empty", EXIT["usage"])
    return path, text


def open_panes(workspace_id, me):
    """One line for each open pane of the workspace that hosts an agent and is no coordinator.

    The source is the one of panes.py: `herdr pane list` and the names of `herdr agent list`.
    """
    code, data, raw = herdr("pane", "list", "--workspace", workspace_id)
    if code != 0 or not data or error_code(data):
        fail(f"pane list failed: {raw[:200]}", EXIT["usage"])
    names = {a["pane_id"]: a.get("name") or "-" for a in live_agents()}
    tab_labels = {t["tab_id"]: t.get("label") for t in tabs(workspace_id)}
    lines = []
    for p in data["result"]["panes"]:
        pid = p["pane_id"]
        record = read_record(pid) or {}
        role = record.get("role") or (tab_labels.get(p.get("tab_id")) if tab_labels.get(p.get("tab_id")) in ROLES else None)
        if pid == me or role == "coordinator" or not (p.get("agent") or record):
            continue
        lines.append(f"- `{pid}` {names.get(pid, '-')}, role {role or '-'}, status {p.get('agent_status') or '-'}, "
                     f"cwd `{p.get('cwd') or '-'}`")
    return lines


def cut_section(text):
    """The text without an earlier section SECTION, up to the next `# ` or `## ` heading or the end."""
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if line.rstrip() == SECTION), None)
    if start is None:
        return text
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith(("# ", "## "))), len(lines))
    return "".join(lines[:start] + lines[end:])


def append_panes(path, text, lines):
    body = "\n".join(lines) if lines else "- none"
    section = (f"\n{SECTION}\n\n{body}\n\nCollect their replies with `ask.py <pane-id> --wait-only` or "
               "`last-reply.py <pane-id>`; do not send them a second task.\n")
    kept = cut_section(text).rstrip("\n") + "\n"
    path = os.path.realpath(path)  # a symlinked handoff file stays a link; its target gets the text
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".handoff-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(kept + section)
        os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        os.replace(tmp, path)
    except OSError as exc:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        fail(f"cannot append the open panes to {path}: {exc.strerror}", EXIT["usage"])


def spawn(opts, harness):
    cmd = [sys.executable, os.path.join(HERE, "spawn.py"), "--harness", harness, "--role", "coordinator",
           "--cwd", os.getcwd()]
    for key in ("model", "thinking"):
        if opts[key]:
            cmd += [f"--{key}", opts[key]]
    p = subprocess.run(cmd, capture_output=True, text=True)
    sys.stderr.write(p.stderr)
    out = {}
    for line in reversed(p.stdout.splitlines()):
        try:
            out = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    pane, name = out.get("pane_id"), out.get("name")
    if p.returncode == SPAWN_EXIT["startup_question"]:
        fail(f"spawn.py exit 4, the new coordinator stopped at a startup question; new pane {pane} {name}. "
             "Both panes stay open.", EXIT["startup_question"])
    if p.returncode != 0:
        err = (p.stderr.strip().splitlines() or ["no output"])[-1]
        fail(f"spawn.py exit {p.returncode}: {err[:200]}; no new pane", EXIT["spawn_failed"])
    if not pane:
        fail("spawn.py exit 0, but its output has no pane ID; read `panes.py`", EXIT["spawn_failed"])
    return pane, name


def start_prompt(path, me):
    return (f"Read the handoff file {path}. You take over the coordinator work from pane {me} and the open "
            f"panes that the file lists. Reply with one line that starts with {MARKER} and names your first next "
            "step. Then end the turn and wait for the second prompt; do not start the work yet.")


def accepted(stdout):
    """True when the reply part of the ask.py output has a line that starts with the marker."""
    _, sep, reply = stdout.partition(REPLY_LINE)
    return bool(sep) and any(line.strip().startswith(MARKER) for line in reply.splitlines())


def ask(pane, prompt, timeout, grace=ASK_GRACE):
    """Return (exit code, stdout) of ask.py, or (None, cause) when ask.py did not end or did not start."""
    cmd = [sys.executable, os.path.join(HERE, "ask.py"), pane, "--text", prompt, "--timeout", str(timeout)]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + grace)
    except subprocess.TimeoutExpired:
        return None, f"ask.py did not end within {timeout + grace} seconds"
    except OSError as exc:
        return None, f"ask.py did not start: {exc.strerror}"
    return p.returncode, p.stdout


def record_handoff(path, me, pane, name, status, cause=None):
    """Append one line to handoffs.jsonl beside the handoff file. Status: recorded, or failed with a cause."""
    record_file = os.path.join(os.path.dirname(path), "handoffs.jsonl")
    entry = {"time": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "old_pane_id": me, "new_pane_id": pane, "new_name": name, "handoff_file": path, "status": status}
    if cause:
        entry["cause"] = cause
    with open(record_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    return record_file


def second_prompt(path, record_file, me):
    return (f"The handoff is recorded in {record_file}. The previous coordinator pane {me} closes now. "
            f"Continue the work of the handoff file {path}.")


def send_second(pane, prompt):
    """Send the prompt with ask.py. Return (True, "") when the new coordinator works on it.

    Success: exit 124 (delivered, the turn still works after SEND_SECONDS) or exit 0 with a new reply.
    A blocked pane (4), a busy pane (3), no turn (5), an API error (6 or the note of exit 0), a hung or
    missing ask.py and every other result are failures. The markers count only before the reply line.
    """
    code, out = ask(pane, prompt, SEND_SECONDS)
    if code is None:
        return False, out
    if code == ASK_EXIT["timeout"]:
        return True, ""
    if code == ASK_EXIT["reply"]:
        head = out.partition(REPLY_LINE)[0]
        if any(line in head for line in NO_REPLY_LINES):
            return False, "ask.py exit 0 without a new reply"
        if API_ERROR_NOTE in head:
            return False, "ask.py exit 0, the reply is an API error"
        return True, ""
    if code == ASK_EXIT["blocked"]:
        return False, "ask.py exit 4, the new coordinator waits on a question or an approval"
    return False, f"ask.py exit {code}"


def main():
    opts = parse(sys.argv[1:])
    me, workspace, own_harness = check_caller()
    path, text = check_file(opts["file"])
    harness = opts["harness"] or own_harness
    if harness not in HARNESSES:
        fail(f"cannot tell the harness of pane {me} ({harness}); give --harness claude or --harness pi", EXIT["usage"])

    append_panes(path, text, open_panes(workspace, me))
    pane, name = spawn(opts, harness)
    new = f"new pane {pane} {name}; both panes stay open"

    code, out = ask(pane, start_prompt(path, me), opts["timeout"])
    if code is None:
        fail(f"{out}; {new}. Read it with `ask.py {pane} --wait-only` or `last-reply.py {pane}`.",
             EXIT["not_accepted"])
    if code != 0:
        fail(f"ask.py exit {code}; {new}. Read it with `ask.py {pane} --wait-only` or `last-reply.py {pane}`.",
             EXIT["not_accepted"])
    if not accepted(out):
        fail(f"the reply has no line that starts with {MARKER}; {new}. Read it with `last-reply.py {pane}`.",
             EXIT["not_accepted"])
    try:
        record_file = record_handoff(path, me, pane, name, "recorded")
    except OSError as exc:
        fail(f"cannot write handoffs.jsonl beside {path}: {exc.strerror}; {new}", EXIT["record_failed"])
    ok, why = send_second(pane, second_prompt(path, record_file, me))
    if not ok:
        try:
            record_handoff(path, me, pane, name, "failed", f"second prompt: {why}")
        except OSError:
            pass  # exit 7 stays; the line below names the cause
        fail(f"the second prompt failed ({why}); {new}. Read the new pane with `last-reply.py {pane}`.",
             EXIT["send_failed"])

    print(f"handoff done: old pane {me}, new pane {pane} {name}, record {record_file}. Closing {me}.", flush=True)
    own = read_record(me)
    remove_record(me)  # as close.py does: a later pane with this ID is no coordinator
    # The last step: this is the pane of the caller, so the close ends this command.
    code, data, raw = herdr("pane", "close", me)
    if code != 0 or error_code(data):
        if own:
            write_record(me, own)
        fail(f"herdr pane close {me}: {raw[:200]}; the handoff to {pane} {name} is done", EXIT["close_failed"])


if __name__ == "__main__":
    main()
