// Hash routes keep the search, source, folder and reader addressable.
// Only GET requests read source data. Content stays in this page's memory.
// One POST exists: the decision for a proposed record of a review source.
import { el, renderMarkdown, renderText } from './render.js';
import { browseRequest, reviewRequest, searchRequest, searchSelection, sourceSearchRequest } from './selection.js';
import { FolderTree, PROVIDERS, folderHref, pathParts, railEntries } from './rail.js';

const main = document.getElementById('main');
const status = document.getElementById('status');
const nav = document.getElementById('sources-nav');
const banner = document.getElementById('mode-banner');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const railToggle = document.getElementById('rail-toggle');
// A reader can close a provider group. A group opens again only when a route enters one of its sources.
const railClosed = new Set();
// The start of the key of a retry control. The rest is the key of its row.
const RETRY = 'retry ';
// The folders of each source that the rail shows. Content stays in this page's memory.
const tree = new FolderTree();
const typeOrder = ['openviking', 'okknow', 'llmwiki', 'hermes', 'agentcore'];
const state = { sources: [], mode: '', overview: null, renderId: 0, readerId: 0, viewKey: null, route: null,
  path: null, entry: null, revealed: null, showCurrent: false };

function put(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

function grouped(sources) {
  return [...sources].sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));
}

function plural(unit = 'entry', n) {
  if (n === 1) return unit;
  return unit.endsWith('y') ? `${unit.slice(0, -1)}ies` : `${unit}s`;
}

async function api(path, init = { headers: { Accept: 'application/json' }, cache: 'no-store' }) {
  const res = await fetch(path, init);
  let body = {};
  try { body = await res.json(); } catch { /* The HTTP status still describes an empty response. */ }
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  if (body.mode) setMode(body.mode);
  return body;
}

function q(params) {
  const values = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) values.set(k, v);
  return values.size ? `?${values}` : '';
}

function href(route, params = {}) { return `#${route}${q(params)}`; }
function sourcePath(id) { return `/source/${encodeURIComponent(id)}`; }
function announce(text) { status.textContent = text; }
function fmtCount(n) { return Number.isFinite(n) ? n.toLocaleString('en-US') : '—'; }
function current(id) { return id === state.renderId; }
function source(id) { return state.sources.find((s) => s.id === id); }
function srcClass(s) { return `src src-${typeOrder.includes(s?.type) ? s.type : 'none'}`; }
function sourceName(id) {
  const s = source(id);
  return el('span', { class: `${srcClass(s)} src-name` }, s?.name ?? id);
}

function dateNode(iso, label) {
  if (!iso) return el('span', { class: 'date muted' }, 'No date');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return el('span', { class: 'date muted' }, 'Unknown date');
  return el('time', { class: 'date', datetime: date.toISOString(), title: `${label ?? 'Date'}: ${iso}` }, date.toISOString().slice(0, 10));
}

function errorBox(err, what) {
  return el('div', { class: 'notice notice-error', role: 'alert' },
    el('strong', {}, `${what} failed. `), err?.message ?? 'The source did not return a result.');
}

function loading(text) { return el('p', { class: 'notice loading', role: 'status' }, text); }

function notes(data) {
  const values = [data.note, ...(Array.isArray(data.notes) ? data.notes : [data.notes])].filter(Boolean);
  return [
    data.partial ? el('p', { class: 'notice partial' }, 'Partial result. This read does not cover the whole source.') : null,
    ...[...new Set(values)].map((text) => el('p', { class: 'note' }, String(text))),
    data.errors?.length ? el('ul', { class: 'namespace-errors notice notice-error' }, data.errors.map((error) =>
      el('li', {}, el('code', {}, error.path), ': ', error.message))) : null,
  ];
}

function staleNotice(data) {
  if (data?.state !== 'stale') return null;
  return el('div', { class: 'notice notice-error stale-notice', role: 'status' },
    el('strong', { class: 'state-word' }, 'Stale'),
    el('p', {}, data.error?.message ?? 'The last read failed.'),
    data.detail ? el('p', {}, data.detail) : null,
    Number.isFinite(data.total) ? el('p', {}, `${fmtCount(data.total)} counted ${plural(data.unit, data.total)} remain available.`) : null);
}

function namespaceState(folder) {
  if (!folder.state || folder.state === 'unloaded') return el('span', { class: 'load-label' }, 'Load namespace · reads AWS');
  const labels = { loaded: 'Loaded', empty: 'Empty', partial: 'Partial', denied: 'Denied', failed: 'Failed' };
  return el('span', { class: 'namespace-state' }, labels[folder.state] ?? folder.state,
    folder.state === 'denied' || folder.state === 'failed' ? ' · retry reads AWS' : '',
    folder.error?.message ? el('span', { class: 'state-detail' }, folder.error.message) : null);
}

function setMode(mode) {
  state.mode = mode;
  const text = {
    sample: 'Sample mode: synthetic records only. Nothing here is live memory.',
    mixed: 'Mixed mode: some sources show synthetic records. Each source names its mode.',
  }[mode];
  banner.hidden = !text;
  banner.textContent = text ?? '';
}

// The links to the other sections exist only below the local web app, where this page is the section /memory/.
// A standalone server has no other section, so the links hide there. theme.js owns the theme and its list.
const appNav = document.getElementById('app-nav');
if (appNav && !location.pathname.startsWith('/memory/')) appNav.hidden = true;

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const at = raw.indexOf('?');
  const path = at < 0 ? raw : raw.slice(0, at);
  const params = Object.fromEntries(new URLSearchParams(at < 0 ? '' : raw.slice(at + 1)));
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'search') return { view: 'search', path, params };
  if (parts[0] === 'source' && parts[1]) return { view: 'source', path, id: decodeURIComponent(parts[1]), params };
  return { view: 'global', path: '/', params: {} };
}

