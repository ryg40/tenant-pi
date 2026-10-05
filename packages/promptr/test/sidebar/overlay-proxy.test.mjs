// Promptr overlay completion through Pi 0.87.1's real stable TUI reference (createInteractiveTuiReference).
// Its reads return fresh forwarding functions, writes reach the current renderer, and it cannot report or delete own
// properties. Completion must never leave an own `hideOverlay` on the renderer: a stale one keeps foreign overlays
// open and turns Pi's fullscreen quit loop (`while (hasOverlayEntries) hideOverlay()`) into a busy hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedOverlayUi } from '../../dist/src/sidebar/controller.mjs';
import { controllerHarness, theme, tick } from './controller-harness.mjs';
import { mountPiLayout, terminal } from './pi-layout-fixture.mjs';
import { createInteractiveTuiReference, fullscreenExitLoop, piCustomUi, renderer } from './pi-proxy-fixture.mjs';

const ESC = '\x1b';
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const ownHide = object => Object.getOwnPropertyDescriptor(object, 'hideOverlay')?.value;
const probes = object => Object.getOwnPropertySymbols(object).filter(symbol => symbol.description === 'promptr.renderer');
const box = name => ({ name, render: () => [], invalidate() {}, handleInput() {} });
const names = tui => tui.overlayStack.map(entry => entry.component.name);

/** Open an overlay through `ui.custom`; returns its done and promise once shown. */
async function open(ui, name, options = {}) {
  let done;
  const promise = ui.custom((_tui, _theme, _keys, finish) => { done = finish; return box(name); }, { overlay: true, overlayOptions: {}, ...options });
  await tick();
  return { promise, done: value => done(value) };
}

for (const fullscreen of [false, true]) {
  const mode = fullscreen ? 'fullscreen' : 'regular';
  test(`${mode} renderer behind Pi's proxy: foreign overlays close after several Promptr completions and the quit loop ends`, async () => {
    const real = renderer(fullscreen, terminal());
    const ref = createInteractiveTuiReference(() => real);
    const ui = piCustomUi(ref, theme);
    const owned = ownedOverlayUi(ui);
    for (let i = 0; i < 3; i++) {
      const mine = await open(owned, `own${i}`);
      assert.deepEqual(names(real), [`own${i}`]);
      mine.done(i); assert.equal(await mine.promise, i);
      assert.deepEqual(names(real), []);
      assert.equal(own(real, 'hideOverlay'), false, 'no own hideOverlay is left on the renderer');
      assert.deepEqual(probes(real), [], 'the renderer probe is removed');
    }
    const foreign = await open(ui, 'foreign');
    foreign.done('f'); assert.equal(await foreign.promise, 'f');
    assert.deepEqual(names(real), [], 'the foreign overlay closed through its own done');

    // Own overlay below a foreign one: own completion removes only its entry; the foreign one still closes itself.
    const mine = await open(owned, 'own');
    const above = await open(ui, 'above');
    mine.done(); await mine.promise;
    assert.deepEqual(names(real), ['above']);
    above.done(); await above.promise;
    assert.deepEqual(names(real), []);

    await open(ui, 'left1'); await open(ui, 'left2');
    const exit = fullscreenExitLoop(real);
    assert.deepEqual(exit, { spins: 2, terminated: true }, 'Pi\'s quit loop pops each entry once and ends');
  });
}

test('an existing instance hideOverlay (the split-pane fullscreen hook) is restored by identity through the proxy', async () => {
  const real = renderer(false, terminal());
  const base = Object.getPrototypeOf(real).hideOverlay;
  let adapterCalls = 0;
  const adapter = function () { adapterCalls++; return base.call(this); };
  real.hideOverlay = adapter;
  const ui = piCustomUi(createInteractiveTuiReference(() => real), theme);
  const owned = ownedOverlayUi(ui);
  for (let i = 0; i < 2; i++) {
    const mine = await open(owned, 'own');
    mine.done(); await mine.promise;
    assert.equal(ownHide(real), adapter, 'the adapter is the renderer\'s own method again');
  }
  assert.equal(adapterCalls, 0, 'own completions removed their entry by handle, not by pop-top');
  const foreign = await open(ui, 'foreign');
  foreign.done(); await foreign.promise;
  assert.equal(adapterCalls, 1, 'a foreign completion reaches the adapter');
  assert.deepEqual(names(real), []);
});

