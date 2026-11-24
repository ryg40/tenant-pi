import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';
import { create } from '../lib/adapters/agentcore.mjs';
import { parseStageYaml, resolveNamespaces, validateStage } from '../lib/agentcore-scope.mjs';
import { Hub } from '../lib/hub.mjs';

const fixture = JSON.parse(readFileSync(new URL('../sample/agentcore.json', import.meta.url), 'utf8'));
const shared = '/shared/';
const own = '/actor/alice/';
const cfg = {
  id: 'agentcore', type: 'agentcore', mode: 'live', memoryId: 'ExampleMemory',
  region: 'us-east-1', profile: 'example-person-alice', namespaces: [shared, own],
};
const stageYaml = `schemaVersion: 1
stage: dev
region: us-east-1
memory:
  eventExpiryDays: 30
  events: [alice]
  strategies:
    - type: semantic
      name: Facts
      namespace: /strategy/{actorId}/facts/
    - type: userPreference
      name: Preferences
      namespace: /strategy/{actorId}/preferences/
    - type: summary
      name: Sessions
      namespace: /strategy/{actorId}/sessions/{sessionId}/
bucket:
  enabled: true
service:
  submit: false
  workerRead: false
people:
  - actorId: alice
    pin: XYZ1001
    status: active
    iamUser: false
  - actorId: bob
    pin: XYZ1002
    status: active
  - actorId: carol
    pin: XYZ1003
    status: offboarded
projects:
  - projectId: example-project
    maintainers: [alice]
    members: [alice, bob]
    deleters: []
  - projectId: second-project
    maintainers: [bob]
    members: [alice, bob]
  - projectId: unrelated-project
    maintainers: [bob]
    members: [bob]
hostRoles:
  - roleSuffix: macos-role
    actorId: example-agent
    proposalProject: example-project
`;
const stageCfg = {
  actorId: 'alice', region: cfg.region, scope: { kind: 'stage-file', path: 'synthetic-dev.yaml' },
};
function record(number = 1, extra = {}) {
  const doc = fixture.docs[(number - 1) % fixture.docs.length];
  return {
    memoryRecordId: `fixture-record-${number}`, content: { text: doc.body },
    memoryStrategyId: doc.kind, createdAt: new Date(doc.date), namespaces: [shared], ...extra,
  };
}
function fake(send = async () => ({}), settings = {}, deps = {}) {
  const calls = [];
  let options;
  let factories = 0;
  const adapter = create({ ...cfg, ...settings }, {
    ...deps,
    clientFactory: (config, clientOptions) => {
      factories++;
      options = clientOptions;
      assert.equal(config.profile, cfg.profile);
      return { send: (command, sendOptions) => { calls.push({ command, ...sendOptions }); return send(command, sendOptions); } };
    },
  });
  return { adapter, calls, options: () => options, factories: () => factories };
}
const denied = () => Object.assign(new Error('private upstream detail'), { name: 'AccessDeniedException' });
const code = (expected) => (error) => error.code === expected && !error.message.includes('private upstream detail');

// The YAML and records are synthetic. No test resolves a real person profile.
test('stage inventory matches member, maintainer, offboarded and strategy rules', () => {
  const inventory = resolveNamespaces(stageCfg, { read: (path, encoding) => {
    assert.equal(path, 'synthetic-dev.yaml');
    assert.equal(encoding, 'utf8');
    return stageYaml;
  } });
  assert.deepEqual(inventory.map(({ namespace, kind }) => [namespace, kind]), [
    ['/shared/', 'global shared'], ['/actor/alice/', 'own private'],
    ['/project/example-project/shared/', 'project shared'],
    ['/project/example-project/proposals/alice/', 'own proposals'],
    ['/project/example-project/rejected/alice/', 'own rejected'],
    ['/project/example-project/proposals/bob/', 'member proposals'],
    ['/project/example-project/rejected/bob/', 'member rejected'],
    ['/project/example-project/proposals/carol/', 'offboarded member proposals'],
    ['/project/example-project/rejected/carol/', 'offboarded member rejected'],
    ['/project/second-project/shared/', 'project shared'],
    ['/project/second-project/proposals/alice/', 'own proposals'],
    ['/strategy/alice/facts/', 'own semantic strategy'],
    ['/strategy/alice/preferences/', 'own userPreference strategy'],
  ]);
  assert.ok(inventory.every((entry) => entry.label.includes(entry.namespace)));
  const member = resolveNamespaces({ ...stageCfg, actorId: 'bob' }, { read: () => stageYaml });
  assert.equal(member.some((entry) => entry.namespace === '/project/example-project/rejected/bob/'), false);
  assert.equal(member.some((entry) => entry.namespace.startsWith('/strategy/')), false);
});

