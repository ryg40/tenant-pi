#!/usr/bin/env python3
"""Offline, read-only check of the Markdown files of the explicit publish set (Python 3.11+).

Rules: relative links and `#anchors` resolve; each fenced `json` block parses; each
`tenant_pi.py <action>` and its `--flag` exist in the parser of `scripts/tenant_pi.py`;
each parser action is named in a guide under `docs/guides/`; the skill table in the README of a
component of several skills is the skill list of `config/manifest.json`. A diagnostic is
`rule: path:line` and never holds file content. No process, no network, no write.
"""
import sys

# Direct script invocation imports project modules; never leave bytecode in the kit.
sys.dont_write_bytecode = True

import argparse
import json
from pathlib import Path, PurePosixPath
import re

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
from scripts.publish_check import PUBLISH, PUBLISH_DIRS, DEV_ONLY_REL, excluded_files, explicit_files, private_excludes
from scripts import tenant_pi
from scripts.validate import load, manifest

GUIDES = "docs/guides/"
# Optional private-copy link targets. A portable copy can omit them. The list is empty.
DEV_ONLY_TARGETS = ()
# Flags of other programs that the guides and README.md name in a standalone code span.
EXTERNAL_FLAGS = frozenset({
    "--no-approve", "--extensions", "--version", "--prefix", "--ignore-scripts", "--global",
    "--no-verify", "--skip-checks", "--no-push", "--force", "--model", "--remote", "--remote-branch",
})
# Environment names that the launch line or the kit text uses beside the manifest names.
# `PI_CODING_AGENT_` is the prefix that the inventory command of the install text prints.
LAUNCH_ENV = frozenset({"PI_CODING_AGENT_DIR", "PI_MCP_CONFIG_MODE", "WIKI_HOME", "PI_CODING_AGENT_SESSION_DIR",
                        "PI_CODING_AGENT_"})
SHELL_LANGS = ("", "sh", "bash", "shell", "console", "text")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)")
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
SPAN = re.compile(r"(`+)(.+?)\1")
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
CLI = re.compile(r"tenant_pi\.py(?=\s|$)([^;&|>\n]*)")
FLAG = re.compile(r"(?:(?<=\s)|(?<=\[))(--[a-z][a-z0-9-]*)")
STANDALONE_FLAG = re.compile(r"^(--[a-z][a-z0-9-]*)(?:[ =].*)?$")
ENV_NAME = re.compile(r"\b((?:TENANTEXT|PI|WIKI)_[A-Z0-9_]+)\b")
# The header line of a skill table: the first cell is `Skill`. The table ends at the next blank line.
SKILL_HEADER = re.compile(r"^\|\s*Skill\s*\|")
# One row of a skill table: the first cell is one code span with the skill name.
SKILL_ROW = re.compile(r"^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|")


class _Captured(Exception):
    """Stops `tenant_pi.main` at `parse_args`, with the built parser."""


def cli_tree():
    """The global options and the options of each action of the real `tenant_pi.py` parser.

    `main` builds the parser and calls `parse_args`; the patch stops it there, so no action runs.
    """
    captured = []
    original = argparse.ArgumentParser.parse_args

    def capture(self, *args, **kwargs):
        captured.append(self)
        raise _Captured

    argparse.ArgumentParser.parse_args = capture
    try:
        tenant_pi.main([])
    except _Captured:
        pass
    finally:
        argparse.ArgumentParser.parse_args = original
    parser = captured[0]
    actions = {}
    for item in parser._actions:
        if isinstance(item, argparse._SubParsersAction):
            for name, sub in item.choices.items():
                actions[name] = {option for entry in sub._actions for option in entry.option_strings}
    return {option for item in parser._actions for option in item.option_strings}, actions


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


def published(rel, root=ROOT):
    """Whether a link target belongs to the publish set, including optional exclusions."""
    if rel == DEV_ONLY_REL or excluded_files({rel, rel.rstrip("/") + "/"}, private_excludes(root)):
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