test('the routing goes to the renderer that is current at completion, never to a replaced one', async () => {
  const first = renderer(false, terminal());
  const second = renderer(true, terminal());
  let current = first;
  const ui = piCustomUi(createInteractiveTuiReference(() => current), theme);
  const owned = ownedOverlayUi(ui);
  let done;
  const pending = owned.custom((_t, _th, _k, finish) => { done = finish; return box('own'); }, { overlay: true, overlayOptions: {} });
  current = second; // replaced after the factory ran, before Pi showed the overlay
  await tick();
  assert.deepEqual([names(first), names(second)], [[], ['own']]);
  const above = await open(ui, 'above');
  done(); await pending;
  assert.deepEqual(names(second), ['above'], 'only the own entry left the current renderer');
  assert.equal(own(first, 'hideOverlay'), false);
  assert.equal(own(second, 'hideOverlay'), false);
  first.hideOverlay(); // the old renderer's own method must not reach the new one
  assert.deepEqual(names(second), ['above']);
  above.done(); await above.promise;
  assert.deepEqual(fullscreenExitLoop(second), { spins: 0, terminated: true });
});

test('a leaked routing function forwards to the previous method instead of swallowing hideOverlay', async () => {
  const real = renderer(true, terminal());
  const ref = createInteractiveTuiReference(() => real);
  // Pi's close, plus a third party that wraps hideOverlay while the own completion is in progress.
  const ui = { custom(factory, options) {
    return new Promise(resolve => {
      let closed = false;
      const close = value => {
        if (closed) return; closed = true;
        ref.hideOverlay();
        const captured = real.hideOverlay;
        real.hideOverlay = function () { return captured.call(this); };
        resolve(value);
      };
      Promise.resolve(factory(ref, theme, {}, close)).then(component => {
        if (closed) return;
        options.onHandle?.(ref.showOverlay(component, {}));
      });
    });
  } };
  const mine = await open(ownedOverlayUi(ui), 'own');
  mine.done(); await mine.promise;
  assert.deepEqual(names(real), []);
  ref.showOverlay(box('a'), {}); ref.showOverlay(box('b'), {});
  ref.hideOverlay();
  assert.deepEqual(names(real), ['a'], 'the stale wrapper still pops the top');
  assert.deepEqual(fullscreenExitLoop(real), { spins: 1, terminated: true });
});

test('a renderer reference that hides its target falls back to Pi\'s own completion and leaves nothing behind', async () => {
  for (const variant of ['ignored writes', 'unbound methods']) {
    const real = renderer(false, terminal());
    const ref = new Proxy({}, {
      get: (_target, property) => {
        const value = Reflect.get(real, property, real);
        return typeof value === 'function' && variant === 'ignored writes' ? value.bind(real) : value;
      },
      set: (_target, property, value) => variant === 'ignored writes' ? true : Reflect.set(real, property, value, real),
    });
    const ui = piCustomUi(ref, theme);
    const mine = await open(ownedOverlayUi(ui), 'own');
    mine.done('ok'); assert.equal(await mine.promise, 'ok', variant);
    assert.deepEqual(names(real), [], `${variant}: Pi's pop-top removed the top (own) entry`);
    assert.equal(own(real, 'hideOverlay'), false, variant);
    const foreign = await open(ui, 'foreign');
    foreign.done(); await foreign.promise;
    assert.deepEqual(names(real), [], variant);
  }
});

