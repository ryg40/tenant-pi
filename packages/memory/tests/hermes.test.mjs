import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { setImmediate as turn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { create, loadHermes, openReadOnly, readStore, splitEntries } from '../lib/adapters/hermes.mjs';
import { FileCache, MAX_FILE_BYTES, readInside } from '../lib/files.mjs';
import { Hub } from '../lib/hub.mjs';
import { LocalIndex } from '../lib/localindex.mjs';

const { docs } = JSON.parse(await readFile(new URL('../sample/hermes.json', import.meta.url), 'utf8'));
const body = (i = 0) => docs[i].body;
const entry = (i = 0) => `${body(i)}\n<!-- created=2026-07-01, last=2026-10-30 -->`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-hermes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY, project TEXT, target TEXT, category TEXT, content TEXT,
    created TEXT, last_referenced TEXT, failure_reason TEXT, corrected_to TEXT,
    tool_state TEXT, hit_count INTEGER, last_hit_at TEXT);
    CREATE TABLE sessions (id INTEGER, content TEXT);
    CREATE TABLE messages (id INTEGER, content TEXT);`);
  for (let i = 0; i < 4; i++) {
    db.prepare(`INSERT INTO memories (id, target, content, created, last_referenced)
      VALUES (?, ?, ?, ?, ?)`).run(i + 1, i < 2 ? 'memory' : i === 2 ? 'user' : 'failure', body(i), '2026-07-01', '2026-10-30');
  }
  db.prepare('INSERT INTO sessions VALUES (1, ?)').run(body(5));
  db.prepare('INSERT INTO messages VALUES (1, ?)').run(body(5));
  return db;
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'background reload must finish');
    await turn();
  }
}

test('splitEntries keeps the native separator and date suffix', () => {
  assert.deepEqual(splitEntries(`${entry()}\n\u00a7\n${body(1)}`), [
    { text: body(), created: '2026-07-01', last: '2026-10-30' },
    { text: body(1), created: null, last: null },
  ]);
  assert.deepEqual(splitEntries(''), []);
});

test('active and project entries retain folders, dates and every matching row number', async (t) => {
  const root = await fixture(t);
  const db = makeStore(path.join(root, 'sessions.db'));
  db.prepare('INSERT INTO memories (id, target, content, created) VALUES (5, ?, ?, ?)').run('memory', body(), '2026-07-01');
  db.close();
  await writeFile(path.join(root, 'MEMORY.md'), entry());
  await writeFile(path.join(root, 'USER.md'), body(2));
  const projects = path.join(root, 'projects');
  await mkdir(path.join(projects, 'gateway'), { recursive: true });
  await writeFile(path.join(projects, 'gateway/MEMORY.md'), body(1));
  const { docs: loaded } = await loadHermes({ path: root, projectsPath: projects });
  const active = loaded.find((d) => d.id === 'file:MEMORY.md#1');
  assert.equal(active.body, body());
  assert.equal(active.date, '2026-10-30');
  assert.equal(active.dateLabel, 'last referenced');
  assert.deepEqual(active.folder, ['active', 'memory']);
  assert.deepEqual(active.meta.filter(([key]) => key === 'Row'), [['Row', 'memories.id = 1'], ['Row', 'memories.id = 5']]);
  const project = loaded.find((d) => d.id === 'project:gateway#1');
  assert.deepEqual(project.folder, ['projects', 'gateway']);
  assert.ok(project.meta.some(([key, value]) => key === 'Row' && value === 'memories.id = 2'));
  assert.equal(loaded.find((d) => d.id === 'file:USER.md#1').dateLabel, 'file time');
  assert.equal(loaded.find((d) => d.id === 'db:5').dateLabel, 'created');
});

test('file reloads reuse unchanged text, drop removed entries and update row links', async (t) => {
  const root = await fixture(t);
  const db = makeStore(path.join(root, 'sessions.db'));
  t.after(() => db.close());
  await writeFile(path.join(root, 'MEMORY.md'), entry());
  await writeFile(path.join(root, 'USER.md'), body(2));
  const reads = [];
  const state = { files: new FileCache({ read: async (root, rel) => {
    reads.push(rel);
    return readInside(root, rel);
  } }) };
  const cfg = { path: root };
  await loadHermes(cfg, state);
  assert.deepEqual(reads.sort(), ['MEMORY.md', 'USER.md']);
  reads.length = 0;
  const firstStore = state.store;
  await loadHermes(cfg, state);
  assert.deepEqual(reads, []);
  assert.strictEqual(state.store, firstStore);
  db.prepare('DELETE FROM memories WHERE id = ?').run(1);
  const info = await stat(path.join(root, 'sessions.db'));
  await utimes(path.join(root, 'sessions.db'), info.atime, new Date(info.mtimeMs + 1000));
  await writeFile(path.join(root, 'failures.md'), body(3));
  await rm(path.join(root, 'USER.md'));
  const { docs: next } = await loadHermes(cfg, state);
  assert.deepEqual(reads, ['failures.md']);
  assert.equal(next.find((d) => d.id === 'file:USER.md#1'), undefined);
  assert.equal(next.find((d) => d.id === 'file:MEMORY.md#1').meta.some(([key]) => key === 'Row'), false);
});

test('one refused Markdown file cannot hide readable Hermes store rows', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const root = await fixture(t);
  await writeFile(path.join(root, 'MEMORY.md'), entry());
  const file = path.join(root, 'sessions.db');
  makeStore(file).close();
  const state = { files: new FileCache({ read: async (root, relative) => {
    throw Object.assign(new Error(path.join(root, relative)), { code: 'EPERM' });
  } }) };
  const index = new LocalIndex({ source: 'hermes', ttlMs: 100, load: () => loadHermes({ path: root }, state) });
  const { status, ov } = await index.overviewWithStatus();
  assert.equal(status.state, 'ok');
  assert.equal(index.skipped.files, 1);
  assert.equal(ov.total, 4);
  for (let i = 0; i < 4; i++) assert.equal((await index.get(`db:${i + 1}`)).body, body(i));
  assert.equal(await index.get('file:MEMORY.md#1'), null);
  assert.equal(JSON.stringify(status).includes(root), false);
  assert.equal(JSON.stringify(status).includes('MEMORY.md'), false);
  // Without store rows the same refusal must not publish an empty success.
  await rm(file);
  now += 101;
  await index.ensure();
  await assert.rejects(index.pending);
  assert.equal((await index.status()).state, 'error');
  assert.equal((await index.get('db:1')).body, body());
});

test('WAL-only changes invalidate the store cache', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'sessions.db');
  const db = makeStore(file);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  const state = { files: new FileCache() };
  const first = await loadHermes({ path: root }, state);
  const before = await stat(file);
  db.prepare('INSERT INTO memories (id, target, content) VALUES (5, ?, ?)').run('memory', body(5));
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal((await loadHermes({ path: root }, state)).docs.length, first.docs.length + 1);
});

test('a changed WAL index invalidates the store cache', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'sessions.db');
  const db = makeStore(file);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.prepare('INSERT INTO memories (id, target, content) VALUES (5, ?, ?)').run('memory', body(5));
  const state = { files: new FileCache() };
  await loadHermes({ path: root }, state);
  const previous = state.store;
  const sidecar = file + '-shm';
  const info = await stat(sidecar);
  await utimes(sidecar, info.atime, new Date(info.mtimeMs + 5000));
  await loadHermes({ path: root }, state);
  assert.notStrictEqual(state.store, previous);
  assert.equal(state.store.length, previous.length);
});

test('the SQL authorizer observes memories reads and no transcript table reads', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'sessions.db');
  makeStore(file).close();
  const original = DatabaseSync.prototype.prepare;
  const reads = new Set();
  const statements = [];
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    statements.push(sql);
    this.setAuthorizer((action, table) => {
      if (action === constants.SQLITE_READ) {
        reads.add(table);
        if (!['memories', 'sqlite_master', 'sqlite_schema'].includes(table)) return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    return original.call(this, sql);
  });
  assert.equal(readStore(file).length, 4);
  assert.ok(reads.has('memories'));
  assert.equal(reads.has('sessions'), false);
  assert.equal(reads.has('messages'), false);
  assert.ok(statements.every((sql) => /^(SELECT|PRAGMA table_info\(memories\))/.test(sql)));
});

test('missing stores stay absent; corrupt stores and schemas fail without fallback', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(readStore(path.join(root, 'missing.db')), []);
  assert.deepEqual(await readdir(root), []);
  assert.throws(() => openReadOnly(root), /not a file/);
  const file = path.join(root, 'sessions.db');
  await writeFile(file, body());
  assert.throws(() => readStore(file));
  await rm(file);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY)');
  db.close();
  assert.throws(() => readStore(file), /no content column/);
});

test('read-only WAL and immutable fallback work without changing database bytes or sidecars', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-wal-'));
  const source = path.join(root, 'source.db');
  const writer = makeStore(source);
  t.after(async () => {
    for (const name of ['with-index', 'without-index']) {
      await chmod(path.join(root, name), 0o755).catch(() => {});
    }
    writer.close();
    await rm(root, { recursive: true, force: true });
  });
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);');
  writer.prepare('INSERT INTO memories (id, target, content) VALUES (5, ?, ?)').run('memory', body(5));
  const withIndex = path.join(root, 'with-index');
  const withoutIndex = path.join(root, 'without-index');
  for (const folder of [withIndex, withoutIndex]) {
    await mkdir(folder);
    for (const suffix of ['', '-wal', ...(folder === withIndex ? ['-shm'] : [])]) {
      const dest = path.join(folder, 'sample #?.db') + suffix;
      await copyFile(source + suffix, dest);
      await chmod(dest, 0o444);
    }
    await chmod(folder, 0o555);
  }
  await mkdir(path.join(root, 'lib/adapters'), { recursive: true });
  for (const name of ['adapters/hermes.mjs', 'adapters/base.mjs', 'localindex.mjs', 'model.mjs', 'files.mjs']) {
    await copyFile(new URL(`../lib/${name}`, import.meta.url), path.join(root, 'lib', name));
  }
  const privileges = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  // The test sets the fixture folder to 0o755 itself; each parent must let other users pass.
  if (privileges.uid !== undefined) {
    for (let folder = path.dirname(root); ; folder = path.dirname(folder)) {
      if (((await stat(folder)).mode & 0o001) === 0) {
        t.skip(`an unprivileged child cannot pass a parent of the temporary folder: ${folder}`);
        return;
      }
      if (folder === path.dirname(folder)) break;
    }
  }
  // A copied executable avoids an inaccessible root-owned Node installation.
  const node = path.join(root, 'node');
  await copyFile(process.execPath, node);
  await chmod(node, 0o755);
  await chmod(root, 0o755);
  const digest = async (folder) => {
    const values = [];
    for (const name of (await readdir(folder)).sort()) {
      values.push([name, createHash('sha256').update(await readFile(path.join(folder, name))).digest('hex')]);
    }
    return values;
  };
  const before = await Promise.all([digest(withIndex), digest(withoutIndex)]);
  const module = pathToFileURL(path.join(root, 'lib/adapters/hermes.mjs')).href;
  const script = `
    import assert from 'node:assert/strict';
    import { accessSync, constants as fsConstants } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { openReadOnly, readStore } from ${JSON.stringify(module)};
    const withIndex = ${JSON.stringify(path.join(withIndex, 'sample #?.db'))};
    const withoutIndex = ${JSON.stringify(path.join(withoutIndex, 'sample #?.db'))};
    for (const file of [withIndex, withoutIndex]) {
      assert.throws(() => accessSync(file, fsConstants.W_OK));
    }
    assert.equal(readStore(withIndex).length, 5);
    let plain;
    try {
      assert.throws(() => {
        plain = new DatabaseSync(withoutIndex, { readOnly: true });
        plain.prepare('SELECT count(*) FROM memories').get();
      });
    } finally { plain?.close(); }
    let closes = 0;
    const close = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () { closes++; return close.call(this); };
    const fallback = openReadOnly(withoutIndex);
    assert.equal(closes, 1);
    assert.equal(fallback.prepare('SELECT count(*) AS n FROM memories').get().n, 4);
    assert.throws(() => fallback.exec('DELETE FROM memories'), /readonly/);
    fallback.close();
    assert.equal(readStore(withoutIndex).length, 4);
    console.log('read-only WAL and immutable fallback passed');
  `;
  const child = spawnSync(node, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    ...privileges, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error?.code ?? child.signal));
  assert.match(child.stdout, /fallback passed/);
  assert.deepEqual(await Promise.all([digest(withIndex), digest(withoutIndex)]), before);
});

test('an unreadable store reports an error without a leaked fallback connection', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'sessions.db');
  makeStore(file).close();
  const error = Object.assign(new Error('readonly'), { errcode: 8 });
  let closes = 0;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'prepare', () => { throw error; });
  t.mock.method(DatabaseSync.prototype, 'close', function () { closes++; return close.call(this); });
  assert.throws(() => openReadOnly(file), /readonly/);
  assert.equal(closes, 2);
});

test('oversize active files show the limit instead of silently disappearing', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'MEMORY.md'), body().repeat(Math.ceil(MAX_FILE_BYTES / body().length) + 1));
  const { docs: loaded } = await loadHermes({ path: root });
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].body, /up to 2 MB/);
});

test('hermes keeps stale results on a failed refresh and warm remains on the hub', async (t) => {
  const root = await fixture(t);
  const active = path.join(root, 'MEMORY.md');
  await writeFile(active, entry());
  const cfg = { id: 'hermes', type: 'hermes', mode: 'live', path: root, refreshSeconds: 0 };
  const source = create(cfg);
  await source.warm();
  await writeFile(path.join(root, 'sessions.db'), body());
  assert.equal((await source.overview()).total, 1);
  await until(async () => (await source.status()).state === 'error');
  assert.equal((await source.get('file:MEMORY.md#1')).body, body());
  await rm(path.join(root, 'sessions.db'));
  await writeFile(active, `${entry()}\n\u00a7\n${body(1)}`);
  await until(async () => (await source.overview()).total === 2);
  await until(async () => (await source.status()).state === 'ok');
  let warms = 0;
  const hub = new Hub({ sources: [cfg] }, { factories: { hermes: { create(cfg) {
    const adapter = create(cfg);
    const warm = adapter.warm;
    adapter.warm = () => { warms++; return warm(); };
    return adapter;
  } } } });
  hub.warm();
  assert.equal(warms, 1);
  await hub.entry('hermes').adapter.warm();
  assert.equal((await hub.entry('hermes').adapter.overview()).total, 2);
});

test('configured missing roots fail rather than removing a complete index', async (t) => {
  const root = await fixture(t);
  await assert.rejects(loadHermes({ path: path.join(root, 'absent') }), { code: 'not_mounted' });
  await assert.rejects(loadHermes({ path: root, projectsPath: path.join(root, 'absent') }), { code: 'ENOENT' });
});
