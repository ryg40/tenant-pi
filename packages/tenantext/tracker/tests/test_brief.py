"""Parser, validator and dump tests for tracker-brief/1."""

import contextlib
import io
import json
import unittest
from pathlib import Path

from tracker.__main__ import main
from tracker.brief import (
    BUDGET_ERROR,
    BUDGET_WARN,
    BriefError,
    Diagnostic,
    default_brief_word_count,
    dump,
    parse,
    validate,
)

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"


def example_text():
    return EXAMPLE.read_text(encoding="utf-8")


def swap(text, old, new):
    assert text.count(old) == 1, f"expected exactly one {old!r}"
    return text.replace(old, new)


def line_of(text, needle, nth=1):
    """1-based line number of the nth line that equals needle."""
    found = [n for n, line in enumerate(text.split("\n"), 1) if line == needle]
    return found[nth - 1]


EXTRA_CHANGE = """```change
id: chg-extra
title: Extra change
summary: One more change.
status: reported
evidence:
  - ev-pr-2
```

"""


class ParseTests(unittest.TestCase):
    def syntax_error(self, text):
        with self.assertRaises(BriefError) as ctx:
            parse(text)
        return ctx.exception.diagnostics

    def assertSyntax(self, text, code, line="any"):
        diags = self.syntax_error(text)
        matches = [d for d in diags if d.code == code]
        self.assertTrue(matches, f"no {code} in {[str(d) for d in diags]}")
        if line != "any":
            self.assertIn(line, [d.line for d in matches], [str(d) for d in diags])
        for d in diags:
            self.assertEqual(d.level, "error")
        return matches

    def test_example_parses_and_validates_clean(self):
        model = parse(example_text())
        self.assertEqual(validate(model), [])
        words = default_brief_word_count(model)
        self.assertGreaterEqual(words, 250)
        self.assertLessEqual(words, BUDGET_WARN)

    def test_model_shape(self):
        model = parse(example_text())
        self.assertEqual(
            list(model),
            ["meta", "title", "position", "changes", "active", "issues", "gates", "unknowns", "paths", "handoffs", "evidence", "notes"],
        )
        self.assertEqual(model["meta"]["stale_after_days"], 7)
        self.assertEqual(model["meta"]["schema"], "tracker-brief/1")
        self.assertEqual(model["title"], "Demo restart brief")
        self.assertEqual(model["position"]["id"], "pos-demo")
        self.assertEqual([a["priority"] for a in model["active"]], [1, 2, 3])
        self.assertIsInstance(model["changes"][0]["evidence"], list)
        self.assertNotIn("requester", model["active"][2])  # optional and absent
        self.assertNotIn("blocker", model["active"][0])
        self.assertEqual(model["notes"], {"Where things stand": [
            "Requester note: keep this brief short. Long history belongs in the issue tracker.\n"
            "The default brief path is `docs/tracker-brief.md` when `docs/` is a directory, "
            "else `tracker-brief.md` at the repository root."]})
        # The model is plain JSON data.
        self.assertEqual(json.loads(json.dumps(model)), model)

    def test_round_trip(self):
        model = parse(example_text())
        text = dump(model)
        self.assertEqual(parse(text), model)
        self.assertEqual(dump(parse(text)), text)

    def test_round_trip_of_plain_hand_built_model(self):
        plain = json.loads(json.dumps(parse(example_text())))
        self.assertEqual(parse(dump(plain)), plain)

    def test_requester_notes_survive_byte_for_byte(self):
        note_a = "Requester: <b>keep</b> \"quotes\" & 'apostrophes'  \n  indented line\t\n### a sub-heading stays prose"
        note_b = "Second note with trailing spaces   "
        text = swap(
            example_text(),
            "## Unknowns and conflicts\n",
            "## Unknowns and conflicts\n\n" + note_a + "\n\n" + note_b + "\n",
        )
        model = parse(text)
        self.assertEqual(model["notes"]["Unknowns and conflicts"], [note_a, note_b])
        out = dump(model)
        self.assertIn(note_a + "\n", out)
        self.assertIn(note_b + "\n", out)
        self.assertEqual(parse(out), model)

    def test_plain_text_is_kept_literally(self):
        text = swap(example_text(), "title: Parser merged", "title: <script>alert(\"x\")</script> & 'quoted'")
        model = parse(text)
        self.assertEqual(model["changes"][0]["title"], "<script>alert(\"x\")</script> & 'quoted'")
        self.assertEqual(parse(dump(model)), model)

    def test_frontmatter_quotes_are_stripped_and_restored(self):
        text = swap(example_text(), "ref: demo@a1b2c3d", 'ref: "demo@a1b2c3d"')
        self.assertEqual(parse(text)["meta"]["ref"], "demo@a1b2c3d")
        model = parse(example_text())
        model["meta"]["ref"] = '"quoted"'
        self.assertEqual(parse(dump(model))["meta"]["ref"], '"quoted"')

    def test_crlf_input(self):
        self.assertEqual(parse(example_text().replace("\n", "\r\n")), parse(example_text()))

    def test_unsupported_schema(self):
        self.assertSyntax(swap(example_text(), "schema: tracker-brief/1", "schema: tracker-brief/2"), "schema-unsupported", 2)

    def test_missing_schema(self):
        self.assertSyntax(swap(example_text(), "schema: tracker-brief/1\n", ""), "schema-unsupported")

    def test_missing_frontmatter(self):
        self.assertSyntax("# Title\n", "frontmatter", 1)
        self.assertSyntax("---\nschema: tracker-brief/1\n", "frontmatter", 1)

    def test_bad_frontmatter_line(self):
        self.assertSyntax(swap(example_text(), "synthesis: model", "synthesis model"), "frontmatter", 10)

    def test_duplicate_frontmatter_key(self):
        self.assertSyntax(swap(example_text(), "synthesis: model", "synthesis: model\nsynthesis: minimal"), "key-duplicate", 11)

    def test_missing_heading(self):
        text = example_text()
        start = text.index("## Unknowns and conflicts")
        end = text.index("## Follow-up paths")
        diags = self.assertSyntax(text[:start] + text[end:], "heading-missing")
        self.assertIn("Unknowns and conflicts", diags[0].message)

    def test_duplicate_heading(self):
        text = example_text()
        self.assertSyntax(text + "\n## What changed\n", "heading-duplicate", len(text.split("\n")) + 1)

    def test_out_of_order_heading(self):
        text = example_text()
        a = text.index("## What changed")
        b = text.index("## Still active")
        c = text.index("## Issues and work items")
        swapped = text[:a] + text[b:c] + text[a:b] + text[c:]
        self.assertSyntax(swapped, "heading-order", line_of(swapped, "## What changed"))

    def test_unknown_heading(self):
        text = swap(example_text(), "## Evidence\n", "## Evidence\n\n## Extras\n")
        self.assertSyntax(text, "heading-unknown", line_of(text, "## Extras"))

    def test_record_type_must_match_section(self):
        text = swap(example_text(), "```change\nid: chg-export", "```active\nid: chg-export")
        self.assertSyntax(text, "record-type", line_of(text, "```active"))

    def test_unclosed_fence(self):
        text = swap(example_text(), "  - ev-pr-2\n```\n\n## Still active", "  - ev-pr-2\n\n## Still active")
        self.assertSyntax(text, "fence-unclosed", line_of(text, "id: chg-export") - 1)

    def test_duplicate_record_key(self):
        text = swap(example_text(), "title: Parser merged", "title: Parser merged\ntitle: Again")
        self.assertSyntax(text, "key-duplicate", line_of(text, "title: Again"))

    def test_bad_list_syntax(self):
        text = swap(example_text(), "status: verified\nevidence:\n  - ev-pr-1", "status: verified\n  - ev-pr-1")
        self.assertSyntax(text, "record-syntax")
        text = swap(example_text(), "  - ev-pr-1\n", "   - ev-pr-1\n")
        self.assertSyntax(text, "record-syntax", line_of(text, "   - ev-pr-1"))

    def test_empty_value(self):
        text = swap(example_text(), "requester: coordinator", "requester:")
        self.assertSyntax(text, "value-empty", line_of(text, "requester:"))

    def test_priority_must_be_integer(self):
        text = swap(example_text(), "priority: 1", "priority: high")
        self.assertSyntax(text, "value-int", line_of(text, "priority: high"))

    def test_prose_outside_sections(self):
        text = swap(example_text(), "# Demo restart brief\n", "# Demo restart brief\n\nStray intro text.\n")
        self.assertSyntax(text, "outside-section", line_of(text, "Stray intro text."))

    def test_position_needs_exactly_one_record(self):
        text = example_text()
        start = text.index("```position")
        end = text.index("```", start + 3) + 4
        record = text[start:end]
        self.assertSyntax(swap(text, record, record + "\n" + record.replace("pos-demo", "pos-two")), "count")
        self.assertSyntax(swap(text, record, ""), "count")

    def test_multiple_syntax_errors_are_reported_together(self):
        text = swap(example_text(), "priority: 1", "priority: one")
        text = swap(text, "title: Parser merged", "title: A\ntitle: B")
        codes = {d.code for d in self.syntax_error(text)}
        self.assertEqual(codes, {"value-int", "key-duplicate"})

    def test_diagnostic_format(self):
        self.assertEqual(str(Diagnostic("error", "enum", "bad value", 12)), "line 12: error [enum] bad value")
        self.assertEqual(str(Diagnostic("warning", "budget", "long", None)), "warning [budget] long")


