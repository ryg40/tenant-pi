// Acceptance: in-place collapse of each sidebar panel, saved in sidebar.json, keys and Pi slash commands.
// Temporary PI_CODING_AGENT_DIR/HOME only. No network, no model sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applySidebarSettingsCommand, defaultSidebarSettings, loadSidebarSettings, parseSidebarSettings, parseSidebarSettingsCommand,
  saveSidebarSettings, serializeSidebarSettings, sidebarSettingsPath,
} from '../../dist/src/sidebar/config.mjs';
import { createPanelSettingsDialog } from '../../dist/src/sidebar/settings.mjs';
import { renderComposedSidebar, sidebarInput } from '../../dist/src/sidebar/view.mjs';
import { DEFAULT_PROMPTR_PANEL_ORDER, defaultPromptrPanelLayout } from '../../dist/src/sidebar/atelier-adapter.mjs';
import { createUnavailableTelemetry } from '../../dist/src/sidebar/telemetry.mjs';
import { emptyQueue } from '../../dist/src/queue/pending.mjs';
import promptr from '../../dist/src/extension/index.mjs';
import { controllerHarness, fixture, tick } from './controller-harness.mjs';

const theme = { fg: (_color, value) => value, bold: value => value, italic: value => value };
const queue = { ...emptyQueue(), items: [{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }] };
const data = (over = {}) => ({ queue, composer: 'draft line', note: 'note line', error: '', project: 'p', model: 'm',
  activity: 'Idle', context: '', git: '', tracking: ['#9 collapse'], trackingOpen: 7, focused: false, busy: false, selected: 0,
  attempted: new Set(), notice: '', ...over });
const render = ({ collapsed = [], height = 200, cursor, panelOffset = 0, over } = {}) => renderComposedSidebar({
  telemetry: createUnavailableTelemetry('/tmp/promptr-fixture').snapshot(),
  settings: { sidebarPanelLayout: defaultPromptrPanelLayout(), showSidebarToolNames: false, sidebarCollapsedPanels: collapsed },
  data: data(over), width: 44, height, theme, panelOffset, cursor, colorEnabled: false, now: 0 });
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };

test('a collapsed panel is one header row with a short count; its body is not rendered', () => {
  const open = render().lines.join('\n');
  assert.match(open, /╭─ ✦ QUEUE \/ 2 /);
  assert.match(open, /1 first/);
  const lines = render({ collapsed: ['promptr:queue', 'promptr:tasks', 'promptr:notebook'] }).lines;
  const text = lines.join('\n');
  assert.equal(lines.filter(line => /▸ QUEUE · 2 ─/.test(line)).length, 1);
  assert.match(text, /▸ TASKS · 7 ─/);
  assert.match(text, /▸ NOTEBOOK ─/, 'no badge for panels without a count');
  assert.doesNotMatch(text, /1 first|#9 collapse|note line/);
  assert.doesNotMatch(text, /QUEUE \/ 2/);
});

test('unknown counts give no badge, never 0', () => {
  const text = render({ collapsed: ['promptr:tasks', 'promptr:queue', 'alerts'], over: { trackingOpen: undefined, error: 'queue corrupt' } })
    .lines.join('\n');
  assert.match(text, /▸ TASKS ─/);
  assert.match(text, /▸ QUEUE \/ 2 ─|▸ QUEUE ─/);
  assert.doesNotMatch(text, /· 0/);
  assert.match(text, /▸ ALERTS ─/);
});

test('collapsed panels use one row each, so the viewport and overflow counts stay correct', () => {
  for (const height of [12, 24, 48]) {
    const all = render({ collapsed: [...DEFAULT_PROMPTR_PANEL_ORDER], height });
    const fits = Math.min(DEFAULT_PROMPTR_PANEL_ORDER.length, height - (height < DEFAULT_PROMPTR_PANEL_ORDER.length ? 1 : 0));
    assert.equal(all.viewport.renderedIds.length, fits, `height ${height}`);
    assert.equal(all.viewport.below.length, DEFAULT_PROMPTR_PANEL_ORDER.length - fits);
    assert.equal(all.lines.length, height);
    const expanded = render({ height });
    assert.ok(expanded.viewport.renderedIds.length <= all.viewport.renderedIds.length);
  }
  const mixed = render({ collapsed: ['activity', 'promptr:tasks', 'promptr:notebook'], height: 24 });
  const plain = render({ height: 24 });
  assert.ok(mixed.viewport.renderedIds.length > plain.viewport.renderedIds.length);
  assert.deepEqual([...mixed.viewport.renderedIds, ...mixed.viewport.below], [...DEFAULT_PROMPTR_PANEL_ORDER]);
});

test('the focused cursor marks one panel, collapsed or expanded', () => {
  assert.match(render({ cursor: 'promptr:draft' }).lines.join('\n'), /╭─ ✦ DRAFT ◂ ─/);
  assert.match(render({ cursor: 'promptr:draft', collapsed: ['promptr:draft'] }).lines.join('\n'), /▸ DRAFT ◂ ─/);
  assert.doesNotMatch(render().lines.join('\n'), /◂/);
});

test('keys: Left/Right and k/j move the cursor, Space folds, z folds all; Controls keys are unchanged', () => {
  assert.deepEqual(sidebarInput('\x1b[D', 2), { selected: 2, panel: -1 });
  assert.deepEqual(sidebarInput('\x1b[C', 2), { selected: 2, panel: 1 });
  assert.deepEqual(sidebarInput('k', 2), { selected: 2, panel: -1 });
  assert.deepEqual(sidebarInput('j', 2), { selected: 2, panel: 1 });
  assert.deepEqual(sidebarInput(' ', 2), { selected: 2, fold: true });
  assert.deepEqual(sidebarInput('z', 2), { selected: 2, foldAll: true });
  assert.deepEqual(sidebarInput('\x1b[B', 2), { selected: 3 });
  assert.deepEqual(sidebarInput('\r', 0), { selected: 0, action: 'compose' });
  assert.deepEqual(sidebarInput('q', 0), { selected: 0, action: 'queue' });
});

test('settings: sidebarCollapsedPanels round trips, is validated, keeps unknown IDs, and is omitted when empty', t => {
  fixture(t);
  const file = sidebarSettingsPath();
  assert.ok(!serializeSidebarSettings(defaultSidebarSettings()).includes('sidebarCollapsedPanels'));
  const parsed = parseSidebarSettings(JSON.stringify({ version: 1, sidebarCollapsedPanels: ['alerts', 'future:panel', 'alerts'] }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.settings.sidebarCollapsedPanels, ['alerts', 'future:panel']);
  assert.match(parseSidebarSettings(JSON.stringify({ version: 1, sidebarCollapsedPanels: 'alerts' })).error, /must be an array/);
  assert.match(parseSidebarSettings(JSON.stringify({ version: 1, sidebarCollapsedPanels: ['Bad Id'] })).error, /not a valid panel id/);

  const state = loadSidebarSettings(file);
  const saved = saveSidebarSettings(state, { ...state.settings, sidebarCollapsedPanels: ['promptr:queue', 'future:panel'] });
  assert.ok(saved.ok);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sidebarCollapsedPanels, ['promptr:queue', 'future:panel']);
  assert.deepEqual(loadSidebarSettings(file).settings.sidebarCollapsedPanels, ['promptr:queue', 'future:panel']);
});

test('commands: collapse, expand and fold parse, resolve names, and handle all and hidden panels', () => {
  assert.deepEqual(parseSidebarSettingsCommand('collapse queue').command, { kind: 'collapse', ref: 'queue', collapsed: true });
  assert.deepEqual(parseSidebarSettingsCommand('expand ALL').command, { kind: 'collapse', ref: 'all', collapsed: false });
  assert.deepEqual(parseSidebarSettingsCommand('fold alerts').command, { kind: 'collapse', ref: 'alerts', collapsed: undefined });
  assert.equal(parseSidebarSettingsCommand('fold all').ok, false);
  assert.equal(parseSidebarSettingsCommand('collapse').ok, false);

  const base = defaultSidebarSettings();
  const one = applySidebarSettingsCommand(base, parseSidebarSettingsCommand('collapse queue').command);
  assert.deepEqual(one.value.sidebarCollapsedPanels, ['promptr:queue']);
  assert.equal(one.message, 'Queue collapsed');
  const toggled = applySidebarSettingsCommand(one.value, parseSidebarSettingsCommand('fold queue').command);
  assert.deepEqual(toggled.value.sidebarCollapsedPanels, []);
  const all = applySidebarSettingsCommand(base, parseSidebarSettingsCommand('collapse all').command);
  assert.deepEqual(all.value.sidebarCollapsedPanels, [...DEFAULT_PROMPTR_PANEL_ORDER]);
  assert.deepEqual(applySidebarSettingsCommand(all.value, parseSidebarSettingsCommand('expand all').command).value.sidebarCollapsedPanels, []);
  const hidden = { ...base, sidebarPanelLayout: base.sidebarPanelLayout.map(e => (e.id === 'tools' ? { ...e, visible: false } : e)) };
  assert.equal(applySidebarSettingsCommand(hidden, parseSidebarSettingsCommand('collapse tools').command).message,
    'Tools is hidden; collapsed state saved');
  assert.match(applySidebarSettingsCommand(base, parseSidebarSettingsCommand('collapse nope').command).error, /Unknown panel/);
});

test('settings screen: f folds the selected panel in the draft, and D expands all', t => {
  fixture(t);
  const file = sidebarSettingsPath();
  const results = [];
  const d = createPanelSettingsDialog({ state: loadSidebarSettings(file), availableIds: () => [], theme, requestRender() {},
    done: r => results.push(r) });
  d.handleInput('f');
  assert.deepEqual(d.draft().sidebarCollapsedPanels, ['agent']);
  assert.match(d.render(120).join('\n'), /1 ● on  ▸ folded Agent/);
  d.handleInput('D');
  assert.deepEqual(d.draft().sidebarCollapsedPanels, []);
});

test('Pi slash commands: registered with completions, saved at once, and never show a hidden sidebar', async t => {
  const home = process.env.HOME;
  const h = controllerHarness(t, 'tui', { register: pi => promptr(pi) });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  for (const name of ['promptr-collapse', 'promptr-expand', 'promptr-fold']) assert.ok(h.commands.has(name), name);

  const complete = await h.commands.get('promptr-collapse').getArgumentCompletions('qu');
  assert.deepEqual(complete.map(item => item.value), ['queue']);
  assert.match(complete[0].description, /Queue · ▾ open/);
  assert.equal((await h.commands.get('promptr-collapse').getArgumentCompletions('')).at(0).value, 'all');
  assert.ok(!(await h.commands.get('promptr-fold').getArgumentCompletions('')).some(item => item.value === 'all'));
  const sub = await h.commands.get('promptr').getArgumentCompletions('col');
  assert.deepEqual(sub.map(item => item.value), ['collapse']);
  assert.deepEqual((await h.commands.get('promptr').getArgumentCompletions('fold al')).map(item => item.value), ['fold alerts']);

  await h.command('promptr', 'off');
  await h.command('promptr-collapse', 'queue');
  await settle();
  assert.deepEqual(JSON.parse(fs.readFileSync(sidebarSettingsPath(), 'utf8')).sidebarCollapsedPanels, ['promptr:queue']);
  assert.match(h.notices.at(-1), /Queue collapsed\. Saved\./);
  assert.equal(h.sidebar(), undefined, 'a hidden sidebar stays hidden');
  assert.match((await h.commands.get('promptr-expand').getArgumentCompletions('qu'))[0].description, /▸ folded/);

  await h.command('promptr-fold', '');
  assert.match(h.notices.at(-1), /Usage: \/promptr-fold <name>/);
  await h.command('promptr-expand', 'all');
  assert.equal(JSON.parse(fs.readFileSync(sidebarSettingsPath(), 'utf8')).sidebarCollapsedPanels, undefined);
});

test('a refused save keeps the fold for this session and says so', async t => {
  const home = process.env.HOME;
  const h = controllerHarness(t, 'tui', { register: pi => promptr(pi) });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  const file = sidebarSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  await h.command('promptr', 'on');
  await settle();
  await h.command('promptr-collapse', 'queue');
  await settle();
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'the invalid file is never overwritten');
  assert.match(h.notices.at(-1), /Queue collapsed for this session; settings not saved/);
  const lines = h.sidebar().render(44).join('\n');
  assert.match(lines, /▸ QUEUE · 0 ─/);
});

