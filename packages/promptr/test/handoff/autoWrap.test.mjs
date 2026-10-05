import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
 WRAP_THRESHOLD_TOKENS, autoWrapFilename, buildAutoWrapPrompt, claimAutoWrap,
 currentTokensOf, runAutoWrap, shouldAutoWrap,
} from '../../dist/src/handoff/autoWrap.mjs';
import { historyDocName } from '../../dist/src/briefing/openknowledge.mjs';

const SNAP = { ref: 'main', head: 'abc123', dirty: true, changed: ['a.ts'] };

function io(t, { review = true, choice = 'save', sync = 'synced to test history', launch = true, writeThrows = false } = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-wrap-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const calls = { review: 0, choose: 0, launch: 0, sync: 0 };
 const notices = [];
 const launched = [];
 return {
  dir, calls, notices, launched,
  input: (over = {}) => ({
   tokens: 200_000, sessionId: 'sess-1', cwd: dir, slug: 'proj-x', handoffsDir: dir,
   snapshot: SNAP, progress: [], queueTexts: [], provider: 'example-provider', model: 'm', thinking: 'xhigh',
   ...over,
  }),
  env: (triggered = new Set()) => ({
   triggered,
   writeHandoff: (d, name, text) => {
    if (writeThrows) throw new Error('disk full');
    fs.writeFileSync(path.join(d, name), text + '\n');
   },
   appendLog: () => {},
   syncHistory: async text => { calls.sync++; assert.match(text, /AUTOMATIC 200k-context/); return sync; },
   ui: {
    review: async text => { calls.review++; assert.match(text, /AUTOMATIC 200k-context/); return review; },
    choose: async title => { calls.choose++; assert.match(title, /Save for later/); return choice; },
    notify: (message, level) => notices.push([message, level ?? 'info']),
   },
   launchFresh: async text => { calls.launch++; launched.push(text); if (launch === 'throw') throw new Error('herdr down'); return launch; },
  }),
 };
}

test('threshold constant and token normalization never substitute cumulative usage', () => {
 assert.equal(WRAP_THRESHOLD_TOKENS, 200_000);
 assert.equal(currentTokensOf({ tokens: 200_000 }), 200_000);
 assert.equal(currentTokensOf({ tokens: null }), undefined);
 assert.equal(currentTokensOf(undefined), undefined);
 assert.equal(currentTokensOf(null), undefined);
 assert.equal(currentTokensOf({}), undefined);
 assert.equal(currentTokensOf({ tokens: NaN }), undefined);
 assert.equal(currentTokensOf({ tokens: '200000' }), undefined);
});

test('trigger fires only on observed at-or-above readings, once per session', () => {
 assert.equal(shouldAutoWrap(199_999, false), false);
 assert.equal(shouldAutoWrap(200_000, false), true);
 assert.equal(shouldAutoWrap(250_000, false), true);
 assert.equal(shouldAutoWrap(undefined, false), false);
 assert.equal(shouldAutoWrap(300_000, true), false);
 const set = new Set();
 assert.equal(claimAutoWrap(set, 'a'), true);
 assert.equal(claimAutoWrap(set, 'a'), false);
 assert.equal(claimAutoWrap(set, 'b'), true);
});

test('below threshold and unknown readings skip without touching disk or ui', async t => {
 for (const tokens of [199_999, undefined]) {
  const f = io(t);
  const env = f.env();
  assert.equal(await runAutoWrap(f.input({ tokens }), env), 'skipped');
  assert.deepEqual(fs.readdirSync(f.dir), []);
  assert.deepEqual([f.calls.review, f.calls.choose, f.calls.launch, f.calls.sync], [0, 0, 0, 0]);
  assert.equal(env.triggered.size, 0);
 }
});

test('second run in the same session skips; a new session proceeds', async t => {
 const f = io(t);
 const env = f.env();
 assert.equal(await runAutoWrap(f.input(), env), 'saved');
 assert.equal(f.calls.launch, 0);
 assert.equal(await runAutoWrap(f.input(), env), 'skipped');
 assert.equal(f.calls.choose, 1);
 assert.equal(await runAutoWrap(f.input({ sessionId: 'sess-2' }), env), 'saved');
 assert.equal(f.calls.choose, 2);
});

test('Save for later retains the handoff and launches nothing', async t => {
 const f = io(t);
 const env = f.env();
 assert.equal(await runAutoWrap(f.input(), env), 'saved');
 const files = fs.readdirSync(f.dir).filter(n => n.endsWith('.md'));
 assert.equal(files.length, 1);
 assert.match(files[0], /^200k-.*\.md$/);
 assert.match(fs.readFileSync(path.join(f.dir, files[0]), 'utf8'), /AUTOMATIC 200k-context wrap-up/);
 assert.equal(f.calls.launch, 0);
 assert.match(f.notices.map(n => n[0]).join('\n'), /waiting for a choice|Nothing launched/);
});

