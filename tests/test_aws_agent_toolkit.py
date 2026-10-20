"""The JSON examples of the AWS Agent Toolkit guide pass the kit validators. No path is opened, no network."""
import copy
import json
import re
import unittest

from scripts.validate import ROOT, load, manifest, overlay
from scripts.workflow_modules import ADAPTER_SETTINGS, MCP_CONFIG, render_mcp, validate_mcp

GUIDE = ROOT / "docs/guides/aws-agent-toolkit.md"
JSON_BLOCK = re.compile(r"^[ \t]*```json\n(.*?)^[ \t]*```", re.M | re.S)


def examples():
    """The fenced `json` blocks of the guide, keyed by their single top-level key."""
    blocks = [json.loads(block) for block in JSON_BLOCK.findall(GUIDE.read_text(encoding="utf-8"))]
    return {next(iter(block)): block for block in blocks if len(block) == 1}


class AwsAgentToolkitGuideTests(unittest.TestCase):
    def setUp(self):
        self.components = manifest(load(ROOT / "config/manifest.json"))
        self.examples = examples()

    def test_owner_resources_example_passes_the_overlay_validator(self):
        data = load(ROOT / "config/config.example.json")
        data["ownerResources"] = copy.deepcopy(self.examples["ownerResources"]["ownerResources"])
        overlay(data, self.components)
        (path,) = data["ownerResources"]["skills"]
        self.assertTrue(path.endswith("/agent-toolkit-for-aws/plugins/aws-core/skills"))

    def test_mcp_example_passes_and_renders_without_a_credential(self):
        definitions = self.examples["mcpServers"]
        self.assertEqual(["aws-mcp"], validate_mcp(definitions))
        rendered = render_mcp(definitions, self.components)
        content = rendered["files"][MCP_CONFIG]
        self.assertEqual({"url": "https://aws-mcp.us-east-1.api.aws/mcp", "lifecycle": "lazy"},
                         content["mcpServers"]["aws-mcp"])
        self.assertEqual(ADAPTER_SETTINGS, content["settings"])
        self.assertEqual({"transport": "http", "disabled": False, "lifecycle": "lazy", "startupConnection": False},
                         rendered["activation"]["servers"]["aws-mcp"])
        self.assertNotIn("env_reference_not_checked", {gap["code"] for gap in rendered["gaps"]})


if __name__ == "__main__":
    unittest.main()
