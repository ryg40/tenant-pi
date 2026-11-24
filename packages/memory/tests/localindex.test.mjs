import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { LocalIndex, PAGE_SIZE } from '../lib/localindex.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/llmwiki.json', import.meta.url), 'utf8'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('the first callers and warm-up share one load, including an empty index', async () => {
  const gate = deferred();
  let calls = 0;
  const index = new LocalIndex({ source: 'test', load: () => { calls++; return gate.promise; } });
  const first = index.ensure();
  const second = index.ensure();
  await turn();
  assert.equal(calls, 1);
  gate.resolve([]);
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  await index.ensure();
  assert.equal(calls, 1);
  assert.equal((await index.status()).state, 'ok');
});

test('stale readers return the old snapshot while one reload is held', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const gate = deferred();
  const index = new LocalIndex({ source: 'test', ttlMs: 100, load: () => ++calls === 1 ? docs : gate.promise });
  await index.ensure();
  now += 101;
  assert.strictEqual(await index.ensure(), docs);
  await turn();
  assert.equal(calls, 2);
  assert.equal((await index.get(docs[0].id)).body, docs[0].body);
  assert.equal((await index.overview()).total, docs.length);
  assert.equal((await index.search('privilege')).total, 1);
  assert.equal((await index.browse({ path: 'wiki/concepts' })).total, 2);
  assert.equal((await index.recent(1)).length, 1);
  assert.equal((await index.status()).state, 'ok');
  assert.equal(calls, 2);
  const pending = index.pending;
  gate.resolve([docs[1]]);
  await pending;
  assert.equal((await index.overview()).total, 1);
  assert.equal(await index.get(docs[0].id), null);
  assert.equal(index.loadedAt, now);
});

test('a failed reload preserves data, reports a safe error and throttles retries', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const index = new LocalIndex({ source: 'test', ttlMs: 100, load: () => {
    calls++;
    if (calls === 2) throw new Error('private-path-and-content');
    return docs;
  } });
  await index.ensure();
  now += 101;
  assert.strictEqual(await index.ensure(), docs);
  await assert.rejects(index.pending);
  const status = await index.status();
  assert.equal(status.state, 'error');
  assert.equal(status.error.code, 'failed');
  assert.doesNotMatch(JSON.stringify(status), /private-path-and-content/);
  assert.equal(index.loadedAt, 1000);
  assert.equal((await index.overview()).total, docs.length);
  assert.equal(calls, 2);
  now += 101;
  await index.ensure();
  await index.pending;
  assert.equal((await index.status()).state, 'ok');
});

test('an initial failure remains a refusal until the retry interval expires', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const failure = new Error('missing source');
  const index = new LocalIndex({ source: 'test', ttlMs: 100, load: () => {
    if (++calls === 1) throw failure;
    return docs;
  } });
  await assert.rejects(index.ensure(), (error) => error === failure);
  assert.equal(index.pending, null);
  for (let i = 0; i < 5; i++) assert.equal((await index.status()).state, 'error');
  await assert.rejects(index.get(docs[0].id), (error) => error === failure);
  await assert.rejects(index.overviewWithStatus(), (error) => error === failure);
  assert.equal(calls, 1);
  now += 101;
  assert.strictEqual(await index.ensure(), docs);
});

test('a malformed load cannot replace the previous snapshot', async () => {
  const index = new LocalIndex({ source: 'test', ttlMs: 0, load: () => docs });
  await index.ensure();
  index.load = () => [null];
  await index.ensure();
  await assert.rejects(index.pending);
  assert.strictEqual(index.docs, docs);
  assert.equal(index.byId.get(docs[0].id), docs[0]);
});

test('browse, search, dates and pagination retain the LocalIndex interface', async () => {
  const many = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({ ...docs[0], id: String(i) }));
  const index = new LocalIndex({ source: 'test', load: () => [...many, docs[2]], folderLabels: { wiki: 'Wiki pages' } });
  const first = await index.browse({ path: 'wiki/concepts' });
  assert.equal(first.total, PAGE_SIZE + 1);
  assert.equal(first.items.length, PAGE_SIZE);
  assert.equal(first.more, true);
  assert.equal(first.crumbs[1].label, 'Wiki pages');
  const second = await index.browse({ path: 'wiki/concepts', offset: PAGE_SIZE });
  assert.equal(second.items.length, 1);
  assert.equal(second.more, false);
  assert.equal((await index.search('storage', { path: 'wiki/concepts' })).total, 0);
  assert.equal((await index.recent(1))[0].id, docs[2].id);
  assert.equal((await index.get('0')).format, 'markdown');
});
