// Navigation controller: stable identity, stale-response handling,
// change detection, native blockers, and the one attributed request packet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingNavigationController } from '../../dist/src/tracking/selection.mjs';
import { REPO, detail, dependencyRead, fixtureCatalog, fixturePorts, page, tracked } from './fixtures.mjs';

const make = (options) => new TrackingNavigationController({ repo: REPO, ...options });

async function ready({ detailOverrides = {}, catalog = fixtureCatalog(), items } = {}) {
  const rows = items ?? [tracked(5), tracked(7), tracked(9)];
  const ports = fixturePorts({
    pages: [page(rows)],
    details: { 7: detail(7, detailOverrides) },
    catalog,
  });
  const controller = make({ ports });
  await controller.openList(1);
  controller.moveCursor(1);
  controller.select();
  await controller.openDetail();
  return { controller, ports };
}

test('rebinding preserves the new provider and drops old selection and in-flight results', async () => {
  const { controller, ports } = await ready();
  const github = { provider: 'github', host: 'https://github.com', owner: 'example', repo: 'mirror' };
  let release;
  ports.listPage = () => new Promise(resolve => { release = resolve; });
  const pending = controller.refresh();
  controller.rebind(github);
  release(page([tracked(99)]));
  assert.equal(await pending, 'stale');
  assert.deepEqual(controller.getState().repo, github);
  assert.equal(controller.getState().selectedNumber, undefined);
  assert.equal(controller.getState().list.items.length, 0);
  assert.equal(controller.getState().requestReady, false);
  ports.listPage = async repo => { assert.deepEqual(repo, github); return page([tracked(1)]); };
  await controller.openList();
  assert.equal(controller.getState().list.items.length, 1);
});

test('the constructor refuses an unusable repository binding', () => {
  assert.throws(() => new TrackingNavigationController({ repo: { host: 'nope', owner: 'a', repo: 'b' }, ports: fixturePorts() }), /invalid repository/);
});

test('a page read past the summary cap drives the list, one request per action', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => tracked(i + 1));
  const ports = fixturePorts({ pages: [page(rows, { hasMore: true }), page([tracked(26)], { page: 2 })] });
  const controller = make({ ports });
  await controller.openList(1);
  assert.equal(controller.getState().list.items.length, 25);
  assert.equal(ports.state.listCalls, 1, 'one page read per user action');
  await controller.nextPage();
  assert.equal(controller.getState().list.page, 2);
  assert.equal(ports.state.listCalls, 2);
  assert.equal(await controller.nextPage(), 'refused', 'the last page does not read again');
  assert.equal(ports.state.listCalls, 2);
  await controller.previousPage();
  assert.equal(controller.getState().list.page, 1);
  assert.equal(await controller.previousPage(), 'refused');
});

test('a refresh that reorders the page keeps the same selected issue', async () => {
  const ports = fixturePorts({
    pages: (pageNumber, call) =>
      call === 1 ? page([tracked(5), tracked(7), tracked(9)]) : page([tracked(9), tracked(5), tracked(7)]),
  });
  const controller = make({ ports });
  await controller.openList(1);
  controller.moveCursor(1);
  controller.select();
  assert.equal(controller.getState().selectedNumber, 7);
  await controller.refresh();
  const state = controller.getState();
  assert.equal(state.selectedNumber, 7, 'identity, not row index, survives a reorder');
  assert.equal(state.list.cursor, 2, 'the cursor follows the issue to its new row');
});

test('a refresh that removes the selected issue clears it instead of retargeting', async () => {
  const ports = fixturePorts({
    pages: (pageNumber, call) => (call === 1 ? page([tracked(5), tracked(7), tracked(9)]) : page([tracked(5), tracked(9)])),
  });
  const controller = make({ ports });
  await controller.openList(1);
  controller.moveCursor(1);
  controller.select();
  await controller.refresh();
  const state = controller.getState();
  assert.equal(state.selectedKey, undefined, 'a removed selection is cleared');
  assert.equal(state.selectedNumber, undefined);
  assert.match(state.notice, /no longer on this page/);
  assert.deepEqual([...state.blockers], ['no issue selected']);
});

