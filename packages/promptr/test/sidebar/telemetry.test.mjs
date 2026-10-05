import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  attachSidebarTelemetry, reconstructTodos, STATUS_SOURCE_GAP_ALERT, todosFromToolResult, unavailableTelemetrySnapshot,
} from '../../dist/src/sidebar/telemetry.mjs';
import { openPromptrUsage, usageDecimals } from '../../dist/src/sidebar/usage-dialog.mjs';
import { defaultPromptrPanelLayout, renderPromptrSidebar } from '../../dist/src/sidebar/atelier-adapter.mjs';
import { SUBAGENT_METADATA_ENTRY } from '../../dist/src/sidebar/vendor/atelier/subagent-usage.mjs';

const theme = { fg: (_color, value) => value, bold: value => value, italic: value => value };
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UI_SETTERS = ['setFooter', 'setEditorComponent', 'setHeader', 'setWidget', 'setStatus', 'setWorkingMessage',
  'setWorkingIndicator', 'setWorkingVisible', 'setTitle', 'setToolsExpanded', 'setHiddenThinkingLabel'];

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-telemetry-'));
  const temp = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, 'subagents-temp');
  t.after(() => {
    if (temp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = temp;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const gitExec = (command, args, options = {}) => new Promise(resolve => {
  execFile(command, args, { cwd: options.cwd, timeout: options.timeout }, (error, stdout, stderr) =>
    resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      killed: Boolean(error?.killed) }));
});

function fakePi({ exec = gitExec, entries = [] } = {}) {
  const handlers = new Map();
  const bus = new Map();
  const calls = { exec: [], on: [], appendEntry: [] };
  const pi = {
    on(event, handler) {
      calls.on.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => { const current = handlers.get(event) ?? []; const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); };
    },
    events: {
      on(channel, handler) {
        const list = bus.get(channel) ?? []; list.push(handler); bus.set(channel, list);
        return () => { const current = bus.get(channel) ?? []; const index = current.indexOf(handler); if (index >= 0) current.splice(index, 1); };
      },
      emit(channel, data) { for (const handler of [...(bus.get(channel) ?? [])]) handler(data); },
    },
    getActiveTools: () => ['read', 'bash', 'todo'],
    getAllTools: () => [{ name: 'read' }, { name: 'bash' }, { name: 'todo' }, { name: 'edit' }],
    getThinkingLevel: () => 'high',
    appendEntry(customType, data) { calls.appendEntry.push(customType); entries.push({ type: 'custom', customType, data }); },
    exec: async (command, args, options) => { calls.exec.push([command, ...args].join(' ')); return exec(command, args, options); },
  };
  const emit = async (event, payload, ctx) => {
    for (const handler of [...(handlers.get(event) ?? [])]) await handler({ type: event, ...payload }, ctx);
  };
  const count = event => (handlers.get(event) ?? []).length;
  return { pi, calls, emit, count, bus: pi.events };
}

function fakeCtx({ root, trusted = true, entries = [], branch, sessionId = 'session-a', context } = {}) {
  const uiCalls = [];
  const base = { notify: (message, level) => uiCalls.push(`notify:${level}:${message}`), custom: undefined };
  const ui = new Proxy(base, { get: (target, name) => target[name] ?? ((..._args) => { uiCalls.push(String(name)); }) });
  const state = { trusted, idle: true, context: context ?? { tokens: 12_000, contextWindow: 200_000, percent: 6 } };
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionFile: () => path.join(root, 'sessions', `${sessionId}.jsonl`),
    getSessionName: () => 'fixture session',
    getEntries: () => entries,
    getBranch: () => branch?.() ?? entries,
  };
  const ctx = {
    cwd: root, mode: 'tui', hasUI: true, ui, sessionManager,
    model: { id: 'example-model', provider: 'example-provider' },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => state.context,
    isProjectTrusted: () => state.trusted,
    isIdle: () => state.idle,
  };
  return { ctx, state, uiCalls, entries };
}

const assistant = (output, cost, extra = {}) => ({ type: 'message', message: { role: 'assistant', content: [],
  usage: { input: 100, output, cacheRead: 10, cacheWrite: 5, cost: { total: cost } }, stopReason: 'stop', ...extra } });
const todoResult = (details, isError = false) => ({ type: 'message', message: { role: 'toolResult', toolName: 'todo', isError, details, content: [] } });
const attach = (pi, ctx, extra = {}) => attachSidebarTelemetry({ pi, ctx, autoCompact: true,
  inspectWorkspace: async () => ({ kind: 'unavailable' }), ...extra });

