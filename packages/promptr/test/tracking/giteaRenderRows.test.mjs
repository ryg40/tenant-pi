import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 NO_MILESTONE, renderBoardLines, renderCompactLines, renderPlaceholderLines,
} from '../../dist/src/tracking/gitea.mjs';

// Snapshot age is baked into the fixture stamp, not the clock: these rows must
// stay honest about freshness, so every assertion below reads a real age string.
const TEN_HOURS_AGO = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
const NINE_DAYS_AGO = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();

function issue(number, title, milestone = 'S1.1 — First milestone') {
 return { number, title, state: 'open', milestone, labels: [], url: '' };
}

function group(name, open, closed, openIssues) {
 const total = open + closed;
 return {
  name, open, closed, total,
  progress: total === 0 ? 0 : Math.round((closed / total) * 100),
  openIssues,
 };
}

/** Shaped like a real snapshot: 44 issues, 1 closed, 6 groups. */
function liveShapedSnapshot(fetchedAt = TEN_HOURS_AGO) {
 return {
  version: 1,
  fetchedAt,
  repo: { host: 'https://gitea.example.test', owner: 'owner', repo: 'promptr' },
  overall: { open: 43, closed: 1, total: 44, progress: 2 },
  groups: [
   group('S1.1 — First milestone', 7, 0, [
    issue(2, 'Sample task with a long title for the board'),
    issue(3, 'Sample task three'),
   ]),
   group('S1.2 — Second milestone', 8, 0, [
    issue(5, 'Sample task five', 'S1.2 — Second milestone'),
    issue(6, 'Sample task six', 'S1.2 — Second milestone'),
   ]),
   group('S1.3 — Third milestone', 2, 0, [issue(9, 'Sample task nine', 'S1.3 — Third milestone')]),
   group('S2 — Fourth milestone', 9, 0, [issue(14, 'Sample task fourteen', 'S2 — Fourth milestone')]),
   group('S3 — Fifth milestone', 14, 0, [issue(20, 'Sample task twenty', 'S3 — Fifth milestone')]),
   group(NO_MILESTONE, 3, 1, [issue(46, 'Sample task forty-six', NO_MILESTONE)]),
  ],
 };
}

function emptySnapshot() {
 return {
  version: 1,
  fetchedAt: TEN_HOURS_AGO,
  repo: { host: 'https://gitea.example.test', owner: 'owner', repo: 'promptr' },
  overall: { open: 0, closed: 0, total: 0, progress: 0 },
  groups: [],
 };
}

function allClosedSnapshot() {
 return {
  version: 1,
  fetchedAt: NINE_DAYS_AGO,
  repo: { host: 'https://gitea.example.test', owner: 'owner', repo: 'promptr' },
  overall: { open: 0, closed: 12, total: 12, progress: 100 },
  groups: [group('S1.1 — First milestone', 0, 12, [])],
 };
}

const RENDERERS = [
 ['renderCompactLines', renderCompactLines],
 ['renderBoardLines', renderBoardLines],
];

// ---- row budgets ----

test('both renderers respect maxRows exactly, including tiny budgets', () => {
 for (const [name, render] of RENDERERS) {
  for (const snapshot of [liveShapedSnapshot(), emptySnapshot(), allClosedSnapshot()]) {
   for (const maxRows of [0, 1, 2, 3, 4, 5, 8, 14, 20]) {
    const lines = render(snapshot, maxRows);
    assert.ok(
     lines.length <= maxRows,
     `${name} returned ${lines.length} rows for maxRows=${maxRows}`,
    );
    assert.ok(lines.every((l) => typeof l === 'string'), `${name} must return string[]`);
    assert.ok(lines.every((l) => !l.includes('\n')), `${name} rows must stay single-line`);
   }
  }
 }
});

test('maxRows 0 renders nothing and maxRows 1 keeps only the summary', () => {
 for (const [, render] of RENDERERS) {
  assert.deepEqual(render(liveShapedSnapshot(), 0), []);
  const one = render(liveShapedSnapshot(), 1);
  assert.equal(one.length, 1);
  assert.match(one[0], /owner\/promptr/);
  assert.match(one[0], /updated 10h ago/);
 }
});