test('a response that lands after cancellation is dropped without touching state', async () => {
  let release;
  const ports = fixturePorts({ pages: [] });
  ports.listPage = () => new Promise((resolve) => { release = () => resolve(page([tracked(1)])); });
  const controller = make({ ports });
  const inFlight = controller.openList(1);
  controller.cancel();
  release();
  assert.equal(await inFlight, 'stale');
  const state = controller.getState();
  assert.equal(state.list.items.length, 0, 'a cancelled read never populates the list');
  assert.match(state.notice, /Cancelled/);
});

test('a superseded page read cannot overwrite the newer one', async () => {
  const pending = [];
  const ports = fixturePorts({ pages: [] });
  ports.listPage = (repo, pageNumber) => new Promise((resolve) => pending.push(() => resolve(page([tracked(pageNumber)], { page: pageNumber }))));
  const controller = make({ ports });
  const first = controller.openList(1);
  const second = controller.openList(2);
  pending[1]();
  pending[0]();
  assert.equal(await second, 'applied');
  assert.equal(await first, 'stale');
  assert.equal(controller.getState().list.page, 2, 'the late first response did not win');
});

test('an offline list is displayed as cached and cannot start a selection', async () => {
  const ports = fixturePorts({ pages: (p, call) => (call === 1 ? page([tracked(5)]) : new Error('offline')) });
  const controller = make({ ports });
  await controller.openList(1);
  await controller.refresh();
  const state = controller.getState();
  assert.equal(state.list.offline, true);
  assert.equal(state.list.items.length, 1, 'cached rows may still be displayed');
  assert.match(state.notice, /unavailable/);
  assert.equal(controller.select(), 'refused', 'cached rows cannot create a request path');
});

test('an unreadable detail is unavailable, not open work', async () => {
  const ports = fixturePorts({ pages: [page([tracked(7)])], details: { 7: undefined } });
  const controller = make({ ports });
  await controller.openList(1);
  controller.select();
  await controller.openDetail();
  const state = controller.getState();
  assert.equal(state.detail, undefined);
  assert.equal(state.detailStale, true);
  assert.ok(state.blockers.includes('issue detail was never read'));
});

test('closed, retired and natively blocked issues block the request with reasons', async () => {
  const cases = [
    [{ state: 'closed' }, /closed/],
    [{ labels: ['resolution:retired'] }, /resolution:retired/],
    [{ dependencies: dependencyRead({ items: [{ number: 30, title: 'catalog', state: 'open', repo: 'owner/promptr' }], blockers: 1 }) }, /open native dependency blocker/],
    [{ dependencies: dependencyRead({ status: 'incomplete', reason: 'read bounded' }) }, /dependency read incomplete/],
    [{ dependencies: dependencyRead({ status: 'unavailable', reason: 'ECONNREFUSED' }) }, /cannot claim unblocked/],
  ];
  for (const [overrides, expected] of cases) {
    const { controller } = await ready({ detailOverrides: overrides });
    const blockers = controller.getState().blockers;
    assert.ok(blockers.some((b) => expected.test(b)), `${JSON.stringify(overrides)} -> ${blockers.join('; ')}`);
    assert.equal(await controller.startGenerate(), 'refused', 'a blocked issue never opens the workflow picker');
    assert.equal(controller.prepareRequest().ok, false);
    assert.equal(controller.getLastRequest(), undefined, 'no packet exists for a blocked issue');
  }
});

