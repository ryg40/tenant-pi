// Pure notebook entry model: marked `-- label -- … -- end --` blocks and paragraphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archivedPromptBlock, entryIndexAt, entryMatching, isBeginMarker, isEndMarker, newNoteBlock,
  notebookEntries, removeLines, stepEntry,
} from '../../dist/src/companion/notebook-entries.mjs';

const NOTE = [
  'free paragraph line one', 'free paragraph line two', '',
  '-- Queued 2026-09-08 10:00Z --', 'first prompt', 'second line', '-- end --', '',
  'lonely line', '',
  '-- Note 2026-09-08 10:05Z --', 'note body', '',
].join('\n');

test('entries: paragraphs and closed marked blocks, with bodies excluding the markers', () => {
  const entries = notebookEntries(NOTE);
  assert.deepEqual(entries.map((e) => [e.kind, e.startLine, e.endLine, e.bodyStart, e.bodyEnd]), [
    ['paragraph', 1, 2, 1, 2],
    ['marked', 4, 7, 5, 6],
    ['paragraph', 9, 9, 9, 9],
    ['marked', 11, 12, 12, 12],
  ]);
  assert.equal(entries[1].label, 'Queued 2026-09-08 10:00Z');
  assert.equal(entries[0].label, 'free paragraph line one');
  assert.ok(Object.isFrozen(entries) && Object.isFrozen(entries[0]));
});

test('entries: an unclosed block ends before the next opener or at the end, without trailing blanks', () => {
  const text = '-- Note a --\nbody\n\n\n-- Note b --\n\n';
  const entries = notebookEntries(text);
  assert.deepEqual(entries.map((e) => [e.startLine, e.endLine, e.bodyStart, e.bodyEnd]), [[1, 2, 2, 2], [5, 5, 6, 5]]);
  assert.ok(entries[1].bodyStart > entries[1].bodyEnd, 'an empty block has no body');
});

test('entries: stray end markers and blank text are skipped; markers are recognised strictly', () => {
  assert.deepEqual(notebookEntries(''), []);
  assert.deepEqual(notebookEntries('\n\n'), []);
  assert.deepEqual(notebookEntries('-- end --\nline\n').map((e) => [e.kind, e.startLine]), [['paragraph', 2]]);
  assert.ok(isBeginMarker('-- Queued x --') && isBeginMarker('  -- Note --  '));
  assert.ok(!isBeginMarker('-- end --') && isEndMarker('-- end --') && !isBeginMarker('-- --') && !isBeginMarker('--x--'));
});

test('stepEntry snaps a partial selection first, then steps and stops at the ends', () => {
  const entries = notebookEntries(NOTE);
  assert.equal(stepEntry(entries, { startLine: 5, endLine: 5 }, 1).index, 1, 'a line inside entry 2 snaps to entry 2');
  assert.equal(stepEntry(entries, { startLine: 4, endLine: 7 }, 1).index, 2);
  assert.equal(stepEntry(entries, { startLine: 4, endLine: 7 }, -1).index, 0);
  assert.equal(stepEntry(entries, { startLine: 1, endLine: 2 }, -1).index, 0, 'no wrap at the top');
  assert.equal(stepEntry(entries, { startLine: 11, endLine: 12 }, 1).index, 3, 'no wrap at the bottom');
  assert.equal(stepEntry(entries, { startLine: 3, endLine: 3 }, 1).index, 0, 'a blank line belongs to the entry before it');
  assert.equal(stepEntry([], { startLine: 1, endLine: 1 }, 1), undefined);
  assert.equal(entryIndexAt(entries, 8), 1);
  assert.equal(entryMatching(entries, { startLine: 9, endLine: 9 }).label, 'lonely line');
  assert.equal(entryMatching(entries, { startLine: 9, endLine: 10 }), undefined);
});

test('removeLines drops exactly the inclusive range and keeps the trailing newline rule', () => {
  assert.equal(removeLines('a\nb\nc\n', 2, 2), 'a\nc\n');
  assert.equal(removeLines('a\nb\nc', 1, 3), '');
  assert.equal(removeLines('a\nb\n', 5, 9), 'a\nb\n', 'out of range changes nothing');
  assert.equal(removeLines(NOTE, 4, 7).split('\n')[3], '');
});

test('the blocks the view inserts are closed entries', () => {
  assert.equal(newNoteBlock('2026-09-08 12:00Z'), '-- Note 2026-09-08 12:00Z --\n\n-- end --\n');
  assert.equal(archivedPromptBlock('s', 'hello'), '-- Queued s --\nhello\n-- end --\n');
  assert.equal(archivedPromptBlock('s', 'hello\n'), '-- Queued s --\nhello\n-- end --\n');
  const entries = notebookEntries(`${newNoteBlock('s')}${archivedPromptBlock('t', 'x')}`);
  assert.deepEqual(entries.map((e) => [e.kind, e.startLine, e.endLine]), [['marked', 1, 3], ['marked', 4, 6]]);
});
