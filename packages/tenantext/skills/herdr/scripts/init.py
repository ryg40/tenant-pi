#!/usr/bin/env python3
"""Prepare the workspace layout and print who you are. Run it first. Safe to repeat.

On the first use in a workspace, the tab of the caller gets the label `coordinator`,
moves to position 1, and the caller gets the name <project>-coordinator-1.
On herdr-core (a pane of the Herdr app) the first caller of a space becomes its coordinator:
the skill writes its record and sets the label skill.role=coordinator. The core has no rename.
The first tab of a space holds the coordinator: a terminal with no skill.role label and no
-<role>-<n> name becomes the coordinator at its first run when the part of its `where` label after
the last " / " is `coordinator` or `1`. A terminal with a task role name is never claimed.

Usage: init.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (CONTRACT, ROLES, core_coordinator_record, core_project, core_role, core_role_tab,  # noqa: E402
                     core_terminals, ensure_layout, hc, herdr_app_pane, require_backend, require_herdr_env, say_name, tabs,
                     write_record)


def name_role(name):
    """The role in a name of the form `<project>-<role>-<n>`, or None."""
    match = re.search(r"-(%s)-[0-9]+\Z" % "|".join(ROLES), name) if isinstance(name, str) else None
    return match.group(1) if match else None


def first_tab_coordinator(terminal):
    """True when the first-tab rule makes the terminal a coordinator (see roleOfTerminal of the owner popup).

    The terminal has no skill.role label and no role name, and the part of its `where` label after the last
    " / " is exactly `coordinator` or `1`. No " / ", an empty tab part or a `where` that is no text gives False.
    """
    labels = terminal.get("labels") or {}
    if isinstance(labels.get("skill.role"), str) or name_role(terminal.get("name")):
        return False
    where = labels.get("where")
    if not isinstance(where, str) or " / " not in where:
        return False
    return where.rsplit(" / ", 1)[1] in ("coordinator", "1")


def init_core(found):
    """init.py on herdr-core. The space and the tab come only from the labels of the caller's terminal."""
    me = herdr_app_pane(found)
    if not me:
        print(f"error: the herdr-core terminal {found['terminal']} is no pane of the Herdr app (no herdr.space or "
              "herdr.tab label). Nothing was done.", file=sys.stderr)
        sys.exit(CONTRACT["backend"]["refusal_exit"]["init"])
    labels = me["labels"]
    space, address = labels["herdr.space"], me.get("address") or found["terminal"]
    role, claimed = core_role(me), False
    task_named = name_role(me.get("name")) not in (None, "coordinator")
    if role is None and not task_named:
        others = [] if first_tab_coordinator(me) else core_terminals(space)
        if others is None:
            sys.exit("error: could not list the herdr-core terminals; nothing was done")
        if not any(t.get("address") != address and core_role(t) == "coordinator" for t in others):
            write_record(address, core_coordinator_record(dict(me, address=address), space))
            code, _, raw = hc("label", address, "skill.role=coordinator", timeout=20)
            if code != 0:
                print(f"warning: could not set the label skill.role on {address}: {raw[:200]}", file=sys.stderr)
            role, claimed = "coordinator", True
    out = {"backend": "herdr-core", "workspace_id": space, "workspace": core_project(me), "tab_id": labels["herdr.tab"],
           "pane_id": address, "name": me.get("name"), "say": say_name(me.get("name"), labels.get("where")), "role": role,
           "claimed": claimed,
           "role_tabs": {r: core_role_tab(labels, r) for r in ROLES if r != "coordinator" or role == "coordinator"}}
    if claimed:
        print(f"herdr: first use in space '{out['workspace']}'. You are its coordinator; your tab is the "
              "coordinator tab.", file=sys.stderr)
    print(json.dumps(out))


def main():
    found = require_backend("init", core=True)
    if found["backend"] == "core":
        return init_core(found)
    require_herdr_env()
    me = ensure_layout(quiet=False)
    if not me:
        sys.exit("error: could not read your pane from Herdr")
    me["say"] = say_name(me.get("name"))
    me["role_tabs"] = {t["label"]: t["tab_id"] for t in tabs(me["workspace_id"]) if t.get("label") in ROLES}
    print(json.dumps(me))


if __name__ == "__main__":
    main()
