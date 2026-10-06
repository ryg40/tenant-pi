#!/usr/bin/env python3
"""Print a compact table of Herdr panes. Default scope: the caller's workspace.

Usage: panes.py [--all | --workspace <id-or-label>]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import ensure_layout, error_code, herdr, require_herdr_env, tabs  # noqa: E402


def main():
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
    print("PANE\tTAB\tNAME\tHARNESS\tSTATUS\tWORKSPACE\tCWD\tLABEL")
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
