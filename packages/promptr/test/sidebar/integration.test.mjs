// Acceptance: the adopted sidebar keeps Promptr drafts, queue, notebook, tasks and explicit commands.
// Temporary PI_CODING_AGENT_DIR/HOME only; the model-send sink is a fake array. No Herdr, no network, no Git in untrusted runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import promptr from '../../dist/src/extension/index.mjs';
import { parseQueue } from '../../dist/src/queue/pending.mjs';
import { projectPaths } from '../../dist/src/state/paths.mjs';
import { promptLogFiles } from '../../dist/src/sync/prompt-log.mjs';
import { SIDEBAR_IMPLEMENTATION, SIDEBAR_MODE_NOTICE, sidebarChartGraphics } from '../../dist/src/sidebar/controller.mjs';
import { sidebarSettingsPath } from '../../dist/src/sidebar/config.mjs';
import { UNSUPPORTED_LAYOUT_MESSAGE } from '../../dist/src/sidebar/vendor/split-pane.mjs';
import { controllerHarness, terminal, tick } from './controller-harness.mjs';

const ESC = '\x1b';
const ENTER = '\r';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const RIGHT = '\x1b[C';
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
const settingsFile = () => sidebarSettingsPath();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
/** Focus the sidebar with Alt+P, then press one key. */
async function act(h, key) { await h.shortcut('alt+p'); h.press(key); await settle(); }

/** The whole Promptr extension (index.mts) with a fake send sink; HOME is temporary too. */
function extension(t, mode = 'tui', options = {}) {
  const home = process.env.HOME;
  const h = controllerHarness(t, mode, { ...options, register: pi => promptr(pi) });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  return h;
}

test('Controls: compose, notebook, queue, refresh, remove-one, workspace, panels and usage each run one explicit dialog', async t => {
  const h = controllerHarness(t, 'tui', { select: labels => labels[1] });
  await h.emit('session_start');
  assert.ok(h.sidebar(), 'startup shows the passive sidebar');
  assert.equal(h.listeners.size, 0, 'the passive sidebar owns no input');
  await act(h, 'c');
  assert.equal(h.store.read().composer, 'Draft from editor');
  h.edit(async (title, prefill) => { assert.match(title, /notebook/i); assert.equal(prefill, ''); return 'Owner note\nline 2'; });
  await act(h, 'n');
  assert.equal(h.store.read().note, 'Owner note\nline 2');
  assert.deepEqual(h.records.at(-1).slice(3), ['Owner note\nline 2'], 'note revision goes to the prompt-log hook');
  await act(h, 'q'); await act(h, 'q');
  assert.equal(h.store.read().queue.items.length, 2);
  assert.equal(h.store.read().composer, 'Draft from editor', 'queueing retains the draft');
  await act(h, 'r');
  assert.ok(h.sidebar().render(44).join('\n').includes('Refreshed'));
  const before = h.store.read().queue;
  await act(h, 'd');
  const after = h.store.read().queue;
  assert.deepEqual(after.items.map(i => i.id), [before.items[0].id], 'exactly the selected item is removed');
  assert.equal(after.revision, before.revision + 1);
  await act(h, 'w');
  assert.equal(h.counts().workspaces, 1);
  await act(h, 'p');
  assert.ok(h.dialog(), 'panel settings screen opened');
  h.dialog().handleInput(ESC); await settle();
  assert.equal(fs.existsSync(settingsFile()), false, 'cancel writes no settings file');
  await act(h, 'u');
  assert.match(h.notices.at(-1), /trusted project/, 'usage refuses an untrusted project and reads nothing');
  assert.equal(h.counts().reviews, 0, 'no action sent anything');
  assert.equal(h.sends.length, 0);
  assert.ok(h.sidebar(), 'the sidebar is remounted after every dialog');
  assert.equal(h.listeners.size, 0, 'dialogs return focus to the Pi editor');
});

test('remove-one checks the queue revision and a cancelled picker changes nothing', async t => {
  let external;
  const h = controllerHarness(t, 'tui', { select: labels => { external?.(); return labels[0]; } });
  h.store.saveText('composer', '', 'Keep me');
  h.store.queueDraft();
  await h.emit('session_start');
  external = () => h.store.queueDraft();
  await act(h, 'd');
  assert.match(h.notices.at(-1), /Queue changed/);
  assert.equal(h.store.read().queue.items.length, 2, 'the stale remove removed nothing');
  external = undefined;
  const cancel = controllerHarness(t, 'tui', { select: () => undefined });
  cancel.store.saveText('composer', '', 'Stay');
  cancel.store.queueDraft();
  const bytes = fs.readFileSync(cancel.store.paths.queue, 'utf8');
  await cancel.emit('session_start');
  await act(cancel, 'd');
  assert.equal(fs.readFileSync(cancel.store.paths.queue, 'utf8'), bytes);
});