function withoutReader(params) {
  const { item, open, ...rest } = params;
  return rest;
}

async function route({ refresh = false } = {}) {
  const previous = state.route;
  const readerId = ++state.readerId;
  let id = state.renderId;
  try {
    const r = parseRoute();
    const key = JSON.stringify([r.view, r.id, withoutReader(r.params)]);
    const focusedFilter = document.activeElement?.closest('.filter')?.dataset.source;
    state.route = r;
    if (state.entry && (state.entry.id !== r.params.item || state.entry.sid !== (r.id ?? r.params.open))) state.entry = null;
    if (r.view !== 'source') state.path = null;
    // Only the entry into a source opens its tree and its group. A redraw keeps what the reader closed.
    if (r.view === 'source' && source(r.id) && (previous?.view !== 'source' || previous.id !== r.id)) {
      tree.enter(r.id);
      railClosed.delete(source(r.id).type);
      state.revealed = null;
    }
    renderNav(r);
    searchInput.value = r.view === 'search' ? r.params.q ?? '' : '';
    main.classList.toggle('reading', Boolean(r.params.item));
    let ready;
    // List and reader generations are separate, including while either read is pending.
    if (refresh || key !== state.viewKey) {
      id = ++state.renderId;
      state.viewKey = key;
      ready = r.view === 'search' ? viewSearch(r.params, id)
        : r.view === 'source' ? viewSource(r.id, r.params, id) : viewGlobal(id, refresh);
      focusFilter(focusedFilter);
    }
    const reader = main.querySelector('.reader-col');
    let reading;
    main.querySelector('.cols, .split')?.classList.toggle('has-reader', Boolean(r.params.item));
    if (reader) {
      if (r.params.item) reading = openReader(reader, r.id ?? r.params.open, r.params.item, readerId);
      else {
        put(reader);
        paintPath();
        const link = Array.from(main.querySelectorAll('.item-link')).find((a) =>
          a.dataset.item === previous?.params.item && a.dataset.source === (previous?.id ?? previous?.params.open));
        link?.focus({ preventScroll: true });
      }
    }
    await Promise.all([ready, reading]);
    if (current(id)) markSelection(state.route);
  } catch (err) {
    if (current(id)) {
      state.renderId += 1;
      state.viewKey = null;
      put(main, errorBox(err, 'Loading the page'), el('a', { href: '#/' }, 'Back to all sources'));
    }
  }
}

function focusFilter(sid) {
  if (sid) Array.from(main.querySelectorAll('.filter')).find((button) => button.dataset.source === sid)?.focus({ preventScroll: true });
}

function markSelection(r) {
  for (const a of main.querySelectorAll('.item-link')) {
    const active = a.dataset.item === r.params.item && a.dataset.source === (r.id ?? r.params.open);
    if (active) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
    a.closest('li')?.classList.toggle('active', active);
  }
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = searchInput.value.trim();
  if (!text) return;
  location.hash = href('/search', { q: text, s: state.route?.view === 'search' ? state.route.params.s : undefined });
});

document.querySelector('.skip').addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});

document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const active = document.activeElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') || active?.isContentEditable;
  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (event.key === 'Escape' && state.route?.params.item) {
    event.preventDefault();
    location.hash = href(state.route.path, withoutReader(state.route.params));
  } else if (!typing && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const list = active?.closest('[data-key-list]');
    if (!list) return;
    const links = Array.from(list.querySelectorAll('a, button')).filter((node) => node.getClientRects().length);
    const at = links.indexOf(active);
    if (at < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : Math.max(0, Math.min(links.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    links[next]?.focus();
  } else if (!typing && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
    // Right opens the folders of a rail row; Left closes them.
    const toggle = active?.closest?.('.rail-row')?.querySelector('.tree-toggle');
    if (!toggle || (toggle.getAttribute('aria-expanded') === 'true') === (event.key === 'ArrowRight')) return;
    event.preventDefault();
    toggle.click();
  }
});
window.addEventListener('hashchange', () => {
  closeRail({ toContent: true });
  route();
});

// On a small screen the rail opens below the title bar. It is always open on a wide screen.
function closeRail({ toContent = false } = {}) {
  if (!nav.classList.contains('is-open')) return;
  const inside = nav.contains(document.activeElement);
  nav.classList.remove('is-open');
  railToggle.setAttribute('aria-expanded', 'false');
  if (inside) (toContent ? main : railToggle).focus({ preventScroll: true });
}
railToggle.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  railToggle.setAttribute('aria-expanded', String(open));
  // The rail comes after the title bar in the document. Focus moves into it; closeRail returns it.
  if (open) {
    const shown = Array.from(nav.querySelectorAll('a, button')).filter((node) => node.getClientRects().length);
    (shown.find((node) => node.getAttribute('aria-current')) ?? shown[0])?.focus({ preventScroll: true });
  }
});
nav.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !nav.classList.contains('is-open')) return;
  event.preventDefault();
  event.stopPropagation();
  closeRail();
});

function logo(src) {
  const plate = () => el('span', { class: 'rail-logo rail-logo-none', 'aria-hidden': 'true' });
  // A logo that does not load leaves a plain plate. The label still names the source.
  return src ? el('img', { class: 'rail-logo', src, alt: '', width: '24', height: '24',
    onerror: (event) => event.target.replaceWith(plate()) }) : plate();
}