test('an issue that changed under a reviewed detail demands a deliberate re-review', async () => {
  const ports = fixturePorts({
    pages: [page([tracked(7)])],
    details: (number, call) => (call === 1 ? detail(7) : detail(7, { updatedAt: '2026-09-06T09:00:00Z' })),
    catalog: fixtureCatalog(),
  });
  const controller = make({ ports });
  await controller.openList(1);
  controller.select();
  await controller.openDetail();
  assert.equal(await controller.startGenerate(), 'refused');
  let state = controller.getState();
  assert.equal(state.changed, true);
  assert.equal(state.view, 'detail', 'a changed issue does not slide into the picker');
  assert.match(state.notice, /changed since you reviewed it/);
  assert.ok(state.blockers.some((b) => /review it again/.test(b)));

  controller.acceptReviewedDetail();
  assert.equal(controller.getState().changed, false);
  assert.equal(await controller.startGenerate(), 'applied', 'after a deliberate re-review generation may start');
  assert.equal(controller.getState().view, 'workflow');
});

test('without an injected catalog the picker says so and offers nothing', async () => {
  // `null`, not `undefined`: an omitted option would fall back to the fixture catalog.
  const { controller } = await ready({ catalog: null });
  assert.equal(controller.getState().catalogAvailable, false);
  assert.equal(await controller.startGenerate(), 'refused');
  const state = controller.getState();
  assert.match(state.notice, /catalog unavailable/i);
  assert.deepEqual([...controller.listWorkflows()], []);
  assert.deepEqual([...controller.listProviders()], []);
  assert.equal(controller.chooseWorkflow('fixture-a'), 'refused');
  assert.equal(controller.prepareRequest().ok, false);
});

test('workflow then provider produces an inert preview and one frozen packet', async () => {
  const { controller, ports } = await ready();
  assert.equal(await controller.startGenerate(), 'applied');
  assert.equal(ports.state.detailCalls, 2, 'the issue is re-read before the picker opens');
  assert.equal(controller.chooseWorkflow('fixture-a'), 'applied');
  assert.equal(controller.getState().view, 'provider');
  assert.equal(controller.chooseProvider('fixture-provider-2'), 'applied');
  const execution = controller.getState();
  assert.equal(execution.view, 'execution', 'the provider step leads to the execution choice');
  assert.equal(execution.expansion, undefined, 'nothing is previewed before the execution choice');
  assert.deepEqual(controller.listExecutions().map((e) => e.id), ['pi-subagents', 'herdr-native']);
  assert.equal(controller.chooseExecution('teleport'), 'refused');
  assert.equal(controller.chooseExecution('herdr-native'), 'applied');
  const preview = controller.getState();
  assert.equal(preview.view, 'preview');
  assert.equal(preview.executionId, 'herdr-native');
  assert.equal(preview.expansion.template, 'fixture-a');
  assert.equal(preview.expansion.provider, 'fixture-provider-2');
  assert.match(preview.notice, /Nothing launched or sent/);
  assert.equal(preview.requestReady, false, 'a preview is not a request');

  const result = controller.prepareRequest();
  assert.equal(result.ok, true);
  const packet = result.value;
  assert.equal(packet.version, 1);
  assert.equal(packet.kind, 'generate-prompt-request');
  assert.equal(packet.createdAt, '2026-09-07T12:34:56Z', 'the injected clock makes the packet deterministic');
  assert.equal(packet.task.number, 7);
  assert.equal(packet.task.url, `${REPO.host}/owner/promptr/issues/7`);
  assert.equal(packet.task.body, 'line one\nline two\n\nline four', 'the reviewed bytes travel unchanged');
  assert.equal(packet.task.bodyTruncated, false);
  assert.deepEqual(packet.task.repo, REPO);
  assert.equal(packet.workflow.template, 'fixture-a');

  assert.ok(Object.isFrozen(packet) && Object.isFrozen(packet.task) && Object.isFrozen(packet.task.labels));
  assert.throws(() => { packet.task.number = 99; }, TypeError);

  // The packet carries the task and the workflow, and nothing else.
  assert.deepEqual(Object.keys(packet).sort(), ['createdAt', 'kind', 'task', 'version', 'workflow']);
  const wire = JSON.stringify(packet);
  for (const forbidden of ['token', 'composer', 'queue', 'scratch', 'transcript', 'Authorization']) {
    assert.ok(!wire.toLowerCase().includes(forbidden.toLowerCase()), `packet leaked ${forbidden}`);
  }
});

