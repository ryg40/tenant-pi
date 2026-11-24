import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { create, MAX_TREE_CALLS } from '../lib/adapters/openviking.mjs';
import { readSecret, validateConfig } from '../lib/config.mjs';
import { SourceError } from '../lib/model.mjs';

const ROOT = 'viking://user/sample/memories/';
const SECOND = 'viking://user/sample-two/memories/';
const KEY = 'synthetic-test-key';
const sample = JSON.parse(readFileSync(new URL('../sample/openviking.json', import.meta.url), 'utf8'));
const files = sample.docs.map((doc) => ({
  uri: doc.meta.find(([key]) => key === 'URI')[1],
  name: doc.meta.find(([key]) => key === 'URI')[1].split('/').at(-1),
  isDir: false,
  modTime: doc.date,
  abstract: doc.body,
  body: doc.body,
}));
const PROFILE = files[0].uri;
const directories = [...new Set(files.flatMap((file) => {
  const parts = file.uri.slice(ROOT.length).split('/');
  return parts.slice(0, -1).map((_, i) => ROOT + parts.slice(0, i + 1).join('/') + '/');
}))].map((uri) => ({ uri, name: uri.split('/').at(-2), isDir: true }));
const sidecars = ['.abstract.md', '.overview.md', '.hidden/note.md'].map((name) => ({
  uri: ROOT + name, name, isDir: false, abstract: 'Synthetic hidden summary',
}));
const foreign = { ...files[0], uri: SECOND + 'profile.md' };
const placeholder = '{{ov_privacy:sample:viking://~/privacy/credential/example#/values/token}}';
const longPlaceholder = `{{ov_privacy:sample:viking://~/privacy/${'x'.repeat(300)}#/values/token}}`;

function config(baseUrl, extra = {}) {
  return {
    id: 'openviking-sample', type: 'openviking', mode: 'live',
    name: 'OpenViking \u00b7 sample', baseUrl, apiKeyFile: '/run/secrets/openviking-sample',
    roots: [{ uri: ROOT, label: 'sample memories' }], ...extra,
  };
}

async function stub(t, { override, cfg = {}, readSecret } = {}) {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url, 'http://stub.invalid');
      const request = {
        route: `${req.method} ${url.pathname}`, query: url.searchParams,
        body: raw ? JSON.parse(raw) : undefined, key: req.headers['x-api-key'],
      };
      requests.push(request);
      const send = (body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (override && await override(request, send, res)) return;
      switch (request.route) {
        case 'GET /api/v1/fs/ls': {
          const uri = request.query.get('uri');
          const recursive = request.query.get('recursive') === 'true';
          const entries = [...directories, ...files, ...sidecars, foreign].filter((entry) => {
            if (entry === foreign) return true;
            if (!entry.uri.startsWith(uri)) return false;
            return recursive || !entry.uri.slice(uri.length).replace(/\/$/, '').includes('/');
          });
          const offset = Number(request.query.get('offset'));
          send({ status: 'ok', result: entries.slice(offset, offset + 2), has_more: offset + 2 < entries.length });
          return;
        }
        case 'GET /api/v1/fs/stat': {
          const uri = request.query.get('uri');
          const file = files.find((f) => f.uri === uri);
          send({ status: 'ok', result: file ? { ...file, size: Buffer.byteLength(file.body), id: 'synthetic-record' } : { isDir: true } });
          return;
        }
        case 'GET /api/v1/content/read':
          send({ status: 'ok', result: files.find((f) => f.uri === request.query.get('uri'))?.body ?? '' });
          return;
        case 'POST /api/v1/search/find':
          send({ status: 'ok', result: { memories: [
            ...files.map((file, i) => ({ ...file, score: i + 1 })),
            ...sidecars, foreign, ...directories,
          ] } });
          return;
        case 'POST /api/v1/search/grep':
          send({ status: 'ok', result: { matches: [
            { uri: PROFILE, content: 'Synthetic keyword match', line: 1 },
            { uri: PROFILE, content: 'Another synthetic keyword match', line: 2 },
            ...sidecars.map((file) => ({ uri: file.uri, content: 'Hidden keyword match' })),
            { uri: foreign.uri, content: 'Foreign keyword match' },
          ] } });
          return;
        default:
          throw new Error(`Unexpected route: ${request.route}`);
      }
    } catch (err) {
      errors.push(err);
      res.writeHead(500).end();
    }
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, []);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adapter = create(config(baseUrl, cfg), { readSecret: readSecret ?? (() => KEY) });
  return { adapter, requests, baseUrl };
}

