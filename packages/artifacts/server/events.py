"""The event channel of the local server for the Herdr app: one authenticated event stream over plain HTTP.

`GET /events/v1` answers with `text/event-stream` (Server-Sent Events). A client gets the present state first, then
one message for each change: an artifact was added, changed, archived, restored or removed; a Compare session waits for a pick; a
Compare result was submitted; the agent received a result; a module started or stopped. The contract is
packages/artifacts/docs/events.md. Python 3 standard library only.

The sources need no call of another program. A watcher thread reads the artifact store and the Compare session
records of the Walkr root every WATCH_SECONDS, only while a client is connected, and once when a client connects.
It sends the Walkr server no request and reads no agent token, so the watch does not keep the Walkr server awake.
An event can arrive up to WATCH_SECONDS late, plus the time of one read.

Sign-in: the request carries `Authorization: Bearer <token>`. The server writes a new token at each start to the
file TOKEN_FILE of its state directory, mode 0600. The token is in no status answer, no address and no log line.
A request with an `Origin` or a `Sec-Fetch-Site` header is a request of a web page and gets 403 before the token
check.
"""
import collections
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import socket
import stat
import threading
import time

# The version of the contract. A change that an old client cannot read gets a new number and a new path.
VERSION = 1
PATH = f'/events/v{VERSION}'
TOKEN_FILE = 'events-token'
# The limits: clients at one time, bytes of one message, waiting messages of one client, and kept events for a
# client that comes back.
CLIENTS = 8
MESSAGE_BYTES = 16 * 1024
QUEUE = 256
KEEP = 512
# The watcher reads its sources this often while a client is connected.
WATCH_SECONDS = 2
# A comment line goes out after this time with no message, so each side sees a dead link.
BEAT_SECONDS = 15
# A write to a client that does not read ends after this time, and the server closes that client.
SEND_SECONDS = 10
# The longest title in a message.
TITLE = 200
# The Compare records: the form of a session ID, the most session folders of one read, the largest record.
SESSION = re.compile(r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}')
SESSIONS = 5000
RECORD_BYTES = 16 * 1024 * 1024
# The most waiting sessions that a state message lists; the count is always complete.
LISTED = 100


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def short(value, limit=TITLE):
    """A text value for a message: a string of at most `limit` characters with no control character, else ''."""
    if not isinstance(value, str):
        return ''
    return re.sub(r'[\x00-\x1f\x7f]+', ' ', value).strip()[:limit]


def write_token(state_dir, name=TOKEN_FILE):
    """Make a new token, write it to the file `name` (default TOKEN_FILE) of `state_dir` with mode 0600 and return
    it. The write goes to a new file that replaces the old one, so no reader sees a part of a token and no old link
    is followed."""
    token = secrets.token_hex(32)
    directory = Path(state_dir)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    scratch = directory / f'.{name}-{secrets.token_hex(4)}'
    fd = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='ascii') as handle:
            handle.write(token + '\n')
        os.replace(scratch, directory / name)
    except BaseException:
        try:
            os.unlink(scratch)
        except OSError:
            pass
        raise
    return token


# ---------------------------------------------------------------------------
# The sources: what the watcher reads
# ---------------------------------------------------------------------------
def compare_root():
    """The default Compare root of Walkr. The server runs with a small environment (walkr_front.child_env), so the
    live Walkr server that it starts uses this root too."""
    return Path.home() / '.local/.walkr/compare'


def read_session(sessions_fd, name):
    """(stamp, facts) of the record of one session folder, or None. The read follows no symlink, takes only a regular
    file of at most RECORD_BYTES and keeps a few short fields. `stamp` changes when a writer replaces the record."""
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        folder = os.open(name, flags | getattr(os, 'O_DIRECTORY', 0), dir_fd=sessions_fd)
    except OSError:
        return None
    try:
        try:
            fd = os.open('session.json', flags | getattr(os, 'O_NONBLOCK', 0), dir_fd=folder)
        except OSError:
            return None
        with open(fd, 'rb') as file:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > RECORD_BYTES:
                return None
            stamp = (info.st_ino, info.st_mtime_ns, info.st_size)
            raw = file.read(RECORD_BYTES + 1)
    finally:
        os.close(folder)
    try:
        doc = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(doc, dict) or doc.get('sessionId') != name or doc.get('status') not in ('open', 'submitted'):
        return None
    repo = doc.get('repo') if isinstance(doc.get('repo'), dict) else {}
    return stamp, {'status': doc['status'], 'title': short(doc.get('title')), 'createdAt': short(doc.get('createdAt'), 40),
                   'workflow': short(doc.get('workflow'), 64), 'repo': short(repo.get('name'), 100),
                   'received': isinstance(doc.get('receivedAt'), str), 'outcome': isinstance(doc.get('outcome'), dict)}


def stamp_of(sessions_fd, name):
    """The stamp of the record of one session folder with no read of its content, or None."""
    try:
        info = os.stat(f'{name}/session.json', dir_fd=sessions_fd, follow_symlinks=False)
    except OSError:
        return None
    return (info.st_ino, info.st_mtime_ns, info.st_size) if stat.S_ISREG(info.st_mode) else None