test('a repeated confirm cannot emit a second packet for the same preview', async () => {
  const { controller } = await ready();
  await controller.startGenerate();
  controller.chooseWorkflow('fixture-a');
  controller.chooseProvider('fixture-provider-1');
  controller.chooseExecution('pi-subagents');
  const first = controller.prepareRequest();
  assert.equal(first.ok, true);
  const second = controller.prepareRequest();
  assert.equal(second.ok, false);
  assert.match(second.error, /already prepared/);
  assert.equal(controller.consumeRequest(), first.value);
  assert.equal(controller.consumeRequest(), undefined, 'the packet is handed over exactly once');
  assert.equal(controller.getLastRequest(), first.value, 'the in-memory accessor still holds it');
});

test('cancelling out of the preview discards it without emitting anything', async () => {
  const { controller } = await ready();
  await controller.startGenerate();
  controller.chooseWorkflow('fixture-a');
  controller.chooseProvider('fixture-provider-1');
  controller.chooseExecution('pi-subagents');
  assert.equal(controller.back(), 'execution');
  assert.equal(controller.getState().expansion, undefined);
  assert.equal(controller.getState().executionId, undefined);
  assert.equal(controller.back(), 'provider');
  assert.equal(controller.prepareRequest().ok, false);
  assert.equal(controller.getLastRequest(), undefined, 'cancelling never produced a packet');
  assert.equal(controller.back(), 'workflow');
  assert.equal(controller.back(), 'detail');
  assert.match(controller.getState().notice, /Nothing launched or sent/);
  assert.equal(controller.back(), 'list');
  assert.equal(controller.back(), 'exit', 'from the list, back hands focus to the host');
});

test('re-selecting an issue drops any preview built for it', async () => {
  const { controller } = await ready();
  await controller.startGenerate();
  controller.chooseWorkflow('fixture-a');
  controller.chooseProvider('fixture-provider-1');
  controller.chooseExecution('pi-subagents');
  assert.ok(controller.getState().expansion);
  controller.select();
  assert.equal(controller.getState().expansion, undefined);
  assert.equal(controller.getState().workflowId, undefined);
});

test('readiness is stated, never inferred, and a catalog error surfaces verbatim', async () => {
  const failing = fixtureCatalog({ expandWorkflow: () => ({ ok: false, error: 'simple template needs a resolved design' }) });
  const { controller } = await ready({ catalog: failing });
  assert.equal(controller.getReadiness(), 'unknown', 'nothing is inferred from the issue text');
  controller.setReadiness('unresolved-design');
  assert.equal(controller.getReadiness(), 'unresolved-design');
  await controller.startGenerate();
  controller.chooseWorkflow('fixture-a');
  assert.equal(controller.chooseProvider('fixture-provider-1'), 'refused');
  assert.match(controller.getState().notice, /simple template needs a resolved design/);
  assert.equal(controller.getState().expansion, undefined);
});

test('the controller exposes no send, launch, enqueue or write surface', () => {
  const names = Object.getOwnPropertyNames(TrackingNavigationController.prototype);
  // `execution` is the delegation-mode picker step (listExecutions/chooseExecution),
  // a choice of text, not a surface that executes anything.
  const dangerous = names.filter((n) => /send|launch|spawn|exec(?!ution)|enqueue|write|save|submit|post/i.test(n));
  assert.deepEqual(dangerous, [], `unexpected execution surface: ${dangerous.join(', ')}`);
});