function railLink(url, cls, isCurrent, mark, label, title) {
  return el('a', { href: url, class: `nav-link ${cls}`, 'aria-current': isCurrent ? 'page' : null, title },
    mark, el('span', { class: 'rail-label' }, label));
}

function browseUrl(sid, params) {
  return `api/sources/${encodeURIComponent(sid)}/browse${q(browseRequest(params))}`;
}

// One browse request fills one node of the tree. A reply for a node that the reader closed is dropped.
// A second call for a node whose read is on the way waits for that read and sends nothing.
const reading = new Map();
function loadFolders(s, path) {
  const key = `${s.id}\n${path}`;
  if (tree.node(s.id, path).state === 'loading' && reading.has(key)) return reading.get(key);
  const done = tree.read(s, path, () => { treeChanged(); return api(browseUrl(s.id, { path })); })
    .then((took) => { if (took) treeChanged(); })
    .finally(() => { if (reading.get(key) === done) reading.delete(key); });
  reading.set(key, done);
  return done;
}

function treeChanged() {
  renderNav(state.route);
  paintPath();
  if (!state.showCurrent) return;
  const link = nav.querySelector('.tree-link[aria-current]');
  if (!link) return;
  state.showCurrent = false;
  link.scrollIntoView({ block: 'nearest' });
}

function toggleSource(s) {
  if (tree.isOpen(s.id)) tree.close(s.id);
  else {
    tree.pin(s.id);
    if (tree.needsRead(s.id)) { loadFolders(s, ''); return; }
  }
  treeChanged();
}

function toggleFolder(s, path) {
  if (tree.isPathOpen(s.id, path)) tree.collapse(s.id, path);
  else {
    tree.expand(s.id, path);
    if (tree.needsRead(s.id, path)) { loadFolders(s, path); return; }
  }
  treeChanged();
}

function treeToggle(key, open, controls, label, onclick) {
  return el('button', { type: 'button', class: 'tree-toggle', 'data-key': key, 'aria-expanded': String(open),
    'aria-controls': open ? controls : null, 'aria-label': label, title: label, onclick },
  el('span', { class: 'rail-caret', 'aria-hidden': 'true' }));
}

function folderList(s, path, here, ids) {
  const node = tree.node(s.id, path);
  const noun = s.lazy ? 'namespaces' : 'folders';
  const items = node.folders.flatMap((folder, index) => {
    // A section heading stands before the first folder of each group.
    const heading = folder.group && folder.group !== node.folders[index - 1]?.group
      ? el('li', { class: 'tree-group' }, el('p', { class: 'tree-group-name' }, folder.group)) : null;
    const child = tree.node(s.id, folder.path);
    // A folder with no folder inside has no control once the tree knows it.
    const can = tree.mayRead(s, folder.path) && !(child.state === 'ok' && !child.folders.length);
    const open = can && tree.isPathOpen(s.id, folder.path);
    const key = `folder ${s.id} ${folder.path}`;
    const sub = open ? folderList(s, folder.path, here, ids) : null;
    return [heading, el('li', {}, el('div', { class: 'rail-row', 'data-row': key },
      can ? treeToggle(key, open, sub?.id, `Folders in ${folder.label}`, () => toggleFolder(s, folder.path))
        : s.lazy ? null : el('span', { class: 'tree-spacer', 'aria-hidden': 'true' }),
      el('a', { class: 'tree-link', href: folderHref(s.id, folder.path), title: folder.label,
        'aria-current': here === folder.path && (ids.marked = true) ? 'location' : null },
      el('span', { class: 'tree-name' }, folder.label),
      Number.isFinite(folder.count) ? el('span', { class: 'facet-count' }, fmtCount(folder.count)) : null,
      s.lazy ? namespaceState(folder) : null)), sub)];
  });
  const waiting = node.state === 'loading' || node.state === 'idle';
  // The retry control stays in place while its read is on the way, so the focus stays on it when the read fails again.
  const retrying = node.state === 'loading' && Boolean(node.error);
  return el('ul', { class: 'rail-tree', id: `rail-tree-${ids.next += 1}` }, items,
    waiting && (!items.length || retrying) ? el('li', {}, el('p', { class: 'tree-note', role: 'status' }, `Reading ${noun}…`)) : null,
    node.state === 'ok' && !items.length ? el('li', {}, el('p', { class: 'tree-note' }, `No ${noun}.`)) : null,
    node.state === 'error' || retrying ? el('li', {}, retrying ? null : el('p', { class: 'tree-note tree-error', role: 'alert' },
      el('strong', {}, `Reading the ${noun} failed. `), node.error?.message ?? 'The source did not return a result.'),
    // When this button leaves, the rest of its key gives the focus to the control of the row.
    el('button', { type: 'button', class: 'quiet tree-retry', 'data-key': `${RETRY}${path ? `folder ${s.id} ${path}` : `source ${s.id}`}`,
      'aria-disabled': retrying ? 'true' : null, onclick: () => { if (!retrying) loadFolders(s, path); } }, 'Try again')) : null);
}