def compare_sessions(root, known):
    """{session ID: (stamp, facts)} of the Compare root. `known` is the answer of the call before: a record with the
    same stamp is not read again. A missing root gives {}. A record that cannot be read is left out."""
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    try:
        sessions_fd = os.open(Path(root) / 'sessions', flags)
    except OSError:
        return {}
    found = {}
    try:
        names = sorted(name for name in os.listdir(sessions_fd) if SESSION.fullmatch(name))[-SESSIONS:]
        for name in names:
            stamp = stamp_of(sessions_fd, name)
            if stamp is None:
                continue
            if name in known and known[name][0] == stamp:
                found[name] = known[name]
                continue
            record = read_session(sessions_fd, name)
            if record is not None:
                found[name] = record
    except OSError:
        pass
    finally:
        os.close(sessions_fd)
    return found


# ---------------------------------------------------------------------------
# The hub: the model, the kept events and the clients
# ---------------------------------------------------------------------------
class Client:
    def __init__(self):
        self.queue = queue.Queue(maxsize=QUEUE)
        self.connection = None
        self.dropped = False


class Hub:
    """The state of the channel. `artifacts` gives {slug: (version, title, archived)} of the store; `modules` gives
    {module name: True when it runs}; `root` is the Compare root. One lock covers the model, the kept events and the
    client list, so a client that connects gets a state and then each later event, with no gap."""

    def __init__(self, token, artifacts, modules, root=None):
        self.token = token
        self.read_artifacts, self.read_modules = artifacts, modules
        self.root = compare_root() if root is None else Path(root)
        self.epoch = secrets.token_hex(6)
        self.seq = 0
        self.kept = collections.deque(maxlen=KEEP)
        self.clients = set()
        self.lock = threading.Lock()
        # One read of the sources at a time: a slow read must not write an older result over a newer one.
        self.reading = threading.Lock()
        self.closed = False
        self.artifacts, self.sessions, self.modules = {}, {}, {}
        self.scan(first=True)

    # -- the model -----------------------------------------------------------
    def scan(self, first=False):
        """Read the sources and publish one event for each change since the last read. The first read of a server run
        publishes nothing: its result is the state. A source that cannot be read keeps its last value."""
        with self.reading:
            self.read(first)

    def read(self, first):
        try:
            artifacts = self.read_artifacts()
        except Exception:
            artifacts = self.artifacts
        try:
            modules = dict(self.read_modules())
        except Exception:
            modules = self.modules
        sessions = compare_sessions(self.root, self.sessions)
        with self.lock:
            if not first:
                for slug in sorted(artifacts.keys() - self.artifacts.keys()):
                    self.publish('artifact.added', slug, title=short(artifacts[slug][1]))
                for slug in sorted(artifacts.keys() & self.artifacts.keys()):
                    version, title, archived = artifacts[slug]
                    if version != self.artifacts[slug][0]:
                        self.publish('artifact.changed', slug, title=short(title))
                    if archived != self.artifacts[slug][2]:
                        self.publish('artifact.archived' if archived else 'artifact.restored', slug, title=short(title))
                for slug in sorted(self.artifacts.keys() - artifacts.keys()):
                    self.publish('artifact.removed', slug)
                for name in sorted(sessions):
                    new, old = sessions[name][1], (self.sessions.get(name) or (None, None))[1]
                    if old is None and new['status'] == 'open':
                        self.publish('compare.waiting', name, title=new['title'], createdAt=new['createdAt'],
                                     workflow=new['workflow'], **({'repo': new['repo']} if new['repo'] else {}))
                    if new['status'] == 'submitted' and (old is None or old['status'] == 'open'):
                        self.publish('compare.submitted', name, title=new['title'])
                    if new['received'] and (old is None or not old['received']):
                        self.publish('compare.received', name)
                for name in sorted(set(modules) | set(self.modules)):
                    if bool(modules.get(name)) != bool(self.modules.get(name)):
                        self.publish('module.started' if modules.get(name) else 'module.stopped', name)
            self.artifacts, self.sessions, self.modules = artifacts, sessions, modules

    def state(self):
        """The state message. The caller holds the lock."""
        waiting = [(name, facts) for name, (_, facts) in self.sessions.items() if facts['status'] == 'open']
        waiting.sort(key=lambda item: item[0], reverse=True)
        unread = sum(1 for _, facts in self.sessions.values()
                     if facts['status'] == 'submitted' and not facts['received'] and not facts['outcome'])
        data = {
            'kind': 'state', 'version': VERSION, 'epoch': self.epoch, 'seq': self.seq, 'time': now(),
            'artifacts': {'count': len(self.artifacts)},
            'compare': {
                'waiting': len(waiting), 'unreceived': unread,
                'sessions': [{'id': name, 'title': facts['title'], 'createdAt': facts['createdAt'],
                              'workflow': facts['workflow'], **({'repo': facts['repo']} if facts['repo'] else {})}
                             for name, facts in waiting[:LISTED]],
            },
            'modules': {name: 'running' if on else 'stopped' for name, on in sorted(self.modules.items())},
        }
        return self.frame('state', self.seq, data)

    # -- the messages --------------------------------------------------------
    def frame(self, kind, seq, data):
        """The bytes of one message. A message over MESSAGE_BYTES loses its title and its session list; the counts
        and the identifiers stay."""
        def encode(fields):
            body = json.dumps(fields, separators=(',', ':'))
            return f'event: {kind}\nid: {self.epoch}-{seq}\ndata: {body}\n\n'.encode()

        frame = encode(data)
        if len(frame) > MESSAGE_BYTES:
            data = {key: value for key, value in data.items() if key != 'title'}
            if isinstance(data.get('compare'), dict):
                data['compare'] = {**data['compare'], 'sessions': []}
            return encode(data)
        return frame

    def publish(self, kind, ident, **fields):
        """Add one event and give it to each client. The caller holds the lock. A client with a full queue does not
        read: it is dropped, and its connection is shut so that its thread ends."""
        self.seq += 1
        message = self.frame(kind, self.seq, {'kind': kind, 'id': ident, 'time': now(), 'seq': self.seq, **fields})
        self.kept.append((self.seq, message))
        for client in list(self.clients):
            try:
                client.queue.put_nowait(message)
            except queue.Full:
                self.drop(client)

    def drop(self, client):
        client.dropped = True
        self.clients.discard(client)
        try:
            client.connection.shutdown(socket.SHUT_RDWR)
        except (OSError, AttributeError):
            pass

    # -- the clients ---------------------------------------------------------
    def connect(self, connection, last):
        """A new client and its first messages, or None when CLIENTS are connected. `last` is the Last-Event-ID
        value: with the epoch of this run and a sequence number whose later events are all kept, the client gets
        those events; else it gets the state."""
        self.scan()
        with self.lock:
            if self.closed or len(self.clients) >= CLIENTS:
                return None, []
            client = Client()
            client.connection = connection
            match = re.fullmatch(r'([a-f0-9]{12})-([0-9]{1,18})', last or '')
            first = [self.state()]
            if match and match.group(1) == self.epoch:
                seen, oldest = int(match.group(2)), self.kept[0][0] if self.kept else self.seq + 1
                if seen <= self.seq and seen + 1 >= oldest:
                    first = [message for number, message in self.kept if number > seen]
            self.clients.add(client)
            return client, first

    def leave(self, client):
        with self.lock:
            self.clients.discard(client)

    def watched(self):
        with self.lock:
            return bool(self.clients)

    def close(self):
        """The server stops: each client gets the event of that and its connection ends."""
        with self.lock:
            self.closed = True
            self.publish('module.stopped', 'artifacts')
            for client in list(self.clients):
                try:
                    client.queue.put_nowait(None)
                except queue.Full:
                    self.drop(client)


