import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TuiAltScreen, visibleWidth } from '@earendil-works/pi-tui';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { createSplitPaneController, UNSUPPORTED_LAYOUT_MESSAGE } from '../../dist/src/sidebar/vendor/split-pane.mjs';
import * as canonical from '../../dist/src/sidebar/vendor/atelier/split-pane.mjs';
import * as bridgeImages from '../../dist/src/sidebar/vendor/image-compositor.mjs';
import * as canonicalImages from '../../dist/src/sidebar/vendor/atelier/image-compositor.mjs';
import { createTui, mountPiLayout, terminal } from './pi-layout-fixture.mjs';

const MARK = 'SIDEBAR';
const plain = line => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, '');
const sidebarComponent = split => ({ render: w => Array(split.getSidebarHeight()).fill(MARK.padEnd(w, '#')), invalidate() {} });

function start(mode, term, layout, options = {}) {
  const tui = createTui(mode, term);
  const parts = layout === false ? undefined : mountPiLayout(tui, layout);
  const warnings = [];
  const split = createSplitPaneController({ onWarning: message => warnings.push(message), ...options });
  split.attach(tui); split.show();
  const handle = tui.showOverlay(sidebarComponent(split), split.overlayOptions());
  return { tui, parts, split, handle, warnings };
}

function frame(tui, width, height) {
  if (tui.mode === 'fullscreen') return renderLayoutFrame(tui.layoutRoot, width, height, () => {}).lines;
  return tui.compositeOverlays(tui.render(width), width, height);
}

test('prototype import paths re-export the one canonical split and image compositor', () => {
  assert.equal(createSplitPaneController, canonical.createSplitPaneController);
  assert.equal(bridgeImages.createImageCompositorBinding, canonicalImages.createImageCompositorBinding);
  assert.equal(typeof bridgeImages.hasCapturingOverlay, 'function');
  assert.match(UNSUPPORTED_LAYOUT_MESSAGE, /\/promptr workspace/);
});

for (const mode of ['regular', 'fullscreen']) test(`${mode}: dock stays full width below the sidebar across sizes`, () => {
  const term = terminal();
  for (const sidebarWidth of [28, 44, 72]) for (const footerRows of [4, 6]) {
    const { tui, parts, split } = start(mode, term, { footerRows }, { defaultSidebarWidth: sidebarWidth });
    for (const [width, height] of [[91, 30], [92, 30], [140, 12], [140, 63], [200, 45]]) for (const [editorRows, widgetRows] of [[3, 0], [8, 2]]) {
      term.columns = width; term.rows = height;
      parts.editor.rows = editorRows; parts.above.rows = widgetRows;
      split.requestRender();
      for (const part of Object.values(parts)) if (part?.widths) part.widths.length = 0;
      let lines = frame(tui, width, height);
      const sidebar = width < 92 ? 0 : Math.min(sidebarWidth, width - 64);
      const label = `${mode} ${width}x${height} sidebar=${sidebarWidth} footer=${footerRows} editor=${editorRows}`;
      const dockRows = parts.dockRows();
      assert.equal(split.isVisibleAtWidth(width), width >= 92, label);
      assert.equal(split.getSidebarHeight(), Math.max(0, height - dockRows), label);
      for (const name of ['editor', 'footer', 'above']) assert.ok(parts[name].widths.every(w => w === width), `${label} ${name}`);
      if (dockRows >= height) {
        // Pi itself shrinks an oversized dock; the sidebar has no rows and paints nothing.
        assert.ok(lines.every(line => !line.includes(MARK)), label);
        continue;
      }
      assert.ok(parts.chat.widths.includes(width - sidebar), label);
      // Without a sidebar, regular Pi leaves blank rows after its content, as before.
      if (mode === 'regular' && !sidebar) while (lines.length && lines.at(-1) === '') lines = lines.slice(0, -1);
      const dock = lines.slice(-dockRows);
      assert.ok(dock.every(line => !line.includes(MARK)), `${label}: sidebar painted into the dock`);
      assert.ok(dock.slice(-footerRows).every((line, i) => line.startsWith(`footer-${i}`)), label);
      assert.ok(lines.every(line => visibleWidth(line) <= width), label);
      if (sidebar && height - dockRows > 0) assert.ok(lines.slice(0, height - dockRows).some(line => line.includes(MARK)), label);
    }
    split.dispose();
  }
});

