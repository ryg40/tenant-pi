"""Component checklist contract: manifest order, the fields, the three forms, and no write."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts import components, tenant_pi
from scripts.components import LOCKED, RECOMMENDED, parse_select, prerequisites, report, selection, text
from scripts.profile_plan import prepare
from scripts.validate import Invalid, load, manifest, overlay

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
MANIFEST = load(ROOT / "config/manifest.json")
KNOWN = manifest(MANIFEST)
EXAMPLE = ROOT / "config/config.example.json"
CANARY = "CANARY_SECRET"
MEMORY_BLOCKS = {"hermes": {"backgroundReview": False},
                 "wiki": {"ambientPersonalVault": False, "backgroundTasks": False},
                 "openviking": {"captureToolResults": False}}
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", "socket.connect", *PROCESS_EVENTS):
        EVENTS.append((event, args))


sys.addaudithook(_audit)


def dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def row(cid, enabled=None):
    return next(item for item in report(KNOWN, enabled)["components"] if item["id"] == cid)


def chosen_overlay(chosen):
    """The example overlay with the selection of `chosen`, and the consent and the `memory` block that it needs."""
    data = load(EXAMPLE)
    data["selection"] = selection(KNOWN, chosen)["selection"]
    active = [cid for cid in MEMORY_BLOCKS if cid in data["selection"]["enable"]]
    if active:
        data["consent"]["memoryCapture"] = True
        data["consent"]["remoteMemoryWrites"] = "openviking" in active
        data["memory"] = {"schemaVersion": 1, **{cid: copy.deepcopy(block) if cid in active else None
                                                 for cid, block in MEMORY_BLOCKS.items()}}
    return data


def rule(call, *args):
    try:
        call(*args)
    except Invalid as exc:
        return str(exc)
    return None


class ChecklistTests(unittest.TestCase):
    def test_count_and_order_are_the_manifest(self):
        result = report(KNOWN)
        self.assertEqual(27, len(MANIFEST["components"]))
        self.assertEqual(list(MANIFEST["components"]), [item["id"] for item in result["components"]])
        self.assertEqual(list(range(1, 28)), [item["number"] for item in result["components"]])
        self.assertEqual({"count", "marks", "components", "scope"}, set(result))
        self.assertEqual((27, "recommended"), (result["count"], result["marks"]))
        fields = {"number", "id", "kind", "status", "extensions", "skills", "requires", "prerequisites",
                  "recommended", "marked", "locked"}
        self.assertTrue(all(set(item) == fields for item in result["components"]))
        self.assertEqual(dump(result), dump(report(manifest(load(ROOT / "config/manifest.json")))))

    def test_fields_of_four_components(self):
        self.assertEqual({"number": 1, "id": "core", "kind": "npm", "status": "tested", "extensions": [], "skills": [],
                          "requires": [], "prerequisites": [], "recommended": True, "marked": True, "locked": True},
                         row("core"))
        skills = row("coordinator-skills")
        self.assertEqual((14, "tree", "unverified", [], ["core"], True, True, False),
                         tuple(skills[key] for key in ("number", "kind", "status", "extensions", "requires",
                                                       "recommended", "marked", "locked")))
        self.assertEqual(["grilling", "grill-me", "wayfinder", "research", "prototype", "domain-modeling", "to-spec",
                          "to-tickets", "pr", "show-me", "retro", "get-status", "writing-for-agents"], skills["skills"])
        self.assertEqual(["env:GITEA_TOKEN", "gap:host_tool_required"], skills["prerequisites"])
        self.assertEqual({"number": 7, "id": "ops-footer", "kind": "tree", "status": "unverified",
                          "extensions": ["ops-footer"], "skills": [], "requires": ["core", "context-meter"],
                          "prerequisites": [], "recommended": True, "marked": True, "locked": False}, row("ops-footer"))
        self.assertEqual({"number": 26, "id": "wiki", "kind": "npm", "status": "tested",
                          "extensions": ["llm-wiki"], "skills": [], "requires": ["core"],
                          "prerequisites": ["overlay:consent.memoryCapture", "overlay:memory.wiki",
                                            "gap:peer_override_required", "setup:pi install npm:@zosmaai/pi-llm-wiki",
                                            "setup:node scripts/patch_extension_peers.mjs"],
                          "recommended": True, "marked": True, "locked": False}, row("wiki"))

    def test_names_come_from_the_manifest_resources(self):
        self.assertEqual(4, len(row("knowledge-skills")["skills"]))
        self.assertEqual(["builtin", None], [row("model-routing")["kind"], None])
        for cid, component in KNOWN.items():
            with self.subTest(cid=cid):
                found = row(cid)
                self.assertEqual([Path(item).name for item in component["resources"]["skills"]], found["skills"])
                self.assertEqual(len(component["resources"]["extensions"]), len(found["extensions"]))
                self.assertFalse({"index", "index.ts", "src", "extensions", ""} & set(found["extensions"]))
        # A path with no directory of its own gives the package name.
        self.assertEqual({"promptr": ["promptr"], "mcp": ["pi-mcp-adapter"], "hermes": ["pi-hermes-memory"],
                          "questions": ["@juicesharp/rpiv-ask-user-question"], "openviking": ["openviking-pi"]},
                         {cid: row(cid)["extensions"] for cid in ("promptr", "mcp", "hermes", "questions", "openviking")})

    def test_recommended_set_is_in_the_manifest_and_closed(self):
        self.assertEqual(16, len(RECOMMENDED))
        self.assertEqual(len(set(RECOMMENDED)), len(RECOMMENDED))
        self.assertLessEqual(set(RECOMMENDED), set(KNOWN))
        self.assertLessEqual(set(LOCKED), set(RECOMMENDED))
        for cid in RECOMMENDED:
            with self.subTest(cid=cid):
                self.assertLessEqual(set(KNOWN[cid]["requires"]), set(RECOMMENDED))
        self.assertEqual([], selection(KNOWN, list(RECOMMENDED))["added"])
        self.assertEqual(set(RECOMMENDED), {item["id"] for item in report(KNOWN)["components"] if item["recommended"]})
        # The tracked example stays the smallest selection.
        self.assertEqual(["core"], load(EXAMPLE)["selection"]["enable"])

    def test_marks_of_an_overlay(self):
        result = report(KNOWN, components.overlay_enabled(load(EXAMPLE), KNOWN))
        self.assertEqual("overlay", result["marks"])
        self.assertEqual(["core"], [item["id"] for item in result["components"] if item["marked"]])
        self.assertEqual(16, sum(item["recommended"] for item in result["components"]))
        # A locked component stays marked.
        self.assertTrue(row("core", [])["marked"])
        for data, expected in (([], "required_fields: overlay.selection"), ({"selection": {}}, "required_fields: overlay.selection"),
                               ({"selection": {"enable": "core"}}, "array: overlay.selection.enable"),
                               ({"selection": {"enable": ["core", "core"]}}, "duplicate_id: overlay.selection.enable"),
                               ({"selection": {"enable": [CANARY]}}, "component_id: overlay.selection.enable"),
                               ({"selection": {"enable": ["absent-id"]}}, "undeclared_component: overlay.selection")):
            self.assertEqual(expected, rule(components.overlay_enabled, data, KNOWN))


class PrerequisiteTests(unittest.TestCase):
    """Each code is a fact of the validator or of the plan."""

    def test_overlay_codes_are_what_validate_needs(self):
        for cid, codes in (("hermes", ["overlay:consent.memoryCapture", "overlay:memory.hermes"]),
                           ("wiki", ["overlay:consent.memoryCapture", "overlay:memory.wiki"]),
                           ("openviking", ["overlay:consent.memoryCapture", "overlay:consent.remoteMemoryWrites",
                                           "overlay:memory.openviking"])):
            with self.subTest(cid=cid):
                self.assertEqual(codes, [code for code in row(cid)["prerequisites"] if code.startswith("overlay:")])
                data = chosen_overlay([cid])
                overlay(data, KNOWN)
                for code in codes:
                    broken = copy.deepcopy(data)
                    section, key = code.split(":", 1)[1].split(".")
                    if section == "consent":
                        broken[section][key] = False
                    else:
                        broken[section][key] = None
                    self.assertIsNotNone(rule(overlay, broken, KNOWN), code)
        self.assertEqual(["overlay:inputs.mcpFile", "setup:pi install npm:pi-mcp-adapter"], row("mcp")["prerequisites"])
        data = chosen_overlay(["mcp"])
        self.assertEqual("mcp_input_required: overlay.inputs.mcpFile", rule(overlay, data, KNOWN))
        data["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
        overlay(data, KNOWN)

    def test_env_and_gap_codes_are_the_manifest(self):
        for cid, component in KNOWN.items():
            with self.subTest(cid=cid):
                codes = prerequisites(cid, component)
                self.assertEqual(component["env"], [code[4:] for code in codes if code.startswith("env:")])
                required = [gap["code"] for gap in component.get("gaps", []) if gap["code"].endswith("_required")]
                self.assertEqual(required, [code[4:] for code in codes if code.startswith("gap:")
                                            and code[4:] not in components.MEMORY_PLAN_GAPS.get(cid, ())])
                self.assertEqual(len(set(codes)), len(codes))
        self.assertEqual([], row("core")["prerequisites"])
        self.assertEqual(["env:TENANTEXT_LITELLM_BASE_URL", "env:TENANTEXT_LITELLM_API_KEY"],
                         row("codex-accounts")["prerequisites"])
        self.assertEqual(["gap:build_step_required"], row("promptr")["prerequisites"])
        self.assertIn("gap:install_step_required", row("openviking")["prerequisites"])
        self.assertIn("gap:native_addon_unverified", row("hermes")["prerequisites"])

    def test_setup_and_plan_gap_codes_are_the_plan(self):
        base = prepare(MANIFEST, load(EXAMPLE))
        for cid in ("hermes", "wiki", "openviking", "questions", "mcp", "ops-footer", "promptr"):
            with self.subTest(cid=cid):
                data = chosen_overlay([cid])
                extra = {}
                if cid == "mcp":
                    data["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
                    extra["mcp_definitions"] = {"mcpServers": {}}
                plan = prepare(MANIFEST, data, **extra)
                # The plan prints the absolute package path of this clone; the code holds the kit-relative path.
                added = [line.replace(str(ROOT) + "/", "") for line in plan["commands"]["setup"]
                         if line not in base["commands"]["setup"]]
                steps = [code[6:] for code in row(cid)["prerequisites"] if code.startswith("setup:")]
                self.assertEqual(len(added), len(steps), added)
                for line, step in zip(added, steps):
                    self.assertTrue((" " + line).endswith(" " + step), (line, step))
                gaps = {gap["code"] for gap in plan["readinessGaps"]}
                for code in row(cid)["prerequisites"]:
                    if code.startswith("gap:"):
                        self.assertIn(code[4:], gaps)
        peer = "node scripts/patch_extension_peers.mjs"
        self.assertEqual({"mcp": ["pi install npm:pi-mcp-adapter"],
                          "questions": ["pi install npm:@juicesharp/rpiv-ask-user-question@2.11.0", peer],
                          "hermes": ["pi install npm:pi-hermes-memory", peer],
                          "wiki": ["pi install npm:@zosmaai/pi-llm-wiki", peer],
                          "openviking": ["npm --prefix packages/openviking-pi ci --ignore-scripts"]},
                         {cid: [code[6:] for code in row(cid)["prerequisites"] if code.startswith("setup:")]
                          for cid in ("mcp", "questions", "hermes", "wiki", "openviking")})


class TextTests(unittest.TestCase):
    def test_one_line_for_each_component_and_the_answer_line(self):
        output = text(report(KNOWN))
        self.assertEqual(output, text(report(KNOWN)))
        self.assertTrue(output.endswith("\n") and not output.endswith("\n\n"))
        lines = output.splitlines()
        self.assertEqual(28, len(lines))
        self.assertEqual(components.ANSWER, lines[-1])
        self.assertIn("`ok`", lines[-1])
        for number, (line, cid) in enumerate(zip(lines, KNOWN), 1):
            with self.subTest(cid=cid):
                mark = "[x]" if cid in RECOMMENDED else "[ ]"
                self.assertTrue(line.startswith(f"{number:>2} {mark} {cid}"), line)
                self.assertIn(" | " + KNOWN[cid]["status"], line)
                for name in row(cid)["extensions"] + row(cid)["skills"]:
                    self.assertIn(name, line)
                for needed in KNOWN[cid]["requires"]:
                    if needed not in LOCKED:
                        self.assertIn(needed, line.split("requires: ", 1)[1])
        self.assertEqual(16, sum("[x]" in line for line in lines[:27]))
        self.assertEqual(" 1 [x] core (locked) | tested", lines[0])
        self.assertEqual(" 7 [x] ops-footer | extension: ops-footer | unverified | requires: context-meter", lines[6])
        self.assertEqual(13, lines[13].split("skills: ", 1)[1].split(" | ")[0].count(",") + 1)
        self.assertEqual(4, lines[14].split("skills: ", 1)[1].split(" | ")[0].count(",") + 1)
        self.assertEqual("26 [x] wiki | extension: llm-wiki | tested | needs: consent.memoryCapture, "
                         "memory.wiki, peer_override_required, 2 setup lines", lines[25])
        self.assertTrue(output.isascii())

    def test_marks_follow_an_overlay(self):
        lines = text(report(KNOWN, ["core", "herdr"])).splitlines()
        self.assertEqual([1, 12], [number for number, line in enumerate(lines[:27], 1) if "[x]" in line])


class SelectionTests(unittest.TestCase):
    def test_closure_adds_the_required_ids(self):
        result = selection(KNOWN, parse_select("ops-footer", KNOWN))
        self.assertEqual({"selection", "added", "prerequisites", "scope"}, set(result))
        self.assertEqual(["core", "context-meter", "ops-footer"], result["selection"]["enable"])
        self.assertEqual(["context-meter"], result["added"])
        self.assertEqual(sorted(set(KNOWN) - {"core", "context-meter", "ops-footer"}), result["selection"]["disable"])
        relay = selection(KNOWN, parse_select("herdr-relay", KNOWN))
        self.assertEqual((["core", "herdr", "herdr-relay"], ["herdr"]), (relay["selection"]["enable"], relay["added"]))
        self.assertEqual({"herdr": ["gap:host_tool_required"], "herdr-relay": ["gap:host_tool_required"]},
                         relay["prerequisites"])
        skill = selection(KNOWN, ["promptr-handoff"])
        self.assertEqual((["promptr"], {"promptr": ["gap:build_step_required"]}), (skill["added"], skill["prerequisites"]))
        self.assertEqual((["core"], []), (selection(KNOWN, ["core"])["selection"]["enable"], selection(KNOWN, [])["added"]))

    def test_numbers_and_ids_name_the_same_components(self):
        self.assertEqual(["ops-footer", "herdr-relay"], parse_select("7,13", KNOWN))
        self.assertEqual(["ops-footer", "herdr-relay", "wiki"], parse_select(" 7 , herdr-relay,26,ops-footer,7", KNOWN))
        self.assertEqual(dump(selection(KNOWN, parse_select("7,13", KNOWN))),
                         dump(selection(KNOWN, parse_select("herdr-relay,ops-footer", KNOWN))))
        self.assertEqual(list(KNOWN), parse_select(",".join(str(number) for number in range(1, 28)), KNOWN))

    def test_unknown_id_or_number_is_refused_without_its_value(self):
        for value in ("nope", "0", "28", "7,,13", "", "7;13", "-1", "1.5", "9999999", "٧", CANARY, "core," + CANARY):
            with self.subTest(value=value):
                self.assertEqual("undeclared_component: components.select", rule(parse_select, value, KNOWN))

    def test_blocked_component_is_refused(self):
        known = copy.deepcopy(KNOWN)
        known["herdr"]["status"] = "blocked"
        self.assertEqual("blocked_component: components.select", rule(selection, known, ["herdr-relay"]))

    def test_each_selection_passes_the_selection_rules_of_validate(self):
        for chosen in (list(RECOMMENDED), ["ops-footer"], ["herdr-relay"], ["promptr-handoff", "tracker-site"], []):
            with self.subTest(chosen=chosen):
                data = chosen_overlay(chosen)
                self.assertEqual(set(KNOWN), set(data["selection"]["enable"]) | set(data["selection"]["disable"]))
                overlay(data, KNOWN)

    def test_recommended_selection_validates_with_consent_and_memory(self):
        result = selection(KNOWN, list(RECOMMENDED))
        self.assertEqual(["core", *sorted(set(RECOMMENDED) - {"core"})], result["selection"]["enable"])
        self.assertEqual(11, len(result["selection"]["disable"]))
        self.assertEqual({"codex-accounts", "doctor", "coordinator-skills", "knowledge-skills", "slopscore-pr",
                          "hermes", "wiki"}, set(result["prerequisites"]))
        data = load(EXAMPLE)
        data["selection"] = result["selection"]
        # The selection alone is not valid: the two memory modules need the consent and the block.
        self.assertEqual("memory_choices_required: overlay.memory", rule(overlay, data, KNOWN))
        data["memory"] = {"schemaVersion": 1, "hermes": {"backgroundReview": False},
                          "wiki": {"ambientPersonalVault": False, "backgroundTasks": False}, "openviking": None}
        self.assertEqual("memory_consent_required: overlay.consent.memoryCapture", rule(overlay, data, KNOWN))
        data["consent"]["memoryCapture"] = True
        overlay(data, KNOWN)
        prepare(MANIFEST, data)


class ComponentsCliTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-components-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        hook = self.base / "sitecustomize.py"
        hook.write_text("import sys\nsys.dont_write_bytecode = True\nimport socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
        self.env = dict(os.environ, HOME=str(self.base), PYTHONPATH=str(self.base), PYTHONDONTWRITEBYTECODE="1")

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(CLI), "components", *args], cwd=self.base, env=self.env, text=True,
                              capture_output=True, check=False)

    def test_three_forms_are_deterministic_and_write_nothing(self):
        before = sorted(path.name for path in self.base.iterdir())
        for args in ((), ("--format", "text"), ("--overlay", str(EXAMPLE)), ("--overlay", str(EXAMPLE), "--format", "text"),
                     ("--select", ",".join(RECOMMENDED)), ("--select", "7,13")):
            with self.subTest(args=args):
                runs = [self.run_cli(*args) for _ in range(2)]
                self.assertEqual([0, 0, ""], [runs[0].returncode, runs[1].returncode, runs[0].stderr], runs[0].stderr)
                self.assertEqual(runs[0].stdout, runs[1].stdout)
                self.assertTrue(runs[0].stdout.endswith("\n"))
        self.assertEqual(before, sorted(path.name for path in self.base.iterdir()))
        data = json.loads(self.run_cli().stdout)
        self.assertEqual(self.run_cli().stdout.strip(), dump(data))
        self.assertEqual(dump(report(KNOWN)), dump(data))
        self.assertEqual(text(report(KNOWN)), self.run_cli("--format", "text").stdout)
        marked = json.loads(self.run_cli("--overlay", str(EXAMPLE)).stdout)
        self.assertEqual(("overlay", ["core"]), (marked["marks"], [item["id"] for item in marked["components"] if item["marked"]]))
        self.assertEqual(1, self.run_cli("--overlay", str(EXAMPLE), "--format", "text").stdout.count("[x]"))
        chosen = json.loads(self.run_cli("--select", "7,13").stdout)
        self.assertEqual((["core", "context-meter", "herdr", "herdr-relay", "ops-footer"], ["context-meter", "herdr"]),
                         (chosen["selection"]["enable"], chosen["added"]))
        self.assertEqual(dump(selection(KNOWN, list(RECOMMENDED))), self.run_cli("--select", ",".join(RECOMMENDED)).stdout.strip())

    def test_errors_use_the_error_form_of_the_kit(self):
        (self.base / "bad.json").write_text('{"selection": "' + CANARY)
        (self.base / "other.json").write_text(json.dumps({"selection": {"enable": ["core", "absent-id"]}}))
        for args, error in ((("--select", "nope"), "undeclared_component: components.select"),
                            (("--select", "28"), "undeclared_component: components.select"),
                            (("--select", CANARY), "undeclared_component: components.select"),
                            (("--select", "7", "--format", "text"), "option_conflict: components.select"),
                            (("--select", "7", "--overlay", str(EXAMPLE)), "option_conflict: components.select"),
                            (("--overlay", str(self.base / "absent.json")), "input_missing: overlay.file"),
                            (("--overlay", str(self.base / "bad.json")), "invalid_json: overlay.file"),
                            (("--overlay", str(self.base / "other.json")), "undeclared_component: overlay.selection"),
                            (("--manifest", str(EXAMPLE)), "unknown_fields: manifest")):
            with self.subTest(args=args):
                result = self.run_cli(*args)
                self.assertEqual((2, ""), (result.returncode, result.stdout))
                found = json.loads(result.stderr)
                self.assertEqual((error, False), (found["error"], found["candidate_created"]))
                self.assertNotIn(CANARY, result.stderr)
        help_text = subprocess.run([sys.executable, str(CLI), "--help"], cwd=self.base, env=self.env, text=True,
                                   capture_output=True, check=False).stdout
        self.assertIn("components", help_text)

    def test_action_opens_only_its_inputs_for_reading(self):
        del EVENTS[:]
        RECORDING.append(True)
        try:
            for argv in (["components"], ["components", "--format", "text"], ["components", "--overlay", str(EXAMPLE)],
                         ["components", "--select", "7,13"]):
                with open(os.devnull, "w") as sink:
                    stdout, sys.stdout = sys.stdout, sink
                    try:
                        self.assertEqual(0, tenant_pi.main(argv))
                    finally:
                        sys.stdout = stdout
        finally:
            del RECORDING[:]
        self.assertEqual([], [event for event, _ in EVENTS if event in (*PROCESS_EVENTS, "socket.connect")])
        opened = [args for event, args in EVENTS if event == "open" and args[0] != os.devnull]
        # `open(path, mode, flags)`: no flag of a write, a creation or a truncation.
        writing = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
        self.assertEqual([], [args[0] for args in opened if type(args[2]) is int and args[2] & writing])
        self.assertEqual(4, [args[0] for args in opened].count("manifest.json"))
        self.assertEqual(1, [args[0] for args in opened].count("config.example.json"))


if __name__ == "__main__":
    unittest.main()
