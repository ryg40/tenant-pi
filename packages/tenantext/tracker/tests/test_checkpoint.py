"""Checkpoint packet bounds, the run lock and the stage state machine."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from tracker import checkpoint as cp


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


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


class CheckpointPacketTests(unittest.TestCase):
    def test_packet_stays_under_limit_for_any_session_size(self):
        huge = "word " * 200000
        packet = cp.build_checkpoint(
            run_id="r1", created="2026-09-23T06:00:00Z", repo="owner/demo", repo_url=S.REPO_URL,
            ref="main@abc1234", store_location=".okf/tracker-brief.md", issues_source=S.REPO_URL + "/issues",
            handoffs=["/home/dev/notes/%d.md" % i for i in range(50)], objective=huge,
            changed_files=["src/deep/path/%05d/%s.py" % (i, "x" * 150) for i in range(10000)],
            uncommitted_files=["tmp/%d" % i for i in range(5000)], blockers=[huge] * 40,
            boundaries=[huge] * 40, next_safe_action=huge, notes=[huge] * 40,
            previous={"location": "x" * 5000, "snapshot": "2026-09-20T00:00:00Z"})
        data = cp.encode_checkpoint(packet)
        self.assertLessEqual(len(data), cp.CHECKPOINT_MAX_BYTES)
        self.assertEqual(packet["schema"], cp.CHECKPOINT_SCHEMA)
        self.assertEqual(packet["changed_files"]["count"], 10000)
        self.assertLessEqual(len(packet["changed_files"]["files"]), 25)
        self.assertLessEqual(len(packet["blockers"]), 5)
        self.assertLessEqual(len(packet["sources"]["handoffs"]), 3)
        for key in ("repo", "ref", "objective", "next_safe_action", "approval_boundaries", "previous_brief"):
            self.assertIn(key, packet)

    def test_save_and_load_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            packet = cp.build_checkpoint(run_id="r1", created="2026-09-23T06:00:00Z", repo="owner/demo",
                                         repo_url=S.REPO_URL, ref="main@abc1234", store_location="brief.md")
            path = cp.save_checkpoint(Path(tmp), packet)
            self.assertEqual(cp.load_checkpoint(Path(tmp)), json.loads(path.read_text()))

    def test_redact_and_one_line(self):
        self.assertEqual(cp.redact("token abcd1234 here", ["abcd1234"]), "token [redacted] here")
        self.assertEqual(cp.one_line("a\n b\x00c", 100), "a b c")
        self.assertTrue(cp.one_line("x" * 50, 10).endswith("..."))
        self.assertLessEqual(len(cp.one_line("x" * 50, 10)), 10)


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.clock = S.Clock()

    def tearDown(self):
        self.tmp.cleanup()

    def test_second_lock_is_refused_while_holder_lives(self):
        first = cp.RunLock(self.state, clock=self.clock).acquire()
        with self.assertRaises(cp.LockBusy) as ctx:
            cp.RunLock(self.state, clock=self.clock).acquire()
        self.assertIn("another refresh holds the lock", str(ctx.exception))
        first.release()
        cp.RunLock(self.state, clock=self.clock).acquire().release()

    def test_stale_lock_of_dead_process_is_recovered(self):
        pid = dead_pid()
        cp.RunLock(self.state, clock=self.clock, pid=pid).acquire()  # never released: process "died"
        lock = cp.RunLock(self.state, clock=self.clock).acquire()
        self.assertEqual(lock.recovered["pid"], pid)
        self.assertTrue(list(self.state.glob("lock.stale-*")), "the stale lock is kept for evidence")
        lock.release()

    def test_foreign_host_lock_goes_stale_only_after_timeout(self):
        cp.RunLock(self.state, clock=self.clock, host="devbox-2", pid=12345).acquire()
        with self.assertRaises(cp.LockBusy):
            cp.RunLock(self.state, clock=self.clock, stale_seconds=600).acquire()
        self.clock.advance(seconds=601)
        cp.RunLock(self.state, clock=self.clock, stale_seconds=600).acquire().release()

    def test_release_only_removes_own_lock(self):
        mine = cp.RunLock(self.state, clock=self.clock).acquire()
        other = cp.RunLock(self.state, clock=self.clock)
        other.release()
        self.assertTrue((self.state / "lock").exists())
        mine.release()
        self.assertFalse((self.state / "lock").exists())


class RunStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.run = cp.RunState.create(self.state, run_id="r1", created="2026-09-23T06:00:00Z",
                                      checkpoint_sha="abc", base_source="canonical", max_retries=2)

    def tearDown(self):
        self.tmp.cleanup()

    def test_done_stage_with_same_input_is_a_no_op(self):
        self.assertTrue(self.run.begin("collect", "h1", "t1"))
        self.run.finish("collect", "t2", output_hash="o1")
        self.assertFalse(self.run.begin("collect", "h1", "t3"))
        self.assertEqual(self.run.stage("collect")["attempts"], 1)
        self.assertTrue(self.run.begin("collect", "h2", "t4"), "a new input reruns the stage")

    def test_failures_are_bounded(self):
        for n in range(3):
            self.run.begin("publish", "h", "t")
            self.run.queue("publish", "HTTP 500", "t")
        with self.assertRaises(cp.RetryLimit):
            self.run.begin("publish", "h", "t")
        self.assertEqual(self.run.stage("publish")["failures"], 3)

    def test_state_survives_reload_and_interruptions_are_marked(self):
        self.run.begin("store", "h", "t")
        again = cp.RunState.load(self.state)
        self.assertEqual(again.stage("store")["status"], "running")
        self.assertEqual(again.mark_interrupted("t2"), ["store"])
        self.assertEqual(cp.RunState.load(self.state).stage("store")["status"], "interrupted")

    def test_metrics_record_unknown_tokens_as_null(self):
        self.run.begin("collect", "h", "t")
        self.run.finish("collect", "t")
        self.run.begin("synthesize", "h", "t")
        self.run.finish("synthesize", "t", model_calls=1, input_tokens=None, output_tokens=None)
        totals = self.run.totals()
        self.assertEqual(totals["model_calls"], 1)
        self.assertIsNone(totals["input_tokens"], "unknown tokens stay unknown")
        stage = self.run.stage("collect")
        self.assertEqual((stage["model_calls"], stage["input_tokens"]), (0, 0))
        self.assertIsNotNone(stage["runtime_seconds"])

    def test_complete_after_all_stages(self):
        for name in cp.STAGES[:-1]:
            self.run.begin(name, "h", "t")
            self.run.finish(name, "t")
        self.assertFalse(self.run.data["complete"])
        self.run.skip("publish", "not requested", "t")
        self.assertTrue(self.run.data["complete"])
        self.assertEqual(self.run.unfinished(), [])


class NearContextLimitTests(unittest.TestCase):
    """A checkpoint from a huge session stays bounded and only points at notes."""

    def test_checkpoint_command_is_bounded(self):
        from tracker.refresh import Refresh, load_config
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            repo = S.make_repo(tmp / "repo", 50)
            for i in range(300):
                (repo / ("scratch-%03d-%s.txt" % (i, "y" * 80))).write_text("x")
            base = S.head_short(repo)
            (repo / "docs").mkdir()
            (repo / "docs" / "tracker-brief.md").write_text(S.previous_brief(base, "2026-09-01T00:00:00Z"))
            handoff = tmp / "handoff.md"
            handoff.write_text("SESSION-TRANSCRIPT-LINE\n" * 200000)
            state = tmp / "state"
            S.write_config(state)
            out = []
            refresh = Refresh(load_config(repo_path=repo, state_dir=state, env={}), env={}, out=out.append,
                              clock=S.Clock(), http_get=S.FakeIssueAPI([]))
            code = refresh._locked("checkpoint", refresh.checkpoint, objective="z" * 100000,
                                   handoffs=[str(handoff)], blockers=["b" * 5000] * 20)
            self.assertEqual(code, 0)
            data = (state / "checkpoint.json").read_bytes()
            self.assertLessEqual(len(data), cp.CHECKPOINT_MAX_BYTES)
            self.assertNotIn(b"SESSION-TRANSCRIPT-LINE", data, "the checkpoint points at notes; it does not copy them")
            packet = json.loads(data)
            self.assertEqual(packet["uncommitted_files"]["count"], 301)
            self.assertEqual(packet["previous_brief"]["ref"], "main@" + base)
            self.assertTrue(any("requester approval" in b for b in packet["approval_boundaries"]))
            self.assertEqual(packet["next_safe_action"], "Run the storage tests and fix the first failure.")
            run = cp.RunState.load(state)
            self.assertEqual(run.data["mode"], "incremental")
            self.assertTrue(all(run.stage(n)["status"] == "pending" for n in cp.STAGES))
            # The model packet built from it is bounded too, even with a 4 MB handoff note.
            self.assertEqual(refresh._locked("collect", refresh.collect), 0)
            self.assertEqual(refresh._locked("prepare", refresh.prepare), 0)
            from tracker.refresh import SYNTHESIS_PACKET_MAX_BYTES
            size = (state / "synthesis-input.md").stat().st_size
            self.assertLessEqual(size, SYNTHESIS_PACKET_MAX_BYTES)


if __name__ == "__main__":
    unittest.main()
