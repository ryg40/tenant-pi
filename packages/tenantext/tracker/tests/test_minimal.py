"""Minimal briefs: verified facts plus the previous brief, labeled honestly."""
import copy
import importlib.util
import sys
import unittest
from pathlib import Path

from tracker.minimal import MINIMAL_PREFIX, build_minimal


def _support():
    name = "tracker_pipeline_support"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, Path(__file__).resolve().parent / "fixtures" / "pipeline_support.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


S = _support()
HAS_BRIEF = importlib.util.find_spec("tracker.brief") is not None
SNAP = "2026-09-10T00:00:00Z"


def facts(commits=6, merges=1, issues_status="ok"):
    rows = []
    for i in range(commits):
        sha = ("%07x" % (0xabc0000 + i)) + "0" * 33
        rows.append({"sha": sha, "short": sha[:7], "date": "2026-09-0%dT00:00:00Z" % (1 + i % 9),
                     "subject": ("Merge pull request 'Topic %d' (#%d)" % (i, i)) if i < merges else "Change %d" % i,
                     "merge": i < merges, "url": S.REPO_URL + "/commit/" + sha})
    return {
        "schema": "tracker-facts/1", "collected": "2026-09-09T23:00:00Z", "repo": S.REPO, "repo_url": S.REPO_URL,
        "git": {"checked": "2026-09-09T23:00:00Z", "branch": "main", "head": rows[0]["sha"] if rows else "f" * 40,
                "ref": "main@" + (rows[0]["short"] if rows else "fffffff"), "base": "1" * 40,
                "base_source": "previous ref", "commit_count": commits, "commits": rows},
        "issues": {"status": issues_status, "checked": "2026-09-09T23:00:00Z", "list_url": S.REPO_URL + "/issues",
                   "error": None if issues_status == "ok" else "HTTP 502",
                   "items": [{"number": 3, "title": "Storage layer", "state": "closed", "url": S.REPO_URL + "/issues/3",
                              "checked": "2026-09-09T23:00:00Z"},
                             {"number": 7, "title": "Old closed", "state": "closed", "url": S.REPO_URL + "/issues/7",
                              "checked": "2026-09-09T23:00:00Z"},
                             {"number": 9, "title": "New", "state": "open", "url": S.REPO_URL + "/issues/9",
                              "checked": "2026-09-09T23:00:00Z"}]},
    }


def previous():
    if HAS_BRIEF:
        from tracker import brief
        return brief.parse(S.previous_brief("1111111", "2026-09-01T00:00:00Z"))
    return {
        "meta": {"schema": "tracker-brief/1", "repo": S.REPO, "repo_url": S.REPO_URL, "ref": "main@1111111",
                 "snapshot": "2026-09-01T00:00:00Z", "evidence_checked": "2026-09-01T00:00:00Z", "scope": "Demo.",
                 "synthesis": "model", "stale_after_days": 7},
        "title": "Demo restart brief",
        "position": {"id": "pos-main", "text": "Old.", "milestone": "Storage layer", "status": "verified"},
        "changes": [{"id": "chg-parser", "title": "Parser merged", "summary": "S.", "status": "verified",
                     "evidence": ["ev-issue-2"]}],
        "active": [{"id": "act-storage", "title": "Storage", "readiness": "ready-offline", "next": "N.", "priority": 1}],
        "issues": [{"id": "3", "title": "Storage layer", "state": "open", "progress": "in-progress",
                    "url": S.REPO_URL + "/issues/3", "checked": "2026-09-01T00:00:00Z"}],
        "gates": [{"id": "gate-deploy", "kind": "approval", "text": "Ask first."}],
        "unknowns": [],
        "paths": [{"id": "path-storage", "title": "Finish the storage layer", "role": "recommended"},
                  {"id": "path-docs", "title": "Tidy the docs", "role": "backlog"}],
        "evidence": [{"id": "ev-issue-2", "label": "I2", "kind": "issue", "ref": S.REPO_URL + "/issues/2",
                      "confidence": "verified"}],
        "notes": {"Where things stand": ["Owner note: keep this brief short. Long history belongs in the issue tracker."]},
    }


