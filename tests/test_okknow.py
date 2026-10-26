"""The okknow module: the CLI talks only to the configured origin; the installer stores no credential."""
import base64
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'packages/okknow/skills/okknow/scripts/okknow'
USER, PASSWORD = 'canary-user-7f3a', 'canary-pass-9d41e2'


class Server:
    """A loopback HTTP server that records each request; `redirect` answers 307 to a fixed path on that origin."""

    def __init__(self, test, redirect=None):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def answer(self):
                self.rfile.read(int(self.headers.get('content-length') or 0))
                owner.requests.append((self.command, self.path, 'Authorization' in self.headers))
                if redirect:
                    self.send_response(307)
                    self.send_header('Location', redirect + '/moved')
                else:
                    self.send_response(401 if self.path == '/mcp' else 200)
                self.send_header('content-length', '0')
                self.end_headers()
            do_GET = do_POST = do_DELETE = answer

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.httpd.server_port}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        test.addCleanup(self.httpd.server_close)
        test.addCleanup(self.httpd.shutdown)


class OkknowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='okknow-test-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / 'home'
        self.home.mkdir()
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                    'OPENKNOWLEDGE_USERNAME': USER, 'OPENKNOWLEDGE_PASSWORD': PASSWORD}

    def cli(self, *args, **env):
        return subprocess.run(['python3', str(CLI), *args], env=self.env | env, text=True,
                              capture_output=True, timeout=20)

    def test_cli_refuses_without_an_origin_and_refuses_another_origin(self):
        # Each refusal comes before any request: the origins are unroutable names.
        self.assertEqual(4, self.cli('ls').returncode)
        self.assertEqual(0, self.cli('setup', '--origin', 'https://ok.invalid', '--yes', '--no-probe').returncode)
        self.assertEqual('https://ok.invalid', self.cli('origin').stdout.strip())
        other = 'https://other.invalid'
        self.assertEqual([2, 2, 2], [self.cli('--origin', other, 'ls').returncode,
                                     self.cli('ls', OKKNOW_ORIGIN=other).returncode,
                                     self.cli('ls', OPENKNOWLEDGE_ORIGIN=other).returncode])
        self.assertEqual(2, self.cli('setup', '--origin', 'http://ok.invalid', '--yes', '--no-probe').returncode)

    def test_cli_refuses_a_redirect_and_sends_nothing_to_its_target(self):
        target = Server(self)
        origin = Server(self, redirect=target.origin)
        self.assertEqual(0, self.cli('setup', '--origin', origin.origin, '--yes', '--no-probe').returncode)
        self.assertEqual(3, self.cli('ls').returncode)
        self.assertTrue(origin.requests)
        self.assertEqual([], target.requests)

    def test_setup_yes_sends_no_credential_without_probe_auth(self):
        server = Server(self)
        self.assertEqual(0, self.cli('setup', '--origin', server.origin, '--yes').returncode)
        self.assertTrue(server.requests)
        self.assertEqual([], [r for r in server.requests if r[2]])

    def test_installer_writes_no_credential(self):
        bin_dir = self.base / 'bin'
        bin_dir.mkdir()
        pi = bin_dir / 'pi'
        pi.write_text('#!/bin/sh\nexit 0\n')
        pi.chmod(0o700)
        (self.home / '.claude').mkdir()
        # A closed loopback port: the probe of the wizard fails at once, and nothing leaves the host.
        result = subprocess.run(['sh', str(ROOT / 'install.sh'), '--new', 'demo', '--shell', 'bash',
                                 '--with', 'mcp,okknow', '--yes'],
                                env=self.env | {'PATH': str(bin_dir) + ':/usr/bin:/bin', 'OKKNOW_ORIGIN': 'http://127.0.0.1:1',
                                                'INSTALL_TEST_TTY': str(self.home / 'absent-tty')},
                                stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=60)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        adapter = json.loads((self.home / '.pi/profiles/demo/mcp-adapter.json').read_text())
        self.assertTrue(adapter['mcpServers']['okknow']['headers']['Authorization'].startswith('!'))
        canaries = [USER, PASSWORD, base64.b64encode(f'{USER}:{PASSWORD}'.encode()).decode()]
        for path in self.home.rglob('*'):
            if path.is_file() and not path.is_symlink():
                data = path.read_text(errors='replace')
                for canary in canaries:
                    self.assertNotIn(canary, data, str(path))


if __name__ == '__main__':
    unittest.main()
