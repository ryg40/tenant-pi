"""The local tenant-artifacts server: a read-only web server on 127.0.0.1 for the artifacts of the store.

`artifacts start` runs this file: `python3 -B artifacts_server.py --port N`. The root page links to the index of
the artifacts (/artifacts) and to the Walkr page (/walkr). The server answers GET and HEAD only, except the requests
that it passes to the live Walkr server for the Compare page (walkr_front.PASSED). It admits only a loopback peer with
a loopback name in the Host header, and runs a retention sweep at its start and then once an hour. It runs until `artifacts off`. Python 3 standard library only.

To add a screen, add one entry to ROUTES. To add a content type, add one entry to VIEWS (and to the upload types of
the CLI).
"""
import argparse
import faulthandler
import hashlib
import html
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socketserver
import sys
import threading
import time
import unicodedata
from urllib.parse import quote

import artifacts_store as store_lib
import walkr_front

WEB = Path(__file__).resolve().parent / 'web'
SWEEP_SECONDS = 3600
# /api/state answers from the last read of the store while it is younger than this, so many open pages cost one read.
STATE_SECONDS = 2
LOOPBACK_NAMES = ('127.0.0.1', 'localhost', '[::1]')
# The policy of each artifact answer: no allow-same-origin, so a stored page gets an opaque origin and cannot act
# as the server origin. The frame of the viewer page has the same tokens.
SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals allow-downloads'
# The policy of the pages of the server origin (the index and the viewer): the poll of /api/state goes to this
# origin only.
PAGE_POLICY = ("default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; "
               "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
COMMON_HEADERS = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                  'Cache-Control': 'no-store'}
# The static files: URL name -> content type. The server reads no other file of its web directory.
STATIC = {
    'index.css': 'text/css; charset=utf-8',
    'index.js': 'text/javascript; charset=utf-8',
    'live.js': 'text/javascript; charset=utf-8',
    'viewer.js': 'text/javascript; charset=utf-8',
    'markdown.css': 'text/css; charset=utf-8',
    'markdown.js': 'text/javascript; charset=utf-8',
    'vendor/marked.umd.js': 'text/javascript; charset=utf-8',
    'vendor/highlight.min.js': 'text/javascript; charset=utf-8',
}


class Answer:
    def __init__(self, status, body=b'', content_type='text/plain; charset=utf-8', headers=None):
        self.status, self.body, self.content_type, self.headers = status, body, content_type, headers or {}


def text(status, message):
    return Answer(status, (message + '\n').encode('utf-8'))


