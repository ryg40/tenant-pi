#!/usr/bin/env python3
"""Send one prompt to an agent that already runs in a Herdr pane, wait until the
agent settles, then print its complete reply. One blocking call.

Usage: ask.py <pane-id-or-agent-name> (--file <prompt-file> | --text "<prompt>")
              [--timeout SECONDS] [--max-chars N]
       ask.py <pane-id-or-agent-name> --wait-only [--timeout SECONDS] [--max-chars N]

--wait-only sends no prompt: it waits until the pane settles and prints the last reply.

On herdr-core (a pane of the Herdr app) the target is a local, live terminal (a name or an address such as t13).
The prompt goes out one time with `hc send --wait`; a message to the caller ends that wait early, and
ask.py then waits with `hc wait`, never with a second send.

Exit codes: 0 reply printed | 2 usage or bad target | 3 target is working, nothing sent
            4 target is blocked on a question or approval | 5 no turn started
            6 the reply is an API error and the transcript holds no other reply
            124 timed out while the target still works (prompt was delivered; do not resend)

When the reply is an API error line, the last assistant message written after the
prompt that is not such a line is printed in its place, with a one-line note. Exit
code 0. When only an older message exists, the note ends with "; from before this prompt".
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (AGY_NOTE, CONTRACT, DISK_NOTE, PI_AGENTS, agent_info, agy_texts, assistant_texts,  # noqa: E402
                     claude_core_session, clip, find_agy_transcript, core_error_kind, core_get, core_info, core_screen, ensure_layout, error_code, exit_codes,
                     find_pi_session, hc, herdr, herdr_app_pane, line_count, pi_disk_session, pi_turn_done,
                     read_record, require_backend, require_herdr_env, save_pi_session, saved_pi_session, screen_tail,
                     session_file)

EXIT = exit_codes("ask")
NO_NEW_REPLY_LINE = CONTRACT["ask"]["no_new_reply_line"]
NO_TRANSCRIPT_LINE = CONTRACT["ask"]["no_transcript_line"]
API_ERROR_NOTE = CONTRACT["ask"]["api_error_note"]
NO_BLOCK_NOTE = CONTRACT["ask"]["no_block_note"]
# After agent_prompt_stalled, a turn can still start late, for example on the first turn of a new pane.
STALL_SECONDS = 60
PI_FILE_SECONDS = 20  # herdr-core: how long ask.py searches for the Pi session file after the turn
PI_FILE_POLL = 2
# A Pi session file on disk (no Herdr status): the turn ends when the final reply is last and the file
# has not changed for this long.
QUIET_SECONDS = 5


def parse(argv):
    opts = {"timeout": 600, "max_chars": 8000, "text": None, "file": None, "wait_only": False}
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--wait-only":
            opts["wait_only"] = True
            i += 1
        elif a in ("--timeout", "--max-chars", "--text", "--file"):
            if i + 1 >= len(argv):
                sys.exit(__doc__)
            opts[a[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        else:
            pos.append(a)
            i += 1
    prompts = bool(opts["text"]) + bool(opts["file"])
    if len(pos) != 1 or prompts != (0 if opts["wait_only"] else 1):
        sys.exit(__doc__)
    opts["timeout"] = int(opts["timeout"])
    opts["max_chars"] = int(opts["max_chars"])
    return pos[0], opts


API_ERROR_STARTS = ("API Error:", "Please run /login")


def is_api_error(text):
    """True when the text is the error line that the harness writes in place of a reply."""
    return text.lstrip().startswith(API_ERROR_STARTS)


def transcript_fallback(path, offset):
    """Return (text, older) for the last assistant message that is no API error line, or None.

    A message written after the prompt (transcript line `offset` and later) comes first.
    `older` is True when only a message from before the prompt exists.
    """
    new = assistant_texts(path, offset)
    for text in reversed(new):
        if not is_api_error(text):
            return text, False
    everything = assistant_texts(path)
    for text in reversed(everything[:len(everything) - len(new)]):
        if not is_api_error(text):
            return text, True
    return None


def compacted(path, start_line=0):
    """True when the transcript has a compaction after line `start_line` (0-based).

    Pi writes an entry of type `compaction`. Claude Code writes a `system` entry of subtype `compact_boundary`.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n < start_line or "compact" not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") == "compaction" or (d.get("type") == "system" and d.get("subtype") == "compact_boundary"):
                    return True
    except OSError:
        pass
    return False


