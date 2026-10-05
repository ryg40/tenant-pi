import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshSessionName, startFreshBriefingInNewPi } from '../../dist/src/companion/briefing-fresh.mjs';

const RUNTIME = { PI_PROVIDER: 'example-provider', PI_MODEL: 'vendor/example-model-1.3-contributor', PI_REASONING_LEVEL: 'xhigh' };
const TEXT = '# Briefing\n\nExact continuation text.\n';

function agentRecord(paneId, { status = 'idle', cwd, session, terminal = 'term-x' } = {}) {
 return { result: { agent: {
  agent: 'pi', pane_id: paneId, cwd, foreground_cwd: cwd,
  agent_status: status, agent_session: { kind: 'path', value: session },
  terminal_id: terminal,
 }}};
}

function fixture(t, { confirm = true, mutate = null, fail = null } = {}) {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-fresh-'));
 t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
 const source = { pane: 'w4:p0', sessionFile: '/sessions/main.jsonl', cwd };
 const calls = []; const notices = []; const confirms = [];
 let gets = 0;
 const freshPane = 'w4:p7';
 const exec = async args => {
  calls.push(args);
  if (fail && fail(args, calls)) throw new Error('injected failure');
  if (args[0] === 'agent' && args[1] === 'get' && args[2] === source.pane) {
   gets++;
   const changed = mutate && mutate('source', gets);
   return JSON.stringify(changed ?? agentRecord(source.pane, { cwd, session: source.sessionFile, terminal: 'term-src' }));
  }
  if (args[0] === 'pane' && args[1] === 'split') {
   return JSON.stringify({ result: { pane: { pane_id: freshPane, workspace_id: 'w4', tab_id: 'w4:t9' } } });
  }
  if (args[0] === 'workspace' && args[1] === 'list') return JSON.stringify({ result: { workspaces: [{ workspace_id: 'w4', label: 'promptr' }] } });
  if (args[0] === 'agent' && args[1] === 'start') return JSON.stringify({ ok: true });
  if (args[0] === 'agent' && args[1] === 'get' && args[2] === freshPane) {
   const changed = mutate && mutate('successor', 0);
   return JSON.stringify(changed ?? agentRecord(freshPane, { cwd, session: '/sessions/fresh.jsonl', terminal: 'term-new' }));
  }
  if (args[0] === 'agent' && args[1] === 'prompt') return JSON.stringify({ ok: true });
  throw new Error('unexpected call ' + JSON.stringify(args));
 };
 const ui = {
  confirm: async (title, message) => { confirms.push([title, message]); return confirm; },
  notify: (message, level) => notices.push([message, level ?? 'info']),
 };
 const packets = () => {
  const dir = path.join(cwd, '.promptr', 'briefing-history');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('-fresh-attempt.json')) : [];
 };
 return { cwd, source, calls, notices, confirms, ui, exec, packets, freshPane };
}

test('freshSessionName is lowercase-safe and embeds project plus timestamp', () => {
 const name = freshSessionName("/repo/My Project", new Date('2026-09-07T06:00:00Z'));
 assert.match(name, /^promptr-fresh-my-project-20260907t060000$/);
});

test('cancel launches nothing and writes no packet', async t => {
 const f = fixture(t, { confirm: false });
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.deepEqual(f.calls.map(c => c.slice(0, 2).join(' ')), ['agent get']);
 assert.deepEqual(f.packets(), []);
});

test('happy path verifies, confirms exact binding, saves packet, splits, starts, verifies, prompts once', async t => {
 const f = fixture(t);
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), true);
 assert.deepEqual(f.calls.map(c => c.slice(0, 2).join(' ')),
  ['agent get', 'agent get', 'pane split', 'workspace list', 'agent start', 'agent get', 'agent prompt']);
 const [title, message] = f.confirms[0];
 assert.match(title, /Start fresh/);
 for (const needle of ['example-provider', 'vendor/example-model-1.3-contributor', 'xhigh', f.cwd, 'w4:p0']) assert.ok(message.includes(needle), needle);
 const split = f.calls[2];
 assert.ok(split.includes('--pane') && split[split.indexOf('--pane') + 1] === 'w4:p0');
 assert.ok(split.includes('--cwd') && split[split.indexOf('--cwd') + 1] === f.cwd);
 assert.ok(split.includes('PI_PROVIDER=example-provider') && split.includes('PI_MODEL=vendor/example-model-1.3-contributor') && split.includes('PI_REASONING_LEVEL=xhigh'));
 const start = f.calls[4];
 assert.deepEqual(start.slice(0, 5), ['agent', 'start', start[2], '--kind', 'pi']);
 assert.ok(/^[a-z0-9-]+$/.test(start[2]));
 assert.ok(start.includes('--provider') && start.includes('example-provider'));
 assert.ok(start.includes('--model') && start.includes('vendor/example-model-1.3-contributor'));
 assert.ok(start.includes('--thinking') && start.includes('xhigh'));
 assert.equal(start[start.indexOf('--name') + 1], 'prompt-coord');
 assert.ok(start.slice(start.indexOf('--pane') + 1, start.indexOf('--pane') + 2).every(p => p === f.freshPane));
 assert.equal(f.packets().length, 1);
 const packet = JSON.parse(fs.readFileSync(path.join(f.cwd, '.promptr', 'briefing-history', f.packets()[0]), 'utf8'));
 assert.equal(packet.kind, 'start-fresh');
 assert.equal(packet.text, TEXT);
 assert.deepEqual(packet.runtime, { provider: 'example-provider', model: 'vendor/example-model-1.3-contributor', thinking: 'xhigh' });
 assert.equal(packet.outcome, 'transferred');
 assert.equal(packet.successor.pane, f.freshPane);
 assert.match(f.notices.at(-1)[0], /Transfer recorded/);
 assert.match(f.notices.at(-1)[0], /stop mutating/);
});

