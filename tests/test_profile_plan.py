"""Only in-memory synthetic inputs exercise the pure planner."""
import copy
import json
import re
import shlex
import unittest
from unittest.mock import patch

from scripts.profile_plan import (GLOBAL_INSTALL_WARNING, OUTPUTS, PROVIDER_KEY_NAMES, UNTESTED_PI_FACT, prepare,
                                   provider_key_warning, readiness, runtime_report, setup_commands)
from scripts.check_runtime import parse_range
from tests.test_model_routes import NATIVE, GATEWAY, REGISTRY
from scripts.validate import ROOT, Invalid, load, manifest

TENANTEXT_PACKAGE = str(ROOT / "packages/tenantext")
RUNTIME = load("config/manifest.json")["runtime"]
PIN = RUNTIME["piVersion"]
# A stable patch after the pin's numeric version, including a prerelease pin.
major, minor, patch_number = re.fullmatch(r"([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[0-9A-Za-z.-]+)?", PIN).groups()
IN_RANGE = f"{major}.{minor}.{int(patch_number) + 1}"
NEWER = ".".join(map(str, parse_range(RUNTIME["piAcceptedRange"], "f")[1]))
OLDER = "0.99.2"


def report(pi=PIN, node="24.21.0", python="3.11.2", **status):
    """The `check-runtime` report for these installed versions.

    A keyword such as `pi_status="mismatch"` gives a status other than `match`.
    """
    found = {"pi": pi, "node": node, "python": python}
    required = {"pi": PIN, "node": RUNTIME["nodeRange"], "python": RUNTIME["pythonRange"]}
    result = {key: {"installed": found[key], "required": required[key], "status": status.get(key + "_status", "match")}
              for key in found}
    result["pi"].update(tested=PIN, acceptedRange=RUNTIME["piAcceptedRange"])
    return result


