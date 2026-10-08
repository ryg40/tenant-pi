"""The results file of an install: its facts schema, its fixed text, its one write and every refusal."""
import copy
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import install_results as results
from scripts import tenant_pi
from scripts.components import names as checklist_names
from scripts.install_results import HEADINGS, MAX_ITEMS, MAX_TEXT, NAME, TEMPORARY, candidate, components, facts, npm_names, render
from scripts.profile_write import WriteError
from scripts.validate import Invalid, load, manifest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
KNOWN = manifest(load(ROOT / "config/manifest.json"))
COMMIT = "0" * 40
CLONE = "/home/EXAMPLE_USER/tenant-pi"
PRIVATE = "/home/EXAMPLE_USER/.config/tenant-pi"
MAIN = "/home/EXAMPLE_USER/.pi/profiles/main"
SECOND = "/home/EXAMPLE_USER/.pi/profiles/second"
# Secret forms, built from parts: this file is in the publish set and holds no such text.
SECRETS = ("sk" + "-" + "A1b2" * 6, "pass" + "word: " + "Zx9" * 7, "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
           "Authorization Bear" + "er " + "Qw3e" * 6, "ey" + "J" + "abcDEF123456" + "." + "abcDEF123456",
           "AK" + "IA" + "A1B2" * 4, "np" + "m_" + "a1B2" * 9, "h" + "f_" + "a1B2" * 8, "AI" + "za" + "a1B2_-x" * 5)


def overlay_data(target=MAIN):
    data = load(ROOT / "config/config.example.json")
    data["target"]["agentDir"] = target
    data["selection"] = {"enable": ["core", "model-routing", "context-meter", "ops-footer", "herdr", "hermes"],
                         "disable": ["wiki", "questions"]}
    data["roles"] = {"interactive": {"provider": "example-provider", "model": "example-model", "thinking": "high"}}
    data["consent"]["memoryCapture"] = True
    data["memory"] = {"schemaVersion": 1, "hermes": {"backgroundReview": False}, "wiki": None, "openviking": None}
    return data


def facts_data(**changes):
    data = {
        "schemaVersion": 1, "date": "2030-01-01", "installingAgent": "EXAMPLE_AGENT", "status": "complete",
        "lastStage": "Stage 9: first launch and checks", "nextStep": None,
        "account": {"name": "EXAMPLE_USER", "createdByInstall": True, "openShell": "sudo -iu EXAMPLE_USER"},
        "places": {"node": "24.0.0", "pi": "1.1.0", "launchers": [{"target": MAIN, "path": PRIVATE + "/launch-main.sh"}]},
        "stages": [{"stage": "Stage 0: inventory", "state": "done", "note": None},
                   {"stage": "Stage 4a: Herdr and the question tool", "state": "not_applicable", "note": "Not selected."},
                   {"stage": "Stage 9: first launch and checks", "state": "done", "note": None}],
        "checks": [{"name": "Check 1: the login", "state": "not_run", "note": "The user logs in."},
                   {"name": "Check 3: the model reply", "state": "not_run", "note": None},
                   {"name": "Check 4: the comparison with the baseline", "state": "passed", "note": None}],
        "wikiVault": {"path": None, "existedBefore": False, "kept": False},
        "notes": ["The account has no password."],
    }
    data.update(changes)
    return data


def row(directory=MAIN, launcher=PRIVATE + "/launch-main.sh", **changes):
    state = {"schemaVersion": 1, "status": "complete",
             "provenance": {"kitSchemaVersion": 1, "piVersion": "1.1.0", "generatedAt": "2030-01-01T12:00:00Z"}}
    values = {"present": True, "state": state, "installed": {"pi-hermes-memory": True}, "launcher": launcher,
              "launcher_present": None if launcher is None else True, **changes}
    return candidate(directory, values["present"], values["state"], values["installed"], values.get("error", False),
                     values["launcher"], values["launcher_present"])


def text(data=None, candidates=None, overlay=True, targets=(MAIN,)):
    data = facts(facts_data() if data is None else data, list(targets))
    return render(commit=COMMIT, kit_root=CLONE, overlay_path=PRIVATE + "/overlay.json" if overlay else None,
                  overlay=overlay_data() if overlay else None, known=KNOWN, facts=data,
                  candidates=[row()] if candidates is None else candidates)


def frontmatter(value):
    lines = value.split("\n")
    assert lines[0] == "---"
    return lines[1:lines.index("---", 1)]


def section(value, heading):
    start = value.index("## " + heading + "\n")
    end = value.find("\n## ", start)
    return value[start:] if end < 0 else value[start:end]


