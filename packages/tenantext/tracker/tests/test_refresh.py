"""End-to-end refresh flows: long session, days away, failures, duplicates, interruptions, conflicts."""
import importlib.util
import json
import re
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from datetime import timedelta
from pathlib import Path
from unittest import mock

from tracker import checkpoint as cp
from tracker.refresh import (EXIT_BUSY, EXIT_FAILED, EXIT_OK, EXIT_WAITING, SYNTHESIS_PACKET_MAX_BYTES, Refresh,
                             load_config, main)
from tracker.store import OpenKnowledgeStore, PendingQueue


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
HAS_PIPELINE = all(importlib.util.find_spec(m) is not None for m in ("tracker.brief", "tracker.render"))
needs_pipeline = unittest.skipUnless(HAS_PIPELINE, "needs tracker.brief and tracker.render")
GITEA_CANARY = "CANARY-GITEA-TOKEN-0b7e"
BEARER_CANARY = "CANARY-BEARER-TOKEN-91aa"
EDIT_CANARY = "CANARY-EDIT-TOKEN"
PREVIOUS_SNAPSHOT = S.iso(S.EPOCH + timedelta(days=3))


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class Harness:
    """A temp repo with a previous brief, a fake issue API and a fake artifact service."""

    def __init__(self, tmp, *, commits=12, later=5, merge_every=0, issues=None, previous=True,
                 publish=False, config=None):
        self.root = Path(tmp)
        self.repo = S.make_repo(self.root / "repo", commits, merge_every=merge_every)
        self.base = S.head_short(self.repo)
        self.canonical = self.repo / "docs" / "tracker-brief.md"
        if previous:
            self.canonical.parent.mkdir(parents=True)
            self.canonical.write_text(S.previous_brief(self.base, PREVIOUS_SNAPSHOT))
        if later:
            S.add_commits(self.repo, later, start=S.EPOCH + timedelta(days=5), merge_every=merge_every,
                          prefix="Later")
        self.head = S.head_short(self.repo)
        self.state = self.root / "state"
        overrides = dict(config or {})
        if publish:
            cred = self.root / "secrets" / "artifact-token"
            cred.parent.mkdir()
            cred.write_text(BEARER_CANARY)
            overrides["publish"] = {"endpoint": S.ARTIFACTS, "credential_file": str(cred),
                                    "receipt_dir": str(self.root / "receipts")}
        S.write_config(self.state, **overrides)
        self.clock = S.Clock(S.EPOCH + timedelta(days=10))
        self.api = S.FakeIssueAPI(issues if issues is not None else self.default_issues())
        self.service = S.FakeArtifactService(BEARER_CANARY, edit_prefix=EDIT_CANARY)
        self.env = {"GITEA_TOKEN": GITEA_CANARY}
        self.store = None
        self.out: list = []

    @staticmethod
    def default_issues():
        early, late = S.EPOCH + timedelta(days=1), S.EPOCH + timedelta(days=6)
        return [S.issue(2, state="closed", updated=early, title="Parser and validator"),
                S.issue(3, updated=late, title="Storage layer"),
                S.issue(4, updated=early, title="Publication target"),
                S.issue(5, updated=late, title="New follow-up"),
                S.issue(6, state="closed", updated=late, title="Closed while away"),
                S.issue(7, pr=True, updated=late, title="A pull request")]

    def deps(self) -> dict:
        deps = {"env": self.env, "http_get": self.api, "http": self.service, "clock": self.clock,
                "out": self.out.append}
        if self.store is not None:
            deps["store"] = self.store
        return deps

    def refresh(self) -> Refresh:
        config = load_config(repo_path=self.repo, state_dir=self.state, env=self.env)
        return Refresh(config, **self.deps())

    def main(self, *argv) -> int:
        return main(["--repo-path", str(self.repo), "--state-dir", str(self.state), *argv], **self.deps())

    def text(self) -> str:
        return "\n".join(self.out)

    def run_json(self) -> dict:
        return json.loads((self.state / "run.json").read_text())


