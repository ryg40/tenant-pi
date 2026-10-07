"""Synthetic, offline memory-module contract tests: consent, activation, rendering, publication."""
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
from scripts.memory_modules import HERMES_CONFIG, WIKI_NO_AUTH_KEY, render_memory, validate_memory
from scripts.profile_plan import prepare
from scripts.profile_write import STATE, WriteError, write
from scripts.validate import Invalid, load, manifest, overlay
from tests.test_model_routes import REGISTRY

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
PIN = load(ROOT / "config/manifest.json")["runtime"]["piVersion"]
CANARY = "CANARY_SECRET"
MEMORY_ROLE = {"provider": "fake-native", "model": "team/slash-id", "thinking": "high"}
GATEWAY_ROLE = {"provider": "litellm-codex", "model": "codex-auto/sol", "thinking": "xhigh", "route": "gateway"}
HERMES_ON = {"backgroundReview": True, "reviewTransport": "direct"}
HERMES_OFF = {"backgroundReview": False}
WIKI_OFF = {"ambientPersonalVault": False, "backgroundTasks": False}
EMBEDDING = {"provider": "openai-compatible", "baseUrl": "https://embeddings.example.invalid/v1",
             "model": "text-embedding-ada-002", "auth": {"envVar": "EXAMPLE_EMBEDDING_KEY"}, "expectedDimensions": 1536}
OPENVIKING = {"captureToolResults": True, "recallContextTimeoutMs": 5000}
OPENVIKING_DIR = "packages/openviking-pi"


class MemoryContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest_data = load(ROOT / "config/manifest.json")
        cls.components = manifest(cls.manifest_data)

    def base(self, *modules, consent=None, memory=None):
        data = load(ROOT / "config/config.example.json")
        data["target"]["agentDir"] = "/home/Test User/.pi/.config/new profile"
        for cid in modules:
            data["selection"]["disable"].remove(cid)
            data["selection"]["enable"].append(cid)
        data["consent"]["memoryCapture"] = bool(modules) if consent is None else consent
        if memory is not None:
            data["memory"] = {"schemaVersion": 1, "hermes": None, "wiki": None, "openviking": None, **memory}
        return data

    def error(self, data, rule, **kwargs):
        with self.assertRaisesRegex(Invalid, "^" + rule + ":") as ctx:
            overlay(data, self.components)
            prepare(self.manifest_data, data, **kwargs)
        self.assertNotIn(CANARY, str(ctx.exception))

    def test_default_generation_emits_no_memory_module(self):
        data = self.base()
        plan = prepare(self.manifest_data, data)
        settings = plan["files"]["settings.json"]["content"]
        self.assertEqual([], settings["packages"])
        self.assertNotIn("llm-wiki", settings)
        self.assertNotIn(HERMES_CONFIG, plan["files"])
        self.assertIsNone(plan["files"][".tenant-pi/choices.json"]["content"]["memory"])
        # A `memory` block with every module null is inert.
        data = self.base(consent=False, memory={})
        overlay(data, self.components)
        self.assertIsNone(prepare(self.manifest_data, data)["files"][".tenant-pi/choices.json"]["content"]["memory"])

    def test_no_consent_blocks_every_memory_module(self):
        for cid, choice in (("hermes", HERMES_OFF), ("wiki", WIKI_OFF)):
            with self.subTest(cid=cid):
                self.error(self.base(cid, consent=False, memory={cid: choice}), "memory_consent_required")
        # Consent alone activates nothing, and choices without selection are rejected.
        self.error(self.base(consent=True), "memory_disabled")
        self.error(self.base(consent=True, memory={"hermes": HERMES_OFF}), "memory_disabled")
        self.error(self.base("hermes", memory={"hermes": HERMES_OFF, "wiki": WIKI_OFF}), "memory_module_disabled")
        # Selection without explicit choices is rejected.
        self.error(self.base("hermes"), "memory_choices_required")
        self.error(self.base("hermes", memory={}), "memory_choices_required")

    def openviking(self, *others, remote=True, memory=None, **kwargs):
        """An overlay with `openviking` selected; `remote` is `consent.remoteMemoryWrites`."""
        data = self.base("openviking", *others, memory={"openviking": copy.deepcopy(OPENVIKING)} if memory is None else memory,
                         **kwargs)
        data["consent"]["remoteMemoryWrites"] = remote
        return data

    def test_openviking_needs_selection_and_both_consents(self):
        # The remote consent has no consumer without the module.
        data = self.base("hermes", memory={"hermes": HERMES_OFF})
        data["consent"]["remoteMemoryWrites"] = True
        self.error(data, "remote_memory_disabled")
        data = self.base()
        data["consent"]["remoteMemoryWrites"] = True
        self.error(data, "memory_disabled")
        # Choices without selection, with and without consent.
        self.error(self.base(consent=False, memory={"openviking": copy.deepcopy(OPENVIKING)}), "memory_module_disabled")
        # Selection without consent; then the capture consent without the remote consent.
        self.error(self.openviking(consent=False, remote=False), "memory_consent_required")
        self.error(self.openviking(consent=False), "memory_consent_required")
        self.error(self.openviking(remote=False), "remote_memory_consent_required")
        # Selection and both consents without choices.
        self.error(self.openviking(memory={}), "memory_choices_required")
        data = self.openviking()
        del data["memory"]
        self.error(data, "memory_choices_required")
        overlay(self.openviking(), self.components)
        component = self.components["openviking"]
        self.assertEqual(("unverified", {"kind": "tree", "path": OPENVIKING_DIR}, "Apache-2.0"),
                         (component["status"], component["source"], component["license"]))
        self.assertEqual([{"file": "settings.json", "key": "package:" + OPENVIKING_DIR + ":index.ts"}],
                         component["configOwnership"]["claims"])

    def test_openviking_renders_the_package_and_the_two_launch_variables(self):
        data = self.openviking("hermes", "promptr", memory={"openviking": copy.deepcopy(OPENVIKING), "hermes": HERMES_OFF})
        overlay(data, self.components)
        before = copy.deepcopy(data)
        plan = prepare(self.manifest_data, data)
        self.assertEqual(before, data)
        settings = plan["files"]["settings.json"]["content"]
        # The in-tree packages first, then the memory packages in their order.
        self.assertEqual([str(ROOT / "packages/promptr"), "npm:pi-hermes-memory", str(ROOT / OPENVIKING_DIR)],
                         [package["source"] for package in settings["packages"]])
        self.assertEqual({"source": str(ROOT / OPENVIKING_DIR), "extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []},
                         settings["packages"][-1])
        self.assertTrue((ROOT / OPENVIKING_DIR / "index.ts").is_file())
        target = "PI_CODING_AGENT_DIR=/home/Test User/.pi/.config/new profile"
        self.assertEqual(["OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=5000", "OPENVIKING_CAPTURE_TOOL_RESULTS=true", "env", "-u",
                          "PI_CODING_AGENT_SESSION_DIR", target, "pi", "--no-approve"], shlex.split(plan["commands"]["launch"]))
        memory = plan["files"][".tenant-pi/choices.json"]["content"]["memory"]
        self.assertEqual({"enabled": True, "localCapture": False, "backgroundModelCalls": False, "remoteWrites": True,
                          "captureToolResults": True}, memory["activation"]["openviking"])
        self.assertFalse(memory["activation"]["hermes"]["remoteWrites"])
        self.assertEqual([{"kind": "process_environment", "name": "OPENVIKING_CAPTURE_TOOL_RESULTS",
                           "instruction": "OPENVIKING_CAPTURE_TOOL_RESULTS=true"},
                          {"kind": "process_environment", "name": "OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS",
                           "instruction": "OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=5000"}], memory["setup"])
        # The variable names are the names of the schema that the vendored extension reads.
        schema = (ROOT / OPENVIKING_DIR / "shared/config-schema.mjs").read_text(encoding="utf-8")
        for key, name, kind in (("captureToolResults", "OPENVIKING_CAPTURE_TOOL_RESULTS", "bool"),
                                ("recallContextTimeoutMs", "OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS", "int")):
            line = next(line for line in schema.splitlines() if '{ name: "' + key + '",' in line)
            self.assertIn('env: "' + name + '"', line)
            self.assertIn('type: "' + kind + '"', line)
        self.assertIn("min: 0, max: 600000", next(line for line in schema.splitlines() if '{ name: "recallContextTimeoutMs",' in line))
        # The gaps of the manifest, one time each, and no peer override for this package.
        gaps = [(g["code"], g["subject"]) for g in plan["readinessGaps"] if g["subject"] == "openviking"]
        self.assertEqual([*((gap["code"], "openviking") for gap in self.components["openviking"]["gaps"]),
                          ("shared_home_state", "openviking")], gaps)
        self.assertEqual({"install_step_required", "server_required", "package_runtime_unverified", "kit_test_missing",
                          "capture_cost_unmeasured", "shared_home_state"}, {code for code, _ in gaps})
        self.assertIn({"code": "peer_override_required", "subject": "hermes"}, plan["readinessGaps"])
        agent = "PI_CODING_AGENT_DIR=" + shlex.quote(data["target"]["agentDir"])
        self.assertEqual(["npm install --global -- @earendil-works/pi-coding-agent@" + PIN,
                          agent + " pi update --extensions", agent + " node scripts/patch_extension_peers.mjs",
                          "npm --prefix " + shlex.quote(str(ROOT / OPENVIKING_DIR)) + " ci --ignore-scripts"],
                         plan["commands"]["setup"])
        # The module alone: no npm package to reconcile, no peer override, no file of its own.
        data = self.openviking(memory={"openviking": {"captureToolResults": False}})
        overlay(data, self.components)
        plan = prepare(self.manifest_data, data)
        self.assertEqual(["npm install --global -- @earendil-works/pi-coding-agent@" + PIN,
                          "npm --prefix " + shlex.quote(str(ROOT / OPENVIKING_DIR)) + " ci --ignore-scripts"],
                         plan["commands"]["setup"])
        self.assertEqual({"settings.json", ".tenant-pi/choices.json"}, set(plan["files"]))
        self.assertEqual([str(ROOT / OPENVIKING_DIR)], [p["source"] for p in plan["files"]["settings.json"]["content"]["packages"]])
        # Both states of the switch are written; the optional number is absent when the overlay has none.
        self.assertEqual(["OPENVIKING_CAPTURE_TOOL_RESULTS=false", "env", "-u", "PI_CODING_AGENT_SESSION_DIR", target, "pi",
                          "--no-approve"], shlex.split(plan["commands"]["launch"]))
        self.assertFalse(plan["files"][".tenant-pi/choices.json"]["content"]["memory"]["activation"]["openviking"]["captureToolResults"])
        # No generated file holds a credential, an endpoint, or a setting of the extension beside the two.
        dump = json.dumps({name: plan["files"][name]["content"] for name in plan["files"]})
        for word in ("OPENVIKING_API_KEY", "OPENVIKING_URL", "ovcli.conf", "apiKey", "endpoint\":"):
            self.assertNotIn(word, dump.replace(json.dumps(self.manifest_data["components"]["openviking"]["gaps"])[1:-1], ""), word)
        rendered = render_memory(data, self.components)
        self.assertEqual(({}, {}), (rendered["settings"], rendered["files"]))
        validate_memory(data, self.components)

    def test_openviking_invalid_choice_shapes_and_canaries(self):
        for change, rule in ((lambda o: o.update(captureToolResults="true"), "boolean"),
                             (lambda o: o.update(captureToolResults=1), "boolean"),
                             (lambda o: o.pop("captureToolResults"), "required_fields"),
                             (lambda o: o.update(recallContextTimeoutMs=CANARY), "timeout_ms"),
                             (lambda o: o.update(recallContextTimeoutMs=True), "timeout_ms"),
                             (lambda o: o.update(recallContextTimeoutMs=5000.0), "timeout_ms"),
                             (lambda o: o.update(recallContextTimeoutMs=-1), "timeout_ms"),
                             (lambda o: o.update(recallContextTimeoutMs=600001), "timeout_ms"),
                             (lambda o: o.update(apiKey=CANARY), "unknown_fields"),
                             (lambda o: o.update(endpoint="https://" + CANARY + ".example.invalid"), "unknown_fields"),
                             (lambda o: o.update(takeover={"enabled": True}), "unknown_fields")):
            with self.subTest(rule=rule):
                data = self.openviking()
                change(data["memory"]["openviking"])
                self.error(data, rule)
        for value in (CANARY, [CANARY], 7, True):
            with self.subTest(value=type(value).__name__):
                self.error(self.openviking(memory={"openviking": value}), "object")
        # The bounds of the schema are valid values; 0 keeps the default of the extension.
        for value in (0, 600000):
            data = self.openviking(memory={"openviking": {"captureToolResults": True, "recallContextTimeoutMs": value}})
            overlay(data, self.components)
            self.assertIn("OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=" + str(value), shlex.split(prepare(self.manifest_data, data)["commands"]["launch"]))
        # An endpoint or a credential name for the module is not an overlay field either.
        data = self.openviking()
        data["endpoints"]["openviking"] = "https://openviking.example.invalid"
        self.error(data, "integration_configuration_unavailable")
        data = self.openviking()
        data["env"]["openviking"] = "${OPENVIKING_API_KEY}"
        self.error(data, "undeclared_env")
        self.assertEqual([], self.components["openviking"]["env"])

    def test_local_only_consent_disables_every_background_model_path(self):
        data = self.base("hermes", "wiki", memory={"hermes": HERMES_OFF, "wiki": WIKI_OFF})
        overlay(data, self.components)
        plan = prepare(self.manifest_data, data)
        settings = plan["files"]["settings.json"]["content"]
        self.assertEqual([{"source": "npm:pi-hermes-memory", "extensions": ["src/index.ts"], "skills": [], "prompts": [], "themes": []},
                          {"source": "npm:@zosmaai/pi-llm-wiki", "extensions": ["extensions"], "skills": [], "prompts": [], "themes": []}],
                         settings["packages"])
        self.assertEqual({"ambientPersonalVault": False, "trajectories": False}, settings["llm-wiki"])
        self.assertEqual({"reviewEnabled": False, "correctionDetection": False, "flushOnCompact": False,
                          "flushOnShutdown": False, "memoryOverflowStrategy": "reject", "autoConsolidate": False},
                         plan["files"][HERMES_CONFIG]["content"])
        for key in ("llmModelOverride", "llmThinkingOverride", "childExtensionPaths", "reviewTransport"):
            self.assertNotIn(key, plan["files"][HERMES_CONFIG]["content"])
        memory = plan["files"][".tenant-pi/choices.json"]["content"]["memory"]
        self.assertEqual({"enabled": True, "localCapture": True, "backgroundModelCalls": False, "remoteWrites": False},
                         memory["activation"]["hermes"])
        self.assertEqual({"enabled": True, "localCapture": True, "ambientPersonalVault": False, "backgroundModelCalls": False,
                          "remoteWrites": False, "personalVault": "home",
                          "embeddings": {"enabled": False, "writeTimeRequests": False, "queryTimeRequests": False,
                                         "backfill": "separate action"}}, memory["activation"]["wiki"])
        self.assertEqual({"enabled": False}, memory["activation"]["openviking"])
        codes = {(g["code"], g["subject"]) for g in plan["readinessGaps"]}
        for expected in (("package_runtime_unverified", "hermes"), ("package_runtime_unverified", "wiki"),
                         ("peer_override_required", "hermes"), ("peer_override_required", "wiki"),
                         ("native_addon_unverified", "better-sqlite3"), ("shared_home_state", "wiki"),
                         ("session_backfill_scope_unverified", "hermes"), ("project_settings_override", "wiki")):
            self.assertIn(expected, codes)
        self.assertNotIn(("child_provider_unverified", "hermes"), codes)
        self.assertEqual(["npm install --global -- @earendil-works/pi-coding-agent@" + PIN,
                          "PI_CODING_AGENT_DIR=" + shlex.quote(data["target"]["agentDir"]) + " pi update --extensions",
                          "PI_CODING_AGENT_DIR=" + shlex.quote(data["target"]["agentDir"]) + " node scripts/patch_extension_peers.mjs"],
                         plan["commands"]["setup"])
        self.assertTrue(plan["commands"]["launch"].startswith("env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="))

    def test_background_model_calls_require_a_memory_role_and_a_child_provider(self):
        self.error(self.base("hermes", memory={"hermes": HERMES_ON}), "memory_role_required")
        data = self.base("wiki", memory={"wiki": {**WIKI_OFF, "backgroundTasks": True}})
        self.error(data, "memory_role_required")
        # Wiki accepts only four task thinking levels.
        data["roles"]["memory"] = {**MEMORY_ROLE, "thinking": "off"}
        self.error(data, "unsupported_wiki_thinking")
        data["roles"]["memory"] = copy.deepcopy(MEMORY_ROLE)
        overlay(data, self.components)
        plan = prepare(self.manifest_data, data)
        self.assertEqual({"ambientPersonalVault": False, "trajectories": False,
                          "taskModel": {"provider": "fake-native", "id": "team/slash-id"}, "taskThinkingLevel": "high"},
                         plan["files"]["settings.json"]["content"]["llm-wiki"])
        self.assertNotIn({"code": "role_activation_unavailable", "subject": "memory"}, plan["readinessGaps"])
        self.assertIn({"code": "provider_auth_unverified", "subject": "memory"}, plan["readinessGaps"])
        # Hermes: a native provider needs no child source; llama.cpp needs the built-in; a gateway needs a package path.
        data = self.base("hermes", memory={"hermes": HERMES_ON})
        data["roles"]["memory"] = copy.deepcopy(MEMORY_ROLE)
        overlay(data, self.components)
        config = prepare(self.manifest_data, data)["files"][HERMES_CONFIG]["content"]
        self.assertEqual({"reviewEnabled": True, "correctionDetection": True, "flushOnCompact": True, "flushOnShutdown": True,
                          "memoryOverflowStrategy": "auto-consolidate", "autoConsolidate": True, "reviewTransport": "direct",
                          "llmModelOverride": "fake-native/team/slash-id", "llmThinkingOverride": "high"}, config)
        data["roles"]["memory"] = {"provider": "llama.cpp", "model": "local", "thinking": "low"}
        self.error(data, "missing_child_provider")
        data["memory"]["hermes"] = {**HERMES_ON, "reviewTransport": "subprocess", "childExtensionPaths": ["builtin:llama.cpp"]}
        overlay(data, self.components)
        plan = prepare(self.manifest_data, data)
        self.assertEqual(["builtin:llama.cpp"], plan["files"][HERMES_CONFIG]["content"]["childExtensionPaths"])
        self.assertIn({"code": "child_provider_unverified", "subject": "hermes"}, plan["readinessGaps"])
        self.assertEqual({"reviewTransport": "subprocess", "childExtensionSources": 1},
                         {k: plan["files"][".tenant-pi/choices.json"]["content"]["memory"]["activation"]["hermes"][k]
                          for k in ("reviewTransport", "childExtensionSources")})
        data["roles"]["memory"] = {"provider": "openai-codex-2", "model": "gpt", "thinking": "low"}
        self.error(data, "missing_child_provider")
        data["memory"]["hermes"]["childExtensionPaths"] = ["/home/Test User/new profile/git/tenantext/extensions/codex-accounts/index.ts"]
        data["selection"]["disable"].remove("codex-accounts")
        data["selection"]["enable"].append("codex-accounts")
        overlay(data, self.components)
        prepare(self.manifest_data, data)

    def test_gateway_memory_role_with_routes(self):
        data = self.base("hermes", "model-routing", "codex-accounts", memory={"hermes": {**HERMES_ON, "childExtensionPaths": [
            "/home/Test User/new profile/git/tenantext/extensions/codex-accounts/index.ts"]}})
        data["modelRoutes"] = {"schemaVersion": 1, "cycle": [], "gateway": {"auth": "env"}}
        data["endpoints"]["codex-accounts"] = "https://gateway.example.invalid/v1"
        data["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"
        data["roles"]["memory"] = copy.deepcopy(GATEWAY_ROLE)
        overlay(data, self.components)
        plan = prepare(self.manifest_data, data, registry=REGISTRY)
        self.assertEqual("litellm-codex/codex-auto/sol", plan["files"][HERMES_CONFIG]["content"]["llmModelOverride"])
        self.assertEqual("packages/tenantext", "/".join(plan["files"]["settings.json"]["content"]["packages"][0]["source"].split("/")[-2:]))
        self.assertEqual(["extensions/codex-accounts/index.ts"], plan["files"]["settings.json"]["content"]["packages"][0]["extensions"])
        self.assertTrue(plan["commands"]["launch"].startswith("TENANTEXT_LITELLM_BASE_URL="))
        data["memory"]["hermes"]["childExtensionPaths"] = ["builtin:llama.cpp"]
        self.error(data, "missing_child_provider", registry=REGISTRY)

    def test_invalid_choice_shapes_and_canaries(self):
        cases = ((lambda m: m["hermes"].update(backgroundReview="yes"), "boolean"),
                 (lambda m: m["hermes"].update(reviewTransport="direct"), "unused_memory_field"),
                 (lambda m: m["hermes"].update(backgroundReview=True), "review_transport"),
                 (lambda m: m["hermes"].update(backgroundReview=True, reviewTransport=CANARY), "review_transport"),
                 (lambda m: m["hermes"].update(backgroundReview=True, reviewTransport="direct", childExtensionPaths=CANARY), "array"),
                 (lambda m: m["hermes"].update(backgroundReview=True, reviewTransport="direct", childExtensionPaths=["relative/" + CANARY]), "child_extension_source"),
                 (lambda m: m["hermes"].update(backgroundReview=True, reviewTransport="direct", childExtensionPaths=["/tmp/../" + CANARY]), "absolute_path"),
                 (lambda m: m["hermes"].update(backgroundReview=True, reviewTransport="direct", childExtensionPaths=["builtin:x", "builtin:x"]), "duplicate_child_extension"),
                 (lambda m: m["hermes"].update(extra=CANARY), "unknown_fields"),
                 (lambda m: m.update(schemaVersion=2), "schema_version"),
                 (lambda m: m.update(other=CANARY), "unknown_fields"))
        for change, rule in cases:
            with self.subTest(rule=rule):
                data = self.base("hermes", memory={"hermes": copy.deepcopy(HERMES_OFF)})
                data["roles"]["memory"] = copy.deepcopy(MEMORY_ROLE)
                change(data["memory"])
                self.error(data, rule)
        for change, rule in ((lambda w: w.update(wikiHome="relative/" + CANARY), "absolute_path"),
                             (lambda w: w.update(wikiHome="/home/Test User/wiki home"), "wiki_home_is_ambient"),
                             (lambda w: w.update(ambientPersonalVault=1), "boolean"),
                             (lambda w: w.pop("backgroundTasks"), "required_fields")):
            with self.subTest(rule=rule):
                data = self.base("wiki", memory={"wiki": copy.deepcopy(WIKI_OFF)})
                change(data["memory"]["wiki"])
                self.error(data, rule)

    def embedding(self):
        data = self.base("wiki", memory={"wiki": {**WIKI_OFF, "embedding": copy.deepcopy(EMBEDDING)}})
        data["consent"]["embeddingTextTransfer"] = True
        return data

    def test_embedding_consent_is_separate_and_optional(self):
        for consent in (None, False):
            data = self.embedding()
            if consent is None:
                del data["consent"]["embeddingTextTransfer"]
            else:
                data["consent"]["embeddingTextTransfer"] = consent
            self.error(data, "embedding_consent_missing")
        data = self.embedding()
        data["consent"]["memoryCapture"] = False
        self.error(data, "memory_consent_required")
        for data in (self.base(), self.base("wiki", memory={"wiki": WIKI_OFF}),
                     self.base("wiki", memory={"wiki": {**WIKI_OFF, "embedding": None}})):
            data["consent"]["embeddingTextTransfer"] = True
            self.error(data, "embedding_consent_unused")
        data = self.embedding()
        data["selection"]["enable"].remove("wiki")
        data["selection"]["disable"].append("wiki")
        self.error(data, "embedding_consent_unused")
        data["consent"]["memoryCapture"] = False
        data["consent"]["embeddingTextTransfer"] = False
        self.error(data, "embedding_consent_missing")
        for value in (1, "true", None, [], {}):
            data = self.embedding()
            data["consent"]["embeddingTextTransfer"] = value
            self.error(data, "boolean")

    def test_embedding_mapping_and_readiness_preserve_other_choices(self):
        for auth, key, value in (({"envVar": "EXAMPLE_EMBEDDING_KEY"}, "embeddingApiKeyEnv", "EXAMPLE_EMBEDDING_KEY"),
                                 ({"mode": "none"}, "embeddingApiKey", WIKI_NO_AUTH_KEY)):
            for base in ("https://embeddings.example.invalid", "https://embeddings.example.invalid/v1",
                         "http://localhost:8080/prefix", "https://embeddings.example.invalid/prefix/v1/",
                         "http://[::1]:8080/v1", "https://embeddings.example.invalid/v1?version=1"):
                with self.subTest(auth=key, base=base):
                    data = self.embedding()
                    data["memory"]["wiki"].update(ambientPersonalVault=True, backgroundTasks=True, wikiHome="/home/example/vault")
                    data["memory"]["wiki"]["embedding"].update(auth=auth, baseUrl=base)
                    data["roles"]["memory"] = copy.deepcopy(MEMORY_ROLE)
                    before = copy.deepcopy(data)
                    plan = prepare(self.manifest_data, data)
                    self.assertEqual(before, data)
                    settings = plan["files"]["settings.json"]["content"]
                    self.assertEqual({"ambientPersonalVault": True, "trajectories": False,
                                      "taskModel": {"provider": MEMORY_ROLE["provider"], "id": MEMORY_ROLE["model"]},
                                      "taskThinkingLevel": "high", "embeddingProvider": "openai-compatible",
                                      "embeddingBaseUrl": base, "embeddingModel": EMBEDDING["model"], key: value}, settings["llm-wiki"])
                    choices = plan["files"][".tenant-pi/choices.json"]["content"]
                    self.assertEqual({"enabled": True, "writeTimeRequests": True, "queryTimeRequests": True,
                                      "backfill": "separate action", "expectedDimensions": 1536},
                                     choices["memory"]["activation"]["wiki"]["embeddings"])
                    self.assertEqual("wikiHome", choices["memory"]["activation"]["wiki"]["personalVault"])
                    for code in ("embedding_endpoint_unverified", "embedding_dimensions_unverified"):
                        self.assertIn({"code": code, "subject": "wiki"}, plan["readinessGaps"])
                    plain = copy.deepcopy(data)
                    del plain["memory"]["wiki"]["embedding"]
                    plain["consent"]["embeddingTextTransfer"] = False
                    plain_plan = prepare(self.manifest_data, plain)
                    self.assertEqual(plain_plan["commands"], plan["commands"])
                    self.assertEqual(plain_plan["files"]["settings.json"]["content"],
                                     {**settings, "llm-wiki": {k: v for k, v in settings["llm-wiki"].items() if not k.startswith("embedding")}})
        data = self.embedding()
        del data["memory"]["wiki"]["embedding"]["expectedDimensions"]
        plan = prepare(self.manifest_data, data)
        self.assertNotIn({"code": "embedding_dimensions_unverified", "subject": "wiki"}, plan["readinessGaps"])
        self.assertNotIn("expectedDimensions", plan["files"][".tenant-pi/choices.json"]["content"]["memory"]["activation"]["wiki"]["embeddings"])

    def test_embedding_rejects_incomplete_and_malformed_choices(self):
        for key in ("provider", "baseUrl", "model", "auth"):
            data = self.embedding()
            del data["memory"]["wiki"]["embedding"][key]
            self.error(data, "required_fields")
        for value in (False, True, [], "", CANARY, 1):
            data = self.embedding()
            data["memory"]["wiki"]["embedding"] = value
            self.error(data, "object")
        for key, value, rule in (("provider", "openai", "embedding_provider"), ("provider", CANARY, "embedding_provider"),
                                 ("provider", [], "embedding_provider"), ("model", "", "text"),
                                 ("model", " " + CANARY, "embedding_model"), ("model", CANARY + "\n", "text"),
                                 ("model", [], "text"), ("auth", {}, "embedding_auth"),
                                 ("auth", {"mode": "none", "envVar": "EXAMPLE_EMBEDDING_KEY"}, "embedding_auth"),
                                 ("auth", {"mode": CANARY}, "embedding_auth"), ("auth", {"apiKey": CANARY}, "unknown_fields"),
                                 ("auth", {"envVar": "${" + CANARY + "}"}, "env_name"),
                                 ("auth", {"envVar": ""}, "env_name"), ("auth", {"envVar": []}, "env_name"),
                                 ("auth", None, "object"), ("expectedDimensions", 0, "embedding_dimensions"),
                                 ("expectedDimensions", -1, "embedding_dimensions"), ("expectedDimensions", True, "embedding_dimensions"),
                                 ("expectedDimensions", 1.5, "embedding_dimensions"), ("expectedDimensions", CANARY, "embedding_dimensions"),
                                 ("embeddingStorePath", CANARY, "unknown_fields"), ("dimensions", 1536, "unknown_fields")):
            with self.subTest(key=key, rule=rule):
                data = self.embedding()
                data["memory"]["wiki"]["embedding"][key] = value
                self.error(data, rule)
        for value in (None, 3, [], "", "relative/v1", "ftp://embeddings.example.invalid", "https:///v1",
                      "https://user:" + CANARY + "@embeddings.example.invalid", "https://user@embeddings.example.invalid",
                      "https://embeddings.example.invalid/#" + CANARY, "https://embeddings.example.invalid/#",
                      "https://embeddings.example.invalid:bad", "https://embeddings.example.invalid:65536",
                      "https://embeddings.example.invalid:0", "https://embeddings.example.invalid:",
                      "https://embeddings.example.invalid/\n" + CANARY, " https://embeddings.example.invalid",
                      "https://embeddings.example.invalid/%0a" + CANARY, "https://embeddings.example.invalid/%zz",
                      "https://embeddings.example.invalid/%23" + CANARY, "https://%75ser@embeddings.example.invalid",
                      "https://.", "https://-bad.example.invalid", "https://bad..example.invalid",
                      "https://embeddings.example.invalid/" + chr(133), "https://embeddings.example.invalid/<bad>"):
            with self.subTest(value=value):
                data = self.embedding()
                data["memory"]["wiki"]["embedding"]["baseUrl"] = value
                self.error(data, "embedding_url")
        for key in ("key", "token", "api_key", "apikey", "secret", "password", "authorization", "ToKeN", "%74oken", "%2574oken"):
            data = self.embedding()
            data["memory"]["wiki"]["embedding"]["baseUrl"] += "?version=1&" + key + "=" + CANARY
            self.error(data, "embedding_url")

    def test_wiki_home_is_a_process_local_launch_fact(self):
        data = self.base("wiki", memory={"wiki": {**WIKI_OFF, "ambientPersonalVault": True, "wikiHome": "/home/Test User/wiki home"}})
        overlay(data, self.components)
        before = copy.deepcopy(data)
        plan = prepare(self.manifest_data, data)
        self.assertEqual(before, data)
        self.assertEqual(["WIKI_HOME=/home/Test User/wiki home", "env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=/home/Test User/.pi/.config/new profile", "pi", "--no-approve"],
                         shlex.split(plan["commands"]["launch"]))
        self.assertNotIn({"code": "shared_home_state", "subject": "wiki"}, plan["readinessGaps"])
        self.assertEqual("wikiHome", plan["files"][".tenant-pi/choices.json"]["content"]["memory"]["activation"]["wiki"]["personalVault"])
        self.assertTrue(plan["files"]["settings.json"]["content"]["llm-wiki"]["ambientPersonalVault"])
        self.assertEqual([{"kind": "process_environment", "name": "WIKI_HOME", "instruction": "WIKI_HOME='/home/Test User/wiki home'"}],
                         plan["files"][".tenant-pi/choices.json"]["content"]["memory"]["setup"])
        rendered = render_memory(data, self.components)
        self.assertEqual(rendered["settings"], {"llm-wiki": plan["files"]["settings.json"]["content"]["llm-wiki"]})
        validate_memory(data, self.components)


class MemoryPublicationTests(unittest.TestCase):
    """Guarded writer, comparison, and CLI behaviour with the Hermes file present."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-memory-")
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
        for cid in ("hermes", "wiki"):
            self.data["selection"]["disable"].remove(cid)
            self.data["selection"]["enable"].append(cid)
        self.data["consent"]["memoryCapture"] = True
        self.data["roles"]["memory"] = copy.deepcopy(MEMORY_ROLE)
        self.data["memory"] = {"schemaVersion": 1, "hermes": copy.deepcopy(HERMES_ON), "wiki": copy.deepcopy(WIKI_OFF), "openviking": None}

    def test_writer_publishes_the_hermes_file_privately_and_records_it(self):
        plan = prepare(self.manifest_data, self.data)
        old = os.umask(0)
        try:
            result = write(plan, str(self.target))
        finally:
            os.umask(old)
        self.assertTrue(result.complete)
        self.assertEqual({"settings.json", HERMES_CONFIG, ".tenant-pi", ".tenant-pi/choices.json", STATE},
                         {str(p.relative_to(self.target)) for p in self.target.rglob("*")})
        self.assertEqual(0o600, stat.S_IMODE((self.target / HERMES_CONFIG).stat().st_mode))
        self.assertEqual(plan["files"][HERMES_CONFIG]["content"], json.loads((self.target / HERMES_CONFIG).read_text()))
        state = json.loads((self.target / STATE).read_text())
        self.assertEqual(["settings.json", ".tenant-pi/choices.json", HERMES_CONFIG, STATE], state["provenance"]["outputs"])
        self.assertEqual({"core": "npm:@earendil-works/pi-coding-agent@" + PIN, "hermes": "npm:pi-hermes-memory",
                          "wiki": "npm:@zosmaai/pi-llm-wiki"}, state["provenance"]["pins"])
        self.assertNotIn("fake-native", (self.target / STATE).read_text())
        # Tampered plans are rejected before any file exists.
        for change in (lambda p: p["files"][HERMES_CONFIG]["content"].update(reviewEnabled=False),
                       lambda p: p["files"][HERMES_CONFIG]["content"].update(llmModelOverride=CANARY),
                       lambda p: p["files"].pop(HERMES_CONFIG),
                       lambda p: p["files"].update({"extra.json": p["files"][HERMES_CONFIG]}),
                       lambda p: p["files"][".tenant-pi/choices.json"]["content"]["memory"]["activation"]["hermes"].update(backgroundModelCalls=False),
                       lambda p: p["files"][".tenant-pi/choices.json"]["content"].pop("memory")):
            tampered = copy.deepcopy(prepare(self.manifest_data, self.data))
            change(tampered)
            other = self.parent / "other"
            with self.assertRaises(WriteError) as caught:
                write(tampered, str(other))
            self.assertFalse(caught.exception.candidate_created)
            self.assertFalse(other.exists())
            self.assertNotIn(CANARY, str(caught.exception))

    def test_compare_reads_the_hermes_file_and_redacts_private_values(self):
        plan = prepare(self.manifest_data, self.data)
        files = {name: copy.deepcopy(plan["files"][name]["content"]) for name in ("settings.json", ".tenant-pi/choices.json", HERMES_CONFIG)}
        from scripts.profile_write import _provenance
        files[".tenant-pi/state.json"] = {"schemaVersion": 1, "status": "complete",
                                         "provenance": _provenance(files[".tenant-pi/choices.json"], ["settings.json", ".tenant-pi/choices.json", HERMES_CONFIG])}
        report = compare(files, copy.deepcopy(files))
        self.assertEqual(list(FILES), report["scope"]["filesRead"])
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])
        self.assertIn({"file": HERMES_CONFIG, "field": "/reviewEnabled"}, report["unchanged"])
        self.assertIn({"file": "settings.json", "field": "/llm-wiki/ambientPersonalVault"}, report["unchanged"])
        edited = copy.deepcopy(files)
        edited[HERMES_CONFIG]["reviewEnabled"] = False
        edited[HERMES_CONFIG]["llmModelOverride"] = CANARY
        edited[HERMES_CONFIG]["childExtensionPaths"] = ["/" + CANARY]
        edited[HERMES_CONFIG]["reviewTransport"] = CANARY
        edited[HERMES_CONFIG]["extra"] = CANARY
        edited[HERMES_CONFIG]["bad key\n"] = CANARY
        edited["settings.json"]["llm-wiki"]["taskModel"] = {"provider": CANARY, "id": CANARY}
        edited["settings.json"]["llm-wiki"]["taskThinkingLevel"] = CANARY
        edited[".tenant-pi/choices.json"]["memory"] = {"activation": CANARY}
        report = compare(files, edited)
        dump = json.dumps(report)
        self.assertNotIn(CANARY, dump)
        self.assertNotIn("bad key", dump)
        changes = {(c["file"], c["field"]): c for c in report["changes"]}
        self.assertEqual(({"value": True}, {"value": False}), (changes[(HERMES_CONFIG, "/reviewEnabled")]["left"], changes[(HERMES_CONFIG, "/reviewEnabled")]["right"]))
        self.assertEqual({"status": "unsupported_value"}, changes[(HERMES_CONFIG, "/reviewTransport")]["right"])
        self.assertEqual({"status": "unsupported_value"}, changes[("settings.json", "/llm-wiki/taskThinkingLevel")]["right"])
        for key in ((HERMES_CONFIG, "/llmModelOverride"), (HERMES_CONFIG, "/childExtensionPaths"),
                    ("settings.json", "/llm-wiki/taskModel"), (".tenant-pi/choices.json", "/memory")):
            self.assertNotIn("right", changes[key], key)
        self.assertEqual("owner_edits", report["right"]["drift"]["status"])
        self.assertEqual(["/llm-wiki", HERMES_CONFIG + ":/childExtensionPaths", HERMES_CONFIG + ":/extra",
                          HERMES_CONFIG + ":/llmModelOverride", HERMES_CONFIG + ":/reviewEnabled",
                          HERMES_CONFIG + ":/reviewTransport", "/<redacted>"], report["right"]["drift"]["fields"])
        self.assertEqual("changed", report["right"]["drift"]["metadata"])
        # A candidate whose Hermes file was deleted after generation is visible drift, not a crash.
        missing = copy.deepcopy(files)
        missing[HERMES_CONFIG] = None
        report = compare(files, missing)
        self.assertEqual([HERMES_CONFIG + ":/<missing>"], report["right"]["drift"]["fields"])
        self.assertEqual("removed", next(c["change"] for c in report["changes"] if c["file"] == HERMES_CONFIG))
        # A hostile Hermes file shape is reported, never a crash or a value leak.
        for hostile_value in ([CANARY], CANARY, 7, {"reviewEnabled": {"x": CANARY}}):
            hostile = copy.deepcopy(files)
            hostile[HERMES_CONFIG] = hostile_value
            report = compare(files, hostile)
            self.assertNotIn(CANARY, json.dumps(report))
            self.assertEqual("owner_edits", report["right"]["drift"]["status"])

    def test_cli_generate_and_compare_in_a_disposable_home_without_external_effects(self):
        overlay_file = self.base_dir / "overlay.json"
        overlay_file.write_text(json.dumps(self.data))
        bin_dir = self.base_dir / "bin"
        bin_dir.mkdir()
        for name in ("pi", "npm", "node", "git", "sh", "curl"):
            command = bin_dir / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base_dir / "called") + "'\n")
            command.chmod(0o700)
        hook = self.base_dir / "sitecustomize.py"
        hook.write_text("import sys\nsys.dont_write_bytecode = True\nimport socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
        env = dict(os.environ, HOME=str(self.home), PATH=str(bin_dir), PYTHONPATH=str(self.base_dir), PYTHONDONTWRITEBYTECODE="1")
        # Ambient host state beside the candidate must stay unread and unchanged.
        (self.home / ".llm-wiki").mkdir()
        (self.home / ".llm-wiki/config.json").write_text(CANARY)
        (self.home / ".pi/agent").mkdir(parents=True)
        (self.home / ".pi/agent/hermes-memory-config.json").write_text(CANARY)

        def run(*args):
            return subprocess.run([sys.executable, str(CLI), *args], cwd=self.base_dir, env=env, text=True, capture_output=True)

        plan = run("plan", "--overlay", str(overlay_file))
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        self.assertEqual([".", ".tenant-pi", ".tenant-pi/choices.json", HERMES_CONFIG, "settings.json", STATE],
                         [f["path"] for f in preview["files"]])
        self.assertTrue(preview["memory"]["activation"]["hermes"]["backgroundModelCalls"])
        self.assertIn({"code": "peer_override_required", "subject": "hermes"}, preview["readinessGaps"])
        generated = run("generate", "--overlay", str(overlay_file), "--target", str(self.target))
        self.assertEqual(0, generated.returncode, generated.stderr)
        self.assertTrue(json.loads(generated.stdout)["filesComplete"])
        self.assertEqual(0o600, stat.S_IMODE((self.target / HERMES_CONFIG).stat().st_mode))
        self.assertNotIn(CANARY, generated.stdout + generated.stderr)
        self.assertEqual(CANARY, (self.home / ".llm-wiki/config.json").read_text())
        self.assertEqual(CANARY, (self.home / ".pi/agent/hermes-memory-config.json").read_text())
        self.assertFalse((self.base_dir / "called").exists())
        self.assertFalse((self.target / "pi-hermes-memory").exists())
        self.assertFalse((self.target / "sessions").exists())
        # A second candidate without Hermes compares as a removed file, never a value leak.
        self.data["target"]["agentDir"] = str(self.parent / "second")
        self.data["selection"]["enable"].remove("hermes")
        self.data["selection"]["disable"].append("hermes")
        self.data["memory"]["hermes"] = None
        self.data["roles"]["memory"]["model"] = CANARY.lower()
        overlay_file.write_text(json.dumps(self.data))
        second = run("generate", "--overlay", str(overlay_file), "--target", str(self.parent / "second"))
        self.assertEqual(0, second.returncode, second.stderr)
        compared = run("compare", "--left", str(self.target), "--right", str(self.parent / "second"))
        self.assertEqual(0, compared.returncode, compared.stderr)
        report = json.loads(compared.stdout)
        self.assertNotIn(CANARY.lower(), compared.stdout)
        self.assertEqual("removed", next(c["change"] for c in report["changes"] if c["file"] == HERMES_CONFIG and c["field"] == "/reviewEnabled"))
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])

    def test_cli_embedding_choices_stay_offline_and_preserve_existing_data(self):
        overlay_file = self.base_dir / "overlay.json"
        ambient = self.home / ".pi/agent"
        vault = self.home / ".llm-wiki"
        ambient.mkdir(parents=True)
        vault.mkdir()
        (ambient / "settings.json").write_text(json.dumps({"theme": CANARY}))
        (vault / "page.md").write_text(CANARY)
        (vault / "embeddings.json").write_text(CANARY)
        before = {p: p.read_bytes() for root in (ambient, vault) for p in root.rglob("*") if p.is_file()}
        hook = self.base_dir / "sitecustomize.py"
        hook.write_text(
            "import os, sys, socket, subprocess, urllib.request\n"
            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
            "socket.socket.connect = blocked\nsocket.socket.connect_ex = blocked\n"
            "socket.create_connection = blocked\nsocket.getaddrinfo = blocked\n"
            "subprocess.Popen = blocked\nos.system = blocked\nurllib.request.urlopen = blocked\n"
            "original = os._Environ.__getitem__\n"
            "def guarded(self, key):\n"
            "    if key in ('EXAMPLE_EMBEDDING_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'):\n"
            "        raise AssertionError('credential value read')\n"
            "    return original(self, key)\n"
            "os._Environ.__getitem__ = guarded\n"
            "os._Environ.__contains__ = lambda self, key: self.encodekey(key) in self._data\n"
            "def audit(event, args):\n"
            "    if event == 'open' and isinstance(args[0], str):\n"
            "        if any(args[0].startswith(p) for p in " + repr([str(ambient), str(vault)]) + "):\n"
            "            raise AssertionError('ambient data read')\n"
            "sys.addaudithook(audit)\n")
        env = dict(os.environ, HOME=str(self.home), PYTHONPATH=str(self.base_dir), PYTHONDONTWRITEBYTECODE="1",
                   EXAMPLE_EMBEDDING_KEY=CANARY, OPENAI_API_KEY=CANARY,
                   OPENAI_BASE_URL="https://" + CANARY + ".example.invalid/v1")

        def run(*args, success=True):
            result = subprocess.run([sys.executable, str(CLI), *args], cwd=self.base_dir, env=env, text=True, capture_output=True)
            self.assertEqual(0 if success else 2, result.returncode, result.stdout + result.stderr)
            self.assertNotIn(CANARY, result.stdout + result.stderr)
            return json.loads(result.stdout) if success else result

        # The old overlay and explicit null both stay off in an ambient credential environment.
        variants = (("old", None), ("off", None), ("env", EMBEDDING),
                    ("none", {**EMBEDDING, "auth": {"mode": "none"}}))
        targets = []
        for label, embedding in variants:
            with self.subTest(label=label):
                data = copy.deepcopy(self.data)
                target = self.parent / label
                targets.append(target)
                data["target"]["agentDir"] = str(target)
                if label != "old":
                    data["memory"]["wiki"]["embedding"] = copy.deepcopy(embedding)
                    data["consent"]["embeddingTextTransfer"] = embedding is not None
                overlay_file.write_text(json.dumps(data))
                run("validate", "--overlay", str(overlay_file))
                preview = run("plan", "--overlay", str(overlay_file))
                self.assertFalse(target.exists())
                activation = preview["memory"]["activation"]["wiki"]["embeddings"]
                self.assertEqual(embedding is not None, activation["enabled"])
                self.assertEqual(embedding is not None, activation["writeTimeRequests"])
                self.assertEqual(embedding is not None, activation["queryTimeRequests"])
                self.assertEqual("separate action", activation["backfill"])
                self.assertFalse(preview["runtimeReady"])
                self.assertNotIn("reindex", json.dumps(preview["commands"]))
                generated = run("generate", "--overlay", str(overlay_file), "--target", str(target))
                self.assertTrue(generated["filesComplete"])
                self.assertFalse(generated["runtimeReady"])
                settings = json.loads((target / "settings.json").read_text())
                wiki = settings["llm-wiki"]
                expected_auth = "embeddingApiKey" if label == "none" else "embeddingApiKeyEnv"
                self.assertEqual({expected_auth} if embedding else set(),
                                 set(wiki) & {"embeddingApiKey", "embeddingApiKeyEnv"})
                if embedding:
                    self.assertEqual(embedding["baseUrl"], wiki["embeddingBaseUrl"])
                    self.assertEqual(embedding["model"], wiki["embeddingModel"])
                    self.assertEqual("openai-compatible", wiki["embeddingProvider"])
                    self.assertEqual(WIKI_NO_AUTH_KEY if label == "none" else "EXAMPLE_EMBEDDING_KEY", wiki[expected_auth])
                    self.assertNotIn("expectedDimensions", wiki)
                else:
                    self.assertFalse(any(k.startswith("embedding") for k in wiki))
                self.assertFalse(wiki["trajectories"])
                self.assertEqual({"settings.json", HERMES_CONFIG, ".tenant-pi", ".tenant-pi/choices.json", STATE},
                                 {str(p.relative_to(target)) for p in target.rglob("*")})
                self.assertNotIn(CANARY, "".join(p.read_text() for p in target.rglob("*") if p.is_file()))
                self.assertEqual(0o600, stat.S_IMODE((target / "settings.json").stat().st_mode))
        compared = run("compare", "--left", str(targets[0]), "--right", str(targets[2]))
        self.assertEqual([], compared["unsupported"])
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, compared["right"]["drift"])
        self.assertNotIn(EMBEDDING["baseUrl"], json.dumps(compared))
        self.assertNotIn("EXAMPLE_EMBEDDING_KEY", json.dumps(compared))
        preserved = {p: p.read_bytes() for target in targets for p in target.rglob("*") if p.is_file()}
        # Bad choices fail validation, planning and generation before target publication.
        invalid = (("provider", None), ("baseUrl", "https://u:" + CANARY + "@embeddings.example.invalid"),
                   ("baseUrl", "https://embeddings.example.invalid/#" + CANARY),
                   ("baseUrl", "file:///" + CANARY),
                   ("baseUrl", "https://embeddings.example.invalid?token=" + CANARY),
                   ("model", ""), ("auth", {"apiKey": CANARY}))
        for key, value in invalid:
            data = copy.deepcopy(self.data)
            data["consent"]["embeddingTextTransfer"] = True
            data["memory"]["wiki"]["embedding"] = copy.deepcopy(EMBEDDING)
            data["memory"]["wiki"]["embedding"][key] = value
            overlay_file.write_text(json.dumps(data))
            for command in ("validate", "plan", "generate"):
                args = ("--target", str(self.target)) if command == "generate" else ()
                run(command, "--overlay", str(overlay_file), *args, success=False)
                self.assertFalse(self.target.exists())
        self.assertEqual(before, {p: p.read_bytes() for p in before})
        self.assertEqual(preserved, {p: p.read_bytes() for p in preserved})

    def test_cli_generates_an_openviking_profile_without_a_server_call_or_a_credential(self):
        for cid in ("hermes", "wiki"):
            self.data["selection"]["enable"].remove(cid)
            self.data["selection"]["disable"].append(cid)
        self.data["selection"]["disable"].remove("openviking")
        self.data["selection"]["enable"].append("openviking")
        self.data["consent"]["remoteMemoryWrites"] = True
        self.data["roles"]["memory"] = None
        self.data["memory"] = {"schemaVersion": 1, "hermes": None, "wiki": None, "openviking": copy.deepcopy(OPENVIKING)}
        overlay_file = self.base_dir / "overlay.json"
        overlay_file.write_text(json.dumps(self.data))
        bin_dir = self.base_dir / "bin"
        bin_dir.mkdir()
        for name in ("pi", "npm", "node", "git", "sh", "curl", "ov"):
            command = bin_dir / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base_dir / "called") + "'\n")
            command.chmod(0o700)
        hook = self.base_dir / "sitecustomize.py"
        hook.write_text("import sys\nsys.dont_write_bytecode = True\nimport socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
        # The credential files and the variables of the extension stay unread: the canary is in none of the output.
        (self.home / ".openviking").mkdir()
        for name in ("ovcli.conf", "ov.conf"):
            (self.home / ".openviking" / name).write_text(json.dumps({"url": "https://" + CANARY + ".example.invalid", "api_key": CANARY}))
        (self.home / ".pi/agent/extensions/openviking").mkdir(parents=True)
        (self.home / ".pi/agent/extensions/openviking/config.json").write_text(json.dumps({"captureToolResults": CANARY}))
        env = dict(os.environ, HOME=str(self.home), PATH=str(bin_dir), PYTHONPATH=str(self.base_dir), PYTHONDONTWRITEBYTECODE="1",
                   OPENVIKING_API_KEY=CANARY, OPENVIKING_URL="https://" + CANARY + ".example.invalid",
                   OPENVIKING_CLI_CONFIG_FILE=str(self.home / ".openviking/ovcli.conf"))

        def run(*args):
            return subprocess.run([sys.executable, str(CLI), *args], cwd=self.base_dir, env=env, text=True, capture_output=True)

        plan = run("plan", "--overlay", str(overlay_file))
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        self.assertEqual([".", ".tenant-pi", ".tenant-pi/choices.json", "settings.json", STATE], [f["path"] for f in preview["files"]])
        self.assertTrue(preview["memory"]["activation"]["openviking"]["remoteWrites"])
        self.assertIn({"code": "server_required", "subject": "openviking"}, preview["readinessGaps"])
        self.assertIn("npm --prefix " + shlex.quote(str(ROOT / OPENVIKING_DIR)) + " ci --ignore-scripts", preview["commands"]["setupDisplayOnly"])
        launch = shlex.split(preview["commands"]["launchDisplayOnly"])
        self.assertEqual(["OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS=5000", "OPENVIKING_CAPTURE_TOOL_RESULTS=true"], launch[:2])
        generated = run("generate", "--overlay", str(overlay_file), "--target", str(self.target))
        self.assertEqual(0, generated.returncode, generated.stderr)
        self.assertTrue(json.loads(generated.stdout)["filesComplete"])
        self.assertEqual({"settings.json", ".tenant-pi", ".tenant-pi/choices.json", STATE},
                         {str(p.relative_to(self.target)) for p in self.target.rglob("*")})
        settings = json.loads((self.target / "settings.json").read_text())
        self.assertEqual([{"source": str(ROOT / OPENVIKING_DIR), "extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []}],
                         settings["packages"])
        state = json.loads((self.target / STATE).read_text())
        self.assertEqual("tree:" + OPENVIKING_DIR, state["provenance"]["pins"]["openviking"])
        written = "".join(p.read_text() for p in self.target.rglob("*") if p.is_file())
        self.assertNotIn(CANARY, written + plan.stdout + plan.stderr + generated.stdout + generated.stderr)
        for word in ("OPENVIKING_API_KEY", "OPENVIKING_URL", "api_key"):
            self.assertNotIn(word, written, word)
        self.assertFalse((self.base_dir / "called").exists())
        self.assertFalse((self.target / "config.json").exists())
        self.assertEqual(["config.json"], [p.name for p in (self.home / ".pi/agent/extensions/openviking").iterdir()])
        self.assertEqual(["ov.conf", "ovcli.conf"], sorted(p.name for p in (self.home / ".openviking").iterdir()))
        # A second profile with the capture of tool results off: the comparison names the two fields by value.
        self.data["target"]["agentDir"] = str(self.parent / "second")
        self.data["memory"]["openviking"] = {"captureToolResults": False}
        overlay_file.write_text(json.dumps(self.data))
        second = run("generate", "--overlay", str(overlay_file), "--target", str(self.parent / "second"))
        self.assertEqual(0, second.returncode, second.stderr)
        compared = run("compare", "--left", str(self.target), "--right", str(self.parent / "second"))
        self.assertEqual(0, compared.returncode, compared.stderr)
        report = json.loads(compared.stdout)
        at = "/overlay/memory/openviking/"
        changes = {c["field"]: c for c in report["changes"] if c["field"].startswith(at)}
        self.assertEqual({at + "captureToolResults": ("changed", {"value": True}, {"value": False}),
                          at + "recallContextTimeoutMs": ("removed", {"value": 5000}, None)},
                         {field: (c["change"], c.get("left"), c.get("right")) for field, c in changes.items()})
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])
        self.assertFalse((self.base_dir / "called").exists())


if __name__ == "__main__":
    unittest.main()
