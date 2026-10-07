"""Offline packaging and temporary-home installation checks for knowledge skills."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "packages/tenantext/skills/knowledge-skills"
NAMES = {"okf-knowledge-base", "open-knowledge-write-skill", "open-knowledge-discovery", "open-knowledge"}
PIN = "776760f49d5b3b5c24921165b6c1ea17e8990fd5"


class KnowledgeSkillsTests(unittest.TestCase):
    def install(self, home):
        return subprocess.run(["bash", str(COMPONENT / "install.sh")], text=True,
                              capture_output=True, check=True,
                              env={**os.environ, "KNOWLEDGE_SKILLS_HOME": str(home)})

    def test_manifest_metadata_and_pinned_credits(self):
        manifest = json.loads((ROOT / "config/manifest.json").read_text())
        component = manifest["components"]["knowledge-skills"]
        resources = component["resources"]
        self.assertEqual(NAMES, {Path(skill).name for skill in resources["skills"]})
        self.assertEqual([], resources["extensions"] + resources["prompts"] + resources["themes"])
        self.assertEqual({"kind": "tree", "path": "packages/tenantext"}, component["source"])
        self.assertEqual(["core"], component["requires"])
        self.assertEqual("MIT", component["license"])
        self.assertEqual("tenantext", component["owner"])
        self.assertEqual("unverified", component["status"])
        self.assertEqual({"host_tool_required", "pi_line_unqualified", "kit_test_missing"},
                         {gap["code"] for gap in component["gaps"]})
        self.assertEqual([], component["env"])
        self.assertEqual("reviewed", component["configOwnership"]["status"])
        self.assertEqual([{"file": "settings.json", "key": "package:packages/tenantext:" + skill}
                          for skill in resources["skills"]], component["configOwnership"]["claims"])
        self.assertEqual(NAMES, {path.name for path in COMPONENT.iterdir() if path.is_dir()})
        for name in NAMES:
            with self.subTest(skill=name):
                skill = COMPONENT / name
                text = (skill / "SKILL.md").read_text()
                frontmatter = text.split("---", 2)[1]
                self.assertIn("\nname: " + name + "\n", frontmatter)
                self.assertTrue(text.isascii())
                self.assertIn(PIN, (skill / "CREDITS.md").read_text())
                self.assertIn("Inkeep", (skill / "CREDITS.md").read_text())
                self.assertIn("$" + name, (skill / "agents/openai.yaml").read_text())
        self.assertIn("\ntype: Document\n", (COMPONENT / "okf-knowledge-base/SKILL.md").read_text())
        plugin = json.loads((COMPONENT / "okf-knowledge-base/plugin.json").read_text())
        self.assertEqual("okf", plugin["name"])
        self.assertEqual("https://github.com/inkeep/open-knowledge-skills", plugin["repository"])
        for name in ("description-optimization.md", "pressure-testing.md"):
            self.assertTrue((COMPONENT / "open-knowledge-write-skill/references" / name).is_file())
        license_text = (ROOT / "packages/tenantext/licenses/open-knowledge-skills-MIT.txt").read_text()
        self.assertIn("MIT License", license_text)
        self.assertIn("Copyright (c) 2026 Inkeep", license_text)

    def test_open_knowledge_keeps_all_upstream_references_and_project_scope(self):
        skill = COMPONENT / "open-knowledge"
        references = {
            "anti-patterns.md", "cadence-and-logs.md", "components-and-visuals.md",
            "conflict-resolution.md", "corpus-qa.md", "doc-editing.md", "folder-model.md",
            "ingest-and-sources.md", "linking.md", "media-and-assets.md",
            "onboard-existing-repo.md", "preview.md", "setup.md", "starter-packs.md",
            "template-authoring.md", "writing.md",
        }
        self.assertEqual(references, {path.name for path in (skill / "references").iterdir()})
        for name in references:
            with self.subTest(reference=name):
                text = (skill / "references" / name).read_text()
                self.assertTrue(text.strip())
                self.assertTrue(text.isascii())
        self.assertIn("Kit installation alone does not initialize a project",
                      (skill / "CREDITS.md").read_text())
        self.assertIn("Apply only to an initialized OpenKnowledge project",
                      (skill / "SKILL.md").read_text())
        self.assertIn("In an initialized OpenKnowledge (OK) project:",
                      (skill / "references/setup.md").read_text())

    def test_install_is_repeatable_and_links_only_skills(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            for harness in (".claude", ".pi/agent"):
                (home / harness).mkdir(parents=True)
            for _ in range(2):
                result = self.install(home)
                self.assertEqual("", result.stderr)
                for harness in (".claude", ".pi/agent"):
                    directory = home / harness / "skills"
                    self.assertEqual(NAMES, {path.name for path in directory.iterdir()})
                    for name in NAMES:
                        link = directory / name
                        self.assertTrue(link.is_symlink())
                        self.assertEqual(COMPONENT / name, link.resolve())

    def test_missing_harnesses_are_not_created(self):
        for harness in (None, ".claude", ".pi/agent"):
            with self.subTest(harness=harness), tempfile.TemporaryDirectory() as temp:
                home = Path(temp)
                if harness:
                    (home / harness).mkdir(parents=True)
                self.install(home)
                for candidate in (".claude", ".pi/agent"):
                    self.assertEqual(candidate == harness, (home / candidate).exists())

    def test_existing_files_and_directories_stay_links_are_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            skills = home / ".claude/skills"
            skills.mkdir(parents=True)
            directory = skills / "okf-knowledge-base"
            directory.mkdir()
            (directory / "keep.txt").write_text("keep directory")
            file = skills / "open-knowledge-discovery"
            file.write_text("keep file")
            link = skills / "open-knowledge-write-skill"
            link.symlink_to(home / "missing")
            for _ in range(2):
                result = self.install(home)
                self.assertIn("skipped: " + str(directory), result.stderr)
                self.assertIn("skipped: " + str(file), result.stderr)
                self.assertFalse(directory.is_symlink())
                self.assertEqual("keep directory", (directory / "keep.txt").read_text())
                self.assertEqual("keep file", file.read_text())
                self.assertEqual(COMPONENT / link.name, link.resolve())
            old_target = home / "old skill"
            old_target.mkdir()
            (old_target / "keep.txt").write_text("keep old target")
            link.unlink()
            link.symlink_to(old_target)
            self.install(home)
            self.assertEqual(COMPONENT / link.name, link.resolve())
            self.assertEqual("keep old target", (old_target / "keep.txt").read_text())


if __name__ == "__main__":
    unittest.main()
