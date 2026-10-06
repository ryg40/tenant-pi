import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startRoleHandoff, collectRoleHandoff } from '../../dist/src/herdr/role-handoff.mjs';
import { parseAgent, parseAgentList, parseHerdrResult, matchesAgentIdentity, buildInteractiveStartArgs, buildWaitArgs } from '../../dist/src/herdr/adapter.mjs';
import { runReceiptDir, writeRunReceipt } from '../../dist/src/state/run-receipts.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const runtime = { harness: 'pi', provider: 'example-provider', model: 'example/model', thinking: 'high' };

test('adapter parses sanitized CLI envelopes and rejects errors, malformed and oversized responses', () => {
  assert.equal(parseAgent(JSON.stringify(fixture('agent-get'))).pane_id, 'wA:p2');
  assert.equal(parseAgentList(JSON.stringify(fixture('agent-list'))).length, 1);
  assert.equal(parseHerdrResult(JSON.stringify(fixture('agent-prompt-wait'))).type, 'agent_prompted');
  assert.equal(parseAgent(JSON.stringify(fixture('agent-wait'))).agent_status, 'done');
  for (const input of ['{}', '{', 'null', '{"error":{},"result":{"agent":{}}}', ' '.repeat(1024 * 1024 + 1)]) {
    assert.equal(parseAgent(input), undefined);
  }
  assert.equal(parseAgentList('{"result":{"agents":[null]}}'), undefined);
  const agent = parseAgent(JSON.stringify(fixture('agent-get')));
  assert.equal(matchesAgentIdentity(agent, { pane: 'wA:p2', cwd: '/project', session: '/sessions/wrong.jsonl' }), false);
  assert.deepEqual(buildInteractiveStartArgs('example-worker', 'wA:p2', runtime), [
    'agent', 'start', 'example-worker', '--kind', 'pi', '--pane', 'wA:p2', '--timeout', '60000',
    '--', '--provider', 'example-provider', '--model', 'example/model', '--thinking', 'high',
  ]);
  assert.throws(() => buildWaitArgs('wA:p2', 0));
});

function setup(t, mode = '') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-role-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(scratch, 'agent');
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const packetPath = path.join(scratch, 'packet.md');
  fs.writeFileSync(packetPath, 'Review the example change. Keep the session open.');
  let now = Date.now() - 1000;
  const calls = [];
  let owner;
  let phase = 'start';
  const agentResponse = (name, status) => {
    const data = fixture(name);
    const agent = data.result.agent;
    agent.name = owner;
    agent.cwd = agent.foreground_cwd = scratch;
    if (status) agent.agent_status = status;
    if (phase === 'collect' && mode === 'changed-session') agent.agent_session.value = '/sessions/replacement.jsonl';
    if (phase === 'collect' && mode === 'changed-owner') agent.name = 'unowned-worker';
    if (phase === 'collect' && mode === 'blocked') agent.agent_status = 'blocked';
    return JSON.stringify(data);
  };
  const deps = {
    now: () => now,
    sleep: async ms => { now += ms; },
    exec: async args => {
      calls.push(args);
      const key = args.slice(0, 2).join(' ');
      if (key === 'workspace list') return '{"result":{"workspaces":[]}}';
      if (key === 'tab create') {
        if (mode === 'tab-failure') throw new Error('tab timeout');
        return '{"result":{"root_pane":{"pane_id":"wA:p2"}}}';
      }
      if (key === 'agent start') {
        owner = args[2];
        if (mode === 'start-failure') throw new Error('start timeout');
        return '{}';
      }
      if (key === 'agent get') return agentResponse('agent-get', mode === 'never-ready' ? 'working' : 'idle');
      if (key === 'agent prompt') {
        if (mode === 'uncertain') throw new Error('timeout with sensitive text');
        if (mode === 'bad-ack') return '{}';
        return agentResponse('agent-prompt-wait');
      }
      if (key === 'agent wait') return agentResponse('agent-wait');
      throw new Error('Unexpected command');
    },
  };
  const input = { explicitlyRequested: true, runId: 'example-run', packetPath, taskRef: 'example/task',
    workspace: 'wA', cwd: scratch, role: 'worker', runtime };
  return { input, deps, calls, collectPhase: () => { phase = 'collect'; now = Date.now() + 1000; } };
}

