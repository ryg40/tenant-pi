"""Next-session prompt generator: content, determinism, limits and refresh rules."""

import copy
import importlib.util
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

from tracker import handoff
from tracker.brief import HANDOFF_MAX_WORDS, dump, parse, stored_handoff, validate, words

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"
FIXTURE = ROOT / "tests" / "fixtures" / "prototype-fleet-72.md"


def _support():
    name = "tracker_pipeline_support"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT / "tests" / "fixtures" / "pipeline_support.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def example():
    return parse(EXAMPLE.read_text(encoding="utf-8"))


def errors(model):
    return [d for d in validate(model) if d.level == "error"]


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.model = example()
        self.record = handoff.build(self.model)
        self.text = self.record["text"]

    def test_record_fields(self):
        self.assertEqual(
            {k: v for k, v in self.record.items() if k != "text"},
            {"id": "handoff-path-merge-storage", "path": "path-merge-storage", "source": "generated",
             "generated": "2030-01-23T06:30:00Z", "basis": "current"},
        )

    def test_deterministic_and_pure(self):
        before = copy.deepcopy(self.model)
        self.assertEqual(handoff.build(self.model), self.record)
        self.assertEqual(handoff.build(json.loads(json.dumps(self.model))), self.record)
        self.assertEqual(self.model, before, "build does not change the model")

    def test_text_stands_alone(self):
        path = self.model["paths"][0]
        for needed in [
            "You coordinate the next work session in the repository owner/demo.",
            "Start from this prompt. You have not seen the earlier session.",
            "Repository: owner/demo",
            "Repository URL: https://git.example.com/owner/demo",
            "Working directory: ~/git/demo",
            "Revision: demo@a1b2c3d",
            "Brief snapshot: 2030-01-23T06:30:00Z",
            "Evidence checked: 2030-01-23T06:25:00Z",
            "Confirm that the sources below are still current before you act.",
            "Objective: " + path["objective"],
            "Scope: " + path["scope"],
            "Next action: " + path["next_action"],
            "- Task 3, storage specification (issue): https://git.example.com/owner/demo/issues/3",
            "- Tracker brief schema (file, not a link): tracker/schema.md",
            "- #3 Storage adapters and conflict checks (open, in-progress): "
            "https://git.example.com/owner/demo/issues/3",
            "- Both feature branches are committed.",
            "Authority: " + path["authority"],
            "- Publishing the rendered brief",
            "- The tracker unit tests pass.",
            "- python3 -m unittest discover -s tracker/tests -t .",
            "- npm test",
            "Expected output: " + path["output"],
        ]:
            self.assertIn(needed, self.text.split("\n"), needed)

    def test_gates_in_force(self):
        lines = self.text.split("\n")
        for gate in self.model["gates"]:
            label = {"approval": "Needs approval", "forbidden": "Forbidden"}.get(gate["kind"])
            if label:
                self.assertIn(f"- {label}: {gate['text']}", lines)
            else:
                self.assertNotIn(gate["text"], self.text, "allowed gates are not approval gates")

    def test_ends_with_the_proposal_statement(self):
        self.assertTrue(self.text.endswith(handoff.PROPOSAL))
        for phrase in ["is a proposal", "no permission to deploy, publish, change issues or pass an approval gate",
                       "stop and ask the requester"]:
            self.assertIn(phrase, self.text)

    def test_plain_text_one_fact_per_line(self):
        self.assertLessEqual(words(self.text), HANDOFF_MAX_WORDS)
        self.assertNotIn("<", self.text)
        self.assertNotIn("**", self.text)
        self.assertEqual(self.text, self.text.strip())
        for line in self.text.split("\n"):
            self.assertEqual(line, line.rstrip())
            self.assertLess(len(line), 260, line)

    def test_carried_forward_first_line(self):
        record = handoff.build(self.model, basis="carried-forward")
        self.assertEqual(record["basis"], "carried-forward")
        first = record["text"].split("\n")[0]
        self.assertEqual(first, handoff.CARRIED_FORWARD)
        self.assertIn("earlier brief", first)
        self.assertIn("not re-checked", first)
        self.assertNotIn(handoff.CARRIED_FORWARD, self.text)
        with self.assertRaises(ValueError):
            handoff.build(self.model, basis="later")

    def test_fallbacks_for_cwd_revision_and_unknown_issue(self):
        model = example()
        path = model["paths"][0]
        del path["cwd"], path["revision"]
        path["issues"] = ["3", "#999"]
        text = handoff.build(model)["text"]
        self.assertIn("Working directory: a checkout of owner/demo (the brief records no path)", text)
        self.assertIn("Revision: demo@a1b2c3d (the ref of the brief)", text)
        self.assertIn("- #999 (no issue record in the brief)", text)

    def test_other_repository_keeps_the_brief_url_apart(self):
        model = example()
        model["paths"][0]["repo"] = "owner/other"
        text = handoff.build(model)["text"]
        self.assertIn("Repository: owner/other", text)
        self.assertIn("Brief repository: owner/demo at https://git.example.com/owner/demo", text)
        self.assertNotIn("Repository URL:", text)

    def test_only_model_facts(self):
        canary = "CANARY-ENV-VALUE-5c1d"
        with mock.patch.dict(os.environ, {"GITEA_TOKEN": canary, "TRACKER_STORE_PATH": "/secret/" + canary}):
            text = handoff.build(self.model)["text"]
        self.assertNotIn(canary, text)
        source = json.dumps(self.model)
        for url in re.findall(r"https://\S+", text):
            self.assertIn(url, source)

    def test_no_recommended_path(self):
        model = example()
        model["paths"][0]["role"] = "backlog"
        self.assertIsNone(handoff.build(model))

    def test_long_path_stays_within_the_limit(self):
        model = example()
        path = model["paths"][0]
        path["objective"] = " ".join(["objective"] * 300)
        path["scope"] = " ".join(["scope"] * 300)
        path["acceptance"] = [f"criterion {n} " + " ".join(["detail"] * 20) for n in range(30)]
        path["needs_approval"] = [f"approval {n}" for n in range(12)]
        text = handoff.build(model)["text"]
        self.assertLessEqual(words(text), HANDOFF_MAX_WORDS)
        self.assertIn("more in the restart brief", text)
        self.assertTrue(text.endswith(handoff.PROPOSAL))
        self.assertIn("- python3 -m unittest discover -s tracker/tests -t .", text, "commands are never clipped")
        refreshed = handoff.refresh(model)
        self.assertEqual([d.code for d in errors(refreshed) if d.code in ("words", "handoff", "value-format")], [])

    def test_id_stays_unique(self):
        # An evidence record already uses the natural id, so the handoff gets a suffix.
        model = json.loads(json.dumps(example()).replace('"ev-issue-3"', '"handoff-path-merge-storage"'))
        self.assertEqual(handoff.build(model)["id"], "handoff-path-merge-storage-2")
        self.assertEqual(errors(handoff.refresh(model)), [])
        long_id = "p" + "x" * 63
        model["paths"][0]["id"] = long_id
        self.assertEqual(len(handoff.build(model)["id"]), 64)


