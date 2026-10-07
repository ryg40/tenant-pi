"""Synthetic-only fixture tests; no host configuration is read."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.validate import (Invalid, OPTIONAL_TREE_COMPONENTS, TREE_COMPONENTS, load, manifest,
                              npm_parts, optional_tree_absent, overlay, tree_items)

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
        overlay(data, self.components)
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
        # The question extension keeps the exact version whose registry metadata was read.
        self.assertEqual(("@juicesharp/rpiv-ask-user-question", "2.11.0"),
                         npm_parts(data["components"]["questions"]["source"]["spec"]))
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
        changed["components"]["tracker-site"].update(status="blocked", reason="Blocked for this test.")
        changed["components"]["tracker-site"]["configOwnership"].update(status="blocked", claims=[])
        changed["components"]["tracker-site"]["source"] = None
        manifest(changed)  # Missing provenance stays blocked.
        changed["components"]["tracker-site"]["source"] = {"kind": "local", "pathKey": "local-source"}
        manifest(changed)  # Local development also stays blocked.

    def test_tested_pi_must_be_inside_a_valid_accepted_range(self):
        data = load(ROOT / "config/manifest.json")
        tested = data["runtime"]["piVersion"].split("-", 1)[0]
        for accepted in (f">={tested} <99", ">=0.0.0 <99"):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            manifest(changed)
        for accepted, rule in ((">=99.0.0 <100", "tested_outside_range"),
                               (f">=0.0.0 <{tested}", "tested_outside_range"),
                               (">=2.0 <1", "runtime_range"), ("^1.0.3", "runtime_range"),
                               (None, "runtime_range"), ("CANARY_SECRET", "runtime_range")):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            with self.subTest(accepted=accepted), self.assertRaises(Invalid) as error:
                manifest(changed)
            self.assertEqual(rule + ": manifest.runtime.piAcceptedRange", str(error.exception))
        changed = copy.deepcopy(data)
        del changed["runtime"]["piAcceptedRange"]
        with self.assertRaisesRegex(Invalid, "^required_fields: manifest.runtime$"):
            manifest(changed)

    def test_accepted_pi_range_requires_an_upper_bound(self):
        data = load(ROOT / "config/manifest.json")
        tested = data["runtime"]["piVersion"].split("-", 1)[0]
        for accepted in (f">={tested}", ">=0.0", ">=0.0.0"):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            with self.subTest(accepted=accepted), self.assertRaises(Invalid) as error:
                manifest(changed)
            self.assertEqual("range_without_upper_bound: manifest.runtime.piAcceptedRange", str(error.exception))

    def test_malformed_accepted_pi_range_fails(self):
        data = load(ROOT / "config/manifest.json")
        for accepted in ("", "1.0.3", "<1.1", ">=1.0.3 <=1.1", ">=1.0.3 <1.1 ", ">=1.0.3 || >=2.0", 3, [">=1.0.3 <1.1"]):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            with self.subTest(accepted=accepted), self.assertRaises(Invalid) as error:
                manifest(changed)
            self.assertEqual("runtime_range: manifest.runtime.piAcceptedRange", str(error.exception))

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
        data["components"]["tracker-site"].update(status="blocked", reason="Blocked for this test.")
        data["components"]["tracker-site"]["configOwnership"].update(status="blocked", claims=[])
        data["components"]["tracker-site"]["source"] = {"kind": "local", "pathKey": "local-source"}
        components = manifest(data)
        local = copy.deepcopy(self.base)
        local["paths"]["local-source"] = "/home/Example User/.config/tenant-pi"
        with self.assertRaisesRegex(Invalid, "^undeclared_path:"):
            overlay(local, components)
        # A second blocked component with the same path key. `openviking` is selectable, so the
        # test blocks a copy of it first.
        selectable = copy.deepcopy(data["components"]["openviking"])
        data["components"]["openviking"].update(
            status="blocked", reason="Blocked for this test.", source={"kind": "local", "pathKey": "local-source"},
            configOwnership={"claims": [], "status": "blocked", "boundary": "Blocked for this test"})
        with self.assertRaisesRegex(Invalid, "^duplicate_path_owner:"):
            manifest(data)
        data["components"]["openviking"] = selectable
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

    def test_tree_resources_come_from_the_manifest_and_exist_in_the_tree(self):
        data = load(ROOT / "config/manifest.json")
        # The table of the validator is the manifest of the kit, in manifest order. The file is read
        # here with `json.load`, independent of `validate.py`, so the test guards the derivation.
        with open(ROOT / "config/manifest.json", encoding="utf-8") as handle:
            kit = json.load(handle)["components"]
        expected = [(cid, c["source"]["path"], kind, tuple(c["resources"][kind]))
                    for cid, c in kit.items() if isinstance(c["source"], dict) and c["source"]["kind"] == "tree"
                    for kind in ("extensions", "skills", "prompts", "themes") if c["resources"][kind]]
        self.assertEqual(expected, [(cid, path, kind, tuple(tree_items(item)))
                                    for cid, (path, kind, item) in TREE_COMPONENTS.items()])
        self.assertEqual(len(expected), len({cid for cid, *_ in expected}))
        # A manifest from another place that names one more skill is not the manifest of the kit.
        component = data["components"]["coordinator-skills"]
        component["resources"]["skills"].append("skills/coordinator-skills/not-in-the-kit")
        component["configOwnership"]["claims"].append(
            {"file": "settings.json", "key": "package:packages/tenantext:skills/coordinator-skills/not-in-the-kit"})
        with self.assertRaisesRegex(Invalid, "^unreviewed_claim:"):
            manifest(data)
        # The manifest of the kit names a path that the tree does not hold, or no path.
        from scripts import validate
        for skills in (["skills/herdr", "skills/not-in-the-kit"], []):
            with self.subTest(skills=skills):
                data = load(ROOT / "config/manifest.json")
                component = data["components"]["herdr"]
                component["resources"]["skills"] = skills
                component["configOwnership"]["claims"] = [
                    {"file": "settings.json", "key": "package:packages/tenantext:" + skill} for skill in skills]
                with mock.patch.dict(validate.REVIEWED_CLAIMS, {"herdr": {
                        ("settings.json", "package:packages/tenantext:" + skill) for skill in skills}}), \
                        mock.patch.dict(validate.REVIEWED_RESOURCES, {"herdr": validate._tree_resources("skills", tuple(skills))}):
                    with self.assertRaisesRegex(Invalid, "^tree_resource_missing:"):
                        manifest(data)

    def test_unreadable_kit_manifest_fails_closed_with_its_cause(self):
        from scripts import validate
        self.assertIsNone(validate.TREE_COMPONENTS_CAUSE)
        with tempfile.TemporaryDirectory() as tmp:
            for text, cause in ((None, "FileNotFoundError: "), ("{", "JSONDecodeError: "),
                                ('{"components": {"x": {"source": {"kind": "tree"}}}}', "KeyError: 'resources'")):
                with self.subTest(cause=cause), mock.patch.object(validate, "ROOT", Path(tmp)):
                    if text is not None:
                        (Path(tmp) / "config").mkdir(exist_ok=True)
                        (Path(tmp) / "config/manifest.json").write_text(text, encoding="utf-8")
                    table, found = validate._tree_components()
                    self.assertEqual({}, table)
                    self.assertTrue(found.startswith(cause), found)
        # The empty table removes the tree anchors; the finding of `manifest()` prints the cause.
        anchors = {cid: source for cid, source in validate.REVIEWED_SOURCES.items()
                   if cid not in validate.TREE_COMPONENTS}
        with mock.patch.dict(validate.REVIEWED_SOURCES, anchors, clear=True), \
                mock.patch.object(validate, "TREE_COMPONENTS_CAUSE", "KeyError: 'path'"):
            with self.assertRaisesRegex(Invalid, r"^reviewed_components: manifest\.components \(kit manifest "
                                                 r"config/manifest\.json not read: KeyError: 'path'\)$"):
                manifest(load(ROOT / "config/manifest.json"))

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
            # A skill directory holds `SKILL.md`; a directory without it is a component of several skills.
            skills = {"skills/" + s.relative_to(ROOT / package_dir / "skills").as_posix()
                      for p in (ROOT / package_dir / "skills").iterdir() if p.is_dir()
                      for s in ([p] if (p / "SKILL.md").is_file() else [d for d in p.iterdir() if d.is_dir()])}
            from scripts.publish_check import excluded_files, private_excludes
            skills = {skill for skill in skills
                      if not excluded_files({f"{package_dir}/{skill}/SKILL.md"}, private_excludes(ROOT))}
            self.assertEqual(skills, {skill for cid, c in data["components"].items()
                                      if c["source"] == {"kind": "tree", "path": package_dir}
                                      and not optional_tree_absent(cid)
                                      for skill in c["resources"]["skills"]})
        self.assertEqual(21, len(TREE_COMPONENTS))
        knowledge = data["components"]["knowledge-skills"]["resources"]["skills"]
        self.assertEqual(4, len(knowledge))
        self.assertIn("skills/knowledge-skills/open-knowledge", knowledge)
        for cid in TREE_COMPONENTS:
            component = data["components"][cid]
            path, kind, item = TREE_COMPONENTS[cid]
            items = tree_items(item)
            if not optional_tree_absent(cid):
                for one in items:
                    self.assertTrue((ROOT / path / one).exists(), cid)
            self.assertIn("core", component["requires"])
            self.assertIn(component["status"], ("unverified", "blocked"))  # No `tested` without a test here.
            self.assertTrue(component["gaps"], cid)
            self.assertEqual(len(items), sum(len(v) for v in component["resources"].values()))
            self.assertEqual(items, component["resources"][kind])
            # Only a skill component of several skills names more than one resource.
            self.assertTrue(len(items) == 1 or (kind == "skills" and cid in ("coordinator-skills", "knowledge-skills")), cid)
            self.assertIn(cid, self.base["selection"]["disable"])
        self.assertEqual(["core"], self.base["selection"]["enable"])
        self.assertEqual(["TENANTEXT_LITELLM_BASE_URL", "TENANTEXT_LITELLM_API_KEY"], data["components"]["codex-accounts"]["env"])
        routing = (ROOT / "packages/tenantext/extensions/codex-accounts/routing.ts").read_text(encoding="utf-8")
        for name in data["components"]["codex-accounts"]["env"]:
            self.assertIn("env." + name, routing)
        self.assertNotIn("gitea", json.dumps(data))

    def test_relay_is_optional_and_requires_herdr_when_enabled(self):
        self.assertEqual(("herdr-relay",), OPTIONAL_TREE_COMPONENTS)
        component = self.components["herdr-relay"]
        self.assertEqual(["core", "herdr"], component["requires"])
        self.assertEqual("unverified", component["status"])
        self.assertEqual({"extensions": [], "skills": ["skills/herdr-relay"], "prompts": [], "themes": []},
                         component["resources"])
        self.assertFalse(any("herdr-relay" in c["requires"] for c in self.components.values()))
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("herdr-relay")
        data["selection"]["disable"].remove("herdr-relay")
        self.check_error(data, "missing_dependency")
        data["selection"]["enable"].append("herdr")
        data["selection"]["disable"].remove("herdr")
        if optional_tree_absent("herdr-relay"):
            self.check_error(data, "tree_resource_missing")
        else:
            overlay(data, self.components)
        from scripts import validate
        with mock.patch.object(validate, "optional_tree_absent", side_effect=lambda cid: cid == "herdr-relay"):
            components = manifest(load(ROOT / "config/manifest.json"))
            overlay(self.base, components)
            with self.assertRaisesRegex(Invalid, "^tree_resource_missing:"):
                overlay(data, components)

    def test_tracker_skill_is_selectable_with_explicit_runtime_gap(self):
        component = self.components["tracker-site"]
        self.assertEqual("unverified", component["status"])
        self.assertIsNone(component["reason"])
        self.assertEqual({"host_tool_required", "pi_line_unqualified", "kit_test_missing"},
                         {gap["code"] for gap in component["gaps"]})
        self.assertEqual("reviewed", component["configOwnership"]["status"])
        self.assertEqual([{"file": "settings.json", "key": "package:packages/tenantext:skills/tracker-site"}],
                         component["configOwnership"]["claims"])

    def test_question_extension_is_a_selectable_pinned_npm_component(self):
        component = self.components["questions"]
        self.assertEqual({"kind": "npm", "spec": "@juicesharp/rpiv-ask-user-question@2.11.0"}, component["source"])
        self.assertEqual(("unverified", None, ["core"], "MIT"),
                         (component["status"], component["reason"], component["requires"], component["license"]))
        self.assertEqual({"extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []}, component["resources"])
        self.assertEqual([], component["env"])
        self.assertEqual({"pi_line_unqualified", "package_source_unreviewed", "peer_package_unverified",
                          "question_ui_unverified", "shared_config_outside_profile", "kit_test_missing"},
                         {gap["code"] for gap in component["gaps"]})
        self.assertEqual([{"file": "settings.json", "key": "package:@juicesharp/rpiv-ask-user-question"}],
                         component["configOwnership"]["claims"])
        self.assertIn("questions", self.base["selection"]["disable"])
        self.assertNotIn("questions", self.base["selection"]["enable"])
        # The reviewed anchor holds the version: an altered manifest cannot move or drop the pin.
        for spec in ("@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-ask-user-question@2.12.0",
                     "rpiv-ask-user-question@2.11.0"):
            data = load(ROOT / "config/manifest.json")
            data["components"]["questions"]["source"]["spec"] = spec
            with self.assertRaisesRegex(Invalid, "^reviewed_source:"):
                manifest(data)
        data = load(ROOT / "config/manifest.json")
        data["components"]["questions"]["resources"]["extensions"] = ["index.ts", "rpc-fallback.ts"]
        with self.assertRaisesRegex(Invalid, "^reviewed_resources:"):
            manifest(data)
        data = load(ROOT / "config/manifest.json")
        data["components"]["questions"]["status"] = "tested"
        with self.assertRaisesRegex(Invalid, "^status_gaps:"):
            manifest(data)

    def test_herdr_is_a_host_tool_and_no_package_of_the_profile(self):
        gaps = {gap["code"]: gap["fact"] for gap in self.components["herdr"]["gaps"]}
        self.assertIn("the kit does not install them", gaps["host_tool_required"])
        self.assertIn("check-herdr", gaps["host_tool_required"])
        # No component installs the Herdr application: no source names it.
        sources = json.dumps([component["source"] for component in self.components.values()])
        self.assertNotIn("herdr", sources.replace("promptr", ""))
        self.assertNotIn("pi-herdr", json.dumps(load(ROOT / "config/manifest.json")))

    def test_pi_line_gap_facts_do_not_claim_a_stale_readme_version(self):
        components = manifest(load(ROOT / "config/manifest.json"))
        facts = {name: gap["fact"] for name, component in components.items() for gap in component.get("gaps", [])
                 if gap["code"] == "pi_line_unqualified"}
        self.assertEqual(16, len(facts))
        self.assertEqual("The component uses the resource settings syntax of the reviewed Pi release "
                         "(see docs/resources.md). No test in this repository loads it with the kit pin.",
                         facts.pop("resources"))
        common = "No test in this repository loads the component with the kit pin."
        self.assertEqual(common, facts["coordinator-skills"])
        for name, fact in facts.items():
            with self.subTest(component=name):
                self.assertEqual(common, fact)

    def test_status_and_gaps_rules(self):
        for change, rule in (
                (lambda c: c["doctor"].update(status="tested"), "status_gaps"),
                (lambda c: c["doctor"].update(gaps=[]), "status_gaps"),
                (lambda c: c["doctor"].pop("gaps"), "status_gaps"),
                (lambda c: c["core"].update(gaps=[{"code": "x", "fact": "A fact"}]), "status_gaps"),
                (lambda c: (c["tracker-site"]["configOwnership"].update(status="blocked", claims=[]),
                            c["tracker-site"].update(status="qualified")), "status"),
                (lambda c: c["doctor"].update(reason="CANARY_SECRET"), "status_reason"),
                (lambda c: c["doctor"]["gaps"].append(copy.deepcopy(c["doctor"]["gaps"][0])), "duplicate_gap"),
                (lambda c: c["doctor"]["gaps"][0].update(code="Bad Code"), "gap_code"),
                (lambda c: c["doctor"]["gaps"][0].update(fact="$(CANARY_SECRET)"), "shell_or_template"),
                (lambda c: c["doctor"]["gaps"][0].update(note="CANARY_SECRET"), "unknown_fields"),
                (lambda c: c["doctor"].update(gaps="CANARY_SECRET"), "array"),
                (lambda c: c["doctor"]["configOwnership"].update(status="blocked", claims=[]), "ownership_blocked"),
                (lambda c: c["tracker-site"]["configOwnership"].update(status="blocked", claims=[]), "ownership_blocked")):
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
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("tracker-site")
        data["selection"]["disable"].remove("tracker-site")
        overlay(data, self.components)
        blocked = copy.deepcopy(self.components)
        blocked["tracker-site"].update(status="blocked", reason="Blocked for this test.")
        with self.assertRaisesRegex(Invalid, "^blocked_component:"):
            overlay(data, blocked)
        data = copy.deepcopy(self.base)
        data["selection"]["enable"].append("ops-footer")
        data["selection"]["disable"].remove("ops-footer")
        self.check_error(data, "missing_dependency")


if __name__ == "__main__":
    unittest.main()
