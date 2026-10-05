// Catch-Me-Up digest: pure window, render, packet copy, parse and diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCHUP_FRESH_MS, MARKDOWN_LIMIT, PACKET_MARKDOWN_LIMIT, catchUpForPacket, catchUpSummaryLine, diffIssues, emptyDigest,
  isCatchUpFresh, parseCatchUpDigest, renderCatchUpMarkdown, resolveWindow,
} from '../../dist/src/tracking/catchup.mjs';
import { hostile } from '../tracking-navigation/fixtures.mjs';

const NOW = '2026-09-08T12:00:00.000Z';
const H = 60 * 60 * 1000;
const ms = (iso) => Date.parse(iso);

const HEADINGS = [
  '# Catch-Me-Up — ',
  '## Window and sources',
  '## Tracker activity',
  '## Repository',
  '## Worktrees and workers',
  '## Handoffs and continuation',
  '## Briefs, inbox and workspace',
  '## Checkpoints and log',
  '## Gaps and staleness',
];

function digest(overrides = {}) {
  const d = emptyDigest('promptr-abc', '/work/promptr', NOW, resolveWindow(undefined, NOW));
  return Object.assign(d, overrides);
}

test('resolveWindow: default 72 h, cursor, explicit relative and ISO, 14 d cap', () => {
  const dflt = resolveWindow(undefined, NOW);
  assert.equal(dflt.reason, 'default');
  assert.equal(ms(NOW) - ms(dflt.since), 72 * H);
  assert.equal(dflt.until, NOW);
  const cursor = resolveWindow('2026-09-08T06:00:00Z', NOW);
  assert.equal(cursor.reason, 'cursor');
  assert.equal(ms(NOW) - ms(cursor.since), 6 * H);
  const rel = resolveWindow('2026-09-08T06:00:00Z', NOW, '48h');
  assert.equal(rel.reason, 'explicit');
  assert.equal(ms(NOW) - ms(rel.since), 48 * H);
  const days = resolveWindow(undefined, NOW, '7d');
  assert.equal(ms(NOW) - ms(days.since), 7 * 24 * H);
  const iso = resolveWindow(undefined, NOW, '2026-09-07T00:00:00Z');
  assert.equal(iso.since, '2026-09-07T00:00:00.000Z');
  assert.equal(iso.reason, 'explicit');
  const capped = resolveWindow('2026-01-01T00:00:00Z', NOW);
  assert.equal(ms(NOW) - ms(capped.since), 14 * 24 * H, 'old cursor capped at 14 d');
  assert.equal(ms(NOW) - ms(resolveWindow(undefined, NOW, '90d').since), 14 * 24 * H, 'explicit capped at 14 d');
  assert.equal(resolveWindow('garbage', NOW).reason, 'default');
  assert.equal(resolveWindow(undefined, NOW, 'soon').reason, 'default', 'unparseable explicit falls back');
  assert.equal(resolveWindow(undefined, NOW, '2027-01-01T00:00:00Z').since, NOW, 'never reaches past now');
});

test('renderCatchUpMarkdown: fixed heading order, newest first, sanitized', () => {
  const d = digest();
  d.tracker.issues = [
    { number: 1, title: 'older', state: 'open', labels: [], updatedAt: '2026-09-07T00:00:00Z', url: 'u', changed: ['body'] },
    { number: 2, title: `newer ${hostile('x')}`, state: 'closed', labels: ['bug'], updatedAt: '2026-09-08T00:00:00Z', url: 'u', changed: ['closed'] },
  ];
  d.repo.commits = [
    { hash: 'aaaaaaaaaaaa', date: '2026-09-07T01:00:00Z', subject: 'first' },
    { hash: 'bbbbbbbbbbbb', date: '2026-09-08T01:00:00Z', subject: 'second' },
  ];
  d.gaps = ['tracker (gitea) issues: unreachable (401)'];
  const md = renderCatchUpMarkdown(d);
  let last = -1;
  for (const heading of HEADINGS) {
    const at = md.indexOf(heading);
    assert.ok(at > last, `${heading} in order`);
    last = at;
  }
  assert.ok(md.indexOf('#2 closed') < md.indexOf('#1 open'), 'issues newest first');
  assert.ok(md.indexOf('bbbbbbbbbbbb') < md.indexOf('aaaaaaaaaaaa'), 'commits newest first');
  assert.ok(!md.includes('\x1b') && !md.includes('‮'), 'hostile bytes stripped');
  assert.match(md, /unreachable \(401\)/);
  assert.ok(md.length <= MARKDOWN_LIMIT);
});

test('renderCatchUpMarkdown: truncation keeps the Gaps section and names the cut', () => {
  const d = digest();
  d.repo.commits = Array.from({ length: 200 }, (_, i) => ({ hash: `c${String(i).padStart(11, '0')}`, date: NOW, subject: 'x'.repeat(190) }));
  d.gaps = ['existing gap'];
  const md = renderCatchUpMarkdown(d);
  assert.ok(md.length <= MARKDOWN_LIMIT, `cut to ${MARKDOWN_LIMIT}`);
  assert.match(md, /\[truncated\]/);
  const gapsAt = md.lastIndexOf('## Gaps and staleness');
  assert.ok(gapsAt > 0);
  assert.match(md.slice(gapsAt), /existing gap/);
  assert.match(md.slice(gapsAt), /rendered Markdown cut at 24000 chars/);
});

