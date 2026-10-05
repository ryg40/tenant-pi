import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  ABSENT_FINGERPRINT, applySidebarSettingsCommand, defaultSidebarSettings, loadSidebarSettings, movePanel,
  parseSidebarSettingsCommand, resolvePanelRef, runSidebarSettingsCommand, saveSidebarSettings, sidebarSettingsPath,
} from '../../dist/src/sidebar/config.mjs';
import { createPanelSettingsDialog } from '../../dist/src/sidebar/settings.mjs';
import { nextPanelOffset, renderComposedSidebar, sidebarInput } from '../../dist/src/sidebar/view.mjs';
import { DEFAULT_PROMPTR_PANEL_ORDER } from '../../dist/src/sidebar/atelier-adapter.mjs';
import { normalizeSidebarPanelLayout } from '../../dist/src/sidebar/vendor/atelier/sidebar-panels.mjs';
import { createUnavailableTelemetry } from '../../dist/src/sidebar/telemetry.mjs';
import { SidebarStore } from '../../dist/src/sidebar/store.mjs';
import { emptyQueue } from '../../dist/src/queue/pending.mjs';

const theme = { fg: (_color, value) => value, bold: value => value, italic: value => value };
const PROMPTR = ['promptr:tasks', 'promptr:notebook', 'promptr:queue', 'promptr:draft', 'promptr:controls'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-settings-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file: sidebarSettingsPath() };
}
const data = (over = {}) => ({ queue: emptyQueue(), composer: 'draft line', note: 'note line', error: '', project: 'p', model: 'm',
  activity: 'Idle', context: '', git: '', tracking: ['#5 settings'], focused: false, busy: false, selected: 0, attempted: new Set(), notice: '', ...over });
const render = (layout, height = 200, panelOffset = 0, width = 44) => renderComposedSidebar({
  telemetry: createUnavailableTelemetry('/tmp/promptr-fixture').snapshot(), settings: { sidebarPanelLayout: layout, showSidebarToolNames: false },
  data: data(), width, height, theme, panelOffset, colorEnabled: false, now: 0 });
const titles = lines => [...lines.join('\n').matchAll(/╭─ ✦ ([A-Z /0-9]+?) ─/g)].map(match => match[1].replace(/ \/ \d+$/, ''));
const save = (state, settings) => { const result = saveSidebarSettings(state, settings); assert.ok(result.ok, result.error); return result.state; };
const dialog = (state, extra = {}) => {
  const results = [];
  const d = createPanelSettingsDialog({ state, availableIds: () => PROMPTR, theme, requestRender() {}, done: r => results.push(r), ...extra });
  return { d, results, keys: (...keys) => keys.forEach(key => d.handleInput(key)) };
};
const DOWN = '\x1b[B';

test('first run uses the 14-panel default and creates no file or directory', t => {
  const { file } = fixture(t);
  assert.equal(file, path.join(process.env.PI_CODING_AGENT_DIR, 'promptr', 'sidebar.json'));
  const state = loadSidebarSettings();
  assert.equal(state.fingerprint, ABSENT_FINGERPRINT);
  assert.deepEqual(state.settings.sidebarPanelLayout.map(e => e.id), [...DEFAULT_PROMPTR_PANEL_ORDER]);
  assert.ok(state.settings.sidebarPanelLayout.every(e => e.visible));
  assert.equal(fs.existsSync(path.dirname(file)), false);
  render(state.settings.sidebarPanelLayout, 12);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'rendering never writes');
});

test('every catalog panel toggles independently, including Agent and Controls', () => {
  const base = defaultSidebarSettings();
  for (const id of DEFAULT_PROMPTR_PANEL_ORDER) {
    const off = applySidebarSettingsCommand(base, { kind: 'panel', ref: id, visible: false });
    assert.ok(off.ok);
    assert.deepEqual(off.value.sidebarPanelLayout.filter(e => !e.visible).map(e => e.id), [id]);
    const on = applySidebarSettingsCommand(off.value, { kind: 'panel', ref: id, visible: true });
    assert.ok(on.value.sidebarPanelLayout.every(e => e.visible));
    assert.ok(!titles(render(off.value.sidebarPanelLayout).lines).includes(id.replace('promptr:', '').toUpperCase()));
  }
});