function report(receipt, changes = {}) {
  fs.writeFileSync(receipt.reportPath, JSON.stringify({ runId: receipt.runId, packetHash: receipt.packetHash,
    session: receipt.harnessSession, completedAt: new Date().toISOString(), marker: receipt.completionMarker,
    report: 'The requested checks pass. Correctness still needs review.', ...changes }), { mode: 0o600 });
}

test('one fixture launch collects a fresh bounded report and keeps immutable private receipts', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  assert.equal(receipt.outcome, 'submitted');
  report(receipt);
  h.collectPhase();
  const result = await collectRoleHandoff(receipt.runId, h.deps);
  assert.equal(result.outcome, 'collected');
  assert.match(result.reportHash, /^[a-f0-9]{64}$/);
  const dir = runReceiptDir(receipt.runId);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(dir).filter(f => f !== 'report.json')) {
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /Review the example change|Correctness still needs review/);
  }
  assert.throws(() => writeRunReceipt(dir, 'launch.json', {}), /EEXIST/);
  await assert.rejects(startRoleHandoff(h.input, h.deps), /EEXIST/);
  const finalReceipt = fs.readFileSync(path.join(dir, 'collection.json'), 'utf8');
  const callsBeforeRetry = h.calls.length;
  await assert.rejects(collectRoleHandoff(receipt.runId, h.deps), /already-collected/);
  assert.equal(h.calls.length, callsBeforeRetry);
  assert.equal(fs.readFileSync(path.join(dir, 'collection.json'), 'utf8'), finalReceipt);
  assert.throws(() => writeRunReceipt(dir, 'collection.json', {}), /EEXIST/);
  assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 1);
  assert.equal(h.calls.filter(a => a[1] === 'start').length, 1);
  assert.equal(h.calls.some(a => ['close', 'stop', 'kill'].includes(a[1])), false);
});

for (const [mode, changes, reason] of [
  ['stale', { completedAt: '2000-01-01T00:00:00.000Z' }, 'stale-report'],
  ['wrong-session', { session: '/sessions/wrong.jsonl' }, 'report-identity-mismatch'],
  ['wrong-run', { runId: 'old-run' }, 'report-identity-mismatch'],
  ['wrong-packet', { packetHash: 'wrong' }, 'report-identity-mismatch'],
  ['no-marker', { marker: '' }, 'completion-marker-missing'],
  ['oversized', { report: 'x'.repeat(25_000) }, 'invalid-report'],
  ['changed-session', {}, 'session-mismatch'],
  ['changed-owner', {}, 'session-mismatch'],
  ['blocked', {}, 'blocked'],
  ['uncertain', {}, 'submission-unconfirmed'],
  ['bad-ack', {}, 'submission-unconfirmed'],
]) {
  test(`collection refuses ${mode} without replay or replacement`, async t => {
    const h = setup(t, mode);
    const receipt = await startRoleHandoff(h.input, h.deps);
    report(receipt, changes);
    h.collectPhase();
    const result = await collectRoleHandoff(receipt.runId, h.deps);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.reason, reason);
    await assert.rejects(startRoleHandoff(h.input, h.deps), /EEXIST/);
    assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 1);
    assert.equal(h.calls.filter(a => a[1] === 'start').length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(runReceiptDir(receipt.runId), 'launch.json'), 'utf8'), /sensitive text/);
  });
}

