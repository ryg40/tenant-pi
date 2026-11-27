"""The password systems of the admin key: the macOS Keychain, Bitwarden, Vault and an opt-in file. The CLI only.

Each store writes the key and reads it back. The key goes to a store program only on its standard input, never as an
argument; a Bitwarden session goes only in the BW_SESSION variable of the child. Each store program gets an environment
from an allow list (`child_env`): Vault and the Keychain get no BW_SESSION, and Bitwarden gets no VAULT_TOKEN. A `bw`
runs only as a direct Node script with a Node of version MIN_NODE or later, or as a native program (`bw_launcher`): an
older Node can throw away the stored keys of an unlocked session, and a wrapper script can start one. Each program runs
by its absolute path. The server never imports this file. Python 3 standard library only.

`auto` order: on macOS the Keychain when `security` works, then Bitwarden when an unlocked session exists, then Vault
when VAULT_ADDR is set and `vault token lookup` works. `auto` never chooses the file store.
"""
import base64
import functools
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import login as login_lib

RUN_SECONDS = 60
# The tenant-credsync session cache counts only while it is younger than this.
SESSION_SECONDS = 43200
VAULT_MOUNT = 'kv'
KEY_FILE = 'admin-key'
# The oldest Node major version that runs a `bw` Node script.
MIN_NODE = 20
# The environment of each store program: these names and the names with these prefixes, nothing else. Only the
# networked stores (bw, vault) get the proxy variables.
BASE_NAMES = ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
              'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR')
BASE_PREFIXES = ('LC_',)
PROXY_NAMES = tuple(name for proxy in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY')
                    for name in (proxy, proxy.lower()))
BW_NAMES = ('NODE_EXTRA_CA_CERTS', 'NODE_NO_WARNINGS', *PROXY_NAMES)
VAULT_NAMES = PROXY_NAMES
# The first bytes of a native program: ELF, and Mach-O (32 and 64 bit, both byte orders, and the universal form).
NATIVE_MAGIC = (b'\x7fELF', b'\xfe\xed\xfa\xce', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xcf\xfa\xed\xfe',
                b'\xca\xfe\xba\xbe')
BW_PREFIXES = ('BITWARDENCLI_',)
VAULT_PREFIXES = ('VAULT_',)


class StoreError(Exception):
    """A store that cannot take or give the key. The message names the store and the fix, never a value."""


def host_part():
    """The short host name, limited to safe characters, for the item names."""
    name = re.sub(r'[^A-Za-z0-9-]', '', socket.gethostname().split('.')[0])[:63]
    return name or 'host'


def child_env(names=(), prefixes=(), **values):
    """The environment of a store program: the names of BASE_NAMES and `names`, the names with a prefix of
    BASE_PREFIXES and `prefixes`, then `values`."""
    keep = set(BASE_NAMES) | set(names)
    starts = BASE_PREFIXES + tuple(prefixes)
    env = {name: value for name, value in os.environ.items() if name in keep or name.startswith(starts)}
    return {**env, **values}


def program(name, search=None):
    """The absolute path of the program `name` on the PATH (or the path list `search`). A command runs by this path:
    by its bare name, a program that cannot start would make Python try the next program of that name on the PATH.
    An empty or relative entry of the PATH gives a relative path, which is made absolute from the current folder."""
    found = shutil.which(name, path=search)
    if not found:
        raise StoreError(f'no {name} on the PATH')
    return os.path.abspath(found)


def run(command, data='', env=None):
    """Run one store program with `data` on its standard input. The command holds no key. With no `env`, the program
    gets the base allow list of child_env."""
    if env is None:
        env = child_env()
    try:
        return subprocess.run(command, input=data, capture_output=True, text=True, timeout=RUN_SECONDS, env=env)
    except subprocess.TimeoutExpired:
        raise StoreError(f'{command[0]} did not answer in {RUN_SECONDS} s') from None
    except OSError as error:
        raise StoreError(f'{command[0]} did not run ({type(error).__name__})') from None


