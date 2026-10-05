// Append-only prompt-log: local JSONL, queue diffing, remote batches with
// idempotent markers, reconnect catch-up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 appendPromptLog, batchMarker, createPromptLogSyncer, diffQueueEvents, parsePromptLog, promptLogFiles,
 promptLogStatusLabel, readPromptLog, readSyncCursor, remoteSyncedThrough, renderPromptLogBatch, syncPromptLog, textHash,
} from '../../dist/src/sync/prompt-log.mjs';
import { projectPagesFor } from '../../dist/src/sync/project-pages.mjs';
import { emptyQueue, enqueue, removeItem } from '../../dist/src/queue/pending.mjs';
import { clientIdentity, newClientId } from '../../dist/src/state/client.mjs';
import { parseWorkspacePage, workspaceImportDecision } from '../../dist/src/sync/workspace-hydrate.mjs';
import { renderWorkspaceMirror } from '../../dist/src/sync/workspace-mirror.mjs';

const pages = projectPagesFor('https://wiki.example', 'Promptr');
const NOW = '2026-09-08T10:00:00.000Z';

function memIo(initial = {}) {
 const files = { ...initial };
 return {
  files,
  readFile: (f) => files[f],
  appendFile: (f, t) => { files[f] = (files[f] ?? '') + t; },
  writeFile: (f, t) => { files[f] = t; },
 };
}

function fakeClient(docs = {}, { failWrite = false, failRead = false } = {}) {
 const calls = [];
 return {
  docs, calls,
  async readDocument(name) { calls.push(['GET', name]); if (failRead) throw new Error('OpenKnowledge unavailable'); return docs[name] ?? null; },
  async createPage(name) { calls.push(['POST create', name]); if (name in docs) return 'exists'; docs[name] = ''; return 'created'; },
  async writeMarkdown(name, markdown, position, summary) {
   calls.push(['POST write', name, position, summary]);
   if (failWrite) throw new Error('OpenKnowledge write HTTP 502');
   docs[name] = position === 'append' ? (docs[name] ?? '') + markdown : markdown;
  },
 };
}

test('local append assigns increasing seq, is tolerant to malformed lines, and never rewrites', () => {
 const io = memIo();
 const files = promptLogFiles('/state');
 const first = appendPromptLog(files, io, 'laptop-1a2b', NOW, [{ kind: 'queue-add', text: 'first thought', itemId: 'i1', origin: 'composer' }]);
 assert.deepEqual(first.map((e) => e.seq), [1]);
 io.appendFile(files.log, 'garbage line\n{"seq":"x"}\n');
 const second = appendPromptLog(files, io, 'laptop-1a2b', NOW, [{ kind: 'queue-delete', text: 'first thought', itemId: 'i1' }, { kind: 'note-revision', text: '# note' }]);
 assert.deepEqual(second.map((e) => e.seq), [2, 3]);
 const all = readPromptLog(files, io);
 assert.deepEqual(all.map((e) => [e.seq, e.kind]), [[1, 'queue-add'], [2, 'queue-delete'], [3, 'note-revision']]);
 assert.equal(all[0].origin, 'composer');
 assert.ok(io.files[files.log].includes('garbage line'), 'the log is never rewritten');
 assert.deepEqual(parsePromptLog(undefined), []);
 assert.equal(textHash('a'), textHash('a'));
 assert.notEqual(textHash('a'), textHash('b'));
});

test('diffQueueEvents reports adds and deletes by item id; an edit is delete then add', () => {
 const q0 = emptyQueue();
 const q1 = enqueue(q0, { expectedRevision: 0, requestId: 'r1', text: 'alpha', origin: 'web' });
 const q2 = enqueue(q1, { expectedRevision: 1, requestId: 'r2', text: 'beta' });
 const adds = diffQueueEvents(q0, q2);
 assert.deepEqual(adds.map((e) => [e.kind, e.text, e.origin]), [['queue-add', 'alpha', 'web'], ['queue-add', 'beta', 'composer']]);
 const q3 = removeItem(q2, q2.items[0].id);
 const removed = diffQueueEvents(q2, q3);
 assert.deepEqual(removed.map((e) => [e.kind, e.text, e.itemId]), [['queue-delete', 'alpha', q2.items[0].id]]);
 assert.deepEqual(diffQueueEvents(q3, q3), []);
});