test('source identity change after confirm launches nothing and writes no packet', async t => {
 const f = fixture(t, { mutate: (which, n) => which === 'source' && n === 2
  ? { result: { agent: { agent: 'pi', pane_id: 'w4:p0', cwd: f.cwd, foreground_cwd: f.cwd, agent_status: 'working', agent_session: { kind: 'path', value: '/sessions/main.jsonl' }, terminal_id: 'term-src' } } }
  : null });
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.ok(!f.calls.some(c => c[0] === 'pane' || c[1] === 'prompt' || c[1] === 'start'));
 assert.deepEqual(f.packets(), []);
});

test('existing packet blocks replay with zero Herdr calls', async t => {
 const f = fixture(t);
 const dir = path.join(f.cwd, '.promptr', 'briefing-history');
 fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(path.join(dir, 'x-fresh-attempt.json'), '{}');
 // Reuse the real packet path by running once with a failing split, then retry.
 const g = fixture(t, { fail: args => args[0] === 'pane' });
 assert.equal(await startFreshBriefingInNewPi(TEXT, g.source, g.ui, g.exec, { ...RUNTIME }), false);
 assert.equal(g.packets().length, 1);
 const before = g.calls.length;
 assert.equal(await startFreshBriefingInNewPi(TEXT, g.source, g.ui, g.exec, { ...RUNTIME }), false);
 assert.equal(g.calls.length, before);
 assert.ok(g.notices.at(-1)[0].includes('already attempted'));
});

test('missing runtime binding, source binding, or command text launches nothing', async t => {
 const f = fixture(t);
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, {}), false);
 assert.equal(await startFreshBriefingInNewPi(TEXT, { pane: '', sessionFile: '', cwd: f.cwd }, f.ui, f.exec, { ...RUNTIME }), false);
 assert.equal(await startFreshBriefingInNewPi('   ', f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.equal(await startFreshBriefingInNewPi('/coordinatr', f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.deepEqual(f.calls, []);
 assert.deepEqual(f.packets(), []);
});

test('uncertain prompt retains attempted packet without retry', async t => {
 const f = fixture(t, { fail: args => args[1] === 'prompt' });
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), true);
 assert.equal(f.calls.filter(c => c[1] === 'prompt').length, 1);
 assert.match(f.notices.at(-1)[0], /uncertain/);
 const packet = JSON.parse(fs.readFileSync(path.join(f.cwd, '.promptr', 'briefing-history', f.packets()[0]), 'utf8'));
 assert.equal(packet.outcome, 'attempted/unknown');
});

test('unverified successor submits nothing but retains the packet', async t => {
 const f = fixture(t, { mutate: which => which === 'successor'
  ? { result: { agent: { agent: 'pi', pane_id: 'w4:p7', cwd: '/elsewhere', foreground_cwd: '/elsewhere', agent_status: 'idle', agent_session: { kind: 'path', value: '/sessions/fresh.jsonl' }, terminal_id: 'term-new' } } }
  : null });
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.ok(!f.calls.some(c => c[1] === 'prompt'));
 assert.equal(f.packets().length, 1);
 assert.match(f.notices.at(-1)[0], /nothing submitted/);
});

test('split failure launches nothing and retains the packet', async t => {
 const f = fixture(t, { fail: args => args[0] === 'pane' });
 assert.equal(await startFreshBriefingInNewPi(TEXT, f.source, f.ui, f.exec, { ...RUNTIME }), false);
 assert.ok(!f.calls.some(c => c[1] === 'start' || c[1] === 'prompt'));
 assert.equal(f.packets().length, 1);
});
