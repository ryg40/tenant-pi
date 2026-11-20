"""The artifacts module: a scan finding stores nothing; delete and replace; the local server admits only loopback
Host names, sends the sandbox policy, escapes the facts and reads nothing outside the store; the retention sweep;
start twice, off, and a decoy PID; the remote store over ssh."""
import datetime
import http.client
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
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


def request(port, path, host=None):
    """(status, headers, body) of one GET; `host` replaces the Host header."""
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.request('GET', path, headers={'Host': host} if host is not None else {})
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
        self.html = self.scratch.upload('page.html', '<h1>Page</h1>\n')
        self.markdown = self.scratch.upload('notes.md', '# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
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
        for path in ('/', '/v/' + slug):
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
        self.assertNotIn(MARKER.encode(), request(self.port, '/')[2])


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
