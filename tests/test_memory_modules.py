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
from scripts.memory_modules import HERMES_CONFIG, render_memory, validate_memory
from scripts.profile_plan import prepare
from scripts.profile_write import STATE, WriteError, write
from scripts.validate import Invalid, load, manifest, overlay
from tests.test_model_routes import REGISTRY

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
MEMORY_ROLE = {"provider": "fake-native", "model": "team/slash-id", "thinking": "high"}
GATEWAY_ROLE = {"provider": "litellm-codex", "model": "codex-auto/sol", "thinking": "xhigh", "route": "gateway"}
HERMES_ON = {"backgroundReview": True, "reviewTransport": "direct"}
HERMES_OFF = {"backgroundReview": False}
WIKI_OFF = {"ambientPersonalVault": False, "backgroundTasks": False}


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

    def test_remote_write_refusal_and_openviking_stays_blocked(self):
        data = self.base("hermes", memory={"hermes": HERMES_OFF})
        data["consent"]["remoteMemoryWrites"] = True
        self.error(data, "remote_memory_disabled")
        data = self.base(consent=False, memory={"openviking": {"enabled": True}})
        self.error(data, "memory_module_disabled")
        data = self.base(memory={})
        data["selection"]["disable"].remove("openviking")
        data["selection"]["enable"].append("openviking")
        self.error(data, "blocked_component")
        self.assertEqual("blocked", self.components["openviking"]["status"])
        self.assertIsNone(self.components["openviking"]["source"])

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
                          "remoteWrites": False, "personalVault": "home"}, memory["activation"]["wiki"])
        self.assertEqual({"enabled": False}, memory["activation"]["openviking"])
        codes = {(g["code"], g["subject"]) for g in plan["readinessGaps"]}
        for expected in (("package_runtime_unverified", "hermes"), ("package_runtime_unverified", "wiki"),
                         ("peer_override_required", "hermes"), ("peer_override_required", "wiki"),
                         ("native_addon_unverified", "better-sqlite3"), ("shared_home_state", "wiki"),
                         ("session_backfill_scope_unverified", "hermes"), ("project_settings_override", "wiki")):
            self.assertIn(expected, codes)
        self.assertNotIn(("child_provider_unverified", "hermes"), codes)
        self.assertEqual(["npm install --global -- @earendil-works/pi-coding-agent@1.0.3",
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
        self.assertEqual({"core": "npm:@earendil-works/pi-coding-agent@1.0.3", "hermes": "npm:pi-hermes-memory",
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


if __name__ == "__main__":
    unittest.main()
