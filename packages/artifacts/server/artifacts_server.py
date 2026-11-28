"""The local tenant-artifacts server: a web server on 127.0.0.1 for the artifacts of the store.

`artifacts start` runs this file: `python3 -B artifacts_server.py --port N`. The root page links to the index of
the artifacts (/artifacts) and to /walkr, which redirects to the Walkr Compare page on this origin. The server answers
GET and HEAD, the archive and restore writes, and the requests that it passes to Walkr and Memory. It admits only a loopback peer with a loopback name in the Host header, and runs a retention
sweep at its start and then once an hour. With the config key walkrPublicOrigin, a loopback peer with the host of
that origin in the Host header is a public request (a reverse proxy sends it through an SSH forward): it reaches only
/walkr and the pass of the Compare page (`public_route`). Each other local request but /login, /logout, /healthz,
/static/ and /events/v1 needs a session of the admin login or the local CLI token (`login_refusal`, login.py). It
runs until `artifacts off`. Python 3 standard library only.

To add a screen, add one entry to ROUTES. To add a content type, add one entry to VIEWS (and to the upload types of
the CLI).
"""
import argparse
import faulthandler
import hashlib
import hmac
import html
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import sys
import threading
import time
import unicodedata
from urllib.parse import parse_qs, quote, urlsplit