test('Agent/Activity/Tasks/Notebook saved as 1/2/3/4 render in that order and survive a fresh load', t => {
  const { file } = fixture(t);
  let settings = defaultSidebarSettings();
  settings.sidebarPanelLayout = [...settings.sidebarPanelLayout].reverse();
  for (const [ref, position] of [['agent', 1], ['activity', 2], ['tasks', 3], ['notebook', 4]]) {
    const result = applySidebarSettingsCommand(settings, { kind: 'move', ref, position });
    assert.ok(result.ok, result.error); settings = result.value;
  }
  save(loadSidebarSettings(file), settings);
  const reloaded = loadSidebarSettings(file);
  assert.deepEqual(reloaded.settings, settings);
  assert.deepEqual(titles(render(reloaded.settings.sidebarPanelLayout).lines).slice(0, 4), ['AGENT', 'ACTIVITY', 'TASKS', 'NOTEBOOK']);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.sidebarPanelLayout.every(e => Object.keys(e).join() === 'id,visible'), 'array order is the only position');
});

test('a hidden panel keeps a moved position and returns there when re-enabled', () => {
  let s = applySidebarSettingsCommand(defaultSidebarSettings(), { kind: 'panel', ref: 'notebook', visible: false }).value;
  s = applySidebarSettingsCommand(s, { kind: 'move', ref: 'notebook', position: 2 }).value;
  assert.equal(s.sidebarPanelLayout[1].id, 'promptr:notebook');
  assert.ok(!titles(render(s.sidebarPanelLayout).lines).includes('NOTEBOOK'));
  s = applySidebarSettingsCommand(s, { kind: 'panel', ref: 'promptr:notebook', visible: true }).value;
  assert.deepEqual(titles(render(s.sidebarPanelLayout).lines).slice(0, 2), ['AGENT', 'NOTEBOOK']);
});

test('all panels off is allowed, names the recovery command, and a command restores a panel', t => {
  const { file } = fixture(t);
  let s = defaultSidebarSettings();
  for (const id of DEFAULT_PROMPTR_PANEL_ORDER) s = applySidebarSettingsCommand(s, { kind: 'panel', ref: id, visible: false }).value;
  save(loadSidebarSettings(file), s);
  assert.ok(loadSidebarSettings(file).settings.sidebarPanelLayout.every(e => !e.visible), 'Agent is not forced back on');
  assert.ok(normalizeSidebarPanelLayout([{ id: 'agent', visible: false }]).every(e => e.id !== 'agent' || !e.visible));
  const text = render(s.sidebarPanelLayout, 12).lines.join('\n');
  assert.match(text, /All panels are off/);
  assert.match(text, /\/promptr panels/);
  assert.doesNotMatch(text, /\/promptr settings/);
  const outcome = runSidebarSettingsCommand('panel controls on', { file });
  assert.equal(outcome.kind, 'saved', outcome.message);
  assert.deepEqual(titles(render(loadSidebarSettings(file).settings.sidebarPanelLayout).lines), ['CONTROLS']);
  assert.equal(runSidebarSettingsCommand('panels', { file }).kind, 'open-panels');
});

