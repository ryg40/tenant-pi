// selectIssue + back() exit semantics for the workboard entry path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingNavigationController } from '../../dist/src/tracking/selection.mjs';
import { issueKey } from '../../dist/src/tracking/gitea.mjs';
import { REPO, detail, fixturePorts, page, tracked } from '../tracking-navigation/fixtures.mjs';

function controller(overrides = {}) {
  const ports = fixturePorts({ pages: [page([tracked(1), tracked(2)])], details: { 1: detail(1), 2: detail(2) }, ...overrides });
  return { nav: new TrackingNavigationController({ repo: REPO, ports }), ports };
}

test('selectIssue binds identity directly, marks the board entry, and back() from detail exits', async () => {
  const { nav } = controller();
  assert.equal(nav.getEntry(), 'list');
  assert.equal(nav.selectIssue(tracked(2)), 'applied');
  assert.equal(nav.getEntry(), 'board');
  const state = nav.getState();
  assert.equal(state.selectedKey, issueKey(REPO, 2));
  assert.equal(state.selectedNumber, 2);
  assert.equal(state.selectedTitle, 'Issue 2 title');
  assert.equal(await nav.openDetail(), 'applied');
  assert.equal(nav.getState().view, 'detail');
  assert.equal(nav.back(), 'exit');
  assert.equal(nav.getState().view, 'list');
});

test('selectIssue clears a previous selection, detail and preview', async () => {
  const { nav } = controller();
  await nav.openList();
  nav.moveCursor(0);
  assert.equal(nav.select(), 'applied');
  assert.equal(await nav.openDetail(), 'applied');
  assert.ok(nav.getState().detail);
  assert.equal(nav.selectIssue(tracked(2)), 'applied');
  const state = nav.getState();
  assert.equal(state.detail, undefined);
  assert.equal(state.expansion, undefined);
  assert.equal(state.requestReady, false);
  assert.equal(state.selectedNumber, 2);
  assert.ok(state.blockers.includes('issue detail was never read'));
});

test('selectIssue refuses an unusable number', () => {
  const { nav } = controller();
  assert.equal(nav.selectIssue(tracked(0)), 'refused');
  assert.equal(nav.selectIssue(tracked(-3)), 'refused');
  assert.equal(nav.selectIssue({ ...tracked(1), number: 'x' }), 'refused');
  assert.equal(nav.getState().selectedKey, undefined);
  assert.equal(nav.getEntry(), 'list');
});

test('the list path keeps returning "list" from detail, and openList/select reset the entry', async () => {
  const { nav } = controller();
  nav.selectIssue(tracked(2));
  assert.equal(nav.getEntry(), 'board');
  await nav.openList();
  assert.equal(nav.getEntry(), 'list');
  nav.selectIssue(tracked(2));
  nav.moveCursor(0);
  assert.equal(nav.select(), 'applied');
  assert.equal(nav.getEntry(), 'list');
  assert.equal(await nav.openDetail(), 'applied');
  assert.equal(nav.back(), 'list');
  assert.equal(nav.getState().view, 'list');
});
