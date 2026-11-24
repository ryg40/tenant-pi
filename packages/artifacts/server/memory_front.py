"""The Memory side of the local server: the memory viewer of packages/memory as a child process, and the pass of the
section /memory to it.

The viewer is a Node program (packages/memory/server.mjs --child). This server starts it on 127.0.0.1 with a free
port, and stops it at its own stop. The child has no sign-in of its own: this server writes a secret of this start
to the standard input of the child, and each passed request carries it in the header PARENT_HEADER. The secret is in
no argument, no environment variable, no file and no log line, and no browser gets it. The child ends when its
standard input closes, so it never outlives this server.

The pass (`listed`, `forward`) sends a request only when its method and its whole raw path are in the exact list
PASSED. The target is always 127.0.0.1 with the port of the child and the path below the prefix: no part of a
request chooses the host or the port. An answer of the child with a redirect status never goes back.

The sources of the viewer come from the settings file of the user (`settings_path`). Without that file the viewer
shows its synthetic sample data. Python 3 standard library only.
"""
import json
import os
from pathlib import Path
import re
import secrets
import select
import socket
import subprocess
import threading
import time

# The package of the viewer in this kit, from the real path of this file. The artifacts package works without it.
PACKAGE = Path(__file__).resolve().parents[2] / 'memory'
ENTRY = PACKAGE / 'server.mjs'
# One dependency of the viewer: when its file is absent, `npm ci` did not run in the package.
DEPENDENCY = PACKAGE / 'node_modules/@aws-sdk/client-bedrock-agentcore/package.json'
NODE_MAJOR = 24
PREFIX = '/memory'
PARENT_HEADER = 'X-Tenant-Artifacts-Parent'
SETTINGS = 'memory-sources.json'
# The child must print its ready line in this time.
START_SECONDS = 20
# After a failed start, the next try waits this long, so a broken settings file starts no process for each request.
RETRY_SECONDS = 10
# One deadline for the exchange of one passed request. A source of the viewer has 12 s for one read.
PASS_SECONDS = 40
# The largest body of a passed POST (the viewer takes 4096 bytes) and the largest answer that goes back.
BODY_BYTES = 8 * 1024
ANSWER_BYTES = 32 * 1024 * 1024

# ---------------------------------------------------------------------------
# The pass list
# ---------------------------------------------------------------------------
# The files of the page that packages/memory/lib/web.mjs serves.
STATIC = ('app.css', 'app.js', 'render.js', 'selection.js', 'rail.js', 'theme.css', 'theme.js', 'favicon.svg',
          'logo-openviking.svg', 'logo-okknow.svg', 'logo-llmwiki.svg', 'logo-hermes.svg', 'logo-agentcore.svg')
