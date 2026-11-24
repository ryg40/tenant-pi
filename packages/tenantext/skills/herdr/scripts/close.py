#!/usr/bin/env python3
"""Close task panes that spawn.py started in your workspace. Refuses all other panes.

Refused: panes with no spawn.py record, panes of another workspace, coordinator
panes, interactive sessions, and your own pane.
On herdr-core (a pane of the Herdr app) a pane is a local terminal of your space: close.py
ends it with `hc kill` only when it has a valid record that spawn.py wrote on herdr-core.

Usage: close.py <pane-id-or-name> [<pane-id-or-name> ...]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (CONTRACT, agent_info, core_error_kind, core_get, core_local, core_record,  # noqa: E402
                     ensure_layout, error_code, hc, herdr, herdr_app_pane, read_record, remove_record,
                     require_backend, require_herdr_env)


def spawned_here(rec, space):
    """True for a record that spawn.py wrote on herdr-core for a task terminal of `space`."""
    return (isinstance(rec, dict) and rec.get("backend") == "herdr-core" and not rec.get("self")
            and rec.get("workspace_id") == space and rec.get("session") != "primary"
            and rec.get("role") != "coordinator")


def close_core(found):
    """close.py on herdr-core. Kill a terminal only with a valid spawn.py record of the caller's space."""
    me = herdr_app_pane(found)
    if not me:
        print(f"error: the herdr-core terminal {found['terminal']} is no local pane of the Herdr app "
              "(no herdr.space or herdr.tab label). Nothing was closed.", file=sys.stderr)
        sys.exit(CONTRACT["backend"]["refusal_exit"]["close"])
    space, mine = me["labels"]["herdr.space"], me.get("address") or found["terminal"]
    failed = 0
    for target in sys.argv[1:]:
        state, terminal = core_get(target)
        if state == "not_found":
            # Already closed. Only a record of a task terminal that spawn.py started in this space goes away.
            if core_local(target) and spawned_here(read_record(target), space):
                remove_record(target)
                print(f"{target}: already closed")
            else:
                print(f"{target}: no terminal has this name or address. Give the address.")
                failed = 1
            continue
        address = (terminal or {}).get("address") if isinstance(terminal, dict) else target
        why = None
        if state == "remote":
            why = "the terminal belongs to another machine"
        elif state != "ok":
            print(f"{target}: close failed: hc get failed: {str(terminal)[:200]}")
            failed = 1
            continue
        elif address == mine:
            why = "the pane is your own pane"
        else:
            rec = core_record(terminal)
            if not rec or rec.get("self"):
                why = "spawn.py did not start this pane, or its record is stale"
            elif rec.get("workspace_id") != space or (terminal.get("labels") or {}).get("herdr.space") != space:
                why = "the pane belongs to another workspace"
            elif rec.get("session") == "primary" or rec.get("role") == "coordinator":
                why = "the pane is a coordinator or an interactive session"
        if why:
            print(f"{address}: REFUSED, {why}. Close it only when the user tells you to: hc kill {address}")
            failed = 1
            continue
        code, data, raw = hc("kill", address, "--json", timeout=30)
        kind = core_error_kind(data)
        if (code == 0 and not kind) or kind == "not_found":
            remove_record(address)
            print(f"{address}: closed" if not kind else f"{address}: already closed")
        else:
            print(f"{address}: close failed: {raw[:200]}")
            failed = 1
    sys.exit(failed)


def main():
    found = require_backend("close", core=True)
    if found["backend"] == "core":
        if len(sys.argv) < 2:
            sys.exit(__doc__)
        return close_core(found)
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
