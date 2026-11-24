import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { create, parseLs } from '../lib/adapters/okknow.mjs';
import { LocalIndex } from '../lib/localindex.mjs';

const samples = JSON.parse(await readFile(new URL('../sample/okknow.json', import.meta.url), 'utf8')).docs;
const docName = (doc) => doc.meta.find(([key]) => key === 'Document')[1];
const markdown = (doc) => [
  '---', `title: ${doc.title}`, `type: ${doc.kind}`, `updated: ${doc.date}`,
  `tags: [${(doc.tags ?? []).join(', ')}]`, '---', doc.body,
].join('\n');
const pair = ['sample-reader', 'sample-only'].join(':');
const expectedAuth = `Basic ${Buffer.from(pair).toString('base64')}`;
const skipped = ['.ok', '.git', '.pi', 'node_modules', 'assets', '.obsidian'];
const countPipe = 'find . -type f -name "*.md" | cut -d/ -f2 | sort | uniq -c';
const rootListing = [
  'Warning: the sample index is still warming.',
  'total 8',
  ...['projects', 'inbox', 'research', 'wiki', ...skipped].map((name) => `drwxr-xr-x 2 sample sample 4096 Nov 6 10:00 ${name}/`),
  '-rw-r--r-- 1 sample sample 120 Nov 6 10:00 Gateway brief.md',
].join('\n');
let scratch;
let tlsOptions;
let previousCAs;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'okknow-test-'));
  previousCAs = getCACertificates('default');
  const keyFile = path.join(scratch, 'key.pem');
  const certFile = path.join(scratch, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', keyFile, '-out', certFile,
  ], { stdio: 'ignore' });
  tlsOptions = { key: await readFile(keyFile), cert: await readFile(certFile, 'utf8') };
  // Trust only this generated certificate in this isolated test process.
  setDefaultCACertificates([tlsOptions.cert]);
});

