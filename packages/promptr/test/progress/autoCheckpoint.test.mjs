import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
 AUTOCHECK_DEFAULT_INTERVAL_MS, autoCheckEnabled, autoStatusLine, buildAutoWorkState,
 defaultAutoCheckRecord, firstContentLine, formatAutoEntry, hasWork, loadAutoRecordFile,
 maybeAutoCheckpoint, parseAutoCheckRecord, saveAutoRecordFile, shouldAutoCapture,
 workSignature,
} from '../../dist/src/progress/autoCheckpoint.mjs';
import { appendProgress, loadProgress } from '../../dist/src/progress/tracker.mjs';

const STATE = {
 queueCount: 2, queueHead: 'Ship the briefing slice', composerHead: 'Try the companion trial',
 head: 'abc123', dirty: true, changedCount: 3,
};
const IDLE = { queueCount: 0, queueHead: '', composerHead: '', head: 'abc123', dirty: false, changedCount: 0 };

function fixture(t, { sync = 'synced to test history' } = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-autocheck-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const recordFile = path.join(dir, 'autocheck.json');
 const progressFile = path.join(dir, 'progress.json');
 const logFile = path.join(dir, 'promptr.md');
 const calls = [];
 const record = defaultAutoCheckRecord();
 const io = {
  readRecord: () => { calls.push('read'); return { ...record, ...(JSON.parse(JSON.stringify(record))) }; },
  // Mirror file round-trip semantics: keys dropped by JSON stay dropped.
  writeRecord: next => {
   calls.push('write');
   const clean = JSON.parse(JSON.stringify(next));
   for (const k of Object.keys(record)) delete record[k];
   Object.assign(record, clean);
  },
  appendEntry: text => {
   calls.push('append');
   return appendEntryReal(progressFile, logFile, text);
  },
  syncHistory: async text => { calls.push('sync'); if (sync === 'throw') throw new Error('net down'); return sync; },
 };
 return { dir, recordFile, progressFile, logFile, calls, io, record };
}

// Real local save through the existing tracker (no network, no launch).
function appendEntryReal(progressFile, logFile, text) {
 return appendProgress(progressFile, logFile, {
  text, cwd: '/repo/proj', head: 'abc123', ref: 'main', dirty: true, changed: ['a.ts'],
 });
}

test('cadence: first capture immediate, repeats gated by change and interval', () => {
 const interval = 15 * 60_000;
 const t0 = 1_700_000_000_000;
 assert.equal(shouldAutoCapture(defaultAutoCheckRecord(), STATE, t0), true);
 const after = { ...defaultAutoCheckRecord(), lastAt: t0, lastSignature: workSignature(STATE) };
 assert.equal(shouldAutoCapture(after, STATE, t0 + interval), false);
 assert.equal(shouldAutoCapture(after, { ...STATE, queueCount: 3 }, t0 + 1_000), false);
 assert.equal(shouldAutoCapture(after, { ...STATE, queueCount: 3 }, t0 + interval), true);
 assert.equal(shouldAutoCapture(defaultAutoCheckRecord(), IDLE, t0), false);
 assert.equal(shouldAutoCapture(after, IDLE, t0 + interval), false);
});

test('local-first save writes an [auto] progress entry and records the capture', async t => {
 const f = fixture(t);
 const out = await maybeAutoCheckpoint({ state: STATE, nowMs: 1000 }, f.io);
 assert.equal(out.captured, true);
 assert.equal(out.sync, 'synced to test history');
 const entries = loadProgress(f.progressFile).entries;
 assert.equal(entries.length, 1);
 assert.match(entries[0].text, /^\[auto\] working-state snapshot/);
 assert.match(entries[0].text, /goal: Ship the briefing slice/);
 assert.match(entries[0].text, /abc123 \(dirty, 3 changed\) · 2 queued/);
 assert.match(entries[0].text, /next: Try the companion trial/);
 assert.equal(f.record.lastAt, 1000);
 assert.equal(f.record.lastSignature, workSignature(STATE));
 assert.equal(f.record.pendingEntry, undefined);
 assert.ok(fs.readFileSync(f.logFile, 'utf8').includes('[auto]'));
});

test('failed sync keeps the entry locally with visible pending; later settle clears it', async t => {
 const f = fixture(t, { sync: 'throw' });
 const out = await maybeAutoCheckpoint({ state: STATE, nowMs: 1000 }, f.io);
 assert.equal(out.captured, true);
 assert.match(out.sync, /^pending — /);
 assert.match(f.record.pendingEntry, /\[auto\]/);
 assert.equal(loadProgress(f.progressFile).entries.length, 1);
 // Same state: no new capture, but the pending entry retries and clears.
 let mode = 'ok';
 f.io.syncHistory = async () => { f.calls.push('sync'); if (mode === 'ok') return 'synced late'; throw new Error('net down'); };
 const again = await maybeAutoCheckpoint({ state: STATE, nowMs: 2000 }, f.io);
 assert.equal(again.captured, false);
 assert.equal(again.sync, 'synced late');
 assert.equal(f.record.pendingEntry, undefined);
 assert.equal(loadProgress(f.progressFile).entries.length, 1);
 void mode;
});

