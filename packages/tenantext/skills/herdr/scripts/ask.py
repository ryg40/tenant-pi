#!/usr/bin/env python3
"""Send one prompt to an agent that already runs in a Herdr pane, wait until the
agent settles, then print its complete reply. One blocking call.

Usage: ask.py <pane-id-or-agent-name> (--file <prompt-file> | --text "<prompt>")
              [--timeout SECONDS] [--max-chars N]
       ask.py <pane-id-or-agent-name> --wait-only [--timeout SECONDS] [--max-chars N]

--wait-only sends no prompt: it waits until the pane settles and prints the last reply.

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
from _common import (CONTRACT, DISK_NOTE, agent_info, assistant_texts, clip, ensure_layout, error_code,  # noqa: E402
                     exit_codes, herdr, line_count, pi_disk_session, read_record, require_herdr_env,
                     save_pi_session, screen_tail, session_file)

EXIT = exit_codes("ask")
NO_NEW_REPLY_LINE = CONTRACT["ask"]["no_new_reply_line"]
NO_TRANSCRIPT_LINE = CONTRACT["ask"]["no_transcript_line"]
# After agent_prompt_stalled, a turn can still start late, for example on the first turn of a new pane.
STALL_SECONDS = 60


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


def wait_for_turn(target, info, path, offset, deadline):
    """After a stall, poll up to STALL_SECONDS, inside the deadline, for a turn that starts late. Never resend."""
    end = min(deadline, time.time() + STALL_SECONDS)
    while not turn_started(target, info, path, offset):
        if time.time() >= end:
            return False
        time.sleep(2)
    return True


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
        print("note: no result block; the pane may not be done. Read the screen.")


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


def main():
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
    if err == "agent_prompt_stalled" and wait_for_turn(target, info, path, offset, deadline):
        err = None  # the turn started late: wait for it as for any turn
    # Without a path from Herdr, a Pi pane's own session file on disk can hold the reply. See pi_disk_session.
    # A stalled turn gets no locator: a file of another pane must not hide the NO TURN STARTED output.
    locate = (lambda now: pi_disk_session(now, prompt, start)) if err is None else None
    now, new_path, offset, texts = settle(target, info, path, offset, deadline, locate=locate)
    from_disk = bool(new_path) and not path and not session_file(now)
    if from_disk and prompt is not None:
        save_pi_session(now, new_path)  # a later run without a prompt reads this file
    status = now.get("agent_status")
    elapsed = time.time() - start

    if status == "working":
        report(now, elapsed, "")
        print("TIMED OUT: the prompt was delivered and the target still works. Do not send the prompt again.")
        print(f"Wait more with `herdr agent wait {now['pane_id']} --timeout 600000`, then run last-reply.py {now['pane_id']}.")
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
        print(f"note: reply was an API error ({clip_line(reply)}); "
              "text below is the last assistant message of the transcript"
              + ("; from before this prompt" if fallback[1] else ""))
        reply = fallback[0]
    print_reply(now["pane_id"], reply, opts["max_chars"])


if __name__ == "__main__":
    main()
