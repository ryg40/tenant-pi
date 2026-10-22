"""Synthetic-only fixture tests of the manifest contract; no host configuration is read."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import validate
from scripts.validate import Invalid, TREE_COMPONENTS, load, manifest, npm_parts, optional_tree_absent, tree_items

ROOT = Path(__file__).resolve().parents[1]


def kit_manifest():
    return load(ROOT / "config/manifest.json")


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.components = manifest(kit_manifest())

    def check_error(self, data, rule):
        with self.assertRaisesRegex(Invalid, "^" + rule + ":") as result:
            manifest(data)
        self.assertNotIn("CANARY_SECRET", str(result.exception))

    def test_kit_manifest_and_direct_validator(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py")],
                                capture_output=True, text=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertTrue(result.stdout.startswith("valid: "))
        self.assertEqual(2, kit_manifest()["schemaVersion"])
        data = kit_manifest()
        data["schemaVersion"] = 1
        self.check_error(data, "schema_version")

    def test_duplicate_json_and_unknown_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "fixture.json"
            file.write_text('{"canary":"CANARY_SECRET","canary":0}')
            with self.assertRaisesRegex(Invalid, "duplicate_key: JSON object") as result:
                load(file)
            self.assertNotIn("CANARY_SECRET", str(result.exception))
        for change in (lambda d: d.update(secret="CANARY_SECRET"),
                       lambda d: d["components"]["core"].update(unreviewed="CANARY_SECRET"),
                       # The fields of the generator are gone from the contract.
                       lambda d: d["components"]["core"].update(reason=None),
                       lambda d: d["components"]["core"].update(configOwnership={"claims": []})):
            data = kit_manifest()
            change(data)
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
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--manifest", str(file)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual((2, "", "invalid_json: file line=3 column=3\n"), (result.returncode, result.stdout, result.stderr))
            result = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--manifest",
                                     str(Path(tmp) / "absent.json")], capture_output=True, text=True, check=False)
            self.assertEqual((2, "", "input_missing: file\n"), (result.returncode, result.stdout, result.stderr))

    def test_sources_and_cycles(self):
        for src, rule in [
            ({"kind": "npm", "spec": "fake@latest"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@^1.0.0"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@1.x"}, "exact_npm_pin"),
            ({"kind": "npm", "spec": "fake@1.0.0", "path": "packages/tenantext"}, "source_form"),
            # A git or a local source has no form in the contract.
            ({"kind": "git", "url": "https://user:CANARY_SECRET@example.invalid/x"}, "unknown_fields"),
            ({"kind": "local"}, "source_form"),
            (None, "object"),
        ]:
            data = kit_manifest()
            data["components"]["codex-accounts"]["source"] = src
            self.check_error(data, rule)
        data = kit_manifest()
        data["components"]["core"]["source"]["spec"] = "@earendil-works/pi-coding-agent"
        self.check_error(data, "core_runtime_pin")  # the core spec keeps the tested version
        self.assertEqual(("@zosmaai/pi-llm-wiki", None), npm_parts("@zosmaai/pi-llm-wiki"))
        self.assertEqual(("@zosmaai/pi-llm-wiki", "0.12.4"), npm_parts("@zosmaai/pi-llm-wiki@0.12.4"))
        self.assertEqual(("pi-mcp-adapter", "3.2.0"), npm_parts("pi-mcp-adapter@3.2.0"))
        data = kit_manifest()
        data["components"]["codex-accounts"]["requires"] = ["not-listed"]
        self.check_error(data, "undeclared_dependency")
        data["components"]["codex-accounts"]["requires"] = ["model-routing"]
        data["components"]["model-routing"]["requires"] = ["codex-accounts"]
        self.check_error(data, "dependency_cycle")
        data = kit_manifest()
        data["components"]["core"]["requires"] = ["model-routing"]
        self.check_error(data, "core_source")

    def test_reviewed_source_and_runtime_bindings(self):
        data = kit_manifest()
        pin = data["runtime"]["piVersion"]
        for src in ({"kind": "builtin"}, {"kind": "npm", "spec": "other@" + pin}):
            changed = copy.deepcopy(data)
            changed["components"]["core"]["source"] = src
            with self.assertRaisesRegex(Invalid, "^(reviewed_source|core_runtime_pin):"):
                manifest(changed)
        changed = copy.deepcopy(data)
        changed["runtime"]["piVersion"] = "0.88.0"
        self.check_error(changed, "core_runtime_pin")
        # The anchor holds the package, the manifest holds the version: a moved pin of both fields passes.
        changed["runtime"]["piAcceptedRange"] = ">=0.88.0 <0.89"
        changed["components"]["core"]["source"]["spec"] = "@earendil-works/pi-coding-agent@0.88.0"
        manifest(changed)
        for cid, src in (("model-routing", {"kind": "npm", "spec": "fake@1.0.0"}),
                         ("codex-accounts", {"kind": "builtin"}),
                         ("mcp", {"kind": "npm", "spec": "fake@3.1.0"})):
            changed = copy.deepcopy(data)
            changed["components"][cid]["source"] = src
            self.check_error(changed, "reviewed_source")
        changed = copy.deepcopy(data)
        del changed["components"]["questions"]
        self.check_error(changed, "reviewed_components")

    def test_tested_pi_must_be_inside_a_valid_accepted_range(self):
        data = kit_manifest()
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
        changed = copy.deepcopy(data)
        changed["runtime"]["nodeRange"] = ">=20"
        self.check_error(changed, "runtime_range")

    def test_accepted_pi_range_requires_an_upper_bound(self):
        data = kit_manifest()
        tested = data["runtime"]["piVersion"].split("-", 1)[0]
        for accepted in (f">={tested}", ">=0.0", ">=0.0.0"):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            with self.subTest(accepted=accepted), self.assertRaises(Invalid) as error:
                manifest(changed)
            self.assertEqual("range_without_upper_bound: manifest.runtime.piAcceptedRange", str(error.exception))

    def test_malformed_accepted_pi_range_fails(self):
        data = kit_manifest()
        for accepted in ("", "1.0.3", "<1.1", ">=1.0.3 <=1.1", ">=1.0.3 <1.1 ", ">=1.0.3 || >=2.0", 3, [">=1.0.3 <1.1"]):
            changed = copy.deepcopy(data)
            changed["runtime"]["piAcceptedRange"] = accepted
            with self.subTest(accepted=accepted), self.assertRaises(Invalid) as error:
                manifest(changed)
            self.assertEqual("runtime_range: manifest.runtime.piAcceptedRange", str(error.exception))

    def test_tree_source_rejections(self):
        for path, rule in ((None, "source_form"),  # The `path` field is missing.
                           ("packages/not-in-the-kit", "reviewed_source"),  # An absent directory is no anchor.
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
                data = kit_manifest()
                data["components"]["doctor"]["source"] = {"kind": "tree"} if path is None else {"kind": "tree", "path": path}
                self.check_error(data, rule)
        data = kit_manifest()
        data["components"]["doctor"]["source"] = {"kind": "tree", "path": "packages/tenantext", "spec": "x@1.0.0"}
        self.check_error(data, "source_form")
        # An existing package directory that is not the reviewed anchor of the component stays rejected.
        data["components"]["doctor"]["source"] = {"kind": "tree", "path": "packages/openviking-pi"}
        self.check_error(data, "reviewed_source")

    def test_tree_resources_come_from_the_manifest_and_exist_in_the_tree(self):
        # The table of the validator is the manifest of the kit, in manifest order. The file is read
        # here with `json.load`, independent of `validate.py`, so the test guards the derivation.
        with open(ROOT / "config/manifest.json", encoding="utf-8") as handle:
            kit = json.load(handle)["components"]
        expected = [(cid, c["source"]["path"], kind, tuple(c["resources"][kind]))
                    for cid, c in kit.items() if c["source"]["kind"] == "tree"
                    for kind in ("extensions", "skills", "prompts", "themes") if c["resources"][kind]]
        self.assertEqual(expected, [(cid, path, kind, tuple(tree_items(item)))
                                    for cid, (path, kind, item) in TREE_COMPONENTS.items()])
        self.assertEqual(len(expected), len({cid for cid, *_ in expected}))
        # A tree component names a path that the tree does not hold, or no path.
        for skills in (["skills/herdr", "skills/not-in-the-kit"], []):
            with self.subTest(skills=skills):
                data = kit_manifest()
                data["components"]["herdr"]["resources"]["skills"] = skills
                self.check_error(data, "tree_resource_missing")
        data = kit_manifest()
        data["components"]["herdr"]["resources"]["skills"].append("skills/herdr")
        self.check_error(data, "duplicate_resource")
        data = kit_manifest()
        data["components"]["herdr"]["resources"]["skills"] = ["/skills/herdr"]
        self.check_error(data, "relative_path")

    def test_unreadable_kit_manifest_fails_closed_with_its_cause(self):
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
                manifest(kit_manifest())

    def test_tree_path_rejects_a_link_that_leaves_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            kit = Path(tmp) / "kit"
            (kit / "packages").mkdir(parents=True)
            (Path(tmp) / "outside").mkdir()
            (kit / "packages/escape").symlink_to(Path(tmp) / "outside")
            (kit / "packages/inside").mkdir()
            with mock.patch.object(validate, "ROOT", kit):
                validate.tree_path("packages/inside", "source.path")
                with self.assertRaisesRegex(Invalid, "^tree_outside_packages:"):
                    validate.tree_path("packages/escape", "source.path")

    def test_npm_extension_entry_names_a_file(self):
        entries = [(cid, entry) for cid, c in kit_manifest()["components"].items() if c["source"]["kind"] == "npm"
                   for entry in c["resources"]["extensions"]]
        self.assertIn(("wiki", "extensions/llm-wiki/index.ts"), entries)
        for cid, entry in entries:
            with self.subTest(cid=cid):
                self.assertRegex(entry, r"\A(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.ts\Z")

    def test_one_tree_component_per_extension_and_skill(self):
        data = kit_manifest()
        package = json.loads((ROOT / "packages/tenantext/package.json").read_text(encoding="utf-8"))
        declared = {entry[2:] for entry in package["pi"]["extensions"]}
        in_manifest = {c["resources"]["extensions"][0] for cid, c in data["components"].items()
                       if c["source"] == {"kind": "tree", "path": "packages/tenantext"} and c["resources"]["extensions"]}
        self.assertEqual(declared, in_manifest)
        package_dir = "packages/tenantext"
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
        for cid in TREE_COMPONENTS:
            component = data["components"][cid]
            path, kind, item = TREE_COMPONENTS[cid]
            items = tree_items(item)
            if not optional_tree_absent(cid):
                for one in items:
                    self.assertTrue((ROOT / path / one).exists(), cid)
            self.assertIn("core", component["requires"])
            self.assertEqual("unverified", component["status"])  # No `tested` without a test here.
            self.assertTrue(component["gaps"], cid)
            self.assertEqual(items, component["resources"][kind])
            # Only a skill component of several skills names more than one resource.
            self.assertTrue(len(items) == 1 or (kind == "skills" and cid in ("coordinator-skills", "knowledge-skills")), cid)
        self.assertEqual(["TENANTEXT_LITELLM_BASE_URL", "TENANTEXT_LITELLM_API_KEY"], data["components"]["codex-accounts"]["env"])

    def test_an_absent_tree_folder_is_no_finding_and_a_partial_folder_is(self):
        with tempfile.TemporaryDirectory() as tmp:
            kit = Path(tmp)
            # A kit with each resource path of the tree components, without the OpenViking package folder.
            for cid, (path, kind, items) in TREE_COMPONENTS.items():
                for item in tree_items(items):
                    if path != "packages/openviking-pi":
                        (kit / path / item).parent.mkdir(parents=True, exist_ok=True)
                        (kit / path / item).mkdir() if kind == "skills" else (kit / path / item).touch()
            with mock.patch.object(validate, "ROOT", kit):
                self.assertEqual(["openviking"], [cid for cid in TREE_COMPONENTS if optional_tree_absent(cid)])
                manifest(kit_manifest())
                skill = TREE_COMPONENTS["coordinator-skills"][2][0]
                (kit / "packages/tenantext" / skill).rmdir()
                with self.assertRaisesRegex(Invalid, "^tree_resource_missing: manifest.components.item.resources$"):
                    manifest(kit_manifest())

    def test_question_extension_is_a_pinned_npm_component(self):
        component = self.components["questions"]
        # The manifest holds the version and the anchor holds the package.
        name, version = npm_parts(component["source"]["spec"])
        self.assertEqual(("npm", "@juicesharp/rpiv-ask-user-question"), (component["source"]["kind"], name))
        self.assertTrue(version)
        self.assertEqual(("unverified", ["core"], "MIT"),
                         (component["status"], component["requires"], component["license"]))
        self.assertEqual({"extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []}, component["resources"])
        data = kit_manifest()
        data["components"]["questions"]["source"]["spec"] = name + "@99.0.0"
        manifest(data)
        for spec in ("rpiv-ask-user-question@" + version, "@juicesharp/other@" + version):
            data["components"]["questions"]["source"]["spec"] = spec
            self.check_error(data, "reviewed_source")
        data = kit_manifest()
        data["components"]["questions"]["status"] = "tested"
        self.check_error(data, "status_gaps")

    def test_herdr_is_a_host_tool_and_no_package_of_the_profile(self):
        gaps = {gap["code"]: gap["fact"] for gap in self.components["herdr"]["gaps"]}
        self.assertIn("the kit does not install them", gaps["host_tool_required"])
        # No component installs the Herdr application: no source names it.
        sources = json.dumps([component["source"] for component in self.components.values()])
        self.assertNotIn("herdr", sources)
        self.assertNotIn("pi-herdr", json.dumps(kit_manifest()))

    def test_status_gaps_env_and_owner_rules(self):
        for change, rule in (
                (lambda c: c["doctor"].update(status="tested"), "status_gaps"),
                (lambda c: c["doctor"].update(gaps=[]), "status_gaps"),
                (lambda c: c["doctor"].pop("gaps"), "status_gaps"),
                (lambda c: c["core"].update(gaps=[{"code": "x", "fact": "A fact"}]), "status_gaps"),
                (lambda c: c["tracker-site"].update(status="blocked"), "status"),
                (lambda c: c["doctor"]["gaps"].append(copy.deepcopy(c["doctor"]["gaps"][0])), "duplicate_gap"),
                (lambda c: c["doctor"]["gaps"][0].update(code="Bad Code"), "gap_code"),
                (lambda c: c["doctor"]["gaps"][0].update(fact="$(CANARY_SECRET)"), "shell_or_template"),
                (lambda c: c["doctor"]["gaps"][0].update(note="CANARY_SECRET"), "unknown_fields"),
                (lambda c: c["doctor"].update(gaps="CANARY_SECRET"), "array"),
                (lambda c: c["doctor"].update(env=["lower_case"]), "env_name"),
                (lambda c: c["doctor"].update(env=["X_Y", "X_Y"]), "duplicate_env"),
                (lambda c: c["doctor"].update(owner="Not An Id"), "owner"),
                (lambda c: c["doctor"].update(license=""), "text")):
            data = kit_manifest()
            change(data["components"])
            self.check_error(data, rule)


if __name__ == "__main__":
    unittest.main()
