"""Synthetic, offline route contract tests."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.model_routes import render
from scripts.validate import Invalid, load, manifest, overlay

ROOT = Path(__file__).resolve().parents[1]
NATIVE = {"provider": "fake-native", "model": "team/slash-id", "thinking": "high", "route": "native"}
GATEWAY = {"provider": "litellm-codex", "model": "codex-auto/sol", "thinking": "xhigh", "route": "gateway"}
REGISTRY = {"fake-native": {"team/slash-id": ["high", "low"], "another": ["off"]},
            "litellm-codex": {"codex-auto/sol": ["xhigh", "low"]}}


class RoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.components = manifest(load(ROOT / "config/manifest.json"))

    def base(self):
        data = load(ROOT / "config/config.example.json")
        data["modelRoutes"] = {"schemaVersion": 1, "cycle": [], "gateway": None}
        return data

    def enable(self, data, *components):
        for component in components:
            data["selection"]["disable"].remove(component)
            data["selection"]["enable"].append(component)

    def gateway(self, data, auth="env"):
        self.enable(data, "codex-accounts")
        data["modelRoutes"]["gateway"] = {"auth": auth}
        data["endpoints"]["codex-accounts"] = "https://gateway.example.invalid/v1"
        if auth == "env":
            data["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"

    def error(self, data, rule, registry=REGISTRY):
        with self.assertRaisesRegex(Invalid, "^" + rule + ":") as ctx:
            overlay(data, self.components)
            render(data, registry)
        self.assertNotIn("CANARY_SECRET", str(ctx.exception))

    def test_core_only_and_legacy_overlay(self):
        data = self.base()
        overlay(data, self.components)
        result = render(data, {})
        self.assertEqual({}, result["settings"])
        self.assertEqual("unverified", result["availability"])
        self.assertEqual([], result["setup"])
        self.assertEqual("unset", result["roleStatus"]["interactive"])
        data.pop("modelRoutes")
        overlay(data, self.components)

    def test_native_cycle_and_required_roles(self):
        data = self.base()
        self.enable(data, "model-routing")
        data["roles"]["interactive"] = copy.deepcopy(NATIVE)
        data["modelRoutes"]["cycle"] = [copy.deepcopy(NATIVE), {"provider": "fake-native", "model": "another", "thinking": "off"}]
        overlay(data, self.components)
        before = copy.deepcopy(data)
        result = render(data, REGISTRY, required_roles=("review", "interactive"))
        self.assertEqual(before, data)
        self.assertEqual("team/slash-id", result["settings"]["defaultModel"])
        self.assertEqual(["fake-native/team/slash-id", "fake-native/another"], result["settings"]["enabledModels"])
        self.assertEqual({"fake-native/another": "off", "fake-native/team/slash-id": "high"}, result["settings"]["modelThinkingLevels"])
        self.assertEqual("required_missing", result["roleStatus"]["review"])
        self.assertNotIn("review", result["settings"])
        self.assertEqual("native_auth", result["setup"][0]["kind"])
        # Pi 0.99.1 findInitialModel (same in 0.87.1) takes the first scoped model before the saved default.
        self.assertEqual(result["settings"]["defaultProvider"] + "/" + result["settings"]["defaultModel"],
                         result["settings"]["enabledModels"][0])
        data["modelRoutes"]["cycle"].reverse()
        self.error(data, "interactive_not_first_in_cycle")
        data["roles"]["interactive"] = None
        self.assertEqual(["fake-native/another", "fake-native/team/slash-id"],
                         render(data, REGISTRY)["settings"]["enabledModels"])

    def test_gateway_auth_alternatives_and_credentials_are_name_only(self):
        for auth in ("env", "login"):
            data = self.base()
            self.enable(data, "model-routing")
            self.gateway(data, auth)
            data["roles"]["review"] = copy.deepcopy(GATEWAY)
            overlay(data, self.components)
            result = render(data, REGISTRY, credential_names={"TENANTEXT_LITELLM_BASE_URL"})
            self.assertEqual("codex-auto/sol", result["roles"]["review"]["model"])
            self.assertEqual([], result["cycle"])
            self.assertEqual({}, {k: v for k, v in result["settings"].items() if k.startswith("default")})
            self.assertEqual("missing", result["credentialStatus"]["TENANTEXT_LITELLM_API_KEY"] if auth == "env" else "missing")
            self.assertEqual("pi_login_blocked" if auth == "login" else "process_environment", result["setup"][-1]["method"])
            self.assertNotIn("CANARY_SECRET", json.dumps(result))
            self.assertNotIn("auth.json", json.dumps(result))
            self.assertNotIn("TOKEN", json.dumps(result))
            self.assertEqual("TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1", result["setup"][0]["instruction"])

    def test_gateway_requires_prefix_env_and_selection(self):
        data = self.base()
        self.enable(data, "model-routing")
        data["roles"]["review"] = copy.deepcopy(GATEWAY)
        self.error(data, "gateway_disabled")
        self.gateway(data)
        del data["env"]["codex-accounts"]
        self.error(data, "gateway_env_name")
        data["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"
        data["endpoints"]["codex-accounts"] = "https://gateway.example.invalid"
        self.error(data, "gateway_api_prefix")
        for value in ("https://user:CANARY_SECRET@gateway.example.invalid/v1", "https://gateway.example.invalid/v1?key=CANARY_SECRET", "$(CANARY_SECRET)", "http://localhost:4000/v1", "https://gateway.example.invalid/%253Btouch/v1"):
            data["endpoints"]["codex-accounts"] = value
            self.error(data, "credential_free_https_url")
        data["endpoints"]["codex-accounts"] = "https://gateway.example.invalid/v1"
        data["modelRoutes"]["gateway"] = None
        self.error(data, "gateway_missing")
        data["modelRoutes"]["gateway"] = {"auth": "login"}
        del data["env"]["codex-accounts"]
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^credential_names:"):
            render(data, REGISTRY, credential_names={"TENANTEXT_LITELLM_API_KEY"})
        data["selection"]["enable"].remove("model-routing")
        data["selection"]["disable"].append("model-routing")
        self.error(data, "model_routing_required")

    def test_unsupported_registry_model_thinking_and_alias(self):
        data = self.base()
        self.enable(data, "model-routing")
        data["roles"]["worker"] = copy.deepcopy(NATIVE)
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^unsupported_model_thinking:"):
            render(data, {})
        data["roles"]["worker"]["thinking"] = "xhigh"
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^unsupported_model_thinking:"):
            render(data, REGISTRY)
        self.gateway(data)
        data["roles"]["worker"] = {**GATEWAY, "model": "codex1/gpt-6-sol"}
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^unsupported_gateway_model:"):
            render(data, REGISTRY)

    def test_conflicts_malformed_and_redaction(self):
        data = self.base()
        data["modelRoutes"]["schemaVersion"] = True
        self.error(data, "schema_version")
        data["modelRoutes"]["schemaVersion"] = 1
        data["modelRoutes"]["extra"] = "CANARY_SECRET"
        self.error(data, "unknown_fields")
        del data["modelRoutes"]["extra"]
        self.enable(data, "model-routing")
        data["modelRoutes"]["cycle"] = [copy.deepcopy(NATIVE), copy.deepcopy(NATIVE)]
        self.error(data, "duplicate_cycle_model")
        data["modelRoutes"]["cycle"].pop()
        data["roles"]["worker"] = {**NATIVE, "thinking": "low"}
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^conflicting_model_thinking:"):
            render(data, REGISTRY)
        data["roles"]["worker"]["thinking"] = "high"
        data["modelRoutes"]["cycle"][0]["model"] = "$(CANARY_SECRET)"
        self.error(data, "shell_or_template")
        data["modelRoutes"]["cycle"][0] = copy.deepcopy(NATIVE)
        data["modelRoutes"]["cycle"][0]["unknown"] = "CANARY_SECRET"
        self.error(data, "unknown_fields")

    def test_ambiguous_settings_key_and_native_gateway_boundary(self):
        data = self.base()
        self.enable(data, "model-routing")
        data["roles"]["worker"] = copy.deepcopy(NATIVE)
        data["modelRoutes"]["cycle"] = [{"provider": "fake-native/team", "model": "slash-id", "thinking": "high"}]
        self.error(data, "ambiguous_model_key")
        data["modelRoutes"]["cycle"] = []
        data["roles"]["worker"] = {**GATEWAY, "route": "native"}
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^unsupported_native_provider:"):
            render(data, REGISTRY)
        data["roles"]["worker"] = {"provider": "openai-codex-2", "model": "mock", "thinking": "off"}
        overlay(data, self.components)
        with self.assertRaisesRegex(Invalid, "^provider_requires_codex_accounts:"):
            render(data, {"openai-codex-2": {"mock": ["off"]}})

    def test_validate_script_from_unrelated_cwd_without_pythonpath(self):
        valid = self.base()
        self.enable(valid, "model-routing")
        valid["roles"]["review"] = copy.deepcopy(NATIVE)
        invalid = copy.deepcopy(valid)
        invalid["modelRoutes"]["cycle"] = [{**NATIVE, "model": "$(CANARY_SECRET)"}]
        before = {p: p.read_bytes() for p in (ROOT / "scripts/__pycache__").glob("*.pyc")} if (ROOT / "scripts/__pycache__").exists() else {}
        with tempfile.TemporaryDirectory() as tmp:
            for name, data, code, message in (("valid", valid, 0, "valid: structural contract"),
                                              ("invalid", invalid, 2, "shell_or_template: overlay.modelRoutes.cycle.entry.model")):
                path = Path(tmp) / (name + ".json")
                path.write_text(json.dumps(data), encoding="utf-8")
                env = {key: value for key, value in os.environ.items() if key not in ("PYTHONPATH", "PYTHONPYCACHEPREFIX")}
                env["PYTHONDONTWRITEBYTECODE"] = "1"
                result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--overlay", str(path)],
                                        cwd=tmp, env=env, capture_output=True, text=True, check=False)
                self.assertEqual(code, result.returncode, result.stdout + result.stderr)
                self.assertIn(message, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stdout + result.stderr)
                self.assertNotIn("CANARY_SECRET", result.stdout + result.stderr)
            nested = Path(tmp) / "standalone-uncaught.json"
            nested.write_text(json.dumps(invalid), encoding="utf-8")
            env.pop("PYTHONDONTWRITEBYTECODE", None)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--overlay", str(nested)],
                                    cwd=tmp, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(2, result.returncode)
            self.assertIn("shell_or_template: overlay.modelRoutes.cycle.entry.model", result.stderr)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
        after = {p: p.read_bytes() for p in (ROOT / "scripts/__pycache__").glob("*.pyc")} if (ROOT / "scripts/__pycache__").exists() else {}
        self.assertEqual(before, after)

    def test_duplicate_json_and_purity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "synthetic.json"
            path.write_text('{"modelRoutes":{},"modelRoutes":"CANARY_SECRET"}')
            with self.assertRaisesRegex(Invalid, "^duplicate_key: JSON object") as ctx:
                load(path)
            self.assertNotIn("CANARY_SECRET", str(ctx.exception))
        data = self.base()
        self.enable(data, "model-routing")
        data["roles"]["interactive"] = copy.deepcopy(NATIVE)
        registry = copy.deepcopy(REGISTRY)
        before = copy.deepcopy((data, registry))
        with patch("builtins.open", side_effect=AssertionError("I/O")), patch("subprocess.run", side_effect=AssertionError("subprocess")), patch("os.getenv", side_effect=AssertionError("environment")):
            a = render(data, registry)
        a["roles"]["interactive"]["model"] = "modified"
        self.assertEqual(before, (data, registry))
        self.assertEqual("team/slash-id", render(data, registry)["roles"]["interactive"]["model"])
        for invalid in (None, {"fake-native": {"team/slash-id": ["CANARY_SECRET"]}}):
            with self.assertRaises(Invalid) as ctx:
                render(data, invalid)
            self.assertNotIn("CANARY_SECRET", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