test('explicit namespaces replace stage scope, including an empty list and exact session paths', () => {
  const read = () => { assert.fail('an explicit list must not read the stage file'); };
  assert.deepEqual(resolveNamespaces({ namespaces: [] }, { read }), []);
  assert.deepEqual(resolveNamespaces({ ...stageCfg, namespaces: [shared, { namespace: shared, label: 'duplicate' },
    { namespace: '/strategy/alice/sessions/example-session/', label: 'Session' }] }, { read }), [
    { namespace: shared, label: shared }, { namespace: '/strategy/alice/sessions/example-session/', label: 'Session' },
  ]);
});

test('scope failures reject bad files, wrong regions, non-dev stages and inactive persons', () => {
  for (const value of [undefined, {}, { kind: 'registry', path: 'ignored' }, { kind: 'stage-file', path: '' }]) {
    assert.throws(() => resolveNamespaces({ ...stageCfg, scope: value }), code('config'));
  }
  assert.throws(() => resolveNamespaces(stageCfg, { read: () => { throw new Error('missing file'); } }), code('config'));
  for (const config of [{ ...stageCfg, region: 'us-west-2' }, { ...stageCfg, actorId: 'carol' },
    { ...stageCfg, actorId: 'absent' }, { ...stageCfg, actorId: '../alice' }]) {
    assert.throws(() => resolveNamespaces(config, { read: () => stageYaml }), code('config'));
  }
  for (const text of [stageYaml.replace('stage: dev', 'stage: test'), stageYaml.replace('stage: dev', 'stage: prod')]) {
    assert.throws(() => resolveNamespaces(stageCfg, { read: () => text }), code('config'));
  }
  for (const namespaces of [null, 'not-a-list', ['/*'], ['/shared'], ['/../'], ['/a/#/'], [{}],
    [{ namespace: shared, label: '' }], [{ namespace: shared, label: '\n' }]]) {
    assert.throws(() => resolveNamespaces({ namespaces }), code('config'));
  }
});

