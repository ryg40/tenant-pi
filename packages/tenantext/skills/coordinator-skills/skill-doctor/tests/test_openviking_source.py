"""The collector reads sessions from an OpenViking server, read-only, and falls back to the local files.

Run: python3 -m unittest discover -s skills/coordinator-skills/skill-doctor/tests
"""
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SKILL = Path(__file__).resolve().parents[1]
COLLECTOR = SKILL / "scripts" / "collect_sessions.py"
ROOT_URI = "viking://user/demo/sessions"


def peer_of(path):
    """The path form of a peer ID, as the OpenViking clients derive it for a directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def message(role, peer, *parts, when=None):
    return {"id": secrets.token_hex(4), "role": role, "parts": list(parts),
            "created_at": (when or datetime.now(timezone.utc)).isoformat(), "peer_id": peer}


def tool_call(name, arguments):
    return {"type": "tool", "tool_id": secrets.token_hex(4), "tool_name": name,
            "tool_input": arguments, "tool_status": "running"}


def tool_result(output):
    return {"type": "tool", "tool_id": secrets.token_hex(4), "tool_output": output, "tool_status": "completed"}


def text(value):
    return {"type": "text", "text": value}


class StubOpenViking(ThreadingHTTPServer):
    """Serves GET requests from fixture files and records each Authorization header and method.

    `redirect` sends each request after the health check to that address; `refuse` answers 401.
    """

    def __init__(self, files, archives):
        super().__init__(("127.0.0.1", 0), StubHandler)
        self.files, self.archives, self.seen = files, archives, []
        self.redirect, self.refuse = None, False


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.server.seen.append(("POST", self.headers.get("Authorization")))
        self.reply(405, {"status": "error"})

    def do_GET(self):
        self.server.seen.append(("GET", self.headers.get("Authorization")))
        parts = urlsplit(self.path)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        uri = query.get("uri", "")
        if self.server.refuse:
            return self.reply(401, {"status": "error", "error": {"code": "UNAUTHENTICATED"}})
        if self.server.redirect and parts.path != "/health":
            self.send_response(307)
            self.send_header("Location", self.server.redirect)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if parts.path == "/health":
            return self.reply(200, {"status": "ok", "healthy": True})
        if parts.path == "/api/v1/sessions":
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            sessions = sorted({name.split("/")[0] for name in self.server.files})
            return self.reply(200, {"status": "ok", "result": [
                {"session_id": name, "uri": f"{ROOT_URI}/{name}", "is_dir": True, "mod_time": now}
                for name in sessions]})
        if parts.path == "/api/v1/fs/ls":
            if uri == ROOT_URI:
                return self.reply(200, {"status": "ok", "result": [], "has_more": False})
            name = uri[len(ROOT_URI) + 1:].removesuffix("/history")
            if name in self.server.archives:
                return self.reply(200, {"status": "ok", "result": [
                    {"name": archive, "isDir": True} for archive in self.server.archives[name]]})
            return self.reply(404, {"status": "error", "error": {"code": "NOT_FOUND"}})
        if parts.path == "/api/v1/content/read":
            lines = self.server.files.get(uri[len(ROOT_URI) + 1:])
            if lines is None:
                return self.reply(404, {"status": "error", "error": {"code": "NOT_FOUND"}})
            limit = int(query.get("limit", "-1"))
            shown = lines if limit < 0 else lines[:limit]
            return self.reply(200, {"status": "ok", "result": "".join(json.dumps(m) + "\n" for m in shown)})
        return self.reply(404, {"status": "error", "error": {"code": "NOT_FOUND"}})

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class OpenVikingSourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="skill-doctor-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "project"
        self.repo.mkdir()
        self.token = secrets.token_hex(16)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("OPENVIKING_", "CLAUDE_", "CODEX_", "HERMES_", "WARP_"))}
        self.env.update({"HOME": str(self.tmp / "home"), "PYTHONDONTWRITEBYTECODE": "1",
                         "OPENVIKING_CLI_CONFIG_FILE": str(self.tmp / "ovcli.conf"),
                         "OPENVIKING_CONFIG_FILE": str(self.tmp / "ov.conf")})

    def serve(self, files, archives):
        server = StubOpenViking(files, archives)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def configure(self, port, api_key=None):
        config = {"url": "http://127.0.0.1:%d" % port, "api_key": api_key or self.token}
        (self.tmp / "ovcli.conf").write_text(json.dumps(config), encoding="utf-8")

    def collect(self, out, *extra):
        command = [sys.executable, "-B", str(COLLECTOR), "--repo", str(self.repo), "--out", str(out), *extra]
        return subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=120)

    def test_openviking_source_writes_the_sessions_of_the_repository_and_keeps_the_credential_out(self):
        mine, other = peer_of(self.repo), peer_of(self.tmp / "other")
        start = datetime.now(timezone.utc) - timedelta(hours=1)
        at = [start + timedelta(minutes=minute) for minute in range(5)]
        # Retention keeps a copy of a message in the newest archive and in the live file.
        retained = message("assistant", mine, tool_call("Edit", {"file_path": "src/parser.py"}), when=at[3])
        files = {
            "cc-one/history/archive_2/messages.jsonl": [
                message("user", mine, text("Fix the parser."), when=at[0]),
                message("assistant", mine, tool_call("Read", {"file_path": "src/parser.py"}), when=at[1]),
                message("user", mine, tool_result("def parse(): pass"), when=at[2]),
            ],
            "cc-one/history/archive_10/messages.jsonl": [retained],
            "cc-one/messages.jsonl": [retained, message("assistant", mine, text("Fixed."), when=at[4])],
            "pi-two/messages.jsonl": [
                message("user", mine, text("Run the tests.")),
                message("assistant", mine, text("Running."), tool_call("bash", {"command": "make test"})),
            ],
            "cc-three/messages.jsonl": [
                message("user", other, text("Other project.")),
                message("assistant", other, tool_call("Bash", {"command": "ls"})),
            ],
        }
        server = self.serve(files, {"cc-one": ["archive_10", "archive_2"]})
        self.configure(server.server_address[1])
        out = self.tmp / "out"

        result = self.collect(out, "--source", "openviking")

        self.assertEqual(0, result.returncode, result.stderr)
        inventory = json.loads((out / "inventory.json").read_text(encoding="utf-8"))
        self.assertEqual("openviking", inventory["session_source"])
        sampled = sorted((s["harness"], s["meta"]["id"]) for s in inventory["sessions"] if s["sampled"])
        self.assertEqual([("claude", "one"), ("pi", "two")], sampled)
        self.assertEqual(["claude-one.md", "pi-two.md"], sorted(p.name for p in (out / "transcripts").iterdir()))
        one = next(s["stats"] for s in inventory["sessions"] if s["meta"]["id"] == "one")
        self.assertEqual(0, one["repeated_tool_calls"])
        self.assertEqual((at[0].isoformat(), at[4].isoformat()), (one["first_ts"], one["last_ts"]))
        self.assertTrue(server.seen)
        self.assertEqual({("GET", "Bearer " + self.token)}, set(server.seen))
        for path in [out / "inventory.json", *(out / "transcripts").iterdir()]:
            self.assertNotIn(self.token, path.read_text(encoding="utf-8"), path.name)
        self.assertNotIn(self.token, result.stdout + result.stderr)

        elsewhere = self.serve({}, {})
        server.redirect = "http://127.0.0.1:%d/health" % elsewhere.server_address[1]
        redirected = self.collect(self.tmp / "redirected", "--source", "openviking")
        self.assertEqual(1, redirected.returncode, redirected.stderr)
        self.assertEqual([], [header for _, header in elsewhere.seen if header])

    def test_without_an_answering_server_the_default_run_uses_the_local_files_and_openviking_fails(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.configure(port)
        project = self.tmp / "claude" / "projects" / "project"
        project.mkdir(parents=True)
        records = [
            {"type": "user", "sessionId": "local-one", "cwd": str(self.repo), "timestamp": "2026-01-01T00:00:00Z",
             "message": {"role": "user", "content": "List the files."}},
            {"type": "assistant", "sessionId": "local-one", "cwd": str(self.repo),
             "message": {"id": "m1", "role": "assistant",
                         "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]}},
        ]
        (project / "local-one.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        local = ["--harness", "claude", "--claude-home", str(self.tmp / "claude")]

        default = self.collect(self.tmp / "default", *local)
        explicit = self.collect(self.tmp / "explicit", *local, "--source", "openviking")

        self.assertEqual(0, default.returncode, default.stderr)
        inventory = json.loads((self.tmp / "default" / "inventory.json").read_text(encoding="utf-8"))
        self.assertEqual("local", inventory["session_source"])
        self.assertEqual(1, inventory["stats"]["sessions_sampled"])
        self.assertEqual(1, len(default.stderr.strip().splitlines()))
        self.assertEqual(1, explicit.returncode)
        self.assertEqual(1, len(explicit.stderr.strip().splitlines()))

        refusing = self.serve({}, {})
        refusing.refuse = True
        self.configure(refusing.server_address[1])
        refused = self.collect(self.tmp / "refused", *local)
        self.assertEqual(1, refused.returncode, refused.stderr)
        self.assertFalse((self.tmp / "refused" / "inventory.json").exists())
        self.assertEqual(1, len(refused.stderr.strip().splitlines()))

        broken = self.token[:16] + "\n" + self.token[16:]
        self.configure(refusing.server_address[1], api_key=broken)
        malformed = self.collect(self.tmp / "malformed", *local)
        self.assertEqual(1, malformed.returncode)
        for part in broken.splitlines():
            self.assertNotIn(part, malformed.stdout + malformed.stderr)


if __name__ == "__main__":
    unittest.main()