test('agent, activity, timing, output speed, context and tools come from observed events', async t => {
  const root = tempRoot(t);
  const { pi, emit } = fakePi();
  const { ctx, state } = fakeCtx({ root, context: { tokens: null, contextWindow: 200_000, percent: null } });
  let clock = 10_000;
  t.mock.method(Date, 'now', () => clock);
  const telemetry = attach(pi, ctx);
  let renders = 0;
  telemetry.subscribe(() => renders++);
  let snap = telemetry.snapshot();
  assert.equal(snap.modelId, 'example-model');
  assert.equal(snap.provider, 'example-provider');
  assert.equal(snap.thinkingLevel, 'high');
  assert.equal(snap.metrics.subscription, true);
  // Unknown context stays unknown; cumulative usage is not substituted.
  assert.equal(snap.metrics.contextTokens, null);
  assert.equal(snap.metrics.contextPercent, null);
  assert.equal(snap.activeToolCount, 3);
  assert.equal(snap.availableToolCount, 4);
  assert.deepEqual([...snap.activeToolNames], ['bash', 'read', 'todo']);

  await emit('agent_start', {}, ctx);
  state.idle = false;
  await emit('turn_start', { turnIndex: 0, timestamp: clock }, ctx);
  await emit('before_provider_request', { payload: {} }, ctx);
  clock += 300;
  await emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'streamed words '.repeat(20) }] } }, ctx);
  clock += 1000;
  await emit('message_end', { message: assistant(50, 0.01).message }, ctx);
  await emit('tool_execution_start', { toolCallId: 'a', toolName: 'read', args: { path: path.join(root, 'src/a.ts') } }, ctx);
  await emit('tool_execution_start', { toolCallId: 'b', toolName: 'bash', args: { command: 'npm test' } }, ctx);
  snap = telemetry.snapshot();
  assert.equal(snap.activity, 'working');
  assert.ok(snap.workingLabel);
  assert.equal(snap.runActivity.turnNumber, 1);
  assert.equal(snap.runActivity.performance.ttftMs, 300);
  assert.equal(snap.runActivity.performance.tokensPerSecond, 50);
  assert.deepEqual(snap.runActivity.activeTools.map(tool => [tool.id, tool.name, tool.summary]),
    [['a', 'read', 'src/a.ts'], ['b', 'bash', 'npm test']]);
  // Parallel calls: ending one leaves the other active.
  clock += 200;
  await emit('tool_execution_end', { toolCallId: 'a', toolName: 'read', result: {}, isError: false }, ctx);
  snap = telemetry.snapshot();
  assert.deepEqual(snap.runActivity.activeTools.map(tool => tool.id), ['b']);
  assert.deepEqual(snap.runActivity.recentTools.map(tool => [tool.id, tool.status, tool.durationMs]), [['a', 'done', 200]]);
  await emit('tool_execution_end', { toolCallId: 'b', toolName: 'bash', result: {}, isError: true }, ctx);
  state.idle = true;
  state.context = { tokens: 30_000, contextWindow: 200_000, percent: 15 };
  await emit('turn_end', { turnIndex: 0 }, ctx);
  await emit('agent_settled', {}, ctx);
  snap = telemetry.snapshot();
  assert.equal(snap.activity, 'ready');
  assert.equal(snap.runActivity.phase, 'settled');
  assert.equal(snap.runActivity.failedCount, 1);
  assert.equal(snap.metrics.contextTokens, 30_000);
  assert.equal(snap.metrics.contextPercent, 15);
  assert.ok(renders > 0);
  // Model and thinking changes refresh the agent panel.
  ctx.model = { id: 'second-model', provider: 'second-provider' };
  await emit('model_select', { model: ctx.model, source: 'set' }, ctx);
  assert.equal(telemetry.snapshot().modelId, 'second-model');
  telemetry.dispose();
});

test('TODOs follow the active branch; a valid empty list clears; failed or malformed updates keep state', async t => {
  const root = tempRoot(t);
  const first = [todoResult({ action: 'add', todos: [{ id: 1, text: 'Write tests', done: false }, { id: 2, text: 'Ship', done: true }], nextId: 3 })];
  const other = [...first, todoResult({ action: 'clear', todos: [], nextId: 1 })];
  let branch = first;
  const { pi, emit } = fakePi();
  const { ctx } = fakeCtx({ root, entries: other, branch: () => branch });
  const telemetry = attach(pi, ctx);
  assert.deepEqual(telemetry.snapshot().todos.map(todo => [todo.id, todo.status]), [[1, 'pending'], [2, 'completed']]);
  await emit('message_end', { message: todoResult({ action: 'add', error: 'text required' }, true).message }, ctx);
  await emit('message_end', { message: todoResult({ todos: [{ id: 'x' }] }).message }, ctx);
  await emit('message_end', { message: todoResult('not details').message }, ctx);
  assert.equal(telemetry.snapshot().todos.length, 2);
  await emit('message_end', { message: todoResult({ tasks: [{ id: 7, subject: 'rpiv task', status: 'in_progress' }] }).message }, ctx);
  assert.deepEqual(telemetry.snapshot().todos.map(todo => [todo.id, todo.text, todo.status]), [[7, 'rpiv task', 'in_progress']]);
  branch = other;
  await emit('session_tree', { newLeafId: 'x', oldLeafId: 'y' }, ctx);
  assert.deepEqual(telemetry.snapshot().todos, []);
  branch = first;
  await emit('session_tree', { newLeafId: 'y', oldLeafId: 'x' }, ctx);
  assert.equal(telemetry.snapshot().todos.length, 2);
  // Pure helpers used for reconstruction.
  assert.equal(todosFromToolResult({ role: 'toolResult', toolName: 'other', details: { todos: [] } }), undefined);
  assert.deepEqual(reconstructTodos([...first, todoResult({ todos: 'broken' })]).length, 2);
  telemetry.dispose();
});