test('maxRows 3 spends its rows on summary, an issue, and the discovery hint', () => {
 for (const [name, render] of RENDERERS) {
  const lines = render(liveShapedSnapshot(), 3);
  assert.equal(lines.length, 3, name);
  assert.match(lines[0], /43 open/, name);
  assert.match(lines[1], /^ {2}#2 /, name);
  assert.match(lines[2], /\/work-status/, name);
 }
});

// ---- no duplicate heading, no bar wall ----

test('rows never repeat the TRACKING region heading', () => {
 for (const [name, render] of RENDERERS) {
  for (const line of render(liveShapedSnapshot(), 14)) {
   assert.ok(!line.includes('TRACKING'), `${name} row repeats the region heading: ${line}`);
  }
 }
});

test('milestones collapse to one rollup row instead of a per-milestone bar wall', () => {
 const compact = renderCompactLines(liveShapedSnapshot(), 8);
 const board = renderBoardLines(liveShapedSnapshot(), 14);
 for (const [name, lines] of [['compact', compact], ['board', board]]) {
  const rollups = lines.filter((l) => l.startsWith('Milestones · '));
  assert.equal(rollups.length, 1, `${name} should carry exactly one milestone rollup`);
  assert.match(rollups[0], /S1\.1 0\/7/, name);
  assert.match(rollups[0], /S3 0\/14/, name);
  const bars = lines.filter((l) => l.includes('[') && l.includes('░'));
  assert.ok(bars.length <= 1, `${name} should keep at most the overall bar, got ${bars.length}`);
 }
 // Neither surface calls issue disposition "progress": closed includes retired
 // and superseded work, so an aggregate bar would imply delivery falsely.
 assert.ok(compact.every((l) => !l.includes('░')));
 assert.ok(board.every((l) => !l.includes('░')));
 assert.match(compact[0], /dispositioned/);
 assert.match(board[0], /dispositioned/);
});

test('rollup caps at six milestones and marks the remainder', () => {
 const snapshot = liveShapedSnapshot();
 snapshot.groups.push(group('S4 — Later', 5, 0, [issue(60, 'Later work', 'S4 — Later')]));
 snapshot.groups.push(group('S5 — Later still', 4, 0, []));
 const rollup = renderBoardLines(snapshot, 14).find((l) => l.startsWith('Milestones · '));
 assert.ok(rollup);
 assert.match(rollup, /· \+2$/);
});

// ---- open issue rows ----

test('open issues are listed by number, deduped, and labelled as open issues only', () => {
 const snapshot = liveShapedSnapshot();
 // Same issue surfaced under two groups must not be listed twice.
 snapshot.groups[1].openIssues.push(issue(2, 'Sample task with a long title for the board'));
 const lines = renderBoardLines(snapshot, 14);
 const numbers = lines
  .filter((l) => /^ {2}#\d+ /.test(l))
  .map((l) => Number(l.trim().slice(1).split(' ')[0]));
 assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'issue rows must ascend by number');
 assert.equal(new Set(numbers).size, numbers.length, 'issue rows must be deduped');
 assert.ok(lines.some((l) => l === 'Open issues · Gitea order, not a run queue:'));
 // The snapshot has no assignee/dependency data, so nothing may claim priority.
 const joined = lines.join('\n').toLowerCase();
 for (const claim of ['next runnable', 'next up', 'start here', 'assigned to you', 'in progress']) {
  assert.ok(!joined.includes(claim), `must not claim "${claim}"`);
 }
});

test('the overflow count reports every open issue, not just the listable ones', () => {
 // openIssues is capped per milestone, so 44 issues surface only 9 listable
 // rows here while overall.open says 43. The hint must not say "+N" from the
 // short list; that would read as a nearly-empty backlog.
 const snapshot = liveShapedSnapshot();
 const listable = snapshot.groups.reduce((n, g) => n + g.openIssues.length, 0);
 assert.ok(listable < snapshot.overall.open, 'fixture must exercise the capped case');
 for (const [name, render, rows] of [['compact', renderCompactLines, 8], ['board', renderBoardLines, 14]]) {
  const lines = render(snapshot, rows);
  const hint = lines.find((l) => l.startsWith('+'));
  assert.ok(hint, `${name} should carry an overflow hint`);
  const shown = lines.filter((l) => /^ {2}#\d+ /.test(l)).length;
  assert.equal(hint, `+${snapshot.overall.open - shown} more open · /work-status browses all`, name);
 }
});

test('the compact pane spends rows on issues and one rollup, not on a header', () => {
 const lines = renderCompactLines(liveShapedSnapshot(), 8);
 assert.equal(lines.length, 8);
 assert.ok(!lines.includes('Open issues · Gitea order, not a run queue:'));
 assert.equal(lines.filter((l) => /^ {2}#\d+ /.test(l)).length, 5, 'five issue rows at the default budget');
 assert.ok(lines[7].startsWith('Milestones · '));
});

test('issue rows carry the milestone code but stay silent for No milestone', () => {
 const lines = renderBoardLines(liveShapedSnapshot(), 14);
 const tagged = lines.find((l) => l.startsWith('  #2 '));
 assert.match(tagged, / · S1\.1$/);
 const untagged = lines.find((l) => l.startsWith('  #46 '));
 if (untagged) assert.ok(!untagged.includes('No milestone'));
});

test('long hostile titles are clamped per row and never leak control bytes', () => {
 const hostile = `${'A'.repeat(40)}\u001b[31m\u0007red\tbytes ${'B'.repeat(60)}`;
 const snapshot = liveShapedSnapshot();
 snapshot.groups[0].openIssues = [{
  number: 7, title: hostile, state: 'open',
  milestone: 'S1.1 — First milestone', labels: [], url: '',
 }];
 const compactRow = renderCompactLines(snapshot, 8).find((l) => l.startsWith('  #7 '));
 const boardRow = renderBoardLines(snapshot, 14).find((l) => l.startsWith('  #7 '));
 for (const [name, row, cap] of [['compact', compactRow, 56], ['board', boardRow, 72]]) {
  assert.ok(row, `${name} row missing`);
  // Row = "  #7 " + clamped title + " · S1.1"; the title portion honours the cap.
  const title = row.slice('  #7 '.length).replace(/ · S1\.1$/, '');
  assert.ok(title.length <= cap, `${name} title ${title.length} > ${cap}`);
  assert.ok(title.endsWith('…'), `${name} title should mark the cut`);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/.test(row), `${name} row leaked a control byte`);
 }
});

// ---- freshness and empty states ----

test('snapshot age is always explicit, including a stale multi-day snapshot', () => {
 for (const [name, render] of RENDERERS) {
  assert.match(render(liveShapedSnapshot(), 14)[0], /updated 10h ago/, name);
  assert.match(render(liveShapedSnapshot(NINE_DAYS_AGO), 14)[0], /updated 9d ago/, name);
  assert.match(render({ ...liveShapedSnapshot(), fetchedAt: 'not-a-date' }, 14)[0], /unknown age/, name);
 }
});

test('an empty tracker says so and still points at /work-status', () => {
 for (const [name, render] of RENDERERS) {
  const lines = render(emptySnapshot(), 8);
  assert.match(lines[0], /no issues tracked/, name);
  assert.match(lines.join('\n'), /\/work-status/, name);
  assert.ok(!lines.join('\n').includes('Milestones · '), `${name} has no milestones to roll up`);
 }
});

test('an all-closed tracker reports zero open without inventing work', () => {
 for (const [name, render] of RENDERERS) {
  const lines = render(allClosedSnapshot(), 8);
  const joined = lines.join('\n');
  assert.match(joined, /No open issues listed/, name);
  assert.match(joined, /updated 9d ago/, name);
  assert.ok(!/ {2}#\d+ /.test(joined), `${name} must not list issue rows when none are open`);
 }
});

test('placeholder rows are untouched and keep the read-only discovery hint', () => {
 const lines = renderPlaceholderLines('Gitea 401 for /api/v1/repos');
 assert.equal(lines.length, 2);
 assert.match(lines[0], /^TRACKING \(Gitea, read-only\): /);
 assert.match(lines[1], /\/work-status/);
});
