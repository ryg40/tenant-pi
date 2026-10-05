// Visual hierarchy of the briefing/Resume dialogs.
//
// These checks are about *layout and legibility invariants*, not cosmetic
// strings: nothing overflows, the actions and the way out stay on screen at
// every tested geometry, the selected choice is identifiable with color
// stripped, and no rendering change can confirm or send on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { CompanionBriefingDialogs } from '../../dist/src/companion/briefing-dialogs.mjs';

const COLOR = process.env.NO_COLOR === undefined || process.env.NO_COLOR === '';
const ACCENT_BOLD = '[1;36m';

/** Minimal TuiAltScreen stand-in; captures the component handed to setLayoutRoot. */
function harness(columns, rows) {
  const state = { root: undefined, renders: 0 };
  const tui = {
    terminal: { rows, columns },
    setLayoutRoot: (component) => { state.root = component; },
    requestRender() { state.renders += 1; },
  };
  return { tui, dialogs: new CompanionBriefingDialogs(tui), state };
}

const paint = (component, width) => component.render(width);
const plain = (lines) => lines.map((line) => stripTerminalSequences(line));
const joined = (component, width) => plain(paint(component, width)).join('\n');

/** Every invariant a frame must satisfy at a given geometry. */
function assertFrameFits(component, width, rows, label) {
  const frame = paint(component, width);
  assert.ok(frame.length <= rows, `${label}: ${frame.length} rows exceeds ${rows}`);
  for (const line of frame) {
    assert.ok(visibleWidth(line) <= width, `${label}: row wider than ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
  }
  return frame;
}

const LONG_HEADING = [
  'PROMPTR · promptr — project briefing overview with a heading long enough to wrap at every tested width',
  '/home/example/workspaces/promptr',
  'Briefing: draft · updated 2026-09-07T00:00:00Z',
  ...Array.from({ length: 24 }, (_, i) => `Synthetic briefing preview line ${i} — prose that must stay in the scrollable region.`),
  'Remote: not connected',
  'Local: /home/example/workspaces/promptr/.promptr/briefing.md',
].join('\n');

const OVERVIEW_CHOICES = ['Resume', 'Edit briefing', 'Save locally', 'Connect OpenKnowledge',
  'Browse projects', 'New task', 'Open workspace', 'View sources', 'Close'];

test('dialog-style: long heading never costs the actions or the way out (97x63, 40x24)', () => {
  for (const [columns, rows] of [[97, 63], [40, 24]]) {
    const { dialogs, state } = harness(columns, rows);
    void dialogs.select(LONG_HEADING, OVERVIEW_CHOICES);
    const frame = assertFrameFits(state.root, columns, rows, `${columns}x${rows}`);
    const text = plain(frame);
    // The dialog identity is pinned above the scroll region.
    assert.ok(text.slice(0, 3).some((line) => line.includes('PROMPTR ·')), 'primary heading not pinned at top');
    // Actions are on screen, and so is the cancellation help.
    assert.ok(text.some((line) => line.includes('Resume')), 'first action missing');
    assert.ok(text.at(-1).includes('Esc cancel'), `footer lost: ${JSON.stringify(text.at(-1))}`);
    // Long prose is separated from the actions by a labelled rule.
    assert.match(text.join('\n'), /── CHOOSE/);
  }
});

const HUGE_HEADING = [
  'PROMPTR · promptr',
  ...Array.from({ length: 120 }, (_, i) => `Synthetic briefing preview line ${i}.`),
  'Local: /home/example/workspaces/promptr/.promptr/briefing.md',
].join('\n');

test('dialog-style: scroll position is shown only while text is unread, and PgDn reaches the tail', () => {
  const { dialogs, state } = harness(97, 63);
  void dialogs.select(HUGE_HEADING, OVERVIEW_CHOICES);
  assert.match(joined(state.root, 97), /↕ 1–\d+\/\d+/, 'expected a read-position indicator for a scrolling heading');
  let text = joined(state.root, 97);
  let guardRail = 0;
  while (!text.includes('Local: /home/example') && guardRail < 20) {
    dialogs.handleInput('\x1b[6~'); // PgDn
    text = joined(state.root, 97);
    guardRail += 1;
  }
  assert.ok(text.includes('Local: /home/example'), 'tail of the heading unreachable by PgDn');
  assert.match(text, /↕ \d+–\d+\/\d+/, 'read position lost while scrolled');

  const short = harness(97, 63);
  void short.dialogs.select('Resume /home/example/workspaces/promptr\nCurrent Pi session: main Pi w4:p0',
    ['Continue here', 'Start fresh', 'Cancel']);
  const fits = joined(short.state.root, 97);
  assert.doesNotMatch(fits, /↕/, 'a fully visible heading must not claim a read position');
  // Exact target/session information is never dropped.
  assert.match(fits, /Current Pi session: main Pi w4:p0/);
  assert.ok(fits.split('\n').at(-1).includes('Esc cancel'));
});

test('dialog-style: confirmation keeps Cancel selected and marks it without relying on color', async () => {
  const { dialogs, state } = harness(97, 63);
  const promise = dialogs.confirm('Connect this briefing target?',
    'https://openknowledge.example / projects/promptr/brief\nConnect only reads. Save + sync will create/replace this page after a comparison.');
  const text = joined(state.root, 97);
  assert.match(text, /→ Cancel/, 'selected choice must carry a textual marker');
  assert.doesNotMatch(text, /→ Confirm/);
  assert.match(text, /Cancel is selected/, 'footer must state the default in words');
  assert.match(text, /── CONFIRM ─/);
  // The decision-critical target stays at normal contrast in the body region.
  assert.match(text, /projects\/promptr\/brief/);
  if (COLOR) assert.ok(paint(state.root, 97).some((line) => line.includes(ACCENT_BOLD)), 'expected a cyan focus accent');

  // A bracketed paste containing Enter must not answer the question.
  dialogs.handleInput('\x1b[200~\r\x1b[201~');
  let settled = false;
  void promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, 'pasted Enter confirmed the dialog');
  dialogs.handleInput('\r');
  assert.equal(await promise, false, 'Enter on the default must cancel');
});

test('dialog-style: selecting returns the untouched semantic string', async () => {
  for (const [steps, expected] of [[0, 'Continue here'], [1, 'Start fresh'], [2, 'Cancel']]) {
    const { dialogs, state } = harness(97, 63);
    const promise = dialogs.select('Resume /home/example', ['Continue here', 'Start fresh', 'Cancel']);
    paint(state.root, 97);
    for (let i = 0; i < steps; i += 1) dialogs.handleInput('\x1b[B');
    dialogs.handleInput('\r');
    assert.equal(await promise, expected);
  }
});

test('dialog-style: a multiline save-success notice stays readable and is never dropped', () => {
  const { dialogs, state } = harness(97, 63);
  dialogs.notify('Saved locally 2026-09-07T00:00:00Z.\nRetained revisions: /home/example/.promptr/briefing-history\nRemote: not connected', 'info');
  void dialogs.select('PROMPTR · promptr\n/home/example', ['Resume', 'Close']);
  const text = joined(state.root, 97);
  for (const fragment of ['Saved locally 2026-09-07T00:00:00Z.', 'Retained revisions:', 'Remote: not connected']) {
    assert.ok(text.includes(fragment), `notice line hidden: ${fragment}`);
  }
});

test('dialog-style: warnings are marked as well as coloured, and clear when the dialog resolves', async () => {
  const { dialogs, state } = harness(97, 63);
  dialogs.notify('Send failed or uncertain; the packet was kept and will not be replayed.', 'warning');
  const promise = dialogs.select('Briefing outcome', ['Back to workspace']);
  const text = joined(state.root, 97);
  assert.match(text, /⚠ Send failed or uncertain/, 'warning marker missing');
  dialogs.handleInput('\r');
  assert.equal(await promise, 'Back to workspace');

  const next = dialogs.select('PROMPTR · promptr', ['Close']);
  assert.doesNotMatch(joined(state.root, 97), /Send failed or uncertain/, 'stale notice leaked into the next dialog');
  dialogs.handleInput('\x1b');
  assert.equal(await next, undefined);
});

test('dialog-style: editor mode labels its region, keeps the save hint, and returns exact bytes', async () => {
  const { dialogs, state } = harness(40, 24);
  const exact = '# Briefing\n\nExact café 🌱 line\n  indented tail';
  const promise = dialogs.editor('Review/edit continuation — save locally, then choose where; Esc cancels', exact);
  const frame = assertFrameFits(state.root, 40, 24, 'editor 40x24');
  const text = plain(frame);
  // The Editor draws its own accented border; a second labelled rule stacked on
  // top of it was pure noise, so the dialog must not add one here.
  assert.doesNotMatch(text.join('\n'), /── EDIT/, 'editor must not stack a rule on the editor border');
  assert.ok(text.some((line) => /^─{4,}/.test(line)), 'editor border missing as the region boundary');
  if (COLOR) assert.ok(frame.some((line) => line.includes('[36m') && line.includes('─')), 'editor border not accented');
  assert.ok(text.at(-1).includes('Ctrl+S save'), `editor footer lost: ${JSON.stringify(text.at(-1))}`);
  assert.ok(text.at(-1).includes('Esc cancel'));
  dialogs.handleInput('\x13'); // Ctrl+S
  assert.equal(await promise, exact);
});

test('dialog-style: tiny and narrow widths never overflow and never lose the footer', () => {
  for (const width of [1, 2, 3, 5, 12, 13, 14, 20]) {
    const { dialogs, state } = harness(width, 24);
    void dialogs.select(LONG_HEADING, OVERVIEW_CHOICES);
    const frame = assertFrameFits(state.root, width, 24, `select w${width}`);
    assert.ok(frame.length >= 1);
    if (width >= 20) assert.ok(plain(frame).at(-1).includes('Esc cancel'), `footer lost at width ${width}`);
    // Below the rule width the labelled rule is dropped rather than truncated.
    if (width < 14) assert.doesNotMatch(plain(frame).join('\n'), /── CHOOSE/);
  }
});

test('dialog-style: a very short viewport still shows an action row and the footer', () => {
  const { dialogs, state } = harness(40, 6);
  void dialogs.select(LONG_HEADING, OVERVIEW_CHOICES);
  const frame = assertFrameFits(state.root, 40, 6, 'select 40x6');
  const text = plain(frame);
  assert.ok(text.some((line) => line.includes('→ Resume')), 'no action row survived a 6-row viewport');
  assert.ok(text.at(-1).includes('Esc cancel'), `footer lost in a 6-row viewport: ${JSON.stringify(text)}`);
});

test('dialog-style: long choice labels are truncated, not wrapped past the pane', () => {
  const long = Array.from({ length: 12 }, (_, i) => `Option ${i} — ${'x'.repeat(160)}`);
  for (const [columns, rows] of [[97, 63], [40, 24]]) {
    const { dialogs, state } = harness(columns, rows);
    void dialogs.select('Recent projects (12)\nSelecting a row inspects only — nothing sends or launches.', long);
    const frame = assertFrameFits(state.root, columns, rows, `long choices ${columns}x${rows}`);
    assert.ok(plain(frame).some((line) => line.includes('→ Option 0')), 'selected long choice not marked');
    assert.ok(plain(frame).at(-1).includes('Esc cancel'));
  }
});

test('dialog-style: rendering alone never resolves, sends, or launches', async () => {
  const { dialogs, state } = harness(97, 63);
  const promise = dialogs.select(LONG_HEADING, OVERVIEW_CHOICES);
  let settled = false;
  void promise.then(() => { settled = true; });
  for (const width of [1, 5, 40, 97]) paint(state.root, width);
  dialogs.handleInput('\x1b[6~');
  dialogs.handleInput('\x1b[5~');
  dialogs.handleInput('\x1b[1;1:3B'); // Kitty key-release must stay filtered
  paint(state.root, 97);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, 'render/scroll resolved the dialog');
  dialogs.handleInput('\r');
  assert.equal(await promise, 'Resume', 'key-release moved the selection');
});
