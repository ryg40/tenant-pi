import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 buildRoutingIndex, cacheMatches, defaultRoutingConfig, describeWorkstream,
 guardSourcePath, loadRoutingIndex, saveRoutingIndex,
} from '../../dist/src/project/workstreams.mjs';

const AT = '2026-09-01T00:00:00.000Z';
const NOW = Date.parse('2026-09-07T00:00:00.000Z');

function proj(over = {}) {
 return {
  slug: 'promptr-abc123', cwd: '/git/promptr', commonGitDir: '/git/promptr/.git',
  worktreeRoot: '/git/promptr', gitDir: '/git/promptr/.git', ref: 'main',
  head: 'abc123def456', isWorktree: false, isDetached: false, isMissing: false,
  lastActivity: AT, lastActivitySource: 'messages', sessionCount: 2,
  sessionIds: ['s1'], activeSessionIds: [], observedCwds: ['/git/promptr'],
  pinned: false, note: '', ...over,
 };
}

function fakeFS({ files = {}, realpaths = null } = {}) {
 return {
  readFile: (p, n) => (p in files ? files[p].slice(0, n) : undefined),
  realpath: (p) => {
   if (realpaths !== null) return p in realpaths ? realpaths[p] : undefined;
   return p in files || Object.keys(files).some((f) => f.startsWith(p + '/')) ? p : undefined;
  },
 };
}

const cfg = (roots, extra = {}) =>
 defaultRoutingConfig({ projectRoots: roots, ...extra });

const progressDoc = JSON.stringify({
 version: 1,
 entries: [
  { id: 'a1', at: AT, text: 'did X, next Y', cwd: '/git/promptr', head: 'abc', ref: 'main', dirty: false, changed: [] },
  { id: 'b2', at: AT, text: 'did Z, next W', cwd: '/git/promptr', head: 'def', ref: 'main', dirty: true, changed: ['a.ts'] },
 ],
});

const mdDoc = `# Title

## Current snapshot
- goal is demo
- code entry: src/demo.ts

## Exact next action
- ship the demo ([guide](docs/guide.md)) ([evil](../../etc/passwd))

## Blockers
- waiting on owner

## Random notes
- ignored prose
`;