class ConfigTests(unittest.TestCase):
    def test_default_store_path_uses_docs_directory_not_okf(self):
        for docs, okf, expected in (
                (False, False, "tracker-brief.md"),
                (False, True, "tracker-brief.md"),
                (True, False, "docs/tracker-brief.md"),
                (True, True, "docs/tracker-brief.md")):
            with self.subTest(docs=docs, okf=okf), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                repo = S.make_repo(root / "repo", 1)
                if docs:
                    (repo / "docs").mkdir()
                else:
                    (repo / "docs").write_text("Not a directory\n")
                if okf:
                    (repo / ".okf").mkdir()
                config = load_config(repo_path=repo, state_dir=root / "state", env={})
                self.assertEqual({"backend": "local", "path": expected}, config.store)
                self.assertFalse((repo / expected).exists())

    def test_explicit_store_path_wins_over_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = S.make_repo(root / "repo", 1)
            (repo / "docs").mkdir()
            config_file = root / "config.json"
            config_file.write_text(json.dumps({"store": {"path": ".okf/tracker-brief.md"}}))
            config = load_config(repo_path=repo, state_dir=root / "state",
                                 config_file=config_file, env={})
            self.assertEqual(".okf/tracker-brief.md", config.store["path"])
            config = load_config(repo_path=repo, state_dir=root / "state",
                                 config_file=config_file, env={"TRACKER_STORE_PATH": "custom/brief.md"})
            self.assertEqual("custom/brief.md", config.store["path"])


class PacketTests(unittest.TestCase):
    def test_long_session_packet_stays_bounded(self):
        issues = [S.issue(n, updated=S.EPOCH + timedelta(days=4, minutes=n)) for n in range(10, 410)]
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(tmp, commits=100, later=600, merge_every=7, issues=issues)
            self.assertEqual(h.main("run"), EXIT_WAITING, h.text())
            packet = (h.state / "synthesis-input.md").read_text()
            self.assertLessEqual(len(packet.encode("utf-8")), SYNTHESIS_PACKET_MAX_BYTES)
            facts = json.loads((h.state / "facts.json").read_text())
            count = facts["git"]["commit_count"]
            self.assertGreater(count, 600)
            self.assertIn("commits since base: %d" % count, packet)
            self.assertLessEqual(len(re.findall(r"^- ev-commit-", packet, re.M)), 30)
            self.assertLessEqual(len(re.findall(r"^- ev-issue-", packet, re.M)), 40)
            self.assertIn("## Instructions", packet.replace("# Tracker synthesis step", "## Instructions"))
            self.assertIn("Run the model step in a fresh context", h.text())
            self.assertLessEqual((h.state / "checkpoint.json").stat().st_size, cp.CHECKPOINT_MAX_BYTES)

    def test_days_away_packet_names_changes_since_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(tmp, commits=10, later=5)
            self.assertEqual(h.main("checkpoint"), EXIT_OK)
            self.assertEqual(h.main("collect"), EXIT_OK)
            self.assertEqual(h.main("prepare"), EXIT_OK)
            packet = (h.state / "synthesis-input.md").read_text()
            self.assertIn("commits since base: 5", packet)
            self.assertIn("from previous ref", packet)
            for i in range(5):
                self.assertIn("Later %d" % i, packet)
            self.assertNotIn("| Change 3", packet, "work before the previous checkpoint is not listed again")
            self.assertIn("The parser is merged on main", packet, "previous position is included")
            self.assertIn("path-storage", packet, "previous recommended path is included")
            self.assertIn("snapshot: %s" % PREVIOUS_SNAPSHOT, packet)
            closed = [u for u, _ in h.api.calls if "state=closed" in u]
            self.assertTrue(closed and all("since=" in u for u in closed), "closed issues only since the checkpoint")
            self.assertIn("ev-issue-6", packet)
            self.assertNotIn("ev-issue-2 ", packet, "closed before the checkpoint")
            self.assertNotIn("ev-issue-7", packet, "pull requests are excluded")

    def test_run_waits_for_the_model_step_and_status_says_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(tmp)
            self.assertEqual(h.main("run"), EXIT_WAITING)
            h.out.clear()
            self.assertEqual(h.main("status"), EXIT_OK)
            self.assertIn("synthesize pending", h.text())
            self.assertIn("apply --synthesis FILE", h.text())


class LockTests(unittest.TestCase):
    def test_duplicate_run_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(tmp)
            holder = cp.RunLock(h.state).acquire()
            try:
                self.assertEqual(h.main("run", "--minimal"), EXIT_BUSY)
                self.assertIn("Refused", h.text())
                self.assertFalse((h.state / "run.json").exists(), "the refused run changed nothing")
            finally:
                holder.release()


