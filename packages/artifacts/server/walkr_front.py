"""The Walkr side of the artifacts server and of the CLI: is Walkr installed, does its live server answer now, the
address of the Compare page, and the pass of that page to the live server.

The live Walkr server is a separate Node process. It writes the record `~/.human-review/server.json` with its port,
its PID, its protocol and an agent token. This module parses the record and keeps only the port and the PID; the
record check of /walkr also gets the protocol. It gives no field of the record to a caller: `socket_state` says
only `open` or `closed`. It never keeps or sends the agent token. A custom HUMAN_REVIEW_STATE_DIR is not supported
here. Python 3 standard library only.

`open_page` runs `walkr-compare --here open`. That command starts the live server when none runs, or replaces a live
server of an older protocol, and prints the address of the Compare page. The Walkr program reads the agent token itself;
this module gets only the printed address. Its path holds the page secret, which the live server makes at its start
and which is not in the record. The secret is a capability: a holder can read the sessions and submit picks.
`artifacts walkr-url` prints the address. The page /walkr of the server gives it in a redirect, only to a request
that passes the guard of the server (`walkr_page` in artifacts_server.py). An OpenFailed message is a fixed text of
this module; the error output of the child is only in its `detail`, for the CLI.

The pass (`listed`, `forward`) sends a request of the exact list PASSED to the live server, unchanged, and gives its
answer back. The page token and the checks of the live server decide each request; the pass adds only the Origin
rule of `loopback_origin`.
"""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import time
import urllib.parse

# The program that marks Walkr as installed, on the PATH of the server process.
PROGRAM = 'walkr-compare'
# SERVER_PROTOCOL of packages/walkr/src/paths.js: a live server of another protocol does not count.
PROTOCOL = 11
# The whole probe (connect, request, answer) takes this long at most, so /healthz stays fast when the record is stale
# or a slow program holds the recorded port.
PROBE_SECONDS = 0.5
# A record larger than this is not a Walkr record.
RECORD_BYTES = 64 * 1024


def program():
    """The path of the program walkr-compare on the PATH of this process, or None. With no PATH variable, no
    directory is searched (not the system default path): open_page gives the child the same PATH, so the look and the
    run find the same program. Each call looks again, so an install shows with no restart."""
    return shutil.which(PROGRAM, path=os.environ.get('PATH', ''))


def installed():
    """True when program() finds walkr-compare. An error of the look counts as not installed."""
    try:
        return program() is not None
    except Exception:
        return False


def record_path():
    return Path.home() / '.human-review' / 'server.json'


def read_record(protocol=False, private=False):
    """(port, pid) of the record, or None when the record is absent, not a regular file, not valid or names no port
    and PID. The open does not block, so a FIFO at the path of the record cannot hold the reader. With `protocol`,
    (port, pid, the value of the key protocol, None when absent): only for the record check of /walkr
    and the CLI stop. With `private`, refuse a link, another owner's record or access by another user."""
    try:
        flags = os.O_RDONLY | os.O_NONBLOCK | (os.O_NOFOLLOW if private else 0)
        fd = os.open(record_path(), flags)
        with open(fd, 'rb') as file:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
                return None
            raw = file.read(RECORD_BYTES + 1)
        data = json.loads(raw) if len(raw) <= RECORD_BYTES else None
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    port, pid = data.get('port'), data.get('pid')
    if type(port) is not int or not 0 < port <= 65535 or type(pid) is not int or pid <= 0:
        return None
    return (port, pid, data.get('protocol')) if protocol else (port, pid)


def current(protocol):
    """True when Walkr takes a record with this protocol value as one of its own protocol: the JSON number PROTOCOL
    (local-server.js ensureServer: `saved.protocol === SERVER_PROTOCOL`). A boolean is no number here."""
    return type(protocol) in (int, float) and protocol == PROTOCOL


def same(value, wanted):
    """True when two JSON values are equal and of one type, so 9, 9.0, True and '9' are four values."""
    return type(value) is type(wanted) and value == wanted


