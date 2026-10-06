"""Unit tests for names, labels and launch arguments. No Herdr server is needed.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import contextlib
import importlib.util
import io
import json
import os
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
            self.assertNotIn("Hound", spawn.system_prompt(r, CFG))
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
            self.assertEqual(config, {"mcpServers": {"hound": {"type": "http", "url": "http://127.0.0.1:8765/mcp"}}})
            self.assertIn("mcp__hound", args[args.index("--allowedTools") + 1].split())
            self.assertNotIn("--strict-mcp-config", args)
            r = spawn.resolve(opts(harness="claude", role="worker"), CFG)
            self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-worker-1", write=False))
            r = spawn.resolve(opts(harness="pi", role="researcher", strict=True), CFG)
            args = spawn.native_args(r, CFG, False, "t-researcher-1", write=False)
            self.assertEqual(args[args.index("--mcp-config") + 1], os.path.expanduser("~/.pi/agent/mcp-researcher.json"))
            r = spawn.resolve(opts(harness="pi", role="researcher"), CFG)
            self.assertNotIn("--mcp-config", spawn.native_args(r, CFG, False, "t-researcher-1", write=False))

    def test_the_server_name_of_an_mcp_entry(self):
        resources = {
            "b": {"group": "web", "order": 2, "kind": "mcp", "mcp_server": "search_two", "locations": [{"url": "http://localhost:2/mcp"}]},
            "a": {"group": "web", "order": 1, "kind": "mcp", "locations": [{"file": "~/x"}, {"url": "http://localhost:1/mcp"}]},
            "no-url": {"group": "web", "kind": "mcp", "locations": [{"command": "x"}]},
            "bad name": {"group": "web", "kind": "mcp", "locations": [{"url": "http://localhost:3/mcp"}]},
            "skill": {"group": "web", "kind": "skill", "locations": [{"url": "http://localhost:4/"}]},
            "local": {"group": "local", "kind": "mcp", "locations": [{"url": "http://localhost:5/mcp"}]}}
        self.assertEqual(list(_common.mcp_servers(resources).items()),
                         [("a", "http://localhost:1/mcp"), ("search_two", "http://localhost:2/mcp")])

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
            prompts[role] = spawn.system_prompt(r, CFG)
            self.assertIn("context gatherer", prompts[role])
            self.assertIn("Web tools of your harness", prompts[role])
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
        self.assertEqual(sorted(example["resources"]), ["desktop-browser", "hound"])

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


if __name__ == "__main__":
    unittest.main()
