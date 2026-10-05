// Overlay ownership. Pi 0.87.1 completes a ctx.ui.custom overlay by calling tui.hideOverlay(),
// which pops the TOP overlay. The harness reproduces that exact behavior on a real pi-tui overlay stack.
// Promptr must remove only its own overlays and leave a foreign dialog's entry, promise, focus and input alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import * as controller from '../../dist/src/sidebar/controller.mjs';
import { sidebarSettingsPath } from '../../dist/src/sidebar/config.mjs';
import { controllerHarness, terminal, theme, tick } from './controller-harness.mjs';

const ESC = '\x1b';
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

let foreignCount = 0;
/** Another extension's capturing dialog, opened through the same ctx.ui.custom. */
function openForeign(h, { nonCapturing = false } = {}) {
  const id = ++foreignCount;
  const component = { foreign: id, keys: [], render: () => [`FOREIGN ${id}`], invalidate() {}, handleInput(data) { component.keys.push(data); } };
  let done;
  let settled;
  const promise = h.ctx.ui.custom((_tui, _theme, _keys, finish) => { done = finish; return component; },
    { overlay: true, overlayOptions: { anchor: 'center', width: 30, ...(nonCapturing ? { nonCapturing: true } : {}) } }).then(value => { settled = { value }; return value; });
  return { component, promise, done: value => done(value), settled: () => settled };
}
const label = component => component.foreign ? `foreign${component.foreign}`
  : typeof component.draft === 'function' ? 'settings'
    : typeof component.handleInput === 'function' ? 'dialog' : 'sidebar';
const stack = h => h.tui.overlayStack.map(entry => label(entry.component));

for (const [mode, action] of [['regular', 'off'], ['regular', 'toggle'], ['fullscreen', 'off']]) {
  test(`${mode}: /promptr ${action} with a foreign dialog above removes only the sidebar entry`, async t => {
    const h = controllerHarness(t, 'tui', { fullscreen: mode === 'fullscreen' });
    await h.emit('session_start'); await settle();
    const f = openForeign(h); await settle();
    await h.command('promptr', action); await settle();
    assert.deepEqual(stack(h), [`foreign${f.component.foreign}`]);
    assert.equal(h.tui.focusedComponent, f.component);
    assert.equal(f.settled(), undefined);
    f.done(); await f.promise;
    assert.deepEqual(stack(h), []);
  });
}

for (const mode of ['regular', 'fullscreen']) {
  test(`${mode}: hiding the sidebar under a foreign dialog removes only the sidebar; the dialog keeps focus, input and its own done`, async t => {
    const h = controllerHarness(t, 'tui', { fullscreen: mode === 'fullscreen' });
    await h.emit('session_start'); await settle();
    assert.deepEqual(stack(h), ['sidebar']);
    const hideOverlay = h.tui.hideOverlay;
    await h.shortcut('alt+p');
    const f = openForeign(h); await settle();
    const top = f.component.foreign;
    assert.deepEqual(stack(h), ['sidebar', `foreign${top}`]);
    assert.equal(h.tui.focusedComponent, f.component);
    let consumed = 'unset';
    for (const fn of [...h.listeners]) consumed = fn('s');
    assert.equal(consumed, undefined, 'a focused sidebar passes keys through while a foreign dialog is open');
    assert.equal(h.listeners.size, 0, 'and releases its input ownership');
    assert.equal(h.counts().reviews, 0);

    await h.command('promptr', 'off'); await settle();
    assert.deepEqual(stack(h), [`foreign${top}`], 'only the sidebar entry was removed');
    assert.equal(h.tui.focusedComponent, f.component, 'the foreign dialog keeps focus');
    assert.equal(f.settled(), undefined, 'the foreign promise is still pending');
    assert.equal(h.tui.hideOverlay, hideOverlay, 'hideOverlay is restored exactly');
    if (mode === 'regular') assert.equal(own(h.tui, 'hideOverlay'), false, 'no instance patch is left behind');

    await h.command('promptr', 'on'); await settle();
    assert.deepEqual(stack(h), [`foreign${top}`], 'the sidebar never mounts above a foreign dialog');
    await h.command('promptr', 'status');
    assert.match(h.notices.at(-1), /waiting for another overlay/);

    f.done('foreign result');
    assert.equal(await f.promise, 'foreign result', 'the foreign dialog closes through its own done');
    assert.deepEqual(stack(h), []);
    await wait(300);
    assert.deepEqual(stack(h), ['sidebar'], 'the sidebar mounts once the dialog is gone');
    await h.command('promptr', 'off'); await h.command('promptr', 'on'); await settle();
    assert.deepEqual(stack(h), ['sidebar'], 'show/hide works with one entry');
    assert.equal(h.listeners.size, 0);
    assert.equal(h.tui.hideOverlay, hideOverlay);
  });
}

