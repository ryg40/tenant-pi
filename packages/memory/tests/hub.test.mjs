import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Hub } from '../lib/hub.mjs';
import { sampleConfig } from '../lib/config.mjs';
import { create as sampleAdapter } from '../lib/adapters/sample.mjs';
import { indexAdapter } from '../lib/adapters/base.mjs';
import { LocalIndex } from '../lib/localindex.mjs';
import { publicError, SourceError } from '../lib/model.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/llmwiki.json', import.meta.url), 'utf8'));

function fake(overrides = {}) {
  return {
    name: 'Sample source', lazy: false,
    status: async () => ({ state: 'ok', detail: 'Sample ready' }),
    overview: async () => ({ total: 0, newest: null, facets: [] }),
    search: async () => ({ total: 0, items: [] }),
    recent: async () => [],
    browse: async () => ({ items: [] }),
    get: async () => null,
    ...overrides,
  };
}

function hubFor(adapters, opts = {}) {
  return new Hub({ sources: Object.keys(adapters).map((id) => ({ id, type: 'openviking', mode: 'live' })) }, {
    timeoutMs: 50,
    ...opts,
    factories: { openviking: { create: (cfg) => adapters[cfg.id] } },
  });
}

test('a slow source times out alone and a failed source keeps its own error slot', async () => {
  const logs = [];
  const hub = hubFor({
    good: fake({ search: async () => ({ items: [{ id: 'sample-hit' }], total: 1 }) }),
    slow: fake({ search: () => new Promise(() => {}) }),
    failed: fake({ search: () => { throw new Error('/sample/private sample-secret'); } }),
  }, { log: (line) => logs.push(line) });
  const results = await hub.search('sample-query');
  assert.deepEqual(results.map((r) => [r.id, r.state]), [['good', 'ok'], ['slow', 'error'], ['failed', 'error']]);
  assert.equal(results[0].items[0].id, 'sample-hit');
  assert.equal(results[1].error.code, 'timeout');
  assert.equal(results[2].error.code, 'failed');
  assert.doesNotMatch(JSON.stringify({ results, logs }), /\/sample\/private|sample-secret|sample-query/);
});

test('invalid search replies fail only their source slot', async () => {
  const hub = hubFor({
    good: fake({ search: async () => ({ items: [{ id: 'sample-hit' }], total: 1 }) }),
    absent: fake({ search: async () => null }),
    missing: fake({ search: async () => ({}) }),
    wrong: fake({ search: async () => ({ items: 'sample-private-content' }) }),
  });
  const results = await hub.search('sample');
  assert.equal(results[0].state, 'ok');
  assert.equal(results[0].items[0].id, 'sample-hit');
  for (const result of results.slice(1)) {
    assert.equal(result.state, 'error');
    assert.equal(result.error.code, 'bad_reply');
    assert.deepEqual(result.items, []);
  }
  assert.doesNotMatch(JSON.stringify(results), /sample-private-content/);
});

test('lazy sources join searches only when explicitly named and preserve completeness fields', async () => {
  let calls = 0;
  const hub = hubFor({ normal: fake(), lazy: fake({ lazy: true, search: async () => {
    calls += 1;
    return { total: 8, items: [], note: 'Sample note', more: true, partial: true, notes: ['Sample skipped namespace'] };
  } }) });
  assert.deepEqual((await hub.search('sample')).map((r) => r.id), ['normal']);
  assert.equal(calls, 0);
  const [result] = await hub.search('sample', { sources: ['lazy'] });
  assert.equal(calls, 1);
  assert.deepEqual([result.id, result.total, result.more, result.partial, result.notes], ['lazy', 8, true, true, ['Sample skipped namespace']]);
  assert.deepEqual((await hub.search('sample', { sources: [] })).map((r) => r.id), ['normal']);
});