test('review/send: one explicit item through the existing manual-send guards; cancel, no retry, no removal', async t => {
  const h = extension(t);
  h.store.saveText('composer', '', 'Exact\nprompt text');
  h.store.queueDraft();
  await h.emit('session_start');
  await act(h, 's');
  assert.ok(h.dialog(), 'review dialog is open');
  h.dialog().handleInput(ESC); await settle();
  assert.equal(h.sends.length, 0, 'cancel sends nothing');
  h.state.idle = false;
  await act(h, 's');
  assert.match(h.notices.at(-1), /idle/); assert.equal(h.sends.length, 0);
  h.state.idle = true; h.state.pending = true;
  await act(h, 's');
  assert.match(h.notices.at(-1), /idle/); assert.equal(h.sends.length, 0);
  h.state.pending = false;
  await act(h, 's');
  h.state.leaf = 'moved';
  h.dialog().handleInput(ENTER); await settle();
  assert.equal(h.sends.length, 0, 'a session change during review attempts nothing');
  assert.match(h.notices.at(-1), /Nothing attempted/);
  await act(h, 's');
  h.dialog().handleInput(ENTER); await settle();
  assert.deepEqual(h.sends, [{ text: 'Exact\nprompt text', opts: { expandPromptTemplates: false } }]);
  assert.match(h.notices.at(-1), /attempted/i);
  await act(h, 's');
  assert.equal(h.sends.length, 1, 'no automatic retry');
  assert.match(h.notices.at(-1), /Already attempted/);
  assert.equal(h.store.read().queue.items.length, 1, 'the attempted item is retained, not marked delivered');
  assert.ok(h.sidebar().render(44).some(line => line.includes('? Exact')), 'attempted-but-unconfirmed is shown as ?');
});

test('empty queue review sends nothing and says what to do', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start');
  await act(h, 's');
  assert.equal(h.counts().reviews, 0);
  assert.match(h.notices.at(-1), /Queue is empty/);
});

test('stored draft, queue, notebook and prompt-log stay compatible with existing Promptr workflows', async t => {
  const h = extension(t);
  await h.emit('session_start');
  const paths = projectPaths(h.root);
  assert.equal(fs.existsSync(paths.dir), false, 'startup writes no sample notebook or state');
  h.edit(async () => 'Queued exact text');
  await act(h, 'c'); await act(h, 'q');
  h.edit(async () => 'Notebook line');
  await act(h, 'n');
  assert.equal(h.store.paths.dir, paths.dir, 'same project ID as the workspace and companion');
  assert.equal(fs.readFileSync(paths.composer, 'utf8'), 'Queued exact text');
  assert.equal(fs.readFileSync(paths.scratch, 'utf8'), 'Notebook line');
  const queue = parseQueue(fs.readFileSync(paths.queue, 'utf8'));
  assert.equal(queue.items.length, 1); assert.equal(queue.items[0].text, 'Queued exact text');
  const log = fs.readFileSync(promptLogFiles(paths.dir).log, 'utf8');
  assert.match(log, /Queued exact text/); assert.match(log, /note-revision/);
  h.edit(async () => 'café');
  await act(h, 'n');
  assert.match(h.notices.at(-1), /ASCII/);
  assert.equal(fs.readFileSync(paths.scratch, 'utf8'), 'Notebook line', 'non-ASCII edits are refused, not stored');
  fs.writeFileSync(paths.queue, 'owner broken queue');
  await act(h, 'q');
  assert.equal(fs.readFileSync(paths.queue, 'utf8'), 'owner broken queue', 'a corrupt queue blocks writes');
  const text = h.sidebar().render(60).join('\n');
  assert.match(text, /Queue unreadable/);
});

