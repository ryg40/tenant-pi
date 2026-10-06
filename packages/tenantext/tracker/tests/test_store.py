"""Storage adapters, the pending queue, record fragments and incremental updates."""
import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from tracker import store as st


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


class LocalStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = st.LocalFileStore(self.root / ".okf" / "tracker-brief.md", root=self.root)
        self.queue = st.PendingQueue(self.root / "state")

    def tearDown(self):
        self.tmp.cleanup()

    def test_read_write_with_revisions(self):
        self.assertEqual(self.store.read(), (None, None))
        rev = self.store.write("one\n", None)
        self.assertEqual(self.store.read(), ("one\n", rev))
        self.assertEqual(self.store.location, ".okf/tracker-brief.md")
        rev2 = self.store.write("two\n", rev)
        self.assertNotEqual(rev, rev2)

    def test_requester_edit_after_read_refuses_the_write(self):
        rev = self.store.write("base\n", None)
        self.store.path.write_text("base\nrequester edit\n")
        with self.assertRaises(st.ConflictError):
            self.store.write("tool update\n", rev)
        self.assertEqual(self.store.path.read_text(), "base\nrequester edit\n", "requester edit is untouched")

    def test_store_brief_conflict_keeps_both(self):
        rev = self.store.write("base\n", None)
        self.store.path.write_text("requester edit\n")
        result = st.store_brief(self.store, self.queue, "tool update\n", base_revision=rev)
        self.assertEqual(result["result"], "conflict")
        self.assertEqual(self.store.path.read_text(), "requester edit\n")
        self.assertEqual(self.queue.text(), "tool update\n")
        self.assertTrue(self.queue.load()["conflict"])

    def test_store_brief_is_idempotent(self):
        rev = self.store.write("base\n", None)
        self.assertEqual(st.store_brief(self.store, self.queue, "new\n", base_revision=rev)["result"], "stored")
        again = st.store_brief(self.store, self.queue, "new\n", base_revision=rev)
        self.assertEqual(again["result"], "unchanged", "a rerun after an interruption writes nothing")


class OpenKnowledgeTests(unittest.TestCase):
    def test_not_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = st.OpenKnowledgeStore(which=lambda name: None, env={}, mcp_config_paths=[Path(tmp) / "none.json"])
            info = store.detect()
            self.assertFalse(info["available"])
            self.assertFalse(info["write_verified"])
            self.assertIn("not installed", info["reason"])
            with self.assertRaises(st.StoreUnavailable):
                store.read()
            with self.assertRaises(st.StoreUnavailable):
                store.write("x", None)

    def test_cli_found_is_still_not_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = st.OpenKnowledgeStore(which=lambda name: "/home/dev/bin/ok", env={}, mcp_config_paths=[])
            info = store.detect()
            self.assertFalse(info["available"])
            self.assertIn("not verified", info["reason"])

    def test_mcp_config_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "claude.json"
            config.write_text('{"mcpServers": {"open-knowledge": {"command": "ok"}}}')
            store = st.OpenKnowledgeStore(which=lambda name: None, env={}, mcp_config_paths=[config])
            info = store.detect()
            self.assertTrue(info["mcp_configured"])
            self.assertIn("MCP tools run in the agent", info["reason"])


class PendingQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = st.LocalFileStore(self.root / "brief.md")
        self.queue = st.PendingQueue(self.root / "state")

    def tearDown(self):
        self.tmp.cleanup()

    def test_unavailable_store_queues_then_sync_applies(self):
        rev = self.store.write("base\n", None)
        down = st.OpenKnowledgeStore(which=lambda name: None, env={}, mcp_config_paths=[])
        result = st.store_brief(down, self.queue, "new\n", base_revision=rev)
        self.assertEqual(result["result"], "pending")
        self.assertEqual(self.queue.sync(down)["result"], "unavailable")
        self.assertEqual(self.queue.text(), "new\n", "still pending")
        self.assertEqual(self.queue.sync(self.store)["result"], "applied")
        self.assertEqual(self.store.path.read_text(), "new\n")
        self.assertIsNone(self.queue.load())
        self.assertTrue(list(self.queue.dir.glob("synced-*/brief.md")), "applied briefs are archived, not deleted")

    def test_sync_refuses_when_requester_edited(self):
        rev = self.store.write("base\n", None)
        self.queue.enqueue("new\n", base_revision=rev, location="brief.md", reason="down")
        self.store.path.write_text("requester edit\n")
        result = self.queue.sync(self.store)
        self.assertEqual(result["result"], "conflict")
        self.assertEqual(self.store.path.read_text(), "requester edit\n")
        self.assertEqual(self.queue.text(), "new\n")
        self.assertTrue(self.queue.load()["conflict"])

    def test_newer_pending_supersedes_without_deleting(self):
        self.queue.enqueue("one\n", base_revision=None, location="x", reason="down")
        self.queue.enqueue("two\n", base_revision=None, location="x", reason="down")
        self.assertEqual(self.queue.text(), "two\n")
        archived = list(self.queue.dir.glob("superseded-*/brief.md"))
        self.assertEqual([p.read_text() for p in archived], ["one\n"])

    def test_last_good_keeps_previous_copy(self):
        lg = st.LastGood(self.root / "state")
        lg.save_brief("a\n", {"snapshot": "s1"})
        self.assertTrue(lg.save_html("<p>a</p>", "a\n"))
        self.assertFalse(lg.save_html("<p>b</p>", "b\n"), "HTML must match the saved brief")
        lg.save_brief("b\n", {"snapshot": "s2"})
        self.assertEqual(lg.text(), "b\n")
        self.assertEqual((self.root / "state" / "last-good.prev.md").read_text(), "a\n")


class FragmentTests(unittest.TestCase):
    def test_parse_records_lists_ints_and_retire(self):
        text = S.synthesis("pipeline-synthesis-long.md", "abc1234") + "\n```retire\nids:\n  - ev-old\n```\n"
        frag = st.parse_fragment(text)
        types = [t for t, _, _ in frag["records"]]
        self.assertEqual(types.count("change"), 3)
        self.assertEqual(types.count("path"), 2)
        active = next(r for t, r, _ in frag["records"] if t == "active")
        self.assertEqual(active["priority"], 1)
        self.assertEqual(active["evidence"], ["ev-issue-4"])
        self.assertEqual(frag["retire"], ["ev-old"])

    def test_outer_markdown_wrapper_is_removed(self):
        frag = st.parse_fragment("```markdown\n```gate\nid: g1\nkind: allowed\ntext: Offline work.\n```\n```\n")
        self.assertEqual(frag["records"][0][1], {"id": "g1", "kind": "allowed", "text": "Offline work."})

    def test_errors_have_line_numbers(self):
        for text, needle in (("```bogus\nid: x\n```\n", "unknown record type"),
                             ("```gate\nid: x\n", "not closed"),
                             ("```gate\nid: x\nid: y\n```\n", "duplicate key"),
                             ("```active\npriority: high\n```\n", "integer"),
                             ("```gate\nthis is prose\n```\n", "cannot read")):
            with self.assertRaises(st.FragmentError) as ctx:
                st.parse_fragment(text)
            self.assertIn(needle, str(ctx.exception))
            self.assertIn("line", str(ctx.exception))

    def test_lenient_mode_skips_requester_code_blocks(self):
        text = "prose\n```sh\nnpm test\n```\n```gate\nid: g\nkind: allowed\ntext: t\n```\n"
        frag = st.parse_fragment(text, strict=False)
        self.assertEqual([t for t, _, _ in frag["records"]], ["gate"])

    def test_format_round_trip(self):
        record = {"id": "p", "title": "T", "acceptance": ["a", "b"], "priority": 2}
        frag = st.parse_fragment(st.format_record("active", record))
        self.assertEqual(frag["records"][0][1], record)

    def test_handoff_block_values(self):
        text = ("```handoff\nid: handoff-a\npath: path-a\nsource: generated\ngenerated: 2026-09-01T00:00:00Z\n"
                "basis: current\ntext: |\n  First line.\n\n  - item\n    indented\n\n```\n")
        [(rtype, record, _)] = st.parse_fragment(text)["records"]
        self.assertEqual(rtype, "handoff")
        self.assertEqual(record["text"], "First line.\n\n- item\n  indented")
        self.assertEqual(st.parse_fragment(st.format_record("handoff", record))["records"][0][1], record)
        with self.assertRaises(st.FragmentError) as ctx:
            st.parse_fragment("```handoff\nid: h\ntext: |\n  ok\nnot indented\n```\n")
        self.assertIn("bad indentation", str(ctx.exception))
        with self.assertRaises(st.FragmentError) as ctx:
            st.parse_fragment("```change\nid: c\nsummary: |\n  two\n  lines\n```\n")
        self.assertIn("cannot take a '|' block value", str(ctx.exception))

    def test_previous_brief_with_a_handoff_parses_leniently(self):
        records = st.parse_fragment(S.previous_brief("abc1234", "2026-09-01T00:00:00Z"), strict=False)["records"]
        handoffs = [r for t, r, _ in records if t == "handoff"]
        self.assertEqual(len(handoffs), 1)
        self.assertIn("\n\n", handoffs[0]["text"])

    def test_read_frontmatter(self):
        meta = st.read_frontmatter(S.previous_brief("abc1234", "2026-09-01T00:00:00Z"))
        self.assertEqual(meta["ref"], "main@abc1234")
        self.assertEqual(meta["synthesis"], "model")


