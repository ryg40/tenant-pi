// Tracking modal: bounded frames at real pane sizes, hostile-content
// display, and the guarantee that workspace keys cannot fall through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TrackingModal } from '../../dist/src/companion/tracking-dialogs.mjs';
import { TrackingNavigationController } from '../../dist/src/tracking/selection.mjs';
import { REPO, detail, dependencyRead, fixtureCatalog, fixturePorts, hostile, page, tracked } from './fixtures.mjs';

const SIZES = [[40, 24], [97, 63], [60, 30]];
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));

function build({ rows = 24, items, details, catalog = fixtureCatalog() } = {}) {
  const list = items ?? Array.from({ length: 25 }, (_, i) => tracked(i + 1));
  const ports = fixturePorts({
    pages: [page(list, { hasMore: true }), page([tracked(26)], { page: 2 })],
    details: details ?? ((number) => detail(number)),
    catalog,
  });
  const controller = new TrackingNavigationController({ repo: REPO, ports });
  let height = rows;
  const modal = new TrackingModal(controller, { rows: () => height });
  return { controller, modal, ports, setRows: (value) => { height = value; } };
}

test('every pane fills its height exactly and never overflows its width', async () => {
  const { controller, modal, setRows } = build();
  await controller.openList(1);
  const panes = [
    async () => {},
    async () => { await modal.handleKey('\r'); },
    async () => { await modal.handleKey('g'); },
    async () => { await modal.handleKey('\r'); },
    async () => { await modal.handleKey('\r'); },
    async () => { await modal.handleKey('\r'); },
  ];
  const seen = new Set();
  for (const step of panes) {
    await step();
    seen.add(controller.getState().view);
    for (const [width, height] of SIZES) {
      setRows(height);
      const frame = modal.render(width);
      assert.equal(frame.length, height, `${controller.getState().view} rows at ${width}x${height}`);
      assert.ok(frame.every((row) => visibleWidth(row) <= width), `${controller.getState().view} overflow at ${width}x${height}`);
    }
    setRows(24);
  }
  assert.deepEqual([...seen], ['list', 'detail', 'workflow', 'provider', 'execution', 'preview']);
});