def turn_started(target, info, path, offset):
    """True when the pane works or waits on a question, or its transcript has lines after the prompt."""
    now = agent_info(target) or info
    if now.get("agent_status") in ("working", "blocked"):
        return True
    new_path = session_file(now) or path
    return bool(new_path) and line_count(new_path) > (offset if new_path == path else 0)


def wait_for_turn(target, info, path, offset, deadline, find=None):
    """After a stall, poll up to STALL_SECONDS, inside the deadline, for a turn that starts late. Never resend.

    Return (started, disk). `find()` looks for the Pi session file on disk that holds the prompt; when it
    finds one, disk is its (path, start line). Herdr gives a Pi-Bolt pane no status, so only the file shows the turn.
    """
    end = min(deadline, time.time() + STALL_SECONDS)
    while True:
        if turn_started(target, info, path, offset):
            return True, None
        disk = find() if find else None
        if disk:
            return True, disk
        if time.time() >= end:
            return False, None
        time.sleep(2)


def follow_pi_file(path, start, deadline, current):
    """Follow a Pi session file until its turn ends. Return (state, reply).

    The turn works while the last entry after line `start` is no final reply (pi_turn_done) or the file grows.
    State "done" gives the final reply. Before it accepts the end, and at the deadline, `current()` checks that
    the file is still the session of the pane: else state "gone". State "working" means the deadline passed.
    """
    seen, since = None, time.time()
    while True:
        try:
            st = os.stat(path)
            sig = (st.st_size, st.st_mtime_ns)
        except OSError:
            sig = None
        reply = ""
        if sig != seen:
            seen, since = sig, time.time()
        elif time.time() - since >= QUIET_SECONDS:
            reply = pi_turn_done(path, start)
        if reply or time.time() >= deadline:
            if not current():
                return "gone", None
            return ("done", reply) if reply else ("working", None)
        time.sleep(1)


def settle(target, info, path, offset, deadline, locate=None):
    """Wait until the pane settles or the deadline passes. Return (agent info, transcript, start line, new texts).

    `locate(info)` finds the transcript on disk when Herdr gives no path; it returns (path, start line) or None.
    Pi auto-compaction sets done in the middle of a turn. A done or idle status with no new assistant text
    is not the end of the turn when the transcript shows a compaction after the prompt: wait again.
    """
    while True:
        now = agent_info(target) or info
        if now.get("agent_status") == "working" and time.time() < deadline:
            remaining = max(1, int(deadline - time.time()))
            herdr("agent", "wait", info["pane_id"], "--timeout", str(remaining * 1000), timeout=remaining + 30)
            continue
        time.sleep(1)  # let the transcript flush
        now = agent_info(target) or now
        status = now.get("agent_status")
        new_path = session_file(now) or path
        start = offset if new_path == path else 0
        if not new_path and locate:
            new_path, start = locate(now) or (None, 0)
        texts = assistant_texts(new_path, start) if new_path else []
        compacting = status in ("done", "idle") and not texts and bool(new_path) and compacted(new_path, start)
        if time.time() < deadline and (status == "working" or compacting):
            continue
        return now, new_path, start, texts


def clip_line(text, max_chars=200):
    line = text.strip().splitlines()[0]
    return line if len(line) <= max_chars else line[:max_chars] + "..."


def report(info, elapsed, note):
    print(f"pane={info['pane_id']} agent={info.get('agent')} status={info.get('agent_status')} "
          f"cwd={info.get('cwd')} elapsed={int(elapsed)}s {note}".rstrip())


