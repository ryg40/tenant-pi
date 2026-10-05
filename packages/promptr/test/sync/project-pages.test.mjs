import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenKnowledgeClient, openKnowledgeOrigin, hasOpenKnowledgeCredentials } from '../../dist/src/briefing/openknowledge.mjs';
import {
 PROJECT_PAGE_KINDS, projectSlug, projectPagesFor, seedPage, bootstrapProjectPages, checkProjectPages,
 okAge, okHeaderLabel, createOpenKnowledgePoller,
} from '../../dist/src/sync/project-pages.mjs';

const ORIGIN = 'https://wiki.example';
const PASSWORD = 'fixture-password';
const env = { OPENKNOWLEDGE_USERNAME: 'fixture-user', OPENKNOWLEDGE_PASSWORD: PASSWORD };
const pages = projectPagesFor(ORIGIN, 'Promptr');
const clock = () => 1_000_000;

/** Fake PagesClient recording calls; `docs` holds existing pages. `fail` throws on the brief read. */
function fakeClient(docs = {}, { fail, race } = {}) {
 const calls = [];
 return {
  calls, docs,
  async readDocument(docName) {
   calls.push(['GET', docName]);
   if (fail && docName.endsWith('/brief')) throw fail;
   return docName in docs ? docs[docName] : null;
  },
  async createPage(docName) {
   calls.push(['POST create', docName]);
   if (race) { docs[docName] = 'raced'; return 'exists'; }
   return 'created';
  },
  async writeMarkdown(docName, markdown, position, summary) {
   calls.push(['POST write', docName, position, summary]);
   docs[docName] = markdown;
  },
 };
}

/** Bounded fixture fetch in the style of test/briefing/store.test.mjs. */
function server(status) {
 const calls = [];
 const request = async (url, init) => { calls.push({ url, ...init }); return new Response('', { status }); };
 return { calls, client: new OpenKnowledgeClient(ORIGIN, env, request) };
}

test('projectSlug rule table', () => {
 assert.equal(projectSlug('Promptr'), 'promptr');
 assert.equal(projectSlug('My Repo!!'), 'my-repo');
 assert.throws(() => projectSlug('---'), /no usable OpenKnowledge slug/);
 const long = projectSlug('a'.repeat(100));
 assert.equal(long.length, 80); assert.match(long, /^[a-z0-9][a-z0-9_-]{0,79}$/);
 assert.deepEqual(PROJECT_PAGE_KINDS, ['brief', 'inbox', 'workspace', 'handoffs', 'prompt-log']);
});

test('projectPagesFor derives the prefix from label or an existing brief docName', () => {
 assert.deepEqual(pages, { origin: ORIGIN, label: 'Promptr', prefix: 'projects/promptr', brief: 'projects/promptr/brief',
  inbox: 'projects/promptr/inbox', workspace: 'projects/promptr/workspace', handoffs: 'projects/promptr/handoffs', promptLog: 'projects/promptr/prompt-log' });
 const kept = projectPagesFor(ORIGIN, 'Renamed Dir', 'projects/old-name/brief');
 assert.equal(kept.prefix, 'projects/old-name'); assert.equal(kept.inbox, 'projects/old-name/inbox'); assert.equal(kept.label, 'Renamed Dir');
 assert.throws(() => projectPagesFor(ORIGIN, 'x', 'projects/old-name/other'));
 assert.throws(() => projectPagesFor(ORIGIN, 'x', 'Projects/Old/brief'));
 assert.throws(() => projectPagesFor('http://wiki.example', 'x'));
});

test('seeds are exact ASCII LF text', () => {
 assert.equal(seedPage('inbox', 'Promptr'), '# Promptr inbox\n\nType one thought per block: a `## ` heading or a paragraph group separated by `---`. Promptr queues each new block once and appends a small trailer under it; it never edits your text.\n');
 assert.equal(seedPage('workspace', 'Promptr'), '# Promptr workspace\n\nWritten by Promptr; edits here are overwritten. Nothing mirrored yet.\n');
 assert.equal(seedPage('handoffs', 'Promptr'), '# Promptr handoffs\n\nAppend-only history of handoffs, wrap-ups and checkpoints.\n');
 assert.equal(seedPage('inbox', 'café 🌱').split('\n')[0], '# caf? ?? inbox');
 assert.equal(seedPage('handoffs', 'x'.repeat(100)).split('\n')[0], `# ${'x'.repeat(80)} handoffs`);
});

