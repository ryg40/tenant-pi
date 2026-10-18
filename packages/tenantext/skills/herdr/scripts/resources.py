#!/usr/bin/env python3
"""Show the tools, skills and processes of the catalog, with the location that is
present on this machine. Use it when a method fails and you need the next one.

Usage: resources.py                 all entries
       resources.py --group web     entries of one group (web, local)
       resources.py --role scout    entries for one role (also with --group)
       resources.py <id>            one entry, with all its locations
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (MACHINE_CATALOG, ROLES, load_catalog, location_state,  # noqa: E402
                     resolve_resource, role_matches)


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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--group")
    parser.add_argument("--role", choices=ROLES)
    options = parser.parse_args(args)
    print("ORDER\tGROUP\tID\tROLES\tPRESENT\tLOCATION\tUSE WHEN")
    for order, rid, e in sorted((e.get("order", 100), rid, e) for rid, e in resources.items()):
        if (options.group and e.get("group") != options.group) or not role_matches(e, options.role):
            continue
        where, found = resolve_resource(e)
        state = {True: "yes", False: "no", None: "always"}[found]
        print("\t".join([str(order), e.get("group", ""), rid, ",".join(e.get("roles", [])) or "-",
                         state, where or "-", e.get("use_when", "")]))
    print(f"\nMachine file: {MACHINE_CATALOG} ({'present' if os.path.isfile(MACHINE_CATALOG) else 'absent'})")


if __name__ == "__main__":
    main()