test('remote sync appends bounded batches with markers, advances the cursor, and skips a batch already on the page', async () => {
 const io = memIo();
 const files = promptLogFiles('/state');
 appendPromptLog(files, io, 'laptop-1a2b', NOW, [
  { kind: 'queue-add', text: 'one ``` fenced', itemId: 'a' },
  { kind: 'send-attempt', text: 'one ``` fenced', meta: { outcome: 'submitted' } },
 ]);
 const client = fakeClient({});
 const result = await syncPromptLog(files, io, client, pages, 'laptop-1a2b', () => NOW);
 assert.deepEqual(result, { state: 'synced', pending: 0, syncedThrough: 2 });
 assert.deepEqual(client.calls.map((c) => c[0]), ['GET', 'POST create', 'POST write']);
 const page = client.docs[pages.promptLog];
 assert.ok(page.includes(batchMarker('laptop-1a2b', 1, 2)));
 assert.ok(page.includes('### 1 queue-add · 2026-09-08T10:00:00.000Z · laptop-1a2b · item a'));
 assert.ok(page.includes('### 2 send-attempt · 2026-09-08T10:00:00.000Z · laptop-1a2b · outcome submitted'));
 assert.ok(page.includes('````\none ``` fenced\n````'));
 assert.equal(readSyncCursor(files, io).syncedThrough, 2);
 assert.equal(remoteSyncedThrough(page, 'laptop-1a2b'), 2);
 assert.equal(remoteSyncedThrough(page, 'other'), 0);

 // Unknown-outcome recovery: the cursor is behind but the page has the batch.
 io.writeFile(files.cursor, JSON.stringify({ version: 1, syncedThrough: 0 }));
 const again = await syncPromptLog(files, io, client, pages, 'laptop-1a2b', () => NOW);
 assert.deepEqual(again, { state: 'synced', pending: 0, syncedThrough: 2 });
 assert.equal(client.calls.filter((c) => c[0] === 'POST write').length, 1, 'no duplicate append');

 // A second client's entries with the same seq numbers are independent.
 const io2 = memIo();
 appendPromptLog(files, io2, 'desk-ffff', NOW, [{ kind: 'queue-add', text: 'from the other machine' }]);
 const other = await syncPromptLog(files, io2, client, pages, 'desk-ffff', () => NOW);
 assert.equal(other.state, 'synced');
 assert.ok(client.docs[pages.promptLog].includes(batchMarker('desk-ffff', 1, 1)));
});

test('offline and failed writes retain entries locally, report pending/offline, and catch up on retry', async () => {
 const io = memIo();
 const files = promptLogFiles('/state');
 appendPromptLog(files, io, 'c', NOW, [{ kind: 'briefing-save', text: '# brief' }]);
 assert.deepEqual(await syncPromptLog(files, io, undefined, pages, 'c', () => NOW), { state: 'unbound', pending: 1, syncedThrough: 0, reason: 'credentials not exported' });
 assert.deepEqual(await syncPromptLog(files, io, fakeClient({}), undefined, 'c', () => NOW), { state: 'unbound', pending: 1, syncedThrough: 0, reason: 'not connected' });
 const down = fakeClient({}, { failRead: true });
 const offline = await syncPromptLog(files, io, down, pages, 'c', () => NOW);
 assert.equal(offline.state, 'offline');
 assert.equal(offline.pending, 1);
 assert.match(readSyncCursor(files, io).lastError, /unavailable/);
 const flaky = fakeClient({ [pages.promptLog]: '# log\n' }, { failWrite: true });
 const pending = await syncPromptLog(files, io, flaky, pages, 'c', () => NOW);
 assert.equal(pending.state, 'pending');
 assert.equal(readSyncCursor(files, io).syncedThrough, 0);
 assert.equal(promptLogStatusLabel(pending), 'log pending 1');
 assert.equal(promptLogStatusLabel(undefined), 'log local');
 const up = fakeClient({ [pages.promptLog]: '# log\n' });
 const synced = await syncPromptLog(files, io, up, pages, 'c', () => NOW);
 assert.equal(synced.state, 'synced');
 assert.equal(promptLogStatusLabel(synced), 'log synced 1');
});

