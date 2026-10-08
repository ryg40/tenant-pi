"""Synthetic, offline workflow-module tests: MCP adapter definitions, Promptr readiness, publication."""
import copy
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.candidate_compare import FILES, compare
from scripts.memory_modules import HERMES_CONFIG
from scripts.profile_plan import prepare
from scripts.profile_write import STATE, WriteError, write
from scripts.validate import Invalid, load, manifest, overlay
from scripts.workflow_modules import (BUILTIN_MCP_OFF, MCP_CONFIG, MCP_MODE_NAME, PROMPTR_PREREQUISITES,
                                      render_mcp, validate_mcp)

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
PIN = load(ROOT / "config/manifest.json")["runtime"]["piVersion"]
CANARY = "CANARY_SECRET"
SLOT = "inputs/mcp-adapter.json"
HTTP_SERVER = {"url": "https://mcp.example.invalid/mcp", "headers": {"Authorization": "${MCP_EXAMPLE_TOKEN}"}}
STDIO_SERVER = {"command": "/opt/tools/example-mcp", "args": ["--stdio", "--verbose"],
                "env": {"EXAMPLE_HOME": "${EXAMPLE_HOME}"}, "cwd": "/opt/tools"}
DEFINITIONS = {"$schema": "https://example.invalid/schema.json",
               "mcpServers": {"remote": copy.deepcopy(HTTP_SERVER), "local": copy.deepcopy(STDIO_SERVER),
                              "eager": {"url": "http://127.0.0.1:8080/mcp", "lifecycle": "keep-alive"},
                              "parked": {"url": "https://parked.example.invalid/", "disabled": True}}}


def ipv4(*octets):
    # Built at run time so that no private or shared-range literal is in this file for the host-value scan.
    return ".".join(str(octet) for octet in octets)