test('dialog: Cancel writes nothing, Defaults needs Save, Undo reverts one step, Save persists', t => {
  const { file } = fixture(t);
  save(loadSidebarSettings(file), applySidebarSettingsCommand(defaultSidebarSettings(), { kind: 'move', ref: 'tools', position: 1 }).value);
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  let run = dialog(loadSidebarSettings(file));
  run.keys(' ', ']', 'd');
  assert.deepEqual(run.d.draft().sidebarPanelLayout.map(e => e.id), [...DEFAULT_PROMPTR_PANEL_ORDER]);
  run.keys('\x1b');
  assert.deepEqual(run.results, [{ saved: false }]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);

  run = dialog(loadSidebarSettings(file));
  run.keys(' ');
  assert.equal(run.d.draft().sidebarPanelLayout[0].visible, false);
  run.keys('u');
  assert.equal(run.d.draft().sidebarPanelLayout[0].visible, true);
  run.keys(DOWN, 'm', '5', '\r', 's');
  assert.equal(run.results[0].saved, true);
  assert.equal(loadSidebarSettings(file).settings.sidebarPanelLayout[4].id, 'agent');
});

test('dialog keys toggle startup and width; the render stays inside the viewport', t => {
  const { file } = fixture(t);
  const run = dialog(loadSidebarSettings(file), { getViewportHeight: () => 14,
    preview: (layout, width, height) => render(layout, height, 0, width).lines });
  for (let i = 0; i < 14; i++) run.keys(DOWN);
  run.keys(' ', DOWN, '\x1b[D', '\x1b[D', DOWN, ' ');
  const draft = run.d.draft();
  assert.equal(draft.showSidebarOnStartup, false);
  assert.equal(draft.sidebarWidth, 42);
  assert.equal(draft.showSidebarToolNames, true);
  for (const width of [30, 80, 120]) {
    const lines = run.d.render(width);
    assert.ok(lines.length <= 14);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
  }
  assert.equal(fs.existsSync(file), false, 'rendering and preview write nothing');
});