test('dispose and session replacement under a foreign dialog keep it and never restore a stale sidebar', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start'); await settle();
  const f = openForeign(h); await settle();
  const name = `foreign${f.component.foreign}`;
  await h.emit('session_shutdown'); await settle();
  assert.deepEqual(stack(h), [name]);
  assert.equal(f.settled(), undefined);
  await wait(300);
  assert.deepEqual(stack(h), [name], 'a disposed session never remounts');
  h.state.sessionId = 'replacement';
  await h.emit('session_start'); await settle();
  assert.deepEqual(stack(h), [name], 'the new session waits instead of stacking above the dialog');
  f.done();
  await f.promise;
  await wait(300);
  assert.deepEqual(stack(h), ['sidebar'], 'exactly one sidebar, owned by the new session');
  await h.emit('session_shutdown'); await settle();
  assert.deepEqual(stack(h), []);
  assert.equal(own(h.tui, 'hideOverlay'), false);
});

test('the Promptr settings screen closes by identity with foreign dialogs above or below it', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start'); await settle();
  const blocking = openForeign(h); await settle();
  const x = `foreign${blocking.component.foreign}`;
  await h.command('promptr', 'panels'); await settle();
  assert.deepEqual(stack(h), ['sidebar', x], 'no Promptr dialog opens over another extension\'s capturing dialog');
  assert.match(h.notices.at(-1), /another extension's overlay is open/);
  blocking.done(); await blocking.promise;
  assert.deepEqual(stack(h), ['sidebar']);
  // No foreign overlay below: the Promptr settings screen is the bottom entry.
  await h.command('promptr', 'off');
  const opened = h.command('promptr', 'panels'); await settle();
  assert.deepEqual(stack(h), ['settings']);
  h.dialog().handleInput(ESC);
  await opened; await settle();
  assert.deepEqual(stack(h), [], 'cancel removed the settings screen; the sidebar stays off');
  assert.equal(fs.existsSync(sidebarSettingsPath()), false);
  await h.command('promptr', 'on'); await settle();
  assert.deepEqual(stack(h), ['sidebar']);

  void h.command('promptr', 'panels'); await settle();
  const above = openForeign(h); await settle();
  const a = `foreign${above.component.foreign}`;
  assert.deepEqual(stack(h), ['settings', a]);
  await h.emit('session_shutdown'); await settle();
  assert.deepEqual(stack(h), [a], 'shutdown closed only the Promptr settings screen');
  assert.equal(h.tui.focusedComponent, above.component);
  assert.equal(above.settled(), undefined);
  above.done('a');
  assert.equal(await above.promise, 'a');
  assert.deepEqual(stack(h), []);
  assert.equal(fs.existsSync(sidebarSettingsPath()), false, 'nothing was saved');
});

test('the Promptr usage dialog closes by identity when a foreign dialog is above it', async t => {
  const home = process.env.HOME;
  const h = controllerHarness(t, 'tui', { trusted: true });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  await h.emit('session_start'); await settle();
  void h.command('promptr', 'usage'); await settle(6);
  assert.deepEqual(stack(h), ['dialog'], 'usage opened after the sidebar finished');
  const above = openForeign(h); await settle();
  const a = `foreign${above.component.foreign}`;
  await h.emit('session_shutdown'); await settle();
  assert.deepEqual(stack(h), [a], 'shutdown retired only the usage dialog');
  assert.equal(above.settled(), undefined);
  above.done();
  await above.promise;
  assert.deepEqual(stack(h), []);
});

for (const mode of ['regular', 'fullscreen']) test(`${mode}: own dialog transitions keep the full-width dock and leave no overlay patch`, async t => {
  const h = controllerHarness(t, 'tui', { fullscreen: mode === 'fullscreen' });
  await h.emit('session_start'); await settle();
  const adapted = h.tui.hideOverlay;
  for (let i = 0; i < 3; i++) {
    const opened = h.command('promptr', 'panels'); await settle();
    assert.deepEqual(stack(h), ['settings']);
    h.dialog().handleInput(i === 2 ? 'S' : ESC);
    await opened; await settle();
    assert.deepEqual(stack(h), ['sidebar']);
  }
  assert.equal(h.tui.hideOverlay, adapted);
  if (mode === 'regular') {
    assert.equal(own(h.tui, 'hideOverlay'), false);
    h.tui.render(140);
    assert.equal(h.parts.editor.widths.at(-1), 140); assert.equal(h.parts.footer.widths.at(-1), 140);
    assert.equal(h.parts.chat.widths.at(-1), 96);
  }
  await h.emit('session_shutdown'); await settle();
  assert.deepEqual(stack(h), []);
  // Fullscreen teardown reassigns the prototype method as an own property; the value is what matters.
  assert.equal(h.tui.hideOverlay, Object.getPrototypeOf(h.tui).hideOverlay, 'dispose restores the prototype method');
});