def print_reply(pane_id, reply, max_chars):
    print("--- reply ---")
    print(clip(reply, max_chars, head=max_chars // 4))
    record = read_record(pane_id) or {}
    if record.get("session") == "subagent" and not any(
            line.startswith("Marker: SUBAGENT_COMPLETE") for line in reply.splitlines()):
        print(NO_BLOCK_NOTE)


def read_prompt(opts):
    if opts["file"]:
        try:
            prompt = open(opts["file"], encoding="utf-8").read().strip()
        except OSError as exc:
            sys.exit(f"error: cannot read prompt file: {exc}")
    else:
        prompt = opts["text"].strip()
    if not prompt:
        sys.exit("error: the prompt is empty")
    return prompt


def send(target, info, prompt, timeout, start):
    """Send the prompt one time. Return the error code of Herdr, or None. Exit when the prompt was not sent."""
    code, data, raw = herdr("agent", "prompt", info["pane_id"], prompt, "--wait",
                            "--timeout", str(timeout * 1000), timeout=timeout + 30)
    err = error_code(data) or (None if code == 0 else "error")
    if err == "agent_blocked":
        report(agent_info(target) or info, time.time() - start, "")
        print("NOT SENT: the target became blocked. Show the screen to the user.")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(EXIT["blocked"])
    if err and err not in ("timeout", "agent_prompt_stalled"):
        print(f"error: herdr agent prompt failed: {raw[:500]}", file=sys.stderr)
        sys.exit(EXIT["usage"])
    return err


# ---------------------------------------------------------------------------
# herdr-core (a pane of the Herdr app). The target is a LOCAL, LIVE terminal, and the prompt goes out ONE time.
# ---------------------------------------------------------------------------
def core_target(found, target, exit_code):
    """(caller address, terminal, info) for a target on herdr-core. Exit with `exit_code` for a bad target."""
    me = herdr_app_pane(found)
    if not me:
        print(f"error: the herdr-core terminal {found['terminal']} is no local pane of the Herdr app "
              "(no herdr.space or herdr.tab label). Nothing was sent.", file=sys.stderr)
        sys.exit(exit_code)
    mine = me.get("address") or found["terminal"]
    state, terminal = core_get(target)
    why = {"not_found": "no terminal has this name or address",
           "remote": "it is a terminal of another machine; the skill acts only on local terminals",
           "error": f"hc get failed: {str(terminal)[:300]}"}.get(state)
    if not why and terminal.get("state") != "live":
        why = f"the terminal is not live (state {terminal.get('state')})"
    info = core_info(terminal) if not why else {}
    if not why and not info.get("agent"):
        why = "the terminal hosts no agent (no status app and no spawn.py record with a harness)"
    if not why and info["pane_id"] == mine:
        why = "the target is your own terminal"
    if why:
        print(f"error: '{target}': {why}. Nothing was sent. Run panes.py to list panes.", file=sys.stderr)
        sys.exit(exit_code)
    return mine, terminal, info


def core_now(address, info):
    """The fresh info of the terminal, or None when it ended (not found or not live)."""
    state, terminal = core_get(address)
    if state == "not_found" or (state == "ok" and terminal.get("state") != "live"):
        return None
    return dict(core_info(terminal), pid=info.get("pid")) if state == "ok" else info


def core_gone(info, elapsed):
    report(dict(info, agent_status="ended"), elapsed, "")
    print(f"ENDED: the terminal {info['pane_id']} ended before the turn was done. Read its last screen with "
          f"`hc read {info['pane_id']}` and tell the user.", file=sys.stderr)
    sys.exit(EXIT["error"])


def core_timeout(info, elapsed):
    report(info, elapsed, "")
    print("TIMED OUT: the prompt was delivered and the target still works. Do not send the prompt again.")
    print(f"Wait more with `ask.py {info['pane_id']} --wait-only`, then run last-reply.py {info['pane_id']}.")
    sys.exit(EXIT["timeout"])


def core_blocked(info, elapsed, sent):
    report(dict(info, agent_status="blocked"), elapsed, "")
    if sent:
        print("BLOCKED: the target stopped on a question or an approval. Show this to the user; do not answer it yourself.")
    else:
        print("NOT SENT: the target waits on a question or an approval. Show this to the user; do not answer it yourself.")
    print("--- screen tail ---")
    print(clip(core_screen(info["pane_id"], 40), 3000))
    sys.exit(EXIT["blocked"])


def core_send(info, prompt, deadline, start):
    """Send the prompt ONE time with `hc send --wait`. Return (wait object, turn before the send).

    Exit when nothing was typed (3 or 4), when the delivery is not known (2), or when no turn started (5).
    """
    address = info["pane_id"]
    remaining = max(1, int(deadline - time.time()))
    args = ["send", "--json", "--wait", "--timeout", str(remaining)]
    if info.get("agent_status") == "idle":
        args += ["--if", "idle"]  # `--if` takes only idle or working; a done terminal has no such guard
    code, data, raw = hc(*args, "--", address, prompt, timeout=remaining + 30)
    kind = core_error_kind(data)
    if kind == "status_mismatch" or (kind and "block" in kind):
        now = core_now(address, info) or info
        if now.get("agent_status") == "blocked" or "block" in kind:
            core_blocked(now, time.time() - start, sent=False)
        report(now, time.time() - start, "")
        print("NOT SENT: the status of the target changed before the send; nothing was typed. Wait with "
              f"`ask.py {address} --wait-only`, then send the prompt again, or ask the user.")
        sys.exit(EXIT["busy"])
    if code != 0 or not isinstance(data, dict) or kind:
        print(f"error: hc send failed (exit {code}): {raw[:500]}. The delivery is not known: read the screen "
              f"with `hc read {address}` before you send anything again.", file=sys.stderr)
        sys.exit(EXIT["usage"])
    if not data.get("started"):
        core_no_turn(info, time.time() - start, "hc send started no turn")
    return data.get("wait") or {}, data.get("turn")


def core_no_turn(info, elapsed, why):
    report(info, elapsed, "")
    print(f"NO TURN STARTED: {why}. The prompt is not sent again. Read the screen before any other input.")
    print("--- screen tail ---")
    print(clip(core_screen(info["pane_id"], 60), 4000))
    sys.exit(EXIT["no_turn"])


def core_follow(info, wait, deadline):
    """Wait until the turn ends; never send. Return (outcome, wait object).

    outcome: "ended", "timeout" (the deadline passed and the target still works), "blocked" or "gone".
    `wait` is the wait object of `hc send --wait`, or None for a new `hc wait`. A message to the caller ends a
    wait early: one line on stderr names its sender, then the wait goes on.
    """
    address = info["pane_id"]
    while True:
        if wait is None:
            remaining = int(deadline - time.time())
            if remaining < 1:
                now = core_now(address, info)
                if now is None:
                    return "gone", {}
                state = now.get("agent_status")
                return ("blocked" if state == "blocked" else "timeout" if state == "working" else "ended"), {}
            code, data, raw = hc("wait", address, "--timeout", str(remaining), "--json", timeout=remaining + 30)
            if core_error_kind(data) == "not_found":
                return "gone", {}
            wait = data if code == 0 and isinstance(data, dict) and not core_error_kind(data) else {}
        reason, status = wait.get("reason"), wait.get("status")
        if status == "blocked":
            return "blocked", wait
        if reason == "message":
            print(f"note: a message from {wait.get('from')} ended the wait early; waiting again. "
                  "The prompt is not sent again.", file=sys.stderr)
            wait = None
            continue
        if reason == "status" and wait.get("ended") and status != "working":
            return "ended", wait
        if reason == "timeout" and time.time() < deadline - 1:
            wait = None
            continue
        # A timeout at the deadline, an exit, or an answer that is not known: the state of the terminal decides.
        now = core_now(address, info)
        if now is None:
            return "gone", wait
        state = now.get("agent_status")
        if state == "blocked":
            return "blocked", wait
        if state == "working":
            if time.time() >= deadline - 1:
                return "timeout", wait
            time.sleep(1)
            wait = None
            continue
        return "ended", wait


def core_transcript(info, prompt, start, path, offset, deadline):
    """(path, start line, from disk) of the transcript of the turn, or (None, 0, False).

    Claude Code: the session that the sessions file of the SAME pid names now; a new session (/clear, a resume)
    is read from line 0. Pi: with a prompt, the one session file on disk that holds it after the send, searched
    every PI_FILE_POLL seconds for up to PI_FILE_SECONDS, inside the deadline, while no file matches;
    without a prompt, the file that an earlier prompt saved in the record. agy: with a prompt, the one agy
    transcript that holds it after the send, searched in the same way; without a prompt, none.
    """
    if info.get("agent") == "claude":
        sid = claude_core_session(info.get("pid"))
        new_path = session_file({"agent_session": {"kind": "id", "value": sid}}) if sid else None
        if not new_path:
            return None, 0, False
        return new_path, (offset if new_path == path else 0), False
    if info.get("agent") == "agy":
        if prompt is None:
            return None, 0, False
        end = min(deadline, time.time() + PI_FILE_SECONDS)
        hit = find_agy_transcript(start, prompt)
        while not hit and time.time() + PI_FILE_POLL <= end:
            time.sleep(PI_FILE_POLL)
            hit = find_agy_transcript(start, prompt)
        return (hit[0], hit[1], True) if hit else (None, 0, False)
    if info.get("agent") in PI_AGENTS:
        if prompt is None:
            saved = saved_pi_session(info)
            return (saved, 0, True) if saved else (None, 0, False)
        cwds = [c for c in (info.get("cwd"), info.get("foreground_cwd")) if c]
        end = min(deadline, time.time() + PI_FILE_SECONDS)
        hit = find_pi_session(cwds, start, prompt)
        while not hit and time.time() + PI_FILE_POLL <= end:
            time.sleep(PI_FILE_POLL)  # the file can reach the disk after the core shows the end of the turn
            hit = find_pi_session(cwds, start, prompt)
        if hit:
            save_pi_session(info, hit[0])  # a later run without a prompt reads this file
            return hit[0], hit[1], True
    return None, 0, False


def ask_core(found, target, opts):
    prompt = None if opts["wait_only"] else read_prompt(opts)
    mine, terminal, info = core_target(found, target, EXIT["usage"])
    address = info["pane_id"]
    status = info.get("agent_status")
    if prompt is not None and status == "working":
        report(info, 0, "")
        print(f"NOT SENT: the target works on another turn. Wait with `ask.py {address} --wait-only`, "
              "or ask the user before you interrupt it.")
        sys.exit(EXIT["busy"])
    if prompt is not None and status == "blocked":
        core_blocked(info, 0, sent=False)

    path = session_file(info)  # Claude Code: the transcript before the send; Pi has no path before it
    offset = line_count(path) if path and prompt is not None else 0
    start = time.time()
    deadline = start + opts["timeout"]
    turn0 = terminal.get("turn")
    if prompt is not None:
        wait, sent_turn = core_send(info, prompt, deadline, start)
        turn0 = sent_turn if isinstance(sent_turn, int) else turn0
    else:
        if status == "blocked":
            core_blocked(info, 0, sent=True)
        # A wait-only run waits only for a turn that works now.
        wait = None if status == "working" else {"reason": "status", "ended": True, "status": status}

    while True:
        outcome, wait = core_follow(info, wait, deadline)
        now = core_now(address, info)
        if outcome == "gone" or now is None:
            core_gone(info, time.time() - start)
        if outcome == "blocked":
            core_blocked(now, time.time() - start, sent=True)
        if outcome == "timeout":
            core_timeout(now, time.time() - start)
        time.sleep(1)  # let the transcript flush
        new_path, new_offset, from_disk = core_transcript(now, prompt, start, path, offset, deadline)
        read = agy_texts if now.get("agent") == "agy" else assistant_texts
        texts = read(new_path, new_offset) if new_path else []
        if texts is None:  # the agy reader failed: NO TRANSCRIPT PATH and the screen, never a second send
            new_path, texts = None, []
        if prompt is not None and not texts:
            moved = any(isinstance(t, int) and isinstance(turn0, int) and t > turn0
                        for t in ((wait or {}).get("turn"), now.get("turn")))
            grew = bool(new_path) and (new_path != path or line_count(new_path) > offset)
            if not moved and not grew:
                # No status change and no new transcript line: a turn can still start late. Never resend.
                end = min(deadline, time.time() + STALL_SECONDS)
                last = now  # the last known status decides at the deadline
                while time.time() < end:
                    later = core_now(address, info)
                    last = later or last
                    if later is None or later.get("agent_status") in ("working", "blocked"):
                        break
                    if isinstance(later.get("turn"), int) and isinstance(turn0, int) and later["turn"] > turn0:
                        break
                    time.sleep(2)
                else:
                    core_no_turn(now, time.time() - start, f"no status change and no new transcript line after "
                                                           f"{STALL_SECONDS} seconds")
                wait = None
                if time.time() < deadline:
                    continue
                if last.get("agent_status") == "working":
                    core_timeout(last, time.time() - start)
        if (not texts and new_path and now.get("agent_status") in ("done", "idle")
                and compacted(new_path, new_offset) and time.time() < deadline):
            time.sleep(2)  # a compaction set done in the middle of the turn: wait again
            wait = None
            continue
        break
    elapsed = time.time() - start

    if not texts:
        report(now, elapsed, "")
        if not new_path:
            print(f"{NO_TRANSCRIPT_LINE} (on herdr-core: no Claude Code sessions file for the process of the "
                  "terminal, or no single Pi session file or agy transcript that holds the prompt). "
                  "The screen tail follows.")
        else:
            print(f"{NO_NEW_REPLY_LINE}. The screen tail follows.")
        print("--- screen tail ---")
        print(clip(core_screen(address, 60), 4000))
        sys.exit(EXIT["reply"])

    report(now, elapsed, f"transcript={new_path}")
    if from_disk:
        print(f"{AGY_NOTE if now.get('agent') == 'agy' else DISK_NOTE}{new_path}")
    reply = texts[-1]
    if is_api_error(reply):
        fallback = transcript_fallback(new_path, new_offset)
        if fallback is None:
            print("API ERROR: the reply is an API error and the transcript holds no other reply. "
                  "Read the commit of the agent, or send the prompt again in a new pane.")
            print_reply(address, reply, opts["max_chars"])
            sys.exit(EXIT["api_error"])
        print(f"{API_ERROR_NOTE} ({clip_line(reply)}); "
              "text below is the last assistant message of the transcript"
              + ("; from before this prompt" if fallback[1] else ""))
        reply = fallback[0]
    print_reply(address, reply, opts["max_chars"])


def main():
    found = require_backend("ask", core=True)
    if found["backend"] == "core":
        target, opts = parse(sys.argv[1:])
        return ask_core(found, target, opts)
    require_herdr_env()
    target, opts = parse(sys.argv[1:])
    ensure_layout(quiet=False)
    prompt = None if opts["wait_only"] else read_prompt(opts)

    info = agent_info(target)
    if not info:
        print(f"error: '{target}' is not a pane that hosts an agent. Run panes.py to list panes.", file=sys.stderr)
        sys.exit(EXIT["usage"])
    if info["pane_id"] == os.environ.get("HERDR_PANE_ID"):
        print("error: the target is your own pane.", file=sys.stderr)
        sys.exit(EXIT["usage"])
    status = info.get("agent_status") if prompt is not None else None
    if status == "working":
        report(info, 0, "")
        print("NOT SENT: the target works on another turn. Wait with "
              f"`herdr agent wait {info['pane_id']} --timeout 600000`, or ask the user before you interrupt it.")
        sys.exit(EXIT["busy"])
    if status == "blocked":
        report(info, 0, "")
        print("NOT SENT: the target waits on a question or an approval. Show this to the user; do not answer it yourself.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(EXIT["blocked"])

    path = session_file(info)
    # A wait-only run reads the whole transcript: its reply is the last one, also from a turn that started earlier.
    offset = line_count(path) if path and prompt is not None else 0
    start = time.time()
    deadline = start + opts["timeout"]
    err = None if prompt is None else send(target, info, prompt, opts["timeout"], start)

    # A timeout or a stall does not prove failure. Poll the state; never resend.
    disk = None
    if err == "agent_prompt_stalled":
        # A Pi pane with no path from Herdr: the session file on disk that holds the prompt shows the turn.
        find = (lambda: pi_disk_session(agent_info(target) or info, prompt, start)) if not path else None
        started, disk = wait_for_turn(target, info, path, offset, deadline, find=find)
        if started:
            err = None  # the turn started late: wait for it as for any turn
    # Without a path from Herdr, a Pi pane's own session file on disk can hold the reply. See pi_disk_session.
    # A stalled turn gets no locator: a file of another pane must not hide the NO TURN STARTED output.
    locate = (lambda now: disk or pi_disk_session(now, prompt, start)) if err is None else None
    now, new_path, offset, texts = settle(target, info, path, offset, deadline, locate=locate)
    from_disk = bool(new_path) and not path and not session_file(now)
    if from_disk and prompt is not None:
        save_pi_session(now, new_path)  # a later run without a prompt reads this file
    status = now.get("agent_status")
    working_on_disk = False
    if from_disk and status not in ("working", "blocked"):
        # Herdr gives no status of a turn in a file on disk (Pi-Bolt shows idle): follow the file to its end.
        # The file must stay the session of the same pane by the rule that found it: no other file, no resend.
        pane_id, found = now["pane_id"], (new_path, offset)

        def current():
            fresh = agent_info(target)
            return bool(fresh) and fresh.get("pane_id") == pane_id and pi_disk_session(fresh, prompt, start) == found
        state, reply = follow_pi_file(new_path, offset, deadline, current)
        now = agent_info(target) or now
        working_on_disk = state == "working"
        texts = [reply] if reply else []  # the message that ended the turn is the reply
        if state == "gone":
            new_path, from_disk = None, False  # NO TRANSCRIPT PATH and the screen tail
    elapsed = time.time() - start

    if status == "working" or working_on_disk:
        report(now, elapsed, f"transcript={new_path}" if working_on_disk else "")
        print("TIMED OUT: the prompt was delivered and the target still works. Do not send the prompt again.")
        if working_on_disk:
            print(f"Wait more with `ask.py {now['pane_id']} --wait-only`; it follows the same session file.")
        else:
            print(f"Wait more with `herdr agent wait {now['pane_id']} --timeout 600000`, "
                  f"then run last-reply.py {now['pane_id']}.")
        sys.exit(EXIT["timeout"])
    if status == "blocked":
        report(now, elapsed, "")
        print("BLOCKED: the target stopped on a question or an approval. Show this to the user; do not answer it yourself.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(EXIT["blocked"])
    if not texts:
        report(now, elapsed, "")
        if err == "agent_prompt_stalled":
            print(f"NO TURN STARTED: Herdr wrote the prompt but saw no activity, also after {STALL_SECONDS} seconds more. "
                  "Read the screen before any other input.")
        elif not new_path:
            # Herdr knows the transcript only from the reporter of the harness; without it, or without the socket, no reply is readable.
            print(f"{NO_TRANSCRIPT_LINE} (is the Herdr integration for the harness installed, or does the pane run without HERDR_SOCKET_PATH, as Pi-Bolt does?). The screen tail follows.")
        else:
            print(f"{NO_NEW_REPLY_LINE}. The screen tail follows.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 60), 4000))
        sys.exit(EXIT["no_turn"] if err == "agent_prompt_stalled" else EXIT["reply"])

    report(now, elapsed, f"transcript={new_path}")
    if from_disk:
        print(f"{DISK_NOTE}{new_path}")
    reply = texts[-1]
    if is_api_error(reply):
        fallback = transcript_fallback(new_path, offset)
        if fallback is None:
            print("API ERROR: the reply is an API error and the transcript holds no other reply. "
                  "Read the commit of the agent, or send the prompt again in a new pane.")
            print_reply(now["pane_id"], reply, opts["max_chars"])
            sys.exit(EXIT["api_error"])
        print(f"{API_ERROR_NOTE} ({clip_line(reply)}); "
              "text below is the last assistant message of the transcript"
              + ("; from before this prompt" if fallback[1] else ""))
        reply = fallback[0]
    print_reply(now["pane_id"], reply, opts["max_chars"])


if __name__ == "__main__":
    main()