function internalFind(request, send) {
  if (request.route !== 'POST /api/v1/search/find') return false;
  send({ status: 'error', error: { code: 'INTERNAL', message: 'Synthetic failure' } });
  return true;
}

test('only the five read routes run for list, stat, read, find and grep', async (t) => {
  let fallback = false;
  const { adapter, requests } = await stub(t, { override: (req, send) => fallback && internalFind(req, send) });
  assert.equal((await adapter.status()).state, 'ok');
  assert.equal((await adapter.overview()).total, files.length);
  const page = await adapter.browse({ path: ROOT });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, PROFILE);
  assert.equal(page.folders.length, directories.filter((d) => !d.uri.slice(ROOT.length).replace(/\/$/, '').includes('/')).length);
  assert.equal(page.more, false);
  const detail = await adapter.get(PROFILE);
  assert.equal(detail.body, files[0].body);
  assert.equal(detail.native, PROFILE);
  assert.equal(detail.format, 'markdown');
  assert.equal(new Map(detail.meta).get('Record id'), 'synthetic-record');
  const semantic = await adapter.search('keyword');
  assert.equal(semantic.total, files.length);
  assert.match(semantic.note, /^Semantic search/);
  assert.equal(semantic.items[0].score, files.length);
  fallback = true;
  const keyword = await adapter.search('keyword');
  assert.equal(keyword.total, 1);
  assert.equal(keyword.items[0].id, PROFILE);
  assert.equal(keyword.items[0].date, new Date(files[0].modTime).toISOString());
  assert.match(keyword.note, /keyword fallback.*grep/);
  assert.deepEqual(new Set(requests.map((r) => r.route)), new Set([
    'GET /api/v1/fs/ls', 'GET /api/v1/fs/stat', 'GET /api/v1/content/read',
    'POST /api/v1/search/find', 'POST /api/v1/search/grep',
  ]));
  assert.ok(requests.every((r) => r.key === KEY));
  assert.ok(requests.every((r) => !r.query.has('raw')));
});

test('recursive paging counts raw entries and caches only a complete tree', async (t) => {
  const { adapter, requests } = await stub(t);
  const overview = await adapter.overview();
  assert.equal(overview.total, files.length);
  assert.equal(overview.facets.reduce((n, f) => n + f.count, 0), files.length);
  assert.equal(overview.newest, [...files].sort((a, b) => b.modTime.localeCompare(a.modTime))[0].modTime);
  const pages = requests.filter((r) => r.route.endsWith('/ls'));
  assert.ok(pages.length > 1);
  const targets = new Set(pages.map((r) => r.query.get('uri')));
  for (const target of targets) {
    const offsets = pages.filter((r) => r.query.get('uri') === target).map((r) => Number(r.query.get('offset')));
    assert.deepEqual(offsets, offsets.map((_, i) => i * 2));
  }
  assert.ok(pages.every((r) => r.query.get('recursive') === 'true' && r.query.get('output') === 'original'));
  assert.ok(pages.every((r) => r.query.get('sort_by') === 'name' && r.query.get('limit') === '1000'));
  assert.equal((await adapter.recent(3)).length, 3);
  assert.equal((await adapter.overview()).total, files.length);
  assert.equal(requests.length, pages.length);
});