class ValidateTests(unittest.TestCase):
    def diags(self, text, **kwargs):
        return validate(parse(text), **kwargs)

    def assertDiag(self, text, code, line="any", level="error"):
        diags = self.diags(text)
        matches = [d for d in diags if d.code == code and d.level == level]
        self.assertTrue(matches, f"no {level} {code} in {[str(d) for d in diags]}")
        if line != "any":
            self.assertIn(line, [d.line for d in matches], [str(d) for d in diags])
        return matches

    def test_unknown_record_key(self):
        text = swap(example_text(), "title: Parser merged", "title: Parser merged\ncolour: green")
        self.assertDiag(text, "key-unknown", line_of(text, "colour: green"))

    def test_old_owner_key_names_the_new_key(self):
        text = swap(example_text(), "requester: coordinator", "owner: coordinator")
        matches = self.assertDiag(text, "key-unknown", line_of(text, "owner: coordinator"))
        self.assertIn("unknown key 'owner' (renamed to 'requester')", matches[0].message)

    def test_unknown_frontmatter_key(self):
        text = swap(example_text(), "synthesis: model", "synthesis: model\nauthor: someone")
        self.assertDiag(text, "key-unknown", line_of(text, "author: someone"))

    def test_missing_required_key(self):
        text = swap(example_text(), "next: Import sample records", "hint: Import sample records")
        matches = self.assertDiag(text, "key-missing", line_of(text, "```active", 3))
        self.assertIn("'next'", matches[0].message)
        self.assertDiag(text, "key-unknown")

    def test_change_needs_evidence(self):
        text = swap(example_text(), "status: verified\nevidence:\n  - ev-pr-2\n", "status: verified\n")
        self.assertDiag(text, "key-missing")

    def test_duplicate_ids(self):
        text = swap(example_text(), "id: gate-publish", "id: chg-validation")
        self.assertDiag(text, "id-duplicate", line_of(text, "id: chg-validation", 2))

    def test_bad_id_format(self):
        text = swap(example_text(), "id: gate-publish", "id: Gate_Publish")
        self.assertDiag(text, "id-format", line_of(text, "id: Gate_Publish"))

    def test_bad_enums(self):
        for old, new in [
            ("status: verified\nevidence:\n  - ev-pr-2", "status: done\nevidence:\n  - ev-pr-2"),
            ("readiness: needs-decision\nnext:", "readiness: soon\nnext:"),
            ("progress: in-progress", "progress: halfway"),
            ("kind: allowed", "kind: maybe"),
            ("severity: normal", "severity: low"),
            ("role: backlog", "role: someday"),
            ("synthesis: model", "synthesis: magic"),
            ("kind: file\n", "kind: blog\n"),
        ]:
            with self.subTest(new=new):
                text = swap(example_text(), old, new)
                self.assertDiag(text, "enum", line_of(text, new.split("\n")[0]))

    def test_unresolved_evidence(self):
        text = swap(example_text(), "  - ev-pr-2\n```\n\n## Still", "  - ev-missing\n```\n\n## Still")
        self.assertDiag(text, "evidence-unresolved", line_of(text, "  - ev-missing"))

    def test_unresolved_read_first(self):
        text = swap(example_text(), "read_first:\n  - ev-issue-4", "read_first:\n  - ev-nowhere")
        self.assertDiag(text, "evidence-unresolved", line_of(text, "  - ev-nowhere"))

    def test_evidence_must_point_to_evidence_records(self):
        text = swap(example_text(), "  - ev-pr-2\n```\n\n## Still", "  - gate-publication\n```\n\n## Still")
        self.assertDiag(text, "evidence-unresolved")

    def test_unresolved_path_issue(self):
        text = swap(example_text(), "  - #8", "  - unresolved task")
        self.assertDiag(text, "issue-unresolved", line_of(text, "  - unresolved task"))

    def test_unsafe_evidence_refs(self):
        for ref in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "http://git.example.com/owner/demo",
            "data:text/html,<script>alert(1)</script>",
            "https://user:pw@git.example.com/owner",
            "https://token@git.example.com/owner",
            "HTTPS://git.example.com/owner",
            "https://",
            "https://git.example.com/a b",
            "//evil.example.com/x",
            "vbscript:msgbox",
            "file:///etc/passwd",
        ]:
            with self.subTest(ref=ref):
                text = swap(example_text(), "ref: tracker/schema.md", "ref: " + ref)
                self.assertDiag(text, "url-unsafe", line_of(text, "ref: " + ref))

    def test_safe_plain_refs(self):
        for ref in ["a1b2c3d", "tracker/schema.md", "README.md:12", "okf:concept/tracker-brief", "~/git/demo/docs/x.md"]:
            with self.subTest(ref=ref):
                text = swap(example_text(), "ref: tracker/schema.md", "ref: " + ref)
                self.assertEqual(self.diags(text), [])

    def test_unsafe_issue_and_repo_urls(self):
        text = swap(example_text(), "url: https://git.example.com/owner/demo/issues/7", "url: http://git.example.com/owner/demo/issues/7")
        self.assertDiag(text, "url-unsafe", line_of(text, "url: http://git.example.com/owner/demo/issues/7"))
        text = swap(example_text(), "repo_url: https://git.example.com/owner/demo", "repo_url: https://me:secret@git.example.com/owner/demo")
        self.assertDiag(text, "url-unsafe", 4)

    def test_count_limits(self):
        text = swap(example_text(), "## Still active", EXTRA_CHANGE + "## Still active")
        self.assertDiag(text, "count", line_of(text, "id: chg-extra") - 1)
        extra_active = "```active\nid: act-extra\ntitle: X\nreadiness: optional\nnext: Y\npriority: 3\n```\n\n"
        text = swap(example_text(), "## Issues and work items", extra_active + "## Issues and work items")
        self.assertDiag(text, "count")
        text = swap(example_text(), "role: alternative\nreadiness: ready-offline", "role: recommended\nreadiness: ready-offline")
        self.assertDiag(text, "count")
        text = swap(example_text(), "role: backlog", "role: alternative")
        self.assertDiag(text, "count")

    def test_needs_at_least_one_gate(self):
        text = example_text()
        start = text.index("## Approval boundaries")
        end = text.index("## Unknowns and conflicts")
        text = text[:start] + "## Approval boundaries\n\n" + text[end:]
        self.assertDiag(text, "count", line_of(text, "## Approval boundaries"))

    def test_priority_rules(self):
        text = swap(example_text(), "priority: 3", "priority: 4")
        self.assertDiag(text, "priority", line_of(text, "priority: 4"))
        text = swap(example_text(), "priority: 3", "priority: 2")
        self.assertDiag(text, "priority", line_of(text, "priority: 2", 2))

    def test_field_word_limits(self):
        long = " ".join(["word"] * 41)
        text = swap(example_text(), "summary: The export command", "summary: " + long + " The export command")
        self.assertDiag(text, "words")
        text = swap(example_text(), "next: Merge the adapter", "next: " + " ".join(["w"] * 30) + " Merge the adapter")
        self.assertDiag(text, "words")

    def test_word_budget(self):
        base = default_brief_word_count(parse(example_text()))
        filler = " ".join(["more"] * (BUDGET_WARN - base + 1))
        text = swap(example_text(), "objective: Merge the adapter", "objective: " + filler + " Merge the adapter")
        self.assertDiag(text, "budget", level="warning")
        self.assertFalse([d for d in self.diags(text) if d.level == "error"])
        filler = " ".join(["more"] * (BUDGET_ERROR - base + 1))
        text = swap(example_text(), "objective: Merge the adapter", "objective: " + filler + " Merge the adapter")
        self.assertDiag(text, "budget")

    def test_budget_counts_only_default_view_fields(self):
        filler = " ".join(["more"] * 600)
        text = swap(example_text(), "objective: Label an input set", "objective: " + filler + " Label an input set")
        self.assertEqual(self.diags(text), [])  # backlog path text is not in the default brief

    def test_date_format(self):
        text = swap(example_text(), "\nsnapshot: 2030-01-23T06:30:00Z\n", "\nsnapshot: 2030-01-23 06:30\n")
        matches = self.assertDiag(text, "date-format", 6)
        self.assertEqual(matches[0].message, "'snapshot' must be UTC like 2030-01-23T06:00:00Z")
        text = swap(example_text(), "checked: 2030-01-23T06:25:00Z\nworkstream: storage", "checked: 2030-13-01T00:00:00Z\nworkstream: storage")
        matches = self.assertDiag(text, "date-format")
        self.assertEqual(matches[0].message, "'checked' in issue '3' must be UTC like 2030-01-23T06:00:00Z")

    def test_list_and_scalar_types(self):
        text = swap(example_text(), "evidence:\n  - ev-issue-4\n```\n\n## Issues", "evidence: ev-issue-4\n```\n\n## Issues")
        self.assertDiag(text, "value-type", line_of(text, "evidence: ev-issue-4"))
        text = swap(example_text(), "requester: coordinator", "requester:\n  - a\n  - b")
        self.assertDiag(text, "value-type")

    def test_staleness_only_with_now(self):
        model = parse(example_text())
        self.assertEqual(validate(model), [])
        self.assertEqual(validate(model, now="2030-01-25T00:00:00Z"), [])
        stale = validate(model, now="2030-02-05T00:00:00Z")
        self.assertEqual({d.code for d in stale}, {"stale", "stale-evidence"})
        self.assertTrue(all(d.level == "warning" for d in stale))
        future = validate(model, now="2030-01-01T00:00:00Z")
        self.assertIn("time-order", {d.code for d in future})
        with self.assertRaisesRegex(ValueError, r"^now must look like 2030-01-23T06:00:00Z$"):
            validate(model, now="yesterday")

    def test_consistency_warnings(self):
        text = swap(example_text(), "state: closed\nprogress: merged", "state: closed\nprogress: in-progress")
        self.assertDiag(text, "issue-state", level="warning")
        text = swap(example_text(), "previous_snapshot: 2030-01-20T18:00:00Z", "previous_snapshot: 2030-01-24T18:00:00Z")
        self.assertDiag(text, "time-order", 8, level="warning")

    def test_hand_built_model_without_lines(self):
        model = json.loads(json.dumps(parse(example_text())))
        model["changes"][0]["title"] = "two\nlines"
        model["gates"][0]["id"] = model["changes"][1]["id"]
        model["notes"] = {"Nowhere": ["x"]}
        diags = validate(model)
        codes = {d.code for d in diags}
        self.assertTrue({"value-format", "id-duplicate", "notes"} <= codes, codes)
        self.assertTrue(all(d.line is None for d in diags))

    def test_model_shape_errors(self):
        self.assertEqual(validate([])[0].code, "model-shape")
        model = json.loads(json.dumps(parse(example_text())))
        del model["paths"]
        self.assertEqual({d.code for d in validate(model)}, {"model-shape"})