test('shutdown during an open editor, picker or settings screen saves nothing and never revives the sidebar', async t => {
  const h = controllerHarness(t, 'tui', { select: (_labels, opts) => new Promise(resolve => opts.signal.addEventListener('abort', () => resolve(undefined))) });
  let resolveEditor;
  h.edit(() => new Promise(resolve => { resolveEditor = resolve; }));
  await h.emit('session_start');
  await h.shortcut('alt+p'); h.press('n');
  await h.emit('session_shutdown'); resolveEditor('Late note'); await settle();
  assert.equal(h.store.read().note, ''); assert.equal(h.counts().active, 0); assert.equal(h.listeners.size, 0);

  const p = controllerHarness(t);
  await p.emit('session_start');
  void p.command('promptr', 'panels'); await settle();
  assert.ok(p.dialog());
  p.dialog().handleInput(' ');
  await p.emit('session_shutdown'); await settle();
  assert.equal(p.counts().active, 0, 'the settings screen is closed on shutdown');
  assert.equal(fs.existsSync(settingsFile()), false);

  const r = controllerHarness(t, 'tui', { select: (_labels, opts) => new Promise(resolve => opts.signal.addEventListener('abort', () => resolve(undefined))) });
  r.store.saveText('composer', '', 'Keep');
  r.store.queueDraft();
  await r.emit('session_start');
  await r.shortcut('alt+p'); r.press('d'); await settle();
  await r.emit('session_shutdown'); await settle();
  assert.equal(r.store.read().queue.items.length, 1, 'the aborted picker removed nothing');
  assert.equal(r.counts().active, 0); assert.equal(r.listeners.size, 0);
  await r.shortcut('alt+p');
  assert.equal(r.counts().active, 1, 'only an explicit action opens a new sidebar');
});

test('focus release, paste safety, repeated commands, hide/show and narrow-mode input', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start');
  const handlers = name => (h.events.get(name) ?? []).length;
  const turnHandlers = handlers('turn_start');
  for (let i = 0; i < 3; i++) { await h.command('promptr'); await h.command('coordinatr'); }
  assert.equal(h.counts().active, 1, 'one sidebar');
  assert.equal(h.listeners.size, 0);
  assert.equal(handlers('turn_start'), turnHandlers, 'one telemetry runtime');
  await h.shortcut('alt+p');
  assert.equal(h.listeners.size, 1);
  h.press('\x1b[200~s\x1b[201~'); h.press('sq'); await settle();
  assert.equal(h.counts().reviews, 0, 'pasted or combined text is never an action');
  h.press(ESC);
  assert.equal(h.listeners.size, 0, 'Esc returns input to Pi');
  await h.shortcut('alt+p');
  await h.shortcut('alt+shift+p');
  assert.equal(h.listeners.size, 0); assert.equal(h.counts().active, 0, 'hiding releases input and the overlay');
  await h.shortcut('alt+shift+p');
  assert.equal(h.counts().active, 1);
  await h.shortcut('alt+p');
  h.tui.terminal.columns = 80;
  let consumed;
  for (const fn of [...h.listeners]) consumed = fn('s');
  assert.equal(consumed, undefined, 'narrow mode passes the key to Pi');
  assert.equal(h.listeners.size, 0); assert.equal(h.counts().reviews, 0);
  await h.command('promptr', 'off');
  await h.emit('session_shutdown');
  assert.equal(handlers('turn_start'), turnHandlers - 1, 'telemetry handlers are unsubscribed on shutdown');
});

test('panel commands and the settings screen save the same configuration; width is saved by both', async t => {
  const a = controllerHarness(t);
  await a.emit('session_start');
  for (const args of ['panel notebook off', 'move tasks 5', 'width 52', 'startup off']) await a.command('promptr', args);
  const viaCommands = fs.readFileSync(settingsFile(), 'utf8');
  assert.match(a.notices.at(-1), /Saved/);
  await a.command('promptr', 'status');
  assert.match(a.notices.at(-1), /Width: 52 \(saved 52/);

  const b = controllerHarness(t);
  await b.emit('session_start');
  const opened = b.command('promptr', 'panels'); await settle();
  const keys = (...list) => list.forEach(key => b.dialog().handleInput(key));
  keys(DOWN, DOWN, DOWN, ENTER);            // Notebook off (position 4)
  keys(UP, 'm', '5', ENTER);                 // Tasks to position 5
  keys(...Array(10).fill(DOWN), ENTER);      // Startup row: stay hidden
  keys(DOWN, ...Array(8).fill(RIGHT));       // Width 44 -> 52
  keys('S');
  await opened; await settle();
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), viaCommands);
  await b.command('promptr', 'status');
  assert.match(b.notices.at(-1), /Width: 52 \(saved 52/);
  await b.command('promptr', 'width 99');
  assert.match(b.notices.at(-1), /not saved/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), viaCommands, 'an invalid width changes nothing');
});

