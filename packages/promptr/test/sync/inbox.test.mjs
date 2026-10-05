import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectPagesFor, seedPage } from '../../dist/src/sync/project-pages.mjs';
import {
 parseInboxBlocks, inboxTrailer, toThoughtText, readSeen, serializeSeen, pollInbox, createInboxPoller,
} from '../../dist/src/sync/inbox.mjs';

const pages = projectPagesFor('https://wiki.example', 'Promptr');
const SEED = seedPage('inbox', 'Promptr');
const h = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const NOW = 1_700_000_000_000;
const ISO = new Date(NOW).toISOString();

/** Fake PagesClient recording calls; `fail` throws on the inbox read, `failWrite` on every append. */
function fakeClient(inbox, { fail, failWrite } = {}) {
 const calls = [];
 const docs = { [pages.inbox]: inbox };
 return {
  calls, docs,
  async readDocument(docName) {
   calls.push(['GET', docName]);
   if (fail) throw fail;
   return docName in docs ? docs[docName] : null;
  },
  async createPage() { throw new Error('unexpected create'); },
  async writeMarkdown(docName, markdown, position, summary) {
   calls.push(['POST write', docName, position, summary, markdown]);
   if (failWrite) throw failWrite;
   docs[docName] = (docs[docName] ?? '') + markdown;
  },
 };
}

/** Deps harness: `seen` is the persisted set, `writes` every writeSeen snapshot, `enqueued` every accepted call. */
function harness(client, { seen = new Set(), accept = () => true, pagesValue = pages, unbound = false } = {}) {
 const writes = [];
 const enqueued = [];
 const order = [];
 return {
  writes, enqueued, order,
  deps: {
   pages: () => (unbound ? undefined : pagesValue),
   client: () => client,
   readSeen: () => new Set(seen),
   writeSeen: (hashes) => { seen = new Set(hashes); writes.push([...hashes]); order.push('seen'); },
   enqueue: (text, hash) => { const ok = accept(text, hash); if (ok) enqueued.push([text, hash]); return ok; },
   now: () => NOW,
  },
  seen: () => seen,
 };
}

const TWO = `${SEED}\n## First thought\n\nBody one.\n\n## Second\nBody two.\n`;

test('parseInboxBlocks: seed-only page yields no blocks', () => {
 const parsed = parseInboxBlocks(SEED);
 assert.deepEqual(parsed.blocks, []);
 assert.equal(parsed.consumed.size, 0);
 assert.equal(parsed.malformed, undefined);
});

test('parseInboxBlocks: two ## blocks with expected texts and hashes', () => {
 const { blocks } = parseInboxBlocks(TWO);
 assert.deepEqual(blocks.map((b) => b.text), ['First thought\n\nBody one.', 'Second\nBody two.']);
 assert.deepEqual(blocks.map((b) => b.index), [0, 1]);
 assert.deepEqual(blocks.map((b) => b.hash), [h('First thought\n\nBody one.'), h('Second\nBody two.')]);
 assert.match(blocks[0].hash, /^[0-9a-f]{16}$/);
});

test('parseInboxBlocks: --- paragraph groups, empty groups skipped, blank runs collapsed', () => {
 const page = `${SEED}\n---\n\nAlpha line.\n\n\n\n\nStill alpha.\n\n---\n---\nBeta.\n`;
 const { blocks } = parseInboxBlocks(page);
 assert.deepEqual(blocks.map((b) => b.text), ['Alpha line.\n\nStill alpha.', 'Beta.']);
});

test('parseInboxBlocks: mixed headings and separators', () => {
 const page = `${SEED}\n## Head\nh body\n---\npara group\n## Tail\n`;
 const { blocks } = parseInboxBlocks(page);
 assert.deepEqual(blocks.map((b) => b.text), ['Head\nh body', 'para group', 'Tail']);
});

test('parseInboxBlocks: trailer lines are dropped and collected into consumed', () => {
 const page = `${TWO}\n\n${inboxTrailer(h('First thought\n\nBody one.'), ISO)}\n`;
 const parsed = parseInboxBlocks(page);
 assert.deepEqual([...parsed.consumed], [h('First thought\n\nBody one.')]);
 assert.deepEqual(parsed.blocks.map((b) => b.text), ['First thought\n\nBody one.', 'Second\nBody two.']);
 assert.equal(inboxTrailer('0123456789abcdef', ISO), `<!-- promptr:queued 0123456789abcdef ${ISO} -->`);
});