test('failed or malformed TODO updates are rejected whole and never replace a valid list', async t => {
  const root = tempRoot(t);
  const valid = [{ id: 1, text: 'Keep me', done: false }, { id: 2, text: 'Done', done: true }];
  const entries = [todoResult({ action: 'add', todos: valid, nextId: 3 })];
  const { pi, emit } = fakePi({ entries });
  const { ctx } = fakeCtx({ root, entries });
  const telemetry = attach(pi, ctx);
  const current = () => telemetry.snapshot().todos.map(todo => [todo.id, todo.text, todo.status]);
  const expected = [[1, 'Keep me', 'pending'], [2, 'Done', 'completed']];
  assert.deepEqual(current(), expected);
  const rejected = [
    // Pi's example todo tool reports failure through details.error without isError; the list differs here.
    { action: 'toggle', todos: [{ id: 9, text: 'Wrong list', done: false }], nextId: 10, error: 'id required' },
    { action: 'clear', todos: [], nextId: 1, error: 'failed' },
    // One invalid rpiv status rejects the whole update instead of clearing or partly replacing.
    { tasks: [{ id: 5, subject: 'valid', status: 'pending' }, { id: 6, subject: 'bad', status: 'odd' }] },
    { tasks: [{ id: 6, subject: 'only bad', status: 'blocked' }] },
    // Non-finite and non-integer IDs are malformed.
    { todos: [{ id: Number.NaN, text: 'nan', done: false }] },
    { todos: [{ id: Number.POSITIVE_INFINITY, text: 'inf', done: false }] },
    { tasks: [{ id: 1.5, subject: 'fraction', status: 'pending' }] },
    { todos: [{ id: '1', text: 'string id', done: false }] },
  ];
  for (const details of rejected) {
    assert.equal(todosFromToolResult(todoResult(details).message), undefined, JSON.stringify(details));
    await emit('message_end', { message: todoResult(details).message }, ctx);
    assert.deepEqual(current(), expected, JSON.stringify(details));
  }
  // Branch reconstruction skips the same failed entries.
  const branchWithFailures = [...entries, ...rejected.map(details => todoResult(details))];
  assert.deepEqual(reconstructTodos(branchWithFailures).map(todo => todo.text), ['Keep me', 'Done']);
  // A successful update with no error field still replaces the list; a null error is not a failure.
  await emit('message_end', { message: todoResult({ action: 'toggle', todos: [{ id: 1, text: 'Keep me', done: true }], nextId: 3, error: null }).message }, ctx);
  assert.deepEqual(current(), [[1, 'Keep me', 'completed']]);
  telemetry.dispose();
});

