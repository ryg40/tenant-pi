// Sidebar render cost and render-request rate. Each defect test fails on the
// baseline build: the store poll asked for a frame every 1.5 s, streamed telemetry asked for one per token,
// every frame rebuilt the whole sidebar, and nothing bounded or reported a request storm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderGuard, RENDER_IDLE_INTERVAL_MS, RENDER_STORM_SECONDS, RENDER_THROTTLED_INTERVAL_MS, RENDER_WORKING_INTERVAL_MS,
} from '../../dist/src/sidebar/render-guard.mjs';
import { createSplitPaneController } from '../../dist/src/sidebar/vendor/split-pane.mjs';
import { controllerHarness, tick } from './controller-harness.mjs';
import { createTui, mountPiLayout, terminal } from './pi-layout-fixture.mjs';

const plain = line => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, '');
const STORM = /render requests\/s/;

/** Harness with mocked timers and Date; `frames` counts requests that reached Pi. */
async function mounted(t, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const h = controllerHarness(t, 'tui', options);
  const counter = { frames: 0 };
  h.tui.requestRender = () => { counter.frames++; };
  await h.emit('session_start'); await tick(); await tick();
  assert.ok(h.sidebar(), 'sidebar mounted');
  const fire = (name, payload = {}) => { for (const fn of [...(h.events.get(name) ?? [])]) fn({ type: name, ...payload }, h.ctx); };
  return { h, counter, fire };
}

test('defect: the idle store poll asks for a frame only when the store changed on disk', async t => {
  const { h, counter } = await mounted(t);
  counter.frames = 0;
  t.mock.timers.tick(1500 * 10);
  assert.equal(counter.frames, 0, 'ten polls of an unchanged store request no frame');
  h.store.saveText('composer', '', 'Draft written by another process');
  t.mock.timers.tick(1500);
  assert.equal(counter.frames, 1, 'a changed store requests one frame');
  t.mock.timers.tick(1500 * 4);
  assert.equal(counter.frames, 1);
});