def base_model():
    return {
        "meta": {"schema": "tracker-brief/1", "repo": S.REPO, "repo_url": S.REPO_URL, "ref": "main@1111111",
                 "snapshot": "2026-09-01T00:00:00Z", "evidence_checked": "2026-09-01T00:00:00Z",
                 "scope": "Demo.", "synthesis": "model", "stale_after_days": 7},
        "title": "Demo",
        "position": {"id": "pos", "text": "Old position.", "status": "verified"},
        "changes": [{"id": "chg-old", "title": "Old", "summary": "Old change.", "status": "verified",
                     "evidence": ["ev-a"]}],
        "active": [{"id": "act-a", "title": "A", "readiness": "ready-offline", "next": "Do A.", "priority": 1}],
        "issues": [{"id": "3", "title": "Old title", "state": "open", "progress": "in-progress",
                    "url": S.REPO_URL + "/issues/3", "checked": "2026-09-01T00:00:00Z"}],
        "gates": [{"id": "gate-a", "kind": "approval", "text": "Ask first."}],
        "unknowns": [{"id": "unk-a", "kind": "missing", "severity": "normal", "text": "Unknown A."}],
        "paths": [{"id": "path-a", "title": "Path A", "role": "recommended"}],
        "evidence": [{"id": "ev-a", "label": "A", "kind": "note", "ref": "note", "confidence": "reported"}],
        "notes": {"Where things stand": ["Requester note: keep it short."]},
    }


