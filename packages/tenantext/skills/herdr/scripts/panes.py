#!/usr/bin/env python3
"""Print a compact table of Herdr panes. Default scope: the caller's workspace.

On herdr-core (a pane of the Herdr app) a workspace is a space (the label herdr.space), and the table
lists only the live terminals of this machine.

Usage: panes.py [--all | --workspace <id-or-label>]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (ROLES, core_harness, core_project, core_role, core_role_tab, core_terminals,  # noqa: E402
                     ensure_layout, error_code, herdr, herdr_app_pane, require_backend, require_herdr_env, tabs)

HEADER = "PANE\tTAB\tNAME\tHARNESS\tSTATUS\tWORKSPACE\tCWD\tLABEL"


def scope_arg(args):
    """(all, workspace) from the arguments; the usage text on a wrong argument."""
    if args == ["--all"]:
        return True, None
    if args[:1] == ["--workspace"] and len(args) == 2:
        return False, args[1]
    if args:
        sys.exit(__doc__)
    return False, None


def panes_core(found):
    """panes.py on herdr-core: the live local terminals of the caller's space, of one space, or of each space."""
    me = herdr_app_pane(found)
    if not me:
        sys.exit(f"error: the herdr-core terminal {found['terminal']} is no pane of the Herdr app "
                 "(no herdr.space or herdr.tab label)")
    every, scope = scope_arg(sys.argv[1:])
    # Read only the needed space: the caller's space, or the space ID after --workspace. A project name, or an
    # ID with no live terminal, needs each space.
    terminals = core_terminals() if every else core_terminals(scope or me["labels"]["herdr.space"])
    if scope and terminals == []:
        terminals = core_terminals()
    if terminals is None:
        sys.exit("error: could not list the herdr-core terminals")
    projects = {}
    for t in terminals:
        projects.setdefault(t["labels"]["herdr.space"], core_project(t))
    projects.setdefault(me["labels"]["herdr.space"], core_project(me))
    if scope and scope not in projects:
        match = [s for s, name in projects.items() if name == scope]
        if len(match) != 1:
            sys.exit(f"error: workspace '{scope}' matches {len(match)} spaces; use the space id. "
                     f"Known: {', '.join(f'{k}={v}' for k, v in projects.items())}")
        scope = match[0]
    if not every:
        scope = scope or me["labels"]["herdr.space"]
        terminals = [t for t in terminals if t["labels"]["herdr.space"] == scope]
    coordinator_tabs = {(t["labels"]["herdr.space"], t["labels"].get("herdr.tab"))
                        for t in terminals if core_role(t) == "coordinator"}
    mine = me.get("address") or found["terminal"]
    print(HEADER)
    for t in terminals:
        labels, status = t["labels"], t.get("status") or {}
        tab = labels.get("herdr.tab") or ""
        roles = [r for r in ROLES if r != "coordinator" and core_role_tab(labels, r) == tab]
        if roles:
            tab = roles[0]
        elif (labels["herdr.space"], tab) in coordinator_tabs:
            tab = "coordinator"
        print("\t".join([
            t["address"] + (" (you)" if t["address"] == mine else ""),
            tab,
            t.get("name") or "-",
            core_harness(t) or "shell",
            status.get("state") or "",
            projects.get(labels["herdr.space"], ""),
            (t.get("foreground") or {}).get("cwd") or t.get("cwd") or "",
            t.get("title") or "-",
        ]))


def main():
    found = require_backend("panes", core=True)
    if found["backend"] == "core":
        return panes_core(found)
    require_herdr_env()
    ensure_layout(quiet=False)
    args = sys.argv[1:]
    scope = os.environ.get("HERDR_WORKSPACE_ID")
    if args[:1] == ["--all"]:
        scope = None
    elif args[:1] == ["--workspace"] and len(args) == 2:
        scope = args[1]
    elif args:
        sys.exit(__doc__)

    code, data, raw = herdr("workspace", "list")
    if code != 0 or not data or error_code(data):
        sys.exit(f"error: workspace list failed: {raw[:300]}")
    workspaces = data["result"]["workspaces"]
    labels = {w["workspace_id"]: w.get("label", "") for w in workspaces}
    if scope and scope not in labels:
        match = [w["workspace_id"] for w in workspaces if w.get("label") == scope]
        if len(match) != 1:
            sys.exit(f"error: workspace '{scope}' matches {len(match)} workspaces; use the workspace id. "
                     f"Known: {', '.join(f'{k}={v}' for k, v in labels.items())}")
        scope = match[0]

    code, data, raw = herdr("agent", "list")
    names = {}
    if data and not error_code(data):
        names = {a["pane_id"]: a.get("name", "") for a in data["result"]["agents"]}

    cmd = ["pane", "list"] + (["--workspace", scope] if scope else [])
    code, data, raw = herdr(*cmd)
    if code != 0 or not data or error_code(data):
        sys.exit(f"error: pane list failed: {raw[:300]}")
    me = os.environ.get("HERDR_PANE_ID", "")
    tab_labels = {}
    for wid in {p["workspace_id"] for p in data["result"]["panes"]}:
        tab_labels.update({t["tab_id"]: f"{i}:{t.get('label', '')}" for i, t in enumerate(tabs(wid), 1)})
    print(HEADER)
    for p in data["result"]["panes"]:
        pid = p["pane_id"]
        print("\t".join([
            pid + (" (you)" if pid == me else ""),
            tab_labels.get(p.get("tab_id"), p.get("tab_id", "")),
            names.get(pid, "") or "-",
            p.get("agent") or "shell",
            p.get("agent_status", ""),
            labels.get(p.get("workspace_id"), ""),
            p.get("cwd", ""),
            p.get("label") or p.get("terminal_title_stripped", "") or "-",
        ]))


if __name__ == "__main__":
    main()