test('openKnowledgeOrigin and credentials come only from env', () => {
 assert.equal(openKnowledgeOrigin({}), 'https://openknowledge.example.com');
 assert.equal(openKnowledgeOrigin({ OPENKNOWLEDGE_ORIGIN: ' https://wiki.example ' }), ORIGIN);
 assert.throws(() => openKnowledgeOrigin({ OPENKNOWLEDGE_ORIGIN: 'http://wiki.example' }));
 assert.throws(() => openKnowledgeOrigin({ OPENKNOWLEDGE_ORIGIN: 'https://wiki.example/path' }));
 assert.equal(hasOpenKnowledgeCredentials({}), false); assert.equal(hasOpenKnowledgeCredentials(env), true);
 assert.equal(OpenKnowledgeClient.fromEnv(ORIGIN, {}), undefined);
 assert.throws(() => new OpenKnowledgeClient(ORIGIN, {}));
 assert.equal(OpenKnowledgeClient.fromEnv(ORIGIN, env).origin, ORIGIN);
});

test('missing credentials → poller reports unbound "credentials not exported"', async () => {
 const statuses = [];
 const poller = createOpenKnowledgePoller({ pages: () => pages, client: () => OpenKnowledgeClient.fromEnv(ORIGIN, {}),
  check: checkProjectPages, now: clock, onStatus: s => statuses.push(s) });
 assert.deepEqual(poller.current(), { state: 'unbound', reason: 'not connected' });
 await poller.refresh();
 assert.deepEqual(statuses, [{ state: 'unbound', reason: 'credentials not exported' }]);
});

test('OpenKnowledgeClient maps HTTP statuses and sends pinned request rules', async () => {
 const unauthorized = server(401);
 await assert.rejects(unauthorized.client.readDocument(pages.brief), /read HTTP 401/);
 assert.ok(unauthorized.calls.every(c => c.redirect === 'error' && c.headers.Authorization.startsWith('Basic ') && c.method === 'GET'));
 assert.equal(await server(404).client.readDocument(pages.brief), null);
 assert.equal(await server(409).client.createPage(pages.inbox), 'exists');
 assert.equal(await server(200).client.createPage(pages.inbox), 'created');
 await assert.rejects(server(500).client.createPage(pages.inbox), /create HTTP 500/);
 await assert.rejects(server(500).client.writeMarkdown(pages.inbox, 'x', 'replace', 's'), /write HTTP 500/);
 const ok = server(200); await ok.client.writeMarkdown(pages.inbox, 'md', 'append', 'sum');
 assert.deepEqual(JSON.parse(ok.calls[0].body), { docName: pages.inbox, markdown: 'md', position: 'append', summary: 'sum', clientName: 'promptr' });
 const net = new OpenKnowledgeClient(ORIGIN, env, async () => { throw Error('private network detail'); });
 await assert.rejects(net.readDocument(pages.brief), /OpenKnowledge unavailable/);
 const wrong = new OpenKnowledgeClient(ORIGIN, env, async () => Response.json({ docName: 'other', content: 'x' }));
 await assert.rejects(wrong.readDocument(pages.brief), /different document/);
});

test('bootstrap: 401 on brief → offline with reason containing 401, no POST', async () => {
 const client = fakeClient({}, { fail: Error('OpenKnowledge read HTTP 401') });
 const status = await bootstrapProjectPages(client, pages, clock);
 assert.equal(status.state, 'offline'); assert.match(status.reason, /401/); assert.equal(status.at, clock());
 assert.deepEqual(client.calls, [['GET', pages.brief]]);
});

test('bootstrap: all three missing → GET, create, write, GET per kind in order; brief untouched', async () => {
 const client = fakeClient({});
 const status = await bootstrapProjectPages(client, pages, clock);
 assert.deepEqual(status, { state: 'ok', at: clock(), created: ['inbox', 'workspace', 'handoffs', 'prompt-log'] });
 const expected = [['GET', pages.brief]];
 for (const kind of ['inbox', 'workspace', 'handoffs', 'prompt-log']) {
  const name = kind === 'prompt-log' ? pages.promptLog : pages[kind];
  expected.push(['GET', name], ['POST create', name], ['POST write', name, 'replace', `Promptr bootstrap: ${kind} page`], ['GET', name]);
 }
 assert.deepEqual(client.calls, expected);
 assert.equal(client.docs[pages.inbox], seedPage('inbox', 'Promptr'));
 assert.equal(pages.brief in client.docs, false);
});