test('browse fetches later server pages and applies the visible file offset', async (t) => {
  const { adapter, requests } = await stub(t);
  const rootMenu = await adapter.browse();
  assert.deepEqual(rootMenu.folders, [{ path: ROOT, label: 'sample memories' }]);
  assert.equal(requests.length, 0);
  const path = ROOT + 'preferences/';
  const page = await adapter.browse({ path, offset: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.offset, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.more, false);
  assert.equal(page.crumbs.at(-1).path, path);
  assert.ok(requests.length > 1);
  assert.ok(requests.every((r) => r.query.get('recursive') === 'false'));
});

test('separate source entries retain their own keys, ids, names and roots', async (t) => {
  const { baseUrl, requests } = await stub(t);
  const secondCfg = config(baseUrl, {
    id: 'openviking-sample-two', name: 'OpenViking \u00b7 sample-two',
    apiKeyFile: '/run/secrets/openviking-sample-two', roots: [SECOND],
  });
  const configs = validateConfig({ sources: [config(baseUrl), secondCfg] });
  const seen = [];
  const adapters = configs.sources.map((cfg) => create(cfg, { readSecret: (file) => {
    seen.push(file);
    return file.endsWith('sample-two') ? 'synthetic-second-key' : KEY;
  } }));
  await Promise.all(adapters.map((adapter) => adapter.status()));
  await adapters[0].status();
  assert.deepEqual(adapters.map((adapter) => adapter.id), ['openviking-sample', 'openviking-sample-two']);
  assert.deepEqual(adapters.map((adapter) => adapter.name), configs.sources.map((cfg) => cfg.name));
  assert.deepEqual(seen, configs.sources.map((cfg) => cfg.apiKeyFile));
  assert.ok(requests.some((r) => r.query.get('uri') === ROOT && r.key === KEY));
  assert.ok(requests.some((r) => r.query.get('uri') === SECOND && r.key === 'synthetic-second-key'));
});

test('scoped find and fallback exclude hidden, directory and foreign results', async (t) => {
  let fallback = false;
  const { adapter, requests } = await stub(t, { override: (req, send) => fallback && internalFind(req, send) });
  const path = ROOT + 'preferences';
  const result = await adapter.search('keyword', { path, limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 1);
  assert.ok(result.items.every((item) => item.id.startsWith(path + '/')));
  assert.equal(requests[0].body.target_uri, path + '/');
  assert.deepEqual(requests[0].body.level, [2]);
  assert.equal(requests[0].body.context_type, 'memory');
  fallback = true;
  assert.equal((await adapter.search('keyword', { path })).total, 0);
  assert.equal(requests.at(-1).body.uri, path + '/');
  assert.ok(requests.every((r) => !r.route.endsWith('/ls')));
});

test('fallback escapes the bounded query before grep and uses no extra listing', async (t) => {
  const { adapter, requests } = await stub(t, { override: internalFind });
  const query = 'x'.repeat(199) + '[' + 'ignored';
  const result = await adapter.search(query);
  assert.match(result.note, /keyword fallback/);
  const grep = requests.at(-1);
  assert.equal(grep.body.pattern, 'x'.repeat(199) + '\\[');
  assert.doesNotThrow(() => new RegExp(grep.body.pattern));
  assert.equal(grep.body.case_insensitive, true);
  assert.equal(grep.body.node_limit, 5000);
  assert.equal(result.items[0].date, null);
  assert.deepEqual(requests.map((r) => r.route), ['POST /api/v1/search/find', 'POST /api/v1/search/grep']);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} from find or grep remains a denial`, async (t) => {
    for (const deniedRoute of ['/find', '/grep']) {
      const { adapter, requests } = await stub(t, { override: (req, send) => {
        if (req.route.endsWith(deniedRoute)) {
          send({ status: 'error' }, status);
          return true;
        }
        return internalFind(req, send);
      } });
      await assert.rejects(adapter.search('keyword'), { code: 'denied' });
      assert.equal(requests.length, deniedRoute === '/find' ? 1 : 2);
    }
  });
}

test('a structured permission error also blocks fallback', async (t) => {
  const { adapter, requests } = await stub(t, { override: (_, send) => {
    send({ status: 'error', error: { code: 'PERMISSION_DENIED', message: KEY } });
    return true;
  } });
  await assert.rejects(adapter.search('keyword'), (err) => err.code === 'denied' && !err.message.includes(KEY));
  assert.equal(requests.length, 1);
});

for (const denial of [401, 'PERMISSION_DENIED']) {
  test(`a ${denial} denial reloads the rotated key file on the next call`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'openviking-key-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, KEY);
    let acceptedKey = KEY;
    const { adapter, requests } = await stub(t, {
      cfg: { apiKeyFile: keyFile }, readSecret,
      override: (req, send) => {
        if (req.key === acceptedKey) return false;
        send({ status: 'error', error: { code: 'PERMISSION_DENIED', message: req.key } },
          typeof denial === 'number' ? denial : 200);
        return true;
      },
    });
    assert.equal((await adapter.status()).state, 'ok');
    acceptedKey = 'synthetic-rotated-key';
    writeFileSync(keyFile, acceptedKey);
    await assert.rejects(adapter.status(), (err) => err.code === 'denied'
      && !err.message.includes(KEY) && !err.message.includes(acceptedKey));
    assert.equal((await adapter.status()).state, 'ok');
    assert.equal(requests.at(-1).key, acceptedKey);
  });
}

test('credential failures do not make any network request or run fallback', async (t) => {
  const { adapter, requests } = await stub(t, { readSecret: () => { throw new SourceError('credentials', 'Missing test credential.'); } });
  await assert.rejects(adapter.search('keyword'), { code: 'credentials' });
  assert.equal(requests.length, 0);
});

test('paths outside roots, traversal and hidden paths are refused before a request', async (t) => {
  const { adapter, requests } = await stub(t);
  const paths = [
    SECOND, ROOT.replace('/memories/', '/memories-other/'), ROOT + '../resources/note.md',
    ROOT + '%2e%2e/resources/note.md', ROOT + '%252e%252e/note.md', ROOT + './note.md',
    ROOT + 'folder\\..\\note.md', ROOT + 'note.md\0', ROOT + 'folder//note.md',
    ROOT + '{calendar:today}/note.md', ...sidecars.map((file) => file.uri),
  ];
  for (const path of paths) {
    await assert.rejects(adapter.browse({ path }), { code: 'outside_roots' });
    await assert.rejects(adapter.search('keyword', { path }), { code: 'outside_roots' });
    assert.equal(await adapter.get(path), null);
  }
  assert.equal(requests.length, 0);
});

test('invalid root configuration fails before loading a credential', () => {
  for (const roots of [[], ['viking://~/memories/'], [ROOT + '../'], [ROOT + '.hidden/'], [{ label: 'missing URI' }]]) {
    assert.throws(() => create(config('http://unused.invalid', { roots }), {
      readSecret: () => assert.fail('No credential should be read'),
    }), /set at least one root|canonical, visible Viking root/);
  }
});

test('privacy placeholders remain in the reader and become markers before snippet truncation', async (t) => {
  const body = `# ${placeholder} ${longPlaceholder}\nSynthetic memory.`;
  let fallback = false;
  const { adapter } = await stub(t, { override: (req, send) => {
    if (fallback && internalFind(req, send)) return true;
    if (req.route.endsWith('/read')) send({ status: 'ok', result: body });
    else if (req.route.endsWith('/ls')) send({ status: 'ok', result: [{ ...files[0], abstract: body }] });
    else if (req.route.endsWith('/find')) send({ status: 'ok', result: { memories: [{ ...files[0], abstract: body }] } });
    else if (req.route.endsWith('/grep')) send({ status: 'ok', result: { matches: [{ uri: PROFILE, content: body }] } });
    else return false;
    return true;
  } });
  const detail = await adapter.get(PROFILE);
  assert.equal(detail.body, body);
  assert.equal(new Map(detail.meta).get('Privacy placeholders'), '2');
  const snippets = [detail.item.snippet, (await adapter.browse({ path: ROOT })).items[0].snippet,
    (await adapter.search('keyword')).items[0].snippet];
  fallback = true;
  snippets.push((await adapter.search('keyword')).items[0].snippet);
  for (const snippet of snippets) {
    assert.equal((snippet.match(/\u2039private\u203a/g) ?? []).length, 2);
    assert.doesNotMatch(snippet, /ov_privacy|privacy\/credential|x{20}/);
  }
});

for (const bodyStarted of [false, true]) {
  test(`timeouts propagate when the ${bodyStarted ? 'body stalls' : 'server sends no headers'}`, { timeout: 3000 }, async (t) => {
    const { adapter } = await stub(t, { cfg: { timeoutMs: 100 }, override: (_, __, res) => {
      if (bodyStarted) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"status":"ok",');
      }
      return true;
    } });
    await assert.rejects(adapter.status(), { code: 'timeout', status: 504 });
    await assert.rejects(adapter.search('keyword'), { code: 'timeout', status: 504 });
  });
}

