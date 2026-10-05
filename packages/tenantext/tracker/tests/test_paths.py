"""Agent packet extraction tests."""

import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path

from tracker.__main__ import main
from tracker.brief import dump, parse
from tracker.paths import EXECUTION_NOTE, PACKET_SCHEMA, extract, format_text

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"
FIXTURE = ROOT / "tests" / "fixtures" / "prototype-fleet-72.md"


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.model = parse(EXAMPLE.read_text(encoding="utf-8"))
        self.packets = extract(self.model)

    def test_one_packet_per_path_in_order(self):
        self.assertEqual([p["id"] for p in self.packets], [p["id"] for p in self.model["paths"]])
        self.assertEqual([p["role"] for p in self.packets], ["recommended", "alternative", "alternative", "backlog"])

    def test_packet_holds_every_path_field(self):
        for path, packet in zip(self.model["paths"], self.packets):
            for key, value in path.items():
                self.assertEqual(packet[key], value)
            self.assertEqual(packet["packet"], PACKET_SCHEMA)
            self.assertEqual(packet["execution"], EXECUTION_NOTE)

    def test_read_first_resolves_to_full_evidence_records(self):
        first = self.packets[0]
        self.assertEqual([e["id"] for e in first["read_first_records"]], ["ev-issue-3", "ev-file-schema"])
        evidence = {e["id"]: e for e in self.model["evidence"]}
        self.assertEqual(first["read_first_records"][1], evidence["ev-file-schema"])
        self.assertEqual(first["unresolved_read_first"], [])

    def test_issue_records_resolve_ids_and_numbers(self):
        footer = self.packets[1]
        self.assertEqual([i["id"] for i in footer["issue_records"]], ["5", "6"])
        self.assertEqual(footer["unresolved_issues"], ["#8"])  # kept as text, not dropped
        model = copy.deepcopy(self.model)
        model["paths"][1]["issues"] = ["#6", "6", "#7"]
        packet = extract(model)[1]
        self.assertEqual([i["id"] for i in packet["issue_records"]], ["6", "7"])

    def test_brief_identity_and_gates_travel_with_each_packet(self):
        packet = self.packets[2]
        self.assertEqual(packet["brief"]["repo"], "owner/demo")
        self.assertEqual(packet["brief"]["snapshot"], "2030-01-23T06:30:00Z")
        self.assertEqual(packet["brief"]["synthesis"], "model")
        self.assertEqual([g["id"] for g in packet["gates"]], ["gate-offline", "gate-publication", "gate-publish", "gate-no-launch"])
        self.assertEqual([e["id"] for e in packet["gates"][1]["evidence_records"]], ["ev-issue-4"])

    def test_packets_are_plain_json_and_do_not_share_state(self):
        before = copy.deepcopy(self.model)
        packets = extract(self.model)
        self.assertEqual(json.loads(json.dumps(packets)), packets)
        packets[0]["acceptance"].append("mutated")
        packets[0]["read_first_records"][0]["label"] = "mutated"
        self.assertEqual(self.model, before)
        self.assertEqual(extract(self.model), self.packets)

    def test_validation_commands_stay_text(self):
        self.assertEqual(self.packets[0]["validate"], ["python3 -m unittest discover -s tracker/tests -t .", "npm test"])
        text = format_text(self.packets)
        self.assertIn("Validation commands (text only):", text)
        self.assertIn("proposal-only", text)

    def test_recommended_packet_holds_the_stored_handoff(self):
        stored = self.model["handoffs"][0]
        self.assertEqual(self.packets[0]["handoff"], stored)
        for packet in self.packets[1:]:
            self.assertNotIn("handoff", packet)
        model = copy.deepcopy(self.model)
        model["handoffs"][0]["text"] = "Stored text only.\n\nNothing is composed here."
        self.assertEqual(extract(model)[0]["handoff"]["text"], "Stored text only.\n\nNothing is composed here.")

    def test_text_prints_the_stored_prompt(self):
        text = format_text(self.packets)
        stored = self.model["handoffs"][0]
        begin = "----- begin prompt -----\n"
        self.assertEqual(text.count(begin), 1)
        self.assertIn(begin + stored["text"] + "\n----- end prompt -----\n", text)
        self.assertIn("Next-session prompt (source generated, basis current, generated 2030-01-23T06:30:00Z):", text)
        self.assertLess(text.index(begin), text.index("\nPATH path-reconcile"))

    def test_prototype_fixture_packets(self):
        packets = extract(parse(FIXTURE.read_text(encoding="utf-8")))
        self.assertEqual(len(packets), 18)
        second = packets[1]
        self.assertEqual([i["id"] for i in second["issue_records"]], ["21", "14", "13", "12", "11", "10"])
        self.assertEqual(second["unresolved_issues"], [])


class CliPathsTests(unittest.TestCase):
    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = main(list(argv))
        return code, out.getvalue()

    def test_json_output_matches_extract(self):
        code, out = self.run_cli("paths", str(EXAMPLE), "--json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), extract(parse(EXAMPLE.read_text(encoding="utf-8"))))

    def test_text_output(self):
        code, out = self.run_cli("paths", str(EXAMPLE))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("PATH path-merge-storage [recommended, ready-offline]\n"))
        self.assertEqual(out.count("\nPATH "), 3)
        self.assertIn(parse(EXAMPLE.read_text(encoding="utf-8"))["handoffs"][0]["text"], out)

    def test_handoff_prints_only_the_stored_prompt(self):
        code, out = self.run_cli("handoff", str(EXAMPLE))
        self.assertEqual(code, 0)
        self.assertEqual(out, parse(EXAMPLE.read_text(encoding="utf-8"))["handoffs"][0]["text"] + "\n")
        code, out = self.run_cli("handoff", str(FIXTURE))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("You coordinate the next work session"))

    def test_handoff_without_a_prompt_exits_1(self):
        model = parse(EXAMPLE.read_text(encoding="utf-8"))
        model["paths"][0]["role"] = "backlog"
        model["handoffs"] = []
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "brief.md"
            path.write_text(dump(model), encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(["handoff", str(path)])
            self.assertEqual(code, 1)
            self.assertEqual(out.getvalue(), "")
            self.assertIn("error [handoff] this brief stores no next-session prompt", err.getvalue())
            path.write_text("not a brief", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(["handoff", str(path)]), 1)


if __name__ == "__main__":
    unittest.main()