for (const mode of ['regular', 'fullscreen']) test(`${mode}: unrecognized layout keeps Pi untouched and reports /promptr workspace once`, () => {
  const tui = createTui(mode, terminal());
  const widths = [];
  const root = { render: width => { widths.push(width); return ['Pi']; }, invalidate() {} };
  if (mode === 'regular') tui.addChild(root); else tui.setLayoutRoot(root);
  const warnings = [];
  const input = [];
  const split = createSplitPaneController({ onWarning: m => warnings.push(m), subscribeInput: fn => { input.push(fn); return () => {}; } });
  split.attach(tui); split.show();
  tui.showOverlay(sidebarComponent(split), split.overlayOptions());
  split.requestRender(); split.requestRender();
  assert.equal(split.isLayoutSupported(), false);
  assert.equal(split.isVisibleAtWidth(140), false);
  assert.deepEqual(warnings, [UNSUPPORTED_LAYOUT_MESSAGE]);
  if (mode === 'regular') { tui.render(140); assert.equal(widths.at(-1), 140); assert.equal(tui.hasOverlay(), false); }
  else assert.equal(tui.layoutRoot, root);
  assert.equal(split.beginResize(), false);
  assert.equal(input.length, 0, 'no input listener for a hidden sidebar');
  split.dispose();
  if (mode === 'fullscreen') assert.equal(tui.layoutRoot, root);
});

class SelectionScreen extends TuiAltScreen {
  getSelectionColumns(line) { return { start: 0, end: visibleWidth(line) }; }
  applySelection(screen) { return screen.map(line => `[${line}]`); }
}

test('fullscreen selection clips only sidebar rows; dock rows keep full width', () => {
  const term = terminal(140, 30);
  const tui = new SelectionScreen(term); tui.requestRender = () => {};
  const parts = mountPiLayout(tui, { footerRows: 4, editorRows: 3 });
  const split = createSplitPaneController(); split.attach(tui); split.show();
  tui.showOverlay(sidebarComponent(split), split.overlayOptions());
  split.requestRender();
  const top = split.getSidebarHeight();
  assert.equal(top, 30 - parts.dockRows());
  const wide = 'x'.repeat(140);
  assert.deepEqual(tui.getSelectionColumns(wide, 0, { start: {} }), { start: 0, end: 96 });
  assert.deepEqual(tui.getSelectionColumns(wide, top, { start: {} }), { start: 0, end: 140 });
  assert.deepEqual(tui.getSelectionColumns(wide, 0, { start: { scrollView: {} } }), { start: 0, end: 140 });
  const screen = Array.from({ length: 30 }, () => `${'m'.repeat(96)}${'s'.repeat(44)}`);
  const selected = tui.applySelection(screen);
  assert.equal(selected[top], `[${screen[top]}]`, 'dock row highlight is not clipped');
  assert.equal(plain(selected[0]), `[${'m'.repeat(95)}${'s'.repeat(44)}`, 'sidebar cells restored beside the highlighted transcript');
  split.dispose();
  assert.deepEqual(tui.getSelectionColumns(wide, 0, { start: {} }), { start: 0, end: 140 });
});

test('image repair composites the sidebar only above the dock', () => {
  const term = terminal(140, 20);
  const { tui, split } = start('fullscreen', term, { footerRows: 4, editorRows: 3 });
  split.requestRender();
  const top = split.getSidebarHeight();
  const image = '\x1b_Ga=p,i=1;\x1b\\';
  const lines = Array.from({ length: 20 }, (_, row) => `row-${row}`.padEnd(140, '.'));
  lines[1] = `img${image}`.padEnd(140, '.'); lines[top + 1] = `dock-img${image}` + '.'.repeat(100);
  const out = tui.compositeOverlays(lines, 140, 20);
  assert.ok(out[1].includes(MARK), 'transcript image row keeps the sidebar');
  assert.ok(!out[top + 1].includes(MARK), 'dock image row keeps its right side');
  assert.ok(out[top + 1].includes(image));
  split.dispose();
});