test('bootstrap: all existing → GETs only; "exists" race → read again, no write', async () => {
 const existing = fakeClient({ [pages.brief]: 'b', [pages.inbox]: 'i', [pages.workspace]: 'w', [pages.handoffs]: 'h', [pages.promptLog]: 'p' });
 assert.deepEqual(await bootstrapProjectPages(existing, pages, clock), { state: 'ok', at: clock(), created: [] });
 assert.ok(existing.calls.every(c => c[0] === 'GET')); assert.equal(existing.calls.length, 5);
 const raced = fakeClient({ [pages.inbox]: 'i', [pages.workspace]: 'w' }, { race: true });
 assert.deepEqual(await bootstrapProjectPages(raced, pages, clock), { state: 'ok', at: clock(), created: [] });
 assert.deepEqual(raced.calls.slice(-3), [['GET', pages.promptLog], ['POST create', pages.promptLog], ['GET', pages.promptLog]]);
 const readback = fakeClient({});
 readback.writeMarkdown = async () => {};
 const status = await bootstrapProjectPages(readback, pages, clock);
 assert.deepEqual(status, { state: 'offline', reason: 'inbox create/read-back failed', at: clock() });
});

test('checkProjectPages does exactly one inbox GET', async () => {
 const client = fakeClient({});
 assert.deepEqual(await checkProjectPages(client, pages, clock), { state: 'ok', at: clock(), created: [] });
 assert.deepEqual(client.calls, [['GET', pages.inbox]]);
 const down = { ...client, readDocument: async () => { throw Error('OpenKnowledge unavailable (network, timeout or redirect); local copy retained. extra text past eighty characters'); } };
 const status = await checkProjectPages(down, pages, clock);
 assert.equal(status.state, 'offline'); assert.equal(status.reason.length, 80);
});

test('okAge and okHeaderLabel table', () => {
 const now = 10_000_000_000;
 for (const [ago, label] of [[0, '0s'], [59_000, '59s'], [60_000, '1m'], [59 * 60_000, '59m'], [3_600_000, '1h'], [23 * 3_600_000, '23h'], [24 * 3_600_000, '1d'], [3 * 86_400_000, '3d']]) {
  assert.equal(okAge(now - ago, now), label);
 }
 assert.equal(okAge(now + 5000, now), '0s');
 assert.equal(okHeaderLabel({ state: 'unbound', reason: 'x' }, now), 'OK unbound');
 assert.equal(okHeaderLabel({ state: 'offline', reason: 'x', at: now }, now), 'OK offline');
 assert.equal(okHeaderLabel({ state: 'ok', at: now - 120_000, created: [] }, now), 'OK 2m');
});

test('poller coalesces concurrent refreshes and emits only on change', async () => {
 let checks = 0; let result = { state: 'ok', at: 1, created: [] }; let resolveCheck;
 const statuses = [];
 const poller = createOpenKnowledgePoller({ pages: () => pages, client: () => fakeClient({}), now: clock, onStatus: s => statuses.push(s),
  check: () => { checks++; return new Promise(r => { resolveCheck = () => r(result); }); } });
 const a = poller.refresh(); const b = poller.refresh();
 assert.equal(a, b); resolveCheck(); await a;
 assert.equal(checks, 1); assert.equal(statuses.length, 1);
 result = { state: 'ok', at: 2, created: [] }; const c = poller.refresh(); resolveCheck(); await c;
 assert.equal(statuses.length, 1, 'same state, newer at: no emission'); assert.equal(poller.current().at, 2);
 result = { state: 'offline', reason: 'down', at: 3 }; const d = poller.refresh(); resolveCheck(); await d;
 assert.equal(statuses.length, 2); assert.equal(statuses[1].state, 'offline');
 const bare = createOpenKnowledgePoller({ pages: () => undefined, client: () => undefined, check: checkProjectPages, now: clock, onStatus: s => statuses.push(s) });
 await bare.refresh(); assert.deepEqual(statuses.at(-1), { state: 'unbound', reason: 'not connected' });
});

test('no secrets: reasons, labels and notices never contain the fixture password', async () => {
 const leaky = new OpenKnowledgeClient(ORIGIN, env, async () => { throw Error(`auth ${PASSWORD}`); });
 const status = await bootstrapProjectPages(leaky, pages, clock);
 const unauthorized = await checkProjectPages(server(401).client, pages, clock);
 for (const text of [status.reason, unauthorized.reason, okHeaderLabel(status, clock()), okHeaderLabel(unauthorized, clock()), JSON.stringify(pages)]) {
  assert.ok(!text.includes(PASSWORD)); assert.ok(!text.includes('fixture-user'));
 }
});
