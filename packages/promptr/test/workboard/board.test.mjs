// Workboard classification and ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_STATUS_ORDER, boardSummary, buildWorkBoard, classifyIssue, toBoardIssue,
} from '../../dist/src/tracking/board.mjs';
import { NO_MILESTONE } from '../../dist/src/tracking/gitea.mjs';
import { REPO, hostile, tracked } from '../tracking-navigation/fixtures.mjs';

function snapshot(openIssues, overrides = {}) {
  return {
    version: 1,
    fetchedAt: '2026-09-07T12:00:00Z',
    repo: { ...REPO },
    overall: { open: openIssues.length, closed: 1, total: openIssues.length + 1, progress: 0 },
    groups: [],
    openIssues,
    ...overrides,
  };
}

test('classification precedence: each rule wins over everything below it', () => {
  const table = [
    ['review beats assignee, blockers and later', tracked(1, { labels: ['status:needs-review', 'scope:later'], assignee: 'a', blockers: 3 }), 'review'],
    ['assignee beats blockers and later', tracked(2, { labels: ['scope:later'], assignee: 'a', blockers: 3 }), 'active'],
    ['blockers > 0 beats later', tracked(3, { labels: ['route:follow-up'], blockers: 2 }), 'blocked'],
    ['later label with blockers 0', tracked(4, { labels: ['scope:later'], blockers: 0 }), 'later'],
    ['later label with blockers unknown', tracked(5, { labels: ['route:follow-up'] }), 'later'],
    ['blockers 0 and no label is ready', tracked(6, { blockers: 0 }), 'ready'],
    ['blockers undefined and no label is unknown', tracked(7), 'unknown'],
  ];
  for (const [name, issue, expected] of table) assert.equal(classifyIssue(issue), expected, name);
});

test('unknown is never rendered as ready: an unread graph stays unknown', () => {
  assert.equal(classifyIssue(tracked(1)), 'unknown');
  assert.equal(classifyIssue(tracked(1, { blockers: 0 })), 'ready');
  const board = buildWorkBoard(snapshot([tracked(1), tracked(2, { blockers: 0 })]));
  assert.equal(board.counts.unknown, 1);
  assert.equal(board.counts.ready, 1);
  const unknownRow = board.rows.find((r) => r.kind === 'issue' && r.issue.number === 1);
  assert.equal(unknownRow.issue.blockers, undefined);
});