test('strict stage parsing preserves quotes and rejects unsupported YAML and bad rosters', () => {
  assert.equal(parseStageYaml(stageYaml.replace('stage: dev', 'stage: "dev" # comment')).stage, 'dev');
  assert.equal(parseStageYaml(stageYaml.replace('stage: dev', "stage: 'dev'")).stage, 'dev');
  for (const text of ['', ' stage: dev', stageYaml + 'stage: dev\n', stageYaml.replace('stage: dev', 'stage: &dev dev'),
    stageYaml.replace('stage: dev', 'stage: *dev'), stageYaml.replace('stage: dev', 'stage: |\n  dev'),
    stageYaml.replace('stage: dev', 'stage: "dev'), stageYaml.replace('  enabled:', '\tenabled:'),
    stageYaml.replace('stage: dev', 'stage: !tag dev'), stageYaml.replace('schemaVersion: 1', 'schemaVersion: 2')]) {
    assert.throws(() => parseStageYaml(text), code('config'));
  }
  const mutations = [
    (s) => { s.people.push({ ...s.people[0] }); },
    (s) => { s.people[1].pin = s.people[0].pin; },
    (s) => { s.people[0].iamUser = 'yes'; },
    (s) => { s.people[0].pin = 'invalid'; },
    (s) => { s.projects[0].members.push('carol'); },
    (s) => { s.projects[0].maintainers = []; },
    (s) => { s.projects[0].deleters = ['carol']; },
    (s) => { s.projects[0].members.push('alice'); },
    (s) => { s.projects.push({ ...s.projects[0] }); },
    (s) => { s.memory.events = ['carol']; },
    (s) => { s.memory.eventExpiryDays = 1; },
    (s) => { s.memory.strategies.push({ ...s.memory.strategies[0] }); },
    (s) => { s.memory.strategies[0].type = 'unknown'; },
    (s) => { s.service.submit = 'yes'; },
    (s) => { s.hostRoles[0].actorId = 'alice'; },
    (s) => { s.hostRoles[0].proposalProject = 'absent'; },
    (s) => { s.hostRoles[0].roleSuffix = 'unknown'; },
    (s) => { s.extra = true; },
  ];
  for (const mutate of mutations) {
    const stage = parseStageYaml(stageYaml);
    mutate(stage);
    assert.throws(() => validateStage(stage), code('config'));
  }
  assert.throws(() => resolveNamespaces(stageCfg, {
    read: () => stageYaml.replace('/strategy/{actorId}/facts/', '/strategy/{unknown}/facts/'),
  }), code('config'));
});

test('client config rejects missing profile and invalid limits without resolving credentials', () => {
  for (const changes of [{ profile: undefined }, { profile: 'bad profile' }, { memoryId: '' }, { region: 'bad' },
    { maxPages: 0 }, { maxPages: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 2 ** 31 },
    { maxSearchNamespaces: 0 }, { refreshSeconds: -1 }, { refreshSeconds: Infinity }]) {
    assert.throws(() => fake(undefined, changes), code('config'));
  }
});

test('global hub, root browse, unknown records and default search never construct an AWS client', async () => {
  const source = fake();
  const hub = new Hub({ sources: [cfg] }, { factories: { agentcore: { create: () => source.adapter } } });
  hub.warm();
  assert.equal((await hub.overview())[0].total, null);
  assert.deepEqual(await hub.recent(), []);
  assert.deepEqual(await hub.search('UTC'), []);
  assert.equal((await hub.browse(cfg.id, {})).folders.length, 2);
  assert.equal(await source.adapter.get(`${shared}#unknown`), null);
  assert.equal(await source.adapter.get('unknown'), null);
  assert.equal(await source.adapter.get('/not-configured/#unknown'), null);
  await source.adapter.status();
  assert.equal(source.factories(), 0);
  assert.equal(source.calls.length, 0);
});

test('one namespace loads lazily with one attempt and bounded pagination', async () => {
  const source = fake(async (command) => ({ memoryRecordSummaries: [record(command.input.nextToken ? 2 : 1)], nextToken: 'more' }), { maxPages: 2 });
  const page = await source.adapter.browse({ path: shared });
  assert.equal(page.partial, true);
  assert.equal(page.state, 'partial');
  assert.equal(page.pages, 2);
  assert.equal(page.total, 2);
  assert.equal(source.calls.length, 2);
  assert.ok(source.calls.every(({ command, abortSignal }) => command instanceof ListMemoryRecordsCommand && abortSignal instanceof AbortSignal));
  assert.deepEqual(source.calls.map(({ command }) => command.input), [
    { memoryId: cfg.memoryId, namespace: shared, maxResults: 100 },
    { memoryId: cfg.memoryId, namespace: shared, maxResults: 100, nextToken: 'more' },
  ]);
  const { credentials, ...options } = source.options();
  assert.equal(typeof credentials, 'function');
  assert.deepEqual(options, { region: cfg.region, profile: cfg.profile, maxAttempts: 1, ignoreConfiguredEndpointUrls: true });
  const overview = await source.adapter.overview();
  assert.equal(overview.total, null);
  assert.equal(overview.partial, true);
  assert.equal(overview.facets[1].state, 'unloaded');
});

