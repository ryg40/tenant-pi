"""Offline workflow contracts. JSON-form YAML needs no third-party parser."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ".github/workflows/checks.yml"
CHECKS = ("python3 scripts/check.py",)


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
        self.assertEqual(workflow["jobs"]["offline"]["runs-on"], "ubuntu-latest")
        text = json.dumps(workflow)
        self.assertNotIn("secrets.", text)
        self.assertNotIn("TOKEN", text)
        self.assertNotIn("npm", text)
        steps = workflow["jobs"]["offline"]["steps"]
        self.assertEqual([s["run"] for s in steps if "run" in s], list(CHECKS))
        self.assertFalse(steps[0]["with"]["persist-credentials"])

    def test_python_setup_matches_runner_platform(self):
        steps = self.load()["jobs"]["offline"]["steps"]
        self.assertEqual(steps[1], {
            "uses": "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065",
            "with": {"python-version": "3.11"},
        })


if __name__ == "__main__":
    unittest.main()