after(async () => {
  if (previousCAs) setDefaultCACertificates(previousCAs);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function toolResult(msg) {
  const { name, arguments: args } = msg.params;
  if (name === 'search') {
    return { structuredContent: {
      results: samples.slice(0, 2).map((doc, i) => ({ docName: docName(doc), title: doc.title, kind: 'page', score: 1 - i / 10, signals: ['title'] })),
      resultCount: 2,
    } };
  }
  assert.equal(name, 'exec');
  if (args.command === countPipe) {
    return { structuredContent: { text: ['Warning: sample count', '2 projects', '1 inbox', '1 research', '1 wiki', '1 Gateway brief.md', '1 Gateway handoffs.md', ...skipped.map((name) => `9 ${name}`)].join('\n') } };
  }
  assert.match(args.command, /^ls -l '[A-Za-z0-9._\-/ ]+'$/);
  if (args.command === "ls -l '.'") {
    return { structuredContent: {
      text: rootListing,
      warnings: [{ kind: 'sample' }],
      enrichedPaths: ['projects', 'inbox', 'research', 'wiki'].map((name) => {
        const docs = samples.filter((doc) => doc.folder[0] === name);
        return { path: name, recursiveMdCount: docs.length, mostRecentMd: {
          path: `${docName(docs[0])}.md`, title: docs[0].title, updatedAt: docs[0].date,
          mtime: '2001-01-01T00:00:00Z', modified: '2002-01-01T00:00:00Z',
        } };
      }).concat(skipped.map((name) => ({ path: name, mostRecentMd: { path: `${name}/brief.md`, updatedAt: '2099-01-01T00:00:00Z' } }))),
    } };
  }
  return { structuredContent: {
    text: '-rw-r--r-- 1 sample sample 180 Nov 6 2026 brief.md\n-rw-r--r-- 1 sample sample 120 Nov 4 2026 handoffs.md',
    enrichedPaths: samples.slice(0, 2).map((doc) => ({ path: `${docName(doc)}.md`, title: doc.title, tags: doc.tags, frontmatter: { type: doc.kind, description: doc.title } })),
  } };
}

async function stub(t, { transport = 'json', respond } = {}) {
  const requests = [];
  const handlerErrors = [];
  let session = 0;
  const server = https.createServer(tlsOptions, async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const msg = body ? JSON.parse(body) : null;
      const request = { method: req.method, url: req.url, headers: req.headers, msg };
      requests.push(request);
      assert.equal(req.headers.authorization, expectedAuth);
      if (respond && await respond(request, res)) return;
      if (req.url.startsWith('/api/document?')) {
        assert.equal(req.method, 'GET');
        const name = new URL(req.url, 'https://example.invalid').searchParams.get('docName');
        const doc = samples.find((sample) => docName(sample) === name);
        res.writeHead(doc ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(doc ? { docName: name, content: markdown(doc) } : {}));
        return;
      }
      assert.equal(req.url, '/mcp');
      if (req.method === 'DELETE') {
        assert.ok(req.headers['mcp-session-id']);
        res.writeHead(204).end();
        return;
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(req.headers.accept, 'application/json, text/event-stream');
      if (msg.method === 'notifications/initialized') {
        assert.equal(msg.id, undefined);
        assert.ok(req.headers['mcp-session-id']);
        res.writeHead(202).end();
        return;
      }
      let result;
      if (msg.method === 'initialize') {
        assert.equal(req.headers['mcp-session-id'], undefined);
        assert.equal(msg.params.protocolVersion, '2025-06-18');
        res.setHeader('mcp-session-id', `sample-session-${++session}`);
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sample', version: '1' } };
      } else {
        assert.equal(msg.method, 'tools/call');
        assert.ok(req.headers['mcp-session-id']);
        result = toolResult(msg);
      }
      const reply = { jsonrpc: '2.0', id: msg.id, result };
      if (transport === 'sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': sample heartbeat\r\n\r\n');
        res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n');
        const lines = JSON.stringify(reply, null, 2).split('\n').map((line) => `data: ${line}`).join('\r\n');
        const wire = `event: message\r\n${lines}\r\n\r\n`;
        res.write(wire.slice(0, 23));
        res.write(wire.slice(23));
        // The stream stays open. A matching reply must finish the read.
        res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    } catch (err) {
      handlerErrors.push(err);
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(handlerErrors, []);
  });
  const origin = `https://127.0.0.1:${server.address().port}`;
  let credentialReads = 0;
  const adapter = (config = {}) => create({ id: 'ok-test', origin, credentialFile: 'sample-credential', timeoutMs: 1000, ...config }, {
    readSecret(file) {
      assert.equal(file, 'sample-credential');
      credentialReads += 1;
      return pair;
    },
  });
  return { requests, origin, adapter, get credentialReads() { return credentialReads; } };
}

function assertSessions(requests) {
  const mcp = requests.filter((req) => req.url === '/mcp');
  assert.equal(mcp.length % 4, 0);
  for (let i = 0; i < mcp.length; i += 4) {
    const group = mcp.slice(i, i + 4);
    assert.deepEqual(group.map((req) => req.msg?.method ?? req.method), ['initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
    const sid = group[1].headers['mcp-session-id'];
    assert.ok(sid);
    assert.deepEqual(group.slice(1).map((req) => req.headers['mcp-session-id']), [sid, sid, sid]);
  }
}

for (const transport of ['json', 'sse']) {
  test(`${transport}: all HTTP operations use only allowed reads and close each session`, async (t) => {
    const s = await stub(t, { transport });
    const a = s.adapter();
    assert.equal((await a.status()).state, 'ok');
    const overview = await a.overview();
    assert.equal(overview.total, 7);
    assert.deepEqual(overview.facets, [
      { path: 'projects', label: 'projects', count: 2 }, { path: '', label: 'Top level', count: 2 },
      ...['inbox', 'research', 'wiki'].map((name) => ({ path: name, label: name, count: 1 })),
    ]);
    const before = s.requests.length;
    assert.deepEqual(await a.overview(), overview);
    assert.equal(s.requests.length, before, 'counts use the existing refresh cache');
    const root = await a.browse();
    assert.deepEqual(root.folders.map((folder) => [folder.path, folder.count]), [['projects', 2], ['inbox', 1], ['research', 1], ['wiki', 1]]);
    assert.equal(root.items[0].id, 'Gateway brief');
    const folder = await a.browse({ path: 'projects/gateway/' });
    assert.equal(folder.items[0].title, samples[0].title);
    assert.equal(folder.items[0].kind, samples[0].kind);
    assert.deepEqual(folder.items[0].tags, samples[0].tags);
    assert.equal(folder.items[0].id, docName(samples[0]));
    assert.deepEqual(folder.crumbs.map((crumb) => crumb.path), ['', 'projects', 'projects/gateway']);
    await a.browse({ path: 'projects/Gateway brief' });
    const search = await a.search('gateway; $(echo sample)', { limit: 999 });
    assert.equal(search.total, 2);
    assert.deepEqual(search.items.map((item) => item.id), samples.slice(0, 2).map(docName));
    assert.equal(search.items[0].score, 1);
    const recent = await a.recent(2);
    assert.deepEqual(recent.map((item) => [item.id, item.date, item.dateLabel]), [
      [docName(samples[2]), new Date(samples[2].date).toISOString(), 'updated'],
      [docName(samples[0]), new Date(samples[0].date).toISOString(), 'updated'],
    ]);
    const doc = await a.get(docName(samples[0]));
    assert.equal(doc.body, samples[0].body);
    assert.equal(doc.item.title, samples[0].title);
    assert.equal(doc.item.kind, samples[0].kind);
    assert.equal(doc.native, docName(samples[0]));
    assert.equal(doc.format, 'markdown');
    assert.ok(doc.meta.some(([key, value]) => key === 'Document' && value === docName(samples[0])));
    assert.equal(await a.get('projects/gateway/missing'), null);
    assert.equal(s.credentialReads, 1);
    const calls = s.requests.filter((req) => req.msg?.method === 'tools/call').map((req) => req.msg.params);
    assert.deepEqual(calls, [
      { name: 'exec', arguments: { command: "ls -l '.'" } },
      { name: 'exec', arguments: { command: countPipe } },
      { name: 'exec', arguments: { command: "ls -l '.'" } },
      { name: 'exec', arguments: { command: "ls -l 'projects/gateway'" } },
      { name: 'exec', arguments: { command: "ls -l 'projects/Gateway brief'" } },
      { name: 'search', arguments: { query: 'gateway; $(echo sample)', limit: 100, scopes: ['page', 'content'] } },
      { name: 'exec', arguments: { command: "ls -l '.'" } },
    ]);
    assertSessions(s.requests);
    assert.equal(s.requests.filter((req) => req.method === 'GET').length, 2);
  });
}

test('unsafe paths fail before a request or a credential read', async (t) => {
  const s = await stub(t);
  const a = s.adapter();
  for (const value of ["folder/'page", 'folder/"page', '..', '../page', 'folder/../page', 'page;', 'page$', 'page`', 'page\n', 'page\r', 'page\r\n', 'line\nbreak', '/page', '-la', 'page\\name']) {
    await assert.rejects(a.browse({ path: value }), { code: 'bad_path' });
    await assert.rejects(a.get(value), { code: 'bad_path' });
    await assert.rejects(a.search('gateway', { path: value }), { code: 'bad_path' });
  }
  assert.equal(s.requests.length, 0);
  assert.equal(s.credentialReads, 0);
});

test('only an HTTPS origin without credentials, path, query or fragment is accepted', () => {
  for (const origin of ['http://127.0.0.1:4317', 'http://example.invalid', 'file:///tmp/pages', 'not a URL', 'https://', 'https://example.invalid/path', 'https://example.invalid/?query=1', 'https://example.invalid/#fragment', 'https://sample:sample@example.invalid']) {
    assert.throws(() => create({ id: 'ok-test', origin }, { readSecret() { assert.fail('no credential read'); } }), /origin must use https/);
  }
});

test('a malformed credential fails before any request', async (t) => {
  const s = await stub(t);
  const a = create({ id: 'ok-test', origin: s.origin }, { readSecret: () => 'missing-separator' });
  await assert.rejects(a.status(), { code: 'credentials' });
  assert.equal(s.requests.length, 0);
});

for (const phase of ['initialize', 'notifications/initialized', 'tools/call', 'document']) {
  for (const status of [401, 403, 500]) {
    test(`${phase}: HTTP ${status} reports ${status === 500 ? 'failed' : 'denied'}`, async (t) => {
      const s = await stub(t, { respond(req, res) {
        if (req.msg?.method !== phase && !(phase === 'document' && req.method === 'GET')) return false;
        res.writeHead(status).end('sample response');
        return true;
      } });
      const a = s.adapter();
      await assert.rejects(phase === 'document' ? a.get(docName(samples[0])) : a.status(), { code: status === 500 ? 'failed' : 'denied' });
      if (['notifications/initialized', 'tools/call'].includes(phase)) assert.equal(s.requests.at(-1).method, 'DELETE');
    });
  }
}

for (const phase of ['tools/call', 'document']) {
  test(`${phase}: redirects never reach the redirect target`, async (t) => {
    let redirected = 0;
    const target = await stub(t, { respond() { redirected += 1; return false; } });
    const s = await stub(t, { respond(req, res) {
      if (req.msg?.method !== phase && !(phase === 'document' && req.method === 'GET')) return false;
      res.writeHead(307, { Location: `${target.origin}/redirect-target` }).end();
      return true;
    } });
    const a = s.adapter();
    await assert.rejects(phase === 'document' ? a.get(docName(samples[0])) : a.status(), { code: 'unreachable' });
    assert.equal(redirected, 0);
    if (phase === 'tools/call') assert.equal(s.requests.at(-1).method, 'DELETE');
  });
}

for (const phase of ['initialize', 'tools/call', 'document']) {
  for (const stalled of ['headers', 'body']) {
    test(`${phase}: stalled ${stalled} reports timeout`, async (t) => {
      const s = await stub(t, { respond(req, res) {
        if (req.msg?.method !== phase && !(phase === 'document' && req.method === 'GET')) return false;
        if (phase === 'initialize') res.setHeader('mcp-session-id', 'sample-timeout');
        if (stalled === 'body') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{');
        }
        return true;
      } });
      const a = s.adapter({ timeoutMs: 100 });
      await assert.rejects(phase === 'document' ? a.get(docName(samples[0])) : a.status(), { code: 'timeout', status: 504 });
      if (phase === 'tools/call' || (phase === 'initialize' && stalled === 'body')) assert.equal(s.requests.at(-1).method, 'DELETE');
    });
  }
}

test('an SSE stream without a matching reply times out and closes the session', async (t) => {
  const s = await stub(t, { respond(req, res) {
    if (req.msg?.method !== 'tools/call') return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
    return true;
  } });
  await assert.rejects(s.adapter({ timeoutMs: 100 }).status(), { code: 'timeout' });
  assert.equal(s.requests.at(-1).method, 'DELETE');
});

for (const [name, result, code] of [
  ['tool error', { result: { isError: true, content: [{ type: 'text', text: 'sample private detail' }] } }, 'failed'],
  ['RPC error', { error: { code: -32603, message: 'sample private detail' } }, 'failed'],
  ['missing result', {}, 'bad_reply'],
  ['scalar result', { result: 2 }, 'bad_reply'],
  ['array result', { result: [] }, 'bad_reply'],
  ['wrong response id', { id: 99, result: {} }, 'bad_reply'],
]) {
  test(`${name}: reports a safe error and closes the session`, async (t) => {
    const s = await stub(t, { respond(req, res) {
      if (req.msg?.method !== 'tools/call') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: req.msg.id, ...result }));
      return true;
    } });
    await assert.rejects(s.adapter().status(), (err) => {
      assert.equal(err.code, code);
      assert.ok(!err.message.includes('sample private detail'));
      return true;
    });
    assert.equal(s.requests.at(-1).method, 'DELETE');
  });
}

for (const transport of ['json', 'sse']) {
  test(`${transport}: invalid JSON reports bad_reply`, async (t) => {
    const s = await stub(t, { respond(req, res) {
      if (req.msg?.method !== 'tools/call') return false;
      res.writeHead(200, { 'Content-Type': transport === 'sse' ? 'text/event-stream' : 'application/json' });
      res.end(transport === 'sse' ? 'data: invalid\n\n' : 'invalid');
      return true;
    } });
    await assert.rejects(s.adapter().status(), { code: 'bad_reply' });
    assert.equal(s.requests.at(-1).method, 'DELETE');
  });
}

test('an SSE stream that ends without a reply reports bad_reply', async (t) => {
  const s = await stub(t, { respond(req, res) {
    if (req.msg?.method !== 'tools/call') return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(': sample heartbeat\n\n');
    return true;
  } });
  await assert.rejects(s.adapter().status(), { code: 'bad_reply' });
  assert.equal(s.requests.at(-1).method, 'DELETE');
});

test('text-only tool results still provide directory listings', async (t) => {
  const s = await stub(t, { respond(req, res) {
    if (req.msg?.method !== 'tools/call') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.msg.id, result: { content: [{ type: 'text', text: rootListing }] } }));
    return true;
  } });
  assert.equal((await s.adapter().browse()).items[0].id, 'Gateway brief');
});

