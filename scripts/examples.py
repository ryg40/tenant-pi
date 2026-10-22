#!/usr/bin/env python3
"""Render the portable `.env.example` from the strict manifest: the environment names of the components."""
import argparse
from pathlib import Path

from validate import ROOT, Invalid, load, manifest


def render(data):
    components = manifest(data)
    names = sorted({name for component in components.values() for name in component["env"]})
    env = "# Synthetic names only; tenant-pi does not source this file.\n"
    env += "# Set values outside the repository after local review.\n"
    env += "".join(f"{name}=\n" for name in names)
    return {ROOT / ".env.example": env}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="regenerate only tracked synthetic examples")
    args = parser.parse_args()
    try:
        outputs = render(load(ROOT / "config/manifest.json"))
    except Invalid as exc:
        parser.exit(2, str(exc) + "\n")
    if args.write:
        for path, content in outputs.items():
            path.write_text(content, encoding="utf-8")
    elif any(path.read_text(encoding="utf-8") != content for path, content in outputs.items()):
        parser.exit(2, "example_mismatch: generated examples\n")
    print("examples valid" if not args.write else "synthetic examples regenerated")


if __name__ == "__main__":
    main()