// A rail row of one source: its link, the control of its folders and, when open, the folders.
function sourceRow(s, link, r, ids) {
  const open = tree.isOpen(s.id);
  const key = `source ${s.id}`;
  // The source can answer with another form of the route path. That form marks the folder once its reply is here.
  const asked = r.params.path ?? '';
  const here = r.view !== 'source' || r.id !== s.id ? null
    : state.path?.sid === s.id && state.path.asked === asked ? state.path.at : asked;
  ids.marked = false;
  const list = open ? folderList(s, '', here, ids) : null;
  // One mark for the current place: the folder when the tree shows it, else the source.
  if (ids.marked) {
    link.removeAttribute('aria-current');
    link.classList.add('holds-current');
  }
  list?.setAttribute('aria-label', `${s.lazy ? 'Namespaces' : 'Folders'} of ${s.name || s.id}`);
  return [el('div', { class: 'rail-row', 'data-row': key }, link,
    treeToggle(key, open, list?.id, `${s.lazy ? 'Namespaces' : 'Folders'} of ${s.name || s.id}`, () => toggleSource(s))), list];
}

function railGroup(entry, r, ids) {
  const holdsCurrent = r.view === 'source' && entry.members.some((member) => member.id === r.id);
  const open = !railClosed.has(entry.type);
  const subId = `rail-sub-${entry.type}`;
  const sub = el('ul', { class: 'rail-sub', id: subId, 'aria-label': `${entry.label} agents`, hidden: !open },
    entry.members.map((member) => el('li', {}, sourceRow(member.source, railLink(href(sourcePath(member.id)), `nav-sub ${srcClass(member.source)}`,
      r.view === 'source' && r.id === member.id, null, member.label, member.source.name), r, ids))));
  const toggle = el('button', {
    type: 'button', class: `nav-link rail-group-toggle${holdsCurrent ? ' has-current' : ''}`, 'data-key': `group ${entry.type}`,
    'aria-expanded': String(open), 'aria-controls': subId,
    onclick: () => {
      const closed = sub.toggleAttribute('hidden');
      if (closed) railClosed.add(entry.type); else railClosed.delete(entry.type);
      toggle.setAttribute('aria-expanded', String(!closed));
    },
  }, logo(entry.logo), el('span', { class: 'rail-label' }, entry.label), el('span', { class: 'rail-caret', 'aria-hidden': 'true' }));
  return el('li', { class: `rail-group ${srcClass(entry)}` }, toggle, sub);
}

// Paints again and gives the focus back to the same link or control. A control that left its row gives it to the link.
function repaint(container, paint) {
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const focused = active?.getAttribute('href') ?? null;
  const key = active?.dataset.key ?? null;
  paint();
  if (!active) return;
  const button = (wanted) => Array.from(container.querySelectorAll('button')).find((node) => node.dataset.key === wanted);
  const row = key?.startsWith(RETRY) ? key.slice(RETRY.length) : key;
  const again = focused ? Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === focused)
    : key ? button(key) ?? button(row)
      ?? Array.from(container.querySelectorAll('.rail-row')).find((node) => node.dataset.row === row)?.querySelector('a') : null;
  again?.focus({ preventScroll: true });
}

function renderNav(r) {
  const ids = { next: 0 };
  repaint(nav, () => put(nav, el('ul', { class: 'rail-list', 'data-key-list': true },
    el('li', {}, railLink('#/', 'nav-all', r.view === 'global', logo('favicon.svg'), 'All sources')),
    railEntries(state.sources).map((entry) => entry.kind === 'group' ? railGroup(entry, r, ids)
      : el('li', {}, sourceRow(entry.source, railLink(href(sourcePath(entry.source.id)), srcClass(entry.source),
        r.view === 'source' && r.id === entry.source.id, logo(entry.logo), entry.label), r, ids))))));
}

// The path bar: the source, each folder of the path as a link, and the open entry as the last part.
function paintPath() {
  const bar = main.querySelector('.path-bar');
  const at = state.path;
  if (!bar || !at) return;
  const parts = pathParts(source(at.sid), at.crumbs, at.at, (path) => tree.label(at.sid, path));
  const entry = state.entry?.sid === at.sid && state.entry.title ? state.entry : null;
  repaint(bar, () => put(bar, el('ol', { class: 'crumbs' },
    parts.map((part, index) => el('li', {}, el('a', { href: folderHref(at.sid, part.path),
      'aria-current': !entry && index === parts.length - 1 ? 'location' : null }, part.label))),
    entry ? el('li', { class: 'crumb-entry' }, el('span', { 'aria-current': 'location' }, entry.title)) : null),
  at.text ? el('span', { class: 'path-note muted' }, at.at ? 'The search covers this folder.' : 'The search covers the whole source.') : null));
}

async function viewGlobal(id, refresh) {
  put(main, el('section', { class: 'page-head' }, el('h1', {}, 'All memory')), loading('Reading the source ledger…'));
  const [ov, recent] = await Promise.all([
    api(`api/overview${refresh ? '?refresh=1' : ''}`).catch((error) => ({ error })),
    api('api/recent?limit=25').catch((error) => ({ error })),
  ]);
  if (!current(id)) return;
  const sources = grouped(ov.sources ?? state.sources.map((s) => ({ ...s, state: 'error', error: ov.error })));
  state.overview = sources;
  const counted = sources.filter((s) => s.state !== 'error' && Number.isFinite(s.total));
  const total = counted.reduce((sum, s) => sum + s.total, 0);
  put(main,
    el('section', { class: 'page-head' },
      el('div', { class: 'page-title' }, el('h1', {}, 'All memory'),
        el('button', { type: 'button', class: 'quiet', onclick: () => route({ refresh: true }) }, 'Read again')),
      el('p', { class: 'lede' }, `${fmtCount(total)} counted entries in ${counted.length} of ${sources.length} sources. `,
        'Each source counts its own unit: a file, a page, an entry or a record.')),
    strata(counted, total), ledger(sources), recentList(recent));
  announce(`All memory: ${fmtCount(total)} counted entries.`);
}

