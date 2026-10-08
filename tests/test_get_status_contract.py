"""Offline contract checks; these do not prove a live handoff."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "packages/tenantext/skills/coordinator-skills/get-status/SKILL.md"
CLOSE = 'herdr pane close "$HERDR_PANE_ID"'
BUNDLE_HEADINGS = [
    "How to work here", "Done since <since> (verified)", "Active", "Next: the frontier",
    "Recommended first action", "User gates and dated items", "Decisions that bind",
    "Environment and blockers", "Sessions (last ten)", "Open questions (unverified)", "Sources",
    "Suggested skills",
]


def section(text, number):
    match = re.search(rf"^## {number}\. .*?(?=^## \d+\. |\Z)", text, re.S | re.M)
    return match[0] if match else ""


class GetStatusContractTests(unittest.TestCase):
    def test_bundle_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        bundle = re.search(r"```markdown\n(# Status bundle:.*?)\n```", text, re.S)
        self.assertIsNotNone(bundle)
        self.assertEqual(re.findall(r"^## (.+)$", bundle[1], re.M), BUNDLE_HEADINGS)

    def test_handshake_and_delivery_guards(self):
        text = SKILL.read_text(encoding="utf-8")
        front = text.split("\n---\n", 1)[0]
        self.assertIn("\ndisable-model-invocation: true", front)
        start, send, close = section(text, 4), section(text, 5), section(text, 6)
        self.assertIn("Not in Herdr:", start)
        self.assertIn("Keep this pane open; do not send `go`.", start)
        for guard in ("`MORE`", "`PLAN`", "Wait for `go` after your PLAN reply.", "After two `MORE` rounds",
                      "Without `PLAN`, report to the user, keep this pane open and send no `go`.",
                      "Never close the new coordinator pane.", "install -m 600"):
            self.assertIn(guard, send)
        for guard in ("Confirm delivery only when the output has a `--- reply ---` line followed by a reply.",
                      "`NO NEW REPLY in the transcript`", "| 124 | `go` is delivered.",
                      "Retry exactly once, only after the first call returns exit 3.",
                      "is not confirmed (ask.py exit <code>)"):
            self.assertIn(guard, close)
        self.assertEqual(text.count(CLOSE), 1)
        self.assertEqual(text.count("--text go"), 1)
        self.assertLess(close.index("--text go --timeout 60"), close.index(CLOSE))
        self.assertIn("install -d -m 700", section(text, 3))
        self.assertTrue(text.rstrip().endswith(CLOSE + "\n```"))


if __name__ == "__main__":
    unittest.main()
