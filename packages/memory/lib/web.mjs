// The HTTP surface: Basic authentication, a Host guard, strict headers, the
// JSON API of the hub and the static files of the UI.
//
// Every route except /healthz needs the credential. The log line holds the
// method, the route name, the status and the time; never a query or content.
//
// As a module of the local server (server.mjs --child) the app has no sign-in of
// its own: each request, /healthz too, must carry the secret of this start in the
// header X-Tenant-Artifacts-Parent. Only the parent server knows it, and it adds
// the header itself; a browser never gets it.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicError, SourceError } from './model.mjs';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/render.js', ['render.js', 'text/javascript; charset=utf-8']],
  ['/selection.js', ['selection.js', 'text/javascript; charset=utf-8']],
  ['/rail.js', ['rail.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/logo-openviking.svg', ['logo-openviking.svg', 'image/svg+xml']],
  ['/logo-okknow.svg', ['logo-okknow.svg', 'image/svg+xml']],
  ['/logo-llmwiki.svg', ['logo-llmwiki.svg', 'image/svg+xml']],
  ['/logo-hermes.svg', ['logo-hermes.svg', 'image/svg+xml']],
  ['/logo-agentcore.svg', ['logo-agentcore.svg', 'image/svg+xml']],
]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createHandler({ hub, auth, parentSecret = null, allowedHosts = [], log = () => {} }) {
  const expected = auth ? digest(`${auth.user}:${auth.password}`) : null;
  const parent = parentSecret ? digest(parentSecret) : null;

  function fromParent(req) {
    if (!parent) return true;
    const given = req.headers['x-tenant-artifacts-parent'];
    return typeof given === 'string' && timingSafeEqual(digest(given), parent);
  }
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));

  function hostAllowed(host) {
    if (!host) return false;
    const h = host.toLowerCase();
    if (hosts.has(h)) return true;
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(h);
  }

  function authorized(req) {
    if (!expected) return true;
    const header = req.headers.authorization ?? '';
    const m = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
    if (!m) return false;
    const bytes = Buffer.from(m[1], 'base64');
    if (bytes.toString('base64') !== m[1]) return false;
    const given = digest(bytes.toString('utf8'));
    return timingSafeEqual(given, expected);
  }

  return async function handle(req, res) {
    const started = Date.now();
    let route = 'bad-request';
    setHeaders(res);
    try {
      let url;
      try {
        if (!req.url.startsWith('/') || req.url.startsWith('//') || /%(?![0-9a-f]{2})/i.test(req.url)) throw new Error();
        url = new URL(req.url, 'http://local');
        decodeURIComponent(url.pathname);
      } catch {
        throw new SourceError('bad_request', '', 400);
      }
      route = routeName(url.pathname);
      if (!hostAllowed(req.headers.host)) {
        route = 'host-refused';
        return sendJson(res, 421, { error: { code: 'host', message: 'This Host is not allowed.' } });
      }
      if (!fromParent(req)) {
        route = 'parent-refused';
        return sendJson(res, 401, { error: { code: 'parent', message: 'This module answers only its parent server.' } });
      }
      if (route === 'healthz') {
        if (req.method !== 'GET') throw new SourceError('method', '', 405);
        return sendJson(res, 200, { ok: true });
      }
      if (!authorized(req)) {
        route = 'auth-refused';
        res.setHeader('WWW-Authenticate', 'Basic realm="tenant-memory", charset="UTF-8"');
        return sendJson(res, 401, { error: { code: 'auth', message: 'Sign in.' } });
      }
      if (route === 'static' && req.method !== 'GET') throw new SourceError('method', '', 405);
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        route = 'static';
        const [file, type] = STATIC.get(url.pathname);
        const body = await readFile(path.join(UI_DIR, file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(body);
      }
      if (!url.pathname.startsWith('/api/')) {
        route = 'not-found';
        return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
      }
      const result = await api(req, url, hub);
      route = result.route;
      return sendJson(res, 200, { mode: hub.mode, serverTime: new Date().toISOString(), ...result.body });
    } catch (err) {
      const status = err instanceof SourceError && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
        ? err.status : 500;
      if (status === 405) res.setHeader('Allow', ['cache-clear', 'review'].includes(route) ? 'POST' : 'GET');
      return sendJson(res, status, { mode: hub.mode, error: publicError(err) });
    } finally {
      const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'].includes(req.method)
        ? req.method : 'OTHER';
      log(`${method} ${route} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}

function routeName(p) {
  if (p === '/healthz') return 'healthz';
  if (STATIC.has(p)) return 'static';
  const routes = new Map([
    ['/api/sources', 'sources'], ['/api/overview', 'overview'], ['/api/recent', 'recent'],
    ['/api/search', 'search'], ['/api/cache/clear', 'cache-clear'],
  ]);
  if (routes.has(p)) return routes.get(p);
  const match = p.match(/^\/api\/sources\/[^/]+\/(browse|search|item|review)$/);
  if (match) return match[1] === 'search' ? 'source-search' : match[1];
  return 'not-found';
}

async function api(req, url, hub) {
  const p = url.pathname;
  const q = url.searchParams;
  const parts = p.split('/').filter(Boolean); // ['api', ...]
  if (req.method === 'POST' && p === '/api/cache/clear') {
    return { route: 'cache-clear', body: { cleared: hub.clear() } };
  }
  if (parts[1] === 'sources' && parts.length === 4 && parts[3] === 'review') {
    if (req.method !== 'POST') throw new SourceError('method', '', 405);
    reviewGuard(req);
    const { id, decision } = await reviewBody(req);
    return { route: 'review', body: await hub.review(decodeURIComponent(parts[2]), id, decision) };
  }
  if (req.method !== 'GET' || p === '/api/cache/clear') throw new SourceError('method', 'Only GET reads data.', 405);
  if (p === '/api/sources') return { route: 'sources', body: { sources: hub.sources() } };
  if (p === '/api/overview') {
    const refresh = param(q, 'refresh');
    if (refresh !== null && !['0', '1'].includes(refresh)) throw new SourceError('bad_request', '', 400);
    return { route: 'overview', body: { sources: await hub.overview({ refresh: refresh === '1' }) } };
  }
  if (p === '/api/recent') return { route: 'recent', body: { items: await hub.recent(intParam(q, 'limit', 30, 1, 100)) } };
  if (p === '/api/search') {
    const query = textParam(q, 'q');
    const sources = (param(q, 'sources') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(hub.sources().map((s) => s.id));
    if (sources.some((id) => !known.has(id))) throw new SourceError('unknown_source', '', 404);
    return {
      route: 'search',
      body: { query, results: await hub.search(query, { sources, limit: intParam(q, 'limit', 10, 1, 50) }) },
    };
  }
  if (parts[1] === 'sources' && parts.length === 4) {
    const id = decodeURIComponent(parts[2]);
    if (parts[3] === 'browse') {
      return { route: 'browse', body: await hub.browse(id, { path: param(q, 'path') ?? '', offset: intParam(q, 'offset', 0, 0, 1e6) }) };
    }
    if (parts[3] === 'search') {
      const query = textParam(q, 'q');
      return { route: 'source-search', body: { query, ...(await hub.searchOne(id, query, { limit: intParam(q, 'limit', 50, 1, 100), path: param(q, 'path') ?? '' })) } };
    }
    if (parts[3] === 'item') {
      const itemId = param(q, 'id');
      if (!itemId) throw new SourceError('bad_request', 'Give the id of the item.', 400);
      return { route: 'item', body: await hub.item(id, itemId) };
    }
  }
  throw new SourceError('not_found', 'Not found.', 404);
}

// A browser sends the Basic credential by itself, also for a request that another
// site starts. The write route therefore needs a JSON content type, a custom
// header and an Origin that equals the Host. Another site cannot set these.
function reviewGuard(req) {
  const origin = req.headers.origin ?? '';
  const site = req.headers['sec-fetch-site'];
  const sameOrigin = /^https?:\/\/[^/]+$/.test(origin) && origin.replace(/^https?:\/\//, '').toLowerCase() === String(req.headers.host).toLowerCase();
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['x-tenant-memory-action'] !== 'review'
      || !sameOrigin || (site !== undefined && site !== 'same-origin')) {
    throw new SourceError('review_off', '', 403);
  }
}

async function reviewBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new SourceError('bad_request', '', 400);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SourceError('bad_request', '', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'decision,id'
      || typeof body.id !== 'string' || !body.id || body.id.length > 2048 || !['approve', 'reject'].includes(body.decision)) {
    throw new SourceError('bad_request', '', 400);
  }
  return body;
}

function param(q, name) {
  if (q.getAll(name).length > 1) throw new SourceError('bad_request', '', 400);
  return q.get(name);
}

function textParam(q, name) {
  const v = (param(q, name) ?? '').trim();
  if (!v) throw new SourceError('bad_request', `Give the parameter ${name}.`, 400);
  if (v.length > 500) throw new SourceError('bad_request', `The parameter ${name} is longer than 500 characters.`, 400);
  return v;
}

function intParam(q, name, dflt, min, max) {
  const raw = param(q, name);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) throw new SourceError('bad_request', `The parameter ${name} must be an integer from ${min} to ${max}.`, 400);
  return n;
}

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest();
}
