import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCoordinatr, createRuntime, resolveCompanionEntry } from '../../dist/src/extension/coordinatr.mjs';
import { projectPaths } from '../../dist/src/state/paths.mjs';

const pane = (id, tab = 'wR:t1') => ({ pane_id: id, workspace_id: 'wR', tab_id: tab, terminal_id: `term-${id}`, cwd: '/work/promptr' });
const envelope = (record) => JSON.stringify({ result: { pane: record } });

function host(exec) {
  let handler;
  return {
    pi: {
      exec,
      on() {},
      registerCommand(_name, command) { handler = command.handler; },
    },
    run: (...args) => handler(...args),
  };
}

function context(notices, sessionFile = '/sessions/main.jsonl') {
  return {
    cwd: '/work/promptr', mode: 'tui',
    ui: { notify: (text) => notices.push(text), setStatus() {} },
    sessionManager: {
      getSessionId: () => 'session-id', getLeafId: () => 'leaf-id',
      getSessionFile: () => sessionFile,
    },
  };
}

test('fresh extension runtimes discover and reuse one exact-workspace live companion', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const notices = [];
  let launched = false;
  let splits = 0;
  let runs = 0;
  let focuses = 0;
  const focusTargets = [];
  const entry = resolveCompanionEntry();
  const stateDir = projectPaths('/work/promptr').dir;
  const exec = async (_command, args) => {
    if (args[0] === 'workspace' && args[1] === 'list') return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'wR', label: 'promptr' }] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: launched ? [pane('wR:p2', 'wR:t2')] : [] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'process-info') return { stdout: JSON.stringify({ result: { process: { argv: ['node', entry, 'demo', '--state-dir', stateDir, '--project-cwd', '/work/promptr', '--pi-pane', 'wR:p1', '--pi-session', '/sessions/main.jsonl'] } } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'current') return { stdout: envelope(pane('wR:p1')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'split') { splits++; return { stdout: envelope(pane('wR:p2', 'wR:t2')), stderr: '', code: 0, killed: false }; }
    if (args[0] === 'pane' && args[1] === 'run') { runs++; launched = true; return { stdout: '{}', stderr: '', code: 0, killed: false }; }
    if (args[0] === 'pane' && args[1] === 'focus') { focuses++; focusTargets.push(args[args.indexOf('--pane') + 1]); return { stdout: '{}', stderr: '', code: 0, killed: false }; }
    return { stdout: '{}', stderr: '', code: 0, killed: false };
  };
  try {
    const first = host(exec); registerCoordinatr(first.pi, createRuntime()); await first.run('', context(notices));
    const second = host(exec); const runtime = registerCoordinatr(second.pi, createRuntime()); await second.run('', context(notices));
    assert.equal(splits, 1);
    assert.equal(runs, 1);
    assert.equal(focuses, 1);
    assert.deepEqual(focusTargets, ['wR:p2'], 'the exact discovered pane is the focus target');
    assert.equal(runtime.binding?.paneId, 'wR:p2');
    assert.equal(runtime.binding?.trackingName, 'prompt-coord');
    assert.match(notices.at(-1), /reuses right pane wR:p2/);
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('missing Pi session file causes no Herdr call, split, or companion launch', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const calls = []; const notices = [];
  try {
    const h = host(async (_command, args) => { calls.push(args); return { stdout: '{}', stderr: '', code: 0, killed: false }; });
    registerCoordinatr(h.pi, createRuntime());
    await h.run('', context(notices, null));
    assert.deepEqual(calls, []);
    assert.match(notices.at(-1), /session\/state binding.*No split/i);
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('launch failure records no reusable binding and every attempted launcher has complete rediscovery argv', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const notices = []; const launchers = [];
  const exec = async (_command, args) => {
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'wR', label: 'promptr' }] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'current') return { stdout: envelope(pane('wR:p1')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'split') return { stdout: envelope(pane('wR:p2', 'wR:t2')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'run') { launchers.push(args[3]); return { stdout: '', stderr: 'failed', code: 1, killed: false }; }
    return { stdout: '{}', stderr: '', code: 0, killed: false };
  };
  try {
    const h = host(exec); const runtime = registerCoordinatr(h.pi, createRuntime());
    await h.run('', context(notices));
    assert.equal(runtime.binding, undefined);
    assert.equal(runtime.state, 'awaiting-recovery');
    assert.equal(launchers.length, 1);
    for (const flag of ['--state-dir', '--project-cwd', '--pi-pane', '--pi-session']) assert.match(launchers[0], new RegExp(flag));
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('ensure does not reuse an in-memory pane after its foreground process is replaced', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const notices = []; let processChecks = 0; let runs = 0;
  const exec = async (_command, args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { stdout: envelope(pane('wR:p2', 'wR:t2')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'process-info') { processChecks++; return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ['bash'] }] } } }), stderr: '', code: 0, killed: false }; }
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'wR', label: 'promptr' }] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'current') return { stdout: envelope(pane('wR:p1')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'split') return { stdout: envelope(pane('wR:p3', 'wR:t3')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'run') { runs++; return { stdout: '{}', stderr: '', code: 0, killed: false }; }
    return { stdout: '{}', stderr: '', code: 0, killed: false };
  };
  try {
    const runtime = createRuntime();
    runtime.binding = { paneId: 'wR:p2', workspaceId: 'wR', tabId: 'wR:t2', terminalId: 'term-wR:p2', sessionId: 'session-id', leafId: 'leaf-id', nonce: runtime.nonce, createdAt: 1 };
    const h = host(exec); registerCoordinatr(h.pi, runtime);
    await h.run('', context(notices));
    assert.equal(processChecks, 1);
    assert.equal(runs, 1);
    assert.equal(runtime.binding?.paneId, 'wR:p3');
    assert.equal(notices.some((notice) => /reuses right pane wR:p2/.test(notice)), false);
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('recover rejects pane process replacement despite identical pane identity', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const notices = []; let processChecks = 0;
  const exec = async (_command, args) => {
    if (args[0] === 'pane' && args[1] === 'get') return { stdout: envelope(pane('wR:p2', 'wR:t2')), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'process-info') { processChecks++; return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ['bash'] }] } } }), stderr: '', code: 0, killed: false }; }
    return { stdout: '{}', stderr: '', code: 0, killed: false };
  };
  try {
    const runtime = createRuntime();
    runtime.binding = { paneId: 'wR:p2', workspaceId: 'wR', tabId: 'wR:t2', terminalId: 'term-wR:p2', sessionId: 'session-id', leafId: 'leaf-id', nonce: runtime.nonce, createdAt: 1 };
    const h = host(exec); registerCoordinatr(h.pi, runtime);
    await h.run('recover', context(notices));
    assert.equal(processChecks, 1, 'process-info is mandatory');
    assert.equal(runtime.binding, undefined, 'replaced process cannot remain a send target');
    assert.equal(runtime.state, 'awaiting-recovery');
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('a valid same-workspace companion for another source blocks duplicates without redirecting', async () => {
  const old = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: process.env.HERDR_TAB_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'wR:p1', HERDR_WORKSPACE_ID: 'wR', HERDR_TAB_ID: 'wR:t1' });
  const notices = [];
  let splits = 0; let runs = 0; let focuses = 0; const focusTargets = [];
  const entry = resolveCompanionEntry();
  const otherState = projectPaths('/work/other').dir;
  const exec = async (_command, args) => {
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ result: { workspaces: [{ workspace_id: 'wR', label: 'promptr' }] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ result: { panes: [{ ...pane('wR:p2', 'wR:t2'), tokens: { agent: 'prompt-coord' } }] } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'process-info') return { stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: ['node', entry, 'demo', '--state-dir', otherState, '--project-cwd', '/work/other', '--pi-pane', 'wR:p9', '--pi-session', '/sessions/other.jsonl'] }] } } }), stderr: '', code: 0, killed: false };
    if (args[0] === 'pane' && args[1] === 'focus') { focuses++; focusTargets.push(args[args.indexOf('--pane') + 1]); return { stdout: '{}', stderr: '', code: 0, killed: false }; }
    if (args[0] === 'pane' && args[1] === 'split') splits++;
    if (args[0] === 'pane' && args[1] === 'run') runs++;
    return { stdout: '{}', stderr: '', code: 0, killed: false };
  };
  try {
    const h = host(exec); const runtime = registerCoordinatr(h.pi, createRuntime());
    await h.run('', context(notices));
    assert.equal(splits, 0); assert.equal(runs, 0); assert.equal(focuses, 1);
    assert.deepEqual(focusTargets, ['wR:p2']);
    assert.equal(runtime.binding, undefined, 'another source never becomes the send target');
    assert.match(notices.at(-1), /another source\/project.*no duplicate created.*not redirected/i);
  } finally {
    for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