test('ownedOverlayUi removes only its own entry and never stays mounted above another overlay', async () => {
  assert.equal(typeof controller.ownedOverlayUi, 'function', 'ownedOverlayUi is exported');
  const tui = new TuiMainScreen(terminal()); tui.requestRender = () => {};
  // Pi 0.87.1 showExtensionCustom, verbatim in behavior: close() pops the top overlay.
  const ui = { custom(factory, options) {
    return new Promise(resolve => {
      let closed = false;
      const close = value => { if (closed) return; closed = true; if (options?.overlay) tui.hideOverlay(); resolve(value); };
      Promise.resolve(factory(tui, theme, {}, close)).then(component => {
        if (closed || !options?.overlay) return; // non-overlay custom replaces the editor instead
        const handle = tui.showOverlay(component, typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions);
        options?.onHandle?.(handle);
      });
    });
  } };
  const box = () => ({ render: () => [], invalidate() {}, handleInput() {} });
  const components = () => tui.overlayStack.map(e => e.component);
  const blocked = [];
  const owned = controller.ownedOverlayUi(ui, { cancelValue: 'cancelled', onBlocked: () => blocked.push('blocked') });
  assert.notEqual(owned, ui);
  // Done before show on an empty stack removes nothing.
  const early = owned.custom((_t, _th, _k, done) => { done('early'); return box(); }, { overlay: true, overlayOptions: {} });
  assert.equal(await early, 'early');
  await tick();
  assert.deepEqual(components(), []);
  // Own overlay at the bottom; a foreign dialog arrives above it; own completion removes only its entry.
  let finish;
  const mine = box();
  const handles = [];
  const late = owned.custom((_t, _th, _k, done) => { finish = done; return mine; }, { overlay: true, overlayOptions: { nonCapturing: true }, onHandle: h => handles.push(h) });
  await tick();
  assert.equal(handles.length, 1, 'the caller onHandle still runs');
  const above = box();
  const aboveHandle = tui.showOverlay(above, {});
  finish('mine'); finish('again');
  assert.equal(await late, 'mine');
  assert.deepEqual(components(), [above]);
  assert.equal(own(tui, 'hideOverlay'), false);
  // A foreign overlay is present: the factory is never called and the promise resolves with cancelValue.
  let called = false;
  assert.equal(await owned.custom(() => { called = true; return box(); }, { overlay: true, overlayOptions: {} }), 'cancelled');
  await tick();
  assert.equal(called, false); assert.deepEqual(components(), [above]); assert.deepEqual(blocked, ['blocked']);
  aboveHandle.hide();
  // Same-tick race: the foreign overlay is shown first; the own overlay is cancelled at onHandle by identity.
  const racer = box();
  let racerDone;
  const racerPromise = ui.custom((_t, _th, _k, done) => { racerDone = done; return racer; }, { overlay: true, overlayOptions: {} });
  const onHandles = [];
  const raced = owned.custom(() => box(), { overlay: true, overlayOptions: {}, onHandle: h => onHandles.push(h) });
  assert.equal(await raced, 'cancelled');
  assert.deepEqual(components(), [racer], 'only the own entry was removed');
  assert.deepEqual(onHandles, [], 'a cancelled overlay never reports a handle');
  assert.equal(tui.focusedComponent, racer);
  racerDone('r'); assert.equal(await racerPromise, 'r');
  assert.deepEqual(components(), []);
  // An existing instance adapter is restored, not removed.
  const patched = () => tui.overlayStack.pop();
  tui.hideOverlay = patched;
  let again;
  void owned.custom((_t, _th, _k, done) => { again = done; return box(); }, { overlay: true, overlayOptions: {} });
  await tick();
  again();
  assert.equal(tui.hideOverlay, patched);
  assert.deepEqual(components(), []);
  delete tui.hideOverlay;
  const plain = await new Promise(resolve => { void owned.custom((_t, _th, _k, done) => { resolve(done); return box(); }); });
  assert.equal(typeof plain, 'function', 'non-overlay custom calls pass through');
});

