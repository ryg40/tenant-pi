"""The publish step of herdr-idle-cleanup uploads a handoff only after a clean secret scan.

Run: python3 -m unittest discover -s skills/herdr-idle-cleanup/tests
"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import uuid
from unittest import mock

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, "scripts"))
import publish  # noqa: E402

HANDOFF = """# Herdr idle handoff 20261109-120000

Harvest 2026-11-09T12:00:00Z. Entries: 1 (P1 1, P2 0, P3 0).

## Priority index

- **P1** ws-idle / p1 (pi): **REPORT 1** The build waits. Id `0123456789abcdef`.

## Workspace ws-idle (w1)

### Pane p1

- Cwd: /work/repo-a

~~~~text
**REPORT 1** The build waits

- **[1]** Blocked: The build waits for the owner.
~~~~
"""


class _Stub(http.server.BaseHTTPRequestHandler):
    """Records each request. With `server.redirect` set, answers 302 to that URL. The response header holds no
    request data."""

    def do_GET(self):
        self.server.requests.append({"path": self.path, "headers": dict(self.headers)})
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.server.requests.append({"path": self.path, "headers": dict(self.headers),
                                     "body": json.loads(self.rfile.read(length))})
        if self.server.redirect:
            self.send_response(302)
            self.send_header("Location", self.server.redirect)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = json.dumps({"artifact": {"slug": "stub-slug", "expiresAt": "2026-12-09T12:00:00Z"},
                           "shareUrl": "stub-share-link", "editToken": "stub-edit"}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class _PublishCase(unittest.TestCase):
    def stub(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
        server.requests, server.redirect = [], None
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="publish-test-")
        self.server = self.stub()
        self.token = "stub-" + uuid.uuid4().hex
        token_file = os.path.join(self.dir, "token")
        with open(token_file, "w") as f:
            f.write(self.token + "\n")
        self.settings = {"publish_url": f"http://127.0.0.1:{self.server.server_address[1]}",
                         "publish_token_file": token_file}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, stem, text):
        path = os.path.join(self.dir, stem + ".md")
        with open(path, "w") as f:
            f.write(text)
        return path


class GateTests(_PublishCase):
    """The gate and the redirect rule, with no Betterleaks binary."""

    def test_no_scanner_or_a_scanner_finding_makes_no_request(self):
        clean = self.write("20261109-120000", HANDOFF)
        with mock.patch.object(publish, "kit_scanner", return_value=None):
            self.assertEqual(1, publish.publish(clean, self.dir, self.settings, do_upload=True, out=[].append))
        finding = dict(self.settings, secret_scan_command=["false"])
        self.assertEqual(1, publish.publish(clean, self.dir, finding, do_upload=True, out=[].append))
        self.assertEqual([], self.server.requests)

    def test_a_redirect_is_a_failed_upload_with_no_second_request(self):
        other = self.stub()
        self.server.redirect = f"http://127.0.0.1:{other.server_address[1]}/v1/artifacts"
        settings = dict(self.settings, secret_scan_command=["true"])
        clean = self.write("20261109-120000", HANDOFF)
        with self.assertRaises(RuntimeError):
            publish.publish(clean, self.dir, settings, do_upload=True, out=[].append)
        self.assertEqual(1, len(self.server.requests))
        self.assertEqual([], other.requests)


@unittest.skipUnless(publish.kit_scanner() and shutil.which(os.environ.get("BETTERLEAKS_BIN") or "betterleaks"),
                     "needs the kit scanner and the Betterleaks binary")
class PublishTests(_PublishCase):
    def test_upload_only_after_a_clean_scan_with_the_token_of_the_token_file(self):
        # A synthetic token that the kit scanner flags (rule github-pat), built at run time from parts.
        fake = "".join(("ghp", "_", "Zx9QwEr7TyUi3OpA", "s5DfGh1JkLz2XcVbNm4Q"))
        secret = self.write("20261109-110000", HANDOFF + f'\napi = "{fake}"\n')
        lines = []
        self.assertEqual(1, publish.publish(secret, self.dir, self.settings, do_upload=True, out=lines.append))
        self.assertEqual([], self.server.requests)
        self.assertNotIn(fake, "\n".join(lines))

        clean = self.write("20261109-120000", HANDOFF)
        self.assertEqual(0, publish.publish(clean, self.dir, self.settings, do_upload=True, out=lines.append))
        self.assertEqual(1, len(self.server.requests))
        request = self.server.requests[0]
        self.assertEqual("/v1/artifacts", request["path"])
        self.assertEqual("Bearer " + self.token, request["headers"]["Authorization"])
        self.assertEqual(0o600, os.stat(os.path.join(self.dir, "20261109-120000.html")).st_mode & 0o777)


if __name__ == "__main__":
    unittest.main()