test('a find timeout can still return the keyword fallback', { timeout: 3000 }, async (t) => {
  const { adapter } = await stub(t, { cfg: { timeoutMs: 100 }, override: (req) => req.route.endsWith('/find') });
  const result = await adapter.search('keyword');
  assert.equal(result.total, 1);
  assert.match(result.note, /keyword fallback/);
});

for (const result of [undefined, [], [files[0]]]) {
  test(`malformed or non-progressing pages fail without caching a partial tree (${JSON.stringify(result?.length)})`, async (t) => {
    let broken = true;
    const { adapter, requests } = await stub(t, { override: (req, send) => {
      if (!broken || !req.route.endsWith('/ls')) return false;
      send({ status: 'ok', result, has_more: true });
      return true;
    } });
    await assert.rejects(adapter.overview(), { code: 'bad_reply' });
    assert.ok(requests.length <= 2);
    broken = false;
    assert.equal((await adapter.overview()).total, files.length);
  });
}

test('all configured roots are checked and overlapping roots do not duplicate files', async (t) => {
  const { adapter, requests } = await stub(t, { cfg: { roots: [ROOT, ROOT + 'preferences/'] } });
  await adapter.status();
  assert.deepEqual(new Set(requests.map((r) => r.query.get('uri'))), new Set([ROOT, ROOT + 'preferences/']));
  assert.equal((await adapter.overview()).total, files.length);
  assert.equal((await adapter.search('keyword')).total, files.length);
});

