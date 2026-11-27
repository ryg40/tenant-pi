"""The pass of the artifacts server to the live Walkr server, `artifacts walkr-url` and the page /walkr: only the
listed requests reach the live server, each request of the Compare page is listed, a foreign Origin gets 403, the
agent token of the record never goes out, the page secret is not in server.log, walkr-url prints the address on the
origin of the artifacts server, and /walkr redirects to that address only for a request from a loopback page, on Linux
only for a client socket of this user, and only when the evidence shows that only the recorded server listens on the
port of the Walkr record: on Linux each listener on that port, from a complete read of the listening rows, on macOS
the PID and a protocol of /health that fit the record. On Linux a request of another user holds no lock that a
request of the owner waits for. A failed run of walkr-compare shows no byte of its output on the page or in the log."""
import email.message
import fcntl
import html
import html.parser
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest import mock
import urllib.parse

from tests.test_artifacts import ROOT, Scratch, free_port, health_pid, signed

SERVER_DIR = ROOT / 'packages/artifacts/server'


def page_values():
    """A page secret and a session ID, made at run time."""
    return secrets.token_hex(32), time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(6)


class FakeWalkr(http.server.BaseHTTPRequestHandler):
    """A live Walkr server: /health answers with the PID of the test process and the protocol `protocol` of the
    server (11 when it has none; no protocol key for None). Each other request goes into the list `got` of the server,
    and the answer is a fixed JSON value with a policy header."""

    def answer(self):
        if self.path == '/health':
            protocol = getattr(self.server, 'protocol', 11)
            body = json.dumps({'ok': True, 'pid': os.getpid()}
                              | ({} if protocol is None else {'protocol': protocol})).encode()
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
    # As the real record: the key `token`, 32 hex digits (packages/walkr/src/server.js).
    token = secrets.token_hex(16)
    record = scratch.home / '.human-review/server.json'
    record.parent.mkdir()
    record.write_text(json.dumps({'port': live.server_address[1], 'pid': os.getpid(), 'protocol': 11,
                                  'token': token}))
    scratch.ok('start')
    return live, token


