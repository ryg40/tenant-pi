"""The admin login of the local artifacts server: a request with no session and no token gets no data from a
protected route, while /events/v1, /healthz and /login stay reachable; the right key gives a session and a wrong key
does not; a rotate ends the old session and the old key; a first start with no usable store starts no server and
writes no verifier, a store whose read-back differs writes none, and a failed rotate keeps the old one; the key is in
no argument of a store program, no output and no server log; each store program gets no credential of another
store; a `bw` Node script with an old Node never runs; the local CLI token passes and a wrong one does not.

The password systems are fake programs on a scratch PATH: they record their arguments and the names of their
environment variables, and keep their data in the scratch folder. No real Bitwarden, Vault or Keychain is asked."""
import json
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from urllib.parse import urlencode

from tests.test_artifacts import TOKEN_HEADER, Scratch, request

# Each fake records its arguments as one JSON line in <folder>/args and the names (not the values) of its environment
# variables in <folder>/env, and keeps its data in <folder>. The folder is in the script: the store programs get only
# the environment of their allow list.
FAKE_HEAD = '''#!{python}
import base64, json, os, shlex, sys
folder = {folder!r}
name = os.path.basename(sys.argv[0])
with open(os.path.join(folder, 'args'), 'a') as log:
    log.write(json.dumps([name] + sys.argv[1:]) + '\\n')
with open(os.path.join(folder, 'env'), 'a') as log:
    log.write(json.dumps([name, sorted(os.environ)]) + '\\n')
args = sys.argv[1:]
'''
# The fake bw is a direct Node script; the fake Node 24 below runs it with Python.
FAKE_BW = FAKE_HEAD.replace('#!{python}', '#!/usr/bin/env node') + '''
items = os.path.join(folder, 'items.json')
data = json.load(open(items)) if os.path.exists(items) else {{}}
if args == ['status']:
    print(json.dumps({{'status': 'unlocked' if os.environ.get('BW_SESSION') else 'locked'}}))
elif args == ['encode']:
    print(base64.b64encode(sys.stdin.read().encode()).decode())
elif args[:2] in (['create', 'item'], ['edit', 'item']):
    item = json.loads(base64.b64decode(sys.stdin.read()))
    item['id'] = args[2] if args[0] == 'edit' else 'item-' + str(len(data) + 1)
    data[item['id']] = item
    json.dump(data, open(items, 'w'))
    print(json.dumps(item))
elif args[:2] == ['get', 'item'] and args[2] in data:
    item = data[args[2]]
    if os.path.exists(os.path.join(folder, 'wrong')):
        item['login']['password'] += 'x'
    print(json.dumps(item))
else:
    sys.exit(1)
'''
FAKE_VAULT = FAKE_HEAD + '''
value = os.path.join(folder, 'vault-value')
if args == ['token', 'lookup']:
    sys.exit(0)
if args[:2] == ['kv', 'put'] and args[-1] == 'key=-' and not os.path.exists(os.path.join(folder, 'fail-put')):
    open(value, 'w').write(sys.stdin.read())
    # An armed failure: each read after this write fails.
    if os.path.exists(os.path.join(folder, 'arm-fail-get')):
        os.rename(os.path.join(folder, 'arm-fail-get'), os.path.join(folder, 'fail-get'))
elif args[:2] == ['kv', 'get'] and os.path.exists(value) and not os.path.exists(os.path.join(folder, 'fail-get')):
    print(open(value).read())
else:
    sys.exit(1)
'''
FAKE_SECURITY = FAKE_HEAD + '''
value = os.path.join(folder, 'keychain-value')
if args == ['list-keychains', '-d', 'user']:
    sys.exit(0)
if args == ['-i']:
    words = shlex.split(sys.stdin.read())
    if words[0] != 'add-internet-password':
        sys.exit(1)
    open(value, 'w').write(words[words.index('-w') + 1])
elif args[0] == 'find-internet-password' and args[-1] == '-w' and os.path.exists(value):
    print(open(value).read())
else:
    sys.exit(1)
'''
# A Node 18 and a `bw` Node script: the CLI must run neither the script nor this node with it. Each call of the node
# but --version is a call of bw.
FAKE_OLD_NODE = FAKE_HEAD.replace("name = os.path.basename(sys.argv[0])",
                                  "name = 'node' if sys.argv[1:] == ['--version'] else 'bw'") + '''
if args == ['--version']:
    print('v18.20.4')
'''
FAKE_NEW_NODE = '''#!{python}
import os, sys
if sys.argv[1:] == ['--version']:
    print('v24.0.0')
else:
    os.execv({python!r}, [{python!r}, *sys.argv[1:]])
'''
FAKE_NODE_BW = '''#!/usr/bin/env node
process.exit(1);
'''
# A `bw` shell wrapper: it could start an old Node itself, so it must never run. A run leaves the file `wrapper-ran`.
FAKE_WRAPPER_BW = '''#!/bin/sh
touch {folder}/wrapper-ran
exit 1
'''
# A `security` stub that fails: on macOS /usr/bin/security is on the scratch PATH, so `auto` tests stub it out to
# avoid asking the host Keychain.
FAKE_NO_KEYCHAIN = '''#!/bin/sh
exit 1
'''
FAKES = {'bitwarden': ('bw', FAKE_BW), 'vault': ('vault', FAKE_VAULT), 'keychain': ('security', FAKE_SECURITY),
         'no-keychain': ('security', FAKE_NO_KEYCHAIN), 'old-node': ('node', FAKE_OLD_NODE),
         'node-bw': ('bw', FAKE_NODE_BW), 'wrapper-bw': ('bw', FAKE_WRAPPER_BW)}


