"""The admin login of the local server: the verifier file, the hash of the key, the browser sessions and the throttle.

The CLI (`artifacts start`, `artifacts login rotate`) makes the key, writes it into a password system and then writes
the verifier file VERIFIER of the config folder: the user name, the hash algorithm with its parameters, the salt, the
hash, the store kind, the item reference, the creation time and a generation id. The file never holds the key. The
server reads only this file: it never gets the key or a credential of a store. Python 3 standard library only.

A rotate first reads the item of the verifier (the item of `pending` when that entry exists) and keeps the one
hash that fits the key of that item. Then it writes the verifier with that hash and the entry `pending` (the
parameters, the salt and the hash of the new key) with the same generation, so the server takes the stored key and
the new key while the store changes: at most two hashes. Only after a good read-back of the store does the verifier
get the new key as its active hash, no `pending` entry and a new generation. When the rotate stops between these
steps, the `pending` entry stays, and the key that the store holds works.

The server checks the stat of the file on each request that needs the login, so a new key (a new generation) ends
each session of a running server with no restart. With no valid file, the server signs in nobody.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time

USER = 'admin'
VERIFIER = 'admin-login.json'
# The local CLI token: a new one for each run of the server, in this file of the state folder. The CLI sends it in
# TOKEN_HEADER. It is not the event token: that one reaches only /events/v1.
CLI_TOKEN_FILE = 'cli-token'
TOKEN_HEADER = 'X-Tenant-Artifacts-Token'
# The key: 32 random bytes, written as base64url with no padding.
KEY_BYTES = 32
# scrypt: N = 2^14, r = 8, p = 1 needs 16 MiB and about 50 ms. The key has 256 random bits, so the cost only slows a
# copy of the file; it is no defence of a weak key.
SCRYPT = {'n': 2 ** 14, 'r': 8, 'p': 1, 'dklen': 32}
# A session lasts this long after its last request, and the cookie goes out again at most once in this time.
SESSION_SECONDS = 7 * 24 * 3600
COOKIE_SECONDS = 24 * 3600
# After FAILURES failed logins, each login is refused for LOCK_SECONDS.
FAILURES = 5
LOCK_SECONDS = 30


def new_key():
    return base64.urlsafe_b64encode(secrets.token_bytes(KEY_BYTES)).rstrip(b'=').decode('ascii')


def b64(raw):
    return base64.b64encode(raw).decode('ascii')


def available():
    """True when this Python has hashlib.scrypt (an OpenSSL build; Apple's /usr/bin/python3 can lack it)."""
    return hasattr(hashlib, 'scrypt')


def digest(key, salt, params):
    return hashlib.scrypt(key.encode('utf-8'), salt=salt, n=params['n'], r=params['r'], p=params['p'],
                          dklen=params['dklen'], maxmem=64 * 1024 * 1024)


def hashed(key):
    """The parameters, the salt and the hash of `key`, as the fields of a verifier."""
    salt = secrets.token_bytes(16)
    return {'params': dict(SCRYPT), 'salt': b64(salt), 'hash': b64(digest(key, salt, SCRYPT))}


def verifier(key, store, now):
    """The content of a new verifier file for `key`: no field holds the key."""
    return {'version': 1, 'user': USER, 'algorithm': 'scrypt', **hashed(key), 'store': store, 'createdAt': now,
            'generation': secrets.token_hex(8)}


HASH_FIELDS = ('params', 'salt', 'hash', 'store')


def with_pending(data, key, store, keep='active'):
    """The verifier `data` with the entry `pending` for the new key `key` of the store item `store`. `keep` names the
    entry of `data` that stays as the active hash: 'active', or 'pending' (the stored key of an unfinished rotate).
    The other entry goes, so the verifier has two hashes at most. The generation stays, so the sessions live on."""
    base = {name: value for name, value in data.items() if name != 'pending'}
    if keep == 'pending':
        base.update({name: data['pending'][name] for name in HASH_FIELDS})
    return {**base, 'pending': {**hashed(key), 'store': store}}


def fitting_entry(data, key):
    """The entry of the verifier `data` whose hash fits `key`: 'pending', 'active', or None."""
    if data.get('pending') and key_fits(data['pending'], key):
        return 'pending'
    return 'active' if key_fits(data, key) else None


def replace_durably(scratch, path):
    """os.replace of the synced file `scratch` onto `path`, then a sync of the folder, so the new file survives a
    power loss once this returns."""
    os.replace(scratch, path)
    folder = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def valid_hash(entry):
    """True when `entry` has valid scrypt parameters, a salt and a hash in base64."""
    params = entry.get('params')
    try:
        if set(params) != set(SCRYPT) or not all(type(params[k]) is int and params[k] > 0 for k in SCRYPT):
            return False
        base64.b64decode(entry['salt'], validate=True)
        base64.b64decode(entry['hash'], validate=True)
    except (TypeError, KeyError, ValueError):
        return False
    return True


def write_verifier(path, data):
    """Replace the verifier file in one step: a synced scratch file of mode 0600 in the same folder, then
    os.replace and a sync of the folder."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, scratch = tempfile.mkstemp(dir=path.parent, prefix='.admin-login-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps(data, indent=2) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        replace_durably(scratch, path)
    except BaseException:
        try:
            os.unlink(scratch)
        except OSError:
            pass
        raise


def read_verifier(path):
    """The verifier as a dict, or None when the file is absent or not a valid verifier."""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('algorithm') != 'scrypt' or data.get('user') != USER:
        return None
    if not valid_hash(data) or not isinstance(data.get('generation'), str) or not isinstance(data.get('store'), dict):
        return None
    # A `pending` entry that is not valid counts as absent: the active key still works.
    pending = data.get('pending')
    if pending is not None and not (isinstance(pending, dict) and valid_hash(pending)
                                    and isinstance(pending.get('store'), dict)):
        data.pop('pending')
    return data


def key_fits(entry, key):
    try:
        given = digest(key, base64.b64decode(entry['salt']), entry['params'])
    except (ValueError, MemoryError):
        return False
    return hmac.compare_digest(given, base64.b64decode(entry['hash']))


def matches(data, user, key):
    """True when `user` and `key` fit the verifier `data`: its active key or its `pending` key. The comparisons run
    in constant time."""
    good_user = hmac.compare_digest(user.encode('utf-8', 'replace'), data['user'].encode('utf-8'))
    good_key = key_fits(data, key)
    if data.get('pending'):
        good_key = key_fits(data['pending'], key) or good_key
    return good_key and good_user


class Logins:
    """The login state of one server: the verifier of the file, the sessions in memory and the throttle."""

    def __init__(self, path, clock=time.monotonic):
        self.path = Path(path)
        self.clock = clock
        self.lock = threading.Lock()
        # One login try at a time: the check of the lock time, the key check and the count of the failures.
        self.gate = threading.Lock()
        self.stamp = None
        self.data = None
        # session id -> [generation, last use, last time the cookie went out, server-minted session id]
        self.sessions = {}
        self.failures = 0
        self.locked_until = 0.0

    def current(self):
        """The verifier of the file now, or None. A new generation ends each session."""
        try:
            info = os.stat(self.path)
            stamp = (info.st_ino, info.st_mtime_ns, info.st_size)
        except OSError:
            stamp = None
        with self.lock:
            if stamp != self.stamp:
                self.stamp = stamp
                self.data = read_verifier(self.path) if stamp else None
                generation = self.data['generation'] if self.data else None
                self.sessions = {sid: entry for sid, entry in self.sessions.items() if entry[0] == generation}
            return self.data

    def generation(self):
        data = self.current()
        return data['generation'] if data else None

    def session(self, sid):
        """(True, stored session id to send again or None) for a live session id, else (False, None). A hit renews the
        session, and a renewed cookie uses the server-minted id from the table rather than the request header."""
        generation = self.generation()
        if not sid or generation is None:
            return False, None
        now = self.clock()
        with self.lock:
            entry = self.sessions.get(sid)
            if entry is None or entry[0] != generation or now - entry[1] > SESSION_SECONDS:
                self.sessions.pop(sid, None)
                return False, None
            entry[1] = now
            again = now - entry[2] >= COOKIE_SECONDS
            if again:
                entry[2] = now
            return True, (entry[3] if again else None)

    def retry_after(self):
        """The seconds until the next login try is taken, or 0."""
        with self.lock:
            left = self.locked_until - self.clock()
            return int(left) + 1 if left > 0 else 0

    def login(self, user, key):
        """(session id, 0) for the right user name and key, (None, 0) for a wrong one, (None, seconds) while the
        throttle refuses each try. One try at a time: the lock time is checked, the key is checked and the failures
        are counted in one locked step, so parallel tries cannot pass the fifth failure."""
        with self.gate:
            wait = self.retry_after()
            if wait:
                return None, wait
            data = self.current()
            if data is None:
                return None, 0
            if matches(data, user, key):
                now = self.clock()
                sid = secrets.token_urlsafe(32)
                with self.lock:
                    self.failures = 0
                    self.sessions = {s: e for s, e in self.sessions.items() if now - e[1] <= SESSION_SECONDS}
                    self.sessions[sid] = [data['generation'], now, now, sid]
                return sid, 0
            with self.lock:
                self.failures += 1
                if self.failures >= FAILURES:
                    self.failures = 0
                    self.locked_until = self.clock() + LOCK_SECONDS
            return None, 0

    def logout(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)
