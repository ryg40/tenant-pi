import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth, TuiMainScreen, TuiAltScreen, VStack, ScrollView } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { SidebarStore } from '../../dist/src/sidebar/store.mjs';
import { emptyQueue } from '../../dist/src/queue/pending.mjs';
import { renderSidebar, sidebarInput, safeLine } from '../../dist/src/sidebar/view.mjs';
import { createSplitPaneController } from '../../dist/src/sidebar/vendor/split-pane.mjs';
import { mountPiLayout } from './pi-layout-fixture.mjs';
import { controllerHarness, fixture, terminal, theme, tick } from './controller-harness.mjs';

test('read/hide fallback never creates state; text save detects an external edit', t => {
  const { store } = fixture(t);
  assert.equal(store.read().note, '');
  assert.equal(fs.existsSync(store.paths.dir), false);
  store.saveText('note', '', 'Owner note');
  assert.throws(() => store.saveText('note', '', 'Lost note'), /changed elsewhere/);
  assert.equal(store.read().note, 'Owner note');
  assert.throws(() => store.saveText('note', 'Owner note', '\x1b[31m'), /ASCII/);
});

test('queue keeps exact draft and requires current revision for removal', t => {
  const { store } = fixture(t);
  store.saveText('composer', '', 'One\nexact draft');
  const queued = store.queueDraft();
  assert.equal(queued.items[0].text, 'One\nexact draft');
  assert.equal(store.read().composer, 'One\nexact draft');
  store.queueDraft();
  assert.throws(() => store.remove(queued.items[0].id, queued.revision), /Queue changed/);
  const next = store.read().queue;
  assert.equal(store.remove(next.items[0].id, next.revision).items.length, 1);
});

test('corrupt queue is reported and never replaced by an empty fallback', t => {
  const { store } = fixture(t);
  fs.mkdirSync(store.paths.dir, { recursive: true });
  fs.writeFileSync(store.paths.queue, 'owner broken queue');
  store.saveText('composer', '', 'New draft');
  assert.match(store.read().error, /unreadable/);
  assert.throws(() => store.queueDraft(), /blocked/);
  assert.equal(fs.readFileSync(store.paths.queue, 'utf8'), 'owner broken queue');
});