test('parseInboxBlocks: an edited block hashes differently', () => {
 const before = parseInboxBlocks(TWO).blocks[1].hash;
 const after = parseInboxBlocks(TWO.replace('Body two.', 'Body two, edited.')).blocks[1].hash;
 assert.notEqual(before, after);
});

test('parseInboxBlocks: CRLF input normalizes to the LF hashes', () => {
 const crlf = parseInboxBlocks(TWO.replace(/\n/g, '\r\n'));
 assert.deepEqual(crlf.blocks.map((b) => b.hash), parseInboxBlocks(TWO).blocks.map((b) => b.hash));
});

test('parseInboxBlocks: control characters mark the page malformed', () => {
 const parsed = parseInboxBlocks(`${TWO}\x1b[31m`);
 assert.deepEqual(parsed.blocks, []);
 assert.match(parsed.malformed, /^inbox page rejected: /);
});

test('toThoughtText: ASCII, LF and tab rules plus truncation marker', () => {
 const block = { index: 0, hash: 'x', text: 'café\tok\x07\r\nnext' };
 assert.equal(toThoughtText(block), 'caf?  ok\nnext');
 const long = { index: 0, hash: 'y', text: 'a'.repeat(300 * 1024) };
 const out = toThoughtText(long);
 assert.ok(out.endsWith('\n[truncated]'));
 assert.ok(out.length <= 256 * 1024 + '\n[truncated]'.length);
 assert.match(out, /^[\x20-\x7e\n]*$/);
});

test('readSeen / serializeSeen round trip and tolerance', () => {
 assert.equal(readSeen(undefined).size, 0);
 assert.equal(readSeen('garbage{').size, 0);
 assert.equal(readSeen('{"version":1,"hashes":"nope"}').size, 0);
 const text = serializeSeen(new Set(['aa', 'bb']));
 assert.equal(text, '{"version":1,"hashes":["aa","bb"]}\n');
 assert.deepEqual([...readSeen(text)], ['aa', 'bb']);
 const many = new Set(Array.from({ length: 2500 }, (_, i) => `h${i}`));
 const kept = readSeen(serializeSeen(many));
 assert.equal(kept.size, 2000);
 assert.ok(kept.has('h2499') && !kept.has('h0'));
});

test('pollInbox: two blocks → two enqueues, seen written before each trailer append', async () => {
 const client = fakeClient(TWO);
 const hs = harness(client);
 const origWrite = client.writeMarkdown.bind(client);
 client.writeMarkdown = async (...args) => { hs.order.push('trailer'); return origWrite(...args); };
 const result = await pollInbox(hs.deps);
 assert.deepEqual(result, { state: 'ok', queued: 2, skipped: 0, trailerFailures: 0 });
 const [h1, h2] = [h('First thought\n\nBody one.'), h('Second\nBody two.')];
 assert.deepEqual(hs.enqueued, [['First thought\n\nBody one.', h1], ['Second\nBody two.', h2]]);
 assert.deepEqual(hs.writes, [[h1], [h1, h2]]);
 assert.deepEqual(hs.order, ['seen', 'trailer', 'seen', 'trailer']);
 const appends = client.calls.filter((c) => c[0] === 'POST write');
 assert.equal(appends.length, 2);
 for (const [i, hash] of [h1, h2].entries()) {
  assert.equal(appends[i][1], pages.inbox);
  assert.equal(appends[i][2], 'append');
  assert.equal(appends[i][3], `Promptr queued ${hash}`);
  assert.equal(appends[i][4], `\n\n${inboxTrailer(hash, ISO)}\n`);
 }
 assert.ok(client.docs[pages.inbox].startsWith(TWO), 'user text preserved');
});

test('pollInbox: second poll with the same page and persisted seen enqueues nothing', async () => {
 const client = fakeClient(TWO);
 const hs = harness(client);
 await pollInbox(hs.deps);
 const again = await pollInbox(hs.deps);
 assert.deepEqual(again, { state: 'ok', queued: 0, skipped: 0, trailerFailures: 0 });
 assert.equal(hs.enqueued.length, 2);
 assert.equal(client.calls.filter((c) => c[0] === 'POST write').length, 2);
});

