"""Offline parser, request and ledger tests. No AWS command reaches a real subprocess."""
from contextlib import redirect_stderr
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import memory_submit as submit

SAMPLE = Path(__file__).resolve().parents[1] / "config/memory-candidates.example.md"


def candidate(n=1, text="Example text", namespace="/shared/"):
    return {"source": f"wiki://example/record-{n}", "namespace": namespace, "text": text}


def ledger():
    return {"schemaVersion": 1, "memoryId": "mem-EXAMPLE", "region": "us-east-1", "records": {}, "pending": None}


def args(tmp_path, records=None, *extra):
    file = tmp_path / "candidates.json"
    file.write_text(json.dumps(records if records is not None else [candidate()]))
    return [str(file), "--memory-id", "mem-EXAMPLE", "--region", "us-east-1", "--namespace-allow", "/shared/",
            "--ledger", str(tmp_path / "ledger.json"), *extra]


def fake_cli(calls):
    def run(command, **kwargs):
        assert command[:2] == ["aws", "bedrock-agentcore"]
        assert command[-5:] == ["--region", "us-east-1", "--output", "json", "--no-cli-pager"]
        assert kwargs == {"capture_output": True, "text": True, "timeout": 120, "check": False}
        path = Path(command[4].removeprefix("file://"))
        assert path.stat().st_mode & 0o777 == 0o600
        body = json.loads(path.read_text())
        calls.append((command[2], body, path))
        assert "recordExpirySpecification" not in body
        result = []
        for index, record in enumerate(body["records"]):
            assert "timestamp" in record
            entry = {"status": "SUCCEEDED", "memoryRecordId": record.get("memoryRecordId", f"record-{index}")}
            if "requestIdentifier" in record:
                entry["requestIdentifier"] = record["requestIdentifier"]
            result.append(entry)
        return SimpleNamespace(returncode=0, stdout=json.dumps({"successfulRecords": result[::-1], "failedRecords": []}))
    return run


class MemorySubmitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp_path = Path(temporary.name)

    def test_parsers(self):
        self.assertEqual(submit.parse_candidates(json.dumps([candidate()]), "json"), [candidate()])
        records = submit.parse_candidates(SAMPLE.read_text(), "markdown")
        self.assertEqual(len(records), 3)
        self.assertTrue(all(record["namespace"] == "/shared/" for record in records))
        markdown = "# Title\n\n## Record\nsource: wiki://example/one\nnamespace: /shared/\n\nFirst paragraph.\n\nSecond paragraph.\n"
        parsed = submit.parse_candidates(markdown, "markdown")
        self.assertEqual(parsed, [{"source": "wiki://example/one", "namespace": "/shared/", "text": "First paragraph.\n\nSecond paragraph."}])
        self.assertEqual(submit.parse_candidates(markdown.replace("\n", "\r\n"), "markdown"), parsed)
        for value, form in [("{}", "json"), ("[]", "json"), ("bad", "json"), ("# Empty", "markdown"),
                            ("## Title\nnamespace: /shared/\nsource: wiki://example/one\n\ntext", "markdown")]:
            with self.assertRaises(submit.SubmitError):
                submit.parse_candidates(value, form)

    def test_validation_and_paragraph_split(self):
        text = "a" * 10000 + "\n\n" + "b" * 7000 + "\n\n" + "c" * 9000
        records = submit.prepare_records([candidate(text=text)], ["/shared/"])
        self.assertEqual([len(r["text"]) for r in records], [10000, 7000, 9000])
        self.assertEqual("\n\n".join(r["text"] for r in records), text)
        self.assertEqual([r["partSource"] for r in records], [f"wiki://example/record-1#part-{n}" for n in (1, 2, 3)])
        self.assertEqual(len(submit.split_text("x" * 16000)), 1)
        self.assertEqual(submit.split_text("x" * 16000 + "\n\nend"), ["x" * 16000, "end"])
        with self.assertRaisesRegex(submit.SubmitError, "paragraph"):
            submit.split_text("x" * 16001)
        for patch_value in [{"source": "relative"}, {"source": "https://user:password@example.invalid/a"},
                            {"text": " "}, {"text": None}, {"namespace": "/owner/example/"}, {"extra": 1}]:
            with self.assertRaises(submit.SubmitError):
                submit.prepare_records([{**candidate(), **patch_value}], ["/shared/"])
        with self.assertRaisesRegex(submit.SubmitError, "duplicate"):
            submit.prepare_records([candidate(), candidate()], ["/shared/"])

    def test_stable_identifiers_and_batches(self):
        records = submit.prepare_records([candidate(n) for n in range(201)], ["/shared/"])
        batches = submit.batches(records, ledger(), timestamp="2026-01-01T00:00:00+00:00")
        self.assertEqual([len(b["payload"]["records"]) for b in batches], [100, 100, 1])
        self.assertEqual(len({r["requestIdentifier"] for r in records}), 201)
        self.assertEqual(submit.request_identifier(records[0]["source"], 1), records[0]["requestIdentifier"])
        changed = submit.prepare_records([candidate(0, "Changed text")], ["/shared/"])
        self.assertEqual(changed[0]["requestIdentifier"], records[0]["requestIdentifier"])
        self.assertNotEqual(submit.request_identifier(records[0]["source"], 2), records[0]["requestIdentifier"])
        self.assertEqual(submit.batches(records, ledger(), timestamp="2026-01-01T00:00:00+00:00"), batches)

    def test_default_dry_run_writes_nothing_and_has_bounded_previews(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate(text="x" * 100)])
        before = set(tmp_path.iterdir())
        output = io.StringIO()
        with patch.object(subprocess, "run", side_effect=AssertionError("network")):
            self.assertEqual(submit.main(argv, run=lambda *a, **k: self.fail("must not send"), out=output), 0)
        batch = json.loads(output.getvalue())
        self.assertTrue(batch["count"] == 1 and batch["namespaces"] == ["/shared/"])
        self.assertEqual(batch["records"][0]["size"], 100)
        self.assertEqual(batch["records"][0]["preview"], "x" * 80)
        self.assertEqual(set(tmp_path.iterdir()), before)

    def test_live_create_ledger_skip_and_update(self):
        tmp_path = self.tmp_path
        calls = []
        argv = args(tmp_path, [candidate(), candidate(2)], "--send")
        self.assertEqual(submit.main(argv, run=fake_cli(calls), out=io.StringIO()), 0)
        self.assertEqual(len(calls), 1)
        path = tmp_path / "ledger.json"
        saved = json.loads(path.read_text())
        self.assertEqual(len(saved["records"]), 2)
        self.assertTrue(all(value["memoryRecordId"].startswith("record-") for value in saved["records"].values()))
        self.assertIs(saved["pending"], None)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(calls[0][2].exists())
        self.assertEqual(submit.main(argv, run=fake_cli(calls), out=io.StringIO()), 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(submit.main(argv + ["--update"], run=fake_cli(calls), out=io.StringIO()), 0)
        self.assertEqual(calls[-1][0], "batch-update-memory-records")
        for record in calls[-1][1]["records"]:
            self.assertNotIn("requestIdentifier", record)
            self.assertEqual(record["sourceNamespaces"], ["/shared/"])
            self.assertTrue(record["memoryRecordId"].startswith("record-"))

    def test_timeout_retains_exact_batch_for_retry(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate()], "--send")
        def timeout(command, **kwargs):
            raise subprocess.TimeoutExpired(command, 120)
        self.assertEqual(submit.main(argv, run=timeout, out=io.StringIO()), 2)
        saved = json.loads((tmp_path / "ledger.json").read_text())
        pending = copy.deepcopy(saved["pending"]["batches"][0]["payload"])
        self.assertEqual(saved["records"], {})
        calls = []
        self.assertEqual(submit.main(argv, run=fake_cli(calls), out=io.StringIO()), 0)
        self.assertEqual(calls[0][1], pending)
        self.assertFalse(list(tmp_path.glob(".memory-request-*")))

    def test_partial_failure_saves_successes_and_retries_only_failures(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate(), candidate(2)], "--send")
        def partial(command, **kwargs):
            body = json.loads(Path(command[4][7:]).read_text())
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "successfulRecords": [{"requestIdentifier": body["records"][0]["requestIdentifier"],
                                       "memoryRecordId": "saved", "status": "SUCCEEDED"}],
                "failedRecords": [{"requestIdentifier": body["records"][1]["requestIdentifier"], "status": "FAILED"}],
            }))
        self.assertEqual(submit.main(argv, run=partial, out=io.StringIO()), 2)
        self.assertEqual(len(json.loads((tmp_path / "ledger.json").read_text())["records"]), 1)
        calls = []
        self.assertEqual(submit.main(argv, run=fake_cli(calls), out=io.StringIO()), 0)
        self.assertEqual(len(calls[0][1]["records"]), 1)

    def test_ledger_resource_mismatch_namespace_move_and_part_shrink_fail(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate()], "--send")
        self.assertEqual(submit.main(argv, run=fake_cli([]), out=io.StringIO()), 0)
        self.assertEqual(submit.main(["mem-OTHER" if x == "mem-EXAMPLE" else x for x in argv], run=fake_cli([])), 2)
        existing = ledger()
        existing["records"] = {"old": {"source": candidate()["source"], "part": 2, "namespace": "/shared/", "memoryRecordId": "old"}}
        records = submit.prepare_records([candidate()], ["/shared/"])
        with self.assertRaisesRegex(submit.SubmitError, "part count"):
            submit.batches(records, existing, update=True)
        existing["records"] = {records[0]["requestIdentifier"]: {"namespace": "/owner/example/", "memoryRecordId": "old"}}
        with self.assertRaisesRegex(submit.SubmitError, "namespace changes"):
            submit.batches(records, existing)

    def test_invalid_input_never_writes_or_sends_and_errors_hide_text(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate(text="CANARY_SECRET", namespace="/denied/")], "--send")
        before = set(tmp_path.iterdir())
        errors = io.StringIO()
        with redirect_stderr(errors):
            self.assertEqual(submit.main(argv, run=lambda *a, **k: self.fail("must not send")), 2)
        self.assertNotIn("CANARY_SECRET", errors.getvalue())
        self.assertEqual(set(tmp_path.iterdir()), before)
        with self.assertRaisesRegex(submit.SubmitError, "tracked repository"):
            submit.ledger_path(submit.ROOT / "README.md")
        linked = tmp_path / "link"
        linked.symlink_to(tmp_path / "target")
        with self.assertRaisesRegex(submit.SubmitError, "symbolic link"):
            submit.ledger_path(linked)

    def test_pending_payload_tampering_never_reaches_cli(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate()], "--send")
        self.assertEqual(submit.main(argv, run=lambda *a, **k: SimpleNamespace(returncode=1)), 2)
        path = tmp_path / "ledger.json"
        saved = json.loads(path.read_text())
        saved["pending"]["batches"][0]["payload"]["records"][0]["content"]["text"] = "unreviewed text"
        path.write_text(json.dumps(saved))
        self.assertEqual(submit.main(argv, run=lambda *a, **k: self.fail("must not send")), 2)

    def test_partial_failure_with_later_batches_does_not_lose_failed_records(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate(n) for n in range(101)], "--send")
        def partial(command, **kwargs):
            body = json.loads(Path(command[4][7:]).read_text())
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                "successfulRecords": [{"requestIdentifier": record["requestIdentifier"], "memoryRecordId": f"saved-{n}", "status": "SUCCEEDED"}
                                      for n, record in enumerate(body["records"][1:])],
                "failedRecords": [{"requestIdentifier": body["records"][0]["requestIdentifier"], "status": "FAILED"}],
            }))
        self.assertEqual(submit.main(argv, run=partial), 2)
        calls = []
        self.assertEqual(submit.main(argv, run=fake_cli(calls)), 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0][1]["records"]), 2)

    def test_incomplete_response_retains_pending_batch(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate()], "--send")
        self.assertEqual(submit.main(argv, run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps({
            "successfulRecords": [], "failedRecords": []}))), 2)
        saved = json.loads((tmp_path / "ledger.json").read_text())
        self.assertIsNot(saved["pending"], None)
        self.assertEqual(saved["records"], {})

    def test_pending_mismatch_and_lock_fail_without_send(self):
        tmp_path = self.tmp_path
        argv = args(tmp_path, [candidate()], "--send")
        (tmp_path / "ledger.json.lock").write_text("")
        self.assertEqual(submit.main(argv, run=lambda *a, **k: self.fail("must not send")), 2)
        (tmp_path / "ledger.json.lock").unlink()
        def timeout(*a, **k):
            raise OSError()
        self.assertEqual(submit.main(argv, run=timeout), 2)
        (tmp_path / "candidates.json").write_text(json.dumps([candidate(text="changed")]))
        self.assertEqual(submit.main(argv, run=lambda *a, **k: self.fail("must not send")), 2)


if __name__ == "__main__":
    unittest.main()