test('the syncer debounces observe() and retry() attempts only while something is pending', async () => {
 const io = memIo();
 const files = promptLogFiles('/state');
 let client = undefined;
 const timers = [];
 const results = [];
 const syncer = createPromptLogSyncer({
  files, io, clientId: 'c', pages: () => pages, client: () => client, nowIso: () => NOW,
  setTimer: (cb) => { const t = { cb, active: true }; timers.push(t); return t; },
  clearTimer: (t) => { t.active = false; },
  onResult: (r) => results.push(r.state),
 });
 appendPromptLog(files, io, 'c', NOW, [{ kind: 'queue-add', text: 'x' }]);
 syncer.observe();
 syncer.observe();
 assert.equal(timers.filter((t) => t.active).length, 1, 'coalesced');
 timers.find((t) => t.active).cb();
 await new Promise((r) => setTimeout(r, 0));
 assert.deepEqual(results, ['unbound']);
 client = fakeClient({});
 await syncer.retry();
 assert.deepEqual(results, ['unbound', 'synced']);
 assert.equal(syncer.current().syncedThrough, 1);
 const before = client.calls.length;
 await syncer.retry();
 assert.equal(client.calls.length, before, 'nothing pending: no network');
});

test('client identity is created once and reused; a corrupt file is replaced', () => {
 const io = memIo();
 const id = clientIdentity('/home/user', io, () => 'host-abcd');
 assert.equal(id, 'host-abcd');
 assert.equal(clientIdentity('/home/user', io, () => 'other-0000'), 'host-abcd');
 io.writeFile('/home/user/client.json', '{bad');
 assert.equal(clientIdentity('/home/user', io, () => 'fresh-1111'), 'fresh-1111');
 assert.match(newClientId('My Laptop.local', 'beef'), /^my-laptop\.local-beef$/);
});

test('workspace hydration reads the writing client and decides when to import another client\'s mirror', () => {
 const content = { project: 'promptr', gitRef: 'main', gitHead: 'abc', gitDirty: false, piStatus: 'idle', queue: [{ text: 'q' }], composer: 'c', client: 'desk-ffff', note: '# my note' };
 const page = renderWorkspaceMirror(content, NOW);
 assert.ok(page.includes('Client: desk-ffff'));
 assert.ok(page.includes('## Notebook\n\n```\n# my note\n```'));
 const parsed = parseWorkspacePage(page);
 assert.equal(parsed.client, 'desk-ffff');
 assert.equal(parsed.updated, NOW);
 assert.equal(parsed.project, 'promptr');
 assert.equal(workspaceImportDecision(parsed, 'laptop-1a2b', undefined).action, 'import');
 assert.equal(workspaceImportDecision(parsed, 'desk-ffff', undefined).action, 'none');
 assert.equal(workspaceImportDecision(parsed, 'laptop-1a2b', `desk-ffff@${NOW}`).action, 'none');
 assert.equal(workspaceImportDecision(null, 'laptop-1a2b', undefined).action, 'none');
 const seed = parseWorkspacePage('# Promptr workspace\n\nWritten by Promptr; edits here are overwritten. Nothing mirrored yet.\n');
 assert.equal(workspaceImportDecision(seed, 'laptop-1a2b', undefined).action, 'none');
});

test('renderPromptLogBatch is empty for no entries and bounds meta text to one line', () => {
 assert.equal(renderPromptLogBatch([], 'c'), '');
 const block = renderPromptLogBatch([{ seq: 4, at: NOW, client: 'c', kind: 'send-attempt', text: 't', meta: { outcome: 'line one\nline two' } }], 'c');
 assert.ok(block.includes('outcome line one line two'));
});
