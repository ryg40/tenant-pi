#!/usr/bin/env python3
"""Show the tools, skills and processes of the catalog, with the location that is
present on this machine. Use it when a method fails and you need the next one.

Usage: resources.py                 all entries
       resources.py --group web     entries of one group (web, local)
       resources.py <id>            one entry, with all its locations
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import MACHINE_CATALOG, load_catalog, location_state, resolve_resource  # noqa: E402


def main():
    args = sys.argv[1:]
    resources = load_catalog()
    if args and not args[0].startswith("--"):
        entry = resources.get(args[0])
        if not entry:
            sys.exit(f"error: no entry '{args[0]}'. Entries: {', '.join(sorted(resources))}")
        out = dict(entry, id=args[0], locations=[
            {"location": text, "present": found} for text, found in map(location_state, entry.get("locations") or [])])
        print(json.dumps(out, indent=2))
        return
    group = args[1] if args[:1] == ["--group"] and len(args) == 2 else None
    if args and group is None:
        sys.exit(__doc__)
    print("ORDER\tGROUP\tID\tPRESENT\tLOCATION\tUSE WHEN")
    for order, rid, e in sorted((e.get("order", 100), rid, e) for rid, e in resources.items()):
        if group and e.get("group") != group:
            continue
        where, found = resolve_resource(e)
        state = {True: "yes", False: "no", None: "always"}[found]
        print("\t".join([str(order), e.get("group", ""), rid, state, where or "-", e.get("use_when", "")]))
    print(f"\nMachine file: {MACHINE_CATALOG} ({'present' if os.path.isfile(MACHINE_CATALOG) else 'absent'})")


if __name__ == "__main__":
    main()
