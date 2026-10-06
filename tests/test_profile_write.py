"""Synthetic guarded-writer contract and mutation-boundary checks."""
import copy
import json
import os
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from scripts.profile_plan import prepare
from scripts.profile_write import STATE, WriteError, write
from scripts.validate import ROOT, load
from tests.test_model_routes import NATIVE, GATEWAY, REGISTRY

PIN = load(ROOT / "config/manifest.json")["runtime"]["piVersion"]

FIXED = datetime(2026, 9, 30, 12, 34, 56, 789, tzinfo=timezone.utc)
COMMIT = "0123456789abcdef0123456789abcdef01234567"


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-write-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.parent = self.home / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.sentinel = self.home / "outside"
        self.sentinel.write_text("KEEP", encoding="utf-8")
        self.plan = self.plan_for(self.target)

    def plan_for(self, target):
        overlay = load("config/config.example.json")
        overlay["target"]["agentDir"] = str(target)
        return prepare(load("config/manifest.json"), overlay)

    def check_outside(self):
        self.assertEqual("KEEP", self.sentinel.read_text(encoding="utf-8"))

    def assert_rejected(self, plan=None, target=None, candidate=False, rule=None):
        with self.assertRaises(WriteError) as caught:
            write(self.plan if plan is None else plan, str(self.target) if target is None else target)
        self.assertEqual(candidate, caught.exception.candidate_created)
        if rule is not None:
            self.assertEqual(rule, caught.exception.rule)
        if candidate:
            self.assertTrue(self.target.exists())
        self.check_outside()
        self.assertNotIn("KEEP", str(caught.exception))

    def test_success_exact_inventory_deterministic_and_modes_umask_zero(self):
        old = os.umask(0)
        try:
            result = write(self.plan, str(self.target), clock=lambda: FIXED, kit_commit=COMMIT)
        finally:
            self.assertEqual(0, os.umask(old))
        self.assertTrue(result.complete)
        self.assertEqual(str(self.target), result.target_agent_dir)
        self.assertEqual({"settings.json", ".tenant-pi", ".tenant-pi/choices.json", STATE},
                         {str(p.relative_to(self.target)) for p in self.target.rglob("*")})
        self.assertEqual(0o700, stat.S_IMODE(self.target.stat().st_mode))
        self.assertEqual(0o700, stat.S_IMODE((self.target / ".tenant-pi").stat().st_mode))
        for name in ("settings.json", ".tenant-pi/choices.json", STATE):
            self.assertEqual(0o600, stat.S_IMODE((self.target / name).stat().st_mode))
        for name in ("settings.json", ".tenant-pi/choices.json"):
            payload = self.plan["files"][name]["content"]
            self.assertEqual(payload, json.loads((self.target / name).read_text()))
            self.assertEqual((json.dumps(payload, sort_keys=True, ensure_ascii=True,
                                         allow_nan=False, separators=(",", ":")) + "\n").encode("ascii"),
                             (self.target / name).read_bytes())
        state = json.loads((self.target / STATE).read_text())
        self.assertEqual({"schemaVersion": 1, "status": "complete", "provenance": {
            "kitSchemaVersion": 1, "piVersion": PIN, "nodeRange": ">=22.22.0 <23", "enabled": ["core"],
            "pins": {"core": "npm:@earendil-works/pi-coding-agent@" + PIN},
            "outputs": ["settings.json", ".tenant-pi/choices.json", ".tenant-pi/state.json"],
            "generatedAt": "2026-09-30T12:34:56Z", "kitCommit": COMMIT}}, state)
        # The record carries no private overlay value: no target path, endpoint, role, or credential name.
        self.assertNotIn(str(self.target), (self.target / STATE).read_text())
        self.assert_rejected()

    def test_generation_time_and_kit_commit(self):
        # The default clock and commit: the current UTC second and `unknown`.
        before = datetime.now(timezone.utc).replace(microsecond=0)
        write(self.plan, str(self.target))
        after = datetime.now(timezone.utc)
        record = json.loads((self.target / STATE).read_text())["provenance"]
        self.assertRegex(record["generatedAt"], r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
        moment = datetime.strptime(record["generatedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertTrue(before <= moment <= after)
        self.assertEqual("unknown", record["kitCommit"])
        # Another offset is written as the same instant in UTC; the clock is called once.
        calls = []
        other = self.parent / "other"

        def clock():
            calls.append(1)
            return FIXED.astimezone(timezone(timedelta(hours=-5)))

        write(self.plan_for(other), str(other), clock=clock)
        self.assertEqual("2026-09-30T12:34:56Z", json.loads((other / STATE).read_text())["provenance"]["generatedAt"])
        self.assertEqual(1, len(calls))

    def test_invalid_clock_or_commit_refused_before_any_write(self):
        canary = "CANARY_COMMIT"

        def broken():
            raise RuntimeError(canary)

        for options, rule in (({"clock": lambda: FIXED.replace(tzinfo=None)}, "clock"), ({"clock": lambda: canary}, "clock"),
                              ({"clock": broken}, "clock"),
                              ({"clock": lambda: datetime(10000 - 1, 12, 31, 23, 0, tzinfo=timezone(timedelta(hours=-2)))}, "clock"),
                              ({"kit_commit": canary}, "kit_commit"), ({"kit_commit": COMMIT.upper()}, "kit_commit"),
                              ({"kit_commit": COMMIT[:39]}, "kit_commit"), ({"kit_commit": COMMIT + "\n"}, "kit_commit"),
                              ({"kit_commit": None}, "kit_commit"), ({"kit_commit": "a" * 64}, "kit_commit")):
            with self.subTest(rule=rule, options=sorted(options)):
                with self.assertRaises(WriteError) as caught:
                    write(self.plan, str(self.target), **options)
                self.assertEqual((rule, False), (caught.exception.rule, caught.exception.candidate_created))
                self.assertNotIn(canary, str(caught.exception))
                self.assertFalse(self.target.exists())
        self.check_outside()

    def test_selected_model_and_inert_package_preserved(self):
        overlay = load("config/config.example.json")
        overlay["target"]["agentDir"] = str(self.target)
        for cid in ("model-routing", "codex-accounts"):
            overlay["selection"]["disable"].remove(cid)
            overlay["selection"]["enable"].append(cid)
        overlay["roles"]["interactive"] = {"provider": "example", "model": "org/model:v2", "thinking": "xhigh"}
        plan = prepare(load("config/manifest.json"), overlay)
        write(plan, str(self.target))
        self.assertEqual(plan["files"]["settings.json"]["content"], json.loads((self.target / "settings.json").read_text()))
        self.assertEqual([{"source": str(ROOT / "packages/tenantext"),
                           **load("config/manifest.json")["components"]["codex-accounts"]["resources"]}],
                         json.loads((self.target / "settings.json").read_text())["packages"])
        self.assertEqual(plan["files"][".tenant-pi/choices.json"]["content"],
                         json.loads((self.target / ".tenant-pi/choices.json").read_text()))
        self.check_outside()

    def test_a_skill_component_of_several_skills_writes_each_skill(self):
        target = self.parent / "profile coordinator-skills"
        overlay = load("config/config.example.json")
        overlay["target"]["agentDir"] = str(target)
        overlay["selection"]["disable"].remove("coordinator-skills")
        overlay["selection"]["enable"].append("coordinator-skills")
        plan = prepare(load("config/manifest.json"), overlay)
        self.assertTrue(write(plan, str(target)).complete)
        settings = json.loads((target / "settings.json").read_text())
        # The manifest is the one source of the skill list of the component.
        skills = load("config/manifest.json")["components"]["coordinator-skills"]["resources"]["skills"]
        self.assertGreater(len(skills), 1)
        self.assertEqual([{"source": str(ROOT / "packages/tenantext"), "extensions": [], "skills": skills,
                           "prompts": [], "themes": []}], settings["packages"])
        for skill in skills:
            self.assertTrue(Path(settings["packages"][0]["source"], skill, "SKILL.md").is_file())
        self.assertEqual({"core": "npm:@earendil-works/pi-coding-agent@" + PIN, "coordinator-skills": "tree:packages/tenantext"},
                         json.loads((target / STATE).read_text())["provenance"]["pins"])

    def test_one_tree_component_is_written_once_with_its_own_filter(self):
        for cid, key, item in (("slopscore", "extensions", "extensions/slopscore/index.ts"),
                               ("slopscore-pr", "skills", "skills/slopscore-pr")):
            with self.subTest(cid=cid):
                target = self.parent / ("profile " + cid)
                overlay = load("config/config.example.json")
                overlay["target"]["agentDir"] = str(target)
                overlay["selection"]["disable"].remove(cid)
                overlay["selection"]["enable"].append(cid)
                plan = prepare(load("config/manifest.json"), overlay)
                self.assertTrue(write(plan, str(target)).complete)
                settings = json.loads((target / "settings.json").read_text())
                expected = {"source": str(ROOT / "packages/tenantext"), "extensions": [], "skills": [], "prompts": [], "themes": []}
                expected[key] = [item]
                self.assertEqual([expected], settings["packages"])
                self.assertTrue(Path(settings["packages"][0]["source"], item).exists())
                state = json.loads((target / STATE).read_text())
                # The provenance record holds the kit-relative pin, never the host path of the kit.
                self.assertEqual({"core": "npm:@earendil-works/pi-coding-agent@" + PIN, cid: "tree:packages/tenantext"},
                                 state["provenance"]["pins"])
                self.assertNotIn(str(ROOT), (target / STATE).read_text())
                for change in (lambda p: p["files"]["settings.json"]["content"]["packages"][0][key].append("skills/herdr"),
                               lambda p: p["files"]["settings.json"]["content"]["packages"][0].update(source="/tmp/other"),
                               lambda p: p["files"]["settings.json"]["content"]["packages"].append(
                                   copy.deepcopy(p["files"]["settings.json"]["content"]["packages"][0]))):
                    overlay["target"]["agentDir"] = str(self.target)
                    altered = prepare(load("config/manifest.json"), overlay)
                    change(altered)
                    self.assert_rejected(plan=altered)
                    self.assertFalse(self.target.exists())
        self.check_outside()

    def test_route_generation_and_pre_mutation_tamper(self):
        overlay = load("config/config.example.json")
        overlay["target"]["agentDir"] = str(self.target)
        overlay["selection"] = {"enable": ["core", "model-routing", "codex-accounts"], "disable": []}
        overlay["roles"] = {"interactive": copy.deepcopy(GATEWAY)}
        overlay["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(GATEWAY)], "gateway": {"auth": "env"}}
        overlay["endpoints"] = {"codex-accounts": "https://gateway.example.invalid/v1"}
        overlay["env"] = {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
        plan = prepare(load("config/manifest.json"), overlay, registry=REGISTRY, required_roles=("worker",))
        changes = (
            lambda p: p["files"]["settings.json"]["content"].update(defaultModel="codex-auto/astra"),
            lambda p: p["files"]["settings.json"]["content"].update(enabledModels=[]),
            lambda p: p["files"]["settings.json"]["content"]["modelThinkingLevels"].update({"litellm-codex/codex-auto/sol": "off"}),
            lambda p: p["files"]["settings.json"]["content"]["packages"][0].update(source="git:other@pin"),
            lambda p: p["files"]["settings.json"]["content"]["packages"][0]["extensions"].append("extensions/*"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["routes"]["setup"].clear(),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["registry"]["litellm-codex"]["codex-auto/sol"].append("max"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["roleStatus"].update(worker="selected"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["requiredRoles"].clear(),
            lambda p: p["commands"].update(launch="echo KEEP"),
            lambda p: p["readinessGaps"].clear(),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["manifest"]["components"]["codex-accounts"]["resources"]["skills"].append("*")
        )
        for change in changes:
            with self.subTest(change=changes.index(change)):
                altered = copy.deepcopy(plan)
                change(altered)
                self.assert_rejected(plan=altered)
                self.assertFalse(self.target.exists())
        result = write(plan, str(self.target))
        self.assertTrue(result.complete)
        self.assertEqual(["litellm-codex/codex-auto/sol"], json.loads((self.target / "settings.json").read_text())["enabledModels"])
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_omitted_optional_components_prepare_to_write(self):
        overlay = load("config/config.example.json")
        overlay["target"]["agentDir"] = str(self.target)
        overlay["selection"] = {"enable": ["core"], "disable": []}
        plan = prepare(load("config/manifest.json"), overlay)
        result = write(plan, str(self.target))
        self.assertTrue(result.complete)
        self.assertEqual(plan["files"][".tenant-pi/choices.json"]["content"],
                         json.loads((self.target / ".tenant-pi/choices.json").read_text()))
        state = json.loads((self.target / STATE).read_text())
        self.assertEqual(("complete", ["core"]), (state["status"], state["provenance"]["enabled"]))
        self.check_outside()

    def test_existing_targets_no_adoption(self):
        for kind in ("empty_dir", "file", "link", "dangling", "fifo"):
            with self.subTest(kind=kind):
                if kind == "empty_dir":
                    self.target.mkdir()
                elif kind == "file":
                    self.target.write_text("KEEP")
                elif kind in ("link", "dangling"):
                    self.target.symlink_to(self.sentinel if kind == "link" else self.home / "missing")
                else:
                    os.mkfifo(self.target)
                before = os.lstat(self.target)
                with self.assertRaises(WriteError) as caught:
                    write(self.plan, str(self.target))
                self.assertFalse(caught.exception.candidate_created)
                self.assertEqual(before.st_ino, os.lstat(self.target).st_ino)
                self.check_outside()
                self.target.unlink() if kind != "empty_dir" else self.target.rmdir()

    def test_unsafe_ancestors_and_parent(self):
        symlink = self.home / "linked"
        symlink.symlink_to(self.parent, target_is_directory=True)
        node = self.home / "pipe"
        os.mkfifo(node)
        unsafe = self.home / "writable"
        unsafe.mkdir(mode=0o777)
        unsafe.chmod(0o777)
        missing = self.home / "absent" / "new profile"
        for target, rule in ((symlink / "new profile", "unsafe_path"),
                             (node / "new profile", "unsafe_path"),
                             (unsafe / "new profile", "unsafe_permissions"),
                             (missing, "unsafe_path")):
            with self.subTest(rule=rule, target=target):
                self.assert_rejected(plan=self.plan_for(target), target=str(target), rule=rule)
                self.assertFalse(os.path.lexists(target))
        sticky = self.home / "sticky"
        sticky.mkdir(mode=0o700)
        sticky.chmod(0o1777)
        # A sticky ancestor is safe, but the immediate parent must belong to the caller.
        sticky_parent = sticky / "owned"
        sticky_parent.mkdir(mode=0o700)
        self.assertTrue(write(self.plan_for(sticky_parent / "new"), str(sticky_parent / "new")).complete)
        self.check_outside()

    def test_target_mismatch_precedes_filesystem_checks(self):
        target = self.home / "absent" / "new profile"
        self.assert_rejected(target=str(target), rule="invalid_plan")
        self.assertFalse(os.path.lexists(target))

    def test_schema_path_content_and_command_tampering_fail_without_mutation(self):
        changes = (
            lambda p: p.update(extra="KEEP"),
            lambda p: p["files"].update({"../outside": p["files"]["settings.json"]}),
            lambda p: p["files"].update({"/tmp/outside": p["files"]["settings.json"]}),
            lambda p: p["files"]["settings.json"].update(mode="0644"),
            lambda p: p["files"]["settings.json"].update(content={"packages": ["extension"]}),
            lambda p: p["files"]["settings.json"]["content"].update(enableAnalytics=True),
            lambda p: p["files"]["settings.json"]["content"].update(extra="KEEP"),
            lambda p: p["files"]["settings.json"]["content"].update(float_value=float("nan")),
            lambda p: p["files"]["settings.json"]["content"].update(float_value=float("inf")),
            lambda p: p["files"]["settings.json"]["content"].update(x=b"KEEP"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"].update(extra="KEEP"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["overlay"]["target"].update(agentDir="/tmp/outside"),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["overlay"]["consent"].update(telemetry=True),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["overlay"]["roles"].update(review={"provider": "KEEP", "model": "$(KEEP)", "thinking": "low"}),
            lambda p: p["files"][".tenant-pi/choices.json"]["content"]["overlay"]["selection"]["enable"].append("promptr"),
            lambda p: p["commands"].update(launch="echo KEEP"),
            lambda p: p["commands"].update(setup=["sh -c KEEP"]),
            lambda p: p["readinessGaps"].append({"code": "other", "subject": "KEEP"}),
        )
        for change in changes:
            with self.subTest(change=changes.index(change)):
                plan = copy.deepcopy(self.plan)
                change(plan)
                self.assert_rejected(plan=plan)
        self.assertFalse(self.target.exists())
        for name in (str(self.target / "../outside"), str(self.parent) + "/./new profile",
                     str(self.home / "absent" / "new")):
            self.assert_rejected(target=name)

    def test_non_json_cycle_rejected_and_no_private_values_in_errors(self):
        plan = copy.deepcopy(self.plan)
        plan["files"]["settings.json"]["content"]["cycle"] = plan
        self.assert_rejected(plan=plan)
        self.assertFalse(self.target.exists())

    def test_failure_before_first_mutation_and_during_write(self):
        with patch("scripts.profile_write.os.mkdir", side_effect=OSError("KEEP")):
            self.assert_rejected()
        self.assertFalse(self.target.exists())
        from scripts import profile_write
        actual = profile_write._create_file

        def interrupt(fd, name, data):
            if name == "choices.json":
                raise OSError("KEEP")
            return actual(fd, name, data)

        with patch("scripts.profile_write._create_file", side_effect=interrupt):
            self.assert_rejected(candidate=True)
        self.assertEqual("incomplete", json.loads((self.target / STATE).read_text())["status"])
        self.assertTrue((self.target / "settings.json").exists())
        self.assertFalse((self.target / ".tenant-pi/choices.json").exists())

    def test_close_after_completion_reports_warning_not_incomplete(self):
        from scripts import profile_write
        for close_index in (0, 1, 2):
            with self.subTest(close_index=close_index):
                original_close = os.close
                original_replace = os.replace
                published = [False]
                closes = [0]

                def replace(*args, **kwargs):
                    original_replace(*args, **kwargs)
                    published[0] = True

                def close(fd):
                    original_close(fd)
                    if published[0]:
                        index = closes[0]
                        closes[0] += 1
                        if index == close_index:
                            raise OSError("CANARY_SECRET")

                with patch.object(profile_write.os, "replace", side_effect=replace), \
                     patch.object(profile_write.os, "close", side_effect=close):
                    result = write(self.plan, str(self.target))
                self.assertTrue(result.complete)
                self.assertEqual(("cleanup_failed: target.descriptors",), result.warnings)
                self.assertEqual(3, closes[0])
                self.assertEqual("complete", json.loads((self.target / STATE).read_text())["status"])
                self.check_outside()
                # Only the disposable fixture is removed between subtests.
                import shutil
                shutil.rmtree(self.target)

    def test_prepublication_close_failure_preserves_primary_error(self):
        from scripts import profile_write
        original_close = os.close
        attempted = [False]
        raised = [False]

        def replace(*args, **kwargs):
            attempted[0] = True
            raise OSError("PRIMARY_CANARY")

        def close(fd):
            original_close(fd)
            if attempted[0] and not raised[0]:
                raised[0] = True
                raise OSError("CLEANUP_CANARY")

        with patch.object(profile_write.os, "replace", side_effect=replace), \
             patch.object(profile_write.os, "close", side_effect=close):
            self.assert_rejected(candidate=True, rule="write_failed")
        self.assertTrue(raised[0])
        self.assertEqual("incomplete", json.loads((self.target / STATE).read_text())["status"])
        self.check_outside()

    def test_failure_before_completion_preserves_incomplete(self):
        with patch("scripts.profile_write.os.replace", side_effect=OSError("KEEP")):
            self.assert_rejected(candidate=True)
        self.assertEqual("incomplete", json.loads((self.target / STATE).read_text())["status"])
        self.assertEqual({"settings.json", ".tenant-pi", ".tenant-pi/state.json",
                          ".tenant-pi/state.next", ".tenant-pi/choices.json"},
                         {str(p.relative_to(self.target)) for p in self.target.rglob("*")})

    def test_metadata_replacement_before_publication_detected(self):
        from scripts import profile_write
        actual = profile_write._create_file
        moved = self.home / "moved-metadata"

        def replace_meta(fd, name, data):
            actual(fd, name, data)
            if name == "state.next":
                (self.target / ".tenant-pi").rename(moved)
                (self.target / ".tenant-pi").symlink_to(self.home, target_is_directory=True)

        with patch("scripts.profile_write._create_file", side_effect=replace_meta):
            with self.assertRaises(WriteError) as caught:
                write(self.plan, str(self.target))
        self.assertTrue(caught.exception.candidate_created)
        self.assertEqual("incomplete", json.loads((moved / "state.json").read_text())["status"])
        self.check_outside()

    def test_replacement_before_publication_detected(self):
        from scripts import profile_write
        actual = profile_write._create_file
        moved = self.parent / "moved"

        def replace_target(fd, name, data):
            actual(fd, name, data)
            if name == "state.next":
                self.target.rename(moved)
                self.target.symlink_to(self.sentinel)

        with patch("scripts.profile_write._create_file", side_effect=replace_target):
            with self.assertRaises(WriteError) as caught:
                write(self.plan, str(self.target))
        self.assertTrue(caught.exception.candidate_created)
        self.assertEqual("incomplete", json.loads((moved / STATE).read_text())["status"])
        self.assertTrue(self.target.is_symlink())
        self.check_outside()


if __name__ == "__main__":
    unittest.main()
