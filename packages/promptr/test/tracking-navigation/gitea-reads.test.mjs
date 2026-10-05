// Structured Gitea reads for navigation: explicit pages past the
// ten-per-milestone display cap, strict detail validation, honest native
// dependency reads, and untrusted-text handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detailSignature, fetchIssueDependencies, fetchIssueDetail, fetchIssuePage,
  isRetired, isValidIssueNumber, isValidTrackingRepo, issueKey, issueUrl,
  parseIssueDetail, sanitizeBody, sanitizeLine,
} from '../../dist/src/tracking/gitea.mjs';
import { REPO, fakeFetch, hostile, issue } from './fixtures.mjs';

const NOW = () => '2026-09-07T12:00:00Z';

test('a page read returns 25 rows, far past the ten-per-milestone display cap', async () => {
  const first = Array.from({ length: 25 }, (_, i) => issue(i + 1));
  const second = Array.from({ length: 7 }, (_, i) => issue(i + 26));
  const fetchFn = fakeFetch({
    '/issues?': (url) => (url.includes('page=1') ? first : second),
  });
  const p1 = await fetchIssuePage({ repo: REPO, page: 1, fetchFn, now: NOW });
  assert.equal(p1.items.length, 25, 'navigation is not limited to the summary cap of ten');
  assert.equal(p1.hasMore, true);
  assert.equal(p1.page, 1);
  const p2 = await fetchIssuePage({ repo: REPO, page: 2, fetchFn, now: NOW });
  assert.equal(p2.items.length, 7);
  assert.equal(p2.hasMore, false, 'a short page ends the walk');
  // Exactly one request per user action, always type=issues and an explicit page.
  assert.equal(fetchFn.calls.length, 2);
  for (const call of fetchFn.calls) {
    assert.match(call.url, /state=all/);
    assert.match(call.url, /type=issues/);
    assert.match(call.url, /page=\d+/);
  }
});

test('pull requests are filtered defensively even when the API ignores type=issues', async () => {
  const mixed = [issue(1), { ...issue(2), pull_request: { merged: false } }, issue(3)];
  const fetchFn = fakeFetch({ '/issues?': mixed });
  const result = await fetchIssuePage({ repo: REPO, page: 1, fetchFn, now: NOW });
  assert.deepEqual(result.items.map((i) => i.number), [1, 3]);
});

test('identity is bound to the snapshot repo, never to an issue-supplied URL', async () => {
  const fetchFn = fakeFetch({ '/issues/7': issue(7), '/dependencies': [] });
  const detail = await fetchIssueDetail({ repo: REPO, number: 7, fetchFn, now: NOW });
  assert.ok(detail);
  assert.equal(detail.url, issueUrl(REPO, 7));
  assert.ok(!detail.url.includes('evil.example'), 'html_url must not steer the record');
  assert.equal(detail.key, issueKey(REPO, 7));
  // Every authenticated request stayed on the bound host/owner/repo.
  for (const call of fetchFn.calls) assert.ok(call.url.startsWith(`${REPO.host}/api/v1/repos/owner/promptr/`), call.url);
});

test('the token rides in a header only, never in a URL or a returned record', async () => {
  const token = 'gitea-token-value';
  const fetchFn = fakeFetch({ '/issues/7': issue(7), '/dependencies': [] });
  const detail = await fetchIssueDetail({ repo: REPO, number: 7, token, fetchFn, now: NOW });
  for (const call of fetchFn.calls) {
    assert.ok(!call.url.includes(token), 'token must never appear in a URL');
    assert.equal(call.headers.Authorization, `token ${token}`);
  }
  assert.ok(!JSON.stringify(detail).includes(token), 'token must never appear in a detail record');
});

test('repo and issue-number validation refuse traversal, empty and non-positive values', () => {
  assert.equal(isValidTrackingRepo(REPO), true);
  assert.equal(isValidTrackingRepo({ ...REPO, owner: '..' }), false);
  assert.equal(isValidTrackingRepo({ ...REPO, repo: 'a/b' }), false);
  assert.equal(isValidTrackingRepo({ ...REPO, host: 'ftp://x' }), false);
  assert.equal(isValidTrackingRepo({ ...REPO, host: '' }), false);
  for (const bad of [0, -3, 1.5, '7', undefined, null, NaN]) assert.equal(isValidIssueNumber(bad), false, String(bad));
  assert.equal(isValidIssueNumber(33), true);
  assert.equal(issueKey(REPO, 33), issueKey({ ...REPO, host: `${REPO.host}/` }, 33), 'trailing slash is not a new identity');
});