function strata(sources, total) {
  const bar = el('div', { class: 'strata-bar', 'aria-label': 'Share of counted entries by source' });
  for (const s of sources) {
    if (s.total <= 0 || !total) continue;
    const share = s.total / total;
    const segment = el('a', {
      class: `strata-seg ${srcClass(s)}`, href: href(sourcePath(s.id)),
      'aria-label': `${s.name}: ${fmtCount(s.total)} ${plural(s.unit, s.total)}, ${Math.round(share * 100)} percent`,
      title: `${s.name}: ${fmtCount(s.total)} (${(share * 100).toFixed(1)}%)`,
    }, el('span', { class: 'strata-label' }, share > 0.08 ? s.name : ''));
    // CSSOM sets the size without an inline style attribute in the source.
    segment.style.flexGrow = String(share);
    bar.append(segment);
  }
  if (!bar.childNodes.length) bar.append(el('span', { class: 'strata-empty' }, 'No source has a count yet.'));
  return el('figure', { class: 'strata' }, bar,
    el('figcaption', { class: 'muted' }, 'Width shows counted entries, not storage size. Unknown and empty counts have no segment.'));
}

function stateCell(s) {
  const word = s.state === 'error' ? 'Error' : s.state === 'stale' ? 'Stale' : s.state === 'loading' ? 'Loading' : s.lazy ? 'On request'
    : s.partial ? 'Partial' : s.total === 0 ? 'Empty' : s.mode === 'sample' ? 'Sample' : 'Live';
  return el('td', { class: `state ${['error', 'stale'].includes(s.state) ? 'state-error' : s.mode === 'sample' ? 'state-sample' : ''}`, 'data-label': 'State' },
    el('span', { class: 'state-word' }, word),
    ['error', 'stale'].includes(s.state) ? el('span', { class: 'state-detail' }, s.error?.message ?? 'The read failed.') : null,
    el('span', { class: 'state-detail' }, s.detail ?? (s.state === 'error' ? '' : s.lazy ? 'Open a namespace to load records.' : s.mode === 'sample' ? 'Synthetic records' : '')),
    ...notes(s));
}

function ledger(sources) {
  const rows = sources.map((s) => el('tr', { class: srcClass(s) },
    el('th', { scope: 'row' }, el('a', { href: href(sourcePath(s.id)), class: 'src-name' }, s.name),
      el('span', { class: 'unit' }, `${s.unit}${s.mode === 'sample' ? ' · sample' : ''}`)),
    stateCell(s),
    el('td', { class: 'num', 'data-label': 'Entries' }, s.state !== 'error' ? `${s.partial && Number.isFinite(s.total) ? '≥ ' : ''}${fmtCount(s.total)}` : '—'),
    el('td', { 'data-label': 'Newest entry' }, s.newest ? dateNode(s.newest) : el('span', { class: 'muted' }, 'Not known')),
    el('td', { 'data-label': s.lazy ? 'Namespaces' : 'Largest scopes' }, (s.facets ?? []).length
      ? el('div', { class: 'facets' }, s.facets.slice(0, 3).map((f) => el('a', {
        href: href(sourcePath(s.id), { path: f.path }), class: 'facet',
      }, f.label, s.lazy ? namespaceState(f)
        : Number.isFinite(f.count) ? el('span', { class: 'facet-count' }, fmtCount(f.count)) : null)))
      : el('span', { class: 'muted' }, 'None reported'))));
  return el('section', { class: 'ledger', 'aria-labelledby': 'ledger-h' }, el('h2', { id: 'ledger-h' }, 'Sources'),
    el('div', { class: 'table-wrap' }, el('table', { role: 'table' },
      el('thead', { role: 'rowgroup' }, el('tr', { role: 'row' },
        ['Source', 'State', 'Entries', 'Newest entry', 'Largest scopes'].map((name) => el('th', { scope: 'col' }, name)))),
      el('tbody', { role: 'rowgroup' }, rows))),
    !sources.length ? el('p', { class: 'muted' }, 'No sources are configured.') : null);
}

function itemLink(item, url, active = false) {
  return el('a', { class: 'item-link', href: url, 'aria-current': active ? 'true' : null,
    'data-item': item.id, 'data-source': item.source }, el('span', { class: 'item-title' }, item.title));
}

function recentList(data) {
  return el('section', { class: 'recent', 'aria-labelledby': 'recent-h' },
    el('h2', { id: 'recent-h' }, 'Recent across all sources'),
    el('p', { class: 'muted' }, 'The newest dated entries available. On-request sources show only loaded records.'),
    ...notes(data),
    data.error ? errorBox(data.error, 'Reading recent entries')
      : data.items?.length ? el('ol', { class: 'timeline', 'data-key-list': true }, data.items.map((item) =>
        el('li', { class: srcClass(source(item.source)) }, dateNode(item.date, item.dateLabel), sourceName(item.source),
          itemLink(item, href(sourcePath(item.source), { item: item.id })),
          item.scope ? el('span', { class: 'scope', title: item.scope }, item.scope) : null)))
        : el('p', { class: 'muted' }, 'No dated entries.'));
}

