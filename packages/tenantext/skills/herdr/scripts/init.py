#!/usr/bin/env python3
"""Prepare the workspace layout and print who you are. Run it first. Safe to repeat.

On the first use in a workspace, the tab of the caller gets the label `coordinator`,
moves to position 1, and the caller gets the name <project>-coordinator-1.

Usage: init.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import ROLES, ensure_layout, require_herdr_env, tabs  # noqa: E402


def main():
    require_herdr_env()
    me = ensure_layout(quiet=False)
    if not me:
        sys.exit("error: could not read your pane from Herdr")
    me["role_tabs"] = {t["label"]: t["tab_id"] for t in tabs(me["workspace_id"]) if t.get("label") in ROLES}
    print(json.dumps(me))


if __name__ == "__main__":
    main()