test('progress adapter: latest is current, previous is last, declared', () => {
 const io = fakeFS({ files: { '/git/promptr/progress.json': progressDoc } });
 const [e] = buildRoutingIndex([proj()], [
  { kind: 'progress', path: '/git/promptr/progress.json', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(e.draft, false);
 assert.deepEqual(e.current, { text: 'did Z, next W', kind: 'declared' });
 assert.deepEqual(e.last, { text: 'did X, next Y', kind: 'declared' });
 assert.equal(e.status, 'active');
 assert.equal(e.statusKind, 'inferred');
 assert.equal(e.coverage.complete, true);
});

test('markdown adapter: sections, blockers, code entry, links; traversal dropped', () => {
 const io = fakeFS({ files: { '/git/promptr/notes.md': mdDoc } });
 const [e] = buildRoutingIndex([proj()], [
  { kind: 'markdown', path: '/git/promptr/notes.md', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.deepEqual(e.current, { text: 'goal is demo', kind: 'declared' });
 assert.ok(e.next.text.includes('ship the demo'));
 assert.deepEqual(e.blockers, [{ text: 'waiting on owner', kind: 'declared' }]);
 assert.equal(e.codeEntry, 'src/demo.ts');
 assert.ok(e.readFirst.some((l) => l.path === 'docs/guide.md'));
 assert.ok(!e.readFirst.some((l) => l.path.includes('passwd')));
 assert.equal(e.status, 'blocked');
 assert.equal(e.statusKind, 'declared');
});

test('issue adapter: open links only, closed adds validation, bad payload skipped', () => {
 const io = fakeFS();
 const idx = buildRoutingIndex([proj()], [
  { kind: 'issue', projectKey: 'promptr-abc123', issue: { number: 21, title: 'Routing index', state: 'open' } },
  { kind: 'issue', projectKey: 'promptr-abc123', issue: { number: 20, title: 'Discovery', state: 'closed' } },
  { kind: 'issue', projectKey: 'promptr-abc123', issue: { number: -1, title: '', state: 'open' } },
 ], io, cfg(['/git']), { nowMs: () => NOW });
 const [e] = idx.entries;
 assert.ok(e.readFirst.some((l) => l.label.startsWith('#21')));
 assert.ok(e.validation.some((v) => v.command === 'gitea#20' && v.result === 'closed'));
 assert.ok(e.coverage.missing.some((m) => m.includes('unusable')));
});

test('malformed map yields partial coverage and stays draft', () => {
 const io = fakeFS({ files: { '/git/promptr/notes.md': '# Just a title\n\nprose with no sections\n' } });
 const [e] = buildRoutingIndex([proj()], [
  { kind: 'markdown', path: '/git/promptr/notes.md', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(e.draft, true);
 assert.equal(e.current.kind, 'observed');
 assert.ok(e.coverage.missing.some((m) => m.includes('no recognized sections')));
 assert.equal(e.coverage.complete, false);
});

test('no-map project gets one marked draft workstream', () => {
 const [e] = buildRoutingIndex([proj()], [], fakeFS(), cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(e.draft, true);
 assert.equal(e.status, 'draft — no map found');
 assert.equal(e.next, undefined);
 assert.equal(e.last, undefined);
 assert.deepEqual(e.coverage, { complete: false, missing: ['no routing sources'] });
 assert.equal(e.workstreamId, 'ws-promptr-abc123');
});

test('rebuild is deterministic: same fingerprint twice', () => {
 const io = fakeFS({ files: { '/git/promptr/progress.json': progressDoc } });
 const inputs = [{ kind: 'progress', path: '/git/promptr/progress.json', projectKey: 'promptr-abc123' }];
 const a = buildRoutingIndex([proj()], inputs, io, cfg(['/git']), { nowMs: () => NOW });
 const b = buildRoutingIndex([proj()], inputs, io, cfg(['/git']), { nowMs: () => NOW + 99999 });
 assert.equal(a.fingerprint, b.fingerprint);
 assert.equal(a.entries[0].fingerprint, b.entries[0].fingerprint);
 assert.ok(cacheMatches({ version: 1, fingerprint: a.fingerprint, entries: a.entries }, b));
});

test('traversal rejected: outside roots and symlink escape', () => {
 const io = fakeFS({
  files: { '/git/promptr/notes.md': mdDoc },
  realpaths: { '/git/promptr/notes.md': '/etc/evil.md' },
 });
 assert.equal(guardSourcePath('/etc/passwd', ['/git'], io), undefined);
 assert.equal(guardSourcePath('/git/promptr/notes.md', ['/git'], io), undefined);
 const [e] = buildRoutingIndex([proj()], [
  { kind: 'markdown', path: '/git/promptr/notes.md', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(e.draft, true);
 assert.ok(e.coverage.missing.some((m) => m.includes('rejected')));
});

test('no fabricated completion: unknowns absent, no percentages', () => {
 const [e] = buildRoutingIndex([proj({ head: 'unknown', lastActivity: NOW })], [], fakeFS(), cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(e.current, undefined);
 assert.equal(e.codeEntry, '');
 assert.deepEqual(e.validation, []);
 const json = JSON.stringify(buildRoutingIndex([proj()], [], fakeFS(), cfg(['/git']), { nowMs: () => NOW }));
 assert.ok(!json.includes('%'));
 assert.ok(!/confidence/i.test(json));
});

test('one-off edits merge: two sources, one workstream', () => {
 const io = fakeFS({ files: {
  '/git/promptr/a.md': '## Current snapshot\n- from A\n',
  '/git/promptr/b.md': '## Exact next action\n- from B\n',
 } });
 const [e] = buildRoutingIndex([proj()], [
  { kind: 'markdown', path: '/git/promptr/a.md', projectKey: 'promptr-abc123' },
  { kind: 'markdown', path: '/git/promptr/b.md', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(buildRoutingIndex([proj()], [
  { kind: 'markdown', path: '/git/promptr/a.md', projectKey: 'promptr-abc123' },
  { kind: 'markdown', path: '/git/promptr/b.md', projectKey: 'promptr-abc123' },
 ], io, cfg(['/git']), { nowMs: () => NOW }).entries.length, 1);
 assert.equal(e.sources.length, 3);
 assert.ok(e.current.text.includes('from A'));
 assert.ok(e.next.text.includes('from B'));
});

test('recent activity infers active; stale infers idle', () => {
 const fresh = proj({ lastActivity: new Date(NOW - 86400000).toISOString() });
 const io = fakeFS({ files: { '/git/promptr/progress.json': progressDoc } });
 const inputs = [{ kind: 'progress', path: '/git/promptr/progress.json', projectKey: 'promptr-abc123' }];
 const [a] = buildRoutingIndex([fresh], inputs, io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(a.status, 'active');
 assert.equal(a.statusKind, 'inferred');
 const stale = proj({ lastActivity: '2026-08-01T00:00:00.000Z' });
 const [s] = buildRoutingIndex([stale], inputs, io, cfg(['/git']), { nowMs: () => NOW }).entries;
 assert.equal(s.status, 'idle');
 assert.equal(s.statusKind, 'inferred');
});

test('persist/load roundtrip and stale cache detection', async () => {
 const { default: fs } = await import('node:fs');
 const { default: os } = await import('node:os');
 const { default: path } = await import('node:path');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-routing-'));
 try {
  const file = path.join(dir, 'index.json');
  const io = fakeFS({ files: { '/git/promptr/progress.json': progressDoc } });
  const idx = buildRoutingIndex([proj()], [
   { kind: 'progress', path: '/git/promptr/progress.json', projectKey: 'promptr-abc123' },
  ], io, cfg(['/git']), { nowMs: () => NOW });
  saveRoutingIndex(file, idx);
  const { readText } = await import('../../dist/src/state/paths.mjs');
  const saved = loadRoutingIndex(readText(file));
  assert.ok(saved && cacheMatches(saved, idx));
  assert.equal(loadRoutingIndex('garbage'), undefined);
  assert.equal(cacheMatches(undefined, idx), false);
  const other = { ...idx, fingerprint: 'deadbeef' };
  assert.equal(cacheMatches({ version: 1, fingerprint: 'deadbeef', entries: [] }, other), true);
  assert.equal(cacheMatches({ version: 1, fingerprint: 'nope', entries: [] }, other), false);
 } finally {
  fs.rmSync(dir, { recursive: true, force: true });
 }
});

test('max-entries stops with partial flag', () => {
 const io = fakeFS();
 const idx = buildRoutingIndex([proj(), proj({ slug: 'other-1' })], [], io, cfg(['/git'], { maxEntries: 1 }), { nowMs: () => NOW });
 assert.equal(idx.entries.length, 1);
 assert.equal(idx.partial, true);
 assert.equal(idx.stoppedBy, 'max-entries');
});

test('describeWorkstream names evidence without percents', () => {
 const [e] = buildRoutingIndex([proj()], [], fakeFS(), cfg(['/git']), { nowMs: () => NOW }).entries;
 const line = describeWorkstream(e);
 assert.ok(line.includes('ws-promptr-abc123'));
 assert.ok(line.includes('(draft)'));
 assert.ok(!line.includes('%'));
});

// LEGACY_ISSUE_REPO needs no override. It is the fallback of an issue
// input without a repository, and no production code creates an issue input.
test('no production caller gives buildRoutingIndex an issue input, so the legacy repository is not read', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('../../src/', import.meta.url);
  const calls = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mts')) continue;
    const file = `${entry.parentPath}/${entry.name}`;
    const source = readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      if (/\b(buildRoutingIndex|issueLocator)\(/.test(line) && !/^export function /.test(line)) calls.push(`${file.slice(file.lastIndexOf('/src/') + 1)}: ${line.trim()}`);
    }
  }
  const outside = calls.filter((c) => !c.startsWith('src/project/workstreams.mts:'));
  assert.equal(outside.length, 1, outside.join('\n'));
  assert.match(outside[0], /^src\/briefing\/overview\.mts: const index = buildRoutingIndex\(discovered\.projects, \[\], /);
});