# ---------------------------------------------------------------------------
# The macOS Keychain: an internet password
# ---------------------------------------------------------------------------
def keychain_usable():
    return (bool(shutil.which('security'))
            and run([program('security'), 'list-keychains', '-d', 'user']).returncode == 0)


def keychain_item(port):
    return {'kind': 'keychain', 'server': '127.0.0.1', 'port': port, 'account': 'admin', 'protocol': 'http'}


def keychain_words(item):
    return ['-s', item['server'], '-P', str(item['port']), '-a', item['account'], '-r', item['protocol']]


def keychain_write(item, key):
    # `security -i` reads its command from standard input, so the key is in no argument of a process.
    line = ' '.join(shlex.quote(word) for word in ['add-internet-password', '-U', *keychain_words(item), '-w', key])
    done = run([program('security'), '-i'], line + '\n')
    if done.returncode:
        raise StoreError(f'security add-internet-password ended with exit {done.returncode}')
    return item


def keychain_read(item):
    done = run([program('security'), 'find-internet-password', *keychain_words(item), '-w'])
    return done.stdout.strip() if done.returncode == 0 else None


# ---------------------------------------------------------------------------
# Bitwarden: a Login item, through an unlocked session
# ---------------------------------------------------------------------------
def credsync_cache():
    """The session cache file of tenant-credsync. It is only read, never changed."""
    runtime = os.environ.get('XDG_RUNTIME_DIR')
    if runtime:
        return Path(runtime) / 'tenant-credsync' / 'bw-session'
    return Path(f'/dev/shm/tenant-credsync-{os.getuid()}') / 'bw-session'


def bw_session():
    """BW_SESSION of the environment, else the young tenant-credsync cache, else None."""
    value = os.environ.get('BW_SESSION', '').strip()
    if value:
        return value
    path = credsync_cache()
    try:
        if time.time() - path.stat().st_mtime >= SESSION_SECONDS:
            return None
        value = path.read_text(encoding='utf-8').strip()
    except (OSError, ValueError):
        return None
    return value or None


def bw_env(session):
    return child_env(BW_NAMES, BW_PREFIXES, BW_SESSION=session)


def program_kind(path):
    """('script', the words of the `#!` line), ('native', None) for an ELF or Mach-O program, or ('other', None)."""
    try:
        with open(path, 'rb') as handle:
            first = handle.readline(512)
    except OSError as error:
        raise StoreError(f'cannot read the program {path} ({type(error).__name__})') from None
    if first.startswith(b'#!'):
        return 'script', first[2:].decode('utf-8', 'replace').split()
    return ('native' if first[:4] in NATIVE_MAGIC else 'other'), None


@functools.lru_cache(maxsize=None)
def bw_launcher(search):
    """The command that runs `bw` of the PATH `search`, as a tuple of absolute paths: (node, real path of bw) for a
    direct Node script (`#!/usr/bin/env node`, or an absolute `#!` path that ends in /node), (real path,) for a native
    program (ELF or Mach-O). Raises StoreError for each other file (a wrapper script can start an old Node), and when
    the Node of a Node script is missing or older than MIN_NODE; then no `bw` runs."""
    real = os.path.realpath(program('bw', search))
    kind, words = program_kind(real)
    if kind == 'native':
        return (real,)
    refused = (f'bw ({real}) is not a direct Node script and not a native program, so its Node cannot be checked. '
               'Put a bw whose first line is #!/usr/bin/env node, or a native bw, first on the PATH')
    if kind != 'script' or not words:
        raise StoreError(refused)
    if os.path.basename(words[0]) == 'env' and os.path.isabs(words[0]):
        names = [word for word in words[1:] if not word.startswith('-') and '=' not in word]
        if not names or names[0] != 'node':
            raise StoreError(refused)
        try:
            node = program('node', search)
        except StoreError:
            raise StoreError(f'bw ({real}) is a Node script, and no node is on the PATH. Put a Node {MIN_NODE} or '
                             'later first on the PATH') from None
    elif os.path.basename(words[0]) == 'node' and os.path.isabs(words[0]):
        node = words[0]
    else:
        raise StoreError(refused)
    # The real path: a version-manager link cannot change between the check and the calls.
    node = os.path.realpath(node)
    done = run([node, '--version'])
    match = re.fullmatch(r'v?(\d+)(\.\d+)*', done.stdout.strip())
    version = done.stdout.strip()[:20] if match else 'unknown'
    if done.returncode or not match or int(match.group(1)) < MIN_NODE:
        raise StoreError(f'bw ({real}) is a Node script, and its node {node} is version {version}; bw needs Node '
                         f'{MIN_NODE} or later, else it can throw away the stored keys of the session. Put a Node '
                         f'{MIN_NODE} or later first on the PATH')
    return (node, real)