def log(message):
    print(time.strftime('%Y-%m-%dT%H:%M:%S') + ' ' + message, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# The views: content type -> (label of the index, renderer of the view, file extension of a download)
# ---------------------------------------------------------------------------
def html_view(meta, source):
    """An HTML artifact goes out as stored."""
    return source


MARKDOWN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<link rel="stylesheet" href="/static/markdown.css">
</head>
<body>
<main class="page">
<pre id="source" class="source">{source}</pre>
</main>
<script src="/static/vendor/marked.umd.js"></script>
<script src="/static/markdown.js"></script>
</body>
</html>
"""


def markdown_view(meta, source):
    """A small page that holds the Markdown as inert text; the browser renders it with the vendored marked."""
    page = MARKDOWN_PAGE.format(title=html.escape(str(meta.get('title') or 'Artifact')),
                                source=html.escape(source.decode('utf-8', 'replace')))
    return page.encode('utf-8')


VIEWS = {
    'text/html': ('HTML', html_view, '.html'),
    'text/markdown': ('Markdown', markdown_view, '.md'),
}


# ---------------------------------------------------------------------------
# The routes: path pattern -> handler. A handler gets the request handler and the match.
# ---------------------------------------------------------------------------
def human_size(size):
    if size < 1024:
        return f'{size} B'
    if size < 1024 * 1024:
        return f'{size / 1024:.1f} KiB'
    return f'{size / (1024 * 1024):.1f} MiB'


def facts(meta):
    """The shown facts of one artifact as text; the callers escape each value."""
    slug = meta['slug']
    updated = meta.get('updatedAt') if store_lib.parse_time(meta.get('updatedAt')) else ''
    return {'slug': slug, 'label': (view_of(meta) or ('Other',))[0],
            'title': str(meta.get('title') or slug), 'file': str(meta.get('fileName') or ''),
            'repo': meta.get('repo') if isinstance(meta.get('repo'), str) else '',
            'created': meta['createdAt'], 'updated': updated, 'version': store_lib.version(meta)}


def time_tag(value):
    e = html.escape
    return f'<time datetime="{e(value)}">{e(value)}</time>'


def index_row(meta):
    f = facts(meta)
    size = meta.get('byteSize') if type(meta.get('byteSize')) is int else 0
    # `?thumb`: the Markdown view of a thumbnail loads no library past marked.
    view, source = '/v/' + f['slug'], '/a/' + f['slug'] + '?thumb'
    find = ' '.join((f['title'], f['file'], f['repo'], f['label'])).lower()
    e = html.escape
    repo_cell = (f'<button type="button" class="repo" title="Filter by this repo">{e(f["repo"])}</button>'
                 if f['repo'] else '<span class="none">none</span>')
    updated = f'<span class="updated">updated {time_tag(f["updated"])}</span>' if f['updated'] else ''
    # data-key changes with each new version, so the live refresh keeps the row (and its thumbnail) only while
    # the artifact is the same.
    return (f'<tr data-key="{e(f["slug"] + " " + f["version"])}" data-filter="{e(find)}">'
            f'<td class="thumb"><a href="{view}" tabindex="-1" aria-hidden="true">'
            f'<iframe src="{source}" loading="lazy" sandbox="allow-scripts" tabindex="-1" title=""></iframe></a></td>'
            f'<td class="name" data-sort="{e(f["title"].lower())}"><a class="title" href="{view}">{e(f["title"])}</a>'
            f'<span class="file">{e(f["file"])}</span>'
            f'<a class="download" href="/d/{e(f["slug"])}" download>Download</a></td>'
            f'<td data-sort="{e(f["label"])}">{e(f["label"])}</td>'
            f'<td data-sort="{e(f["repo"].lower())}">{repo_cell}</td>'
            f'<td data-sort="{e(f["created"])}">{time_tag(f["created"])}{updated}</td>'
            f'<td class="size" data-sort="{size}" data-sort-type="number">{human_size(size)}</td>'
            '</tr>')


INDEX_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Artifacts</title>
<link rel="stylesheet" href="/static/index.css">
<script type="module" src="/static/index.js"></script>
</head>
<body data-state="{state}">
<header class="top">
<h1>Artifacts</h1>
<p class="facts"><span>{count}</span><span>{retention}</span></p>
</header>
<main>
"""
# The page has the table also with no artifact, so the live refresh can add the first row. The tools need the
# script, so they are hidden until it runs. The gallery view is the same table with other style rules; index.js
# fills the sort list from the column heads.
INDEX_TABLE = """<div id="tools" class="tools" hidden>
<input id="filter" class="filter" type="search" placeholder="Filter by title, file, repo or type"
 aria-label="Filter the artifacts" autocomplete="off">
<div id="views" class="views" role="group" aria-label="View"><button type="button" data-view="table"
 aria-pressed="true">Table</button><button type="button" data-view="gallery" aria-pressed="false">Gallery</button></div>
<label class="sorter">Sort <select id="sort"></select></label>
</div>
<p id="empty" class="empty"{empty_hidden}>No artifact is stored yet. Run <code>artifacts upload FILE</code> to add one.</p>
<p id="nomatch" class="empty" hidden>No artifact matches the filter.</p>
<table id="artifacts"{table_hidden}>
<thead><tr>
<th scope="col" class="thumb"><span class="hidden-label">Preview</span></th>
<th scope="col" data-column="name" aria-sort="none"><button type="button">Name<span class="dir" aria-hidden="true"></span></button></th>
<th scope="col" data-column="type" aria-sort="none"><button type="button">Type<span class="dir" aria-hidden="true"></span></button></th>
<th scope="col" data-column="repo" aria-sort="none"><button type="button">Repo<span class="dir" aria-hidden="true"></span></button></th>
<th scope="col" data-column="created" aria-sort="descending"><button type="button">Created<span class="dir" aria-hidden="true"></span></button></th>
<th scope="col" data-column="size" aria-sort="none"><button type="button">Size<span class="dir" aria-hidden="true"></span></button></th>
</tr></thead>
<tbody>
{rows}
</tbody>
</table>
"""


def retention_text():
    try:
        days = store_lib.retention_of(store_lib.load_config())
    except store_lib.ConfigError:
        return 'Retention: unknown (the configuration file is not valid)'
    return 'Retention: none' if days is None else f'Retention: {days} day' + ('' if days == 1 else 's')


def page(body):
    return Answer(200, body.encode('utf-8'), 'text/html; charset=utf-8', {'Content-Security-Policy': PAGE_POLICY})


def listing(server, fresh):
    """(the artifacts of the store, the retention text, the state value). With `fresh` (the index and the viewer)
    the server reads the store again. Else (/api/state) it takes the last read while it is younger than
    STATE_SECONDS. One read runs at a time, so the last read is never older than a page that the server sent."""
    with server.listing_lock:
        began = time.monotonic()
        if fresh or server.listed is None or began - server.listed[0] >= STATE_SECONDS:
            items = store_lib.artifacts(server.store)
            retention = retention_text()
            server.listed = (began, items, retention, store_lib.state(items, retention))
        return server.listed[1:]


def index(handler, match):
    items, retention, state = listing(handler.server, fresh=True)
    count = f'{len(items)} artifact' + ('' if len(items) == 1 else 's')
    body = INDEX_HEAD.format(state=state, count=count, retention=html.escape(retention))
    body += INDEX_TABLE.format(rows='\n'.join(index_row(meta) for meta in items),
                               empty_hidden=' hidden' if items else '', table_hidden='' if items else ' hidden')
    body += '</main>\n</body>\n</html>\n'
    return page(body)


VIEWER_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title} - Artifacts</title>
<link rel="stylesheet" href="/static/index.css">
<script type="module" src="/static/viewer.js"></script>
</head>
<body class="viewer" data-slug="{slug}" data-version="{version}">
<header class="bar">
<a class="home" href="/artifacts">Artifacts</a>
<h1 class="name">{title}</h1>
<p class="facts">{facts}</p>
<nav class="nav">{nav}</nav>
<p id="note" class="note" role="status" hidden><span id="note-text"></span>
<button id="reload" type="button" hidden>Reload</button></p>
</header>
<iframe class="frame" src="/a/{slug}" sandbox="{sandbox}" title="{title}"></iframe>
</body>
</html>
"""


def viewer(handler, match):
    """The viewer page: a slim bar on the server origin and the artifact in a sandboxed frame. This page is not
    sandboxed, so each value of meta.json goes out escaped."""
    slug = match.group('slug')
    items = listing(handler.server, fresh=True)[0] if store_lib.SLUG.fullmatch(slug) else []
    place = next((n for n, meta in enumerate(items) if meta['slug'] == slug), None)
    if place is None or view_of(items[place]) is None:
        return text(404, 'not found')
    f = facts(items[place])
    e = html.escape
    shown = [e(value) for value in (f['file'], f['label'], f['repo']) if value]
    shown.append('created ' + time_tag(f['created']))
    if f['updated']:
        shown.append('updated ' + time_tag(f['updated']))
    # The newest artifact comes first, so the newer neighbor has the lower place.
    nav = []
    if place > 0:
        nav.append(f'<a href="/v/{e(items[place - 1]["slug"])}" rel="prev">Newer</a>')
    if place + 1 < len(items):
        nav.append(f'<a href="/v/{e(items[place + 1]["slug"])}" rel="next">Older</a>')
    nav.append(f'<a href="/d/{e(slug)}" download>Download</a>')
    nav.append(f'<a href="/a/{e(slug)}" target="_blank" rel="noopener">Open alone</a>')
    return page(VIEWER_PAGE.format(title=e(f['title']), slug=e(slug), version=e(f['version']), sandbox=SANDBOX,
                                   facts=''.join(f'<span>{part}</span>' for part in shown), nav=''.join(nav)))


def api_state(handler, match):
    """The live state for the index and the viewer: a hash of the list and the retention, the count, and with a slug
    the version of that artifact (null when it is gone). The answer can be up to STATE_SECONDS old."""
    slug = match.group('slug')
    if slug is not None and not store_lib.SLUG.fullmatch(slug):
        return text(404, 'not found')
    items, _, state = listing(handler.server, fresh=False)
    data = {'state': state, 'count': len(items)}
    if slug is not None:
        data['artifact'] = next(({'version': store_lib.version(meta)} for meta in items if meta['slug'] == slug),
                                None)
    return Answer(200, json.dumps(data).encode('utf-8'), 'application/json')


def browse(handler, match):
    return Answer(302, b'', headers={'Location': '/artifacts'})


# The root page and the Walkr page: links are paths only (no scheme, host or port), because Sheprd shows the pages
# through a tunnel on another port.
SIMPLE_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<link rel="stylesheet" href="/static/index.css">
</head>
<body>
<header class="top">
<h1>{title}</h1>
</header>
<main>
{body}
</main>
</body>
</html>
"""