test('global and single-source searches project safe namespace errors', async () => {
  const errors = [
    { path: '/global/shared', code: 'denied', message: 'sample-private-message', stack: 'sample-private-stack' },
    { path: '/actors/alice/private', code: 'aws_failed', message: 'sample-private-message', content: 'sample-private-content' },
    { path: '/sample/unknown', code: 'sample-private-code', message: 'sample-private-message' },
  ];
  const projected = errors.map(({ path, code }) => ({ path, ...publicError(new SourceError(code)) }));
  const hub = hubFor({
    lazy: fake({ lazy: true, search: async () => ({ items: [{ id: 'sample-hit' }], total: 1, partial: true, errors }) }),
    empty: fake({ search: async () => ({ items: [], errors: [] }) }),
    absent: fake(),
    malformed: fake({ search: async () => ({ items: [], errors: [null] }) }),
    nonarray: fake({ search: async () => ({ items: [], errors: {} }) }),
  });
  const [result] = await hub.search('sample', { sources: ['lazy'] });
  assert.equal(result.state, 'ok');
  assert.equal(result.partial, true);
  assert.equal(result.items[0].id, 'sample-hit');
  assert.deepEqual(result.errors, projected);
  const single = await hub.searchOne('lazy', 'sample', {});
  assert.deepEqual(single.errors, projected);
  assert.deepEqual(single.items, result.items);
  assert.equal(single.partial, true);
  assert.equal(errors[0].stack, 'sample-private-stack');
  assert.equal(errors[0].message, 'sample-private-message');
  assert.doesNotMatch(JSON.stringify({ result, single }), /sample-private/);
  const [empty, absent, malformed, nonarray] = await hub.search('sample');
  assert.deepEqual(empty.errors, []);
  assert.equal(Object.hasOwn(absent, 'errors'), false);
  for (const failed of [malformed, nonarray]) {
    assert.equal(failed.state, 'error');
    assert.equal(failed.error.code, 'bad_reply');
    assert.deepEqual(failed.items, []);
    await assert.rejects(hub.searchOne(failed.id, 'sample', {}), { code: 'bad_reply' });
  }
});

test('indexAdapter awaits its check for status and combined overviews', async () => {
  let failure;
  const status = { state: 'error', detail: 'Reload failed; serving the previous snapshot.', error: { code: 'failed' } };
  const overview = { status, ov: { total: 1, newest: null, facets: [] } };
  const adapter = indexAdapter({
    id: 'sample', type: 'llmwiki', mode: 'sample',
    check: async () => { await Promise.resolve(); if (failure) throw failure; },
    index: { status: async () => status, overviewWithStatus: async () => overview },
  });
  assert.strictEqual(await adapter.status(), status);
  assert.strictEqual(await adapter.overviewWithStatus(), overview);
  failure = new SourceError('not_mounted');
  await assert.rejects(adapter.status(), (error) => error === failure);
  await assert.rejects(adapter.overviewWithStatus(), (error) => error === failure);
});

test('invalid overview statuses fail only their source and leave other data intact', async () => {
  const snapshot = { total: 1, newest: docs[0].date, facets: [{ path: 'wiki', count: 1 }] };
  const invalid = [undefined, null, 'ok', [], { state: 'down' }];
  const hub = hubFor({
    good: fake({ overview: async () => snapshot }),
    ...Object.fromEntries(invalid.flatMap((status, i) => [
      [`bad-${i}`, fake({ status: async () => status })],
      [`combined-${i}`, fake({ overviewWithStatus: async () => ({ status, ov: snapshot }) })],
    ])),
    missing: fake({ overviewWithStatus: async () => undefined }),
  });
  const [good, ...failed] = await hub.overview();
  assert.equal(good.state, 'ok');
  for (const key of Object.keys(snapshot)) assert.deepEqual(good[key], snapshot[key]);
  for (const slot of failed) {
    assert.equal(slot.state, 'error');
    assert.equal(slot.error.code, 'bad_reply');
    assert.equal(Object.hasOwn(slot, 'total'), false);
  }
});

