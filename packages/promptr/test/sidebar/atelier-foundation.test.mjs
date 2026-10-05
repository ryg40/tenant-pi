import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  DEFAULT_PROMPTR_PANEL_ORDER, PROMPTR_SIDEBAR_CHANNEL, PROMPTR_SIDEBAR_PROTOCOL_VERSION, defaultPromptrPanelLayout,
  describeSidebarPanels, renderPromptrSidebar,
} from '../../dist/src/sidebar/atelier-adapter.mjs';
import { createUnavailableTelemetry } from '../../dist/src/sidebar/telemetry.mjs';

const vendor = fileURLToPath(new URL('../../src/sidebar/vendor/atelier/', import.meta.url));
const theme = { fg: (_color, value) => value, bold: value => value, italic: value => value };
const panels = [
  { id: 'promptr:tasks', rows: ['#7 foundation'] },
  { id: 'promptr:queue', rows: ['1 queued prompt'] },
  { id: 'promptr:draft', rows: ['draft text'] },
];
const render = (layout, height = 120) => renderPromptrSidebar({
  telemetry: createUnavailableTelemetry('/tmp/promptr-fixture').snapshot(), layout, promptrPanels: panels,
  width: 44, height, theme, colorEnabled: false, now: 0,
});

test('vendored Atelier modules keep attribution and never install Atelier chrome or commands', () => {
  const files = fs.readdirSync(vendor).filter(name => name.endsWith('.mts'));
  assert.equal(files.length, 21);
  for (const name of files) {
    const source = fs.readFileSync(vendor + name, 'utf8');
    assert.match(source, /^\/\/ Vendored from pi-atelier v0\.12\.0 .*3ff521f618cf.*371b847e525f/, name);
    assert.doesNotMatch(source, /\.(setFooter|setEditorComponent|registerCommand|registerShortcut)\(/, name);
    assert.doesNotMatch(source, /"\/atelier|pi-atelier:sidebar-panels/, name);
  }
  assert.equal(PROMPTR_SIDEBAR_CHANNEL, 'promptr:sidebar-panels');
  assert.equal(PROMPTR_SIDEBAR_PROTOCOL_VERSION, 1);
});

test('default layout lists all fourteen panels in the default order, all enabled', () => {
  assert.deepEqual(defaultPromptrPanelLayout().map(entry => entry.id), [...DEFAULT_PROMPTR_PANEL_ORDER]);
  assert.equal(DEFAULT_PROMPTR_PANEL_ORDER.length, 14);
  assert.ok(defaultPromptrPanelLayout().every(entry => entry.visible));
});

test('render adapter follows layout order, skips hidden panels and stays within bounds', () => {
  const layout = [{ id: 'agent', visible: true }, { id: 'promptr:queue', visible: true },
    { id: 'promptr:tasks', visible: true }, { id: 'promptr:draft', visible: false }, { id: 'promptr:notebook', visible: true }];
  const text = render(layout).join('\n');
  assert.ok(text.indexOf('QUEUE') > 0 && text.indexOf('QUEUE') < text.indexOf('TASKS'));
  assert.ok(!text.includes('DRAFT'));
  assert.ok(!text.includes('NOTEBOOK'), 'unavailable panel renders nothing');
  for (const height of [120, 12, 3]) {
    const lines = render(layout, height);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= 44));
  }
});

test('descriptors keep disabled and unavailable panels visible to settings', () => {
  const layout = [{ id: 'usage', visible: false }, { id: 'promptr:notebook', visible: true }, { id: 'promptr:tasks', visible: true }];
  assert.deepEqual(describeSidebarPanels(layout, ['promptr:tasks']), [
    { id: 'usage', title: 'Usage', visible: false, order: 0, available: true, builtin: true },
    { id: 'promptr:notebook', title: 'Notebook', visible: true, order: 1, available: false, builtin: false },
    { id: 'promptr:tasks', title: 'Tasks', visible: true, order: 2, available: true, builtin: false },
  ]);
});

test('unavailable telemetry reports missing usage instead of zero values', () => {
  const source = createUnavailableTelemetry('/tmp/promptr-fixture');
  const snapshot = source.snapshot();
  assert.equal(snapshot.metrics.usageAvailable, false);
  assert.equal(snapshot.workspacePulse.status, 'unavailable');
  source.subscribe(() => {})();
  source.dispose(); source.dispose();
});
