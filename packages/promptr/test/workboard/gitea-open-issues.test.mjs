// Snapshot open-issue list, cache tolerance and bounded dependency reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OPEN_ISSUES, buildSnapshot, fetchTracking, parseSnapshot, snapshotOpenIssues,
} from '../../dist/src/tracking/gitea.mjs';
import { REPO, fakeFetch, issue, tracked } from '../tracking-navigation/fixtures.mjs';

const NOW = () => '2026-09-07T12:00:00Z';

test('buildSnapshot carries every open issue up to the bound, beyond the per-group cap', () => {
  const issues = Array.from({ length: 30 }, (_, i) => tracked(i + 1, { state: i % 5 === 0 ? 'closed' : 'open' }));
  const snap = buildSnapshot(REPO, issues, new Map(), NOW());
  assert.equal(snap.openIssues.length, 24);
  assert.ok(snap.groups.every((g) => g.openIssues.length <= 10));
  assert.deepEqual(snapshotOpenIssues(snap).map((i) => i.number), issues.filter((i) => i.state === 'open').map((i) => i.number));
  const many = buildSnapshot(REPO, Array.from({ length: 200 }, (_, i) => tracked(i + 1)), new Map(), NOW());
  assert.equal(many.openIssues.length, MAX_OPEN_ISSUES);
});

test('snapshotOpenIssues falls back to capped, deduped group rows when the list is absent or empty', () => {
  const groups = [
    { name: 'A', open: 2, closed: 0, total: 2, progress: 0, openIssues: [tracked(4), tracked(2)] },
    { name: 'B', open: 1, closed: 0, total: 1, progress: 0, openIssues: [tracked(2), tracked(9, { state: 'closed' })] },
  ];
  const base = { version: 1, fetchedAt: NOW(), repo: { ...REPO }, overall: { open: 3, closed: 0, total: 3, progress: 0 }, groups };
  assert.deepEqual(snapshotOpenIssues(base).map((i) => i.number), [2, 4]);
  assert.deepEqual(snapshotOpenIssues({ ...base, openIssues: [] }).map((i) => i.number), [2, 4]);
  const list = snapshotOpenIssues({ ...base, openIssues: [tracked(7)] });
  assert.deepEqual(list.map((i) => i.number), [7]);
  list.push(tracked(8));
  assert.equal(base.openIssues, undefined);
});

test('parseSnapshot tolerates an older cache without openIssues and validates one with it', () => {
  const raw = {
    version: 1, fetchedAt: NOW(), repo: { ...REPO },
    overall: { open: 1, closed: 0, total: 1, progress: 0 },
    groups: [{ name: 'A', open: 1, closed: 0, total: 1, progress: 0, openIssues: [tracked(3)] }],
  };
  const old = parseSnapshot(raw);
  assert.ok(old);
  assert.equal(old.openIssues, undefined);
  assert.deepEqual(snapshotOpenIssues(old).map((i) => i.number), [3]);
  const fresh = parseSnapshot({
    ...raw,
    openIssues: [
      tracked(3, { assignee: 'example-owner', updatedAt: '2026-09-01T10:00:00Z', blockers: 2 }),
      tracked(5, { state: 'closed' }),
      { number: 'nope' },
      tracked(6, { blockers: -1, assignee: 42 }),
    ],
  });
  assert.ok(fresh);
  assert.deepEqual(fresh.openIssues.map((i) => i.number), [3, 6]);
  assert.equal(fresh.openIssues[0].assignee, 'example-owner');
  assert.equal(fresh.openIssues[0].blockers, 2);
  assert.equal(fresh.openIssues[0].updatedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(fresh.openIssues[1].blockers, undefined);
  assert.equal(fresh.openIssues[1].assignee, undefined);
});

test('fetchTracking withBlockers reads one bounded dependency GET per open issue', async () => {
  const list = [
    issue(1, { assignee: { login: 'example-owner' } }),
    issue(2),
    issue(3, { state: 'closed' }),
    issue(4),
    issue(5),
  ];
  const fetchFn = fakeFetch({
    '/milestones': [],
    '/issues/1/dependencies': [],
    '/issues/2/dependencies': [{ number: 8, state: 'open', title: 'dep' }, { number: 9, state: 'closed', title: 'done' }],
    '/issues/4/dependencies': { __status: 500 },
    '/issues/5/dependencies': [{ number: 'bad' }],
    '/issues?': (url) => (url.includes('page=1') ? list : []),
  });
  const snap = await fetchTracking({ repo: REPO, fetchFn, now: NOW, withBlockers: true, maxPages: 1 });
  const depCalls = fetchFn.calls.filter((c) => c.url.includes('/dependencies'));
  assert.equal(depCalls.length, 4, 'one read per open issue, none for the closed one');
  for (const n of [1, 2, 4, 5]) assert.equal(depCalls.filter((c) => c.url.includes(`/issues/${n}/dependencies`)).length, 1);
  const by = Object.fromEntries(snap.openIssues.map((i) => [i.number, i]));
  assert.equal(by[1].blockers, 0);
  assert.equal(by[1].assignee, 'example-owner');
  assert.equal(by[1].updatedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(by[2].blockers, 1, 'only open dependencies count');
  assert.equal(by[4].blockers, undefined, 'a failed read stays unknown');
  assert.equal(by[5].blockers, undefined, 'an incomplete read stays unknown');
  assert.equal(by[3], undefined);
});

test('fetchTracking without withBlockers never touches the dependency endpoint, and the limit bounds reads', async () => {
  const list = Array.from({ length: 6 }, (_, i) => issue(i + 1));
  const plain = fakeFetch({ '/milestones': [], '/dependencies': [], '/issues?': (url) => (url.includes('page=1') ? list : []) });
  const snap = await fetchTracking({ repo: REPO, fetchFn: plain, now: NOW, maxPages: 1 });
  assert.equal(plain.calls.filter((c) => c.url.includes('/dependencies')).length, 0);
  assert.ok(snap.openIssues.every((i) => i.blockers === undefined));
  const bounded = fakeFetch({ '/milestones': [], '/dependencies': [], '/issues?': (url) => (url.includes('page=1') ? list : []) });
  const snap2 = await fetchTracking({ repo: REPO, fetchFn: bounded, now: NOW, maxPages: 1, withBlockers: true, blockerReadLimit: 2 });
  assert.equal(bounded.calls.filter((c) => c.url.includes('/dependencies')).length, 2);
  assert.deepEqual(snap2.openIssues.map((i) => i.blockers), [0, 0, undefined, undefined, undefined, undefined]);
});