test('Git inspection: trusted repo, untrusted, non-repository and stale states never read file contents', async t => {
  const root = tempRoot(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'f@x'], ['config', 'user.name', 'f']]) await gitExec('git', ['-C', repo, ...args]);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  await gitExec('git', ['-C', repo, 'add', '.']);
  await gitExec('git', ['-C', repo, 'commit', '-qm', 'base']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'untracked-secret.txt'), 'SECRET-CONTENT\n');

  const trusted = fakePi();
  const a = fakeCtx({ root: repo });
  const live = attachSidebarTelemetry({ pi: trusted.pi, ctx: a.ctx, autoCompact: null });
  await trusted.emit('turn_end', { turnIndex: 0 }, a.ctx);
  for (let i = 0; i < 50 && live.snapshot().workspacePulse.status === 'inspecting'; i++) await sleep(20);
  let snap = live.snapshot();
  assert.equal(snap.workspacePulse.status, 'changed');
  assert.equal(snap.branch, 'main');
  assert.equal(snap.workspacePulse.data.snapshot.trackedFiles, 1);
  assert.equal(snap.workspacePulse.data.snapshot.untrackedFiles, 1);
  assert.equal(snap.workspacePulse.data.snapshot.linesAdded, 1);
  assert.ok(trusted.calls.exec.length > 0);
  for (const command of trusted.calls.exec) assert.match(command, /^git (rev-parse|-C \S+ (status --porcelain=v2|rev-parse --verify|diff --numstat))/);
  assert.ok(!JSON.stringify(snap).includes('SECRET-CONTENT'));
  assert.equal(live.sources().workspace, 'available');
  assert.equal(live.sources().autoCompact, 'unavailable');

  live.dispose();

  // Untrusted: no Git process at all, explicit untrusted source and alert.
  const blocked = fakePi();
  const u = fakeCtx({ root: repo, trusted: false });
  const untrusted = attachSidebarTelemetry({ pi: blocked.pi, ctx: u.ctx, autoCompact: true });
  await blocked.emit('turn_start', { turnIndex: 0 }, u.ctx);
  await blocked.emit('turn_end', { turnIndex: 0 }, u.ctx);
  await sleep(400);
  assert.deepEqual(blocked.calls.exec, []);
  assert.equal(untrusted.snapshot().workspacePulse.status, 'unavailable');
  assert.equal(untrusted.sources().workspace, 'untrusted');
  assert.ok(untrusted.snapshot().extensionStatuses.some(line => /Untrusted project/.test(line)));
  untrusted.dispose();

  // Non-repository directory.
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const n = fakePi();
  const nonRepo = attachSidebarTelemetry({ pi: n.pi, ctx: fakeCtx({ root: plain }).ctx, autoCompact: true });
  for (let i = 0; i < 50 && nonRepo.snapshot().workspacePulse.status === 'inspecting'; i++) await sleep(20);
  assert.equal(nonRepo.snapshot().workspacePulse.status, 'not-repo');
  nonRepo.dispose();
});

test('stale workspace data is kept and marked stale after a failed refresh', async t => {
  const root = tempRoot(t);
  const { pi, emit } = fakePi();
  const { ctx } = fakeCtx({ root });
  const data = { root, relativeCwd: '', branch: 'main', snapshot: { trackedFiles: 0, untrackedFiles: 0, linesAdded: 0, linesRemoved: 0, binaryFiles: 0, submodules: 0, conflicts: 0 } };
  let next = { kind: 'available', ...data };
  const telemetry = attach(pi, ctx, { inspectWorkspace: async () => next });
  for (let i = 0; i < 50 && telemetry.snapshot().workspacePulse.status === 'inspecting'; i++) await sleep(10);
  assert.equal(telemetry.snapshot().workspacePulse.status, 'clean');
  next = { kind: 'unavailable' };
  await emit('turn_end', { turnIndex: 0 }, ctx);
  for (let i = 0; i < 50 && telemetry.snapshot().workspacePulse.status === 'clean'; i++) await sleep(10);
  assert.equal(telemetry.snapshot().workspacePulse.status, 'stale');
  assert.equal(telemetry.snapshot().workspacePulse.data.branch, 'main');
  telemetry.dispose();
});

function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }

test('subagent accounting: session ownership, dedup, partial data, same-millisecond replies and separate totals', async t => {
  const root = tempRoot(t);
  const artifacts = path.join(root, '.pi', 'subagents', 'artifacts');
  const asyncRoot = path.join(root, 'async');
  const sessionFile = path.join(root, 'sessions', 'session-a.jsonl');
  // Child A: complete, priced, with an events history that includes two replies in the same millisecond.
  writeJson(path.join(artifacts, 'run-a_scout_meta.json'), { runId: 'run-a', agent: 'scout', model: 'second-model',
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.3 }, timestamp: 5 });
  writeJson(path.join(asyncRoot, 'run-a', 'status.json'), { runId: 'run-a', sessionId: sessionFile, state: 'complete', startedAt: 1000,
    steps: [{ agent: 'scout', startedAt: 1000, status: 'complete' }] });
  const reply = (at, cost, timestamp) => JSON.stringify({ type: 'message_end', subagentSource: 'child', subagentRunId: 'run-a',
    subagentStepIndex: 0, subagentAgent: 'scout', observedAt: at, message: { role: 'assistant', timestamp, usage: { cost: { total: cost } } } });
  fs.writeFileSync(path.join(asyncRoot, 'run-a', 'events.jsonl'),
    [reply(2000, 0.1, 1), reply(2000, 0.1, 1), reply(2000, 0.1, 2), reply(3000, 0.1, 3)].join('\n') + '\n');
  // Child B: metadata without cost (unpriced, not zero-cost).
  writeJson(path.join(artifacts, 'run-b_worker_meta.json'), { runId: 'run-b', agent: 'worker', usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 } });
  // Foreign session: status owned by another session is never followed.
  writeJson(path.join(asyncRoot, 'run-f', 'status.json'), { runId: 'run-f', sessionId: 'someone-else', state: 'complete', steps: [] });
  writeJson(path.join(artifacts, 'run-x_ghost_meta.json'), { runId: 'run-x', agent: 'ghost', usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 99 } });

  const entries = [
    assistant(40, 0.05),
    { type: 'custom', customType: SUBAGENT_METADATA_ENTRY, data: { runIds: ['run-a', 'run-b', 'run-f', 'run-missing'],
      paths: [path.join(artifacts, 'run-a_scout_meta.json')], asyncDirs: [path.join(asyncRoot, 'run-a'), path.join(asyncRoot, 'run-f')] } },
    // A subagent tool result carrying nested usage must not change main-agent totals.
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent', isError: false, content: [], details: { runId: 'run-a' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } } } },
  ];
  const { pi, bus } = fakePi({ entries });
  const { ctx } = fakeCtx({ root, entries });
  const telemetry = attach(pi, ctx);
  await telemetry.refreshSubagentUsage();
  const usage = telemetry.subagentUsage();
  assert.deepEqual(usage.runs.map(run => [run.runId, run.agent, run.cost, run.pricedRuns]).sort(),
    [['run-a', 'scout', 0.3, 1], ['run-b', 'worker', 0, 0]]);
  assert.equal(usage.runs.filter(run => run.runId === 'run-a').length, 1, 'metadata referenced by path and scan counts once');
  assert.ok(!usage.runs.some(run => run.runId === 'run-x'), 'unreferenced artifacts are ignored');
  assert.equal(usage.totals.pricedRuns, 1);
  assert.ok(usage.unavailable >= 2, 'missing and foreign references are partial, not zero');
  const series = usage.costHistory.find(item => item.runId === 'run-a');
  assert.deepEqual(series.points.map(point => [point.at, Number(point.cost.toFixed(2))]), [[1000, 0], [2000, 0.1], [2000, 0.2], [3000, 0.3]]);
  // Main-agent usage stays separate from child accounting.
  const snap = telemetry.snapshot();
  assert.equal(snap.metrics.cost, 0.05);
  assert.equal(snap.metrics.output, 40);
  assert.equal(snap.subagentUsage.totals.cost, 0.3);

  // Wrong-session lifecycle events are rejected before any accounting read.
  const before = entries.length;
  bus.emit('subagent:async-complete', { sessionId: 'another-session', runId: 'run-z', asyncDir: path.join(asyncRoot, 'run-z') });
  assert.equal(entries.length, before);
  bus.emit('subagent:async-complete', { sessionId: sessionFile, runId: 'run-c', asyncDir: path.join(asyncRoot, 'run-c') });
  assert.equal(entries.length, before + 1);
  assert.deepEqual(entries.at(-1).data, { runIds: ['run-c'], paths: [], asyncDirs: [path.join(asyncRoot, 'run-c')] });
  assert.equal(entries.at(-1).customType, 'pi-atelier:subagent-metadata');
  telemetry.dispose();
});

