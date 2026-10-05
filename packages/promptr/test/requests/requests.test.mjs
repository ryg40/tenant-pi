// Saved request packets: pure listing/loading over an injected fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeRequest, draftFor, listRequests, loadRequest } from '../../dist/src/tracking/requests.mjs';
import { DIR, fakeFs, packet } from './fixtures.mjs';

const CONTEXT = { cwd: '/repo', ref: 'main', head: 'abc1234', dirty: false, targetLabel: 'Coordinator', nowIso: '2026-09-07T13:00:00Z' };

test('listing is newest first and ignores other issues', () => {
  const fs = fakeFs({
    '7-20260901T100000Z.json': JSON.stringify(packet(7)),
    '7-20260907T120000Z.json': JSON.stringify(packet(7)),
    '7-20260905T000000Z.json': JSON.stringify(packet(7)),
    '8-20260907T120000Z.json': JSON.stringify(packet(8)),
    'notes.txt': 'x',
  });
  const { entries, skipped } = listRequests(DIR, 7, fs);
  assert.deepEqual(entries.map((e) => e.stamp), ['20260907T120000Z', '20260905T000000Z', '20260901T100000Z']);
  assert.equal(skipped, 0);
  assert.equal(entries[0].file, `${DIR}/7-20260907T120000Z.json`);
  assert.equal(entries[0].issue, 7);
  assert.equal(entries[0].template, 'fixture-a');
  assert.equal(entries[0].provider, 'fixture-provider-1');
  assert.equal(entries[0].createdAt, '2026-09-07T12:34:56Z');
});

test('an empty or missing directory lists nothing', () => {
  assert.deepEqual(listRequests(DIR, 7, fakeFs({})), { entries: [], skipped: 0 });
  assert.deepEqual(listRequests(DIR, 7, fakeFs({}, { missing: true })), { entries: [], skipped: 0 });
});

test('malformed and foreign JSON are skipped and counted', () => {
  const fs = fakeFs({
    '7-20260907T120000Z.json': JSON.stringify(packet(7)),
    '7-20260907T120001Z.json': '{not json',
    '7-20260907T120002Z.json': JSON.stringify({ kind: 'something-else', version: 1 }),
    '7-20260907T120003Z.json': JSON.stringify(packet(9)),
    '7-20260907T120004Z.json': JSON.stringify(packet(7, { version: 2 })),
    '7-20260907T120005Z.json': JSON.stringify(packet(7, { workflow: { template: 1, provider: 'p' } })),
    '7-20260907T120006Z.json': undefined,
  });
  const { entries, skipped } = listRequests(DIR, 7, fs);
  assert.equal(entries.length, 1);
  assert.equal(skipped, 6);
});

test('a generated sibling is detected only when it is in the listing', () => {
  const fs = fakeFs({
    '7-20260907T120000Z.json': JSON.stringify(packet(7)),
    '7-20260907T120000Z.md': 'generated text\n',
    '7-20260901T100000Z.json': JSON.stringify(packet(7)),
  });
  const { entries } = listRequests(DIR, 7, fs);
  assert.equal(entries[0].generatedFile, `${DIR}/7-20260907T120000Z.md`);
  assert.equal(entries[1].generatedFile, undefined);
  assert.equal(describeRequest(entries[0]), '20260907T120000Z · fixture-a · fixture-provider-1 · generated');
  assert.equal(describeRequest(entries[1]), '20260901T100000Z · fixture-a · fixture-provider-1');
});

test('describeRequest sanitizes hostile bytes and stays within 120 columns', () => {
  const entry = { name: 'x', file: 'x', issue: 1, stamp: '20260907T120000Z', template: `${String.fromCharCode(0x1b)}[31m${'t'.repeat(200)}`, provider: 'p', createdAt: '', generatedFile: undefined };
  const text = describeRequest(entry);
  assert.ok(text.length <= 120);
  assert.ok(!text.includes(String.fromCharCode(0x1b)));
});

test('loadRequest returns ok, unreadable and malformed as named outcomes', () => {
  const good = JSON.stringify(packet(7));
  const files = { '7-20260907T120000Z.json': good, '7-20260907T120000Z.md': 'generated\n' };
  const fs = fakeFs(files);
  const [entry] = listRequests(DIR, 7, fs).entries;
  const loaded = loadRequest(entry, fs);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.packet.task.number, 7);
  assert.equal(loaded.generated, 'generated\n');
  assert.equal(loaded.entry, entry);

  assert.deepEqual(loadRequest(entry, fakeFs({})), { ok: false, reason: 'packet unreadable' });
  assert.deepEqual(loadRequest(entry, fakeFs({ '7-20260907T120000Z.json': '{oops' })), { ok: false, reason: 'packet malformed' });
  assert.deepEqual(loadRequest(entry, fakeFs({ '7-20260907T120000Z.json': JSON.stringify(packet(8)) })), { ok: false, reason: 'packet malformed' });
});

test('generated text is kept only when non-empty and composer-safe', () => {
  const good = JSON.stringify(packet(7));
  const load = (md) => {
    const fs = fakeFs({ '7-20260907T120000Z.json': good, '7-20260907T120000Z.md': md });
    const [entry] = listRequests(DIR, 7, fs).entries;
    return loadRequest(entry, fs);
  };
  assert.equal(load('plain ascii\nsecond line\n').generated, 'plain ascii\nsecond line\n');
  assert.equal(load('').generated, undefined, 'empty');
  assert.equal(load('café\n').generated, undefined, 'non-ASCII');
  assert.equal(load('a\r\nb').generated, undefined, 'CR');
  assert.equal(load('tab\there').generated, undefined, 'tab');
  assert.equal(load(undefined).generated, undefined, 'unreadable sibling');
});

test('draftFor prefers the generated text and otherwise builds the deterministic draft', () => {
  const good = JSON.stringify(packet(7));
  const withMd = fakeFs({ '7-20260907T120000Z.json': good, '7-20260907T120000Z.md': 'generated\n' });
  const without = fakeFs({ '7-20260907T120000Z.json': good });
  const a = loadRequest(listRequests(DIR, 7, withMd).entries[0], withMd);
  const b = loadRequest(listRequests(DIR, 7, without).entries[0], without);
  assert.equal(draftFor(a, CONTEXT), 'generated\n');
  const draft = draftFor(b, CONTEXT);
  assert.ok(draft.includes('#7'));
  assert.ok(draft.length > 100);
  assert.equal(draftFor(b, CONTEXT), draft, 'deterministic');
});
