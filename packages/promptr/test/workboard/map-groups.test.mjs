// Map groups of the workboard: the rows the builder gives for zero, one and
// two open maps, and the fold state the companion view keeps over those rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkBoard } from '../../dist/src/tracking/board.mjs';
import { CompanionSpikeView, KEY_REFERENCE } from '../../dist/src/companion/view.mjs';
import { REPO, tracked } from '../tracking-navigation/fixtures.mjs';

function snapshot(openIssues) {
  return {
    version: 1,
    fetchedAt: '2026-09-07T12:00:00Z',
    repo: { ...REPO },
    overall: { open: openIssues.length, closed: 0, total: openIssues.length, progress: 0 },
    groups: [],
    openIssues,
  };
}

const item = (number, title, labels = [], extra = {}) => tracked(number, { title, labels, blockers: 0, ...extra });
const MAP = 'wayfinder:map';
const under = (number) => `wayfinder:parent:${number}`;

/** Two open maps with children, one child of a map that is not open, one free-standing task. */
const TWO_MAPS = [
  item(40, 'Editor rework', [MAP]),
  item(50, 'Release notes', [MAP]),
  item(41, 'Split the toolbar', [under(40)]),
  item(42, 'Keep the cursor on save', [under(40), 'priority:P1']),
  item(51, 'Collect the changes', [under(50)]),
  item(61, 'Archive the old drafts', [under(60)]),
  item(70, 'Fix the tab order'),
];

const shape = (board) => board.rows.map((r) =>
  r.kind === 'map' ? `map#${r.number}:${r.childCount}` : r.kind === 'section' ? `S:${r.count}`
    : r.kind === 'heading' ? `H:${r.status}:${r.count}` : `${r.depth === 1 ? '  ' : ''}#${r.issue.number}`);

test('zero maps: the rows are status headings and depth 0 tasks only', () => {
  const board = buildWorkBoard(snapshot([item(2, 'Fix the tab order'), item(8, 'Trim the footer', [], { assignee: 'a' })]));
  assert.deepEqual(shape(board), ['H:active:1', '#8', 'H:ready:1', '#2']);
});

test('one map: its children sit under it with the count, the rest is free-standing', () => {
  const board = buildWorkBoard(snapshot([
    item(40, 'Editor rework', [MAP]),
    item(41, 'Split the toolbar', [under(40)]),
    item(70, 'Fix the tab order'),
  ]));
  assert.deepEqual(shape(board), ['map#40:1', '  #41', 'S:1', 'H:ready:1', '#70']);
});

test('two maps: each child is under its map, each map row carries the count of its open children', () => {
  const board = buildWorkBoard(snapshot(TWO_MAPS));
  assert.deepEqual(shape(board), [
    'map#40:2', '  #42', '  #41',
    'map#50:1', '  #51',
    'S:2',
    'H:ready:2', '#61', '#70',
  ]);
  assert.deepEqual(board.rows[0].counts, { active: 0, ready: 2, review: 0, blocked: 0, later: 0, unknown: 0 });
  assert.equal(board.rows[0].title, 'Editor rework');
});

test('a child of a map that is not open keeps a free-standing row and its membership', () => {
  const board = buildWorkBoard(snapshot(TWO_MAPS));
  const row = board.rows.find((r) => r.kind === 'issue' && r.issue.number === 61);
  assert.equal(row.depth, 0);
  assert.equal(row.issue.mapNumber, 60);
  assert.ok(!board.rows.some((r) => r.kind === 'map' && r.number === 60));
});

// --- the fold state of the view -------------------------------------------

const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const DOWN = '\x1b[B', HOME = '\x1b[H', ENTER = '\r';

function view(issues = TWO_MAPS) {
  const tui = { requestRender() {}, terminal: { rows: 63, columns: 120 } };
  const v = new CompanionSpikeView(tui, { noteText: 'note', hosted: true, overviewNavigation: true, trackingNavigation: true });
  v.setWorkBoard(buildWorkBoard(snapshot(issues)));
  v.setFocus('tracking');
  return v;
}