function filters(params, selected, results = []) {
  return el('div', { class: 'filters', role: 'group', 'aria-label': 'Sources to search' }, state.sources.map((s) => {
    const on = selected.includes(s.id);
    const result = results.find((r) => r.id === s.id);
    const next = on ? selected.filter((id) => id !== s.id) : [...selected, s.id];
    return el('button', { type: 'button', class: `filter ${srcClass(s)}`, 'aria-pressed': String(on), 'data-source': s.id,
      onclick: () => { location.hash = href('/search', { q: params.q, s: next.join(',') }); },
    }, el('span', { class: 'filter-box', 'aria-hidden': 'true' }, on ? '✓' : ''), s.name,
    result ? el('span', { class: 'filter-count' }, result.state === 'error' ? 'error' : fmtCount(result.total)) : null,
    s.lazy ? el('span', { class: 'filter-note' }, 'reads AWS') : null);
  }));
}

async function viewSearch(params, id) {
  const text = params.q?.trim() ?? '';
  const selected = searchSelection(state.sources, params);
  const head = el('section', { class: 'page-head' }, el('h1', {}, text ? `Search: “${text}”` : 'Search'),
    el('p', { class: 'lede' }, 'Each source ranks its own matches. Scores from different sources are not comparable.'),
    filters(params, selected));
  const results = el('div', { class: 'results-col', 'aria-busy': 'true' }, loading('Searching the selected sources…'));
  const reader = el('aside', { class: 'reader-col', 'aria-label': 'Reader' });
  put(main, head, el('div', { class: `split ${params.item ? 'has-reader' : ''}` }, results, reader));
  let data;
  try {
    const request = searchRequest(state.sources, params);
    data = request ? await api(`api/search${q(request)}`) : { results: [] };
  } catch (error) {
    if (current(id)) { results.setAttribute('aria-busy', 'false'); put(results, errorBox(error, 'Search')); }
    return;
  }
  if (!current(id)) return;
  const groups = grouped(data.results);
  const focusedFilter = document.activeElement?.closest('.filter')?.dataset.source;
  put(head, el('h1', {}, text ? `Search: “${text}”` : 'Search'),
    el('p', { class: 'lede' }, 'Each source ranks its own matches. Scores from different sources are not comparable.'),
    el('p', { class: 'muted' }, 'Sources marked “reads AWS” join only when selected. Sample mode never reads AWS.'),
    filters(params, selected, groups));
  focusFilter(focusedFilter);
  results.setAttribute('aria-busy', 'false');
  put(results, !text ? el('p', { class: 'notice' }, 'Enter a search term.')
    : !selected.length ? el('p', { class: 'notice' }, 'No sources selected. Select a source to search.')
      : groups.map((result) => {
        const s = source(result.id) ?? result;
        const items = result.items ?? [];
        const link = href(sourcePath(result.id), { q: text });
        return el('section', { class: `group ${srcClass(s)}`, 'aria-labelledby': `g-${result.id}` },
          el('h2', { id: `g-${result.id}` }, el('a', { href: link, class: 'src-name' }, s.name),
            el('span', { class: 'group-count' }, result.state === 'error' ? 'Failed' : `${fmtCount(result.total)} reported matches`)),
          ...notes(result), result.state === 'error' ? errorBox(result.error, `${s.name} search`) : null,
          items.length ? el('ol', { class: 'results', 'data-key-list': true }, items.map((item) => resultRow(item,
            href('/search', { ...params, open: result.id, item: item.id }), params.open === result.id && params.item === item.id)))
            : result.state !== 'error' ? el('p', { class: 'muted' }, result.partial ? 'No match in the returned results.' : 'No match.') : null,
          result.more || result.total > items.length ? el('a', { class: 'more', href: link }, `Open ${s.name} for more results`) : null);
      }));
  markSelection(state.route);
  announce(`Search returned ${groups.length} source groups.`);
}

function resultRow(item, url, active) {
  return el('li', { class: active ? 'active' : '' }, itemLink(item, url, active),
    item.snippet ? el('p', { class: 'snippet' }, item.snippet) : null,
    el('p', { class: 'item-meta' }, dateNode(item.date, item.dateLabel),
      item.scope ? el('span', { class: 'scope', title: item.scope }, item.scope) : null,
      item.kind ? el('span', { class: 'kind' }, item.kind) : null));
}