def root(handler, match):
    """The root page: one link for each module. The Walkr link is there also without Walkr: its page says so."""
    body = ('<ul class="modules">\n<li><a href="/artifacts">Artifacts</a></li>\n'
            '<li><a href="/walkr">Walkr</a></li>\n</ul>')
    return page(SIMPLE_PAGE.format(title='Local server', body=body))


def walkr_page(handler, match):
    """The Walkr page: installed or not, live or not, and how to open the Walkr page. It holds no value of the Walkr
    record (no token, no port of the live server)."""
    nav = '<p><a href="/">Back to the root page</a></p>'
    if not walkr_front.installed():
        body = ('<p>Walkr is not installed: the program <code>walkr-compare</code> is not on the PATH of this '
                'server.</p>\n' + nav)
        return page(SIMPLE_PAGE.format(title='Walkr', body=body))
    live = ('The live Walkr server answers now.' if walkr_front.socket_state() == 'open'
            else 'The live Walkr server does not answer now. A Walkr command starts it.')
    body = ('<p>Walkr is installed.</p>\n'
            f'<p>{live}</p>\n'
            '<p>To open the Walkr page, run <code>artifacts walkr-url</code>.</p>\n' + nav)
    return page(SIMPLE_PAGE.format(title='Walkr', body=body))