test('off switch and global kill switch capture nothing and write nothing', async t => {
 const f = fixture(t);
 f.record.enabled = false;
 assert.deepEqual(await maybeAutoCheckpoint({ state: STATE, nowMs: 1 }, f.io), { captured: false, sync: 'local only' });
 const g = fixture(t);
 assert.deepEqual(
  await maybeAutoCheckpoint({ state: STATE, nowMs: 1, env: { PROMPTR_AUTO_CHECKPOINTS: '0' } }, g.io),
  { captured: false, sync: 'local only' });
 assert.deepEqual(g.calls.filter(c => c === 'append'), []);
 assert.equal(loadProgress(g.progressFile).entries.length, 0);
});

test('capture touches only record/entry/sync channels: no send, launch, or exec surface', async t => {
 const f = fixture(t);
 await maybeAutoCheckpoint({ state: STATE, nowMs: 1 }, f.io);
 for (const c of f.calls) assert.ok(['read', 'write', 'append', 'sync'].includes(c), c);
 const here = path.dirname(fileURLToPath(import.meta.url));
 const src = fs.readFileSync(path.join(here, '../../dist/src/progress/autoCheckpoint.mjs'), 'utf8');
 for (const banned of ['child_process', 'sendUserMessage', 'herdr', 'execFile', 'spawn', 'agent prompt', 'agent start']) {
  assert.ok(!src.includes(banned), `must not reference ${banned}`);
 }
});

test('status line shows switch, cadence, last capture, and truncated sync', () => {
 assert.match(autoStatusLine(defaultAutoCheckRecord()), /on · every 15m · no capture yet · local only/);
 assert.match(autoStatusLine({ ...defaultAutoCheckRecord(), enabled: false }), /^Auto-checkpoints: off/);
 assert.match(autoStatusLine(defaultAutoCheckRecord(), { PROMPTR_AUTO_CHECKPOINTS: '0' }), /off \(disabled by PROMPTR_AUTO_CHECKPOINTS\)/);
 assert.match(autoStatusLine(defaultAutoCheckRecord(), { PROMPTR_AUTO_CHECKPOINTS: '1' }), /on · every 15m/);
 const withLast = autoStatusLine({ ...defaultAutoCheckRecord(), lastAt: Date.parse('2026-09-07T06:12:00Z'), lastSync: 'synced to x history' });
 assert.match(withLast, /last 06:12Z · synced to x history/);
 const long = autoStatusLine({ ...defaultAutoCheckRecord(), lastSync: `pending — ${'y'.repeat(200)}` });
 assert.ok(long.length < 160);
});

test('settings tolerate corruption and clamp intervals; round-trip through file', t => {
 const f = fixture(t);
 assert.deepEqual(parseAutoCheckRecord(undefined), defaultAutoCheckRecord());
 assert.deepEqual(parseAutoCheckRecord('{nope'), defaultAutoCheckRecord());
 assert.equal(parseAutoCheckRecord('{"intervalMs":1000}').intervalMs, AUTOCHECK_DEFAULT_INTERVAL_MS);
 assert.equal(parseAutoCheckRecord('{"intervalMs":30}').intervalMs, AUTOCHECK_DEFAULT_INTERVAL_MS);
 assert.equal(parseAutoCheckRecord('{"intervalMs":3600000,"enabled":false}').intervalMs, 3600000);
 assert.equal(autoCheckEnabled(defaultAutoCheckRecord(), {}), true);
 assert.equal(autoCheckEnabled(defaultAutoCheckRecord(), { PROMPTR_AUTO_CHECKPOINTS: 'OFF' }), false);
 saveAutoRecordFile(f.recordFile, { ...defaultAutoCheckRecord(), enabled: false });
 assert.equal(loadAutoRecordFile(f.recordFile).enabled, false);
});

test('entry format degrades honestly with empty state and truncates long text', () => {
 const empty = formatAutoEntry({ queueCount: 0, queueHead: '', composerHead: '', head: 'unknown', dirty: false, changedCount: 0 });
 assert.match(empty, /no queued goal/);
 assert.match(empty, /git state unknown/);
 assert.match(empty, /no draft next action/);
 assert.ok(hasWork(STATE) && !hasWork(IDLE));
 assert.equal(firstContentLine('\n\n  hello world  \nsecond'), 'hello world');
 assert.equal(buildAutoWorkState({ queueTexts: ['  Goal here\nmore'], composerText: '', head: 'h', dirty: false, changedCount: 0 }).queueHead, 'Goal here');
 const big = formatAutoEntry({ ...STATE, queueHead: 'g'.repeat(2000) });
 assert.ok(big.length <= 601);
});
