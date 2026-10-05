// Catch-Me-Up sources: every read through injected deps; failures are gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CATCHUP_MARKER_PREFIX, catchUpCursorLine, loadFreshCatchUp, loadLatestCatchUp, nodeCatchUpFs, parseCatchUpCursor, runCatchUp,
} from '../../dist/src/tracking/catchup-sources.mjs';
import { fetchCommentsSince, fetchIssuesSince, SINCE_MAX_PAGES } from '../../dist/src/tracking/gitea.mjs';
import { fetchCommentsSinceGitHub, fetchIssuesSinceGitHub, GITHUB_API_VERSION } from '../../dist/src/tracking/github.mjs';
import { trackingPorts } from '../../dist/src/tracking/ports.mjs';
import { parseInboxBlocks } from '../../dist/src/sync/inbox.mjs';
import { fakeFetch, hostile } from '../tracking-navigation/fixtures.mjs';

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const H = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const SINCE = '2026-09-05T12:00:00.000Z';
const GITEA = { host: 'https://gitea.example.test', owner: 'owner', repo: 'promptr', provider: 'gitea' };
const GITHUB = { host: 'https://github.com', owner: 'owner', repo: 'promptr', provider: 'github' };
const TOKEN = 'sekrit-token-value';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-catchup-'));
  return dir;
}

function write(file, text, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

function pathsFor(root, cwd) {
  const dir = path.join(root, 'state', 'projects', 'promptr-abc');
  return {
    root: path.join(root, 'state'), dir, slug: 'promptr-abc', cwd,
    scratch: path.join(dir, 'scratch.md'), queue: path.join(dir, 'queue.json'), composer: path.join(dir, 'composer.md'),
    progress: path.join(dir, 'progress.json'), autocheck: path.join(dir, 'autocheck.json'), log: path.join(dir, 'promptr.md'),
    handoffsDir: path.join(dir, 'handoffs'), tracking: path.join(dir, 'tracking.json'),
    catchupDir: path.join(dir, 'catchup'), catchup: path.join(dir, 'catchup.json'),
  };
}

/** Fake `git`: answers keyed by cwd; unknown cwd rejects like a non-repo. */
function fakeExec(repos) {
  const calls = [];
  return Object.assign(async (args, cwd) => {
    calls.push({ args, cwd });
    const repo = repos[cwd];
    if (!repo) throw new Error(`fatal: not a git repository: ${cwd}`);
    const key = args[0] === 'rev-parse' ? (args.includes('--abbrev-ref') ? 'branch' : 'head')
      : args[0] === 'status' ? 'status' : args[0] === 'log' ? (args.includes('-1') ? 'last' : 'log')
      : args[0] === 'rev-list' ? 'ab' : args[0] === 'worktree' ? 'worktrees' : args[0];
    const value = repo[key];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`no fixture for git ${args.join(' ')}`);
    return value;
  }, { calls });
}

function fixture({ tracker, openKnowledge, brief, exec, home, cwd } = {}) {
  const root = tmp();
  const projectCwd = cwd ?? path.join(root, 'project');
  fs.mkdirSync(projectCwd, { recursive: true });
  const homeDir = home ?? path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const paths = pathsFor(root, projectCwd);
  const deps = {
    exec: exec ?? fakeExec({ [projectCwd]: { head: 'abcdef123456\n', branch: 'main\n', status: '', log: '', ab: '0\t0\n', worktrees: `worktree ${projectCwd}\nHEAD abc\nbranch refs/heads/main\n\n`, last: '' } }),
    fs: nodeCatchUpFs(), now: () => NOW, env: {}, homedir: () => homeDir,
    ...(tracker ? { tracker } : {}), ...(openKnowledge ? { openKnowledge } : {}), ...(brief ? { brief } : {}),
  };
  return { root, cwd: projectCwd, paths, deps, home: homeDir };
}

