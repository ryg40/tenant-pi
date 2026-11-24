import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { create, loadVault } from '../lib/adapters/llmwiki.mjs';
import { FileCache, readInside } from '../lib/files.mjs';
import { LocalIndex } from '../lib/localindex.mjs';
import { Hub } from '../lib/hub.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/llmwiki.json', import.meta.url), 'utf8'));
const page = (i = 0) => `---\ntitle: ${docs[i].title}\ntype: ${docs[i].kind}\nupdated: ${docs[i].date}\ntags: [memory, sample]\n---\n${docs[i].body}`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-wiki-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'wiki', 'concepts'), { recursive: true });
  return root;
}

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'background reload must finish');
    await turn();
  }
}

test('wiki pages keep metadata, folders and date precedence; raw is opt-in', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'wiki/concepts/page.md'), page());
  await writeFile(path.join(root, 'wiki/index.md'), docs[0].body);
  await writeFile(path.join(root, 'wiki/plain.mdx'), docs[1].body);
  await mkdir(path.join(root, 'meta'));
  await writeFile(path.join(root, 'meta/log.md'), docs[0].body);
  await mkdir(path.join(root, 'raw'));
  await writeFile(path.join(root, 'raw/capture.md'), docs[2].body);
  const { docs: loaded } = await loadVault(root);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].title, docs[0].title);
  assert.deepEqual(loaded[0].folder, ['wiki', 'concepts']);
  assert.equal(loaded[0].date, docs[0].date);
  assert.equal(loaded[0].dateLabel, 'updated');
  assert.deepEqual(loaded[0].tags, ['memory', 'sample']);
  assert.equal(loaded[1].dateLabel, 'file time');
  assert.equal((await loadVault(root, { includeRaw: true })).docs.length, 3);
  await writeFile(path.join(root, 'wiki/date.md'), `---\ndate: 2026-10-01\n---\n${docs[0].body}`);
  assert.equal((await loadVault(root)).docs.find((d) => d.id === 'wiki/date.md').dateLabel, 'date');
});

test('incremental scans read only changed and added files and drop removals', async (t) => {
  const root = await fixture(t);
  for (const name of ['unchanged', 'mtime', 'size', 'removed']) {
    await writeFile(path.join(root, `wiki/${name}.md`), page());
  }
  // Use an exact whole-second time so the size-only change preserves mtime.
  const fixed = new Date('2026-01-01T00:00:00Z');
  for (const name of ['mtime', 'size']) await utimes(path.join(root, `wiki/${name}.md`), fixed, fixed);
  const reads = [];
  const cache = new FileCache({ read: async (root, rel) => { reads.push(rel); return readInside(root, rel); } });
  const first = await loadVault(root, {}, cache);
  assert.equal(reads.length, 4);
  reads.length = 0;
  assert.deepEqual(await loadVault(root, {}, cache), first);
  assert.deepEqual(reads, []);
  await utimes(path.join(root, 'wiki/mtime.md'), fixed, new Date(fixed.getTime() + 1000));
  await writeFile(path.join(root, 'wiki/size.md'), page() + '\n' + docs[1].body);
  await utimes(path.join(root, 'wiki/size.md'), fixed, fixed);
  await writeFile(path.join(root, 'wiki/added.md'), page(1));
  await rm(path.join(root, 'wiki/removed.md'));
  const { docs: next } = await loadVault(root, {}, cache);
  assert.deepEqual(reads.sort(), ['wiki/added.md', 'wiki/mtime.md', 'wiki/size.md']);
  assert.equal(next.length, 4);
  assert.equal(next.find((d) => d.id === 'wiki/removed.md'), undefined);
  assert.strictEqual(next.find((d) => d.id === 'wiki/unchanged.md'), first.docs.find((d) => d.id === 'wiki/unchanged.md'));
});

