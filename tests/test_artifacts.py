"""The artifacts module: a scan finding stores nothing; delete and replace; the local server admits only loopback
Host names, guards archive writes, sends the sandbox policy, escapes the facts, reads nothing outside
the store and gives out no field of the Walkr record (port, PID, agent token); the retention sweep; start twice, off, and a decoy PID; the remote
store over ssh."""
import datetime
import email.message
from html.parser import HTMLParser
import http.client
import http.server
import json
import secrets
import os
import re
from pathlib import Path
import re
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'packages/artifacts/skills/artifacts/scripts/artifacts'
# A plain marker in a file outside the store: no answer may hold it.
MARKER = 'outside-marker-7c1e'
# A fake ssh: it logs each call, then runs the remote command with sh -c in the remote home, as sshd does. A call
# from inside a remote command fails, so a forward loop ends at once.
FAKE_SSH = """#!/bin/sh
echo call >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_SSH_INSIDE" ] || [ -n "$FAKE_SSH_EXIT" ]; then exit "${FAKE_SSH_EXIT:-255}"; fi
export FAKE_SSH_INSIDE=1
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
cd "$FAKE_SSH_HOME" || exit 255
if [ -n "$FAKE_SSH_CUT" ]; then head -c "$FAKE_SSH_CUT" | HOME=$FAKE_SSH_HOME sh -c "$3"; exit 255; fi
HOME=$FAKE_SSH_HOME exec sh -c "$3"
"""


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


# The local CLI token of the scratch server on each port (Scratch.cli reads it after each start). The helpers send
# it, so a test of a protected route passes the login as the CLI does.
TOKENS = {}
TOKEN_HEADER = 'X-Tenant-Artifacts-Token'


def signed(port, headers):
    """`headers` with the local token of the server on `port`, when the test has one."""
    fields = dict(headers or {})
    if port in TOKENS:
        fields.setdefault(TOKEN_HEADER, TOKENS[port])
    return fields


