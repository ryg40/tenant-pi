import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, readSecret, sampleConfig, validateConfig } from '../lib/config.mjs';

const source = { id: 'sample-alice', type: 'openviking', mode: 'sample' };

test('configuration rejects unknown types, duplicate ids, bad ids and bad modes', () => {
  for (const type of ['unknown', 'constructor', '__proto__', null, ['openviking']]) {
    assert.throws(() => validateConfig({ sources: [{ ...source, type }] }), /unknown type/);
  }
  assert.throws(() => validateConfig({ sources: [source, source] }), /occurs twice/);
  for (const id of ['', 'Alice', '../sample', 'sample user', 'a'.repeat(41), 1, {}]) {
    assert.throws(() => validateConfig({ sources: [{ ...source, id }] }), /id must be/);
  }
  for (const mode of ['enabled', '', 1, {}]) {
    assert.throws(() => validateConfig({ sources: [{ ...source, mode }] }), /unknown mode/);
  }
  for (const raw of [null, {}, { sources: {} }, { sources: [null] }, { sources: [[]] }]) {
    assert.throws(() => validateConfig(raw), /config:/);
  }
});

test('several sources of one type are valid and defaults do not mutate input', () => {
  const raw = { sources: [{ type: 'openviking' }, { id: 'sample-bob', type: 'openviking', mode: 'off' }] };
  const result = validateConfig(raw);
  assert.deepEqual(result.sources.map(({ id, mode }) => [id, mode]), [['openviking', 'live'], ['sample-bob', 'off']]);
  assert.equal(raw.sources[0].id, undefined);
  assert.deepEqual(validateConfig(sampleConfig()), sampleConfig());
  assert.equal(new Set(sampleConfig().sources.map((s) => s.type)).size, 5);
});

test('configuration and credential file errors do not expose paths or file content', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.json');
  await writeFile(file, JSON.stringify({ sources: [source] }));
  assert.deepEqual(loadConfig(file), { sources: [source] });
  await writeFile(file, '{"sample-private-content":');
  for (const target of [file, path.join(dir, 'missing')]) {
    assert.throws(() => loadConfig(target), (err) => {
      assert.equal(err.message, 'config: the source file is not readable JSON');
      return true;
    });
  }
  assert.throws(() => readSecret(), /no credential file/);
  assert.throws(() => readSecret(path.join(dir, 'missing')), /not readable/);
  await writeFile(file, ' \n');
  assert.throws(() => readSecret(file), /empty/);
  await writeFile(file, ' sample-user:sample-password \n');
  assert.equal(readSecret(file), 'sample-user:sample-password');
});
