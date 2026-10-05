// Workspace layout: the companion window's density, region
// hierarchy and focus legibility. Behavioural queue/selection contracts stay
// with test/briefing/*; this file only pins what the frame looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSpikeView, condensePaths, sanitizeProjectLabel } from '../../dist/src/companion/view.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const SIZES = [[40, 24], [60, 30], [97, 63], [120, 40]];
const NOTE = ['Workspace note line one.', '', 'line three', 'line four'].join('\n');
const LONG_NOTE = Array.from({ length: 80 }, (_, i) => `note line ${i + 1}`).join('\n');
const TRACKING = Array.from({ length: 12 }, (_, i) => `S${i} [....]  0% 0/${i + 1}`);

const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const tui = (rows = 63, columns = 97) => ({ requestRender() {}, terminal: { rows, columns } });

function view({ note = NOTE, queued = 0, focus = 'editor', hosted = true, tracking = TRACKING, projectLabel } = {}) {
  const options = { noteText: note, hosted, overviewNavigation: hosted, trackingLines: tracking };
  if (projectLabel !== undefined) options.projectLabel = projectLabel;
  const v = new CompanionSpikeView(tui(), options);
  v.setFocus('composer');
  for (let i = 0; i < queued; i++) { v.handleInput(`thought ${i + 1} body text`); v.handleInput('\x05'); }
  v.setFocus(focus);
  return v;
}

const frame = (v, width, height) => plain(v.renderFrame(width, height));
const at = (rows, re) => rows.findIndex((row) => re.test(row));

test('every frame size fills exactly, never overflows, and keeps the footer last', () => {
  for (const queued of [0, 4]) {
    for (const focus of ['panel', 'composer', 'editor']) {
      const v = view({ queued, focus });
      for (const [width, height] of SIZES) {
        const raw = v.renderFrame(width, height);
        assert.equal(raw.length, height, `rows at ${width}x${height}`);
        assert.ok(raw.every((row) => visibleWidth(row) <= width), `overflow at ${width}x${height}`);
        const rows = plain(raw);
        // The two footer rows are the frame's last rows and are never blank:
        // whatever else is squeezed, what just happened and which keys apply stay.
        assert.match(rows[height - 2], /^▶ (QUEUE|COMPOSE|NOTEBOOK) · \S/, `focus row ${width}x${height}`);
        assert.ok(rows[height - 1].trim().length > 0, `hint row ${width}x${height}`);
      }
    }
  }
});

test('regions are labelled next to their own content, with no rule stacked on a rule', () => {
  const rows = frame(view({ queued: 2, focus: 'editor' }), 97, 63);
  const queue = at(rows, /QUEUE 2 /);
  const compose = at(rows, /COMPOSE/);
  const notebook = at(rows, /NOTEBOOK · /);
  const tracking = at(rows, /TRACKING · /);
  assert.ok(queue >= 0 && compose > queue && notebook > compose && tracking > notebook, 'region order');
  // Each label is immediately followed by the content it names, not by another rule.
  assert.match(rows[queue + 1], /^  1\. thought 1/);
  assert.ok(!/^──/.test(rows[compose + 1]), 'composer content follows its label');
  assert.match(rows[notebook + 1], /^Workspace note line one\./);
  // The notebook's closing rule butts straight onto TRACKING: no dead spacer.
  assert.match(rows[tracking - 1], /^─+$/);
  // One rule per region; the old duplicate NOTE/COMPOSER headers are gone.
  assert.equal(rows.filter((row) => /^── /.test(row)).length, 4);
  // And no selected-line preview echoing text the notebook already shows.
  assert.ok(!rows.some((row) => row.startsWith('  > ')), 'no duplicated selection preview');
});

test('focus is marked textually in both the region rule and the footer, not by colour alone', () => {
  for (const [focus, label] of [['panel', 'QUEUE'], ['composer', 'COMPOSE'], ['editor', 'NOTEBOOK']]) {
    const rows = frame(view({ queued: 1, focus }), 97, 63);
    const marked = rows.filter((row) => /^── ▶ /.test(row));
    assert.equal(marked.length, 1, `${focus}: exactly one marked region rule`);
    assert.match(marked[0], new RegExp(`▶ ${label}`));
    assert.match(rows.at(-2), new RegExp(`^▶ ${label} · `));
  }
});

