import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionCommand, parseCompanionProcessInfo, parsePaneInfoOutput, parsePaneListOutput, parseSplitOutput } from '../../dist/src/coordinatr/layout.mjs';

function response(tabId, paneId = 'w8:pT', workspaceId = 'w8') {
  return JSON.stringify({ result: { type: 'pane_current', pane: {
    pane_id: paneId, workspace_id: workspaceId, tab_id: tabId,
    terminal_id: 'term_0123456789abcd', cwd: '/project', focused: true,
  } } });
}

test('current/get accepts Herdr alphanumeric workspace, tab and pane suffixes', () => {
  for (const [workspaceId, tabId, paneId] of [
    ['w8', 'w8:tJ', 'w8:pT'],
    ['w8', 'w8:t1A', 'w8:pT'],
    ['wR', 'wR:t1', 'wR:p1'],
    ['wAlpha2', 'wAlpha2:ta', 'wAlpha2:pZ9'],
  ]) {
    const pane = parsePaneInfoOutput(response(tabId, paneId, workspaceId));
    assert.equal(pane?.workspaceId, workspaceId);
    assert.equal(pane?.paneId, paneId);
    assert.equal(pane?.tabId, tabId);
  }
});

test('companion launcher keeps an alphanumeric source pane binding', () => {
  const command = buildCompanionCommand('/entry.mjs', '/tracking.json', '/state', 'wR:p1', '/repo', '/sessions/main.jsonl');
  assert.ok(command.includes("--pi-pane 'wR:p1'"));
  assert.equal(buildCompanionCommand('/entry.mjs', undefined, undefined, 'bad:p1'), undefined);
  assert.equal(buildCompanionCommand('/entry.mjs', undefined, undefined, 'wR:p1\n'), undefined);
  assert.equal(buildCompanionCommand('/entry.mjs', '/tracking.json', '/state', 'wR:p1', '/repo', undefined), undefined);
  for (const required of ['--state-dir', '--project-cwd', '--pi-pane', '--pi-session']) assert.ok(command.includes(required));
});

test('split response accepts alphabetic tabs without accepting the source pane', () => {
  assert.equal(parseSplitOutput(response('w8:tJ', 'w8:pU'), 'w8:pT')?.tabId, 'w8:tJ');
  assert.equal(parseSplitOutput(response('w8:tJ'), 'w8:pT'), undefined);
});

test('bounded pane discovery and live companion argv require exact runtime arguments', () => {
  const panes = JSON.stringify({ result: { panes: [
    { pane_id: 'wR:p1', workspace_id: 'wR', tab_id: 'wR:t1', cwd: '/repo' },
    { pane_id: 'wX:p2', workspace_id: 'wX', tab_id: 'wX:t2', cwd: '/other' },
  ] } });
  assert.deepEqual(parsePaneListOutput(panes, 'wR').map((p) => p.paneId), ['wR:p1']);
  assert.equal(parsePaneListOutput(JSON.stringify({ result: { panes: Array(33).fill({}) } }), 'wR'), undefined);
  const argv = ['node', '/pkg/dist/src/companion/spike.mjs', 'demo', '--state-dir', '/state', '--project-cwd', '/repo', '--pi-pane', 'wR:p1', '--pi-session', '/session.jsonl'];
  assert.deepEqual(parseCompanionProcessInfo(JSON.stringify({ result: { process: { argv } } })), {
    entry: '/pkg/dist/src/companion/spike.mjs', stateDir: '/state', projectCwd: '/repo', piPane: 'wR:p1', piSession: '/session.jsonl',
  });
  assert.equal(parseCompanionProcessInfo(JSON.stringify({ result: { process: { argv: argv.filter((v) => v !== '--state-dir') } } })), undefined);
  assert.equal(parseCompanionProcessInfo(JSON.stringify({ result: { process: { argv: argv.map((v) => v === '/session.jsonl' ? 'relative.jsonl' : v) } } })), undefined);
  assert.equal(parseCompanionProcessInfo(JSON.stringify({ result: { process: { argv: ['node', '/fake/spike.mjs', 'other'] } } })), undefined);
});

test('malformed or mismatched Herdr identities remain rejected', () => {
  for (const tabId of ['', 'w8:t', 'w8:tJ!', 'w8:tJ extra', 'w8:pJ', 'x8:tJ']) {
    assert.equal(parsePaneInfoOutput(response(tabId)), undefined);
    assert.equal(parseSplitOutput(response(tabId), 'w8:pS'), undefined);
  }
  assert.equal(parsePaneInfoOutput(response('wR:t1', 'w8:pT', 'wR')), undefined);
  assert.equal(parsePaneInfoOutput(response('w8:t1', 'wR:p1', 'wR')), undefined);
  assert.equal(parsePaneInfoOutput(response('wR:t1', 'wR:p1', 'w!')), undefined);
});