test('active-run accounting refresh stops at dispose and late reads never publish', async t => {
  const root = tempRoot(t);
  const asyncRoot = path.join(root, 'async');
  const sessionFile = path.join(root, 'sessions', 'session-a.jsonl');
  const running = runId => ({ runId, sessionId: sessionFile, state: 'running', startedAt: 1, steps: [{ agent: 'worker', startedAt: 1, status: 'running' }] });
  writeJson(path.join(asyncRoot, 'run-p', 'status.json'), running('run-p'));
  writeJson(path.join(asyncRoot, 'run-q', 'status.json'), running('run-q'));
  const refs = runId => [{ type: 'custom', customType: SUBAGENT_METADATA_ENTRY, data: { runIds: [runId], paths: [], asyncDirs: [path.join(asyncRoot, runId)] } }];
  const retiredEntries = refs('run-p');
  const liveEntries = refs('run-q');
  const retired = attach(fakePi({ entries: retiredEntries }).pi, fakeCtx({ root, entries: retiredEntries }).ctx);
  const control = attach(fakePi({ entries: liveEntries }).pi, fakeCtx({ root, entries: liveEntries }).ctx);
  await retired.refreshSubagentUsage();
  await control.refreshSubagentUsage();
  assert.equal(retired.subagentUsage().pending, 1);
  assert.equal(control.subagentUsage().pending, 1);
  let notified = 0;
  retired.subscribe(() => notified++);
  retired.dispose();
  // Count real accounting opens per run while the 1.5 s pending refresh would fire.
  const opened = [];
  const realOpen = fsp.open;
  t.mock.method(fsp, 'open', (file, ...rest) => { opened.push(String(file)); return realOpen(file, ...rest); });
  syncBuiltinESMExports();
  try { await sleep(1800); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(opened.some(file => file.includes(`${path.sep}run-q${path.sep}`)), 'control session keeps refreshing');
  assert.ok(!opened.some(file => file.includes(`${path.sep}run-p${path.sep}`)), 'retired session reads nothing');
  assert.equal(notified, 0);
  assert.deepEqual(retired.snapshot(), unavailableTelemetrySnapshot(root));
  assert.equal(retired.subagentUsage().runs.length, 0);
  control.dispose();
});

test('late async completions cannot repaint a retired session', async t => {
  const root = tempRoot(t);
  const { pi, emit, count } = fakePi();
  let resolveA;
  const a = fakeCtx({ root, sessionId: 'session-a', entries: [todoResult({ todos: [{ id: 1, text: 'A only', done: false }] })] });
  const telemetryA = attach(pi, a.ctx, { inspectWorkspace: () => new Promise(resolve => { resolveA = resolve; }) });
  let paintedA = 0;
  telemetryA.subscribe(() => paintedA++);
  const registered = count('agent_start');
  // Session replacement: A shuts down, B attaches.
  await emit('session_shutdown', { reason: 'new' }, a.ctx);
  assert.equal(count('agent_start'), registered - 1, 'handlers are unsubscribed');
  const b = fakeCtx({ root, sessionId: 'session-b' });
  const telemetryB = attach(pi, b.ctx);
  resolveA({ kind: 'available', root, relativeCwd: '', branch: 'retired-branch',
    snapshot: { trackedFiles: 1, untrackedFiles: 0, linesAdded: 0, linesRemoved: 0, binaryFiles: 0, submodules: 0, conflicts: 0 } });
  await tick(); await tick();
  assert.equal(paintedA, 0);
  assert.deepEqual(telemetryA.snapshot(), unavailableTelemetrySnapshot(root));
  assert.equal(telemetryB.snapshot().branch, undefined);
  assert.deepEqual(telemetryB.snapshot().todos, []);
  // Events for A's context do not reach B.
  await emit('agent_start', {}, a.ctx);
  assert.equal(telemetryB.snapshot().activity, 'ready');
  assert.equal(telemetryA.isCurrent(), false);
  telemetryB.dispose();
});

test('alerts: runtime and Promptr alerts show; external statuses are reported unavailable, never all-clear', async t => {
  const root = tempRoot(t);
  const { pi, emit } = fakePi();
  const { ctx } = fakeCtx({ root });
  const telemetry = attach(pi, ctx);
  assert.deepEqual([...telemetry.snapshot().extensionStatuses], [STATUS_SOURCE_GAP_ALERT]);
  assert.equal(telemetry.sources().extensionStatuses, 'unavailable');
  await emit('message_end', { message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'rate limited\x1b[31m',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }, ctx);
  await emit('session_compact_failed', { reason: 'threshold', aborted: false, willRetry: false, fromExtension: false }, ctx);
  telemetry.setPromptrAlerts([{ level: 'error', text: 'Queue unreadable; writes blocked' }, { level: 'warning', text: 'Tracker snapshot old' }]);
  const statuses = telemetry.snapshot().extensionStatuses;
  assert.ok(statuses.some(line => line.startsWith('Model request failed: rate limited')));
  assert.ok(!statuses.some(line => line.includes('\x1b')));
  assert.ok(statuses.includes('Compaction failed'));
  assert.ok(statuses.includes('Queue unreadable; writes blocked'));
  assert.ok(statuses.includes('Warning: Tracker snapshot old'));
  const lines = renderPromptrSidebar({ telemetry: telemetry.snapshot(), layout: defaultPromptrPanelLayout(), promptrPanels: [],
    width: 60, height: 200, theme, colorEnabled: false, now: 0 }).join('\n');
  assert.match(lines, /ALERTS/);
  assert.match(lines, /footer-only/);
  assert.match(lines, /Compaction failed/);
  assert.doesNotMatch(lines, /all clear/i);
  await emit('agent_start', {}, ctx);
  await emit('session_compact', { reason: 'manual', willRetry: false, fromExtension: false, compactionEntry: {} }, ctx);
  telemetry.setPromptrAlerts([]);
  assert.deepEqual([...telemetry.snapshot().extensionStatuses], [STATUS_SOURCE_GAP_ALERT]);
  telemetry.dispose();
  const quiet = attach(fakePi().pi, fakeCtx({ root, sessionId: 'q' }).ctx, { reportStatusSourceGap: false });
  assert.deepEqual([...quiet.snapshot().extensionStatuses], []);
  assert.equal(quiet.sources().extensionStatuses, 'unavailable');
  quiet.dispose();
});

test('whole-sidebar disable suspends producers; re-enable reconciles without forcing panels visible', async t => {
  const root = tempRoot(t);
  const entries = [todoResult({ todos: [{ id: 1, text: 'kept on branch', done: false }] })];
  let inspections = 0;
  const { pi, emit } = fakePi({ entries });
  const { ctx } = fakeCtx({ root, entries });
  const telemetry = attach(pi, ctx, { enabled: false, inspectWorkspace: async () => { inspections++; return { kind: 'not-repo' }; } });
  let notified = 0;
  telemetry.subscribe(() => notified++);
  await emit('turn_start', { turnIndex: 0 }, ctx);
  await emit('turn_end', { turnIndex: 0 }, ctx);
  await emit('message_end', { message: todoResult({ todos: [] }).message }, ctx);
  await sleep(350);
  assert.equal(inspections, 0);
  assert.equal(notified, 0);
  assert.deepEqual(telemetry.snapshot(), unavailableTelemetrySnapshot(root));
  assert.equal(telemetry.sources().workspace, 'suspended');
  telemetry.setEnabled(true);
  for (let i = 0; i < 50 && telemetry.snapshot().workspacePulse.status === 'inspecting'; i++) await sleep(10);
  assert.equal(inspections, 1);
  assert.equal(telemetry.snapshot().workspacePulse.status, 'not-repo');
  assert.deepEqual(telemetry.snapshot().todos.map(todo => todo.text), ['kept on branch']);
  // Panel-level visibility is not telemetry's concern: all data remain in the snapshot.
  const hidden = defaultPromptrPanelLayout().map(entry => ({ ...entry, visible: entry.id !== 'todos' }));
  const lines = renderPromptrSidebar({ telemetry: telemetry.snapshot(), layout: hidden, promptrPanels: [], width: 44, height: 120, theme, colorEnabled: false, now: 0 });
  assert.doesNotMatch(lines.join('\n'), /TODOS/);
  assert.equal(telemetry.snapshot().todos.length, 1);
  telemetry.dispose();
});

test('attach, events, rendering and disposal never touch footer/editor setters or transcript hooks', async t => {
  const root = tempRoot(t);
  const { pi, emit, calls } = fakePi();
  const { ctx, uiCalls } = fakeCtx({ root });
  const telemetry = attach(pi, ctx);
  for (const [event, payload] of [['agent_start', {}], ['turn_start', { turnIndex: 0 }], ['tool_execution_start', { toolCallId: 't', toolName: 'todo', args: {} }],
    ['message_end', { message: todoResult({ todos: [{ id: 1, text: 'x', done: false }] }).message }],
    ['tool_execution_end', { toolCallId: 't', toolName: 'todo', result: { content: [{ type: 'text', text: 'original' }] }, isError: false }],
    ['turn_end', { turnIndex: 0 }], ['agent_settled', {}]]) await emit(event, payload, ctx);
  renderPromptrSidebar({ telemetry: telemetry.snapshot(), layout: defaultPromptrPanelLayout(), promptrPanels: [], width: 44, height: 80, theme, colorEnabled: false, now: 0 });
  telemetry.dispose();
  assert.deepEqual(uiCalls.filter(name => UI_SETTERS.includes(name)), []);
  for (const forbidden of ['tool_result', 'tool_call', 'context', 'context_with_system', 'before_agent_start', 'input', 'message_start'])
    assert.ok(!calls.on.includes(forbidden), forbidden);
});

test('snapshot and render perform no Git, file, process or network work', async t => {
  const root = tempRoot(t);
  const entries = [assistant(10, 0.01), todoResult({ todos: [{ id: 1, text: 'x', done: false }] })];
  const { pi, emit, calls } = fakePi({ entries });
  const { ctx } = fakeCtx({ root, entries });
  const telemetry = attach(pi, ctx);
  await emit('agent_start', {}, ctx);
  await tick();
  const execBefore = calls.exec.length;
  const touched = [];
  const spy = (target, names, label) => { for (const name of names) if (typeof target[name] === 'function') t.mock.method(target, name, (..._args) => { touched.push(`${label}.${name}`); throw new Error('I/O in render'); }); };
  spy(fs, ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'openSync', 'opendirSync', 'readFile', 'open', 'opendir', 'stat', 'realpathSync'], 'fs');
  spy(fsp, ['readFile', 'open', 'opendir', 'stat', 'realpath', 'readdir'], 'fsp');
  spy(childProcess, ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync'], 'cp');
  t.mock.method(globalThis, 'fetch', () => { touched.push('fetch'); throw new Error('network in render'); });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 3; i++) {
      await emit('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'abc '.repeat(i + 5) }] } }, ctx);
      const lines = renderPromptrSidebar({ telemetry: telemetry.snapshot(), layout: defaultPromptrPanelLayout(), promptrPanels: [],
        width: 44, height: 90, theme, colorEnabled: false, now: 0 });
      assert.ok(lines.every(line => visibleWidth(line) <= 44));
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(touched, []);
  assert.equal(calls.exec.length, execBefore);
  telemetry.dispose();
});

test('usage dialog keeps release interactions, text fallback, trust gate and session lifetime', async t => {
  const root = tempRoot(t);
  const asyncRoot = path.join(root, 'async');
  const sessionFile = path.join(root, 'sessions', 'session-a.jsonl');
  const artifacts = path.join(root, '.pi', 'subagents', 'artifacts');
  const steps = [{ agent: 'scout', startedAt: 1000, status: 'complete' }, { agent: 'worker', startedAt: 1000, status: 'complete' }];
  writeJson(path.join(asyncRoot, 'run-u', 'status.json'), { runId: 'run-u', sessionId: sessionFile, state: 'complete', startedAt: 1000, steps });
  const reply = (index, agent, at, cost) => JSON.stringify({ type: 'message_end', subagentSource: 'child', subagentRunId: 'run-u',
    subagentStepIndex: index, subagentAgent: agent, observedAt: at, message: { role: 'assistant', timestamp: at, usage: { cost: { total: cost } } } });
  fs.writeFileSync(path.join(asyncRoot, 'run-u', 'events.jsonl'),
    [reply(0, 'scout', 2000, 0.1), reply(1, 'worker', 2500, 0.2), reply(0, 'scout', 3000, 0.1), reply(1, 'worker', 4000, 0.3)].join('\n') + '\n');
  writeJson(path.join(artifacts, 'run-u_scout_0_meta.json'), { runId: 'run-u', agent: 'scout', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.2 } });
  writeJson(path.join(artifacts, 'run-u_worker_1_meta.json'), { runId: 'run-u', agent: 'worker', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5 } });
  const entries = [{ type: 'custom', customType: SUBAGENT_METADATA_ENTRY, data: { runIds: ['run-u'], paths: [], asyncDirs: [path.join(asyncRoot, 'run-u')] } }];
  const { pi } = fakePi({ entries });
  const f = fakeCtx({ root, entries });
  const telemetry = attach(pi, f.ctx);
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
  let component;
  let doneValue = 'pending';
  f.ctx.ui.custom = (factory, options) => new Promise(resolve => {
    assert.equal(options.overlay, true);
    component = factory(tui, theme, {}, value => { doneValue = value; resolve(value); });
  });
  const opened = openPromptrUsage(f.ctx, telemetry);
  for (let i = 0; i < 100 && !component; i++) await sleep(5);
  assert.ok(component, 'dialog opened');
  const view = () => component.render(80);
  let lines = view();
  assert.ok(lines.every(line => visibleWidth(line) <= 80));
  const text = lines.join('\n');
  assert.match(text, /SUBAGENT COST/);
  assert.match(text, /\[ \] point/);
  assert.doesNotMatch(text, /\x1b_G|\x1b\]1337/, 'plain terminal uses the text fallback');
  component.handleInput('\x1b[C'); // right: focus first agent
  component.handleInput('[');
  lines = view();
  assert.match(lines.join('\n'), /#1 · Point 1\/2/);
  component.handleInput(']');
  assert.match(view().join('\n'), /#1 · Point 2\/2/);
  component.handleInput('A');
  assert.match(view().join('\n'), /select an agent/);
  component.handleInput('\x1b');
  assert.equal(await opened, 'closed');
  assert.equal(doneValue, undefined);
  assert.equal(usageDecimals(9), 6);
  assert.equal(usageDecimals(-1), 0);

  // Retiring the session closes an open dialog.
  component = undefined;
  const second = openPromptrUsage(f.ctx, telemetry);
  for (let i = 0; i < 100 && !component; i++) await sleep(5);
  telemetry.dispose();
  assert.equal(await second, 'closed');
  assert.deepEqual(component.render(80), []);
  assert.equal(await openPromptrUsage(f.ctx, telemetry), 'inactive');

  // Untrusted projects read nothing.
  const u = fakeCtx({ root, trusted: false, sessionId: 'u' });
  const untrusted = attach(fakePi().pi, u.ctx);
  assert.equal(await openPromptrUsage(u.ctx, untrusted), 'untrusted');
  assert.ok(u.uiCalls.some(call => call.startsWith('notify:info:Subagent usage needs a trusted project')));
  untrusted.dispose();
  assert.deepEqual(f.uiCalls.filter(name => UI_SETTERS.includes(name)), []);
});
