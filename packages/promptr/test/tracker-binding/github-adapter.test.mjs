// GitHub adapter, tracker configuration and provider dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_API_VERSION, fetchIssueDependenciesGitHub, fetchIssueDetailGitHub, fetchIssuePageGitHub, fetchTrackingGitHub,
  githubApiBase,
} from '../../dist/src/tracking/github.mjs';
import { resolveTracker, trackerLabel, trackerProviderOf } from '../../dist/src/tracking/config.mjs';
import { trackingPorts } from '../../dist/src/tracking/ports.mjs';
import { buildWorkBoard } from '../../dist/src/tracking/board.mjs';
import { issueKey, parseSnapshot, repoIdentity, repoProvider } from '../../dist/src/tracking/gitea.mjs';
import { fakeFetch, issue } from '../tracking-navigation/fixtures.mjs';

const GH = { host: 'https://github.com', owner: 'octo', repo: 'demo', provider: 'github' };
const NOW = () => '2026-09-08T12:00:00Z';

function ghIssue(number, overrides = {}) {
  return issue(number, {
    labels: [{ name: 'wayfinder:parent:7' }, { name: 'priority:P1' }],
    assignee: { login: 'octo' },
    html_url: `https://github.com/octo/demo/issues/${number}`,
    ...overrides,
  });
}

test('API base: api.github.com for github.com, <host>/api/v3 for an enterprise host, explicit origin wins', () => {
  assert.equal(githubApiBase(GH), 'https://api.github.com/repos/octo/demo');
  assert.equal(githubApiBase({ ...GH, host: 'https://ghe.example' }), 'https://ghe.example/api/v3/repos/octo/demo');
  assert.equal(githubApiBase(GH, 'https://proxy.example/gh/'), 'https://proxy.example/gh/repos/octo/demo');
});

test('fetchTrackingGitHub reads milestones and issues, drops pull requests, sends the API version and a Bearer token it never echoes', async () => {
  const fetchFn = fakeFetch({
    '/milestones': [{ title: 'M1', open_issues: 2, closed_issues: 3 }],
    '/issues?': [ghIssue(1), ghIssue(2, { pull_request: { url: 'x' } }), ghIssue(3, { state: 'closed' })],
  });
  const snap = await fetchTrackingGitHub({ repo: GH, token: 'ghp_secret', fetchFn, now: NOW });
  assert.deepEqual(snap.repo, GH);
  assert.deepEqual(snap.openIssues.map((i) => i.number), [1]);
  assert.equal(snap.openIssues[0].assignee, 'octo');
  assert.deepEqual(snap.openIssues[0].labels, ['wayfinder:parent:7', 'priority:P1']);
  assert.equal(snap.groups.find((g) => g.name === 'M1').closed, 3);
  for (const call of fetchFn.calls) {
    assert.equal(call.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
    assert.equal(call.headers.Authorization, 'Bearer ghp_secret');
  }
  assert.doesNotMatch(JSON.stringify(snap), /ghp_secret/);
  const board = buildWorkBoard(snap);
  assert.equal(board.provider, 'github');
  assert.equal(board.repoLabel, 'octo/demo');
  // Re-parsed from a cache the provider survives.
  assert.equal(parseSnapshot(JSON.parse(JSON.stringify(snap))).repo.provider, 'github');
});

test('blocked_by dependencies: complete on a short page, 404 reports unavailable (never clear), and the snapshot stops probing', async () => {
  const complete = fakeFetch({ '/dependencies/blocked_by': [{ number: 9, state: 'open', title: 'blocker', repository_url: 'https://api.github.com/repos/octo/demo' }] });
  const read = await fetchIssueDependenciesGitHub({ repo: GH, number: 1, fetchFn: complete });
  assert.deepEqual(read, { status: 'complete', items: [{ number: 9, title: 'blocker', state: 'open', repo: 'octo/demo' }], blockers: 1, reason: '' });

  const missing = fakeFetch({ '/dependencies/blocked_by': { __status: 404 } });
  const unavailable = await fetchIssueDependenciesGitHub({ repo: GH, number: 1, fetchFn: missing });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /GitHub 404 .* issue dependencies API unavailable/);

  const probing = fakeFetch({
    '/issues?': [ghIssue(1), ghIssue(2)],
    '/dependencies/blocked_by': { __status: 404 },
  });
  const snap = await fetchTrackingGitHub({ repo: GH, fetchFn: probing, withBlockers: true, now: NOW });
  assert.ok(snap.openIssues.every((i) => i.blockers === undefined), 'unknown stays unknown');
  assert.equal(probing.calls.filter((c) => c.url.includes('blocked_by')).length, 1, 'one 404 ends the per-issue probing');
});