def send(port, method, path, headers=None, body=None):
    """(status, body) of one request to the artifacts server."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    try:
        connection.request(method, path, body=body, headers=signed(port, headers))
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

    def test_feedback_page_routes_pass_and_agent_routes_stay_refused(self):
        port, sid = self.scratch.port, self.session
        headers = {'Origin': self.origin, 'Content-Type': 'application/json', 'X-Human-Review-Token': self.page_token}
        passed_get = [
            ('GET', '/_walkr/compare/feedback.js'),
            ('GET', '/_walkr/compare/feedback.css'),
            ('GET', f'/_walkr/feedback/o/{self.secret}/{sid}/item-1/preview'),
            ('GET', f'/_walkr/feedback/o/{self.secret}/{sid}/item-1/opt-1'),
            ('GET', f'/_walkr/feedback/api/sessions/{sid}'),
        ]
        for method, path in passed_get:
            self.assertEqual(200, send(port, method, path)[0], path)
        passed_post = [
            ('POST', f'/_walkr/feedback/api/sessions/{sid}/seen'),
            ('POST', f'/_walkr/feedback/api/sessions/{sid}/expand'),
            ('POST', f'/_walkr/feedback/api/sessions/{sid}/respond'),
            ('POST', f'/_walkr/feedback/api/sessions/{sid}/rate'),
        ]
        for method, path in passed_post:
            self.assertEqual(200, send(port, method, path, headers, '{}')[0], path)
        for path in (
            '/_walkr/feedback/api/sessions',
            f'/_walkr/feedback/api/sessions/{sid}/patch',
            f'/_walkr/feedback/api/sessions/{sid}/received',
            f'/_walkr/feedback/api/sessions/{sid}/outcome',
            f'/_walkr/feedback/api/sessions/{sid}/respond?x=1',
        ):
            self.assertEqual(405, send(port, 'POST', path, headers, '{}')[0], path)
        for path in (
            '/_walkr/feedback/api/capabilities',
            '/_walkr/feedback/api/page',
            f'/_walkr/feedback/api/sessions/{sid}?x=1',
            f'/_walkr/feedback/o/{self.secret}/{sid}/item-1',
            f'/_walkr/feedback/o/{self.secret}/{sid}/item-1/opt-1/extra',
        ):
            self.assertEqual(404, send(port, 'GET', path)[0], path)
        self.assertEqual(passed_get + passed_post, [(got['method'], got['path']) for got in self.live.got])

    def test_no_route_of_a_retired_walkr_mode_passes(self):
        """Core, Double, Coinflip and Trainer are retired (packages/walkr/CHANGELOG.md). Their routes, also the Core
        items of the old Compare page, stay with this server: a GET gets 404, a POST 405, and none reaches the live
        Walkr server."""
        port, key = self.scratch.port, secrets.token_hex(8)
        frame = f'/_walkr/compare/c/{self.secret}/{key}/'
        headers = {'Origin': self.origin, 'Content-Type': 'application/json', 'X-Human-Review-Token': self.page_token}
        for path in (frame, frame + 'style.css', '/_walkr/compare/one-core.js', '/_walkr/compare/core-frame.js',
                     '/_walkr/compare/history-view.js', '/_walkr/compare/api/core', f'/_walkr/compare/api/core/{key}',
                     f'/_walkr/compare/api/history/h-{secrets.token_hex(12)}', f'/artifact/x/{key}/index.html',
                     '/sdk.js', f'/s/{key}', '/_walkr/modes/core', '/double/x', '/_walkr/trainer/s/x'):
            self.assertEqual(404, send(port, 'GET', path)[0], path)
        for path in (f'/_walkr/compare/api/core/{key}/comment', f'/_walkr/compare/api/core/{key}/send',
                     f'/api/page/{key}/comment', f'/api/page/{key}/send', '/api/session', '/api/double/sessions',
                     '/_walkr/trainer/api/datasets'):
            self.assertEqual(405, send(port, 'POST', path, headers, '{}')[0], path)
        self.assertEqual([], self.live.got)

    def test_the_preview_of_a_next_round_passes_and_a_wider_path_does_not(self):
        # o/<secret>/<session>/next/<roundId> (packages/walkr/src/compare-server.js); a roundId has the rule of an
        # optionId (packages/walkr/src/compare-store.js).
        port, frames = self.scratch.port, f'/_walkr/compare/o/{self.secret}/{self.session}'
        passed = [('GET', frames + '/next/round-1'), ('GET', frames + '/next/' + 'R' * 64)]
        for method, path in passed:
            self.assertEqual(200, send(port, method, path)[0], path)
        for path in (frames + '/next/round-1/x', frames + '/next/', frames + '/next/.round', frames + '/next/' + 'R' * 65,
                     frames + '/next/a%2Fb', frames + '/next/round-1?x', frames + '/later/round-1'):
            self.assertEqual(404, send(port, 'GET', path)[0], path)
        self.assertEqual(405, send(port, 'POST', frames + '/next/round-1', body='{}')[0])
        # Exactly the allowed requests reached the live server, in any order: no refused one.
        self.assertEqual(set(passed), {(got['method'], got['path']) for got in self.live.got})

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


WALKR_SRC = ROOT / 'packages/walkr/src'
# The API calls of compare.js (`call("/...")` and `feedbackCall("/...")`) and the requests that each one makes.
# A new call fails the test below until it is here and its requests are in walkr_front.PASSED.
COMPARE_CALLS = {
    '/history': [('GET', '/_walkr/compare/api/history')],
    '/sessions/${wanted}': [('GET', '/_walkr/compare/api/sessions/{session}')],
    '/sessions/${wanted}/seen': [('POST', '/_walkr/compare/api/sessions/{session}/seen')],
    '/sessions/${item.sessionId}/${item.op}': [('POST', '/_walkr/compare/api/sessions/{session}/{op}')],
}
FEEDBACK_CALLS = {
    '/sessions/${wanted}': [('GET', '/_walkr/feedback/api/sessions/{session}')],
    '/sessions/${wanted}/seen': [('POST', '/_walkr/feedback/api/sessions/{session}/seen')],
    '/sessions/${item.sessionId}/${item.op}': [('POST', '/_walkr/feedback/api/sessions/{session}/{op}')],
}
COMPARE_OPS = {'submit', 'rate'}
FEEDBACK_OPS = {'expand', 'respond', 'rate'}


class PageRefs(html.parser.HTMLParser):
    """The values of the src and href attributes of an HTML page, in any quote form."""

    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        self.refs += [value for name, value in attrs if name in ('src', 'href') and value]

    handle_startendtag = handle_starttag


def page_files(page, source):
    """The paths of this origin that the HTML `source` of the page path `page` names: each src and href value,
    resolved against the page path, with no fragment. A value with a scheme or a host is of another origin."""
    parser = PageRefs()
    parser.feed(source)
    parser.close()
    paths = []
    for value in parser.refs:
        address = urllib.parse.urlsplit(urllib.parse.urldefrag(urllib.parse.urljoin(page, value)).url)
        if not address.scheme and not address.netloc:
            paths.append(address.path + (f'?{address.query}' if address.query else ''))
    return paths


def compare_page_requests():
    """(method, path) of each request of the Compare page: the files that compare.html names (any HTML attribute
    form), the module imports of each served script (read from the files that compare-server.js and server.js serve
    for them), the page, a frame and the API calls of compare.js with sample IDs. The script readers check the
    current forms of compare.js and its modules (`from "./x.js"`, `import("./x.js")`, `call("/...")`), not each form
    of JavaScript."""
    secret, session = page_values()
    static = dict(re.findall(r'"(/_walkr/compare/[^"]+)": \["([^"]+)"', (WALKR_SRC / 'compare-server.js').read_text()))
    static.update(re.findall(r'"(/theme\.(?:css|js))": \["([^"]+)"', (WALKR_SRC / 'server.js').read_text()))
    found, todo = [], page_files(f'/_walkr/compare/g/{secret}', (WALKR_SRC / 'compare.html').read_text())
    while todo:
        path = todo.pop(0)
        if path in found:
            continue
        found.append(path)
        if path.endswith('.js') and path in static:
            imports = re.findall(r'(?:\bfrom|\bimport\()\s*["\']\./([^"\']+)["\']', (WALKR_SRC / static[path]).read_text())
            todo += [path.rsplit('/', 1)[0] + '/' + name for name in imports]
    requests = [('GET', path) for path in found]
    requests += [
        ('GET', f'/_walkr/compare/g/{secret}'),
        ('GET', f'/_walkr/compare/o/{secret}/{session}/option-1'),
        ('GET', f'/_walkr/feedback/o/{secret}/{session}/item-1/preview'),
        ('GET', f'/_walkr/feedback/o/{secret}/{session}/item-1/opt-1'),
    ]
    script = (WALKR_SRC / 'compare.js').read_text()
    calls = set(re.findall(r'\bcall\(\s*[`"](/[^`"]*)[`"]', script))
    feedback_calls = set(re.findall(r'\bfeedbackCall\(\s*[`"](/[^`"]*)[`"]', script))
    ops = set(re.findall(r'\bop: "([a-z]+)"', script))
    values = {'session': session}
    for call in calls:
        for method, path in COMPARE_CALLS.get(call, []):
            for op in sorted(ops & COMPARE_OPS) if '{op}' in path else ['']:
                requests.append((method, path.format(op=op, **values)))
    for call in feedback_calls:
        for method, path in FEEDBACK_CALLS.get(call, []):
            for op in sorted(ops & FEEDBACK_OPS) if '{op}' in path else ['']:
                requests.append((method, path.format(op=op, **values)))
    return found, calls, feedback_calls, ops, requests


class CompareRequestsTests(unittest.TestCase):
    def test_the_page_reader_finds_each_attribute_form_and_resolves_it_against_the_page(self):
        foreign = 'example' + '.invalid'
        source = ('<link rel=stylesheet href=/a.css><script src=\'/b.js\'></script><img src="c.png"/>'
                  f'<a href="#top">x</a><a href="https://{foreign}/d.js">y</a><a href="//{foreign}/e">z</a>')
        self.assertEqual(['/a.css', '/b.js', '/p/c.png', '/p/q'], page_files('/p/q', source))

    def test_each_request_of_the_compare_page_is_in_the_pass_list(self):
        _, walkr_front = server_modules()
        files, calls, feedback_calls, ops, requests = compare_page_requests()
        # The reader finds the files of the page and of its scripts, so an empty list cannot pass.
        self.assertLessEqual(
            {'/_walkr/compare/app.js', '/_walkr/compare/a2ui.js', '/_walkr/compare/a2ui.css',
             '/_walkr/compare/feedback.js', '/_walkr/compare/feedback.css'},
            set(files),
        )
        self.assertEqual(set(COMPARE_CALLS), calls, 'a new Compare API call of compare.js: add it to COMPARE_CALLS')
        self.assertEqual(set(FEEDBACK_CALLS), feedback_calls,
                         'a new Feedback API call of compare.js: add it to FEEDBACK_CALLS')
        self.assertEqual(COMPARE_OPS | FEEDBACK_OPS, ops, 'a new page write of compare.js: check walkr_front.PASSED')
        missing = [(method, path) for method, path in requests if not walkr_front.listed(method, path)]
        self.assertEqual([], missing)


class WalkrUrlTests(unittest.TestCase):
    def test_walkr_url_prints_the_artifacts_origin_passes_exit_2_and_gives_4_with_no_walkr(self):
        scratch = Scratch(self)
        self.assertEqual(4, scratch.cli('walkr-url').returncode)
        scratch.ok('start')
        secret, session = page_values()
        tools = scratch.base / 'bin'
        tools.mkdir()
        # The fake prints the address on another port, as walkr-compare --here open does; the ID "bad" exits 2.
        walkr_port = scratch.port + 1 if scratch.port < 65535 else scratch.port - 1
        (tools / 'walkr-compare').write_text(
            '#!/bin/sh\n[ "$1 $2" = "--here open" ] || exit 9\n'
            '[ "$3" = bad ] && { echo "Compare NOT_FOUND." >&2; exit 2; }\n'
            f'echo "http://127.0.0.1:{walkr_port}/_walkr/compare/g/{secret}#$3"\n')
        (tools / 'walkr-compare').chmod(0o755)
        path = f'{tools}:' + scratch.env['PATH']
        done = scratch.cli('walkr-url', session, PATH=path)
        self.assertEqual(0, done.returncode, done.stderr)
        self.assertEqual(f'http://127.0.0.1:{scratch.port}/_walkr/compare/g/{secret}#{session}\n', done.stdout)
        done = scratch.cli('walkr-url', 'bad', PATH=path)
        self.assertEqual(2, done.returncode)
        # The CLI shows the error output of walkr-compare; the server does not (see WalkrLinkTests).
        self.assertEqual('artifacts: the session is unknown or the ID is not valid (Compare NOT_FOUND.)\n', done.stderr)


def get(port, path, method='GET', headers=None):
    """(status, headers with lower-case names, body) of one request to the artifacts server. `headers` is a dict or a
    list of (name, value) pairs; a list can name a header twice. A Host header of `headers` replaces the default one."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=40)
    pairs = list(headers.items() if isinstance(headers, dict) else headers or [])
    pairs += list(signed(port, {}).items())
    try:
        connection.putrequest(method, path, skip_host=any(name.lower() == 'host' for name, _ in pairs))
        for name, value in pairs:
            connection.putheader(name, value)
        connection.endheaders()
        reply = connection.getresponse()
        return reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read()
    finally:
        connection.close()


def fake_open(scratch, script):
    """Replace the program walkr-compare of the scratch PATH. Each run writes its arguments, its working directory
    and the names of its environment variables to $HOME/walkr-ran, then runs `script`."""
    tools = scratch.base / 'bin'
    tools.mkdir(exist_ok=True)
    (tools / 'walkr-compare').write_text(
        '#!/bin/sh\n{ echo "args: $*"; echo "cwd: $(pwd)"; env | sed "s/=.*//" | sort | sed "s/^/env: /"; } '
        '>> "$HOME/walkr-ran"\n' + script)
    (tools / 'walkr-compare').chmod(0o755)
    if not scratch.env['PATH'].startswith(f'{tools}:'):
        scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']


