"""The Walkr side of the artifacts server: is Walkr installed, does its live server answer now, and the pass of the
Compare page to that server.

The live Walkr server is a separate Node process. It writes the record `~/.human-review/server.json` with its port,
its PID, its protocol and an agent token. This module reads only the port and the PID, and gives no value of the
record to a caller: the answers say `installed` or not and `open` or `closed`. It never sends the agent token. A
custom HUMAN_REVIEW_STATE_DIR is not supported here. Python 3 standard library only.

The pass (`listed`, `forward`) sends a request of the exact list PASSED to the live server, unchanged, and gives its
answer back. The page token and the checks of the live server decide each request; the pass adds only the Origin
rule of `origin_admitted`.
"""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import time

# The program that marks Walkr as installed, on the PATH of the server process.
PROGRAM = 'walkr-compare'
# SERVER_PROTOCOL of packages/walkr/src/paths.js: a live server of another protocol does not count.
PROTOCOL = 9
# The whole probe (connect, request, answer) takes this long at most, so /healthz stays fast when the record is stale
# or a slow program holds the recorded port.
PROBE_SECONDS = 0.5
# A record larger than this is not a Walkr record.
RECORD_BYTES = 64 * 1024


def installed():
    """True when the program walkr-compare is on the PATH of the server process. Each call looks again, so an
    install shows with no restart. An error of the look counts as not installed."""
    try:
        return shutil.which(PROGRAM) is not None
    except Exception:
        return False


def record_path():
    return Path.home() / '.human-review' / 'server.json'


def read_record():
    """(port, pid) of the record, or None when the record is absent, not a regular file, not valid or names no port
    and PID. The open does not block, so a FIFO at the path of the record cannot hold the reader."""
    try:
        fd = os.open(record_path(), os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        with open(fd, 'rb') as file:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
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
    return port, pid


def probe(port, pid):
    """True when GET /health on 127.0.0.1:port answers 200 with this PID and protocol PROTOCOL. The /health route
    of Walkr is no sign of use, so the probe does not keep the Walkr server alive. No other route is called.

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
    return (isinstance(data, dict) and type(data.get('pid')) is int and data['pid'] == pid
            and type(data.get('protocol')) is int and data['protocol'] == PROTOCOL)


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
SESSION = r'[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}'
# The page secret of one run of the live server: 64 hex characters in the path of the page and of its frames.
SECRET = re.compile(r'[a-f0-9]{64}')
# The pass takes GET only: the Compare page sends no HEAD, so a HEAD stays with the artifacts server.
READ = ('GET',)
PASSED = (
    (READ, re.compile(r'/theme\.css|/theme\.js')),
    (READ, re.compile(r'/_walkr/compare/(?:app\.js|compare-stars\.js|frame-zoom\.js|history-view\.js|compare\.css)')),
    (READ, re.compile(r'/_walkr/compare/g/[a-f0-9]{64}')),
    (READ, re.compile(r'/_walkr/compare/o/[a-f0-9]{64}/' + SESSION + r'/[A-Za-z0-9][A-Za-z0-9._-]{0,63}')),
    (READ, re.compile(r'/_walkr/compare/api/history(?:/h-[a-f0-9]{24})?')),
    (READ, re.compile(r'/_walkr/compare/api/sessions/' + SESSION)),
    (('POST',), re.compile(r'/_walkr/compare/api/sessions/' + SESSION + r'/(?:seen|submit|rate)')),
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