test('finished and empty pages stop without a second request', async () => {
  const source = fake(async (command) => command.input.namespace === shared ? { memoryRecordSummaries: [record()] } : {});
  assert.equal((await source.adapter.browse({ path: shared })).partial, false);
  assert.equal((await source.adapter.browse({ path: own })).state, 'empty');
  assert.equal(source.calls.length, 2);
  assert.equal((await source.adapter.overview()).total, 1);
});

test('cache refresh happens only on a namespace browse, and overlapping browses coalesce', async () => {
  let time = 1000;
  let reads = 0;
  const source = fake(async () => ({ memoryRecordSummaries: [record(++reads)] }), { refreshSeconds: 2 }, { now: () => time });
  await Promise.all([source.adapter.browse({ path: shared }), source.adapter.browse({ path: shared })]);
  await source.adapter.browse({ path: shared });
  assert.equal(reads, 1);
  assert.equal((await source.adapter.get(`${shared}#fixture-record-1`)).body, fixture.docs[0].body);
  time = 3000;
  assert.equal((await source.adapter.overview()).facets[0].count, undefined);
  assert.deepEqual(await source.adapter.recent(), []);
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.equal(reads, 1);
  await source.adapter.browse({ path: shared });
  assert.equal(reads, 2);
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.ok(await source.adapter.get(`${shared}#fixture-record-2`));
});

test('zero refresh age reloads browses but keeps the latest list and search readable', async () => {
  let time = 1000;
  let reads = 0;
  const source = fake(async () => ({ memoryRecordSummaries: [record(++reads)] }),
    { refreshSeconds: 0 }, { now: () => time });
  const first = await source.adapter.browse({ path: shared });
  time += 1000;
  assert.ok(await source.adapter.get(first.items[0].id));
  assert.equal((await source.adapter.overview()).facets[0].count, 1);
  assert.equal((await source.adapter.recent()).length, 1);
  const second = await source.adapter.browse({ path: shared });
  assert.equal(reads, 2);
  assert.equal(await source.adapter.get(first.items[0].id), null);
  assert.ok(await source.adapter.get(second.items[0].id));
  const search = await source.adapter.search('UTC', { path: shared });
  time += 1000;
  assert.ok(await source.adapter.get(search.items[0].id));
  assert.equal(reads, 3);
});

test('a denied refresh discards only that namespace and can recover', async () => {
  let rejectRead = false;
  const source = fake(async (command) => {
    if (rejectRead && command.input.namespace === shared) throw denied();
    return { memoryRecordSummaries: [record()] };
  }, { refreshSeconds: 0 });
  await source.adapter.browse({ path: shared });
  await source.adapter.browse({ path: own });
  rejectRead = true;
  await assert.rejects(source.adapter.browse({ path: shared }), code('denied'));
  const root = await source.adapter.browse();
  assert.equal(root.folders[0].state, 'denied');
  assert.equal(root.folders[1].error, undefined);
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.equal((await source.adapter.browse({ path: own })).total, 1);
  rejectRead = false;
  assert.equal((await source.adapter.browse({ path: shared })).total, 1);
});

test('a failed later page discards earlier pages and previous cached content', async () => {
  let failRead = false;
  let time = 1;
  const source = fake(async (command) => {
    if (command.input.nextToken) throw new Error('private upstream detail');
    return { memoryRecordSummaries: [record()], ...(failRead ? { nextToken: 'second' } : {}) };
  }, { refreshSeconds: 1 }, { now: () => time });
  await source.adapter.browse({ path: shared });
  failRead = true;
  time = 1001;
  await assert.rejects(source.adapter.browse({ path: shared }), code('aws_failed'));
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.deepEqual(await source.adapter.recent(), []);
});