test('focused keys: j moves the cursor, Space saves a fold, z folds all and then expands all', async t => {
  const home = process.env.HOME;
  const h = controllerHarness(t, 'tui', { register: pi => promptr(pi) });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  const saved = () => JSON.parse(fs.readFileSync(sidebarSettingsPath(), 'utf8')).sidebarCollapsedPanels;
  await h.command('promptr', 'on');
  await settle();
  h.sidebar().render(44);
  await h.shortcut('alt+p');
  await settle();
  assert.match(h.sidebar().render(44).join('\n'), /AGENT ◂/, 'the cursor starts on the first panel in view');
  h.press('j');
  h.press(' ');
  await settle();
  assert.deepEqual(saved(), ['activity']);
  assert.match(h.sidebar().render(44).join('\n'), /▸ ACTIVITY ◂ ─/);
  h.press('z');
  await settle();
  assert.equal(saved().length, DEFAULT_PROMPTR_PANEL_ORDER.length);
  h.press('z');
  await settle();
  assert.equal(saved(), undefined);
});

test('kitty key events: Alt+P release and repeat keep focus; a held Alt+P after unfocus does not loop', async t => {
  const home = process.env.HOME;
  const h = controllerHarness(t, 'tui', { register: pi => promptr(pi) });
  process.env.HOME = h.root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  // Kitty keyboard protocol (CSI u): Alt is modifier 3; `:2` is a repeat, `:3` a release.
  const ALT_P = '\x1b[112;3u', ALT_P_REPEAT = '\x1b[112;3:2u', ALT_P_RELEASE = '\x1b[112;3:3u';
  const SPACE_REPEAT = '\x1b[32;1:2u', J_RELEASE = '\x1b[106;1:3u';
  /** Deliver one raw event like Pi: listeners first; returns true when a listener consumed it. */
  const deliver = raw => { for (const fn of [...h.listeners]) if (fn(raw)?.consume) return true; return false; };
  const focused = () => /AGENT ◂/.test(h.sidebar().render(44).join('\n'));
  const saved = () => (fs.existsSync(sidebarSettingsPath()) ? JSON.parse(fs.readFileSync(sidebarSettingsPath(), 'utf8')).sidebarCollapsedPanels : undefined);

  await h.command('promptr', 'on');
  await settle();
  h.sidebar().render(44);
  await h.shortcut('alt+p');
  await settle();
  assert.ok(focused());
  assert.ok(deliver(ALT_P_RELEASE), 'the release is consumed');
  assert.ok(deliver(ALT_P_REPEAT), 'a repeat is consumed');
  await settle();
  assert.ok(focused(), 'release and repeat do not end focus');
  assert.ok(deliver(J_RELEASE));
  deliver(' ');
  deliver(SPACE_REPEAT);
  deliver(SPACE_REPEAT);
  await settle();
  assert.deepEqual(saved(), ['agent'], 'a held Space folds once');

  assert.ok(deliver(ALT_P), 'a new Alt+P press ends focus');
  await settle();
  assert.ok(!focused());
  assert.ok(deliver(ALT_P_REPEAT), 'held Alt+P repeats are swallowed, so Pi does not refocus');
  assert.ok(deliver(ALT_P_REPEAT));
  assert.ok(deliver(ALT_P_RELEASE));
  assert.equal(deliver(ALT_P_REPEAT), false, 'after the release, Alt+P reaches Pi again');
});
