"""Owner skill and prompt directories (`overlay.ownerResources`): synthetic paths only; no path here is opened."""
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
from scripts.validate import MAX_OWNER_RESOURCE_PATH, MAX_OWNER_RESOURCES, ROOT, Invalid, load, manifest, overlay
from tests.test_candidate_compare import candidate, fields, overlay_for

CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
SKILLS = ["/home/example/git/owner skills", "/srv/shared/skills"]
PROMPTS = ["/home/example/git/owner-prompts"]
CHOICES = ".tenant-pi/choices.json"


class OwnerResourceTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")
        self.components = manifest(copy.deepcopy(self.manifest))
        self.overlay = load(ROOT / "config/config.example.json")
        self.overlay["target"]["agentDir"] = "/home/example/profiles/new"

    def error(self, value, rule, field):
        self.overlay["ownerResources"] = value
        with self.assertRaises(Invalid) as caught:
            overlay(self.overlay, self.components)
        # A static diagnostic: the rule and the field path, never the input value.
        self.assertEqual(rule + ": " + field, str(caught.exception))
        with self.assertRaises(Invalid) as planned:
            prepare(self.manifest, self.overlay)
        self.assertEqual(str(caught.exception), str(planned.exception))

    def test_key_is_optional_and_examples_do_not_use_it(self):
        overlay(self.overlay, self.components)
        self.assertNotIn("ownerResources", self.overlay)
        # The generated examples still match their tracked files and do not carry the key.
        result = subprocess.run([sys.executable, str(ROOT / "scripts/examples.py")], cwd=ROOT, text=True,
                                capture_output=True, check=False, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual((0, "examples valid\n"), (result.returncode, result.stdout))
        self.assertNotIn("ownerResources", (ROOT / "config/config.example.json").read_text(encoding="utf-8"))
        baseline = prepare(self.manifest, self.overlay)["files"]["settings.json"]["content"]
        # An empty object and empty lists render no `skills` and no `prompts` key.
        for value in ({}, {"skills": []}, {"skills": [], "prompts": []}):
            self.overlay["ownerResources"] = value
            plan = prepare(self.manifest, self.overlay)
            self.assertEqual(baseline, plan["files"]["settings.json"]["content"])
            self.assertNotIn("owner_resource_unqualified", json.dumps(plan["readinessGaps"]))

    def test_each_kind_alone_and_both_validate(self):
        for value in ({"skills": SKILLS}, {"prompts": PROMPTS}, {"skills": SKILLS, "prompts": PROMPTS},
                      # One directory may hold both kinds; a duplicate is counted inside one list only.
                      {"skills": ["/srv/both"], "prompts": ["/srv/both"]},
                      {"skills": ["/srv/a/-b", "/srv/a b/c-d", "/srv/it's"]}):
            with self.subTest(value=repr(value)):
                self.overlay["ownerResources"] = value
                overlay(self.overlay, self.components)

    def test_shape_errors(self):
        self.error(SKILLS, "object", "overlay.ownerResources")
        self.error(None, "object", "overlay.ownerResources")
        self.error({"extensions": []}, "unknown_fields", "overlay.ownerResources")
        self.error({"themes": []}, "unknown_fields", "overlay.ownerResources")
        self.error({"skills": [], CANARY: 1}, "unknown_fields", "overlay.ownerResources")
        for kind in ("skills", "prompts"):
            for value in (SKILLS[0], {"0": SKILLS[0]}, None, 7):
                with self.subTest(kind=kind, value=repr(value)):
                    self.error({kind: value}, "array", "overlay.ownerResources." + kind)

    def test_entry_uses_the_absolute_path_rules(self):
        for kind in ("skills", "prompts"):
            for value, rule in (("relative/path", "absolute_path"), ("/a/../b", "absolute_path"), ("/a//b", "absolute_path"),
                                ("/a/", "absolute_path"), ("/", "absolute_path"), ("~/skills", "absolute_path"),
                                ("/a/~" + CANARY, "absolute_path"), ("/a/*", "absolute_path"), ("/a/b?", "absolute_path"),
                                ("/a/*.md", "absolute_path"), ("file:///" + CANARY, "absolute_path"),
                                ("npm:" + CANARY, "absolute_path"), ("/a/$(" + CANARY + ")", "shell_or_template"),
                                ("/a/`" + CANARY + "`", "shell_or_template"), ("/a/{{" + CANARY + "}}", "shell_or_template"),
                                ("/a\n" + CANARY, "text"), ("/a\x00" + CANARY, "text"), ("", "text"), (7, "text"),
                                (None, "text"), (["/a"], "text"), ({"source": "/a"}, "text")):
                with self.subTest(kind=kind, value=repr(value)):
                    self.error({kind: [value]}, rule, "overlay.ownerResources." + kind)

    def test_pi_directive_prefix_has_its_own_rule(self):
        for kind in ("skills", "prompts"):
            for value in ("-/srv/" + CANARY, "!/srv/" + CANARY, "+/srv/" + CANARY, "-", "!", "+", "-skills/draft",
                          "!**/*.md", "+skills/a", "-builtin:mcp"):
                with self.subTest(kind=kind, value=value):
                    self.error({kind: [value]}, "resource_directive", "overlay.ownerResources." + kind)

    def test_entry_that_pi_would_trim_is_rejected(self):
        target = self.overlay["target"]["agentDir"]
        for kind in ("skills", "prompts"):
            for value in ("/ ", "/a ", "/a/ ", " /a", target + " ", " " + target, "/a/ /b", "/  /" + CANARY, " ",
                          "\t/a", "/a\n", " -/srv/" + CANARY, "/srv/" + CANARY + "\u00a0"):
                with self.subTest(kind=kind, value=repr(value)):
                    self.error({kind: [value]}, "resource_whitespace", "overlay.ownerResources." + kind)
        # A space inside a segment, also at its edge, is part of the directory name: Pi trims the entry only.
        self.overlay["ownerResources"] = {"skills": ["/srv/a b/c", "/srv/a /b", "/srv/ a/b"]}
        overlay(self.overlay, self.components)

    def test_entry_in_at_or_above_the_kit_packages_is_rejected(self):
        for kind in ("skills", "prompts"):
            for value in (str(ROOT / "packages"), str(ROOT / "packages/tenantext"), str(ROOT / "packages/tenantext/skills"),
                          str(ROOT / "packages/promptr/skills/promptr-handoff"), str(ROOT / "packages/absent"),
                          str(ROOT), str(ROOT.parent)):
                with self.subTest(kind=kind, value=value):
                    self.error({kind: [value]}, "kit_package", "overlay.ownerResources." + kind)
        # A sibling of `packages/` and a name that only shares the prefix are outside the rule.
        self.overlay["ownerResources"] = {"skills": [str(ROOT / "skills"), str(ROOT / "packages-owner"), str(ROOT) + "-owner"]}
        overlay(self.overlay, self.components)

    def test_duplicate_entry_in_one_list(self):
        self.error({"skills": [SKILLS[0], SKILLS[1], SKILLS[0]]}, "duplicate_resource", "overlay.ownerResources.skills")
        self.error({"prompts": [PROMPTS[0], PROMPTS[0]]}, "duplicate_resource", "overlay.ownerResources.prompts")

    def test_entry_inside_the_target_profile_is_rejected(self):
        target = self.overlay["target"]["agentDir"]
        for kind in ("skills", "prompts"):
            for value in (target, target + "/" + kind, target + "/deep/er"):
                with self.subTest(kind=kind, value=value):
                    self.error({kind: [value]}, "inside_target", "overlay.ownerResources." + kind)
        # A sibling that shares the name prefix is outside the target.
        self.overlay["ownerResources"] = {"skills": [target + "-skills", "/home/example/profiles"]}
        overlay(self.overlay, self.components)

    def test_list_and_path_bounds(self):
        full = ["/srv/skills/s" + str(index) for index in range(MAX_OWNER_RESOURCES)]
        longest = "/" + "a" * (MAX_OWNER_RESOURCE_PATH - 1)
        self.overlay["ownerResources"] = {"skills": full, "prompts": [longest]}
        overlay(self.overlay, self.components)
        for kind in ("skills", "prompts"):
            self.error({kind: full + ["/srv/one more"]}, "resource_count", "overlay.ownerResources." + kind)
            self.error({kind: [longest + "a"]}, "resource_path_length", "overlay.ownerResources." + kind)

    def test_rendered_into_the_pi_arrays_in_overlay_order(self):
        for cid in ("doctor", "herdr", "resources"):
            self.overlay["selection"]["disable"].remove(cid)
            self.overlay["selection"]["enable"].append(cid)
        self.overlay["ownerResources"] = {"prompts": list(PROMPTS), "skills": list(SKILLS)}
        plan = prepare(self.manifest, self.overlay)
        settings = plan["files"]["settings.json"]["content"]
        # Exact Pi shape: two top-level string arrays. The kit renders no entry of its own before them.
        self.assertEqual(SKILLS, settings["skills"])
        self.assertEqual(PROMPTS, settings["prompts"])
        self.assertIsNot(self.overlay["ownerResources"]["skills"], settings["skills"])
        # The kit skill stays a filter of its package entry; an owner directory never enters `packages`.
        self.assertEqual([str(ROOT / "packages/tenantext")], [package["source"] for package in settings["packages"]])
        self.assertEqual(["skills/herdr"], settings["packages"][0]["skills"])
        gaps = [gap["subject"] for gap in plan["readinessGaps"] if gap["code"] == "owner_resource_unqualified"]
        self.assertEqual(["skills:" + SKILLS[0], "skills:" + SKILLS[1], "prompts:" + PROMPTS[0]], gaps)
        choices = plan["files"][CHOICES]["content"]
        self.assertEqual(self.overlay["ownerResources"], choices["overlay"]["ownerResources"])
        self.assertEqual(json.dumps(plan, sort_keys=True), json.dumps(prepare(self.manifest, self.overlay), sort_keys=True))
        # No setup or launch command names an owner directory.
        self.assertEqual(1, len(plan["commands"]["setup"]))
        self.assertNotIn("owner", json.dumps(plan["commands"]))

    def test_one_kind_renders_one_key(self):
        self.overlay["ownerResources"] = {"prompts": list(PROMPTS)}
        settings = prepare(self.manifest, self.overlay)["files"]["settings.json"]["content"]
        self.assertEqual(PROMPTS, settings["prompts"])
        self.assertNotIn("skills", settings)

    def test_owner_packages_and_owner_resources_stay_separate(self):
        self.overlay["ownerPackages"] = [SKILLS[0]]
        self.overlay["ownerResources"] = {"skills": [SKILLS[1]]}
        settings = prepare(self.manifest, self.overlay)["files"]["settings.json"]["content"]
        self.assertEqual([SKILLS[0]], settings["packages"])
        self.assertEqual([SKILLS[1]], settings["skills"])

    def test_compare_shows_added_removed_and_changed_entries_as_markers(self):
        old = candidate(overlay_for("/home/example/old"))
        new = candidate(overlay_for("/home/example/new",
                                    ownerResources={"skills": ["/home/example/" + CANARY, SKILLS[1]], "prompts": list(PROMPTS)}))
        report = compare(old, new)
        added = fields(report, "added")
        expected = [(CHOICES, "/overlay/ownerResources/prompts/0"), (CHOICES, "/overlay/ownerResources/skills/0"),
                    (CHOICES, "/overlay/ownerResources/skills/1"), ("settings.json", "/prompts/0"),
                    ("settings.json", "/skills/0"), ("settings.json", "/skills/1")]
        self.assertEqual(expected, added)
        self.assertEqual([], report["unsupported"])
        text = json.dumps(report)
        for private in (CANARY, "owner-prompts", "/home/example", "/srv"):
            self.assertNotIn(private, text)
        # A marker has no value on either side.
        for change in report["changes"]:
            if (change["file"], change["field"]) in expected:
                self.assertEqual({"file", "field", "change"}, set(change))
        for side in ("left", "right"):
            self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report[side]["drift"])
        self.assertEqual(expected, fields(compare(new, old), "removed"))
        # One entry less at the end of one list: exactly that index is removed.
        shorter = candidate(overlay_for("/home/example/new",
                                        ownerResources={"skills": ["/home/example/" + CANARY], "prompts": list(PROMPTS)}))
        self.assertEqual([(CHOICES, "/overlay/ownerResources/skills/1"), ("settings.json", "/skills/1")],
                         fields(compare(new, shorter), "removed"))
        edited = candidate(overlay_for("/home/example/new",
                                       ownerResources={"skills": ["/home/example/other", SKILLS[1]], "prompts": list(PROMPTS)}))
        self.assertEqual([(CHOICES, "/overlay/ownerResources/skills/0"), ("settings.json", "/skills/0")],
                         fields(compare(new, edited), "changed"))
        self.assertEqual(json.dumps(report, sort_keys=True), json.dumps(compare(old, new), sort_keys=True))

    def test_compare_marks_a_recorded_bad_shape_as_unsupported(self):
        new = candidate(overlay_for("/home/example/new", ownerResources={"skills": list(SKILLS)}))
        old = candidate(overlay_for("/home/example/old"))
        for value, field in ((CANARY, "/overlay/ownerResources"), ([SKILLS[0]], "/overlay/ownerResources"),
                             ({"skills": CANARY}, "/overlay/ownerResources/skills"),
                             ({"skills": [SKILLS[0], 7]}, "/overlay/ownerResources/skills"),
                             ({"prompts": {CANARY: 1}}, "/overlay/ownerResources/prompts")):
            with self.subTest(value=repr(value)):
                edited = copy.deepcopy(new)
                edited[CHOICES]["overlay"]["ownerResources"] = value
                report = compare(old, edited)
                self.assertIn({"file": CHOICES, "field": field, "side": "right", "status": "unsupported_shape"},
                              report["unsupported"])
                self.assertNotIn("/overlay/ownerResources/skills/0", json.dumps(report))
                self.assertNotIn(CANARY, json.dumps(report))
        edited = copy.deepcopy(new)
        edited[CHOICES]["overlay"]["ownerResources"]["themes"] = [CANARY]
        report = compare(old, edited)
        self.assertIn({"file": CHOICES, "field": "/overlay/ownerResources/themes", "side": "right",
                       "status": "unsupported_field"}, report["unsupported"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_compare_reports_a_hand_edit_as_drift_and_never_echoes_it(self):
        old = candidate(overlay_for("/home/example/old"))
        new = candidate(overlay_for("/home/example/new", ownerResources={"skills": list(SKILLS)}))
        # The `/resources` command of the kit writes a `-<path>` entry into the same array.
        new["settings.json"]["skills"].append("-../" + CANARY)
        new["settings.json"]["prompts"] = ["!" + CANARY + "/*.md"]
        report = compare(old, new)
        self.assertEqual({"status": "owner_edits", "fields": ["/prompts", "/skills"], "metadata": "unchanged"},
                         report["right"]["drift"])
        self.assertIn(("settings.json", "/skills/2"), fields(report, "added"))
        self.assertIn(("settings.json", "/prompts/0"), fields(report, "added"))
        self.assertEqual([], report["unsupported"])
        self.assertNotIn(CANARY, json.dumps(report))
        for value in (CANARY, {CANARY: 1}, [SKILLS[0], 7], [[CANARY]]):
            with self.subTest(value=repr(value)):
                new["settings.json"]["skills"] = value
                report = compare(old, new)
                self.assertIn({"file": "settings.json", "field": "/skills", "side": "right", "status": "unsupported_shape"},
                              report["unsupported"])
                self.assertNotIn(CANARY, json.dumps(report))

    def test_compare_reads_the_arrays_of_a_settings_only_side(self):
        live = {"settings.json": {"skills": ["/home/example/" + CANARY, "-skills/" + CANARY], "prompts": []},
                CHOICES: None, ".tenant-pi/state.json": None}
        report = compare(live, candidate(overlay_for("/home/example/new", ownerResources={"skills": [SKILLS[0]]})))
        self.assertEqual("settings_only", report["left"]["kind"])
        self.assertIn(("settings.json", "/skills/0"), fields(report, "changed"))
        self.assertIn(("settings.json", "/skills/1"), fields(report, "removed"))
        self.assertNotIn({"file": "settings.json", "field": "/skills", "side": "left", "status": "unsupported_field"},
                         report["unsupported"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_guarded_writer_rejects_a_changed_owner_entry_before_a_write(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-owner-res-write-") as temp:
            parent = Path(temp).resolve() / "owned parent"
            parent.mkdir(mode=0o700)
            target = parent / "new profile"
            self.overlay["target"]["agentDir"] = str(target)
            self.overlay["ownerResources"] = {"skills": list(SKILLS), "prompts": list(PROMPTS)}
            plan = prepare(self.manifest, self.overlay)
            content = lambda p: p["files"]["settings.json"]["content"]
            for edit in (lambda p: content(p)["skills"].__setitem__(0, "/home/example/" + CANARY),
                         lambda p: content(p)["skills"].append("-" + CANARY),
                         lambda p: content(p)["prompts"].pop(),
                         lambda p: content(p).pop("prompts")):
                changed = copy.deepcopy(plan)
                edit(changed)
                with self.assertRaises(WriteError) as caught:
                    write(changed, str(target))
                self.assertEqual("invalid_plan: plan_mismatch: plan", str(caught.exception))
                self.assertFalse(caught.exception.candidate_created)
                self.assertFalse(target.exists())
            self.assertTrue(write(plan, str(target)).complete)
            written = json.loads((target / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual((SKILLS, PROMPTS), (written["skills"], written["prompts"]))


class OwnerResourceCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-owner-res-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.file = self.base / "overlay.json"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        # The directories do not exist: the kit must not check, open or copy them.
        self.skills = [str(self.base / "absent" / "owner skills"), str(self.base / "absent" / "more-skills")]
        self.prompts = [str(self.base / "absent" / "prompts")]
        # The three actions read `HOME` to find `~/.pi/agent`: the disposable directory, never the real one.
        self.env = dict(os.environ, HOME=str(self.base), PYTHONDONTWRITEBYTECODE="1")

    def run_cli(self, action, *extra):
        self.file.write_text(json.dumps(self.data), encoding="utf-8")
        return subprocess.run([sys.executable, str(CLI), action, "--overlay", str(self.file), *extra],
                              cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def test_validate_plan_generate_and_compare(self):
        self.data["ownerResources"] = {"skills": self.skills, "prompts": self.prompts}
        result = self.run_cli("validate")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertTrue(json.loads(result.stdout)["valid"])
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        plan = json.loads(result.stdout)
        self.assertEqual({"skills": self.skills, "prompts": self.prompts}, plan["ownerResources"])
        for subject in ["skills:" + path for path in self.skills] + ["prompts:" + path for path in self.prompts]:
            self.assertIn({"code": "owner_resource_unqualified", "subject": subject}, plan["readinessGaps"])
        # Deterministic: sorted keys, fixed separators, the same bytes on a second run.
        self.assertEqual(json.dumps(plan, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n", result.stdout)
        self.assertEqual(result.stdout, self.run_cli("plan").stdout)
        self.assertFalse(self.target.exists())
        result = self.run_cli("generate", "--target", str(self.target))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual({"skills": self.skills, "prompts": self.prompts}, json.loads(result.stdout)["ownerResources"])
        settings = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual((self.skills, self.prompts), (settings["skills"], settings["prompts"]))
        choices = json.loads((self.target / ".tenant-pi/choices.json").read_text(encoding="utf-8"))
        self.assertEqual({"skills": self.skills, "prompts": self.prompts}, choices["overlay"]["ownerResources"])
        # Nothing is copied into the candidate and no owner directory is created.
        self.assertEqual([".tenant-pi", "settings.json"], sorted(entry.name for entry in self.target.iterdir()))
        self.assertFalse((self.base / "absent").exists())
        # A second candidate with one skill directory less: the CLI comparison shows the removed entries.
        second = self.parent / "second profile"
        self.data["target"]["agentDir"] = str(second)
        self.data["ownerResources"] = {"skills": self.skills[:1]}
        self.assertEqual(0, self.run_cli("generate", "--target", str(second)).returncode)
        result = subprocess.run([sys.executable, str(CLI), "compare", "--left", str(self.target), "--right", str(second)],
                                cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        # Deterministic: the same bytes on a second run.
        again = subprocess.run([sys.executable, str(CLI), "compare", "--left", str(self.target), "--right", str(second)],
                               cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((0, result.stdout), (again.returncode, again.stdout))
        self.assertEqual(json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n", result.stdout)
        removed = [(c["file"], c["field"]) for c in report["changes"] if c["change"] == "removed"]
        self.assertEqual([(CHOICES, "/overlay/ownerResources/prompts/0"), (CHOICES, "/overlay/ownerResources/skills/1"),
                          ("settings.json", "/prompts/0"), ("settings.json", "/skills/1")], removed)
        self.assertIn({"file": "settings.json", "field": "/skills/0"}, report["unchanged"])
        self.assertNotIn("absent", json.dumps(report["changes"]))
        result = subprocess.run([sys.executable, str(CLI), "compare", "--left", str(second), "--right", str(self.target)],
                                cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        added = [(c["file"], c["field"]) for c in json.loads(result.stdout)["changes"] if c["change"] == "added"]
        self.assertEqual(removed, added)

    def test_plan_without_the_key_lists_no_owner_resource(self):
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual({"skills": [], "prompts": []}, json.loads(result.stdout)["ownerResources"])
        self.assertNotIn("owner_resource_unqualified", result.stdout)

    def test_each_rule_fails_with_a_static_diagnostic_and_no_target(self):
        cases = (({"skills": ["relative/" + CANARY]}, "absolute_path: overlay.ownerResources.skills"),
                 ({"prompts": ["-/srv/" + CANARY]}, "resource_directive: overlay.ownerResources.prompts"),
                 ({"skills": ["!" + CANARY]}, "resource_directive: overlay.ownerResources.skills"),
                 ({"skills": [self.skills[0], self.skills[0]]}, "duplicate_resource: overlay.ownerResources.skills"),
                 ({"prompts": [str(self.target) + "/prompts"]}, "inside_target: overlay.ownerResources.prompts"),
                 ({"skills": [str(self.target) + " "]}, "resource_whitespace: overlay.ownerResources.skills"),
                 ({"prompts": ["/ "]}, "resource_whitespace: overlay.ownerResources.prompts"),
                 ({"skills": [str(ROOT / "packages/tenantext/skills")]}, "kit_package: overlay.ownerResources.skills"),
                 ({"skills": ["/" + CANARY * 100]}, "resource_path_length: overlay.ownerResources.skills"),
                 ({"skills": self.skills, CANARY: []}, "unknown_fields: overlay.ownerResources"))
        for value, diagnostic in cases:
            self.data["ownerResources"] = value
            for action, extra in (("validate", ()), ("plan", ()), ("generate", ("--target", str(self.target)))):
                with self.subTest(diagnostic=diagnostic, action=action):
                    result = self.run_cli(action, *extra)
                    self.assertEqual((2, ""), (result.returncode, result.stdout))
                    self.assertEqual({"error": diagnostic, "candidate_created": False}, json.loads(result.stderr))
                    self.assertNotIn(CANARY, result.stderr)
                    self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