def request(port, path, host=None, method='GET', headers=None, body=None, token=True):
    """(status, headers, body) of one request (GET by default); `host` replaces the Host header. With `token`, the
    request carries the local token of the scratch server."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        fields = signed(port, headers) if token else dict(headers or {})
        if host is not None:
            fields['Host'] = host
        connection.request(method, path, body=body, headers=fields)
        reply = connection.getresponse()
        return reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read()
    finally:
        connection.close()


def seed_config(home, port):
    """The config of a scratch home with its port, before its first `setup --port`. With no config, the old port of
    setup is the default 6790, and setup asks /healthz there: a test must not reach the server of the owner."""
    path = home / '.config/tenant-artifacts/config.json'
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(json.dumps({'port': port}, indent=2) + '\n')
    path.chmod(0o600)


def health_pid(port):
    try:
        status, _, body = request(port, '/healthz')
    except OSError:
        return None
    return json.loads(body).get('pid') if status == 200 else None


class Scratch:
    """A scratch home with its own config, store and state, and a free port. The real home is never used."""

    def __init__(self, test, key_store='file'):
        temp = tempfile.TemporaryDirectory(prefix='artifacts-test-')
        test.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir()
        self.store = self.home / '.local/share/tenant-artifacts/store'
        self.state = self.home / '.local/state/tenant-artifacts/server.json'
        self.port = free_port()
        # A clean scan by default: the seam replaces the kit scanner, which needs the Betterleaks binary.
        # The admin key goes to the file store of the scratch home: no password system of the host is asked.
        # XDG_RUNTIME_DIR is the scratch folder, so no session cache of tenant-credsync is read.
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                    'ARTIFACTS_SCAN_COMMAND': 'true', 'XDG_RUNTIME_DIR': str(self.base)}
        self.test = test
        test.addCleanup(self.kill_server)
        seed_config(self.home, self.port)
        self.ok('setup', '--port', str(self.port), '--key-store', key_store)

    def cli(self, *args, **env):
        done = subprocess.run([sys.executable, str(CLI), *args], env=self.env | env, text=True,
                              capture_output=True, timeout=60, cwd=self.base)
        if 'start' in args:
            self.remember_token()
        return done

    def remember_token(self):
        """Keep the local token of the server of this home for the request helpers."""
        token = self.home / '.local/state/tenant-artifacts/cli-token'
        if token.is_file():
            TOKENS[self.port] = token.read_text().strip()

    def ok(self, *args):
        done = self.cli(*args)
        self.test.assertEqual(0, done.returncode, done.stderr)
        return done

    def upload(self, name, content, *options):
        page = self.base / name
        page.write_text(content)
        out = self.ok('upload', str(page), *options).stdout
        line = next(line for line in out.splitlines() if line.startswith('slug:'))
        return line.split(':', 1)[1].strip()

    def files(self, slug):
        return {path.name: path.read_bytes() for path in (self.store / slug).iterdir()}

    def kill_server(self):
        # Also on a failed test: the server of this scratch port stops.
        pid = health_pid(self.port)
        if pid:
            os.kill(pid, signal.SIGKILL)


class UploadTests(unittest.TestCase):
    def test_a_scan_finding_stops_the_upload_and_stores_nothing(self):
        scratch = Scratch(self)
        page = scratch.base / 'report.html'
        page.write_text('<h1>Report</h1>\n')
        done = scratch.cli('upload', str(page), ARTIFACTS_SCAN_COMMAND='false')
        self.assertEqual(5, done.returncode)
        self.assertEqual([], list(scratch.store.iterdir()) if scratch.store.exists() else [])

    def test_delete_removes_only_a_named_artifact_and_a_refusal_deletes_nothing(self):
        scratch = Scratch(self)
        gone, kept = (scratch.upload(f'page{n}.html', f'<p>{n}</p>\n') for n in range(2))
        # A link with a slug name to an artifact folder outside the store, whose meta.json names the link.
        outside = scratch.store.parent / ('o' * 32)
        outside.mkdir()
        (outside / 'meta.json').write_text(json.dumps({'slug': 'l' * 32, 'createdAt': '2026-01-01T00:00:00Z'}))
        (scratch.store / ('l' * 32)).symlink_to(outside)
        # A foreign folder with a slug name and no meta.json.
        (scratch.store / ('f' * 32)).mkdir()
        everything = sorted(path.name for path in scratch.store.iterdir())
        for bad in ('l' * 32, 'f' * 32, 'u' * 32):
            done = scratch.cli('delete', gone, bad)
            self.assertEqual(2, done.returncode, bad)
            self.assertEqual(everything, sorted(path.name for path in scratch.store.iterdir()), bad)
        scratch.ok('delete', gone)
        self.assertEqual(sorted(name for name in everything if name != gone),
                         sorted(path.name for path in scratch.store.iterdir()))
        self.assertTrue((outside / 'meta.json').is_file())
        self.assertTrue((scratch.store / kept / 'source').is_file())


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Scratch(self)
        self.uploaded = {'page.html': '<h1>Page</h1>\n', 'notes.md': '# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'}
        self.html = self.scratch.upload('page.html', self.uploaded['page.html'])
        self.markdown = self.scratch.upload('notes.md', self.uploaded['notes.md'])
        self.scratch.ok('start')
        self.port = self.scratch.port

    def test_archive_refusals_leave_the_artifact_unchanged(self):
        origin = f'http://127.0.0.1:{self.port}'
        headers = {'Origin': origin, 'Content-Type': 'application/json'}
        before = self.scratch.files(self.html)
        cases = [({'Content-Type': 'application/json'}, b'{}', 403),
                 (headers | {'Origin': 'null'}, b'{}', 403),
                 (headers | {'Origin': f'http://127.0.0.1:{self.port - 1}'}, b'{}', 403),
                 (headers | {'Origin': f'http://localhost:{self.port}'}, b'{}', 403),
                 (headers | {'Sec-Fetch-Site': 'cross-site'}, b'{}', 403),
                 (headers | {'Content-Type': 'text/plain'}, b'{}', 415),
                 (headers | {'Content-Length': 'x'}, b'{}', 411), (headers, b' ' * 1025, 413),
                 (headers, b'[]', 400), (headers, b'{', 400)]
        path = '/api/archive/' + self.html
        for fields, body, expected in cases:
            with self.subTest(fields=fields, expected=expected):
                status, back, _ = request(self.port, path, method='POST', headers=fields, body=body)
                self.assertEqual(expected, status)
                self.assertNotIn('access-control-allow-origin', back)
                self.assertEqual(before, self.scratch.files(self.html))
        for method in ('GET', 'HEAD', 'OPTIONS'):
            status, back, _ = request(self.port, path, method=method, headers=headers)
            self.assertEqual((405, 'POST'), (status, back.get('allow')), method)
            self.assertEqual(before, self.scratch.files(self.html))
        for slug in ('short', 'u' * 32):
            status, _, body = request(self.port, '/api/archive/' + slug, method='POST', headers=headers, body=b'{}')
            self.assertEqual(404, status)
            self.assertIn('error', json.loads(body))

    def test_another_local_user_cannot_archive(self):
        from tests.test_artifacts_walkr import server_modules
        server, _ = server_modules()
        path = '/api/archive/' + self.html
        handler = mock.Mock(path=path, command='POST', requestline=f'POST {path} HTTP/1.1',
                            client_address=('127.0.0.1', 1), headers=email.message.Message())
        handler.server.store = self.scratch.store
        for key, value in [('Host', 'localhost'), ('Origin', 'http://localhost'), ('Content-Length', '2'),
                           ('Content-Type', 'application/json')]:
            handler.headers[key] = value
        before = self.scratch.files(self.html)
        with mock.patch.object(server, 'peer_refusal', return_value='Another local user.'), \
                mock.patch.object(server, 'login_refusal', return_value=None):
            self.assertEqual(403, server.Handler.route(handler).status)
        self.assertEqual(before, self.scratch.files(self.html))
        handler.rfile.read.assert_not_called()

    def test_archive_and_restore_change_the_list_but_not_the_version_or_source(self):
        path = self.scratch.store / self.html / 'meta.json'
        before = json.loads(path.read_text()) | {'extra': 'keep'}
        path.write_text(json.dumps(before))
        path.chmod(0o640)
        headers = {'Origin': f'http://127.0.0.1:{self.port}', 'Sec-Fetch-Site': 'same-origin',
                   'Content-Type': 'application/json; charset=utf-8'}

        def state():
            return json.loads(request(self.port, '/api/state/' + self.html)[2])

        def write(action):
            status, _, data = request(self.port, f'/api/{action}/{self.html}', method='POST', headers=headers,
                                      body=b'{}')
            self.assertEqual(200, status)
            self.assertEqual({'slug': self.html, 'archived': action == 'archive'}, json.loads(data))

        live = state()
        write('archive')
        saved = state()
        self.assertNotEqual(live['state'], saved['state'])
        self.assertEqual(live['artifact'], saved['artifact'])
        meta = json.loads(path.read_text())
        datetime.datetime.strptime(meta.pop('archivedAt'), '%Y-%m-%dT%H:%M:%SZ')
        self.assertEqual(before, meta)
        self.assertEqual(0o640, path.stat().st_mode & 0o777)
        stamp = path.stat().st_ino
        write('archive')
        self.assertEqual(stamp, path.stat().st_ino)
        self.assertNotIn(self.html.encode(), request(self.port, '/artifacts')[2])
        status, _, archive = request(self.port, '/artifacts/archive')
        self.assertEqual(200, status)
        self.assertTrue(any(link == '/v/' + self.html for link in re.findall(r'href="([^"]+)"', archive.decode())))
        self.assertNotIn(b'<iframe', archive)
        addresses = re.findall(r'(?:href|src)="([^"]+)"', archive.decode())
        self.assertNotIn('/a/' + self.html, addresses)
        self.assertEqual(200, request(self.port, '/v/' + self.html)[0])
        for prefix in ('/a/', '/d/'):
            self.assertEqual(self.uploaded['page.html'].encode(), request(self.port, prefix + self.html)[2])
        write('restore')
        self.assertEqual(live, state())
        self.assertIn(self.html.encode(), request(self.port, '/artifacts')[2])
        self.assertEqual(before, json.loads(path.read_text()))

    def test_the_server_admits_only_a_loopback_host_name(self):
        for host in ('rebind.invalid', f'rebind.invalid:{self.port}', '', '[::1', '127.0.0.1:99999'):
            for path in ('/healthz', '/'):
                self.assertEqual(403, request(self.port, path, host)[0], (host, path))
        for host in (f'127.0.0.1:{self.port}', 'localhost:1', '[::1]:8080', 'localhost'):
            self.assertEqual(200, request(self.port, '/healthz', host)[0], host)

    def test_an_artifact_view_has_the_sandbox_policy_without_same_origin(self):
        # `?thumb` is the address of a preview frame of the index, with the theme of the page for a Markdown view:
        # it has the same policy.
        for path in ('/a/' + self.html, '/a/' + self.markdown, f'/a/{self.html}?thumb', f'/a/{self.markdown}?thumb',
                     f'/a/{self.markdown}?thumb&theme=torch-dark'):
            status, headers, _ = request(self.port, path)
            self.assertEqual(200, status, path)
            directives = {part.split()[0]: part.split()[1:]
                          for part in headers['content-security-policy'].split(';') if part.strip()}
            self.assertIn('sandbox', directives)
            self.assertNotIn('allow-same-origin', directives['sandbox'])
            # The frame parent is the admitted host by name: the web view of Sheprd refuses 'self' here.
            self.assertEqual([f'http://127.0.0.1:{self.port}'], directives['frame-ancestors'])

    def test_replace_keeps_the_slug_and_the_created_time_and_a_finding_changes_nothing(self):
        # An old created time, so a replace that writes the time of now shows.
        meta_file = self.scratch.store / self.html / 'meta.json'
        meta_file.write_text(json.dumps({**json.loads(meta_file.read_text()), 'createdAt': '2026-01-01T00:00:00Z'}))
        page = self.scratch.base / 'page2.html'
        page.write_text('<h1>Second</h1>\n')
        out = self.scratch.ok('upload', str(page), '--replace', self.html).stdout
        self.assertIn('slug: ' + self.html, out.splitlines())
        after = json.loads(meta_file.read_text())
        self.assertEqual('2026-01-01T00:00:00Z', after['createdAt'])
        self.assertIn('updatedAt', after)
        self.assertEqual(1, after['revision'])
        self.assertEqual(b'<h1>Second</h1>\n', request(self.port, '/a/' + self.html)[2])
        stored = self.scratch.files(self.html)
        page.write_text('<h1>Third</h1>\n')
        done = self.scratch.cli('upload', str(page), '--replace', self.html, ARTIFACTS_SCAN_COMMAND='false')
        self.assertEqual(5, done.returncode)
        self.assertEqual(stored, self.scratch.files(self.html))

    def test_the_index_and_the_viewer_escape_the_facts(self):
        # Built from parts: the markup is never one literal of this file. One mark each for the title, the file
        # name and the repo.
        marks = ('t4k', 'f4k', 'r4k')
        markup = {mark: '<' + f'b data-mark="{mark}">' for mark in marks}
        slug = self.scratch.upload(markup['f4k'] + '.html', '<p>x</p>\n', '--title', markup['t4k'],
                                   '--repo', markup['r4k'])
        for path in ('/artifacts', '/v/' + slug):
            status, _, body = request(self.port, path)
            self.assertEqual(200, status, path)
            for mark in marks:
                self.assertNotIn(markup[mark].encode(), body, (path, mark))
                self.assertIn(('&lt;' + f'b data-mark=&quot;{mark}&quot;&gt;').encode(), body, (path, mark))

    def test_the_theme_of_a_markdown_view_is_one_fixed_name_and_no_other_query_text(self):
        class Root(HTMLParser):
            def handle_starttag(self, tag, attrs):
                if tag == 'html':
                    self.attrs = {name: value or '' for name, value in attrs}

        mark = 'q7k'
        cases = {'': None, '?theme=torch-dark': 'torch-dark', '?thumb&theme=torch-light': 'torch-light',
                 f'?theme={mark}': None, f'?theme=torch-dark%22{mark}': None, f'?theme=torch-dark&theme={mark}': None}
        for query, expected in cases.items():
            status, _, body = request(self.port, '/a/' + self.markdown + query)
            self.assertEqual(200, status, query)
            root = Root()
            root.feed(body.decode())
            self.assertEqual(expected, root.attrs.get('data-theme'), query)
            self.assertNotIn(mark.encode(), body, query)
        # An HTML artifact goes out as stored, with each query.
        self.assertEqual(self.uploaded['page.html'].encode(), request(self.port, f'/a/{self.html}?theme=torch-dark')[2])

    def test_a_bad_slug_or_a_dot_dot_path_reads_nothing_outside_the_store(self):
        # An artifact folder with a valid slug name beside the store, and a link to it inside the store. Its
        # meta.json names the slug of the link, so only the refusal of the link keeps it out.
        outside = self.scratch.store.parent / ('o' * 32)
        outside.mkdir()
        (outside / 'source').write_text(MARKER + '\n')
        (outside / 'meta.json').write_text(json.dumps({
            'slug': 'l' * 32, 'title': MARKER, 'fileName': 'x.md', 'contentType': 'text/markdown', 'repo': None,
            'createdAt': '2026-01-01T00:00:00Z', 'byteSize': 20}))
        (self.scratch.store / ('l' * 32)).symlink_to(outside)
        # The server decodes no `%`, so an encoded path takes the same code path as a short slug. A file of the web
        # directory that is not in the list of static files gets 404 too.
        paths = ['/a/short', '/a/../' + 'o' * 32, '/a/' + 'l' * 32, '/v/' + 'l' * 32, '/static/../artifacts_server.py',
                 '/static/vendor/highlight-LICENSE']
        for path in paths:
            status, _, body = request(self.port, path)
            self.assertEqual(404, status, path)
            self.assertNotIn(MARKER.encode(), body, path)
        self.assertNotIn(MARKER.encode(), request(self.port, '/artifacts')[2])

    def test_a_download_has_the_stored_bytes_the_attachment_and_the_sandbox_without_scripts(self):
        for slug, name in ((self.html, 'page.html'), (self.markdown, 'notes.md')):
            status, headers, body = request(self.port, '/d/' + slug)
            self.assertEqual(200, status)
            self.assertEqual(self.uploaded[name].encode('utf-8'), body)
            self.assertEqual(f'attachment; filename="{name}"', headers['content-disposition'])
            directives = {part.split()[0]: part.split()[1:]
                          for part in headers['content-security-policy'].split(';') if part.strip()}
            self.assertEqual([], directives['sandbox'])
            self.assertEqual('nosniff', headers['x-content-type-options'])

    def test_a_file_name_with_a_quote_a_line_break_and_a_path_adds_no_header(self):
        meta_file = self.scratch.store / self.html / 'meta.json'
        meta = json.loads(meta_file.read_text())

        def file_name(name):
            meta_file.write_text(json.dumps({**meta, 'fileName': name}))
            status, headers, _ = request(self.port, '/d/' + self.html)
            self.assertEqual(200, status, name)
            self.assertNotIn('x-added-mark', headers, name)
            match = re.fullmatch(r'attachment; filename="([^"]*)"', headers['content-disposition'])
            self.assertIsNotNone(match, headers['content-disposition'])
            return match.group(1)

        cleaned = file_name('dir/sub\\a"b\r\nx-added-mark: 1\r\n\r\nc.html')
        self.assertTrue(cleaned.endswith('.html'), cleaned)
        for ch in cleaned:
            self.assertNotIn(ch, '"/\\', cleaned)
            self.assertTrue(' ' <= ch <= '~', cleaned)
        # A hidden name, a name of dots and spaces and a name too long for a file system get the slug fallback.
        for name in ('.report.md', '...', '. . .', 'report.', 'x' * 201 + '.html'):
            self.assertEqual(self.html + '.html', file_name(name), name)

    def test_a_post_to_a_download_gets_405_and_an_unknown_slug_gets_404(self):
        self.assertEqual(405, request(self.port, '/d/' + self.html, method='POST')[0])
        for path in ('/d/' + 'u' * 32, '/d/short'):
            self.assertEqual(404, request(self.port, path)[0], path)
        meta_file = self.scratch.store / self.html / 'meta.json'
        meta_file.write_text(json.dumps({**json.loads(meta_file.read_text()), 'contentType': ['text/html']}))
        self.assertEqual(404, request(self.port, '/d/' + self.html)[0])

    def test_each_page_address_answers_and_each_file_that_a_page_links_exists(self):
        linked = set()
        for path in ('/', '/artifacts', '/v/' + self.html, '/v/' + self.markdown, '/a/' + self.html,
                     '/a/' + self.markdown, '/d/' + self.html):
            status, _, body = request(self.port, path)
            self.assertEqual(200, status, path)
            linked.update(re.findall(r'(?:src|href)="(/static/[^"?]+)', body.decode()))
        # The index page links its style and its script, and a script names each module that it imports.
        self.assertTrue(linked)
        for path in sorted(linked):
            status, _, body = request(self.port, path)
            self.assertEqual(200, status, path)
            for module in re.findall(r'from "(/static/[^"]+)"', body.decode()):
                self.assertEqual(200, request(self.port, module)[0], module)

    def test_a_post_to_a_page_gets_405(self):
        for path in ('/', '/artifacts', '/walkr'):
            self.assertEqual(405, request(self.port, path, method='POST')[0], path)


def torch_tokens(path, theme):
    """The custom properties of the block of `theme` in a theme file: name -> value. The block is the rule whose
    selector list ends with :root[data-theme="<theme>"]."""
    block = re.search(r'(?m)^(?:[^{}\n]*,\s*)?:root\[data-theme="%s"\]\s*\{([^}]*)\}' % theme, path.read_text())
    return dict(re.findall(r'(--[a-z0-9-]+):\s*([^;]+);', block.group(1))) if block else {}


class ThemeTests(unittest.TestCase):
    def test_the_torch_tokens_of_the_artifacts_pages_and_of_the_memory_viewer_equal_those_of_walkr(self):
        """The artifacts package has its own copy of the Torch tokens, because it works with no Walkr; the memory
        viewer has one too, because it loads no file of another package. With the packages in the tree, each token of
        the two Torch blocks of Walkr has the same value in each copy."""
        walkr = ROOT / 'packages/walkr/src/theme.css'
        if not walkr.is_file():
            self.skipTest('packages/walkr is absent')
        copies = [ROOT / 'packages/artifacts/server/web/theme.css']
        if (ROOT / 'packages/memory').is_dir():
            copies.append(ROOT / 'packages/memory/ui/theme.css')
        fonts = dict(re.findall(r'(--sans|--mono):\s*([^;]+);', walkr.read_text()))
        for copy in copies:
            for theme in ('torch-light', 'torch-dark'):
                source, own = torch_tokens(walkr, theme), torch_tokens(copy, theme)
                self.assertTrue(source, theme)
                for name, value in source.items():
                    self.assertEqual(value, own.get(name), (copy.parent.parent.name, theme, name))
            self.assertEqual(fonts, dict(re.findall(r'(--sans|--mono):\s*([^;]+);', copy.read_text())), copy)


class FakeWalkr(http.server.BaseHTTPRequestHandler):
    """A live Walkr server: /health answers with the PID of the test process and protocol 11."""

    def do_GET(self):
        body = json.dumps({'ok': True, 'pid': getattr(self.server, 'health_pid', os.getpid()), 'protocol': 11}).encode()
        self.send_response(200 if self.path == '/health' else 404)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def values(data):
    """Each leaf value of a JSON value."""
    if isinstance(data, dict):
        return [v for item in data.values() for v in values(item)]
    if isinstance(data, list):
        return [v for item in data for v in values(item)]
    return [data]


def fake_walkr(test, scratch):
    """Walkr installed (a program walkr-compare on the PATH) and a live fake Walkr server with its record in the
    scratch home. The fake server answers with the PID of the test process: a signal to that PID ends the test run.
    Returns (the live server, its port, the token of the record)."""
    tools = scratch.base / 'bin'
    tools.mkdir()
    (tools / 'walkr-compare').write_text('#!/bin/sh\nexit 0\n')
    (tools / 'walkr-compare').chmod(0o755)
    scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']
    live = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeWalkr)
    test.addCleanup(live.server_close)
    threading.Thread(target=live.serve_forever, daemon=True).start()
    test.addCleanup(live.shutdown)
    # As the real record: the key `token`, 32 hex digits (packages/walkr/src/server.js).
    token = secrets.token_hex(16)
    walkr_port = live.server_address[1]
    record = scratch.home / '.human-review/server.json'
    record.parent.mkdir()
    record.write_text(json.dumps({'port': walkr_port, 'pid': os.getpid(), 'protocol': 11, 'token': token}))
    return live, walkr_port, token


class WalkrTests(unittest.TestCase):
    def test_healthz_and_the_walkr_page_hold_no_value_of_the_walkr_record(self):
        scratch = Scratch(self)
        _, walkr_port, token = fake_walkr(self, scratch)
        scratch.ok('start')
        status, _, body = request(scratch.port, '/healthz')
        self.assertEqual(200, status)
        data = json.loads(body)
        # The probe reached the fake server, so the record was read.
        self.assertEqual({'socket': 'open'}, data['walkr'])
        self.assertNotIn(token.encode(), body)
        self.assertEqual(scratch.port, data['port'])
        # pid and uid are numbers of the server process, and one can equal the Walkr port by chance.
        for value in values({key: item for key, item in data.items() if key not in ('pid', 'uid')}):
            if isinstance(value, str):
                self.assertNotIn(str(walkr_port), value)
            else:
                self.assertNotEqual(walkr_port, value)
        # The fake walkr-compare prints no address, so /walkr is the text page of a failed start.
        status, _, body = request(scratch.port, '/walkr')
        self.assertEqual(503, status)
        self.assertNotIn(token.encode(), body)
        self.assertNotIn(str(walkr_port).encode(), body)
        log = (scratch.state.parent / 'server.log').read_text()
        self.assertNotIn(token, log)


    def test_status_json_has_two_state_words_and_no_record_value_and_keep_walkr_spares_walkr(self):
        scratch = Scratch(self)
        _, walkr_port, token = fake_walkr(self, scratch)

        def status(expected):
            raw = scratch.ok('--json', 'status').stdout
            self.assertNotIn(token, raw)
            data = json.loads(raw)
            self.assertEqual(expected, data['state'])
            self.assertEqual({'socket': 'open'}, data['walkr'])
            # The Walkr port is in no value: each number, also inside an address, is another number. The PID of the
            # server can equal the Walkr port by chance.
            for value in values({key: item for key, item in data.items() if key != 'pid'}):
                numbers = [int(n) for n in re.findall(r'[0-9]+', value)] if isinstance(value, str) else [value]
                self.assertNotIn(walkr_port, numbers)
        status('stopped')
        scratch.ok('start')
        status('running')
        off = scratch.ok('off', '--keep-walkr')
        self.assertNotIn(token, off.stdout + off.stderr)
        self.assertIsNone(health_pid(scratch.port))
        # off --keep-walkr sent no signal to the Walkr PID: that PID is this test process, and the test goes on.
        status('stopped')

    def test_off_stops_the_live_walkr_server_only_when_health_names_the_pid_of_the_record(self):
        scratch = Scratch(self)
        tools = scratch.base / 'bin'
        tools.mkdir()
        (tools / 'walkr-compare').write_text('#!/bin/sh\nexit 0\n')
        (tools / 'walkr-compare').chmod(0o755)
        scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']
        record = scratch.home / '.human-review/server.json'
        record.parent.mkdir()

        def child(code):
            process = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
            self.addCleanup(process.wait)
            self.addCleanup(process.kill)
            if process.stdout:
                self.addCleanup(process.stdout.close)
            return process
        # A live Walkr server in its own process: /health names its own PID and the protocol of the kit.
        walkr = child('import http.server, json, os\n'
                      'class H(http.server.BaseHTTPRequestHandler):\n'
                      '    def do_GET(self):\n'
                      '        body = json.dumps({"ok": True, "pid": os.getpid(), "protocol": 11}).encode()\n'
                      '        self.send_response(200); self.send_header("Content-Length", str(len(body)))\n'
                      '        self.end_headers(); self.wfile.write(body)\n'
                      '    def log_message(self, *args): pass\n'
                      'server = http.server.HTTPServer(("127.0.0.1", 0), H)\n'
                      'print(server.server_address[1], flush=True)\n'
                      'server.serve_forever()\n')
        port = int(walkr.stdout.readline())
        # A record that names another process than the one that answers /health: that process gets no signal.
        other = child('import time\ntime.sleep(120)\n')
        record.write_text(json.dumps({'port': port, 'pid': other.pid, 'protocol': 11, 'token': secrets.token_hex(16)}))
        record.chmod(0o600)
        scratch.ok('start')
        scratch.ok('off')
        self.assertIsNone(other.poll())
        self.assertIsNone(walkr.poll())
        # The record of the live server: off stops it after the local server, and says so.
        record.write_text(json.dumps({'port': port, 'pid': walkr.pid, 'protocol': 11, 'token': secrets.token_hex(16)}))
        scratch.ok('start')
        scratch.ok('off')
        if sys.platform.startswith('linux'):
            walkr.wait(timeout=10)
        else:
            self.assertIsNone(walkr.poll())
        self.assertIsNone(health_pid(scratch.port))
        self.assertIsNone(other.poll())

    def test_off_spares_a_decoy_named_by_health_that_does_not_own_the_listener(self):
        scratch = Scratch(self)
        listener, port, _ = fake_walkr(self, scratch)
        decoy = subprocess.Popen(['sleep', '60'])
        self.addCleanup(decoy.wait)
        self.addCleanup(decoy.kill)
        listener.health_pid = decoy.pid
        record = scratch.home / '.human-review/server.json'
        record.write_text(json.dumps({'port': port, 'pid': decoy.pid, 'protocol': 11}))
        record.chmod(0o600)
        scratch.ok('off')
        self.assertIsNone(decoy.poll())

    def test_a_walkr_port_that_answers_byte_by_byte_leaves_healthz_fast_and_closed(self):
        scratch = Scratch(self)
        tools = scratch.base / 'bin'
        tools.mkdir()
        (tools / 'walkr-compare').write_text('#!/bin/sh\nexit 0\n')
        (tools / 'walkr-compare').chmod(0o755)
        scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']
        # A program on the recorded port: it reads the request, then sends one byte each 0.3 s and never ends. Each
        # byte comes before a socket timeout of 0.5 s, so only a deadline of the whole probe stops the probe.
        listener = socket.create_server(('127.0.0.1', 0))
        self.addCleanup(listener.close)
        done = threading.Event()
        self.addCleanup(done.set)

        def trickle(connection):
            with connection:
                connection.recv(4096)
                try:
                    while not done.wait(0.3):
                        connection.sendall(b'H')
                except OSError:
                    pass

        def accept():
            # One thread for each connection: the probes at `start` must not hold the port for the next probe.
            while not done.is_set():
                try:
                    connection, _ = listener.accept()
                except OSError:
                    return
                threading.Thread(target=trickle, args=(connection,), daemon=True).start()
        threading.Thread(target=accept, daemon=True).start()
        record = scratch.home / '.human-review/server.json'
        record.parent.mkdir()
        record.write_text(json.dumps({'port': listener.getsockname()[1], 'pid': os.getpid(), 'protocol': 11,
                                      'agentToken': secrets.token_hex(32)}))
        scratch.ok('start')
        began = time.monotonic()
        status, _, body = request(scratch.port, '/healthz')
        elapsed = time.monotonic() - began
        self.assertEqual(200, status)
        self.assertEqual({'socket': 'closed'}, json.loads(body)['walkr'])
        # The CLI reads /healthz with a timeout of 2 seconds.
        self.assertLess(elapsed, 2.0)

class RetentionTests(unittest.TestCase):
    def test_a_sweep_deletes_only_artifacts_older_than_the_setting(self):
        scratch = Scratch(self)
        old, new, broken = (scratch.upload(f'page{n}.html', f'<p>{n}</p>\n') for n in range(3))
        now = datetime.datetime.now(datetime.timezone.utc)

        def age(slug, days):
            meta_file = scratch.store / slug / 'meta.json'
            meta = json.loads(meta_file.read_text())
            meta['createdAt'] = (now - datetime.timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%SZ')
            meta_file.write_text(json.dumps(meta))
        age(old, 30)
        age(new, 1)
        (scratch.store / broken / 'meta.json').write_text('not json')
        # Foreign entries: a file, and a folder with an old meta.json whose name is not a slug.
        (scratch.store / 'notes.txt').write_text('keep\n')
        (scratch.store / 'foreign').mkdir()
        (scratch.store / 'foreign' / 'meta.json').write_text(json.dumps({'slug': 'foreign',
                                                                          'createdAt': '2020-01-01T00:00:00Z'}))
        everything = sorted(path.name for path in scratch.store.iterdir())
        # The server sweeps at its start, before its first /healthz answer.
        scratch.ok('start')
        scratch.ok('off')
        self.assertEqual(everything, sorted(path.name for path in scratch.store.iterdir()))
        scratch.ok('retention', '7')
        scratch.ok('start')
        scratch.ok('off')
        self.assertEqual(sorted(name for name in everything if name != old),
                         sorted(path.name for path in scratch.store.iterdir()))


class StartOffTests(unittest.TestCase):
    def test_start_twice_gives_one_server_and_off_spares_a_decoy(self):
        scratch = Scratch(self)
        first = scratch.ok('start')
        pid = health_pid(scratch.port)
        self.assertIsNotNone(pid)
        second = scratch.ok('start')
        self.assertEqual(pid, health_pid(scratch.port))
        self.assertEqual(first.stdout.splitlines()[-1], second.stdout.splitlines()[-1])
        decoy = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        self.addCleanup(decoy.wait)
        self.addCleanup(decoy.kill)
        saved = scratch.state.read_text()
        scratch.state.write_text(json.dumps({**json.loads(saved), 'pid': decoy.pid}))
        scratch.ok('off')
        self.assertIsNone(decoy.poll())
        self.assertEqual(pid, health_pid(scratch.port))
        scratch.state.write_text(saved)
        scratch.ok('off')
        self.assertIsNone(health_pid(scratch.port))
        self.assertIsNone(decoy.poll())

    def test_the_server_listens_without_a_name_lookup(self):
        # A reverse lookup can wait on the network before the server listens (macOS). Here each lookup fails.
        scratch = Scratch(self)
        site = scratch.base / 'site'
        site.mkdir()
        (site / 'sitecustomize.py').write_text('import socket\n\ndef refuse(*args):\n'
                                               '    raise AssertionError("a name lookup")\n\n'
                                               'socket.getfqdn = socket.gethostbyaddr = refuse\n')
        log = scratch.base / 'server.log'
        program = ROOT / 'packages/artifacts/server/artifacts_server.py'
        with log.open('w') as out:
            server = subprocess.Popen([sys.executable, '-B', str(program), '--port', str(scratch.port)],
                                      env=scratch.env | {'PYTHONPATH': str(site)}, stdin=subprocess.DEVNULL,
                                      stdout=out, stderr=out)
        self.addCleanup(server.wait)
        self.addCleanup(server.kill)
        for _ in range(100):
            if health_pid(scratch.port) == server.pid or server.poll() is not None:
                break
            time.sleep(0.1)
        self.assertEqual(server.pid, health_pid(scratch.port), log.read_text())

    def test_setup_with_a_port_and_no_config_asks_no_other_port(self):
        # With no config the old port is the default 6790, the server of the owner. Here each connection is logged
        # and refused, so the test sends nothing to a port.
        scratch = Scratch(self)
        home = scratch.base / 'empty-home'
        home.mkdir()
        site = scratch.base / 'site'
        site.mkdir()
        asked = scratch.base / 'asked'
        (site / 'sitecustomize.py').write_text(
            'import socket\n\ndef refuse(address, *args, **kwargs):\n'
            f'    with open({str(asked)!r}, "a") as log:\n'
            '        log.write(str(address[1]) + "\\n")\n'
            '    raise ConnectionRefusedError("refused by the test")\n\n'
            'socket.create_connection = refuse\n')
        done = scratch.cli('setup', '--port', str(scratch.port), HOME=str(home), PYTHONPATH=str(site))
        self.assertEqual(0, done.returncode, done.stderr)
        ports = set(asked.read_text().split()) if asked.exists() else set()
        self.assertLessEqual(ports, {str(scratch.port)})
        config = json.loads((home / '.config/tenant-artifacts/config.json').read_text())
        self.assertEqual(scratch.port, config['port'])

    def test_setup_refuses_another_port_while_the_server_of_this_home_runs(self):
        scratch = Scratch(self)
        scratch.ok('start')
        path = scratch.home / '.config/tenant-artifacts/config.json'
        saved = path.read_bytes()
        done = scratch.cli('setup', '--port', str(free_port()))
        self.assertEqual(2, done.returncode, done.stderr)
        self.assertEqual(saved, path.read_bytes())
        scratch.ok('off')


class RemoteStoreTests(unittest.TestCase):
    """The key `remote`: upload, list, delete and open work on the store of another computer. The test seam replaces
    ssh with a fake that runs the remote command under a second scratch home."""

    def setUp(self):
        self.scratch = scratch = Scratch(self)
        self.remote = scratch.base / 'remote'
        (self.remote / '.local/bin').mkdir(parents=True)
        # Not on the PATH of the test: the remote command finds the CLI in ~/.local/bin.
        (self.remote / '.local/bin/artifacts').symlink_to(CLI)
        self.remote_store = self.remote / '.local/share/tenant-artifacts/store'
        self.calls = scratch.base / 'ssh-calls'
        fake = scratch.base / 'fake-ssh'
        fake.write_text(FAKE_SSH)
        fake.chmod(0o755)
        scratch.env.update({'ARTIFACTS_SSH_COMMAND': shlex.quote(str(fake)), 'FAKE_SSH_HOME': str(self.remote),
                            'FAKE_SSH_LOG': str(self.calls)})
        # The remote home has a key `remote` too: a call without --here would forward the file again.
        remote_port = free_port()
        seed_config(self.remote, remote_port)
        for args in (('setup', '--port', str(remote_port)), ('setup', '--remote', 'computer-c')):
            self.assertEqual(0, scratch.cli(*args, HOME=str(self.remote)).returncode)
        scratch.ok('setup', '--remote', 'computer-b')
        self.page = scratch.base / 'page.html'
        self.page.write_text('<p>x</p>\n')

    def names(self, store):
        return sorted(path.name for path in store.iterdir()) if store.exists() else []

    def test_archive_checks_all_slugs_and_restore_returns_the_remote_item(self):
        slug = self.scratch.upload('page.html', '<p>one</p>')
        path = self.remote_store / slug / 'meta.json'
        before = json.loads(path.read_text())
        self.assertEqual(2, self.scratch.cli('archive', slug, 'u' * 32).returncode)
        self.assertEqual(before, json.loads(path.read_text()))
        self.assertEqual('archived: ' + slug, self.scratch.ok('archive', slug).stdout.strip())
        stamp = json.loads(path.read_text())['archivedAt']
        self.assertIn('archived', self.scratch.ok('list').stdout.split())
        self.scratch.upload('page.html', '<p>two</p>', '--replace', slug)
        self.assertEqual(stamp, json.loads(path.read_text())['archivedAt'])
        self.assertEqual('restored: ' + slug, self.scratch.ok('restore', slug).stdout.strip())
        self.assertNotIn('archivedAt', json.loads(path.read_text()))

    def test_a_title_with_shell_characters_arrives_as_text_and_runs_nothing(self):
        title = "q'; touch injected; '$(touch injected)`touch injected`\" \\"
        slug = self.scratch.upload('page.html', '<p>x</p>\n', '--title', title)
        meta = json.loads((self.remote_store / slug / 'meta.json').read_text())
        self.assertEqual(title, meta['title'])
        for folder in (self.remote, self.scratch.base):
            self.assertFalse((folder / 'injected').exists(), folder)

    def test_with_remote_the_file_goes_only_to_the_remote_store_and_here_keeps_it_local(self):
        slug = self.scratch.upload('page.html', '<p>one</p>\n')
        self.scratch.upload('page.html', '<p>two</p>\n', '--replace', slug)
        self.assertEqual([slug], self.names(self.remote_store))
        self.assertEqual(b'<p>two</p>\n', (self.remote_store / slug / 'source').read_bytes())
        self.assertEqual([], self.names(self.scratch.store))
        out = self.scratch.ok('--here', 'upload', str(self.page)).stdout
        here = next(line for line in out.splitlines() if line.startswith('slug:')).split(':', 1)[1].strip()
        self.assertEqual([here], self.names(self.scratch.store))
        self.assertEqual([slug], self.names(self.remote_store))

    def test_setup_refuses_a_destination_that_is_not_plain_and_delete_checks_each_slug_here(self):
        config = self.scratch.home / '.config/tenant-artifacts/config.json'
        before = config.read_bytes()
        for bad in ('-oProxyCommand=x', 'computer b', 'computer;x', 'computer$(x)', 'user@-x'):
            self.assertEqual(2, self.scratch.cli('setup', '--remote=' + bad).returncode, bad)
            self.assertEqual(before, config.read_bytes(), bad)
        self.assertEqual(2, self.scratch.cli('delete', 'a' * 32, 'not-a-slug').returncode)
        self.assertFalse(self.calls.exists())

    def test_no_connection_stops_the_upload_with_exit_3_and_stores_nothing(self):
        done = self.scratch.cli('upload', str(self.page), FAKE_SSH_EXIT='255')
        self.assertEqual(3, done.returncode, done.stderr)
        self.assertTrue(self.calls.exists())
        self.assertEqual([], self.names(self.remote_store))
        self.assertEqual([], self.names(self.scratch.store))

    def test_a_cut_stream_is_not_stored_as_the_file(self):
        """A connection that ends in the middle of the stream gives the remote command the first bytes only."""
        done = self.scratch.cli('upload', str(self.page), FAKE_SSH_CUT='4')
        self.assertEqual(3, done.returncode, done.stderr)
        self.assertEqual([], self.names(self.remote_store))
        self.assertEqual([], self.names(self.scratch.store))

    def test_the_scan_runs_here_first_and_a_failing_scan_sends_nothing(self):
        done = self.scratch.cli('upload', str(self.page), ARTIFACTS_SCAN_COMMAND='false')
        self.assertEqual(5, done.returncode, done.stderr)
        self.assertFalse(self.calls.exists())
        self.assertEqual([], self.names(self.remote_store))


class EventsTests(unittest.TestCase):
    """The event channel /events/v1 of the local server (packages/artifacts/docs/events.md)."""

    def setUp(self):
        self.scratch = Scratch(self)
        self.scratch.ok('start')
        self.token_file = Path(json.loads(self.scratch.ok('--json', 'status').stdout)['events']['token_file'])
        text = self.token_file.read_text()
        self.token = text.strip()

    def open(self, headers, path='/events/v1'):
        connection = http.client.HTTPConnection('127.0.0.1', self.scratch.port, timeout=30)
        self.addCleanup(connection.close)
        connection.request('GET', path, headers=headers)
        return connection.getresponse()

    def stream(self, last=None):
        headers = {'Authorization': 'Bearer ' + self.token}
        if last:
            headers['Last-Event-ID'] = last
        reply = self.open(headers)
        self.assertEqual(200, reply.status)
        return reply

    def message(self, reply):
        """The next message of the stream: (event, id, data). A comment line of the server is skipped."""
        event = ident = data = None
        while True:
            line = reply.fp.readline().decode().rstrip('\n')
            if line.startswith('event: '):
                event = line[7:]
            elif line.startswith('id: '):
                ident = line[4:]
            elif line.startswith('data: '):
                data = json.loads(line[6:])
            elif not line and event:
                return event, ident, data

    def test_a_request_without_the_token_or_with_a_wrong_token_is_refused(self):
        self.assertEqual(0o600, self.token_file.stat().st_mode & 0o777)
        wrong = 'f' * len(self.token)
        for headers in ({}, {'Authorization': 'Bearer ' + wrong}, {'Authorization': 'Bearer'},
                        {'Authorization': 'Basic ' + self.token}, {'X-Human-Review-Token': self.token}):
            reply = self.open(headers)
            self.assertEqual(401, reply.status, headers)
            self.assertNotIn(self.token, reply.read().decode())
        # The token opens the channel only in the header: a path with a query is not the channel.
        self.assertEqual(404, self.open(signed(self.scratch.port, {}), '/events/v1?token=' + self.token).status)
        # The token is in no status answer and in no log line.
        self.assertNotIn(self.token, self.scratch.ok('--json', 'status').stdout + self.scratch.ok('status').stdout)
        status, _, body = request(self.scratch.port, '/healthz')
        self.assertNotIn(self.token, body.decode())
        self.assertNotIn(self.token, (self.scratch.home / '.local/state/tenant-artifacts/server.log').read_text())

    def test_a_request_of_a_web_page_is_refused_also_with_the_token(self):
        auth = {'Authorization': 'Bearer ' + self.token}
        origin = f'http://127.0.0.1:{self.scratch.port}'
        for headers in ({'Origin': origin}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'same-origin'}):
            self.assertEqual(403, self.open(auth | headers).status, headers)
        # Without the token the page check still comes first.
        self.assertEqual(403, self.open({'Origin': origin}).status)

    def test_a_connected_client_gets_the_state_and_then_the_event_of_an_upload(self):
        reply = self.stream()
        event, ident, state = self.message(reply)
        self.assertEqual('state', event)
        self.assertEqual({'count': 0}, state['artifacts'])
        self.assertEqual(f'{state["epoch"]}-{state["seq"]}', ident)
        self.assertEqual('running', state['modules']['artifacts'])
        slug = self.scratch.upload('report.html', '<h1>Report</h1>', '--title', 'First report')
        event, ident, added = self.message(reply)
        self.assertEqual(('artifact.added', slug, 'First report'), (event, added['id'], added['title']))
        self.assertGreater(added['seq'], state['seq'])
        self.assertEqual(f'{state["epoch"]}-{added["seq"]}', ident)
        self.scratch.ok('delete', slug)
        event, _, removed = self.message(reply)
        self.assertEqual(('artifact.removed', slug), (event, removed['id']))

    def test_a_client_that_comes_back_gets_the_missed_events_or_the_full_state(self):
        first = self.stream()
        _, ident, state = self.message(first)
        first.close()
        # No client is connected while this artifact arrives.
        slug = self.scratch.upload('later.html', '<h1>Later</h1>')
        back = self.stream(last=ident)
        event, _, added = self.message(back)
        self.assertEqual(('artifact.added', slug), (event, added['id']))
        back.close()
        # An ID of another server run, or of an event that this run never sent: the full state.
        for last in ('0' * 12 + '-3', f'{state["epoch"]}-{state["seq"] + 50}', 'not-an-id'):
            again = self.stream(last=last)
            event, _, full = self.message(again)
            self.assertEqual(('state', {'count': 1}), (event, full['artifacts']), last)
            again.close()


class MemoryPassTests(unittest.TestCase):
    """The pass of the section /memory to the memory viewer (packages/artifacts/server/memory_front.py)."""

    @classmethod
    def setUpClass(cls):
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(ROOT / 'packages/artifacts/server'))
        import memory_front
        cls.front = memory_front

    def test_the_pass_takes_only_the_listed_paths_and_refuses_each_escape(self):
        listed = self.front.listed
        for method, path in (('GET', '/memory/'), ('GET', '/memory/app.js'), ('GET', '/memory/logo-okknow.svg'),
                             ('GET', '/memory/api/sources'), ('GET', '/memory/api/overview?refresh=1'),
                             ('GET', '/memory/api/search?q=release+notes&sources=okknow%2Chermes&limit=10'),
                             ('GET', '/memory/api/sources/openviking-bob/browse?path=a%2Fb&offset=0'),
                             ('GET', '/memory/api/sources/hermes/item?id=store%2Fuser%231'),
                             ('POST', '/memory/api/sources/agentcore/review')):
            self.assertTrue(listed(method, path), path)
        other = 'example' + '.invalid'
        for method, path in (
                # A dot segment, plain and encoded, and a double slash.
                ('GET', '/memory/../healthz'), ('GET', '/memory/api/../../healthz'), ('GET', '/memory/%2e%2e/healthz'),
                ('GET', '/memory/api/sources/..%2f..%2fx/browse'), ('GET', '/memory//api/sources'),
                ('GET', '//memory/api/sources'), ('GET', '/memory/api//sources'),
                # An absolute address in the path, a host in the path, a backslash and a fragment.
                ('GET', f'/memory/http://{other}/x'), ('GET', f'http://{other}/memory/'), ('GET', f'/memory/@{other}/'),
                ('GET', '/memory/api\\sources'), ('GET', '/memory/api/sources#x'), ('GET', '/memory/api/sources?a=b#c'),
                # A query on the page or on a file, a query with a character outside an encoded form, another
                # prefix, a path that the viewer has but the page does not use, and a wrong method.
                ('GET', '/memory/?next=x'), ('GET', '/memory/app.js?v=1'), ('GET', '/memory/api/sources?a=b c'),
                ('GET', '/memory/api/sources?a=<x>'), ('GET', '/memoryx/api/sources'), ('GET', '/memory'),
                ('GET', '/memory/healthz'), ('GET', '/memory/api/cache/clear'), ('POST', '/memory/api/cache/clear'),
                ('GET', '/memory/api/sources/UPPER/browse'), ('GET', '/memory/api/sources/a/b/browse'),
                ('POST', '/memory/api/sources'), ('POST', '/memory/api/sources/x/review?x=1'),
                ('GET', '/memory/api/sources/x/review'), ('PUT', '/memory/'), ('DELETE', '/memory/api/sources')):
            self.assertFalse(listed(method, path), path)

    def test_the_pass_goes_only_to_the_child_with_the_secret_and_gives_no_redirect_back(self):
        other = 'example' + '.invalid'
        got = []

        class FakeChild(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                got.append((self.command, self.path, dict(self.headers)))
                redirect = self.path.startswith('/api/overview')
                body = b'{"mode":"sample"}'
                self.send_response(302 if redirect else 200)
                if redirect:
                    self.send_header('Location', f'http://{other}/x')
                self.send_header('Content-Type', 'application/json')
                self.send_header('Set-Cookie', 'a=b')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass
        child = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeChild)
        self.addCleanup(child.server_close)
        threading.Thread(target=child.serve_forever, daemon=True).start()
        self.addCleanup(child.shutdown)
        port, secret = child.server_address[1], secrets.token_hex(32)
        status, back, _ = self.front.forward('GET', '/memory/api/sources?x=1', {'Host': '127.0.0.1:1'}, b'', port, secret)
        self.assertEqual(200, status)
        # The child gets the path below the prefix and the secret of the parent; no cookie header comes back.
        self.assertEqual(('GET', '/api/sources?x=1'), got[0][:2])
        self.assertEqual(secret, got[0][2].get(self.front.PARENT_HEADER))
        self.assertNotIn('set-cookie', back)
        # A redirect of the child is no answer of the pass.
        with self.assertRaises(Exception):
            self.front.forward('GET', '/memory/api/overview', {}, b'', port, secret)


if __name__ == '__main__':
    unittest.main()