def ran(scratch):
    """The lines that the runs of the fake walkr-compare wrote, or [] with no run."""
    path = scratch.home / 'walkr-ran'
    return path.read_text().splitlines() if path.exists() else []


def server_log(scratch):
    return (scratch.home / '.local/state/tenant-artifacts/server.log').read_text()


class WalkrLinkTests(unittest.TestCase):
    """The page /walkr: a 303 redirect to the Compare page on this origin, or a text page that says why not."""

    def test_walkr_redirects_to_the_compare_page_of_the_live_server_and_the_log_holds_no_secret(self):
        scratch = Scratch(self)
        live, token = fake_walkr(self, scratch)
        secret, _ = page_values()
        # walkr-compare open prints the address on the port of the live Walkr server.
        fake_open(scratch, f'echo "http://127.0.0.1:{live.server_address[1]}/_walkr/compare/g/{secret}"\n')
        status, headers, body = get(scratch.port, '/walkr')
        self.assertEqual(303, status, body)
        # A relative address: the port of the artifacts server stays, also through a tunnel.
        self.assertEqual(f'/_walkr/compare/g/{secret}', headers['location'])
        self.assertEqual('no-store', headers['cache-control'])
        self.assertEqual('no-referrer', headers['referrer-policy'])
        self.assertEqual(b'', body)
        self.assertEqual(['args: --here open'], [line for line in ran(scratch) if line.startswith('args:')])
        # The address works: the artifacts server passes it to the live Walkr server.
        self.assertEqual(200, get(scratch.port, headers['location'])[0])
        self.assertEqual([('GET', f'/_walkr/compare/g/{secret}')],
                         [(got['method'], got['path']) for got in live.got])
        self.assertNotIn(token, json.dumps(live.got) + json.dumps(headers))
        log = server_log(scratch)
        self.assertNotIn(secret, log)
        self.assertNotIn(token, log)
        lines = log.splitlines()
        self.assertEqual(1, len([line for line in lines if '"GET /walkr HTTP/1.1" 303' in line]), log)
        self.assertEqual(1, len([line for line in lines if '"GET /_walkr/compare/g/<secret> HTTP/1.1" 200' in line]),
                         log)

    def test_head_of_walkr_answers_like_get_without_a_body(self):
        scratch = Scratch(self)
        fake_walkr(self, scratch)
        secret, _ = page_values()
        fake_open(scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        status, headers, body = get(scratch.port, '/walkr', method='HEAD')
        self.assertEqual(303, status)
        self.assertEqual(f'/_walkr/compare/g/{secret}', headers['location'])
        self.assertEqual(b'', body)

    def test_walkr_runs_walkr_compare_open_when_no_live_server_runs_with_the_small_environment(self):
        scratch = Scratch(self)
        secret, _ = page_values()
        # No record and no live server: walkr-compare open starts the live server and prints the address.
        fake_open(scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        state = scratch.home / '.local/state/tenant-artifacts'
        state.mkdir(parents=True)
        # A server started by hand with the variables of the Sheprd link of Walkr: its walkr-compare gets neither.
        with open(state / 'server.log', 'w') as out:
            server = subprocess.Popen([sys.executable, '-B', str(SERVER_DIR / 'artifacts_server.py'),
                                       '--port', str(scratch.port)], cwd=scratch.base, stdin=subprocess.DEVNULL,
                                      stdout=out, stderr=out,
                                      env=scratch.env | {'HERDR_ENV': '1', 'WALKR_SHEPRD_CONNECT': '1'})
        self.addCleanup(server.wait)
        self.addCleanup(server.kill)
        deadline = time.monotonic() + 30
        while health_pid(scratch.port) != server.pid:
            self.assertLess(time.monotonic(), deadline, 'the server gave no /healthz answer')
            time.sleep(0.1)
        scratch.remember_token()
        status, headers, _ = get(scratch.port, '/walkr')
        self.assertEqual(303, status)
        self.assertEqual(f'/_walkr/compare/g/{secret}', headers['location'])
        lines = ran(scratch)
        self.assertIn('args: --here open', lines)
        self.assertIn(f'cwd: {state}', lines)
        names = {line[5:] for line in lines if line.startswith('env: ')}
        self.assertNotIn('HERDR_ENV', names)
        self.assertNotIn('WALKR_SHEPRD_CONNECT', names)
        self.assertNotIn('ARTIFACTS_SCAN_COMMAND', names)
        self.assertIn('HOME', names)

    def test_walkr_without_walkr_is_a_text_page_that_names_walkr_url(self):
        scratch = Scratch(self)
        scratch.ok('start')
        status, headers, body = get(scratch.port, '/walkr')
        self.assertEqual(200, status)
        self.assertNotIn('location', headers)
        text = body.decode()
        self.assertIn('Walkr is not installed', text)
        self.assertIn('<code>artifacts walkr-url</code>', text)

    def test_a_failed_start_is_a_text_page_with_a_fixed_reason_and_no_byte_of_the_child(self):
        scratch = Scratch(self)
        # The program is on the PATH of the server from its start; each case below replaces its script.
        fake_open(scratch, 'exit 1\n')
        scratch.ok('start')
        secret, token = secrets.token_hex(32), secrets.token_hex(16)
        # 260 characters first: the old cut at 300 characters kept 40 characters of the secret, unmasked. The two
        # markers stand for each other value of the child (for example a PID): no number, so no port or PID of the
        # log can match them.
        lead = 'x' * 260
        markers = ('child-stderr-marker', 'child-stdout-marker')
        for code, reason in ((1, 'the live Walkr server did not answer'),
                             (2, 'the session is unknown or the ID is not valid'),
                             (127, 'walkr-compare cannot run; is Node on the PATH?')):
            fake_open(scratch, f'echo "{lead}{secret} {markers[0]} {token}" >&2\n'
                               f'echo "{secret} {markers[1]} {token}"\nexit {code}\n')
            status, headers, body = get(scratch.port, '/walkr')
            self.assertEqual(503, status, code)
            self.assertNotIn('location', headers)
            text = body.decode()
            self.assertEqual([f'{reason} (exit code {code})'],
                             re.findall(r'got no address of the Walkr page: (.*)\.</p>', html.unescape(text)))
            self.assertIn('<code>artifacts walkr-url</code>', text)
            log = server_log(scratch)
            for value in (secret[:16], token[:16]) + markers:
                self.assertNotIn(value, text)
                self.assertNotIn(value, log)
            self.assertEqual(1, log.count(f'walkr: no page address: {reason} (exit code {code})'))
        # The diagnostic lines of the log are the fixed reasons only.
        self.assertEqual(['walkr: no page address: the live Walkr server did not answer (exit code 1)',
                          'walkr: no page address: the session is unknown or the ID is not valid (exit code 2)',
                          'walkr: no page address: walkr-compare cannot run; is Node on the PATH? (exit code 127)'],
                         re.findall(r'walkr: .*', server_log(scratch)))
        # An address of another form is no page address.
        fake_open(scratch, 'echo "http://127.0.0.1:1/_walkr/compare/g/short"\n')
        status, headers, body = get(scratch.port, '/walkr')
        self.assertEqual(503, status)
        self.assertNotIn('location', headers)
        self.assertIn('printed no page address', body.decode())

    def test_a_request_from_a_foreign_page_gets_the_text_page_and_runs_nothing(self):
        scratch = Scratch(self)
        live, token = fake_walkr(self, scratch)
        secret, _ = page_values()
        fake_open(scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        foreign = 'http://' + 'example' + '.invalid'
        root = f'http://127.0.0.1:{scratch.port}'
        # A Sec-Fetch-Site value that is not one of none, same-origin and same-site, and a header named twice.
        for headers in ({'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'Cross-Site'}, {'Origin': foreign},
                        {'Origin': 'null'}, {'Origin': f'https://127.0.0.1:{scratch.port}'},
                        {'Referer': foreign + '/page'}, {'Referer': 'https://localhost/'},
                        {'Sec-Fetch-Site': 'same-origin', 'Referer': foreign + '/'},
                        {'Sec-Fetch-Site': ''}, {'Sec-Fetch-Site': 'cross-site, same-origin'},
                        {'Sec-Fetch-Site': 'bogus'}, [('Sec-Fetch-Site', 'same-origin'), ('Sec-Fetch-Site', 'none')],
                        [('Origin', root), ('Origin', root)], [('Referer', root + '/'), ('Referer', root + '/')]):
            status, answer, body = get(scratch.port, '/walkr', headers=headers)
            self.assertEqual(403, status, headers)
            self.assertNotIn('location', answer)
            self.assertNotIn(secret.encode(), body)
            self.assertIn(b'<code>artifacts walkr-url</code>', body)
            # A click on this page is a request of this server's page; the page cannot be framed.
            for link in re.findall(r'href="([^"]*)"', body.decode()):
                self.assertNotIn(token, link)
                numbers = re.findall(r'\d+', link)
                self.assertNotIn(str(live.server_port), numbers)
                self.assertNotIn(str(os.getpid()), numbers)
            self.assertIn("frame-ancestors 'none'", answer['content-security-policy'])
        self.assertEqual([], ran(scratch))

    def test_a_request_with_no_fetch_header_or_a_loopback_page_gets_the_redirect(self):
        scratch = Scratch(self)
        fake_walkr(self, scratch)
        secret, _ = page_values()
        fake_open(scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        root = f'http://127.0.0.1:{scratch.port}'
        for headers in ({}, {'Sec-Fetch-Site': 'same-origin'}, {'Sec-Fetch-Site': 'none'},
                        {'Sec-Fetch-Site': 'same-site'}, {'Sec-Fetch-Site': ' Same-Origin '}, {'Origin': root},
                        {'Referer': root + '/'},
                        {'Referer': 'http://localhost:9/x'}, {'Referer': 'http://[::1]:7000/'}):
            status, answer, _ = get(scratch.port, '/walkr', headers=headers)
            self.assertEqual(303, status, headers)
            self.assertEqual(f'/_walkr/compare/g/{secret}', answer['location'])

    def test_links_of_the_root_page_give_out_no_walkr_record_value(self):
        scratch = Scratch(self)
        live, token = fake_walkr(self, scratch)
        status, _, body = get(scratch.port, '/')
        self.assertEqual(200, status)
        for link in re.findall(r'href="([^"]*)"', body.decode()):
            self.assertNotIn(token, link)
            numbers = re.findall(r'\d+', link)
            self.assertNotIn(str(live.server_port), numbers)
            self.assertNotIn(str(os.getpid()), numbers)


class PublicOriginTests(unittest.TestCase):
    """The key walkrPublicOrigin: a loopback peer with the host of that origin in the Host header is a public request.
    It reaches only /walkr and the pass list, and a page write needs the public Origin."""

    def setUp(self):
        self.scratch = Scratch(self)
        self.name = '.'.join(('walkr', 'example', 'org'))
        self.origin = 'https://' + self.name

    def start(self, key=True):
        if key:
            self.scratch.ok('setup', '--walkr-public-origin', self.origin)
        self.live, _ = fake_walkr(self, self.scratch)

    def test_a_public_request_reaches_only_walkr_and_the_pass_list(self):
        self.start()
        slug = self.scratch.upload('page.html', '<p>stored</p>')
        secret, _ = page_values()
        fake_open(self.scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        port, public = self.scratch.port, {'Host': self.name}
        missing = get(port, '/no-such-page')
        self.assertEqual(404, missing[0])
        for method, path in (('GET', '/healthz'), ('GET', '/'), ('GET', '/artifacts'), ('GET', f'/a/{slug}'),
                             ('GET', f'/v/{slug}'), ('GET', '/events/v1'), ('GET', '/memory/'),
                             ('POST', f'/api/archive/{slug}'), ('HEAD', '/walkr')):
            status, _, body = get(port, path, method, public)
            self.assertEqual((404, missing[2] if method != 'HEAD' else b''), (status, body), path)
        status, headers, _ = get(port, '/walkr', headers=public)
        self.assertEqual((303, f'/_walkr/compare/g/{secret}'), (status, headers.get('location')))
        self.assertEqual(200, get(port, '/theme.css', headers=public)[0])
        self.assertEqual([('GET', '/theme.css')], [(got['method'], got['path']) for got in self.live.got])

    def test_a_public_page_write_needs_the_public_origin(self):
        self.start()
        _, session = page_values()
        path = f'/_walkr/compare/api/sessions/{session}/submit'
        base = [('Host', self.name), ('Content-Type', 'application/json'), ('Content-Length', '2')]

        def submit(*origins):
            connection = http.client.HTTPConnection('127.0.0.1', self.scratch.port, timeout=20)
            try:
                connection.putrequest('POST', path, skip_host=True)
                for name, value in base + [('Origin', origin) for origin in origins]:
                    connection.putheader(name, value)
                connection.endheaders(b'{}')
                return connection.getresponse().status
            finally:
                connection.close()
        for origins in ((), ('http://' + self.name,), ('https://other.' + self.name,), ('null',),
                        (self.origin, self.origin)):
            self.assertEqual(403, submit(*origins), origins)
        self.assertEqual([], self.live.got)
        self.assertEqual(200, submit(self.origin))
        self.assertEqual([('POST', path, self.origin, self.name)],
                         [(got['method'], got['path'], got['headers'].get('Origin'), got['headers'].get('Host'))
                          for got in self.live.got])

    def test_a_public_walkr_and_pass_read_refuse_a_foreign_origin_or_referer(self):
        self.start()
        secret, _ = page_values()
        fake_open(self.scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        port, foreign = self.scratch.port, 'https://other.' + self.name
        for name, value, status in (('Origin', foreign, 403), ('Referer', foreign + '/', 403),
                                    ('Referer', self.origin + '/walkr', 303)):
            got = get(port, '/walkr', headers=[('Host', self.name), (name, value)])[0]
            self.assertEqual(status, got, (name, value))
        self.assertEqual(403, get(port, '/theme.css', headers=[('Host', self.name), ('Origin', foreign)])[0])
        self.assertEqual([], self.live.got)

    def test_without_the_key_the_public_host_is_refused_as_today(self):
        self.start(key=False)
        for path in ('/walkr', '/theme.css', '/healthz'):
            self.assertEqual(403, get(self.scratch.port, path, headers={'Host': self.name})[0], path)
        self.assertEqual([], self.live.got)


def server_modules():
    """(artifacts_server, walkr_front), loaded in this process with no bytecode file."""
    sys.dont_write_bytecode = True
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    import artifacts_server
    import walkr_front
    return artifacts_server, walkr_front


@unittest.skipUnless(Path('/proc/net/tcp').is_file(), 'the TCP table of Linux')
class PeerUidTests(unittest.TestCase):
    """The user ID of the peer of a loopback TCP connection, from the TCP tables of Linux."""

    def pair(self, family=socket.AF_INET, target='127.0.0.1'):
        """The accepted socket of one loopback connection to an IPv4 listener."""
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        client = socket.socket(family, socket.SOCK_STREAM)
        self.addCleanup(client.close)
        client.connect((target, listener.getsockname()[1]))
        accepted, _ = listener.accept()
        self.addCleanup(accepted.close)
        return accepted

    def test_the_peer_uid_of_an_ipv4_and_a_mapped_ipv6_client_is_this_user(self):
        server, _ = server_modules()
        for family, target in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::ffff:127.0.0.1')):
            accepted = self.pair(family, target)
            self.assertEqual(os.getuid(), server.local_sockets.peer_uid(accepted.getpeername(), accepted.getsockname()), family)

    def handler(self, accepted, headers=()):
        """A request handler of `accepted` with these headers."""
        handler = mock.Mock()
        handler.headers = email.message.Message()
        for name, value in headers:
            handler.headers[name] = value
        handler.connection = accepted
        return handler

    def folder(self):
        temp = tempfile.TemporaryDirectory(prefix='artifacts-tables-')
        self.addCleanup(temp.cleanup)
        return Path(temp.name)

    def test_on_linux_only_a_client_socket_of_this_user_passes(self):
        server, walkr_front = server_modules()
        accepted = self.pair()
        handler = self.handler(accepted)
        peer, local = accepted.getpeername(), accepted.getsockname()
        line = re.compile(r'^(\s*\d+: ' + re.escape(server.local_sockets.table_address(peer, False)) + ' '
                          + re.escape(server.local_sockets.table_address(local, False)) + r'(?: \S+){4}\s+)\d+', re.M)
        real = Path('/proc/net/tcp').read_text()
        self.assertTrue(line.search(real))
        folder = self.folder()
        (folder / 'same').write_text(real)
        # Another user: a user ID that is not the one of this test.
        (folder / 'other').write_text(line.sub(lambda match: match.group(1) + str(os.getuid() + 1), real))
        (folder / 'none').write_text(real.splitlines()[0] + '\n')
        cases = ((folder / 'same', None), (folder / 'other', 'another user'), (folder / 'none', 'found no user'),
                 # A table that cannot be read (here a directory), and no table at all.
                 (folder, 'found no user'), (folder / 'absent', 'found no user'))
        with mock.patch.object(server.local_sockets, 'LINUX', True):
            for path, refused in cases:
                with mock.patch.dict(server.local_sockets.TCP_TABLES, {False: str(path), True: str(folder / 'absent6')}):
                    reason = server.peer_refusal(handler)
                if refused is None:
                    self.assertIsNone(reason, path)
                else:
                    self.assertIn(refused, reason or '', path)
            # The real tables name this user.
            self.assertIsNone(server.peer_refusal(handler))
            with mock.patch.object(server.local_sockets, 'peer_uid', return_value=os.getuid() + 1), \
                    mock.patch.object(walkr_front, 'installed', return_value=True), \
                    mock.patch.object(walkr_front, 'open_page') as open_page:
                answer = server.walkr_page(handler, None)
            open_page.assert_not_called()
            self.assertEqual(403, answer.status)
            self.assertIn(b'another user', answer.body)
            with mock.patch.object(server.local_sockets, 'peer_uid', return_value=None), \
                    mock.patch.object(walkr_front, 'installed', return_value=True), \
                    mock.patch.object(walkr_front, 'open_page') as open_page:
                self.assertEqual(403, server.walkr_page(handler, None).status)
            open_page.assert_not_called()

    def test_memory_refuses_another_local_user_without_starting_the_child(self):
        server, _ = server_modules()
        handler = self.handler(self.pair(), [('Host', 'localhost')])
        handler.client_address = handler.connection.getpeername()
        handler.command = 'GET'
        with mock.patch.object(server.local_sockets, 'peer_uid', return_value=os.getuid() + 1), \
                mock.patch.object(server, 'login_refusal', return_value=None):
            for handler.path in ('/memory/', '/memory/api/sources'):
                handler.requestline = f'GET {handler.path} HTTP/1.1'
                self.assertEqual(403, server.Handler.route(handler).status, handler.path)
        handler.server.memory.target.assert_not_called()

    def test_macos_reads_no_table_and_passes(self):
        server, _ = server_modules()
        handler = self.handler(self.pair())
        with mock.patch.object(server.local_sockets, 'LINUX', False), \
                mock.patch.object(server.local_sockets, 'table_rows', side_effect=AssertionError('a table was read')):
            self.assertIsNone(server.peer_refusal(handler))

    def test_the_table_read_stops_at_its_line_and_a_read_past_a_limit_gives_no_user(self):
        server, _ = server_modules()
        accepted = self.pair()
        peer, local = accepted.getpeername(), accepted.getsockname()
        rest = ' 01 00000000:00000000 00:00000000 00000000  {uid}        0 {inode} 1 0 20 4 30 10 -1\n'
        head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
        match = (f'   0: {server.local_sockets.table_address(peer, False)} {server.local_sockets.table_address(local, False)}'
                 + rest.format(uid=4242, inode=1))
        filler = '   1: 0100007F:0001 0100007F:0002' + rest.format(uid=4343, inode=2)
        folder = self.folder()
        tables = {}
        for name, text in (('first', head + match + 'x' * 1000 + '\n'), ('small', head + filler * 10 + match),
                           ('long', head + 'x' * 1000 + '\n' + match),
                           ('large', head + filler * server.local_sockets.TABLE_LINES + match)):
            (folder / name).write_text(text)
            tables[name] = {False: str(folder / name)}
        # The read stops at the line: the long line after it is not read.
        self.assertEqual(4242, server.local_sockets.peer_uid(peer, local, tables['first']))
        self.assertEqual(4242, server.local_sockets.peer_uid(peer, local, tables['small']))
        self.assertIsNone(server.local_sockets.peer_uid(peer, local, tables['long']))
        # A large table: the line comes after TABLE_LINES lines, so the read stops before it, with no answer. The
        # read goes line by line: the whole table is never in memory.
        with mock.patch.object(server.local_sockets, 'TABLE_SECONDS', 600):
            tracemalloc.start()
            try:
                self.assertIsNone(server.local_sockets.peer_uid(peer, local, tables['large']))
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        self.assertGreater((folder / 'large').stat().st_size, 10 * 1024 * 1024)
        self.assertLess(peak, 1024 * 1024)
        with mock.patch.object(server.local_sockets, 'TABLE_SECONDS', -1):
            self.assertIsNone(server.local_sockets.peer_uid(peer, local, tables['small']))

    def test_a_client_line_before_the_cap_is_a_result_and_a_client_line_after_the_cap_refuses(self):
        server, walkr_front = server_modules()
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        accepted = self.pair()
        peer, local = accepted.getpeername(), accepted.getsockname()
        listen = table_row(server.local_sockets.table_address(('127.0.0.1', port), False), '00000000:0000', '0A', os.getuid(),
                           os.fstat(listener.fileno()).st_ino)
        client = table_row(server.local_sockets.table_address(peer, False), server.local_sockets.table_address(local, False), '01', os.getuid(), 7)
        filler = table_row('0100007F:0001', '0100007F:0002', '06', 0, 0)
        cap, folder, page = 50, self.folder(), f'/_walkr/compare/g/{secrets.token_hex(32)}'
        # In the order of the kernel: the listener in row 1, then more connection rows than the cap. The client in
        # row 2 is a result, and the listening rows end at row 2, so the listener read is complete: 303. The client
        # after the cap is not seen: 403.
        for before, after, status in (([listen, client], [], 303), ([listen], [client], 403)):
            table = folder / f'tcp-{status}'
            table.write_text(TABLE_HEAD + ''.join(before) + filler * (cap + 1 - len(before)) + ''.join(after))
            with mock.patch.object(server.local_sockets, 'LINUX', True), mock.patch.object(server.local_sockets, 'TABLE_LINES', cap), \
                    mock.patch.dict(server.local_sockets.TCP_TABLES, {False: str(table), True: str(folder / 'absent6')}), \
                    mock.patch.object(server, 'log'), \
                    mock.patch.object(walkr_front, 'installed', return_value=True), \
                    mock.patch.object(walkr_front, 'read_record', return_value=(port, os.getpid(), 10)), \
                    mock.patch.object(walkr_front, 'open_page', return_value=page) as open_page:
                answer = server.walkr_page(self.handler(accepted), None)
            self.assertEqual(status, answer.status, status)
            self.assertEqual(1 if status == 303 else 0, open_page.call_count, status)


TABLE_HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'


def table_row(local, remote, state, uid, inode):
    """One line of a TCP table of Linux, in the form of the kernel."""
    return (f'   0: {local} {remote} {state} 00000000:00000000 00:00000000 00000000 {uid:5d}        0 {inode} 1 '
            '0000000000000000 100 0 0 10 0\n')


def bare_handler(headers=()):
    """A request handler with these headers and no connection, for a test that mocks the user check."""
    handler = mock.Mock()
    handler.headers = email.message.Message()
    for name, value in headers:
        handler.headers[name] = value
    return handler


class WalkrOrderTests(unittest.TestCase):
    """The order of the checks of /walkr: the headers, a slot of the user check, the user check, then OPEN_LOCK. A
    request of another user never holds OPEN_LOCK. No test here waits for a time limit: OPEN_SECONDS is 0, so a held
    lock gives 503 at once, and each wait on an event has a limit only against a hang."""
    REFUSED = 'This request comes from a program of another user of this computer.'

    def test_refused_requests_of_another_user_hold_no_lock_that_the_owner_waits_for(self):
        server, walkr_front = server_modules()
        go = threading.Event()
        self.addCleanup(go.set)
        foreign, entered = {}, {}

        def refusal(handler):
            if handler in entered:  # A slow check: it holds its slot until the test lets it go.
                entered[handler].set()
                self.assertTrue(go.wait(60))
            return self.REFUSED if handler in foreign else None

        def run(handler):
            try:
                foreign[handler].append(server.walkr_page(handler, None).status)
            finally:
                entered[handler].set()
        page = f'/_walkr/compare/g/{secrets.token_hex(32)}'
        with mock.patch.object(server, 'peer_refusal', side_effect=refusal), \
                mock.patch.object(server, 'stale_record', return_value=False), \
                mock.patch.object(walkr_front, 'installed', return_value=True), \
                mock.patch.object(walkr_front, 'OPEN_SECONDS', 0), \
                mock.patch.object(walkr_front, 'open_page', return_value=page) as open_page:
            threads = []
            # CHECKS - 1 requests of another user in a slow check at the same time.
            for _ in range(server.CHECKS - 1):
                handler = bare_handler()
                foreign[handler], entered[handler] = [], threading.Event()
                threads.append(threading.Thread(target=run, args=(handler,)))
                threads[-1].start()
                self.assertTrue(entered[handler].wait(60))
            # More requests of another user meanwhile: each takes the free slot, gets 403 and gives the slot back.
            quick = [bare_handler() for _ in range(6)]
            for handler in quick:
                foreign[handler] = []
            quick_status = [server.walkr_page(handler, None).status for handler in quick]
            owner = server.walkr_page(bare_handler(), None)
            go.set()
            for thread in threads:
                thread.join(60)
        self.assertEqual([403] * 6, quick_status)
        # The request of the owner got its 303 with no wait for OPEN_LOCK.
        self.assertEqual(303, owner.status)
        self.assertEqual(page, owner.headers['Location'])
        self.assertEqual(1, open_page.call_count)
        self.assertEqual([[403]] * (server.CHECKS - 1), [foreign[handler] for handler in entered])

    def test_with_each_slot_taken_a_request_gets_503_at_once_and_with_the_lock_taken_too(self):
        server, walkr_front = server_modules()
        with mock.patch.object(walkr_front, 'installed', return_value=True), \
                mock.patch.object(walkr_front, 'OPEN_SECONDS', 0), \
                mock.patch.object(server, 'stale_record', side_effect=AssertionError('the record was read')), \
                mock.patch.object(walkr_front, 'open_page') as open_page:
            for _ in range(server.CHECKS):
                self.assertTrue(server.CHECK_SLOTS.acquire(blocking=False))
            try:
                with mock.patch.object(server, 'peer_refusal', side_effect=AssertionError('a check ran')):
                    # The header check still answers: it runs first.
                    foreign = server.walkr_page(bare_handler([('Sec-Fetch-Site', 'cross-site')]), None)
                    full = server.walkr_page(bare_handler(), None)
            finally:
                for _ in range(server.CHECKS):
                    server.CHECK_SLOTS.release()
            self.assertTrue(server.OPEN_LOCK.acquire(blocking=False))
            try:
                with mock.patch.object(server, 'peer_refusal', return_value=None):
                    busy = server.walkr_page(bare_handler(), None)
            finally:
                server.OPEN_LOCK.release()
        self.assertEqual(403, foreign.status)
        self.assertEqual(503, full.status)
        self.assertIn(b'Too many requests', full.body)
        self.assertEqual(503, busy.status)
        self.assertIn(b'takes too long', busy.body)
        open_page.assert_not_called()


# A process that listens: argv family (4 or 6), host, port, IPV6_V6ONLY (0 or 1), SO_REUSEPORT (0 or 1), and the
# interface of SO_BINDTODEVICE ('' for none). It prints `ready` when it listens and ends when its standard input
# closes.
LISTENER = r'''
import socket, sys
six, host, port, v6only, reuse = sys.argv[1] == '6', sys.argv[2], int(sys.argv[3]), sys.argv[4] == '1', sys.argv[5] == '1'
s = socket.socket(socket.AF_INET6 if six else socket.AF_INET)
if six:
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, int(v6only))
if reuse:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
if sys.argv[6]:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, sys.argv[6].encode())
s.bind((host, port))
s.listen()
print('ready', flush=True)
sys.stdin.read()
'''


def other_interface():
    """The name of a network interface other than lo, or None."""
    try:
        return next((name for name in sorted(os.listdir('/sys/class/net')) if name != 'lo'), None)
    except OSError:
        return None


class StaleRecordTests(unittest.TestCase):
    """stale_record: walkr-compare open runs only when the evidence is complete and unambiguous: only the recorded
    Walkr server listens on the port of the Walkr record, or no program listens there."""

    def pid_of(self, words):
        child = subprocess.Popen(words)
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        return child.pid

    def listener_of_another_process(self, six, host, port, v6only=False, reuse=False, device=''):
        """Another process of this user listens on host:port until the end of the test."""
        child = subprocess.Popen([sys.executable, '-I', '-c', LISTENER, '6' if six else '4', host, str(port),
                                  str(int(v6only)), str(int(reuse)), device],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(child.stderr.close)
        self.addCleanup(child.stdout.close)
        self.addCleanup(child.wait)
        self.addCleanup(child.stdin.close)
        if child.stdout.readline().strip() != 'ready':
            child.stdin.close()
            child.wait()
            self.fail(f'the listener on {host}:{port} did not start: {child.stderr.read()[-300:]}')

    def own_listener(self, host='127.0.0.1', reuse=False):
        """A listener of this process; its port."""
        listener = socket.socket()
        self.addCleanup(listener.close)
        if reuse:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        listener.bind((host, 0))
        listener.listen()
        return listener.getsockname()[1]

    def stale(self, port):
        """stale_record on Linux, with the real TCP tables and a record of `port` and this process."""
        server, walkr_front = server_modules()
        with mock.patch.object(server.local_sockets, 'LINUX', True), \
                mock.patch.object(walkr_front, 'read_record', return_value=(port, os.getpid(), 10)):
            return server.stale_record()

    @unittest.skipUnless(Path('/proc/net/tcp6').is_file() and socket.has_ipv6, 'the TCP tables of Linux with IPv6')
    def test_on_linux_a_listener_of_another_process_on_any_address_of_the_port_refuses(self):
        # The normal case: only the recorded process listens on the port.
        self.assertFalse(self.stale(self.own_listener()))
        # A listener of another process beside it, in each family and on each address. That one also refuses when it
        # cannot get the connection to 127.0.0.1 (IPv6-only, another address): the tables cannot show that. An
        # exact address does not hide a wildcard (review 3, M2).
        for six, host, v6only in ((True, '::', True), (True, '::', False), (False, '0.0.0.0', False),
                                  (False, '127.0.0.2', False)):
            port = self.own_listener(reuse=True)
            self.listener_of_another_process(six, host, port, v6only=v6only, reuse=True)
            self.assertTrue(self.stale(port), (host, v6only))
        # A listener of another process alone, on 127.0.0.1 or on 0.0.0.0.
        for host in ('127.0.0.1', '0.0.0.0'):
            other = free_port()
            self.listener_of_another_process(False, host, other)
            self.assertTrue(self.stale(other), host)
        # Two listeners on 127.0.0.1 (SO_REUSEPORT, one user).
        shared = self.own_listener(reuse=True)
        self.listener_of_another_process(False, '127.0.0.1', shared, reuse=True)
        self.assertTrue(self.stale(shared))

    @unittest.skipUnless(Path('/proc/net/tcp').is_file() and other_interface(), 'the TCP table and an interface')
    def test_on_linux_an_exact_listener_bound_to_another_interface_does_not_hide_a_wildcard_on_lo(self):
        # Review 3, M2: the recorded process listens on 127.0.0.1, bound to an interface other than lo, so it cannot
        # get the connection to 127.0.0.1. Another process listens on 0.0.0.0, bound to lo, and gets it. The tables
        # show no interface: refused.
        listener = socket.socket()
        self.addCleanup(listener.close)
        try:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, other_interface().encode())
        except OSError as error:
            self.skipTest(f'SO_BINDTODEVICE: {error.strerror}')
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        self.assertFalse(self.stale(port))
        self.listener_of_another_process(False, '0.0.0.0', port, device='lo')
        self.assertTrue(self.stale(port))

    def test_the_listener_read_gives_each_listener_of_the_port_or_no_answer(self):
        server, _ = server_modules()
        own = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(own.close)
        port = own.getsockname()[1]
        other = port ^ 1
        temp = tempfile.TemporaryDirectory(prefix='artifacts-tables-')
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)

        def listen(host, inode, six=False, on=port):
            return table_row(server.local_sockets.table_address((host, on), six), '00000000:0000', '0A', 0, inode)

        def connection(six=False, state='01'):
            return table_row(server.local_sockets.table_address(('127.0.0.1', port), six),
                             server.local_sockets.table_address(('127.0.0.1', other), six), state, 0, 0)

        def tables(v4, v6=()):
            name = secrets.token_hex(4)
            for six, rows in ((False, v4), (True, v6)):
                (folder / f'{name}-{six}').write_text(TABLE_HEAD + ''.join(rows))
            return {six: str(folder / f'{name}-{six}') for six in (False, True)}
        v4 = {'127.0.0.1': 1, '0.0.0.0': 2, '127.0.0.2': 3, '192.0.2.5': 4}
        v6 = {'::': 5, '::1': 6, '::ffff:127.0.0.1': 7, '::ffff:0.0.0.0': 8, '2001:db8::1': 9}
        # Each listener on the port counts, in both tables and on each address; a listener on another port and a
        # connection on the port do not.
        rows4 = [listen(host, inode) for host, inode in v4.items()] + [listen('127.0.0.1', 10, on=other), connection()]
        rows6 = [listen(host, inode, True) for host, inode in v6.items()] + [connection(True)]
        self.assertEqual({str(inode) for inode in range(1, 10)}, server.local_sockets.listener_inodes(port, tables(rows4, rows6)))
        cap = 20
        with mock.patch.object(server.local_sockets, 'TABLE_LINES', cap):
            # Many connections after the listening rows: the read of each table ends at the first of them, so the
            # answer is complete under the cap (review 2, N1).
            many = tables([listen('127.0.0.1', 1)] + [connection()] * (cap * 2),
                          [listen('::', 5, True)] + [connection(True)] * (cap * 2))
            self.assertEqual({'1', '5'}, server.local_sockets.listener_inodes(port, many))
            # Review 3, M1: a read that stops never gives a part. The cap inside the listening rows after the own
            # listener, a tcp6 that cannot be read after a listener in tcp, a listening row with too few fields.
            unread = folder / 'unread'
            unread.mkdir()
            short = '   1: 0100007F:0001 00000000:0000 0A\n'
            (folder / 'short').write_text(TABLE_HEAD + listen('127.0.0.1', 1) + short)
            for broken in (tables([listen('127.0.0.1', 1)] + [listen('127.0.0.1', 100 + n, on=other)
                                                              for n in range(cap)] + [listen('0.0.0.0', 2)]),
                           {False: tables([listen('127.0.0.1', 1)])[False], True: str(unread)},
                           {False: str(folder / 'short'), True: str(folder / 'absent6')}):
                with self.assertRaises(server.local_sockets.Unknown):
                    server.local_sockets.listener_inodes(port, broken)
        # Before Linux 4.4, the pending connection requests (state 03) of a listener came among the listening rows:
        # they do not end the read. A row in another state ends it: Linux prints no listening row after it.
        old = tables([listen('127.0.0.1', 1), connection(state='03'), listen('0.0.0.0', 2), connection(),
                      listen('127.0.0.2', 3)])
        self.assertEqual({'1', '2'}, server.local_sockets.listener_inodes(port, old))

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(), 'the descriptor folder of Linux')
    def test_a_limit_inside_the_listening_rows_refuses_and_many_connections_do_not(self):
        server, walkr_front = server_modules()
        own = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(own.close)
        port, inode = own.getsockname()[1], os.fstat(own.fileno()).st_ino
        other = port ^ 1
        temp = tempfile.TemporaryDirectory(prefix='artifacts-tables-')
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)

        def listen(host, number, on=port):
            return table_row(server.local_sockets.table_address((host, on), False), '00000000:0000', '0A', os.getuid(), number)
        connection = table_row('0100007F:0001', '0100007F:0002', '01', 0, 0)
        cap, page = 20, f'/_walkr/compare/g/{secrets.token_hex(32)}'
        cases = (
            # Review 3, M1: the own listener first, the cap inside the listening rows, then a listener of another
            # process that the read never sees.
            ([listen('127.0.0.1', inode)] + [listen('127.0.0.1', 100 + n, other) for n in range(cap)]
             + [listen('0.0.0.0', 99), connection], 503),
            # The own listener, then more connections than the cap: complete, so the normal case passes.
            ([listen('127.0.0.1', inode)] + [connection] * (cap * 2), 303),
            # The idle exit of Walkr on a busy host: no listener on the port; walkr-compare starts a new server.
            ([listen('127.0.0.1', 100, other)] + [connection] * (cap * 2), 303))
        for index, (rows, status) in enumerate(cases):
            table = folder / f'tcp-{index}'
            table.write_text(TABLE_HEAD + ''.join(rows))
            with mock.patch.object(server.local_sockets, 'LINUX', True), mock.patch.object(server.local_sockets, 'TABLE_LINES', cap), \
                    mock.patch.dict(server.local_sockets.TCP_TABLES, {False: str(table), True: str(folder / 'absent6')}), \
                    mock.patch.object(server, 'log'), \
                    mock.patch.object(server, 'peer_refusal', return_value=None), \
                    mock.patch.object(walkr_front, 'installed', return_value=True), \
                    mock.patch.object(walkr_front, 'read_record', return_value=(port, os.getpid(), 10)), \
                    mock.patch.object(walkr_front, 'open_page', return_value=page) as open_page:
                answer = server.walkr_page(bare_handler(), None)
            self.assertEqual(status, answer.status, index)
            self.assertEqual(1 if status == 303 else 0, open_page.call_count, index)
            if status == 503:
                self.assertIn(b'<code>artifacts walkr-url</code>', answer.body)

    @unittest.skipUnless(Path('/proc/self/fd').is_dir(), 'the descriptor folder of Linux')
    def test_the_descriptor_walk_stops_when_it_found_each_socket_and_refuses_past_its_limit(self):
        server, _ = server_modules()
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        inode = str(os.fstat(listener.fileno()).st_ino)
        # A file with a higher descriptor number than the listener, so the walk has an entry after it.
        null = os.open(os.devnull, os.O_RDONLY)
        high = fcntl.fcntl(null, fcntl.F_DUPFD, listener.fileno() + 1)
        os.close(null)
        self.addCleanup(os.close, high)
        numbers = sorted(int(entry.name) for entry in os.scandir('/proc/self/fd'))
        index = numbers.index(listener.fileno())
        self.assertLess(index + 1, len(numbers))
        with mock.patch.object(server.local_sockets, 'FD_ENTRIES', index + 1):
            self.assertTrue(server.local_sockets.holds(os.getpid(), {inode}))
        with mock.patch.object(server.local_sockets, 'FD_ENTRIES', index):
            self.assertFalse(server.local_sockets.holds(os.getpid(), {inode}))

    def test_on_macos_health_must_fit_the_protocol_of_the_record(self):
        server, walkr_front = server_modules()
        page = f'/_walkr/compare/g/{secrets.token_hex(32)}'
        temp = tempfile.TemporaryDirectory(prefix='artifacts-home-')
        self.addCleanup(temp.cleanup)
        home = Path(temp.name)
        (home / '.human-review').mkdir()
        # (protocol of the record, protocol of /health, refused). None: no protocol key. A record of the protocol of
        # this module, also as 10.0: walkr-compare takes it as live and sends its token, so /health must name that
        # protocol (review 3, M3). A record of an older protocol, or with none: walkr-compare replaces that server and
        # sends no token to it, so /health must name the protocol of the record. Other evidence refuses.
        current = walkr_front.PROTOCOL
        old = current - 1
        cases = ((current, current, False), (float(current), current, False), (current, old, True),
                 (current, None, True), (current, str(current), True), (old, old, False), (None, None, False),
                 (old, current, True), (old, None, True), (None, old, True))
        for record_protocol, health_protocol, refused in cases:
            live = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWalkr)
            live.got, live.protocol = [], health_protocol
            self.addCleanup(live.server_close)
            threading.Thread(target=live.serve_forever, daemon=True).start()
            self.addCleanup(live.shutdown)
            port = live.server_address[1]
            record = {'port': port, 'pid': os.getpid(), 'token': secrets.token_hex(16)}
            if record_protocol is not None:
                record['protocol'] = record_protocol
            (home / '.human-review/server.json').write_text(json.dumps(record))
            case = (record_protocol, health_protocol)
            with mock.patch.dict(os.environ, {'HOME': str(home)}), mock.patch.object(server.local_sockets, 'LINUX', False), \
                    mock.patch.object(server.local_sockets, 'table_rows', side_effect=AssertionError('a table was read')), \
                    mock.patch.object(server, 'log'), \
                    mock.patch.object(walkr_front, 'installed', return_value=True), \
                    mock.patch.object(walkr_front, 'open_page', return_value=page) as open_page:
                self.assertEqual((port, os.getpid()), walkr_front.read_record())
                self.assertEqual((port, os.getpid(), record_protocol), walkr_front.read_record(protocol=True))
                self.assertEqual(refused, server.stale_record(), case)
                answer = server.walkr_page(bare_handler(), None)
                # The pass still takes only a live server of the protocol of this module.
                self.assertEqual(health_protocol == current and type(health_protocol) is int,
                                 walkr_front.probe(port, os.getpid()), case)
            self.assertEqual(503 if refused else 303, answer.status, case)
            self.assertEqual(0 if refused else 1, open_page.call_count, case)
            if refused:
                self.assertIn(b'<code>artifacts walkr-url</code>', answer.body)
                self.assertNotIn(str(port).encode(), answer.body)
            else:
                self.assertEqual(page, answer.headers['Location'])
            self.assertEqual([], live.got)

    @unittest.skipUnless(Path('/proc/net/tcp').is_file(), 'the TCP table of Linux')
    def test_on_linux_a_record_is_proven_only_by_the_listening_socket_of_its_process(self):
        server, walkr_front = server_modules()
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        dead = subprocess.Popen(['true'])
        dead.wait()
        other = self.pid_of(['sleep', '30'])
        cases = ((None, False),
                 # This process holds the listener.
                 ((port, os.getpid(), 11), False),
                 # The process of the record is gone, or does not hold the listener on its port.
                 ((port, dead.pid, 11), True), ((port, other, 11), True),
                 # The idle exit of Walkr: no program listens; walkr-compare starts a new server.
                 ((free_port(), dead.pid, 11), False))
        with mock.patch.object(server.local_sockets, 'LINUX', True):
            for record, stale in cases:
                with mock.patch.object(walkr_front, 'read_record', return_value=record):
                    self.assertEqual(stale, server.stale_record(), record)
            # Tables with no answer prove nothing.
            with mock.patch.object(walkr_front, 'read_record', return_value=(port, os.getpid(), 11)), \
                    mock.patch.object(server.local_sockets, 'table_rows', side_effect=server.local_sockets.Unknown('test')):
                self.assertTrue(server.stale_record())

    def test_on_macos_health_must_name_the_recorded_pid(self):
        server, walkr_front = server_modules()
        live = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWalkr)
        live.got = []
        self.addCleanup(live.server_close)
        threading.Thread(target=live.serve_forever, daemon=True).start()
        self.addCleanup(live.shutdown)
        port = live.server_address[1]
        with mock.patch.object(server.local_sockets, 'LINUX', False), \
                mock.patch.object(server.local_sockets, 'table_rows', side_effect=AssertionError('a table was read')):
            # FakeWalkr answers /health with the PID of this process and protocol 11.
            for record, stale in (((port, os.getpid(), 11), False), ((port, os.getpid() + 1, 11), True),
                                  ((free_port(), 4242, 11), False)):
                with mock.patch.object(walkr_front, 'read_record', return_value=record):
                    self.assertEqual(stale, server.stale_record(), record)

    @unittest.skipUnless(Path('/proc/net/tcp').is_file(), 'the TCP table of Linux')
    def test_a_stale_record_gets_the_text_page_and_runs_no_walkr_compare(self):
        scratch = Scratch(self)
        # Another program listens on the port of a record whose process is gone; it answers 200 on each path.
        other = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWalkr)
        other.got = []
        self.addCleanup(other.server_close)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(other.shutdown)
        dead = subprocess.Popen(['true'])
        dead.wait()
        token = secrets.token_hex(16)
        record = scratch.home / '.human-review/server.json'
        record.parent.mkdir()
        record.write_text(json.dumps({'port': other.server_address[1], 'pid': dead.pid, 'token': token,
                                      'protocol': 11}))
        secret, _ = page_values()
        fake_open(scratch, f'echo "http://127.0.0.1:1/_walkr/compare/g/{secret}"\n')
        scratch.ok('start')
        status, headers, body = get(scratch.port, '/walkr')
        self.assertEqual(503, status)
        self.assertNotIn('location', headers)
        self.assertEqual([], ran(scratch))
        self.assertEqual([], other.got)
        text = body.decode()
        self.assertIn('<code>~/.human-review/server.json</code>', text)
        # The fixed text names the command for a shell and says that it has no such check; no value of the record.
        self.assertIn('<code>artifacts walkr-url</code> runs <code>walkr-compare open</code> with no such check', text)
        self.assertNotIn(str(other.server_address[1]), text)
        self.assertNotIn(str(dead.pid), text)
        self.assertEqual(1, server_log(scratch).count('walkr: refused: no proof'))


class OpenPageTests(unittest.TestCase):
    """walkr_front.open_page: the one run of `walkr-compare open` for the CLI and the server."""

    def test_a_program_that_prints_no_address_in_time_stops_with_code_3(self):
        _, walkr_front = server_modules()
        scratch = Scratch(self)
        fake_open(scratch, 'exec sleep 5\n')
        with mock.patch.dict(os.environ, {'PATH': scratch.env['PATH'], 'HOME': str(scratch.home)}):
            began = time.monotonic()
            with self.assertRaises(walkr_front.OpenFailed) as caught:
                walkr_front.open_page(cwd=str(scratch.base), seconds=0.5)
            self.assertLess(time.monotonic() - began, 4)
        self.assertEqual(3, caught.exception.code)
        self.assertIn('no page address in 0.5 s', str(caught.exception))

    def test_the_detail_for_the_cli_masks_a_secret_before_the_cut_and_the_message_is_fixed(self):
        _, walkr_front = server_modules()
        scratch = Scratch(self)
        secret = secrets.token_hex(32)
        fake_open(scratch, f'echo "{"x" * 280}{secret}" >&2\nexit 1\n')
        with mock.patch.dict(os.environ, {'PATH': scratch.env['PATH'], 'HOME': str(scratch.home)}):
            with self.assertRaises(walkr_front.OpenFailed) as caught:
                walkr_front.open_page(cwd=str(scratch.base))
        error = caught.exception
        self.assertEqual((3, 1), (error.code, error.returncode))
        self.assertEqual('the live Walkr server did not answer', str(error))
        self.assertEqual('the live Walkr server did not answer (exit code 1)', error.reason())
        self.assertEqual('x' * 280 + '<secret>', error.detail)

    def test_with_no_path_variable_no_directory_is_searched(self):
        _, walkr_front = server_modules()
        scratch = Scratch(self)
        fake_open(scratch, 'exit 0\n')
        tools = scratch.base / 'bin'
        environ = {name: value for name, value in os.environ.items() if name != 'PATH'}
        # shutil.which with no path argument would search the system default path (os.confstr) here.
        with mock.patch.dict(os.environ, environ, clear=True), mock.patch('os.confstr', return_value=str(tools)):
            self.assertIsNone(walkr_front.program())
            self.assertFalse(walkr_front.installed())
        with mock.patch.dict(os.environ, {'PATH': str(tools)}):
            self.assertEqual(str(tools / 'walkr-compare'), walkr_front.program())


if __name__ == '__main__':
    unittest.main()
