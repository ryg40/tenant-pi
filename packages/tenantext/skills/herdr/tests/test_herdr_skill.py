"""Unit tests for names, labels and launch arguments. No Herdr server is needed.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
os.environ["HERDR_SKILL_STATE_DIR"] = tempfile.mkdtemp(prefix="herdr-skill-test-")
# The tests read the shipped catalog only, not the machine file of the machine that runs them.
os.environ["HERDR_SKILL_RESOURCES"] = os.path.join(os.environ["HERDR_SKILL_STATE_DIR"], "no-machine-file.json")

import _common  # noqa: E402

spec = importlib.util.spec_from_file_location("spawn", os.path.join(SKILL, "scripts", "spawn.py"))
spawn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spawn)

spec = importlib.util.spec_from_file_location("ask", os.path.join(SKILL, "scripts", "ask.py"))
ask = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask)

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


class IsolatedConfig(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="herdr-models-test-")
        self.addCleanup(temp.cleanup)
        env = mock.patch.dict(os.environ, {"HOME": temp.name, "XDG_CONFIG_HOME": os.path.join(temp.name, "config")})
        env.start()
        self.addCleanup(env.stop)
        self.models_path = os.path.join(temp.name, "config", "herdr-skill", "models.json")

    def write_models(self, data):
        os.makedirs(os.path.dirname(self.models_path), exist_ok=True)
        with open(self.models_path, "w", encoding="utf-8") as f:
            json.dump(data, f)


class ModelDefaults(IsolatedConfig):
    def test_missing_file_uses_harness_default(self):
        for harness in ("pi", "claude"):
            r = spawn.resolve(opts(harness=harness), CFG)
            self.assertIsNone(r["model"])
            self.assertIsNone(r["thinking"])
            self.assertEqual(spawn.model_message(r), "model: harness default")

    def test_one_role_selects_the_launch_harness(self):
        self.write_models({"roles": {"scout": {
            "pi": {"model": "example/model", "thinking": "high"},
            "claude": {"model": "example-alias", "thinking": "medium"}}}})
        with mock.patch.object(spawn, "resolve_pi_model", return_value="example/model") as resolve:
            r = spawn.resolve(opts(), CFG)
            resolve.assert_called_once_with("example/model")
        self.assertEqual(r["thinking"], "high")
        self.assertEqual(spawn.model_message(r), "model: example/model (from models.json)")
        self.assertEqual(spawn.native_args(r, CFG, False, "t-scout-1", write=False)[:6],
                         ["--provider", "example", "--model", "model", "--thinking", "high"])
        r = spawn.resolve(opts(harness="claude"), CFG)
        self.assertEqual((r["model"], r["thinking"]), ("example-alias", "medium"))
        self.assertEqual(spawn.native_args(r, CFG, False, "t-scout-1", write=False)[:4],
                         ["--model", "example-alias", "--effort", "medium"])
        self.assertIsNone(spawn.resolve(opts(role="worker"), CFG)["model"])

    def test_each_key_is_optional(self):
        for data in ({}, {"roles": {}}, {"roles": {"scout": {}}}, {"roles": {"scout": {"pi": {}}}},
                     {"roles": {"scout": {"claude": {"model": "example-alias"}}}}):
            with self.subTest(data=data):
                self.write_models(data)
                self.assertIsNone(spawn.resolve(opts(), CFG)["model"])
        self.write_models({"roles": {"scout": {"pi": {"thinking": "high"}}}})
        r = spawn.resolve(opts(), CFG)
        self.assertIsNone(r["model"])
        self.assertEqual(r["thinking"], "high")

    def test_request_model_skips_file_and_its_thinking(self):
        self.write_models({"roles": {"scout": {"claude": {"model": "file-alias", "thinking": "high"}}}})
        r = spawn.resolve(opts(harness="claude", model="request-alias"), CFG)
        self.assertEqual(r["model"], "request-alias")
        self.assertIsNone(r["thinking"])
        self.assertEqual(spawn.model_message(r), "model: request-alias (from request)")
        self.write_models(["bad shape"])
        with mock.patch.object(spawn, "resolve_pi_model", return_value="example/request") as resolve:
            r = spawn.resolve(opts(model="request", thinking="medium"), CFG)
            resolve.assert_called_once_with("request")
        self.assertEqual((r["model"], r["thinking"]), ("example/request", "medium"))

    def test_request_thinking_wins_and_claude_minimum_is_applied(self):
        self.write_models({"roles": {"scout": {"claude": {"model": "example-alias", "thinking": "off"}}}})
        self.assertEqual(spawn.resolve(opts(harness="claude"), CFG)["thinking"], "low")
        self.assertEqual(spawn.resolve(opts(harness="claude", thinking="high"), CFG)["thinking"], "high")

    def test_home_fallback_and_xdg_precedence(self):
        home_path = os.path.join(os.environ["HOME"], ".config", "herdr-skill", "models.json")
        os.makedirs(os.path.dirname(home_path))
        with open(home_path, "w", encoding="utf-8") as f:
            json.dump({"roles": {"scout": {"claude": {"model": "home-alias"}}}}, f)
        self.assertIsNone(spawn.resolve(opts(harness="claude"), CFG)["model"])
        for value in (None, ""):
            with mock.patch.dict(os.environ):
                if value is None:
                    os.environ.pop("XDG_CONFIG_HOME")
                else:
                    os.environ["XDG_CONFIG_HOME"] = value
                self.assertEqual(spawn.resolve(opts(harness="claude"), CFG)["model"], "home-alias")

    def test_bad_shape_has_path_and_reason(self):
        bad = [(None, "root must be an object"), ({"models": {}}, "root has unknown keys"),
               ({"roles": []}, "roles must be an object"),
               ({"roles": {"unknown": {}}}, "roles has unknown keys"),
               ({"roles": {"scout": []}}, "roles.scout must be an object"),
               ({"roles": {"scout": {"unknown": {}}}}, "roles.scout has unknown keys"),
               ({"roles": {"scout": {"pi": None}}}, "roles.scout.pi must be an object")]
        for entry, reason in (({"extra": True}, "has unknown keys"), ({"model": 3}, "nonempty string"),
                              ({"model": " "}, "nonempty string"), ({"model": "a\nb"}, "line breaks"),
                              ({"thinking": "invalid"}, "thinking must be one of")):
            bad.append(({"roles": {"scout": {"pi": entry}}}, reason))
        for data, reason in bad:
            with self.subTest(data=data):
                self.write_models(data)
                err = io.StringIO()
                with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as exc:
                    spawn.resolve(opts(harness="claude", role="worker"), CFG)
                self.assertEqual(exc.exception.code, 2)
                self.assertIn(self.models_path, err.getvalue())
                self.assertIn(reason, err.getvalue())

    def test_malformed_json_and_encoding_have_path_and_reason(self):
        self.write_models({})
        for content in (b"{", b"\xff"):
            with open(self.models_path, "wb") as f:
                f.write(content)
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as exc:
                spawn.resolve(opts(), CFG)
            self.assertEqual(exc.exception.code, 2)
            self.assertIn(self.models_path + ": ", err.getvalue())
            self.assertGreater(len(err.getvalue().split(self.models_path + ": ")[1].strip()), 0)

    def test_dry_run_keeps_stdout_json_and_reports_model_source(self):
        self.write_models({"roles": {"scout": {"claude": {"model": "example-alias"}}}})
        out, err = io.StringIO(), io.StringIO()
        me = {"workspace": "proj", "workspace_id": "w1", "tab_id": "t1", "pane_id": "p1"}
        with mock.patch.multiple(spawn, require_herdr_env=lambda: None,
                                 ensure_layout_readonly=lambda: me, live_agents=lambda: []), \
                mock.patch.object(sys, "argv", ["spawn.py", "--harness", "claude", "--role", "scout", "--dry-run"]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            spawn.main()
        self.assertEqual(json.loads(out.getvalue())["model_source"], "models.json")
        self.assertEqual(err.getvalue().strip(), "model: example-alias (from models.json)")


class Launch(IsolatedConfig):
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

    def test_the_shipped_catalog_gives_no_mcp_server(self):
        self.assertEqual(_common.mcp_servers(_common.load_catalog()), {})
        self.assertEqual(_common.load_launch(CFG), {})
        for role in ("researcher", "scout"):
            r = spawn.resolve(opts(harness="claude", role=role), CFG)
            args = spawn.native_args(r, CFG, False, f"t-{role}-1", write=False)
            self.assertNotIn("--mcp-config", args)
            self.assertNotIn("mcp__", args[args.index("--allowedTools") + 1])
            self.assertNotIn("DonSeTch", spawn.system_prompt(r, CFG))
            r = spawn.resolve(opts(harness="pi", role=role, strict=True), CFG)
            self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, f"t-{role}-1", write=False))

    def test_strict_claude_with_no_mcp_entry_gets_an_empty_mcp_configuration(self):
        r = spawn.resolve(opts(harness="claude", role="researcher", strict=True), CFG)
        args = spawn.native_args(r, CFG, False, "t-researcher-1", write=True)
        self.assertIn("--strict-mcp-config", args)
        self.assertEqual(json.load(open(args[args.index("--mcp-config") + 1])), {"mcpServers": {}})
        self.assertNotIn("mcp__", args[args.index("--allowedTools") + 1])

    def test_the_machine_file_gives_the_mcp_servers_and_their_tool_names(self):
        example = os.path.join(SKILL, "resources.local.example.json")
        with mock.patch.object(_common, "MACHINE_CATALOG", example):
            r = spawn.resolve(opts(harness="claude", role="researcher"), CFG)
            args = spawn.native_args(r, CFG, False, "t-researcher-1", write=True)
            config = json.load(open(args[args.index("--mcp-config") + 1]))
            helper = os.path.expanduser("~/.agents/skills/herdr/scripts/mcp-bearer-helper.sh DONSETCH_HTTP_TOKEN")
            self.assertEqual(config, {"mcpServers": {"donsetch": {
                "type": "http", "url": "http://127.0.0.1:8766/mcp", "headersHelper": helper}}})
            self.assertNotIn("test-token-value", json.dumps(config))
            self.assertIn("mcp__donsetch", args[args.index("--allowedTools") + 1].split())
            self.assertNotIn("--strict-mcp-config", args)
            r = spawn.resolve(opts(harness="claude", role="worker"), CFG)
            self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-worker-1", write=False))
            r = spawn.resolve(opts(harness="pi", role="researcher", strict=True), CFG)
            args = spawn.native_args(r, CFG, False, "t-researcher-1", write=False)
            self.assertEqual(args[args.index("--mcp-config") + 1], os.path.expanduser("~/.pi/agent/mcp-researcher.json"))
            r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
            self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-researcher-1", write=False))

    def test_headers_helper_is_optional_and_expands_home(self):
        resources = {
            "plain": {"group": "web", "kind": "mcp", "locations": [{"url": "http://localhost/plain"}]},
            "auth": {"group": "web", "kind": "mcp", "headers_helper": "~/helper.sh TOKEN",
                     "locations": [{"url": "http://localhost/auth"}]}}
        with mock.patch.dict(os.environ, {"HOME": "/tmp/herdr-home"}), \
                mock.patch.object(spawn, "load_catalog", return_value=resources):
            args = spawn.native_args(spawn.resolve(opts(harness="claude", role="researcher"), CFG), CFG,
                                     False, "t-researcher-1", write=True)
        config_path = args[args.index("--mcp-config") + 1]
        config = json.load(open(config_path, encoding="utf-8"))
        self.assertNotIn("headersHelper", config["mcpServers"]["plain"])
        self.assertEqual(config["mcpServers"]["auth"]["headersHelper"], "/tmp/herdr-home/helper.sh TOKEN")

    def test_bearer_helper_fails_closed_and_emits_json_header(self):
        helper = os.path.join(SKILL, "scripts", "mcp-bearer-helper.sh")
        env = os.environ.copy()
        env.pop("DONSETCH_HTTP_TOKEN", None)
        missing = subprocess.run([helper, "DONSETCH_HTTP_TOKEN"], capture_output=True, text=True, env=env)
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stdout, "")
        self.assertEqual(len(missing.stderr.strip().splitlines()), 1)
        env["DONSETCH_HTTP_TOKEN"] = "test-token-value"
        present = subprocess.run([helper, "DONSETCH_HTTP_TOKEN"], capture_output=True, text=True, env=env)
        self.assertEqual(present.returncode, 0, present.stderr)
        self.assertEqual(json.loads(present.stdout), {"Authorization": "Bearer test-token-value"})

    def test_the_server_name_of_an_mcp_entry(self):
        resources = {
            "b": {"group": "web", "order": 2, "kind": "mcp", "mcp_server": "search_two", "locations": [{"url": "http://localhost:2/mcp"}]},
            "a": {"group": "web", "order": 1, "kind": "mcp", "locations": [{"file": "~/x"}, {"url": "http://localhost:1/mcp"}]},
            "no-url": {"group": "web", "kind": "mcp", "locations": [{"command": "x"}]},
            "bad name": {"group": "web", "kind": "mcp", "locations": [{"url": "http://localhost:3/mcp"}]},
            "skill": {"group": "web", "kind": "skill", "locations": [{"url": "http://localhost:4/"}]},
            "local": {"group": "local", "kind": "mcp", "locations": [{"url": "http://localhost:5/mcp"}]}}
        self.assertEqual(list(_common.mcp_servers(resources).items()),
                         [("a", {"url": "http://localhost:1/mcp"}),
                          ("search_two", {"url": "http://localhost:2/mcp"})])

    def test_pi_researcher_keeps_the_mcp_servers_of_the_user(self):
        r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
        self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-researcher-1", write=False))

    def test_researcher_prompt_is_an_order_of_preference(self):
        r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
        text = spawn.system_prompt(r, CFG)
        self.assertNotRegex(text, r"\{[a-z_:]+\}")
        self.assertIn("The task has priority", text)
        self.assertIn("go to the next one", text)
        self.assertNotIn("**Report.**", text)
        self.assertIn("resources.py", text)
        for banned in ("DonSeTch MCP only", "do not change to another search tool", "Do not change to another"):
            self.assertNotIn(banned, text)

    def test_scout_and_researcher_are_both_context_gatherers(self):
        prompts = {}
        for role in ("researcher", "scout"):
            r = spawn.resolve(opts(harness="claude", role=role), CFG)
            self.assertTrue(r["web"], role)
            args = spawn.native_args(r, CFG, False, f"t-{role}-1", write=False)
            prompts[role] = spawn.system_prompt(r, CFG)
            self.assertIn("context gatherer", prompts[role])
            self.assertIn("Web tools of your harness" if role == "researcher" else "`rg`", prompts[role])
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
            json.dump({"resources": {"local-services": {"remove": True},
                                     "harness-web": {"group": "web", "order": 5, "title": "Mine"},
                                     "extra": {"group": "local", "order": 1, "title": "Extra"}},
                       "launch": {"pi_mcp_config_strict": "~/mine.json"}}, f)
        merged = _common.load_catalog(path)
        self.assertNotIn("local-services", merged)
        self.assertEqual(merged["harness-web"]["title"], "Mine")
        self.assertIn("extra", merged)
        self.assertIn("local-search", merged)
        self.assertIn("local-services", _common.load_catalog("/nonexistent/herdr-skill-test.json"))
        self.assertEqual(_common.load_launch(CFG, path), {"pi_mcp_config_strict": os.path.expanduser("~/mine.json")})

    def test_the_shipped_catalog_holds_no_machine_entry(self):
        shipped = _common.load_catalog("/nonexistent/herdr-skill-test.json")
        self.assertEqual(sorted(rid for rid, e in shipped.items() if e.get("group") == "web"), ["harness-web"])
        for entry in shipped.values():
            self.assertNotEqual(entry.get("kind"), "mcp")
            self.assertFalse(entry.get("locations"))
        example = json.load(open(os.path.join(SKILL, "resources.local.example.json"), encoding="utf-8"))
        self.assertEqual(sorted(example["resources"]), ["desktop-browser", "donsetch"])

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


API_ERROR = "Please run /login · API Error: 403 Access to this model requires an access grant."


def entry(role, text, **extra):
    return dict({"type": role, "message": {"role": role, "content": [{"type": "text", "text": text}]}}, **extra)


def run_ask(path, status="idle"):
    """Run ask.main() against a transcript that gets its new lines while the prompt runs."""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines[:2])
    info = {"pane_id": "p-2", "agent": "claude", "agent_status": status, "cwd": "/tmp",
            "agent_session": {"kind": "path", "value": path}}

    def herdr(*args, **kw):
        if args[:2] == ("agent", "prompt"):
            with open(path, "w", encoding="utf-8") as f:
                f.writelines(lines)
        return 0, {}, ""

    out = io.StringIO()
    with mock.patch.multiple(ask, require_herdr_env=lambda: None, ensure_layout=lambda quiet: None,
                             agent_info=lambda target: info, herdr=herdr), \
            mock.patch.object(ask.time, "sleep", lambda s: None), \
            mock.patch.object(sys, "argv", ["ask.py", "proj-worker-1", "--text", "do the task"]), \
            mock.patch.dict(os.environ, {"HERDR_PANE_ID": "p-1"}), contextlib.redirect_stdout(out):
        try:
            ask.main()
            code = 0
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue()


class ApiErrorFallback(unittest.TestCase):
    def transcript(self, *entries):
        tmp = tempfile.TemporaryDirectory(prefix="herdr-skill-test-")
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, "session.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        return path

    def test_api_error_lines_are_recognised(self):
        self.assertTrue(ask.is_api_error(API_ERROR))
        self.assertTrue(ask.is_api_error("API Error: 500 Internal server error"))
        self.assertFalse(ask.is_api_error("The call returns `API Error: 403` on the second try."))
        self.assertFalse(ask.is_api_error("FINAL_COMPRESSED_CONTEXT\nStatus: complete"))

    def test_a_normal_reply_is_printed_without_a_note(self):
        code, out = run_ask(self.transcript(entry("user", "earlier task"), entry("assistant", "earlier reply"),
                                       entry("user", "do the task"), entry("assistant", "Status: complete")))
        self.assertEqual(code, 0)
        self.assertNotIn("note:", out)
        self.assertTrue(out.endswith("--- reply ---\nStatus: complete\n"), out)

    def test_an_api_error_reply_falls_back_to_the_text_after_the_prompt(self):
        code, out = run_ask(self.transcript(
            entry("user", "earlier task"), entry("assistant", "earlier reply"),
            entry("user", "do the task"),
            entry("assistant", "The checks pass. I commit now."),
            entry("assistant", "side text of another agent", isSidechain=True),
            entry("assistant", API_ERROR, isApiErrorMessage=True),
            entry("assistant", API_ERROR, isApiErrorMessage=True)))
        self.assertEqual(code, 0)
        head, reply = out.split("--- reply ---\n")
        self.assertEqual(reply, "The checks pass. I commit now.\n")
        self.assertNotIn("earlier reply", out)
        note = head.splitlines()[-1]
        self.assertTrue(note.startswith("note: reply was an API error (Please run /login"), note)
        self.assertTrue(note.endswith("text below is the last assistant message of the transcript"), note)

    def test_only_an_older_text_is_printed_with_the_extended_note(self):
        code, out = run_ask(self.transcript(entry("user", "earlier task"), entry("assistant", "earlier reply"),
                                       entry("user", "do the task"), entry("assistant", API_ERROR)))
        self.assertEqual(code, 0)
        note = out.split("--- reply ---\n")[0].splitlines()[-1]
        self.assertTrue(note.startswith("note: reply was an API error (Please run /login"), note)
        self.assertTrue(note.endswith("last assistant message of the transcript; from before this prompt"), note)
        self.assertTrue(out.endswith("--- reply ---\nearlier reply\n"), out)

    def test_an_api_error_with_no_other_reply_is_an_error(self):
        code, out = run_ask(self.transcript(entry("user", "earlier task"), entry("assistant", API_ERROR),
                                       entry("user", "do the task"), entry("assistant", API_ERROR)))
        self.assertEqual(code, 6)
        self.assertNotIn("note:", out)
        self.assertIn("API ERROR:", out)
        self.assertTrue(out.endswith("--- reply ---\n" + API_ERROR + "\n"), out)


class Roles258(unittest.TestCase):
    NOTE = "note: no result block; the pane may not be done. Read the screen."
    MARKER = "Marker: SUBAGENT_COMPLETE"

    def run_reply(self, reply, record=None, api_error=False):
        path = os.path.join(tempfile.mkdtemp(prefix="herdr-roles258-"), "session.jsonl")
        entries = [entry("user", "earlier task"), entry("user", "do the task"), entry("assistant", reply)]
        if api_error:
            entries.append(entry("assistant", API_ERROR))
        with open(path, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e) + "\n")
        with mock.patch.object(ask, "read_record", return_value=record) as read_record:
            result = run_ask(path)
        read_record.assert_called_once_with("p-2")
        return result

    def test_clip_short_text_is_unchanged(self):
        for text in ("", "A short reply.\nNext line."):
            for kwargs in ({}, {"head": 0}, {"head": 2000}):
                with self.subTest(text=text, kwargs=kwargs):
                    self.assertEqual(_common.clip(text, 8000, **kwargs), text)

    def test_clip_at_the_limit_is_unchanged(self):
        text = "x" * 8000
        for kwargs in ({}, {"head": 0}, {"head": 2000}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(_common.clip(text, 8000, **kwargs), text)

    def test_clip_long_text_defaults_to_tail_only(self):
        text = "h" * 2000 + "m" * 37 + "t" * 8000
        for kwargs in ({}, {"head": 0}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(_common.clip(text, 8000, **kwargs),
                                 "[... first 2037 characters omitted ...]\n" + "t" * 8000)

    def test_clip_long_text_keeps_the_requested_head_and_tail(self):
        text = "h" * 2000 + "m" * 37 + "t" * 6000
        self.assertEqual(_common.clip(text, 8000, head=2000), "h" * 2000
                         + "\n[... 37 characters omitted ...]\n" + "t" * 6000)

    def test_clip_uses_the_requested_head_and_tail_sizes(self):
        text = "abcdefghijklmnopqrstuvwxyz"
        for limit, head, tail in ((0, "", ""), (1, "", "z"), (3, "", "xyz"),
                                  (7, "a", "uvwxyz"), (20, "abcde", "lmnopqrstuvwxyz"),
                                  (7, "abc", "wxyz"), (7, "abcdefg", "")):
            with self.subTest(limit=limit, head=head):
                notice = (f"\n[... {len(text) - limit} characters omitted ...]\n" if head else
                          f"[... first {len(text) - limit} characters omitted ...]\n")
                self.assertEqual(_common.clip(text, limit, head=len(head)), head + notice + tail)

    def test_ask_reply_keeps_the_head_including_api_error_fallback(self):
        reply = "h" * 2000 + "m" * 37 + "t" * 6000
        expected = "h" * 2000 + "\n[... 37 characters omitted ...]\n" + "t" * 6000 + "\n"
        for api_error in (False, True):
            with self.subTest(api_error=api_error):
                code, out = self.run_reply(reply, api_error=api_error)
                self.assertEqual(code, 0)
                self.assertEqual(out.split("--- reply ---\n")[1], expected)
                self.assertEqual("note: reply was an API error" in out, api_error)

    def test_ask_screen_tails_keep_only_the_tail(self):
        for status, limit, code in (("blocked", 3000, 4), ("idle", 4000, 0)):
            with self.subTest(status=status):
                screen = "h" * 2000 + "m" * 37 + "t" * limit
                info = {"pane_id": "p-2", "agent": "claude", "agent_status": status, "cwd": "/tmp"}
                out = io.StringIO()
                with mock.patch.multiple(ask, require_herdr_env=lambda: None, ensure_layout=lambda quiet: None,
                                         agent_info=lambda target: info, session_file=lambda info: None,
                                         herdr=lambda *args, **kw: (0, {}, "")), \
                        mock.patch.object(ask, "screen_tail", return_value=screen), \
                        mock.patch.object(ask.time, "sleep", lambda s: None), \
                        mock.patch.object(sys, "argv", ["ask.py", "proj-worker-1", "--text", "do the task"]), \
                        mock.patch.dict(os.environ, {"HERDR_PANE_ID": "p-1"}), \
                        contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as exc:
                    ask.main()
                self.assertEqual(exc.exception.code, code)
                self.assertEqual(out.getvalue().split("--- screen tail ---\n")[1],
                                 "[... first 2037 characters omitted ...]\n" + "t" * limit + "\n")

    def test_last_reply_keeps_the_head_only_for_transcript_text(self):
        spec = importlib.util.spec_from_file_location("last_reply", os.path.join(SKILL, "scripts", "last-reply.py"))
        last_reply = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(last_reply)
        info = {"pane_id": "p-2", "agent": "claude", "agent_status": "idle", "cwd": "/tmp"}
        for limit, args in ((8000, []), (20, ["--max-chars", "20"])):
            text = "h" * (limit // 4) + "m" * 37 + "t" * limit
            for transcript in (True, False):
                with self.subTest(limit=limit, transcript=transcript):
                    out = io.StringIO()
                    with mock.patch.multiple(last_reply, require_herdr_env=lambda: None,
                                             agent_info=lambda target: info, session_file=lambda info: "session.jsonl",
                                             assistant_texts=lambda path: [text] if transcript else [],
                                             screen_tail=lambda target, lines: text), \
                            mock.patch.object(sys, "argv", ["last-reply.py", "proj-worker-1", *args]), \
                            contextlib.redirect_stdout(out):
                        last_reply.main()
                    omitted = len(text) - limit
                    if transcript:
                        expected = ("h" * (limit // 4) + f"\n[... {omitted} characters omitted ...]\n"
                                    + "t" * (limit - limit // 4) + "\n")
                        self.assertEqual(out.getvalue().split("--- last reply ---\n")[1], expected)
                    else:
                        expected = f"[... first {omitted} characters omitted ...]\n" + "t" * limit + "\n"
                        self.assertEqual(out.getvalue().split("--- screen tail ---\n")[1], expected)

    def test_ask_defaults_to_8000_characters(self):
        _, parsed = ask.parse(["proj-worker-1", "--text", "do the task"])
        self.assertEqual(parsed["max_chars"], 8000)
        _, parsed = ask.parse(["proj-worker-1", "--text", "do the task", "--max-chars", "20"])
        self.assertEqual(parsed["max_chars"], 20)

    def test_task_reply_without_marker_gets_the_note_after_the_reply(self):
        code, out = self.run_reply("The checks pass.", {"session": "subagent"})
        self.assertEqual(code, 0)
        self.assertTrue(out.endswith("--- reply ---\nThe checks pass.\n" + self.NOTE + "\n"), out)
        self.assertEqual(out.count(self.NOTE), 1)

    def test_task_reply_with_the_contract_marker_gets_no_note(self):
        with open(os.path.join(SKILL, "roles", "contract.md"), encoding="utf-8") as f:
            self.assertIn(self.MARKER, f.read().splitlines())
        reply = "FINAL_COMPRESSED_CONTEXT\nRole: worker\nStatus: complete\n" + self.MARKER
        code, out = self.run_reply(reply, {"session": "subagent"})
        self.assertEqual(code, 0)
        self.assertNotIn(self.NOTE, out)
        self.assertTrue(out.endswith(reply + "\n"), out)

    def test_marker_must_start_a_line(self):
        for reply in ("Quoted: " + self.MARKER, "Still working.\n " + self.MARKER):
            with self.subTest(reply=reply):
                code, out = self.run_reply(reply, {"session": "subagent"})
                self.assertEqual(code, 0)
                self.assertTrue(out.endswith(self.NOTE + "\n"), out)
        code, out = self.run_reply("Done.\n" + self.MARKER + " extra text", {"session": "subagent"})
        self.assertEqual(code, 0)
        self.assertNotIn(self.NOTE, out)

    def test_marker_is_checked_before_clipping(self):
        reply = "h" * 3000 + "\n" + self.MARKER + "\n" + "t" * 7000
        code, out = self.run_reply(reply, {"session": "subagent"})
        self.assertEqual(code, 0)
        self.assertIn("characters omitted", out)
        self.assertNotIn(self.MARKER, out)
        self.assertNotIn(self.NOTE, out)

    def test_primary_interactive_and_unrecorded_panes_get_no_note(self):
        interactive = spawn.resolve(opts(harness="claude", role="worker", model="test-model", interactive=True), CFG)
        for record in ({"session": "primary"}, interactive, None, {}):
            with self.subTest(record=record):
                code, out = self.run_reply("The checks pass.", record)
                self.assertEqual(code, 0)
                self.assertNotIn(self.NOTE, out)

    def test_api_error_fallback_checks_the_selected_reply(self):
        for reply, missing in (("The checks pass.", True), (self.MARKER, False)):
            with self.subTest(reply=reply):
                code, out = self.run_reply(reply, {"session": "subagent"}, api_error=True)
                self.assertEqual(code, 0)
                self.assertIn("note: reply was an API error", out)
                self.assertEqual(self.NOTE in out, missing)

    def test_api_error_without_fallback_keeps_its_exit_code(self):
        code, out = self.run_reply(API_ERROR, {"session": "subagent"})
        self.assertEqual(code, 6)
        self.assertTrue(out.endswith(API_ERROR + "\n" + self.NOTE + "\n"), out)


class Roles256(IsolatedConfig):
    def prompt(self, role):
        resolved = spawn.resolve(opts(harness="claude", role=role), CFG)
        return spawn.system_prompt(resolved, CFG)

    def practice(self, role):
        text = self.prompt(role).split("## Usual practice\n\n", 1)[1].split("\n\n", 1)[0]
        return text.splitlines()

    def test_scratch_rule_is_a_numbered_practice_for_both_roles(self):
        rule = "Put scratch files in a new directory from `mktemp -d`, and leave them there."
        for role in ("worker", "reviewer"):
            with self.subTest(role=role):
                lines = self.practice(role)
                self.assertIn(rule, [line.split(". ", 1)[1] for line in lines])
                self.assertEqual([line.split(". ", 1)[0] for line in lines],
                                 [str(i) for i in range(1, len(lines) + 1)])

    def test_worker_keeps_task_priority_without_the_dangling_sentence(self):
        text = " ".join(self.prompt("worker").split())
        self.assertIn("If the task names a tool, a method or a check, use that.", text)
        self.assertNotIn("The lists below are the usual order of preference. They are "
                         "not limits.", text)

    def test_reviewer_method_two_reads_the_commit_before_a_targeted_check(self):
        text = self.prompt("reviewer")
        methods = text.split("## Methods, in order of preference\n\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(methods.splitlines()[1],
                         "2. Read the check lines in the commit body. "
                         "Run one test or one script only to confirm a suspected defect.")
        self.assertNotIn("Run the checks that exist and do not change state: tests, type check, lint.", text)

    def test_reviewer_verdict_follows_the_acceptance_scope_item(self):
        lines = self.practice("reviewer")
        self.assertEqual(lines[0],
                         "1. A changed line that no acceptance criterion of the task names is a finding. "
                         "Report it even when the diff otherwise looks correct.")
        self.assertEqual(lines[1],
                         "2. Check each acceptance criterion of the task. Start the findings with a verdict: "
                         "pass, pass with findings, or fix first.")

    def test_rendered_prompt_sizes_stay_within_the_corrected_limits(self):
        self.assertLessEqual(abs(len(self.prompt("worker")) - 2341), 150)
        self.assertLessEqual(len(self.prompt("reviewer")), 2578)


class Roles255(IsolatedConfig):
    def test_gatherers_render_only_the_first_choice_list(self):
        resources = _common.load_catalog()
        command = f"python3 {spawn.HERE}/resources.py"
        fallback = ("If an entry fails or is not available, go to the next one. In your result, say\n"
                    "which entry you used, which entries failed, and the exact error of each.\n"
                    "Stop and report only when no entry works, or when the task forbids the\n"
                    "entries that are left.")
        for harness in ("pi", "claude"):
            for role, first, second in (("researcher", "web", "local"), ("scout", "local", "web")):
                with self.subTest(harness=harness, role=role):
                    r = spawn.resolve(opts(harness=harness, role=role), CFG)
                    text = spawn.system_prompt(r, CFG)
                    first_lines, _ = _common.catalog_lines(resources, first)
                    second_lines, _ = _common.catalog_lines(resources, second)
                    self.assertIn("\n".join(first_lines), text)
                    for line in second_lines:
                        self.assertNotIn(line, text)
                    pointer = f"Use the entries of `{command} --group {second} --role {role}` in their order."
                    if role == "scout":
                        pointer += " Read the entry before its first use."
                    self.assertIn(pointer, text)
                    self.assertEqual(text.count(fallback), 1)
                    self.assertNotIn("**Report.**", text)
                    self.assertNotRegex(text, r"\{[a-z_:]+\}")

    def test_scout_pointer_keeps_the_machine_web_mcp_configuration(self):
        example = os.path.join(SKILL, "resources.local.example.json")
        with mock.patch.object(_common, "MACHINE_CATALOG", example):
            for strict in (False, True):
                with self.subTest(strict=strict):
                    r = spawn.resolve(opts(harness="claude", role="scout", strict=strict), CFG)
                    args = spawn.native_args(r, CFG, False, "roles255-scout-1", write=True)
                    with open(args[args.index("--mcp-config") + 1], encoding="utf-8") as f:
                        config = json.load(f)
                    helper = os.path.expanduser("~/.agents/skills/herdr/scripts/mcp-bearer-helper.sh DONSETCH_HTTP_TOKEN")
                    self.assertEqual(config, {"mcpServers": {"donsetch": {
                        "type": "http", "url": "http://127.0.0.1:8766/mcp", "headersHelper": helper}}})
                    self.assertIn("mcp__donsetch", args[args.index("--allowedTools") + 1].split())
                    self.assertEqual("--strict-mcp-config" in args, strict)
                    with open(args[args.index("--append-system-prompt-file") + 1], encoding="utf-8") as f:
                        text = f.read()
                    self.assertIn("resources.py --group web --role scout` in their order. Read the entry before its first use.", text)
                    self.assertNotIn("**DonSeTch MCP", text)

    def test_scout_focus_routes_diff_judgements_to_a_reviewer(self):
        with open(os.path.join(SKILL, "SPAWN.md"), encoding="utf-8") as f:
            row = next(line for line in f if line.startswith("| `scout` |"))
        self.assertTrue(row.split("|")[2].strip().endswith(
            "Finds and quotes facts; a judgement of a diff goes to a reviewer"))


class Roles257(IsolatedConfig):
    def test_unattended_worker_allows_edits_without_a_blanket_shell_rule(self):
        for strict in (False, True):
            with self.subTest(strict=strict):
                r = spawn.resolve(opts(harness="claude", role="worker", strict=strict), CFG)
                args = spawn.native_args(r, CFG, True, "t-worker-1", write=False)
                allowed = args[args.index("--allowedTools") + 1]
                self.assertEqual(allowed, spawn.CLAUDE_HERDR_TOOLS + " Read Write Edit Grep Glob")
                self.assertNotIn("Bash", allowed.split())
                self.assertNotIn("Bash(*)", allowed.split())
                self.assertEqual(args[args.index("--permission-mode") + 1], "auto")

    def test_read_roles_keep_the_read_only_shell_rules(self):
        read_tools = ("Read Grep Glob Bash(rg:*) Bash(ls:*) Bash(cat:*) Bash(git log:*) "
                      "Bash(git diff:*) Bash(git show:*) Bash(git status:*) Bash(git grep:*)")
        self.assertEqual(spawn.CLAUDE_READ_TOOLS, read_tools)
        for role in ("researcher", "scout", "reviewer"):
            with self.subTest(role=role):
                r = spawn.resolve(opts(harness="claude", role=role), CFG)
                args = spawn.native_args(r, CFG, False, f"t-{role}-1", write=False)
                self.assertIn(read_tools, args[args.index("--allowedTools") + 1])


class Roles254(IsolatedConfig):
    def setUp(self):
        super().setUp()
        self.resolved = {harness: spawn.resolve(opts(harness=harness, role="coordinator"), CFG)
                         for harness in ("pi", "claude")}
        self.prompts = {harness: spawn.system_prompt(r, CFG) for harness, r in self.resolved.items()}

    def test_pi_spawn_rule_points_to_the_skill(self):
        expected = "4. In Pi, start each task session with `herdr_spawn` (herdr skill, section B)."
        for harness, text in self.prompts.items():
            with self.subTest(harness=harness):
                self.assertIn(expected, text.splitlines())
                for removed in ("herdr_watch_start", "blocking `ask.py`", "not to use the watch"):
                    self.assertNotIn(removed, text)

    def test_claude_lookup_routing(self):
        expected = ("7. In Claude Code, a read-only lookup that needs no other model and no visible pane "
                    "goes to the Agent tool (Explore or web-fetch). A ticket, a review or work for another "
                    "model goes to a Herdr pane.")
        for harness, text in self.prompts.items():
            with self.subTest(harness=harness):
                self.assertIn(expected, text.splitlines())

    def test_result_format_ban_is_absent(self):
        for harness, text in self.prompts.items():
            with self.subTest(harness=harness):
                for removed in ("You are not a task session.", "task session result format",
                                "task-session result format", "Answer the user in the normal way."):
                    self.assertNotIn(removed, text)

    def test_numbering_and_models_item_stay_unchanged(self):
        expected = ("10. The model and thinking level come from the request or from the local defaults file "
                    "`~/.config/herdr-skill/models.json`.")
        for harness, text in self.prompts.items():
            with self.subTest(harness=harness):
                numbers = [int(line.partition(". ")[0]) for line in text.splitlines()
                           if line.partition(". ")[0].isdigit()]
                self.assertEqual(numbers, list(range(1, 11)))
                self.assertIn(expected, text.splitlines())

    def test_rendered_coordinator_prompt_size(self):
        for harness, r in self.resolved.items():
            with self.subTest(harness=harness):
                args = spawn.native_args(r, CFG, False, f"t-coordinator-254-{harness}")
                with open(args[-1], encoding="utf-8") as f:
                    text = f.read()
                self.assertEqual(text, self.prompts[harness] + "\n")
                self.assertLessEqual(len(text), 1560)


class Roles253(IsolatedConfig):
    def write_catalog(self, roles):
        path = os.path.join(os.path.dirname(self.models_path), "resources.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"resources": {"example": {"group": "web", "roles": roles}}}, f)
        return path

    def test_donsetch_example_reports_the_error_and_uses_the_next_entry(self):
        with open(os.path.join(SKILL, "resources.local.example.json"), encoding="utf-8") as f:
            example = json.load(f)
        text = example["resources"]["donsetch"]["load"]
        self.assertTrue(text.endswith(
            "If DonSeTch fails, give its exact error in the result and use the next entry."))
        self.assertNotIn("stop", text)
        self.assertNotIn("do not use another search provider", text)
        self.assertIn("roles", example["comment"])

    def test_role_prompts_include_unscoped_and_matching_entries_only(self):
        resources = {
            "all-roles": {"group": "web", "order": 1, "title": "All roles"},
            "researcher-only": {"group": "web", "order": 2, "title": "Researcher only", "roles": ["researcher"]},
            "scout-only": {"group": "web", "order": 3, "title": "Scout only", "roles": ["scout"]}}
        for role in CFG["roles"]:
            with self.subTest(role=role):
                lines, absent = _common.catalog_lines(resources, "web", role)
                expected = ["all-roles"] + ([f"{role}-only"] if role in ("researcher", "scout") else [])
                self.assertEqual(len(lines), len(expected))
                self.assertEqual(absent, [])
                for number, (line, rid) in enumerate(zip(lines, expected), 1):
                    self.assertTrue(line.startswith(f"{number}. "))
                    self.assertIn(f"`{rid}`", line)
                if role not in ("researcher", "scout"):
                    continue
                group = "web" if role == "researcher" else "local"
                prompt_resources = {rid: dict(resource, group=group) for rid, resource in resources.items()}
                with mock.patch.object(spawn, "load_catalog", return_value=prompt_resources):
                    text = spawn.system_prompt(spawn.resolve(opts(harness="claude", role=role), CFG), CFG)
                for rid in resources:
                    if rid in expected:
                        self.assertIn(f"`{rid}`", text)
                    else:
                        self.assertNotIn(f"`{rid}`", text)
                self.assertNotIn("**Report.**", text)

    def test_excluded_entries_are_not_probed_or_reported_as_absent(self):
        resources = {
            "omitted": {"group": "web", "roles": ["scout"]},
            "empty": {"group": "web", "roles": []},
            "other-group": {"group": "local"}}
        with mock.patch.object(_common, "resolve_resource") as resolve:
            self.assertEqual(_common.catalog_lines(resources, "web", "researcher"), ([], []))
        resolve.assert_not_called()

    def test_known_roles_and_empty_list_are_valid(self):
        for roles in ([], list(CFG["roles"]), ["scout", "scout"], *([role] for role in CFG["roles"])):
            with self.subTest(roles=roles):
                path = self.write_catalog(roles)
                self.assertEqual(_common.load_catalog(path)["example"]["roles"], roles)

    def test_invalid_roles_stop_launch_with_path_and_reason(self):
        bad = (None, "scout", {}, 1, True, ["unknown"], ["scout", "unknown"],
               [None], [1], [True], [{}], [["scout"]], [""])
        me = {"workspace": "proj", "workspace_id": "w1", "tab_id": "t1", "pane_id": "p1"}
        for roles in bad:
            path = self.write_catalog(roles)
            for harness in ("pi", "claude"):
                for dry_run in (False, True):
                    with self.subTest(roles=roles, harness=harness, dry_run=dry_run):
                        argv = ["spawn.py", "--harness", harness, "--role", "worker"]
                        if dry_run:
                            argv.append("--dry-run")
                        out, err = io.StringIO(), io.StringIO()
                        with mock.patch.object(_common, "MACHINE_CATALOG", path), \
                                mock.patch.multiple(spawn, require_herdr_env=lambda: None,
                                                    ensure_layout=lambda quiet: me,
                                                    ensure_layout_readonly=lambda: me, live_agents=lambda: []), \
                                mock.patch.object(spawn, "place") as place, \
                                mock.patch.object(spawn, "herdr") as herdr, \
                                mock.patch.object(sys, "argv", argv), \
                                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                                self.assertRaises(SystemExit) as exc:
                            spawn.main()
                        self.assertEqual(exc.exception.code, 2)
                        self.assertIn(path + ": resources.example.roles must be a list of known role names:",
                                      err.getvalue())
                        self.assertEqual(out.getvalue(), "")
                        place.assert_not_called()
                        herdr.assert_not_called()

    def test_invalid_shipped_roles_report_the_shipped_path(self):
        path = self.write_catalog(["unknown"])
        err = io.StringIO()
        with mock.patch.object(_common, "SKILL_DIR", os.path.dirname(path)), \
                contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as exc:
            _common.load_catalog()
        self.assertEqual(exc.exception.code, 2)
        self.assertIn(path + ": resources.example.roles must be a list of known role names:", err.getvalue())


class Roles263(IsolatedConfig):
    def test_reviewer_task_priority_has_only_the_task_rule(self):
        for harness in ("pi", "claude"):
            with self.subTest(harness=harness):
                resolved = spawn.resolve(opts(harness=harness, role="reviewer"), CFG)
                text = spawn.system_prompt(resolved, CFG)
                priority = text.split("## The task has priority\n\n", 1)[1].split("\n\n", 1)[0]
                self.assertEqual(priority, "If the task names a method, a scope or a check, use that.")
                self.assertNotIn("They are " "not limits.", text)


class Roles262(IsolatedConfig):
    def resources_command(self, *args):
        path = os.path.join(os.path.dirname(self.models_path), "resources.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"resources": {
                "scoped": {"group": "web", "roles": ["scout", "worker"]},
                "empty": {"group": "web", "roles": []}}}, f)
        return subprocess.run([sys.executable, os.path.join(SKILL, "scripts", "resources.py"), *args],
                              capture_output=True, text=True,
                              env=dict(os.environ, HERDR_SKILL_RESOURCES=path))

    def test_resources_role_filter_and_roles_column(self):
        for role in (None, "scout", "researcher"):
            role_args = ["--role", role] if role else []
            for args, group in ((role_args, None), (role_args + ["--group", "web"], "web"),
                                (["--group", "web"] + role_args, "web")):
                with self.subTest(args=args):
                    result = self.resources_command(*args)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    table = result.stdout.split("\n\n", 1)[0].splitlines()
                    header = table[0].split("\t")
                    self.assertIn("ROLES", header)
                    rows = {row["ID"]: row for row in (dict(zip(header, line.split("\t")))
                                                     for line in table[1:])}
                    expected = {rid for rid, entry in _common.load_catalog().items()
                                if group is None or entry["group"] == group}
                    if role in (None, "scout"):
                        expected.add("scoped")
                        self.assertEqual(rows["scoped"]["ROLES"], "scout,worker")
                    if role is None:
                        expected.add("empty")
                        self.assertEqual(rows["empty"]["ROLES"], "-")
                    self.assertEqual(set(rows), expected)
                    self.assertEqual(rows["harness-web"]["ROLES"], "-")

    def test_unknown_role_error_lists_known_roles(self):
        result = self.resources_command("--role", "unknown")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("error:", result.stderr)
        self.assertIn("unknown", result.stderr)
        for role in _common.ROLES:
            self.assertIn(role, result.stderr)

    def test_rendered_pointers_and_list_command_name_the_role(self):
        command = f"python3 {spawn.HERE}/resources.py"
        for harness in ("pi", "claude"):
            for role, group in (("researcher", "local"), ("scout", "web")):
                with self.subTest(harness=harness, role=role):
                    text = spawn.system_prompt(spawn.resolve(opts(harness=harness, role=role), CFG), CFG)
                    self.assertIn(f"`{command} --group {group} --role {role}`", text)
                    self.assertIn(f"run `{command} --role {role}`.", text)
                    self.assertNotRegex(text, r"\{[a-z_:]+\}")

    def test_absent_note_includes_role_filtered_pointer_groups(self):
        missing = os.path.join(os.path.dirname(self.models_path), "absent-skill.md")
        resources = _common.load_catalog()
        for rid in ("local-machine", "harness-web"):
            resources[rid]["locations"] = [{"file": missing}]
            resources[rid]["roles"] = ["researcher", "scout"]
        for group in ("local", "web"):
            for suffix, roles in (("worker-only", ["worker"]), ("empty", [])):
                resources[f"{group}-{suffix}"] = {
                    "group": group, "roles": roles, "locations": [{"file": missing}]}
        for role, first, pointer in (("researcher", "harness-web", "local-machine"),
                                     ("scout", "local-machine", "harness-web")):
            with self.subTest(role=role), mock.patch.object(spawn, "load_catalog", return_value=resources), \
                    mock.patch.object(_common, "resolve_resource", wraps=_common.resolve_resource) as resolve:
                text = spawn.system_prompt(spawn.resolve(opts(harness="claude", role=role), CFG), CFG)
                note = next(line for line in text.splitlines() if line.startswith("Not found on this machine"))
                self.assertEqual(note, "Not found on this machine when you started: "
                                 + resources[first]["title"] + ", " + resources[pointer]["title"]
                                 + ". Try one of them only if the task asks for it.")
                self.assertEqual(resolve.call_count, 4)
                for call in resolve.call_args_list:
                    self.assertNotIn(call.args[0].get("roles"), (["worker"], []))
                self.assertNotIn("{absent}", text)

    def test_absent_group_is_collected_once_for_lists_and_pointers(self):
        resources = {"missing": {"group": "local", "title": "Missing local entry",
                                 "locations": [{"file": self.models_path}]}}
        template = ("{methods:local}\n{resources_command} --group local --role researcher\n"
                    "{resources_command} --group local --role researcher\n{absent}")
        with mock.patch.object(_common, "resolve_resource", wraps=_common.resolve_resource) as resolve:
            text = spawn.render_methods(template, resources, "researcher")
        resolve.assert_called_once_with(resources["missing"])
        self.assertEqual(text.count("Missing local entry"), 1)


if __name__ == "__main__":
    unittest.main()