test('optional peer roots stay in the same user source and expose separate folders', async (t) => {
  const peerRoot = 'viking://user/sample/peers/sample-peer/memories/';
  const peerFile = { ...files[0], uri: peerRoot + 'profile.md' };
  let fallback = false;
  const { adapter, requests } = await stub(t, {
    cfg: { roots: [{ uri: ROOT, label: 'User memories' }, { uri: peerRoot, label: 'Peer sample-peer' }] },
    override: (req, send) => {
      if (fallback && internalFind(req, send)) return true;
      const target = req.query.get('uri') ?? req.body?.target_uri ?? req.body?.uri;
      if (!target?.startsWith(peerRoot)) return false;
      if (req.route.endsWith('/ls')) send({ status: 'ok', result: [peerFile] });
      else if (req.route.endsWith('/stat')) send({ status: 'ok', result: peerFile });
      else if (req.route.endsWith('/read')) send({ status: 'ok', result: peerFile.body });
      else if (req.route.endsWith('/find')) send({ status: 'ok', result: { memories: [peerFile] } });
      else if (req.route.endsWith('/grep')) send({ status: 'ok', result: { matches: [{ uri: peerFile.uri, content: peerFile.body }] } });
      else return false;
      return true;
    },
  });
  const menu = await adapter.browse();
  assert.deepEqual(new Set(menu.folders.map((f) => f.path)), new Set([ROOT, peerRoot]));
  assert.equal(menu.folders.find((f) => f.path === peerRoot).label, 'Peer sample-peer');
  const overview = await adapter.overview();
  assert.equal(overview.total, files.length + 1);
  assert.ok(overview.facets.some((f) => f.path === peerRoot && f.count === 1));
  const page = await adapter.browse({ path: peerRoot });
  assert.deepEqual(page.items.map((item) => item.id), [peerFile.uri]);
  assert.equal(page.items[0].source, adapter.id);
  assert.equal(page.items[0].scope, 'Peer sample-peer');
  assert.equal((await adapter.get(peerFile.uri)).body, peerFile.body);
  assert.equal((await adapter.search('keyword')).total, files.length + 1);
  fallback = true;
  const keyword = await adapter.search('keyword', { path: peerRoot });
  assert.deepEqual(keyword.items.map((item) => item.id), [peerFile.uri]);
  assert.equal(requests.at(-1).body.uri, peerRoot);
  const before = requests.length;
  const sibling = peerRoot.replace('sample-peer', 'unconfigured-peer');
  await assert.rejects(adapter.browse({ path: sibling }), { code: 'outside_roots' });
  await assert.rejects(adapter.search('keyword', { path: sibling }), { code: 'outside_roots' });
  assert.equal(await adapter.get(sibling + 'profile.md'), null);
  assert.equal(requests.length, before);
});

test('browse can reach files beyond the visible page limit', async (t) => {
  const entries = Array.from({ length: 205 }, (_, i) => ({ ...files[0], uri: ROOT + `profile-${i}.md` }));
  const { adapter } = await stub(t, { override: (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    const offset = Number(req.query.get('offset'));
    send({ status: 'ok', result: entries.slice(offset, offset + 100), has_more: offset + 100 < entries.length });
    return true;
  } });
  const first = await adapter.browse({ path: ROOT });
  assert.equal(first.total, entries.length);
  assert.equal(first.more, true);
  const next = await adapter.browse({ path: ROOT, offset: first.items.length });
  assert.equal(next.more, false);
  assert.deepEqual([...first.items, ...next.items].map((item) => item.id), entries.map((entry) => entry.uri));
});

test('an HTTP internal error also uses the keyword fallback', async (t) => {
  const { adapter } = await stub(t, { override: (req, send) => {
    if (!req.route.endsWith('/find')) return false;
    send({ status: 'error', error: { code: 'INTERNAL' } }, 500);
    return true;
  } });
  const result = await adapter.search('keyword');
  assert.equal(result.total, 1);
  assert.match(result.note, /keyword fallback/);
});

test('malformed find replies and dropped connections use the keyword fallback', async (t) => {
  const replies = [null, {}, { status: 'ok', result: null },
    { status: 'ok', result: { memories: {} } },
    { status: 'ok', result: { memories: [], skills: {} } }];
  for (const reply of [...replies, 'invalid-json', 'disconnect']) {
    await t.test(JSON.stringify(reply), async (t) => {
      const { adapter, requests } = await stub(t, { override: (req, send, res) => {
        if (!req.route.endsWith('/find')) return false;
        if (reply === 'invalid-json') res.writeHead(200).end('{');
        else if (reply === 'disconnect') res.destroy();
        else send(reply);
        return true;
      } });
      const result = await adapter.search('keyword');
      assert.equal(result.total, 1);
      assert.match(result.note, /keyword fallback/);
      assert.deepEqual(requests.map((r) => r.route), ['POST /api/v1/search/find', 'POST /api/v1/search/grep']);
    });
  }
});

