"""Owner package paths (`overlay.ownerPackages`): synthetic paths only; no path here is opened."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.candidate_compare import compare
from scripts.profile_plan import prepare
from scripts.profile_write import WriteError, write
from scripts.validate import ROOT, Invalid, load, manifest, overlay
from tests.test_candidate_compare import candidate, fields, overlay_for

CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
PLAIN = "/home/example/git/owner skills"
FILTERED = {"source": "/home/example/git/owner-tools", "extensions": ["extensions/index.ts"],
            "skills": ["skills/example", "!skills/draft-*"], "prompts": []}


class OwnerPackageTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")
        self.components = manifest(copy.deepcopy(self.manifest))
        self.overlay = load(ROOT / "config/config.example.json")
        self.overlay["target"]["agentDir"] = "/home/example/profiles/new"

    def error(self, items, rule, field):
        self.overlay["ownerPackages"] = items
        with self.assertRaises(Invalid) as caught:
            overlay(self.overlay, self.components)
        # A static diagnostic: the rule and the field path, never the input value.
        self.assertEqual(rule + ": " + field, str(caught.exception))
        with self.assertRaises(Invalid) as planned:
            prepare(self.manifest, self.overlay)
        self.assertEqual(str(caught.exception), str(planned.exception))

    def test_key_is_optional_and_examples_do_not_use_it(self):
        overlay(self.overlay, self.components)
        self.assertNotIn("ownerPackages", self.overlay)
        # The generated examples still match their tracked files and do not carry the key.
        result = subprocess.run([sys.executable, str(ROOT / "scripts/examples.py")], cwd=ROOT, text=True,
                                capture_output=True, check=False, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual((0, "examples valid\n"), (result.returncode, result.stdout))
        self.assertNotIn("ownerPackages", (ROOT / "config/config.example.json").read_text(encoding="utf-8"))
        self.overlay["ownerPackages"] = []
        plan = prepare(self.manifest, self.overlay)
        self.assertEqual([], plan["files"]["settings.json"]["content"]["packages"])

    def test_both_forms_validate_and_filters_accept_paths_and_exclusions(self):
        self.overlay["ownerPackages"] = [PLAIN, copy.deepcopy(FILTERED), {"source": "/srv/only source"}]
        overlay(self.overlay, self.components)
        self.overlay["ownerPackages"] = [{"source": PLAIN, "skills": ["!**/*.draft", "a b/c.d", "!x?"]}]
        overlay(self.overlay, self.components)

    def test_source_uses_the_absolute_path_rules(self):
        for value, rule in (("relative/path", "absolute_path"), ("/a/../b", "absolute_path"), ("/a//b", "absolute_path"),
                            ("/a/", "absolute_path"), ("/a/$(" + CANARY + ")", "shell_or_template"),
                            ("/a/`" + CANARY + "`", "shell_or_template"), ("/a\n" + CANARY, "text"), ("", "text"),
                            ("npm:" + CANARY, "absolute_path"), ("git:https://example.invalid/" + CANARY, "absolute_path")):
            with self.subTest(rule=rule):
                self.error([value], rule, "overlay.ownerPackages.item.source")
                self.error([{"source": value}], rule, "overlay.ownerPackages.item.source")

    def test_shape_errors(self):
        self.error(PLAIN, "array", "overlay.ownerPackages")
        self.error({"0": PLAIN}, "array", "overlay.ownerPackages")
        self.error([7], "object", "overlay.ownerPackages.item")
        self.error([None], "object", "overlay.ownerPackages.item")
        self.error([{"skills": []}], "required_fields", "overlay.ownerPackages.item")
        self.error([{"source": PLAIN, "themes": []}], "unknown_fields", "overlay.ownerPackages.item")
        self.error([{"source": PLAIN, CANARY: 1}], "unknown_fields", "overlay.ownerPackages.item")
        self.error([{"source": 7}], "text", "overlay.ownerPackages.item.source")

    def test_duplicate_source(self):
        self.error([PLAIN, PLAIN], "duplicate_source", "overlay.ownerPackages.item.source")
        self.error([PLAIN, {"source": PLAIN, "skills": []}], "duplicate_source", "overlay.ownerPackages.item.source")

    def test_kit_declared_package_path_is_a_duplicate_package(self):
        for path in ("packages/tenantext", "packages/promptr"):
            # Enabled or not: the kit owns its package directories.
            self.error([str(ROOT / path)], "duplicate_package", "overlay.ownerPackages.item.source")
            self.error([{"source": str(ROOT / path), "skills": []}], "duplicate_package", "overlay.ownerPackages.item.source")
        self.overlay["ownerPackages"] = [str(ROOT / "packages/tenantext/skills")]
        overlay(self.overlay, self.components)  # A different path is not compared by containment.

    def test_bad_filter_entries(self):
        for key in ("extensions", "skills", "prompts"):
            for value in ("not a list", {"a": 1}, None, [7], [None], [""], ["!"], ["/abs"], ["a/../b"], ["!a/../b"],
                          ["../" + CANARY], ["./a"], ["a//b"], ["a/"], ["a*"], ["+a"], ["-a"], ["-skills/draft"], ["+!a"],
                          [" "], ["!  "], [" a"], ["a "], ["a/ b"], ["a /b"], ["! a"], ["!a/b "], ["a", "a"], ["$" + CANARY],
                          ["!`" + CANARY + "`"], ["a\\b"], ["a\n" + CANARY], [["a"]]):
                with self.subTest(key=key, value=repr(value)):
                    self.error([{"source": PLAIN, key: value}], "package_filter", "overlay.ownerPackages.item." + key)

    def test_filter_entry_may_hold_an_inner_space_or_an_inner_hyphen(self):
        self.overlay["ownerPackages"] = [{"source": PLAIN, "skills": ["a b/c-d", "a/-b", "!a b/*-c"]}]
        overlay(self.overlay, self.components)

    def test_rendered_after_every_kit_declaration_in_overlay_order(self):
        for cid in ("doctor", "herdr"):
            self.overlay["selection"]["disable"].remove(cid)
            self.overlay["selection"]["enable"].append(cid)
        self.overlay["ownerPackages"] = [copy.deepcopy(FILTERED), PLAIN, {"source": "/srv/only source"}]
        plan = prepare(self.manifest, self.overlay)
        packages = plan["files"]["settings.json"]["content"]["packages"]
        self.assertEqual(str(ROOT / "packages/tenantext"), packages[0]["source"])
        # Exact Pi shape: a plain path stays a string, an object keeps only its given keys.
        self.assertEqual([FILTERED, PLAIN, {"source": "/srv/only source"}], packages[1:])
        self.assertIsNot(self.overlay["ownerPackages"][0], packages[1])
        gaps = [gap["subject"] for gap in plan["readinessGaps"] if gap["code"] == "owner_package_unqualified"]
        self.assertEqual([FILTERED["source"], PLAIN, "/srv/only source"], gaps)
        choices = plan["files"][".tenant-pi/choices.json"]["content"]
        self.assertEqual(self.overlay["ownerPackages"], choices["overlay"]["ownerPackages"])
        self.assertEqual(json.dumps(plan, sort_keys=True), json.dumps(prepare(self.manifest, self.overlay), sort_keys=True))
        # No setup command installs or updates an owner package.
        self.assertEqual(1, len(plan["commands"]["setup"]))
        self.assertNotIn("owner skills", json.dumps(plan["commands"]))

    def test_compare_shows_added_removed_and_changed_owner_packages_as_markers(self):
        old = candidate(overlay_for("/home/example/old"))
        new = candidate(overlay_for("/home/example/new", ownerPackages=["/home/example/" + CANARY, copy.deepcopy(FILTERED)]))
        report = compare(old, new)
        added = fields(report, "added")
        for field in (("settings.json", "/packages/0/source"), ("settings.json", "/packages/1/source"),
                      ("settings.json", "/packages/1/resources"), (".tenant-pi/choices.json", "/overlay/ownerPackages/0"),
                      (".tenant-pi/choices.json", "/overlay/ownerPackages/1")):
            self.assertIn(field, added)
        self.assertNotIn(("settings.json", "/packages/0/resources"), added)
        self.assertEqual([], report["unsupported"])
        text = json.dumps(report)
        for private in (CANARY, "owner-tools", "/home/example", "draft"):
            self.assertNotIn(private, text)
        by_field = {(c["file"], c["field"]): c for c in report["changes"]}
        self.assertEqual({"status": "unsupported_value"}, by_field[("settings.json", "/packages/0/source")]["right"])
        self.assertNotIn("right", by_field[(".tenant-pi/choices.json", "/overlay/ownerPackages/0")])
        for side in ("left", "right"):
            self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report[side]["drift"])
        removed = fields(compare(new, old), "removed")
        self.assertIn(("settings.json", "/packages/1/source"), removed)
        self.assertIn((".tenant-pi/choices.json", "/overlay/ownerPackages/1"), removed)
        edited = candidate(overlay_for("/home/example/new", ownerPackages=["/home/example/other", copy.deepcopy(FILTERED)]))
        changed = fields(compare(new, edited), "changed")
        self.assertEqual([(".tenant-pi/choices.json", "/overlay/ownerPackages/0"), ("settings.json", "/packages/0/source")], changed)
        self.assertEqual(json.dumps(report, sort_keys=True), json.dumps(compare(old, new), sort_keys=True))

    def test_compare_indexes_count_kit_declarations_first_in_settings_only(self):
        selection = {"enable": ["core", "doctor"], "disable": []}
        old = candidate(overlay_for("/home/example/old", selection=copy.deepcopy(selection)))
        new = candidate(overlay_for("/home/example/new", selection=copy.deepcopy(selection),
                                    ownerPackages=["/home/example/" + CANARY, copy.deepcopy(FILTERED)]))
        self.assertEqual(str(ROOT / "packages/tenantext"), new["settings.json"]["packages"][0]["source"])
        report = compare(old, new)
        added = fields(report, "added")
        # The kit package keeps index 0 of settings.packages; the overlay list starts at 0 again.
        self.assertEqual([(".tenant-pi/choices.json", "/overlay/ownerPackages/0"), (".tenant-pi/choices.json", "/overlay/ownerPackages/1"),
                          ("settings.json", "/packages/1/source"), ("settings.json", "/packages/2/resources"),
                          ("settings.json", "/packages/2/source")], added)
        self.assertIn({"file": "settings.json", "field": "/packages/0/source"}, report["unchanged"])
        self.assertIn({"file": "settings.json", "field": "/packages/0/resources"}, report["unchanged"])
        self.assertEqual([], report["unsupported"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_compare_marks_a_recorded_non_list_as_unsupported_shape(self):
        new = candidate(overlay_for("/home/example/new", ownerPackages=[PLAIN]))
        for value in (CANARY, {CANARY: PLAIN}, [PLAIN, 7]):
            with self.subTest(value=repr(value)):
                edited = copy.deepcopy(new)
                edited[".tenant-pi/choices.json"]["overlay"]["ownerPackages"] = value
                report = compare(candidate(overlay_for("/home/example/old")), edited)
                self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerPackages", "side": "right",
                               "status": "unsupported_shape"}, report["unsupported"])
                self.assertNotIn("/overlay/ownerPackages/0", json.dumps(report))
                self.assertNotIn(CANARY, json.dumps(report))

    def test_guarded_writer_rejects_a_changed_owner_entry_before_a_write(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-owner-write-") as temp:
            parent = Path(temp).resolve() / "owned parent"
            parent.mkdir(mode=0o700)
            target = parent / "new profile"
            self.overlay["target"]["agentDir"] = str(target)
            self.overlay["ownerPackages"] = [PLAIN, copy.deepcopy(FILTERED)]
            plan = prepare(self.manifest, self.overlay)
            packages = lambda p: p["files"]["settings.json"]["content"]["packages"]
            for edit in (lambda p: packages(p).__setitem__(0, "/home/example/" + CANARY),
                         lambda p: packages(p)[1]["skills"].append(CANARY),
                         lambda p: packages(p).append("/home/example/" + CANARY),
                         lambda p: packages(p).pop()):
                changed = copy.deepcopy(plan)
                edit(changed)
                with self.assertRaises(WriteError) as caught:
                    write(changed, str(target))
                self.assertEqual("invalid_plan: plan_mismatch: plan", str(caught.exception))
                self.assertFalse(caught.exception.candidate_created)
                self.assertFalse(target.exists())
            self.assertTrue(write(plan, str(target)).complete)
            written = json.loads((target / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual([PLAIN, FILTERED], written["packages"])

    def test_compare_reports_a_hand_edit_of_an_owner_package_as_drift(self):
        new = candidate(overlay_for("/home/example/new", ownerPackages=[PLAIN]))
        new["settings.json"]["packages"].append("/home/example/" + CANARY)
        report = compare(candidate(overlay_for("/home/example/old")), new)
        self.assertEqual({"status": "owner_edits", "fields": ["/packages"], "metadata": "unchanged"}, report["right"]["drift"])
        self.assertNotIn(CANARY, json.dumps(report))
        new["settings.json"]["packages"].append(7)
        report = compare(candidate(overlay_for("/home/example/old")), new)
        self.assertIn({"file": "settings.json", "field": "/packages", "side": "right", "status": "unsupported_shape"},
                      report["unsupported"])


class OwnerPackageCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-owner-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.file = self.base / "overlay.json"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        # The paths do not exist: the kit must not check, open or install them.
        self.plain = str(self.base / "absent" / "owner skills")
        self.filtered = {"source": str(self.base / "absent" / "owner-tools"), "skills": ["skills/example", "!skills/draft-*"]}
        # The three actions read `HOME` to find `~/.pi/agent`: the disposable directory, never the real one.
        self.env = dict(os.environ, HOME=str(self.base), PYTHONDONTWRITEBYTECODE="1")

    def run_cli(self, action, *extra):
        self.file.write_text(json.dumps(self.data), encoding="utf-8")
        return subprocess.run([sys.executable, str(CLI), action, "--overlay", str(self.file), *extra],
                              cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def test_validate_plan_and_generate_accept_both_forms(self):
        self.data["ownerPackages"] = [self.plain, self.filtered]
        result = self.run_cli("validate")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertTrue(json.loads(result.stdout)["valid"])
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        plan = json.loads(result.stdout)
        self.assertEqual([self.plain, self.filtered], plan["ownerPackages"])
        for source in (self.plain, self.filtered["source"]):
            self.assertIn({"code": "owner_package_unqualified", "subject": source}, plan["readinessGaps"])
        self.assertEqual(result.stdout, self.run_cli("plan").stdout)
        self.assertFalse(self.target.exists())
        result = self.run_cli("generate", "--target", str(self.target))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual([self.plain, self.filtered], json.loads(result.stdout)["ownerPackages"])
        settings = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual([self.plain, self.filtered], settings["packages"])
        choices = json.loads((self.target / ".tenant-pi/choices.json").read_text(encoding="utf-8"))
        self.assertEqual([self.plain, self.filtered], choices["overlay"]["ownerPackages"])
        self.assertFalse((self.base / "absent").exists())
        # A second candidate without the packages: the CLI comparison shows them as removed.
        second = self.parent / "second profile"
        self.data["target"]["agentDir"] = str(second)
        del self.data["ownerPackages"]
        self.assertEqual(0, self.run_cli("generate", "--target", str(second)).returncode)
        result = subprocess.run([sys.executable, str(CLI), "compare", "--left", str(self.target), "--right", str(second)],
                                cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        removed = [(c["file"], c["field"]) for c in report["changes"] if c["change"] == "removed"]
        self.assertIn(("settings.json", "/packages/0/source"), removed)
        self.assertIn(("settings.json", "/packages/1/source"), removed)
        self.assertNotIn("owner-tools", json.dumps(report["changes"]))

    def test_plan_without_the_key_lists_no_owner_package(self):
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        plan = json.loads(result.stdout)
        self.assertEqual([], plan["ownerPackages"])
        self.assertNotIn("owner_package_unqualified", result.stdout)

    def test_each_rule_fails_with_a_static_diagnostic_and_no_target(self):
        cases = ((["relative/" + CANARY], "absolute_path: overlay.ownerPackages.item.source"),
                 ([self.plain, {"source": self.plain}], "duplicate_source: overlay.ownerPackages.item.source"),
                 ([str(ROOT / "packages/tenantext")], "duplicate_package: overlay.ownerPackages.item.source"),
                 ([{"source": self.plain, "skills": ["../" + CANARY]}], "package_filter: overlay.ownerPackages.item.skills"))
        for items, diagnostic in cases:
            self.data["ownerPackages"] = items
            for action, extra in (("validate", ()), ("plan", ()), ("generate", ("--target", str(self.target)))):
                with self.subTest(diagnostic=diagnostic, action=action):
                    result = self.run_cli(action, *extra)
                    self.assertEqual((2, ""), (result.returncode, result.stdout))
                    self.assertEqual({"error": diagnostic, "candidate_created": False}, json.loads(result.stderr))
                    self.assertNotIn(CANARY, result.stderr)
                    self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