test('a malformed or unreadable issue is unavailable, never a default-open one', () => {
  const deps = { status: 'complete', items: [], blockers: 0, reason: '' };
  const cases = {
    'missing state': { ...issue(7), state: undefined },
    'unknown state': { ...issue(7), state: 'weird' },
    'missing updated_at': { ...issue(7), updated_at: undefined },
    'unparseable updated_at': { ...issue(7), updated_at: 'not a date' },
    'number mismatch': { ...issue(8) },
    'pull request': { ...issue(7), pull_request: {} },
    'empty title': { ...issue(7), title: '   ' },
    'not an object': 'nope',
  };
  for (const [label, raw] of Object.entries(cases)) {
    assert.equal(parseIssueDetail(raw, REPO, 7, deps, NOW()), undefined, label);
  }
  assert.ok(parseIssueDetail(issue(7), REPO, 7, deps, NOW()), 'a well-formed issue still parses');
});

test('dependency reads paginate honestly and never report complete when bounded', async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ number: 100 + i, title: 'dep', state: 'open' }));
  const bounded = fakeFetch({ '/dependencies': full });
  const capped = await fetchIssueDependencies({ repo: REPO, number: 7, fetchFn: bounded, perPage: 2, maxPages: 2 });
  assert.equal(capped.status, 'incomplete', 'a bound that was reached cannot claim a complete read');
  assert.equal(capped.items.length, 2, 'duplicate pages are deduped by repo#number');
  assert.equal(bounded.calls.length, 2);

  const short = fakeFetch({ '/dependencies': [{ number: 30, title: 'catalog', state: 'open', repository: { full_name: 'owner/promptr' } }] });
  const complete = await fetchIssueDependencies({ repo: REPO, number: 7, fetchFn: short, perPage: 25 });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.blockers, 1, 'an open dependency is a native blocker');

  const failing = fakeFetch({ '/dependencies': { __error: 'connect ECONNREFUSED' } });
  const unavailable = await fetchIssueDependencies({ repo: REPO, number: 7, fetchFn: failing });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /ECONNREFUSED/);

  const garbled = fakeFetch({ '/dependencies': [{ number: 1, state: 'mystery' }] });
  const partial = await fetchIssueDependencies({ repo: REPO, number: 7, fetchFn: garbled });
  assert.equal(partial.status, 'incomplete', 'an unparseable entry is not a cleared dependency');
});

test('dependency read of an invalid reference is unavailable and issues no request', async () => {
  const fetchFn = fakeFetch({});
  const result = await fetchIssueDependencies({ repo: REPO, number: 0, fetchFn });
  assert.equal(result.status, 'unavailable');
  assert.equal(fetchFn.calls.length, 0, 'an invalid reference must not reach the network');
});

test('untrusted titles and bodies lose control, C1 and bidi bytes but keep their text', () => {
  const line = sanitizeLine(hostile('Task 33'));
  assert.match(line, /Task 33/);
  for (const code of [0x1b, 0x7f, 0x202e, 0x9b, 0x200f]) {
    assert.ok(!line.includes(String.fromCharCode(code)), `line kept 0x${code.toString(16)}`);
  }
  const body = sanitizeBody(`first${String.fromCharCode(0x1b)}[2J\nsecond\ttab\r\nthird${String.fromCharCode(0x202e)}`);
  assert.equal(body.truncated, false);
  assert.equal(body.text, 'first[2J\nsecond  tab\nthird', 'newlines survive, escapes and bidi do not');

  const long = sanitizeBody('x'.repeat(50), 10);
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 10);
});

test('retirement is read from labels and the change signature covers native state', () => {
  assert.equal(isRetired(['enhancement', 'Resolution:Retired']), true);
  assert.equal(isRetired(['retired-ish']), false);
  const deps = { status: 'complete', items: [], blockers: 0, reason: '' };
  const base = parseIssueDetail(issue(7), REPO, 7, deps, NOW());
  const moved = parseIssueDetail({ ...issue(7), updated_at: '2026-09-02T10:00:00Z' }, REPO, 7, deps, NOW());
  const relabelled = parseIssueDetail({ ...issue(7), labels: [{ name: 'resolution:retired' }] }, REPO, 7, deps, NOW());
  const blocked = parseIssueDetail(issue(7), REPO, 7, { ...deps, blockers: 1 }, NOW());
  assert.notEqual(detailSignature(base), detailSignature(moved));
  assert.notEqual(detailSignature(base), detailSignature(relabelled));
  assert.notEqual(detailSignature(base), detailSignature(blocked));
  // The read stamp alone is not a change: re-reading an unchanged issue is idempotent.
  const reread = parseIssueDetail(issue(7), REPO, 7, deps, '2026-09-07T13:00:00Z');
  assert.equal(detailSignature(base), detailSignature(reread));
});

test('a bounded body records its own truncation instead of pretending to be whole', async () => {
  const huge = 'a'.repeat(30_000);
  const fetchFn = fakeFetch({ '/issues/7': { ...issue(7), body: huge }, '/dependencies': [] });
  const detail = await fetchIssueDetail({ repo: REPO, number: 7, fetchFn, now: NOW });
  assert.ok(detail);
  assert.equal(detail.bodyTruncated, true);
  assert.equal(detail.body.length, 24_000);
});