test('toBoardIssue reads priority, map parent, assignee and defaults', () => {
  const issue = toBoardIssue(tracked(9, {
    labels: ['priority:P2', 'wayfinder:parent:42', 'enhancement'],
    assignee: 'example-owner', blockers: 0, milestone: '', url: 'https://x/9', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  assert.equal(issue.priority, 'P2');
  assert.equal(issue.mapNumber, 42);
  assert.equal(issue.assignee, 'example-owner');
  assert.equal(issue.status, 'active');
  assert.equal(issue.milestone, NO_MILESTONE);
  assert.equal(issue.url, 'https://x/9');
  assert.equal(issue.updatedAt, '2026-09-01T00:00:00.000Z');
  const bare = toBoardIssue(tracked(10));
  assert.equal(bare.priority, '');
  assert.equal(bare.mapNumber, undefined);
  assert.equal(bare.assignee, '');
  assert.equal(bare.updatedAt, '');
  assert.ok(Object.isFrozen(issue) && Object.isFrozen(issue.labels));
});

test('rows: each map ascending with its children beneath it, then a free-standing section with status headings', () => {
  const issues = [
    tracked(50, { labels: ['wayfinder:map'], blockers: 0 }),
    tracked(40, { labels: ['wayfinder:map'] }),
    tracked(7, { blockers: 0, labels: ['priority:P3', 'wayfinder:parent:40'] }),
    tracked(3, { blockers: 0, labels: ['wayfinder:parent:40'] }),
    tracked(5, { blockers: 0, labels: ['priority:P1', 'wayfinder:parent:50'] }),
    tracked(2, { assignee: 'a', labels: ['priority:P2'] }),
    tracked(9, { assignee: 'b', labels: ['priority:P1'] }),
    tracked(11, { labels: ['status:needs-review'] }),
    tracked(1, { state: 'closed', assignee: 'z' }),
  ];
  const board = buildWorkBoard(snapshot(issues, { overall: { open: 17, closed: 5, total: 22, progress: 0 } }));
  const shape = board.rows.map((r) =>
    r.kind === 'map' ? `map${r.number}` : r.kind === 'section' ? `S:${r.label}:${r.count}`
      : r.kind === 'heading' ? `H:${r.status}:${r.count}` : `${r.depth === 1 ? '  ' : ''}#${r.issue.number}`);
  assert.deepEqual(shape, [
    'map40', '  #7', '  #3',
    'map50', '  #5',
    'S:FREE-STANDING:3',
    'H:active:2', '#9', '#2',
    'H:review:1', '#11',
  ]);
  assert.ok(board.rows.filter((r) => r.kind === 'issue' && r.depth === 1).every((r) => r.issue.mapNumber !== undefined));
  assert.equal(board.provider, undefined, 'a snapshot without provider yields no provider field');
  assert.deepEqual(board.counts, { active: 2, ready: 3, review: 1, blocked: 0, later: 0, unknown: 0 });
  const map40 = board.rows[0];
  assert.equal(board.rows[3].kind, 'map');
  assert.equal(map40.childCount, 2);
  assert.deepEqual(map40.counts, { active: 0, ready: 2, review: 0, blocked: 0, later: 0, unknown: 0 });
  assert.equal(board.rows[3].childCount, 1);
  assert.equal(board.openCount, 17, 'openCount is the snapshot overall, not the row count');
  assert.equal(board.summary, '17 open · 2 active · 3 ready · 1 review');
  assert.equal(board.repoLabel, 'owner/promptr');
  assert.equal(board.fetchedAt, '2026-09-07T12:00:00Z');
  assert.equal(board.version, 1);
  assert.ok(Object.isFrozen(board) && Object.isFrozen(board.rows) && Object.isFrozen(board.counts));
  assert.ok(!board.rows.some((r) => r.kind === 'issue' && r.issue.number === 1), 'closed issues never appear');
  assert.ok(!board.rows.some((r) => r.kind === 'issue' && r.issue.labels.includes('wayfinder:map')), 'maps are not issue rows');
});

test('a child of a closed or unknown map is free-standing, and no section row appears without maps', () => {
  const board = buildWorkBoard(snapshot([tracked(8, { blockers: 0, labels: ['wayfinder:parent:999'] }), tracked(2, { blockers: 0 })]));
  assert.deepEqual(board.rows.map((r) => r.kind), ['heading', 'issue', 'issue']);
  assert.deepEqual(board.rows.filter((r) => r.kind === 'issue').map((r) => [r.issue.number, r.depth]), [[2, 0], [8, 0]]);
  assert.equal(board.rows[1].issue.mapNumber === 999 || board.rows[2].issue.mapNumber === 999, true, 'membership label is preserved');
  const withProvider = buildWorkBoard(snapshot([tracked(1)], { repo: { ...REPO, provider: 'github' } }));
  assert.equal(withProvider.provider, 'github');
});

test('zero-count statuses emit no heading and the summary omits them', () => {
  const board = buildWorkBoard(snapshot([tracked(1)]));
  assert.deepEqual(board.rows.map((r) => r.kind), ['heading', 'issue']);
  assert.equal(board.rows[0].status, 'unknown');
  assert.equal(board.summary, '1 open · 1 unknown');
  assert.equal(boardSummary({ active: 0, ready: 0, review: 0, blocked: 0, later: 0, unknown: 0 }, 0), '0 open');
  assert.deepEqual([...WORK_STATUS_ORDER], ['active', 'ready', 'review', 'blocked', 'later', 'unknown']);
});

test('snapshot.openIssues wins over groups; capped groups are the fallback', () => {
  const groups = [{ name: 'S1', open: 1, closed: 0, total: 1, progress: 0, openIssues: [tracked(99, { blockers: 0 })] }];
  const withFull = buildWorkBoard(snapshot([tracked(5, { blockers: 0 })], { groups }));
  assert.deepEqual(withFull.rows.filter((r) => r.kind === 'issue').map((r) => r.issue.number), [5]);
  const fallback = buildWorkBoard({ ...snapshot([], { groups }), openIssues: undefined });
  assert.deepEqual(fallback.rows.filter((r) => r.kind === 'issue').map((r) => r.issue.number), [99]);
  const empty = buildWorkBoard({ ...snapshot([], { groups }), openIssues: [] });
  assert.deepEqual(empty.rows.filter((r) => r.kind === 'issue').map((r) => r.issue.number), [99], 'empty list falls back too');
});

test('hostile titles, labels and assignees are stripped of control and bidi bytes', () => {
  const issue = toBoardIssue(tracked(3, { title: hostile('t'), labels: [hostile('l')], assignee: hostile('a'), blockers: 0 }));
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
  assert.ok(!bad.test(issue.title));
  assert.ok(!bad.test(issue.assignee));
  assert.ok(issue.labels.every((l) => !bad.test(l)));
  assert.ok(issue.title.length <= 200);
});