class FactsTests(unittest.TestCase):
    def rule(self, data, targets=(MAIN,)):
        with self.assertRaises(Invalid) as caught:
            facts(data, list(targets))
        return str(caught.exception)

    def test_the_example_is_valid_and_returned_unchanged(self):
        data = facts_data()
        self.assertIs(data, facts(data, [MAIN]))

    def test_an_unknown_key_is_refused_at_each_level(self):
        self.assertEqual("unknown_fields: facts", self.rule(facts_data(extra=1)))
        for key, at in (("account", "facts.account"), ("places", "facts.places"), ("wikiVault", "facts.wikiVault")):
            data = facts_data()
            data[key]["extra"] = 1
            self.assertEqual("unknown_fields: " + at, self.rule(data))
        for key in ("stages", "checks"):
            data = facts_data()
            data[key][0]["extra"] = 1
            self.assertEqual("unknown_fields: facts." + key, self.rule(data))
        data = facts_data()
        data["places"]["launchers"][0]["extra"] = 1
        self.assertEqual("unknown_fields: facts.places.launchers", self.rule(data))

    def test_a_missing_key_is_refused(self):
        data = facts_data()
        del data["notes"]
        self.assertEqual("required_fields: facts", self.rule(data))

    def test_each_closed_value_is_checked(self):
        for change, expected in (
                ({"schemaVersion": 2}, "schema_version: facts.schemaVersion"),
                ({"schemaVersion": True}, "schema_version: facts.schemaVersion"),
                ({"date": "2030-02-30"}, "date: facts.date"),
                ({"date": "2030-1-1"}, "date: facts.date"),
                ({"status": "done"}, "status: facts.status"),
                ({"status": "stopped"}, "next_step_required: facts.nextStep"),
                ({"notes": "one"}, "array: facts.notes"),
                ({"notes": ["x"] * (MAX_ITEMS + 1)}, "too_many_items: facts.notes"),
                ({"stages": [{"stage": "a", "state": "passed", "note": None}]}, "state: facts.stages.state"),
                ({"checks": [{"name": "a", "state": "done", "note": None}]}, "state: facts.checks.state"),
                ({"checks": [{"name": "a", "state": "passed", "note": None}] * 2}, "duplicate_name: facts.checks"),
                ({"account": {"name": "bad name", "createdByInstall": True, "openShell": "x"}},
                 "account_name: facts.account.name"),
                ({"account": {"name": "EXAMPLE_USER", "createdByInstall": "yes", "openShell": "x"}},
                 "boolean: facts.account.createdByInstall"),
                ({"wikiVault": {"path": None, "existedBefore": True, "kept": False}}, "wiki_vault: facts.wikiVault"),
                ({"wikiVault": {"path": "/home/EXAMPLE_USER/.llm-wiki", "existedBefore": False, "kept": True}},
                 "wiki_vault: facts.wikiVault"),
                ({"wikiVault": {"path": "relative", "existedBefore": False, "kept": False}},
                 "absolute_path: facts.wikiVault.path"),
                ({"places": {"clone": "relative"}}, "absolute_path: facts.places.clone"),
                ({"places": {"launchers": [{"target": SECOND, "path": PRIVATE + "/x.sh"}]}},
                 "launcher_target: facts.places.launchers.target"),
                ({"places": {"launchers": [{"target": MAIN, "path": PRIVATE + "/x.sh"}] * 2}},
                 "duplicate_target: facts.places.launchers")):
            with self.subTest(expected=expected):
                self.assertEqual(expected, self.rule(facts_data(**change)))

    def test_a_free_text_is_one_short_line(self):
        for value, expected in (("two\nlines", "line_break"), ("two\rlines", "line_break"), ("a b", "line_break"),
                                ("tab\there", "text"), ("code `span`", "text"), ("", "text"), (" edge", "text"),
                                (7, "text"), ("x" * (MAX_TEXT + 1), "text_too_long")):
            with self.subTest(value=value):
                self.assertEqual(expected + ": facts.notes", self.rule(facts_data(notes=[value])))
                self.assertEqual(expected + ": facts.installingAgent", self.rule(facts_data(installingAgent=value)))
        self.assertEqual("x" * MAX_TEXT, facts(facts_data(notes=["x" * MAX_TEXT]), [MAIN])["notes"][0])

    def test_a_secret_form_is_refused_in_each_free_text_and_never_echoed(self):
        for secret in SECRETS:
            for change, at in (({"notes": ["Key: " + secret]}, "facts.notes"), ({"nextStep": secret}, "facts.nextStep"),
                               ({"lastStage": secret}, "facts.lastStage"),
                               ({"places": {"pi": secret}}, "facts.places.pi"),
                               ({"stages": [{"stage": "a", "state": "done", "note": secret}]}, "facts.stages.note"),
                               ({"checks": [{"name": secret, "state": "passed", "note": None}]}, "facts.checks.name")):
                with self.subTest(at=at):
                    message = self.rule(facts_data(**change))
                    self.assertEqual("secret_like: " + at, message)
                    self.assertNotIn(secret, message)
        data = facts_data()
        data["account"]["openShell"] = SECRETS[0]
        self.assertEqual("secret_like: facts.account.openShell", self.rule(data))
        # The name of a credential variable and a commit are not a secret form.
        facts(facts_data(notes=["Export TENANTEXT_LITELLM_API_KEY in the shell.", "Kit commit " + "a" * 40]), [MAIN])


class RowTests(unittest.TestCase):
    def test_components_have_the_names_of_their_extensions_and_skills(self):
        on, off = components(KNOWN, {"core", "ops-footer", "herdr"})
        self.assertEqual([{"id": "core", "extensions": [], "skills": []},
                          {"id": "ops-footer", "extensions": ["ops-footer"], "skills": []},
                          {"id": "herdr", "extensions": [], "skills": ["herdr"]}], on)
        names = {item["id"]: item for item in off}
        self.assertEqual(set(KNOWN) - {"core", "ops-footer", "herdr"}, set(names))
        # An entry file names its package.
        self.assertEqual(["promptr"], names["promptr"]["extensions"])
        self.assertEqual(["pi-hermes-memory"], names["hermes"]["extensions"])
        # An entry file in a directory of its own has the name of that directory.
        self.assertEqual(["llm-wiki"], names["wiki"]["extensions"])
        self.assertEqual(["@juicesharp/rpiv-ask-user-question"], names["questions"]["extensions"])
        self.assertIn("grilling", names["coordinator-skills"]["skills"])
        self.assertEqual([item["id"] for item in on + off], [cid for cid in KNOWN if cid in ("core", "ops-footer", "herdr")]
                         + [cid for cid in KNOWN if cid not in ("core", "ops-footer", "herdr")])
        # The `components` action gives the same names for each component of the manifest.
        for item in on + off:
            self.assertEqual(checklist_names(item["id"], KNOWN[item["id"]]), (item["extensions"], item["skills"]))

    def test_npm_names_of_a_settings_file(self):
        settings = {"packages": ["npm:pi-hermes-memory", {"source": "npm:@juicesharp/rpiv-ask-user-question@2.11.0"},
                                 "/home/EXAMPLE_USER/tenant-pi/packages/tenantext", "npm:pi-hermes-memory",
                                 "npm:BAD NAME", 7, {"source": 7}]}
        self.assertEqual(["pi-hermes-memory", "@juicesharp/rpiv-ask-user-question"], npm_names(settings))
        for other in (None, [], {"packages": "x"}, {}):
            self.assertEqual([], npm_names(other))

    def test_each_candidate_state(self):
        self.assertEqual({"directory": MAIN, "state": "complete", "piVersion": "1.1.0", "generatedAt": "2030-01-01T12:00:00Z",
                          "packages": [{"name": "pi-hermes-memory", "installed": True}],
                          "launcher": PRIVATE + "/launch-main.sh", "launcherPresent": True}, row())
        incomplete = {"schemaVersion": 1, "status": "incomplete"}
        for changes, expected in (({"state": incomplete}, "incomplete"), ({"state": None}, "unmanaged"),
                                  ({"present": False, "state": None}, "absent"), ({"state": []}, "invalid"),
                                  ({"state": {"schemaVersion": 2}}, "invalid"), ({"error": True}, "invalid"),
                                  ({"state": {"schemaVersion": 1, "status": "CANARY"}}, "invalid")):
            with self.subTest(expected=expected):
                found = row(**changes)
                self.assertEqual(expected, found["state"])
                self.assertNotIn("CANARY", json.dumps(found))
        # A value of the record that has no public form does not reach the row.
        hostile = {"schemaVersion": 1, "status": "complete", "provenance": {"piVersion": "CANARY", "generatedAt": "CANARY"}}
        self.assertEqual((None, None), (row(state=hostile)["piVersion"], row(state=hostile)["generatedAt"]))