function boardLines(v) {
  const rows = plain(v.renderFrame(120, 63));
  const top = rows.findIndex((row) => /TRACKING · /.test(row));
  const lines = [];
  const boardRow = /^[ ▶][ +](?:Map #|FREE-STANDING |[A-Z]+ \d+$|#\d+ | └ #)/;
  for (let i = top + 1; i < rows.length && boardRow.test(rows[i]); i++) lines.push(rows[i]);
  return lines;
}

test('a map group starts expanded and the board rows are not changed by the view', () => {
  const v = view();
  const before = JSON.stringify(v.getWorkBoard().rows);
  const lines = boardLines(v);
  assert.match(lines[0], /^  Map #40 Editor rework · 2 tasks · 2 ready$/);
  assert.match(lines[1], /^▶  └ #42 P1 ready /);
  assert.match(lines[3], /^  Map #50 Release notes · 1 task · 1 ready$/);
  v.handleInput('f');
  assert.equal(JSON.stringify(v.getWorkBoard().rows), before, 'the fold is view state, not board data');
});

test('f folds the map of the task under the cursor and f or Enter expands it again', () => {
  const v = view();
  v.handleInput('f');
  let lines = boardLines(v);
  assert.match(lines[0], /^▶\+Map #40 Editor rework · 2 tasks folded · 2 ready$/);
  assert.match(lines[1], /^  Map #50 Release notes · 1 task · 1 ready$/, 'the children of the folded map are hidden');
  assert.equal(v.getBoardCursor(), undefined, 'the cursor is on the folded map row');
  assert.equal(v.consumeTrackingIntent(), undefined);

  v.handleInput('g');
  assert.equal(v.consumeTrackingIntent(), undefined, 'g on a folded map row asks the host for nothing');

  v.handleInput(DOWN);
  assert.equal(v.getBoardCursor().number, 51, 'Down leaves the folded map for the next task');
  v.handleInput(HOME);
  assert.equal(v.getBoardCursor(), undefined, 'Home returns to the folded map row');

  v.handleInput('f');
  assert.equal(v.getBoardCursor().number, 42, 'the cursor goes to the first child of the expanded map');
  assert.match(boardLines(v)[0], /^  Map #40 Editor rework · 2 tasks · 2 ready$/);

  v.handleInput('f');
  v.handleInput(ENTER);
  assert.equal(v.getBoardCursor().number, 42, 'Enter on a folded map row expands it');
  assert.equal(v.consumeTrackingIntent(), undefined, 'Enter on a folded map row opens no task');
  lines = boardLines(v);
  assert.equal(lines.filter((line) => /\+Map #/.test(line)).length, 0);
});

test('a fold survives a refresh by map number and ends when the map leaves the board', () => {
  const v = view();
  v.handleInput('f');
  v.setWorkBoard(buildWorkBoard(snapshot([...TWO_MAPS, item(43, 'Add the status line', [under(40)])])));
  assert.match(boardLines(v)[0], /^▶\+Map #40 Editor rework · 3 tasks folded · 3 ready$/);
  v.setWorkBoard(buildWorkBoard(snapshot(TWO_MAPS.filter((i) => i.number !== 40))));
  const lines = boardLines(v);
  assert.equal(lines.filter((line) => /\+Map #/.test(line)).length, 0);
  assert.ok(v.getBoardCursor() !== undefined, 'the cursor falls back to a task');
});

test('f changes nothing with one open map, and on a free-standing task', () => {
  const single = view(TWO_MAPS.filter((i) => i.number !== 50 && i.number !== 51));
  const before = boardLines(single);
  single.handleInput('f');
  assert.deepEqual(boardLines(single), before);
  assert.equal(single.getBoardCursor().number, 42);

  const v = view();
  for (let i = 0; i < 6; i++) v.handleInput(DOWN);
  assert.equal(v.getBoardCursor().number, 70);
  const lines = boardLines(v);
  v.handleInput('f');
  assert.deepEqual(boardLines(v), lines);
});

test('the key list of the workboard names f', () => {
  assert.ok(KEY_REFERENCE.tracking.some(([key, label]) => key === 'f' && /fold/.test(label)));
});
