import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const tui = () => ({ requestRender() {}, terminal: { rows: 40, columns: 80 } });
const CTRL_E = '\x05';
const CTRL_K = '\x0b';
const CTRL_U = '\x15';
const CTRL_J_KITTY = '\x1b[106;5u';
const CTRL_J_RELEASE = '\x1b[106;5:3u';

function viewWithQueue(...thoughts) {
  const view = new CompanionSpikeView(tui(), { noteText: 'note one\nnote two', hosted: true });
  view.setFocus('composer');
  for (const thought of thoughts) {
    view.handleInput(thought);
    view.handleInput(CTRL_E);
  }
  view.setFocus('panel');
  return view;
}

const queue = (view) => [...view.getMockQueue()];

test('panel Ctrl+J/K moves cards with identity-following focus; release and ordinary Enter do not reorder', () => {
  const view = viewWithQueue('one', 'two', 'three');
  const thirdId = view.snapshot().queue.items[2].id;
  view.handleInput(CTRL_K);
  assert.deepEqual(queue(view), ['one', 'three', 'two']);
  assert.equal(view.getFocusedQueue(), 1);
  assert.equal(view.snapshot().queue.items[1].id, thirdId);
  view.handleInput(CTRL_J_KITTY);
  assert.deepEqual(queue(view), ['one', 'two', 'three']);
  assert.equal(view.getFocusedQueue(), 2);
  view.handleInput(CTRL_J_RELEASE);
  assert.deepEqual(queue(view), ['one', 'two', 'three'], 'Kitty release is filtered');

  view.handleInput('\r');
  assert.deepEqual(queue(view).slice(0, 3), ['one', 'two', 'three']);
  assert.equal(queue(view).at(-1), 'note one\n', 'ordinary Enter keeps queue-selection behavior');
  view.handleInput('\n');
  assert.equal(queue(view).at(-1), 'note one\n', 'legacy LF is Enter, never the Ctrl+J reorder shortcut');
});

test('y duplicates only in the panel and modal y keeps confirmation priority', () => {
  const view = viewWithQueue('one', 'two');
  const source = view.snapshot().queue.items[1];
  view.handleInput('y');
  const copy = view.snapshot().queue.items[2];
  assert.deepEqual(queue(view), ['one', 'two', 'two']);
  assert.equal(view.getFocusedQueue(), 2);
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.requestId, source.requestId);
  assert.equal(copy.text, source.text);
  assert.equal(view.getReviewRequested(), false);

  view.handleInput('d');
  view.handleInput('y');
  assert.deepEqual(queue(view), ['one', 'two'], 'confirmation y deletes instead of duplicating');
  view.setFocus('composer');
  view.handleInput('yu');
  assert.equal(view.getComposerText(), 'yu', 'composer y/u remain ordinary typing');
});

test('u restores the last confirmed deletion around intervening additions and reorders', () => {
  const view = viewWithQueue('one', 'two', 'three');
  view.handleInput('k');
  const deleted = view.snapshot().queue.items[1];
  view.handleInput('d');
  view.handleInput('y');
  assert.deepEqual(queue(view), ['one', 'three']);
  assert.equal(view.enqueueExternalText('four', 'web'), true);
  view.setFocus('panel');
  view.handleInput(CTRL_K);
  assert.deepEqual(queue(view), ['one', 'four', 'three']);
  view.handleInput('u');
  assert.deepEqual(queue(view), ['one', 'two', 'four', 'three']);
  assert.equal(view.snapshot().queue.items[1].id, deleted.id);
  assert.equal(view.getFocusedQueue(), 1);
  assert.equal(view.getReviewRequested(), false);
  view.handleInput('u');
  assert.match(view.getNotice(), /nothing to undo/);
});

test('cancelled clear retains delete undo, while confirmed clear consumes it; empty actions are safe', () => {
  const view = viewWithQueue('one', 'two');
  view.handleInput('d');
  view.handleInput('y');
  view.handleInput(CTRL_U);
  assert.equal(view.isConfirmingClear(), true);
  view.handleInput('n');
  view.handleInput('u');
  assert.deepEqual(queue(view), ['one', 'two']);

  view.handleInput('d');
  view.handleInput('y');
  view.handleInput(CTRL_U);
  view.handleInput('y');
  assert.deepEqual(queue(view), []);
  view.handleInput('u');
  assert.match(view.getNotice(), /nothing to undo/);
  for (const key of ['y', CTRL_K, CTRL_J_KITTY, 'd']) view.handleInput(key);
  assert.deepEqual(queue(view), []);
});

test('card action hints and notices remain bounded in a narrow frame', () => {
  const view = viewWithQueue('one');
  view.handleInput('u');
  const rows = view.renderFrame(40, 24);
  assert.equal(rows.length, 24);
  assert.ok(rows.every((row) => visibleWidth(row) <= 40));
  const plain = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain.some((row) => row.includes('nothing to undo')));
  assert.match(plain.at(-1), /^Enter queue · S send · j\/k · s · \? keys$/);
});
