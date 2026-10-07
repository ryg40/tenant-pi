"""`carry`: overlay patches from a compare report. Synthetic candidates only; nothing is applied by the kit."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.candidate_compare import compare
from scripts.carry import CHOICES, OWNED, carry
from scripts.profile_plan import prepare
from scripts.validate import ROOT, Invalid, load
from tests.test_candidate_compare import candidate, overlay_for
from tests.test_model_routes import NATIVE, REGISTRY

CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "sk-live-CANARY_SECRET_0123456789"
TARGET = "/home/example/profiles/carry"
RIGHT = "/home/example/profiles/right"
PACKAGE = "/home/example/git/owner-skills"


def apply_patches(document, patches):
    """A small RFC 6902 applier (`add`, `replace`, `remove`), independent of the module."""
    result = copy.deepcopy(document)
    for patch in patches:
        assert set(patch) == ({"op", "path"} if patch["op"] == "remove" else {"op", "path", "value"}), patch
        parts = [p.replace("~1", "/").replace("~0", "~") for p in patch["path"].split("/")[1:]]
        parent = result
        for part in parts[:-1]:
            parent = parent[int(part)] if type(parent) is list else parent[part]
        last = parts[-1]
        if type(parent) is list:
            index = len(parent) if last == "-" else int(last)
            if patch["op"] == "add":
                parent.insert(index, copy.deepcopy(patch["value"]))
            elif patch["op"] == "replace":
                parent[index] = copy.deepcopy(patch["value"])
            else:
                del parent[index]
        elif patch["op"] == "add":
            parent[last] = copy.deepcopy(patch["value"])
        elif patch["op"] == "replace":
            assert last in parent, patch["path"]
            parent[last] = copy.deepcopy(patch["value"])
        else:
            assert last in parent, patch["path"]
            del parent[last]
    return result


def rendered(plan):
    """The bytes the guarded writer publishes for each planned file."""
    return {name: json.dumps(item["content"], sort_keys=True, ensure_ascii=True, allow_nan=False,
                             separators=(",", ":")).encode("ascii") for name, item in plan["files"].items()}


def file_bytes(files):
    # `prepare` does not render `state.json`: the guarded writer adds it with the publication status
    # and the provenance record. The round trips therefore prove `settings.json`, `choices.json` and the
    # module files; `state.json` depends only on the choices and the published names.
    return {name: json.dumps(content, sort_keys=True, ensure_ascii=True, allow_nan=False,
                             separators=(",", ":")).encode("ascii")
            for name, content in files.items() if name != ".tenant-pi/state.json"}


def routed(target=TARGET, **changes):
    data = overlay_for(target,
                       selection={"enable": ["core", "model-routing", "codex-accounts"], "disable": ["doctor"]},
                       modelRoutes={"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": {"auth": "env"}},
                       endpoints={"codex-accounts": "https://gateway.example.invalid/v1"},
                       env={"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"},
                       roles={"interactive": copy.deepcopy(NATIVE)})
    data.update(changes)
    return data


def report_for(left, right):
    return {"right": {"path": RIGHT}, **{k: v for k, v in compare(left, right).items() if k != "right"}}


class CarryRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")

    def round_trip(self, overlay_a, overlay_b, registry_a=None, registry_b=None):
        """Patches applied to overlay A render candidate B byte for byte; return the output."""
        files_a = candidate(copy.deepcopy(overlay_a), registry=copy.deepcopy(registry_a))
        files_b = candidate(copy.deepcopy(overlay_b), registry=copy.deepcopy(registry_b))
        before = json.dumps(overlay_a, sort_keys=True)
        output = carry(report_for(files_a, files_b), overlay_a, copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual(before, json.dumps(overlay_a, sort_keys=True), "carry must not change its input")
        patched = apply_patches(overlay_a, output["patches"])
        self.assertEqual(overlay_b, patched)
        plan = prepare(copy.deepcopy(self.manifest), patched, registry=copy.deepcopy(registry_b))
        self.assertEqual(file_bytes(files_b), rendered(plan))
        self.assertEqual({"status": "valid"}, output["patchedOverlay"])
        self.assertEqual(json.dumps(output, sort_keys=True),
                         json.dumps(carry(report_for(files_a, files_b), overlay_a, copy.deepcopy(self.manifest), files_b, RIGHT), sort_keys=True))
        return output

    def test_one_owner_package_prints_exactly_one_add(self):
        base = overlay_for(TARGET)
        output = self.round_trip(base, {**copy.deepcopy(base), "ownerPackages": [PACKAGE]})
        self.assertEqual([{"op": "add", "path": "/ownerPackages", "value": [PACKAGE]}], output["patches"])
        # The rendered package entry is a settings change; the overlay patch carries it.
        self.assertEqual([{"file": "settings.json", "field": "/packages/0/source", "reason": "rendered_field"}],
                         output["notCarried"])

    def test_each_owner_owned_key_round_trips(self):
        base = overlay_for(TARGET)
        doctor = copy.deepcopy(base)
        doctor["selection"]["enable"].append("doctor")
        doctor["selection"]["disable"].remove("doctor")
        cases = {
            "selection": (base, doctor, None, None),
            "unmanaged": (base, {**copy.deepcopy(base), "unmanaged": [{"key": "/npmCommand", "reason": "Host wrapper."}]}, None, None),
            "ownerPackages replace": ({**copy.deepcopy(base), "ownerPackages": [PACKAGE]},
                                      {**copy.deepcopy(base), "ownerPackages": [{"source": PACKAGE, "skills": ["skills/a"]}, "/srv/other"]},
                                      None, None),
            "ownerPackages remove": ({**copy.deepcopy(base), "ownerPackages": [PACKAGE]}, base, None, None),
            "core to routed": (base, routed(), None, REGISTRY),
            "routed to core": (routed(), base, REGISTRY, None),
            "thinking": (routed(), routed(roles={"interactive": {**NATIVE, "thinking": "low"}},
                                          modelRoutes={"schemaVersion": 1, "cycle": [{**NATIVE, "thinking": "low"}], "gateway": {"auth": "env"}}),
                         REGISTRY, REGISTRY),
            "gateway off": (routed(), routed(modelRoutes={"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": None},
                                             endpoints={}, env={}), REGISTRY, REGISTRY),
            "review role": (routed(), routed(roles={"interactive": copy.deepcopy(NATIVE), "review": copy.deepcopy(NATIVE)}),
                            REGISTRY, REGISTRY),
        }
        for name, (a, b, reg_a, reg_b) in cases.items():
            with self.subTest(case=name):
                output = self.round_trip(a, b, reg_a, reg_b)
                self.assertTrue(output["patches"])
                for patch in output["patches"]:
                    self.assertIn(patch["path"].split("/")[1], OWNED)

    def test_patch_forms_for_the_routed_change(self):
        output = self.round_trip(overlay_for(TARGET), routed(), None, REGISTRY)
        patches = {p["path"]: p for p in output["patches"]}
        self.assertEqual({"/endpoints/codex-accounts", "/env/codex-accounts", "/modelRoutes", "/roles/interactive",
                          "/selection/disable", "/selection/enable"}, set(patches))
        # The env value is the literal reference, never a resolved value.
        self.assertEqual({"op": "add", "path": "/env/codex-accounts", "value": "${TENANTEXT_LITELLM_API_KEY}"},
                         patches["/env/codex-accounts"])
        self.assertEqual("add", patches["/modelRoutes"]["op"])
        self.assertEqual("replace", patches["/selection/enable"]["op"])
        self.assertEqual([p["path"] for p in output["patches"]], sorted(p["path"] for p in output["patches"]))
        reasons = {(item["file"], item["field"]): item["reason"] for item in output["notCarried"]}
        self.assertEqual("rendered_field", reasons[("settings.json", "/defaultModel")])
        self.assertEqual("not_owner_owned", reasons[(".tenant-pi/choices.json", "/routes")])
        self.assertEqual("not_owner_owned", reasons[(".tenant-pi/state.json", "/provenance/enabled")])
        for item in output["notCarried"]:
            self.assertEqual({"file", "field", "reason"}, set(item))


def with_memory(*modules, memory=None, target=TARGET, **changes):
    """An overlay with the named memory modules selected, consent given, and a `memory` block."""
    data = overlay_for(target, **changes)
    for cid in modules:
        data["selection"]["disable"].remove(cid)
        data["selection"]["enable"].append(cid)
    data["consent"]["memoryCapture"] = bool(modules)
    if memory is not None:
        data["memory"] = {"schemaVersion": 1, "hermes": None, "wiki": None, "openviking": None, **memory}
    return data


MEMORY_ROLE = {"provider": "fake-native", "model": "team/slash-id", "thinking": "high"}
RECORD = (".tenant-pi/choices.json", "/memory")


class CarryMemoryAndResourceTests(unittest.TestCase):
    """`ownerResources` and the `memory` fields in the table; `consent` stays outside."""

    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")

    def run_pair(self, overlay_a, overlay_b, registry=None):
        files_a = candidate(copy.deepcopy(overlay_a), registry=copy.deepcopy(registry))
        files_b = candidate(copy.deepcopy(overlay_b), registry=copy.deepcopy(registry))
        output = carry(report_for(files_a, files_b), copy.deepcopy(overlay_a), copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([], [p for p in output["patches"] if p["path"].startswith("/consent")])
        return files_b, output

    def renders(self, patched, files_b, registry=None):
        plan = prepare(copy.deepcopy(self.manifest), patched, registry=copy.deepcopy(registry))
        self.assertEqual(file_bytes(files_b), rendered(plan))

    def test_owner_resources_add_replace_remove_round_trip(self):
        base = overlay_for(TARGET)
        skills, prompts, other = "/home/example/git/owner-skills/skills", "/home/example/git/owner-prompts", "/srv/other"
        cases = {
            "add key": (base, {**copy.deepcopy(base), "ownerResources": {"skills": [skills]}},
                        [{"op": "add", "path": "/ownerResources", "value": {"skills": [skills]}}]),
            "add kind": ({**copy.deepcopy(base), "ownerResources": {"skills": [skills]}},
                         {**copy.deepcopy(base), "ownerResources": {"skills": [skills], "prompts": [prompts]}},
                         [{"op": "add", "path": "/ownerResources/prompts", "value": [prompts]}]),
            "replace entry": ({**copy.deepcopy(base), "ownerResources": {"skills": [skills, other]}},
                              {**copy.deepcopy(base), "ownerResources": {"skills": [other, skills]}},
                              [{"op": "replace", "path": "/ownerResources/skills", "value": [other, skills]}]),
            "replace to empty": ({**copy.deepcopy(base), "ownerResources": {"skills": [skills]}},
                                 {**copy.deepcopy(base), "ownerResources": {"skills": []}},
                                 [{"op": "replace", "path": "/ownerResources/skills", "value": []}]),
            "remove kind": ({**copy.deepcopy(base), "ownerResources": {"skills": [skills], "prompts": [prompts]}},
                            {**copy.deepcopy(base), "ownerResources": {"prompts": [prompts]}},
                            [{"op": "remove", "path": "/ownerResources/skills"}]),
            "remove key": ({**copy.deepcopy(base), "ownerResources": {"prompts": [prompts]}}, base,
                           [{"op": "remove", "path": "/ownerResources"}]),
        }
        for name, (a, b, expected) in cases.items():
            with self.subTest(case=name):
                files_b, output = self.run_pair(a, b)
                self.assertEqual(expected, output["patches"])
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                patched = apply_patches(a, output["patches"])
                self.assertEqual(b, patched)
                self.renders(patched, files_b)
                # The rendered `skills` and `prompts` entries are settings changes; the overlay patch carries them.
                for item in output["notCarried"]:
                    self.assertEqual("rendered_field", item["reason"], item)
                    self.assertEqual("settings.json", item["file"])

    def test_memory_field_changes_round_trip_as_one_patch_per_field(self):
        wiki_off = {"ambientPersonalVault": False, "backgroundTasks": False}
        hermes_off = {"backgroundReview": False}
        hermes_on = {"backgroundReview": True, "reviewTransport": "direct", "childExtensionPaths": ["/srv/ext/one"]}
        cases = {
            "wiki ambient vault": (with_memory("wiki", memory={"wiki": wiki_off}),
                                   with_memory("wiki", memory={"wiki": {**wiki_off, "ambientPersonalVault": True,
                                                                        "wikiHome": "/home/example/vault"}}),
                                   [{"op": "replace", "path": "/memory/wiki/ambientPersonalVault", "value": True},
                                    {"op": "add", "path": "/memory/wiki/wikiHome", "value": "/home/example/vault"}]),
            "hermes review on": (with_memory("hermes", memory={"hermes": hermes_off}),
                                 with_memory("hermes", memory={"hermes": hermes_on}, roles={"memory": MEMORY_ROLE}),
                                 [{"op": "replace", "path": "/memory/hermes/backgroundReview", "value": True},
                                  {"op": "add", "path": "/memory/hermes/childExtensionPaths", "value": ["/srv/ext/one"]},
                                  {"op": "add", "path": "/memory/hermes/reviewTransport", "value": "direct"}]),
            "hermes review off": (with_memory("hermes", memory={"hermes": hermes_on}, roles={"memory": MEMORY_ROLE}),
                                  with_memory("hermes", memory={"hermes": hermes_off}, roles={"memory": MEMORY_ROLE}),
                                  [{"op": "replace", "path": "/memory/hermes/backgroundReview", "value": False},
                                   {"op": "remove", "path": "/memory/hermes/childExtensionPaths"},
                                   {"op": "remove", "path": "/memory/hermes/reviewTransport"}]),
            # A module that is `null` in one overlay has no field to keep: the module is one unit.
            "add wiki to hermes": (with_memory("hermes", memory={"hermes": hermes_off}),
                                   with_memory("hermes", "wiki", memory={"hermes": hermes_off, "wiki": wiki_off}),
                                   [{"op": "replace", "path": "/memory/wiki", "value": wiki_off}]),
            "remove wiki from hermes": (with_memory("hermes", "wiki", memory={"hermes": hermes_off, "wiki": wiki_off}),
                                        with_memory("hermes", memory={"hermes": hermes_off}),
                                        [{"op": "replace", "path": "/memory/wiki", "value": None}]),
        }
        for name, (a, b, expected) in cases.items():
            with self.subTest(case=name):
                files_b, output = self.run_pair(a, b)
                self.assertEqual(expected, [p for p in output["patches"] if p["path"].startswith("/memory")])
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                patched = apply_patches(a, output["patches"])
                self.assertEqual(b, patched)
                self.renders(patched, files_b)
                reasons = {(item["file"], item["field"]): item["reason"] for item in output["notCarried"]}
                # The activation record is derived: its overlay causes carry, the record gives no patch.
                self.assertEqual("not_owner_owned", reasons[RECORD])

    def test_all_null_memory_block_round_trips(self):
        # No module is selected and no rendered file changes: the overlay fields alone carry the block.
        base, empty = overlay_for(TARGET), with_memory(memory={})
        for name, (a, b, expected) in {
                "add": (base, empty, [{"op": "add", "path": "/memory", "value": empty["memory"]}]),
                "remove": (empty, base, [{"op": "remove", "path": "/memory"}])}.items():
            with self.subTest(case=name):
                files_b, output = self.run_pair(a, b)
                self.assertEqual(expected, output["patches"])
                self.assertEqual([], output["notCarried"])
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                patched = apply_patches(a, output["patches"])
                self.assertEqual(b, patched)
                self.renders(patched, files_b)

    def test_same_count_child_extension_replacement_round_trips(self):
        # The activation record stays equal, and the overlay field still carries.
        hermes = {"backgroundReview": True, "reviewTransport": "direct"}
        a = with_memory("hermes", memory={"hermes": {**hermes, "childExtensionPaths": ["/srv/ext/one"]}}, roles={"memory": MEMORY_ROLE})
        b = with_memory("hermes", memory={"hermes": {**hermes, "childExtensionPaths": ["/srv/ext/two"]}}, roles={"memory": MEMORY_ROLE})
        files_a, files_b = candidate(copy.deepcopy(a)), candidate(copy.deepcopy(b))
        report = report_for(files_a, files_b)
        self.assertEqual([{"file": ".tenant-pi/choices.json", "field": "/overlay/memory/hermes/childExtensionPaths/0", "change": "changed"},
                          {"file": "hermes-memory-config.json", "field": "/childExtensionPaths", "change": "changed"}],
                         report["changes"])
        self.assertNotIn("/srv/ext", json.dumps(report))
        output = carry(report, copy.deepcopy(a), copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/hermes/childExtensionPaths", "value": ["/srv/ext/two"]}],
                         output["patches"])
        self.assertEqual([{"file": "hermes-memory-config.json", "field": "/childExtensionPaths", "reason": "rendered_field"}],
                         output["notCarried"])
        self.assertEqual({"status": "valid"}, output["patchedOverlay"])
        patched = apply_patches(a, output["patches"])
        self.assertEqual(b, patched)
        self.renders(patched, files_b)

    def test_target_only_memory_field_survives_a_carry_of_another_field(self):
        # A memory field that only the patched overlay sets, and that the report does
        # not name, is in no patch.
        hermes = {"backgroundReview": True, "reviewTransport": "direct"}
        wiki = {"ambientPersonalVault": True, "backgroundTasks": False}
        cases = {
            # name: (module, the choice of A, the target-only field and its value, the field that changes from A to B).
            # A and B do not set the target-only field.
            "hermes.childExtensionPaths": ("hermes", hermes, "childExtensionPaths", ["/srv/ext/target-only"],
                                           "reviewTransport", "subprocess"),
            "wiki.wikiHome": ("wiki", wiki, "wikiHome", "/home/example/target-vault", "backgroundTasks", True),
        }
        for name, (module, choice, kept, kept_value, moved, moved_value) in cases.items():
            with self.subTest(field=name):
                a = with_memory(module, memory={module: choice}, roles={"memory": MEMORY_ROLE})
                b = with_memory(module, memory={module: {**choice, moved: moved_value}}, roles={"memory": MEMORY_ROLE})
                target = with_memory(module, memory={module: {**choice, kept: kept_value}}, roles={"memory": MEMORY_ROLE})
                files_b = candidate(copy.deepcopy(b))
                output = carry(report_for(candidate(copy.deepcopy(a)), files_b), copy.deepcopy(target),
                               copy.deepcopy(self.manifest), files_b, RIGHT)
                self.assertEqual([{"op": "replace", "path": "/memory/" + module + "/" + moved, "value": moved_value}],
                                 output["patches"])
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                patched = apply_patches(target, output["patches"])
                self.assertNotIn(kept, a["memory"][module])
                self.assertNotIn(kept, b["memory"][module])
                self.assertEqual(kept_value, patched["memory"][module][kept])
                expected = copy.deepcopy(target)
                expected["memory"][module][moved] = moved_value
                self.assertEqual(expected, patched)

    def test_field_with_another_value_in_the_target_survives_a_carry_of_another_field(self):
        # A, B and the patched overlay all set `childExtensionPaths`; only the patched overlay has its
        # own value. The report does not name the field, so the value stays.
        hermes = {"backgroundReview": True, "reviewTransport": "direct", "childExtensionPaths": ["/srv/ext/one"]}
        a = with_memory("hermes", memory={"hermes": hermes}, roles={"memory": MEMORY_ROLE})
        b = with_memory("hermes", memory={"hermes": {**hermes, "reviewTransport": "subprocess"}}, roles={"memory": MEMORY_ROLE})
        target = with_memory("hermes", memory={"hermes": {**hermes, "childExtensionPaths": ["/srv/ext/target"]}},
                             roles={"memory": MEMORY_ROLE})
        files_b = candidate(copy.deepcopy(b))
        output = carry(report_for(candidate(copy.deepcopy(a)), files_b), copy.deepcopy(target),
                       copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/hermes/reviewTransport", "value": "subprocess"}], output["patches"])
        self.assertEqual(["/srv/ext/target"], apply_patches(target, output["patches"])["memory"]["hermes"]["childExtensionPaths"])

    def test_openviking_fields_carry_by_value_and_the_remote_consent_stays_a_decision(self):
        def remote(data):
            data["consent"]["remoteMemoryWrites"] = True
            return data
        a = remote(with_memory("openviking", memory={"openviking": {"captureToolResults": False}}))
        b = remote(with_memory("openviking", memory={"openviking": {"captureToolResults": True, "recallContextTimeoutMs": 5000}}))
        files_b = candidate(copy.deepcopy(b))
        report = report_for(candidate(copy.deepcopy(a)), files_b)
        at = "/overlay/memory/openviking/"
        self.assertEqual({at + "captureToolResults": "changed", at + "recallContextTimeoutMs": "added"},
                         {c["field"]: c["change"] for c in report["changes"] if c["field"].startswith(at)})
        output = carry(report, copy.deepcopy(a), copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/openviking/captureToolResults", "value": True},
                          {"op": "add", "path": "/memory/openviking/recallContextTimeoutMs", "value": 5000}], output["patches"])
        self.assertEqual({"status": "valid"}, output["patchedOverlay"])
        self.assertEqual(b, apply_patches(a, output["patches"]))
        # The module goes from `null` to an object: the fields carry, the two consent switches do not.
        base = overlay_for(TARGET)
        report = report_for(candidate(copy.deepcopy(base)), files_b)
        output = carry(report, with_memory(memory={}), copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([], [p for p in output["patches"] if p["path"].startswith("/consent")])
        self.assertEqual({"captureToolResults": True, "recallContextTimeoutMs": 5000},
                         apply_patches(with_memory(memory={}), output["patches"])["memory"]["openviking"])
        for key in ("memoryCapture", "remoteMemoryWrites"):
            self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/consent/" + key, "reason": "consent_decision"},
                          output["notCarried"])
        self.assertEqual("invalid", output["patchedOverlay"]["status"])

    def test_all_null_block_change_never_touches_a_module_object_of_the_target(self):
        # The report names no `hermes` field, so `hermes` of the patched overlay stays.
        target = with_memory("hermes", memory={"hermes": {"backgroundReview": True, "reviewTransport": "direct",
                                                          "childExtensionPaths": ["/srv/ext/target"]}},
                             roles={"memory": MEMORY_ROLE})
        base, empty = overlay_for(TARGET), with_memory(memory={})
        for name, (a, b) in {"block added": (base, empty), "block removed": (empty, base)}.items():
            with self.subTest(case=name):
                files_b = candidate(copy.deepcopy(b))
                report = report_for(candidate(copy.deepcopy(a)), files_b)
                at = "/overlay/memory/"
                self.assertEqual([at + "hermes", at + "openviking", at + "schemaVersion", at + "wiki"],
                                 [c["field"] for c in report["changes"]])
                output = carry(report, copy.deepcopy(target), copy.deepcopy(self.manifest), files_b, RIGHT)
                self.assertEqual([], output["patches"])
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                self.assertEqual([{"file": ".tenant-pi/choices.json", "field": c["field"], "reason": "overlay_matches"}
                                  for c in report["changes"]], output["notCarried"])

    def test_module_set_to_null_on_the_right_still_carries_to_a_target_object(self):
        # A real change: the report names the `hermes` fields that B removes. The consent decision stays open.
        hermes = {"backgroundReview": True, "reviewTransport": "direct", "childExtensionPaths": ["/srv/ext/one"]}
        a = with_memory("hermes", memory={"hermes": hermes}, roles={"memory": MEMORY_ROLE})
        target = with_memory("hermes", memory={"hermes": {**hermes, "childExtensionPaths": ["/srv/ext/target"]}},
                             roles={"memory": MEMORY_ROLE})
        null_block = with_memory(memory={}, roles={"memory": MEMORY_ROLE})
        no_block = overlay_for(TARGET, roles={"memory": MEMORY_ROLE})
        for name, (b, expected) in {
                "hermes null": (null_block, [{"op": "replace", "path": "/memory/hermes", "value": None}]),
                "no block": (no_block, [{"op": "remove", "path": "/memory"}])}.items():
            with self.subTest(case=name):
                files_b = candidate(copy.deepcopy(b))
                report = report_for(candidate(copy.deepcopy(a)), files_b)
                self.assertIn("/overlay/memory/hermes/backgroundReview", [c["field"] for c in report["changes"]])
                output = carry(report, copy.deepcopy(target), copy.deepcopy(self.manifest), files_b, RIGHT)
                self.assertEqual(expected, [p for p in output["patches"] if p["path"].startswith("/memory")])
                self.assertEqual([], [p for p in output["patches"] if p["path"].startswith("/consent")])
                self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/consent/memoryCapture",
                               "reason": "consent_decision"}, output["notCarried"])
                self.assertEqual({"status": "invalid", "rule": "memory_disabled: overlay.consent"}, output["patchedOverlay"])
                patched = apply_patches(target, output["patches"])
                patched["consent"] = copy.deepcopy(b["consent"])
                self.assertEqual(b, patched)

    def test_removed_block_keeps_a_target_module_that_the_report_does_not_name(self):
        # B has no block and the report names only `hermes` fields. The patched overlay also has a
        # `wiki` object: `/memory` stays, `hermes` goes to `null`, and `wiki` is unchanged.
        hermes, wiki = {"backgroundReview": False}, {"ambientPersonalVault": False, "backgroundTasks": False}
        a = with_memory("hermes", memory={"hermes": hermes})
        b = overlay_for(TARGET)
        target = with_memory("hermes", "wiki", memory={"hermes": hermes, "wiki": wiki})
        files_b = candidate(copy.deepcopy(b))
        output = carry(report_for(candidate(copy.deepcopy(a)), files_b), copy.deepcopy(target),
                       copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/hermes", "value": None}],
                         [p for p in output["patches"] if p["path"].startswith("/memory")])
        self.assertEqual({"schemaVersion": 1, "hermes": None, "wiki": wiki, "openviking": None},
                         apply_patches(target, output["patches"])["memory"])
        reasons = {(item["file"], item["field"]): item["reason"] for item in output["notCarried"]}
        self.assertEqual("overlay_matches", reasons[(".tenant-pi/choices.json", "/overlay/memory/wiki")])

    def test_module_that_is_an_object_in_both_overlays_carries_only_the_named_fields(self):
        # The report says that `wiki` goes from `null` to an object. The patched overlay already has a
        # `wiki` object with a field of its own: that field stays, and the check names the rule.
        hermes_off, wiki_off = {"backgroundReview": False}, {"ambientPersonalVault": False, "backgroundTasks": False}
        a = with_memory("hermes", memory={"hermes": hermes_off})
        b = with_memory("hermes", "wiki", memory={"hermes": hermes_off, "wiki": wiki_off})
        target = with_memory("hermes", "wiki", memory={"hermes": hermes_off, "wiki": {
            "ambientPersonalVault": True, "backgroundTasks": False, "wikiHome": "/home/example/target-vault"}})
        files_b = candidate(copy.deepcopy(b))
        output = carry(report_for(candidate(copy.deepcopy(a)), files_b), copy.deepcopy(target),
                       copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/wiki/ambientPersonalVault", "value": False}], output["patches"])
        reasons = {(item["file"], item["field"]): item["reason"] for item in output["notCarried"]}
        self.assertEqual("overlay_matches", reasons[(".tenant-pi/choices.json", "/overlay/memory/wiki")])
        self.assertEqual("overlay_matches", reasons[(".tenant-pi/choices.json", "/overlay/memory/wiki/backgroundTasks")])
        self.assertEqual("/home/example/target-vault", apply_patches(target, output["patches"])["memory"]["wiki"]["wikiHome"])
        self.assertEqual({"status": "invalid", "rule": "wiki_home_is_ambient: overlay.memory.wiki.wikiHome"},
                         output["patchedOverlay"])

    def test_unnamed_memory_values_and_an_invalid_right_block_never_print(self):
        # Both sides and the patched overlay hold a secret-like path in a field that does not change.
        wiki = {"ambientPersonalVault": True, "backgroundTasks": False, "wikiHome": "/home/" + CANARY + "/vault"}
        a = with_memory("wiki", memory={"wiki": wiki}, roles={"memory": MEMORY_ROLE})
        b = with_memory("wiki", memory={"wiki": {**wiki, "backgroundTasks": True}}, roles={"memory": MEMORY_ROLE})
        files_a, files_b = candidate(copy.deepcopy(a)), candidate(copy.deepcopy(b))
        report = report_for(files_a, files_b)
        self.assertNotIn("CANARY", json.dumps(report))
        output = carry(report, copy.deepcopy(a), copy.deepcopy(self.manifest), files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/wiki/backgroundTasks", "value": True}], output["patches"])
        self.assertNotIn("CANARY", json.dumps(output))
        # A hand-edited right copy that fails the memory rules gives no patch and no value.
        broken = copy.deepcopy(files_b)
        broken[".tenant-pi/choices.json"]["overlay"]["memory"]["wiki"]["backgroundTasks"] = CANARY
        report = report_for(files_a, broken)
        self.assertNotIn("CANARY", json.dumps(report))
        output = carry(report, copy.deepcopy(a), copy.deepcopy(self.manifest), broken, RIGHT)
        self.assertEqual([], output["patches"])
        self.assertNotIn("CANARY", json.dumps(output))
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/memory/wiki/backgroundTasks",
                       "reason": "right_overlay_invalid"}, output["notCarried"])

    def test_memory_add_and_remove_leave_the_consent_decision_to_the_user(self):
        wiki = {"ambientPersonalVault": False, "backgroundTasks": False}
        without, enabled = overlay_for(TARGET), with_memory("wiki", memory={"wiki": wiki})
        for name, (a, b, op, rule) in {
                "add": (without, enabled, "add", "memory_consent_required: overlay.consent.memoryCapture"),
                "remove": (enabled, without, "remove", "memory_disabled: overlay.consent")}.items():
            with self.subTest(case=name):
                files_b, output = self.run_pair(a, b)
                memory = [p for p in output["patches"] if p["path"] == "/memory"]
                self.assertEqual([{"op": op, "path": "/memory", **({"value": b["memory"]} if op == "add" else {})}], memory)
                self.assertEqual(["/memory", "/selection/disable", "/selection/enable"], [p["path"] for p in output["patches"]])
                # The consent change is listed with its static reason and never printed as a patch.
                self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/consent/memoryCapture",
                               "reason": "consent_decision"}, output["notCarried"])
                self.assertEqual({"status": "invalid", "rule": rule}, output["patchedOverlay"])
                patched = apply_patches(a, output["patches"])
                self.assertNotEqual(b, patched)
                # The user's consent decision completes the overlay; then it renders candidate B.
                patched["consent"] = copy.deepcopy(b["consent"])
                self.assertEqual(b, patched)
                self.renders(patched, files_b)

    def test_consent_change_alone_is_never_a_patch(self):
        hermes = with_memory("hermes", memory={"hermes": {"backgroundReview": False}})
        left = candidate(copy.deepcopy(hermes))
        right = copy.deepcopy(left)
        # A hand-edited right overlay copy that differs only in consent: no patch, a static reason.
        right[".tenant-pi/choices.json"]["overlay"]["consent"]["telemetry"] = True
        report = report_for(left, right)
        report["changes"].append({"file": ".tenant-pi/choices.json", "field": "/overlay/consent", "change": "changed"})
        output = carry(report, copy.deepcopy(hermes), copy.deepcopy(self.manifest), right, RIGHT)
        self.assertEqual([], output["patches"])
        self.assertEqual([{"file": ".tenant-pi/choices.json", "field": "/overlay/consent", "reason": "consent_decision"},
                          {"file": ".tenant-pi/choices.json", "field": "/overlay/consent/telemetry", "reason": "consent_decision"}],
                         output["notCarried"])
        self.assertNotIn("consent", OWNED)

    def test_memory_and_resource_field_forms(self):
        left = candidate(overlay_for(TARGET))
        report = {"right": {"path": RIGHT}, "changes": [
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources", "change": "changed"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/themes/0", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/" + CANARY + "/0", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/hermes/" + CANARY, "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/" + CANARY + "/wikiHome", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/openviking/wikiHome", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/memory", "change": "changed"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/schemaVersion", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/hermes", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/wiki/wikiHome", "change": "added"}]}
        output = carry(report, overlay_for(TARGET), copy.deepcopy(self.manifest), left, RIGHT)
        self.assertNotIn("CANARY", json.dumps(output))
        self.assertEqual([], output["patches"])
        self.assertEqual([
            # The derived activation record is not in the table.
            {"file": ".tenant-pi/choices.json", "field": "/memory", "reason": "not_owner_owned"},
            # The block without a field, an unknown module and an unknown field map to no overlay path.
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory", "reason": "field_unmapped"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/<redacted>/wikiHome", "reason": "field_unmapped"},
            # Neither overlay has the block: the known fields lift to `/memory`, which matches.
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/hermes", "reason": "overlay_matches"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/hermes/<redacted>", "reason": "field_unmapped"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/openviking/wikiHome", "reason": "field_unmapped"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/schemaVersion", "reason": "overlay_matches"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/memory/wiki/wikiHome", "reason": "overlay_matches"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources", "reason": "field_unmapped"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/<redacted>/0", "reason": "field_unmapped"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/<redacted>/0", "reason": "field_unmapped"}],
            output["notCarried"])


class CarryEmbeddingTests(unittest.TestCase):
    setUp = CarryMemoryAndResourceTests.setUp
    run_pair = CarryMemoryAndResourceTests.run_pair
    renders = CarryMemoryAndResourceTests.renders

    def base(self, embedding=None):
        data = with_memory("wiki", memory={"wiki": {"ambientPersonalVault": False, "backgroundTasks": False}})
        if embedding is not None:
            data["memory"]["wiki"]["embedding"] = copy.deepcopy(embedding)
            data["consent"]["embeddingTextTransfer"] = True
        return data

    def choice(self):
        return {"provider": "openai-compatible", "baseUrl": "http://127.0.0.1:8080/v1",
                "model": "example-embedding", "auth": {"envVar": "EXAMPLE_EMBEDDING_KEY"}, "expectedDimensions": 1024}

    def test_embedding_leaf_changes_round_trip_and_preserve_unreported_values(self):
        a = self.base(self.choice())
        for key, value in (("baseUrl", "https://embeddings.example.invalid/v1"), ("model", "another-model"),
                           ("expectedDimensions", 1536), ("auth", {"mode": "none"})):
            with self.subTest(key=key):
                b = copy.deepcopy(a)
                b["memory"]["wiki"]["embedding"][key] = value
                files_b, output = self.run_pair(a, b)
                patched = apply_patches(a, output["patches"])
                self.assertEqual(b, patched)
                self.assertEqual({"status": "valid"}, output["patchedOverlay"])
                self.renders(patched, files_b)
                reverse_files, reverse = self.run_pair(b, a)
                self.assertEqual(a, apply_patches(b, reverse["patches"]))
                self.renders(apply_patches(b, reverse["patches"]), reverse_files)
        b = copy.deepcopy(a)
        b["memory"]["wiki"]["embedding"]["model"] = "another-model"
        files_b = candidate(b)
        target = copy.deepcopy(a)
        target["memory"]["wiki"]["embedding"].update(baseUrl="https://target.example.invalid/v1", expectedDimensions=2048)
        output = carry(report_for(candidate(a), files_b), target, self.manifest, files_b, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/wiki/embedding/model", "value": "another-model"}], output["patches"])
        patched = apply_patches(target, output["patches"])
        self.assertEqual(target["memory"]["wiki"]["embedding"]["baseUrl"], patched["memory"]["wiki"]["embedding"]["baseUrl"])
        self.assertEqual(2048, patched["memory"]["wiki"]["embedding"]["expectedDimensions"])
        target["memory"]["wiki"]["embedding"]["auth"] = {"mode": "none"}
        output = carry(report_for(candidate(a), files_b), target, self.manifest, files_b, RIGHT)
        self.assertEqual({"mode": "none"}, apply_patches(target, output["patches"])["memory"]["wiki"]["embedding"]["auth"])
        self.assertEqual({"status": "valid"}, output["patchedOverlay"])
        # Optional dimension omission is a leaf removal, not a whole embedding replacement.
        b = copy.deepcopy(a)
        del b["memory"]["wiki"]["embedding"]["expectedDimensions"]
        files_b, output = self.run_pair(a, b)
        self.assertEqual([{"op": "remove", "path": "/memory/wiki/embedding/expectedDimensions"}], output["patches"])
        self.renders(apply_patches(a, output["patches"]), files_b)

    def test_enable_disable_omission_and_consent_invalid_patches(self):
        on, omitted = self.base(self.choice()), self.base()
        null = copy.deepcopy(omitted)
        null["memory"]["wiki"]["embedding"] = None
        for off in (omitted, null):
            for a, b, rule in ((off, on, "embedding_consent_missing"), (on, off, "embedding_consent_unused")):
                with self.subTest(rule=rule, null=off is null):
                    files_b, output = self.run_pair(a, b)
                    self.assertEqual(1, len(output["patches"]))
                    self.assertEqual("/memory/wiki/embedding", output["patches"][0]["path"])
                    self.assertEqual({"status": "invalid", "rule": rule + ": overlay.consent.embeddingTextTransfer"}, output["patchedOverlay"])
                    patched = apply_patches(a, output["patches"])
                    self.assertEqual(a["consent"], patched["consent"])
                    patched["consent"] = copy.deepcopy(b["consent"])
                    self.assertEqual(b, patched)
                    self.renders(patched, files_b)
        for a, b in ((omitted, null), (null, omitted)):
            files_b, output = self.run_pair(a, b)
            self.assertEqual(b, apply_patches(a, output["patches"]))
            # A disabled marker alone must not discard a target's unreported embedding fields.
            output = carry(report_for(candidate(a), files_b), on, self.manifest, files_b, RIGHT)
            self.assertEqual([], output["patches"])
        files_b = candidate(on)
        target = copy.deepcopy(on)
        target["memory"]["wiki"]["embedding"]["expectedDimensions"] = 2048
        no_dimension = copy.deepcopy(on)
        del no_dimension["memory"]["wiki"]["embedding"]["expectedDimensions"]
        files_b = candidate(no_dimension)
        output = carry(report_for(candidate(null), files_b), target, self.manifest, files_b, RIGHT)
        self.assertEqual([], output["patches"])
        # Old records with an inert activation record missing compare without carry noise.
        old = candidate(omitted)
        del old[CHOICES]["memory"]["activation"]["wiki"]["embeddings"]
        files_b = candidate(omitted)
        output = carry(report_for(old, files_b), omitted, self.manifest, files_b, RIGHT)
        self.assertEqual([], output["patches"])
        self.assertEqual([], output["notCarried"])

    def test_values_come_only_from_validated_right_overlay(self):
        a, b = self.base(self.choice()), self.base(self.choice())
        b["memory"]["wiki"]["embedding"]["model"] = "right-overlay-model"
        right = candidate(b)
        report = report_for(candidate(a), right)
        right["settings.json"]["llm-wiki"]["embeddingModel"] = CANARY
        for entry in report["changes"]:
            entry["right"] = {"value": CANARY}
        output = carry(report, a, self.manifest, right, RIGHT)
        self.assertEqual([{"op": "replace", "path": "/memory/wiki/embedding/model", "value": "right-overlay-model"}], output["patches"])
        self.assertNotIn(CANARY, json.dumps(output))
        for value in ([], CANARY, {"auth": {"apiKey": CANARY}}):
            broken = copy.deepcopy(right)
            broken[CHOICES]["overlay"]["memory"]["wiki"]["embedding"] = value
            output = carry(report, a, self.manifest, broken, RIGHT)
            self.assertEqual([], output["patches"])
            self.assertNotIn(CANARY, json.dumps(output))
            self.assertIn("right_overlay_invalid", [c["reason"] for c in output["notCarried"]])
        # Legacy whole-object markers cannot replace unreported leaves of an existing object.
        report["changes"] = [{"file": CHOICES, "field": "/overlay/memory/wiki/embedding", "change": "changed"}]
        output = carry(report, a, self.manifest, right, RIGHT)
        self.assertEqual([], output["patches"])
        self.assertEqual("overlay_matches", output["notCarried"][0]["reason"])
        report["changes"] = [{"file": CHOICES, "field": "/overlay/memory/wiki/embedding/" + CANARY, "change": "added"}]
        output = carry(report, a, self.manifest, right, RIGHT)
        self.assertEqual([], output["patches"])
        self.assertNotIn(CANARY, json.dumps(output))
        self.assertEqual("field_unmapped", output["notCarried"][0]["reason"])


class CarryRuleTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load(ROOT / "config/manifest.json")
        self.base = overlay_for(TARGET)
        self.left = candidate(copy.deepcopy(self.base))
        self.right = candidate({**copy.deepcopy(self.base), "ownerPackages": [PACKAGE]})

    def run_carry(self, report=None, overlay_data=None, right=None, path=RIGHT):
        right = self.right if right is None else right
        return carry(report_for(self.left, right) if report is None else report,
                     copy.deepcopy(self.base) if overlay_data is None else overlay_data,
                     copy.deepcopy(self.manifest), right, path)

    def error(self, rule, **kwargs):
        with self.assertRaises(Invalid) as caught:
            self.run_carry(**kwargs)
        self.assertEqual(rule, str(caught.exception))
        self.assertNotIn("CANARY", str(caught.exception))

    def test_non_owned_change_is_not_carried_and_secret_canary_never_printed(self):
        # A secret-like string in non-owned fields of both sides: target, settings and a module-free key.
        left = copy.deepcopy(self.left)
        right = copy.deepcopy(self.right)
        for files, side in ((left, "L"), (right, "R")):
            files[".tenant-pi/choices.json"]["overlay"]["target"]["agentDir"] = "/home/" + CANARY + side
            files["settings.json"]["defaultModel"] = CANARY + side
            files["settings.json"]["npmCommand"] = [CANARY + side]
            # A memory background-model path, an owner resource path and the memory
            # record are rendered or derived fields. Only the overlay copy gives a patch value.
            files["hermes-memory-config.json"] = {"reviewEnabled": True, "llmModelOverride": CANARY + side,
                                                  "childExtensionPaths": ["/opt/" + CANARY + side]}
            files["settings.json"]["skills"] = ["/home/" + CANARY + side]
            files["settings.json"]["prompts"] = ["/home/" + CANARY + side]
            files[".tenant-pi/choices.json"]["memory"] = {"setup": [{"instruction": "WIKI_HOME=/" + CANARY + side}]}
        output = self.run_carry(report=report_for(left, right), right=right)
        printed = json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
        self.assertNotIn("CANARY", printed)
        self.assertEqual([{"op": "add", "path": "/ownerPackages", "value": [PACKAGE]}], output["patches"])
        reasons = {(item["file"], item["field"]): item["reason"] for item in output["notCarried"]}
        self.assertEqual("not_owner_owned", reasons[(".tenant-pi/choices.json", "/overlay/target/agentDir")])
        self.assertEqual("rendered_field", reasons[("settings.json", "/defaultModel")])
        self.assertEqual("rendered_field", reasons[("hermes-memory-config.json", "/childExtensionPaths")])
        self.assertEqual("rendered_field", reasons[("hermes-memory-config.json", "/llmModelOverride")])
        self.assertEqual("rendered_field", reasons[("settings.json", "/skills/0")])
        self.assertEqual("rendered_field", reasons[("settings.json", "/prompts/0")])
        # The record is derived metadata and selects no unit.
        self.assertEqual("not_owner_owned", reasons[(".tenant-pi/choices.json", "/memory")])

    def test_accepted_range_change_is_visible_but_never_carried(self):
        right = copy.deepcopy(self.left)
        right[".tenant-pi/choices.json"]["manifest"]["runtime"]["piAcceptedRange"] = ">=0.0.0 <99"
        output = self.run_carry(report=report_for(self.left, right), right=right)
        self.assertEqual([], output["patches"])
        self.assertEqual([{"file": ".tenant-pi/choices.json", "field": "/manifest/runtime/piAcceptedRange",
                          "reason": "not_owner_owned"}], output["notCarried"])
        self.assertNotIn(">=0.0.0 <99", json.dumps(output))

    def test_unknown_field_segments_print_as_redacted(self):
        report = report_for(self.left, self.right)
        report["changes"] += [
            {"file": "settings.json", "field": "/" + CANARY, "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/target/" + CANARY, "change": "changed"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/endpoints/sk-live-canary", "change": "added"},
            {"file": "mcp-adapter.json", "field": "/mcpServers/" + CANARY + "/disabled", "change": "changed"},
            {"file": "settings.json", "field": "/packages/1234567/source", "change": "added"}]
        output = self.run_carry(report=report)
        self.assertNotIn("CANARY", json.dumps(output))
        self.assertNotIn("sk-live", json.dumps(output))
        shown = {(item["file"], item["field"], item["reason"]) for item in output["notCarried"]}
        self.assertEqual({("settings.json", "/<redacted>", "rendered_field"),
                          (".tenant-pi/choices.json", "/overlay/target/<redacted>", "not_owner_owned"),
                          # An ID-shaped name maps to a unit; with no value on either side it matches.
                          (".tenant-pi/choices.json", "/overlay/endpoints/<redacted>", "overlay_matches"),
                          ("mcp-adapter.json", "/mcpServers/<redacted>/disabled", "rendered_field"),
                          ("settings.json", "/packages/<redacted>/source", "rendered_field"),
                          ("settings.json", "/packages/0/source", "rendered_field")}, shown)
        self.assertEqual([{"op": "add", "path": "/ownerPackages", "value": [PACKAGE]}], output["patches"])
        # Every field `compare` prints for a real pair keeps its kit names.
        routed_report = report_for(candidate(overlay_for(TARGET)), candidate(routed(), registry=copy.deepcopy(REGISTRY)))
        output = carry(routed_report, overlay_for(TARGET), copy.deepcopy(self.manifest),
                       candidate(routed(), registry=copy.deepcopy(REGISTRY)), RIGHT)
        self.assertEqual([], [item for item in output["notCarried"] if "<redacted>" in item["field"]])
        self.assertEqual(sorted({(c["file"], c["field"]) for c in routed_report["changes"]} -
                                {(".tenant-pi/choices.json", c["field"]) for c in routed_report["changes"]
                                 if c["field"].split("/")[2:3] and c["field"].split("/")[2] in OWNED}),
                         sorted((item["file"], item["field"]) for item in output["notCarried"]))

    def test_right_without_overlay_copy_or_with_an_invalid_one_carries_nothing(self):
        plain = {"settings.json": copy.deepcopy(self.right["settings.json"]), ".tenant-pi/choices.json": None,
                 ".tenant-pi/state.json": None}
        report = report_for(self.left, self.right)
        output = self.run_carry(report=report, right=plain)
        self.assertEqual([], output["patches"])
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerPackages/0", "reason": "right_overlay_missing"},
                      output["notCarried"])
        broken = copy.deepcopy(self.right)
        broken[".tenant-pi/choices.json"]["overlay"]["ownerPackages"] = ["relative/" + CANARY]
        output = self.run_carry(report=report, right=broken)
        self.assertEqual([], output["patches"])
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerPackages/0", "reason": "right_overlay_invalid"},
                      output["notCarried"])
        self.assertNotIn("CANARY", json.dumps(output))
        hand_env = copy.deepcopy(self.right)
        hand_env[".tenant-pi/choices.json"]["overlay"]["env"] = {"codex-accounts": CANARY}
        self.assertNotIn("CANARY", json.dumps(self.run_carry(report=report, right=hand_env)))

    def test_overlay_that_already_matches_gets_no_patch(self):
        done = {**copy.deepcopy(self.base), "ownerPackages": [PACKAGE]}
        output = self.run_carry(overlay_data=done)
        self.assertEqual([], output["patches"])
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerPackages/0", "reason": "overlay_matches"},
                      output["notCarried"])

    def test_owned_key_with_unmapped_field_is_listed(self):
        report = report_for(self.left, self.right)
        report["changes"].append({"file": ".tenant-pi/choices.json", "field": "/overlay/roles/<redacted>", "change": "added"})
        report["changes"].append({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/skills/0", "change": "added"})
        output = self.run_carry(report=report)
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/roles/<redacted>", "reason": "field_unmapped"},
                      output["notCarried"])
        # `ownerResources` is in the table. Neither side has the key, so the overlay matches.
        self.assertIn({"file": ".tenant-pi/choices.json", "field": "/overlay/ownerResources/skills/0", "reason": "overlay_matches"},
                      output["notCarried"])

    def test_patched_overlay_check_names_a_rule(self):
        # Carry the mcp selection without its `inputs.mcpFile`: the check names the static rule.
        mcp = copy.deepcopy(self.base)
        mcp["selection"]["enable"].append("mcp")
        mcp["selection"]["disable"].remove("mcp")
        mcp["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
        right = copy.deepcopy(self.right)
        right[".tenant-pi/choices.json"]["overlay"] = mcp
        report = {"right": {"path": RIGHT}, "changes": [
            {"file": ".tenant-pi/choices.json", "field": "/overlay/selection/enable/mcp", "change": "added"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/selection/disable/mcp", "change": "removed"},
            {"file": ".tenant-pi/choices.json", "field": "/overlay/inputs/mcpFile", "change": "changed"}]}
        output = self.run_carry(report=report, right=right)
        self.assertEqual(["/selection/disable", "/selection/enable"], [p["path"] for p in output["patches"]])
        self.assertEqual({"status": "invalid", "rule": "mcp_input_required: overlay.inputs.mcpFile"}, output["patchedOverlay"])

    def test_report_and_overlay_refusals_are_static(self):
        good = report_for(self.left, self.right)
        self.error("report_right_mismatch: report.right.path", path="/home/example/other")
        self.error("report_shape: report", report=[])
        self.error("report_shape: report", report={"right": {"path": RIGHT}})
        self.error("report_right_mismatch: report.right.path", report={"changes": []})
        self.error("report_shape: report", report={"right": {"path": RIGHT}, "changes": {"0": good["changes"][0]}})
        self.error("report_right_mismatch: report.right.path", report={**good, "right": RIGHT})
        self.error("report_right_mismatch: report.right.path", report={**good, "right": [RIGHT]})
        for entry in ({"file": "auth.json", "field": "/token", "change": "added"},
                      {"file": "settings.json", "field": "/a $x", "change": "added"},
                      {"file": "settings.json", "field": "/" + "a" * 65, "change": "added"},
                      {"file": "settings.json", "field": "/packages/" + "a" * 65 + "/source", "change": "added"},
                      {"file": "settings.json", "field": "no-slash", "change": "added"},
                      {"file": "settings.json", "field": "/a" * 300, "change": "added"},
                      {"file": "settings.json", "field": "/a", "change": CANARY},
                      CANARY):
            with self.subTest(entry=str(entry)[:40]):
                self.error("report_shape: report.changes", report={**good, "changes": [entry]})
        bad = copy.deepcopy(self.base)
        bad["env"] = {"codex-accounts": CANARY}
        self.error("unselected_env: overlay.env", overlay_data=bad)


class CarryCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-carry-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        hook = self.base / "sitecustomize.py"
        self.log = self.base / "opened.log"
        hook.write_text("import sys\nsys.dont_write_bytecode = True\n"
                        "import os, socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n"
                        "_log = os.open(" + repr(str(self.log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
                        "_WRITE = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND\n"
                        "def _audit(event, args):\n"
                        "    if event == 'open':\n"
                        "        line = ('WRITE ' if type(args[2]) is int and args[2] & _WRITE else '') + str(args[0])\n"
                        "    elif event.startswith(('os.mkdir', 'os.rename', 'os.remove', 'os.rmdir', 'os.symlink', 'os.link', 'os.chmod', 'os.chown', 'os.truncate', 'os.utime', 'shutil.')):\n"
                        "        line = 'MUTATE ' + event + ' ' + str(args[0])\n"
                        "    else:\n        return\n"
                        "    os.write(_log, (line + '\\n').encode('utf-8', 'replace'))\n"
                        "sys.addaudithook(_audit)\n")
        self.env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=str(self.base))
        self.left, self.right = self.base / "left", self.base / "right"
        overlay_a = overlay_for(TARGET)
        self.write_side(self.left, candidate(copy.deepcopy(overlay_a)))
        self.right_files = candidate(routed(), registry=copy.deepcopy(REGISTRY))
        self.write_side(self.right, self.right_files)
        self.overlay = self.base / "overlay.json"
        self.overlay.write_text(json.dumps(overlay_a), encoding="utf-8")
        self.report = self.base / "report.json"

    def write_side(self, directory, files):
        (directory / ".tenant-pi").mkdir(parents=True, mode=0o700)
        for name, content in files.items():
            (directory / name).write_text(json.dumps(content), encoding="utf-8")
        # Private runtime state beside the declared files must stay unread.
        (directory / "auth.json").write_text('{"token": "CANARY_AUTH"}')
        (directory / "models.json").write_text('{"key": "CANARY_MODELS"}')
        (directory / "sessions").mkdir()
        (directory / "sessions" / "s.jsonl").write_text("CANARY_SESSION")

    def cli(self, action, *args):
        return subprocess.run([sys.executable, str(CLI), action, *args], cwd=self.base, env=self.env,
                              capture_output=True, check=False)

    def make_report(self):
        result = self.cli("compare", "--left", str(self.left), "--right", str(self.right))
        self.assertEqual(0, result.returncode, result.stderr)
        self.report.write_bytes(result.stdout)

    def run_carry(self, *extra):
        return self.cli("carry", "--report", str(self.report), "--overlay", str(self.overlay), "--right", str(self.right), *extra)

    def test_round_trip_through_the_cli_reads_only_declared_files(self):
        for side in (self.left, self.right):
            settings = json.loads((side / "settings.json").read_text())
            settings["npmCommand"] = ["/opt/" + CANARY]
            settings["theme"] = CANARY
            (side / "settings.json").write_text(json.dumps(settings))
        self.make_report()
        self.log.unlink()
        before = {path: path.read_bytes() if path.is_file() else None for path in self.base.rglob("*") if path != self.log}
        result = self.run_carry()
        self.assertEqual((0, b""), (result.returncode, result.stderr))
        self.assertNotIn(b"CANARY", result.stdout)
        self.assertEqual(result.stdout, self.run_carry().stdout)
        output = json.loads(result.stdout)
        self.assertEqual(result.stdout.decode("ascii").rstrip("\n"),
                         json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
        lines = self.log.read_text().splitlines()
        # No write open, directory creation, rename, removal, link or mode change.
        self.assertEqual([], [line for line in lines if line.startswith(("WRITE ", "MUTATE "))])
        opened = {Path(line).name for line in lines}
        for private in ("auth.json", "models.json", "s.jsonl"):
            self.assertNotIn(private, opened)
        self.assertTrue({"report.json", "overlay.json", "manifest.json", "settings.json", "choices.json", "state.json"} <= opened, opened)
        self.log.unlink()
        self.assertEqual(before, {path: path.read_bytes() if path.is_file() else None for path in self.base.rglob("*")})
        patched = apply_patches(json.loads(self.overlay.read_text()), output["patches"])
        plan = prepare(load(ROOT / "config/manifest.json"), patched, registry=copy.deepcopy(REGISTRY))
        self.assertEqual(file_bytes(self.right_files), rendered(plan))

    def test_refusals_are_static_and_print_nothing(self):
        self.make_report()
        cases = ((("--right", "relative"), "absolute_path: carry.right"),
                 (("--right", str(self.left)), "report_right_mismatch: report.right.path"),
                 (("--report", str(self.base / "absent.json")), "input_missing: carry.report"))
        for args, rule in cases:
            with self.subTest(rule=rule):
                options = dict(zip(("--report", "--overlay", "--right"), (str(self.report), str(self.overlay), str(self.right))))
                options.update(dict([args]))
                self.log.unlink(missing_ok=True)
                result = self.cli("carry", *[x for pair in options.items() for x in pair])
                self.assertEqual(2, result.returncode)
                self.assertEqual({"candidate_created": False, "error": rule}, json.loads(result.stderr))
                self.assertEqual(b"", result.stdout)
                if rule.startswith("report_right_mismatch"):
                    # The refusal fires before any file of the named directory is opened.
                    self.assertEqual([], [line for line in self.log.read_text().splitlines() if str(self.left) in line])
        self.report.write_text('{"right": {"path": "' + str(self.right) + '"}, "changes": [{"file": "settings.json", "field": "/' + CANARY + '!", "change": "added"}]}')
        result = self.run_carry()
        self.assertEqual({"candidate_created": False, "error": "report_shape: report.changes"}, json.loads(result.stderr))
        self.assertNotIn(b"CANARY", result.stdout + result.stderr)
        # A field that only looks like a secret passes the shape rule and prints as `<redacted>`.
        self.report.write_text('{"right": {"path": "' + str(self.right) + '"}, "changes": [{"file": "settings.json", "field": "/' + CANARY + '", "change": "added"}]}')
        result = self.run_carry()
        self.assertEqual((0, b""), (result.returncode, result.stderr))
        self.assertNotIn(b"CANARY", result.stdout)
        self.assertEqual([{"file": "settings.json", "field": "/<redacted>", "reason": "rendered_field"}],
                         json.loads(result.stdout)["notCarried"])
        link = self.base / "linked.json"
        link.symlink_to(self.overlay)
        result = self.cli("carry", "--report", str(self.report), "--overlay", str(link), "--right", str(self.right))
        self.assertEqual({"candidate_created": False, "error": "input_not_regular: carry.overlay"}, json.loads(result.stderr))


if __name__ == "__main__":
    unittest.main()
