// Pure helpers for the hosted /promptr board and
// a hosted frame with a hand-built board (fixture style mirrors
// test/workspace/board-view.test.mjs). index.mts is never imported here: it
// needs the Pi host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_GENERATE_NOTICE, hostedBoard, placeDraft } from '../../dist/src/extension/hosted-tracking.mjs';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const REPO = { host: 'https://git.example', owner: 'owner', repo: 'repo' };
const NOW = '2026-09-07T12:00:00Z';

function snapshot(repo = REPO) {
  const issues = [
    { number: 1, title: 'First', state: 'open', milestone: 'No milestone', labels: [], url: 'https://git.example/owner/repo/issues/1', blockers: 0 },
    { number: 2, title: 'Second', state: 'open', milestone: 'No milestone', labels: ['status:ready'], url: 'https://git.example/owner/repo/issues/2', blockers: 0 },
  ];
  return {
    version: 1, fetchedAt: NOW, repo,
    overall: { open: 2, closed: 0, total: 2, progress: 0 },
    groups: [{ name: "No milestone", open: 2, closed: 0, total: 2, progress: 0, openIssues: issues }],
    openIssues: issues,
  };
}

test('hostedBoard: valid live snapshot enables navigation with an empty note', () => {
  const r = hostedBoard(snapshot(), 'live', 'live from Gitea');
  assert.ok(r.board);
  assert.equal(r.navigation, true);
  assert.equal(r.note, '');
});

test('hostedBoard: cached and stale sources carry a bounded note', () => {
  const r = hostedBoard(snapshot(), 'cache', 'stale snapshot kept (fetch failed)');
  assert.ok(r.board);
  assert.equal(r.navigation, true);
  assert.equal(r.note, 'cache · stale snapshot kept (fetch failed)');
  const long = hostedBoard(snapshot(), 'cache', 'x'.repeat(200));
  assert.equal(long.note.length, 80);
  assert.ok(long.note.startsWith('cache · '));
});

test('hostedBoard: invalid repo keeps the board but disables navigation', () => {
  const r = hostedBoard(snapshot({ host: 'ftp://nope', owner: 'o', repo: 'r' }), 'live', 'live from Gitea');
  assert.ok(r.board);
  assert.equal(r.navigation, false);
});

test('hostedBoard: undefined snapshot yields no board, no navigation, a note', () => {
  const r = hostedBoard(undefined, 'none', 'fetch failed');
  assert.equal(r.board, undefined);
  assert.equal(r.navigation, false);
  assert.equal(r.note, 'none · fetch failed');
});

test('placeDraft table', () => {
  const draft = 'Task #7\n\nbody\n';
  const cases = [
    ['', draft, 7, '7-20260907T120000Z.json', draft, 'draft for #7 in COMPOSE — edit, then Ctrl+S reviews + sends · packet requests/7-20260907T120000Z.json'],
    ['', draft, 7, undefined, draft, 'draft for #7 in COMPOSE — edit, then Ctrl+S reviews + sends'],
    ['busy text', draft, 7, '7-20260907T120000Z.json', 'busy text', 'composer busy — draft saved to requests/7-20260907T120000Z.json; clear or queue the composer and press g again'],
    ['busy text', draft, 7, undefined, 'busy text', 'composer busy — packet for #7 could not be saved; clear or queue the composer and press g again'],
  ];
  for (const [composer, d, n, saved, wantText, wantNotice] of cases) {
    const r = placeDraft(composer, d, n, saved);
    assert.equal(r.composerText, wantText);
    assert.equal(r.notice, wantNotice);
  }
  assert.match(HOSTED_GENERATE_NOTICE, /\/coordinatr-herdr companion/);
});

// ---- hosted frame with a hand-built board ----
const STATUSES = ['active', 'ready', 'review', 'blocked', 'later', 'unknown'];
const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const tui = (rows = 57, columns = 97) => ({ requestRender() {}, terminal: { rows, columns } });

function issue(number, status) {
  return Object.freeze({
    number, title: `Task ${number} ${status} title long enough to need truncation in narrow frames`,
    status, priority: number % 3 === 0 ? 'P1' : number % 3 === 1 ? 'P2' : '',
    assignee: status === 'active' ? 'example-owner' : '', blockers: status === 'blocked' ? 2 : status === 'unknown' ? undefined : 0,
    mapNumber: 42, labels: [], milestone: 'No milestone', url: `https://git.example/o/r/issues/${number}`,
    updatedAt: '2026-09-07T00:00:00Z',
  });
}

function board() {
  const plan = ['active', 3, 'ready', 3, 'review', 2, 'blocked', 2, 'later', 1, 'unknown', 1];
  const rows = [];
  const counts = zero();
  const issues = [];
  let n = 100;
  for (let i = 0; i < plan.length; i += 2) {
    const [status, count] = [plan[i], plan[i + 1]];
    rows.push({ kind: 'heading', status, count });
    for (let k = 0; k < count; k++) { const it = issue(++n, status); rows.push({ kind: 'issue', issue: it }); issues.push(it); counts[status]++; }
  }
  rows.unshift({ kind: 'map', number: 42, title: 'Hosted map', childCount: 12, counts });
  return { version: 1, repoLabel: 'owner/repo', fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(), openCount: 12, counts, rows, summary: '12 open', issues };
}

function hostedView() {
  const v = new CompanionSpikeView(tui(), { noteText: 'Hosted note.\n', hosted: true, overviewNavigation: true, trackingNavigation: true, projectLabel: 'promptr' });
  v.setWorkBoard(board());
  return v;
}

test('hosted frame fills exactly at 97x57 and 40x18 and shows the TRACKING rule with the open count', () => {
  const v = hostedView();
  for (const [width, height] of [[97, 57], [40, 18]]) {
    const raw = v.renderFrame(width, height);
    assert.equal(raw.length, height, `rows at ${width}x${height}`);
    assert.ok(raw.every((row) => visibleWidth(row) <= width), `overflow at ${width}x${height}`);
    const rows = plain(raw);
    const rule = rows.find((row) => /TRACKING ·/.test(row));
    assert.ok(rule, `TRACKING rule at ${width}x${height}`);
    assert.match(rule, /12 open/);
  }
});

test('Tab reaches TRACKING and Enter yields an open intent for the cursor issue', () => {
  const v = hostedView();
  let guard = 0;
  while (v.snapshot().focus !== 'tracking' && guard++ < 6) v.handleInput('\t');
  assert.equal(v.snapshot().focus, 'tracking');
  v.handleInput('\r');
  const intent = v.consumeTrackingIntent();
  assert.ok(intent, 'intent present');
  assert.equal(intent.kind, 'open');
  assert.equal(typeof intent.issue.number, 'number');
  assert.equal(v.consumeTrackingIntent(), undefined);
});
