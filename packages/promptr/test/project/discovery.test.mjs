import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
 defaultDiscoveryConfig, describeProject, discoverRecentProjects, isWithinWindow,
 latestMessageTimestamp, maxChunkTimestamp, nodeDiscoveryFS, parseSessionHeader, underPrefixes,
} from '../../dist/src/project/discovery.mjs';

const DAY = 86_400_000;
const nowIso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

function sessionFile({ id, cwd, at, messages = [] }) {
 const head = JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd });
 const lines = [head, ...messages.map((ts, i) =>
  JSON.stringify({ type: 'message', id: `m${i}`, timestamp: ts, message: { role: 'user', content: [] } }))];
 return lines.join('\n') + '\n';
}

// In-memory fake: no real sessions, no real repos.
function fakeFS({ files, realpaths = {}, dirs = null, identities = {} }) {
 const names = Object.keys(files).sort();
 return {
  listSessionFiles: () => [...names],
  readHead: (f, n) => (f in files ? files[f].slice(0, n) : undefined),
  readTail: (f, n) => (f in files ? files[f].slice(-n) : undefined),
  realpath: (p) => (p in realpaths ? realpaths[p] : (dirs === null || dirs.has(p) ? p : undefined)),
  isDirectory: (p) => (dirs === null ? true : dirs.has(p)),
  gitIdentity: (cwd) => identities[cwd],
 };
}

function ident(dir, { ref = 'main', head = 'abc123def456', detached = false } = {}) {
 return {
  commonGitDir: path.join(dir, '.git'), gitDir: path.join(dir, '.git'),
  worktreeRoot: dir, ref: detached ? '' : ref, head, detached,
 };
}

function baseConfig(roots, extra = {}) {
 return defaultDiscoveryConfig({
  sessionRoots: ['/sessions'], projectRoots: [roots], recentDays: 14, ...extra,
 });
}

test('parseSessionHeader accepts v3 headers, rejects garbage', () => {
 const good = parseSessionHeader(sessionFile({ id: 's1', cwd: '/x', at: nowIso(0) }));
 assert.deepEqual(good, { id: 's1', timestamp: good.timestamp, cwd: '/x' });
 assert.equal(parseSessionHeader(''), undefined);
 assert.equal(parseSessionHeader('{"type":"message"}'), undefined);
 assert.equal(parseSessionHeader('{"type":"session","id":"","timestamp":"x","cwd":"/x"}'), undefined);
 assert.equal(parseSessionHeader('{"type":"session","id":"s","timestamp":"not-a-date","cwd":"/x"}'), undefined);
});

test('maxChunkTimestamp picks latest, ignores garbage', () => {
 const t = maxChunkTimestamp('no stamps here {"timestamp": "oops"}');
 assert.equal(t, undefined);
 const a = '2026-01-01T00:00:00.000Z';
 const b = '2026-06-01T00:00:00.000Z';
 assert.equal(maxChunkTimestamp(`"timestamp":"${a}" ... "timestamp": "${b}"`), b);
});

test('latestMessageTimestamp ignores the header stamp itself', () => {
 const header = '2026-01-01T00:00:00.000Z';
 const chunk = `{"type":"session","timestamp":"${header}"} tail`;
 assert.equal(latestMessageTimestamp(chunk, header), undefined);
 const later = '2026-02-01T00:00:00.000Z';
 assert.equal(latestMessageTimestamp(`${chunk} "timestamp":"${later}"`, header), later);
 assert.equal(latestMessageTimestamp(`${chunk} "timestamp":"${header}"`, header), undefined);
});

test('isWithinWindow honors 1..90 clamp and future rejection', () => {
 const now = Date.now();
 assert.equal(isWithinWindow(new Date(now - 2 * DAY).toISOString(), now, 14), true);
 assert.equal(isWithinWindow(new Date(now - 30 * DAY).toISOString(), now, 14), false);
 assert.equal(isWithinWindow(new Date(now + 1000).toISOString(), now, 14), false);
 assert.equal(isWithinWindow('bogus', now, 14), false);
});

test('underPrefixes matches exact and nested paths only', () => {
 assert.equal(underPrefixes('/a/git/proj', ['/a/git']), true);
 assert.equal(underPrefixes('/a/git', ['/a/git']), true);
 assert.equal(underPrefixes('/a/git-evil', ['/a/git']), false);
 assert.equal(underPrefixes('/other', ['/a/git']), false);
});