def healthz(handler, match):
    # The user ID lets the CLI tell its own server from the server of another user on the same port. The keys
    # status, service, pid and uid are read by the CLI; schema 2 adds the others. No value of the Walkr record goes
    # out: `walkr` holds only the word open or closed.
    data = {'status': 'ok', 'service': store_lib.SERVICE, 'pid': os.getpid(), 'uid': os.getuid(), 'schema': 2,
            'port': handler.server.server_port, 'modules': ['artifacts'],
            'pages': {'root': '/', 'artifacts': '/artifacts'}}
    if walkr_front.installed():
        data['modules'].append('walkr')
        data['pages']['walkr'] = '/walkr'
        data['walkr'] = {'socket': walkr_front.socket_state()}
    return Answer(200, json.dumps(data).encode('utf-8'), 'application/json')


def json_error(status, code, message):
    return Answer(status, json.dumps({'error': {'code': code, 'message': message}}).encode('utf-8'),
                  'application/json')


def walkr_pass(handler):
    """Pass one request of walkr_front.PASSED to the live Walkr server and give its answer back. The pass adds one
    rule: an Origin header must be an HTTP origin with a loopback name. The page token and the checks of the live
    server decide the rest."""
    origins = handler.headers.get_all('Origin') or []
    if len(origins) > 1 or origins and not walkr_front.loopback_origin(origins[0].strip().lower(), loopback_host):
        return json_error(403, 'FORBIDDEN', 'This request comes from a page that is not on a loopback origin.')
    headers = {}
    for name in walkr_front.FORWARD:
        value = handler.headers.get(name)
        if value is not None:
            # A value goes out as it came; a control character or a character outside Latin-1 cannot.
            if re.search(r'[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]', value):
                return json_error(400, 'INVALID_REQUEST', 'A request header holds a character that is not valid.')
            headers[name] = value
    body = b''
    if handler.command == 'POST':
        length = handler.headers.get('Content-Length')
        if handler.headers.get('Transfer-Encoding') or length is None or not re.fullmatch(r'[0-9]{1,10}', length):
            return json_error(411, 'INVALID_REQUEST', 'A request body needs a Content-Length.')
        if int(length) > walkr_front.BODY_BYTES:
            return json_error(413, 'INVALID_REQUEST', 'The request body is too large.')
        body = handler.rfile.read(int(length))
    try:
        status, back, data = walkr_front.forward(handler.command, handler.path, headers, body)
    except walkr_front.Closed:
        return json_error(503, 'WALKR_CLOSED', walkr_front.CLOSED_REASON)
    except TimeoutError:
        return json_error(504, 'WALKR_TIMEOUT', 'The live Walkr server did not answer in time.')
    except (OSError, ValueError):
        return json_error(502, 'WALKR_ANSWER', 'The live Walkr server gave no valid answer.')
    content_type = back.pop('content-type', 'application/octet-stream')
    return Answer(status, data, content_type, {name.title(): value for name, value in back.items()})