class MinimalTests(unittest.TestCase):
    def build(self, prev=None, f=None, reason="model output failed validation"):
        return build_minimal(prev, f or facts(), repo=S.REPO, repo_url=S.REPO_URL, scope="Demo.",
                             title="Demo restart brief", snapshot=SNAP, reason=reason)

    def test_labels_and_facts(self):
        prev = previous()
        model = self.build(copy.deepcopy(prev))
        self.assertEqual(model["meta"]["synthesis"], "minimal")
        self.assertEqual(model["meta"]["previous_snapshot"], "2026-09-01T00:00:00Z")
        self.assertTrue(model["position"]["text"].startswith("Scripted facts only"))
        self.assertNotIn("milestone", model["position"], "no carried milestone claim")
        self.assertLessEqual(len(model["changes"]), 3)
        self.assertTrue(all(c["status"] == "verified" and c["evidence"][0].startswith("ev-commit-")
                            for c in model["changes"]))
        self.assertIn("Merge pull request", model["changes"][0]["title"], "merged work is preferred")
        cited = {e for c in model["changes"] for e in c["evidence"]}
        self.assertTrue(cited <= {e["id"] for e in model["evidence"]}, "every cited commit has a record")
        unknowns = {u["id"]: u for u in model["unknowns"]}
        self.assertIn("model output failed validation", unknowns[MINIMAL_PREFIX + "synthesis"]["text"])
        self.assertIn("carried forward", unknowns[MINIMAL_PREFIX + "carried-path"]["text"])
        self.assertIn("unverified", unknowns[MINIMAL_PREFIX + "carried-path"]["text"])
        self.assertIn("Finish the storage layer", unknowns[MINIMAL_PREFIX + "carried-path"]["text"])
        self.assertEqual(model["notes"], prev["notes"])

    def test_never_invents_a_next_step(self):
        prev = previous()
        model = self.build(copy.deepcopy(prev))
        self.assertEqual(model["paths"], prev["paths"], "paths are carried forward unchanged, never new")
        self.assertEqual(model["active"], prev["active"])
        self.assertEqual(model["gates"], prev["gates"])
        first = facts()
        first["git"].update(base=None, base_source="none")
        empty = self.build(None, first)
        self.assertEqual(empty["paths"], [])
        self.assertEqual(empty["changes"], [])
        self.assertEqual([g["kind"] for g in empty["gates"]], ["approval"], "a conservative default gate")

    @unittest.skipUnless(HAS_BRIEF, "needs tracker.brief")
    def test_owner_handoff_is_carried_like_owner_content(self):
        from tracker import brief, handoff
        prev = previous()
        prev["handoffs"][0].update(source="owner", text="Owner prompt.\n\nKeep it.")
        model = self.build(copy.deepcopy(prev))
        self.assertEqual(model["handoffs"], prev["handoffs"])
        refreshed = handoff.refresh(model, basis="carried-forward")
        self.assertEqual(refreshed["handoffs"], prev["handoffs"])
        generated = self.build(previous())
        refreshed = handoff.refresh(generated, basis="carried-forward")
        self.assertEqual(refreshed["handoffs"][0]["basis"], "carried-forward")
        self.assertEqual(refreshed["handoffs"][0]["generated"], SNAP)
        self.assertEqual([d for d in brief.validate(refreshed) if d.level == "error"], [])
        self.assertEqual(self.build(None)["handoffs"], [])

    def test_issue_facts_and_conflicts_are_reported(self):
        model = self.build(previous())
        by_url = {i["url"]: i for i in model["issues"]}
        self.assertEqual(by_url[S.REPO_URL + "/issues/3"]["state"], "closed")
        self.assertEqual(by_url[S.REPO_URL + "/issues/3"]["progress"], "in-progress")
        self.assertIn(S.REPO_URL + "/issues/9", by_url)
        texts = " ".join(u["text"] for u in model["unknowns"])
        self.assertIn("#3", texts, "state change is flagged")
        self.assertIn("#7", texts, "closed issue without a record is flagged, not invented")

    def test_issue_tracker_unavailable(self):
        model = self.build(previous(), facts(issues_status="error"))
        kinds = {u["id"]: u["kind"] for u in model["unknowns"]}
        self.assertEqual(kinds[MINIMAL_PREFIX + "issues"], "inaccessible")

    def test_rebuilding_does_not_duplicate_minimal_unknowns(self):
        once = self.build(previous())
        twice = self.build(once)
        ids = [u["id"] for u in twice["unknowns"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sum(1 for i in ids if i.startswith(MINIMAL_PREFIX + "synthesis")), 1)

    @unittest.skipUnless(HAS_BRIEF, "needs tracker.brief")
    def test_minimal_brief_validates_within_budget(self):
        from tracker import brief
        for prev in (previous(), None):
            model = self.build(prev, facts(commits=30, merges=5))
            text = brief.dump(model)
            errors = [d for d in brief.validate(brief.parse(text)) if d.level == "error"]
            self.assertEqual(errors, [], text)
            self.assertIn("synthesis: minimal", text)


if __name__ == "__main__":
    unittest.main()