def commands(prose, blocks):
    """(line, text) of each code span and of each shell block line, continuations joined."""
    for number, line in prose:
        for match in SPAN.finditer(line):
            yield number, match.group(2)
    for lang, start, lines in blocks:
        if lang not in SHELL_LANGS:
            continue
        pending, first = "", None
        for number, line in lines:
            first = number if first is None else first
            if line.rstrip().endswith("\\"):
                pending += line.rstrip()[:-1] + " "
                continue
            yield first, pending + line
            pending, first = "", None
        if pending:
            yield first, pending


def skill_table(lines):
    """The lines of the first skill table: from its header line to the next blank line.

    A README with no skill table gives no line. Another table of the README is not read.
    """
    start = next((index for index, line in enumerate(lines) if SKILL_HEADER.match(line)), None)
    if start is None:
        return []
    end = next((index for index in range(start, len(lines)) if not lines[index].strip()), len(lines))
    return lines[start:end]


def skill_lists(components):
    """(README path, skill names) of each tree component with more than one skill, in manifest order.

    The README is in the parent directory of the skill directories. It holds the one document list
    of the skills of the component; the other documents point at it.
    """
    for component in components.values():
        skills = component["resources"]["skills"]
        if component["source"] and component["source"]["kind"] == "tree" and len(skills) > 1:
            parents = {PurePosixPath(skill).parent.as_posix() for skill in skills}
            yield (f"{component['source']['path']}/{sorted(parents)[0]}/README.md",
                   [PurePosixPath(skill).name for skill in skills] if len(parents) == 1 else None)


def check(root=ROOT, files=None):
    """Sorted unique diagnostics and counts for the Markdown files of the publish set."""
    every_list = files is None
    files = sorted(name for name in explicit_files(root, PUBLISH) if name.endswith(".md")) if files is None else sorted(files)
    top, actions = cli_tree()
    every_flag = top.union(*actions.values())
    components = manifest(load(root / "config/manifest.json"))
    env_names = LAUNCH_ENV | {name for component in components.values() for name in component["env"]}
    parsed, findings, guided = {}, set(), set()
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
        strict = name.startswith(GUIDES) or name == "README.md"
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
                        if rel not in DEV_ONLY_TARGETS:
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
        for number, text in commands(prose, blocks):
            where = f"{name}:{number}"
            for match in CLI.finditer(text):
                rest = match.group(1)
                word = rest.split()[0] if rest.split() else ""
                if not word or word.startswith(("<", "[")):
                    continue
                if word.startswith("-"):
                    if word not in top:
                        findings.add(f"cli_flag: {where}")
                    continue
                if word not in actions:
                    findings.add(f"cli_action: {where}")
                    continue
                if name.startswith(GUIDES):
                    guided.add(word)
                for flag in FLAG.findall(rest):
                    if flag not in actions[word]:
                        findings.add(f"cli_flag: {where}")
            if strict:
                standalone = STANDALONE_FLAG.match(text.strip())
                if standalone and standalone.group(1) not in every_flag | EXTERNAL_FLAGS:
                    findings.add(f"cli_flag: {where}")
        if strict:
            for number, line in prose + [item for _, _, lines in blocks for item in lines]:
                for env in ENV_NAME.findall(line):
                    if env not in env_names:
                        findings.add(f"env_name: {name}:{number}")
    # A synthetic file list checks a skill table only when it names the README.
    for name, expected in skill_lists(components):
        if not every_list and name not in files:
            continue
        try:
            lines = (root / name).read_text(encoding="utf-8").split("\n")
        except (OSError, UnicodeError):
            findings.add(f"skill_list: {name}")
            continue
        rows = [match.group(1) for match in map(SKILL_ROW.match, skill_table(lines)) if match]
        if rows != expected:
            findings.add(f"skill_list: {name}")
    for action in sorted(set(actions) - guided):
        findings.add(f"action_unguided: scripts/tenant_pi.py:{action}")
    counts["actions"] = len(actions)
    return sorted(findings), counts


def main():
    findings, counts = check()
    for finding in findings:
        print(finding)
    if findings:
        print(f"doc check failed: {len(findings)} findings")
        return 1
    print(f"doc check valid: {counts['files']} files, {counts['links']} links, {counts['json']} json blocks, "
          f"{counts['actions']} actions (offline text checks only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