# The form of a source ID (packages/memory/lib/config.mjs).
SOURCE = r'[a-z0-9][a-z0-9-]{0,39}'
# (methods, pattern of the whole path, a query is allowed). A path with a percent escape, a dot segment, a double
# slash or another host matches no pattern. The page and its files take no query.
PASSED = (
    (('GET',), re.compile(PREFIX + r'/'), False),
    (('GET',), re.compile(PREFIX + r'/(?:' + '|'.join(re.escape(name) for name in STATIC) + r')'), False),
    (('GET',), re.compile(PREFIX + r'/api/(?:sources|overview|recent|search)'), True),
    (('GET',), re.compile(PREFIX + r'/api/sources/' + SOURCE + r'/(?:browse|search|item)'), True),
    (('POST',), re.compile(PREFIX + r'/api/sources/' + SOURCE + r'/review'), False),
)
# A query goes to the child as it came: only the characters of an encoded form (URLSearchParams), at most 8192.
QUERY = re.compile(r'[A-Za-z0-9._~%*+&=-]{0,8192}')
# The request headers that go to the child (never a cookie, a credential or PARENT_HEADER of a client), and the
# answer headers that come back.
FORWARD = ('Host', 'Origin', 'Accept', 'Content-Type', 'Sec-Fetch-Site', 'X-Tenant-Memory-Action')
# The parent sets nosniff on every answer; the child cannot override it.
BACK = ('content-type', 'content-security-policy', 'cache-control', 'referrer-policy',
        'allow', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy')


def listed(method, raw):
    """True when the method and the raw request path are in PASSED. The raw path is the text of the request line:
    nothing is decoded or normalized before the match."""
    path, mark, query = raw.partition('?')
    for methods, pattern, with_query in PASSED:
        if method in methods and pattern.fullmatch(path):
            return not mark or (with_query and QUERY.fullmatch(query) is not None)
    return False


# ---------------------------------------------------------------------------
# What the module needs
# ---------------------------------------------------------------------------
def node_commands():
    """The path of each node command on the PATH of this process, in the order of the PATH, each file one time."""
    found, seen = [], set()
    for folder in os.environ.get('PATH', '').split(os.pathsep):
        path = os.path.join(folder, 'node') if os.path.isabs(folder) else ''
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            real = os.path.realpath(path)
            if real not in seen:
                seen.add(real)
                found.append(path)
    return found


_versions = {}


def node_major(path):
    """The major version of the node command at `path`, or None. One run of `node --version` for each file state."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    key = (info.st_ino, info.st_mtime_ns)
    if _versions.get(path, (None, None))[0] != key:
        try:
            done = subprocess.run([path, '--version'], capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
            match = re.fullmatch(r'v([0-9]{1,3})\.[0-9.]+\s*', done.stdout.decode('ascii', 'replace'))
        except (OSError, subprocess.SubprocessError):
            match = None
        _versions[path] = (key, int(match.group(1)) if match else None)
    return _versions[path][1]


def node():
    """The first node command on the PATH with version NODE_MAJOR or later, or None. A computer can have an older
    node first on the PATH and a newer one behind it."""
    for path in node_commands():
        if (node_major(path) or 0) >= NODE_MAJOR:
            return path
    return None


def missing():
    """One sentence that says what the module needs and does not have, or None when it can start."""
    if not ENTRY.is_file():
        return 'The memory viewer is not in this kit: the folder packages/memory is absent.'
    if node() is None:
        commands = node_commands()
        if not commands:
            return (f'The memory viewer needs Node {NODE_MAJOR} or later, and no node command is on the PATH of '
                    'this server.')
        major = node_major(commands[0])
        found = 'an unknown version' if major is None else f'version {major}'
        return (f'The memory viewer needs Node {NODE_MAJOR} or later; the node command on the PATH of this server '
                f'is {found}.')
    if not DEPENDENCY.is_file():
        return ('The dependencies of the memory viewer are not installed: run install.sh --with memory of the kit, '
                'or npm ci --omit=dev --ignore-scripts in packages/memory.')
    return None


def installed():
    """True when the module can start. An error of the look counts as not installed."""
    try:
        return missing() is None
    except Exception:
        return False


# ---------------------------------------------------------------------------
# The child process
# ---------------------------------------------------------------------------
class Child:
    """The viewer process of this server run. `settings` is the settings file of the user; `env` is the small
    environment of a child of this server; `log` is the log function of the server."""

    def __init__(self, settings, env, log=lambda message: None):
        self.settings, self.env, self.log = Path(settings), env, log
        self.lock = threading.Lock()
        self.process = None
        self.port = None
        self.secret = None
        self.reason = None
        self.tried = 0.0
        self.stopped = False

    def running(self):
        process = self.process
        return process is not None and process.poll() is None and self.port is not None

    def target(self):
        """(port, secret) of the running child. Starts it when it does not run; None when it cannot run now, and
        `why()` then gives the sentence for the page."""
        if self.running():
            return self.port, self.secret
        with self.lock:
            if self.running():
                return self.port, self.secret
            if self.stopped or time.monotonic() - self.tried < RETRY_SECONDS and self.tried:
                return None
            self.tried = time.monotonic()
            self.start()
            return (self.port, self.secret) if self.running() else None

    def why(self):
        return self.reason or missing() or 'The memory viewer does not run now. Load the page again in a moment.'

    def start(self):
        """Start the child and wait for its ready line. The caller holds the lock."""
        self.reap()
        self.port = None
        self.reason = missing()
        if self.reason:
            return
        secret = secrets.token_hex(32)
        try:
            process = subprocess.Popen([node(), str(ENTRY), '--child', '--config', str(self.settings), '--port', '0'],
                                       cwd=str(PACKAGE), env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        except OSError as error:
            self.reason = f'The memory viewer did not start: {error.strerror}.'
            return
        self.process = process
        try:
            process.stdin.write((secret + '\n').encode())
            process.stdin.flush()
            ready = self.ready_line(process)
        except OSError:
            ready = None
        port = ready.get('port') if isinstance(ready, dict) and ready.get('ready') is True else None
        if type(port) is int and 0 < port <= 65535:
            self.port, self.secret, self.reason = port, secret, None
            self.log(f'memory: the viewer runs, pid {process.pid}, mode {ready.get("mode")}')
            return
        # A sentence of the child holds no path and no file content (server.mjs); it is cut and has no control
        # character.
        text = ready.get('error') if isinstance(ready, dict) and isinstance(ready.get('error'), str) else ''
        text = re.sub(r'[\x00-\x1f\x7f]+', ' ', text).strip()[:300]
        self.reason = text or f'The memory viewer gave no ready line in {START_SECONDS} s.'
        self.log('memory: the viewer did not start')
        self.reap(force=True)

    def ready_line(self, process):
        """The JSON value of the first output line of the child, or None after START_SECONDS, at the end of the
        output, or for a line that is no JSON object."""
        deadline = time.monotonic() + START_SECONDS
        raw = b''
        fd = process.stdout.fileno()
        while b'\n' not in raw and len(raw) < 4096:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                return None
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            raw += chunk
        try:
            return json.loads(raw.split(b'\n', 1)[0])
        except ValueError:
            return None

    def reap(self, force=False):
        """End the process of an earlier start, when one is left. Its standard input closes first: the child takes
        that as the end of its parent."""
        process, self.process = self.process, None
        if process is None:
            return
        for stream in (process.stdin, process.stdout):
            try:
                stream.close()
            except OSError:
                pass
        if process.poll() is None:
            if force:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def stop(self):
        """The server stops: the child ends, and no later request starts it again."""
        with self.lock:
            self.stopped = True
            self.port = None
            self.reap(force=True)


# ---------------------------------------------------------------------------
# The pass
# ---------------------------------------------------------------------------
class Closed(Exception):
    """The child does not answer on its port."""


def forward(method, raw, headers, body, port, secret):
    """Send one listed request to the child and return (status, headers, body) of its answer. `raw` is the raw path
    of the request with its query; the child gets the part after PREFIX. `headers` maps the names of FORWARD to
    their values. Raises Closed when the child does not take the connection, TimeoutError after PASS_SECONDS, and
    ValueError for an answer that is not HTTP, is too large or is a redirect.

    The request is HTTP/1.0, so the answer ends when the child closes the connection."""
    deadline = time.monotonic() + PASS_SECONDS

    def left():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('pass deadline')
        return remaining
    lines = [f'{method} {raw[len(PREFIX):]} HTTP/1.0']
    lines += [f'{name}: {value}' for name, value in headers.items()]
    lines += [f'{PARENT_HEADER}: {secret}', f'Content-Length: {len(body)}']
    request = ('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1') + body
    raw_answer = b''
    try:
        connection = socket.create_connection(('127.0.0.1', port), timeout=left())
    except TimeoutError:
        raise
    except OSError:
        raise Closed() from None
    with connection:
        connection.settimeout(left())
        connection.sendall(request)
        while len(raw_answer) <= ANSWER_BYTES:
            connection.settimeout(left())
            chunk = connection.recv(1024 * 1024)
            if not chunk:
                break
            raw_answer += chunk
    if len(raw_answer) > ANSWER_BYTES:
        raise ValueError('answer too large')
    head, end, rest = raw_answer.partition(b'\r\n\r\n')
    status_line, *header_lines = head.decode('latin-1').split('\r\n')
    status = status_line.split(' ', 2)
    if not end or len(status) < 2 or not status[0].startswith('HTTP/') or not re.fullmatch(r'[1-5][0-9]{2}', status[1]):
        raise ValueError('not an HTTP answer')
    # A redirect of the child could send the browser to another place: it never goes back.
    if status[1].startswith('3'):
        raise ValueError('redirect')
    back = {}
    for line in header_lines:
        name, colon, value = line.partition(':')
        if colon and name.strip().lower() in BACK:
            back[name.strip().lower()] = value.strip()
    return int(status[1]), back, rest