def probe(port, pid, protocol=PROTOCOL):
    """True when GET /health on 127.0.0.1:port answers 200 with this PID and the protocol value `protocol` (same();
    None: no protocol key or null). The /health route of Walkr is no sign of use, so the probe does not keep the
    Walkr server alive. No other route is called.

    One deadline of PROBE_SECONDS covers the whole probe: each socket step waits only for the time that is left, so
    a program that answers byte by byte cannot hold the probe longer. The request is HTTP/1.0, so the answer ends
    when the server closes the connection."""
    deadline = time.monotonic() + PROBE_SECONDS

    def left():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('probe deadline')
        return remaining
    raw = b''
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=left()) as connection:
            connection.settimeout(left())
            connection.sendall(f'GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n'.encode())
            while len(raw) <= RECORD_BYTES:
                connection.settimeout(left())
                chunk = connection.recv(RECORD_BYTES + 1 - len(raw))
                if not chunk:
                    break
                raw += chunk
    except OSError:
        return False
    head, end, body = raw.partition(b'\r\n\r\n')
    status = head.split(b'\r\n', 1)[0].split()
    if len(raw) > RECORD_BYTES or not end or len(status) < 2 or not status[0].startswith(b'HTTP/') \
            or status[1] != b'200':
        return False
    try:
        data = json.loads(body)
    except ValueError:
        return False
    return isinstance(data, dict) and same(data.get('pid'), pid) and same(data.get('protocol'), protocol)


def socket_state():
    """'open' when the record names a live Walkr server of protocol PROTOCOL, else 'closed'. This is the boundary to
    /healthz: any error of the record or of the probe (for example a RecursionError of deeply nested JSON) gives
    'closed' and is not logged, because its text can hold a value of the record."""
    try:
        record = read_record()
        return 'open' if record is not None and probe(*record) else 'closed'
    except Exception:
        return 'closed'


# ---------------------------------------------------------------------------
# The pass of the Compare page
# ---------------------------------------------------------------------------
# The exact list of the requests that the pass sends to the live Walkr server: (methods, path pattern). The patterns
# are the routes that the Compare page uses (packages/walkr/src/compare-server.js, compare.js, compare.html). A
# pattern matches the whole raw path of the request, so a path with a query or a fragment, a percent escape or a dot
# segment is never passed. Each other request stays with the artifacts server: a POST gets 405, a GET the 404.
# A test reads the files and the module imports of compare.html and the routes of compare.js, so a new file of the page
# fails it until it is in this list (tests/test_artifacts_walkr.py, CompareRequestsTests).
SESSION = r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}'
# The page secret of one run of the live server: 64 hex characters in the path of the page and of its frames.
SECRET = re.compile(r'[a-f0-9]{64}')
# The pass takes GET only: the Compare page sends no HEAD, so a HEAD stays with the artifacts server.
READ = ('GET',)
PASSED = (
    (READ, re.compile(r'/theme\.css|/theme\.js')),
    (READ, re.compile(r'/_walkr/compare/(?:app\.js|a2ui\.js|compare-a2ui\.js|compare-stars\.js|feedback\.js|frame-zoom\.js|a2ui\.css|compare\.css|feedback\.css)')),
    (READ, re.compile(r'/_walkr/compare/g/[a-f0-9]{64}')),
    # An HTML option, or with next/ the HTML preview of a Next round card: an optionId and a roundId have one rule.
    (READ, re.compile(r'/_walkr/compare/o/[a-f0-9]{64}/' + SESSION + r'/(?:next/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}')),
    (READ, re.compile(r'/_walkr/compare/api/history')),
    (READ, re.compile(r'/_walkr/compare/api/sessions/' + SESSION)),
    (('POST',), re.compile(r'/_walkr/compare/api/sessions/' + SESSION + r'/(?:seen|submit|rate)')),
    (READ, re.compile(r'/_walkr/feedback/(?:feedback\.js|feedback\.css)')),
    # Sandboxed Feedback HTML frame: component preview or option concept overview.
    (READ, re.compile(r'/_walkr/feedback/o/[a-f0-9]{64}/' + SESSION + r'/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}')),
    (READ, re.compile(r'/_walkr/feedback/api/sessions/' + SESSION)),
    (('POST',), re.compile(r'/_walkr/feedback/api/sessions/' + SESSION + r'/(?:seen|expand|respond|rate)')),
)
# One deadline covers the probe, the connect, the request and the whole answer, so a live server that stops or answers byte by
# byte cannot hold a thread of the front longer.
PASS_SECONDS = 10
# The largest body of a passed POST: the request limit of the live server (8 MiB).
BODY_BYTES = 8 * 1024 * 1024
# The largest answer of the live server that the pass gives back.
ANSWER_BYTES = 64 * 1024 * 1024
# The request headers that go to the live server; each other header stays here (no cookie, no credential).
FORWARD = ('Host', 'Origin', 'Content-Type', 'X-Human-Review-Token')
# The answer headers that come back: the content type and the policy headers.
BACK = ('content-type', 'content-security-policy', 'cache-control', 'x-content-type-options', 'referrer-policy',
        'allow')