test('pollInbox: restart with lost seen file relies on trailers already on the page', async () => {
 const client = fakeClient(TWO);
 await pollInbox(harness(client).deps);
 const fresh = harness(client);
 const result = await pollInbox(fresh.deps);
 assert.deepEqual(result, { state: 'ok', queued: 0, skipped: 0, trailerFailures: 0 });
 assert.equal(fresh.enqueued.length, 0);
 assert.equal(fresh.writes.length, 0);
});

test('pollInbox: an edited block is queued once more', async () => {
 const client = fakeClient(TWO);
 const hs = harness(client);
 await pollInbox(hs.deps);
 client.docs[pages.inbox] = client.docs[pages.inbox].replace('Body two.', 'Body two, edited.');
 const result = await pollInbox(hs.deps);
 assert.equal(result.queued, 1);
 assert.equal(hs.enqueued[2][0], 'Second\nBody two, edited.');
});

test('pollInbox: malformed page → notice, nothing enqueued, no write', async () => {
 const client = fakeClient(`${TWO}\x00`);
 const hs = harness(client);
 const result = await pollInbox(hs.deps);
 assert.equal(result.state, 'ok');
 assert.equal(result.queued, 0);
 assert.match(result.notice, /^inbox page rejected: /);
 assert.equal(hs.enqueued.length, 0);
 assert.equal(hs.writes.length, 0);
 assert.equal(client.calls.filter((c) => c[0] === 'POST write').length, 0);
});

test('pollInbox: 401/timeout → offline, no enqueue, no seen write', async () => {
 for (const fail of [new Error('OpenKnowledge 401 Unauthorized'), new Error('timeout')]) {
  const client = fakeClient(TWO, { fail });
  const hs = harness(client);
  const result = await pollInbox(hs.deps);
  assert.deepEqual(result, { state: 'offline', reason: fail.message });
  assert.equal(hs.enqueued.length, 0);
  assert.equal(hs.writes.length, 0);
 }
});

test('pollInbox: unbound when no pages or no client; null page is ok with zeros', async () => {
 assert.deepEqual(await pollInbox(harness(fakeClient(TWO), { unbound: true }).deps), { state: 'unbound', reason: 'not connected' });
 const hs = harness(fakeClient(TWO));
 hs.deps.client = () => undefined;
 assert.deepEqual(await pollInbox(hs.deps), { state: 'unbound', reason: 'credentials not exported' });
 const client = fakeClient(TWO);
 delete client.docs[pages.inbox];
 assert.deepEqual(await pollInbox(harness(client).deps), { state: 'ok', queued: 0, skipped: 0, trailerFailures: 0 });
});

test('pollInbox: enqueue returning false skips the block without marking it seen', async () => {
 const client = fakeClient(TWO);
 const hs = harness(client, { accept: (text) => !text.startsWith('First') });
 const result = await pollInbox(hs.deps);
 assert.deepEqual(result, { state: 'ok', queued: 1, skipped: 1, trailerFailures: 0 });
 assert.deepEqual([...hs.seen()], [h('Second\nBody two.')]);
 assert.equal(client.calls.filter((c) => c[0] === 'POST write').length, 1);
});

test('pollInbox: trailer write failure is counted and seen is still written', async () => {
 const client = fakeClient(TWO, { failWrite: new Error('500') });
 const hs = harness(client);
 const result = await pollInbox(hs.deps);
 assert.deepEqual(result, { state: 'ok', queued: 2, skipped: 0, trailerFailures: 2 });
 assert.equal(hs.seen().size, 2);
 assert.equal(hs.writes.length, 2);
});

test('createInboxPoller: coalesces concurrent refreshes and reports every result', async () => {
 const client = fakeClient(TWO);
 const hs = harness(client);
 const results = [];
 const poller = createInboxPoller({ ...hs.deps, onResult: (r) => results.push(r) });
 assert.equal(poller.current(), undefined);
 const a = poller.refresh();
 const b = poller.refresh();
 assert.equal(a, b);
 await a;
 assert.equal(client.calls.filter((c) => c[0] === 'GET').length, 1);
 await poller.refresh();
 assert.equal(results.length, 2);
 assert.equal(results[0].queued, 2);
 assert.equal(results[1].queued, 0);
 assert.deepEqual(poller.current(), results[1]);
});
