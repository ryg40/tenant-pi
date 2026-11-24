import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { exists, FileCache, mapBounded, MAX_FILE_BYTES, readInside, READ_CONCURRENCY, statInside, walkMarkdown } from '../lib/files.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/llmwiki.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'root'));
  return { dir, root: path.join(dir, 'root') };
}

test('walk finds Markdown, skips hidden paths and links, and respects its cap', async (t) => {
  const { dir, root } = await fixture(t);
  for (const folder of ['child', '.hidden', 'skip']) await mkdir(path.join(root, folder));
  for (const file of ['a.md', 'child/b.mdx', 'child/c.MD', '.hidden/d.md', '.private.md', 'skip/e.md', 'text.txt']) {
    await writeFile(path.join(root, file), docs[0].body);
  }
  await writeFile(path.join(dir, 'outside.md'), docs[1].body);
  await symlink(path.join(dir, 'outside.md'), path.join(root, 'link.md'));
  await symlink(path.join(root, 'child'), path.join(root, 'linked-folder'));
  assert.deepEqual(await walkMarkdown(root, root, { skipDirs: ['skip'] }), ['a.md', 'child/b.mdx', 'child/c.MD']);
  assert.equal((await walkMarkdown(root, root, { maxFiles: 2 })).length, 2);
  await assert.rejects(walkMarkdown(root, dir), /outside the root/);
  await assert.rejects(walkMarkdown(root, path.join(root, 'absent')));
  const opendir = fs.opendir;
  let failDuringListing = false;
  let code = 'EACCES';
  const mock = t.mock.method(fs, 'opendir', async (dir) => {
    if (dir !== path.join(root, 'child')) return opendir(dir);
    const error = Object.assign(new Error(dir), { code });
    if (!failDuringListing) throw error;
    return (async function* () {
      for await (const entry of await opendir(dir)) {
        yield entry;
        throw error;
      }
    })();
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  for (failDuringListing of [false, true]) {
    let skipped = 0;
    const readable = await walkMarkdown(root, root, { skipDirs: ['skip'], onSkip: () => { skipped++; } });
    assert.deepEqual(readable, ['a.md']);
    assert.equal(skipped, 1);
  }
  // A transient listing error fails the walk; it must not drop a subtree silently.
  code = 'EIO';
  await assert.rejects(walkMarkdown(root, root, { onSkip: () => {} }), { code: 'EIO' });
});

test('readInside rejects escapes and nonfiles, and preserves UTF-8 within its byte cap', async (t) => {
  const { dir, root } = await fixture(t);
  await writeFile(path.join(root, 'page.md'), docs[0].body);
  const read = await readInside(root, 'page.md');
  assert.equal(read.text, docs[0].body);
  assert.equal(read.tooLarge, false);
  assert.equal(read.size, Buffer.byteLength(docs[0].body));
  assert.equal((await readInside(path.parse(root).root, path.join(root, 'page.md'))).text, docs[0].body);
  await writeFile(path.join(dir, 'outside.md'), docs[1].body);
  await symlink(path.join(dir, 'outside.md'), path.join(root, 'escape.md'));
  for (const relative of ['../outside.md', path.join(dir, 'outside.md'), 'escape.md']) {
    await assert.rejects(readInside(root, relative), /outside the root/);
  }
  await assert.rejects(statInside(root, '.'), /not a file/);
  await assert.rejects(readInside(root, 'absent.md'), { code: 'ENOENT' });
  const huge = docs[0].body.repeat(Math.ceil((MAX_FILE_BYTES + 1) / docs[0].body.length));
  await writeFile(path.join(root, 'large.md'), huge);
  const large = await readInside(root, 'large.md');
  assert.equal(large.tooLarge, true);
  assert.equal(large.text, '');
  const exact = Buffer.alloc(MAX_FILE_BYTES, 'a');
  await writeFile(path.join(root, 'exact.md'), exact);
  assert.equal((await readInside(root, 'exact.md')).size, MAX_FILE_BYTES);
  assert.equal((await readInside(root, 'exact.md')).tooLarge, false);
});

test('readInside refuses replaced or changing files and closes each handle', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'page.md');
  await writeFile(file, docs[0].body);
  const handle = await open(file, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const realStat = prototype.stat;
  const handles = new Set();
  for (const phase of ['open', 'read']) {
    let calls = 0;
    const mock = t.mock.method(prototype, 'stat', async function (...args) {
      handles.add(this);
      const info = await realStat.apply(this, args);
      calls++;
      if (phase === 'open') info.ino++;
      else if (calls === 2) info.size++;
      return info;
    });
    await assert.rejects(readInside(root, 'page.md'), new RegExp(`file changed during ${phase}`));
    mock.mock.restore();
  }
  assert.equal(handles.size, 2);
  for (const opened of handles) assert.equal(opened.fd, -1);
});

test('exists distinguishes missing paths from invalid directory traversal', async (t) => {
  const { root } = await fixture(t);
  assert.equal(await exists(path.join(root, 'missing')), false);
  await writeFile(path.join(root, 'file'), docs[0].body);
  assert.equal(await exists(path.join(root, 'file')), true);
  await assert.rejects(exists(path.join(root, 'file', 'child')), { code: 'ENOTDIR' });
});

test('parallel work stays bounded and returns input order', async () => {
  let active = 0, peak = 0;
  const values = Array.from({ length: 100 }, (_, i) => i);
  const result = await mapBounded(values, async (i) => {
    peak = Math.max(peak, ++active);
    await turn();
    active--;
    return i;
  });
  assert.deepEqual(result, values);
  assert.equal(active, 0);
  assert.equal(peak, READ_CONCURRENCY);
});

test('parallel failure drains in-flight reads before the caller can retry', async () => {
  let active = 0;
  await assert.rejects(mapBounded(Array.from({ length: 100 }, (_, i) => i), async (i) => {
    active++;
    try {
      await turn();
      if (i === 1) throw new Error('read failed');
      await turn();
    } finally { active--; }
  }), /read failed/);
  assert.equal(active, 0);
});

test('FileCache reuses parsed entries and commits no partial failed scan', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'page.md');
  await writeFile(file, docs[0].body);
  const reads = [];
  let fail = false;
  const cache = new FileCache({ read: async (root, rel) => {
    reads.push(rel);
    if (fail) throw new Error('read failed');
    return readInside(root, rel);
  } });
  const files = [{ root, relative: 'page.md' }];
  const parse = ({ text }) => ({ body: text });
  const first = await cache.load(files, parse);
  assert.strictEqual((await cache.load(files, parse)).docs[0], first.docs[0]);
  assert.equal(reads.length, 1);
  assert.equal([...cache.entries.values()][0].info.text, undefined);
  const info = await stat(file);
  await utimes(file, info.atime, new Date(info.mtimeMs + 5000));
  fail = true;
  await assert.rejects(cache.load(files, parse));
  fail = false;
  await cache.load(files, parse);
  assert.equal(reads.length, 3);
  assert.deepEqual((await cache.load([], parse)).docs, []);
  assert.equal(cache.entries.size, 0);
});

test('a cached path is checked again before reuse', async (t) => {
  const { dir, root } = await fixture(t);
  await writeFile(path.join(root, 'page.md'), docs[0].body);
  const cache = new FileCache();
  const files = [{ root, relative: 'page.md' }];
  await cache.load(files, ({ text }) => text);
  await rm(path.join(root, 'page.md'));
  await writeFile(path.join(dir, 'outside.md'), docs[1].body);
  await symlink(path.join(dir, 'outside.md'), path.join(root, 'page.md'));
  const result = await cache.load(files, ({ text }) => text);
  assert.deepEqual(result.docs, []);
  assert.equal(result.skipped.files, 1);
});