test('semantic search keeps readable namespaces when another namespace denies the request', async () => {
  const source = fake(async (command) => {
    assert.ok(command instanceof RetrieveMemoryRecordsCommand);
    if (command.input.namespace === own) throw denied();
    return { memoryRecordSummaries: [record(1, { score: 0.8 }), record(2, { score: 0.95 })] };
  });
  const result = await source.adapter.search('UTC', { limit: 7 });
  assert.equal(result.total, 2);
  assert.equal(result.partial, true);
  assert.deepEqual(result.errors, [{ path: own, code: 'denied', message: 'The service denied the namespace read.' }]);
  assert.equal(result.items[0].score, 0.95);
  for (const { command } of source.calls) {
    assert.deepEqual(command.input.searchCriteria, { searchQuery: 'UTC', topK: 7 });
    assert.equal(command.input.maxResults, 7);
  }
  assert.equal((await source.adapter.get(result.items[0].id)).body, fixture.docs[1].body);
  assert.equal(source.calls.length, 2);
  assert.equal((await source.adapter.overview()).total, null);
});

test('search bounds, namespace selection and unknown namespaces', async () => {
  const source = fake(async () => ({ memoryRecordSummaries: [record()], nextToken: 'more' }), { maxSearchNamespaces: 1 });
  const result = await source.adapter.search('a'.repeat(2000), { limit: 100 });
  assert.equal(result.partial, true);
  assert.match(result.note, /1 namespace\(s\) not searched/);
  assert.equal(source.calls[0].command.input.searchCriteria.topK, 20);
  assert.equal(source.calls[0].command.input.searchCriteria.searchQuery.length, 1000);
  await source.adapter.search('UTC', { limit: -3, path: own });
  assert.equal(source.calls[1].command.input.searchCriteria.topK, 1);
  assert.equal(source.calls[1].command.input.namespace, own);
  await assert.rejects(source.adapter.search('UTC', { path: '/unknown/' }), code('unknown_namespace'));
  await assert.rejects(source.adapter.browse({ path: '/unknown/' }), code('unknown_namespace'));
  assert.equal(source.calls.length, 2);
});

test('a search denial discards a loaded namespace but preserves other cached records', async () => {
  const source = fake(async (command) => {
    if (command instanceof RetrieveMemoryRecordsCommand && command.input.namespace === shared) throw denied();
    return { memoryRecordSummaries: [record()] };
  });
  await source.adapter.browse({ path: shared });
  await source.adapter.browse({ path: own });
  const result = await source.adapter.search('UTC', { path: shared });
  assert.equal(result.errors[0].code, 'denied');
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.ok(await source.adapter.get(`${own}#fixture-record-1`));
  assert.deepEqual((await source.adapter.recent()).map((item) => item.scope), [own]);
});

test('sample guard fails both list and search namespaces without leaking earlier records', async () => {
  const bad = record(1, { memoryRecordId: fixture.docs[0].id });
  const source = fake(async (command) => ({ memoryRecordSummaries: [command.input.namespace === shared ? bad : record(2)] }));
  await assert.rejects(source.adapter.browse({ path: shared }), code('aws_failed'));
  assert.equal((await source.adapter.browse({ path: own })).total, 1);
  const result = await source.adapter.search('UTC');
  assert.equal(result.items.length, 1);
  assert.equal(result.errors[0].code, 'aws_failed');
  assert.equal(result.items[0].scope, own);
  assert.equal(await source.adapter.get(`${shared}#${bad.memoryRecordId}`), null);
});