function fakeTracker(repo, { issues, comments } = {}) {
  const calls = [];
  return {
    repo,
    ports: {
      fetchIssuesSince: async (r, since) => { calls.push(['issues', since]); if (issues instanceof Error) throw issues; return issues ?? { items: [], truncated: false }; },
      fetchCommentsSince: async (r, since) => { calls.push(['comments', since]); if (comments instanceof Error) throw comments; return comments ?? { items: [], truncated: false }; },
    },
    calls,
  };
}

// ---- offline and complete ----

test('tracker offline → a gaps entry naming the provider and a complete digest on disk', async () => {
  const tracker = fakeTracker(GITEA, { issues: new Error(`Gitea 401 for /api ${TOKEN}`), comments: new Error('timeout') });
  const { paths, cwd, deps } = fixture({ tracker });
  const result = await runCatchUp({ cwd, paths, deps });
  assert.equal(result.digest.tracker.reachable, false);
  assert.equal(result.digest.tracker.repoLabel, 'gitea owner/promptr');
  assert.ok(result.digest.gaps.some((g) => /tracker \(gitea\) issues: unreachable/.test(g)), JSON.stringify(result.digest.gaps));
  assert.ok(result.digest.gaps.some((g) => /tracker \(gitea\) comments: unreachable/.test(g)));
  assert.equal(result.digest.repo.head, 'abcdef123456');
  assert.equal(result.digest.window.reason, 'default');
  assert.match(result.markdown, /^# Catch-Me-Up — promptr-abc — 2026-09-08T12:00:00\.000Z/);
  assert.ok(fs.existsSync(result.file));
  assert.ok(fs.existsSync(result.file.replace(/\.md$/, '.json')));
  const cursor = parseCatchUpCursor(fs.readFileSync(paths.catchup, 'utf8'));
  assert.equal(cursor.lastFile, result.file);
  assert.equal(cursor.lastRunAt, iso(NOW));
  assert.match(cursor.summary, /^catch-up just now · 0 issues · 0 worktrees · 0 handoffs$/);
  assert.match(fs.readFileSync(paths.log, 'utf8'), /## Catch-Me-Up 20260908T120000Z\ncatch-up just now/);
  assert.equal(result.openKnowledge, 'skipped: OpenKnowledge offline');
  assert.ok(result.digest.gaps.some((g) => /OpenKnowledge offline/.test(g)));
  assert.ok(!fs.readdirSync(paths.catchupDir).some((n) => n.endsWith('.tmp')), 'no temp files left behind');
});

test('the second run uses the cursor as its window; explicit --since wins', async () => {
  const tracker = fakeTracker(GITEA);
  const { paths, cwd, deps } = fixture({ tracker });
  await runCatchUp({ cwd, paths, deps });
  deps.now = () => NOW + 3 * H;
  const second = await runCatchUp({ cwd, paths, deps });
  assert.equal(second.digest.window.reason, 'cursor');
  assert.equal(second.digest.window.since, iso(NOW));
  assert.equal(tracker.calls.at(-1)[1], iso(NOW));
  const third = await runCatchUp({ cwd, paths, deps, explicitSince: '7d' });
  assert.equal(third.digest.window.reason, 'explicit');
  assert.equal(third.digest.window.since, iso(NOW + 3 * H - 7 * 24 * H));
  const loaded = loadLatestCatchUp(paths, (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } });
  assert.equal(loaded.file, third.file);
  assert.equal(loaded.digest.window.reason, 'explicit');
});

test('tracker issues are diffed against the cached snapshot; comments flag issues', async () => {
  const tracker = fakeTracker(GITEA, {
    issues: { items: [
      { number: 7, title: `seven ${hostile('t')}`, state: 'closed', milestone: 'No milestone', labels: ['bug'], url: 'https://x/7', updatedAt: '2026-09-08T01:00:00Z' },
      { number: 9, title: 'nine', state: 'open', milestone: 'No milestone', labels: [], url: 'https://x/9', updatedAt: '2026-09-08T02:00:00Z' },
    ], truncated: true },
    comments: { items: [{ issue: 9, author: 'owner', createdAt: '2026-09-08T01:30:00Z', excerpt: `done in worktree ${hostile('c')}` }], truncated: false },
  });
  const { paths, cwd, deps } = fixture({ tracker });
  write(paths.tracking, JSON.stringify({
    version: 1, fetchedAt: '2026-09-07T00:00:00Z', repo: GITEA, overall: { open: 1, closed: 0, total: 1, progress: 0 },
    groups: [{ name: 'No milestone', open: 1, closed: 0, total: 1, progress: 0, openIssues: [{ number: 7, title: 'seven', state: 'open', milestone: 'No milestone', labels: ['bug'], url: 'https://x/7' }] }],
  }));
  const { digest, markdown } = await runCatchUp({ cwd, paths, deps });
  assert.equal(digest.tracker.reachable, true);
  const by = Object.fromEntries(digest.tracker.issues.map((i) => [i.number, i]));
  assert.deepEqual(by[7].changed, ['closed']);
  assert.deepEqual(by[9].changed, ['opened', 'comments']);
  assert.ok(!by[7].title.includes('\x1b'));
  assert.equal(digest.tracker.comments.length, 1);
  assert.equal(digest.tracker.truncated, true);
  assert.ok(digest.gaps.some((g) => /3-page bound/.test(g)));
  assert.ok(!markdown.includes('\x1b') && !markdown.includes('‮'));
  assert.match(markdown, /comment on #9 by owner/);
});

// ---- provider tables (real adapters, fake fetch) ----

const giteaIssue = (n, extra = {}) => ({ number: n, title: `Issue ${n}`, state: 'open', labels: [{ name: 'bug' }], html_url: `https://gitea.example.test/owner/promptr/issues/${n}`, updated_at: '2026-09-08T01:00:00Z', ...extra });
const comment = (n, body = 'a comment') => ({ id: n, body, created_at: '2026-09-08T01:00:00Z', user: { login: 'someone' }, issue_url: `https://api.example/repos/owner/promptr/issues/${n}`, html_url: `https://x/owner/promptr/issues/${n}#issuecomment-1` });
const fullPage = (make, from = 1) => Array.from({ length: 50 }, (_, i) => make(from + i));

const PROVIDERS = [
  {
    name: 'gitea', repo: GITEA, issues: fetchIssuesSince, comments: fetchCommentsSince,
    issueUrl: (p) => `https://gitea.example.test/api/v1/repos/owner/promptr/issues?state=all&type=issues&since=${encodeURIComponent(SINCE)}&sort=updated&limit=50&page=${p}`,
    commentUrl: (p) => `https://gitea.example.test/api/v1/repos/owner/promptr/issues/comments?since=${encodeURIComponent(SINCE)}&limit=50&page=${p}`,
    auth: `token ${TOKEN}`, extraHeaders: { Accept: 'application/json' }, env: { PROMPTR_TRACKER: 'gitea', GITEA_HOST: GITEA.host, GITEA_OWNER: 'owner', GITEA_REPO: 'promptr', GITEA_TOKEN: TOKEN },
  },
  {
    name: 'github', repo: GITHUB, issues: fetchIssuesSinceGitHub, comments: fetchCommentsSinceGitHub,
    issueUrl: (p) => `https://api.github.com/repos/owner/promptr/issues?state=all&since=${encodeURIComponent(SINCE)}&sort=updated&direction=desc&per_page=50&page=${p}`,
    commentUrl: (p) => `https://api.github.com/repos/owner/promptr/issues/comments?since=${encodeURIComponent(SINCE)}&sort=updated&direction=desc&per_page=50&page=${p}`,
    auth: `Bearer ${TOKEN}`, extraHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION },
    env: { PROMPTR_TRACKER: 'github', GITHUB_OWNER: 'owner', GITHUB_REPO: 'promptr', GITHUB_TOKEN: TOKEN },
  },
];

for (const p of PROVIDERS) {
  test(`${p.name}: since URLs, headers, PR filtering, issue_url parsing, output free of the token`, async () => {
    const fetchFn = fakeFetch({
      '/issues/comments': [comment(3), comment(4, `body ${hostile('b')}`), { id: 9, body: 'no issue url', created_at: 'x', user: { login: 'u' } }],
      '/issues?': [giteaIssue(1), giteaIssue(2, { pull_request: { url: 'pr' } })],
    });
    const issues = await p.issues({ repo: p.repo, since: SINCE, token: TOKEN, fetchFn });
    const comments = await p.comments({ repo: p.repo, since: SINCE, token: TOKEN, fetchFn });
    assert.equal(fetchFn.calls[0].url, p.issueUrl(1));
    assert.equal(fetchFn.calls[1].url, p.commentUrl(1));
    for (const call of fetchFn.calls) {
      assert.equal(call.headers.Authorization, p.auth);
      for (const [k, v] of Object.entries(p.extraHeaders)) assert.equal(call.headers[k], v);
    }
    assert.deepEqual(issues.items.map((i) => i.number), [1], 'pull requests dropped');
    assert.equal(issues.truncated, false);
    assert.deepEqual(issues.items[0].labels, ['bug']);
    assert.deepEqual(comments.items.map((c) => c.issue), [3, 4], 'issue number from issue_url tail; no url = dropped');
    assert.equal(comments.items[0].author, 'someone');
    assert.ok(!comments.items[1].excerpt.includes('\x1b'));
    const output = JSON.stringify({ issues, comments });
    assert.ok(!output.includes(TOKEN), 'token never in output');
  });

  test(`${p.name}: pagination stops at ${SINCE_MAX_PAGES} pages and reports truncation`, async () => {
    const fetchFn = fakeFetch({
      '/issues/comments': (url) => fullPage((n) => comment(n), 1),
      '/issues?': (url) => fullPage((n) => giteaIssue(n), Number(/page=(\d+)/.exec(url)[1]) * 100),
    });
    const issues = await p.issues({ repo: p.repo, since: SINCE, fetchFn });
    assert.equal(issues.items.length, 150);
    assert.equal(issues.truncated, true);
    const issueCalls = fetchFn.calls.filter((c) => c.url.includes('/issues?'));
    assert.equal(issueCalls.length, SINCE_MAX_PAGES);
    assert.equal(issueCalls[2].url, p.issueUrl(3));
    assert.equal(issueCalls[0].headers.Authorization, undefined, 'no token → no Authorization header');
    const comments = await p.comments({ repo: p.repo, since: SINCE, fetchFn });
    assert.equal(comments.items.length, 150);
    assert.equal(comments.truncated, true);
  });

  test(`${p.name}: 401/403/timeout become a gaps entry naming the provider, never an exception`, async () => {
    for (const failure of [{ __status: 401 }, { __status: 403 }, { __error: 'The operation was aborted' }]) {
      const fetchFn = fakeFetch({ '/issues': failure });
      const ports = trackingPorts({ ...p.env }, { timeoutMs: 100 });
      const { paths, cwd, deps } = fixture({ tracker: { repo: p.repo, ports } });
      deps.tracker.ports = { fetchIssuesSince: (r, s) => p.issues({ repo: r, since: s, token: TOKEN, fetchFn }), fetchCommentsSince: (r, s) => p.comments({ repo: r, since: s, token: TOKEN, fetchFn }) };
      const result = await runCatchUp({ cwd, paths, deps });
      assert.equal(result.digest.tracker.reachable, false);
      assert.equal(result.digest.tracker.repoLabel, `${p.name} owner/promptr`);
      assert.ok(result.digest.gaps.some((g) => g.startsWith(`tracker (${p.name}) issues: unreachable`)), JSON.stringify(result.digest.gaps));
      assert.ok(!JSON.stringify(result.digest).includes(TOKEN) && !result.markdown.includes(TOKEN));
    }
  });
}

test('trackingPorts dispatches the since-reads by repo.provider with the right token header', async () => {
  const fetchFn = fakeFetch({ '/issues': [] });
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const ports = trackingPorts({ GITEA_TOKEN: 'g-token', GITHUB_TOKEN: 'h-token' });
    await ports.fetchIssuesSince(GITEA, SINCE);
    await ports.fetchCommentsSince(GITHUB, SINCE);
    assert.equal(fetchFn.calls[0].headers.Authorization, 'token g-token');
    assert.match(fetchFn.calls[0].url, /gitea\.example\.test\/api\/v1/);
    assert.equal(fetchFn.calls[1].headers.Authorization, 'Bearer h-token');
    assert.match(fetchFn.calls[1].url, /api\.github\.com\/repos\/owner\/promptr\/issues\/comments/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---- repository, worktrees, wave files ----

test('repository: commits, uncommitted paths and ahead/behind from git; a failing git is a gap', async () => {
  const { paths, cwd, deps } = fixture();
  deps.exec = fakeExec({ [cwd]: {
    head: 'abcdef123456\n', branch: 'wave/catchup\n', status: ' M src/a.mts\n?? new.txt\n', ab: '2\t1\n', worktrees: '',
    log: `aaaaaaaaaaaa\t2026-09-07T10:00:00+00:00\tOlder commit\nbbbbbbbbbbbb\t2026-09-08T10:00:00+00:00\tNewer ${hostile('s')}\n`, last: '',
  } });
  const { digest } = await runCatchUp({ cwd, paths, deps });
  assert.equal(digest.repo.ref, 'wave/catchup');
  assert.equal(digest.repo.dirty, true);
  assert.deepEqual(digest.repo.uncommitted, ['src/a.mts', 'new.txt']);
  assert.equal(digest.repo.aheadBehind, 'ahead 2 · behind 1');
  assert.deepEqual(digest.repo.commits.map((c) => c.hash), ['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
  assert.ok(!digest.repo.commits[0].subject.includes('\x1b'));
  const logCall = deps.exec.calls.find((c) => c.args[0] === 'log' && !c.args.includes('-1'));
  assert.equal(logCall.args[1], `--since=${digest.window.since}`);
  const broken = fixture({ exec: fakeExec({}) });
  const result = await runCatchUp({ cwd: broken.cwd, paths: broken.paths, deps: broken.deps });
  assert.ok(result.digest.gaps.some((g) => /repository: git unavailable/.test(g)));
  assert.equal(result.digest.repo.head, 'unknown');
});

test('worktrees: git worktree list plus handoff lanes; task-result marker and dirtiness decide inclusion', async () => {
  const { paths, cwd, deps, home } = fixture();
  const lanes = path.join(home, '.local', 'share', 'promptr-handoffs');
  const done = path.join(lanes, 'round3-wave1', 'catchup');
  const dirty = path.join(lanes, 'round3-wave1', 'handoffr');
  const stale = path.join(lanes, 'round1', 'old');
  const backup = path.join(lanes, 'install-backups', 'x');
  const notGit = path.join(lanes, 'round3-wave1', 'notes');
  for (const d of [done, dirty, stale, backup]) write(path.join(d, '.git'), 'gitdir: elsewhere');
  fs.mkdirSync(notGit, { recursive: true });
  write(path.join(done, '.promptr', 'task-result.md'), `# Task result\nStatus: complete\n\nMarker: SUBAGENT_COMPLETE\n`, NOW - H);
  write(path.join(dirty, '.promptr', 'task-result.md'), `Status: in progress ${hostile('r')}\n`, NOW - 2 * H);
  fs.utimesSync(stale, new Date(NOW - 30 * 24 * H), new Date(NOW - 30 * 24 * H));
  const extra = path.join(cwd, '..', 'extra-worktree');
  fs.mkdirSync(extra, { recursive: true });
  const old = '2026-01-01T00:00:00+00:00';
  const recent = '2026-09-08T09:00:00+00:00';
  deps.exec = fakeExec({
    [cwd]: { head: 'aaaaaaaaaaaa\n', branch: 'main\n', status: '', log: '', ab: new Error('no upstream'), worktrees: `worktree ${cwd}\nHEAD a\nbranch refs/heads/main\n\nworktree ${path.resolve(extra)}\nHEAD b\nbranch refs/heads/feature\n\n`, last: `aaaaaaaaaaaa\t${old}\tinit\n` },
    [path.resolve(extra)]: { head: 'bbbbbbbbbbbb\n', branch: 'feature\n', status: '', last: `bbbbbbbbbbbb\t${recent}\tfeature work\n` },
    [done]: { head: 'cccccccccccc\n', branch: 'wave/catchup\n', status: '', last: `cccccccccccc\t${old}\tstart lane\n` },
    [dirty]: { head: 'dddddddddddd\n', branch: 'wave/handoffr\n', status: ' M x\n', last: `dddddddddddd\t${old}\tstart lane\n` },
    [stale]: { head: 'eeeeeeeeeeee\n', branch: 'old\n', status: '', last: `eeeeeeeeeeee\t${old}\told\n` },
    [backup]: { head: 'ffffffffffff\n', branch: 'b\n', status: '', last: '' },
  });
  const { digest, markdown } = await runCatchUp({ cwd, paths, deps });
  const byPath = Object.fromEntries(digest.worktrees.map((t) => [t.path, t]));
  assert.ok(byPath[done], 'lane with a fresh task-result is included');
  assert.equal(byPath[done].lane, 'catchup');
  assert.equal(byPath[done].wave, 'round3-wave1');
  assert.equal(byPath[done].taskResult.complete, true);
  assert.equal(byPath[done].taskResult.firstLine, '# Task result');
  assert.ok(byPath[dirty], 'dirty lane is included');
  assert.equal(byPath[dirty].dirty, true);
  assert.equal(byPath[dirty].taskResult.complete, false);
  assert.ok(!byPath[dirty].taskResult.firstLine.includes('\x1b'));
  assert.ok(byPath[path.resolve(extra)], 'git worktree with a recent commit is included');
  assert.equal(byPath[path.resolve(extra)].lastCommit.subject, 'feature work');
  assert.equal(byPath[stale], undefined, 'old clean lane without task-result is skipped');
  assert.equal(byPath[backup], undefined, 'install-backups skipped');
  assert.ok(!deps.exec.calls.some((c) => c.cwd === notGit), 'a directory without .git is never queried');
  assert.equal(digest.repo.aheadBehind, undefined, 'ahead/behind is best effort');
  assert.match(markdown, /task-result COMPLETE/);
  assert.match(markdown, /\(round3-wave1\/catchup\)/);
});

test('wave files under .promptr/<wave>/ by mtime, bounded to 50 with a gap', async () => {
  const { paths, cwd, deps } = fixture();
  write(path.join(cwd, '.promptr', 'round3', 'contract.md'), `\n# Contract ${hostile('w')}\n`, NOW - H);
  write(path.join(cwd, '.promptr', 'round3', 'packets', 'catchup.md'), 'Task: x\n', NOW - 2 * H);
  write(path.join(cwd, '.promptr', 'round1', 'old.md'), 'old\n', NOW - 30 * 24 * H);
  write(path.join(cwd, '.promptr', 'coordinator-handoff.md'), 'top-level file, not a wave file\n', NOW - H);
  for (let i = 0; i < 55; i++) write(path.join(cwd, '.promptr', 'bulk', `f${i}.md`), `bulk ${i}\n`, NOW - 3 * H - i * 1000);
  const { digest } = await runCatchUp({ cwd, paths, deps });
  assert.equal(digest.waves.length, 50);
  assert.equal(digest.waves[0].path, path.join('round3', 'contract.md'));
  assert.match(digest.waves[0].firstLine, /^# Contract /);
  assert.ok(!digest.waves[0].firstLine.includes('\x1b'));
  assert.equal(digest.waves[1].path, path.join('round3', 'packets', 'catchup.md'));
  assert.ok(!digest.waves.some((f) => f.path.includes('old.md')));
  assert.ok(digest.gaps.some((g) => /wave files: 7 more/.test(g)));
});

// ---- handoffs, briefs, checkpoints ----

test('local handoffs with receipts, continuation head and coordinator handoff', async () => {
  const { paths, cwd, deps } = fixture();
  write(path.join(paths.handoffsDir, 'h1.md'), `# Handoff one ${hostile('h')}\n\n## How to continue\n\n1. Reopen the lane\n2. Then run tests\n`, NOW - H);
  write(path.join(paths.handoffsDir, 'h1.json'), JSON.stringify({ state: 'launched' }));
  write(path.join(paths.handoffsDir, 'h0.md'), '# Old handoff\n', NOW - 20 * 24 * H);
  write(path.join(paths.handoffsDir, 'h2.md'), '# Handoff two\n', NOW - 2 * H);
  write(path.join(paths.handoffsDir, 'h2.json'), '{broken');
  write(path.join(cwd, 'docs', 'continuation.md'), `# Continuation\n\n## Current snapshot\n\n- main at e70a004\n- catch-up lane running\n\n## Older\n- ignored\n`);
  write(path.join(cwd, '.promptr', 'coordinator-handoff.md'), 'Coordinator handoff line 1\nline 2\n', NOW - H);
  const { digest } = await runCatchUp({ cwd, paths, deps });
  assert.deepEqual(digest.handoffs.local.map((h) => h.name), ['h1', 'h2']);
  assert.equal(digest.handoffs.local[0].receiptState, 'launched');
  assert.equal(digest.handoffs.local[0].firstStep, '1. Reopen the lane');
  assert.match(digest.handoffs.local[0].title, /^# Handoff one /);
  assert.ok(!digest.handoffs.local[0].title.includes('\x1b'));
  assert.equal(digest.handoffs.local[1].receiptState, undefined);
  assert.ok(digest.handoffs.continuationHead.includes('- main at e70a004'));
  assert.ok(digest.handoffs.continuationHead.some((l) => /coordinator-handoff\.md/.test(l)));
  assert.ok(digest.handoffs.continuationHead.includes('Coordinator handoff line 1'));
  assert.ok(digest.gaps.some((g) => /handoffs page: OpenKnowledge offline/.test(g)));
});

test('checkpoints in window and log headings by their stamps', async () => {
  const { paths, cwd, deps } = fixture();
  const entry = (id, at) => ({ id, at, text: `checkpoint ${id}\nmore`, cwd, head: 'abc', ref: 'main', dirty: false, changed: [] });
  write(paths.progress, JSON.stringify({ version: 1, entries: [entry('old1', iso(NOW - 10 * 24 * H)), entry('new1', iso(NOW - H)), entry('new2', iso(NOW - 30 * 60 * 1000))] }));
  write(paths.log, `# log\n\n## Checkpoint ${iso(NOW - 10 * 24 * H)} (old1)\n\n## Checkpoint ${iso(NOW - H)} (new1)\n\n## Handoff ${iso(NOW - 40 * 60 * 1000)}\n`);
  const { digest, markdown } = await runCatchUp({ cwd, paths, deps });
  assert.deepEqual(digest.checkpoints.progress.map((e) => e.id), ['new2', 'new1']);
  assert.equal(digest.checkpoints.logHeadings.length, 2);
  assert.match(digest.checkpoints.logHeadings[0], /^Handoff/);
  assert.match(markdown, /checkpoint new2/);
});

function fakeOpenKnowledge(pages, { writeError } = {}) {
  const reads = [];
  const writes = [];
  return {
    reads, writes,
    client: {
      readDocument: async (name) => { reads.push(name); const v = pages[name]; if (v instanceof Error) throw v; return v ?? null; },
      writeMarkdown: async (name, md, position, summary) => { if (writeError) throw writeError; writes.push({ name, md, position, summary }); },
    },
    pages: { brief: 'projects/promptr/brief', inbox: 'projects/promptr/inbox', workspace: 'projects/promptr/workspace', handoffs: 'projects/promptr/handoffs' },
  };
}

test('OpenKnowledge: brief head, inbox unqueued count, workspace head, handoff markers, append', async () => {
  const open = ['# Inbox', '', '## first thought', 'do the thing', '', '## second thought', 'still pending', '', '## third', 'also pending', ''].join('\n');
  const firstHash = parseInboxBlocks(open).blocks.find((b) => b.text.includes('do the thing')).hash;
  const inbox = `${open}\n<!-- promptr:queued ${firstHash} 2026-09-08T00:00:00Z -->\n`;
  const handoffs = [
    `<!-- promptr:handoff coord-1 ${iso(NOW - H)} example-provider/example-model:high -->`, '# Handoff', '',
    `<!-- promptr:handoff coord-0 ${iso(NOW - 20 * 24 * H)} x/y:z -->`, '',
    `## Automatic 200k wrap-up ${iso(NOW - 2 * H)}`, '',
  ].join('\n');
  const ok = fakeOpenKnowledge({
    'projects/promptr/brief': '# Brief\n\nremote brief line\n',
    'projects/promptr/inbox': inbox,
    'projects/promptr/workspace': `# Workspace ${hostile('k')}\nqueue: 2\n`,
    'projects/promptr/handoffs': handoffs,
  });
  const brief = { text: '# Local brief\n\nlocal line one\n', updated: iso(NOW - 3 * H), target: { origin: 'https://ok.example', docName: 'projects/promptr/brief' } };
  const { paths, cwd, deps } = fixture({ openKnowledge: ok, brief });
  const result = await runCatchUp({ cwd, paths, deps });
  const d = result.digest;
  assert.deepEqual(d.briefs.brief.head, ['# Local brief', 'local line one']);
  assert.equal(d.briefs.brief.updated, iso(NOW - 3 * H));
  assert.equal(d.briefs.inboxUnqueued, 2);
  assert.match(d.briefs.workspaceHead[0], /^# Workspace /);
  assert.ok(!d.briefs.workspaceHead[0].includes('\x1b'));
  assert.deepEqual(d.handoffs.remoteMarkers.map((m) => m.name), ['coord-1', 'automatic-wrap-up']);
  assert.equal(d.handoffs.remoteMarkers[0].runtime, 'example-provider/example-model:high');
  assert.ok(ok.reads.length <= 5, 'at most 5 page reads');
  assert.equal(result.openKnowledge, 'appended');
  assert.equal(ok.writes.length, 1);
  assert.equal(ok.writes[0].name, 'projects/promptr/handoffs');
  assert.equal(ok.writes[0].position, 'append');
  assert.match(ok.writes[0].md, new RegExp(`^\\n${CATCHUP_MARKER_PREFIX} 20260908T120000Z -->\\n# Catch-Me-Up`));
});

test('OpenKnowledge append failure → status pending; read failures → gaps; run still completes', async () => {
  const ok = fakeOpenKnowledge({ 'projects/promptr/inbox': new Error('OpenKnowledge read HTTP 500') }, { writeError: new Error('OpenKnowledge write HTTP 503') });
  const { paths, cwd, deps } = fixture({ openKnowledge: ok });
  const result = await runCatchUp({ cwd, paths, deps });
  assert.equal(result.openKnowledge, 'pending: OpenKnowledge write HTTP 503');
  assert.ok(result.digest.gaps.some((g) => /inbox page: unreadable/.test(g)));
  assert.ok(result.digest.gaps.some((g) => /handoffs page: not created/.test(g)));
  assert.ok(result.digest.gaps.some((g) => /brief: no local briefing text/.test(g)));
  assert.ok(fs.existsSync(result.file));
});

// ---- cursor helpers and freshness ----

test('catchUpCursorLine and loadFreshCatchUp honour the 24 h rule', async () => {
  const { paths, cwd, deps } = fixture({ tracker: fakeTracker(GITEA) });
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } };
  assert.equal(catchUpCursorLine(undefined, NOW), 'catch-up: never');
  assert.equal(loadFreshCatchUp(paths, read, NOW), undefined);
  await runCatchUp({ cwd, paths, deps });
  const cursor = parseCatchUpCursor(read(paths.catchup));
  assert.equal(catchUpCursorLine(cursor, NOW + 2 * H), 'catch-up: 2h ago · 0 issues · 0 worktrees · 0 handoffs');
  assert.ok(loadFreshCatchUp(paths, read, NOW + 24 * H));
  assert.equal(loadFreshCatchUp(paths, read, NOW + 24 * H + 1), undefined, 'older than 24 h is not attached');
  assert.equal(parseCatchUpCursor('{bad'), undefined);
  assert.equal(parseCatchUpCursor(JSON.stringify({ lastRunAt: 1 })), undefined);
});
