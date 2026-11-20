"""The artifacts module: a scan finding stores nothing; delete and replace; the local server admits only loopback
Host names, refuses each method but GET and HEAD, sends the sandbox policy, escapes the facts, reads nothing outside
the store and gives out no value of the Walkr record; the retention sweep; start twice, off, and a decoy PID; the remote
store over ssh."""
import datetime
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


def request(port, path, host=None, method='GET'):
    """(status, headers, body) of one request (GET by default); `host` replaces the Host header."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.request(method, path, headers={'Host': host} if host is not None else {})
        reply = connection.getresponse()
        return reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read()
    finally:
        connection.close()


def health_pid(port):
    try:
        status, _, body = request(port, '/healthz')
    except OSError:
        return None
    return json.loads(body).get('pid') if status == 200 else None


class Scratch:
    """A scratch home with its own config, store and state, and a free port. The real home is never used."""

    def __init__(self, test):
        temp = tempfile.TemporaryDirectory(prefix='artifacts-test-')
        test.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir()
        self.store = self.home / '.local/share/tenant-artifacts/store'
        self.state = self.home / '.local/state/tenant-artifacts/server.json'
        self.port = free_port()
        # A clean scan by default: the seam replaces the kit scanner, which needs the Betterleaks binary.
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1',
                    'ARTIFACTS_SCAN_COMMAND': 'true'}
        self.test = test
        test.addCleanup(self.kill_server)
        self.ok('setup', '--port', str(self.port))

    def cli(self, *args, **env):
        return subprocess.run([sys.executable, str(CLI), *args], env=self.env | env, text=True,
                              capture_output=True, timeout=60, cwd=self.base)

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

    def test_the_server_admits_only_a_loopback_host_name(self):
        for host in ('rebind.invalid', f'rebind.invalid:{self.port}', '', '[::1', '127.0.0.1:99999'):
            for path in ('/healthz', '/'):
                self.assertEqual(403, request(self.port, path, host)[0], (host, path))
        for host in (f'127.0.0.1:{self.port}', 'localhost:1', '[::1]:8080', 'localhost'):
            self.assertEqual(200, request(self.port, '/healthz', host)[0], host)

    def test_an_artifact_view_has_the_sandbox_policy_without_same_origin(self):
        for slug in (self.html, self.markdown):
            status, headers, _ = request(self.port, '/a/' + slug)
            self.assertEqual(200, status)
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

    def test_a_post_to_a_page_gets_405(self):
        for path in ('/', '/artifacts', '/walkr'):
            self.assertEqual(405, request(self.port, path, method='POST')[0], path)


class FakeWalkr(http.server.BaseHTTPRequestHandler):
    """A live Walkr server: /health answers with the PID of the test process and protocol 9."""

    def do_GET(self):
        body = json.dumps({'ok': True, 'pid': os.getpid(), 'protocol': 9}).encode()
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
    token = secrets.token_hex(32)
    walkr_port = live.server_address[1]
    record = scratch.home / '.human-review/server.json'
    record.parent.mkdir()
    record.write_text(json.dumps({'port': walkr_port, 'pid': os.getpid(), 'protocol': 9, 'agentToken': token}))
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
        status, _, body = request(scratch.port, '/walkr')
        self.assertEqual(200, status)
        self.assertNotIn(token.encode(), body)
        self.assertNotIn(str(walkr_port).encode(), body)
        log = (scratch.state.parent / 'server.log').read_text()
        self.assertNotIn(token, log)


    def test_status_json_has_two_state_words_and_no_record_value_and_off_spares_walkr(self):
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
        off = scratch.ok('off')
        self.assertNotIn(token, off.stdout + off.stderr)
        self.assertIsNone(health_pid(scratch.port))
        # off sent no signal to the Walkr PID: that PID is this test process, and the test goes on after off.
        status('stopped')

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
        record.write_text(json.dumps({'port': listener.getsockname()[1], 'pid': os.getpid(), 'protocol': 9,
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
        for args in (('setup', '--port', str(free_port())), ('setup', '--remote', 'computer-c')):
            self.assertEqual(0, scratch.cli(*args, HOME=str(self.remote)).returncode)
        scratch.ok('setup', '--remote', 'computer-b')
        self.page = scratch.base / 'page.html'
        self.page.write_text('<p>x</p>\n')

    def names(self, store):
        return sorted(path.name for path in store.iterdir()) if store.exists() else []

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


if __name__ == '__main__':
    unittest.main()