def artifact_policy(handler):
    """The policy of an artifact answer. Only a page of this server may frame an artifact. The policy names the
    admitted Host value and not 'self': the web view of Sheprd compares 'self' with the opaque origin of the
    sandboxed answer and then refuses the frame. A source cannot hold an IPv6 literal, so that host keeps 'self'."""
    host = handler.headers.get('Host').strip().lower()
    parent = "'self'" if host.startswith('[') else f'http://{host}'
    return f'sandbox {SANDBOX}; frame-ancestors {parent}'


def view_of(meta):
    """The VIEWS entry of the content type of `meta`, or None. A damaged meta.json can hold a list or an object
    there, which no dict lookup takes, so only a string is looked up."""
    content_type = meta.get('contentType') if meta else None
    return VIEWS.get(content_type) if isinstance(content_type, str) else None


def artifact(handler, match):
    slug = match.group('slug')
    # A slug that is not valid reads no file.
    if not store_lib.SLUG.fullmatch(slug):
        return text(404, 'not found')
    store = handler.server.store
    meta = store_lib.read_meta(store, slug)
    view = view_of(meta)
    source = store_lib.read_member(store, slug, store_lib.SOURCE) if view else None
    if source is None:
        return text(404, 'not found')
    return Answer(200, view[1](meta, source), 'text/html; charset=utf-8',
                  {'Content-Security-Policy': artifact_policy(handler)})


# The policy of a download answer: the empty sandbox (no script, no same origin), so the stored HTML never runs as
# a page of the server origin, also when a browser shows it in place of the download.
DOWNLOAD_POLICY = "sandbox; default-src 'none'; frame-ancestors 'none'"
# The characters of a file name that RFC 5987 lets stand in `filename*` without a percent escape.
ATTR_CHARS = "!#$&+-.^_`|~"


