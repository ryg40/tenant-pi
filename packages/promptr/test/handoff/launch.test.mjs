import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 buildHandoffAgentStartArgs, buildHandoffPromptArgs, buildHandoffTabArgs, launchHandoffSuccessor,
} from '../../dist/src/handoff/launch.mjs';

const CWD = '/repo';
const SESSION = '/sessions/source.jsonl';
const ENV = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w8', HERDR_PANE_ID: 'w8:p13' };
const RUNTIME = { provider: 'example-provider', model: 'vendor/example-model-1.3', thinking: 'medium', source: 'ctx' };
const TEXT = '# Promptr handoff - proj - now\nSECRET-BODY-MARKER\n## How to continue\n1. go\n';

const agent = (pane, over = {}) => JSON.stringify({ result: { agent: {
 agent: 'pi', pane_id: pane, cwd: CWD, foreground_cwd: CWD, agent_status: 'idle', terminal_id: 't1',
 agent_session: { kind: 'path', value: pane === 'w8:p13' ? SESSION : '/sessions/new.jsonl' }, ...over,
} } });
const NOT_FOUND = JSON.stringify({ error: { code: 'agent_not_found' } });
const TAB = JSON.stringify({ result: { root_pane: { pane_id: 'w8:p99' } } });

function harness({ sourceStatus = 'idle', readySeq = [agent('w8:p99')], promptThrows = false, source } = {}) {
 const calls = [];
 let gets = 0;
 let slept = 0;
 const exec = async args => {
  calls.push(args);
  const key = args.slice(0, 2).join(' ');
  if (key === 'agent get' && args[2] === 'w8:p13') return source ?? agent('w8:p13', { agent_status: sourceStatus });
  if (key === 'workspace list') return JSON.stringify({ result: { workspaces: [{ workspace_id: 'w8', label: 'promptr' }] } });
  if (key === 'tab create') return TAB;
  if (key === 'agent start') return '{}';
  if (key === 'agent get') return readySeq[Math.min(gets++, readySeq.length - 1)];
  if (key === 'agent prompt') { if (promptThrows) throw new Error('timeout'); return '{}'; }
  throw new Error(`unexpected ${key}`);
 };
 let t = 0;
 const deps = { exec, now: () => new Date(Date.UTC(2026, 8, 8, 14, 5, 9) + t), sleep: async ms => { slept++; t += ms; } };
 const input = { env: ENV, cwd: CWD, slug: 'proj', sessionFile: SESSION, runtime: RUNTIME, name: 'hx', handoffPath: '/h/hx.md', handoffText: TEXT };
 return { calls, deps, input, sleptCount: () => slept };
}

const kinds = calls => calls.map(a => a.slice(0, 2).join(' '));

test('arg builders: full peer, no restrictions, no handoff text', () => {
 assert.deepEqual(buildHandoffTabArgs('w8', CWD, 'L'), ['tab', 'create', '--workspace', 'w8', '--cwd', CWD, '--label', 'L', '--no-focus']);
 const start = buildHandoffAgentStartArgs('n', 'w8:p99', RUNTIME);
 assert.deepEqual(start.slice(0, 9), ['agent', 'start', 'n', '--kind', 'pi', '--pane', 'w8:p99', '--timeout', '60000']);
 assert.deepEqual(start.slice(9), ['--', '--provider', 'example-provider', '--model', 'vendor/example-model-1.3', '--thinking', 'medium']);
 for (const flag of ['--no-extensions', '--no-skills', '--tools']) assert.ok(!start.includes(flag));
 assert.deepEqual(buildHandoffPromptArgs('w8:p99', 'msg'), ['agent', 'prompt', 'w8:p99', 'msg', '--wait', '--until', 'working', '--timeout', '10000']);
});

