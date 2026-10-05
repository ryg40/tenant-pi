// Send guard: pure decision table, review status line, synchronous status probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPiStatusNow, reviewStatusLine, sendGuardDecision } from '../../dist/src/companion/send-guard.mjs';
import { buildHerdrPromptArgs } from '../../dist/src/companion/spike.mjs';

const WORKING_MSG = 'left Pi is working — Enter again submits into the running turn; Esc keeps the queue';
const BLOCKED_MSG = 'left Pi is blocked (approval/question) — resolve it in the left pane first; queue kept';

test('sendGuardDecision: idle and unknown submit regardless of arming', () => {
  for (const status of ['idle', 'unknown']) {
    assert.deepEqual(sendGuardDecision(status, false), { action: 'submit' });
    assert.deepEqual(sendGuardDecision(status, true), { action: 'submit' });
  }
});

test('sendGuardDecision: working arms first, submits when armed', () => {
  assert.deepEqual(sendGuardDecision('working', false), { action: 'arm', message: WORKING_MSG });
  assert.deepEqual(sendGuardDecision('working', true), { action: 'submit' });
});

test('sendGuardDecision: blocked refuses even when armed', () => {
  assert.deepEqual(sendGuardDecision('blocked', false), { action: 'refuse', message: BLOCKED_MSG });
  assert.deepEqual(sendGuardDecision('blocked', true), { action: 'refuse', message: BLOCKED_MSG });
});

test('direct send builds exact argv for the current alphanumeric Herdr pane', () => {
  assert.deepEqual(buildHerdrPromptArgs('wR:p1', 'exact prompt'), ['agent', 'prompt', 'wR:p1', 'exact prompt']);
  assert.equal(buildHerdrPromptArgs('bad:p1', 'exact prompt'), undefined);
  assert.equal(buildHerdrPromptArgs('wR:p1\n', 'exact prompt'), undefined);
});

test('reviewStatusLine names the pane and status, or says nothing will be sent', () => {
  assert.equal(reviewStatusLine('w8:p2', 'idle'), 'Target: left Pi w8:p2 · status idle');
  assert.equal(reviewStatusLine('w8:p2', 'blocked'), 'Target: left Pi w8:p2 · status blocked');
  assert.equal(reviewStatusLine(undefined, 'idle'), 'Target: no --pi-pane (nothing will be sent)');
  assert.equal(reviewStatusLine('', 'idle'), 'Target: no --pi-pane (nothing will be sent)');
});

function fakeRunner(result) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (typeof result === 'function') return result();
    return result;
  };
  return { run, calls };
}

const idleJson = JSON.stringify({ result: { pane: { agent_status: 'idle' } } });

test('readPiStatusNow: parses idle JSON with the exact argv and a 5 s timeout', () => {
  const { run, calls } = fakeRunner({ status: 0, stdout: idleJson });
  assert.equal(readPiStatusNow('w8:p2', run), 'idle');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'herdr');
  assert.deepEqual(calls[0].args, ['pane', 'get', 'w8:p2']);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.encoding, 'utf8');
});

test('readPiStatusNow: working and blocked pass through', () => {
  const json = (status) => JSON.stringify({ result: { pane: { agent_status: status } } });
  assert.equal(readPiStatusNow('p', fakeRunner({ status: 0, stdout: json('working') }).run), 'working');
  assert.equal(readPiStatusNow('p', fakeRunner({ status: 0, stdout: json('blocked') }).run), 'blocked');
});

test('readPiStatusNow: garbage, non-zero exit, error, timeout and throw all yield unknown', () => {
  assert.equal(readPiStatusNow('p', fakeRunner({ status: 0, stdout: 'not json' }).run), 'unknown');
  assert.equal(readPiStatusNow('p', fakeRunner({ status: 0, stdout: null }).run), 'unknown');
  assert.equal(readPiStatusNow('p', fakeRunner({ status: 1, stdout: idleJson }).run), 'unknown');
  assert.equal(readPiStatusNow('p', fakeRunner({ status: null, stdout: '', error: new Error('ENOENT') }).run), 'unknown');
  const timeout = Object.assign(new Error('spawnSync herdr ETIMEDOUT'), { code: 'ETIMEDOUT' });
  assert.equal(readPiStatusNow('p', fakeRunner({ status: null, stdout: '', error: timeout }).run), 'unknown');
  assert.equal(readPiStatusNow('p', fakeRunner(() => { throw new Error('boom'); }).run), 'unknown');
});
