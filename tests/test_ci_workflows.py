"""Offline workflow contracts. JSON-form YAML needs no third-party parser."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ".github/workflows/checks.yml"
CHECKS = ("python3 scripts/check.py",)


def version(text):
    return tuple(int(part) for part in text.split("."))


class Workflows(unittest.TestCase):
    def test_no_development_workflows(self):
        self.assertFalse((ROOT / ".gitea").exists())

    def load(self):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                self.assertNotIn(key, result)
                result[key] = value
            return result
        # JSON is a strict subset of YAML 1.2. Refuse duplicate keys too.
        return json.loads((ROOT / WORKFLOW).read_text(), object_pairs_hook=unique)

    def test_yaml_and_repository_commands(self):
        workflow = self.load()
        self.assertIn("on", workflow)
        self.assertEqual(workflow["env"], {"PYTHONDONTWRITEBYTECODE": "1"})
        for job in workflow["jobs"].values():
            for dependency in job.get("needs", []):
                self.assertIn(dependency, workflow["jobs"])
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"@[0-9a-f]{40}$")
                if "run" not in step:
                    continue
                command = step["run"]
                self.assertIn(command, CHECKS)
                self.assertTrue((ROOT / command.split()[1]).is_file())
                self.assertNotIn("publish_portable", command)
                self.assertNotIn("pi ", command)

    def test_offline_workflows_no_secrets(self):
        workflow = self.load()
        self.assertEqual(workflow["on"], {"push": {}, "pull_request": {}})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(workflow["jobs"]), {"offline"})
        text = json.dumps(workflow)
        self.assertNotIn("secrets.", text)
        self.assertNotIn("TOKEN", text)
        self.assertNotIn("npm", text)
        # Expressions read only the fixed matrix, never event data such as a branch name.
        for expression in re.findall(r"\$\{\{(.*?)\}\}", text):
            self.assertRegex(expression, r"^\s*matrix\.[a-z]+\s*$")
        steps = workflow["jobs"]["offline"]["steps"]
        self.assertEqual([s["run"] for s in steps if "run" in s], list(CHECKS))
        self.assertIs(steps[0]["with"]["persist-credentials"], False)

    def test_matrix_runs_linux_floor_and_macos(self):
        job = self.load()["jobs"]["offline"]
        manifest = json.loads((ROOT / "config/manifest.json").read_text())
        floor = manifest["runtime"]["pythonRange"].removeprefix(">=")
        self.assertIs(job["strategy"]["fail-fast"], False)
        entries = {entry["os"]: entry["python"] for entry in job["strategy"]["matrix"]["include"]}
        self.assertEqual(entries.get("ubuntu-latest"), floor)
        macos = [name for name in entries if name.startswith("macos-")]
        self.assertEqual(len(macos), 1)
        self.assertGreaterEqual(version(entries[macos[0]]), version(floor))
        self.assertEqual(job["runs-on"], "${{ matrix.os }}")
        setup = [step for step in job["steps"]
                 if step.get("uses", "").startswith("actions/setup-python@")]
        self.assertEqual([step["with"] for step in setup], [{"python-version": "${{ matrix.python }}"}])


if __name__ == "__main__":
    unittest.main()
