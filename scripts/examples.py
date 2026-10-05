#!/usr/bin/env python3
"""Render portable examples from the strict manifest and synthetic v1 defaults."""
import argparse
import json
from pathlib import Path

from validate import ROOT, SAMPLE_TARGET, Invalid, load, manifest


def render(data):
    components = manifest(data)
    overlay = {
        "schemaVersion": 1,
        "target": {"agentDir": SAMPLE_TARGET},
        "selection": {"enable": ["core"], "disable": sorted(set(components) - {"core"})},
        "paths": {}, "roles": {}, "endpoints": {}, "env": {},
        "inputs": {"modelsFile": None, "mcpFile": None},
        "consent": {"memoryCapture": False, "remoteMemoryWrites": False, "telemetry": False},
    }
    from validate import overlay as validate_overlay
    validate_overlay(overlay, components)
    config = json.dumps(overlay, indent=2) + "\n"
    names = sorted({name for component in components.values() for name in component["env"]})
    env = "# Synthetic names only; tenant-pi does not source this file.\n"
    env += "# Set values outside the repository after local review.\n"
    env += "".join(f"{name}=\n" for name in names)
    return {ROOT / "config/config.example.json": config, ROOT / ".env.example": env}


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