test('malformed grep replies fail rather than reporting empty results', async (t) => {
  for (const result of [null, {}, { matches: {} }]) {
    await t.test(JSON.stringify(result), async (t) => {
      const { adapter } = await stub(t, { override: (req, send) => {
        if (internalFind(req, send)) return true;
        send({ status: 'ok', result });
        return true;
      } });
      await assert.rejects(adapter.search('keyword'), { code: 'bad_reply' });
    });
  }
});

test('an empty semantic result does not run the keyword fallback', async (t) => {
  const { adapter, requests } = await stub(t, { override: (_, send) => {
    send({ status: 'ok', result: { memories: [], resources: [], skills: [] } });
    return true;
  } });
  const result = await adapter.search('keyword');
  assert.equal(result.total, 0);
  assert.match(result.note, /^Semantic search/);
  assert.deepEqual(requests.map((r) => r.route), ['POST /api/v1/search/find']);
});

test('a later root failure discards partial semantic hits and searches every root with grep', async (t) => {
  const peerRoot = 'viking://user/sample/peers/sample-peer/memories/';
  const { adapter, requests } = await stub(t, {
    cfg: { roots: [ROOT, peerRoot] },
    override: (req, send) => {
      if (req.route.endsWith('/find')) {
        if (req.body.target_uri === ROOT) return internalFind(req, send);
        send({ status: 'ok', result: { memories: [{ uri: peerRoot + 'semantic-only.md' }] } });
      } else if (req.route.endsWith('/grep') && req.body.uri === peerRoot) {
        send({ status: 'ok', result: { matches: [{ uri: peerRoot + 'profile.md', content: files[0].body }] } });
      } else return false;
      return true;
    },
  });
  const result = await adapter.search('keyword');
  assert.deepEqual(new Set(result.items.map((item) => item.id)), new Set([PROFILE, peerRoot + 'profile.md']));
  assert.match(result.note, /keyword fallback/);
  assert.deepEqual(requests.filter((r) => r.route.endsWith('/grep')).map((r) => r.body.uri), [peerRoot, ROOT]);
});

test('the list deadline covers all pages and a failed refresh preserves the previous cache', async (t) => {
  let expire = false;
  const clock = Date.now;
  t.mock.method(Date, 'now', clock);
  const { adapter, requests } = await stub(t, { cfg: { refreshSeconds: 0 }, override: (req, send) => {
    if (internalFind(req, send)) return true;
    if (!expire || !req.route.endsWith('/ls')) return false;
    send({ status: 'ok', result: [files[0]], has_more: true });
    Date.now.mock.mockImplementation(() => clock() + 20_000);
    return true;
  } });
  assert.equal((await adapter.overview()).total, files.length);
  expire = true;
  await assert.rejects(adapter.overview(), { code: 'timeout', status: 504 });
  Date.now.mock.mockImplementation(clock);
  expire = false;
  const before = requests.length;
  const fallback = await adapter.search('keyword');
  assert.equal(fallback.items[0].date, new Date(files[0].modTime).toISOString());
  assert.deepEqual(requests.slice(before).map((r) => r.route), ['POST /api/v1/search/find', 'POST /api/v1/search/grep']);
  assert.equal((await adapter.overview()).total, files.length);
});