def bw_run(words, data, session):
    """Run `bw words` with the checked Node (bw_launcher) and the Bitwarden environment."""
    return run([*bw_launcher(os.environ.get('PATH', os.defpath)), *words], data, bw_env(session))


def bitwarden_usable():
    if not shutil.which('bw'):
        return False
    session = bw_session()
    if session is None:
        return False
    done = bw_run(['status'], '', session)
    try:
        return done.returncode == 0 and json.loads(done.stdout).get('status') == 'unlocked'
    except (ValueError, AttributeError):
        return False


def bw(words, data, session):
    done = bw_run(words, data, session)
    if done.returncode:
        raise StoreError(f'bw {" ".join(words[:2])} ended with exit {done.returncode}')
    return done.stdout


def bw_encode(value):
    """What `bw encode` gives: the base64 of the UTF-8 JSON text. In Python, so no child gets the session."""
    return base64.b64encode(json.dumps(value).encode('utf-8')).decode('ascii')


def bitwarden_item(port):
    return {'kind': 'bitwarden', 'name': f'tenant-artifacts admin ({host_part()})', 'uri': f'http://127.0.0.1:{port}'}


def bitwarden_write(item, key):
    session = bw_session()
    if session is None:
        raise StoreError('no unlocked Bitwarden session')
    if item.get('id'):
        try:
            current = json.loads(bw(['get', 'item', item['id']], '', session))
        except ValueError:
            raise StoreError(f'bw get item gave no JSON for the item {item["name"]}') from None
        current.setdefault('login', {})['password'] = key
        bw(['edit', 'item', item['id']], bw_encode(current), session)
        return item
    # A Login item in no folder, so tenant-credsync never writes it into a shell file.
    value = {'type': 1, 'name': item['name'], 'notes': None, 'favorite': False, 'folderId': None,
             'organizationId': None, 'fields': [], 'reprompt': 0,
             'login': {'username': 'admin', 'password': key, 'uris': [{'uri': item['uri'], 'match': None}]}}
    try:
        made = json.loads(bw(['create', 'item'], bw_encode(value), session))
        ident = made['id']
    except (ValueError, KeyError, TypeError):
        raise StoreError(f'bw create item gave no item id for {item["name"]}') from None
    if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', ident):
        raise StoreError(f'bw create item gave no valid item id for {item["name"]}')
    return {**item, 'id': ident}