for (const mode of ['regular', 'fullscreen']) test(`${mode}: repeated show/hide, resize and dispose restore every owned hook`, () => {
  const term = terminal();
  const tui = createTui(mode, term);
  const parts = mountPiLayout(tui);
  const original = { render: tui.render, showOverlay: tui.showOverlay, hideOverlay: tui.hideOverlay,
    getSelectionColumns: tui.getSelectionColumns, applySelection: tui.applySelection, compositeOverlays: tui.compositeOverlays, root: tui.layoutRoot };
  const listeners = new Set();
  const split = createSplitPaneController({ subscribeInput: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
  split.attach(tui);
  for (let i = 0; i < 3; i++) {
    split.show();
    const handle = tui.showOverlay(sidebarComponent(split), split.overlayOptions());
    assert.equal(split.beginResize(), true);
    assert.equal(listeners.size, 1);
    split.hide(); handle.hide();
    assert.equal(listeners.size, 0, 'hide releases resize input');
  }
  if (mode === 'regular') assert.ok(term.writes.includes('\u001b[?1006l\u001b[?1002l'), 'mouse reporting disabled');
  split.dispose(); split.dispose();
  assert.equal(tui.render, original.render);
  assert.equal(tui.showOverlay, original.showOverlay);
  assert.equal(tui.hideOverlay, original.hideOverlay);
  assert.equal(tui.getSelectionColumns, original.getSelectionColumns);
  assert.equal(tui.applySelection, original.applySelection);
  assert.equal(tui.compositeOverlays, original.compositeOverlays);
  if (mode === 'fullscreen') assert.equal(tui.layoutRoot, parts.root);
  assert.equal(term.cursorShown, 0, 'a live renderer keeps its cursor state');
});

test('stopped renderer gets its cursor back on hide; a second owner never stacks hooks', () => {
  const term = terminal();
  const { tui, split } = start('fullscreen', term, {});
  const first = tui.layoutRoot;
  const warnings = [];
  const second = createSplitPaneController({ onWarning: m => warnings.push(m) });
  second.attach(tui); second.show();
  assert.equal(tui.layoutRoot, first, 'second owner does not wrap the first split');
  assert.equal(second.isVisibleAtWidth(140), false);
  assert.deepEqual(warnings, [UNSUPPORTED_LAYOUT_MESSAGE]);
  second.dispose();
  tui.stopped = true;
  split.hide();
  assert.equal(term.cursorShown, 1);
  split.dispose();
});

test('hasCapturingOverlay (bridge path) ignores the sidebar overlay and detects dialogs', () => {
  const { tui, split } = start('fullscreen', terminal(), {});
  assert.equal(bridgeImages.hasCapturingOverlay(tui), false, 'non-capturing sidebar entry only');
  const dialog = tui.showOverlay({ render: () => ['Dialog'], invalidate() {} }, { anchor: 'center', width: 20 });
  assert.equal(bridgeImages.hasCapturingOverlay(tui), true);
  dialog.hide();
  assert.equal(bridgeImages.hasCapturingOverlay(tui), false);
  assert.equal(bridgeImages.hasCapturingOverlay({}), true, 'unknown renderer: suspend plots');
  split.dispose();
});

test('fullscreen: a mouse event on the split stacks renders nothing (Pi dispatches to the boxes below)', () => {
  const { tui, parts, split } = start('fullscreen', terminal(), {});
  frame(tui, 140, 45);
  for (const part of Object.values(parts)) if (part?.widths) part.widths.length = 0;
  const root = tui.layoutRoot;
  const body = root.children[0];
  // Pi 0.87.1 calls these after the transcript and sidebar boxes; a foreign pi-tui Container
  // prototype is not skipped, so its inherited handler would render every child per mouse move.
  for (const stack of [body, root]) for (const y of [0, 10, 44]) {
    const event = { type: 'move', button: 0, x: 5, y, screenX: 5, screenY: y, width: 140, height: 45 };
    assert.equal(stack.handleMouse(event), undefined);
  }
  assert.deepEqual(parts.chat.widths, [], 'transcript was not rendered by mouse dispatch');
  assert.deepEqual(parts.editor.widths, [], 'dock was not rendered by mouse dispatch');
  split.dispose();
});