test('recursive discovery descends beyond three levels, pages and deduplicates the tree', async (t) => {
  const deepFiles = [files[0],
    { ...files[0], uri: ROOT + 'events/2026/10/20/note.md', modTime: '2026-11-06T00:00:00Z' },
    { ...files[0], uri: ROOT + 'events/2026/10/20/archive/nested/deeper/note.md', modTime: '2026-11-07T00:00:00Z' },
    { ...files[0], uri: ROOT + 'preferences/sample/nested/deeper/note.md' }];
  const dirs = [...new Set(deepFiles.flatMap((file) => {
    const parts = file.uri.slice(ROOT.length).split('/');
    return parts.slice(0, -1).map((_, i) => ROOT + parts.slice(0, i + 1).join('/'));
  }))].map((uri) => ({ uri, isDir: true }));
  const { adapter, requests } = await stub(t, { override: (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    const target = req.query.get('uri');
    const entries = [...dirs, ...deepFiles].filter((entry) => entry.uri.startsWith(target)
      && entry.uri.slice(target.length).split('/').length <= 3);
    // Include a repeated self directory and unsafe directories to check queue confinement.
    entries.push({ uri: target.replace(/\/$/, ''), isDir: true },
      { uri: ROOT + '.hidden/a/b/c/d', isDir: true }, { uri: SECOND + 'a/b/c/d', isDir: true });
    const offset = Number(req.query.get('offset'));
    send({ status: 'ok', result: entries.slice(offset, offset + 2), has_more: offset + 2 < entries.length });
    return true;
  } });
  const overview = await adapter.overview();
  assert.equal(overview.total, deepFiles.length);
  assert.equal(overview.note, '');
  assert.equal(overview.newest, '2026-11-07T00:00:00Z');
  assert.equal(overview.facets.reduce((n, f) => n + f.count, 0), deepFiles.length);
  const recent = await adapter.recent(20);
  assert.deepEqual(new Set(recent.map((item) => item.id)), new Set(deepFiles.map((file) => file.uri)));
  assert.equal(recent[0].id, deepFiles[2].uri);
  const firstPages = requests.filter((req) => req.query.get('offset') === '0');
  const visited = firstPages.map((req) => req.query.get('uri'));
  assert.equal(new Set(visited).size, visited.length);
  assert.ok(visited.includes(ROOT + 'events/2026/10/20/archive/nested/'));
  assert.ok(visited.includes(ROOT + 'preferences/sample/nested/'));
  assert.ok(visited.every((uri) => uri.startsWith(ROOT) && !uri.includes('/.')));
  const before = requests.length;
  assert.deepEqual(await adapter.overview(), overview);
  assert.equal(requests.length, before);
});

test('a complete shallow tree makes no extra list call', async (t) => {
  const shallowFiles = [files[0], { ...files[0], uri: ROOT + 'preferences/style/note.md' }];
  const dirs = ['preferences/', 'preferences/style/', 'empty/'].map((path) => ({ uri: ROOT + path, isDir: true }));
  const { adapter, requests } = await stub(t, { override: (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    const uri = req.query.get('uri');
    send({ status: 'ok', result: [...dirs, ...shallowFiles].filter((entry) => entry.uri.startsWith(uri)), has_more: false });
    return true;
  } });
  const overview = await adapter.overview();
  assert.equal(overview.total, shallowFiles.length);
  assert.equal(overview.note, '');
  assert.deepEqual(new Set((await adapter.recent()).map((item) => item.id)), new Set(shallowFiles.map((file) => file.uri)));
  assert.equal(requests.length, 1);
});

test('concurrent overview and recent share one walk through 100 day folders', { timeout: 5000 }, async (t) => {
  const months = ['01', '02', '03', '04'].map((month) => ROOT + `events/2026/${month}/`);
  const dayFiles = months.flatMap((month) => Array.from({ length: 25 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return Array.from({ length: 10 }, (_, n) => ({ ...files[0], uri: `${month}${day}/note-${n}.md` }));
  }).flat());
  const allFiles = [...dayFiles, ...Array.from({ length: 20 }, (_, i) => ({ ...files[0], uri: ROOT + `profile-${i}.md` }))];
  const dirs = [...new Set(allFiles.flatMap((file) => {
    const parts = file.uri.slice(ROOT.length).split('/');
    return parts.slice(0, -1).map((_, i) => ROOT + parts.slice(0, i + 1).join('/'));
  }))].map((uri) => ({ uri, isDir: true }));
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const { adapter, requests } = await stub(t, { override: async (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    const uri = req.query.get('uri');
    if (uri === ROOT) {
      started.resolve();
      await release.promise;
    }
    const entries = [...dirs, ...allFiles].filter((entry) => entry.uri.startsWith(uri)
      && entry.uri.slice(uri.length).split('/').length <= 3);
    const offset = Number(req.query.get('offset'));
    const limit = Number(req.query.get('limit'));
    send({ status: 'ok', result: entries.slice(offset, offset + limit), has_more: offset + limit < entries.length });
    return true;
  } });
  const overviewRequest = adapter.overview();
  await started.promise;
  const recentRequest = adapter.recent(allFiles.length);
  release.resolve();
  const [overview, recent] = await Promise.all([overviewRequest, recentRequest]);
  assert.equal(overview.total, allFiles.length);
  assert.equal(overview.note, '');
  assert.deepEqual(new Set(recent.map((item) => item.id)), new Set(allFiles.map((file) => file.uri)));
  const targets = requests.map((req) => req.query.get('uri'));
  assert.equal(targets.length, new Set(targets).size);
  t.diagnostic(`100 day folders: ${requests.length} list calls; ${overview.total} files.`);
});