class PlanTests(unittest.TestCase):
    def setUp(self):
        # These are repo-owned synthetic samples, not private client inputs.
        self.manifest = load("config/manifest.json")
        self.overlay = load("config/config.example.json")
        self.overlay["target"]["agentDir"] = "/home/Test User/.pi/.config/new profile"

    def enable(self, cid):
        self.overlay["selection"]["disable"].remove(cid)
        self.overlay["selection"]["enable"].append(cid)

    def routes(self, gateway=None):
        self.enable("model-routing")
        self.overlay["modelRoutes"] = {"schemaVersion": 1, "cycle": [], "gateway": gateway}
        if gateway is not None:
            self.enable("codex-accounts")
            self.overlay["endpoints"]["codex-accounts"] = "https://gateway.example.invalid/v1"
            if gateway["auth"] == "env":
                self.overlay["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"

    def test_native_and_gateway_routes_require_independent_capabilities(self):
        self.routes()
        self.overlay["roles"]["interactive"] = copy.deepcopy(NATIVE)
        self.overlay["modelRoutes"]["cycle"] = [copy.deepcopy(NATIVE),
            {"provider": "fake-native", "model": "another", "thinking": "off"}]
        with self.assertRaisesRegex(Invalid, "registry_required"):
            prepare(self.manifest, self.overlay)
        with self.assertRaisesRegex(Invalid, "unsupported_model_thinking"):
            prepare(self.manifest, self.overlay, registry={})
        result = prepare(self.manifest, self.overlay, registry=REGISTRY, required_roles=("review",))
        settings = result["files"]["settings.json"]["content"]
        self.assertEqual("team/slash-id", settings["defaultModel"])
        self.assertEqual(["fake-native/team/slash-id", "fake-native/another"], settings["enabledModels"])
        self.assertEqual("off", settings["modelThinkingLevels"]["fake-native/another"])
        self.assertEqual("required_missing", result["files"][".tenant-pi/choices.json"]["content"]["roleStatus"]["review"])
        self.assertIn({"code": "required_role_missing", "subject": "review"}, result["readinessGaps"])
        for code in ("model_catalog_unverified", "provider_auth_unverified"):
            self.assertIn({"code": code, "subject": "cycle:fake-native/another"}, result["readinessGaps"])
            self.assertNotIn({"code": code, "subject": "cycle:fake-native/team/slash-id"}, result["readinessGaps"])
        self.overlay["modelRoutes"]["cycle"].reverse()
        with self.assertRaisesRegex(Invalid, "interactive_not_first_in_cycle"):
            prepare(self.manifest, self.overlay, registry=REGISTRY)
        self.overlay["roles"]["interactive"] = None
        result = prepare(self.manifest, self.overlay, registry=REGISTRY)
        for subject in ("cycle:fake-native/another", "cycle:fake-native/team/slash-id"):
            for code in ("model_catalog_unverified", "provider_auth_unverified"):
                self.assertIn({"code": code, "subject": subject}, result["readinessGaps"])
        for auth in ("env", "login"):
            self.overlay = load("config/config.example.json")
            self.overlay["target"]["agentDir"] = "/home/Test User/.pi/.config/new profile"
            self.routes({"auth": auth})
            self.overlay["roles"]["review"] = copy.deepcopy(GATEWAY)
            result = prepare(self.manifest, self.overlay, registry=REGISTRY)
            self.assertEqual(1, len(result["files"]["settings.json"]["content"]["packages"]))
            self.assertEqual(["extensions/codex-accounts/index.ts"],
                             result["files"]["settings.json"]["content"]["packages"][0]["extensions"])
            self.assertEqual({}, {k: v for k, v in result["files"]["settings.json"]["content"].items() if k in ("defaultProvider", "defaultModel", "defaultThinkingLevel")})
            self.assertIn("TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1 env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=", result["commands"]["launch"])
            self.assertEqual(auth == "login", any(g["code"] == "pi_login_blocked" for g in result["readinessGaps"]))

    def test_legacy_reserved_provider_and_disabled_gateway(self):
        self.enable("model-routing")
        self.overlay["roles"]["review"] = {"provider": "litellm-codex", "model": "codex-auto/sol", "thinking": "xhigh"}
        with self.assertRaisesRegex(Invalid, "reserved_provider"):
            prepare(self.manifest, self.overlay)
        self.overlay["roles"] = {}
        self.overlay["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(GATEWAY)], "gateway": None}
        with self.assertRaisesRegex(Invalid, "gateway_disabled"):
            prepare(self.manifest, self.overlay, registry=REGISTRY)

    def test_core_contract_and_pure_no_io(self):
        before = copy.deepcopy((self.manifest, self.overlay))
        with patch("builtins.open", side_effect=AssertionError("I/O")), \
             patch("subprocess.run", side_effect=AssertionError("process")), \
             patch("pathlib.Path.open", side_effect=AssertionError("I/O")), \
             patch("os.mkdir", side_effect=AssertionError("I/O")):
            result = prepare(self.manifest, self.overlay)
        self.assertEqual(before, (self.manifest, self.overlay))
        self.assertEqual(set(OUTPUTS), set(result["files"]))
        self.assertEqual({"mode": "0600", "content": {
            "defaultProjectTrust": "ask", "enableInstallTelemetry": False,
            "enableAnalytics": False, "packages": []}}, result["files"]["settings.json"])
        self.assertEqual(self.overlay, result["files"][".tenant-pi/choices.json"]["content"]["overlay"])
        self.assertEqual(["env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=/home/Test User/.pi/.config/new profile", "pi", "--no-approve"],
                         shlex.split(result["commands"]["launch"]))
        self.assertEqual(["npm", "install", "--global", "--", "@earendil-works/pi-coding-agent@" + PIN],
                         shlex.split(result["commands"]["setup"][0]))
        self.assertIn("target_absence_unverified", [g["code"] for g in result["readinessGaps"]])
        json.loads(json.dumps(result))

    def test_interactive_roles_preserved_and_package_filters(self):
        self.enable("model-routing")
        self.enable("codex-accounts")
        self.overlay["roles"] = {
            "interactive": {"provider": "test-provider", "model": "org/model:v2", "thinking": "xhigh"},
            "worker": {"provider": "test-provider", "model": "org/worker", "thinking": "minimal"},
            "research": {"provider": "test-provider", "model": "org/research", "thinking": "max"},
            "memory": None,
        }
        result = prepare(self.manifest, self.overlay, credential_names={"TENANTEXT_LITELLM_API_KEY"})
        settings = result["files"]["settings.json"]["content"]
        self.assertEqual(("test-provider", "org/model:v2", "xhigh"),
                         tuple(settings[k] for k in ("defaultProvider", "defaultModel", "defaultThinkingLevel")))
        choices = result["files"][".tenant-pi/choices.json"]["content"]
        self.assertEqual(self.overlay["roles"], choices["overlay"]["roles"])
        self.assertEqual([{"source": TENANTEXT_PACKAGE,
                           **self.manifest["components"]["codex-accounts"]["resources"]}], settings["packages"])
        self.assertEqual([], choices["pendingPackages"])
        self.assertEqual(1, len(result["commands"]["setup"]))
        self.assertEqual("role_activation_unavailable", next(g["code"] for g in result["readinessGaps"] if g["subject"] == "worker" and g["code"] == "role_activation_unavailable"))
        serialized = json.dumps(result)
        self.assertNotIn("SECRET_VALUE", serialized)
        self.assertEqual("credential_value_not_checked", next(g["code"] for g in result["readinessGaps"] if g["subject"] == "TENANTEXT_LITELLM_API_KEY"))
        self.assertIn({"code": "package_runtime_unverified", "subject": "codex-accounts"}, result["readinessGaps"])
        # Every manifest gap of an `unverified` component reaches the plan under the component ID.
        for gap in self.manifest["components"]["codex-accounts"]["gaps"]:
            self.assertIn({"code": gap["code"], "subject": "codex-accounts"}, result["readinessGaps"])

    def test_quotes_and_injection(self):
        self.overlay["target"]["agentDir"] = "/tmp/it's a profile"
        quoted = prepare(self.manifest, self.overlay)
        self.assertEqual(["env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=/tmp/it's a profile", "pi", "--no-approve"],
                         shlex.split(quoted["commands"]["launch"]))
        # The line holds the name of the session variable one time, to remove it, and no session path.
        self.assertEqual(1, quoted["commands"]["launch"].count("SESSION_DIR"))
        self.assertNotIn("--session-dir", quoted["commands"]["launch"])
        self.overlay["target"]["agentDir"] = "/tmp/profile;touch INJECTED"
        with self.assertRaisesRegex(Invalid, "absolute_path"):
            prepare(self.manifest, self.overlay)
        self.overlay["target"]["agentDir"] = "/home/Test User/.pi/new profile"
        self.enable("model-routing")
        self.overlay["roles"]["review"] = {"provider": "fake", "model": "$(touch /tmp/INJECTED)", "thinking": "low"}
        with self.assertRaisesRegex(Invalid, "shell_or_template"):
            prepare(self.manifest, self.overlay)
        self.overlay["roles"]["review"]["model"] = "org/review"
        self.enable("codex-accounts")
        result = prepare(self.manifest, self.overlay)
        self.assertEqual("org/review", result["files"][".tenant-pi/choices.json"]["content"]["overlay"]["roles"]["review"]["model"])
        self.assertNotIn("TENANTEXT_LITELLM_API_KEY", result["commands"]["launch"])

    def test_fail_unsupported_and_invalid(self):
        self.overlay["inputs"]["modelsFile"] = "inputs/models.json"
        with self.assertRaisesRegex(Invalid, "unsupported_models_file"):
            prepare(self.manifest, self.overlay)
        self.overlay["inputs"]["modelsFile"] = None
        self.overlay["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
        with self.assertRaisesRegex(Invalid, "unselected_input"):
            prepare(self.manifest, self.overlay)
        self.overlay["inputs"]["mcpFile"] = None
        self.overlay["consent"]["telemetry"] = True
        with self.assertRaisesRegex(Invalid, "telemetry_activation_unavailable"):
            prepare(self.manifest, self.overlay)
        self.overlay["consent"]["telemetry"] = False
        self.overlay["roles"]["interactive"] = {"provider": "fake", "model": "org/id", "thinking": "low"}
        with self.assertRaisesRegex(Invalid, "model_routing_required"):
            prepare(self.manifest, self.overlay)
        self.overlay["roles"] = {}
        self.overlay["unknown"] = "SECRET_VALUE"
        with self.assertRaisesRegex(Invalid, "unknown_fields") as caught:
            prepare(self.manifest, self.overlay)
        self.assertNotIn("SECRET_VALUE", str(caught.exception))
        del self.overlay["unknown"]
        self.enable("tracker-site")
        self.manifest["components"]["tracker-site"].update(status="blocked", reason="Blocked for this test.")
        self.manifest["components"]["tracker-site"]["configOwnership"].update(status="blocked", claims=[])
        with self.assertRaisesRegex(Invalid, "blocked_component"):
            prepare(self.manifest, self.overlay)

    def test_duplicate_identity_and_resource_tamper(self):
        self.enable("codex-accounts")
        self.enable("model-routing")
        self.manifest["components"]["codex-accounts"]["resources"]["extensions"].clear()
        with self.assertRaisesRegex(Invalid, "reviewed_resources"):
            prepare(self.manifest, self.overlay)
        # Pin validation normally prevents duplicate sources; also guard a later
        # reviewed manifest extension from introducing two entries for one identity.
        self.manifest = load("config/manifest.json")
        components = manifest(self.manifest)
        # Tree components share a package on purpose; the guard is for npm and git identities.
        for cid, version in (("promptr", "1.0.0"), ("codex-accounts", "2.0.0")):
            components[cid]["status"] = "tested"
            components[cid]["source"] = {"kind": "npm", "spec": "one-package@" + version}
            components[cid]["configOwnership"]["status"] = "reviewed"
        self.enable("promptr")
        with patch("scripts.profile_plan.manifest", return_value=components):
            with self.assertRaisesRegex(Invalid, "duplicate_package_identity"):
                prepare(self.manifest, self.overlay)

    def test_one_tree_component_declares_the_package_once_with_its_own_filter(self):
        for cid, key, item in (("doctor", "extensions", "extensions/doctor/index.ts"),
                               ("resources", "extensions", "extensions/resources/index.ts"),
                               ("herdr", "skills", "skills/herdr"),
                               ("tracker-site", "skills", "skills/tracker-site")):
            with self.subTest(cid=cid):
                self.setUp()
                self.enable(cid)
                result = prepare(self.manifest, self.overlay)
                expected = {"source": TENANTEXT_PACKAGE, "extensions": [], "skills": [], "prompts": [], "themes": []}
                expected[key] = [item]
                self.assertEqual([expected], result["files"]["settings.json"]["content"]["packages"])
                self.assertTrue((ROOT / "packages/tenantext" / item).exists())
                choices = result["files"][".tenant-pi/choices.json"]["content"]
                self.assertEqual([], choices["pendingPackages"])
                self.assertEqual(1, len(result["commands"]["setup"]))  # No install step: the package is in the kit.
                self.assertIn({"code": "pi_line_unqualified", "subject": cid}, result["readinessGaps"])
                self.assertIn({"code": "kit_test_missing", "subject": cid}, result["readinessGaps"])

    def test_question_extension_is_declared_as_an_npm_package_with_its_setup_lines(self):
        self.enable("questions")
        result = prepare(self.manifest, self.overlay)
        package = {"source": "npm:@juicesharp/rpiv-ask-user-question@2.11.0",
                   "extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []}
        self.assertEqual([package], result["files"]["settings.json"]["content"]["packages"])
        choices = result["files"][".tenant-pi/choices.json"]["content"]
        self.assertEqual([], choices["pendingPackages"])
        agent = "PI_CODING_AGENT_DIR=" + shlex.quote(self.overlay["target"]["agentDir"])
        # `pi install` installs the declared package; the peer override then corrects its `typebox` entry.
        # The line holds the identical source string of `settings.json`.
        self.assertEqual([agent + " pi install " + shlex.quote(package["source"]),
                          agent + " node scripts/patch_extension_peers.mjs"], result["commands"]["setup"][1:])
        self.assertNotIn("pi update --extensions", json.dumps(result["commands"]))
        codes = {gap["code"] for gap in result["readinessGaps"] if gap["subject"] == "questions"}
        self.assertEqual({"package_runtime_unverified", "pi_line_unqualified", "package_source_unreviewed",
                          "peer_package_unverified", "question_ui_unverified", "shared_config_outside_profile",
                          "kit_test_missing"}, codes)
        self.assertNotIn("optional_activation_unavailable", {gap["code"] for gap in result["readinessGaps"]})
        # No file of the profile holds a guidance file of the extension, and the launch line is unchanged.
        self.assertEqual({"settings.json", ".tenant-pi/choices.json"}, set(result["files"]))
        self.assertNotIn("rpiv", result["commands"]["launch"])

    def test_question_extension_follows_the_tree_package_and_precedes_owner_packages(self):
        self.enable("questions")
        self.enable("herdr")
        self.overlay["ownerPackages"] = ["/home/Test User/owner package"]
        packages = prepare(self.manifest, self.overlay)["files"]["settings.json"]["content"]["packages"]
        self.assertEqual([TENANTEXT_PACKAGE, "npm:@juicesharp/rpiv-ask-user-question@2.11.0", "/home/Test User/owner package"],
                         [entry if type(entry) is str else entry["source"] for entry in packages])
        self.assertEqual(["skills/herdr"], packages[0]["skills"])

    def test_tree_components_of_one_package_merge_into_one_declaration(self):
        for cid in ("ops-footer", "context-meter", "herdr", "codex-accounts"):
            self.enable(cid)
        result = prepare(self.manifest, self.overlay)
        self.assertEqual([{"source": TENANTEXT_PACKAGE,
                           "extensions": ["extensions/codex-accounts/index.ts", "extensions/context-meter/index.ts",
                                          "extensions/ops-footer/index.ts"],
                           "skills": ["skills/herdr"], "prompts": [], "themes": []}],
                         result["files"]["settings.json"]["content"]["packages"])
        self.overlay["selection"]["enable"].reverse()
        self.overlay["selection"]["enable"].sort(key=lambda cid: cid != "core")
        self.assertEqual(result["files"]["settings.json"], prepare(self.manifest, self.overlay)["files"]["settings.json"])

    def test_credential_names_never_values(self):
        self.enable("codex-accounts")
        result = prepare(self.manifest, self.overlay)
        self.assertIn({"code": "credential_missing", "subject": "TENANTEXT_LITELLM_API_KEY"}, result["readinessGaps"])
        self.overlay["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"
        with self.assertRaisesRegex(Invalid, "integration_configuration_unavailable"):
            prepare(self.manifest, self.overlay)
        self.overlay["env"] = {}
        for names in ({"SECRET_VALUE"}, "TENANTEXT_LITELLM_API_KEY", {"TENANTEXT_LITELLM_API_KEY": "SECRET_VALUE"}.items()):
            with self.assertRaisesRegex(Invalid, "credential_names") as caught:
                prepare(self.manifest, self.overlay, credential_names=names)
            self.assertNotIn("SECRET_VALUE", str(caught.exception))


class ReadinessTests(unittest.TestCase):
    """The plan gaps after the facts of the caller: a generated target and a `check-runtime` report."""

    def setUp(self):
        self.manifest = load("config/manifest.json")
        self.overlay = load("config/config.example.json")
        self.target = self.overlay["target"]["agentDir"]
        self.plan = prepare(self.manifest, self.overlay)
        self.core = self.manifest["components"]["core"]["source"]["spec"]
        self.fixed = [{"code": "target_absence_unverified", "subject": self.target},
                      {"code": "node_runtime_unverified", "subject": RUNTIME["nodeRange"]},
                      {"code": "core_runtime_unverified", "subject": self.core}]

    def gaps(self, **options):
        return readiness(self.plan, **options)["readinessGaps"]

    def test_no_probe_keeps_the_unverified_gaps(self):
        before = copy.deepcopy(self.plan)
        self.assertEqual(self.fixed, self.plan["readinessGaps"])
        self.assertEqual({"readinessGaps": self.fixed, "runtimeReady": False}, readiness(self.plan))
        # A complete generation proves the absence of the target, and no runtime fact.
        self.assertEqual({"readinessGaps": self.fixed[1:], "runtimeReady": False},
                         readiness(self.plan, generated=True))
        self.assertEqual(before, self.plan)

    def test_match_removes_the_runtime_gaps(self):
        before = copy.deepcopy(self.plan)
        self.assertEqual({"readinessGaps": self.fixed[:1], "runtimeReady": False},
                         readiness(self.plan, report=report()))
        self.assertEqual({"readinessGaps": [], "runtimeReady": False},
                         readiness(self.plan, report=report(), generated=True))
        # The plan that the writer rebuilds does not change with the report.
        self.assertEqual(before, self.plan)
        self.assertEqual(before, prepare(self.manifest, self.overlay))

    def test_mismatch_names_the_installed_and_the_required_version(self):
        pi = {"code": "core_runtime_mismatch", "subject": self.core, "installed": NEWER, "required": PIN}
        for generated in (False, True):
            result = readiness(self.plan, report=report(pi=NEWER, pi_status="mismatch"), generated=generated)
            self.assertEqual(([] if generated else self.fixed[:1]) + [pi], result["readinessGaps"])
            self.assertFalse(result["runtimeReady"])
        both = self.gaps(report=report(pi=OLDER, node="22.22.3", pi_status="mismatch", node_status="mismatch"),
                         generated=True)
        self.assertEqual([{"code": "node_runtime_mismatch", "subject": RUNTIME["nodeRange"], "installed": "22.22.3",
                           "required": RUNTIME["nodeRange"]},
                          {"code": "core_runtime_mismatch", "subject": self.core, "installed": OLDER, "required": PIN}],
                         both)

    def test_accepted_untested_pi_keeps_an_explicit_gap(self):
        data = report(pi=IN_RANGE, pi_status="untested_in_range")
        runtime_report(data, RUNTIME)
        expected = {"code": "core_runtime_untested_in_range", "subject": self.core,
                    "installed": IN_RANGE, "required": PIN, "tested": PIN,
                    "acceptedRange": RUNTIME["piAcceptedRange"], "fact": UNTESTED_PI_FACT}
        before = copy.deepcopy(self.plan)
        for generated in (False, True):
            result = readiness(self.plan, report=data, generated=generated)
            self.assertEqual(([] if generated else self.fixed[:1]) + [expected], result["readinessGaps"])
            self.assertFalse(result["runtimeReady"])
        self.assertIn("The kit tests ran on the tested version only.", expected["fact"])
        self.assertEqual(before, self.plan)

    def test_absent_pi_is_a_missing_gap(self):
        result = readiness(self.plan, report=report(pi=None, pi_status="missing"), generated=True)
        self.assertEqual([{"code": "core_runtime_missing", "subject": self.core, "installed": None, "required": PIN}],
                         result["readinessGaps"])
        self.assertFalse(result["runtimeReady"])
        absent = report(pi=None, node=None, pi_status="missing", node_status="missing")
        self.assertEqual(["node_runtime_missing", "core_runtime_missing"],
                         [g["code"] for g in self.gaps(report=absent, generated=True)])

    def test_unparsed_is_a_measured_state_and_python_adds_no_gap(self):
        unparsed = report(pi=None, node=None, pi_status="unparsed", node_status="unparsed")
        self.assertEqual(["node_runtime_unparsed", "core_runtime_unparsed"],
                         [g["code"] for g in self.gaps(report=unparsed, generated=True)])
        # Python runs the kit, not the profile: its status changes no gap.
        for python, status in (("3.10.14", "mismatch"), (None, "missing"), (None, "unparsed")):
            self.assertEqual({"readinessGaps": [], "runtimeReady": False},
                             readiness(self.plan, report=report(python=python, python_status=status), generated=True))

    def test_another_gap_keeps_runtime_ready_false(self):
        self.overlay["selection"]["disable"].remove("doctor")
        self.overlay["selection"]["enable"].append("doctor")
        self.plan = prepare(self.manifest, self.overlay)
        result = readiness(self.plan, report=report(), generated=True)
        self.assertEqual(self.plan["readinessGaps"][3:], result["readinessGaps"])
        self.assertIn({"code": "package_runtime_unverified", "subject": "doctor"}, result["readinessGaps"])
        self.assertFalse(result["runtimeReady"])

    def test_report_is_validated_against_the_manifest_runtime(self):
        for good in (report(), report(pi=NEWER, pi_status="mismatch"), report(pi=PIN + "-beta.1", pi_status="mismatch"),
                     report(pi=IN_RANGE, pi_status="untested_in_range"),
                     report(pi=IN_RANGE + "-rc.1", pi_status="untested_in_range"),
                     report(node="24.0.0-rc.1", node_status="mismatch"), report(python="3.14.0rc1"),
                     report(pi=None, node=None, python=None, pi_status="missing", node_status="unparsed",
                            python_status="missing")):
            self.assertIs(good, runtime_report(good, RUNTIME))
        canary = "CANARY_SECRET"

        def changed(key, field, value):
            data = report()
            data[key][field] = value
            return data

        cases = [(None, "object: runtime_report"), ([], "object: runtime_report"), ({}, "required_fields: runtime_report"),
                 ({**report(), "npm": report()["pi"]}, "unknown_fields: runtime_report"),
                 ({**report(), "pi": canary}, "object: runtime_report.pi"),
                 ({**report(), "pi": {"installed": PIN, "status": "match"}}, "required_fields: runtime_report.pi"),
                 ({**report(), "pi": {**report()["pi"], canary: 1}}, "unknown_fields: runtime_report.pi"),
                 # A report of another pin or range is not evidence for this manifest.
                 (changed("pi", "required", OLDER), "runtime_report_required: runtime_report.pi.required"),
                 (changed("pi", "tested", OLDER), "runtime_report_required: runtime_report.pi.tested"),
                 (changed("pi", "acceptedRange", ">=0.0.0 <99"), "runtime_report_required: runtime_report.pi.acceptedRange"),
                 (changed("pi", "status", "untested_in_range"), "runtime_report_status: runtime_report.pi.status"),
                 (changed("node", "status", "untested_in_range"), "runtime_report_status: runtime_report.node.status"),
                 (report(pi=None, pi_status="untested_in_range"), "runtime_report_installed: runtime_report.pi.installed"),
                 (report(pi=IN_RANGE, pi_status="mismatch"), "runtime_report_status: runtime_report.pi.status"),
                 (report(pi=NEWER, pi_status="untested_in_range"), "runtime_report_status: runtime_report.pi.status"),
                 (changed("node", "required", ">=20"), "runtime_report_required: runtime_report.node.required"),
                 (changed("python", "required", None), "runtime_report_required: runtime_report.python.required"),
                 (changed("pi", "status", "ok"), "runtime_report_status: runtime_report.pi.status"),
                 (changed("pi", "status", ["match"]), "runtime_report_status: runtime_report.pi.status"),
                 # The status must agree with the two versions of its entry.
                 (changed("pi", "installed", NEWER), "runtime_report_status: runtime_report.pi.status"),
                 (changed("pi", "status", "mismatch"), "runtime_report_status: runtime_report.pi.status"),
                 (changed("node", "installed", "22.22.3"), "runtime_report_status: runtime_report.node.status"),
                 (changed("node", "status", "mismatch"), "runtime_report_status: runtime_report.node.status"),
                 (changed("python", "installed", "3.10.14"), "runtime_report_status: runtime_report.python.status"),
                 (changed("pi", "installed", None), "runtime_report_installed: runtime_report.pi.installed"),
                 (changed("pi", "status", "missing"), "runtime_report_installed: runtime_report.pi.installed"),
                 (changed("node", "status", "unparsed"), "runtime_report_installed: runtime_report.node.installed")]
        # `installed` is one version token of the `check-runtime` grammar, and nothing else.
        cases += [(changed("pi", "installed", bad), "runtime_report_installed: runtime_report.pi.installed")
                  for bad in ("", "v" + PIN, " " + PIN, PIN + "\n", "pi " + PIN, PIN + " " + canary, canary, 1, [PIN],
                              PIN + "-" + "a" * 40, PIN + "\u00e9")]
        for data, error in cases:
            with self.subTest(error=error, data=str(data)[:40]):
                with self.assertRaises(Invalid) as caught:
                    runtime_report(data, RUNTIME)
                self.assertEqual(error, str(caught.exception))
                self.assertNotIn(canary, str(caught.exception))

    def test_validation_and_readiness_are_pure(self):
        with patch("builtins.open", side_effect=AssertionError("I/O")), \
             patch("subprocess.run", side_effect=AssertionError("process")), \
             patch("subprocess.Popen", side_effect=AssertionError("process")), \
             patch("pathlib.Path.open", side_effect=AssertionError("I/O")), \
             patch("os.mkdir", side_effect=AssertionError("I/O")), \
             patch("tempfile.mkdtemp", side_effect=AssertionError("I/O")):
            data = runtime_report(report(pi=NEWER, pi_status="mismatch"), RUNTIME)
            result = readiness(self.plan, report=data, generated=True)
        self.assertEqual(["core_runtime_mismatch"], [g["code"] for g in result["readinessGaps"]])
        json.loads(json.dumps(result))


class PiInstallTests(unittest.TestCase):
    """The mark of the global Pi install line: it must not suggest a silent replacement of the installed Pi."""

    def setUp(self):
        self.manifest = load("config/manifest.json")
        self.overlay = load("config/config.example.json")
        self.plan = prepare(self.manifest, self.overlay)
        self.line = "npm install --global -- @earendil-works/pi-coding-agent@" + PIN

    def mark(self, status, installed=None, change=None):
        return {"command": self.line, "status": status, "installed": installed, "required": PIN, "change": change,
                "warning": "global_install_replaces_pi_for_all_profiles"}

    def test_no_report_marks_the_unknown_version_and_keeps_the_line(self):
        before = copy.deepcopy(self.plan)
        self.assertEqual([self.line], self.plan["commands"]["setup"])
        self.assertEqual({"setup": [self.line], "piInstall": self.mark("installed_version_unknown")},
                         setup_commands(self.plan))
        self.assertEqual("global_install_replaces_pi_for_all_profiles", GLOBAL_INSTALL_WARNING)
        # A report without a readable Pi version knows as little as no report.
        self.assertEqual(setup_commands(self.plan), setup_commands(self.plan, report(pi=None, pi_status="unparsed")))
        self.assertEqual(before, self.plan)

    def test_match_marks_the_line_as_not_needed(self):
        self.assertEqual({"setup": [], "piInstall": self.mark("not_needed", PIN)},
                         setup_commands(self.plan, report()))

    def test_accepted_untested_pi_needs_no_replacement(self):
        for installed in (IN_RANGE, IN_RANGE + "-rc.1"):
            with self.subTest(installed=installed):
                data = report(pi=installed, pi_status="untested_in_range")
                runtime_report(data, RUNTIME)
                self.assertEqual({"setup": [], "piInstall": self.mark("not_needed", installed)},
                                 setup_commands(self.plan, data))
                self.assertEqual([self.line], self.plan["commands"]["setup"])

    def test_newer_installed_marks_a_downgrade(self):
        result = setup_commands(self.plan, report(pi=NEWER, pi_status="mismatch"))
        self.assertEqual({"setup": [], "piInstall": self.mark("replaces_installed", NEWER, "downgrade")}, result)
        for newer in (f"{int(major) + 1}.0.0", f"{major}.{int(minor) + 2}.0", NEWER + "-rc.1"):
            self.assertEqual("downgrade",
                             setup_commands(self.plan, report(pi=newer, pi_status="mismatch"))["piInstall"]["change"])

    def test_older_installed_marks_an_upgrade(self):
        result = setup_commands(self.plan, report(pi=OLDER, pi_status="mismatch"))
        self.assertEqual({"setup": [], "piInstall": self.mark("replaces_installed", OLDER, "upgrade")}, result)
        # A prerelease of the pin is before the pin.
        for older in ("0.9.10", "1.0.0", PIN + "-beta.1"):
            self.assertEqual("upgrade",
                             setup_commands(self.plan, report(pi=older, pi_status="mismatch"))["piInstall"]["change"])
        # Build text differs from the tested token, but does not change range acceptance.
        result = setup_commands(self.plan, report(pi=PIN + "+build.5", pi_status="untested_in_range"))
        self.assertEqual({"setup": [], "piInstall": self.mark("not_needed", PIN + "+build.5")}, result)

    def test_absent_pi_marks_the_line_as_needed(self):
        self.assertEqual({"setup": [self.line], "piInstall": self.mark("needed")},
                         setup_commands(self.plan, report(pi=None, pi_status="missing")))

    def test_only_the_pi_line_leaves_the_setup_lines(self):
        # The lines of the npm modules stay in each case; a synthetic second line stands for them.
        other = "PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/new-agent pi install npm:example-package"
        self.plan["commands"]["setup"].append(other)
        self.assertEqual([self.line, other], setup_commands(self.plan)["setup"])
        self.assertEqual([self.line, other], setup_commands(self.plan, report(pi=None, pi_status="missing"))["setup"])
        self.assertEqual([other], setup_commands(self.plan, report())["setup"])
        self.assertEqual([other], setup_commands(self.plan, report(pi=NEWER, pi_status="mismatch"))["setup"])
        # Node and Python do not change the mark of the Pi line.
        self.assertEqual(setup_commands(self.plan, report()),
                         setup_commands(self.plan, report(node="22.22.3", python=None, node_status="mismatch",
                                                          python_status="missing")))

    def test_mark_is_pure(self):
        with patch("builtins.open", side_effect=AssertionError("I/O")), \
             patch("subprocess.run", side_effect=AssertionError("process")), \
             patch("subprocess.Popen", side_effect=AssertionError("process")), \
             patch("os.mkdir", side_effect=AssertionError("I/O")):
            result = setup_commands(self.plan, report(pi=NEWER, pi_status="mismatch"))
        json.loads(json.dumps(result))


class ProviderKeyWarningTests(unittest.TestCase):
    """The warning for a provider key variable of the launching shell. Each input is a synthetic name list."""

    def test_set_variables_give_a_warning_with_names_only(self):
        value = "synthetic-value-not-a-key"
        environment = {"OPENAI_API_KEY": value, "ANTHROPIC_BASE_URL": value, "HOME": "/home/EXAMPLE_USER",
                       "UNRELATED_API_KEY": value}
        result = provider_key_warning(list(environment))
        self.assertEqual("provider_key_in_launching_environment", result["code"])
        # The order is the order of the constant, not of the caller.
        self.assertEqual(["ANTHROPIC_BASE_URL", "OPENAI_API_KEY"], result["variables"])
        self.assertIn("profile with no login", result["fact"])
        self.assertIn("--model '<provider>/<model>'", result["remedy"])
        self.assertNotIn(value, json.dumps(result))
        for name in PROVIDER_KEY_NAMES:
            with self.subTest(name=name):
                self.assertEqual([name], provider_key_warning({name})["variables"])

    def test_no_known_variable_gives_no_warning(self):
        for names in ((), ["HOME", "PATH", "TENANTEXT_LITELLM_API_KEY", "UNRELATED_API_KEY", "openai_api_key"]):
            with self.subTest(names=names):
                self.assertIsNone(provider_key_warning(names))

    def test_warning_is_pure(self):
        with patch("builtins.open", side_effect=AssertionError("I/O")), \
             patch("os.environ", new=None), \
             patch("subprocess.run", side_effect=AssertionError("process")):
            result = provider_key_warning(["GROQ_API_KEY"])
        json.loads(json.dumps(result))


if __name__ == "__main__":
    unittest.main()