test('catchUpForPacket bounds the Markdown to 16,000 chars and carries counts', () => {
  const d = digest();
  d.repo.commits = Array.from({ length: 200 }, (_, i) => ({ hash: `c${String(i).padStart(11, '0')}`, date: NOW, subject: 'y'.repeat(190) }));
  d.worktrees = [{ path: '/w', branch: 'b', head: 'h', dirty: false }];
  d.handoffs.local = [{ name: 'h', mtime: NOW, title: 't', firstStep: '' }];
  const packet = catchUpForPacket(d);
  assert.ok(packet.markdown.length <= PACKET_MARKDOWN_LIMIT);
  assert.equal(packet.since, d.window.since);
  assert.equal(packet.generatedAt, NOW);
  assert.deepEqual(packet.counts, { issues: 0, comments: 0, commits: 200, worktrees: 1, handoffs: 1, gaps: 0 });
  assert.match(packet.summary, /^catch-up .* · 0 issues · 1 worktree · 1 handoff$/);
});

test('catchUpSummaryLine with a clock shows an age', () => {
  const d = digest();
  assert.equal(catchUpSummaryLine(d, ms(NOW) + 2 * H), 'catch-up 2h ago · 0 issues · 0 worktrees · 0 handoffs');
  assert.equal(catchUpSummaryLine(d, ms(NOW) + 30_000), 'catch-up just now · 0 issues · 0 worktrees · 0 handoffs');
});

test('isCatchUpFresh: 24 h boundary, future and garbage stamps', () => {
  assert.equal(isCatchUpFresh(NOW, ms(NOW) + CATCHUP_FRESH_MS), true);
  assert.equal(isCatchUpFresh(NOW, ms(NOW) + CATCHUP_FRESH_MS + 1), false);
  assert.equal(isCatchUpFresh(NOW, ms(NOW) - 1), false, 'a future stamp is not fresh');
  assert.equal(isCatchUpFresh('nope', ms(NOW)), false);
});

test('parseCatchUpDigest tolerates garbage and round-trips a digest', () => {
  for (const raw of [undefined, null, '', '{', '[]', '{"version":2}', '{"version":1,"kind":"other"}', 42, { version: 1, kind: 'promptr-catchup', tracker: 'no' }]) {
    assert.doesNotThrow(() => parseCatchUpDigest(raw));
  }
  assert.equal(parseCatchUpDigest('{'), undefined);
  const partial = parseCatchUpDigest({ version: 1, kind: 'promptr-catchup', tracker: 'no', gaps: ['a', 3] });
  assert.equal(partial.tracker.reachable, false);
  assert.deepEqual(partial.gaps, ['a']);
  const d = digest();
  d.tracker.issues = [{ number: 5, title: `t${hostile('z')}`, state: 'open', labels: ['a'], updatedAt: NOW, url: 'u', changed: ['opened', 'bogus'] }];
  d.worktrees = [{ path: '/w', lane: 'catchup', wave: 'round3', branch: 'wave/catchup', head: 'abc', dirty: true, taskResult: { present: true, complete: true, firstLine: 'Status', mtime: NOW } }];
  const back = parseCatchUpDigest(JSON.stringify(d));
  assert.equal(back.slug, 'promptr-abc');
  assert.deepEqual(back.tracker.issues[0].changed, ['opened']);
  assert.ok(!back.tracker.issues[0].title.includes('\x1b'));
  assert.equal(back.worktrees[0].taskResult.complete, true);
  assert.equal(back.window.reason, 'default');
});

test('diffIssues flags opened, closed, labels, body and comments', () => {
  const previous = [
    { number: 1, title: 'a', state: 'open', milestone: 'm', labels: ['x'], url: 'u', updatedAt: '2026-09-01T00:00:00Z' },
    { number: 2, title: 'b', state: 'open', milestone: 'm', labels: ['x'], url: 'u', updatedAt: '2026-09-01T00:00:00Z' },
    { number: 3, title: 'c', state: 'open', milestone: 'm', labels: ['x'], url: 'u', updatedAt: '2026-09-01T00:00:00Z' },
  ];
  const cur = (number, state, labels, updatedAt = '2026-09-08T00:00:00Z') => ({ number, title: 't', state, labels, updatedAt, url: 'u' });
  const out = diffIssues(previous, [
    cur(1, 'closed', ['x']),
    cur(2, 'open', ['x', 'y']),
    cur(3, 'open', ['x']),
    cur(4, 'open', []),
    cur(5, 'closed', []),
  ], new Set([3, 4]));
  const by = Object.fromEntries(out.map((i) => [i.number, i.changed]));
  assert.deepEqual(by[1], ['closed']);
  assert.deepEqual(by[2], ['labels']);
  assert.deepEqual(by[3], ['body', 'comments']);
  assert.deepEqual(by[4], ['opened', 'comments']);
  assert.deepEqual(by[5], ['closed']);
  assert.deepEqual(diffIssues(previous, [cur(3, 'open', ['x'], '2026-09-01T00:00:00Z')])[0].changed, [], 'unchanged issue has no flags');
});
