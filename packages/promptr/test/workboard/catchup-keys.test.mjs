// Catch-Me-Up key `c` in the workboard modal: one intent per press in
// list/detail, ignored elsewhere with the notice, a scrollable pane, hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingModal, catchUpFreshnessHint } from '../../dist/src/companion/tracking-dialogs.mjs';
import { TrackingNavigationController } from '../../dist/src/tracking/selection.mjs';
import { KEY_REFERENCE } from '../../dist/src/companion/view.mjs';
import { parseCatchUpArgs } from '../../dist/src/extension/hosted-tracking.mjs';
import { REPO, detail, fixtureCatalog, fixturePorts, page, tracked } from '../tracking-navigation/fixtures.mjs';

const plain = (rows) => rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
const NOW = Date.parse('2026-09-08T12:00:00Z');
const H = 60 * 60 * 1000;

function fakeCatchUp({ latest, fail, delay = 0 } = {}) {
  const calls = { run: 0 };
  let current = latest;
  const markdown = Array.from({ length: 60 }, (_, i) => (i === 0 ? '# Catch-Me-Up — promptr — 2026-09-08T12:00:00Z' : `- line ${i}`)).join('\n');
  return {
    calls,
    async run() {
      calls.run += 1;
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
      if (fail) throw new Error('git exploded');
      current = { generatedAt: new Date(NOW).toISOString(), summary: 'catch-up just now · 4 issues · 2 worktrees · 1 handoff', markdown, file: '/state/catchup/20260908T120000Z.md' };
      return current;
    },
    latest: () => current,
    now: () => NOW,
  };
}

async function build({ rows = 24, catchUp, toDetail = true } = {}) {
  const ports = fixturePorts({ pages: [page([tracked(1), tracked(2)])], details: (number) => detail(number), catalog: fixtureCatalog() });
  const controller = new TrackingNavigationController({ repo: REPO, ports });
  let height = rows;
  const modal = new TrackingModal(controller, { rows: () => height, catchUp });
  await controller.openList(1);
  if (toDetail) {
    await modal.handleKey('\r');
    assert.equal(controller.getState().view, 'detail');
  }
  return { controller, modal, setRows: (value) => { height = value; } };
}

test('`c` without a port leaves a notice and runs nothing', async () => {
  const { modal } = await build();
  assert.equal(await modal.handleKey('c'), 'handled');
  const rows = plain(modal.render(97));
  assert.match(rows.at(-2), /Catch-Me-Up unavailable here\./);
  assert.equal(modal.catchUpPaneOpen, false);
});