test('a passive foreign overlay: Promptr settings never opens above it, the race is cancelled at onHandle, and foreign completion removes only the foreign entry', async t => {
  const h = controllerHarness(t);
  await h.emit('session_start'); await settle();
  await h.command('promptr', 'off');
  const passive = openForeign(h, { nonCapturing: true }); await settle();
  const p = `foreign${passive.component.foreign}`;
  const refused = h.command('promptr', 'panels'); await settle();
  await refused;
  assert.deepEqual(stack(h), [p], 'entry guard: no settings screen above a passive foreign overlay');
  assert.match(h.notices.at(-1), /another extension's overlay is open/);
  passive.done('passive'); assert.equal(await passive.promise, 'passive');
  assert.deepEqual(stack(h), [], 'the passive overlay closed through its own done; nothing stale');

  // Race: the foreign overlay is requested first but shown in the same microtask turn as the settings screen.
  const racer = openForeign(h, { nonCapturing: true });
  const raced = h.command('promptr', 'panels');
  await settle();
  const r = `foreign${racer.component.foreign}`;
  assert.deepEqual(stack(h), [r], 'the settings screen was cancelled at the onHandle boundary');
  await raced;
  assert.match(h.notices.at(-1), /another extension's overlay is open/);
  assert.equal(racer.settled(), undefined, 'the foreign overlay is untouched');
  racer.done('r'); assert.equal(await racer.promise, 'r');
  assert.deepEqual(stack(h), []);
  assert.equal(fs.existsSync(sidebarSettingsPath()), false, 'nothing was saved');
  assert.equal(h.listeners.size, 0, 'no stale input owner');
  await h.command('promptr', 'on'); await settle();
  assert.deepEqual(stack(h), ['sidebar'], 'own transitions still work afterwards');
});

test('a foreign dialog arriving during the usage refresh cancels the usage dialog at its mount boundary', async t => {
  const home = process.env.HOME;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = controllerHarness(t, 'tui', { trusted: true, wrapTelemetry: telemetry => {
    const refresh = telemetry.refreshSubagentUsage.bind(telemetry);
    telemetry.refreshSubagentUsage = async () => { await gate; await refresh(); };
    return telemetry;
  } });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  await h.emit('session_start'); await settle();
  let finished = false;
  const usage = h.command('promptr', 'usage').then(() => { finished = true; });
  await settle();
  assert.deepEqual(stack(h), [], 'the sidebar finished; usage is refreshing');
  const f = openForeign(h); await settle();
  const name = `foreign${f.component.foreign}`;
  release(); await settle(8);
  assert.deepEqual(stack(h), [name], 'the usage dialog never mounted above the foreign dialog');
  await usage;
  assert.equal(finished, true, 'the usage command resolved');
  assert.match(h.notices.at(-1), /another extension's overlay is open/);
  assert.equal(h.tui.focusedComponent, f.component);
  assert.equal(f.settled(), undefined);
  f.done('f'); assert.equal(await f.promise, 'f');
  assert.deepEqual(stack(h), []);
  await wait(300);
  assert.deepEqual(stack(h), ['sidebar'], 'the sidebar returns after the foreign dialog closes');
});

test('native dialogs, review and workspace stop at their boundaries while a foreign dialog is open', async t => {
  let foreign;
  const h = controllerHarness(t, 'tui', { select: async labels => { foreign = openForeign(h); await settle(); return labels[0]; } });
  h.store.saveText('composer', '', 'Keep me');
  h.store.queueDraft();
  const bytes = fs.readFileSync(h.store.paths.queue, 'utf8');
  await h.emit('session_start'); await settle();
  await h.shortcut('alt+p'); h.press('d'); await settle(6);
  assert.equal(h.counts().confirms, 0, 'the confirm dialog did not open over the foreign dialog');
  assert.equal(fs.readFileSync(h.store.paths.queue, 'utf8'), bytes, 'nothing removed');
  assert.equal(h.tui.focusedComponent, foreign.component, 'the foreign dialog keeps focus');
  assert.equal(h.listeners.size, 0);
  let editorCalls = 0;
  h.edit(async () => { editorCalls++; return 'late'; });
  await h.command('promptr', 'workspace');
  assert.equal(h.counts().workspaces, 0, 'workspace refused at entry while the dialog is open');
  foreign.done(); await foreign.promise;

  // Guards handed to review and workspace turn false when a foreign dialog arrives mid-flow.
  let seen;
  const w = controllerHarness(t, 'tui', { workspace: async (ctx, isCurrent) => {
    assert.equal(isCurrent(), true);
    const f = openForeign(w); await settle();
    seen = { current: isCurrent(), select: await ctx.ui.select('pick', ['a']), editor: await ctx.ui.editor('edit', 'x'),
      confirm: await ctx.ui.confirm('ok?', 'm'), input: await ctx.ui.input('in') };
    f.done(); await f.promise;
  } });
  let editorOpened = 0;
  w.edit(async () => { editorOpened++; return 'x'; });
  await w.emit('session_start'); await settle();
  await w.command('promptr', 'workspace'); await settle();
  assert.deepEqual(seen, { current: false, select: undefined, editor: undefined, confirm: false, input: undefined });
  assert.equal(editorOpened, 0, 'no native dialog opened above the foreign dialog');
  assert.equal(w.counts().confirms, 0);
  assert.equal(editorCalls, 0);
});
