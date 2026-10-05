// Requests pane in the tracking modal: `p` from detail, bounded frames,
// cursor, Enter → "reopen" with a one-shot consumeReopen(), Esc back to detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TrackingModal } from '../../dist/src/companion/tracking-dialogs.mjs';
import { TrackingNavigationController } from '../../dist/src/tracking/selection.mjs';
import { listRequests, loadRequest } from '../../dist/src/tracking/requests.mjs';
import { REPO, detail, fixtureCatalog, fixturePorts, page, tracked } from '../tracking-navigation/fixtures.mjs';
import { DIR, fakeFs, packet } from './fixtures.mjs';
const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));

function fixtureRequests(files) {
  const fs = fakeFs(files);
  const calls = { list: 0, load: 0 };
  return {
    calls,
    list: (issue) => { calls.list += 1; return listRequests(DIR, issue, fs); },
    load: (entry) => { calls.load += 1; return loadRequest(entry, fs); },
  };
}

async function build({ rows = 24, requests } = {}) {
  const ports = fixturePorts({
    pages: [page([tracked(1), tracked(2)])],
    details: (number) => detail(number),
    catalog: fixtureCatalog(),
  });
  const controller = new TrackingNavigationController({ repo: REPO, ports });
  let height = rows;
  const modal = new TrackingModal(controller, { rows: () => height, requests });
  await controller.openList(1);
  await modal.handleKey('\r');
  assert.equal(controller.getState().view, 'detail');
  return { controller, modal, setRows: (value) => { height = value; } };
}

const FILES = {
  '1-20260907T120000Z.json': JSON.stringify(packet(1)),
  '1-20260907T120000Z.md': 'generated for one\n',
  '1-20260901T100000Z.json': JSON.stringify(packet(1)),
  '1-20260903T000000Z.json': '{broken',
  '2-20260907T120000Z.json': JSON.stringify(packet(2)),
};

test('`p` without a port leaves a notice and opens nothing', async () => {
  const { controller, modal } = await build();
  assert.equal(await modal.handleKey('p'), 'handled');
  const rows = plain(modal.render(97));
  assert.match(rows.at(-2), /Requests browser unavailable here\./);
  assert.ok(!rows[0].includes('· requests'));
  assert.equal(controller.getState().view, 'detail');
  assert.match(rows.at(-1), /p requests/, 'the detail hint names the key');
});

test('`p` with a port opens a bounded requests pane at 24 and 63 rows', async () => {
  const requests = fixtureRequests(FILES);
  const { modal, setRows } = await build({ requests });
  assert.equal(await modal.handleKey('P'), 'handled');
  assert.equal(requests.calls.list, 1);
  for (const [width, height] of [[40, 24], [97, 63]]) {
    setRows(height);
    const frame = modal.render(width);
    assert.equal(frame.length, height);
    assert.ok(frame.every((row) => visibleWidth(row) <= width));
  }
  setRows(24);
  const rows = plain(modal.render(97));
  assert.match(rows[0], /detail · requests/);
  assert.match(rows[1], /^requests for #1 · 2 saved · 1 skipped/);
  assert.match(rows[2], /^▶ 20260907T120000Z · fixture-a · fixture-provider-1 · generated/);
  assert.match(rows[3], /^  20260901T100000Z · fixture-a · fixture-provider-1$/);
  assert.match(rows.at(-1), /Enter reopens into the composer · Esc back to detail/);
});

test('an issue without packets says so', async () => {
  const { modal } = await build({ requests: fixtureRequests({ '2-20260907T120000Z.json': JSON.stringify(packet(2)) }) });
  await modal.handleKey('p');
  const rows = plain(modal.render(80));
  assert.match(rows[1], /requests for #1 · 0 saved · 0 skipped/);
  assert.match(rows[2], /no saved requests for this issue/);
});

test('↑↓ move the cursor and Enter reopens the chosen packet exactly once', async () => {
  const requests = fixtureRequests(FILES);
  const { controller, modal } = await build({ requests });
  await modal.handleKey('p');
  await modal.handleKey('\x1b[B');
  let rows = plain(modal.render(97));
  assert.match(rows[3], /^▶ 20260901T100000Z/);
  await modal.handleKey('\x1b[B');
  assert.match(plain(modal.render(97))[3], /^▶ 20260901T100000Z/, 'cursor clamps at the end');
  await modal.handleKey('\x1b[A');
  await modal.handleKey('\x1b[A');
  rows = plain(modal.render(97));
  assert.match(rows[2], /^▶ 20260907T120000Z/);

  assert.equal(await modal.handleKey('\r'), 'reopen');
  assert.equal(requests.calls.load, 1);
  const loaded = modal.consumeReopen();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.packet.task.number, 1);
  assert.equal(loaded.generated, 'generated for one\n');
  assert.equal(modal.consumeReopen(), undefined, 'one-shot');
  assert.equal(controller.getState().view, 'detail');
  assert.ok(!plain(modal.render(97))[0].includes('· requests'), 'the pane closed');
  assert.equal(controller.consumeRequest(), undefined, 'no new packet was prepared');
});

test('a packet that fails to load leaves a notice and reopens nothing', async () => {
  const fs = fakeFs({ '1-20260907T120000Z.json': JSON.stringify(packet(1)) });
  const requests = { list: (issue) => listRequests(DIR, issue, fs), load: () => ({ ok: false, reason: 'packet malformed' }) };
  const { modal } = await build({ requests });
  await modal.handleKey('p');
  assert.equal(await modal.handleKey('\r'), 'handled');
  const rows = plain(modal.render(97));
  assert.match(rows.at(-2), /packet unreadable: packet malformed — nothing reopened/);
  assert.match(rows[0], /· requests/, 'the pane stays open');
  assert.equal(modal.consumeReopen(), undefined);
});

test('Esc closes the pane and stays in detail; a second Esc goes back to the list', async () => {
  const { controller, modal } = await build({ requests: fixtureRequests(FILES) });
  await modal.handleKey('p');
  assert.equal(await modal.handleKey('\x1b'), 'handled');
  assert.equal(controller.getState().view, 'detail');
  assert.ok(!plain(modal.render(97))[0].includes('· requests'));
  assert.equal(await modal.handleKey('\x1b'), 'handled');
  assert.equal(controller.getState().view, 'list');
});

test('workspace keys are still refused while the pane is open', async () => {
  const { modal } = await build({ requests: fixtureRequests(FILES) });
  await modal.handleKey('p');
  assert.equal(await modal.handleKey('\x13'), 'handled');
  const rows = plain(modal.render(97));
  assert.match(rows.at(-2), /never queues or sends/);
  assert.match(rows[0], /· requests/);
});
