"""The artifacts module: the scan stops an upload, the token stays out of the output, no redirect, setup keeps keys,
and the local server: a refused clone, one server only, and off by the exact process match (a decoy survives)."""
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'packages/artifacts/skills/artifacts/scripts/artifacts'
# A canary built from parts, so the source holds no credential-shaped literal.
CANARY = '-'.join(['canary', 'artifacts', '5e1f', '93b2'])


class Server:
    """A loopback server that records (method, path, Authorization value, body); `redirect` answers 307 to it."""

    def __init__(self, test, redirect=None):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self):
                body = self.rfile.read(int(self.headers.get('content-length') or 0)).decode()
                owner.requests.append((self.command, self.path, self.headers.get('Authorization'), body))
                if redirect:
                    self.send_response(307)
                    self.send_header('Location', redirect + '/v1/artifacts')
                    self.send_header('content-length', '0')
                    self.end_headers()
                    return
                if self.path == '/v1/artifacts' and self.command == 'POST':
                    reply = {'artifact': {'slug': 'slug1', 'title': 'Report', 'expiresAt': '2027-01-01T00:00:00Z'},
                             'shareUrl': owner.origin + '/a/slug1', 'editToken': 'edit-marker'}
                    code = 201
                elif self.path.startswith('/v1/artifacts'):
                    reply = {'artifacts': [{'artifact': {'slug': 'slug1', 'title': 'Report',
                                                         'expiresAt': '2027-01-01T00:00:00Z'}}]}
                    code = 200
                else:
                    reply, code = {'ok': True}, 200
                data = json.dumps(reply).encode()
                self.send_response(code)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            do_GET = do_POST = answer

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        test.addCleanup(self.httpd.server_close)
        test.addCleanup(self.httpd.shutdown)


class ArtifactsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='artifacts-test-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / 'home'
        self.home.mkdir()
        self.token_file = self.base / 'token'
        self.token_file.write_text(CANARY + '\n')
        self.token_file.chmod(0o600)
        self.page = self.base / 'report.html'
        self.page.write_text('<h1>Report</h1>\n')
        # A clean scan by default: the seam replaces the kit scanner, which needs the Betterleaks binary.
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                    'ARTIFACTS_SCAN_COMMAND': 'true',
                    'http_proxy': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9'}

    def cli(self, *args, **env):
        return subprocess.run(['python3', str(CLI), *args], env=self.env | env, text=True,
                              capture_output=True, timeout=30)

    def setup_origin(self, origin):
        done = self.cli('setup', '--origin', origin, '--token-file', str(self.token_file), '--yes')
        self.assertEqual(0, done.returncode, done.stderr)

    def config(self):
        return self.home / '.config/tenant-artifacts/config.json'

    def test_a_scanner_finding_stops_the_upload_before_any_request(self):
        server = Server(self)
        self.setup_origin(server.origin)
        done = self.cli('upload', str(self.page), ARTIFACTS_SCAN_COMMAND='false')
        self.assertEqual(5, done.returncode)
        self.assertEqual([], server.requests)

    def test_the_token_goes_only_into_the_authorization_header(self):
        server = Server(self)
        self.setup_origin(server.origin)
        runs = [self.cli('upload', str(self.page), '--title', 'Report'), self.cli('list'), self.cli('doctor')]
        self.assertEqual([0, 0, 0], [run.returncode for run in runs], [run.stderr for run in runs])
        for run in runs:
            self.assertNotIn(CANARY, run.stdout + run.stderr)
        self.assertNotIn('edit-marker', runs[0].stdout + runs[0].stderr)
        self.assertNotIn(CANARY, self.config().read_text())
        sent = [request for request in server.requests if request[1] != '/healthz']
        self.assertTrue(sent)
        for method, path, auth, body in sent:
            self.assertEqual('Bearer ' + CANARY, auth)
            self.assertNotIn(CANARY, path + body)
        self.assertEqual([None], [auth for _, path, auth, _ in server.requests if path == '/healthz'])

    def test_a_redirect_to_another_origin_is_refused(self):
        target = Server(self)
        origin = Server(self, redirect=target.origin)
        self.setup_origin(origin.origin)
        self.assertEqual(3, self.cli('upload', str(self.page)).returncode)
        self.assertEqual(3, self.cli('list').returncode)
        self.assertTrue(origin.requests)
        self.assertEqual([], target.requests)

    def test_setup_refuses_http_for_a_host_that_is_not_loopback(self):
        done = self.cli('setup', '--origin', 'http://artifacts.invalid', '--token-file', str(self.token_file), '--yes')
        self.assertEqual(2, done.returncode)
        self.assertFalse(self.config().exists())

    def test_setup_keeps_other_keys_and_refuses_a_different_origin_with_yes(self):
        self.config().parent.mkdir(parents=True)
        self.config().write_text(json.dumps({'origin': 'https://one.invalid', 'tokenFile': '/old', 'note': 'kept'}))
        refused = self.cli('setup', '--origin', 'https://two.invalid', '--token-file', str(self.token_file), '--yes')
        self.assertEqual(2, refused.returncode)
        self.assertEqual('https://one.invalid', json.loads(self.config().read_text())['origin'])
        self.setup_origin('https://one.invalid')
        saved = json.loads(self.config().read_text())
        self.assertEqual({'origin': 'https://one.invalid', 'tokenFile': str(self.token_file), 'note': 'kept'}, saved)
        self.assertEqual(0o600, self.config().stat().st_mode & 0o777)

    def test_open_in_a_herdr_pane_calls_sheprd_on_path_with_browser_open(self):
        self.setup_origin('https://artifacts.invalid')
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        record = self.base / 'sheprd-args'
        fake = bin_dir / 'sheprd'
        fake.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "' + str(record) + '"\n')
        fake.chmod(0o755)
        done = self.cli('open', 'slug1', HERDR_ENV='1', PATH=str(bin_dir) + ':/usr/bin:/bin')
        self.assertEqual(0, done.returncode, done.stderr)
        url = done.stdout.strip().splitlines()[-1]
        self.assertEqual(['browser', 'open', url], record.read_text().splitlines())