test('malformed, unsupported, duplicate and wrongly typed files are reported and never overwritten', t => {
  const { file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bad = ['{ broken', '{"version":2}', '[]',
    '{"version":1,"sidebarPanelLayout":[{"id":"agent","visible":true},{"id":"agent","visible":false}]}',
    '{"version":1,"sidebarPanelLayout":[{"id":"agent","visible":"yes"}]}',
    '{"version":1,"sidebarPanelLayout":[{"id":"Not An Id","visible":true}]}',
    '{"version":1,"sidebarWidth":200}'];
  for (const raw of bad) {
    fs.writeFileSync(file, raw);
    const state = loadSidebarSettings(file);
    assert.ok(state.error, raw);
    assert.deepEqual(state.settings.sidebarPanelLayout.map(e => e.id), [...DEFAULT_PROMPTR_PANEL_ORDER]);
    assert.equal(saveSidebarSettings(state, defaultSidebarSettings()).ok, false);
    assert.equal(runSidebarSettingsCommand('panel agent off', { file }).kind, 'error');
    const run = dialog(state); run.keys(' ', 's');
    assert.equal(run.results.length, 0, 'dialog stays open on refusal');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('stale save is refused and the external edit survives', t => {
  const { file } = fixture(t);
  const state = loadSidebarSettings(file);
  const run = dialog(state);
  const external = '{"version":1,"showSidebarOnStartup":false}\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, external);
  run.keys(' ', 's');
  assert.equal(run.results.length, 0);
  assert.match(run.d.render(80).join('\n'), /changed elsewhere/);
  const direct = saveSidebarSettings(state, defaultSidebarSettings());
  assert.equal(direct.ok, false); assert.equal(direct.stale, true);
  assert.equal(fs.readFileSync(file, 'utf8'), external);
});

test('a retired session cannot save late', t => {
  const { file } = fixture(t);
  let current = true;
  const run = dialog(loadSidebarSettings(file), { isCurrent: () => current });
  run.keys(' ');
  current = false;
  run.keys('s');
  assert.equal(run.results.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(runSidebarSettingsCommand('startup off', { file, isCurrent: () => false }).kind, 'error');
  assert.equal(fs.existsSync(file), false);
});

test('unavailable panels keep their slot, show as unavailable, and unknown fields survive a save', t => {
  const { file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, ownerNote: 'keep me', sidebarPanelLayout: [
    { id: 'agent', visible: true }, { id: 'future:panel', visible: true }, { id: 'activity', visible: true }] }));
  const state = loadSidebarSettings(file);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.settings.sidebarPanelLayout.slice(0, 3).map(e => e.id), ['agent', 'future:panel', 'activity']);
  assert.equal(state.settings.sidebarPanelLayout.length, 15, 'missing catalog panels are added');
  assert.deepEqual(state.settings.sidebarPanelLayout.slice(3, 7).map(e => e.id), ['promptr:tasks', 'promptr:notebook', 'promptr:queue', 'promptr:draft']);
  const run = dialog(state);
  assert.match(run.d.render(100).join('\n'), /2 ● on  ▾ open   future:panel\s+unavailable/);
  assert.ok(!titles(render(state.settings.sidebarPanelLayout).lines).includes('FUTURE:PANEL'));
  assert.equal(runSidebarSettingsCommand('startup off', { file }).kind, 'saved');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.ownerNote, 'keep me');
  assert.equal(raw.sidebarPanelLayout[1].id, 'future:panel');
});

test('aliases resolve only when unambiguous; invalid commands change nothing', t => {
  const { file } = fixture(t);
  const layout = [...defaultSidebarSettings().sidebarPanelLayout, { id: 'other:tasks', visible: false }];
  assert.deepEqual(resolvePanelRef(layout, 'Notebook'), { ok: true, id: 'promptr:notebook' });
  assert.deepEqual(resolvePanelRef(layout, 'todos'), { ok: true, id: 'todos' });
  assert.match(resolvePanelRef(layout, 'tasks').error, /ambiguous/);
  assert.equal(resolvePanelRef(layout, 'promptr:tasks').id, 'promptr:tasks');
  assert.match(resolvePanelRef(layout, 'nope').error, /Unknown panel/);
  assert.equal(movePanel(layout, 'agent', 0).ok, false);
  assert.equal(movePanel(layout, 'agent', 16).ok, false);
  runSidebarSettingsCommand('startup on', { file });
  const before = fs.readFileSync(file, 'utf8');
  for (const args of ['move notebook x', 'move notebook 0', 'move notebook 15', 'panel nope off', 'panel notebook maybe',
    'panel notebook', 'startup sometimes', 'panels extra', 'move notebook 2 3']) {
    const outcome = runSidebarSettingsCommand(args, { file });
    assert.equal(outcome.kind, 'error', args);
    assert.equal(fs.readFileSync(file, 'utf8'), before, args);
  }
  assert.equal(parseSidebarSettingsCommand('width 52'), undefined, 'other /promptr subcommands pass through');
  assert.equal(parseSidebarSettingsCommand(''), undefined);
});

test('overflow paging reaches every enabled panel in saved order; resize never rewrites settings', t => {
  const { file } = fixture(t);
  const layout = defaultSidebarSettings().sidebarPanelLayout;
  for (const height of [12, 24, 45]) for (const width of [28, 44, 72]) {
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const view = render(layout, height, offset, width);
      assert.ok(view.lines.length <= height && view.lines.every(line => visibleWidth(line) <= width), `${width}x${height}`);
      view.viewport.renderedIds.forEach(id => seen.add(id));
      if (!view.viewport.below.length) break;
      assert.match(view.lines.at(-1), /↓\d+ more · PgUp\/PgDn/);
      const next = nextPanelOffset(view.viewport, 1);
      assert.ok(next > offset); offset = next;
    }
    assert.deepEqual([...seen].sort(), [...DEFAULT_PROMPTR_PANEL_ORDER].sort(), `${width}x${height}`);
    const back = render(layout, height, offset, width).viewport;
    if (offset > 0) assert.ok(back.above.length > 0 && nextPanelOffset(back, -1) === offset - 1);
  }
  const first = render(layout, 45).viewport.renderedIds;
  assert.deepEqual(first, [...DEFAULT_PROMPTR_PANEL_ORDER].filter(id => first.includes(id)), 'visible subset keeps saved order');
  assert.deepEqual(first.slice(0, 4), ['agent', 'activity', 'promptr:tasks', 'promptr:notebook']);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(sidebarInput('\x1b[6~', 2), { selected: 2, scroll: 1 });
  assert.deepEqual(sidebarInput('[', 2), { selected: 2, scroll: -1 });
});