test('collection retries after not-settled and collects the later report', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  h.collectPhase();
  const exec = h.deps.exec;
  let settled = false;
  h.deps.exec = async args => {
    const response = await exec(args);
    if (!settled && args[1] === 'wait') {
      const data = JSON.parse(response);
      data.result.agent.agent_status = 'working';
      return JSON.stringify(data);
    }
    return response;
  };
  assert.deepEqual(await collectRoleHandoff(receipt.runId, h.deps), { outcome: 'rejected', reason: 'not-settled' });
  const dir = runReceiptDir(receipt.runId);
  const firstAttempt = fs.readFileSync(path.join(dir, 'collection-attempted-1.json'), 'utf8');
  const rejection = fs.readFileSync(path.join(dir, 'collection-1.json'), 'utf8');
  assert.equal(fs.existsSync(path.join(dir, 'collection.json')), false);
  settled = true;
  report(receipt);
  h.collectPhase();
  assert.equal((await collectRoleHandoff(receipt.runId, h.deps)).outcome, 'collected');
  assert.equal(fs.readFileSync(path.join(dir, 'collection-attempted-1.json'), 'utf8'), firstAttempt);
  assert.equal(fs.readFileSync(path.join(dir, 'collection-1.json'), 'utf8'), rejection);
  for (const file of ['collection-attempted-1.json', 'collection-attempted-2.json', 'collection-1.json', 'collection-2.json']) {
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    assert.throws(() => writeRunReceipt(dir, file, {}), /EEXIST/);
  }
  assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 1);
  assert.equal(h.calls.filter(a => a[1] === 'start').length, 1);
});

test('idle without a report rejects but a later report can be collected', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  h.collectPhase();
  assert.equal((await collectRoleHandoff(receipt.runId, h.deps)).outcome, 'rejected');
  report(receipt);
  h.collectPhase();
  assert.equal((await collectRoleHandoff(receipt.runId, h.deps)).outcome, 'collected');
});

test('collection rejects malformed launch receipt fields before any Herdr call', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  report(receipt);
  h.collectPhase();
  const dir = runReceiptDir(receipt.runId);
  const callsBeforeCollection = h.calls.length;
  const malformed = [null, [], { ...receipt, owner: undefined }, { ...receipt, promptAt: 'not-a-time' },
    { ...receipt, runtime: null }, { ...receipt, pane: 42 }, { ...receipt, completionMarker: null }];
  for (const [index, value] of malformed.entries()) {
    fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(value));
    assert.deepEqual(await collectRoleHandoff(receipt.runId, h.deps), { outcome: 'rejected', reason: 'invalid-receipt' });
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, `collection-${index + 1}.json`), 'utf8'));
    assert.equal(evidence.reason, 'invalid-receipt');
  }
  assert.equal(h.calls.length, callsBeforeCollection);
  assert.equal(fs.existsSync(path.join(dir, 'collection.json')), false);
});

test('old file metadata refuses a freshly claimed report time', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  report(receipt);
  fs.utimesSync(receipt.reportPath, new Date(0), new Date(0));
  h.collectPhase();
  assert.equal((await collectRoleHandoff(receipt.runId, h.deps)).reason, 'stale-report');
});

test('no explicit request or unsupported harness makes no Herdr call', async t => {
  const h = setup(t);
  await assert.rejects(startRoleHandoff({ ...h.input, explicitlyRequested: false }, h.deps));
  await assert.rejects(startRoleHandoff({ ...h.input, runtime: { ...runtime, harness: 'claude' } }, h.deps));
  assert.deepEqual(h.calls, []);
});

for (const mode of ['tab-failure', 'start-failure', 'never-ready']) {
  test(`${mode} records failed-before-send and never prompts or replaces`, async t => {
    const h = setup(t, mode);
    const receipt = await startRoleHandoff(h.input, h.deps);
    assert.equal(receipt.outcome, 'failed-before-send');
    assert.equal(receipt.stage, mode === 'tab-failure' ? 'tab' : mode === 'start-failure' ? 'start' : 'ready');
    const launch = JSON.parse(fs.readFileSync(path.join(runReceiptDir(receipt.runId), 'launch.json'), 'utf8'));
    assert.equal(launch.outcome, 'failed-before-send');
    assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 0);
    assert.equal(h.calls.filter(a => a[1] === 'start').length, mode === 'tab-failure' ? 0 : 1);
    assert.ok(h.calls.filter(a => a[1] === 'get').length <= 30);
    await assert.rejects(startRoleHandoff(h.input, h.deps), /EEXIST/);
  });
}

test('collection refuses a symlink instead of reading another artifact', async t => {
  const h = setup(t);
  const receipt = await startRoleHandoff(h.input, h.deps);
  fs.symlinkSync(h.input.packetPath, receipt.reportPath);
  h.collectPhase();
  assert.equal((await collectRoleHandoff(receipt.runId, h.deps)).outcome, 'rejected');
});
