#!/usr/bin/env python3
"""Build the plugin skills from package sources without deleting any files."""
import argparse
import os
from pathlib import Path
import shutil
import stat
import sys

SKILLS = ("herdr",)
EXCLUDED = {"install.sh", "tests", "__pycache__"}


def inventory(source):
    directories, files = [], []

    def visit(path):
        if path.name in EXCLUDED or path.suffix == ".pyc":
            return
        if path.is_symlink():
            raise ValueError(f"source is a symlink: {path}")
        if path.is_dir():
            directories.append(path.relative_to(source))
            for child in sorted(path.iterdir()):
                visit(child)
        elif path.is_file():
            files.append(path.relative_to(source))
        else:
            raise ValueError(f"source is not a regular file or directory: {path}")

    for name in SKILLS:
        skill = source / name
        if not skill.is_dir():
            raise ValueError(f"source skill is missing: {name}")
        visit(skill)
    return directories, files


def build(source, destination):
    directories, files = inventory(source)
    # Resolve parent aliases, but never follow links at or inside the destination.
    destination = Path(os.path.realpath(destination.parent)) / destination.name
    for path in (destination, *destination.parents):
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        except OSError as error:
            raise ValueError(f"cannot inspect destination path: {path}; check its parent directories") from error
        if not stat.S_ISDIR(mode):
            raise ValueError(f"destination path is not a plain directory: {path}")
    resolved_source, resolved_destination = source.resolve(), destination.resolve()
    if (resolved_destination.is_relative_to(resolved_source)
            or resolved_source.is_relative_to(resolved_destination)):
        raise ValueError("destination overlaps the source skills")
    expected_directories, expected_files = set(directories), set(files)

    def validate(path):
        relative = path.relative_to(destination)
        inside_skill = len(relative.parts) > 1 and relative.parts[0] in SKILLS
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"destination contains a symlink: {path}")
        if stat.S_ISDIR(metadata.st_mode) and (relative in expected_directories
                                             or (inside_skill and path.name == "__pycache__")):
            for child in path.iterdir():
                validate(child)
        elif stat.S_ISREG(metadata.st_mode) and (relative in expected_files
                                                or (inside_skill and path.suffix == ".pyc")):
            if metadata.st_nlink != 1:
                raise ValueError(f"destination contains a hard-linked file: {path}")
        else:
            raise ValueError(f"destination contains an unexpected entry: {path}; remove it by hand")

    if destination.exists():
        for child in destination.iterdir():
            validate(child)
    destination.mkdir(parents=True, exist_ok=True)
    for relative in directories:
        (destination / relative).mkdir(exist_ok=True)
    for relative in files:
        shutil.copy2(source / relative, destination / relative)
    return len(files)


def main():
    plugin = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", type=Path, default=plugin / "skills",
                        help="output skills directory (default: skills beside this script)")
    args = parser.parse_args()
    try:
        count = build(plugin.parent / "skills", args.destination.absolute())
    except (OSError, ValueError) as error:
        print(f"build-skills: {error}", file=sys.stderr)
        return 1
    print(f"build-skills: copied {count} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