test('Esc at review and Esc at choice both save without launching', async t => {
 const f = io(t, { review: false });
 assert.equal(await runAutoWrap(f.input(), f.env()), 'saved');
 assert.equal(f.calls.choose, 0);
 assert.equal(f.calls.launch, 0);
 const g = io(t, { choice: undefined });
 assert.equal(await runAutoWrap(g.input(), g.env()), 'saved');
 assert.equal(g.calls.launch, 0);
});

test('Continue now submits once and reports continued', async t => {
 const f = io(t, { choice: 'continue', launch: true });
 assert.equal(await runAutoWrap(f.input(), f.env()), 'continued');
 assert.equal(f.calls.launch, 1);
 assert.match(f.launched[0], /AUTOMATIC 200k-context wrap-up/);
});

test('launch refusal and launch failure both retain the handoff with no retry', async t => {
 const f = io(t, { choice: 'continue', launch: false });
 assert.equal(await runAutoWrap(f.input(), f.env()), 'saved');
 assert.equal(f.calls.launch, 1);
 assert.equal(fs.readdirSync(f.dir).filter(n => n.endsWith('.md')).length, 1);
 const g = io(t, { choice: 'continue', launch: 'throw' });
 const env = g.env();
 assert.equal(await runAutoWrap(g.input(), env), 'saved');
 assert.equal(g.calls.launch, 1);
 assert.equal(fs.readdirSync(g.dir).filter(n => n.endsWith('.md')).length, 1);
 assert.match(g.notices.map(n => n[0]).join('\n'), /No retry/);
 // Claimed trigger means even the failed session never auto-retries.
 assert.equal(await runAutoWrap(g.input(), env), 'skipped');
});

test('pending history sync does not block the choice; write failure notifies and launches nothing', async t => {
 const f = io(t, { sync: 'pending — offline; handoff retained locally' });
 assert.equal(await runAutoWrap(f.input(), f.env()), 'saved');
 assert.equal(f.calls.choose, 1);
 const g = io(t, { writeThrows: true });
 assert.equal(await runAutoWrap(g.input(), g.env()), 'saved');
 assert.match(g.notices.map(n => n[0]).join('\n'), /could not be persisted/);
 assert.equal(g.calls.launch, 0);
});

test('prompt carries observed reading, threshold, runtime and git state', () => {
 const text = buildAutoWrapPrompt({
  slug: 's', cwd: '/repo', snapshot: SNAP, progress: [], queueTexts: ['q1'],
  provider: 'example-provider', model: 'm', thinking: 'xhigh', observedTokens: 200_001,
 });
 assert.match(text, /AUTOMATIC 200k-context wrap-up/);
 assert.match(text, /200001/);
 assert.match(text, /200000/);
 assert.match(text, /example-provider \/ m \/ xhigh/);
 assert.match(text, /abc123/);
 assert.match(autoWrapFilename(new Date('2026-09-07T06:00:00Z'), 'ab'), /^200k-2026-09-07T06-00-00-ab\.md$/);
});

test('history page derives from the briefing target; non-brief targets refuse', () => {
 assert.equal(historyDocName('projects/promptr/brief'), 'projects/promptr/handoffs');
 assert.throws(() => historyDocName('projects/promptr/other'), /brief/);
});

test('Phase A hook: busy source falls back to the deterministic packet with a notice', async t => {
 const f = io(t);
 const env = f.env();
 const requests = [];
 env.requestHandoff = async focus => { requests.push(focus); return true; };
 assert.equal(await runAutoWrap(f.input({ sourceIdle: false }), env), 'saved');
 assert.equal(requests.length, 0);
 assert.equal(fs.readdirSync(f.dir).filter(n => n.endsWith('.md')).length, 1);
 assert.match(f.notices.map(n => n[0]).join('\n'), /Coordinator busy: deterministic wrap-up saved; run \/handoffr when idle/);
});

test('Phase A hook: idle source requests the Coordinator-authored handoff once per session, no deterministic file', async t => {
 const f = io(t);
 const env = f.env();
 const requests = [];
 env.requestHandoff = async focus => { requests.push(focus); return true; };
 assert.equal(await runAutoWrap(f.input({ sourceIdle: true }), env), 'requested');
 assert.deepEqual(requests, ['AUTOMATIC 200k-context wrap-up (observed 200000 tokens)']);
 assert.deepEqual(fs.readdirSync(f.dir), []);
 assert.deepEqual([f.calls.review, f.calls.choose, f.calls.launch, f.calls.sync], [0, 0, 0, 0]);
 assert.equal(await runAutoWrap(f.input({ sourceIdle: true }), env), 'skipped');
 assert.equal(requests.length, 1);
 // A failed request falls back to the deterministic packet in a new session.
 env.requestHandoff = async () => false;
 assert.equal(await runAutoWrap(f.input({ sourceIdle: true, sessionId: 'sess-2' }), env), 'saved');
 assert.equal(fs.readdirSync(f.dir).filter(n => n.endsWith('.md')).length, 1);
});
