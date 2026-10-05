import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as browse from '../../dist/src/project/browse.mjs';
import {
 buildBrowseModel, buildResumeDraft, cancelBrowse, guardResume, inspectRow,
 refreshBrowseModel, resumeCard, rowLabel, stalenessLabel,
} from '../../dist/src/project/browse.mjs';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const H = 3_600_000, D = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function proj(over = {}) {
 return {
  slug: 'promptr-abc123', cwd: '/git/promptr', commonGitDir: '/git/promptr/.git',
  worktreeRoot: '/git/promptr', gitDir: '/git/promptr/.git', ref: 'main',
  head: 'abc123def456', isWorktree: false, isDetached: false, isMissing: false,
  lastActivity: iso(NOW - 2 * H), lastActivitySource: 'messages', sessionCount: 2,
  sessionIds: ['s1'], activeSessionIds: [], observedCwds: ['/git/promptr'],
  pinned: false, note: '', ...over,
 };
}

function entry(over = {}) {
 return {
  workstreamId: 'ws-promptr-abc123', projectKey: 'promptr-abc123',
  status: 'active', statusKind: 'inferred',
  current: { text: 'ship browse slice', kind: 'declared' },
  next: { text: 'wire browse into overview', kind: 'declared' },
  readFirst: [{ label: 'plan', path: '/git/promptr/docs/plans/effortless-resume.md' }],
  codeEntry: '/git/promptr/extension/src/project/browse.mts',
  validation: [{ command: 'npm test', ref: 'main', result: 'passed', at: iso(NOW - H) }],
  blockers: [],
  sources: [{ locator: 'progress:/git/promptr/x', revision: 'abc', observedAt: iso(NOW - H), kind: 'progress' }],
  coverage: { complete: true, missing: [] },
  evidencedCheckpoints: 0, draft: false, fingerprint: 'f1', ...over,
 };
}

const drafts = () => ({ scratch: 'note', composer: 'comp', queue: ['q1'], selection: [3, 7] });

test('rows sort active first, then recent, missing trailing; unindexed projects get draft rows', () => {
 const stale = proj({ slug: 'old-1', cwd: '/git/old', lastActivity: iso(NOW - 20 * D) });
 const active = proj({ slug: 'live-2', cwd: '/git/live', lastActivity: iso(NOW - 30 * D), activeSessionIds: ['s9'], sessionIds: ['s9'] });
 const missing = proj({ slug: 'gone-3', cwd: '/git/gone', isMissing: true, lastActivity: iso(NOW - H) });
 const model = buildBrowseModel([stale, active, missing], { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW });
 assert.deepEqual(model.rows.map((r) => r.slug), ['live-2', 'old-1', 'gone-3']);
 assert.equal(model.rows[0].activeWriter, true);
 assert.equal(model.rows[0].staleness, 'active now');
 assert.equal(model.rows[2].missing, true);
 assert.equal(model.rows[2].draft, true);
 assert.equal(model.rows[2].status, 'draft — no map found');
});

test('indexed rows carry workstream status, counts, and bounded ASCII labels', () => {
 const model = buildBrowseModel([proj()], { version: 1, entries: [entry()], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW });
 const [row] = model.rows;
 assert.equal(row.status, 'active');
 assert.equal(row.next, 'wire browse into overview');
 assert.equal(row.readFirst, 1);
 assert.equal(row.draft, false);
 const label = rowLabel(row);
 assert.ok(label.length <= 160);
 assert.ok(!/[\x00-\x1F\x7F]/.test(label));
 assert.match(label, /promptr-abc123/);
});

test('staleness labels never invent recency', () => {
 assert.equal(stalenessLabel('not-a-date', NOW), 'unknown');
 assert.equal(stalenessLabel(iso(NOW - 30_000), NOW), 'just now');
 assert.equal(stalenessLabel(iso(NOW - 5 * 60_000), NOW), '5m ago');
 assert.equal(stalenessLabel(iso(NOW - 3 * H), NOW), '3h ago');
 assert.equal(stalenessLabel(iso(NOW - 9 * D), NOW), '9d ago');
 assert.equal(stalenessLabel(iso(NOW - 60 * D), NOW), 'on 2026-07-09');
 assert.equal(stalenessLabel(iso(NOW + H), NOW), 'just now');
});

test('browse module has no send/launch path: static import scan + export surface', () => {
 const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'project', 'browse.mts'), 'utf8');
 const imports = src.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('import '));
 assert.ok(imports.length > 0);
 for (const line of imports) {
  for (const token of ['briefing-send', 'briefing-fresh', 'manual-send', 'extension/index', 'coordinatr', 'child_process', 'execFile', 'spawn', 'sendUserMessage', 'worker_threads']) {
   assert.ok(!line.includes(token), `browse.mts imports forbidden ${token}: ${line}`);
  }
 }
 for (const key of Object.keys(browse)) {
  assert.ok(!/send|launch|submit|prompt|exec|queue|drain/i.test(key), `suspicious export ${key}`);
 }
});