def fake_store(scratch, kind):
    """Put the fake program of `kind` first on the scratch PATH; returns its data folder."""
    folder = scratch.base / 'fake'
    tools = scratch.base / 'fakebin'
    folder.mkdir(exist_ok=True)
    tools.mkdir(exist_ok=True)
    name, source = FAKES[kind]
    (tools / name).write_text(source.format(python=sys.executable, folder=str(folder))
                              if '{' in source else source)
    (tools / name).chmod(0o755)
    if not scratch.env['PATH'].startswith(f'{tools}:'):
        scratch.env['PATH'] = f'{tools}:' + scratch.env['PATH']
    if kind == 'bitwarden':
        (tools / 'node').write_text(FAKE_NEW_NODE.format(python=sys.executable))
        (tools / 'node').chmod(0o755)
    if kind in ('bitwarden', 'node-bw', 'wrapper-bw'):
        scratch.env['BW_SESSION'] = secrets.token_hex(8)
    if kind == 'vault':
        scratch.env['VAULT_ADDR'] = 'http://127.0.0.1:1'
    return folder


def stored_key(scratch, folder, kind):
    """The key that the store of `kind` holds now."""
    if kind == 'file':
        return (scratch.home / '.config/tenant-artifacts/admin-key').read_text().strip()
    if kind == 'bitwarden':
        items = json.loads((folder / 'items.json').read_text())
        return next(iter(items.values()))['login']['password']
    return (folder / ('vault-value' if kind == 'vault' else 'keychain-value')).read_text().strip()


def calls(folder, name):
    """The recorded argument lists of the fake `name`."""
    path = folder / 'args'
    lines = path.read_text().splitlines() if path.exists() else []
    return [words for words in map(json.loads, lines) if words[0] == name]


def verifier(scratch):
    return scratch.home / '.config/tenant-artifacts/admin-login.json'


def log_in(port, key, user='admin', target='/artifacts'):
    """(status, headers) of POST /login with the form of the login page."""
    body = urlencode({'user': user, 'key': key, 'next': target}).encode()
    status, headers, _ = request(port, '/login', method='POST', body=body, token=False,
                                 headers={'Origin': f'http://127.0.0.1:{port}',
                                          'Content-Type': 'application/x-www-form-urlencoded'})
    return status, headers


def cookie_of(headers):
    return headers['set-cookie'].split(';', 1)[0]


class GateTests(unittest.TestCase):
    def test_no_session_and_no_token_get_no_data_and_the_open_routes_stay_reachable(self):
        scratch = Scratch(self)
        marker = 'login-marker-' + secrets.token_hex(4)
        slug = scratch.upload('page.html', f'<p>{marker}</p>\n')
        scratch.ok('start')
        port = scratch.port
        json_body = {'Origin': f'http://127.0.0.1:{port}', 'Content-Type': 'application/json'}
        page = 303
        cases = [('GET', '/', page), ('GET', '/artifacts', page), ('GET', '/artifacts/archive', page),
                 ('GET', '/v/' + slug, page), ('GET', '/walkr', page), ('GET', '/memory/', page),
                 ('GET', '/_walkr/compare/g/' + secrets.token_hex(32), page), ('GET', '/unknown', page),
                 ('GET', '/api/state', 401), ('GET', '/api/login', 401), ('GET', '/a/' + slug, 401),
                 ('GET', '/d/' + slug, 401), ('POST', '/api/archive/' + slug, 401),
                 ('GET', '/memory/api/sources', 401), ('GET', '/_walkr/compare/api/sessions/20261125T120000Z-' + secrets.token_hex(6), 401),
                 # The open routes: their own answers, not the login.
                 ('GET', '/healthz', 200), ('GET', '/login', 200), ('GET', '/static/theme.css', 200),
                 ('GET', '/events/v1', 401)]
        open_paths = {'/healthz', '/login', '/static/theme.css', '/events/v1'}
        before = scratch.files(slug)
        for method, path, expected in cases:
            with self.subTest(path=path):
                status, headers, body = request(port, path, method=method, token=False,
                                                headers=json_body if method == 'POST' else None,
                                                body=b'{}' if method == 'POST' else None)
                self.assertEqual(expected, status)
                self.assertNotIn(marker.encode(), body)
                if path not in open_paths:
                    self.assertNotIn('set-cookie', headers)
                if expected == page:
                    self.assertEqual('/login', headers['location'].split('?', 1)[0])
        self.assertEqual(before, scratch.files(slug))
        # /events/v1 keeps its own token rule: its refusal names the Bearer scheme.
        self.assertEqual('Bearer', request(port, '/events/v1', token=False)[1].get('www-authenticate'))

    def test_the_cli_token_passes_and_a_wrong_token_is_refused(self):
        scratch = Scratch(self)
        scratch.ok('start')
        self.assertEqual(200, request(scratch.port, '/api/state')[0])
        wrong = {TOKEN_HEADER: secrets.token_hex(32)}
        for path in ('/api/state', '/artifacts'):
            self.assertEqual(401, request(scratch.port, path, headers=wrong, token=False)[0], path)


