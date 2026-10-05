#!/usr/bin/env python3
"""Close subagent panes that spawn.py started in your workspace. Refuses all other panes.

Refused: panes with no spawn.py record, panes of another workspace, coordinator
panes, interactive sessions, and your own pane.

Usage: close.py <pane-id-or-name> [<pane-id-or-name> ...]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (agent_info, ensure_layout, error_code, herdr, read_record,  # noqa: E402
                     remove_record, require_herdr_env)


def main():
    require_herdr_env()
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    me = ensure_layout()
    failed = 0
    for target in sys.argv[1:]:
        pane = target
        if ":" not in target:
            info = agent_info(target)
            if not info:
                print(f"{target}: no live agent has this name. Give the pane ID.")
                failed = 1
                continue
            pane = info["pane_id"]
        rec = read_record(pane)
        why = None
        if not rec:
            why = "spawn.py did not start this pane"
        elif rec.get("workspace_id") != me.get("workspace_id"):
            why = "the pane belongs to another workspace"
        elif rec.get("session") == "primary" or rec.get("role") == "coordinator":
            why = "the pane is a coordinator or an interactive session"
        elif pane == me.get("pane_id"):
            why = "the pane is your own pane"
        if why:
            print(f"{pane}: REFUSED, {why}. Close it only when the user tells you to: herdr pane close {pane}")
            failed = 1
            continue
        code, data, raw = herdr("pane", "close", pane)
        err = error_code(data)
        if (code == 0 and not err) or err == "pane_not_found":
            remove_record(pane)
            print(f"{pane}: closed" if not err else f"{pane}: already closed")
        else:
            print(f"{pane}: close failed: {raw[:200]}")
            failed = 1
    sys.exit(failed)


if __name__ == "__main__":
    main()
