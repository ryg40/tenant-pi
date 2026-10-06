"""Command line for tracker-brief/1 documents.

    python3 -m tracker validate FILE [--now ISO]
    python3 -m tracker render FILE OUT.html [--template PATH]
    python3 -m tracker paths FILE [--json]
    python3 -m tracker handoff FILE

Exit 0 on success (warnings allowed), 1 on errors, 2 on usage errors.
No command opens a network connection or runs another program.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .brief import BriefError, default_brief_word_count, parse, parse_utc, stored_handoff, validate
from .paths import extract, format_text
from .render import DEFAULT_TEMPLATE, render


def _report(path, diagnostics, stream):
    for d in diagnostics:
        where = f"{path}:{d.line}" if d.line else str(path)
        print(f"{where}: {d.level} [{d.code}] {d.message}", file=stream)


def _load(path, now=None):
    """Parse and validate. Return (model, diagnostics) or raise SystemExit(1)."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"{path}: error [read] {exc.strerror or exc}", file=sys.stderr)
        raise SystemExit(1)
    try:
        model = parse(text)
    except BriefError as exc:
        _report(path, exc.diagnostics, sys.stderr)
        raise SystemExit(1)
    diagnostics = validate(model, now=now)
    _report(path, diagnostics, sys.stderr)
    if any(d.level == "error" for d in diagnostics):
        raise SystemExit(1)
    return model, diagnostics


def cmd_validate(args):
    model, diagnostics = _load(args.file, now=args.now)
    warnings = sum(1 for d in diagnostics if d.level == "warning")
    print(f"{args.file}: valid; {warnings} warning(s); default brief {default_brief_word_count(model)} words")
    return 0


def cmd_render(args):
    model, _ = _load(args.file)
    try:
        html = render(model, template=args.template)
    except (OSError, ValueError) as exc:
        print(f"{args.template}: error [template] {exc}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(html, encoding="utf-8")
    os.replace(tmp, out)
    print(f"rendered {out}")
    return 0


def cmd_paths(args):
    model, _ = _load(args.file)
    packets = extract(model)
    if args.json:
        print(json.dumps(packets, indent=2, ensure_ascii=False))
    else:
        sys.stdout.write(format_text(packets))
    return 0


def cmd_handoff(args):
    model, _ = _load(args.file)
    handoff = stored_handoff(model)
    if handoff is None:
        print(
            f"{args.file}: error [handoff] this brief stores no next-session prompt; "
            "only a brief with a recommended path has one",
            file=sys.stderr,
        )
        return 1
    sys.stdout.write(handoff["text"] + "\n")
    return 0


def _now_arg(value):
    if parse_utc(value) is None:
        raise argparse.ArgumentTypeError("use UTC like 2030-01-23T06:00:00Z")
    return value


def build_parser():
    parser = argparse.ArgumentParser(prog="python3 -m tracker", description="Validate, render and extract tracker-brief/1 documents.")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="check a brief and print diagnostics")
    p.add_argument("file")
    p.add_argument("--now", type=_now_arg, help="UTC time for the staleness check, like 2030-01-23T06:00:00Z")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("render", help="write the HTML view of a brief")
    p.add_argument("file")
    p.add_argument("out")
    p.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="HTML template with @@TITLE@@ and @@BODY@@")
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("paths", help="print agent packets for the follow-up paths")
    p.add_argument("file")
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    p.set_defaults(func=cmd_paths)

    p = sub.add_parser("handoff", help="print only the stored next-session prompt of the recommended path")
    p.add_argument("file")
    p.set_defaults(func=cmd_handoff)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 1


if __name__ == "__main__":
    sys.exit(main())