test('empty built-in panels say so instead of disappearing', () => {
  const text = render(defaultSidebarSettings().sidebarPanelLayout).lines.join('\n');
  for (const phrase of ['No alerts', 'No session TODOs', 'Usage unavailable', 'No subagent runs']) assert.match(text, new RegExp(phrase));
});

test('settings actions leave notebook, draft, queue revision and footer data untouched', t => {
  const { root, file } = fixture(t);
  const store = new SidebarStore(root);
  store.saveText('note', '', 'Owner note');
  store.saveText('composer', '', 'Owner draft');
  store.queueDraft();
  const snapshot = () => [store.paths.scratch, store.paths.composer, store.paths.queue].map(p => fs.readFileSync(p, 'utf8'));
  const before = snapshot();
  const revision = store.read().queue.revision;
  runSidebarSettingsCommand('panel notebook off', { file });
  runSidebarSettingsCommand('move queue 1', { file });
  runSidebarSettingsCommand('startup off', { file });
  const run = dialog(loadSidebarSettings(file)); run.keys('d', 's');
  assert.deepEqual(snapshot(), before);
  assert.equal(store.read().queue.revision, revision);
  const promptrFiles = fs.readdirSync(path.dirname(file));
  assert.deepEqual(promptrFiles.filter(name => !name.startsWith('projects')), ['sidebar.json'], 'only sidebar.json is written');
});

test('chartGraphics reaches the subagent graph; a suspended plot keeps its rows and restores afterwards', () => {
  const telemetry = { ...createUnavailableTelemetry('/tmp/promptr-fixture').snapshot(), subagentUsage: {
    runs: [{ id: 'r1:0', runId: 'r1', agent: 'scout', metadataPath: '/tmp/none', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.02, pricedRuns: 1 }],
    totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.02, pricedRuns: 1 }, unavailable: 0, pending: 0, limited: false,
    costHistory: [{ id: 'r1:0', runId: 'r1', stepIndex: 0, agent: 'scout', startedAt: 0, partial: false,
      points: [{ at: 0, cost: 0 }, { at: 1000, cost: 0.01 }, { at: 2000, cost: 0.02 }] }] } };
  const layout = [{ id: 'agent', visible: true }, { id: 'subagents', visible: true }, { id: 'promptr:notebook', visible: true }];
  const draw = chartGraphics => renderComposedSidebar({ telemetry, settings: { sidebarPanelLayout: layout, showSidebarToolNames: false },
    data: data(), width: 44, height: 80, theme, colorEnabled: false, now: 0, ...(chartGraphics ? { chartGraphics } : {}) });
  const owner = {};
  const live = draw({ imageOwner: owner, suspendPlot: false });
  const suspended = draw({ imageOwner: owner, suspendPlot: true });
  const restored = draw({ imageOwner: owner, suspendPlot: false });
  assert.match(suspended.lines.join('\n'), /Close dialog to view graph/);
  assert.match(live.lines.join('\n'), /SUBAGENTS[\s\S]*\$0[\s\S]*\/promptr usage/, 'live graph renders axis and hint');
  assert.doesNotMatch(live.lines.join('\n'), /Close dialog to view graph/);
  const headerRows = view => view.lines.flatMap((line, index) => /╭─ ✦ /.test(line) ? [index] : []);
  assert.deepEqual(headerRows(suspended), headerRows(live), 'suspension keeps the reserved layout');
  assert.deepEqual(restored.lines, live.lines, 'plot returns after the dialog');
  assert.deepEqual(draw().lines, live.lines, 'chartGraphics is optional');
});