test('the list pane shows a whole 25-row page and follows the cursor while scrolling', async () => {
  const { controller, modal } = build({ rows: 24 });
  await controller.openList(1);
  const first = plain(modal.render(80));
  assert.ok(first.some((row) => /#1 open/.test(row)));
  assert.ok(first.some((row) => /page 1\+/.test(row)), 'more pages are named, not implied');
  for (let i = 0; i < 24; i++) await modal.handleKey('\x1b[B');
  const scrolled = plain(modal.render(80));
  assert.ok(scrolled.some((row) => /▶ #25 open/.test(row)), 'the cursor stayed visible past the window');
  assert.equal(controller.getState().list.cursor, 24);
});

test('Ctrl+S, Ctrl+E, Ctrl+O and Ctrl+U are refused by name instead of reaching the workspace', async () => {
  const { controller, modal } = build();
  await controller.openList(1);
  const before = JSON.stringify(controller.getState());
  for (const [key, expected] of [['\x13', /never queues or sends/], ['\x05', /composer is not reachable/], ['\x0f', /close tracking first/], ['\x15', /queue is not reachable/]]) {
    const outcome = await modal.handleKey(key);
    assert.equal(outcome, 'handled');
    const notice = plain(modal.render(97)).at(-2);
    assert.match(notice, expected);
  }
  assert.equal(JSON.stringify(controller.getState()), before, 'workspace keys changed no navigation state');
});

test('plain `s` in the modal does not submit anything', async () => {
  const { controller, modal } = build();
  await controller.openList(1);
  const before = JSON.stringify(controller.getState());
  await modal.handleKey('s');
  assert.equal(JSON.stringify(controller.getState()), before);
  assert.equal(controller.getLastRequest(), undefined);
});

test('Escape steps back one pane and finally hands focus to the host', async () => {
  const { controller, modal } = build();
  await controller.openList(1);
  await modal.handleKey('\r');
  await modal.handleKey('g');
  assert.equal(controller.getState().view, 'workflow');
  assert.equal(await modal.handleKey('\x1b'), 'handled');
  assert.equal(controller.getState().view, 'detail');
  assert.equal(await modal.handleKey('\x1b'), 'handled');
  assert.equal(controller.getState().view, 'list');
  assert.equal(await modal.handleKey('\x1b'), 'exit', 'from the list, Escape returns to the workspace');
});

test('the preview names its one action and prepares exactly one packet', async () => {
  const { controller, modal } = build();
  await controller.openList(1);
  await modal.handleKey('\r');
  await modal.handleKey('g');
  await modal.handleKey('\r');
  await modal.handleKey('\r');
  assert.equal(controller.getState().view, 'execution');
  assert.ok(plain(modal.render(97)).some((row) => /Herdr native sessions/.test(row)), 'the execution step offers Herdr native sessions');
  await modal.handleKey('\r');
  const rows = plain(modal.render(97));
  assert.ok(rows.some((row) => /Prepare request \(no launch\)/.test(row)), 'the action is named for what it does');
  assert.ok(rows.some((row) => /execution pi-subagents/.test(row)), 'the preview names the chosen execution');
  assert.ok(rows.some((row) => /runtime availability is unverified/.test(row)));
  assert.equal(await modal.handleKey('\r'), 'prepared');
  const packet = controller.consumeRequest();
  assert.equal(packet.kind, 'generate-prompt-request');
  // A repeated confirm on the same preview emits nothing further.
  assert.equal(await modal.handleKey('\r'), 'handled');
  assert.equal(controller.consumeRequest(), undefined);
});

test('a hostile title and body are displayed without their escape or bidi bytes', async () => {
  const nasty = detail(3, {
    title: hostile('Task three'),
    body: `${String.fromCharCode(0x1b)}[2J wiped\nsecond${String.fromCharCode(0x202e)} line`,
  });
  const { controller, modal } = build({ items: [tracked(3, { title: hostile('Task three') })], details: () => nasty });
  await controller.openList(1);
  await modal.handleKey('\r');
  const frame = modal.render(80);
  const joined = frame.join('\n');
  for (const code of [0x202e, 0x7f, 0x9b]) {
    assert.ok(!joined.includes(String.fromCharCode(code)), `frame kept 0x${code.toString(16)}`);
  }
  // The only escapes left are this component's own SGR colour codes.
  assert.equal(joined.replace(/\x1b\[[0-9;]*m/g, '').includes(String.fromCharCode(0x1b)), false);
  assert.ok(plain(frame).some((row) => /Task three/.test(row)), 'readable text survives sanitising');
});

test('a missing catalog is stated in the picker rather than filled with an invented matrix', async () => {
  const { controller, modal } = build({ catalog: null });
  await controller.openList(1);
  await modal.handleKey('\r');
  await modal.handleKey('g');
  const rows = plain(modal.render(80));
  assert.ok(rows.some((row) => /catalog unavailable/i.test(row)));
  assert.ok(rows.some((row) => /Nothing is generated, launched or sent/.test(row)));
  assert.equal(await modal.handleKey('\r'), 'handled');
  assert.equal(controller.getLastRequest(), undefined);
});

test('a blocked issue shows its reasons in the detail pane and refuses g', async () => {
  const blocked = detail(4, { state: 'closed', dependencies: dependencyRead({ status: 'unavailable', reason: 'offline' }) });
  const { controller, modal } = build({ items: [tracked(4)], details: () => blocked });
  await controller.openList(1);
  await modal.handleKey('\r');
  await modal.handleKey('g');
  assert.equal(controller.getState().view, 'detail', 'g did not open a picker for a blocked issue');
  const rows = plain(modal.render(97));
  assert.ok(rows.some((row) => /blocked:/.test(row)));
  assert.ok(rows.some((row) => /issue is closed/.test(row)));
});

test('page keys read one page per action and reset the read position', async () => {
  const { controller, modal, ports } = build();
  await controller.openList(1);
  assert.equal(ports.state.listCalls, 1);
  await modal.handleKey('n');
  assert.equal(controller.getState().list.page, 2);
  assert.equal(ports.state.listCalls, 2, 'one page read per key');
  await modal.handleKey('p');
  assert.equal(controller.getState().list.page, 1);
  assert.equal(ports.state.listCalls, 3);
});
