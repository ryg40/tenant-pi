// Queue codec: optional `origin` provenance tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyQueue, enqueue, parseQueue, serializeQueue } from '../../dist/src/queue/pending.mjs';

test('origin round-trips through enqueue, serialize and parse; items without it are unchanged', () => {
  let q = enqueue(emptyQueue(), { expectedRevision: 0, requestId: 'r1', text: 'from the browser', origin: 'web' });
  q = enqueue(q, { expectedRevision: 1, requestId: 'r2', text: 'typed here' });
  assert.equal(q.items[0].origin, 'web');
  assert.equal(q.items[1].origin, undefined);
  const text = serializeQueue(q);
  assert.ok(text.includes('"origin":"web"'));
  const back = parseQueue(text);
  assert.equal(back.items[0].origin, 'web');
  assert.equal(back.items[1].origin, undefined);
  assert.equal(serializeQueue(back), text);
});

test('origin must be a short lowercase tag; unknown keys stay rejected', () => {
  for (const bad of ['', 'Web', 'a b', 'x'.repeat(17), 42]) {
    assert.throws(() => enqueue(emptyQueue(), { expectedRevision: 0, requestId: 'r', text: 't', origin: bad }), /origin must be a short lowercase tag/);
  }
  const q = enqueue(emptyQueue(), { expectedRevision: 0, requestId: 'r', text: 't', origin: 'web' });
  const tampered = JSON.parse(serializeQueue(q));
  tampered.items[0].origin = 'W';
  assert.throws(() => parseQueue(JSON.stringify(tampered)), /origin must be a short lowercase tag/);
  tampered.items[0].origin = 'web';
  tampered.items[0].extra = 1;
  assert.throws(() => parseQueue(JSON.stringify(tampered)), /unknown field in item/);
});
