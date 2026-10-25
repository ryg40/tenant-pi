#!/usr/bin/env python3
"""Build the plugin skills from package sources without deleting any files."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import sys

EXCLUDED = {"install.sh", "tests", "__pycache__"}
PACKAGE = "packages/tenantext"
MANIFEST = Path(__file__).resolve().parents[3] / "config/manifest.json"
# Package directories that a skill runs from its own copy. The plugin cache of Claude Code holds only
# the plugin directory, so the copy of tracker-site carries the tracker package beside its SKILL.md.
SUPPORT = {"tracker-site": ("tracker",)}
# Package licence texts that the CREDITS.md files of the skills name. A cached plugin copy has no other file
# of the package, so the build puts them beside the skill folders, with the names of the package root.
NOTICES = ("LICENSE", "licenses")


def declared_skills(manifest=MANIFEST):
    """The skill paths below skills/ that the kit manifest declares for this package, in manifest order."""
    skills = []
    for component in json.loads(Path(manifest).read_text(encoding="utf-8"))["components"].values():
        if component["source"] != {"kind": "tree", "path": PACKAGE}:
            continue
        for item in component["resources"]["skills"]:
            if not item.startswith("skills/"):
                raise ValueError(f"declared skill is not below skills/: {item}")
            skills.append(item.removeprefix("skills/"))
    return tuple(skills)


def inventory(source, skills, notices=()):
    """Map each source file and directory to its path in the flat output: <skill name>/... and the notices."""
    directories, files, names, roots = [], [], [], [source]

    def visit(path, target):
        if path.name in EXCLUDED or path.suffix == ".pyc":
            return
        if path.is_symlink():
            raise ValueError(f"source is a symlink: {path}")
        if path.is_dir():
            directories.append(target)
            for child in sorted(path.iterdir()):
                visit(child, target / child.name)
        elif path.is_file():
            files.append((path, target))
        else:
            raise ValueError(f"source is not a regular file or directory: {path}")

    for relative in skills:
        skill = source / relative
        if not skill.is_dir():
            raise ValueError(f"source skill is missing: {relative}")
        if skill.name in names:
            raise ValueError(f"two declared skills have the name: {skill.name}")
        names.append(skill.name)
        visit(skill, Path(skill.name))
        for name in SUPPORT.get(skill.name, ()):
            support = source.parent / name
            if not support.is_dir():
                raise ValueError(f"support directory is missing: {support}")
            roots.append(support)
            visit(support, Path(skill.name) / name)
    for name in notices:
        notice = source.parent / name
        if name in names:
            raise ValueError(f"a declared skill has the name of a licence entry: {name}")
        if not notice.exists():
            raise ValueError(f"licence entry is missing: {notice}")
        roots.append(notice)
        visit(notice, Path(name))
    return directories, files, names, roots


def build(source, destination, skills=None, notices=()):
    directories, files, names, roots = inventory(source, declared_skills() if skills is None else skills, notices)
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
    resolved_destination = destination.resolve()
    for root in roots:
        resolved_source = root.resolve()
        if (resolved_destination.is_relative_to(resolved_source)
                or resolved_source.is_relative_to(resolved_destination)):
            raise ValueError("destination overlaps the source skills")
    expected_directories, expected_files = set(directories), {target for _, target in files}

    def validate(path):
        relative = path.relative_to(destination)
        inside_skill = len(relative.parts) > 1 and relative.parts[0] in names
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
    for path, relative in files:
        shutil.copy2(path, destination / relative)
    return len(files)


def main():
    plugin = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", type=Path, default=plugin / "skills",
                        help="output skills directory (default: skills beside this script)")
    args = parser.parse_args()
    try:
        skills = declared_skills()
        count = build(plugin.parent / "skills", args.destination.absolute(), skills, NOTICES)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"build-skills: {error}", file=sys.stderr)
        return 1
    print(f"build-skills: copied {count} files of {len(skills)} skills and the licence texts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
