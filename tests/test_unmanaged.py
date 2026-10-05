"""Accepted drift (`overlay.unmanaged`): synthetic pointers and reasons only; no pointer is resolved."""
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
from scripts.validate import REASON_MAX, ROOT, UNMANAGED_MAX, Invalid, load, manifest, overlay
from tests.test_candidate_compare import candidate, fields, overlay_for

CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
REASON = "Reviewed; kept on purpose."
NPM = {"key": "/npmCommand", "reason": REASON}
ITEM = "overlay.unmanaged.item"


def dump(report):
    """The exact bytes the CLI prints for a report."""
    return json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")


class UnmanagedRuleTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")
        self.components = manifest(copy.deepcopy(self.manifest))
        self.overlay = load(ROOT / "config/config.example.json")
        self.overlay["target"]["agentDir"] = "/home/example/profiles/new"

    def error(self, items, rule, field):
        self.overlay["unmanaged"] = items
        with self.assertRaises(Invalid) as caught:
            overlay(self.overlay, self.components)
        # A static diagnostic: the rule and the field path, never the input value.
        self.assertEqual(rule + ": " + field, str(caught.exception))
        self.assertNotIn(CANARY, str(caught.exception))
        with self.assertRaises(Invalid) as planned:
            prepare(self.manifest, self.overlay)
        self.assertEqual(str(caught.exception), str(planned.exception))

    def accept(self, items):
        self.overlay["unmanaged"] = items
        overlay(self.overlay, self.components)

    def test_key_is_optional_and_examples_do_not_use_it(self):
        overlay(self.overlay, self.components)
        self.assertNotIn("unmanaged", self.overlay)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/examples.py")], cwd=ROOT, text=True,
                                capture_output=True, check=False, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual((0, "examples valid\n"), (result.returncode, result.stdout))
        self.assertNotIn("unmanaged", (ROOT / "config/config.example.json").read_text(encoding="utf-8"))
        without = prepare(self.manifest, self.overlay)
        self.accept([])
        # An empty list changes nothing except its own record.
        self.assertEqual(without["files"]["settings.json"], prepare(self.manifest, self.overlay)["files"]["settings.json"])

    def test_shape_errors(self):
        self.error("/npmCommand", "array", "overlay.unmanaged")
        self.error({"/npmCommand": REASON}, "array", "overlay.unmanaged")
        self.error(None, "array", "overlay.unmanaged")
        for item in ("/npmCommand", 7, None, ["/npmCommand", REASON]):
            self.error([item], "object", ITEM)
        self.error([{"key": "/npmCommand"}], "required_fields", ITEM)
        self.error([{"reason": REASON}], "required_fields", ITEM)
        self.error([{**NPM, "file": "settings.json"}], "unknown_fields", ITEM)
        self.error([{**NPM, CANARY: 1}], "unknown_fields", ITEM)

    def test_pointer_accepts_the_documented_grammar(self):
        for key in ("/npmCommand", "/a", "/packages/0/source", "/llm-wiki/taskModel", "/A_b.c:d@e-f/0", "/-a", "/a/-",
                    "/" + "a" * 300):
            with self.subTest(key=key[:40]):
                self.accept([{"key": key, "reason": REASON}])

    def test_pointer_rejects_every_other_form(self):
        for key in ("", "/", "npmCommand", "a/b", "//a", "/a//b", "/a/", "/a b", "/a/*", "/*", "/a?", "/a~1b", "/a~0b",
                    "/a\n", "/a\n" + CANARY, "\n/a", "/a\x00", "/<redacted>", "/a#b", "/a$" + CANARY, "/é", "/a\\b",
                    "/a,b", "/a[0]", " /a", "/a ", "settings.json:/a", 7, None, True, ["/a"], {"/a": 1}):
            with self.subTest(key=repr(key)):
                self.error([{"key": key, "reason": REASON}], "pointer", ITEM + ".key")

    def test_reason_accepts_bounded_text(self):
        for reason in ("x", " x ", "a" * REASON_MAX, "é" * REASON_MAX, "User: $HOME `x` {{y}} - ! + ☃ \U0001f600",
                       "-leading hyphen", "!leading mark"):
            with self.subTest(reason=reason[:20]):
                self.accept([{"key": "/npmCommand", "reason": reason}])
        self.assertEqual(200, REASON_MAX)

    def test_reason_must_be_non_empty_text(self):
        for reason in ("", " ", "   ", "\u00a0", "\u2003 ", None, 7, True, [REASON], {"text": CANARY}):
            with self.subTest(reason=repr(reason)):
                self.error([{"key": "/npmCommand", "reason": reason}], "reason_required", ITEM + ".reason")

    def test_reason_is_at_most_200_characters(self):
        self.error([{"key": "/npmCommand", "reason": "a" * (REASON_MAX + 1)}], "reason_length", ITEM + ".reason")
        self.error([{"key": "/npmCommand", "reason": CANARY * 100}], "reason_length", ITEM + ".reason")

    def test_reason_has_no_control_character(self):
        for char in ("\n", "\r", "\t", "\x00", "\x1b", "\x1f", "\x7f", "\x80", "\x85", "\x9f"):
            with self.subTest(char=repr(char)):
                self.error([{"key": "/npmCommand", "reason": "a" + char + CANARY}], "reason_control_character", ITEM + ".reason")

    def test_duplicate_pointer(self):
        self.error([NPM, {"key": "/npmCommand", "reason": "other"}], "duplicate_pointer", ITEM + ".key")
        self.error([NPM, {"key": "/deviceId", "reason": REASON}, dict(NPM)], "duplicate_pointer", ITEM + ".key")
        # Exact strings: a different pointer with the same reason is no duplicate, and no prefix is compared.
        self.accept([NPM, {"key": "/npmCommand/0", "reason": REASON}, {"key": "/npmcommand", "reason": REASON}])

    def test_list_holds_at_most_200_items(self):
        items = [{"key": "/k" + str(index), "reason": REASON} for index in range(UNMANAGED_MAX + 1)]
        self.assertEqual(200, UNMANAGED_MAX)
        self.accept(items[:UNMANAGED_MAX])
        self.error(items, "unmanaged_count", "overlay.unmanaged")
        # The count is checked first: an oversized list of invalid items gives the same static rule.
        self.error([CANARY] * (UNMANAGED_MAX + 1), "unmanaged_count", "overlay.unmanaged")

    def test_plan_records_the_list_and_writes_nothing_else(self):
        without = prepare(self.manifest, self.overlay)
        items = [{"key": "/deviceId", "reason": "b"}, dict(NPM)]
        self.overlay["unmanaged"] = items
        plan = prepare(self.manifest, self.overlay)
        choices = plan["files"][".tenant-pi/choices.json"]["content"]
        self.assertEqual(items, choices["overlay"]["unmanaged"])  # Overlay order is kept.
        self.assertIsNot(items, choices["overlay"]["unmanaged"])
        # No accepted key is rendered: settings, gaps and commands equal the plan without the list.
        for part in ("readinessGaps", "commands"):
            self.assertEqual(without[part], plan[part])
        self.assertEqual(without["files"]["settings.json"], plan["files"]["settings.json"])
        self.assertEqual(sorted(without["files"]), sorted(plan["files"]))
        self.assertEqual(json.dumps(plan, sort_keys=True), json.dumps(prepare(self.manifest, self.overlay), sort_keys=True))

    def test_guarded_writer_rejects_a_changed_record_before_a_write(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-unmanaged-write-") as temp:
            parent = Path(temp).resolve() / "owned parent"
            parent.mkdir(mode=0o700)
            target = parent / "new profile"
            self.overlay["target"]["agentDir"] = str(target)
            self.overlay["unmanaged"] = [dict(NPM)]
            plan = prepare(self.manifest, self.overlay)
            changed = copy.deepcopy(plan)
            changed["files"]["settings.json"]["content"]["npmCommand"] = [CANARY]
            with self.assertRaises(WriteError) as caught:
                write(changed, str(target))
            self.assertEqual("invalid_plan: plan_mismatch: plan", str(caught.exception))
            invalid = copy.deepcopy(plan)
            invalid["files"][".tenant-pi/choices.json"]["content"]["overlay"]["unmanaged"][0]["key"] = "/*"
            with self.assertRaises(WriteError) as caught:
                write(invalid, str(target))
            self.assertEqual("invalid_plan: pointer: overlay.unmanaged.item.key", str(caught.exception))
            self.assertFalse(target.exists())
            self.assertTrue(write(plan, str(target)).complete)
            written = json.loads((target / ".tenant-pi/choices.json").read_text(encoding="utf-8"))
            self.assertEqual([NPM], written["overlay"]["unmanaged"])
            self.assertNotIn("npmCommand", json.loads((target / "settings.json").read_text(encoding="utf-8")))


class UnmanagedCompareTests(unittest.TestCase):
    def setUp(self):
        self.old = candidate(overlay_for("/home/example/old"))

    def edited(self, items, target="/home/example/new"):
        new = candidate(overlay_for(target, unmanaged=items))
        new["settings.json"]["npmCommand"] = ["/private/" + CANARY, "--", "npm"]
        new["settings.json"]["deviceId"] = CANARY
        return new

    def test_one_accepted_and_one_unaccepted_difference(self):
        report = compare(self.old, self.edited([dict(NPM)]))
        self.assertEqual([{"file": "settings.json", "field": "/npmCommand", "side": "right", "status": "unsupported_field",
                           "reason": REASON}], report["accepted"])
        self.assertEqual([{"file": "settings.json", "field": "/deviceId", "side": "right", "status": "unsupported_field"}],
                         report["unsupported"])
        self.assertEqual((1, 1), (report["summary"]["accepted"], report["summary"]["unsupported"]))
        self.assertNotIn(("settings.json", "/npmCommand"), fields(report))
        self.assertIn((".tenant-pi/choices.json", "/overlay/unmanaged/0"), fields(report, "added"))
        self.assertNotIn(CANARY, json.dumps(report))
        # Without the list the same difference is unsupported and nothing is accepted.
        plain = compare(self.old, self.edited([]))
        self.assertEqual(["/deviceId", "/npmCommand"], [u["field"] for u in plain["unsupported"]])
        self.assertEqual(([], 0), (plain["accepted"], plain["summary"]["accepted"]))

    def test_report_is_byte_equal_on_unchanged_inputs(self):
        items = [{"key": "/defaultProjectTrust", "reason": "b ☃"}, dict(NPM)]
        first = dump(compare(copy.deepcopy(self.old), self.edited(items)))
        second = dump(compare(copy.deepcopy(self.old), self.edited(copy.deepcopy(items))))
        self.assertEqual(first, second)
        # The order of the overlay list does not change the `accepted` list.
        swapped = json.loads(dump(compare(self.old, self.edited(items[::-1]))))
        self.assertEqual(json.loads(first)["accepted"], swapped["accepted"])

    def test_accepted_change_is_a_marker_and_leaves_changes_and_summary(self):
        items = [{"key": "/defaultProjectTrust", "reason": "trust"}, {"key": "/enableAnalytics", "reason": "added"},
                 {"key": "/defaultModel", "reason": "removed"}, {"key": "/enableInstallTelemetry", "reason": "equal"}]
        new = candidate(overlay_for("/home/example/new", unmanaged=items))
        new["settings.json"]["defaultProjectTrust"] = "always"
        left = copy.deepcopy(self.old)
        del left["settings.json"]["enableAnalytics"]
        left["settings.json"]["defaultModel"] = CANARY
        report = compare(left, new)
        self.assertEqual([{"file": "settings.json", "field": "/defaultModel", "change": "removed", "reason": "removed"},
                          {"file": "settings.json", "field": "/defaultProjectTrust", "change": "changed", "reason": "trust"},
                          {"file": "settings.json", "field": "/enableAnalytics", "change": "added", "reason": "added"}],
                         report["accepted"])
        self.assertEqual([], [f for f in fields(report) if f[0] == "settings.json"])
        # A public value is not echoed for an accepted field, and an equal field stays `unchanged`.
        self.assertNotIn("always", json.dumps(report))
        self.assertIn({"file": "settings.json", "field": "/enableInstallTelemetry"}, report["unchanged"])
        self.assertEqual(3, report["summary"]["accepted"])
        self.assertEqual(len(report["changes"]), sum(report["summary"][k] for k in ("added", "removed", "changed")))
        self.assertNotIn(CANARY, json.dumps(report))

    def test_pointer_is_an_exact_field_path_of_settings_only(self):
        items = [{"key": "/packages", "reason": "no prefix"}, {"key": "/overlay/target/agentDir", "reason": "other file"},
                 {"key": "/status", "reason": "other file"}, {"key": "/npmcommand", "reason": "case"}]
        new = self.edited(items)
        new["settings.json"]["packages"] = ["/home/example/" + CANARY]
        new[".tenant-pi/state.json"]["status"] = "incomplete"
        report = compare(self.old, new)
        self.assertEqual([], report["accepted"])
        self.assertIn((".tenant-pi/state.json", "/status"), fields(report, "changed"))
        self.assertIn(("settings.json", "/packages/0/source"), fields(report, "added"))
        self.assertIn((".tenant-pi/choices.json", "/overlay/target/agentDir"), fields(report, "changed"))
        self.assertEqual(["/deviceId", "/npmCommand"], [u["field"] for u in report["unsupported"]])
        # The exact path of a list entry and of a wrong shape is accepted.
        new = self.edited([{"key": "/packages/0/source", "reason": "entry"}])
        new["settings.json"]["packages"] = ["/home/example/" + CANARY]
        self.assertEqual([{"file": "settings.json", "field": "/packages/0/source", "change": "added", "reason": "entry"}],
                         compare(self.old, new)["accepted"])
        new = self.edited([{"key": "/packages", "reason": "shape"}])
        new["settings.json"]["packages"] = CANARY
        report = compare(self.old, new)
        self.assertEqual([{"file": "settings.json", "field": "/packages", "side": "right", "status": "unsupported_shape",
                           "reason": "shape"}], report["accepted"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_either_side_accepts_and_the_right_reason_wins(self):
        listed = self.edited([dict(NPM)], target="/home/example/old")
        plain = self.edited([])
        report = compare(listed, plain)
        # Both sides carry the key: one entry per side, each with the reason of the left record.
        self.assertEqual([("left", REASON), ("right", REASON)], [(a["side"], a["reason"]) for a in report["accepted"]])
        self.assertEqual(["/deviceId", "/deviceId"], [u["field"] for u in report["unsupported"]])
        both = compare(listed, self.edited([{"key": "/npmCommand", "reason": "newer"}]))
        self.assertEqual(["newer", "newer"], [a["reason"] for a in both["accepted"]])
        # A record on the left side only also accepts a changed field, without a value.
        trusting = candidate(overlay_for("/home/example/old", unmanaged=[{"key": "/defaultProjectTrust", "reason": "left"}]))
        right = candidate(overlay_for("/home/example/new"))
        right["settings.json"]["defaultProjectTrust"] = "always"
        report = compare(trusting, right)
        self.assertEqual([{"file": "settings.json", "field": "/defaultProjectTrust", "change": "changed", "reason": "left"}],
                         report["accepted"])
        self.assertNotIn(("settings.json", "/defaultProjectTrust"), fields(report))
        self.assertNotIn("always", json.dumps(report))
        # A side without metadata (a live profile) is covered by the other side's record.
        live = {"settings.json": copy.deepcopy(plain["settings.json"]), ".tenant-pi/choices.json": None, ".tenant-pi/state.json": None}
        report = compare(live, listed)
        self.assertEqual("settings_only", report["left"]["kind"])
        self.assertEqual(["left", "right"], [a["side"] for a in report["accepted"]])

    def test_redacted_key_name_cannot_be_accepted(self):
        new = self.edited([{"key": "/redacted", "reason": REASON}])
        new["settings.json"]["bad key\n" + CANARY] = CANARY
        report = compare(self.old, new)
        self.assertEqual([], report["accepted"])
        self.assertIn({"file": "settings.json", "field": "/<redacted>", "side": "right", "status": "unsupported_field_name"},
                      report["unsupported"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_hand_edited_record_accepts_nothing_and_echoes_nothing(self):
        for value in (CANARY, {"key": "/npmCommand", "reason": REASON}, [{"key": "/npmCommand"}], [CANARY],
                      [{"key": "/npmCommand", "reason": "a\n" + CANARY}], [{"key": "/npmCommand", "reason": CANARY * 100}],
                      [{"key": "/*", "reason": CANARY}], [{"key": "/npmCommand", "reason": ""}],
                      [dict(NPM), {"key": "/npmCommand", "reason": CANARY}], [{**NPM, CANARY: CANARY}],
                      [{"key": "/npmCommand", "reason": " "}],
                      [dict(NPM)] + [{"key": "/k" + str(i), "reason": CANARY} for i in range(UNMANAGED_MAX)]):
            with self.subTest(value=repr(value)[:60]):
                new = self.edited([dict(NPM)])
                new[".tenant-pi/choices.json"]["overlay"]["unmanaged"] = value
                report = compare(self.old, new)
                self.assertEqual([], report["accepted"])
                self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/unmanaged", "side": "right",
                               "status": "unsupported_shape"}, report["unsupported"])
                self.assertIn("/npmCommand", [u["field"] for u in report["unsupported"]])
                self.assertNotIn("/overlay/unmanaged/0", json.dumps(report))
                self.assertNotIn(CANARY, json.dumps(report))

    def test_list_change_is_a_marker_and_drift_is_not_filtered(self):
        first = self.edited([dict(NPM)], target="/home/example/old")
        second = self.edited([{"key": "/npmCommand", "reason": "other " + CANARY}])
        report = compare(first, second)
        entry = next(c for c in report["changes"] if c["field"] == "/overlay/unmanaged/0")
        self.assertEqual({"file": ".tenant-pi/choices.json", "field": "/overlay/unmanaged/0", "change": "changed"}, entry)
        # Drift still names the hand edit; the accepted list does not hide it there.
        self.assertEqual({"status": "owner_edits", "fields": ["/deviceId", "/npmCommand"], "metadata": "unchanged"},
                         report["left"]["drift"])


class UnmanagedCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-unmanaged-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.file = self.base / "overlay.json"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        # The three actions read `HOME` to find `~/.pi/agent`: the disposable directory, never the real one.
        self.env = dict(os.environ, HOME=str(self.base), PYTHONDONTWRITEBYTECODE="1")

    def run_cli(self, action, *extra):
        self.file.write_text(json.dumps(self.data), encoding="utf-8")
        return subprocess.run([sys.executable, str(CLI), action, "--overlay", str(self.file), *extra],
                              cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def compare_cli(self, left, right):
        return subprocess.run([sys.executable, str(CLI), "compare", "--left", str(left), "--right", str(right)],
                              cwd=self.base, env=self.env, capture_output=True, check=False)

    def test_plan_echoes_generate_records_and_compare_accepts(self):
        items = [dict(NPM), {"key": "/llm-wiki/taskModel", "reason": "café ☃"}]
        self.data["unmanaged"] = items
        result = self.run_cli("validate")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual(items, json.loads(result.stdout)["unmanaged"])
        self.assertTrue(result.stdout.isascii())
        self.assertEqual(result.stdout, self.run_cli("plan").stdout)
        self.assertFalse(self.target.exists())
        result = self.run_cli("generate", "--target", str(self.target))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual(items, json.loads(result.stdout)["unmanaged"])
        choices = json.loads((self.target / ".tenant-pi/choices.json").read_text(encoding="utf-8"))
        self.assertEqual(items, choices["overlay"]["unmanaged"])
        self.assertNotIn("npmCommand", json.loads((self.target / "settings.json").read_text(encoding="utf-8")))
        # A settings-only directory stands for the live profile: one accepted and one unaccepted key.
        live = self.parent / "live profile"
        live.mkdir(mode=0o700)
        settings = json.loads((self.target / "settings.json").read_text(encoding="utf-8"))
        settings.update(npmCommand=["/private/" + CANARY], deviceId=CANARY)
        (live / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
        before = sorted(str(p) for p in self.parent.rglob("*"))
        first = self.compare_cli(live, self.target)
        self.assertEqual((0, b""), (first.returncode, first.stderr))
        report = json.loads(first.stdout)
        self.assertEqual([{"file": "settings.json", "field": "/npmCommand", "side": "left", "status": "unsupported_field",
                           "reason": REASON}], report["accepted"])
        self.assertEqual([{"file": "settings.json", "field": "/deviceId", "side": "left", "status": "unsupported_field"}],
                         report["unsupported"])
        self.assertEqual(1, report["summary"]["accepted"])
        self.assertNotIn(CANARY.encode(), first.stdout)
        # Deterministic: a second run prints the same bytes, and no file is written.
        self.assertEqual(first.stdout, self.compare_cli(live, self.target).stdout)
        self.assertEqual(before, sorted(str(p) for p in self.parent.rglob("*")))

    def test_plan_without_the_key_echoes_an_empty_list(self):
        result = self.run_cli("plan")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual([], json.loads(result.stdout)["unmanaged"])

    def test_each_rule_fails_with_a_static_diagnostic_and_no_target(self):
        cases = (({"/a": CANARY}, "array: overlay.unmanaged"),
                 ([{"key": "/a"}], "required_fields: overlay.unmanaged.item"),
                 ([{"key": "/" + CANARY + "/*", "reason": REASON}], "pointer: overlay.unmanaged.item.key"),
                 ([{"key": "/a", "reason": ""}], "reason_required: overlay.unmanaged.item.reason"),
                 ([{"key": "/a", "reason": " \u00a0"}], "reason_required: overlay.unmanaged.item.reason"),
                 ([{"key": "/" + CANARY + str(i), "reason": "a"} for i in range(201)], "unmanaged_count: overlay.unmanaged"),
                 ([{"key": "/a", "reason": CANARY * 100}], "reason_length: overlay.unmanaged.item.reason"),
                 ([{"key": "/a", "reason": CANARY + "\x1b[2J"}], "reason_control_character: overlay.unmanaged.item.reason"),
                 ([{"key": "/" + CANARY, "reason": "a"}, {"key": "/" + CANARY, "reason": "b"}],
                  "duplicate_pointer: overlay.unmanaged.item.key"))
        for items, diagnostic in cases:
            self.data["unmanaged"] = items
            for action, extra in (("validate", ()), ("plan", ()), ("generate", ("--target", str(self.target)))):
                with self.subTest(diagnostic=diagnostic, action=action):
                    result = self.run_cli(action, *extra)
                    self.assertEqual((2, ""), (result.returncode, result.stdout))
                    self.assertEqual({"error": diagnostic, "candidate_created": False}, json.loads(result.stderr))
                    self.assertNotIn(CANARY, result.stderr)
                    self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
