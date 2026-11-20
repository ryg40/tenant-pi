"""The pass of the artifacts server to the live Walkr server, and `artifacts walkr-url`: only the listed requests
reach the live server, a foreign Origin gets 403, the agent token of the record never goes out, the page secret is not
in server.log, and walkr-url prints the address on the origin of the artifacts server."""
import http.client
import http.server
import json
import os
import secrets
import threading
import time
import unittest

from tests.test_artifacts import Scratch


def page_values():
    """A page secret and a session ID, made at run time."""
    return secrets.token_hex(32), time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(6)


class FakeWalkr(http.server.BaseHTTPRequestHandler):
    """A live Walkr server: /health answers with the PID of the test process and protocol 9. Each other request goes
    into the list `got` of the server, and the answer is a fixed JSON value with a policy header."""

    def answer(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'pid': os.getpid(), 'protocol': 9}).encode()
        else:
            length = int(self.headers.get('Content-Length') or 0)
            self.server.got.append({'method': self.command, 'path': self.path, 'headers': dict(self.headers.items()),
                                    'body': self.rfile.read(length).decode('latin-1')})
            body = b'{"ok": true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Security-Policy', "default-src 'none'")
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_HEAD = answer

    def log_message(self, format, *args):
        pass


def fake_walkr(test, scratch):
    """Walkr installed (a program walkr-compare on the PATH), a live fake Walkr server with its record and agent
    token in the scratch home, and a running artifacts server. Returns (the live server, the agent token)."""
    tools = scratch.base / 'bin'
    tools.mkdir()
    (tools / 'walkr-compare').write_text('#!/bin/sh\nexit 0\n')
    (tools / 'walkr-compare').chmod(0o755)
    scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']
    live = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWalkr)
    live.got = []
    test.addCleanup(live.server_close)
    threading.Thread(target=live.serve_forever, daemon=True).start()
    test.addCleanup(live.shutdown)
    token = secrets.token_hex(32)
    record = scratch.home / '.human-review/server.json'
    record.parent.mkdir()
    record.write_text(json.dumps({'port': live.server_address[1], 'pid': os.getpid(), 'protocol': 9,
                                  'agentToken': token}))
    scratch.ok('start')
    return live, token


def send(port, method, path, headers=None, body=None):
    """(status, body) of one request to the artifacts server."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        reply = connection.getresponse()
        return reply.status, reply.read()
    finally:
        connection.close()


class PassTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Scratch(self)
        self.live, self.token = fake_walkr(self, self.scratch)
        self.secret, self.session = page_values()
        self.page_token = secrets.token_hex(32)
        self.origin = f'http://127.0.0.1:{self.scratch.port}'

    def seen(self, origin, path=None):
        return send(self.scratch.port, 'POST', path or f'/_walkr/compare/api/sessions/{self.session}/seen',
                    {'Origin': origin, 'Content-Type': 'application/json', 'X-Human-Review-Token': self.page_token},
                    '{}')

    def test_only_the_listed_requests_reach_the_live_server(self):
        port, sid = self.scratch.port, self.session
        passed = [('GET', f'/_walkr/compare/g/{self.secret}'), ('GET', '/theme.css'),
                  ('GET', f'/_walkr/compare/api/sessions/{sid}')]
        for method, path in passed:
            self.assertEqual(200, send(port, method, path)[0], path)
        self.assertEqual(200, self.seen(self.origin)[0])
        for path in ('/_walkr/compare/api/sessions', f'/_walkr/compare/api/sessions/{sid}/outcome', '/api/session',
                     f'/_walkr/compare/api/sessions/{sid}/seen?x=1', f'/s/{sid}'):
            self.assertEqual(405, send(port, 'POST', path, body='{}')[0], path)
        for path in (f'/_walkr/compare/api/sessions/{sid}?x=1', '/_walkr/compare/api/page',
                     '/_walkr/compare/api/capabilities', '/health', f'/_walkr/compare/g/{self.secret}?x'):
            self.assertEqual(404, send(port, 'GET', path)[0], path)
        self.assertEqual(passed + [('POST', f'/_walkr/compare/api/sessions/{sid}/seen')],
                         [(got['method'], got['path']) for got in self.live.got])

    def test_a_listed_post_with_a_foreign_origin_gets_403_and_does_not_reach_the_live_server(self):
        for origin in ('http://' + 'example' + '.invalid', 'null', f'https://127.0.0.1:{self.scratch.port}',
                       self.origin + '/page'):
            self.assertEqual(403, self.seen(origin)[0], origin)
        self.assertEqual([], self.live.got)

    def test_the_agent_token_never_goes_out_and_the_log_holds_no_page_secret(self):
        self.assertEqual(200, send(self.scratch.port, 'GET', f'/_walkr/compare/g/{self.secret}')[0])
        self.assertEqual(200, self.seen(self.origin)[0])
        self.assertNotIn(self.token, json.dumps(self.live.got))
        # The page token of the request goes through unchanged.
        seen_path = f'/_walkr/compare/api/sessions/{self.session}/seen'
        seen = [got for got in self.live.got if got['method'] == 'POST' and got['path'] == seen_path]
        self.assertEqual(1, len(seen))
        self.assertEqual(self.page_token, seen[0]['headers'].get('X-Human-Review-Token'))
        log = (self.scratch.home / '.local/state/tenant-artifacts/server.log').read_text()
        self.assertNotIn(self.secret, log)


class WalkrUrlTests(unittest.TestCase):
    def test_walkr_url_prints_the_artifacts_origin_passes_exit_2_and_gives_4_with_no_walkr(self):
        scratch = Scratch(self)
        self.assertEqual(4, scratch.cli('walkr-url').returncode)
        scratch.ok('start')
        secret, session = page_values()
        tools = scratch.base / 'bin'
        tools.mkdir()
        # The fake prints the address on another port, as walkr-compare open does; the ID "bad" exits 2.
        walkr_port = scratch.port + 1 if scratch.port < 65535 else scratch.port - 1
        (tools / 'walkr-compare').write_text(
            '#!/bin/sh\n[ "$2" = bad ] && { echo "Compare NOT_FOUND." >&2; exit 2; }\n'
            f'echo "http://127.0.0.1:{walkr_port}/_walkr/compare/g/{secret}#$2"\n')
        (tools / 'walkr-compare').chmod(0o755)
        path = f'{tools}:' + scratch.env['PATH']
        done = scratch.cli('walkr-url', session, PATH=path)
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual(f'http://127.0.0.1:{scratch.port}/_walkr/compare/g/{secret}#{session}\n', done.stdout)
        self.assertEqual(2, scratch.cli('walkr-url', 'bad', PATH=path).returncode)


if __name__ == '__main__':
    unittest.main()
