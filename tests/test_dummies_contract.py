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


if __name__ == "__main__":
    unittest.main()