test('`c` in the list view runs one catch-up and opens the pane; the rule shows the summary', async () => {
  const catchUp = fakeCatchUp();
  const { modal } = await build({ catchUp, toDetail: false });
  assert.equal(await modal.handleKey('c'), 'handled');
  assert.equal(catchUp.calls.run, 1);
  assert.equal(modal.catchUpRunCount, 1);
  assert.equal(modal.catchUpPaneOpen, true);
  const rows = plain(modal.render(160));
  assert.match(rows[0], /· list · catch-up · catch-up just now · 4 issues · 2 worktrees · 1 handoff/);
  assert.match(rows[1], /^# Catch-Me-Up/);
  assert.match(rows.at(-2), /catch-up just now .* \/state\/catchup\/20260908T120000Z\.md/);
  assert.match(rows.at(-1), /↑↓ PgUp PgDn scroll the catch-up digest · Esc back/);
});

test('`C` in detail runs once; a second press while running does not start another', async () => {
  const catchUp = fakeCatchUp({ delay: 20 });
  const { modal } = await build({ catchUp });
  const first = modal.handleKey('C');
  const during = plain(modal.render(80));
  assert.match(during[0], /catching up…/);
  assert.match(during.at(-2), /catching up…/);
  await modal.handleKey('c');
  assert.equal(catchUp.calls.run, 1, 'no second run while one is in flight');
  await first;
  assert.equal(modal.catchUpPaneOpen, true);
});

test('pane scrolls with ↑↓ PgUp PgDn and Esc closes only the pane', async () => {
  const catchUp = fakeCatchUp();
  const { controller, modal } = await build({ catchUp, rows: 12 });
  await modal.handleKey('c');
  let rows = plain(modal.render(160));
  assert.match(rows[0], /1-9\/60/);
  await modal.handleKey('\x1b[B');
  rows = plain(modal.render(160));
  assert.match(rows[0], /2-10\/60/);
  await modal.handleKey('\x1b[6~');
  rows = plain(modal.render(160));
  assert.match(rows[0], /11-19\/60/);
  await modal.handleKey('\x1b[5~');
  rows = plain(modal.render(160));
  assert.match(rows[0], /2-10\/60/);
  await modal.handleKey('\x1b[A');
  rows = plain(modal.render(160));
  assert.match(rows[0], /1-9\/60/);
  assert.equal(await modal.handleKey('\x1b'), 'handled');
  assert.equal(modal.catchUpPaneOpen, false);
  assert.equal(controller.getState().view, 'detail', 'Esc closed the pane, not the detail');
  rows = plain(modal.render(160));
  assert.match(rows[0], /· detail · catch-up just now/);
});

test('`c` in workflow, provider, execution and preview views is ignored with the notice', async () => {
  const catchUp = fakeCatchUp();
  const { controller, modal } = await build({ catchUp });
  await modal.handleKey('g');
  assert.equal(controller.getState().view, 'workflow');
  await modal.handleKey('c');
  assert.equal(catchUp.calls.run, 0);
  assert.match(plain(modal.render(97)).at(-2), /TRACKING ignores c — \? lists the keys/);
  await modal.handleKey('\r');
  assert.equal(controller.getState().view, 'provider');
  await modal.handleKey('C');
  assert.equal(catchUp.calls.run, 0);
  assert.match(plain(modal.render(97)).at(-2), /TRACKING ignores c/);
  await modal.handleKey('\r');
  assert.equal(controller.getState().view, 'execution');
  await modal.handleKey('c');
  assert.equal(catchUp.calls.run, 0);
  assert.match(plain(modal.render(97)).at(-2), /TRACKING ignores c/);
  await modal.handleKey('\r');
  assert.equal(controller.getState().view, 'preview');
  await modal.handleKey('c');
  assert.equal(catchUp.calls.run, 0);
  assert.match(plain(modal.render(97)).at(-2), /TRACKING ignores c/);
});

test('a failing run reports the failure and opens no pane', async () => {
  const catchUp = fakeCatchUp({ fail: true });
  const { modal } = await build({ catchUp });
  await modal.handleKey('c');
  assert.equal(modal.catchUpPaneOpen, false);
  assert.match(plain(modal.render(97)).at(-2), /catch-up failed: git exploded — nothing written/);
});

test('hint tiers contain `c` in list and detail at three widths; preview shows freshness', async () => {
  const stale = { generatedAt: new Date(NOW - 25 * H).toISOString(), summary: 's', markdown: '', file: 'f' };
  const fresh = { generatedAt: new Date(NOW - 2 * H).toISOString(), summary: 's', markdown: '', file: 'f' };
  for (const width of [140, 70, 40]) {
    const list = await build({ catchUp: fakeCatchUp(), toDetail: false });
    assert.match(plain(list.modal.render(width)).at(-1), /\bc\b/, `list hint names c at ${width}`);
    const det = await build({ catchUp: fakeCatchUp() });
    assert.match(plain(det.modal.render(width)).at(-1), /c catch-up/, `detail hint names c at ${width}`);
  }
  const { modal } = await build({ catchUp: fakeCatchUp({ latest: stale }) });
  await modal.handleKey('g');
  await modal.handleKey('\r');
  await modal.handleKey('\r');
  await modal.handleKey('\r');
  assert.match(plain(modal.render(140)).at(-1), /no fresh catch-up · press c/);
  const freshModal = await build({ catchUp: fakeCatchUp({ latest: fresh }) });
  await freshModal.modal.handleKey('g');
  await freshModal.modal.handleKey('\r');
  await freshModal.modal.handleKey('\r');
  await freshModal.modal.handleKey('\r');
  for (const width of [140, 70, 40]) assert.match(plain(freshModal.modal.render(width)).at(-1), /catch-up 2h ago/, `preview freshness at ${width}`);
  assert.equal(catchUpFreshnessHint(undefined, NOW), 'no fresh catch-up · press c');
  assert.equal(catchUpFreshnessHint(fresh, NOW), 'catch-up 2h ago');
  assert.equal(catchUpFreshnessHint(stale, NOW), 'no fresh catch-up · press c');
});

test('KEY_REFERENCE.tracking lists c', () => {
  const entry = KEY_REFERENCE.tracking.find(([key]) => key === 'c');
  assert.ok(entry);
  assert.match(entry[1], /Catch-Me-Up/);
});

test('parseCatchUpArgs accepts --since 48h|7d|<iso> and rejects the rest', () => {
  assert.deepEqual(parseCatchUpArgs(''), {});
  assert.deepEqual(parseCatchUpArgs(undefined), {});
  assert.deepEqual(parseCatchUpArgs('--since 48h'), { since: '48h' });
  assert.deepEqual(parseCatchUpArgs('--since=7d'), { since: '7d' });
  assert.deepEqual(parseCatchUpArgs('--since 2026-09-01T00:00:00Z'), { since: '2026-09-01T00:00:00Z' });
  assert.ok('error' in parseCatchUpArgs('--since'));
  assert.ok('error' in parseCatchUpArgs('--since soon'));
  assert.ok('error' in parseCatchUpArgs('now'));
});
