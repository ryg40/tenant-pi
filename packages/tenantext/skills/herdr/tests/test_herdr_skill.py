"""Unit tests for names, labels and launch arguments. No Herdr server is needed.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
os.environ["HERDR_SKILL_STATE_DIR"] = tempfile.mkdtemp(prefix="herdr-skill-test-")

import _common  # noqa: E402

spec = importlib.util.spec_from_file_location("spawn", os.path.join(SKILL, "scripts", "spawn.py"))
spawn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawn)

CFG = json.load(open(os.path.join(SKILL, "roles.json"), encoding="utf-8"))


def opts(**kw):
    base = {"harness": "pi", "role": "scout", "model": None, "thinking": None, "interactive": False,
            "strict": False}
    base.update(kw)
    return base


class Names(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(_common.project_slug("Example-Workspace-2026"), "example-workspace-2026")
        self.assertEqual(_common.project_slug("My Project!"), "my-project")
        self.assertEqual(_common.project_slug("9lives"), "w9lives")
        self.assertEqual(_common.project_slug(""), "ws")

    def test_name_is_valid_for_each_role(self):
        for role in _common.ROLES:
            name = _common.make_name("Example-Workspace-2026", role, [])
            self.assertRegex(name, r"^[a-z][a-z0-9_-]{0,31}$")
            self.assertTrue(name.endswith(f"-{role}-1"), name)

    def test_project_part_is_the_same_for_each_role(self):
        names = [_common.make_name("Example-Workspace-2026", role, []) for role in _common.ROLES]
        self.assertEqual({n.rsplit("-", 2)[0] for n in names}, {"example-workspace"})

    def test_number_is_highest_live_plus_one(self):
        live = [{"name": "proj-scout-1"}, {"name": "proj-scout-4"}, {"name": "proj-worker-9"}, {"name": None}]
        self.assertEqual(_common.make_name("proj", "scout", live), "proj-scout-5")
        self.assertEqual(_common.make_name("proj", "reviewer", live), "proj-reviewer-1")

    def test_pane_label_starts_with_the_name(self):
        label = _common.pane_label("proj-scout-2", "pi", "example-provider/example-group/example-model", "medium")
        self.assertEqual(label, "proj-scout-2 pi:example-model/medium")
        self.assertEqual(_common.pane_label("proj-scout-2", "claude"), "proj-scout-2 claude")
        self.assertEqual(label.split()[0], "proj-scout-2")

    def test_role_tabs_match_the_role_table(self):
        self.assertEqual(sorted(_common.ROLES), sorted(CFG["roles"]))
        self.assertEqual(_common.ROLES[0], "coordinator")


class Launch(unittest.TestCase):
    def test_no_model_is_stored_in_the_role_table(self):
        text = json.dumps(CFG["roles"])
        for word in ("model", "thinking", "opus", "sonnet"):
            self.assertNotIn(word, text)

    def test_model_and_thinking_are_optional(self):
        r = spawn.resolve(opts(), CFG)
        self.assertIsNone(r["model"])
        self.assertIsNone(r["thinking"])
        args = spawn.native_args(r, CFG, False, "t-scout-1", write=False)
        self.assertNotIn("--model", args)
        self.assertNotIn("--thinking", args)

    def test_coordinator_is_primary_and_has_no_contract(self):
        r = spawn.resolve(opts(harness="claude", role="coordinator", model="claude-opus-5-5", thinking="medium"), CFG)
        self.assertEqual(r["session"], "primary")
        self.assertNotIn("FINAL_COMPRESSED_CONTEXT", spawn.system_prompt(r, CFG))
        args = spawn.native_args(r, CFG, False, "t-coordinator-2", write=False)
        self.assertEqual(args[:4], ["--model", "claude-opus-5-5", "--effort", "medium"])

    def test_subagent_has_the_contract_and_interactive_has_not(self):
        r = spawn.resolve(opts(harness="claude", role="reviewer"), CFG)
        self.assertIn("FINAL_COMPRESSED_CONTEXT", spawn.system_prompt(r, CFG))
        r = spawn.resolve(opts(harness="claude", role="worker", interactive=True), CFG)
        self.assertNotIn("FINAL_COMPRESSED_CONTEXT", spawn.system_prompt(r, CFG))

    def test_default_launch_removes_no_tool(self):
        for harness in ("pi", "claude"):
            for role in _common.ROLES:
                r = spawn.resolve(opts(harness=harness, role=role), CFG)
                args = spawn.native_args(r, CFG, False, f"t-{role}-1", write=False)
                for flag in ("--exclude-tools", "--disallowedTools", "--no-skills", "--strict-mcp-config"):
                    self.assertNotIn(flag, args, (harness, role))

    def test_each_claude_session_starts_in_auto_mode(self):
        for role in _common.ROLES:
            for extra in ({}, {"strict": True}, {"interactive": True}):
                r = spawn.resolve(opts(harness="claude", role=role, **extra), CFG)
                args = spawn.native_args(r, CFG, role == "worker", f"t-{role}-1", write=False)
                self.assertEqual(args[args.index("--permission-mode") + 1], "auto", (role, extra))
                self.assertEqual(args.count("--permission-mode"), 1)
            r = spawn.resolve(opts(harness="pi", role=role), CFG)
            self.assertNotIn("--permission-mode", spawn.native_args(r, CFG, False, f"t-{role}-1", write=False))

    def test_strict_read_roles_cannot_edit(self):
        r = spawn.resolve(opts(harness="claude", role="scout", strict=True), CFG)
        args = spawn.native_args(r, CFG, False, "t-scout-1", write=False)
        self.assertIn("Edit Write NotebookEdit", args[args.index("--disallowedTools") + 1])
        r = spawn.resolve(opts(harness="pi", role="reviewer", strict=True), CFG)
        args = spawn.native_args(r, CFG, False, "t-reviewer-1", write=False)
        self.assertEqual(args[args.index("--exclude-tools") + 1], "edit,write")
        self.assertIn("Strict launch", spawn.system_prompt(r, CFG))

    def test_claude_researcher_gets_hound_in_addition(self):
        r = spawn.resolve(opts(harness="claude", role="researcher"), CFG)
        args = spawn.native_args(r, CFG, False, "t-researcher-1", write=False)
        self.assertTrue(args[args.index("--mcp-config") + 1].endswith("mcp/hound.claude.json"))
        self.assertIn("mcp__hound", args[args.index("--allowedTools") + 1])

    def test_pi_researcher_keeps_the_mcp_servers_of_the_user(self):
        r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
        self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-researcher-1", write=False))

    def test_researcher_prompt_is_an_order_of_preference(self):
        r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
        text = spawn.system_prompt(r, CFG)
        self.assertNotRegex(text, r"\{[a-z_:]+\}")
        self.assertIn("The task has priority", text)
        self.assertIn("go to the next one", text)
        self.assertIn("**Report.**", text)
        self.assertIn("resources.py", text)
        for banned in ("Hound MCP only", "do not change to another search tool", "Do not change to another"):
            self.assertNotIn(banned, text)

    def test_scout_and_researcher_are_both_context_gatherers(self):
        prompts = {}
        for role in ("researcher", "scout"):
            r = spawn.resolve(opts(harness="claude", role=role), CFG)
            self.assertTrue(r["web"], role)
            args = spawn.native_args(r, CFG, False, f"t-{role}-1", write=False)
            self.assertIn("mcp__hound", args[args.index("--allowedTools") + 1])
            prompts[role] = spawn.system_prompt(r, CFG)
            self.assertIn("context gatherer", prompts[role])
            self.assertIn("Hound MCP", prompts[role])
            self.assertIn("`rg`", prompts[role])
            self.assertNotRegex(prompts[role], r"\{[a-z_:]+\}")
        self.assertLess(prompts["researcher"].index("## Web,"), prompts["researcher"].index("## Local,"))
        self.assertLess(prompts["scout"].index("## Local,"), prompts["scout"].index("## Web,"))
        self.assertIn("permission to read a repository on the web", prompts["scout"])

    def test_an_entry_that_is_not_on_the_machine_is_left_out(self):
        resources = {
            "a": {"group": "web", "order": 1, "title": "A", "use_when": "first", "load": "a",
                  "locations": [{"file": "/nonexistent/herdr-skill-test"}]},
            "b": {"group": "web", "order": 2, "title": "B", "use_when": "second", "load": "b"}}
        lines, absent = _common.catalog_lines(resources, "web")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("1. **B**"))
        self.assertEqual(absent, ["A"])

    def test_the_first_location_that_is_present_is_used(self):
        here = os.path.abspath(__file__)
        entry = {"locations": [{"file": "/nonexistent/herdr-skill-test"}, {"file": here}, {"file": SKILL + "/SKILL.md"}]}
        self.assertEqual(_common.resolve_resource(entry), (here, True))
        self.assertEqual(_common.resolve_resource({}), (None, None))

    def test_the_machine_file_adds_replaces_and_removes(self):
        path = os.path.join(tempfile.mkdtemp(), "resources.json")
        with open(path, "w") as f:
            json.dump({"resources": {"hound": {"remove": True},
                                     "desktop-browser": {"group": "web", "order": 5, "title": "Mine"},
                                     "extra": {"group": "local", "order": 1, "title": "Extra"}}}, f)
        merged = _common.load_catalog(path)
        self.assertNotIn("hound", merged)
        self.assertEqual(merged["desktop-browser"]["title"], "Mine")
        self.assertIn("extra", merged)
        self.assertIn("local-search", merged)
        self.assertIn("hound", _common.load_catalog("/nonexistent/herdr-skill-test.json"))

    def test_the_catalog_names_no_host(self):
        text = open(os.path.join(SKILL, "resources.json"), encoding="utf-8").read()
        for entry in json.loads(text)["resources"].values():
            for location in entry.get("locations", []):
                if "file" in location:
                    self.assertTrue(location["file"].startswith("~/"), location)
                if "url" in location:
                    self.assertRegex(location["url"], r"^http://(127\.0\.0\.1|localhost)[:/]")
        self.assertNotIn("ssh ", text.lower())

    def test_each_role_prompt_gives_the_task_priority(self):
        for role in ("researcher", "scout", "worker", "reviewer"):
            r = spawn.resolve(opts(harness="pi", role=role), CFG)
            self.assertIn("The task has priority", spawn.system_prompt(r, CFG))

    def test_strict_subagent_can_load_the_skill(self):
        r = spawn.resolve(opts(harness="pi", role="scout", strict=True), CFG)
        args = spawn.native_args(r, CFG, False, "t-scout-1", write=False)
        self.assertEqual(args[args.index("--skill") + 1], SKILL)

    def test_claude_thinking_minimum_is_low(self):
        r = spawn.resolve(opts(harness="claude", role="worker", thinking="off"), CFG)
        self.assertEqual(r["thinking"], "low")

    def test_no_argument_has_a_line_break(self):
        # Herdr refuses agent arguments with line breaks.
        for harness in ("pi", "claude"):
            for role in _common.ROLES:
                r = spawn.resolve(opts(harness=harness, role=role), CFG)
                for a in spawn.native_args(r, CFG, False, f"t-{role}-1", write=False):
                    self.assertNotIn("\n", a)


if __name__ == "__main__":
    unittest.main()
