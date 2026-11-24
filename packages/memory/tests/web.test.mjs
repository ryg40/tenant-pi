import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { Hub } from '../lib/hub.mjs';
import { SourceError } from '../lib/model.mjs';
import { createHandler } from '../lib/web.mjs';

const auth = { user: 'sample-user', password: 'sample-password' };
const basic = (user = auth.user, password = auth.password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const privateText = '/sample/private/file sample-secret sample-content';

async function fixture(t, { allowedHosts = [], broken = false, sample = false } = {}) {
  const logs = [];
  const hub = new Hub({ sources: [{ id: 'sample', type: 'openviking', mode: sample ? 'sample' : 'live' }] }, {
    timeoutMs: 50,
    log: (line) => logs.push(line),
    factories: { openviking: { create: () => ({
      id: 'sample', type: 'openviking', name: 'Sample', mode: 'live', lazy: false,
      status: async () => ({ state: 'ok', detail: 'Sample ready' }),
      overview: async () => ({ total: 0, newest: null, facets: [] }),
      recent: async () => [],
      search: async () => ({ total: 0, items: [] }),
      browse: async () => { throw new Error(privateText); },
      get: async (id) => {
        if (id === 'sample-missing') return null;
        if (id === 'sample-timeout') return new Promise(() => {});
        if (id === 'sample-unexpected-status') throw new SourceError('failed', privateText, 999);
        throw new SourceError('failed', privateText);
      },
    }) } },
  });
  if (broken) hub.browse = async () => { throw new Error(privateText); };
  const server = createServer(createHandler({ hub, auth, allowedHosts, log: (line) => logs.push(line) }));
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const call = (target, { method = 'GET', authorized = true, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: target, method, setHost: !Object.hasOwn(headers, 'Host'), headers: {
      ...(authorized ? { Authorization: basic() } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: res.headers['content-type']?.startsWith('application/json') && text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { call, logs };
}

function headersAreSafe(reply) {
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  assert.equal(reply.headers['x-frame-options'], 'DENY');
  assert.equal(reply.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin');
  for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(reply.headers['content-security-policy'].includes(rule));
  }
}

function errorShape(reply, code) {
  headersAreSafe(reply);
  assert.equal(reply.json.error.code, code);
  assert.deepEqual(Object.keys(reply.json.error).sort(), ['code', 'message']);
  assert.equal(typeof reply.json.error.message, 'string');
  assert.doesNotMatch(reply.text, /sample-secret|sample-content|\/sample\/private|stack|node_modules|Error:/);
}

test('Basic authentication rejects absent, wrong and malformed credentials', async (t) => {
  const { call } = await fixture(t);
  const headers = [undefined, basic('wrong-user'), basic(auth.user, 'wrong-password'), '', 'Bearer sample', 'Basic !!!', 'Basic', 'Basic dXNlcg==', basic() + '=', basic().slice(0, -1)];
  for (const header of headers) {
    const reply = await call('/api/sources', { authorized: false, headers: header === undefined ? {} : { Authorization: header } });
    assert.equal(reply.status, 401, String(header));
    assert.equal(reply.headers['www-authenticate'], 'Basic realm="tenant-memory", charset="UTF-8"');
    errorShape(reply, 'auth');
  }
  for (const Authorization of [basic(), basic().replace('Basic', 'basic')]) {
    const reply = await call('/api/sources', { headers: { Authorization } });
    assert.equal(reply.status, 200);
    headersAreSafe(reply);
  }
});

test('health does not need authentication but still enforces Host and method', async (t) => {
  const { call } = await fixture(t);
  const reply = await call('/healthz', { authorized: false });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { ok: true });
  headersAreSafe(reply);
  const refused = await call('/healthz', { authorized: false, headers: { Host: 'unlisted.example' } });
  assert.equal(refused.status, 421);
  errorShape(refused, 'host');
  const post = await call('/healthz', { authorized: false, method: 'POST' });
  assert.equal(post.status, 405);
  errorShape(post, 'method');
});

test('Host names are exact and X-Forwarded-Host cannot add or remove permission', async (t) => {
  const { call } = await fixture(t, { allowedHosts: ['memory.example', 'explicit.example:443'] });
  for (const host of ['localhost', 'localhost:1234', '127.0.0.1', '[::1]', '[::1]:1234', 'memory.example', 'MEMORY.EXAMPLE', 'explicit.example:443']) {
    const reply = await call('/api/sources', { headers: { Host: host, 'X-Forwarded-Host': 'unlisted.example' } });
    assert.equal(reply.status, 200, host);
    headersAreSafe(reply);
  }
  for (const host of ['unlisted.example', 'memory.example:443', 'sub.memory.example', 'memory.example.evil', 'memory.example.', 'memory.example@evil.example', 'explicit.example', 'localhost.evil', '127.1', '2130706433']) {
    const reply = await call('/api/sources', { headers: { Host: host, 'X-Forwarded-Host': 'memory.example' } });
    assert.equal(reply.status, 421, host);
    errorShape(reply, 'host');
  }
  const noHost = await call('/api/sources', { headers: { Host: '' } });
  assert.equal(noHost.status, 421);
  errorShape(noHost, 'host');
  const authenticatedProxy = await call('/api/sources', { authorized: false, headers: { Host: 'memory.example', 'X-Authentik-Username': 'sample-user' } });
  assert.equal(authenticatedProxy.status, 401);
});

test('static files and every API success include strict headers', async (t) => {
  const { call } = await fixture(t);
  for (const route of ['/', '/app.js', '/render.js', '/app.css', '/favicon.svg', '/api/sources', '/api/overview?refresh=1', '/api/recent?limit=1', '/api/search?q=sample', '/api/sources/sample/search?q=sample']) {
    const reply = await call(route);
    assert.equal(reply.status, 200, route);
    headersAreSafe(reply);
  }
  const clear = await call('/api/cache/clear', { method: 'POST' });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.cleared, 1);
  headersAreSafe(clear);
});

test('sample browse and item replies keep strict headers and their data shape', async (t) => {
  const { call } = await fixture(t, { sample: true });
  const root = await call('/api/sources/sample/browse');
  assert.equal(root.status, 200);
  headersAreSafe(root);
  assert.equal(root.json.mode, 'sample');
  assert.ok(root.json.folders.length > 0);
  const search = await call('/api/sources/sample/search?q=Alice');
  assert.equal(search.status, 200);
  assert.ok(search.json.items.length > 0);
  const item = await call(`/api/sources/sample/item?id=${encodeURIComponent(search.json.items[0].id)}`);
  assert.equal(item.status, 200);
  headersAreSafe(item);
  assert.equal(item.json.mode, 'sample');
  assert.equal(item.json.item.id, search.json.items[0].id);
  assert.equal(typeof item.json.body, 'string');
  assert.ok(item.json.body.length > 0);
});

test('methods fail with 405 and an Allow header', async (t) => {
  const { call } = await fixture(t);
  for (const [route, method, allow] of [['/api/sources', 'POST', 'GET'], ['/', 'PUT', 'GET'], ['/api/sources/sample/item?id=sample', 'DELETE', 'GET'], ['/api/cache/clear', 'GET', 'POST'], ['/api/cache/clear', 'DELETE', 'POST']]) {
    const reply = await call(route, { method });
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.allow, allow);
    errorShape(reply, 'method');
  }
});

test('invalid parameters and malformed paths give safe 400 responses', async (t) => {
  const { call, logs } = await fixture(t);
  const targets = [
    '/api/search', '/api/search?q=%20', `/api/search?q=${'x'.repeat(501)}`, '/api/search?q=sample&q=second',
    '/api/recent?limit=0', '/api/recent?limit=101', '/api/recent?limit=-1', '/api/recent?limit=1.5',
    '/api/recent?limit=1e1', '/api/recent?limit=0x10', '/api/recent?limit=', '/api/recent?limit=%20', '/api/recent?limit=1&limit=2',
    '/api/overview?refresh=yes', '/api/overview?refresh=0&refresh=1', '/api/search?q=sample&limit=51',
    '/api/sources/sample/browse?offset=-1', '/api/sources/sample/browse?offset=1000001',
    '/api/sources/sample/search', '/api/sources/sample/search?q=sample&limit=101',
    '/api/sources/sample/item', '/api/sources/sample/item?id=', '/api/sources/sample/item?id=sample&id=second',
    '/api/sources/sample/browse?path=one&path=two', '/api/sources/%ZZ/item?id=sample',
    '/api/sources/%FF/item?id=sample', '//[invalid', 'http://[invalid',
  ];
  for (const target of targets) {
    const reply = await call(target);
    assert.equal(reply.status, 400, target);
    errorShape(reply, 'bad_request');
  }
  assert.ok(logs.every((line) => /^GET [a-z-]+ 400 \d+ms$/.test(line)));
});

test('unknown routes, sources and items give consistent safe 404 shapes', async (t) => {
  const { call } = await fixture(t);
  for (const [target, code] of [
    ['/sample-private-route', 'not_found'], ['/api/unknown', 'not_found'],
    ['/api/sources/sample/unknown', 'not_found'], ['/api/sources/missing/browse', 'unknown_source'],
    ['/api/search?q=sample&sources=missing', 'unknown_source'], ['/api/sources/sample/item?id=sample-missing', 'not_found'],
  ]) {
    const reply = await call(target);
    assert.equal(reply.status, 404);
    errorShape(reply, code);
  }
});

test('adapter errors and unexpected handler errors never expose secrets in replies or logs', async (t) => {
  const { call, logs } = await fixture(t);
  for (const target of ['/api/sources/sample/browse', '/api/sources/sample/item?id=sample-private-id', '/api/sources/sample/item?id=sample-unexpected-status']) {
    const reply = await call(target);
    assert.equal(reply.status, 502);
    errorShape(reply, 'failed');
  }
  const timeout = await call('/api/sources/sample/item?id=sample-timeout');
  assert.equal(timeout.status, 504);
  errorShape(timeout, 'timeout');
  const broken = await fixture(t, { broken: true });
  const reply = await broken.call('/api/sources/sample/browse?path=sample-private-path');
  assert.equal(reply.status, 500);
  errorShape(reply, 'failed');
  assert.doesNotMatch([...logs, ...broken.logs].join('\n'), /sample-secret|sample-content|sample-private-id|sample-private-path|\/sample\/private|Error:/);
});

test('access logs contain method, fixed route, status and elapsed time only', async (t) => {
  const { call, logs } = await fixture(t);
  await call('/api/search?q=sample-private-query');
  await call('/api/sources/missing-private-source/item?id=sample-private-id');
  await call('/sample-private-path?content=sample-private-content');
  await call('/api/search?q=sample-private-query', { method: 'POST' });
  assert.equal(logs.length, 4);
  const expected = [['GET', 'search', '200'], ['GET', 'item', '404'], ['GET', 'not-found', '404'], ['POST', 'search', '405']];
  logs.forEach((line, i) => {
    assert.match(line, /^[A-Z]+ [a-z-]+ \d{3} \d+ms$/);
    assert.deepEqual(line.split(' ').slice(0, 3), expected[i]);
  });
  assert.doesNotMatch(logs.join('\n'), /sample-private|missing-private|\?|\/api\//);
});
