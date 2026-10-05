import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 saveThenScheduleWorkspaceMirror, workspaceOkHeaderLabel,
} from '../../dist/src/companion/spike.mjs';
import { CompanionSpikeView } from '../../dist/src/companion/view.mjs';

const ok = { state: 'ok', at: 1_000, created: [] };

test('persistent integration saves locally before scheduling and does not schedule after save failure', () => {
 const order = [];
 saveThenScheduleWorkspaceMirror(() => order.push('save'), () => order.push('schedule'));
 assert.deepEqual(order, ['save', 'schedule']);
 assert.throws(() => saveThenScheduleWorkspaceMirror(() => { order.push('failed save'); throw new Error('disk'); }, () => order.push('bad schedule')), /disk/);
 assert.deepEqual(order, ['save', 'schedule', 'failed save']);
});

test('pending workspace write stays visible despite a healthy reachability status', () => {
 assert.equal(workspaceOkHeaderLabel(ok, 'pending', 2_000), 'OK pending');
 assert.equal(workspaceOkHeaderLabel(ok, 'synced', 2_000), 'OK 1s');
 assert.equal(workspaceOkHeaderLabel({ state: 'offline', reason: 'down', at: 2_000 }, 'synced', 2_000), 'OK offline');
 assert.equal(workspaceOkHeaderLabel({ state: 'unbound', reason: 'not connected' }, 'unbound', 2_000), 'OK unbound');
});

test('companion header renders the wired pending label', () => {
 const tui = { requestRender() {}, terminal: { rows: 30, columns: 100 } };
 const view = new CompanionSpikeView(tui, { noteText: 'note', hosted: true, overviewNavigation: true, projectLabel: 'promptr' });
 view.setHeaderStatus({ git: 'main @abcdef1', pi: 'Pi w8:p2 idle', ok: 'OK pending' });
 const plain = view.renderFrame(100, 30).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
 assert.ok(plain.some((line) => line.includes('PROMPTR · promptr · main @abcdef1 · Pi w8:p2 idle · OK pending')));
});
