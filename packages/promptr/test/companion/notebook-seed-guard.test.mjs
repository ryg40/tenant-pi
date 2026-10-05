import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSharedState, saveSharedState } from '../../dist/src/companion/spike.mjs';
import { emptyQueue } from '../../dist/src/queue/pending.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-seed-guard-'));
}

function snapshot(noteText) {
  return {
    noteText,
    composerText: '',
    queue: emptyQueue(),
    documentRevision: 0,
    selection: { startLine: 1, endLine: 1 },
    focus: 'editor',
  };
}

test('missing scratch.md seeds the sample and skipNote never persists it', () => {
  const dir = tempDir();
  const loaded = loadSharedState(dir);
  assert.equal(loaded.noteSeeded, true);
  assert.match(loaded.noteText, /^# Curated sample note/);
  // The persist() caller passes skipNote while the text is still the seed.
  saveSharedState(dir, snapshot(loaded.noteText), { skipNote: true });
  assert.equal(fs.existsSync(path.join(dir, 'scratch.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'queue.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'composer.md')), true);
});

test('real notes typed after a seeded load are written', () => {
  const dir = tempDir();
  const loaded = loadSharedState(dir);
  const edited = snapshot(`${loaded.noteText}\nMy real note.`);
  // Caller clears skipNote once the text differs from the seed.
  const skipNote = loaded.noteSeeded && edited.noteText === loaded.noteText;
  saveSharedState(dir, edited, skipNote ? { skipNote: true } : undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'scratch.md'), 'utf8'), edited.noteText);
  const reloaded = loadSharedState(dir);
  assert.equal(reloaded.noteSeeded, false);
  assert.equal(reloaded.noteText, edited.noteText);
});

test('an existing notebook round-trips untouched', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'scratch.md'), 'my notes\nline two\n');
  const loaded = loadSharedState(dir);
  assert.equal(loaded.noteSeeded, false);
  assert.equal(loaded.noteText, 'my notes\nline two\n');
  saveSharedState(dir, snapshot(loaded.noteText));
  assert.equal(fs.readFileSync(path.join(dir, 'scratch.md'), 'utf8'), 'my notes\nline two\n');
});

test('empty or unsupported scratch.md is seeded and preserved, not overwritten', () => {
  const emptyDir = tempDir();
  fs.writeFileSync(path.join(emptyDir, 'scratch.md'), '');
  const emptyLoaded = loadSharedState(emptyDir);
  assert.equal(emptyLoaded.noteSeeded, true);
  saveSharedState(emptyDir, snapshot(emptyLoaded.noteText), { skipNote: true });
  assert.equal(fs.readFileSync(path.join(emptyDir, 'scratch.md'), 'utf8'), '');

  const oddDir = tempDir();
  fs.writeFileSync(path.join(oddDir, 'scratch.md'), 'caf\u00e9\n');
  const oddLoaded = loadSharedState(oddDir);
  assert.equal(oddLoaded.noteSeeded, true);
  saveSharedState(oddDir, snapshot(oddLoaded.noteText), { skipNote: true });
  assert.equal(fs.readFileSync(path.join(oddDir, 'scratch.md'), 'utf8'), 'caf\u00e9\n');
});