def bitwarden_read(item):
    session = bw_session()
    if session is None or not item.get('id'):
        return None
    done = bw_run(['get', 'item', item['id']], '', session)
    try:
        return json.loads(done.stdout)['login']['password'] if done.returncode == 0 else None
    except (ValueError, KeyError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Vault: the KV field `key`
# ---------------------------------------------------------------------------
def vault_usable():
    return (bool(shutil.which('vault')) and bool(os.environ.get('VAULT_ADDR'))
            and run([program('vault'), 'token', 'lookup'], env=vault_env()).returncode == 0)


def vault_env():
    return child_env(VAULT_NAMES, VAULT_PREFIXES)


def vault_item(port):
    return {'kind': 'vault', 'mount': VAULT_MOUNT, 'path': f'tenant-artifacts/{host_part()}/admin', 'field': 'key'}


def vault_write(item, key):
    # `key=-` reads the value from standard input (vault kv put -h).
    done = run([program('vault'), 'kv', 'put', f'-mount={item["mount"]}', item['path'], f'{item["field"]}=-'], key,
               vault_env())
    if done.returncode:
        raise StoreError(f'vault kv put ended with exit {done.returncode}')
    return item


def vault_read(item):
    done = run([program('vault'), 'kv', 'get', f'-mount={item["mount"]}', f'-field={item["field"]}', item['path']],
               env=vault_env())
    return done.stdout.strip() if done.returncode == 0 else None


# ---------------------------------------------------------------------------
# The file store: only when the user chose it
# ---------------------------------------------------------------------------
def file_item(folder):
    return {'kind': 'file', 'path': str(Path(folder) / KEY_FILE)}


def file_write(item, key):
    path = Path(item['path'])
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, scratch = tempfile.mkstemp(dir=path.parent, prefix='.admin-key-')
        with os.fdopen(fd, 'w', encoding='ascii') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(key + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        login_lib.replace_durably(scratch, path)
    except OSError as error:
        raise StoreError(f'cannot write {path} ({type(error).__name__})') from None
    return item


def file_read(item):
    try:
        return Path(item['path']).read_text(encoding='ascii').strip()
    except (OSError, ValueError):
        return None


STORE = {
    'keychain': (keychain_usable, keychain_item, keychain_write, keychain_read),
    'bitwarden': (bitwarden_usable, bitwarden_item, bitwarden_write, bitwarden_read),
    'vault': (vault_usable, vault_item, vault_write, vault_read),
    'file': (lambda: True, None, file_write, file_read),
}


NAMES = {'keychain': 'the Keychain', 'bitwarden': 'Bitwarden', 'vault': 'Vault', 'file': 'the file store'}


def choose(setting, note=lambda line: print(line, file=sys.stderr)):
    """The store kind for a new key: the setting, or the first usable store of the `auto` order. None when no store
    is usable. A probe error (StoreError) of the setting goes to the caller; in `auto`, it means "not usable": `note`
    gets one line with the reason, and the order goes on."""
    if setting != 'auto':
        return setting if STORE[setting][0]() else None
    order = (['keychain'] if sys.platform == 'darwin' else []) + ['bitwarden', 'vault']
    for kind in order:
        try:
            if STORE[kind][0]():
                return kind
        except StoreError as error:
            note(f'artifacts: {NAMES[kind]} skipped: {error}')
    return None


def new_item(kind, port, folder):
    return file_item(folder) if kind == 'file' else STORE[kind][1](port)


def addressable(item):
    """True when the store can find `item`: a Bitwarden item needs its id."""
    return item.get('kind') != 'bitwarden' or bool(item.get('id'))


def describe(item):
    """The item reference as text: no value."""
    kind = item.get('kind')
    if kind == 'bitwarden':
        return f'Bitwarden item "{item.get("name")}"' + (f' (id {item["id"]})' if item.get('id') else '')
    if kind == 'keychain':
        return (f'Keychain internet password, account {item.get("account")}, server {item.get("server")}, '
                f'port {item.get("port")}')
    if kind == 'vault':
        return f'Vault {item.get("mount")}/{item.get("path")}, field {item.get("field")}'
    if kind == 'file':
        return f'file {item.get("path")}'
    return 'unknown store'


def store_key(item, key):
    """Write `key` into the store of `item`, read it back and compare it in memory. Returns the item with its final
    reference (a new Bitwarden item gets its id). Raises StoreError."""
    kind = item['kind']
    _, _, write, read = STORE[kind]
    item = write(item, key)
    back = read(item)
    if back is None or back != key:
        raise StoreError(f'the store took the key, but the read-back of {describe(item)} '
                         + ('failed' if back is None else 'gave another value'))
    return item