def watcher(hub, stop):
    """Read the sources every WATCH_SECONDS while a client is connected."""
    while not stop.wait(WATCH_SECONDS):
        if hub.watched():
            try:
                hub.scan()
            except Exception:  # one failed read must not end the watcher
                pass


# ---------------------------------------------------------------------------
# The request
# ---------------------------------------------------------------------------
def refusal(headers, token):
    """(status, code, message) when the request must not get the stream, else None. The page check comes first, so a
    page learns nothing about the token."""
    if headers.get('Origin') is not None or headers.get('Sec-Fetch-Site') is not None:
        return 403, 'FORBIDDEN', 'The event channel is not for a web page.'
    values = headers.get_all('Authorization') or []
    sent = values[0].strip() if len(values) == 1 else ''
    scheme, _, given = sent.partition(' ')
    if scheme.lower() != 'bearer' or not hmac.compare_digest(given.strip().encode('utf-8', 'replace'), token.encode()):
        return 401, 'UNAUTHORIZED', 'Send the token of the events-token file as a Bearer credential.'
    return None


def stream(handler, hub):
    """Answer one admitted request with the event stream, until the client leaves or the server stops. `handler`
    is the request handler of the server; this function writes the whole answer itself."""
    client, first = hub.connect(handler.connection, handler.headers.get('Last-Event-ID'))
    if client is None:
        return False
    try:
        handler.connection.settimeout(SEND_SECONDS)
        handler.send_response(200)
        for name, value in (('Content-Type', 'text/event-stream; charset=utf-8'), ('Cache-Control', 'no-store'),
                            ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'),
                            ('X-Accel-Buffering', 'no'), ('Connection', 'close')):
            handler.send_header(name, value)
        handler.end_headers()
        handler.close_connection = True
        # One comment line first, so a client that came back with nothing missed sees that the stream is open.
        handler.wfile.write(b': open\n\n')
        for message in first:
            handler.wfile.write(message)
        handler.wfile.flush()
        while not client.dropped:
            try:
                message = client.queue.get(timeout=BEAT_SECONDS)
            except queue.Empty:
                message = b': beat\n\n'
            if message is None:
                break
            handler.wfile.write(message)
            handler.wfile.flush()
    except OSError:  # the client left, or it did not read for SEND_SECONDS
        pass
    finally:
        hub.leave(client)
    return True