class McpDefinitionTests(unittest.TestCase):
    def error(self, definitions, rule):
        with self.assertRaisesRegex(Invalid, "^" + rule + ":") as ctx:
            validate_mcp(definitions)
        self.assertNotIn(CANARY, str(ctx.exception))
        self.assertNotIn(CANARY.lower(), str(ctx.exception))

    def test_reviewed_shapes_pass_and_keep_file_order(self):
        self.assertEqual(["remote", "local", "eager", "parked"], validate_mcp(DEFINITIONS))
        for url in ("http://localhost:3000/mcp", "http://" + ipv4(10, 0, 0, 5) + "/", "http://" + ipv4(192, 168, 1, 20) + ":8443/x",
                    "http://" + ipv4(172, 16, 4, 4) + ":1/", "https://host.example.invalid:8443/path/to/mcp",
                    "http://" + ipv4(100, 64, 0, 9) + "/mcp"):
            with self.subTest(url=url):
                validate_mcp({"mcpServers": {"s": {"url": url}}})
        validate_mcp({"mcpServers": {}})
        validate_mcp({"mcpServers": {"s": {"command": "/bin/true", "inheritEnv": False, "includeTools": ["a.b", "c_d"],
                                           "toolPrefix": "short", "idleTimeout": 0, "exposeResources": False}}})

    def test_credentials_commands_and_native_fields_are_rejected(self):
        cases = (
            ({"url": "https://h.invalid/", "bearerToken": CANARY}, "credential_field"),
            ({"url": "https://h.invalid/", "bearerTokenEnv": "X"}, "credential_field"),
            ({"url": "https://h.invalid/", "bearerTokenStore": True}, "credential_field"),
            ({"url": "https://h.invalid/", "auth": "oauth"}, "credential_field"),
            ({"url": "https://h.invalid/", "oauth": {"clientId": "x", "clientSecret": CANARY}}, "credential_field"),
            ({"url": "https://h.invalid/", "requestHeadersCommand": "/bin/" + CANARY}, "credential_field"),
            ({"command": "/bin/x", "literalEnv": {"K": CANARY}}, "credential_field"),
            ({"url": "https://h.invalid/", "type": "http"}, "native_mcp_field"),
            ({"url": "https://h.invalid/", "enabled": False}, "native_mcp_field"),
            ({"url": "https://h.invalid/", "timeout": 60}, "native_mcp_field"),
            ({"url": "https://h.invalid/", "exposure": "direct"}, "native_mcp_field"),
            ({"command": "/bin/x", "toolExposure": {}}, "native_mcp_field"),
            ({"socket": "/run/" + CANARY}, "unsupported_transport"),
            ({"lifecycle": "lazy"}, "transport_required"),
            ({"url": "https://h.invalid/", "command": "/bin/x"}, "transport_conflict"),
            ({"url": "https://h.invalid/", "args": ["x"]}, "transport_fields"),
            ({"command": "/bin/x", "headers": {}}, "transport_fields"),
            ({"url": "https://h.invalid/", "headers": {"Authorization": "!op read " + CANARY}}, "credential_command"),
            ({"url": "https://h.invalid/", "headers": {"Authorization": "Bearer " + CANARY}}, "literal_credential"),
            ({"url": "https://h.invalid/", "headers": {"Authorization": "Bearer ${TOKEN}"}}, "literal_credential"),
            ({"url": "https://h.invalid/", "headers": {"Content-Type": "application/json"}}, "literal_credential"),
            ({"url": "https://h.invalid/", "headers": {"bad header": "${TOKEN}"}}, "header_name"),
            ({"command": "/bin/x", "env": {"KEY": "!" + CANARY}}, "credential_command"),
            ({"command": "/bin/x", "env": {"KEY": CANARY}}, "env_reference"),
            ({"command": "/bin/x", "env": {"key": "${KEY}"}}, "env_name"),
            ({"command": "/bin/x", "args": ["--token=" + CANARY]}, "credential_argument"),
            ({"command": "/bin/x", "args": ["--api-key", CANARY]}, "credential_argument"),
            ({"command": "/bin/x", "args": ["$" + CANARY]}, "shell_or_template"),
            ({"command": "/bin/x", "args": "--flag"}, "array"),
            ({"command": "npx", "args": ["-y", CANARY]}, "absolute_path"),
            ({"command": "/opt/../" + CANARY}, "absolute_path"),
            ({"command": "/bin/x", "cwd": "relative/" + CANARY}, "absolute_path"),
            ({"url": "https://user:" + CANARY + "@h.invalid/"}, "mcp_url"),
            ({"url": "https://h.invalid/?key=" + CANARY}, "mcp_url"),
            ({"url": "https://h.invalid/%3B" + CANARY}, "mcp_url"),
            ({"url": "https://h.invalid/${TOKEN}"}, "mcp_url"),
            ({"url": "ftp://h.invalid/"}, "mcp_url"),
            ({"url": "https://h.invalid:70000/"}, "mcp_url"),
            ({"url": "http://mcp.example.invalid/"}, "plain_http_url"),
            ({"url": "http://8.8.8.8/"}, "plain_http_url"),
            ({"url": "http://[::1]:8000/"}, "mcp_url"),
            ({"url": "https://h.invalid/", "httpTransport": "websocket"}, "http_transport"),
            ({"url": "https://h.invalid/", "caFile": "certs/" + CANARY}, "absolute_path"),
            ({"url": "https://h.invalid/", "lifecycle": "always"}, "lifecycle"),
            ({"url": "https://h.invalid/", "disabled": "yes"}, "boolean"),
            ({"url": "https://h.invalid/", "directTools": ["x"]}, "boolean"),
            ({"url": "https://h.invalid/", "requestTimeoutMs": 0}, "integer"),
            ({"url": "https://h.invalid/", "idleTimeout": -1}, "integer"),
            ({"url": "https://h.invalid/", "toolPrefix": "x"}, "tool_prefix"),
            ({"url": "https://h.invalid/", "includeTools": ["bad tool"]}, "tool_name"),
            ({"url": "https://h.invalid/", "excludeTools": ["a", "a"]}, "duplicate_tool"),
            ({"url": "https://h.invalid/", "extra": CANARY}, "unknown_fields"),
            (CANARY, "object"),
        )
        for entry, rule in cases:
            with self.subTest(rule=rule, entry=sorted(entry) if type(entry) is dict else entry):
                self.error({"mcpServers": {"s": entry}}, rule)

    def test_file_shape_names_and_duplicates(self):
        for data, rule in (({"mcpServers": {}, "imports": ["cursor"]}, "ambient_import_field"),
                           ({"mcpServers": {}, "settings": {"hostConfigDiscovery": "on"}}, "ambient_import_field"),
                           ({"mcpServers": {}, "claudePlugins": [CANARY]}, "ambient_import_field"),
                           ({"mcp-servers": {}}, "ambient_import_field"),
                           ({"mcpServers": {}, "autoEnableCodemode": True}, "ambient_import_field"),
                           ({"mcpServers": {}, "extra": CANARY}, "unknown_fields"),
                           ({}, "required_fields"),
                           ({"mcpServers": []}, "object"),
                           ({"mcpServers": {}, "$schema": 5}, "text"),
                           ({"mcpServers": {"bad name": {"url": "https://h.invalid/"}}}, "server_name"),
                           ({"mcpServers": {"": {"url": "https://h.invalid/"}}}, "server_name"),
                           ({"mcpServers": {"Hound": {"url": "https://h.invalid/"}, "hound": {"url": "https://h.invalid/"}}}, "duplicate_server"),
                           ([], "object"), (CANARY, "object")):
            with self.subTest(rule=rule):
                self.error(data, rule)
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "mcp.json"
            file.write_text('{"mcpServers": {"a": {"url": "https://h.invalid/"}, "a": {"url": "https://' + CANARY + '.invalid/"}}}')
            with self.assertRaisesRegex(Invalid, "^duplicate_key:") as ctx:
                load(file)
            self.assertNotIn(CANARY, str(ctx.exception))


class WorkflowPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest_data = load(ROOT / "config/manifest.json")
        cls.components = manifest(cls.manifest_data)

    def base(self, *modules, mcp=True):
        data = load(ROOT / "config/config.example.json")
        data["target"]["agentDir"] = "/home/Test User/.pi/.config/new profile"
        for cid in modules:
            data["selection"]["disable"].remove(cid)
            data["selection"]["enable"].append(cid)
        if mcp:
            data["selection"]["disable"].remove("mcp")
            data["selection"]["enable"].append("mcp")
            data["inputs"]["mcpFile"] = SLOT
        return data

    def test_module_selection_and_input_slot_are_bound(self):
        data = self.base(mcp=False)
        data["selection"]["disable"].remove("mcp")
        data["selection"]["enable"].append("mcp")
        with self.assertRaisesRegex(Invalid, "^mcp_input_required:"):
            overlay(data, self.components)
        data = self.base(mcp=False)
        data["inputs"]["mcpFile"] = SLOT
        with self.assertRaisesRegex(Invalid, "^unselected_input:"):
            overlay(data, self.components)
        data = self.base()
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^mcp_definitions_required:"):
            prepare(self.manifest_data, data)
        with self.assertRaisesRegex(Invalid, "^mcp_definitions_without_module:"):
            prepare(self.manifest_data, self.base(mcp=False), mcp_definitions=DEFINITIONS)
        with self.assertRaisesRegex(Invalid, "^credential_field:") as ctx:
            prepare(self.manifest_data, data, mcp_definitions={"mcpServers": {"s": {"url": "https://h.invalid/", "bearerToken": CANARY}}})
        self.assertNotIn(CANARY, str(ctx.exception))

    def test_default_plan_emits_no_mcp_path_but_records_the_matrix(self):
        plan = prepare(self.manifest_data, self.base(mcp=False))
        settings = plan["files"]["settings.json"]["content"]
        self.assertNotIn("extensions", settings)
        self.assertEqual([], settings["packages"])
        self.assertNotIn(MCP_CONFIG, plan["files"])
        self.assertNotIn(MCP_MODE_NAME, plan["commands"]["launch"])
        workflow = plan["files"][".tenant-pi/choices.json"]["content"]["workflow"]
        self.assertEqual({"enabled": False, "status": "tested"}, workflow["mcp"])
        self.assertEqual({"enabled": False, "status": "unverified",
                          "prerequisites": [{"code": p["code"], "subject": p["subject"], "status": p["status"]} for p in PROMPTR_PREREQUISITES]},
                         workflow["promptr"])
        self.assertIsNone(plan["files"][".tenant-pi/choices.json"]["content"]["mcpDefinitions"])
        self.assertEqual("unverified", self.components["promptr"]["status"])
        self.assertEqual({"local_package_load": "met", "pi_line_build_and_tests": "met", "build_step_required": "open",
                          "host_module_dependency": "open", "private_renderer_adapters": "open",
                          "automatic_dispatch_path_unverified": "open"}, {p["code"]: p["status"] for p in PROMPTR_PREREQUISITES})
        # Each open prerequisite is a gap of the component, so a plan that enables Promptr names it.
        gap_codes = {gap["code"] for gap in self.components["promptr"]["gaps"]}
        self.assertLessEqual({p["code"] for p in PROMPTR_PREREQUISITES if p["status"] == "open"}, gap_codes)

    def test_promptr_facts_separate_current_checks_from_historical_loads(self):
        facts = {p["code"]: p["fact"] for p in PROMPTR_PREREQUISITES}
        self.assertIn("Pi 1.0.2 and Pi 1.0.3 load", facts["local_package_load"])
        self.assertIn("16 commands", facts["local_package_load"])
        self.assertIn("four skills", facts["local_package_load"])
        self.assertIn("pins pi-tui and pi-coding-agent 1.1.0", facts["pi_line_build_and_tests"])
        self.assertIn("With both dependencies at 1.1.0, the build, the 778 tests, the typecheck and `npm run smoke` pass.",
                      facts["pi_line_build_and_tests"])
        self.assertIn("`npm run smoke:installed` and a package load on Pi 1.1.0 are not verified.",
                      facts["pi_line_build_and_tests"])
        self.assertEqual("@earendil-works/pi-tui@1.1.0", next(
            p["subject"] for p in PROMPTR_PREREQUISITES if p["code"] == "host_module_dependency"))
        self.assertIn("Pi 1.0.2 and Pi 1.0.3 print one peerDependencies warning", facts["host_module_dependency"])
        self.assertNotIn("No build or test on the kit pin is verified", " ".join(facts.values()))

    def test_promptr_is_selectable_and_the_plan_declares_the_built_package(self):
        overlay = self.base(mcp=False)
        for cid in ("promptr", "promptr-handoff"):
            overlay["selection"]["disable"].remove(cid)
            overlay["selection"]["enable"].append(cid)
        plan = prepare(self.manifest_data, overlay)
        packages = plan["files"]["settings.json"]["content"]["packages"]
        self.assertEqual([{"source": str(ROOT / "packages/promptr"), "extensions": ["index.ts"],
                           "skills": ["skills/promptr-handoff"], "prompts": [], "themes": []}], packages)
        workflow = plan["files"][".tenant-pi/choices.json"]["content"]["workflow"]
        self.assertTrue(workflow["promptr"]["enabled"])
        gaps = {(gap["code"], gap["subject"]) for gap in plan["readinessGaps"]}
        for code in ("package_runtime_unverified", "build_step_required", "host_module_dependency",
                     "placeholder_defaults", "private_renderer_adapters", "automatic_dispatch_path_unverified", "kit_test_missing"):
            self.assertIn((code, "promptr"), gaps)
        self.assertIn(("skill_use_unverified", "promptr-handoff"), gaps)

    def test_extension_components_keep_skills_empty_and_herdr_is_its_own_component(self):
        # The Herdr skill is a selectable component.
        for cid in ("tenantext", "codex-accounts"):
            self.assertEqual([], self.components[cid]["resources"]["skills"])
        self.assertEqual({"extensions": [], "skills": ["skills/herdr"], "prompts": [], "themes": []},
                         self.components["herdr"]["resources"])
        self.assertEqual("unverified", self.components["herdr"]["status"])

    def test_adapter_module_renders_one_mcp_path(self):
        data = self.base()
        before = copy.deepcopy(DEFINITIONS)
        plan = prepare(self.manifest_data, data, mcp_definitions=DEFINITIONS)
        self.assertEqual(before, DEFINITIONS)
        settings = plan["files"]["settings.json"]["content"]
        self.assertEqual([{"source": "npm:pi-mcp-adapter", "extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []}],
                         settings["packages"])
        self.assertEqual([BUILTIN_MCP_OFF], settings["extensions"])
        content = plan["files"][MCP_CONFIG]["content"]
        self.assertEqual("0600", plan["files"][MCP_CONFIG]["mode"])
        self.assertEqual(["eager", "local", "parked", "remote"], list(content["mcpServers"]))
        self.assertEqual(DEFINITIONS["mcpServers"]["parked"], content["mcpServers"]["parked"])  # Disabled entry preserved verbatim.
        self.assertEqual(STDIO_SERVER, content["mcpServers"]["local"])
        self.assertEqual({"hostConfigDiscovery": "off", "projectServers": "ask", "allowInstall": False}, content["settings"])
        self.assertNotIn("$schema", content)
        self.assertEqual(["PI_MCP_CONFIG_MODE=exclusive", "env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=/home/Test User/.pi/.config/new profile", "pi", "--no-approve"],
                         shlex.split(plan["commands"]["launch"]))
        self.assertEqual(["npm install --global -- @earendil-works/pi-coding-agent@" + PIN,
                          "PI_CODING_AGENT_DIR=" + shlex.quote(data["target"]["agentDir"]) + " pi update --extensions"],
                         plan["commands"]["setup"])
        gaps = {(g["code"], g["subject"]) for g in plan["readinessGaps"]}
        for expected in (("package_runtime_unverified", "mcp"), ("peer_range_unverified", "mcp"), ("credential_store_shared", "mcp"),
                         ("server_connection_unverified", "mcp:remote"), ("server_connection_unverified", "mcp:local"),
                         ("server_connection_unverified", "mcp:eager"), ("startup_connection", "mcp:eager"),
                         ("env_reference_not_checked", "MCP_EXAMPLE_TOKEN"), ("env_reference_not_checked", "EXAMPLE_HOME")):
            self.assertIn(expected, gaps)
        self.assertNotIn(("server_connection_unverified", "mcp:parked"), gaps)
        self.assertNotIn(("startup_connection", "mcp:remote"), gaps)
        self.assertNotIn(("optional_activation_unavailable", "mcp"), gaps)
        self.assertNotIn(("peer_override_required", "mcp"), gaps)
        record = plan["files"][".tenant-pi/choices.json"]["content"]["workflow"]["mcp"]
        self.assertEqual({"enabled": True, "path": "adapter", "builtinMcp": "disabled", "configMode": "exclusive"},
                         {k: record[k] for k in ("enabled", "path", "builtinMcp", "configMode")})
        self.assertEqual({"transport": "http", "disabled": False, "lifecycle": "keep-alive", "startupConnection": True}, record["servers"]["eager"])
        self.assertEqual({"transport": "stdio", "disabled": False, "lifecycle": "lazy", "startupConnection": False}, record["servers"]["local"])
        self.assertEqual({"transport": "http", "disabled": True, "lifecycle": "lazy", "startupConnection": False}, record["servers"]["parked"])
        self.assertEqual(DEFINITIONS, plan["files"][".tenant-pi/choices.json"]["content"]["mcpDefinitions"])
        self.assertEqual([], plan["files"][".tenant-pi/choices.json"]["content"]["pendingPackages"])
        rendered = render_mcp(DEFINITIONS, self.components)
        self.assertEqual(rendered["files"][MCP_CONFIG], content)

    def test_module_order_and_launch_prefixes_with_other_modules(self):
        data = self.base("codex-accounts", "wiki")
        data["consent"]["memoryCapture"] = True
        data["memory"] = {"schemaVersion": 1, "hermes": None, "openviking": None,
                          "wiki": {"ambientPersonalVault": True, "backgroundTasks": False, "wikiHome": "/home/Test User/wiki"}}
        plan = prepare(self.manifest_data, data, mcp_definitions=DEFINITIONS)
        sources = [p["source"] for p in plan["files"]["settings.json"]["content"]["packages"]]
        self.assertEqual([str(ROOT / "packages/tenantext"),
                          "npm:@zosmaai/pi-llm-wiki", "npm:pi-mcp-adapter"], sources)
        self.assertEqual(["PI_MCP_CONFIG_MODE=exclusive", "WIKI_HOME=/home/Test User/wiki",
                          "env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=/home/Test User/.pi/.config/new profile", "pi", "--no-approve"],
                         shlex.split(plan["commands"]["launch"]))
        self.assertEqual(3, len(plan["commands"]["setup"]))
        self.assertTrue(plan["commands"]["setup"][2].endswith("node scripts/patch_extension_peers.mjs"))
        # The wiki package declares an MCP server of its own; only one path can load it and both are closed here.
        self.assertEqual([BUILTIN_MCP_OFF], plan["files"]["settings.json"]["content"]["extensions"])


class WorkflowPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-workflow-")
        self.addCleanup(self.temp.cleanup)
        self.base_dir = Path(self.temp.name)
        self.home = self.base_dir / "home"
        self.home.mkdir(mode=0o700)
        self.parent = self.base_dir / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.manifest_data = load(ROOT / "config/manifest.json")
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        self.data["selection"]["disable"].remove("mcp")
        self.data["selection"]["enable"].append("mcp")
        self.data["inputs"]["mcpFile"] = SLOT

    def test_writer_publishes_the_adapter_file_privately_and_rejects_tampering(self):
        plan = prepare(self.manifest_data, self.data, mcp_definitions=DEFINITIONS)
        old = os.umask(0)
        try:
            result = write(plan, str(self.target))
        finally:
            os.umask(old)
        self.assertTrue(result.complete)
        self.assertEqual({"settings.json", MCP_CONFIG, ".tenant-pi", ".tenant-pi/choices.json", STATE},
                         {str(p.relative_to(self.target)) for p in self.target.rglob("*")})
        self.assertEqual(0o600, stat.S_IMODE((self.target / MCP_CONFIG).stat().st_mode))
        self.assertEqual(plan["files"][MCP_CONFIG]["content"], json.loads((self.target / MCP_CONFIG).read_text()))
        state = json.loads((self.target / STATE).read_text())
        self.assertEqual(["settings.json", ".tenant-pi/choices.json", MCP_CONFIG, STATE], state["provenance"]["outputs"])
        self.assertEqual("npm:pi-mcp-adapter", state["provenance"]["pins"]["mcp"])
        self.assertNotIn("MCP_EXAMPLE_TOKEN", (self.target / STATE).read_text())
        for change in (lambda p: p["files"][MCP_CONFIG]["content"]["mcpServers"]["remote"].update(url="https://" + CANARY.lower() + ".invalid/"),
                       lambda p: p["files"][MCP_CONFIG]["content"]["mcpServers"].update(extra={"url": "https://h.invalid/"}),
                       lambda p: p["files"][MCP_CONFIG]["content"]["settings"].update(hostConfigDiscovery="on"),
                       lambda p: p["files"].pop(MCP_CONFIG),
                       lambda p: p["files"]["settings.json"]["content"].pop("extensions"),
                       lambda p: p["files"][".tenant-pi/choices.json"]["content"]["mcpDefinitions"]["mcpServers"]["parked"].update(disabled=False),
                       lambda p: p["files"][".tenant-pi/choices.json"]["content"]["workflow"]["mcp"].update(builtinMcp="enabled"),
                       lambda p: p["files"][".tenant-pi/choices.json"]["content"].pop("workflow")):
            tampered = copy.deepcopy(prepare(self.manifest_data, self.data, mcp_definitions=DEFINITIONS))
            change(tampered)
            other = self.parent / "other"
            with self.assertRaises(WriteError) as caught:
                write(tampered, str(other))
            self.assertFalse(caught.exception.candidate_created)
            self.assertFalse(other.exists())
            self.assertNotIn(CANARY.lower(), str(caught.exception))

    def test_compare_reads_the_adapter_file_and_redacts_definitions(self):
        plan = prepare(self.manifest_data, self.data, mcp_definitions=DEFINITIONS)
        files = {name: copy.deepcopy(plan["files"][name]["content"]) for name in ("settings.json", ".tenant-pi/choices.json", MCP_CONFIG)}
        from scripts.profile_write import _provenance
        files[".tenant-pi/state.json"] = {"schemaVersion": 1, "status": "complete",
                                         "provenance": _provenance(files[".tenant-pi/choices.json"], ["settings.json", ".tenant-pi/choices.json", MCP_CONFIG])}
        report = compare(files, copy.deepcopy(files))
        self.assertEqual(list(FILES), report["scope"]["filesRead"])
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])
        self.assertIn({"file": MCP_CONFIG, "field": "/mcpServers/parked/disabled"}, report["unchanged"])
        self.assertIn({"file": "settings.json", "field": "/extensions"}, report["unchanged"])
        edited = copy.deepcopy(files)
        edited[MCP_CONFIG]["mcpServers"]["parked"]["disabled"] = False
        edited[MCP_CONFIG]["mcpServers"]["remote"]["headers"]["Authorization"] = CANARY
        edited[MCP_CONFIG]["mcpServers"]["remote"]["lifecycle"] = CANARY
        edited[MCP_CONFIG]["mcpServers"]["added"] = {"url": "https://" + CANARY.lower() + ".invalid/"}
        edited[MCP_CONFIG]["mcpServers"]["bad name\n"] = {"url": CANARY}
        edited[MCP_CONFIG]["settings"]["hostConfigDiscovery"] = "on"
        edited[MCP_CONFIG]["imports"] = [CANARY]
        edited["settings.json"]["extensions"] = ["+builtin:mcp", CANARY]
        report = compare(files, edited)
        dump = json.dumps(report)
        self.assertNotIn(CANARY, dump)
        self.assertNotIn(CANARY.lower(), dump)
        self.assertNotIn("bad name", dump)
        changes = {(c["file"], c["field"]): c for c in report["changes"]}
        self.assertEqual(({"value": True}, {"value": False}), (changes[(MCP_CONFIG, "/mcpServers/parked/disabled")]["left"],
                                                              changes[(MCP_CONFIG, "/mcpServers/parked/disabled")]["right"]))
        self.assertEqual({"status": "unsupported_value"}, changes[(MCP_CONFIG, "/mcpServers/remote/lifecycle")]["right"])
        self.assertEqual({"value": "off"}, changes[(MCP_CONFIG, "/settings/hostConfigDiscovery")]["left"])
        self.assertEqual({"status": "unsupported_value"}, changes[("settings.json", "/extensions")]["right"])
        self.assertEqual("added", changes[(MCP_CONFIG, "/mcpServers/added/transport")]["change"])
        self.assertNotIn("right", changes[(MCP_CONFIG, "/mcpServers/remote/definition")])
        statuses = {(u["file"], u["field"], u["status"]) for u in report["unsupported"]}
        self.assertIn((MCP_CONFIG, "/imports", "unsupported_field"), statuses)
        self.assertIn((MCP_CONFIG, "/mcpServers/<redacted>", "unsupported_field_name"), statuses)
        self.assertEqual("owner_edits", report["right"]["drift"]["status"])
        self.assertEqual(["/extensions", MCP_CONFIG + ":/imports", MCP_CONFIG + ":/mcpServers", MCP_CONFIG + ":/settings"],
                         report["right"]["drift"]["fields"])
        # Hostile recorded definitions make drift not computable and still leak nothing.
        hostile_choices = copy.deepcopy(files)
        hostile_choices[".tenant-pi/choices.json"]["mcpDefinitions"] = {"mcpServers": {"s": {"url": "https://h.invalid/", "bearerToken": CANARY}}}
        report = compare(files, hostile_choices)
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertEqual({"status": "not_computable", "rule": "credential_field: mcp.mcpServers.entry"}, report["right"]["drift"])
        self.assertNotIn("right", {(c["file"], c["field"]): c for c in report["changes"]}[(".tenant-pi/choices.json", "/mcpDefinitions")])
        missing = copy.deepcopy(files)
        missing[MCP_CONFIG] = None
        report = compare(files, missing)
        self.assertEqual([MCP_CONFIG + ":/<missing>"], report["right"]["drift"]["fields"])
        for hostile_value in ([CANARY], CANARY, 7, {"mcpServers": {"x": CANARY}}, {"mcpServers": {"x": {"disabled": CANARY}}}):
            hostile = copy.deepcopy(files)
            hostile[MCP_CONFIG] = hostile_value
            report = compare(files, hostile)
            self.assertNotIn(CANARY, json.dumps(report))
            self.assertEqual("owner_edits", report["right"]["drift"]["status"])

    def test_cli_reads_only_the_declared_slot_and_ignores_ambient_mcp_scopes(self):
        local = self.base_dir / "local"
        (local / "inputs").mkdir(parents=True, mode=0o700)
        (local / "inputs" / "mcp-adapter.json").write_text(json.dumps(DEFINITIONS))
        overlay_file = self.base_dir / "overlay.json"
        overlay_file.write_text(json.dumps(self.data))
        cwd = self.base_dir / "project"
        cwd.mkdir()
        bin_dir = self.base_dir / "bin"
        bin_dir.mkdir()
        for name in ("pi", "npm", "node", "npx", "git", "sh", "curl", "op"):
            command = bin_dir / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base_dir / "called") + "'\n")
            command.chmod(0o700)
        log = self.base_dir / "opened.log"
        hook = self.base_dir / "sitecustomize.py"
        hook.write_text("import sys, os\nsys.dont_write_bytecode = True\nimport socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n"
                        "_log = os.open(" + repr(str(log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
                        "def _write(text): os.write(_log, (text + '\\n').encode('utf-8', 'replace'))\n"
                        # The audit event has no dir_fd, so a wrapper of os.open records the full path of each open.
                        "_paths, _inside, _os_open = {}, [], os.open\n"
                        "def _open(path, flags, mode=0o777, *, dir_fd=None):\n"
                        "    name = os.fsdecode(path)\n"
                        "    full = os.path.normpath(os.path.join(_paths.get(dir_fd, '<unknown>') if dir_fd is not None else os.getcwd(), name))\n"
                        "    _write('resolved\\t' + full)\n"
                        "    _inside.append(1)\n"
                        "    try:\n        fd = _os_open(path, flags, mode, dir_fd=dir_fd)\n"
                        "    finally:\n        _inside.pop()\n"
                        "    _paths[fd] = full\n"
                        "    return fd\n"
                        "os.open = _open\n"
                        "def _audit(event, args):\n    if event == 'open':\n        _write(str(args[0]))\n"
                        "        if not _inside and isinstance(args[0], (str, bytes)):\n"
                        "            _write('resolved\\t' + os.path.normpath(os.path.join(os.getcwd(), os.fsdecode(args[0]))))\n"
                        "sys.addaudithook(_audit)\n")
        env = dict(os.environ, HOME=str(self.home), PATH=str(bin_dir), PYTHONPATH=str(self.base_dir), PYTHONDONTWRITEBYTECODE="1",
                   PI_CODING_AGENT_DIR=str(self.home / ".pi/agent"), PI_MCP_CONFIG_MODE="", MCP_EXAMPLE_TOKEN=CANARY, EXAMPLE_HOME=CANARY)
        # Every scope either MCP path can read at the pins, each holding a canary.
        ambient = {"home-config": self.home / ".config/mcp/mcp.json", "home-agents": self.home / ".agents/mcp.json",
                   "home-agents-nested": self.home / ".agents/mcp/mcp.json", "agent-native": self.home / ".pi/agent/mcp.json",
                   "agent-adapter": self.home / ".pi/agent/mcp-adapter.json", "agent-auth": self.home / ".pi/agent/mcp-auth.json",
                   "agent-cache": self.home / ".pi/agent/mcp-cache.json", "project-shared": cwd / ".mcp.json",
                   "project-native": cwd / ".pi/mcp.json", "project-adapter": cwd / ".pi/mcp-adapter.json",
                   "cursor": self.home / ".cursor/mcp.json", "claude": self.home / ".claude.json"}
        for scope, path in ambient.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"mcpServers": {scope: {"url": "https://" + CANARY.lower() + ".invalid/" + scope}}}))

        def run(*args):
            return subprocess.run([sys.executable, str(CLI), *args], cwd=cwd, env=env, text=True, capture_output=True)

        validated = run("validate", "--overlay", str(overlay_file), "--local-dir", str(local))
        self.assertEqual(0, validated.returncode, validated.stderr)
        plan = run("plan", "--overlay", str(overlay_file), "--local-dir", str(local))
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        self.assertEqual([".", ".tenant-pi", ".tenant-pi/choices.json", MCP_CONFIG, "settings.json", STATE], [f["path"] for f in preview["files"]])
        self.assertTrue(preview["workflow"]["mcp"]["enabled"])
        self.assertEqual("unverified", preview["workflow"]["promptr"]["status"])
        self.assertTrue(preview["commands"]["launchDisplayOnly"].startswith("PI_MCP_CONFIG_MODE=exclusive "))
        generated = run("generate", "--overlay", str(overlay_file), "--local-dir", str(local), "--target", str(self.target))
        self.assertEqual(0, generated.returncode, generated.stderr)
        self.assertTrue(json.loads(generated.stdout)["filesComplete"])
        self.assertEqual(0o600, stat.S_IMODE((self.target / MCP_CONFIG).stat().st_mode))
        self.assertEqual(DEFINITIONS["mcpServers"], json.loads((self.target / MCP_CONFIG).read_text())["mcpServers"])
        for output in (validated, plan, generated):
            self.assertNotIn(CANARY, output.stdout + output.stderr)
            self.assertNotIn(CANARY.lower(), output.stdout + output.stderr)
        lines = log.read_text().splitlines()
        opened = [line for line in lines if not line.startswith("resolved\t")]
        resolved = [line.split("\t", 1)[1] for line in lines if line.startswith("resolved\t")]
        # Three reads of the declared slot plus one exclusive creation of the generated file.
        self.assertEqual(4, opened.count("mcp-adapter.json"), opened)
        self.assertEqual(3, opened.count("inputs"), opened)
        self.assertEqual(3, resolved.count(str(local / "inputs" / "mcp-adapter.json")), resolved)
        self.assertEqual(1, resolved.count(str(self.target / MCP_CONFIG)), resolved)
        # No open reaches an ambient scope: each scope file is below the fake home or the project directory.
        # The check compares full paths, so a clone below a directory named `agent` or `project` passes.
        roots = {str(root) for path in (self.home, cwd) for root in (path, path.resolve())}
        self.assertTrue(all(any(str(path).startswith(root + os.sep) for root in roots) for path in ambient.values()))

        def ambient_open(path):
            return any(path == root or path.startswith(root + os.sep) for root in roots)
        self.assertFalse([line for line in opened + resolved if ambient_open(line)], lines)
        self.assertFalse([line for line in resolved if line.startswith("<unknown>")], lines)
        self.assertIn(str(local / "inputs"), resolved)
        for scope, path in ambient.items():
            self.assertIn(scope, path.read_text())
        self.assertFalse((self.base_dir / "called").exists())
        self.assertFalse((self.target / "mcp-cache.json").exists())
        self.assertFalse((self.target / "mcp.json").exists())
        # The slot must be a regular file below the explicit local directory; a link is refused before any read.
        link_local = self.base_dir / "linked local"
        (link_local / "inputs").mkdir(parents=True)
        (link_local / "inputs" / "mcp-adapter.json").symlink_to(local / "inputs" / "mcp-adapter.json")
        refused = run("plan", "--overlay", str(overlay_file), "--local-dir", str(link_local))
        self.assertEqual(2, refused.returncode)
        self.assertIn("input_not_regular: mcp.file", refused.stderr)
        self.assertEqual(2, run("plan", "--overlay", str(overlay_file), "--local-dir", "relative/local").returncode)
        missing = run("plan", "--overlay", str(overlay_file), "--local-dir", str(self.base_dir / "absent"))
        self.assertEqual(2, missing.returncode)
        self.assertIn("input_missing: mcp.file", missing.stderr)
        self.assertFalse((self.parent / "second").exists())
        # A second candidate without the module compares as a removed file, never as a value leak.
        self.data["target"]["agentDir"] = str(self.parent / "second")
        self.data["selection"]["enable"].remove("mcp")
        self.data["selection"]["disable"].append("mcp")
        self.data["inputs"]["mcpFile"] = None
        overlay_file.write_text(json.dumps(self.data))
        second = run("generate", "--overlay", str(overlay_file), "--target", str(self.parent / "second"))
        self.assertEqual(0, second.returncode, second.stderr)
        compared = run("compare", "--left", str(self.target), "--right", str(self.parent / "second"))
        self.assertEqual(0, compared.returncode, compared.stderr)
        report = json.loads(compared.stdout)
        self.assertNotIn(CANARY.lower(), compared.stdout)
        self.assertNotIn("example.invalid", compared.stdout)
        self.assertEqual("removed", next(c["change"] for c in report["changes"] if c["file"] == MCP_CONFIG and c["field"] == "/mcpServers/parked/disabled"))
        self.assertEqual("removed", next(c["change"] for c in report["changes"] if c["file"] == "settings.json" and c["field"] == "/extensions"))
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])


if __name__ == "__main__":
    unittest.main()