test('the cold search index note survives the result mapping', async (t) => {
  const s = await stub(t, { respond(req, res) {
    if (req.msg?.method !== 'tools/call') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.msg.id, result: { structuredContent: { ready: false, results: [], resultCount: 0 } } }));
    return true;
  } });
  const found = await s.adapter().search('gateway');
  assert.equal(found.total, 0);
  assert.match(found.note, /incomplete/);
});

for (const cleanup of ['denied', 'stalled']) {
  test(`session cleanup ${cleanup} does not replace a successful result`, async (t) => {
    const s = await stub(t, { respond(req, res) {
      if (req.method !== 'DELETE') return false;
      if (cleanup === 'denied') res.writeHead(403).end();
      return true;
    } });
    assert.equal((await s.adapter({ timeoutMs: 100 }).status()).state, 'ok');
    assert.equal(s.requests.at(-1).method, 'DELETE');
  });
}

for (const [name, reply] of [
  ['mismatched name', { docName: 'projects/gateway/handoffs', content: samples[1].body }],
  ['missing name', { content: samples[0].body }],
  ['null JSON', null],
]) {
  test(`document API: ${name} reports bad_reply`, async (t) => {
    const s = await stub(t, { respond(req, res) {
      if (req.method !== 'GET') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      return true;
    } });
    await assert.rejects(s.adapter().get(docName(samples[0])), { code: 'bad_reply' });
    assert.equal(s.requests.length, 1);
  });
}

