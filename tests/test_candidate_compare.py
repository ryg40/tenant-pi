"""Pure comparison contract: deterministic markers, public pins, redaction, and shape visibility."""
import copy
import json
import unittest

from scripts.candidate_compare import DECLARED_ENV, FILES, compare, describe
from scripts.profile_plan import prepare, source_pin
from scripts.profile_write import _provenance
from scripts.validate import Invalid, load
from tests.test_model_routes import NATIVE, REGISTRY

CANARY = "CANARY_SECRET"


def candidate(overlay, registry=None):
    """The declared files exactly as the generator publishes them."""
    plan = prepare(load("config/manifest.json"), overlay, registry=registry)
    choices = plan["files"][".tenant-pi/choices.json"]["content"]
    names = [name for name in ("settings.json", ".tenant-pi/choices.json", "hermes-memory-config.json") if name in plan["files"]]
    files = {name: copy.deepcopy(plan["files"][name]["content"]) for name in names}
    files[".tenant-pi/state.json"] = {"schemaVersion": 1, "status": "complete", "provenance": _provenance(choices, names)}
    return files


def overlay_for(target, **changes):
    data = load("config/config.example.json")
    data["target"]["agentDir"] = target
    data.update(changes)
    return data


def fields(report, change=None):
    return [(c["file"], c["field"]) for c in report["changes"] if change is None or c["change"] == change]


