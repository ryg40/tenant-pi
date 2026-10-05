import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import promptr from '../../dist/src/extension/index.mjs';
import { projectPaths } from '../../dist/src/state/paths.mjs';
import { HANDOFF_HEADINGS } from '../../dist/src/handoff/packet.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(run) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-host-handoff-'));
 const old = { ...process.env };
 process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
 process.env.HERDR_ENV = '1';
 process.env.HERDR_WORKSPACE_ID = 'w8';
 process.env.HERDR_PANE_ID = 'w8:p13';
 const paths = projectPaths(root);
 fs.mkdirSync(paths.handoffsDir, { recursive: true });
 const name = 'host-test';
 const target = path.join(paths.handoffsDir, `${name}.md`);
 const receiptFile = path.join(paths.handoffsDir, `${name}.json`);
 fs.writeFileSync(target, '# Promptr handoff - test\n' + HANDOFF_HEADINGS.map(h => `\n## ${h}\nTest evidence.\n`).join(''));
 fs.writeFileSync(receiptFile, JSON.stringify({ version: 1, name, state: 'requested', sessionId: 'source', leafId: 'leaf', requestedAt: new Date().toISOString(), evidence: '/evidence', target, runtime: { provider: 'example-provider', model: 'vendor/example-model-1.3', thinking: 'medium', source: 'ctx' } }));
 const events = new Map();
 const commands = new Map();
 const calls = [];
 const notices = [];
 const sent = [];
 let choice = 'Save only';
 let idle = true;
 let failedCommand;
 const session = '/sessions/source.jsonl';
 const pi = new Proxy({
  on: (event, fn) => events.set(event, [...(events.get(event) ?? []), fn]),
  registerCommand: (name, command) => commands.set(name, command),
  sendUserMessage: message => sent.push(message),
  getThinkingLevel: () => 'medium',
  exec: async (_bin, args) => {
   calls.push(args);
   if (args[1] === failedCommand) return { code: 1, killed: false, stdout: '', stderr: 'private command failure' };
   let result = {};
   if (args[1] === 'get') result = { agent: { agent: 'pi', pane_id: args[2], cwd: root, foreground_cwd: root, agent_status: 'idle', agent_session: { kind: 'path', value: args[2] === 'w8:p13' ? session : '/sessions/successor.jsonl' } } };
   if (args[0] === 'tab') result = { root_pane: { pane_id: 'w8:p99' } };
   return { code: 0, killed: false, stdout: JSON.stringify({ result }), stderr: '' };
  },
 }, { get: (object, key) => key in object ? object[key] : () => {} });
 const ctx = { cwd: root, mode: 'tui', hasUI: true,
  model: { provider: 'example-provider', id: 'vendor/example-model-1.3' }, thinkingLevel: 'medium',
  isIdle: () => idle, hasPendingMessages: () => false,
  sessionManager: { getSessionId: () => 'source', getSessionFile: () => session, getLeafId: () => 'leaf' },
  ui: { select: async () => choice, notify: text => notices.push(text) },
 };
 promptr(pi);
 const emit = async event => { for (const fn of events.get(event) ?? []) await fn({}, ctx); };
 const readReceipt = () => JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
 try { await run({ events, commands, calls, notices, sent, ctx, emit, readReceipt,
  choose: value => { choice = value; }, busy: () => { idle = false; }, fail: value => { failedCommand = value; },
  wait: async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('host did not finish'); },
 }); } finally {
  await emit('session_shutdown');
  for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
  Object.assign(process.env, old);
  fs.rmSync(root, { recursive: true, force: true });
 }
}

test('handoff finishes after settled handlers, never agent_end; Save only never executes Herdr', async () => fixture(async h => {
 assert.equal(h.events.has('agent_end'), false);
 await h.emit('agent_settled');
 assert.equal(h.readReceipt().state, 'requested');
 await h.wait(() => h.notices.some(n => n.includes('Nothing launched')));
 assert.equal(h.readReceipt().state, 'saved');
 assert.equal(h.calls.length, 0);
 await h.emit('agent_settled');
 await delay(20);
 assert.equal(h.calls.length, 0);
}));

test('shutdown and busy source cancel deferred finalization', async () => {
 for (const action of ['shutdown', 'busy']) await fixture(async h => {
  await h.emit('agent_settled');
  if (action === 'shutdown') await h.emit('session_shutdown'); else h.busy();
  await delay(20);
  assert.equal(h.readReceipt().state, 'requested');
  assert.equal(h.calls.length, 0);
 });
});

test('host exec nonzero start refuses; nonzero prompt is uncertain and never replayed', async () => {
 for (const command of ['start', 'prompt']) await fixture(async h => {
  h.choose('Launch successor now'); h.fail(command);
  await h.emit('agent_settled');
  await h.wait(() => h.readReceipt().launch !== undefined);
  assert.equal(h.readReceipt().launch, command === 'start' ? 'refused' : 'uncertain');
  assert.equal(h.calls.filter(args => args[1] === 'prompt').length, command === 'start' ? 0 : 1);
  assert.ok(!h.notices.join('\n').includes('private command failure'));
  await h.emit('agent_settled'); await delay(20);
  assert.equal(h.calls.filter(args => args[1] === 'prompt').length, command === 'start' ? 0 : 1);
 });
});

test('Phase A pins the packaged skill instead of a similarly named global skill', async () => fixture(async h => {
 await h.commands.get('handoffr').handler('trial only', h.ctx);
 assert.equal(h.sent.length, 1);
 assert.match(h.sent[0], /skills\/promptr-handoff\/SKILL\.md/);
 assert.match(h.sent[0], /do not substitute another handoff skill/);
}));