test('document API: invalid JSON reports bad_reply', async (t) => {
  const s = await stub(t, { respond(req, res) {
    if (req.method !== 'GET') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('invalid');
    return true;
  } });
  await assert.rejects(s.adapter().get(docName(samples[0])), { code: 'bad_reply' });
});

test('parseLs supports time, year, directories, spaces and leading warnings', () => {
  assert.deepEqual(parseLs([
    'Warning: sample listing', 'total 4',
    'drwxr-xr-x 2 sample sample 4096 Nov 6 10:00 Gateway folder/',
    '-rw-r--r-- 1 sample sample 180 Nov 4 2025 Gateway brief.md',
    '-rw-r--r-- 1 sample sample 120 Nov 6 09:10 Gateway handoffs.md',
    'drwxr-xr-x 2 sample sample 4096 Nov 6 10:00 .',
    'drwxr-xr-x 2 sample sample 4096 Nov 6 10:00 ../',
    'lrwxrwxrwx 1 sample sample 9 Nov 6 10:00 link -> brief.md',
  ].join('\n'), new Date('2026-11-07T00:00:00Z')), [
    { name: 'Gateway folder', dir: true, size: 4096, date: '2026-11-06T10:00:00.000Z' },
    { name: 'Gateway brief.md', dir: false, size: 180, date: '2025-11-04T00:00:00.000Z' },
    { name: 'Gateway handoffs.md', dir: false, size: 120, date: '2026-11-06T09:10:00.000Z' },
  ]);
});