class RenderTests(unittest.TestCase):
    def test_the_same_input_gives_the_same_text(self):
        self.assertEqual(text(), text())
        self.assertTrue(text().endswith("\n"))
        self.assertFalse(text().endswith("\n\n"))

    def test_the_key_order_of_the_overlay_does_not_change_the_text(self):
        first = overlay_data()
        first["memory"]["wiki"] = {"ambientPersonalVault": True, "backgroundTasks": False}
        second = copy.deepcopy(first)
        second["consent"] = dict(reversed(list(first["consent"].items())))
        second["memory"] = {key: dict(reversed(list(value.items()))) if type(value) is dict else value
                            for key, value in reversed(list(first["memory"].items()))}
        self.assertNotEqual(list(first["consent"]), list(second["consent"]))
        self.assertNotEqual(list(first["memory"]["wiki"]), list(second["memory"]["wiki"]))
        found = [render(commit=COMMIT, kit_root=CLONE, overlay_path=PRIVATE + "/overlay.json", overlay=data, known=KNOWN,
                        facts=facts(facts_data(), [MAIN]), candidates=[row()]) for data in (first, second)]
        self.assertEqual(found[0], found[1])
        self.assertIn("- `memory.wiki`: `ambientPersonalVault` true, `backgroundTasks` false\n", found[1])
        keys = [line.split("`")[1] for line in section(found[1], HEADINGS[5]).split("\n") if line.startswith("- `consent.")]
        self.assertEqual(sorted("consent." + key for key in first["consent"]), keys)

    def test_the_text_does_not_promise_a_file_without_a_credential(self):
        value = text()
        self.assertIn("The kit adds no credential value from the overlay. Do not write a credential value in the facts file.\n",
                      value)
        self.assertNotIn("holds no credential", value)

    def test_frontmatter_of_a_complete_install_with_one_candidate(self):
        self.assertEqual([
            'title: "Results of the installer kit"', 'date: "2030-01-01"', 'kitCommit: "' + COMMIT + '"',
            'installingAgent: "EXAMPLE_AGENT"', 'status: "complete"', 'lastStage: "Stage 9: first launch and checks"',
            'account: "EXAMPLE_USER"', "accountCreatedByInstall: true", 'clone: "' + CLONE + '"',
            'privateDirectory: "' + PRIVATE + '"', 'overlay: "' + PRIVATE + '/overlay.json"', "candidates:",
            '  - directory: "' + MAIN + '"', '    state: "complete"', '    launcher: "' + PRIVATE + '/launch-main.sh"',
            'pi: "1.1.0"', 'node: "24.0.0"',
            'componentsOn: ["core", "model-routing", "context-meter", "ops-footer", "herdr", "hermes"]',
            "componentsOff: [" + ", ".join('"' + cid + '"' for cid in KNOWN if cid not in overlay_data()["selection"]["enable"]) + "]",
        ], frontmatter(text()))

    def test_a_quote_and_a_backslash_are_escaped_in_the_frontmatter(self):
        found = frontmatter(text(facts_data(installingAgent='The "agent" \\ one')))
        self.assertIn('installingAgent: "The \\"agent\\" \\\\ one"', found)

    def test_each_section_heading_in_order(self):
        value = text()
        headings = [line[3:] for line in value.split("\n") if line.startswith("## ")]
        self.assertEqual(list(HEADINGS), headings)
        self.assertEqual(9, len(headings))
        self.assertEqual(1, sum(line.startswith("# ") for line in value.split("\n")))

    def test_a_complete_install_with_one_candidate(self):
        value = text()
        first = section(value, HEADINGS[0])
        self.assertIn("The install is complete. The last stage is: Stage 9: first launch and checks", first)
        self.assertIn("| Stage 4a: Herdr and the question tool | not applicable | Not selected. |", first)
        self.assertIn("- The account has no password.", first)
        self.assertNotIn("The next step is", first)
        start = section(value, HEADINGS[2])
        self.assertIn("This launcher starts Pi with the candidate `" + MAIN + "`:\n\n```sh\n" + PRIVATE + "/launch-main.sh\n```", start)
        self.assertIn("\nWarning: A `pi` command without the launcher opens the live directory `~/.pi/agent`. "
                      "It does not open the generated profile.", start)
        where = section(value, HEADINGS[3])
        for line in ("| The clone | `" + CLONE + "` |", "| The private directory | `" + PRIVATE + "` |",
                     "| The overlay | `" + PRIVATE + "/overlay.json` |",
                     "| A candidate directory | `" + MAIN + "` | State: complete. Pi pin: 1.1.0. Generated at 2030-01-01T12:00:00Z. |",
                     "| The launcher of this candidate | `" + PRIVATE + "/launch-main.sh` | Present. |",
                     "| The npm packages of this candidate | `" + MAIN + "/npm/` | `pi-hermes-memory` (installed) |",
                     "| Node | `24.0.0` |", "| Pi | `1.1.0` |", "| The memory store of `hermes` | Each candidate directory |",
                     "| The live agent directory | `~/.pi/agent` |"):
            self.assertIn(line, where)
        self.assertNotIn("LLM Wiki vault", where)
        together = section(value, HEADINGS[4])
        for words in ("input of the `generate` action", "from the clone by path", "`PI_CODING_AGENT_DIR`",
                      "`PATH` of the shell", "separate for each candidate"):
            self.assertIn(words, together)
        parts = section(value, HEADINGS[5])
        self.assertIn("- `ops-footer`: extensions `ops-footer`\n", parts)
        self.assertIn("- `herdr`: skills `herdr`\n", parts)
        self.assertLess(parts.index("- `herdr`: skills"), parts.index("These components are off:"))
        self.assertLess(parts.index("These components are off:"), parts.index("- `wiki`: extensions"))
        self.assertIn("- `consent.memoryCapture`: true\n", parts)
        self.assertIn("- `memory.hermes`: `backgroundReview` false\n", parts)
        self.assertIn("- `memory.wiki`: not set\n", parts)
        self.assertIn("The model roles that are set: `interactive`.", parts)
        add = section(value, HEADINGS[6])
        cli = "python3 " + CLONE + "/scripts/tenant_pi.py "
        for line in (cli + "components --overlay " + PRIVATE + "/overlay.json --format text",
                     cli + "components --select core,model-routing,context-meter,ops-footer,herdr,hermes,COMPONENT_ID\n",
                     "one `pi install` line for each npm package that the new candidate declares", "The peer override line",
                     cli + "validate --overlay " + PRIVATE + "/overlay.json --local-dir " + PRIVATE,
                     cli + "plan --overlay " + PRIVATE + "/overlay.json --local-dir " + PRIVATE,
                     cli + "generate --overlay " + PRIVATE + "/overlay.json --local-dir " + PRIVATE
                     + " --target /home/EXAMPLE_USER/.pi/profiles/NEW_NAME --launcher " + PRIVATE + "/launch-NEW_NAME.sh",
                     "The kit changes no profile in place.", "`consent.memoryCapture`", "`consent.remoteMemoryWrites`",
                     "`memory.hermes.backgroundReview`", "`memory.wiki.backgroundTasks`", "`roles.memory`",
                     "Log in again."):
            self.assertIn(line, add)
        self.assertNotIn("pi update", value)
        checks = section(value, HEADINGS[7])
        self.assertIn("| Check 4: the comparison with the baseline | passed |  |", checks)
        self.assertIn("These checks are not run: Check 1: the login; Check 3: the model reply\n", checks)
        last = section(value, HEADINGS[8])
        self.assertIn("`" + CLONE + "/POST_INSTALL.md`", last)
        self.assertIn("`" + PRIVATE + "/install-log.md`", last)

    def test_the_text_holds_no_role_value_and_no_endpoint(self):
        value = text()
        for private in ("example-provider", "example-model"):
            self.assertNotIn(private, value)

    def test_a_stop_at_an_early_stage_without_an_overlay(self):
        data = facts_data(status="stopped", lastStage="Stage 3: install Pi", nextStep="Install Node 24, then run Stage 3 again.",
                          places={}, stages=[{"stage": "Stage 3: install Pi", "state": "failed", "note": "Node is missing."}],
                          checks=[], notes=[])
        value = text(data, candidates=[], overlay=False, targets=())
        self.assertIn('status: "stopped"', frontmatter(value))
        self.assertIn('lastStage: "Stage 3: install Pi"', frontmatter(value))
        for line in ("privateDirectory: null", "overlay: null", "candidates: []", "componentsOn: []"):
            self.assertIn(line, frontmatter(value))
        first = section(value, HEADINGS[0])
        self.assertIn("The install stopped before the end. The last stage is: Stage 3: install Pi", first)
        self.assertIn("The next step is: Install Node 24, then run Stage 3 again.", first)
        self.assertIn("| Stage 3: install Pi | failed | Node is missing. |", first)
        self.assertEqual(list(HEADINGS), [line[3:] for line in value.split("\n") if line.startswith("## ")])
        self.assertIn("The kit got no candidate directory.", section(value, HEADINGS[2]))
        self.assertIn("Warning: A `pi` command without the launcher", section(value, HEADINGS[2]))
        self.assertIn("| The overlay | Not made. |", section(value, HEADINGS[3]))
        self.assertIn("| Node | Not recorded. |", section(value, HEADINGS[3]))
        self.assertIn("The install has no overlay. No component is selected.", section(value, HEADINGS[5]))
        self.assertIn("- `core`:", section(value, HEADINGS[5]).split("These components are off:")[1])
        self.assertIn("Complete the install first", section(value, HEADINGS[6]))
        self.assertNotIn("tenant_pi.py", section(value, HEADINGS[6]))
        self.assertIn("The installing agent recorded no check. The login and the model reply are not proved.",
                      section(value, HEADINGS[7]))
        self.assertIn("no `install-log.md`", section(value, HEADINGS[8]))

    def test_a_stop_with_an_overlay_names_the_last_stage_and_the_next_step(self):
        value = text(facts_data(status="stopped", lastStage="Stage 8: authentication", nextStep="Log in with the launcher."))
        self.assertIn("The install stopped before the end. The last stage is: Stage 8: authentication\n\n"
                      "The next step is: Log in with the launcher.", section(value, HEADINGS[0]))

    def test_an_account_that_the_install_created_and_one_that_existed(self):
        created = section(text(), HEADINGS[1])
        self.assertIn("The account of the install is `EXAMPLE_USER`.\nThe install created this account.\n", created)
        self.assertIn("```sh\nsudo -iu EXAMPLE_USER\n```", created)
        data = facts_data()
        data["account"] = {"name": "EXAMPLE_USER", "createdByInstall": False, "openShell": "su - EXAMPLE_USER"}
        value = text(data)
        existed = section(value, HEADINGS[1])
        self.assertIn("This account existed before the install. The install did not create it.", existed)
        self.assertNotIn("The install created this account.", existed)
        self.assertIn("```sh\nsu - EXAMPLE_USER\n```", existed)
        self.assertIn("accountCreatedByInstall: false", frontmatter(value))

    def test_two_candidates(self):
        data = facts_data()
        data["places"]["launchers"].append({"target": SECOND, "path": PRIVATE + "/launch second.sh"})
        rows = [row(), row(SECOND, PRIVATE + "/launch second.sh", launcher_present=False,
                           installed={"pi-hermes-memory": False}, state={"schemaVersion": 1, "status": "incomplete"})]
        value = text(data, rows, targets=(MAIN, SECOND))
        found = frontmatter(value)
        self.assertLess(found.index('  - directory: "' + MAIN + '"'), found.index('  - directory: "' + SECOND + '"'))
        self.assertIn('    launcher: "' + PRIVATE + '/launch second.sh"', found)
        self.assertIn('    state: "incomplete"', found)
        start = section(value, HEADINGS[2])
        # The launcher line is a shell word: a space in the path is quoted.
        self.assertIn("```sh\n'" + PRIVATE + "/launch second.sh'\n```\n\nWarning: The kit did not find this launcher file.", start)
        self.assertEqual(1, start.count("did not find this launcher file"))
        where = section(value, HEADINGS[3])
        self.assertIn("| A candidate directory | `" + SECOND + "` | State: incomplete. |", where)
        self.assertIn("| The launcher of this candidate | `" + PRIVATE + "/launch second.sh` | Not found. |", where)
        self.assertIn("| `" + SECOND + "/npm/` | `pi-hermes-memory` (not installed) |", where)
        # A candidate without a launcher of the facts file.
        value = text(candidates=[row(launcher=None, installed={})])
        self.assertIn("    launcher: null", frontmatter(value))
        self.assertIn("No launcher file is recorded for the candidate `" + MAIN + "`.", section(value, HEADINGS[2]))
        self.assertIn("The profile declares no npm package.", section(value, HEADINGS[3]))

    def test_a_vault_that_existed_before(self):
        vault = "/home/EXAMPLE_USER/.llm-wiki"
        where = section(text(facts_data(wikiVault={"path": vault, "existedBefore": True, "kept": True})), HEADINGS[3])
        self.assertIn("| The LLM Wiki vault | `" + vault + "` | The vault existed before the install. The kit kept its content. |", where)
        where = section(text(facts_data(wikiVault={"path": vault, "existedBefore": True, "kept": False})), HEADINGS[3])
        self.assertIn("The vault existed before the install. Its content was not kept.", where)
        where = section(text(facts_data(wikiVault={"path": vault, "existedBefore": False, "kept": False})), HEADINGS[3])
        self.assertIn("| The LLM Wiki vault | `" + vault + "` | The vault did not exist before the install. |", where)

    def test_a_pipe_of_a_free_text_stays_in_its_table_cell(self):
        data = facts_data(stages=[{"stage": "a | b", "state": "done", "note": "c | d"}])
        self.assertIn("| a \\| b | done | c \\| d |", text(data))


class WriteTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.out = self.base / "out"
        self.out.mkdir(0o700)
        self.path = self.out / NAME

    def rule(self, *args):
        with self.assertRaises(WriteError) as caught:
            results.write(*args)
        self.assertNotIn(str(self.base), str(caught.exception))
        return str(caught.exception)

    def test_a_new_file_has_mode_0600_and_the_exact_bytes(self):
        result = results.write(str(self.out), b"one\n")
        self.assertEqual({"path": str(self.path), "mode": "0600", "complete": True, "fileCreated": True, "replaced": False,
                          "warnings": []}, results.report(result))
        self.assertEqual(b"one\n", self.path.read_bytes())
        self.assertEqual(0o600, stat.S_IMODE(self.path.stat().st_mode))
        self.assertEqual([NAME], os.listdir(self.out))

    def test_an_existing_file_stays_without_replace(self):
        results.write(str(self.out), b"one\n")
        self.assertEqual("target_exists: results.out_dir", self.rule(str(self.out), b"two\n"))
        self.assertEqual(b"one\n", self.path.read_bytes())
        self.assertEqual([NAME], os.listdir(self.out))

    def test_replace_gives_the_new_bytes_with_mode_0600(self):
        self.path.write_bytes(b"old\n")
        self.path.chmod(0o644)
        self.assertTrue(results.write(str(self.out), b"new\n", True).replaced)
        self.assertEqual(b"new\n", self.path.read_bytes())
        self.assertEqual(0o600, stat.S_IMODE(self.path.stat().st_mode))
        self.assertEqual([NAME], os.listdir(self.out))
        # With no file, `replace` creates it.
        self.path.unlink()
        self.assertFalse(results.write(str(self.out), b"new\n", True).replaced)

    def test_replace_refuses_a_link_a_directory_and_a_left_temporary_file(self):
        other = self.base / "other"
        other.write_bytes(b"KEEP")
        self.path.symlink_to(other)
        self.assertEqual("target_not_regular: results.out_dir", self.rule(str(self.out), b"new\n", True))
        self.assertEqual(b"KEEP", other.read_bytes())
        self.path.unlink()
        self.path.mkdir()
        self.assertEqual("target_not_regular: results.out_dir", self.rule(str(self.out), b"new\n", True))
        self.path.rmdir()
        (self.out / TEMPORARY).write_bytes(b"left")
        self.assertEqual("temporary_exists: results.out_dir", self.rule(str(self.out), b"new\n", True))
        self.assertEqual(b"left", (self.out / TEMPORARY).read_bytes())

    def test_a_temporary_file_that_another_process_made_stays(self):
        self.path.write_bytes(b"old\n")
        create = results._create_file

        def late(parent_fd, name, data):
            # The file appears after the walk and before the exclusive create.
            other = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)
            os.write(other, b"other")
            os.close(other)
            return create(parent_fd, name, data)

        with patch.object(results, "_create_file", late):
            self.assertEqual("target_exists: results.out_dir", self.rule(str(self.out), b"new\n", True))
        self.assertEqual((b"old\n", b"other"), (self.path.read_bytes(), (self.out / TEMPORARY).read_bytes()))

        def broken(parent_fd, name, data):
            create(parent_fd, name, data)
            raise OSError("CANARY")

        # A temporary file of this call does not stay after a failure.
        (self.out / TEMPORARY).unlink()
        with patch.object(results, "_create_file", broken):
            self.assertEqual("write_failed: results.out_dir", self.rule(str(self.out), b"new\n", True))
        self.assertEqual([NAME], os.listdir(self.out))
        self.assertEqual(b"old\n", self.path.read_bytes())

    def test_a_missing_or_linked_directory_is_refused(self):
        self.assertEqual("out_dir_missing: results.out_dir", self.rule(str(self.base / "absent"), b"x"))
        link = self.base / "link"
        link.symlink_to(self.out)
        self.assertEqual("unsafe_path: results.out_dir.parents", self.rule(str(link), b"x"))
        self.assertEqual([], os.listdir(self.out))


class CliTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.home = self.base / "home" / "EXAMPLE_USER"
        self.private = self.home / ".config" / "tenant-pi"
        self.main = self.home / ".pi" / "profiles" / "main"
        self.second = self.home / ".pi" / "profiles" / "second"
        for directory in (self.private, self.main / ".tenant-pi", self.main / "npm/node_modules/pi-hermes-memory",
                          self.second / ".tenant-pi"):
            directory.mkdir(parents=True, mode=0o700)
        self.overlay = self.private / "overlay.json"
        self.overlay.write_text(json.dumps(overlay_data(str(self.main))))
        state = {"schemaVersion": 1, "status": "complete",
                 "provenance": {"kitSchemaVersion": 1, "piVersion": "1.1.0", "generatedAt": "2030-01-01T12:00:00Z"}}
        (self.main / ".tenant-pi/state.json").write_text(json.dumps(state))
        (self.main / "settings.json").write_text(json.dumps({"packages": [
            "npm:pi-hermes-memory", "npm:@juicesharp/rpiv-ask-user-question@2.11.0"]}))
        (self.main / "npm/node_modules/pi-hermes-memory/package.json").write_text("{}")
        # Files of a profile that the action must not open.
        for name in ("auth.json", "models.json"):
            (self.main / name).write_text("CANARY_PRIVATE")
        (self.second / ".tenant-pi/state.json").write_text("not json CANARY_PRIVATE")
        self.launcher = self.private / "launch-main.sh"
        self.launcher.write_text("#!/bin/sh\n")
        data = facts_data()
        data["places"]["launchers"] = [{"target": str(self.main), "path": str(self.launcher)}]
        self.facts = self.base / "facts.json"
        self.facts.write_text(json.dumps(data))
        self.data = data
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("pi", "npm", "node", "git", "sh", "sudo"):
            command = self.bin / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base / "called") + "'\n")
            command.chmod(0o700)
        self.log = self.base / "events.log"
        # Loads before the CLI: blocks the network and each process start, and records each opened path.
        (self.base / "sitecustomize.py").write_text(
            "import sys\nsys.dont_write_bytecode = True\nimport os, socket, subprocess\n"
            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
            "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n"
            "_log = os.open(" + repr(str(self.log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
            "_START = ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty')\n"
            "def _audit(event, args):\n"
            "    if event in _START or event == 'open':\n"
            "        os.write(_log, (event + ' ' + str(args[0] if args else '') + '\\n').encode('utf-8', 'replace'))\n"
            "sys.addaudithook(_audit)\n")
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "PYTHONPATH": str(self.base),
                    "PYTHONDONTWRITEBYTECODE": "1", "TENANTEXT_LITELLM_API_KEY": "CANARY_SECRET_VALUE"}

    def tree(self, skip=()):
        """Every entry below the base with its mode and bytes, without the event log and the paths of `skip`."""
        found = {}
        for path in sorted(self.base.rglob("*")):
            if path == self.log or path in skip:
                continue
            info = os.lstat(path)
            found[str(path.relative_to(self.base))] = (info.st_mode, path.read_bytes() if stat.S_ISREG(info.st_mode) else None)
        return found

    def run_cli(self, *extra, overlay=True, targets=None):
        targets = [self.main] if targets is None else targets
        args = [sys.executable, str(CLI), "results", "--facts", str(self.facts)]
        args += ["--overlay", str(self.overlay)] if overlay else []
        for target in targets:
            args += ["--target", str(target)]
        return subprocess.run([*args, *extra], cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def refused(self, error, *extra, **options):
        before, kit = self.tree(), self.kit_files()
        result = self.run_cli(*extra, **options)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertEqual("", result.stdout)
        self.assertEqual({"candidate_created": False, "error": error}, json.loads(result.stderr))
        self.assertNotIn(str(self.base), result.stderr)
        self.assertNotIn("CANARY", result.stderr)
        # Every refusal fires before the write.
        self.assertEqual(before, self.tree())
        self.assertEqual(kit, self.kit_files())
        self.assertFalse((self.base / "called").exists())

    def kit_files(self):
        return sorted(str(path) for path in ROOT.rglob(NAME + "*"))

    def test_without_out_dir_the_text_is_printed_and_nothing_is_written(self):
        before = self.tree()
        first = self.run_cli()
        self.assertEqual(0, first.returncode, first.stderr)
        self.assertEqual("", first.stderr)
        second = self.run_cli()
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(before, self.tree())
        value = first.stdout
        self.assertEqual(list(HEADINGS), [line[3:] for line in value.split("\n") if line.startswith("## ")])
        found = frontmatter(value)
        self.assertIn('kitCommit: "' + tenant_pi._kit_commit() + '"', found)
        self.assertIn('clone: "' + str(ROOT) + '"', found)
        self.assertIn('privateDirectory: "' + str(self.private) + '"', found)
        self.assertIn('    launcher: "' + str(self.launcher) + '"', found)
        self.assertIn("| `" + str(self.main) + "/npm/` | `pi-hermes-memory` (installed), "
                      "`@juicesharp/rpiv-ask-user-question` (not installed) |", value)
        self.assertIn("| The launcher of this candidate | `" + str(self.launcher) + "` | Present. |", value)
        for private in ("CANARY", "example-provider", "example-model"):
            self.assertNotIn(private, value)
        self.assertFalse((self.base / "called").exists())

    def test_two_runs_write_the_same_bytes_with_mode_0600_and_nothing_else(self):
        out, other = self.home, self.base / "second-out"
        other.mkdir(0o700)
        before = self.tree()
        result = self.run_cli("--out-dir", str(out))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual({"path": str(out / NAME), "mode": "0600", "complete": True, "fileCreated": True, "replaced": False,
                          "warnings": []}, json.loads(result.stdout))
        self.assertEqual(json.dumps(json.loads(result.stdout), sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n",
                         result.stdout)
        self.assertEqual(0, self.run_cli("--out-dir", str(other)).returncode)
        data = (out / NAME).read_bytes()
        self.assertEqual(data, (other / NAME).read_bytes())
        self.assertEqual(data.decode("utf-8"), self.run_cli().stdout)
        self.assertEqual(0o600, stat.S_IMODE((out / NAME).stat().st_mode))
        # The two files are the only change below the base, and the kit clone got no file.
        self.assertEqual(before, self.tree(skip=(out / NAME, other / NAME)))
        self.assertEqual([], self.kit_files())
        self.assertFalse((self.base / "called").exists())

    def test_the_action_starts_no_process_and_opens_only_its_declared_files(self):
        self.assertEqual(0, self.run_cli("--out-dir", str(self.home), targets=[self.main, self.second]).returncode)
        events = self.log.read_text().splitlines()
        self.assertEqual([], [event for event in events if not event.startswith("open ")])
        # The loader opens each path part by its name. The file names of the run are a closed set.
        opened = {event[5:] for event in events}
        names = {name for name in opened if name.endswith((".json", ".md", ".new", ".sh"))
                 and not name.startswith(str(ROOT) + "/")}
        self.assertEqual({"manifest.json", "facts.json", "overlay.json", "state.json", "settings.json", NAME}, names)
        for name in ("auth.json", "models.json", "package.json", "launch-main.sh"):
            self.assertFalse(any(path.endswith(name) for path in opened), name)

    def test_a_candidate_file_that_does_not_load_is_a_state_and_not_a_stop(self):
        result = self.run_cli(targets=[self.main, self.second, self.home / "absent"])
        self.assertEqual(0, result.returncode, result.stderr)
        found = frontmatter(result.stdout)
        self.assertEqual(['    state: "complete"', '    state: "invalid"', '    state: "absent"'],
                         [line for line in found if line.startswith("    state:")])
        self.assertNotIn("CANARY", result.stdout)

    def test_a_directory_inside_the_checkout_is_refused(self):
        self.refused("under_kit: results.out_dir", "--out-dir", str(ROOT))
        self.refused("under_kit: results.out_dir", "--out-dir", str(ROOT / "docs"))
        # A link to the checkout does not hide it.
        (self.base / "link").symlink_to(ROOT / "docs")
        self.refused("under_kit: results.out_dir", "--out-dir", str(self.base / "link"))
        self.refused("under_target: results.out_dir", "--out-dir", str(self.main))
        self.refused("absolute_path: results.out_dir", "--out-dir", "relative")

    def test_a_directory_below_a_wiki_vault_is_refused(self):
        vault = self.home / ".llm-wiki"
        (vault / "meta").mkdir(parents=True, mode=0o700)
        (vault / "config.json").write_text("CANARY_PRIVATE")
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(vault))
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(vault / "meta"))
        # A link to the vault does not hide it.
        (self.base / "link").symlink_to(vault / "meta")
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(self.base / "link"))
        # The vault of `WIKI_HOME` counts also, and the vault of the home directory stays refused.
        other = self.base / "other" / ".llm-wiki"
        other.mkdir(parents=True, mode=0o700)
        self.env["WIKI_HOME"] = str(self.base / "other")
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(other))
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(vault))
        # The rule needs the home directory, and only with `--out-dir`.
        home = self.env.pop("HOME")
        self.refused("home_required: results.home", "--out-dir", str(self.private))
        self.assertEqual(0, self.run_cli().returncode)
        self.env["HOME"] = home
        # A directory beside the vault is not refused.
        result = self.run_cli("--out-dir", str(self.private))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue((self.private / NAME).is_file())
        self.assertEqual([".llm-wiki"], sorted(path.name for path in (self.base / "other").iterdir()))
        self.assertEqual(["config.json", "meta"], sorted(path.name for path in vault.iterdir()))
        self.assertEqual([], list((vault / "meta").iterdir()))

    def wiki_home_overlay(self, root):
        """The overlay of the fixture with the `wiki` module and `memory.wiki.wikiHome` at `root`."""
        data = overlay_data(str(self.main))
        data["selection"] = {"enable": [*data["selection"]["enable"], "wiki"], "disable": ["questions"]}
        data["memory"]["wiki"] = {"ambientPersonalVault": True, "backgroundTasks": False, "wikiHome": str(root)}
        self.overlay.write_text(json.dumps(data))

    def test_the_vault_of_the_overlay_wiki_home_is_refused(self):
        chosen = self.base / "chosen wiki home"
        vault = chosen / ".llm-wiki"
        (vault / "meta").mkdir(parents=True, mode=0o700)
        # Without `wikiHome` in the overlay, the place is no vault.
        self.assertEqual(0, self.run_cli("--out-dir", str(vault / "meta")).returncode)
        (vault / "meta" / NAME).unlink()
        self.wiki_home_overlay(chosen)
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(vault))
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(vault / "meta"))
        (self.base / "link").symlink_to(vault / "meta")
        self.refused("under_wiki_vault: results.out_dir", "--out-dir", str(self.base / "link"))
        self.refused("under_wiki_vault: results.target", targets=[vault / "candidate"])
        # A directory beside the vault is not refused.
        result = self.run_cli("--out-dir", str(chosen))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual([".llm-wiki", NAME], sorted(path.name for path in chosen.iterdir()))
        self.assertEqual([], list((vault / "meta").iterdir()))

    def test_a_target_below_a_wiki_vault_is_refused_before_any_open(self):
        # The kit opens no file of a vault: a `--target` there is refused before its kit files are read.
        vault = self.home / ".llm-wiki"
        other = self.base / "other" / ".llm-wiki"
        chosen = self.base / "chosen" / ".llm-wiki"
        for root in (vault, other, chosen):
            (root / "x" / ".tenant-pi").mkdir(parents=True, mode=0o700)
            for name in ("settings.json", ".tenant-pi/state.json"):
                (root / "x" / name).write_text("CANARY_PRIVATE")
        (self.base / "link").symlink_to(vault / "x")
        for target in (vault, vault / "x", vault / "absent", self.base / "link"):
            self.refused("under_wiki_vault: results.target", targets=[target])
            self.refused("under_wiki_vault: results.target", "--out-dir", str(self.private), targets=[self.main, target])
        # Until here no file is opened but the files of Python and of the kit: the rule comes before each input file.
        events = self.log.read_text().splitlines()
        self.assertIn("open " + str(CLI), events)
        self.assertEqual([], [event for event in events if event.endswith(".json") and not event.startswith("open " + str(ROOT))])
        # The vault of `WIKI_HOME` counts also. With no `HOME`, a print knows only this vault and the one of the overlay.
        self.env["WIKI_HOME"] = str(self.base / "other")
        home = self.env.pop("HOME")
        self.refused("under_wiki_vault: results.target", targets=[other / "x"])
        self.env["HOME"] = home
        del self.env["WIKI_HOME"]
        # The vault of `memory.wiki.wikiHome` of the overlay counts also.
        self.wiki_home_overlay(self.base / "chosen")
        self.refused("under_wiki_vault: results.target", targets=[chosen / "x"])
        # No run opened an entry of a vault, by its path or by its name.
        opened = {event[5:] for event in self.log.read_text().splitlines() if event.startswith("open ")}
        self.assertEqual(set(), {name for name in opened if ".llm-wiki" in name or name in ("x", ".tenant-pi", "state.json",
                                                                                           "settings.json")})
        self.assertFalse((self.private / NAME).exists())

    def test_an_existing_file_is_replaced_only_with_replace(self):
        self.assertEqual(0, self.run_cli("--out-dir", str(self.home)).returncode)
        first = (self.home / NAME).read_bytes()
        self.refused("target_exists: results.out_dir", "--out-dir", str(self.home))
        # A later candidate: the complete file is rendered again from the data.
        self.data["places"]["launchers"].append({"target": str(self.second), "path": str(self.private / "launch-second.sh")})
        self.facts.write_text(json.dumps(self.data))
        result = self.run_cli("--out-dir", str(self.home), "--replace", targets=[self.main, self.second])
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(json.loads(result.stdout)["replaced"])
        second = (self.home / NAME).read_bytes()
        self.assertNotEqual(first, second)
        self.assertIn(str(self.second).encode(), second)
        self.assertEqual(0o600, stat.S_IMODE((self.home / NAME).stat().st_mode))
        self.assertEqual([], [path.name for path in self.home.iterdir() if path.name.startswith(NAME + ".")])
        self.refused("out_dir_required: results.replace", "--replace")

    def test_an_unknown_key_of_the_facts_file_is_refused(self):
        self.data["password"] = "CANARY_SECRET_VALUE"
        self.facts.write_text(json.dumps(self.data))
        self.refused("unknown_fields: facts", "--out-dir", str(self.home))
        self.refused("unknown_fields: facts")

    def test_a_secret_form_does_not_reach_the_file(self):
        for secret in SECRETS:
            data = copy.deepcopy(self.data)
            data["notes"] = ["CANARY " + secret]
            self.facts.write_text(json.dumps(data))
            self.refused("secret_like: facts.notes", "--out-dir", str(self.home))
            self.assertFalse((self.home / NAME).exists())
        result = self.run_cli()
        self.assertEqual(2, result.returncode)
        for secret in SECRETS:
            self.assertNotIn(secret, result.stdout + result.stderr)

    def test_bad_inputs_are_refused(self):
        self.refused("duplicate_target: results.target", targets=[self.main, self.main])
        self.refused("absolute_path: results.target", targets=["relative"])
        self.refused("input_missing: facts.file", "--facts", str(self.base / "absent.json"))
        self.overlay.write_text(json.dumps({**overlay_data(str(self.main)), "extra": "CANARY"}))
        self.refused("unknown_fields: overlay")
        self.facts.write_text(json.dumps(self.data))
        result = subprocess.run([sys.executable, str(CLI), "results", "--facts", str(self.facts), "--overlay", "overlay.json"],
                                cwd=self.private, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual({"candidate_created": False, "error": "absolute_path: results.overlay"}, json.loads(result.stderr))

    def test_an_early_stop_without_an_overlay_and_without_a_candidate(self):
        data = facts_data(status="stopped", lastStage="Stage 1: requirements", nextStep="Install Python 3.11.", places={},
                          stages=[{"stage": "Stage 1: requirements", "state": "blocked", "note": None}], checks=[])
        self.facts.write_text(json.dumps(data))
        result = self.run_cli("--out-dir", str(self.home), overlay=False, targets=[])
        self.assertEqual(0, result.returncode, result.stderr)
        value = (self.home / NAME).read_text()
        self.assertIn('lastStage: "Stage 1: requirements"', frontmatter(value))
        self.assertIn("The next step is: Install Python 3.11.", value)
        self.assertIn("| Stage 1: requirements | blocked |  |", value)


if __name__ == "__main__":
    unittest.main()
