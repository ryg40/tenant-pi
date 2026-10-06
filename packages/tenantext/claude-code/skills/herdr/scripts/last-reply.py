#!/usr/bin/env python3
"""Print the last complete assistant message of the agent in a Herdr pane.

Reads the agent's transcript file, so the text is not cut by the terminal size.
Falls back to the terminal screen when no transcript is found.

Usage: last-reply.py <pane-id-or-agent-name> [--max-chars N]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import agent_info, assistant_texts, clip, require_herdr_env, screen_tail, session_file  # noqa: E402


def main():
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
    info = agent_info(target)
    if not info:
        sys.exit(f"error: '{target}' is not a pane that hosts an agent. Run panes.py to list panes.")
    path = session_file(info)
    print(f"pane={info['pane_id']} agent={info.get('agent')} status={info.get('agent_status')} cwd={info.get('cwd')}")
    texts = assistant_texts(path) if path else []
    if texts:
        print(f"source=transcript {path}")
        print("--- last reply ---")
        print(clip(texts[-1], max_chars))
    else:
        print("source=screen (no transcript text found)")
        print("--- screen tail ---")
        print(clip(screen_tail(target, 80), max_chars))


if __name__ == "__main__":
    main()