test('malformed pages and credentials failures become safe per-namespace errors', async () => {
  for (const page of [null, [], 'invalid', { memoryRecordSummaries: null }, { memoryRecordSummaries: {} }, { memoryRecordSummaries: [null] },
    { memoryRecordSummaries: [{}] }, { memoryRecordSummaries: [record(1, { content: { text: 3 } })] }, { nextToken: 3 }]) {
    const source = fake(async () => page);
    await assert.rejects(source.adapter.browse({ path: shared }), code('aws_failed'));
  }
  const source = fake(async () => { throw Object.assign(new Error('private upstream detail'), { name: 'CredentialsProviderError' }); });
  await assert.rejects(source.adapter.browse({ path: shared }), code('credentials'));
  assert.equal((await source.adapter.browse()).folders[0].state, 'failed');
});

test('call deadlines abort a hung client and late replies cannot refill the cache', async () => {
  let finish;
  const source = fake(() => new Promise((resolve) => { finish = resolve; }), { timeoutMs: 15 });
  await assert.rejects(source.adapter.browse({ path: shared }), code('timeout'));
  assert.equal(source.calls[0].abortSignal.aborted, true);
  finish({ memoryRecordSummaries: [record()] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.deepEqual(await source.adapter.recent(), []);
  const search = fake(() => new Promise(() => {}), { timeoutMs: 15 });
  const result = await search.adapter.search('UTC');
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((error) => error.code === 'timeout'));
});

test('a queued search denial cannot leave a successful list in the cache', async () => {
  let finish;
  const source = fake((command) => {
    if (command instanceof RetrieveMemoryRecordsCommand) throw denied();
    return new Promise((resolve) => { finish = resolve; });
  });
  const load = source.adapter.browse({ path: shared });
  await new Promise((resolve) => setImmediate(resolve));
  const search = source.adapter.search('UTC', { path: shared });
  finish({ memoryRecordSummaries: [record()] });
  await load;
  assert.equal((await search).errors[0].code, 'denied');
  assert.equal(await source.adapter.get(`${shared}#fixture-record-1`), null);
  assert.deepEqual(await source.adapter.recent(), []);
});

test('detail returns complete synthetic text and metadata without fetching unknown records', async () => {
  const body = fixture.docs[0].body.repeat(50);
  const source = fake(async () => ({ memoryRecordSummaries: [record(1, {
    content: { text: body }, timestamp: new Date('2026-11-01T00:00:00Z'),
    metadata: { actorId: { stringValue: 'alice' }, count: { numberValue: 4 }, date: { dateTimeValue: new Date('2026-11-01T00:00:00Z') } },
  })] }));
  await source.adapter.browse({ path: shared });
  const detail = await source.adapter.get(`${shared}#fixture-record-1`);
  assert.equal(detail.body, body);
  assert.ok(detail.item.snippet.length <= 220);
  assert.equal(detail.item.dateLabel, 'event time');
  assert.ok(detail.meta.some(([key, value]) => key === 'metadata actorId' && value === 'alice'));
  assert.equal(await source.adapter.get(`${shared}#unknown`), null);
  assert.equal(source.calls.length, 1);
});

test('a fresh list replaces stale search details and search-only records', async () => {
  const source = fake(async (command) => ({ memoryRecordSummaries: command instanceof RetrieveMemoryRecordsCommand
    ? [record(1), record(2)] : [record(1, { content: { text: fixture.docs[2].body } })] }));
  await source.adapter.search('UTC', { path: shared });
  assert.ok(await source.adapter.get(`${shared}#fixture-record-2`));
  await source.adapter.browse({ path: shared });
  assert.equal(await source.adapter.get(`${shared}#fixture-record-2`), null);
  assert.equal((await source.adapter.get(`${shared}#fixture-record-1`)).body, fixture.docs[2].body);
});

test('adapter source admits only the two memory read commands', () => {
  const text = readFileSync(new URL('../lib/adapters/agentcore.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...new Set(text.match(/\b\w+Command\b/g))].sort(), ['ListMemoryRecordsCommand', 'RetrieveMemoryRecordsCommand']);
  assert.equal(text.includes('maxAttempts: 1'), true);
});