test('unchanged refused wiki files leave the index; whole-source failures retain it', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const root = await fixture(t);
  const healthy = 'wiki/healthy.md';
  const refused = 'wiki/refused.md';
  await writeFile(path.join(root, healthy), page());
  await writeFile(path.join(root, refused), page(1));
  const denied = new Set();
  const cache = new FileCache({ access: async (full, mode) => {
    if (denied.has(full)) throw Object.assign(new Error(full), { code: 'EACCES' });
    return access(full, mode);
  } });
  const index = new LocalIndex({ source: 'wiki', ttlMs: 100, load: () => loadVault(root, {}, cache) });
  await index.ensure();
  assert.equal((await index.get(refused)).body, docs[1].body);
  // Refuse access without changing any file or fingerprint, independent of uid.
  denied.add(path.join(root, refused));
  now += 101;
  await index.ensure();
  await index.pending;
  const { status } = await index.overviewWithStatus();
  assert.equal(status.state, 'ok');
  assert.equal(index.skipped.files, 1);
  assert.equal((await index.get(healthy)).body, docs[0].body);
  assert.equal(await index.get(refused), null);
  assert.equal((await index.search(docs[1].body)).total, 0);
  assert.equal(JSON.stringify(status).includes(root), false);
  assert.equal(JSON.stringify(status).includes(path.basename(refused)), false);
  // No document remains: keep the previous complete index and report failure.
  denied.add(path.join(root, healthy));
  now += 101;
  await index.ensure();
  await assert.rejects(index.pending);
  assert.equal((await index.status()).state, 'error');
  assert.equal((await index.get(healthy)).body, docs[0].body);
  assert.equal(await index.get(refused), null);
  denied.clear();
  now += 101;
  await index.ensure();
  await index.pending;
  assert.equal((await index.get(refused)).body, docs[1].body);
});

test('transient read and parser failures retain the old wiki index with or without skips', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const root = await fixture(t);
  await writeFile(path.join(root, 'wiki/page.md'), page());
  await writeFile(path.join(root, 'wiki/refused.md'), page(1));
  let failure;
  let skip = false;
  const cache = new FileCache({
    access: async (full, mode) => {
      if (skip && full.endsWith('/refused.md')) throw Object.assign(new Error(full), { code: 'EPERM' });
      return access(full, mode);
    },
    read: async (root, relative) => {
      if (failure?.code === 'EIO') throw failure;
      const read = await readInside(root, relative);
      // A parser input failure, outside the file-read catch.
      if (failure) read.mtime = null;
      return read;
    },
  });
  const index = new LocalIndex({ source: 'wiki', ttlMs: 100, load: () => loadVault(root, {}, cache) });
  const previous = await index.ensure();
  await writeFile(path.join(root, 'wiki/page.md'), page(2));
  for (failure of [Object.assign(new Error('private-read-detail'), { code: 'EIO' }), new Error('parser')]) {
    for (skip of [false, true]) {
      now += 101;
      await index.ensure();
      await assert.rejects(index.pending);
      assert.strictEqual(index.docs, previous);
      assert.equal((await index.get('wiki/page.md')).body, docs[0].body);
      assert.equal((await index.status()).state, 'error');
    }
  }
  failure = null;
  skip = false;
  now += 101;
  await index.ensure();
  await index.pending;
  assert.equal((await index.get('wiki/page.md')).body, docs[2].body);
});

test('the adapter serves stale data, reports reload errors and recovers', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'wiki/page.md'), page());
  const adapter = create({ id: 'wiki', path: root, refreshSeconds: 0 });
  await adapter.warm();
  await rename(path.join(root, 'wiki'), path.join(root, 'hidden'));
  assert.equal((await adapter.overview()).total, 1);
  await until(async () => (await adapter.status()).state === 'error');
  assert.equal((await adapter.status()).error.code, 'not_mounted');
  assert.equal((await adapter.get('wiki/page.md')).body, docs[0].body);
  await rename(path.join(root, 'hidden'), path.join(root, 'wiki'));
  await writeFile(path.join(root, 'wiki/added.md'), page(1));
  await until(async () => (await adapter.overview()).total === 2);
  await until(async () => (await adapter.status()).state === 'ok');
});

test('missing wiki does not warm an empty index and the hub calls warm at start', async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, 'wiki'), { recursive: true });
  const adapter = create({ id: 'wiki', path: root });
  await assert.rejects(adapter.warm(), { code: 'not_mounted' });
  assert.equal((await adapter.status()).state, 'error');
  await mkdir(path.join(root, 'wiki'));
  await writeFile(path.join(root, 'wiki/page.md'), page());
  let warms = 0;
  const hub = new Hub({ sources: [{ id: 'wiki', type: 'llmwiki', mode: 'live', path: root }] }, {
    factories: { llmwiki: { create(cfg) {
      const source = create(cfg);
      const warm = source.warm;
      source.warm = () => { warms++; return warm(); };
      return source;
    } } },
  });
  hub.warm();
  await hub.entry('wiki').adapter.warm();
  assert.equal(warms, 2);
  assert.equal((await hub.entry('wiki').adapter.overview()).total, 1);
});