test('the notebook uses the height it is given instead of capping at a fraction of the terminal', () => {
  const v = view({ note: LONG_NOTE });
  const noteRows = (height) => {
    const rows = frame(v, 97, height);
    const top = at(rows, /NOTEBOOK · /);
    const close = rows.findIndex((row, i) => i > top && /^─+$/.test(row));
    return close - top - 1;
  };
  const tall = noteRows(63);
  const short = noteRows(30);
  // pi-tui 0.85.0's Editor shows max(5, floor(terminal.rows * 0.3)) lines on its
  // own, i.e. 18 at 63 rows. The workspace hands it a viewport-scoped TUI so the
  // region's real allocation becomes readable note text.
  assert.ok(tall >= 40, `tall notebook shows ${tall} note rows`);
  assert.ok(tall > short + 15, `taller frame gives more note (${short} -> ${tall})`);
});

test('an empty queue costs one line', () => {
  const rows = frame(view({ queued: 0, tracking: TRACKING }), 97, 63);
  const queue = at(rows, /QUEUE 0 /);
  assert.match(rows[queue + 1], /^  empty · Tab to COMPOSE/);
  assert.ok(!/^ /.test(rows[queue + 2]), 'empty queue state is a single line');
});

test('critical controls survive the smallest frame', () => {
  const rows = frame(view({ queued: 3, focus: 'panel' }), 40, 24);
  assert.match(rows[0], /^PROMPTR · Ctrl\+O overview/, 'project navigation stays in the header');
  assert.match(rows.at(-2), /^▶ QUEUE · /);
  assert.match(rows.at(-1), /Enter queue/);
  assert.ok(rows.some((row) => /QUEUE 3/.test(row)) && rows.some((row) => /NOTEBOOK/.test(row)));
});

test('the header carries project identity, never a filesystem path', () => {
  assert.match(frame(view({ projectLabel: 'promptr' }), 97, 63)[0], /^PROMPTR · promptr · Ctrl\+O overview/);
  assert.equal(sanitizeProjectLabel('/home/someone/.pi/agent/promptr/projects/promptr-23a8'), 'promptr-23a8');
  assert.equal(sanitizeProjectLabel('a\nb\tc'), 'a b c');
  assert.equal(sanitizeProjectLabel(undefined), '');
  assert.ok(!frame(view({ projectLabel: '/home/someone/private/tree' }), 97, 63)[0].includes('/home/'));
});

test('long state paths shrink in the footer while the message around them is kept', () => {
  const v = view();
  v.setNotice("clear failed: EACCES: permission denied, open '/home/someone/.pi/agent/promptr/queue.json'");
  const status = frame(v, 97, 63).at(-2);
  assert.match(status, /clear failed: EACCES: permission denied, open '…\/queue\.json'/);
  assert.equal(condensePaths('sent to /tmp/a'), 'sent to /tmp/a', 'short paths are left alone');
  assert.equal(condensePaths('shared /home/someone/.pi/agent/promptr/projects/p-23a8 · 0 queued'),
    'shared …/p-23a8 · 0 queued');
});

test('footer hints follow the focused region and shorten instead of truncating mid-word', () => {
  const wide = frame(view({ focus: 'panel', queued: 1 }), 97, 63).at(-1);
  const narrow = frame(view({ focus: 'panel', queued: 1 }), 40, 24).at(-1);
  assert.match(wide, /\[ \] entry · Enter queue · S send · E copy · D delete/);
  assert.match(narrow, /^Enter queue · S send/);
  assert.ok(narrow.length < wide.length);
  assert.match(frame(view({ focus: 'composer' }), 97, 63).at(-1), /Ctrl\+S queues \+ reviews/);
});

test('resizing across every frame size preserves drafts, selection, queue and focus', () => {
  const v = view({ queued: 2, focus: 'composer' });
  v.handleInput('draft text kept across resizes');
  const before = v.snapshot();
  for (const [width, height] of [...SIZES, [12, 6], [200, 80], ...SIZES]) v.renderFrame(width, height);
  assert.deepEqual(v.snapshot(), before);
  assert.equal(v.getComposerText(), 'draft text kept across resizes');
  assert.equal(v.getMockQueue().length, 2);
});

test('the standalone prototype keeps both safety banners and the input contract', () => {
  const rows = frame(view({ hosted: false }), 97, 63);
  assert.match(rows[0], /INTERACTION PROTOTYPE \(MOCK\)/);
  assert.match(rows[1], /^NOT SAVED - /);
  assert.match(rows[2], /^Type ASCII \+ Enter/);
  assert.match(rows.at(-2), /session only, never sent/);
});
