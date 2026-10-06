#!/usr/bin/env python3
"""Send one prompt to an agent that already runs in a Herdr pane, wait until the
agent settles, then print its complete reply. One blocking call.

Usage: ask.py <pane-id-or-agent-name> (--file <prompt-file> | --text "<prompt>")
              [--timeout SECONDS] [--max-chars N]

Exit codes: 0 reply printed | 2 usage or bad target | 3 target is working, nothing sent
            4 target is blocked on a question or approval | 5 no turn started
            6 the reply is an API error and the transcript holds no other reply
            124 timed out while the target still works (prompt was delivered; do not resend)

When the reply is an API error line, the last assistant message written after the
prompt that is not such a line is printed in its place, with a one-line note. Exit
code 0. When only an older message exists, the note ends with "; from before this prompt".
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (agent_info, assistant_texts, clip, ensure_layout, error_code, herdr,  # noqa: E402
                     line_count, require_herdr_env, screen_tail, session_file)


def parse(argv):
    opts = {"timeout": 600, "max_chars": 8000, "text": None, "file": None}
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--timeout", "--max-chars", "--text", "--file"):
            if i + 1 >= len(argv):
                sys.exit(__doc__)
            opts[a[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        else:
            pos.append(a)
            i += 1
    if len(pos) != 1 or bool(opts["text"]) == bool(opts["file"]):
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


def clip_line(text, max_chars=200):
    line = text.strip().splitlines()[0]
    return line if len(line) <= max_chars else line[:max_chars] + "..."


def report(info, elapsed, note):
    print(f"pane={info['pane_id']} agent={info.get('agent')} status={info.get('agent_status')} "
          f"cwd={info.get('cwd')} elapsed={int(elapsed)}s {note}".rstrip())


def main():
    require_herdr_env()
    target, opts = parse(sys.argv[1:])
    ensure_layout(quiet=False)
    if opts["file"]:
        try:
            prompt = open(opts["file"], encoding="utf-8").read().strip()
        except OSError as exc:
            sys.exit(f"error: cannot read prompt file: {exc}")
    else:
        prompt = opts["text"].strip()
    if not prompt:
        sys.exit("error: the prompt is empty")

    info = agent_info(target)
    if not info:
        print(f"error: '{target}' is not a pane that hosts an agent. Run panes.py to list panes.", file=sys.stderr)
        sys.exit(2)
    if info["pane_id"] == os.environ.get("HERDR_PANE_ID"):
        print("error: the target is your own pane.", file=sys.stderr)
        sys.exit(2)
    status = info.get("agent_status")
    if status == "working":
        report(info, 0, "")
        print("NOT SENT: the target works on another turn. Wait with "
              f"`herdr agent wait {info['pane_id']} --timeout 600000`, or ask the user before you interrupt it.")
        sys.exit(3)
    if status == "blocked":
        report(info, 0, "")
        print("NOT SENT: the target waits on a question or an approval. Show this to the user; do not answer it yourself.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(4)

    path = session_file(info)
    offset = line_count(path) if path else 0
    start = time.time()
    deadline = start + opts["timeout"]

    code, data, raw = herdr("agent", "prompt", info["pane_id"], prompt, "--wait",
                            "--timeout", str(opts["timeout"] * 1000), timeout=opts["timeout"] + 30)
    err = error_code(data) or (None if code == 0 else "error")
    if err == "agent_blocked":
        report(agent_info(target) or info, time.time() - start, "")
        print("NOT SENT: the target became blocked. Show the screen to the user.")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(4)
    if err and err not in ("timeout", "agent_prompt_stalled"):
        print(f"error: herdr agent prompt failed: {raw[:500]}", file=sys.stderr)
        sys.exit(2)

    # A timeout or a stall does not prove failure. Poll the state; never resend.
    while True:
        now = agent_info(target) or info
        status = now.get("agent_status")
        if status != "working" or time.time() >= deadline:
            break
        remaining = max(1, int(deadline - time.time()))
        herdr("agent", "wait", info["pane_id"], "--timeout", str(remaining * 1000), timeout=remaining + 30)

    time.sleep(1)  # let the transcript flush
    now = agent_info(target) or info
    status = now.get("agent_status")
    elapsed = time.time() - start
    new_path = session_file(now) or path
    if new_path != path:
        offset = 0
    texts = assistant_texts(new_path, offset) if new_path else []

    if status == "working":
        report(now, elapsed, "")
        print("TIMED OUT: the prompt was delivered and the target still works. Do not send the prompt again.")
        print(f"Wait more with `herdr agent wait {now['pane_id']} --timeout 600000`, then run last-reply.py {now['pane_id']}.")
        sys.exit(124)
    if status == "blocked":
        report(now, elapsed, "")
        print("BLOCKED: the target stopped on a question or an approval. Show this to the user; do not answer it yourself.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 40), 3000))
        sys.exit(4)
    if not texts:
        report(now, elapsed, "")
        if err == "agent_prompt_stalled":
            print("NO TURN STARTED: Herdr wrote the prompt but saw no activity. Read the screen before any other input.")
        else:
            print("NO NEW REPLY in the transcript. The screen tail follows.")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 60), 4000))
        sys.exit(5 if err == "agent_prompt_stalled" else 0)

    report(now, elapsed, f"transcript={new_path}")
    reply = texts[-1]
    if is_api_error(reply):
        fallback = transcript_fallback(new_path, offset)
        if fallback is None:
            print("API ERROR: the reply is an API error and the transcript holds no other reply. "
                  "Read the commit of the agent, or send the prompt again in a new pane.")
            print("--- reply ---")
            print(clip(reply, opts["max_chars"]))
            sys.exit(6)
        print(f"note: reply was an API error ({clip_line(reply)}); "
              "text below is the last assistant message of the transcript"
              + ("; from before this prompt" if fallback[1] else ""))
        reply = fallback[0]
    print("--- reply ---")
    print(clip(reply, opts["max_chars"]))


if __name__ == "__main__":
    main()