test('overview returns uncached stale snapshots and only errors when data is unavailable', async () => {
  const status = { state: 'error', detail: 'Reload failed; serving the previous snapshot.', error: { code: 'not_mounted', message: 'sample-private-message', stack: 'sample-private-stack' } };
  const snapshot = { total: 0, newest: null, facets: [], note: 'Sample snapshot' };
  let calls = 0;
  const hub = hubFor({
    stale: fake({ status: async () => status, overview: async () => { calls++; return snapshot; } }),
    missing: fake({ status: async () => status, overview: async () => { throw new SourceError('not_mounted'); } }),
    absent: fake({ status: async () => status, overview: async () => null }),
    unknown: fake({ status: async () => ({ state: 'error', detail: 'Reload failed.' }) }),
  });
  for (let i = 1; i <= 2; i++) {
    const [stale, missing, absent, unknown] = await hub.overview();
    assert.equal(stale.state, 'stale');
    assert.equal(stale.detail, status.detail);
    for (const key of Object.keys(snapshot)) assert.deepEqual(stale[key], snapshot[key]);
    assert.equal(stale.error.code, 'not_mounted');
    assert.equal(missing.state, 'error');
    assert.equal(missing.error.code, 'not_mounted');
    assert.equal(Object.hasOwn(missing, 'total'), false);
    assert.equal(absent.state, 'error');
    assert.equal(unknown.state, 'stale');
    assert.equal(unknown.error.code, 'failed');
    assert.doesNotMatch(JSON.stringify(stale), /sample-private/);
    assert.equal(calls, i);
  }
});

test('the hub isolates LocalIndex load failures, preserves stale data and caches recovery', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let fail = true;
  let snapshot = docs;
  const index = new LocalIndex({ source: 'sample', ttlMs: 100, load: () => {
    if (fail) {
      fail = false;
      throw new SourceError('not_mounted', 'sample-private-path');
    }
    return snapshot;
  } });
  const adapter = indexAdapter({ id: 'sample', type: 'llmwiki', mode: 'sample', index });
  const hub = hubFor({ sample: adapter, good: fake({ overview: async () => ({ total: 1 }) }) });
  const [failed, good] = await hub.overview();
  assert.equal(failed.state, 'error');
  assert.equal(failed.error.code, 'not_mounted');
  assert.equal(Object.hasOwn(failed, 'total'), false);
  assert.equal(good.state, 'ok');
  assert.equal(good.total, 1);
  assert.equal((await hub.overview())[0].state, 'error');
  now += 101;
  const [ready] = await hub.overview();
  assert.equal(ready.state, 'ok');
  assert.equal(ready.total, docs.length);
  assert.equal(Object.hasOwn(ready, 'error'), false);
  assert.deepEqual((await hub.overview())[0], ready);
  fail = true;
  now += 101;
  await index.ensure();
  await assert.rejects(index.pending, { code: 'not_mounted' });
  const [stale] = await hub.overview({ refresh: true });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.total, docs.length);
  assert.deepEqual(stale.facets, ready.facets);
  assert.equal(stale.newest, ready.newest);
  assert.equal(stale.error.code, 'not_mounted');
  assert.doesNotMatch(JSON.stringify(stale), /sample-private/);
  assert.deepEqual((await hub.overview())[0], stale);
  snapshot = [docs[0]];
  now += 101;
  await index.ensure();
  await index.pending;
  const [recovered] = await hub.overview();
  assert.equal(recovered.state, 'ok');
  assert.equal(Object.hasOwn(recovered, 'error'), false);
  assert.equal(recovered.total, snapshot.length);
  assert.equal(recovered.newest, new Date(snapshot[0].date).toISOString());
  assert.deepEqual((await hub.overview())[0], recovered);
});