test('startup visibility and saved width are honored; resize saves only when finished', async t => {
  const h = controllerHarness(t);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ version: 1, showSidebarOnStartup: false, sidebarWidth: 60 }));
  const original = fs.readFileSync(settingsFile(), 'utf8');
  await h.emit('session_start');
  assert.equal(h.counts().active, 0, 'startup off keeps the sidebar hidden');
  await h.command('promptr');
  for (let i = 0; i < 20; i++) h.sidebar().render(60);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), original, 'rendering never writes settings');
  await h.command('promptr', 'resize');
  h.press('\x1b[D'); h.press(ESC); await settle();
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), original, 'a cancelled resize saves nothing');
  await h.command('promptr', 'resize');
  h.press('\x1b[D'); h.press(ENTER); await settle();
  assert.equal(readJson(settingsFile()).sidebarWidth, 61, 'a finished resize is saved');
  assert.equal(readJson(settingsFile()).showSidebarOnStartup, false, 'other saved settings are kept');
});

test('an invalid settings file warns once, keeps defaults and blocks every save', async t => {
  const h = controllerHarness(t);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), '{ owner broken');
  await h.emit('session_start');
  assert.equal(h.notices.filter(n => /settings/.test(n)).length, 1);
  assert.ok(h.sidebar(), 'defaults apply in memory');
  for (const args of ['width 50', 'panel notebook off', 'startup off']) await h.command('promptr', args);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ owner broken');
  await h.command('promptr', 'status');
  assert.match(h.notices.at(-1), /invalid, defaults in use, saving blocked/);
});

test('status names the implementation, version, width, settings path and all-off/overflow/layout state', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start');
  h.sidebar().render(44);
  await h.command('promptr', 'status');
  const status = h.notices.at(-1);
  assert.ok(status.includes(SIDEBAR_IMPLEMENTATION)); assert.match(status, /pi-atelier v0\.12\.0/);
  assert.match(status, /Width: 44/); assert.ok(status.includes(settingsFile()));
  assert.match(status, /Panels: 14 of 14 on/); assert.match(status, /Overflow: \d+ panel\(s\) above, \d+ below/);
  assert.match(status, /Layout: recognized/); assert.match(status, /footer-only/); assert.match(status, /coordinatr-herdr/);
  for (const id of ['agent', 'activity', 'tasks', 'notebook', 'queue', 'draft', 'alerts', 'todos', 'context', 'workspace', 'usage', 'subagents', 'tools', 'controls'])
    await h.command('promptr', `panel ${id} off`);
  await h.command('promptr', 'status');
  assert.match(h.notices.at(-1), /Panels: all 14 off\. Restore with \/promptr panels/);
  assert.ok(h.commands.get('promptr'), 'commands stay available with Controls hidden');
  await h.command('promptr', 'bogus');
  assert.match(h.notices.at(-1), /^Unknown \/promptr option "bogus"\. \/promptr \[/);

  const u = controllerHarness(t, 'tui', { layout: false });
  await u.emit('session_start');
  assert.equal(u.notices.filter(n => n === UNSUPPORTED_LAYOUT_MESSAGE).length, 1);
  await u.shortcut('alt+p');
  assert.equal(u.notices.at(-1), UNSUPPORTED_LAYOUT_MESSAGE);
  assert.equal(u.listeners.size, 0);
  await u.command('promptr', 'status');
  assert.match(u.notices.at(-1), /Layout: unsupported/);
});

test('overflow keys page through all panels via nextPanelOffset', async t => {
  const h = controllerHarness(t);
  h.tui.terminal.rows = 24;
  await h.emit('session_start');
  const titles = () => [...h.sidebar().render(44).join('\n').matchAll(/╭─ ✦ ([A-Z]+)/g)].map(m => m[1]);
  const seen = new Set(titles());
  const first = titles()[0];
  await h.shortcut('alt+p');
  for (let i = 0; i < 14; i++) { h.press(']'); titles().forEach(id => seen.add(id)); }
  assert.equal(seen.size, 14, `all 14 panels reachable: ${[...seen].join(',')}`);
  for (let i = 0; i < 14; i++) h.press('\x1b[5~');
  assert.equal(titles()[0], first, 'PgUp returns to the first panel');
});