test('inspect/select/refresh/draft paths produce no side effects on frozen inputs', () => {
 const p = Object.freeze(proj());
 const e = Object.freeze(entry());
 const model = buildBrowseModel([p], { version: 1, entries: [e], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW });
 const before = JSON.stringify([p, e]);
 const lines = inspectRow(model, { version: 1, entries: [e], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, p.slug);
 assert.ok(lines.length > 4);
 assert.ok(lines.some((l) => l.includes('[declared]')));
 const draft = buildResumeDraft(model.rows[0], e);
 assert.match(draft.text, /promptr-abc123/);
 assert.match(draft.text, /wire browse into overview/);
 assert.equal(JSON.stringify([p, e]), before);
 assert.deepEqual(inspectRow(model, { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, 'nope')[0].match(/nope/)?.[0], 'nope');
});

test('guards block missing, live writers, wrong cwd, and moved HEAD', () => {
 const good = buildBrowseModel([proj()], { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW }).rows[0];
 assert.deepEqual(guardResume(good, { cwd: '/git/promptr', head: 'abc123def456' }), { ok: true, warnings: [] });
 const missing = buildBrowseModel([proj({ isMissing: true })], { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW }).rows[0];
 assert.equal(guardResume(missing, { cwd: '/git/promptr', head: 'x' }).ok, false);
 const live = buildBrowseModel([proj({ activeSessionIds: ['s9'] })], { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW }).rows[0];
 const gLive = guardResume(live, { cwd: '/git/promptr', head: 'abc123def456' });
 assert.equal(gLive.ok, false);
 assert.match(gLive.warnings.join(' '), /second writer/);
 const gCwd = guardResume(good, { cwd: '/git/elsewhere', head: 'abc123def456' });
 assert.equal(gCwd.ok, false);
 assert.match(gCwd.warnings.join(' '), /verified cwd/);
 const gHead = guardResume(good, { cwd: '/git/promptr', head: 'moved999' });
 assert.equal(gHead.ok, false);
 assert.match(gHead.warnings.join(' '), /refresh first/);
 const gUnknown = guardResume(good, { cwd: '/git/promptr', head: 'unknown' });
 assert.equal(gUnknown.ok, true);
 assert.equal(gUnknown.warnings.length, 1);
});

test('resume card is data-only: fixed actions, no auto-submit', () => {
 const card = resumeCard(proj(), entry());
 assert.equal(card.title, 'Resume: promptr-abc123');
 assert.deepEqual(card.actions, ['inspect', 'refresh', 'copy', 'explicit-start']);
 assert.ok(card.lines.length >= 2);
 for (const v of [...card.lines, ...card.actions]) assert.equal(typeof v, 'string');
 const bare = resumeCard(proj(), undefined);
 assert.ok(bare.lines.some((l) => l.includes('No routing entry')));
});

test('refresh keeps drafts and selection; cancel preserves the session', () => {
 const d = drafts();
 const prev = { model: buildBrowseModel([proj()], { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' }, { now: NOW }), drafts: d, selectedKey: 'promptr-abc123' };
 const next = refreshBrowseModel({ discovered: [proj(), proj({ slug: 'new-9', cwd: '/git/new' })], index: { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' } }, prev, { now: NOW });
 assert.equal(next.drafts, d);
 assert.equal(next.selectedKey, 'promptr-abc123');
 assert.equal(next.model.rows.length, 2);
 const dropped = refreshBrowseModel({ discovered: [proj({ slug: 'new-9', cwd: '/git/new' })], index: { version: 1, entries: [], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' } }, prev, { now: NOW });
 assert.equal(dropped.selectedKey, undefined);
 assert.equal(dropped.drafts, d);
 assert.equal(cancelBrowse(prev), prev);
});

test('re-render is stable and labels stay bounded', () => {
 const discovered = [proj(), proj({ slug: 'b-2', cwd: '/git/b', lastActivity: iso(NOW - 5 * D) })];
 const index = { version: 1, entries: [entry()], skipped: [], partial: false, stoppedBy: '', fingerprint: 'i' };
 const a = buildBrowseModel(discovered, index, { now: NOW });
 const b = buildBrowseModel(discovered, index, { now: NOW });
 assert.deepEqual(a.rows.map(rowLabel), b.rows.map(rowLabel));
});
