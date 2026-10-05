"""Opt-in publication: idempotent create, stable-link refresh, verification, secret hygiene."""
import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from tracker.publish import Publisher, PublishError, idempotency_key


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
BEARER = "CANARY-BEARER-TOKEN-51d0"
EDIT = "CANARY-EDIT"
HTML = "<!doctype html><title>Brief</title><p>Hello</p>"


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state"
        self.receipts = root / "receipts"
        self.cred = root / "secrets" / "artifact-token"
        self.cred.parent.mkdir()
        self.cred.write_text(BEARER + "\n")
        self.service = S.FakeArtifactService(BEARER, edit_prefix=EDIT)

    def tearDown(self):
        self.tmp.cleanup()

    def publisher(self, **kw):
        args = dict(endpoint=S.ARTIFACTS, credential_file=self.cred, receipt_dir=self.receipts, repo_slug="owner-demo",
                    state_dir=self.state, title="Demo brief", http=self.service, clock=S.Clock())
        args.update(kw)
        return Publisher(**args)

    def test_create_then_refresh_keeps_one_link(self):
        first = self.publisher().publish(HTML)
        self.assertEqual(first["method"], "POST")
        self.assertTrue(first["verified"])
        self.assertEqual(first["expires"], "2026-10-23T06:00:00.000Z")
        post = self.service.requests[0]
        self.assertEqual(post["headers"]["Idempotency-Key"], idempotency_key("owner-demo", HTML))
        second = self.publisher().publish(HTML.replace("Hello", "Hello again"))
        self.assertEqual(second["method"], "PUT")
        self.assertEqual(second["share_url"], first["share_url"])
        self.assertEqual(len(self.service.artifacts), 1)
        put = [r for r in self.service.requests if r["method"] == "PUT"][0]
        self.assertTrue(put["headers"]["X-Orca-Edit-Token"].startswith(EDIT))

    def test_receipt_is_private_and_outside_state(self):
        self.publisher().publish(HTML)
        receipt = self.receipts / "owner-demo.json"
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.receipts.stat().st_mode), 0o700)
        self.assertIn(EDIT, receipt.read_text(), "the edit token lives only in the receipt")
        self.assertNotIn(BEARER, receipt.read_text())
        state_text = S.all_text(self.state)
        self.assertNotIn(BEARER, state_text)
        self.assertNotIn(EDIT, state_text)
        record = json.loads((self.state / "publication.json").read_text())
        self.assertTrue(record["verified"])

    def test_lost_response_retry_reuses_the_key(self):
        self.service.plan = ["lose-response"]
        with self.assertRaises(PublishError):
            self.publisher().publish(HTML)
        self.assertEqual(len(self.service.artifacts), 1, "the server created it, the client never heard")
        result = self.publisher().publish(HTML)
        self.assertEqual(len(self.service.artifacts), 1, "the retry did not create a duplicate")
        keys = {r["headers"]["Idempotency-Key"] for r in self.service.requests if r["method"] == "POST"}
        self.assertEqual(len(keys), 1)
        self.assertTrue(result["verified"])

    def test_errors_never_carry_secrets(self):
        with self.assertRaises(PublishError) as ctx:
            self.publisher(http=lambda *a: (_ for _ in ()).throw(OSError("boom " + BEARER))).publish(HTML)
        self.assertNotIn(BEARER, str(ctx.exception))
        self.service.plan = [500]
        with self.assertRaises(PublishError) as ctx:
            self.publisher().publish(HTML)
        self.assertIn("HTTP 500", str(ctx.exception))

    def test_verification_mismatch_fails(self):
        self.service.plan = [None, "corrupt"]
        with self.assertRaises(PublishError) as ctx:
            self.publisher().publish(HTML)
        self.assertIn("verification failed", str(ctx.exception))
        self.assertFalse(json.loads((self.state / "publication.json").read_text())["verified"])

    def test_expired_link_is_reported_before_replacing(self):
        self.publisher().publish(HTML)
        self.service.artifacts.clear()
        with self.assertRaises(PublishError) as ctx:
            self.publisher().publish(HTML + " ")
        self.assertIn("--replace", str(ctx.exception))
        result = self.publisher().publish(HTML + " ", replace=True)
        self.assertEqual(result["method"], "POST")
        self.assertTrue(list(self.receipts.glob("owner-demo.replaced-*.json")))

    def test_configuration_is_checked(self):
        with self.assertRaises(PublishError):
            self.publisher(endpoint="http://artifacts.example.com")
        with self.assertRaises(PublishError):
            self.publisher(endpoint="https://user:pw@artifacts.example.com")
        with self.assertRaises(PublishError):
            self.publisher(receipt_dir=self.state / "receipts")
        repo = Path(self.tmp.name) / "repo"
        with self.assertRaises(PublishError):
            self.publisher(receipt_dir=repo / ".receipts", repo_root=repo)
        with self.assertRaises(PublishError):
            self.publisher(credential_file=Path(self.tmp.name) / "missing").publish(HTML)


if __name__ == "__main__":
    unittest.main()
