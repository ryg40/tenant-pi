import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 HANDOFF_HEADINGS, buildHandoffAuthorPrompt, buildHandoffEvidence, buildSuccessorPrompt, handoffSyncMarker,
 parseReceipt, resolveHandoffRuntime, successorLabel, successorName, validateHandoff,
} from '../../dist/src/handoff/packet.mjs';

const RUNTIME = { provider: 'example-provider', model: 'vendor/example-model-1.3', thinking: 'medium', source: 'ctx' };

function fixture(over = {}) {
 const sections = Object.fromEntries(HANDOFF_HEADINGS.map(h => [h, `- ${h} body`]));
 Object.assign(sections, over);
 const lines = ['# Promptr handoff - proj - 2026-09-08T10:00:00Z', ''];
 for (const h of HANDOFF_HEADINGS) {
  if (sections[h] === null) continue;
  lines.push(`## ${h}`, sections[h], '');
 }
 return lines.join('\n');
}

test('evidence carries runtime triple + source, tokens, focus, git and queue', () => {
 const text = buildHandoffEvidence({
  slug: 'proj', cwd: '/repo', ref: 'main', head: 'abc123', dirty: true, changed: ['a.ts'],
  progress: [{ id: 'c1', at: '2026-09-08T09:00:00Z', text: 'did x', cwd: '/repo', head: 'abc123', ref: 'main', dirty: false, changed: [] }],
  queueTexts: ['queued one'], runtime: RUNTIME, sessionFile: '/s/file.jsonl', sessionId: 'sess',
  observedTokens: 201_000, focus: 'trial run', at: '2026-09-08T10:00:00Z',
 });
 for (const needle of ['example-provider', 'vendor/example-model-1.3', 'medium', 'runtime source: ctx', '201000', 'trial run', 'queued one', 'abc123', 'did x', '/s/file.jsonl']) {
  assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
 }
 const unknown = buildHandoffEvidence({
  slug: 'p', cwd: '/r', ref: '', head: 'h', dirty: false, changed: [], progress: [], queueTexts: [],
  runtime: undefined, sessionFile: '', sessionId: '', observedTokens: undefined, at: 'now',
 });
 assert.match(unknown, /runtime: UNKNOWN/);
 assert.match(unknown, /observed context tokens: UNKNOWN/);
});

test('author and successor prompts name only paths/name and are ASCII', () => {
 const prompt = buildHandoffAuthorPrompt('/h/x.evidence.md', '/h/x.md', 'x');
 assert.match(prompt, /promptr-handoff/);
 assert.match(prompt, /\/h\/x\.evidence\.md/);
 assert.match(prompt, /\/h\/x\.md/);
 assert.match(prompt, /HANDOFF READY x/);
 assert.match(prompt, /^[\x20-\x7e]+$/);
 const succ = buildSuccessorPrompt('x', '/h/x.md', '/s/file.jsonl');
 assert.match(succ, /How to continue/);
 assert.match(succ, /git status --short --branch/);
 assert.match(succ, /read-only/);
 assert.match(succ, /^[\x20-\x7e]+$/);
});

test('validateHandoff accepts the full fixture', () => {
 assert.deepEqual(validateHandoff(fixture()), { ok: true });
 assert.equal(HANDOFF_HEADINGS.length, 10);
});

test('validateHandoff rejects missing heading, wrong order, oversize, control chars, BLOCKED first line, empty continue', () => {
 const missing = validateHandoff(fixture({ 'Do not repeat': null }));
 assert.equal(missing.ok, false);
 assert.match(missing.reason, /missing heading "Do not repeat"/);
 const swapped = fixture().replace('## Done this session', '## TMP').replace('## Decisions and rationale', '## Done this session').replace('## TMP', '## Decisions and rationale');
 const order = validateHandoff(swapped);
 assert.equal(order.ok, false);
 assert.match(order.reason, /out of order/);
 const big = validateHandoff(fixture({ 'Done this session': 'x'.repeat(70 * 1024) }));
 assert.equal(big.ok, false);
 assert.match(big.reason, /exceeds/);
 const ctrl = validateHandoff(fixture({ 'Done this session': 'bad \x1b[31m red' }));
 assert.equal(ctrl.ok, false);
 assert.match(ctrl.reason, /control/);
 const blocked = validateHandoff('HANDOFF BLOCKED x no context\n' + fixture());
 assert.equal(blocked.ok, false);
 assert.match(blocked.reason, /first line/);
 const empty = validateHandoff(fixture({ 'How to continue': '' }));
 assert.equal(empty.ok, false);
 assert.match(empty.reason, /How to continue/);
 assert.equal(validateHandoff(undefined).ok, false);
 assert.equal(validateHandoff('   ').ok, false);
});

test('resolveHandoffRuntime prefers ctx over env and refuses partial triples', () => {
 const env = { PI_PROVIDER: 'envp', PI_MODEL: 'envm', PI_REASONING_LEVEL: 'low' };
 assert.deepEqual(resolveHandoffRuntime({ model: { provider: 'ctxp', id: 'ctxm' }, thinkingLevel: 'high', env }),
  { provider: 'ctxp', model: 'ctxm', thinking: 'high', source: 'ctx' });
 assert.deepEqual(resolveHandoffRuntime({ model: { provider: 'ctxp', id: 'ctxm' }, thinkingLevel: undefined, env }),
  { provider: 'envp', model: 'envm', thinking: 'low', source: 'env' });
 assert.equal(resolveHandoffRuntime({ model: { provider: 'ctxp' }, env: { PI_PROVIDER: 'p', PI_MODEL: 'm' } }), undefined);
 assert.equal(resolveHandoffRuntime({ env: {} }), undefined);
 assert.equal(resolveHandoffRuntime({ model: { provider: ' ', id: 'm' }, thinkingLevel: 'low', env: {} }), undefined);
});

test('successorName is <=32 chars, lowercase Herdr-safe and text-dependent; label is ASCII', () => {
 const at = new Date('2026-09-08T14:05:09Z');
 const a = successorName('handoff A', at);
 const b = successorName('handoff B', at);
 assert.match(a, /^[a-z][a-z0-9_-]*$/);
 assert.ok(a.length <= 32);
 assert.match(a, /^promptr-hand-[0-9a-f]{8}-140509$/);
 assert.notEqual(a, b);
 const label = successorLabel('proj-é', at);
 assert.match(label, /^[\x20-\x7e]+$/);
 assert.match(label, /1405$/);
 assert.match(handoffSyncMarker('n', '2026-09-08T14:05:09Z', RUNTIME), /^<!-- promptr:handoff n 2026-09-08T14:05:09Z example-provider\/vendor\/example-model-1\.3:medium -->$/);
 assert.match(handoffSyncMarker('n', 'iso', undefined), /UNKNOWN/);
});

test('parseReceipt accepts the v1 shape and rejects malformed input', () => {
 const ok = { version: 1, name: 'n', state: 'requested', sessionId: 's', leafId: 'l', requestedAt: 'now', evidence: '/e', target: '/t' };
 assert.deepEqual(parseReceipt(JSON.stringify(ok)), ok);
 assert.equal(parseReceipt(JSON.stringify({ ...ok, state: 'weird' })), undefined);
 assert.equal(parseReceipt(JSON.stringify({ ...ok, version: 2 })), undefined);
 assert.equal(parseReceipt('not json'), undefined);
 assert.equal(parseReceipt(undefined), undefined);
});
