import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { BatchUpdateMemoryRecordsCommand, ListMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { inspectSource } from '../check-readonly.mjs';
import { create } from '../lib/adapters/agentcore.mjs';
import { targetOf } from '../lib/adapters/agentcore-review.mjs';
import { Hub } from '../lib/hub.mjs';
import { createHandler } from '../lib/web.mjs';
import { reviewRequest } from '../ui/selection.js';

const P = '/proposals/alice/preferences/';
const S = '/shared/alice/preferences/';
const R = '/rejected/alice/preferences/';
const cfg = {
  id: 'lean', type: 'agentcore', mode: 'live', memoryId: 'ExampleMemory', region: 'us-east-1',
  profile: 'example-reader', namespaces: [P, S, R, '/proposals/alice/events/'], review: { profile: 'example-reviewer' },
};
const when = new Date('2026-01-02T03:04:05Z');

function stubs({ deny = false, fail = false } = {}) {
  const reads = [];
  const writes = [];
  const profiles = {};
  const records = { [P]: [{ memoryRecordId: 'mem-1', content: { text: 'A synthetic preference.' }, timestamp: when, namespaces: [P] }] };
  return {
    reads, writes, profiles, records,
    clientFactory: (_cfg, options) => {
      profiles.read = options.profile;
      return { send: async (command) => {
        assert.ok(command instanceof ListMemoryRecordsCommand);
        reads.push(command.input.namespace);
        return { memoryRecordSummaries: records[command.input.namespace] ?? [] };
      } };
    },
    reviewClientFactory: (_cfg, options) => {
      profiles.review = options.profile;
      return { send: async (command) => {
        assert.ok(command instanceof BatchUpdateMemoryRecordsCommand);
        writes.push(command.input);
        if (deny) throw Object.assign(new Error('private reply text'), { name: 'AccessDeniedException' });
        if (fail) return { successfulRecords: [], failedRecords: [{ memoryRecordId: 'mem-1', errorCode: 'private' }] };
        return { successfulRecords: [{ memoryRecordId: command.input.records[0].memoryRecordId }], failedRecords: [] };
      } };
    },
  };
}

test('a decision has one target, and only for a proposal namespace', () => {
  assert.equal(targetOf(P, 'approve'), S);
  assert.equal(targetOf(P, 'reject'), R);
  for (const [ns, decision] of [[S, 'approve'], [R, 'reject'], ['/proposals/alice/', 'approve'], ['/proposals/alice/other/', 'approve'],
    ['/proposals/Alice/events/', 'reject'], ['/project/x/proposals/alice/', 'approve'], [P, 'delete'], [P, 'constructor'], [null, 'approve']]) {
    assert.equal(targetOf(ns, decision), null, `${ns} ${decision}`);
  }
});

test('a source without the review setting has no review method and no actions', async () => {
  const s = stubs();
  const { review, ...plain } = cfg;
  const adapter = create(plain, s);
  assert.equal(adapter.review, undefined);
  await adapter.browse({ path: P });
  assert.equal((await adapter.get(`${P}#mem-1`)).actions, undefined);
  assert.equal(s.profiles.review, undefined);
});

test('the review setting needs its own profile and no other field', () => {
  for (const review of [{}, { profile: '' }, { profile: 'example-reader' }, { profile: 'a b' }, { profile: 'x', role: 'y' }, 'x', null, []]) {
    assert.throws(() => create({ ...cfg, review }, stubs()), (error) => error.code === 'config', JSON.stringify(review));
  }
});

test('approve moves a loaded proposal with the reviewer profile and keeps its event time', async () => {
  const s = stubs();
  const adapter = create(cfg, s);
  await adapter.browse({ path: P });
  assert.deepEqual((await adapter.get(`${P}#mem-1`)).actions, ['approve', 'reject']);
  assert.deepEqual(await adapter.review(`${P}#mem-1`, 'approve'), { decision: 'approve', from: P, to: S });
  assert.deepEqual(s.writes, [{ memoryId: 'ExampleMemory', records: [{ memoryRecordId: 'mem-1', timestamp: when, namespaces: [S], sourceNamespaces: [P] }] }]);
  assert.deepEqual(s.profiles, { read: 'example-reader', review: 'example-reviewer' });
  assert.equal(await adapter.get(`${P}#mem-1`), null);
});

test('after a move the other loaded proposals stay, and a late AWS list does not bring the moved record back', async () => {
  let time = 1_000_000;
  const s = stubs();
  s.records[P].push({ memoryRecordId: 'mem-2', content: { text: 'A second synthetic preference.' }, timestamp: when, namespaces: [P] });
  const adapter = create(cfg, { ...s, now: () => time });
  await adapter.browse({ path: P });
  await adapter.browse({ path: S });
  await adapter.review(`${P}#mem-1`, 'approve');
  // The second proposal needs no new read.
  assert.deepEqual((await adapter.get(`${P}#mem-2`)).actions, ['approve', 'reject']);
  // AWS still lists the moved record at its old place and not yet at the new place.
  assert.deepEqual((await adapter.browse({ path: P })).items.map((i) => i.id), [`${P}#mem-2`]);
  assert.equal((await adapter.browse({ path: S })).total, 0);
  // Inside the settle time each browse reads AWS again.
  s.records[S] = [{ memoryRecordId: 'mem-1', content: { text: 'A synthetic preference.' }, timestamp: when, namespaces: [S] }];
  s.records[P] = [s.records[P][1]];
  assert.equal((await adapter.browse({ path: S })).total, 1);
  const reads = s.reads.length;
  time += 121_000;
  await adapter.browse({ path: S });
  await adapter.browse({ path: S });
  await adapter.browse({ path: P });
  await adapter.browse({ path: P });
  // After the settle time the first browse of each namespace reads once more, then the cache serves.
  assert.equal(s.reads.length, reads + 2);
  assert.equal((await adapter.review(`${P}#mem-2`, 'reject')).to, R);
  assert.equal(s.writes.length, 2);
});

test('reject moves to the rejected tree', async () => {
  const s = stubs();
  const adapter = create(cfg, s);
  await adapter.browse({ path: P });
  assert.equal((await adapter.review(`${P}#mem-1`, 'reject')).to, R);
  assert.deepEqual(s.writes[0].records[0].namespaces, [R]);
});

test('no AWS write for an unknown record, a record that is not loaded, a bad decision or a missing target', async () => {
  const s = stubs();
  s.records[S] = [{ memoryRecordId: 'mem-2', content: { text: 'A shared record.' } }];
  s.records['/proposals/alice/events/'] = [{ memoryRecordId: 'mem-3', content: { text: 'An event.' } }];
  const adapter = create(cfg, s);
  await assert.rejects(adapter.review(`${P}#mem-1`, 'approve'), (error) => error.code === 'not_found');
  await adapter.browse({ path: P });
  await adapter.browse({ path: S });
  await adapter.browse({ path: '/proposals/alice/events/' });
  await assert.rejects(adapter.review(`${P}#mem-9`, 'approve'), (error) => error.code === 'not_found');
  await assert.rejects(adapter.review('/other/alice/preferences/#mem-1', 'approve'), (error) => error.code === 'not_found');
  await assert.rejects(adapter.review(`${P}#mem-1`, 'delete'), (error) => error.code === 'review_off');
  await assert.rejects(adapter.review(`${S}#mem-2`, 'reject'), (error) => error.code === 'review_off');
  // The targets of the events namespace are not in the configuration.
  assert.equal((await adapter.get('/proposals/alice/events/#mem-3')).actions, undefined);
  await assert.rejects(adapter.review('/proposals/alice/events/#mem-3', 'approve'), (error) => error.code === 'review_off');
  assert.deepEqual(s.writes, []);
});

test('a denied or failed move gives a fixed error and keeps the record readable', async () => {
  for (const [options, code] of [[{ deny: true }, 'review_denied'], [{ fail: true }, 'review_failed']]) {
    const s = stubs(options);
    const adapter = create(cfg, s);
    await adapter.browse({ path: P });
    await assert.rejects(adapter.review(`${P}#mem-1`, 'approve'), (error) => error.code === code && !/private/.test(error.message));
    assert.ok(await adapter.get(`${P}#mem-1`));
  }
});

test('the read-only check allows the update command in the review file only', () => {
  const line = "import { BatchUpdateMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore'; new BatchUpdateMemoryRecordsCommand({});";
  assert.deepEqual(inspectSource('lib/adapters/agentcore-review.mjs', line), []);
  for (const file of ['lib/adapters/agentcore.mjs', 'lib/hub.mjs', 'ui/app.js', 'lib/adapters/x/agentcore-review.mjs', 'agentcore-review.mjs']) {
    assert.ok(inspectSource(file, line).some((f) => f.rule === 'aws-write'), file);
  }
  for (const other of ['BatchDeleteMemoryRecordsCommand', 'BatchCreateMemoryRecordsCommand', 'DeleteMemoryRecordCommand']) {
    assert.ok(inspectSource('lib/adapters/agentcore-review.mjs', `new ${other}({});`).some((f) => f.rule === 'aws-write'), other);
  }
});

test('the page builds the review request, and nothing for another decision', () => {
  const made = reviewRequest('lean', `${P}#mem-1`, 'approve');
  assert.equal(made.path, 'api/sources/lean/review');
  assert.equal(made.init.method, 'POST');
  assert.equal(made.init.headers['X-Tenant-Memory-Action'], 'review');
  assert.deepEqual(JSON.parse(made.init.body), { id: `${P}#mem-1`, decision: 'approve' });
  assert.equal(reviewRequest('lean', `${P}#mem-1`, 'delete'), null);
  assert.equal(reviewRequest('', `${P}#mem-1`, 'approve'), null);
});

async function site(t, s = stubs()) {
  const logs = [];
  const hub = new Hub({ sources: [cfg, { id: 'plain', type: 'agentcore', mode: 'live', memoryId: 'ExampleMemory', region: 'us-east-1', profile: 'example-reader', namespaces: [P] }] }, {
    log: (line) => logs.push(line),
    factories: { agentcore: { create: (c) => create(c, s) } },
  });
  const server = createServer(createHandler({ hub, auth: null, log: (line) => logs.push(line) }));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  const good = { 'Content-Type': 'application/json', 'X-Tenant-Memory-Action': 'review', Origin: `http://${host}` };
  const call = (target, { method = 'POST', headers = good, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  return { call, good, host, logs, s, hub };
}

test('the source list names the review source', async (t) => {
  const { hub } = await site(t);
  assert.deepEqual(hub.sources().map((x) => [x.id, x.review]), [['lean', true], ['plain', false]]);
});

test('the review route moves a loaded proposal and logs no content', async (t) => {
  const { call, logs, s } = await site(t);
  assert.equal((await call(`/api/sources/lean/browse?path=${encodeURIComponent(P)}`, { method: 'GET', headers: {} })).status, 200);
  const reply = await call('/api/sources/lean/review', { body: { id: `${P}#mem-1`, decision: 'approve' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.to, S);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(s.writes.length, 1);
  assert.ok(logs.some((line) => /^POST review 200 \d+ms$/.test(line)));
  assert.ok(!logs.some((line) => line.includes('mem-1') || line.includes('alice')));
});

test('the review route refuses each request that another site can send', async (t) => {
  const { call, good, host, s } = await site(t);
  await call(`/api/sources/lean/browse?path=${encodeURIComponent(P)}`, { method: 'GET', headers: {} });
  const body = { id: `${P}#mem-1`, decision: 'approve' };
  const without = (name) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
  for (const headers of [without('Origin'), without('X-Tenant-Memory-Action'), without('Content-Type'),
    { ...good, Origin: 'https://other.example' }, { ...good, Origin: `http://${host}/x` }, { ...good, Origin: 'null' },
    { ...good, 'Content-Type': 'text/plain' }, { ...good, 'Content-Type': 'application/x-www-form-urlencoded' },
    { ...good, 'Sec-Fetch-Site': 'cross-site' }, { ...good, 'Sec-Fetch-Site': 'same-site' }]) {
    const reply = await call('/api/sources/lean/review', { headers, body });
    assert.equal(reply.status, 403, JSON.stringify(headers));
    assert.equal(reply.json.error.code, 'review_off');
  }
  assert.equal((await call('/api/sources/lean/review', { headers: { ...good, 'Sec-Fetch-Site': 'same-origin' }, body: { ...body, decision: 'x' } })).status, 400);
  assert.deepEqual(s.writes, []);
});

test('the review route checks the method, the body, the source and the record', async (t) => {
  const { call, s } = await site(t);
  await call(`/api/sources/lean/browse?path=${encodeURIComponent(P)}`, { method: 'GET', headers: {} });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const reply = await call('/api/sources/lean/review', { method, headers: {} });
    assert.equal(reply.status, 405, method);
    assert.equal(reply.headers.allow, 'POST');
  }
  for (const body of ['{', '[]', {}, { id: `${P}#mem-1` }, { id: `${P}#mem-1`, decision: 'approve', to: S }, { id: 5, decision: 'approve' },
    { id: '', decision: 'reject' }, { id: 'x'.repeat(5000), decision: 'approve' }]) {
    assert.equal((await call('/api/sources/lean/review', { body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await call('/api/sources/none/review', { body: { id: `${P}#mem-1`, decision: 'approve' } })).status, 404);
  const plain = await call('/api/sources/plain/review', { body: { id: `${P}#mem-1`, decision: 'approve' } });
  assert.equal(plain.status, 403);
  assert.equal(plain.json.error.code, 'review_off');
  assert.equal((await call('/api/sources/lean/review', { body: { id: `${P}#mem-9`, decision: 'approve' } })).status, 404);
  assert.deepEqual(s.writes, []);
});

test('preload reads each namespace at the source root and shows each count; one denied namespace does not fail the root', async () => {
  const s = stubs();
  const reads = [];
  const adapter = create({ ...cfg, preload: true }, { ...s, clientFactory: () => ({ send: async (command) => {
    reads.push(command.input.namespace);
    if (command.input.namespace === R) throw Object.assign(new Error('private'), { name: 'AccessDeniedException' });
    return { memoryRecordSummaries: s.records[command.input.namespace] ?? [] };
  } }) });
  const root = await adapter.browse({ path: '' });
  assert.deepEqual(root.folders.map((f) => [f.path, f.count, f.state]),
    [[P, 1, 'loaded'], ['/proposals/alice/events/', 0, 'empty'], [S, 0, 'empty'], [R, undefined, 'denied']]);
  assert.equal(reads.length, 4);
  // A second root read inside the cache time reads only the failed namespace again.
  await adapter.browse({ path: '' });
  assert.deepEqual(reads.slice(4), [R]);
  const plain = create(cfg, stubs());
  assert.ok((await plain.browse({ path: '' })).folders.every((f) => f.state === 'unloaded'));
  assert.throws(() => create({ ...cfg, preload: 'yes' }, stubs()), (error) => error.code === 'config');
});

test('a review source puts its namespaces into three sections, waiting first; a configured group wins', async () => {
  const mixed = { ...cfg, namespaces: [S, { namespace: R, label: 'old' }, { namespace: '/other/x/', group: 'Notes' }, P, '/plain/', { namespace: '/proposals/alice/events/', group: 'Notes' }] };
  const root = await create(mixed, stubs()).browse({ path: '' });
  assert.deepEqual(root.folders.map((f) => [f.path, f.group]), [
    [P, 'Waiting for approval'], [S, 'Approved'], [R, 'Rejected'], ['/other/x/', 'Notes'], ['/proposals/alice/events/', 'Notes'], ['/plain/', undefined]]);
  const { review, ...plain } = mixed;
  const flat = await create(plain, stubs()).browse({ path: '' });
  assert.deepEqual(flat.folders.map((f) => [f.path, f.group]), [
    ['/other/x/', 'Notes'], ['/proposals/alice/events/', 'Notes'], [S, undefined], [R, undefined], [P, undefined], ['/plain/', undefined]]);
  assert.throws(() => create({ ...cfg, namespaces: [{ namespace: P, group: '' }] }, stubs()));
});