CLOSED_REASON = 'No live Walkr server answers. Run artifacts walkr-url for a new page address.'


class Closed(Exception):
    """No live Walkr server answers on the recorded port."""


def listed(method, path):
    """True when the method and the raw path are in PASSED."""
    return any(method in methods and pattern.fullmatch(path) for methods, pattern in PASSED)


def mask(text):
    """The text with each page secret replaced, for a log line."""
    return SECRET.sub('<secret>', text)


def loopback_origin(value, loopback_host):
    """True when `value` is an HTTP origin (no path) with a loopback name and any port. `loopback_host` is the Host
    rule of the server."""
    return value.startswith('http://') and '/' not in value[7:] and loopback_host(value[7:])


def forward(method, path, headers, body):
    """Send one listed request to the live Walkr server and return (status, headers, body) of its answer. `headers`
    maps the names of FORWARD to their values. Raises Closed when no live Walkr server answers, TimeoutError when its
    answer does not end in PASS_SECONDS from the start of the pass (the probe included), and ValueError for an answer that is not HTTP or too large.

    The request is HTTP/1.0, so the answer ends when the live server closes the connection. The Compare page uses no
    stream (it polls every 2 seconds), so the pass reads the whole answer before it gives it back."""
    # One deadline for the whole pass: the probe of the live server and the request share PASS_SECONDS.
    deadline = time.monotonic() + PASS_SECONDS
    record = read_record()
    if record is None or not probe(*record):
        raise Closed()

    def left():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('pass deadline')
        return remaining
    lines = [f'{method} {path} HTTP/1.0']
    lines += [f'{name}: {value}' for name, value in headers.items()]
    lines.append(f'Content-Length: {len(body)}')
    request = ('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1') + body
    raw = b''
    try:
        connection = socket.create_connection(('127.0.0.1', record[0]), timeout=left())
    except TimeoutError:
        raise
    except OSError:
        raise Closed() from None
    with connection:
        connection.settimeout(left())
        connection.sendall(request)
        while len(raw) <= ANSWER_BYTES:
            connection.settimeout(left())
            chunk = connection.recv(1024 * 1024)
            if not chunk:
                break
            raw += chunk
    if len(raw) > ANSWER_BYTES:
        raise ValueError('answer too large')
    head, end, rest = raw.partition(b'\r\n\r\n')
    status_line, *header_lines = head.decode('latin-1').split('\r\n')
    status = status_line.split(' ', 2)
    if not end or len(status) < 2 or not status[0].startswith('HTTP/') or not re.fullmatch(r'[1-5][0-9]{2}', status[1]):
        raise ValueError('not an HTTP answer')
    back = {}
    for line in header_lines:
        name, colon, value = line.partition(':')
        if colon and name.strip().lower() in BACK:
            back[name.strip().lower()] = value.strip()
    return int(status[1]), back, rest