class LoginTests(unittest.TestCase):
    def test_the_right_key_gives_a_session_a_wrong_key_does_not_and_a_rotate_ends_both(self):
        scratch = Scratch(self)
        scratch.ok('start')
        port = scratch.port
        key = stored_key(scratch, None, 'file')
        status, headers = log_in(port, secrets.token_urlsafe(32))
        self.assertEqual(401, status)
        self.assertNotIn('set-cookie', headers)
        self.assertEqual(401, log_in(port, key, user='root')[0])
        status, headers = log_in(port, key)
        self.assertEqual((303, '/artifacts'), (status, headers['location']))
        session = {'Cookie': cookie_of(headers)}
        self.assertEqual(200, request(port, '/artifacts', headers=session, token=False)[0])
        scratch.ok('login', 'rotate')
        self.assertEqual(303, request(port, '/artifacts', headers=session, token=False)[0])
        self.assertEqual(401, log_in(port, key)[0])
        self.assertEqual(303, log_in(port, stored_key(scratch, None, 'file'))[0])

    def test_cookie_renewal_returns_the_stored_session_id_after_the_renewal_interval(self):
        server_dir = str(Path(__file__).resolve().parents[1] / 'packages/artifacts/server')
        if server_dir not in sys.path:
            sys.path.insert(0, server_dir)
        import login as login_lib

        with tempfile.TemporaryDirectory(prefix='artifacts-login-') as temp:
            path = Path(temp) / login_lib.VERIFIER
            key = login_lib.new_key()
            login_lib.write_verifier(path, login_lib.verifier(key, {'kind': 'file'}, '2026-01-01T00:00:00Z'))
            now = [100.0]
            logins = login_lib.Logins(path, clock=lambda: now[0])
            sid, wait = logins.login(login_lib.USER, key)
            self.assertEqual(0, wait)
            incoming = sid.encode('ascii').decode('ascii')
            self.assertEqual((True, None), logins.session(incoming))
            now[0] += login_lib.COOKIE_SECONDS
            live, renewed = logins.session(incoming)
            self.assertTrue(live)
            self.assertIs(sid, renewed)
            self.assertEqual((True, None), logins.session(incoming))