async function viewSource(sid, params, id) {
  const s = source(sid);
  if (!s) { put(main, errorBox(new Error('No source has this id.'), 'Opening the source')); return; }
  const path = params.path ?? '';
  const text = params.q ?? '';
  const form = el('form', { class: 'source-search', role: 'search' },
    el('label', { class: 'visually-hidden', for: 'source-q' }, `Search ${s.name}`),
    el('input', { id: 'source-q', name: 'q', type: 'search', value: text, placeholder: 'Search this source', autocomplete: 'off', maxlength: '500' }),
    el('button', { type: 'submit' }, s.lazy ? 'Search · reads AWS' : 'Search'),
    text ? el('a', { class: 'quiet', href: href(sourcePath(sid), { path }) }, 'Clear') : null);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    location.hash = href(sourcePath(sid), { path, q: form.querySelector('input').value.trim() || undefined });
  });
  const head = el('section', { class: `page-head source-head ${srcClass(s)}` },
    el('div', { class: 'page-title' }, logo(PROVIDERS[s.type]?.logo), el('h1', { class: 'src-name' }, s.name),
      el('span', { class: `mode-chip mode-${s.mode}` }, `${s.mode === 'sample' ? 'Sample' : 'Live'}${s.lazy ? ' · on request' : ''}`)),
    el('p', { class: 'lede' }, s.description),
    s.lazy ? el('p', { class: 'note' }, `Loading a namespace reads AWS. Searching reads ${path ? 'the selected namespace' : 'all configured namespaces'}.`,
      s.mode === 'sample' ? ' This sample uses synthetic records only.' : '') : null, form);
  const bar = el('nav', { class: `path-bar ${srcClass(s)}`, 'aria-label': 'Path' });
  const list = el('section', { class: `list-col ${srcClass(s)}`, 'aria-label': 'Entries', 'aria-busy': 'true' }, loading('Reading entries…'));
  const reader = el('aside', { class: 'reader-col', 'aria-label': 'Reader' });
  put(main, head, bar, el('div', { class: `cols ${params.item ? 'has-reader' : ''}` }, list, reader));
  state.path = { sid, crumbs: null, at: path, asked: path, text };
  paintPath();
  // Status can wait on another source; it must not hold up this source's data.
  api('api/overview').then((overview) => {
    if (!current(id)) return;
    const entry = overview.sources?.find((entry) => entry.id === sid);
    const stale = staleNotice(entry);
    if (stale) head.append(stale);
    if (entry?.state === 'error') head.append(errorBox(entry.error, 'Reading source status'));
  }).catch((error) => {
    if (current(id)) head.append(errorBox(error, 'Reading source status'));
  });
  try {
    const browse = await api(browseUrl(sid, params)).catch((error) => ({ error }));
    if (!current(id)) return;
    // The reply of the list is also the reply for its folder in the rail. A source can answer with
    // another form of the path (a closing slash); its form is the one that the folder links carry.
    const read = browseRequest(params).path;
    const at = text ? path : browse.path ?? path;
    const fed = text ? read : at;
    tree.feed(sid, fed, browse);
    state.path = { sid, crumbs: text || browse.error ? null : browse.crumbs, at, asked: path, text };
    const key = `${sid}\n${at}`;
    if (state.revealed !== key) {
      state.revealed = key;
      tree.reveal(sid, browse.crumbs);
      state.showCurrent = true;
    }
    // A namespace read changes the states of the root, and a refused one returns no navigation.
    // The root lists namespaces without loading them.
    // Each other source reads the levels above the current folder, one after the other (tree.walk).
    // A tree that the reader closed reads nothing.
    if (s.lazy && read) { if (tree.isOpen(sid)) loadFolders(s, ''); }
    else tree.walk(s, browse.crumbs, fed, (above) => loadFolders(s, above), () => current(id));
    treeChanged();
    const data = text ? await api(`api/sources/${encodeURIComponent(sid)}/search${q(sourceSearchRequest(params))}`) : browse;
    if (!current(id)) return;
    const items = data.items ?? [];
    list.setAttribute('aria-busy', 'false');
    put(list, el('h2', {}, text ? `Matches for “${text}”` : browse.crumbs?.at(-1)?.label ?? 'Entries'),
      data.error ? errorBox(data.error, `Reading ${s.name}`) : [
        ...notes(data),
        s.lazy && path && !text && data.state ? namespaceState(data) : null,
        Number.isFinite(data.total) && (!s.lazy || path || text) ? el('p', { class: 'muted result-count' },
          `${fmtCount(data.total)} reported ${text ? 'matches' : plural(s.unit, data.total)}. Showing ${items.length}.`) : null,
        items.length ? el('ol', { class: 'results', 'data-key-list': true }, items.map((item) => resultRow(item,
          href(sourcePath(sid), { ...params, item: item.id }), params.item === item.id)))
          : el('p', { class: 'muted' }, text ? 'No match in the returned results.' : data.folders?.length
            ? s.lazy ? 'Choose a namespace under this source in the Sources menu. No records load until you select a load action.'
              : 'Choose a folder under this source in the Sources menu to read its entries.'
            : data.partial ? 'This partial read returned no entries.' : 'This folder is empty.'),
        data.more && !items.length ? el('p', { class: 'notice' }, 'The source reports more entries but returned no page. Try reading it again.') : null,
        !text && data.more && items.length ? el('a', { class: 'more', href: href(sourcePath(sid), {
          path, offset: (data.offset ?? 0) + items.length,
        }) }, 'Next page') : null,
        text && (data.more || data.total > items.length) ? el('p', { class: 'note' }, 'More matches exist. Narrow the search to read different matches.') : null,
        !text && data.offset ? el('a', { class: 'more', href: href(sourcePath(sid), {
          path, offset: Math.max(0, data.offset - (data.pageSize ?? 200)),
        }) }, 'Previous page') : null,
      ]);
    markSelection(state.route);
    announce(`${s.name}: ${items.length} entries shown.`);
  } catch (error) {
    if (current(id)) { list.setAttribute('aria-busy', 'false'); put(list, errorBox(error, `Reading ${s.name}`)); }
  }
}