test('overview caches only successful non-lazy sources and invalidates failed refreshes', async () => {
  let snapshot = { total: docs.length, newest: docs[0].date };
  let failGood = false;
  let unavailable = true;
  const hub = hubFor({
    good: fake({ overview: async () => { if (failGood) throw new SourceError('not_mounted'); return snapshot; } }),
    failed: fake({ overview: async () => { if (unavailable) throw new SourceError('not_mounted'); return snapshot; } }),
    status: fake({
      status: async () => ({ state: unavailable ? 'error' : 'ok' }),
      overview: async () => { if (unavailable) throw new SourceError('not_mounted'); return snapshot; },
    }),
    lazy: fake({ lazy: true, status: () => assert.fail('lazy status must not run'), overview: async () => snapshot }),
  });
  const [ready, failed, unavailableStatus] = await hub.overview();
  for (const slot of [failed, unavailableStatus]) {
    assert.equal(slot.state, 'error');
    assert.equal(Object.hasOwn(slot, 'total'), false);
  }
  snapshot = { total: 0, newest: null };
  unavailable = false;
  const [cached, ...updated] = await hub.overview();
  assert.deepEqual(cached, ready);
  for (const slot of updated) {
    assert.equal(slot.state, 'ok');
    assert.equal(slot.total, snapshot.total);
    assert.equal(slot.newest, snapshot.newest);
  }
  failGood = true;
  assert.equal((await hub.overview({ refresh: true }))[0].state, 'error');
  failGood = false;
  const [recovered] = await hub.overview();
  assert.equal(recovered.state, 'ok');
  assert.equal(recovered.total, snapshot.total);
  snapshot = { total: docs.length, newest: docs[0].date };
  hub.clear();
  assert.equal((await hub.overview())[0].total, snapshot.total);
  hub.overviewTtlMs = 0;
  snapshot = { total: 0, newest: null };
  assert.equal((await hub.overview())[0].total, snapshot.total);
});

test('warm calls each adapter once, handles sync throws and logs bounded failures', async () => {
  const logs = [];
  const counts = [0, 0, 0, 0];
  const hub = hubFor({
    good: fake({ warm: () => { counts[0] += 1; } }),
    sync: fake({ warm: () => { counts[1] += 1; throw new Error('sample-secret'); } }),
    async: fake({ warm: async () => { counts[2] += 1; throw new Error('sample-secret'); } }),
    slow: fake({ warm: () => { counts[3] += 1; return new Promise(() => {}); } }),
    absent: fake(),
  }, { log: (line) => logs.push(line) });
  const first = hub.warm();
  assert.deepEqual(counts, [1, 1, 1, 1]);
  await Promise.all([first, hub.warm()]);
  assert.deepEqual(counts, [1, 1, 1, 1]);
  for (const id of ['sync', 'async', 'slow']) assert.ok(logs.some((line) => line.startsWith(`source ${id}: warm-up failed:`)));
  assert.doesNotMatch(logs.join('\n'), /sample-secret/);
});

test('configuration failures stay in their source slot without exposing adapter errors', async () => {
  const logs = [];
  const hub = new Hub({ sources: [
    { id: 'bad', type: 'openviking', mode: 'live' },
    { id: 'off', type: 'openviking', mode: 'off' },
  ] }, { factories: { openviking: { create: () => { throw new Error('/sample/private sample-secret'); } } }, log: (line) => logs.push(line) });
  assert.equal(hub.sources().length, 1);
  assert.equal((await hub.overview())[0].error.code, 'config');
  assert.equal((await hub.search('sample'))[0].error.code, 'config');
  await assert.rejects(hub.browse('bad', {}), { status: 503, code: 'config' });
  assert.doesNotMatch(JSON.stringify({ sources: hub.sources(), logs }), /\/sample\/private|sample-secret/);
});