def disposition(meta, extension):
    """The Content-Disposition value of a download. The file name comes from an upload, so it is data: only its last
    path part, no control or format character, a quote or backslash becomes `_`, and a name that is not ASCII goes
    in `filename*` (RFC 6266) with an ASCII copy in `filename`. The spaces at both ends are removed before the check.
    A client may save the name with no dialog, so a name that starts with a dot, ends with a dot, or is longer than
    200 bytes in UTF-8 is not usable.
    With no usable name: the slug and the extension of the content type."""
    name = meta.get('fileName') if isinstance(meta.get('fileName'), str) else ''
    name = re.split(r'[/\\]', name)[-1]
    name = ''.join(ch for ch in name if not unicodedata.category(ch).startswith('C'))
    name = name.replace('"', '_').strip()
    if not name or name.startswith('.') or name.endswith(('.', ' ')) or len(name.encode('utf-8')) > 200:
        name = meta['slug'] + extension
    plain = ''.join(ch if ' ' <= ch <= '~' else '_' for ch in name)
    if plain == name:
        return f'attachment; filename="{name}"'
    return f'attachment; filename="{plain}"; filename*=UTF-8\'\'{quote(name, safe=ATTR_CHARS)}'


def download(handler, match):
    """The stored source of an artifact, unchanged, as a file download. The route renders nothing."""
    slug = match.group('slug')
    # A slug that is not valid reads no file.
    if not store_lib.SLUG.fullmatch(slug):
        return text(404, 'not found')
    store = handler.server.store
    meta = store_lib.read_meta(store, slug)
    view = view_of(meta)
    source = store_lib.read_member(store, slug, store_lib.SOURCE) if view else None
    if source is None:
        return text(404, 'not found')
    return Answer(200, source, meta['contentType'],
                  {'Content-Disposition': disposition(meta, view[2]), 'Content-Security-Policy': DOWNLOAD_POLICY})


def static(handler, match):
    """A file of STATIC with an ETag of its content. `no-cache` makes the browser ask each time, so a new kit
    version shows at once; a matching If-None-Match gets 304 with no body."""
    name = match.group('name')
    if name not in STATIC:
        return text(404, 'not found')
    try:
        body = (WEB / name).read_bytes()
    except OSError:
        return text(404, 'not found')
    tag = '"' + hashlib.sha256(body).hexdigest() + '"'
    headers = {'Cache-Control': 'no-cache', 'ETag': tag}
    # The weak comparison of If-None-Match: a W/ prefix does not count.
    asked = [part.strip().removeprefix('W/') for part in (handler.headers.get('If-None-Match') or '').split(',')]
    if tag in asked or '*' in asked:
        return Answer(304, b'', STATIC[name], headers)
    return Answer(200, body, STATIC[name], headers)


ROUTES = (
    (re.compile(r'/'), root),
    (re.compile(r'/artifacts'), index),
    (re.compile(r'/browse/?'), browse),
    (re.compile(r'/walkr'), walkr_page),
    (re.compile(r'/healthz'), healthz),
    (re.compile(r'/a/(?P<slug>[^/]*)'), artifact),
    (re.compile(r'/v/(?P<slug>[^/]*)'), viewer),
    (re.compile(r'/d/(?P<slug>[^/]*)'), download),
    (re.compile(r'/api/state(?:/(?P<slug>[^/]*))?'), api_state),
    (re.compile(r'/static/(?P<name>[A-Za-z0-9_./-]+)'), static),
)


# ---------------------------------------------------------------------------
# Admission and the request handler
# ---------------------------------------------------------------------------
def loopback_host(value):
    """True when the host name of a Host header value is a loopback name, with no port or a port up to 65535."""
    value = (value or '').strip().lower()
    if value.startswith('['):
        name, bracket, rest = value.partition(']')
        if not bracket:
            return False
        name += ']'
    else:
        name, colon, port = value.partition(':')
        rest = ':' + port if colon else ''
    if rest and not (re.fullmatch(r':[0-9]{1,5}', rest) and int(rest[1:]) <= 65535):
        return False
    return name in LOOPBACK_NAMES