test('defect: streamed telemetry is coalesced to about 4 frames/s during a turn', async t => {
  const { counter, fire } = await mounted(t);
  fire('agent_start'); fire('before_provider_request');
  counter.frames = 0;
  // One second of streaming at 100 message_update events/s; each one changes the TPS estimate.
  for (let i = 1; i <= 100; i++) {
    fire('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'word '.repeat(i * 4) }] } });
    t.mock.timers.tick(10);
  }
  t.mock.timers.tick(RENDER_WORKING_INTERVAL_MS);
  const limit = Math.ceil(1000 / RENDER_WORKING_INTERVAL_MS) + 2;
  assert.ok(counter.frames >= 3 && counter.frames <= limit, `${counter.frames} frames for 100 updates (limit ${limit})`);
});

test('defect: a fast model streaming 100 tokens/s for several seconds is not reported as a render storm', async t => {
  const { h, fire } = await mounted(t);
  fire('agent_start'); fire('before_provider_request');
  // Each message_update changed the TPS estimate and sent one telemetry request: 68/s tripped the 30/s storm rate.
  for (let i = 1; i <= (RENDER_STORM_SECONDS + 2) * 100; i++) {
    fire('message_update', { message: { role: 'assistant', content: [{ type: 'text', text: 'word '.repeat(i * 4) }] } });
    t.mock.timers.tick(10);
  }
  assert.deepEqual(h.notices.filter(text => STORM.test(text)), []);
  await h.command('promptr', 'status');
  const telemetry = Number(/top: telemetry (\d+)/.exec(h.notices.at(-1))?.[1]);
  const limit = (RENDER_STORM_SECONDS + 2) * (Math.ceil(1000 / RENDER_WORKING_INTERVAL_MS) + 1);
  assert.ok(telemetry <= limit, `${telemetry} telemetry requests (limit ${limit})`);
});

test('defect: identical frames reuse the built sidebar; inputs and elapsed time rebuild it', async t => {
  const { h, fire } = await mounted(t);
  const sidebar = h.sidebar();
  const first = sidebar.render(44);
  assert.equal(sidebar.render(44), first, 'no input changed: same lines');
  const wider = sidebar.render(50);
  assert.notEqual(wider, first, 'width is an input');
  await h.command('promptr', 'focus');
  const focused = sidebar.render(50);
  assert.notEqual(focused, wider, 'focus is an input');
  h.store.saveText('note', '', 'Notebook line');
  t.mock.timers.tick(1500);
  assert.ok(sidebar.render(50).some(line => plain(line).includes('Notebook line')), 'store data is an input');

  // A running turn shows elapsed time: at most one rebuild per second, and the text follows the clock.
  // While a turn runs, telemetry may lag a frame by up to 250 ms (the guard sends a trailing frame).
  fire('agent_start'); // t = 1500 ms
  t.mock.timers.tick(600);
  const running = sidebar.render(50);
  assert.ok(running.some(line => plain(line).includes('running <1s')), running.map(plain).join('\n'));
  t.mock.timers.tick(400);
  assert.equal(sidebar.render(50), running, 'same second: cached');
  t.mock.timers.tick(500);
  const later = sidebar.render(50);
  assert.notEqual(later, running);
  assert.ok(later.some(line => plain(line).includes('running 1s')));
});

test('defect: a render-request storm is reported once with its top requester, then throttled', async t => {
  let listener;
  const { h, counter } = await mounted(t, { wrapTelemetry: telemetry => {
    const subscribe = telemetry.subscribe.bind(telemetry);
    telemetry.subscribe = fn => { listener = fn; return subscribe(fn); };
    return telemetry;
  } });
  counter.frames = 0;
  // 60 telemetry notifications/s with no input and no I/O: the fault signature.
  const storm = seconds => { for (let i = 0; i < seconds * 60; i++) { listener(); t.mock.timers.tick(1000 / 60); } };
  storm(RENDER_STORM_SECONDS + 2);
  const warnings = h.notices.filter(text => STORM.test(text));
  assert.equal(warnings.length, 1, 'one warning');
  assert.match(warnings[0], /top requester: telemetry/);
  counter.frames = 0;
  storm(4);
  assert.ok(counter.frames <= 4 + 1, `${counter.frames} frames in 4 s while throttled`);
  storm(RENDER_STORM_SECONDS + 2);
  assert.equal(h.notices.filter(text => STORM.test(text)).length, 1, 'never warned twice');
  await h.command('promptr', 'status');
  assert.match(h.notices.at(-1), /Render requests: \d+, \d+ sent to Pi \(throttled\); top: telemetry \d+/);
});

test('the split pane re-syncs its renderer adapters only after a layout change', () => {
  const tui = createTui('fullscreen', terminal(140, 30));
  const parts = mountPiLayout(tui);
  const reasons = [];
  const split = createSplitPaneController({ onRenderRequest: reason => reasons.push(reason) });
  split.attach(tui); split.show();
  tui.showOverlay({ render: w => Array(split.getSidebarHeight()).fill('S'.repeat(w)), invalidate() {} }, split.overlayOptions());
  split.requestRender();
  const wrapped = tui.layoutRoot;
  assert.notEqual(wrapped, parts.root);
  const proto = Object.getPrototypeOf(tui);
  let sets = 0;
  tui.setLayoutRoot = component => { sets++; proto.setLayoutRoot.call(tui, component); };
  for (let i = 0; i < 10; i++) split.requestRender();
  assert.equal(sets, 0);
  // Pi mounts its own layout root again: the next data request wraps it once.
  proto.setLayoutRoot.call(tui, parts.root);
  split.requestRender();
  assert.notEqual(tui.layoutRoot, parts.root);
  assert.equal(sets, 1);
  assert.deepEqual(reasons, ['attach', 'show']);
  split.dispose();
  assert.equal(tui.layoutRoot, parts.root);
});

test('candidate check: no render path requests another frame from inside a Pi frame', async t => {
  for (const fullscreen of [false, true]) {
    const h = controllerHarness(t, 'tui', { fullscreen, proxy: true });
    const renderer = h.renderer();
    let inFrame = false;
    const during = [];
    renderer.requestRender = () => { if (inFrame) during.push(new Error().stack.split('\n').slice(2, 5).join(' < ')); };
    if (fullscreen) renderer.altScreenActive = true;
    await h.emit('session_start'); await tick(); await tick();
    const frames = count => { for (let i = 0; i < count; i++) { inFrame = true; try { renderer.doRender(); } finally { inFrame = false; } } };
    frames(5);
    await h.command('promptr', 'focus'); frames(5);
    h.press('\x1b[B'); frames(5);
    renderer.terminal.columns = 80; frames(5);
    renderer.terminal.columns = 140; frames(5);
    assert.deepEqual(during, [], `${fullscreen ? 'fullscreen' : 'regular'}: ${during.join('\n')}`);
    await h.emit('session_shutdown');
  }
});

// ---- guard unit behaviour ----

function fakeClock() {
  const clock = { now: 0, timers: [] };
  clock.setTimer = (run, ms) => { const timer = { at: clock.now + ms, run }; clock.timers.push(timer); return timer; };
  clock.clearTimer = timer => { clock.timers = clock.timers.filter(entry => entry !== timer); };
  clock.advance = ms => {
    const end = clock.now + ms;
    for (;;) {
      const next = clock.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      clock.now = next.at; clock.clearTimer(next); next.run();
    }
    clock.now = end;
  };
  return clock;
}

function guardFixture(state = {}) {
  const clock = fakeClock();
  const flushes = [], warnings = [];
  const guard = createRenderGuard({ flush: () => flushes.push(clock.now), isWorking: () => Boolean(state.working),
    isResizing: () => Boolean(state.resizing), warn: text => warnings.push(text), now: () => clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, flushes, warnings, guard };
}

test('guard: leading frame at once, then one trailing frame per interval', () => {
  const { clock, flushes, guard } = guardFixture();
  guard.request('telemetry');
  assert.deepEqual(flushes, [0]);
  for (let i = 0; i < 10; i++) { clock.advance(5); guard.request('telemetry'); }
  assert.deepEqual(flushes, [0]);
  clock.advance(RENDER_IDLE_INTERVAL_MS);
  assert.deepEqual(flushes, [0, RENDER_IDLE_INTERVAL_MS]);
  assert.equal(guard.stats().requests, 11);
});

test('guard: working turns use the longer interval; urgent and resize requests pass at once', () => {
  const state = { working: true };
  const { clock, flushes, guard } = guardFixture(state);
  guard.request('telemetry'); clock.advance(10); guard.request('telemetry');
  clock.advance(RENDER_WORKING_INTERVAL_MS);
  assert.deepEqual(flushes, [0, RENDER_WORKING_INTERVAL_MS]);
  guard.request('input', true);
  assert.equal(flushes.length, 3);
  state.resizing = true;
  guard.request('telemetry'); guard.request('telemetry');
  assert.equal(flushes.length, 5);
});

test('guard: storm warning names the top requester once; calm seconds release the throttle', () => {
  const { clock, flushes, warnings, guard } = guardFixture();
  for (let i = 0; i < (RENDER_STORM_SECONDS + 1) * 50; i++) {
    guard.request(i % 5 === 0 ? 'panel-registry' : 'telemetry');
    clock.advance(20);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /top requester: telemetry/);
  assert.equal(guard.stats().throttled, true);
  flushes.length = 0;
  for (let i = 0; i < 100; i++) { guard.request('input', true); clock.advance(20); }
  assert.ok(flushes.length <= 3, `${flushes.length} frames in 2 s while throttled`);
  assert.ok(flushes.every((at, i) => i === 0 || at - flushes[i - 1] >= RENDER_THROTTLED_INTERVAL_MS));
  clock.advance((RENDER_STORM_SECONDS + 1) * 1000);
  guard.request('input', true);
  assert.equal(guard.stats().throttled, false);
  assert.equal(warnings.length, 1);
  guard.dispose();
  guard.request('telemetry');
  clock.advance(5000);
  assert.equal(clock.timers.length, 0);
});
