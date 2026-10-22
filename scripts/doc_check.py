#!/usr/bin/env python3
"""Offline, read-only check of explicit Markdown files and published docs (Python 3.11+).

Rules: relative links and `#anchors` resolve; each fenced `json` block parses; each environment
name of `INSTALL.md`, `README.md` and a guide under `docs/guides/` is a known name. A diagnostic
is `rule: path:line` and never holds file content. No process, no network, no write.
"""
import sys

# Direct script invocation imports project modules; never leave bytecode in the kit.
sys.dont_write_bytecode = True

import json
from pathlib import Path, PurePosixPath
import re

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
from scripts.publish_check import (PUBLISH, PUBLISH_DIRS, DEV_ONLY_REL, absent_folders, excluded_files, explicit_files,
                                   private_excludes)
from scripts.validate import load, manifest

GUIDES = "docs/guides/"
# Optional private-copy link targets. A portable copy can omit them. The list is empty.
DEV_ONLY_TARGETS = ()
# Environment names of Pi and of the kit text beside the manifest names.
# `PI_CODING_AGENT_` is the prefix that the inventory command of the install text prints.
LAUNCH_ENV = frozenset({"PI_CODING_AGENT_DIR", "PI_MCP_CONFIG_MODE", "WIKI_HOME", "PI_CODING_AGENT_SESSION_DIR",
                        "PI_CODING_AGENT_"})
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)")
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
SPAN = re.compile(r"(`+)(.+?)\1")
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
ENV_NAME = re.compile(r"\b((?:TENANTEXT|PI|WIKI)_[A-Z0-9_]+)\b")


def slug(text):
    """The GitHub anchor of one heading text."""
    text = re.sub(r"`", "", text).strip().lower()
    return re.sub(r"[^\w\- ]", "", text).replace(" ", "-")


def parse(text):
    """(prose lines, fenced blocks) of one Markdown text, each with its line number."""
    prose, blocks, fence = [], [], None
    for number, line in enumerate(text.split("\n"), 1):
        match = FENCE.match(line)
        if fence is None:
            if match:
                fence = (match.group(1), match.group(2).lower(), number, [])
            else:
                prose.append((number, line))
        elif match and match.group(1)[0] == fence[0][0] and len(match.group(1)) >= len(fence[0]) and not match.group(2):
            blocks.append(fence[1:])
            fence = None
        else:
            fence[3].append((number, line))
    if fence is not None:
        blocks.append(fence[1:])
    return prose, blocks


def anchors(prose):
    found, seen = set(), {}
    for _, line in prose:
        match = HEADING.match(line)
        if match:
            base = slug(match.group(2))
            count = seen.get(base, 0)
            seen[base] = count + 1
            found.add(base if count == 0 else f"{base}-{count}")
    return found


def resolve(name, target):
    """The repository path of a relative link target of file `name`, or None outside the root."""
    parts = []
    for part in PurePosixPath(name).parent.joinpath(target).as_posix().split("/"):
        if part == "..":
            if not parts:
                return None
            parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def json_block(lines):
    """Whether a block is one JSON document, or JSON Lines: one document on each non-empty line."""
    try:
        json.loads("\n".join(lines))
        return True
    except ValueError:
        pass
    rows = [line for line in lines if line.strip()]
    try:
        for row in rows:
            json.loads(row)
    except ValueError:
        return False
    return bool(rows)


def published(rel, root=ROOT, *, entries=None):
    """Whether a link target belongs to the publish set, including optional exclusions."""
    entries = private_excludes(root) if entries is None else entries
    if rel == DEV_ONLY_REL or excluded_files({rel, rel.rstrip("/") + "/"}, entries):
        return False
    if rel in PUBLISH:
        return True
    for directory, excludes in PUBLISH_DIRS:
        if rel == directory:
            return True
        if rel.startswith(directory + "/"):
            rest = rel[len(directory) + 1:]
            return not excluded_files({rest, rest.rstrip("/") + "/"}, excludes)
    return False


def document_files(root):
    """Keep explicit Markdown and directory-selected docs without a Git subprocess."""
    names = {name for name in explicit_files(root, PUBLISH) if name.endswith(".md")}
    names.update(path.relative_to(root).as_posix() for path in (root / "docs").rglob("*.md")
                 if path.is_file())
    entries = private_excludes(root)
    return sorted(name for name in names if published(name, root, entries=entries))


def check(root=ROOT, files=None):
    """Sorted unique diagnostics and counts for the Markdown files of the publish set."""
    files = document_files(root) if files is None else sorted(files)
    components = manifest(load(root / "config/manifest.json"))
    env_names = LAUNCH_ENV | {name for component in components.values() for name in component["env"]}
    parsed, findings = {}, set()
    # A link into the folder of a tree component that the kit leaves out is no finding.
    absent = absent_folders(root)
    counts = {"files": 0, "links": 0, "json": 0}
    for name in files:
        path = root / name
        if path.is_symlink() or not path.is_file():
            findings.add(f"doc_missing: {name}")
            continue
        try:
            parsed[name] = parse(path.read_text(encoding="utf-8"))
        except UnicodeError:
            findings.add(f"doc_text: {name}")
    for name, (prose, blocks) in parsed.items():
        counts["files"] += 1
        strict = name.startswith(GUIDES) or name in ("INSTALL.md", "README.md")
        for number, line in prose:
            for match in LINK.finditer(SPAN.sub("", line)):
                target = match.group(1)
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                    continue
                counts["links"] += 1
                where = f"{name}:{number}"
                file_part, _, anchor = target.partition("#")
                if file_part:
                    rel = resolve(name, file_part)
                    if rel is None:
                        findings.add(f"link_outside: {where}")
                        continue
                    if not (root / rel).exists():
                        if rel not in DEV_ONLY_TARGETS and not (rel + "/").startswith(absent):
                            findings.add(f"link_missing: {where}")
                        continue
                    if rel not in DEV_ONLY_TARGETS and not published(rel, root):
                        findings.add(f"link_unpublished: {where}")
                        continue
                else:
                    rel = name
                if anchor and rel.endswith(".md"):
                    if rel not in parsed:
                        try:
                            parsed_target = parse((root / rel).read_text(encoding="utf-8"))
                        except (OSError, UnicodeError):
                            findings.add(f"link_missing: {where}")
                            continue
                    else:
                        parsed_target = parsed[rel]
                    if anchor not in anchors(parsed_target[0]):
                        findings.add(f"anchor_missing: {where}")
        for lang, start, lines in blocks:
            if lang != "json":
                continue
            counts["json"] += 1
            if not json_block([line for _, line in lines]):
                findings.add(f"json_example: {name}:{start}")
        if strict:
            for number, line in prose + [item for _, _, lines in blocks for item in lines]:
                for env in ENV_NAME.findall(line):
                    if env not in env_names:
                        findings.add(f"env_name: {name}:{number}")
    return sorted(findings), counts


def main():
    findings, counts = check()
    for finding in findings:
        print(finding)
    if findings:
        print(f"doc check failed: {len(findings)} findings")
        return 1
    print(f"doc check valid: {counts['files']} files, {counts['links']} links, {counts['json']} json blocks "
          f"(offline text checks only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