def admitted(handler):
    """A loopback TCP peer and one Host header with a loopback name. This stops DNS rebinding."""
    try:
        peer = ipaddress.ip_address(handler.client_address[0])
    except ValueError:
        return False
    peer = getattr(peer, 'ipv4_mapped', None) or peer
    hosts = handler.headers.get_all('Host') or []
    return peer.is_loopback and len(hosts) == 1 and loopback_host(hosts[0])


class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 30

    def version_string(self):
        return store_lib.SERVICE

    def log_message(self, format, *args):
        # The path of the Compare page and of its frames holds the page secret: the log never holds it.
        log(walkr_front.mask(self.address_string() + ' ' + format % args))

    def send(self, answer, body=True):
        self.send_response(answer.status)
        headers = {**COMMON_HEADERS, 'Content-Type': answer.content_type, **answer.headers}
        # A 304 has no body, and its Content-Length would have to be the length of the full answer: send none.
        if answer.status != 304:
            headers['Content-Length'] = str(len(answer.body))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(answer.body)

    def route(self):
        if not admitted(self):
            return text(403, 'forbidden: only a loopback peer with Host 127.0.0.1, localhost or [::1]')
        # The raw path: a path with a query or a fragment is not in the list.
        if walkr_front.listed(self.command, self.path):
            return walkr_pass(self)
        if self.command not in ('GET', 'HEAD'):
            return Answer(405, b'method not allowed\n', headers={'Allow': 'GET, HEAD'})
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        for pattern, handler in ROUTES:
            match = pattern.fullmatch(path)
            if match:
                return handler(self, match)
        return text(404, 'not found')

    def answer(self):
        try:
            result = self.route()
        except Exception as error:  # one failed request must not stop the server
            log(walkr_front.mask(f'error: {type(error).__name__}: {error}'))
            result = text(500, 'server error')
        self.send(result, body=self.command != 'HEAD')

    def __getattr__(self, name):
        # BaseHTTPRequestHandler looks up do_<METHOD>; each method goes through answer(), which refuses all but
        # GET and HEAD with 405.
        if name.startswith('do_'):
            return self.answer
        raise AttributeError(name)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, store):
        self.store = str(store)
        # The last read of the store (see listing).
        self.listing_lock = threading.Lock()
        self.listed = None
        super().__init__(('127.0.0.1', port), Handler)

    def server_bind(self):
        # HTTPServer.server_bind names the server with socket.getfqdn, a reverse lookup that can wait on the network
        # (macOS) before the server listens. No answer uses the name.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


# ---------------------------------------------------------------------------
# The retention sweep
# ---------------------------------------------------------------------------
def sweep_once(store):
    """One sweep. The setting comes from the configuration file at each sweep, so a change needs no restart."""
    try:
        days = store_lib.retention_of(store_lib.load_config())
    except store_lib.ConfigError as error:
        log(f'sweep: skipped: {error}')
        return
    gone, left = store_lib.sweep(store, days, store_lib.now_utc())
    if gone:
        log(f'sweep: deleted {len(gone)} artifact' + ('' if len(gone) == 1 else 's') + f' older than {days} days')
    for path in left:
        log(f'sweep: cannot remove the scratch directory {path}; remove it by hand')


def sweeper(store, stop):
    while not stop.wait(SWEEP_SECONDS):
        try:
            sweep_once(store)
        except Exception as error:
            log(f'sweep: error: {type(error).__name__}: {error}')


def main(argv=None):
    parser = argparse.ArgumentParser(description='the local tenant-artifacts server')
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args(argv)
    # SIGUSR1 writes the stack of each thread to the log: the CLI sends it when the server gives no /healthz answer.
    faulthandler.register(signal.SIGUSR1)
    store = store_lib.store_dir()
    store_lib.make_store(store)
    server = Server(args.port, store)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    # The first sweep runs before the first answer, so a /healthz answer means that it is done.
    sweep_once(str(store))
    stop = threading.Event()
    threading.Thread(target=sweeper, args=(str(store), stop), daemon=True).start()
    log(f'listening on 127.0.0.1:{args.port}, pid {os.getpid()}, store {store}')
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()
        log('stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
