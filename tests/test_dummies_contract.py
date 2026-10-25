"""Structural checks of the shipped dummies skill and its page template."""
import argparse
import importlib.util
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "packages/tenantext/skills/coordinator-skills/dummies"
FILES = ("SKILL.md", "REPORT.md", "LOG.md", "page-template.md", "CREDITS.md",
         "scripts/state.py", "scripts/page.py", "agents/openai.yaml")

spec = importlib.util.spec_from_file_location("dummies_page_contract", SKILL / "scripts/page.py")
page = importlib.util.module_from_spec(spec)
spec.loader.exec_module(page)

PATTERN_NAMES = ("report", "outcome", "item", "warning", "next", "action", "none")


def syntax_patterns():
    """The line patterns of compact report syntax 2, read from REPORT.md section 6."""
    text = (SKILL / "REPORT.md").read_text(encoding="utf-8")
    section = text.split("## 6. Compact report syntax 2", 1)[1]
    block = re.search(r"```text\n(.*?)\n```", section, re.S)[1]
    patterns = {}
    for line in block.splitlines():
        name, pattern = line.split(None, 1)
        patterns[name] = re.compile(pattern)
    return patterns


FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# The documented order of the block: the line kinds that can follow each kind.
FOLLOWS = {"report": ("item", "warning", "next", "none"), "item": ("item", "warning", "next", "none"),
           "warning": ("warning", "next", "none"), "next": ("action",), "action": ("action",), "none": ()}


def unfenced_lines(message):
    """The lines of a message outside code fences and quotes, with the fence rule of section 6."""
    lines, fence = [], None
    for line in message.splitlines():
        opening = FENCE.match(line)
        if fence is None and opening:
            fence = opening[1]
        elif fence is not None:
            if opening and opening[1][0] == fence[0] and len(opening[1]) >= len(fence) \
                    and not line[opening.end():].strip(" "):
                fence = None
        elif not line.startswith(">"):
            lines.append(line)
    return lines


def check_block(message, patterns):
    """Check the report block of one message against section 6; raise ValueError when it is missing or ambiguous."""
    lines = unfenced_lines(message)
    markers = [i for i, line in enumerate(lines) if patterns["report"].match(line) or patterns["outcome"].match(line)]
    if len(markers) != 1:
        raise ValueError(f"{len(markers)} report lines")
    numbers, actions, stage = [], [], "report"
    for line in lines[markers[0] + 1:]:
        if not line.strip(" "):
            if stage == "next":
                raise ValueError("an empty line after the next line")
            if stage in ("action", "none"):
                break
            continue
        kind = next((name for name in FOLLOWS[stage] if patterns[name].match(line)), None)
        if kind is None:
            raise ValueError(f"line out of the syntax: {line!r}")
        stage = kind
        match = patterns[kind].match(line)
        if kind == "item":
            numbers.append(match[1])
        elif kind == "action":
            actions.append(match[1])
    if stage not in ("action", "none"):
        raise ValueError("no next action and no none line")
    if not numbers or numbers != [str(i + 1) for i in range(len(numbers))]:
        raise ValueError("item numbers must start at 1 and increase by 1")
    expected = "a"
    for label in actions:
        if label != expected:
            raise ValueError("action labels must start at a and follow base-26 order")
        ordinal = 0
        for character in expected:
            ordinal = ordinal * 26 + ord(character) - ord("a") + 1
        ordinal += 1
        expected = ""
        while ordinal:
            ordinal, digit = divmod(ordinal - 1, 26)
            expected = chr(ord("a") + digit) + expected


class DummiesContractTests(unittest.TestCase):
    def test_skill_files_exist(self):
        for name in FILES:
            with self.subTest(name=name):
                self.assertTrue((SKILL / name).is_file())

    def test_page_template_matches_the_written_page(self):
        template = (SKILL / "page-template.md").read_text(encoding="utf-8")
        expected = (template.replace("{title}", "Example log").replace("{slug}", "example-project")
                    .replace("{zone}", "UTC (UTC+00:00)").replace("{context}", ""))
        with tempfile.TemporaryDirectory(prefix="dummies-template-") as temporary:
            target = Path(temporary) / "DUMMIES.md"
            args = argparse.Namespace(zone="UTC (UTC+00:00)", title="Example log")
            facts = {"harness": "pi", "agent": "Pi", "model": "example/model", "session": "example-session"}
            page.new_page(page.LocalFile(str(target)), "DUMMIES", "example-project", args, facts)
            self.assertEqual(expected, target.read_text(encoding="utf-8"))

    def test_skill_text_names_only_files_that_exist(self):
        for name in ("SKILL.md", "REPORT.md", "LOG.md"):
            text = (SKILL / name).read_text(encoding="utf-8")
            # Inline file names and script commands exclude the example report's resource column.
            references = re.findall(r"`([^`\n]+)`", text)
            references += re.findall(r"(?m)^python3 (D/[^\s]+)", text)
            for reference in references:
                match = re.search(r"(?:D/)?[\w./-]+\.(?:md|py|yaml)\b", reference)
                if match:
                    path = match[0].replace("D/", "scripts/", 1)
                    if path.endswith(".py") and "/" not in path:
                        path = "scripts/" + path
                    with self.subTest(name=name, path=path):
                        self.assertTrue((SKILL / path).is_file())

    def test_example_reports_follow_compact_report_syntax_2(self):
        # A program that reads the chat report uses these patterns, so the examples must parse with them.
        patterns = syntax_patterns()
        self.assertEqual(set(PATTERN_NAMES), set(patterns))
        for name, marker in (("REPORT.md", "report"), ("LOG.md", "outcome")):
            text = (SKILL / name).read_text(encoding="utf-8")
            examples = re.findall(r"```markdown\n(.*?)\n```", text, re.S)
            self.assertTrue(any(patterns[marker].match(example.splitlines()[0]) for example in examples), name)
            for example in examples:
                first = example.splitlines()[0]
                with self.subTest(name=name, example=first):
                    self.assertTrue(patterns["report"].match(first) or patterns["outcome"].match(first))
                    check_block(example, patterns)


if __name__ == "__main__":
    unittest.main()
