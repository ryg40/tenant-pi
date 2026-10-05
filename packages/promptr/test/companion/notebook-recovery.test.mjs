import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestPromptLogNotebook, workspaceNotebook } from '../../dist/src/sync/workspace-hydrate.mjs';
import { renderWorkspaceMirror } from '../../dist/src/sync/workspace-mirror.mjs';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';

const content = { project: 'p', gitRef: 'main', gitHead: 'abc', gitDirty: false, piStatus: 'idle', queue: [], composer: '' };
const page = (note, extra = {}) => renderWorkspaceMirror({ ...content, ...extra, note }, '2026-09-09T00:00:00Z');
const view = () => new CompanionSpikeView({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, { noteText: 'seed', hosted: true });

test('reads legacy notebook fences without confusing embedded headings or backticks', () => {
  const note = '# owner\n\n```js\ncode\n```\n\n';
  assert.equal(workspaceNotebook(page(note, { composer: '## Notebook\n\n```\nwrong\n```', queue: [{ text: '## Notebook\n\n```\nwrong\n```' }] })), note);
  assert.equal(workspaceNotebook(page('no trailing newline')), 'no trailing newline\n');
  assert.equal(workspaceNotebook(page('')), '\n');
});

test('missing and malformed notebook sections do not fabricate notes', () => {
  assert.equal(workspaceNotebook(renderWorkspaceMirror(content, 'now')), undefined);
  assert.equal(workspaceNotebook('## Notebook\n\n```\ntruncated'), undefined);
  assert.equal(workspaceNotebook('## Notebook\nnot fenced'), undefined);
});

test('reads the latest complete note revision from shared history', () => {
  const history = [
    '<!-- promptr:log desk 1-3 -->',
    '',
    '### 1 note-revision · now · desk', '', '```', 'old', '```', '',
    '### 2 workspace-import · now · desk', '', '````', '### 99 note-revision · fake · nested', '', '```', 'wrong', '```', '````', '',
    '### 3 note-revision · later · desk', '', '```', 'latest', '```', '',
  ].join('\n');
  assert.equal(latestPromptLogNotebook(history), 'latest\n');
  assert.equal(latestPromptLogNotebook('### 1 note-revision · now · desk\n\n```\ntruncated'), undefined);
  assert.equal(latestPromptLogNotebook('### 1 queue-add · now · desk\n\n```\ntext\n```'), undefined);
});

test('restores untouched notebook without changing composer, queue or focus', () => {
  const v = view();
  const before = v.snapshot();
  assert.equal(v.restoreNotebook('seed', workspaceNotebook(page('real notes\n'))), true);
  assert.equal(v.getNoteText(), 'real notes\n');
  assert.equal(v.snapshot().queue, before.queue);
  assert.equal(v.snapshot().composerText, before.composerText);
  assert.equal(v.snapshot().focus, before.focus);
  assert.equal(v.restoreNotebook('real notes\n', 'second'), false);
});

test('refuses unsupported content, mismatches, and a notebook edited during the read', () => {
  const v = view();
  assert.equal(v.restoreNotebook('seed', 'caf\u00e9'), false);
  assert.equal(v.restoreNotebook('other', 'remote'), false);
  v.handleInput('x');
  assert.equal(v.restoreNotebook(v.getNoteText(), 'remote'), false);
  assert.notEqual(v.getNoteText(), 'remote');
});