for (const count of [MAX_TREE_CALLS - 1, MAX_TREE_CALLS + 5]) {
  test(`recursive discovery bounds directory calls and labels only unfinished trees (${count} directories)`, async (t) => {
    const dirs = Array.from({ length: count }, (_, i) => ({ uri: ROOT + `events/2026/branch-${i}`, isDir: true }));
    const { adapter, requests } = await stub(t, { override: (req, send) => {
      if (!req.route.endsWith('/ls')) return false;
      const uri = req.query.get('uri');
      send({ status: 'ok', result: uri === ROOT ? dirs : [{ ...files[0], uri: uri + 'note.md' }], has_more: false });
      return true;
    } });
    const overview = await adapter.overview();
    assert.equal(requests.length, MAX_TREE_CALLS);
    assert.ok(overview.total <= count);
    if (count >= MAX_TREE_CALLS) assert.match(overview.note, /partial/i);
    else {
      assert.equal(overview.note, '');
      assert.equal(overview.total, count);
    }
    assert.deepEqual(await adapter.overview(), overview);
    assert.equal((await adapter.recent(count)).length, overview.total);
    assert.equal(requests.length, MAX_TREE_CALLS);
  });
}

test('recursive discovery shares the call bound across roots and their API pages', async (t) => {
  const pagesPerRoot = Math.ceil(MAX_TREE_CALLS * 0.6);
  let capped = true;
  const { adapter, requests } = await stub(t, { cfg: { roots: [ROOT, SECOND], refreshSeconds: 0 }, override: (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    const uri = req.query.get('uri');
    const offset = Number(req.query.get('offset'));
    send({ status: 'ok', result: [{ ...files[0], uri: uri + `note-${offset}.md` }], has_more: capped && offset + 1 < pagesPerRoot });
    return true;
  } });
  const partial = await adapter.overview();
  assert.equal(requests.length, MAX_TREE_CALLS);
  assert.ok(partial.total <= pagesPerRoot * 2);
  assert.match(partial.note, /partial/i);
  assert.deepEqual(new Set(requests.map((req) => req.query.get('uri'))), new Set([ROOT, SECOND]));
  capped = false;
  const before = requests.length;
  const complete = await adapter.overview();
  assert.equal(complete.total, 2);
  assert.equal(complete.note, '');
  assert.deepEqual(new Set(requests.slice(before).map((req) => req.query.get('uri'))), new Set([ROOT, SECOND]));
});

test('a denial below the recursion cap fails the refresh without publishing partial files', async (t) => {
  const branch = ROOT + 'events/2026/10/';
  let denied = true;
  const { adapter, requests } = await stub(t, { override: (req, send) => {
    if (!req.route.endsWith('/ls')) return false;
    if (req.query.get('uri') === ROOT) {
      send({ status: 'ok', result: [files[0], { uri: branch, isDir: true }] });
    } else if (denied) {
      send({ status: 'error' }, 403);
    } else {
      send({ status: 'ok', result: [{ ...files[0], uri: branch + '20/note.md' }] });
    }
    return true;
  } });
  const results = await Promise.allSettled([adapter.overview(), adapter.recent()]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'denied'));
  denied = false;
  const before = requests.length;
  const overview = await adapter.overview();
  assert.equal(overview.total, 2);
  assert.equal(overview.note, '');
  assert.deepEqual(new Set(requests.slice(before).map((req) => req.query.get('uri'))), new Set([ROOT, branch]));
});

test('a scheduled directory that disappears is empty, but a missing configured root fails', async (t) => {
  const branch = ROOT + 'events/2026/10/';
  for (const configuredRoot of [false, true]) {
    await t.test(configuredRoot ? 'missing root' : 'missing scheduled directory', async (t) => {
      let missing = true;
      const { adapter } = await stub(t, {
        cfg: { roots: configuredRoot ? [ROOT, branch] : [ROOT], refreshSeconds: 0 },
        override: (req, send) => {
          if (!req.route.endsWith('/ls')) return false;
          if (req.query.get('uri') === ROOT) {
            send({ status: 'ok', result: [files[0], { uri: branch, isDir: true }] });
          } else if (missing) {
            send({ status: 'error', error: { code: 'NOT_FOUND' } }, 404);
          } else {
            send({ status: 'ok', result: [{ ...files[0], uri: branch + '20/note.md' }] });
          }
          return true;
        },
      });
      if (configuredRoot) await assert.rejects(adapter.overview(), { code: 'not_found' });
      else {
        const overview = await adapter.overview();
        assert.equal(overview.total, 1);
        assert.equal(overview.note, '');
        assert.deepEqual((await adapter.recent()).map((item) => item.id), [PROFILE]);
      }
      missing = false;
      assert.equal((await adapter.overview()).total, 2);
    });
  }
});

test('live OpenViking adapter check', { skip: 'Needs stack keys. Production agent keys are not test credentials.' }, () => {});
