import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  duplicateItem,
  emptyQueue,
  enqueue,
  moveItem,
  parseQueue,
  removeItemWithUndo,
  restoreItem,
  serializeQueue,
  setComposer,
} from '../../dist/src/queue/pending.mjs';

function queueOf(...texts) {
  return texts.reduce((queue, text, index) => enqueue(queue, {
    expectedRevision: queue.revision,
    requestId: `request-${index + 1}`,
    text,
    source: { documentRevision: 7, startLine: index + 1, endLine: index + 1 },
    origin: 'web',
  }), emptyQueue());
}

const texts = (queue) => queue.items.map((item) => item.text);

test('moveItem reorders one step, preserves receipts through the codec, and keeps boundaries as no-ops', () => {
  const original = queueOf('one', 'two', 'three');
  const moved = moveItem(original, original.items[1].id, -1);
  assert.deepEqual(texts(moved), ['two', 'one', 'three']);
  assert.equal(moved.revision, original.revision + 1);
  assert.deepEqual(texts(parseQueue(serializeQueue(moved))), ['two', 'one', 'three']);
  const boundary = moveItem(moved, moved.items[0].id, -1);
  assert.equal(boundary.revision, moved.revision);
  assert.equal(serializeQueue(boundary), serializeQueue(moved));
  assert.equal(moveItem(moved, 'unknown', 1).revision, moved.revision);
});

test('duplicateItem inserts an exact-metadata copy with fresh identity and an enqueue receipt', () => {
  const original = queueOf('one', 'two');
  const source = original.items[0];
  const duplicated = duplicateItem(original, source.id, 'fresh-request');
  const copy = duplicated.items[1];
  assert.deepEqual(texts(duplicated), ['one', 'one', 'two']);
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.requestId, source.requestId);
  assert.equal(copy.requestId, 'fresh-request');
  assert.equal(copy.text, source.text);
  assert.deepEqual(copy.source, source.source);
  assert.equal(copy.origin, source.origin);
  assert.equal(duplicated.revision, original.revision + 1);
  const parsed = parseQueue(serializeQueue(duplicated));
  assert.equal(parsed.items[1].id, copy.id);
  assert.throws(() => duplicateItem(original, source.id, source.requestId), /requestId is already present/);
  const withComposerReceipt = setComposer(original, {
    expectedRevision: original.revision,
    requestId: 'composer-request',
    text: 'draft',
  });
  assert.throws(() => duplicateItem(withComposerReceipt, source.id, 'composer-request'), /requestId is already present/);
  assert.equal(serializeQueue(original), serializeQueue(queueOf('one', 'two')), 'collision leaves the input snapshot untouched');
});

test('single-item undo restores at the clamped original index without rolling back intervening state', () => {
  const original = queueOf('one', 'two', 'three');
  const removed = removeItemWithUndo(original, original.items[1].id);
  assert.ok(removed.undo);
  assert.ok(Object.isFrozen(removed.undo));
  assert.ok(Object.isFrozen(removed.undo.item));
  assert.ok(Object.isFrozen(removed.undo.receipt));
  let current = enqueue(removed.queue, {
    expectedRevision: removed.queue.revision,
    requestId: 'request-four',
    text: 'four',
  });
  current = moveItem(current, current.items[2].id, -1);
  current = setComposer(current, { expectedRevision: current.revision, requestId: 'composer-change', text: 'draft kept' });
  const restored = restoreItem(current, removed.undo);
  assert.deepEqual(texts(restored), ['one', 'two', 'four', 'three']);
  assert.equal(restored.items[1].id, original.items[1].id);
  assert.equal(restored.composer, 'draft kept');
  assert.equal(restored.revision, current.revision + 1);
  assert.equal(serializeQueue(parseQueue(serializeQueue(restored))), serializeQueue(restored));

  const three = queueOf('first', 'second', 'last');
  const last = removeItemWithUndo(three, three.items[2].id);
  const withNew = enqueue(emptyQueue(), { expectedRevision: 0, requestId: 'unrelated', text: 'new' });
  assert.deepEqual(texts(restoreItem(withNew, last.undo)), ['new', 'last'], 'former index is clamped to current length');
});

test('effective card operations refuse atomically at maximum revision while no-ops remain valid', () => {
  const atMaximumRevision = (queue) => {
    const raw = JSON.parse(serializeQueue(queue));
    raw.revision = Number.MAX_SAFE_INTEGER;
    return parseQueue(JSON.stringify(raw));
  };
  const maximum = atMaximumRevision(queueOf('one', 'two'));
  const unchanged = serializeQueue(maximum);
  const effective = [
    () => moveItem(maximum, maximum.items[0].id, 1),
    () => duplicateItem(maximum, maximum.items[0].id, 'fresh-at-maximum'),
    () => removeItemWithUndo(maximum, maximum.items[0].id),
  ];
  for (const operation of effective) {
    assert.throws(operation, /revision must be a nonnegative safe integer/);
    assert.equal(serializeQueue(maximum), unchanged);
  }

  const source = queueOf('deleted');
  const { undo } = removeItemWithUndo(source, source.items[0].id);
  const emptyAtMaximum = atMaximumRevision(emptyQueue());
  const emptyUnchanged = serializeQueue(emptyAtMaximum);
  assert.throws(() => restoreItem(emptyAtMaximum, undo), /revision must be a nonnegative safe integer/);
  assert.equal(serializeQueue(emptyAtMaximum), emptyUnchanged);

  const boundary = moveItem(maximum, maximum.items[0].id, -1);
  assert.equal(boundary.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(serializeQueue(boundary), unchanged);
  assert.equal(duplicateItem(maximum, 'missing', 'unused').revision, Number.MAX_SAFE_INTEGER);
  assert.equal(removeItemWithUndo(maximum, 'missing').queue.revision, Number.MAX_SAFE_INTEGER);
});

test('restore validates its token and refuses identity conflicts atomically', () => {
  const original = queueOf('one');
  const { queue, undo } = removeItemWithUndo(original, original.items[0].id);
  const conflicting = enqueue(queue, {
    expectedRevision: queue.revision,
    requestId: original.items[0].requestId,
    text: original.items[0].text,
    source: original.items[0].source,
    origin: original.items[0].origin,
  });
  const before = serializeQueue(conflicting);
  assert.throws(() => restoreItem(conflicting, undo), /identity is already present/);
  assert.equal(serializeQueue(conflicting), before);
  assert.throws(() => restoreItem(queue, { ...undo, index: -1 }), /index must be a nonnegative/);
  assert.equal(removeItemWithUndo(original, 'missing').undo, undefined);
  assert.equal(removeItemWithUndo(original, 'missing').queue.revision, original.revision);
});