test('chart graphics: suspended only under a capturing dialog, never under the non-capturing sidebar', () => {
  const tui = new TuiMainScreen(terminal());
  tui.requestRender = () => {};
  const owner = {};
  assert.deepEqual(sidebarChartGraphics(tui, owner), { imageOwner: owner, suspendPlot: false });
  const sidebar = tui.showOverlay({ render: () => [], invalidate() {} }, { nonCapturing: true });
  assert.equal(sidebarChartGraphics(tui, owner).suspendPlot, false);
  const dialog = tui.showOverlay({ render: () => [], invalidate() {} }, {});
  assert.equal(sidebarChartGraphics(tui, owner).suspendPlot, true);
  dialog.hide(); sidebar.hide();
  assert.equal(sidebarChartGraphics(tui, owner).suspendPlot, false);
  assert.equal(sidebarChartGraphics({}, owner).suspendPlot, true, 'an unknown renderer keeps the plot suspended');
});

test('untrusted startup runs no Git; the inline prototype git snapshot is gone', async t => {
  const calls = [];
  for (const name of ['execFileSync', 'spawnSync', 'execSync', 'execFile', 'spawn']) t.mock.method(childProcess, name, (...args) => { calls.push([name, args[0], ...(args[1] ?? [])].join(' ')); throw new Error('blocked'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const h = controllerHarness(t);
  await h.emit('session_start');
  h.sidebar().render(44);
  assert.deepEqual(calls, []);
  const trusted = controllerHarness(t, 'tui', { trusted: true });
  await trusted.emit('session_start');
  assert.ok(calls.length > 0, 'positive control: the spy sees the trusted tracker-remote lookup');
  assert.ok(calls.every(call => /remote get-url origin/.test(call)), `trusted startup only infers the tracker remote: ${calls.join(' | ')}`);
});

test('all existing commands still register; the legacy Herdr launcher is explicit and F6 is free', async t => {
  const herdr = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  t.after(() => { if (herdr !== undefined) process.env.HERDR_ENV = herdr; });
  const h = extension(t);
  assert.deepEqual([...h.commands.keys()].sort(), ['coordinatr', 'coordinatr-herdr', 'handoffr', 'promptr', 'promptr-autocheck',
    'promptr-catchup', 'promptr-collapse', 'promptr-doctor', 'promptr-expand', 'promptr-fold', 'promptr-resume', 'promptr-save', 'promptr-status', 'promptr-tracker', 'promptr-workflows', 'work-status']);
  assert.deepEqual([...h.shortcuts.keys()].sort(), ['alt+p', 'alt+shift+p']);
  assert.match(h.commands.get('coordinatr-herdr').description, /^Legacy Herdr launcher/);
  await h.emit('session_start');
  await h.command('coordinatr');
  assert.equal(h.counts().launches, 0, '/coordinatr shows the sidebar, never Herdr');
  assert.equal(h.counts().active, 1);
  await h.command('coordinatr-herdr');
  assert.match(h.notices.at(-1), /needs Herdr/);
  assert.equal(h.counts().launches, 0);
  const saved = Object.fromEntries(['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w9:p1', HERDR_WORKSPACE_ID: 'w9', HERDR_TAB_ID: 'w9:t1' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  await h.command('coordinatr-herdr', 'help');
  assert.match(h.notices.at(-1), /^\/coordinatr-herdr \[status\|pause\|resume\|off\|recover\] — bare \/coordinatr-herdr ensures/);
  assert.equal(h.counts().launches, 0);
});

for (const mode of ['rpc', 'json', 'print']) test(`fresh ${mode} startup exposes commands without UI, sends, Herdr or startup writes`, async t => {
  const h = extension(t, mode);
  assert.ok(h.commands.get('promptr') && h.commands.get('coordinatr'));
  await h.emit('session_start');
  await h.emit('agent_start'); await h.emit('agent_settled'); await settle();
  for (const args of ['', 'focus', 'panel notebook off', 'width 50', 'usage', 'workspace', 'status']) {
    await h.command('promptr', args);
    assert.equal(h.notices.at(-1), SIDEBAR_MODE_NOTICE, args);
  }
  await h.shortcut('alt+p');
  assert.equal(h.counts().active, 0); assert.equal(h.listeners.size, 0);
  assert.equal(h.sends.length, 0); assert.equal(h.counts().launches, 0);
  assert.equal(fs.existsSync(path.join(h.root, 'agent')), false, 'nothing was written');
});