class StoreTests(unittest.TestCase):
    def test_no_usable_store_or_a_wrong_read_back_starts_no_server_and_writes_no_verifier(self):
        scratch = Scratch(self, key_store='auto')
        fake_store(scratch, 'no-keychain')
        done = scratch.cli('start')
        self.assertEqual(6, done.returncode)
        self.assertIsNone(json.loads(scratch.ok('--json', 'status').stdout).get('pid'))
        self.assertFalse(verifier(scratch).exists())
        folder = fake_store(scratch, 'bitwarden')
        (folder / 'wrong').touch()
        self.assertEqual(6, scratch.cli('start').returncode)
        self.assertIsNone(json.loads(scratch.ok('--json', 'status').stdout).get('pid'))
        self.assertFalse(verifier(scratch).exists())

    def test_failed_rotates_keep_the_key_of_the_store_and_a_good_rotate_ends_the_earlier_keys(self):
        scratch = Scratch(self, key_store='vault')
        folder = fake_store(scratch, 'vault')
        scratch.ok('start')
        keys = [stored_key(scratch, folder, 'vault')]
        # Rotate 1: the fake vault takes the new key, then its read-back fails.
        (folder / 'arm-fail-get').touch()
        self.assertEqual(6, scratch.cli('login', 'rotate').returncode)
        keys.append(stored_key(scratch, folder, 'vault'))
        self.assertEqual(303, log_in(scratch.port, keys[0])[0])
        self.assertEqual(303, log_in(scratch.port, keys[1])[0])
        self.assertTrue(json.loads(scratch.ok('--json', 'login', 'status').stdout)['pending'])
        # Rotate 2: the read works again, and the store write fails.
        (folder / 'fail-get').rename(folder / 'fail-put')
        self.assertEqual(6, scratch.cli('login', 'rotate').returncode)
        self.assertEqual(303, log_in(scratch.port, stored_key(scratch, folder, 'vault'))[0])
        # Rotate 3 works: only its key logs in.
        (folder / 'fail-put').rename(folder / 'no-fail')
        scratch.ok('login', 'rotate')
        self.assertEqual(303, log_in(scratch.port, stored_key(scratch, folder, 'vault'))[0])
        for key in keys:
            self.assertEqual(401, log_in(scratch.port, key)[0])

    def test_a_rotate_refuses_an_unreadable_item_and_fresh_gives_a_working_key(self):
        scratch = Scratch(self, key_store='bitwarden')
        folder = fake_store(scratch, 'bitwarden')
        scratch.ok('start')
        old = stored_key(scratch, folder, 'bitwarden')
        # The Bitwarden item of the verifier is gone.
        (folder / 'items.json').rename(folder / 'items-gone.json')
        self.assertEqual(6, scratch.cli('login', 'rotate').returncode)
        self.assertFalse(json.loads(scratch.ok('--json', 'login', 'status').stdout)['pending'])
        self.assertEqual(303, log_in(scratch.port, old)[0])
        scratch.ok('login', 'rotate', '--fresh')
        self.assertEqual(303, log_in(scratch.port, stored_key(scratch, folder, 'bitwarden'))[0])

    def test_a_bw_node_script_with_an_old_node_or_a_bw_wrapper_never_runs(self):
        scratch = Scratch(self, key_store='bitwarden')
        fake_store(scratch, 'no-keychain')
        folder = fake_store(scratch, 'old-node')
        fake_store(scratch, 'node-bw')
        self.assertEqual(6, scratch.cli('start').returncode)
        self.assertEqual([], calls(folder, 'bw'))
        fake_store(scratch, 'wrapper-bw')
        self.assertEqual(6, scratch.cli('start').returncode)
        self.assertFalse((folder / 'wrapper-ran').exists())
        scratch.ok('setup', '--key-store', 'auto')
        fake_store(scratch, 'vault')
        scratch.ok('start')
        self.assertEqual('vault', json.loads(scratch.ok('--json', 'login', 'status').stdout)['store']['kind'])
        self.assertEqual([], calls(folder, 'bw'))
        self.assertFalse((folder / 'wrapper-ran').exists())

    def test_the_key_is_in_no_argument_no_output_and_no_server_log_and_no_store_gets_another_credential(self):
        for kind in ('bitwarden', 'vault', 'keychain'):
            with self.subTest(kind=kind):
                scratch = Scratch(self, key_store=kind)
                folder = fake_store(scratch, kind)
                marker = 'ARTIFACTS_MARKER_' + secrets.token_hex(4).upper()
                scratch.env.update({'VAULT_TOKEN': secrets.token_hex(8), 'BW_SESSION': secrets.token_hex(8),
                                    marker: secrets.token_hex(8)})
                outputs = [scratch.ok('start')]
                keys = [stored_key(scratch, folder, kind)]
                self.assertEqual(0o600, verifier(scratch).stat().st_mode & 0o777)
                outputs.append(scratch.ok('login', 'rotate'))
                keys.append(stored_key(scratch, folder, kind))
                outputs += [scratch.ok('login', 'status'), scratch.ok('--json', 'login', 'status'),
                            scratch.ok('status')]
                self.assertEqual(303, log_in(scratch.port, keys[1])[0])
                texts = [done.stdout + done.stderr for done in outputs]
                texts += [(folder / 'args').read_text(), verifier(scratch).read_text(),
                          (scratch.home / '.local/state/tenant-artifacts/server.log').read_text()]
                for key in keys:
                    for channel, value in enumerate(texts):
                        self.assertFalse(key in value, f'{kind}: the key is in text {channel}')
                seen = [json.loads(line) for line in (folder / 'env').read_text().splitlines()]
                self.assertTrue(seen)
                for name, names in seen:
                    self.assertNotIn(marker, names)
                    self.assertNotIn('BW_SESSION' if name != 'bw' else 'VAULT_TOKEN', names)


if __name__ == '__main__':
    unittest.main()