def handoff_record(text):
    """The fenced handoff record of a brief text, fences included."""
    start = text.index("```handoff")
    return text[start:text.index("\n```\n", start) + 4]


def with_handoff_text(text, *rows):
    """Replace the example handoff text block with `text: |` and the given raw lines."""
    record = handoff_record(text)
    head = record[: record.index("text: |")]
    return text.replace(record, head + "text: |\n" + "".join(row + "\n" for row in rows) + "```")


class BlockValueTests(unittest.TestCase):
    def test_example_handoff_parses_as_one_string(self):
        model = parse(example_text())
        [record] = model["handoffs"]
        self.assertEqual(record["path"], "path-merge-storage")
        self.assertIn("\n\n", record["text"], "blank lines inside the block are kept")
        self.assertTrue(record["text"].startswith("You coordinate the next work session"))
        self.assertNotIn("\n  ", record["text"], "the two-space indent is not part of the value")

    def test_blank_lines_and_edges(self):
        text = with_handoff_text(example_text(), "", "  First line.", "", "    Indented more.", "  ", "  - item: x", "", "")
        model = parse(text)
        self.assertEqual(model["handoffs"][0]["text"], "First line.\n\n  Indented more.\n\n- item: x")
        self.assertEqual(validate(model), [])
        text = with_handoff_text(example_text(), "  Trailing spaces go.   ")
        self.assertEqual(parse(text)["handoffs"][0]["text"], "Trailing spaces go.")

    def test_markup_and_fences_stay_text(self):
        rows = ["  <script>alert('x')</script> & more", "  ```", "  ## Not a heading", "  # Not a title", "  key: value"]
        model = parse(with_handoff_text(example_text(), *rows))
        self.assertEqual(model["handoffs"][0]["text"], "\n".join(r[2:] for r in rows))
        self.assertEqual(validate(model), [])
        self.assertEqual(parse(dump(model)), model)

    def test_line_without_indent_is_an_error(self):
        text = with_handoff_text(example_text(), "  Fine.", "Not indented.")
        diags = ParseTests.syntax_error(self, text)
        self.assertEqual([(d.code, d.line) for d in diags], [("block-indent", line_of(text, "Not indented."))])
        text = with_handoff_text(example_text(), "  Fine.", " One space.")
        self.assertEqual({d.code for d in ParseTests.syntax_error(self, text)}, {"block-indent"})
        record = handoff_record(example_text())
        moved = record.replace("basis: current\n", "").replace("\n```", "\nbasis: current\n```")
        text = example_text().replace(record, moved)
        self.assertEqual({d.code for d in ParseTests.syntax_error(self, text)}, {"block-indent"},
                         "a key after the block is inside the block")

    def test_block_on_another_field_is_an_error(self):
        old = "next_action: Collect labeled examples of oversized inputs."
        text = swap(example_text(), old, "next_action: |\n  Collect labeled examples of oversized inputs.")
        diags = ParseTests.syntax_error(self, text)
        self.assertEqual([(d.code, d.line) for d in diags], [("block-field", line_of(text, "next_action: |"))])

    def test_empty_block_is_an_error(self):
        text = with_handoff_text(example_text(), "", "  ")
        self.assertEqual({d.code for d in ParseTests.syntax_error(self, text)}, {"value-empty"})

    def test_one_line_text_is_read_and_dumped_as_a_block(self):
        record = handoff_record(example_text())
        head = record[: record.index("text: |")]
        model = parse(example_text().replace(record, head + "text: One line prompt.\n```"))
        self.assertEqual(model["handoffs"][0]["text"], "One line prompt.")
        self.assertIn("text: |\n  One line prompt.\n```", dump(model))
        self.assertEqual(parse(dump(model)), model)

    def test_dump_round_trip_of_a_hand_built_block(self):
        plain = json.loads(json.dumps(parse(example_text())))
        plain["handoffs"][0]["text"] = "A\n\n  - b\n```\n## c\n<d> & 'e'\n\n\nf"
        out = dump(plain)
        self.assertEqual(parse(out), plain)
        self.assertEqual(dump(parse(out)), out)
        self.assertIn("text: |\n  A\n\n    - b\n  ```\n  ## c\n", out)