test('sidebar renderer fits narrow/wide/short terminals and strips hostile display controls', () => {
  const s = { queue: emptyQueue(), composer: 'wide 中文 é 👨‍💻\x1b]52;c;secret\x07', note: 'Note', error: '',
    project: 'Project 中文', model: 'model'.repeat(40), activity: 'Idle', context: '50% context', git: 'branch',
    tracking: ['Tasks \x1b[2J unsafe'], focused: true, busy: false, selected: 6, attempted: new Set(), notice: '' };
  for (const width of [0, 1, 3, 10, 28, 44, 72, 120]) for (const height of [0, 1, 4, 12, 24, 30, 45, 80]) {
    const lines = renderSidebar(s, width, height, theme);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}x${height}`);
    assert.ok(lines.every(line => !line.includes('secret') && !line.includes('\x1b]52') && !line.includes('\x1b[2J')));
    if (width >= 44 && height >= 12) assert.ok(lines.some(line => line.includes('Remove queued')));
  }
  assert.equal(safeLine('\x1b]52;c;secret\x07hello\x1b[2J'), 'hello');
});

test('keys navigate actions; plain text, combined keys and paste cannot accidentally send', () => {
  assert.equal(sidebarInput('\x1b[A', 0).selected, 6);
  assert.equal(sidebarInput('\x1b[B', 6).selected, 0);
  assert.equal(sidebarInput('s', 0).action, 'review');
  assert.equal(sidebarInput('\r', 0).action, 'compose');
  assert.equal(sidebarInput('\x1b', 0).release, true);
  assert.equal(sidebarInput('some pasted text', 0).action, undefined);
  assert.equal(sidebarInput('\x1b[200~s\x1b[201~', 0).action, undefined);
});

for (const mode of ['regular', 'fullscreen']) test(`split adapter reserves space and restores ${mode} renderer`, () => {
  const tui = mode === 'regular' ? new TuiMainScreen(terminal()) : new TuiAltScreen(terminal());
  tui.requestRender = () => {};
  // The sidebar only splits Pi's real transcript + dock layout.
  const parts = mountPiLayout(tui);
  const root = parts.root;
  const baseRender = tui.render;
  const baseOverlay = tui.showOverlay;
  const split = createSplitPaneController();
  split.attach(tui); split.show();
  const handle = tui.showOverlay({ render: () => ['Sidebar'], invalidate() {} }, split.overlayOptions());
  assert.equal(split.isVisibleAtWidth(91), false);
  assert.equal(split.isVisibleAtWidth(92), true);
  if (mode === 'regular') { tui.render(140); assert.equal(parts.chat.widths.at(-1), 96); }
  else { assert.notEqual(tui.layoutRoot, root); assert.equal(typeof handle.getBounds, 'function'); }
  split.setSidebarWidth(999); assert.equal(split.getSidebarWidth(), 72);
  split.hide(); handle.hide(); split.dispose(); split.dispose();
  assert.equal(tui.render, baseRender);
  assert.equal(tui.showOverlay, baseOverlay);
  if (mode === 'fullscreen') assert.equal(tui.layoutRoot, root);
});

for (const mode of ['regular', 'fullscreen']) test(`${mode} sidebar preserves the full-width editor and four-line footer`, () => {
  const term = terminal();
  const tui = mode === 'regular' ? new TuiMainScreen(term) : new TuiAltScreen(term);
  tui.requestRender = () => {};
  const widths = new Map();
  const make = (name, count) => ({ render(width) { widths.set(name, width); return Array.from({ length: count }, (_, i) => `${name}-${i}`); }, invalidate() {} });
  const document = make('chat', 4), editor = make('editor', 3), footer = make('footer', 4);
  const empty = make('empty', 0);
  const dock = new VStack([empty, empty, empty, editor, empty, footer]);
  const root = new VStack([{ component: new ScrollView(document), basis: 0, grow: 1, minSize: 1 },
    { component: dock, basis: 'auto', minSize: 1 }]);
  if (mode === 'fullscreen') tui.setLayoutRoot(root);
  else for (const child of [document, empty, empty, empty, editor, empty, footer]) tui.addChild(child);
  const split = createSplitPaneController(); split.attach(tui); split.show();
  tui.showOverlay({ render: () => Array(split.getSidebarHeight()).fill('SIDEBAR MENU'), invalidate() {} }, split.overlayOptions());
  for (const [width, height, footerRows] of [[140, 63, 4], [100, 30, 4], [80, 24, 4], [140, 45, 6]]) {
    term.columns = width; term.rows = height;
    footer.render = w => { widths.set('footer', w); return Array.from({ length: footerRows }, (_, i) => `footer-${i}`); };
    split.requestRender();
    const lines = mode === 'fullscreen' ? renderLayoutFrame(tui.layoutRoot, width, height, () => {}).lines : tui.render(width);
    assert.equal(widths.get('editor'), width);
    assert.equal(widths.get('footer'), width);
    assert.equal(widths.get('chat'), width < 92 ? width : width - Math.min(44, width - 64));
    assert.ok(lines.slice(-footerRows).every((line, i) => line.startsWith(`footer-${i}`)));
    assert.ok(lines.slice(-(footerRows + 3)).every(line => !line.includes('SIDEBAR MENU')));
    if (width >= 92) assert.equal(split.getSidebarHeight(), height - footerRows - 3);
  }
  split.dispose();
  if (mode === 'fullscreen') assert.equal(tui.layoutRoot, root);
});

test('startup is passive; focus, compose, queue, review and shutdown are bounded', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start');
  assert.equal(h.counts().launches, 0); assert.equal(h.counts().active, 1);
  assert.equal(fs.existsSync(h.store.paths.dir), false);
  h.press('c'); await tick(); assert.equal(h.store.read().composer, '');
  await h.shortcuts.get('alt+p').handler(h.ctx);
  h.press('\x1bp'); h.press('s'); await tick(); assert.equal(h.counts().reviews, 0);
  await h.shortcuts.get('alt+p').handler(h.ctx);
  h.press('\x1b[200~s\x1b[201~'); await tick(); assert.equal(h.counts().reviews, 0);
  h.press('c'); await tick();
  assert.equal(h.store.read().composer, 'Draft from editor');
  await h.shortcuts.get('alt+p').handler(h.ctx); h.press('q'); await tick();
  assert.equal(h.store.read().queue.items.length, 1);
  assert.equal(h.records.length, 1);
  await h.shortcuts.get('alt+p').handler(h.ctx); h.press('s'); await tick();
  assert.equal(h.counts().reviews, 1);
  await h.commands.get('coordinatr').handler('off', h.ctx); await tick();
  assert.equal(h.listeners.size, 0); assert.equal(h.counts().active, 0);
  await h.commands.get('promptr').handler('', h.ctx); await tick();
  assert.equal(h.store.read().queue.items.length, 1);
  await h.emit('session_shutdown'); await tick();
  assert.equal(h.listeners.size, 0); assert.equal(h.counts().active, 0);
  assert.equal(h.counts().launches, 0);
});

test('session change while editing cancels save and sidebar revival', async t => {
  const h = controllerHarness(t);
  let resolveEditor;
  h.edit(() => new Promise(resolve => { resolveEditor = resolve; }));
  await h.emit('session_start'); await h.shortcuts.get('alt+p').handler(h.ctx);
  h.press('c'); await h.emit('session_shutdown'); resolveEditor('Must not save'); await tick();
  assert.equal(h.store.read().composer, ''); assert.equal(h.counts().active, 0); assert.equal(h.listeners.size, 0);
});

test('narrow focus does not consume Pi input; RPC has no terminal lifecycle', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start'); h.tui.terminal.columns = 80;
  await h.shortcuts.get('alt+p').handler(h.ctx); h.press('s'); await tick();
  assert.equal(h.counts().reviews, 0); assert.match(h.notices.at(-1), /92 columns/);
  h.ctx.mode = 'rpc'; await h.commands.get('promptr').handler('', h.ctx);
  assert.match(h.notices.at(-1), /interactive Pi/);
});

test('RPC startup stays inert and synchronous UI failure leaves no active resources', async t => {
  const h = controllerHarness(t, 'rpc');
  await h.emit('session_start');
  assert.equal(h.counts().active, 0); assert.equal(h.listeners.size, 0);
  h.ctx.mode = 'tui'; h.ctx.ui.custom = () => { throw new Error('UI unavailable'); };
  await h.commands.get('promptr').handler('', h.ctx); await tick();
  assert.match(h.notices.at(-1), /UI unavailable/);
  assert.equal(h.listeners.size, 0);
  await h.emit('session_shutdown');
});

test('sidebar focus return and narrow resize release all owned input', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start');
  await h.shortcuts.get('alt+p').handler(h.ctx);
  h.press('\x1b[112;4u'); await tick();
  // A kitty Alt+Shift+P keeps one listener until its key-up, so held repeats cannot loop.
  assert.equal(h.listeners.size, 1);
  h.press('\x1b[112;4:3u');
  assert.equal(h.listeners.size, 0); assert.equal(h.counts().active, 0);
  await h.commands.get('promptr').handler('resize', h.ctx);
  // The passive sidebar owns no input; only the resize session listens.
  assert.equal(h.listeners.size, 1);
  h.press('\x1b[D'); h.press('\x1b');
  assert.equal(h.listeners.size, 0);
  await h.commands.get('promptr').handler('off', h.ctx); await tick();
  assert.equal(h.listeners.size, 0);
});
