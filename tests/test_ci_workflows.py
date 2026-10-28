"""Offline workflow contracts. JSON-form YAML needs no third-party parser."""
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ".github/workflows/checks.yml"
# The command of the check of everything; a job ends with it.
CHECK = "python3 scripts/check.py --all"


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
                self.assertNotIn("publish_portable", step.get("run", ""))
        # The local check and CI run the same command. A job that a downstream repository adds can run other steps.
        self.assertIn(CHECK, [step.get("run") for job in workflow["jobs"].values() for step in job["steps"]])

    def test_offline_workflows_no_secrets(self):
        workflow = self.load()
        self.assertEqual(workflow["on"], {"push": {}, "pull_request": {}})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        text = json.dumps(workflow)
        self.assertNotIn("secrets.", text)
        self.assertNotIn("TOKEN", text)
        # Expressions read only the fixed matrix, never event data such as a branch name.
        for expression in re.findall(r"\$\{\{(.*?)\}\}", text):
            self.assertRegex(expression, r"^\s*matrix\.[a-z]+\s*$")
        for job in workflow["jobs"].values():
            checkout = [step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@")]
            self.assertEqual([False], [step["with"]["persist-credentials"] for step in checkout])

    def test_the_pi_version_comes_from_the_manifest(self):
        manifest = json.loads((ROOT / "config/manifest.json").read_text())
        self.assertNotIn(manifest["runtime"]["piVersion"], (ROOT / WORKFLOW).read_text())

    def test_betterleaks_installs_at_the_pin_before_the_check(self):
        # Without the binary the scan part says "skipped" and CI still passes.
        pin = re.search(r"^BETTERLEAKS_VERSION=(\S+)$", (ROOT / "scripts/scan.sh").read_text(), re.M).group(1)
        sums = re.findall(r"^\| `betterleaks_[\d.]+_(?:linux_x64|darwin_arm64)\.tar\.gz` \| `([0-9a-f]{64})` \|$",
                          (ROOT / "docs/secret-handling.md").read_text(), re.M)
        self.assertEqual(len(sums), 2)
        for job in self.load()["jobs"].values():
            runs = [step.get("run", "") for step in job["steps"]]
            install = [index for index, run in enumerate(runs) if "betterleaks" in run]
            self.assertEqual(len(install), 1)
            self.assertLess(install[0], runs.index(CHECK))
            self.assertEqual(re.findall(r"^version=(\S+)$", runs[install[0]], re.M), [pin])
            for value in sums:
                self.assertIn(value, runs[install[0]])

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
