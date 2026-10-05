"""Synthetic-only fixture tests; no host configuration is read."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.validate import Invalid, TREE_COMPONENTS, load, manifest, npm_parts, overlay

ROOT = Path(__file__).resolve().parents[1]


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.components = manifest(load(ROOT / "config/manifest.json"))
        cls.base = load(ROOT / "config/config.example.json")

    def check_error(self, data, rule):
        with self.assertRaisesRegex(Invalid, "^" + rule + ":") as result:
            overlay(data, self.components)
        self.assertNotIn("CANARY_SECRET", str(result.exception))

    def test_core_example_and_omitted_roles(self):
        overlay(self.base, self.components)
        self.assertEqual({}, self.base["roles"])
        self.assertFalse(any(self.base["consent"].values()))

    def test_modular_overlay(self):
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].extend(["codex-accounts", "model-routing"])
        data["selection"]["disable"].remove("codex-accounts")
        data["selection"]["disable"].remove("model-routing")
        data["roles"]["interactive"] = {"provider": "fake-provider", "model": "fake/model", "thinking": "low"}
        data["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"
        data["endpoints"]["codex-accounts"] = "https://example.invalid/api"
        overlay(data, self.components)
        # The gateway keys moved with the component split; the old key names the new one.
        for section, value in (("endpoints", "https://example.invalid/api"), ("env", "${TENANTEXT_LITELLM_API_KEY}")):
            moved = copy.deepcopy(data)
            moved["selection"]["enable"].append("tenantext")
            moved["selection"]["disable"].remove("tenantext")
            moved[section]["tenantext"] = value
            with self.assertRaisesRegex(Invalid, "^moved_key: overlay." + section + ".tenantext is now overlay." + section + ".codex-accounts$"):
                overlay(moved, self.components)

    def test_disabled_and_dependencies(self):
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("tracker-site")
        self.check_error(data, "selection_conflict")
        data["selection"]["disable"].remove("tracker-site")
        self.check_error(data, "blocked_component")
        data["selection"]["enable"] = ["model-routing"]
        self.check_error(data, "selection_conflict")
        data["selection"]["enable"] = ["core"]
        data["selection"]["disable"].append("core")
        self.check_error(data, "selection_conflict")

    def test_secret_canary_and_paths(self):
        data = copy.deepcopy(self.base)
        data["target"]["agentDir"] = "/tmp/../CANARY_SECRET"
        self.check_error(data, "absolute_path")
        data["target"]["agentDir"] = "/tmp/new-agent"
        data["inputs"]["modelsFile"] = "../../CANARY_SECRET"
        self.check_error(data, "relative_path")
        data["inputs"]["modelsFile"] = "other/models.json"
        self.check_error(data, "input_allowlist")
        data["inputs"]["modelsFile"] = None
        data["env"]["core"] = "CANARY_SECRET"
        self.check_error(data, "unselected_env")
        del data["env"]["core"]
        data["roles"]["review"] = {"provider": "fake", "model": "$(CANARY_SECRET)", "thinking": "low"}
        self.check_error(data, "shell_or_template")

    def test_duplicate_json_and_unknown_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "fixture.json"
            file.write_text('{"canary":"CANARY_SECRET","canary":0}')
            with self.assertRaisesRegex(Invalid, "duplicate_key: JSON object") as result:
                load(file)
            self.assertNotIn("CANARY_SECRET", str(result.exception))
        data = copy.deepcopy(self.base)
        data["secret"] = "CANARY_SECRET"
        self.check_error(data, "unknown_fields")

    def test_load_names_each_cause_and_the_place_of_a_syntax_error(self):
        broken = b'{\n  "canary": "CANARY_SECRET"\n  "next": 1\n}\n'
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "fixture.json"
            for content, rule, place in ((b'{"canary": "\xff"}', "input_encoding: file", (None, None)),
                                         (broken, "invalid_json: file", (3, 3)),
                                         (b'{"canary": NaN}', "number: JSON", (None, None)),
                                         (b'{"canary": ' + b"9" * 5000 + b"}", "number: JSON", (None, None)),
                                         (b"[" * 100000 + b"]" * 100000, "input_too_deep: file", (None, None))):
                with self.subTest(rule=rule):
                    file.write_bytes(content)
                    with self.assertRaises(Invalid) as result:
                        load(file)
                    self.assertEqual(rule, str(result.exception))
                    self.assertEqual(place, (result.exception.line, result.exception.column))
            for path, rule in ((Path(tmp) / "absent.json", "input_missing: file"), (Path(tmp), "input_unreadable: file")):
                with self.assertRaises(Invalid) as result:
                    load(path)
                self.assertEqual(rule, str(result.exception))
            # The direct validator prints the place after the rule and the field, and no file content.
            file.write_bytes(broken)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--overlay", str(file)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual((2, "", "invalid_json: file line=3 column=3\n"), (result.returncode, result.stdout, result.stderr))
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--overlay", str(Path(tmp) / "absent.json")],
                                    capture_output=True, text=True, check=False)
            self.assertEqual((2, "", "input_missing: file\n"), (result.returncode, result.stdout, result.stderr))

    def test_sources_and_cycles(self):
        for src, rule in [
            ({"kind": "npm", "spec": "fake@latest"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@^1.0.0"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@1.x"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@1.0.0", "url": "https://example.invalid"}, "source_form"),
            ({"kind": "git", "url": "https://user:CANARY_SECRET@example.invalid/x", "commit": "a" * 40, "subdir": "x"}, "credential_free_https_url"),
            ({"kind": "git", "url": "https://example.invalid/x", "commit": "main", "subdir": "x"}, "full_commit"),
            ({"kind": "local", "pathKey": "local-path", "commit": "a" * 40}, "source_form"),
            ({"kind": "git", "url": "https://example.invalid/;touch%20/tmp/CANARY_SECRET", "commit": "a" * 40, "subdir": ""}, "credential_free_https_url"),
            ({"kind": "git", "url": "https://example.invalid/%253Btouch/tmp/CANARY_SECRET", "commit": "a" * 40, "subdir": ""}, "credential_free_https_url"),
        ]:
            data = load(ROOT / "config/manifest.json")
            data["components"]["codex-accounts"]["source"] = src
            with self.assertRaisesRegex(Invalid, "^" + rule + ":") as result:
                manifest(data)
            self.assertNotIn("CANARY_SECRET", str(result.exception))
        data = load(ROOT / "config/manifest.json")
        data["components"]["core"]["source"]["spec"] = "@earendil-works/pi-coding-agent"
        with self.assertRaisesRegex(Invalid, "^reviewed_source:"):  # the core anchor keeps its exact version
            manifest(data)
        data = load(ROOT / "config/manifest.json")
        for cid in ("mcp", "hermes", "wiki"):
            self.assertIsNone(npm_parts(data["components"][cid]["source"]["spec"])[1])
        self.assertEqual(("@zosmaai/pi-llm-wiki", None), npm_parts("@zosmaai/pi-llm-wiki"))
        self.assertEqual(("@zosmaai/pi-llm-wiki", "0.12.4"), npm_parts("@zosmaai/pi-llm-wiki@0.12.4"))
        self.assertEqual(("pi-mcp-adapter", "3.2.0"), npm_parts("pi-mcp-adapter@3.2.0"))
        data = load(ROOT / "config/manifest.json")
        data["components"]["codex-accounts"]["requires"] = ["not-listed"]
        with self.assertRaisesRegex(Invalid, "undeclared_dependency"):
            manifest(data)
        data["components"]["codex-accounts"]["requires"] = ["model-routing"]
        data["components"]["model-routing"]["requires"] = ["codex-accounts"]
        with self.assertRaisesRegex(Invalid, "dependency_cycle"):
            manifest(data)

    def test_env_endpoint_and_consent(self):
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("codex-accounts")
        data["selection"]["disable"].remove("codex-accounts")
        data["endpoints"]["codex-accounts"] = "https://user:CANARY_SECRET@example.invalid/"
        self.check_error(data, "credential_free_https_url")
        data["endpoints"]["codex-accounts"] = "https://example.invalid/"
        data["env"]["codex-accounts"] = "${CANARY_SECRET}"
        self.check_error(data, "undeclared_env")
        data["env"]["codex-accounts"] = "${TENANTEXT_LITELLM_API_KEY}"
        data["consent"]["memoryCapture"] = True
        self.check_error(data, "memory_disabled")

    def test_manifest_unknown_fields_and_disabled_pin(self):
        data = load(ROOT / "config/manifest.json")
        data["components"]["core"]["unreviewed"] = "CANARY_SECRET"
        with self.assertRaisesRegex(Invalid, "unknown_fields") as error:
            manifest(data)
        self.assertNotIn("CANARY_SECRET", str(error.exception))
        del data["components"]["core"]["unreviewed"]
        data["components"]["core"]["source"] = None
        with self.assertRaisesRegex(Invalid, "missing_pin"):
            manifest(data)

    def test_reviewed_source_and_runtime_bindings(self):
        data = load(ROOT / "config/manifest.json")
        for src in ({"kind": "builtin"}, {"kind": "npm", "spec": "other@0.87.1"}):
            changed = copy.deepcopy(data)
            changed["components"]["core"]["source"] = src
            with self.assertRaisesRegex(Invalid, "^(reviewed_source|core_source):"):
                manifest(changed)
        changed = copy.deepcopy(data)
        changed["runtime"]["piVersion"] = "0.88.0"
        with self.assertRaisesRegex(Invalid, "^core_runtime_pin:"):
            manifest(changed)
        for cid, src in (("model-routing", {"kind": "npm", "spec": "fake@1.0.0"}),
                         ("codex-accounts", {"kind": "builtin"}),
                         ("mcp", {"kind": "npm", "spec": "fake@3.1.0"})):
            changed = copy.deepcopy(data)
            changed["components"][cid]["source"] = src
            with self.assertRaisesRegex(Invalid, "^reviewed_source:"):
                manifest(changed)
        changed = copy.deepcopy(data)
        changed["components"]["tracker-site"]["source"] = None
        manifest(changed)  # Missing provenance stays blocked.
        changed["components"]["tracker-site"]["source"] = {"kind": "local", "pathKey": "local-source"}
        manifest(changed)  # Local development also stays blocked.

    def test_unsafe_urls_and_safe_https(self):
        for unsafe in ("https://example.invalid/;touch%20/tmp/CANARY_SECRET",
                       "https://example.invalid/%3Btouch/tmp/CANARY_SECRET",
                       "https://example.invalid/%253Btouch/tmp/CANARY_SECRET"):
            data = load(ROOT / "config/manifest.json")
            data["components"]["codex-accounts"]["source"] = {"kind": "git", "url": unsafe, "commit": "a" * 40, "subdir": ""}
            with self.assertRaisesRegex(Invalid, "^credential_free_https_url:") as error:
                manifest(data)
            self.assertNotIn("CANARY_SECRET", str(error.exception))
            local = copy.deepcopy(self.base)
            local["selection"]["enable"].append("codex-accounts")
            local["selection"]["disable"].remove("codex-accounts")
            local["endpoints"]["codex-accounts"] = unsafe
            self.check_error(local, "credential_free_https_url")
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("codex-accounts")
        data["selection"]["disable"].remove("codex-accounts")
        data["endpoints"]["codex-accounts"] = "https://example.invalid/api/v1"
        overlay(data, self.components)

    def test_ownership_claims_and_collisions(self):
        data = load(ROOT / "config/manifest.json")
        claims = data["components"]["core"]["configOwnership"]["claims"]
        claims.append(copy.deepcopy(claims[0]))
        with self.assertRaisesRegex(Invalid, "^ownership_conflict:"):
            manifest(data)
        claims.pop()
        data["components"]["codex-accounts"]["configOwnership"]["claims"] = copy.deepcopy(claims[:1])
        with self.assertRaisesRegex(Invalid, "^unreviewed_claim:"):
            manifest(data)
        data = load(ROOT / "config/manifest.json")
        data["components"]["tracker-site"]["configOwnership"]["claims"] = [{"file": "settings.json", "key": "/defaultModel"}]
        with self.assertRaisesRegex(Invalid, "^unreviewed_claim:"):
            manifest(data)

    def test_ownership_claim_types_and_cli_diagnostics(self):
        for field in ("file", "key"):
            for value in (["CANARY_SECRET"], {"CANARY_SECRET": True}, None, 42, False):
                data = load(ROOT / "config/manifest.json")
                data["components"]["core"]["configOwnership"]["claims"][0][field] = value
                with self.assertRaisesRegex(Invalid, "^ownership_claim_type: manifest.components.item.configOwnership.claims." + field + "$") as error:
                    manifest(data)
                self.assertNotIn("CANARY_SECRET", str(error.exception))
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / "manifest.json"
                    path.write_text(json.dumps(data), encoding="utf-8")
                    result = subprocess.run(
                        [sys.executable, str(ROOT / "scripts/validate.py"),
                         "--manifest", str(path), "--overlay", str(ROOT / "config/config.example.json")],
                        capture_output=True, text=True, check=False,
                    )
                    self.assertEqual(2, result.returncode)
                    self.assertIn("ownership_claim_type: manifest.components.item.configOwnership.claims." + field, result.stderr)
                    self.assertNotIn("Traceback", result.stdout + result.stderr)
                    self.assertNotIn("CANARY_SECRET", result.stdout + result.stderr)
        manifest(load(ROOT / "config/manifest.json"))

    def test_disabled_local_path_and_duplicate_owner(self):
        data = load(ROOT / "config/manifest.json")
        data["components"]["tracker-site"]["source"] = {"kind": "local", "pathKey": "local-source"}
        components = manifest(data)
        local = copy.deepcopy(self.base)
        local["paths"]["local-source"] = "/home/Example User/.config/tenant-pi"
        with self.assertRaisesRegex(Invalid, "^undeclared_path:"):
            overlay(local, components)
        data["components"]["openviking"]["source"] = {"kind": "local", "pathKey": "local-source"}
        with self.assertRaisesRegex(Invalid, "^duplicate_path_owner:"):
            manifest(data)
        data["components"]["openviking"]["source"] = None
        data["components"]["mcp"]["source"] = {"kind": "local", "pathKey": "other-source"}
        with self.assertRaisesRegex(Invalid, "^local_only:"):
            manifest(data)  # A tested module cannot take a local development source.

    def test_input_slots_and_legitimate_paths(self):
        for directory in ("/home/Example User/new-agent", "/home/example/.pi/tenant",
                          "/home/example/.config/tenant-pi"):
            data = copy.deepcopy(self.base)
            data["target"]["agentDir"] = directory
            data["inputs"]["modelsFile"] = "inputs/models.json"
            overlay(data, self.components)
        for key, candidate in (("modelsFile", "inputs/mcp-adapter.json"),
                               ("modelsFile", "inputs/anything.json"),
                               ("mcpFile", "inputs/models.json")):
            data = copy.deepcopy(self.base)
            data["inputs"][key] = candidate
            self.check_error(data, "input_allowlist")
        for directory in ("/home/example/../tenant", "/home/example/./tenant",
                          "/home/example/tenant;CANARY_SECRET", "relative/tenant"):
            data = copy.deepcopy(self.base)
            data["target"]["agentDir"] = directory
            self.check_error(data, "absolute_path")

    def test_local_only_cannot_be_tested(self):
        data = load(ROOT / "config/manifest.json")
        data["components"]["codex-accounts"]["source"] = {"kind": "local", "pathKey": "local-source"}
        with self.assertRaisesRegex(Invalid, "local_only"):
            manifest(data)

    def test_tree_source_rejections(self):
        for path, rule in ((None, "source_form"),  # The `path` field is missing.
                           ("packages/not-in-the-kit", "tree_path_missing"),
                           ("packages/tenantext/package.json", "tree_path_missing"),  # A file, not a package directory.
                           ("/packages/tenantext", "relative_path"),
                           (str(ROOT / "packages/tenantext"), "relative_path"),
                           ("packages/../CANARY_SECRET", "relative_path"),
                           ("packages/tenantext/../../scripts", "relative_path"),
                           ("../packages/tenantext", "relative_path"),
                           ("scripts", "tree_outside_packages"),
                           ("docs/example-private", "tree_outside_packages"),
                           ("packages", "tree_outside_packages"),
                           (["packages/tenantext"], "text")):
            with self.subTest(path=path):
                data = load(ROOT / "config/manifest.json")
                data["components"]["doctor"]["source"] = {"kind": "tree"} if path is None else {"kind": "tree", "path": path}
                with self.assertRaisesRegex(Invalid, "^" + rule + ":") as error:
                    manifest(data)
                self.assertNotIn("CANARY_SECRET", str(error.exception))
        data = load(ROOT / "config/manifest.json")
        data["components"]["doctor"]["source"] = {"kind": "tree", "path": "packages/tenantext", "commit": "a" * 40}
        with self.assertRaisesRegex(Invalid, "^source_form:"):
            manifest(data)
        # An existing package directory that is not the reviewed anchor of the component stays rejected.
        data["components"]["doctor"]["source"] = {"kind": "tree", "path": "packages/promptr"}
        with self.assertRaisesRegex(Invalid, "^reviewed_source:"):
            manifest(data)

    def test_tree_path_rejects_a_link_that_leaves_packages(self):
        from scripts import validate
        with tempfile.TemporaryDirectory() as tmp:
            kit = Path(tmp) / "kit"
            (kit / "packages").mkdir(parents=True)
            (Path(tmp) / "outside").mkdir()
            (kit / "packages/escape").symlink_to(Path(tmp) / "outside")
            (kit / "packages/inside").mkdir()
            root, validate.ROOT = validate.ROOT, kit
            try:
                validate.tree_path("packages/inside", "source.path")
                with self.assertRaisesRegex(Invalid, "^tree_outside_packages:"):
                    validate.tree_path("packages/escape", "source.path")
            finally:
                validate.ROOT = root

    def test_one_tree_component_per_extension_and_skill(self):
        data = load(ROOT / "config/manifest.json")
        package = json.loads((ROOT / "packages/tenantext/package.json").read_text(encoding="utf-8"))
        declared = {entry[2:] for entry in package["pi"]["extensions"]}
        in_manifest = {c["resources"]["extensions"][0] for cid, c in data["components"].items()
                       if c["source"] == {"kind": "tree", "path": "packages/tenantext"} and c["resources"]["extensions"]}
        self.assertEqual(declared, in_manifest)
        for package_dir in ("packages/tenantext", "packages/promptr"):
            skills = {"skills/" + p.name for p in (ROOT / package_dir / "skills").iterdir() if p.is_dir()}
            from scripts.publish_check import excluded_files, private_excludes
            skills = {skill for skill in skills
                      if not excluded_files({f"{package_dir}/{skill}/SKILL.md"}, private_excludes(ROOT))}
            self.assertEqual(skills, {c["resources"]["skills"][0] for c in data["components"].values()
                                      if c["source"] == {"kind": "tree", "path": package_dir} and c["resources"]["skills"]})
        self.assertEqual(17, len(TREE_COMPONENTS))
        for cid in TREE_COMPONENTS:
            component = data["components"][cid]
            path, kind, item = TREE_COMPONENTS[cid]
            self.assertTrue((ROOT / path / item).exists(), cid)
            self.assertIn("core", component["requires"])
            self.assertIn(component["status"], ("unverified", "blocked"))  # No `tested` without a test here.
            self.assertTrue(component["gaps"], cid)
            self.assertEqual(1, sum(len(v) for v in component["resources"].values()))
            self.assertIn(cid, self.base["selection"]["disable"])
        self.assertEqual(["core"], self.base["selection"]["enable"])
        self.assertEqual(["TENANTEXT_LITELLM_BASE_URL", "TENANTEXT_LITELLM_API_KEY"], data["components"]["codex-accounts"]["env"])
        routing = (ROOT / "packages/tenantext/extensions/codex-accounts/routing.ts").read_text(encoding="utf-8")
        for name in data["components"]["codex-accounts"]["env"]:
            self.assertIn("env." + name, routing)
        self.assertNotIn("gitea", json.dumps(data))

    def test_pi_line_gap_facts_do_not_claim_a_stale_readme_version(self):
        components = manifest(load(ROOT / "config/manifest.json"))
        facts = [gap["fact"] for name, component in components.items() for gap in component.get("gaps", [])
                 if name != "resources" and gap["code"] == "pi_line_unqualified"]
        self.assertEqual(11, len(facts))
        self.assertEqual({"No test in this repository loads the component with the kit pin."}, set(facts))

    def test_status_and_gaps_rules(self):
        for change, rule in (
                (lambda c: c["doctor"].update(status="tested"), "status_gaps"),
                (lambda c: c["doctor"].update(gaps=[]), "status_gaps"),
                (lambda c: c["doctor"].pop("gaps"), "status_gaps"),
                (lambda c: c["core"].update(gaps=[{"code": "x", "fact": "A fact"}]), "status_gaps"),
                (lambda c: c["tracker-site"].update(status="qualified"), "status"),
                (lambda c: c["doctor"].update(reason="CANARY_SECRET"), "status_reason"),
                (lambda c: c["doctor"]["gaps"].append(copy.deepcopy(c["doctor"]["gaps"][0])), "duplicate_gap"),
                (lambda c: c["doctor"]["gaps"][0].update(code="Bad Code"), "gap_code"),
                (lambda c: c["doctor"]["gaps"][0].update(fact="$(CANARY_SECRET)"), "shell_or_template"),
                (lambda c: c["doctor"]["gaps"][0].update(note="CANARY_SECRET"), "unknown_fields"),
                (lambda c: c["doctor"].update(gaps="CANARY_SECRET"), "array"),
                (lambda c: c["doctor"]["configOwnership"].update(status="blocked", claims=[]), "ownership_blocked"),
                (lambda c: c["tracker-site"].update(status="unverified", reason=None), "ownership_blocked")):
            data = load(ROOT / "config/manifest.json")
            change(data["components"])
            with self.assertRaisesRegex(Invalid, "^" + rule + ":") as error:
                manifest(data)
            self.assertNotIn("CANARY_SECRET", str(error.exception))
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("doctor")
        data["selection"]["disable"].remove("doctor")
        overlay(data, self.components)  # `unverified` is selectable; `blocked` is not.
        # Promptr and its four skills are `unverified`; a skill still needs the extension.
        promptr = [cid for cid in self.components if cid == "promptr" or cid.startswith("promptr-")]
        self.assertEqual(5, len(promptr))
        for cid in promptr:
            self.assertEqual("unverified", self.components[cid]["status"])
            self.assertNotIn("requires_blocked_component", {gap["code"] for gap in self.components[cid]["gaps"]})
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("promptr-handoff")
        data["selection"]["disable"].remove("promptr-handoff")
        self.check_error(data, "missing_dependency")
        data["selection"]["enable"].append("promptr")
        data["selection"]["disable"].remove("promptr")
        overlay(data, self.components)
        for cid in ("tracker-site", "openviking"):
            data = copy.deepcopy(self.base)
            data["selection"]["enable"].append(cid)
            data["selection"]["disable"].remove(cid)
            self.check_error(data, "blocked_component")
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("ops-footer")
        data["selection"]["disable"].remove("ops-footer")
        self.check_error(data, "missing_dependency")


if __name__ == "__main__":
    unittest.main()