class RefreshTests(unittest.TestCase):
    def test_replaces_a_generated_handoff(self):
        model = example()
        model["paths"][0]["next_action"] = "Run the new first step."
        out = handoff.refresh(model)
        self.assertIn("Next action: Run the new first step.", out["handoffs"][0]["text"])
        self.assertNotIn("Next action: Run the new first step.", model["handoffs"][0]["text"], "input unchanged")
        self.assertEqual(errors(out), [])

    def test_keeps_an_requester_handoff_for_the_same_path(self):
        model = example()
        requester = dict(model["handoffs"][0], source="requester", text="Requester prompt.\n\nKeep it as written.")
        model["handoffs"] = [requester]
        out = handoff.refresh(model, basis="carried-forward")
        self.assertEqual(out["handoffs"], [requester])
        self.assertEqual(parse(dump(out)), out)

    def test_replaces_an_requester_handoff_when_the_recommended_path_changes(self):
        model = example()
        model["handoffs"] = [dict(model["handoffs"][0], source="requester", text="Requester prompt.")]
        model["paths"][0]["role"] = "backlog"
        model["paths"][1]["role"] = "recommended"
        out = handoff.refresh(model)
        self.assertEqual(out["handoffs"][0]["path"], "path-reconcile")
        self.assertEqual(out["handoffs"][0]["source"], "generated")
        self.assertEqual(errors(out), [])

    def test_drops_the_handoff_without_a_recommended_path(self):
        model = example()
        model["paths"][0]["role"] = "backlog"
        out = handoff.refresh(model)
        self.assertEqual(out["handoffs"], [])
        self.assertEqual(errors(out), [])

    def test_adds_a_missing_handoff_key(self):
        model = example()
        del model["handoffs"]
        self.assertEqual(handoff.refresh(model)["handoffs"], [handoff.build(example())])


class StoredFixtureTests(unittest.TestCase):
    """The stored prompts in the example and the fixtures are generator output, not hand-written."""

    def check(self, model):
        stored = stored_handoff(model)
        self.assertIsNotNone(stored)
        self.assertEqual(stored["source"], "generated")
        self.assertEqual(handoff.build(model, basis=stored["basis"]), stored)
        self.assertEqual(errors(model), [])

    def test_example(self):
        self.check(example())

    def test_prototype_fixture(self):
        self.check(parse(FIXTURE.read_text(encoding="utf-8")))

    def test_pipeline_previous_brief(self):
        S = _support()
        self.check(parse(S.previous_brief("abc1234", "2030-01-01T00:00:00Z")))


if __name__ == "__main__":
    unittest.main()
