#!/usr/bin/env python3
"""Print the last complete assistant message of the agent in a Herdr pane.

Reads the agent's transcript file, so the text is not cut by the terminal size.
For a Pi pane that Herdr gives no transcript path, reads the session file that an
earlier prompt of ask.py matched in this pane, when it is still certain.
Falls back to the terminal screen when no transcript is found.
On herdr-core (a pane of the Herdr app) the target is a local, live terminal: Claude Code
gives its transcript through ~/.claude/sessions/<pid>.json, and the screen comes from `hc read`.
An agy pane keeps no transcript file for this script: it shows the screen.

Usage: last-reply.py <pane-id-or-agent-name> [--max-chars N]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (CONTRACT, DISK_NOTE, PI_AGENTS, agent_info, assistant_texts, clip, core_get,  # noqa: E402
                     core_info, core_screen, herdr_app_pane, pi_disk_session, require_backend, require_herdr_env,
                     saved_pi_session, screen_tail, session_file)


def core_last(found, target):
    """last-reply.py on herdr-core: (info, transcript, from disk, screen function) of a LOCAL, LIVE agent terminal.

    The transcript of Claude Code comes from the sessions file of its process; of Pi, the session file that an
    earlier prompt of ask.py saved in the record. Exit 1 for a bad target, as on Herdr 1.
    """
    me = herdr_app_pane(found)
    if not me:
        print(f"error: the herdr-core terminal {found['terminal']} is no local pane of the Herdr app "
              "(no herdr.space or herdr.tab label). Nothing was done.", file=sys.stderr)
        sys.exit(CONTRACT["backend"]["refusal_exit"]["last-reply"])
    state, terminal = core_get(target)
    why = {"not_found": "no terminal has this name or address", "remote": "it is a terminal of another machine",
           "error": f"hc get failed: {str(terminal)[:300]}"}.get(state)
    if not why and terminal.get("state") != "live":
        why = "the terminal is not live"
    info = core_info(terminal) if not why else {}
    if not why and not info.get("agent"):
        why = "the terminal hosts no agent"
    if not why and info["pane_id"] == (me.get("address") or found["terminal"]):
        why = "the target is your own terminal"
    if why:
        sys.exit(f"error: '{target}': {why}. Run panes.py to list panes.")
    path = session_file(info)
    disk = info.get("agent") in PI_AGENTS and not path
    path = path or (saved_pi_session(info) if disk else None)
    return info, path, bool(disk and path), lambda lines: core_screen(info["pane_id"], lines)


def main():
    found = require_backend("last-reply", core=True)
    if found["backend"] != "core":
        require_herdr_env()
    args = sys.argv[1:]
    max_chars = 8000
    if "--max-chars" in args:
        i = args.index("--max-chars")
        max_chars = int(args[i + 1])
        del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    target = args[0]
    if found["backend"] == "core":
        info, path, disk, screen = core_last(found, target)
    else:
        info = agent_info(target)
        if not info:
            sys.exit(f"error: '{target}' is not a pane that hosts an agent. Run panes.py to list panes.")
        path = session_file(info)
        # Without a path from Herdr: the Pi session file that an earlier prompt of ask.py matched in this pane.
        disk = None if path else pi_disk_session(info)
        path = path or (disk and disk[0])

        def screen(lines):
            return screen_tail(target, lines)
    print(f"pane={info['pane_id']} agent={info.get('agent')} status={info.get('agent_status')} cwd={info.get('cwd')}")
    texts = assistant_texts(path) if path else []
    if texts:
        print(f"source=transcript {path}")
        if disk:
            print(f"{DISK_NOTE}{path}")
        print("--- last reply ---")
        print(clip(texts[-1], max_chars, head=max_chars // 4))
    else:
        print("source=screen (no transcript text found)")
        print("--- screen tail ---")
        print(clip(screen(80), max_chars))


if __name__ == "__main__":
    main()