test('parseLs places December before a January clock and keeps an explicit year', () => {
  const lines = [
    '-rw-r--r-- 1 sample sample 180 Dec 31 23:59 Gateway brief.md',
    '-rw-r--r-- 1 sample sample 120 Jan 1 00:01 Gateway handoffs.md',
    '-rw-r--r-- 1 sample sample 120 Dec 31 2024 Triage queue.md',
  ].join('\n');
  assert.deepEqual(parseLs(lines, new Date('2027-01-01T00:02:00Z')).map((entry) => entry.date), [
    '2026-12-31T23:59:00.000Z', '2027-01-01T00:01:00.000Z', '2024-12-31T00:00:00.000Z',
  ]);
  assert.equal(parseLs(lines, new Date('2026-12-31T23:59:59Z'))[1].date, '2026-01-01T00:01:00.000Z');
});

test('files mode indexes only temporary synthetic pages without changing them', async (t) => {
  const root = await mkdtemp(path.join(scratch, 'pages-'));
  const files = [];
  for (const doc of samples) {
    const filename = path.join(root, `${docName(doc)}.md`);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, markdown(doc));
    await utimes(filename, new Date(doc.date), new Date(doc.date));
    files.push([filename, await readFile(filename, 'utf8')]);
  }
  for (const name of skipped) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'brief.md'), samples[0].body);
  }
  await writeFile(path.join(root, 'Gateway brief.mdx'), samples[0].body);
  await symlink(files[0][0], path.join(root, 'brief-link.md'));
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let denied = false;
  const access = fs.access;
  const mock = t.mock.method(fs, 'access', async (file, mode) => {
    if (denied && file === files[0][0]) throw Object.assign(new Error(file), { code: 'EACCES' });
    return access(file, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const s = await stub(t);
  const a = s.adapter({ access: 'files', path: root, refreshSeconds: 1 });
  await a.warm();
  assert.equal((await a.status()).state, 'ok');
  assert.equal((await a.overview()).total, 6);
  assert.deepEqual((await a.browse()).folders.map((folder) => folder.path), ['inbox', 'projects', 'research', 'wiki']);
  assert.equal((await a.browse({ path: 'projects/gateway' })).items.length, 2);
  assert.equal((await a.search('gateway', { path: 'projects' })).total, 2);
  assert.equal((await a.get(docName(samples[0]))).body, samples[0].body);
  assert.equal(await a.get('../brief'), null);
  assert.equal((await a.recent(1)).length, 1);
  for (const [filename, original] of files) assert.equal(await readFile(filename, 'utf8'), original);
  let reload;
  const ensure = LocalIndex.prototype.ensure;
  t.mock.method(LocalIndex.prototype, 'ensure', function () {
    const result = ensure.call(this);
    reload = this.pending;
    return result;
  });
  denied = true;
  now += 1001;
  await a.warm();
  await reload;
  assert.equal(await a.get(docName(samples[0])), null);
  assert.equal((await a.overview()).total, 5);
  assert.equal((await a.get(docName(samples[1]))).body, samples[1].body);
  const status = await a.status();
  assert.equal(status.state, 'ok');
  assert.equal(JSON.stringify(status).includes(files[0][0]), false);
  assert.equal(s.requests.length, 0);
  assert.equal(s.credentialReads, 0);
});

test('files mode reports a missing mount', async () => {
  const a = create({ id: 'ok-test', access: 'files', path: path.join(scratch, 'missing') });
  await assert.rejects(a.status(), { code: 'not_mounted' });
});

test('live check waits for a stack credential', { skip: 'No stack credential. No live request is permitted.' }, () => {});