# ---------------------------------------------------------------------------
# The address of the Compare page
# ---------------------------------------------------------------------------
# open_page stops `walkr-compare open` after this time. Walkr itself gives up its start after about 6 s, and a slow
# request after 10 s.
OPEN_SECONDS = 20
# The page address that `walkr-compare open` prints: the path holds the page secret, the fragment a session ID.
PAGE = re.compile(r'/_walkr/compare/g/[a-f0-9]{64}')
NOT_INSTALLED = f'Walkr is not installed: the program {PROGRAM} is not on the PATH'


class OpenFailed(Exception):
    """`walkr-compare open` gave no page address. `code` is the exit code of `artifacts walkr-url`: 2 the session is
    unknown or the ID is not valid, 3 no answer of the live server, 4 Walkr or Node is absent.

    The message is a fixed text of this module: it holds no byte of the child. `returncode` is the exit code of the
    child (negative for a signal), or None when the child did not run or did not end in time. `detail` is one line of
    the error output of the child for the CLI:
    each page secret is masked before the cut to 300 characters, but other values of the child can stay (for example
    a PID or a token of another form). The server shows and logs only the message and the exit code."""

    def __init__(self, code, message, detail='', returncode=None):
        super().__init__(message)
        self.code, self.detail, self.returncode = code, detail, returncode

    def reason(self):
        """The message with the exit code of the child, for the server: no byte of the child."""
        return str(self) + (f' (exit code {self.returncode})' if self.returncode is not None else '')


def child_env():
    """A small environment for a child of the CLI or of the server: PATH, HOME and the XDG variables that are set.
    It holds neither WALKR_SHEPRD_CONNECT nor HERDR_ENV, so the optional Sheprd link of Walkr stays off: Sheprd must
    not get the address on the Walkr port."""
    return {name: value for name, value in os.environ.items()
            if name in ('PATH', 'HOME') or name.startswith('XDG_')}


def open_page(session=None, cwd=None, seconds=OPEN_SECONDS):
    """The path of the Compare page, with `#<session>` when `session` is given. Runs `walkr-compare --here open`
    with child_env() in `cwd`; that command starts the live Walkr server when none runs and prints the address on the
    Walkr port. Only the path and the fragment of that address count: the caller puts them on its own origin. The
    front shows the Walkr server of this computer, so `--here` keeps the command here also with the key `remote` of
    the artifacts config file (remote mode of walkr-compare). Raises OpenFailed."""
    env = child_env()
    path = program()
    if path is None:
        raise OpenFailed(4, NOT_INSTALLED)
    try:
        done = subprocess.run([path, '--here', 'open'] + ([session] if session else []), env=env,
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=seconds, cwd=cwd)
    except subprocess.TimeoutExpired:
        raise OpenFailed(3, f'the live Walkr server gave no page address in {seconds} s') from None
    except OSError as error:
        raise OpenFailed(4, f'{PROGRAM} cannot run: {error.strerror}') from None
    # For the CLI: one line of the error output. The mask runs before the cut, so a cut secret cannot stay.
    detail = mask(re.sub(r'[\x00-\x1f\x7f]+', ' ', done.stderr.decode('utf-8', 'replace'))).strip()[:300]
    if done.returncode == 2:
        raise OpenFailed(2, 'the session is unknown or the ID is not valid', detail, 2)
    if done.returncode in (126, 127):
        # The program is a Node script: env exits 127 when node is not on the PATH.
        raise OpenFailed(4, f'{PROGRAM} cannot run; is Node on the PATH?', detail, done.returncode)
    if done.returncode != 0:
        raise OpenFailed(3, 'the live Walkr server did not answer', detail, done.returncode)
    lines = done.stdout.decode('utf-8', 'replace').split()
    try:
        address = urllib.parse.urlsplit(lines[-1] if lines else '')
    except ValueError:  # for example an IPv6 host with no closing bracket
        address = None
    if (address is None or address.scheme != 'http' or address.query or not PAGE.fullmatch(address.path)
            or address.fragment and not re.fullmatch(SESSION, address.fragment)):
        raise OpenFailed(3, f'{PROGRAM} open printed no page address')
    return address.path + (f'#{address.fragment}' if address.fragment else '')