class CompareTests(unittest.TestCase):
    def setUp(self):
        self.old = candidate(overlay_for("/home/example/old"))
        routed = overlay_for("/home/example/new",
                             selection={"enable": ["core", "model-routing", "codex-accounts"], "disable": []},
                             modelRoutes={"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": {"auth": "env"}},
                             endpoints={"codex-accounts": "https://gateway.example.invalid/v1"},
                             env={"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"},
                             roles={"interactive": copy.deepcopy(NATIVE)})
        self.new = candidate(routed, registry=copy.deepcopy(REGISTRY))

    def test_unchanged_generation_is_only_the_target_marker(self):
        again = candidate(overlay_for("/home/example/again"))
        report = compare(self.old, again)
        self.assertEqual([(".tenant-pi/choices.json", "/overlay/target/agentDir")], fields(report))
        self.assertNotIn("left", report["changes"][0])
        self.assertEqual({"added": 0, "removed": 0, "changed": 1, "unsupported": 0, "accepted": 0, "markers": 0,
                          "unchanged": report["summary"]["unchanged"]},
                         report["summary"])
        self.assertGreater(report["summary"]["unchanged"], 20)
        self.assertEqual([], report["unsupported"])
        for side in ("left", "right"):
            self.assertEqual({"kind": "candidate", "state": "complete",
                              "drift": {"status": "none", "fields": [], "metadata": "unchanged"}}, report[side])
        self.assertEqual(json.dumps(report, sort_keys=True), json.dumps(compare(self.old, again), sort_keys=True))
        self.assertEqual(list(FILES), report["scope"]["filesRead"])
        self.assertNotIn("/home/example", json.dumps(report))

    def test_added_module_and_private_choices_show_markers_only(self):
        report = compare(self.old, self.new)
        added = dict(((c["file"], c["field"]), c) for c in report["changes"] if c["change"] == "added")
        self.assertNotIn("right", added[(".tenant-pi/choices.json", "/overlay/endpoints/codex-accounts")])
        self.assertNotIn("right", added[(".tenant-pi/choices.json", "/overlay/env/codex-accounts")])
        self.assertNotIn("right", added[(".tenant-pi/choices.json", "/overlay/roles/interactive/model")])
        self.assertNotIn("right", added[("settings.json", "/defaultModel")])
        self.assertEqual({"value": "high"}, added[("settings.json", "/defaultThinkingLevel")]["right"])
        self.assertEqual({"value": "listed"}, added[(".tenant-pi/choices.json", "/overlay/selection/enable/codex-accounts")]["right"])
        self.assertEqual({"value": "env"}, added[(".tenant-pi/choices.json", "/overlay/modelRoutes/gateway/auth")]["right"])
        # The settings entry holds the host path of the kit; only the kit-relative pin is public.
        self.assertEqual({"status": "unsupported_value"}, added[("settings.json", "/packages/0/source")]["right"])
        self.assertEqual({"value": "tree:packages/tenantext"}, added[(".tenant-pi/state.json", "/provenance/pins/codex-accounts")]["right"])
        self.assertIn((".tenant-pi/choices.json", "/overlay/selection/disable/codex-accounts"), fields(report, "removed"))
        dump = json.dumps(report)
        for private in ("gateway.example.invalid", "TENANTEXT_LITELLM_API_KEY", "team/slash-id", "fake-native"):
            self.assertNotIn(private, dump)
        self.assertEqual([], report["unsupported"])
        self.assertEqual({"status": "none", "fields": [], "metadata": "unchanged"}, report["right"]["drift"])

    def test_changed_source_pin_is_public_and_old_drift_is_not_computable(self):
        previous = copy.deepcopy(self.old)
        choices = previous[".tenant-pi/choices.json"]
        choices["manifest"]["runtime"]["piVersion"] = "0.87.1"
        choices["manifest"]["components"]["core"]["source"]["spec"] = "@earendil-works/pi-coding-agent@0.87.1"
        previous[".tenant-pi/state.json"]["provenance"] = _provenance(choices, ["settings.json", ".tenant-pi/choices.json"])
        report = compare(previous, self.old)
        changed = {(c["file"], c["field"]): c for c in report["changes"] if c["change"] == "changed"}
        self.assertEqual(({"value": "npm:@earendil-works/pi-coding-agent@0.87.1"}, {"value": "npm:@earendil-works/pi-coding-agent@1.0.3"}),
                         (changed[(".tenant-pi/choices.json", "/manifest/components/core/source")]["left"],
                          changed[(".tenant-pi/choices.json", "/manifest/components/core/source")]["right"]))
        self.assertEqual({"value": "0.87.1"}, changed[(".tenant-pi/choices.json", "/manifest/runtime/piVersion")]["left"])
        self.assertEqual({"value": "0.87.1"}, changed[(".tenant-pi/state.json", "/provenance/piVersion")]["left"])
        self.assertEqual({"status": "not_computable", "rule": "core_runtime_pin: manifest.runtime.piVersion"}, report["left"]["drift"])
        self.assertEqual("none", report["right"]["drift"]["status"])

    def test_owner_edits_and_unknown_fields_are_visible_without_values(self):
        edited = copy.deepcopy(self.new)
        edited["settings.json"]["defaultModel"] = CANARY
        edited["settings.json"]["npmCommand"] = ["/private/" + CANARY, "--", "npm"]
        edited["settings.json"]["deviceId"] = CANARY
        edited["settings.json"]["bad key\n"] = CANARY
        edited["settings.json"]["defaultProjectTrust"] = CANARY
        report = compare(self.new, edited)
        self.assertEqual({"status": "owner_edits", "metadata": "unchanged",
                          "fields": ["/defaultModel", "/defaultProjectTrust", "/deviceId", "/npmCommand", "/<redacted>"]},
                         report["right"]["drift"])
        self.assertEqual([{"file": "settings.json", "field": "/<redacted>", "side": "right", "status": "unsupported_field_name"},
                          {"file": "settings.json", "field": "/deviceId", "side": "right", "status": "unsupported_field"},
                          {"file": "settings.json", "field": "/npmCommand", "side": "right", "status": "unsupported_field"}],
                         report["unsupported"])
        changed = {(c["file"], c["field"]): c for c in report["changes"] if c["change"] == "changed"}
        self.assertNotIn("right", changed[("settings.json", "/defaultModel")])
        self.assertEqual(({"value": "ask"}, {"status": "unsupported_value"}),
                         (changed[("settings.json", "/defaultProjectTrust")]["left"], changed[("settings.json", "/defaultProjectTrust")]["right"]))
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertNotIn("bad key", json.dumps(report))

    def test_metadata_edit_and_incomplete_state(self):
        edited = copy.deepcopy(self.old)
        edited[".tenant-pi/choices.json"]["overlay"]["consent"]["memoryCapture"] = True
        edited[".tenant-pi/choices.json"]["overlay"]["selection"]["enable"].append("hermes")
        edited[".tenant-pi/state.json"]["status"] = "incomplete"
        report = compare(self.old, edited)
        self.assertEqual("incomplete", report["right"]["state"])
        self.assertEqual("not_computable", report["right"]["drift"]["status"])
        self.assertEqual("selection_conflict: overlay.selection", report["right"]["drift"]["rule"])
        consent = next(c for c in report["changes"] if c["field"] == "/overlay/consent/memoryCapture")
        self.assertEqual(({"value": False}, {"value": True}), (consent["left"], consent["right"]))

    def test_nested_secret_canaries_never_reach_the_report(self):
        hostile = copy.deepcopy(self.new)
        choices = hostile[".tenant-pi/choices.json"]
        choices["overlay"]["endpoints"]["codex-accounts"] = "https://" + CANARY + ".invalid/v1"
        choices["overlay"]["env"]["codex-accounts"] = "${" + CANARY + "}"
        choices["overlay"]["roles"]["interactive"]["model"] = CANARY
        choices["overlay"]["modelRoutes"]["cycle"][0]["provider"] = CANARY
        choices["overlay"]["modelRoutes"]["cycle"][0]["thinking"] = CANARY
        choices["overlay"]["modelRoutes"]["gateway"]["auth"] = CANARY
        choices["overlay"]["paths"] = {"local": "/" + CANARY, "bad/key": CANARY}
        choices["overlay"]["extra"] = {CANARY: CANARY}
        choices["overlay"]["selection"]["enable"].append(CANARY + "/x")
        choices["manifest"]["components"]["codex-accounts"]["source"]["path"] = "packages/" + CANARY
        choices["manifest"]["components"]["core"]["source"]["spec"] = CANARY
        choices["manifest"]["components"]["core"]["metadata_note"] = CANARY
        choices["manifest"]["runtime"]["nodeRange"] = CANARY + "$"
        choices["registry"] = {CANARY: {CANARY: [CANARY]}}
        choices["registryDigest"] = CANARY
        choices["routes"] = {"setup": [{"instruction": CANARY}]}
        choices["requiredRoles"] = [CANARY]
        choices["credentialNames"] = [CANARY, "X_" + CANARY]
        choices["manifest"]["runtime"]["pythonRange"] = CANARY
        choices["manifest"]["runtime"]["piVersion"] = "1.0.0-" + CANARY
        choices["manifest"]["components"]["hermes"]["source"]["spec"] = "pi-hermes-memory@9.9.9-" + CANARY
        choices["manifest"]["components"]["promptr"]["source"]["path"] = [CANARY]
        choices["manifest"]["components"]["mcp"]["source"]["spec"] = CANARY.lower() + "@3.1.0"
        choices["roleStatus"]["review"] = CANARY
        choices["pendingPackages"] = [{"component": "promptr", "source": "git:https://x:" + CANARY + "@h.invalid/p.git@" + "a" * 40},
                                      {"component": CANARY + "!", "source": CANARY}]
        choices["hidden"] = CANARY
        hostile["settings.json"]["packages"].append({"source": "git:https://t:" + CANARY + "@h.invalid/a.git@" + "b" * 40, "extensions": [CANARY]})
        hostile["settings.json"]["packages"].append({"source": "git:https://" + CANARY + ".invalid/x.git@" + "c" * 40 + "#../" + CANARY})
        hostile["settings.json"]["packages"].append({"source": "npm:" + CANARY.lower() + "@1.0.0"})
        hostile["settings.json"]["enabledModels"] = [CANARY]
        state = hostile[".tenant-pi/state.json"]
        state["provenance"]["pins"]["core"] = CANARY
        state["provenance"]["outputs"] = [CANARY]
        state["provenance"]["enabled"] = [CANARY + "!"]
        state["note"] = CANARY
        report = compare(self.old, hostile)
        dump = json.dumps(report)
        self.assertNotIn(CANARY, dump)
        self.assertNotIn(CANARY.lower(), dump)
        self.assertNotIn("host.invalid", dump)
        statuses = {(u["file"], u["field"], u["status"]) for u in report["unsupported"]}
        self.assertIn((".tenant-pi/choices.json", "/overlay/extra", "unsupported_field"), statuses)
        self.assertIn((".tenant-pi/choices.json", "/hidden", "unsupported_field"), statuses)
        self.assertIn((".tenant-pi/choices.json", "/overlay/paths/<redacted>", "unsupported_field_name"), statuses)
        self.assertIn((".tenant-pi/choices.json", "/overlay/selection/enable/<redacted>", "unsupported_field_name"), statuses)
        self.assertIn((".tenant-pi/choices.json", "/pendingPackages/<redacted>", "unsupported_field_name"), statuses)
        self.assertIn((".tenant-pi/state.json", "/note", "unsupported_field"), statuses)
        values = {(c["file"], c["field"]): c.get("right") for c in report["changes"]}
        for key in (("settings.json", "/packages/1/source"), ("settings.json", "/packages/2/source"), ("settings.json", "/packages/3/source"),
                    (".tenant-pi/choices.json", "/manifest/components/core/source"), (".tenant-pi/choices.json", "/manifest/runtime/pythonRange"),
                    (".tenant-pi/choices.json", "/manifest/runtime/piVersion"), (".tenant-pi/choices.json", "/manifest/components/hermes/source"),
                    (".tenant-pi/choices.json", "/manifest/components/promptr/source"), (".tenant-pi/choices.json", "/manifest/components/mcp/source"),
                    (".tenant-pi/choices.json", "/manifest/components/codex-accounts/source"), (".tenant-pi/choices.json", "/manifest/runtime/nodeRange"),
                    (".tenant-pi/choices.json", "/requiredRoles"), (".tenant-pi/choices.json", "/credentialNames"),
                    (".tenant-pi/choices.json", "/roleStatus/review"), (".tenant-pi/choices.json", "/pendingPackages/promptr"),
                    (".tenant-pi/state.json", "/provenance/pins/core"), (".tenant-pi/state.json", "/provenance/outputs"),
                    (".tenant-pi/state.json", "/provenance/enabled"), (".tenant-pi/choices.json", "/overlay/modelRoutes/gateway/auth")):
            self.assertEqual({"status": "unsupported_value"}, values[key], key)
        for key in (("settings.json", "/enabledModels"), (".tenant-pi/choices.json", "/registry"),
                    (".tenant-pi/choices.json", "/registryDigest"), (".tenant-pi/choices.json", "/routes")):
            self.assertNotIn("right", {(c["file"], c["field"]): c for c in report["changes"]}[key])
        self.assertEqual("not_computable", report["right"]["drift"]["status"])
        self.assertNotIn(CANARY, report["right"]["drift"]["rule"])

    def memory_pair(self):
        """A candidate without a `memory` block, and one with both memory modules and private paths."""
        role = {"provider": "fake-native", "model": "team/slash-id", "thinking": "high"}
        block = {"schemaVersion": 1, "openviking": None,
                 "hermes": {"backgroundReview": True, "reviewTransport": "direct",
                            "childExtensionPaths": ["/srv/" + CANARY + "/ext", "builtin:llama.cpp"]},
                 "wiki": {"ambientPersonalVault": True, "backgroundTasks": False, "wikiHome": "/home/" + CANARY + "/vault"}}
        consent = {"memoryCapture": True, "remoteMemoryWrites": False, "telemetry": False}
        selection = {"enable": ["core", "hermes", "wiki"], "disable": []}
        with_block = overlay_for("/home/example/old", selection=selection, consent=consent, memory=block, roles={"memory": role})
        return self.old, candidate(with_block)

    def test_overlay_memory_block_is_reported_field_by_field(self):
        plain, memory = self.memory_pair()
        report = compare(plain, memory)
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertNotIn("builtin:llama.cpp", json.dumps(report))
        self.assertEqual([], [u for u in report["unsupported"] if u["field"].startswith("/overlay/memory")])
        at = "/overlay/memory/"
        changes = {c["field"]: c for c in report["changes"] if c["file"] == ".tenant-pi/choices.json" and c["field"].startswith(at)}
        # A switch, a closed name and the schema version carry a value; a path is a marker only.
        self.assertEqual({
            at + "schemaVersion": {"value": 1}, at + "openviking": {"value": "disabled"},
            at + "hermes/backgroundReview": {"value": True}, at + "hermes/reviewTransport": {"value": "direct"},
            at + "hermes/childExtensionPaths/0": None, at + "hermes/childExtensionPaths/1": None,
            at + "wiki/ambientPersonalVault": {"value": True}, at + "wiki/backgroundTasks": {"value": False},
            at + "wiki/wikiHome": None}, {field: c.get("right") for field, c in changes.items()})
        for c in changes.values():
            self.assertEqual(("added", False), (c["change"], "left" in c))
        # The activation record stays in the report as one marker.
        record = next(c for c in report["changes"] if c["field"] == "/memory")
        self.assertEqual({"file": ".tenant-pi/choices.json", "field": "/memory", "change": "changed"}, record)
        # Equal blocks are names under `unchanged`; a module set to `null` is a removed set of fields.
        self.assertIn({"file": ".tenant-pi/choices.json", "field": at + "wiki/wikiHome"}, compare(memory, copy.deepcopy(memory))["unchanged"])
        off = copy.deepcopy(memory)
        off[".tenant-pi/choices.json"]["overlay"]["memory"]["wiki"] = None
        report = compare(memory, off)
        self.assertNotIn(CANARY, json.dumps(report))
        self.assertEqual({at + "wiki": "added", at + "wiki/ambientPersonalVault": "removed", at + "wiki/backgroundTasks": "removed",
                          at + "wiki/wikiHome": "removed"},
                         {c["field"]: c["change"] for c in report["changes"] if c["field"].startswith(at)})

    def test_memory_field_policies_cover_every_module_field(self):
        from scripts.candidate_compare import ENUMS, MEMORY_POLICIES
        from scripts.memory_modules import MEMORY, MODULE_FIELDS, REVIEW_TRANSPORTS
        self.assertEqual(set(MEMORY), set(MODULE_FIELDS))
        self.assertEqual(set(MEMORY_POLICIES), {name for required, optional in MODULE_FIELDS.values() for name in (*required, *optional)})
        self.assertEqual(REVIEW_TRANSPORTS, ENUMS["transport"])

    def test_hostile_overlay_memory_shapes_never_leak_a_value(self):
        _, memory = self.memory_pair()
        at = "/overlay/memory"
        hostile = copy.deepcopy(memory)
        block = hostile[".tenant-pi/choices.json"]["overlay"]["memory"]
        block["schemaVersion"] = CANARY
        block["hermes"].update({"backgroundReview": CANARY, "reviewTransport": CANARY, "childExtensionPaths": {"0": "/" + CANARY},
                                "extra": CANARY, "bad key\n": CANARY})
        block["wiki"] = [CANARY]
        block["openviking"] = {"endpoint": CANARY}
        block["other"] = {"x": CANARY}
        report = compare(memory, hostile)
        dump = json.dumps(report)
        self.assertNotIn(CANARY, dump)
        self.assertNotIn("bad key", dump)
        statuses = {(u["field"], u["status"]) for u in report["unsupported"] if u["field"].startswith(at)}
        self.assertEqual({(at + "/hermes/childExtensionPaths", "unsupported_shape"), (at + "/hermes/extra", "unsupported_field"),
                          (at + "/hermes/<redacted>", "unsupported_field_name"), (at + "/wiki", "unsupported_shape"),
                          (at + "/openviking", "unsupported_shape"), (at + "/other", "unsupported_field")}, statuses)
        values = {c["field"]: c.get("right") for c in report["changes"]}
        for field in ("/schemaVersion", "/hermes/backgroundReview", "/hermes/reviewTransport"):
            self.assertEqual({"status": "unsupported_value"}, values[at + field], field)
        # A block that is not an object is one `unsupported_shape` entry.
        for value in (CANARY, [CANARY], 7, None):
            hostile[".tenant-pi/choices.json"]["overlay"]["memory"] = value
            report = compare(memory, hostile)
            self.assertNotIn(CANARY, json.dumps(report))
            self.assertIn({"file": ".tenant-pi/choices.json", "field": at, "side": "right", "status": "unsupported_shape"},
                          report["unsupported"])

    def test_older_metadata_without_a_memory_block_still_compares(self):
        plain, memory = self.memory_pair()
        # An older candidate: no overlay `memory` key, no `/memory` record, and a bare `state.json`.
        older = copy.deepcopy(plain)
        self.assertNotIn("memory", older[".tenant-pi/choices.json"]["overlay"])
        del older[".tenant-pi/choices.json"]["memory"]
        older[".tenant-pi/state.json"] = {"schemaVersion": 1, "status": "complete"}
        for left, right, change in ((older, memory, "added"), (memory, older, "removed")):
            report = compare(left, right)
            self.assertNotIn(CANARY, json.dumps(report))
            found = {c["field"]: c["change"] for c in report["changes"]
                     if c["field"] == "/memory" or c["field"].startswith("/overlay/memory/")}
            self.assertEqual({change}, set(found.values()))
            self.assertIn("/memory", found)
            self.assertIn("/overlay/memory/hermes/backgroundReview", found)
            self.assertEqual([], [u for u in report["unsupported"] if u["field"].startswith("/overlay/memory")])
        report = compare(older, copy.deepcopy(older))
        self.assertEqual({"added": 0, "removed": 0, "changed": 0}, {k: report["summary"][k] for k in ("added", "removed", "changed")})
        self.assertEqual([], [e for key in ("changes", "unchanged", "unsupported") for e in report[key]
                              if e["field"] == "/memory" or e["field"].startswith("/overlay/memory")])

    def test_settings_only_and_incomplete_metadata_sides(self):
        plain = {"settings.json": {"defaultProjectTrust": "ask", "theme": CANARY}, ".tenant-pi/choices.json": None,
                 ".tenant-pi/state.json": None}
        report = compare(plain, self.old)
        self.assertEqual({"kind": "settings_only", "state": None, "drift": None}, report["left"])
        self.assertEqual([{"file": "settings.json", "field": "/theme", "side": "left", "status": "unsupported_field"}], report["unsupported"])
        self.assertIn(("settings.json", "/enableAnalytics"), fields(report, "added"))
        self.assertIn((".tenant-pi/state.json", "/status"), fields(report, "added"))
        self.assertNotIn(CANARY, json.dumps(report))
        partial = copy.deepcopy(self.old)
        partial[".tenant-pi/state.json"] = None
        self.assertEqual({"kind": "incomplete_metadata", "state": None, "drift": None}, compare(partial, self.old)["left"])

    def test_malformed_shapes_and_unknown_schema_versions_stop_or_show(self):
        with self.assertRaises(Invalid) as caught:
            compare({"settings.json": None, ".tenant-pi/choices.json": None, ".tenant-pi/state.json": None}, self.old)
        self.assertEqual("settings_missing: left", str(caught.exception))
        with self.assertRaises(Invalid) as caught:
            compare(self.old, {"settings.json": [CANARY], ".tenant-pi/choices.json": None, ".tenant-pi/state.json": None})
        self.assertEqual("object: right.settings.json", str(caught.exception))
        for file, mutate, field in ((".tenant-pi/state.json", lambda f: f.update(schemaVersion=2), "state.schemaVersion"),
                                    (".tenant-pi/state.json", lambda f: f.pop("schemaVersion"), "state.schemaVersion"),
                                    (".tenant-pi/choices.json", lambda f: f["overlay"].update(schemaVersion="1"), "choices.overlay.schemaVersion"),
                                    (".tenant-pi/choices.json", lambda f: f["manifest"].update(schemaVersion=99), "choices.manifest.schemaVersion")):
            with self.subTest(field=field):
                broken = copy.deepcopy(self.old)
                mutate(broken[file])
                with self.assertRaises(Invalid) as caught:
                    compare(self.old, broken)
                self.assertEqual("unsupported_schema_version: right." + field, str(caught.exception))
        odd = copy.deepcopy(self.old)
        odd[".tenant-pi/choices.json"]["overlay"]["consent"] = [CANARY]
        odd[".tenant-pi/choices.json"]["overlay"]["roles"] = CANARY
        odd[".tenant-pi/choices.json"]["pendingPackages"] = CANARY
        odd["settings.json"]["packages"] = CANARY
        report = compare(self.old, odd)
        self.assertEqual({(".tenant-pi/choices.json", "/overlay/consent"), (".tenant-pi/choices.json", "/overlay/roles"),
                          (".tenant-pi/choices.json", "/pendingPackages"), ("settings.json", "/packages")},
                         {(u["file"], u["field"]) for u in report["unsupported"] if u["status"] == "unsupported_shape"})
        self.assertNotIn(CANARY, json.dumps(report))
        with self.assertRaises(Invalid):
            describe("left", {"settings.json": {}})

    def test_removed_module_and_missing_sections(self):
        report = compare(self.new, self.old)
        removed = {(c["file"], c["field"]): c for c in report["changes"] if c["change"] == "removed"}
        self.assertEqual({"value": "listed"}, removed[(".tenant-pi/choices.json", "/overlay/selection/enable/codex-accounts")]["left"])
        self.assertIn(("settings.json", "/packages/0/source"), removed)
        gutted = copy.deepcopy(self.old)
        for key in ("roles", "consent", "paths"):
            gutted[".tenant-pi/choices.json"]["overlay"].pop(key)
        gutted[".tenant-pi/choices.json"].pop("roleStatus")
        gutted[".tenant-pi/choices.json"].pop("pendingPackages")
        gutted[".tenant-pi/state.json"]["provenance"].pop("pins")
        report = compare(self.old, gutted)
        self.assertEqual({(".tenant-pi/choices.json", "/overlay/roles"), (".tenant-pi/choices.json", "/overlay/consent"),
                          (".tenant-pi/choices.json", "/overlay/paths"), (".tenant-pi/choices.json", "/roleStatus"),
                          (".tenant-pi/choices.json", "/pendingPackages"), (".tenant-pi/state.json", "/provenance/pins")},
                         {(u["file"], u["field"]) for u in report["unsupported"] if u["status"] == "missing_section"})
        self.assertEqual("not_computable", report["right"]["drift"]["status"])

    def test_generation_time_and_kit_commit_are_markers_not_changes(self):
        stamped = copy.deepcopy(self.old)
        stamped[".tenant-pi/state.json"]["provenance"].update(generatedAt="2026-10-01T00:00:00Z", kitCommit="a" * 40)
        later = copy.deepcopy(stamped)
        later[".tenant-pi/state.json"]["provenance"].update(generatedAt="2026-10-02T00:00:00Z", kitCommit="unknown")
        state = ".tenant-pi/state.json"
        # An older record without the two fields still compares: both fields are added markers.
        for left, right, expected in ((self.old, stamped, "added"), (stamped, self.old, "removed"), (stamped, later, "changed")):
            with self.subTest(expected=expected):
                report = compare(left, right)
                self.assertEqual([{"file": state, "field": "/provenance/generatedAt", "change": expected},
                                  {"file": state, "field": "/provenance/kitCommit", "change": expected}], report["markers"])
                self.assertEqual([], [c for c in report["changes"] if c["file"] == state])
                self.assertEqual((0, 0, 0, 2), tuple(report["summary"][k] for k in ("added", "removed", "changed", "markers")))
                self.assertEqual([], report["unsupported"])
                self.assertNotIn("2026-10", json.dumps(report))
                self.assertNotIn("a" * 40, json.dumps(report))
        report = compare(stamped, copy.deepcopy(stamped))
        self.assertEqual(([], 0), (report["markers"], report["summary"]["markers"]))
        self.assertIn({"file": state, "field": "/provenance/kitCommit"}, report["unchanged"])
        hostile = copy.deepcopy(stamped)
        hostile[state]["provenance"].update(generatedAt=CANARY, kitCommit={"nested": CANARY})
        report = compare(stamped, hostile)
        self.assertEqual(2, report["summary"]["markers"])
        self.assertNotIn(CANARY, json.dumps(report))

    def test_closed_public_sets_match_the_reviewed_manifest(self):
        manifest = load("config/manifest.json")
        self.assertEqual(DECLARED_ENV, {name for c in manifest["components"].values() for name in c["env"]})
        older = copy.deepcopy(self.old)
        older[".tenant-pi/state.json"]["provenance"]["pins"]["core"] = "npm:@earendil-works/pi-coding-agent@0.87.1"
        older[".tenant-pi/choices.json"]["manifest"]["components"]["mcp"]["source"]["spec"] = "pi-mcp-adapter@3.1.0"
        report = compare(older, self.old)
        changed = {(c["file"], c["field"]): c for c in report["changes"]}
        self.assertEqual({"value": "npm:@earendil-works/pi-coding-agent@0.87.1"}, changed[(".tenant-pi/state.json", "/provenance/pins/core")]["left"])
        self.assertEqual({"value": "npm:pi-mcp-adapter@3.1.0"},
                         changed[(".tenant-pi/choices.json", "/manifest/components/mcp/source")]["left"])
        self.assertEqual("tree:packages/tenantext", source_pin(manifest["components"]["codex-accounts"]["source"]))

    def test_source_pin_forms(self):
        self.assertIsNone(source_pin(None))
        self.assertEqual("builtin", source_pin({"kind": "builtin"}))
        self.assertEqual("npm:a@1.0.0", source_pin({"kind": "npm", "spec": "a@1.0.0"}))
        self.assertEqual("git:https://h.invalid/r.git@" + "a" * 40 + "#sub",
                         source_pin({"kind": "git", "url": "https://h.invalid/r.git", "commit": "a" * 40, "subdir": "sub"}))
        self.assertEqual("tree:packages/x", source_pin({"kind": "tree", "path": "packages/x"}))
        self.assertEqual("unsupported", source_pin({"kind": "tree", "path": ["x"]}))
        self.assertEqual("unsupported", source_pin({"kind": "local", "pathKey": "x"}))
        self.assertEqual("unsupported", source_pin({"kind": "git", "url": "https://h.invalid/r.git", "commit": "a" * 40, "subdir": ["x"]}))
        self.assertEqual("unsupported", source_pin({"kind": "npm", "spec": 5}))
        self.assertEqual("unsupported", source_pin("npm:x@1.0.0"))


if __name__ == "__main__":
    unittest.main()