test('recent vs stale cutoff uses message activity', () => {
 const files = {
  '/sessions/recent.jsonl': sessionFile({ id: 'r1', cwd: '/g/alpha', at: nowIso(-3 * DAY), messages: [nowIso(-2 * DAY)] }),
  '/sessions/stale.jsonl': sessionFile({ id: 's1', cwd: '/g/beta', at: nowIso(-40 * DAY), messages: [nowIso(-30 * DAY)] }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha'), '/g/beta': ident('/g/beta') } });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].cwd, '/g/alpha');
 assert.equal(r.projects[0].lastActivitySource, 'messages');
 assert.equal(r.skippedStale, 1);
 assert.equal(r.partial, false);
});

test('header-only session falls back to header timestamp', () => {
 const files = {
  '/sessions/h.jsonl': sessionFile({ id: 'h1', cwd: '/g/alpha', at: nowIso(-DAY) }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha') } });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].lastActivitySource, 'header');
});

test('active session marks project live without merging writers', () => {
 const files = {
  '/sessions/a.jsonl': sessionFile({ id: 'live-1', cwd: '/g/alpha', at: nowIso(-DAY), messages: [nowIso(-3600e3)] }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha') } });
 const r = discoverRecentProjects(baseConfig('/g', { activeSessionIds: ['live-1'] }), io);
 assert.deepEqual(r.projects[0].activeSessionIds, ['live-1']);
 assert.match(r.projects[0].note, /active writer/);
});

test('forked sessions merge, resumed session id dedups', () => {
 const files = {
  '/sessions/f1.jsonl': sessionFile({ id: 'f1', cwd: '/g/alpha', at: nowIso(-2 * DAY), messages: [nowIso(-2 * DAY)] }),
  '/sessions/f2.jsonl': sessionFile({ id: 'f2', cwd: '/g/alpha', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
  '/sessions/f1b.jsonl': sessionFile({ id: 'f1', cwd: '/g/alpha', at: nowIso(-DAY), messages: [nowIso(-12 * 3600e3)] }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha') } });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].sessionCount, 2);
 assert.deepEqual(r.projects[0].sessionIds, ['f1', 'f2']);
});

test('truncated tail still yields surviving timestamps', () => {
 const full = sessionFile({ id: 't1', cwd: '/g/alpha', at: nowIso(-2 * DAY), messages: [nowIso(-DAY)] });
 const files = { '/sessions/t.jsonl': full.slice(0, Math.floor(full.length * 0.7)) };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha') } });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
});

test('garbage and headerless files count as ephemeral', () => {
 const files = { '/sessions/junk.jsonl': 'not json at all\n{"type":"message"}\n' };
 const r = discoverRecentProjects(baseConfig('/g'), fakeFS({ files }));
 assert.equal(r.projects.length, 0);
 assert.equal(r.skippedEphemeral, 1);
});

test('symlink escape outside roots is rejected', () => {
 const files = {
  '/sessions/esc.jsonl': sessionFile({ id: 'e1', cwd: '/g/link', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
 };
 const io = fakeFS({ files, realpaths: { '/g/link': '/etc/secret' }, identities: {} });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 0);
 assert.equal(r.skippedOutsideRoots, 1);
});

test('nested cwd and alias merge into one project', () => {
 const files = {
  '/sessions/n1.jsonl': sessionFile({ id: 'n1', cwd: '/g/alpha/sub/dir', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
  '/sessions/n2.jsonl': sessionFile({ id: 'n2', cwd: '/g/alpha', at: nowIso(-2 * DAY), messages: [nowIso(-2 * DAY)] }),
 };
 const io = fakeFS({
  files,
  realpaths: { '/g/alpha/sub/dir': '/g/alpha/sub/dir', '/g/alpha': '/g/alpha' },
  identities: { '/g/alpha/sub/dir': ident('/g/alpha'), '/g/alpha': ident('/g/alpha') },
 });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].cwd, '/g/alpha');
 assert.equal(r.projects[0].sessionCount, 2);
 assert.equal(r.projects[0].observedCwds.length, 2);
});

test('deleted project is reported missing, not dropped', () => {
 const files = {
  '/sessions/gone.jsonl': sessionFile({ id: 'g1', cwd: '/g/vanished', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
 };
 const io = fakeFS({ files, realpaths: { '/g/vanished': undefined }, identities: {} });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].isMissing, true);
 assert.match(r.projects[0].note, /missing/);
});

test('excluded wins over pinned', () => {
 const files = {
  '/sessions/x.jsonl': sessionFile({ id: 'x1', cwd: '/g/secret', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
 };
 const io = fakeFS({ files, identities: { '/g/secret': ident('/g/secret') } });
 const r = discoverRecentProjects(baseConfig('/g', { pinned: ['/g/secret'], excluded: ['/g/secret'] }), io);
 assert.equal(r.projects.length, 0);
 assert.equal(r.skippedExcluded, 1);
});

test('pinned session outside roots is included', () => {
 const files = {
  '/sessions/p.jsonl': sessionFile({ id: 'p1', cwd: '/tmp/side', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
 };
 const io = fakeFS({ files, identities: { '/tmp/side': ident('/tmp/side') } });
 const outside = discoverRecentProjects(baseConfig('/g'), io);
 assert.equal(outside.projects.length, 0);
 const pinned = discoverRecentProjects(baseConfig('/g', { pinned: ['/tmp/side'] }), io);
 assert.equal(pinned.projects.length, 1);
 assert.equal(pinned.projects[0].pinned, true);
});

test('budgets stop early with cursor and partial flag', () => {
 const files = {
  '/sessions/a.jsonl': sessionFile({ id: 'a', cwd: '/g/alpha', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
  '/sessions/b.jsonl': sessionFile({ id: 'b', cwd: '/g/beta', at: nowIso(-DAY), messages: [nowIso(-DAY)] }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha'), '/g/beta': ident('/g/beta') } });
 const r = discoverRecentProjects(baseConfig('/g', { budgets: { maxSessionFiles: 1 } }), io);
 assert.equal(r.partial, true);
 assert.equal(r.stoppedBy, 'max-session-files');
 assert.equal(r.cursor, '/sessions/a.jsonl');
 assert.equal(r.projects.length, 1);
});

test('describeProject explains recency, source, and identity', () => {
 const files = {
  '/sessions/d.jsonl': sessionFile({ id: 'd1', cwd: '/g/alpha', at: nowIso(-DAY), messages: [nowIso(-DAY + 60_000)] }),
 };
 const io = fakeFS({ files, identities: { '/g/alpha': ident('/g/alpha', { ref: 'main', head: 'abc123' }) } });
 const r = discoverRecentProjects(baseConfig('/g'), io);
 const line = describeProject(r.projects[0]);
 assert.match(line, /\/g\/alpha/);
 assert.match(line, /main @ abc123/);
 assert.match(line, /via messages/);
 assert.match(line, /1 session/);
});

// Real git in tmp only: worktree distinctness + detached HEAD.
function git(cwd, ...args) {
 execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

function initRepo(dir) {
 fs.mkdirSync(dir, { recursive: true });
 execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
 fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
 git(dir, 'add', '.');
 git(dir, 'commit', '-m', 'init');
 return fs.realpathSync(dir);
}

test('real worktrees stay distinct with shared common dir', (t) => {
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-disc-wt-'));
 t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
 const repo = initRepo(path.join(tmp, 'repo'));
 const wt = path.join(tmp, 'wt');
 execFileSync('git', ['worktree', 'add', wt], { cwd: repo, stdio: 'ignore' });
 const wtReal = fs.realpathSync(wt);
 const sessDir = path.join(tmp, 'sessions');
 fs.mkdirSync(sessDir);
 fs.writeFileSync(path.join(sessDir, 'a.jsonl'), sessionFile({ id: 'w1', cwd: repo, at: nowIso(-DAY), messages: [nowIso(-DAY)] }));
 fs.writeFileSync(path.join(sessDir, 'b.jsonl'), sessionFile({ id: 'w2', cwd: wtReal, at: nowIso(-DAY), messages: [nowIso(-DAY)] }));
 const cfg = defaultDiscoveryConfig({ sessionRoots: [sessDir], projectRoots: [tmp], recentDays: 14 });
 const r = discoverRecentProjects(cfg, nodeDiscoveryFS());
 assert.equal(r.partial, false);
 assert.equal(r.projects.length, 2);
 assert.equal(r.projects[0].commonGitDir, r.projects[1].commonGitDir);
 const roots = r.projects.map((p) => p.worktreeRoot).sort();
 assert.deepEqual(roots, [repo, wtReal].sort());
 const main = r.projects.find((p) => p.cwd === repo);
 assert.equal(main.isWorktree, false);
 const linked = r.projects.find((p) => p.cwd === wtReal);
 assert.equal(linked.isWorktree, true);
});

test('real detached HEAD is flagged, not merged away', (t) => {
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-disc-det-'));
 t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
 const repo = initRepo(path.join(tmp, 'repo'));
 execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: repo, stdio: 'ignore' });
 const sessDir = path.join(tmp, 'sessions');
 fs.mkdirSync(sessDir);
 fs.writeFileSync(path.join(sessDir, 'd.jsonl'), sessionFile({ id: 'd1', cwd: repo, at: nowIso(-DAY), messages: [nowIso(-DAY)] }));
 const cfg = defaultDiscoveryConfig({ sessionRoots: [sessDir], projectRoots: [tmp], recentDays: 14 });
 const r = discoverRecentProjects(cfg, nodeDiscoveryFS());
 assert.equal(r.projects.length, 1);
 assert.equal(r.projects[0].isDetached, true);
 assert.equal(r.projects[0].ref, '');
 assert.match(r.projects[0].note, /detached/);
});