class HandoffValidateTests(unittest.TestCase):
    def model(self):
        return json.loads(json.dumps(parse(example_text())))

    def codes(self, model):
        return [d.code for d in validate(model) if d.level == "error"]

    def test_recommended_path_needs_one_handoff(self):
        model = self.model()
        model["handoffs"] = []
        self.assertEqual(self.codes(model), ["handoff"])
        model = self.model()
        model["handoffs"].append(dict(model["handoffs"][0], id="handoff-two"))
        self.assertEqual(self.codes(model), ["handoff"])

    def test_handoff_must_name_the_recommended_path(self):
        model = self.model()
        model["handoffs"][0]["path"] = "path-reconcile"
        self.assertEqual(self.codes(model), ["handoff"])

    def test_no_handoff_without_a_recommended_path(self):
        model = self.model()
        model["paths"][0]["role"] = "backlog"
        self.assertEqual(self.codes(model), ["handoff"])
        model["handoffs"] = []
        self.assertEqual(self.codes(model), [])

    def test_handoff_line_numbers(self):
        text = swap(example_text(), "path: path-merge-storage", "path: path-input-limits")
        diags = [d for d in validate(parse(text)) if d.code == "handoff"]
        self.assertEqual([d.line for d in diags], [line_of(text, "path: path-input-limits")])

    def test_fields_enums_and_dates(self):
        for key, value, code in [
            ("source", "model", "enum"),
            ("basis", "stale", "enum"),
            ("generated", "yesterday", "date-format"),
            ("id", "Handoff_1", "id-format"),
            ("id", "path-merge-storage", "id-duplicate"),
        ]:
            with self.subTest(key=key):
                model = self.model()
                model["handoffs"][0][key] = value
                self.assertIn(code, self.codes(model))
        model = self.model()
        del model["handoffs"][0]["basis"]
        self.assertEqual(self.codes(model), ["key-missing"])
        model = self.model()
        model["handoffs"][0]["colour"] = "green"
        self.assertEqual(self.codes(model), ["key-unknown"])

    def test_text_word_limit_and_format(self):
        model = self.model()
        model["handoffs"][0]["text"] = " ".join(["word"] * 451)
        self.assertEqual(self.codes(model), ["words"])
        model["handoffs"][0]["text"] = " ".join(["word"] * 450)
        self.assertEqual(self.codes(model), [])
        for bad in ["trailing  \nline", "\nleading blank", "ends blank\n", "bell\x07", "cr\r\nline", ["a", "b"], ""]:
            with self.subTest(bad=bad):
                model["handoffs"][0]["text"] = bad
                self.assertEqual(len(self.codes(model)), 1, self.codes(model))
                self.assertIn(self.codes(model)[0], ("value-format", "value-type", "value-empty"))

    def test_line_breaks_stay_errors_elsewhere(self):
        model = self.model()
        model["paths"][0]["objective"] = "two\nlines"
        self.assertEqual(self.codes(model), ["value-format"])

    def test_handoff_text_is_outside_the_budget(self):
        model = self.model()
        before = default_brief_word_count(model)
        model["handoffs"][0]["text"] = " ".join(["word"] * 450)
        self.assertEqual(default_brief_word_count(model), before)

    def test_model_needs_handoffs_key(self):
        model = self.model()
        del model["handoffs"]
        self.assertEqual({d.code for d in validate(model)}, {"model-shape"})