let foreignCount = 0;
function openForeign(h) {
  const id = ++foreignCount;
  const component = { foreign: id, render: () => [`FOREIGN ${id}`], invalidate() {}, handleInput() {} };
  let done;
  const promise = h.ctx.ui.custom((_tui, _theme, _keys, finish) => { done = finish; return component; },
    { overlay: true, overlayOptions: { anchor: 'center', width: 30 } });
  return { id, component, promise, done: value => done(value) };
}
const label = component => component.foreign ? `foreign${component.foreign}`
  : typeof component.draft === 'function' ? 'settings'
    : typeof component.handleInput === 'function' ? 'dialog' : 'sidebar';
const stackOf = tui => tui.overlayStack.map(entry => label(entry.component));

for (const mode of ['regular', 'fullscreen']) {
  test(`${mode} through Pi's proxy: foreign dialogs close after many Promptr completions, the split-pane hook survives and quit ends`, async t => {
    const h = controllerHarness(t, 'tui', { fullscreen: mode === 'fullscreen', proxy: true });
    assert.notEqual(h.ui, h.tui, 'factories receive the proxy');
    await h.emit('session_start'); await settle();
    assert.deepEqual(stackOf(h.tui), ['sidebar']);
    const hook = ownHide(h.tui);
    assert.equal(hook === undefined, mode === 'regular', 'fullscreen has the split-pane instance hook; regular has none');

    await h.command('promptr', 'off'); await h.command('promptr', 'on'); await settle();
    await h.shortcut('alt+shift+p'); await h.shortcut('alt+shift+p'); await settle();
    for (let i = 0; i < 2; i++) {
      const opened = h.command('promptr', 'panels'); await settle();
      assert.deepEqual(stackOf(h.tui), ['settings']);
      h.dialog().handleInput(ESC);
      await opened; await settle();
    }
    assert.deepEqual(stackOf(h.tui), ['sidebar']);
    assert.equal(ownHide(h.tui), hook, 'the renderer keeps exactly its earlier hideOverlay');
    assert.deepEqual(probes(h.tui), []);

    const f = openForeign(h); await settle();
    assert.deepEqual(stackOf(h.tui), ['sidebar', `foreign${f.id}`]);
    f.done('x'); assert.equal(await f.promise, 'x');
    assert.deepEqual(stackOf(h.tui), ['sidebar'], 'the foreign dialog closed through its own done');

    await h.command('promptr', 'off'); await settle();
    const g = openForeign(h); await settle();
    g.done(); await g.promise;
    assert.deepEqual(stackOf(h.tui), []);

    await h.command('promptr', 'on'); await settle();
    openForeign(h); await settle();
    assert.equal(h.tui.overlayStack.length, 2);
    const exit = fullscreenExitLoop(h.tui);
    assert.equal(exit.terminated, true, `quit loop ended after ${exit.spins} calls`);
    assert.ok(exit.spins <= 2);
  });
}

test('renderer replacement through the proxy: completions on the old renderer leave both renderers clean', async t => {
  const h = controllerHarness(t, 'tui', { proxy: true });
  await h.emit('session_start'); await settle();
  assert.equal(h.replaceRenderer(renderer(true, terminal())), false, 'Pi refuses a mode switch while an overlay entry exists');
  await h.command('promptr', 'off'); await settle();
  const old = h.tui;
  const next = renderer(true, terminal());
  const parts = mountPiLayout(next);
  assert.ok(parts);
  assert.equal(h.replaceRenderer(next), true);
  await h.command('promptr', 'on'); await settle();
  assert.deepEqual([stackOf(old), stackOf(next)], [[], ['sidebar']]);
  const f = openForeign(h); await settle();
  await h.command('promptr', 'off'); await settle();
  assert.deepEqual(stackOf(next), [`foreign${f.id}`], 'only the sidebar entry left the new renderer');
  old.hideOverlay();
  assert.deepEqual(stackOf(next), [`foreign${f.id}`], 'the old renderer cannot pop the new one');
  f.done(); await f.promise;
  assert.deepEqual(stackOf(next), []);
  assert.equal(own(old, 'hideOverlay'), false);
  assert.deepEqual([probes(old), probes(next)], [[], []]);
  await h.command('promptr', 'on'); await settle();
  openForeign(h); await settle();
  assert.equal(fullscreenExitLoop(next).terminated, true);
});
