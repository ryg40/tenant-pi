// Entry navigation in the queue panel: whole-entry highlight, queue/send/copy/delete
// of the highlighted entry, Ctrl+N note blocks, notebook paste and the `?` reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSpikeView, KEY_REFERENCE, keyReferenceLines, keyReferenceText } from '../../dist/src/companion/view.mjs';

const NOTE = [
  'free paragraph line one', 'free paragraph line two', '',
  '-- Queued 2026-09-08 10:00Z --', 'first prompt', 'second line', '-- end --', '',
  'lonely line', '',
  '-- Note 2026-09-08 10:05Z --', 'note body', '',
].join('\n');
const INVERSE = '\x1b[7m';
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const tui = () => ({ requestRender() {}, terminal: { rows: 40, columns: 100 } });
function view({ hosted = true, noteText = NOTE } = {}) {
  const v = new CompanionSpikeView(tui(), { noteText, hosted, overviewNavigation: hosted, trackingNavigation: false });
  v.setFocus('panel');
  return v;
}
/** Notebook rows painted inverse end to end; the library's one-cell cursor never wraps a whole row. */
function highlighted(v) {
  const rows = v.renderFrame(100, 40);
  const start = rows.findIndex((row) => row.includes('NOTEBOOK'));
  return plain(rows.slice(start + 1).filter((row) => row.startsWith(INVERSE) && row.endsWith('\x1b[0m'))).map((row) => row.trimEnd());
}

test('[ and ] walk whole entries, the notebook paints exactly those lines, and the notice names the entry', () => {
  const v = view();
  v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 1, endLine: 2 });
  assert.deepEqual(highlighted(v), ['free paragraph line one', 'free paragraph line two']);
  v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 4, endLine: 7 });
  assert.match(v.getNotice(), /^entry 2\/4 · lines 4-7 · Queued 2026-09-08 10:00Z · Enter queues, S sends, E copies, D deletes$/);
  assert.deepEqual(highlighted(v), ['-- Queued 2026-09-08 10:00Z --', 'first prompt', 'second line', '-- end --']);
  v.handleInput(']'); v.handleInput(']'); v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 11, endLine: 12 }, 'stops at the last entry');
  v.handleInput('['); v.handleInput('[');
  assert.deepEqual(v.getSelection(), { startLine: 4, endLine: 7 });
  v.setFocus('editor');
  assert.equal(highlighted(v).length, 0, 'the highlight belongs to the panel focus only');
});

test('a long notebook scrolls so the selected entry shows from its first line', () => {
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push(`paragraph ${i}`, '');
  lines.push('-- Note last --', 'body a', 'body b', '-- end --', '');
  const v = view({ noteText: lines.join('\n') });
  for (let i = 0; i < 61; i++) v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 121, endLine: 124 });
  const rows = highlighted(v);
  assert.equal(rows[0], '-- Note last --');
  assert.equal(rows.length, 4);
  v.handleInput('[');
  assert.equal(highlighted(v)[0], 'paragraph 60');
});

test('Enter queues a marked entry without its markers and records the body lines as source', () => {
  const v = view();
  v.handleInput(']'); v.handleInput(']');
  v.handleInput('\r');
  assert.deepEqual(v.getMockQueue(), ['first prompt\nsecond line\n']);
  assert.deepEqual(v.snapshot().queue.items[0].source, { documentRevision: 0, startLine: 5, endLine: 6 });
  assert.equal(v.getNoteText(), NOTE, 'queueing never edits the notebook');
});

test('a line selection that is not an entry still queues the exact lines, and an empty block refuses', () => {
  const v = view();
  v.handleInput('\x1b[B'); v.handleInput('\x1b[B');
  v.handleInput('\r');
  assert.deepEqual(v.getMockQueue(), ['\n'], 'line 3 alone is the blank line');
  const empty = view({ noteText: '-- Note x --\n-- end --\n' });
  empty.handleInput(']');
  empty.handleInput('\r');
  assert.deepEqual(empty.getMockQueue(), []);
  assert.match(empty.getNotice(), /no text between its markers/);
});

test('S queues the highlighted entry and asks for its review; session-only views refuse', () => {
  const v = view();
  v.handleInput(']'); v.handleInput(']');
  v.handleInput('S');
  assert.deepEqual(v.getMockQueue(), ['first prompt\nsecond line\n']);
  assert.equal(v.getReviewRequested(), true);
  assert.equal(v.consumeReviewRequest(), 0);
  const local = view({ hosted: false });
  local.handleInput(']'); local.handleInput('S');
  assert.deepEqual(local.getMockQueue(), []);
  assert.match(local.getNotice(), /session only, never sent/);
});

test('E copies the highlighted entry into an empty composer and refuses over a draft', () => {
  const v = view();
  v.handleInput(']'); v.handleInput(']');
  v.handleInput('E');
  assert.equal(v.getComposerText(), 'first prompt\nsecond line\n');
  assert.equal(v.snapshot().focus, 'composer');
  assert.match(v.getNotice(), /copied notebook lines 5-6 into the composer/);
  v.setFocus('panel');
  v.handleInput('E');
  assert.match(v.getNotice(), /composer has a draft/);
  assert.deepEqual(v.getMockQueue(), [], 'copying never queues');
});

