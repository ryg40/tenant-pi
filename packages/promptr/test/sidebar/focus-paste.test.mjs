// The sidebar's paste parser starts fresh at every focus boundary. A lone Esc that released focus must not
// join a later `[` into a held `ESC[` bracketed-paste prefix; that swallowed the next Esc and let later letters run
// sidebar actions instead of reaching the editor. Paste bytes still never become actions or sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sidebarSettingsPath } from '../../dist/src/sidebar/config.mjs';
import { controllerHarness, tick } from './controller-harness.mjs';

const ESC = '\x1b';
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
/** One terminal input event; true when the sidebar consumed it, false when it reaches Pi's editor. */
const key = (h, raw) => { for (const fn of [...h.listeners]) if (fn(raw)?.consume) return true; return false; };
const stack = h => h.tui.overlayStack.length;
const focusedStatus = async h => { await h.command('promptr', 'status'); return /, focused/.test(h.notices.at(-1)); };

/** Nothing was run: no dialog, no review, no queue or settings change, no send. */
function assertNoAction(h, bytes, message) {
  assert.equal(stack(h), 1, `${message}: only the sidebar entry`);
  assert.equal(h.counts().reviews, 0, message);
  assert.equal(h.counts().workspaces, 0, message);
  assert.deepEqual(h.sends, [], message);
  assert.equal(fs.readFileSync(h.store.paths.queue, 'utf8'), bytes, `${message}: queue unchanged`);
  assert.equal(fs.existsSync(sidebarSettingsPath()), false, `${message}: nothing saved`);
}

async function started(t, options) {
  const h = controllerHarness(t, 'tui', options);
  h.store.saveText('composer', '', 'Keep me');
  h.store.queueDraft();
  const bytes = fs.readFileSync(h.store.paths.queue, 'utf8');
  await h.emit('session_start'); await settle();
  assert.equal(stack(h), 1);
  return { h, bytes };
}

for (const proxy of [false, true]) test(`Alt+P, Esc, Alt+P, [, Esc releases focus and later typing reaches the editor${proxy ? ' (Pi proxy)' : ''}`, async t => {
  const { h, bytes } = await started(t, { proxy });
  await h.shortcut('alt+p');
  assert.equal(key(h, ESC), true, 'Esc releases the first focus');
  assert.equal(h.listeners.size, 0);
  await h.shortcut('alt+p');
  assert.equal(key(h, '['), true, '[ pages while focused');
  assert.equal(key(h, ESC), true);
  assert.equal(h.listeners.size, 0, 'the second Esc released focus');
  assert.equal(await focusedStatus(h), false);
  for (const typed of ['x', 'y', 'z', 'p', 's', 'd', 'u', 'q']) assert.equal(key(h, typed), false, `${typed} reaches the editor`);
  await settle();
  assertNoAction(h, bytes, 'typing after release');
});

test('focus boundaries (hide, narrow, shutdown and a new session) all start a fresh parser', async t => {
  const { h, bytes } = await started(t);
  const boundaries = {
    hide: async () => { await h.command('promptr', 'off'); await h.command('promptr', 'on'); await settle(); },
    narrow: async () => {
      h.tui.terminal.columns = 91;
      assert.equal(key(h, 'x'), false, 'a narrow terminal releases focus and passes the key on');
      h.tui.terminal.columns = 140;
    },
    'alt+shift+p': async () => { assert.equal(key(h, '\x1bP'), true); await h.shortcut('alt+shift+p'); await settle(); },
    'session replacement': async () => {
      await h.emit('session_shutdown'); await settle();
      h.state.sessionId = `next-${Math.random()}`;
      await h.emit('session_start'); await settle();
    },
  };
  for (const [name, cross] of Object.entries(boundaries)) {
    await h.shortcut('alt+p');
    assert.equal(h.listeners.size, 1, `${name}: focused`);
    // An input event that ends in a lone ESC leaves the parser holding it for a following `[`.
    assert.equal(key(h, `a${ESC}`), true);
    await cross();
    assert.equal(h.listeners.size, 0, `${name}: released`);
    await h.shortcut('alt+p');
    assert.equal(h.listeners.size, 1, `${name}: focused again`);
    assert.equal(key(h, '['), true);
    assert.equal(key(h, ESC), true);
    assert.equal(h.listeners.size, 0, `${name}: Esc released after [`);
    assert.equal(key(h, 'p'), false, `${name}: p reaches the editor`);
    await settle();
    assertNoAction(h, bytes, name);
  }
});

test('fragmented and whole bracketed pastes never become actions or sends while focused', async t => {
  const { h, bytes } = await started(t);
  await h.shortcut('alt+p');
  for (const part of ['\x1b[20', '0~q', 's\x1b[201', '~']) assert.equal(key(h, part), true, JSON.stringify(part));
  for (const whole of ['\x1b[200~p\x1b[201~', '\x1b[200~d\r\x1b[201~', 'sq']) assert.equal(key(h, whole), true, JSON.stringify(whole));
  await settle();
  assertNoAction(h, bytes, 'pastes while focused');
  assert.equal(h.listeners.size, 1, 'still focused');
  assert.equal(key(h, ESC), true);
  assert.equal(h.listeners.size, 0);
});

test('a bracketed paste still open at a focus boundary stays dropped after refocus', async t => {
  const { h, bytes } = await started(t);
  await h.shortcut('alt+p');
  assert.equal(key(h, '\x1b[200~pasted'), true, 'the paste opens');
  h.tui.terminal.columns = 91;
  assert.equal(key(h, 'x'), false, 'narrow releases focus');
  h.tui.terminal.columns = 140;
  await h.shortcut('alt+p');
  assert.equal(key(h, 'q'), true);
  assert.equal(key(h, 'p\x1b[201~'), true, 'the remaining paste bytes are dropped');
  await settle();
  assertNoAction(h, bytes, 'paste tail');
  assert.equal(key(h, ESC), true);
  assert.equal(h.listeners.size, 0, 'Esc releases after the paste ends');
});