# A tiny stand-in for the artifact server: it answers each request, also /healthz, on ARTIFACT_BIND:ARTIFACT_PORT.
FAKE_SERVER = """import http from 'node:http'
http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"ok":true}') })
  .listen(Number(process.env.ARTIFACT_PORT), process.env.ARTIFACT_BIND)
"""
NODE = shutil.which('node')


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


@unittest.skipUnless(NODE, 'needs the node command')
class LocalServerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='artifacts-server-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir()
        self.clone = self.base / 'clone'
        (self.clone / 'node_modules').mkdir(parents=True)
        (self.clone / 'loopback-auth.mjs').write_text('// marker\n')
        (self.clone / 'package.json').write_text(json.dumps({'engines': {'node': '>=18'}}))
        (self.clone / 'server.mjs').write_text(FAKE_SERVER)
        self.script = str(self.clone / 'server.mjs')
        self.port = free_port()
        self.env = {'HOME': str(self.home), 'PATH': os.path.dirname(NODE) + ':/usr/bin:/bin',
                    'PYTHONDONTWRITEBYTECODE': '1'}
        # Each test stops each server of its clone, also on failure.
        self.addCleanup(self.kill_servers)

    def cli(self, *args):
        return subprocess.run(['python3', str(CLI), *args], env=self.env, text=True, capture_output=True, timeout=60)

    def servers(self):
        done = subprocess.run(['ps', '-ww', '-x', '-o', 'pid=', '-o', 'command='], capture_output=True, text=True)
        return [int(line.split()[0]) for line in done.stdout.splitlines() if self.script in line.split()[1:]]

    def kill_servers(self):
        for pid in self.servers():
            os.kill(pid, signal.SIGKILL)

    def setup_clone(self):
        done = self.cli('setup', '--clone', str(self.clone), '--port', str(self.port), '--yes')
        self.assertEqual(0, done.returncode, done.stderr)

    def test_start_refuses_a_clone_without_the_localhost_mode(self):
        self.setup_clone()
        (self.clone / 'loopback-auth.mjs').rename(self.clone / 'old-auth.mjs')
        done = self.cli('start')
        self.assertNotEqual(0, done.returncode)
        time.sleep(0.5)
        self.assertEqual([], self.servers())

    def test_a_second_start_starts_no_second_server(self):
        self.setup_clone()
        first = self.cli('start')
        self.assertEqual(0, first.returncode, first.stderr)
        second = self.cli('start')
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertEqual(first.stdout.splitlines()[-1], second.stdout.splitlines()[-1])
        self.assertEqual(1, len(self.servers()))

    def test_off_stops_a_server_that_the_state_file_does_not_name(self):
        self.setup_clone()
        env = {'PATH': self.env['PATH'], 'ARTIFACT_BIND': '127.0.0.1', 'ARTIFACT_PORT': str(self.port)}
        server = subprocess.Popen(['node', self.script], cwd=self.clone, env=env, start_new_session=True,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(server.wait)
        self.addCleanup(server.kill)
        # A decoy: another node script that names the server script only as a later argument.
        decoy_script = self.base / 'decoy.mjs'
        decoy_script.write_text('setInterval(() => {}, 1000);\n')
        decoy = subprocess.Popen(['node', str(decoy_script), self.script], cwd=self.base, env=env,
                                 start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(decoy.wait)
        self.addCleanup(decoy.kill)
        done = self.cli('off')
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertIsNotNone(server.wait(timeout=10))
        self.assertIsNone(decoy.poll())


if __name__ == '__main__':
    unittest.main()