import artifacts_store as store_lib
import walkr_front
import events
import local_sockets
import login as login_lib
import memory_front

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
# The login page has its own policy: its form posts to this origin. Each other page keeps form-action 'none'.
LOGIN_POLICY = PAGE_POLICY.replace("form-action 'none'", "form-action 'self'")
COMMON_HEADERS = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                  'Cache-Control': 'no-store'}
# The static files: URL name -> content type. The server reads no other file of its web directory.
STATIC = {
    'theme.css': 'text/css; charset=utf-8',
    'theme.js': 'text/javascript; charset=utf-8',
    'index.css': 'text/css; charset=utf-8',
    'archive.js': 'text/javascript; charset=utf-8',
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
# The views: content type -> (label of the index, renderer of the view, file extension of a download). A renderer
# gets the facts, the stored bytes and the theme of the request (one of THEMES, or None).
# ---------------------------------------------------------------------------
# The themes of the pages (web/theme.css). An artifact answer is sandboxed and has no storage, so the page that frames
# a Markdown view gives it the theme in the query `theme`.
THEMES = ('torch-light', 'torch-dark')


def html_view(meta, source, theme):
    """An HTML artifact goes out as stored: it keeps its own colors."""
    return source


MARKDOWN_PAGE = """<!doctype html>
<html lang="en"{root}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="/static/theme.css">
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


def markdown_view(meta, source, theme):
    """A small page that holds the Markdown as inert text; the browser renders it with the vendored marked. `theme`
    is one of THEMES or None; with None the page shows Torch Light."""
    page = MARKDOWN_PAGE.format(root=f' data-theme="{theme}"' if theme else '',
                                title=html.escape(str(meta.get('title') or 'Artifact')),
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
    view = view_of(meta)
    # `tile` is the short type word of the static preview tile: the file extension of the type, for example MD.
    return {'slug': slug, 'label': view[0] if view else 'Other', 'tile': view[2][1:].upper() if view else 'FILE',
            'title': str(meta.get('title') or slug), 'file': str(meta.get('fileName') or ''),
            'repo': meta.get('repo') if isinstance(meta.get('repo'), str) else '',
            'created': meta['createdAt'], 'updated': updated, 'version': store_lib.version(meta)}


def time_tag(value):
    e = html.escape
    return f'<time datetime="{e(value)}">{e(value)}</time>'


def byte_size(meta):
    return meta.get('byteSize') if type(meta.get('byteSize')) is int else 0


def index_row(meta):
    f = facts(meta)
    size = byte_size(meta)
    view = '/v/' + f['slug']
    find = ' '.join((f['title'], f['file'], f['repo'], f['label'])).lower()
    e = html.escape
    repo_cell = (f'<button type="button" class="repo" title="Filter by this repo">{e(f["repo"])}</button>'
                 if f['repo'] else '<span class="none">none</span>')
    updated = f'<span class="updated">updated {time_tag(f["updated"])}</span>' if f['updated'] else ''
    # The row holds no frame: a frame is a whole page, and one frame for each row made the index slow. The preview
    # cell shows a static tile with the type. index.js puts a live frame of /a/<slug>?thumb over the tile only on
    # demand, for the slug of data-slug. data-key changes with each new version, so the live refresh keeps the row
    # only while the artifact is the same.
    return (f'<tr data-key="{e(f["slug"] + " " + f["version"])}" data-slug="{e(f["slug"])}" data-filter="{e(find)}">'
            f'<td class="thumb"><a href="{view}" tabindex="-1" aria-hidden="true">'
            f'<span class="tile" data-size="{human_size(size)}">{e(f["tile"])}</span></a></td>'
            f'<td class="name" data-sort="{e(f["title"].lower())}"><a class="title" href="{view}">{e(f["title"])}</a>'
            f'<span class="file">{e(f["file"])}</span>'
            f'<a class="download" href="/d/{e(f["slug"])}" download>Download</a> '
            '<button type="button" class="row-action">Archive</button></td>'
            f'<td data-sort="{e(f["label"])}"><span class="type">{e(f["label"])}</span></td>'
            f'<td data-sort="{e(f["repo"].lower())}">{repo_cell}</td>'
            f'<td data-sort="{e(f["created"])}">{time_tag(f["created"])}{updated}</td>'
            f'<td class="size" data-sort="{size}" data-sort-type="number">{human_size(size)}</td>'
            '</tr>')


# The head of each page of the server origin. theme.js is a plain script before the styles: it sets the theme before
# the first paint (web/theme.js). `scripts` holds the module script of the page, or nothing.
PAGE_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script src="/static/theme.js"></script>
<link rel="stylesheet" href="/static/theme.css">
<link rel="stylesheet" href="/static/index.css">
{scripts}</head>
"""
# The Theme list of the band. It needs theme.js, which shows it.
THEME_LIST = ('<label class="theme-control" hidden>Theme <select data-theme-picker>'
              '<option value="torch-light">Torch Light</option><option value="torch-dark">Torch Dark</option>'
              '</select></label>')
# The logout link of the band. A GET: PAGE_POLICY keeps form-action 'none', and a cross-site GET carries no Strict
# cookie, so it ends no session.
LOGOUT = '<a class="logout" href="/logout">Log out</a>'


def section_links(current=None):
    """The links to the three sections of the web app, for the band of a page: Artifacts, Walkr and Memory. The
    Walkr page (packages/walkr/src/compare-server.js) and the memory viewer (packages/memory/ui/index.html) draw the
    same small markup themselves. The links are paths only. `current` marks the section of the page."""
    links = (('artifacts', '/artifacts', 'Artifacts'), ('walkr', '/walkr', 'Walkr'),
             ('memory', memory_front.PREFIX + '/', 'Memory'))
    return ('<nav class="app-nav" aria-label="Sections">'
            + ''.join(f'<a href="{path}"' + (' aria-current="page"' if name == current else '') + f'>{label}</a>'
                      for name, path, label in links) + '</nav>')


LIST_BAND = """\
<body data-state="{state}">
<header class="band">
<a class="mark" href="/">Local server</a>
""" + section_links('artifacts') + """
<h1 class="page-name">{title}</h1>
<p class="facts">{facts}</p>
<span class="band-end">""" + THEME_LIST + LOGOUT + """</span>
<p id="note" class="note" role="status" hidden></p>
</header>
<main>
"""
# The page has the table also with no artifact, so the live refresh can add the first row. The tools need the
# script, so they are hidden until it runs. The gallery view is the same table with other style rules; index.js
# fills the sort list from the column heads.
INDEX_TABLE = """<div id="tools" class="tools" hidden>
<input id="filter" class="filter" type="search" placeholder="Filter by title, file, repo or type"
 aria-label="Filter the artifacts" autocomplete="off">
<label>Repo <select id="repo"></select></label>
<div id="views" class="views" role="group" aria-label="View"><button type="button" data-view="table"
 aria-pressed="true">Table</button><button type="button" data-view="gallery" aria-pressed="false">Gallery</button></div>
<label class="sorter">Sort <select id="sort"></select></label>
</div>
<p id="empty" class="empty"{empty_hidden}>No artifact is on the main list.</p>
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


def page(body, status=200):
    return Answer(status, body.encode('utf-8'), 'text/html; charset=utf-8', {'Content-Security-Policy': PAGE_POLICY})


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


def list_head(title, script, state, band_facts):
    return (PAGE_HEAD.format(title=title, scripts=f'<script type="module" src="/static/{script}"></script>\n')
            + LIST_BAND.format(title=title, state=state, facts=band_facts))


def index(handler, match):
    stored, retention, state = listing(handler.server, fresh=True)
    items = [meta for meta in stored if not store_lib.archived(meta)]
    archived = len(stored) - len(items)
    count = f'{len(items)} artifact' + ('' if len(items) == 1 else 's')
    band_facts = (f'<span id="shown">{count}</span><a id="archived" data-count="{archived}" href="/artifacts/archive"'
                  + ('' if archived else ' hidden') + f'>{archived} archived</a><span>{html.escape(retention)}</span>')
    body = list_head('Artifacts', 'index.js', state, band_facts)
    body += INDEX_TABLE.format(rows='\n'.join(index_row(meta) for meta in items),
                               empty_hidden=' hidden' if items else '', table_hidden='' if items else ' hidden')
    body += '</main>\n</body>\n</html>\n'
    return page(body)


def archive_row(meta):
    f = facts(meta)
    e = html.escape
    return (f'<tr data-slug="{f["slug"]}"><td><a href="/v/{f["slug"]}">{e(f["title"])}</a></td>'
            f'<td>{e(f["file"])}</td><td>{e(f["repo"]) or "none"}</td><td>{time_tag(f["created"])}</td>'
            f'<td>{human_size(byte_size(meta))}</td><td><button type="button" class="row-action">Restore</button></td></tr>')


def archive_page(handler, match):
    stored, _, state = listing(handler.server, fresh=True)
    items = [meta for meta in stored if store_lib.archived(meta)]
    body = list_head('Archive', 'archive.js', state, f'<span id="archive-count">{len(items)} archived</span>')
    body += '<p><a href="/artifacts">Back to artifacts</a></p>'
    body += '<p id="empty"' + (' hidden' if items else '') + '>No artifact is archived.</p>'
    if items:
        columns = ('Title', 'File', 'Repo', 'Created', 'Size', 'Action')
        body += ('<table id="archive"><thead><tr>' + ''.join(f'<th scope="col">{col}</th>' for col in columns)
                 + '</tr></thead><tbody>' + '\n'.join(archive_row(meta) for meta in items) + '</tbody></table>')
    return page(body + '</main></body></html>')


VIEWER_BODY = """\
<body class="viewer" data-slug="{slug}" data-version="{version}">
<header class="band">
<a class="mark" href="/">Local server</a>
""" + section_links('artifacts') + """
<span class="page-name">{label}</span>
<h1 class="name">{title}</h1>
<p class="facts">{facts}</p>
<nav class="nav">{nav}</nav>
<span class="band-end">""" + THEME_LIST + LOGOUT + """</span>
<p id="note" class="note" role="status" hidden><span id="note-text"></span>
<button id="reload" type="button" hidden>Reload</button></p>
</header>
{frame}
</body>
</html>
"""
# The frame of the viewer. An HTML artifact keeps its own colors, so its frame loads at once.
FRAME = '<iframe class="frame" src="/a/{slug}" sandbox="{sandbox}" title="{title}"></iframe>'
# A Markdown view takes the theme of the page from the query `theme`. viewer.js knows the theme and sets the address
# of the frame from data-src, so the view never shows the other theme first. With no script, the frame of the
# noscript element shows the view in Torch Light.
THEMED_FRAME = ('<iframe class="frame" hidden data-src="/a/{slug}" sandbox="{sandbox}" title="{title}"></iframe>\n'
                '<noscript>' + FRAME + '</noscript>')


def viewer(handler, match):
    """The viewer page: a slim bar on the server origin and the artifact in a sandboxed frame. This page is not
    sandboxed, so each value of meta.json goes out escaped."""
    slug = match.group('slug')
    items = listing(handler.server, fresh=True)[0] if store_lib.SLUG.fullmatch(slug) else []
    meta = next((item for item in items if item['slug'] == slug), None)
    view = view_of(meta)
    if view is None:
        return not_found()
    f = facts(meta)
    e = html.escape
    shown = [e(value) for value in (f['file'], f['repo']) if value]
    shown.append('created ' + time_tag(f['created']))
    if f['updated']:
        shown.append('updated ' + time_tag(f['updated']))
    # The newest artifact comes first, so the newer neighbor has the lower place.
    nav = []
    if store_lib.archived(meta):
        shown.append('Archived')
    else:
        live = [item['slug'] for item in items if not store_lib.archived(item)]
        place = live.index(slug)
        if place > 0:
            nav.append(f'<a href="/v/{e(live[place - 1])}" rel="prev">Newer</a>')
        if place + 1 < len(live):
            nav.append(f'<a href="/v/{e(live[place + 1])}" rel="next">Older</a>')
    nav.append(f'<a href="/d/{e(slug)}" download>Download</a>')
    nav.append(f'<a class="alone" href="/a/{e(slug)}" target="_blank" rel="noopener">Open alone</a>')
    frame = THEMED_FRAME if view[1] is markdown_view else FRAME
    head = PAGE_HEAD.format(title=e(f['title']) + ' - Artifacts',
                            scripts='<script type="module" src="/static/viewer.js"></script>\n')
    return page(head + VIEWER_BODY.format(
        title=e(f['title']), slug=e(slug), version=e(f['version']), label=e(f['label']),
        facts=''.join(f'<span>{part}</span>' for part in shown), nav=''.join(nav),
        frame=frame.format(slug=e(slug), sandbox=SANDBOX, title=e(f['title']))))


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
SIMPLE_BODY = """\
<body>
<header class="band">
{name}
{sections}
<span class="band-end">""" + THEME_LIST + LOGOUT + """</span>
</header>
<main class="plain">
{body}
</main>
</body>
</html>
"""
SERVER_NAME = 'Local server'


def simple_page(title, body, status=200, section=None):
    """A page with the band and `body` (HTML). The band shows the name of the server, the links to the three
    sections (`section` marks the one of this page) and the title of the page."""
    e = html.escape
    name = (f'<h1 class="mark">{SERVER_NAME}</h1>' if title == SERVER_NAME
            else f'<a class="mark" href="/">{SERVER_NAME}</a>\n<h1 class="page-name">{e(title)}</h1>')
    return page(PAGE_HEAD.format(title=e(title), scripts='')
                + SIMPLE_BODY.format(name=name, sections=section_links(section), body=body), status)


def not_found():
    """The answer for an address that names no page: a page for a person, with the way back."""
    return simple_page('Not found', '<p>This address names no page of this server.</p>\n'
                                    '<p><a href="/artifacts">Open the index of the artifacts</a></p>', 404)


def root(handler, match):
    """The root page: one link for each module. The Walkr link is there also without Walkr: its page says so."""
    body = ('<ul class="modules">\n'
            '<li><a href="/artifacts">Artifacts</a> <span>The stored HTML and Markdown pages.</span></li>\n'
            '<li><a href="/walkr">Walkr</a> <span>The review page: compare options, pick one and comment.</span></li>\n'
            '<li><a href="/memory/">Memory</a> <span>The memory viewer: the memories of your agent memory systems.</span></li>\n'
            '</ul>')
    return simple_page(SERVER_NAME, body)


# At most CHECKS requests of the Walkr page and the Memory pass run the user check at one time. The check does not wait for a slot: a request
# with no free slot gets 503 at once, so no waiting threads pile up. The check reads at most one TCP table pass.
CHECKS = 4
CHECK_SLOTS = threading.BoundedSemaphore(CHECKS)
# One request of /walkr at a time past the user check: the record check and the run of walkr-compare. Only a request
# that passed the user check takes this lock, and many requests start no crowd of Node processes. On Linux the user
# check refuses a request of another user, so such a request never holds this lock. On macOS each request passes the
# user check, so a request of another local user can hold it.
OPEN_LOCK = threading.Lock()
# The values of Sec-Fetch-Site that pass; an absent header passes too.
SITES = ('none', 'same-origin', 'same-site')
# The fixed text page of each refusal of stale_record. It names the command for a shell, and it says that the command
# has no such check.
STALE_TEXT = ('<p>This server cannot prove that only the recorded Walkr server listens on the port of the Walkr '
              'record. <code>walkr-compare open</code> can send the agent token of the record to the program on that '
              'port, so this server did not run it.</p>\n<p>In a shell, <code>artifacts walkr-url</code> runs '
              '<code>walkr-compare open</code> with no such check and prints the address of the Walkr page. When no '
              'Walkr server of yours runs, remove the old record <code>~/.human-review/server.json</code> first.</p>')


def walkr_text(status, text, again=False, shell=True):
    """A text page of /walkr: `text` (HTML), with `again` a link to /walkr, and with `shell` the command that prints
    the address in a shell."""
    link = '<p><a href="/walkr">Open the Walkr page</a></p>\n' if again else ''
    hint = ('<p>In a shell, <code>artifacts walkr-url</code> prints the address of the Walkr page or the reason of a '
            'failure.</p>\n' if shell else '')
    body = f'{text}\n{link}{hint}<p><a href="/">Back to the root page</a></p>'
    return simple_page('Walkr', body, status, section='walkr')


def walkr_page(handler, match):
    """/walkr: with Walkr installed, `303 See Other` to the Compare page on this origin. The Location is a path only,
    so the port of this server stays, also through a tunnel. walkr_front.open_page gives the path; it starts the live
    Walkr server when none runs. The server has a thread for each request, so a slow start holds only this request.

    The path holds the page secret, a capability. The checks run cheap first, and a refused request runs nothing:
    1. foreign_page, on the headers only: 403. For a public request, Origin and Referer must name the public
       origin. Its page links to /walkr: a click there is a request of this server's
       page, and the page cannot be framed (PAGE_POLICY), so a foreign page cannot make that click.
    2. CHECK_SLOTS: 503 at once when CHECKS requests run the user check now.
    3. peer_refusal: on Linux, the TCP tables must name the user of this server for the client socket: 403. The slot
       goes back before the next step.
    4. OPEN_LOCK: one request at a time past this point; 503 when an earlier one holds it for OPEN_SECONDS. Only a
       request that passed step 3 waits here. On Linux, only requests of the user of this server wait for each other.
    5. stale_record: the evidence must show that only the recorded Walkr server listens on the port of the Walkr
       record: else 503 with STALE_TEXT.
    Walkr not installed: 200. No address came: 503 with a fixed reason and the exit code of the child, never its
    output. The answer holds no field of the Walkr record (no port, no PID, no agent token), and the log holds no page
    secret.

    The longest wait of a request of the owner: one table read of step 3 (TABLE_SECONDS), OPEN_SECONDS in step 4
    behind earlier requests of the owner, then its own record check and run (TABLE_SECONDS, the descriptor walk and
    OPEN_SECONDS). That is no hard bound: table_rows checks its time after each read. On Linux, a request of another
    user adds no wait: step 3 refuses it before OPEN_LOCK. On macOS, step 3 passes each request, so a request of
    another local user can hold OPEN_LOCK and make the owner's request wait. While CHECKS requests of any user run
    step 3, the owner's request gets 503 at once."""
    e = html.escape
    if not walkr_front.installed():
        return walkr_text(200, '<p>Walkr is not installed: the program <code>walkr-compare</code> is not on the '
                               'PATH of this server.</p>')
    foreign = foreign_page(handler)
    if foreign:
        return walkr_text(403, f'<p>{e(foreign)} So this server did not open the Walkr page.</p>', again=True)
    status, refused = check_peer(handler)
    if status == 503:
        return walkr_text(503, f'<p>{e(refused)}</p>', again=True)
    if refused:
        return walkr_text(403, f'<p>{e(refused)} This server gives the Walkr page only to its own user.</p>')
    if not OPEN_LOCK.acquire(timeout=walkr_front.OPEN_SECONDS):
        return walkr_text(503, '<p>An earlier start of the live Walkr server takes too long.</p>', again=True)
    try:
        if stale_record():
            log('walkr: refused: no proof that only the recorded Walkr server listens on the port of its record')
            return walkr_text(503, STALE_TEXT, again=True, shell=False)
        path = walkr_front.open_page(cwd=str(store_lib.state_dir()))
    except walkr_front.OpenFailed as error:
        # A fixed text of walkr_front and the exit code: no byte of the child goes to the page or to the log.
        log(f'walkr: no page address: {error.reason()}')
        return walkr_text(503, f'<p>Walkr is installed, but this server got no address of the Walkr page: '
                               f'{e(error.reason())}.</p>', again=True)
    finally:
        OPEN_LOCK.release()
    return Answer(303, b'', headers={'Location': path})


def foreign_page(handler):
    """The reason when the headers of this request show a page of another origin, else None.

    - `Sec-Fetch-Site`: absent, or one field with one of SITES (case and spaces do not count). `cross-site`, an empty
      or combined value, an unknown value or two fields: refused. A browser sends `cross-site` for a request that a
      page of another site starts. In the Servo source at the Sheprd pin (read, not seen on the wire), the web view
      of Sheprd sends `same-origin` for a click on a link of this server, and `cross-site` for an address that
      Sheprd opens or the user types (its request has an opaque origin).
    - An Origin or a Referer header must name an HTTP origin with a loopback name. A browser sends neither for a
      link on a page with `Referrer-Policy: no-referrer`, as the pages of this server. For a public request
      (public_of), an Origin must be the public origin and a Referer a page on it."""
    sites = [value.strip().lower() for value in handler.headers.get_all('Sec-Fetch-Site') or []]
    if sites == ['cross-site']:
        return ('The browser marks this request as one from another site. Servo, the web view of Sheprd, marks an '
                'address that you type or that Sheprd opens the same way.')
    if sites and (len(sites) > 1 or sites[0] not in SITES):
        return 'The Sec-Fetch-Site header of this request is not one valid value.'
    origins = handler.headers.get_all('Origin') or []
    referers = handler.headers.get_all('Referer') or []
    public = public_of(handler)
    if public:
        if (len(origins) > 1 or origins and origins[0].strip().lower() != public
                or len(referers) > 1 or referers and not public_page(referers[0], public)):
            return 'This request comes from a page that is not on the public origin of this server.'
        return None
    if (len(origins) > 1 or origins and not walkr_front.loopback_origin(origins[0].strip().lower(), loopback_host)
            or len(referers) > 1 or referers and not loopback_page(referers[0])):
        return 'This request comes from a page that is not on a loopback origin.'
    return None


def public_of(handler):
    """The public origin when this request is a public request (Handler.route sets it), else None."""
    value = getattr(handler, 'public', None)
    return value if isinstance(value, str) else None


def public_page(value, public):
    """True when `value` is an address on the origin `public`, for example a Referer value."""
    try:
        address = urlsplit(value.strip().lower())
    except ValueError:
        return False
    return f'{address.scheme}://{address.netloc}' == public and not address.username


def check_peer(handler):
    """Share the bounded user check between the Walkr page, the Memory pass and archive writes."""
    if not CHECK_SLOTS.acquire(blocking=False):
        return 503, 'Too many requests are checking the local user now.'
    try:
        reason = peer_refusal(handler)
        return (403, reason) if reason else (200, None)
    finally:
        CHECK_SLOTS.release()


def peer_refusal(handler):
    """The reason when the client socket of this request is not provably of the user of this server, else None.

    On Linux the TCP tables name the user of each socket. The kernel adds the client socket of a connection to its
    tables before this server accepts it, so a retry would not help. No line can mean a closed client, a client in
    another network namespace, or a read that stopped at a limit of table_rows before the line; a line found before
    the stop counts. Another user, no line or a table that cannot be read: refused. macOS and the other platforms
    have no such table in the standard library: None, so a program of another local user gets the page there."""
    if not local_sockets.LINUX:
        return None
    try:
        uid = local_sockets.peer_uid(handler.connection.getpeername(), handler.connection.getsockname())
    except OSError:  # the client is gone
        uid = None
    if uid == os.getuid():
        return None
    if uid is None:
        return 'This server found no user for the program of this request in the TCP tables of Linux.'
    return 'This request comes from a program of another user of this computer.'


def loopback_page(value):
    """True when `value` is an HTTP address with a loopback name and any port, for example a Referer value."""
    try:
        address = urlsplit(value.strip().lower())
    except ValueError:
        return False
    return address.scheme == 'http' and loopback_host(address.netloc)


# The rule of this guard: walkr-compare open runs only when the evidence is complete and unambiguous. Any doubt is a
# refusal with the fixed text STALE_TEXT, which names `artifacts walkr-url`. A refusal costs the owner one command in
# a shell; a wrong pass can send the agent token of the record to another process. So a partial table read, a
# listener of another process on the port, and a /health answer that does not fit the record are each a refusal.
def stale_record():
    """True unless the evidence shows that `walkr-compare open` sends the agent token of the Walkr record only to the
    recorded Walkr server. That command takes a record of its protocol as live when any program answers 200 on
    /health at the recorded port, and then sends the record token to that port (packages/walkr/src/local-server.js
    ensureServer, compare-cli.js request). A record outlives its server: the idle exit of Walkr leaves it in place,
    and another program can get its port later.

    - No record, or no program listens on its port: False. walkr-compare starts a new server, which writes its own
      record. A record that read_record does not take (not valid JSON, larger than RECORD_BYTES, a port or a PID that
      is not a positive int) counts as no record here, although Walkr can take some of them (a port as a string).
    - Linux: each listening socket on that port (listener_inodes: both families, each address) must be a socket of
      the recorded process (the inode of its line in the TCP tables, in /proc/<pid>/fd). A listener of any other
      process is a doubt, also one that cannot get the connection to 127.0.0.1 (an IPv6-only socket, another address,
      a socket bound to another interface): the tables show neither IPV6_V6ONLY nor the bound interface, so this
      check cannot tell them apart. Tables with no complete answer: True. The look at /proc/<pid>/fd is a snapshot,
      not a proof of the process that serves a request.
    - Other platforms (macOS): the standard library gives no such proof. /health must name the PID of the record and
      the protocol that the record leads to. A record of the protocol of walkr_front (walkr_front.current): /health
      must name that protocol; walkr-compare takes this record as live and sends its token. A record of another
      protocol: /health must name the same protocol as the record; walkr-compare sends that record's token to no
      program, it stops that server when its /health names the PID of the record and starts a new one
      (local-server.js stopOlderServer). /health is a claim of the listener, not a proof.
    The check and the run of walkr-compare are two steps: a program that takes the port between them is not seen."""
    record = walkr_front.read_record(protocol=True)
    if record is None:
        return False
    port, pid, protocol = record
    if local_sockets.LINUX:
        return local_sockets.listener_owner(port, pid) == 'unknown'
    try:
        socket.create_connection(('127.0.0.1', port), timeout=walkr_front.PROBE_SECONDS).close()
    except ConnectionRefusedError:
        return False
    except OSError:
        pass
    return not walkr_front.probe(port, pid, walkr_front.PROTOCOL if walkr_front.current(protocol) else protocol)


def healthz(handler, match):
    # The user ID lets the CLI tell its own server from the server of another user on the same port. The keys
    # status, service, pid and uid are read by the CLI; schema 2 adds the others. No value of the Walkr record goes
    # out: `walkr` holds only the word open or closed.
    data = {'status': 'ok', 'service': store_lib.SERVICE, 'pid': os.getpid(), 'uid': os.getuid(), 'schema': 2,
            'port': handler.server.server_port, 'modules': ['artifacts'],
            'pages': {'root': '/', 'artifacts': '/artifacts'},
            'events': {'path': events.PATH, 'version': events.VERSION}, 'login': {'path': '/login'}}
    if walkr_front.installed():
        data['modules'].append('walkr')
        data['pages']['walkr'] = '/walkr'
        data['walkr'] = {'socket': walkr_front.socket_state()}
    if memory_front.installed():
        data['modules'].append('memory')
        data['pages']['memory'] = memory_front.PREFIX + '/'
        data['memory'] = {'state': 'running' if handler.server.memory.running() else 'stopped'}
    return Answer(200, json.dumps(data).encode('utf-8'), 'application/json')


def json_error(status, code, message):
    return Answer(status, json.dumps({'error': {'code': code, 'message': message}}).encode('utf-8'),
                  'application/json')


WRITE_PATH = re.compile(r'/api/(?P<action>archive|restore)/(?P<slug>.*)')


def invalid_constant(value):
    raise ValueError('A JSON number must be finite.')


def archive_write(handler, match):
    if handler.command != 'POST':
        return Answer(405, b'method not allowed\n', headers={'Allow': 'POST'})
    headers = handler.headers
    origin = 'http://' + headers['Host'].strip().lower()
    if [v.strip().lower() for v in headers.get_all('Origin', [])] != [origin]:
        return json_error(403, 'FORBIDDEN', 'The origin must match this server.')
    if headers.get_all('Sec-Fetch-Site', []) not in ([], ['same-origin']):
        return json_error(403, 'FORBIDDEN', 'The request must come from the same origin.')
    if len(headers.get_all('Content-Type', [])) != 1 or headers.get_content_type() != 'application/json':
        return json_error(415, 'INVALID_REQUEST', 'The content type must be application/json.')
    lengths = headers.get_all('Content-Length', [])
    if ('Transfer-Encoding' in headers or len(lengths) != 1 or not re.fullmatch(r'[0-9]+', lengths[0])):
        return json_error(411, 'INVALID_REQUEST', 'The body needs one whole Content-Length.')
    length = lengths[0].lstrip('0') or '0'
    if len(length) > 4 or int(length) > 1024:
        return json_error(413, 'INVALID_REQUEST', 'The body is larger than 1024 bytes.')
    status, reason = check_peer(handler)
    if reason:
        return json_error(status, 'FORBIDDEN' if status == 403 else 'BUSY', reason)
    raw = handler.rfile.read(int(length))
    try:
        obj = json.loads(raw, parse_constant=invalid_constant)
    except (ValueError, RecursionError):
        obj = None
    if not isinstance(obj, dict) or len(raw) != int(length):
        return json_error(400, 'INVALID_REQUEST', 'The body must be a complete JSON object.')
    slug, action = match.group('slug', 'action')
    archive = action == 'archive'
    change = store_lib.archive_artifact if archive else store_lib.restore_artifact
    # One server write at a time. An independent CLI command can race a write to the same slug.
    with handler.server.listing_lock:
        try:
            change(handler.server.store, slug)
        except store_lib.NotAnArtifact:
            return json_error(404, 'NOT_FOUND', 'The artifact does not exist.')
        except OSError:
            return json_error(500, 'STORE_ERROR', 'The server could not write the artifact facts.')
        handler.server.listed = None
        log(f'{action}: {slug}')
    return Answer(200, json.dumps({'slug': slug, 'archived': archive}).encode(), 'application/json')


def walkr_pass(handler):
    """Pass one request of walkr_front.PASSED to the live Walkr server and give its answer back. The pass adds one
    rule: an Origin header must be an HTTP origin with a loopback name. For a public request, an Origin must be the
    public origin, and a POST (a page write: seen, submit, rate) needs exactly one Origin header with that value. The
    page token and the checks of the live server decide the rest."""
    origins = handler.headers.get_all('Origin') or []
    public = public_of(handler)
    if public:
        if [value.strip().lower() for value in origins] != [public] and (origins or handler.command == 'POST'):
            return json_error(403, 'FORBIDDEN', 'A page write of the public origin needs its Origin header.')
    elif len(origins) > 1 or origins and not walkr_front.loopback_origin(origins[0].strip().lower(), loopback_host):
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


def memory_text(status, sentence):
    """The text page of the Memory section while the viewer cannot answer: one sentence that says why."""
    body = f'<p>{html.escape(sentence)}</p>\n<p><a href="/">Back to the root page</a></p>'
    return simple_page('Memory', body, status, section='memory')


def memory_pass(handler, raw):
    """Pass one request of memory_front.PASSED to the memory viewer and give its answer back. The viewer is a child
    process of this server on a loopback port; the pass adds the secret of this start. An Origin header must be an
    HTTP origin with a loopback name, as for the Walkr pass. While the viewer cannot run, the page gets one
    sentence that says what is missing, and each other path a JSON reason."""
    origins = handler.headers.get_all('Origin') or []
    if len(origins) > 1 or origins and not walkr_front.loopback_origin(origins[0].strip().lower(), loopback_host):
        return json_error(403, 'FORBIDDEN', 'This request comes from a page that is not on a loopback origin.')
    status, reason = check_peer(handler)
    if reason:
        if raw == memory_front.PREFIX + '/':
            return memory_text(status, reason)
        return json_error(status, 'FORBIDDEN' if status == 403 else 'BUSY', reason)
    headers = {}
    for name in memory_front.FORWARD:
        value = handler.headers.get(name)
        if value is not None:
            if re.search(r'[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]', value):
                return json_error(400, 'INVALID_REQUEST', 'A request header holds a character that is not valid.')
            headers[name] = value
    body = b''
    if handler.command == 'POST':
        length = handler.headers.get('Content-Length')
        if handler.headers.get('Transfer-Encoding') or length is None or not re.fullmatch(r'[0-9]{1,10}', length):
            return json_error(411, 'INVALID_REQUEST', 'A request body needs a Content-Length.')
        if int(length) > memory_front.BODY_BYTES:
            return json_error(413, 'INVALID_REQUEST', 'The request body is too large.')
        body = handler.rfile.read(int(length))
    child = handler.server.memory
    target = child.target()
    is_page = raw == memory_front.PREFIX + '/'
    if target is None:
        sentence = child.why()
        # Not installed is a state of this computer, not an error of the request.
        return memory_text(200 if memory_front.missing() else 503, sentence) if is_page \
            else json_error(503, 'MEMORY_CLOSED', sentence)
    try:
        status, back, data = memory_front.forward(handler.command, raw, headers, body, *target)
    except memory_front.Closed:
        reason = 'The memory viewer does not answer. Load the page again in a moment.'
        return memory_text(503, reason) if is_page else json_error(503, 'MEMORY_CLOSED', reason)
    except TimeoutError:
        return json_error(504, 'MEMORY_TIMEOUT', 'The memory viewer did not answer in time.')
    except (OSError, ValueError):
        return json_error(502, 'MEMORY_ANSWER', 'The memory viewer gave no valid answer.')
    content_type = back.pop('content-type', 'application/octet-stream')
    if content_type.partition(';')[0].strip().lower() == 'text/html' and not back.get('content-security-policy'):
        back['content-security-policy'] = PAGE_POLICY
    return Answer(status, data, content_type, {name.title(): value for name, value in back.items()})


def memory_root(handler, match):
    """/memory: the page lives at /memory/, so that its relative addresses stay below the prefix. A path only: the
    port of this server stays, also through a tunnel."""
    return Answer(308, b'', headers={'Location': memory_front.PREFIX + '/'})


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
    # The query `theme` counts only with one value of THEMES: no other text of the query goes into the page.
    themes = parse_qs(urlsplit(handler.path).query).get('theme', [])
    theme = themes[0] if len(themes) == 1 and themes[0] in THEMES else None
    return Answer(200, view[1](meta, source, theme), 'text/html; charset=utf-8',
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


# ---------------------------------------------------------------------------
# The admin login (login.py): the page /login, the logout and the check of each protected request
# ---------------------------------------------------------------------------
LOGIN_BODY = """\
<body>
<header class="band">
<span class="mark">""" + SERVER_NAME + """</span>
<h1 class="page-name">Log in</h1>
<span class="band-end">""" + THEME_LIST + """</span>
</header>
<main class="plain">
{note}<form class="login" method="post" action="/login">
<input type="hidden" name="next" value="{next}">
<p><label>User name <input name="user" value="admin" autocomplete="username" required></label></p>
<p><label>Key <input name="key" type="password" autocomplete="current-password" required></label></p>
<p><button type="submit">Log in</button></p>
</form>
<p>The key is in the password system that <code>artifacts login status</code> names. <code>artifacts login rotate</code>
makes a new key and ends each session.</p>
</main>
</body>
</html>
"""
# The largest body of POST /login.
LOGIN_BYTES = 4096


def cookie_name(handler):
    """The name of the session cookie: it holds the port, because a browser sends a cookie of 127.0.0.1 to each port."""
    return f'tenant_artifacts_{handler.server.server_port}'


def session_id(handler):
    """The value of the session cookie of this server in the Cookie headers, or None."""
    name = cookie_name(handler)
    for header in handler.headers.get_all('Cookie') or []:
        for part in header.split(';'):
            key, eq, value = part.strip().partition('=')
            if eq and key == name and re.fullmatch(r'[A-Za-z0-9_-]{20,100}', value):
                return value
    return None


def set_cookie(handler, sid, seconds=login_lib.SESSION_SECONDS):
    # No Secure flag: the server speaks plain HTTP on loopback.
    return f'{cookie_name(handler)}={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}'


def safe_next(value):
    """A relative path of this server that starts with one `/`, else /artifacts."""
    if (not isinstance(value, str) or not re.fullmatch(r'/(?![/\\])[^\\\x00-\x20\x7f]*', value)
            or urlsplit(value).scheme or urlsplit(value).netloc):
        return '/artifacts'
    return value


def login_page(handler, status=200, note='', target='/artifacts', headers=None):
    e = html.escape
    note = f'<p class="note-text" role="alert">{e(note)}</p>\n' if note else ''
    body = PAGE_HEAD.format(title='Log in - ' + SERVER_NAME, scripts='') + LOGIN_BODY.format(note=note, next=e(target))
    # Referrer-Policy same-origin: with no-referrer, a browser sends `Origin: null` with the POST of the form.
    return Answer(status, body.encode('utf-8'), 'text/html; charset=utf-8',
                  {'Content-Security-Policy': LOGIN_POLICY, 'Referrer-Policy': 'same-origin', **(headers or {})})


def same_origin_refusal(handler, origin_needed):
    """The reason when the headers name another site, else None: the checks of the archive writes. With
    `origin_needed`, exactly one Origin header is required; else an absent Origin passes, and so does
    `Sec-Fetch-Site: none` (an address that the user typed)."""
    origin = 'http://' + handler.headers['Host'].strip().lower()
    origins = [v.strip().lower() for v in handler.headers.get_all('Origin', [])]
    if origins != [origin] and (origin_needed or origins):
        return 'The origin must match this server.'
    sites = [v.strip().lower() for v in handler.headers.get_all('Sec-Fetch-Site', [])]
    if sites not in ([], ['same-origin']) + (() if origin_needed else (['none'],)):
        return 'The request must come from the same origin.'
    return None


def login_route(handler):
    """GET /login: the form, or a redirect for a live session. POST /login: the check of the user name and the key."""
    logins = handler.server.logins
    if handler.command in ('GET', 'HEAD'):
        targets = parse_qs(urlsplit(handler.path).query).get('next', [])
        target = safe_next(targets[0] if len(targets) == 1 else None)
        if logins.session(session_id(handler))[0]:
            return Answer(303, b'', headers={'Location': target})
        if logins.current() is None:
            return login_page(handler, 503, 'This server has no login key. Run artifacts start or artifacts login '
                                            'rotate in a shell.', target)
        return login_page(handler, target=target)
    if handler.command != 'POST':
        return Answer(405, b'method not allowed\n', headers={'Allow': 'GET, HEAD, POST'})
    refused = same_origin_refusal(handler, origin_needed=True)
    if refused:
        return text(403, 'forbidden: ' + refused)
    lengths = handler.headers.get_all('Content-Length', [])
    if ('Transfer-Encoding' in handler.headers or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,5}', lengths[0])
            or int(lengths[0]) > LOGIN_BYTES):
        return text(413 if lengths and lengths[0].isdigit() else 411, 'the login form needs a small, whole body')
    if handler.headers.get_content_type() != 'application/x-www-form-urlencoded':
        return text(415, 'the login form is application/x-www-form-urlencoded')
    raw = handler.rfile.read(int(lengths[0]))
    wait = logins.retry_after()
    if wait:
        return login_page(handler, 429, f'Too many failed logins. Wait {wait} seconds, then try again.',
                          headers={'Retry-After': str(wait)})
    try:
        fields = parse_qs(raw.decode('utf-8'), keep_blank_values=True, max_num_fields=8)
    except (UnicodeDecodeError, ValueError):
        fields = {}
    one = {name: values[0] for name, values in fields.items() if len(values) == 1}
    target = safe_next(one.get('next'))
    if logins.current() is None:
        return login_page(handler, 503, 'This server has no login key. Run artifacts login rotate in a shell.',
                          target)
    # login() checks the lock time again in the same locked step as the key check and the failure count.
    sid, wait = logins.login(one.get('user', ''), one.get('key', ''))
    if wait:
        return login_page(handler, 429, f'Too many failed logins. Wait {wait} seconds, then try again.',
                          headers={'Retry-After': str(wait)})
    if sid is None:
        log('login: refused')
        return login_page(handler, 401, 'The user name or the key is not right.', target)
    log('login: a new session')
    return Answer(303, b'', headers={'Location': target, 'Set-Cookie': set_cookie(handler, sid)})


def logout_route(handler):
    """GET /logout: end the session of the cookie and go to /login."""
    if handler.command not in ('GET', 'HEAD'):
        return Answer(405, b'method not allowed\n', headers={'Allow': 'GET, HEAD'})
    refused = same_origin_refusal(handler, origin_needed=False)
    if refused:
        return text(403, 'forbidden: ' + refused)
    sid = session_id(handler)
    if sid:
        handler.server.logins.logout(sid)
    return Answer(303, b'', headers={'Location': '/login', 'Set-Cookie': set_cookie(handler, 'none', 0)})


def open_path(path):
    """The paths outside the login: /healthz (the CLI asks it before it knows the program on the port) and the kit
    files of /static/ (no user data; a sandboxed frame has an opaque origin and sends no cookie)."""
    return path == '/healthz' or path.startswith('/static/')


def page_request(handler, path, raw):
    """True for a request of a page, which gets a redirect to /login; False for a JSON, download, write or pass
    request, which gets 401."""
    if handler.command not in ('GET', 'HEAD') or path.startswith(('/api/', '/a/', '/d/')):
        return False
    if walkr_front.listed(handler.command, handler.path):
        return walkr_front.PAGE.fullmatch(handler.path) is not None
    if memory_front.listed(handler.command, raw):
        return raw == memory_front.PREFIX + '/'
    return True


def login_refusal(handler, path, raw):
    """None when the request carries the local CLI token or a live session, else the answer: 303 to /login for a
    page, 401 with no data for each other request. A wrong CLI token is 401 also with a session."""
    tokens = handler.headers.get_all(login_lib.TOKEN_HEADER) or []
    if tokens:
        # An empty token of the server (before main writes the token file) passes nothing.
        expected = handler.server.cli_token.encode('ascii')
        if len(tokens) == 1 and expected and hmac.compare_digest(tokens[0].strip().encode('utf-8', 'replace'),
                                                                 expected):
            return None
        return json_error(401, 'UNAUTHORIZED', 'The local token is not the one of this server run.')
    sid = session_id(handler)
    live, renewed = handler.server.logins.session(sid)
    if live:
        if renewed:
            handler.cookie = set_cookie(handler, renewed)
        return None
    if page_request(handler, path, raw):
        return Answer(303, b'', headers={'Location': '/login?next=' + quote(handler.path, safe='/')})
    return json_error(401, 'UNAUTHORIZED', 'Log in on /login first.')


def api_login(handler, match):
    """The generation of the verifier that this server uses, for `artifacts status` and `artifacts login status`."""
    return Answer(200, json.dumps({'generation': handler.server.logins.generation()}).encode(), 'application/json')


ROUTES = (
    (re.compile(r'/'), root),
    (re.compile(r'/artifacts'), index),
    (re.compile(r'/artifacts/archive'), archive_page),
    (re.compile(r'/browse/?'), browse),
    (re.compile(r'/walkr'), walkr_page),
    (re.compile(r'/memory'), memory_root),
    (re.compile(r'/healthz'), healthz),
    (re.compile(r'/a/(?P<slug>[^/]*)'), artifact),
    (re.compile(r'/v/(?P<slug>[^/]*)'), viewer),
    (re.compile(r'/d/(?P<slug>[^/]*)'), download),
    (re.compile(r'/api/state(?:/(?P<slug>[^/]*))?'), api_state),
    (re.compile(r'/api/login'), api_login),
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
    """LOCAL for a loopback TCP peer and one Host header with a loopback name. PUBLIC for a loopback TCP peer and one
    Host header equal to the host of the public origin of the server (the key walkrPublicOrigin: the name, and the
    port when the origin names one; no port for 443). None for each other request. This stops DNS rebinding."""
    try:
        peer = ipaddress.ip_address(handler.client_address[0])
    except ValueError:
        return None
    peer = getattr(peer, 'ipv4_mapped', None) or peer
    hosts = handler.headers.get_all('Host') or []
    if not peer.is_loopback or len(hosts) != 1:
        return None
    if loopback_host(hosts[0]):
        return LOCAL
    public = getattr(handler.server, 'public', None)
    if public and hosts[0].strip().lower() == public.removeprefix('https://'):
        return PUBLIC
    return None


LOCAL, PUBLIC = 'local', 'public'


def public_route(command, path):
    """True for the requests that a public request reaches: GET /walkr and the pass list of the Compare page
    (walkr_front.PASSED, with the theme files). Each other request, also a new route, answers 404 with no data."""
    return command == 'GET' and path == '/walkr' or walkr_front.listed(command, path)


class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 30
    # The public origin for a public request (admitted), else None.
    public = None
    # The Set-Cookie value that renews the session cookie of this answer, else None.
    cookie = None

    def version_string(self):
        return store_lib.SERVICE

    def log_message(self, format, *args):
        # The path of the Compare page and of its frames holds the page secret: the log never holds it.
        log(walkr_front.mask(self.address_string() + ' ' + format % args))

    def send(self, answer, body=True):
        self.send_response(answer.status)
        headers = {**COMMON_HEADERS, 'Content-Type': answer.content_type, **answer.headers}
        if self.cookie and 'Set-Cookie' not in headers:
            headers['Set-Cookie'] = self.cookie
        # A 304 has no body, and its Content-Length would have to be the length of the full answer: send none.
        if answer.status != 304:
            headers['Content-Length'] = str(len(answer.body))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(answer.body)

    def route(self):
        self.cookie = None
        kind = admitted(self)
        if kind is None:
            return text(403, 'forbidden: only a loopback peer with Host 127.0.0.1, localhost or [::1]')
        # Set for each request, so that a later request on the same connection never keeps the value of one before.
        self.public = self.server.public if kind == PUBLIC else None
        if kind == PUBLIC:
            # Before each route: a public request reaches only public_route, so a new route stays closed to it.
            if not public_route(self.command, self.path):
                return not_found()
        # The event channel of the Herdr app: the exact path, with no query. It writes its own answer.
        if self.path == events.PATH:
            return self.events()
        # BaseHTTPRequestHandler folds leading slashes in self.path. Match and pass the original target.
        raw_target = self.requestline.split()[1]
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        # The login: a public request keeps its own rule (public_route), and each local request but the open paths
        # needs the CLI token or a session. The check comes before the passes.
        if kind == LOCAL:
            if path == '/login':
                return login_route(self)
            if path == '/logout':
                return logout_route(self)
            if not open_path(path):
                refused = login_refusal(self, path, raw_target)
                if refused:
                    return refused
        # The raw path: a path with a query or a fragment is not in the list.
        if walkr_front.listed(self.command, self.path):
            return walkr_pass(self)
        if memory_front.listed(self.command, raw_target):
            return memory_pass(self, raw_target)
        write = WRITE_PATH.fullmatch(path)
        if write:
            return archive_write(self, write)
        if self.command not in ('GET', 'HEAD'):
            return Answer(405, b'method not allowed\n', headers={'Allow': 'GET, HEAD'})
        for pattern, handler in ROUTES:
            match = pattern.fullmatch(path)
            if match:
                return handler(self, match)
        return not_found()

    def events(self):
        """The event channel (events.py): a refusal as JSON, or the stream. The stream is the whole answer of this
        request, so this method then returns None and answer() sends nothing more."""
        if self.command != 'GET':
            return Answer(405, b'method not allowed\n', headers={'Allow': 'GET'})
        refused = events.refusal(self.headers, self.server.hub.token)
        if refused:
            status, code, message = refused
            answer = json_error(status, code, message)
            if status == 401:
                answer.headers['WWW-Authenticate'] = 'Bearer'
            return answer
        if not events.stream(self, self.server.hub):
            return json_error(503, 'BUSY', f'{events.CLIENTS} clients are connected to the event channel.')
        return None

    def answer(self):
        try:
            result = self.route()
        except Exception as error:  # one failed request must not stop the server
            log(walkr_front.mask(f'error: {type(error).__name__}: {error}'))
            result = text(500, 'server error')
        if result is not None:
            self.send(result, body=self.command != 'HEAD')

    def __getattr__(self, name):
        # BaseHTTPRequestHandler looks up do_<METHOD>; each method goes through the same route checks.
        if name.startswith('do_'):
            return self.answer
        raise AttributeError(name)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, store, hub=None, memory=None, public=None, logins=None, cli_token=''):
        self.store = str(store)
        # The admin login (login.Logins) and the local CLI token of this run.
        self.logins = logins
        self.cli_token = cli_token
        # The public origin of the key walkrPublicOrigin (admitted), or None.
        self.public = public
        # The event channel (events.py) and the child process of the Memory section (memory_front.py).
        self.hub = hub
        self.memory = memory
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


def artifact_facts(store):
    """{slug: (version, title, archived)} of the store, for the event channel."""
    return {meta['slug']: (store_lib.version(meta), str(meta.get('title') or meta['slug']), store_lib.archived(meta))
            for meta in store_lib.artifacts(store)}


def module_states(memory):
    """{module name: True when it runs} for the event channel: this server, and Walkr and the memory viewer when they
    are installed."""
    states = {'artifacts': True}
    if walkr_front.installed():
        states['walkr'] = walkr_front.socket_state() == 'open'
    if memory_front.installed():
        states['memory'] = memory.running()
    return states


def public_origin():
    """The public origin of the config key walkrPublicOrigin, read once at the start. A file or a value that is not
    valid logs one line and gives None: the server then admits only local requests (fail closed)."""
    try:
        origin = store_lib.public_origin_of(store_lib.load_config())
    except store_lib.ConfigError as error:
        log(f'walkr: public origin off: {error}')
        return None
    if origin:
        log(f'walkr: public origin {origin}')
    return origin


def main(argv=None):
    parser = argparse.ArgumentParser(description='the local tenant-artifacts server')
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args(argv)
    # SIGUSR1 writes the stack of each thread to the log: the CLI sends it when the server gives no /healthz answer.
    faulthandler.register(signal.SIGUSR1)
    store = store_lib.store_dir()
    store_lib.make_store(store)
    # A new token of the event channel for each run, in a file that only this user can read.
    # The memory viewer: a child process with the settings file of the user. It starts beside the first answers of
    # this server, and again at a request when it is gone.
    memory = memory_front.Child(store_lib.config_path().parent / memory_front.SETTINGS, walkr_front.child_env(), log)
    logins = login_lib.Logins(store_lib.config_path().parent / login_lib.VERIFIER)
    if logins.current() is None:
        log('login: no valid verifier file; each protected route is refused until artifacts login rotate')
    # The bind comes first: a server that cannot bind writes no token file, so the tokens of a running server stay.
    server = Server(args.port, store, memory=memory, public=public_origin(), logins=logins)
    server.cli_token = events.write_token(store_lib.state_dir(), login_lib.CLI_TOKEN_FILE)
    hub = server.hub = events.Hub(events.write_token(store_lib.state_dir()), lambda: artifact_facts(str(store)),
                                  lambda: module_states(memory))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    # The first sweep runs before the first answer, so a /healthz answer means that it is done.
    sweep_once(str(store))
    stop = threading.Event()
    threading.Thread(target=sweeper, args=(str(store), stop), daemon=True).start()
    threading.Thread(target=events.watcher, args=(hub, stop), daemon=True).start()
    threading.Thread(target=memory.target, daemon=True).start()
    log(f'listening on 127.0.0.1:{args.port}, pid {os.getpid()}, store {store}')
    try:
        server.serve_forever()
    finally:
        stop.set()
        # Each client of the event channel gets the stop event; its thread has a moment to send it.
        watched = hub.watched()
        hub.close()
        if watched:
            time.sleep(0.3)
        memory.stop()
        server.server_close()
        log('stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