class CliValidateTests(unittest.TestCase):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_valid_file(self):
        code, out, err = self.run_cli("validate", str(EXAMPLE))
        self.assertEqual(code, 0)
        self.assertIn("valid; 0 warning(s); default brief", out)
        self.assertEqual(err, "")

    def test_now_reports_staleness_as_warning(self):
        code, out, err = self.run_cli("validate", str(EXAMPLE), "--now", "2030-02-28T00:00:00Z")
        self.assertEqual(code, 0)
        self.assertIn(f"{EXAMPLE}:6: warning [stale]", err)

    def test_invalid_file_exits_non_zero_with_lines(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.md"
            bad.write_text(swap(example_text(), "status: verified\nevidence:\n  - ev-pr-2", "status: done\nevidence:\n  - ev-pr-2"))
            code, out, err = self.run_cli("validate", str(bad))
            self.assertEqual(code, 1)
            self.assertRegex(err, r"bad\.md:\d+: error \[enum\]")
            bad.write_text(swap(example_text(), "schema: tracker-brief/1", "schema: tracker-brief/9"))
            code, out, err = self.run_cli("validate", str(bad))
            self.assertEqual(code, 1)
            self.assertIn("bad.md:2: error [schema-unsupported]", err)
            code, out, err = self.run_cli("validate", str(Path(tmp) / "missing.md"))
            self.assertEqual(code, 1)

    def test_bad_now_is_a_usage_error(self):
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stderr(io.StringIO()) as err:
            main(["validate", str(EXAMPLE), "--now", "tomorrow"])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("use UTC like 2030-01-23T06:00:00Z", err.getvalue())

    def test_help_uses_the_neutral_date_example(self):
        with self.assertRaises(SystemExit) as ctx, contextlib.redirect_stdout(io.StringIO()) as out:
            main(["validate", "--help"])
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn("2030-01-23T06:00:00Z", out.getvalue())


if __name__ == "__main__":
    unittest.main()
