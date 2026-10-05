// The navigable tracking region, proqi-style queue
// cards, header status and painted key hints of the companion view. The board
// fixture is built by hand here (structural contract in board-port.mts); the
// tracking builder (buildWorkBoard) is never imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSpikeView, paintKeyHints } from '../../dist/src/companion/view.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const SIZES = [[40, 24], [76, 63], [97, 63], [120, 40]];
const NOTE = ['Workspace note line one.', '', 'line three', 'line four'].join('\n');
const GREEN = '\x1b[32m';

const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const tui = (rows = 63, columns = 97) => ({ requestRender() {}, terminal: { rows, columns } });
const at = (rows, re) => rows.findIndex((row) => re.test(row));

const STATUSES = ['active', 'ready', 'review', 'blocked', 'later', 'unknown'];
const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));

function issue(number, status, extra = {}) {
  return Object.freeze({
    number, title: `Task ${number} ${status} title that is fairly long so it must be truncated somewhere`,
    status, priority: number % 3 === 0 ? 'P1' : number % 3 === 1 ? 'P2' : '',
    assignee: status === 'active' ? 'example-owner' : '', blockers: status === 'blocked' ? 2 : status === 'unknown' ? undefined : 0,
    mapNumber: 3, labels: [], milestone: 'No milestone', url: `https://git.example/o/r/issues/${number}`,
    updatedAt: '2026-09-07T00:00:00Z', ...extra,
  });
}

/** 20 issues: 4 active, 4 ready, 4 review, 4 blocked, 2 later, 2 unknown; one map row first. */
export function board(fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString()) {
  const plan = ['active', 4, 'ready', 4, 'review', 4, 'blocked', 4, 'later', 2, 'unknown', 2];
  const rows = [];
  const counts = zero();
  let n = 100;
  const issues = [];
  for (let i = 0; i < plan.length; i += 2) {
    const [status, count] = [plan[i], plan[i + 1]];
    rows.push({ kind: 'heading', status, count });
    for (let k = 0; k < count; k++) { const it = issue(++n, status); rows.push({ kind: 'issue', issue: it }); issues.push(it); counts[status]++; }
  }
  rows.unshift({ kind: 'map', number: 3, title: 'Workboard map', childCount: 20, counts });
  return { version: 1, repoLabel: 'owner/repo', fetchedAt, openCount: 20, counts, rows, summary: '20 open', issues };
}

function view({ focus = 'editor', queued = 0, withBoard = true, hosted = true, nav = true, tracking, projectLabel } = {}) {
  const options = { noteText: NOTE, hosted, overviewNavigation: hosted, trackingNavigation: nav };
  if (tracking !== undefined) options.trackingLines = tracking;
  if (projectLabel !== undefined) options.projectLabel = projectLabel;
  const v = new CompanionSpikeView(tui(), options);
  if (withBoard) v.setWorkBoard(board());
  v.setFocus('composer');
  for (let i = 0; i < queued; i++) { v.handleInput(`thought ${i + 1} body text`); v.handleInput('\x05'); }
  v.setFocus(focus);
  return v;
}
const frame = (v, width, height) => plain(v.renderFrame(width, height));
const UP = '\x1b[A', DOWN = '\x1b[B', PGUP = '\x1b[5~', PGDN = '\x1b[6~', HOME = '\x1b[H', END = '\x1b[F', ENTER = '\r', ESC = '\x1b';

test('every frame size fills exactly with a 20-issue board, focused and unfocused', () => {
  for (const focus of ['tracking', 'editor', 'panel']) {
    const v = view({ focus, queued: 3 });
    for (const [width, height] of SIZES) {
      const raw = v.renderFrame(width, height);
      assert.equal(raw.length, height, `rows at ${width}x${height} (${focus})`);
      assert.ok(raw.every((row) => visibleWidth(row) <= width), `overflow at ${width}x${height} (${focus})`);
      const rows = plain(raw);
      assert.match(rows[height - 2], /^▶ (QUEUE|COMPOSE|NOTEBOOK|TRACKING) · \S/);
      assert.ok(rows[height - 1].trim().length > 0);
    }
  }
});