test('happy path issues tab create, agent start, agent get polls, one prompt; argv never carries handoff body', async () => {
 const h = harness();
 const result = await launchHandoffSuccessor(h.input, h.deps);
 assert.equal(result.ok, true);
 assert.equal(result.launch, 'launched');
 assert.equal(result.pane, 'w8:p99');
 assert.equal(result.successorSession, '/sessions/new.jsonl');
 assert.match(result.agentName, /^promptr-hand-[0-9a-f]{8}-140509$/);
 assert.deepEqual(kinds(h.calls), ['agent get', 'workspace list', 'tab create', 'agent start', 'agent get', 'agent prompt']);
 assert.equal(result.label, 'prompt-coord');
 assert.equal(h.calls[2][h.calls[2].indexOf('--label') + 1], 'prompt-coord');
 assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 1);
 const prompt = h.calls.find(a => a[1] === 'prompt');
 assert.match(prompt[3], /\/h\/hx\.md/);
 assert.match(prompt[3], new RegExp(SESSION.replace(/\//g, '\\/')));
 assert.match(prompt[3], /^[\x20-\x7e]+$/);
 for (const args of h.calls) assert.ok(!args.join(' ').includes('SECRET-BODY-MARKER'));
});

test('agent_not_found twice then idle succeeds; done counts as ready', async () => {
 const h = harness({ readySeq: [NOT_FOUND, NOT_FOUND, agent('w8:p99')] });
 const result = await launchHandoffSuccessor(h.input, h.deps);
 assert.equal(result.ok, true);
 assert.equal(kinds(h.calls).filter(k => k === 'agent get').length, 4);
 assert.equal(h.sleptCount(), 2);
 const d = harness({ readySeq: [agent('w8:p99', { agent_status: 'done' })] });
 const done = await launchHandoffSuccessor(d.input, d.deps);
 assert.equal(done.ok, true);
 const src = harness({ sourceStatus: 'done' });
 assert.equal((await launchHandoffSuccessor(src.input, src.deps)).ok, true);
});

test('readiness timeout stops polling with a reason and prompts nothing', async () => {
 const h = harness({ readySeq: [NOT_FOUND] });
 const result = await launchHandoffSuccessor(h.input, h.deps);
 assert.equal(result.ok, false);
 assert.equal(result.stage, 'ready');
 assert.equal(result.pane, 'w8:p99');
 assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 0);
 assert.ok(h.sleptCount() <= 31);
});

test('source identity mismatch launches nothing', async () => {
 for (const bad of [
  agent('w8:p13', { cwd: '/elsewhere' }),
  agent('w8:p13', { agent_session: { kind: 'path', value: '/sessions/other.jsonl' } }),
  agent('w8:p13', { agent: 'claude' }),
  NOT_FOUND,
 ]) {
  const h = harness({ source: bad });
  const result = await launchHandoffSuccessor(h.input, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'source');
  assert.deepEqual(kinds(h.calls), ['agent get']);
 }
});

test('source status lag settles before launch; busy/blocked/unknown never launch', async () => {
 const h = harness();
 const original = h.deps.exec;
 let sourceGets = 0;
 h.deps.exec = async args => {
  if (args[1] === 'get' && args[2] === ENV.HERDR_PANE_ID && sourceGets++ === 0) {
   h.calls.push(args);
   return agent(ENV.HERDR_PANE_ID, { agent_status: 'working' });
  }
  return original(args);
 };
 assert.equal((await launchHandoffSuccessor(h.input, h.deps)).ok, true);
 assert.equal(h.sleptCount(), 1);
 for (const status of ['working', 'blocked', 'unknown']) {
  const busy = harness({ sourceStatus: status });
  const result = await launchHandoffSuccessor(busy.input, busy.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'source');
  assert.ok(busy.calls.every(args => args[1] === 'get'));
  assert.equal(busy.sleptCount(), 16);
 }
});

test('preconditions refuse outside Herdr, malformed ids, missing runtime or session', async () => {
 for (const [env, runtime, sessionFile] of [
  [{ ...ENV, HERDR_ENV: '0' }, RUNTIME, SESSION],
  [{ ...ENV, HERDR_WORKSPACE_ID: '' }, RUNTIME, SESSION],
  [{ ...ENV, HERDR_PANE_ID: 'nope' }, RUNTIME, SESSION],
  [ENV, undefined, SESSION],
  [ENV, RUNTIME, ''],
 ]) {
  const h = harness();
  const result = await launchHandoffSuccessor({ ...h.input, env, runtime, sessionFile }, h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'preconditions');
  assert.equal(h.calls.length, 0);
 }
});

test('prompt timeout reports uncertain with the pane and never prompts twice', async () => {
 const h = harness({ promptThrows: true });
 const result = await launchHandoffSuccessor(h.input, h.deps);
 assert.equal(result.ok, true);
 assert.equal(result.launch, 'uncertain');
 assert.equal(result.pane, 'w8:p99');
 assert.equal(h.calls.filter(a => a[1] === 'prompt').length, 1);
});

test('tab create failure and agent start failure launch nothing further', async () => {
 const h = harness();
 const exec = h.deps.exec;
 h.deps.exec = async args => { if (args[0] === 'tab') { h.calls.push(args); return JSON.stringify({ error: 'no' }); } return exec(args); };
 const tab = await launchHandoffSuccessor(h.input, h.deps);
 assert.equal(tab.ok, false);
 assert.equal(tab.stage, 'tab');
 assert.deepEqual(kinds(h.calls), ['agent get', 'workspace list', 'tab create']);
 const g = harness();
 const exec2 = g.deps.exec;
 g.deps.exec = async args => { if (args[1] === 'start') throw new Error('boom'); return exec2(args); };
 const start = await launchHandoffSuccessor(g.input, g.deps);
 assert.equal(start.ok, false);
 assert.equal(start.stage, 'start');
 assert.equal(g.calls.filter(a => a[1] === 'prompt').length, 0);
});