class MergeTests(unittest.TestCase):
    def test_sections_replace_only_when_emitted(self):
        base = base_model()
        frag = st.parse_fragment("```position\nid: pos\ntext: New.\nstatus: verified\n```\n"
                                 "```unknown\nid: unk-b\nkind: stale\nseverity: normal\ntext: B.\n```\n"
                                 "```evidence\nid: ev-b\nlabel: B\nkind: note\nref: n\nconfidence: reported\n```\n")
        merged = st.merge_update(base, frag)
        self.assertEqual(merged["position"]["text"], "New.")
        self.assertEqual(merged["changes"], [], "changes never carry into a new snapshot")
        self.assertEqual([u["id"] for u in merged["unknowns"]], ["unk-b"], "emitted section is replaced")
        self.assertEqual(merged["active"], base["active"], "omitted section is kept")
        self.assertEqual(merged["gates"], base["gates"])
        self.assertEqual(merged["paths"], base["paths"])
        self.assertEqual([e["id"] for e in merged["evidence"]], ["ev-a", "ev-b"], "evidence merges by id")
        self.assertEqual(merged["notes"], base["notes"])
        self.assertEqual(base["position"]["text"], "Old position.", "the base model is not mutated")

    def test_gates_merge_so_leaving_one_out_never_drops_it(self):
        frag = st.parse_fragment("```gate\nid: gate-b\nkind: forbidden\ntext: Never deploy.\n```\n")
        merged = st.merge_update(base_model(), frag)
        self.assertEqual([g["id"] for g in merged["gates"]], ["gate-a", "gate-b"])
        frag = st.parse_fragment("```retire\nids:\n  - gate-a\n```\n")
        self.assertEqual(st.merge_update(base_model(), frag)["gates"], [], "only an explicit retire removes a gate")

    def test_paths_replace_leading_roles_and_keep_backlog(self):
        base = base_model()
        base["paths"] = [{"id": "path-a", "role": "recommended"}, {"id": "path-b", "role": "alternative"},
                         {"id": "path-requester", "role": "backlog"}]
        frag = st.parse_fragment("```path\nid: path-new\ntitle: New\nrole: recommended\n```\n")
        merged = st.merge_update(base, frag)
        self.assertEqual([p["id"] for p in merged["paths"]], ["path-new", "path-requester"])
        frag = st.parse_fragment("```path\nid: path-extra\ntitle: Extra\nrole: backlog\n```\n")
        merged = st.merge_update(base, frag)
        self.assertEqual([p["id"] for p in merged["paths"]], ["path-a", "path-b", "path-requester", "path-extra"],
                         "a backlog-only update keeps the recommended and alternative paths")
        frag = st.parse_fragment("```path\nid: path-a\ntitle: A\nrole: backlog\n```\n"
                                 "```path\nid: path-b\ntitle: B\nrole: recommended\n```\n")
        merged = st.merge_update(base, frag)
        self.assertEqual([(p["id"], p["role"]) for p in merged["paths"]],
                         [("path-b", "recommended"), ("path-a", "backlog"), ("path-requester", "backlog")])

    def test_issue_merge_and_retire(self):
        frag = st.parse_fragment("```issue\nid: 3\ntitle: T\nstate: open\nprogress: merged\nurl: %s/issues/3\n"
                                 "checked: 2026-09-02T00:00:00Z\n```\n```retire\nids:\n  - ev-a\n  - unk-a\n```\n"
                                 % S.REPO_URL)
        merged = st.merge_update(base_model(), frag)
        self.assertEqual(len(merged["issues"]), 1)
        self.assertEqual(merged["issues"][0]["progress"], "merged")
        self.assertEqual(merged["evidence"], [])
        self.assertEqual(merged["unknowns"], [])

    def test_fragment_handoffs_are_ignored_by_the_merge(self):
        base = base_model()
        base["handoffs"] = [{"id": "handoff-path-a", "path": "path-a", "source": "requester",
                             "generated": "2026-09-01T00:00:00Z", "basis": "current", "text": "Requester."}]
        frag = st.parse_fragment("```handoff\nid: handoff-x\npath: path-a\nsource: generated\n"
                                 "generated: 2026-09-02T00:00:00Z\nbasis: current\ntext: |\n  Model text.\n```\n")
        self.assertEqual(st.merge_update(base, frag)["handoffs"], base["handoffs"])
        self.assertEqual(st.empty_model({}, "T")["handoffs"], [])
        self.assertIn("handoff-path-a", st.all_ids(base))

    def test_two_positions_are_rejected(self):
        frag = st.parse_fragment("```position\nid: a\ntext: A.\nstatus: verified\n```\n"
                                 "```position\nid: b\ntext: B.\nstatus: verified\n```\n")
        with self.assertRaises(st.FragmentError):
            st.merge_update(base_model(), frag)

    def test_issue_facts_overlay(self):
        model = base_model()
        issues = {"status": "ok", "checked": "2026-09-05T00:00:00Z", "list_url": S.REPO_URL + "/issues", "items": [
            {"number": 3, "title": "Storage layer", "state": "closed", "url": S.REPO_URL + "/issues/3",
             "checked": "2026-09-05T00:00:00Z"},
            {"number": 9, "title": "New work", "state": "open", "url": S.REPO_URL + "/issues/9",
             "checked": "2026-09-05T00:00:00Z"},
            {"number": 8, "title": "Done elsewhere", "state": "closed", "url": S.REPO_URL + "/issues/8",
             "checked": "2026-09-05T00:00:00Z"}]}
        summary = st.apply_issue_facts(model, issues)
        three = model["issues"][0]
        self.assertEqual((three["state"], three["title"], three["progress"]), ("closed", "Storage layer", "in-progress"),
                         "exact fields from the tracker; progress stays as the brief states it")
        self.assertEqual(summary["state_changed"], [3])
        new = model["issues"][1]
        self.assertEqual((new["id"], new["progress"]), ("issue-9", "not-started"))
        self.assertIn("not assessed", new["note"])
        self.assertEqual(summary["untracked_closed"], [8], "no invented progress for unknown closed issues")
        self.assertFalse(st.apply_issue_facts(model, {"status": "error"})["applied"])

    def test_cited_fact_evidence_is_resolved_exactly(self):
        model = base_model()
        model["changes"] = [{"id": "c", "title": "T", "summary": "S.", "status": "verified",
                             "evidence": ["ev-commit-abc1234", "ev-issue-3"]}]
        model["evidence"].append({"id": "ev-issue-3", "label": "typo", "kind": "url",
                                  "ref": "https://wrong.example.com", "confidence": "verified"})
        facts = {"git": {"checked": "t", "commits": [{"short": "abc1234", "subject": "Fix", "url": S.REPO_URL + "/commit/abc1234"}]},
                 "issues": {"status": "ok", "checked": "t", "list_url": S.REPO_URL + "/issues",
                            "items": [{"number": 3, "title": "Storage", "url": S.REPO_URL + "/issues/3", "checked": "t"}]}}
        st.add_fact_evidence(model, facts)
        by_id = {e["id"]: e for e in model["evidence"]}
        self.assertEqual(by_id["ev-commit-abc1234"]["kind"], "commit")
        self.assertEqual(by_id["ev-issue-3"]["ref"], S.REPO_URL + "/issues/3", "facts replace model-typed links")

    @unittest.skipUnless(HAS_BRIEF, "needs tracker.brief")
    def test_requester_notes_survive_byte_for_byte(self):
        from tracker import brief
        text = S.previous_brief("abc1234", "2026-09-01T00:00:00Z")
        model = brief.parse(text)
        frag = st.parse_fragment("```position\nid: pos-main\ntext: New position.\nstatus: verified\n```\n")
        out = brief.dump(st.merge_update(model, frag))
        for note in ("Requester note: keep this brief short. Long history belongs in the issue tracker.",
                     "Requester note: the requester reviews every publication.",
                     "Requester note: evidence links point at the placeholder host."):
            self.assertIn(note, out)
        self.assertEqual(brief.parse(out)["notes"], model["notes"])
        self.assertEqual(brief.parse(out)["paths"], model["paths"], "unchanged sections are not regenerated")


if __name__ == "__main__":
    unittest.main()