test('the tracking rule names the repo, open count, snapshot age and the host note', () => {
  const v = view({ focus: 'tracking' });
  let rows = frame(v, 97, 63);
  assert.match(rows[at(rows, /TRACKING/)], /^── ▶ TRACKING · owner\/repo · 20 open · updated 5m ago ─+$/);
  v.setWorkBoard(board(), 'offline · cached 11h ago');
  rows = frame(v, 97, 63);
  assert.match(rows[at(rows, /TRACKING/)], /· updated 5m ago · offline · cached 11h ago ─+$/);
  // Only one region rule per region, still four.
  assert.equal(rows.filter((row) => /^── /.test(row)).length, 4);
  const bare = view({ withBoard: false });
  const b = frame(bare, 97, 63);
  const h = at(b, /TRACKING · /);
  assert.match(b[h], /TRACKING · no board/);
  assert.match(b[h + 1], /^  no snapshot · r refreshes$/);
  assert.ok(!/^ /.test(b[h + 2]), 'empty board state is a single line');
});

test('board rows render map, heading and issue shapes with status words, assignee and blockers', () => {
  const v = view({ focus: 'tracking' });
  const rows = frame(v, 120, 40);
  const top = at(rows, /TRACKING · /);
  assert.match(rows[top + 1], /^  Map #3 Workboard map · 20 tasks · 4 active · 4 ready · 4 review · 4 blocked · 2 later · 2 unknown$/);
  assert.match(rows[top + 2], /^  ACTIVE 4$/);
  assert.match(rows[top + 3], /^▶ #101    active  Task 101 active title.* @example-owner$/);
  assert.match(rows[top + 4], /^  #102 P1 active  Task 102/);
  const blocked = rows.find((row) => /#113 /.test(row));
  assert.match(blocked, /blocked Task 113 .* ⛔2$/);
  v.handleInput(END);
  const end = frame(v, 120, 40);
  assert.match(end.find((row) => /^▶ #120/.test(row)), /^▶ #120 P1 \?       Task 120 unknown/);
});

test('the cursor skips map and heading rows, pages by the window and jumps Home/End', () => {
  const v = view({ focus: 'tracking' });
  assert.equal(v.getBoardCursor().number, 101);
  v.handleInput(UP);
  assert.equal(v.getBoardCursor().number, 101, 'Up at the first issue stays put');
  for (let i = 0; i < 4; i++) v.handleInput(DOWN);
  assert.equal(v.getBoardCursor().number, 105, 'Down crosses the READY heading without stopping on it');
  v.handleInput(END);
  assert.equal(v.getBoardCursor().number, 120);
  v.handleInput(DOWN);
  assert.equal(v.getBoardCursor().number, 120);
  v.handleInput(HOME);
  assert.equal(v.getBoardCursor().number, 101);
  v.renderFrame(97, 24);
  v.handleInput(PGDN);
  assert.ok(v.getBoardCursor().number > 101, 'PgDn moves by the visible window');
  v.handleInput(PGUP);
  assert.equal(v.getBoardCursor().number, 101);
});

test('hidden rows are counted inside the budget and the window follows the cursor', () => {
  const v = view({ focus: 'tracking' });
  let rows = frame(v, 97, 24);
  const top = at(rows, /TRACKING · /);
  const body = rows.slice(top + 1, rows.findIndex((row, i) => i > top && /^▶ TRACKING · /.test(row)));
  assert.equal(body.length, 12, 'focused budget at 24 rows is max(8, 12)');
  assert.match(body.at(-1), /^  ↓ \d+ more$/);
  assert.ok(!body.some((row) => /^  ↑ /.test(row)), 'no top counter at the start');
  v.handleInput(END);
  rows = frame(v, 97, 24);
  assert.ok(rows.some((row) => /^  ↑ \d+ more$/.test(row)), 'top counter once scrolled');
  assert.ok(rows.some((row) => /^▶ #120 /.test(row)), 'cursor row visible');
  assert.ok(!rows.some((row) => /^  ↓ /.test(row)), 'no bottom counter at the end');
  // Unfocused budget is smaller: max(4, floor(63/5)) = 12 rows of 27.
  const idle = view({ focus: 'editor' });
  const r = frame(idle, 97, 63);
  const t = at(r, /TRACKING · /);
  const close = r.findIndex((row, i) => i > t && /^▶ NOTEBOOK/.test(row));
  assert.equal(close - t - 1, 12);
  assert.ok(!r.some((row) => /^▶ #/.test(row)), 'no cursor glyph while unfocused');
});

test('Enter, g and r produce intents carrying the cursor issue; other keys keep a notice', () => {
  const v = view({ focus: 'tracking' });
  v.handleInput(DOWN);
  v.handleInput(ENTER);
  v.handleInput('g');
  v.handleInput('r');
  assert.deepEqual(v.consumeTrackingIntent(), { kind: 'open', issue: board().issues[1] });
  assert.deepEqual(v.consumeTrackingIntent(), { kind: 'generate', issue: board().issues[1] });
  assert.deepEqual(v.consumeTrackingIntent(), { kind: 'refresh' });
  assert.equal(v.consumeTrackingIntent(), undefined);
  v.handleInput('z');
  assert.match(v.getNotice(), /TRACKING ignores z/);
  v.handleInput(ESC);
  assert.equal(v.focus, 'composer', 'Esc returns to the focus tracking was entered from');
  assert.match(frame(v, 97, 63).at(-1), /Ctrl\+S queues \+ reviews/);
});

test('the cursor survives setWorkBoard by issue number and falls back to the first issue', () => {
  const v = view({ focus: 'tracking' });
  v.handleInput(END);
  const b = board();
  v.setWorkBoard({ ...b, rows: b.rows.slice().reverse() });
  assert.equal(v.getBoardCursor().number, 120);
  v.setWorkBoard({ ...b, rows: b.rows.filter((row) => row.kind !== 'issue' || row.issue.number !== 120) });
  assert.equal(v.getBoardCursor().number, 101);
  v.setWorkBoard({ ...b, rows: [] });
  assert.equal(v.getBoardCursor(), undefined);
  v.handleInput(ENTER);
  assert.equal(v.consumeTrackingIntent(), undefined);
  assert.match(v.getNotice(), /no open tasks/);
  assert.match(frame(v, 97, 63).find((row) => /no open tasks/.test(row)), /^  no open tasks · r refreshes$/);
});

test('the header carries the OpenKnowledge fragment and tints it by state', () => {
  const YELLOW = '\x1b[33m';
  const v = view({ projectLabel: 'promptr' });
  v.setHeaderStatus({ git: 'main @6627c8c', pi: 'Pi w8:p2 idle', ok: 'OK 12s' });
  let raw = v.renderFrame(97, 63)[0];
  assert.match(plain([raw])[0], /^PROMPTR · promptr · main @6627c8c · Pi w8:p2 idle · OK 12s · Ctrl\+O overview/);
  assert.ok(raw.includes(`${GREEN}Pi w8:p2 idle\x1b[0m`), 'idle pi fragment stays green');
  assert.ok(raw.includes(`${GREEN}OK 12s\x1b[0m`), 'reachable OK fragment is green');
  v.setHeaderStatus({ pi: 'Pi w8:p2 working', ok: 'OK offline' });
  raw = v.renderFrame(97, 63)[0];
  assert.match(plain([raw])[0], /^PROMPTR · promptr · Pi w8:p2 working · OK offline · Ctrl\+O overview/);
  assert.ok(raw.includes(`${YELLOW}OK offline\x1b[0m`), 'offline OK fragment is yellow');
  v.setHeaderStatus({ ok: 'OK unbound' });
  raw = v.renderFrame(97, 63)[0];
  assert.match(plain([raw])[0], /^PROMPTR · promptr · OK unbound · Ctrl\+O overview/);
  assert.ok(!raw.includes(`${GREEN}OK unbound`), 'unbound OK fragment is not green');
  v.setHeaderStatus({});
  assert.match(plain([v.renderFrame(97, 63)[0]])[0], /^PROMPTR · promptr · Ctrl\+O overview/);
});

test('the header carries git and pi state and paints the idle pi fragment green', () => {
  const v = view({ projectLabel: 'promptr' });
  assert.match(frame(v, 97, 63)[0], /^PROMPTR · promptr · Ctrl\+O overview/);
  v.setHeaderStatus({ git: 'main +2', pi: 'pi idle' });
  const raw = v.renderFrame(97, 63)[0];
  assert.match(plain([raw])[0], /^PROMPTR · promptr · main \+2 · pi idle · Ctrl\+O overview/);
  assert.ok(raw.includes(`${GREEN}pi idle\x1b[0m`), 'idle fragment is green');
  v.setHeaderStatus({ pi: 'pi working' });
  assert.ok(v.renderFrame(97, 63)[0].includes('\x1b[33mpi working'), 'working is yellow');
  assert.match(frame(v, 97, 63)[0], /^PROMPTR · promptr · pi working · Ctrl\+O overview/);
  v.setHeaderStatus({});
  assert.match(frame(v, 97, 63)[0], /^PROMPTR · promptr · Ctrl\+O overview/);
});

test('the focused queue card expands with a left bar and honest +n lines; others stay one line', () => {
  const v = view({ focus: 'composer' });
  ['one', 'line two', 'line three', 'line four', 'line five', 'line six'].forEach((line, i) => {
    if (i > 0) v.handleInput(ENTER);
    v.handleInput(line);
  });
  v.handleInput('\x05');
  v.handleInput('second thought');
  v.handleInput('\x05');
  v.setFocus('panel');
  v.handleInput('k');
  const rows = frame(v, 97, 63);
  const q = at(rows, /QUEUE 2 /);
  assert.match(rows[q + 1], /^▎▶ 1\. one \+5 lines · 6l · \d+c$/);
  assert.match(rows[q + 2], /^▎   line two$/);
  assert.match(rows[q + 3], /^▎   line three$/);
  assert.match(rows[q + 4], /^▎   line four \+2 lines$/);
  assert.match(rows[q + 5], /^  2\. second thought · 1l · 14c$/);
  v.setFocus('editor');
  assert.match(frame(v, 97, 63)[q + 1], /^  1\. one \+5 lines/);
  assert.ok(!frame(v, 97, 63).some((row) => row.startsWith('▎')), 'no bar while the panel is idle');
});

test('e edits a card into the composer and refuses while a draft exists; d deletes after y/n', () => {
  const v = view({ focus: 'panel', queued: 3 });
  assert.equal(v.getFocusedQueue(), 2);
  v.handleInput('k');
  v.handleInput('e');
  assert.equal(v.focus, 'composer');
  assert.equal(v.getComposerText(), 'thought 2 body text');
  assert.deepEqual([...v.getMockQueue()], ['thought 1 body text', 'thought 3 body text']);
  assert.equal(v.getNotice(), 'editing thought 2 — Ctrl+S queues + reviews');
  v.setFocus('panel');
  v.handleInput('e');
  assert.equal(v.getNotice(), 'composer has a draft — queue or clear it before editing a card');
  assert.equal(v.getMockQueue().length, 2);
  assert.equal(v.focus, 'panel');
  v.handleInput('d');
  assert.equal(v.getNotice(), 'Delete thought 2? y = delete, n/Esc = keep');
  assert.match(v.renderFrame(97, 63).at(-2), /^\x1b\[33m/, 'delete prompt is painted yellow');
  v.handleInput('n');
  assert.equal(v.getMockQueue().length, 2);
  v.handleInput('d');
  v.handleInput('y');
  assert.deepEqual([...v.getMockQueue()], ['thought 1 body text']);
  assert.equal(v.getNotice(), 'deleted thought 2 — 1 queued');
  const snap = v.snapshot();
  assert.equal(snap.queue.items.length, 1);
  v.handleInput('w');
  assert.equal(v.focus, 'editor');
});

test('hint rows paint key tokens green without touching the words around them', () => {
  const wide = view({ focus: 'panel', queued: 1 }).renderFrame(120, 40).at(-1);
  assert.match(plain([wide])[0], /^\[ \] entry · ↑↓ lines · Enter queue · S send · E copy · D delete · j\/k card · e edit · d delete · s send · \? all keys$/);
  for (const key of ['[', ']', '↑↓', 'Enter', 'S', 'E', 'D', 'j/k', 'e', 'd', 's', '?']) assert.ok(wide.includes(`${GREEN}${key}\x1b[0m`), `${key} painted`);
  assert.ok(!wide.includes(`${GREEN}edit`), 'plain words are not green');
  const tracking = view({ focus: 'tracking' }).renderFrame(97, 63).at(-1);
  assert.match(plain([tracking])[0], /^↑↓ move · Enter opens the task · g Generate Prompt · r refresh · \? all keys · Esc back$/);
  for (const key of ['g', 'r', '?', 'Esc']) assert.ok(tracking.includes(`${GREEN}${key}\x1b[0m`), `${key} painted`);
  assert.ok(paintKeyHints('Ctrl+S queues · Tab focus · PgUp PgDn Home End').includes(`${GREEN}Ctrl+S\x1b[0m`));
  assert.match(view({ focus: 'panel', queued: 1 }).renderFrame(40, 24).at(-1).replace(/\x1b\[[0-9;]*m/g, ''), /^Enter queue · S send · j\/k · s · \? keys$/);
});

test('setTrackingLines keeps the legacy rendering when navigation is off', () => {
  const TRACKING = Array.from({ length: 12 }, (_, i) => `S${i} [....]  0% 0/${i + 1}`);
  const v = view({ nav: false, withBoard: false, tracking: TRACKING });
  const rows = frame(v, 97, 63);
  const heading = at(rows, /TRACKING · Gitea read-only/);
  assert.ok(heading > 0);
  assert.match(rows[heading + 1], /^  S0 \[/);
  assert.ok(rows.some((row) => /^  \.\.\. \d+ more · Ctrl\+O overview$/.test(row)), 'legacy overflow counter');
  v.setTrackingLines([]);
  const bare = frame(v, 97, 63);
  const h = at(bare, /TRACKING · Gitea read-only/);
  assert.match(bare[h + 1], /^  no snapshot · \/work-status refreshes$/);
  assert.match(bare[h + 2], /^▶ /, 'empty tracking state is a single line');
  assert.equal(v.consumeTrackingIntent(), undefined);
  v.setFocus('tracking');
  assert.equal(v.focus, 'editor', 'no tracking focus without navigation');
});

test('truncated board titles and card lines never carry escape bytes into the frame', () => {
  const long = 'A very long issue title that certainly exceeds the room a forty column pane leaves for it';
  const issue = (number, status) => ({ number, title: long, status, priority: 'P1', assignee: 'owner', blockers: 2, mapNumber: 3, labels: [], milestone: 'No milestone', url: '', updatedAt: '' });
  const board = {
    version: 1, repoLabel: 'o/r', fetchedAt: new Date().toISOString(), openCount: 2,
    counts: { active: 1, ready: 0, review: 0, blocked: 1, later: 0, unknown: 0 },
    rows: [
      { kind: 'map', number: 3, title: long, childCount: 2, counts: { active: 1, ready: 0, review: 0, blocked: 1, later: 0, unknown: 0 } },
      { kind: 'heading', status: 'active', count: 1 }, { kind: 'issue', issue: issue(1, 'active') },
      { kind: 'heading', status: 'blocked', count: 1 }, { kind: 'issue', issue: issue(2, 'blocked') },
    ],
    summary: '2 open',
  };
  const v = new CompanionSpikeView(tui(), { noteText: 'n', hosted: true, overviewNavigation: true, trackingNavigation: true });
  v.setWorkBoard(board);
  v.setFocus('composer');
  v.handleInput(`${long}\n${long}\n${long}`.replace(/\n/g, '\r'));
  for (const width of [40, 76]) {
    const rows = plain(v.renderFrame(width, 40));
    const board_rows = rows.filter((row) => /#\d+ /.test(row) || /^  Map #/.test(row));
    assert.ok(board_rows.length >= 3, `board rows rendered at ${width}`);
    for (const row of rows) assert.ok(!row.includes('^[') && !row.includes('\x1b['), `no escape leak at ${width}: ${row}`);
    assert.ok(board_rows.some((row) => row.endsWith('…') || /…/.test(row)), `titles are clamped with an ellipsis at ${width}`);
  }
});

test('replaceComposerText swaps the draft only while it is unedited and supported', () => {
  const v = view({ focus: 'composer' });
  v.handleInput('draft one');
  assert.equal(v.getComposerText(), 'draft one');
  assert.equal(v.replaceComposerText('other', 'generated'), false, 'mismatch leaves the composer alone');
  assert.equal(v.getComposerText(), 'draft one');
  assert.equal(v.replaceComposerText('draft one', 'gen\u00e9rated'), false, 'unsupported text is refused');
  assert.equal(v.getComposerText(), 'draft one');
  assert.equal(v.replaceComposerText('draft one', '# Generated\n\nbody'), true);
  assert.equal(v.getComposerText(), '# Generated\n\nbody');
  assert.equal(v.snapshot().focus, 'composer');
});

test('enqueueExternalText queues a badged web thought and refuses unsupported text', () => {
  const v = view({ focus: 'editor', queued: 1 });
  assert.equal(v.enqueueExternalText('from the browser\nsecond line', 'web'), true);
  assert.equal(v.snapshot().queue.items.length, 2);
  assert.equal(v.snapshot().queue.items[1].origin, 'web');
  assert.match(v.getNotice(), /^web thought queued as 2/);
  let rows = frame(v, 97, 63);
  assert.ok(rows.some((row) => /^  2\. \[web\] from the browser/.test(row)), 'collapsed card carries the badge');
  assert.ok(rows.some((row) => /^  1\. thought 1 body text/.test(row)), 'typed card has no badge');
  v.setFocus('panel');
  v.handleInput('j');
  rows = frame(v, 97, 63);
  assert.ok(rows.some((row) => /^▎▶ 2\. \[web\] from the browser/.test(row)), 'expanded card carries the badge');
  assert.equal(v.enqueueExternalText('', 'web'), false);
  assert.equal(v.enqueueExternalText('caf\u00e9', 'web'), false);
  assert.equal(v.snapshot().queue.items.length, 2);
});