class StatusTests(unittest.TestCase):
    def test_status_makes_no_network_call(self):
        def boom(*a, **k):
            raise AssertionError("network used by status")
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(tmp)
            with mock.patch.object(urllib.request, "urlopen", boom), mock.patch.object(socket, "create_connection", boom):
                h.api = boom
                h.service = boom
                self.assertEqual(h.main("status"), EXIT_OK)
                self.assertIn("Tracker brief: owner/demo", h.text())
                self.assertIn("Snapshot: %s" % PREVIOUS_SNAPSHOT, h.text())
                self.assertIn("Run: none", h.text())
                h.out.clear()
                self.assertEqual(h.main("status", "--json"), EXIT_OK)
                data = json.loads(h.text())
                self.assertEqual(data["canonical"]["synthesis"], "model")

    def test_modules_outside_collect_and_publish_have_no_network_code(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("checkpoint.py", "store.py", "minimal.py", "refresh.py"):
            source = (root / name).read_text()
            for needle in ("urllib.request", "import socket", "http.client", "urlopen"):
                self.assertNotIn(needle, source, "%s must not hold network code" % name)


@needs_pipeline
class PipelineTests(unittest.TestCase):
    def setUp(self):
        from tracker import brief
        self.brief = brief
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def model(self, text):
        return self.brief.parse(text)

    def test_long_session_yields_a_short_prioritized_brief(self):
        issues = [S.issue(n, updated=S.EPOCH + timedelta(days=4, minutes=n)) for n in range(3, 160)]
        h = Harness(self.tmp.name, commits=50, later=300, merge_every=9, issues=issues)
        self.assertEqual(h.main("run"), EXIT_WAITING)
        output = h.root / "model-output.md"
        output.write_text(S.synthesis("pipeline-synthesis-long.md", h.head))
        code = h.main("run", "--synthesis", str(output), "--model-calls", "1", "--input-tokens", "5200",
                      "--output-tokens", "700")
        self.assertEqual(code, EXIT_OK, h.text())
        stored = h.canonical.read_text()
        model = self.model(stored)
        self.assertEqual(model["meta"]["synthesis"], "model")
        self.assertLessEqual(len(model["changes"]), 3)
        self.assertEqual([p["role"] for p in model["paths"]].count("recommended"), 1)
        self.assertEqual(model["paths"][0]["next_action"], "Draft two options for the requester.")
        self.assertEqual([d for d in self.brief.validate(model) if d.level == "error"], [])
        self.assertIn("Requester note: keep this brief short. Long history belongs in the issue tracker.", stored)
        three = next(i for i in model["issues"] if i["url"].endswith("/issues/3"))
        self.assertEqual(three["progress"], "merged")
        self.assertNotEqual(three["checked"], "2026-01-01T00:00:00Z", "exact fields come from the tracker")
        ev = {e["id"]: e for e in model["evidence"]}
        self.assertEqual(ev["ev-commit-" + h.head]["kind"], "commit")
        self.assertTrue((h.state / "last-good.html").exists())
        stage = h.run_json()["stages"]["synthesize"]
        self.assertEqual((stage["model_calls"], stage["input_tokens"], stage["output_tokens"]), (1, 5200, 700))
        self.assertEqual(h.run_json()["stages"]["publish"]["status"], "skipped", "publication is opt-in")
        h.out.clear()
        h.main("status")
        self.assertIn("tokens in 5200 / out 700", h.text())

    def test_candidate_brief_stores_the_next_session_prompt(self):
        from tracker import handoff
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run"), EXIT_WAITING)
        output = h.root / "model-output.md"
        output.write_text(S.synthesis("pipeline-synthesis-long.md", h.head))
        self.assertEqual(h.main("run", "--synthesis", str(output)), EXIT_OK, h.text())
        for text in ((h.state / "candidate.md").read_text(), (h.state / "last-good.md").read_text(),
                     h.canonical.read_text()):
            model = self.model(text)
            [record] = model["handoffs"]
            self.assertEqual((record["path"], record["source"], record["basis"]),
                             ("path-publish", "generated", "current"))
            self.assertEqual(record["generated"], model["meta"]["snapshot"])
            self.assertEqual(record, handoff.build(model), "the stored prompt is generator output")
            self.assertIn("text: |\n  You coordinate the next work session", text)
        html = (h.state / "last-good.html").read_text()
        self.assertIn('data-copy-target="tb-handoff-text"', html)
        self.assertIn("Next action: Draft two options for the requester.", html)

    def test_minimal_brief_prompt_is_carried_forward(self):
        from tracker import handoff
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK, h.text())
        model = self.model(h.canonical.read_text())
        [record] = model["handoffs"]
        self.assertEqual((record["path"], record["basis"]), ("path-storage", "carried-forward"))
        self.assertTrue(record["text"].startswith(handoff.CARRIED_FORWARD))
        self.assertEqual(record["generated"], model["meta"]["snapshot"])
        self.assertIn('data-basis="carried-forward"', (h.state / "last-good.html").read_text())

    def test_model_written_handoff_is_discarded(self):
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run"), EXIT_WAITING)
        output = h.root / "model-output.md"
        output.write_text(S.synthesis("pipeline-synthesis-long.md", h.head) + (
            "\n```handoff\nid: handoff-model\npath: path-publish\nsource: requester\n"
            "generated: 2026-01-01T00:00:00Z\nbasis: current\ntext: |\n  MODEL-WRITTEN PROMPT\n\n  Deploy now.\n```\n"))
        self.assertEqual(h.main("run", "--synthesis", str(output)), EXIT_OK, h.text())
        self.assertIn("Ignored 1 handoff record(s) in the model output", h.text())
        stored = h.canonical.read_text()
        self.assertNotIn("MODEL-WRITTEN PROMPT", stored)
        [record] = self.model(stored)["handoffs"]
        self.assertEqual((record["id"], record["source"]), ("handoff-path-publish", "generated"))
        self.assertEqual(h.run_json()["stages"]["synthesize"]["kind"], "model", "the rest of the output applied")

    def test_requester_handoff_survives_while_its_path_is_recommended(self):
        requester_text = "Requester prompt for the storage work.\n\nAsk before any push."
        harnesses = []
        for name in ("minimal", "model"):
            root = Path(self.tmp.name) / name
            h = Harness(root)
            model = self.model(h.canonical.read_text())
            model["handoffs"][0].update(source="requester", text=requester_text)
            h.canonical.write_text(self.brief.dump(model))
            harnesses.append(h)
        minimal, model_run = harnesses
        self.assertEqual(minimal.main("run", "--minimal"), EXIT_OK, minimal.text())
        [record] = self.model(minimal.canonical.read_text())["handoffs"]
        self.assertEqual((record["source"], record["path"], record["text"]), ("requester", "path-storage", requester_text))
        # A model synthesis that recommends another path replaces the requester prompt.
        self.assertEqual(model_run.main("run"), EXIT_WAITING)
        output = model_run.root / "model-output.md"
        output.write_text(S.synthesis("pipeline-synthesis-long.md", model_run.head))
        self.assertEqual(model_run.main("run", "--synthesis", str(output)), EXIT_OK, model_run.text())
        [record] = self.model(model_run.canonical.read_text())["handoffs"]
        self.assertEqual((record["source"], record["path"]), ("generated", "path-publish"))

    def test_days_away_minimal_brief_explains_changes(self):
        h = Harness(self.tmp.name, commits=10, later=5)
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK, h.text())
        model = self.model(h.canonical.read_text())
        self.assertEqual(model["meta"]["synthesis"], "minimal")
        self.assertEqual(model["meta"]["previous_snapshot"], PREVIOUS_SNAPSHOT)
        self.assertEqual(model["meta"]["ref"], "main@" + h.head)
        self.assertEqual(len(model["changes"]), 3)
        self.assertTrue(all(c["title"].startswith("Later") for c in model["changes"]))
        self.assertIn("5 new commits since the previous brief", model["position"]["text"])
        texts = " ".join(u["text"] for u in model["unknowns"])
        self.assertIn("carried forward", texts)
        self.assertIn("#6", texts, "an issue closed while away is flagged")
        h.out.clear()
        h.main("status")
        self.assertIn("synthesis minimal", h.text())

    def test_invalid_model_output_gives_an_honest_minimal_brief(self):
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run"), EXIT_WAITING)
        bad = h.root / "bad.md"
        bad.write_text(S.synthesis("pipeline-synthesis-invalid.md"))
        self.assertEqual(h.main("run", "--synthesis", str(bad)), EXIT_OK, h.text())
        model = self.model(h.canonical.read_text())
        self.assertEqual(model["meta"]["synthesis"], "minimal")
        reason = next(u["text"] for u in model["unknowns"] if u["id"].startswith("unk-min-synthesis"))
        self.assertIn("did not complete", reason)
        stage = h.run_json()["stages"]["synthesize"]
        self.assertEqual(stage["kind"], "minimal")
        self.assertIn("model output rejected", stage["error"])
        self.assertIsNone(stage["input_tokens"], "unknown tokens are recorded as null")
        h.out.clear()
        h.main("status")
        self.assertIn("synthesize done (minimal)", h.text())
        self.assertIn("model output rejected", h.text())

    def test_missing_model_output_gives_a_minimal_brief(self):
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run", "--synthesis", str(h.root / "missing.md")), EXIT_OK, h.text())
        stage = h.run_json()["stages"]["synthesize"]
        self.assertIn("missing", stage["error"])
        self.assertEqual(self.model(h.canonical.read_text())["meta"]["synthesis"], "minimal")

    def test_no_fallback_fails_and_keeps_the_canonical_brief(self):
        h = Harness(self.tmp.name)
        before = h.canonical.read_text()
        h.main("run")
        bad = h.root / "bad.md"
        bad.write_text(S.synthesis("pipeline-synthesis-invalid.md"))
        self.assertEqual(h.main("apply", "--synthesis", str(bad), "--no-fallback"), EXIT_FAILED)
        self.assertEqual(h.run_json()["stages"]["synthesize"]["status"], "failed")
        self.assertEqual(h.canonical.read_text(), before)

    def test_store_unavailable_keeps_pending_and_last_good(self):
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK, h.text())
        first = h.canonical.read_text()
        h.store = OpenKnowledgeStore(which=lambda name: None, env={}, mcp_config_paths=[])
        h.clock.advance(days=1)
        S.add_commits(h.repo, 2, start=S.EPOCH + timedelta(days=10), prefix="Offline")
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK, h.text())
        self.assertEqual(h.run_json()["base_source"], "last-good")
        self.assertEqual(h.run_json()["stages"]["store"]["status"], "queued")
        pending = PendingQueue(h.state)
        self.assertIn("Offline 1", pending.text())
        self.assertIn("Offline 1", (h.state / "last-good.md").read_text())
        self.assertTrue((h.state / "last-good.html").exists())
        self.assertEqual(h.canonical.read_text(), first, "the canonical file was not touched")
        h.out.clear()
        h.main("status")
        status = h.text()
        self.assertIn("unavailable", status)
        self.assertIn("Pending: brief queued", status)
        self.assertIn("store queued", status)
        self.assertIn("Next: python3 -m tracker.refresh sync", status)
        h.store = None  # the local store is back
        h.out.clear()
        self.assertEqual(h.main("sync"), EXIT_OK, h.text())
        self.assertIn("Offline 1", h.canonical.read_text())
        self.assertEqual(h.run_json()["stages"]["store"]["status"], "done")

    def test_publish_failure_keeps_local_files_and_queues_a_retry(self):
        h = Harness(self.tmp.name, publish=True)
        h.service.plan = [500]
        self.assertEqual(h.main("run", "--minimal", "--publish"), EXIT_FAILED)
        self.assertTrue((h.state / "candidate.html").exists())
        self.assertTrue((h.state / "last-good.html").exists())
        self.assertIn("synthesis: minimal", h.canonical.read_text(), "the brief was stored before publication")
        queue = json.loads((h.state / "publish-queue.json").read_text())
        self.assertIn("HTTP 500", queue["error"])
        h.out.clear()
        h.main("status")
        self.assertIn("Publication retry queued", h.text())
        self.assertIn("publish queued", h.text())
        h.out.clear()
        self.assertEqual(h.main("publish"), EXIT_OK, h.text())
        self.assertFalse((h.state / "publish-queue.json").exists())
        h.out.clear()
        h.main("status")
        self.assertRegex(h.text(), r"Publication: https://artifacts\.example\.com/a/\S+ \(expires 2026-10-23")

    def test_interrupted_run_resumes_without_duplicates(self):
        h = Harness(self.tmp.name, publish=True)
        for command in (("checkpoint",), ("collect",), ("minimal",), ("validate",), ("render",), ("store",)):
            self.assertEqual(h.main(*command), EXIT_OK, h.text())
        brief_text = (h.state / "candidate.md").read_text()
        # The publish request reached the server, then the process died before it saw the reply.
        h.service.plan = ["lose-response"]
        self.assertEqual(h.main("publish"), EXIT_FAILED)
        self.assertEqual(len(h.service.artifacts), 1)
        run = cp.RunState.load(h.state)
        for name in ("store", "publish"):
            run.stage(name)["status"] = "running"
        run.save()
        cp.RunLock(h.state, pid=dead_pid()).acquire()  # the dead process still "holds" the lock
        h.out.clear()
        self.assertEqual(h.main("run", "--minimal", "--publish"), EXIT_OK, h.text())
        self.assertIn("Recovered an interrupted run", h.text())
        self.assertEqual(len(h.service.artifacts), 1, "no second publication")
        keys = {r["headers"]["Idempotency-Key"] for r in h.service.requests if r["method"] == "POST"}
        self.assertEqual(len(keys), 1, "the idempotency key was reused")
        self.assertEqual(h.canonical.read_text(), brief_text, "one canonical brief, written once")
        self.assertIsNone(PendingQueue(h.state).load())
        data = h.run_json()
        self.assertTrue(data["complete"])
        self.assertEqual(data["stages"]["store"]["result"], "unchanged")

    def test_requester_edit_after_checkpoint_is_never_overwritten(self):
        h = Harness(self.tmp.name)
        for command in (("checkpoint",), ("collect",), ("minimal",), ("validate",)):
            self.assertEqual(h.main(*command), EXIT_OK, h.text())
        requester = h.canonical.read_text() + "\nRequester note added while the refresh ran.\n"
        h.canonical.write_text(requester)
        self.assertEqual(h.main("store"), EXIT_FAILED)
        self.assertEqual(h.canonical.read_text(), requester, "requester edit kept")
        pending = PendingQueue(h.state)
        self.assertTrue(pending.load()["conflict"])
        self.assertIn("synthesis: minimal", pending.text(), "the tool's brief is kept too")
        h.out.clear()
        h.main("status")
        self.assertIn("CONFLICT", h.text())
        self.assertIn("Next: python3 -m tracker.refresh checkpoint", h.text())
        self.assertEqual(h.main("sync"), EXIT_FAILED, "sync refuses too")
        self.assertEqual(h.canonical.read_text(), requester)
        h.out.clear()
        self.assertEqual(h.main("checkpoint"), EXIT_OK)
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK, h.text())
        final = h.canonical.read_text()
        self.assertIn("Requester note added while the refresh ran.", final)
        self.assertIn("synthesis: minimal", final)

    def test_rerunning_a_done_stage_writes_nothing(self):
        h = Harness(self.tmp.name)
        self.assertEqual(h.main("run", "--minimal"), EXIT_OK)
        before = (h.canonical.stat().st_mtime_ns, h.canonical.read_text())
        h.out.clear()
        self.assertEqual(h.main("store"), EXIT_OK)
        self.assertIn("already done", h.text())
        self.assertEqual((h.canonical.stat().st_mtime_ns, h.canonical.read_text()), before)

    def test_no_token_or_credential_text_in_any_output(self):
        h = Harness(self.tmp.name, publish=True)
        h.main("run")
        output = h.root / "model-output.md"
        output.write_text(S.synthesis("pipeline-synthesis-long.md", h.head))
        self.assertEqual(h.main("run", "--synthesis", str(output), "--publish"), EXIT_OK, h.text())
        h.service.plan = [503]
        h.main("run", "--minimal", "--publish")  # a failure path writes errors and queue files too
        h.main("status")
        h.main("status", "--json")
        self.assertTrue(any(hdr.get("Authorization") == "token " + GITEA_CANARY for _, hdr in h.api.calls))
        written = S.all_text(h.state, h.repo) + "\n" + h.text()
        for canary in (GITEA_CANARY, BEARER_CANARY, EDIT_CANARY):
            self.assertNotIn(canary, written)
        receipts = list((h.root / "receipts").glob("*.json"))
        self.assertEqual(len(receipts), 1)
        self.assertIn(EDIT_CANARY, receipts[0].read_text(), "only the private receipt holds the edit token")
        self.assertNotIn(BEARER_CANARY, receipts[0].read_text())


if __name__ == "__main__":
    unittest.main()