test('D asks y/n, then removes exactly the highlighted lines and bumps the note revision', () => {
  const v = view();
  v.handleInput(']'); v.handleInput(']');
  v.handleInput('D');
  assert.equal(v.getNotice(), 'Delete notebook lines 4-7? y = delete, n/Esc = keep');
  v.handleInput('n');
  assert.equal(v.getNoteText(), NOTE);
  v.handleInput('D'); v.handleInput('y');
  assert.equal(v.getNoteText(), ['free paragraph line one', 'free paragraph line two', '', '', 'lonely line', '', '-- Note 2026-09-08 10:05Z --', 'note body', ''].join('\n'));
  assert.equal(v.snapshot().documentRevision, 1);
  assert.match(v.getNotice(), /deleted notebook lines 4-7/);
  assert.deepEqual(highlighted(v), [''], 'the selection collapses to the line where the entry was');
});

test('lowercase e/d/s keep acting on queue cards; uppercase never touches the queue', () => {
  const v = view();
  v.setFocus('composer');
  v.handleInput('card text'); v.handleInput('\x05');
  v.setFocus('panel');
  v.handleInput('D');
  assert.match(v.getNotice(), /^Delete notebook lines/);
  v.handleInput('n');
  v.handleInput('d');
  assert.equal(v.getNotice(), 'Delete thought 1? y = delete, n/Esc = keep');
  v.handleInput('y');
  assert.deepEqual(v.getMockQueue(), []);
});

test('Ctrl+N in the notebook inserts a closed note block with the cursor on its body line', () => {
  const v = view({ noteText: 'existing\n' });
  v.setFocus('editor');
  v.handleInput('\x1b[F');
  v.handleInput('\x0e');
  assert.match(v.getNotice(), /new note block inserted/);
  v.handleInput('typed body');
  assert.match(v.getNoteText(), /^existing\n-- Note \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z --\ntyped body\n-- end --\n$/);
  assert.equal(v.snapshot().documentRevision, 2);
  v.setFocus('panel');
  v.handleInput(']'); v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 2, endLine: 4 });
});

test('queued composer prompts are archived as closed blocks that [ ] can reach', () => {
  const v = view({ noteText: 'note\n' });
  v.setFocus('composer');
  v.handleInput('a thought'); v.handleInput('\x05');
  assert.match(v.getNoteText(), /^note\n\n-- Queued \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z --\na thought\n-- end --\n$/);
  v.setFocus('panel');
  v.handleInput(']'); v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 3, endLine: 5 });
});

test('bracketed paste lands in the notebook when it has focus', () => {
  const v = view({ noteText: 'note\n' });
  v.setFocus('editor');
  v.handleInput('\x1b[F');
  v.handleInput('\x1b[200~pasted one\r\npasted\ttwo\x1b[201~');
  assert.equal(v.getNoteText(), 'note\npasted one\npasted  two');
  assert.equal(v.snapshot().documentRevision, 1);
  assert.match(v.getNotice(), /pasted 22 chars into the notebook \(saved\)/);
  v.setFocus('panel');
  v.handleInput('\x1b[200~nope\x1b[201~');
  assert.equal(v.getNoteText(), 'note\npasted one\npasted  two');
  assert.match(v.getNotice(), /paste lands in the composer or the notebook/);
});

test('? shows the key reference for the focused region in the queue region and any key closes it', () => {
  const v = view();
  v.handleInput('?');
  let rows = plain(v.renderFrame(100, 40));
  const header = rows.findIndex((row) => row.includes('KEYS · QUEUE · any key closes'));
  assert.ok(header > 0);
  assert.ok(rows[header + 1].includes('prev / next notebook entry'));
  assert.ok(rows.some((row) => row.includes('Ctrl+O') && row.includes('project overview')), 'global keys follow the region keys');
  v.handleInput('?');
  rows = plain(v.renderFrame(100, 40));
  assert.ok(!rows.some((row) => row.includes('KEYS ·')));
  assert.equal(v.getNotice(), 'key reference closed');
  v.handleInput('?'); v.handleInput(']');
  assert.deepEqual(v.getSelection(), { startLine: 1, endLine: 2 }, 'a real key closes the list and still acts');
  assert.ok(!plain(v.renderFrame(100, 40)).some((row) => row.includes('KEYS ·')));
});

test('the key reference fits its rows at every width and --help lists every region', () => {
  for (const width of [30, 40, 72, 97, 120, 160]) {
    for (const focus of ['panel', 'editor', 'composer', 'tracking']) {
      const lines = keyReferenceLines(focus, width, 14);
      assert.ok(lines.length <= 14, `${focus}@${width} rows`);
      assert.ok(lines.every((line) => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length <= width), `${focus}@${width} width`);
    }
  }
  assert.ok(keyReferenceLines('panel', 40, 14).at(-1).includes('more'), 'overflow is announced, not cut silently');
  const text = keyReferenceText();
  for (const region of Object.keys(KEY_REFERENCE)) for (const [key, label] of KEY_REFERENCE[region]) assert.ok(text.includes(key) && text.includes(label), `${key} listed`);
});