test('single-source methods keep missing, source failure and timeout status codes', async () => {
  const hub = hubFor({
    normal: fake(),
    timeout: fake({ browse: () => new Promise(() => {}) }),
    bad: fake({ browse: () => { throw new SourceError('outside_roots', '/sample/private', 400); } }),
  });
  await assert.rejects(hub.browse('missing', {}), { code: 'unknown_source', status: 404 });
  await assert.rejects(hub.item('normal', 'sample-missing'), { code: 'not_found', status: 404 });
  await assert.rejects(hub.browse('timeout', {}), { code: 'timeout', status: 504 });
  await assert.rejects(hub.browse('bad', {}), { code: 'outside_roots', status: 400 });
  assert.deepEqual(await hub.searchOne('normal', 'sample', {}), { total: 0, items: [] });
});

test('sample fixtures load without credentials; fixture names cannot leave app/sample', async () => {
  for (const fixture of ['../openviking.json', '/openviking.json', 'file:openviking.json', 'openviking.json?x', 'openviking.json#x', 'openviking%2ejson', {}, 'a\\b.json']) {
    assert.throws(() => sampleAdapter({ id: 'sample', type: 'openviking', fixture }), { code: 'config' });
  }
  const sample = sampleAdapter({ id: 'sample-alice', type: 'openviking', fixture: 'openviking.json' });
  assert.ok((await sample.overview()).total > 0);
  const hub = new Hub(sampleConfig());
  await hub.warm();
  assert.ok((await hub.overview()).every((r) => r.state === 'ok'));
  assert.ok((await hub.search('sample')).every((r) => r.state === 'ok'));
  const vikingSources = hub.sources().filter((source) => source.type === 'openviking');
  assert.deepEqual(vikingSources.map(({ id, name }) => [id, name]), [
    ['openviking', 'OpenViking \u00b7 Alice'], ['openviking-bob', 'OpenViking \u00b7 Bob'],
  ]);
  const reports = await hub.browse('openviking-bob', { path: 'preferences' });
  assert.ok(reports.items.some((item) => item.id === 'sample-bob-reports'));
  assert.ok(reports.items.every((item) => item.source === 'openviking-bob'));
  const found = await hub.searchOne('openviking-bob', 'placeholder', {});
  assert.ok(found.items.some((item) => item.id === 'sample-bob-reports'));
  const entries = await hub.browse('openviking-bob', { path: 'entities' });
  for (const item of [...reports.items, ...found.items, ...entries.items]) {
    assert.doesNotMatch(item.snippet, /ov_privacy|viking:\/\/|\||---/);
  }
});

test('AgentCore sample lists namespaces without loading records and resolves slash paths', async () => {
  const adapter = sampleAdapter({ id: 'agentcore', type: 'agentcore' });
  assert.equal(adapter.lazy, true);
  await adapter.warm();
  assert.equal((await adapter.overview()).total, null);
  assert.deepEqual(await adapter.recent(), []);
  const root = await adapter.browse();
  assert.ok(root.folders.length > 0);
  assert.ok(root.folders.every((f) => f.count === undefined && f.state === 'unloaded'));
  assert.deepEqual(root.items, []);
  const namespace = root.folders[0].path;
  const page = await adapter.browse({ path: namespace });
  assert.ok(page.items.length > 0);
  assert.equal(page.path, namespace);
  assert.equal(page.crumbs[1].path, namespace);
  const loaded = (await adapter.overview()).facets;
  assert.equal(loaded.find((f) => f.path === namespace).state, 'loaded');
  assert.ok(loaded.filter((f) => f.path !== namespace).every((f) => f.state === 'unloaded'));
  assert.deepEqual((await adapter.browse()).folders, loaded);
  assert.ok((await adapter.recent()).length > 0);
  const doc = await adapter.get(page.items[0].id);
  assert.equal(doc.item.id, page.items[0].id);
  assert.ok(doc.body.length > 0);
  assert.equal(await adapter.get('sample-missing'), null);
  await assert.rejects(adapter.browse({ path: '/sample/unknown' }), { code: 'unknown_namespace' });
  await assert.rejects(adapter.search('sample', { path: '/sample/unknown' }), { code: 'unknown_namespace' });
  await adapter.search('the', { limit: 1 });
  assert.ok((await adapter.overview()).total > 0);
});