// Approve and Reject for a proposed record. Each needs a second click inside 6 seconds.
function reviewTools(container, sid, itemId, actions, id) {
  const labels = { approve: 'Approve', reject: 'Reject' };
  const note = el('p', { class: 'muted review-note', role: 'status' },
    'A decision moves this record. Approve puts it into the shared tree; Reject puts it into the rejected tree.');
  const buttons = actions.filter((a) => Object.hasOwn(labels, a)).map((decision) => {
    let armed = 0;
    const button = el('button', { type: 'button', class: `review review-${decision}`, onclick: async () => {
      if (Date.now() - armed > 6000) {
        armed = Date.now();
        button.textContent = `Confirm: ${labels[decision].toLowerCase()}`;
        setTimeout(() => { if (armed && Date.now() - armed >= 6000) { armed = 0; button.textContent = labels[decision]; } }, 6100);
        return;
      }
      armed = 0;
      for (const b of buttons) b.disabled = true;
      note.textContent = 'Moving the record…';
      try {
        const request = reviewRequest(sid, itemId, decision);
        const done = await api(request.path, request.init);
        if (id !== state.readerId) return;
        announce(`The record is now in ${done.to}.`);
        put(container, el('div', { class: 'reader' },
          el('p', { class: 'notice', role: 'status' }, `${decision === 'approve' ? 'Approved' : 'Rejected'}. The record is now in ${done.to}.`),
          el('a', { class: 'quiet close', href: href(state.route.path, withoutReader(state.route.params)) }, 'Back to results')));
        // The list behind the reader holds the moved record; the next route reads it again.
        state.viewKey = null;
        // The rail shows the new counts of the two namespaces.
        if (source(sid)) loadFolders(source(sid), '').catch(() => {});
      } catch (error) {
        if (id !== state.readerId) return;
        for (const b of buttons) { b.disabled = false; }
        button.textContent = labels[decision];
        note.textContent = `The record did not move. ${error.message}`;
      }
    } }, labels[decision]);
    return button;
  });
  return el('section', { class: 'review-tools', 'aria-labelledby': 'review-h' },
    el('h3', { id: 'review-h' }, 'Review'), el('div', { class: 'review-buttons' }, buttons), note);
}

async function openReader(container, sid, itemId, id) {
  const r = state.route;
  const close = el('a', { class: 'quiet close', href: href(r.path, withoutReader(r.params)) }, 'Back to results');
  put(container, el('div', { class: 'reader' }, close, loading('Opening the entry…')));
  close.focus({ preventScroll: true });
  // The path bar names the entry at once when the list holds it; the reply gives the name in each other case.
  const listed = Array.from(main.querySelectorAll('.item-link')).find((a) => a.dataset.item === itemId && a.dataset.source === sid);
  state.entry = { sid, id: itemId, title: state.entry?.title ?? listed?.querySelector('.item-title')?.textContent ?? null };
  paintPath();
  let data;
  try { data = await api(`api/sources/${encodeURIComponent(sid)}/item${q({ id: itemId })}`); }
  catch (error) {
    if (id === state.readerId) {
      const focused = document.activeElement === close;
      put(container, el('div', { class: 'reader' }, close, errorBox(error, 'Opening the entry')));
      if (focused) close.focus({ preventScroll: true });
    }
    return;
  }
  if (id !== state.readerId) return;
  const s = source(sid);
  const body = el('div', { class: 'reader-body' });
  let raw = false;
  const paint = () => put(body, raw ? el('pre', { class: 'raw' }, data.body)
    : data.format === 'markdown' ? renderMarkdown(data.body) : renderText(data.body));
  paint();
  const rawButton = el('button', { type: 'button', class: 'quiet', 'aria-pressed': 'false', onclick: () => {
    raw = !raw;
    rawButton.setAttribute('aria-pressed', String(raw));
    rawButton.textContent = raw ? 'Show formatted' : 'Show raw text';
    paint();
  } }, 'Show raw text');
  const copyButton = el('button', { type: 'button', class: 'quiet', onclick: async () => {
    try { await navigator.clipboard.writeText(data.body); announce('The text is on the clipboard.'); copyButton.textContent = 'Copied'; }
    catch { copyButton.textContent = 'Copy is not available'; }
  } }, 'Copy text');
  const item = data.item;
  state.entry = { sid, id: itemId, title: item.title };
  paintPath();
  const focused = document.activeElement === close;
  put(container, el('article', { class: `reader ${srcClass(s)}`, 'aria-labelledby': 'reader-title' },
    el('div', { class: 'reader-tools' }, close, rawButton, copyButton),
    el('p', { class: 'reader-kicker' }, sourceName(sid), item.scope ? el('span', { class: 'scope', title: item.scope }, item.scope) : null),
    el('h2', { id: 'reader-title', tabindex: '-1' }, item.title),
    el('p', { class: 'item-meta' }, dateNode(item.date, item.dateLabel), item.dateLabel ?? ''),
    data.actions?.length ? reviewTools(container, sid, itemId, data.actions, id) : null,
    el('section', { class: 'service-text', 'aria-label': 'Text of the source' }, body),
    el('section', { class: 'service-meta', 'aria-labelledby': 'meta-h' },
      el('h3', { id: 'meta-h' }, 'Metadata of the source'),
      data.meta?.length ? el('dl', {}, data.meta.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, String(value))]))
        : el('p', { class: 'muted' }, 'No metadata supplied.')),
    el('section', { class: 'app-labels', 'aria-labelledby': 'labels-h' },
      el('h3', { id: 'labels-h' }, 'Labels of this app'),
      el('dl', {}, el('dt', {}, 'Kind'), el('dd', {}, item.kind || 'Not known'),
        el('dt', {}, 'Date shown'), el('dd', {}, item.dateLabel || 'None'),
        el('dt', {}, 'Native id'), el('dd', { class: 'mono' }, data.native ?? item.id)),
      el('p', { class: 'muted' }, 'The app derives these labels. They are not facts of the source.'))));
  if (focused) close.focus({ preventScroll: true });
}

async function start() {
  put(main, loading('Reading the list of sources…'));
  try {
    const data = await api('api/sources');
    state.sources = grouped(data.sources);
  } catch (error) {
    put(main, errorBox(error, 'Reading the list of sources'),
      el('button', { type: 'button', onclick: start }, 'Try again'));
    return;
  }
  await route();
}
start();