test('fetchIssuePageGitHub and fetchIssueDetailGitHub keep provider identity and the bound repo URL', async () => {
  const fetchFn = fakeFetch({
    '/dependencies/blocked_by': [],
    '/issues/5': ghIssue(5, { body: 'do the thing' }),
    '/issues?': [ghIssue(5), ghIssue(6)],
  });
  const page = await fetchIssuePageGitHub({ repo: GH, page: 1, fetchFn, now: NOW });
  assert.equal(page.repo.provider, 'github');
  assert.deepEqual(page.items.map((i) => i.number), [5, 6]);
  const detail = await fetchIssueDetailGitHub({ repo: GH, number: 5, fetchFn, now: NOW });
  assert.equal(detail.key, issueKey(GH, 5));
  assert.equal(detail.url, 'https://github.com/octo/demo/issues/5', 'never the issue-supplied html_url');
  assert.equal(detail.repo.provider, 'github');
  assert.equal(detail.dependencies.status, 'complete');
  assert.equal(detail.body, 'do the thing');
});

test('resolveTracker: gitea by default, github only when asked, and misconfiguration is a visible reason', () => {
  assert.equal(trackerProviderOf({}), undefined);
  assert.equal(trackerProviderOf({ PROMPTR_TRACKER: 'GitHub' }), 'github');
  const gitea = resolveTracker({ GITEA_TOKEN: 't' });
  assert.equal(gitea.ok, true);
  assert.equal(gitea.config.provider, 'gitea');
  assert.equal(gitea.config.tokenPresent, true);
  assert.equal(gitea.config.repo.provider, 'gitea');
  assert.equal(trackerLabel(gitea.config.repo), 'gitea owner/promptr');

  const bad = resolveTracker({ PROMPTR_TRACKER: 'jira' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not gitea or github/);

  const unconfigured = resolveTracker({ PROMPTR_TRACKER: 'github' });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.provider, 'github');
  assert.match(unconfigured.reason, /GITHUB_OWNER and GITHUB_REPO/);

  const combined = resolveTracker({ PROMPTR_TRACKER: 'github', GITHUB_REPOSITORY: 'octo/demo', GITHUB_API: 'https://api.example/' });
  assert.equal(combined.ok, true);
  assert.deepEqual(combined.config.repo, GH);
  assert.equal(combined.config.tokenPresent, false);
  assert.equal(combined.config.apiOrigin, 'https://api.example/');

  const fromRemote = resolveTracker({ PROMPTR_TRACKER: 'github' }, 'git@github.com:octo/demo.git');
  assert.equal(fromRemote.ok, true);
  assert.deepEqual(fromRemote.config.repo, GH);
  const otherHost = resolveTracker({ PROMPTR_TRACKER: 'github' }, 'https://gitea.example/o/r.git');
  assert.equal(otherHost.ok, false, 'a remote on another host never fills a GitHub binding');
  assert.doesNotMatch(JSON.stringify(resolveTracker({ GITEA_TOKEN: 'secret-token' })), /secret-token/);
});

test('trackingPorts route by the binding provider, not by any URL', async () => {
  assert.equal(repoProvider({}), 'gitea');
  assert.equal(repoProvider({ provider: 'github' }), 'github');
  assert.deepEqual(repoIdentity({ host: 'https://github.com/', owner: 'o', repo: 'r', provider: 'github' }), { host: 'https://github.com', owner: 'o', repo: 'r', provider: 'github' });
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push({ url: String(url), auth: init?.headers?.Authorization });
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const ports = trackingPorts({ GITHUB_TOKEN: 'gh', GITEA_TOKEN: 'gt' }, { withBlockers: false });
    await ports.listPage(GH, 1);
    await ports.listPage({ host: 'https://gitea.example', owner: 'o', repo: 'r' }, 1);
    assert.match(urls[0].url, /^https:\/\/api\.github\.com\/repos\/octo\/demo\/issues/);
    assert.equal(urls[0].auth, 'Bearer gh');
    assert.match(urls[1].url, /^https:\/\/gitea\.example\/api\/v1\/repos\/o\/r\/issues/);
    assert.equal(urls[1].auth, 'token gt');
  } finally {
    globalThis.fetch = original;
  }
});
